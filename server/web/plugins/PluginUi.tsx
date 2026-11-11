// PluginUi.tsx — the chrome plugins get: the dock their panels sit in, the toolbar buttons of
// their actions, the dialogs the host draws on their behalf, and the manager (KiCad's Plugin and
// Content Manager, for the web): what is installed, what it may do, a catalog, and a developer tab.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { cx } from "../util";
import {
  actionsFor, answerPrompt, cancelInstall, clearLog, closeManager, closePanels, confirmInstall, exportersFor, fetchFromUrl, importersFor, initPlugins, openManager, panelsFor,
  readLocalFiles, requestInstall, restart, runPluginUi, setEnabled, setFrameHost, setManager, setPanelWidth, showPanel, uninstall, usePlugins,
  type CatalogEntry, type PromptField, type PromptRequest,
} from "./host";
import { describePermission, type InstalledPlugin, type PluginManifest } from "./types";

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
    const t = title.toLowerCase(); let out = entries;
    if (t === "file" && (imps.length || exps.length)) {
      const extra: MenuEntry[] = []; if (imps.length) extra.push(["Import", imps.map((x) => x.uiId)]); if (exps.length) extra.push(["Export", exps.map((x) => x.uiId)]);
      const at = out.indexOf("print"); out = at >= 0 ? [...out.slice(0, at), ...extra, "-", ...out.slice(at)] : [...out, "-", ...extra];
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
        {icon ? <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} /> : PUZZLE}
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
  const run = active ? s.running[active.plugin] : undefined;
  // The frames stay mounted (and their plugins running) while the dock is closed: only its size goes.
  return (
    <aside id="dockPlugins" className={cx(!shown && "closed", drag && "drag")} style={shown ? { width: s.panel.width } : undefined} onKeyDown={(e) => e.stopPropagation()}>
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
function Permissions({ perms, fresh }: { perms: string[]; fresh?: string[] }) {
  if (!perms.length) return <p className="plg-muted">Needs no permissions: it cannot read or change your designs.</p>;
  return (
    <ul className="plg-perms">
      {perms.map((p) => { const d = describePermission(p); return (
        <li key={p} className={cx(d.risk)} data-perm={p}>
          <span className="dot" /><div><b>{d.title}</b>{RISK_LABEL[d.risk] ? <span className="tag">{RISK_LABEL[d.risk]}</span> : null}{fresh && fresh.includes(p) ? <span className="tag new">new</span> : null}<p>{d.detail}</p></div>
        </li>
      ); })}
    </ul>
  );
}
function Contributes({ m }: { m: PluginManifest }) {
  const rows: string[] = [];
  for (const a of m.actions || []) rows.push(`Command: ${a.name}${a.key ? ` (${a.key})` : ""}`);
  if (m.panel) rows.push(`Panel: ${m.panel.name}`);
  for (const i of m.importers || []) rows.push(`Import: ${i.name}`);
  for (const e of m.exporters || []) rows.push(`Export: ${e.name}`);
  for (const t of m.assistant_tools || []) rows.push(`Assistant tool: ${t.name}`);
  return rows.length ? <ul className="plg-adds">{rows.map((r) => <li key={r}>{r}</li>)}</ul> : null;
}
const scopesOf = (m: PluginManifest) => { const all = new Set<string>(); for (const a of [...(m.actions || []), ...(m.importers || []), ...(m.exporters || [])]) for (const s of a.scopes || ["pcb", "schematic"]) all.add(s); if (m.panel) for (const s of m.panel.scopes || ["pcb", "schematic"]) all.add(s); return Array.from(all).sort().map((s) => (s === "pcb" ? "PCB" : "Schematic")).join(" · "); };

function ConsentSheet() {
  const c = usePlugins((x) => x.consent); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!c) return null; const m = c.manifest; const perms = m.permissions || [];
  return (
    <div className="plg-consent" id="pluginConsent">
      <h2>{c.update ? "Update" : "Install"} {m.name}?</h2>
      <p className="plg-muted">{m.identifier}{m.version ? ` · version ${m.version}` : ""}{m.author ? ` · by ${m.author}` : ""}<br />From: {c.source === "catalog" ? "the built-in catalog" : c.source === "local" ? "files on your computer" : c.source}</p>
      <p>{m.description}</p>
      <h3>It will be able to</h3>
      <Permissions perms={perms} fresh={c.update ? c.added : undefined} />
      <h3>It adds</h3>
      <Contributes m={m} />
      <p className="plg-muted">Plugins are other people's code. It runs sandboxed in your browser only, with nothing beyond the permissions above, and only while it is enabled. Your collaborators do not run it; they see what it changes as your edits.</p>
      {err ? <p className="plg-err">{err}</p> : null}
      <div className="plg-row end"><button type="button" className="btn" onClick={() => cancelInstall()}>Cancel</button>
        <button type="button" className="btn primary" id="pluginConsentOk" disabled={busy} onClick={async () => { setBusy(true); setErr(await confirmInstall()); setBusy(false); }}>{c.update ? "Update" : "Install"}{perms.length ? " and allow" : ""}</button></div>
    </div>
  );
}

