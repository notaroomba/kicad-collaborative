// sch-tools/arcs.ts — EE_GRAPHIC_TOOL::DrawArc (eeschema/tools/ee_graphic_tool.cpp) with its ARC_MODE_SESSION: the
// five arc drawing modes of KiCad 10's Arc toolbar group (drawArcCenter, drawArcStartEndMid, drawArcStartEndCenter,
// drawArcTangent, drawArcStartDirEnd), built by the same ARC_GEOM_MANAGER the board editor uses (../arc-geom).
// The mode is eeschema's own application setting (APP_SETTINGS_BASE::m_ArcDrawMode), remembered between sessions.
import type { SchCtx, SchDraw, Pt } from "./types";
import {
  ARC_CENTER_START_END, ARC_MODE_ACTIONS, ARC_TANGENT, ArcGeom, NM, arcTangentSeedAt, arcTangentSeedNear, fromNm, kiRound, toNm,
  type ArcSeed, type SeedShape,
} from "../arc-geom";
import { arcNode } from "./nodes";
import { commitShape } from "./shapes";
import { K, S, kid, kids, ptsOf } from "./state";
import { r4 } from "./util";
import { root } from "../root";

export const SCH_ARC_MODE_KEY = "kc.sch.arcDrawMode";
const lsGet = (k: string) => { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch { return null; } };
const lsSet = (k: string, v: string) => { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch { /* storage off */ } };
let mode: number | null = null;
export function schArcDrawMode() {
  if (mode == null) { const v = lsGet(SCH_ARC_MODE_KEY); mode = v !== null && /^[0-4]$/.test(v) ? +v : ARC_CENTER_START_END; }
  return mode;
}
export function setSchArcDrawMode(m: number) { mode = m; lsSet(SCH_ARC_MODE_KEY, String(m)); }
/** SCH_BASE_FRAME::SelectToolbarAction( DrawArcForMode ): the Arc toolbar group shows the mode's button. */
export function showSchArcMode(ctx: SchCtx | null) {
  const c = ctx as (SchCtx & { setGroupCurrent?(g: string, id: string): void }) | null;
  if (c && c.setGroupCurrent) c.setGroupCurrent("Arc", ARC_MODE_ACTIONS[schArcDrawMode()]);
}

/** A sheet graphic as the tangent seed reads it (nm), or null for a kind no arc leaves from. */
export function schSeedShapeOf(it: KItem): SeedShape | null {
  const n = it.node, pt = (k: string) => { const c = kid(n, k); return c ? toNm([+c[1], +c[2]]) : null; };
  if (it.kind === "arc") {
    const s = pt("start"), m = pt("mid"), e = pt("end"); if (!s || !m || !e) return null;
    const a = K.arcFrom3(fromNm(s), fromNm(m), fromNm(e)); return a ? { t: "arc", start: s, mid: m, end: e, center: toNm([a.x, a.y]) } : null;
  }
  if (it.kind === "bezier") { const ps = ptsOf(n).map(toNm); return ps.length === 4 ? { t: "bez", start: ps[0], c1: ps[1], c2: ps[2], end: ps[3] } : null; }
  if (it.kind === "polyline") {
    // a two-point polyline is a graphic SCH_LINE; more points are an SCH_SHAPE POLY (an open chain in a schematic)
    const ps = ptsOf(n).map(toNm); if (ps.length === 2) return { t: "seg", start: ps[0], end: ps[1] };
    return ps.length > 2 ? { t: "poly", pts: ps } : null;
  }
  return null;
}
/** drawManagedShape's findTangentSeed: a graphic shape or line within ARC_SEED_PICK_PIXELS (5 px) of the click. */
export function findSchTangentSeed(ctx: SchCtx, pos: Pt): ArcSeed | null {
  const tol = kiRound(5 / Math.max(1e-9, ctx.pxPerMm || 1) * NM);
  for (const it of ctx.doc.items.values()) {
    if (it.kind !== "arc" && it.kind !== "bezier" && it.kind !== "polyline") continue;
    const b = it.bbox, t = tol / NM;
    if (b && (pos[0] / NM < b[0] - t || pos[0] / NM > b[2] + t || pos[1] / NM < b[1] - t || pos[1] / NM > b[3] + t)) continue;
    const sh = schSeedShapeOf(it); if (!sh) continue;
    // an open polyline of more than two points seeds along its segments and at its two ends
    const seed = sh.t === "poly" ? polySeed(sh.pts, pos, tol) : arcTangentSeedAt(sh, pos, tol); if (seed) return seed;
  }
  return null;
}
function polySeed(pts: Pt[], pos: Pt, tol: number) {
  // ArcTangentSeedAt( EDA_SHAPE POLY ): the contour's chain, open (a schematic polyline is not closed)
  let best: ArcSeed | null = null, bestD = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = arcTangentSeedAt({ t: "seg", start: pts[i], end: pts[i + 1] }, pos, tol);
    if (!s) continue;
    // an inner vertex is not an end of the chain: along the segment instead
    const inner = (i > 0 && same(s.start, pts[i])) || (i + 2 < pts.length && same(s.start, pts[i + 1]));
    const seed = inner ? { start: s.start, dir: s.dir, axis: true } : s;
    const d = Math.hypot(seed.start[0] - pos[0], seed.start[1] - pos[1]);
    if (!best || d < bestD) { best = seed; bestD = d; }
  }
  return best;
}
const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

