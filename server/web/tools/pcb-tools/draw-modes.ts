// pcb-tools/draw-modes.ts — the drawing tools' angle snap modes, polygon leaders and stroke width.
import type { DrawState, PcbCtx, Pt } from "./types";
import { root } from "../root";
import { deleteChanges } from "./changes";
import { DIM_TYPE, snap45, snap90, snapVec45 } from "./dimensions";
import { dimTrack } from "./draw-tools";
import { gfxWidth } from "./nodes";
import { lsGet, lsSet } from "./router-settings";
import { S } from "./state";
import { r6, samePt, vadd, vsub } from "./util";

// S.draw = { shape, start, cur, pts, … }: line/rect/circle take two clicks, an arc its start, end and
// then a point on the arc, a bezier its start, two control points and end, a polygon / zone / rule area
// any number of corners until the first corner is clicked again (or the last one twice, or Enter), a
// text box or table two corners and then a prompt, a dimension two points and (aligned, orthogonal,
// radial) a third for the offset or the text.
export const POLY_TOOLS = new Set(["gpoly", "zone", "thievingzone", "rulearea"]);
export const gfxTool = (t: string | null | undefined) => /^g/.test(t || "") || t === "table" || t === "image" || !!DIM_TYPE[t!];   // draws on the chip's graphics layer
export const RULE_AREA_LAYERS = ["F.Cu", "B.Cu"];
// ---- PCB_TOOL_BASE::GetAngleSnapMode (PCBNEW_SETTINGS m_AngleSnapMode, DIRECT by default in the board editor):
// the Line Modes radio on the left toolbar and Shift+Space (lineModeNext) choose it; it is kept per viewer.
export const ANGLE_SNAP_KEY = "kc.pcbnew.angleSnapMode", ANGLE_SNAP_MODES = ["free", "90", "45"];
/** PCB_VIEWER_TOOLS::NextLineMode: DIRECT -> DEG45 -> DEG90 -> DIRECT. */
export function nextLineMode(m: string | null | undefined) { return m === "free" ? "45" : m === "45" ? "90" : "free"; }
export const ANGLE_SNAP_MSG: Record<string, string> = { free: "", "90": "Constrain to H, V", "45": "Constrain to H, V, 45" };   // DRAWING_TOOL::UpdateStatusBar
export function angleSnapMode() {
  if (!S.angleSnap) { const v = lsGet(ANGLE_SNAP_KEY); S.angleSnap = ANGLE_SNAP_MODES.includes(v!) ? v! : "free"; }
  return S.angleSnap;
}
/** BOARD_EDITOR_CONTROL::ChangeLineMode: the new mode applies to the shape being drawn at once (refreshPreview). */
export function setAngleSnap(ctx: PcbCtx, mode: string) {
  if (!ANGLE_SNAP_MODES.includes(mode)) return angleSnapMode();
  S.angleSnap = mode; lsSet(ANGLE_SNAP_KEY, mode);
  if (ctx && S.draw && S.drawRaw) { drawTrack(S.draw, S.drawRaw, S.drawCtrl!); }
  if (ctx) ctx.requestRender();
  // angleSnapModeChanged: the toolbar's Line Modes radio follows (panes.ts listens)
  try { if (typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") root.dispatchEvent(new CustomEvent("kc:pcb-linemode", { detail: { mode, msg: ANGLE_SNAP_MSG[mode] } })); } catch (e) { /* no DOM */ }
  return mode;
}
export const LINE_LIKE = (shape: string) => shape === "gline" || POLY_TOOLS.has(shape);
/**
 * The angle constraint the drawing tools put on the cursor: lines, polygons, zones and rule areas follow the mode
 * unless Ctrl is held (DrawShape / DrawZone: MD_CTRL → DIRECT); rectangles and circles are free unless Ctrl is held,
 * which constrains them to 45° (a rectangle to a square: GetVectorSnapped45( v, only45 )); a dimension's end snaps to
 * 45° whenever any mode is on, and a centre mark always.
 */
export function drawSnapMode(d: DrawState, ctrl: boolean) {
  const t = d.shape;
  if (t === "grect" || t === "gcircle") return ctrl ? "45" : "free";
  if (LINE_LIKE(t)) return ctrl ? "free" : angleSnapMode();
  if (DIM_TYPE[t] && !d.end) return DIM_TYPE[t] === "center" || (!ctrl && angleSnapMode() !== "free") ? "45" : "free";
  return "free";
}
export function constrainDraw(d: DrawState, p: Pt, ctrl: boolean) {
  const mode = drawSnapMode(d, ctrl); if (mode === "free" || POLY_TOOLS.has(d.shape)) return p;   // polygons bend a leader instead
  const v = vsub(p, d.start);
  return vadd(d.start, mode === "90" ? snap90(v) : snapVec45(v, d.shape === "grect"));
}
// ---- POLYGON_GEOM_MANAGER: in the 45 and 90 modes a polygon, zone or rule area reaches the cursor through a leader
// that bends once (build45DegLeader / build90DegLeader), and a loop line of the same kind runs back to the first corner.
export const normDeg180 = (a: number) => { while (a <= -180) a += 360; while (a > 180) a -= 360; return a; };
export const normDeg90 = (a: number) => { while (a < -90) a += 180; while (a > 90) a -= 180; return a; };
export const vecDeg = (v: Pt) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
export function build45Leader(end: Pt, pts: Pt[]) {
  const last = pts[pts.length - 1], v = vsub(end, last);
  if (pts.length < 2) return [last, vadd(last, snap45(v))];
  const lineA = vecDeg(v), prevA = vecDeg(snap45(vsub(last, pts[pts.length - 2])));
  const vertical = Math.abs(v[1]) > Math.abs(v[0]), horizontal = Math.abs(v[1]) < Math.abs(v[0]);
  const angDiff = Math.abs(normDeg180(lineA - prevA));
  let bendEnd = angDiff < 45 || (angDiff > 90 && angDiff < 135);
  if (Math.abs(Math.abs(normDeg90(prevA)) - 45) < 1e-9) bendEnd = !bendEnd;
  let mid = end;
  if (bendEnd) {
    if (vertical) mid = [last[0], v[1] > 0 ? end[1] - Math.abs(v[0]) : end[1] + Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? end[0] - Math.abs(v[1]) : end[0] + Math.abs(v[1]), last[1]];
  } else {
    if (vertical) mid = [end[0], v[1] > 0 ? last[1] + Math.abs(v[0]) : last[1] - Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? last[0] + Math.abs(v[1]) : last[0] - Math.abs(v[1]), end[1]];
  }
  return [last, mid, end];
}
export function build90Leader(end: Pt, pts: Pt[]) {
  const last = pts[pts.length - 1];
  if (last[0] === end[0] || last[1] === end[1]) return [last, end];
  return [last, [end[0], last[1]], end];
}
/** updateTemporaryLines: { leader, loop } for the cursor at `end`. */
export function polyLeader(d: Pick<DrawState, "pts">, end: Pt, mode: string) {
  if (mode === "45") return { leader: build45Leader(end, d.pts), loop: build45Leader(end, d.pts.slice().reverse()).reverse() };
  if (mode === "90") return { leader: build90Leader(end, d.pts), loop: build90Leader(end, d.pts.slice().reverse()).reverse() };
  return { leader: [d.pts[d.pts.length - 1], end], loop: [] };
}
export const pushPt = (arr: Pt[], p: Pt) => { if (!arr.length || !samePt(arr[arr.length - 1], p)) arr.push(p); };
/** The cursor of the shape being drawn: the grid-resolved point, constrained. */
export function drawTrack(d: DrawState, raw: Pt, ctrl: boolean) {
  d.cur = constrainDraw(d, raw, ctrl);
  if (POLY_TOOLS.has(d.shape)) { d.mode = drawSnapMode(d, ctrl); Object.assign(d, polyLeader(d, d.cur, d.mode)); }
  if (DIM_TYPE[d.shape] && d.end) dimTrack(d, d.cur);
  else if (d.shape === "dimortho") d.orientation = Math.abs(d.cur[0] - d.start[0]) < Math.abs(d.cur[1] - d.start[1]) ? "v" : "h";   // measure the longer side
}
/** DRAWING_TOOL::WIDTH_STEP (0.1 mm): Ctrl++ / Ctrl+- while a shape is being drawn (incWidth / decWidth). */
export const WIDTH_STEP = 0.1;
export function drawWidth(layer: string) { return S.strokeW != null ? S.strokeW : gfxWidth(layer); }
export function stepDrawWidth(ctx: PcbCtx, dir: number) {
  const d = S.draw; if (!d || d.shape === "gtextbox" || d.shape === "table") return false;
  if (DIM_TYPE[d.shape] && d.pts.length < 2 && !d.end && d.pts.length === 0) return false;
  const w = drawWidth(S.gfxLayer);
  if (dir > 0) S.strokeW = +(w + WIDTH_STEP).toFixed(6);
  else if (w > WIDTH_STEP) S.strokeW = +(w - WIDTH_STEP).toFixed(6);
  ctx.requestRender(); return true;
}
/** A new graphic as drawn: the session's stroke width (incWidth / decWidth) over the layer default. */
export function withStroke(node: SNode) {
  if (S.strokeW == null || !Array.isArray(node)) return node;
  const w = r6(S.strokeW);
  const st = node.find((c) => Array.isArray(c) && c[0] === "stroke") as SNode | undefined;
  if (st) { const wi = st.find((c) => Array.isArray(c) && c[0] === "width"); if (wi) (wi as SNode)[1] = w; }
  const style = node.find((c) => Array.isArray(c) && c[0] === "style") as SNode | undefined;   // a dimension's line thickness
  if (style) { const th = style.find((c) => Array.isArray(c) && c[0] === "thickness") as SNode | undefined; if (th) th[1] = w; }
  return node;
}
/**
 * deleteLastPoint (Backspace) / doDelete while a line chain is drawn: the last committed segment is taken back (its
 * undo entry popped, PutDataInPreviousState) and its start becomes the start of the line being drawn again.
 */
export function undoChainSegment(ctx: PcbCtx) {
  const d = S.draw; if (!d || d.shape !== "gline" || !d.chain || !d.chain.length) return false;
  const last = d.chain.pop();
  if (ctx.doc.items.has(last!.id)) ctx.commit(deleteChanges(ctx.doc, [last!.id]), "line", { amend: true, discard: true });
  d.start = last!.start; d.pts = [last!.start]; d.cur = last!.end.slice();
  ctx.requestRender(); return true;
}
