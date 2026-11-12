// pcb-tools/shove.ts — SHOVE (pns_shove.cpp).
import type { Box, BoardDoc, BranchOp, CircleShape, Conductor, CopperShape, WorldItem, DesignSettings, LegFn, PadInfo, PcbCtx, PolyShape, Pt, Route, SegShape } from "./types";
import type { RouterSettings } from "./router-settings";
import { headVia, opOn, routeDoc, routeOwn, viaSpanLayers } from "./branch";
import { settingsOf } from "./dialogs";
import { polySegDist, segsIntersect, shapeGap, shapeOffset } from "./distances";
import { assembleLine, dragCorner45, peq, rp, viaFanout } from "./dragger";
import { netClearance } from "./drc";
import { viaNow } from "./edit-commands";
import { isLocked } from "./groups";
import { pointInPoly } from "./hit";
import { closestOnSeg } from "./point-editor";
import { K, S } from "./state";
import { clone, r6, vunit } from "./util";
import { rulePairClearance } from "./rule-resolver";
import { DIRS8, HULL_EPS, ROUTE_EPS, isFreePad, now, pathHits, ptsLength, routeClearance, routeObstacles, routerWorld, shapeCorePts, simplifyPts, walkHead } from "./walkaround";

// ================================================================ SHOVE (pcbnew/router/pns_shove.cpp)
// The head pushes the tracks and vias of other nets out of its way.  Each pushed track is re-walked around the hulls
// of whatever pushes it (ShoveObstacleLine, both ways round, the side away from the pusher), vias are pushed out by
// the collision's minimum translation and drag their tracks along (pushOrShoveVia), and every pushed thing is pushed
// on a stack and checked in turn, until nothing collides or the iteration / time limits run out.  Pads, holes, rule
// areas, the board edge, arcs and locked items are never moved: the head walks round them, and a pushed track that
// meets one walks round it too (onCollidingSolid).  The whole shove is recomputed from the route's branch on every
// move, so pushed tracks spring back as the head retreats (the springback stack's effect).
export const SHOVE_HEAD_RANK = 1e6;
/** A movable track of the shove's world. */
export interface ShoveTrack { kind: "track"; id: string; a: Pt; b: Pt; w: number; layer: string; net: string; item: KItem }
/** A movable via of the shove's world (moved: at its pushed place). */
export interface ShoveVia { kind: "via"; id: string; at: Pt; r: number; drill: number; layers: Set<string>; net: string; item: KItem; moved?: boolean }
/** Something the shove never moves: a pad, hole, rule area, the edge, an arc, a locked track or via. */
export interface ShoveSolid { kind: "solid"; id: string | null; ckind: string; layers: Set<string> | null | undefined; net: string; shape: CopperShape; bbox: Box; pad?: PadInfo; src?: Conductor | WorldItem }
export type ShoveObj = ShoveTrack | ShoveVia | ShoveSolid;
/** The shove's view of the board (shoveWorld). */
export interface ShoveWorld { doc: BoardDoc; tracks: Map<string, ShoveTrack>; vias: Map<string, ShoveVia>; solids: ShoveSolid[]; grid: Map<string, ShoveObj[]>; CELL: number; maxW: number; s: DesignSettings }
/** A line the shove moves or pushes with: a head, a pushed line of tracks, or a pushed via's proxy. */
export interface ShoveLine {
  key: string; ids: string[]; pts: Pt[]; orig?: Pt[]; w: number; layer: string | null; net: string; rank: number;
  head?: boolean; proxy?: boolean; via?: { at: Pt; r: number; layers?: Set<string> }; viaId?: string; ownIds?: Set<string> | null;
}
/** A pusher or pushed line as the hull and clearance checks read it. */
export type ShoveShape = Pick<ShoveLine, "pts" | "w" | "net"> & Partial<ShoveLine>;
/** The shove in progress: the pushed lines (by key and by track id) and the pushed vias. */
export interface ShoveState { lines: Map<string, ShoveLine>; lineOf: Map<string, ShoveLine>; viaAt: Map<string, Pt>; viaRank: Map<string, number> }
/** What a shove hands the router: the branch edits and the preview. */
export interface ShoveResult { ops: BranchOp[]; preview: ReturnType<typeof shovePreview>; viaOk: boolean }
/** A collision found by shoveNearest. */
interface ShoveHit { d: number; o?: ShoveObj; L?: ShoveLine }
/** The octagonal hull (8 directions) of a shape's core points grown by `off`: SegmentHull / OctagonalHull. */
export function octagon(core: Pt[], off: number) {
  const h = DIRS8.map((u) => { let m = -Infinity; for (const p of core) m = Math.max(m, p[0] * u[0] + p[1] * u[1]); return m + off; });
  const out: Pt[] = [];
  for (let k = 0; k < 8; k++) {
    const u0 = DIRS8[k], u1 = DIRS8[(k + 1) % 8], h0 = h[k], h1 = h[(k + 1) % 8]; const det = u0[0] * u1[1] - u0[1] * u1[0];
    out.push([(h0 * u1[1] - h1 * u0[1]) / det, (u0[0] * h1 - u1[0] * h0) / det]);
  }
  return out;
}
/** The clearance between two lines (or a line and a via, kindB "via") of nets a and b on a layer: the custom rules first, then the netclasses (rulePairClearance). */
export const pairClr = (s: DesignSettings, a: string, b: string, layer?: string | null, kindB?: string) => (S.dru && S.dru.rules.length ? rulePairClearance(S.shoveDoc || null, s, a, b, layer || null, kindB) : Math.max(netClearance(s, a), netClearance(s, b), s.minClearance || 0));
export const sameNetKey = (a: string, b: string) => !!a && a === b;
/** Strictly inside a convex polygon (on the outline is outside). */
export function insideConvex(P: Pt[], p: Pt) {
  let sign = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length]; const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(c) < 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) return false;
    const sg = c > 0 ? 1 : -1; if (!sign) sign = sg; else if (sg !== sign) return false;
  }
  return true;
}
/** Proper or touching intersection of segments p1p2 and p3p4: { t (along p1p2), u (along p3p4), p } or null (parallel: null). */
export function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt) {
  const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]]; const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / den, u = ((p3[0] - p1[0]) * d1[1] - (p3[1] - p1[1]) * d1[0]) / den;
  const E = 1e-9; if (t < -E || t > 1 + E || u < -E || u > 1 + E) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)), p: [p1[0] + d1[0] * t, p1[1] + d1[1] * t] };
}
/**
 * LINE::Walkaround for a convex hull: the path with its stretch through the hull replaced by the hull's outline,
 * going round in hull order (dir +1) or against it (-1).  The path is returned unchanged when it only touches the
 * hull; null when it starts or ends inside it.
 */
