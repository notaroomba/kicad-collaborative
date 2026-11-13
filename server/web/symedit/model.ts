// symedit/model.ts — the Symbol Editor's library-symbol model, over s-expression nodes and free of the DOM so the
// node tests run it.  The C++ it ports:
//   - SCH_IO_KICAD_SEXPR_LIB_CACHE::Save / formatLibrary / SaveSymbol (ordering by inheritance depth then name) and
//     KICAD_FORMAT::Prettify (common/io/kicad/kicad_io_utils.cpp) — a saved library diffs cleanly against a desktop save;
//   - LIB_SYMBOL's units and body styles ("Name_u_b" sub-symbols, (unit_name …), (body_styles demorgan | names));
//   - LIB_SYMBOL_LIBRARY_MANAGER::CreateSymbol (New Symbol / Derive from Existing Symbol), LIB_SYMBOL::Flatten,
//     rename with the derived symbols' (extends …) rewritten;
//   - SYMBOL_EDITOR_PIN_TOOL: CreatePin defaults (g_Last*), PlacePin's occupied-position test, CreateImagePins,
//     SynchronizeOtherUnits, RepeatPin with IncrementString (common/increment.cpp), PushPinProperties;
//   - CheckLibSymbol (eeschema/symbol_checker.cpp) message for message;
//   - SYMBOL_EDIT_FRAME::LoadSymbolFromSchematic's field back-transform and SCH_EDIT_FRAME::SaveSymbolToSchematic's
//     SCH_SYMBOL::UpdateFields( update style, ref, other fields; no reset ) and alternate-pin cleanup;
//   - the Pin Table's CSV export / import columns (DIALOG_LIB_EDIT_PIN_TABLE).
// Coordinates are the file's: millimetres, library Y up.
import { cloneNode, isList, kid, kids, num, parse, str } from "../canvas/sexpr";
import { serialize } from "../canvas/export";

export type Node = SNode;

// ---------------------------------------------------------------- constants
/** SEXPR_SYMBOL_LIB_FILE_VERSION of this tree (eeschema/sch_file_versions.h): only for a brand-new library. */
export const SYMBOL_LIB_FILE_VERSION = 20261106;
export const NEW_LIBRARY_TEXT = '(kicad_symbol_lib\n\t(version 20261106)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")\n)\n';
export const MIL = 0.0254;
/** SYMBOL_EDITOR_SETTINGS defaults (symbol_editor_settings.cpp): pin length 100, name / number size 50 mil, repeat step 100 mil, label delta 1. */
export const DEFAULTS = { pinLength: 100 * MIL, pinNameSize: 50 * MIL, pinNumSize: 50 * MIL, pinStep: 100 * MIL, labelDelta: 1, lineWidth: 0, textSize: 50 * MIL, gridMils: 50 };
export const DEFAULT_PIN_NAME_OFFSET = 20 * MIL;   // DEFAULT_PIN_NAME_OFFSET 20 mil
export const MANDATORY_FIELDS = ["Reference", "Value", "Footprint", "Datasheet", "Description"];

/** The electrical types in DIALOG_PIN_PROPERTIES / the pin table order, with ElectricalPinTypeGetText. */
export const PIN_TYPES: [string, string][] = [
  ["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"],
  ["free", "Free"], ["unspecified", "Unspecified"], ["power_in", "Power input"], ["power_out", "Power output"],
  ["open_collector", "Open collector"], ["open_emitter", "Open emitter"], ["no_connect", "Unconnected"],
];
/** PinShapeGetText order. */
export const PIN_SHAPES: [string, string][] = [
  ["line", "Line"], ["inverted", "Inverted"], ["clock", "Clock"], ["inverted_clock", "Inverted clock"], ["input_low", "Input low"],
  ["clock_low", "Clock low"], ["output_low", "Output low"], ["edge_clock_high", "Falling edge clock"], ["non_logic", "NonLogic"],
];
/** PinOrientationName: file angle -> name. */
export const PIN_ORIENTATIONS: [number, string][] = [[0, "Right"], [180, "Left"], [90, "Up"], [270, "Down"]];

// ---------------------------------------------------------------- text helpers
export const q = (s: string): string => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/** FormatInternalUnits for the schematic: 100 nm resolution, no trailing zeros, never "-0". */
export function fmt(v: number): string { const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; }
export const node = (text: string): Node => { const n = parse(text); if (!n) throw new Error("bad s-expression: " + text.slice(0, 60)); return n; };
export const clone = (n: Node): Node => cloneNode(n);
export const text = (n: Node): string => serialize(n);

// ---------------------------------------------------------------- Prettify
/**
 * KICAD_FORMAT::Prettify (common/io/kicad/kicad_io_utils.cpp:117), character for character: FORMAT_MODE::NORMAL, or
 * FORMAT_MODE::LIBRARY_TABLE (`libTable`), where each (lib …) row stays on one line with its tokens space-separated.
 */
export function prettify(src: string, libTable = false): string {
  const xyLimit = 99, wrapAt = 72;
  let out = "", depth = 0, last = "", inQuote = false, spaced = false, multi = false, inXY = false, column = 0, bs = 0;
  let inLib = false, libDepth = 0;
  const isLib = (i: number) => { let j = i + 1, tok = ""; while (j < n && /[A-Za-z]/.test(src[j])) tok += src[j++]; return tok === "lib"; };
  const n = src.length; const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const nextNonWs = (i: number): string => { while (i < n && ws(src[i])) i++; return i < n ? src[i] : ""; };
  const isXY = (i: number) => src[i + 1] === "x" && src[i + 2] === "y" && src[i + 3] === " ";
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (depth === 0 && c === "#" && (out === "" || out[out.length - 1] === "\n")) {
      let e = src.indexOf("\n", i); if (e < 0) e = n; out += src.slice(i, e) + "\n"; i = e; continue;
    }
    const next = nextNonWs(i);
    if (ws(c) && !inQuote) {
      if (!spaced && depth > 0 && last !== "(" && next !== ")" && next !== "(") {
        if (inXY || column < wrapAt) { out += " "; column++; }
        else if (inLib) out += " ";
        else { out += "\n" + "\t".repeat(depth); column = depth; multi = true; }
        spaced = true;
      }
      continue;
    }
    spaced = false;
    if (c === "(" && !inQuote) {
      const curXY = isXY(i); const curLib = libTable && isLib(i);
      if (out === "" || out[out.length - 1] === "\n") { out += "("; column++; }
      else if (inXY && curXY && column < xyLimit) { out += " ("; column += 2; }
      else if (inLib) { out += " ("; column += 2; }
      else { out += "\n" + "\t".repeat(depth) + "("; column = depth + 1; }
      inXY = curXY;
      if (curLib && !inLib) { inLib = true; libDepth = depth; }
      depth++;
    } else if (c === ")" && !inQuote) {
      if (depth > 0) depth--;
      if (inLib && depth === libDepth) { out += ")"; inLib = false; }
      else if (last === ")" || multi) { out += "\n" + "\t".repeat(depth) + ")"; column = depth + 1; multi = false; }
      else { out += ")"; column++; }
    } else {
      if (c === "\\") bs++;
      else if (c === '"' && (bs & 1) === 0) inQuote = !inQuote;
      if (c !== "\\") bs = 0;
      out += c; column++;
    }
    last = c;
  }
  return out + "\n";
}

// ---------------------------------------------------------------- the library file
export interface SymLib {
  /** (kicad_symbol_lib (version …) (generator …) (generator_version …) …) without its (symbol …) children */
  head: Node;
  version: number;
  /** top-level symbols by name, in file order */
  symbols: Map<string, Node>;
}
export function parseLibrary(src: string): SymLib {
  const t = parse(src);
  if (!t || t[0] !== "kicad_symbol_lib") throw new Error("not a symbol library");
  const head: Node = [t[0]]; const symbols = new Map<string, Node>();
  for (let j = 1; j < t.length; j++) { const c = t[j]; if (isList(c) && c[0] === "symbol") symbols.set(str(c[1]), c); else head.push(c); }
  const v = kid(t, "version");
  return { head, version: v ? num(v[1]) : 0, symbols };
}
export function emptyLibrary(): SymLib { return parseLibrary(NEW_LIBRARY_TEXT); }
/** The library's symbol names in the order SCH_IO_KICAD_SEXPR_LIB_CACHE::Save writes them. */
export function saveOrder(lib: SymLib): string[] {
  const names = Array.from(lib.symbols.keys());
  const depth = (name: string): number => { let d = 0, cur = lib.symbols.get(name); const seen = new Set<string>(); while (cur && d < 32) { const e = kid(cur, "extends"); if (!e) break; const p = str(e[1]); if (seen.has(p)) break; seen.add(p); d++; cur = lib.symbols.get(p); } return d; };
  const dep = new Map(names.map((n) => [n, depth(n)]));
  // wxString::operator< : a code-unit comparison
  return names.sort((a, b) => (dep.get(a)! - dep.get(b)!) || (a < b ? -1 : a > b ? 1 : 0));
}
/** The whole file, as the desktop writes it: header, symbols by inheritance depth then name, prettified. */
export function serializeLibrary(lib: SymLib): string {
  let s = "(" + lib.head.slice(1).reduce((acc: string, c) => acc + " " + serialize(c), String(lib.head[0]));
  for (const name of saveOrder(lib)) s += " " + serialize(lib.symbols.get(name)!);
  return prettify(s + ")");
}

