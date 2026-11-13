// pcb-tools/route-tool.ts — the route tool: start, click, end and abort, vias and the layer picker.
import type { BoardDoc, Hover, NetRef, Obstacle, PcbCtx, Pt, Route, RouteSplit, SnapHit, ViaPlan } from "./types";

/** What the layer picker is opened with: the copper layers, the current one, those it greys out, and where. */
export interface LayerPickerOpts { layers: string[]; current: string; disallow: Set<string>; at: Pt; client: unknown }
/** The layer picker: done(layer) with the picked layer, or done(null) on Cancel. */
export type LayerPicker = (opts: LayerPickerOpts, done: (layer: string | null) => void) => void;
import { runAction } from "./actions";
import { connectedWidth, hoverPoint, netNameOf, otherCopperLayers, sizesOf } from "./app-state";
import { branchChanges, routeCtx, routeDoc, updateHead } from "./branch";
import { addedChange } from "./changes";
import { padAt } from "./convert";
import { copperOf, settingsOf } from "./dialogs";
import { dpClick, dpFix, dpSetLayer, dpToggleVia, dpUndoLeg } from "./diffpair";
import { padCopperLayers, viaLayers } from "./distances";
import { refreshChip } from "./dom";
import { hitTestItem, pointInPoly } from "./hit";
import { netTable } from "./netlist";
import { hasNet, netOf, sameNet } from "./nets";
import { viaNode } from "./nodes";
import { removeRedundant } from "./redundant";
import { fixHead, leadingRatline, routeHighlight, routeUnhighlight } from "./route-fix";
import { netUnder, padsOf } from "./route-geom";
import { RM_MARK } from "./router-settings";
import { DBL_MS, HIT_MM, K, S, lastCtx } from "./state";
import { newTracer, trailAdd } from "./tracer";
import { clone, layerOf, pt, r6, samePt } from "./util";
import { pathHits, routeObstacles, routerWorld } from "./walkaround";

/** ROUTER::CommitRouting: the route's branch onto the board as one undo step ("Route Track"). */
export function commitRoute(ctx: PcbCtx, rt: Route) {
  let b = routeDoc(ctx, rt); if (b === ctx.doc) return false;
  b = removeRedundant(ctx.doc, b, rt);   // DIFF_PAIR_PLACER::FixRoute runs removeLoops on both lines too
  const changes = branchChanges(ctx.doc, b); if (!changes.length) return false;
  ctx.commit(changes, "Route Track"); return true;
}
/** End the route: fix the head when asked (End / double click: FixRoute( forceFinish )), then commit everything fixed. */
export function endRoute(ctx: PcbCtx, fixCurrent: boolean) {
  const rt = S.route; if (!rt) return;
  if (rt.dp) { if (fixCurrent && rt.dpLines) dpFix(ctx, { finish: true }); }
  else if (fixCurrent && ((rt.els && rt.els.length) || rt.placingVia)) fixHead(ctx, { finish: true });
  S.route = null; commitRoute(ctx, rt); routeUnhighlight(ctx, rt); sizesOf(ctx).endRoute(); refreshChip(ctx); ctx.requestRender();
  if (S.routeQueue && routeQueueNext) { const next = routeQueueNext; Promise.resolve().then(() => next(ctx)); }   // RouteSelected: the next one
}
/** route-selected.ts's routeNext, handed over at load (the modules import each other). */
let routeQueueNext: ((ctx: PcbCtx) => unknown) | null = null;
export function setRouteQueueNext(fn: (ctx: PcbCtx) => unknown) { routeQueueNext = fn; }
/** Escape / another tool (ROUTER::AbortPlacement): the route and everything fixed in it are dropped. */
export function abortRoute(ctx: PcbCtx) {
  const rt = S.route; if (!rt) return; S.route = null; S.violations = null; S.routeQueue = null;   // RouteSelected stops (m_cancelled)
  if (rt.layer !== rt.startLayer && ctx) { /* the active layer stays where routing left it, as in pcbnew */ }
  if (ctx) { routeUnhighlight(ctx, rt); sizesOf(ctx).endRoute(); refreshChip(ctx); ctx.requestRender(); } else if (K.pcbSizes) K.pcbSizes.state.endRoute();
}
/**
 * Backspace / Delete / Ctrl+Z while routing (ROUTER::UndoLastSegment → LINE_PLACER::UnfixRoute): the last fixed stage
 * comes off the branch and routing carries on from where it began.  Silent when nothing is fixed.
 */
