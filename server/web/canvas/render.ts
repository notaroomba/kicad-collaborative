// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { root } from "./env";
import { PCB_BG, PCB_GRID, PCB_GRID_AXES, PCB_PAGE_LIMITS, PCB_SHEET, SCH, SCH_DEFAULT, SCH_Z, parseColor, pcbColor, pcbZ, rgba } from "./colors";
import { atOf, flipH, pointInPoly, ptsOf, splitLines } from "./sexpr";
import { ensureSchTheme } from "./geom";
import { displayNetName } from "./geom-pcb";
import { geomBox } from "./hit";
import { documentDrawingSheet } from "./sheet";
import { TEXT_INTERLINE, lineOffsets, textWidth } from "./text";
import { drawStrokeText, setOverbarHeight, strokeLine, strokeOrigin } from "./stroke-font";
import { hopShapes, strokeHopShape } from "./hop-over";
import { schFormat } from "./geom-sch";
import type { AnyCanvas, Box, CircleGeom, Ctx2D, Doc, DrawTextG, Geom, Item, Marker, Mat, ObjectsOpt, PadGeom, PathSink, RatsLine, RectGeom, RenderOpts, TextGeom, View, ViaRingGeom } from "./types";

/** drawHalo's style: the halo colour (or a function of the geometry's colour), its alpha and the extra stroke width in device px. */
export interface HaloStyle { color: string | ((c: string) => string); alpha: number; extraPx: number; extraMm?: number; strokesOnly?: boolean }
// ---------------------------------------------------------------- rendering
export const HAS_PATH2D = typeof Path2D !== "undefined";

export const FONT_FAMILY = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';

export const FONT_EM = 1.4;
   // cap height ≈ 0.72 em for these faces; KiCad's text size is the cap height
export const FONT_CACHE = new Map<number | string, string>();

/** Lazily built Path2D (mm units) for a geometry; rebuilt geometry objects start without one. */
export function pathOf(g: Geom): Path2D | null {
  if (g._p) return g._p;
  if (!HAS_PATH2D) return null;
  const p = new Path2D(); tracePath(p, g); g._p = p; return p;
}

export function tracePath(ctx: PathSink, g: Geom): void {
  if (g.t === "line") { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
  else if (g.t === "poly") { const pts = g.pts; ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (g.close) ctx.closePath(); }
  else if (g.t === "rect") ctx.rect(g.x, g.y, g.w, g.h);
  else if (g.t === "circle") ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
  else if (g.t === "arc") { if (g.pie) ctx.moveTo(g.x, g.y); ctx.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); if (g.pie) ctx.closePath(); }
  else if (g.t === "pad") tracePad(ctx, g);
}

export function tracePad(ctx: PathSink, g: PadGeom): void {
  const c = Math.cos(-g.rot * Math.PI / 180), s = Math.sin(-g.rot * Math.PI / 180);
  const X = (x: number, y: number) => g.x + x * c - y * s, Y = (x: number, y: number) => g.y + x * s + y * c;
  const w = g.w, h = g.h;
  if (g.shape === "circle") { ctx.moveTo(X(w / 2, 0), Y(w / 2, 0)); ctx.arc(g.x, g.y, Math.max(w, h) / 2, 0, Math.PI * 2); return; }
  const r = g.shape === "oval" ? Math.min(w, h) / 2 : Math.min(g.rr || 0, w / 2, h / 2);
  if (r <= 0) { ctx.moveTo(X(-w / 2, -h / 2), Y(-w / 2, -h / 2)); ctx.lineTo(X(w / 2, -h / 2), Y(w / 2, -h / 2)); ctx.lineTo(X(w / 2, h / 2), Y(w / 2, h / 2)); ctx.lineTo(X(-w / 2, h / 2), Y(-w / 2, h / 2)); ctx.closePath(); return; }
  // rounded rectangle traced with arcs (works for ovals, roundrects and rotated pads alike)
  const a = -g.rot * Math.PI / 180; const hw = w / 2 - r, hh = h / 2 - r;
  ctx.moveTo(X(-hw, -h / 2), Y(-hw, -h / 2));
  ctx.lineTo(X(hw, -h / 2), Y(hw, -h / 2)); ctx.arc(X(hw, -hh), Y(hw, -hh), r, a - Math.PI / 2, a, false);
  ctx.lineTo(X(w / 2, hh), Y(w / 2, hh)); ctx.arc(X(hw, hh), Y(hw, hh), r, a, a + Math.PI / 2, false);
  ctx.lineTo(X(-hw, h / 2), Y(-hw, h / 2)); ctx.arc(X(-hw, hh), Y(-hw, hh), r, a + Math.PI / 2, a + Math.PI, false);
  ctx.lineTo(X(-w / 2, -hh), Y(-w / 2, -hh)); ctx.arc(X(-hw, -hh), Y(-hw, -hh), r, a + Math.PI, a + 3 * Math.PI / 2, false);
  ctx.closePath();
}

/**
 * view: { ppm (css px per mm at zoom 1), zoom, panX, panY (css px), x0, y0 (mm origin), dpr }
 * opts: { hidden: Set(layer keys), grid: pitch mm (0 = off), selected: Set(item ids) }
 *   plus KiCad's display options (all optional, default off):
 *   showHiddenPins (schematic) — draw the pins a library symbol marks hidden, with their names and
 *                                numbers, in the hidden-item grey (they are kept in item.hiddenGeom
 *                                so hit boxes stay as they were);
 *   zoneOutline    (board)     — zones as outlines with their hatch only, no copper fill;
 *   outlinePads, outlineTracks, outlineVias (board) — KiCad's sketch display modes: the pad shapes,
 *                                the track/arc stadium outlines and the via rings are stroked with a
 *                                hairline instead of filled;
 *   activeLayer    (board)     — the layer being worked on is drawn on top, with the other layers of its side
 *                                (PCB_DRAW_PANEL_GAL::SetTopLayer); holes, pad / via names and the ratsnest stay above;
 *   highContrast + activeLayer (board) — high-contrast mode: everything not on `activeLayer` is
 *                                dimmed to HC_DIM alpha (holes stay visible), the active layer is
 *                                drawn at full colour;
 *   highlight      (both)      — Set of item ids (or null): everything else is dimmed to HL_DIM alpha
 *                                and the set is drawn in KiCad's brightened look — LAYER_BRIGHTENED
 *                                (magenta) on schematics, the item's own colour Brightened(0.5) on
 *                                boards — with a translucent halo of that colour around it;
 *   ids            (both)      — Set (or array) of item ids: only those items are drawn (export subsets);
 *   background     (both)      — css colour under the drawing, or false for none (transparent export);
 *                                default: the theme's sheet / board background;
 *   frame          (both)      — false skips KiCad's drawing sheet entirely (subset exports).  Otherwise the
 *                                sheet is drawn under the document from the built-in (kicad_wks …) description
 *                                (web/canvas/sheet.ts): the two frame rectangles on the 10 mm margins, the 2 mm
 *                                tick band with its 50 mm ticks and A/B/C · 1/2/3 labels, the title block and its
 *                                text (${TITLE}, ${REVISION}, ${ISSUE_DATE}, ${PAPER}, ${FILENAME}, ${SHEETPATH},
 *                                ${COMPANY}, ${COMMENT1..4}, ${#}/${##}) resolved from the document, then the
 *                                page outline in the page-limits grey.  Schematics use the schematic sheet colour
 *                                (#840000), boards the board one (#C872AB), exactly as eeschema and pcbnew do;
 *   ratsnest       (board)     — [{net, name, a: [x, y], b: [x, y]}] (mm): unrouted connections drawn like
 *                                RATSNEST_VIEW_ITEM — LAYER_RATSNEST rgba(0,248,255,0.35), 0.5 device px
 *                                hairlines, above copper and holes, below the user layers, markers and the
 *                                selection; a line whose ends coincide becomes the 0.2 mm cross.  With
 *                                netColors the line takes the net's colour;
 *   ratsnestNets   (board)     — Set of net numbers: only those nets' lines are drawn (local ratsnest);
 *   markers        (both)      — [{x, y, severity: "error"|"warning"|"exclusion", text}]: DRC / ERC markers as
 *                                MARKER_BASE::ShapeToPolygon's arrow flag — the MarkerShapeCorners scaled by
 *                                0.1625 mm / √(KiCad zoom factor) on boards (PCB_MARKER::SetZoom) and by a
 *                                constant 0.15 mm on schematics — filled in LAYER_DRC_ERROR/WARNING/EXCLUSION
 *                                or LAYER_ERC_ERR/WARN/EXCLUSION, on top of everything but the selection;
 *                                board markers get the LAYER_MARKER_SHADOWS outline (background @ 0.5, one
 *                                scale unit wide).  markerAt() / markerScale() serve hover look-ups;
 *   netNames       (board)     — net names on tracks per PCB_PAINTER::renderNetNameForSegment: glyph size
 *                                0.55 × track width, pen width/12, centred and rotated along the segment
 *                                (angle normalised to (−90°, 90°]), one label per viewport-width of track,
 *                                skipped when the segment is shorter than width × characters or when the
 *                                track is thinner than 4 mm at KiCad zoom 1 (≈ 14 px) on screen
 *                                (PCB_TRACK::ViewGetLOD); the label is NETNAMES_LAYER_ID_START white @ 0.7,
 *                                inverted on bright copper.  Via names per PCB_PAINTER::draw(PCB_VIA):
 *                                size = min(via, 10 mm), text = min(1.5·size / max(chars, 3 | 6), size) × 0.75
 *                                in LAYER_VIA_NETNAMES rgba(50,50,50,0.9), once the via is ≥ 10 mm at zoom 1
 *                                on screen; blind / micro vias add their "top-bottom" layer pair above the
 *                                name.  Pad numbers and pad net names are unaffected (always drawn);
 *   netColors      (board)     — Map net number → css colour (NET_COLOR_MODE::ALL): tracks, vias, pads and
 *                                zone fills on copper take the net's colour; netclass colours are resolved
 *                                to nets by the caller;
 *   zoneFill       (board)     — fill preview for zones that have no (filled_polygon …) yet: the outline
 *                                filled in the layer colour at KiCad's zone opacity (0.6, "board.opacity.zones")
 *                                minus a clearance ring — (connect_pads (clearance c)), 0.5 mm default —
 *                                around other-net pads, tracks, vias and NPTH holes on the zone's layer,
 *                                cut with destination-out on an offscreen canvas (KiCadCanvas.createCanvas);
 *                                visual only, nothing is written to the document.  Zones that carry
 *                                filled_polygon keep their rendering.  Not modelled: thermal reliefs,
 *                                min_thickness insets, board-edge clearance and zone priorities;
 *   flip           (board)     — KiCad's Flip Board View: X mirrored about the board bbox centre; flipX() /
 *                                unflipX() map pointer coordinates and setViewTransform(ctx, view, doc)
 *                                puts overlays into the same space.  Following PCB_PAINTER, text on
 *                                side-specific layers (F.* / B.*) mirrors with the board (back text becomes
 *                                readable), text on the other layers keeps its box but is re-mirrored to stay
 *                                readable; pad labels and net names are always kept readable;
 *   padNumbers     (board)     — default true; false hides the pad numbers (pad net names stay);
 *   gridAxes       (both)      — GAL's grid axes (window.grid.axes_enabled, off by default): the X and Y axes
 *                                through the document origin in the theme's grid_axes colour, grid shown or not;
 *   gridStyle      (both)      — "dots" (default), "lines" or "crosses" (KiCad's grid.style 0 / 1 / 2); gridMinSpacing
 *                                is the minimum spacing of drawn grid marks in px (default 10);
 *   showHiddenText (board)     — draw the hidden fp_text / properties (kept in item.hiddenGeom, tagged
 *                                hiddenText, outside the hit boxes) at HIDDEN_TEXT_ALPHA; KiCad has no
 *                                painter rule for this (this version dropped LAYER_HIDDEN_TEXT).
 *   layerColors    (board)     — Map layer name → css colour: the user's colour for a layer (Appearance ▸ Layers
 *                                swatch); geometry painted in the layer's theme colour takes it instead.  A
 *                                colour with an alpha (the colour picker's Opacity, { / } on the active layer)
 *                                makes the whole layer translucent, its zones included (COLOR4D::a);
 *   objects        (board)     — { hide: Set, opacity: {…} } keyed by KiCad's Appearance ▸ Objects rows: tracks,
 *                                vias, pads, zones, images (visibility + opacity), filledShapes (opacity),
 *                                each multiplying the item colour's alpha (PCB_RENDER_SETTINGS::GetColor); a
 *                                zones value replaces the ZONE_OPACITY default rather than scaling it,
 *                                fpFront / fpBack (a footprint on that side with all its children, as
 *                                LAYER_FOOTPRINTS_FR/BK), values, references, fpText (footprint text), anchors
 *                                (in `show`: the 5 px LAYER_ANCHOR cross on every footprint origin) and
 *                                lockedShadow (in `show`, with lockedIds: LAYER_LOCKED_ITEM_SHADOW halo);
 *   itemColors     (board)     — Map item id → css colour (tracks, vias, zones) or an array of colours by pad index
 *                                (footprints): net / netclass colours resolved per item by the caller, for boards
 *                                whose nets are named inline rather than numbered (netColors needs net codes);
 *   inactiveHide   (board)     — with highContrast + activeLayer: the inactive layers are not drawn at all
 *                                (Appearance ▸ Layer Display Options ▸ Inactive layers: Hide);
 *   gridColor      (both)      — css colour of the grid dots (LAYER_GRID swatch);
 * Stroke styles: geometry with dashType (dash | dot | dash_dot | dash_dot_dot, from (stroke (type …))) is
 * dashed per STROKE_PARAMS::Stroke with KiCad's ISO 128-2 ratios — dash 11 w, gap 4 w, dot 0.2 w of the drawn
 * line width.  Knockout text (knockout on the geometry) fills its inflated box in the layer colour and
 * cuts the glyphs out in the background colour.
 */
