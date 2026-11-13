// pcb-tools/guess.ts — the delete tool's pick and GuessSelectionCandidates.
import type { BoardDoc, Box, GeomPrim, PcbCtx, Pt } from "./types";

/** A selection candidate as GuessSelectionCandidates weighs it (candidateEntry). */
export interface CandEntry { id: string; item: KItem; pad: boolean; geoms: GeomPrim[]; /** a footprint field (PCB_FIELD_T), as "fpId@field:Name" */ field?: string }
/** The candidate id of a footprint field: GENERAL_COLLECTOR lists PCB_FIELD_T beside its footprint. */
export const fieldCandidateId = (fpId: string, name: string) => `${fpId}@field:${name}`;
/** guessCandidates' options. */
export interface GuessOpts { px?: number; activeLayer?: string; hidden?: Set<string> | null; viewport?: number[] | null; highContrast?: boolean }
import { statusPopup } from "./assistants";
import { deleteChanges } from "./changes";
import { expandGroups, isLocked } from "./groups";
import { hitTestItem } from "./hit";
import { HIT_MM, K, S } from "./state";
import { layerOf } from "./util";

/** The delete tool's click: a track / via / graphic under the cursor first, else the footprint app.js would pick. */
export function itemAt(ctx: PcbCtx, mm: Pt) {
  const doc = ctx.doc, [x, y] = mm;
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1)); if (it) return it;
  const id = K.hitTest(doc, x, y, Math.min(5 / Math.max(1, (ctx.zoom || 1) * 0.6), 0.5));
  return id ? doc.items.get(id) || null : null;
}
// ---------------------------------------------------------------- GuessSelectionCandidates
export const SILK_RE = /\.(SilkS|Silkscreen)$/, CRTYD_RE = /\.(CrtYd|Courtyard)$/;
export const TEXTISH = new Set(["gr_text", "gr_text_box", "text", "property", "fp_text"]);
/** A candidate id ("fpId#padIndex" for a pad) as { id, item, pad, geoms }: the geometry KiCad would hit-test. */
export function candidateEntry(doc: BoardDoc, id: string, hidden: Set<string> | null | undefined): CandEntry | null {
  const fi = typeof id === "string" ? id.indexOf("@field:") : -1;
  if (fi > 0) {   // the field's text box (EDA_TEXT::GetTextBox), a filled quad on the field's layer
    const item = doc.items.get(id.slice(0, fi)); if (!item) return null;
    const name = id.slice(fi + 7), fb = (K.fieldBoxes(item, hidden || null) as unknown as { name: string; pts: Pt[]; geom: GeomPrim }[]).find((f) => f.name === name); if (!fb) return null;
    return { id, item, pad: false, field: name, geoms: [{ t: "poly", pts: fb.pts, fill: true, w: 0, layer: fb.geom.layer } as unknown as GeomPrim] };
  }
  const h = typeof id === "string" ? id.indexOf("#") : -1;
  const item = doc.items.get(h > 0 ? id.slice(0, h) : id); if (!item) return null;
  const padIndex = h > 0 ? Number(id.slice(h + 1)) : null;
  const geoms = ((item.geom || []) as GeomPrim[]).filter((g) => !(hidden && g.layer && hidden.has(g.layer)) && !g.padText && !g.padNum && !g.noBox && !g.hole
    && (padIndex === null || g.padIndex === padIndex));
  return { id, item, pad: padIndex !== null, geoms };
}
/** How far (mm) the cursor is from one geometry, up to maxSlop (Infinity beyond): SHAPE::Collide( loc, aMaxDistance, &distance ). */
export function geomDistance(g: GeomPrim, x: number, y: number, maxSlop: number) {
  if (K.geomHit(g, x, y, 0)) return 0;
  if (!K.geomHit(g, x, y, maxSlop)) return Infinity;
  let lo = 0, hi = maxSlop; for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (K.geomHit(g, x, y, m)) hi = m; else lo = m; }
  return hi;
}
export const isZoneFill = (e: CandEntry, g: GeomPrim) => e.item.kind === "zone" && !!g.fill;
/** PCB_SELECTION_TOOL::hitTestDistance (mm). */
export function hitTestDistance(e: CandEntry, x: number, y: number, maxSlop: number, viewport?: number[] | null) {
  const it = e.item; let d = Infinity;
  if (it.kind === "zone") {   // zone borders are very specific
    let edge = Infinity; for (const g of e.geoms) if (!g.fill) edge = Math.min(edge, geomDistance(g, x, y, maxSlop));
    if (edge <= maxSlop / 2) return 0; if (edge <= maxSlop) return maxSlop / 2;
    for (const g of e.geoms) if (g.fill && g.t === "poly" && g.pts && g.pts.length > 2 && pointInPolyMm(g.pts, x, y)) return 0;
    return Infinity;
  }
  if (e.field) { let f = Infinity; for (const g of e.geoms) f = Math.min(f, geomDistance(g, x, y, maxSlop)); return f < Infinity ? Math.max(0, f - maxSlop / 2) : f; }   // a bit of slop to text shapes
  if (it.kind === "footprint" && !e.pad) {   // FOOTPRINT::GetBoundingHull: inside it is an exact hit
    const hb = hullBox(e.geoms);
    if (hb && x >= hb[0] && x <= hb[2] && y >= hb[1] && y <= hb[3]) d = 0;
    else for (const g of e.geoms) if (g.t !== "text") d = Math.min(d, geomDistance(g, x, y, maxSlop));
    const bb = it.bbox; if (viewport && bb && (bb[3] - bb[1] > viewport[1] || bb[2] - bb[0] > viewport[0])) d = 1e9;   // larger than the view: a last resort
    return d;
  }
  for (const g of e.geoms) d = Math.min(d, geomDistance(g, x, y, maxSlop));
  if (TEXTISH.has(it.kind) && d < Infinity) d = Math.max(0, d - maxSlop / 2);   // a bit of slop to text shapes
  return d;
}
export function pointInPolyMm(pts: Pt[], x: number, y: number) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
export function polyAreaMm(pts: Pt[]) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a) / 2; }
export function hullBox(geoms: GeomPrim[]) { let b: Box | null = null; for (const g of geoms) { if (g.t === "text") continue; const gb = K.geomBox(g); if (!gb) continue; b = b ? [Math.min(b[0], gb[0]), Math.min(b[1], gb[1]), Math.max(b[2], gb[2]), Math.max(b[3], gb[3])] : gb.slice(); } return b; }
/** BOARD_ITEM::GetCoverageArea (mm²), from the item's own geometry. */
export function geomArea(g: GeomPrim) {
  const w = g.w || 0;
  switch (g.t) {
  case "line": return Math.hypot(g.x2 - g.x1, g.y2 - g.y1) * w + Math.PI * w * w / 4;
  case "circle": return g.fill ? Math.PI * g.r * g.r : 2 * Math.PI * g.r * w;
  case "arc": { const sw = g.a0 !== undefined && g.a1 !== undefined ? Math.abs(g.a1 - g.a0) : 2 * Math.PI; return g.pie ? sw / 2 * g.r * g.r : sw * g.r * w; }
  case "poly": { if (!g.pts || g.pts.length < 2) return 0; if (g.fill) return polyAreaMm(g.pts); let l = 0; for (let i = 1; i < g.pts.length; i++) l += Math.hypot(g.pts[i][0] - g.pts[i - 1][0], g.pts[i][1] - g.pts[i - 1][1]); return l * w; }
  case "rect": return Math.abs(g.w * g.h);
  case "pad": return g.shape === "circle" ? Math.PI * g.w * g.w / 4 : g.w * g.h;
  default: { const b = K.geomBox(g); return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; }
  }
}
export function coverageArea(e: CandEntry, x: number, y: number, px: number, maxSlop: number) {
  const it = e.item;
  if (it.kind === "zone") { let edge = Infinity; for (const g of e.geoms) if (!g.fill) edge = Math.min(edge, geomDistance(g, x, y, maxSlop / 2)); if (edge <= maxSlop / 2) return px * px * 5; }   // zone borders are "small"
  if (it.kind === "via") { const dr = K.kid(it.node, "drill"); const r = dr ? K.num(dr[1]) / 2 : 0.2; return r * r; }   // vias defer to nothing under them: r², not πr²
  if (it.kind === "image") { const b = it.bbox; return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; }
  if (e.field) { const g = e.geoms[0] as unknown as { pts: Pt[] }; return g && g.pts ? polyAreaMm(g.pts) : 0; }
  if (it.kind === "footprint" && !e.pad) { const hb = hullBox(e.geoms); return hb ? (hb[2] - hb[0]) * (hb[3] - hb[1]) : 0; }
  if (it.kind === "zone") { let a = 0; for (const g of e.geoms) if (g.t === "poly" && !g.fill && g.pts && g.pts.length > 2) a = Math.max(a, polyAreaMm(g.pts)); return a; }
  let a = 0; for (const g of e.geoms) a += geomArea(g); return a;
}
export function entryOnLayer(e: CandEntry, layer: string) {
  if (!layer) return false;
  const cu = /\.Cu$/.test(layer);
  const hits = (l: string) => l === layer || (cu && (l === "*.Cu" || l === "F&B.Cu"));
  if (!e.pad && !e.field) { const l = K.kid(e.item.node, "layer"); if (l && hits(K.str(l[1]))) return true; const ls = K.kid(e.item.node, "layers"); if (ls && ls.slice(1).some((v) => hits(K.str(v)))) return true; }
  for (const g of e.geoms) { if (g.layer && hits(g.layer)) return true; if (g.viaLayers && cu) return true; }
  return false;
}
/**
 * PCB_SELECTION_TOOL::GuessSelectionCandidates for the candidates `ids` under `where` (mm): silkscreen or
 * courtyard preference on the active layer, then "prefer exact hits to sloppy ones" (every item further than the
 * nearest one plus a pixel goes), then the much smaller of nested items (1.5x area steps; a footprint more than 70 %
 * covered stays), then only the items on the active layer when there are any.  opts: { px (mm per pixel),
 * activeLayer, hidden (Set of layer keys), viewport ([w, h] mm), highContrast }.
 */
