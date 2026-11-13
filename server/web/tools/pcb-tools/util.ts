// pcb-tools/util.ts — small helpers.
import type { DesignDefaults, Pt } from "./types";
import { K, S } from "./state";

// ---------------------------------------------------------------- small helpers
export const isList = Array.isArray;
export const r6 = (v: number) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };   // no -0 in files
export const norm360 = (a: number) => ((a % 360) + 360) % 360;
export const norm180 = (a: number) => { const v = norm360(a); return v > 180 ? v - 360 : v; };   // KiCad's footprint range
export const clone = <T>(n: T): T => K.cloneNode(n);   // not JSON: that drops the reader's record of which atoms were quoted
export const samePt = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
export function rotator(deg: number) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x: number, y: number) => [x * c + y * s, -x * s + y * c]; }
export const flipLayerName = (l: string) => /^F\./.test(l) ? "B." + l.slice(2) : /^B\./.test(l) ? "F." + l.slice(2) : l;
export const sideSpecific = (l: string) => /^[FB]\./.test(l);
export const otherSide = (l: string) => l === "F.Cu" ? "B.Cu" : "F.Cu";
export const layerOf = (node: SNode, def?: string) => { const l = K.kid(node, "layer"); return l ? K.str(l[1]) : (def || "F.Cu"); };
export const pt = (node: SNode, key: string) => { const k = K.kid(node, key); return k ? [K.num(k[1]), K.num(k[2])] : null; };
export const widthOf = (node: SNode, def: number) => { const w = K.kid(node, "width"); return w ? K.num(w[1], def) : def; };
export const color = (layer: string) => (K.PCB_COLORS && K.PCB_COLORS[layer]) || (/\.Cu$/.test(layer) ? "#7FC87F" : "#C2C2C2");
export const fmt = (v: number) => String(+v.toFixed(3));
// BOARD_DESIGN_SETTINGS::GetLayerClass and the class defaults pcbnew gives a new item on the layer:
// line width, text size and text thickness (board_design_settings.h DEFAULT_*).
export const layerClass = (l: string) => /^[FB]\.SilkS$/.test(l) ? "silk" : /\.Cu$/.test(l) ? "copper" : l === "Edge.Cuts" ? "edges" : /^[FB]\.CrtYd$/.test(l) ? "courtyard" : /^[FB]\.Fab$/.test(l) ? "fab" : "others";
export const LINE_W: Record<string, number> = { silk: 0.1, copper: 0.2, edges: 0.05, courtyard: 0.05, fab: 0.1, others: 0.1 };
export const TEXT_STYLE: Record<string, number[]> = { silk: [1, 0.1], copper: [1.5, 0.3], edges: [1, 0.15], courtyard: [1, 0.15], fab: [1, 0.15], others: [1, 0.15] };
/**
 * BOARD_DESIGN_SETTINGS' dimension defaults (Board Setup > Text & Graphics > Defaults: Dimension Properties), what
 * DrawDimension gives a new measuring dimension: automatic units, four places, no suffix, zeroes suppressed, text
 * outside and aligned; every dimension takes the arrow length and extension offset.
 */
export const DIM_DEFAULTS = { units: 3, precision: 4, unitsFormat: 0, suppressZeroes: true, textPosition: 0, keepAligned: true, arrowLength: 1.27, extOffset: 0.5 };
export const DIM_DEFAULTS0 = Object.assign({}, DIM_DEFAULTS);
const LINE_W0 = Object.assign({}, LINE_W), TEXT_STYLE0: Record<string, number[]> = JSON.parse(JSON.stringify(TEXT_STYLE));
let fpEditorDefaults = false;
export const footprintEditorDefaults = (): boolean => fpEditorDefaults;
/**
 * The Footprint Editor's own design settings (FOOTPRINT_EDITOR_SETTINGS::m_DesignSettings, whose defaults are the
 * DEFAULT_* of board_design_settings_defaults.h): a footprint takes them, never the open project's board settings.
 */