// ---------------------------------------------------------------- one symbol
export const symName = (sym: Node): string => str(sym[1]);
/** EscapeString( aSource, CTX_LIBID ) (common/string_utils.cpp): the characters a LIB_ID may not hold become {tokens}. */
export function escapeLibId(src: string): string {
  return src.replace(/[\\<>:"\r\n]/g, (c) => ({ "\\": "{backslash}", "<": "{lt}", ">": "{gt}", ":": "{colon}", "\"": "{dblquote}" } as Record<string, string>)[c] || "");
}
const UNESC: Record<string, string> = { dblquote: "\"", quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{" };
/** UnescapeString: a symbol name as the dialogs and messages show it. */
export function unescapeLibId(src: string): string { return src.indexOf("{") < 0 ? src : src.replace(/(?<![$~^_])\{(dblquote|quote|lt|gt|backslash|slash|bar|comma|colon|space|dollar|tab|return|brace)\}/g, (_m, k: string) => UNESC[k]); }
export const parentNameOf = (sym: Node): string | null => { const e = kid(sym, "extends"); return e ? str(e[1]) : null; };
export const isDerived = (sym: Node): boolean => !!kid(sym, "extends");
/** DIALOG_LIB_SYMBOL_PROPERTIES's "Derive from symbol:" choices: the library's symbols less this one and its descendants (no circular inheritance). */
export function parentChoices(lib: SymLib | null, name: string): string[] {
  if (!lib) return [];
  const desc = new Set<string>([name]);
  for (let grew = true; grew;) { grew = false; for (const [k, s] of lib.symbols) { const p = parentNameOf(s); if (p && desc.has(p) && !desc.has(k)) { desc.add(k); grew = true; } } }
  return [...lib.symbols.keys()].filter((k) => !desc.has(k)).sort(numCompare);
}
/** LIB_SYMBOL::SetParent on a derived symbol: rewrite its (extends …). */
export function setParentName(sym: Node, parent: string): void { const e = kid(sym, "extends"); if (e) e[1] = parent; }
export function subUnitBody(name: string): [number, number] { const m = /_(\d+)_(\d+)$/.exec(name); return m ? [+m[1], +m[2]] : [0, 0]; }
/** The root a derived symbol resolves to in its library (or itself). */
export function rootOf(lib: SymLib | null, sym: Node): Node { let cur = sym; const seen = new Set<string>(); while (lib && isDerived(cur)) { const p = parentNameOf(cur)!; if (seen.has(p)) break; seen.add(p); const n = lib.symbols.get(p); if (!n) break; cur = n; } return cur; }

/** LIB_SYMBOL::GetUnitCount: the highest unit any sub-symbol names (at least 1). */
export function unitCount(sym: Node): number { let n = 1; for (const s of kids(sym, "symbol")) { const [u] = subUnitBody(str(s[1])); if (u > n) n = u; } const uc = kid(sym, "unit_count"); return uc ? Math.max(n, num(uc[1], 1)) : n; }
/** The body styles: De Morgan (Standard / Alternate), custom names, or one. */
export function bodyStyles(sym: Node): { count: number; demorgan: boolean; names: string[] } {
  const bs = kid(sym, "body_styles");
  if (bs) { if (str(bs[1]) === "demorgan") return { count: 2, demorgan: true, names: ["Standard", "Alternate"] }; const names = bs.slice(1).map((x) => str(x)); return { count: Math.max(1, names.length), demorgan: false, names }; }
  let max = 1; for (const s of kids(sym, "symbol")) { const [, b] = subUnitBody(str(s[1])); if (b > max) max = b; }
  return max >= 2 ? { count: max, demorgan: true, names: ["Standard", "Alternate"] } : { count: 1, demorgan: false, names: ["Standard"] };
}
/** LIB_SYMBOL::GetBodyStyleDescription( n, true ). */
export function bodyStyleDescription(sym: Node, n: number): string { const b = bodyStyles(sym); if (b.demorgan) return n === 2 ? "Alternate" : "Standard"; return b.names[n - 1] || String(n); }
/** LIB_SYMBOL::LetterSubReference: 1 -> A, 27 -> AA. */
export function unitLetter(unit: number): string { let s = ""; let u = unit; do { const r = (u - 1) % 26; s = String.fromCharCode(65 + r) + s; u = (u - r - 1) / 26; } while (u > 0); return s; }
/** (unit_name …) of a sub-symbol, by unit. */
export function unitNames(sym: Node): Map<number, string> { const m = new Map<number, string>(); for (const s of kids(sym, "symbol")) { const [u] = subUnitBody(str(s[1])); const un = kid(s, "unit_name"); if (un && u > 0) m.set(u, str(un[1])); } return m; }
/** The unit selector's entries, GetUnitDisplayName( u, true ): the display name, else "Unit A" (RebuildSymbolUnitAndBodyStyleLists). */
export function unitChoices(sym: Node): string[] { const n = unitCount(sym), names = unitNames(sym); const out: string[] = []; for (let u = 1; u <= n; u++) out.push(names.get(u) || `Unit ${unitLetter(u)}`); return out; }
export const unitsLocked = (sym: Node): boolean => kids(sym, "property").some((p) => str(p[1]) === "ki_locked");
export const isPower = (sym: Node): boolean => !!kid(sym, "power");

/** The sub-symbol "Name_u_b", created (in unit / body order) when missing. */
export function ensureSub(sym: Node, unit: number, body: number): Node {
  const name = baseName(sym) + "_" + unit + "_" + body;
  for (const s of kids(sym, "symbol")) if (str(s[1]) === name) return s;
  const sub = node("(symbol " + q(name) + ")");
  let at = -1;
  for (let j = 1; j < sym.length; j++) { const c = sym[j]; if (!isList(c) || c[0] !== "symbol") continue; const [u, b] = subUnitBody(str(c[1])); if (u < unit || (u === unit && b < body)) at = j; }
  if (at < 0) { for (let j = 1; j < sym.length; j++) { const c = sym[j]; if (isList(c) && (c[0] === "property" || c[0] === "duplicate_pin_numbers_are_jumpers" || c[0] === "in_pos_files" || c[0] === "on_board" || c[0] === "in_bom" || c[0] === "exclude_from_sim" || c[0] === "jumper_pin_groups" || c[0] === "pin_map" || c[0] === "pin_maps")) at = j; } }
  if (at < 0) { const ef = sym.findIndex((c, j) => j > 0 && isList(c) && (c[0] === "embedded_fonts" || c[0] === "embedded_files")); sym.splice(ef > 0 ? ef : sym.length, 0, sub); }
  else sym.splice(at + 1, 0, sub);
  return sub;
}
/** The sub-symbols' base: the symbol's own name (SaveSymbol writes "<unitName>_u_b" from the LIB_ID item name). */
export function baseName(sym: Node): string { const n = symName(sym); const i = n.indexOf(":"); return i >= 0 ? n.slice(i + 1) : n; }

// draw items -----------------------------------------------------------
export interface ItemRef { sub: string; j: number; unit: number; body: number }
export const GRAPHIC_KINDS = new Set(["rectangle", "polyline", "bezier", "circle", "arc", "ellipse", "ellipse_arc", "text", "text_box"]);
export function subByName(sym: Node, name: string): Node | null { for (const s of kids(sym, "symbol")) if (str(s[1]) === name) return s; return null; }
export function itemAt(sym: Node, ref: Pick<ItemRef, "sub" | "j">): Node | null { const s = subByName(sym, ref.sub); const c = s ? s[ref.j] : null; return isList(c) ? c : null; }
/** Every draw item (shapes, texts, pins) with where it lives. */
export function drawItems(sym: Node): (ItemRef & { node: Node })[] {
  const out: (ItemRef & { node: Node })[] = [];
  for (const s of kids(sym, "symbol")) { const name = str(s[1]); const [u, b] = subUnitBody(name); for (let j = 2; j < s.length; j++) { const c = s[j]; if (isList(c) && (c[0] === "pin" || GRAPHIC_KINDS.has(String(c[0])))) out.push({ sub: name, j, unit: u, body: b, node: c }); } }
  return out;
}
export const allPins = (sym: Node) => drawItems(sym).filter((d) => d.node[0] === "pin");
/** SCH_ITEM type order for the sub-symbol's saved order: shapes, text boxes, texts, pins (KICAD_T). */
const typeRank = (k: string): number => (k === "text_box" ? 1 : k === "text" ? 2 : k === "pin" ? 3 : 0);
/** Add a draw item to unit / body style (0 = common), after the last item of its type; returns its ref. */
export function addDrawItem(sym: Node, unit: number, body: number, item: Node): ItemRef {
  const sub = ensureSub(sym, unit, body); const r = typeRank(String(item[0]));
  let at = sub.length;
  for (let j = 2; j < sub.length; j++) { const c = sub[j]; if (isList(c) && c[0] !== "unit_name" && typeRank(String(c[0])) > r) { at = j; break; } }
  sub.splice(at, 0, item);
  return { sub: str(sub[1]), j: at, unit, body };
}
/** Remove one draw item; an emptied sub-symbol stays (KiCad keeps the unit). */
export function removeDrawItem(sym: Node, ref: Pick<ItemRef, "sub" | "j">): Node | null { const s = subByName(sym, ref.sub); if (!s || !isList(s[ref.j])) return null; return s.splice(ref.j, 1)[0] as Node; }

// geometry edits on a node, library coordinates --------------------------------
const setXY = (n: Node | null, f: (x: number, y: number) => [number, number]): void => { if (!n) return; const [x, y] = f(num(n[1]), num(n[2])); n[1] = +fmt(x); n[2] = +fmt(y); };
/** Every point a node carries, transformed (at / start / mid / end / center / pts). */
export function mapPoints(n: Node, f: (x: number, y: number) => [number, number]): void {
  for (const k of ["at", "start", "mid", "end", "center"]) setXY(kid(n, k), f);
  const p = kid(n, "pts"); if (p) for (const xy of kids(p, "xy")) setXY(xy, f);
}
export function moveNode(n: Node, dx: number, dy: number): void { mapPoints(n, (x, y) => [x + dx, y + dy]); }
/** Rotate 90° counter-clockwise (SCH_ACTIONS::rotateCCW, R) or clockwise about (cx, cy). */
export function rotateNode(n: Node, cx: number, cy: number, ccw: boolean): void {
  const k = String(n[0]);
  if (k === "circle") { setXY(kid(n, "center"), (x, y) => rot(x, y, cx, cy, ccw)); return; }
  if (k === "ellipse" || k === "ellipse_arc") { setXY(kid(n, "center"), (x, y) => rot(x, y, cx, cy, ccw)); rotateEllipse(n, ccw); return; }
  mapPoints(n, (x, y) => rot(x, y, cx, cy, ccw));
  if (k === "rectangle") { const s = kid(n, "start"), e = kid(n, "end"); if (s && e) { const x0 = Math.min(num(s[1]), num(e[1])), x1 = Math.max(num(s[1]), num(e[1])), y0 = Math.min(num(s[2]), num(e[2])), y1 = Math.max(num(s[2]), num(e[2])); s[1] = +fmt(x0); s[2] = +fmt(y1); e[1] = +fmt(x1); e[2] = +fmt(y0); } }
  const at = kid(n, "at");
  if (k === "pin" && at) at[3] = (((num(at[3]) + (ccw ? 90 : 270)) % 360) + 360) % 360;
  else if (k === "text" && at) at[3] = num(at[3]) === 0 ? 900 : 0;   // tenths of a degree (saveText)
  else if ((k === "property" || k === "text_box") && at) at[3] = num(at[3]) === 0 ? 90 : 0;
}
const rot = (x: number, y: number, cx: number, cy: number, ccw: boolean): [number, number] => { const dx = x - cx, dy = y - cy; return ccw ? [cx - dy, cy + dx] : [cx + dy, cy - dx]; };
/** Mirror horizontally (left / right, mirrorH 'X') or vertically (mirrorV 'Y') about (cx, cy). */
export function mirrorNode(n: Node, cx: number, cy: number, horizontal: boolean): void {
  const k = String(n[0]);
  mapPoints(n, (x, y) => horizontal ? [2 * cx - x, y] : [x, 2 * cy - y]);
  if (k === "ellipse" || k === "ellipse_arc") mirrorEllipse(n, horizontal);
  if (k === "arc") { const s = kid(n, "start"), e = kid(n, "end"); if (s && e) { const t1 = s[1], t2 = s[2]; s[1] = e[1]; s[2] = e[2]; e[1] = t1; e[2] = t2; } }
  const at = kid(n, "at");
  if (k === "pin" && at) { const a = num(at[3]); at[3] = horizontal ? (a === 0 ? 180 : a === 180 ? 0 : a) : (a === 90 ? 270 : a === 270 ? 90 : a); }
  else if ((k === "text" || k === "property") && at) {
    const e = kid(n, "effects"); const j = e ? kid(e, "justify") : null; const vert = num(at[3]) === 90;
    if (j && ((horizontal && !vert) || (!horizontal && vert))) for (let i = 1; i < j.length; i++) { if (j[i] === "left") j[i] = "right"; else if (j[i] === "right") j[i] = "left"; }
    if (j && ((horizontal && vert) || (!horizontal && !vert))) for (let i = 1; i < j.length; i++) { if (j[i] === "top") j[i] = "bottom"; else if (j[i] === "bottom") j[i] = "top"; }
  }
}
/** The anchor moved to (x, y): every item and field shifts by the opposite (SYMBOL_EDITOR_MOVE_TOOL "Move Symbol Anchor"). */
export function moveAnchor(sym: Node, x: number, y: number): void {
  for (const d of drawItems(sym)) moveNode(d.node, -x, -y);
  for (const p of kids(sym, "property")) setXY(kid(p, "at"), (a, b) => [a - x, b - y]);
}

// ---------------------------------------------------------------- pins
export interface PinInfo {
  type: string; shape: string; x: number; y: number; orient: number; length: number; visible: boolean;
  name: string; number: string; nameSize: number; numSize: number; unit: number; body: number;
  alternates: { name: string; type: string; shape: string }[];
}
export function pinInfo(p: Node, unit = 0, body = 0): PinInfo {
  const at = kid(p, "at"), len = kid(p, "length"), nm = kid(p, "name"), nb = kid(p, "number");
  const sizeOf = (t: Node | null) => { const e = t && kid(t, "effects"); const f = e && kid(e, "font"); const s = f && kid(f, "size"); return s ? num(s[1]) : 1.27; };
  const h = kid(p, "hide"); const hidden = h ? str(h[1]) !== "no" : p.includes("hide");
  return { type: str(p[1]) || "unspecified", shape: str(p[2]) || "line", x: at ? num(at[1]) : 0, y: at ? num(at[2]) : 0, orient: at ? num(at[3]) : 0, length: len ? num(len[1]) : 2.54,
    visible: !hidden, name: nm ? str(nm[1]) : "", number: nb ? str(nb[1]) : "", nameSize: sizeOf(nm), numSize: sizeOf(nb), unit, body,
    alternates: kids(p, "alternate").map((a) => ({ name: str(a[1]), type: str(a[2]), shape: str(a[3]) })) };
}
/** SCH_IO_KICAD_SEXPR_LIB_CACHE::savePin. */
export function pinNode(i: PinInfo): Node {
  let s = `(pin ${i.type} ${i.shape} (at ${fmt(i.x)} ${fmt(i.y)} ${i.orient}) (length ${fmt(i.length)})`;
  if (!i.visible) s += " (hide yes)";
  s += ` (name ${q(i.name)} (effects (font (size ${fmt(i.nameSize)} ${fmt(i.nameSize)}))))`;
  s += ` (number ${q(i.number)} (effects (font (size ${fmt(i.numSize)} ${fmt(i.numSize)}))))`;
  for (const a of i.alternates) s += ` (alternate ${q(a.name)} ${a.type} ${a.shape})`;
  return node(s + ")");
}
/** Rewrite a pin node from an info record, keeping anything else it carries (custom properties, uuid). */
export function setPin(p: Node, i: PinInfo): void {
  const fresh = pinNode(i);
  const keep = p.filter((c, j) => j > 2 && isList(c) && !["at", "length", "hide", "name", "number", "alternate"].includes(String(c[0])));
  p.length = 0; for (const c of fresh) p.push(c); for (const c of keep) p.push(c);
}
/** SCH_PIN::ChangeLength: the connection point moves so the body end stays put. */
export function changeLength(i: PinInfo, len: number): void {
  const d = len - i.length; const a = i.orient;
  if (a === 0) i.x -= d; else if (a === 180) i.x += d; else if (a === 90) i.y -= d; else i.y += d;
  i.length = len;
}

/** The session's last-used pin settings (g_LastPin*), as CreatePin starts from them. */
export interface PinDefaults { orient: number; type: string; shape: string; visible: boolean; commonUnit: boolean; commonBody: boolean; length: number; nameSize: number; numSize: number }
export function initialPinDefaults(): PinDefaults { return { orient: 0, type: "input", shape: "line", visible: true, commonUnit: false, commonBody: false, length: DEFAULTS.pinLength, nameSize: DEFAULTS.pinNameSize, numSize: DEFAULTS.pinNumSize }; }
/** SYMBOL_EDITOR_PIN_TOOL::CreatePin before the dialog. */
export function newPinInfo(x: number, y: number, last: PinDefaults, unit: number, body: number): PinInfo {
  return { type: last.type, shape: last.shape, x, y, orient: last.orient, length: last.length, visible: last.visible, name: "", number: "", nameSize: last.nameSize, numSize: last.numSize,
    unit: last.commonUnit ? 0 : unit, body: last.commonBody ? 0 : body, alternates: [] };
}
/** EditPinProperties' tail: what the next new pin starts from. */
export function rememberPin(last: PinDefaults, i: PinInfo): void { Object.assign(last, { nameSize: i.nameSize, numSize: i.numSize, orient: i.orient, length: i.length, shape: i.shape, type: i.type, commonBody: i.body === 0, commonUnit: i.unit === 0, visible: i.visible }); }

const samePos = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
/** PlacePin's test: another pin at the same position (any unit, same or common body style); its unit, or null. */
export function occupiedBy(sym: Node, p: PinInfo, skip?: Node | null): number | null {
  for (const d of allPins(sym)) {
    if (d.node === skip) continue; const o = pinInfo(d.node, d.unit, d.body);
    if (!samePos(o, p)) continue;
    if (d.body !== 0 && d.body !== p.body) continue;
    return d.unit;
  }
  return null;
}
/** The occupied-position question PlacePin asks in sync mode (verbatim). */
export const OCCUPIED_MSG = (unit: number) => `This position is already occupied by another pin, in unit ${unit}.`;
export const OCCUPIED_EXT = "Disable the 'Synchronized Pins Mode' option to avoid this message.";

/** CreateImagePins: in sync mode a new unit-specific pin gets a copy in every other unit, numbered "<num>-U<letter>". */
export function imagePins(sym: Node, p: PinInfo): PinInfo[] {
  if (p.unit === 0) return [];
  const out: PinInfo[] = []; const n = unitCount(sym);
  for (let u = 1; u <= n; u++) { if (u === p.unit) continue; out.push(Object.assign({}, p, { unit: u, number: `${p.number}-U${String.fromCharCode(65 + u - 1)}`, alternates: p.alternates.map((a) => ({ ...a })) })); }
  return out;
}
/** Place a pin: the pin plus (sync) its images, added to the symbol.  Returns the main pin's ref. */
export function placePin(sym: Node, p: PinInfo, sync: boolean): ItemRef {
  const ref = addDrawItem(sym, p.unit, p.body, pinNode(p));
  if (sync) for (const im of imagePins(sym, p)) addDrawItem(sym, im.unit, im.body, pinNode(im));
  return findRef(sym, itemAt(sym, ref)) || ref;
}
/** Where a node lives now (indices move as items are added before it). */
export function findRef(sym: Node, n: Node | null): ItemRef | null { if (!n) return null; for (const d of drawItems(sym)) if (d.node === n) return { sub: d.sub, j: d.j, unit: d.unit, body: d.body }; return null; }

/**
 * SYMBOL_EDITOR_PIN_TOOL::SynchronizeOtherUnits: after a pin edit, the first matching pin of every other unit (same
 * position, orientation, type, visibility and name as the pin before the edit) takes the edit; one made redundant by
 * unit 0 / body style 0 is removed.  `pin` is the edited node (already rewritten), `before` the original.  Returns
 * the number of pins removed.
 */
export function synchronizeOtherUnits(sym: Node, pin: Node, before: PinInfo): number {
  const now = findRef(sym, pin); if (!now) return 0;
  const a = pinInfo(pin, now.unit, now.body);
  const n = unitCount(sym); const got = new Array<boolean>(n + 1).fill(false);
  const mark = (u: number) => { if (u >= 0 && u <= n) got[u] = true; }; const done = (u: number) => u >= 0 && u <= n && got[u];
  mark(a.unit);
  const doomed: Node[] = [];
  for (const d of allPins(sym)) {
    if (d.node === pin || done(d.unit)) continue;
    const o = pinInfo(d.node, d.unit, d.body);
    if (!samePos(o, before) || o.orient !== before.orient || o.type !== before.type || o.visible !== before.visible || o.name !== before.name) continue;
    if (d.body === a.body) { changeLength(o, a.length); o.x = a.x; o.y = a.y; o.shape = a.shape; }
    o.orient = a.orient; o.type = a.type; o.visible = a.visible; o.name = a.name; o.nameSize = a.nameSize; o.numSize = a.numSize;
    setPin(d.node, o); mark(d.unit);
    const coversBody = a.body === 0 && (a.unit === 0 || d.unit === a.unit);
    const coversUnits = a.unit === 0 && (a.body === 0 || d.body === a.body);
    if (coversBody || coversUnits) doomed.push(d.node);
  }
  for (const dn of doomed) { const r = findRef(sym, dn); if (r) removeDrawItem(sym, r); }
  return doomed.length;
}
/** Move a pin to another unit / body style (the dialog's "Common to all units / body styles"). */
export function relocatePin(sym: Node, pin: Node, unit: number, body: number): Node {
  const r = findRef(sym, pin); if (!r || (r.unit === unit && r.body === body)) return pin;
  removeDrawItem(sym, r); addDrawItem(sym, unit, body, pin); return pin;
}

/** IncrementString (common/increment.cpp): the last run of digits steps, leading zeros kept; false below zero. */
export function incrementString(name: string, delta: number): string {
  if (!name) return name;
  let i = name.length - 1; while (i >= 0 && !/[0-9]/.test(name[i])) i--;
  const sufStart = i + 1; let j = i; while (j >= 0 && /[0-9]/.test(name[j])) j--;
  const digits = name.slice(j + 1, sufStart); if (!digits) return name;
  const v = parseInt(digits, 10) + delta; if (v <= -1) return name;
  return name.slice(0, j + 1) + String(v).padStart(digits.length, "0") + name.slice(sufStart);
}
/** RepeatPin: a copy one pin_step along (Y for left / right pins, X for up / down), name and number incremented. */
export function repeatPin(src: PinInfo, step = DEFAULTS.pinStep, delta = DEFAULTS.labelDelta): PinInfo {
  const p: PinInfo = Object.assign({}, src, { alternates: src.alternates.map((a) => ({ ...a })) });
  // internal (Y down) step.y = +pin_step is file y - pin_step
  if (p.orient === 0 || p.orient === 180) p.y = +fmt(p.y - step); else p.x = +fmt(p.x + step);
  p.name = incrementString(p.name, delta); p.number = incrementString(p.number, delta);
  return p;
}
/** PushPinProperties: one value of a pin copied to every other pin. */
export function pushPinProperty(sym: Node, src: Node, what: "length" | "nameSize" | "numSize", curBody: number): number {
  const s = pinInfo(src); let n = 0;
  for (const d of allPins(sym)) {
    if (d.node === src) continue; const o = pinInfo(d.node, d.unit, d.body);
    if (what === "length") { if (d.body === 0 || d.body === curBody) changeLength(o, s.length); else continue; }
    else if (what === "nameSize") o.nameSize = s.nameSize; else o.numSize = s.numSize;
    setPin(d.node, o); n++;
  }
  return n;
}

// ---------------------------------------------------------------- fields
export function fieldNode(name: string, value: string, x: number, y: number, hidden: boolean, extra = ""): Node {
  return node(`(property ${q(name)} ${q(value)} (at ${fmt(x)} ${fmt(y)} 0) (show_name no) (do_not_autoplace no)${hidden ? " (hide yes)" : ""} (effects (font (size 1.27 1.27))${extra}))`);
}
export function fieldOf(sym: Node, name: string): Node | null { for (const p of kids(sym, "property")) if (str(p[1]) === name) return p; return null; }
export function fieldValue(sym: Node, name: string): string { const p = fieldOf(sym, name); return p ? str(p[2]) : ""; }
export function setFieldValue(sym: Node, name: string, value: string): void { const p = fieldOf(sym, name); if (p) p[2] = value; }

// ---------------------------------------------------------------- whole symbols
export interface NewSymbolProps {
  name: string; parent?: string | null; reference: string; unitCount: number; unitsInterchangeable: boolean; alternateBodyStyle: boolean;
  power: boolean; pinNameInside: boolean; pinTextPosition: number; showPinNumber: boolean; showPinName: boolean; includeInBom: boolean; includeOnBoard: boolean;
  keepFootprint?: boolean; keepDatasheet?: boolean; transferUserFields?: boolean; keepContentUserFields?: boolean;
}
export function defaultNewSymbolProps(): NewSymbolProps {
  return { name: "", parent: null, reference: "U", unitCount: 1, unitsInterchangeable: false, alternateBodyStyle: false, power: false, pinNameInside: true, pinTextPosition: DEFAULT_PIN_NAME_OFFSET,
    showPinNumber: true, showPinName: true, includeInBom: true, includeOnBoard: true, keepFootprint: true, keepDatasheet: true, transferUserFields: true, keepContentUserFields: false };
}
const yn = (b: boolean) => (b ? "yes" : "no");
/** LIB_SYMBOL_LIBRARY_MANAGER::CreateSymbol, written the way SaveSymbol writes the result. */
export function createSymbol(p: NewSymbolProps, parent?: Node | null): Node {
  const name = p.name;
  if (parent) {
    let s = `(symbol ${q(name)} (extends ${q(symName(parent))})`;
    const powerParent = isPower(parent);
    for (const f of MANDATORY_FIELDS) {
      const pf = fieldOf(parent, f); if (!pf) continue; const c = clone(pf);
      if (f === "Value" && powerParent) c[2] = name;
      if (f === "Footprint" && !p.keepFootprint) c[2] = "";
      if (f === "Datasheet" && !p.keepDatasheet) c[2] = "";
      s += " " + text(c);
    }
    if (p.transferUserFields) for (const pf of kids(parent, "property")) { const f = str(pf[1]); if (MANDATORY_FIELDS.includes(f) || f.startsWith("ki_")) continue; const c = clone(pf); if (!p.keepContentUserFields) c[2] = ""; s += " " + text(c); }
    return node(s + " (embedded_fonts no))");
  }
  const units = Math.max(1, p.unitCount | 0);
  let offset = DEFAULT_PIN_NAME_OFFSET;
  if (p.pinNameInside) { offset = p.pinTextPosition; if (!offset) offset = 0.0001; } else offset = 0;
  const locked = units >= 2 && !p.unitsInterchangeable;
  let s = `(symbol ${q(name)}`;
  if (p.power) s += " (power global)";
  if (p.alternateBodyStyle) s += " (body_styles demorgan)";
  if (!p.showPinNumber) s += " (pin_numbers (hide yes))";
  if (Math.abs(offset - DEFAULT_PIN_NAME_OFFSET) > 1e-9 || !p.showPinName) s += " (pin_names" + (Math.abs(offset - DEFAULT_PIN_NAME_OFFSET) > 1e-9 ? ` (offset ${fmt(offset)})` : "") + (p.showPinName ? "" : " (hide yes)") + ")";
  s += ` (exclude_from_sim no) (in_bom ${yn(p.includeInBom)}) (on_board ${yn(p.includeOnBoard)}) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no)`;
  s += " " + text(fieldNode("Reference", p.reference, 0, 0, false)) + " " + text(fieldNode("Value", p.power ? name : name, 0, 0, false));
  s += " " + text(fieldNode("Footprint", "", 0, 0, true)) + " " + text(fieldNode("Datasheet", "", 0, 0, true)) + " " + text(fieldNode("Description", "", 0, 0, true));
  if (locked) s += " " + text(fieldNode("ki_locked", "", 0, 0, false));
  const base = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  // KiCad's LIB_SYMBOL keeps a (possibly empty) unit for every unit / body style it was given
  for (let u = 1; u <= units; u++) for (let b = 1; b <= (p.alternateBodyStyle ? 2 : 1); b++) s += ` (symbol ${q(base + "_" + u + "_" + b)})`;
  return node(s + " (embedded_fonts no))");
}
/** LIB_SYMBOL::Flatten: a derived symbol with its parent's drawing, pin settings and attributes, its own fields. */
export function flatten(lib: SymLib | null, sym: Node): Node {
  if (!isDerived(sym)) return clone(sym);
  const parent = lib ? lib.symbols.get(parentNameOf(sym)!) : null; if (!parent) return clone(sym);
  const root = flatten(lib, parent);
  const out: Node = ["symbol", sym[1]];
  const mine = new Map<string, Node>(); for (const p of kids(sym, "property")) mine.set(str(p[1]), p);
  for (let j = 2; j < root.length; j++) {
    const c = root[j]; if (!isList(c)) { out.push(c); continue; }
    if (c[0] === "property") { const own = mine.get(str(c[1])); if (own) { out.push(clone(own)); mine.delete(str(c[1])); } else out.push(clone(c)); continue; }
    if (c[0] === "symbol") { const sub = clone(c); sub[1] = baseName(sym) + str(c[1]).slice(baseName(root).length); out.push(sub); continue; }
    if (c[0] === "embedded_fonts" || c[0] === "embedded_files") continue;
    out.push(clone(c));
  }
  // the derived symbol's own extra fields go after the last field
  let at = -1; for (let j = 1; j < out.length; j++) if (isList(out[j]) && (out[j] as Node)[0] === "property") at = j;
  out.splice(at + 1, 0, ...Array.from(mine.values()).map(clone));
  const ef = kid(sym, "embedded_fonts"); out.push(ef ? clone(ef) : node("(embedded_fonts no)"));
  return node(text(out));
}
/** Rename a symbol (SYMBOL_EDIT_FRAME::UpdateSymbolMsgPanelInfo / RenameSymbol): its sub-symbols follow, a Value equal to the old name follows, and every derived symbol's (extends …) is rewritten. */
export function renameSymbol(lib: SymLib, oldName: string, newName: string): string[] {
  const sym = lib.symbols.get(oldName); if (!sym) return [];
  const touched = [oldName, newName];
  const ob = oldName.includes(":") ? oldName.slice(oldName.indexOf(":") + 1) : oldName, nb = newName.includes(":") ? newName.slice(newName.indexOf(":") + 1) : newName;
  sym[1] = newName;
  for (const s of kids(sym, "symbol")) { const n = str(s[1]); if (n.startsWith(ob + "_")) s[1] = nb + n.slice(ob.length); }
  const v = fieldOf(sym, "Value"); if (v && str(v[2]) === oldName) v[2] = newName;
  const order = Array.from(lib.symbols.entries()); lib.symbols.clear();
  for (const [k, s] of order) lib.symbols.set(k === oldName ? newName : k, s);
  for (const [k, s] of lib.symbols) { const e = kid(s, "extends"); if (e && str(e[1]) === oldName) { e[1] = newName; touched.push(k); } }
  return touched;
}
/** The derived symbols of `name` in a library, all generations. */
export function derivedOf(lib: SymLib, name: string): string[] {
  const out: string[] = []; const walk = (p: string) => { for (const [k, s] of lib.symbols) if (parentNameOf(s) === p && !out.includes(k)) { out.push(k); walk(k); } };
  walk(name); return out;
}
/** SetUnitCount( n, true ): units above n lose their items; new units get an (empty) sub-symbol. */
export function setUnitCount(sym: Node, n: number): void {
  for (let j = sym.length - 1; j >= 1; j--) { const c = sym[j]; if (isList(c) && c[0] === "symbol") { const [u] = subUnitBody(str(c[1])); if (u > n) sym.splice(j, 1); } }
  const bs = bodyStyles(sym).count; for (let u = 1; u <= n; u++) for (let b = 1; b <= bs; b++) ensureSub(sym, u, b);
}
/** De Morgan on / off (DIALOG_LIB_SYMBOL_PROPERTIES Units & Body Styles). */
export function setDeMorgan(sym: Node, on: boolean): void {
  const i = sym.findIndex((c, j) => j > 0 && isList(c) && c[0] === "body_styles");
  if (on) { if (i < 0) { const at = sym.findIndex((c, j) => j > 0 && isList(c) && c[0] !== "power"); sym.splice(at > 0 ? at : sym.length, 0, node("(body_styles demorgan)")); } }
  else { if (i > 0) sym.splice(i, 1); for (let j = sym.length - 1; j >= 1; j--) { const c = sym[j]; if (isList(c) && c[0] === "symbol" && subUnitBody(str(c[1]))[1] > 1) sym.splice(j, 1); } }
}
/** The body style mode the Units & Body Styles page shows: single, De Morgan, or custom names. */
export type BodyMode = "single" | "demorgan" | "custom";
export function bodyMode(sym: Node): BodyMode { const b = bodyStyles(sym); return b.demorgan ? "demorgan" : b.count > 1 ? "custom" : "single"; }
/**
 * DIALOG_LIB_SYMBOL_PROPERTIES::TransferDataFromWindow's body style branch: LIB_SYMBOL::SetBodyStyleCount (body 1's
 * pins, and for custom styles its drawings too, copied into each new style; styles past the count pruned), then the
 * De Morgan flag and the names, written as SaveSymbol does ((body_styles demorgan) / (body_styles "A" "B")).
 */
export function setBodyStyles(sym: Node, mode: BodyMode, names: string[] = []): void {
  const cur = bodyStyles(sym), curMode = bodyMode(sym);
  if (mode === curMode && (mode !== "custom" || JSON.stringify(cur.names) === JSON.stringify(names))) return;
  const prev = curMode === "single" ? 1 : cur.count;
  const count = mode === "single" ? 1 : mode === "demorgan" ? 2 : Math.max(1, names.length);
  const dupDraw = mode === "custom", dupPins = mode !== "single";
  if (prev < count && (dupDraw || dupPins)) {
    const adds: [number, number, Node][] = [];
    for (const sub of kids(sym, "symbol")) {
      const [u, b] = subUnitBody(str(sub[1])); if (b !== 1) continue;
      for (const c of sub.slice(2)) {
        if (!isList(c) || c[0] === "unit_name") continue;
        if (c[0] === "pin" ? !dupPins : !dupDraw) continue;
        for (let j = prev + 1; j <= count; j++) adds.push([u, j, clone(c)]);
      }
    }
    for (const [u, b, n] of adds) addDrawItem(sym, u, b, n);
  }
  for (let j = sym.length - 1; j >= 1; j--) { const c = sym[j]; if (isList(c) && c[0] === "symbol" && subUnitBody(str(c[1]))[1] > count) sym.splice(j, 1); }   // PruneBodyStyleDrawItems
  const i = sym.findIndex((c, j) => j > 0 && isList(c) && c[0] === "body_styles");
  if (i > 0) sym.splice(i, 1);
  if (mode !== "single") {
    const tok = node(mode === "demorgan" ? "(body_styles demorgan)" : `(body_styles ${names.map(q).join(" ")})`);
    const pw = sym.findIndex((c, j) => j > 0 && isList(c) && c[0] === "power");
    const at = pw > 0 ? pw + 1 : sym.findIndex((c, j) => j > 1 && isList(c));
    sym.splice(at > 0 ? at : sym.length, 0, tok);
  }
}
/** LIB_SYMBOL::GetUnitDisplayNames written back: (unit_name …) first in every "Name_u_b" sub-symbol of a named unit. */
export function setUnitNames(sym: Node, names: Map<number, string>): void {
  const was = unitNames(sym);
  if (was.size === names.size && [...names].every(([u, n]) => was.get(u) === n)) return;
  for (const sub of kids(sym, "symbol")) {
    const [u] = subUnitBody(str(sub[1])); const i = sub.findIndex((c, j) => j > 1 && isList(c) && c[0] === "unit_name");
    const n = u > 0 ? names.get(u) : undefined;
    if (i > 0) { if (n) (sub[i] as Node)[1] = n; else sub.splice(i, 1); }
    else if (n) sub.splice(2, 0, node(`(unit_name ${q(n)})`));
  }
}
/** (jumper_pin_groups ("1" "2") …): each group's pin numbers, as LIB_SYMBOL::JumperPinGroups. */
export function jumperGroups(sym: Node): string[][] { const g = kid(sym, "jumper_pin_groups"); return g ? (g.slice(1).filter(isList) as Node[]).map((grp) => grp.map((x) => str(x))) : []; }
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Parse the Pin Connections grid rows (", \t\r\n" separated) into groups, std::set order; an error names the missing pin. */
export function parseJumperGroups(rows: string[], hasPin: (n: string) => boolean): { groups: string[][] } | { error: string } {
  const groups: string[][] = [];
  for (let ii = 0; ii < rows.length; ii++) {
    const names = new Set<string>();
    for (const tok of rows[ii].split(/[, \t\r\n]+/)) { if (!tok) continue; if (!hasPin(tok)) return { error: `Pin '${tok}' in jumper pin group ${ii + 1} does not exist in this symbol.` }; names.add(tok); }
    if (names.size) groups.push([...names].sort(cmpStr));
  }
  return { groups };
}
/** Write (jumper_pin_groups …) after the attribute flags, or drop it when there are none; untouched when unchanged. */
export function setJumperGroups(sym: Node, groups: string[][]): void {
  if (JSON.stringify(jumperGroups(sym)) === JSON.stringify(groups)) return;
  const i = sym.findIndex((c, j) => j > 0 && isList(c) && c[0] === "jumper_pin_groups");
  if (i > 0) sym.splice(i, 1);
  if (!groups.length) return;
  const tok = node(`(jumper_pin_groups ${groups.map((g) => "(" + g.map(q).join(" ") + ")").join(" ")})`);
  let at = -1; for (let j = 1; j < sym.length; j++) { const c = sym[j]; if (isList(c) && ["power", "body_styles", "pin_numbers", "pin_names", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "duplicate_pin_numbers_are_jumpers"].includes(String(c[0]))) at = j; }
  if (at < 0) at = sym.findIndex((c, j) => j > 1 && isList(c)) - 1;
  sym.splice(at < 0 ? sym.length : at + 1, 0, tok);
}
/** LIB_SYMBOL::HasPinNumber over every unit and body style. */
export function hasPinNumber(sym: Node, n: string): boolean { for (const sub of kids(sym, "symbol")) for (const p of kids(sub, "pin")) { const num2 = kid(p, "number"); if (num2 && str(num2[1]) === n) return true; } return false; }

// ---------------------------------------------------------------- Symbol Checker
export type Fmt = (mm: number) => string;
const defaultFmt: Fmt = (mm) => fmt(mm) + " mm";
/** CheckLibSymbol: the HTML messages HTML_MESSAGE_BOX lists, in KiCad's words. `gridMm` is the pin grid (25 mil minimum). */
export function checkSymbol(sym: Node, gridMm = 50 * MIL, f: Fmt = defaultFmt): string[] {
  const msgs: string[] = [];
  const ref = fieldValue(sym, "Reference");
  if (!ref) msgs.push("<b>Warning: reference is empty</b><br><br>");
  else if ("0123456789?".includes(ref[ref.length - 1])) msgs.push("<b>Warning: reference prefix</b><br>prefix ending by '0123456789?' can create issues if saved in a symbol library<br><br>");
  const bs = bodyStyles(sym); const multiBody = bs.count > 1; const units = unitCount(sym);
  const pins = allPins(sym).map((d) => ({ ...pinInfo(d.node, d.unit, d.body), node: d.node }));
  // CheckDuplicatePins
  const logical: { p: typeof pins[number]; number: string }[] = [];
  for (const p of pins) { const st = stackedNumbers(p.number); if (!st) logical.push({ p, number: p.number }); else for (const n of st) logical.push({ p, number: n }); }
  logical.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) || (a.p.body - b.p.body) || (a.p.unit - b.p.unit) || (pins.indexOf(a.p) - pins.indexOf(b.p)));
  const unitName = (u: number) => { const nm = unitNames(sym).get(u); return nm || unitLetter(u); };
  for (let i = 1; i < logical.length; i++) {
    const prev = logical[i - 1], next = logical[i];
    if (prev.number !== next.number || prev.p === next.p) continue;
    if (prev.p.body !== 0 && next.p.body !== 0 && prev.p.body !== next.p.body) continue;
    const pinName = prev.p.name ? " '" + prev.p.name + "'" : "", nextName = next.p.name ? " '" + next.p.name + "'" : "";
    const shown = (p: typeof pins[number], n: string) => (p.number === n ? n : `${n} (${p.number})`);
    const pn = shown(prev.p, prev.number), nn = shown(next.p, next.number);
    const at = (p: PinInfo) => `<b>(${f(p.x)}, ${f(p.y)})</b>`;
    let m: string;
    if (multiBody && next.p.body) {
      if (prev.p.unit === 0 || next.p.unit === 0) m = `<b>Duplicate pin ${nn}</b> ${nextName} at location ${at(next.p)} conflicts with pin ${pn}${prev.p.name} at location ${at(prev.p)} in ${bodyStyleDescription(sym, prev.p.body).toLowerCase()} body style.`;
      else m = `<b>Duplicate pin ${nn}</b> ${nextName} at location ${at(next.p)} conflicts with pin ${pn}${pinName} at location ${at(prev.p)} in units ${unitName(next.p.unit)} and ${unitName(prev.p.unit)} of ${bodyStyleDescription(sym, prev.p.body).toLowerCase()} body style.`;
    } else if (prev.p.unit === 0 || next.p.unit === 0) m = `<b>Duplicate pin ${nn}</b> ${nextName} at location ${at(next.p)} conflicts with pin ${pn}${pinName} at location ${at(prev.p)}.`;
    else m = `<b>Duplicate pin ${nn}</b> ${nextName} at location ${at(next.p)} conflicts with pin ${pn}${pinName} at location ${at(prev.p)} in units ${unitName(next.p.unit)} and ${unitName(prev.p.unit)}.`;
    msgs.push(m + "<br><br>");
  }
  const sorted = pins.slice().sort((a, b) => numCompare(a.number, b.number));
  const grid = Math.max(gridMm, 25 * MIL);
  if (isPower(sym)) {
    if (units !== 1) msgs.push("<b>A Power Symbol should have only one unit</b><br><br>");
    if (!sorted.length) msgs.push("<b>A Power Symbol should have exactly one pin</b><br><br>");
    else {
      if (sorted.length > 1) msgs.push("<b>A Power Symbol should have only one pin</b><br><br>");
      const p = sorted[0];
      if (p.type !== "power_in" && p.type !== "power_out") msgs.push("<b>Suspicious Power Symbol</b><br>Only an input or output power pin has meaning<br><br>");
      if (p.type === "power_in" && !p.visible) msgs.push("<b>Suspicious Power Symbol</b><br>Invisible input power pins are no longer required<br><br>");
    }
  }
  const globalPower = (() => { const pw = kid(sym, "power"); return !!pw && str(pw[1]) !== "local"; })();
  for (const p of sorted) {
    const pinName = !p.name || p.name === "~" ? "" : "'" + p.name + "'";
    const at = `<b>(${f(p.x)}, ${f(p.y)})</b>`; const letter = String.fromCharCode(65 + p.unit - 1);
    const where = (lead: string): string => {
      if (multiBody && p.body) return units <= 1 ? `${lead} ${p.number}</b> ${pinName} at location ${at} in ${bodyStyleDescription(sym, p.body).toLowerCase()} body style.` : `${lead} ${p.number}</b> ${pinName} at location ${at} in unit ${letter} of ${bodyStyleDescription(sym, p.body).toLowerCase()} body style.`;
      return units <= 1 ? `${lead} ${p.number}</b> ${pinName} at location ${at}.` : `${lead} ${p.number}</b> ${pinName} at location ${at} in unit ${letter}.`;
    };
    if (!globalPower && p.type === "power_in" && !p.visible) msgs.push("Info: " + where("<b>Hidden power pin") + "<br>(Hidden power pins will drive their pin names on to any connected nets.)<br><br>");
    const iu = (v: number) => Math.round(v * 1e4), g = Math.round(grid * 1e4);
    if (iu(p.x) % g !== 0 || iu(p.y) % g !== 0) {
      // " of %s body style" for the single-unit case, " in unit %c of %s body style" otherwise (symbol_checker.cpp:364-385)
      let m = where("<b>Off grid pin"); if (multiBody && p.body && units <= 1) m = m.replace(" in " + bodyStyleDescription(sym, p.body).toLowerCase(), " of " + bodyStyleDescription(sym, p.body).toLowerCase());
      msgs.push(m + "<br><br>");
    }
  }
  // CheckLibSymbolGraphics
  for (const d of drawItems(sym)) {
    const g = d.node, k = String(g[0]);
    if (k === "circle") { const r = kid(g, "radius"), c = kid(g, "center"); if (!r || num(r[1]) <= 0) msgs.push(`<b>Graphic circle has radius = 0</b> at location <b>(${f(c ? num(c[1]) : 0)}, ${f(c ? num(c[2]) : 0)})</b>.<br>`); }
    else if (k === "rectangle") { const s = kid(g, "start"), e = kid(g, "end"); if (s && e && num(s[1]) === num(e[1]) && num(s[2]) === num(e[2])) msgs.push(`<b>Graphic rectangle has size 0</b> at location <b>(${f(num(s[1]))}, ${f(num(s[2]))})</b>.<br>`); }
    else if (k === "ellipse" || k === "ellipse_arc") { const a = kid(g, "major_radius") || kid(g, "radius_x"), b = kid(g, "minor_radius") || kid(g, "radius_y"); const c = kid(g, "center"); if ((a && num(a[1]) <= 0) || (b && num(b[1]) <= 0)) msgs.push(`<b>Graphic ellipse has null or negative radii</b> at location <b>(${f(c ? num(c[1]) : 0)}, ${f(c ? num(c[2]) : 0)})</b>.<br>`); }
  }
  return msgs;
}
/** SCH_PIN::GetStackedPinNumbers: "[1,2,5-7]" -> its numbers; null when not a valid stacked list. */
export function stackedNumbers(n: string): string[] | null {
  const m = /^\[(.*)\]$/.exec(n); if (!m) return null;
  const out: string[] = [];
  for (const part of m[1].split(",")) { const t = part.trim(); const r = /^(\d+)-(\d+)$/.exec(t); if (r) { for (let i = +r[1]; i <= +r[2]; i++) out.push(String(i)); } else if (t) out.push(t); else return null; }
  return out.length ? out : null;
}
/** StrNumCmp-style pin number order (sort_by_pin_number). */
export function numCompare(a: string, b: string): number { return a.localeCompare(b, undefined, { numeric: true }); }

