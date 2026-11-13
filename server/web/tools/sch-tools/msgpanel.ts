// msgpanel.ts — the schematic items' message panel columns, SCH_*::GetMsgPanelInfo, for the one selected item
// (SCH_INSPECTION_TOOL::UpdateMessagePanel): sch_symbol.cpp, sch_line.cpp, sch_label.cpp, sch_pin.cpp,
// sch_field.cpp, sch_sheet.cpp, sch_junction.cpp, sch_text.cpp, sch_textbox.cpp, sch_shape.cpp (EDA_SHAPE::
// ShapeGetMsgPanelInfo), sch_bus_entry.cpp, sch_bitmap.cpp, sch_rule_area.cpp, sch_table.cpp.
//
// Pure over the document: the connection of a wire, label, junction or bus entry (SCH_CONNECTIVITY::
// AppendConnectionInfo) comes from the caller, which owns the hierarchy's net map.
import type { Units } from "../../store";
import { angleText, messageText } from "../../units";
import { K, kid, kids, num, str, atOf, ptsOf } from "./state";
import { symbolPins, type SymPin } from "./autoplace";
import { isPowerSymbol } from "./dom";
import { spinOfNode } from "./autorotate";
import { base64ToBytes, imageData, imageSize } from "./nodes";

export interface MsgItem { title: string; value: string }
export interface Connection { name: string; bus: boolean; netclass: string }
export interface SchMsgOpts {
  units: Units;
  /** the human-readable path of the sheet on screen ("/" on the root, "/Sub/" below) */
  sheetPath?: string;
  /** SCH_CONNECTIVITY::AppendConnectionInfo's source: the item's connection on this sheet (a pin by number) */
  connection?: (item: KItem, pin?: string) => Connection | null;
  /** KIUI::EllipsizeStatusText's width rule; the default only folds line breaks and tabs */
  ellipsize?: (s: string) => string;
  /** the image's PPI and pixel size (SCH_BITMAP), read by the caller from its data */
  imageInfo?: (item: KItem) => { ppi: number; px: [number, number] } | null;
}
export interface SchMsgSel { id: string; pin?: string; field?: string }

const yes = (n: SNode | null | undefined): boolean => !!n && str(n[1]) !== "no";
const flag = (node: SNode, key: string): boolean => { const k = kid(node, key); return k ? str(k[1] ?? "yes") !== "no" : node.includes(key); };

/** UnescapeString: KiCad's {slash} / {dblquote} … escapes back to their characters. */
export function unescapeString(s: string): string {
  const MAP: Record<string, string> = { dblquote: '"', quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{" };
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in MAP ? MAP[k] : m));
}

// ---------------------------------------------------------------- text attributes (EDA_TEXT)
function effects(node: SNode): SNode | null { return kid(node, "effects"); }
function font(node: SNode): SNode | null { const e = effects(node); return e ? kid(e, "font") : null; }
function textWidth(node: SNode): number { const f = font(node), s = f ? kid(f, "size") : null; return s ? num(s[2] ?? s[1], 1.27) : 1.27; }
function fontName(node: SNode): string { const f = font(node), face = f ? kid(f, "face") : null; return face ? str(face[1]) : "Default"; }
function bold(node: SNode): boolean { const f = font(node); return !!f && flag(f, "bold"); }
function italic(node: SNode): boolean { const f = font(node); return !!f && flag(f, "italic"); }
/** SCH_TEXT / SCH_LABEL_BASE's style column ("Bold Italic"). */
function styleName(node: SNode): string { const b = bold(node), i = italic(node); return b && i ? "Bold Italic" : b ? "Bold" : i ? "Italic" : "Normal"; }
/** EDA_TEXT::GetTextStyleName ("Bold+Italic"). */
function textStyleName(node: SNode): string { const b = bold(node), i = italic(node); return b && i ? "Bold+Italic" : b ? "Bold" : i ? "Italic" : "Normal"; }
function justify(node: SNode): string[] { const e = effects(node), j = e ? kid(e, "justify") : null; return j ? j.slice(1).map(String) : []; }
function hJust(node: SNode): "left" | "center" | "right" { const j = justify(node); return j.includes("left") ? "left" : j.includes("right") ? "right" : "center"; }
function vJust(node: SNode): "top" | "center" | "bottom" { const j = justify(node); return j.includes("top") ? "top" : j.includes("bottom") ? "bottom" : "center"; }
function hidden(node: SNode): boolean { const e = effects(node); return yes(kid(node, "hide")) || (!!e && flag(e, "hide")); }

