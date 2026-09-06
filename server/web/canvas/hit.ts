// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { SCH_LAYERS, pcbColor, pcbZ } from "./colors";
import { boxUnion } from "./geom";
import { kids, pointInPoly } from "./sexpr";
import { textWidth } from "./text";
// ---------------------------------------------------------------- queries
export function movableItems(doc) {
  const out = [];
  for (const it of doc.items.values()) {
    if (!it.movable) continue;
    out.push({ id: it.id, kind: it.kind, x: it.x, y: it.y, rot: it.rot || 0, ref: it.ref || "", value: it.value || "", lib: it.lib || "", layer: it.layer || "", bbox: it.bbox, name: it.name, file: it.file, w: it.w, h: it.h });
  }
  return out;
}

/** Extent of one geometry record (mm), or null for records without a footprint on the page. */
export function geomBox(g) {
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

export function segDistance(x, y, x1, y1, x2, y2) { const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy; let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); }

/** Does (x, y) touch this geometry record within tol mm?  Text counts by its box, like KiCad's text hit tests. */
export function geomHit(g, x, y, tol) {
  const w = (g.w || 0) / 2 + tol;
  switch (g.t) {
  case "line": return segDistance(x, y, g.x1, g.y1, g.x2, g.y2) <= w;
  case "poly": { const n = g.pts.length; if (n < 2) return false; if (g.fill && pointInPoly(g.pts, x, y)) return true; for (let i = 0; i < (g.close ? n : n - 1); i++) { const a = g.pts[i], b = g.pts[(i + 1) % n]; if (segDistance(x, y, a[0], a[1], b[0], b[1]) <= w) return true; } return false; }
  case "circle": { const d = Math.hypot(x - g.x, y - g.y); return g.fill ? d <= g.r + tol : Math.abs(d - g.r) <= w; }
  case "arc": { const d = Math.hypot(x - g.x, y - g.y); return Math.abs(d - g.r) <= w; }
  case "rect": return x >= g.x - w && x <= g.x + g.w + w && y >= g.y - w && y <= g.y + g.h + w;
  case "pad": {   // the pad's own outline in its rotated frame (circles / ovals by radius, everything else by the box)
    const a = (g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), dx = x - g.x, dy = y - g.y;
    const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
    if (g.shape === "circle") return Math.hypot(lx, ly) <= g.w / 2 + tol;
    if (g.shape === "oval") { const rr = Math.min(g.w, g.h) / 2; const ex = Math.max(0, Math.abs(lx) - (g.w / 2 - rr)), ey = Math.max(0, Math.abs(ly) - (g.h / 2 - rr)); return Math.hypot(ex, ey) <= rr + tol; }
    return Math.abs(lx) <= g.w / 2 + tol && Math.abs(ly) <= g.h / 2 + tol;
  }
  case "image": case "text": { const b = geomBox(g); return !!b && x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol; }
  default: return false;
  }
}

/**
 * The movable item under (x, y) with KiCad's candidate ranking (PCB_SELECTION_TOOL::GuessSelectionCandidates):
 * only geometry on visible layers counts (opts.hidden = Set of layer keys), a hit on the item's own
 * geometry beats a hit inside its empty bounding box, the preferred side (opts.side "F" | "B", the
 * active layer's side) beats the other, and the smaller visible extent wins ties.
 * Returns {id, onGeom, layer, box} or null; hitTest() is the id-only form.
 */
export function hitTestDetail(doc, x, y, slopMm, opts) {
  slopMm = slopMm || 0; opts = opts || {}; const hidden = opts.hidden || null, side = opts.side || null;
  let best = null;
  for (const it of doc.items.values()) {
    if (!it.movable || !it.bbox) continue;
    const b = it.bbox;
    if (x < b[0] - slopMm || x > b[2] + slopMm || y < b[1] - slopMm || y > b[3] + slopMm) continue;
    let onGeom = false, hitLayer = null, vis = null, hitClass = 2;   // 0 = pad / copper, 1 = other geometry, 2 = box only
    for (const g of it.geom) {
      if (hidden && g.layer && hidden.has(g.layer)) continue;
      const gb = geomBox(g); if (!gb) continue;
      if (!vis) vis = gb.slice(); else { if (gb[0] < vis[0]) vis[0] = gb[0]; if (gb[1] < vis[1]) vis[1] = gb[1]; if (gb[2] > vis[2]) vis[2] = gb[2]; if (gb[3] > vis[3]) vis[3] = gb[3]; }
      if (g.padText || g.padNum || g.noBox) continue;                       // pad numbers / net names are labels, not selectable geometry
      if (hitClass > 0 && x >= gb[0] - slopMm && x <= gb[2] + slopMm && y >= gb[1] - slopMm && y <= gb[3] + slopMm && geomHit(g, x, y, slopMm)) {
        onGeom = true; const cls = (g.t === "pad" || (g.t !== "text" && /\.Cu$/.test(g.layer || ""))) ? 0 : 1;   // a pad under the cursor beats another part's silkscreen / courtyard / text over it
        if (cls < hitClass) { hitClass = cls; hitLayer = g.layer || null; }
      }
    }
    if (!vis) continue;                                                   // nothing of it is visible: not selectable
    if (x < vis[0] - slopMm || x > vis[2] + slopMm || y < vis[1] - slopMm || y > vis[3] + slopMm) continue;
    const area = Math.max(0, vis[2] - vis[0]) * Math.max(0, vis[3] - vis[1]);
    const itemSide = it.layer && /^B\./.test(it.layer) ? "B" : "F";
    const score = hitClass * 1e11 + (side && itemSide !== side ? 1e9 : 0) + area;
    if (!best || score < best.score) best = { id: it.id, onGeom, layer: hitLayer, box: vis, score };
  }
  return best;
}

export function hitTest(doc, x, y, slopMm, opts) { const h = hitTestDetail(doc, x, y, slopMm, opts); return h ? h.id : null; }

export function layerList(doc) {
  const counts = new Map();
  for (const it of doc.items.values()) for (const g of it.geom) counts.set(g.layer, (counts.get(g.layer) || 0) + 1);
  if (doc.type === "sch") return SCH_LAYERS.map(([name, color]) => ({ key: name, name, color, count: counts.get(name) || 0 })).filter((l) => l.count);
  const out = [];
  for (const [layer, count] of counts) if (layer !== "holes") out.push({ key: layer, name: layer, color: pcbColor(layer), count, z: pcbZ(layer) });
  out.sort((a, b) => b.z - a.z);
  return out;
}

export function snap(v, pitch) { return pitch > 0 ? Math.round(v / pitch) * pitch : v; }


// ---------------------------------------------------------------- queries for the tools layer
/** Union bbox [x0, y0, x1, y1] of the given item ids (Set or array), or null when none has a box — "zoom to selection". */
export function bboxOf(doc, ids) {
  let b = null;
  for (const id of ids || []) { const it = doc.items.get(id); if (it && it.bbox) b = boxUnion(b, it.bbox[0], it.bbox[1], it.bbox[2], it.bbox[3]); }
  return b;
}

/** Does a pad geometry (world space) cover (x, y)?  Pad records use their rotated frame; polygon pads and custom primitives their outline. */
export function padGeomHit(g, x, y) {
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
export function padAt(doc, x, y) {
  let best = null, bestArea = Infinity;
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

export function polyArea(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a) / 2; }
