// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { root } from "./env";
import { PCB_BG, PCB_GRID, PCB_GRID_AXES, PCB_PAGE_LIMITS, PCB_SHEET, SCH, parseColor, pcbColor, pcbZ, rgba } from "./colors";
import { flipH, pointInPoly } from "./sexpr";
import { ensureSchTheme } from "./geom";
import { displayNetName } from "./geom-pcb";
import { geomBox } from "./hit";
import { documentDrawingSheet } from "./sheet";
import { TEXT_INTERLINE, lineOffsets, textWidth } from "./text";
import { drawStrokeText, strokeLine, strokeOrigin } from "./stroke-font";
// ---------------------------------------------------------------- rendering
export const HAS_PATH2D = typeof Path2D !== "undefined";

export const FONT_FAMILY = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';

export const FONT_EM = 1.4;
   // cap height ≈ 0.72 em for these faces; KiCad's text size is the cap height
export const FONT_CACHE = new Map();

/** Lazily built Path2D (mm units) for a geometry; rebuilt geometry objects start without one. */
export function pathOf(g) {
  if (g._p) return g._p;
  if (!HAS_PATH2D) return null;
  const p = new Path2D(); tracePath(p, g); g._p = p; return p;
}

export function tracePath(ctx, g) {
  if (g.t === "line") { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
  else if (g.t === "poly") { const pts = g.pts; ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (g.close) ctx.closePath(); }
  else if (g.t === "rect") ctx.rect(g.x, g.y, g.w, g.h);
  else if (g.t === "circle") ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
  else if (g.t === "arc") { if (g.pie) ctx.moveTo(g.x, g.y); ctx.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); if (g.pie) ctx.closePath(); }
  else if (g.t === "pad") tracePad(ctx, g);
}

export function tracePad(ctx, g) {
  const c = Math.cos(-g.rot * Math.PI / 180), s = Math.sin(-g.rot * Math.PI / 180);
  const X = (x, y) => g.x + x * c - y * s, Y = (x, y) => g.y + x * s + y * c;
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
 *                                swatch); geometry painted in the layer's theme colour takes it instead;
 *   objects        (board)     — { hide: Set, opacity: {…} } keyed by KiCad's Appearance ▸ Objects rows: tracks,
 *                                vias, pads, zones, images (visibility + opacity), filledShapes (opacity),
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
export const MARKER_SCALE = { pcb: 0.1625, sch: 0.15 };
                 // PCB_MARKER / SCH_MARKER SCALING_FACTOR (mm)
