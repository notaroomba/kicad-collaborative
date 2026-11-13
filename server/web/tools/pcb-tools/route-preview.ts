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
import { CLEARANCE_MODE, HALO_COLOR, HALO_FILL_ALPHA, HALO_STROKE_ALPHA, K, RATSNEST, S, saturated } from "./state";
import { adjustColor, alphaOf } from "./overlay";
import { color, layerOf, pt, widthOf } from "./util";

/** ROUTER_PREVIEW_ITEM::getLayerColor: the layer colour, or the net's colour on copper when net colours apply to everything. */
export function previewColor(layer: string, netKey?: string | null) {
  if (netKey && S.netColorMode === "all" && S.ratsnestColors && /\.Cu$/.test(layer)) { const c = S.ratsnestColors.get(netKey); if (c) return c; }
  return color(layer);
}
/** PNS_KICAD_IFACE::DisplayRatline: the ratsnest colour (the net's when net colours are on) Brightened( 0.5 ), alpha + 0.4. */
export function ratlineColor(netKey?: string | null) {
  const base = (netKey && S.netColorMode && S.netColorMode !== "off" && S.ratsnestColors && S.ratsnestColors.get(netKey)) || RATSNEST;
  return adjustColor(base, 0.5, alphaOf(base) + 0.4);
}
const mode = () => (typeof S.trackClearance === "number" ? S.trackClearance : CLEARANCE_MODE.ROUTING_VIA);
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
      // a colliding line always shows its halo; otherwise SHOW_WITH_VIA_WHILE_ROUTING_OR_DRAGGING / ALWAYS show it while dragging
      if (bad || mode() >= CLEARANCE_MODE.ROUTING_EDITING) { c.globalAlpha = HALO_STROKE_ALPHA; c.strokeStyle = HALO_COLOR; c.lineWidth = l.width + 2 * Math.max(netClearance(s, l.netKey), s.minClearance || 0); polyline(c, pts, false); }
      c.globalAlpha = 0.8; c.strokeStyle = previewColor(l.layer, l.netKey); c.lineWidth = l.width; polyline(c, pts, false);   // ROUTER_PREVIEW_ITEM: the layer colour at alpha 0.8
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
    c.globalAlpha = 0.8; c.strokeStyle = previewColor(pv.layer, rt!.netKey); c.lineWidth = pv.width; for (const e of pv.els) strokeElem(c, e);
  }
  if (rt!.dp) { drawDpRoute(c, ctx, px); return; }
  if (rt!.shove) {
    for (const L of rt!.shove.preview.lines) { if (L.pts.length < 2) continue; c.globalAlpha = 0.8; c.strokeStyle = previewColor(L.layer!, (L as { netKey?: string }).netKey); c.lineWidth = L.w; polyline(c, L.pts, false); }
    for (const v of rt!.shove.preview.vias) drawViaPreview(c, v.at, v.size, v.drill, px, 0.8);
  }
  const marks = (rt!.collisions || []).concat(rt!.viaBad || []);
  for (const ob of marks) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, HALO_FILL_ALPHA); drawShape(c, ob.shape, 0, "#00FF00", 1); }   // ROUTER::markViolations
  const els = rt!.els && rt!.els.length ? rt!.els : (rt!.head && rt!.head.length > 1 ? rt!.head.slice(0, -1).map((p: Pt, i: number) => ({ t: "seg" as const, a: p, b: rt!.head[i + 1] })) : []);
  if (els.length) {
    // the head is a PNS::LINE, a line chain: its DM_SHADOW halo is stroked at 0.9 (track_clearance_mode: any routing mode)
    if (mode() >= CLEARANCE_MODE.ROUTING) { c.globalAlpha = HALO_STROKE_ALPHA; c.strokeStyle = HALO_COLOR; c.lineWidth = rt!.width + 2 * routeHaloClearance(ctx, rt!); for (const e of els) strokeElem(c, e); }
    c.globalAlpha = 0.8; c.strokeStyle = saturated(previewColor(rt!.layer, rt!.netKey)); c.lineWidth = rt!.width; for (const e of els) strokeElem(c, e);   // PNS_HEAD_TRACE: the layer (or net) colour saturated, alpha 0.8
  }
  const via = headVia(ctx, rt!);
  if (via) {
    const at = rt!.target || rt!.last; const clr = routeHaloClearance(ctx, rt!);
    if (mode() >= CLEARANCE_MODE.ROUTING_VIA) { c.globalAlpha = HALO_FILL_ALPHA; c.fillStyle = HALO_COLOR; c.beginPath(); c.arc(at[0], at[1], via.diameter / 2 + clr, 0, 2 * Math.PI); c.fill(); }
    drawViaPreview(c, at, via.diameter, via.drill, px, 0.8);
  }
  if (rt!.ratline && S.showRatsnest) { c.globalAlpha = 1; c.strokeStyle = ratlineColor(rt!.netKey); c.lineWidth = 1 * px; line(c, (rt!.ratline as Ratline)[0], (rt!.ratline as Ratline)[1]); }
}
/** What the board render leaves out while the route shows it elsewhere: items rewritten or removed on its branch, and those the shove pushed. */
export function routeHiddenIds() {
  const rt = S.route; if (!rt) return null; const out = new Set();
  for (const st of rt.stages) for (const op of st.ops) { if (op.set) out.add(op.set); if (op.del) out.add(op.del); }
  if (rt.shove) for (const id of rt.shove.preview.hidden) out.add(id);
  if (rt.loopHidden) for (const id of rt.loopHidden) out.add(id);
  return out.size ? out : null;
}
/**
 * ROUTER_STATUS_VIEW_ITEM::ViewDraw: the message in the stroke font, its glyphs 12 px high (the hint 10 px,
 * PREVIEW::GetConstantGlyphHeight, pen 0.2 of the height). They sit in a box that fills at 0.9 and has a 2 px frame,
 * above and right of the cursor. The box takes the UI's button face and text colours.
 */
