// pcb-tools/route-preview.ts — the router's preview: the branch, the head, vias and the status note.
import type { PcbCtx, Pt, TrackElem } from "./types";
import { keysInText } from "../../keys";
import type { Ratline } from "./route-fix";
import { headVia, routeHaloClearance } from "./branch";
import { settingsOf } from "./dialogs";
import { drawDpRoute } from "./diffpair";
import { netClearance } from "./drc";
import { viaNow } from "./edit-commands";
import { drawShape, line, polyline, ring } from "./overlay";
import { connLines } from "./select-move";
import { HALO_COLOR, K, RATSNEST_LEAD, S, saturated } from "./state";
import { color, layerOf, pt, widthOf } from "./util";

/** The drag in progress: the lines and via where they would go, obstacles in violation green, and KiCad's status note. */
export function drawDragPreview(c: CanvasRenderingContext2D, ctx: PcbCtx, view: KView, px: number) {
  const m = S.move;
  if (m && m.conns && m.conns.length && m.moved) {   // COMPONENT_DRAGGER's attached lines at the footprint's offset
    for (const { l, pts } of connLines(m, m.last[0], m.last[1])) { if (pts.length < 2) continue; c.globalAlpha = 0.8; c.strokeStyle = color(l.layer); c.lineWidth = l.width; polyline(c, pts, false); }
  }
  const D = S.drag; if (!D || !D.moved) return;
  for (const d of D.subs) {
    const bad = d.hits && d.hits.length; const s = settingsOf(ctx);
    if (d.shove) {   // the items the drag pushed, where they would go
      for (const L of d.shove.preview.lines) { if (L.pts.length < 2) continue; c.globalAlpha = 0.8; c.strokeStyle = color(L.layer!); c.lineWidth = L.w; polyline(c, L.pts, false); }
      for (const v of d.shove.preview.vias) drawViaPreview(c, v.at, v.size, v.drill, px, 0.8);
    }
    if (bad) for (const ob of d.hits!) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
    for (const { l, pts } of d.sol!.lines) {
      if (pts.length < 2) continue;
      if (bad) { c.globalAlpha = 0.7; c.strokeStyle = HALO_COLOR; c.lineWidth = l.width + 2 * Math.max(netClearance(s, l.netKey), s.minClearance || 0); polyline(c, pts, false); }
      c.globalAlpha = 0.8; c.strokeStyle = color(l.layer); c.lineWidth = l.width; polyline(c, pts, false);   // ROUTER_PREVIEW_ITEM: the layer colour at alpha 0.8
    }
    if (d.via) {
      const at = d.sol!.viaAt || d.viaAt, v = viaNow(d.via.node);
      c.globalAlpha = 0.8; c.strokeStyle = "rgb(179, 179, 179)"; c.lineWidth = Math.max((v.size - v.drill) / 2, px); ring(c, at!, (v.size + v.drill) / 4);   // COLOR4D( 0.7, 0.7, 0.7, 0.8 ) around the hole
    }
  }
  if (D.subs.some((d) => d.forceMark && !d.status) && D.cursor) drawStatusNote(c, D.cursor, px * (view.dpr || 1), "Track violates DRC.", keysInText("(Ctrl+click to commit anyway.)"));
}
/** A track element (segment or arc) stroked at the current width. */
export function strokeElem(c: CanvasRenderingContext2D, e: TrackElem) {
  if (e.t === "arc") { const a = K.arcFrom3(e.a, e.m, e.b); if (a) { c.beginPath(); c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); c.stroke(); return; } }
  line(c, e.a, e.b);
}
/** A via as the router previews it: the annulus in the via colour. */
export function drawViaPreview(c: CanvasRenderingContext2D, at: Pt, size: number, drill: number, px: number, alpha: number) { c.globalAlpha = alpha; c.strokeStyle = "rgb(179, 179, 179)"; c.lineWidth = Math.max((size - drill) / 2, px); ring(c, at, (size + drill) / 4); }
/** The items a node stands for, as preview elements: { layer, width, els } for a track, { via } for a via. */
export function previewOfNode(node: SNode): { layer: string; width: number; els: TrackElem[]; via?: undefined } | { via: { at: Pt; size: number; drill: number }; layer?: undefined; width?: undefined; els?: undefined } | null {
  if (node[0] === "segment") return { layer: layerOf(node), width: widthOf(node, 0.25), els: [{ t: "seg", a: pt(node, "start")!, b: pt(node, "end")! }] };
  if (node[0] === "arc") return { layer: layerOf(node), width: widthOf(node, 0.25), els: [{ t: "arc", a: pt(node, "start")!, m: pt(node, "mid")!, b: pt(node, "end")! }] };
  if (node[0] === "via") { const v = viaNow(node); return { via: { at: pt(node, "at")!, size: v.size, drill: v.drill } }; }
  return null;
}
/** ROUTER::movePlacing's preview: the route's branch (ROUTER_PREVIEW_ITEM, layer colour at 0.8), the head (PNS_HEAD_TRACE, saturated). */
export function drawRoute(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  const rt = S.route;
  for (const st of rt!.stages) for (const op of st.ops) {
    const node = op.add || (op.set && op.node); if (!node) continue; const pv = previewOfNode(node); if (!pv) continue;
    if (pv.via) { drawViaPreview(c, pv.via.at, pv.via.size, pv.via.drill, px, 0.8); continue; }
    c.globalAlpha = 0.8; c.strokeStyle = color(pv.layer); c.lineWidth = pv.width; for (const e of pv.els) strokeElem(c, e);
  }
  if (rt!.dp) { drawDpRoute(c, ctx, px); return; }
  if (rt!.shove) {
    for (const L of rt!.shove.preview.lines) { if (L.pts.length < 2) continue; c.globalAlpha = 0.8; c.strokeStyle = color(L.layer!); c.lineWidth = L.w; polyline(c, L.pts, false); }
    for (const v of rt!.shove.preview.vias) drawViaPreview(c, v.at, v.size, v.drill, px, 0.8);
  }
  const marks = (rt!.collisions || []).concat(rt!.viaBad || []);
  for (const ob of marks) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }   // ROUTER::markViolations
  const els = rt!.els && rt!.els.length ? rt!.els : (rt!.head && rt!.head.length > 1 ? rt!.head.slice(0, -1).map((p: Pt, i: number) => ({ t: "seg" as const, a: p, b: rt!.head[i + 1] })) : []);
  if (els.length) {
    c.globalAlpha = 0.7; c.strokeStyle = HALO_COLOR; c.lineWidth = rt!.width + 2 * routeHaloClearance(ctx, rt!); for (const e of els) strokeElem(c, e);   // track_clearance_mode SHOW_WITH_VIA_WHILE_ROUTING
    c.globalAlpha = 0.8; c.strokeStyle = saturated(color(rt!.layer)); c.lineWidth = rt!.width; for (const e of els) strokeElem(c, e);                      // PNS_HEAD_TRACE: the layer colour saturated, alpha 0.8
  }
  const via = headVia(ctx, rt!);
  if (via) {
    const at = rt!.target || rt!.last; const clr = routeHaloClearance(ctx, rt!);
    c.globalAlpha = 0.7; c.fillStyle = HALO_COLOR; c.beginPath(); c.arc(at[0], at[1], via.diameter / 2 + clr, 0, 2 * Math.PI); c.fill();
    drawViaPreview(c, at, via.diameter, via.drill, px, 0.8);
  }
  if (rt!.ratline && S.showRatsnest) { c.globalAlpha = 1; c.strokeStyle = RATSNEST_LEAD; c.lineWidth = 1 * px; line(c, (rt!.ratline as Ratline)[0], (rt!.ratline as Ratline)[1]); }
}
/** What the board render leaves out while the route shows it elsewhere: items rewritten or removed on its branch, and those the shove pushed. */
export function routeHiddenIds() {
  const rt = S.route; if (!rt) return null; const out = new Set();
  for (const st of rt.stages) for (const op of st.ops) { if (op.set) out.add(op.set); if (op.del) out.add(op.del); }
  if (rt.shove) for (const id of rt.shove.preview.hidden) out.add(id);
  if (rt.loopHidden) for (const id of rt.loopHidden) out.add(id);
  return out.size ? out : null;
}
/** ROUTER_STATUS_VIEW_ITEM: a boxed message and hint above and to the right of the cursor, in the UI's colours. */
export function drawStatusNote(c: CanvasRenderingContext2D, at: Pt, cpx: number, msg: string, hint?: string | null) {
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const fs = 13 * cpx, hs = 11 * cpx, m = 6 * cpx;
  c.save(); c.globalAlpha = 1;
  c.font = `${fs}px sans-serif`; const w1 = c.measureText(msg).width; c.font = `${hs}px sans-serif`; const w2 = c.measureText(hint!).width;
  const w = Math.max(w1, w2) + 2 * m, h = fs + hs + 3 * m; const x = at[0] + 5 * m, y = at[1] - h - 5 * m;
  c.fillStyle = css("--color-panel", "#2b2b2b"); c.strokeStyle = css("--color-ink", "#e0e0e0"); c.lineWidth = cpx;
  c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
  c.fillStyle = css("--color-ink", "#e0e0e0"); c.textBaseline = "top";
  c.font = `${fs}px sans-serif`; c.fillText(msg, x + m, y + m); c.font = `${hs}px sans-serif`; c.fillText(hint!, x + m, y + 2 * m + fs);
  c.restore();
}
