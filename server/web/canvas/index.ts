// kicad-canvas (web/canvas) — parse KiCad s-expression documents (schematic sheets and
// boards) and draw them on a 2D canvas, applying live collaboration ops per item.
//
// Coordinates are millimetres with Y down (KiCad's screen convention) for both
// document types; library symbol geometry (Y up) is mapped through KiCad's own
// orientation matrices.  Nothing here touches the DOM except the canvas context
// handed to render(), so the parser also runs under node for tests.
//
// Placement rules follow eeschema/sch_painter.cpp, eeschema/pin_layout_cache.cpp,
// eeschema/sch_label.cpp and pcbnew/pcb_painter.cpp; colours are KiCad's default
// theme (common/settings/builtin_color_themes.h).
//
// Beyond drawing, the module answers the tools layer's geometry questions (hitTest, padAt, bboxOf,
// fieldAt, markerAt, flipX/unflipX) and exports the document as SVG (renderSvg) or PNG (renderPng);
// render()'s comment lists every display option (ratsnest, markers, netNames, netColors, zoneFill,
// flip, padNumbers, showHiddenText, …).
//
// Package layout: sexpr (parser/serializer + node helpers), text (metrics), colors (KiCad's theme,
// layers, z-order), doc (documents, items, libraries), geom / geom-sch / geom-pcb (geometry builders),
// tables-images, ops (applyChange), edit (tool-layer helpers), hit (hit tests, boxes, fields, pads),
// render (the canvas painter), export (SVG / PNG).  `npm run build:canvas` bundles this entry into
// static/kicad-canvas.js, which the server serves and the node test suites load.
// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { root } from "./env";
import { PCB_BG, PCB_COLORS, PCB_HIDDEN_DEFAULT, SCH, SCH_DEFAULT, SCH_THEMES, pcbColor, pcbZ, schTheme, schThemeColors, setSchTheme, withSchTheme } from "./colors";
import { PAPER_SIZES, addItem, applyDocProps, computeBBox, mm2mils, paperSize, parseDoc, titleBlockOf } from "./doc";
import { addChange, boardChangeExtras, createItem, fieldAt, fieldBoxes, groupMemberIds, moveItem, netNameOf, newUuid, pinPoints, pointInQuad, removeChange, replaceChange, typeNameOf, wireEndsAt } from "./edit";
import { SvgPath, renderPng, renderSvg, serialize, serializeItem, svgDrawingSheet, wrapFragment } from "./export";
import { buildGeom, ensureSchTheme, inSchTheme } from "./geom";
import { hatchLines } from "./geom-pcb";
import { ORIENT, resolveLib, symbolTransform } from "./geom-sch";
import { bboxOf, geomBox, geomHit, geomTouchesRect, itemTouchesRect, itemVisible, hitTest, hitTestDetail, layerList, movableItems, padAt, padGeomHit, snap } from "./hit";
import { applyChange, setAt, setPts } from "./ops";
import { DASH_RATIOS, HIDDEN_TEXT_ALPHA, HL_DIM, MARKER_COLORS, MARKER_CORNERS, MARKER_SCALE, PX_PER_MM_ZOOM1, RATSNEST_COLOR, VIA_NETNAME_COLOR, ZONE_OPACITY, brightened, dashPattern, defaultCreateCanvas, drawDrawingSheet, drawHalo, drawMarkers, drawPad, drawSelectionHalo, selectedColor, flipCentre, flipX, highlightColor, markerAt, markerPolygon, markerScale, render, setViewTransform, trackNameColor, unflipX, zoomFactor } from "./render";
import { boardSetup } from "./board-setup";
import { PlotRecorder, blackAndWhite, dashRuns, itemsBox, luminance, plotItems, plotRecorder, sheetPlotItems } from "./plot-rec";
import { plotParams } from "./plot-params";
import { DRC_ITEMS } from "./drc-items";
import { pcbNetlist } from "./pcb-netlist";
import { schNets } from "./sch-nets";
import { projectFile } from "./project-file";
import { arcFrom3, atOf, bezierPts, boxOf, cloneNode, cornersInSequence, effectsOf, fillOf, kid, kids, num, parse, parseAll, pointInPoly, ptsOf, quotedMask, str, strokeOf, uuidOf } from "./sexpr";
import { DEFAULT_DRAWING_SHEET, PRODUCT_NAME, TB_TOKENS, WS_TOKENS, alphabeticFromIndex, buildDrawingSheet, defaultDrawingSheet, documentDrawingSheet, expandTextVars, incrementLabel, indexFromAlphabetic, parseDrawingSheet, sheetTextPen, sheetTextVars, varResolver } from "./sheet";
import { IMAGE_CACHE, base64Bytes, imageInfo, shiftTable } from "./tables-images";
import { TEXT_INTERLINE, lineOffsets, parseMarkup, textWidth, unescapeText } from "./text";
import { drawStrokeText, linebreakText, parseStrokeMarkup, strokeGlyph, strokeLine, strokeLineWidth, strokeOrigin } from "./stroke-font";
import { displayNetName, netCode } from "./geom-pcb";
import { unitLetter } from "./geom-sch";
import { GRID_MIN_SPACING, GRID_TICK, MIN_TEXT_PX, drawTextStroke, textMode } from "./render";
import { pcbSizes } from "./pcb-sizes";
import { boardItemBox, presenceSelection } from "./kicad-bbox";
import { padModel } from "./pad-model";
import { parseLibSymbol, subUnitBody, PIN_TYPE_NAMES, libGraphicGeom } from "./libsym";
import { footprintDocApi } from "./footprint-doc";
export const api = { parse, parseAll, serialize, serializeItem, parseDoc, applyDocProps, paperSize, titleBlockOf, DASH_RATIOS, setViewTransform, drawSelectionHalo, selectedColor, moveItem, replaceChange, addChange, removeChange, typeNameOf, boardChangeExtras, netNameOf, groupMemberIds, wrapFragment, pinPoints, wireEndsAt, newUuid, createItem, setPts, setAt, atOf, ptsOf, kid, kids, num, str, uuidOf, cloneNode, quotedMask, resolveLib, ORIENT, addItem, applyChange, render, movableItems, hitTest, layerList, snap, computeBBox, PCB_HIDDEN_DEFAULT, SCH, PCB_COLORS, PCB_BG,
  // schematic colour themes (colors.ts): KiCad Default / KiCad Classic / Dark; the painters rebuild stale geometry,
  // renderSvg / renderPng use opts.colorTheme (KiCad Default unless given)
  SCH_DEFAULT, SCH_THEMES, schTheme, schThemeColors, setSchTheme, withSchTheme, ensureSchTheme, inSchTheme,
  // asset hook: set to a function ({ id, kind: "image", ok }) => void; called once an image item's bitmap has
  // decoded (ok) or failed (!ok) after render() drew its placeholder, so the app can request a repaint
  onAssetLoaded: null,
  drawHalo, HL_DIM, brightened, highlightColor, imageInfo, base64Bytes, IMAGE_CACHE, strokeOf, boxOf, cornersInSequence, shiftTable,
  // the drawing sheet (web/canvas/sheet.ts): KiCad's built-in (kicad_wks …) description, its interpreter
  // and the text-variable resolution the title block uses; render()/renderSvg() paint what it returns
  DEFAULT_DRAWING_SHEET, parseDrawingSheet, defaultDrawingSheet, buildDrawingSheet, documentDrawingSheet,
  sheetTextVars, varResolver, expandTextVars, incrementLabel, indexFromAlphabetic, alphabeticFromIndex, sheetTextPen, drawDrawingSheet, svgDrawingSheet,
  PRODUCT_NAME, WS_TOKENS, TB_TOKENS, PAPER_SIZES, mm2mils, TEXT_INTERLINE, lineOffsets,
  fieldBoxes, fieldAt, pointInQuad, hitTestDetail, geomHit, geomBox,
  // exposed for tests and tools
  symbolTransform, textWidth, parseMarkup, hatchLines, arcFrom3, bezierPts, pcbColor, pcbZ, drawPad, buildGeom, effectsOf, fillOf,
  // display-option helpers (see render()): ratsnest / marker / net-name / zone-preview / flip constants and look-ups
  bboxOf, padAt, padGeomHit, markerAt, markerPolygon, markerScale, drawMarkers, zoomFactor, flipX, unflipX, flipCentre, dashPattern, trackNameColor,
  MARKER_CORNERS, MARKER_SCALE, MARKER_COLORS, RATSNEST_COLOR, ZONE_OPACITY, HIDDEN_TEXT_ALPHA, PX_PER_MM_ZOOM1, VIA_NETNAME_COLOR,
  // export: SVG / PNG of the whole document or a subset; createCanvas is the offscreen-canvas factory (replaceable for tests / workers)
  renderSvg, renderPng, SvgPath, createCanvas: defaultCreateCanvas, pointInPoly,
  // KiCad's stroke font (web/canvas/stroke-font.ts): glyphs, markup, line layout, word wrap and the painter.
  // textMode: undefined = stroke font wherever Path2D exists, canvas fonts otherwise; "stroke" / "native" force one
  textMode: undefined, currentTextMode: textMode, strokeGlyph, strokeLine, strokeLineWidth, strokeOrigin, parseStrokeMarkup, linebreakText, drawStrokeText, drawTextStroke,
  unescapeText, displayNetName, netCode, unitLetter, GRID_MIN_SPACING, GRID_TICK, MIN_TEXT_PX,
  // the board editor's track / via sizes, netclass resolution and routing layer pair (web/canvas/pcb-sizes.ts)
  pcbSizes,
  // the Symbol Editor's render mode (web/canvas/libsym.ts): one library symbol as an editable document
  parseLibSymbol, subUnitBody, PIN_TYPE_NAMES, libGraphicGeom };

