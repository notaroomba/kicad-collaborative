// PluginUi.tsx — the chrome plugins get: the dock their panels sit in, the toolbar buttons of
// their actions, the dialogs the host draws on their behalf, and the manager (KiCad's Plugin and
// Content Manager, for the web): what is installed, what it may do, a catalog, and a developer tab.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { cx } from "../util";
import {
  actionsFor, actionsOf, answerPrompt, cancelInstall, clearLog, closeManager, closePanels, closeWindow, confirmInstall, dismissRecommended, exportersFor, fetchFromUrl, importersFor, initPlugins,
  installFromRegistry, installOfficial, loadOfficial, installRecommended, loadRegistry, lookupPublished, missingRecommended, moderate, report, openManager, originOf, panelsFor, publish, readLocalFiles, recommend,
  recommendedPending, requestInstall, restart, runPluginUi, setEnabled, setFrameHost, setManager, setPanelWidth, showPanel, uninstall, unpublish, usePlugins,
  type CatalogEntry, type Compat, type ModerationEntry, type OfficialEntry, type PluginWindowState, type ProjectPlugin, type PromptField, type PromptRequest, type RegistryEntry,
} from "./host";
import { describePermission, isPython, type InstalledPlugin, type PluginAction, type PluginManifest } from "./types";

const PUZZLE = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5a2 2 0 014 0V6h4v4h1.5a2 2 0 010 4H17v5h-4.2v-1.2a1.8 1.8 0 00-3.6 0V19H5v-4.5h1.3a2 2 0 000-4H5V6h4z" /></svg>;

// ---------------------------------------------------------------- menus

type MenuEntry = string | [string, MenuEntry[]];
/**
 * Where plugins appear in the editor menus, the way KiCad places them: actions under
 * Tools → External Plugins (or the menu an action names), importers and exporters under File.
 */
export function usePluginMenus(menus: [string, MenuEntry[]][], editor: string | null): [string, MenuEntry[]][] {
  const s = usePlugins((x) => x);
  if (!editor) return menus;
  const acts = actionsFor(s, editor); const imps = importersFor(s, editor), exps = exportersFor(s, editor); const panels = panelsFor(s, editor);
  const byMenu = (name: string) => acts.filter((a) => (a.action.menu || "tools").toLowerCase() === name).map((a) => a.uiId);
  return menus.map(([title, entries]) => {
    const t = title.replace("&", "").toLowerCase(); let out = entries;   // titles carry KiCad's "&" mnemonic marker
    if (t === "file" && (imps.length || exps.length)) {
      // KiCad's File menu has Import and Export submenus already: plugin entries join them, below a separator.
      const join = (name: string, ids: string[]) => {
        if (!ids.length) return;
        const at = out.findIndex((e) => Array.isArray(e) && e[0] === name);
        if (at >= 0) { const sub = out[at] as [string, MenuEntry[]]; out = [...out.slice(0, at), [name, [...sub[1], "-", ...ids]] as MenuEntry, ...out.slice(at + 1)]; return; }
        const before = out.indexOf("print"); out = before >= 0 ? [...out.slice(0, before), [name, ids] as MenuEntry, "-", ...out.slice(before)] : [...out, "-", [name, ids] as MenuEntry];
      };
      join("Import", imps.map((x) => x.uiId)); join("Export", exps.map((x) => x.uiId));
    }
    if (t === "tools") out = [...out, "-", ["External Plugins", [...byMenu("tools"), ...(byMenu("tools").length ? ["-"] : []), ...(panels.length ? ["pluginPanels"] : []), "pluginManager"]]];
    else if (t === "inspect" || t === "edit" || t === "place") { const mine = byMenu(t); if (mine.length) out = [...out, "-", ...mine]; }
    if (t === "preferences") out = [...out, "pluginManager"];
    return [title, out] as [string, MenuEntry[]];
  });
}

// ---------------------------------------------------------------- toolbar

/** The buttons of actions that ask for one (`show-button`), for the end of the top toolbar as in KiCad: one bar entry each, after a separator. */
export function usePluginBarEntries(): { key: string; node: ReactNode; menu?: { id: string; label: string; glyph?: string } | null }[] {
  const s = usePlugins((x) => x); const editor = useApp((st) => st.document.editor);
  const acts = actionsFor(s, editor).filter((a) => a.action["show-button"]);
  if (!acts.length) return [];
  return [{ key: "plugin-sep", node: <span className="plg-tb-sep" />, menu: null }, ...acts.map((a) => {
    const run = s.running[a.plugin]; const working = !!run && run.busy === a.name; const icon = a.action.icon ? safeSvg(a.action.icon) : "";
    return { key: a.uiId, menu: { id: a.uiId, label: a.name, glyph: icon || undefined }, node: (
      <button type="button" className={cx("plg-tb-btn", working && "busy")} data-uiact={a.uiId} title={`${a.name}${a.action.key ? `  (${a.action.key})` : ""}\n${a.description}\n— plugin: ${a.pluginName}`} onClick={() => runPluginUi(a.uiId)}>
        {a.action.iconUrl ? <img src={a.action.iconUrl} alt="" draggable={false} /> : icon ? <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} /> : PUZZLE}
      </button>
    ) };
  })];
}
/** A plugin's icon is drawn in our page, so it is reduced to shapes: no scripts, handlers, links or foreign content. */
function safeSvg(markup: string): string {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";
  const ok = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g"]);
  const attrs = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "transform", "opacity", "fill-rule"]);
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (!ok.has(c.tagName.toLowerCase())) { c.remove(); continue; }
      for (const at of Array.from(c.attributes)) if (!attrs.has(at.name.toLowerCase()) || /url\(|javascript:/i.test(at.value)) c.removeAttribute(at.name);
      walk(c);
    }
  };
  walk(doc.documentElement);
  return Array.from(doc.documentElement.children).map((c) => new XMLSerializer().serializeToString(c)).join("");
}

// ---------------------------------------------------------------- dock

