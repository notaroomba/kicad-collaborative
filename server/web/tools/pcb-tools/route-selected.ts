// pcb-tools/route-selected.ts — ROUTER_TOOL::RouteSelected and PCB_SELECTION_TOOL::unrouteSegment:
//   routerRouteSelected (Shift+X)            for each selected item in selection order (a footprint stands for its pads),
//                                            each of its unrouted ratsnest ends in turn starts an interactive route there;
//                                            the next starts when the user finishes one, Escape stops them all
//   routerRouteSelectedFromEnd (Shift+E)     the same, each route restarted from the other end (routerContinueFromEnd)
//   routerAutorouteSelected (Shift+F)        the same with Attempt Finish run on each; the ones it cannot finish wait for
//                                            the user
//   unrouteSegment (Backspace)               the selected tracks and vias are deleted ("Unroute Segment") and the tracks
//                                            that touched them become the selection, so Backspace keeps backing up
import type { PcbCtx, Pt } from "./types";
import { deleteChanges } from "./changes";
import { hoverPoint } from "./app-state";
import { applySelection, selectionIds } from "./groups";
import { netlist, ratsnest } from "./netlist";
import { attemptFinish, continueFromEnd, routeClick, setLayer, setRouteQueueNext } from "./route-tool";
import { S } from "./state";
import { pt, samePt } from "./util";

export type RouteSelMode = "manual" | "otherEnd" | "auto";
export interface RouteQueue { items: string[]; idx: number; anchors: Pt[]; mode: RouteSelMode; layer: string }

/** The unrouted ratsnest ends that belong to one item (a footprint's pads, a track's or a via's own anchors). */
export function itemRatsnestAnchors(doc: KDoc, id: string): Pt[] {
  const out: Pt[] = [];
  for (const l of ratsnest(doc as never, netlist(doc as never))) { if (l.ids[0] === id) out.push(l.a.slice()); else if (l.ids[1] === id) out.push(l.b.slice()); }
  return out;
}

/** RouteSelected: the queue starts; false when nothing is selected or a route is already running. */
export function routeSelected(ctx: PcbCtx, mode: RouteSelMode): boolean {
  if (S.route) return false;
  const ids = Array.from(selectionIds(ctx)); if (!ids.length) return false;
  applySelection(ctx, []);
  S.routeQueue = { items: ids, idx: 0, anchors: [], mode, layer: S.layer };
  if (S.modTool !== "route") ctx.setTool("route");
  routeNext(ctx); return true;
}
/** The next route of the queue (called when one ends): false when the queue is done. */
export function routeNext(ctx: PcbCtx): boolean {
  const q = S.routeQueue; if (!q || S.route) return false;
  for (;;) {
    if (!q.anchors.length) {
      if (q.idx >= q.items.length) { S.routeQueue = null; return false; }
      const id = q.items[q.idx++]; if (!ctx.doc.items.has(id)) continue;
      q.anchors = itemRatsnestAnchors(ctx.doc, id); continue;
    }
    const p = q.anchors.shift()!;
    // still unrouted? (an earlier route may have reached it)
    if (!ratsnest(ctx.doc, netlist(ctx.doc)).some((l) => samePt(l.a, p) || samePt(l.b, p))) continue;
    if (S.layer !== q.layer) setLayer(ctx, q.layer);   // back to the layer the user started on
    const hv = hoverPoint(ctx, p, true);
    routeClick(ctx, { x: p[0], y: p[1], snap: hv.snap }, p);
    if (!S.route) continue;
    if (q.mode === "auto") { attemptFinish(ctx); if (S.route) return true; continue; }
    if (q.mode === "otherEnd") continueFromEnd(ctx);
    return true;
  }
}
/** Escape while routing the selection: everything left is dropped (m_cancelled). */
export function cancelRouteQueue() { S.routeQueue = null; }

/** The tracks / arcs / vias that share an end with the removed ones (selectAllConnectedTracks STOP_AT_SEGMENT). */
function touching(doc: KDoc, gone: Set<string>): string[] {
  const ends: { p: Pt; layer: string | null }[] = [];
  const endsOf = (it: KItem): { p: Pt; layer: string | null }[] => {
    if (it.kind === "via") { const a = pt(it.node, "at"); return a ? [{ p: a, layer: null }] : []; }
    const l = it.layer || null; const out: { p: Pt; layer: string | null }[] = [];
    for (const k of ["start", "end"]) { const q = pt(it.node, k); if (q) out.push({ p: q, layer: l }); }
    return out;
  };
  for (const id of gone) { const it = doc.items.get(id); if (it) ends.push(...endsOf(it)); }
  const out: string[] = [];
  for (const it of doc.items.values()) {
    if (gone.has(it.id) || (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via")) continue;
    if (endsOf(it).some((e) => ends.some((g) => samePt(g.p, e.p) && (!g.layer || !e.layer || g.layer === e.layer)))) out.push(it.id);
  }
  return out;
}
/** unrouteSegment: true when the selection had tracks or vias (the key was ours). */
export function unrouteSegment(ctx: PcbCtx): boolean {
  const ids = Array.from(selectionIds(ctx)).filter((id) => { const it = ctx.doc.items.get(id); return !!it && (it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "generated"); });
  if (!ids.length) return false;
  const gone = new Set<string>(ids);
  for (const id of ids) { const it = ctx.doc.items.get(id)!; if (it.kind === "generated") for (const c of K_members(it)) gone.add(c); }
  const after = touching(ctx.doc, gone);
  applySelection(ctx, []);
  ctx.commit(deleteChanges(ctx.doc, Array.from(gone).filter((id) => ctx.doc.items.has(id))), "Unroute Segment");
  applySelection(ctx, after.filter((id) => ctx.doc.items.has(id)));
  ctx.requestRender(); return true;
}
function K_members(it: KItem): string[] { const out: string[] = []; for (const c of it.node) if (Array.isArray(c) && c[0] === "members") for (const m of c.slice(1)) out.push(String(m)); return out; }

setRouteQueueNext(routeNext);
