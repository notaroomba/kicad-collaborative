// web/fab/zonefill — pcbnew's ZONE_FILLER (pcbnew/zone_filler.cpp) in the browser, on Clipper2 (the library
// SHAPE_POLY_SET wraps).  Every step follows the desktop filler:
//
//   Fill()                     conditional pad / via flashing, the zones filled in priority order (a zone waits
//                              for the higher-priority zones it touches), then isolated islands and copper
//                              outside the board edge removed, and the flashing re-checked against the fills
//   BuildSmoothedPoly()        the outline with its same-net neighbours, clipped to the board, chamfered or
//                              filleted, and the min-thickness apron around it
//   fillCopperZone()           thermal reliefs knocked out, clearances to every other-net item (pads, holes,
//                              tracks, vias, text, graphics, the board edge, keepouts), thermal spokes that
//                              reach copper, the min-width deflate / inflate, the hatch pattern, the trim to
//                              the outline, the higher-priority different-net zones (with a second min-width
//                              prune) and the higher-priority same-net zones
//   fillNonCopperZone()        knockout graphics and keepouts out, min-width prune, hatch
//
// Lengths are millimetres; Clipper works to 1 nm (pcbnew's internal unit) and arcs to the board's 5 µm error.
import { ClipType, EndType, FillRule, JoinType, booleanOpD, inflatePathsD, type PathD, type PathsD } from "clipper2-ts";
import { has, kid, kids, num, polyPtsOf, str } from "../canvas/sexpr";
import { type BoardModel, type Footprint, type Node, type Pad, type Track, type Via, expandLayers, isCopper, padShapeOn } from "./model";
import { PlotLog, footprintGeoms, geomPrims, padPrims, textKnockout } from "./plot";
import { fracture, primPolys, stadium } from "./poly";
import { type Prim, type Pt, arcPoints, circlePoints, rot } from "./prims";

/** pcbnew's internal unit: 1 nm. */
const PREC = 6;
/** BOARD_DESIGN_SETTINGS::m_MaxError default (ARC_HIGH_DEF). */
export const MAX_ERROR = 0.005;
/** ADVANCED_CFG::m_ExtraClearance. */
const EXTRA_MARGIN = 0.0005;
/** The epsilon fillCopperZone takes off min_width/2. */
const EPSILON = 0.001;

type Poly = PathsD;
const K = (n: Node | null, key: string): Node | null => (n ? (kid(n, key) as Node | null) : null);

// ---------------------------------------------------------------- polygon set operations (SHAPE_POLY_SET)
const toPath = (pts: Pt[]): PathD => pts.map((p) => ({ x: p[0], y: p[1] }));
const signedArea = (p: PathD): number => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y; return a / 2; };
/** A simple shape wound the way Clipper writes outers (positive area), so a NonZero union joins rather than cancels. */
const shape = (pts: Pt[]): PathD => { const p = toPath(pts); return signedArea(p) < 0 ? p.reverse() : p; };
const shapes = (polys: Pt[][]): Poly => polys.filter((p) => p.length >= 3).map(shape);

export function union(a: Poly, b?: Poly): Poly { if (!a.length && (!b || !b.length)) return []; return booleanOpD(ClipType.Union, a, b && b.length ? b : null, FillRule.NonZero, PREC); }
export function subtract(a: Poly, b: Poly): Poly { if (!a.length || !b.length) return a; return booleanOpD(ClipType.Difference, a, b, FillRule.NonZero, PREC); }
export function intersect(a: Poly, b: Poly): Poly { if (!a.length || !b.length) return []; return booleanOpD(ClipType.Intersection, a, b, FillRule.NonZero, PREC); }
/** SHAPE_POLY_SET::Inflate / Deflate: ROUND_ALL_CORNERS → round joins, CHAMFER_ALL_CORNERS → square joins. */
export function inflate(a: Poly, d: number, round = true, maxError = MAX_ERROR): Poly {
  if (!a.length) return a; if (!d) return a;
  return inflatePathsD(a, d, round ? JoinType.Round : JoinType.Square, EndType.Polygon, 2, PREC, maxError);
}
export const polyArea = (a: Poly): number => a.reduce((s, p) => s + signedArea(p), 0);

interface Box { x0: number; y0: number; x1: number; y1: number }
function bboxOf(a: Poly | PathD[]): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of a) for (const q of p) { if (q.x < b.x0) b.x0 = q.x; if (q.y < b.y0) b.y0 = q.y; if (q.x > b.x1) b.x1 = q.x; if (q.y > b.y1) b.y1 = q.y; }
  return b;
}
const grow = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
const hits = (a: Box, b: Box): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

function inPath(p: PathD, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i].x, yi = p[i].y, xj = p[j].x, yj = p[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance from (x, y) to a closed path's edges. */
function distToPath(p: PathD, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ax = p[j].x, ay = p[j].y, dx = p[i].x - ax, dy = p[i].y - ay; const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y); if (d < best) best = d;
  }
  return best;
}
/** SHAPE_POLY_SET::Contains(pt, -1, accuracy) on a flat set (outers and holes, NonZero). */
export function contains(a: Poly, x: number, y: number, accuracy = 0): boolean {
  let wind = 0;
  for (const p of a) if (inPath(p, x, y)) wind += signedArea(p) >= 0 ? 1 : -1;
  if (wind > 0) return true;
  if (accuracy > 0) for (const p of a) if (distToPath(p, x, y) <= accuracy) return true;
  return false;
}
/** Do two sets share area or touch (SHAPE_POLY_SET::Collide with clearance `d`)? */
function collide(a: Poly, b: Poly, d = 0): boolean {
  if (!a.length || !b.length) return false;
  if (!hits(grow(bboxOf(a), d), bboxOf(b))) return false;
  if (d > 0) return intersect(inflate(a, d, false), b).length > 0;
  return intersect(a, b).length > 0;
}

/** Outer contours with the holes they own: SHAPE_POLY_SET's polygons, outline first. */
function polygonsOf(a: Poly): PathD[][] {
  const outers: { p: PathD; holes: PathD[]; a: number }[] = []; const holes: PathD[] = [];
  for (const p of a) { const ar = signedArea(p); if (ar >= 0) outers.push({ p, holes: [], a: ar }); else holes.push(p); }
  const bySize = outers.slice().sort((x, y) => x.a - y.a);
  for (const h of holes) { const o = bySize.find((c) => inPath(c.p, h[0].x, h[0].y) || (h.length > 1 && inPath(c.p, (h[0].x + h[1].x) / 2, (h[0].y + h[1].y) / 2))); if (o) o.holes.push(h); }
  return outers.map((o) => [o.p, ...o.holes]);
}
const fromPolygons = (ps: PathD[][]): Poly => ps.flat();