export function undoRouteLeg(ctx: PcbCtx) {
  if (S.route && S.route.dp) return dpUndoLeg(ctx);
  const rt = S.route; const st = rt && rt.stages.pop(); if (!st) return false;
  rt.bdoc = null; rt.obs = null;
  rt.last = st.from.slice(); rt.net = st.net; rt.netKey = st.netKey; rt.startIds = st.startIds || []; rt.split = st.split || null; rt.placingVia = null;
  if (st.layer !== rt.layer) { rt.layer = st.layer; S.layer = st.layer; sizesOf(ctx).setActiveLayer(st.layer); }
  rt.tracer = newTracer(rt.width, rt.stages.length ? st.dir : -1); trailAdd(rt.tracer, rt.last); rt.head = [rt.last.slice()]; rt.els = []; rt.target = rt.last.slice();
  rt.chained = rt.stages.length > 0 && !rt.stages[rt.stages.length - 1].placingVia;
  if (rt.cursor) updateHead(ctx);
  routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender(); return true;
}
/** The segment on `layer` under (x, y) with the point projected onto its centre line: where a route started on a track begins. */
export function trackUnder(doc: BoardDoc, x: number, y: number, layer: string) {
  const it = hitTestItem(doc, x, y, HIT_MM, (c) => c.kind === "segment" && layerOf(c.node) === layer); if (!it || it.kind !== "segment" || layerOf(it.node) !== layer) return null;
  const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return { item: it, point: [r6(a[0] + k * dx), r6(a[1] + k * dy)] };
}
/**
 * ROUTER_TOOL::getStartLayer: the layer a route starting at the hover begins on.  The active layer when the start item is
 * on it (or there is none); else the item's own layer: a track end / body on another shown copper layer, or a pad or
 * via that does not reach the active layer.
 */
export function startLayerOf(ctx: PcbCtx, hv: Hover, mm: Pt | null): string | null {
  const snap = hv.snap as SnapHit | null;
  if (snap && snap.kind !== "anchor") {
    if (snap.kind === "pad" || snap.kind === "via") {
      if (snap.onLayer) return snap.onLayer;
      return null;
    }
    return snap.onLayer || null;
  }
  const q = mm || [hv.x, hv.y];
  if (trackUnder(ctx.doc, q[0], q[1], S.layer)) return S.layer;
  for (const l of otherCopperLayers(ctx, S.layer)) if (trackUnder(ctx.doc, q[0], q[1], l)) return l;
  return null;
}
/** The obstacles in violation, shown as KiCad's router does (pure green over a clearance halo) until the cursor moves on. */
export function showViolations(obs: Obstacle[], at: Pt) { S.violations = obs.length ? { obs, at: at.slice() } : null; }
/**
 * ROUTER::isStartingPointRoutable and ROUTER_TOOL's start checks: no route from a non-plated hole, inside a rule area
 * that keeps tracks out, from copper text, or where a zero-length track (at the route width, then the board minimum)
 * already violates clearance (not in Highlight collisions, which only marks).  Returns the refusal message or null.
 */
