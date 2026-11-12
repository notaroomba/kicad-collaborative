// pcb-tools/diffpair.ts — differential pairs: DIFF_PAIR_PLACER and the net pairing.
import type { BoardDoc, Hover, NetRef, Obstacle, ObstacleIndex, PadInfo, PcbCtx, Pt, Route, SnapHit } from "./types";
import type { Ratline } from "./route-fix";

/** One end of a pair: a pad, via or dangling track end of one net (getDanglingAnchor), and the way a track end points. */
export interface DpEnd { kind: string; p: Pt; dir: Pt | null; id?: string; layers?: string; width?: number; pad?: PadInfo }
/** The two ends a pair leg starts from (or lands on). */
export interface DpPair { P: DpEnd; N: DpEnd }
/** The pair's sizes for its nets (width, gap, via gap) and the half spacing h of the coupled lines. */
export type DpSizes = ReturnType<typeof dpSizes>;
/** The gateway a pair leaves through (dpGateway). */
export type DpGateway = NonNullable<ReturnType<typeof dpGateway>>;
/** The head of a pair: both lines, their centre line and its last direction, and the via pair when one is armed. */
export interface DpLines { P: Pt[]; N: Pt[]; centre: Pt[]; lastDir: Pt; vias: { P: Pt; N: Pt } | null }
import { sizesOf } from "./app-state";
import { routeCtx, routeDoc, routeHaloClearance, viaSpanLayers } from "./branch";
import { boardNets } from "./changes";
import { ptKey } from "./connected";
import { copperOf, settingsOf } from "./dialogs";
import { padCopperLayers, viaLayers } from "./distances";
import { refreshChip } from "./dom";
import { chainAppend, jointIndex, rp, trackEnds } from "./dragger";
import { netTable } from "./netlist";
import { hasNet, netOf, sameNet } from "./nets";
import { viaNode } from "./nodes";
import { drawShape, line, polyline } from "./overlay";
import { leadingRatline, routeHighlight, trackOps } from "./route-fix";
import { padsOf } from "./route-geom";
import { drawViaPreview } from "./route-preview";
import { endRoute, showViolations, trackUnder, viaPlan, viaSpan } from "./route-tool";
import { RM_MARK } from "./router-settings";
import { DBL_MS, HALO_COLOR, K, RATSNEST_LEAD, S, saturated } from "./state";
import { newTracer, tracerPosture, trailAdd } from "./tracer";
import { color, layerOf, pt, r6, samePt, vadd, vmul, vsub, vunit, widthOf } from "./util";
import { DIRS8, dir8, dirAngle, indexObstacles, isDiagDir, legPts, pathHits, routeObstacles, simplifyPts, walkHead } from "./walkaround";

// ================================================================ DIFF_PAIR_PLACER (pcbnew/router/pns_diff_pair_placer.cpp)
// Route Differential Pair (6): both nets of a pair routed together at the pair's width and gap.  The pair starts on
// a pad, via or dangling track end of one net and the nearest primitive of the same kind on the complementary net
// (FindDpPrimitivePair); each leg leaves that pair through a gateway (the two coupled start points, DP_GATEWAYS) and
// runs as two lines offset either side of one 45° centre line, walked round the obstacles of other nets as one wide
// track (tryWalkDp), straight with the collisions marked in Highlight collisions (rhMarkObstacles).  A click fixes
// both lines (FixRoute); V ends them on a via pair at the via gap; a click on a pad / via / track end of either net
// with its partner beside it lands the pair on that target and finishes.  One commit, "Route Track".
export const DP_MSG_NETS = "Unable to find complementary differential pair nets. Make sure the names of the nets belonging to a differential pair end with either N/P or +/-.";
export const DP_MSG_START = "Can't find a suitable starting point.  If starting from an existing differential pair make sure you are at the end.";
export const DP_MSG_NOWHERE = "Cannot start a differential pair in the middle of nowhere.";
export const DP_MSG_GAP = "Diff pair gap is less than board minimum clearance.";
export const TAN_22_5 = Math.tan(Math.PI / 8);
/**
 * BOARD::MatchDpSuffix: scanning the name from its end past digits and '_', a final '+' / 'P' makes it the pair's
 * positive net (1) and '-' / 'N' its negative (-1); the complement swaps that character.  { rv, complement }.
 */
