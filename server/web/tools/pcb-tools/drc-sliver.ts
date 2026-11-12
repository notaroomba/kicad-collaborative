// pcb-tools/drc-sliver.ts — DRC_TEST_PROVIDER_SLIVER_CHECKER (copper_sliver): on every copper layer the copper of
// all items is merged (SHAPE_POLY_SET::Simplify) and each outline vertex whose two arms (shorter vertex runs skipped)
// meet at less than the angle tolerance, with the far ends more than the width tolerance apart, is a sliver.
// Also the copper polygons both this check and the connection width check build: pads through the plotter's pad
// outlines (custom, trapezoid and chamfered pads included), tracks, arcs, vias and zone fills as their shapes, and
// the copper graphics and text through the plotter's geometry.
import type { BoardDoc, Conductor, CopperShape, DrcMarker } from "./types";
import { boardModel, type FabDoc, type Pad as FabPad, type BoardModel } from "../../fab/model";
import { padPrims } from "../../fab/plot";
import { type Prim, type Pt, circlePoints } from "../../fab/prims";
import { MAX_ERROR, clockwise, primPolys, roundRectPoints, stadium, union } from "../../fab/poly";
import { geomShapes } from "./drc-silk";
import { marker } from "./drc";

/** ADVANCED_CFG: DRCSliverWidthTolerance, DRCSliverMinimumLength (mm), DRCSliverAngleTolerance (degrees). */
export const SLIVER = { widthTolerance: 0.08, minimumLength: 0.0008, angleTolerance: 20 };

/** A copper shape as closed polygons (mm), chords within the board's maximum error. */
export function shapePolys(s: CopperShape): Pt[][] {
  switch (s.t) {
    case "circle": return s.r > 0 ? [circlePoints(s.x, s.y, s.r, MAX_ERROR)] : [];
    case "seg": return s.r > 0 ? [stadium(s.a[0], s.a[1], s.b[0], s.b[1], 2 * s.r)] : [];
    case "path": { const out: Pt[][] = []; if (s.r > 0) for (let i = 0; i + 1 < s.pts.length; i++) out.push(stadium(s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1], 2 * s.r)); return out; }
    case "rect": return s.w > 0 && s.h > 0 ? [roundRectPoints(s.x, s.y, s.w, s.h, Math.min(s.rr || 0, Math.min(s.w, s.h) / 2), s.rot)] : [];
    case "poly": return s.pts.length >= 3 ? [s.pts as Pt[]] : [];
  }
  return [];
}

/** The plotter's model of the board, its pads looked up by their node. */
export interface CopperCtx { m: BoardModel; pads: Map<unknown, FabPad>; nets: Map<string, Map<string, Pt[][]>> }
export function copperCtx(doc: BoardDoc): CopperCtx {
  const m = boardModel(doc as unknown as FabDoc, null); const pads = new Map<unknown, FabPad>();
  for (const fp of m.footprints) for (const p of fp.pads) pads.set(p.node, p);
  return { m, pads, nets: new Map() };
}
/**
 * The merged copper of each net on `layer` (outers and holes, mm), net-less copper under "": computed once a DRC
 * run for each way of building it.  `outside` gives circles and track ends KiCad's ERROR_OUTSIDE polygons at
 * ARC_HIGH_DEF (the connection width check); otherwise they are the plotter's.
 */
export function netCopper(layer: string, conds: Conductor[], cc: CopperCtx, outside = false): Map<string, Pt[][]> {
  const key = (outside ? "out:" : "") + layer;
  let got = cc.nets.get(key); if (got) return got;
  const byNet = new Map<string, Pt[][]>();
  for (const c of conds) if (c.layers.has(layer)) { const k = c.net || ""; let l = byNet.get(k); if (!l) byNet.set(k, l = []); for (const p of conductorPolys(c, layer, cc, outside)) l.push(p); }
  got = new Map(); for (const [k, polys] of byNet) got.set(k, union(polys));
  cc.nets.set(key, got); return got;
}
/** One conductor's copper on a layer (TransformShapeToPolygon): a pad's real outline, else its shape. */
export function conductorPolys(c: Conductor, layer: string, cc: CopperCtx, outside = false): Pt[][] {
  if (c.kind === "pad") {
    const fp = cc.pads.get(c.pad.node);
    if (fp) {
      const out: Prim[] = []; padPrims(fp, layer, cc.m, out);
      return out.flatMap((p) => (outside && p.k === "circle" && p.d > 0 ? [circleOutside(p.x, p.y, p.d / 2)] : primPolys(p)));
    }
  }
  if (outside) {
    const s = c.shape;
    if (s.t === "circle" && s.r > 0) return [circleOutside(s.x, s.y, s.r)];
    if (s.t === "seg" && s.r > 0) return [ovalOutside(s.a, s.b, 2 * s.r)];
  }
  return shapePolys(c.shape);
}

