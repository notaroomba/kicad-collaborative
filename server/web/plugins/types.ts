// types.ts — what a web plugin is: its manifest, the permissions it can ask for, and the checks
// that decide whether a manifest is accepted at all.
//
// The manifest is KiCad's own IPC-API `plugin.json` (api/schemas/api.v1.schema.json: identifier,
// name, description, runtime, actions[] with scopes / show-button / entrypoint) with one more
// runtime type, "web", and the keys a browser plugin needs: `permissions`, `panel`, `importers`,
// `exporters`, `assistant_tools`.  A folder can therefore carry a desktop plugin (python / exec,
// which KiCad Collaborative on the desktop runs exactly as KiCad does) and a web one side by side.

export type Scope = "pcb" | "schematic";

/** What a plugin may be allowed to do.  Nothing is granted that is not listed and consented to. */
export const PERMISSIONS: Record<string, { title: string; detail: string; risk: "low" | "medium" | "high" }> = {
  "design:read": { title: "Read your designs", detail: "See the components, nets, items and selection of the projects you open while it is enabled.", risk: "medium" },
  "design:write": { title: "Change your designs", detail: "Add, change and remove items in the open document. Every change is a normal collaborative edit: your collaborators see it, it is one undo step, and checkpoints record it.", risk: "high" },
  view: { title: "Control the view", detail: "Select and highlight items, move the view, place check markers and open another document of the project.", risk: "low" },
  "files:import": { title: "Read files you choose", detail: "Read a file from your computer when you pick it in a file dialog.", risk: "low" },
  "files:export": { title: "Save files", detail: "Offer files for download to your computer.", risk: "low" },
  assistant: { title: "Give the assistant tools", detail: "Add tools the design assistant can call. What they return is read by the assistant.", risk: "medium" },
  network: { title: "Talk to the internet", detail: "Send and receive data from the hosts it names. Combined with reading your designs, it could send them there.", risk: "high" },
};

export interface PluginAction {
  identifier: string; name: string; description: string;
  "show-button"?: boolean; scopes?: Scope[];
  /** Inline SVG markup for a 24×24 stroke glyph (the toolbar button). */
  icon?: string;
  /** Hotkey in KiCad's notation, e.g. "Ctrl+Shift+B". */
  key?: string;
  /** Which menu lists it: "tools" (Tools → External Plugins, the default), "inspect", "edit" or "place". */
  menu?: string;
}
export interface PluginPanel { name: string; scopes?: Scope[]; html?: string; width?: number }
export interface PluginPorter { identifier: string; name: string; description?: string; scopes?: Scope[]; extensions?: string[] }
export interface PluginAssistantTool { name: string; description: string; input_schema?: unknown }

export interface PluginManifest {
  identifier: string; name: string; description: string; version?: string; author?: string; homepage?: string; license?: string;
  runtime: { type: string; entrypoint?: string };
  permissions?: string[];
  actions?: PluginAction[];
  panel?: PluginPanel;
  importers?: PluginPorter[];
  exporters?: PluginPorter[];
  assistant_tools?: PluginAssistantTool[];
  /** Other files of the plugin it reads at run time with kicad.resources.text(). */
  resources?: string[];
}

/** An installed plugin as the server stores it. */
export interface InstalledPlugin {
  identifier: string; manifest: PluginManifest; files: Record<string, string>;
  enabled: boolean; granted: string[]; source: string; installedAt?: string; updatedAt?: string;
  /** Set when the registry plugin this copy came from was hidden or removed by the administrators: their reason. */
  withdrawn?: string | null;
}

export const ID_RE = /^[a-zA-Z][-_a-zA-Z0-9.]{0,98}[a-zA-Z0-9]$/;
const SUB_ID_RE = /^[a-zA-Z][-_a-zA-Z0-9.]{0,48}[a-zA-Z0-9]$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,40}$/;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(:\d{1,5})?$/;
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,120}$/;
const SCOPES = new Set(["pcb", "schematic"]);
export const MAX_FILES = 40, MAX_BYTES = 2 * 1024 * 1024;

export const isNetwork = (p: string) => p.startsWith("network:");
export const hostsOf = (perms: string[]) => perms.filter(isNetwork).map((p) => p.slice(8));

/** A permission as a person reads it. */
export function describePermission(p: string): { title: string; detail: string; risk: "low" | "medium" | "high" } {
  if (isNetwork(p)) return { title: `Talk to ${p.slice(8)}`, detail: PERMISSIONS.network.detail, risk: "high" };
  return PERMISSIONS[p] || { title: p, detail: "", risk: "high" };
}

const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
export const safePath = (p: unknown): p is string => typeof p === "string" && PATH_RE.test(p) && !p.includes("..") && !p.includes("//");

/**
 * Check a manifest.  Returns the problems in plain words; an empty list means it is acceptable.
 * Unknown keys are ignored (a desktop plugin's keys live in the same file), unknown *permissions*
 * are not: a plugin asking for something this version cannot grant must not install quietly.
 */