export function matchDpSuffix(name: string) {
  name = String(name || ""); let rv = 0, count = 0, comp = "";
  for (let i = name.length - 1; i >= 0 && rv === 0; i--, count++) {
    const ch = name[i];
    if ((ch >= "0" && ch <= "9") || ch === "_") continue;
    if (ch === "+") { comp = "-"; rv = 1; } else if (ch === "-") { comp = "+"; rv = -1; } else if (ch === "N") { comp = "P"; rv = -1; } else if (ch === "P") { comp = "N"; rv = 1; } else break;
  }
  let base = "";   // aBaseDpName: the polarity character and everything after it dropped (LVDS_P1 -> "LVDS_")
  if (rv !== 0 && count >= 1) { base = name.slice(0, name.length - count); comp = base + comp + name.slice(name.length - count + 1); }
  return { rv, complement: rv ? comp : "", base };
}
/** RULE_RESOLVER::DpNetPair: { P, N } (net objects) when the net and its complement both exist on the board. */
export function dpNetPair(doc: BoardDoc, net: NetRef) {
  const name = net && net.name ? net.name : (net && net.code > 0 ? netTable(doc).byCode.get(net.code) || "" : "");
  const m = matchDpSuffix(name); if (!m.rv) return null;
  const other = boardNets(doc).find((n) => n.name === m.complement); if (!other) return null;
  const self = { code: net.code > 0 ? net.code : (netTable(doc).byName.get(name) || {}).code || 0, name };
  return m.rv > 0 ? { P: self, N: other } : { P: other, N: self };
}
/**
 * DIFF_PAIR_PLACER::getDanglingAnchor for every primitive of a net that can carry a pair's end: pads and vias on the
 * layer (their centre), and track ends on the layer that nothing else of the net joins (the direction pointing out of
 * the track).  [{ kind: "pad" | "via" | "track", p, dir: [dx, dy] | null, id, layers, width }].
 */
export function dpPrimitives(doc: BoardDoc, netKey: string, layer: string) {
  const J = jointIndex(doc); const copper = copperOf(doc); const out: DpEnd[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { for (const p of padsOf(it)) { const ls = padCopperLayers(p, copper); if (J.NT.key(p.net) === netKey && ls.has(layer)) out.push({ kind: "pad", p: [p.x, p.y], dir: null, id: it.id, layers: Array.from(ls).sort().join(","), pad: p }); } }
    else if (it.kind === "via") { const a = pt(it.node, "at"); const ls = viaLayers(it.node, copper); if (a && ls.has(layer) && J.NT.key(netOf(it.node)) === netKey) out.push({ kind: "via", p: a, dir: null, id: it.id, layers: Array.from(ls).sort().join(",") }); }
    else if (it.kind === "segment" && layerOf(it.node) === layer && J.NT.key(netOf(it.node)) === netKey) {
      const [a, b] = trackEnds(it); if (!a || !b || samePt(a, b)) continue;
      for (const [q, o] of [[a, b], [b, a]]) {
        const k = ptKey(q);
        if ((J.vias.get(k) || []).some((v) => v.layers.has(layer)) || (J.pads.get(k) || []).some((x) => x.layers.has(layer) && samePt([x.pad.x, x.pad.y], q))) continue;
        const links = (J.ends.get(layer + "|" + k) || []).filter((x) => J.NT.key(netOf(x.node)) === netKey);
        if (links.length !== 1) continue;
        out.push({ kind: "track", p: q.slice(), dir: vunit(vsub(q, o)), id: it.id, layers: layer, width: widthOf(it.node, 0.25) });
      }
    }
  }
  return out;
}
/** The clicked primitive: the pad / via / track end of the snapped item, or the dangling end of the track under the point. */
export function dpClickedPrimitive(doc: BoardDoc, snap: SnapHit | null, p: Pt, netKey: string, layer: string) {
  const prims = dpPrimitives(doc, netKey, layer);
  if (snap && (snap.kind === "pad" || snap.kind === "via")) return prims.find((q) => q.kind === snap.kind && samePt(q.p, [snap.x, snap.y])) || null;
  // a track: its dangling anchor within half its width of the click (findDpEndingPrimitives' distThreshold)
  let best: DpEnd | null = null, bd = Infinity;
  for (const q of prims) { if (q.kind !== "track") continue; const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1]); if (d <= q.width! / 2 + 1e-6 && d < bd) { bd = d; best = q; } }
  return best;
}
/**
 * DIFF_PAIR_PLACER::FindDpPrimitivePair: the clicked primitive and the nearest primitive of the same kind (pads and
 * vias on the same layers) on the complementary net.  { pair: { P, N, nets, keys } } or { error }.
 */
