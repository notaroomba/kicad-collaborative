// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { SCH, SCH_LAYERS, pcbColor, pcbZ } from "./colors";
import { boxUnion } from "./geom";
import { kids, pointInPoly, rotator } from "./sexpr";
import { textWidth } from "./text";
import type { Box, CircleGeom, Doc, Geom, Item, PadGeom, PolyGeom, Pt } from "./types";

/** A movable item as the chrome lists it (movableItems). */
export interface MovableInfo { id: string; kind: string; x?: number; y?: number; rot: number; ref: string; value: string; lib: string; layer: string; bbox: Box | null; name?: string; file?: string; page?: string; w?: number; h?: number }
/** hitTestDetail's answer: the item, whether its own geometry was hit, the rank class, the layer hit and the visible box. */
export interface HitDetail { id: string; onGeom: boolean; cls: number; layer: string | null; box: Box; score: number }
/** padAt's answer. */
export interface PadHit { item: Item; index: number; pad: SNode | null; number?: string; net?: number; netName?: string; x: number; y: number }
// ---------------------------------------------------------------- queries
export function movableItems(doc: Doc): MovableInfo[] {
  const out: MovableInfo[] = [];
  for (const it of doc.items.values()) {
    if (!it.movable) continue;
    out.push({ id: it.id, kind: it.kind, x: it.x, y: it.y, rot: it.rot || 0, ref: it.ref || "", value: it.value || "", lib: it.lib || "", layer: it.layer || "", bbox: it.bbox, name: it.name, file: it.file, page: it.page, w: it.w, h: it.h });
  }
  return out;
}

/** Extent of one geometry record (mm), or null for records without a footprint on the page. */
export function geomBox(g: Geom): Box | null {
  const w = (g.w || 0) / 2;
  switch (g.t) {
  case "line": return [Math.min(g.x1, g.x2) - w, Math.min(g.y1, g.y2) - w, Math.max(g.x1, g.x2) + w, Math.max(g.y1, g.y2) + w];
  case "poly": { if (!g.pts || !g.pts.length) return null; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of g.pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; } return [x0 - w, y0 - w, x1 + w, y1 + w]; }
  case "circle": case "arc": return [g.x - g.r - w, g.y - g.r - w, g.x + g.r + w, g.y + g.r + w];
  case "rect": return [g.x - w, g.y - w, g.x + g.w + w, g.y + g.h + w];
  case "image": return [g.x - g.w / 2, g.y - g.h / 2, g.x + g.w / 2, g.y + g.h / 2];
  case "pad": { const r = g.rot ? Math.hypot(g.w, g.h) / 2 : 0; return g.rot ? [g.x - r, g.y - r, g.x + r, g.y + r] : [g.x - g.w / 2, g.y - g.h / 2, g.x + g.w / 2, g.y + g.h / 2]; }
  case "text": { const tw = textWidth(g.text || "", g.size || 1, g.w || 0), th = g.size || 1; const r = Math.max(tw, th); return [g.x - r, g.y - r, g.x + r, g.y + r]; }
  default: return null;
  }
}

export function segDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number { const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy; let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); }

