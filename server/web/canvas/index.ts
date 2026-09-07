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
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { root } from "./env";
import { PCB_COLORS, PCB_HIDDEN_DEFAULT, SCH, pcbColor, pcbZ } from "./colors";
import { addItem, computeBBox, parseDoc } from "./doc";
import { addChange, boardChangeExtras, createItem, fieldAt, fieldBoxes, groupMemberIds, moveItem, netNameOf, newUuid, pinPoints, pointInQuad, removeChange, replaceChange, typeNameOf, wireEndsAt } from "./edit";
import { SvgPath, renderPng, renderSvg, serialize, serializeItem, wrapFragment } from "./export";
import { buildGeom } from "./geom";
import { hatchLines } from "./geom-pcb";
import { ORIENT, resolveLib, symbolTransform } from "./geom-sch";
import { bboxOf, geomBox, geomHit, hitTest, hitTestDetail, layerList, movableItems, padAt, padGeomHit, snap } from "./hit";
import { applyChange, setAt, setPts } from "./ops";
import { HIDDEN_TEXT_ALPHA, HL_DIM, MARKER_COLORS, MARKER_CORNERS, MARKER_SCALE, PX_PER_MM_ZOOM1, RATSNEST_COLOR, VIA_NETNAME_COLOR, ZONE_OPACITY, brightened, dashPattern, defaultCreateCanvas, drawHalo, drawPad, drawSelectionHalo, flipCentre, flipX, highlightColor, markerAt, markerPolygon, markerScale, render, setViewTransform, trackNameColor, unflipX, zoomFactor } from "./render";
import { arcFrom3, atOf, bezierPts, boxOf, cloneNode, cornersInSequence, effectsOf, fillOf, kid, kids, num, parse, parseAll, pointInPoly, ptsOf, quotedMask, str, strokeOf, uuidOf } from "./sexpr";
import { IMAGE_CACHE, base64Bytes, imageInfo, shiftTable } from "./tables-images";
import { parseMarkup, textWidth } from "./text";
export const api = { parse, parseAll, serialize, serializeItem, parseDoc, setViewTransform, drawSelectionHalo, moveItem, replaceChange, addChange, removeChange, typeNameOf, boardChangeExtras, netNameOf, groupMemberIds, wrapFragment, pinPoints, wireEndsAt, newUuid, createItem, setPts, setAt, atOf, ptsOf, kid, kids, num, str, uuidOf, cloneNode, quotedMask, resolveLib, ORIENT, addItem, applyChange, render, movableItems, hitTest, layerList, snap, computeBBox, PCB_HIDDEN_DEFAULT, SCH, PCB_COLORS,
  // asset hook: set to a function ({ id, kind: "image", ok }) => void; called once an image item's bitmap has
  // decoded (ok) or failed (!ok) after render() drew its placeholder, so the app can request a repaint
  onAssetLoaded: null,
  drawHalo, HL_DIM, brightened, highlightColor, imageInfo, base64Bytes, IMAGE_CACHE, strokeOf, boxOf, cornersInSequence, shiftTable,
  fieldBoxes, fieldAt, pointInQuad, hitTestDetail, geomHit, geomBox,
  // exposed for tests and tools
  symbolTransform, textWidth, parseMarkup, hatchLines, arcFrom3, bezierPts, pcbColor, pcbZ, drawPad, buildGeom, effectsOf, fillOf,
  // display-option helpers (see render()): ratsnest / marker / net-name / zone-preview / flip constants and look-ups
  bboxOf, padAt, padGeomHit, markerAt, markerPolygon, markerScale, zoomFactor, flipX, unflipX, flipCentre, dashPattern, trackNameColor,
  MARKER_CORNERS, MARKER_SCALE, MARKER_COLORS, RATSNEST_COLOR, ZONE_OPACITY, HIDDEN_TEXT_ALPHA, PX_PER_MM_ZOOM1, VIA_NETNAME_COLOR,
  // export: SVG / PNG of the whole document or a subset; createCanvas is the offscreen-canvas factory (replaceable for tests / workers)
  renderSvg, renderPng, SvgPath, createCanvas: defaultCreateCanvas, pointInPoly };
root.KiCadCanvas = api;