/** ARC_HIGH_DEF (mm). */
export const ARC_HIGH_DEF = 0.005;
/** GetArcToSegmentCount for a full circle, rounded up to a multiple of 8 as TransformCircleToPolygon does (nm). */
function circleSegs(rIU: number, errIU: number): number {
  const r = Math.max(1, rIU), e = Math.max(1, errIU);
  const inc = Math.min(360 / 8, 180 / Math.PI * Math.acos(1 - e / r) * 2);
  const n = Math.max(Math.round(360 / inc), 2);
  return Math.ceil(n / 8) * 8;
}
/** The radius pushed out so the chords' middles lie on the circle (CircleToEndSegmentDeltaRadius). */
function outsideRadius(rIU: number, n: number): number { const a = Math.PI / (n <= 2 ? 3 : n); return rIU + Math.round(Math.abs(rIU * (1 - 1 / Math.cos(a)))); }
const iu = (v: number) => Math.round(v * 1e6);
/** RotatePoint( VECTOR2I ) at `deg`: KiCad's sense (y down), rounded to the nanometre. */
const rotIU = (x: number, y: number, deg: number): Pt => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [Math.round(x * c + y * s), Math.round(y * c - x * s)]; };

/** TransformCircleToPolygon( ERROR_OUTSIDE, ARC_HIGH_DEF ), mm, wound like the other shapes. */
export function circleOutside(x: number, y: number, r: number, err = ARC_HIGH_DEF): Pt[] {
  const rIU = iu(r), n = circleSegs(rIU, iu(err)), R = outsideRadius(rIU, n), d = 360 / n, cx = iu(x), cy = iu(y);
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) { const p = rotIU(R, 0, d / 2 + k * d); out.push([(p[0] + cx) / 1e6, (p[1] + cy) / 1e6]); }
  return clockwise(out);
}

/** TransformOvalToPolygon( ERROR_OUTSIDE, ARC_HIGH_DEF ): round ends on a pushed-out radius, cut back to the
 *  track's width, mm. */
export function ovalOutside(a: number[], b: number[], w: number, err = ARC_HIGH_DEF): Pt[] {
  const wIU = iu(w), r0 = Math.trunc(wIU / 2), n = circleSegs(r0, iu(err)), R = outsideRadius(r0, n), d = 360 / n;
  let sx = iu(a[0]), sy = iu(a[1]), ex = iu(b[0]) - sx, ey = iu(b[1]) - sy;
  if (ex < 0) { sx = iu(b[0]); sy = iu(b[1]); ex = -ex; ey = -ey; }
  const len = Math.round(Math.hypot(ex, ey)), ang = Math.atan2(ey, ex);
  const poly: Pt[] = [[len, R]];
  for (let t = d / 2; t < 180; t += d) { const c = rotIU(0, R, t); poly.push([c[0] + len, c[1]]); }
  poly.push([len, -R], [0, -R]);
  for (let t = d / 2; t < 180; t += d) poly.push(rotIU(0, -R, t));
  poly.push([0, R]);
  // the slab |y| <= width / 2 (BooleanIntersection with the segment's box)
  const hw = Math.trunc(wIU / 2); let pts = poly;
  for (const [lim, sign] of [[hw, 1], [-hw, -1]] as [number, number][]) {
    const res: Pt[] = []; const inside = (p: Pt) => sign * p[1] <= sign * lim;
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i], Q = pts[(i + 1) % pts.length], pi = inside(P), qi = inside(Q);
      if (pi) res.push(P);
      if (pi !== qi) { const t = (lim - P[1]) / (Q[1] - P[1]); res.push([Math.round(P[0] + t * (Q[0] - P[0])), lim]); }
    }
    pts = res;
  }
  const c = Math.cos(ang), s = Math.sin(ang);
  return clockwise(pts.map((p) => [(Math.round(p[0] * c - p[1] * s) + sx) / 1e6, (Math.round(p[0] * s + p[1] * c) + sy) / 1e6] as Pt));
}

/** Clipper's signed area (Clipper2 Area): positive for an outer contour of a union result. */
export function clipperArea(pts: Pt[]): number {
  let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][1] + pts[i][1]) * (pts[j][0] - pts[i][0]);
  return a * 0.5;
}