/** SHAPE_POLY_SET::Fracture: each polygon as one outline, its holes joined in by zero-width cuts. */
export function fractured(a: Poly): Pt[][] {
  const out: Pt[][] = [];
  for (const pg of polygonsOf(a)) {
    const pts = pg.map((p) => p.map((q) => [q.x, q.y] as Pt));
    if (pts.length === 1) out.push(pts[0]); else for (const f of fracture(pts)) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- corner smoothing (SHAPE_POLY_SET::chamferFilletPolygon)
function segCount(r: number, maxErr: number, angle: number): number {
  const rel = Math.max(maxErr, 1e-6) / Math.max(r, 1e-6);
  const inc = Math.min(360 / 8, 180 / Math.PI * Math.acos(1 - rel) * 2);
  return Math.max(2, Math.round(Math.abs(angle * 180 / Math.PI) / inc));
}
export function chamferFillet(contour: Pt[], fillet: boolean, dist: number, maxErr = MAX_ERROR): Pt[] {
  if (!(dist > 0)) return contour;
  // RemoveNullSegments
  const c: Pt[] = []; for (const p of contour) { const q = c[c.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) c.push(p); }
  if (c.length > 1 && Math.abs(c[0][0] - c[c.length - 1][0]) < 1e-9 && Math.abs(c[0][1] - c[c.length - 1][1]) < 1e-9) c.pop();
  const out: Pt[] = []; const n = c.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = c[i]; const pv = c[(i + n - 1) % n], nx = c[(i + 1) % n];
    const xa = pv[0] - x1, ya = pv[1] - y1, xb = nx[0] - x1, yb = nx[1] - y1;
    if (Math.abs(xa + xb) < 1e-12 && Math.abs(ya + yb) < 1e-12) continue;
    const lena = Math.hypot(xa, ya), lenb = Math.hypot(xb, yb);
    if (!fillet) {
      const d = Math.min(dist, 0.5 * lena, 0.5 * lenb);
      out.push([x1 + d * xa / lena, y1 + d * ya / lena], [x1 + d * xb / lenb, y1 + d * yb / lenb]);
      continue;
    }
    const cosine = (xa * xb + ya * yb) / (lena * lenb);
    const denom = Math.sqrt(2 / (1 + cosine) - 1);
    if (!isFinite(denom)) continue;
    let radius = dist;
    if (0.5 * lena * denom < radius) radius = 0.5 * lena * denom;
    if (0.5 * lenb * denom < radius) radius = 0.5 * lenb * denom;
    let k = radius / Math.sqrt(0.5 * (1 - cosine));
    const lenab = Math.hypot(xa / lena + xb / lenb, ya / lena + yb / lenb);
    const xc = x1 + k * (xa / lena + xb / lenb) / lenab, yc = y1 + k * (ya / lena + yb / lenb) / lenab;
    k = radius / Math.sqrt(2 / (1 + cosine) - 1);
    const xs = x1 + k * xa / lena - xc, ys = y1 + k * ya / lena - yc, xe = x1 + k * xb / lenb - xc, ye = y1 + k * yb / lenb - yc;
    const arg = Math.max(-1, Math.min(1, (xs * xe + ys * ye) / (radius * radius)));
    const arcAngle = Math.acos(arg); const segs = segCount(radius, maxErr, arcAngle);
    let delta = arcAngle / segs; const start = Math.atan2(-ys, xs);
    if (xa * yb - ya * xb <= 0) delta = -delta;
    if (isNaN(xc + xs) || isNaN(yc + ys)) continue;
    out.push([xc + xs, yc + ys]);
    for (let j = 0; j < segs; j++) { const a = start + (j + 1) * delta; out.push([xc + Math.cos(a) * radius, yc - Math.sin(a) * radius]); }
  }
  return out;
}

// ---------------------------------------------------------------- the zones
export interface ZoneHatch { thickness: number; gap: number; orientation: number; smoothingLevel: number; smoothingValue: number; borderHatch: boolean; minHoleArea: number; offsets: Map<string, Pt> }
export interface ZoneModel {
  id: string; node: Node; uuid: string;
  net: string; layers: string[]; priority: number;
  /** the outline contours (outline and holes), board frame */
  contours: Pt[][]; outline: Poly; bbox: Box;
  ruleArea: boolean; noFills: boolean; teardrop: boolean;
  /** THERMAL | FULL | NONE | THT_THERMAL */
  connect: string; clearance: number; minThickness: number;
  thermalGap: number; spokeWidth: number;
  smoothing: "" | "chamfer" | "fillet"; radius: number;
  islandMode: number; islandAreaMin: number;
  hatch: ZoneHatch | null; thieving: boolean;
  /** the fill stored in the document: layer → outlines */
  stored: Map<string, Poly>;
}

const CONNECT: Record<string, string> = { yes: "FULL", no: "NONE", thru_hole_only: "THT_THERMAL" };

export function readZone(item: KItem, copper: string[]): ZoneModel | null {
  const n = item.node as Node;
  const single = K(n, "layer"), multi = K(n, "layers");
  const layers = expandLayers(single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"], copper).filter((l, i, a) => a.indexOf(l) === i);
  const nn = K(n, "net"), nname = K(n, "net_name");
  const net = nname ? str(nname[1]) : nn ? (typeof nn[1] === "number" ? "" : str(nn[1])) : "";
  const contours: Pt[][] = [];
  for (const p of kids(n, "polygon") as Node[]) { const pts = polyPtsOf(p) as Pt[]; if (pts.length >= 3) contours.push(pts); }
  // the first chain is the outline, the rest its holes (PCB_IO_KICAD_SEXPR writes Polygon(0) chain by chain)
  const outline = contours.length ? booleanOpD(ClipType.Union, contours.map(toPath), null, FillRule.EvenOdd, PREC) : [];
  const ko = K(n, "keepout"); const cp = K(n, "connect_pads"); const fill = K(n, "fill");
  const f = (key: string, d: number): number => { const k = K(fill, key); return k ? num(k[1], d) : d; };
  const fs = (key: string): string => { const k = K(fill, key); return k ? str(k[1]) : ""; };
  const mode = fs("mode");
  const offsets = new Map<string, Pt>();
  for (const pr of kids(n, "property") as Node[]) { const l = K(pr, "layer"), hp = K(pr, "hatch_position"); const xy = hp ? K(hp, "xy") : null; if (l && xy) offsets.set(str(l[1]), [num(xy[1]), num(xy[2])]); }
  const attr = K(n, "attr");
  const prio = K(n, "priority"), mt = K(n, "min_thickness"), cl = cp ? K(cp, "clearance") : null;
  const smoothing = fs("smoothing");
  const uuidN = K(n, "uuid") || K(n, "tstamp");
  const z: ZoneModel = { id: item.id, node: n, uuid: uuidN ? str(uuidN[1]) : item.id, net, layers, priority: prio ? num(prio[1]) : 0, contours, outline, bbox: bboxOf(outline),
    ruleArea: !!ko, noFills: !!ko && str((K(ko, "copperpour") || [])[1]) === "not_allowed", teardrop: !!(attr && K(attr, "teardrop")),
    connect: cp && typeof cp[1] === "string" && CONNECT[cp[1]] ? CONNECT[cp[1]] : "THERMAL", clearance: cl ? num(cl[1]) : 0, minThickness: mt ? num(mt[1], 0.25) : 0.25,
    thermalGap: f("thermal_gap", 0.5), spokeWidth: f("thermal_bridge_width", 0.5),
    smoothing: smoothing === "chamfer" || smoothing === "fillet" ? smoothing : "", radius: f("radius", 0),
    islandMode: f("island_removal_mode", 0), islandAreaMin: f("island_area_min", 10),
    hatch: mode === "hatch" ? { thickness: f("hatch_thickness", 1), gap: f("hatch_gap", 1.5), orientation: f("hatch_orientation", 0), smoothingLevel: f("hatch_smoothing_level", 0), smoothingValue: f("hatch_smoothing_value", 0.1), borderHatch: fs("hatch_border_algorithm") !== "min_thickness", minHoleArea: f("hatch_min_hole_area", 0.3), offsets } : null,
    thieving: mode === "thieving", stored: new Map() };
  for (const fp of kids(n, "filled_polygon") as Node[]) {
    const l = K(fp, "layer"); const pts = polyPtsOf(fp) as Pt[]; if (pts.length < 3) continue;
    const key = l ? str(l[1]) : layers[0]; const cur = z.stored.get(key) || []; cur.push(shape(pts)); z.stored.set(key, cur);
  }
  return z;
}

/** ZONE::HigherPriority: priority, then the uuid. */
export function higherPriority(a: ZoneModel, b: ZoneModel): boolean {
  if (a.teardrop !== b.teardrop) return a.teardrop;
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.uuid.toLowerCase() > b.uuid.toLowerCase();
}

// ---------------------------------------------------------------- rules (the DRC engine's implicit constraints)
export interface FillRules {
  /** the clearance of a net's netclass */
  netClearance(net: string): number;
  /** board minimum clearance, hole clearance and copper-to-edge clearance (Board Setup > Constraints) */
  minClearance: number; holeClearance: number; edgeClearance: number;
  maxError?: number;
}
const padOverride = (pad: Pad, key: string): number | null => { const k = K(pad.node, key); if (k) return num(k[1]); const f = K(pad.fp.node, key); return f ? num(f[1]) : null; };

// ---------------------------------------------------------------- the filler
export interface LayerFill { layer: string; outlines: Pt[][]; islands: Set<number> }
export interface ZoneFillResult { id: string; layers: LayerFill[] }
export interface FillProgress { phase(n: number, text: string): void; advance(done: number, total: number): void; cancelled(): boolean; yield(): Promise<void> }

/** POLY_YSTRIPES_INDEX: a closed path's edges bucketed by horizontal stripes, for point and segment queries on big fills. */
class PathIndex {
  private readonly y0: number; private readonly h: number; private readonly stripes: number[][];
  readonly bbox: Box;
  constructor(private readonly p: PathD) {
    this.bbox = bboxOf([p]);
    const n = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(p.length))));
    this.y0 = this.bbox.y0; this.h = Math.max(1e-6, (this.bbox.y1 - this.bbox.y0) / n);
    this.stripes = Array.from({ length: n }, () => []);
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = Math.min(p[i].y, p[j].y), b = Math.max(p[i].y, p[j].y);
      for (let k = this.row(a); k <= this.row(b); k++) this.stripes[k].push(j);
    }
  }
  private row(y: number): number { return Math.max(0, Math.min(this.stripes.length - 1, Math.floor((y - this.y0) / this.h))); }
  contains(x: number, y: number): boolean {
    if (x < this.bbox.x0 || x > this.bbox.x1 || y < this.bbox.y0 || y > this.bbox.y1) return false;
    const p = this.p; let inside = false;
    for (const j of this.stripes[this.row(y)]) {
      const i = (j + 1) % p.length; const xi = p[i].x, yi = p[i].y, xj = p[j].x, yj = p[j].y;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** Does any edge cross the segment a–b? */
  crosses(ax: number, ay: number, bx: number, by: number): boolean {
    const p = this.p; const seen = new Set<number>();
    for (let k = this.row(Math.min(ay, by)); k <= this.row(Math.max(ay, by)); k++) for (const j of this.stripes[k]) {
      if (seen.has(j)) continue; seen.add(j);
      const i = (j + 1) % p.length;
      if (segsCross(ax, ay, bx, by, p[j].x, p[j].y, p[i].x, p[i].y)) return true;
    }
    return false;
  }
}
function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by), d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0) !== (d2 > 0) || d1 === 0 || d2 === 0) && ((d3 > 0) !== (d4 > 0) || d3 === 0 || d4 === 0) && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx) || Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)));
}

