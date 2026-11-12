// library.ts — where the assistant gets parts it has not seen on the sheet yet: KiCad's official
// symbol and footprint libraries (through the server's /api/kicad-lib), and vendor parts with their
// own drawings (through /api/parts).  Everything here is read-only and cached for the session; the
// proposal builder turns what it returns into ordinary changes.
import { K, ToolError } from "./design";

const W = window as any;
const SCH = () => W.CollabTools && W.CollabTools.sch;
const PCB = () => W.PcbTools;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

async function getJson(url: string, what: string): Promise<any> {
  let resp: Response;
  try { resp = await fetch(url, { credentials: "same-origin" }); } catch { throw new ToolError(`${what}: the server could not be reached.`); }
  if (resp.status === 404) throw new ToolError(`${what}: not found.`);
  let body: any = null; try { body = await resp.json(); } catch { /* not json */ }
  if (!resp.ok) throw new ToolError(`${what}: ${(body && body.message) || `the server answered ${resp.status}`}`);
  return body;
}
/** read_datasheet: the pages of a PDF that answer a query; the server fetches and indexes the file once for everybody. */
export async function readDatasheet(i: { url?: string; query?: string; pages?: number[]; max_pages?: number }): Promise<any> {
  const url = String((i && i.url) || "").trim();
  if (!url) throw new ToolError("read_datasheet needs the url of the PDF.");
  let resp: Response;
  try { resp = await fetch("/api/ai/datasheet", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, query: i.query, pages: i.pages, max_pages: i.max_pages }) }); }
  catch { throw new ToolError("The datasheet reader could not be reached."); }
  let body: any = null; try { body = await resp.json(); } catch { /* not json */ }
  if (!resp.ok) throw new ToolError((body && body.message) || `The datasheet could not be read (${resp.status}).`);
  return body;
}
const cache = new Map<string, Promise<any>>();
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) { p = make(); cache.set(key, p); p.catch(() => cache.delete(key)); }
  return p as Promise<T>;
}

export function splitId(id: string, what: string): [string, string] {
  const cut = typeof id === "string" ? id.indexOf(":") : -1;
  if (cut <= 0 || cut === id.length - 1) throw new ToolError(`${what} must be written Library:Name, for example ${what === "footprint" ? "Resistor_SMD:R_0402_1005Metric" : "Device:R"}.`);
  return [id.slice(0, cut), id.slice(cut + 1)];
}

// ---------------------------------------------------------------- KiCad's libraries

const libList = (kind: "symbol" | "footprint", lib?: string) =>
  once(`list:${kind}:${lib || ""}`, () => getJson(`/api/kicad-lib/list?kind=${kind}${lib ? `&lib=${encodeURIComponent(lib)}` : ""}`, lib ? `KiCad ${kind} library ${lib}` : `KiCad's ${kind} libraries`));
const libItem = (kind: "symbol" | "footprint", lib: string, name: string) =>
  once(`item:${kind}:${lib}:${name}`, () => getJson(`/api/kicad-lib/item?kind=${kind}&lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(name)}`, `${kind} ${lib}:${name}`));

/** One library symbol as its own node, with a derived symbol ("extends") folded into its parent's drawing. */
async function rawSymbol(lib: string, name: string, depth = 0): Promise<any> {
  const k = K(); const it = await libItem("symbol", lib, name);
  const root = k.parse(it.sexpr); const node = root && k.kids(root, "symbol").find((s: any) => k.str(s[1]) === name);
  if (!node) throw new ToolError(`symbol ${lib}:${name}: the library file could not be read.`);
  const ext = k.kid(node, "extends");
  if (!ext) return node;
  if (depth > 4) throw new ToolError(`symbol ${lib}:${name}: its chain of parent symbols is too long.`);
  const parentName = k.str(ext[1]); const parent = k.cloneNode(await rawSymbol(lib, parentName, depth + 1));
  parent[1] = name;
  for (const c of parent) if (Array.isArray(c) && c[0] === "symbol" && typeof c[1] === "string" && c[1].startsWith(parentName + "_")) c[1] = name + c[1].slice(parentName.length);
  for (const p of k.kids(node, "property")) {   // the child's fields replace the parent's of the same name
    const at = parent.findIndex((c: any) => Array.isArray(c) && c[0] === "property" && k.str(c[1]) === k.str(p[1]) && (k.str(p[1]) !== "private" || k.str(c[2]) === k.str(p[2])));   // private notes are told apart by their own name
    if (at >= 0) parent[at] = p;
    else { const last = parent.map((c: any, i: number) => (Array.isArray(c) && c[0] === "property" ? i : -1)).filter((i: number) => i >= 0).pop(); parent.splice((last === undefined ? 1 : last) + 1, 0, p); }
  }
  return parent;
}

