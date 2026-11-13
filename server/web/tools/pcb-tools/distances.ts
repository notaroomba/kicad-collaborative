// pcb-tools/distances.ts — copper shapes and the distances between them.
import type { Arc3, Box, CopperShape, PadInfo, PolyShape, Pt, RectShape } from "./types";
import { distSeg, pointInPoly } from "./hit";
import { K } from "./state";
import { rotator } from "./util";

// ---------------------------------------------------------------- shapes and distances (copper geometry)
// A copper shape is a core (point, segment, polyline, axis-turned rectangle or polygon) plus an outward
// offset r: circle = point + r, track = segment + w/2, roundrect = shrunk rectangle + corner radius.  The gap
// between two shapes is the core distance less both offsets, clamped at zero when they overlap.
export function segsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt) {
  const o = (a: Pt, b: Pt, c: Pt) => { const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return Math.abs(v) < 1e-12 ? 0 : Math.sign(v); };
  const on = (a: Pt, b: Pt, c: Pt) => Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  const o1 = o(p1, p2, p3), o2 = o(p1, p2, p4), o3 = o(p3, p4, p1), o4 = o(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4 && o1 && o2 && o3 && o4) return true;
  return (o1 === 0 && on(p1, p2, p3)) || (o2 === 0 && on(p1, p2, p4)) || (o3 === 0 && on(p3, p4, p1)) || (o4 === 0 && on(p3, p4, p2));
}
export const dPS = (p: Pt, a: Pt, b: Pt) => distSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
export function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt) { return segsIntersect(a, b, c, d) ? 0 : Math.min(dPS(a, c, d), dPS(b, c, d), dPS(c, a, b), dPS(d, a, b)); }
/** Closed polygons (arrays of points): 0 when they touch or one holds the other, else the least vertex-to-edge gap. */
export function polyPolyDist(P: Pt[], Q: Pt[]) {
  if (P.some(([x, y]) => pointInPoly(Q, x, y)) || Q.some(([x, y]) => pointInPoly(P, x, y))) return 0;
  let d = Infinity;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; for (let j = 0; j < Q.length; j++) { const c = Q[j], e = Q[(j + 1) % Q.length]; if (segsIntersect(a, b, c, e)) return 0; d = Math.min(d, dPS(a, c, e), dPS(c, a, b)); } }
  return d;
}
export function polySegDist(P: Pt[], a: Pt, b: Pt) {
  if (pointInPoly(P, a[0], a[1]) || pointInPoly(P, b[0], b[1])) return 0; let d = Infinity;
  for (let i = 0; i < P.length; i++) { const c = P[i], e = P[(i + 1) % P.length]; if (segsIntersect(a, b, c, e)) return 0; d = Math.min(d, dPS(a, c, e), dPS(b, c, e), dPS(c, a, b), dPS(e, a, b)); }
  return d;
}
/** Do two closed polygons share interior area (touching along an edge or at a corner does not count)? */
export function polysOverlap(P: Pt[], Q: Pt[]) {
  // inside and off every edge (polyPointDist is 0 for any point inside, so the edges are measured here)
  const edgeDist = (R: Pt[], p: Pt) => { let d = Infinity; for (let i = 0; i < R.length; i++) d = Math.min(d, dPS(p, R[i], R[(i + 1) % R.length])); return d; };
  const strictInside = (R: Pt[], p: Pt) => pointInPoly(R, p[0], p[1]) && edgeDist(R, p) > 1e-6;
  if (P.some((p: Pt) => strictInside(Q, p)) || Q.some((p: Pt) => strictInside(P, p))) return true;
  // equal-width boxes side by side meet only at corners on each other's edges: an edge's middle shows the overlap
  const mid = (R: Pt[], i: number): Pt => { const a = R[i], b = R[(i + 1) % R.length]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
  if (P.some((_p: Pt, i: number) => strictInside(Q, mid(P, i))) || Q.some((_q: Pt, i: number) => strictInside(P, mid(Q, i)))) return true;
  const o = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; for (let j = 0; j < Q.length; j++) { const c = Q[j], d = Q[(j + 1) % Q.length]; if (o(a, b, c) * o(a, b, d) < -1e-12 && o(c, d, a) * o(c, d, b) < -1e-12) return true; } }
  return false;
}
export function polyPointDist(P: Pt[], p: Pt) { if (pointInPoly(P, p[0], p[1])) return 0; let d = Infinity; for (let i = 0; i < P.length; i++) d = Math.min(d, dPS(p, P[i], P[(i + 1) % P.length])); return d; }
/** The core of a rectangle shape as a polygon (the rounding radius taken off each side). */
export function rectCore(rc: Pick<RectShape, "x" | "y" | "w" | "h"> & { rot?: number; rr?: number }) { const R = rotator(rc.rot || 0); const hw = Math.max(rc.w / 2 - (rc.rr || 0), 0), hh = Math.max(rc.h / 2 - (rc.rr || 0), 0); return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => { const [dx, dy] = R(lx, ly); return [rc.x + dx, rc.y + dy]; }); }
export function rectPointDist(rc: RectShape, p: Pt) { const [lx, ly] = rotator(-(rc.rot || 0))(p[0] - rc.x, p[1] - rc.y); const hw = Math.max(rc.w / 2 - (rc.rr || 0), 0), hh = Math.max(rc.h / 2 - (rc.rr || 0), 0); return Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0)); }
export const shapeOffset = (s: CopperShape) => s.t === "poly" ? 0 : s.t === "rect" ? (s.rr || 0) : (s.r || 0);
export const shapeSegs = (s: CopperShape): Pt[][] => s.t === "seg" ? [[s.a, s.b]] : s.t === "path" ? s.pts.slice(0, -1).map((p: Pt, i: number) => [p, s.pts[i + 1]]) : [];
/** Distance between two shape cores; 0 when they overlap. */
export function coreDist(s1: CopperShape, s2: CopperShape): number {
  const rank: Record<string, number> = { circle: 0, seg: 1, path: 1, rect: 2, poly: 3 };
  if (rank[s1.t] > rank[s2.t]) return coreDist(s2, s1);
  const a = s1.t, b = s2.t;
  if (a === "circle") {
    const p = [s1.x, s1.y];
    if (b === "circle") return Math.hypot(s2.x - s1.x, s2.y - s1.y);
    if (b === "seg" || b === "path") return Math.min(...shapeSegs(s2).map(([c, d]) => dPS(p, c, d)));
    if (b === "rect") return rectPointDist(s2, p);
    return polyPointDist(s2.pts, p);
  }
  if (a === "seg" || a === "path") {
    const segs = shapeSegs(s1);
    if (b === "seg" || b === "path") { let d = Infinity; for (const [p, q] of segs) for (const [c, e] of shapeSegs(s2)) { d = Math.min(d, segSegDist(p, q, c, e)); if (d === 0) return 0; } return d; }
    const P = b === "rect" ? rectCore(s2) : (s2 as PolyShape).pts; let d = Infinity; for (const [p, q] of segs) { d = Math.min(d, polySegDist(P, p, q)); if (d === 0) return 0; } return d;
  }
  if (a === "rect") return polyPolyDist(rectCore(s1), b === "rect" ? rectCore(s2) : (s2 as PolyShape).pts);
  return Infinity;   // zone against zone: the filler's business
}
export const shapeGap = (s1: CopperShape, s2: CopperShape) => Math.max(0, coreDist(s1, s2) - shapeOffset(s1) - shapeOffset(s2));
export function shapeBBox(s: CopperShape): Box {
  const o = shapeOffset(s); let pts: Pt[];
  if (s.t === "circle") pts = [[s.x, s.y]]; else if (s.t === "seg") pts = [s.a, s.b]; else if (s.t === "path" || s.t === "poly") pts = s.pts; else pts = rectCore(s);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - o, y0 - o, x1 + o, y1 + o];
}
export const boxesTouch = (a: Box, b: Box, slop: number) => !(b[0] > a[2] + slop || b[2] < a[0] - slop || b[1] > a[3] + slop || b[3] < a[1] - slop);
/** Points along an arc from kicad-canvas's arcFrom3 result, start to end; chords stay within 0.1 µm of the arc. */
export function arcPoints(arc: Arc3, start: Pt, end: Pt) {
  let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); if (sweep === 0) sweep = 2 * Math.PI;
  const step = arc.r > 1e-4 ? 2 * Math.acos(Math.max(-1, 1 - 1e-4 / arc.r)) : Math.PI / 24;
  const n = Math.min(4096, Math.max(4, Math.ceil(sweep / step))); const out = [start.slice()];
  for (let i = 1; i < n; i++) { const t = arc.a0 + (arc.anticlockwise ? -1 : 1) * sweep * i / n; out.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]); }
  out.push(end.slice()); return out;
}
export function arcLength(arc: Pick<Arc3, "a0" | "a1" | "r" | "anticlockwise">) { let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return arc.r * sweep; }
/** The copper outline of a pad from padsOf: a disc, a stadium, or a (rounded) rectangle — trapezoids, chamfers and custom pads take their bounding rectangle. */
export function padShape(p: Pick<PadInfo, "shape" | "x" | "y" | "w" | "h" | "rot"> & { node?: SNode }): CopperShape {
  if (p.shape === "circle") return { t: "circle", x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2 };
  if (p.shape === "oval") {
    const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h); const half = (long - short) / 2; const d = rotator(p.rot)(p.w >= p.h ? half : 0, p.w >= p.h ? 0 : half);
    return half > 1e-9 ? { t: "seg", a: [p.x - d[0], p.y - d[1]], b: [p.x + d[0], p.y + d[1]], r: short / 2 } : { t: "circle", x: p.x, y: p.y, r: short / 2 };
  }
  let rr = 0; if (p.shape === "roundrect") { const n = p.node && K.kid(p.node, "roundrect_rratio"); rr = (n ? K.num(n[1]) : 0.25) * Math.min(p.w, p.h); }
  return { t: "rect", x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot, rr };
}
export function padCopperLayers(p: Pick<PadInfo, "layers">, copper: string[]) { const out = new Set<string>(); for (const l of p.layers) { if (l === "*.Cu" || l === "F&B.Cu") for (const c of copper) out.add(c); else if (/\.Cu$/.test(l)) out.add(l); } return out; }
export function viaLayers(node: SNode, copper: string[]) {
  const ls = K.kid(node, "layers"); const pair = ls ? [K.str(ls[1]), K.str(ls[2])] : ["F.Cu", "B.Cu"];
  if (!node.includes("blind") && !node.includes("micro") && !node.includes("buried")) return new Set(copper);
  const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); return new Set(i0 >= 0 && i1 >= 0 ? copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1) : pair);
}
export const shareLayer = (a: Set<string>, b: Set<string>) => { for (const l of a) if (b.has(l)) return true; return false; };

