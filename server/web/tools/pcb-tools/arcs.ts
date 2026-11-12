// pcb-tools/arcs.ts — arc drawing: ARC_DRAW_MODE, ARC_GEOM_MANAGER and ARC_MODE_SESSION.
import type { Arc3, DrawState, PcbCtx, Pt } from "./types";
import { dimensionLabel, textNextToCursor } from "./assistants";
import { addedChange } from "./changes";
import { angleSnapMode, withStroke } from "./draw-modes";
import { applySelection } from "./groups";
import { arcNode } from "./nodes";
import { line, ring } from "./overlay";
import { lsGet, lsSet } from "./router-settings";
import { K, S } from "./state";
import { ARC_CENTER_START_END, ARC_MODE_ACTIONS, ARC_START_END_CENTER, ARC_START_END_MID, ARC_TANGENT, ArcGeom, NM, arcTangentSeedAt, arcTangentSeedNear, crossZ, degOf, fromNm, kiRound, toNm, type ArcSeed, type SeedShape } from "../arc-geom";
export * from "../arc-geom";
import { norm360, vadd, vmul, vsub } from "./util";

// ---------------------------------------------------------------- arcs: ARC_DRAW_MODE, ARC_GEOM_MANAGER, ARC_MODE_SESSION
// include/tool/arc_draw_mode.h: the five ways Draw Arcs builds an arc, in the order Cycle Arc Drawing Mode (Alt+/) walks;
// the mode is an application setting (APP_SETTINGS_BASE::m_ArcDrawMode), so it is remembered between sessions.
export const ARC_MODE_KEY = "kc.pcb.arcDrawMode";
export function arcDrawMode() {
  if (S.arcMode == null) { const v = lsGet(ARC_MODE_KEY); S.arcMode = v !== null && /^[0-4]$/.test(v) ? +v : ARC_CENTER_START_END; }
  return S.arcMode;
}
/** PCB_BASE_FRAME::SelectToolbarAction( DrawArcForMode ): the Arc toolbar group shows the mode's button. */
export function showArcMode(ctx: PcbCtx) { if (ctx && ctx.setGroupCurrent) ctx.setGroupCurrent("Arc", ARC_MODE_ACTIONS[arcDrawMode()]); }
export function setArcDrawMode(m: number) { S.arcMode = m; lsSet(ARC_MODE_KEY, String(m)); }

export function seedShapeOf(it: KItem): SeedShape | null {
  // a graphic of these kinds carries its points (a missing one fails as it always has)
  const n = it.node, pt = (k: string) => { const c = K.kid(n, k); return (c ? toNm([+c[1], +c[2]]) : null) as Pt; };
  if (it.kind === "gr_line") return { t: "seg", start: pt("start"), end: pt("end") };
  if (it.kind === "gr_arc") { const s = pt("start"), m = pt("mid"), e = pt("end"); const a = K.arcFrom3(fromNm(s), fromNm(m), fromNm(e)); return a ? { t: "arc", start: s, mid: m, end: e, center: toNm([a.x, a.y]) } : null; }
  if (it.kind === "gr_curve") { const ps = K.kids(K.kid(n, "pts") || [], "xy").map((c) => toNm([+c[1], +c[2]])); return ps.length === 4 ? { t: "bez", start: ps[0], c1: ps[1], c2: ps[2], end: ps[3] } : null; }
  if (it.kind === "gr_poly") { const ps = K.kids(K.kid(n, "pts") || [], "xy").map((c) => toNm([+c[1], +c[2]])); return ps.length > 1 ? { t: "poly", pts: ps } : null; }
  return null;
}
/** DRAWING_TOOL::drawManagedShape's findTangentSeed: a graphic on the drawing layer within 5 px (ARC_SEED_PICK_PIXELS). */
export function findTangentSeed(ctx: PcbCtx, pos: Pt) {
  const tol = kiRound(5 / Math.max(1e-9, ctx.pxPerMm || 1) * NM), layer = S.gfxLayer;
  for (const it of ctx.doc.items.values()) {
    if (!/^gr_(line|arc|curve|poly)$/.test(it.kind)) continue;
    const l = K.kid(it.node, "layer"); if (!l || K.str(l[1]) !== layer) continue;
    if (it.bbox && (pos[0] / NM < it.bbox[0] - tol / NM || pos[0] / NM > it.bbox[2] + tol / NM || pos[1] / NM < it.bbox[1] - tol / NM || pos[1] / NM > it.bbox[3] + tol / NM)) continue;
    const sh = seedShapeOf(it); if (!sh) continue;
    const seed = arcTangentSeedAt(sh, pos, tol); if (seed) return seed;
  }
  return null;
}

