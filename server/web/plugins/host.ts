// host.ts — the plugin host: which plugins are installed, which are running, and the one place
// where a plugin's request is weighed against what the person granted it.
//
// Plugins belong to a person, not to a project: installing one never runs code in a
// collaborator's browser.  A plugin runs only for the person who installed and enabled it, with
// that person's access — a viewer's plugins cannot write — and what it changes reaches everyone
// else as that person's ordinary edits.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useSyncExternalStore } from "react";
import { ApiError, copyBuffer, editorState, projectDocByPath, fab, history, libs, project, reads, selectionSummary, views, writes } from "./api";
import { pythonRuntime } from "./pyruntime";
import { createSandbox, type Sandbox } from "./sandbox";
import { inScope, isPython, manifestFiles, validateFiles, validateManifest, type InstalledPlugin, type PluginAction, type PluginManifest, type PluginPorter } from "./types";

const W = window as any;
const ED = (): any => W.CollabEditor;
const APP = (): any => W.CollabApp;

// ---------------------------------------------------------------- state

export interface LogLine { at: number; level: "log" | "warn" | "error" | "host"; text: string }
export interface RunState { ready: boolean; failed: boolean; busy: string | null; registered: Record<string, string[]>; error?: string | null }
/** How one of KiCad's official plugins fared against the web runtime (scripts/plugins-python.mjs). */
export interface Compat { status: "works" | "partly" | "opens" | "limited" | "unsupported" | "untested"; note?: string }
/** A plugin in KiCad's own repository. */
export interface OfficialEntry { identifier: string; manifest: PluginManifest; details: string; size: number; compat: Compat | null; icon?: boolean | null }
/** A plugin window the editor floats around the plugin's frame (a wx dialog of a Python plugin). */
export interface PluginWindowState { plugin: string; pluginName: string; title: string; width: number; height: number; modal: boolean }
export interface PromptField { name: string; label: string; type?: "text" | "number" | "select" | "checkbox" | "textarea" | "file"; default?: unknown; options?: Array<string | { value: string; label: string }>; accept?: string[]; as?: "text" | "bytes"; placeholder?: string; min?: number; max?: number; step?: number }
export interface PromptRequest { id: number; plugin: string; pluginName: string; kind: "form" | "confirm"; title: string; message?: string; fields: PromptField[]; okLabel?: string; resolve: (v: any) => void }
export interface Consent { manifest: PluginManifest; files: Record<string, string>; source: string; update: boolean; added: string[] }
export interface CatalogEntry { manifest: PluginManifest; files: Record<string, string> }
/** A plugin someone published to the community registry (no files: they are fetched when the person asks to install). */
export interface RegistryEntry { identifier: string; manifest: PluginManifest; publisher: string; installs: number; publishedAt?: string; updatedAt?: string }
/** What the registry says about one identifier. */
export interface PublishedInfo { publisher: string; version: string; status: "listed" | "hidden" | "removed"; reason: string | null }
/** A published plugin an administrator has to look at: reported, hidden or removed. */
export interface ModerationEntry { identifier: string; manifest: PluginManifest; publisher: string; status: "listed" | "hidden" | "removed"; reason: string | null; installs: number; reports: Array<{ reporter: string; reason: string; at: string }> }
/** A plugin the open project suggests to the people who work on it. */
export interface ProjectPlugin { identifier: string; origin: "catalog" | "registry"; addedBy: string | null; publisher: string | null; manifest: PluginManifest; files: Record<string, string> }

export interface PluginState {
  loaded: boolean; signedIn: boolean; error: string | null;
  installed: InstalledPlugin[]; catalog: CatalogEntry[] | null;
  running: Record<string, RunState>; logs: Record<string, LogLine[]>;
  /** The community registry as last searched; `published` is what is known about single identifiers (null: not published). */
  registry: RegistryEntry[] | null; registryQuery: string; published: Record<string, PublishedInfo | null>;
  /** Whether this person moderates the registry (KC_ADMINS on the server), and what is waiting for them. */
  admin: boolean; moderation: ModerationEntry[] | null;
  /** What the open project recommends, and whether this person may change that. */
  project: { id: string | null; plugins: ProjectPlugin[]; canEdit: boolean; dismissed: string };
  manager: { open: boolean; tab: "installed" | "catalog" | "project" | "develop" | "moderation"; selected: string | null };
  panel: { open: boolean; active: string | null; width: number };
  prompt: PromptRequest | null; consent: Consent | null;
  editor: string | null;
  /** KiCad's repository as last fetched, and why it could not be if it could not. */
  official: OfficialEntry[] | null; officialError: string | null;
  /** The actions each Python plugin registered when it last ran (a Python plugin names its actions at run time, not in a manifest). */
  pyActions: Record<string, PluginAction[]>;
  window: PluginWindowState | null;
}

const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* no storage */ } }, del(k: string) { try { localStorage.removeItem(k); } catch { /* no storage */ } } };
const LS_PANEL = "kc.plugins.panel";

