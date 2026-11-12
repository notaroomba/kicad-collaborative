// pcb-tools/branch.ts — the route's branch: the router's NODE until CommitRouting, and the head it carries.
import type { BoardDoc, BranchCache, BranchOp, Obstacle, PcbChange, PcbCtx, Pt, Route } from "./types";
import { removedChange, replacedChange, upsertChange } from "./changes";
import { copperOf, settingsOf } from "./dialogs";
import { dpUpdateHead } from "./diffpair";
import { rp } from "./dragger";
import { netClearance } from "./drc";
import { netOf } from "./nets";
import { cornerLeg, headElems } from "./posture";
import { jointAt, loopRemovals } from "./redundant";
import { boxNearest, firstHit, leadingRatline, polyNearest, trackOps } from "./route-fix";
import { CM_M45, CM_R45, RM_MARK, RM_SHOVE, RM_WALK, is90 } from "./router-settings";
import { shoveHead } from "./shove";
import { runSmartPads } from "./smartpads";
import { K, S } from "./state";
import { tracerPosture, trailAdd } from "./tracer";
import { hullOf, isDiagDir, pathClear, pathHits, routeObstacles, walkHead } from "./walkaround";

// ---------------------------------------------------------------- the route's branch: ROUTER's NODE until CommitRouting
// Everything fixed while one track is routed (its segments, vias, broken tracks and what Shove pushed aside) lives on a
// branch of the board — a document with its own item map — and goes to the board as ONE commit when the route ends.
// Escape drops the branch (LINE_PLACER::AbortPlacement), Backspace pops the last fixed stage (UnfixRoute).
export function branchDoc(doc: BoardDoc, ops?: BranchOp[] | null) {
  const b = Object.assign({}, doc, { items: new Map(doc.items), __bc: {} as BranchCache, __base: doc, __stale: 0 });
  ops = ops || [];
  // The branch is rebuilt on the live board, which collaborators edit while the route is open.  A { set } / { del }
  // carries the text of the item it was computed from (op.base); when that item is gone or has changed since, the edit
  // is stale and is left out — with the rest of its group (one shoved line, one split track) — so committing the route
  // never brings back an item someone deleted or overwrites their change with the copy the router saw
  // (CommitRouting writes the router's diff onto the live items; it never resurrects them).
  for (let i = 0; i < ops.length;) {
    let j = i + 1; const g = ops[i].grp; if (g) while (j < ops.length && ops[j].grp === g) j++;
    const chunk = ops.slice(i, j); i = j;
    if (chunk.every((op) => branchOpFresh(b, op))) for (const op of chunk) applyBranchOp(b, op); else b.__stale += chunk.length;
  }
  return b;
}
/** Whether a branch edit still applies: its target item is there and unchanged since the edit was computed. */
export function branchOpFresh(b: BoardDoc, op: BranchOp) {
  const id = op.set || op.del; if (!id || op.base == null) return true;
  const cur = b.items.get(id); return !!cur && K.serialize(cur.node) === op.base;
}
/** Stamp a { set } / { del } with the item it was computed from (see branchDoc). */
export function opOn(it: KItem, op: BranchOp, grp?: object) { op.base = K.serialize(it.node); if (grp) op.grp = grp; return op; }
/** One branch edit: { add: node } | { del: id } | { set: id, node } (the node keeps the item's uuid). */
export function applyBranchOp(b: BoardDoc, op: BranchOp) {
  if (op.del) { b.items.delete(op.del); return; }
  if (op.set) { b.items.delete(op.set); K.createItem(b, op.node!); return; }
  if (op.add) K.createItem(b, op.add);
}
/** The board changes that turn `doc` into the branch: added, modified and removed items. */
export function branchChanges(doc: BoardDoc, b: BoardDoc) {
  const out: PcbChange[] = [];
  for (const [id, it] of b.items) { const o = doc.items.get(id); if (!o) out.push(upsertChange(it, "ADDED", netOf(it.node))); else if (o.node !== it.node) out.push(replacedChange(o, it.node)); }
  for (const [id, o] of doc.items) if (!b.items.has(id)) out.push(removedChange(o));
  return out;
}
/** The route's working document: the board plus its fixed stages. */
export function routeDoc(ctx: PcbCtx, rt: Route): BoardDoc {
  if (!rt.stages.length) return ctx.doc;
  if (!rt.bdoc || rt.bdoc.__base !== ctx.doc || rt.bdocVer !== S.docVer) { rt.bdoc = branchDoc(ctx.doc, rt.stages.flatMap((s) => s.ops)); rt.bdocVer = S.docVer; }
  return rt.bdoc;
}
/** The tool context with the route's document in place of the board's (what the router's queries see). */
export function routeCtx(ctx: PcbCtx, rt: Route): PcbCtx { const d = routeDoc(ctx, rt); if (d === ctx.doc) return ctx; const rc = Object.create(ctx); rc.doc = d; return rc; }
/** A route without a net does not collide with itself: its start item. */
export function routeOwn(rt: Route) {
  const s = new Set<string>(rt.startIds || []); for (const st of rt.stages) { for (const id of st.startIds || []) s.add(id); for (const op of st.ops) if (op.add && op.add[0] !== "footprint") { const u = K.kid(op.add, "uuid"); if (u) s.add(K.str(u[1])); } }
  return s;
}
export function routeObs(ctx: PcbCtx, rt: Route, layer?: string) {
  layer = layer || rt.layer; const doc = routeDoc(ctx, rt); const key = S.docVer + "|" + layer + "|" + rt.width + "|" + rt.stages.length + "|" + rt.netKey;
  if (!rt.obs || rt.obs.key !== key || rt.obs.doc !== doc) { rt.obs = routeObstacles(doc, settingsOf(ctx), rt.netKey, layer, rt.netKey ? null : routeOwn(rt)); rt.obs.key = key; rt.obs.doc = doc; }
  return rt.obs;
}
/** ROUTING_SETTINGS' displayed clearance (ImportSizes): the routed net's class clearance, never below the board minimum. */
export function routeHaloClearance(ctx: PcbCtx, rt: Route) { const s = settingsOf(ctx); return Math.max(netClearance(s, rt.netKey), s.minClearance || 0); }
/** The via being carried at the head's end (ToggleViaPlacement): its sizes and the copper it spans. */
export function headVia(ctx: PcbCtx, rt: Route) {
  const pv = rt.placingVia; if (!pv) return null;
  const end = rt.head && rt.head.length ? rt.head[rt.head.length - 1] : rt.last;
  return { at: end.slice(), diameter: pv.diameter, drill: pv.drill, layers: pv.span, type: pv.type };
}
/** Every obstacle the carried via violates, on each copper layer it spans. */
export function viaHits(ctx: PcbCtx, rt: Route, via: { at: Pt; diameter: number; layers: string[] }) {
  const doc = routeDoc(ctx, rt), s = settingsOf(ctx), own = rt.netKey ? null : routeOwn(rt); const out: Obstacle[] = [];
  for (const L of viaSpanLayers(doc, via.layers)) for (const ob of pathHits(routeObstacles(doc, s, rt.netKey, L, own), [via.at], via.diameter / 2)) if (!out.includes(ob)) out.push(ob);
  return out;
}
/** The copper layers between two layers of a via, inclusive, in stack order. */
export function viaSpanLayers(doc: BoardDoc, pair: string[]) {
  const cu = K.pcbSizes.copperStack(copperOf(doc)); const i = cu.indexOf(pair[0]), j = cu.indexOf(pair[pair.length - 1]);
  if (i < 0 || j < 0) return pair.slice(); return cu.slice(Math.min(i, j), Math.max(i, j) + 1);
}
/**
 * LINE_PLACER::Move → routeHead: the posture from the mouse trail, then the head built for the router mode —
 * Highlight collisions: straight to the cursor (snapped onto the first obstacle's hull when the cursor is within half
 * a track width of it), collisions marked; Shove: walked around the solids, the tracks and vias in the way pushed
 * aside (Walk around when the shove cannot be done); Walk around: walked around every obstacle.
 */
