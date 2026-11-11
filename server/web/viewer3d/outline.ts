// viewer3d/outline.ts — the board's shape for the 3D viewer, from the web document model
// (window.KiCadCanvas doc, server/web/canvas/doc.ts): the Edge.Cuts graphics chained into closed
// loops (outlines with their inner cut-outs) and the drilled holes of pads and vias.
//
// Pure geometry on millimetre coordinates with Y down, exactly as the document stores them; no DOM
// and no three.js, so the node test suite (static/tests/viewer3d.test.js) exercises it directly.

export type Pt = [number, number];

/** One closed board outline with the cut-outs that lie inside it (neither repeats its first point). */
export interface Outline { contour: Pt[]; cutouts: Pt[][] }

/** A drilled hole: its outline polygon, centre, bounding radius and whether the barrel is plated. */
export interface Hole { x: number; y: number; r: number; pts: Pt[]; plated: boolean; via: boolean }

export interface BoardShape {
  outlines: Outline[];
  /** true when no closed Edge.Cuts loop exists and the outline is the copper bounding box */
  fallback: boolean;
  /** [x0, y0, x1, y1] of the outlines */
  bbox: [number, number, number, number];
}

const TAU = Math.PI * 2;
const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);

/** Points along a canvas-style arc (centre, radius, a0 → a1, `anticlockwise` as CanvasPath.arc takes it). */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, anticlockwise: boolean, maxErr = 0.01): Pt[] {
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const sweep = anticlockwise ? -norm(a0 - a1) : norm(a1 - a0);
  const n = Math.max(2, Math.min(180, Math.ceil(Math.abs(sweep) / arcStep(r, maxErr))));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** The angular step that keeps a chord within `maxErr` mm of a circle of radius r. */
function arcStep(r: number, maxErr: number): number {
  if (r <= maxErr) return Math.PI / 2;
  return Math.max(Math.PI / 90, Math.min(Math.PI / 6, 2 * Math.acos(1 - maxErr / r)));
}

export function circlePoints(cx: number, cy: number, r: number, maxErr = 0.01): Pt[] {
  const n = Math.max(12, Math.min(180, Math.ceil(TAU / arcStep(r, maxErr))));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) { const a = TAU * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** A stadium (oval drill / oval pad) w × h rotated by `rot` degrees in KiCad's sense (tracePad's convention). */
export function ovalPoints(cx: number, cy: number, w: number, h: number, rot: number, maxErr = 0.01): Pt[] {
  const r = Math.min(w, h) / 2;
  if (Math.abs(w - h) < 1e-6) return circlePoints(cx, cy, r, maxErr);
  const c = Math.cos(-rot * Math.PI / 180), s = Math.sin(-rot * Math.PI / 180);
  const horiz = w > h; const d = Math.abs(w - h) / 2;
  const n = Math.max(6, Math.min(90, Math.ceil(Math.PI / arcStep(r, maxErr))));
  const out: Pt[] = [];
  const add = (x: number, y: number) => { out.push([cx + x * c - y * s, cy + x * s + y * c]); };
  for (let k = 0; k < 2; k++) {
    const sign = k === 0 ? 1 : -1;
    for (let i = 0; i <= n; i++) {
      const a = (horiz ? -Math.PI / 2 : 0) + (k === 0 ? 0 : Math.PI) + Math.PI * i / n;
      add((horiz ? sign * d : 0) + r * Math.cos(a), (horiz ? 0 : sign * d) + r * Math.sin(a));
    }
  }
  return out;
}

export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

export function pointInPolygon(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to the edges of a closed polygon. */
export function distToPolygon(pts: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j][0], ay = pts[j][1], dx = pts[i][0] - ax, dy = pts[i][1] - ay;
    const l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Drop consecutive duplicates (and a repeated closing point) from a loop. */
function cleanLoop(pts: Pt[], eps = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p); }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= eps && Math.abs(out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

/**
 * Chain open polylines into closed loops by matching end points within `tol` mm (KiCad's own outline
 * builder, ConvertOutlineToPolygon, chains Edge.Cuts segments the same way with a chaining epsilon).
 * Chains that never close are returned separately.
 */
export function chainLoops(paths: Pt[][], tol = 0.01): { loops: Pt[][]; open: Pt[][] } {
  const loops: Pt[][] = [], open: Pt[][] = [];
  const used = new Array<boolean>(paths.length).fill(false);
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  // end points bucketed on a grid of `cell` mm so chaining stays linear on large outlines
  const cell = Math.max(tol * 4, 0.05);
  const key = (p: Pt, dx = 0, dy = 0) => (Math.floor(p[0] / cell) + dx) + ":" + (Math.floor(p[1] / cell) + dy);
  const grid = new Map<string, number[]>();
  paths.forEach((p, i) => { for (const e of [p[0], p[p.length - 1]]) { const k = key(e); const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]); } });
  const findNext = (p: Pt): { i: number; rev: boolean } | null => {
    let best: { i: number; rev: boolean } | null = null, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(key(p, dx, dy)); if (!arr) continue;
      for (const i of arr) {
        if (used[i]) continue; const q = paths[i];
        const d0 = Math.hypot(q[0][0] - p[0], q[0][1] - p[1]), d1 = Math.hypot(q[q.length - 1][0] - p[0], q[q.length - 1][1] - p[1]);
        if (d0 <= tol && d0 < bd) { bd = d0; best = { i, rev: false }; }
        if (d1 <= tol && d1 < bd) { bd = d1; best = { i, rev: true }; }
      }
    }
    return best;
  };
  for (let s = 0; s < paths.length; s++) {
    if (used[s]) continue; used[s] = true;
    let chain = paths[s].slice(); let closed = false;
    for (;;) {
      if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) { closed = true; break; }
      const nx = findNext(chain[chain.length - 1]);
      if (!nx) {
        // nothing continues the tail: try growing from the head instead (the start may be mid-chain)
        const hd = findNext(chain[0]); if (!hd) break;
        used[hd.i] = true; const q = hd.rev ? paths[hd.i] : paths[hd.i].slice().reverse(); chain = q.concat(chain.slice(1)); continue;
      }
      used[nx.i] = true; const q = nx.rev ? paths[nx.i].slice().reverse() : paths[nx.i]; chain = chain.concat(q.slice(1));
    }
    const c = cleanLoop(chain);
    if (closed && c.length >= 3) loops.push(c); else open.push(chain);
  }
  return { loops, open };
}