let S: PluginState = {
  loaded: false, signedIn: false, error: null, installed: [], catalog: null, running: {}, logs: {},
  registry: null, registryQuery: "", published: {}, admin: false, moderation: null, project: { id: null, plugins: [], canEdit: false, dismissed: "" },
  manager: { open: false, tab: "installed", selected: null },
  panel: (() => { try { const j = JSON.parse(ls.get(LS_PANEL) || "{}"); return { open: !!j.open, active: typeof j.active === "string" ? j.active : null, width: Math.min(640, Math.max(240, Number(j.width) || 320)) }; } catch { return { open: false, active: null, width: 320 }; } })(),
  prompt: null, consent: null, editor: null, official: null, officialError: null, pyActions: {}, window: null,
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
  if (!me) { set({ loaded: true, signedIn: false, installed: [], admin: false, moderation: null, error: null }); syncRunning(); return; }
  try { const j = await api("/api/plugins"); set({ loaded: true, signedIn: true, installed: j.plugins || [], admin: !!j.admin, error: null }); loadPyActions(); }
  catch (e) { set({ loaded: true, signedIn: true, error: e instanceof Error ? e.message : String(e) }); }
  syncRunning();
}
export async function loadCatalog(): Promise<void> {
  try { const j = await api("/api/plugins/catalog"); set({ catalog: j.plugins || [] }); } catch (e) { set({ catalog: [], error: e instanceof Error ? e.message : String(e) }); }
}


// ---- the community registry

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
let registrySeq = 0;
export async function loadRegistry(q?: string): Promise<void> {
  const query = q === undefined ? S.registryQuery : q; const seq = ++registrySeq;
  if (q !== undefined) set({ registryQuery: q });
  try { const j = await api(`/api/plugins/registry?q=${encodeURIComponent(query)}`); if (seq === registrySeq) set({ registry: j.plugins || [] }); }
  catch (e) { if (seq === registrySeq) set({ registry: [], error: msg(e) }); }
}
/** Fetch a published plugin's files and put the consent sheet in front of the person. */
export async function installFromRegistry(identifier: string): Promise<string | null> {
  if (!S.signedIn) return "Sign in to install plugins.";
  try {
    const j = await api(`/api/plugins/registry/${encodeURIComponent(identifier)}`);
    if (j.status && j.status !== "listed") { void loadRegistry(); return "The administrators took this plugin out of the registry."; }
    return requestInstall(j.manifest, j.files, `registry:${j.publisher}`);
  }
  catch (e) { return msg(e); }
}
/** Learn whether an identifier is in the registry, and under whom (the installed plugin's detail asks). */
export async function lookupPublished(identifier: string): Promise<void> {
  let info: PublishedInfo | null = null;
  try { const r = await fetch(`/api/plugins/registry/${encodeURIComponent(identifier)}`); if (r.ok) { const j = await r.json(); info = { publisher: j.publisher, version: (j.manifest && j.manifest.version) || j.version || "", status: j.status || "listed", reason: j.reason || null }; } else if (r.status !== 404) return; }
  catch { return; }
  set({ published: Object.assign({}, S.published, { [identifier]: info }) });
}
/** Publish the installed copy for others to find.  It shares the copy; it installs nothing for anyone. */
export async function publish(identifier: string): Promise<string | null> {
  const p = find(identifier); if (!p) return "That plugin is not installed.";
  try { await api(`/api/plugins/registry/${encodeURIComponent(identifier)}`, { method: "PUT", body: JSON.stringify({ manifest: p.manifest, files: p.files }) }); }
  catch (e) { return msg(e); }
  await Promise.all([lookupPublished(identifier), S.registry ? loadRegistry() : Promise.resolve()]); return null;
}
export async function unpublish(identifier: string): Promise<string | null> {
  try { await api(`/api/plugins/registry/${encodeURIComponent(identifier)}`, { method: "DELETE" }); } catch (e) { return msg(e); }
  await Promise.all([lookupPublished(identifier), S.registry ? loadRegistry() : Promise.resolve(), loadProject()]); return null;
}

/** Tell the administrators something is wrong with a published plugin. */
export async function report(identifier: string, reason: string): Promise<string | null> {
  if (!S.signedIn) return "Sign in to report a plugin.";
  try { await api(`/api/plugins/registry/${encodeURIComponent(identifier)}/report`, { method: "POST", body: JSON.stringify({ reason }) }); } catch (e) { return msg(e); }
  if (S.admin) void loadModeration(); return null;
}
export async function loadModeration(): Promise<void> {
  if (!S.admin) { set({ moderation: null }); return; }
  try { const j = await api("/api/plugins/moderation"); set({ moderation: j.plugins || [] }); } catch (e) { set({ moderation: [], error: msg(e) }); }
}
/** An administrator's decision: hide, restore, remove, or dismiss the reports. */
export async function moderate(identifier: string, action: "hide" | "restore" | "remove" | "dismiss", reason: string): Promise<string | null> {
  try { await api(`/api/plugins/registry/${encodeURIComponent(identifier)}/moderate`, { method: "POST", body: JSON.stringify({ action, reason }) }); } catch (e) { return msg(e); }
  await Promise.all([loadModeration(), loadRegistry(), refresh(), loadProject()]); return null;
}

// ---- what the open project recommends

