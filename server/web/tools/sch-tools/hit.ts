import type { Box, SchCtx, SchGeom, Pt } from "./types";
import { root } from "../root";
import { mmPerPx } from "./snap";
import { K, LINE_KINDS, SHAPE_KINDS, TEXT_KINDS, atOf, kid, num, str } from "./state";
import { area, segDist, segs } from "./util";

// ---------------------------------------------------------------- hit testing for non-symbol items
export function fontSize(node: SNode) { const e = kid(node, "effects"), f = e && kid(e, "font"), s = f && kid(f, "size"); return s ? num(s[2], num(s[1], 1.27)) : 1.27; }
// Estimated footprint of a label/text on screen (the canvas only boxes the anchor).
export function textRect(item: Pick<KItem, "kind" | "node">): Box {
  const n = item.node, [x, y, rot] = atOf(n), size = fontSize(n), lines = str(n[1]).split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  let w = longest * size * 0.75 + size * 0.4; if (item.kind !== "label" && item.kind !== "text") w += size * 1.6;
  const v0 = -size * 1.4, v1 = (lines.length - 1) * size * 1.5 + size * 0.2;
  const th = (((Math.round(rot) % 360) + 360) % 360) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const map = (u: number, v: number) => [x + u * cs + v * sn, y - u * sn + v * cs];
  const c = [map(0, v0), map(w, v0), map(w, v1), map(0, v1)];
  return [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
}
export function rectOf(item: KItem): Box { return TEXT_KINDS.has(item.kind) ? textRect(item) : item.bbox || (() => { const [x, y] = atOf(item.node); return [x - 0.6, y - 0.6, x + 0.6, y + 0.6]; })(); }
export const boxDist = (b: Box | null, x: number, y: number) => b ? Math.max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0) : Infinity;
export function inSweep(t: number, g: SchGeom) { const n = (v: number) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return g.anticlockwise ? n(g.a0 - t) <= n(g.a0 - g.a1) : n(t - g.a0) <= n(g.a1 - g.a0); }
/** Distance from (x, y) to a canvas geometry's stroke (shapes are picked by their outline, like KiCad). */
export function geomDist(g: SchGeom, x: number, y: number) {
  if (g.t === "line") return segDist([x, y], [g.x1, g.y1], [g.x2, g.y2]);
  if (g.t === "poly") { const n = g.pts.length; if (n < 2) return Infinity; let d = Infinity; for (let i = 0; i < (g.close ? n : n - 1); i++) d = Math.min(d, segDist([x, y], g.pts[i], g.pts[(i + 1) % n])); return d; }
  if (g.t === "circle") return Math.abs(Math.hypot(x - g.x, y - g.y) - g.r);
  if (g.t === "arc") return inSweep(Math.atan2(y - g.y, x - g.x), g) ? Math.abs(Math.hypot(x - g.x, y - g.y) - g.r) : Infinity;
  if (g.t === "rect") return boxDist([g.x, g.y, g.x + g.w, g.y + g.h], x, y);
  return Infinity;
}
export function hitNonSymbol(doc: KDoc, x: number, y: number, tol: number) {
  let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    let d: number;
    if (LINE_KINDS.has(it.kind)) { d = Infinity; for (const [a, b] of segs(it)) d = Math.min(d, segDist([x, y], a, b)); d += 0.01; }   // small things on a line win ties
    else if (SHAPE_KINDS.has(it.kind) || it.kind === "bezier" || it.kind === "rule_area") { d = Infinity; for (const g of it.geom as SchGeom[]) if (!g.noStroke) d = Math.min(d, geomDist(g, x, y)); d += 0.01; }
    else if (it.kind === "text_box" || it.kind === "netclass_flag" || it.kind === "directive_label" || it.kind === "table" || it.kind === "image") d = boxDist(it.bbox, x, y);
    else if (it.kind === "bus_entry") { const [ax, ay] = atOf(it.node), s = kid(it.node, "size"); d = segDist([x, y], [ax, ay], [ax + (s ? num(s[1]) : 2.54), ay + (s ? num(s[2]) : 2.54)]); }
    else if (it.kind === "junction" || it.kind === "no_connect") { const [ax, ay] = atOf(it.node); d = Math.max(0, Math.hypot(ax - x, ay - y) - 0.6); }
    else if (TEXT_KINDS.has(it.kind)) { const b = textRect(it); d = Math.max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0); }
    else continue;
    if (d <= tol && d < bd) { bd = d; best = it; }
  }
  return best;
}
// Our pick for the select tool; null hands the click back to app.js (symbols, empty space).
export function pickNonSymbol(ctx: SchCtx, mm: Pt) {
  const hit = hitNonSymbol(ctx.doc, mm[0], mm[1], Math.max(0.3, 5 * mmPerPx(ctx))); if (!hit) return null;
  const allowed = root.CollabEditor && root.CollabEditor.pickAllowed; if (allowed && !allowed(hit)) return null;   // the Selection Filter pane
  const symId = K.hitTest(ctx.doc, mm[0], mm[1], 0.5);
  if (symId && !LINE_KINDS.has(hit.kind)) { const sym = ctx.doc.items.get(symId); if (sym && area(sym.bbox) < area(rectOf(hit))) return null; }
  return hit;
}
// Anything under the cursor: our own items first, then the symbols and sheets app.js selects (K.hitTest).
export function pickAny(ctx: SchCtx, mm: Pt) {
  const hit = pickNonSymbol(ctx, mm); if (hit) return hit;
  const id = K.hitTest(ctx.doc, mm[0], mm[1], Math.max(0.3, 5 * mmPerPx(ctx)));
  return id ? ctx.doc.items.get(id) || null : null;
}