export function walkAroundHull(path: Pt[], H: Pt[], dir: number) {
  if (path.length < 2) return null;
  if (insideConvex(H, path[0]) || insideConvex(H, path[path.length - 1])) return null;
  const ips: { i: number; t: number; j: number; u: number; p: Pt }[] = [];
  for (let i = 0; i + 1 < path.length; i++) for (let j = 0; j < H.length; j++) { const x = segIntersect(path[i], path[i + 1], H[j], H[(j + 1) % H.length]); if (x) ips.push({ i, t: x.t, j, u: x.u, p: x.p }); }
  if (ips.length < 2) return path.map((p: Pt) => p.slice());
  ips.sort((a, b) => a.i - b.i || a.t - b.t);
  const first = ips[0], last = ips[ips.length - 1];
  // only touching (no stretch strictly inside): nothing to walk round
  let enters = false;
  for (let k = 0; k + 1 < ips.length && !enters; k++) { const a = ips[k], b = ips[k + 1]; const pa = a.p, pb = b.p; if (insideConvex(H, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2])) enters = true; }
  for (let i = first.i + 1; i <= last.i && !enters; i++) if (insideConvex(H, path[i])) enters = true;
  if (!enters) return path.map((p: Pt) => p.slice());
  const n = H.length; const out = path.slice(0, first.i + 1).map((p: Pt) => p.slice()); out.push(first.p);
  if (dir > 0) {
    if (first.j === last.j && last.u >= first.u) { /* along the same edge */ }
    else { let k = (first.j + 1) % n; for (let g = 0; g <= n; g++) { out.push(H[k].slice()); if (k === last.j) break; k = (k + 1) % n; } }
  } else if (first.j === last.j && last.u <= first.u) { /* along the same edge, backwards */ }
  else { let k = first.j; for (let g = 0; g <= n; g++) { out.push(H[k].slice()); if (k === (last.j + 1) % n) break; k = (k + n - 1) % n; } }
  out.push(last.p); for (let i = last.i + 1; i < path.length; i++) out.push(path[i].slice());
  return simplifyPts(out.map(rp));
}
/** SHAPE_LINE_CHAIN::SelfIntersecting: two non-adjacent segments that meet. */
export function selfIntersecting(pts: Pt[]) {
  for (let i = 0; i + 1 < pts.length; i++) for (let j = i + 2; j + 1 < pts.length; j++) {
    if (i === 0 && j === pts.length - 2 && peq(pts[0], pts[pts.length - 1])) continue;
    if (segsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
  }
  return false;
}
/**
 * The shove's view of the board: the movable tracks (unlocked segments) and vias, in coarse grids, and the solids
 * (pads, holes, rule areas, the edge, arcs, locked tracks and vias, and vias at all while "Shove vias" is off).
 */
export function shoveWorld(doc: BoardDoc, s: DesignSettings, shoveVias: boolean): ShoveWorld {
  const bc = doc.__bc; const key = "sw" + (shoveVias ? 1 : 0);
  if (bc && bc[key]) return bc[key] as ShoveWorld;
  if (!bc && S.sworld && S.sworld.doc === doc && S.sworld.ver === S.docVer && S.sworld.key === key) return S.sworld.w;
  const Wd = routerWorld(doc); const tracks = new Map<string, ShoveTrack>(), vias = new Map<string, ShoveVia>(), solids: ShoveSolid[] = [];
  const CELL = 2.5; const grid = new Map<string, ShoveObj[]>(); let maxW = 0;
  const gadd = (o: ShoveObj, b: Box) => { for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++) for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) { const k = gx + "," + gy; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(o); } };
  for (const c of Wd.conds) {
    const locked = c.item && isLocked(c.item.node);
    if (c.kind === "segment" && !locked) { const o: ShoveTrack = { kind: "track", id: c.id, a: (c.shape as SegShape).a, b: (c.shape as SegShape).b, w: c.width, layer: Array.from(c.layers)[0], net: c.net, item: c.item }; tracks.set(c.id, o); gadd(o, c.bbox); maxW = Math.max(maxW, c.width); continue; }
    if (c.kind === "via" && !locked && shoveVias) { const o: ShoveVia = { kind: "via", id: c.id, at: [(c.shape as CircleShape).x, (c.shape as CircleShape).y], r: (c.shape as CircleShape).r, drill: c.drill, layers: c.layers, net: c.net, item: c.item }; vias.set(c.id, o); gadd(o, c.bbox); maxW = Math.max(maxW, 2 * (c.shape as CircleShape).r); continue; }
    const o: ShoveSolid = { kind: "solid", id: c.id, ckind: c.kind, layers: c.layers, net: c.net, shape: c.shape, bbox: c.bbox, pad: c.kind === "pad" ? c.pad : undefined, src: c }; solids.push(o); gadd(o, c.bbox);
  }
  for (const h of Wd.holes) { const o: ShoveSolid = { kind: "solid", id: h.id, ckind: "hole", layers: h.layers, net: "", shape: h.shape, bbox: h.bbox, src: h }; solids.push(o); gadd(o, h.bbox); }
  for (const k of Wd.keepouts) { const o: ShoveSolid = { kind: "solid", id: k.id, ckind: "keepout", layers: k.layers, net: "", shape: k.shape, bbox: k.bbox }; solids.push(o); gadd(o, k.bbox); }
  for (const e of Wd.edges) { const o: ShoveSolid = { kind: "solid", id: null, ckind: "edge", layers: null, net: "", shape: e.shape, bbox: e.bbox }; solids.push(o); gadd(o, e.bbox); }
  const w: ShoveWorld = { doc, tracks, vias, solids, grid, CELL, maxW, s }; S.shoveDoc = doc;
  if (bc) bc[key] = w; else S.sworld = { doc, ver: S.docVer, key, w };
  return w;
}
/** Clearance between a line of net `net` and a solid (PNS_PCBNEW_RULE_RESOLVER's kinds). */
export function solidClr(s: DesignSettings, net: string, o: ShoveSolid, layer?: string | null) { return routeClearance(s, net, { kind: o.ckind === "hole" ? "hole" : o.ckind === "keepout" ? "keepout" : o.ckind === "edge" ? "edge" : o.ckind, net: o.net, id: o.id, src: o.src }, layer, S.shoveDoc || null); }
/** The items of the world (base grid, then the shoved lines and vias) near a box. */
export function shoveNear(SW: ShoveWorld, st: ShoveState, box: Box, grow: number, fn: (o: ShoveObj | { kind: "line"; L: ShoveLine }) => void) {
  const C = SW.CELL, seen = new Set<ShoveObj>();
  for (let gx = Math.floor((box[0] - grow) / C); gx <= Math.floor((box[2] + grow) / C); gx++) for (let gy = Math.floor((box[1] - grow) / C); gy <= Math.floor((box[3] + grow) / C); gy++) {
    const l = SW.grid.get(gx + "," + gy); if (!l) continue;
    for (const o of l) { if (seen.has(o)) continue; seen.add(o); if (o.kind === "track" && st.lineOf.has(o.id)) continue; if (o.kind === "via" && st.viaAt.has(o.id)) continue; fn(o); }
  }
  for (const L of st.lines.values()) fn({ kind: "line", L });
  for (const [id, at] of st.viaAt) { const v = SW.vias.get(id); if (v) fn(Object.assign({}, v, { at, moved: true })); }
}
/** The line's segments [a, b] and its via (if any) as collision probes. */
export const lineSegs = (L: Pick<ShoveLine, "pts">): Pt[][] => (L.pts.length > 1 ? L.pts.slice(0, -1).map((p: Pt, i: number) => [p, L.pts[i + 1]]) : []);
/**
 * NODE::NearestObstacle in SHOVE::shoveIteration's search order (SOLID, VIA, SEGMENT): the obstacle the line meets
 * first.  { kind: "solid" | "via" | "line", o, L } or null.
 */
