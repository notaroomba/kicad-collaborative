// pcbdialogs/dimension — Dimension Properties (DIALOG_DIMENSION_PROPERTIES) for the five board dimensions.
// The layout follows dialog_dimension_properties_base: Leader Format (leaders), Dimension Format (the measuring
// dimensions; a centre mark keeps only its layer), Dimension Text and Dimension Line.  OK writes the format, style
// and text options into a copy of the node, then PCB_DIM_*::Update (pcb-tools' dimRead / dimUpdate / dimWrite)
// re-derives the value text and its place, and the copy goes in as one "Edit Dimension Properties" change.
// Driving value mode needs a length constraint bound to both ends (DimensionCanDrive), which the web editor has no
// way to make, so the Value choice offers Driven and Arbitrary as KiCad does for an unbound dimension.
import { faceOfFont, fontField, setFaceOfFont } from "../../dialogs/font-picker";
import { box, checkField, form, h, coordField, lenField, numField, openDialog, selectField, textField, unitLabel, type Field } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const f6 = (v: number): string => String(+(+v).toFixed(6));
const NM = 1e6;

/** PCB_DIM_* as pcb-tools reads it (lengths in nm). */
interface DimModel {
  type: string; start: number[]; end: number[]; prefix: string; suffix: string; unitsMode: number; unitsFormat: number; precision: number;
  override: string | null; suppressZeroes: boolean; thickness: number; arrowLength: number; posMode: number; arrowInward: boolean;
  extHeight: number; extOffset: number; keepAligned: boolean; textFrame: number; text: string; textPos: number[]; textAngle: number;
  textH: number; textW: number; textThick: number; bold: boolean; hJustify: string; measured?: number;
}
interface DimTools {
  dimRead(n: SNode): DimModel; dimUpdate(m: DimModel): DimModel; dimWrite(n: SNode, m: DimModel): SNode; dimBaseText(m: DimModel, nm: number): string;
  isLocked(n: SNode): boolean;
}
const PT = (): DimTools => (window as unknown as { PcbTools: DimTools }).PcbTools;

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
const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };
const layerOptions = (doc: KDoc, cur: string): [string, string][] => {
  const all = Array.from(doc.layers.keys()).map((n): [string, string] => [n, layerLabel(doc, n)]);
  return cur && !all.some((o) => o[0] === cur) ? [[cur, cur], ...all] : all;
};
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");

