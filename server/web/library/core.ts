// library/core.ts — the document side of library access, free of DOM and network so it runs
// under node (server/static/tests/library.test.js): flattening a derived library symbol the way
// LIB_SYMBOL::Flatten does, the copy a sheet keeps in (lib_symbols …), a new symbol instance
// as SCH_IO_KICAD_SEXPR::saveSymbol writes it, a library footprint turned into a board
// footprint as PCB_IO_KICAD_SEXPR::format(FOOTPRINT) writes it, and the chooser's search.
//
// Nodes are built from s-expression text through KiCadCanvas.parse rather than from bare
// arrays: the reader records which atoms were quoted, and KiCad's parsers want strings
// where the format says string.

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;

const isList = (v: unknown): v is SNode => Array.isArray(v);
const head = (n: SNode): string => String(n[0]);
const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** A quoted s-expression string. */
export function q(s: unknown): string {
  return '"' + text(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}
/** A coordinate the way KiCad prints it: at most four decimals for the schematic, six for the board. */
const mm = (v: number, digits = 4): string => String(+(+v).toFixed(digits) || 0);

function parseOne(src: string): SNode {
  const n = K().parse(src);
  if (!n) throw new Error("not an s-expression");
  return n;
}
function clone(n: SNode): SNode { return (K().cloneNode as (n: SNode) => SNode)(n); }
function kid(n: SNode, key: string): SNode | null { return K().kid(n, key); }
function kids(n: SNode, key: string): SNode[] { return K().kids(n, key); }
function indexOfKid(n: SNode, key: string): number { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return i; } return -1; }
function dropKids(n: SNode, key: string): void { for (let i = n.length - 1; i >= 1; i--) { const c = n[i]; if (isList(c) && c[0] === key) n.splice(i, 1); } }
function yes(n: SNode | null, def: boolean): boolean { return n ? text(n[1]) !== "no" : def; }

export const MANDATORY_FIELDS = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const isMeta = (name: string) => name.startsWith("ki_");

/** "Lib:Name" → { lib, name }; a bare name has an empty library. */
export function parseLibId(id: string): { lib: string; name: string } {
  const i = id.indexOf(":");
  return i < 0 ? { lib: "", name: id } : { lib: id.slice(0, i), name: id.slice(i + 1) };
}

/** The library symbol out of whatever was handed over: its text, a node, or a whole (kicad_symbol_lib …). */
export function symbolNodeOf(src: string | SNode, name?: string): SNode {
  let n = typeof src === "string" ? parseOne(src) : src;
  if (head(n) === "kicad_symbol_lib") {
    const all = kids(n, "symbol");
    const want = name ? all.find((s) => text(s[1]) === name || parseLibId(text(s[1])).name === name) : all[0];
    if (!want) throw new Error("the library has no symbol " + (name || ""));
    n = want;
  }
  if (head(n) !== "symbol") throw new Error("not a library symbol");
  return n;
}

// ---------------------------------------------------------------- library symbols

function propertyNamed(sym: SNode, name: string): SNode | null {
  for (const p of kids(sym, "property")) if (text(p[1]) === name) return p;
  return null;
}
const propertyText = (sym: SNode, name: string): string => { const p = propertyNamed(sym, name); return p ? text(p[2]) : ""; };

/**
 * LIB_SYMBOL::Flatten: the root parent's drawing with the derived symbol's name and fields.
 * `parents` is the chain the symbol extends, nearest first.  A mandatory field of the child
 * replaces the parent's only when it has text; any other field replaces or joins; keywords and
 * footprint filters fall back to the parent's; the BOM / board / simulation flags are the child's.
 */