/** Does (x, y) touch this geometry record within tol mm?  Text counts by its box, like KiCad's text hit tests. */
export function geomHit(g: Geom, x: number, y: number, tol: number): boolean {
  const w = (g.w || 0) / 2 + tol;
  switch (g.t) {
  case "line": return segDistance(x, y, g.x1, g.y1, g.x2, g.y2) <= w;
  case "poly": { const n = g.pts.length; if (n < 2) return false; if (g.fill && pointInPoly(g.pts, x, y)) return true; for (let i = 0; i < (g.close ? n : n - 1); i++) { const a = g.pts[i], b = g.pts[(i + 1) % n]; if (segDistance(x, y, a[0], a[1], b[0], b[1]) <= w) return true; } return false; }
  case "circle": { const d = Math.hypot(x - g.x, y - g.y); return g.fill ? d <= g.r + tol : Math.abs(d - g.r) <= w; }
  case "arc": {   // on the stroke and inside the sweep (or within reach of one of its ends) — not anywhere on the full circle
    const d = Math.hypot(x - g.x, y - g.y); if (Math.abs(d - g.r) > w) return false;
    if (g.pie || g.a0 === undefined || g.a1 === undefined) return true;
    const TWO = Math.PI * 2, nrm = (v: number) => ((v % TWO) + TWO) % TWO;
    const from = g.anticlockwise ? g.a1 : g.a0, sweep = nrm((g.anticlockwise ? g.a0 : g.a1) - from) || TWO;
    if (nrm(Math.atan2(y - g.y, x - g.x) - from) <= sweep) return true;
    return Math.hypot(x - (g.x + g.r * Math.cos(g.a0)), y - (g.y + g.r * Math.sin(g.a0))) <= w || Math.hypot(x - (g.x + g.r * Math.cos(g.a1)), y - (g.y + g.r * Math.sin(g.a1))) <= w;
  }
  case "rect": return x >= g.x - w && x <= g.x + g.w + w && y >= g.y - w && y <= g.y + g.h + w;
  case "pad": {   // the pad's own outline in its rotated frame (circles / ovals by radius, everything else by the box)
    const a = (g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), dx = x - g.x, dy = y - g.y;
    const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
    if (g.shape === "circle") return Math.hypot(lx, ly) <= g.w / 2 + tol;
    if (g.shape === "oval") { const rr = Math.min(g.w, g.h) / 2; const ex = Math.max(0, Math.abs(lx) - (g.w / 2 - rr)), ey = Math.max(0, Math.abs(ly) - (g.h / 2 - rr)); return Math.hypot(ex, ey) <= rr + tol; }
    return Math.abs(lx) <= g.w / 2 + tol && Math.abs(ly) <= g.h / 2 + tol;
  }
  case "text": {   // the text's own box — its width along the reading direction, placed by the justification and turned with it (EDA_TEXT::TextHitTest)
    const tw = textWidth(g.text || "", g.sizeX || g.size || 1, g.w || 0), th = g.size || 1;
    const x0 = g.h === "left" ? 0 : g.h === "right" ? -tw : -tw / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -th : -th / 2;
    let [lx, ly] = rotator(-(g.rot || 0))(x - g.x, y - g.y); if (g.mirror) lx = -lx;
    return lx >= x0 - tol && lx <= x0 + tw + tol && ly >= y0 - tol && ly <= y0 + th + tol;
  }
  case "image": { const b = geomBox(g); return !!b && x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol; }
  default: return false;
  }
}

/** Does the segment a-b pass through (or lie inside) the rectangle?  Liang-Barsky. */
export function segTouchesRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** Does this geometry record reach into the rectangle — its stroke or filled area, not merely its bounding box? */
export function geomTouchesRect(g: Geom, x0: number, y0: number, x1: number, y1: number): boolean {
  const b = geomBox(g); if (!b || b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) return false;
  const w = (g.w || 0) / 2;
  switch (g.t) {
  case "line": return segTouchesRect(g.x1, g.y1, g.x2, g.y2, x0 - w, y0 - w, x1 + w, y1 + w);
  case "poly": {
    const n = g.pts.length; if (!n) return false;
    for (let i = 0; i < (g.close || g.fill ? n : n - 1); i++) { const a = g.pts[i], c = g.pts[(i + 1) % n]; if (segTouchesRect(a[0], a[1], c[0], c[1], x0 - w, y0 - w, x1 + w, y1 + w)) return true; }
    return !!g.fill && pointInPoly(g.pts, x0, y0);          // the rectangle sits wholly inside a filled outline
  }
  case "circle": {
    const cx = Math.max(x0, Math.min(g.x, x1)), cy = Math.max(y0, Math.min(g.y, y1));
    if (Math.hypot(cx - g.x, cy - g.y) > g.r + w) return false;
    if (g.fill) return true;
    const far = Math.max(Math.hypot(x0 - g.x, y0 - g.y), Math.hypot(x1 - g.x, y0 - g.y), Math.hypot(x0 - g.x, y1 - g.y), Math.hypot(x1 - g.x, y1 - g.y));
    return far >= g.r - w;                                  // not swallowed by the hole of an unfilled circle
  }
  case "arc": {
    if (g.a0 === undefined || g.a1 === undefined) return true;
    const TWO = Math.PI * 2, nrm = (v: number) => ((v % TWO) + TWO) % TWO;
    const from = g.anticlockwise ? g.a1 : g.a0, sweep = nrm((g.anticlockwise ? g.a0 : g.a1) - from) || TWO, steps = Math.max(4, Math.ceil(sweep / (Math.PI / 16)));
    let px = g.x + g.r * Math.cos(from), py = g.y + g.r * Math.sin(from);
    for (let i = 1; i <= steps; i++) { const a = from + sweep * i / steps, qx = g.x + g.r * Math.cos(a), qy = g.y + g.r * Math.sin(a); if (segTouchesRect(px, py, qx, qy, x0 - w, y0 - w, x1 + w, y1 + w)) return true; px = qx; py = qy; }
    return false;
  }
  default: return true;                                     // pads, text, images: by their box
  }
}

/**
 * A selection box that takes what it touches (dragged right to left): does any visible geometry of the item
 * reach into it?  A zone counts by its outline only, as in ZONE::HitTest — a box inside a pour does not take
 * the pour — and a diagonal track by its copper, not by the rectangle around it.
 */