export function startRefusal(ctx: PcbCtx, p: Pt, mm: Pt, net: NetRef, width: number, layer: string, own: Set<string>, snapped: boolean) {
  const doc = ctx.doc; const q = mm || p;
  const pad = padAt(doc, q[0], q[1], layer) || padAt(doc, q[0], q[1], null);
  if (pad && pad.pad.type === "np_thru_hole") return "Cannot start routing from a non-plated hole.";
  const W = routerWorld(doc);
  if (W.keepouts.some((k) => k.layers!.has(layer) && pointInPoly((k.shape as { pts: Pt[] }).pts, p[0], p[1]))) return "Rule area disallows tracks.";
  if (!snapped && !pad) { const t = hitTestItem(doc, q[0], q[1], HIT_MM); if (t && (t.kind === "gr_text" || t.kind === "gr_text_box") && /\.Cu$/.test(layerOf(t.node, ""))) return "Cannot start routing from a text item."; }
  if (!/\.Cu$/.test(layer)) return "Tracks on Copper layers only.";
  if (S.rs.mode === RM_MARK) return null;
  const s = settingsOf(ctx); const key = netTable(doc).key(net);
  const O = routeObstacles(doc, s, key, layer, key ? null : own);
  let hits = pathHits(O, [p], width / 2);
  if (hits.length && s.minTrackWidth > 0) hits = pathHits(O, [p], s.minTrackWidth / 2);
  if (hits.length) { showViolations(hits, p); return "The routing start point violates DRC."; }
  return null;
}
export function routeClick(ctx: PcbCtx, hv: Hover, mm: Pt, opts?: { enter?: boolean } | null) {
  if ((S.route && S.route.dp) || (!S.route && S.modTool === "routediff")) { dpClick(ctx, hv, mm, opts as { enter?: boolean } | undefined); return; }
  opts = opts || {}; const now = Date.now(); let p = [hv.x, hv.y];
  S.violations = null;
  if (!S.route) {
    let net = (hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, S.layer)) as NetRef;   // a grid snap carries none: undefined, as before
    let split: RouteSplit | null = null, startIds: string[] = [], startKind = hv.snap ? hv.snap.kind : null;
    // ROUTER_TOOL::getStartLayer: a start item that is not on the active layer moves the route (and the active layer) to its layer
    const startOn = startLayerOf(ctx, hv, mm);
    if (startOn && startOn !== S.layer) setLayer(ctx, startOn);
    if (!hv.snap) { const on = trackUnder(ctx.doc, mm ? mm[0] : hv.x, mm ? mm[1] : hv.y, S.layer); if (on) { p = on.point; net = netOf(on.item.node); split = { id: on.item.id, point: p.slice(), node: clone(on.item.node) }; startIds.push(on.item.id); startKind = "track"; } }   // started on a track: its centre line and its net
    else if (hv.snap.kind !== "pad") { const it = hitTestItem(ctx.doc, hv.x, hv.y, HIT_MM); if (it) startIds.push(it.id); }
    const R = sizesOf(ctx); const connected = connectedWidth(ctx.doc, p, S.layer, mm || p);
    const width = R.routeWidth(netNameOf(ctx, net), connected);   // ImportSizes: the connected track, the net's class, or the selected width
    const refusal = startRefusal(ctx, p, mm, net, width, S.layer, new Set(startIds), !!hv.snap);
    if (refusal) { ctx.toast(refusal); ctx.requestRender(); return; }
    const netKey = netTable(ctx.doc).key(net);
    S.route = { start: p.slice(), startLayer: S.layer, startKind, startSpan: hv.snap && (hv.snap.kind === "pad" || hv.snap.kind === "via") ? ((hv.snap as SnapHit).layers || null) : null,
      last: p, target: p.slice(), cursor: p.slice(), head: [p.slice()], els: [], reached: true, net, netKey, layer: S.layer, width, connected, diagFirst: !!S.rs.start_diagonal, clickT: now, clickAt: p.slice(),
      stages: [], split, startIds, ratline: null, placingVia: null, chained: false, collisions: null, shove: null,
      tracer: newTracer(width, -1), keepHighlight: !!netKey && S.highlightNet === netKey };
    trailAdd(S.route.tracer, p);
    if (R.activeLayer !== S.layer) R.setActiveLayer(S.layer);
    routeHighlight(ctx, S.route); S.route.ratline = leadingRatline(ctx, S.route);
    // V before the route started (m_startWithVia): a via from the layer the route began on to the toggled layer,
    // unless the start pad / via already reaches it
    const swv = S.startWithVia; S.startWithVia = null;
    if (swv && swv.from !== S.route.layer && !startSpans(ctx, S.route, S.route.layer)) { const to = S.route.layer; S.route.layer = swv.from; S.layer = swv.from; S.route.obs = null; toggleViaPlacement(ctx, "through", to); }
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const rt = S.route;
  const dbl = !opts.enter && now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  if (!samePt(p, rt.cursor || rt.last)) { rt.cursor = p.slice(); updateHead(ctx); }
  const rc = routeCtx(ctx, rt);
  // landing on the routed net (a pad, via or track end) ends the trace once the head reaches it, as in KiCad
  const onNet = hv.snap && rt.netKey && sameNet(hv.snap.net, rt.net);
  const lands = onNet && rt.reached && samePt(rt.target, [hv.x, hv.y]);
  let endSplit: RouteSplit | null = null;
  if (lands && hv.snap!.kind === "trackMid" && !(rt.split && rt.split.id === (hv.snap as SnapHit).id)) { const it = rc.doc.items.get((hv.snap as SnapHit).id!); if (it) endSplit = { id: it.id, point: [hv.x, hv.y], node: clone(it.node) }; }
  const markEnd = S.rs.mode === RM_MARK && hv.snap && samePt(rt.target, [hv.x, hv.y]) ? hv.snap as SnapHit : null;
  const placingVia = !!rt.placingVia;
  if (!fixHead(ctx, { endSplit, snap: markEnd })) { ctx.requestRender(); return; }
  if ((lands || (markEnd && hasNet(markEnd.net) && rt.netKey && sameNet(markEnd.net, rt.net))) && !placingVia) { endRoute(ctx, false); return; }
  if (rt.cursor) updateHead(ctx);
  routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender();
}
/** The through via's layer span: the outer copper layers of the board. */
export function viaSpan(doc: BoardDoc) { const cu = K.pcbSizes.copperStack(copperOf(doc)); return [cu[0], cu[cu.length - 1]]; }
/** The microvia's sizes: the net's class microvia, else KiCad's netclass defaults (0.3 / 0.1 mm). */
export function microViaSize(ctx: PcbCtx, net: NetRef) {
  // the microvia fields ride on the class when the project has them (they are not in NetClassValues)
  const R = sizesOf(ctx); const nc = (R.netclassOf ? R.netclassOf(netNameOf(ctx, net)) : null) as { uvia_diameter?: number; uvia_drill?: number } | null;
  return { diameter: nc && nc.uvia_diameter! > 0 ? nc.uvia_diameter! : 0.3, drill: nc && nc.uvia_drill! > 0 ? nc.uvia_drill! : 0.1 };
}
/**
 * ROUTER_TOOL::handleLayerSwitch for a via command: the via's type, sizes and the layer it leads to.  A through via
 * goes to the layer of the nearest ratsnest anchor (the layer pair when that anchor is through-hole or on the current
 * layer, or when there is none); blind/buried and micro vias go across the layer pair.  `target` is a picked layer
 * (the Select Layer variants).  Returns the via or a refusal message.
 */