export const GRID_MIN_SPACING = 10, GRID_TICK = 10;   // "grid.min_spacing" (px), GAL::SetCoarseGrid( 10 )

export const HC_DIM = 0.2, HL_DIM = 0.25, HIDDEN_TEXT_ALPHA = 0.5;

export const ZONE_OPACITY = 0.6;
                                        // PCB_DISPLAY_OPTIONS::m_ZoneOpacity ("board.opacity.zones")
export const RATSNEST_COLOR = "rgba(0,248,255,0.35)", RATSNEST_PX = 0.5, RATSNEST_CROSS = 0.2;
   // LAYER_RATSNEST, m_RatsnestThickness, CROSS_SIZE
export const MARKER_CORNERS = [[0, 0], [8, 1], [4, 3], [13, 8], [9, 9], [8, 13], [3, 4], [1, 8]];
   // MARKER_BASE::MarkerShapeCorners
export const MARKER_SCALE: { pcb: number; sch: number } = { pcb: 0.1625, sch: 0.15 };
                 // PCB_MARKER / SCH_MARKER SCALING_FACTOR (mm)
export const MARKER_COLORS: { pcb: Record<string, string>; sch: Record<string, string> } = {
  pcb: { error: "rgba(215,91,107,0.8)", warning: "rgba(255,208,66,0.8)", exclusion: "rgba(255,255,255,0.8)" },   // LAYER_DRC_*
  sch: { error: "rgba(230,9,13,0.8)", warning: "rgba(209,146,0,0.8)", exclusion: "rgba(194,194,194,0.8)" },      // LAYER_ERC_*
};

export const PX_PER_MM_ZOOM1 = 91 * 1e6 * 1e-9 / 0.0254;
                // GAL world scale at zoom factor 1: screen DPI (ADVANCED_CFG 91) × 1 nm in inches, per mm
export const TRACK_NETNAME_MM = 4, VIA_NETNAME_MM = 10, PAD_NETNAME_MM = 0.5;
                 // PCB_TRACK / PCB_VIA::ViewGetLOD netname thresholds
export const VIA_NETNAME_COLOR = "rgba(50,50,50,0.9)", TRACK_NETNAME_LIGHT = "rgba(255,255,255,0.7)", TRACK_NETNAME_DARK = "rgba(0,0,0,0.7)";

export const SIDE_SPECIFIC = /^(F|B)\./;
                                // LSET::SideSpecificMask: the front / back layers
export const HL_CACHE = new Map<string, string>(), NETNAME_COLOR_CACHE = new Map<string, string>();

/** COLOR4D::Brightened(f): every channel c → c·(1−f) + f */
export function brightened(c: string, f: number): string { const [r, g, b, a] = parseColor(c); const k = (v: number) => Math.round(v * (1 - f) + 255 * f); return rgba(k(r), k(g), k(b), a); }

/** The colour of a highlighted item: the board brightens its own colour by the highlight factor (0.5); eeschema paints LAYER_BRIGHTENED. */
export function highlightColor(c: string, isPcb: boolean): string {
  if (!isPcb) return SCH.brightened;
  let v = HL_CACHE.get(c); if (!v) { v = brightened(c, 0.5); HL_CACHE.set(c, v); } return v;
}

/**
 * The colour of a SELECTED board item: RENDER_SETTINGS::update() derives m_layerColorsSel from each layer
 * colour, and PCB_PAINTER::getColor() paints a selected item in it -- there is no shadow or halo on a board.
 * With m_selectFactor 0.5: factor = min(1, 0.25 + brightness^3), colour.Brightened(factor); when that changes
 * the brightness by under 0.05 (near-white layers) fall back to Darkened(0.2) with the blue channel pushed
 * toward 1 by `factor`.  Layers darker than 0.05 keep their colour.  Brightness is 0.299 r + 0.587 g + 0.114 b.
 */
export const SEL_CACHE = new Map<string, string>();
export function selectedColor(c: string): string {
  let v = SEL_CACHE.get(c); if (v) return v;
  const [r, g, b, a] = parseColor(c), R = r / 255, G = g / 255, B = b / 255;
  const bright = (x: number, y: number, z: number) => 0.299 * x + 0.587 * y + 0.114 * z, br = bright(R, G, B);
  if (br < 0.05) v = c;
  else {
    const f = Math.min(1, 0.25 + br * br * br), up = (x: number) => x * (1 - f) + f;
    let sr = up(R), sg = up(G), sb = up(B);
    if (Math.abs(bright(sr, sg, sb) - br) < 0.05) { const d = (x: number) => x * (1 - 0.2); sr = d(R); sg = d(G); sb = B * (1 - f) + f; }
    v = rgba(Math.round(sr * 255), Math.round(sg * 255), Math.round(sb * 255), a);
  }
  SEL_CACHE.set(c, v); return v;
}

/** Fills of a highlighted schematic item: background-layer fills go translucent (SCH_PAINTER: alpha 0.2), the rest take the highlight colour. */
export function highlightFill(g: Geom): string { return g.z !== undefined && g.z < 0 ? "rgba(255,0,255,0.2)" : SCH.brightened; }

/** Track net-name colour for a copper colour: NETNAMES_LAYER_ID_START, inverted when the copper's brightness is above 0.5 (PCB_RENDER_SETTINGS::LoadColors). */
export function trackNameColor(copper: string): string {
  let v = NETNAME_COLOR_CACHE.get(copper);
  if (!v) { const [r, g, b] = parseColor(copper); v = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? TRACK_NETNAME_DARK : TRACK_NETNAME_LIGHT; NETNAME_COLOR_CACHE.set(copper, v); }
  return v;
}

/** STROKE_PARAMS::Stroke dash pattern (mm) for a drawn line width: dash 11 w, gap 4 w, dot 0.2 w (ISO 128-2 ratios 12 / 3, correction 1). */
export const DASH_RATIOS = { dash: 12, gap: 3 };   // the schematic's dashed_lines_dash_length_ratio / gap_length_ratio (Schematic Setup > Formatting)
export function dashPattern(type: string | null | undefined, w: number): number[] {
  const dash = Math.max(DASH_RATIOS.dash - 1, 1) * w, gap = Math.max(DASH_RATIOS.gap + 1, 1) * w, dot = 0.2 * w;
  if (type === "dot") return [dot, gap];
  if (type === "dash_dot") return [dash, gap, dot, gap];
  if (type === "dash_dot_dot") return [dash, gap, dot, gap, dot, gap];
  return [dash, gap];
}

/** KiCad's zoom factor for a view: css px per mm over the GAL's px per mm at zoom 1. */
export function zoomFactor(view: View): number { return (view.ppm * view.zoom) / PX_PER_MM_ZOOM1; }

/** Marker shape scale (mm per corner unit): boards shrink with √zoom (PCB_MARKER::SetZoom), schematics are fixed. */
export function markerScale(docType: string, view: View | null | undefined): number { return docType === "sch" || !view ? MARKER_SCALE[docType === "sch" ? "sch" : "pcb"] : MARKER_SCALE.pcb / Math.sqrt(Math.max(zoomFactor(view), 1e-9)); }

/** The mirror axis of the flipped board view: the board bbox centre. */
export function flipCentre(doc: { bbox?: Box | null } | null | undefined): number { const b = doc && doc.bbox; return b ? (b[0] + b[2]) / 2 : 0; }

/** Document x → x as drawn in the flipped view (an involution: unflipX is the same map, exported for clarity). */
export function flipX(doc: { bbox?: Box | null } | null | undefined, x: number): number { return 2 * flipCentre(doc) - x; }

export function unflipX(doc: { bbox?: Box | null } | null | undefined, x: number): number { return 2 * flipCentre(doc) - x; }

/** Canvas factory for offscreen work (zone previews, renderPng); replace KiCadCanvas.createCanvas to inject one (tests). */
export function defaultCreateCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined" && document.createElement) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  return null;
}

export const makeCanvas = (w: number, h: number): AnyCanvas | null => ((root.KiCadCanvas && root.KiCadCanvas.createCanvas) || defaultCreateCanvas)(w, h);

export let SCRATCH: AnyCanvas | null = null;
   // offscreen canvas reused by the zone previews
export function scratchCanvas(w: number, h: number): AnyCanvas | null {
  if (!SCRATCH) { SCRATCH = makeCanvas(w, h); if (!SCRATCH) return null; }
  if (SCRATCH.width !== w || SCRATCH.height !== h) { SCRATCH.width = w; SCRATCH.height = h; }
  return SCRATCH;
}

export const TOP_Z = 100000, TOP_CACHE = new Map<string, number>();
   // draw-order offset of the layers brought to the top with the active layer
export const BUCKETS = new Map<number, Geom[]>(), NAME_BUCKETS = new Map<number, Geom[]>(), SEL_BUCKETS = new Map<number, Geom[]>();
   // z → geometry, reused frame to frame (cleared, never reallocated)
export const ZS: number[] = [];

export function bucket(map: Map<number, Geom[]>, z: number): Geom[] { let arr = map.get(z); if (!arr) { arr = []; map.set(z, arr); } return arr; }

