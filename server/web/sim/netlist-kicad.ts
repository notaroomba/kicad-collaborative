// sim/netlist-kicad — the KiCad (s-expression) and Allegro netlists of File > Export > Netlist, pure:
//   KiCad    NETLIST_EXPORTER_KICAD::Format( GNL_ALL | GNL_OPT_KICAD ) over NETLIST_EXPORTER_XML::makeRoot: (export
//            (version "E") (design …) (components …) (groups …) (variants …) (libparts …) (libraries …) (nets …)),
//            an XNODE tree written by XNODE::Format and run through KICAD_FORMAT::Prettify.
//   Allegro  NETLIST_EXPORTER_ALLEGRO: (NETLIST) … $PACKAGES / $A_PROPERTIES / $NETS / $END, plus one device file per
//            package (devices/<device>.txt).
// Both walk the sheet instances in hierarchy order and, on each sheet, its symbols by reference (StrNumCmp, no case),
// the unit with the lowest uuid standing for its package (findNextSymbol); "#" references and symbols excluded from
// the board are left out.  Nets come from the hierarchy's net map (canvas/pcb-netlist buildNetlist().netMap).
import type { Netlist, NetEntry, SheetInstance } from "../canvas/pcb-netlist";
import { prettify } from "../canvas/prettify";
import { strNumCmp as strNumCmpCase } from "../canvas/variant-model";
import { symbolFlags, symbolFlagsForVariant, symbolVariant, type SymFlags } from "../canvas/variant-model";

type N = SNode;
const isList = Array.isArray;
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kidOf = (n: N | null | undefined, key: string): N | null => { if (!n) return null; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return c as N; } return null; };
const kidsOf = (n: N | null | undefined, key: string): N[] => (n ? (n.filter((c) => isList(c) && c[0] === key) as N[]) : []);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const yesOf = (k: N | null, dflt: boolean): boolean => (k ? k.length < 2 || /^(yes|true)$/.test(sv(k[1])) : dflt);

/** StrNumCmp (common/string_utils.cpp): runs of digits compare by value; `ignoreCase` upper-cases first. */
export function strNumCmp(a: string, b: string, ignoreCase = false): number {
  return ignoreCase ? strNumCmpCase(a.toUpperCase(), b.toUpperCase()) : strNumCmpCase(a, b);
}

