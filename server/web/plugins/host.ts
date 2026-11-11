// host.ts — the plugin host: which plugins are installed, which are running, and the one place
// where a plugin's request is weighed against what the person granted it.
//
// Plugins belong to a person, not to a project: installing one never runs code in a
// collaborator's browser.  A plugin runs only for the person who installed and enabled it, with
// that person's access — a viewer's plugins cannot write — and what it changes reaches everyone
// else as that person's ordinary edits.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useSyncExternalStore } from "react";
import { ApiError, editorState, reads, selectionSummary, views, writes } from "./api";
import { createSandbox, type Sandbox } from "./sandbox";
import { inScope, manifestFiles, validateFiles, validateManifest, type InstalledPlugin, type PluginAction, type PluginManifest, type PluginPorter } from "./types";

const W = window as any;
const ED = (): any => W.CollabEditor;
const APP = (): any => W.CollabApp;

// ---------------------------------------------------------------- state

export interface LogLine { at: number; level: "log" | "warn" | "error" | "host"; text: string }
export interface RunState { ready: boolean; failed: boolean; busy: string | null; registered: Record<string, string[]> }
export interface PromptField { name: string; label: string; type?: "text" | "number" | "select" | "checkbox" | "textarea" | "file"; default?: unknown; options?: Array<string | { value: string; label: string }>; accept?: string[]; as?: "text" | "bytes"; placeholder?: string; min?: number; max?: number; step?: number }
export interface PromptRequest { id: number; plugin: string; pluginName: string; kind: "form" | "confirm"; title: string; message?: string; fields: PromptField[]; okLabel?: string; resolve: (v: any) => void }
export interface Consent { manifest: PluginManifest; files: Record<string, string>; source: string; update: boolean; added: string[] }
export interface CatalogEntry { manifest: PluginManifest; files: Record<string, string> }

export interface PluginState {
  loaded: boolean; signedIn: boolean; error: string | null;
  installed: InstalledPlugin[]; catalog: CatalogEntry[] | null;
  running: Record<string, RunState>; logs: Record<string, LogLine[]>;
  manager: { open: boolean; tab: "installed" | "catalog" | "develop"; selected: string | null };
  panel: { open: boolean; active: string | null; width: number };
  prompt: PromptRequest | null; consent: Consent | null;
  editor: string | null;
}

const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* no storage */ } }, del(k: string) { try { localStorage.removeItem(k); } catch { /* no storage */ } } };
const LS_PANEL = "kc.plugins.panel";

let S: PluginState = {
  loaded: false, signedIn: false, error: null, installed: [], catalog: null, running: {}, logs: {},
  manager: { open: false, tab: "installed", selected: null },
  panel: (() => { try { const j = JSON.parse(ls.get(LS_PANEL) || "{}"); return { open: !!j.open, active: typeof j.active === "string" ? j.active : null, width: Math.min(640, Math.max(240, Number(j.width) || 320)) }; } catch { return { open: false, active: null, width: 320 }; } })(),
  prompt: null, consent: null, editor: null,
};
const subs = new Set<() => void>();
function set(patch: Partial<PluginState>) { S = Object.assign({}, S, patch); for (const fn of Array.from(subs)) fn(); }
export const pluginStore = { get: () => S, subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; } };
export function usePlugins<T>(sel: (s: PluginState) => T): T { return useSyncExternalStore(pluginStore.subscribe, () => sel(S), () => sel(S)); }

const find = (id: string) => S.installed.find((p) => p.identifier === id) || null;
const has = (p: InstalledPlugin, perm: string) => p.granted.includes(perm);
function setRun(id: string, patch: Partial<RunState> | null) {
  const running = Object.assign({}, S.running);
  if (patch === null) delete running[id]; else running[id] = Object.assign({ ready: false, failed: false, busy: null, registered: {} }, running[id], patch);
  set({ running });
}
function log(id: string, level: LogLine["level"], text: string) {
  const lines = (S.logs[id] || []).concat({ at: Date.now(), level, text: String(text).slice(0, 4000) });
  set({ logs: Object.assign({}, S.logs, { [id]: lines.slice(-300) }) });
}
export const clearLog = (id: string) => set({ logs: Object.assign({}, S.logs, { [id]: [] }) });
const toast = (text: string, ms?: number) => { try { ED().api.toolCtx().toast(text, ms); } catch { /* no editor yet */ } };

