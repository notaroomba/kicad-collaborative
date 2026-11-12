// dialogs/global-edit-logic.ts — the document half of Edit > Edit Text & Graphics Properties…
// (eeschema/dialogs/dialog_global_edit_text_and_graphics.cpp, DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS::visitItem and
// processItem): which items of a sheet the Scope and Filter Items boxes reach, and what the Set To box does to their
// text effects, strokes, fills and junction dots.  Only those nodes change; positions, text and everything else of
// an item are left as they are.  Pure functions over s-expression nodes, so the node tests load this file directly;
// the dialog (global-edit.ts) walks the hierarchy and commits.

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const isList = Array.isArray;
const clone = (n: SNode): SNode => (K().cloneNode as (x: SNode) => SNode)(n);
const kid = (n: SNode, k: string): SNode | null => K().kid(n, k) as SNode | null;
const kids = (n: SNode, k: string): SNode[] => K().kids(n, k) as SNode[];
const str = (v: unknown): string => K().str(v as SNode);
const num = (v: unknown, d = 0): number => { const x = Number(isList(v) ? NaN : v); return Number.isFinite(x) ? x : d; };
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** A COLOR4D as the file writes it: r, g, b 0..255 and alpha 0..1.  null is COLOR4D::UNSPECIFIED. */
export type Color = [number, number, number, number] | null;
export interface Scope {
  references: boolean; values: boolean; otherFields: boolean; wires: boolean; buses: boolean; globalLabels: boolean; hierLabels: boolean;
  labelFields: boolean; sheetTitles: boolean; sheetFields: boolean; sheetPins: boolean; sheetBorders: boolean; schTextAndGraphics: boolean;
}
/** The Filter Items box: a filter is on when its value is not null (an empty value is on but lets everything by). */
export interface Filters { fieldName: string | null; reference: string | null; libId: string | null; power: boolean | null; net: string | null; selectedOnly: boolean }
/** The Set To box: undefined leaves a property unchanged ("-- leave unchanged --", an undetermined checkbox). */
export interface SetTo {
  font?: string; textColor?: Color; textSize?: number; bold?: boolean; italic?: boolean;
  orientation?: 0 | 1 | 2 | 3; hAlign?: "left" | "center" | "right"; vAlign?: "top" | "center" | "bottom";
  visible?: boolean; showName?: boolean; lineWidth?: number; lineColor?: Color; lineStyle?: LineStyle; fillColor?: Color;
  junctionSize?: number; junctionColor?: Color;
}
export const LINE_STYLES = ["solid", "dash", "dot", "dash_dot", "dash_dot_dot"] as const;
export type LineStyle = typeof LINE_STYLES[number];
export const KICAD_FONT = "KiCad Font";

/** What the walker needs to know about a sheet instance that the nodes alone do not say. */
export interface SheetCtx {
  /** The connection name of an item on this sheet instance (null: none, as for symbols, sheets and text). */
  netOf(id: string): string | null;
  /** What a label or junction connects to: wires or pins (SCH_LABEL_LOCATE_WIRE_T), buses (SCH_LABEL_LOCATE_BUS_T). */
  attached(id: string): { wire: boolean; bus: boolean };
  /** The symbol's reference on this instance (SCH_SYMBOL::GetRef). */
  refOf(node: SNode): string;
  isPower(node: SNode): boolean;
  selected(id: string): boolean;
}

export function emptyScope(): Scope {
  return { references: false, values: false, otherFields: false, wires: false, buses: false, globalLabels: false, hierLabels: false,
    labelFields: false, sheetTitles: false, sheetFields: false, sheetPins: false, sheetBorders: false, schTextAndGraphics: false };
}

/** WildCompareString( pattern, text, false ): * and ?, the whole text, any case. */
export function wild(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(text);
}

// ---------------------------------------------------------------- node edits
const idx = (n: SNode, k: string): number => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === k) return j; } return -1; };
const drop = (n: SNode, k: string): void => { let i; while ((i = idx(n, k)) > 0) n.splice(i, 1); };
const dropTok = (n: SNode, t: string): void => { for (let j = n.length - 1; j > 0; j--) if (n[j] === t) n.splice(j, 1); };
function put(n: SNode, k: string, values: unknown[], before: string[] = []): SNode {
  const i = idx(n, k), c = [k, ...values] as SNode;
  if (i > 0) { n[i] = c; return c; }
  let at = n.length; for (const b of before) { const j = idx(n, b); if (j > 0) { at = j; break; } }
  n.splice(at, 0, c); return c;
}
const colorVals = (c: [number, number, number, number]): unknown[] => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), r4(c[3])];

