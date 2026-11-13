// pcbdialogs/textbox — Text Box Properties (DIALOG_TEXTBOX_PROPERTIES) for a board text box.
// The layout follows dialog_textbox_properties_base: the multi-line text, then Locked, Layer / Orientation, the
// font row (KiCad Font, bold, italic, horizontal and vertical alignment, mirrored), the text size and thickness
// (with the auto-thickness link) beside Border, its width and its style.  OK (TransferDataFromWindow) validates
// the text size against TEXT_MIN_SIZE_MM / TEXT_MAX_SIZE_MM, clamps a too-thick pen with KiCad's message, turns the
// box per PCB_TEXTBOX::SetTextAngle (the box slides about its start, the angle is the text's), and grows the box to
// GetMinSize when the text no longer fits.  An edited text box is one "Edit Text Box Properties" change; the text
// box tool (DRAWING_TOOL::DrawRectangle) opens it on the box just drawn and commits "Draw Text Box" on OK.
import { faceOfFont, fontField, setFaceOfFont } from "../../dialogs/font-picker";
import { checkField, errorMessage, fmtLenU, form, h, lenField, numField, openDialog, selectField, unitLabel, type Field } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const f6 = (v: number): string => String(+(+v).toFixed(6));
const NM = 1e6;
const TEXT_MIN_SIZE_MM = 0.001, TEXT_MAX_SIZE_MM = 250.0;
const TEXT_INTERLINE = 1.68 * 0.9583;   // the stroke font's interline pitch (canvas/text.ts)

interface LockApi { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode }
const PT = (): LockApi => (window as unknown as { PcbTools: LockApi }).PcbTools;
interface StrokeApi { linebreakText(text: string, colWidth: number, sizeX: number, thickness: number, italic?: boolean): string }

function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
function put(node: SNode, key: string, text: string | null, before: string[] = []): void {
  const i = idxOf(node, key);
  if (text === null) { if (i > 0) node.splice(i, 1); return; }
  const n = K().parse(text) as SNode;
  if (i > 0) { node[i] = n; return; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, n);
}
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");
const flag = (font: SNode | null, f: string): boolean => !!font && (yes(kid(font, f)) || font.includes(f));
const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };
const layerOptions = (doc: KDoc, cur: string): [string, string][] => {
  const all = Array.from(doc.layers.keys()).map((n): [string, string] => [n, layerLabel(doc, n)]);
  return cur && !all.some((o) => o[0] === cur) ? [[cur, cur], ...all] : all;
};