export function render(doc: Doc, ctx: Ctx2D, view: View, opts?: RenderOpts | null): void {
  ensureSchTheme(doc);   // geometry built under another schematic colour theme is rebuilt first
  opts = opts || {}; const hidden = opts.hidden || new Set();
  const isPcb = doc.type === "pcb";
  setOverbarHeight(isPcb ? 1.23 : schFormat.overbarHeight);   // the board's KIFONT::METRICS are the defaults
  const hops = isPcb ? null : hopShapes(doc);                  // Formatting > Hop-over size
  const showHiddenPins = !!opts.showHiddenPins && doc.type === "sch", zoneOutline = isPcb && !!opts.zoneOutline;
  // hidden fields: pcbnew's hidden texts, eeschema's show_hidden_fields (LAYER_HIDDEN)
  const showHiddenText = !!opts.showHiddenText, padNumbers = opts.padNumbers !== false;
  // eeschema's View-menu options: mark_sim_exclusions and show_directive_labels (both on by default)
  const noSimMarks = !isPcb && opts.markSimExclusions === false, noDirectives = !isPcb && opts.showDirectiveLabels === false;
  const sketchPads = isPcb && !!opts.outlinePads, sketchTracks = isPcb && !!opts.outlineTracks, sketchVias = isPcb && !!opts.outlineVias;
  const hcLayer = isPcb && opts.highContrast && opts.activeLayer ? String(opts.activeLayer) : null;
  const hl = opts.highlight && opts.highlight.size ? opts.highlight : null;
  const hlGeoms = hl ? new Set<Geom>() : null;   // geometry of the highlighted items
  // a net highlight names single pads as "footprintId#padIndex" (PCB_PAINTER brightens by netcode, so the
  // footprint's other pads, its mask / paste openings of other pads and its silk stay dark)
  let hlPadFps: Set<string> | null = null;
  if (hl) for (const k of hl) { const i = typeof k === "string" ? k.indexOf("#") : -1; if (i > 0) (hlPadFps || (hlPadFps = new Set())).add(k.slice(0, i)); }
  // the schematic names single pins ("symbolId#pin:<number>", a sheet's "sheetId#pin:<name>") and the fields a
  // highlighted power symbol brightens ("symbolId#field:Value")
  const subHl = (it: { id: string }, g: Geom) => hl!.has(isPcb ? it.id + "#" + g.padIndex : g.pinNo !== undefined ? it.id + "#pin:" + g.pinNo : g.field ? it.id + "#field:" + g.field : "");
  const selPcb = isPcb && opts.selected && opts.selected.size ? opts.selected : null;   // board selection: repainted, not haloed
  const selGeoms = selPcb ? new Set<Geom>() : null;
  let selPadFps: Set<string> | null = null;   // a pad selected on its own ("footprintId#padIndex"): only that pad is repainted
  if (selPcb) for (const k of selPcb) { const i = typeof k === "string" ? k.indexOf("#") : -1; if (i > 0) (selPadFps || (selPadFps = new Set())).add(k.slice(0, i)); }
  const hlColor = (c: string) => highlightColor(c, isPcb);
  const ids = opts.ids ? (opts.ids instanceof Set ? opts.ids : new Set(opts.ids)) : null;
  const skip = opts.skip && opts.skip.size ? opts.skip : null;   // items a peer is dragging: drawn as ghosts elsewhere
  const netColors = isPcb && opts.netColors && opts.netColors.size ? opts.netColors : null;
  const netNames = isPcb && opts.netNames !== false,   // pcbnew default: net names on pads and tracks ("pcb_display.net_names_mode" 3)
   zoneFill = isPcb && !!opts.zoneFill, flip = isPcb && !!opts.flip;
  const rats = isPcb && opts.ratsnest && opts.ratsnest.length ? opts.ratsnest : null, ratsNets = opts.ratsnestNets || null;
  // eeschema's show_erc_errors / show_erc_warnings (on by default) and show_erc_exclusions (off) filter the markers
  let markers = opts.markers && opts.markers.length ? opts.markers : null;
  if (markers && !isPcb) {
    const ok = (m: Marker) => m.severity === "exclusion" ? opts.showErcExclusions === true : m.severity === "warning" ? opts.showErcWarnings !== false : opts.showErcErrors !== false;
    if (!markers.every(ok)) { markers = markers.filter(ok); if (!markers.length) markers = null; }
  }
  const layerColors = isPcb && opts.layerColors && opts.layerColors.size ? opts.layerColors : null;
  const obj = isPcb && opts.objects ? opts.objects : null, objHide = obj && obj.hide && obj.hide.size ? obj.hide : null, objAlpha = obj && obj.opacity ? obj.opacity : null;
  const hcHide = !!opts.inactiveHide;
  // PCB_RENDER_SETTINGS::GetColor: a zone's colour alpha times m_zoneOpacity ("board.opacity.zones", 0.6 by default);
  // the Appearance ▸ Objects ▸ Zones slider sets it outright
  const zoneA = objAlpha && typeof objAlpha.zones === "number" ? Math.max(0, Math.min(1, objAlpha.zones)) : ZONE_OPACITY;
  // ... except a teardrop area, which takes m_trackOpacity (and no zone opacity)
  const trackA = objAlpha && typeof objAlpha.tracks === "number" ? Math.max(0, Math.min(1, objAlpha.tracks)) : 1;
  // PCB_RENDER_SETTINGS::LoadColors: a board layer colour is drawn with an alpha of 0.2 at least ("if the alpha
  // channel is too small, the layer is not visible"); the stored colour keeps what the user set
  const layerDraw = layerColors ? new Map<string, string>() : null;
  if (layerColors) for (const [k, c] of layerColors) layerDraw!.set(k, minLayerAlpha(c));
  const itemColors = isPcb && opts.itemColors && opts.itemColors.size ? opts.itemColors : null, tint = itemColors ? new Map<Geom, string>() : null;
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = view.dpr || 1;
  const s = view.ppm * view.zoom * dpr;                 // device px per mm
  const sCss = view.ppm * view.zoom;                    // css px per mm (KiCad's LOD rules work in logical pixels)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // region: [x0, y0, x1, y1] device px — repaint only that part of the canvas (the editor's pan strips); the
  // pixels drawn there are the full render's, the rest of the canvas is left alone
  const region = opts.region || null;
  if (region) { ctx.save(); ctx.beginPath(); ctx.rect(region[0], region[1], region[2] - region[0], region[3] - region[1]); ctx.clip(); }
  const bg = opts.background === undefined ? (doc.type === "sch" ? SCH.bg : PCB_BG) : opts.background;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); } else if (!opts.overlay && typeof ctx.clearRect === "function") ctx.clearRect(0, 0, W, H);
  const tx = view.panX * dpr - view.x0 * s, ty = view.panY * dpr - view.y0 * s;
  // base transform (document mm → device px); the flipped view mirrors X about the board centre
  const cx = flip ? flipCentre(doc) : 0;
  const A = flip ? -s : s, E = flip ? tx + 2 * cx * s : tx;
  ctx.setTransform(A, 0, 0, s, E, ty);
  const dx0 = -E / A, dx1 = (W - E) / A;
  const fx0 = Math.min(dx0, dx1), fx1 = Math.max(dx0, dx1), fy0 = -ty / s, fy1 = fy0 + H / s;   // visible mm rect
  // the rect geometry is culled against: the visible one, or the repainted region (plus a margin for strokes
  // and labels that reach into it from outside)
  let vx0 = fx0, vx1 = fx1, vy0 = fy0, vy1 = fy1;
  if (region) {
    const m = 48, rx0 = (region[0] - m - E) / A, rx1 = (region[2] + m - E) / A;
    vx0 = Math.max(fx0, Math.min(rx0, rx1)); vx1 = Math.min(fx1, Math.max(rx0, rx1));
    vy0 = Math.max(fy0, (region[1] - m - ty) / s); vy1 = Math.min(fy1, (region[3] + m - ty) / s);
  }
  // grid: GAL::DrawGrid.  The pitch is multiplied by the coarse tick (10) until grid marks are more than
  // grid.min_spacing (10 px; 20 for small crosses) apart; every 10th row / column of the drawn grid is major:
  // twice the dot size, line width or cross size.  Styles: "dots" (KiCad's default), "lines", "crosses".
  if (opts.grid! > 0) {   // undefined > 0 is false: no grid
    const style = opts.gridStyle === "lines" || opts.gridStyle === "crosses" ? opts.gridStyle : "dots";
    const minSpacing = (opts.gridMinSpacing! > 0 ? opts.gridMinSpacing! : GRID_MIN_SPACING) * (style === "crosses" ? 2 : 1) / sCss;
    let pitch = opts.grid!; let guard = 0;
    while (pitch <= minSpacing && guard++ < 12) pitch *= GRID_TICK;
    const go = opts.gridOrigin || [0, 0], gx = go[0], gy = go[1];   // BOARD_DESIGN_SETTINGS::m_GridOrigin: the grid is laid out from it
    const i0 = Math.floor((vx0 - gx) / pitch), i1 = Math.ceil((vx1 - gx) / pitch), j0 = Math.floor((vy0 - gy) / pitch), j1 = Math.ceil((vy1 - gy) / pitch);
    const px1 = Math.max(1, dpr) / s;   // one device pixel (grid.line_width 1.0)
    const gridColor = opts.gridColor || (isPcb ? PCB_GRID : SCH.grid);
    if ((Math.ceil((fx1 - gx) / pitch) - Math.floor((fx0 - gx) / pitch)) * (Math.ceil((fy1 - gy) / pitch) - Math.floor((fy0 - gy) / pitch)) < 400000) {   // the whole view's count, region or not
      if (style === "dots") {
        ctx.fillStyle = gridColor; ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const wdt = i % GRID_TICK === 0 ? 2 * px1 : px1, x = (i * pitch + gx) - wdt / 2;
          for (let j = j0; j <= j1; j++) { const hgt = j % GRID_TICK === 0 ? 2 * px1 : px1; ctx.rect(x, (j * pitch + gy) - hgt / 2, wdt, hgt); }
        }
        ctx.fill();
      } else if (style === "lines") {
        ctx.strokeStyle = gridColor; ctx.lineCap = "butt";
        for (const major of [false, true]) {
          ctx.lineWidth = major ? 2 * px1 : px1; ctx.beginPath();
          for (let i = i0; i <= i1; i++) if ((i % GRID_TICK === 0) === major) { ctx.moveTo((i * pitch + gx), vy0); ctx.lineTo((i * pitch + gx), vy1); }
          for (let j = j0; j <= j1; j++) if ((j % GRID_TICK === 0) === major) { ctx.moveTo(vx0, (j * pitch + gy)); ctx.lineTo(vx1, (j * pitch + gy)); }
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = gridColor; ctx.lineCap = "butt";
        for (const major of [false, true]) {
          const wdt = major ? 2 * px1 : px1, len = 2 * wdt; ctx.lineWidth = wdt; ctx.beginPath();
          for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            if ((i % GRID_TICK === 0 && j % GRID_TICK === 0) !== major) continue;
            const x = (i * pitch + gx), y = (j * pitch + gy); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
          }
          ctx.stroke();
        }
      }
    }
  }
  // GAL::DrawGrid draws the axes before it looks at the grid's visibility: one grid line wide, through 0,0
  if (opts.gridAxes) {
    const px1 = Math.max(1, dpr) / s;
    ctx.strokeStyle = opts.gridAxesColor || (isPcb ? PCB_GRID_AXES : SCH.gridAxes); ctx.lineWidth = px1; ctx.lineCap = "butt"; ctx.beginPath();
    if (vy0 <= 0 && vy1 >= 0) { ctx.moveTo(vx0, 0); ctx.lineTo(vx1, 0); }
    if (vx0 <= 0 && vx1 >= 0) { ctx.moveTo(0, vy0); ctx.lineTo(0, vy1); }
    ctx.stroke();
  }
  // the drawing sheet (frame, tick band, title block) and, above it, the page outline.  Under the
  // flipped board view KiCad mirrors the sheet back about the page — "Draw the title block normally
  // even if the view is flipped" (ds_proxy_view_item.cpp:114-128) — so it is drawn unflipped here.
  if (opts.frame !== false && !(doc as { fpEditor?: boolean }).fpEditor) {   // the Footprint Editor has no drawing sheet
    if (flip) ctx.setTransform(s, 0, 0, s, tx, ty);
    drawDrawingSheet(ctx, doc, s, Math.max(1, dpr) / s);
    if (flip) ctx.setTransform(A, 0, 0, s, E, ty);
  }
  // collect visible geometry into the z buckets (arrays reused across frames)
  for (const arr of BUCKETS.values()) arr.length = 0;
  for (const arr of NAME_BUCKETS.values()) arr.length = 0;
  const obstacles: Geom[] | null = zoneFill ? [] : null, previews: Geom[] | null = zoneFill ? [] : null;
  const copperZ = isPcb ? (doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]) : null;
  // PCB_DRAW_PANEL_GAL::SetTopLayer: the active layer is brought to the top — a copper layer together with its
  // zone / pad / via / netname layers, and with it every layer of its side (F.* or B.*); the holes, the pad and
  // via names and the ratsnest are always on top.  A non-copper active layer goes above those too.  The layers
  // keep their order among themselves (VIEW::TOP_LAYER_MODIFIER), so this is one offset per layer.
  const act = isPcb && opts.activeLayer ? String(opts.activeLayer) : null;
  const actSide = act ? (act.indexOf("F.") === 0 ? "F." : act.indexOf("B.") === 0 ? "B." : null) : null, actCu = !!act && /\.Cu$/.test(act);
  const zHoles0 = isPcb ? pcbZ("holes") : 0;
  TOP_CACHE.clear();
  const topOf = (layer: string) => {
    if (!act) return 0;
    let v = TOP_CACHE.get(layer);
    if (v === undefined) { v = layer === "holes" ? TOP_Z : layer === act ? (actCu ? TOP_Z : 2 * TOP_Z) : actSide && layer && layer.indexOf(actSide) === 0 ? TOP_Z : 0; TOP_CACHE.set(layer, v); }
    return v;
  };
  const zOf = (g: Geom) => { const z = g.z === undefined ? 0 : g.z; return isPcb ? z + topOf(z >= zHoles0 && z < zHoles0 + 10 ? "holes" : g.layer) : z; };
  const zHoles = zHoles0 + topOf("holes"), zRats = zHoles + 2, zViaName = zHoles + 1.5;
  // the schematic selection: SCH_SELECTION_TOOL::highlight hides a selected item from its own layers and draws it
  // from the selection VIEW_GROUP (LAYER_SELECT_OVERLAY), over every unselected item; so its geometry is bucketed
  // apart and drawn after the rest, its selection shadow first.  "id#pin:N" / "id#field:Name" lift that part alone.
  const schSel: string[] | null = !isPcb && opts.selected && opts.selected.size ? (skip ? [...opts.selected].filter((id) => !skip.has(id)) : [...opts.selected]) as string[] : null;
  let selWhole: Set<string> | null = null, selParts: Map<string, Set<string>> | null = null;
  if (schSel) {
    selWhole = new Set();
    for (const k of schSel) {
      const i = typeof k === "string" ? k.indexOf("#") : -1;
      if (i < 0) { selWhole.add(k); continue; }
      const id = k.slice(0, i), sub = k.slice(i + 1); if (!sub.startsWith("pin:") && !sub.startsWith("field:")) continue;
      let set = (selParts || (selParts = new Map<string, Set<string>>())).get(id); if (!set) selParts.set(id, set = new Set<string>()); set.add(sub);
    }
  }
  for (const arr of SEL_BUCKETS.values()) arr.length = 0;
  // SCH_PAINTER::draw( SCH_TEXT ): a label with a bus connection (HasBusConnection) takes the bus colour
  const busLabels = isPcb ? null : busConnectedLabels(doc);
  let schTint: Map<Geom, string> | null = null;
  const cullM = 4 * Math.max(1, dpr) / s + 0.1; const cx0 = vx0 - cullM, cx1 = vx1 + cullM, cy0 = vy0 - cullM, cy1 = vy1 + cullM;   // per-geometry cull rect: the view plus 4 px
  for (const it of doc.items.values()) {
    if ((ids && !ids.has(it.id)) || (skip && skip.has(it.id))) continue;
    const b = it.bbox; if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    const isHl = hl ? hl.has(it.id) : false;
    const lift = selWhole ? selWhole.has(it.id) : false, liftParts = selParts ? selParts.get(it.id) || null : null;
    if (noDirectives && it.kind === "directive_label" && !lift) continue;   // SCH_PAINTER: unless it is selected
    const busTint = busLabels && busLabels.has(it.id);
    const padHl = !isHl && hlPadFps && hlPadFps.has(it.id) ? it.id + "#" : null;   // highlighted pads of this footprint
    const isSel = selPcb ? selPcb.has(it.id) : false;
    const padSel = !isSel && selPadFps && selPadFps.has(it.id) ? it.id + "#" : null;
    const itemTint = itemColors ? itemColors.get(it.id) : null;
    const isFp = objHide && it.kind === "footprint";
    if (isFp && objHide.has(it.layer && /^B\./.test(it.layer) ? "fpBack" : "fpFront")) continue;
    // an item that only partly shows (a long connector, a zone's hatch, a big footprint when zoomed in) is
    // culled geometry by geometry; the boxes are cached on the geometry records (rebuilt with the item)
    const partial = !zoneFill && b && it.geom.length > 6 && (b[0] < cx0 || b[2] > cx1 || b[1] < cy0 || b[3] > cy1);
    for (const g of it.geom) {
      if (partial && g.t !== "image") {
        const bb = g._bb === undefined ? (g._bb = geomBox(g)) : g._bb;
        if (bb && (bb[2] < cx0 || bb[0] > cx1 || bb[3] < cy0 || bb[1] > cy1)) continue;
      }
      if (g.padText) {
        // PAD::ViewGetLOD (netname layer): the pad must be flashed on a visible layer (the high-contrast one in
        // that mode) and its smaller side at least 0.5 mm at zoom 1; pad net names follow the net-names option
        if (g.padNum ? !padNumbers : !netNames) continue;
        if ((g as TextGeom).padMin! * sCss < PAD_NETNAME_MM * PX_PER_MM_ZOOM1) continue;   // pad labels are text records with both set
        const pl = (g as TextGeom).padLayers!; let vis = false;
        if (hcLayer) vis = pl.indexOf(hcLayer) >= 0; else for (let i = 0; i < pl.length; i++) if (!hidden.has(pl[i])) { vis = true; break; }
        if (!vis) continue;
      } else {
        if (hidden.has(g.layer) || (zoneOutline && g.zoneFill)) continue;
        if (hcHide && hcLayer && g.layer !== hcLayer && g.layer !== "holes") continue;   // inactive layers: Hide
      }
      if (noSimMarks && g.simMarker) continue;
      if (busTint && g.layer === "Labels") (schTint || (schTint = new Map())).set(g, SCH.bus);
      if (objHide) {
        const oc = objectClass(g);
        if (oc && objHide.has(oc)) continue;
        if (isFp && g.t === "text" && !g.pad && (objHide.has("fpText") || (g.field === "Reference" && objHide.has("references")) || (g.field === "Value" && objHide.has("values")))) continue;
      }
      const z = zOf(g);
      bucket(lift || (liftParts && liftParts.has(g.pinNo !== undefined ? "pin:" + g.pinNo : g.field ? "field:" + g.field : "")) ? SEL_BUCKETS : BUCKETS, z).push(g);
      if (itemTint && !g.hole && (g.track || g.via || g.zoneFill || (g.pad && g.t !== "text"))) { const tc = typeof itemTint === "string" ? itemTint : itemTint[g.padIndex!]; if (tc) tint!.set(g, tc); }
      if (isHl || (padHl && (isPcb ? g.padIndex !== undefined : true) && subHl(it, g))) hlGeoms!.add(g);
      if (isSel || (padSel && g.padIndex !== undefined && selPcb!.has(padSel + g.padIndex))) selGeoms!.add(g);
      if (netNames && g.net! > 0) {
        if (g.track && !sketchTracks) bucket(NAME_BUCKETS, pcbZ(g.layer) + 3.5 + topOf(g.layer)).push(g);
        else if (g.viaLabel) bucket(NAME_BUCKETS, zViaName).push(g);
      }
      if (zoneFill) {
        if (g.zoneUnfilled) previews!.push(g);
        else if (g.track || (g.via && !g.hole && (g.viaType !== "through" || g.viaLabel)) || g.npth || (g.pad && !g.hole && g.t !== "text")) obstacles!.push(g);   // a through via cuts every layer once (its label ring stands for it)
      }
    }
    if (it.hiddenGeom && (showHiddenPins || showHiddenText)) for (const g of it.hiddenGeom) {
      if (hidden.has(g.layer) || (g.hiddenText ? !showHiddenText : !showHiddenPins)) continue;
      const z = zOf(g);
      bucket(lift || (liftParts && liftParts.has(g.pinNo !== undefined ? "pin:" + g.pinNo : g.field ? "field:" + g.field : "")) ? SEL_BUCKETS : BUCKETS, z).push(g);
      if (isHl || (padHl && !isPcb && subHl(it, g))) hlGeoms!.add(g);
    }
  }
  ZS.length = 0;
  for (const [z, arr] of BUCKETS) if (arr.length) ZS.push(z);
  for (const [z, arr] of NAME_BUCKETS) if (arr.length && !BUCKETS.has(z)) ZS.push(z);
  if (rats) ZS.push(zRats);
  if (previews && previews.length) { previews.sort((a, b) => zOf(a) - zOf(b)); for (const g of previews) { const z = zOf(g) - 1.5 - 0.01; if (ZS.indexOf(z) < 0) ZS.push(z); } }
  ZS.sort((a, b) => a - b);
  const minW = Math.max(1, dpr) / s;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  let curStroke: string | null = null, curFill: string | null = null, curWidth = -1, curAlpha = -1, curCap = "round";
  // a record without a colour leaves the style as the context takes it (the assignment is ignored), as it always has
  const setStroke = (c: string | null | undefined) => { if (c !== curStroke) { ctx.strokeStyle = c as string; curStroke = c as string; } };
  const setFill = (c: string | null | undefined) => { if (c !== curFill) { ctx.fillStyle = c as string; curFill = c as string; } };
  const setWidth = (w: number) => { if (w !== curWidth) { ctx.lineWidth = w; curWidth = w; } };
  const setAlpha = (a: number) => { if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; } };
  const setCap = (c: string) => { if (c !== curCap) { ctx.lineCap = c as CanvasLineCap; curCap = c; } };
  const rec = !!(ctx as unknown as { __plot?: boolean }).__plot;   // a plot recorder (plot-rec.ts) reads paths, not Path2D objects
  const strokeG = (g: Geom) => { const p = rec ? null : pathOf(g); if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); } };
  const fillG = (g: Geom) => { const p = rec ? null : pathOf(g); if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } };
  const base = [A, 0, 0, s, E, ty]; const viewRect = [fx0, fy0, fx1, fy1];
  const dirty = () => { curStroke = curFill = null; curWidth = -1; curCap = "round"; curAlpha = -1; };
  let ratsDone = !rats, previewIdx = 0;
  // selection: eeschema draws a selected item's shadow (LAYER_SELECTION_SHADOWS) under it, so the strokes stay on
  // top and only a glow shows around them; pcbnew repaints the item in its selected colour instead (drawOne)
  const anchors = schSel ? fieldAnchors(doc, schSel, hidden, opts.dangling, opts.moving) : null;
  // one geometry record; `lifted`: part of the schematic selection, whose background fills (symbol body, sheet,
  // filled shape / text box backgrounds) getRenderColor draws WithAlpha( 0.5 )
  const drawOne = (g: Geom, lifted: boolean): void => {
    let alpha = g.alpha === undefined ? 1 : g.alpha;
    if (lifted && (g.z || 0) < 0 && ((g.noStroke && g.fill) || g.noShadow)) alpha *= 0.5;
    if (hcLayer && g.layer !== hcLayer && g.layer !== "holes" && !g.padText) alpha *= HC_DIM;
    if (g.zoneFill) alpha *= g.teardrop ? trackA : zoneA;   // PCB_RENDER_SETTINGS::GetColor: color.a *= m_zoneOpacity (m_trackOpacity for a teardrop)
    if (g.hiddenText && isPcb) alpha *= HIDDEN_TEXT_ALPHA;
    let color = g.color, fill = g.fill;
    if (objAlpha && !g.zoneFill) { const oc = g.teardrop ? "tracks" : objectClass(g) || (fill && g.t !== "text" && !g.hole ? "filledShapes" : null); const oa = oc ? objAlpha[oc] : undefined; if (oa !== undefined && oa < 1) alpha *= oa; }
    if (layerDraw && !g.hole) { const lc = layerDraw.get(g.layer); if (lc) { const def = pcbColor(g.layer); if (color === def) color = lc; if (fill === def) fill = lc; } }
    if (netColors && g.net! > 0 && (g.track || g.via || g.pad || g.zoneFill) && !g.hole && copperZ!.indexOf(g.layer) >= 0) { const nc = netColors.get(g.net!); if (nc) { color = nc; if (fill) fill = nc; } }
    if (tint) { const tc = tint.get(g); if (tc && copperZ!.indexOf(g.layer) >= 0) { color = tc; if (fill) fill = tc; } }
    if (schTint) { const tc = schTint.get(g); if (tc) color = tc; }   // a label on a bus: LAYER_BUS
    // board selection: the item repainted in its layer's selected colour (PCB_PAINTER::getColor), holes untouched
    if (selPcb && selGeoms!.has(g) && !g.hole) { color = selectedColor(color!); if (fill) fill = selectedColor(fill); }
    if (hl) { if (hlGeoms!.has(g)) { color = hlColor(color!); if (fill) fill = isPcb ? hlColor(fill) : highlightFill(g); } else if (isPcb) alpha *= HL_DIM; }
    setAlpha(alpha);
    const t = g.t;
    if (t === "text") { drawText(ctx, g, s, doc.type, minW, color, base, flip, bg || PCB_BG); curStroke = curFill = null; curWidth = -1; curCap = "round"; return; }
    if (t === "image") {
      const e = g.entry;
      // PCB_PAINTER: translate to the centre, rotate by -orientation, the opacity as the alpha
      const turned = !!g.rot, faded = g.opacity != null && g.opacity < 1;
      if (turned || faded) ctx.save();
      if (faded) ctx.globalAlpha *= g.opacity!;
      if (turned) { const cx = g.x + g.w / 2, cy = g.y + g.h / 2; ctx.translate(cx, cy); ctx.rotate(-g.rot! * Math.PI / 180); ctx.translate(-cx, -cy); }
      if (e && e.loaded && !e.failed && e.img && typeof ctx.drawImage === "function") {
        // the decoded pixel size wins over the header estimate, keeping the centre
        const w = e.w > 0 ? e.w * g.pxMm * g.scale : g.w, h = e.h > 0 ? e.h * g.pxMm * g.scale : g.h;
        ctx.drawImage(e.img, g.x + (g.w - w) / 2, g.y + (g.h - h) / 2, w, h);
      } else {
        // not decoded (yet): KiCad has no placeholder, so a dashed hairline frame with a cross marks the bitmap's footprint
        setStroke(color); setWidth(minW); setCap("butt"); ctx.setLineDash([0.6, 0.4]);
        ctx.strokeRect(g.x, g.y, g.w, g.h);
        ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x + g.w, g.y + g.h); ctx.moveTo(g.x + g.w, g.y); ctx.lineTo(g.x, g.y + g.h); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (turned || faded) ctx.restore();
      return;
    }
    // LAYER_VIA_HOLEWALLS under the hole; PCB_PAINTER underpaints it filled in the outline mode too
    // (only via holes, which are circles, carry wallR)
    if (g.wallR && ((g.wallR - (g as CircleGeom).r) * s > 0.35)) { setFill(g.wallColor!); ctx.beginPath(); ctx.arc((g as CircleGeom).x, (g as CircleGeom).y, g.wallR, 0, Math.PI * 2); ctx.fill(); }
    if ((sketchPads && g.pad) || (sketchVias && g.via)) {   // sketch mode: the shape's outline in a hairline, nothing filled
      if (t === "poly" && g.pts.length < 2) return;
      setStroke(color); setWidth(minW); setCap("butt"); strokeG(g); return;
    }
    if (sketchTracks && g.track) { setStroke(color); setWidth(minW); setCap("butt"); ctx.beginPath(); traceTrackOutline(ctx, g); ctx.stroke(); return; }
    if (t === "rect") {
      if (fill) { setFill(fill); ctx.fillRect(g.x, g.y, g.w, g.h); }
      if (!g.noStroke) {
        setStroke(color); const lw = Math.max(g.wd || 0, minW); setWidth(lw);
        if (g.dash) ctx.setLineDash(dashPattern(g.dashType, lw));
        ctx.strokeRect(g.x, g.y, g.w, g.h);
        if (g.dash) ctx.setLineDash([]);
      }
      return;
    }
    if (t === "poly" && g.pts.length < 2) return;
    if (fill) { setFill(fill); fillG(g); }
    if (g.noStroke) return;
    if (t === "line" || t === "arc" || (t === "poly" && (g.w > 0 || !fill)) || (t === "circle" && (g.w > 0 || !fill)) || (t === "pad" && !fill)) {
      setStroke(color); const lw = Math.max(g.w, minW); setWidth(lw); setCap(g.cap || (t === "poly" || t === "line" ? "round" : "butt"));
      const hop = hops && t === "poly" ? hops.get(g) : undefined;
      if (hop) { strokeHopShape(ctx, hop, g.dash ? dashPattern(g.dashType, lw) : null); return; }   // the runs dashed, the hop arcs solid
      if (g.dash) ctx.setLineDash(dashPattern(g.dashType, lw));
      strokeG(g);
      if (g.dash) ctx.setLineDash([]);
    }
  };
  for (const z of ZS) {
    // overlay passes that sit at this depth
    if (!ratsDone && zRats <= z) { drawRatsnest(ctx, rats!, ratsNets, netColors, s, dpr, viewRect); ratsDone = true; dirty(); }
    if (previews) while (previewIdx < previews.length && zOf(previews[previewIdx]) - 1.5 - 0.01 <= z) { const pg = previews[previewIdx++]; drawZonePreview(ctx, pg, obstacles!, base, W, H, minW, netColors, ((pg.teardrop ? trackA : zoneA) / ZONE_OPACITY) * (hcLayer && pg.layer !== hcLayer ? HC_DIM : 1) * (hl && !hlGeoms!.has(pg) ? HL_DIM : 1)); dirty(); }
    const arr = BUCKETS.get(z);
    if (arr) for (const g of arr) drawOne(g, false);
    const names = NAME_BUCKETS.get(z);
    if (names && names.length) {
      for (const g of names) {
        let alpha = 1; if (hcLayer && g.layer !== hcLayer) continue;   // PCB_TRACK::ViewGetLOD: no names on dimmed tracks
        if (hl && !hlGeoms!.has(g)) alpha *= HL_DIM;
        setAlpha(alpha);
        if (g.track) drawTrackName(ctx, g, doc, s, sCss, viewRect, base, flip); else drawViaName(ctx, g as ViaRingGeom, doc, s, sCss, base, flip);   // the via rings that carry the label
      }
      dirty();
    }
  }
  if (!ratsDone) { drawRatsnest(ctx, rats!, ratsNets, netColors, s, dpr, viewRect); }
  if (previews) while (previewIdx < previews.length) { const pg = previews[previewIdx++]; drawZonePreview(ctx, pg, obstacles!, base, W, H, minW, netColors, ((pg.teardrop ? trackA : zoneA) / ZONE_OPACITY) * (hcLayer && pg.layer !== hcLayer ? HC_DIM : 1) * (hl && !hlGeoms!.has(pg) ? HL_DIM : 1)); }
  ctx.globalAlpha = 1;
  if (obj && obj.show) drawObjectOverlays(ctx, doc, obj, opts, s, dpr, hidden, [vx0, vy0, vx1, vy1]);
  // the Footprint Editor's footprint sits at the origin: its anchor is the LAYER_ANCHOR cross there
  if ((doc as { fpEditor?: boolean }).fpEditor && !(obj && obj.hide && obj.hide.has("anchors"))) {
    const a = 5 * Math.max(1, dpr) / s;
    ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.strokeStyle = ANCHOR_COLOR; ctx.lineWidth = Math.max(1, dpr) / s; ctx.beginPath();
    ctx.moveTo(-a, 0); ctx.lineTo(a, 0); ctx.moveTo(0, -a); ctx.lineTo(0, a); ctx.stroke(); ctx.restore();
  }
  // highlight: the brightened items get a translucent halo of the highlight colour (the schematic's LAYER_SELECTION_SHADOWS pass for brightened items)
  if (hl) drawHalo(ctx, doc, skip ? new Set([...hl].filter((id) => !skip.has(id))) : hl, s, dpr, hidden, { color: hlColor, alpha: isPcb ? 0.35 : 0.15, extraPx: isPcb ? 3 : SCH_HIGHLIGHT_THICKNESS, strokesOnly: !isPcb });   // skipped items (drawn elsewhere) get none
  if (schSel) {
    // the selection VIEW_GROUP, over everything else, its layers in SCH_LAYER_ORDER: the backgrounds (bitmaps,
    // shape / symbol / sheet / note fills), then LAYER_SELECTION_SHADOWS, then the items' strokes, then their anchors
    const sz: number[] = []; for (const [z, arr] of SEL_BUCKETS) if (arr.length) sz.push(z);
    sz.sort((a, b) => a - b);
    const bgZ = (z: number) => z === SCH_Z.bitmap || z === SCH_Z.sheetBg || z === SCH_Z.notesBg || z === SCH_Z.deviceBg;
    ctx.setTransform(A, 0, 0, s, E, ty); dirty();
    for (const z of sz) if (bgZ(z)) for (const g of SEL_BUCKETS.get(z)!) drawOne(g, true);
    ctx.globalAlpha = 1; ctx.setTransform(A, 0, 0, s, E, ty);
    drawSelectionHalo(ctx, doc, schSel, s, dpr, hidden);
    drawLineEndShadows(ctx, doc, schSel, s, dpr);
    if (anchors) drawFieldAnchors(ctx, anchors, s, dpr, true);
    ctx.setTransform(A, 0, 0, s, E, ty); dirty();
    for (const z of sz) if (!bgZ(z)) for (const g of SEL_BUCKETS.get(z)!) drawOne(g, true);
    ctx.globalAlpha = 1; ctx.setTransform(A, 0, 0, s, E, ty);
    if (anchors) drawFieldAnchors(ctx, anchors, s, dpr, false);   // LAYER_SCHEMATIC_ANCHOR, over the items
  }
  // DRC / ERC markers: above everything but the selection (GAL_LAYER_ORDER: LAYER_SELECT_OVERLAY, then LAYER_DRC_*)
  if (markers) drawMarkers(ctx, markers, doc.type, markerScale(doc.type, view), bg || (isPcb ? PCB_BG : SCH.bg));
  if (region) ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The labels attached to a bus: a local, global or hierarchical label whose connection point lies on a bus segment
 * (SCH_LABEL_BASE::HasBusConnection, the label then drives the bus's subgraph).  Cached while the bus and label
 * geometry is unchanged.
 */
const BUS_LABELS = new WeakMap<object, { key: unknown[]; ids: Set<string> }>();
export function busConnectedLabels(doc: Doc): Set<string> | null {
  const buses: Item[] = [], labels: Item[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "bus") buses.push(it);
    else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") labels.push(it);
  }
  if (!buses.length || !labels.length) return null;
  const key: unknown[] = []; for (const it of buses) key.push(it.geom); for (const it of labels) key.push(it.geom);
  const hit = BUS_LABELS.get(doc);
  if (hit && hit.key.length === key.length && hit.key.every((k, i) => k === key[i])) return hit.ids;
  const ids = new Set<string>();
  const segs: number[][] = [];
  for (const b of buses) { const pts = ptsOf(b.node); for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]); }
  for (const lb of labels) {
    const a = atOf(lb.node), x = a[0], y = a[1];
    for (const [x1, y1, x2, y2] of segs) {
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
      if (Math.hypot(x1 + t * dx - x, y1 + t * dy - y) <= 1e-4) { ids.add(lb.id); break; }
    }
  }
  BUS_LABELS.set(doc, { key, ids });
  return ids;
}

