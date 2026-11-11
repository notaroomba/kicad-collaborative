// library/sources.ts — where the chooser's tree comes from: KiCad's official libraries through
// the server's /api/libs/* routes, the project's own *.kicad_sym / *.pretty documents, and the
// sources other modules register (KiCadLibrary.registerSource).  Everything is fetched on
// demand and kept for the page's lifetime; the pinned upstream ref never changes under it.
import { flattenSymbol, footprintInfo, parseLibId, symbolInfo, symbolNodeOf } from "./core";

export type LibKind = "symbol" | "footprint";

/** One row of a library: a symbol or a footprint the chooser can show without its geometry. */
export interface LibItem {
  /** The lib id / fpid ("Device:R") or a source's own id. */
  id: string;
  name: string;
  description?: string;
  keywords?: string;
  library?: string;
  /** Symbols: unit count, power flag, reference prefix, default footprint, parent. */
  units?: number;
  power?: boolean;
  reference?: string;
  footprint?: string;
  extends?: string;
  /** Footprints: pad count. */
  pads?: number;
  /** Which source resolves the item: "official", "project", "placed" or a registered source id. */
  source: string;
}

/** What a source hands back for a chosen item: the s-expression plus field values to apply. */
export interface FetchedItem {
  libId?: string;
  fpid?: string;
  /** A library symbol, parents flattened. */
  symbol?: string;
  /** A .kicad_mod. */
  footprint?: string;
  fields?: Record<string, string>;
}

/** The contract of KiCadLibrary.registerSource. */
export interface LibrarySource {
  id: string;
  label: string;
  kinds: LibKind[];
  search(query: string, kind: LibKind): Promise<Array<{ id: string; name: string; description?: string; keywords?: string; library?: string }>>;
  fetch(item: { id: string; name: string; description?: string; keywords?: string; library?: string }, kind: LibKind): Promise<FetchedItem>;
}

export interface LibraryEntry { name: string; description: string; source: "official" | "project" }

interface ProjectDoc { docId: string; path: string; docType: string }

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const seg = (kind: LibKind) => (kind === "symbol" ? "symbols" : "footprints");

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json() as { message?: string }; if (j && j.message) msg = j.message; } catch { /* not JSON */ }
    const err: Error & { retryAfter?: number } = new Error(r.status === 401 ? "Sign in to use the KiCad libraries" : msg || `HTTP ${r.status}`);
    // 503 + Retry-After: the server could not reach the upstream just now
    const wait = Number(r.headers.get("retry-after")); if (r.status === 503 && wait > 0) err.retryAfter = wait;
    throw err;
  }
  return r.json() as Promise<T>;
}

// ---------------------------------------------------------------- official libraries

interface SymbolRow { n: string; d: string; k: string; r: string; u: number; p?: boolean; e?: string; f?: string }
interface FootprintRow { n: string; d: string; k: string; p: number }

const tables = new Map<LibKind, Promise<{ ref: string; libraries: LibraryEntry[] }>>();
const indexes = new Map<string, Promise<LibItem[]>>();
const fetched = new Map<string, Promise<FetchedItem>>();

/** The official library table of one kind (names and descriptions, table order). */
export function officialLibraries(kind: LibKind): Promise<{ ref: string; libraries: LibraryEntry[] }> {
  let p = tables.get(kind);
  if (!p) {
    p = getJson<{ ref: string; libraries: { name: string; description: string }[] }>(`/api/libs/${seg(kind)}`)
      .then((j) => ({ ref: j.ref, libraries: j.libraries.map((l) => ({ name: l.name, description: l.description, source: "official" as const })) }));
    p.catch(() => tables.delete(kind));
    tables.set(kind, p);
  }
  return p;
}