// ---------------------------------------------------------------- schematic instance <-> library
/**
 * LoadSymbolFromSchematic: the instance's fields moved back into library space — mirror undone first, then the
 * rotation (90 swaps x,y and negates x; 270 swaps and negates y; 180 negates both), in internal (Y down) units;
 * the library file stores the negated Y.  `lib` is the flattened library copy (changed in place and returned).
 */
export function instanceToLibrary(instance: Node, lib: Node): Node {
  const at = kid(instance, "at"); const sx = at ? num(at[1]) : 0, sy = at ? num(at[2]) : 0, srot = at ? ((Math.round(num(at[3])) % 360) + 360) % 360 : 0;
  const m = kid(instance, "mirror"); const mirror = m ? str(m[1]) : "";
  const fields: Node[] = [];
  for (const p of kids(instance, "property")) {
    const f = clone(p); const a = kid(f, "at");
    if (a) {
      let x = num(a[1]) - sx, y = num(a[2]) - sy;   // internal units: Y down
      if (mirror === "x") y = -y; else if (mirror === "y") x = -x;
      if (srot === 90) { const t = x; x = y; y = t; x = -x; }
      else if (srot === 270) { const t = x; x = y; y = t; y = -y; }
      else if (srot === 180) { x = -x; y = -y; }
      a[1] = +fmt(x); a[2] = +fmt(-y);
    }
    // a placed field may carry (uuid …) and instance-only tokens the library format lacks
    for (let j = f.length - 1; j >= 1; j--) if (isList(f[j]) && (f[j] as Node)[0] === "uuid") f.splice(j, 1);
    fields.push(f);
  }
  // SetFields( fullSetOfFields ): the library's own fields are replaced, ki_ metadata kept
  const meta = kids(lib, "property").filter((p) => str(p[1]).startsWith("ki_"));
  for (let j = lib.length - 1; j >= 1; j--) if (isList(lib[j]) && (lib[j] as Node)[0] === "property") lib.splice(j, 1);
  let ins = -1; for (let j = 1; j < lib.length; j++) { const c = lib[j]; if (isList(c) && ["exclude_from_sim", "in_bom", "on_board", "in_pos_files", "duplicate_pin_numbers_are_jumpers", "jumper_pin_groups", "pin_names", "pin_numbers", "power", "body_styles"].includes(String(c[0]))) ins = j; }
  lib.splice(ins + 1, 0, ...fields, ...meta);
  return lib;
}
/**
 * SCH_SYMBOL::UpdateFields( path, update style, update ref, update other fields, no reset ) on a placed symbol from
 * the edited library symbol: every library field (by name) is imported — text, effects, visibility — at the symbol
 * position plus the library offset (internal units), the Reference through the instance data.  Instance-only fields
 * stay.  Returns the new node.
 */
