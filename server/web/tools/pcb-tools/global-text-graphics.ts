// pcb-tools/global-text-graphics.ts — DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS::TransferDataFromWindow / visitItem /
// processItem (dialog_global_edit_text_and_graphics.cpp): Edit > Edit Text & Graphic Properties... on board nodes.
// The scope picks the footprint fields, footprint texts / graphics / dimensions and the board's texts / graphics /
// dimensions; the filters keep items on a layer, of a parent reference or footprint, or selected; the action sets
// the specified values or the layer-class defaults (StyleFromSettings).  Plain node editing, driven by node tests.
import { wildCompare } from "./exchange";
import { K } from "./state";
import { DIM_DEFAULTS, isList, layerStyle, r6, rotator } from "./util";

export interface TextGraphicsScope {
  references?: boolean; values?: boolean; otherFootprintFields?: boolean; footprintTexts?: boolean; footprintGraphics?: boolean; footprintDimensions?: boolean;
  boardText?: boolean; boardGraphics?: boolean; boardDimensions?: boolean;
}
export interface TextGraphicsFilter { layer?: string | null; reference?: string | null; footprint?: string | null; selectedOnly?: boolean }
/** null / undefined = leave as it is (INDETERMINATE_ACTION / wxCHK_UNDETERMINED) */
export interface TextGraphicsValues {
  layer?: string | null; visible?: boolean | null; lineWidth?: number | null; kicadFont?: boolean; textWidth?: number | null; textHeight?: number | null;
  thickness?: number | null; autoThickness?: boolean; bold?: boolean | null; italic?: boolean | null; keepUpright?: boolean | null; centerOnFootprint?: boolean;
}
export interface TextGraphicsJob { scope: TextGraphicsScope; filter: TextGraphicsFilter; specified: boolean; values: TextGraphicsValues; selection?: Set<string> }

const SHAPES = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"]);
/** PCB_SHAPE_T || PCB_BARCODE_T: the graphics the scope visits (a barcode is no PCB_SHAPE: it has no stroke). */
const GRAPHICS = new Set([...SHAPES, "barcode"]);
/** The text items that store keep-upright: PCB_TEXT / PCB_FIELD (format writes (unlocked) only for those, never text boxes or cells). */
const storesUpright = (n: SNode) => n[0] === "fp_text" || n[0] === "property";
const isText = (n: SNode) => n[0] === "gr_text" || n[0] === "fp_text" || n[0] === "gr_text_box" || n[0] === "fp_text_box" || n[0] === "property" || n[0] === "table_cell";
const isField = (n: SNode) => n[0] === "property" || (n[0] === "fp_text" && (n[1] === "reference" || n[1] === "value"));
const fieldName = (n: SNode) => (n[0] === "fp_text" ? (n[1] === "reference" ? "Reference" : "Value") : K.str(n[1]));
const textOf = (n: SNode) => (n[0] === "gr_text_box" || n[0] === "fp_text_box" || n[0] === "table_cell" ? K.str(n[1]) : K.str(n[2]));
const layerOfNode = (n: SNode) => { const l = K.kid(n, "layer"); return l ? K.str(l[1]) : ""; };