export function validateManifest(m: any): string[] {
  const bad: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["plugin.json is not a JSON object"];
  if (!str(m.identifier, 100) || !ID_RE.test(m.identifier)) bad.push("identifier must look like com.example.my-plugin");
  if (!str(m.name, 200)) bad.push("name is required (200 characters at most)");
  if (typeof m.description !== "string" || m.description.length > 500) bad.push("description is required (500 characters at most)");
  if (!m.runtime || typeof m.runtime !== "object") bad.push("runtime is required");
  else if (m.runtime.type !== "web") bad.push(m.runtime.type === "python" || m.runtime.type === "exec" ? `this is a desktop plugin (runtime "${m.runtime.type}"): install it in the desktop app's Plugin and Content Manager` : 'runtime.type must be "web"');
  else if (!safePath(m.runtime.entrypoint) || !/\.js$/.test(m.runtime.entrypoint)) bad.push("runtime.entrypoint must name the plugin's .js file");
  const perms = m.permissions === undefined ? [] : m.permissions;
  if (!Array.isArray(perms) || perms.some((p: unknown) => typeof p !== "string")) bad.push("permissions must be a list of strings");
  else for (const p of perms as string[]) {
    if (isNetwork(p)) { if (!HOST_RE.test(p.slice(8))) bad.push(`"${p}": name a host, for example network:api.example.com`); }
    else if (p === "network" || !PERMISSIONS[p]) bad.push(p === "network" ? 'network access must name its hosts, for example "network:api.example.com"' : `unknown permission "${p}"`);
  }
  const has = (p: string) => Array.isArray(perms) && perms.includes(p);
  const scopesOk = (s: unknown) => s === undefined || (Array.isArray(s) && s.every((x) => SCOPES.has(x)));
  const seen = new Set<string>();
  const list = (key: string, v: unknown, each: (x: any, where: string) => void) => {
    if (v === undefined) return; if (!Array.isArray(v) || v.length > 60) { bad.push(`${key} must be a list`); return; }
    v.forEach((x, i) => { if (!x || typeof x !== "object") bad.push(`${key}[${i}] must be an object`); else each(x, `${key}[${i}]`); });
  };
  const ident = (x: any, where: string) => {
    if (!str(x.identifier, 50) || !SUB_ID_RE.test(x.identifier)) bad.push(`${where}.identifier is missing or malformed`);
    else if (seen.has(where.split("[")[0] + x.identifier)) bad.push(`${where}.identifier "${x.identifier}" is used twice`);
    else seen.add(where.split("[")[0] + x.identifier);
    if (!str(x.name, 200)) bad.push(`${where}.name is required`);
    if (!scopesOk(x.scopes)) bad.push(`${where}.scopes may hold "pcb" and "schematic" (the editors the web has)`);
  };
  list("actions", m.actions, (x, w) => {
    ident(x, w);
    if (x.icon !== undefined && (typeof x.icon !== "string" || x.icon.length > 4000)) bad.push(`${w}.icon must be inline SVG markup`);
    if (x.key !== undefined && (typeof x.key !== "string" || x.key.length > 30)) bad.push(`${w}.key must be a hotkey such as "Ctrl+Shift+B"`);
  });
  list("importers", m.importers, (x, w) => { ident(x, w); if (!has("files:import")) bad.push(`${w} needs the files:import permission`); if (x.extensions !== undefined && (!Array.isArray(x.extensions) || x.extensions.some((e: unknown) => typeof e !== "string" || !/^\.[A-Za-z0-9_]{1,12}$/.test(e)))) bad.push(`${w}.extensions must look like [".csv"]`); });
  list("exporters", m.exporters, (x, w) => { ident(x, w); if (!has("files:export")) bad.push(`${w} needs the files:export permission`); });
  list("assistant_tools", m.assistant_tools, (x, w) => {
    if (!str(x.name, 41) || !TOOL_RE.test(x.name)) bad.push(`${w}.name must be lower_snake_case`);
    if (!str(x.description, 1200)) bad.push(`${w}.description is required: it is what the assistant reads to decide when to call the tool`);
    if (!has("assistant")) bad.push(`${w} needs the assistant permission`);
  });
  if (m.panel !== undefined) {
    if (!m.panel || typeof m.panel !== "object" || !str(m.panel.name, 60)) bad.push("panel.name is required");
    else { if (!scopesOk(m.panel.scopes)) bad.push('panel.scopes may hold "pcb" and "schematic"'); if (m.panel.html !== undefined && !safePath(m.panel.html)) bad.push("panel.html must name a file of the plugin"); }
  }
  if (m.resources !== undefined && (!Array.isArray(m.resources) || m.resources.length > MAX_FILES || m.resources.some((p: unknown) => !safePath(p)))) bad.push("resources must be a list of file paths inside the plugin");
  return bad;
}

/** Every file a manifest refers to, entry point first. */
export function manifestFiles(m: PluginManifest): string[] {
  const out = [m.runtime.entrypoint || "main.js"];
  if (m.panel && m.panel.html) out.push(m.panel.html);
  for (const r of m.resources || []) out.push(r);
  return Array.from(new Set(out));
}

export function validateFiles(m: PluginManifest, files: Record<string, string>): string[] {
  const bad: string[] = []; const names = Object.keys(files);
  if (names.length > MAX_FILES) bad.push(`a plugin holds at most ${MAX_FILES} files`);
  let total = 0; for (const n of names) { if (!safePath(n)) bad.push(`"${n}" is not an acceptable file name`); total += files[n].length; }
  if (total > MAX_BYTES) bad.push("the plugin is larger than 2 MB");
  for (const f of manifestFiles(m)) if (typeof files[f] !== "string") bad.push(`${f} is named in plugin.json but missing`);
  return bad;
}

export const scopeOf = (editor: string | null): Scope | null => (editor === "pcb" ? "pcb" : editor === "sch" ? "schematic" : null);
export const inScope = (scopes: Scope[] | undefined, editor: string | null) => { const s = scopeOf(editor); return !!s && (!scopes || !scopes.length || scopes.includes(s)); };