/** lineTypeNames, in the combo's order. */
export const BORDER_STYLES: [string, string][] = [["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];

/** The dialog's state (mm, degrees). */
export interface TextBoxValues {
  text: string; locked: boolean; layer: string; angle: number; textW: number; textH: number; autoThickness: boolean; textThick: number;
  bold: boolean; italic: boolean; hJustify: string; vJustify: string; mirrored: boolean; border: boolean; borderWidth: number; borderStyle: string;
  /** the outline font, "" for KiCad Font */
  face: string;
}

/** TransferDataToWindow. */
export function textBoxValues(node: SNode): TextBoxValues {
  const ef = kid(node, "effects"), font = kid(ef, "font"), size = kid(font, "size"), th = kid(font, "thickness"), j = kid(ef, "justify");
  const js = j ? j.slice(1).map(String) : [];
  const auto = !th || !(Number(th[1]) > 0);
  const textW = nval(size, 2, 1), stroke = kid(node, "stroke"), border = yes(kid(node, "border"));
  let a = nval(kid(node, "angle")) % 360; if (a > 180) a -= 360; if (a <= -180) a += 360;   // Normalize180
  const style = sval(kid(stroke, "type")) || "default";
  return {
    text: sval(node), locked: PT().isLocked(node), layer: sval(kid(node, "layer")), angle: a,
    textW, textH: nval(size, 1, 1), autoThickness: auto, textThick: auto ? Math.round(textW * NM / 8) / NM : nval(th),   // GetPenSizeForNormal
    bold: flag(font, "bold"), italic: flag(font, "italic"), face: faceOfFont(font),
    hJustify: js.includes("left") ? "left" : js.includes("right") ? "right" : "center", vJustify: js.includes("top") ? "top" : js.includes("bottom") ? "bottom" : "center",
    mirrored: js.includes("mirror"), border, borderWidth: border ? nval(kid(stroke, "width")) : NaN, borderStyle: style === "default" ? "solid" : style,
  };
}

const corners = (n: SNode): [number, number, number, number] | null => { const s = kid(n, "start"), e = kid(n, "end"); return s && e ? [nval(s), nval(s, 2), nval(e), nval(e, 2)] : null; };

/**
 * PCB_TEXTBOX::GetMinSize: the wrapped text's height plus the margins across the text direction.  The text box
 * height is EDA_TEXT::GetTextBox's for the stroke font: the cap height inflated by 1.5 pens a side, the 0.17 fudge,
 * and one interline per extra line.  Only the height is held (the width re-wraps).
 */
export function textBoxMinSize(node: SNode, v: TextBoxValues): [number, number] {
  if (!v.text) return [0, 0];
  const c = corners(node); if (!c) return [0, 0];
  const m = kid(node, "margins"), ml = nval(m, 1), mt = nval(m, 2), mr = nval(m, 3), mb = nval(m, 4);
  const horiz = ((v.angle % 180) + 180) % 180 === 0;
  const pen = v.autoThickness ? Math.round(v.textW * NM / 8) / NM : v.textThick;
  const colWidth = (horiz ? Math.abs(c[2] - c[0]) - (ml + mr) : Math.abs(c[3] - c[1]) - (mt + mb));
  const S = (globalThis as unknown as { KiCadCanvas: StrokeApi }).KiCadCanvas;
  const shown = S && S.linebreakText ? S.linebreakText(v.text, colWidth, v.textW, pen, v.italic) : v.text;
  const lines = shown.split("\n").length;
  const extY = v.textH + 2 * Math.round(pen * 1.5 * NM) / NM;
  let hgt = extY + Math.round(extY * 0.17 * NM) / NM + (lines - 1) * Math.round(v.textH * TEXT_INTERLINE * NM) / NM;
  hgt += horiz ? mt + mb : ml + mr;
  const rot = ((v.angle % 360) + 360) % 360;
  return rot === 90 || rot === 270 ? [hgt, 0] : [0, hgt];
}

/** TransferDataFromWindow on a copy of the node.  Returns the node, and the clamp message when the pen was too thick. */
export function applyTextBox(orig: SNode, v: TextBoxValues, v0: TextBoxValues): { node: SNode; clamped: boolean } {
  const node = (K().cloneNode as (n: SNode) => SNode)(orig);
  node[1] = v.text.replace(/\r/g, "");   // the writer escapes new lines as "\\n" (EscapeString( CTX_QUOTED_STR ))
  if (v.locked !== PT().isLocked(node)) PT().setLocked(node, v.locked);
  put(node, "layer", `(layer ${quote(v.layer)})`, ["uuid", "effects"]);
  let ef = kid(node, "effects"); if (!ef) { put(node, "effects", "(effects (font (size 1 1)))", ["border", "stroke", "knockout"]); ef = kid(node, "effects") as SNode; }
  let font = kid(ef, "font"); if (!font) { ef.splice(1, 0, K().parse("(font)") as SNode); font = kid(ef, "font") as SNode; }
  if (v.face !== v0.face) setFaceOfFont(font, v.face);
  put(font, "size", `(size ${f6(v.textH)} ${f6(v.textW)})`, ["line_spacing", "thickness", "bold", "italic", "color"]);
  let clamped = false, thick = v.textThick;
  if (!v.autoThickness) {
    const maxPen = Math.round(Math.min(Math.abs(v.textW), Math.abs(v.textH)) * NM * 0.25) / NM;   // ClampTextPenSize
    if (thick > maxPen) { thick = maxPen; clamped = true; }
  }
  put(font, "thickness", v.autoThickness ? null : `(thickness ${f6(thick)})`, ["bold", "italic", "color"]);
  for (const f of ["bold", "italic"] as const) {
    if (v[f] === v0[f]) continue;
    const bare = font.indexOf(f); if (bare > 0) font.splice(bare, 1);
    put(font, f, v[f] ? `(${f} yes)` : null, f === "bold" ? ["italic", "color"] : ["color"]);
  }
  const jj = [...(v.hJustify !== "center" ? [v.hJustify] : []), ...(v.vJustify !== "center" ? [v.vJustify] : []), ...(v.mirrored ? ["mirror"] : [])];
  put(ef, "justify", jj.length ? `(justify ${jj.join(" ")})` : null, ["hide", "href"]);
  put(node, "border", `(border ${v.border ? "yes" : "no"})`, ["stroke", "knockout"]);
  const w = isFinite(v.borderWidth) ? v.borderWidth : 0;
  put(node, "stroke", `(stroke (width ${f6(w)}) (type ${v.borderStyle}))`, ["knockout"]);
  // SetTextAngle( Normalize() ): PCB_TEXTBOX::Rotate about the start by the change, the box sliding with its centre
  const a1 = ((v.angle % 360) + 360) % 360, a0 = ((nval(kid(node, "angle")) % 360) + 360) % 360, d = a1 - a0;
  const c = corners(node);
  if (d && c) {
    const r = -d * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const sx = c[0] * NM, sy = c[1] * NM, ox = (c[0] + c[2]) * NM / 2, oy = (c[1] + c[3]) * NM / 2;
    const nx = sx + (ox - sx) * cs - (oy - sy) * sn, ny = sy + (ox - sx) * sn + (oy - sy) * cs;   // RotatePoint: y down, positive is counter-clockwise on screen
    const dx = Math.round(nx - ox) / NM, dy = Math.round(ny - oy) / NM;
    (kid(node, "start") as SNode).splice(1, 2, +f6(c[0] + dx), +f6(c[1] + dy)); (kid(node, "end") as SNode).splice(1, 2, +f6(c[2] + dx), +f6(c[3] + dy));
  }
  put(node, "angle", a1 ? `(angle ${f6(a1)})` : null, ["layer"]);
  // the box grows to hold the text (GetMinSize)
  const min = textBoxMinSize(node, v), cc = corners(node);
  if (cc) {
    let [x0, y0, x1, y1] = cc, grew = false;
    if (min[0] > 0 && Math.abs(x1 - x0) < min[0]) { x1 = x1 >= x0 ? x0 + min[0] : x0 - min[0]; grew = true; }
    if (min[1] > 0 && Math.abs(y1 - y0) < min[1]) { y1 = y1 >= y0 ? y0 + min[1] : y0 - min[1]; grew = true; }
    if (grew) (kid(node, "end") as SNode).splice(1, 2, +f6(x1), +f6(y1));
  }
  return { node, clamped };
}

/** DisplayError, over the dialog. */
const errorBox = (message: string, then?: () => void): void => errorMessage(message, then);

/** DIALOG_TEXTBOX_PROPERTIES.  `create`: the dialog of a text box being drawn (OK hands the node over, Cancel null). */
export function textBoxDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, ro = !!ctx.viewOnly, v0 = textBoxValues(node0);
  const inFootprint = node0[0] === "fp_text_box";
  const fields: Record<string, Field<string | number | boolean>> = {};
  const reg = <T extends string | number | boolean>(k: string, f: Field<T>): Field<T> => { fields[k] = f as unknown as Field<string | number | boolean>; return f; };
  let text: HTMLTextAreaElement | null = null;
  const current = (): TextBoxValues => {
    const g = (k: string): unknown => fields[k].get();
    const pick = (keys: string[], d: string): string => keys.find((a) => (fields["align-" + a] as Field<boolean>).get()) || d;
    return { text: text ? text.value : v0.text, locked: !!g("locked"), layer: String(g("layer")), angle: Number(g("angle")), textW: Number(g("textW")), textH: Number(g("textH")),
      autoThickness: !!g("autoThickness"), textThick: Number(g("textThick")), bold: !!g("bold"), italic: !!g("italic"), face: String(g("face")),
      hJustify: pick(["left", "center", "right"], v0.hJustify), vJustify: pick(["top", "center", "bottom"], v0.vJustify), mirrored: !!g("mirrored"),
      border: !!g("border"), borderWidth: Number(g("borderWidth")), borderStyle: String(g("borderStyle")) };
  };
  return !!openDialog({ title: "Text Box Properties", width: 640, readOnly: ro, noEnter: true,
    build(body) {
      text = h("textarea", { class: "pd-text", style: "min-height:110px;width:100%;box-sizing:border-box", readOnly: ro, "data-k": "text", spellcheck: false });
      text.value = v0.text;
      text.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); const ok = (body.parentElement as HTMLElement).querySelector<HTMLButtonElement>(".kd-foot > button:last-child"); if (ok) ok.click(); } });   // SCINTILLA_TRICKS: Shift+Enter accepts, Enter is a new line
      setTimeout(() => { if (text) { text.focus(); text.select(); } }, 0);
      const locked = reg("locked", checkField(v0.locked, "Locked", { ro, key: "locked" }));
      if (inFootprint) locked.el.style.display = "none";
      const layer = reg("layer", selectField<string>(v0.layer, layerOptions(doc, v0.layer), { ro, key: "layer" }));
      const angle = reg("angle", numField(v0.angle, { ro, key: "angle", digits: 3 })); angle.input.title = "Text orientation";
      const presets = h("datalist", { id: "kd-tb-rot" }); for (const r of ["0.0", "90.0", "-90.0", "180.0"]) presets.append(h("option", { value: r })); angle.input.setAttribute("list", "kd-tb-rot");
      const bold = reg("bold", checkField(v0.bold, "Bold", { ro, key: "bold" })), italic = reg("italic", checkField(v0.italic, "Italic", { ro, key: "italic" }));
      const radio = (group: string[], cur: string, labels: Record<string, string>): Field<boolean>[] => group.map((a) => reg("align-" + a, checkField(cur === a, labels[a], { ro, key: "align-" + a,
        onChange: (on) => { if (on) for (const b of group) { if (b !== a) fields["align-" + b].set(false); } } })));   // onHalignButton / onValignButton: one at most
      const hal = radio(["left", "center", "right"], v0.hJustify, { left: "Align left", center: "Align center", right: "Align right" });
      const val = radio(["top", "center", "bottom"], v0.vJustify, { top: "Align top", center: "Align middle", bottom: "Align bottom" });
      const mirrored = reg("mirrored", checkField(v0.mirrored, "Mirrored", { ro, key: "mirrored" }));
      const tw = reg("textW", lenField(v0.textW, { ro, key: "textW" })), tht = reg("textH", lenField(v0.textH, { ro, key: "textH" }));
      const thick = reg("textThick", lenField(v0.textThick, { ro: ro || v0.autoThickness, key: "textThick" }));
      const auto = reg("autoThickness", checkField(v0.autoThickness, "Auto", { ro, key: "autoThickness", tip: "Adjust the text thickness",
        onChange: (on) => { thick.input.disabled = ro || on; if (on) thick.set(Math.round(tw.get() * NM / 8) / NM); } }));
      const onTextSize = (): void => { if (auto.get()) thick.set(Math.round(tw.get() * NM / 8) / NM); };
      tw.input.addEventListener("input", onTextSize); tw.input.addEventListener("change", onTextSize);
      const bw = reg("borderWidth", lenField(v0.borderWidth, { ro: ro || !v0.border, key: "borderWidth", allowEmpty: true }));
      const bs = reg("borderStyle", selectField<string>(v0.borderStyle, BORDER_STYLES, { ro: ro || !v0.border, key: "borderStyle" }));
      const border = reg("border", checkField(v0.border, "Border", { ro, key: "border",
        onChange: (on) => {   // onBorderChecked: a border with no width takes the layer class's line thickness
          if (on && !(bw.get() > 0)) { const PTx = window as unknown as { PcbTools?: { gfxWidth?(l: string): number } }; const lw = PTx.PcbTools && PTx.PcbTools.gfxWidth ? PTx.PcbTools.gfxWidth(layer.get()) : 0.1; bw.set(lw); }
          bw.input.disabled = bs.input.disabled = ro || !on;
        } }));
      const tools = h("span", { class: "pd-inline", style: "flex-wrap:wrap;gap:4px 10px" }, bold.el, italic.el, ...hal.map((f) => f.el), ...val.map((f) => f.el), mirrored.el);
      body.append(presets, h("label", { class: "pd-lbl" }, "Text:"), text,
        h("div", { class: "pd-row", style: "margin:8px 0" }, locked.el),
        h("div", { class: "pd-cols2" },
          form([["Layer:", layer.el], ["Font:", reg("face", fontField(doc, v0.face, { ro, key: "face" })).el]], true),
          form([["Orientation:", angle.el, null, "Text orientation"]], true)),
        h("div", { style: "margin:6px 0 8px" }, tools),
        h("div", { class: "pd-cols2" },
          form([["Text width:", tw.el, unitLabel(), "Text width"], ["Text height:", tht.el, unitLabel(), "Text height"],
            ["Thickness:", thick.el, h("span", { class: "pd-inline", style: "gap:6px" }, unitLabel(), auto.el), "Text thickness"]], true),
          form([border.el, ["Border width:", bw.el, unitLabel()], ["Border style:", bs.el]], true)));
    },
    cancel: create ? () => create(null) : undefined,
    ok() {
      if (ro) return true;
      const v = current();
      // UNIT_BINDER::Validate( TEXT_MIN_SIZE_MM, TEXT_MAX_SIZE_MM )
      for (const [val, label] of [[v.textW, "Text width"], [v.textH, "Text height"]] as [number, string][]) {
        if (val < TEXT_MIN_SIZE_MM) { errorBox(`${label} must be at least ${fmtLenU(TEXT_MIN_SIZE_MM)}.`); return false; }
        if (val > TEXT_MAX_SIZE_MM) { errorBox(`${label} must be less than ${fmtLenU(TEXT_MAX_SIZE_MM)}.`); return false; }
      }
      const unchanged = JSON.stringify(v) === JSON.stringify(v0);
      if (!create && unchanged) return true;                          // nothing changed: the item stays as it is
      const { node, clamped } = applyTextBox(node0, v, v0);
      const finish = (): void => {
        if (create) { create(node); return; }
        if (K().serialize(node) === K().serialize(node0)) return;
        ctx.commit([K().replaceChange(doc, { ...item, node, geom: [], bbox: null })], "Edit Text Box Properties");
      };
      if (clamped) errorBox("The text thickness is too large for the text size.\nIt will be clamped.", finish); else finish();
      return true;
    } });
}

/** The text box tool: the dialog on the box just drawn; done gets the node, or null on Cancel. */
export function newTextBoxDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = textBoxDialog(ctx, { id: "", kind: "gr_text_box", node, geom: [], bbox: null } as unknown as KItem, done);
  if (!ok) done(null);
  return ok;
}