function effectsOf(n: SNode): SNode { let e = kid(n, "effects"); if (!e) e = put(n, "effects", [["font", ["size", 1.27, 1.27]]], ["uuid"]); return e; }
function fontOf(e: SNode): SNode { let f = kid(e, "font"); if (!f) { f = ["font", ["size", 1.27, 1.27]] as SNode; e.splice(1, 0, f); } return f; }
const flag = (f: SNode, k: string): boolean => { if (f.includes(k)) return true; const c = kid(f, k); return !!c && str(c[1]) !== "no"; };
function setFlag(f: SNode, k: "bold" | "italic", on: boolean): void {
  dropTok(f, k); drop(f, k);
  if (on) put(f, k, ["yes"], k === "bold" ? ["italic", "color"] : ["color"]);
}

/** The text half of processItem (EDA_TEXT): size, colour, justification, bold, italic, font. */
function editText(n: SNode, s: SetTo, flipH: boolean, flipV: boolean, align: boolean): void {
  if (s.textSize === undefined && s.textColor === undefined && s.bold === undefined && s.italic === undefined && s.font === undefined
    && !(align && (s.hAlign !== undefined || s.vAlign !== undefined))) return;
  const e = effectsOf(n), f = fontOf(e);
  if (s.textSize !== undefined) put(f, "size", [r4(s.textSize), r4(s.textSize)], ["thickness", "bold", "italic", "line_spacing", "color"]);
  if (s.textColor !== undefined) { drop(f, "color"); if (s.textColor) put(f, "color", colorVals(s.textColor)); }
  if (align && (s.hAlign !== undefined || s.vAlign !== undefined)) {
    const j = kid(e, "justify");
    let h = j ? (j.includes("left") ? "left" : j.includes("right") ? "right" : "center") : "center";
    let v = j ? (j.includes("top") ? "top" : j.includes("bottom") ? "bottom" : "center") : "center";
    const mirror = !!j && j.includes("mirror");
    if (s.hAlign !== undefined) { h = s.hAlign; if (flipH) h = h === "left" ? "right" : h === "right" ? "left" : h; }
    if (s.vAlign !== undefined) { v = s.vAlign; if (flipV) v = v === "top" ? "bottom" : v === "bottom" ? "top" : v; }
    const jv: string[] = []; if (h !== "center") jv.push(h); if (v !== "center") jv.push(v); if (mirror) jv.push("mirror");
    if (jv.length) put(e, "justify", jv, ["hide", "href"]); else drop(e, "justify");
  }
  if (s.italic !== undefined) setFlag(f, "italic", s.italic);
  if (s.bold !== undefined) setFlag(f, "bold", s.bold);
  // the font follows bold / italic (GetFontSelection( IsBold(), IsItalic() )); the stroke font has no face
  if (s.font !== undefined) { drop(f, "face"); if (s.font && s.font !== KICAD_FONT) f.splice(1, 0, ["face", s.font] as unknown as SNode); }
}

/** SCH_FIELD::SetVisible / SetNameShown, written the KiCad 9 way ((hide yes), (show_name yes) on the property). */
function editField(p: SNode, s: SetTo): void {
  if (s.visible !== undefined) {
    const e = kid(p, "effects"); if (e) { dropTok(e, "hide"); drop(e, "hide"); }
    drop(p, "hide"); if (!s.visible) put(p, "hide", ["yes"], ["show_name", "do_not_autoplace", "effects"]);
  }
  if (s.showName !== undefined) { drop(p, "show_name"); if (s.showName) put(p, "show_name", ["yes"], ["do_not_autoplace", "effects"]); }
}

/** STROKE_PARAMS: width, line style, colour (an unspecified colour is not written). */
function editStroke(n: SNode, s: SetTo): void {
  if (s.lineWidth === undefined && s.lineStyle === undefined && s.lineColor === undefined) return;
  let st = kid(n, "stroke"); if (!st) st = put(n, "stroke", [["width", 0], ["type", "default"]], ["fill", "uuid"]);
  if (s.lineWidth !== undefined) put(st, "width", [r4(s.lineWidth)]);
  if (s.lineStyle !== undefined) put(st, "type", [s.lineStyle], ["color"]);
  if (s.lineColor !== undefined) { drop(st, "color"); if (s.lineColor) put(st, "color", colorVals(s.lineColor)); }
}