export function itemTouchesRect(it: Pick<Item, "geom">, x0: number, y0: number, x1: number, y1: number, hidden?: Set<string> | null): boolean {
  for (const g of it.geom || []) {
    if (g.zoneFill || g.padText || g.padNum || g.noBox) continue;
    if (hidden && g.layer && hidden.has(g.layer)) continue;
    if (geomTouchesRect(g, x0, y0, x1, y1)) return true;
  }
  return false;
}

/** Is anything of the item on a layer that is shown?  (What cannot be seen cannot be selected.) */
export function itemVisible(it: Pick<Item, "geom">, hidden?: Set<string> | null): boolean {
  if (!hidden || !hidden.size) return true;
  let drawn = false;
  for (const g of it.geom || []) { if (!g.layer) continue; drawn = true; if (!hidden.has(g.layer)) return true; }
  return !drawn;
}

/**
 * The movable item under (x, y) with KiCad's candidate ranking (PCB_SELECTION_TOOL::GuessSelectionCandidates):
 * only geometry on visible layers counts (opts.hidden = Set of layer keys), a hit on the item's own
 * geometry beats a hit inside its empty bounding box, the preferred side (opts.side "F" | "B", the
 * active layer's side) beats the other, and the smaller visible extent wins ties.
 * Returns {id, onGeom, layer, box} or null; hitTest() is the id-only form.
 */
export function hitTestDetail(doc: Doc, x: number, y: number, slopMm?: number, opts?: { hidden?: Set<string> | null; side?: string | null } | null): HitDetail | null {
  slopMm = slopMm || 0; opts = opts || {}; const hidden = opts.hidden || null, side = opts.side || null;
  let best: HitDetail | null = null;
  for (const it of doc.items.values()) {
    if (!it.movable || !it.bbox) continue;
    const b = it.bbox;
    if (x < b[0] - slopMm || x > b[2] + slopMm || y < b[1] - slopMm || y > b[3] + slopMm) continue;
    let onGeom = false, exact = false, hitLayer: string | null = null, vis: Box | null = null, hull: Box | null = null, hitClass = 2;   // 0 = pad / copper, 1 = other geometry, 2 = box only
    const grow = (b: Box | null, gb: Box): Box => { if (!b) return gb.slice(); if (gb[0] < b[0]) b[0] = gb[0]; if (gb[1] < b[1]) b[1] = gb[1]; if (gb[2] > b[2]) b[2] = gb[2]; if (gb[3] > b[3]) b[3] = gb[3]; return b; };
    for (const g of it.geom) {
      if (hidden && g.layer && hidden.has(g.layer)) continue;
      const gb = geomBox(g); if (!gb) continue;
      vis = grow(vis, gb);
      if (g.padText || g.padNum || g.noBox) continue;                       // pad numbers / net names are labels, not selectable geometry
      if (g.t !== "text") hull = grow(hull, gb);                             // FOOTPRINT::HitTestAccurate / SCH_SYMBOL body box: shapes and pads, never the fields
      if (hitClass > 0 && x >= gb[0] - slopMm && x <= gb[2] + slopMm && y >= gb[1] - slopMm && y <= gb[3] + slopMm && geomHit(g, x, y, slopMm)) {
        onGeom = true; if (!exact && (slopMm <= 0 || geomHit(g, x, y, 0))) exact = true;
        const cls = (g.t === "pad" || (g.t !== "text" && /\.Cu$/.test(g.layer || ""))) ? 0 : 1;   // a pad under the cursor beats another part's silkscreen / courtyard / text over it
        if (cls < hitClass) { hitClass = cls; hitLayer = g.layer || null; }
      }
    }
    if (!vis) continue;                                                   // nothing of it is visible: not selectable
    // an empty-box hit only counts inside the hull of the item's shapes: a reference text hanging far off
    // the body must not make the empty space beside a part select it (KiCad's HitTestAccurate)
    const hb = hull || vis;
    if (x < hb[0] - slopMm || x > hb[2] + slopMm || y < hb[1] - slopMm || y > hb[3] + slopMm) continue;
    // PCB_SELECTION_TOOL::GuessSelectionCandidates "prefer exact hits to sloppy ones": a point inside a part's
    // hull (hitTestDistance 0 for a footprint / symbol) or on an item's own geometry beats an item that is only
    // reached through the click tolerance, so the middle of a part never picks its neighbour's silkscreen
    if (!exact && hull && (it.kind === "footprint" || it.kind === "symbol" || it.kind === "sheet") && x >= hull[0] && x <= hull[2] && y >= hull[1] && y <= hull[3]) exact = true;
    const area = Math.max(0, vis[2] - vis[0]) * Math.max(0, vis[3] - vis[1]);
    const itemSide = it.layer && /^B\./.test(it.layer) ? "B" : "F";
    const score = (exact ? 0 : 1e13) + hitClass * 1e11 + (side && itemSide !== side ? 1e9 : 0) + area;
    if (!best || score < best.score) best = { id: it.id, onGeom, cls: hitClass, layer: hitLayer, box: vis, score };
  }
  return best;
}

