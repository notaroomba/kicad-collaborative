// pcb-tools/point-editor.ts — the point editor (PCB_POINT_EDITOR): edit points, arcs, corners.
import type { BoardDoc, PcbCtx, Pt } from "./types";

/** A handle of the point editor: its key, where it sits, round or square, and the indicator lines it draws. */
export interface EditPoint { key: string; p: Pt; circle?: boolean; lines?: Pt[] }
import { appTool, isPcbDoc, liveDoc } from "./app-state";
import { crossZ } from "./arcs";
import { addedChange, replacedChange } from "./changes";
import { dimEditNode, dimEditPoints } from "./dimensions";
import { isLocked, selectionIds } from "./groups";
import { line } from "./overlay";
import { lsGet, lsSet } from "./router-settings";
import { K, S, lastCtx } from "./state";
import { clone, pt, r6, samePt, vadd, vmul, vsub } from "./util";
import { isTuningPattern } from "./tuning-patterns";
import { genCancelEdit, genFinishEdit, genStartEdit, genUpdateEdit, selectedTuningPattern, tuningEditNode, tuningEditPoints } from "./tuning-edit";
import type { GenEdit } from "./tuning-edit";

// ---------------------------------------------------------------- point editor (PCB_POINT_EDITOR)
// A single selected zone, rule area, polygon, line, rectangle, circle, arc or dimension carries KiCad's edit handles: squares on
// the corners / ends (EDIT_POINT), circles on the edge midpoints (EDIT_LINE centre points).  Dragging a handle reshapes
// the item; a zone or polygon edge midpoint drags the whole edge; Ins (Create Corner) adds a corner on the edge under
// the cursor, Remove Corner takes the corner under it out.  Only the edited coordinates are rewritten.
export const PE_KINDS = new Set(["zone", "gr_poly", "gr_line", "gr_rect", "gr_circle", "gr_arc", "dimension"]);
/** The (pts) list a polygon edit works on: the zone's first outline, the polygon's own points. */
export function pePtsNode(node: SNode) { const host = node[0] === "zone" ? K.kid(node, "polygon") : node; return host ? K.kid(host, "pts") : null; }
export function pePolyPts(node: SNode) { const p = pePtsNode(node); return p ? K.kids(p, "xy").map((x) => [K.num(x[1]), K.num(x[2])]) : []; }
/** EDIT_POINTS of an item: [{ key, p, circle }] in drawing order. */
export function editPoints(it: KItem): EditPoint[] {
  if (it && it.kind === "generated") return isTuningPattern(it) ? tuningEditPoints(it) : [];   // PCB_TUNING_PATTERN::MakeEditPoints
  if (!it || !PE_KINDS.has(it.kind)) return [];
  const n = it.node, out: EditPoint[] = [];
  if (it.kind === "dimension") return dimEditPoints(n);
  if (it.kind === "zone" || it.kind === "gr_poly") {
    const pts = pePolyPts(n); pts.forEach((p, i) => out.push({ key: "c" + i, p }));
    if (pts.length > 1) pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; out.push({ key: "m" + i, p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], circle: true }); });
  } else if (it.kind === "gr_line") { for (const k of ["start", "end"]) { const p = pt(n, k); if (p) out.push({ key: k, p }); } }
  else if (it.kind === "gr_rect") {
    const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) return out;
    const c = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    c.forEach((p, i) => out.push({ key: "r" + i, p }));
    c.forEach((p, i) => { const q = c[(i + 1) % 4]; out.push({ key: "e" + i, p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], circle: true }); });
  } else if (it.kind === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); if (c) out.push({ key: "center", p: c }); if (e) out.push({ key: "end", p: e }); }
  else if (it.kind === "gr_arc") {   // ARC_START, ARC_MID, ARC_END, ARC_CENTER, with indicator lines from the centre to the ends
    for (const k of ["start", "mid", "end"]) { const p = pt(n, k); if (p) out.push({ key: k, p }); }
    const s = pt(n, "start"), m = pt(n, "mid"), e = pt(n, "end"), a = s && m && e ? K.arcFrom3(s, m, e) : null;
    if (a) { const c = [a.x, a.y]; out.push({ key: "center", p: c, lines: [s!, e!] }); }
  }
  return out;
}
// ---- EDA_ARC_POINT_EDIT_BEHAVIOR (common/tool/point_editor_behavior.cpp): an arc's start, mid, end and centre handles,
// and what dragging one does in each ARC_EDIT_MODE (Preferences > PCB Editor > Editing Options > Arc editing mode,
// the Arc toolbar group's menu, Cycle Arc Editing Mode Ctrl+Space).  0 keeps the centre and adjusts the radius, 1 keeps
// the endpoints (or the direction at the other end), 2 keeps the centre and the radius.
export const ARC_KEEP_CENTER = 0, ARC_KEEP_ENDPOINTS = 1, ARC_KEEP_RADIUS = 2;
export const ARC_EDIT_KEY = "kc.pcb.arcEditMode";
export const ARC_EDIT_ACTIONS = ["pointEditorArcKeepCenter", "pointEditorArcKeepEndpoint", "pointEditorArcKeepRadius"];
export function arcEditMode() {
  if (S.arcEditMode == null) { const v = lsGet(ARC_EDIT_KEY); S.arcEditMode = v !== null && /^[0-2]$/.test(v) ? +v : ARC_KEEP_CENTER; }
  return S.arcEditMode;
}
export function setArcEditMode(m: number) { S.arcEditMode = m; lsSet(ARC_EDIT_KEY, String(m)); }
/** IncrementArcEditMode: keep center -> keep center and radius -> keep endpoints -> keep center. */
export const nextArcEditMode = (m: number) => (m === ARC_KEEP_CENTER ? ARC_KEEP_RADIUS : m === ARC_KEEP_RADIUS ? ARC_KEEP_ENDPOINTS : ARC_KEEP_CENTER);
export const ARC_MIN_RADIUS = 0.0254;   // EDA_UNIT_UTILS::Mils2IU( 1 )
export const resized = (v: Pt, len: number) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] * len / l, v[1] * len / l] : [0, 0]; };
/** EDA_SHAPE with the board's winding: from start to end the polar angle grows; the mid is halfway (GetArcMid). */
export function arcFromCenter(c: Pt, s: Pt, e: Pt) {
  const r = Math.hypot(s[0] - c[0], s[1] - c[1]); const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let sw = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0; while (sw <= 0) sw += 2 * Math.PI;
  return { start: s, mid: [c[0] + r * Math.cos(a0 + sw / 2), c[1] + r * Math.sin(a0 + sw / 2)], end: e };
}
/** The arc of `orig` with handle `key` dragged: `p` is the snapped cursor, `raw` the cursor itself (the mid handle uses it). */
export function arcEditGeometry(orig: SNode, key: string, p: Pt, raw: Pt, mode: number) {
  let s = pt(orig, "start")!, e = pt(orig, "end")!; const m = pt(orig, "mid")!; const a = s && m && e ? K.arcFrom3(s, m, e) : null; if (!a) return null;   // a missing point leaves no arc
  // the arc as pcbnew holds it (start to end with the polar angle growing); the handle stays the one under the cursor
  if (crossZ(m![0] - s![0], m![1] - s![1], e![0] - m![0], e![1] - m![1]) < 0) { [s, e] = [e, s]; if (key === "start" || key === "end") key = key === "start" ? "end" : "start"; }
  const c = [a.x, a.y];
  if (key === "center") {
    if (mode === ARC_KEEP_ENDPOINTS) {   // editArcCenterKeepEndpoints: the centre slides along the chord's bisector
      const mid = [(s![0] + e![0]) / 2, (s![1] + e![1]) / 2], n = resized([-(e![1] - s![1]), e![0] - s![0]], 1);
      const t = (p[0] - mid[0]) * n[0] + (p[1] - mid[1]) * n[1]; const nc = [mid[0] + n[0] * t, mid[1] + n[1] * t];
      return arcFromCenter(nc, s, e);
    }
    const d = [p[0] - c[0], p[1] - c[1]];   // both other modes move the arc
    return { start: vadd(s, d), mid: vadd(m, d), end: vadd(e, d) };
  }
  if (key === "mid") {
    if (mode === ARC_KEEP_ENDPOINTS) {   // editArcMidKeepEndpoints: on a ray from just off the chord's middle, out past the mid
      const ch = [(s![0] + e![0]) / 2, (s![1] + e![1]) / 2], v = vsub(m, ch), justOff = Math.hypot(s![0] - e![0], s![1] - e![1]) / 100;
      const A = vadd(ch, resized(v, justOff)), u = resized(v, 1); const t = Math.max(0, (raw[0] - A[0]) * u[0] + (raw[1] - A[1]) * u[1]);
      const nm = vadd(A, vmul(u, t)); if (Math.abs(crossZ(nm[0] - s![0], nm[1] - s![1], e![0] - s![0], e![1] - s![1])) < 1e-12) return null;
      return { start: s, mid: nm, end: e };
    }
    // KI_ARC_EDIT::EditArcMidKeepCenter: the radius follows the cursor, the ends stay on their rays
    const r = Math.max(ARC_MIN_RADIUS, Math.hypot(raw[0] - c[0], raw[1] - c[1]));
    return arcFromCenter(c, vadd(c, resized(vsub(s, c), r)), vadd(c, resized(vsub(e, c), r)));
  }
  if (key !== "start" && key !== "end") return null;
  const movingStart = key === "start";
  if (mode === ARC_KEEP_CENTER) {   // KI_ARC_EDIT::EditArcEndpointKeepCenter: the other end follows onto the new radius
    let p1 = vsub(p, c); const p2 = vsub(movingStart ? e : s, c);
    if (!p1[0] && !p1[1]) p1 = vsub(movingStart ? s : e, c);
    const r = Math.max(ARC_MIN_RADIUS, Math.hypot(p1[0], p1[1]));
    const n1 = vadd(c, resized(p1, r)), n2 = vadd(c, (p2[0] || p2[1]) ? resized(p2, r) : [r, 0]);
    return movingStart ? arcFromCenter(c, n1, n2) : arcFromCenter(c, n2, n1);
  }
  if (mode === ARC_KEEP_RADIUS) {   // editArcEndpointKeepCenterAndRadius: the end slides round the circle
    const n1 = vadd(c, resized(vsub(p, c), a.r));
    return movingStart ? arcFromCenter(c, n1, e) : arcFromCenter(c, s, n1);
  }
  // editArcEndpointKeepTangent: the other end and the tangent there stay; the centre moves along that end's radius
  const p1 = movingStart ? e : s, p2 = p, p3 = m;
  let v1 = vsub(p1, c), v2 = vsub(p2, c); const v3 = vsub(p3, c);
  if (!Math.hypot(v1[0], v1[1]) || !Math.hypot(v2[0], v2[1])) return null;
  const u1 = resized(v1, 1); let u2 = vsub(v3, vmul(u1, u1[0] * v3[0] + u1[1] * v3[1])); u2 = resized(u2, 1);
  const det = u1[0] * u2[1] - u2[0] * u1[1]; if (!det) return null;
  v1 = [(v1[0] * u2[1] - v1[1] * u2[0]) / det, (-v1[0] * u1[1] + v1[1] * u1[0]) / det];
  v2 = [(v2[0] * u2[1] - v2[1] * u2[0]) / det, (-v2[0] * u1[1] + v2[1] * u1[0]) / det];
  const R = Math.hypot(v1[0], v1[1]); if (v2[0] === R) return null;   // a straight line: nothing changes
  let flip = false; if (v2[0] > R) { flip = true; v2[0] = 2 * R - v2[0]; }
  const delta = (R * R - v2[0] * v2[0] - v2[1] * v2[1]) / (2 * v2[0] - 2 * R);
  if (Math.abs(v2[1] / (R - v2[0])) > 50 || !isFinite(delta)) return null;   // ADVANCED_CFG m_DrawArcCenterMaxAngle
  const v4 = flip ? [2 * R + delta, 0] : [-delta, 0];
  const nc = vadd(c, [v4[0] * u1[0] + v4[1] * u2[0], v4[0] * u1[1] + v4[1] * u2[1]]);
  return movingStart ? arcFromCenter(nc, p, e) : arcFromCenter(nc, s, p);
}
export const setXY = (node: SNode, key: string, p: Pt) => { const k = K.kid(node, key); if (k) { k[1] = r6(p[0]); k[2] = r6(p[1]); } };
/** The node with handle `key` moved to `p` (from the original node `orig`). */
export function editPointNode(orig: SNode, kind: string, key: string, p: Pt, raw: Pt | null | undefined, grid: ((p: Pt) => Pt) | null | undefined) {
  if (kind === "dimension") return dimEditNode(orig, key, p, raw || p, (grid || null));
  if (kind === "gr_arc") {
    const g = arcEditGeometry(orig, key, p, raw || p, arcEditMode()); if (!g) return clone(orig);
    const node = clone(orig), cw = crossZ(g.mid[0] - g.start[0], g.mid[1] - g.start[1], g.end[0] - g.mid[0], g.end[1] - g.mid[1]) >= 0;
    setXY(node, "start", cw ? g.start : g.end); setXY(node, "mid", g.mid); setXY(node, "end", cw ? g.end : g.start);
    return node;
  }
  const node = clone(orig);
  if (kind === "zone" || kind === "gr_poly") {
    const pn = pePtsNode(node); const xs = pn ? K.kids(pn, "xy") : []; const nn = xs.length; if (!nn) return node;
    const i = +key.slice(1);
    if (key[0] === "c") { xs[i][1] = r6(p[0]); xs[i][2] = r6(p[1]); }
    else {   // an edge midpoint drags the edge: both its corners move by the same offset
      const j = (i + 1) % nn; const a = [K.num(xs[i][1]), K.num(xs[i][2])], b = [K.num(xs[j][1]), K.num(xs[j][2])];
      const d = [p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2];
      xs[i][1] = r6(a[0] + d[0]); xs[i][2] = r6(a[1] + d[1]); xs[j][1] = r6(b[0] + d[0]); xs[j][2] = r6(b[1] + d[1]);
    }
  } else if (kind === "gr_line") setXY(node, key, p);
  else if (kind === "gr_rect") {
    const a = pt(orig, "start"), b = pt(orig, "end"); let x0 = a![0], y0 = a![1], x1 = b![0], y1 = b![1];
    // corners TL TR BR BL as start / end coordinates; an edge moves one coordinate
    const sx = (v: number) => { x0 = v; }, sy = (v: number) => { y0 = v; }, ex = (v: number) => { x1 = v; }, ey = (v: number) => { y1 = v; };
    ({ r0: () => { sx(p[0]); sy(p[1]); }, r1: () => { ex(p[0]); sy(p[1]); }, r2: () => { ex(p[0]); ey(p[1]); }, r3: () => { sx(p[0]); ey(p[1]); },
      e0: () => sy(p[1]), e1: () => ex(p[0]), e2: () => ey(p[1]), e3: () => sx(p[0]) } as Record<string, () => void>)[key]();
    setXY(node, "start", [x0, y0]); setXY(node, "end", [x1, y1]);
  } else if (kind === "gr_circle") {
    if (key === "center") { const c = pt(orig, "center"), e = pt(orig, "end"); setXY(node, "center", p); setXY(node, "end", [e![0] + p[0] - c![0], e![1] + p[1] - c![1]]); }
    else setXY(node, "end", p);
  }
  return node;
}
/** The one selected item's id (the module's own selection or the app's), or null. */
export function peSingleId(ctx?: PcbCtx) {
  const c = ctx || lastCtx; const ids = c && c.doc ? selectionIds(c) : S.sel;
  if (c && c.doc && ids.size > 1) { const gen = selectedTuningPattern(c, ids); if (gen) return gen.id; }   // a selected pattern is one generator
  return ids.size === 1 ? ids.values().next().value : null;
}
/** The handle of the single selected editable item within `tol` mm of (x, y), or null. */
export function editHandleAt(doc: BoardDoc, x: number, y: number, tol: number) {
  const id = peSingleId(); const it = id ? doc.items.get(id) : null; if (!it || isLocked(it.node)) return null;
  let best: EditPoint | null = null, bd = tol;
  for (const h of editPoints(it)) { const d = Math.max(Math.abs(h.p[0] - x), Math.abs(h.p[1] - y)); if (d <= bd) { bd = d; best = h; } }
  return best ? { it, h: best } : null;
}
/** PCB_POINT_EDITOR::addCorner: a corner on the zone / polygon edge nearest the cursor, or a line split there. */
export function addCornerChanges(doc: BoardDoc, id: string, at: Pt) {
  const it = doc.items.get(id); if (!it) return [];
  if (it.kind === "zone" || it.kind === "gr_poly") {
    const pts = pePolyPts(it.node); if (pts.length < 2) return [];
    let bi = -1, bd = Infinity, bp: Pt | null = null;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const q = closestOnSeg(at, a, b); const d = Math.hypot(q[0] - at[0], q[1] - at[1]); if (d < bd) { bd = d; bi = i; bp = q; } }
    const node = clone(it.node); const pn = pePtsNode(node); const xs = K.kids(pn!, "xy"); const after = xs[bi];
    pn!.splice(pn!.indexOf(after) + 1, 0, ["xy", r6(bp![0]), r6(bp![1])]);
    return [replacedChange(it, node)];
  }
  if (it.kind === "gr_line") {   // the segment splits in two at the cursor's projection
    const a = pt(it.node, "start")!, b = pt(it.node, "end")!; const q = closestOnSeg(at, a, b); if (samePt(q, a) || samePt(q, b)) return [];
    const first = clone(it.node); setXY(first, "end", q);
    const second = clone(it.node); setXY(second, "start", q); const u = K.kid(second, "uuid"); if (u) u[1] = K.newUuid ? K.newUuid() : u[1] + "-1";
    return [replacedChange(it, first), addedChange(doc, second)];
  }
  return [];
}
/** PCB_POINT_EDITOR::canAddCorner: zones, polygons and plain lines. */
export function canAddCorner(it: KItem) { return !!it && (it.kind === "zone" || it.kind === "gr_poly" || it.kind === "gr_line"); }
/** PCB_POINT_EDITOR::canRemoveCorner: a zone or polygon with more than three corners, one of them under the cursor. */
export function canRemoveCorner(doc: BoardDoc, id: string, at: Pt) { const it = doc.items.get(id); if (!it || (it.kind !== "zone" && it.kind !== "gr_poly") || pePolyPts(it.node).length <= 3) return false; return !at || removeCornerChanges(doc, id, at, handleTol()).length > 0; }
export function closestOnSeg(p: Pt, a: Pt, b: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return a.slice(); const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); return [a[0] + t * dx, a[1] + t * dy]; }
/** PCB_POINT_EDITOR::removeCorner: the zone / polygon corner under the cursor, while more than three remain. */
export function removeCornerChanges(doc: BoardDoc, id: string, at: Pt, tol: number) {
  const it = doc.items.get(id); if (!it || (it.kind !== "zone" && it.kind !== "gr_poly")) return [];
  const pts = pePolyPts(it.node); if (pts.length <= 3) return [];
  let bi = -1, bd = tol; pts.forEach((p, i) => { const d = Math.max(Math.abs(p[0] - at[0]), Math.abs(p[1] - at[1])); if (d <= bd) { bd = d; bi = i; } });
  if (bi < 0) return [];
  const node = clone(it.node); const pn = pePtsNode(node); pn!.splice(pn!.indexOf(K.kids(pn!, "xy")[bi]), 1);
  return [replacedChange(it, node)];
}
export const handleTol = () => 6 * (S.mmPerPx || 0.05);   // a few screen pixels around the 8 px handle
export function onHandlePointerDown(ev: PointerEvent) {
  const ctx = lastCtx; if (!ctx || !isPcbDoc() || ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || appTool() !== "select") return;
  if (S.route || S.draw || S.drag || S.move || S.pedit || ctx.viewOnly) return;
  const stage = ctx.stage; if (!stage || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const doc = liveDoc(); if (!doc) return; const mm = ctx.worldMm(ev);
  const hit = editHandleAt(doc, mm[0], mm[1], handleTol()); if (!hit) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  S.pedit = { id: hit.it.id, kind: hit.it.kind, key: hit.h.key, orig: clone(hit.it.node), start: mm, moved: false, ignoreGrid: !!(hit.h as { ignoreGrid?: boolean }).ignoreGrid };
  if (isTuningPattern(hit.it)) genStartEdit(ctx, hit.it);   // PCB_POINT_EDITOR: genStartEdit
  try { stage.setPointerCapture(ev.pointerId!); } catch (e) { /* synthetic event */ }
}
export function editHandleMove(ctx: PcbCtx, mm: Pt) {
  const pe = S.pedit; if (!pe) return; const it = ctx.doc.items.get(pe.id); if (!it) { S.pedit = null; return; }
  if (!pe.moved && Math.hypot(mm[0] - pe.start[0], mm[1] - pe.start[1]) < 1e-3) return;
  const p = pe.ignoreGrid ? mm : ctx.snapOn && ctx.snap ? ctx.snap([mm[0], mm[1]]) : mm;   // the amplitude and spacing handles ignore the grid
  if (pe.kind === "generated") { pe.moved = true; pe.node = tuningEditNode(pe.orig, pe.key, p); genUpdateEdit(ctx, pe.node); return; }   // genUpdateEdit: re-tuned live
  pe.moved = true; pe.node = editPointNode(pe.orig, pe.kind, pe.key, p, mm, ctx.snapOn && ctx.snap ? ctx.snap : null);
  it.node.length = 0; it.node.push(...clone(pe.node!)); K.replaceChange(ctx.doc, it); ctx.requestRender();
}
export function editHandleUp(ctx: PcbCtx, commit: boolean) {
  const pe = S.pedit; S.pedit = null; if (!pe) return; const it = ctx.doc.items.get(pe.id); if (!it) { genCancelEdit(ctx); return; }
  if (pe.kind === "generated") { if (commit && pe.moved) genFinishEdit(ctx); else genCancelEdit(ctx); return; }   // genFinishEdit: "Edit Tuning Pattern"
  it.node.length = 0; it.node.push(...clone(pe.orig)); K.replaceChange(ctx.doc, it);   // the original back first: commit records the inverse
  if (commit && pe.moved && pe.node && K.serialize(pe.node) !== K.serialize(pe.orig)) ctx.commit([replacedChange(it, pe.node)], "edit points");
  ctx.requestRender();
}
export function drawEditPoints(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  if (S.route || S.draw || S.drag || S.move || S.modTool) return;
  const id = peSingleId(ctx); const ge = S.genEdit as GenEdit | null | undefined;
  const it = id ? (ge && ge.id === id && ge.fin && ge.fin.items.get(id)) || ctx.doc.items.get(id) : null; if (!it || isLocked(it.node)) return; const hs = editPoints(it); if (!hs.length) return;
  const cur = ctx.cursor || null; const size = 4 * px;   // POINT_SIZE 8 px
  const hotKey = S.pedit ? S.pedit.key : (cur ? ((editHandleAt(ctx.doc, cur[0], cur[1], handleTol()) || {}).h || {}).key : null);
  c.save(); c.globalAlpha = 1; c.setLineDash([]);
  for (const h of hs) if (h.lines) { c.lineWidth = 0.5 * px; c.strokeStyle = "rgba(77,77,77,0.8)"; for (const q of h.lines) line(c, h.p, q); }   // EDIT_POINTS' indicator lines
  for (const h of hs) {
    const on = h.key === hotKey;
    c.lineWidth = (on ? 5 : 2) * px; c.strokeStyle = on ? "rgba(128,128,128,0.8)" : "rgba(77,77,77,0.8)"; c.fillStyle = "#FFFFFF";   // LAYER_AUX_ITEMS, border Darkened(0.7) / hover Darkened(0.5)
    c.beginPath(); if (h.circle) c.arc(h.p[0], h.p[1], size, 0, Math.PI * 2); else c.rect(h.p[0] - size, h.p[1] - size, 2 * size, 2 * size);
    c.fill(); c.stroke();
  }
  c.restore();
}
