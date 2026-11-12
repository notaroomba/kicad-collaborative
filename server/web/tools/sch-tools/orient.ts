import type { Pt } from "./types";
import { fontNode, labelJustify } from "./nodes";
import { K, LINE_KINDS, SHAPE_KINDS, TEXT_KINDS, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { deep, dropKid, r4, replaceKid } from "./util";

// ---------------------------------------------------------------- orientation (KiCad's transform algebra)
// T = [x1, y1, x2, y2] maps library coords (Y up) to screen offsets; mirrors pre-multiply like the parser does.
/** A 2×2 transform [x1, y1, x2, y2]. */
export type Mat = number[];
export const ROT: Record<number, Mat> = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
export const MX = [1, 0, 0, -1], MY = [-1, 0, 0, 1], RCCW = [0, 1, -1, 0], RCW = [0, -1, 1, 0];
export const OP_M: Record<string, Mat> = { ccw: RCCW, cw: RCW, x: MX, y: MY };
export const SCREEN_OP: Record<string, (dx: number, dy: number) => Pt> = { ccw: (dx: number, dy: number) => [dy, -dx], cw: (dx: number, dy: number) => [-dy, dx], x: (dx: number, dy: number) => [dx, -dy], y: (dx: number, dy: number) => [-dx, dy] };
export function mul(A: Mat, B: Mat): Mat { return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]].map((v) => v || 0); }   // no -0
export function tFrom(rot: number, mirror: string): Mat { let T = ROT[((Math.round(rot) % 360) + 360) % 360] || ROT[0]; if (mirror === "y") T = mul(MY, T); if (mirror === "x") T = mul(MX, T); return T; }
// KiCad's own search order when it writes a transform back out as (at … rot) + (mirror …)
export const ORIENTS: [number, string][] = [[0, ""], [90, ""], [180, ""], [270, ""], [0, "x"], [90, "x"], [270, "x"], [0, "y"], [90, "y"], [180, "y"], [270, "y"]];
export function orientOf(T: Mat) { for (const [rot, m] of ORIENTS) { const U = tFrom(rot, m); if (U[0] === T[0] && U[1] === T[1] && U[2] === T[2] && U[3] === T[3]) return { rot, mirror: m }; } return { rot: 0, mirror: "" }; }
export function symOrient(node: SNode) { const m = kid(node, "mirror"); return { rot: atOf(node)[2], mirror: m ? str(m[1]) : "" }; }
// Rotate / mirror a symbol node in place: compose the transform, rewrite (at … rot)/(mirror …)
// and carry the fields around the anchor with the same screen-space map.
export function orientSymbol(node: SNode, op: string) {
  const { rot, mirror } = symOrient(node); const o = orientOf(mul(OP_M[op], tFrom(rot, mirror)));
  const [ax, ay] = atOf(node); setAt(node, undefined, undefined, o.rot);
  dropKid(node, "mirror");
  if (o.mirror) { const ai = node.findIndex((c) => Array.isArray(c) && c[0] === "at"); node.splice(ai + 1, 0, ["mirror", o.mirror]); }
  const f = SCREEN_OP[op];
  for (const p of kids(node, "property")) { const a = kid(p, "at"); if (!a) continue; const [dx, dy] = f(num(a[1]) - ax, num(a[2]) - ay); a[1] = r4(ax + dx); a[2] = r4(ay + dy); }
  return o;
}
export function setTextRot(kind: string, node: SNode, rot: number) {
  rot = ((rot % 360) + 360) % 360;
  const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  let ef = kid(node, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; node.push(ef); }
  replaceKid(ef, labelJustify(kind, rot));
}
export function rotateNode(kind: string, node: SNode, cw: boolean) {
  if (kind === "symbol") return orientSymbol(node, cw ? "cw" : "ccw");
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[cw ? "cw" : "ccw"](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) { setTextRot(kind, node, atOf(node)[2] + (cw ? 270 : 90)); return true; }
  return false;
}
export function mirrorNode(kind: string, node: SNode, axis: string) {
  if (kind === "symbol") return orientSymbol(node, axis);
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[axis](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) {   // labels flip their reading direction instead
    const rot = atOf(node)[2]; const flip: Record<number, number> = axis === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 };
    if (flip[rot] === undefined) return false; setTextRot(kind, node, flip[rot]); return true;
  }
  return false;
}
export const SHAPE_POINTS: Record<string, string[]> = { rectangle: ["start", "end"], circle: ["center"], arc: ["start", "mid", "end"] };
export function anchorOf(kind: string, node: SNode): Pt {
  if (LINE_KINDS.has(kind) || kind === "bezier") { const p = ptsOf(node); return p[0] || [0, 0]; }
  if (SHAPE_KINDS.has(kind)) { const k = kid(node, SHAPE_POINTS[kind][0]); return k ? [num(k[1]), num(k[2])] : [0, 0]; }
  if (kind === "rule_area") { const pl = kid(node, "polyline"); const p = pl ? ptsOf(pl) : []; return p[0] || [0, 0]; }
  if (kind === "table") { const cells = kid(node, "cells"); const c = cells && kid(cells, "table_cell"); if (c) { const [x, y] = atOf(c); return [x, y]; } return [0, 0]; }
  const [x, y] = atOf(node); return [x, y];
}
export function shiftAt(n: SNode, dx: number, dy: number) { const a = kid(n, "at"); if (a) { a[1] = r4(num(a[1]) + dx); a[2] = r4(num(a[2]) + dy); } }
export function shiftNode(kind: string, node: SNode, dx: number, dy: number) {
  if (!dx && !dy) return;
  if (LINE_KINDS.has(kind) || kind === "bezier") { setPts(node, ptsOf(node).map(([x, y]) => [x + dx, y + dy])); return; }
  if (SHAPE_KINDS.has(kind)) { for (const key of SHAPE_POINTS[kind]) { const k = kid(node, key); if (k) { k[1] = r4(num(k[1]) + dx); k[2] = r4(num(k[2]) + dy); } } return; }
  if (kind === "rule_area") { for (const pl of kids(node, "polyline")) setPts(pl, ptsOf(pl).map(([x, y]) => [x + dx, y + dy])); return; }
  if (kind === "table") { const cells = kid(node, "cells"); if (cells) for (const c of kids(cells, "table_cell")) shiftAt(c, dx, dy); return; }
  const [x, y] = atOf(node); setAt(node, r4(x + dx), r4(y + dy));
  for (const pr of kids(node, "property")) shiftAt(pr, dx, dy);
  if (kind === "sheet") for (const pin of kids(node, "pin")) shiftAt(pin, dx, dy);
}
// A copy with a fresh identity; the desktop re-annotates and rebuilds instance data.
export function cloneNode(item: Pick<KItem, "kind" | "node">) {
  const node = deep(item.node);
  if (item.kind === "rule_area") { dropKid(node, "uuid"); for (const pl of kids(node, "polyline")) replaceKid(pl, ["uuid", K.newUuid()]); return node; }
  replaceKid(node, ["uuid", K.newUuid()]);
  for (const pin of kids(node, "pin")) replaceKid(pin, ["uuid", K.newUuid()]);
  const cells = item.kind === "table" ? kid(node, "cells") : null; if (cells) for (const c of kids(cells, "table_cell")) replaceKid(c, ["uuid", K.newUuid()]);
  dropKid(node, "instances");
  return node;
}