interface CopperItem { kind: "pad" | "via" | "track"; net: string; layers: Set<string>; pad?: Pad; via?: Via; track?: Track; bbox: Box }

export class ZoneFiller {
  readonly zones: ZoneModel[];
  private readonly board: Poly | null;
  private readonly edges: Pt[][] = [];
  private readonly log = new PlotLog();
  private readonly maxError: number;
  /** pad / via → layers it is forced (not) flashed on by the conditional-flashing pass */
  private readonly padFlash = new Map<Pad | Via, Map<string, boolean>>();
  private readonly fills = new Map<ZoneModel, Map<string, Poly>>();
  private readonly worst: number;
  private readonly items: CopperItem[] = [];

  constructor(readonly m: BoardModel, readonly rules: FillRules) {
    this.maxError = rules.maxError || MAX_ERROR;
    this.zones = [];
    for (const it of m.doc.items.values()) if (it.kind === "zone") { const z = readZone(it, m.copper); if (z && z.contours.length) this.zones.push(z); }
    const { loops, polylines } = this.edgeOutline();
    this.edges = polylines;
    this.board = loops.length ? booleanOpD(ClipType.Union, loops.map(toPath), null, FillRule.EvenOdd, PREC) : null;
    let worst = Math.max(rules.minClearance, rules.edgeClearance, rules.holeClearance);
    for (const z of this.zones) worst = Math.max(worst, z.clearance);
    const nets = new Set<string>(); for (const fp of m.footprints) for (const p of fp.pads) nets.add(p.net); for (const z of this.zones) nets.add(z.net); nets.add("");
    for (const n of nets) worst = Math.max(worst, rules.netClearance(n));
    this.worst = worst;
    for (const fp of m.footprints) for (const pad of fp.pads) this.items.push({ kind: "pad", net: pad.net, layers: pad.layers, pad, bbox: this.padBox(pad) });
    for (const v of m.vias) this.items.push({ kind: "via", net: v.net, layers: new Set(v.layers), via: v, bbox: { x0: v.x - v.size / 2, y0: v.y - v.size / 2, x1: v.x + v.size / 2, y1: v.y + v.size / 2 } });
    for (const t of m.tracks) { const r = t.w / 2; const b = t.arc ? { x0: t.arc.cx - t.arc.r - r, y0: t.arc.cy - t.arc.r - r, x1: t.arc.cx + t.arc.r + r, y1: t.arc.cy + t.arc.r + r } : { x0: Math.min(t.x1, t.x2) - r, y0: Math.min(t.y1, t.y2) - r, x1: Math.max(t.x1, t.x2) + r, y1: Math.max(t.y1, t.y2) + r }; this.items.push({ kind: "track", net: t.net || "", layers: new Set([t.layer]), track: t, bbox: b }); }
  }

  private padBox(pad: Pad): Box { const s = Math.max(pad.base.w, pad.base.h, pad.drill ? Math.max(pad.drill.w, pad.drill.h) : 0) + Math.hypot(pad.base.offset[0], pad.base.offset[1]) * 2; let r = s / 2 * Math.SQRT2; for (const sh of pad.stack.values()) r = Math.max(r, Math.max(sh.w, sh.h) / 2 * Math.SQRT2); return { x0: pad.x - r, y0: pad.y - r, x1: pad.x + r, y1: pad.y + r }; }