export function hitTest(doc: Doc, x: number, y: number, slopMm?: number, opts?: { hidden?: Set<string> | null; side?: string | null } | null): string | null { const h = hitTestDetail(doc, x, y, slopMm, opts); return h ? h.id : null; }

export function layerList(doc: Doc): { key: string; name: string; color: string; count: number; z?: number }[] {
  const counts = new Map<string, number>();
  for (const it of doc.items.values()) for (const g of it.geom) counts.set(g.layer, (counts.get(g.layer) || 0) + 1);
  if (doc.type === "sch") return SCH_LAYERS.map(([name, key]) => ({ key: name, name, color: SCH[key], count: counts.get(name) || 0 })).filter((l) => l.count);
  const out: { key: string; name: string; color: string; count: number; z: number }[] = [];
  for (const [layer, count] of counts) if (layer !== "holes") out.push({ key: layer, name: layer, color: pcbColor(layer), count, z: pcbZ(layer) });
  out.sort((a, b) => b.z - a.z);
  return out;
}

export function snap(v: number, pitch: number): number { return pitch > 0 ? Math.round(v / pitch) * pitch : v; }


// ---------------------------------------------------------------- queries for the tools layer
/** Union bbox [x0, y0, x1, y1] of the given item ids (Set or array), or null when none has a box — "zoom to selection". */
export function bboxOf(doc: Doc, ids: Iterable<string> | null | undefined): Box | null {
  let b: Box | null = null;
  for (const id of ids || []) { const it = doc.items.get(id); if (it && it.bbox) b = boxUnion(b, it.bbox[0], it.bbox[1], it.bbox[2], it.bbox[3]); }
  return b;
}

/** Does a pad geometry (world space) cover (x, y)?  Pad records use their rotated frame; polygon pads and custom primitives their outline. */
/** (A type guard: only pad, polygon and circle records can cover a point; the others answer false.) */
export function padGeomHit(g: Geom, x: number, y: number): g is PadGeom | PolyGeom | CircleGeom {
  if (g.t === "pad") {
    const a = -g.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a); const dx = x - g.x, dy = y - g.y;
    const lx = dx * c + dy * sn, ly = -dx * sn + dy * c; const w = g.w, h = g.h;
    if (g.shape === "circle") return Math.hypot(lx, ly) <= Math.max(w, h) / 2;
    if (Math.abs(lx) > w / 2 || Math.abs(ly) > h / 2) return false;
    const r = g.shape === "oval" ? Math.min(w, h) / 2 : Math.min(g.rr || 0, w / 2, h / 2);
    if (r <= 0) return true;
    const qx = Math.max(Math.abs(lx) - (w / 2 - r), 0), qy = Math.max(Math.abs(ly) - (h / 2 - r), 0);
    return Math.hypot(qx, qy) <= r;
  }
  if (g.t === "poly") return g.pts.length > 2 && pointInPoly(g.pts, x, y);
  if (g.t === "circle") return Math.hypot(x - g.x, y - g.y) <= g.r;
  return false;
}

/**
 * The pad under (x, y) mm — the renderer's own world-space pad shapes (footprint transform applied):
 * { item, index (among the footprint's pad nodes), pad (the node), number, net, netName, x, y } or null; the
 * smallest covering pad wins.
 */
export function padAt(doc: Doc, x: number, y: number): PadHit | null {
  let best: PadHit | null = null, bestArea = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const b = it.bbox; if (b && (x < b[0] || x > b[2] || y < b[1] || y > b[3])) continue;
    for (const g of it.geom) {
      if (!g.pad || g.hole || g.padIndex === undefined || g.t === "text" || !padGeomHit(g, x, y)) continue;
      const area = g.t === "pad" ? g.w * g.h : g.t === "circle" ? Math.PI * g.r * g.r : polyArea(g.pts);
      if (area >= bestArea) continue;
      bestArea = area;
      const cx = g.t === "poly" ? g.pts.reduce((a, p) => a + p[0], 0) / g.pts.length : g.x, cy = g.t === "poly" ? g.pts.reduce((a, p) => a + p[1], 0) / g.pts.length : g.y;
      best = { item: it, index: g.padIndex, pad: kids(it.node, "pad")[g.padIndex] || null, number: g.padNumber, net: g.net, netName: g.netName, x: cx, y: cy };
    }
  }
  return best;
}

export function polyArea(pts: readonly (readonly number[])[]): number { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a) / 2; }