export function shoveNearest(SW: ShoveWorld, st: ShoveState, L: ShoveLine) {
  const s = SW.s; const segs = lineSegs(L); const found: Record<"solid" | "via" | "line", ShoveHit | null> = { solid: null, via: null, line: null };
  const score = (k: "solid" | "via" | "line", d: number, x: { o?: ShoveObj; L?: ShoveLine }) => { if (!found[k] || d < found[k]!.d) found[k] = Object.assign({ d }, x); };
  const consider = (o: ShoveObj | { kind: "line"; L: ShoveLine }, probe: Probe, idx: number, rL: number, onLayer: string) => {
    if (o.kind === "line") {
      const M = o.L; if (M === L || M.layer !== onLayer || sameNetKey(M.net, L.net)) return;
      const c = pairClr(s, L.net, M.net, onLayer);
      for (let k = 0; k + 1 < M.pts.length; k++) { const g = probeGap(probe, rL, { t: "seg", a: M.pts[k], b: M.pts[k + 1], r: M.w / 2 }); if (g < c - ROUTE_EPS) { score("line", idx + probeDist(probe, M.pts[k]), { L: M }); return; } }
      return;
    }
    if (L.ownIds && o.id && L.ownIds.has(o.id)) return;
    if (o.kind === "track") {
      if (o.layer !== onLayer || sameNetKey(o.net, L.net) || (L.ids && L.ids.includes(o.id))) return;
      const g = probeGap(probe, rL, { t: "seg", a: o.a, b: o.b, r: o.w / 2 }); if (g < pairClr(s, L.net, o.net, onLayer) - ROUTE_EPS) score("line", idx + probeDist(probe, o.a), { o });
    } else if (o.kind === "via") {
      if (!o.layers.has(onLayer) || sameNetKey(o.net, L.net) || (L.viaId && L.viaId === o.id)) return;
      const g = probeGap(probe, rL, { t: "circle", x: o.at[0], y: o.at[1], r: o.r }); if (g < pairClr(s, L.net, o.net, onLayer, "via") - ROUTE_EPS) score("via", idx + probeDist(probe, o.at), { o });
    } else {
      if (o.layers && !o.layers.has(onLayer)) return;
      if (o.ckind !== "edge" && o.ckind !== "hole" && o.ckind !== "keepout" && (sameNetKey(o.net, L.net) || (o.ckind === "pad" && (!o.net ? !L.net : isFreePad(o.pad))))) return;
      if (o.ckind === "keepout") { const a = probe.t === "seg" ? probe.a : [probe.x, probe.y], b = probe.t === "seg" ? probe.b : a; if (pointInPoly((o.shape as PolyShape).pts, a[0], a[1]) || pointInPoly((o.shape as PolyShape).pts, b[0], b[1]) || polySegDist((o.shape as PolyShape).pts, a, b) < rL - ROUTE_EPS) score("solid", idx, { o }); return; }
      const g = probeGap(probe, rL, o.shape); if (g < solidClr(s, L.net, o, onLayer) - ROUTE_EPS) score("solid", idx + probeDist(probe, shapeCorePts(o.shape)[0]), { o });
    }
  };
  const grow = (L.w || 0) / 2 + SW.maxW + 2;
  segs.forEach(([a, b], i: number) => {
    const probe: Probe = { t: "seg", a, b }; const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    shoveNear(SW, st, box, grow, (o) => consider(o, probe, i * 1e4, L.w / 2, L.layer as string));   // a via proxy has no layer: no layer matches it
  });
  if (L.via) {
    const v = L.via; const probe: Probe = { t: "circle", x: v.at[0], y: v.at[1] };
    for (const layer of v.layers!) shoveNear(SW, st, [v.at[0], v.at[1], v.at[0], v.at[1]], v.r + grow, (o) => consider(o, probe, segs.length * 1e4, v.r, layer));
  }
  if (found.solid) return Object.assign({ kind: "solid" }, found.solid);
  if (found.via) return Object.assign({ kind: "via" }, found.via);
  if (found.line) return Object.assign({ kind: "line" }, found.line);
  return null;
}
/** A collision probe: a segment of a line or the centre of its via. */
export type Probe = { t: "seg"; a: Pt; b: Pt } | { t: "circle"; x: number; y: number };
export function probeGap(probe: Probe, r: number, shape: CopperShape) { const p: CopperShape = probe.t === "seg" ? { t: "seg", a: probe.a, b: probe.b, r } : { t: "circle", x: probe.x, y: probe.y, r }; return shapeGap(p, shape); }
export function probeDist(probe: Probe, q: Pt) { const a = probe.t === "seg" ? probe.a : [probe.x, probe.y]; return Math.min(9999, Math.hypot(q[0] - a[0], q[1] - a[1])); }
/** SHOVE::assembleLine for a track of the world (or the shoved line it is already part of). */
export function shoveLineOf(SW: ShoveWorld, st: ShoveState, o: ShoveTrack): ShoveLine | null {
  if (st.lineOf.has(o.id)) return st.lineOf.get(o.id)!;
  const ln = assembleLine(SW.doc, o.item); if (!ln) return null;
  return { key: ln.ids.join(","), ids: ln.ids, pts: ln.pts.map((p) => p.slice()), orig: ln.pts.map((p) => p.slice()), w: ln.width, layer: ln.layer, net: ln.netKey, rank: -Infinity };
}
export function setLine(st: ShoveState, L: ShoveLine, pts: Pt[]) { L.pts = pts; if (L.head || L.proxy) return; st.lines.set(L.key, L); for (const id of L.ids) st.lineOf.set(id, L); }
/** The hulls a pusher puts around itself for a pushed line of width w (its segments, and its via). */
export function pusherHulls(s: DesignSettings, P: ShoveShape, V: ShoveShape) {
  const c = pairClr(s, P.net, V.net); const out: Pt[][] = [];
  for (const [a, b] of lineSegs(P)) out.push(octagon([a, b], P.w / 2 + c + V.w / 2 + HULL_EPS));
  if (P.via) out.push(octagon([P.via.at], P.via.r + c + V.w / 2 + HULL_EPS));
  return out;
}
/** Does line V keep its clearance to pusher P? */
export function clearOf(s: DesignSettings, P: ShoveShape, V: ShoveShape) {
  const c = pairClr(s, P.net, V.net) - ROUTE_EPS;
  for (const [a, b] of lineSegs(V)) {
    const sv: CopperShape = { t: "seg", a, b, r: V.w / 2 };
    for (const [p, q] of lineSegs(P)) if (shapeGap(sv, { t: "seg", a: p, b: q, r: P.w / 2 }) < c) return false;
    if (P.via && shapeGap(sv, { t: "circle", x: P.via.at[0], y: P.via.at[1], r: P.via.r }) < c) return false;
  }
  return true;
}
/** SHOVE::checkShoveDirection: the pusher's first point must not lie inside the area the shove sweeps. */
export function shoveDirectionOk(P: ShoveShape, orig: Pt[], shoved: Pt[]) {
  const cp = P.pts.length ? P.pts[0] : P.via!.at;
  const poly = orig.concat(shoved.slice().reverse()); return !pointInPoly(poly, cp[0], cp[1]);
}
/**
 * SHOVE::ShoveObstacleLine / shoveLineToHullSet: line V re-walked round the hulls of pusher P — four attempts (each
 * way round, the hulls in either order) — keeping its ends, on the side away from the pusher, clear of it.
 */