/** A layer colour as PCB_RENDER_SETTINGS::LoadColors draws it: an alpha below 0.2 is raised to 0.2. */
export function minLayerAlpha(c: string): string {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(c);
  if (m) return +m[4] < 0.2 ? `rgba(${m[1]},${m[2]},${m[3]},0.2)` : c;
  const h = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c);
  return h && parseInt(h[2], 16) < 51 ? "#" + h[1] + "33" : c;
}

/** Which Appearance ▸ Objects row a geometry belongs to (null: governed by its layer alone). */
export function objectClass(g: Geom): string | null {
  return g.track ? "tracks" : g.via ? "vias" : g.pad ? "pads" : (g.zoneFill || g.zoneOutline || g.zoneUnfilled) ? "zones" : g.t === "image" ? "images" : null;
}

export const ANCHOR_COLOR = "#FF26E2", LOCKED_SHADOW_COLOR = "rgba(255,38,226,0.5)";
   // LAYER_ANCHOR, LAYER_LOCKED_ITEM_SHADOW (builtin_color_themes.h)
/** The overlay object layers: the locked-item shadow (under the anchors) and the footprint anchors — PCB_PAINTER::draw(FOOTPRINT, LAYER_ANCHOR): a 5 px cross, 1 px pen. */
export function drawObjectOverlays(ctx: Ctx2D, doc: Doc, obj: ObjectsOpt, opts: RenderOpts, s: number, dpr: number, hidden: Set<string> | null, vr: number[]): void {
  const show = obj.show!, hide = obj.hide || new Set<string>();   // called only when obj.show is set
  if (show.has("lockedShadow") && opts.lockedIds && opts.lockedIds.size) drawHalo(ctx, doc, opts.lockedIds, s, dpr, hidden, { color: () => "#FF26E2", alpha: 0.5, extraPx: 4 });
  if (show.has("anchors")) {
    const a = 5 * Math.max(1, dpr) / s;
    ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.strokeStyle = ANCHOR_COLOR; ctx.lineWidth = Math.max(1, dpr) / s; ctx.beginPath();
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint" || it.x === undefined) continue;
      if (hide.has(it.layer && /^B\./.test(it.layer) ? "fpBack" : "fpFront")) continue;
      // a footprint's anchor: x and y are set together by buildFootprintGeom
      if (it.x < vr[0] - a || it.x > vr[2] + a || it.y! < vr[1] - a || it.y! > vr[3] + a) continue;
      ctx.moveTo(it.x - a, it.y!); ctx.lineTo(it.x + a, it.y!); ctx.moveTo(it.x, it.y! - a); ctx.lineTo(it.x, it.y! + a);
    }
    ctx.stroke(); ctx.restore();
  }
}

