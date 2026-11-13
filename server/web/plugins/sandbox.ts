// sandbox.ts — where a plugin's code runs, and the only door out of it.
//
// A plugin is other people's code.  It runs in an <iframe sandbox="allow-scripts"> built from a
// srcdoc, which gives it an opaque origin: it cannot read the page, the cookies or storage of
// this site, cannot call our API as the signed-in person, cannot open windows or navigate the
// tab.  A Content-Security-Policy inside the frame denies every network load except the hosts
// the person granted, and the app page's own `frame-src 'none'` (src/pages.rs) stops the frame
// from navigating itself somewhere with data in the URL.  What is left is one MessagePort, and
// everything a plugin can do is a request on that port which host.ts checks against the
// plugin's granted permissions before acting.
//
// The frame is also the plugin's panel when it has one: the plugin draws into its own document,
// and the dock shows or hides the frame.

import { hostsOf, type InstalledPlugin } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SandboxInit {
  plugin: { identifier: string; name: string; version: string; hosts?: string[]; pyodide?: string };
  /** The entry script reports by itself when the plugin is ready (the Python runtime, which has an interpreter to start first). */
  defer?: boolean;
  granted: string[];
  theme: { dark: boolean; vars: Record<string, string> };
  entry: string; entryName: string; html: string; resources: Record<string, string>;
}

/**
 * The code that runs first inside the frame: it builds the `kicad` global over the port.  It is
 * shipped as this function's own source text, so it must be self-contained — no imports, no
 * references to anything outside its body.
 */