/** The dialog's state: everything updateDimensionFromDialog() sets. */
export interface DimDialogValues {
  arbitrary: boolean; value: string; prefix: string; suffix: string; layer: string; arrowInward: boolean; unitsMode: number; unitsFormat: number; precision: number;
  suppressZeroes: boolean; posMode: number; textX: number; textY: number; keepAligned: boolean; angle: number; textW: number; textH: number; autoThickness: boolean;
  /** the outline font, "" for KiCad Font */
  face: string;
  textThick: number; bold: boolean; italic: boolean; hJustify: string; mirrored: boolean; lineThickness: number; arrowLength: number; extOffset: number; extHeight: number; textFrame: number;
}
/** TransferDataToWindow: the item's values (mm, degrees). */
export function dimDialogValues(node: SNode): DimDialogValues {
  const m = PT().dimRead(node), gt = kid(node, "gr_text"), ef = kid(gt, "effects"), font = kid(ef, "font"), j = kid(ef, "justify"), th = kid(font, "thickness");
  const auto = !th || !(Number(th[1]) > 0);
  let a = m.textAngle % 360; if (a > 180) a -= 360; if (a <= -180) a += 360;   // Normalize180
  return {
    arbitrary: m.override !== null, value: m.override !== null ? m.override : PT().dimBaseText({ ...m, prefix: "", suffix: "", unitsFormat: 0 }, PT().dimUpdate({ ...m }).measured || 0),
    prefix: m.prefix, suffix: m.suffix, layer: sval(kid(node, "layer")), arrowInward: m.arrowInward, unitsMode: m.unitsMode, unitsFormat: m.unitsFormat, precision: m.precision,
    suppressZeroes: m.suppressZeroes, posMode: m.posMode, textX: m.textPos[0] / NM, textY: m.textPos[1] / NM, keepAligned: m.keepAligned, angle: a,
    textW: m.textW / NM, textH: m.textH / NM, autoThickness: auto, textThick: auto ? Math.round(m.textW / 8) / NM : m.textThick / NM,
    face: faceOfFont(font), bold: m.bold, italic: yes(kid(font, "italic")) || (!!font && font.includes("italic")), hJustify: m.hJustify, mirrored: !!j && j.includes("mirror"),
    lineThickness: m.thickness, arrowLength: m.arrowLength / NM, extOffset: m.extOffset / NM, extHeight: m.extHeight / NM, textFrame: m.textFrame,
  };
}
const hasValueModeChoice = (type: string): boolean => type === "aligned" || type === "orthogonal" || type === "radial";
/** updateDimensionFromDialog + Update(): the node with the dialog's values applied. */
export function applyDimDialog(orig: SNode, v: DimDialogValues): SNode {
  const T = PT(), node = (K().cloneNode as (n: SNode) => SNode)(orig), type = sval(kid(node, "type")) || "aligned";
  const center = type === "center", leader = type === "leader", aligned = type === "aligned" || type === "orthogonal";
  put(node, "layer", `(layer ${quote(v.layer)})`, ["uuid"]);
  if (!center) {
    let override: string | null;
    if (hasValueModeChoice(type)) override = v.arbitrary ? v.value : null;
    else { const o = kid(kid(node, "format"), "override_value"); override = o ? v.value : null; }   // a leader keeps its override state
    put(node, "format", `(format (prefix ${quote(v.prefix)}) (suffix ${quote(v.suffix)}) (units ${v.unitsMode}) (units_format ${v.unitsFormat}) (precision ${v.precision})`
      + (override !== null ? ` (override_value ${quote(override)})` : "") + (v.suppressZeroes ? " (suppress_zeroes yes)" : "") + ")", ["style", "gr_text"]);
  }
  put(node, "style", `(style (thickness ${f6(v.lineThickness)}) (arrow_length ${f6(v.arrowLength)}) (text_position_mode ${v.posMode})`
    + (aligned ? ` (arrow_direction ${v.arrowInward ? "inward" : "outward"})` : "") + (aligned ? ` (extension_height ${f6(v.extHeight)})` : "")
    + (leader ? ` (text_frame ${v.textFrame})` : "") + ` (extension_offset ${f6(v.extOffset)})` + (v.keepAligned ? " (keep_text_aligned yes)" : "") + ")", ["gr_text"]);
  const gt = kid(node, "gr_text");
  if (gt) {
    put(gt, "layer", `(layer ${quote(v.layer)})`, ["uuid", "effects"]);
    const at = kid(gt, "at") as SNode, ang = ((v.angle % 360) + 360) % 360;   // SetTextAngle( Normalize() )
    if (at) { if (v.posMode === 2) { at[1] = +f6(v.textX); at[2] = +f6(v.textY); } if (at.length > 3) at[3] = +f6(ang); else at.push(+f6(ang)); }
    let ef = kid(gt, "effects"); if (!ef) { put(gt, "effects", "(effects (font (size 1 1)))"); ef = kid(gt, "effects") as SNode; }
    let font = kid(ef, "font"); if (!font) { ef.splice(1, 0, K().parse("(font)") as SNode); font = kid(ef, "font") as SNode; }
    if (v.face !== faceOfFont(font)) setFaceOfFont(font, v.face);
    put(font, "size", `(size ${f6(v.textH)} ${f6(v.textW)})`, ["line_spacing", "thickness", "bold", "italic", "color"]);
    put(font, "thickness", v.autoThickness ? null : `(thickness ${f6(v.textThick)})`, ["bold", "italic", "color"]);
    for (const flag of ["bold", "italic"] as const) {
      const bare = font.indexOf(flag); if (bare > 0) font.splice(bare, 1);
      put(font, flag, v[flag] ? `(${flag} yes)` : null, flag === "bold" ? ["italic", "color"] : ["color"]);
    }
    const old = kid(ef, "justify"), keep = old ? old.slice(1).map(String).filter((t) => t === "top" || t === "bottom") : [];
    const jj = [...(v.hJustify !== "center" ? [v.hJustify] : []), ...keep, ...(v.mirrored ? ["mirror"] : [])];
    put(ef, "justify", jj.length ? `(justify ${jj.join(" ")})` : null, ["hide", "href"]);
  }
  const m = T.dimRead(node);
  if (!v.keepAligned) m.textAngle = ((v.angle % 360) + 360) % 360;
  T.dimUpdate(m);
  return T.dimWrite(node, m);
}