export function updateInstanceFields(instance: Node, lib: Node): Node {
  const n = clone(instance); const at = kid(n, "at"); const sx = at ? num(at[1]) : 0, sy = at ? num(at[2]) : 0;
  for (const lf of kids(lib, "property")) {
    const name = str(lf[1]); if (name.startsWith("ki_")) continue;
    const la = kid(lf, "at"); const lx = la ? num(la[1]) : 0, ly = la ? num(la[2]) : 0, lr = la ? num(la[3]) : 0;
    let f = n.find((c, j) => j > 0 && isList(c) && c[0] === "property" && str((c as Node)[1]) === name) as Node | undefined;
    const fresh = clone(lf); const fa = kid(fresh, "at"); if (fa) { fa[1] = +fmt(sx + lx); fa[2] = +fmt(sy - ly); fa[3] = lr; }
    if (f) { const u = kid(f, "uuid"); const i = n.indexOf(f); n[i] = fresh; if (u) fresh.push(u); f = fresh; }
    else { let last = -1; for (let j = 1; j < n.length; j++) if (isList(n[j]) && (n[j] as Node)[0] === "property") last = j; n.splice(last + 1, 0, fresh); }
    if (name === "Reference") {
      const inst = kid(n, "instances");
      if (inst) for (const pr of kids(inst, "project")) for (const path of kids(pr, "path")) { const r = kid(path, "reference"); if (r) r[1] = str(lf[2]); }
    }
  }
  return n;
}
/** The library pins a placed symbol carries (pin "number" (uuid …)), one per number, alternates no longer offered cleared. */
export function updateInstancePins(n: Node, lib: Node, newUuid: () => string, clearOrphanAlts: boolean): void {
  const old = new Map<string, Node>(); for (const p of kids(n, "pin")) old.set(str(p[1]), p);
  const out: Node[] = []; const seen = new Set<string>();
  for (const sub of kids(lib, "symbol")) {
    const [, b] = subUnitBody(str(sub[1])); if (b > 1) continue;
    for (const lp of kids(sub, "pin")) {
      const nb = kid(lp, "number"); const number = nb ? str(nb[1]) : ""; if (seen.has(number)) continue; seen.add(number);
      const mine = old.get(number); const p = mine ? clone(mine) : node(`(pin ${q(number)} (uuid ${q(newUuid())}))`);
      const ai = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === "alternate");
      if (ai > 0 && clearOrphanAlts) { const alt = str((p[ai] as Node)[1]); if (!kids(lp, "alternate").some((a) => str(a[1]) === alt)) p.splice(ai, 1); }
      out.push(p);
    }
  }
  for (let j = n.length - 1; j >= 1; j--) if (isList(n[j]) && (n[j] as Node)[0] === "pin") n.splice(j, 1);
  let at = -1; for (let j = 1; j < n.length; j++) if (isList(n[j]) && ((n[j] as Node)[0] === "property" || (n[j] as Node)[0] === "uuid")) at = j;
  n.splice(at + 1, 0, ...out);
}
/** SCH_SCREEN::Append's cache naming: an existing "<lib id>" or "<name>_<n>" copy equal to `copy` is reused, else the next free "<name>_<n>". */
export function cacheName(cache: Map<string, Node>, libId: string, copy: Node): { name: string; reused: boolean } {
  const item = libId.split(":").pop() || libId;
  const body = (n: Node): string => JSON.stringify(n.slice(2));   // structural: both sides parsed by the same reader
  const want = body(copy);
  const cands: string[] = []; if (cache.has(libId)) cands.push(libId);
  for (const k of cache.keys()) if (k.startsWith(item + "_") && /^\d+$/.test(k.slice(item.length + 1))) cands.push(k);
  for (const k of cands) { const c = cache.get(k)!; if (body(c) === want) return { name: k, reused: true }; }
  if (!cache.has(libId)) return { name: libId, reused: false };
  let i = 1; while (cache.has(`${item}_${i}`)) i++;
  return { name: `${item}_${i}`, reused: false };
}
/** The flattened library symbol as a schematic's (lib_symbols) entry named `name` (sub-symbols keep the item name). */
export function asCacheEntry(flat: Node, name: string): Node { const c = clone(flat); c[1] = name; const ef = c.findIndex((x, j) => j > 0 && isList(x) && x[0] === "embedded_fonts"); if (ef > 0 && kid(c, "embedded_files") === null) { /* keep */ } return c; }

