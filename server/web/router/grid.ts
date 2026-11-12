// Autorouter — the routing grid: pitch selection, obstacle rasterisation and the per-rule-class occupancy maps.
//
// The board is sampled on a fine uniform grid.  For every rule class (track width + clearance + via size) there is
// one occupancy map per copper layer: a cell counts the obstacles that a track of that class centred on the cell
// would violate.  A cell with count 0 is a legal track centre.  Counts (not bits) let a net lift its own copper out
// of the map while it is being routed and put it back afterwards.
import type { Weights } from "./weights";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Shape = any;                 // PcbTools' copper shapes: circle | seg | path | rect | poly
export type Pt = [number, number];

export interface Obstacle { net: string; layers: number[]; shape: Shape; clr: number; edge?: boolean; thru?: Pt; pad?: boolean }

export interface RuleClass {
  key: string; width: number; clr: number; viaD: number; viaDrill: number; kind?: string;
  full: Uint16Array[];                   // everything, including what this run has routed
  fixed: Uint16Array[];                  // only what was on the board before the run (rip-up looks through this one)
  vfull: Uint16Array[]; vfixed: Uint16Array[];   // the same two for a via centred on the cell (a wider disc)
}

export interface Grid {
  g: number; ox: number; oy: number; W: number; H: number;
  layers: string[]; routable: boolean[];
  noVia: Uint16Array;                    // SMD pads and via keep-outs: no via may be centred here
  thru: Uint8Array;                      // the net being routed has a plated hole here: changing layer is free
  outside: Uint8Array | null;            // cells outside the board outline
  keep: (Uint8Array | null)[];           // rule areas that keep tracks out, per layer
  edgeClr: number; margin: number;
  obstacles: Map<string, Obstacle[]>;    // board copper by net ("" = no net, holes, edges)
  classes: Map<string, RuleClass>;
  weights: Weights;
  /** Signal domains: the extra gap a track of one kind keeps from another net's tracks and vias (not its pads). */
  kinds?: Map<string, string>; sep?: (a: string, b: string) => number;
  nearPad?: Uint8Array;                  // cells within reach of a pad: where parts sit close, tracks cannot keep a domain gap
}

export const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];

/** Distance from a point to a shape's copper (0 inside). */
export function pointGap(s: Shape, px: number, py: number): number {
  switch (s.t) {
    case "circle": return Math.max(0, Math.hypot(px - s.x, py - s.y) - s.r);
    case "seg": return Math.max(0, distSeg(px, py, s.a[0], s.a[1], s.b[0], s.b[1]) - s.r);
    case "path": { let d = Infinity; for (let i = 0; i + 1 < s.pts.length; i++) d = Math.min(d, distSeg(px, py, s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1])); return Math.max(0, d - (s.r || 0)); }
    case "rect": {
      const r = -(s.rot || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r); const dx = px - s.x, dy = py - s.y;
      const lx = dx * c + dy * sn, ly = -dx * sn + dy * c; const rr = s.rr || 0;
      const hw = Math.max(s.w / 2 - rr, 0), hh = Math.max(s.h / 2 - rr, 0);
      return Math.max(0, Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0)) - rr);
    }
    case "poly": { if (pointInPoly(s.pts, px, py)) return 0; let d = Infinity; const n = s.pts.length; for (let i = 0; i < n; i++) { const a = s.pts[i], b = s.pts[(i + 1) % n]; d = Math.min(d, distSeg(px, py, a[0], a[1], b[0], b[1])); } return d; }
  }
  return Infinity;
}
export function distSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
export function pointInPoly(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function bboxOf(s: Shape): [number, number, number, number] {
  let pts: Pt[]; let o = 0;
  if (s.t === "circle") { pts = [[s.x, s.y]]; o = s.r; } else if (s.t === "seg") { pts = [s.a, s.b]; o = s.r; } else if (s.t === "path") { pts = s.pts; o = s.r || 0; } else if (s.t === "poly") pts = s.pts;
  else { const h = Math.hypot(s.w, s.h) / 2; return [s.x - h, s.y - h, s.x + h, s.y + h]; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0 - o, y0 - o, x1 + o, y1 + o];
}
/** Long strokes are stamped in short pieces so each piece's bounding box stays tight. */
function pieces(s: Shape): Shape[] {
  const out: Shape[] = []; const CH = 1.5;
  const cut = (a: Pt, b: Pt, r: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.ceil(len / CH));
    for (let i = 0; i < n; i++) out.push({ t: "seg", a: [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], b: [a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n], r });
  };
  if (s.t === "seg") cut(s.a, s.b, s.r); else if (s.t === "path") { for (let i = 0; i + 1 < s.pts.length; i++) cut(s.pts[i], s.pts[i + 1], s.r || 0); } else out.push(s);
  return out;
}