/**
 * A uniform grid over item boxes (a broad phase like KiCad's DRC_RTREE): query(box, slop) gives the items whose
 * box may touch it, each once, in their original order.  Items spanning very many cells sit in one shared list.
 */
export function boxGrid<T>(items: T[], boxOf: (t: T) => Box, cell = 2): { query(b: Box, slop: number): T[] } {
  const cells = new Map<number, number[]>(); const big: number[] = []; const boxes = items.map(boxOf);
  const key = (cx: number, cy: number) => cx * 1048576 + cy;
  boxes.forEach((b, i) => {
    const x0 = Math.floor(b[0] / cell), x1 = Math.floor(b[2] / cell), y0 = Math.floor(b[1] / cell), y1 = Math.floor(b[3] / cell);
    if (!isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > 256) { big.push(i); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = key(x, y); const l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); }
  });
  return {
    query(b: Box, slop: number): T[] {
      const hit = new Set<number>(big);
      const x0 = Math.floor((b[0] - slop) / cell), x1 = Math.floor((b[2] + slop) / cell), y0 = Math.floor((b[1] - slop) / cell), y1 = Math.floor((b[3] + slop) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return items.slice();
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const l = cells.get(key(x, y)); if (l) for (const i of l) hit.add(i); }
      return [...hit].sort((p, q) => p - q).filter((i) => boxesTouch(boxes[i], b, slop)).map((i) => items[i]);
    },
  };
}