export const MARKER_COLORS = {
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
export const HL_CACHE = new Map(), NETNAME_COLOR_CACHE = new Map();

/** COLOR4D::Brightened(f): every channel c → c·(1−f) + f */
export function brightened(c, f) { const [r, g, b, a] = parseColor(c); const k = (v) => Math.round(v * (1 - f) + 255 * f); return rgba(k(r), k(g), k(b), a); }

/** The colour of a highlighted item: the board brightens its own colour by the highlight factor (0.5); eeschema paints LAYER_BRIGHTENED. */
export function highlightColor(c, isPcb) {
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
export const SEL_CACHE = new Map();
export function selectedColor(c) {
  let v = SEL_CACHE.get(c); if (v) return v;
  const [r, g, b, a] = parseColor(c), R = r / 255, G = g / 255, B = b / 255;
  const bright = (x, y, z) => 0.299 * x + 0.587 * y + 0.114 * z, br = bright(R, G, B);
  if (br < 0.05) v = c;
  else {
    const f = Math.min(1, 0.25 + br * br * br), up = (x) => x * (1 - f) + f;
    let sr = up(R), sg = up(G), sb = up(B);
    if (Math.abs(bright(sr, sg, sb) - br) < 0.05) { const d = (x) => x * (1 - 0.2); sr = d(R); sg = d(G); sb = B * (1 - f) + f; }
    v = rgba(Math.round(sr * 255), Math.round(sg * 255), Math.round(sb * 255), a);
  }
  SEL_CACHE.set(c, v); return v;
}

/** Fills of a highlighted schematic item: background-layer fills go translucent (SCH_PAINTER: alpha 0.2), the rest take the highlight colour. */
export function highlightFill(g) { return g.z !== undefined && g.z < 0 ? "rgba(255,0,255,0.2)" : SCH.brightened; }

/** Track net-name colour for a copper colour: NETNAMES_LAYER_ID_START, inverted when the copper's brightness is above 0.5 (PCB_RENDER_SETTINGS::LoadColors). */
export function trackNameColor(copper) {
  let v = NETNAME_COLOR_CACHE.get(copper);
  if (!v) { const [r, g, b] = parseColor(copper); v = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? TRACK_NETNAME_DARK : TRACK_NETNAME_LIGHT; NETNAME_COLOR_CACHE.set(copper, v); }
  return v;
}

/** STROKE_PARAMS::Stroke dash pattern (mm) for a drawn line width: dash 11 w, gap 4 w, dot 0.2 w (ISO 128-2 ratios 12 / 3, correction 1). */
export const DASH_RATIOS = { dash: 12, gap: 3 };   // the schematic's dashed_lines_dash_length_ratio / gap_length_ratio (Schematic Setup > Formatting)
export function dashPattern(type, w) {
  const dash = Math.max(DASH_RATIOS.dash - 1, 1) * w, gap = Math.max(DASH_RATIOS.gap + 1, 1) * w, dot = 0.2 * w;
  if (type === "dot") return [dot, gap];
  if (type === "dash_dot") return [dash, gap, dot, gap];
  if (type === "dash_dot_dot") return [dash, gap, dot, gap, dot, gap];
  return [dash, gap];
}

/** KiCad's zoom factor for a view: css px per mm over the GAL's px per mm at zoom 1. */
export function zoomFactor(view) { return (view.ppm * view.zoom) / PX_PER_MM_ZOOM1; }

/** Marker shape scale (mm per corner unit): boards shrink with √zoom (PCB_MARKER::SetZoom), schematics are fixed. */
export function markerScale(docType, view) { return docType === "sch" || !view ? MARKER_SCALE[docType === "sch" ? "sch" : "pcb"] : MARKER_SCALE.pcb / Math.sqrt(Math.max(zoomFactor(view), 1e-9)); }

/** The mirror axis of the flipped board view: the board bbox centre. */
export function flipCentre(doc) { const b = doc && doc.bbox; return b ? (b[0] + b[2]) / 2 : 0; }

/** Document x → x as drawn in the flipped view (an involution: unflipX is the same map, exported for clarity). */
export function flipX(doc, x) { return 2 * flipCentre(doc) - x; }

export function unflipX(doc, x) { return 2 * flipCentre(doc) - x; }

/** Canvas factory for offscreen work (zone previews, renderPng); replace KiCadCanvas.createCanvas to inject one (tests). */
export function defaultCreateCanvas(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined" && document.createElement) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  return null;
}

export const makeCanvas = (w, h) => ((root.KiCadCanvas && root.KiCadCanvas.createCanvas) || defaultCreateCanvas)(w, h);

export let SCRATCH = null;
   // offscreen canvas reused by the zone previews
export function scratchCanvas(w, h) {
  if (!SCRATCH) { SCRATCH = makeCanvas(w, h); if (!SCRATCH) return null; }
  if (SCRATCH.width !== w || SCRATCH.height !== h) { SCRATCH.width = w; SCRATCH.height = h; }
  return SCRATCH;
}

export const TOP_Z = 100000, TOP_CACHE = new Map();
   // draw-order offset of the layers brought to the top with the active layer
export const BUCKETS = new Map(), NAME_BUCKETS = new Map();
   // z → geometry, reused frame to frame (cleared, never reallocated)
export const ZS = [];

export function bucket(map, z) { let arr = map.get(z); if (!arr) { arr = []; map.set(z, arr); } return arr; }

export function render(doc, ctx, view, opts) {
  ensureSchTheme(doc);   // geometry built under another schematic colour theme is rebuilt first
  opts = opts || {}; const hidden = opts.hidden || new Set();
  const isPcb = doc.type === "pcb";
  const showHiddenPins = !!opts.showHiddenPins && doc.type === "sch", zoneOutline = isPcb && !!opts.zoneOutline;
  const showHiddenText = isPcb && !!opts.showHiddenText, padNumbers = opts.padNumbers !== false;
  const sketchPads = isPcb && !!opts.outlinePads, sketchTracks = isPcb && !!opts.outlineTracks, sketchVias = isPcb && !!opts.outlineVias;
  const hcLayer = isPcb && opts.highContrast && opts.activeLayer ? String(opts.activeLayer) : null;
  const hl = opts.highlight && opts.highlight.size ? opts.highlight : null;
  const hlGeoms = hl ? new Set() : null;   // geometry of the highlighted items
  const selPcb = isPcb && opts.selected && opts.selected.size ? opts.selected : null;   // board selection: repainted, not haloed
  const selGeoms = selPcb ? new Set() : null;
  const hlColor = (c) => highlightColor(c, isPcb);
  const ids = opts.ids ? (opts.ids instanceof Set ? opts.ids : new Set(opts.ids)) : null;
  const skip = opts.skip && opts.skip.size ? opts.skip : null;   // items a peer is dragging: drawn as ghosts elsewhere
  const netColors = isPcb && opts.netColors && opts.netColors.size ? opts.netColors : null;
  const netNames = isPcb && opts.netNames !== false,   // pcbnew default: net names on pads and tracks ("pcb_display.net_names_mode" 3)
   zoneFill = isPcb && !!opts.zoneFill, flip = isPcb && !!opts.flip;
  const rats = isPcb && opts.ratsnest && opts.ratsnest.length ? opts.ratsnest : null, ratsNets = opts.ratsnestNets || null;
  const markers = opts.markers && opts.markers.length ? opts.markers : null;
  const layerColors = isPcb && opts.layerColors && opts.layerColors.size ? opts.layerColors : null;
  const obj = isPcb && opts.objects ? opts.objects : null, objHide = obj && obj.hide && obj.hide.size ? obj.hide : null, objAlpha = obj && obj.opacity ? obj.opacity : null;
  const hcHide = !!opts.inactiveHide;
  const itemColors = isPcb && opts.itemColors && opts.itemColors.size ? opts.itemColors : null, tint = itemColors ? new Map() : null;
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = view.dpr || 1;
  const s = view.ppm * view.zoom * dpr;                 // device px per mm
  const sCss = view.ppm * view.zoom;                    // css px per mm (KiCad's LOD rules work in logical pixels)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // region: [x0, y0, x1, y1] device px — repaint only that part of the canvas (the editor's pan strips); the
  // pixels drawn there are the full render's, the rest of the canvas is left alone
  const region = opts.region || null;
  if (region) { ctx.save(); ctx.beginPath(); ctx.rect(region[0], region[1], region[2] - region[0], region[3] - region[1]); ctx.clip(); }
  const bg = opts.background === undefined ? (doc.type === "sch" ? SCH.bg : PCB_BG) : opts.background;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); } else if (typeof ctx.clearRect === "function") ctx.clearRect(0, 0, W, H);
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
  if (opts.grid > 0) {
    const style = opts.gridStyle === "lines" || opts.gridStyle === "crosses" ? opts.gridStyle : "dots";
    const minSpacing = (opts.gridMinSpacing > 0 ? opts.gridMinSpacing : GRID_MIN_SPACING) * (style === "crosses" ? 2 : 1) / sCss;
    let pitch = opts.grid; let guard = 0;
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
  if (opts.frame !== false) {
    if (flip) ctx.setTransform(s, 0, 0, s, tx, ty);
    drawDrawingSheet(ctx, doc, s, Math.max(1, dpr) / s);
    if (flip) ctx.setTransform(A, 0, 0, s, E, ty);
  }
  // collect visible geometry into the z buckets (arrays reused across frames)
  for (const arr of BUCKETS.values()) arr.length = 0;
  for (const arr of NAME_BUCKETS.values()) arr.length = 0;
  const obstacles = zoneFill ? [] : null, previews = zoneFill ? [] : null;
  const copperZ = isPcb ? (doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]) : null;
  // PCB_DRAW_PANEL_GAL::SetTopLayer: the active layer is brought to the top — a copper layer together with its
  // zone / pad / via / netname layers, and with it every layer of its side (F.* or B.*); the holes, the pad and
  // via names and the ratsnest are always on top.  A non-copper active layer goes above those too.  The layers
  // keep their order among themselves (VIEW::TOP_LAYER_MODIFIER), so this is one offset per layer.
  const act = isPcb && opts.activeLayer ? String(opts.activeLayer) : null;
  const actSide = act ? (act.indexOf("F.") === 0 ? "F." : act.indexOf("B.") === 0 ? "B." : null) : null, actCu = !!act && /\.Cu$/.test(act);
  const zHoles0 = isPcb ? pcbZ("holes") : 0;
  TOP_CACHE.clear();
  const topOf = (layer) => {
    if (!act) return 0;
    let v = TOP_CACHE.get(layer);
    if (v === undefined) { v = layer === "holes" ? TOP_Z : layer === act ? (actCu ? TOP_Z : 2 * TOP_Z) : actSide && layer && layer.indexOf(actSide) === 0 ? TOP_Z : 0; TOP_CACHE.set(layer, v); }
    return v;
  };
  const zOf = (g) => { const z = g.z === undefined ? 0 : g.z; return isPcb ? z + topOf(z >= zHoles0 && z < zHoles0 + 10 ? "holes" : g.layer) : z; };
  const zHoles = zHoles0 + topOf("holes"), zRats = zHoles + 2, zViaName = zHoles + 1.5;
  const cullM = 4 * Math.max(1, dpr) / s + 0.1; const cx0 = vx0 - cullM, cx1 = vx1 + cullM, cy0 = vy0 - cullM, cy1 = vy1 + cullM;   // per-geometry cull rect: the view plus 4 px
  for (const it of doc.items.values()) {
    if ((ids && !ids.has(it.id)) || (skip && skip.has(it.id))) continue;
    const b = it.bbox; if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    const isHl = hl ? hl.has(it.id) : false;
    const isSel = selPcb ? selPcb.has(it.id) : false;
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
        if (g.padMin * sCss < PAD_NETNAME_MM * PX_PER_MM_ZOOM1) continue;
        const pl = g.padLayers; let vis = false;
        if (hcLayer) vis = pl.indexOf(hcLayer) >= 0; else for (let i = 0; i < pl.length; i++) if (!hidden.has(pl[i])) { vis = true; break; }
        if (!vis) continue;
      } else {
        if (hidden.has(g.layer) || (zoneOutline && g.zoneFill)) continue;
        if (hcHide && hcLayer && g.layer !== hcLayer && g.layer !== "holes") continue;   // inactive layers: Hide
      }
      if (objHide) {
        const oc = objectClass(g);
        if (oc && objHide.has(oc)) continue;
        if (isFp && g.t === "text" && !g.pad && (objHide.has("fpText") || (g.field === "Reference" && objHide.has("references")) || (g.field === "Value" && objHide.has("values")))) continue;
      }
      const z = zOf(g);
      bucket(BUCKETS, z).push(g);
      if (itemTint && !g.hole && (g.track || g.via || g.zoneFill || (g.pad && g.t !== "text"))) { const tc = typeof itemTint === "string" ? itemTint : itemTint[g.padIndex]; if (tc) tint.set(g, tc); }
      if (isHl) hlGeoms.add(g);
      if (isSel) selGeoms.add(g);
      if (netNames && g.net > 0) {
        if (g.track && !sketchTracks) bucket(NAME_BUCKETS, pcbZ(g.layer) + 3.5 + topOf(g.layer)).push(g);
        else if (g.viaLabel) bucket(NAME_BUCKETS, zViaName).push(g);
      }
      if (zoneFill) {
        if (g.zoneUnfilled) previews.push(g);
        else if (g.track || (g.via && !g.hole && (g.viaType !== "through" || g.viaLabel)) || g.npth || (g.pad && !g.hole && g.t !== "text")) obstacles.push(g);   // a through via cuts every layer once (its label ring stands for it)
      }
    }
    if (it.hiddenGeom && (showHiddenPins || showHiddenText)) for (const g of it.hiddenGeom) {
      if (hidden.has(g.layer) || (g.hiddenText ? !showHiddenText : !showHiddenPins)) continue;
      const z = zOf(g);
      bucket(BUCKETS, z).push(g);
      if (isHl) hlGeoms.add(g);
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
  let curStroke = null, curFill = null, curWidth = -1, curAlpha = -1, curCap = "round";
  const setStroke = (c) => { if (c !== curStroke) { ctx.strokeStyle = c; curStroke = c; } };
  const setFill = (c) => { if (c !== curFill) { ctx.fillStyle = c; curFill = c; } };
  const setWidth = (w) => { if (w !== curWidth) { ctx.lineWidth = w; curWidth = w; } };
  const setAlpha = (a) => { if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; } };
  const setCap = (c) => { if (c !== curCap) { ctx.lineCap = c; curCap = c; } };
  const strokeG = (g) => { const p = pathOf(g); if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); } };
  const fillG = (g) => { const p = pathOf(g); if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } };
  const base = [A, 0, 0, s, E, ty]; const viewRect = [fx0, fy0, fx1, fy1];
  const dirty = () => { curStroke = curFill = null; curWidth = -1; curCap = "round"; curAlpha = -1; };
  let ratsDone = !rats, previewIdx = 0;
  for (const z of ZS) {
    // overlay passes that sit at this depth
    if (!ratsDone && zRats <= z) { drawRatsnest(ctx, rats, ratsNets, netColors, s, dpr, viewRect); ratsDone = true; dirty(); }
    if (previews) while (previewIdx < previews.length && zOf(previews[previewIdx]) - 1.5 - 0.01 <= z) { const pg = previews[previewIdx++]; drawZonePreview(ctx, pg, obstacles, base, W, H, minW, netColors, (hcLayer && pg.layer !== hcLayer ? HC_DIM : 1) * (hl && !hlGeoms.has(pg) ? HL_DIM : 1)); dirty(); }
    const arr = BUCKETS.get(z);
    if (arr) for (const g of arr) {
      let alpha = g.alpha === undefined ? 1 : g.alpha;
      if (hcLayer && g.layer !== hcLayer && g.layer !== "holes" && !g.padText) alpha *= HC_DIM;
      if (g.zoneFill) alpha *= ZONE_OPACITY;   // PCB_RENDER_SETTINGS::GetColor: color.a *= m_zoneOpacity
      if (g.hiddenText) alpha *= HIDDEN_TEXT_ALPHA;
      let color = g.color, fill = g.fill;
      if (objAlpha) { const oc = objectClass(g) || (fill && g.t !== "text" && !g.hole ? "filledShapes" : null); const oa = oc ? objAlpha[oc] : undefined; if (oa !== undefined && oa < 1) alpha *= oa; }
      if (layerColors && !g.hole) { const lc = layerColors.get(g.layer); if (lc) { const def = pcbColor(g.layer); if (color === def) color = lc; if (fill === def) fill = lc; } }
      if (netColors && g.net > 0 && (g.track || g.via || g.pad || g.zoneFill) && !g.hole && copperZ.indexOf(g.layer) >= 0) { const nc = netColors.get(g.net); if (nc) { color = nc; if (fill) fill = nc; } }
      if (tint) { const tc = tint.get(g); if (tc && copperZ.indexOf(g.layer) >= 0) { color = tc; if (fill) fill = tc; } }
      // board selection: the item repainted in its layer's selected colour (PCB_PAINTER::getColor), holes untouched
      if (selPcb && selGeoms.has(g) && !g.hole) { color = selectedColor(color); if (fill) fill = selectedColor(fill); }
      if (hl) { if (hlGeoms.has(g)) { color = hlColor(color); if (fill) fill = isPcb ? hlColor(fill) : highlightFill(g); } else alpha *= HL_DIM; }
      setAlpha(alpha);
      const t = g.t;
      if (t === "text") { drawText(ctx, g, s, doc.type, minW, color, base, flip, bg || PCB_BG); curStroke = curFill = null; curWidth = -1; curCap = "round"; continue; }
      if (t === "image") {
        const e = g.entry;
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
        continue;
      }
      // LAYER_VIA_HOLEWALLS under the hole; PCB_PAINTER underpaints it filled in the outline mode too
      if (g.wallR && ((g.wallR - g.r) * s > 0.35)) { setFill(g.wallColor); ctx.beginPath(); ctx.arc(g.x, g.y, g.wallR, 0, Math.PI * 2); ctx.fill(); }
      if ((sketchPads && g.pad) || (sketchVias && g.via)) {   // sketch mode: the shape's outline in a hairline, nothing filled
        if (t === "poly" && g.pts.length < 2) continue;
        setStroke(color); setWidth(minW); setCap("butt"); strokeG(g); continue;
      }
      if (sketchTracks && g.track) { setStroke(color); setWidth(minW); setCap("butt"); ctx.beginPath(); traceTrackOutline(ctx, g); ctx.stroke(); continue; }
      if (t === "rect") {
        if (fill) { setFill(fill); ctx.fillRect(g.x, g.y, g.w, g.h); }
        if (!g.noStroke) {
          setStroke(color); const lw = Math.max(g.wd || 0, minW); setWidth(lw);
          if (g.dash) ctx.setLineDash(dashPattern(g.dashType, lw));
          ctx.strokeRect(g.x, g.y, g.w, g.h);
          if (g.dash) ctx.setLineDash([]);
        }
        continue;
      }
      if (t === "poly" && g.pts.length < 2) continue;
      if (fill) { setFill(fill); fillG(g); }
      if (g.noStroke) continue;
      if (t === "line" || t === "arc" || (t === "poly" && (g.w > 0 || !fill)) || (t === "circle" && (g.w > 0 || !fill)) || (t === "pad" && !fill)) {
        setStroke(color); const lw = Math.max(g.w, minW); setWidth(lw); setCap(g.cap || (t === "poly" || t === "line" ? "round" : "butt"));
        if (g.dash) ctx.setLineDash(dashPattern(g.dashType, lw));
        strokeG(g);
        if (g.dash) ctx.setLineDash([]);
      }
    }
    const names = NAME_BUCKETS.get(z);
    if (names && names.length) {
      for (const g of names) {
        let alpha = 1; if (hcLayer && g.layer !== hcLayer) continue;   // PCB_TRACK::ViewGetLOD: no names on dimmed tracks
        if (hl && !hlGeoms.has(g)) alpha *= HL_DIM;
        setAlpha(alpha);
        if (g.track) drawTrackName(ctx, g, doc, s, sCss, viewRect, base, flip); else drawViaName(ctx, g, doc, s, sCss, base, flip);
      }
      dirty();
    }
  }
  if (!ratsDone) { drawRatsnest(ctx, rats, ratsNets, netColors, s, dpr, viewRect); }
  if (previews) while (previewIdx < previews.length) { const pg = previews[previewIdx++]; drawZonePreview(ctx, pg, obstacles, base, W, H, minW, netColors, (hcLayer && pg.layer !== hcLayer ? HC_DIM : 1) * (hl && !hlGeoms.has(pg) ? HL_DIM : 1)); }
  ctx.globalAlpha = 1;
  if (obj && obj.show) drawObjectOverlays(ctx, doc, obj, opts, s, dpr, hidden, [vx0, vy0, vx1, vy1]);
  // highlight: the brightened items get a translucent halo of the highlight colour (the schematic's LAYER_SELECTION_SHADOWS pass for brightened items)
  if (hl) drawHalo(ctx, doc, hl, s, dpr, hidden, { color: hlColor, alpha: isPcb ? 0.35 : 0.15, extraPx: 3 });
  // DRC / ERC markers: above everything but the selection (GAL_LAYER_ORDER: LAYER_SELECT_OVERLAY, then LAYER_DRC_*)
  if (markers) drawMarkers(ctx, markers, doc.type, markerScale(doc.type, view), bg || (isPcb ? PCB_BG : SCH.bg));
  // selection: eeschema draws a selection shadow (a translucent halo around the item's own geometry);
  // pcbnew repaints the item in its selected colour instead, which the geometry pass above already did
  if (!isPcb && opts.selected && opts.selected.size) drawSelectionHalo(ctx, doc, opts.selected, s, dpr, hidden);
  if (region) ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Which Appearance ▸ Objects row a geometry belongs to (null: governed by its layer alone). */
