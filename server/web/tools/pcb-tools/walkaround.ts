// pcb-tools/walkaround.ts — the interactive router's Walk around mode and its obstacles.
import type { Box, BoardDoc, Conductor, CopperShape, DesignSettings, LegFn, Obstacle, ObstacleIndex, PadInfo, PolyShape, Pt, RouterWorld, WorldItem } from "./types";
import { copperOf } from "./dialogs";
import { boxesTouch, padShape, polySegDist, rectCore, shapeBBox, shapeGap, shapeOffset } from "./distances";
import { edgeShapes, netClearance } from "./drc";
import { pointInPoly } from "./hit";
import { conductors } from "./netlist";
import { zoneLayers } from "./nodes";
import { padsOf, routeLeg } from "./route-geom";
import { K, S } from "./state";
import { r6, samePt } from "./util";

// ---------------------------------------------------------------- interactive router: KiCad's default Walk around mode
// ROUTING_SETTINGS' defaults (pns_routing_settings.cpp): mode RM_Walkaround, start_diagonal false, auto_posture true,
// no DRC violations allowed.  Every pointer move walks the head line from the last fixed point to the cursor around
// other nets' copper (pads, tracks, arcs, vias), NPTH holes, Edge.Cuts and rule areas that keep tracks out, each
// inflated by the clearance the design rules give the pair plus half the track width.  Zone fills are not obstacles
// (PNS does not model them).  When the cursor cannot be reached the head stops at the reachable point closest to it.
export const ROUTE_EPS = 1e-4;      // a gap this much short of the rule still passes (the router's clearance epsilon)
export const HULL_EPS = 2e-3;       // hull corners sit this far outside the clearance boundary
export const DIRS8 = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2], [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]];
export const octile = (a: Pt, b: Pt) => { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
export function shapeCorePts(s: CopperShape): Pt[] { return s.t === "circle" ? [[s.x, s.y]] : s.t === "seg" ? [s.a, s.b] : s.t === "rect" ? rectCore(s) : s.pts; }

/** The board's copper and other routing obstacles, rebuilt when the document changes. */
export function routerWorld(doc: BoardDoc): RouterWorld {
  if (doc.__bc && doc.__bc.rworld) return doc.__bc.rworld;
  if (!doc.__bc && S.rworld && S.rworld.doc === doc && S.rworld.ver === S.docVer) return S.rworld;
  const copper = copperOf(doc); const conds = conductors(doc).filter((c) => c.kind !== "zone");
  const holes: WorldItem[] = [], keepouts: WorldItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        if (p.type !== "np_thru_hole") continue;
        const d = K.kid(p.node, "drill"); let w = p.w, h = p.h;
        if (d) { if (K.str(d[1]) === "oval") { w = K.num(d[2], w); h = K.num(d[3], w); } else { w = h = K.num(d[1], w); } }
        const shape = padShape(Object.assign({}, p, { w, h, shape: Math.abs(w - h) < 1e-9 ? "circle" : "oval" }));
        holes.push({ id: it.id, kind: "hole", pad: p, layers: new Set(copper), shape, bbox: shapeBBox(shape) });
      }
    } else if (it.kind === "zone" && K.kid(it.node, "keepout")) {
      const ko = K.kid(it.node, "keepout")!; const tr = K.kid(ko, "tracks"); if (!tr || K.str(tr[1]) !== "not_allowed") continue;
      const layers = new Set<string>(); for (const l of zoneLayers(it.node)) { if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => layers.add(c)); else layers.add(l); }
      const poly = K.kid(it.node, "polygon"); const pts = poly ? K.ptsOf(poly) : []; if (pts.length < 3) continue;
      const shape: CopperShape = { t: "poly", pts }; keepouts.push({ id: it.id, kind: "keepout", layers, shape, bbox: shapeBBox(shape) });
    }
  }
  const edges = edgeShapes(doc).shapes.map((shape): WorldItem => ({ id: null, kind: "edge", shape, bbox: shapeBBox(shape) }));
  const W = { doc, ver: S.docVer, conds, holes, keepouts, edges, copper };
  if (doc.__bc) doc.__bc.rworld = W; else { S.rworld = W; S.sworld = null; }
  return W;
}
/** PNS_PCBNEW_RULE_RESOLVER::Clearance for the routed net against an obstacle (the larger netclass clearance, floored at the board minimum). */
export function routeClearance(s: DesignSettings, netKey: string, ob: Pick<Obstacle, "kind" | "net">) {
  const minC = s.minClearance || 0; const mine = Math.max(netClearance(s, netKey), minC);
  if (ob.kind === "edge") return s.edgeClearance || 0;
  if (ob.kind === "hole") return Math.max(s.holeClearance !== undefined ? s.holeClearance : 0.25, mine);
  if (ob.kind === "keepout") return 0;
  return Math.max(mine, netClearance(s, ob.net), minC);
}
/**
 * The obstacles a route on `layer` meets: everything on the layer that is not the routed net's copper.  Pads without a
 * net block every route with a net, free pads block nothing; other net-less copper collides with every route but the
 * route's own items (`own`: the start item and the fixed segments of a route that has no net).
 */