function InstalledTab() {
  const s = usePlugins((x) => x); const sel = s.installed.find((p) => p.identifier === s.manager.selected) || s.installed[0] || null;
  if (!s.signedIn) return <div className="plg-empty">Sign in to install plugins. They are kept with your account and follow you to any browser.</div>;
  if (!s.installed.length) return <div className="plg-empty"><p>No plugins yet.</p><button type="button" className="btn primary" onClick={() => setManager({ tab: "catalog" })}>Browse the catalog</button></div>;
  return (
    <div className="plg-split">
      <ul className="plg-list" id="pluginList">
        {s.installed.map((p) => { const run = s.running[p.identifier]; return (
          <li key={p.identifier} className={cx(sel && sel.identifier === p.identifier && "on")} data-plugin={p.identifier} onClick={() => setManager({ selected: p.identifier })}>
            <span className={cx("state", !p.enabled ? "off" : run ? (run.failed ? "bad" : run.ready ? "run" : "wait") : "idle")} title={!p.enabled ? "Disabled" : run ? (run.failed ? "Failed to start" : "Running") : "Starts when you open a project"} />
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
  return (
    <div className="plg-detail" id="pluginDetail">
      <div className="plg-row">
        <h2>{m.name}</h2><span className="plg-muted">{m.version || ""}</span><span className="grow" />
        <label className="plg-switch"><input type="checkbox" id="pluginEnabled" checked={p.enabled} onChange={(e) => void setEnabled(p.identifier, e.target.checked)} /> Enabled</label>
      </div>
      <p className="plg-muted">{m.identifier}{m.author ? ` · by ${m.author}` : ""}{scopesOf(m) ? ` · ${scopesOf(m)}` : ""}{m.homepage && /^https:\/\//.test(m.homepage) ? <> · <a href={m.homepage} target="_blank" rel="noreferrer noopener">homepage ↗</a></> : null}</p>
      <p>{m.description}</p>
      <h3>Permissions you granted</h3><Permissions perms={p.granted} />
      <h3>Adds</h3><Contributes m={m} />
      <h3>Log <span className="plg-muted">{run ? (run.failed ? "failed to start" : run.busy ? `running: ${run.busy}` : run.ready ? "running" : "starting") : p.enabled ? "not running (open a project)" : "disabled"}</span></h3>
      <div className="plg-log" id="pluginLog" ref={logEl}>{lines.length ? lines.map((l, i) => <div key={i} className={l.level}><time>{new Date(l.at).toLocaleTimeString()}</time>{l.text}</div>) : <div className="plg-muted">Nothing logged yet. A plugin's console output appears here.</div>}</div>
      <div className="plg-row end">
        <button type="button" className="btn sm" onClick={() => clearLog(p.identifier)}>Clear log</button>
        <button type="button" className="btn sm" disabled={!p.enabled} onClick={() => restart(p.identifier)}>Restart</button>
        <button type="button" className="btn sm danger" id="pluginUninstall" onClick={() => { if (confirm(`Uninstall ${m.name}? Its stored settings are removed too.`)) void uninstall(p.identifier); }}>Uninstall</button>
      </div>
    </div>
  );
}

function CatalogTab() {
  const s = usePlugins((x) => x); const [err, setErr] = useState<string | null>(null);
  if (s.catalog === null) return <div className="plg-empty">Loading…</div>;
  const have = (id: string) => s.installed.find((p) => p.identifier === id);
  const install = (c: CatalogEntry) => setErr(s.signedIn ? requestInstall(c.manifest, c.files, "catalog") : "Sign in to install plugins.");
  return (
    <div className="plg-catalog" id="pluginCatalog">
      {err ? <p className="plg-err">{err}</p> : null}
      {s.catalog.map((c) => { const m = c.manifest; const cur = have(m.identifier); const newer = cur && (cur.manifest.version || "") !== (m.version || ""); return (
        <div className="plg-card" key={m.identifier} data-plugin={m.identifier}>
          <div className="plg-row"><b>{m.name}</b><span className="plg-muted">{m.version || ""}</span><span className="grow" /><span className="plg-muted">{scopesOf(m)}</span></div>
          <p>{m.description}</p>
          <div className="plg-row"><span className="plg-muted perms">{(m.permissions || []).map((p) => describePermission(p).title).join(" · ") || "No permissions"}</span><span className="grow" />
            {cur && !newer ? <span className="plg-muted">Installed</span> : <button type="button" className="btn sm primary" data-install={m.identifier} onClick={() => install(c)}>{newer ? "Update…" : "Install…"}</button>}</div>
        </div>
      ); })}
      <p className="plg-muted">These ship with KiCad Collaborative and double as examples: their source is in server/plugins.</p>
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
      <p>The guide and the API reference are in <a href="https://github.com/notaroomba/kicad-collaborative/blob/master/server/plugins/README.md" target="_blank" rel="noreferrer noopener">server/plugins/README.md ↗</a>; the catalog plugins beside it are short, complete examples.</p>
      <p className="plg-muted">Python and exec plugins for the desktop app (KiCad's IPC API and action plugins) are installed there, in its Plugin and Content Manager. What they change in an online project reaches the web like any other edit.</p>
    </div>
  );
}

export function PluginManager() {
  const mgr = usePlugins((x) => x.manager); const consent = usePlugins((x) => x.consent); const error = usePlugins((x) => x.error); const n = usePlugins((x) => x.installed.length);
  if (!mgr.open) return null;
  const tabs: [typeof mgr.tab, string][] = [["installed", `Installed${n ? ` (${n})` : ""}`], ["catalog", "Catalog"], ["develop", "Install from file or URL"]];
  return (
    <div className="kd-overlay plg-overlay" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { if (consent) cancelInstall(); else closeManager(); } }} onPointerDown={(e) => { if (e.target === e.currentTarget) closeManager(); }}>
      <div className="kd-dialog plg-manager" role="dialog" aria-modal="true" id="pluginManager" tabIndex={-1}>
        <div className="kd-title"><span>Plugin Manager</span><span className="kd-x" title="Close (Esc)" onClick={() => closeManager()}>×</span></div>
        {consent ? <div className="kd-body"><ConsentSheet /></div> : (
          <>
            <div className="plg-mtabs">{tabs.map(([id, label]) => <button type="button" key={id} className={cx(mgr.tab === id && "on")} data-tab={id} onClick={() => setManager({ tab: id })}>{label}</button>)}</div>
            <div className="kd-body">
              {error ? <p className="plg-err">{error}</p> : null}
              {mgr.tab === "installed" ? <InstalledTab /> : mgr.tab === "catalog" ? <CatalogTab /> : <DevelopTab />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Everything of ours that mounts once. */
export function PluginChrome() { return <><PluginDock /><PluginPrompt /><PluginManager /></>; }