const LS_DISMISS = "kc.plugins.recommended.seen.";
const projectId = (): string | null => { const st = APP() ? APP().getState() : null; return st && st.me && st.project ? st.project.projectId : null; };
let projectSeq = 0;
export async function loadProject(): Promise<void> {
  const id = projectId(); const seq = ++projectSeq;
  if (!id) { set({ project: { id: null, plugins: [], canEdit: false, dismissed: "" } }); return; }
  try {
    const j = await api(`/api/projects/${encodeURIComponent(id)}/plugins`); if (seq !== projectSeq) return;
    set({ project: { id, plugins: j.plugins || [], canEdit: !!j.canEdit, dismissed: ls.get(LS_DISMISS + id) || "" } });
  } catch { if (seq === projectSeq) set({ project: { id, plugins: [], canEdit: false, dismissed: "" } }); }
}
/** The recommendations this person has not installed. */
export const missingRecommended = (s: PluginState): ProjectPlugin[] => s.project.plugins.filter((r) => !s.installed.some((p) => p.identifier === r.identifier));
const missingKey = (s: PluginState) => missingRecommended(s).map((r) => r.identifier).sort().join(",");
/** True while the project recommends something this person neither has nor has waved away. */
export const recommendedPending = (s: PluginState): boolean => { const k = missingKey(s); return !!k && k !== s.project.dismissed; };
/** Stop pointing at the current recommendations (a new one points again). */
export function dismissRecommended(): void {
  const id = S.project.id; if (!id) return; const k = missingKey(S);
  ls.set(LS_DISMISS + id, k); set({ project: Object.assign({}, S.project, { dismissed: k }) });
}
/** Where a plugin the person has can be got by anyone: the catalog, the registry, or nowhere (a private copy). */
export function originOf(p: InstalledPlugin, s: PluginState = S): "catalog" | "registry" | null {
  if (p.source === "catalog") return "catalog";
  const pub = s.published[p.identifier]; return pub && pub.status === "listed" ? "registry" : null;
}
export async function recommend(identifier: string, origin: "catalog" | "registry", on: boolean): Promise<string | null> {
  const id = projectId(); if (!id) return "Open a project first.";
  try { await api(`/api/projects/${encodeURIComponent(id)}/plugins/${encodeURIComponent(identifier)}`, on ? { method: "PUT", body: JSON.stringify({ origin }) } : { method: "DELETE" }); }
  catch (e) { return msg(e); }
  await loadProject(); return null;
}
export function installRecommended(r: ProjectPlugin): string | null {
  if (!S.signedIn) return "Sign in to install plugins.";
  return requestInstall(r.manifest, r.files, r.origin === "catalog" ? "catalog" : `registry:${r.publisher || "unknown"}`);
}

// ---- KiCad's own plugins

let officialBusy: Promise<void> | null = null; let iconRetries = 0;
/** KiCad's repository, as the server lists it.  The answer is waited for at most 45 seconds, so the catalog never
 *  sits on "Loading"; while the server is still fetching the icons the list is asked for again a little later. */