/** GetISO8601CurrentDateTime: wxDateTime::Now().FormatISOCombined( 'T' ), local time, no zone. */
export function iso8601Local(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** UnescapeString: {slash} {backslash} {lt} {gt} {colon} {dquote} {space} {tab} {return} {brace} back to characters. */
export function unescapeString(s: string): string {
  if (s.indexOf("{") < 0) return s;
  const map: Record<string, string> = { slash: "/", backslash: "\\", lt: "<", gt: ">", colon: ":", dquote: '"', quote: "'", space: " ", tab: "\t", return: "\n", brace: "{", comma: "," };
  return s.replace(/\{(slash|backslash|lt|gt|colon|dquote|quote|space|tab|return|brace|comma)\}/g, (_m, k: string) => map[k]);
}

/** ExpandStackedPinNotation: "[1-3,5]" → 1, 2, 3, 5 (a prefix may lead the numbers: "[A1-A4]"); `valid` false when
 *  the brackets or a range are malformed (the text is then kept whole). */
export function expandStackedPins(pin: string): { nums: string[]; valid: boolean } {
  const open = pin.includes("["), close = pin.includes("]");
  if (open || close) { if (!pin.startsWith("[") || !pin.endsWith("]")) return { nums: [pin], valid: false }; }
  if (!pin.startsWith("[") || !pin.endsWith("]")) return { nums: [pin], valid: true };
  const out: string[] = [];
  for (let part of pin.slice(1, -1).split(",")) {
    part = part.trim(); if (!part) continue;
    const dash = part.indexOf("-");
    if (dash >= 0) {
      const a = /^(.*?)(\d+)$/.exec(part.slice(0, dash).trim()), b = /^(.*?)(\d+)$/.exec(part.slice(dash + 1).trim());
      if (!a || !b || a[1] !== b[1] || +a[2] > +b[2]) return { nums: [pin], valid: false };
      for (let v = +a[2]; v <= +b[2]; v++) out.push(a[1] + v);
    } else out.push(part);
  }
  return { nums: out, valid: true };
}

// ---------------------------------------------------------------- the library symbol as the exporters read it
export interface LibPin { number: string; name: string; type: string; unit: number; bodyStyle: number; x: number; y: number }
export interface LibInfo {
  libId: string; nickname: string; name: string; unitCount: number; unitNames: Map<number, string>;
  pins: LibPin[]; fields: { name: string; value: string }[]; description: string; keywords: string; fpFilters: string[];
  duplicatePinsAreJumpers: boolean; jumperGroups: string[][];
}
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
/** The (property [private] "name" "value") parts of a field node. */
export function fieldParts(p: N): { name: string; value: string; priv: boolean } {
  const priv = sv(p[1]) === "private" && p.length > 3 && !isList(p[3]);
  return priv ? { name: sv(p[2]), value: sv(p[3]), priv } : { name: sv(p[1]), value: sv(p[2]), priv };
}
/** The cached lib symbol: its units, pins (unit / body style / position), fields, keywords and footprint filters. */
export function libInfo(lib: N): LibInfo {
  const libId = sv(lib[1]), colon = libId.indexOf(":");
  const pins: LibPin[] = [], unitNames = new Map<number, string>();
  let unitCount = 1;
  for (const sub of kidsOf(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); const unit = m ? +m[1] : 0, body = m ? +m[2] : 0;
    if (unit > unitCount) unitCount = unit;
    const un = kidOf(sub, "unit_name"); if (un && unit) unitNames.set(unit, sv(un[1]));
    for (const p of kidsOf(sub, "pin")) {
      const at = kidOf(p, "at") || ["at", 0, 0];
      const name = sv((kidOf(p, "name") || [])[1]), number = sv((kidOf(p, "number") || [])[1]);
      // the file's Y is up; SCH_PIN::GetPosition is in the internal Y-down frame
      pins.push({ number, name: name === "~" ? "" : name, type: sv(p[1]), unit, bodyStyle: body, x: +sv(at[1]) || 0, y: -(+sv(at[2]) || 0) });
    }
  }
  const fields: { name: string; value: string }[] = []; let description = "", keywords = "", fpFilters: string[] = [];
  for (const p of kidsOf(lib, "property")) {
    const f = fieldParts(p);
    if (f.name === "ki_keywords") { keywords = f.value; continue; }
    if (f.name === "ki_fp_filters") { fpFilters = f.value.split(/\s+/).filter(Boolean); continue; }
    if (f.name === "ki_description") { description = f.value; continue; }
    if (f.name === "Description") description = f.value;
    fields.push({ name: f.name, value: f.value });
  }
  const jg = kidOf(lib, "jumper_pin_groups");
  return { libId, nickname: colon >= 0 ? libId.slice(0, colon) : "", name: colon >= 0 ? libId.slice(colon + 1) : libId, unitCount, unitNames, pins, fields, description, keywords, fpFilters,
    duplicatePinsAreJumpers: yesOf(kidOf(lib, "duplicate_pin_numbers_are_jumpers"), false), jumperGroups: jg ? (jg.slice(1).filter(isList) as N[]).map((g) => g.map(sv)) : [] };
}
/** LETTER subreference of a unit (LIB_SYMBOL::LetterSubReference): A…Z, then AA… */
export function unitLetter(unit: number): string {
  let s = "", u = unit;
  while (u > 0) { u--; s = String.fromCharCode(65 + (u % 26)) + s; u = Math.floor(u / 26); }
  return s;
}
/** GetGraphicalPins( unit, bodyStyle ): the unit's own and the common pins (0 = every unit / style). */
const graphicalPins = (li: LibInfo, unit: number, body: number): LibPin[] => li.pins.filter((p) => (!unit || !p.unit || p.unit === unit) && (!body || !p.bodyStyle || p.bodyStyle === body));
/** LIB_SYMBOL::GetUnitPinInfo: each unit's display name and its pin numbers (by position, stacked pins expanded). */
export function unitPinInfo(li: LibInfo): { name: string; pins: string[] }[] {
  const out: { name: string; pins: string[] }[] = [];
  for (let u = 1; u <= Math.max(li.unitCount, 1); u++) {
    const list = graphicalPins(li, u, 0).slice().sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
    const seen = new Set<string>(), pins: string[] = [];
    for (const p of list) {
      const e = expandStackedPins(p.number);
      const nums = e.valid && e.nums.length ? e.nums : [p.number];
      for (const n of nums) if (!seen.has(n)) { seen.add(n); pins.push(n); }
    }
    out.push({ name: li.unitNames.get(u) || unitLetter(u), pins });
  }
  return out;
}

// ---------------------------------------------------------------- the hierarchy's symbols
export interface NlSheet {
  index: number; uuidPath: string[]; human: string; file: string; doc: KDoc;
  /** the (sheet …) item that instantiates this sheet; null for the root */
  sheetNode: N | null;
  /** the instance's page number */
  page?: string;
}
/** SCH_SHEET::ComparePageNum: integers by value and before anything else, the rest by StrNumCmp. */
export function comparePageNum(a: string, b: string): number {
  if (a === b) return 0;
  const ia = /^[+-]?\d+$/.test(a.trim()), ib = /^[+-]?\d+$/.test(b.trim());
  if (ia && ib) return parseInt(a, 10) < parseInt(b, 10) ? -1 : 1;
  if (ia) return -1; if (ib) return 1;
  return strNumCmp(a, b) || cmp(a, b);
}
export interface NlInput {
  sheets: NlSheet[];
  netlist: Netlist;
  /** the root schematic's file name, as SCHEMATIC::GetFileName gives it */
  source: string;
  date: string;
  /** GetBuildVersion() */
  version: string;
  /** the project's text variables (.kicad_pro text_variables) */
  textVars?: Record<string, string>;
  /** SCHEMATIC::GetVariantNames with their descriptions */
  variants?: { name: string; description: string }[];
  /** the library table's URI of a symbol library nickname */
  libUri?(nickname: string): string | null;
  /** the root sheet's name (the .kicad_pro "sheets" entry of the root uuid) */
  rootSheetName?: string;
  /** NET_SETTINGS::GetEffectiveNetClass( net )->GetName() */
  netClass?(net: string): string;
}

interface Sym {
  sheet: NlSheet; item: KItem; node: N; uuid: string; ref: string; unit: number; lib: LibInfo | null; path: string; flags: SymFlags;
}
const instPath = (s: NlSheet): string => "/" + s.uuidPath.join("/");
/** SCH_SHEET_PATH::PathAsString: "/" then each sheet uuid below the root followed by "/". */
const pathAsString = (s: NlSheet): string => "/" + s.uuidPath.slice(1).map((u) => u + "/").join("");

function symbolsOf(sheet: NlSheet, libCache: Map<string, LibInfo>): Sym[] {
  const out: Sym[] = [];
  for (const it of sheet.doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const n = it.node;
    let ref = "", unit = Math.round(+sv((kidOf(n, "unit") || [])[1])) || 1;
    for (const p of kidsOf(n, "property")) { const f = fieldParts(p); if (f.name === "Reference") ref = f.value; }
    for (const pr of kidsOf(kidOf(n, "instances"), "project")) for (const p of kidsOf(pr, "path")) if (sv(p[1]) === instPath(sheet)) {
      const r = kidOf(p, "reference"); if (r) ref = sv(r[1]); const u = kidOf(p, "unit"); if (u) unit = Math.round(+sv(u[1])) || unit;
    }
    const libName = sv((kidOf(n, "lib_name") || kidOf(n, "lib_id") || [])[1]);
    const key = sheet.index + "|" + libName;
    let lib = libCache.get(key) || null;
    if (!lib) { const ln = sheet.doc.lib.get(libName); if (ln) { lib = libInfo(ln); libCache.set(key, lib); } }
    out.push({ sheet, item: it, node: n, uuid: sv((kidOf(n, "uuid") || [])[1]) || it.id, ref, unit, lib, path: instPath(sheet), flags: symbolFlags(n) });
  }
  return out;
}

/** The sheet item's flags (SCH_SHEET_PATH::GetExcludedFromBOM / Board / Sim, GetDNP): any sheet on the path. */
function sheetFlags(sheets: NlSheet[], s: NlSheet, variant = ""): SymFlags {
  const f: SymFlags = { dnp: false, excludedFromSim: false, excludedFromBOM: false, excludedFromBoard: false, excludedFromPosFiles: false };
  // the ancestors of s: the sheets whose uuid path is a prefix
  for (const a of sheets) {
    if (!a.sheetNode || a.uuidPath.length > s.uuidPath.length || !a.uuidPath.every((u, i) => s.uuidPath[i] === u)) continue;
    // the sheet symbol lives in the parent sheet's file (its version gives the variant in_bom's meaning)
    const parent = sheets.find((p) => p.uuidPath.length === a.uuidPath.length - 1 && p.uuidPath.every((u, i) => a.uuidPath[i] === u));
    const g = variant ? symbolFlagsForVariant(a.sheetNode, variant, "/" + a.uuidPath.slice(0, -1).join("/"), parent ? parent.doc.version : undefined) : symbolFlags(a.sheetNode);
    f.dnp = f.dnp || g.dnp; f.excludedFromSim = f.excludedFromSim || g.excludedFromSim; f.excludedFromBOM = f.excludedFromBOM || g.excludedFromBOM; f.excludedFromBoard = f.excludedFromBoard || g.excludedFromBoard;
  }
  return f;
}

/** The exporters' symbol walk: per sheet, ordered by reference (the lowest uuid standing for a reference on a
 *  sheet, the others its extra units), findNextSymbol's checks. */
function walkSymbols(inp: NlInput, excluded: (s: Sym) => boolean): { sym: Sym; extra: Sym[]; all: Sym[] }[] {
  const libCache = new Map<string, LibInfo>(), out: { sym: Sym; extra: Sym[]; all: Sym[] }[] = [], found = new Set<string>();
  const perSheet = inp.sheets.map((s) => symbolsOf(s, libCache)), all = perSheet.flat();
  inp.sheets.forEach((_s, si) => {
    const ordered = new Map<string, Sym>(), extra = new Map<string, Sym[]>();
    const key = (r: string): string => r.toUpperCase();
    for (const s of perSheet[si]) {
      if (excluded(s)) continue;
      const k = key(s.ref), have = ordered.get(k);
      if (!have) { ordered.set(k, s); continue; }
      const l = extra.get(k) || []; extra.set(k, l);
      if (have.uuid > s.uuid) { l.push(have); ordered.set(k, s); } else l.push(s);
    }
    const syms = [...ordered.values()].sort((a, b) => strNumCmp(a.ref, b.ref, true));
    for (const s of syms) {
      if (!s.ref || s.ref.startsWith("#")) continue;
      if (!s.lib) continue;
      if (s.lib.unitCount > 1) { if (found.has(s.ref)) continue; found.add(s.ref); }
      out.push({ sym: s, extra: (extra.get(key(s.ref)) || []).slice().sort((a, b) => strNumCmp(a.ref, b.ref, true)), all });
    }
  });
  return out;
}

const fieldValue = (n: N, name: string): string => { for (const p of kidsOf(n, "property")) { const f = fieldParts(p); if (f.name === name) return f.value; } return ""; };
/** The symbol's field texts for a variant (SCH_SYMBOL::GetFieldText( name, sheet, variant )). */
function fieldsFor(s: Sym, variant: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of kidsOf(s.node, "property")) { const f = fieldParts(p); m.set(f.name, f.name === "Reference" ? s.ref : f.value); }
  if (variant) { const st = symbolVariant(s.node, variant, s.path, s.sheet.doc.version); if (st) for (const [k, v] of st.fields) if (m.has(k)) m.set(k, v); }
  return m;
}
/** GetShownText: ${FIELD}, ${REFERENCE}, ${VALUE}, ${FOOTPRINT}, ${UNIT}, the sheet's fields and the project's
 *  text variables resolved (a name nothing defines stays as written). */