/** The rows of one official library. */
export function officialIndex(kind: LibKind, lib: string): Promise<LibItem[]> {
  const key = kind + ":" + lib;
  let p = indexes.get(key);
  if (!p) {
    p = kind === "symbol"
      ? getJson<{ symbols: SymbolRow[] }>(`/api/libs/symbols/${encodeURIComponent(lib)}`).then((j) => j.symbols.map((s): LibItem => ({
        id: `${lib}:${s.n}`, name: s.n, description: s.d, keywords: s.k, library: lib, units: s.u, power: !!s.p, reference: s.r, footprint: s.f || "", extends: s.e || "", source: "official" })))
      : getJson<{ footprints: FootprintRow[] }>(`/api/libs/footprints/${encodeURIComponent(lib)}`).then((j) => j.footprints.map((f): LibItem => ({
        id: `${lib}:${f.n}`, name: f.n, description: f.d, keywords: f.k, library: lib, pads: f.p, source: "official" })));
    p.catch(() => indexes.delete(key));
    indexes.set(key, p);
  }
  return p;
}

function officialFetch(kind: LibKind, id: string): Promise<FetchedItem> {
  const key = kind + ":" + id;
  let p = fetched.get(key);
  if (!p) {
    const { lib, name } = parseLibId(id);
    const url = `/api/libs/${seg(kind)}/${encodeURIComponent(lib)}/${encodeURIComponent(name)}`;
    p = kind === "symbol"
      ? getJson<{ libId: string; symbol: string; parents: string[] }>(url).then((j) => ({ libId: j.libId, symbol: K().serialize(flattenSymbol(j.symbol, j.parents)) }))
      : getJson<{ fpid: string; footprint: string }>(url).then((j) => ({ fpid: j.fpid, footprint: j.footprint }));
    p.catch(() => fetched.delete(key));
    fetched.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------- the project's own libraries

interface ProjectLib { name: string; docs: ProjectDoc[] }

/** Library nicknames of a project's *.kicad_sym files / *.pretty folders, from its document list. */
export function projectLibraries(kind: LibKind, docs: ProjectDoc[]): ProjectLib[] {
  const out = new Map<string, ProjectLib>();
  for (const d of docs || []) {
    if (!d || typeof d.path !== "string") continue;
    const parts = d.path.split("/"), file = parts[parts.length - 1];
    let name = "";
    if (kind === "symbol" && /\.kicad_sym$/i.test(file)) name = file.replace(/\.kicad_sym$/i, "");
    else if (kind === "footprint" && /\.kicad_mod$/i.test(file)) {
      const dir = parts[parts.length - 2] || "";
      name = /\.pretty$/i.test(dir) ? dir.replace(/\.pretty$/i, "") : "";
    }
    if (!name) continue;
    let lib = out.get(name); if (!lib) { lib = { name, docs: [] }; out.set(name, lib); }
    lib.docs.push(d);
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const docTexts = new Map<string, Promise<string>>();
function docText(docId: string): Promise<string> {
  let p = docTexts.get(docId);
  if (!p) {
    p = fetch(`/api/docs/${docId}/content`, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
    p.catch(() => docTexts.delete(docId));
    docTexts.set(docId, p);
  }
  return p;
}

async function projectIndex(kind: LibKind, lib: ProjectLib): Promise<LibItem[]> {
  if (kind === "footprint") {
    return lib.docs.map((d): LibItem => { const name = d.path.split("/").pop()!.replace(/\.kicad_mod$/i, ""); return { id: `${lib.name}:${name}`, name, library: lib.name, source: "project" }; })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows: LibItem[] = [];
  for (const d of lib.docs) {
    const tree = K().parse(await docText(d.docId)); if (!tree) continue;
    const all = K().kids(tree, "symbol");
    const byName = new Map(all.map((s) => [String(s[1]), s]));
    for (const s of all) {
      const info = symbolInfo(s);
      // a derived symbol draws its root parent
      let root = s, depth = 0;
      for (let e = K().kid(root, "extends"); e && depth < 16; e = K().kid(root, "extends"), depth++) { const p = byName.get(String(e[1])); if (!p) break; root = p; }
      const ri = root === s ? info : symbolInfo(root);
      rows.push({ id: `${lib.name}:${info.name}`, name: info.name, description: info.description || ri.description, keywords: info.keywords || ri.keywords, library: lib.name,
        units: ri.units, power: ri.power || info.power, reference: info.reference || ri.reference, footprint: info.footprint, extends: info.extends, source: "project" });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function projectFetch(kind: LibKind, id: string, docs: ProjectDoc[]): Promise<FetchedItem> {
  const { lib, name } = parseLibId(id);
  const pl = projectLibraries(kind, docs).find((l) => l.name === lib);
  if (!pl) throw new Error(`The project has no library ${lib}`);
  if (kind === "footprint") {
    const d = pl.docs.find((x) => x.path.split("/").pop()!.replace(/\.kicad_mod$/i, "") === name);
    if (!d) throw new Error(`${lib} has no footprint ${name}`);
    return { fpid: id, footprint: await docText(d.docId) };
  }
  for (const d of pl.docs) {
    const tree = K().parse(await docText(d.docId)); if (!tree) continue;
    const all = K().kids(tree, "symbol"), byName = new Map(all.map((s) => [String(s[1]), s]));
    const sym = byName.get(name); if (!sym) continue;
    const parents: SNode[] = [];
    for (let e = K().kid(sym, "extends"); e && parents.length < 16;) { const p = byName.get(String(e[1])); if (!p) break; parents.push(p); e = K().kid(p, "extends"); }
    return { libId: id, symbol: K().serialize(flattenSymbol(sym, parents)) };
  }
  throw new Error(`${lib} has no symbol ${name}`);
}

// ---------------------------------------------------------------- registered sources

const registered = new Map<string, LibrarySource>();
const sourceListeners = new Set<() => void>();

export function registerSource(source: LibrarySource): void {
  if (!source || typeof source.id !== "string" || !source.id || typeof source.search !== "function" || typeof source.fetch !== "function")
    throw new Error("registerSource needs { id, label, kinds, search(), fetch() }");
  if (["official", "project", "placed", "recent"].includes(source.id)) throw new Error(`"${source.id}" is a built-in source id`);
  registered.set(source.id, { id: source.id, label: String(source.label || source.id), kinds: Array.isArray(source.kinds) && source.kinds.length ? source.kinds : ["symbol", "footprint"],
    search: source.search.bind(source), fetch: source.fetch.bind(source) });
  for (const fn of Array.from(sourceListeners)) fn();
}
export function unregisterSource(id: string): void { if (registered.delete(id)) for (const fn of Array.from(sourceListeners)) fn(); }
export function registeredSources(kind: LibKind): LibrarySource[] { return Array.from(registered.values()).filter((s) => s.kinds.includes(kind)); }
export function onSourcesChanged(fn: () => void): () => void { sourceListeners.add(fn); return () => { sourceListeners.delete(fn); }; }

// ---------------------------------------------------------------- one front door

export interface SourceContext { docs: ProjectDoc[]; doc: KDoc | null }

/** The rows of a library of a built-in source. */
export function libraryIndex(kind: LibKind, entry: LibraryEntry, ctx: SourceContext): Promise<LibItem[]> {
  if (entry.source === "official") return officialIndex(kind, entry.name);
  const pl = projectLibraries(kind, ctx.docs).find((l) => l.name === entry.name);
  return pl ? projectIndex(kind, pl) : Promise.resolve([]);
}

/** Symbols the sheet already embeds / footprints the board already uses, as chooser rows. */
export function placedItems(kind: LibKind, doc: KDoc | null): LibItem[] {
  if (!doc) return [];
  const out: LibItem[] = [];
  if (kind === "symbol") {
    for (const [id, node] of doc.lib) {
      let info; try { info = symbolInfo(K().resolveLib(doc, id) || node); } catch { continue; }
      out.push({ id, name: parseLibId(id).name, description: info.description, keywords: info.keywords, library: parseLibId(id).lib, units: info.units, power: info.power,
        reference: info.reference, footprint: info.footprint, source: "placed" });
    }
  } else {
    const seen = new Set<string>();
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint") continue;
      const id = String(it.node[1] || ""); if (!id || seen.has(id)) continue; seen.add(id);
      const info = footprintInfo(it.node);
      out.push({ id, name: info.name, description: info.description, keywords: info.keywords, library: parseLibId(id).lib, pads: info.pads, source: "placed" });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function placedFetch(kind: LibKind, id: string, doc: KDoc | null): FetchedItem {
  if (!doc) throw new Error("No document is open");
  if (kind === "symbol") {
    const node = K().resolveLib(doc, id) || doc.lib.get(id);
    if (!node) throw new Error(`The sheet has no symbol ${id}`);
    const flat = K().cloneNode ? (K().cloneNode as (n: SNode) => SNode)(node) : node;
    for (let i = flat.length - 1; i >= 1; i--) { const c = flat[i]; if (Array.isArray(c) && c[0] === "extends") flat.splice(i, 1); }
    return { libId: id, symbol: K().serialize(symbolNodeOf(flat)) };
  }
  // a board footprint back in library form: unflipped, unrotated, about its own origin
  const Pcb = (window as unknown as { PcbTools?: { flipFootprintNode(n: SNode): SNode; rotateFootprintNode(n: SNode, deg: number): SNode } }).PcbTools;
  let best: KItem | null = null;
  for (const it of doc.items.values()) if (it.kind === "footprint" && String(it.node[1]) === id) { if (!best || (it.layer !== "B.Cu" && !(it.rot || 0))) best = it; }
  if (!best) throw new Error(`The board has no footprint ${id}`);
  const node = (K().cloneNode as (n: SNode) => SNode)(best.node);
  const layer = K().kid(node, "layer");
  if (Pcb && layer && String(layer[1]) === "B.Cu") Pcb.flipFootprintNode(node);
  const rot = K().atOf(node)[2];
  if (Pcb && rot) Pcb.rotateFootprintNode(node, -rot);
  return { fpid: id, footprint: K().serialize(node) };
}

/** Resolve a chooser row to its s-expression through whichever source owns it. */
export async function fetchItem(kind: LibKind, item: LibItem, ctx: SourceContext): Promise<FetchedItem> {
  if (item.source === "official") return officialFetch(kind, item.id);
  if (item.source === "project") return projectFetch(kind, item.id, ctx.docs);
  if (item.source === "placed") return placedFetch(kind, item.id, ctx.doc);
  const src = registered.get(item.source);
  if (!src) throw new Error(`Unknown library source ${item.source}`);
  const got = await src.fetch({ id: item.id, name: item.name, description: item.description, keywords: item.keywords, library: item.library }, kind);
  if (!got || (kind === "symbol" ? !got.symbol : !got.footprint)) throw new Error(`${src.label} returned no ${kind}`);
  return got;
}

// ---------------------------------------------------------------- recently used (per browser)

const RECENT_MAX = 12;
const recentKey = (kind: LibKind) => `kicad-collab:lib-recent:${kind}`;

export function recentItems(kind: LibKind): LibItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentKey(kind)) || "[]") as LibItem[];
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && (r.source === "official" || r.source === "project")) : [];
  } catch { return []; }
}
export function rememberRecent(kind: LibKind, item: LibItem): void {
  if (item.source !== "official" && item.source !== "project") return;      // only what can be fetched again later
  try {
    const list = recentItems(kind).filter((r) => r.id !== item.id);
    list.unshift({ id: item.id, name: item.name, description: item.description, keywords: item.keywords, library: item.library, units: item.units, power: item.power,
      reference: item.reference, footprint: item.footprint, pads: item.pads, source: item.source });
    localStorage.setItem(recentKey(kind), JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch { /* storage unavailable */ }
}
