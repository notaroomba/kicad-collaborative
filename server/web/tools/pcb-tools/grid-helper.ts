// pcb-tools/grid-helper.ts — select-tool drags and PCB_GRID_HELPER's drag origin and magnetic snapping.
import type { BoardDoc, Mods, PcbCtx, Pt, SelectMove, SnapAnchor, SnapType } from "./types";
import { LOCKED_WARNING, overrideLocks } from "./actions";
import { isLocked } from "./groups";
import { padCovers, padsOf } from "./route-geom";
import { K, S } from "./state";
import { anchorOf } from "./transforms";
import { MOVE_SNAP_MSG, angleSnapMode, displayConstraintsMsg } from "./draw-modes";
import { clone, corners, isList, pt, r6, samePt } from "./util";

// ---------------------------------------------------------------- select-tool drags (PCB_SELECTION_TOOL → EDIT_TOOL::doMoveSelection / drag45)
// KiCad: a left-drag on a track slides the segment (attached ends follow), a via or graphic moves
// freely with the tracks ending on it stretching along.  app.js calls onSelectDown when its own
// footprint hit-test found nothing on the footprint's geometry; the capture-phase stage listeners
// below then drive the drag while app.js's select tool stays passive.
export function beginSelectDrag(ctx: PcbCtx, it: KItem, mm: Pt) {
  if (isLocked(it.node) && !overrideLocks()) { ctx.toast(LOCKED_WARNING, 3500); return false; }
  const m: SelectMove = { ids: [it.id], start: snapCursor(ctx, mm, new Set([it.id]), {}).p, orig: new Map(), ends: [], last: [0, 0], moved: false };   // a held-button drag: no warp, the cursor is the reference
  m.orig.set(it.id, clone(it.node));
  if (it.kind === "via") {                                        // tracks ending on the via stretch with it
    const at = pt(it.node, "at");
    for (const sg of ctx.doc.items.values()) { if (sg.kind !== "segment" && sg.kind !== "arc") continue; for (const key of ["start", "end"]) { const q = pt(sg.node, key); if (q && at && samePt(q, at)) { m.ends.push({ id: sg.id, key }); if (!m.orig.has(sg.id)) m.orig.set(sg.id, clone(sg.node)); } } }
  }
  S.move = m; S.sel = new Set([it.id]); displayConstraintsMsg(MOVE_SNAP_MSG[angleSnapMode()]!); return true;
}
// ---------------------------------------------------------------- PCB_GRID_HELPER: drag origin and magnetic snapping
export const SNAP_SCREEN_RADIUS = 25;   // libs/snap snap_resolver.h: the magnetic range in screen pixels
/**
 * The snap points an item offers (PCB_GRID_HELPER::computeAnchors).  aFrom (the items being moved): a footprint's
 * position and the middle of its box, and the centre of a pad the mouse is inside; otherwise (the items snapped to)
 * a footprint's position and middle only — pads, tracks and vias capture the cursor in the track tool only
 * (MAGNETIC_OPTIONS::CAPTURE_CURSOR_IN_TRACK_TOOL), graphics always (editing.magnetic_graphics): their ends, corners,
 * centres and middles.  Text snaps by its position.
 */