/** The api with the members assigned below, after the literal (the literal's own type does not have them). */
type Api = typeof api & {
  itemTouchesRect: typeof itemTouchesRect; itemVisible: typeof itemVisible; geomTouchesRect: typeof geomTouchesRect;
  boardItemBox: typeof boardItemBox; presenceSelection: typeof presenceSelection;
  pcbNetlist: typeof pcbNetlist; schNets: typeof schNets; boardSetup: typeof boardSetup; DRC_ITEMS: typeof DRC_ITEMS; projectFile: typeof projectFile; padModel: typeof padModel;
  footprintDoc: typeof footprintDocApi; plot: typeof plotApi;
};
const plotApi = { PlotRecorder, plotRecorder, plotItems, sheetPlotItems, itemsBox, dashRuns, blackAndWhite, luminance, params: plotParams };
(api as Api).itemTouchesRect = itemTouchesRect; (api as Api).itemVisible = itemVisible; (api as Api).geomTouchesRect = geomTouchesRect;
(api as Api).boardItemBox = boardItemBox; (api as Api).presenceSelection = presenceSelection;   // BOARD_ITEM::GetBoundingBox for the presence payload (web/canvas/kicad-bbox.ts)
(api as Api).pcbNetlist = pcbNetlist; (api as Api).schNets = schNets; (api as Api).boardSetup = boardSetup; (api as Api).DRC_ITEMS = DRC_ITEMS; (api as Api).projectFile = projectFile; (api as Api).padModel = padModel;   // the board dialogs' pure halves (web/editor/pcbdialogs)
(api as Api).footprintDoc = footprintDocApi;
(api as Api).plot = plotApi;   // File > Plot / Print: the painter recorded as plot items (web/canvas/plot-rec.ts), the board's plot settings   // the Footprint Editor's document (web/canvas/footprint-doc.ts)
root.KiCadCanvas = api;