/** A KiCad library symbol in the form a sheet embeds it: named by its library id. */
export function kicadSymbol(libId: string): Promise<any> {
  const [lib, name] = splitId(libId, "lib_id");
  return once(`sheet-symbol:${libId}`, async () => { const n = K().cloneNode(await rawSymbol(lib, name)); n[1] = libId; return n; });
}
/** A KiCad library footprint's file text. */
export async function kicadFootprint(fpid: string): Promise<string> {
  const [lib, name] = splitId(fpid, "footprint");
  return (await libItem("footprint", lib, name)).sexpr as string;
}

// ---------------------------------------------------------------- vendor parts

export interface VendorPart { vendor: string; vendor_id: string; mpn: string; manufacturer: string; description: string; package: string; datasheet: string; fields: Record<string, string>; cad: any }
export const vendorPart = (vendor: string, id: string): Promise<VendorPart> =>
  once(`part:${vendor}:${id}`, () => getJson(`/api/parts/part?vendor=${encodeURIComponent(vendor)}&id=${encodeURIComponent(id)}`, `${vendor} part ${id}`));

/** A vendor part's symbol in sheet form (named by its library id), plus the fields a placed symbol carries. */
export async function vendorSymbol(vendor: string, id: string): Promise<{ libId: string; node: any; fields: Record<string, string>; value: string }> {
  const part = await vendorPart(vendor, id); const sym = part.cad && part.cad.symbol;
  if (!sym) throw new ToolError(`${vendor} part ${id} has no schematic symbol; use a KiCad library symbol with its Footprint and part number fields instead.`);
  const node = K().parse(sym.sexpr); if (!node) throw new ToolError(`${vendor} part ${id}: its symbol could not be read.`);
  node[1] = sym.lib_id;
  const fields: Record<string, string> = Object.assign({}, part.fields, part.datasheet ? { Datasheet: part.datasheet } : {}, part.cad.footprint ? { Footprint: part.cad.footprint.fpid } : {});
  return { libId: sym.lib_id, node, fields, value: part.mpn || sym.name };
}

// ---------------------------------------------------------------- what a part looks like, before it is placed

const SCRATCH_SCH = '(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "00000000-0000-4000-8000-000000000000") (paper "A4") (lib_symbols))';
const SCRATCH_PCB = '(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0"))';

/** Pins of a library symbol placed at the origin, unrotated: where a wire has to end, relative to the symbol's position. */
export function symbolFacts(libId: string, node: any): unknown {
  const k = K(); const s = SCH(); if (!s) throw new ToolError("The schematic tools are not loaded.");
  const scratch = k.parseDoc(SCRATCH_SCH, "kicad_sch"); scratch.lib.set(libId, node);
  const unitNames = new Set<number>();
  for (const c of node) if (Array.isArray(c) && c[0] === "symbol") { const m = /_(\d+)_(\d+)$/.exec(k.str(c[1])); if (m && +m[1] > 0) unitNames.add(+m[1]); }
  const units = Array.from(unitNames).sort((a, b) => a - b); if (!units.length) units.push(1);
  const prop = (name: string) => { const p = k.kids(node, "property").find((q: any) => k.str(q[1]) === name); return p ? k.str(p[2]) : ""; };
  const out: any = { lib_id: libId, reference_prefix: prop("Reference"), value: prop("Value"), footprint: prop("Footprint") || undefined, datasheet: prop("Datasheet") || undefined,
    description: prop("Description") || prop("ki_description") || undefined, footprint_filters: prop("ki_fp_filters") || undefined, power_symbol: !!k.kid(node, "power") || undefined, units: [] as any[] };
  for (const u of units) {
    const sn = s._.symbolNode(scratch, libId, [0, 0], 0, ""); const un = k.kid(sn, "unit"); if (un) un[1] = u;
    const item = k.addItem(scratch, sn);
    const pins = s._.symbolPins(scratch, item).map((p: any) => ({ number: p.number, name: p.name === "~" ? "" : p.name, type: p.type, dx: r3(p.x), dy: r3(p.y), hidden: p.hidden || undefined }));
    out.units.push({ unit: u, body_box: item.bbox ? item.bbox.map(r3) : undefined, pins });
    scratch.items.delete(item.id);
  }
  out.note = "dx, dy are each pin's connection point relative to the symbol's x, y at rotation 0 (Y points down). At rotation 90 the point is (dy, -dx), at 180 (-dx, -dy), at 270 (-dy, dx); KiCad rotates counter-clockwise. body_box is the drawing's extent at rotation 0.";
  return out;
}