export function sandboxRuntime(): void {
  const W: any = window;
  let port: MessagePort | null = null; let seq = 0;
  const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  const queue: any[] = [];
  const handlers: Record<string, Record<string, (arg: any) => any>> = { action: {}, importer: {}, exporter: {}, tool: {}, wizard: {} };
  const listeners: Record<string, Array<(d: any) => void>> = {};
  let resources: Record<string, string> = {};
  const post = (m: any, transfer?: Transferable[]) => { if (port) port.postMessage(m, transfer || []); else queue.push(m); };
  const call = (method: string, args?: any): Promise<any> => new Promise((ok, no) => { const id = ++seq; waiting.set(id, { ok, no }); post({ t: "call", id, method, args: args === undefined ? {} : args }); });
  const show = (v: any): string => { if (typeof v === "string") return v; if (v instanceof Error) return v.stack || v.message; try { return JSON.stringify(v); } catch (e) { return String(v); } };
  const log = (level: string, parts: any[]) => post({ t: "log", level, text: parts.map(show).join(" ").slice(0, 4000) });
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = (console as any)[level];
    (console as any)[level] = (...parts: any[]) => { log(level === "debug" || level === "info" ? "log" : level, parts); try { orig.apply(console, parts); } catch (e) { /* no console */ } };
  }
  W.addEventListener("error", (ev: ErrorEvent) => log("error", [ev.error || ev.message]));
  W.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => log("error", ["Unhandled promise rejection:", ev.reason]));

  const group = (prefix: string, names: string[]) => { const o: any = {}; for (const n of names) o[n] = (args?: any) => call(prefix + "." + n, args); return o; };
  const reg = (kind: string) => (name: string, fn: (arg: any) => any, meta?: any) => {
    if (typeof name !== "string" || typeof fn !== "function") throw new TypeError("register(name, handler)");
    handlers[kind][name] = fn; post(meta && typeof meta === "object" ? { t: "registered", kind, name, meta } : { t: "registered", kind, name });
  };
  const kicad: any = {
    plugin: {}, editor: { scope: null, document: null, role: null, viewOnly: true },
    on(name: string, fn: (d: any) => void) { (listeners[name] = listeners[name] || []).push(fn); return () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); }; },
    actions: { register: reg("action") },
    importers: { register: reg("importer") },
    exporters: { register: reg("exporter") },
    assistant: { registerTool: reg("tool") },
    wizards: { register: reg("wizard") },
    design: group("design", ["overview", "documents", "components", "component", "nets", "items", "selection", "runChecks", "boardInfo", "board", "apply", "commit", "undo", "redo", "copied", "copy"]),
    view: group("view", ["select", "highlight", "focus", "appearance", "setMarkers", "clearMarkers", "openDocument"]),
    fab: group("fab", ["layers", "gerbers", "drill", "positions", "bom", "svg", "drc", "netlist", "render", "model"]),
    project: group("project", ["versions", "saveVersion", "addLibraryFiles"]),
    libs: group("libs", ["libraries", "footprints", "footprint"]),
    net: group("net", ["fetch"]),
    ui: Object.assign(group("ui", ["prompt", "confirm", "showPanel", "hidePanel", "showWindow", "hideWindow", "openLink"]), {
      toast: (text: any) => call("ui.toast", text && typeof text === "object" ? text : { text: String(text) }),
      status: (text: any) => call("ui.status", text && typeof text === "object" ? text : { text: text ? String(text) : "" }),
    }),
    files: group("files", ["save", "pick"]),
    storage: {
      get: (key: any) => call("storage.get", key && typeof key === "object" ? key : { key }),
      set: (key: any, value?: any) => call("storage.set", key && typeof key === "object" ? key : { key, value }),
      remove: (key: any) => call("storage.remove", key && typeof key === "object" ? key : { key }),
      keys: () => call("storage.keys"),
    },
    resources: { text(path: string) { return path in resources ? Promise.resolve(resources[path]) : Promise.reject(new Error("no such file in this plugin: " + path)); }, list() { return Object.keys(resources); } },
  };
  W.kicad = kicad;

  const emit = (name: string, data: any) => { for (const fn of (listeners[name] || []).slice()) { try { fn(data); } catch (e) { log("error", [e]); } } };
  const applyTheme = (th: any) => {
    const root = document.documentElement;
    for (const k of Object.keys(th.vars || {})) root.style.setProperty(k, th.vars[k]);
    root.setAttribute("data-theme", th.dark ? "dark" : "light"); root.style.colorScheme = th.dark ? "dark" : "light";
  };
  const onMessage = (m: any) => {
    if (!m || typeof m !== "object") return;
    if (m.t === "result") { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.error) { const e: any = new Error(m.error); e.code = m.code || "error"; w.no(e); } else w.ok(m.value); }
    else if (m.t === "event") { if (m.name === "theme") applyTheme(m.data); if (m.name === "editor") Object.assign(kicad.editor, m.data); emit(m.name, m.data); }
    else if (m.t === "invoke") {
      const fn = handlers[m.kind] && handlers[m.kind][m.name];
      if (!fn) { post({ t: "done", id: m.id, error: "the plugin has not registered " + m.kind + " \"" + m.name + "\"" }); return; }
      let out: any; try { out = Promise.resolve(fn(m.arg)); } catch (e) { out = Promise.reject(e); }
      out.then((value: any) => post({ t: "done", id: m.id, value: value === undefined ? null : value }),
        (e: any) => { log("error", [e]); post({ t: "done", id: m.id, error: e && e.message ? String(e.message) : String(e) }); });
    }
  };
  const start = (init: any, p: MessagePort) => {
    port = p; port.onmessage = (ev) => onMessage(ev.data);
    Object.assign(kicad.plugin, init.plugin, { permissions: init.granted });
    Object.assign(kicad.editor, init.editor || {});
    resources = init.resources || {}; applyTheme(init.theme || {});
    if (init.html) document.body.innerHTML = init.html;
    for (const m of queue.splice(0)) port.postMessage(m);
    const s = document.createElement("script");
    s.src = URL.createObjectURL(new Blob([init.entry + "\n//# sourceURL=plugin:///" + init.plugin.identifier + "/" + init.entryName], { type: "text/javascript" }));
    kicad.plugin.loaded = (info: any) => post({ t: "ready", failed: !!(info && info.failed), error: info && info.error ? String(info.error) : undefined });
    s.onload = () => { if (!init.defer) post({ t: "ready" }); };
    s.onerror = () => { log("error", ["The plugin's script could not be loaded."]); post({ t: "ready", failed: true }); };
    document.head.appendChild(s);
  };
  const first = (ev: MessageEvent) => {
    if (ev.source !== W.parent || !ev.data || ev.data.t !== "init" || !ev.ports || !ev.ports[0]) return;
    W.removeEventListener("message", first); start(ev.data, ev.ports[0]);
  };
  W.addEventListener("message", first);
}