export function flattenSymbol(symbol: string | SNode, parents: (string | SNode)[] = []): SNode {
  const child = clone(symbolNodeOf(symbol));
  if (!kid(child, "extends")) return child;
  if (!parents.length) throw new Error(`${text(child[1])} extends ${text(kid(child, "extends")![1])}, which was not supplied`);
  const base = flattenSymbol(parents[0], parents.slice(1));
  const baseName = parseLibId(text(base[1])).name, name = text(child[1]), ownName = parseLibId(name).name;
  base[1] = name;
  for (const sub of kids(base, "symbol")) {
    const s = text(sub[1]);
    if (s.startsWith(baseName + "_")) sub[1] = ownName + s.slice(baseName.length);
  }
  for (const p of kids(child, "property")) {
    const pname = text(p[1]), mine = text(p[2]);
    const at = base.findIndex((c) => isList(c) && c[0] === "property" && text(c[1]) === pname);
    if (MANDATORY_FIELDS.includes(pname) || isMeta(pname)) {
      if (mine === "" && at >= 0) continue;
      if (at >= 0) base[at] = clone(p); else insertProperty(base, clone(p));
    } else if (at >= 0) base[at] = clone(p);
    else insertProperty(base, clone(p));
  }
  for (const flag of ["exclude_from_sim", "in_bom", "on_board", "in_pos_files"]) {
    const mine = kid(child, flag); if (!mine) continue;
    const at = indexOfKid(base, flag);
    if (at >= 0) base[at] = clone(mine); else base.splice(Math.max(2, firstIndex(base, ["property", "symbol"])), 0, clone(mine));
  }
  return base;
}
function firstIndex(n: SNode, keys: string[]): number {
  for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && keys.includes(head(c))) return i; }
  return n.length;
}
/** After the last property, where the writer puts the next field. */
function insertProperty(sym: SNode, prop: SNode): void {
  let at = -1;
  for (let i = 1; i < sym.length; i++) { const c = sym[i]; if (isList(c) && c[0] === "property") at = i; }
  if (at < 0) at = firstIndex(sym, ["symbol"]) - 1;
  sym.splice(at + 1, 0, prop);
}

/**
 * The copy of a library symbol a sheet keeps in (lib_symbols …): the same symbol named by its
 * full lib id, units keeping the bare item name ("Device:R" holds "R_0_1"), as the schematic
 * writer saves a symbol's flattened library part when it is first used.
 */
export function embedSymbol(libId: string, symbol: string | SNode): SNode {
  const src = symbolNodeOf(symbol);
  if (kid(src, "extends")) throw new Error("flatten a derived symbol before embedding it");
  const out = clone(src);
  const was = parseLibId(text(out[1])).name, name = parseLibId(libId).name;
  out[1] = libId;
  if (was !== name) for (const sub of kids(out, "symbol")) { const s = text(sub[1]); if (s.startsWith(was + "_")) sub[1] = name + s.slice(was.length); }
  return out;
}

export interface SymbolInfo {
  name: string; reference: string; value: string; footprint: string; datasheet: string; description: string; keywords: string;
  fpFilters: string; power: boolean; units: number; bodyStyles: number; extends: string; pins: number;
  fields: { name: string; value: string }[];
}

/** `Name_<unit>_<bodyStyle>` → [unit, bodyStyle]. */
export function unitOfSubSymbol(sub: string): [number, number] | null {
  const m = /_(\d+)_(\d+)$/.exec(sub);
  return m ? [+m[1], +m[2]] : null;
}

export function symbolInfo(symbol: string | SNode): SymbolInfo {
  const s = symbolNodeOf(symbol);
  let units = 1, bodyStyles = 1, pins = 0;
  for (const sub of kids(s, "symbol")) {
    const u = unitOfSubSymbol(text(sub[1])); if (u) { units = Math.max(units, u[0]); bodyStyles = Math.max(bodyStyles, u[1]); }
    pins += kids(sub, "pin").length;
  }
  const ext = kid(s, "extends");
  return {
    name: parseLibId(text(s[1])).name, reference: propertyText(s, "Reference"), value: propertyText(s, "Value"), footprint: propertyText(s, "Footprint"),
    datasheet: propertyText(s, "Datasheet"), description: propertyText(s, "Description") || propertyText(s, "ki_description"),
    keywords: propertyText(s, "ki_keywords"), fpFilters: propertyText(s, "ki_fp_filters"), power: !!kid(s, "power"),
    units, bodyStyles, extends: ext ? text(ext[1]) : "", pins,
    fields: kids(s, "property").filter((p) => !isMeta(text(p[1]))).map((p) => ({ name: text(p[1]), value: text(p[2]) })),
  };
}

