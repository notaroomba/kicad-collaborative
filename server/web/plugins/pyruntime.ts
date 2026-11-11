// pyruntime.ts — runs one of KiCad's own Python plugins inside the plugin sandbox.
//
// KiCad's official plugins are Python programs written against the desktop application's
// `pcbnew` and `wx` modules.  Rather than translate them, the sandbox frame runs real CPython
// (Pyodide: the interpreter compiled to WebAssembly) and gives it those two modules, written
// over the collaborative board and over HTML (server/plugins/python).  This file is the piece
// in between: it is the "entry script" of every Python plugin, an ordinary sandboxed web
// plugin that happens to start an interpreter.  It has exactly the reach any web plugin has:
// the `kicad` API over the frame's one port, checked by host.ts against what the person granted.
//
// Python calls into the editor block (WebAssembly stack switching), so `dialog.ShowModal()`
// and `board.Add(...)` behave as the plugin's author wrote them for the desktop.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shipped as this function's own source text and run in the frame: it must be self-contained —
 * no imports, no references to anything outside its body.
 */
export function pythonRuntime(): void {
  const W: any = window; const kicad: any = W.kicad; const base: string = kicad.plugin.pyodide;
  let py: any = null;
  const say = (e: any) => (e && e.message ? String(e.message) : String(e));
  const lastLine = (e: any) => { const lines = say(e).trim().split("\n"); return lines[lines.length - 1].slice(0, 400); };

  // ---- wx: windows, modal waits, timers
  const modals = new Map<number, () => void>(); let shown = false; let presentSeq = 0;
  const promised = (fn: any, args: any[]) => {
    try { const r = fn.callPromising ? fn.callPromising(...args) : fn(...args); if (r && typeof r.catch === "function") r.catch((e: any) => console.error(say(e))); }
    catch (e) { console.error(say(e)); }
  };
  const frame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));
  W.__kcWx = {
    /** A DOM listener that enters Python in a way that lets the handler block (open another dialog, wait for the editor). */
    promising: (fn: any) => (ev: any) => promised(fn, [ev]),
    /** Show a top-level wx window: the editor floats the frame as a dialog sized to the window's content. */
    async show(title: string, el: HTMLElement, wantW: number, wantH: number, modal: boolean) {
      const seq = ++presentSeq;
      if (!shown) { await kicad.ui.showWindow({ title, width: wantW || 460, height: wantH || 260, modal }); shown = true; await frame(); }
      if (seq !== presentSeq) return;
      const body = document.body; const pad = 2;
      el.style.width = "max-content"; const natural = Math.ceil(el.getBoundingClientRect().width) + pad; el.style.width = "";
      const width = Math.max(280, Math.min(1100, wantW > 0 ? Math.max(wantW, Math.min(natural, wantW + 240)) : natural));
      body.style.width = width + "px"; el.style.minHeight = "0";
      const height = Math.max(wantH > 0 ? Math.min(wantH, 760) : 0, Math.ceil(el.scrollHeight) + pad, 80);
      body.style.width = ""; el.style.minHeight = "";
      await kicad.ui.showWindow({ title, width, height, modal });
    },
    hide() { presentSeq++; shown = false; kicad.ui.hideWindow().catch(() => undefined); },
    modal: (id: number) => new Promise<void>((ok) => modals.set(id, ok)),
    endModal(id: number) { const ok = modals.get(id); if (ok) { modals.delete(id); ok(); } },
    tick: () => new Promise<void>((ok) => setTimeout(ok, 0)),
    sleep: (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms | 0))),
    later: (fn: any, ms: number) => setTimeout(() => promised(fn, []), Math.max(0, ms | 0)),
    copy: (_text: string) => undefined,
  };
  // The person closed the floating dialog (its ×, or Escape): the topmost wx window gets its close event.
  kicad.on("window-closed", () => { if (py) py.runPythonAsync("import wx\nwx._user_closed()").catch((e: any) => console.error(say(e))); });

  // ---- the bridge Python blocks on
  const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any); return btoa(s); };
  const unb64 = (text: string) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  W.__kcCall = async (method: string, json: string): Promise<string> => {
    const a = json ? JSON.parse(json) : {}; let out: any = null;
    switch (method) {
      case "design.board": out = await kicad.design.board(); break;
      case "design.commit": out = await kicad.design.commit(a); break;
      case "fab.layers": out = await kicad.fab.layers(); break;
      case "fab.gerbers": out = await kicad.fab.gerbers(a); break;
      case "fab.drill": out = await kicad.fab.drill(a); break;
      case "fab.positions": out = await kicad.fab.positions(a); break;
      case "fab.bom": out = await kicad.fab.bom(a); break;
      case "fab.svg": out = await kicad.fab.svg(a); break;
      case "fab.drc": out = await kicad.fab.drc(a); break;
      case "fab.netlist": out = await kicad.fab.netlist(); break;
      case "project.versions": out = await kicad.project.versions(); break;
      case "project.saveVersion": out = await kicad.project.saveVersion(a); break;
      case "net.fetch": out = await kicad.net.fetch(a); break;
      case "view.select": out = await kicad.view.select(a); break;
      case "view.focus": out = await kicad.view.focus(a); break;
      case "ui.confirm": out = await kicad.ui.confirm(a); break;
      case "ui.openLink": out = await kicad.ui.openLink(a); break;
      case "ui.prompt": out = await kicad.ui.prompt(a); break;
      case "ui.status": kicad.ui.status(a.text || "").catch(() => undefined); break;
      case "files.save": out = await kicad.files.save({ filename: a.filename, bytes: unb64(a.base64 || ""), mime: a.mime }); break;
      case "files.pick": { const f = await kicad.files.pick({ title: a.title, accept: a.accept, as: "bytes" }); out = f ? { name: f.name, base64: b64(new Uint8Array(f.bytes)) } : null; break; }
      default: throw new Error("the Python runtime has no call named " + method);
    }
    return JSON.stringify(out === undefined ? null : out);
  };

  // ---- actions
  let chain: Promise<unknown> = Promise.resolve();
  const runAction = (index: number) => {
    const next = chain.then(async () => {
      const out = JSON.parse(await py.runPythonAsync("kicad_web.run_action(" + index + ")"));
      if (out.note) kicad.ui.toast(out.note).catch(() => undefined);
      if (!out.ok) throw new Error(out.error || "the plugin failed; its log has the details");
    });
    chain = next.catch(() => undefined);       // one action at a time; a failure does not block the next
    return next;
  };

  const loadScript = (src: string) => new Promise<void>((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = () => ok(); s.onerror = () => no(new Error("the Python runtime could not be downloaded")); document.head.appendChild(s); });
  (async () => {
    kicad.ui.status("Starting Python…").catch(() => undefined);
    await loadScript(base + "pyodide.js");
    py = await W.loadPyodide({ indexURL: base, stdout: (t: string) => console.log(t), stderr: (t: string) => console.warn(t) });
    const shim = await (await fetch(base + "kicad-python.json")).json();
    for (const name of Object.keys(shim.files)) { const dst = "/kicad/lib/" + name; py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf("/"))); py.FS.writeFile(dst, shim.files[name]); }
    const files: Record<string, string> = {}; for (const name of kicad.resources.list()) files[name] = await kicad.resources.text(name);
    py.globals.set("_kc_files", py.toPy(files));
    // Packages the plugin imports that the runtime carries (numpy, requests, KiCad's kipy, …) are fetched now, once.
    try {
      const lock = await (await fetch(base + "pyodide-lock.json")).text();
      py.globals.set("_kc_lock", lock);
      const need: string[] = JSON.parse(await py.runPythonAsync("import sys\nsys.path.insert(0, '/kicad/lib')\nimport kicad_web\nkicad_web.needed_packages(_kc_files, _kc_lock)"));
      py.globals.delete("_kc_lock");
      for (const name of need) {
        kicad.ui.status("Loading " + name + "…").catch(() => undefined);
        try { await py.loadPackage(name, { messageCallback: () => undefined, errorCallback: (t: string) => console.warn(t) }); }
        catch (e) { console.warn("The Python package " + name + " could not be loaded: " + lastLine(e)); }
      }
    } catch (e) { console.warn("The plugin's Python packages could not be checked: " + lastLine(e)); }
    const info = JSON.parse(await py.runPythonAsync([
      "import sys",
      "sys.path.insert(0, '/kicad/lib') if '/kicad/lib' not in sys.path else None",
      "import js, kicad_web",
      "from pyodide.ffi import run_sync",
      "def _kc_bridge(method, args):",
      "    return run_sync(js.__kcCall(method, args))",
      "kicad_web.boot(" + JSON.stringify(kicad.plugin.identifier) + ", _kc_files, _kc_bridge, " + JSON.stringify(kicad.plugin.name) + ")",
    ].join("\n")));
    py.globals.delete("_kc_files");
    for (const a of info.actions) kicad.actions.register("py" + a.index, () => runAction(a.index), { name: a.name, description: a.description, icon: a.icon, button: !!a.button });
    kicad.ui.status("").catch(() => undefined);
    if (info.error) console.error("This plugin could not be loaded: " + info.error);
    else if (!info.actions.length) console.warn("This plugin loaded but added no board editor actions.");
    kicad.plugin.loaded({ failed: !!info.error && !info.actions.length, error: info.error || null, actions: info.actions.length });
  })().catch((e) => { console.error("The Python runtime did not start: " + lastLine(e)); kicad.ui.status("").catch(() => undefined); kicad.plugin.loaded({ failed: true, error: lastLine(e), actions: 0 }); });
}
