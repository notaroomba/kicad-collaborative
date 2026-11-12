// pcb-tools/inline-drag.ts — ROUTER_TOOL::InlineDrag: the router's drag of tracks and vias.
import type { CopperShape, DragSub, Obstacle, PcbChange, PcbCtx, Pt } from "./types";
import { highlightIds, overrideLocks } from "./actions";
import { netNameOf, netlistCached, sizesOf } from "./app-state";
import { cancelOps } from "./assistants";
import { cursorPoint } from "./clipboard";
import { KD, settingsOf } from "./dialogs";
import { dpNetPair } from "./diffpair";
import { shapeBBox, shapeGap, viaLayers } from "./distances";
import { dragChanges, dragTo, solutionChanged } from "./drag-optimize";
import { dragStart, peq, rp, trackEnds } from "./dragger";
import { netClearance } from "./drc";
import { distToItem, routableItems, viaNow } from "./edit-commands";
import { isLocked, selectionIds } from "./groups";
import { hitTestItem } from "./hit";
import { netHighlightIds, netTable } from "./netlist";
import { netOf } from "./nets";
import { closestOnSeg } from "./point-editor";
import { routeUnhighlight } from "./route-fix";
import { HIT_MM, S } from "./state";
import { layerOf, widthOf } from "./util";
import { ROUTE_EPS } from "./walkaround";

/**
 * ROUTER_TOOL::InlineDrag: the item nearest the grab point leads (snapped onto it), the other selected tracks follow with
 * the same displacement (MULTI_DRAGGER), the dragged net is highlighted.  S.drag = { subs, tool, bySelect, moved }.
 */
export function beginInlineDrag(ctx: PcbCtx, its: KItem[] | null | undefined, mm: Pt, free: boolean, how: string, lockOk?: boolean): boolean {
  if (!its || !its.length) return false;
  const sorted = its.slice().sort((a: KItem, b: KItem) => distToItem(a, mm) - distToItem(b, mm));
  if (!lockOk && isLocked(sorted[0].node) && !overrideLocks()) return askDragLocked(ctx, () => beginInlineDrag(ctx, its, mm, free, "tool", true));
  const lead = dragStart(ctx, sorted[0], mm, free); if (!lead) return false;
  const subs = [lead], taken = new Set(lead.ids);
  for (const it of sorted.slice(1)) {
    if (taken.has(it.id) || it.kind !== "segment") continue;
    const [a, b] = trackEnds(it); const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = dragStart(ctx, it, mid, false); if (!d) continue;
    if (d.mode !== "segment" && !free) d.mode = "segment";
    d.ids.forEach((id: string) => taken.add(id)); subs.push(d);
  }
  // ROUTER::StartDragging: one segment of a differential pair with "Keep coupling between differential pairs" on
  // goes to the MULTI_DRAGGER with its coupled partner segment (reconstructOriginalDpCoupling), both moving together
  if (subs.length === 1 && lead.mode === "segment" && !free && S.rs.keep_diff_pair_coupling_when_dragging) {
    const c = dpCoupledSegment(ctx, sorted[0]);
    if (c && !taken.has(c.item.id)) { const d = dragStart(ctx, c.item, c.grab, false); if (d) { d.mode = "segment"; d.dpPartner = true; subs.push(d); } }
  }
  if (subs.length > 1) { const excl = new Set<string>(); for (const d of subs) d.ids.forEach((id: string) => excl.add(id)); for (const d of subs) { d.excl = excl; d.obs = new Map(); } }   // the other dragged lines are not where they were
  cancelOps(); S.violations = null;
  S.drag = { subs, tool: how === "tool", bySelect: how !== "tool", moved: false, cursor: lead.start.slice(), appSel: how === "app" };   // a left-drag commits on release, D / G on the next click
  dragHighlight(ctx, lead);
  ctx.requestRender(); return true;
}
/**
 * DIFF_PAIR::CoupledSegmentPairs for one segment: the segment of the complementary net (BOARD::MatchDpSuffix) on the
 * same layer that runs parallel to it (within DP_PARALLELITY_THRESHOLD), overlaps it along its length and sits at a
 * pair's gap from it — the nearest such.  { item, grab: the point facing the segment's middle } or null.
 */