/** LIB_SYMBOL::GetUnitDisplayName's default: "Unit A", "Unit B", … "Unit AA". */
export function unitName(unit: number): string {
  let n = unit, s = "";
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return "Unit " + s;
}

// ---------------------------------------------------------------- a new symbol instance

function fieldHidden(p: SNode): boolean {
  const h = kid(p, "hide"); if (h) return text(h[1]) !== "no";
  if (p.includes("hide")) return true;
  const e = kid(p, "effects"); if (!e) return false;
  const eh = kid(e, "hide"); return eh ? text(eh[1]) !== "no" : e.includes("hide");
}
/** (effects …) of a library field for the instance: the visibility lives on the field, not in the effects. */
function effectsText(p: SNode | null): string {
  const e = p && kid(p, "effects");
  if (!e) return "(effects (font (size 1.27 1.27)))";
  const c = clone(e); dropKids(c, "hide");
  for (let i = c.length - 1; i >= 1; i--) if (c[i] === "hide") c.splice(i, 1);
  return K().serialize(c);
}

export interface SymbolInstanceOpts {
  /** "Lib:Name" as it goes into (lib_id …). */
  libId: string;
  /** The flattened library symbol (embedded or library form). */
  symbol: SNode;
  at: [number, number];
  unit?: number;
  /** Field values over the library's; names the symbol does not have become new (hidden) fields. */
  fields?: Record<string, string>;
  /** The full designator ("R?", "U3"); the library prefix + "?" when absent. */
  reference?: string;
  /** Project name and sheet path ("/<root uuid>/<sheet uuid>…") for the (instances …) block. */
  project?: string;
  path?: string;
  uuid?: string;
}

/**
 * A new SCH_SYMBOL of a library symbol, unrotated at `at`: the header flags from the library
 * part, every field at its library position (library Y points up), a pin with a fresh uuid for
 * each pin of the first body style, and the instance of the sheet it lands on.
 */
export function symbolInstance(o: SymbolInstanceOpts): SNode {
  const lib = o.symbol, unit = o.unit && o.unit > 0 ? o.unit : 1, [x, y] = o.at;
  const flag = (key: string, def: boolean) => `(${key} ${yes(kid(lib, key), def) ? "yes" : "no"})`;
  const info = symbolInfo(lib);
  const prefix = info.reference || "U";
  const reference = o.reference || prefix + "?";
  const over = o.fields || {};
  const out: string[] = [`(symbol (lib_id ${q(o.libId)}) (at ${mm(x)} ${mm(y)} 0) (unit ${unit}) (body_style 1)`,
    flag("exclude_from_sim", false), flag("in_bom", true), flag("on_board", true), flag("in_pos_files", true), "(dnp no)", `(uuid ${q(o.uuid || K().newUuid())})`];
  const field = (name: string, value: string, lp: SNode | null, hiddenDefault: boolean) => {
    const a = lp ? kid(lp, "at") : null;
    const lx = a ? K().num(a[1]) : 0, ly = a ? K().num(a[2]) : 0, rot = a ? K().num(a[3]) : 0;
    const hidden = lp ? fieldHidden(lp) : hiddenDefault;
    return `(property ${q(name)} ${q(value)} (at ${mm(x + lx)} ${mm(y - ly)} ${mm(rot)})${hidden ? " (hide yes)" : ""} (show_name ${yes(lp && kid(lp, "show_name"), false) ? "yes" : "no"})`
      + ` (do_not_autoplace ${yes(lp && kid(lp, "do_not_autoplace"), false) ? "yes" : "no"}) ${effectsText(lp)})`;
  };
  const libProps = kids(lib, "property").filter((p) => !isMeta(text(p[1])));
  const seen = new Set<string>();
  for (const name of MANDATORY_FIELDS) {
    const lp = libProps.find((p) => text(p[1]) === name) || null;
    let value = name === "Reference" ? reference : over[name] !== undefined ? over[name] : lp ? text(lp[2]) : "";
    if (name === "Value" && value === "") value = info.name;
    out.push(field(name, value, lp, name !== "Reference" && name !== "Value")); seen.add(name);
  }
  for (const lp of libProps) {
    const name = text(lp[1]); if (seen.has(name)) continue; seen.add(name);
    out.push(field(name, over[name] !== undefined ? over[name] : text(lp[2]), lp, false));
  }
  for (const [name, value] of Object.entries(over)) {
    if (seen.has(name) || isMeta(name) || !name) continue; seen.add(name);
    out.push(field(name, text(value), null, true));
  }
  for (const sub of kids(lib, "symbol")) {
    const u = unitOfSubSymbol(text(sub[1]));
    if (u && u[1] > 1) continue;                                   // pins of the alternate body style belong to it alone
    for (const pin of kids(sub, "pin")) { const nn = kid(pin, "number"); out.push(`(pin ${q(nn ? nn[1] : "")} (uuid ${q(K().newUuid())}))`); }
  }
  if (o.project && o.path) out.push(`(instances (project ${q(o.project)} (path ${q(o.path)} (reference ${q(reference)}) (unit ${unit}))))`);
  return parseOne(out.join(" ") + ")");
}