// ---------------------------------------------------------------- pin table
/** A Pin Table row: positions as KiCad shows them (internal coordinates, Y down), not the file's Y up. */
export interface PinRow { count: number; number: string; name: string; type: string; shape: string; orient: number; numSize: number; nameSize: number; length: number; x: number; y: number; visible: boolean; unit: number; body: number; node?: Node | null }
export const PIN_TABLE_COLUMNS = ["Count", "Number", "Name", "Electrical Type", "Graphic Style", "Orientation", "Number Text Size", "Name Text Size", "Length", "X Position", "Y Position", "Visible", "Unit", "Body Style"];
export function pinRows(sym: Node): PinRow[] {
  return allPins(sym).map((d) => { const i = pinInfo(d.node, d.unit, d.body); return { count: 1, number: i.number, name: i.name, type: i.type, shape: i.shape, orient: i.orient, numSize: i.numSize, nameSize: i.nameSize, length: i.length, x: i.x, y: -i.y, visible: i.visible, unit: i.unit, body: i.body, node: d.node }; });
}
const typeName = (t: string) => (PIN_TYPES.find((p) => p[0] === t) || [t, t])[1];
const shapeName = (t: string) => (PIN_SHAPES.find((p) => p[0] === t) || [t, t])[1];
const orientName = (a: number) => (PIN_ORIENTATIONS.find((p) => p[0] === a) || [a, "Right"])[1];
const csvCell = (v: string) => (/[",\n\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
/** The table as CSV (Export … To File / To Clipboard), every column but Count, sizes and positions in `f`'s units. */
export function pinsToCsv(rows: PinRow[], sym: Node, f: Fmt = (mm) => fmt(mm), sep = ","): string {
  const unitLabel = (u: number) => (u === 0 ? "ALL" : unitLetter(u)); const bodyLabel = (b: number) => (b === 0 ? "ALL" : bodyStyleDescription(sym, b));
  const lines = [PIN_TABLE_COLUMNS.slice(1).join(sep)];
  for (const r of rows) lines.push([r.number, r.name, typeName(r.type), shapeName(r.shape), orientName(r.orient), f(r.numSize), f(r.nameSize), f(r.length), f(r.x), f(r.y), r.visible ? "1" : "0", unitLabel(r.unit), bodyLabel(r.body)].map((v) => sep === "," ? csvCell(String(v)) : String(v)).join(sep));
  return lines.join("\n") + "\n";
}
function splitCsv(line: string, sep: string): string[] {
  const out: string[] = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; } else if (c === '"') inQ = true; else if (c === sep) { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out;
}
/** Import (From File / From Clipboard): CSV or TSV with the export's header; `parseLen` reads a length in the user's units. */
export function pinsFromCsv(src: string, sym: Node, parseLen: (s: string) => number = (s) => Number(s)): PinRow[] {
  const lines = src.split(/\r?\n/).filter((l) => l.trim()); if (!lines.length) return [];
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const head = splitCsv(lines[0], sep).map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const back = <T>(list: [T, string][], v: string, d: T): T => { const hit = list.find((p) => p[1].toLowerCase() === v.trim().toLowerCase() || String(p[0]) === v.trim()); return hit ? hit[0] : d; };
  const bodyNames = bodyStyles(sym).names;
  const rows: PinRow[] = [];
  for (const line of lines.slice(1)) {
    const c = splitCsv(line, sep); const g = (n: string) => { const i = col(n); return i >= 0 ? (c[i] || "").trim() : ""; };
    const unitS = g("Unit"), bodyS = g("Body Style");
    const unit = !unitS || unitS.toUpperCase() === "ALL" ? 0 : /^\d+$/.test(unitS) ? +unitS : unitS.toUpperCase().split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
    const body = !bodyS || bodyS.toUpperCase() === "ALL" ? 0 : /^\d+$/.test(bodyS) ? +bodyS : Math.max(1, bodyNames.findIndex((n) => n.toLowerCase() === bodyS.toLowerCase()) + 1);
    rows.push({ count: 1, number: g("Number"), name: g("Name"), type: back(PIN_TYPES, g("Electrical Type"), "unspecified"), shape: back(PIN_SHAPES, g("Graphic Style"), "line"),
      orient: back(PIN_ORIENTATIONS, g("Orientation"), 0), numSize: parseLen(g("Number Text Size")) || 1.27, nameSize: parseLen(g("Name Text Size")) || 1.27,
      length: parseLen(g("Length")) || 2.54, x: parseLen(g("X Position")) || 0, y: parseLen(g("Y Position")) || 0, visible: !/^(0|false|no)$/i.test(g("Visible")), unit, body, node: null });
  }
  return rows;
}
/** The summary line of the pin table: a range summary of the numbers, the count and the duplicates. */
export function pinNumberSummary(rows: PinRow[]): { numbers: string; count: number; duplicates: string } {
  const nums = rows.map((r) => r.number).filter((n) => n !== "");
  const counts = new Map<string, number>(); for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  const dups = Array.from(counts.entries()).filter(([, c]) => c > 1).map(([n]) => n).sort(numCompare);
  const uniq = Array.from(counts.keys()).sort(numCompare);
  // PIN_NUMBERS::GetSummary: runs of consecutive numbers with the same prefix collapse to "a-b"
  const parts: string[] = []; let i = 0;
  while (i < uniq.length) {
    const m0 = /^(.*?)(\d+)$/.exec(uniq[i]); if (!m0) { parts.push(uniq[i]); i++; continue; }
    let j = i; while (j + 1 < uniq.length) { const m1 = /^(.*?)(\d+)$/.exec(uniq[j + 1]), mj = /^(.*?)(\d+)$/.exec(uniq[j])!; if (!m1 || m1[1] !== m0[1] || +m1[2] !== +mj[2] + 1) break; j++; }
    parts.push(j > i ? `${uniq[i]}-${uniq[j]}` : uniq[i]); i = j + 1;
  }
  return { numbers: parts.join(", "), count: nums.length, duplicates: dups.join(", ") };
}
/**
 * Write a pin table back: every pin of the symbol replaced by the rows, in one whole-symbol change.  A row that came
 * from a pin keeps that pin's node — a row the user did not touch is written back exactly, an edited one keeps what
 * the table does not show (alternates, custom properties, …), as DIALOG_LIB_EDIT_PIN_TABLE edits the SCH_PIN copies.
 */
export function applyPinRows(sym: Node, rows: PinRow[]): void {
  for (const d of allPins(sym).reverse()) removeDrawItem(sym, d);
  for (const r of rows) {
    const keepAlts = r.node ? kids(r.node, "alternate").map((a) => ({ name: str(a[1]), type: str(a[2]), shape: str(a[3]) })) : [];
    const info: PinInfo = { type: r.type, shape: r.shape, x: r.x, y: -r.y, orient: r.orient, length: r.length, visible: r.visible, name: r.name, number: r.number, nameSize: r.nameSize, numSize: r.numSize, unit: r.unit, body: r.body, alternates: keepAlts };
    let n: Node;
    if (r.node) {
      n = clone(r.node);
      const o = pinInfo(n);
      const same = o.type === info.type && o.shape === info.shape && o.x === info.x && o.y === info.y && o.orient === info.orient && o.length === info.length && o.visible === info.visible
        && o.name === info.name && o.number === info.number && o.nameSize === info.nameSize && o.numSize === info.numSize;
      if (!same) setPin(n, info);
    } else n = pinNode(info);
    addDrawItem(sym, r.unit, r.body, n);
  }
}

// ---------------------------------------------------------------- shapes
/** A new graphic as SaveSymbol writes it (stroke width 0 = default, type default; fill none). */
export function shapeNode(kind: "rectangle" | "circle" | "arc" | "polyline" | "bezier", pts: number[][], fill = "none", width = 0): Node {
  const st = ` (stroke (width ${fmt(width)}) (type default)) (fill (type ${fill}))`;
  if (kind === "rectangle") return node(`(rectangle (start ${fmt(pts[0][0])} ${fmt(pts[0][1])}) (end ${fmt(pts[1][0])} ${fmt(pts[1][1])})${st})`);
  if (kind === "circle") { const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]); return node(`(circle (center ${fmt(pts[0][0])} ${fmt(pts[0][1])}) (radius ${fmt(r)})${st})`); }
  if (kind === "arc") return node(`(arc (start ${fmt(pts[0][0])} ${fmt(pts[0][1])}) (mid ${fmt(pts[1][0])} ${fmt(pts[1][1])}) (end ${fmt(pts[2][0])} ${fmt(pts[2][1])})${st})`);
  return node(`(${kind} (pts ${pts.map((p) => `(xy ${fmt(p[0])} ${fmt(p[1])})`).join(" ")})${st})`);
}
/**
 * ARC_TANGENT's seed: the direction a line or arc of `sym` leaves the point `p` with (a polyline end or an arc end,
 * pointing away from the shape, as the next arc continues it), or null when no shape ends at `p`.  File coordinates.
 */