export const DP_PARALLELITY_THRESHOLD = 10e-6;   // 10 IU, in mm
export function dpCoupledSegment(ctx: PcbCtx, seg: KItem | null | undefined) {
  const doc = ctx.doc; if (!seg || seg.kind !== "segment") return null;
  const pair = dpNetPair(doc, netOf(seg.node)); if (!pair) return null;
  const NT = netTable(doc); const mine = NT.key(netOf(seg.node)); const kP = NT.key(pair.P), kN = NT.key(pair.N), other = kP === mine ? kN : kP;
  if (!other || other === mine) return null;
  const L = layerOf(seg.node), w = widthOf(seg.node, 0.25); const [a, b] = trackEnds(seg); if (!a || !b) return null;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1e-6) return null; const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const sz = sizesOf(ctx); const dpGap = sz && sz.routeDiffPair ? sz.routeDiffPair(netNameOf(ctx, netOf(seg.node))).gap : 0.25;
  const maxGap = Math.max(dpGap * 2, dpGap + 2 * w);   // the gap constraint's max, generously: a coupled pair, not a neighbour
  let best: { item: KItem; dist: number; grab: Pt } | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" || layerOf(it.node) !== L || NT.key(netOf(it.node)) !== other) continue;
    const [c, d] = trackEnds(it); if (!c || !d) continue;
    const l2 = Math.hypot(d[0] - c[0], d[1] - c[1]); if (l2 < 1e-6) continue;
    const v = [(d[0] - c[0]) / l2, (d[1] - c[1]) / l2];
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) * Math.min(len, l2) > DP_PARALLELITY_THRESHOLD * 1000) continue;   // ApproxParallel over the length
    const dist = Math.abs((c[0] - a[0]) * u[1] - (c[1] - a[1]) * u[0]);
    const gap = dist - (w + widthOf(it.node, 0.25)) / 2; if (gap <= 0 || gap > maxGap) continue;
    const t0 = (c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1], t1 = (d[0] - a[0]) * u[0] + (d[1] - a[1]) * u[1];
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(len, Math.max(t0, t1)); if (hi - lo <= 1e-6) continue;   // the two face each other
    if (!best || dist < best.dist) { const tm = (lo + hi) / 2; const m = [a[0] + u[0] * tm, a[1] + u[1] * tm]; best = { item: it, dist, grab: closestOnSeg(m, c, d) }; }
  }
  return best;
}
/**
 * ROUTER_TOOL::performDragging: a drag that starts on a locked item asks first (KIDIALOG "The selected item is locked.",
 * OK labelled "Drag Anyway"); the drag then follows the cursor until the next click, as D does.
 */