/** The designator a new symbol gets: "R?" — or, with automatic annotation, the first free number. */
export function nextReference(prefix: string, used: Iterable<string>, auto: boolean): string {
  prefix = prefix || "U";
  if (!auto) return prefix + "?";
  const taken = new Set(used); let n = 1;
  while (taken.has(prefix + n)) n++;
  return prefix + n;
}

// ---------------------------------------------------------------- a library footprint on the board

export interface FootprintInstanceOpts {
  /** "Lib:Name" as it goes into (footprint "…"). */
  fpid: string;
  /** The .kicad_mod text (or its parsed node). */
  footprint: string | SNode;
  at: [number, number];
  /** Field values over the library's (Reference stays "REF**" unless given). */
  fields?: Record<string, string>;
  uuid?: string;
}

const FP_UUID_BEFORE_EFFECTS = new Set(["property", "fp_text", "fp_text_box"]);
const FP_OWNED = new Set(["property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "pad", "zone", "group", "dimension", "image", "table", "point", "barcode", "fp_ellipse", "fp_ellipse_arc"]);

/**
 * A library footprint as a board item: the library header (version, generator) goes, the name
 * becomes the full FPID, the footprint and each of its items get a uuid where the board writer
 * puts it, the Datasheet and Description fields every board footprint carries are added, pads
 * come without nets, and it sits unrotated on the front at `at`.
 */
export function footprintInstance(o: FootprintInstanceOpts): SNode {
  const src = typeof o.footprint === "string" ? parseOne(o.footprint) : clone(o.footprint);
  if (head(src) !== "footprint" && head(src) !== "module") throw new Error("not a footprint");
  const out = parseOne(`(footprint ${q(o.fpid)} (layer "F.Cu") (uuid ${q(o.uuid || K().newUuid())}) (at ${mm(o.at[0], 6)} ${mm(o.at[1], 6)}))`);
  const freshen = (n: SNode) => {
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "uuid" || c[0] === "tstamp") n[i] = parseOne(`(uuid ${q(K().newUuid())})`);
      else freshen(c);
    }
  };
  const over = o.fields || {};
  const seen = new Set<string>();
  const body: SNode[] = [];
  for (let i = 2; i < src.length; i++) {
    const c = src[i]; if (!isList(c)) continue;                       // bare flags (locked, placed) do not travel
    const k = head(c);
    if (k === "version" || k === "generator" || k === "generator_version" || k === "tedit" || k === "layer" || k === "at" || k === "uuid" || k === "tstamp"
      || k === "path" || k === "sheetname" || k === "sheetfile" || k === "locked" || k === "placed") continue;
    if (k === "property") { const name = text(c[1]); seen.add(name); if (over[name] !== undefined) c[2] = text(over[name]); }
    if (k === "pad") dropKids(c, "net");
    if (FP_OWNED.has(k)) {
      freshen(c);
      if (!kid(c, "uuid")) {
        const u = parseOne(`(uuid ${q(K().newUuid())})`);
        const e = FP_UUID_BEFORE_EFFECTS.has(k) ? indexOfKid(c, "effects") : -1;
        if (e >= 0) c.splice(e, 0, u); else c.push(u);
      }
    }
    body.push(c);
  }
  // the fields a board footprint always has (FOOTPRINT's mandatory fields), after Value
  const extra: SNode[] = [];
  const mk = (name: string, value: string, hidden: boolean) => parseOne(`(property ${q(name)} ${q(value)} (at 0 0 0) (layer "F.Fab")${hidden ? " (hide yes)" : ""} (uuid ${q(K().newUuid())}) (effects (font (size 1.27 1.27))))`);
  for (const name of ["Datasheet", "Description"]) if (!seen.has(name)) { extra.push(mk(name, over[name] !== undefined ? text(over[name]) : "", true)); seen.add(name); }
  for (const [name, value] of Object.entries(over)) if (name && !seen.has(name)) { extra.push(mk(name, text(value), true)); seen.add(name); }
  let after = -1;
  body.forEach((c, i) => { if (head(c) === "property" && (text(c[1]) === "Value" || (after < 0 && text(c[1]) === "Reference"))) after = i; });
  if (after < 0) { body.forEach((c, i) => { if (head(c) === "descr" || head(c) === "tags") after = i; }); }
  body.splice(after + 1, 0, ...extra);
  for (const c of body) out.push(c);
  return out;
}