/** RATSNEST_VIEW_ITEM::ViewDraw: hairlines in LAYER_RATSNEST (or the net colour), a cross where both ends coincide. */
export function drawRatsnest(ctx: Ctx2D, lines: RatsLine[], nets: Set<number> | null, netColors: Map<number, string> | null, s: number, dpr: number, vr: number[]): void {
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.lineWidth = RATSNEST_PX * Math.max(1, dpr) / s;
  let cur: string | null = null; const c = RATSNEST_CROSS;
  const flush = () => { if (cur !== null) ctx.stroke(); };
  for (const l of lines) {
    if (nets && !nets.has(l.net)) continue;
    const a = l.a, b = l.b; if (!a || !b) continue;
    if (Math.max(a[0], b[0]) < vr[0] - c || Math.min(a[0], b[0]) > vr[2] + c || Math.max(a[1], b[1]) < vr[1] - c || Math.min(a[1], b[1]) > vr[3] + c) continue;
    const color = (netColors && netColors.get(l.net)) || RATSNEST_COLOR;
    if (color !== cur) { flush(); ctx.strokeStyle = color; ctx.beginPath(); cur = color; }
    if (a[0] === b[0] && a[1] === b[1]) { ctx.moveTo(a[0] - c, a[1] - c); ctx.lineTo(a[0] + c, a[1] + c); ctx.moveTo(a[0] - c, a[1] + c); ctx.lineTo(a[0] + c, a[1] - c); }
    else { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  }
  flush(); ctx.restore();
}

/** MARKER_BASE::ShapeToPolygon at a position: the corners × scale (mm), closed. */
export function markerPolygon(m: { x: number; y: number }, scale: number): number[][] { return MARKER_CORNERS.map(([px, py]) => [m.x + px * scale, m.y + py * scale]); }

export function drawMarkers(ctx: Ctx2D, markers: (Marker | null)[], docType: string, scale: number, bg: string): void {
  const colors = MARKER_COLORS[docType === "sch" ? "sch" : "pcb"];
  const [br, bgc, bb] = parseColor(bg); const shadow = rgba(br, bgc, bb, 0.5);   // LAYER_MARKER_SHADOWS = background @ 0.5
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineJoin = "round";
  for (const m of markers) {
    if (!m || !isFinite(m.x) || !isFinite(m.y)) continue;
    ctx.beginPath();
    for (let i = 0; i < MARKER_CORNERS.length; i++) { const px = m.x + MARKER_CORNERS[i][0] * scale, py = m.y + MARKER_CORNERS[i][1] * scale; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.closePath();
    if (docType !== "sch") { ctx.strokeStyle = shadow; ctx.lineWidth = scale; ctx.stroke(); }
    ctx.fillStyle = colors[m.severity as string] || colors.error; ctx.fill();
  }
  ctx.restore();
}

/** The first marker whose flag (at `scale` mm per unit, default the board's base scale) covers (x, y) within tolMm, or null. */
export function markerAt(markers: (Marker | null)[] | null | undefined, x: number, y: number, tolMm?: number, scale?: number): Marker | null {
  if (!markers) return null; tolMm = tolMm || 0; scale = scale || MARKER_SCALE.pcb;
  for (const m of markers) {
    if (!m || !isFinite(m.x) || !isFinite(m.y)) continue;
    const x0 = m.x - tolMm, y0 = m.y - tolMm, x1 = m.x + 13 * scale + tolMm, y1 = m.y + 13 * scale + tolMm;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (tolMm > 0 || pointInPoly(markerPolygon(m, scale), x, y)) return m;
  }
  return null;
}

/** One net-name label: KiCad's glyph size is the cap height here too; the label is always kept readable (re-mirrored under flip). */
export function drawLabel(ctx: Ctx2D, x: number, y: number, text: string, size: number, rot: number, color: string, pen: number, base: Mat, flip: boolean, sizeX?: number): void {
  if (textMode() === "stroke") {
    // GAL::BitmapText falls back to the stroke font: centred both ways, un-mirrored under the flipped view
    drawStrokeText(ctx, base, { x, y, text, size, sizeX, rot, mirror: !!flip, h: "center", v: "middle", pen }, color, 1 / Math.abs(base[0]));
    return;
  }
  const a = -(rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a); const mx = flip ? -1 : 1;
  ctx.setTransform(base[0] * c * mx, base[3] * sn * mx, -base[0] * sn, base[3] * c, base[0] * x + base[4], base[3] * y + base[5]);
  let font = FONT_CACHE.get(size); if (!font) { font = `${size * FONT_EM}px ${FONT_FAMILY}`; if (FONT_CACHE.size < 512) FONT_CACHE.set(size, font); }
  ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = color;
  ctx.fillText(text, 0, size / 2);
  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
}

/** PCB_PAINTER::renderNetNameForSegment for a track segment / arc geometry. */
export function drawTrackName(ctx: Ctx2D, g: Geom, doc: Doc, s: number, sCss: number, vr: number[], base: Mat, flip: boolean): void {
  const name = displayNetName(doc.nets.get(g.net!)); if (!name) return;
  const width = g.w || 0; if (width * sCss < TRACK_NETNAME_MM * PX_PER_MM_ZOOM1) return;   // ViewGetLOD: 4 mm at zoom 1
  const chars = name.length; const size = width * 0.55, pen = width / 12; const color = trackNameColor(g.color!);
  const vw = vr[2] - vr[0], vh = vr[3] - vr[1];
  if (g.t === "line") {
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1; const len = Math.hypot(dx, dy); if (len < width * chars || len < 1e-9) return;
    let rot: number, n: number;
    if (dy === 0) { rot = 0; n = Math.max(1, Math.round(len / vw)); }
    else if (dx === 0) { rot = 90; n = Math.max(1, Math.round(len / vh)); }
    else { rot = -Math.atan2(dy, dx) * 180 / Math.PI; while (rot > 90) rot -= 180; while (rot <= -90) rot += 180; n = Math.max(1, Math.round(len / (Math.SQRT2 * Math.min(vw, vh)))); }
    for (let i = 1; i <= n; i++) {
      const x = g.x1 + dx * i / (n + 1), y = g.y1 + dy * i / (n + 1);
      if (x < vr[0] || x > vr[2] || y < vr[1] || y > vr[3]) continue;
      drawLabel(ctx, x, y, name, size, rot, color, pen, base, flip);
    }
  } else if (g.t === "arc") {
    let sweep = g.a1 - g.a0; if (!g.anticlockwise && sweep < 0) sweep += 2 * Math.PI; if (g.anticlockwise && sweep > 0) sweep -= 2 * Math.PI;
    if (Math.abs(sweep) * g.r < width * chars) return;
    const am = g.a0 + sweep / 2; const x = g.x + g.r * Math.cos(am), y = g.y + g.r * Math.sin(am);
    if (x < vr[0] || x > vr[2] || y < vr[1] || y > vr[3]) return;
    let rot = -(am * 180 / Math.PI + 90); while (rot > 90) rot -= 180; while (rot <= -90) rot += 180;   // tangent at the mid point
    drawLabel(ctx, x, y, name, size, rot, color, pen, base, flip);
  }
}

/** PCB_PAINTER::draw(PCB_VIA) netname layer: the net name (and the layer pair of blind / micro vias) centred on the via. */
export function drawViaName(ctx: Ctx2D, g: ViaRingGeom, doc: Doc, s: number, sCss: number, base: Mat, flip: boolean): void {
  const name = displayNetName(doc.nets.get(g.net!)); const showLayers = g.viaType && g.viaType !== "through";
  if (!name && !showLayers) return;
  if (g.viaSize * sCss < VIA_NETNAME_MM * PX_PER_MM_ZOOM1) return;   // ViewGetLOD: 10 mm at zoom 1
  const size = Math.min(g.viaSize, 10);
  let tsize = Math.min(1.5 * size / Math.max(name.length, showLayers ? 6 : 3), size) * 0.75;
  const both = showLayers && !!name; const dy = both ? tsize * 1.3 / 2 : 0;
  if (name) drawLabel(ctx, g.x, g.y + dy, name, tsize, 0, VIA_NETNAME_COLOR, tsize / 10, base, flip);
  if (showLayers) {
    const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
    const idx = (l: string) => { const i = copper.indexOf(l); return i < 0 ? 1 : i + 1; };
    drawLabel(ctx, g.x, g.y - (both ? dy + tsize * 0.15 : 0), idx(g.viaLayers[0]) + "-" + idx(g.viaLayers[1]), tsize, 0, VIA_NETNAME_COLOR, tsize / 10, base, flip);
  }
}

/**
 * Fill preview of one unfilled zone outline: the polygon at the zone opacity minus a clearance ring around
 * every other-net obstacle on its layer (pads: the shape inflated by the clearance; tracks: width + 2·clearance;
 * vias / NPTH holes: radius + clearance), cut with destination-out on the scratch canvas, then composited.
 */
export function drawZonePreview(ctx: Ctx2D, g: Geom, obstacles: Geom[], base: Mat, W: number, H: number, minW: number, netColors: Map<number, string> | null, alphaMul?: number): void {
  if (!g.pts || g.pts.length < 3) return;
  const layer = g.layer, net = g.net, c = g.zoneClearance || 0; const alpha = ZONE_OPACITY * (alphaMul === undefined ? 1 : alphaMul);
  const color = (netColors && net! > 0 && netColors.get(net!)) || g.color;
  const off = scratchCanvas(W, H); const octx = off ? off.getContext("2d") : null;
  const target: Ctx2D = octx || ctx;
  if (octx) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, W, H); octx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); octx.globalAlpha = 1; }
  else { ctx.save(); ctx.globalAlpha = alpha; }   // no offscreen canvas (headless): the rings cut through to the page — a degraded fallback
  target.setLineDash([]); target.lineJoin = "round"; target.lineCap = "round";
  target.fillStyle = color as string; target.beginPath(); tracePath(target, g); target.fill();
  target.globalCompositeOperation = "destination-out"; target.fillStyle = "#000"; target.strokeStyle = "#000";
  for (const o of obstacles) {
    if (o.net === net && !(o.npth)) continue;
    const onLayer = o.layer === layer || (o.via && o.viaType === "through") || o.npth;
    if (!onLayer) continue;
    if (o.track) { target.lineWidth = (o.w || 0) + 2 * c; target.beginPath(); tracePath(target, o); target.stroke(); continue; }
    if (o.via && o.t === "circle") { target.beginPath(); target.arc(o.x, o.y, o.r + c, 0, Math.PI * 2); target.fill(); continue; }
    if (o.t === "poly" && o.pts.length < 2) continue;
    target.beginPath(); tracePath(target, o); target.fill(); if (c > 0) { target.lineWidth = 2 * c; target.stroke(); }
  }
  target.globalCompositeOperation = "source-over";
  if (octx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(off as CanvasImageSource, 0, 0); ctx.restore(); }
  else ctx.restore();
}