function resolver(s: Sym, inp: NlInput, fields: Map<string, string>): (t: string) => string {
  const sheetFields = new Map<string, string>();
  if (s.sheet.sheetNode) for (const p of kidsOf(s.sheet.sheetNode, "property")) { const f = fieldParts(p); sheetFields.set(f.name.toUpperCase(), f.value); }
  const tv = inp.textVars || {};
  const one = (name: string): string | undefined => {
    const up = name.toUpperCase();
    if (up === "REFERENCE") return s.ref;
    if (up === "UNIT") return s.lib && s.lib.unitCount > 1 ? unitLetter(s.unit) : "";
    for (const [k, v] of fields) if (k.toUpperCase() === up) return v;
    if (up === "SHEETNAME") return s.sheet.sheetNode ? sheetFields.get("SHEETNAME") : "";
    if (sheetFields.has(up)) return sheetFields.get(up);
    if (Object.prototype.hasOwnProperty.call(tv, name)) return tv[name];
    return undefined;
  };
  const go = (t: string, depth: number): string => (depth > 10 || t.indexOf("${") < 0 ? t : t.replace(/\$\{([^}]+)\}/g, (m, nm: string) => { const v = one(nm); return v === undefined ? m : go(v, depth + 1); }));
  return (t) => go(t, 0);
}