// ---------------------------------------------------------------- strokes (STROKE_PARAMS::GetMsgPanelInfo)
const LINE_STYLES: Record<string, string> = { solid: "Solid", dash: "Dashed", dot: "Dotted", dash_dot: "Dash-Dot", dash_dot_dot: "Dash-Dot-Dot" };
function strokeOf(node: SNode): { width: number; type: string } {
  const s = kid(node, "stroke"); if (!s) return { width: 0, type: "default" };
  const w = kid(s, "width"), t = kid(s, "type"); return { width: w ? num(w[1], 0) : 0, type: t ? str(t[1]) : "default" };
}
function strokeRows(node: SNode, o: SchMsgOpts, style = true, width = true): MsgItem[] {
  const s = strokeOf(node), out: MsgItem[] = [];
  if (style) out.push({ title: "Line Style", value: LINE_STYLES[s.type] || "Default" });
  if (width) out.push({ title: "Line Width", value: len(s.width, o) });
  return out;
}
const len = (mm: number, o: SchMsgOpts): string => messageText(mm, o.units, "sch", true);
const ell = (s: string, o: SchMsgOpts): string => { const t = unescapeString(s).replace(/[\n\r\t]/g, " "); return o.ellipsize ? o.ellipsize(t) : t; };

/** SCH_CONNECTIVITY::AppendConnectionInfo: the connection's name, and for a net its resolved netclass. */
function connectionRows(item: KItem, o: SchMsgOpts, pin?: string): MsgItem[] {
  const c = o.connection ? o.connection(item, pin) : null; if (!c) return [];
  const out: MsgItem[] = [{ title: "Connection Name", value: unescapeString(c.name) }];
  if (!c.bus) out.push({ title: "Resolved Netclass", value: unescapeString(c.netclass || "Default") });
  return out;
}

// ---------------------------------------------------------------- symbols
const fieldNode = (node: SNode, name: string): SNode | null => kids(node, "property").find((p) => str(p[1]) === name) || null;
const fieldText = (node: SNode, name: string): string => { const f = fieldNode(node, name); return f ? str(f[2]) : ""; };
function libOf(doc: KDoc, node: SNode): SNode | null {
  const name = str((kid(node, "lib_name") || kid(node, "lib_id") || [])[1]), id = str((kid(node, "lib_id") || [])[1]);
  return (K.resolveLib(doc, name) as SNode | null) || (K.resolveLib(doc, id) as SNode | null) || doc.lib.get(name) || doc.lib.get(id) || null;
}
/** The symbol's units and body styles as the library defines them ("Name_U_S" sub-symbols). */
function libUnitInfo(lib: SNode | null): { units: number; styles: number; names: Map<number, string> } {
  let units = 1, styles = 1; const names = new Map<number, string>();
  if (!lib) return { units, styles, names };
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (!m) continue;
    units = Math.max(units, +m[1]); styles = Math.max(styles, +m[2]);
    const un = kid(sub, "unit_name"); if (un && +m[1] > 0) names.set(+m[1], str(un[1]));
  }
  if (kid(lib, "body_styles")) styles = Math.max(styles, kids(lib, "body_styles")[0].length - 1);
  return { units, styles, names };
}
/** LIB_SYMBOL::LetterSubReference( unit, 'A' ): A … Z, AA … */
function unitLetter(unit: number): string { let n = unit, s = ""; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }

