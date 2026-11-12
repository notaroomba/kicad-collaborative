// pcb-tools/route-fix.ts — the route's leading ratline, net highlight and FixRoute: the track ops a fixed leg adds.
import type { Antenna, BoardDoc, BranchOp, Cluster, Conductor, NetRef, Obstacle, ObstacleIndex, PcbCtx, Pt, Route, RouteSplit, SnapHit, TrackElem } from "./types";

/** The leading ratline: from the head's end to the nearest unconnected anchor of the net. */
export type Ratline = Pt[];
import { highlightIds } from "./actions";
import { netlistCached, sizesOf } from "./app-state";
import { headVia, opOn, routeDoc, routeObs } from "./branch";
import { addedChange, replacedChange } from "./changes";
import { copperOf } from "./dialogs";
import { boxesTouch, shapeGap } from "./distances";
import { peq } from "./dragger";
import { netHighlightIds, netTable } from "./netlist";
import { hasNet, netNode, netOf } from "./nets";
import { segmentNode, viaNode } from "./nodes";
import { closestOnSeg } from "./point-editor";
import { arcTrackNode, elemsPts } from "./posture";
import { dirOfElem } from "./redundant";
import { showViolations, viaSpan } from "./route-tool";
import { RM_MARK, RM_SHOVE } from "./router-settings";
import { solidObs } from "./shove";
import { K, S } from "./state";
import { newTracer, trailAdd } from "./tracer";
import { EPS } from "./transforms";
import { clone, layerOf, pt, r6, samePt } from "./util";
import { obstacleHit, obstaclesNear, pathClear, shapeCorePts } from "./walkaround";

/** NODE::NearestObstacle: the obstacle met first along the line. */
export function firstHit(O: ObstacleIndex, pts: Pt[], r: number) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]; let best: Obstacle | null = null, bd = Infinity;
    obstaclesNear(O, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], r, (ob) => {
      if (!obstacleHit(ob, a, b, r)) return false;
      const c = shapeCorePts(ob.shape); let d = Infinity; for (const p of c) d = Math.min(d, Math.hypot(p[0] - a[0], p[1] - a[1]));
      if (d < bd) { bd = d; best = ob; } return false;
    });
    if (best) return best;
  }
  return null;
}
/** SHAPE_LINE_CHAIN::NearestPoint on a closed polygon's outline. */
export function polyNearest(P: Pt[], p: Pt) { let best = P[0], bd = Infinity; for (let i = 0; i < P.length; i++) { const q = closestOnSeg(p, P[i], P[(i + 1) % P.length]); const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } } return best; }
/** BOX2::NearestPoint of the polygon's bounding box (the 90° corner modes). */
export function boxNearest(P: Pt[], p: Pt): Pt { const xs = P.map((q: Pt) => q[0]), ys = P.map((q: Pt) => q[1]); return [Math.max(Math.min(...xs), Math.min(Math.max(...xs), p[0])), Math.max(Math.min(...ys), Math.min(Math.max(...ys), p[1]))]; }
/**
 * TOPOLOGY::LeadingRatLine: from the head's end to the nearest anchor of the routed net that is not already connected
 * to the line (its start's copper, or what its end lands on).  None for a route without a net.  The anchor's copper
 * layers ride along (ROUTER::GetNearestRatnestAnchor, which picks a through via's target layer).
 */
