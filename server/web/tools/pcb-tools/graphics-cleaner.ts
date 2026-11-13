// pcb-tools/graphics-cleaner.ts — Tools > Cleanup Graphics... (GRAPHICS_CLEANER, graphics_cleaner.cpp, and
// ConnectBoardShapes, fix_board_shape.cpp): zero-size and duplicated shapes, four lines that make a rectangle, and
// board outline ends that do not quite meet.
import type { BoardDoc, PcbChange, Pt } from "./types";
import type { CleanupItem } from "./track-edit";
import { addedChange, removedChange, replacedChange } from "./changes";
import { K } from "./state";
import { clone, r6 } from "./util";

/** DIALOG_CLEANUP_GRAPHICS's options; tolerance is mm (UNIT_BINDER m_tolerance, 2 mm until changed). */
export interface GraphicsCleanupOpts { mergeRects?: boolean; deleteRedundant?: boolean; fixBoardOutlines?: boolean; tolerance?: number;
  /** ids of the drawings to clean (DIALOG_CLEANUP_GRAPHICS cleans them all: board->Drawings()) */
  ids?: Iterable<string> | null }
export interface GraphicsCleanupPlan { items: CleanupItem[]; changes: PcbChange[] }

// ADVANCED_CFG::m_DRCEpsilon (0.5 um) for GRAPHICS_CLEANER::equivalent; WELD_GAP_TOLERANCE for ConnectBoardShapes
const EPSILON = 0.0005, WELD_GAP = 0.01;
const SHAPE_KINDS = /^gr_(line|rect|circle|arc|poly|curve|ellipse|ellipse_arc)$/;

type Shape = { id: string; item: KItem; node: SNode; kind: string; dirty: boolean };
const P = (n: SNode, key: string): Pt | null => { const k = K.kid(n, key); return k ? [K.num(k[1]), K.num(k[2])] : null; };
const setP = (n: SNode, key: string, p: Pt): void => { const k = K.kid(n, key); if (k) { k[1] = r6(p[0]); k[2] = r6(p[1]); } };
const ptsOf = (n: SNode): Pt[] => K.ptsOf(n) as Pt[];
const setPts = (n: SNode, i: number, p: Pt): void => { const pts = K.kid(n, "pts"); const xy = pts ? pts.filter((c) => Array.isArray(c) && c[0] === "xy")[i] as SNode | undefined : undefined; if (xy) { xy[1] = r6(p[0]); xy[2] = r6(p[1]); } };
const layerOf = (n: SNode): string => { const l = K.kid(n, "layer"); return l ? K.str(l[1]) : ""; };
const widthOf = (n: SNode): number => { const s = K.kid(n, "stroke"); const w = s ? K.kid(s, "width") : K.kid(n, "width"); return w ? K.num(w[1]) : 0; };
const equivalent = (a: Pt | null, b: Pt | null, eps = EPSILON): boolean => !!a && !!b && Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
const d2 = (a: Pt, b: Pt): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** An ellipse's (center …) (major_radius …) (minor_radius …) (rotation_angle …) [(start_angle …) (end_angle …)]. */
const nv = (n: SNode, key: string): number => { const k = K.kid(n, key); return k ? K.num(k[1]) : 0; };
function ellipseOf(n: SNode): { c: Pt; a: number; b: number; rot: number; t0: number; t1: number } {
  return { c: P(n, "center") || [0, 0], a: nv(n, "major_radius"), b: nv(n, "minor_radius"), rot: nv(n, "rotation_angle"), t0: nv(n, "start_angle"), t1: nv(n, "end_angle") };
}
/** EDA_SHAPE::recalcEllipseArcEndpoints: an ellipse's start is its centre and its end the major axis' tip; an arc's are where it starts and ends. */
function ellipseEnds(n: SNode, arc: boolean): [Pt, Pt] {
  const e = ellipseOf(n), phi = e.rot * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  if (!arc) return [e.c, [e.c[0] + e.a * cp, e.c[1] + e.a * sp]];
  const at = (deg: number): Pt => { const t = deg * Math.PI / 180, lx = e.a * Math.cos(t), ly = e.b * Math.sin(t); return [e.c[0] + lx * cp - ly * sp, e.c[1] + lx * sp + ly * cp]; };
  return [at(e.t0), at(e.t1)];
}
/** EDA_SHAPE GetStart / GetEnd: a circle's centre and rim point, a curve's ends, a polygon's unused (0, 0). */
function startOf(s: Shape): Pt | null {
  switch (s.kind) {
    case "circle": return P(s.node, "center");
    case "curve": return ptsOf(s.node)[0] || null;
    case "poly": return [0, 0];
    case "ellipse": case "ellipse_arc": return ellipseEnds(s.node, s.kind === "ellipse_arc")[0];
  }
  return P(s.node, "start");
}
function endOf(s: Shape): Pt | null {
  switch (s.kind) {
    case "curve": return ptsOf(s.node)[3] || null;
    case "poly": return [0, 0];
    case "ellipse": case "ellipse_arc": return ellipseEnds(s.node, s.kind === "ellipse_arc")[1];
  }
  return P(s.node, "end");
}
function setStart(s: Shape, p: Pt): void { if (s.kind === "curve") setPts(s.node, 0, p); else setP(s.node, "start", p); s.dirty = true; }
function setEnd(s: Shape, p: Pt): void { if (s.kind === "curve") setPts(s.node, 3, p); else setP(s.node, "end", p); s.dirty = true; }