export function guessCandidates(doc: BoardDoc, ids: string[], where: Pt, opts?: GuessOpts | null): string[] {
  opts = opts || {}; if (!ids || ids.length < 2) return (ids || []).slice();
  const px = opts.px || 0.01, maxSlop = 5 * px, [x, y] = where, active = opts.activeLayer || S.layer || "F.Cu";
  let list = ids.map((id: string) => candidateEntry(doc, id, opts!.hidden)).filter(Boolean) as CandEntry[]; if (list.length < 2) return list.map((e) => e.id);
  // a silk layer in front: single-layer silk texts and shapes; a courtyard in front (high contrast): footprints
  let preferred: CandEntry[] = [];
  if (SILK_RE.test(active)) preferred = list.filter((e) => e.field ? SILK_RE.test(String((e.geoms[0] as { layer?: string }).layer || "")) : !e.pad && e.item.kind !== "footprint" && e.item.kind !== "zone" && (TEXTISH.has(e.item.kind) || /^gr_|^table/.test(e.item.kind)) && SILK_RE.test(layerOf(e.item.node, "")));
  else if (CRTYD_RE.test(active) && opts.highContrast) preferred = list.filter((e) => !e.pad && !e.field && e.item.kind === "footprint");
  if (preferred.length) { list = preferred; if (list.length === 1) return [list[0].id]; }
  // prefer exact hits to sloppy ones
  const slop = new Map<CandEntry, number>(); let minSlop = Infinity;
  for (const e of list) { const d = hitTestDistance(e, x, y, maxSlop, opts.viewport); slop.set(e, d); if (d < minSlop) minSlop = d; }
  if (minSlop < Infinity) list = list.filter((e) => !(slop.get(e)! > minSlop + px));
  // a small item within a much larger one
  const byArea = list.map((e): [CandEntry, number] => [e, coverageArea(e, x, y, px, maxSlop)]).sort((a, b) => a[1] - b[1]);
  const rejected = new Set<CandEntry>(); let rejecting = false;
  for (let i = 1; i < byArea.length; i++) { if (byArea[i][1] > byArea[i - 1][1] * 1.5) rejecting = true; if (rejecting) rejected.add(byArea[i][0]); }
  for (const [e, a] of byArea) if (e.item.kind === "footprint" && !e.pad && !e.field && a > 0) {   // FOOTPRINT::CoverageRatio: a covered footprint stays for the menu
    let cov = 0; for (const [o, oa] of byArea) if (o !== e && !((o.pad || o.field) && o.item === e.item) && o.item.kind !== "zone") cov += oa;
    if (cov / a > 0.7) rejected.delete(e);
  }
  if (list.length > rejected.size) list = list.filter((e) => !rejected.has(e));
  // what is left has similar areas: only those on the active layer, when there are any
  if (list.length > 1) { const on = list.filter((e) => entryOnLayer(e, active)); if (on.length) list = on; }
  return list.map((e) => e.id);
}
/**
 * PCB_CONTROL::InteractiveDelete's motion handler: the item under the cursor is brightened only when exactly one
 * candidate remains after GuessSelectionCandidates (several overlapping items brighten nothing).
 */