export function leadingRatline(ctx: PcbCtx, rt: Route): Ratline | null {
  rt.ratAnchor = null; if (!rt.netKey) return null;
  const nl = netlistCached(ctx.doc); const net = nl.nets.get(rt.netKey); if (!net) return null;
  const end = rt.target; const probe = (p: Pt) => ({ t: "circle" as const, x: p[0], y: p[1], r: 0 });
  const touches = (cl: Cluster, p: Pt, layer: string) => cl.items.some((c) => c.kind !== "zone" && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, probe(p)) <= EPS);
  let best: Cluster["anchors"][number] | null = null, bd = Infinity, bcl: Cluster | null = null;
  for (const cl of net.clusters) {
    if (touches(cl, rt.last, rt.layer) || touches(cl, end, rt.layer) || (rt.start && touches(cl, rt.start, rt.startLayer))) continue;
    for (const a of cl.anchors) { const d = Math.hypot(a.p[0] - end[0], a.p[1] - end[1]); if (d < bd) { bd = d; best = a; bcl = cl; } }
  }
  rt.ratAnchor = null; if (!best) return null;
  const b0 = best, cond: Conductor | undefined = bcl!.items.find((c) => c.id === b0.id && c.anchors.some((q: Pt) => samePt(q, b0.p))) || bcl!.items.find((c) => c.id === b0.id);
  rt.ratAnchor = { p: best.p.slice(), layers: cond ? Array.from(cond.layers) : [], through: !!cond && (cond.kind === "pad" ? cond.pad.type === "thru_hole" : cond.kind === "via" ? cond.layers.size >= copperOf(ctx.doc).length : false) };
  return [end.slice(), best.p.slice()];
}
/** highlightNets( true, { net } ): the routed net brightened, the rest dimmed; a highlight the user had on that net is kept for afterwards. */
export function routeHighlight(ctx: PcbCtx, rt: Route | null) {
  if (!rt || !rt.netKey) return; const d = routeDoc(ctx, rt); const ids = netHighlightIds(d, rt.netKey, netlistCached(d));
  if (rt.netKeyN) for (const id of netHighlightIds(d, rt.netKeyN, netlistCached(d))) ids.add(id);   // a differential pair: both nets
  highlightIds(ctx, ids);
}
export function routeUnhighlight(ctx: PcbCtx | null, rt: (Pick<Route, "netKey"> & { keepHighlight?: unknown }) | null) {
  if (!ctx || !rt || !rt.netKey) return;
  if (rt.keepHighlight && S.highlightNet === rt.netKey) highlightIds(ctx, netHighlightIds(ctx.doc, rt.netKey, netlistCached(ctx.doc)));
  else { S.highlightNet = null; highlightIds(ctx, null); }
}
/** The branch edits that add a line's elements as tracks (segments, and arcs in the rounded corner modes). */
export const MICRO_SEG = 0.01;   // a walked or snapped line's sliver under 10 µm folds into its neighbour (no micro segments on the board)
export function foldMicro(els: TrackElem[]): TrackElem[] {
  const out = els.map((e) => Object.assign({}, e));
  for (let i = 0; i < out.length && out.length > 1; i++) {
    const e = out[i]; if (e.t !== "seg" || Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) >= MICRO_SEG) continue;
    const prev = out[i - 1], next = out[i + 1];
    if (prev && prev.t === "seg") prev.b = e.b.slice(); else if (next && next.t === "seg") next.a = e.a.slice(); else continue;
    out.splice(i, 1); i--;
  }
  // a head that is nothing but a sliver (the cursor a hair off the last fixed point) adds no track
  return out.length === 1 && out[0].t === "seg" && Math.hypot(out[0].b[0] - out[0].a[0], out[0].b[1] - out[0].a[1]) < MICRO_SEG ? [] : out;
}
export function trackOps(doc: BoardDoc, els: TrackElem[], width: number, layer: string, net: NetRef) {
  const ops: BranchOp[] = [];
  for (const e of foldMicro(els)) {
    if (peq(e.a, e.b)) continue;
    const node = e.t === "arc" ? arcTrackNode(doc, e.a, e.m, e.b, width, layer, net) : segmentNode(doc, e.a, e.b, width, layer, net);
    node.push(["uuid", K.newUuid()]); ops.push({ add: node });
  }
  return ops;
}
/** The branch edits that break a track at a point (splitAdjacentSegments): the track ends there, a new one carries on. */
export function splitOps(doc: BoardDoc, split: RouteSplit): BranchOp[] {
  const it = doc.items.get(split.id); if (!it || it.kind !== "segment" || K.serialize(it.node) !== K.serialize(split.node)) return [];
  const a = pt(it.node, "start"), b = pt(it.node, "end"), p = split.point; if (!a || !b || samePt(a, p) || samePt(b, p)) return [];
  const head = clone(it.node); K.kid(head, "end")!.splice(1, 2, r6(p[0]), r6(p[1]));
  const tail = clone(it.node); const u = K.kid(tail, "uuid"); if (u) tail.splice(tail.indexOf(u), 1);
  K.kid(tail, "start")!.splice(1, 2, r6(p[0]), r6(p[1])); tail.push(["uuid", K.newUuid()]);
  const grp = {}; return [opOn(it, { set: it.id, node: head }, grp), { add: tail, grp }];
}
/** splitAdjacentSegments as board changes (exported for the tests and the autorouter). */
export function splitChanges(doc: BoardDoc, split: RouteSplit) {
  return splitOps(doc, split).map((op) => op.set ? replacedChange(doc.items.get(op.set)!, op.node!) : addedChange(doc, op.add!, netOf(op.add!)));
}
/** FixRoute( forceFinish = false ) in Highlight collisions: the end item and a net-less trace adopt each other's net. */
export function adoptNetOps(doc: BoardDoc, rt: Route, snap: SnapHit | null | undefined) {
  if (!snap) return [];
  if (!rt.netKey && hasNet(snap.net)) { rt.net = snap.net; rt.netKey = netTable(doc).key(snap.net); return []; }
  if (rt.netKey && !hasNet(snap.net)) {
    if (snap.kind === "pad" && snap.fp) {
      const fp = doc.items.get(snap.fp); if (!fp) return []; const node = clone(fp.node); const pad = K.kids(node, "pad")[snap.padIndex!]; if (!pad) return [];
      const nk = K.kid(pad, "net"); const nn = netNode(doc, rt.net); if (nk) pad.splice(pad.indexOf(nk), 1, nn); else pad.splice(pad.length - 1, 0, nn);
      return [opOn(fp, { set: fp.id, node })];
    }
    const it = snap.id ? doc.items.get(snap.id) : null; if (!it) return [];
    const node = clone(it.node); const nk = K.kid(node, "net"); const nn = netNode(doc, rt.net); if (nk) node.splice(node.indexOf(nk), 1, nn); else node.push(nn);
    return [opOn(it, { set: it.id, node })];
  }
  return [];
}
/**
 * LINE_PLACER::FixRoute: the head (and the via it carries) goes onto the route's branch; refused while it collides —
 * except in Highlight collisions with "Allow DRC violations", and in Shove only for collisions with solids.  With
 * "Fix all segments on click" off the last segment stays free unless the route ends or a via is placed.
 * Returns false when nothing was fixed.
 */