export function askDragLocked(ctx: PcbCtx, go: () => void) {
  const kd = KD(); if (!kd || typeof document === "undefined") { ctx.toast("The selected item is locked."); return false; }
  kd.open({ title: "Confirmation", width: 360, okLabel: "Drag Anyway",
    build(body) { const p = document.createElement("p"); p.style.margin = "4px 0"; p.textContent = "The selected item is locked."; body.appendChild(p); },
    ok() { go(); } });
  return true;
}
/** NeighboringSegmentFilter: the track or via under the cursor when nothing is selected. */
export function dragCandidate(ctx: PcbCtx, p: Pt) {
  const it = hitTestItem(ctx.doc, p[0], p[1], HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  return it && (it.kind === "segment" || it.kind === "via") ? it : null;
}
/** EDIT_TOOL::Drag (D, G): the selected tracks / via, or the one under the cursor, follow the cursor until a click. */
export function beginToolDrag(ctx: PcbCtx, free: boolean) {
  const ids = selectionIds(ctx); const at = cursorPoint(ctx);
  let its = ids.size ? routableItems(ctx.doc, ids) : null;
  if (!its && !ids.size) { const c = dragCandidate(ctx, at); if (c) its = [c]; }
  return !!its && beginInlineDrag(ctx, its, at, free, "tool");
}
export function dragHighlight(ctx: PcbCtx, d: DragSub) { if (!d.netKey) return; d.keepHighlight = S.highlightNet === d.netKey; highlightIds(ctx, netHighlightIds(ctx.doc, d.netKey, netlistCached(ctx.doc))); }
/** ROUTER::Move while dragging: every sub-drag to the snapped cursor (the followers by the lead's displacement). */
export function dragMove(ctx: PcbCtx, mm: Pt) {
  const D = S.drag; if (!D) return; const p = ctx.snapOn ? ctx.snap(mm.slice()) : mm.slice();
  D.cursor = mm.slice(); const lead = D.subs[0];
  if (!D.moved && peq(p, lead.start)) return;
  D.moved = true; const dx = p[0] - lead.start[0], dy = p[1] - lead.start[1];
  const done: DragSub[] = [];
  for (const d of D.subs) {
    const prev = { sol: d.sol, lastValid: d.lastValid, hits: d.hits, status: d.status, shove: d.shove };
    dragTo(ctx, d, d === lead ? p : rp([d.start[0] + dx, d.start[1] + dy]));
    // MULTI_DRAGGER drags the lines one after another in one node: each meets the ones already moved
    const peers = peerHits(ctx, d, done);
    if (peers.length) {
      if (d.free || d.forceMark) { d.hits = (d.hits || []).concat(peers); d.status = false; }
      else Object.assign(d, prev);   // walk around: the previous solution stays
    }
    done.push(d);
  }
}
/** Where a sub-drag's lines (and via) break clearance with lines of another net already moved in this step. */
export function peerHits(ctx: PcbCtx, d: DragSub, others: DragSub[]) {
  if (!others.length) return []; const s = settingsOf(ctx); const out: Obstacle[] = [];
  const segs = (pts: Pt[], r: number): CopperShape[] => pts.length === 1 ? [{ t: "circle", x: pts[0][0], y: pts[0][1], r }] : pts.slice(0, -1).map((a: Pt, i: number) => ({ t: "seg", a, b: pts[i + 1], r }));
  const mine = d.sol!.lines.map(({ l, pts }) => ({ layer: l.layer, net: l.netKey, shapes: segs(pts, l.width / 2) }));
  if (d.sol!.viaAt && d.via) { const copper = ctx.doc.copper.length ? ctx.doc.copper : ["F.Cu", "B.Cu"]; for (const L of viaLayers(d.via.node, copper)) mine.push({ layer: L, net: d.netKey, shapes: [{ t: "circle", x: d.sol!.viaAt[0], y: d.sol!.viaAt[1], r: viaNow(d.via.node).size / 2 }] }); }
  for (const o of others) for (const { l, pts } of o.sol!.lines) {
    if (pts.length < 1) continue;
    for (const m of mine) {
      if (m.layer !== l.layer || (m.net && m.net === l.netKey)) continue;
      const clr = Math.max(netClearance(s, m.net), netClearance(s, l.netKey), s.minClearance || 0);
      for (const b of segs(pts, l.width / 2)) if (m.shapes.some((a: CopperShape) => shapeGap(a, b) < clr - ROUTE_EPS)) { out.push({ id: l.ids[0], kind: "segment", net: l.netKey, shape: b, bbox: shapeBBox(b), clr }); break; }
    }
  }
  return out;
}
/** The changes a drag commits (FixRoute for each sub-drag), or null when any of them refuses. */
export function dragFixChanges(ctx: PcbCtx, d: DragSub, force: boolean) {
  if (!d.status) {
    if (d.forceMark) { if (!force) return null; }
    else { dragTo(ctx, d, d.lastValid); if (!d.status) return null; }
  }
  return solutionChanged(d) ? dragChanges(ctx, d) : [];
}
/** End the drag: commit (Ctrl forces a drag in violation) or put everything back; the net highlight goes. */
export function finishDrag(ctx: PcbCtx, commit: unknown, force: boolean) {
  const D = S.drag; if (!D) return false; S.drag = null; let done = false;
  if (commit && D.moved && !ctx.viewOnly) {
    const all: PcbChange[] = []; let ok = true;
    for (const d of D.subs) { const ch = dragFixChanges(ctx, d, force); if (!ch) { ok = false; break; } all.push(...ch); }
    if (ok && all.length) { ctx.commit(all, "drag track"); done = true; }
    if (D.appSel && ctx.setSelection && ctx.selection) ctx.setSelection(Array.from(ctx.selection));
  }
  routeUnhighlight(ctx, D.subs[0]);
  if (D.tool) ctx.setTool("select");
  ctx.requestRender(); return done;
}
/** Items the canvas leaves out while their dragged shape is drawn in the overlay (ROUTER_IFACE::HideItem). */
export function dragHiddenIds() {
  if (S.move && S.move.conns && S.move.conns.length && S.move.moved) { const out = new Set<string>(); for (const c of S.move.conns) for (const id of c.l.ids) out.add(id); return out; }
  const D = S.drag; if (!D || !D.moved) return null;
  const out = new Set<string>(); for (const d of D.subs) { for (const id of d.ids) out.add(id); if (d.shove) for (const id of d.shove.preview.hidden) out.add(id); } return out;
}
