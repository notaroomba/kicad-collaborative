// pcb-tools/footprint.ts — footprint rotate / flip at the file level.
import type { SAtom } from "./types";
import { K } from "./state";
import { flipLayerName, isList, norm180, r6, sideSpecific } from "./util";

// ---------------------------------------------------------------- footprint rotate / flip (file-level)
// Pad and text angles in the file are absolute (KiCad writes lib angle + footprint angle), so a footprint
// turn re-derives each one from its angle relative to the footprint; a flip negates that relative angle.
export const ANGLED = (c: SAtom): c is SNode => isList(c) && (c[0] === "pad" || c[0] === "property" || c[0] === "fp_text") && !!K.kid(c, "at");
// the writer leaves a zero orientation out of a pad's and a footprint's (at x y): "(at 1 2)", never "(at 1 2 0)"; text always carries its angle
export function setAngle(c: SNode, a: number) { const at = K.kid(c, "at"); a = norm180(r6(a)); if (a === 0 && c[0] === "pad") { at!.length = Math.min(at!.length, 3); return; } if (at!.length >= 4) at![3] = a; else if (a !== 0) at!.push(a); }
export function setFootprintAt(node: SNode, x: number, y: number, a: number) { K.setAt(node, x, y, a); const at = K.kid(node, "at"); if (at && !K.kid(node, "transform") && a === 0 && at.length === 4 && typeof at[3] === "number") at.length = 3; }
export function rotateFootprintNode(node: SNode, deg: number) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(a0 + deg); setFootprintAt(node, x, y, a1);
  for (const c of node) if (ANGLED(c)) setAngle(c, K.atOf(c)[2] - a0 + a1);
  return node;
}
export function mirrorShapeX(g: SNode) {
  for (const key of ["start", "end", "center", "mid"]) { const k = K.kid(g, key); if (k) k[1] = r6(-K.num(k[1])); }
  const pts = K.kid(g, "pts");
  if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") p[1] = r6(-K.num(p[1])); else mirrorShapeX(p); }
}
export function flipLayerKid(c: SNode) {
  const l = K.kid(c, "layer"); if (l) l[1] = flipLayerName(K.str(l[1]));
  const ls = K.kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayerName(K.str(ls[i]));
}
export function toggleMirror(c: SNode) {
  const l = K.kid(c, "layer"); if (!l || !sideSpecific(K.str(l[1]))) return;   // user layers have no side: no mirroring
  let eff = K.kid(c, "effects"); if (!eff) { eff = ["effects"]; c.push(eff); }
  const j = K.kid(eff, "justify");
  if (!j) { eff.push(["justify", "mirror"]); return; }
  const i = j.indexOf("mirror");
  if (i < 0) j.push("mirror"); else { j.splice(i, 1); if (j.length === 1) eff.splice(eff.indexOf(j), 1); if (eff.length === 1) c.splice(c.indexOf(eff), 1); }
}
/** Flip to the other side about the footprint's own origin (KiCad's F): mirror local X, negate angles, swap F./B. layers. */
export function flipFootprintNode(node: SNode) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(-a0); setFootprintAt(node, x, y, a1);
  const lay = K.kid(node, "layer"); if (lay) lay[1] = flipLayerName(K.str(lay[1]));
  for (const c of node) {
    if (!isList(c)) continue; const t = c[0] as string;
    if (ANGLED(c)) { const at = K.kid(c, "at"); at![1] = r6(-K.num(at![1])); setAngle(c, -(K.atOf(c)[2] - a0) + a1); }
    if (t === "pad") {
      flipLayerKid(c);
      const dr = K.kid(c, "drill"); const off = dr && K.kid(dr, "offset"); if (off) off[1] = r6(-K.num(off[1]));
      const prims = K.kid(c, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) mirrorShapeX(p);
    } else if (t === "property" || t === "fp_text") { if (ANGLED(c)) { flipLayerKid(c); toggleMirror(c); } }
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(t)) { mirrorShapeX(c); flipLayerKid(c); }
    else if (t === "fp_text_box" || t === "zone") { mirrorShapeX(c); flipLayerKid(c); for (const poly of K.kids(c, "polygon").concat(K.kids(c, "filled_polygon"))) mirrorShapeX(poly); if (t === "fp_text_box") toggleMirror(c); }
  }
  return node;
}