/** Add (sign = 1) or take away (sign = -1) a shape grown by `grow` in an occupancy map. */
export function stamp(G: Grid, map: Uint16Array, s: Shape, grow: number, sign: number, far = grow, near?: Uint8Array): void {
  if (far > grow && near) {   // a wider gap that holds only away from pads
    for (const p of pieces(s)) {
      const b = bboxOf(p);
      const x0 = Math.max(0, Math.ceil((b[0] - far - G.ox) / G.g)), x1 = Math.min(G.W - 1, Math.floor((b[2] + far - G.ox) / G.g));
      const y0 = Math.max(0, Math.ceil((b[1] - far - G.oy) / G.g)), y1 = Math.min(G.H - 1, Math.floor((b[3] + far - G.oy) / G.g));
      for (let iy = y0; iy <= y1; iy++) { const y = G.oy + iy * G.g; let row = iy * G.W + x0; for (let ix = x0; ix <= x1; ix++, row++) { const d = pointGap(p, G.ox + ix * G.g, y); if (d <= grow || (d <= far && !near[row])) map[row] += sign; } }
    }
    return;
  }
  for (const p of pieces(s)) {
    const b = bboxOf(p);
    const x0 = Math.max(0, Math.ceil((b[0] - grow - G.ox) / G.g)), x1 = Math.min(G.W - 1, Math.floor((b[2] + grow - G.ox) / G.g));
    const y0 = Math.max(0, Math.ceil((b[1] - grow - G.oy) / G.g)), y1 = Math.min(G.H - 1, Math.floor((b[3] + grow - G.oy) / G.g));
    for (let iy = y0; iy <= y1; iy++) {
      const y = G.oy + iy * G.g; let row = iy * G.W + x0;
      for (let ix = x0; ix <= x1; ix++, row++) if (pointGap(p, G.ox + ix * G.g, y) <= grow) map[row] += sign;
    }
  }
}
/** Scan-fill a polygon: calls span(ix0, ix1, iy) for the runs of cell centres inside it. */
export function fillPoly(G: Grid, pts: Pt[], span: (x0: number, x1: number, iy: number) => void): void {
  let y0 = Infinity, y1 = -Infinity; for (const p of pts) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const iy0 = Math.max(0, Math.ceil((y0 - G.oy) / G.g)), iy1 = Math.min(G.H - 1, Math.floor((y1 - G.oy) / G.g));
  const xs: number[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    const y = G.oy + iy * G.g + 1e-7; xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i][1], yj = pts[j][1];
      if ((yi > y) !== (yj > y)) xs.push(pts[i][0] + (y - yi) * (pts[j][0] - pts[i][0]) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k] - G.ox) / G.g)), b = Math.min(G.W - 1, Math.floor((xs[k + 1] - G.ox) / G.g));
      if (a <= b) span(a, b, iy);
    }
  }
}

/**
 * The grid pitch and origin.  Among KiCad's usual grids the one most pad centres sit on wins (so tracks leave pads
 * from their centres without a stub; fine-pitch pads count most, across their row), finer first, within a cell budget that keeps a run in memory and in time.
 */
