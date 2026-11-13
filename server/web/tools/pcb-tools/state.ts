// pcb-tools/state.ts — the module state S, the canvas API K and the constants every section shares.
import type { PcbCanvasApi, PcbCtx, PcbState } from "./types";
import { root } from "../root";
import { ensureDom } from "./dom";

export let K = root.KiCadCanvas as PcbCanvasApi;                 // re-bound from ctx.K on every hook
export const WIDTHS = [0.2, 0.25, 0.3, 0.5, 0.8, 1.0];
export const HL = "#FFB43A", VIA = "#ECECEC", DEL = "#FF5C5C";
export const ANCHOR = "rgb(255, 38, 226)";   // LAYER_ANCHOR (builtin_color_themes.h): the snap guides
export const RATSNEST = "rgba(0, 248, 255, 0.35)";   // LAYER_RATSNEST (builtin_color_themes.h)
// the router's preview colours: the ratsnest Brightened(0.8) with alpha + 0.4 for the routed net, Brightened(0.5) for
// the leading line from the head (DisplayRatline), and DARKDARKGRAY clearance halos
export const RATSNEST_BRIGHT = "rgba(204, 250, 255, 0.575)", RATSNEST_LEAD = "rgba(128, 252, 255, 0.75)", HALO_COLOR = "rgb(72, 72, 72)";
// ROUTER_PREVIEW_ITEM DM_SHADOW: DARKDARKGRAY stroked at 0.9 (line chains: the head), filled at 0.7 (segments, vias, obstacles)
export const HALO_STROKE_ALPHA = 0.9, HALO_FILL_ALPHA = 0.7;
/** pcb_display.track_clearance_mode values (TRACK_CLEARANCE_MODE). */
export const CLEARANCE_MODE = { NONE: 0, ROUTING: 1, ROUTING_VIA: 2, ROUTING_EDITING: 3, ALWAYS: 4 };
/** COLOR4D::Saturate(1.0): the same hue and value at full saturation (the head trace colour). */
export function saturated(col: string) {
  let r, g, b; const m = /^#([0-9a-f]{6})/i.exec(col), q = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(col);
  if (m) { const v = parseInt(m[1], 16); r = v >> 16; g = (v >> 8) & 255; b = v & 255; } else if (q) { r = +q[1]; g = +q[2]; b = +q[3]; } else return col;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return `rgb(${r}, ${g}, ${b})`;
  const f = (x: number) => Math.round(max * (x - min) / (max - min));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}
// KiCad's delete cursor: a small bin with a crosshair hotspot
export const DELETE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 8h12M8 2v12M4 8h8M8 4v8" stroke="#fff" stroke-width="3"/><path d="M2 8h12M8 2v12" stroke="#000" stroke-width="1.2"/><path d="M14 10h8l-1 12h-6zM13 8h10M17 6h2v2h-2z" fill="#fff" stroke="#c00" stroke-width="1.2"/></svg>') + '") 8 8, crosshair';
export const SNAP_MM = 0.5, HIT_MM = 0.2, DBL_MS = 400;
// The desktop applier only parses kicad_pcb documents (a bare item takes the
// legacy-format branches), so every fragment travels wrapped.  The version is
// the one boards from this build carry — it must never exceed the desktop's.
export const BOARD_VERSION = 20260728;

export const S = {
  layer: "F.Cu", gfxLayer: "F.Cu",   // graphics, text and dimensions are drawn on the active layer, as DRAWING_TOOL does
  sel: new Set(), padSel: null, padAlso: null, pedit: null, mmPerPx: 0, route: null,   // padSel: a pad picked on its own, "footprintId#padIndex" (PCB_SELECTION_TOOL selects PCB_PAD_T)
  drag: null, draw: null, hover: null, text: null, modTool: null, doc: null,
  image: null,                            // the picked reference image riding the cursor: { base64, info, w, h, name }
  client: null,                           // last pointer position in client px, where prompts open
  markers: [],                            // the last DRC run's markers [{ x, y, severity, text, ids, code }]
  padClearance: true,                     // pcb_display.pad_clearance (Show pad clearance), on by default
  trackClearance: 2,                      // pcb_display.track_clearance_mode (Preferences ▸ PCB Editor ▸ Display Options), SHOW_WITH_VIA_WHILE_ROUTING
  showRatsnest: true, localRatsnest: false, hiddenNets: new Set(), rats: null, ratsDirty: true,   // ratsnest display (KiCad shows it by default)
  settings: null, settingsSrc: null, settingsCache: null, highlightNet: null,
  docVer: 0, rworld: null, nlc: null, violations: null,   // the router's caches (per document change) and the obstacles shown in violation
  tune: { pattern: null, picker: null, cursor: null },   // the length tuner: the pattern being placed, the track under the cursor
} as unknown as PcbState;   // rs, tuneSettings and the rest are set by the later sections' own top-level statements as the script loads
export let lastCtx: PcbCtx | null = null;

export function bind(ctx: PcbCtx) { lastCtx = ctx; if (ctx && ctx.K) K = ctx.K as PcbCanvasApi; if (ctx) ensureDom(ctx); }