function symbolRows(doc: KDoc, it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [], lib = libOf(doc, n);
  const libId = str((kid(n, "lib_id") || [])[1]), colon = libId.indexOf(":");
  const nick = colon >= 0 ? libId.slice(0, colon) : "", itemName = colon >= 0 ? libId.slice(colon + 1) : libId;
  const ref = it.ref || fieldText(n, "Reference"), value = fieldText(n, "Value");
  const excludes = (): void => {
    const m: string[] = [];
    if (flag(n, "exclude_from_sim")) m.push("Simulation");
    const bom = kid(n, "in_bom"); if (bom && str(bom[1]) === "no") m.push("BOM");
    const brd = kid(n, "on_board"); if (brd && str(brd[1]) === "no") m.push("Board");
    if (flag(n, "dnp")) m.push("DNP");
    if (m.length) out.push({ title: "Exclude from", value: m.join(", ") });
  };
  if (lib) {
    if (isPowerSymbol(doc, libId)) out.push({ title: "Power symbol", value: ell(value, o) });
    else {
      out.push({ title: "Reference", value: unescapeString(ref) }, { title: "Value", value: ell(value, o) });
      excludes();
      out.push({ title: "Name", value: ell(itemName, o) });
    }
    const ext = kid(lib, "extends");
    if (ext) out.push({ title: "Derived from", value: unescapeString(str(ext[1])) });
    else out.push({ title: "Library", value: nick || "Undefined!!!" });
    const fp = ell(fieldText(n, "Footprint"), o);
    out.push({ title: "Footprint", value: fp || "<Unknown>" });
    const kw = fieldNode(lib, "ki_keywords");
    out.push({ title: `Description: ${fieldText(n, "Description") || fieldText(lib, "Description")}`, value: `Keywords: ${kw ? str(kw[2]) : ""}` });
  } else {
    out.push({ title: "Reference", value: ref }, { title: "Value", value: ell(value, o) });
    excludes();
    out.push({ title: "Name", value: ell(itemName, o) });
    out.push({ title: "Library", value: nick ? `Symbol not found in ${nick}!` : "No library defined!" });
  }
  return out;
}

const PIN_TYPE: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
const PIN_SHAPE: Record<string, string> = { line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low", clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic" };
const PIN_ORIENT: Record<number, string> = { 0: "Right", 90: "Up", 180: "Left", 270: "Down" };

/** SCH_PIN::GetMsgPanelInfo for a pin of a placed symbol. */
function pinRows(doc: KDoc, it: KItem, number: string, o: SchMsgOpts): MsgItem[] {
  const pin: SymPin | undefined = symbolPins(doc, it).find((p) => p.number === number); if (!pin) return [];
  const n = it.node, lib = libOf(doc, n), info = libUnitInfo(lib), out: MsgItem[] = [{ title: "Type", value: "Pin" }];
  // SCH_ITEM::GetMsgPanelInfo: the parent symbol's unit and body style
  const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1;
  if (info.units > 1) out.push({ title: "Unit", value: info.names.get(unit) || unitLetter(unit) });
  if (info.styles > 1) { const bs = kid(n, "body_style") || kid(n, "convert"); const s = bs ? num(bs[1], 1) : 1; out.push({ title: "Body Style", value: s === 1 ? "Standard" : s === 2 ? "Alternate" : `Body style ${s}` }); }
  out.push({ title: "Name", value: unescapeString(pin.name === "~" ? "" : pin.name) }, { title: "Number", value: pin.number === "~" ? "" : pin.number },
    { title: "Type", value: PIN_TYPE[pin.type] || "Unspecified" }, { title: "Style", value: PIN_SHAPE[pin.shape || "line"] || "Line" },
    { title: "Visible", value: pin.hidden ? "No" : "Yes" }, { title: "Length", value: len(pin.len, o) },
    { title: "Orientation", value: PIN_ORIENT[((Math.round(pin.libRot || 0) % 360) + 360) % 360] || "Right" },
    { title: it.ref || fieldText(n, "Reference"), value: unescapeString(fieldText(n, "Value")) });
  return out;
}

/** SCH_FIELD::GetMsgPanelInfo. */
function fieldRows(it: KItem, name: string, o: SchMsgOpts): MsgItem[] {
  const f = fieldNode(it.node, name); if (!f) return [];
  const h = hJust(f), v = vJust(f);
  return [
    { title: "Symbol Field", value: unescapeString(name) }, { title: "Text", value: ell(str(f[2]), o) },
    { title: "Visible", value: hidden(f) ? "No" : "Yes" }, { title: "Font", value: fontName(f) }, { title: "Style", value: textStyleName(f) },
    { title: "Text Size", value: len(textWidth(f), o) },
    { title: "H Justification", value: h === "left" ? "Left" : h === "right" ? "Right" : "Center" },
    { title: "V Justification", value: v === "top" ? "Top" : v === "bottom" ? "Bottom" : "Center" },
  ];
}