export function drawStatusNote(c: CanvasRenderingContext2D, at: Pt, cpx: number, msg: string, hint?: string | null) {
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const g = 12 * cpx, gh = 10 * cpx;
  const width = (s: string, size: number) => s ? (K.strokeLineWidth as (t: string, italic: boolean) => number)(s, false) * size + size * 0.2 : 0;
  const tw = Math.max(width(msg, g), width(hint || "", gh));
  const mx = g * 0.4, my = g * 0.6;
  const sx = tw + mx; let sy = g * 1.7; if (hint) sy += gh * 1.2;
  const ox = at[0] + mx * 5, oy = at[1] - (sy + my * 5);
  const face = css("--color-panel", "#2b2b2b"), ink = css("--color-ink", "#e0e0e0");
  c.save(); c.setLineDash([]);
  c.globalAlpha = 0.9; c.fillStyle = face; c.fillRect(ox - mx, oy - my, sx + 2 * mx, sy + 2 * my);
  c.globalAlpha = 1; c.strokeStyle = ink; c.lineWidth = 2 * cpx; c.strokeRect(ox - mx, oy - my, sx + 2 * mx, sy + 2 * my);
  const m = c.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f];
  const stroke = K.drawStrokeText as (ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number) => void;
  const tx = ox + mx, ty = oy + my;
  stroke(c, base, { x: tx, y: ty, text: msg, size: g, rot: 0, mirror: false, h: "left", v: "center", pen: g * 0.2, italic: false, dy: 0 }, ink, cpx);
  if (hint) stroke(c, base, { x: tx, y: ty + g * 1.6, text: hint, size: gh, rot: 0, mirror: false, h: "left", v: "center", pen: gh * 0.2, italic: false, dy: 0 }, ink, cpx);
  c.restore();
}
