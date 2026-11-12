import type { SchCtx } from "./types";
import { editable, selectedItems, setSelectionIds } from "./commands";
import { fontSize, textRect } from "./hit";
import { TEXTBOX_MARGIN, classLabelNode, labelNode, textBoxNode } from "./nodes";
import { K, TEXT_KINDS, atOf, kid, kids, num, str, uuidOf } from "./state";
import { addNode, deep, r4, removeChange, replaceKid } from "./util";

// ---------------------------------------------------------------- type conversions (SCH_EDIT_TOOL::ChangeTextType)
export const CONVERT_KINDS = new Set(["label", "global_label", "hierarchical_label", "text", "text_box", "netclass_flag", "directive_label"]);
export const LABEL_SIZE_RATIO = 0.375;    // SCHEMATIC_SETTINGS::m_LabelSizeRatio
export function copyFont(from: SNode, to: SNode) {
  const ef = kid(from, "effects"), f = ef && kid(ef, "font"); if (!f) return;
  const tef = kid(to, "effects"); if (!tef) return;
  replaceKid(tef, deep(f));
}
// KiCad's getValidNetname: line breaks and tabs become underscores, so do spaces unless it is a bus group.
export function validNetname(text: string) {
  let t = str(text).replace(/[\r\n\t]/g, "_");
  if (!/^[^\s{}]*\{.*\}$/.test(t)) t = t.replace(/ /g, "_");
  return t || "<empty>";
}
export function convertNode(item: KItem, toKind: string, gridPitch: number) {
  const n = item.node, from = item.kind;
  let text = str(n[1]), p = atOf(n).slice(0, 2), rot = atOf(n)[2] || 0;
  const shapeN = kid(n, "shape"), shape = shapeN && (from === "global_label" || from === "hierarchical_label") ? str(shapeN[1]) : null;
  if (from === "netclass_flag" || from === "directive_label") { const nc = kids(n, "property").find((q) => str(q[1]) === "Netclass"); text = nc ? str(nc[2]) : "<empty>"; }
  if (from === "text") rot = 0;                                   // a text's angle is not a spin style: labels start out reading right
  if (from === "text_box") {
    const s = kid(n, "size"), mg = kid(n, "margins"), size = fontSize(n);
    const m = mg ? [num(mg[1]), num(mg[2]), num(mg[3]), num(mg[4])] : [TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN];
    let box = [p[0] + m[0], p[1] + m[1], p[0] + num(s && s[1]) - m[2], p[1] + num(s && s[2]) - m[3]];
    if (toKind === "label" || toKind === "global_label" || toKind === "hierarchical_label") { const inf = LABEL_SIZE_RATIO * size; box = [box[0] - inf, box[1] - inf, box[2] + inf, box[3] + inf]; }
    const ef = kid(n, "effects"), j = ef && kid(ef, "justify"), right = !!(j && j.includes("right")), vertical = rot === 90 || rot === 270;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    if (vertical) { rot = right ? 270 : 90; p = right ? [cx, box[1]] : [cx, box[3]]; } else { rot = right ? 180 : 0; p = right ? [box[2], cy] : [box[0], cy]; }
    const g = gridPitch || 1.27; p = [r4(K.snap(p[0], g)), r4(K.snap(p[1], g))];
  }
  let out;
  if (toKind === "text_box") {
    const r = TEXT_KINDS.has(from) ? textRect(item) : (item.bbox || [p[0], p[1] - 1.27, p[0] + 5, p[1]]);
    const size = fontSize(n), mg = r4(0.75 * size), slop = r4(mg / 20);
    let x0 = r[0] - mg, y0 = r[1] - mg, x1 = r[2] + mg, y1 = r[3] + mg;
    if (rot === 90 || rot === 270) { if (rot === 270) y1 += slop; else y0 -= slop; } else if (rot === 180) x0 -= slop; else x1 += slop;
    out = textBoxNode(text, [x0, y0], [x1, y1]);
  } else if (toKind === "netclass_flag" || toKind === "directive_label") out = classLabelNode(from === "netclass_flag" || from === "directive_label" ? text : text, p, rot);
  else if (toKind === "text") out = labelNode("text", text, p, rot);
  else { out = labelNode(toKind, validNetname(text), p, rot); if (shape && toKind !== "label") replaceKid(out, ["shape", shape]); }
  if (!uuidOf(out)) out.push(["uuid", K.newUuid()]);
  copyFont(n, out);
  return out;
}
export function convertSelection(ctx: SchCtx, toKind: string) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes = [], ids = [];
  for (const it of selectedItems(ctx)) {
    if (!CONVERT_KINDS.has(it.kind) || it.kind === toKind || (toKind === "netclass_flag" && it.kind === "directive_label")) continue;
    const node = convertNode(it, toKind, ctx.gridPitch);
    const added = addNode(doc, node); doc.items.delete(added.item.id);       // commit adds it; keep the doc untouched until then
    changes.push(removeChange(it), added.change); ids.push(added.item.id);
  }
  if (!changes.length) return false;
  ctx.commit(changes, "change to " + toKind.replace("_", " "));
  setSelectionIds(ctx, ids); return true;
}