export function shoveLine(s: DesignSettings, P: ShoveShape, V: ShoveShape) {
  const hulls = pusherHulls(s, P, V); if (!hulls.length || V.pts.length < 2) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const order = attempt >= 2 ? hulls.slice().reverse() : hulls, dir = attempt % 2 ? 1 : -1;
    let path = V.pts.map((p: Pt) => p.slice()); let ok = true;
    for (const H of order) { const w = walkAroundHull(path, H, dir); if (!w) { ok = false; break; } path = w; }
    if (!ok) continue;
    if (!peq(path[0], V.pts[0]) || !peq(path[path.length - 1], V.pts[V.pts.length - 1])) continue;
    if (!shoveDirectionOk(P, V.pts, path)) continue;
    if (selfIntersecting(path)) continue;
    if (!clearOf(s, P, { pts: path, w: V.w, net: V.net })) continue;
    return path;
  }
  return null;
}
/** SHOVE::onCollidingSolid for a pushed line: walk it round the solid, the shorter way, its ends kept. */
export function walkLineAround(s: DesignSettings, L: ShoveLine, shape: CopperShape, clr: number) {
  const core = shapeCorePts(shape); const off = (shape.t === "poly" ? 0 : shapeOffset(shape)) + clr + L.w / 2 + HULL_EPS; const H = octagon(core, off);
  let best: Pt[] | null = null;
  for (const dir of [1, -1]) { const p = walkAroundHull(L.pts, H, dir); if (!p || selfIntersecting(p) || !peq(p[0], L.pts[0]) || !peq(p[p.length - 1], L.pts[L.pts.length - 1])) continue; if (!best || ptsLength(p) < ptsLength(best)) best = p; }
  return best;
}
/**
 * SHOVE::pushOrShoveVia: the via pushed out of the line by the collision's minimum translation; the tracks ending
 * on it follow with 45° corners (LINE::DragCorner) and are pushed on the stack with the via.
 */