/** GRAPHICS_CLEANER::isNullShape */
function isNullShape(s: Shape): boolean {
  switch (s.kind) {
    case "line": case "rect": case "arc": return equivalent(startOf(s), endOf(s));
    case "circle": { const c = startOf(s), e = endOf(s); return !c || !e || Math.hypot(e[0] - c[0], e[1] - c[1]) === 0; }
    case "poly": return ptsOf(s.node).length === 0;
    case "curve": { const p = ptsOf(s.node); if (p.length < 4) return true; return K.bezierPts(p).length < 2 || (K.bezierPts(p).length === 2 && equivalent(p[0], p[3])); }
    case "ellipse": case "ellipse_arc": { const e = ellipseOf(s.node); return Math.round(e.a * 1e6) === 0 || Math.round(e.b * 1e6) === 0; }
  }
  return false;
}
/** GRAPHICS_CLEANER::areEquivalent */
function areEquivalent(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind || layerOf(a.node) !== layerOf(b.node) || widthOf(a.node) !== widthOf(b.node)) return false;
  switch (a.kind) {
    case "line": case "rect": case "circle": return equivalent(startOf(a), startOf(b)) && equivalent(endOf(a), endOf(b));
    case "arc": return equivalent(P(a.node, "mid"), P(b.node, "mid")) && equivalent(startOf(a), startOf(b)) && equivalent(endOf(a), endOf(b));
    case "curve": { const p = ptsOf(a.node), q = ptsOf(b.node); return p.length === 4 && q.length === 4 && p.every((x, i) => equivalent(x, q[i])); }
    case "ellipse": case "ellipse_arc": {
      const e = ellipseOf(a.node), f = ellipseOf(b.node), iu = (v: number): number => Math.round(v * 1e6);
      return equivalent(e.c, f.c) && iu(e.a) === iu(f.a) && iu(e.b) === iu(f.b) && e.rot === f.rot && (a.kind !== "ellipse_arc" || (e.t0 === f.t0 && e.t1 === f.t1));
    }
  }
  return false;   // POLY: TODO in KiCad too
}

/**
 * ConnectBoardShapes: walk the chains of lines, arcs and curves and make their ends meet.  The k-d tree holds the
 * GetStart / GetEnd of every Edge.Cuts shape (rectangles, circles, polygons and ellipses as well), built once from
 * the ends as they were; only lines, arcs and curves start a walk or are joined.
 */
