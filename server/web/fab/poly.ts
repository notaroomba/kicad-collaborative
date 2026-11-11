// web/fab/poly — polygon set operations for the plotter (Clipper2, the library pcbnew's SHAPE_POLY_SET uses):
// merging a custom pad's primitives into one outline, growing or shrinking a shape by a solder mask or paste
// margin with round corners, the solder mask minimum-width pass, and SHAPE_POLY_SET::Fracture — a polygon with
// holes turned into one outline with cut-ins, the only way a Gerber region or an aperture macro can carry a hole.
import { EndType, FillRule, JoinType, differenceD, inflatePathsD, unionD, type PathD, type PathsD } from "clipper2-ts";
import { type Prim, type Pt, arcPoints, area, circlePoints, rot } from "./prims";

/** Clipper works on integers: six decimals of a millimetre is pcbnew's own nanometre grid. */
const PRECISION = 6;
/** Chord error of a rounded corner or a circle turned into a polygon, mm (the board's default max error). */
export const MAX_ERROR = 0.005;

const toPath = (pts: Pt[]): PathD => pts.map((p) => ({ x: p[0], y: p[1] }));
const fromPath = (p: PathD): Pt[] => p.map((q) => [q.x, q.y] as Pt);
const toPaths = (polys: Pt[][]): PathsD => polys.map(toPath);
const fromPaths = (ps: PathsD): Pt[][] => ps.map(fromPath).filter((p) => p.length >= 3);

/** The union of closed polygons: outer contours and holes, flat (holes wind the other way). */
export function union(polys: Pt[][]): Pt[][] {
  if (!polys.length) return [];
  return fromPaths(unionD(toPaths(polys), [], FillRule.NonZero, PRECISION));
}

/** Polygons grown (d > 0) or shrunk (d < 0) with round corners — SHAPE_POLY_SET::Inflate, ROUND_ALL_CORNERS. */
export function inflate(polys: Pt[][], d: number): Pt[][] {
  if (!d) return polys;
  if (!polys.length) return [];
  return fromPaths(inflatePathsD(toPaths(polys), d, JoinType.Round, EndType.Polygon, 2, PRECISION, MAX_ERROR));
}

/** a − b. */
export function subtract(a: Pt[][], b: Pt[][]): Pt[][] {
  if (!a.length || !b.length) return a;
  return fromPaths(differenceD(toPaths(a), toPaths(b), FillRule.NonZero, PRECISION));
}