// ---------------------------------------------------------------- the rest
const LABEL_TITLE: Record<string, string> = { label: "Label", directive_label: "Directive Label", netclass_flag: "Directive Label", global_label: "Global Label", hierarchical_label: "Hierarchical Label" };
const LABEL_SHAPE: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-State", passive: "Passive" };
const SPIN_JUST = ["Align left", "Align bottom", "Align right", "Align top"];   // SPIN_STYLE RIGHT, UP, LEFT, BOTTOM

function labelRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [{ title: LABEL_TITLE[it.kind], value: unescapeString(str(n[1])) }];
  if (it.kind === "global_label" || it.kind === "hierarchical_label") { const sh = kid(n, "shape"); out.push({ title: "Type", value: LABEL_SHAPE[sh ? str(sh[1]) : "input"] || "???" }); }
  out.push({ title: "Font", value: fontName(n) }, { title: "Style", value: styleName(n) }, { title: "Text Size", value: len(textWidth(n), o) },
    { title: "Justification", value: SPIN_JUST[spinOfNode(n)] || "???" });
  out.push(...connectionRows(it, o));
  return out;
}

function textRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [{ title: "Text", value: ell(str(n[1]), o) }];
  if (flag(n, "exclude_from_sim")) out.push({ title: "Exclude from", value: "Simulation" });
  const h = hJust(n);
  out.push({ title: "Font", value: fontName(n) }, { title: "Style", value: styleName(n) }, { title: "Text Size", value: len(textWidth(n), o) },
    { title: "Justification", value: h === "left" ? "Align left" : h === "right" ? "Align right" : "Align center" });
  return out;
}

function textBoxRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [{ title: "Text Box", value: ell(str(n[1]), o) }];
  if (flag(n, "exclude_from_sim")) out.push({ title: "Exclude from", value: "Simulation" });
  const [, , w, h] = boxOf(n);
  out.push({ title: "Font", value: fontName(n) }, { title: "Style", value: styleName(n) }, { title: "Text Size", value: len(textWidth(n), o) },
    { title: "Box Width", value: len(Math.abs(w), o) }, { title: "Box Height", value: len(Math.abs(h), o) }, ...strokeRows(n, o));
  return out;
}
/** A text box / rectangle's (x, y, w, h) from (at)(size) or (start)(end). */
function boxOf(n: SNode): [number, number, number, number] {
  const s = kid(n, "start"), e = kid(n, "end");
  if (s && e) return [num(s[1]), num(s[2]), num(e[1]) - num(s[1]), num(e[2]) - num(s[2])];
  const a = atOf(n), sz = kid(n, "size"); return [a[0], a[1], sz ? num(sz[1]) : 0, sz ? num(sz[2]) : 0];
}

function shapeRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [];
  const pts = (): number[][] => ptsOf(n) as number[][];
  switch (it.kind) {
    case "circle": { const c = kid(n, "center"), r = kid(n, "radius"); out.push({ title: "Shape", value: "Circle" }, { title: "Radius", value: len(r ? num(r[1]) : 0, o) }); void c; break; }
    case "arc": {
      const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end");
      const A: number[] = s ? [num(s[1]), num(s[2])] : [0, 0], M: number[] = m ? [num(m[1]), num(m[2])] : A, B: number[] = e ? [num(e[1]), num(e[2])] : A;
      const c = circumcentre(A, M, B), r = c ? Math.hypot(A[0] - c[0], A[1] - c[1]) : 0;
      let ang = 0;
      if (c) { const a0 = Math.atan2(A[1] - c[1], A[0] - c[0]), am = Math.atan2(M[1] - c[1], M[0] - c[0]), a1 = Math.atan2(B[1] - c[1], B[0] - c[0]); const sweep = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); const cw = sweep(am - a0) < sweep(a1 - a0); ang = (cw ? sweep(a1 - a0) : -sweep(a0 - a1)) * 180 / Math.PI; }
      out.push({ title: "Shape", value: "Arc" }, { title: "Length", value: len(Math.abs(ang) * Math.PI / 180 * r, o) }, { title: "Angle", value: angleText(ang) }, { title: "Radius", value: len(r, o) });
      break;
    }
    case "bezier": { const p = pts(); out.push({ title: "Shape", value: "Curve" }, { title: "Length", value: len(bezierLength(p), o) }); break; }
    case "rectangle": { const [, , w, h] = boxOf(n); out.push({ title: "Shape", value: "Rectangle" }, { title: "Width", value: len(Math.abs(w), o) }, { title: "Height", value: len(Math.abs(h), o) }); break; }
    case "polyline": out.push({ title: "Shape", value: "Polygon" }, { title: "Points", value: String(pts().length) }); break;
    default: break;
  }
  out.push(...strokeRows(n, o));
  return out;
}
function circumcentre(a: number[], b: number[], c: number[]): number[] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
function bezierLength(p: number[][]): number {
  if (p.length < 4) return 0;
  let l = 0, prev = p[0];
  for (let i = 1; i <= 64; i++) { const t = i / 64, u = 1 - t; const q = [u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0], u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]]; l += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
  return l;
}

/** SCH_LINE::GetMsgPanelInfo (a wire, a bus, or a two-point graphic line). */
function lineRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, out: MsgItem[] = [{ title: "Line Type", value: it.kind === "wire" ? "Wire" : it.kind === "bus" ? "Bus" : "Graphical" }];
  const st = strokeOf(n);
  // a wire or bus whose own style is DEFAULT draws in its netclass's style (GetEffectiveLineStyle differs)
  if ((it.kind === "wire" || it.kind === "bus") && st.type === "default") out.push({ title: "Line Style", value: "from netclass" });
  else out.push(...strokeRows(n, o, true, false));
  if (it.kind === "wire" || it.kind === "bus") out.push(...connectionRows(it, o));
  return out;
}

function sheetRows(it: KItem, o: SchMsgOpts): MsgItem[] {
  const n = it.node, name = fieldText(n, "Sheetname") || fieldText(n, "Sheet name"), file = fieldText(n, "Sheetfile") || fieldText(n, "Sheet file");
  const out: MsgItem[] = [{ title: "Sheet Name", value: ell(name, o) }];
  if (o.sheetPath !== undefined) { const base = o.sheetPath.endsWith("/") ? o.sheetPath : o.sheetPath + "/"; out.push({ title: "Hierarchical Path", value: `${base}${name}/` }); }
  out.push({ title: "File Name", value: ell(file, o) });
  const m: string[] = [];
  if (flag(n, "exclude_from_sim")) m.push("Simulation");
  const bom = kid(n, "in_bom"); if (bom && str(bom[1]) === "no") m.push("BOM");
  const brd = kid(n, "on_board"); if (brd && str(brd[1]) === "no") m.push("Board");
  if (flag(n, "dnp")) m.push("DNP");
  if (m.length) out.push({ title: "Exclude from", value: m.join(", ") });
  return out;
}

/** An image's pixel size and PPI (a PNG's pHYs chunk in pixels per metre; BITMAP_BASE's 300 otherwise). */
export function imageInfoOf(node: SNode): { ppi: number; px: [number, number] } | null {
  let b: Uint8Array | null = null; try { b = base64ToBytes(imageData(node)); } catch (e) { b = null; }
  const sz = imageSize(b); if (!b || !sz) return null;
  let ppi = 300;
  if (b[0] === 0x89 && b[1] === 0x50) {
    for (let i = 8; i + 12 <= b.length;) {
      const ln = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3], type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === "pHYs" && ln >= 9) { const ppm = ((b[i + 8] << 24) >>> 0) + (b[i + 9] << 16) + (b[i + 10] << 8) + b[i + 11]; if (b[i + 16] === 1 && ppm > 0) ppi = Math.round(ppm * 0.0254); break; }
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + ln;
    }
  }
  return { ppi, px: [sz[0], sz[1]] };
}