export function objectClass(g) {
  return g.track ? "tracks" : g.via ? "vias" : g.pad ? "pads" : (g.zoneFill || g.zoneOutline || g.zoneUnfilled) ? "zones" : g.t === "image" ? "images" : null;
}

export const ANCHOR_COLOR = "#FF26E2", LOCKED_SHADOW_COLOR = "rgba(255,38,226,0.5)";
   // LAYER_ANCHOR, LAYER_LOCKED_ITEM_SHADOW (builtin_color_themes.h)
/** The overlay object layers: the locked-item shadow (under the anchors) and the footprint anchors — PCB_PAINTER::draw(FOOTPRINT, LAYER_ANCHOR): a 5 px cross, 1 px pen. */
export function drawObjectOverlays(ctx, doc, obj, opts, s, dpr, hidden, vr) {
  const show = obj.show, hide = obj.hide || new Set();
  if (show.has("lockedShadow") && opts.lockedIds && opts.lockedIds.size) drawHalo(ctx, doc, opts.lockedIds, s, dpr, hidden, { color: () => "#FF26E2", alpha: 0.5, extraPx: 4 });
  if (show.has("anchors")) {
    const a = 5 * Math.max(1, dpr) / s;
    ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.strokeStyle = ANCHOR_COLOR; ctx.lineWidth = Math.max(1, dpr) / s; ctx.beginPath();
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint" || it.x === undefined) continue;
      if (hide.has(it.layer && /^B\./.test(it.layer) ? "fpBack" : "fpFront")) continue;
      if (it.x < vr[0] - a || it.x > vr[2] + a || it.y < vr[1] - a || it.y > vr[3] + a) continue;
      ctx.moveTo(it.x - a, it.y); ctx.lineTo(it.x + a, it.y); ctx.moveTo(it.x, it.y - a); ctx.lineTo(it.x, it.y + a);
    }
    ctx.stroke(); ctx.restore();
  }
}

