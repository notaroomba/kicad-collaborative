import type { Box, PaintGeom, Pt } from "./types";
import { rectOf } from "./hit";
import { corners } from "./nodes";
import { K, LINE_KINDS, S, ptsOf } from "./state";
import { schArcPoints } from "./arcs";
import { segNull } from "./wire";

// ---------------------------------------------------------------- overlay painting
export function paint(c: CanvasRenderingContext2D, item: KItem, alpha: number, px: number) {
  c.save(); c.globalAlpha = alpha;
  // KGeom leaves its fields untyped (each primitive kind has its own); PaintGeom names them by kind
  for (const g of item.geom as unknown as PaintGeom[]) {
    const w = Math.max(g.w || g.wd || 0, px);
    if (g.t === "line") { c.strokeStyle = g.color; c.lineWidth = w; c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
    else if (g.t === "poly") { if (g.pts.length < 2) continue; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); if (g.fill) { c.fillStyle = g.fill; c.fill(); } c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); }
    else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); if (g.fill) { c.fillStyle = g.fill; c.fill(); } if (g.w! > 0 || !g.fill) { c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); } }
    else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); }
    else if (g.t === "rect") { if (g.fill) { c.fillStyle = g.fill; c.fillRect(g.x, g.y, g.w, g.h); } c.strokeStyle = g.color; c.lineWidth = w; c.strokeRect(g.x, g.y, g.w, g.h); }
    else if (g.t === "text") {
      c.save(); c.translate(g.x, g.y); if (g.rot) c.rotate(-g.rot * Math.PI / 180);
      c.font = `${g.size * 0.92}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`; c.textAlign = g.h; c.textBaseline = g.v === "top" ? "top" : g.v === "bottom" ? "alphabetic" : "middle";
      c.fillStyle = g.color; c.fillText(g.text, 0, 0); c.restore();
    }
  }
  c.restore();
}
export function outline(c: CanvasRenderingContext2D, item: KItem, color: string, px: number, width: number) {
  c.save(); c.strokeStyle = color; c.lineWidth = width * px; c.globalAlpha = 0.9;
  if (LINE_KINDS.has(item.kind)) { const p = ptsOf(item.node); if (p.length > 1) { c.lineCap = "round"; c.lineWidth = Math.max(0.5, 5 * px); c.globalAlpha = 0.45; c.beginPath(); c.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]); c.stroke(); } }
  else { const b = rectOf(item), pad = 0.4; c.setLineDash([4 * px, 3 * px]); c.strokeRect(b[0] - pad, b[1] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad); }
  c.restore();
}
/**
 * The geometry this module has in flight, in mm, as [x1, y1, x2, y2, widthMm] segments — what a
 * peer should see while it is being drawn.  Until this existed, a web user rubber-banding a wire
 * showed the desktop nothing but a cursor and the wire appeared out of nowhere on the drop,
 * while a desktop user doing the same was ghosted live on the web the whole time.
 */
export function ghostSegs() {
  const out: number[][] = [];
  const w = S.wire;

  if (w) {
    const width = w.kind === "bus" ? 0.3048 : 0.1524;
    for (const sg of w.segs) if (!segNull(sg)) out.push([sg[0][0], sg[0][1], sg[1][0], sg[1][1], width]);
  }
  for (const seg of (S.drag && S.drag.preview) || []) {   // wires the drop will create
    const width = seg.kind === "bus" ? 0.3048 : 0.1524;
    for (let i = 1; i < seg.pts.length; i++) out.push([seg.pts[i - 1][0], seg.pts[i - 1][1], seg.pts[i][0], seg.pts[i][1], width]);
  }
  // What a peer would otherwise not see until the drop: the outline of the items a move / drag carries,
  // of the item on the cursor (a symbol, label, image being placed) and of the shape being drawn.
  const box = (b: Box | null) => { if (b && out.length < 120) out.push([b[0], b[1], b[2], b[1], 0.1524], [b[2], b[1], b[2], b[3], 0.1524], [b[2], b[3], b[0], b[3], 0.1524], [b[0], b[3], b[0], b[1], 0.1524]); };
  const path = (pts: Pt[]) => { for (let i = 1; i < pts.length && out.length < 120; i++) out.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 0.1524]); };
  const d = S.drag;
  if (d && d.moved) for (const e of d.items) { if (LINE_KINDS.has(e.kind)) path(ptsOf(e.item.node)); else box(e.item.bbox || rectOf(e.item)); }
  if (S.carry && S.carry.item) box(S.carry.item.bbox || rectOf(S.carry.item));
  const dr = S.draw;
  if (dr && dr.arc) {   // the arc as it previews, or its construction line until there is one
    const a = schArcPoints(dr), arc = a ? K.arcFrom3(a.start, a.mid, a.end) : null;
    if (arc) { const sweep = arc.anticlockwise ? -(((arc.a0 - arc.a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) : ((arc.a1 - arc.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), ring: Pt[] = [];
      for (let i = 0; i <= 24; i++) { const t = arc.a0 + sweep * i / 24; ring.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]); } path(ring); }
    else if (dr.pts.length) path([dr.pts[0], dr.cur]);
  }
  else if (dr && dr.pts.length && dr.cur) {
    const a = dr.pts[0], c = dr.cur;
    if (dr.shape === "rect" || dr.shape === "textbox" || dr.shape === "sheet" || dr.shape === "table") box(corners(a, c));
    else if (dr.shape === "circle") { const r = Math.hypot(c[0] - a[0], c[1] - a[1]), ring: Pt[] = []; for (let i = 0; i <= 24; i++) ring.push([a[0] + r * Math.cos(i * Math.PI / 12), a[1] + r * Math.sin(i * Math.PI / 12)]); path(ring); }
    else path(dr.pts.concat([c]));
  }
  return out;
}
