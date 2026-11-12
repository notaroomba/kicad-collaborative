// sch-tools — schematic editing tools for the web editor: wires and buses with
// KiCad's 90° routing and automatic junctions, bus entries, no-connects, labels,
// text, symbol and power-symbol placement, directive labels, graphic shapes
// (rectangle, circle, arc, lines, polygon, bezier, text box, table, rule area,
// image), hierarchical sheets (their file is created on the server first) and
// sheet pins, net highlighting, rotate / mirror / duplicate, the connected drag
// of one item or a multi-selection, KiCad's interactive delete tool and delete
// of the non-symbol items app.js does not select itself.
//
// Registers on window.CollabTools.sch; app.js drives the hooks documented at its
// "editing tools" seam.  Edits are whole-item changes built from a *cloned* node,
// so commit() can still serialise the untouched original as the undo step.  The
// DOM is only touched once a stage is handed over, so the logic runs under node.
//
// Built by 'npm run build:sch-tools' into static/sch-tools.js, a classic script (IIFE) that registers
// window.CollabTools.sch; the modules follow the sections of the original file.
import type { NetHighlighter } from "./types";
import { root } from "../root";
import { actions, runAction } from "./actions";
import { annotate, annotateChanges, clearAnnotation, clearAnnotationChanges, cycleBodyStyle, editFieldPrompt, libUnits, placeNextUnit, showDatasheet, splitRef, stepUnit, toggleSymbolFlag } from "./annotate";
import { autoplaceNode, autoplaceSelection, bodyBox, fieldExtent, globalPowerPin, symbolPins } from "./autoplace";
import { dropCarry, placeCarry, placeText, singleClickPlace, startCarry } from "./carry";
import { assignPastedRef, clipboardText, copyAsText, copySelection, cutSelection, duplicateSelection, parseClipboard, pasteChanges, pasteText, setReference } from "./clipboard";
import { CLIP, clipRead, clipWrite, cursorOf, selectedItems, setSelectionIds } from "./commands";
import { junctionAt, needsJunction, pinsAt } from "./connect";
import { convertNode, convertSelection, validNetname } from "./convert";
import { autostartKind, danglingEnds, drawOverlay } from "./dangling";
import { type PromptFn, autostartAt, isPowerSymbol, onDownCapture, onKeyCapture, onUpCapture, pickSymbol, placeClassLabel, powerSymbols, setPromptImpl } from "./dom";
import { beginDrag, bendPath, cancelDrag, cleanupAt, connPoints, cycleLineMode, endDrag, makeAnchor, mergeAt, modeText, moveDrag, ridersOf, setDragMode, setLineMode } from "./drag";
import { cleanupSheetPins, ercCheck, ercNets, runERC, subsheetDoc, syncSheetPins } from "./erc";
import { fieldsTableChanges, fieldsTableRows, openFieldsTable } from "./fields-table";
import { highlightClick, netItems, pickNet, setHighlight, terminalsOf } from "./highlight";
import { geomDist, hitNonSymbol, pickAny, pickNonSymbol, textRect } from "./hit";
import { busyMessage, onActivate, onDocChanged, onKey, onPointerDown, onPointerMove, onPointerUp, vetoTool, wireKey } from "./hooks";
import { type ImagePickerFn, openImagePicker, setImagePickerImpl } from "./images";
import { analyzePoint, cancelWire, editTxn, explicitJunctionAllowed, explicitJunctionNeeded, finishWire, previewJunctions, txnCleanUp, txnTrimWire } from "./junction";
import { selectConnection, selectNode, stepNetItem } from "./netwalk";
import { SHEET_FILE_OFF, SHEET_NAME_OFF, arcNode, base64ToBytes, bezierNode, busEntryNode, bytesToBase64, circleNode, classLabelNode, imageData, imageNode, imageSize, junctionNode, labelNode, lineNode, noConnectNode, polygonNode, polylineNode, rectangleNode, ruleAreaNode, sheetNode, sheetPinNode, symbolNode, tableNode, drawTableNode, drawTableSize, textBoxNode } from "./nodes";
import { MX, MY, RCCW, anchorOf, cloneNode, mirrorNode, mul, orientOf, orientSymbol, rotateNode, shiftNode, tFrom } from "./orient";
import { ghostSegs } from "./overlay";
import { applyPointEdit, editFollowers, editHandles, editPoints, pointEditEnd, pointEditMove, pointEditStart, textBoxMinSize } from "./point-edit";
import { incrementSelection, incrementText, rememberPlaced, repeatLast } from "./repeat";
import { deleteAt, deleteChanges, deleteSelected, duplicateSelected, orientSelected } from "./selection-edits";
import { cancelDraw, drawClick, finishDraw } from "./shapes";
import { currentDoc, emptySheetDoc, ensureSheetDoc, nextPage, placeSheet, placeSheetPin, relPath, sheetEdgeAt, sheetInstance, sheetPathHere, sheetPinClick, sheetPinPoint } from "./sheets";
import { snapConn } from "./snap";
import { DELETE_CURSOR, S, TOOLS } from "./state";
import { alignEdgeChanges, alignEdges, alignToGrid, alignToGridChanges, breakAgain, breakWire, breakWireChanges, endBreak, halfGrid, moveExactChanges, moveExactly, rotationCentre, selectionCentre, swapChanges, swapNodes, swapSelection, transformChanges, transformNode, transformSelected } from "./transforms";
import { busLabelsOf, busMembers, unfoldAction, unfoldBus, unfoldMembers } from "./unfold";
import { itemSexpr, modChange, ruleAreaId, typeNameFor } from "./util";
import { schArcDrawMode } from "./arcs";
import { PIN_HELPERS, labelShapeForPin, pinAltFunction, pinAlternates, pinAt, pinBox, pinHelper, pinOf, pinProperties, setAltPinFunction, singleNetLabelForPin, swapPinLabels } from "./pins";
import { autoRotateChanges, autoRotateNode, autoRotateOf, labelOrientationForPoint, setAutoRotate, setSpinOfNode, spinOfNode } from "./autorotate";
import { computeBreakPoint, isTerminalPoint, mergeOverlap, simplify, simplifyWireList, sourceLine, startWire, switchPosture, undoSegment, wireClick, wireFollow, wirePoints } from "./wire";