/** PAD::IsFreePad: a pin of type free whose net is still its own "unconnected-(…)" net. */
export function isFreePad(p: PadInfo | null | undefined) {
  const t = p && p.node && K.kid(p.node, "pintype"); const n = p && p.net;
  return !!t && K.str(t[1]) === "free" && !!n && /^(.*\/)?unconnected-\(/.test(n.name || "");
}
export function routeObstacles(doc: BoardDoc, s: DesignSettings, netKey: string, layer: string, own?: Set<string> | null, skip?: Set<string> | null) {
  const W = routerWorld(doc); const out: Obstacle[] = [];
  const take = (o: Conductor | WorldItem, net: string) => { const ob = { id: o.id, kind: o.kind, net: net || "", shape: o.shape, bbox: o.bbox, src: o } as Obstacle; ob.clr = routeClearance(s, netKey, ob); out.push(ob); };
  for (const c of W.conds) {
    if (!c.layers.has(layer) || (skip && skip.has(c.id) && c.kind !== "pad")) continue;
    if (netKey && c.net === netKey) continue;
    // PNS ITEM::collideSimple: a net-less pad is the orphaned net's copper, an obstacle to every routed net (only a
    // net-less route shares its net); a free pad (PAD::IsFreePad) collides with nothing
    if (c.kind === "pad" && (!c.net ? !netKey : isFreePad(c.pad))) continue;
    if (own && own.has(c.id) && c.kind !== "pad") continue;
    take(c, c.net);
  }
  for (const h of W.holes) take(h, "");
  for (const k of W.keepouts) if (k.layers!.has(layer)) take(k, "");
  for (const e of W.edges) take(e, "");
  return indexObstacles(out);
}
/** The obstacle list with a coarse grid so a leg only meets the obstacles near it. */
export function indexObstacles(out: Obstacle[]): ObstacleIndex {
  const CELL = 2.5, grid = new Map<string, number[]>(); let maxClr = 0;
  out.forEach((ob, i: number) => {
    maxClr = Math.max(maxClr, ob.clr); const b = ob.bbox;
    for (let gx = Math.floor((b[0] - ob.clr) / CELL); gx <= Math.floor((b[2] + ob.clr) / CELL); gx++) for (let gy = Math.floor((b[1] - ob.clr) / CELL); gy <= Math.floor((b[3] + ob.clr) / CELL); gy++) {
      const key = gx + "," + gy; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(i);
    }
  });
  return { list: out, grid, CELL, maxClr, stamp: new Uint32Array(out.length), tick: 0 };
}
/** Obstacles whose clearance zone may reach the box [x0, y0, x1, y1] grown by r. */
export function obstaclesNear(O: ObstacleIndex, box: Box, r: number, fn: (ob: Obstacle) => boolean) {
  const C = O.CELL; O.tick++; if (O.tick > 4e9) { O.stamp.fill(0); O.tick = 1; }
  for (let gx = Math.floor((box[0] - r) / C); gx <= Math.floor((box[2] + r) / C); gx++) for (let gy = Math.floor((box[1] - r) / C); gy <= Math.floor((box[3] + r) / C); gy++) {
    const l = O.grid.get(gx + "," + gy); if (!l) continue;
    for (const i of l) { if (O.stamp[i] === O.tick) continue; O.stamp[i] = O.tick; const ob = O.list[i]; if (!boxesTouch(box, ob.bbox, r + ob.clr)) continue; if (fn(ob)) return ob; }
  }
  return null;
}
/** Does a track of half width r along a..b (a point when a === b) violate an obstacle's clearance? */
export function obstacleHit(ob: Obstacle, a: Pt, b: Pt, r: number) {
  const sh: CopperShape = samePt(a, b) ? { t: "circle", x: a[0], y: a[1], r } : { t: "seg", a, b, r };
  if (ob.kind === "keepout") return pointInPoly((ob.shape as PolyShape).pts, a[0], a[1]) || pointInPoly((ob.shape as PolyShape).pts, b[0], b[1]) || polySegDist((ob.shape as PolyShape).pts, a, b) < r - ROUTE_EPS;
  return shapeGap(sh, ob.shape) < ob.clr - ROUTE_EPS;
}
/** The first obstacle a segment hits (null when clear). */
export function segHit(O: ObstacleIndex, a: Pt, b: Pt, r: number) {
  const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  return obstaclesNear(O, box, r, (ob) => obstacleHit(ob, a, b, r));
}
/** Every obstacle a polyline (or one point) at half width r violates. */
export function pathHits(O: ObstacleIndex, pts: Pt[], r: number) {
  const out = new Set<Obstacle>();
  const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(0, -1).map((p: Pt, i: number) => [p, pts[i + 1]]);
  for (const [a, b] of segs) { const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; obstaclesNear(O, box, r, (ob) => { if (!out.has(ob) && obstacleHit(ob, a, b, r)) out.add(ob); return false; }); }
  return Array.from(out);
}
export const pathClear = (O: ObstacleIndex, pts: Pt[], r: number) => { if (pts.length === 1) return !segHit(O, pts[0], pts[0], r); for (let i = 0; i + 1 < pts.length; i++) if (segHit(O, pts[i], pts[i + 1], r)) return false; return true; };
/** The 45° octagon around an obstacle's clearance zone for a track of half width r: where the walk turns. */
export function hullOf(ob: Obstacle, r: number): Pt[] {
  const key = r.toFixed(6); if (ob.hullKey === key) return ob.hull!;
  const core = shapeCorePts(ob.shape), off = (ob.kind === "keepout" ? 0 : shapeOffset(ob.shape) + ob.clr) + r + HULL_EPS;
  const h = DIRS8.map((u) => { let m = -Infinity; for (const p of core) m = Math.max(m, p[0] * u[0] + p[1] * u[1]); return m + off; });
  const out: Pt[] = [];
  for (let k = 0; k < 8; k++) {
    const u0 = DIRS8[k], u1 = DIRS8[(k + 1) % 8], h0 = h[k], h1 = h[(k + 1) % 8]; const det = u0[0] * u1[1] - u0[1] * u1[0];
    out.push([(h0 * u1[1] - h1 * u0[1]) / det, (u0[0] * h1 - u1[0] * h0) / det]);
  }
  ob.hullKey = key; ob.hull = out; return out;
}
/** DIRECTION_45 of a vector: 0 = E, 1 = SE (y down), … 7 = NE; -1 for a null vector. */
export function dir8(a: Pt, b: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1]; if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return -1; return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8; }
/** DIRECTION_45::Angle: 0 straight, 1 obtuse, 2 right, 3 acute, 4 half full (a U-turn). */
export const dirAngle = (d1: number, d2: number) => { const d = Math.abs(d1 - d2) % 8; return d > 4 ? 8 - d : d; };
export const isDiagDir = (d: number) => d >= 0 && d % 2 === 1;
/** A leg as a point list (routeLeg's segments joined). */
export const legPts45 = (a: Pt, b: Pt, diagFirst: boolean) => legPts(a, b, diagFirst);
export function legPts(a: Pt, b: Pt, diagFirst: boolean): Pt[] { const segs = routeLeg(a, b, diagFirst); return segs.length ? [segs[0][0]].concat(segs.map((s) => s[1])) : [a.slice()]; }
/** SHAPE_LINE_CHAIN::Simplify: drop repeated points and merge colinear segments. */
export function simplifyPts(pts: Pt[]) {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    if (out.length >= 2) { const a = out[out.length - 2], b = out[out.length - 1]; if (dir8(a, b) === dir8(b, p) && Math.abs((b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])) < 1e-9) { out[out.length - 1] = p.slice(); continue; } }
    out.push(p.slice());
  }
  return out;
}
/** The point of a polyline at arc length t. */
export function alongPts(pts: Pt[], t: number) {
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (t <= L || i + 2 === pts.length) { const k = L > 0 ? Math.min(1, t / L) : 0; return { i, p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] }; } t -= L; }
  return { i: 0, p: pts[0].slice() };
}
export const ptsLength = (pts: Pt[]) => { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return L; };
/** A clear polyline cut where it first violates clearance (cursorDistMinimum's fallback: the head just stops short). */
export function clipPts(O: ObstacleIndex, pts: Pt[], r: number) {
  if (segHit(O, pts[0], pts[0], r)) return [pts[0].slice()];
  let lo = 0, hi = ptsLength(pts);
  const clearTo = (t: number) => { const { i, p } = alongPts(pts, t); return pathClear(O, pts.slice(0, i + 1).concat([p]), r); };
  if (clearTo(hi)) return pts.map((p: Pt) => p.slice());
  for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (clearTo(m)) lo = m; else hi = m; }
  const { i, p } = alongPts(pts, lo); return simplifyPts(pts.slice(0, i + 1).concat([[r6(p[0]), r6(p[1])]]));
}
/**
 * WALKAROUND: a 45° line from `start` to `goal` that keeps clear of every obstacle.  The posture line comes first;
 * when it is blocked the walk turns at the corners of the obstacles' octagonal hulls (both ways round, the shorter
 * wins), growing the set of obstacles it walks around until the goal is reached.  Returns the points or null.
 */