// ---------------------------------------------------------------- rule areas (SCH_RULE_AREA)
type P = [number, number];
const polyOf = (ra: N): P[] => ((kidOf(kidOf(ra, "polyline"), "pts") || []).filter((c) => isList(c) && c[0] === "xy") as N[]).map((c) => [+sv(c[1]), +sv(c[2])] as P);
function inPoly(pt: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
/** SHAPE_POLY_SET::Collide( SHAPE_RECT ): the rectangle touches the polygon's inside or edge. */
function rectHitsPoly(r: [number, number, number, number], poly: P[]): boolean {
  if (poly.length < 3) return false;
  const corners: P[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  if (corners.some((c) => inPoly(c, poly))) return true;
  if (poly.some((v) => v[0] >= r[0] && v[0] <= r[2] && v[1] >= r[1] && v[1] <= r[3])) return true;
  for (let i = 0; i < poly.length; i++) for (let k = 0; k < 4; k++) if (segsCross(poly[i], poly[(i + 1) % poly.length], corners[k], corners[(k + 1) % 4])) return true;
  return false;
}
/** The rule areas whose polygon collides with the item's bounding box (SCH_RULE_AREA::RefreshContainedItemsAndDirectives
 *  for a symbol or a sheet: the item's m_rule_areas_cache). */
export function ruleAreasAround(doc: KDoc, item: KItem): KItem[] {
  if (!item.bbox) return [];
  const out: KItem[] = [];
  for (const ra of doc.items.values()) if (ra.kind === "rule_area" && rectHitsPoly(item.bbox, polyOf(ra.node))) out.push(ra);
  return out;
}
/** The "Component Class" values of the directive labels on the border of every rule area around `item`
 *  (RefreshContainedItemsAndDirectives: a label whose connection point is on the polygon's edge). */
export function ruleAreaClasses(doc: KDoc, item: KItem): string[] {
  const out: string[] = [];
  if (!item.bbox) return out;
  const items = [...doc.items.values()];
  for (const ra of items) {
    if (ra.kind !== "rule_area") continue;
    const poly = polyOf(ra.node); if (!rectHitsPoly(item.bbox, poly)) continue;
    for (const dl of items) {
      if (dl.kind !== "netclass_flag" && dl.kind !== "directive_label") continue;
      const at = kidOf(dl.node, "at"); if (!at) continue;
      const p: P = [+sv(at[1]), +sv(at[2])];
      if (!poly.some((v, i) => segDist(p, v, poly[(i + 1) % poly.length]) <= 1e-4)) continue;
      for (const f of kidsOf(dl.node, "property")) { const fp = fieldParts(f); if (fp.name === "Component Class" && fp.value) out.push(fp.value); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- XNODE
interface XN { name: string; attrs: [string, string][]; kids: XN[]; text: string[] }
const xn = (name: string, text?: string): XN => ({ name, attrs: [], kids: [], text: text !== undefined && text.length > 0 ? [text] : [] });
const attr = (n: XN, k: string, v: string): XN => { n.attrs.push([k, v]); return n; };
const add = (p: XN, c: XN): XN => { p.kids.push(c); return c; };
/** OUTPUTFORMATTER::Quotew: always quoted, \ " and newlines escaped. */
const quotew = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
/** XNODE::Format: "(name" + " (attr value)"… + a newline before the first element child + children, a newline after
 *  every element that has a next sibling; text children as ' "text"'. */
function formatX(n: XN): string {
  let s = "(" + n.name;
  for (const [k, v] of n.attrs) s += ` (${k} ${quotew(v)})`;
  // texts are added before element children only for (tstamps …) and leaf nodes; they keep their order
  for (const t of n.text) s += " " + quotew(t);
  n.kids.forEach((c, i) => { if (i === 0) s += "\n"; s += formatX(c) + (i < n.kids.length - 1 ? ")\n" : ")"); });
  return s;
}
const finishX = (root: XN): string => prettify(formatX(root) + ")\n");

// ---------------------------------------------------------------- the KiCad netlist
export function kicadNetlist(inp: NlInput): string {
  const root = attr(xn("export"), "version", "E");
  // ---- design
  const design = add(root, xn("design"));
  add(design, xn("source", inp.source));
  add(design, xn("date", inp.date));
  add(design, xn("tool", "Eeschema " + inp.version));
  for (const [k, v] of Object.entries(inp.textVars || {}).sort((a, b) => cmp(a[0], b[0]))) attr(add(design, xn("textvar", v)), "name", k);
  inp.sheets.forEach((sh, i) => {
    const xs = add(design, xn("sheet")); attr(xs, "number", String(i + 1)); attr(xs, "name", sh.human); attr(xs, "tstamps", pathAsString(sh));
    const tb = ((sh.doc as unknown as { titleBlock?: Record<string, string> }).titleBlock) || {};
    const exp = (t: string): string => t.replace(/\$\{([^}]+)\}/g, (m, nm: string) => (inp.textVars && Object.prototype.hasOwnProperty.call(inp.textVars, nm) ? inp.textVars[nm] : m));
    const xt = add(xs, xn("title_block"));
    add(xt, xn("title", exp(tb.title || ""))); add(xt, xn("company", exp(tb.company || ""))); add(xt, xn("rev", exp(tb.rev || ""))); add(xt, xn("date", exp(tb.date || "")));
    add(xt, xn("source", sh.file.split("/").pop() || sh.file));
    for (let c = 1; c <= 9; c++) { const xc = add(xt, xn("comment")); attr(xc, "number", String(c)); attr(xc, "value", exp(tb["comment" + c] || "")); }
  });
  // ---- components
  const excluded = (s: Sym): boolean => s.flags.excludedFromBoard || sheetFlags(inp.sheets, s.sheet).excludedFromBoard;
  const walk = walkSymbols(inp, excluded);
  const comps = add(root, xn("components"));
  const libParts = new Map<string, LibInfo>();
  const variantNames = (inp.variants || []).map((v) => v.name);
  // getSheetComponentClasses: the classes of the rule areas around each sheet symbol, for everything below it
  const sheetClasses: [string[], Set<string>][] = [];
  for (const sh of inp.sheets) for (const it of sh.doc.items.values()) if (it.kind === "sheet") {
    const id = sv((kidOf(it.node, "uuid") || [])[1]) || it.id;
    sheetClasses.push([[...sh.uuidPath, id], new Set(ruleAreaClasses(sh.doc, it))]);
  }
  for (const { sym, extra, all } of walk) {
    if (sym.lib) libParts.set(sym.lib.libId, sym.lib);
    const xc = attr(add(comps, xn("comp")), "ref", sym.ref);
    // addSymbolFields
    const units = all.filter((o) => o.ref.toUpperCase() === sym.ref.toUpperCase());
    let value = "", footprint = "", datasheet = "", description = "";
    const fields = new Map<string, string>();
    const shown = (o: Sym, name: string): string => { const f = fieldsFor(o, ""); return resolver(o, inp, f)(f.get(name) || ""); };
    if (sym.lib && sym.lib.unitCount > 1) {
      const ranked = units.slice().sort((a, b) => a.unit - b.unit || cmp(a.uuid, b.uuid));
      const pick = (name: string): string => { for (const o of ranked) { const c = shown(o, name); if (c) return c; } return ""; };
      value = pick("Value"); footprint = pick("Footprint"); datasheet = pick("Datasheet"); description = pick("Description");
      const rank = new Map<string, [boolean, number]>();
      ranked.forEach((o, idx) => {
        for (const p of kidsOf(o.node, "property")) {
          const f = fieldParts(p); if (MANDATORY.includes(f.name) || f.priv) continue;
          const c = shown(o, f.name), r: [boolean, number] = [c === "", idx], k = rank.get(f.name);
          if (!k || r[0] < k[0] || (r[0] === k[0] && r[1] < k[1])) { fields.set(f.name, c); rank.set(f.name, r); }
        }
      });
    } else {
      value = shown(sym, "Value"); footprint = shown(sym, "Footprint"); datasheet = shown(sym, "Datasheet"); description = shown(sym, "Description");
      for (const p of kidsOf(sym.node, "property")) { const f = fieldParts(p); if (MANDATORY.includes(f.name) || f.priv) continue; fields.set(f.name, shown(sym, f.name)); }
    }
    fields.set("Footprint", footprint); fields.set("Datasheet", datasheet); fields.set("Description", description);
    add(xc, xn("value", value.length ? unescapeString(value) : "~"));
    if (footprint) add(xc, xn("footprint", unescapeString(footprint)));
    if (datasheet) add(xc, xn("datasheet", unescapeString(datasheet)));
    if (description) add(xc, xn("description", unescapeString(description)));
    const xf = add(xc, xn("fields"));
    for (const [k, v] of fields) attr(add(xf, xn("field", unescapeString(v))), "name", unescapeString(k));
    // libsource
    const libId = sv((kidOf(sym.node, "lib_id") || [])[1]), colon = libId.indexOf(":");
    const xl = add(xc, xn("libsource"));
    attr(xl, "lib", colon >= 0 ? libId.slice(0, colon) : ""); attr(xl, "part", colon >= 0 ? libId.slice(colon + 1) : libId);
    attr(xl, "description", shown(sym, "Description"));
    const prop = (name: string, value?: string): void => { const p = attr(add(xc, xn("property")), "name", name); if (value !== undefined) attr(p, "value", value); };
    for (const p of kidsOf(sym.node, "property")) { const f = fieldParts(p); if (MANDATORY.includes(f.name) || f.priv) continue; prop(f.name, shown(sym, f.name)); }
    // the sheet's fields (the root's: Sheetname "", Sheetfile <file>)
    if (sym.sheet.sheetNode) for (const p of kidsOf(sym.sheet.sheetNode, "property")) { const f = fieldParts(p); prop(f.name, f.value); }
    else { prop("Sheetname", inp.rootSheetName || ""); prop("Sheetfile", sym.sheet.file.split("/").pop() || sym.sheet.file); }
    const sf = sheetFlags(inp.sheets, sym.sheet), f = sym.flags;
    if (f.excludedFromBOM || sf.excludedFromBOM) prop("exclude_from_bom");
    if (f.excludedFromSim || sf.excludedFromSim) prop("exclude_from_sim");
    if (f.excludedFromBoard || sf.excludedFromBoard) prop("exclude_from_board");
    if (f.excludedFromPosFiles) prop("exclude_from_pos_files");
    if (f.dnp || sf.dnp) prop("dnp");
    if (variantNames.length) {
      let xvs: XN | null = null;
      for (const vn of variantNames) {
        let xv: XN | null = null;
        const put = (c: XN | null): void => { if (!c) return; if (!xv) xv = attr(xn("variant"), "name", vn); xv.kids.push(c); };
        const ef = symbolFlagsForVariant(sym.node, vn, sym.path, sym.sheet.doc.version), es = sheetFlags(inp.sheets, sym.sheet, vn);
        const bin = (name: string, base: boolean, eff: boolean): void => { if (base !== eff) { const p = attr(xn("property"), "name", name); attr(p, "value", eff ? "1" : "0"); put(p); } };
        bin("dnp", f.dnp || sf.dnp, ef.dnp || es.dnp);
        bin("exclude_from_bom", f.excludedFromBOM || sf.excludedFromBOM, ef.excludedFromBOM || es.excludedFromBOM);
        bin("exclude_from_sim", f.excludedFromSim || sf.excludedFromSim, ef.excludedFromSim || es.excludedFromSim);
        bin("exclude_from_pos_files", f.excludedFromPosFiles, ef.excludedFromPosFiles);
        const st = symbolVariant(sym.node, vn, sym.path, sym.sheet.doc.version);
        if (st && st.fields.size) {
          let xfs: XN | null = null;
          for (const [k, v] of st.fields) {
            if (v === (k === "Reference" ? sym.ref : fieldValue(sym.node, k))) continue;
            if (!xfs) xfs = xn("fields");
            attr(add(xfs, xn("field", unescapeString(resolver(sym, inp, fieldsFor(sym, vn))(v)))), "name", unescapeString(k));
          }
          put(xfs);
        }
        if (xv) { if (!xvs) xvs = xn("variants"); xvs.kids.push(xv); }
      }
      if (xvs) xc.kids.push(xvs);
    }
    if (sym.lib) {
      if (sym.lib.keywords) prop("ki_keywords", sym.lib.keywords);
      if (sym.lib.fpFilters.length) prop("ki_fp_filters", sym.lib.fpFilters.join(" "));
      if (sym.lib.duplicatePinsAreJumpers) add(xc, xn("duplicate_pin_numbers_are_jumpers", "1"));
      if (sym.lib.jumperGroups.length) { const xj = add(xc, xn("jumper_pin_groups")); for (const g of sym.lib.jumperGroups) { const xg = add(xj, xn("group")); for (const p of g) add(xg, xn("pin", p)); } }
    }
    const xsp = add(xc, xn("sheetpath")); attr(xsp, "names", sym.sheet.human); attr(xsp, "tstamps", pathAsString(sym.sheet));
    // component classes: the "Component Class" fields of every unit
    const classes = new Set<string>();
    const classUnits = [sym, ...(sym.lib && sym.lib.unitCount > 1 ? all.filter((o) => o.ref.toUpperCase() === sym.ref.toUpperCase() && o.unit !== sym.unit) : [])];
    for (const o of classUnits) {
      for (const p of kidsOf(o.node, "property")) { const fp = fieldParts(p); if (fp.name === "Component Class") { const t = shown(o, fp.name); if (t) classes.add(t); } }
      for (const c of ruleAreaClasses(o.sheet.doc, o.item)) classes.add(c);
      for (const [path, cs] of sheetClasses) if (path.length <= o.sheet.uuidPath.length && path.every((u, i) => o.sheet.uuidPath[i] === u)) for (const c of cs) classes.add(c);
    }
    if (classes.size) { const xcc = add(xc, xn("component_classes")); for (const c of [...classes].sort(cmp)) add(xcc, xn("class", unescapeString(c))); }
    const xts = add(xc, xn("tstamps")); for (const e of extra) xts.text.push(e.uuid); xts.text.push(sym.uuid);
    const xu = add(xc, xn("units"));
    if (sym.lib) for (const u of unitPinInfo(sym.lib)) { const x1 = attr(add(xu, xn("unit")), "name", u.name); const xp = add(x1, xn("pins")); for (const n of u.pins) attr(add(xp, xn("pin")), "num", n); }
  }
  // ---- groups
  const groups = add(root, xn("groups"));
  const visits = new Map<KDoc, number>(); for (const s of inp.sheets) visits.set(s.doc, (visits.get(s.doc) || 0) + 1);
  for (const sh of inp.sheets) {
    const prefix = pathAsString(sh);
    for (const it of sh.doc.items.values()) {
      if (it.kind !== "group") continue;
      const g = it.node; let name = typeof g[1] === "string" && !isList(g[1]) ? sv(g[1]) : "";
      if ((visits.get(sh.doc) || 0) > 1) name = `${name} (${sh.human})`;
      const xg = add(groups, xn("group")); attr(xg, "name", name); attr(xg, "uuid", prefix + sv((kidOf(g, "uuid") || [])[1])); attr(xg, "lib_id", sv((kidOf(g, "lib_id") || [])[1]));
      const xm = add(xg, xn("members"));
      for (const m of (kidOf(g, "members") || []).slice(1).map(sv)) {
        const mi = [...sh.doc.items.values()].find((x) => sv((kidOf(x.node, "uuid") || [])[1]) === m || x.id === m);
        if (!mi) continue;
        if (mi.kind === "symbol" || mi.kind === "group") attr(add(xm, xn("member")), "uuid", prefix + m);
        else if (mi.kind === "sheet") for (const d of inp.sheets) if (d.uuidPath.length > sh.uuidPath.length && d.uuidPath[sh.uuidPath.length] === m && sh.uuidPath.every((u, i) => d.uuidPath[i] === u))
          for (const di of d.doc.items.values()) if (di.kind === "symbol") attr(add(xm, xn("member")), "uuid", pathAsString(d) + sv((kidOf(di.node, "uuid") || [])[1]));
      }
    }
  }
  // ---- variants
  const xvars = add(root, xn("variants"));
  for (const v of (inp.variants || []).slice().sort((a, b) => cmp(a.name, b.name))) { const x = attr(add(xvars, xn("variant")), "name", v.name); if (v.description) attr(x, "description", v.description); }
  // ---- libparts (LIB_SYMBOL_LESS_THAN: by lib id)
  const xlp = add(root, xn("libparts")), libraries = new Set<string>();
  const libKey = (li: LibInfo): [string, string] => [li.nickname, li.name];
  for (const li of [...libParts.values()].sort((a, b) => cmp(libKey(a)[0], libKey(b)[0]) || cmp(libKey(a)[1], libKey(b)[1]))) {
    if (li.nickname) libraries.add(li.nickname);
    const x = add(xlp, xn("libpart")); attr(x, "lib", li.nickname); attr(x, "part", li.name);
    if (li.description) add(x, xn("description", li.description));
    const ds = (li.fields.find((f) => f.name === "Datasheet") || { value: "" }).value; if (ds) add(x, xn("docs", ds));
    if (li.fpFilters.length) { const xf = add(x, xn("footprints")); for (const f of li.fpFilters) add(xf, xn("fp", f)); }
    const xf = add(x, xn("fields"));
    for (const f of li.fields) attr(add(xf, xn("field", f.value)), "name", f.name);
    const pins = graphicalPins(li, 0, 0).slice().sort((a, b) => strNumCmp(a.number, b.number, true));
    const uniq = pins.filter((p, i) => i === 0 || p.number !== pins[i - 1].number);
    if (uniq.length) {
      const xp = add(x, xn("pins"));
      for (const p of uniq) {
        const e = expandStackedPins(p.number);
        for (const num of e.valid && e.nums.length ? e.nums : [p.number]) { const q = add(xp, xn("pin")); attr(q, "num", num); attr(q, "name", p.name); attr(q, "type", p.type); }
      }
    }
  }
  // ---- libraries
  const xlibs = add(root, xn("libraries"));
  for (const nick of [...libraries].sort(cmp)) { const uri = inp.libUri ? inp.libUri(nick) : null; if (uri === null) continue; const x = attr(add(xlibs, xn("library")), "logical", nick); add(x, xn("uri", uri)); }
  // ---- nets
  const xnets = add(root, xn("nets"));
  const nets = exportNets(inp, walk.map((w) => w.sym), (s) => excluded(s));
  nets.forEach((net, i) => {
    let xnet: XN | null = null;
    const nodes = net.nodes;
    const stacked = nodes.length <= 1 || nodes.slice(1).every((n) => n.symId === nodes[0].symId && n.inst === nodes[0].inst && n.pin.x === nodes[0].pin.x && n.pin.y === nodes[0].pin.y && n.pin.name === nodes[0].pin.name);
    for (const nd of nodes) {
      if (nd.ref.startsWith("#")) continue;
      const e = expandStackedPins(nd.pin.number), nums = e.nums;
      if (!nums.length) continue;
      if (!xnet) { xnet = add(xnets, xn("net")); attr(xnet, "code", String(i + 1)); attr(xnet, "name", net.name); attr(xnet, "class", inp.netClass ? inp.netClass(net.name) : "Default"); }
      for (const num of nums) {
        const x = add(xnet, xn("node")); attr(x, "ref", nd.ref); attr(x, "pin", num);
        if (nd.pin.name || nums.length > 1) attr(x, "pinfunction", nd.pin.name ? nd.pin.name + "_" + num : num);
        attr(x, "pintype", nd.pin.type + (net.nc && (nodes.length === 1 || stacked) ? "+no_connect" : ""));
      }
    }
  });
  return finishX(root);
}

interface NetNode { ref: string; symId: string; inst: number; pin: LibPin }
/** m_exportNets with each net's symbol pins (the pin's library data), nets by StrNumCmp of the name, the nodes by
 *  reference then shown pin number, duplicates removed. */
function exportNets(inp: NlInput, _syms: Sym[], excluded: (s: Sym) => boolean): { name: string; nc: boolean; nodes: NetNode[] }[] {
  const libCache = new Map<string, LibInfo>(), byInst = new Map<number, Map<string, Sym>>();
  for (const sh of inp.sheets) { const m = new Map<string, Sym>(); for (const s of symbolsOf(sh, libCache)) m.set(s.item.id, s); byInst.set(sh.index, m); }
  const out: { name: string; nc: boolean; nodes: NetNode[] }[] = [];
  const map: Map<string, NetEntry> = inp.netlist.netMap || new Map();
  for (const e of map.values()) {
    if (e.bus) continue;
    const nodes: NetNode[] = []; let nc = false;
    for (const m of e.members) {
      if (m.kind === "no_connect") { nc = true; continue; }
      if (m.kind !== "pin" || m.pin === undefined) continue;
      const s = (byInst.get(m.inst) || new Map()).get(m.id) as Sym | undefined; if (!s || !s.lib) continue;
      if (excluded(s)) continue;
      const lp = graphicalPins(s.lib, s.unit, 0).find((p) => p.number === m.pin) || s.lib.pins.find((p) => p.number === m.pin);
      if (!lp) continue;
      nodes.push({ ref: s.ref, symId: s.item.id, inst: m.inst, pin: lp });
    }
    nodes.sort((a, b) => (a.ref === b.ref ? cmp(a.pin.number, b.pin.number) : cmp(a.ref, b.ref)));
    const uniq = nodes.filter((n, i) => !nodes.slice(0, i).some((o) => o.ref === n.ref && o.pin.number === n.pin.number));
    out.push({ name: e.name, nc, nodes: uniq });
  }
  return out.sort((a, b) => strNumCmp(a.name, b.name));
}

// ---------------------------------------------------------------- Allegro
/** NETLIST_EXPORTER_ALLEGRO::formatText: µ/μ to u, ! ' and non-ASCII to ?, quoted when anything but [A-Za-z0-9_/] is left. */
export function allegroText(s: string): string {
  if (!s) return "";
  const p = s.replace(/[µμ]/g, "u").replace(/[!']|[^ -~]/g, "?");
  return /[^a-zA-Z0-9_/]/.test(p) ? `'${p}'` : p;
}
export const allegroDevice = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
const allegroPin = (p: LibPin, raw: string): string => (raw + "__" + p.number).replace(/[^A-Za-z0-9_+?/-]/g, "?");
/** formatRoom: the human sheet path (the root's: the root file's name), separators trimmed, inner ones as dashes. */
export function allegroRoom(human: string, rootName: string): string {
  let path = human === "/" ? rootName : human;
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  let out = "";
  for (const c of path) out += /[a-zA-Z0-9_-]/.test(c) ? c : c === "/" ? "-" : "_";
  return out;
}
const refPrefix = (r: string): string => { const i = r.search(/[0-9]/); return i < 0 ? r : r.slice(0, i); };

export function allegroNetlist(inp: NlInput, report?: (m: string, sev: "warning" | "error") => void): { netlist: string; devices: Map<string, string> } {
  const excluded = (s: Sym): boolean => s.flags.excludedFromBoard;
  const walk = walkSymbols(inp, excluded);
  const rootName = (inp.source.split(/[\\/]/).pop() || inp.source).replace(/\.kicad_sch$/, "");
  const ordered: Sym[] = []; const packageProps: [string, string][] = [];
  for (const { sym } of walk) {
    if (!sym.lib || !sym.lib.pins.length) continue;
    packageProps.push([allegroRoom(sym.sheet.human, rootName), sym.ref]);
    ordered.push(sym);
  }
  for (const s of ordered) {
    if (s.ref.length > 31) report && report(`Reference ${s.ref} is longer than the 31 characters Allegro accepts by default.`, "warning");
    if (/[()'!@]/.test(s.ref)) report && report(`Reference ${s.ref} contains a character Allegro rejects (()'!@).`, "warning");
  }
  let f = `(NETLIST)\n(Source: ${inp.source})\n(Date: ${inp.date})\n`;
  // ---- packages: group by value, footprint and reference prefix
  const raw = (s: Sym, name: string): string => fieldsFor(s, "").get(name) || "";
  const groups: Sym[][] = []; const rest = ordered.slice();
  while (rest.length) {
    const first = rest.shift() as Sym, g = [first];
    for (let i = 0; i < rest.length;) {
      const it = rest[i];
      if (raw(it, "Value") === raw(first, "Value") && raw(it, "Footprint") === raw(first, "Footprint") && refPrefix(it.ref) === refPrefix(first.ref)) { g.push(it); rest.splice(i, 1); }
      else i++;
    }
    groups.push(g);
  }
  const groupField = (g: Sym[], names: string[]): string => {
    for (const s of g) {
      const fm = fieldsFor(s, ""), res = resolver(s, inp, fm);
      for (const n of names) { for (const [k, v] of fm) if (k.toLowerCase() === n.toLowerCase()) { const t = res(v); if (t) return allegroText(t); } }
    }
    for (const s of g) for (const n of names) { const lf = s.lib && s.lib.fields.find((x) => x.name.toLowerCase() === n.toLowerCase()); if (lf && lf.value) return allegroText(lf.value); }
    return "";
  };
  const devices = new Map<string, string>(), pkgMap = new Map<string, { value: string; tol: string; refs: Sym[] }>();
  for (const g of groups) {
    const sym = g[0];
    let fpText = raw(sym, "Footprint");
    let deviceType = (raw(sym, "Value") + "_" + fpText).replace(/_+$/, "");
    deviceType = allegroDevice(deviceType);
    const value = groupField(g, ["Spice_Model", "VALUE"]), tol = groupField(g, ["TOLERANCE", "TOL"]);
    const refs = g.slice().sort((a, b) => (a.ref === b.ref ? cmp(a.sheet.human, b.sheet.human) : strNumCmp(a.ref, b.ref)));
    if (!pkgMap.has(deviceType)) pkgMap.set(deviceType, { value, tol, refs });
    fpText = fpText.slice(fpText.lastIndexOf(":") + 1);
    const alt = (sym.lib ? sym.lib.fpFilters : []).filter((x) => !/[*?]/.test(x)).map((x) => x.slice(x.lastIndexOf(":") + 1));
    if (!fpText) fpText = alt.length ? (alt.shift() as string) : deviceType;
    let d = `PACKAGE '${allegroDevice(fpText)}'\nCLASS IC\n`;
    const all = sym.lib ? sym.lib.pins.slice().sort((a, b) => strNumCmp(a.number, b.number, true)) : [];
    const pins = all.filter((p, i) => i === 0 || p.number !== all[i - 1].number);
    d += `PINCOUNT ${pins.length}\n`;
    if (pins.length) {
      d += "PINORDER MAIN " + pins.map((p) => ",\n\t" + allegroPin(p, p.name)).join("") + "\n";
      d += "FUNCTION MAIN MAIN " + pins.map((p) => ",\n\t" + p.number).join("") + "\n";
    }
    if (value) d += `PACKAGEPROP VALUE ${value}\n`;
    if (tol) d += `PACKAGEPROP TOL ${tol}\n`;
    if (alt.length) d += `PACKAGEPROP ALT_SYMBOLS '(${alt.join(",")})'\n`;
    const pn = groupField(g, ["PART_NUMBER", "mpn", "mfr_pn"]); if (pn) d += `PACKAGEPROP PART_NUMBER ${pn}\n`;
    const ht = groupField(g, ["HEIGHT"]); if (ht) d += `PACKAGEPROP HEIGHT ${ht}\n`;
    d += "END\n";
    devices.set(deviceType + ".txt", d);
  }
  f += "$PACKAGES\n";
  for (const [dev, p] of [...pkgMap.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    let value = p.value; if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (!value && !p.tol) f += `! '${dev}' ; `;
    else if (!p.tol) f += `! '${dev}' ! '${value}' ; `;
    else f += `! '${dev}' ! '${value}' ! ${p.tol} ; `;
    f += p.refs.map((s) => s.ref).join(",\n\t") + "\n";
  }
  // ---- room properties
  f += "$A_PROPERTIES\n";
  const rooms = new Map<string, string[]>();
  for (const [room, ref] of packageProps) { const l = rooms.get(room) || []; l.push(ref); rooms.set(room, l); }
  for (const [room, refs] of [...rooms.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (!room) continue;
    f += `'ROOM' '${room}' ; ` + refs.slice().sort((a, b) => strNumCmp(a, b)).join(",\n\t") + "\n";
  }
  // ---- nets
  f += "$NETS\n";
  const nets = exportNets(inp, ordered, excluded).filter((n) => n.nodes.some((x) => !x.ref.startsWith("#")));
  const byName = new Map<string, NetNode[]>();
  for (const n of nets) for (const nd of n.nodes) { if (nd.ref.startsWith("#")) continue; const l = byName.get(n.name) || []; l.push(nd); byName.set(n.name, l); }
  const nodeLess = (a: NetNode, b: NetNode): number => {
    if (a.ref === b.ref) { const x = /^\d+$/.test(a.pin.number), y = /^\d+$/.test(b.pin.number); return x && y ? +a.pin.number - +b.pin.number : cmp(a.pin.number, b.pin.number); }
    return strNumCmp(a.ref, b.ref);
  };
  for (const [name, nodes] of [...byName.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    f += allegroText(name).toUpperCase() + "; ";
    const list: string[] = [];
    for (const nd of nodes.slice().sort(nodeLess)) for (const num of expandStackedPins(nd.pin.number).nums) list.push(`${nd.ref}.${num}`);
    f += list.join(",\n\t") + "\n";
  }
  f += "$END\n";
  return { netlist: f, devices };
}

/** The SheetInstance list (pcb-netlist) with each instance's sheet item, for NlInput.sheets. */
export function nlSheets(instances: SheetInstance[], docOf: (file: string) => KDoc | null): NlSheet[] {
  const out: NlSheet[] = [];
  for (const i of instances) {
    const doc = docOf(i.file); if (!doc) continue;
    let sheetNode: N | null = null;
    if (i.uuidPath.length > 1) {
      const parent = instances.find((p) => p.uuidPath.length === i.uuidPath.length - 1 && p.uuidPath.every((u, k) => i.uuidPath[k] === u));
      const pd = parent ? docOf(parent.file) : null, id = i.uuidPath[i.uuidPath.length - 1];
      if (pd) for (const it of pd.items.values()) if (it.kind === "sheet" && (sv((kidOf(it.node, "uuid") || [])[1]) === id || it.id === id)) sheetNode = it.node;
    }
    let page = "";
    if (sheetNode) {
      const ppath = "/" + i.uuidPath.slice(0, -1).join("/");
      for (const pr of kidsOf(kidOf(sheetNode, "instances"), "project")) for (const p of kidsOf(pr, "path")) if (sv(p[1]) === ppath) { const pg = kidOf(p, "page"); if (pg) page = sv(pg[1]); }
    } else page = (doc as unknown as { pageNumber?: string }).pageNumber || "1";
    out.push({ index: i.index, uuidPath: i.uuidPath, human: i.human, file: i.file, doc, sheetNode, page });
  }
  // SCH_SHEET_LIST::SortByPageNumbers (ComparePageNum, then the walk order)
  // the virtual page number: the depth-first walk (BuildSheetList), children in the order the instances list them
  const pos = new Map(out.map((s, k) => [s.uuidPath.join("/"), k]));
  const dfsKey = (s: NlSheet): number[] => s.uuidPath.map((_u, k) => pos.get(s.uuidPath.slice(0, k + 1).join("/")) ?? -1);
  const dfs = (a: NlSheet, b: NlSheet): number => { const x = dfsKey(a), y = dfsKey(b); for (let k = 0; k < Math.min(x.length, y.length); k++) if (x[k] !== y[k]) return x[k] - y[k]; return x.length - y.length; };
  return out.sort((a, b) => comparePageNum(a.page || "", b.page || "") || dfs(a, b));
}