/** RATSNEST_VIEW_ITEM::ViewDraw: hairlines in LAYER_RATSNEST (or the net colour), a cross where both ends coincide. */
export function drawRatsnest(ctx, lines, nets, netColors, s, dpr, vr) {
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.lineWidth = RATSNEST_PX * Math.max(1, dpr) / s;
  let cur = null; const c = RATSNEST_CROSS;
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
export function markerPolygon(m, scale) { return MARKER_CORNERS.map(([px, py]) => [m.x + px * scale, m.y + py * scale]); }

export function drawMarkers(ctx, markers, docType, scale, bg) {
  const colors = MARKER_COLORS[docType === "sch" ? "sch" : "pcb"];
  const [br, bgc, bb] = parseColor(bg); const shadow = rgba(br, bgc, bb, 0.5);   // LAYER_MARKER_SHADOWS = background @ 0.5
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineJoin = "round";
  for (const m of markers) {
    if (!m || !isFinite(m.x) || !isFinite(m.y)) continue;
    ctx.beginPath();
    for (let i = 0; i < MARKER_CORNERS.length; i++) { const px = m.x + MARKER_CORNERS[i][0] * scale, py = m.y + MARKER_CORNERS[i][1] * scale; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.closePath();
    if (docType !== "sch") { ctx.strokeStyle = shadow; ctx.lineWidth = scale; ctx.stroke(); }
    ctx.fillStyle = colors[m.severity] || colors.error; ctx.fill();
  }
  ctx.restore();
}

/** The first marker whose flag (at `scale` mm per unit, default the board's base scale) covers (x, y) within tolMm, or null. */
export function markerAt(markers, x, y, tolMm, scale) {
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
export function drawLabel(ctx, x, y, text, size, rot, color, pen, base, flip, sizeX) {
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
export function drawTrackName(ctx, g, doc, s, sCss, vr, base, flip) {
  const name = displayNetName(doc.nets.get(g.net)); if (!name) return;
  const width = g.w || 0; if (width * sCss < TRACK_NETNAME_MM * PX_PER_MM_ZOOM1) return;   // ViewGetLOD: 4 mm at zoom 1
  const chars = name.length; const size = width * 0.55, pen = width / 12; const color = trackNameColor(g.color);
  const vw = vr[2] - vr[0], vh = vr[3] - vr[1];
  if (g.t === "line") {
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1; const len = Math.hypot(dx, dy); if (len < width * chars || len < 1e-9) return;
    let rot, n;
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
export function drawViaName(ctx, g, doc, s, sCss, base, flip) {
  const name = displayNetName(doc.nets.get(g.net)); const showLayers = g.viaType && g.viaType !== "through";
  if (!name && !showLayers) return;
  if (g.viaSize * sCss < VIA_NETNAME_MM * PX_PER_MM_ZOOM1) return;   // ViewGetLOD: 10 mm at zoom 1
  const size = Math.min(g.viaSize, 10);
  let tsize = Math.min(1.5 * size / Math.max(name.length, showLayers ? 6 : 3), size) * 0.75;
  const both = showLayers && !!name; const dy = both ? tsize * 1.3 / 2 : 0;
  if (name) drawLabel(ctx, g.x, g.y + dy, name, tsize, 0, VIA_NETNAME_COLOR, tsize / 10, base, flip);
  if (showLayers) {
    const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
    const idx = (l) => { const i = copper.indexOf(l); return i < 0 ? 1 : i + 1; };
    drawLabel(ctx, g.x, g.y - (both ? dy + tsize * 0.15 : 0), idx(g.viaLayers[0]) + "-" + idx(g.viaLayers[1]), tsize, 0, VIA_NETNAME_COLOR, tsize / 10, base, flip);
  }
}

/**
 * Fill preview of one unfilled zone outline: the polygon at the zone opacity minus a clearance ring around
 * every other-net obstacle on its layer (pads: the shape inflated by the clearance; tracks: width + 2·clearance;
 * vias / NPTH holes: radius + clearance), cut with destination-out on the scratch canvas, then composited.
 */
export function drawZonePreview(ctx, g, obstacles, base, W, H, minW, netColors, alphaMul) {
  if (!g.pts || g.pts.length < 3) return;
  const layer = g.layer, net = g.net, c = g.zoneClearance || 0; const alpha = ZONE_OPACITY * (alphaMul === undefined ? 1 : alphaMul);
  const color = (netColors && net > 0 && netColors.get(net)) || g.color;
  const off = scratchCanvas(W, H); const octx = off ? off.getContext("2d") : null;
  const target = octx || ctx;
  if (octx) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, W, H); octx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]); octx.globalAlpha = 1; }
  else { ctx.save(); ctx.globalAlpha = alpha; }   // no offscreen canvas (headless): the rings cut through to the page — a degraded fallback
  target.setLineDash([]); target.lineJoin = "round"; target.lineCap = "round";
  target.fillStyle = color; target.beginPath(); tracePath(target, g); target.fill();
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
  if (octx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(off, 0, 0); ctx.restore(); }
  else ctx.restore();
}

/** Outline of a track segment (stadium) or track arc (band with round caps) for the sketch display mode. */
export function traceTrackOutline(ctx, g) {
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

/** Draw KiCad's selection shadow around every geom of the given item ids (canvas must be in document space). */
export function drawSelectionHalo(ctx, doc, ids, s, dpr, hidden) { drawHalo(ctx, doc, ids, s, dpr, hidden, { color: "#66B2FF", alpha: 0.55, extraPx: 5 }); }

/**
 * A translucent halo around every geom of the given item ids: style = { color: css colour or (geomColour) → css colour,
 * alpha, extraPx: width added to each stroke, in device px }.  Every id in the set gets its halo.
 */
export function drawHalo(ctx, doc, ids, s, dpr, hidden, style) {
  const minW = Math.max(1, dpr) / s, extra = style.extraPx * dpr / s;
  const colorFn = typeof style.color === "function" ? style.color : () => style.color;
  ctx.save();
  ctx.globalAlpha = style.alpha; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    for (const g of it.geom) {
      if (hidden && hidden.has(g.layer)) continue;
      const halo = colorFn(g.color); ctx.strokeStyle = halo; ctx.fillStyle = halo;
      if (g.t === "text") {
        const w = typeof textWidth === "function" ? textWidth(g.text || "", g.size, g.w || 0.1524) : (g.text || "").length * g.size * 0.75;
        const h = g.size * 1.35;
        ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180); if (g.mirror) ctx.scale(-1, 1);
        const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2;
        ctx.fillRect(x0 - extra / 2, y0 - extra / 4, w + extra, h + extra / 2); ctx.restore();
        continue;
      }
      if (g.t === "rect" || g.t === "image") { ctx.lineWidth = Math.max(g.wd || 0, minW) + extra; ctx.strokeRect(g.x, g.y, g.w, g.h); continue; }
      if (g.t === "poly" && (!g.pts || g.pts.length < 2)) continue;
      ctx.lineWidth = Math.max(g.w || 0, minW) + extra;
      const p = pathOf(g);
      if (g.fill || g.t === "pad" || g.t === "circle") { if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } }
      if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); }
    }
  }
  ctx.restore();
}

