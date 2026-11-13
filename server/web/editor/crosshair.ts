// crosshair.ts — KiCad's canvas cursor, drawn over the canvas at the snapped cursor position.
//
// GAL::DrawCursor: the cursor sits on the grid point the tools will use (not under the mouse), in the
// colour theme's cursor colour, as one of the three View > Crosshair modes:
//  · small  — an 80 px cross ("cursorSize = 80");
//  · full   — horizontal and vertical lines across the whole canvas;
//  · 45     — the two diagonals across the whole canvas (FULLSCREEN_DIAGONAL).
// The system cursor over the canvas is the tool's KICURSOR (cursors.ts).

import { snapMm } from "./doc";
import { E } from "./state";
import { activeModule } from "./tools";
import { applyView, isSch, mmH, mmW, mmX0, mmY0, requestRepaint, stage, world } from "./view";

const SMALL = 80;   // OPENGL_GAL::blitCursor: cursorSize = 80 screen (device) pixels

/** The cursor's document position (snapped), or null while the pointer is off the canvas. */
let at: number[] | null = null;
/** Whether `at` is a position a tool forced (ForceCursorPosition) rather than the grid snap of the mouse. */
let forcedAt = false;

/**
 * Where the cursor is drawn for the mouse at `mm`: the point the active tool snapped to (VIEW_CONTROLS::
 * ForceCursorPosition from GRID_HELPER::BestSnapAnchor, the router's snap), else the grid point under the mouse.
 * SCH_TOOL_BASE::InteractiveDelete runs its picker with SetSnapping( false ), so its cursor sits on the pointer.
 */
function cursorPoint(mm: number[]): number[] {
  if (E.kdoc && E.kdoc.type === "sch" && E.tool === "delete") return mm;
  const m = activeModule() as { toolCursorPoint?: () => number[] | null } | null;
  if (m && m.toolCursorPoint) { try { const p = m.toolCursorPoint(); if (p && isFinite(p[0]) && isFinite(p[1])) return p; } catch (e) { /* fall back to the grid */ } }
  return snapMm(mm);
}

/**
 * Draw the cursor for document position `mm` (snapped here) or at the position a tool `forced`, or hide it (null:
 * the pointer left the canvas).  Returns where it is drawn (GetCursorPosition), or null.
 */
export function placeCrosshair(mm: number[] | null, forced?: number[] | null): number[] | null {
  const next = mm && E.kdoc ? (forced || cursorPoint(mm)) : null;
  forcedAt = !!(next && forced);
  if (!next && !at) return null;
  if (next && at && next[0] === at[0] && next[1] === at[1]) return next;
  at = next; requestRepaint(); return next;
}

/** Redraw at the last cursor position (after a pan / zoom or a mode change), if the cursor is on the canvas. */
export function refreshCrosshair(): void { if (at && E.lastCursorMm && !forcedAt) { at = cursorPoint(E.lastCursorMm); requestRepaint(); } }

/**
 * The colour theme's cursor colour: LAYER_SCHEMATIC_CURSOR (KiCad Default #0F0F0F, Classic black) on the
 * schematic, LAYER_CURSOR (white) on the board (builtin_color_themes.h).
 */
export function cursorColor(): string {
  if (!isSch()) return "#FFFFFF";
  const K = KiCadCanvas as unknown as { schTheme?: () => string; SCH?: Record<string, string> };
  const id = K.schTheme ? K.schTheme() : "default";
  return id === "classic" ? "#000000" : id === "dark" ? "#E8E8E8" : "#0F0F0F";
}

/**
 * GAL::DrawCursor (OPENGL_GAL::blitCursor): one device pixel wide, in the cursor colour, on the canvas after
 * everything else — an 80 px cross, full-window lines, or the two full-window diagonals.
 */
export function drawCrosshair(ctx: CanvasRenderingContext2D): void {
  if (!at || !E.kdoc) return;
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (!(wr.width > 0) || !(wr.height > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  // device pixels, on the pixel centre so a one-pixel line stays crisp
  const x = Math.round((wr.left - sr.left + ((at[0] - mmX0()) / mmW()) * wr.width) * dpr) + 0.5;
  const y = Math.round((wr.top - sr.top + ((at[1] - mmY0()) / mmH()) * wr.height) * dpr) + 0.5;
  const W = ctx.canvas.width, H = ctx.canvas.height, L = W + H;
  const mode = E.crosshairMode === "full" || E.crosshairMode === "45" ? E.crosshairMode : "small";
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = cursorColor(); ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath();
  if (mode === "45") { ctx.moveTo(x - L, y - L); ctx.lineTo(x + L, y + L); ctx.moveTo(x - L, y + L); ctx.lineTo(x + L, y - L); }
  else if (mode === "full") { ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  else { ctx.moveTo(x - SMALL / 2, y); ctx.lineTo(x + SMALL / 2, y); ctx.moveTo(x, y - SMALL / 2); ctx.lineTo(x, y + SMALL / 2); }
  ctx.stroke(); ctx.restore();
}

/** The grid pitch the cursor keys step by: the active tool's grid override, else the grid (mm). */
function gridStep(): number { const g = E.gridFor ? E.gridFor() : E.gridPitch; return g > 0 ? g : 1; }

/**
 * COMMON_TOOLS::CursorControl (Up / Down / Left / Right, ×10 with Ctrl): the cursor moves by grid steps, and
 * the view follows when it would leave the window.  The browser cannot warp the mouse, so the move is handed
 * to the canvas as a pointer move at the new position: hover, previews and drags follow it as they do in KiCad.
 */
export function cursorStep(dx: number, dy: number, steps: number): void {
  if (!E.kdoc) return;
  const sr = stage.getBoundingClientRect(), d = gridStep() * steps;
  const toScreen = (q: number[]): number[] => { const wr = world.getBoundingClientRect(); return [wr.left + ((q[0] - mmX0()) / mmW()) * wr.width, wr.top + ((q[1] - mmY0()) / mmH()) * wr.height]; };
  let from = E.lastCursorMm as number[] | null;
  if (!from) { const wr = world.getBoundingClientRect(); from = [mmX0() + ((sr.left + sr.width / 2 - wr.left) / wr.width) * mmW(), mmY0() + ((sr.top + sr.height / 2 - wr.top) / wr.height) * mmH()]; }
  const s = snapMm(from), to = [s[0] + dx * d, s[1] + dy * d];
  let [x, y] = toScreen(to);
  const m = 4;
  if (x < sr.left + m || x > sr.right - m || y < sr.top + m || y > sr.bottom - m) {
    const wr = world.getBoundingClientRect(), ppx = wr.width / mmW();
    E.viewTouched = true; E.panX -= dx * d * ppx; E.panY -= dy * d * ppx; applyView();
    [x, y] = toScreen(to);
  }
  stage.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
}

/** COMMON_TOOLS::PanControl (Shift + arrows): the view moves by ten grid steps. */
export function panStep(dx: number, dy: number): void {
  const wr = world.getBoundingClientRect(), ppx = wr.width > 0 ? wr.width / mmW() : 4, d = gridStep() * 10 * ppx;
  E.viewTouched = true; E.panX += dx * d; E.panY += dy * d; applyView();
  refreshCrosshair();
}