/** A new arc on the cursor: DRAWING_TOOL::DrawArc's loop body (drawManagedShape with an ARC_MODE_SESSION). */
export function newArcDraw(chainSeed: ArcSeed | null) {
  const g = new ArcGeom(arcDrawMode());
  const d: DrawState = { shape: "garc", arc: g, chainSeeded: false, clickSeeded: false, started: false, start: [0, 0], cur: [0, 0], pts: [] };
  if (chainSeed) { g.setTangentSeed(chainSeed.start, chainSeed.dir, chainSeed.axis); d.chainSeeded = true; d.started = true; d.start = fromNm(chainSeed.start); }
  return d;
}
/** ARC_MODE_SESSION::SetMode, from a mode action or Cycle Arc Drawing Mode while the tool runs. */
export function switchArcMode(ctx: PcbCtx, m: number) {
  setArcDrawMode(m); showArcMode(ctx);
  const d = S.draw; if (d && d.shape === "garc") { d.arc!.setMode(m); d.chainSeeded = false; d.clickSeeded = false; syncArcDraw(d); }
  ctx.requestRender();
}
export function syncArcDraw(d: DrawState) { const g = d.arc!; d.pts = g.hasPreview() ? [fromNm(g.pts[0])] : []; d.start = fromNm(g.pts[0]); }
export function arcClick(ctx: PcbCtx, p: Pt) {
  let d = S.draw; if (!d || d.shape !== "garc") { d = S.draw = newArcDraw(null); }
  const g = d.arc!, pos = toNm(p);
  if (!d.started) { applySelection(ctx, []); d.started = true; }
  // ARC_MODE_SESSION::PlacePoint: in the tangent mode the first click on a graphic seeds the arc from it
  const first = !d.chainSeeded && !d.clickSeeded && g.getStep() === 0;
  if (first && g.mode === ARC_TANGENT) { const seed = findTangentSeed(ctx, pos); if (seed) { g.setTangentSeed(seed.start, seed.dir, seed.axis); d.clickSeeded = true; syncArcDraw(d); ctx.requestRender(); return; } }
  g.addPoint(pos, true); d.clickSeeded = false; d.lastClick = pos; syncArcDraw(d);
  if (g.isComplete()) commitArc(ctx, d);
  ctx.requestRender();
}
export function commitArc(ctx: PcbCtx, d: DrawState) {
  const sh = d.arc!.shape(); S.draw = null;
  if (!sh) return;
  const node = withStroke(arcNode(fromNm(sh.start), fromNm(sh.mid), fromNm(sh.end), S.gfxLayer));
  const add = addedChange(ctx.doc, node); ctx.commit([add], "Draw Arc");
  if (add.id) applySelection(ctx, [add.id]);   // the committed arc is selected (ACTIONS::selectItem)
  // the tool goes on with the next arc; in the tangent mode it leaves from the end of this one
  const committed = { t: "arc" as const, start: sh.start, mid: sh.mid, end: sh.end, center: [sh.center[0], sh.center[1]] };
  S.draw = newArcDraw(arcDrawMode() === ARC_TANGENT ? arcTangentSeedNear(committed, d.lastClick || sh.end) : null);
}
export function arcMove(d: DrawState, p: Pt, ctrl: boolean) {
  const g = d.arc!; d.cur = p.slice();
  g.snap = !ctrl && angleSnapMode() !== "free";   // SetAngleSnap( angleSnap != LEADER_MODE::DIRECT )
  if (g.hasPreview()) g.addPoint(toNm(p), false);
}
/** ARC_MODE_SESSION::RemoveLastPoint (Backspace). */
export function arcBackup(ctx: PcbCtx) {
  const d = S.draw!, g = d.arc!;
  if (d.clickSeeded) { g.reset(); d.clickSeeded = false; }
  else if (g.isReset() && !g.hasTangentSeed()) { S.draw = null; }
  else g.removeLastPoint();
  if (S.draw) syncArcDraw(d);
  ctx.requestRender();
}
/** finishInteractive (Enter): the arc drawn so far is kept and the tool ends (SHAPE_DRAW_RESULT::FINISHED). */
export function finishArc(ctx: PcbCtx, editing: () => boolean) {
  const d = S.draw!, sh = d.started ? d.arc!.shape() : null; S.draw = null;
  if (sh && editing()) { const add = addedChange(ctx.doc, withStroke(arcNode(fromNm(sh.start), fromNm(sh.mid), fromNm(sh.end), S.gfxLayer))); ctx.commit([add], "Draw Arc"); if (add.id) applySelection(ctx, [add.id]); }
  ctx.setTool("select"); ctx.requestRender();
}
/** ARC_ASSISTANT::ViewDraw: the arc's construction guides and the values next to the cursor. */
export function drawArcPreview(c: CanvasRenderingContext2D, d: DrawState, px: number, colour: string) {
  const g = d.arc!; if (!g.hasPreview()) return;
  const sh = g.shape(), mm = fromNm;
  if (sh) { const a = K.arcFrom3(mm(sh.start), mm(sh.mid), mm(sh.end)); if (a) { c.beginPath(); c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); c.stroke(); } }
  c.save(); c.globalAlpha = 1; c.lineWidth = px; c.strokeStyle = colour;
  const guide = (a: Pt, b: Pt, dim: boolean) => { c.globalAlpha = dim ? 0.45 : 0.9; line(c, mm(a), mm(b)); };
  const dashed = (a: Pt, b: Pt) => { const v = vsub(b, a), L = Math.hypot(v[0], v[1]), lim = 400 * px * NM; const e = L > lim ? vadd(a, vmul(v, lim / L)) : b;
    c.globalAlpha = 0.9; c.setLineDash([12 * px, 6 * px]); line(c, mm(a), mm(e)); c.setLineDash([]); };
  const strs: string[] = []; let anchor = mm(g.startRadiusEnd()); const cursor = mm(g.last);
  if (g.mode === ARC_CENTER_START_END) {
    const o = g.getOrigin(); anchor = mm(o);
    guide(o, g.startRadiusEnd(), g.getStep() > 1);
    if (g.getStep() === 1) { strs.push(dimensionLabel("r", g.radius / NM)); let a = g.startAngle(); while (a < -360) a += 360; while (a >= 360) a -= 360; strs.push(dimensionLabel("θ", a, true)); }
    else { guide(o, g.endRadiusEnd(), false); guide(o, g.last, true);
      const sub = g.subtended(); let end = g.startAngle() + sub; end = ((end + 180) % 360 + 360) % 360 - 180;
      strs.push(dimensionLabel("Δθ", sub, true)); strs.push(dimensionLabel("θ", end, true)); }
  } else {
    const i = g.pointIndex(); if (i === 0) { c.restore(); return; }
    const start = g.startRadiusEnd(), sol = g.sol;
    if (g.mode === ARC_START_END_MID || g.mode === ARC_START_END_CENTER) {
      const chordEnd = i === 1 ? g.last : g.pts[1], mid = [(start[0] + chordEnd[0]) / 2, (start[1] + chordEnd[1]) / 2];
      guide(start, chordEnd, i > 1); anchor = mm(mid);
      if (i > 1 && sol.valid) {
        const marked = g.mode === ARC_START_END_MID ? sol.mid : sol.center;
        dashed(mid, marked); c.globalAlpha = 0.9; ring(c, mm(marked), 4 * px);
        if (g.mode === ARC_START_END_CENTER) { guide(marked, sol.start, true); guide(marked, sol.end, true); }
        strs.push(dimensionLabel("r", sol.radius / NM)); strs.push(dimensionLabel("s", Math.hypot(sol.mid[0] - mid[0], sol.mid[1] - mid[1]) / NM));
      }
    } else {
      const dir = g.dir, L = Math.hypot(dir[0], dir[1]);
      if (L > 0) dashed(start, vadd(start, vmul(dir, Math.max(L, 100 * px * NM) / L)));
      if (i === 1) { guide(start, g.last, true); strs.push(dimensionLabel("θ", degOf(dir), true)); }
      else if (sol.valid) { guide(start, sol.end, true); strs.push(dimensionLabel("r", sol.radius / NM)); }
    }
    if (sol.valid) strs.push(dimensionLabel("Δθ", g.subtended(), true));
  }
  c.restore();
  if (strs.length) textNextToCursor(c, cursor, vsub(anchor, cursor), strs, px, colour);
}