function effects(n: SNode): SNode { let e = K.kid(n, "effects"); if (!e) { e = ["effects"]; n.push(e); } return e; }
function font(n: SNode): SNode { const e = effects(n); let f = K.kid(e, "font"); if (!f) { f = ["font"]; e.splice(1, 0, f); } return f; }
function setFontFlag(f: SNode, key: string, on: boolean): void {
  for (let i = f.length - 1; i > 0; i--) { const c = f[i]; if (c === key || (isList(c) && c[0] === key)) f.splice(i, 1); }
  if (on) f.push([key, "yes"]);
}
const fontFlag = (n: SNode, key: string) => { const e = K.kid(n, "effects"); const f = e && K.kid(e, "font"); if (!f) return false; if (f.includes(key)) return true; const k = K.kid(f, key); return !!k && K.str(k[1]) !== "no"; };
function setSize(n: SNode, w: number | null, h: number | null): void {
  const f = font(n); let s = K.kid(f, "size"); if (!s) { s = ["size", 1, 1]; f.splice(1, 0, s); }
  if (h !== null) s[1] = r6(h); if (w !== null) s[2] = r6(w);
}
function setThickness(n: SNode, t: number | null): void {
  const f = font(n); const k = K.kid(f, "thickness");
  if (t === null) { if (k) f.splice(f.indexOf(k), 1); return; }     // SetAutoThickness: no stored pen width
  if (k) k[1] = r6(t); else { const s = K.kid(f, "size"); f.splice(s ? f.indexOf(s) + 1 : f.length, 0, ["thickness", r6(t)]); }
}
function setLayer(n: SNode, layer: string): void { const l = K.kid(n, "layer"); if (l) l[1] = layer; }
/** PCB_BARCODE::SetTextSize: its (text_height …). */
function setBarcodeTextHeight(n: SNode, h: number): void { const t = K.kid(n, "text_height"); if (t) t[1] = r6(h); else { const tx = K.kid(n, "text"); n.splice(tx ? n.indexOf(tx) + 1 : n.length, 0, ["text_height", r6(h)]); } }
function setHidden(n: SNode, hidden: boolean): void {
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (c === "hide" || (isList(c) && c[0] === "hide")) n.splice(i, 1); }
  const e = K.kid(n, "effects"); if (e) for (let i = e.length - 1; i > 0; i--) { const c = e[i]; if (c === "hide" || (isList(c) && c[0] === "hide")) e.splice(i, 1); }
  if (hidden) { const at = K.kid(n, "uuid") || K.kid(n, "effects"); n.splice(at ? n.indexOf(at) : n.length, 0, ["hide", "yes"]); }
}
/** PCB_TEXT::SetKeepUpright: the footprint text's (unlocked yes) is "not upright". */
function setKeepUpright(n: SNode, upright: boolean): void {
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (isList(c) && c[0] === "unlocked") n.splice(i, 1); }
  const at = K.kid(n, "at"); if (at) for (let i = at.length - 1; i > 3; i--) if (at[i] === "unlocked") at.splice(i, 1);
  if (!upright) { const l = K.kid(n, "layer"); n.splice(l ? n.indexOf(l) : n.length, 0, ["unlocked", "yes"]); }
}
function setLineWidth(n: SNode, w: number): void {
  if (n[0] === "dimension") { let st = K.kid(n, "style"); if (!st) { st = ["style"]; n.push(st); } const t = K.kid(st, "thickness"); if (t) t[1] = r6(w); else st.splice(1, 0, ["thickness", r6(w)]); return; }
  const stroke = K.kid(n, "stroke");
  if (stroke) { const ww = K.kid(stroke, "width"); if (ww) ww[1] = r6(w); else stroke.splice(1, 0, ["width", r6(w)]); return; }
  const ww = K.kid(n, "width"); if (ww) ww[1] = r6(w); else n.push(["stroke", ["width", r6(w)], ["type", "default"]]);
}
/** The text of a dimension is its (gr_text …) child. */
const dimText = (n: SNode) => K.kid(n, "gr_text") || K.kid(n, "fp_text");