export function PluginDock() {
  const view = useApp((st) => st.view); const editor = useApp((st) => st.document.editor);
  const s = usePlugins((x) => x); const host = useRef<HTMLDivElement>(null); const [drag, setDrag] = useState(false);
  useEffect(() => { initPlugins(); }, []);
  useEffect(() => { setFrameHost(host.current); return () => setFrameHost(null); }, []);
  const panels = view === "editor" ? panelsFor(s, editor) : [];
  const active = panels.find((p) => p.plugin === s.panel.active) || panels[0] || null;
  const shown = view === "editor" && !!editor && s.panel.open && !!active;
  useEffect(() => { window.dispatchEvent(new Event("resize")); }, [shown, s.panel.width]);
  const startDrag = (ev: React.PointerEvent) => {
    ev.preventDefault(); setDrag(true); const x0 = ev.clientX, w0 = s.panel.width;
    const move = (e: PointerEvent) => setPanelWidth(w0 + (x0 - e.clientX));
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const run = active ? s.running[active.plugin] : undefined; const windowed = view === "editor" && !!s.window;
  // The frames stay mounted (and their plugins running) while the dock is closed: only its size goes.
  return (
    <aside id="dockPlugins" className={cx(!shown && "closed", drag && "drag", windowed && "windowed")} style={shown ? { width: s.panel.width } : undefined} onKeyDown={(e) => e.stopPropagation()}>
      <div className={cx("plg-grip", drag && "on")} onPointerDown={startDrag} />
      <div className="plg-head">
        <div className="plg-tabs">
          {panels.map((p) => <button type="button" key={p.plugin} className={cx("plg-tab", active && p.plugin === active.plugin && "on")} data-plugin-tab={p.plugin} onClick={() => showPanel(p.plugin)}>{p.name}</button>)}
        </div>
        <button type="button" className="plg-ib" title="Manage plugins" onClick={() => openManager("installed")}>{PUZZLE}</button>
        <button type="button" className="plg-ib x" title="Close" onClick={() => closePanels()}>×</button>
      </div>
      {active && run && run.failed ? <div className="plg-note err">This plugin failed to start. Its log in Manage Plugins says why.</div> : null}
      {active && !run ? <div className="plg-note">This plugin is not running.</div> : null}
      <div className="plg-frames" id="pluginFrames" ref={host} />
    </aside>
  );
}

// ---------------------------------------------------------------- a plugin's own window

/**
 * The frame of a plugin that opened a window (a KiCad Python plugin's wx dialog), floated as a KiCad dialog.  The editor
 * draws the title bar and the border; the plugin's sandboxed frame is laid exactly over the body, so what is inside is
 * still the plugin's and still boxed in.
 */
export function PluginWindow() {
  const w = usePlugins((x) => x.window); const view = useApp((st) => st.view);
  return w && view === "editor" ? <WindowDialog w={w} key={w.plugin} /> : null;
}
function WindowDialog({ w }: { w: PluginWindowState }) {
  const body = useRef<HTMLDivElement>(null); const [off, setOff] = useState({ x: 0, y: 0 }); const [drag, setDrag] = useState(false);
  const busy = usePlugins((x) => { const r = x.running[w.plugin]; return !!r && !r.ready; });
  useLayoutEffect(() => {
    const el = body.current; if (!el) return; const root = document.documentElement;
    const place = () => { const r = el.getBoundingClientRect(); root.style.setProperty("--plg-win-x", `${Math.round(r.left)}px`); root.style.setProperty("--plg-win-y", `${Math.round(r.top)}px`); root.style.setProperty("--plg-win-w", `${Math.round(r.width)}px`); root.style.setProperty("--plg-win-h", `${Math.round(r.height)}px`); };
    place(); const ro = new ResizeObserver(place); ro.observe(el); window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [off.x, off.y, w.width, w.height]);
  useEffect(() => { document.body.classList.toggle("plg-win-drag", drag); return () => document.body.classList.remove("plg-win-drag"); }, [drag]);
  const startDrag = (ev: React.PointerEvent) => {
    if ((ev.target as HTMLElement).closest(".kd-x")) return;
    ev.preventDefault(); setDrag(true); const x0 = ev.clientX - off.x, y0 = ev.clientY - off.y;
    const move = (e: PointerEvent) => setOff({ x: Math.max(-window.innerWidth / 2 + 80, Math.min(window.innerWidth / 2 - 80, e.clientX - x0)), y: Math.max(-window.innerHeight / 2 + 40, Math.min(window.innerHeight / 2 - 40, e.clientY - y0)) });
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className={cx("kd-overlay plg-winlay", !w.modal && "modeless")} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") closeWindow(); }}>
      <div className="kd-dialog plg-window" role="dialog" aria-modal={w.modal} id="pluginWindow" tabIndex={-1} style={{ transform: `translate(${off.x}px, ${off.y}px)`, maxWidth: "calc(100vw - 24px)" /* theme.css caps its own dialogs at 760px; a plugin window is as wide as its content asks */ }}>
        <div className="kd-title" onPointerDown={startDrag}><span>{w.title}</span><span className="plg-from">plugin: {w.pluginName}</span><span className="kd-x" title="Close (Esc)" onClick={() => closeWindow()}>×</span></div>
        <div className="plg-winbody" ref={body} style={{ minWidth: w.width, height: w.height }}>{busy ? <span className="plg-muted">Starting…</span> : null}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs drawn for a plugin

function Field({ f, value, set }: { f: PromptField; value: unknown; set: (v: unknown) => void }) {
  const [picked, setPicked] = useState("");
  if (f.type === "checkbox") return <><label /><label className="plg-check"><input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} /> {f.label}</label></>;
  let input;
  if (f.type === "select") input = <select value={String(value ?? "")} onChange={(e) => set(e.target.value)}>{(f.options || []).map((o) => { const v = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label; return <option key={v} value={v}>{l}</option>; })}</select>;
  else if (f.type === "textarea") input = <textarea rows={5} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
  else if (f.type === "number") input = <input type="number" value={value === undefined || value === null ? "" : String(value)} min={f.min} max={f.max} step={f.step ?? "any"} onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} />;
  else if (f.type === "file") input = (
    <span className="plg-file">
      <input type="file" accept={(f.accept || []).join(",") || undefined} onChange={async (e) => {
        const file = e.target.files && e.target.files[0]; if (!file) { set(null); setPicked(""); return; }
        if (file.size > 64 * 1024 * 1024) { setPicked("That file is larger than 64 MB."); set(null); return; }
        setPicked(`${file.name} · ${file.size} bytes`);
        set(f.as === "bytes" ? { name: file.name, size: file.size, bytes: await file.arrayBuffer() } : { name: file.name, size: file.size, text: await file.text() });
      }} />
      {picked ? <span className="plg-muted">{picked}</span> : null}
    </span>
  );
  else input = <input type="text" value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
  return <><label>{f.label}</label>{input}</>;
}

export function PluginPrompt() {
  const pr = usePlugins((x) => x.prompt);
  return pr ? <PromptDialog pr={pr} key={pr.id} /> : null;
}
function PromptDialog({ pr }: { pr: PromptRequest }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => { const v: Record<string, unknown> = {}; for (const f of pr.fields) v[f.name] = f.default !== undefined ? f.default : f.type === "checkbox" ? false : f.type === "select" ? (f.options && f.options.length ? (typeof f.options[0] === "string" ? f.options[0] : f.options[0].value) : "") : f.type === "number" || f.type === "file" ? null : ""; return v; });
  const ok = () => answerPrompt(pr.kind === "confirm" ? true : values);
  const cancel = () => answerPrompt(pr.kind === "confirm" ? false : null);
  const needFile = pr.fields.some((f) => f.type === "file" && !values[f.name]);
  return (
    <div className="kd-overlay plg-overlay" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") cancel(); if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && !needFile) ok(); }}>
      <div className="kd-dialog plg-prompt" role="dialog" aria-modal="true" id="pluginPrompt">
        <div className="kd-title"><span>{pr.title}</span><span className="plg-from">plugin: {pr.pluginName}</span><span className="kd-x" title="Close (Esc)" onClick={cancel}>×</span></div>
        <div className="kd-body">
          {pr.message ? <p className="plg-msg">{pr.message}</p> : null}
          {pr.fields.length ? <div className="kv">{pr.fields.map((f) => <Field key={f.name} f={f} value={values[f.name]} set={(v) => setValues((o) => Object.assign({}, o, { [f.name]: v }))} />)}</div> : null}
        </div>
        <div className="kd-foot"><button type="button" className="btn" onClick={cancel}>Cancel</button><button type="button" className="btn primary" id="pluginPromptOk" autoFocus disabled={needFile} onClick={ok}>{pr.okLabel || "OK"}</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- manager

const RISK_LABEL = { low: "", medium: "", high: "sensitive" } as const;
function Permissions({ perms, fresh, m }: { perms: string[]; fresh?: string[]; m?: PluginManifest }) {
  if (!perms.length) return <p className="plg-muted">Needs no permissions: it cannot read or change your designs.</p>;
  return (
    <ul className="plg-perms">
      {perms.map((p) => { const d = describePermission(p, m); return (
        <li key={p} className={cx(d.risk)} data-perm={p}>
          <span className="dot" /><div><b>{d.title}</b>{RISK_LABEL[d.risk] ? <span className="tag">{RISK_LABEL[d.risk]}</span> : null}{fresh && fresh.includes(p) ? <span className="tag new">new</span> : null}<p>{d.detail}</p></div>
        </li>
      ); })}
    </ul>
  );
}
function Contributes({ m, actions }: { m: PluginManifest; actions?: PluginAction[] }) {
  const rows: string[] = [];
  if (isPython(m)) {
    if (!actions || !actions.length) return <p className="plg-muted">Board editor commands under Tools → External Plugins. A Python plugin names them when it first runs.</p>;
    for (const a of actions) rows.push(`Command: ${a.name}`);
    return <ul className="plg-adds">{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
  }
  for (const a of m.actions || []) rows.push(`Command: ${a.name}${a.key ? ` (${a.key})` : ""}`);
  if (m.panel) rows.push(`Panel: ${m.panel.name}`);
  for (const i of m.importers || []) rows.push(`Import: ${i.name}`);
  for (const e of m.exporters || []) rows.push(`Export: ${e.name}`);
  for (const t of m.assistant_tools || []) rows.push(`Assistant tool: ${t.name}`);
  return rows.length ? <ul className="plg-adds">{rows.map((r) => <li key={r}>{r}</li>)}</ul> : null;
}
const scopesOf = (m: PluginManifest) => { if (isPython(m)) return "PCB"; const all = new Set<string>(); for (const a of [...(m.actions || []), ...(m.importers || []), ...(m.exporters || [])]) for (const s of a.scopes || ["pcb", "schematic"]) all.add(s); if (m.panel) for (const s of m.panel.scopes || ["pcb", "schematic"]) all.add(s); return Array.from(all).sort().map((s) => (s === "pcb" ? "PCB" : "Schematic")).join(" · "); };

function ConsentSheet() {
  const c = usePlugins((x) => x.consent); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!c) return null; const m = c.manifest; const perms = m.permissions || [];
  return (
    <div className="plg-consent" id="pluginConsent">
      <h2>{c.update ? "Update" : "Install"} {m.name}?</h2>
      <p className="plg-muted">{m.identifier}{m.version ? ` · version ${m.version}` : ""}{m.author ? ` · by ${m.author}` : ""}<br />From: {sourceLabel(c.source)}</p>
      {c.source.startsWith("registry:") ? <p className="plg-warn" id="pluginUnreviewed">Community plugins are published by other people and are not reviewed. Install it only if you trust {c.source.slice(9)}, and read what it asks for below.</p> : null}
      <p>{m.description}</p>
      <h3>It will be able to</h3>
      <Permissions perms={perms} fresh={c.update ? c.added : undefined} m={c.manifest} />
      <h3>It adds</h3>
      <Contributes m={m} />
      {isPython(m) ? <p className="plg-muted" id="pluginPythonNote">This is a KiCad desktop plugin, written in Python for the desktop's <code>pcbnew</code> and <code>wx</code> modules. Here it runs on a Python interpreter inside the sandbox, against this editor's version of those modules. Most of what such plugins do is covered; anything that needs a program on your computer, another Python package or the network is not, and the plugin's log says so when it happens.</p> : null}
      <p className="plg-muted">Plugins are other people's code. It runs sandboxed in your browser only, with nothing beyond the permissions above, and only while it is enabled. Your collaborators do not run it; they see what it changes as your edits.</p>
      {err ? <p className="plg-err">{err}</p> : null}
      <div className="plg-row end"><button type="button" className="btn" onClick={() => cancelInstall()}>Cancel</button>
        <button type="button" className="btn primary" id="pluginConsentOk" disabled={busy} onClick={async () => { setBusy(true); setErr(await confirmInstall()); setBusy(false); }}>{c.update ? "Update" : "Install"}{perms.length ? " and allow" : ""}</button></div>
    </div>
  );
}

const sourceLabel = (source: string) => (source === "catalog" ? "the built-in catalog" : source.startsWith("kicad") ? `KiCad's plugin repository${source.length > 6 ? `, version ${source.slice(6)}` : ""}` : source === "local" ? "files on your computer" : source.startsWith("registry:") ? `the community registry, published by ${source.slice(9)}` : source);

function InstalledTab() {
  const s = usePlugins((x) => x); const sel = s.installed.find((p) => p.identifier === s.manager.selected) || s.installed[0] || null;
  if (!s.signedIn) return <div className="plg-empty">Sign in to install plugins. They are kept with your account and follow you to any browser.</div>;
  if (!s.installed.length) return <div className="plg-empty"><p>No plugins yet.</p><button type="button" className="btn primary" onClick={() => setManager({ tab: "catalog" })}>Browse the catalog</button></div>;
  return (
    <div className="plg-split">
      <ul className="plg-list" id="pluginList">
        {s.installed.map((p) => { const run = s.running[p.identifier]; return (
          <li key={p.identifier} className={cx(sel && sel.identifier === p.identifier && "on")} data-plugin={p.identifier} onClick={() => setManager({ selected: p.identifier })}>
            <span className={cx("state", p.withdrawn ? "bad" : !p.enabled ? "off" : run ? (run.failed ? "bad" : run.ready ? "run" : "wait") : "idle")} title={p.withdrawn ? "Taken out of the registry by the administrators" : !p.enabled ? "Disabled" : run ? (run.failed ? "Failed to start" : "Running") : "Starts when you open a project"} />
            {p.source.startsWith("kicad") ? <PcmIcon identifier={p.identifier} has small /> : null}
            <span className="nm">{p.manifest.name}</span><span className="ver">{p.manifest.version || ""}</span>
          </li>
        ); })}
      </ul>
      {sel ? <Detail p={sel} key={sel.identifier} /> : null}
    </div>
  );
}
function Detail({ p }: { p: InstalledPlugin }) {
  const run = usePlugins((x) => x.running[p.identifier]); const lines = usePlugins((x) => x.logs[p.identifier]) || []; const m = p.manifest;
  const logEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const el = logEl.current; if (el) el.scrollTop = el.scrollHeight; }, [lines.length]);
  const s = usePlugins((x) => x); const me = useApp((st) => st.me); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const pub = s.published[p.identifier]; const known = p.identifier in s.published; const origin = originOf(p, s);
  const python = isPython(m); const pyActs = actionsOf(p, s);
  useEffect(() => { if (p.source !== "catalog" && !python) void lookupPublished(p.identifier); }, [p.identifier, p.source, python]);
  const mine = !!pub && !!me && pub.publisher === me.login; const recommended = s.project.plugins.some((r) => r.identifier === p.identifier);
  const act = async (fn: () => Promise<string | null>) => { setBusy(true); setErr(await fn()); setBusy(false); };
  return (
    <div className="plg-detail" id="pluginDetail">
      <div className="plg-row">
        {p.source.startsWith("kicad") ? <PcmIcon identifier={p.identifier} has /> : null}
        <h2>{m.name}</h2><span className="plg-muted">{m.version || ""}</span><span className="grow" />
        <label className="plg-switch"><input type="checkbox" id="pluginEnabled" checked={p.enabled} onChange={(e) => { if (e.target.checked && p.withdrawn && !confirm(`The administrators took ${m.name} out of the registry:\n\n${p.withdrawn}\n\nSwitch it on anyway?`)) return; void setEnabled(p.identifier, e.target.checked); }} /> Enabled</label>
      </div>
      {p.withdrawn ? <p className="plg-warn bad" id="pluginWithdrawn">The administrators took this plugin out of the community registry, and your copy was switched off. Their reason: {p.withdrawn} The copy is still yours: uninstall it, or switch it back on if you trust it.</p> : null}
      <p className="plg-muted">{m.identifier}{m.author ? ` · by ${m.author}` : ""}{scopesOf(m) ? ` · ${scopesOf(m)}` : ""}{m.homepage && /^https:\/\//.test(m.homepage) ? <> · <a href={m.homepage} target="_blank" rel="noreferrer noopener">homepage ↗</a></> : null}</p>
      <p>{m.description}</p>
      <h3>Permissions you granted</h3><Permissions perms={p.granted} m={p.manifest} />
      <h3>Adds</h3><Contributes m={m} actions={pyActs} />
      {python ? <p className="plg-muted" id="pluginPython">A KiCad Python plugin from {sourceLabel(p.source)}. Its interpreter starts the first time you use one of its commands in a project, which takes a few seconds; after that it stays ready.{run && run.error ? <><br /><span className="plg-err">It reported: {run.error}</span></> : null}</p> : null}
      {python || (p.source === "catalog" && !(s.project.id && s.project.canEdit)) ? null : (
        <>
          <h3>Sharing</h3>
          <div className="plg-share" id="pluginShare">
            {p.source === "catalog" ? null : !known ? <p className="plg-muted">Checking the registry…</p> : pub && pub.status !== "listed" ? (
              <p className="plg-muted" id="pluginModerated">{mine ? "The administrators" : `Published by ${pub.publisher}; the administrators`} {pub.status === "hidden" ? "hid" : "removed"} {mine ? "your listing" : "the listing"}{pub.reason ? `: ${pub.reason}` : "."}{mine ? " It cannot be published again while that stands." : ""}</p>
            ) : pub && !mine ? <p className="plg-muted">In the community registry, published by {pub.publisher} (version {pub.version || "?"}).</p> : pub ? (
              <div className="plg-row"><span className="grow">You published version {pub.version || "?"} to the community registry.</span>
                {(m.version || "") !== pub.version ? <button type="button" className="btn sm" id="pluginPublish" disabled={busy} onClick={() => void act(() => publish(p.identifier))}>Publish {m.version || "this copy"}</button> : null}
                <button type="button" className="btn sm danger" id="pluginUnpublish" disabled={busy} onClick={() => { if (confirm(`Remove ${m.name} from the registry? People who installed it keep their copy.`)) void act(() => unpublish(p.identifier)); }}>Unpublish</button></div>
            ) : (
              <div className="plg-row"><span className="grow plg-muted">Only you have this plugin. Publishing lists this copy in the community registry under your name, for anyone to install.</span>
                <button type="button" className="btn sm" id="pluginPublish" disabled={busy} onClick={() => { if (confirm(`Publish ${m.name} ${m.version || ""} to the community registry as ${me ? me.login : "you"}? Anyone will be able to see and install it.`)) void act(() => publish(p.identifier)); }}>Publish…</button></div>
            )}
            {s.project.id && s.project.canEdit ? (
              <label className="plg-check" title={origin ? "Collaborators are shown it and choose for themselves. It never installs or runs for them on its own." : "Publish it first: collaborators need somewhere to get it from."}>
                <input type="checkbox" id="pluginRecommend" checked={recommended} disabled={busy || (!origin && !recommended)} onChange={(e) => void act(() => recommend(p.identifier, origin || "registry", e.target.checked))} />
                Recommend to this project's collaborators{origin ? "" : " (publish it first)"}
              </label>
            ) : null}
            {err ? <p className="plg-err" id="pluginShareErr">{err}</p> : null}
          </div>
        </>
      )}
      <h3>Log <span className={cx("plg-status", run && run.failed && "bad", run && run.ready && !run.failed && "run")}>{run ? (run.failed ? "failed to start" : run.busy ? `running: ${run.busy}` : run.ready ? "running" : "starting") : p.enabled ? (python && pyActs.length ? "starts when you use it" : "not running (open a project)") : "disabled"}</span></h3>
      <div className="plg-log" id="pluginLog" ref={logEl}>{lines.length ? lines.map((l, i) => <div key={i} className={l.level}><time>{new Date(l.at).toLocaleTimeString()}</time>{l.text}</div>) : <div className="plg-muted">Nothing logged yet. A plugin's console output appears here.</div>}</div>
      <div className="plg-row end">
        <button type="button" className="btn sm" onClick={() => clearLog(p.identifier)}>Clear log</button>
        <button type="button" className="btn sm" disabled={!p.enabled} onClick={() => restart(p.identifier)}>Restart</button>
        <button type="button" className="btn sm danger" id="pluginUninstall" onClick={() => { if (confirm(`Uninstall ${m.name}? Its stored settings are removed too.`)) void uninstall(p.identifier); }}>Uninstall</button>
      </div>
    </div>
  );
}

const COMPAT_LABEL: Record<Compat["status"], string> = { works: "Runs here", partly: "Partly runs", opens: "Opens, unverified", limited: "Limited here", unsupported: "Does not run here yet", untested: "Not tested yet" };
/** KiCad's own repository: the plugins the desktop's Plugin and Content Manager lists, runnable here through the Python runtime. */
/** A KiCad repository plugin's own icon, as KiCad's Plugin and Content Manager shows it; a plain plug mark when it has none. */
function PcmIcon({ identifier, has, small }: { identifier: string; has: boolean; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  return has && !failed
    ? <img className={cx("plg-icon", small && "sm")} src={`/api/plugins/pcm/${encodeURIComponent(identifier)}/icon`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span className={cx("plg-icon none", small && "sm")} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v3" /></svg></span>;
}

type Source = "all" | "builtin" | "kicad" | "community";
const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const SOURCE_NOTE: Record<Source, string> = {
  all: "Everything you can install, in one list: the plugins built into Junction, the ones in KiCad's own Plugin and Content Manager, and the ones other people published here. You are shown what a plugin asks for before it is installed.",
  builtin: "These ship with Junction and double as examples: their source is in server/plugins.",
  kicad: "The plugins in KiCad's own Plugin and Content Manager. They are Python programs written for the desktop; here each runs on a Python interpreter in the plugin sandbox, on your board, with its dialogs drawn in the editor. Each label comes from a test run: the plugin was loaded and every command it adds was run on a demo board.",
  community: "Published by other people and not reviewed. You are shown who published a plugin and everything it asks for before it is installed.",
};

/** The one catalog: built-in plugins, KiCad's repository and the community registry in a single searchable list,
 *  as KiCad's Plugin and Content Manager shows its plugins.  Each card says where the plugin comes from. */
function CatalogTab() {
  const s = usePlugins((x) => x); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState(""); const [source, setSource] = useState<Source>("all"); const [all, setAll] = useState(false); const timer = useRef(0);
  // the catalog opens unfiltered each time; KiCad's list is asked for once
  useEffect(() => { void loadOfficial(); if (s.registryQuery) void loadRegistry(""); return () => clearTimeout(timer.current); }, []);
  const search = (v: string) => { setQ(v); clearTimeout(timer.current); timer.current = window.setTimeout(() => void loadRegistry(v.trim()), 220); };
  const have = (id: string) => s.installed.find((p) => p.identifier === id);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (m: PluginManifest, extra = "") => words.every((w) => `${m.name} ${m.description} ${m.identifier} ${m.author || ""} ${extra}`.toLowerCase().includes(w));
  const builtin = (s.catalog || []).filter((c) => match(c.manifest));
  const official = s.official || []; const hidden = official.filter((e) => e.compat && e.compat.status === "unsupported").length;
  const kicad = official.filter((e) => (all || words.length > 0 || !e.compat || e.compat.status !== "unsupported") && match(e.manifest));
  // the registry is searched by the server; what it sent for an older query is filtered here until the answer arrives
  const community = (s.registry || []).filter((r) => match(r.manifest, r.publisher));
  type Row = { key: string; name: string; node: ReactNode };
  const rows: Row[] = [];
  const installBuiltin = (c: CatalogEntry) => setErr(s.signedIn ? requestInstall(c.manifest, c.files, "catalog") : "Sign in to install plugins.");
  const installKicad = async (e: OfficialEntry) => { setBusy(e.identifier); setErr(null); setErr(await installOfficial(e.identifier)); setBusy(null); };
  if (source === "all" || source === "builtin") for (const c of builtin) { const m = c.manifest; const cur = have(m.identifier); const newer = cur && (cur.manifest.version || "") !== (m.version || ""); rows.push({ key: `b:${m.identifier}`, name: m.name, node: (
    <div className="plg-card with-icon" key={`b:${m.identifier}`} data-plugin={m.identifier} data-source="builtin">
      <PcmIcon identifier={m.identifier} has={false} />
      <div className="plg-card-body">
        <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span><span className="plg-from">Built in</span><span className="grow" /><span className="plg-muted">{scopesOf(m)}</span></div>
        <p>{m.description}</p>
        <div className="plg-row"><span className="plg-muted perms">{(m.permissions || []).map((p) => describePermission(p, m).title).join(" · ") || "No permissions"}</span><span className="grow" />
          {cur && !newer ? <span className="plg-muted">Installed</span> : <button type="button" className="btn sm primary" data-install={m.identifier} onClick={() => installBuiltin(c)}>{newer ? "Update…" : "Install…"}</button>}</div>
      </div>
    </div>) }); }
  if (source === "all" || source === "kicad") for (const e of kicad) { const m = e.manifest; const cur = have(m.identifier); const newer = cur && (cur.manifest.version || "") !== (m.version || ""); const c = e.compat; rows.push({ key: `k:${e.identifier}`, name: m.name, node: (
    <div className="plg-card with-icon" key={`k:${e.identifier}`} data-plugin={e.identifier} data-source="kicad">
      <PcmIcon identifier={e.identifier} has={e.icon !== false} />
      <div className="plg-card-body">
        <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span>{m.author ? <span className="plg-muted">by {m.author}</span> : null}<span className="plg-from" title="From KiCad's Plugin and Content Manager">KiCad</span><span className="grow" />
          {c ? <span className={cx("plg-compat", c.status)} title={c.note || ""}>{COMPAT_LABEL[c.status] || c.status}</span> : <span className="plg-compat" title="Newer than this editor's test run">Not tested yet</span>}</div>
        <p>{m.description}</p>
        {c && c.note && c.status !== "works" ? <p className="plg-muted">{c.note}</p> : null}
        <div className="plg-row"><span className="plg-muted perms">{e.identifier}{e.size ? ` · ${sizeOf(e.size)}` : ""}{m.homepage && /^https:\/\//.test(m.homepage) ? <> · <a href={m.homepage} target="_blank" rel="noreferrer noopener">homepage ↗</a></> : null}</span><span className="grow" />
          {cur && !newer ? <span className="plg-muted">Installed</span> : <button type="button" className="btn sm primary" data-install={e.identifier} disabled={busy !== null} onClick={() => void installKicad(e)}>{busy === e.identifier ? "Downloading…" : newer ? "Update…" : "Install…"}</button>}</div>
      </div>
    </div>) }); }
  if (source === "all" || source === "community") for (const r of community) rows.push({ key: `c:${r.identifier}`, name: r.manifest.name, node: <RegistryCard key={`c:${r.identifier}`} r={r} setErr={setErr} /> });
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const loadingKicad = s.official === null && source !== "builtin" && source !== "community";
  const loading = s.catalog === null || s.registry === null;
  const total = (s.catalog || []).length + official.length + (s.registry || []).length;
  const chips: [Source, string, number | null][] = [["all", "All", null], ["builtin", "Built in", s.catalog ? builtin.length : null], ["kicad", "KiCad", s.official ? kicad.length : null], ["community", "Community", s.registry ? community.length : null]];
  return (
    <div className="plg-catalog" id="pluginCatalog">
      <div className="plg-row plg-catalog-head"><input type="search" id="pluginSearch" className="plg-search" placeholder={total ? `Search ${total} plugins` : "Search plugins"} value={q} onChange={(e) => search(e.target.value)} /></div>
      <div className="plg-row plg-catalog-head">
        <div className="plg-chips" role="tablist" aria-label="Where plugins come from">{chips.map(([id, label, n]) => <button type="button" key={id} role="tab" aria-selected={source === id} className={cx(source === id && "on")} data-source-filter={id} onClick={() => setSource(id)}>{label}{n !== null ? <span className="n">{n}</span> : null}</button>)}</div>
        <span className="grow" />
        {hidden && source !== "builtin" && source !== "community" ? <label className="plg-check"><input type="checkbox" id="pluginKicadAll" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show the {hidden} KiCad plugins that do not run here</label> : null}
      </div>
      <p className="plg-muted plg-source-note">{SOURCE_NOTE[source]}</p>
      {err ? <p className="plg-err" id="pluginCatalogErr">{err}</p> : null}
      {s.officialError && source !== "builtin" && source !== "community" ? <p className="plg-err" id="pluginKicadErr">KiCad's repository could not be read: {s.officialError} <button type="button" className="btn sm" onClick={() => void loadOfficial(true)}>Try again</button></p> : null}
      {loadingKicad ? <p className="plg-muted plg-loading" id="pluginKicadLoading"><span className="plg-spin" aria-hidden="true" />Loading KiCad's repository…</p> : null}
      {rows.map((r) => r.node)}
      {!rows.length && !loading && !loadingKicad ? <div className="plg-empty" id="pluginCatalogEmpty">{words.length ? `Nothing matches "${q.trim()}".` : source === "community" ? "Nothing has been published yet. Yours could be the first: install a plugin from a file, then publish it from its page." : "Nothing here yet."}</div> : null}
      {!rows.length && loading ? <div className="plg-empty">Loading…</div> : null}
    </div>
  );
}

const when = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
function RegistryCard({ r, setErr }: { r: RegistryEntry; setErr: (e: string | null) => void }) {
  const cur = usePlugins((x) => x.installed.find((p) => p.identifier === r.identifier)); const m = r.manifest; const [busy, setBusy] = useState(false);
  const newer = cur && (cur.manifest.version || "") !== (m.version || "");
  const [reporting, setReporting] = useState(false); const [why, setWhy] = useState(""); const [sent, setSent] = useState(false); const [rerr, setRerr] = useState<string | null>(null);
  const send = async () => { setBusy(true); const e = await report(r.identifier, why); setBusy(false); setRerr(e); if (!e) { setSent(true); setReporting(false); setWhy(""); } };
  return (
    <div className="plg-card with-icon" data-plugin={r.identifier} data-source="community">
      <PcmIcon identifier={r.identifier} has={false} />
      <div className="plg-card-body">
      <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span><span className="plg-from" title="Published by this person in the community registry; not reviewed">Community · by {r.publisher}</span><span className="grow" /><span className="plg-muted">{scopesOf(m)}</span></div>
      <p>{m.description}</p>
      <p className="plg-muted plg-meta">{r.identifier} · {r.installs} install{r.installs === 1 ? "" : "s"}{when(r.updatedAt) ? ` · updated ${when(r.updatedAt)}` : ""}</p>
      <div className="plg-row"><span className="plg-muted perms">{(m.permissions || []).map((p) => describePermission(p, m).title).join(" · ") || "No permissions"}</span><span className="grow" />
        {cur && !newer ? <span className="plg-muted">Installed</span> : <button type="button" className="btn sm primary" data-install={r.identifier} disabled={busy} onClick={async () => { setBusy(true); setErr(await installFromRegistry(r.identifier)); setBusy(false); }}>{newer ? "Update…" : "Install…"}</button>}</div>
      <div className="plg-report">
        {sent ? <span className="plg-muted" data-reported={r.identifier}>Reported. The administrators will look at it.</span> : reporting ? (
          <>
            <textarea rows={2} data-report-reason={r.identifier} autoFocus placeholder="What is wrong with this plugin? The administrators read this." value={why} maxLength={1000} onChange={(e) => setWhy(e.target.value)} />
            {rerr ? <p className="plg-err">{rerr}</p> : null}
            <div className="plg-row end"><button type="button" className="btn sm" onClick={() => { setReporting(false); setRerr(null); }}>Cancel</button><button type="button" className="btn sm" data-report-send={r.identifier} disabled={busy || why.trim().length < 10} onClick={() => void send()}>Send report</button></div>
          </>
        ) : <button type="button" className="plg-link" data-report={r.identifier} onClick={() => setReporting(true)}>Report a problem…</button>}
      </div>
      </div>
    </div>
  );
}

/** For the server's administrators: published plugins that were reported, hidden or removed, and what to do about each. */
function ModerationTab() {
  const list = usePlugins((x) => x.moderation);
  if (list === null) return <div className="plg-empty">Loading…</div>;
  return (
    <div className="plg-catalog" id="pluginModeration">
      <p className="plg-muted">Published plugins that someone reported, or that you hid or removed. Hiding takes a plugin out of the registry and out of project recommendations and switches off the copies people installed from it; they are told your reason. Removing does the same for good and drops its files.</p>
      {!list.length ? <div className="plg-none" id="pluginModerationEmpty">Nothing is waiting. Reports appear here.</div> : list.map((e) => <ModerationCard key={e.identifier} e={e} />)}
    </div>
  );
}
function ModerationCard({ e }: { e: ModerationEntry }) {
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const m = e.manifest;
  const act = async (action: "hide" | "restore" | "remove" | "dismiss") => {
    if (action === "remove" && !confirm(`Remove ${m.name} from the registry for good? Its files are dropped and the identifier cannot be published again.`)) return;
    setBusy(true); const r = await moderate(e.identifier, action, reason); setBusy(false); setErr(r); if (!r) setReason("");
  };
  const needs = reason.trim().length < 5;
  return (
    <div className="plg-card" data-plugin={e.identifier}>
      <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span><span className="plg-from">by {e.publisher}</span><span className={cx("plg-status", e.status !== "listed" && "bad")}>{e.status}</span><span className="grow" /><span className="plg-muted">{e.installs} install{e.installs === 1 ? "" : "s"}</span></div>
      <p className="plg-muted plg-meta">{e.identifier} · {(m.permissions || []).map((p) => describePermission(p, m).title).join(" · ") || "No permissions"}</p>
      {e.status !== "listed" && e.reason ? <p>Your reason: {e.reason}</p> : null}
      {e.reports.length ? <ul className="plg-reports">{e.reports.map((r, i) => <li key={i}><b>{r.reporter}</b> <span className="plg-muted">{when(r.at)}</span><br />{r.reason}</li>)}</ul> : null}
      {err ? <p className="plg-err">{err}</p> : null}
      {e.status === "removed" ? null : (
        <div className="plg-row">
          {e.status === "listed" ? <input type="text" className="grow" data-mod-reason={e.identifier} placeholder="Reason, shown to the publisher and to people who installed it" value={reason} maxLength={500} onChange={(ev) => setReason(ev.target.value)} /> : <span className="grow" />}
          {e.status === "listed" && e.reports.length ? <button type="button" className="btn sm" data-mod="dismiss" disabled={busy} onClick={() => void act("dismiss")}>Dismiss reports</button> : null}
          {e.status === "listed" ? <button type="button" className="btn sm" data-mod="hide" disabled={busy || needs} onClick={() => void act("hide")}>Hide</button> : <button type="button" className="btn sm" data-mod="restore" disabled={busy} onClick={() => void act("restore")}>Restore</button>}
          {e.status === "listed" ? <button type="button" className="btn sm danger" data-mod="remove" disabled={busy || needs} onClick={() => void act("remove")}>Remove</button> : null}
        </div>
      )}
    </div>
  );
}

/** What the open project recommends.  A list to choose from: nothing here installs or runs by itself. */
function ProjectTab() {
  const s = usePlugins((x) => x); const name = useApp((st) => (st.project ? st.project.name : "")); const [err, setErr] = useState<string | null>(null);
  if (!s.project.id) return <div className="plg-empty">Open a project to see the plugins it recommends.</div>;
  const recs = s.project.plugins;
  return (
    <div className="plg-catalog" id="pluginProject">
      <p className="plg-muted">Plugins that people working on {name || "this project"} suggest to each other. A recommendation is only a pointer: each person installs for themselves, after seeing what the plugin asks for, and it runs in their own browser only.</p>
      {err ? <p className="plg-err">{err}</p> : null}
      {!recs.length ? <div className="plg-none" id="pluginProjectEmpty">{s.project.canEdit ? "Nothing is recommended yet. Open one of your installed plugins and tick “Recommend to this project's collaborators”." : "Nothing is recommended for this project."}</div> : recs.map((r) => <ProjectCard key={r.identifier} r={r} canEdit={s.project.canEdit} setErr={setErr} />)}
    </div>
  );
}
function ProjectCard({ r, canEdit, setErr }: { r: ProjectPlugin; canEdit: boolean; setErr: (e: string | null) => void }) {
  const cur = usePlugins((x) => x.installed.find((p) => p.identifier === r.identifier)); const m = r.manifest; const newer = cur && (cur.manifest.version || "") !== (m.version || "");
  return (
    <div className="plg-card" data-plugin={r.identifier}>
      <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span><span className="plg-from">{r.origin === "catalog" ? "built in" : `by ${r.publisher || "unknown"}`}</span><span className="grow" /><span className="plg-muted">{scopesOf(m)}</span></div>
      <p>{m.description}</p>
      <div className="plg-row"><span className="plg-muted perms">{r.addedBy ? `Recommended by ${r.addedBy} · ` : ""}{(m.permissions || []).map((p) => describePermission(p, m).title).join(" · ") || "No permissions"}</span><span className="grow" />
        {canEdit ? <button type="button" className="btn sm" data-unrecommend={r.identifier} onClick={async () => setErr(await recommend(r.identifier, r.origin, false))}>Stop recommending</button> : null}
        {cur && !newer ? <span className="plg-muted">Installed</span> : <button type="button" className="btn sm primary" data-install={r.identifier} onClick={() => setErr(installRecommended(r))}>{newer ? "Update…" : "Install…"}</button>}</div>
    </div>
  );
}

function DevelopTab() {
  const signedIn = usePlugins((x) => x.signedIn); const [url, setUrl] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const take = async (load: () => Promise<{ manifest: PluginManifest; files: Record<string, string>; source: string }>) => {
    if (!signedIn) { setErr("Sign in to install plugins."); return; }
    setBusy(true); setErr(null);
    try { const got = await load(); setErr(requestInstall(got.manifest, got.files, got.source)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <div className="plg-develop">
      <h3>Install from an address</h3>
      <p className="plg-muted">The address of a plugin.json, or of the folder that holds it — a GitHub link works. Your browser fetches it; you are shown what it asks for before anything is installed.</p>
      <div className="plg-row"><input type="text" id="pluginUrl" className="grow" placeholder="https://github.com/you/your-plugin/blob/main/plugin.json" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void take(() => fetchFromUrl(url)); }} />
        <button type="button" className="btn" disabled={busy || !url.trim()} onClick={() => void take(() => fetchFromUrl(url))}>Fetch…</button></div>
      <h3>Load from your computer</h3>
      <p className="plg-muted">Pick a plugin's folder, or its plugin.json together with the files it names. Load it again after you edit it: an installed plugin is replaced by the new copy.</p>
      <div className="plg-row">
        <label className="btn">Choose folder…<input type="file" hidden multiple {...({ webkitdirectory: "" } as object)} onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; if (fs.length) void take(() => readLocalFiles(fs)); }} /></label>
        <label className="btn">Choose files…<input type="file" id="pluginFiles" hidden multiple onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; if (fs.length) void take(() => readLocalFiles(fs)); }} /></label>
      </div>
      {err ? <p className="plg-err" id="pluginDevErr">{err}</p> : null}
      <h3>Writing a plugin</h3>
      <p>A plugin is a folder with a <code>plugin.json</code> — KiCad's own plugin manifest, with <code>"runtime": {"{"}"type": "web", "entrypoint": "main.js"{"}"}</code> — and a script that uses the <code>kicad</code> object: <code>kicad.actions.register()</code>, <code>kicad.design.components()</code>, <code>kicad.design.apply()</code>, <code>kicad.ui.prompt()</code>…</p>
      <p>The guide and the API reference are in <a href="https://github.com/notaroomba/junction/blob/master/server/plugins/README.md" target="_blank" rel="noreferrer noopener">server/plugins/README.md ↗</a>; the catalog plugins beside it are short, complete examples.</p>
      <p className="plg-muted">Python and exec plugins for the desktop app (KiCad's IPC API and action plugins) are installed there, in its Plugin and Content Manager. What they change in an online project reaches the web like any other edit.</p>
    </div>
  );
}

export function PluginManager() {
  const mgr = usePlugins((x) => x.manager); const consent = usePlugins((x) => x.consent); const error = usePlugins((x) => x.error); const n = usePlugins((x) => x.installed.length);
  const recs = usePlugins((x) => (x.project.id ? x.project.plugins.length : -1));
  const admin = usePlugins((x) => x.admin); const waiting = usePlugins((x) => (x.moderation || []).filter((e) => e.status === "listed").length);
  if (!mgr.open) return null;
  const tabs: [typeof mgr.tab, string][] = [["installed", `Installed${n ? ` (${n})` : ""}`], ["catalog", "Catalog"], ...(recs >= 0 ? [["project", `This project${recs ? ` (${recs})` : ""}`] as [typeof mgr.tab, string]] : []), ["develop", "Install from file or URL"], ...(admin ? [["moderation", `Moderation${waiting ? ` (${waiting})` : ""}`] as [typeof mgr.tab, string]] : [])];
  return (
    <div className="kd-overlay plg-overlay" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { if (consent) cancelInstall(); else closeManager(); } }} onPointerDown={(e) => { if (e.target === e.currentTarget) closeManager(); }}>
      <div className={cx("kd-dialog plg-manager", consent && "consenting")} role="dialog" aria-modal="true" id="pluginManager" tabIndex={-1}>
        <div className="kd-title"><span>Plugin Manager</span><span className="kd-x" title="Close (Esc)" onClick={() => closeManager()}>×</span></div>
        {consent ? <div className="kd-body"><ConsentSheet /></div> : (
          <>
            <div className="plg-mtabs">{tabs.map(([id, label]) => <button type="button" key={id} className={cx(mgr.tab === id && "on")} data-tab={id} onClick={() => setManager({ tab: id })}>{label}</button>)}</div>
            <div className="kd-body">
              {error ? <p className="plg-err">{error}</p> : null}
              {mgr.tab === "installed" ? <InstalledTab /> : mgr.tab === "catalog" ? <CatalogTab /> : mgr.tab === "project" ? <ProjectTab /> : mgr.tab === "moderation" && admin ? <ModerationTab /> : <DevelopTab />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The dialogs sit at page level (not in the editor), so the home view can open the manager too. */
export function PluginDialogs() { return <><PluginWindow /><PluginPrompt /><PluginManager /><RecommendBar /></>; }

/**
 * The notice that the open project recommends plugins this person does not have — KiCad's
 * infobar, across the top of the canvas.  It points at the list and can be closed; it installs nothing.
 */
function RecommendBar() {
  const n = usePlugins((x) => (recommendedPending(x) ? missingRecommended(x).length : 0)); const view = useApp((st) => st.view);
  // Beside the canvas, not inside it: the canvas captures every pointer that goes down on it.
  const stage = typeof document !== "undefined" ? document.getElementById("editorBody") : null;
  if (!n || view !== "editor" || !stage) return null;
  return createPortal(
    <div className="plg-infobar" id="pluginRecommended" role="status">
      {PUZZLE}<span className="grow">This project recommends {n === 1 ? "a plugin" : `${n} plugins`} you do not have. Nothing is installed unless you choose to.</span>
      <button type="button" className="btn sm" id="pluginRecommendedShow" onClick={() => openManager("project")}>Show…</button>
      <button type="button" className="plg-ib" id="pluginRecommendedDismiss" title="Dismiss" aria-label="Dismiss" onClick={() => dismissRecommended()}>×</button>
    </div>, stage);
}