export function itemAnchors(it: KItem, from: boolean, mouse: Pt | null, gridPitch: number): SnapAnchor[] {
  // each anchor carries its POINT_TYPE (PCB_GRID_HELPER::computeAnchors' addAnchor), shown by the snap indicator
  const out: SnapAnchor[] = []; const n = it.node, k = it.kind;
  const add = (p: Pt | null, t: SnapType) => { if (p) { const a = p.slice() as SnapAnchor; a.t = t; out.push(a); } };
  if (k === "footprint") {
    if (from && mouse) for (const p of padsOf(it)) if (padCovers(p, mouse[0], mouse[1])) add([p.x, p.y], "center");
    const pos = anchorOf(it); add(pos, "center");
    if (it.bbox) { const c = [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]; const g = gridPitch || 0; if (Math.hypot(c[0] - pos[0], c[1] - pos[1]) > Math.hypot(g, g)) add(c, "center"); }
    return out;
  }
  if ((k === "segment" || k === "arc" || k === "via") && !from) return out;
  if (k === "via" || k === "gr_text" || k === "target" || k === "image") { add(K.atOf(n).slice(0, 2), "center"); return out; }
  if (k === "segment" || k === "arc" || k === "gr_line" || k === "gr_arc") {
    const a = pt(n, "start"), b = pt(n, "end"); add(a, "end"); add(b, "end");
    if (k === "gr_line" && a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], "mid");
    if (k === "gr_arc" || k === "arc") add(pt(n, "mid"), "mid");
    return out;
  }
  if (k === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); add(c, "center"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r]]) add([c[0] + dx, c[1] + dy], "quadrant"); } return out; }
  if (k === "gr_rect" || k === "gr_text_box") {
    // the box: its centre, each corner and the middle of each side
    const a = pt(n, "start"), b = pt(n, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      add([mx, my], "center"); for (const p of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) add(p, "corner"); for (const p of [[mx, y0], [x1, my], [mx, y1], [x0, my]]) add(p, "mid"); }
    return out;
  }
  if (k === "gr_poly" || k === "zone" || k === "gr_curve") {
    const P = K.kid(k === "zone" ? (K.kid(n, "polygon") || n) : n, "pts"); if (P) for (const xy of P.slice(1)) if (isList(xy) && xy[0] === "xy") add([K.num(xy[1]), K.num(xy[2])], "corner");
    return out;
  }
  if (k === "dimension") { const P = K.kid(n, "pts"); if (P) for (const xy of P.slice(1)) if (isList(xy) && xy[0] === "xy") add([K.num(xy[1]), K.num(xy[2])], "none"); return out; }
  return out;
}
/**
 * PCB_GRID_HELPER::BestDragOrigin: the anchor of the moved items nearest the mouse (a pad centre under it, a
 * footprint's position, a shape's end …); the mouse itself when they offer none.
 */
export function bestDragOrigin(doc: BoardDoc, ids: Iterable<string>, mouse: Pt, gridPitch: number) {
  let best: Pt | null = null, bd = Infinity;
  for (const id of ids) { const it = doc.items.get(id); if (!it) continue; for (const p of itemAnchors(it, true, mouse, gridPitch)) { const d = Math.hypot(p[0] - mouse[0], p[1] - mouse[1]); if (d < bd) { bd = d; best = p; } } }
  return best ? [r6(best[0]), r6(best[1])] : mouse.slice();
}
/**
 * PCB_GRID_HELPER::BestSnapAnchor / ResolveSnap: the cursor pulled onto an anchor of an item that is not moving
 * within SNAP_SCREEN_RADIUS pixels (no further than one grid step when the grid is on), else onto the grid.  Shift
 * held turns object snapping off (grid.SetSnap( !MD_SHIFT )), Ctrl the grid (TOOL_EVENT::DisableGridSnapping is MD_CTRL).  Returns
 * { p, anchor } where anchor is the snapped-to point or null.
 */