export function arcTangentSeed(sym: Node, p: number[], unit = 0, body = 0, eps = 1e-6): number[] | null {
  const same = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  const xy = (n: Node | null): number[] | null => (n ? [num(n[1]), num(n[2])] : null);
  for (const d of drawItems(sym)) {
    if ((d.unit && unit && d.unit !== unit) || (d.body && body && d.body !== body)) continue;
    const n = d.node;
    if (n[0] === "polyline") {
      const pts = (kid(n, "pts") || []).slice(1).filter(isList).map((q) => xy(q as Node)!) as number[][];
      if (pts.length < 2) continue;
      const k = pts.length - 1;
      if (same(pts[k], p)) return [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]];
      if (same(pts[0], p)) return [pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]];
    } else if (n[0] === "arc") {
      const a = xy(kid(n, "start")), m = xy(kid(n, "mid")), e = xy(kid(n, "end")); if (!a || !m || !e) continue;
      // the circle through start, mid, end; travel start -> mid -> end turns with the sign of the cross product
      const bx = e[0] - a[0], by = e[1] - a[1], cx = m[0] - a[0], cy = m[1] - a[1], dd = 2 * (bx * cy - by * cx); if (!dd) continue;
      const bb = bx * bx + by * by, cc = cx * cx + cy * cy;
      const c = [a[0] + (cy * bb - by * cc) / dd, a[1] + (bx * cc - cx * bb) / dd];
      const turn = Math.sign((m[0] - a[0]) * (e[1] - m[1]) - (m[1] - a[1]) * (e[0] - m[0]));
      const tan = (q: number[], dir: number) => { const r = [q[0] - c[0], q[1] - c[1]]; return [-r[1] * turn * dir, r[0] * turn * dir]; };
      if (same(e, p)) return tan(e, 1);
      if (same(a, p)) return tan(a, -1);
    }
  }
  return null;
}
// ---------------------------------------------------------------- ellipses (EDA_SHAPE / ELLIPSE_GEOM_MANAGER)
/** EDA_UNIT_UTILS::FormatAngle: fmt::format( "{:.10g}", degrees ). */
export function fmtAngle(deg: number): string {
  if (!isFinite(deg)) return "0";
  if (deg === 0) return Object.is(deg, -0) ? "-0" : "0";
  const e = Math.floor(Math.log10(Math.abs(deg)));
  const strip = (m: string) => (m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m);
  if (e < -4 || e >= 10) { const [m, x] = deg.toExponential(9).split("e"); const n = Number(x); return strip(m) + "e" + (n < 0 ? "-" : "+") + String(Math.abs(n)).padStart(2, "0"); }
  return strip(deg.toFixed(Math.max(0, 9 - e)));
}
const IU = 1e4;   // schIUScale: 100 nm
const iu = (mm: number): number => Math.round(mm * IU);
const tdiv = (a: number, b: number): number => Math.trunc(a / b);   // C++ integer division
export interface EllipseGeom { cx: number; cy: number; major: number; minor: number; rotation: number; start: number; end: number }
/**
 * ELLIPSE_GEOM_MANAGER::setBboxCorner2 / EDA_SHAPE::calcEdit (ELLIPSE): the ellipse inscribed in the box from corner `a`
 * to corner `b` (file millimetres, Y up), major axis along the longer side.  Done in internal units, Y down.
 */
export function ellipseFromBox(a: number[], b: number[]): EllipseGeom {
  const x1 = iu(a[0]), y1 = -iu(a[1]), x2 = iu(b[0]), y2 = -iu(b[1]);
  const cx = tdiv(x1 + x2, 2), cy = tdiv(y1 + y2, 2);
  const halfW = tdiv(Math.abs(x2 - x1), 2), halfH = tdiv(Math.abs(y2 - y1), 2);
  const wide = halfW >= halfH;
  return { cx: cx / IU, cy: -cy / IU, major: Math.max(wide ? halfW : halfH, 1) / IU, minor: Math.max(wide ? halfH : halfW, 1) / IU, rotation: wide ? 0 : 90, start: 0, end: 360 };
}
/** ELLIPSE::GetAngleAtPoint, in internal (Y down) space, degrees. */
export function ellipseAngleAt(e: EllipseGeom, p: number[]): number {
  const a = Math.max(1, e.major * IU), b = Math.max(1, e.minor * IU);
  const dx = iu(p[0]) - Math.round(e.cx * IU) + 0, dy = -iu(p[1]) + Math.round(e.cy * IU) + 0;   // integers, never -0
  const r = e.rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  return Math.atan2(ly / b, lx / a) * 180 / Math.PI;
}
/** ELLIPSE_GEOM_MANAGER::setStartAngle / setEndAngle: the end always after the start, wrapped by 360. */
export function ellipseArcAngles(e: EllipseGeom, startPt: number[], endPt?: number[]): { start: number; end: number } {
  const start = ellipseAngleAt(e, startPt);
  if (!endPt) return { start, end: start + 360 };
  let end = ellipseAngleAt(e, endPt);
  while (end <= start) end += 360;
  return { start, end };
}
const angNum = (deg: number): number => Number(fmtAngle(deg));
/** formatEllipse / formatEllipseArc for a library (centre written with Y up). */
export function ellipseNode(e: EllipseGeom, arc: boolean, fill = "none", width = 0): Node {
  const n = node(`(${arc ? "ellipse_arc" : "ellipse"} (center ${fmt(e.cx)} ${fmt(e.cy)}) (major_radius ${fmt(e.major)}) (minor_radius ${fmt(e.minor)}) (rotation_angle 0)${arc ? " (start_angle 0) (end_angle 0)" : ""} (stroke (width ${fmt(width)}) (type default)) (fill (type ${fill})))`);
  setAngle(n, "rotation_angle", e.rotation);
  if (arc) { setAngle(n, "start_angle", e.start); setAngle(n, "end_angle", e.end); }
  return n;
}
function setAngle(n: Node, key: string, deg: number): void { const k = kid(n, key); if (k) k[1] = angNum(deg); }
const getAngle = (n: Node, key: string, d = 0): number => { const k = kid(n, key); return k ? num(k[1], d) : d; };
/** EDA_SHAPE::rotate for ELLIPSE / ELLIPSE_ARC: Rotation -= aAngle (SCH_SHAPE::Rotate passes 90 for CCW, 270 for CW). */
function rotateEllipse(n: Node, ccw: boolean): void { setAngle(n, "rotation_angle", getAngle(n, "rotation_angle") - (ccw ? 90 : 270)); }
/** ELLIPSE::Mirror: Rotation = -Rotation; LEFT_RIGHT [s, e] -> [180 - e, 180 - s], TOP_BOTTOM [s, e] -> [-e, -s]. */
function mirrorEllipse(n: Node, horizontal: boolean): void {
  setAngle(n, "rotation_angle", -getAngle(n, "rotation_angle"));
  if (n[0] !== "ellipse_arc") return;
  const s = getAngle(n, "start_angle"), e = getAngle(n, "end_angle", 90);
  setAngle(n, "start_angle", horizontal ? 180 - e : -e); setAngle(n, "end_angle", horizontal ? 180 - s : -s);
}

export function textNode(s: string, x: number, y: number, size = 1.27, angle = 0): Node {
  return node(`(text ${q(s)} (at ${fmt(x)} ${fmt(y)} ${Math.round(angle * 10)}) (effects (font (size ${fmt(size)} ${fmt(size)}))))`);   // angle in tenths (saveText)
}
/** saveTextBox: (at) is the top-left corner (library Y up), (size) its width and height. */
export function textBoxNode(s: string, x: number, y: number, w: number, hgt: number, size = 1.27): Node {
  return node(`(text_box ${q(s)} (at ${fmt(x)} ${fmt(y)} 0) (size ${fmt(w)} ${fmt(-hgt)}) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0) (type default)) (fill (type none)) (effects (font (size ${fmt(size)} ${fmt(size)})) (justify left top)))`);
}