export function connectBoardShapes(shapes: Shape[], eps: number): void {
  if (!shapes.length) return;
  const chainable = shapes.filter((s) => s.kind === "line" || s.kind === "arc" || s.kind === "curve");
  const ends: [Pt, Shape][] = [];
  for (const s of shapes) { const a = startOf(s), b = endOf(s); if (a && b) ends.push([a.slice() as Pt, s], [b.slice() as Pt, s]); }
  const skip = new Set<Shape>();
  const findNext = (shape: Shape, p: Pt): Shape | null => {
    // knnSearch( 2 ): the two nearest ends, the shape's own included
    const near = ends.map((e, i) => [d2(p, e[0]), i] as [number, number]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, 2);
    let best: Shape | null = null, bestD = eps * eps;
    for (const [d, i] of near) { const c = ends[i][1]; if (c === shape || skip.has(c)) continue; if (d < bestD) { bestD = d; best = c; } }
    return best;
  };
  const pick4 = (p0: Pt[], p1: Pt[]): number => { const d = [d2(p0[0], p1[0]), d2(p0[0], p1[1]), d2(p0[1], p1[0]), d2(p0[1], p1[1])]; return d.indexOf(Math.min(...d)); };
  const moveCurveEnd = (s: Shape, i: number, p: Pt): void => {
    const pts = ptsOf(s.node), at = i === 0 ? 0 : 3, ctl = i === 0 ? 1 : 2, dx = p[0] - pts[at][0], dy = p[1] - pts[at][1];
    setPts(s.node, ctl, [pts[ctl][0] + dx, pts[ctl][1] + dy]); setPts(s.node, at, p); s.dirty = true;
  };
  const setEndAt = (s: Shape, i: number, p: Pt): void => { if (s.kind === "curve") moveCurveEnd(s, i, p); else if (i === 0) setStart(s, p); else setEnd(s, p); };
  const connectPair = (a: Shape, b: Shape): void => {
    const pa = [startOf(a)!, endOf(a)!], pb = [startOf(b)!, endOf(b)!];
    if (a.kind === "line" && b.kind === "line") {
      const idx = pick4(pa, pb), i0 = idx >> 1, i1 = idx & 1;
      const ux = pa[1][0] - pa[0][0], uy = pa[1][1] - pa[0][1], vx = pb[1][0] - pb[0][0], vy = pb[1][1] - pb[0][1];
      const cross = ux * vy - uy * vx;
      // SEG::Angle: |Normalize180( angle( A - B ) - angle( A' - B' ) )|, 0..180 degrees, so the drawing directions count
      const n180 = (d: number): number => { while (d <= -180) d += 360; while (d > 180) d -= 360; return d; };
      const dirOf = (x: number, y: number): number => n180(Math.atan2(y, x) * 180 / Math.PI);
      const angle = Math.abs(n180(dirOf(-ux, -uy) - dirOf(-vx, -vy))) * Math.PI / 180;
      const segsCross = (): boolean => { const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(pa[0], pa[1], pb[0]) * o(pa[0], pa[1], pb[1]) <= 0 && o(pb[0], pb[1], pa[0]) * o(pb[0], pb[1], pa[1]) <= 0; };
      let ok = false;
      if ((segsCross() || angle > Math.PI / 4) && Math.abs(cross) > 1e-12) {
        const t = ((pb[0][0] - pa[0][0]) * vy - (pb[0][1] - pa[0][1]) * vx) / cross;
        const x: Pt = [pa[0][0] + t * ux, pa[0][1] + t * uy];
        setEndAt(a, i0, x); setEndAt(b, i1, x); ok = true;
      }
      if (!ok && d2(pa[i0], pb[i1]) <= WELD_GAP * WELD_GAP) { const m: Pt = [(pa[i0][0] + pb[i1][0]) / 2, (pa[i0][1] + pb[i1][1]) / 2]; setEndAt(a, i0, m); setEndAt(b, i1, m); }
      return;
    }
    const joins = (s: Shape): boolean => s.kind === "line" || s.kind === "arc" || s.kind === "curve";
    if (!joins(a) || !joins(b)) return;   // a rectangle, circle, polygon or ellipse: none of connectPair's cases
    if (a.kind === b.kind) {   // arc-arc, curve-curve: both ends to their middle
      const idx = pick4(pa, pb), i0 = idx >> 1, i1 = idx & 1, m: Pt = [(pa[i0][0] + pb[i1][0]) / 2, (pa[i0][1] + pb[i1][1]) / 2];
      setEndAt(a, i0, m); setEndAt(b, i1, m); return;
    }
    // a line meets an arc or a curve, or a curve an arc: the line (or the curve) moves onto the other's end
    const rank = (s: Shape): number => (s.kind === "line" ? 0 : s.kind === "curve" ? 1 : 2);
    const mover = rank(a) < rank(b) ? a : b, fixed = mover === a ? b : a;
    const pm = mover === a ? pa : pb, pf = mover === a ? pb : pa, idx = pick4(pm, pf);
    setEndAt(mover, idx >> 1, pf[idx & 1].slice() as Pt);
  };
  const candidates = new Set(chainable);
  while (candidates.size) {
    const g = candidates.values().next().value as Shape;
    const walkFrom = (cur: Shape, start: Pt): void => {
      let prev = start;
      for (;;) {
        const next = findNext(cur, prev); if (!next) break;
        connectPair(cur, next);
        const ns = startOf(next)!, ne = endOf(next)!;
        prev = d2(prev, ns) < d2(prev, ne) ? ne : ns;
        cur = next; skip.add(cur); candidates.delete(cur);
      }
    };
    const ptEnd = endOf(g)!, ptStart = startOf(g)!;
    const atEnd = findNext(g, ptEnd), atStart = findNext(g, ptStart);
    const minD = (r: Pt, s: Shape): number => Math.min(d2(r, startOf(s)!), d2(r, endOf(s)!));
    const fromEnd = atEnd && atStart ? minD(ptEnd, atEnd) <= minD(ptStart, atStart) : !!atEnd || !atStart;
    if (fromEnd) { walkFrom(g, endOf(g)!); walkFrom(g, startOf(g)!); } else { walkFrom(g, startOf(g)!); walkFrom(g, endOf(g)!); }
    candidates.delete(g);
  }
}

