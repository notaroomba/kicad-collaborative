// viewer3d/colors.ts — KiCad's default 3D viewer colours (3d-viewer/3d_canvas/board_adapter.cpp:212-225,
// the g_Default* COLOR4D values) and the placeholder colours of the component bodies.

/** r, g, b in 0..1 (sRGB, as KiCad's COLOR4D stores them) and alpha. */
export type RGBA = [number, number, number, number];

export const BACKGROUND_TOP: RGBA = [0.80, 0.80, 0.90, 1];      // g_DefaultBackgroundTop
export const BACKGROUND_BOTTOM: RGBA = [0.40, 0.40, 0.50, 1];   // g_DefaultBackgroundBot
export const SILKSCREEN: RGBA = [0.94, 0.94, 0.94, 1];          // g_DefaultSilkscreen
export const SOLDER_MASK: RGBA = [0.08, 0.20, 0.14, 0.83];      // g_DefaultSolderMask
export const SOLDER_PASTE: RGBA = [0.50, 0.50, 0.50, 1];        // g_DefaultSolderPaste
export const SURFACE_FINISH: RGBA = [0.75, 0.61, 0.23, 1];      // g_DefaultSurfaceFinish (copper)
export const BOARD_BODY: RGBA = [0.43, 0.45, 0.30, 0.90];       // g_DefaultBoardBody
/** The inside of a drilled hole seen from above where it could not be cut out of the board mesh. */
export const HOLE_SHADE: RGBA = [0.10, 0.09, 0.07, 1];

export function css(c: RGBA, alpha = c[3]): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return alpha >= 1 ? `rgb(${v(c[0])},${v(c[1])},${v(c[2])})` : `rgba(${v(c[0])},${v(c[1])},${v(c[2])},${+alpha.toFixed(3)})`;
}

export function hex(c: RGBA): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return "#" + v(c[0]) + v(c[1]) + v(c[2]);
}

export function fromHex(h: string): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(h); if (!m) return [0, 0, 0, 1];
  const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}