/** processItem: the specified values, or StyleFromSettings( bds, false ). */
function processNode(n: SNode, job: TextGraphicsJob, inFootprint: boolean, fpCenterLocal: [number, number] | null): void {
  const v = job.values;
  const text = isText(n) ? n : null;
  const shape = SHAPES.has(String(n[0])) || n[0] === "gr_text_box" || n[0] === "fp_text_box" ? n : null;
  const dim = n[0] === "dimension" ? n : null;
  if (job.specified) {
    const t = text || (dim ? dimText(dim) : null);
    // a dimension's (gr_text …) is parsed into the dimension itself (parsePCB_TEXT( m_board, dim )), so its layer goes too
    if (v.layer) { setLayer(n, v.layer); if (dim && t) setLayer(t, v.layer); }
    if (t) {
      {
        if (v.textWidth !== null && v.textWidth !== undefined) setSize(t, v.textWidth, null);
        if (v.textHeight !== null && v.textHeight !== undefined) setSize(t, null, v.textHeight);
        if (v.autoThickness) setThickness(t, null);
        else if (v.thickness !== null && v.thickness !== undefined) setThickness(t, v.thickness);
        if (v.bold !== null && v.bold !== undefined) setFontFlag(font(t), "bold", v.bold);
        if (v.italic !== null && v.italic !== undefined) setFontFlag(font(t), "italic", v.italic);
        if (v.kicadFont) { const f = font(t); const face = K.kid(f, "face"); if (face) f.splice(f.indexOf(face), 1); }
        if (inFootprint) {
          if (v.keepUpright !== null && v.keepUpright !== undefined && storesUpright(t)) setKeepUpright(t, v.keepUpright);
          if (v.centerOnFootprint && fpCenterLocal) { const at = K.kid(t, "at"); if (at) { at[1] = r6(fpCenterLocal[0]); at[2] = r6(fpCenterLocal[1]); } }
        }
      }
    }
    if (n[0] === "barcode") {
      if (v.textHeight !== null && v.textHeight !== undefined) setBarcodeTextHeight(n, v.textHeight);
      else if (v.textWidth !== null && v.textWidth !== undefined) setBarcodeTextHeight(n, v.textWidth);
    }
    if (isField(n) && v.visible !== null && v.visible !== undefined) setHidden(n, !v.visible);
    if (v.lineWidth !== null && v.lineWidth !== undefined && (shape && !text || dim)) setLineWidth(n, v.lineWidth);
    if (v.lineWidth !== null && v.lineWidth !== undefined && (n[0] === "gr_text_box" || n[0] === "fp_text_box")) setLineWidth(n, v.lineWidth);
    return;
  }
  // StyleFromSettings( *m_brdSettings, false )
  const st = layerStyle(layerOfNode(n));
  if (n[0] === "barcode") { setBarcodeTextHeight(n, st.h); return; }     // PCB_BARCODE::StyleFromSettings
  if (shape) setLineWidth(n, st.line);
  const t = text || (dim ? dimText(dim) : null);
  if (t) {
    setSize(t, st.w, st.h); setThickness(t, st.thick); setFontFlag(font(t), "italic", st.italic);
    if (inFootprint && text && storesUpright(text)) setKeepUpright(t, st.upright);
  }
  if (dim) {
    setLineWidth(dim, st.line);
    const fmt = K.kid(dim, "format");
    if (fmt) {
      const put = (k: string, val: unknown) => { const c = K.kid(fmt, k); if (c) c[1] = val as SNode[number]; else fmt.push([k, val as SNode[number]]); };
      put("units", DIM_DEFAULTS.units); put("units_format", DIM_DEFAULTS.unitsFormat); put("precision", DIM_DEFAULTS.precision);
      for (let i = fmt.length - 1; i > 0; i--) { const c = fmt[i]; if (c === "suppress_zeroes" || (isList(c) && c[0] === "suppress_zeroes")) fmt.splice(i, 1); }
      if (DIM_DEFAULTS.suppressZeroes) fmt.push(["suppress_zeroes", "yes"]);
    }
    const style = K.kid(dim, "style");
    if (style) {
      const tp = K.kid(style, "text_position_mode"); if (tp) tp[1] = DIM_DEFAULTS.textPosition; else style.push(["text_position_mode", DIM_DEFAULTS.textPosition]);
      for (let i = style.length - 1; i > 0; i--) { const c = style[i]; if (c === "keep_text_aligned" || (isList(c) && c[0] === "keep_text_aligned")) style.splice(i, 1); }
      if (DIM_DEFAULTS.keepAligned) style.push(["keep_text_aligned", "yes"]);
    }
  }
}

/**
 * TransferDataFromWindow: the board items (footprints first, then the board's drawings) the scope and the filters
 * pick, each processed; returns the changed top-level items as [id, new node].
 */
