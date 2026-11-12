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
import { MAX_ERROR, primPolys, roundRectPoints, stadium, union } from "../../fab/poly";
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
export interface CopperCtx { m: BoardModel; pads: Map<unknown, FabPad> }
export function copperCtx(doc: BoardDoc): CopperCtx {
  const m = boardModel(doc as unknown as FabDoc, null); const pads = new Map<unknown, FabPad>();
  for (const fp of m.footprints) for (const p of fp.pads) pads.set(p.node, p);
  return { m, pads };
}
/** One conductor's copper on a layer (TransformShapeToPolygon): a pad's real outline, else its shape. */
export function conductorPolys(c: Conductor, layer: string, cc: CopperCtx): Pt[][] {
  if (c.kind === "pad") {
    const fp = cc.pads.get(c.pad.node);
    if (fp) { const out: Prim[] = []; padPrims(fp, layer, cc.m, out); return out.flatMap(primPolys); }
  }
  return shapePolys(c.shape);
}

/** Clipper's signed area (Clipper2 Area): positive for an outer contour of a union result. */
export function clipperArea(pts: Pt[]): number {
  let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][1] + pts[i][1]) * (pts[j][0] - pts[i][0]);
  return a * 0.5;
}

/** Every copper item on `layer` merged (forEachGeometryItem + Simplify): the outer outlines, in nm. */
export function layerCopperOutlines(doc: BoardDoc, layer: string, conds: Conductor[], cc: CopperCtx): Pt[][] {
  const polys: Pt[][] = [];
  for (const c of conds) if (c.layers.has(layer)) for (const p of conductorPolys(c, layer, cc)) polys.push(p);
  for (const it of doc.items.values()) for (const s of geomShapes(it.geom as never, layer)) for (const p of shapePolys(s)) polys.push(p);
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
