// props/symbol.ts — symbols (schematic): orientation, mirror, position, unit and flags.
import { root } from "../root";
import { atOf, deg360, delKid, kid, kids, num, r6, setAt, setKid, setYesNo, str } from "./sexpr";

// KiCad's TRANSFORM (x1 y1 x2 y2) per orientation — the table kicad-canvas.js draws with.
const ORIENT: Record<number, number[]> = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
export function mirrorOf(node: SNode): string { const m = kid(node, "mirror"); return m ? str(m[1]) : ""; }
export function symbolT(rot: number, mirror: string): number[] {
  const T = (ORIENT[deg360(rot)] || ORIENT[0]).slice();
  if (mirror === "y") { T[0] = -T[0]; T[1] = -T[1]; } else if (mirror === "x") { T[2] = -T[2]; T[3] = -T[3]; }
  return T;
}
/**
 * Re-orient a symbol.  Field positions are stored already transformed (sheet
 * coordinates) while their angle is the raw 0/90, so keep each field's
 * library-frame offset: p' = a + B·Aᵀ·(p − a), A and B being orthonormal.
 */
export function setSymbolTransform(node: SNode, rot: number, mirror: string): void {
  const [ax, ay, oldRot] = atOf(node);
  const A = symbolT(oldRot, mirrorOf(node)), B = symbolT(rot, mirror);
  for (const p of kids(node, "property")) {
    const at = kid(p, "at"); if (!at) continue;
    const dx = num(at[1]) - ax, dy = num(at[2]) - ay;
    const lx = A[0] * dx + A[2] * dy, ly = A[1] * dx + A[3] * dy;
    at[1] = r6(ax + B[0] * lx + B[1] * ly); at[2] = r6(ay + B[2] * lx + B[3] * ly);
  }
  setAt(node, undefined, undefined, deg360(rot));
  if (mirror) setKid(node, "mirror", [mirror], ["unit", "body_style", "convert", "exclude_from_sim", "in_bom", "uuid", "property"]);
  else delKid(node, "mirror");
}
export function setSymbolRotation(node: SNode, deg: number): void { setSymbolTransform(node, deg, mirrorOf(node)); }
export function setSymbolMirror(node: SNode, m: string): void { setSymbolTransform(node, atOf(node)[2], m === "x" || m === "y" ? m : ""); }
/** Fields ride along with the anchor. */
export function setSymbolPosition(node: SNode, x: number, y: number): void {
  const [ox, oy] = atOf(node); const dx = x - ox, dy = y - oy;
  setAt(node, r6(x), r6(y));
  for (const p of kids(node, "property")) { const at = kid(p, "at"); if (at) { at[1] = r6(num(at[1]) + dx); at[2] = r6(num(at[2]) + dy); } }
}
export function setSymbolUnit(node: SNode, n: unknown): void { setKid(node, "unit", [Math.max(1, Math.round(num(n, 1)))], ["body_style", "convert", "exclude_from_sim", "in_bom", "uuid", "property"]); }
export function setSymbolFlag(node: SNode, key: string, on: boolean): void { setYesNo(node, key, on); }
export function libUnitCount(doc: KDoc | null | undefined, node: SNode): number {
  const lib = doc && root.KiCadCanvas.resolveLib(doc, str((kid(node, "lib_id") || [])[1]));
  let n = 1;
  if (lib) for (const s of kids(lib, "symbol")) { const m = str(s[1]).match(/_(\d+)_(\d+)$/); if (m) n = Math.max(n, +m[1]); }
  return n;
}