export function pushVia(SW: ShoveWorld, st: ShoveState, L: ShoveLine, v: ShoveVia, stack: ShoveLine[]) {
  const s = SW.s; const R = v.r + pairClr(s, L.net, v.net) + HULL_EPS; let at = v.at.slice();
  for (let k = 0; k < 24; k++) {
    let moved = false;
    for (const [a, b] of lineSegs(L)) {
      const q = closestOnSeg(at, a, b); let d = Math.hypot(at[0] - q[0], at[1] - q[1]); const need = R + L.w / 2;
      if (d >= need - 1e-9) continue;
      let n = d > 1e-9 ? [(at[0] - q[0]) / d, (at[1] - q[1]) / d] : vunit([-(b[1] - a[1]), b[0] - a[0]]);
      if (d <= 1e-9 && !n[0] && !n[1]) n = [1, 0];
      at = [at[0] + n[0] * (need - d), at[1] + n[1] * (need - d)]; moved = true;
    }
    if (L.via) { const d = Math.hypot(at[0] - L.via.at[0], at[1] - L.via.at[1]), need = R + L.via.r; if (d < need - 1e-9) { const n = d > 1e-9 ? [(at[0] - L.via.at[0]) / d, (at[1] - L.via.at[1]) / d] : [1, 0]; at = [at[0] + n[0] * (need - d), at[1] + n[1] * (need - d)]; moved = true; } }
    if (!moved) break;
  }
  at = rp(at);
  const rank = L.rank - 1; st.viaAt.set(v.id, at); st.viaRank.set(v.id, rank);
  const item = SW.doc.items.get(v.id);
  for (const fl of item ? viaFanout(SW.doc, item) : []) {
    if (fl.arc || !fl.ids.length) return false;   // an arc on the via cannot follow (arcs are not shoved here)
    const M: ShoveLine = st.lineOf.get(fl.ids[0]) || { key: fl.ids.join(","), ids: fl.ids, pts: fl.pts.map((p) => p.slice()), orig: fl.pts.map((p) => p.slice()), w: fl.width, layer: fl.layer, net: fl.netKey, rank: -Infinity };
    if (!peq(M.pts[0], v.at) && peq(M.pts[M.pts.length - 1], v.at)) { M.pts.reverse(); M.ids = M.ids.slice().reverse(); if (M.orig) M.orig = M.orig.slice().reverse(); }
    if (!peq(M.pts[0], v.at)) continue;
    M.rank = rank; setLine(st, M, dragCorner45(M.pts, 0, at, 0));
    const i = stack.indexOf(M); if (i >= 0) stack.splice(i, 1); stack.push(M);
  }
  stack.push({ proxy: true, key: "via:" + v.id, viaId: v.id, pts: [at], w: 0, layer: null, net: v.net, rank, via: { at, r: v.r, layers: v.layers } } as ShoveLine);   // a proxy has no track ids
  return true;
}
/**
 * SHOVE::Run → shoveMainLoop: push everything out of the heads' way.  heads: [{ pts, w, layer, net, via?, ownIds? }].
 * Returns the shove state { lines, viaAt } or null when it cannot be done within the limits.
 */