// ---------------------------------------------------------------- symbol header (DIALOG_LIB_SYMBOL_PROPERTIES)
export interface SymHeader { power: "" | "global" | "local"; showPinNumbers: boolean; showPinNames: boolean; pinNameOffset: number; excludeFromSim: boolean; inBom: boolean; onBoard: boolean; inPosFiles: boolean; jumpers: boolean }
const yesTok = (n: Node | null, d: boolean): boolean => { if (!n) return d; const v = n[1]; return v === undefined ? true : str(v) !== "no"; };
export function symHeader(sym: Node): SymHeader {
  const pw = kid(sym, "power"); const pn = kid(sym, "pin_names"), pnum = kid(sym, "pin_numbers");
  const off = pn ? kid(pn, "offset") : null;
  const hidden = (n: Node | null) => !!n && (n.includes("hide") || yesTok(kid(n, "hide"), false));
  return { power: pw ? (str(pw[1]) === "local" ? "local" : "global") : "", showPinNumbers: !hidden(pnum), showPinNames: !hidden(pn), pinNameOffset: off ? num(off[1]) : DEFAULT_PIN_NAME_OFFSET,
    excludeFromSim: yesTok(kid(sym, "exclude_from_sim"), false), inBom: yesTok(kid(sym, "in_bom"), true), onBoard: yesTok(kid(sym, "on_board"), true), inPosFiles: yesTok(kid(sym, "in_pos_files"), true), jumpers: yesTok(kid(sym, "duplicate_pin_numbers_are_jumpers"), false) };
}
/** Write the header tokens the way SaveSymbol orders them (power, body_styles, pin_numbers, pin_names, the flags). */
export function setSymHeader(sym: Node, hd: SymHeader): void {
  const was = symHeader(sym);
  if (JSON.stringify(was) === JSON.stringify(hd) || isDerived(sym)) return;   // nothing changed: the file's own tokens stay as written
  const had = (k: string) => !!kid(sym, k);
  const keep = { sim: had("exclude_from_sim"), bom: had("in_bom"), board: had("on_board"), pos: had("in_pos_files"), jump: had("duplicate_pin_numbers_are_jumpers") };
  const body = kid(sym, "body_styles");
  const drop = new Set(["power", "body_styles", "pin_numbers", "pin_names", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "duplicate_pin_numbers_are_jumpers"]);
  for (let j = sym.length - 1; j >= 2; j--) { const c = sym[j]; if (isList(c) && drop.has(String(c[0]))) sym.splice(j, 1); }
  const yn2 = (b: boolean) => (b ? "yes" : "no");
  const offDefault = Math.abs(hd.pinNameOffset - DEFAULT_PIN_NAME_OFFSET) < 1e-9;
  let s = "(x";
  if (hd.power) s += ` (power ${hd.power})`;
  if (body) s += " " + text(body);
  if (!hd.showPinNumbers) s += " (pin_numbers (hide yes))";
  if (!offDefault || !hd.showPinNames) s += " (pin_names" + (offDefault ? "" : ` (offset ${fmt(hd.pinNameOffset)})`) + (hd.showPinNames ? "" : " (hide yes)") + ")";
  // a flag the file did not carry is written only when it differs from its default (an older file keeps its token set)
  if (keep.sim || hd.excludeFromSim) s += ` (exclude_from_sim ${yn2(hd.excludeFromSim)})`;
  if (keep.bom || !hd.inBom) s += ` (in_bom ${yn2(hd.inBom)})`;
  if (keep.board || !hd.onBoard) s += ` (on_board ${yn2(hd.onBoard)})`;
  if (keep.pos || !hd.inPosFiles) s += ` (in_pos_files ${yn2(hd.inPosFiles)})`;
  if (keep.jump || hd.jumpers) s += ` (duplicate_pin_numbers_are_jumpers ${yn2(hd.jumpers)})`;
  s += ")";
  sym.splice(2, 0, ...(node(s).slice(1) as Node[]));
}
/** A metadata property (ki_keywords / ki_fp_filters) set, created after the last field, or removed when empty. */
export function setMetaField(sym: Node, name: string, value: string): void {
  const p = fieldOf(sym, name);
  if (!value) { if (p) sym.splice(sym.indexOf(p), 1); return; }
  if (p) { p[2] = value; return; }
  let last = -1; for (let j = 1; j < sym.length; j++) if (isList(sym[j]) && (sym[j] as Node)[0] === "property") last = j;
  sym.splice(last + 1, 0, node(`(property ${q(name)} ${q(value)} (at 0 0 0) (show_name no) (do_not_autoplace no) (hide yes) (effects (font (size 1.27 1.27))))`));
}

// ---------------------------------------------------------------- SYMBOL_IMPORT_MANAGER (eeschema/symbol_import_manager.cpp)
export interface ImportInfo { name: string; parent: string; power: boolean; exists: boolean; checked: boolean; auto: boolean; derived: boolean }
/** The import selection model behind DIALOG_IMPORT_SYMBOL_SELECT: picking a derived symbol pulls in its ancestors. */
export class SymbolImportManager {
  /** std::map order: names sorted by code point. */
  readonly infos = new Map<string, ImportInfo>();
  private parents = new Map<string, string>();
  private derivatives = new Map<string, string[]>();
  constructor(lib: SymLib, exists: (name: string) => boolean) {
    const names = [...lib.symbols.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const n of names) { const s = lib.symbols.get(n)!; const p = parentNameOf(s) || ""; this.infos.set(n, { name: n, parent: p, power: !!kid(s, "power"), exists: exists(n), checked: false, auto: false, derived: !!p }); }
    for (const [n, i] of this.infos) if (i.parent) { this.parents.set(n, i.parent); const d = this.derivatives.get(i.parent) || []; d.push(n); this.derivatives.set(i.parent, d); }
  }
  names(): string[] { return [...this.infos.keys()]; }
  ancestors(name: string): Set<string> {
    const out = new Set<string>(); let cur = name;
    for (;;) { const p = this.parents.get(cur); if (!p || !this.infos.has(p) || out.has(p)) break; out.add(p); cur = p; }
    return out;
  }
  descendants(name: string): Set<string> {
    const out = new Set<string>(); const todo = [name];
    while (todo.length) { const c = todo.pop()!; for (const ch of this.derivatives.get(c) || []) if (!out.has(ch)) { out.add(ch); todo.push(ch); } }
    return out;
  }
  setSelected(name: string, on: boolean): void {
    const i = this.infos.get(name); if (!i) return;
    if (on) { i.checked = true; i.auto = false; for (const a of this.ancestors(name)) { const ai = this.infos.get(a)!; if (!ai.checked && !ai.auto) ai.auto = true; } }
    else { i.checked = false; i.auto = false; this.recalc(); }
  }
  deselectWithDescendants(name: string): void {
    for (const n of [name, ...this.descendants(name)]) { const i = this.infos.get(n); if (i) { i.checked = false; i.auto = false; } }
    this.recalc();
  }
  selectAll(filter?: (n: string) => boolean): void { for (const i of this.infos.values()) if (!filter || filter(i.name)) { i.checked = true; i.auto = false; } this.recalc(); }
  deselectAll(filter?: (n: string) => boolean): void { for (const i of this.infos.values()) if (!filter || filter(i.name)) { i.checked = false; i.auto = false; } this.recalc(); }
  toImport(): string[] { return [...this.infos.values()].filter((i) => i.checked || i.auto).map((i) => i.name); }
  manualCount(): number { return [...this.infos.values()].filter((i) => i.checked).length; }
  autoCount(): number { return [...this.infos.values()].filter((i) => i.auto && !i.checked).length; }
  conflicts(): string[] { return [...this.infos.values()].filter((i) => (i.checked || i.auto) && i.exists).map((i) => i.name); }
  static matches(name: string, filter: string): boolean { return !filter || name.toLowerCase().includes(filter.toLowerCase()); }
  /** DIALOG_IMPORT_SYMBOL_SELECT::updateStatusLine */
  status(): string { const a = this.autoCount(), m = this.manualCount(); return a > 0 ? `${m} symbols selected, ${a} parents auto-included` : `${m} symbols selected`; }
  private recalc(): void {
    for (const i of this.infos.values()) i.auto = false;
    for (const i of this.infos.values()) if (i.checked) for (const a of this.ancestors(i.name)) { const ai = this.infos.get(a)!; if (!ai.checked) ai.auto = true; }
  }
}
export function setBool(n: Node, key: string, on: boolean): void { const k = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === key); if (k > 0) (n[k] as Node)[1] = on ? "yes" : "no"; else if (on) { const a = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "at"); n.splice(a > 0 ? a + 1 : 3, 0, node(`(${key} yes)`)); } }
/** A field's visibility: KiCad 10 writes (hide yes) on the field, older files inside its (effects). */
export function isHidden(n: Node): boolean {
  const top = kid(n, "hide"); if (top) return str(top[1]) !== "no";
  const ef = kid(n, "effects"); if (!ef) return false;
  const h2 = kid(ef, "hide"); return ef.includes("hide") || (!!h2 && str(h2[1]) !== "no");
}
export function setHide(n: Node, hide: boolean): void {
  if (isHidden(n) === hide) return;
  const ef = n.find((c, j) => j > 0 && Array.isArray(c) && c[0] === "effects") as Node | undefined;
  if (ef && (ef.includes("hide") || ef.some((c) => Array.isArray(c) && c[0] === "hide"))) {
    // the file keeps its own layout: the flag stays inside (effects)
    const bare = ef.indexOf("hide"); if (bare > 0) ef.splice(bare, 1);
    const k2 = ef.findIndex((c) => Array.isArray(c) && c[0] === "hide"); if (k2 > 0) ef.splice(k2, 1);
    if (hide) ef.push(node("(hide yes)"));
    return;
  }
  const k = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "hide");
  if (hide) { if (k < 0) { const e = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "effects"); n.splice(e > 0 ? e : n.length, 0, node("(hide yes)")); } else (n[k] as Node)[1] = "yes"; }
  else if (k > 0) n.splice(k, 1);
}

// ---------------------------------------------------------------- Update Symbol Fields
/** A user-visible field: the ki_ properties are symbol attributes, not fields, in KiCad 10. */
const isField = (p: Node): boolean => !str(p[1]).startsWith("ki_");
/** DIALOG_UPDATE_SYMBOL_FIELDS: the mandatory names, then the sorted other field names of the flattened parent and the symbol. */
export function updatableFieldNames(lib: SymLib | null, sym: Node): string[] {
  const parent = lib && parentNameOf(sym) ? lib.symbols.get(parentNameOf(sym)!) : null;
  const names = new Set<string>();
  for (const s of [parent ? flatten(lib, parent) : null, sym]) if (s) for (const p of kids(s, "property")) { const n = str(p[1]); if (isField(p) && !MANDATORY_FIELDS.includes(n)) names.add(n); }
  return [...MANDATORY_FIELDS, ...[...names].sort()];
}
export interface FieldSyncOptions { fields: Set<string>; removeExtra: boolean; resetEmpty: boolean; resetText: boolean; resetVisibility: boolean; resetEffects: boolean; resetPositions: boolean }
/** LIB_SYMBOL::SyncFieldsFromParent, applied to the derived symbol `sym` in place.  False when the parent cannot be found. */
export function syncFieldsFromParent(lib: SymLib | null, sym: Node, o: FieldSyncOptions): boolean {
  const pn = parentNameOf(sym); const parentSym = lib && pn ? lib.symbols.get(pn) : null; if (!parentSym) return false;
  const parent = flatten(lib, parentSym);
  const pf = (name: string): Node | null => { for (const p of kids(parent, "property")) if (str(p[1]) === name && isField(p)) return p; return null; };
  const showName = (p: Node): boolean => { const s = kid(p, "show_name"); return !!s && (s.length < 2 || str(s[1]) !== "no"); };
  for (let j = sym.length - 1; j >= 2; j--) {
    const f = sym[j]; if (!isList(f) || f[0] !== "property" || !isField(f)) continue;
    const name = str(f[1]); if (!o.fields.has(name)) continue;
    const p = pf(name);
    if (!p) { if (o.removeExtra) sym.splice(j, 1); continue; }
    if (str(p[2]) === "" ? o.resetEmpty : o.resetText) f[2] = p[2];
    if (o.resetVisibility) {
      setHide(f, isHidden(p));
      const k = f.findIndex((c, i) => i > 0 && isList(c) && c[0] === "show_name");
      if (showName(p)) { if (k < 0) setBool(f, "show_name", true); else f[k] = node("(show_name yes)"); }
      else if (k > 0) f.splice(k, 1);
    }
    if (o.resetEffects) {
      // EDA_TEXT::SetAttributes, keeping the field's own visibility and position (and its hyperlink, which is not an attribute)
      const visible = !isHidden(f);
      const fa = kid(f, "at"), pa = kid(p, "at");
      if (fa && pa) { const ang = pa.length > 3 ? pa[3] : 0; if (fa.length > 3) fa[3] = ang; else if (Number(ang) !== 0) fa.push(ang); }
      const pe = kid(p, "effects"); const ne = pe ? clone(pe) : node("(effects (font (size 1.27 1.27)))");
      for (let i = ne.length - 1; i > 0; i--) if (ne[i] === "hide" || (isList(ne[i]) && ((ne[i] as Node)[0] === "hide" || (ne[i] as Node)[0] === "href"))) ne.splice(i, 1);
      const fe = kid(f, "effects"); const href = fe ? kid(fe, "href") : null; if (href) ne.push(clone(href));
      const ei = f.findIndex((c, i) => i > 0 && isList(c) && c[0] === "effects");
      if (ei > 0) f[ei] = ne; else f.push(ne);
      if (isHidden(f) === visible) setHide(f, !visible);
    }
    if (o.resetPositions) { const fa = kid(f, "at"), pa = kid(p, "at"); if (fa && pa) { fa[1] = pa[1]; fa[2] = pa[2]; } }
  }
  // the parent's selected fields the symbol lacks, after its last field
  const have = new Set(kids(sym, "property").map((p) => str(p[1])));
  let at = 1; for (let j = 2; j < sym.length; j++) if (isList(sym[j]) && (sym[j] as Node)[0] === "property") at = j;
  if (at === 1) { at = sym.findIndex((c, i) => i > 1 && isList(c) && (c[0] === "symbol" || c[0] === "embedded_fonts")); at = at < 0 ? sym.length - 1 : at - 1; }
  const added: Node[] = [];
  for (const p of kids(parent, "property")) {
    const name = str(p[1]); if (!isField(p) || !o.fields.has(name) || have.has(name)) continue;
    const n = clone(p);
    // a new SCH_FIELD: no name shown, auto-placement allowed, attributes / text / position from the parent
    for (let i = n.length - 1; i > 2; i--) if (isList(n[i]) && ["show_name", "do_not_autoplace", "id"].includes(String((n[i] as Node)[0]))) n.splice(i, 1);
    added.push(n);
  }
  sym.splice(at + 1, 0, ...added);
  return true;
}
export { kid as kidOf, kids as kidsOf, str as strOf };