/**
 * The message panel for one selected item (SCH_INSPECTION_TOOL::UpdateMessagePanel): a symbol, a pin of a symbol
 * (`sel.pin`), a symbol or sheet field (`sel.field`) or any other schematic item.  [] when it shows nothing.
 */
export function msgPanelInfo(doc: KDoc, sel: SchMsgSel, o: SchMsgOpts): MsgItem[] {
  const it = doc.items.get(sel.id); if (!it) return [];
  if (sel.pin !== undefined && it.kind === "symbol") return pinRows(doc, it, sel.pin, o);
  if (sel.field !== undefined) return fieldRows(it, sel.field, o);
  switch (it.kind) {
    case "symbol": return symbolRows(doc, it, o);
    case "wire": case "bus": return lineRows(it, o);
    case "polyline": return ptsOf(it.node).length === 2 ? lineRows(it, o) : shapeRows(it, o);
    case "label": case "global_label": case "hierarchical_label": case "directive_label": case "netclass_flag": return labelRows(it, o);
    case "text": return textRows(it, o);
    case "text_box": return textBoxRows(it, o);
    case "rectangle": case "circle": case "arc": case "bezier": return shapeRows(it, o);
    case "sheet": return sheetRows(it, o);
    case "junction": {
      const d = kid(it.node, "diameter"), dia = d && num(d[1], 0) > 0 ? num(d[1]) : (doc as KDoc & { schSettings?: { junctionDiameter?: number } }).schSettings?.junctionDiameter ?? 0.9144;
      return [{ title: "Junction", value: "" }, { title: "Size", value: len(dia, o) }, ...connectionRows(it, o)];
    }
    case "bus_entry": return [{ title: "Bus Entry Type", value: "Wire" }, ...connectionRows(it, o)];
    case "image": {
      const sc = kid(it.node, "scale"), scale = sc ? num(sc[1], 1) : 1, info = o.imageInfo ? o.imageInfo(it) : imageInfoOf(it.node);
      const ppi = info && info.ppi > 0 ? info.ppi : 300, px = info ? info.px : [0, 0];
      return [{ title: "Bitmap", value: "" }, { title: "PPI", value: `${Math.round(ppi)} ` }, { title: "Scale", value: `${scale.toFixed(6)} ` },
        { title: "Width", value: len(px[0] / ppi * 25.4 * scale, o) }, { title: "Height", value: len(px[1] / ppi * 25.4 * scale, o) }];
    }
    case "rule_area": {
      const pl = kid(it.node, "polyline") || it.node;
      return [{ title: "Rule Area", value: "" }, { title: "Points", value: String(ptsOf(pl).length) }, ...strokeRows(pl, o), { title: "Resolved netclass", value: "<None>" }];
    }
    case "table": { const c = kid(it.node, "column_count"); return [{ title: "Table", value: `${c ? num(c[1], 0) : 0} Columns` }]; }
    default: return [];   // SCH_NO_CONNECT and the rest: SCH_ITEM::GetMsgPanelInfo, nothing outside a symbol
  }
}

/** KIUI::EllipsizeMenuText: escapes undone, line breaks and tabs folded, anything past 36 characters cut to 34 and "...". */
export function ellipsizeMenuText(s: string): string {
  const t = unescapeString(s).replace(/[\n\r\t]/g, " ");
  return t.length > 36 ? t.slice(0, 34) + "..." : t;
}
/**
 * EDA_ITEM::GetItemDescription( aUnitsProvider, aFull = false ) of a schematic item: the wording of the Clarify Selection
 * menu (SELECTION_TOOL::doSelectionMenu), from sch_line.cpp, sch_symbol.cpp, sch_label.cpp, sch_shape.cpp, sch_sheet.cpp …
 * `field` names a symbol / sheet field (SCH_FIELD::GetItemDescription), `pin` a symbol pin by number.
 */