export function loadOfficial(force = false): Promise<void> {
  if (S.official && !S.officialError && !force) return Promise.resolve();
  if (officialBusy) return officialBusy;
  officialBusy = (async () => {
    const stop = new AbortController(); const timer = setTimeout(() => stop.abort(), 45000);
    try {
      const j = await api("/api/plugins/pcm", { signal: stop.signal }); set({ official: j.plugins || [], officialError: null });
      if (j.iconsPending && iconRetries < 6) { iconRetries++; setTimeout(() => void loadOfficial(true), 6000 * iconRetries); }
    } catch (e) { set({ official: S.official || [], officialError: stop.signal.aborted ? "it did not answer in time" : msg(e) }); }
    finally { clearTimeout(timer); officialBusy = null; }
  })();
  return officialBusy;
}
/** Download one of KiCad's plugins (the server fetches and unpacks it) and put it in front of the person on the consent sheet. */
export async function installOfficial(identifier: string): Promise<string | null> {
  if (!S.signedIn) return "Sign in to install plugins.";
  try { const j = await api(`/api/plugins/pcm/${encodeURIComponent(identifier)}`); return requestInstall(j.manifest, j.files || {}, String(j.source || "kicad")); }
  catch (e) { return msg(e); }
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
  const keep: Record<string, string> = {}; for (const f of manifestFiles(c.manifest, c.files)) keep[f] = c.files[f];
  try {
    await api(`/api/plugins/${encodeURIComponent(c.manifest.identifier)}`, { method: "PUT", body: JSON.stringify({ manifest: c.manifest, files: keep, granted: c.manifest.permissions || [], source: c.source }) });
  } catch (e) { return e instanceof Error ? e.message : String(e); }
  stop(c.manifest.identifier);
  set({ consent: null, manager: Object.assign({}, S.manager, { tab: "installed", selected: c.manifest.identifier }) });
  await refresh(); if (S.registry) void loadRegistry(); return null;
}
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  set({ installed: S.installed.map((p) => (p.identifier === id ? Object.assign({}, p, { enabled }) : p)) }); syncRunning();   // at once; the refresh below confirms it
  try { await api(`/api/plugins/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ enabled }) }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  await refresh();
}
export async function uninstall(id: string): Promise<void> {
  try { await api(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  stop(id); storageClear(id); forgetPyActions(id);
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

interface Run { plugin: InstalledPlugin; key: string; sandbox: Sandbox; pending: Map<number, { ok: (v: any) => void; no: (e: Error) => void; timer: number }>; seq: number; commits: number[]; actions?: PluginAction[] }
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

// ---- Python plugins: started when first needed, because each one carries an interpreter

const LS_PY = "kc.plugins.py.";
const pyActive = new Set<string>(), pyStarting = new Set<string>(), pyFailed = new Set<string>();
/** The actions a Python plugin registered the last time this copy of it ran, or null when it has not run yet. */
function cachedPyActions(p: InstalledPlugin): PluginAction[] | null {
  try { const j = JSON.parse(ls.get(LS_PY + p.identifier) || "null"); return j && j.key === keyOf(p) && Array.isArray(j.actions) ? j.actions : null; } catch { return null; }
}
function rememberPyActions(p: InstalledPlugin, actions: PluginAction[]) {
  ls.set(LS_PY + p.identifier, JSON.stringify({ key: keyOf(p), actions }));
  set({ pyActions: Object.assign({}, S.pyActions, { [p.identifier]: actions }) });
}
function forgetPyActions(id: string) { ls.del(LS_PY + id); pyActive.delete(id); pyFailed.delete(id); const next = Object.assign({}, S.pyActions); delete next[id]; set({ pyActions: next }); }
/** Bring what is remembered about the installed Python plugins into the state the menus read. */
function loadPyActions() {
  const next: Record<string, PluginAction[]> = {};
  for (const p of S.installed) if (isPython(p.manifest)) { const c = S.running[p.identifier] ? S.pyActions[p.identifier] : cachedPyActions(p); if (c) next[p.identifier] = c; }
  set({ pyActions: next });
}
/** The actions of a plugin: the manifest's, or for a Python plugin the ones it registered. */
export const actionsOf = (p: InstalledPlugin, s: PluginState = S): PluginAction[] => (isPython(p.manifest) ? s.pyActions[p.identifier] || [] : p.manifest.actions || []);

function wanted(): InstalledPlugin[] {
  const app = APP(); const st = app ? app.getState() : null;
  if (!frameHost || !st || st.view !== "editor" || !st.project || !st.me) return [];
  // A Python plugin whose actions are known waits for the first click on one of them; one that has never run starts once, to find out what it offers.
  return S.installed.filter((p) => p.enabled && (!isPython(p.manifest) || (!pyFailed.has(p.identifier) && (pyActive.has(p.identifier) || !S.pyActions[p.identifier]))));
}
function syncRunning() {
  const want = new Map(wanted().map((p) => [p.identifier, p]));
  for (const [id, run] of Array.from(runs)) { const p = want.get(id); if (!p || keyOf(p) !== run.key) stop(id); }
  for (const p of want.values()) if (!runs.has(p.identifier)) start(p);
  showFrames();
}
async function startPython(p: InstalledPlugin) {
  const id = p.identifier; if (pyStarting.has(id)) return; pyStarting.add(id);
  setRun(id, { ready: false, failed: false, busy: null, registered: {}, error: null });
  log(id, "host", `Starting ${p.manifest.name} ${p.manifest.version || ""} (Python)`.trim());
  let files: Record<string, string>;
  try { files = (await api(`/api/plugins/${encodeURIComponent(id)}/files`)).files || {}; }
  catch (e) { pyStarting.delete(id); pyFailed.add(id); log(id, "error", `Its files could not be fetched: ${e instanceof Error ? e.message : String(e)}`); setRun(id, { ready: true, failed: true }); return; }
  pyStarting.delete(id);
  if (!frameHost || runs.has(id) || !wanted().some((w) => w.identifier === id && keyOf(w) === keyOf(p))) { setRun(id, null); return; }
  const run: Run = { plugin: p, key: keyOf(p), sandbox: null as unknown as Sandbox, pending: new Map(), seq: 0, commits: [], actions: [] };
  runs.set(id, run);
  run.sandbox = createSandbox(p, frameHost, {
    plugin: { identifier: id, name: p.manifest.name, version: p.manifest.version || "", pyodide: `${location.origin}/static/pyodide/`, hosts: has(p, "network") && p.manifest.network && Array.isArray(p.manifest.network.hosts) ? p.manifest.network.hosts.slice(0, 200) : [] }, granted: p.granted.slice(), theme: themeNow(),
    entry: `(${pythonRuntime.toString()})();`, entryName: "kicad-python.js", html: "", resources: files, defer: true,
    editor: editorState(has(p, "design:read")),
  }, (msg) => onMessage(run, msg));
}
function start(p: InstalledPlugin) {
  if (!frameHost) return;
  if (isPython(p.manifest)) { void startPython(p); return; }
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
  if (S.window && S.window.plugin === id) set({ window: null });
  if (S.prompt && S.prompt.plugin === id) { S.prompt.resolve(null); set({ prompt: null }); }
  log(id, "host", "Stopped");
}
export function restart(id: string) { stop(id); pyFailed.delete(id); if (find(id) && isPython(find(id)!.manifest)) pyActive.add(id); syncRunning(); }

function onMessage(run: Run, m: any) {
  const id = run.plugin.identifier; if (!m || typeof m !== "object" || runs.get(id) !== run) return;
  switch (m.t) {
    case "ready":
      setRun(id, { ready: true, failed: !!m.failed, error: typeof m.error === "string" ? m.error.slice(0, 600) : null });
      if (!m.failed) log(id, "host", "Ready");
      if (run.actions) { if (m.failed) pyFailed.add(id); else rememberPyActions(run.plugin, run.actions); }
      break;
    case "log": log(id, m.level === "error" ? "error" : m.level === "warn" ? "warn" : "log", String(m.text || "")); break;
    case "registered": {
      if (typeof m.kind !== "string" || typeof m.name !== "string" || !["action", "importer", "exporter", "tool", "wizard"].includes(m.kind)) break;
      const reg = Object.assign({}, (S.running[id] || { registered: {} }).registered); reg[m.kind] = Array.from(new Set((reg[m.kind] || []).concat(m.name.slice(0, 80)))); setRun(id, { registered: reg });
      // A Python plugin says what its actions are called as it registers them; that is the only description there is.
      if (run.actions && m.kind === "action" && m.meta && typeof m.meta === "object" && /^py\d{1,3}$/.test(m.name) && run.actions.length < 60 && !run.actions.some((a) => a.identifier === m.name)) {
        const icon = typeof m.meta.icon === "string" && /^data:image\/(png|jpeg|gif|svg\+xml|bmp|x-icon);base64,[A-Za-z0-9+/=]+$/.test(m.meta.icon) && m.meta.icon.length < 120000 ? m.meta.icon : undefined;
        run.actions.push({ identifier: m.name, name: String(m.meta.name || "Action").slice(0, 120), description: String(m.meta.description || "").slice(0, 400), scopes: m.meta.wizard ? ["pcb", "footprint_wizard"] : ["pcb"], "show-button": !!m.meta.button, iconUrl: icon });
      }
      break;
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
    // A command reads the selection when it starts.  Picks of the board tools (a pad, a track) do not announce
    // themselves the way the app's own selection does, so the plugin is told what is selected now.
    if (has(run.plugin, "design:read")) { try { run.sandbox.send({ t: "event", name: "selection", data: selectionSummary() }); } catch { /* no document open */ } }
    run.sandbox.send({ t: "invoke", id, kind, name, arg });
  });
}
function emit(name: string, data: unknown, need?: string) { for (const run of runs.values()) if (!need || has(run.plugin, need)) run.sandbox.send({ t: "event", name, data }); }

/** Wait for a just-started plugin to finish loading (its handlers are registered as its script runs). */
async function whenReady(id: string, tries = 100): Promise<Run> {
  for (let i = 0; i < tries; i++) { const run = runs.get(id); const st = S.running[id]; if (!run && !pyStarting.has(id)) break; if (run && st && st.ready) { if (st.failed) throw new Error("the plugin failed to load; see its log"); return run; } await new Promise((r) => setTimeout(r, 50)); }
  const p = find(id);
  throw new Error(!p ? "that plugin is not installed" : !p.enabled ? `${p.manifest.name} is disabled` : `${p.manifest.name} is not running`);
}

// ---------------------------------------------------------------- the API gate

/** The permission each method needs; null means any running plugin may call it. */
const NEEDS: Record<string, string | null> = {
  "design.overview": "design:read", "design.documents": "design:read", "design.components": "design:read", "design.component": "design:read", "design.nets": "design:read",
  "design.items": "design:read", "design.selection": "design:read", "design.runChecks": "design:read", "design.boardInfo": "design:read", "design.board": "design:read",
  "design.apply": "design:write", "design.commit": "design:write", "design.titleBlock": "design:write", "design.undo": "design:write", "design.redo": "design:write", "design.copied": "design:read", "design.copy": "design:write",
  "view.select": "view", "view.move": "design:write", "view.highlight": "view", "view.focus": "view", "view.appearance": "view", "view.setMarkers": "view", "view.clearMarkers": "view", "view.openDocument": "view",
  "files.save": "files:export", "files.pick": "files:import",
  "fab.layers": "design:read", "fab.gerbers": "design:read", "fab.drill": "design:read", "fab.positions": "design:read", "fab.bom": "design:read",
  "fab.svg": "design:read", "fab.plot": "design:read", "fab.drc": "design:read", "fab.netlist": "design:read", "fab.render": "design:read", "fab.model": "design:read", "fab.vrml": "design:read", "fab.odb": "design:read", "project.versions": "design:read", "project.saveVersion": "design:write", "project.addLibraryFiles": "design:write", "project.rewriteDocument": "design:write", "project.saveRules": "design:write",
  "libs.libraries": null, "libs.symbolLibraries": null, "libs.symbolFile": null, "libs.footprints": null, "libs.footprint": null, "libs.model": null,
  "net.fetch": "network",
  "ui.toast": null, "ui.status": null, "ui.prompt": null, "ui.confirm": null, "ui.showPanel": null, "ui.hidePanel": null, "ui.showWindow": null, "ui.hideWindow": null, "ui.openLink": null,
  "storage.get": null, "storage.set": null, "storage.remove": null, "storage.keys": null,
};

/**
 * One HTTP request for one of KiCad's official Python plugins.  The frame cannot open connections; the server carries
 * the request, and only to the web addresses that plugin's own package names (src/pcm.rs decides, not this page).
 */
async function netFetch(p: InstalledPlugin, a: any): Promise<unknown> {
  if (!isPython(p.manifest)) throw new ApiError("Network requests through the server are for KiCad's official Python plugins.", "permission_denied");
  const url = String(a.url || ""); let host = ""; try { host = new URL(url).host; } catch { throw new ApiError("That is not a web address.", "invalid"); }
  const method = String(a.method || "GET").toUpperCase();
  log(p.identifier, "host", `Network: ${method} ${host}`);
  const r = await fetch(`/api/plugins/pcm/${encodeURIComponent(p.identifier)}/fetch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, method, headers: Array.isArray(a.headers) ? a.headers.filter((h: unknown) => Array.isArray(h) && h.length === 2).map((h: unknown[]) => [String(h[0]), String(h[1])]) : [], body: typeof a.body === "string" ? a.body : "" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const msg = (j && (j.message || j.error)) || `the server answered ${r.status}`; log(p.identifier, "warn", `Network: ${host}: ${msg}`); return { error: String(msg) }; }
  return j;
}