export function deleteCandidate(ctx: PcbCtx, mm: Pt) {
  if (typeof ctx.candidatesAt === "function") {
    let ids = null; try { ids = ctx.candidatesAt(mm); } catch (e) { ids = null; }
    if (ids) { const u = Array.from(new Set(ids.map((id: string) => (typeof id === "string" && id.indexOf("#") > 0 ? id.slice(0, id.indexOf("#")) : id)))); return u.length === 1 ? ctx.doc.items.get(u[0]) || null : null; }
  }
  return itemAt(ctx, mm);
}
/**
 * The click handler: the brightened item goes (EDIT_TOOL::DeleteItems, silently); a locked one stays and a
 * STATUS_TEXT_POPUP says "Item locked." beside the cursor for two seconds.
 */
export function deleteAt(ctx: PcbCtx, mm: Pt) {
  const it = S.hover && S.hover.del !== undefined ? S.hover.del : deleteCandidate(ctx, mm); if (!it || !ctx.doc.items.has(it.id)) return null;
  if (isLocked(it.node)) { statusPopup(ctx, "Item locked.", mm, 2000); return null; }
  S.sel.delete(it.id); if (S.hover) S.hover.del = null;
  if (ctx.selected && ctx.selected.id === it.id) ctx.setSelected(null);
  ctx.commit(deleteChanges(ctx.doc, Array.from(expandGroups(ctx.doc, [it.id]))), "delete");
  ctx.requestRender();
  return it;
}