export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export function walkTo(O: ObstacleIndex, start: Pt, goal: Pt, r: number, diagFirst: boolean, lastDir: number, deadline: number, legFn?: LegFn | null): Pt[] | null {
  deadline = deadline || now() + 40; const legPts = legFn || legPts45;
  const first = legPts(start, goal, diagFirst); if (pathClear(O, first, r)) return first;
  const second = legPts(start, goal, !diagFirst); if (pathClear(O, second, r)) return second;
  const active = new Set(pathHits(O, first, r).concat(pathHits(O, second, r)));
  const legMemo = new Map<string, { pts: Pt[] | null; hits: Obstacle[] }>();   // clear legs between two points (either posture), shared by the rounds
  for (let round = 0; round < 8 && active.size; round++) {
    const nodes = [start, goal];
    for (const ob of active) for (const v of hullOf(ob, r)) if (!segHit(O, v, v, r)) nodes.push(v);
    if (nodes.length > 400) break;
    const blockers = new Set<Obstacle>();
    const leg = (i: number, j: number) => {   // the clear leg between two nodes (either posture), or null
      const a = nodes[Math.min(i, j)], b = nodes[Math.max(i, j)]; const key = a[0] + "," + a[1] + ":" + b[0] + "," + b[1];
      let m = legMemo.get(key);
      if (!m) {
        m = { pts: null, hits: [] } as { pts: Pt[] | null; hits: Obstacle[] };
        for (const df of [false, true]) {
          const pts = legPts(a, b, df); let hit: Obstacle | null = null;
          for (let k = 0; k + 1 < pts.length && !hit; k++) hit = segHit(O, pts[k], pts[k + 1], r);
          if (!hit) { m.pts = pts; break; } m.hits.push(hit);
        }
        legMemo.set(key, m);
      }
      for (const h of m.hits) blockers.add(h);
      return m.pts && (i < j ? m.pts : m.pts.slice().reverse());
    };
    // lazy A* over the hull corners (octile lengths): a node's leg from its parent is only checked when it is taken
    const n = nodes.length, g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    g[0] = 0; let found = false; const closed: number[] = [];
    for (let iter = 0; iter < 4 * n; iter++) {
      if (now() > deadline) return null;
      let u = -1, bf = Infinity; for (let i = 0; i < n; i++) if (!done[i] && g[i] < Infinity) { const f = g[i] + octile(nodes[i], goal); if (f < bf) { bf = f; u = i; } }
      if (u < 0) break;
      if (u !== 0 && !leg(from[u], u)) {   // its optimistic parent cannot see it: the best closed node that can, if any
        let bp = -1, bc = Infinity;
        const order = closed.filter((c) => c !== from[u]).sort((x, y) => (g[x] + octile(nodes[x], nodes[u])) - (g[y] + octile(nodes[y], nodes[u])));
        for (const c of order.slice(0, 12)) if (leg(c, u)) { bp = c; bc = g[c] + octile(nodes[c], nodes[u]) + 1e-3; break; }
        if (bp < 0) { g[u] = Infinity; from[u] = -1; continue; }
        from[u] = bp; g[u] = bc;
      }
      done[u] = 1; closed.push(u); if (u === 1) { found = true; break; }
      for (let v = 1; v < n; v++) { if (done[v]) continue; const c = g[u] + octile(nodes[u], nodes[v]) + 1e-3; if (c < g[v]) { g[v] = c; from[v] = u; } }
    }
    if (found) {
      let seq: number[] = []; for (let v = 1; v >= 0; v = from[v]) seq.unshift(v);
      // pull the line tight (the optimizer's MERGE_SEGMENTS): skip corners a direct leg can do without
      const tight = [seq[0]]; let i = 0;
      while (i < seq.length - 1) { let j = seq.length - 1; while (j > i + 1 && !leg(seq[i], seq[j])) j--; tight.push(seq[j]); i = j; }
      // each leg in the posture that continues the previous segment best
      let pts = [start.slice()], prev = lastDir;
      for (let k = 0; k + 1 < tight.length; k++) {
        const a = nodes[tight[k]], b = nodes[tight[k + 1]]; const cands: Pt[][] = [];
        for (const df of (k === 0 ? [diagFirst, !diagFirst] : [false, true])) { const p = legPts(a, b, df); if (pathClear(O, p, r)) cands.push(p); }
        if (!cands.length) { cands.push(leg(tight[k], tight[k + 1])!); }
        let best = cands[0];
        if (prev >= 0 && cands.length > 1) { const score = (p: Pt[]) => dirAngle(prev, dir8(p[0], p[1])); if (score(cands[1]) < score(cands[0])) best = cands[1]; }
        pts = pts.concat(best.slice(1)); prev = dir8(best[best.length - 2], best[best.length - 1]);
      }
      return simplifyPts(pts);
    }
    let grew = false; for (const b of blockers) if (!active.has(b)) { active.add(b); grew = true; }
    if (!grew) break;
  }
  return null;
}
/**
 * LINE_PLACER::routeHead in Walk around: the clear line towards the cursor.  An unreachable cursor (inside another
 * net's clearance, or walled in) gives the reachable point nearest to it.  { pts, reached }.
 */
