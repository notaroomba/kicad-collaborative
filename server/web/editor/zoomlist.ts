// zoomlist.ts — KiCad's zoom presets and the stepping rules of COMMON_TOOLS (common/tool/common_tools.cpp).
// Pure: no DOM, so the node tests load it directly.

/** include/zoom_defines.h ZOOM_LIST_EESCHEMA / ZOOM_LIST_PCBNEW, kept with the other KiCad tables. */
export { ZOOM_LIST } from "../tables";

/**
 * COMMON_TOOLS::doZoomInOut: the zoom factor times (or over) at least 1.3, then the next zoom-list entry at or
 * above it (zooming in) or at or below it (zooming out), pegged to the ends of the list.
 */
export function nextZoomPreset(list: number[], current: number, zoomIn: boolean): number {
  const z = zoomIn ? current * 1.3 : current / 1.3;
  if (zoomIn) { for (const f of list) if (f >= z) return f; return list[list.length - 1]; }
  for (let i = list.length - 1; i >= 0; i--) if (list[i] <= z) return list[i];
  return list[0];
}

/**
 * The margin EDA_DRAW_PANEL_GAL::ZoomToFit leaves around a fitted box, as the fraction of the screen the box may
 * fill: 1/1.04 (1/1.10 when the canvas is under 768 px high), 1/1.48 in the symbol and footprint editors' Zoom to Fit.
 */
export function fitMargin(canvasHeight: number, libraryEditor: boolean): number {
  return 1 / (libraryEditor ? 1.48 : canvasHeight < 768 ? 1.10 : 1.04);
}