/**
 * GRAPHICS_CLEANER::CleanupBoard: the report (CLEANUP_ITEM texts) and, unless dryRun, the changes as one commit.
 * As in KiCad the board outline fix runs only for real, so a dry run does not list it.
 */
export function graphicsCleanup(doc: BoardDoc, o: GraphicsCleanupOpts, dryRun: boolean): GraphicsCleanupPlan {
  const pick = o.ids ? new Set(o.ids) : null;
  const shapes: Shape[] = [];
  for (const it of doc.items.values()) if (SHAPE_KINDS.test(it.kind) && (!pick || pick.has(it.id))) shapes.push({ id: it.id, item: it, node: clone(it.node), kind: it.kind.slice(3), dirty: false });
  const items: CleanupItem[] = [], deleted = new Set<Shape>(), removed = new Set<Shape>(), added: SNode[] = [];
  if (o.deleteRedundant) {
    shapes.forEach((s, i) => {
      if (deleted.has(s)) return;
      if (isNullShape(s)) { items.push({ code: "null_graphic", text: "Remove zero-size graphic", ids: [s.id] }); removed.add(s); return; }
      for (let j = i + 1; j < shapes.length; j++) {
        const t = shapes[j]; if (deleted.has(t)) continue;
        if (areEquivalent(s, t)) { items.push({ code: "duplicate_graphic", text: "Remove duplicated graphic", ids: [t.id] }); deleted.add(t); removed.add(t); }
      }
    });
  }
  if (o.fixBoardOutlines && !dryRun) connectBoardShapes(shapes.filter((s) => layerOf(s.node) === "Edge.Cuts" && !removed.has(s)), o.tolerance ?? 2);
  if (o.mergeRects) {
    type Side = { start: Pt; end: Pt; s: Shape };
    const key = (p: Pt): string => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
    const sides: Side[] = [], ptMap = new Map<string, Side[]>();
    for (const s of shapes) {
      if (s.kind !== "line" || isNullShape(s)) continue;
      let a = startOf(s)!, b = endOf(s)!;
      if (a[0] !== b[0] && a[1] !== b[1]) continue;
      if (a[0] > b[0] || a[1] > b[1]) [a, b] = [b, a];
      const side = { start: a, end: b, s }; sides.push(side);
      const k = key(a); if (!ptMap.has(k)) ptMap.set(k, []); ptMap.get(k)!.push(side);
    }
    for (const side of sides) {
      if (deleted.has(side.s)) continue;
      const viable = (c: Side): boolean => layerOf(c.s.node) === layerOf(side.s.node) && widthOf(c.s.node) === widthOf(side.s.node) && !deleted.has(c.s);
      let left: Side | null = null, top: Side | null = null, right: Side | null = null, bottom: Side | null = null;
      if (side.start[0] === side.end[0]) { left = side; top = (ptMap.get(key(left.start)) || []).find((c) => c !== left && viable(c)) || null; }
      else if (side.start[1] === side.end[1]) { top = side; left = (ptMap.get(key(top.start)) || []).find((c) => c !== top && viable(c)) || null; }
      if (!top || !left) continue;
      right = (ptMap.get(key(top.end)) || []).find((c) => c !== top && c !== left && viable(c)) || null;
      bottom = (ptMap.get(key(left.end)) || []).find((c) => c !== top && c !== left && viable(c)) || null;
      if (!right || !bottom || key(right.end) !== key(bottom.end)) continue;
      for (const x of [left, top, right, bottom]) { deleted.add(x.s); removed.add(x.s); }
      items.push({ code: "lines_to_rect", text: "Convert lines to rectangle", ids: [left.s.id, top.s.id, right.s.id, bottom.s.id] });
      const stroke = K.kid(top.s.node, "stroke");
      added.push(["gr_rect", ["start", r6(top.start[0]), r6(top.start[1])], ["end", r6(bottom.end[0]), r6(bottom.end[1])],
        stroke ? clone(stroke) : ["stroke", ["width", widthOf(top.s.node)], ["type", "default"]], ["fill", "no"], ["layer", layerOf(top.s.node)], ["uuid", K.newUuid()]]);
    }
  }
  const changes: PcbChange[] = [];
  if (!dryRun) {
    for (const s of shapes) {
      if (removed.has(s)) changes.push(removedChange(s.item));
      else if (s.dirty && K.serialize(s.node) !== K.serialize(s.item.node)) changes.push(replacedChange(s.item, s.node));   // an end already where it goes is no edit
    }
    for (const n of added) changes.push(addedChange(doc, n));
  }
  return { items, changes };
}