// ---------------------------------------------------------------- server

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, init));
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.error)) || `the server answered ${r.status}`);
  return j;
}

export async function refresh(): Promise<void> {
  const me = APP() ? APP().getState().me : null;
  if (!me) { set({ loaded: true, signedIn: false, installed: [], error: null }); syncRunning(); return; }
  try { const j = await api("/api/plugins"); set({ loaded: true, signedIn: true, installed: j.plugins || [], error: null }); }
  catch (e) { set({ loaded: true, signedIn: true, error: e instanceof Error ? e.message : String(e) }); }
  syncRunning();
}
export async function loadCatalog(): Promise<void> {
  try { const j = await api("/api/plugins/catalog"); set({ catalog: j.plugins || [] }); } catch (e) { set({ catalog: [], error: e instanceof Error ? e.message : String(e) }); }
}

/** Ask the person before anything is stored: what the plugin is and every permission it wants. */
export function requestInstall(manifest: PluginManifest, files: Record<string, string>, source: string): string | null {
  const bad = validateManifest(manifest).concat(validateManifest(manifest).length ? [] : validateFiles(manifest, files));
  if (bad.length) return bad.join("; ");
  const prev = find(manifest.identifier); const wants = manifest.permissions || [];
  set({ consent: { manifest, files, source, update: !!prev, added: prev ? wants.filter((p) => !prev.granted.includes(p)) : wants } });
  return null;
}
export const cancelInstall = () => set({ consent: null });
export async function confirmInstall(): Promise<string | null> {
  const c = S.consent; if (!c) return null;
  const keep: Record<string, string> = {}; for (const f of manifestFiles(c.manifest)) keep[f] = c.files[f];
  try {
    await api(`/api/plugins/${encodeURIComponent(c.manifest.identifier)}`, { method: "PUT", body: JSON.stringify({ manifest: c.manifest, files: keep, granted: c.manifest.permissions || [], source: c.source }) });
  } catch (e) { return e instanceof Error ? e.message : String(e); }
  stop(c.manifest.identifier);
  set({ consent: null, manager: Object.assign({}, S.manager, { tab: "installed", selected: c.manifest.identifier }) });
  await refresh(); return null;
}
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  set({ installed: S.installed.map((p) => (p.identifier === id ? Object.assign({}, p, { enabled }) : p)) }); syncRunning();   // at once; the refresh below confirms it
  try { await api(`/api/plugins/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ enabled }) }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  await refresh();
}
export async function uninstall(id: string): Promise<void> {
  try { await api(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  stop(id); storageClear(id);
  const logs = Object.assign({}, S.logs); delete logs[id];
  set({ logs, manager: Object.assign({}, S.manager, { selected: S.manager.selected === id ? null : S.manager.selected }) });
  await refresh();
}

const rawUrl = (u: string) => { const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/(.+)$/); return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u; };
/** Fetch a plugin from the address of its plugin.json (or of the folder that holds it).  The browser fetches it; the server never does. */
export async function fetchFromUrl(input: string): Promise<{ manifest: PluginManifest; files: Record<string, string>; source: string }> {
  let url = rawUrl(input.trim()); if (!/^https:\/\//.test(url)) throw new Error("Give an https:// address.");
  if (!/\.json(\?.*)?$/.test(url)) url = url.replace(/\/?$/, "/plugin.json");
  const get = async (u: string) => { let r: Response; try { r = await fetch(u, { credentials: "omit", referrerPolicy: "no-referrer" }); } catch { throw new Error(`Could not fetch ${u} (the site may not allow other sites to read it).`); } if (!r.ok) throw new Error(`${u} answered ${r.status}.`); const t = await r.text(); if (t.length > 2 * 1024 * 1024) throw new Error(`${u} is too large.`); return t; };
  let manifest: PluginManifest; try { manifest = JSON.parse(await get(url)); } catch (e) { throw new Error(e instanceof SyntaxError ? "plugin.json is not valid JSON." : (e as Error).message); }
  const bad = validateManifest(manifest); if (bad.length) throw new Error(bad.join("; "));
  const base = url.replace(/[^/]*(\?.*)?$/, ""); const files: Record<string, string> = {};
  for (const f of manifestFiles(manifest)) files[f] = await get(base + f);
  return { manifest, files, source: url };
}
/** Read a plugin out of files the person picked (a folder, or plugin.json with its neighbours). */
export async function readLocalFiles(list: File[]): Promise<{ manifest: PluginManifest; files: Record<string, string>; source: string }> {
  const named = list.map((f) => ({ f, path: ((f as any).webkitRelativePath || f.name) as string }));
  const mf = named.filter((x) => /(^|\/)plugin\.json$/.test(x.path)).sort((a, b) => a.path.length - b.path.length)[0];
  if (!mf) throw new Error("No plugin.json among those files.");
  const root = mf.path.slice(0, mf.path.length - "plugin.json".length);
  let manifest: PluginManifest; try { manifest = JSON.parse(await mf.f.text()); } catch { throw new Error("plugin.json is not valid JSON."); }
  const bad = validateManifest(manifest); if (bad.length) throw new Error(bad.join("; "));
  const files: Record<string, string> = {};
  for (const want of manifestFiles(manifest)) { const hit = named.find((x) => x.path === root + want); if (!hit) throw new Error(`${want} is named in plugin.json but was not among the files.`); files[want] = await hit.f.text(); }
  return { manifest, files, source: "local" };
}

// ---------------------------------------------------------------- running

interface Run { plugin: InstalledPlugin; key: string; sandbox: Sandbox; pending: Map<number, { ok: (v: any) => void; no: (e: Error) => void; timer: number }>; seq: number; commits: number[] }
const runs = new Map<string, Run>();
let frameHost: HTMLElement | null = null;
const keyOf = (p: InstalledPlugin) => `${p.updatedAt || ""}|${p.granted.join(",")}`;

const THEME_VARS = ["--bench", "--paper", "--panel", "--panel-2", "--line", "--line-2", "--ink", "--ink-2", "--ink-3", "--blue", "--copper", "--copper-2", "--teal", "--wire", "--warn", "--err", "--font", "--mono"];
function themeNow() {
  const cs = getComputedStyle(document.documentElement); const vars: Record<string, string> = {};
  for (const v of THEME_VARS) { const val = cs.getPropertyValue(v).trim(); if (val) vars[v] = val; }
  const dt = document.documentElement.dataset.theme;
  return { dark: dt === "dark" || (dt !== "light" && matchMedia("(prefers-color-scheme: dark)").matches), vars };
}

/** The dock gives the host the element the frames live in; they stay mounted there, shown or not. */
export function setFrameHost(el: HTMLElement | null) { frameHost = el; if (el) syncRunning(); }

function wanted(): InstalledPlugin[] {
  const app = APP(); const st = app ? app.getState() : null;
  if (!frameHost || !st || st.view !== "editor" || !st.project || !st.me) return [];
  return S.installed.filter((p) => p.enabled);
}
function syncRunning() {
  const want = new Map(wanted().map((p) => [p.identifier, p]));
  for (const [id, run] of Array.from(runs)) { const p = want.get(id); if (!p || keyOf(p) !== run.key) stop(id); }
  for (const p of want.values()) if (!runs.has(p.identifier)) start(p);
  showFrames();
}
function start(p: InstalledPlugin) {
  if (!frameHost) return;
  const m = p.manifest; const entryName = m.runtime.entrypoint || "main.js";
  const resources: Record<string, string> = {}; for (const r of m.resources || []) if (typeof p.files[r] === "string") resources[r] = p.files[r];
  const run: Run = { plugin: p, key: keyOf(p), sandbox: null as unknown as Sandbox, pending: new Map(), seq: 0, commits: [] };
  runs.set(p.identifier, run); setRun(p.identifier, { ready: false, failed: false, busy: null, registered: {} });
  log(p.identifier, "host", `Starting ${m.name} ${m.version || ""}`.trim());
  run.sandbox = createSandbox(p, frameHost, {
    plugin: { identifier: p.identifier, name: m.name, version: m.version || "" }, granted: p.granted.slice(), theme: themeNow(),
    entry: p.files[entryName] || "", entryName, html: m.panel && m.panel.html ? p.files[m.panel.html] || "" : "", resources,
    editor: editorState(has(p, "design:read")),
  }, (msg) => onMessage(run, msg));
}
export function stop(id: string) {
  const run = runs.get(id); if (!run) return;
  for (const w of run.pending.values()) { clearTimeout(w.timer); w.no(new Error("the plugin was stopped")); }
  run.sandbox.destroy(); runs.delete(id); setRun(id, null);
  if (S.prompt && S.prompt.plugin === id) { S.prompt.resolve(null); set({ prompt: null }); }
  log(id, "host", "Stopped");
}
export function restart(id: string) { stop(id); syncRunning(); }

function onMessage(run: Run, m: any) {
  const id = run.plugin.identifier; if (!m || typeof m !== "object" || runs.get(id) !== run) return;
  switch (m.t) {
    case "ready": setRun(id, { ready: true, failed: !!m.failed }); if (!m.failed) log(id, "host", "Ready"); break;
    case "log": log(id, m.level === "error" ? "error" : m.level === "warn" ? "warn" : "log", String(m.text || "")); break;
    case "registered": {
      if (typeof m.kind !== "string" || typeof m.name !== "string" || !["action", "importer", "exporter", "tool"].includes(m.kind)) break;
      const reg = Object.assign({}, (S.running[id] || { registered: {} }).registered); reg[m.kind] = Array.from(new Set((reg[m.kind] || []).concat(m.name.slice(0, 80)))); setRun(id, { registered: reg }); break;
    }
    case "done": { const w = run.pending.get(m.id); if (!w) break; run.pending.delete(m.id); clearTimeout(w.timer); if (m.error) w.no(new Error(String(m.error).slice(0, 2000))); else w.ok(m.value); break; }
    case "call": {
      if (typeof m.id !== "number" || typeof m.method !== "string") break;
      handleCall(run, m.method, m.args && typeof m.args === "object" ? m.args : {}).then(
        (value) => run.sandbox.send({ t: "result", id: m.id, value: value === undefined ? null : value }),
        (e) => { const msg = e instanceof Error ? e.message : String(e); if (!(e instanceof ApiError)) console.warn("plugin host:", m.method, e); log(id, "warn", `${m.method}: ${msg}`); run.sandbox.send({ t: "result", id: m.id, error: msg, code: e instanceof ApiError ? e.code : "error" }); });
      break;
    }
    default: break;
  }
}

/** Ask the plugin to run something it registered.  `timeout` 0 waits for as long as the plugin runs. */
function invoke(run: Run, kind: string, name: string, arg: unknown, timeout: number): Promise<any> {
  return new Promise((ok, no) => {
    const id = ++run.seq;
    const timer = timeout ? window.setTimeout(() => { run.pending.delete(id); no(new Error(`${run.plugin.manifest.name} did not answer within ${Math.round(timeout / 1000)} seconds`)); }, timeout) : 0;
    run.pending.set(id, { ok, no, timer });
    run.sandbox.send({ t: "invoke", id, kind, name, arg });
  });
}
function emit(name: string, data: unknown, need?: string) { for (const run of runs.values()) if (!need || has(run.plugin, need)) run.sandbox.send({ t: "event", name, data }); }

/** Wait for a just-started plugin to finish loading (its handlers are registered as its script runs). */
async function whenReady(id: string): Promise<Run> {
  for (let i = 0; i < 100; i++) { const run = runs.get(id); const st = S.running[id]; if (!run) break; if (st && st.ready) { if (st.failed) throw new Error("the plugin failed to load; see its log"); return run; } await new Promise((r) => setTimeout(r, 50)); }
  const p = find(id);
  throw new Error(!p ? "that plugin is not installed" : !p.enabled ? `${p.manifest.name} is disabled` : `${p.manifest.name} is not running`);
}

// ---------------------------------------------------------------- the API gate

/** The permission each method needs; null means any running plugin may call it. */
const NEEDS: Record<string, string | null> = {
  "design.overview": "design:read", "design.documents": "design:read", "design.components": "design:read", "design.component": "design:read", "design.nets": "design:read",
  "design.items": "design:read", "design.selection": "design:read", "design.runChecks": "design:read", "design.boardInfo": "design:read",
  "design.apply": "design:write", "design.commit": "design:write",
  "view.select": "view", "view.highlight": "view", "view.focus": "view", "view.setMarkers": "view", "view.clearMarkers": "view", "view.openDocument": "view",
  "files.save": "files:export", "files.pick": "files:import",
  "ui.toast": null, "ui.status": null, "ui.prompt": null, "ui.confirm": null, "ui.showPanel": null, "ui.hidePanel": null,
  "storage.get": null, "storage.set": null, "storage.remove": null, "storage.keys": null,
};

async function handleCall(run: Run, method: string, a: any): Promise<unknown> {
  const p = run.plugin; const name = p.manifest.name;
  if (!(method in NEEDS)) throw new ApiError(`there is no kicad.${method}`, "unknown_method");
  const need = NEEDS[method];
  if (need && !has(p, need)) throw new ApiError(`${name} does not have the "${need}" permission, which kicad.${method} needs. Add it to "permissions" in plugin.json; the person is asked when the plugin is installed.`, "permission_denied");
  const [ns, fn] = method.split(".");
  if (ns === "design") {
    if (reads[fn]) return reads[fn](a);
    // A plugin that writes in a loop (an edit event answered with an edit) is stopped here rather than flooding the session.
    const now = Date.now(); run.commits = run.commits.filter((t) => now - t < 10000);
    if (run.commits.length >= 30) throw new ApiError("That is too many changes in a few seconds; this one was not applied.", "rate_limited");
    run.commits.push(now);
    const label = `${name}: ${String(a.label || a.title || "edit").slice(0, 80)}`;
    const out = await writes[fn](a, label);
    log(p.identifier, "host", `Changed the design — ${label}`);
    toast(`${label} — Undo reverts it`, 3200);
    return out;
  }
  if (ns === "view") return views[fn](a);
  if (ns === "storage") return storage(p.identifier, fn, a);
  if (ns === "files") return fn === "save" ? saveFile(p, a) : pickFile(p, a);
  switch (fn) {
    case "toast": toast(`${name}: ${String(a.text || "").slice(0, 300)}`, 3000); return null;
    case "status": try { APP() && ED().api.toolCtx().setStatus(a.text ? `${name}: ${String(a.text).slice(0, 120)}` : ""); } catch { /* no editor */ } return null;
    case "showPanel": if (!p.manifest.panel) throw new ApiError(`${name} declares no panel in plugin.json`, "invalid"); showPanel(p.identifier); return null;
    case "hidePanel": if (S.panel.active === p.identifier) setPanel({ open: false }); return null;
    case "confirm": return ask(p, { kind: "confirm", title: String(a.title || name).slice(0, 120), message: String(a.message || "").slice(0, 2000), fields: [], okLabel: a.okLabel ? String(a.okLabel).slice(0, 40) : undefined }).then((v) => !!v);
    case "prompt": return ask(p, { kind: "form", title: String(a.title || name).slice(0, 120), message: a.message ? String(a.message).slice(0, 2000) : undefined, fields: cleanFields(a.fields).filter((f) => f.type !== "file" || has(p, "files:import")), okLabel: a.okLabel ? String(a.okLabel).slice(0, 40) : undefined });
    default: return null;
  }
}

// ---------------------------------------------------------------- dialogs the host draws for a plugin

let promptSeq = 0;
function cleanFields(v: unknown): PromptField[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 30).filter((f) => f && typeof f === "object" && typeof (f as any).name === "string").map((f: any) => ({
    name: String(f.name).slice(0, 60), label: String(f.label || f.name).slice(0, 120), type: ["text", "number", "select", "checkbox", "textarea", "file"].includes(f.type) ? f.type : "text",
    default: f.default, options: Array.isArray(f.options) ? f.options.slice(0, 200) : undefined, accept: Array.isArray(f.accept) ? f.accept.filter((x: unknown) => typeof x === "string").slice(0, 20) : undefined,
    as: f.as === "bytes" ? "bytes" : "text", placeholder: typeof f.placeholder === "string" ? f.placeholder.slice(0, 120) : undefined,
    min: typeof f.min === "number" ? f.min : undefined, max: typeof f.max === "number" ? f.max : undefined, step: typeof f.step === "number" ? f.step : undefined }));
}
/** One dialog at a time, always titled with the plugin's name so it cannot pass for the editor's own. */
function ask(p: InstalledPlugin, req: Omit<PromptRequest, "id" | "plugin" | "pluginName" | "resolve">): Promise<any> {
  if (S.prompt) return Promise.reject(new ApiError("Another plugin dialog is already open.", "busy"));
  return new Promise((resolve) => set({ prompt: Object.assign({ id: ++promptSeq, plugin: p.identifier, pluginName: p.manifest.name, resolve }, req) }));
}
export function answerPrompt(value: any) { const pr = S.prompt; if (!pr) return; set({ prompt: null }); pr.resolve(value); }

function saveFile(p: InstalledPlugin, a: any): unknown {
  const name = String(a.filename || "export.txt").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "export.txt";
  let part: BlobPart;
  if (typeof a.text === "string") part = a.text;
  else if (a.bytes instanceof ArrayBuffer || ArrayBuffer.isView(a.bytes)) part = a.bytes as BlobPart;
  else throw new ApiError("files.save needs text or bytes.", "invalid");
  const blob = new Blob([part], { type: typeof a.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : "application/octet-stream" });
  if (blob.size > 64 * 1024 * 1024) throw new ApiError("That file is larger than 64 MB.", "too_large");
  const el = document.createElement("a"); el.href = URL.createObjectURL(blob); el.download = name; document.body.appendChild(el); el.click();
  setTimeout(() => { URL.revokeObjectURL(el.href); el.remove(); }, 1500);
  log(p.identifier, "host", `Saved ${name} (${blob.size} bytes)`); toast(`${p.manifest.name} saved ${name}`);
  return { filename: name, bytes: blob.size };
}
async function pickFile(p: InstalledPlugin, a: any): Promise<unknown> {
  const out = await ask(p, { kind: "form", title: String(a.title || "Choose a file").slice(0, 120), message: a.message ? String(a.message).slice(0, 600) : undefined,
    fields: cleanFields([{ name: "file", label: "File", type: "file", accept: a.accept, as: a.as }]), okLabel: "Open" });
  return out && out.file ? out.file : null;
}

function storage(id: string, fn: string, a: any): unknown {
  const me = APP() ? APP().getState().me : null; const key = `kc.plugin.${me ? me.id : 0}.${id}`;
  let data: Record<string, unknown> = {}; try { data = JSON.parse(ls.get(key) || "{}") || {}; } catch { data = {}; }
  const k = String(a.key === undefined ? "" : a.key).slice(0, 200);
  if (fn === "keys") return Object.keys(data);
  if (fn === "get") return k in data ? data[k] : null;
  if (fn === "remove") delete data[k]; else data[k] = a.value === undefined ? null : a.value;
  const text = JSON.stringify(data);
  if (text.length > 512 * 1024) throw new ApiError("A plugin's storage holds 512 KB at most.", "too_large");
  ls.set(key, text); return null;
}
function storageClear(id: string) { const me = APP() ? APP().getState().me : null; ls.del(`kc.plugin.${me ? me.id : 0}.${id}`); }

// ---------------------------------------------------------------- what plugins contribute to the chrome

export interface Contribution { plugin: string; pluginName: string; id: string; uiId: string; name: string; description: string }
export interface ActionContribution extends Contribution { action: PluginAction }
export const uiIdOf = (kind: "plugin" | "plugin-import" | "plugin-export", plugin: string, id: string) => `${kind}:${plugin}:${id}`;

export function actionsFor(s: PluginState, editor: string | null): ActionContribution[] {
  const out: ActionContribution[] = [];
  for (const p of s.installed) if (p.enabled) for (const a of p.manifest.actions || []) if (inScope(a.scopes, editor)) out.push({ plugin: p.identifier, pluginName: p.manifest.name, id: a.identifier, uiId: uiIdOf("plugin", p.identifier, a.identifier), name: a.name, description: a.description || "", action: a });
  return out;
}
function porters(s: PluginState, editor: string | null, key: "importers" | "exporters"): Contribution[] {
  const out: Contribution[] = [];
  for (const p of s.installed) if (p.enabled) for (const a of (p.manifest[key] || []) as PluginPorter[]) if (inScope(a.scopes, editor)) out.push({ plugin: p.identifier, pluginName: p.manifest.name, id: a.identifier, uiId: uiIdOf(key === "importers" ? "plugin-import" : "plugin-export", p.identifier, a.identifier), name: a.name, description: a.description || "" });
  return out;
}
export const importersFor = (s: PluginState, editor: string | null) => porters(s, editor, "importers");
export const exportersFor = (s: PluginState, editor: string | null) => porters(s, editor, "exporters");
export function panelsFor(s: PluginState, editor: string | null): { plugin: string; name: string }[] {
  return s.installed.filter((p) => p.enabled && p.manifest.panel && inScope(p.manifest.panel.scopes, editor)).map((p) => ({ plugin: p.identifier, name: p.manifest.panel!.name }));
}

export const isPluginUiId = (id: string) => id === "pluginManager" || id === "pluginPanels" || /^plugin(-import|-export)?:/.test(id);
/** The label of a menu entry of ours, or null when the id is not one (or its plugin is gone). */
export function pluginUiLabel(id: string): string | null {
  if (id === "pluginManager") return "Manage Plugins…";
  if (id === "pluginPanels") return "Plugin Panels";
  const m = id.match(/^(plugin|plugin-import|plugin-export):([^:]+):(.+)$/); if (!m) return null;
  const p = find(m[2]); if (!p) return null;
  const list: Array<{ identifier: string; name: string }> = (m[1] === "plugin" ? p.manifest.actions : m[1] === "plugin-import" ? p.manifest.importers : p.manifest.exporters) || [];
  const hit = list.find((x) => x.identifier === m[3]); return hit ? hit.name : null;
}
export function pluginUiKey(id: string): string {
  const m = id.match(/^plugin:([^:]+):(.+)$/); if (!m) return "";
  const a = (find(m[1])?.manifest.actions || []).find((x) => x.identifier === m[2]); return (a && a.key) || "";
}

async function busy<T>(id: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  setRun(id, { busy: what });
  try { return await fn(); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); log(id, "error", `${what}: ${msg}`); toast(`${find(id)?.manifest.name || "Plugin"}: ${msg}`, 5000); return undefined; }
  finally { if (S.running[id]) setRun(id, { busy: null }); }
}

export async function runAction(plugin: string, action: string): Promise<void> {
  const p = find(plugin); const a = p && (p.manifest.actions || []).find((x) => x.identifier === action); if (!p || !a) return;
  await busy(plugin, a.name, async () => { const run = await whenReady(plugin); await invoke(run, "action", action, { editor: editorState(has(p, "design:read")) }, 0); });
}
export async function runExporter(plugin: string, id: string): Promise<void> {
  const p = find(plugin); const x = p && (p.manifest.exporters || []).find((e) => e.identifier === id); if (!p || !x) return;
  await busy(plugin, x.name, async () => {
    const run = await whenReady(plugin); const out = await invoke(run, "exporter", id, {}, 0);
    if (out && typeof out === "object" && (typeof out.text === "string" || out.bytes)) saveFile(p, out);   // an exporter may also save by itself and return nothing
  });
}
/** Importers start from a click, so the file dialog opens straight away; the plugin is handed what was picked. */
export function runImporter(plugin: string, id: string): void {
  const p = find(plugin); const x = p && (p.manifest.importers || []).find((e) => e.identifier === id); if (!p || !x) return;
  const input = document.createElement("input"); input.type = "file"; if (x.extensions && x.extensions.length) input.accept = x.extensions.join(",");
  input.onchange = () => {
    const f = input.files && input.files[0]; if (!f) return;
    if (f.size > 64 * 1024 * 1024) { toast("That file is larger than 64 MB."); return; }
    void busy(plugin, x.name, async () => { const run = await whenReady(plugin); const bytes = await f.arrayBuffer(); let text = ""; try { text = new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { text = ""; } await invoke(run, "importer", id, { name: f.name, size: f.size, text, bytes }, 0); });
  };
  input.click();
}
/** A click on one of our menu or toolbar entries. */
export function runPluginUi(id: string): void {
  if (id === "pluginManager") { openManager(); return; }
  if (id === "pluginPanels") { setPanel({ open: !S.panel.open }); return; }
  const m = id.match(/^(plugin|plugin-import|plugin-export):([^:]+):(.+)$/); if (!m) return;
  if (m[1] === "plugin") void runAction(m[2], m[3]); else if (m[1] === "plugin-export") void runExporter(m[2], m[3]); else runImporter(m[2], m[3]);
}

// ---------------------------------------------------------------- panels and the manager

function setPanel(patch: Partial<PluginState["panel"]>) {
  const panel = Object.assign({}, S.panel, patch); ls.set(LS_PANEL, JSON.stringify(panel)); set({ panel }); showFrames();
}
export function showPanel(id: string) { setPanel({ open: true, active: id }); }
export const closePanels = () => setPanel({ open: false });
export const setPanelWidth = (w: number) => setPanel({ width: Math.min(640, Math.max(240, Math.round(w))) });
/** Only the active panel's frame is visible; every other plugin keeps running out of sight. */
function showFrames() {
  const editor = S.editor; const open = S.panel.open ? panelsFor(S, editor) : [];
  const active = open.find((p) => p.plugin === S.panel.active) || open[0] || null;
  for (const [id, run] of runs) run.sandbox.frame.hidden = !active || active.plugin !== id;
}
export function openManager(tab?: PluginState["manager"]["tab"]) {
  set({ manager: Object.assign({}, S.manager, { open: true, tab: tab || S.manager.tab }) });
  void refresh(); if (!S.catalog) void loadCatalog();
}
export const closeManager = () => set({ manager: Object.assign({}, S.manager, { open: false }), consent: null });
export const setManager = (patch: Partial<PluginState["manager"]>) => set({ manager: Object.assign({}, S.manager, patch) });

// ---------------------------------------------------------------- the assistant's bridge

/** The tools enabled plugins offer the assistant: declared in the manifest (so the person consented to them) and registered by the running plugin. */
export function assistantTools(): Array<{ plugin: string; plugin_name: string; tool: string; description: string; input_schema: unknown }> {
  const out = [];
  for (const p of S.installed) {
    if (!p.enabled || !has(p, "assistant") || !runs.has(p.identifier)) continue;
    for (const t of p.manifest.assistant_tools || []) out.push({ plugin: p.identifier, plugin_name: p.manifest.name, tool: t.name, description: t.description, input_schema: t.input_schema || { type: "object" } });
  }
  return out;
}
export async function callAssistantTool(plugin: string, tool: string, input: unknown): Promise<unknown> {
  const p = find(plugin);
  if (!p || !p.enabled || !has(p, "assistant") || !(p.manifest.assistant_tools || []).some((t) => t.name === tool)) throw new Error(`No enabled plugin offers the tool ${plugin} / ${tool}. Call list_plugin_tools to see what is available.`);
  const run = await whenReady(plugin);
  log(plugin, "host", `The assistant called ${tool}`);
  return invoke(run, "tool", tool, input === undefined ? {} : input, 30000);
}

// ---------------------------------------------------------------- wiring

const KEY_NAMES: Record<string, string> = { Del: "Delete", Esc: "Escape", Space: " ", Ins: "Insert", PgUp: "PageUp", PgDn: "PageDown", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };
function hotkeyMatches(ev: KeyboardEvent, key: string): boolean {
  const parts = key.split("+"); const k = parts.pop() || "";
  if (parts.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey) || parts.includes("Shift") !== ev.shiftKey || parts.includes("Alt") !== ev.altKey) return false;
  const want = KEY_NAMES[k] || k; return want.length === 1 ? ev.key.toUpperCase() === want.toUpperCase() : ev.key === want;
}

let wired = false;
/** Called once the chrome is mounted: follow the editor's state and keep the running plugins in step with it. */
export function initPlugins(): void {
  if (wired) return; wired = true;
  const app = APP(); if (!app) return;
  let last: any = {}; let changeTimer = 0;
  const onState = (st: any) => {
    const now = { me: st.me ? st.me.id : null, view: st.view, project: st.project ? st.project.projectId : null, editor: st.document.editor, docId: st.document.docId, sel: st.selection.version, ver: st.document.version, viewOnly: st.viewOnly, selIds: st.selection.ids };
    const was = last; last = now;
    if (now.me !== was.me) void refresh();
    if (now.editor !== was.editor) { set({ editor: now.editor }); showFrames(); }
    if (now.view !== was.view || now.project !== was.project) syncRunning();
    if (!runs.size) return;
    if (now.docId !== was.docId || now.editor !== was.editor || now.viewOnly !== was.viewOnly) {
      for (const run of runs.values()) run.sandbox.send({ t: "event", name: "editor", data: editorState(has(run.plugin, "design:read")) });
      if (now.docId !== was.docId) emit("document", editorState(true).document, "design:read");
    }
    if (now.sel !== was.sel || now.selIds !== was.selIds) emit("selection", selectionSummary(), "design:read");
    if (now.ver !== was.ver && now.docId === was.docId) { clearTimeout(changeTimer); changeTimer = window.setTimeout(() => emit("change", { version: now.ver }, "design:read"), 250); }
  };
  app.subscribe(onState); onState(app.getState());

  const themed = () => emit("theme", themeNow());
  new MutationObserver(themed).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themed);

  document.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!S.editor || S.manager.open || S.prompt || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) || (W.KDialogs && W.KDialogs.isOpen && W.KDialogs.isOpen())) return;
    for (const a of actionsFor(S, S.editor)) if (a.action.key && hotkeyMatches(ev, a.action.key)) { ev.preventDefault(); ev.stopPropagation(); void runAction(a.plugin, a.id); return; }
  }, true);

  // The assistant (web/ai/client.ts) reaches plugin tools through this object; tests use it too.
  W.KcPlugins = { store: pluginStore, tools: assistantTools, callTool: callAssistantTool, openManager, runUi: runPluginUi, refresh };
}
