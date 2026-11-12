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
  // the outers are the contours of the larger total area's winding
  const areas = paths.map(area);
  let pos = 0, neg = 0; for (const a of areas) { if (a > 0) pos += a; else neg -= a; }
  const outerSign = pos >= neg ? 1 : -1;
  const outers: { pts: Pt[]; holes: Pt[][]; a: number; box: number[] }[] = [];
  const holes: Pt[][] = [];
  paths.forEach((p, i) => { if (Math.sign(areas[i]) === outerSign) outers.push({ pts: p, holes: [], a: Math.abs(areas[i]), box: bbox(p) }); else holes.push(p); });
  if (!holes.length) return paths;
  outers.sort((a, b) => a.a - b.a);   // the smallest outer that contains a hole owns it
  const inside = (c: { pts: Pt[]; box: number[] }, x: number, y: number): boolean => x >= c.box[0] && x <= c.box[2] && y >= c.box[1] && y <= c.box[3] && pointInPoly(c.pts, x, y);
  for (const h of holes) {
    const o = outers.find((c) => inside(c, h[0][0], h[0][1]) || inside(c, (h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2));
    if (o) o.holes.push(h);
  }
  const out: Pt[][] = [];
  for (const o of outers) out.push(o.holes.length ? joinHoles(o.pts, o.holes) : o.pts.slice());
  return out;
}

function bbox(p: Pt[]): number[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  return [x0, y0, x1, y1];
}

/**
 * The holes cut into one outer, taken from the right: each joins the outline edge nearest to the right of its
 * rightmost vertex (an earlier hole's edges included), the first such edge along the outline on a tie.  The
 * outline is a linked list and the non-horizontal edges sit in horizontal bands, so this stays near linear.
 */
function joinHoles(outer: Pt[], holeList: Pt[][]): Pt[] {
  interface N { p: Pt; next: N | null; l: number }   // l: the node's place along the outline (order labels)
  interface E { a: N; dead?: boolean }   // the edge from a to a.next (the outline's last vertex closes to the head)
  const GAP = 1 << 20;
  const head: N = { p: outer[0], next: null, l: 0 }; let tail = head;
  for (let i = 1; i < outer.length; i++) { const n: N = { p: outer[i], next: null, l: i * GAP }; tail.next = n; tail = n; }
  const nextOf = (n: N): N => n.next || head;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of outer) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  let total = outer.length; for (const h of holeList) total += h.length;
  const nb = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(total)))), bh = (y1 - y0) / nb || 1;
  const bands: E[][] = Array.from({ length: nb }, () => []);
  const band = (y: number): number => Math.min(nb - 1, Math.max(0, Math.floor((y - y0) / bh)));
  const addEdge = (a: N): void => {
    const b = nextOf(a); if (a.p[1] === b.p[1]) return;
    const e: E = { a }; const lo = band(Math.min(a.p[1], b.p[1])), hi = band(Math.max(a.p[1], b.p[1]));
    for (let k = lo; k <= hi; k++) bands[k].push(e);
  };
  for (let n: N | null = head; n; n = n.next) addEdge(n);
  const hs = holeList.map((h) => { let mi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i; return { h, mi }; });
  hs.sort((a, b) => b.h[b.mi][0] - a.h[a.mi][0]);
  for (const { h, mi } of hs) {
    const hx = h[mi][0], hy = h[mi][1];
    if (hy < y0 || hy > y1) continue;
    let best: E | null = null, bestX = Infinity;
    for (const e of bands[band(hy)]) {
      if (e.dead) continue;
      const a = e.a.p, b = nextOf(e.a).p;
      if (a[1] === b[1]) continue;
      if (Math.min(a[1], b[1]) > hy || Math.max(a[1], b[1]) < hy) continue;
      const x = a[0] + (b[0] - a[0]) * (hy - a[1]) / (b[1] - a[1]);
      if (x >= hx && (x < bestX || (x === bestX && best && e.a.l < best.a.l))) { bestX = x; best = e; }
    }
    if (!best) continue;
    // a → cut → ring … → cut → b: the edge a-b becomes a-cut and cut-b
    const a = best.a, after = a.next; const cut: Pt = [bestX, hy];
    best.dead = true;
    const c1: N = { p: cut, next: null, l: 0 }; a.next = c1; let last = c1; const added: N[] = [a], fresh: N[] = [c1];
    for (let k = 0; k <= h.length; k++) { const n: N = { p: h[(mi + k) % h.length], next: null, l: 0 }; last.next = n; added.push(last); fresh.push(n); last = n; }
    const c2: N = { p: cut, next: after, l: 0 }; last.next = c2; added.push(last, c2); fresh.push(c2);
    // labels between a and what followed it, all of them relabelled when the gap has run out
    const hiL = after ? after.l : a.l + (fresh.length + 1) * GAP, step = (hiL - a.l) / (fresh.length + 1);
    let ok = true, prev = a.l;
    for (let k = 0; k < fresh.length; k++) { const l = a.l + (k + 1) * step; if (!(l > prev)) ok = false; fresh[k].l = prev = l; }
    if (after && !(after.l > prev)) ok = false;
    if (!ok) { let i = 0; for (let n: N | null = head; n; n = n.next) n.l = i++ * GAP; }
    for (const n of added) addEdge(n);
  }
  const res: Pt[] = []; for (let n: N | null = head; n; n = n.next) res.push(n.p);
  return res;
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
    case "rpoly": {
      if (!(p.d > 0) || p.n < 3) return [];
      const pts: Pt[] = [];
      for (let i = 0; i < p.n; i++) { const a = (p.rot + i * 360 / p.n) * Math.PI / 180; pts.push([p.x + p.d / 2 * Math.cos(a), p.y - p.d / 2 * Math.sin(a)]); }
      return [clockwise(pts)];
    }
    case "td": return [];
  }
}