export function shoveRun(SW: ShoveWorld, heads: Omit<ShoveLine, "key" | "rank" | "ids">[], rs: RouterSettings) {
  const st: ShoveState = { lines: new Map(), lineOf: new Map(), viaAt: new Map(), viaRank: new Map() };
  const stack: ShoveLine[] = heads.map((h, i: number) => Object.assign({ head: true, key: "head" + i, rank: SHOVE_HEAD_RANK, ids: (h as Partial<ShoveLine>).ids || [] }, h));
  const limit = rs.shove_iteration_limit || 250, deadline = now() + Math.min(rs.shove_time_limit || 1000, 150);   // an interactive move keeps well under KiCad's 1 s
  const s = SW.s;
  for (let iter = 0; stack.length; iter++) {
    if (iter >= limit || now() > deadline) return null;
    const cur = stack[stack.length - 1];
    const hit = shoveNearest(SW, st, cur);
    if (!hit) { stack.pop(); continue; }
    if (hit.kind === "solid") {
      if (cur.head || cur.proxy) return null;
      const so = hit.o as ShoveSolid; const w = walkLineAround(s, cur, so.shape, so.ckind === "keepout" ? 0 : solidClr(s, cur.net, so, cur.layer)); if (!w) return null;
      setLine(st, cur, w); continue;
    }
    if (hit.kind === "via") {
      const hv = hit.o as ShoveVia; const v: ShoveVia = st.viaAt.has(hv.id) ? Object.assign({}, hv, { at: st.viaAt.get(hv.id)! }) : hv;
      const vr = st.viaRank.has(v.id) ? st.viaRank.get(v.id)! : -Infinity;
      if (vr > cur.rank) {   // onReverseCollidingVia: the line gives way round the via that was pushed into it
        if (cur.head || cur.proxy) return null;
        const res = shoveLine(s, { pts: [], w: 0, net: v.net, via: { at: v.at, r: v.r } }, cur); if (!res) return null; setLine(st, cur, res); continue;
      }
      if (!pushVia(SW, st, cur, v, stack)) return null;
      continue;
    }
    const ob = hit.L || shoveLineOf(SW, st, hit.o as ShoveTrack); if (!ob) return null;
    if (ob.rank > cur.rank) {   // reverse collision: the line that was pushed further pushes this one back
      if (cur.head || cur.proxy) return null;
      const res = shoveLine(s, ob, cur); if (!res) return null; setLine(st, cur, res); continue;
    }
    const res = shoveLine(s, cur, ob); if (!res) return null;
    ob.rank = cur.rank - 1; setLine(st, ob, res);
    const i = stack.indexOf(ob); if (i >= 0) stack.splice(i, 1); stack.push(ob);
  }
  return st;
}
/** The branch edits of a shove: each pushed line's segments rewritten (the first ones keep their uuids), each pushed via moved. */
export function shoveOps(doc: BoardDoc, st: ShoveState) {
  const ops: BranchOp[] = [];
  for (const L of st.lines.values()) {
    const pts = simplifyPts(L.pts); const olds = L.ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; if (!olds.length) continue;
    const n = pts.length - 1; const grp = {};
    for (let i = 0; i < n; i++) {
      const base = olds[Math.min(i, olds.length - 1)]; const node = clone(base.node);
      K.kid(node, "start")!.splice(1, 2, r6(pts[i][0]), r6(pts[i][1])); K.kid(node, "end")!.splice(1, 2, r6(pts[i + 1][0]), r6(pts[i + 1][1]));
      if (i < olds.length) ops.push(opOn(olds[i], { set: olds[i].id, node }, grp));
      else { const u = K.kid(node, "uuid"); if (u) node.splice(node.indexOf(u), 1); node.push(["uuid", K.newUuid()]); ops.push({ add: node, grp }); }
    }
    for (let i = Math.max(n, 0); i < olds.length; i++) ops.push(opOn(olds[i], { del: olds[i].id }, grp));
  }
  for (const [id, at] of st.viaAt) { const it = doc.items.get(id); if (!it) continue; const node = clone(it.node); K.kid(node, "at")!.splice(1, 2, r6(at[0]), r6(at[1])); ops.push(opOn(it, { set: id, node })); }
  return ops;
}
/** What a shove shows: the pushed lines and vias, and the ids of the originals they hide. */
export function shovePreview(doc: BoardDoc, st: ShoveState) {
  const hidden = new Set<string>(); const lines: { pts: Pt[]; w: number; layer: string | null }[] = [], vias: { at: Pt; size: number; drill: number }[] = [];
  for (const L of st.lines.values()) { for (const id of L.ids) hidden.add(id); lines.push({ pts: L.pts, w: L.w, layer: L.layer }); }
  for (const [id, at] of st.viaAt) { const it = doc.items.get(id); if (!it) continue; hidden.add(id); const v = viaNow(it.node); vias.push({ at, size: v.size, drill: v.drill }); }
  return { hidden, lines, vias };
}
/** The router's obstacles in Shove mode for the head's walk (rhWalkBase( SOLID_T )): everything the shove cannot move. */
export function solidObs(ctx: PcbCtx, rt: Route, layer?: string) {
  layer = layer || rt.layer; const doc = routeDoc(ctx, rt); const s = settingsOf(ctx);
  const key = S.docVer + "|" + layer + "|" + rt.width + "|" + rt.stages.length + "|" + rt.netKey + "|" + S.rs.shove_vias;
  if (rt.sobs && rt.sobs.key === key && rt.sobs.doc === doc) return rt.sobs;
  const SW = shoveWorld(doc, s, S.rs.shove_vias); const skip = new Set([...SW.tracks.keys(), ...SW.vias.keys()]);
  rt.sobs = routeObstacles(doc, s, rt.netKey, layer, rt.netKey ? null : routeOwn(rt), skip); rt.sobs.key = key; rt.sobs.doc = doc;
  return rt.sobs!;
}
/**
 * LINE_PLACER::rhShoveOnly: the head walked round the solids, then shoved into the rest.  { pts, reached, shove } or
 * null when the shove fails (the caller walks around instead).
 */