/** Pads and extent of a library footprint at the origin, unrotated, on the front. */
export function footprintFacts(fpid: string, sexpr: string): unknown {
  const k = K(); const P = PCB(); if (!P) throw new ToolError("The board tools are not loaded.");
  const node = footprintNode(fpid, sexpr, "REF**", "", {});
  const scratch = k.parseDoc(SCRATCH_PCB, "kicad_pcb"); const item = k.addItem(scratch, node);
  const pads = P.padsOf(item).map((p: any) => ({ number: p.number, type: p.type, dx: r3(p.x), dy: r3(p.y), size: [r3(p.w), r3(p.h)] }));
  let cy: number[] | null = null;
  try { const c = P.courtyards(scratch).find((q: any) => q.id === item.id || q.item === item); if (c && c.bbox) cy = c.bbox.map(r3); } catch { /* no courtyard maths */ }
  return { footprint: fpid, pads: pads.length, through_hole: pads.some((p: any) => p.type === "thru_hole"), extent_box: item.bbox ? item.bbox.map(r3) : undefined, courtyard_box: cy || undefined,
    pad_list: pads.length <= 80 ? pads : pads.slice(0, 80).concat([{ note: `${pads.length - 80} more pads` } as any]) };
}

/**
 * A library footprint (.kicad_mod) as a board item node at the origin on the front: named by its
 * library id, with ids, its Reference and Value set, extra fields hidden, and each pad on the net
 * `nets` names for its number.  The caller rotates, flips and moves it into place.
 */
export function footprintNode(fpid: string, sexpr: string, ref: string, value: string, fields: Record<string, string>, nets?: (pad: string) => any[] | null): any {
  const k = K(); const src = k.parse(sexpr);
  if (!src || (src[0] !== "footprint" && src[0] !== "module")) throw new ToolError(`footprint ${fpid}: the library file could not be read.`);
  const out: any[] = ["footprint", fpid]; const uuid = () => ["uuid", k.newUuid()]; let placed = false;
  const place = () => { if (!placed) { out.push(uuid(), ["at", 0, 0]); placed = true; } };
  const seen = new Set<string>();
  for (const c of src.slice(2)) {
    if (!Array.isArray(c)) continue;
    const key = c[0];
    if (key === "version" || key === "generator" || key === "generator_version" || key === "uuid" || key === "at" || key === "tedit" || key === "tstamp") continue;
    const node = k.cloneNode(c);
    if (key === "layer") { out.push(node); place(); continue; }
    place();
    if (key === "property") {
      const name = k.str(node[1]); seen.add(name);
      if (name === "Reference") node[2] = ref; else if (name === "Value") node[2] = value || k.str(node[2]); else if (name in fields) node[2] = fields[name];
    }
    if ((key === "property" || key === "pad" || String(key).startsWith("fp_")) && !k.kid(node, "uuid")) node.push(uuid());
    if (key === "pad" && nets) { const i = node.findIndex((q: any) => Array.isArray(q) && q[0] === "net"); if (i >= 0) node.splice(i, 1); const n = nets(k.str(node[1])); if (n) node.push(n); }
    out.push(node);
  }
  place();
  for (const [name, v] of Object.entries(fields)) {
    if (seen.has(name) || !v || name === "Reference" || name === "Value" || name === "Footprint") continue;
    out.push(["property", name, v, ["at", 0, 0, 0], ["layer", "F.Fab"], ["hide", "yes"], uuid(), ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]]]);
  }
  return out;
}