export function fixHead(ctx: PcbCtx, opts?: { finish?: boolean; snap?: SnapHit | null; endSplit?: RouteSplit | null }) {
  opts = opts || {}; const rt = S.route!; const rs = S.rs; const doc = routeDoc(ctx, rt);
  let els = rt.els && rt.els.length ? foldMicro(rt.els) : []; const via = headVia(ctx, rt);
  if (!els.length && !via) return false;
  const O = routeObs(ctx, rt); const r = rt.width / 2;
  if (!rs.can_violate_drc || rs.mode !== RM_MARK) {
    if (rs.mode === RM_MARK) { if (rt.collisions && rt.collisions.length) return false; }
    else if (!pathClear(rs.mode === RM_SHOVE ? solidObs(ctx, rt) : O, elemsPts(els.length ? els : [{ t: "seg", a: rt.last, b: rt.last }]), r)) return false;
    if (via && rs.mode !== RM_MARK && rt.viaBad) { showViolations(rt.viaBad, via.at); return false; }
  }
  const realEnd = !!opts.finish;
  if (!rs.fix_all_segments && !realEnd && !via && els.length > 1) els = els.slice(0, -1);
  const ops: BranchOp[] = [];
  if (rs.mode === RM_MARK && opts.snap) ops.push(...adoptNetOps(doc, rt, opts.snap));
  ops.push(...trackOps(doc, els, rt.width, rt.layer, rt.net));
  const antennas: Antenna[] = [];   // the tracks split at the route's start / end: removeAntennas looks at their halves when the route is committed
  const noteSplit = (sp: RouteSplit, sops: BranchOp[]) => { if (sops.length === 2 && sops[1].add) { const u = K.kid(sops[1].add, "uuid"); antennas.push({ p: sp.point.slice(), layer: layerOf(sp.node), ids: [sp.id, u ? K.str(u[1]) : ""] }); } return sops; };
  if (rt.split && els.length) { ops.push(...noteSplit(rt.split, splitOps(doc, rt.split))); rt.split = null; }
  if (opts.endSplit) ops.push(...noteSplit(opts.endSplit, splitOps(doc, opts.endSplit)));
  if (rt.shove && rs.mode === RM_SHOVE) ops.push(...rt.shove.ops);
  const end = els.length ? els[els.length - 1].b.slice() : rt.last.slice();
  if (via) { const node = viaNode(doc, end[0], end[1], via.diameter, via.drill, rt.net, via.type === "through" ? viaSpan(doc) : [via.layers[0], via.layers[1]]); if (via.type !== "through") node.splice(1, 0, via.type); node.push(["uuid", K.newUuid()]); ops.push({ add: node }); }
  const prevDir = els.length ? dirOfElem(els[els.length - 1]) : -1;
  rt.stages.push({ ops, from: rt.last.slice(), layer: rt.layer, net: rt.net, netKey: rt.netKey, placingVia: rt.placingVia, startIds: rt.startIds, split: rt.split, dir: rt.tracer.lastSegDir, antennas });
  rt.bdoc = null; rt.obs = null;
  rt.last = end; rt.head = [end.slice()]; rt.els = []; rt.target = end.slice(); rt.ratline = null; rt.shove = null; rt.collisions = null; rt.startIds = [];
  if (via) {   // switchLayerOnViaPlacement: on to the via's other layer
    rt.layer = rt.placingVia!.toLayer; S.layer = rt.layer; sizesOf(ctx).setActiveLayer(rt.layer); rt.placingVia = null;
    rt.tracer = newTracer(rt.width, -1);
  } else rt.tracer = newTracer(rt.width, prevDir);   // the next leg prefers to carry on the last segment's direction
  rt.chained = !via;
  trailAdd(rt.tracer, rt.last);
  return true;
}