/** SCH_SHAPE::SetFillColor + SetFillMode: a colour fills with it, the unspecified colour is no fill. */
function editFill(n: SNode, c: Color): void {
  const f = c ? ["fill", ["type", "color"], ["color", ...colorVals(c)]] : ["fill", ["type", "none"]];
  put(n, "fill", f.slice(1) as unknown[], ["effects", "uuid"]);
}

/** SCH_LABEL_BASE::SetSpinStyle: the angle in the file and the justification it implies (Right, Up, Left, Down). */
function editSpin(kind: string, n: SNode, spin: number): void {
  const rot = spin * 90, a = kid(n, "at"); if (!a) return;
  if (a.length >= 4) a[3] = rot; else a.push(rot);
  const e = effectsOf(n), right = rot === 180 || rot === 270;
  const jv = kind === "label" ? [right ? "right" : "left", "bottom"] : [right ? "right" : "left"];
  put(e, "justify", jv, ["hide", "href"]);
}

/** The symbol's TRANSFORM x1 / y1 signs (SCH_SYMBOL::GetTransform) from its angle and mirror. */
export function symbolTransform(node: SNode): { x1: number; y1: number } {
  const a = kid(node, "at"), rot = ((Math.round(a ? num(a[3]) : 0) % 360) + 360) % 360;
  let x1 = 1, y1 = 0;
  // the parser's TRANSFORM for (at x y 90) is (0, 1, -1, 0) and for 270 (0, -1, 1, 0); (mirror y) negates x1 / y1, (mirror x) keeps them
  if (rot === 90) { x1 = 0; y1 = 1; } else if (rot === 180) { x1 = -1; y1 = 0; } else if (rot === 270) { x1 = 0; y1 = -1; }
  const m = kid(node, "mirror");
  if (m && str(m[1]) === "y") { x1 = -x1; y1 = -y1; }
  return { x1, y1 };
}

const polyPoints = (n: SNode): number => { const p = kid(n, "pts"); return p ? kids(p, "xy").length : 0; };

// ---------------------------------------------------------------- the walk
const LABELS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const SHAPES = new Set(["polyline", "rectangle", "circle", "arc", "bezier"]);
const fieldName = (p: SNode): string => str(p[1]) === "private" && p.length > 3 && !isList(p[2]) ? str(p[2]) : str(p[1]);
const META = /^ki_/;

/**
 * visitItem over one item of one sheet instance: the item's new node when something of it changed, else null.
 * The node handed in is not touched.
 */