export function findDpPrimitivePair(doc: BoardDoc, snap: SnapHit | null, p: Pt, layer: string, net: NetRef): { error: string; pair?: undefined } | { pair: DpPair; nets: { P: NetRef; N: NetRef }; keys: { P: string; N: string }; error?: undefined } {
  const nets = dpNetPair(doc, net); if (!nets) return { error: DP_MSG_NETS };
  const NT = netTable(doc); const refKey = NT.key(net), keyP = NT.key(nets.P), keyN = NT.key(nets.N);
  const ref = dpClickedPrimitive(doc, snap, p, refKey, layer); if (!ref) return { error: DP_MSG_START };
  const coupledKey = refKey === keyP ? keyN : keyP; let best: DpEnd | null = null, bd = Infinity;
  for (const q of dpPrimitives(doc, coupledKey, layer)) {
    if (q.kind !== ref.kind || (q.kind !== "track" && q.layers !== ref.layers)) continue;
    const d = Math.hypot(q.p[0] - ref.p[0], q.p[1] - ref.p[1]); if (d < bd) { bd = d; best = q; }
  }
  if (!best) return { error: DP_MSG_START };
  return { pair: refKey === keyP ? { P: ref, N: best } : { P: best, N: ref }, nets, keys: { P: keyP, N: keyN } };
}
/** A polyline offset sideways by `off` (left of travel positive), mitred at the corners; `inDir` the travel direction before the first point. */
export function offsetPts(pts: Pt[], off: number, inDir: Pt | null) {
  const nrm = (u: Pt): Pt => [-u[1], u[0]]; const out: Pt[] = [];
  const dirs: Pt[] = []; for (let i = 0; i + 1 < pts.length; i++) dirs.push(vunit(vsub(pts[i + 1], pts[i])));
  if (!dirs.length) return pts.length ? [vadd(pts[0], vmul(nrm(inDir || [1, 0]), off))] : [];
  for (let k = 0; k < pts.length; k++) {
    const u0 = k === 0 ? (inDir || dirs[0]) : dirs[k - 1], u1 = k < dirs.length ? dirs[k] : dirs[dirs.length - 1];
    const n0 = nrm(u0), n1 = nrm(u1); const den = 1 + n0[0] * n1[0] + n0[1] * n1[1];
    const m = den < 1e-6 ? n1 : vmul(vadd(n0, n1), 1 / den);
    out.push(rp(vadd(pts[k], vmul(m, off))));
  }
  return out;
}
/**
 * The gateway a pair leaves through (DP_GATEWAYS::BuildFromPrimitivePair, reduced to the exits the router ends up
 * taking): the exit direction (the tracks' own for a pair of track ends, else the 45° direction nearest the cursor
 * that does not run along the pads' axis, perpendicular preferred), the centre point where both lines are coupled at
 * the pair's gap, which side the P line is on, and each anchor's 45° entry into its coupled line.
 */