export function pickGrid(pads: (Pt | number[])[], bounds: [number, number, number, number], nLayers: number, forced?: number): { g: number; ox: number; oy: number } {
  const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]); const budget = 3.2e6 / Math.max(2, nLayers);
  const cands = forced ? [forced] : [0.1, 0.127, 0.125, 0.05, 0.2, 0.254, 0.25, 0.4, 0.5, 0.635, 1.27];
  let best: { g: number; ox: number; oy: number; score: number } | null = null;
  for (const g of cands) {
    if (!forced && area / (g * g) > budget) continue;
    const off = (axis: 0 | 1) => {
      const hist = new Map<number, number>(); let top = 0, at = 0;
      let sum = 0; for (const p of pads) { const wt = p.length > 2 ? (p as number[])[2 + axis] : 1; sum += wt; const r = Math.round((((p[axis] % g) + g) % g) * 1000) % Math.round(g * 1000); const n = (hist.get(r) || 0) + wt; hist.set(r, n); if (n > top) { top = n; at = r; } }
      return { frac: sum ? top / sum : 1, off: at / 1000 };
    };
    const fx = off(0), fy = off(1);
    const score = (fx.frac + fy.frac) / 2 - g * 0.6;   // a finer grid is worth a few off-centre pads
    if (!best || score > best.score) best = { g, ox: fx.off, oy: fy.off, score };
  }
  if (!best) { const g = Math.sqrt(area / budget); best = { g: +g.toFixed(3), ox: 0, oy: 0, score: 0 }; }
  const ox = bounds[0] - ((((bounds[0] - best.ox) % best.g) + best.g) % best.g), oy = bounds[1] - ((((bounds[1] - best.oy) % best.g) + best.g) % best.g);
  return { g: best.g, ox, oy };
}

export const growFor = (G: Grid, c: RuleClass, o: Obstacle) => (o.edge ? G.edgeClr : Math.max(c.clr, o.clr)) + c.width / 2 + G.margin;
export const growVia = (G: Grid, c: RuleClass, o: Obstacle) => (o.edge ? G.edgeClr : Math.max(c.clr, o.clr)) + c.viaD / 2 + G.margin;
/** The extra a track of another signal domain adds to the gap (0 when the two are of a kind, or it is a pad). */
const domainGap = (G: Grid, c: RuleClass, o: Obstacle): number => {
  if (!c.kind || !G.kinds || !G.sep || o.pad || o.edge || !o.net) return 0; const k = G.kinds.get(o.net); if (!k || k === c.kind) return 0;
  return Math.max(0, G.sep(c.kind, k) - Math.max(c.clr, o.clr));
};
function stampObstacle(G: Grid, c: RuleClass, o: Obstacle, sign: number, t: Uint16Array[], v: Uint16Array[]): void {
  const gt = growFor(G, c, o), gv = growVia(G, c, o), x = domainGap(G, c, o);
  for (const l of o.layers) { stamp(G, t[l], o.shape, gt, sign, gt + x, G.nearPad); stamp(G, v[l], o.shape, gv, sign, gv + x, G.nearPad); }
}
/** Put an obstacle into (or take it out of) a class's maps: the run's maps, and the board's own too when `fixed`. */
export function stampClass(G: Grid, c: RuleClass, o: Obstacle, sign: number, fixed: boolean): void {
  stampObstacle(G, c, o, sign, c.full, c.vfull); if (fixed) stampObstacle(G, c, o, sign, c.fixed, c.vfixed);
}

/** Build the occupancy maps of a rule class from the board's obstacles. */
export function buildClass(G: Grid, key: string, width: number, clr: number, viaD: number, viaDrill: number, kind?: string): RuleClass {
  const n = G.W * G.H; const c: RuleClass = { key, width, clr, viaD, viaDrill, kind, full: [], fixed: [], vfull: [], vfixed: [] };
  for (let l = 0; l < G.layers.length; l++) {
    const m = new Uint16Array(n);
    if (G.outside) for (let i = 0; i < n; i++) if (G.outside[i]) m[i] = 1;
    const k = G.keep[l]; if (k) for (let i = 0; i < n; i++) if (k[i]) m[i]++;
    c.fixed.push(m); c.vfixed.push(m.slice());
  }
  for (const list of G.obstacles.values()) for (const o of list) stampObstacle(G, c, o, 1, c.fixed, c.vfixed);
  for (let l = 0; l < G.layers.length; l++) { c.full.push(c.fixed[l].slice()); c.vfull.push(c.vfixed[l].slice()); }
  G.classes.set(key, c);
  return c;
}

/** May a via of the class be centred on the cell?  Every copper layer must take it (through vias only). */
export function viaFits(G: Grid, vmaps: Uint16Array[], gi: number): boolean {
  if (G.noVia[gi]) return false;
  for (let l = 0; l < vmaps.length; l++) if (vmaps[l][gi]) return false;
  return true;
}