/** Outline of a track segment (stadium) or track arc (band with round caps) for the sketch display mode. */
export function traceTrackOutline(ctx: PathSink, g: Geom): void {
  const hw = (g.w || 0) / 2;
  if (g.t === "line") {
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1, L = Math.hypot(dx, dy);
    if (L < 1e-9 || hw <= 0) { ctx.moveTo(g.x1 + hw, g.y1); ctx.arc(g.x1, g.y1, Math.max(hw, 1e-6), 0, Math.PI * 2); return; }
    const ang = Math.atan2(dy, dx), nx = -dy / L * hw, ny = dx / L * hw;
    ctx.moveTo(g.x1 + nx, g.y1 + ny); ctx.lineTo(g.x2 + nx, g.y2 + ny);
    ctx.arc(g.x2, g.y2, hw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.lineTo(g.x1 - nx, g.y1 - ny);
    ctx.arc(g.x1, g.y1, hw, ang - Math.PI / 2, ang + Math.PI / 2, true);
    ctx.closePath();
  } else if (g.t === "arc") {
    const acw = !!g.anticlockwise, p0 = [g.x + g.r * Math.cos(g.a0), g.y + g.r * Math.sin(g.a0)], p1 = [g.x + g.r * Math.cos(g.a1), g.y + g.r * Math.sin(g.a1)];
    ctx.moveTo(g.x + (g.r + hw) * Math.cos(g.a0), g.y + (g.r + hw) * Math.sin(g.a0));
    ctx.arc(g.x, g.y, g.r + hw, g.a0, g.a1, acw);
    ctx.arc(p1[0], p1[1], hw, g.a1, g.a1 + Math.PI, acw);
    if (g.r - hw > 1e-9) ctx.arc(g.x, g.y, g.r - hw, g.a1, g.a0, !acw); else ctx.lineTo(g.x, g.y);
    ctx.arc(p0[0], p0[1], hw, g.a0 + Math.PI, g.a0, acw);
    ctx.closePath();
  } else tracePath(ctx, g);
}

/**
 * LAYER_SELECTION_SHADOWS in KiCad's default schematic theme (builtin_color_themes.h): a lighter blue on macOS,
 * which "looks better with a lighter shadow", (.4, .7, 1.0) elsewhere, both at 0.8.
 */
export const SCH_SELECTION_SHADOW = SCH_DEFAULT.selection;   // KiCad Default's; the live theme's is SCH.selection
/** eeschema's selection.thickness / highlight_thickness (EESCHEMA_SETTINGS: 3 and 2). */
export const SCH_SELECTION_THICKNESS = 3, SCH_HIGHLIGHT_THICKNESS = 2;
const MIL = 0.0254;
/**
 * KiCad's selection shadow (SCH_PAINTER, aLayer == LAYER_SELECTION_SHADOWS): every stroke of the item, pins and
 * the glyphs of its text redrawn wider in the shadow colour, under the item itself.  getShadowWidth() adds
 * `thickness` pixels plus `thickness` mils to each stroke; shapes are not filled (selection.fill_shapes is off).
 * Canvas in document space; `under` is the caller's promise that the item is drawn over it afterwards.
 */
export function drawSelectionHalo(ctx: Ctx2D, doc: Doc, ids: Iterable<string>, s: number, dpr: number, hidden?: Set<string> | null, thickness = SCH_SELECTION_THICKNESS): void {
  drawHalo(ctx, doc, ids, s, dpr, hidden, { color: SCH.selection, alpha: 1, extraPx: thickness, extraMm: thickness * MIL, strokesOnly: true });
}

/**
 * SCH_PAINTER::draw( SCH_LINE ) on the shadow pass: a selected line end that is not itself selected (STARTPOINT /
 * ENDPOINT, a click near one end or a box grabbing one end) gets drawDanglingIndicator's small square, half-size the
 * shadowed line width / 2 plus UNSELECTED_END_SIZE / 2 (2 mils), stroked at the shadow width in the shadow colour
 * Invert()ed and Brightened( 0.3 ).  The selection names a partly selected line "id#end:0" (start) / "id#end:1" (end);
 * a line selected whole has both ends selected and no squares.
 */
export function drawLineEndShadows(ctx: Ctx2D, doc: Doc, keys: Iterable<string>, s: number, dpr: number, thickness = SCH_SELECTION_THICKNESS): void {
  const ends = new Map<string, Set<number>>();
  for (const k of keys) { const m = typeof k === "string" ? /^(.*)#end:([01])$/.exec(k) : null; if (m) { let e = ends.get(m[1]); if (!e) ends.set(m[1], e = new Set()); e.add(+m[2]); } }
  if (!ends.size) return;
  const shadowW = thickness * Math.max(1, dpr) / s + thickness * MIL;
  const c = parseColor(SCH.selection);
  const inv = c ? [255 - c[0], 255 - c[1], 255 - c[2]].map((v) => Math.round(v + (255 - v) * 0.3)) : [184, 130, 77];
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineJoin = "miter"; ctx.strokeStyle = `rgba(${inv[0]},${inv[1]},${inv[2]},${c ? c[3] : 0.8})`; ctx.lineWidth = shadowW;
  for (const [id, sel] of ends) {
    const it = doc.items.get(id); if (!it || (it.kind !== "wire" && it.kind !== "bus" && it.kind !== "polyline")) continue;
    const g = it.geom.find((x) => x.t === "poly" || x.t === "line"); if (!g) continue;
    const pts = g.t === "poly" ? (g as { pts: number[][] }).pts : [[(g as { x1: number }).x1, (g as { y1: number }).y1], [(g as { x2: number }).x2, (g as { y2: number }).y2]];
    if (!pts || pts.length < 2) continue;
    const r = ((g.w || 0) + shadowW) / 2 + 2 * MIL;
    for (const i of [0, 1]) { if (sel.has(i)) continue; const p = i ? pts[pts.length - 1] : pts[0]; ctx.strokeRect(p[0] - r, p[1] - r, 2 * r, 2 * r); }
  }
  ctx.restore();
}

/**
 * SCH_PAINTER::draw( SCH_TEXTBOX ) on LAYER_SELECTION_SHADOWS: the whole box filled in the shadow colour, the glyphs
 * without a shadow; a table draws each of its cells that way.  The boxes of a schematic text box / table, or null.
 */
export function shadowBoxes(it: { kind: string; node: SNode }): number[][] | null {
  const kidOf = (n: SNode, k: string) => (n as unknown[]).find((c) => Array.isArray(c) && c[0] === k) as SNode | undefined;
  const box = (n: SNode): number[] | null => {
    const a = kidOf(n, "at") || kidOf(n, "start"), sz = kidOf(n, "size"), e = kidOf(n, "end"); if (!a) return null;
    const x = +(a[1] as number), y = +(a[2] as number);
    const x2 = sz ? x + +(sz[1] as number) : e ? +(e[1] as number) : x, y2 = sz ? y + +(sz[2] as number) : e ? +(e[2] as number) : y;
    return [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)];
  };
  if (it.kind === "text_box") { const b = box(it.node); return b ? [b] : null; }
  if (it.kind !== "table") return null;
  const cells = kidOf(it.node, "cells"); if (!cells) return null;
  const out: number[][] = [];
  for (const c of (cells as unknown[]).slice(1)) {
    if (!Array.isArray(c) || c[0] !== "table_cell") continue;
    const sp = kidOf(c as SNode, "span"); if (sp && (+(sp[1] as number) <= 0 || +(sp[2] as number) <= 0)) continue;   // covered by a merged cell
    const b = box(c as SNode); if (b) out.push(b);
  }
  return out.length ? out : null;
}

/**
 * The anchors of the selected fields: a selected symbol selects its fields (SCH_SELECTION_TOOL::highlight runs
 * SetSelected on the children), and SCH_PAINTER draws a selected field's anchor (drawAnchor) at its position.
 */
export function fieldAnchors(doc: Doc, keys: Iterable<string>, hidden?: Set<string> | null, dangling?: Set<string> | null, moving?: Set<string> | null): number[][] | null {
  const out: number[][] = [];
  for (const key of keys) {
    const cut = typeof key === "string" ? key.indexOf("#") : -1, id = cut > 0 ? key.slice(0, cut) : key, sub = cut > 0 ? key.slice(cut + 1) : null;
    const it = doc.items.get(id); if (!it) continue;
    if (moving && moving.has(id)) continue;          // "parentMoving": no anchors while the item itself moves
    if (moving && moving.has(key)) continue;         // a field moving on its own shows its umbilical line instead
    const only = sub && sub.startsWith("field:") ? sub.slice(6) : null;
    if (sub && !only) continue;                       // a selected pin has no field anchors
    // SCH_PAINTER::draw( SCH_TEXT ): a selected text always shows its anchor, a local label only when it is not
    // dangling (global, hierarchical and directive labels and sheet pins never do)
    if (!only && (it.kind === "text" || (it.kind === "label" && !(dangling && dangling.has(id))))) {
      const a = (it.node as unknown[]).find((c) => Array.isArray(c) && c[0] === "at") as unknown[] | undefined;
      if (a) out.push([+(a[1] as number), +(a[2] as number)]);
    }
    if (!only && it.kind !== "symbol" && it.kind !== "label") continue;
    const seen = new Set<string>();
    for (const g of it.geom) {
      if (g.t !== "text" || !g.field || seen.has(g.field) || (only && g.field !== only)) continue;
      if (hidden && hidden.has(g.layer)) continue;
      seen.add(g.field); out.push([g.x, g.y]);
    }
  }
  return out.length ? out : null;
}
/**
 * SCH_PAINTER::drawAnchor: a cross of TEXT_ANCHOR_SIZE (8 mils) radius plus 8/25 px, in LAYER_SCHEMATIC_ANCHOR
 * blue at the dangling-indicator pen (default pen / 3); its shadow pass draws it in the selection shadow colour
 * at the shadow width.
 */
export function drawFieldAnchors(ctx: Ctx2D, pts: number[][], s: number, dpr: number, shadow: boolean): void {
  const px = dpr / s, r = 8 * MIL + (8 / 25) * px;
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "round";
  ctx.strokeStyle = shadow ? SCH.selection : SCH_ANCHOR_COLOR;
  ctx.lineWidth = shadow ? SCH_SELECTION_THICKNESS * px + SCH_SELECTION_THICKNESS * MIL : Math.max(0.1524 / 3, px);
  ctx.beginPath();
  for (const [x, y] of pts) { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
  ctx.stroke(); ctx.restore();
}
export const SCH_ANCHOR_COLOR = "#0000FF";   // LAYER_SCHEMATIC_ANCHOR

/**
 * A translucent halo around every geom of the given item ids: style = { color: css colour or (geomColour) → css colour,
 * alpha, extraPx: width added to each stroke, in device px }.  Every id in the set gets its halo.
 */
export function drawHalo(ctx: Ctx2D, doc: Doc, ids: Iterable<string>, s: number, dpr: number, hidden: Set<string> | null | undefined, style: HaloStyle): void {
  const minW = Math.max(1, dpr) / s, extra = style.extraPx * dpr / s + (style.extraMm || 0);
  const colorFn = typeof style.color === "function" ? style.color : () => style.color as string;
  const strokesOnly = !!style.strokesOnly;
  const m = typeof (ctx as CanvasRenderingContext2D).getTransform === "function" ? (ctx as CanvasRenderingContext2D).getTransform() : null;
  const base: Mat | null = m ? [m.a, m.b, m.c, m.d, m.e, m.f] as unknown as Mat : null;
  ctx.save();
  ctx.globalAlpha = style.alpha; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
  for (const key of ids) {
    // "itemId#pin:N" / "itemId#field:Name" (schematic) and "footprintId#padIndex" (board) halo that part alone
    const cut = typeof key === "string" ? key.indexOf("#") : -1, id = cut > 0 ? key.slice(0, cut) : key, sub = cut > 0 ? key.slice(cut + 1) : null;
    const it = doc.items.get(id); if (!it || (sub !== null && doc.type === "pcb")) continue;   // a board pad brightens without a halo
    if (strokesOnly && sub === null && doc.type === "sch") {
      const boxes = shadowBoxes(it);
      if (boxes) { ctx.fillStyle = colorFn(SCH.notes); for (const b of boxes) ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); continue; }
    }
    for (const g of it.geom) {
      if (hidden && hidden.has(g.layer)) continue;
      if (sub !== null && (sub !== (g.pinNo !== undefined ? "pin:" + g.pinNo : g.field ? "field:" + g.field : ""))) continue;
      if (strokesOnly && ((g as { noStroke?: boolean }).noStroke || g.noShadow)) continue;   // a sheet / body background fill, hatch lines: no stroke to shadow
      const halo = colorFn(g.color as string); ctx.strokeStyle = halo; ctx.fillStyle = halo;
      if (g.t === "text") {
        if (strokesOnly && base && HAS_PATH2D) {
          // the glyphs themselves, each stroke widened (SCH_PAINTER draws shadow text with m_StrokeWidth + shadowWidth)
          const tg = g as unknown as DrawTextG; const pen = tg.w > 0 ? tg.w : tg.size / 8;
          ctx.save(); drawTextStroke(ctx, Object.assign({}, tg, { w: pen + extra, knockout: false, layoutW: tg.layoutW !== undefined ? tg.layoutW : pen }) as DrawTextG, minW + extra, halo, base, false); ctx.restore();
          continue;
        }
        const w = typeof textWidth === "function" ? textWidth(g.text || "", g.size, g.w || 0.1524) : (g.text || "").length * g.size * 0.75;
        const h = g.size * 1.35;
        ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180); if (g.mirror) ctx.scale(-1, 1);
        const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2;
        ctx.fillRect(x0 - extra / 2, y0 - extra / 4, w + extra, h + extra / 2); ctx.restore();
        continue;
      }
      if (g.t === "image" && g.rot) { const cx = g.x + g.w / 2, cy = g.y + g.h / 2; ctx.save(); ctx.translate(cx, cy); ctx.rotate(-g.rot * Math.PI / 180); ctx.lineWidth = minW + extra; ctx.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h); ctx.restore(); continue; }
      if (g.t === "rect" || g.t === "image") { ctx.lineWidth = Math.max((g as RectGeom).wd || 0, minW) + extra; ctx.strokeRect(g.x, g.y, g.w, g.h); continue; }
      if (g.t === "poly" && (!g.pts || g.pts.length < 2)) continue;
      ctx.lineWidth = Math.max(g.w || 0, minW) + extra;
      const p = (ctx as unknown as { __plot?: boolean }).__plot ? null : pathOf(g);
      // strokes only: a shape filled in its own outline colour (a junction dot, a FILLED_SHAPE) keeps its fill
      const fillIt = strokesOnly ? !!g.fill && g.fill === g.color : (g.fill || g.t === "pad" || g.t === "circle");
      if (fillIt) { if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } }
      if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); }
    }
  }
  ctx.restore();
}