export function editTextAndGraphics(doc: KDoc, job: TextGraphicsJob): [string, SNode][] {
  const out: [string, SNode][] = [];
  const sc = job.scope, f = job.filter, sel = job.selection || new Set<string>();
  const layerOk = (n: SNode) => !f.layer || layerOfNode(n) === f.layer;
  const memberOfSelectedGroup = (id: string) => { for (const it of doc.items.values()) if (it.kind === "group" && sel.has(it.id) && K.groupMemberIds(it.node).includes(id)) return true; return false; };
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const n = K.cloneNode(it.node); let changed = false;
    const ref = (() => { const p = K.kids(n, "property").find((x) => x[1] === "Reference") || K.kids(n, "fp_text").find((x) => x[1] === "reference"); return p ? K.str(p[2]) : ""; })();
    // the parent's "center" (BOARD_ITEM::GetCenter: its bounding box centre) in the footprint's own frame
    let center: [number, number] | null = null;
    if (it.bbox) { const [fx, fy, fa] = K.atOf(n); const c = [(it.bbox[0] + it.bbox[2]) / 2 - fx, (it.bbox[1] + it.bbox[3]) / 2 - fy]; const r = rotator(-fa)(c[0], c[1]); center = [r[0], r[1]]; }
    const visit = (c: SNode) => {
      if (job.filter.selectedOnly && !sel.has(it.id) && !memberOfSelectedGroup(it.id)) return;
      if (!layerOk(c)) return;
      if (f.reference && !wildCompare(f.reference, ref)) return;
      if (f.footprint && !wildCompare(f.footprint, K.str(n[1]))) return;
      const before = K.serialize(c); processNode(c, job, true, center); if (K.serialize(c) !== before) changed = true;
    };
    for (const c of n) {
      if (!isList(c)) continue;
      const node = c as SNode;
      if (isField(node)) {
        const name = fieldName(node);
        if (name === "Reference") { if (sc.references) visit(node); continue; }
        if (name === "Value") { if (sc.values) visit(node); continue; }
        if (/^ki_/.test(name)) continue;
        if (sc.otherFootprintFields) visit(node);
        else if (sc.references && textOf(node) === "${REFERENCE}") visit(node);
        else if (sc.values && textOf(node) === "${VALUE}") visit(node);
      } else if (node[0] === "fp_text" || node[0] === "fp_text_box") {
        if (sc.footprintTexts) visit(node);
        else if (sc.references && textOf(node) === "${REFERENCE}") visit(node);
        else if (sc.values && textOf(node) === "${VALUE}") visit(node);
      } else if (node[0] === "table") { if (sc.footprintTexts) for (const cell of K.kids(K.kid(node, "cells") || node, "table_cell")) visit(cell); }
      else if (node[0] === "dimension") { if (sc.footprintDimensions) visit(node); }
      else if (GRAPHICS.has(String(node[0]))) { if (sc.footprintGraphics) visit(node); }
    }
    if (changed) out.push([it.id, n]);
  }
  for (const it of doc.items.values()) {
    const k = it.kind; const n = K.cloneNode(it.node);
    const visit = (c: SNode): boolean => {
      if (job.filter.selectedOnly && !sel.has(it.id) && !memberOfSelectedGroup(it.id)) return false;
      if (!layerOk(c)) return false;
      const before = K.serialize(c); processNode(c, job, false, null); return K.serialize(c) !== before;
    };
    let changed = false;
    if (k === "gr_text" || k === "gr_text_box") { if (sc.boardText) changed = visit(n); }
    else if (k === "table") { if (sc.boardText) for (const cell of K.kids(K.kid(n, "cells") || n, "table_cell")) changed = visit(cell) || changed; }
    else if (k === "dimension") { if (sc.boardDimensions) changed = visit(n); }
    else if (GRAPHICS.has(k)) { if (sc.boardGraphics) changed = visit(n); }
    if (changed) out.push([it.id, n]);
  }
  return out;
}

export const textGraphicsApi = { editTextAndGraphics, fontFlag };