root.CollabTools = root.CollabTools || {};
// built first, then registered: the module carries more than SchToolModule declares (the hooks app.js
// probes for, the commands, and the internals under _ for tests)
const sch = {
  id: "sch", tools: TOOLS.map((t) => ({ id: t.id, label: t.label, key: t.key, icon: t.icon, cursor: t.cursor })),
  onActivate, onPointerDown, onPointerMove, onPointerUp, onKey, drawOverlay, onDocChanged, ghostSegs, vetoTool,
  // for tests and the props panel
  state: S, select(id: string | null) { S.sel = id || null; }, setPrompt(fn: PromptFn) { setPromptImpl(fn); }, setNetHighlighter(h: NetHighlighter | null) { S.netHL = h || null; }, setImagePicker(fn: ImagePickerFn) { setImagePickerImpl(fn); },
  // connected drag engine, shared with app.js's select tool (symbols and sheets; an array drags a multi-selection)
  beginDrag, moveDrag, endDrag, cancelDrag, setDragMode, setLineMode, cycleLineMode, modeText,
  // REMOVED changes (plus junction cleanup) for one item or a multi-selection; the net of an item on this sheet
  deleteChanges, netItems,
  // KiCad's non-tool commands: { id: { id, label, key, run(ctx, opts) -> handled } }; app.js binds menus and keys to them
  actions, runAction, markers() { return S.markers; },
  // clipboard text in the desktop's format and its parser, ERC and annotation as pure functions over a doc
  clipboardText, parseClipboard, ercCheck, annotateChanges, clearAnnotationChanges, fieldsTableRows, fieldsTableChanges, busMembers,
  _: { setFollow(on: boolean) { S.forceFollow = !!on; }, schArcDrawMode, pinAt, pinBox, pinAltFunction, pinOf, pinProperties, pinHelper, PIN_HELPERS, swapPinLabels, singleNetLabelForPin, labelShapeForPin, pinAlternates, setAltPinFunction, labelOrientationForPoint, autoRotateNode, autoRotateChanges, autoRotateOf, setAutoRotate, setSpinOfNode, spinOfNode, textBoxMinSize, globalPowerPin, breakAgain, sourceLine, danglingEnds, endBreak, onKeyCapture, onUpCapture, onDownCapture, selectedItems, setSelectionIds, cursorOf, pasteChanges, pasteText, cutSelection, copySelection, duplicateSelection, copyAsText, incrementText, repeatLast, rememberPlaced,
    convertNode, convertSelection, validNetname, symbolPins, bodyBox, fieldExtent, autoplaceNode, autoplaceSelection, splitRef, setReference, assignPastedRef, annotate, clearAnnotation,
    ercNets, runERC, subsheetDoc, syncSheetPins, cleanupSheetPins, transformNode, transformChanges, transformSelected, selectionCentre, halfGrid, swapNodes, swapChanges, swapSelection,
    alignToGridChanges, alignToGrid, alignEdgeChanges, alignEdges, moveExactChanges, moveExactly, rotationCentre, breakWireChanges, breakWire, openFieldsTable, unfoldMembers, busLabelsOf, unfoldBus, unfoldAction,
    selectConnection, selectNode, stepNetItem, incrementSelection, editFieldPrompt, toggleSymbolFlag, stepUnit, cycleBodyStyle, placeNextUnit, libUnits, showDatasheet, CLIP, clipWrite, clipRead,
    lineNode, junctionNode, noConnectNode, busEntryNode, labelNode, symbolNode, orientSymbol, rotateNode, mirrorNode, cloneNode, shiftNode,
    tFrom, orientOf, mul, RCCW, MX, MY, needsJunction, junctionAt, pinsAt, snapConn, simplify, simplifyWireList, computeBreakPoint, editPoints, editHandles, applyPointEdit, editFollowers, pointEditStart, pointEditMove, pointEditEnd, wireFollow, wireClick, wirePoints, undoSegment, switchPosture, wireKey, isTerminalPoint, mergeOverlap,
    analyzePoint, autostartKind, autostartAt, explicitJunctionNeeded, explicitJunctionAllowed, previewJunctions, editTxn, txnCleanUp, txnTrimWire, singleClickPlace, busyMessage, vetoTool, startWire, cancelWire, hitNonSymbol, textRect, pickNonSymbol,
    beginDrag, moveDrag, endDrag, placeText, bendPath, connPoints, makeAnchor, ridersOf, cleanupAt, mergeAt, startCarry, placeCarry, dropCarry, finishWire, deleteSelected, duplicateSelected, orientSelected, modChange,
    // graphic shapes, directive labels, power symbols and the delete tool
    rectangleNode, circleNode, arcNode, polylineNode, textBoxNode, classLabelNode, placeClassLabel, isPowerSymbol, powerSymbols, pickSymbol,
    drawClick, finishDraw, cancelDraw, deleteChanges, deleteAt, pickAny, geomDist, anchorOf, DELETE_CURSOR,
    // sheets, sheet pins, tables, curves, polygons, rule areas, images and net highlighting
    sheetNode, sheetPinNode, tableNode, drawTableNode, drawTableSize, bezierNode, polygonNode, ruleAreaNode, imageNode, imageData, imageSize, bytesToBase64, base64ToBytes,
    placeSheet, ensureSheetDoc, sheetInstance, sheetPathHere, nextPage, emptySheetDoc, relPath, currentDoc, sheetEdgeAt, sheetPinPoint, sheetPinClick, placeSheetPin,
    openImagePicker, netItems, terminalsOf, pickNet, highlightClick, setHighlight, typeNameFor, ruleAreaId, itemSexpr, SHEET_NAME_OFF, SHEET_FILE_OFF },
};
root.CollabTools.sch = sch;