/** A face name as a CSS font-family entry. */
export const cssFamily = (face: string): string => '"' + String(face).replace(/["'\\<>&;]/g, "") + '"';

const FACES = new Map<string, boolean>();
let faceCtx: CanvasRenderingContext2D | null = null;
/**
 * Whether the browser can draw text in the named face.  KiCad falls back to its stroke font when fontconfig
 * has no such face; here a face is taken to exist when text set in it measures differently from both generic
 * fallbacks it would otherwise land on.  No canvas (Node) → false.  "KiCad Font" is the stroke font itself.
 */
export function faceAvailable(face: string): boolean {
  let ok = FACES.get(face);
  if (ok !== undefined) return ok;
  ok = false;
  if (face && !/^kicad font$/i.test(face) && typeof document !== "undefined") {
    try {
      if (!faceCtx) faceCtx = document.createElement("canvas").getContext("2d");
      const probe = "mmmmmmmmmmlliWW0123@#", fam = cssFamily(face);
      const w = (f: string) => { faceCtx!.font = "40px " + f; return faceCtx!.measureText(probe).width; };   // a 2d context, or the throw below
      ok = w(fam + ", monospace") !== w("monospace") || w(fam + ", serif") !== w("serif");
    } catch (e) { ok = false; }
  }
  FACES.set(face, ok);
  return ok;
}

const WANTED = new Set<string>();
/**
 * Tell the app that text in this face (and style) is about to be drawn: KiCadCanvas.onFontWanted(face, bold, italic),
 * once per style.  The editor fetches the font from the project and calls fontChanged when it is on the page.
 */
export function wantFace(face: string, bold: boolean, italic: boolean): void {
  const k = face + "|" + (bold ? "b" : "") + "|" + (italic ? "i" : "");
  if (WANTED.has(k) || /^kicad font$/i.test(face)) return;
  const cb = root.KiCadCanvas && root.KiCadCanvas.onFontWanted;
  if (typeof cb !== "function") return;
  WANTED.add(k);
  try { cb(face, bold, italic); } catch (e) { /* the app's concern */ }
}
/** A font arrived on (or left) the page: look again whether the face can be drawn.  No face: every face. */
export function fontChanged(face?: string): void {
  if (face === undefined) { FACES.clear(); WANTED.clear(); FONT_DATA.clear(); return; }
  FACES.delete(face);
}

/** A font file held for plotting: the bytes, and the style the file really is (a family without a bold answers with its regular). */
export interface FontBytes { data: ArrayBuffer; bold: boolean; italic: boolean }
const FONT_DATA = new Map<string, FontBytes>();
const fontKey = (face: string, bold: boolean, italic: boolean): string => face.toLowerCase() + "|" + (bold ? "b" : "") + "|" + (italic ? "i" : "");
/**
 * The file of a face in the style asked for, kept so that a plot can draw the text's real outlines (web/fab
 * reads the glyphs out of it); the screen needs only the browser's own copy.  null forgets it.
 */
export function setFontData(face: string, bold: boolean, italic: boolean, font: FontBytes | null): void {
  if (font) FONT_DATA.set(fontKey(face, bold, italic), font); else FONT_DATA.delete(fontKey(face, bold, italic));
}
export function fontData(face: string, bold: boolean, italic: boolean): FontBytes | null { return FONT_DATA.get(fontKey(face, bold, italic)) || null; }
/** Every file held, as [face, bold, italic, font] of the style it was asked in (to hand them to a worker). */
export function allFontData(): [string, boolean, boolean, FontBytes][] {
  return [...FONT_DATA].map(([k, f]) => { const [face, b, i] = k.split("|"); return [face, b === "b", i === "i", f] as [string, boolean, boolean, FontBytes]; });
}

/** Text shorter than this on screen (device px of glyph height) is not drawn. */
export const MIN_TEXT_PX = 2;

/**
 * Which text painter runs: "stroke" — KiCad's own stroke font (web/canvas/stroke-font.ts), the default wherever
 * Path2D exists — or "native", the canvas font fallback (headless contexts).  KiCadCanvas.textMode forces one.
 */
export function textMode(): "stroke" | "native" {
  const m = root.KiCadCanvas && root.KiCadCanvas.textMode;
  return m === "stroke" || m === "native" ? m : (HAS_PATH2D ? "stroke" : "native");
}

/**
 * One text geometry in KiCad's stroke font.  The glyphs, the advance widths, ~{overbar} / _{sub} / ^{super}
 * runs, the italic tilt and the anchor fudges are the ones FONT::Draw uses, so text lands where eeschema and
 * pcbnew put it.  Under the flipped board view, text that is not side-specific — and every pad label — is
 * re-mirrored with its justification swapped so it stays readable inside the same (mirrored) box.
 */
export function drawTextStroke(ctx: Ctx2D, g: DrawTextG, minW: number, color: string, base: Mat, flip: boolean, bgColor?: string | null): void {
  let mirror = !!g.mirror, h = g.h;
  if (flip && (g.padText || !SIDE_SPECIFIC.test(g.layer || ""))) { mirror = !mirror; h = flipH(h); }
  const pen = g.w > 0 ? g.w : g.size / 8;
  const text = g.raw || g.text || "";
  const spec = { x: g.x, y: g.y, text, size: g.size, sizeX: g.sizeX, rot: g.rot || 0, mirror, h, v: g.v, pen, italic: !!g.italic, dy: 0 };
  if (g.knockout) {
    // PCB_TEXT knockout: the text box, inflated by GetKnockoutTextMargin, in the layer colour; the glyphs cut out in the background colour
    const sx = g.sizeX! > 0 ? g.sizeX! : g.size, line = strokeLine(text, !!g.italic);
    const lay = g.layoutW !== undefined ? g.layoutW : pen; const [ox, oy] = strokeOrigin(line.advance, h, g.v, lay / sx, lay / g.size); const m = Math.max(pen / 2, g.size / 9);
    const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = mirror ? -1 : 1;
    ctx.setTransform(base[0] * c * mx, base[3] * sn * mx, -base[0] * sn, base[3] * c, base[0] * g.x + base[4], base[3] * g.y + base[5]);
    // the glyph cell: capitals span 20/21 above the layout baseline and 1/21 below it (FONT_OFFSET)
    ctx.fillStyle = color; ctx.fillRect(ox * sx - m, (oy - 20 / 21) * g.size - m, line.width * sx + 2 * m, g.size + 2 * m);
    drawStrokeText(ctx, base, Object.assign(spec, { layoutPen: lay }), bgColor || PCB_BG, minW);
    return;
  }
  // the glyphs sit where the item's own pen places them (a widened shadow pen must not shift the layout)
  if (g.layoutW !== undefined) (spec as { layoutPen?: number }).layoutPen = g.layoutW;
  if (g.multiline && text.indexOf("\n") >= 0) {
    // a drawing-sheet field carrying a \n: lines an interline apart, the block placed per EDA_TEXT::GetLinePositions
    const lines = splitLines(text), step = g.size * TEXT_INTERLINE, offs = lineOffsets(lines.length, g.v);
    for (let i = 0; i < lines.length; i++) { spec.text = lines[i]; spec.dy = offs[i] * step; drawStrokeText(ctx, base, spec, color, minW); }
    return;
  }
  drawStrokeText(ctx, base, spec, color, minW);
}

/**
 * One text run: KiCad's size is the cap height; the baseline sits size/2 below a "middle" anchor.  The text's
 * local frame (anchor, rotation, mirror) is composed with `base` (the document → device matrix) into a single
 * setTransform.  Under the flipped board view, text that is not side-specific — and every pad label — is
 * re-mirrored with its justification swapped so it stays readable inside the same (mirrored) box.
 */
export function drawText(ctx: Ctx2D, g: DrawTextG, s: number, docType: string, minW: number, colorOverride: string | null | undefined, base: Mat | null, flip: boolean, bgColor?: string | null): void {
  const px = g.size * s; if (px < (g.minPx || MIN_TEXT_PX)) return;
  const color = (colorOverride || g.color) as string;
  if (g.face) wantFace(g.face, !!g.bold, !!g.italic);
  const outline = !!g.face && faceAvailable(g.face);
  if (!outline && textMode() === "stroke") {
    let b = base;
    if (!b && typeof ctx.getTransform === "function") { const m = ctx.getTransform(); b = [m.a, m.b, m.c, m.d, m.e, m.f]; }
    if (b) { drawTextStroke(ctx, g, minW, color, b, flip, bgColor); return; }
  }
  const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  let mx = g.mirror ? -1 : 1, h = g.h;
  if (flip && (g.padText || !SIDE_SPECIFIC.test(g.layer || ""))) { mx = -mx; h = flipH(h); }
  if (base) ctx.setTransform(base[0] * c * mx, base[3] * sn * mx, -base[0] * sn, base[3] * c, base[0] * g.x + base[4], base[3] * g.y + base[5]);
  else { ctx.save(); ctx.translate(g.x, g.y); if (a) ctx.rotate(a); if (mx < 0) ctx.scale(-1, 1); }
  // KiCad's bold/italic are a thicker and a sheared stroke font; with a real face the equivalent is
  // the face's own weight and slant.  Only geometry that asks for them (the drawing sheet) is affected.
  // An outline font (effects (font (face "…"))) is drawn in that face: KiCad's FONT::GetFont by name.
  const key = outline ? `${g.size}|${g.bold ? "b" : ""}${g.italic ? "i" : ""}|${g.face}` : g.bold || g.italic ? `${g.size}|${g.bold ? "b" : ""}${g.italic ? "i" : ""}` : g.size;
  let font = FONT_CACHE.get(key);
  if (!font) { font = `${g.italic ? "italic " : ""}${g.bold ? (outline ? "bold " : "600 ") : ""}${g.size * FONT_EM}px ${outline ? cssFamily(g.face!) + ", " : ""}${FONT_FAMILY}`; if (FONT_CACHE.size < 512) FONT_CACHE.set(key, font); }
  ctx.font = font;
  ctx.textAlign = h as CanvasTextAlign; ctx.textBaseline = "alphabetic";
  const base0 = g.v === "top" ? g.size : g.v === "bottom" ? 0 : g.size / 2;
  if (g.knockout) {
    // PCB_TEXT knockout: the text box, inflated by GetKnockoutTextMargin, in the layer colour; the glyphs cut out in the background colour
    const w = textWidth(g.text || "", g.size, g.w || 0), m = Math.max((g.w || 0) / 2, g.size / 9);
    const x0 = h === "left" ? 0 : h === "right" ? -w : -w / 2;
    ctx.fillStyle = color; ctx.fillRect(x0 - m, base0 - g.size - m, w + 2 * m, g.size + 2 * m);
    ctx.fillStyle = bgColor || PCB_BG; ctx.fillText(g.text, 0, base0);
    if (base) ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); else ctx.restore();
    return;
  }
  ctx.fillStyle = color;
  if (g.padText) { ctx.fillText(g.text, 0, base0); if (base) ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); else ctx.restore(); return; }
  // stroke-font thickness beyond a filled face's own stem (~0.13·size) reads as bold; text that
  // already carries the bold flag gets its weight from the face instead of a second stroke pass
  const extra = g.bold || outline ? 0 : g.w - 0.13 * g.size;
  const boldPass = extra > 0.01 && docType === "pcb";
  if (boldPass) { ctx.lineWidth = extra; ctx.strokeStyle = color; ctx.lineJoin = "round"; }
  // A drawing-sheet field carrying a \n is a multiline run: KiCad lays the lines out an interline
  // apart and centres the block on the anchor (EDA_TEXT::GetLinePositions, common/eda_text.cpp:937-978).
  const lines = g.multiline && g.text.indexOf("\n") >= 0 ? splitLines(g.text) : null;
  if (lines) {
    const step = g.size * TEXT_INTERLINE, offs = lineOffsets(lines.length, g.v);
    for (let i = 0; i < lines.length; i++) { const y = base0 + offs[i] * step; if (boldPass) ctx.strokeText(lines[i], 0, y); ctx.fillText(lines[i], 0, y); }
  } else {
    if (boldPass) ctx.strokeText(g.text, 0, base0);
    ctx.fillText(g.text, 0, base0);
  }
  if (g.bars && ctx.measureText) {
    // overbar: KiCad draws it 1.23·size above the baseline with the text pen
    const total = ctx.measureText(g.text).width; const shift = h === "center" ? -total / 2 : h === "right" ? -total : 0;
    const y = base0 - g.size * (docType === "pcb" ? 1.23 : schFormat.overbarHeight); ctx.lineWidth = Math.max(g.w || g.size / 8, minW); ctx.strokeStyle = color; ctx.beginPath();
    for (const [i0, i1] of g.bars) { const x0 = shift + ctx.measureText(g.text.slice(0, i0)).width, x1 = shift + ctx.measureText(g.text.slice(0, i1)).width; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }
  if (base) ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); else ctx.restore();
}