export function viaPlan(ctx: PcbCtx, rt: Route, type: string, target?: string | null): ViaPlan | string {
  const R = sizesOf(ctx); const cur = rt.layer; const [pTop, pBot] = R.layerPair || ["F.Cu", "B.Cu"];
  const doc = routeDoc(ctx, rt); const stack = K.pcbSizes.copperStack(copperOf(doc)); const F = stack[0], B = stack[stack.length - 1];
  if (type !== "through" && target && ((target === B && cur === F) || (target === F && cur === B))) type = "through";   // a blind via across the whole board is a through via
  const paired = (x: string, p0: string, p1: string) => (x === p0 ? p1 : x === p1 ? p0 : p0);   // SIZES_SETTINGS::PairedLayer, else GetLayerTop()
  let a = cur, b = target || null, next: string;
  if (b) next = b;
  else if (type === "through") {
    const rl = rt.ratAnchor;
    if (!rl || !rl.layers.length) { a = pTop; b = pBot; next = paired(cur, pTop, pBot); }
    else if (rl.through) { b = cur === pBot ? pTop : cur === pTop ? pBot : pTop; next = b; }
    else { const other = K.pcbSizes.copperStack(rl.layers)[0]; b = other === cur ? paired(cur, pTop, pBot) : other; next = b; }
  } else {
    if (cur === pTop || cur === pBot) { a = pTop; b = pBot; } else b = pTop;
    if (a === b) return "Via needs 2 different layers.";
    next = paired(cur, a, b);
  }
  if (next === cur) { if (type !== "through") return "Via needs 2 different layers."; next = cur === F ? B : F; }
  const size = type === "micro" ? microViaSize(ctx, rt.net) : R.routeVia(netNameOf(ctx, rt.net));
  const span = type === "through" ? [F, B] : [a, b].sort((x, y) => stack.indexOf(x) - stack.indexOf(y));
  return { type, toLayer: next, span, diameter: size.diameter, drill: size.drill };
}
/**
 * ROUTER_TOOL::onViaCommand: the first via command attaches a via to the head's end (it follows the cursor and is
 * checked with it, ToggleViaPlacement); the same command again takes it off.  The next click fixes trace and via
 * and routing goes on on the via's other layer.  With no route yet (the Route tool idle) the next route starts with a via.
 */