/** A face name as a CSS font-family entry. */
export const cssFamily = (face) => '"' + String(face).replace(/["'\\<>&;]/g, "") + '"';

const FACES = new Map();
let faceCtx = null;
/**
 * Whether the browser can draw text in the named face.  KiCad falls back to its stroke font when fontconfig
 * has no such face; here a face is taken to exist when text set in it measures differently from both generic
 * fallbacks it would otherwise land on.  No canvas (Node) → false.  "KiCad Font" is the stroke font itself.
 */
export function faceAvailable(face) {
  let ok = FACES.get(face);
  if (ok !== undefined) return ok;
  ok = false;
  if (face && !/^kicad font$/i.test(face) && typeof document !== "undefined") {
    try {
      if (!faceCtx) faceCtx = document.createElement("canvas").getContext("2d");
      const probe = "mmmmmmmmmmlliWW0123@#", fam = cssFamily(face);
      const w = (f) => { faceCtx.font = "40px " + f; return faceCtx.measureText(probe).width; };
      ok = w(fam + ", monospace") !== w("monospace") || w(fam + ", serif") !== w("serif");
    } catch (e) { ok = false; }
  }
  FACES.set(face, ok);
  return ok;
}

/** Text shorter than this on screen (device px of glyph height) is not drawn. */
export const MIN_TEXT_PX = 2;

/**
 * Which text painter runs: "stroke" — KiCad's own stroke font (web/canvas/stroke-font.ts), the default wherever
 * Path2D exists — or "native", the canvas font fallback (headless contexts).  KiCadCanvas.textMode forces one.
 */
export function textMode() {
  const m = root.KiCadCanvas && root.KiCadCanvas.textMode;
  return m === "stroke" || m === "native" ? m : (HAS_PATH2D ? "stroke" : "native");
}

/**
 * One text geometry in KiCad's stroke font.  The glyphs, the advance widths, ~{overbar} / _{sub} / ^{super}
 * runs, the italic tilt and the anchor fudges are the ones FONT::Draw uses, so text lands where eeschema and
 * pcbnew put it.  Under the flipped board view, text that is not side-specific — and every pad label — is
 * re-mirrored with its justification swapped so it stays readable inside the same (mirrored) box.
 */
export function drawTextStroke(ctx, g, minW, color, base, flip, bgColor) {
  let mirror = !!g.mirror, h = g.h;
  if (flip && (g.padText || !SIDE_SPECIFIC.test(g.layer || ""))) { mirror = !mirror; h = flipH(h); }
  const pen = g.w > 0 ? g.w : g.size / 8;
  const text = g.raw || g.text || "";
  const spec = { x: g.x, y: g.y, text, size: g.size, sizeX: g.sizeX, rot: g.rot || 0, mirror, h, v: g.v, pen, italic: !!g.italic, dy: 0 };
  if (g.knockout) {
    // PCB_TEXT knockout: the text box, inflated by GetKnockoutTextMargin, in the layer colour; the glyphs cut out in the background colour
    const sx = g.sizeX > 0 ? g.sizeX : g.size, line = strokeLine(text, !!g.italic);
    const [ox, oy] = strokeOrigin(line.width, h, g.v, pen / sx, pen / g.size); const m = Math.max(pen / 2, g.size / 9);
    const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = mirror ? -1 : 1;
    ctx.setTransform(base[0] * c * mx, base[3] * sn * mx, -base[0] * sn, base[3] * c, base[0] * g.x + base[4], base[3] * g.y + base[5]);
    // the glyph cell: capitals span 20/21 above the layout baseline and 1/21 below it (FONT_OFFSET)
    ctx.fillStyle = color; ctx.fillRect(ox * sx - m, (oy - 20 / 21) * g.size - m, line.width * sx + 2 * m, g.size + 2 * m);
    drawStrokeText(ctx, base, spec, bgColor || PCB_BG, minW);
    return;
  }
  if (g.multiline && text.indexOf("\n") >= 0) {
    // a drawing-sheet field carrying a \n: lines an interline apart, the block placed per EDA_TEXT::GetLinePositions
    const lines = text.split("\n"), step = g.size * TEXT_INTERLINE, offs = lineOffsets(lines.length, g.v);
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
export function drawText(ctx, g, s, docType, minW, colorOverride, base, flip, bgColor) {
  const px = g.size * s; if (px < (g.minPx || MIN_TEXT_PX)) return;
  const color = colorOverride || g.color;
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
  if (!font) { font = `${g.italic ? "italic " : ""}${g.bold ? (outline ? "bold " : "600 ") : ""}${g.size * FONT_EM}px ${outline ? cssFamily(g.face) + ", " : ""}${FONT_FAMILY}`; if (FONT_CACHE.size < 512) FONT_CACHE.set(key, font); }
  ctx.font = font;
  ctx.textAlign = h; ctx.textBaseline = "alphabetic";
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
  const lines = g.multiline && g.text.indexOf("\n") >= 0 ? g.text.split("\n") : null;
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
    const y = base0 - g.size * 1.23; ctx.lineWidth = Math.max(g.w || g.size / 8, minW); ctx.strokeStyle = color; ctx.beginPath();
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
export function drawDrawingSheet(ctx, doc, s, minW) {
  const isPcb = doc.type === "pcb";
  const ink = isPcb ? PCB_SHEET : SCH.frame;
  const items = documentDrawingSheet(doc);
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineCap = "butt"; ctx.lineJoin = "miter";
  let width = -1;
  const setWidth = (w) => { const lw = Math.max(w, minW); if (lw !== width) { width = lw; ctx.lineWidth = lw; } };
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
  // DS_PAINTER::DrawBorder (ds_painter.cpp:383-396): the paper outline, last, in the page-limits colour
  ctx.strokeStyle = isPcb ? PCB_PAGE_LIMITS : SCH.pageLimits;
  ctx.lineWidth = minW;
  ctx.strokeRect(0, 0, doc.page[0], doc.page[1]);
}


/** Put the canvas into document space (mm) for a given view — for tool overlays; pass the document as `flipDoc` to match the flipped board view. */
export function setViewTransform(ctx, view, flipDoc) {
  const dpr = view.dpr || 1, s = view.ppm * view.zoom * dpr;
  const tx = view.panX * dpr - view.x0 * s, ty = view.panY * dpr - view.y0 * s;
  if (flipDoc) ctx.setTransform(-s, 0, 0, s, tx + 2 * flipCentre(flipDoc) * s, ty); else ctx.setTransform(s, 0, 0, s, tx, ty);
  return s;
}

export function drawPad(ctx, g, minW) {
  ctx.beginPath(); tracePad(ctx, g);
  if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
  if (!g.fill || g.w === 0.1) { ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(0.05, minW); ctx.stroke(); }
}