export function visitItem(item: { id: string; kind: string; node: SNode }, scope: Scope, f: Filters, s: SetTo, ctx: SheetCtx): SNode | null {
  const kind = item.kind;
  if (f.net !== null && f.net !== "") {
    const net = ctx.netOf(item.id);
    if (!net || !wild(f.net, net)) return null;
  }
  if (kind === "symbol") {
    if (f.reference !== null && f.reference !== "" && !wild(f.reference, ctx.refOf(item.node))) return null;
    if (f.libId !== null && f.libId !== "") { const l = kid(item.node, "lib_id"); if (!wild(f.libId, l ? str(l[1]) : "")) return null; }
    if (f.power !== null && ctx.isPower(item.node) !== f.power) return null;
  }
  const out = clone(item.node), self = ctx.selected(item.id);
  // processItem's "Selected items only": the item or its parent
  const pass = (ownSelected: boolean): boolean => !f.selectedOnly || ownSelected || self;
  const nameOk = (p: SNode): boolean => f.fieldName === null || f.fieldName === "" || wild(f.fieldName, fieldName(p));
  const doField = (p: SNode, flipH = false, flipV = false): void => { editText(p, s, flipH, flipV, true); editField(p, s); };

  if (kind === "symbol") {
    if (!pass(false)) return null;
    const t = symbolTransform(item.node), fh = t.x1 < 0, fv = t.y1 < 0;
    for (const p of kids(out, "property")) {
      const n = fieldName(p); if (META.test(n)) continue;
      if (n === "Reference") { if (scope.references) doField(p, fh, fv); }
      else if (n === "Value") { if (scope.values) doField(p, fh, fv); }
      else if (scope.otherFields && nameOk(p)) doField(p, fh, fv);
    }
  } else if (kind === "sheet") {
    for (const p of kids(out, "property")) {
      const n = fieldName(p);
      if (n === "Sheetname") { if (scope.sheetTitles && pass(false)) doField(p); }
      else if (scope.sheetFields && nameOk(p) && pass(false)) doField(p);
    }
    if (scope.sheetBorders && (!f.selectedOnly || self) && (s.lineWidth !== undefined || s.lineColor !== undefined || s.fillColor !== undefined)) {
      // SetBorderWidth / SetBorderColor / SetBackgroundColor (no line style for a sheet border)
      editStroke(out, { lineWidth: s.lineWidth, lineColor: s.lineColor });
      if (s.fillColor !== undefined) put(out, "fill", [["color", ...colorVals(s.fillColor || [0, 0, 0, 0])]], ["uuid"]);
    }
    if (scope.sheetPins && pass(false)) for (const pin of kids(out, "pin")) editText(pin, s, false, false, false);
  } else if (kind === "wire" || kind === "bus" || kind === "polyline") {
    if ((kind === "polyline" && scope.schTextAndGraphics) || (kind === "wire" && scope.wires) || (kind === "bus" && scope.buses)) {
      if (!pass(false)) return null;
      editStroke(out, s);
      if (kind === "polyline" && s.fillColor !== undefined && polyPoints(item.node) > 2) editFill(out, s.fillColor);   // a 2-point line is a SCH_LINE, not a SCH_SHAPE
    }
  } else if (LABELS.has(kind)) {
    const at = ctx.attached(item.id);
    const reach = (scope.wires && at.wire) || (scope.buses && at.bus) || (scope.globalLabels && kind === "global_label") || (scope.hierLabels && kind === "hierarchical_label");
    if (reach && pass(false)) {
      editText(out, s, false, false, false);
      if (s.orientation !== undefined) editSpin(kind, out, s.orientation);
    }
    if (scope.labelFields && pass(false)) for (const p of kids(out, "property")) if (nameOk(p)) doField(p);
  } else if (kind === "junction") {
    // the first connected line decides (a junction's ConnectedItems)
    const at = ctx.attached(item.id);
    if (((at.bus && scope.buses) || (at.wire && !at.bus && scope.wires) || (at.wire && at.bus && scope.wires)) && pass(false)) {
      if (s.junctionSize !== undefined) put(out, "diameter", [r4(s.junctionSize)], ["color", "uuid"]);
      if (s.junctionColor !== undefined) put(out, "color", colorVals(s.junctionColor || [0, 0, 0, 0]), ["uuid"]);
    }
  } else if (kind === "text" || kind === "text_box" || SHAPES.has(kind)) {
    if (!scope.schTextAndGraphics || !pass(false)) return null;
    if (kind === "text" || kind === "text_box") editText(out, s, false, false, true);
    if (kind !== "text") editStroke(out, s);
    if (kind !== "text" && s.fillColor !== undefined) editFill(out, s.fillColor);
  } else return null;
  return JSON.stringify(out) === JSON.stringify(item.node) ? null : out;
}

/** The symbol's reference on a sheet instance: the (instances) path that ends with the instance's sheet uuids. */
export function refOnInstance(node: SNode, uuidPath: string[]): string {
  const inst = kid(node, "instances"); const tail = uuidPath.filter(Boolean).slice(1).join("/");
  const all: SNode[] = []; if (inst) for (const pr of kids(inst, "project")) all.push(...kids(pr, "path"));
  const hit = all.find((p) => { const s = str(p[1]).replace(/^\/+|\/+$/g, ""); return tail ? s.endsWith(tail) : s.split("/").length <= 1; }) || all[0];
  if (hit) { const r = kid(hit, "reference"); if (r) return str(r[1]); }
  const f = kids(node, "property").find((p) => fieldName(p) === "Reference");
  return f ? str(f[2]) : "";
}

/** "#rrggbb" + alpha 0..1 → Color; the reverse for the swatch. */
export function hexToColor(hex: string, alpha = 1): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim()); if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), alpha];
}
export function colorToHex(c: Color): string { return c ? "#" + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v as number))).toString(16).padStart(2, "0")).join("") : "#000000"; }