/**
 * KiCad's drawing sheet under the document: the frame rectangles, the 50 mm tick band with its
 * A/B/C · 1/2/3 labels and the title block, from web/canvas/sheet.ts's reading of the built-in
 * (kicad_wks …) description — then DS_PAINTER::DrawBorder's page outline on top of it.
 *
 * Every stroke is the description's own width (0.15 mm for the built-in sheet; DS_RENDER_SETTINGS
 * carries a default pen of 0, so KiCad's max() never raises it), floored at one device pixel so it
 * does not disappear when zoomed out.  The page outline is KiCad's hairline in the lighter
 * page-limits colour — the bug this replaces painted that rectangle in the sheet's dark red and
 * drew nothing else.  Colours: eeschema LAYER_SCHEMATIC_DRAWINGSHEET / _PAGE_LIMITS, pcbnew
 * LAYER_DRAWINGSHEET / LAYER_PAGE_LIMITS (ds_proxy_view_item.cpp:130-148, sch_view.cpp:137-138).
 */
export function drawDrawingSheet(ctx: Ctx2D, doc: Doc, s: number, minW: number): void {
  const isPcb = doc.type === "pcb";
  const ink = isPcb ? PCB_SHEET : SCH.frame;
  const items = documentDrawingSheet(doc);
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineCap = "butt"; ctx.lineJoin = "miter";
  let width = -1;
  const setWidth = (w: number) => { const lw = Math.max(w, minW); if (lw !== width) { width = lw; ctx.lineWidth = lw; } };
  ctx.beginPath();
  let open = false;
  for (const it of items) {
    if (it.t === "line" || it.t === "rect") {
      const w = Math.max(it.t === "line" ? it.w : it.lw, minW);
      if (open && w !== width) { ctx.stroke(); ctx.beginPath(); open = false; }
      setWidth(w);
      if (it.t === "line") { ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); }
      else ctx.rect(it.x, it.y, it.w, it.h);
      open = true;
    }
  }
  if (open) ctx.stroke();
  for (const it of items) {
    if (it.t !== "text") continue;
    drawText(ctx, { t: "text", x: it.x, y: it.y, text: it.text, size: it.size, w: it.w, color: it.color || ink,
      rot: it.rot, h: it.h, v: it.v, bold: it.bold, italic: it.italic, multiline: it.multiline, minPx: 3 }, s, doc.type, minW, null, null, false, null);
  }
  // DS_PAINTER::DrawBorder (ds_painter.cpp:383-396): the paper outline, last, in the page-limits colour (not plotted)
  if ((ctx as unknown as { __plot?: boolean }).__plot) return;
  ctx.strokeStyle = isPcb ? PCB_PAGE_LIMITS : SCH.pageLimits;
  ctx.lineWidth = minW;
  ctx.strokeRect(0, 0, doc.page[0], doc.page[1]);
}


/** Put the canvas into document space (mm) for a given view — for tool overlays; pass the document as `flipDoc` to match the flipped board view. */
export function setViewTransform(ctx: Ctx2D, view: View, flipDoc?: { bbox?: Box | null } | null): number {
  const dpr = view.dpr || 1, s = view.ppm * view.zoom * dpr;
  const tx = view.panX * dpr - view.x0 * s, ty = view.panY * dpr - view.y0 * s;
  if (flipDoc) ctx.setTransform(-s, 0, 0, s, tx + 2 * flipCentre(flipDoc) * s, ty); else ctx.setTransform(s, 0, 0, s, tx, ty);
  return s;
}

export function drawPad(ctx: Ctx2D, g: PadGeom, minW: number): void {
  ctx.beginPath(); tracePad(ctx, g);
  if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
  if (!g.fill || g.w === 0.1) { ctx.strokeStyle = g.color as string; ctx.lineWidth = Math.max(0.05, minW); ctx.stroke(); }
}