/** The frame's own stylesheet: the app's colour tokens (sent in at start, kept in step with the theme) on plain elements. */
const BASE_CSS = `
:root{--font:system-ui,sans-serif;--mono:ui-monospace,monospace}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{font:12px/1.45 var(--font);color:var(--ink);background:var(--paper);overflow:auto}
h1,h2,h3{margin:0 0 6px;font-weight:600;color:var(--ink)}h1{font-size:14px}h2{font-size:13px}
h3{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
p{margin:0 0 8px}a{color:var(--blue)}code,pre,.mono{font-family:var(--mono);font-size:11px}
button,.btn{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:4px 10px;cursor:pointer}
button:hover,.btn:hover{border-color:var(--blue)}button:disabled{opacity:.5;cursor:default}
button.primary,.btn.primary{background:var(--copper);border-color:var(--copper-2,var(--copper));color:#fff}
input,select,textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:4px 6px}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:1px solid var(--blue);outline-offset:0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--ink-2);background:var(--bench);position:sticky;top:0}
.muted{color:var(--ink-2)}.err{color:var(--err)}.warn{color:var(--warn)}.ok{color:var(--wire)}
.pad{padding:8px 10px}.row{display:flex;gap:6px;align-items:center}.grow{flex:1}
`;

const cspSource = (host: string) => `https://${host}`;

/** The document the frame starts from: the policy, the base styles, the runtime.  No plugin text is spliced into it. */
export function buildSrcdoc(granted: string[], python?: string): string {
  const hosts = hostsOf(granted).map(cspSource);
  // A Python plugin's frame may also load the interpreter: script and WebAssembly from our own
  // /static/pyodide/ and nowhere else.  That folder holds public runtime files only.
  if (python) hosts.push(python);
  // With Python, data: too: the ngspice build carries its WebAssembly inside its own file and reads it with fetch.
  // A data: address names no server, so nothing can be sent anywhere through it.
  if (python) hosts.push("data:");
  const net = hosts.length ? hosts.join(" ") : "'none'";
  const csp = [
    "default-src 'none'", `script-src 'unsafe-inline' blob:${python ? ` 'wasm-unsafe-eval' ${python}` : ""}`, "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
    `connect-src ${net}`, "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "worker-src blob:", "object-src 'none'", "media-src 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${BASE_CSS}</style>`
    + `<script>(${sandboxRuntime.toString()})();</script></head><body></body></html>`;
}

export interface Sandbox {
  frame: HTMLIFrameElement;
  send(msg: unknown): void;
  destroy(): void;
}

/**
 * Start a plugin's frame inside `parent` and hand it its port.  `onMessage` receives everything
 * the plugin says; nothing it says is trusted.
 */
export function createSandbox(p: InstalledPlugin, parent: HTMLElement, init: SandboxInit & { editor: unknown }, onMessage: (m: any) => void): Sandbox {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");                      // no camera, microphone, geolocation, clipboard, …
  frame.setAttribute("title", p.manifest.name);
  frame.dataset.plugin = p.identifier;
  frame.className = "plg-frame";
  frame.hidden = true;
  const chan = new MessageChannel(); let dead = false;
  chan.port1.onmessage = (ev) => { if (!dead) onMessage(ev.data); };
  frame.addEventListener("load", () => {
    // The first load is the srcdoc.  A later one would mean the frame went somewhere else; the
    // page's frame-src forbids that, and the port given away below is not handed out twice.
    if (dead || !frame.contentWindow || frame.dataset.started) return;
    frame.dataset.started = "1";
    frame.contentWindow.postMessage(Object.assign({ t: "init" }, init), "*", [chan.port2]);
  });
  frame.srcdoc = buildSrcdoc(p.granted, init.plugin.pyodide);
  parent.appendChild(frame);
  return {
    frame,
    send(msg) { if (!dead) chan.port1.postMessage(msg); },
    destroy() { dead = true; try { chan.port1.close(); } catch { /* closed */ } frame.remove(); },
  };
}