/** Nest closed loops: even depth = an outline, odd depth = a cut-out of the loop that directly contains it. */
export function nestLoops(loops: Pt[][]): Outline[] {
  const L = loops.filter((l) => l.length >= 3 && Math.abs(polyArea(l)) > 1e-6).sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  const parent: number[] = [], depth: number[] = [];
  for (let i = 0; i < L.length; i++) {
    parent[i] = -1; depth[i] = 0;
    // loops are sorted by area, so the last (smallest) earlier loop containing this one is its parent
    for (let j = i - 1; j >= 0; j--) if (pointInPolygon(L[j], L[i][0][0], L[i][0][1])) { parent[i] = j; depth[i] = depth[j] + 1; break; }
  }
  const out: Outline[] = []; const index = new Map<number, Outline>();
  for (let i = 0; i < L.length; i++) {
    if (depth[i] % 2 === 0) { const o: Outline = { contour: L[i], cutouts: [] }; index.set(i, o); out.push(o); }
    else { const o = index.get(parent[i]); if (o) o.cutouts.push(L[i]); }
  }
  return out;
}

/** The Edge.Cuts primitives of a geometry list as paths: closed ones come back in `loops`, the rest in `paths`. */
function edgePaths(geoms: KGeom[], loops: Pt[][], paths: Pt[][]): void {
  for (const g of geoms) {
    if (g.layer !== "Edge.Cuts") continue;
    if (g.t === "line") paths.push([[num(g.x1), num(g.y1)], [num(g.x2), num(g.y2)]]);
    else if (g.t === "arc") paths.push(arcPoints(num(g.x), num(g.y), num(g.r), num(g.a0), num(g.a1), !!g.anticlockwise));
    else if (g.t === "circle") loops.push(circlePoints(num(g.x), num(g.y), num(g.r)));
    else if (g.t === "poly") {
      const pts = (g.pts as Pt[] | undefined) || []; if (pts.length < 2) continue;
      const p = pts.map((q): Pt => [q[0], q[1]]);
      if (g.close) { const c = cleanLoop(p); if (c.length >= 3) loops.push(c); } else paths.push(p);
    }
  }
}