export function walkHead(O: ObstacleIndex, start: Pt, goal: Pt, r: number, diagFirst: boolean, lastDir: number, legFn?: LegFn | null) {
  const legPts = legFn || legPts45;
  const deadline = now() + 35;   // a mouse move must stay interactive: past this the head just stops short
  if (samePt(start, goal)) return { pts: [start.slice()], reached: true };
  if (segHit(O, start, start, r)) return { pts: [start.slice()], reached: false };
  if (!segHit(O, goal, goal, r)) { const p = walkTo(O, start, goal, r, diagFirst, lastDir, deadline, legFn); if (p) return { pts: p, reached: true }; }
  // the cursor sits in a clearance zone (or no walk reaches it): try the hull edges nearest to it, then clip
  const cands: Pt[] = [];
  obstaclesNear(O, [goal[0], goal[1], goal[0], goal[1]], r, (ob) => {
    if (!obstacleHit(ob, goal, goal, r)) return false; const H = hullOf(ob, r);
    for (let i = 0; i < 8; i++) { const a = H[i], b = H[(i + 1) % 8]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((goal[0] - a[0]) * dx + (goal[1] - a[1]) * dy) / l2)) : 0; cands.push([a[0] + k * dx, a[1] + k * dy]); }
    return false;
  });
  const options: Pt[][] = [];
  const clip = clipPts(O, legPts(start, goal, diagFirst), r); options.push(clip);
  cands.sort((p, q) => Math.hypot(p[0] - goal[0], p[1] - goal[1]) - Math.hypot(q[0] - goal[0], q[1] - goal[1]));
  let tried = 0;
  for (const c of cands) { if (tried >= 2 || now() > deadline) break; if (segHit(O, c, c, r)) continue; tried++; const p = walkTo(O, start, [r6(c[0]), r6(c[1])], r, diagFirst, lastDir, deadline, legFn); if (p) options.push(p); }
  const dist = (p: Pt[]) => { const e = p[p.length - 1]; return Math.hypot(e[0] - goal[0], e[1] - goal[1]); };
  options.sort((a, b) => dist(a) - dist(b) || ptsLength(a) - ptsLength(b));
  return { pts: options[0], reached: false };
}