export function itemDescription(doc: KDoc, id: string, units: Units, sub?: { field?: string; pin?: string }): string {
  const it = doc.items.get(id); if (!it) return "";
  const n = it.node, L = (mm: number) => messageText(mm, units, "sch", true), text = () => ellipsizeMenuText(str(n[1]));
  if (sub && sub.field !== undefined) {
    const f = fieldNode(n, sub.field), content = f ? ellipsizeMenuText(str(f[2])) : "";
    return content ? `Field ${unescapeString(sub.field)} '${content}'` : `Field ${unescapeString(sub.field)} (empty)`;
  }
  switch (it.kind) {
    case "symbol": {
      const libId = str((kid(n, "lib_id") || [])[1]), name = libId.slice(libId.indexOf(":") + 1);
      const ref = ellipsizeMenuText(it.ref || fieldText(n, "Reference"));
      if (sub && sub.pin !== undefined) return `Symbol ${ref} Pin ${sub.pin}`;
      return `Symbol ${ref} [${ellipsizeMenuText(name)}]`;
    }
    case "wire": case "bus": case "polyline": {
      const p = ptsOf(n);
      if (it.kind === "polyline" && p.length !== 2) return `Polyline, ${p.length} points`;   // SCH_SHAPE POLY
      const what = it.kind === "wire" ? "Wire" : it.kind === "bus" ? "Bus" : "Graphic Line";
      const [a, b] = p.length >= 2 ? [p[0], p[p.length - 1]] : [[0, 0], [0, 0]];
      const dir = a[0] === b[0] ? "Vertical " : a[1] === b[1] ? "Horizontal " : "";
      return `${dir}${what}, length ${L(Math.hypot(b[0] - a[0], b[1] - a[1]))}`;
    }
    case "junction": return "Junction";
    case "no_connect": return "No Connect";
    case "bus_entry": return "Bus to wire entry";
    case "label": return `Label '${text()}'`;
    case "global_label": return `Global Label '${text()}'`;
    case "hierarchical_label": return `Hierarchical Label '${text()}'`;
    case "directive_label": case "netclass_flag": {
      const f = kids(n, "property")[0]; if (!f) return "Directive Label";
      const content = ellipsizeMenuText(str(f[2])), name = unescapeString(str(f[1]));
      return content ? `Directive Label [${name} ${content}]` : `Directive Label [${name} (empty)]`;
    }
    case "text": return `Graphic Text '${text()}'`;
    case "text_box": return `Text box '${text()}'`;
    case "sheet": return `Hierarchical Sheet '${ellipsizeMenuText(fieldText(n, "Sheetname") || fieldText(n, "Sheet name"))}'`;
    case "image": return "Image";
    case "rule_area": return "Schematic rule area";
    case "table": { const c = kid(n, "column_count"); return `${c ? num(c[1], 0) : 0} Column Table`; }
    case "rectangle": { const [, , w, h] = boxOf(n); return `Rectangle, width ${L(Math.abs(w))} height ${L(Math.abs(h))}`; }
    case "circle": {
      const c = kid(n, "center"), r = kid(n, "radius"), e = kid(n, "end");
      const rad = r ? num(r[1]) : c && e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : 0;
      return `Circle, radius ${L(rad)}`;
    }
    case "arc": {
      const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end");
      const A = s ? [num(s[1]), num(s[2])] : [0, 0], M = m ? [num(m[1]), num(m[2])] : A, B = e ? [num(e[1]), num(e[2])] : A;
      const c = circumcentre(A, M, B); return `Arc, radius ${L(c ? Math.hypot(A[0] - c[0], A[1] - c[1]) : 0)}`;
    }
    case "bezier": return `Bezier Curve, ${ptsOf(n).length} points`;
    case "ellipse": case "ellipse_arc": {
      const v = (k: string) => num((kid(n, k) || [])[1], 0);
      return `${it.kind === "ellipse" ? "Ellipse" : "Elliptical Arc"}, ${L(v("major_radius"))} x ${L(v("minor_radius"))}`;
    }
    case "group": { const nm = kid(n, "name") ? str(kid(n, "name")![1]) : str(n[1]), m = kid(n, "members"); const cnt = m ? m.length - 1 : 0; return nm ? `Group '${nm}', ${cnt} members` : `Unnamed Group, ${cnt} members`; }
    default: return it.kind;
  }
}