/** The board outline of a document: Edge.Cuts loops, or the bounding box of the board when there are none. */
export function boardShape(doc: KDoc): BoardShape {
  const loops: Pt[][] = [], paths: Pt[][] = [];
  for (const it of doc.items.values()) edgePaths(it.geom, loops, paths);
  let chained = chainLoops(paths, 0.01);
  // a sloppy outline (ends that miss by a few hundredths) still closes for KiCad's 3D viewer, which retries
  // with a larger chaining epsilon; do the same before giving up on the loose ends
  if (chained.open.length) { const retry = chainLoops(paths, 0.1); if (retry.open.length < chained.open.length) chained = retry; }
  let outlines = nestLoops(loops.concat(chained.loops));
  let fallback = false;
  if (!outlines.length) {
    fallback = true;
    const b = doc.bbox || [0, 0, 100, 80];
    outlines = [{ contour: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], cutouts: [] }];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of outlines) for (const p of o.contour) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return { outlines, fallback, bbox: [x0, y0, x1, y1] };
}

/** Chord error of a drilled hole's outline, mm: a 0.4 mm via gets 12 sides, a 1 mm pad hole 14, a 3 mm mounting hole 24. */
const HOLE_ERR = 0.012;

/** Every drilled hole of the board: through vias and the drills of through-hole / NPTH pads. */
export function boardHoles(doc: KDoc): Hole[] {
  const out: Hole[] = []; const seen = new Map<string, number>();
  const put = (h: Hole) => {
    // a plated pad hole is drawn twice (the plating wall, then the hole): keep the smaller of the pair
    const k = h.x.toFixed(4) + ":" + h.y.toFixed(4); const i = seen.get(k);
    if (i === undefined) { seen.set(k, out.length); out.push(h); } else if (h.r < out[i].r) out[i] = h;
  };
  for (const it of doc.items.values()) {
    for (const g of it.geom) {
      if (!g.hole || g.layer !== "holes") continue;
      if (g.t === "circle") { const r = num(g.r); if (r > 0) put({ x: num(g.x), y: num(g.y), r, pts: circlePoints(num(g.x), num(g.y), r, HOLE_ERR), plated: true, via: !!g.via }); }
      else if (g.t === "pad") {
        const w = num(g.w), h = num(g.h, w); if (!(w > 0) || !(h > 0)) continue;
        const pts = g.shape === "oval" ? ovalPoints(num(g.x), num(g.y), w, h, num(g.rot), HOLE_ERR) : circlePoints(num(g.x), num(g.y), Math.max(w, h) / 2, HOLE_ERR);
        put({ x: num(g.x), y: num(g.y), r: Math.max(w, h) / 2, pts, plated: !g.npth, via: false });
      }
      // blind / buried / micro vias (drawn as two half-discs) do not pierce the board: no hole
    }
  }
  return out;
}

/**
 * Split the holes into those that can be cut out of an outline as real holes — wholly inside it, clear of
 * its edge and cut-outs and of each other — and the rest, which the viewer only paints dark.  Returns one
 * list per outline plus the leftovers.
 */
export function assignHoles(shape: BoardShape, holes: Hole[], clearance = 0.03): { perOutline: Hole[][]; rest: Hole[] } {
  const perOutline: Hole[][] = shape.outlines.map(() => []); const rest: Hole[] = [];
  const maxR = holes.reduce((m, h) => Math.max(m, h.r), 0);
  const cell = Math.max(1, 2 * maxR + clearance);
  const grid = new Map<string, Hole[]>();
  const key = (x: number, y: number) => Math.floor(x / cell) + ":" + Math.floor(y / cell);
  // larger holes win an overlap: place them first
  const sorted = holes.slice().sort((a, b) => b.r - a.r);
  for (const h of sorted) {
    let oi = -1;
    for (let i = 0; i < shape.outlines.length; i++) {
      const o = shape.outlines[i];
      if (!pointInPolygon(o.contour, h.x, h.y) || distToPolygon(o.contour, h.x, h.y) < h.r + clearance) continue;
      if (o.cutouts.some((c) => pointInPolygon(c, h.x, h.y) || distToPolygon(c, h.x, h.y) < h.r + clearance)) continue;
      oi = i; break;
    }
    if (oi < 0) { rest.push(h); continue; }
    let clash = false; const gx = Math.floor(h.x / cell), gy = Math.floor(h.y / cell);
    for (let dx = -1; dx <= 1 && !clash; dx++) for (let dy = -1; dy <= 1 && !clash; dy++) {
      const arr = grid.get((gx + dx) + ":" + (gy + dy)); if (!arr) continue;
      for (const o of arr) if (Math.hypot(o.x - h.x, o.y - h.y) < o.r + h.r + clearance) { clash = true; break; }
    }
    if (clash) { rest.push(h); continue; }
    const k = key(h.x, h.y); const a = grid.get(k); if (a) a.push(h); else grid.set(k, [h]);
    perOutline[oi].push(h);
  }
  return { perOutline, rest };
}