export function useFootprintEditorDefaults(on: boolean) {
  if (on !== fpEditorDefaults) S.angleSnap = undefined;   // the Footprint Editor keeps its own line mode (draw-modes.ts)
  fpEditorDefaults = on;
  if (on) { Object.assign(DIM_DEFAULTS, DIM_DEFAULTS0); Object.assign(LINE_W, LINE_W0); for (const [k, v] of Object.entries(TEXT_STYLE0)) TEXT_STYLE[k] = v.slice(); }
}
/** Take the project's per-layer-class defaults (board.design_settings.defaults) for new graphics and text. */
let rawDefaults: DesignDefaults = {};
export function layerDefaults(d: DesignDefaults) {
  rawDefaults = fpEditorDefaults ? {} : (d || {});
  if (fpEditorDefaults) { useFootprintEditorDefaults(true); return; }
  Object.assign(DIM_DEFAULTS, DIM_DEFAULTS0);
  const dd = d.dimensions || {}, int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? Math.round(v) : null);
  if (int(d.dimension_units, 0, 3) !== null) DIM_DEFAULTS.units = int(d.dimension_units, 0, 3)!;
  if (int(d.dimension_precision, 0, 9) !== null) DIM_DEFAULTS.precision = int(d.dimension_precision, 0, 9)!;
  if (int(dd.units_format, 0, 2) !== null) DIM_DEFAULTS.unitsFormat = int(dd.units_format, 0, 2)!;
  if (int(dd.text_position, 0, 2) !== null) DIM_DEFAULTS.textPosition = int(dd.text_position, 0, 2)!;
  if (typeof dd.suppress_zeroes === "boolean") DIM_DEFAULTS.suppressZeroes = dd.suppress_zeroes;
  if (typeof dd.keep_text_aligned === "boolean") DIM_DEFAULTS.keepAligned = dd.keep_text_aligned;
  if (typeof dd.arrow_length === "number" && dd.arrow_length > 0) DIM_DEFAULTS.arrowLength = dd.arrow_length / 1e6;   // stored in nm
  if (typeof dd.extension_offset === "number" && dd.extension_offset >= 0) DIM_DEFAULTS.extOffset = dd.extension_offset / 1e6;
  for (const [cls, stem] of [["silk", "silk"], ["copper", "copper"], ["edges", "board_outline"], ["courtyard", "courtyard"], ["fab", "fab"], ["others", "other"]]) {
    const w = d[stem + "_line_width"]; if (typeof w === "number" && w > 0) LINE_W[cls] = w;
    const sz = d[stem + "_text_size_h"], th = d[stem + "_text_thickness"]; if (typeof sz === "number" && sz > 0) TEXT_STYLE[cls] = [sz, typeof th === "number" && th > 0 ? th : TEXT_STYLE[cls][1]];
  }
}
/**
 * BOARD_DESIGN_SETTINGS::GetLineThickness / GetTextSize / GetTextThickness / GetTextItalic / GetTextUpright for a layer:
 * the layer class's defaults (the project's, or KiCad's when it has none).
 */
export function layerStyle(layer: string): { line: number; w: number; h: number; thick: number; italic: boolean; upright: boolean } {
  const cls = layerClass(layer);
  const stem = ({ silk: "silk", copper: "copper", edges: "board_outline", courtyard: "courtyard", fab: "fab", others: "other" } as Record<string, string>)[cls];
  const d = rawDefaults as Record<string, unknown>;
  const [size, thick] = TEXT_STYLE[cls];
  const v = d[stem + "_text_size_v"];
  return { line: LINE_W[cls], w: size, h: typeof v === "number" && v > 0 ? v : size, thick, italic: d[stem + "_text_italic"] === true,
    upright: typeof d[stem + "_text_upright"] === "boolean" ? d[stem + "_text_upright"] as boolean : true };
}
export const textStyle = (layer: string) => { const [size, thick] = TEXT_STYLE[layerClass(layer)]; return { size, thick }; };
export const isBack = (l: string) => /^B\./.test(l);
export const xy = (p: Pt) => ["xy", r6(p[0]), r6(p[1])];
export const corners = (a: Pt, b: Pt) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
export const vsub = (a: Pt, b: Pt) => [a[0] - b[0], a[1] - b[1]], vadd = (a: Pt, b: Pt) => [a[0] + b[0], a[1] + b[1]], vmul = (a: Pt, k: number) => [a[0] * k, a[1] * k];
export const vunit = (v: Pt) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : [0, 0]; };