export function dpGateway(pair: DpPair, toward: Pt, h: number) {
  const aP = pair.P.p, aN = pair.N.p; const M = [(aP[0] + aN[0]) / 2, (aP[1] + aN[1]) / 2];
  const axis = vunit(vsub(aP, aN)); const perp = [-axis[1], axis[0]];
  let cands: Pt[];
  if (pair.P.dir && pair.N.dir && Math.abs(pair.P.dir[0] * pair.N.dir[0] + pair.P.dir[1] * pair.N.dir[1] - 1) < 1e-3) cands = [DIRS8[dir8([0, 0], pair.P.dir)]];   // parallel track ends: carry on
  else cands = DIRS8;
  const want = toward && !samePt(toward, M) ? vunit(vsub(toward, M)) : perp;
  let best: { d: Pt; n: Pt; tP: number; score: number } | null = null;
  for (const d of cands) {
    const n = [-d[1], d[0]]; const tP = (aP[0] - M[0]) * n[0] + (aP[1] - M[1]) * n[1];
    if (Math.abs(tP) < 1e-6) continue;   // the pads lie along the exit: the lines would cross
    const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * want[0] + d[1] * want[1])));
    const offPerp = Math.acos(Math.min(1, Math.abs(d[0] * perp[0] + d[1] * perp[1])));
    const score = ang + 1.2 * offPerp;   // the exit square to the pads is the one the gateways favour
    if (!best || score < best.score - 1e-9) best = { d, n, tP, score };
  }
  if (!best) return null;
  const { d, n, tP } = best; const sideP = tP > 0 ? 1 : -1;
  const alongP = (aP[0] - M[0]) * d[0] + (aP[1] - M[1]) * d[1], lat = Math.abs(Math.abs(tP) - h);
  const L = Math.max(alongP, -alongP) + lat;
  const mid = rp(vadd(M, vmul(d, L))); const sP = rp(vadd(mid, vmul(n, sideP * h))), sN = rp(vadd(mid, vmul(n, -sideP * h)));
  const df = !isDiagDir(dir8([0, 0], d));   // converge first (45° off the exit), then run along it
  const entry = (a: Pt, s: Pt) => simplifyPts(legPts(a.map(r6), s, df).map(rp));
  return { d, dIdx: dir8([0, 0], d), n, sideP, mid, sP, sN, entryP: entry(aP, sP), entryN: entry(aN, sN), anchorP: aP.slice(), anchorN: aN.slice() };
}
/** The pair's sizes for a route of the nets (ROUTER_TOOL's size update) and the half spacing of the coupled lines. */
export function dpSizes(ctx: PcbCtx, nets: { P: NetRef; N?: NetRef }) { const d = sizesOf(ctx).routeDiffPair(nets.P.name || ""); return Object.assign({}, d, { h: (d.gap + d.width) / 2 }); }
/** The obstacles of a pair: everything on the layer but the copper of either net (rhMarkObstacles' filter). */
export function dpObstacles(ctx: PcbCtx, rt: Route) {
  const doc = routeDoc(ctx, rt); const key = S.docVer + "|" + rt.layer + "|" + rt.stages.length + "|" + rt.netKey;
  if (!rt.dpObs || rt.dpObs.key !== key || rt.dpObs.doc !== doc) {
    const O = routeObstacles(doc, settingsOf(ctx), rt.netKey, rt.layer, null);
    rt.dpObs = indexObstacles(O.list.filter((ob) => ob.net !== rt.netKeyN)); rt.dpObs.key = key; rt.dpObs.doc = doc;
  }
  return rt.dpObs;
}
/** The target pair under the cursor: a primitive of either net and its partner (routeHead's FindDpPrimitivePair on the end item). */
export function dpTarget(ctx: PcbCtx, rt: Route, snap: SnapHit | null | undefined) {
  if (!snap || !(snap.kind === "pad" || snap.kind === "via" || snap.kind === "track")) return null;
  if (!sameNet(snap.net, rt.net) && !sameNet(snap.net, rt.netN)) return null;
  const doc = routeDoc(ctx, rt); const r = findDpPrimitivePair(doc, snap, [snap.x, snap.y], rt.layer, snap.net);
  if (!r.pair) return null;
  const st = rt.dpStart; if (samePt(r.pair.P.p, st!.P.p) && samePt(r.pair.N.p, st!.N.p)) return null;   // the pair it starts from
  return r.pair;
}
/**
 * A centre line from the gateway towards `goal` that leaves along the gateway's direction: when the leg turns at once
 * it starts a little ahead, far enough for the inner line to make the turn (h·tan(θ/2)), so neither line doubles back.
 */
export function dpCentre(O: ObstacleIndex | null, gw: DpGateway, goal: Pt, R: number, rt: Route, mode: number) {
  const h = rt.dpSizes!.h;
  const along = (goal[0] - gw.mid[0]) * gw.d[0] + (goal[1] - gw.mid[1]) * gw.d[1];
  if (along <= 1e-6) return { pts: [gw.mid.slice()], reached: samePt(goal, gw.mid) };   // behind the gateway: hold at it
  // routeHead: a cursor within half the pair's pitch of the gateway's extension keeps the straight part only, projected
  const lead = Math.abs((goal[0] - gw.mid[0]) * gw.n[0] + (goal[1] - gw.mid[1]) * gw.n[1]);
  if (lead <= h) goal = rp(vadd(gw.mid, vmul(gw.d, along)));
  const run = (from: Pt) => {
    const a = legPts(from, goal, false), b = legPts(from, goal, true);
    const score = (p: Pt[]) => (p.length > 1 ? dirAngle(gw.dIdx, dir8(p[0], p[1])) : 0);
    let first = rt.diagFirst ? b : a; if (score(first === a ? b : a) < score(first)) first = first === a ? b : a;
    if (mode === RM_MARK || !O) return { pts: first, reached: true };
    return walkHead(O, from, goal, R, first === b, gw.dIdx);
  };
  let r = run(gw.mid);
  const turn = r.pts.length > 1 ? dirAngle(gw.dIdx, dir8(r.pts[0], r.pts[1])) : 0;
  if (turn >= 3) return { pts: [gw.mid.slice()], reached: false };   // an acute turn straight out of the gateway: no fit
  if (turn > 0) {
    const ahead = rp(vadd(gw.mid, vmul(gw.d, h * Math.tan(turn * Math.PI / 8) + 1e-3)));
    const r2 = run(ahead); r = { pts: simplifyPts([gw.mid.slice()].concat(r2.pts)), reached: r2.reached };
  }
  return r;
}
/**
 * DIFF_PAIR_PLACER::routeHead and the mode's walk: the two lines from the current pair towards the cursor (or onto a
 * target pair, or ending on a via pair), their collisions, and whether the fit is clean enough to fix (m_fitOk).
 */
