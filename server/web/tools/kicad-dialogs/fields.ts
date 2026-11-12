// kicad-dialogs/fields.ts — field helpers (pure; tested under node): read and write a symbol / footprint
// field's text, effects, position, layer, keep-upright and visibility on the raw (property …) node.
import { PROPS, delKid, has, kid, kids, num, r4, setKid, str, yesKid } from "./sexpr";

/** A field's font and justification, as the "Edit Text and Field Properties" dialog edits them. */
export interface FieldFx { size: number; thick?: number; bold: boolean; italic: boolean; h: string; v: string; mirror?: boolean }

/** The (property "Name" …) node, or for legacy boards the (fp_text reference|value …) node. */
export function fieldNode(node: SNode, name: string): SNode | null {
  for (const p of kids(node, "property")) if (str(p[1]) === name) return p;
  const t = name === "Reference" ? "reference" : name === "Value" ? "value" : null;
  if (t) for (const p of kids(node, "fp_text")) if (str(p[1]) === t) return p;
  return null;
}
export function fieldText(p: SNode): string { return p[0] === "fp_text" ? str(p[2]) : str(p[2]); }
export function setFieldText(p: SNode, text: unknown): void { p[2] = str(text); }
/** {size, thick, bold, italic, h, v, mirror} from (effects …) with KiCad's defaults. */
export function fieldEffects(p: SNode): Required<FieldFx> {
  const e = kid(p, "effects"), f = e && kid(e, "font"), sz = f && kid(f, "size"), th = f && kid(f, "thickness"), j = e && kid(e, "justify");
  return { size: sz ? num(sz[2], num(sz[1], 1.27)) : 1.27, thick: th ? num(th[1]) : 0,
    bold: !!(f && (has(f, "bold") || yesKid(f, "bold"))), italic: !!(f && (has(f, "italic") || yesKid(f, "italic"))),
    h: j ? (has(j, "left") ? "left" : has(j, "right") ? "right" : "center") : "center",
    v: j ? (has(j, "top") ? "top" : has(j, "bottom") ? "bottom" : "center") : "center",
    mirror: !!(j && has(j, "mirror")) };
}
/** Write font size / thickness / bold / italic / justify the way KiCad 9 does; hide is handled separately. */
export function setFieldEffects(p: SNode, fx: FieldFx): void {
  let e = kid(p, "effects"); if (!e) e = setKid(p, "effects", [], ["uuid"]);
  let f = kid(e, "font"); if (!f) { f = ["font"]; e.splice(1, 0, f); }
  setKid(f, "size", [r4(fx.size), r4(fx.size)]);
  if (fx.thick !== undefined) { if (fx.thick > 0) setKid(f, "thickness", [r4(fx.thick)], ["bold", "italic", "color"]); else delKid(f, "thickness"); }
  for (const flag of ["bold", "italic"] as const) { const i = f.indexOf(flag); if (i > 0) f.splice(i, 1); delKid(f, flag); if (fx[flag]) setKid(f, flag, ["yes"], [flag === "bold" ? "italic" : "color"]); }
  const jv: string[] = []; if (fx.h && fx.h !== "center") jv.push(fx.h); if (fx.v && fx.v !== "center") jv.push(fx.v); if (fx.mirror) jv.push("mirror");
  if (jv.length) setKid(e, "justify", jv, ["hide", "href"]); else delKid(e, "justify");
}
export function fieldAt(p: SNode): [number, number, number] { const a = kid(p, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0]; }
export function setFieldAt(p: SNode, x: number, y: number, rot: number): void { const a = kid(p, "at"); const keep = a ? a.slice(4) : []; setKid(p, "at", [r4(x), r4(y), r4(rot), ...keep], ["layer", "hide", "uuid", "effects"]); }
export function fieldLayer(p: SNode): string { const l = kid(p, "layer"); return l ? str(l[1]) : ""; }
export function setFieldLayer(p: SNode, layer: string): void { if (layer) setKid(p, "layer", [layer], ["hide", "uuid", "effects"]); }
export function fieldUnlocked(p: SNode): boolean { const a = kid(p, "at"); return !!(a && has(a, "unlocked")) || yesKid(p, "unlocked"); }
export function setFieldUnlocked(p: SNode, on: boolean): void { const a = kid(p, "at"); if (a) { const i = a.indexOf("unlocked"); if (i > 0) a.splice(i, 1); } delKid(p, "unlocked"); if (on) setKid(p, "unlocked", ["yes"], ["layer", "hide", "uuid", "effects"]); }
export function fieldHidden(p: SNode): boolean { const H = PROPS() && PROPS()!.helpers; if (H && H.isHidden) return H.isHidden(p); const h = kid(p, "hide"); if (h) return str(h[1]) !== "no"; const e = kid(p, "effects"); return !!(e && (has(e, "hide") || yesKid(e, "hide"))); }
export function setFieldHidden(node: SNode, p: SNode, hidden: boolean): void {
  const H = PROPS() && PROPS()!.helpers;
  if (H && H.setFieldHidden && p[0] === "property" && H.setFieldHidden(node, str(p[1]), hidden)) return;
  const e = kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); delKid(e, "hide"); }
  delKid(p, "hide"); if (hidden) setKid(p, "hide", ["yes"], ["uuid", "effects"]);
}