// ---------------------------------------------------------------- pin maps (PANEL_SYMBOL_PIN_MAP)
export interface PinMapDef { name: string; entries: [string, string][] }
export interface AssocFootprint { fpid: string; map: string }
/** (associated_footprints (footprint "<lib_id>" (map "<name>"))…) and (pin_maps (pin_map "<name>" (entry "<pin>" "<pad>")…)…). */
export function pinMapData(sym: Node): { maps: PinMapDef[]; assocs: AssocFootprint[] } {
  const maps: PinMapDef[] = []; const assocs: AssocFootprint[] = [];
  const pm = kid(sym, "pin_maps");
  if (pm) for (const m of kids(pm, "pin_map")) { const def: PinMapDef = { name: str(m[1]), entries: kids(m, "entry").map((e) => [str(e[1]), str(e[2])] as [string, string]) }; const i = maps.findIndex((x) => x.name === def.name); if (i >= 0) maps[i] = def; else maps.push(def); }
  const af = kid(sym, "associated_footprints");
  if (af) for (const f of kids(af, "footprint")) { const mp = kid(f, "map"); assocs.push({ fpid: str(f[1]), map: mp ? str(mp[1]) : "" }); }
  return { maps, assocs };
}
/** SCH_IO_KICAD_SEXPR_LIB_CACHE::savePinMapData: after the fields, associations first; nothing when empty. */
export function setPinMapData(sym: Node, maps: PinMapDef[], assocs: AssocFootprint[]): void {
  for (let j = sym.length - 1; j > 1; j--) { const c = sym[j]; if (isList(c) && (c[0] === "pin_maps" || c[0] === "associated_footprints")) sym.splice(j, 1); }
  let at = 1; for (let j = 2; j < sym.length; j++) { const c = sym[j]; if (isList(c) && c[0] === "property") at = j; }
  if (at === 1) { const k = sym.findIndex((c, j) => j > 1 && isList(c) && (c[0] === "symbol" || c[0] === "embedded_fonts")); at = k < 0 ? sym.length - 1 : k - 1; }
  const add: Node[] = [];
  if (assocs.length) add.push(node(`(associated_footprints ${assocs.map((a) => `(footprint ${q(a.fpid)}${a.map ? ` (map ${q(a.map)})` : ""})`).join(" ")})`));
  if (maps.length) add.push(node(`(pin_maps ${maps.map((m) => `(pin_map ${q(m.name)}${m.entries.map(([p, d]) => ` (entry ${q(p)} ${q(d)})`).join("")})`).join(" ")})`));
  sym.splice(at + 1, 0, ...add);
}
/** LIB_SYMBOL::GetLogicalPins( 0, 0 ) reduced to unique numbers: stacked pins expand, the first pin of a number names it. */
export function logicalPinRows(sym: Node): { number: string; name: string; unit: number }[] {
  const out: { number: string; name: string; unit: number }[] = []; const seen = new Set<string>();
  for (const d of allPins(sym)) {
    const nb = kid(d.node, "number"), nm = kid(d.node, "name"); const num0 = nb ? str(nb[1]) : ""; const name = nm ? str(nm[1]) : "";
    const ex = expandStacked(num0);
    for (const n of ex.valid && ex.pins.length ? ex.pins : [num0]) if (!seen.has(n)) { seen.add(n); out.push({ number: n, name, unit: d.unit }); }
  }
  return out;
}
/** ExpandStackedPinNotation: "[1,3-5,A1-A3]" (\, and \- escaped) → its pads; `valid` false for broken brackets or ranges. */
export function expandStacked(pad: string): { pins: string[]; valid: boolean } {
  const open = pad.includes("["), close = pad.includes("]");
  if ((open || close) && !(pad.startsWith("[") && pad.endsWith("]"))) return { pins: [pad], valid: false };
  if (!(pad.startsWith("[") && pad.endsWith("]"))) return { pins: [pad], valid: true };
  const inner = pad.slice(1, -1); const parts: string[] = []; let cur = "";
  for (let i = 0; i < inner.length; i++) { const c = inner[i]; if (c === "\\" && i + 1 < inner.length) { cur += c + inner[++i]; continue; } if (c === ",") { parts.push(cur); cur = ""; } else cur += c; }
  parts.push(cur);
  const unesc = (s: string) => s.replace(/\\(.)/g, "$1");
  const alnum = (s: string): [string, number] => { const m = /^(.*?)(\d+)$/.exec(s); return m ? [m[1], Number(m[2])] : [s, -1]; };
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim(); if (!part) continue;
    let dash = -1; for (let i = 0; i < part.length; i++) { if (part[i] === "\\") { i++; continue; } if (part[i] === "-") { dash = i; break; } }
    if (dash >= 0) {
      const [sp, sv] = alnum(unesc(part.slice(0, dash)).trim()), [ep, ev] = alnum(unesc(part.slice(dash + 1)).trim());
      if (sp !== ep || sv === -1 || ev === -1 || sv > ev) return { pins: [pad], valid: false };
      for (let v = sv; v <= ev; v++) out.push(sp + v);
    } else out.push(unesc(part));
  }
  return out.length ? { pins: out, valid: true } : { pins: [pad], valid: false };
}

// ---------------------------------------------------------------- sym-lib-table (LIBRARY_TABLE::Format / PANEL_SYM_LIB_TABLE)
export interface LibTableRow { enabled: boolean; visible: boolean; nickname: string; uri: string; type: string; options: string; descr: string }
export function parseLibTable(text: string): LibTableRow[] {
  const t = parse(text); if (!t) return [];
  return kids(t, "lib").map((l) => ({ nickname: str((kid(l, "name") || [])[1]), uri: str((kid(l, "uri") || [])[1]), type: str((kid(l, "type") || [])[1]) || "KiCad",
    options: str((kid(l, "options") || [])[1]), descr: str((kid(l, "descr") || [])[1]), enabled: !kid(l, "disabled"), visible: !kid(l, "hidden") }));
}
/**
 * LIBRARY_TABLE::Format (version 7, each row's name / type / uri / options / descr, then (disabled) and (hidden))
 * through PRETTIFIED_FILE_OUTPUTFORMATTER in FORMAT_MODE::LIBRARY_TABLE: tab indent, one row per line.
 */
export function formatLibTable(rows: LibTableRow[], root = "sym_lib_table"): string {
  const lines = rows.map((r) => `(lib (name ${q(r.nickname)})(type ${q(r.type)})(uri ${q(r.uri.replace(/\\/g, "/"))})(options ${q(r.options)})(descr ${q(r.descr)})${r.enabled ? "" : "(disabled)"}${r.visible ? "" : "(hidden)"})`);
  return prettify(`(${root} (version 7)${lines.join("")})`, true);
}
/** LIB_TABLE_GRID_TRICKS::VerifyTable: rows without a path go silently; a nickname must be legal and unique. */
export function verifyLibTable(rows: LibTableRow[]): { rows: LibTableRow[]; error?: string; row?: number } {
  const out = rows.filter((r) => r.uri.trim()).map((r) => ({ ...r, nickname: r.nickname.trim(), uri: r.uri.trim() }));
  for (let i = 0; i < out.length; i++) {
    const nick = out[i].nickname;
    if (!nick) return { rows: out, error: "Library must have a nickname.", row: i };
    const bad = [...nick].find((c) => c < " " || c === "\\" || c === ":"); if (bad) return { rows: out, error: `Illegal character '${bad}' in nickname '${nick}'.`, row: i };
  }
  for (let a = 0; a < out.length - 1; a++) for (let b = a + 1; b < out.length; b++) if (out[a].nickname === out[b].nickname) return { rows: out, error: `Multiple libraries cannot share the same nickname ('${out[a].nickname}').`, row: b };
  return { rows: out };
}

// ---------------------------------------------------------------- SYMBOL_EDITOR_MOVE_TOOL::AlignElements / SYMBOL_EDITOR_EDIT_TOOL::Swap
/** EDA_ITEM::GetPosition of a library item (file coordinates): a pin's connection point, a text's or field's
 *  anchor, a text box's corner, a circle's or arc's centre, a polygon's first vertex, else the shape's start. */
export function itemPosition(n: Node): [number, number] {
  const k = String(n[0]);
  const p = (key: string): [number, number] | null => { const c = kid(n, key); return c ? [num(c[1]), num(c[2])] : null; };
  if (k === "pin" || k === "text" || k === "property" || k === "text_box") return p("at") || [0, 0];
  if (k === "circle" || k === "ellipse" || k === "ellipse_arc") return p("center") || [0, 0];
  if (k === "arc") { const s = p("start"), m = p("mid"), e = p("end"); if (s && m && e) { const c = circleCenter(s, m, e); if (c) return c; } return s || [0, 0]; }
  if (k === "polyline" || k === "bezier") { const pts = kid(n, "pts"); const xy = pts ? kids(pts, "xy")[0] : null; return xy ? [num(xy[1]), num(xy[2])] : [0, 0]; }
  return p("start") || [0, 0];
}
function circleCenter(a: [number, number], b: [number, number], c: [number, number]): [number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const s = (p: [number, number]) => p[0] * p[0] + p[1] * p[1];
  return [(s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d, (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d];
}
/** SCH_ITEM::SetPosition: the item moves so its position lands on (x, y). */
export function setItemPosition(n: Node, x: number, y: number): void { const [px, py] = itemPosition(n); if (px !== x || py !== y) moveNode(n, x - px, y - py); }
/** AlignElements for one item: its position onto `grid`; a pin's length also rounds to the grid (when above 0). */
export function alignToGrid(n: Node, grid: number): boolean {
  const before = text(n); const [x, y] = itemPosition(n);
  const al = (v: number) => +fmt(Math.round(v / grid) * grid);
  setItemPosition(n, al(x), al(y));
  if (n[0] === "pin") { const l = kid(n, "length"); if (l) { const nl = al(num(l[1])); if (nl > 0) l[1] = nl; } }
  return text(n) !== before;
}
/** SYMBOL_EDITOR_EDIT_TOOL::Swap: each item in selection order trades positions with the next (pins also trade orientation). */
export function swapItems(items: Node[]): void {
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i], b = items[i + 1];
    const pa = itemPosition(a), pb = itemPosition(b);
    setItemPosition(a, pb[0], pb[1]); setItemPosition(b, pa[0], pa[1]);
    if (a[0] === "pin" && b[0] === "pin") { const aa = kid(a, "at"), ba = kid(b, "at"); if (aa && ba) { const o = aa[3]; aa[3] = ba[3]; ba[3] = o; } }
  }
}

// ---------------------------------------------------------------- stacked pins (ConvertStackedPins / ExplodeStackedPin)
const escStacked = (s: string): string => s.replace(/[[\],\-\\]/g, (c) => "\\" + c);   // EscapeStackedPinItem
const isLong = (s: string): boolean => /^[+-]?\d+$/.test(s);
/** ConvertStackedPins' collapseRanges: "[1-3,5,A1,A2,X]" from the pin numbers. */
export function stackedNotation(numbers: string[]): string {
  const groups = new Map<string, number[]>(); const other: string[] = [];
  for (const n of numbers) {
    if (!n) { other.push("(empty)"); continue; }
    const m = /^(.*?)(\d+)$/.exec(n);
    if (m) { const g = groups.get(m[1]) || []; g.push(Number(m[2])); groups.set(m[1], g); } else other.push(n);
  }
  const parts: string[] = [];
  for (const prefix of [...groups.keys()].sort()) {
    const nums = groups.get(prefix)!.sort((a, b) => a - b); const p = escStacked(prefix);
    for (let i = 0; i < nums.length; i++) {
      const start = nums[i]; let end = start;
      while (i + 1 < nums.length && nums[i + 1] === nums[i] + 1) { i++; end = nums[i]; }
      parts.push(end > start + 1 ? `${p}${start}-${p}${end}` : end === start + 1 ? `${p}${start},${p}${end}` : `${p}${start}`);
    }
  }
  for (const o of other) parts.push(escStacked(o));
  return "[" + parts.join(",") + "]";
}
const pinNumberOf = (p: Node): string => { const nb = kid(p, "number"); return nb ? str(nb[1]) : ""; };
/** The pins ConvertStackedPins works on: the selected pins, or every pin at the one selected pin's position. */
export function stackCandidates(sym: Node, sel: Node[]): Node[] {
  if (sel.length === 1 && sel[0][0] === "pin") { const [x, y] = itemPosition(sel[0]); return allPins(sym).map((d) => d.node).filter((p) => { const [px, py] = itemPosition(p); return px === x && py === y; }); }
  return sel.filter((n) => n[0] === "pin");
}
/** ConvertStackedPins: the first pin (by number) takes the stacked notation, the others go; an error message or null. */
export function convertStackedPins(sym: Node, pins: Node[]): string | null {
  if (pins.length < 2) return "At least two pins are needed to convert to stacked pins";
  const [x, y] = itemPosition(pins[0]);
  if (pins.some((p) => { const [px, py] = itemPosition(p); return px !== x || py !== y; })) return "All pins must be at the same location";
  const sorted = [...pins].sort((a, b) => {
    const na = pinNumberOf(a), nb = pinNumberOf(b), ia = isLong(na), ib = isLong(nb);
    if (ia && ib) return Number(na) - Number(nb); if (ia !== ib) return ia ? -1 : 1; return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const master = sorted[0]; const nb = kid(master, "number"); if (nb) nb[1] = stackedNotation(sorted.map(pinNumberOf));
  for (const p of sorted.slice(1)) { const r = findRef(sym, p); if (r) removeDrawItem(sym, r); }
  return null;
}
/** ExplodeStackedPin: the pin keeps the first number and shows; one hidden pin per other number (power inputs become passive). */
export function explodeStackedPin(sym: Node, pin: Node): Node[] | string {
  const nums = stackedNumbers(pinNumberOf(pin));
  if (!nums || nums.length <= 1) return "Selected pin does not have valid stacked notation";
  nums.sort((a, b) => (isLong(a) && isLong(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  const r = findRef(sym, pin); if (!r) return "Selected pin does not have valid stacked notation";
  const i = pinInfo(pin, r.unit, r.body); const out: Node[] = [pin];
  setPin(pin, { ...i, number: nums[0], visible: true });
  for (const n of nums.slice(1)) {
    const np = pinNode({ ...i, number: n, visible: false, type: i.type === "power_in" ? "passive" : i.type, alternates: [] });
    addDrawItem(sym, r.unit, r.body, np); out.push(np);
  }
  return out;
}