  /** BOARD::GetBoardPolygonOutlines: the Edge.Cuts drawings chained into closed loops (outline and cutouts). */
  private edgeOutline(): { loops: Pt[][]; polylines: Pt[][] } {
    const prims: Prim[] = []; const knock: Prim[] = [];
    for (const it of this.m.doc.items.values()) {
      if (it.kind === "footprint" || it.kind === "zone") continue;
      for (const g of it.geom) if (g.layer === "Edge.Cuts" && g.t !== "text") geomPrims(Object.assign({}, g, { dash: false, w: 0.001, fill: null }) as KGeom, prims, knock, this.log);
    }
    for (const fp of this.m.footprints) for (const g of fp.item.geom) if (g.layer === "Edge.Cuts" && g.t !== "text" && !g.pad) geomPrims(Object.assign({}, g, { dash: false, w: 0.001, fill: null }) as KGeom, prims, knock, this.log);
    const chains: Pt[][] = [];
    for (const p of prims) {
      if (p.k === "seg") chains.push([[p.x1, p.y1], [p.x2, p.y2]]);
      else if (p.k === "arc") chains.push(arcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, this.maxError));
      else if (p.k === "circle") { const c = circlePoints(p.x, p.y, p.d / 2, this.maxError); chains.push(c.concat([c[0]])); }
      else if (p.k === "region") chains.push(p.pts.concat([p.pts[0]]));
    }
    const tol = 0.001; const same = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
    const open = chains.map((c) => c.slice()); const loops: Pt[][] = [];
    while (open.length) {
      let cur = open.pop() as Pt[];
      let grew = true;
      while (grew && !(cur.length > 2 && same(cur[0], cur[cur.length - 1]))) {
        grew = false; const tail = cur[cur.length - 1];
        for (let i = 0; i < open.length; i++) {
          const c = open[i];
          if (same(c[0], tail)) { cur = cur.concat(c.slice(1)); open.splice(i, 1); grew = true; break; }
          if (same(c[c.length - 1], tail)) { cur = cur.concat(c.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
        }
      }
      if (cur.length > 3 && same(cur[0], cur[cur.length - 1])) loops.push(cur.slice(0, -1));
    }
    return { loops, polylines: chains };
  }

  // ------------------------------------------------------------ item shapes
  private padFlashes(pad: Pad, layer: string): boolean {
    if (!pad.layers.has(layer)) return false;
    const f = this.padFlash.get(pad); if (f && f.has(layer)) return f.get(layer) as boolean;
    return true;
  }
  private viaFlashes(v: Via, layer: string): boolean {
    if (!v.layers.includes(layer)) return false;
    const f = this.padFlash.get(v); if (f && f.has(layer)) return f.get(layer) as boolean;
    return true;
  }
  /** PAD::TransformShapeToPolygon(layer, clearance). */
  private padShape(pad: Pad, layer: string, gap: number): Poly {
    const out: Prim[] = []; padPrims(pad, layer, this.m, out);
    const polys: Pt[][] = []; for (const p of out) for (const q of primPolys(p)) polys.push(q);
    const base = union(shapes(polys));
    return gap > 0 ? inflate(base, gap, true, this.maxError) : base;
  }
  /** PAD::TransformHoleToPolygon. */
  private holeShape(pad: Pad, gap: number): Poly {
    const d = pad.drill; if (!d) return [];
    if (!d.oval || Math.abs(d.w - d.h) < 1e-9) return [shape(circlePoints(pad.x, pad.y, d.w / 2 + gap, this.maxError))];
    const long = Math.max(d.w, d.h), short = Math.min(d.w, d.h); const half = (long - short) / 2;
    const [ax, ay] = d.w > d.h ? rot(-half, 0, pad.rot) : rot(0, -half, pad.rot);
    return [shape(stadium(pad.x + ax, pad.y + ay, pad.x - ax, pad.y - ay, short + 2 * gap))];
  }
  private viaShape(v: Via, layer: string, gap: number): Poly { const d = v.sizes ? v.sizes.get(layer) ?? v.size : v.size; return [shape(circlePoints(v.x, v.y, d / 2 + gap, this.maxError))]; }
  private trackShape(t: Track, gap: number): Poly {
    const w = t.w + 2 * gap; if (!(w > 0)) return [];
    const prims: Prim[] = t.arc && Math.hypot(t.x2 - t.x1, t.y2 - t.y1) > 1e-5 ? [{ k: "arc", cx: t.arc.cx, cy: t.arc.cy, r: t.arc.r, a0: t.arc.a0, a1: t.arc.a1, acw: t.arc.acw, w }] : [{ k: "seg", x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, w }];
    const polys: Pt[][] = []; for (const p of prims) for (const q of primPolys(p)) polys.push(q);
    return shapes(polys);
  }
  private padShapeName(pad: Pad, layer: string): string { return padShapeOn(pad, layer, this.m.copper).shape; }

  // ------------------------------------------------------------ rules
  /** CLEARANCE_CONSTRAINT between the zone and an item (netclasses, local clearances, local overrides, board minimum). */
  private clearance(z: ZoneModel, net: string | null, override: number | null): number {
    const min = this.rules.minClearance || 0;
    if (override !== null && override > 0) return Math.max(override, min);
    let c = this.rules.netClearance(z.net); if (net !== null) c = Math.max(c, this.rules.netClearance(net));
    return Math.max(c, z.clearance, min);
  }
  /** EvalZoneConnection: the pad's own setting, its footprint's, the zone's; THT thermal is thermal for a PTH only. */
  private connection(z: ZoneModel, pad: Pad): string {
    const zc = (n: Node): string | null => { const k = K(n, "zone_connect"); if (!k) return null; return ["NONE", "THERMAL", "FULL", "THT_THERMAL"][num(k[1], 1)] || null; };
    let c = zc(pad.node) || zc(pad.fp.node) || z.connect;
    if (c === "THT_THERMAL") c = pad.type === "thru_hole" ? "THERMAL" : "FULL";
    return c;
  }
  private thermalGap(z: ZoneModel, pad: Pad | null): number { if (pad) { const g = K(pad.node, "thermal_gap"); if (g && num(g[1]) > 0) return num(g[1]); } return z.thermalGap; }
  private spokeWidth(z: ZoneModel, pad: Pad | null): number {
    if (pad) { const g = K(pad.node, "thermal_bridge_width") || K(pad.node, "thermal_width"); if (g && num(g[1]) > 0) return Math.max(num(g[1]), z.minThickness); }
    return z.spokeWidth;
  }
  private spokeAngle(pad: Pad): number {
    const a = K(pad.node, "thermal_bridge_angle"); if (a) return num(a[1]);
    const s = pad.base.shape; return s === "circle" || (s === "custom" && pad.base.anchor === "circle") ? 45 : 90;
  }

  // ------------------------------------------------------------ Fill()
  /** The fills of `toFill` (every board zone when null): zone id → per-layer outlines and island flags. */
  async fill(toFill: string[] | null, prog?: FillProgress): Promise<ZoneFillResult[] | null> {
    const zones = this.zones.filter((z) => !z.ruleArea && z.contours.length && (!toFill || toFill.includes(z.id)));
    const copperSet = new Set(this.m.copper);
    prog && prog.phase(1, "Building zone fills...");
    this.conditionalFlashing();
    // the existing fills of zones left alone are what the refilled ones knock out
    for (const z of this.zones) if (!zones.includes(z) && !z.ruleArea) this.fills.set(z, new Map(z.stored));
    const work: { z: ZoneModel; layer: string }[] = [];
    for (const z of zones) for (const l of z.layers) if (copperSet.has(l) || !isCopper(l)) work.push({ z, layer: l });
    // a zone waits for every higher-priority zone it can touch
    work.sort((a, b) => (a.z === b.z ? 0 : higherPriority(a.z, b.z) ? -1 : 1));
    let done = 0;
    for (const w of work) {
      if (prog) { if (prog.cancelled()) return null; await prog.yield(); }
      const polys = this.fillSingleZone(w.z, w.layer);
      let map = this.fills.get(w.z); if (!map) { map = new Map(); this.fills.set(w.z, map); }
      map.set(w.layer, polys);
      prog && prog.advance(++done, work.length);
    }
    if (prog) { if (prog.cancelled()) return null; prog.phase(2, "Removing isolated copper islands..."); await prog.yield(); }
    const results: ZoneFillResult[] = [];
    const islandsOf = this.isolatedIslands(zones);
    for (const z of zones) {
      const res: ZoneFillResult = { id: z.id, layers: [] };
      const zoneIslands = islandsOf.get(z) || new Map<string, Set<number>>();
      // a zone with no pad connection on any layer is a deliberately unconnected pour: kept as it is
      let allIsolated = true;
      for (const l of z.layers) { if (!isCopper(l)) continue; const polys = this.fillOutlines(z, l); const iso = zoneIslands.get(l); if (!polys.length) continue; if (!iso || iso.size !== polys.length) allIsolated = false; }
      for (const l of z.layers) {
        let outlines = this.fillOutlines(z, l); const iso = zoneIslands.get(l) || new Set<number>(); const flags = new Set<number>();
        if (isCopper(l) && !allIsolated && iso.size) {
          const keep: Pt[][] = [];
          outlines.forEach((o, i) => {
            if (!iso.has(i)) { keep.push(o); return; }
            const a = Math.abs(signedArea(toPath(o)));
            if (z.islandMode === 0) return;
            if (z.islandMode === 2 && a < z.islandAreaMin) return;
            flags.add(keep.length); keep.push(o);
          });
          outlines = keep;
        }
        res.layers.push({ layer: l, outlines, islands: flags });
      }
      // islands outside the board edge (a chamfer or fillet can put copper there)
      if (this.mayHoldOutOfBoardCopper(z)) {
        const minArea = z.minThickness * z.minThickness * 3;
        for (const lf of res.layers) {
          if (!isCopper(lf.layer)) continue;
          const keep: Pt[][] = []; const flags = new Set<number>();
          lf.outlines.forEach((o, i) => {
            const a = Math.abs(signedArea(toPath(o)));
            if (a >= minArea && this.board && polyArea(intersect(this.board, [shape(o)])) < a / 2) return;
            if (lf.islands.has(i)) flags.add(keep.length); keep.push(o);
          });
          lf.outlines = keep; lf.islands = flags;
        }
      }
      results.push(res);
    }
    prog && prog.phase(3, "");
    return results;
  }

  private readonly outlineCache = new Map<Poly, Pt[][]>();
  private fillOutlines(z: ZoneModel, layer: string): Pt[][] {
    const f = this.fills.get(z); const p = f ? f.get(layer) : null; if (!p) return [];
    let o = this.outlineCache.get(p); if (!o) { o = fractured(p); this.outlineCache.set(p, o); }
    return o;
  }

  private mayHoldOutOfBoardCopper(z: ZoneModel): boolean { if (!this.board) return true; if (z.teardrop) return false; return z.smoothing === "chamfer" || z.smoothing === "fillet"; }

  /** The first pass of Fill(): which conditionally flashed pads and vias a zone will reach. */
  private conditionalFlashing(): void {
    const first = this.m.copper[0], last = this.m.copper[this.m.copper.length - 1];
    const keepoutAt = (layer: string, x: number, y: number): boolean => this.zones.some((z) => z.ruleArea && z.noFills && z.layers.includes(layer) && contains(z.outline, x, y));
    const best = (layer: string, net: string, test: (z: ZoneModel) => boolean): ZoneModel | null => {
      let sameNet: ZoneModel | null = null, any: ZoneModel | null = null;
      for (const z of this.zones) {
        if (z.ruleArea || !z.layers.includes(layer) || z.contours.length === 0 || !test(z)) continue;
        if (z.net === net && (!sameNet || higherPriority(z, sameNet))) sameNet = z;
        if (!any || higherPriority(z, any)) any = z;
      }
      return sameNet || any;
    };
    const trackEnds = new Map<string, Pt[]>();
    for (const t of this.m.tracks) { const l = trackEnds.get(t.layer) || []; l.push([t.x1, t.y1], [t.x2, t.y2]); trackEnds.set(t.layer, l); }
    const trackAt = (layer: string, x: number, y: number, r: number): boolean => (trackEnds.get(layer) || []).some((p) => Math.hypot(p[0] - x, p[1] - y) <= r);
    for (const v of this.m.vias) {
      if (!v.removeUnused) continue;
      const map = new Map<string, boolean>(); const vFirst = v.layers[0], vLast = v.layers[v.layers.length - 1];
      for (const l of v.layers) {
        if (v.keepEnds && (l === vFirst || l === vLast)) continue;
        if (trackAt(l, v.x, v.y, (v.sizes ? v.sizes.get(l) ?? v.size : v.size) / 2)) continue;   // ConditionallyFlashed is false when a track connects
        if (keepoutAt(l, v.x, v.y)) { map.set(l, false); continue; }
        const z = best(l, v.net, (zz) => contains(zz.outline, v.x, v.y, v.drill / 2 + 0.000001));
        map.set(l, !!(z && z.net === v.net && (!v.keepEnds || l === vFirst || l === vLast || true)));
      }
      this.padFlash.set(v, map);
    }
    for (const fp of this.m.footprints) for (const pad of fp.pads) {
      if (!pad.removeUnused || pad.type !== "thru_hole") continue;
      const map = new Map<string, boolean>();
      for (const l of pad.layers) {
        if (!isCopper(l)) continue;
        if (pad.keepEnds && (l === first || l === last)) continue;
        if (pad.zoneLayers.has(l)) continue;
        if (trackAt(l, pad.x, pad.y, Math.max(pad.base.w, pad.base.h) / 2)) continue;
        if (keepoutAt(l, pad.x, pad.y)) { map.set(l, false); continue; }
        const z = best(l, pad.net, (zz) => contains(zz.outline, pad.x, pad.y));
        map.set(l, !!(z && z.net === pad.net));
      }
      this.padFlash.set(pad, map);
    }
  }

  // ------------------------------------------------------------ fillSingleZone / BuildSmoothedPoly
  private fillSingleZone(z: ZoneModel, layer: string): Poly {
    const { maxExtents, smoothed } = this.buildSmoothedPoly(z, layer);
    if (isCopper(layer)) return this.fillCopperZone(z, layer, smoothed, maxExtents);
    return this.fillNonCopperZone(z, layer, smoothed);
  }

  private smooth(z: ZoneModel, a: Poly): Poly {
    if (!z.smoothing || !(z.radius > 0) || z.teardrop) return a;
    const out: Pt[][] = [];
    for (const p of a) { const pts = p.map((q) => [q.x, q.y] as Pt); const s = chamferFillet(pts, z.smoothing === "fillet", z.radius, this.maxError); if (s.length >= 3) out.push(s); }
    // keep each contour's winding (holes stay holes)
    return booleanOpD(ClipType.Union, out.map(toPath), null, FillRule.NonZero, PREC);
  }

  buildSmoothedPoly(z: ZoneModel, layer: string): { maxExtents: Poly; smoothed: Poly } {
    const flattened = z.outline;
    const smoothReq = !!z.smoothing && !z.teardrop;
    const maxExt = flattened;
    let poly = flattened;
    const eps = 0.001; const bb = grow(z.bbox, eps);
    const sameNet: ZoneModel[] = [], diffNet: ZoneModel[] = [];
    for (const c of this.zones) {
      if (c === z || !c.layers.includes(layer) || c.ruleArea || c.teardrop || !hits(c.bbox, bb)) continue;
      if (c.net === z.net) { if (collide(z.outline, c.outline)) sameNet.push(c); }
      else if (collide(z.outline, c.outline)) diffNet.push(c);
    }
    for (const s of sameNet) {
      let diff: Poly = [];
      for (const d of diffNet) if (higherPriority(d, s) && hits(d.bbox, s.bbox)) diff = union(diff, d.outline);
      let isolated = false;
      if (diff.length) isolated = subtract(z.outline, diff).length === 0;
      if (!isolated) poly = union(poly, s.outline);
    }
    if (this.board) poly = intersect(poly, this.board);
    const withSameNet = poly;
    poly = smoothReq ? this.smooth(z, poly) : poly;
    let apron = inflate(maxExt, z.minThickness, true, this.maxError);
    apron = intersect(apron, withSameNet);
    const smoothed = intersect(poly, apron);
    const maxExtents = intersect(poly, maxExt);
    return { maxExtents, smoothed };
  }

  // ------------------------------------------------------------ knockouts
  private knockoutThermalReliefs(z: ZoneModel, layer: string, fill: Poly, thermal: (Pad | Via)[], noConn: Pad[], solid: Via[]): Poly {
    const holes: Pt[][] = []; let holesP: Poly = [];
    const zb = grow(z.bbox, this.worst); const seen = new Set<string>();
    const hatch = !!z.hatch;
    for (const it of this.items) {
      if (it.kind !== "pad" || !it.pad) continue;
      const pad = it.pad;
      const npthWithHole = pad.type === "np_thru_hole" && !!pad.drill && pad.drill.w > 0;
      if (!pad.layers.has(layer) && !npthWithHole) continue;
      if (!hits(grow(it.bbox, this.worst), z.bbox) && !hits(it.bbox, zb)) continue;
      const sh = padShapeOn(pad, layer, this.m.copper);
      if (sh.shape !== "custom") {
        const eff = sh.shape === "circle" ? Math.max(sh.w, sh.h, pad.drill ? Math.max(pad.drill.w, pad.drill.h) : 0) : 0;
        const key = [pad.x.toFixed(6), pad.y.toFixed(6), eff ? eff : sh.w, eff ? eff : sh.h, sh.shape, pad.rot, pad.net].join("|");
        if (seen.has(key)) continue; seen.add(key);
      }
      let noConnection = pad.net !== z.net;
      if (!z.teardrop && (z.net === "" || this.padFlash.get(pad)?.get(layer) === false)) noConnection = true;
      if (noConnection) { noConn.push(pad); continue; }
      let conn = z.teardrop ? "FULL" : this.connection(z, pad);
      if (conn === "THERMAL" && !this.padFlashes(pad, layer)) conn = "NONE";
      if (conn === "THERMAL") {
        if (collide(fill, this.padShape(pad, layer, 0))) { thermal.push(pad); holesP = holesP.concat(this.padShape(pad, layer, this.thermalGap(z, pad))); }
      } else if (conn === "NONE") {
        if (hatch) { noConn.push(pad); continue; }
        const padClr = Math.max(z.clearance, 0);
        if (this.padFlashes(pad, layer)) holesP = holesP.concat(this.padShape(pad, layer, padClr));
        else if (pad.drill && pad.drill.w > 0) holesP = holesP.concat(this.holeShape(pad, Math.max(this.rules.holeClearance, padClr)));
      }
    }
    if (hatch) {
      const seenV = new Set<string>();
      for (const v of this.m.vias) {
        if (!v.layers.includes(layer)) continue;
        const vb = { x0: v.x - v.size / 2 - this.worst, y0: v.y - v.size / 2 - this.worst, x1: v.x + v.size / 2 + this.worst, y1: v.y + v.size / 2 + this.worst };
        if (!hits(vb, z.bbox)) continue;
        const key = [v.x.toFixed(6), v.y.toFixed(6), Math.max(v.drill, v.size), v.net].join("|"); if (seenV.has(key)) continue; seenV.add(key);
        let noConnection = v.net !== z.net;
        if (this.padFlash.get(v)?.get(layer) === false) noConnection = true;
        if (noConnection) continue;
        const gap = z.thermalGap;   // EvalZoneConnection on a via: the zone's own setting
        // EvalZoneConnection for a via is the zone's own setting; THT thermal is solid for anything but a PTH pad
        if (z.connect === "THERMAL") { if (gap > 0) { thermal.push(v); holesP = holesP.concat(this.viaShape(v, layer, gap)); } }
        else if (z.connect === "NONE") { /* buildCopperItemClearances */ }
        else solid.push(v);
      }
    }
    if (holes.length) holesP = holesP.concat(shapes(holes));
    return holesP.length ? subtract(fill, union(holesP)) : fill;
  }

  private buildCopperItemClearances(z: ZoneModel, layer: string, noConn: Pad[]): Poly {
    const out: Poly[] = []; const extra = EXTRA_MARGIN;
    const zb = grow(z.bbox, this.worst + extra);
    const seenP = new Set<string>();
    for (const pad of noConn) {
      const sh = padShapeOn(pad, layer, this.m.copper);
      if (sh.shape !== "custom") {
        const eff = sh.shape === "circle" ? Math.max(sh.w, sh.h, pad.drill ? Math.max(pad.drill.w, pad.drill.h) : 0) : 0;
        const key = [pad.x.toFixed(6), pad.y.toFixed(6), eff ? eff : sh.w, eff ? eff : sh.h, sh.shape, pad.rot, pad.net].join("|");
        if (seenP.has(key)) continue; seenP.add(key);
      }
      // knockoutPadClearance
      const initGap = -1;
      let gap = initGap;
      const hasHole = !!pad.drill && pad.drill.w > 0;
      const flash = this.padFlashes(pad, layer) && pad.layers.has(layer);
      const plated = hasHole && pad.type === "thru_hole";
      const override = padOverride(pad, "clearance");
      if (flash || plated) gap = Math.max(gap, this.clearance(z, pad.net, override));
      if (flash && gap >= 0) {
        // an NPTH pad no larger than its hole has no copper
        const npthBare = pad.type === "np_thru_hole" && pad.drill && ((sh.shape === "circle" && pad.drill.w >= sh.w - 1e-9) || (sh.shape === "oval" && pad.drill.w >= sh.w - 1e-9 && pad.drill.h >= sh.h - 1e-9));
        if (!npthBare) out.push(this.padShape(pad, layer, gap + extra));
      }
      if (hasHole) {
        let holeGap = this.rules.holeClearance || 0;
        if (pad.type === "np_thru_hole") gap = initGap;
        gap = Math.max(gap, holeGap);
        if (gap >= 0) out.push(this.holeShape(pad, gap + extra));
        holeGap = 0;
      }
    }
    const seenT = new Set<string>();
    for (const it of this.items) {
      if (it.kind === "pad" || !it.layers.has(layer) || !hits(it.bbox, zb)) continue;
      if (it.kind === "via" && it.via) {
        const v = it.via; const key = [v.x.toFixed(6), v.y.toFixed(6), Math.max(v.drill, v.size), v.net].join("|"); if (seenT.has(key)) continue; seenT.add(key);
        let sameNet = v.net === z.net; if (!z.teardrop && z.net === "") sameNet = false;
        if (this.padFlash.get(v)?.get(layer) === false) sameNet = false;
        let gap = -1;
        if (!sameNet) gap = Math.max(gap, this.clearance(z, v.net, null));
        if (this.viaFlashes(v, layer) && gap > 0) out.push(this.viaShape(v, layer, gap + extra));
        let holeGap = -1; if (!sameNet) holeGap = Math.max(holeGap, this.rules.holeClearance || 0);
        gap = Math.max(gap, holeGap);
        if (gap >= 0) out.push([shape(circlePoints(v.x, v.y, v.drill / 2 + gap + extra, this.maxError))]);
      } else if (it.track) {
        const t = it.track; const key = [t.x1, t.y1, t.x2, t.y2, t.w].map((x) => x.toFixed(6)).join("|"); if (seenT.has(key)) continue; seenT.add(key);
        let sameNet = it.net === z.net; if (!z.teardrop && z.net === "") sameNet = false;
        let gap = -1; if (!sameNet) gap = Math.max(gap, this.clearance(z, it.net, null));
        if (gap >= 0) out.push(this.trackShape(t, gap + extra));
      }
    }
    // graphic items: copper drawings and text on the layer, and the board edge
    const gfxGap = Math.max(-1, this.clearance(z, null, null));
    const edgeGap = Math.max(-1, this.rules.edgeClearance);
    const addGeom = (g: KGeom, gap: number): void => {
      if (gap < 0) return;
      if (g.t === "text") { if (g.hiddenText) return; const polys = textKnockout(g, g.knockout ? 0 : gap + extra, this.log); if (polys.length) out.push(shapes(polys)); return; }
      const prims: Prim[] = [], knock: Prim[] = [];
      geomPrims(Object.assign({}, g, { dash: false }) as KGeom, prims, knock, this.log, gap + extra);
      const polys: Pt[][] = []; for (const p of prims) for (const q of primPolys(p)) polys.push(q);
      if (polys.length) out.push(union(shapes(polys)));
    };
    for (const it of this.m.doc.items.values()) {
      const k = it.kind;
      if (k === "footprint" || k === "segment" || k === "arc" || k === "via" || k === "zone" || k === "image" || k === "group" || k === "point" || k === "generated") continue;
      if (it.bbox && !hits({ x0: it.bbox[0], y0: it.bbox[1], x1: it.bbox[2], y1: it.bbox[3] }, zb)) continue;
      const netN = K(it.node as Node, "net"); const gnet = netN ? (typeof netN[1] === "number" ? (this.m.doc.nets.get(netN[1] as number) || "") : str(netN[1])) : null;
      for (const g of it.geom) {
        if (g.point) continue;
        if (g.layer === layer) { const same = gnet !== null && gnet === z.net && z.net !== ""; addGeom(g, same ? -1 : gfxGap); }
        else if (g.layer === "Margin") addGeom(g, Math.max(gfxGap, edgeGap));
      }
    }
    for (const fp of this.m.footprints) {
      for (const g of footprintGeoms(fp, layer, { plotReference: true, plotValue: true, subtractMaskFromSilk: false })) {
        if (g.hiddenText) continue;
        // net-tie graphics touching a same-net pad are part of the net
        if (has(fp.node, "net_tie_pad_groups") || K(fp.node, "net_tie_pad_groups")) continue;
        addGeom(g, gfxGap);
      }
    }
    // the board edge: its centre line grown by the copper-to-edge clearance (line widths ignored)
    if (edgeGap >= 0) {
      const gap = edgeGap + extra; const polys: Pt[][] = [];
      for (const c of this.edges) { if (!c.length) continue; const b = c.reduce((bx, p) => ({ x0: Math.min(bx.x0, p[0]), y0: Math.min(bx.y0, p[1]), x1: Math.max(bx.x1, p[0]), y1: Math.max(bx.y1, p[1]) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }); if (!hits(grow(b, gap), zb)) continue; for (let i = 0; i + 1 < c.length; i++) polys.push(stadium(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1], 2 * gap)); }
      if (polys.length) out.push(union(shapes(polys)));
    }
    // rule areas that keep copper pours out (outline, no clearance), before the min-width cycle
    for (const k of this.zones) if (k.ruleArea && k.noFills && k.layers.includes(layer) && hits(k.bbox, z.bbox) && !z.teardrop) out.push(k.outline);
    return union(out.flat());
  }

  /** buildDifferentNetZoneClearances: higher-priority zones of other nets, as filled, grown by the clearance. */
  private differentNetZoneClearances(z: ZoneModel, layer: string): Poly {
    const out: Poly[] = [];
    for (const k of this.zones) {
      if (k === z || k.ruleArea || k.teardrop || !k.layers.includes(layer)) continue;
      if (!higherPriority(k, z) || k.net === z.net) continue;
      const reach = this.worst + z.minThickness;
      if (!hits(grow(z.bbox, reach), k.bbox) || !collide(z.outline, k.outline, reach)) continue;
      const f = this.fills.get(k); const fp = f ? f.get(layer) : null; if (!fp || !fp.length) continue;
      const gap = Math.max(-1, this.clearance(z, k.net, null), k.clearance);
      if (gap < 0) continue;
      out.push(inflate(fp, gap + EXTRA_MARGIN, true, this.maxError));
    }
    return union(out.flat());
  }

  private subtractHigherPriorityZones(z: ZoneModel, layer: string, fill: Poly): Poly {
    const ko: Poly[] = [];
    for (const k of this.zones) if (k !== z && !k.ruleArea && !k.teardrop && k.net === z.net && k.priority > z.priority && k.layers.includes(layer) && hits(k.bbox, z.bbox)) ko.push(k.outline);
    return ko.length ? subtract(fill, union(ko.flat())) : fill;
  }

  // ------------------------------------------------------------ thermal spokes
  private buildThermalSpokes(z: ZoneModel, layer: string, items: (Pad | Via)[]): Pt[][] {
    const spokes: Pt[][] = [];
    const halfW = (z.hatch ? z.hatch.thickness : z.minThickness) / 2;
    const eps = this.maxError;
    for (const item of items) {
      const isVia = !(item as Pad).fp;
      const pad = isVia ? null : item as Pad, via = isVia ? item as Via : null;
      let gap: number, spokeW: number, circular: boolean;
      if (pad) {
        if (!pad.layers.has(layer)) continue;
        const sh = padShapeOn(pad, layer, this.m.copper);
        circular = sh.shape === "circle" || (sh.shape === "oval" && Math.abs(sh.w - sh.h) < 1e-9);
        gap = this.thermalGap(z, pad); spokeW = Math.min(this.spokeWidth(z, pad), Math.min(sh.w, sh.h));
        if (spokeW < z.minThickness) continue;
      } else if (via && z.hatch) {
        circular = true; gap = z.thermalGap; spokeW = Math.min(z.spokeWidth, via.sizes ? via.sizes.get(layer) ?? via.size : via.size);
        if (spokeW < z.minThickness) continue;
      } else continue;
      const half = spokeW / 2;
      // the pad's box in its own frame, centred on the shape (not the hole)
      let bw: number, bh: number, cx: number, cy: number, orient = 0, angle = 0;
      if (pad) {
        const sh = padShapeOn(pad, layer, this.m.copper);
        if (sh.shape === "custom") { const polys = this.padShape(pad, layer, 0); const b = bboxOf(polys.map((p) => p.map((q) => { const [x, y] = rot(q.x - pad.x, q.y - pad.y, -pad.rot); return { x, y }; }))); bw = Math.max(Math.abs(b.x0 - sh.offset[0]), Math.abs(b.x1 - sh.offset[0])) * 2; bh = Math.max(Math.abs(b.y0 - sh.offset[1]), Math.abs(b.y1 - sh.offset[1])) * 2; }
        else { bw = sh.w + Math.abs(sh.delta[1]); bh = sh.h + Math.abs(sh.delta[0]); }
        const [ox, oy] = rot(sh.offset[0], sh.offset[1], pad.rot); cx = pad.x + ox; cy = pad.y + oy; orient = pad.rot; angle = this.spokeAngle(pad);
      } else { const d = (via as Via).sizes ? (via as Via).sizes!.get(layer) ?? (via as Via).size : (via as Via).size; bw = bh = d; cx = (via as Via).x; cy = (via as Via).y; }
      const infl = gap + eps + halfW;
      const hx = bw / 2 + infl, hy = bh / 2 + infl;
      const build = (base: number): Pt[][] => {
        const out: Pt[][] = [];
        for (const k of [0, 90, 180, 270]) {
          const a = (k + base) * Math.PI / 180; let dx = Math.cos(a), dy = Math.sin(a);
          if (Math.abs(dx) < 1e-12) dx = 0; if (Math.abs(dy) < 1e-12) dy = 0;
          let side: Pt, end: Pt;
          if (dx === 0) { side = [half, 0]; end = [0, dy * hy]; }
          else if (dy === 0) { side = [0, half]; end = [dx * hx, 0]; }
          else {
            const distX = hx / Math.abs(dx), distY = hy / Math.abs(dy);
            if (distX < distY) { side = [0, half / Math.sin(Math.PI / 2 - a)]; end = [dx * distX, dy * distX]; }
            else { side = [half / Math.sin(a), 0]; end = [dx * distY, dy * distY]; }
          }
          out.push([[side[0], side[1]], [-side[0], -side[1]], [end[0] - side[0], end[1] - side[1]], [end[0], end[1]], [end[0] + side[0], end[1] + side[1]]]);
        }
        return out;
      };
      let four: Pt[][];
      if (circular) { four = build(0); if (angle) four = four.map((s) => s.map((p) => rot(p[0], p[1], angle))); }
      else four = build(angle);
      for (const s of four) spokes.push(s.map((p) => { const [x, y] = rot(p[0], p[1], orient); return [cx + x, cy + y] as Pt; }));
    }
    return spokes;
  }

  // ------------------------------------------------------------ fillCopperZone
  private fillCopperZone(z: ZoneModel, layer: string, smoothed: Poly, maxExtents: Poly): Poly {
    const halfMin = z.minThickness / 2; const eps = EPSILON; const prune = halfMin - eps > eps;
    const thermal: (Pad | Via)[] = [], noConn: Pad[] = [], solidVias: Via[] = [];
    let fill = smoothed;
    fill = this.knockoutThermalReliefs(z, layer, fill, thermal, noConn, solidVias);
    let rings: Poly = [];
    if (z.hatch) { const r = this.hatchThermalRings(z, layer, smoothed, thermal); rings = r; if (r.length) fill = union(fill, r); }
    const clearanceHoles = this.buildCopperItemClearances(z, layer, noConn);
    const spokes = this.buildThermalSpokes(z, layer, thermal);
    const zoneClr = this.differentNetZoneClearances(z, layer);
    if (spokes.length) {
      // Only the copper near a spoke's end can decide it, and an opening by r looks no further than 2r from a
      // point: the test area is built inside squares of that reach around the ends (the same answer as the whole
      // zone, without deflating and re-inflating all of it).
      const reach = 2 * Math.max(halfMin - eps, 0) + 0.05;
      const windows = shapes(spokes.map((sp) => { const [x, y] = sp[3]; return [[x - reach, y - reach], [x + reach, y - reach], [x + reach, y + reach], [x - reach, y + reach]] as Pt[]; }));
      let test = intersect(fill, union(windows));
      test = subtract(test, clearanceHoles); if (zoneClr.length) test = subtract(test, zoneClr);
      if (prune) test = inflate(inflate(test, -(halfMin - eps), false, this.maxError), halfMin - eps, false, this.maxError);
      const keep: Pt[][] = [];
      const spokePaths = spokes.map(toPath);
      spokes.forEach((s, i) => {
        const tp = s[3];
        if (contains(test, tp[0], tp[1], 0.000001)) { keep.push(s); return; }
        for (let j = 0; j < spokes.length; j++) if (j !== i && inPath(spokePaths[j], tp[0], tp[1]) && inPath(spokePaths[i], spokes[j][3][0], spokes[j][3][1])) { keep.push(s); return; }
      });
      if (keep.length) fill = union(fill, shapes(keep));
    }
    fill = subtract(fill, clearanceHoles);
    if (prune) { fill = inflate(fill, -(halfMin - eps), false, this.maxError); if (rings.length) rings = inflate(rings, -(halfMin - eps), false, this.maxError); }
    // blobs narrower than min thickness on both axes go
    fill = fromPolygons(polygonsOf(fill).filter((pg) => { const b = bboxOf([pg[0]]); return Math.max(b.x1 - b.x0, b.y1 - b.y0) >= z.minThickness; }));
    if (z.hatch) {
      const discs: Poly = []; for (const v of solidVias) if (v.layers.includes(layer)) for (const d of this.viaShape(v, layer, 0)) discs.push(d);
      const protect = union(union(rings, clearanceHoles), discs.length ? intersect(union(discs), smoothed) : []);
      fill = this.addHatch(z, layer, fill, protect);
    }
    if (prune) fill = inflate(fill, halfMin - eps, true, this.maxError);
    if (rings.length) fill = union(fill, rings);
    const padHoles: Poly = []; for (const it of thermal) if ((it as Pad).fp) for (const h of this.holeShape(it as Pad, 0)) padHoles.push(h);
    const holes = padHoles.length ? union(clearanceHoles, padHoles) : clearanceHoles;
    fill = intersect(fill, maxExtents);
    fill = subtract(fill, holes);
    // iterative-refill path (ADVANCED_CFG::m_ZoneFillIterativeRefill, on by default): the other-net zones last
    if (zoneClr.length) {
      let apron = subtract(subtract(smoothed, maxExtents), holes);
      fill = subtract(fill, zoneClr); apron = subtract(apron, zoneClr);
      fill = this.postKnockoutMinWidthPrune(z, fill, apron);
    }
    fill = this.subtractHigherPriorityZones(z, layer, fill);
    // dropSubResolutionOutlines
    const noise = this.maxError * this.maxError;
    fill = fromPolygons(polygonsOf(fill).filter((pg) => Math.abs(signedArea(pg[0])) >= noise));
    return fill;
  }

  private postKnockoutMinWidthPrune(z: ZoneModel, fill: Poly, apron: Poly): Poly {
    const half = z.minThickness / 2, eps = EPSILON; if (half - eps <= eps) return fill;
    const pre = fill;
    let f = fill;
    if (apron.length) f = union(f, inflate(apron, eps, true, this.maxError));
    f = inflate(f, -(half - eps), false, this.maxError);
    f = fromPolygons(polygonsOf(f).filter((pg) => { const b = bboxOf([pg[0]]); return Math.max(b.x1 - b.x0, b.y1 - b.y0) >= z.minThickness; }));
    f = inflate(f, half - eps, true, this.maxError);
    return intersect(f, pre);
  }

  // ------------------------------------------------------------ hatch
  private hatchThermalRings(z: ZoneModel, layer: string, smoothed: Poly, items: (Pad | Via)[]): Poly {
    const all: Poly = [];
    for (const item of items) {
      const pad = (item as Pad).fp ? item as Pad : null, via = pad ? null : item as Via;
      let ring: Poly;
      if (pad) {
        if (!pad.layers.has(layer)) continue;
        const sh = padShapeOn(pad, layer, this.m.copper);
        const circ = sh.shape === "circle" || (sh.shape === "oval" && Math.abs(sh.w - sh.h) < 1e-9);
        const gap = this.thermalGap(z, pad); const sw = Math.min(this.spokeWidth(z, pad), Math.min(sh.w, sh.h));
        if (sw < z.minThickness) continue;
        if (circ) { const [ox, oy] = rot(sh.offset[0], sh.offset[1], pad.rot); const r = Math.max(sh.w, sh.h) / 2; ring = subtract([shape(circlePoints(pad.x + ox, pad.y + oy, r + gap + sw, this.maxError))], [shape(circlePoints(pad.x + ox, pad.y + oy, r + gap, this.maxError))]); }
        else ring = subtract(this.padShape(pad, layer, gap + sw), this.padShape(pad, layer, gap));
      } else if (via) {
        const d = via.sizes ? via.sizes.get(layer) ?? via.size : via.size; const sw = Math.min(z.spokeWidth, d); if (sw < z.minThickness) continue;
        const r = d / 2 + z.thermalGap; ring = subtract([shape(circlePoints(via.x, via.y, r + sw, this.maxError))], [shape(circlePoints(via.x, via.y, r, this.maxError))]);
      } else continue;
      for (const r of ring) all.push(r);
    }
    return all.length ? intersect(union(all), smoothed) : [];
  }

  /** ZONE_FILLER::addHatchFillTypeOnZone. */
  private addHatch(z: ZoneModel, layer: string, fill: Poly, rings: Poly): Poly {
    const h = z.hatch as ZoneHatch;
    const thickness = Math.max(h.thickness, z.minThickness + 0.001);
    const grid = thickness + h.gap;
    let maxError = this.maxError;
    const orient = h.orientation;
    const rotP = (a: Poly, deg: number): Poly => a.map((p) => p.map((q) => { const [x, y] = rot(q.x, q.y, deg); return { x, y }; }));
    const filled = orient ? rotP(fill, -orient) : fill;
    if (!filled.length) return fill;
    const bb = bboxOf(filled);
    const holeSize = h.gap + z.minThickness;
    let holeBase: Pt[] = [[0, 0], [holeSize, 0], [holeSize, holeSize], [0, holeSize]];
    const minimalHoleArea = holeSize * holeSize * h.minHoleArea;
    if (h.smoothingLevel > 0) {
      let sv = h.gap * h.smoothingValue / 2;
      if (sv > 0.02) {
        let level = h.smoothingLevel;
        if (sv < 0.04 && level > 1) level = 1;
        sv += z.minThickness / 2; sv = Math.min(sv, h.gap / 2);
        maxError = Math.max(maxError * 2, sv / 20);
        if (level === 1) holeBase = chamferFillet(holeBase, false, sv);
        else { if (h.smoothingLevel > 2) maxError /= 2; holeBase = chamferFillet(holeBase, true, sv, maxError); }
      }
    }
    const off = h.offsets.get(layer) || [0, 0];
    const mod = (a: number, b: number): number => a - b * Math.trunc(a / b);
    const x0 = bb.x0 - mod(bb.x0, grid) - grid, y0 = bb.y0 - mod(bb.y0, grid) - grid;
    const holes: PathD[] = [];
    for (let xx = x0; xx <= bb.x1; xx += grid) for (let yy = y0; yy <= bb.y1; yy += grid) {
      holes.push(shape(holeBase.map((p) => { let x = p[0] + xx, y = p[1] + yy; if (orient) [x, y] = rot(x, y, orient); return [x + mod(off[0], grid), y + mod(off[1], grid)] as Pt; })));
    }
    let deflatedThickness = h.thickness - z.minThickness; deflatedThickness = Math.max(deflatedThickness, maxError * 2);
    let clipped = intersect(holes, inflate(fill, -deflatedThickness, false, maxError));
    clipped = intersect(clipped, inflate(z.outline, -z.minThickness, false, maxError));
    let polys = polygonsOf(clipped).filter((pg) => Math.abs(signedArea(pg[0])) >= minimalHoleArea);
    if (rings.length) {
      const rb = bboxOf(rings); const ringPolys = polygonsOf(rings);
      polys = polys.filter((pg) => {
        const hb = bboxOf([pg[0]]); if (!hits(hb, rb)) return true;
        for (const rp of ringPolys) {
          const b = bboxOf([rp[0]]); if (!(hb.x0 <= b.x0 && hb.y0 <= b.y0 && hb.x1 >= b.x1 && hb.y1 >= b.y1)) continue;
          if (!inPath(pg[0], (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) || !inPath(pg[0], rp[0][0].x, rp[0][0].y)) continue;
          if (intersect([pg[0]], [rp[0]]).length && polyArea(intersect([pg[0]], [rp[0]])) < Math.abs(signedArea(rp[0])) - 1e-9) continue;
          return false;
        }
        return true;
      });
    }
    return subtract(fill, fromPolygons(polys));
  }

  // ------------------------------------------------------------ non-copper
  private fillNonCopperZone(z: ZoneModel, layer: string, smoothed: Poly): Poly {
    const holes: Poly[] = [];
    const take = (g: KGeom): void => {
      if (!g.knockout || g.layer !== layer) return;
      if (g.t === "text") { const p = textKnockout(g, 0, this.log); if (p.length) holes.push(shapes(p)); return; }
      const prims: Prim[] = [], knock: Prim[] = []; geomPrims(g, prims, knock, this.log, 0);
      const polys: Pt[][] = []; for (const p of prims) for (const q of primPolys(p)) polys.push(q); if (polys.length) holes.push(shapes(polys));
    };
    for (const fp of this.m.footprints) for (const g of fp.item.geom) take(g);
    for (const it of this.m.doc.items.values()) if (it.kind !== "footprint") for (const g of it.geom) take(g);
    let fill = holes.length ? subtract(smoothed, union(holes.flat())) : smoothed;
    const ko: Poly[] = []; for (const k of this.zones) if (k.ruleArea && k.noFills && k.layers.includes(layer) && hits(k.bbox, z.bbox)) ko.push(k.outline);
    if (ko.length) fill = subtract(fill, union(ko.flat()));
    const half = z.minThickness / 2, eps = EPSILON;
    fill = inflate(fill, -(half - eps), false, this.maxError);
    if (z.hatch) fill = this.addHatch(z, layer, fill, []);
    if (half - eps > eps) fill = inflate(fill, half - eps, true, this.maxError);
    return fill;
  }

  // ------------------------------------------------------------ connectivity (FillIsolatedIslandsMap)
  /**
   * For each zone and copper layer, the indices of fill outlines whose cluster holds no pad. The clusters are
   * CN_CONNECTIVITY_ALGO::SearchClusters( CSM_CONNECTIVITY_CHECK ) over the whole board: a pad or via is one item on
   * every layer it spans, so a fill fragment that reaches a pad only through a via and a track on another layer is
   * not an island.
   */
  private isolatedIslands(zones: ZoneModel[]): Map<ZoneModel, Map<string, Set<number>>> {
    const out = new Map<ZoneModel, Map<string, Set<number>>>();
    // board-wide union-find over items; a pad or via keeps one id across its layers
    const parent: number[] = []; const isPad: boolean[] = [];
    const newId = (pad: boolean): number => { parent.push(parent.length); isPad.push(pad); return parent.length - 1; };
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const ids = new Map<object, number>();
    const idOf = (o: object, pad: boolean): number => { let g = ids.get(o); if (g === undefined) { g = newId(pad); ids.set(o, g); } return g; };
    interface N { g: number; net: string; poly: Poly; anchors: Pt[]; bbox: Box; zone?: ZoneModel; idx?: number; index?: PathIndex }
    const zoneNodes: { n: N; layer: string }[] = [];
    for (const layer of this.m.copper) {
      // nodes on this layer: pads, vias, tracks, and every zone's fill outlines
      const nodes: N[] = [];
      for (const it of this.items) {
        if (!it.layers.has(layer) || !it.net) continue;
        if (it.pad) {
          const p = it.pad; if (!p.layers.has(layer)) continue;
          if (this.padFlash.get(p)?.get(layer) === false) continue;
          const sh = padShapeOn(p, layer, this.m.copper); const [ox, oy] = rot(sh.offset[0], sh.offset[1], p.rot);
          const poly = this.padShape(p, layer, 0); if (!poly.length) continue;
          nodes.push({ g: idOf(p, true), net: p.net, poly, anchors: [[p.x + ox, p.y + oy]], bbox: bboxOf(poly) });
        } else if (it.via) {
          const v = it.via; const g = idOf(v, false);
          if (this.padFlash.get(v)?.get(layer) === false) continue;
          const poly = this.viaShape(v, layer, 0);
          nodes.push({ g, net: v.net, poly, anchors: [[v.x, v.y]], bbox: bboxOf(poly) });
        } else if (it.track) {
          const t = it.track; const poly = this.trackShape(t, 0); if (!poly.length) continue;
          nodes.push({ g: idOf(t, false), net: it.net, poly, anchors: [[t.x1, t.y1], [t.x2, t.y2]], bbox: bboxOf(poly) });
        }
      }
      for (const z of this.zones) {
        if (z.ruleArea || !z.layers.includes(layer) || !z.net) continue;
        const outl = this.fillOutlines(z, layer);
        outl.forEach((o, i) => { const p = [shape(o)]; const index = new PathIndex(p[0]); const n: N = { g: newId(false), net: z.net, poly: p, anchors: [], bbox: index.bbox, zone: z, idx: i, index }; nodes.push(n); zoneNodes.push({ n, layer }); });
      }
      // CN_VISITOR's tests on this layer: anchors in a zone, or the shapes colliding
      const byNet = new Map<string, N[]>(); for (const n of nodes) { const l = byNet.get(n.net) || []; l.push(n); byNet.set(n.net, l); }
      for (const list of byNet.values()) {
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
          const A = list[a], B = list[b];
          if (!hits(A.bbox, B.bbox)) continue;
          if (A.zone && B.zone && A.zone === B.zone) continue;
          if (find(A.g) === find(B.g)) continue;
          let touch = false;
          if (A.zone && B.zone) touch = intersect(A.poly, B.poly).length > 0;
          else if (A.zone || B.zone) {
            // CN_VISITOR::checkZoneItemConnection: an anchor in the fill, else the shapes colliding
            const Z = (A.zone ? A : B).index as PathIndex, I = A.zone ? B : A;
            touch = I.anchors.some((p) => Z.contains(p[0], p[1]));
            if (!touch) for (const path of I.poly) { if (touch) break; for (let k = 0, j = path.length - 1; k < path.length; j = k++) { if (Z.contains(path[k].x, path[k].y) || Z.crosses(path[j].x, path[j].y, path[k].x, path[k].y)) { touch = true; break; } } }
          } else touch = intersect(A.poly, B.poly).length > 0;
          if (touch) join(A.g, B.g);
        }
      }
    }
    // CN_CLUSTER::IsOrphaned: no pad in the cluster
    const withPad = new Set<number>(); isPad.forEach((p, i) => { if (p) withPad.add(find(i)); });
    for (const { n, layer } of zoneNodes) {
      const z = n.zone as ZoneModel; if (!zones.includes(z)) continue;
      let m = out.get(z); if (!m) { m = new Map(); out.set(z, m); }
      let s = m.get(layer); if (!s) { s = new Set(); m.set(layer, s); }
      if (!withPad.has(find(n.g))) s.add(n.idx as number);
    }
    return out;
  }
}

// ---------------------------------------------------------------- writing the result back
const r6 = (v: number): number => { const r = Math.round(v * 1e6) / 1e6; return r === 0 ? 0 : r; };
/**
 * The zone node with its fill replaced: (fill yes …) and one (filled_polygon (layer …) [(island yes)] (pts …)) per
 * outline, layer by layer in the board's layer order, after the outline — where PCB_IO_KICAD_SEXPR writes them.
 */
export function filledZoneNode(node: Node, res: ZoneFillResult, copper: string[], clone: (n: Node) => Node): Node {
  const out = clone(node);
  for (let i = out.length - 1; i > 0; i--) if (Array.isArray(out[i]) && (out[i] as Node)[0] === "filled_polygon") out.splice(i, 1);
  const fill = K(out, "fill");
  if (fill) { if (fill[1] !== "yes") fill.splice(1, 0, "yes"); } else out.push(["fill", "yes"] as unknown as Node);
  const order = (l: string): number => { const i = copper.indexOf(l); return i >= 0 ? i : 1000 + l.charCodeAt(0); };
  const layers = res.layers.slice().sort((a, b) => order(a.layer) - order(b.layer));
  const polys: Node[] = [];
  for (const lf of layers) lf.outlines.forEach((o, i) => {
    const n: unknown[] = ["filled_polygon", ["layer", lf.layer]];
    if (lf.islands.has(i)) n.push(["island", "yes"]);
    n.push(["pts", ...o.map((p) => ["xy", r6(p[0]), r6(p[1])])]);
    polys.push(n as Node);
  });
  let at = -1; for (let i = 1; i < out.length; i++) if (Array.isArray(out[i]) && (out[i] as Node)[0] === "polygon") at = i;
  if (at < 0) { for (let i = 1; i < out.length; i++) if (Array.isArray(out[i]) && (out[i] as Node)[0] === "fill") at = i; }
  out.splice(at + 1, 0, ...polys);
  return out;
}

/** The fill as it stands in a zone node: layer → outlines (for comparing a refill against it). */
export function storedFill(node: Node): Map<string, Pt[][]> {
  const m = new Map<string, Pt[][]>();
  for (const fp of kids(node, "filled_polygon") as Node[]) { const l = K(fp, "layer"); const key = l ? str(l[1]) : ""; const cur = m.get(key) || []; cur.push(polyPtsOf(fp) as Pt[]); m.set(key, cur); }
  return m;
}
export type { Footprint };