async function handleCall(run: Run, method: string, a: any): Promise<unknown> {
  const p = run.plugin; const name = p.manifest.name;
  if (!(method in NEEDS)) throw new ApiError(`there is no kicad.${method}`, "unknown_method");
  const need = NEEDS[method];
  if (need && !has(p, need)) throw new ApiError(`${name} does not have the "${need}" permission, which kicad.${method} needs. Add it to "permissions" in plugin.json; the person is asked when the plugin is installed.`, "permission_denied");
  const [ns, fn] = method.split(".");
  if (ns === "design") {
    if (reads[fn]) return reads[fn](a);
    if (fn === "copied" || fn === "copy") return copyBuffer[fn](a);
    if (fn === "undo" || fn === "redo") { const out = await history[fn](); log(p.identifier, "host", fn === "undo" ? "Chose Edit → Undo" : "Chose Edit → Redo"); return out; }
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
  if (ns === "fab") return fab[fn](a);
  if (ns === "libs") return libs[fn](a);
  if (ns === "project" && fn === "addLibraryFiles") return addLibraryFiles(p, a);
  if (ns === "project" && fn === "rewriteDocument") return rewriteDocument(p, a);
  if (ns === "project" && fn === "saveRules") return saveRules(p, a);
  if (ns === "project") { if (fn === "saveVersion") log(p.identifier, "host", a && a.name ? `Saved a version: ${String(a.name).slice(0, 80)}` : "Opened the Save Version dialog"); return project[fn](a); }
  if (ns === "net") return netFetch(p, a);
  if (ns === "storage") return storage(p.identifier, fn, a);
  if (ns === "files") return fn === "save" ? saveFile(p, a) : pickFile(p, a);
  switch (fn) {
    case "toast": toast(`${name}: ${String(a.text || "").slice(0, 300)}`, 3000); return null;
    case "status": try { APP() && ED().api.toolCtx().setStatus(a.text ? `${name}: ${String(a.text).slice(0, 120)}` : ""); } catch { /* no editor */ } return null;
    case "showPanel": if (!p.manifest.panel) throw new ApiError(`${name} declares no panel in plugin.json`, "invalid"); showPanel(p.identifier); return null;
    case "hidePanel": if (S.panel.active === p.identifier) setPanel({ open: false }); return null;
    case "showWindow": {
      if (S.window && S.window.plugin !== p.identifier) throw new ApiError("Another plugin window is already open.", "busy");
      const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
      set({ window: { plugin: p.identifier, pluginName: name, title: String(a.title || name).slice(0, 120), width: num(a.width, 240, 1200, 460), height: num(a.height, 60, 900, 260), modal: a.modal !== false } });
      showFrames(); return null;
    }
    case "hideWindow": if (S.window && S.window.plugin === p.identifier) { set({ window: null }); showFrames(); } return null;
    case "openLink": {
      // A plugin cannot open pages itself (its frame has no popups); the person is shown where it wants to go, and the editor opens it if they agree.
      let url: URL; try { url = new URL(String(a.url || "")); } catch { throw new ApiError("openLink needs a web address.", "invalid"); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiError("Only web addresses can be opened.", "invalid");
      const yes = await ask(p, { kind: "confirm", title: "Open a web page?", message: `${name} wants to open this page in a new tab:\n\n${url.href.slice(0, 600)}`, fields: [], okLabel: "Open" });
      if (yes) window.open(url.href, "_blank", "noopener,noreferrer");
      return !!yes;
    }
    case "confirm": return ask(p, { kind: "confirm", title: String(a.title || name).slice(0, 120), message: String(a.message || "").slice(0, 2000), fields: [], okLabel: a.okLabel ? String(a.okLabel).slice(0, 40) : undefined }).then((v) => !!v);
    case "prompt": return ask(p, { kind: "form", title: String(a.title || name).slice(0, 120), message: a.message ? String(a.message).slice(0, 2000) : undefined, fields: cleanFields(a.fields).filter((f) => f.type !== "file" || has(p, "files:import")), okLabel: a.okLabel ? String(a.okLabel).slice(0, 40) : undefined });
    default: return null;
  }
}

// ---------------------------------------------------------------- libraries a plugin imports

const LIBRARY_FILE = /^(?:[^/]+\/)*(?:[^/]+\.kicad_sym|[^/]+\.pretty\/[^/]+\.kicad_mod|[^/]+\.(?:step|stp|wrl))$/i;
/**
 * A plugin that imports parts writes symbol libraries, footprints and 3D models into the project folder.  On the
 * desktop they are then in the project; here the person is asked, and on a yes they become documents of the project
 * and rows of its library tables (everyone in the project gets them).  What is refused or fails is left to the
 * plugin, which hands it over as a download.
 */
async function addLibraryFiles(p: InstalledPlugin, a: any): Promise<unknown> {
  const files: { path: string; text: string }[] = [];
  for (const f of Array.isArray(a.files) ? a.files.slice(0, 200) : []) {
    const path = String((f && f.path) || "").replace(/\\/g, "/"); const text = typeof (f && f.text) === "string" ? f.text : "";
    if (LIBRARY_FILE.test(path) && !path.split("/").some((part) => part === ".." || part.startsWith(".")) && text && text.length <= 8_000_000) files.push({ path, text });
  }
  const none = { added: [], updated: [], failed: (Array.isArray(a.files) ? a.files : []).map((f: any) => String((f && f.path) || "")) };
  if (!files.length) return none;
  let ed: any; try { ed = ED(); } catch { return none; }
  if (!ed || !ed.api || !ed.api.importLibraryFiles || ed.viewOnly) return none;
  const libs = files.filter((f) => /\.kicad_sym$/i.test(f.path)).length, fps = files.filter((f) => /\.kicad_mod$/i.test(f.path)).length, models = files.length - libs - fps;
  const what = [libs ? `${libs} symbol ${libs === 1 ? "library" : "libraries"}` : "", fps ? `${fps} footprint${fps === 1 ? "" : "s"}` : "", models ? `${models} 3D model${models === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  const names = files.slice(0, 8).map((f) => f.path).join("\n") + (files.length > 8 ? `\n… and ${files.length - 8} more` : "");
  const yes = await ask(p, { kind: "confirm", title: "Add to the project's libraries", message: `${p.manifest.name} made ${what}. Add them to this project's libraries? Everyone in the project gets them.\n\n${names}`, fields: [], okLabel: "Add to project" });
  if (!yes) return none;
  const out = await ed.api.importLibraryFiles(files);
  log(p.identifier, "host", `Added to the project's libraries: ${[...out.added, ...out.updated].join(", ") || "nothing"}${out.failed.length ? `; failed: ${out.failed.join(", ")}` : ""}`);
  if (out.added.length || out.updated.length) toast(`${p.manifest.name}: ${out.added.length + out.updated.length} library file${out.added.length + out.updated.length === 1 ? "" : "s"} added to the project`, 4000);
  return out;
}

/**
 * A schematic (or another board of the project) that a plugin rewrote as a file.  The server works out what the
 * plugin changed, item by item, and carries that into the document as it is now; the person sees the list first.
 * The open document is not rewritten this way: plugins change it through the editor.
 */
async function rewriteDocument(p: InstalledPlugin, a: any): Promise<unknown> {
  const path = String(a.path || "").replace(/\\/g, "/"), base = typeof a.base === "string" ? a.base : "", text = typeof a.text === "string" ? a.text : "";
  if (!/\.kicad_(sch|pcb)$/i.test(path) || !base || !text || text.length > 32_000_000) return { error: "not a schematic or board of this project" };
  let ed: any; try { ed = ED(); } catch { return { error: "no editor" }; }
  if (!ed || ed.viewOnly) return { error: "this project is open for viewing only" };
  const doc = projectDocByPath(path); if (!doc) return { error: "the project has no document of that name" };
  if (doc.open) return { error: "the open document is changed through the editor, not as a file" };
  const send = async (dry: boolean) => {
    const r = await fetch(`/api/docs/${encodeURIComponent(doc.docId)}/rewrite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base, text, label: p.manifest.name, dry_run: dry }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(String(j.error || j.message || `the server answered ${r.status}`)); return j;
  };
  let plan: any; try { plan = await send(true); } catch (e) { return { error: String((e as Error).message || e) }; }
  const changes: any[] = Array.isArray(plan.changes) ? plan.changes : [];
  if (!plan.changed || !changes.length) return { unchanged: true };
  const lines = changes.slice(0, 10).map((c) => `${c.kind} ${c.item}${Array.isArray(c.parts) && c.parts.length ? ` (${c.parts.slice(0, 3).join(", ")})` : ""}`).join("\n") + (changes.length > 10 ? `\n… and ${changes.length - 10} more` : "");
  const yes = await ask(p, { kind: "confirm", title: "Change the schematic", message: `${p.manifest.name} changed ${path}. Carry ${changes.length === 1 ? "this change" : `these ${changes.length} changes`} into the project? The document as it was is kept in History.\n\n${lines}`, fields: [], okLabel: "Apply changes" });
  if (!yes) return { declined: true };
  let done: any; try { done = await send(false); } catch (e) { return { error: String((e as Error).message || e) }; }
  log(p.identifier, "host", `${path}: ${changes.length} change${changes.length === 1 ? "" : "s"} carried into the project${done.kept ? ` (kept as “${done.kept}”)` : ""}`);
  toast(`${p.manifest.name}: ${path} updated`, 4000);
  return { applied: true, changes };
}

/**
 * The project's custom design rules file (.kicad_dru) as a plugin wrote it.  The person is shown what the plugin wants
 * to store and decides; the rules then are the project's own (Board Setup > Custom Rules), and DRC uses them.
 */
async function saveRules(p: InstalledPlugin, a: any): Promise<unknown> {
  const path = String(a.path || "").replace(/\\/g, "/"), text = typeof a.text === "string" ? a.text : "";
  if (!/^[^/]+\.kicad_dru$/i.test(path) || text.length > 2_000_000) return { error: "not the project's custom rules file" };
  let ed: any; try { ed = ED(); } catch { return { error: "no editor" }; }
  if (!ed || ed.viewOnly || !ed.api || typeof ed.api.saveCustomRules !== "function") return { error: "this project is open for viewing only" };
  if (typeof ed.druText === "string" && ed.druText === text) return { unchanged: true };
  const rules = (text.match(/\(rule\s/g) || []).length;
  const yes = await ask(p, { kind: "confirm", title: "Change the custom design rules", message: `${p.manifest.name} wrote the project's custom rules file (${path}): ${rules} rule${rules === 1 ? "" : "s"}. Store it in the project? The design rule check, the router and the length tuner follow these rules; Board Setup > Custom Rules shows them.`, fields: [], okLabel: "Store rules" });
  if (!yes) return { declined: true };
  const ok = await ed.api.saveCustomRules(path, text);
  if (!ok) return { error: "the rules could not be saved" };
  log(p.identifier, "host", `${path}: custom rules stored in the project (${rules} rule${rules === 1 ? "" : "s"})`);
  toast(`${p.manifest.name}: custom rules updated`, 4000);
  return { applied: true };
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
  for (const p of s.installed) if (p.enabled) for (const a of actionsOf(p, s)) if (inScope(a.scopes, editor)) out.push({ plugin: p.identifier, pluginName: p.manifest.name, id: a.identifier, uiId: uiIdOf("plugin", p.identifier, a.identifier), name: a.name, description: a.description || "", action: a });
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
  const list: Array<{ identifier: string; name: string }> = (m[1] === "plugin" ? actionsOf(p) : m[1] === "plugin-import" ? p.manifest.importers : p.manifest.exporters) || [];
  const hit = list.find((x) => x.identifier === m[3]); return hit ? hit.name : null;
}
export function pluginUiKey(id: string): string {
  const m = id.match(/^plugin:([^:]+):(.+)$/); if (!m) return "";
  const pl = find(m[1]); const a = (pl ? actionsOf(pl) : []).find((x) => x.identifier === m[2]); return (a && a.key) || "";
}

async function busy<T>(id: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  setRun(id, { busy: what });
  // An action may wait on a dialog for minutes, so there is no deadline; a plugin that is simply stuck is named once, with the way out.
  const slow = window.setTimeout(() => { if (!S.prompt && !S.window) { log(id, "warn", `${what} has been running for 20 seconds`); toast(`${find(id)?.manifest.name || "A plugin"} is still running “${what}”. Restart it from Manage Plugins if it is stuck.`, 6000); } }, 20000);
  try { return await fn(); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); log(id, "error", `${what}: ${msg}`); toast(`${find(id)?.manifest.name || "Plugin"}: ${msg}`, 5000); return undefined; }
  finally { clearTimeout(slow); if (S.running[id]) setRun(id, { busy: null }); }
}

export async function runAction(plugin: string, action: string): Promise<void> {
  const p = find(plugin); const a = p && actionsOf(p).find((x) => x.identifier === action); if (!p || !a) return;
  const python = isPython(p.manifest);
  if (python) { pyActive.add(plugin); pyFailed.delete(plugin); syncRunning(); }      // the interpreter starts on the first click, and stays for the next
  await busy(plugin, a.name, async () => { const run = await whenReady(plugin, python ? 1800 : 100); await invoke(run, "action", action, { editor: editorState(has(p, "design:read")) }, 0); });
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
/** A footprint wizard a plugin offers (an action of scope "footprint_wizard", KiCad's api.v1 PluginAction scope),
 *  as the footprint editor's wizard dialog lists it.  A Python plugin's wizards are the ones it registered when it
 *  last ran ("Footprint Wizard: <name>" commands). */
export interface WizardContribution { plugin: string; pluginName: string; id: string; name: string; description: string; python: boolean }
export function footprintWizards(s: PluginState = S): WizardContribution[] {
  const out: WizardContribution[] = [];
  for (const p of s.installed) if (p.enabled) for (const a of actionsOf(p, s)) if ((a.scopes || []).includes("footprint_wizard"))
    out.push({ plugin: p.identifier, pluginName: p.manifest.name, id: a.identifier, name: a.name.replace(/^Footprint Wizard: /, ""), description: a.description || "", python: isPython(p.manifest) });
  return out;
}
/** One request to a footprint wizard (see web/editor/fpwizard.ts for what it is asked and answers); a Python
 *  plugin's interpreter starts on the first one, as for its actions. */
export async function callWizard(plugin: string, id: string, req: unknown): Promise<unknown> {
  const p = find(plugin); if (!p) throw new Error("that plugin is not installed");
  const python = isPython(p.manifest);
  if (python) { pyActive.add(plugin); pyFailed.delete(plugin); syncRunning(); }
  const run = await whenReady(plugin, python ? 1800 : 100);
  return invoke(run, "wizard", id, req, python ? 0 : 30000);
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
  const win = S.window ? S.window.plugin : null;
  for (const [id, run] of runs) { const f = run.sandbox.frame; f.hidden = id !== win && (!active || active.plugin !== id); f.classList.toggle("plg-windowed", id === win); }
}
/** The person closed a plugin window: the plugin is told (a wx dialog gets its close event) and takes the window down itself. */
export function closeWindow() {
  const w = S.window; if (!w) return; const run = runs.get(w.plugin);
  if (run) run.sandbox.send({ t: "event", name: "window-closed", data: {} });
  // A plugin that does not answer (still busy, or stuck) does not get to keep a window over the editor.
  window.setTimeout(() => { if (S.window === w) { set({ window: null }); showFrames(); } }, run ? 1500 : 0);
}
export function openManager(tab?: PluginState["manager"]["tab"]) {
  set({ manager: Object.assign({}, S.manager, { open: true, tab: tab || S.manager.tab }) });
  if (!S.catalog) void loadCatalog(); void loadRegistry(); void loadProject(); void refresh().then(() => loadModeration());
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
  // the footprint editor's wizard dialog lives in the editor bundle: it reaches this one through the window
  (window as unknown as { KiCadPluginWizards?: unknown }).KiCadPluginWizards = { list: () => footprintWizards(), call: callWizard };
  const app = APP(); if (!app) return;
  let last: any = {}; let changeTimer = 0;
  const onState = (st: any) => {
    const now = { me: st.me ? st.me.id : null, view: st.view, project: st.project ? st.project.projectId : null, editor: st.document.editor, docId: st.document.docId, sel: st.selection.version, ver: st.document.version, viewOnly: st.viewOnly, selIds: st.selection.ids };
    const was = last; last = now;
    if (now.me !== was.me) void refresh();
    if (now.editor !== was.editor) { set({ editor: now.editor }); showFrames(); }
    if (now.view !== was.view || now.project !== was.project) syncRunning();
    if (now.project !== was.project || now.me !== was.me) void loadProject();
    if (now.project !== was.project && now.project && was.me === now.me) void refresh();   // a plugin withdrawn since the last look stops here
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
    if (!S.editor || app.getState().view !== "editor" || S.manager.open || S.prompt || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT" || t.isContentEditable)) || (W.KDialogs && W.KDialogs.isOpen && W.KDialogs.isOpen())) return;
    for (const a of actionsFor(S, S.editor)) if (a.action.key && hotkeyMatches(ev, a.action.key)) { ev.preventDefault(); ev.stopPropagation(); void runAction(a.plugin, a.id); return; }
  }, true);

  // Other parts of the editor (and the tests) reach plugins and their declared tools through this object.
  W.KcPlugins = { store: pluginStore, tools: assistantTools, callTool: callAssistantTool, openManager, runUi: runPluginUi, runAction, refresh, loadProject };
}