/** What a footprint's index row needs, from its text. */
export function footprintInfo(footprint: string | SNode): { name: string; description: string; keywords: string; pads: number } {
  const n = typeof footprint === "string" ? parseOne(footprint) : footprint;
  const numbers = new Set(kids(n, "pad").map((p) => text(p[1])).filter((s) => s !== ""));
  const d = kid(n, "descr"), t = kid(n, "tags");
  return { name: parseLibId(text(n[1])).name, description: d ? text(d[1]) : "", keywords: t ? text(t[1]) : "", pads: numbers.size };
}

// ---------------------------------------------------------------- the chooser's search

export interface SearchRow { name: string; description?: string; keywords?: string; library?: string }

/**
 * Score a row against the filter like the library tree does: every whitespace-separated term
 * must be found in the name, the keywords, the description or the library; a match in the
 * name counts most, an exact or leading match more still.  0 means filtered out.
 */
export function searchScore(row: SearchRow, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  const name = row.name.toLowerCase(), kw = (row.keywords || "").toLowerCase(), desc = (row.description || "").toLowerCase(), lib = (row.library || "").toLowerCase();
  const nameScore = (t: string): number =>
    name === t ? 1000 : name.startsWith(t) ? 500 - Math.min(200, name.length - t.length) : name.includes(t) ? 250 - Math.min(100, name.indexOf(t)) : 0;
  let score = 0;
  for (const t of terms) {
    let s = 0;
    const colon = t.indexOf(":");
    if (colon > 0 && lib === t.slice(0, colon)) s = colon === t.length - 1 ? 20 : nameScore(t.slice(colon + 1));   // "lib:name", as a lib id is written
    else s = nameScore(t);
    if (!s) {
      if (kw.split(/\s+/).includes(t)) s = 120;
      else if (kw.includes(t)) s = 80;
      else if (desc.includes(t)) s = 40;
      else if (lib.includes(t)) s = 20;
    }
    if (!s) return 0;
    score += s;
  }
  return score;
}

/** KiCad's test for a power symbol in the chooser's filter: the (power) flag or a #PWR / #FLG reference. */
export function isPowerRow(row: { power?: boolean; reference?: string }): boolean {
  return !!row.power || row.reference === "#PWR" || row.reference === "#FLG";
}