/** DIALOG_DIMENSION_PROPERTIES on a dimension: false when it cannot open. */
export function dimensionDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, type = sval(kid(node0, "type")) || "aligned", ro = !!ctx.viewOnly;
  const center = type === "center", leader = type === "leader", aligned = type === "aligned" || type === "orthogonal";
  const v0 = dimDialogValues(node0);
  const fields: { [k: string]: Field<string | number | boolean> } = {};
  const reg = <T extends string | number | boolean>(k: string, f: Field<T>): Field<T> => { fields[k] = f as unknown as Field<string | number | boolean>; return f; };
  let preview: HTMLElement | null = null;
  const current = (): DimDialogValues => {
    const g = (k: string): unknown => (fields[k] ? fields[k].get() : (v0 as unknown as Record<string, unknown>)[k]);
    const halign = (["left", "center", "right"] as const).find((a) => (fields["align-" + a] as Field<boolean> | undefined)?.get()) || v0.hJustify;
    return { ...v0, arbitrary: g("valueMode") === "arbitrary", value: String(g("value")), prefix: String(g("prefix")), suffix: String(g("suffix")), layer: String(g("layer")),
      arrowInward: g("arrowDirection") === "inward", unitsMode: Number(g("unitsMode")), unitsFormat: Number(g("unitsFormat")), precision: Number(g("precision")),
      suppressZeroes: !!g("suppressZeroes"), posMode: Number(g("posMode")), textX: Number(g("textX")), textY: Number(g("textY")), keepAligned: !!g("keepAligned"),
      angle: Number(g("angle")), textW: Number(g("textW")), textH: Number(g("textH")), autoThickness: !!g("autoThickness"), textThick: Number(g("textThick")),
      face: String(g("face")), bold: !!g("bold"), italic: !!g("italic"), hJustify: halign, mirrored: !!g("mirrored"), lineThickness: Number(g("lineThickness")), arrowLength: Number(g("arrowLength")),
      extOffset: Number(g("extOffset")), extHeight: Number(g("extHeight")), textFrame: Number(g("textFrame")) };
  };
  const measuredText = (v: DimDialogValues): string => { const m = PT().dimRead(applyDimDialog(node0, { ...v, arbitrary: false })); const u = PT().dimUpdate(m); return PT().dimBaseText({ ...u, prefix: "", suffix: "", unitsFormat: 0, override: null }, u.measured || 0); };
  // updatePreviewText; a Driven value field follows the measurement in the chosen units and precision
  const refresh = (): void => {
    const v = current();
    if (fields.value && fields.valueMode && fields.valueMode.get() === "driven") (fields.value as Field<string>).set(measuredText(v));
    if (preview) { const n = applyDimDialog(node0, current()); preview.textContent = sval(kid(n, "gr_text")); }
  };
  const live = (f: Field<string | number | boolean>): void => { f.input.addEventListener("input", refresh); f.input.addEventListener("change", refresh); };
  const layerSel = reg("layer", selectField<string>(v0.layer, layerOptions(doc, v0.layer), { ro, key: "layer" }));
  return !!openDialog({ title: "Dimension Properties", width: 760, readOnly: ro,
    build(body) {
      if (leader) {
        const value = reg("value", textField(v0.value, { ro, key: "value" }));
        const frame = reg("textFrame", selectField<number>(v0.textFrame, [[0, "None"], [1, "Rectangle"], [2, "Circle"]], { ro, key: "textFrame" }));
        frame.input.title = "Draw a shape around the leader text";
        body.append(box("Leader Format", h("div", { class: "pd-cols2" }, form([["Text:", value.el], ["Layer:", layerSel.el]], true), form([["Text frame:", frame.el, null, "Draw a shape around the leader text"]], true))));
      } else if (center) {
        body.append(box("Dimension Format", form([["Layer:", layerSel.el]], true)));
      } else {
        const value = reg("value", textField(v0.value, { ro: ro || !v0.arbitrary, key: "value" })); value.input.title = "Measured value of this dimension";
        const mode = reg("valueMode", selectField<string>(v0.arbitrary ? "arbitrary" : "driven", [["driven", "Driven"], ["arbitrary", "Arbitrary"]], { ro, key: "valueMode",
          onChange: (x) => { value.input.disabled = ro || x === "driven"; refresh(); } }));
        mode.input.title = "Driven follows the measured geometry; Driving forces the geometry to the entered length; Arbitrary shows custom text";
        const unitsTip = "Units of this dimension (\"automatic\" to follow the units selected in the editor)";
        const units = reg("unitsMode", selectField<number>(v0.unitsMode, [[0, "Inches"], [1, "Mils"], [2, "Millimeters"], [3, "Automatic"]], { ro, key: "units" }));
        const prefix = reg("prefix", textField(v0.prefix, { ro, key: "prefix" })), suffix = reg("suffix", textField(v0.suffix, { ro, key: "suffix" }));
        const ufmt = reg("unitsFormat", selectField<number>(v0.unitsFormat, [[0, "1234"], [1, "1234 mm"], [2, "1234 (mm)"]], { ro, key: "unitsFormat" }));
        const prec = reg("precision", selectField<number>(v0.precision, [[0, "0"], [1, "0.0"], [2, "0.00"], [3, "0.000"], [4, "0.0000"], [5, "0.00000"],
          [6, "0.00 in / 0 mils / 0.0 mm"], [7, "0.000 / 0 / 0.00"], [8, "0.0000 / 0.0 / 0.000"], [9, "0.00000 / 0.00 / 0.0000"]], { ro, key: "precision" }));
        const zeroes = reg("suppressZeroes", checkField(v0.suppressZeroes, "Suppress trailing zeroes", { ro, key: "suppressZeroes", tip: "When checked, \"0.100\" will be shown as \"0.1\" even if the precision setting is higher" }));
        for (const f of [value, prefix, suffix, units, ufmt, prec, zeroes] as Field<string | number | boolean>[]) live(f);
        preview = h("span", { "data-k": "preview" }, "");
        body.append(box("Dimension Format", h("div", { class: "pd-cols2" },
          form([["Value:", h("span", { class: "pd-inline", style: "gap:6px" }, value.el, mode.el), null, "Measured value of this dimension"], ["Prefix:", prefix.el, null, "Text to print before the dimension value"],
            ["Suffix:", suffix.el, null, "Text to print after the dimension value"], ["Layer:", layerSel.el], ["Preview:", preview]], true),
          form([["Units:", units.el, null, unitsTip], ["Units format:", ufmt.el, null, "Choose how to display the units"], ["Precision:", prec.el, null, "Choose how many digits of precision to display"], zeroes.el], true))));
      }
      if (!center) {
        const bold = reg("bold", checkField(v0.bold, "Bold", { ro, key: "bold" })), italic = reg("italic", checkField(v0.italic, "Italic", { ro, key: "italic" }));
        const mirrored = reg("mirrored", checkField(v0.mirrored, "Mirrored", { ro, key: "mirrored" }));
        const aligns = (["left", "center", "right"] as const).map((a) => { const f = reg("align-" + a, checkField(v0.hJustify === a, a === "left" ? "Left" : a === "center" ? "Center" : "Right", { ro, key: "align-" + a,
          onChange: (on) => { if (on) for (const b of ["left", "center", "right"]) if (b !== a) fields["align-" + b].set(false); else fields["align-" + a].set(true); } })); f.input.title = "Align " + a; return f; });
        const tw = reg("textW", lenField(v0.textW, { ro, key: "textW" })), tht = reg("textH", lenField(v0.textH, { ro, key: "textH" }));
        const thick = reg("textThick", lenField(v0.textThick, { ro: ro || v0.autoThickness, key: "textThick" }));
        const auto = reg("autoThickness", checkField(v0.autoThickness, "Auto", { ro, key: "autoThickness", tip: "Adjust the text thickness",
          onChange: (on) => { thick.input.disabled = ro || on; if (on) thick.set(Math.round(tw.get() * NM / 8) / NM); } }));
        tw.input.addEventListener("input", () => { if (auto.get()) thick.set(Math.round(tw.get() * NM / 8) / NM); });   // onTextSize
        const manual = v0.posMode === 2;
        const tx = reg("textX", coordField(v0.textX, "x", { ro: ro || !manual, key: "textX" })), ty = reg("textY", coordField(v0.textY, "y", { ro: ro || !manual, key: "textY" }));
        const angle = reg("angle", numField(v0.angle, { ro: ro || v0.keepAligned, key: "angle", digits: 3 }));
        const presets = h("datalist", { id: "kd-dim-rot" }); for (const r of ["0.0", "90.0", "-90.0", "180.0"]) presets.append(h("option", { value: r })); angle.input.setAttribute("list", "kd-dim-rot");
        const posMode = reg("posMode", selectField<number>(v0.posMode, [[0, "Outside"], [1, "Inline"], [2, "Manual"]], { ro, key: "posMode",
          onChange: (x) => { tx.input.disabled = ty.input.disabled = ro || x !== 2; } }));
        posMode.input.title = "Choose how to position the text relative to the dimension line";
        const keep = reg("keepAligned", checkField(v0.keepAligned, "Keep aligned with dimension", { ro, key: "keepAligned", tip: "Automatically set the text orientation to match the dimension lines",
          onChange: (on) => { angle.input.disabled = ro || on; } }));
        for (const f of [tw, tht, bold, italic] as Field<string | number | boolean>[]) live(f);
        const left = form([["Font:", reg("face", fontField(doc, v0.face, { ro, key: "face" })).el], ["Width:", tw.el, unitLabel(), "Text width"], ["Height:", tht.el, unitLabel(), "Text height"],
          ["Thickness:", thick.el, h("span", { class: "pd-inline", style: "gap:6px" }, unitLabel(), auto.el), "Text thickness"], ...(leader ? [] : [["Position mode:", posMode.el] as [string, HTMLElement]])], true);
        const right = form([["Position X:", tx.el, unitLabel(), "Text pos X"], ["Position Y:", ty.el, unitLabel(), "Text pos Y"],
          ["Orientation:", angle.el, null, "Text orientation"], keep.el], true);
        const toggles = h("div", { class: "pd-inline", style: "flex-wrap:wrap;margin:0 0 8px" }, bold.el, italic.el, ...aligns.map((f) => f.el), mirrored.el);
        body.append(presets, box("Dimension Text", toggles, h("div", { class: "pd-cols2" }, left, right)));
      }
      const lt = reg("lineThickness", lenField(v0.lineThickness, { ro, key: "lineThickness" }));
      const al = reg("arrowLength", lenField(v0.arrowLength, { ro, key: "arrowLength" }));
      const eo = reg("extOffset", lenField(v0.extOffset, { ro, key: "extOffset" }));
      const eh = reg("extHeight", lenField(v0.extHeight, { ro, key: "extHeight" }));
      const dir = reg("arrowDirection", selectField<string>(v0.arrowInward ? "inward" : "outward", [["inward", "Inward"], ["outward", "Outward"]], { ro, key: "arrowDirection" }));
      dir.input.title = "Chose Dimension Arrow Direction\nAutomatic: Determined based on text position.\nInward:    >-----<\nOutward: <----->";
      const lineLeft: ([string, HTMLElement, HTMLElement?, string?])[] = [["Line thickness:", lt.el, unitLabel(), "Thickness of the dimension lines"]];
      if (!center) lineLeft.push(["Arrow length:", al.el, unitLabel()]);
      lineLeft.push(["Arrow direction:", dir.el]);
      const lineRight: ([string, HTMLElement, HTMLElement?, string?])[] = [];
      if (!center) lineRight.push(["Extension line offset:", eo.el, unitLabel(), "Gap between the measured points and the start of the extension lines"]);
      if (aligned) lineRight.push(["Extension line overshoot:", eh.el, unitLabel()]);
      body.append(box("Dimension Line", h("div", { class: "pd-cols2" }, form(lineLeft, true), form(lineRight, true))));
      refresh();
    },
    ok() {
      if (ro) return true;
      const v = current(); if (JSON.stringify(v) === JSON.stringify(v0)) return true;   // nothing changed: the item stays as it is
      const node = applyDimDialog(node0, v);
      if (K().serialize(node) === K().serialize(node0)) return true;
      ctx.commit([K().replaceChange(doc, { ...item, node, geom: [], bbox: null })], "Edit Dimension Properties");
      return true;
    } });
}