export function toggleViaPlacement(ctx: PcbCtx, type?: string, target?: string | null) {
  const rt = S.route;
  if (rt && rt.dp) return dpToggleVia(ctx, type, target!);
  if (!rt) { if (S.modTool === "routediff") return true; startWithVia(ctx); return true; }
  if (rt.placingVia && !target) { rt.placingVia = null; S.layer = rt.layer; sizesOf(ctx).setActiveLayer(rt.layer); if (rt.cursor) updateHead(ctx); refreshChip(ctx); ctx.requestRender(); return true; }
  const plan = viaPlan(ctx, rt, type!, target);
  if (typeof plan === "string") { ctx.toast(plan); return true; }
  rt.placingVia = plan; sizesOf(ctx).setActiveLayer(plan.toLayer); S.layer = rt.layer;
  if (rt.cursor) updateHead(ctx);
  refreshChip(ctx); ctx.requestRender(); return true;
}
/** ACT_PlaceThroughVia with the Route tool idle: the next route starts with a via, and the active layer toggles. */
export function startWithVia(ctx: PcbCtx) { S.startWithVia = { from: S.layer }; runAction("layerToggle", ctx); }
/** The Select Layer and Place … Via commands: KiCad's layer picker at the track end, then the via to that layer. */
export function selectLayerAndPlaceVia(ctx: PcbCtx, type: string) {
  const rt = S.route; if (!rt) return false;
  const doc = routeDoc(ctx, rt); const cu = K.pcbSizes.copperStack(copperOf(doc));
  const disallow = new Set(type === "through" ? [] : [rt.layer]);
  const at = rt.target || rt.last;
  layerPickerImpl({ layers: cu, current: rt.layer, disallow, at, client: S.client }, (layer: string | null) => {
    if (!layer || !S.route || S.route !== rt) return;
    if (type !== "through" && layer === rt.layer) return;
    if (rt.placingVia) rt.placingVia = null;
    toggleViaPlacement(lastCtx || ctx, type, layer);
  });
  return true;
}
export function placeVia(ctx: PcbCtx, hv: Hover) {
  const net = (hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, null)) as NetRef;   // a grid snap carries none: undefined, as before
  const via = sizesOf(ctx).routeVia(netNameOf(ctx, net));
  ctx.commit([addedChange(ctx.doc, viaNode(ctx.doc, hv.x, hv.y, via.diameter, via.drill, net, viaSpan(ctx.doc)), net)], "via");
}
/**
 * A layer change while routing (PgUp/PgDn, + / -, Toggle Layer, the layer combo): LINE_PLACER::SetLayer moves the head
 * to the layer when nothing is fixed yet and the route starts on a pad or via that spans it (or on nothing); otherwise
 * a via to that layer is armed, placed on the next click.
 */