function pointInPoly(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * SHAPE_POLY_SET::Fracture: a flat union result (outers and holes) as outlines without holes.  Each hole is
 * joined to what surrounds it by a horizontal cut from its rightmost vertex to the nearest edge to its right,
 * holes taken from the right so a cut can land on a hole already joined.
 */
export function fracture(paths: Pt[][]): Pt[][] {
  if (paths.length < 2) return paths;
  const sign = (p: Pt[]): number => Math.sign(area(p));
  // the outers are the contours of the larger total area's winding
  let pos = 0, neg = 0; for (const p of paths) { const a = area(p); if (a > 0) pos += a; else neg -= a; }
  const outerSign = pos >= neg ? 1 : -1;
  const outers: { pts: Pt[]; holes: Pt[][]; a: number }[] = [];
  const holes: Pt[][] = [];
  for (const p of paths) { if (sign(p) === outerSign) outers.push({ pts: p, holes: [], a: Math.abs(area(p)) }); else holes.push(p); }
  if (!holes.length) return paths;
  outers.sort((a, b) => a.a - b.a);   // the smallest outer that contains a hole owns it
  for (const h of holes) {
    const o = outers.find((c) => pointInPoly(c.pts, h[0][0], h[0][1]) || pointInPoly(c.pts, (h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2));
    if (o) o.holes.push(h);
  }
  const out: Pt[][] = [];
  for (const o of outers) {
    let poly = o.pts.slice();
    const hs = o.holes.map((h) => { let mi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i; return { h, mi }; });
    hs.sort((a, b) => b.h[b.mi][0] - a.h[a.mi][0]);
    for (const { h, mi } of hs) {
      const hx = h[mi][0], hy = h[mi][1];
      let best = -1, bestX = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (a[1] === b[1]) continue;
        if (Math.min(a[1], b[1]) > hy || Math.max(a[1], b[1]) < hy) continue;
        const x = a[0] + (b[0] - a[0]) * (hy - a[1]) / (b[1] - a[1]);
        if (x >= hx && x < bestX) { bestX = x; best = i; }
      }
      if (best < 0) continue;
      const cut: Pt = [bestX, hy];
      const ring: Pt[] = []; for (let k = 0; k <= h.length; k++) ring.push(h[(mi + k) % h.length]);
      poly = poly.slice(0, best + 1).concat([cut], ring, [cut], poly.slice(best + 1));
    }
    out.push(poly);
  }
  return out;
}

/**
 * An outline wound the way every shape made here is (clockwise on screen).  A union counts windings, so a
 * drawn polygon that runs the other way would cancel the shape it overlaps instead of joining it.
 */
export function clockwise(pts: Pt[]): Pt[] { return area(pts) < 0 ? pts.slice().reverse() : pts; }

/** A thick segment with round ends as a polygon. */
export function stadium(x1: number, y1: number, x2: number, y2: number, w: number): Pt[] {
  const r = w / 2;
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) return circlePoints(x1, y1, r, MAX_ERROR);
  const a = Math.atan2(y2 - y1, x2 - x1);
  return arcPoints(x1, y1, r, a + Math.PI / 2, a + 3 * Math.PI / 2, false, MAX_ERROR).concat(arcPoints(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2, false, MAX_ERROR));
}

/** A rectangle w × h with corners of radius r about the origin, turned by `deg`, moved to (x, y). */
export function roundRectPoints(x: number, y: number, w: number, h: number, r: number, deg: number): Pt[] {
  const hx = w / 2 - r, hy = h / 2 - r; const pts: Pt[] = [];
  if (r <= 1e-9) pts.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
  else {
    const corner = (cx: number, cy: number, a0: number): void => { for (const p of arcPoints(cx, cy, r, a0, a0 + Math.PI / 2, false, MAX_ERROR)) pts.push(p); };
    corner(hx, hy, 0); corner(-hx, hy, Math.PI / 2); corner(-hx, -hy, Math.PI); corner(hx, -hy, 3 * Math.PI / 2);
  }
  return pts.map((p) => { const q = rot(p[0], p[1], deg); return [x + q[0], y + q[1]] as Pt; });
}

/** What a primitive covers, as closed polygons (a thick arc is one stadium per chord). */
export function primPolys(p: Prim): Pt[][] {
  switch (p.k) {
    case "seg": return p.w > 0 ? [stadium(p.x1, p.y1, p.x2, p.y2, p.w)] : [];
    case "arc": {
      if (!(p.w > 0)) return [];
      const pts = arcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, MAX_ERROR); const out: Pt[][] = [];
      for (let i = 0; i + 1 < pts.length; i++) out.push(stadium(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], p.w));
      return out;
    }
    case "circle": return p.d > 0 ? [circlePoints(p.x, p.y, p.d / 2, MAX_ERROR)] : [];
    case "rect": return p.w > 0 && p.h > 0 ? [roundRectPoints(p.x, p.y, p.w, p.h, 0, p.rot)] : [];
    case "oval": return p.w > 0 && p.h > 0 ? [roundRectPoints(p.x, p.y, p.w, p.h, Math.min(p.w, p.h) / 2, p.rot)] : [];
    case "roundrect": return p.w > 0 && p.h > 0 ? [roundRectPoints(p.x, p.y, p.w, p.h, p.r, p.rot)] : [];
    case "poly": return p.pts.length >= 3 ? [clockwise(p.pts.map((q) => [p.x + q[0], p.y + q[1]] as Pt))] : [];
    case "region": return p.pts.length >= 3 ? [clockwise(p.pts)] : [];
  }
}