/** S.draw for an arc on the cursor: the construction, and whether its start came from a tangent seed. */
export function newSchArc(chainSeed: ArcSeed | null): SchDraw {
  const g = new ArcGeom(schArcDrawMode());
  const d: SchDraw = { shape: "arc", pts: [], cur: [0, 0], arc: g, started: false, chainSeeded: false, clickSeeded: false };
  if (chainSeed) { g.setTangentSeed(chainSeed.start, chainSeed.dir, chainSeed.axis); d.chainSeeded = true; d.started = true; }
  syncSchArc(d);
  return d;
}
/** The fixed points shown as handles: the first placed point (or the seed's start). */
export function syncSchArc(d: SchDraw) { const g = d.arc!; d.pts = g.hasPreview() ? [fromNm(g.pts[0]).map(r4)] : []; }
/** ARC_MODE_SESSION::SetMode from a mode action or Cycle Arc Drawing Mode while the tool runs. */
export function switchSchArcMode(ctx: SchCtx, m: number) {
  setSchArcDrawMode(m); showSchArcMode(ctx);
  const d = S.draw; if (d && d.shape === "arc" && d.arc) { d.arc.setMode(m); d.chainSeeded = false; d.clickSeeded = false; syncSchArc(d); }
  ctx.requestRender();
}
/** A click: ARC_MODE_SESSION::PlacePoint, then the arc commits when the construction is complete. */
export function schArcClick(ctx: SchCtx, p: Pt) {
  let d = S.draw; if (!d || d.shape !== "arc" || !d.arc) d = S.draw = newSchArc(null);
  const g = d.arc!, pos = toNm(p);
  if (!d.started) { S.sel = null; ctx.setSelected(null); d.started = true; }
  const first = !d.chainSeeded && !d.clickSeeded && g.getStep() === 0;
  if (first && g.mode === ARC_TANGENT) {
    const seed = findSchTangentSeed(ctx, pos);
    if (seed) { g.setTangentSeed(seed.start, seed.dir, seed.axis); d.clickSeeded = true; syncSchArc(d); ctx.requestRender(); return; }
  }
  g.addPoint(pos, true); d.clickSeeded = false; d.lastClick = pos; d.cur = p.slice(); syncSchArc(d);
  if (g.isComplete()) commitSchArc(ctx, d, true);
  ctx.requestRender();
}
export function schArcMove(d: SchDraw, p: Pt) { const g = d.arc!; d.cur = p.slice(); if (g.hasPreview()) g.addPoint(toNm(p), false); }
/** The arc's file points (start / mid / end), or null while there is no arc yet. */
export function schArcPoints(d: SchDraw) {
  const sh = d.arc ? d.arc.shape() : null; if (!sh) return null;
  return { start: fromNm(sh.start).map(r4), mid: fromNm(sh.mid).map(r4), end: fromNm(sh.end).map(r4) };
}
/** commitItem( "Draw Arc" ), the arc selected; in the tangent mode the next arc leaves from where this one ended. */
export function commitSchArc(ctx: SchCtx, d: SchDraw, next: boolean) {
  const a = schArcPoints(d); S.draw = null;
  if (a) commitShape(ctx, arcNode(a.start, a.mid, a.end), "arc");
  if (!next) return;
  const sh = d.arc!.shape();
  const seed = sh && schArcDrawMode() === ARC_TANGENT ? arcTangentSeedNear({ t: "arc", start: sh.start, mid: sh.mid, end: sh.end, center: sh.center }, d.lastClick || sh.end) : null;
  S.draw = newSchArc(seed); S.draw.cur = d.cur.slice();   // the next arc previews from where the cursor is
}
/** A double click or finishInteractive (Enter / End): the arc drawn so far is kept and the tool ends (FINISHED). */
export function finishSchArc(ctx: SchCtx) {
  const d = S.draw, a = d && d.started ? schArcPoints(d) : null; S.draw = null;
  if (a) commitShape(ctx, arcNode(a.start, a.mid, a.end), "arc");
  ctx.setTool("select"); ctx.requestRender();
}
/** ARC_MODE_SESSION::RemoveLastPoint (Backspace): a seed or the last point goes; with nothing placed the arc is dropped. */
export function schArcBackup(ctx: SchCtx) {
  const d = S.draw!, g = d.arc!;
  if (d.clickSeeded) { g.reset(); d.clickSeeded = false; }
  else if (g.isReset() && !g.hasTangentSeed()) { S.draw = null; }
  else g.removeLastPoint();
  if (S.draw) syncSchArc(d);
  ctx.requestRender();
}
/** ACTIONS::arcPosture ('/'): ARC_GEOM_MANAGER::ToggleClockwise. */
export function schArcPosture(ctx: SchCtx) { const d = S.draw; if (!d || !d.arc) return false; d.arc.toggleClockwise(); ctx.requestRender(); return true; }
/** The preview: the arc (or the construction line to the cursor until there is one) and the center / radius guides. */
export function drawSchArcPreview(c: CanvasRenderingContext2D, d: SchDraw, px: number) {
  const g = d.arc!; if (!g.hasPreview()) return;
  const a = schArcPoints(d), o = fromNm(g.getOrigin());
  c.beginPath();
  if (a) { const arc = K.arcFrom3(a.start, a.mid, a.end); if (arc) c.arc(arc.x, arc.y, arc.r, arc.a0, arc.a1, arc.anticlockwise); }
  else { c.moveTo(o[0], o[1]); c.lineTo(d.cur[0], d.cur[1]); }
  c.stroke();
  if (g.mode === ARC_CENTER_START_END && g.getStep() >= 1) {   // ARC_ASSISTANT: the radius lines from the center
    c.save(); c.setLineDash([2 * px, 2 * px]); c.globalAlpha = 0.5; c.beginPath();
    const s = fromNm(g.startRadiusEnd()); c.moveTo(o[0], o[1]); c.lineTo(s[0], s[1]);
    if (g.getStep() >= 2) { const e = fromNm(g.endRadiusEnd()); c.moveTo(o[0], o[1]); c.lineTo(e[0], e[1]); }
    c.stroke(); c.restore();
  }
}