/** Board items whose copper the conductors already give (forEachGeometryItem visits each item once). */
const CONDUCTOR_KINDS = new Set(["segment", "arc", "via", "zone"]);
/** Every copper item on `layer` merged (forEachGeometryItem + Simplify): the outer outlines, in nm. */
export function layerCopperOutlines(doc: BoardDoc, layer: string, conds: Conductor[], cc: CopperCtx): Pt[][] {
  // each net merged first (shared with the connection width check), then the nets and the graphics together
  const polys: Pt[][] = [];
  for (const merged of netCopper(layer, conds, cc).values()) for (const p of merged) polys.push(p);
  for (const it of doc.items.values()) if (!CONDUCTOR_KINDS.has(it.kind)) for (const s of geomShapes(it.geom as never, layer)) for (const p of shapePolys(s)) polys.push(p);
  return union(polys).filter((p) => clipperArea(p) > 0).map((p) => p.map((q) => [Math.round(q[0] * 1e6), Math.round(q[1] * 1e6)] as Pt));
}

/** The sliver vertices of one outline (nm): DRC_TEST_PROVIDER_SLIVER_CHECKER::Run's inner loop. */
export function sliverPoints(pts: Pt[], opt = SLIVER): Pt[] {
  const out: Pt[] = []; const n = pts.length; if (n <= 5) return out;
  const widthTol = Math.round(opt.widthTolerance * 1e6), sqW = widthTol * widthTol;
  const cosTol = 2.0 * Math.cos(opt.angleTolerance * Math.PI / 180);
  const minLen = Math.round(opt.minimumLength * 1e6);
  const area = (p: Pt, q: Pt, r: Pt) => (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  const locallyInside = (a: number, b: number) => {
    const prev = (n + a - 1) % n, next = (a + 1) % n;
    if (area(pts[prev], pts[a], pts[next]) < 0) return area(pts[a], pts[b], pts[next]) >= 0 && area(pts[a], pts[prev], pts[b]) >= 0;
    return area(pts[a], pts[b], pts[prev]) < 0 || area(pts[a], pts[next], pts[b]) < 0;
  };
  let offset = 0;
  for (let kk = 0; kk < n; kk += offset) {
    const prior = (n + kk - 1) % n; let next = (kk + 1) % n;
    let pt = pts[kk]; const ptPrior = pts[prior]; let vPrior: Pt = [ptPrior[0] - pt[0], ptPrior[1] - pt[1]]; let fwd = 1;
    offset = 1;
    while (Math.abs(vPrior[0]) < minLen && Math.abs(vPrior[1]) < minLen && offset < n) { pt = pts[(kk + offset++) % n]; vPrior = [ptPrior[0] - pt[0], ptPrior[1] - pt[1]]; }
    if (offset >= n) break;
    let ptAfter = pts[next]; let vAfter: Pt = [ptAfter[0] - pt[0], ptAfter[1] - pt[1]];
    while (Math.abs(vAfter[0]) < minLen && Math.abs(vAfter[1]) < minLen && fwd < n) { next = (kk + fwd++) % n; ptAfter = pts[next]; vAfter = [ptAfter[0] - pt[0], ptAfter[1] - pt[1]]; }
    if (vPrior[0] * vAfter[0] + vPrior[1] * vAfter[1] <= 0) continue;   // the angle is 90° or more
    if (!locallyInside(prior, next)) continue;
    const vInc: Pt = [ptAfter[0] - ptPrior[0], ptAfter[1] - ptPrior[1]];
    const arm1 = vPrior[0] ** 2 + vPrior[1] ** 2, arm2 = vAfter[0] ** 2 + vAfter[1] ** 2, opp = vInc[0] ** 2 + vInc[1] ** 2;
    const cos = Math.abs((opp - arm1 - arm2) / (Math.sqrt(arm1) * Math.sqrt(arm2)));
    if (cos > cosTol && 2.0 - cos > 1.1920929e-7 && opp > sqW) out.push(pt);
  }
  return out;
}

/** copper_sliver markers: "Copper sliver (<layer>)" at each sliver vertex. */
export function sliverMarkers(doc: BoardDoc, conds: Conductor[], cc?: CopperCtx): DrcMarker[] {
  const out: DrcMarker[] = []; const ctx = cc || copperCtx(doc);
  for (const layer of doc.copper) {
    const name = layerName(doc, layer);
    for (const poly of layerCopperOutlines(doc, layer, conds, ctx)) for (const p of sliverPoints(poly)) {
      const m = marker("copper_sliver", "warning", p[0] / 1e6, p[1] / 1e6, `Copper sliver (${name})`, []); m.layer = layer; out.push(m);
    }
  }
  return out;
}
/** BOARD::GetLayerName: the user name when the board gives one. */
export function layerName(doc: BoardDoc, layer: string): string { const l = doc.layers && doc.layers.get(layer); return l && l.userName ? l.userName : layer; }
