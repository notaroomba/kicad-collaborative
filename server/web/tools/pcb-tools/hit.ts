// pcb-tools/hit.ts — hit testing of the non-footprint items.
import type { BoardDoc, PcbGeom, Pt } from "./types";

// ---------------------------------------------------------------- hit testing (non-footprint items)
export function distSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
export function pointInPoly(pts: Pt[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function inSweep(t: number, g: Pick<PcbGeom, "a0" | "a1" | "anticlockwise">) {
  const norm = (v: number) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return g.anticlockwise ? norm(g.a0 - t) <= norm(g.a0 - g.a1) : norm(t - g.a0) <= norm(g.a1 - g.a0);
}
/** Distance from (x, y) to a geometry's stroke edge (0 inside a filled shape). */
export function geomDist(g: PcbGeom, x: number, y: number) {
  if (g.t === "line") return distSeg(x, y, g.x1, g.y1, g.x2, g.y2) - g.w / 2;
  if (g.t === "poly") {
    const n = g.pts.length; if (n < 2) return Infinity;
    if (g.fill && pointInPoly(g.pts, x, y)) return 0;
    let d = Infinity;
    for (let i = 0; i < (g.close ? n : n - 1); i++) { const a = g.pts[i], b = g.pts[(i + 1) % n]; d = Math.min(d, distSeg(x, y, a[0], a[1], b[0], b[1])); }
    return d - g.w / 2;
  }
  if (g.t === "circle") { const d = Math.hypot(x - g.x, y - g.y); return g.fill && d <= g.r ? d - g.r : Math.abs(d - g.r) - g.w / 2; }   // deep inside a via beats the tracks meeting under it
  if (g.t === "arc") { const d = Math.hypot(x - g.x, y - g.y); return inSweep(Math.atan2(y - g.y, x - g.x), g) ? Math.abs(d - g.r) - g.w / 2 : Infinity; }
  if (g.t === "rect" || g.t === "image") return (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) ? 0 : Infinity;
  return Infinity;
}
/** Nearest track / via / graphic / text within slop mm of (x, y); footprints are app.js's business. */
export function hitTestItem(doc: BoardDoc, x: number, y: number, slop: number, only?: ((it: KItem) => boolean) | null) {
  let best: KItem | null = null, bd = slop;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint" || it.kind === "group" || it.kind === "generated" || !it.bbox) continue;
    if (only && !only(it)) continue;
    const b = it.bbox; if (x < b[0] - slop || x > b[2] + slop || y < b[1] - slop || y > b[3] + slop) continue;
    let d = Infinity;
    if (it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") d = (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) ? slop * 0.5 : Infinity;   // precise copper hits win over a text box
    else for (const g of it.geom as PcbGeom[]) { if (it.kind === "zone" && g.fill) continue; d = Math.min(d, geomDist(g, x, y)); }
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}