export function shoveHead(ctx: PcbCtx, rt: Route, leg: LegFn): { pts: Pt[]; reached: boolean; shove: ShoveResult } | null {
  const s = settingsOf(ctx), doc = ctx.doc; const r = rt.width / 2;
  const SOL = solidObs(ctx, rt); const w = walkHead(SOL, rt.last, rt.cursor, r, rt.diagFirst, rt.tracer.lastSegDir, leg);
  const via = headVia(ctx, rt); const head: Omit<ShoveLine, "key" | "rank" | "ids"> = { pts: w.pts, w: rt.width, layer: rt.layer, net: rt.netKey, ownIds: rt.netKey ? null : routeOwn(rt) };
  if (via) {
    const hv = head.via = { at: w.pts[w.pts.length - 1].slice(), r: via.diameter / 2, layers: new Set(viaSpanLayers(doc, via.layers)) };
    for (const L of hv.layers) if (pathHits(solidObs(ctx, rt, L), [hv.at], hv.r).length) return null;
  }
  const SW = shoveWorld(doc, s, S.rs.shove_vias);
  const st = shoveRun(SW, [head], S.rs); if (!st) return null;
  return { pts: w.pts, reached: w.reached, shove: { ops: shoveOps(doc, st), preview: shovePreview(doc, st), viaOk: true } };
}