export function updateHead(ctx: PcbCtx) {
  const rt = S.route; if (!rt || !ctx.doc) return;
  if (rt.dp) { dpUpdateHead(ctx, S.hover); return; }
  const rs = S.rs, rc = routeCtx(ctx, rt), O = routeObs(ctx, rt); const r = rt.width / 2;
  trailAdd(rt.tracer, rt.cursor);
  // MOUSE_TRAIL_TRACER: the posture follows the mouse unless "Use mouse path to set track posture" is off (then the
  // last segment's direction, or the initial direction)
  if (rs.auto_posture || rt.tracer.manuallyForced) rt.diagFirst = isDiagDir(tracerPosture(rt.tracer, rt.cursor));
  else rt.diagFirst = rt.tracer.lastSegDir >= 0 ? isDiagDir(rt.tracer.lastSegDir) : !!rs.start_diagonal;
  const cm = rs.corner_mode, free = rs.mode === RM_MARK && rs.free_angle_mode;
  const leg = (a: Pt, b: Pt, df: boolean) => cornerLeg(a, b, df, cm, false);
  rt.collisions = null; rt.shove = null; rt.viaBad = null;
  const via = headVia(ctx, rt);
  if (rs.mode === RM_MARK) {
    let pts = cornerLeg(rt.last, rt.cursor, rt.diagFirst, cm, free); let hits = pathHits(O, pts, r);
    if (hits.length) {   // snap to the hull of the first obstacle (rhMarkObstacles)
      const ob = firstHit(O, pts, r) || hits[0]; const H = hullOf(ob, r);
      const near = is90(cm) ? boxNearest(H, rt.cursor) : polyNearest(H, rt.cursor);
      if (Math.hypot(near[0] - rt.cursor[0], near[1] - rt.cursor[1]) < r) { pts = cornerLeg(rt.last, rp(near), rt.diagFirst, cm, free); hits = pathHits(O, pts, r); }
    }
    rt.head = pts; rt.reached = true;
    if (via) { rt.head.length && (via.at = rt.head[rt.head.length - 1].slice()); for (const ob of viaHits(ctx, rt, via)) if (!hits.includes(ob)) hits.push(ob); }
    rt.collisions = hits.length ? hits : null;
  } else if (rs.mode === RM_SHOVE) {
    const res = shoveHead(rc, rt, leg);
    if (res) { rt.head = res.pts; rt.reached = res.reached; rt.shove = res.shove; }
    else { const w = walkHead(O, rt.last, rt.cursor, r, rt.diagFirst, rt.tracer.lastSegDir, leg); rt.head = w.pts; rt.reached = w.reached; }
  } else {
    const res = walkHead(O, rt.last, rt.cursor, r, rt.diagFirst, rt.tracer.lastSegDir, leg);
    rt.head = res.pts; rt.reached = res.reached;
  }
  // rhWalkOnly / rhShoveOnly: OPTIMIZER::SMART_PADS with "Optimize pad connections" in the 45° corner modes, unless
  // the posture was forced by hand
  if (rs.smart_pads && rs.mode !== RM_MARK && (cm === CM_M45 || cm === CM_R45) && !rt.tracer.manuallyForced && rt.head.length >= 3) {
    const sp = runSmartPads(rc.doc, rt.head, rt.width, rt.layer, rt.netKey, (pts: Pt[]) => pathClear(O, pts, r));
    if (sp) rt.head = sp;
  }
  rt.target = rt.head[rt.head.length - 1].slice();
  if (via && rs.mode === RM_WALK) { const vh = viaHits(ctx, rt, Object.assign({}, via, { at: rt.target })); rt.viaBad = vh.length ? vh : null; }
  rt.els = headElems(rt.head, cm, rs.mode === RM_MARK ? null : (p: Pt[]) => pathClear(O, p, r));
  rt.ratline = leadingRatline(rc, rt);
  rt.loopHidden = previewLoops(ctx, rt, rc);
}
/**
 * LINE_PLACER::Move: when the head reaches an item of its net, removeLoops runs on the head's node, so the tracks it
 * would erase vanish from the preview.  The ids the board render leaves out, or null.
 */
export function previewLoops(ctx: PcbCtx, rt: Route, rc: PcbCtx) {
  if (!S.rs.remove_loops || !rt.reached || !rt.netKey || !rt.els || !rt.els.length) return null;
  const doc = rc.doc; if (!jointAt(doc, rt.layer, rt.target, rt.netKey).count) return null;
  const b = branchDoc(doc, trackOps(doc, rt.els, rt.width, rt.layer, rt.net));
  const ids = loopRemovals(ctx.doc, b); return ids.size ? ids : null;
}