// ---------------------------------------------------------------- the tools

const words = (q: string) => q.toLowerCase().split(/[\s,]+/).filter(Boolean);
const matches = (name: string, ws: string[]) => { const n = name.toLowerCase(); return ws.every((w) => n.includes(w)); };

/** find_parts: KiCad libraries and their items by name, and vendor parts by what they are. */
export async function findParts(input: { query?: string; kind?: string; library?: string; vendor?: string }): Promise<unknown> {
  const kind = input.kind === "footprint" ? "footprint" : "symbol"; const ws = words(String(input.query || "")); const out: any = { kind };
  if (input.library) {
    const l = await libList(kind, String(input.library)); const hit = (l.items as string[]).filter((n) => matches(n, ws));
    out.library = l.library; out.count = hit.length; out.items = hit.slice(0, 150).map((n) => `${l.library}:${n}`);
    if (hit.length > 150) out.note = `${hit.length - 150} more; narrow the query.`;
    return out;
  }
  if (!ws.length) throw new ToolError("Give a query (words of the library, part number or part name), or a library to list.");
  const libs = (await libList(kind)).libraries as string[];
  out.libraries = libs.filter((n) => ws.some((w) => n.toLowerCase().includes(w))).slice(0, 30);
  try {   // every library at once; the first search after a server start takes about half a minute
    const r = await once(`search:${kind}:${ws.join(" ")}`, () => getJson(`/api/kicad-lib/search?kind=${kind}&q=${encodeURIComponent(ws.join(" "))}`, "KiCad library search"));
    out.items = r.items; if (r.total > r.items.length) out.more_items = r.total - r.items.length;
  } catch (e) { out.library_search_error = e instanceof Error ? e.message : String(e); }
  out.note = "libraries are KiCad's own; list one with library to see everything in it. Common ids: Device:R, Device:C, Device:C_Polarized, Device:L, Device:LED, Device:D, Device:Crystal_GND24, Switch:SW_Push, Connector_Generic:Conn_01xNN, power:GND, power:+3V3, power:+5V, power:VBUS, power:PWR_FLAG.";
  if (kind === "symbol" && input.vendor !== "none") {
    try {
      const v = await getJson(`/api/parts/search?q=${encodeURIComponent(String(input.query))}${input.vendor ? `&vendor=${encodeURIComponent(input.vendor)}` : ""}`, "vendor search");
      out.vendor_parts = (v.results || []).slice(0, 15).map((p: any) => ({ vendor: p.vendor, id: p.vendor_id, mpn: p.mpn, manufacturer: p.manufacturer, description: (p.description || "").slice(0, 140), package: p.package, stock: p.stock,
        unit_price: p.prices && p.prices[0] ? `${p.prices[0].price} ${p.prices[0].currency}` : undefined, assembly: p.assembly || undefined, datasheet: p.datasheet || undefined }));
      if (v.errors && v.errors.length) out.vendor_errors = v.errors.map((e: any) => e.message);
    } catch (e) { out.vendor_errors = [e instanceof Error ? e.message : String(e)]; }
  }
  return out;
}

/** get_library_part: pins of a symbol or pads of a footprint, before it is on the design. */
export async function getLibraryPart(input: { id?: string; kind?: string; vendor?: string }): Promise<unknown> {
  if (input.vendor) {
    const id = String(input.id || ""); const part = await vendorPart(input.vendor, id); const out: any = { vendor: part.vendor, id: part.vendor_id, mpn: part.mpn, manufacturer: part.manufacturer, description: part.description, package: part.package, datasheet: part.datasheet || undefined, fields: part.fields };
    if (part.cad && part.cad.symbol) { const s = await vendorSymbol(input.vendor, id); out.symbol = symbolFacts(s.libId, s.node); }
    if (part.cad && part.cad.footprint) out.footprint = footprintFacts(part.cad.footprint.fpid, part.cad.footprint.sexpr);
    return out;
  }
  const id = String(input.id || "");
  if (input.kind === "footprint") return footprintFacts(id, await kicadFootprint(id));
  return symbolFacts(id, await kicadSymbol(id));
}