export function dpUpdateHead(ctx: PcbCtx, hv: Hover | null) {
  const rt = S.route; if (!rt || !ctx.doc) return;
  const rs = S.rs; const sz = rt.dpSizes; const h = sz!.h; const R = h + sz!.width / 2;
  trailAdd(rt.tracer, rt.cursor);
  if (rs.auto_posture || rt.tracer.manuallyForced) rt.diagFirst = isDiagDir(tracerPosture(rt.tracer, rt.cursor));
  const O = dpObstacles(ctx, rt); const mode = rs.mode;
  const gw = dpGateway(rt.dpStart!, rt.cursor, h); rt.dpGw = gw; rt.collisions = null; rt.dpTargetPair = null;
  if (!gw) { rt.dpLines = null; rt.dpFit = false; return; }
  const target = rt.placingVia ? null : dpTarget(ctx, rt, hv && hv.snap as SnapHit | null);
  let centre: Pt[] | undefined, reached = true, tail: DpGateway | null = null;
  if (target) {
    const tg = dpGateway(target, gw.mid, h);
    // the pair has to arrive on the target with P on P's side: travelling into the target the left / right swap
    if (tg && tg.sideP === -gw.sideP) {
      const back = rp(vadd(tg.mid, vmul(tg.d, h + 1e-3)));   // room for the inner line to turn in
      const c = dpCentre(mode === RM_MARK ? null : O, gw, back, R, rt, mode);
      if (c.reached && samePt(c.pts[c.pts.length - 1], back)) { centre = simplifyPts(c.pts.concat([tg.mid.slice()])); tail = tg; rt.dpTargetPair = target; }
    }
  }
  if (!centre) { const c = dpCentre(mode === RM_MARK ? null : O, gw, rt.cursor, R, rt, mode); centre = c.pts; reached = c.reached; }
  // a last run too short to carry both lines round its corner would fold the inner line back: the head stops before it
  while (!tail && centre.length > 2 && Math.hypot(centre[centre.length - 1][0] - centre[centre.length - 2][0], centre[centre.length - 1][1] - centre[centre.length - 2][1]) < 2 * h * TAN_22_5 + 1e-3) centre = centre.slice(0, -1);
  const lastDir = centre.length > 1 ? vunit(vsub(centre[centre.length - 1], centre[centre.length - 2])) : gw.d;
  let P = chainAppend(gw.entryP.map((q) => q.slice()), offsetPts(centre, gw.sideP * h, gw.d));
  let N = chainAppend(gw.entryN.map((q) => q.slice()), offsetPts(centre, -gw.sideP * h, gw.d));
  if (tail) { chainAppend(P, tail.entryP.slice().reverse()); chainAppend(N, tail.entryN.slice().reverse()); }
  let vias: DpLines["vias"] = null;
  if (rt.placingVia && centre.length) {
    // DP_GATEWAYS::SetFitVias: the lines fan out (or in) at 45° to two vias spaced at the via gap
    const e = centre[centre.length - 1]; const n = [-lastDir[1], lastDir[0]]; const hv2 = (sz!.viaGap + rt.placingVia.diameter) / 2;
    const k = Math.abs(hv2 - h); const c2 = vadd(e, vmul(lastDir, k));
    const vP = rp(vadd(c2, vmul(n, gw.sideP * hv2))), vN = rp(vadd(c2, vmul(n, -gw.sideP * hv2)));
    chainAppend(P, [vP]); chainAppend(N, [vN]); vias = { P: vP, N: vN };
  }
  P = simplifyPts(P); N = simplifyPts(N);
  rt.dpLines = { P, N, centre, lastDir, vias }; rt.reached = reached;
  rt.head = centre; rt.target = centre[centre.length - 1].slice();
  // collisions: both lines (and the vias) against everything but the pair's own nets
  const hits = new Set<Obstacle>(); for (const L of [P, N]) for (const ob of pathHits(O, L, sz!.width / 2)) hits.add(ob);
  if (vias) for (const L of viaSpanLayers(routeDoc(ctx, rt), rt.placingVia!.span)) {
    const OL = L === rt.layer ? O : indexObstacles(routeObstacles(routeDoc(ctx, rt), settingsOf(ctx), rt.netKey, L, null).list.filter((ob) => ob.net !== rt.netKeyN));
    for (const v of [vias.P, vias.N]) for (const ob of pathHits(OL, [v], rt.placingVia!.diameter / 2)) hits.add(ob);
  }
  rt.collisions = hits.size ? Array.from(hits) : null;
  rt.dpFit = !hits.size && P.length > 1 && N.length > 1;
  rt.els = []; rt.ratline = dpRatlines(routeCtx(ctx, rt), rt);
}
/** updateLeadingRatLine for both nets: from each line's end to the nearest unconnected anchor of its net. */
export function dpRatlines(ctx: PcbCtx, rt: Route) {
  const L = rt.dpLines; if (!L) return null; const out: Ratline[] = [];
  for (const [line, net, key] of [[L.P, rt.net, rt.netKey], [L.N, rt.netN, rt.netKeyN]] as [Pt[], NetRef, string][]) {
    // the route as LeadingRatLine reads it, for one net
    const fake = { netKey: key, net, target: line[line.length - 1], last: line[0], layer: rt.layer, start: null, startLayer: rt.layer };
    const r = leadingRatline(ctx, fake as unknown as Route); if (r) out.push(r);
  }
  return out.length ? out : null;
}
/** ROUTER::StartRouting in PNS_MODE_ROUTE_DIFF_PAIR: the start checks, then the placer's start pair. */
export function dpStart(ctx: PcbCtx, hv: Hover, mm: Pt) {
  const p = [hv.x, hv.y]; const doc = ctx.doc; const layer = S.layer;
  const snap = hv.snap && hv.snap.kind !== "anchor" ? hv.snap as SnapHit : null;
  let net: NetRef | null = snap ? snap.net : null, s2 = snap;
  if (!snap) { const on = trackUnder(doc, mm ? mm[0] : hv.x, mm ? mm[1] : hv.y, layer); if (on) { net = netOf(on.item.node); s2 = { kind: "track", x: on.point[0], y: on.point[1], net, id: on.item.id }; } }
  if (!s2 || !hasNet(net)) { ctx.toast(DP_MSG_NOWHERE); return; }
  if (!/\.Cu$/.test(layer)) { ctx.toast("Tracks on Copper layers only."); return; }
  const nets = dpNetPair(doc, net!); if (!nets) { ctx.toast(DP_MSG_NETS); return; }
  const sizes = dpSizes(ctx, nets);
  if (!S.rs.can_violate_drc && sizes.gap < (settingsOf(ctx).minClearance || 0) - 1e-9) { ctx.toast(DP_MSG_GAP); return; }
  const fp = findDpPrimitivePair(doc, s2.kind === "track" ? null : s2, [s2.x, s2.y], layer, net!); if (fp.error) { ctx.toast(fp.error); return; }
  const NT = netTable(doc);
  S.route = { dp: true, start: p.slice(), startLayer: layer, startKind: s2.kind, last: p.slice(), target: p.slice(), cursor: p.slice(), head: [p.slice()], els: [], reached: true,
    net: nets.P, netKey: NT.key(nets.P), netN: nets.N, netKeyN: NT.key(nets.N), layer, width: sizes.width, dpSizes: sizes, dpStart: fp.pair, dpLines: null, dpFit: false,
    diagFirst: !!S.rs.start_diagonal, clickT: Date.now(), clickAt: p.slice(), stages: [], split: null, startIds: [fp.pair!.P.id!, fp.pair!.N.id!], ratline: null, placingVia: null, chained: false,
    collisions: null, shove: null, tracer: newTracer(sizes.width, -1), keepHighlight: false };
  const rt = S.route; trailAdd(rt.tracer, p);
  const R = sizesOf(ctx); if (R.activeLayer !== layer) R.setActiveLayer(layer);
  routeHighlight(ctx, rt); dpUpdateHead(ctx, hv); refreshChip(ctx); ctx.requestRender();
}
/** DIFF_PAIR_PLACER::FixRoute: both lines (and the via pair) onto the route's branch; false when the fit is not clean. */
export function dpFix(ctx: PcbCtx, opts?: { finish?: boolean }) {
  opts = opts || {}; const rt = S.route; const L = rt!.dpLines; const rs = S.rs;
  if (!L || L.P.length < 2 || L.N.length < 2) return false;
  if (!rt!.dpFit && !(rs.mode === RM_MARK && rs.can_violate_drc)) { if (rt!.collisions) showViolations(rt!.collisions, rt!.target); return false; }
  const doc = routeDoc(ctx, rt!); const seg = (pts: Pt[]) => pts.slice(0, -1).map((a: Pt, i: number) => ({ t: "seg" as const, a: a.slice(), b: pts[i + 1].slice() }));
  let P = L.P, N = L.N;
  if (!rs.fix_all_segments && !opts.finish && !rt!.dpTargetPair && !L.vias && P.length > 2 && N.length > 2) { P = P.slice(0, -1); N = N.slice(0, -1); }
  const ops = trackOps(doc, seg(P), (rt!.dpSizes)!.width, rt!.layer, rt!.net).concat(trackOps(doc, seg(N), (rt!.dpSizes)!.width, rt!.layer, (rt!.netN)!));
  let nextPair: DpPair;
  if (L.vias) {
    const v = rt!.placingVia; const layers = v!.type === "through" ? viaSpan(doc) : [v!.span[0], v!.span[1]];
    for (const [at, net] of [[L.vias.P, rt!.net], [L.vias.N, rt!.netN]] as [Pt, NetRef][]) { const node = viaNode(doc, at[0], at[1], v!.diameter, v!.drill, net, layers); if (v!.type !== "through") node.splice(1, 0, v!.type); node.push(["uuid", K.newUuid()]); ops.push({ add: node }); }
    nextPair = { P: { kind: "via", p: L.vias.P.slice(), dir: null }, N: { kind: "via", p: L.vias.N.slice(), dir: null } };
  } else {
    const dP = vunit(vsub(P[P.length - 1], P[P.length - 2])), dN = vunit(vsub(N[N.length - 1], N[N.length - 2]));
    nextPair = { P: { kind: "track", p: P[P.length - 1].slice(), dir: dP }, N: { kind: "track", p: N[N.length - 1].slice(), dir: dN } };
  }
  const prevDir = P.length > 1 ? dir8(P[P.length - 2], P[P.length - 1]) : -1;
  rt!.stages.push({ ops, from: rt!.last.slice(), layer: rt!.layer, net: rt!.net, netKey: rt!.netKey, placingVia: rt!.placingVia, startIds: rt!.startIds, split: null, dir: rt!.tracer.lastSegDir, dpStart: rt!.dpStart });
  rt!.bdoc = null; rt!.obs = null; rt!.dpObs = null; rt!.dpStart = nextPair; rt!.last = nextPair.P.p.slice(); rt!.startIds = [];
  rt!.dpLines = null; rt!.head = [rt!.last.slice()]; rt!.target = rt!.last.slice(); rt!.ratline = null; rt!.collisions = null;
  if (P.length > 2) rt!.diagFirst = !isDiagDir(dir8(P[P.length - 3], P[P.length - 2]));   // m_initialDiagonal
  if (L.vias) { rt!.layer = (rt!.placingVia)!.toLayer; S.layer = rt!.layer; sizesOf(ctx).setActiveLayer(rt!.layer); rt!.placingVia = null; rt!.tracer = newTracer(rt!.width, -1); }
  else rt!.tracer = newTracer(rt!.width, prevDir);
  rt!.chained = !L.vias; trailAdd(rt!.tracer, rt!.last);
  return true;
}
/** A click while routing a pair: fix both lines; landing on a target pair ends the route. */
export function dpClick(ctx: PcbCtx, hv: Hover, mm: Pt, opts?: { enter?: boolean }) {
  opts = opts || {}; const now = Date.now(); const p = [hv.x, hv.y]; S.violations = null;
  if (!S.route) { dpStart(ctx, hv, mm); return; }
  const rt = S.route;
  const dbl = !opts.enter && now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  rt.cursor = p.slice(); dpUpdateHead(ctx, hv);
  const landed = !!rt.dpTargetPair;
  if (!dpFix(ctx, { finish: landed })) { ctx.requestRender(); return; }
  if (landed) { endRoute(ctx, false); return; }
  dpUpdateHead(ctx, hv); routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender();
}
/** Backspace while routing a pair (UnfixRoute): the last fixed stage comes off and the pair it started from is current again. */
export function dpUndoLeg(ctx: PcbCtx) {
  const rt = S.route; const st = rt && rt.stages.pop(); if (!st) return false;
  rt.bdoc = null; rt.obs = null; rt.dpObs = null; rt.dpStart = st.dpStart; rt.last = st.from.slice(); rt.startIds = st.startIds || []; rt.placingVia = null;
  if (st.layer !== rt.layer) { rt.layer = st.layer; S.layer = st.layer; sizesOf(ctx).setActiveLayer(st.layer); }
  rt.tracer = newTracer(rt.width, rt.stages.length ? st.dir : -1); trailAdd(rt.tracer, rt.last); rt.dpLines = null;
  rt.chained = rt.stages.length > 0 && !rt.stages[rt.stages.length - 1].placingVia;
  dpUpdateHead(ctx, S.hover); routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender(); return true;
}
/** DIFF_PAIR_PLACER::ToggleVia: a via pair at the lines' ends, through to the routing pair's other layer (or `target`). */
export function dpToggleVia(ctx: PcbCtx, type?: string, target?: string) {
  const rt = S.route; if (!rt) return false;
  if (rt.placingVia && !target) { rt.placingVia = null; S.layer = rt.layer; sizesOf(ctx).setActiveLayer(rt.layer); }
  else {
    const plan = viaPlan(ctx, Object.assign({}, rt, { ratAnchor: null }), type!, target);
    if (typeof plan === "string") { ctx.toast(plan); return true; }
    rt.placingVia = plan; sizesOf(ctx).setActiveLayer(plan.toLayer); S.layer = rt.layer;
  }
  dpUpdateHead(ctx, S.hover); refreshChip(ctx); ctx.requestRender(); return true;
}
/** DIFF_PAIR_PLACER::SetLayer: before anything is fixed the pair moves to the layer when both its pads / vias reach it; otherwise a via pair is armed. */
export function dpSetLayer(ctx: PcbCtx, layer: string) {
  const rt = S.route; if (layer === rt!.layer) { if (rt!.placingVia) dpToggleVia(ctx); return; }
  const st = rt!.dpStart; const doc = routeDoc(ctx, rt!);
  const reaches = (q: DpEnd) => q.kind === "pad" || q.kind === "via" ? dpPrimitives(doc, (q === st!.P ? rt!.netKey : rt!.netKeyN)!, layer).some((x) => x.kind === q.kind && samePt(x.p, q.p)) : false;
  if (!rt!.placingVia && ((!rt!.stages.length && reaches(st!.P) && reaches(st!.N)) || (rt!.stages.length && !rt!.chained))) {
    rt!.layer = layer; S.layer = layer; sizesOf(ctx).setActiveLayer(layer); rt!.dpObs = null; rt!.tracer = newTracer(rt!.width, -1); trailAdd(rt!.tracer, rt!.last);
    dpUpdateHead(ctx, S.hover); refreshChip(ctx); ctx.requestRender(); return;
  }
  rt!.placingVia = null; dpToggleVia(ctx, "through", layer);
}
/** The pair being routed: both lines with the clearance halo, the via pair, and the leading ratsnest of both nets. */
export function drawDpRoute(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  const rt = S.route; const L = rt!.dpLines; const w = (rt!.dpSizes)!.width; const clr = routeHaloClearance(ctx, rt!);
  const marks = rt!.collisions || [];
  for (const ob of marks) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
  if (L) {
    c.globalAlpha = 0.7; c.strokeStyle = HALO_COLOR; c.lineWidth = w + 2 * clr; polyline(c, L.P, false); polyline(c, L.N, false);
    c.globalAlpha = 0.8; c.strokeStyle = saturated(color(rt!.layer)); c.lineWidth = w; polyline(c, L.P, false); polyline(c, L.N, false);
    if (L.vias && rt!.placingVia) for (const at of [L.vias.P, L.vias.N]) {
      c.globalAlpha = 0.7; c.fillStyle = HALO_COLOR; c.beginPath(); c.arc(at[0], at[1], rt!.placingVia.diameter / 2 + clr, 0, 2 * Math.PI); c.fill();
      drawViaPreview(c, at, rt!.placingVia.diameter, rt!.placingVia.drill, px, 0.8);
    }
  }
  if (rt!.ratline && S.showRatsnest) { c.globalAlpha = 1; c.strokeStyle = RATSNEST_LEAD; c.lineWidth = 1 * px; for (const r of rt!.ratline as Ratline[]) line(c, r[0], r[1]); }
}