export function setLayer(ctx: PcbCtx, layer: string) {
  const rt = S.route;
  if (rt && rt.dp) { dpSetLayer(ctx, layer); return; }
  if (rt) {
    if (layer === rt.layer) { if (rt.placingVia) toggleViaPlacement(ctx); return; }
    const spans = !rt.stages.length && (!rt.startKind || ((rt.startKind === "pad" || rt.startKind === "via") && startSpans(ctx, rt, layer)));
    const afterVia = rt.stages.length && !rt.chained;
    if (!rt.placingVia && (spans || afterVia)) {
      rt.layer = layer; S.layer = layer; sizesOf(ctx).setActiveLayer(layer); rt.obs = null;
      rt.tracer = newTracer(rt.width, -1); trailAdd(rt.tracer, rt.last); rt.head = [rt.last.slice()]; rt.els = [];
      if (rt.cursor) updateHead(ctx); refreshChip(ctx); ctx.requestRender(); return;
    }
    rt.placingVia = null; toggleViaPlacement(ctx, "through", layer); return;
  }
  S.layer = layer; S.gfxLayer = layer; sizesOf(ctx).setActiveLayer(layer); refreshChip(ctx); ctx.requestRender();
}
/** Whether the route's start pad / via has copper on `layer`. */
export function startSpans(ctx: PcbCtx, rt: Route, layer: string) {
  const doc = ctx.doc; const p = rt.start; const cu = copperOf(doc);
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (p[0] < b[0] - 0.01 || p[0] > b[2] + 0.01 || p[1] < b[1] - 0.01 || p[1] > b[3] + 0.01)) continue;
    if (it.kind === "via") { const a = pt(it.node, "at"); if (a && samePt(a, p) && viaLayers(it.node, cu).has(layer)) return true; }
    else if (it.kind === "footprint") for (const pd of padsOf(it)) if (samePt([pd.x, pd.y], p) && padCopperLayers(pd, cu).has(layer)) return true;
  }
  return false;
}
// The layer picker (PCB_EDIT_FRAME::SelectOneLayer) is DOM; the editor installs the real one, the tests a stub.
export let layerPickerImpl: LayerPicker = function (opts, done) { done(null); };
/** pcb.setLayerPicker: the editor installs the real layer picker. */
export function setLayerPickerImpl(fn: LayerPicker) { layerPickerImpl = fn; }

/**
 * ROUTER::Finish (routerAttemptFinish, F while routing): the head is walked to the nearest ratsnest anchor
 * (GetNearestRatnestAnchor) up to five times while it keeps moving; when it gets there on a layer the anchor has, the
 * route is fixed there and ends (FixRoute).  Otherwise the head stays where the walk got to (KiCad warps the mouse
 * there).  False when nothing is routed or there is no anchor to go to.
 */
export function attemptFinish(ctx: PcbCtx): boolean {
  const rt = S.route; if (!rt || rt.dp) return false;
  leadingRatline(ctx, rt); const a = rt.ratAnchor; if (!a) return false;
  const goal: Pt = a.p.slice();
  for (let tries = 5; tries > 0; tries--) { const before = rt.target.slice(); rt.cursor = goal.slice(); updateHead(ctx); if (samePt(rt.target, before)) break; }
  if (samePt(rt.target, goal) && (a.layers.includes(rt.layer) || a.layers.includes("*.Cu"))) {
    const hv = hoverPoint(ctx, goal, true);
    routeClick(ctx, { x: goal[0], y: goal[1], snap: hv.snap }, goal, { enter: true });
    if (S.route === rt) endRoute(ctx, false);
    return true;
  }
  ctx.requestRender(); return true;
}
/**
 * ROUTER::ContinueFromEnd (routerContinueFromEnd, Ctrl+E while routing): what is fixed is committed, routing restarts at
 * the nearest ratsnest anchor (on the current layer when the anchor has it, else the anchor's first layer) and the
 * head is pulled back to where the route had got to.
 */
export function continueFromEnd(ctx: PcbCtx): boolean {
  const rt = S.route; if (!rt || rt.dp) return false;
  leadingRatline(ctx, rt); const a = rt.ratAnchor; if (!a) { ctx.toast("No ratsnest end to continue from."); return true; }
  const currentEnd = rt.target.slice(), layer = rt.layer;
  endRoute(ctx, false);
  const next = a.layers.includes(layer) || a.layers.includes("*.Cu") || !a.layers.length ? layer : a.layers[0];
  if (next !== S.layer) setLayer(ctx, next);
  const hv = hoverPoint(ctx, a.p.slice(), true);
  routeClick(ctx, { x: a.p[0], y: a.p[1], snap: hv.snap }, a.p.slice());
  const nr = S.route as Route | null; if (!nr) return true;
  nr.cursor = currentEnd; updateHead(ctx); ctx.requestRender(); return true;
}
