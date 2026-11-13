// crosshair.ts — KiCad's canvas cursor, drawn on its own canvas over the board at the tool's cursor position.
//
// GAL::DrawCursor: the cursor sits on the grid point the tools will use (not under the mouse), in the
// colour theme's cursor colour, as one of the three View > Crosshair modes:
//  · small  — an 80 px cross ("cursorSize = 80");
//  · full   — horizontal and vertical lines across the whole canvas;
//  · 45     — the two diagonals across the whole canvas (FULLSCREEN_DIAGONAL).
// The system cursor over the canvas is the tool's KICURSOR (arrow while selecting, pencil while drawing …),
// see toolCursor().

import { snapMm } from "./doc";
import { $ } from "./dom";
import { E } from "./state";
import { activeModule } from "./tools";
import { applyView, mmH, mmW, mmX0, mmY0, stage, world } from "./view";

const SMALL = 40;   // half of GAL's 80 px cursor

let shown = false;
let drawnMode = "";

/**
 * Where the cursor is drawn: the point the active tool snapped to (VIEW_CONTROLS::ForceCursorPosition from
 * GRID_HELPER::BestSnapAnchor, the router's snap), else the grid point under the mouse.
 */
function cursorPoint(mm: number[]): number[] {
  const m = activeModule() as { toolCursorPoint?: () => number[] | null } | null;
  if (m && m.toolCursorPoint) { try { const p = m.toolCursorPoint(); if (p && isFinite(p[0]) && isFinite(p[1])) return p; } catch (e) { /* fall back to the grid */ } }
  return snapMm(mm);
}

/**
 * Draw the cursor at document position `mm`, or hide it (null: the pointer left the canvas).  OPENGL_GAL::blitCursor:
 * on the canvas (LAYER_CURSOR, a canvas over the board), one pixel wide, at the tool's cursor position.
 */
export function placeCrosshair(mm: number[] | null): void {
  const cv = $("#crosshair") as unknown as HTMLCanvasElement | null;
  if (!cv || typeof cv.getContext !== "function") return;
  if (!mm || !E.kdoc) { if (shown) { cv.classList.remove("live"); shown = false; } return; }
  // SCH_TOOL_BASE::InteractiveDelete: the picker runs with SetSnapping( false ), so its cursor sits on the pointer
  const p = E.kdoc.type === "sch" && E.tool === "delete" ? mm : cursorPoint(mm), wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (!(wr.width > 0) || !(wr.height > 0)) return;
  const dpr = window.devicePixelRatio || 1, W = Math.round(sr.width * dpr), H = Math.round(sr.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const lw = Math.max(1, Math.round(dpr)), half = lw % 2 ? 0.5 : 0;
  const x = Math.round((wr.left - sr.left + ((p[0] - mmX0()) / mmW()) * wr.width) * dpr) + half;
  const y = Math.round((wr.top - sr.top + ((p[1] - mmY0()) / mmH()) * wr.height) * dpr) + half;
  const L = W + H, S = SMALL * dpr;
  const mode = E.crosshairMode === "full" || E.crosshairMode === "45" ? E.crosshairMode : "small";
  if (drawnMode !== mode) { cv.dataset.mode = mode; drawnMode = mode; }
  const c = cv.getContext("2d")!; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  c.strokeStyle = getComputedStyle(cv).color || "#FFFFFF"; c.lineWidth = lw; c.lineCap = "butt"; c.beginPath();
  if (mode === "45") { c.moveTo(x - L, y - L); c.lineTo(x + L, y + L); c.moveTo(x - L, y + L); c.lineTo(x + L, y - L); }
  else if (mode === "full") { c.moveTo(0, y); c.lineTo(W, y); c.moveTo(x, 0); c.lineTo(x, H); }
  else { c.moveTo(x - S, y); c.lineTo(x + S, y); c.moveTo(x, y - S); c.lineTo(x, y + S); }
  c.stroke();
  if (!shown) { cv.classList.add("live"); shown = true; }
}

/** Redraw at the last cursor position (after a pan / zoom or a mode change), if the cursor is on the canvas. */
export function refreshCrosshair(): void { if (shown && E.lastCursorMm) placeCrosshair(E.lastCursorMm); }

// KICURSOR::PENCIL — the drawing tools' cursor; hotspot at the tip
const PENCIL = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2.5 21.5l1.6-5.4L16.6 3.6a1.9 1.9 0 0 1 2.7 0l1.1 1.1a1.9 1.9 0 0 1 0 2.7L7.9 19.9z" fill="#fff" stroke="#000" stroke-linejoin="round"/><path d="M4.1 16.1l3.8 3.8M14.6 5.6l3.8 3.8" stroke="#000"/><path d="M2.5 21.5l.9-3 2.1 2.1z"/></svg>')}") 2 22, crosshair`;

/** The system cursor for a tool module's declared cursor: KiCad draws with the pencil, not a second crosshair. */
export function toolCursor(declared: string): string { return declared === "crosshair" ? PENCIL : declared; }

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