export function snapCursor(ctx: PcbCtx, mm: Pt, skip: Set<string> | null, mods?: Mods | null, line?: SnapLines | null): { p: Pt; anchor: SnapAnchor | null; guide?: [Pt, Pt] | null } {
  mods = mods || {};
  const gridOn = !!(ctx.snapOn && ctx.snap) && !(mods.ctrlKey || mods.metaKey);
  const g = gridOn ? ctx.snap(mm.slice()) : mm.slice();
  if (mods.shiftKey || !ctx.doc) return { p: g, anchor: null };
  const scale = SNAP_SCREEN_RADIUS / Math.max(1e-6, ctx.pxPerMm || 4); const range = gridOn && ctx.gridPitch ? Math.min(scale, ctx.gridPitch) : scale;
  let best: SnapAnchor | null = null, bd = range;
  for (const it of ctx.doc.items.values()) {
    if (skip && skip.has(it.id)) continue; const b = it.bbox;
    if (b && (mm[0] < b[0] - range || mm[0] > b[2] + range || mm[1] < b[1] - range || mm[1] > b[3] + range)) continue;
    for (const p of itemAnchors(it, false, null, ctx.gridPitch)) { const d = Math.hypot(p[0] - mm[0], p[1] - mm[1]); if (d <= bd) { bd = d; best = p; } }
  }
  if (best) return { p: [r6(best[0]), r6(best[1])], anchor: best };
  // no anchor captured: the angle snap lines through the move's origin (GetNearestSnapLinePoint), drawn as a guide
  if (line && line.dirs.length) {
    const pitch = ctx.gridPitch || 0;
    const sl = nearestSnapLinePoint(line.origin, line.dirs, mm, g, range, pitch > 0 ? pitch : 0, (q) => (ctx.snap ? ctx.snap(q.slice()) : q));
    if (sl) { const q: Pt = [r6(sl[0]), r6(sl[1])]; return { p: q, anchor: null, guide: [line.origin.slice(), q] }; }
  }
  return { p: g, anchor: null };
}
/** The snap lines a move offers (EDIT_TOOL::doMoveSelection configureAngleSnap): their origin and directions. */
export interface SnapLines { origin: Pt; dirs: Pt[] }
/** configureAngleSnap: DEG45 offers H, V and both diagonals, DEG90 H and V, DIRECT none. */
export function angleSnapDirections(mode: string): Pt[] {
  return mode === "45" ? [[1, 0], [0, 1], [1, 1], [1, -1]] : mode === "90" ? [[1, 0], [0, 1]] : [];
}
/**
 * SNAP_LINE_MANAGER::GetNearestSnapLinePoint (common/tool/construction_manager.cpp): of the lines through `origin`
 * along `dirs` that pass within `range` of the cursor, the nearest one; the point on it is the grid point that keeps
 * it on the line — the origin's X or Y with the nearest grid's other coordinate for a vertical or horizontal line,
 * and for a diagonal the one of the 3x3 grid points around the projection that scores best on (distance from the
 * line + 0.1 x distance from the cursor).  `nearestGrid` is the cursor on the grid; `gridAt` puts a point on it.
 */
export function nearestSnapLinePoint(origin: Pt, dirs: Pt[], cursor: Pt, nearestGrid: Pt, range: number, pitch: number, gridAt: (p: Pt) => Pt): Pt | null {
  const delta = [cursor[0] - origin[0], cursor[1] - origin[1]];
  let bestPerp = Infinity, best: Pt | null = null;
  for (const dir of dirs) {
    const len = Math.hypot(dir[0], dir[1]); if (!len) continue;
    const u = [dir[0] / len, dir[1] / len];
    const along = delta[0] * u[0] + delta[1] * u[1];
    const proj: Pt = [origin[0] + u[0] * along, origin[1] + u[1] * along];
    const perp = Math.hypot(delta[0] - u[0] * along, delta[1] - u[1] * along);
    if (perp > range) continue;   // (the long-range escape needs perp >= 2 x range, so it never applies here)
    let sp: Pt = proj;
    if (pitch > 0) {
      if (dir[0] === 0 && dir[1] !== 0) sp = [origin[0], nearestGrid[1]];
      else if (dir[1] === 0 && dir[0] !== 0) sp = [nearestGrid[0], origin[1]];
      else {
        const g0 = gridAt(proj.slice()); let bs = Infinity, bp: Pt = proj;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const gp: Pt = [g0[0] + dx * pitch, g0[1] + dy * pitch];
          const gd = [gp[0] - origin[0], gp[1] - origin[1]]; const ga = gd[0] * u[0] + gd[1] * u[1];
          const score = Math.hypot(gd[0] - u[0] * ga, gd[1] - u[1] * ga) + Math.hypot(gp[0] - cursor[0], gp[1] - cursor[1]) * 0.1;
          if (score < bs) { bs = score; bp = gp; }
        }
        sp = bp;
      }
    }
    if (perp < bestPerp) { bestPerp = perp; best = sp; }
  }
  return best;
}
