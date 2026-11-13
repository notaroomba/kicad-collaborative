// pcb-tools — board editing tools for the web editor, mirroring pcbnew's
// interactions: route (X) with KiCad's 45° posture, via (V), active layer
// (PgUp/PgDn), rotate (R) / flip (F) of the selected footprint, selection and
// delete of tracks, vias and graphics, expand to the connected run (U), drag a
// segment (D), width cycling (W), graphic line/rect/circle/arc/polygon/bezier
// (Shift+L/R/C, Ctrl+Shift+A/P/B), text (T), text boxes, tables, reference
// images, copper zones (Alt+Z) and rule areas (Ctrl+Shift+K), the five
// dimension tools (orthogonal on Ctrl+Shift+H) and KiCad's interactive delete
// tool.  The non-tool commands of pcbnew live in pcb.actions: clipboard
// (Ctrl+C/X/V/D, KiCad's own kicad_pcb clipboard format), move exactly,
// position relative, align / distribute, group rotate / flip / mirror / swap,
// swap layers, track width / via edits, cleanup tracks & vias, select net /
// connection / unconnected, groups, locks, conversions, the DRC subset, the
// ratsnest and the net inspector, with pad hit-testing and a pad dialog.
//
// Registers on window.CollabTools.pcb.  The geometry and node builders touch no
// DOM and are exported as PcbTools on the global so the node test can drive
// them against a parsed board.  Every node is built the way
// pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp writes the item (child order
// included) with the defaults pcbnew's drawing tool gives a new item.
//
// Built by 'npm run build:pcb-tools' into static/pcb-tools.js, a classic script (IIFE) that registers
// window.CollabTools.pcb and window.PcbTools; the modules follow the sections of the original file.
import type { BoardDoc, FormSpec, PcbChange, PcbCtx, Pt, PtrEvent } from "./types";
import type { RequestOpts, RoutingDialogs } from "./actions";
import type { NewItemDialog } from "./assistants";
import type { PickerFn, PromptFn } from "./dom";
import type { LayerPicker } from "./route-tool";
import type { RouterSettings } from "./router-settings";
import { root } from "../root";
import { highlightNetAt, setDragImpl, swapLayerChanges, footprintByRef, footprintRefChoices, ACTIONS, LOCKED_WARNING, VIA_SIZES, applyTuneSettings, modificationPoint, requestSelection, routingDialogs, runAction, setRoutingDialogsImpl, tuneSettingsView, tunerProperties, unfillChanges, unlockedIds } from "./actions";
import { hoverPoint, liveSelected, netNameOf, nextWidth, sizesOf } from "./app-state";
import { ArcGeom, arcBackup, arcDrawMode, arcFromStartEndCenterDrag, arcFromStartEndMidDrag, arcFromStartTangentEnd, arcMove, arcTangentSeedAt, arcTangentSeedNear, finishArc, setArcDrawMode, showArcMode } from "./arcs";
import { arrayChanges, arrayOrigin, arraySize, arrayStacked, arrayTransform } from "./array";
import { cancelOps, dimensionLabel, newItemDialogs, placeTextAt, setNewItemDialogsImpl } from "./assistants";
import { branchChanges, branchDoc, branchOpFresh, updateHead } from "./branch";
import { addedChange, boardNets, deleteChanges, removedChange, replacedChange, typeNameOf, wrapBoard } from "./changes";
import { annotate, clearNets, clipboardText, cursorPoint, duplicateChanges, freshUuids, layersBlock, parseClipboard, pasteChanges, referencePoint, rewriteNets } from "./clipboard";
import { connectedRun } from "./connected";
import { boardStatistics, convertChanges, footprintAttrChanges, justifyChanges, padAt, selectionLoops, zonePriorityChanges } from "./convert";
import { formImpl, padProperties, setFormImpl } from "./dialogs";
import { DP_MSG_GAP, DP_MSG_NETS, DP_MSG_NOWHERE, DP_MSG_START, dpGateway, dpNetPair, dpPrimitives, dpSizes, findDpPrimitivePair, matchDpSuffix, offsetPts } from "./diffpair";
import { ARROW_LEN, DIM_CLASS, DIM_TYPE, EXT_HEIGHT, EXT_OFFSET, dimBaseText, dimEditNode, dimEditPoints, dimGeometry, dimRead, dimUpdate, dimValueText, dimWrite, dimensionNode, readableAngle, snap45, snap90, snapVec45 } from "./dimensions";
import { arcLength, arcPoints, boxGrid, boxesTouch, coreDist, padCopperLayers, padShape, polyPolyDist, segSegDist, segsIntersect, shapeGap, viaLayers } from "./distances";
import { applySelMode, closeTextPrompt, pickClick, pickInteractively, refreshChip, setPickerImpl, setPromptImpl, routerKeyAction, selMode, undoRedoInFlight } from "./dom";
import { changedArea, dragChanges, dragTo, optimizeDragged } from "./drag-optimize";
import { assembleLine, dragCorner45, dragCornerFree, dragSegment45, dragSolution, dragStart, initialTrace } from "./dragger";
import { ANGLE_SNAP_MSG, DRAWING_TOOL_IDS, MOVE_SNAP_MSG, POLY_TOOLS, RULE_AREA_LAYERS, angleSnapMode, displayConstraintsMsg, build45Leader, constrainDraw, drawTrack, nextLineMode, setAngleSnap, stepDrawWidth, undoChainSegment, withStroke } from "./draw-modes";
import { drawClick, finishPoly, openImagePicker, placeImage, polyOutline, zoneTemplate } from "./draw-tools";
import { circleApprox, circleOutside, clipperArea, ovalApprox, ovalOutside, sliverMarkers, sliverPoints, splitCollinearOutlines } from "./drc-sliver";
import { PolygonTest, connectionWidthMarkers } from "./drc-connwidth";
import { DEFAULT_SETTINGS, boardOutline, chainLoops, courtyards, designSettings, drc, edgeShapes, netClearance, netclassOf, segCross } from "./drc";
import { cycleWidth, deleteSelection, expandSelection, flipSelected, fmtSize, hoverDelete, rotateSelected, routableItems, sizeUnits } from "./edit-commands";
import { messageText } from "../../units";
import { flipFootprintNode, rotateFootprintNode } from "./footprint";
import { angleSnapDirections, bestDragOrigin, itemAnchors, nearestSnapLinePoint, snapAnchors, snapCursor } from "./grid-helper";
import { OffsetItemState } from "./ref-move";
import { applySelection, expandGroups, groupChanges, groupMembers, groupMembersChanges, groupNode, groupOf, isLocked, lockChanges, selectionIds, setLocked, topParentOf, ungroupChanges } from "./groups";
import { deleteAt, deleteCandidate, fieldCandidateId, guessCandidates, hitTestDistance, itemAt } from "./guess";
import { hitTestItem } from "./hit";
import { base64Bytes, imageInfo, imageMm } from "./images";
import { beginToolDrag, dpCoupledSegment, dragCandidate, dragHiddenIds, dragMove, finishDrag } from "./inline-drag";
import { LENGTH_UNCONSTRAINED, TUNE_IU, TUNE_MSG_INSIDE, TUNE_MSG_PICK, TUNE_MSG_SELECT, chLength, chPoints, coupledSegmentPairs, dpMeanderMove, meanderDefaults, meanderMove, setTargetLength, setTargetSkew, splitLine } from "./meander";
import { SELECTION_TYPES, boardLayerName, filterIds, idsOnLayer, inspectClearance, itemDescription, msgPanelInfo } from "./msgpanel";
import { boardFindHits, edaMatches, findStep, netNameCmp, unescapeKiCad } from "./find";
import { flipFieldChange, footprintFieldNode, hideFieldChanges, requestField, rotateFieldChange } from "./field-edit";
import { copperStack, layerDistance, netLengths, stackupItems } from "./net-lengths";
import { clusterRoots, conductors, connectedCopperIds, localRatsnest, netHighlightIds, netInspector, netItemIds, netTable, netlist, ratsnest } from "./netlist";
import { netNode, netOf, netStyle } from "./nets";
import { TEXTBOX_MARGIN, arcNode, circleNode, curveNode, effectsNode, gfxWidth, imageNode, lineNode, polyNode, rectNode, ruleAreaNode, segmentNode, tableGrid, tableNode, textBoxNode, textNode, viaNode, zoneNode, zonePriority, setZoneFillMode, setThieving, thievingOf, zoneFillMode, thievingZoneNode, thievingDefaults, thievingAllowed, THIEVING_FILE_VERSION, THIEVING_NEEDS_VERSION_MSG } from "./nodes";
import { drawGroupFrames, enterGroup, enteredGroupIds, exitGroup, groupBox, selectedTopGroup, withinEnteredGroup } from "./group-edit";
import { adjustColor, courtyardConflicts, clearanceOutlines, drawClearanceOutlines, drawOverlay, drawSnapIndicator, dynamicRatsnest, gridOriginColor, snapTypeOf } from "./overlay";
import { genHiddenIds, selectedTuningPattern, editTuningPattern, tuningEditNode, tuningEditPoints, tuningOutline, genStartEdit, genUpdateEdit, genFinishEdit, genCancelEdit } from "./tuning-edit";
import { addCornerChanges, arcEditGeometry, arcEditMode, canAddCorner, canRemoveCorner, editPointNode, editPoints, removeCornerChanges, setArcEditMode } from "./point-editor";
import { cornerLeg, elemsPts, headElems, roundCorners } from "./posture";
import { antennaRemovals, loopRemovals, removeRedundant } from "./redundant";
import { adoptNetOps, foldMicro, routeHighlight, routeUnhighlight, splitChanges, splitOps } from "./route-fix";
import { netUnder, padsOf, routeLeg, snapTarget } from "./route-geom";
import { drawStatusNote, routeHiddenIds, statusNoteDims } from "./route-preview";
import { endRoute, placeVia, setLayerPickerImpl, routeClick, setLayer, startLayerOf, undoRouteLeg, viaPlan } from "./route-tool";
import { RS_DEFAULTS, cornerStyleName, parseRouterSettings, routerChecks, setRouterSettings } from "./router-settings";
import { beginCarryMove, componentDragHits, finishSelectMove, moveTransform, selectMoveTo, startPendingDrag } from "./select-move";
import { insideConvex, octagon, selfIntersecting, shoveLine, shoveOps, shoveRun, shoveWorld, walkAroundHull } from "./shove";
import { cornerCost, padBreakouts, runSmartPads, smartPadsSingle } from "./smartpads";
import { BOARD_VERSION, DELETE_CURSOR, HIT_MM, K, S, WIDTHS, bind, lastCtx, saturated } from "./state";
import { TOOLS, ghostSegs } from "./tools";
import { PAD_TOOLS, moveAnchorChanges, padToolApi, placePad } from "./pad-tool";
import { exchangeApi } from "./exchange";
import { globalDeletionApi } from "./global-delete";
import { textGraphicsApi } from "./global-text-graphics";
import { layerStyle } from "./util";
import { fpPropsApi } from "./fp-props";
import { fpPadsApi } from "./fp-pads";
import { fpCheckApi } from "./fp-check";
import { fpUsersApi } from "./fp-users";
import { enumActivate, enumDown, enumLeave, enumMove, enumRunning, setEnumParams } from "./fp-enum-tool";
import { newTracer, tracerFlip, tracerPosture, trailAdd } from "./tracer";
import { breakTrackChanges, cleanupChanges, cleanupPlan, trackEditChanges, trackLayerChanges, unusedPadLayerChanges } from "./track-edit";
import { DRCET, DRC_RUN_TEXT, fixDrcEntry, inspectDrcAction, violatingRuleName, applyExclusions, exclusionKey, exclusionOf, legacyExclusion, projectExclusions, readExclusion, withExclusion, withoutExclusions } from "./drc-exclusions";
import { starvedThermalMarkers, isolatedCopperMarkers, padZoneConnection, thermalGap, padOutline } from "./drc-zones";
import { silkClearanceMarkers, silkEdgeMarkers, silkToMaskMarkers, maskBridgeMarkers, silkMaskMarkers, boardElements, maskSetup, primShapes, geomShapes, elementGap } from "./drc-silk";
import { courtyardMarkers, courtyardOutlines, disabledLayerMarkers, effectivePenWidth, holeClearanceMarkers, holeToHoleMarkers, keepoutMarkers, moreDrcMarkers, textDimsMarkers, textMirroringMarkers, textOnEdgeCutsMarkers } from "./drc-more";
import { PCB_KINDS, rotateTextBoxNode, setTextBoxAngleSliding, textBoxAngle, alignBox, alignChanges, anchorOf, distributeChanges, distributeDeltasGaps, distributeDeltasPoints, flipChanges, flipNode, mapNodePoints, mirrorChanges, mirrorNode, moveChanges, moveExactChanges, packChanges, positionRelativeChanges, rotateChanges, rotateNode, selectionCenter, swapChanges, topLeftAnchor, transformChanges, translateNode } from "./transforms";
import { customRouteClearance, pinnedOpt, routedRuleItem, rulePairClearance, ruleSizes } from "./rule-resolver";
import { assertionMarkers, disallowMarkers, padAnnulus, ruleItems, sizeMarkers, trackAngleMarkers } from "./drc-rules";
import { callFunc, footprintSelector, itemShape } from "./dru-eval";
import { diffPairMarkers, evalRuleConstraint, matchedLengthMarkers, parseCondition, parseDru, ruleMatches, wildMatch } from "./dru";
import { isTuningPattern, regenerateTuningChanges, setCustomRules, tuneClick, tuneHiddenIds, tuneStatus, tuneMove, tuningPatternInfo, tuningRemoveChanges } from "./tuning-patterns";
import { TUNE_MSG_DP_NETS, TUNE_MSG_SKEW_NETS, TUNE_MSG_SKEW_PICK, assembleDiffPair, coupledLength, isTuneTool, tunePieces, tuningPatternNode } from "./tuning-tool";
import { LINE_W, TEXT_STYLE, flipLayerName, layerClass, layerOf, norm180, norm360, pt, r6, textStyle, useFootprintEditorDefaults, widthOf } from "./util";
import { dir8, hullOf, isFreePad, legPts, pathClear, pathHits, routeClearance, routeObstacles, routerWorld, simplifyPts, walkHead, walkTo } from "./walkaround";
import { uniqueZoneName, subtractOutline } from "./zone-modes";
import { unrouteSegment, itemRatsnestAnchors } from "./route-selected";
import { enabledLayerPairs, resetLayerPairCycle, itemOnLayer } from "./snap-pairs";

/** Every pad picked on its own ("footprintId#padIndex"), the last one picked first; those picked before it with
 *  Shift count while it is still the picked pad. */
function selectedPadKeys(): string[] {
  if (!S.padSel) return [];
  const also = S.padAlso && S.padAlso.anchor === S.padSel ? S.padAlso.keys : [];
  return [S.padSel, ...also.filter((k) => k !== S.padSel)];
}

/**
 * EDIT_TOOL::Drag (PCB_ACTIONS::drag45Degree, D, and dragFreeAngle, G): one footprint is dragged with its tracks, tracks
 * and a via go to the router's inline drag (45 degree or free angle); with nothing selected the routable item under the
 * cursor is dragged, or a footprint there is hover-dragged.  False lets the key through (a selection that is not routable).
 */
function dragKey(ctx: PcbCtx, free: boolean): boolean {
  bind(ctx); if (!ctx.doc) return false;
  const editing = () => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
  const ids = selectionIds(ctx); const it = liveSelected();
  if (!S.sel.size && it && ids.size === 1 && ctx.doc.items.get(it.id)?.kind === "footprint") return editing() && beginCarryMove(ctx, { drag: true });
  if (ids.size && !routableItems(ctx.doc, ids)) return false;
  if (!ids.size && !dragCandidate(ctx, cursorPoint(ctx))) {   // nothing routable under the cursor: a footprint there is hover-dragged
    if (!editing()) return true;
    const sel = requestSelection(ctx, { filter: (x: KItem) => x.kind === "footprint" || x.kind === "group" });
    if (sel && sel.items.length === 1 && sel.items[0]!.kind === "footprint") { applySelection(ctx, sel.ids); beginCarryMove(ctx, { ids: sel.ids, drag: true, hover: true }); }
    return true;
  }
  if (editing()) { S.dragFree = free; ctx.setTool("drag"); }
  return true;
}
setDragImpl(dragKey);

export const pcb = {
  id: "pcb", tools: TOOLS, state: S, ghostSegs,
  /** The KICURSOR a running tool switched to (null: its declared one): MOVING while a move, a drag or a placed image rides the cursor. */
  /**
   * VIEW_CONTROLS::GetCursorPosition while a tool forces it: a move's snapped reference (EDIT_TOOL ForceCursorPosition
   * of m_cursor), the routed head, or a tool's resolved cursor (the grid helper's magnetic snap); null: the grid snap.
   */
  cursorPos(): Pt | null {
    const m = S.move; if (m) return [r6(m.start[0]! + m.last[0]!), r6(m.start[1]! + m.last[1]!)];
    if (S.route && S.route.cursor) return S.route.cursor.slice();
    if (S.modTool && S.hover && S.modTool !== "drag") return [S.hover.x, S.hover.y];
    return null;
  },
  cursorNow(): string | null { const st = S as unknown as { move?: unknown; drag?: unknown; image?: unknown }; return st.move || st.drag || st.image ? "MOVING" : null; },
  /** Drag (D / G) of the selected footprints and vias with their tracks attached; false when nothing can be dragged. */
  dragSelection(ctx: PcbCtx) { bind(ctx); if (ctx.viewOnly || !ctx.doc) return false; return beginCarryMove(ctx, { drag: true }); },
  /** Drag 45 Degree / Drag Free Angle from a menu: the router's drag of the selected tracks or via. */
  inlineDrag(ctx: PcbCtx, free: boolean) { bind(ctx); if (ctx.viewOnly || !ctx.doc) return false; S.dragFree = !!free; ctx.setTool("drag"); return S.modTool === "drag"; },
  /** A press on a multi-item app selection (a box selection): a routable one arms the router's drag instead of a Move. */
  routableDown(ev: PtrEvent, mm: Pt, ctx: PcbCtx, ids: string[]) {
    bind(ctx); if (!ctx.doc || ctx.viewOnly || !ctx.live || !routableItems(ctx.doc, ids)) return false;
    S.pending = { ids: Array.from(ids), item: ctx.doc.items.get(ids[0]), mm: mm.slice(), client: [ev.clientX || 0, ev.clientY || 0], app: true }; return true;
  },
  /** What the canvas leaves out while it is drawn elsewhere (the lines being dragged). */
  hiddenIds() { return routeHiddenIds() || tuneHiddenIds() || genHiddenIds() || dragHiddenIds(); },
  onActivate(t: string, ctx: PcbCtx) {
    bind(ctx);
    const mine = TOOLS.some((x) => x.id === t);
    if (S.route && t !== (S.route.dp ? "routediff" : "route")) { const rt = S.route; S.route = null; routeUnhighlight(ctx, rt); }   // leaving the tool drops the unfixed leg
    S.violations = null;
    if (!isTuneTool(t) || t !== S.modTool) { S.tune.pattern = null; S.tune.picker = null; }
    if (S.drag && t !== "drag") { const D = S.drag; S.drag = null; routeUnhighlight(ctx, D.subs[0]); }
    S.zoneMode = t === "zone" ? S.zoneModeNext || null : null; S.zoneModeNext = null;
    S.draw = null; S.strokeW = null; closeTextPrompt(); S.hover = null; if (t !== "image") S.image = null;
    if (enumRunning() && t !== "enumpads") enumLeave(ctx, true);   // EnumeratePads: another tool pushes the step (Esc reverted it already)
    S.modTool = mine ? t : null;
    if (DRAWING_TOOL_IDS.has(t)) displayConstraintsMsg(ANGLE_SNAP_MSG[angleSnapMode()]!);   // DRAWING_TOOL::Reset( RUN ) -> UpdateStatusBar
    if (t === "enumpads") enumActivate(ctx);
    // PAD_TOOL::PlacePad: the master pad type of the action, and the pad selected as the tool starts (Add Pad copies it)
    S.padPlace = PAD_TOOLS[t] ? { type: PAD_TOOLS[t], angle: 0 } : null;
    if (PAD_TOOLS[t]) { const selPad = [...S.sel].map((id) => ctx.doc && ctx.doc.items.get(id)).find((it) => it && it.kind === "pad"); S.padTemplate = selPad ? selPad.node : null; if (ctx.setStatus) ctx.setStatus("Place pad"); }
    if (t === "garc") showArcMode(ctx);
    if (t === "thievingzone" && !ctx.viewOnly && !thievingAllowed(ctx.doc)) { S.modTool = null; ctx.toast(THIEVING_NEEDS_VERSION_MSG); ctx.setTool("select"); return; }
    if (t === "drag" && !beginToolDrag(ctx, !!S.dragFree)) { S.modTool = null; ctx.toast("Select a track or a via first, or point at one, then press D to drag it"); ctx.setTool("select"); return; }
    refreshChip(ctx); ctx.requestRender();
    if (t === "image" && !S.image && !ctx.viewOnly) openImagePicker();   // KiCad opens the file dialog as the tool starts
  },
  onPointerDown(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
    bind(ctx); const t = S.modTool; if (!t || ev.button !== 0 || !ctx.doc) return false;
    if (typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY!];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "routediff" || t === "via" || t === "gridorigin" || t === "drillorigin" || t === "pickpoint" || t === "anchor" || !!PAD_TOOLS[t], ev); S.hover = hv;
    if (t === "enumpads") { enumDown(ev, mm, ctx); return true; }
    if (t === "route" || t === "routediff") routeClick(ctx, hv, mm);
    else if (isTuneTool(t)) tuneClick(ctx, mm);
    else if (t === "gridorigin") { sizesOf(ctx).setGridOrigin([hv.x, hv.y]); ctx.toast(`Grid origin set to ${fmtSize(hv.x, true)}, ${fmtSize(hv.y)}`); ctx.setTool("select"); }
    else if (t === "drillorigin") { if (!ctx.viewOnly) { sizesOf(ctx).setAuxOrigin([hv.x, hv.y]); ctx.toast(`Drill/place file origin set to ${fmtSize(hv.x, true)}, ${fmtSize(hv.y)}`); } ctx.setTool("select"); }
    else if (t === "via") placeVia(ctx, hv);
    else if (PAD_TOOLS[t] && S.padPlace) { if (!ctx.viewOnly) placePad(ctx, S.padPlace.type, [hv.x, hv.y], S.padPlace.angle); }   // IPO_REPEAT: the tool stays armed
    else if (t === "anchor") { if (!ctx.viewOnly) { const ch = moveAnchorChanges(ctx.doc, [hv.x, hv.y]); if (ch.length) ctx.commit(ch, "Move Footprint Anchor"); } ctx.setTool("select"); }
    else if (t === "drag") { if (S.drag) { dragMove(ctx, mm); if (S.drag.moved) finishDrag(ctx, true, !!(ev.ctrlKey || ev.metaKey)); } else ctx.setTool("select"); }   // a click after motion fixes the drag
    else if (t === "gtext") placeTextAt(ctx, [hv.x, hv.y]);
    else if (t === "image") { if (S.image) placeImage(ctx, hv); else openImagePicker(); }
    else if (t === "pickpoint" || t === "pickitem") pickClick(ctx, t, hv, mm);
    else if (t === "delete") deleteAt(ctx, mm);   // an empty click is ours too: the tool stays armed
    else drawClick(ctx, hv, t, ev);
    return true;
  },
  /** Select tool, nothing on a footprint's own geometry under the cursor: pick a track / via / graphic and arm its drag. */
  /**
   * A click on a pad selects the pad (PCB_SELECTION_TOOL treats PCB_PAD_T as a selectable item; the Selection Filter's
   * Pads box gates it).  Returns "box" for a press on a pad that was not selected (DRAG_SELECTED: a drag draws a box),
   * true when it already was, false when no pad is under the cursor or pads are filtered out.
   */
  selectPadAt(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
    bind(ctx); if (!ctx.doc || (ev.button !== undefined && ev.button !== 0)) return false;
    if ((ctx.selFilter || {}).pads === false) return false;
    let pad = null; try { pad = K.padAt ? K.padAt(ctx.doc, mm[0], mm[1]) : null; } catch (e) { pad = null; }
    if (!pad || !pad.item || pad.index === undefined) return false;
    const allowed = root.CollabEditor && root.CollabEditor.pickAllowed; if (allowed && !allowed(pad.item)) return false;
    const key = pad.item.id + "#" + pad.index, was = S.padSel === key;
    // Shift adds, as in KiCad: the pads picked before stay selected with this one, and so does what else is selected
    if (selMode(ev) === "add") {
      const before = selectedPadKeys().filter((k) => k !== key);
      S.padAlso = before.length ? { anchor: key, keys: before } : null;
    } else { S.sel.clear(); S.padAlso = null; }
    S.padSel = key; S.downHandled = ev; ctx.requestRender();
    return was ? true : "box";
  },
  /** Every pad picked on its own, as "footprintId#padIndex": the last one picked first. */
  selectedPadKeys() { return selectedPadKeys(); },
  // PCB_CONTROL::InteractiveDelete brightens the item a click would remove
  // VIEW_CONTROLS::ForceCursorPosition: the cursor sits where the tool snapped (a move's anchor, a tool's hover point)
  toolCursorPoint() { if (S.move && S.move.snapAt) return [S.move.snapAt[0], S.move.snapAt[1]]; if ((S.modTool || S.route || S.drag) && S.hover) return [S.hover.x, S.hover.y]; return null; },
  /** RENDER_SETTINGS::isInEnteredGroup: the entered group's members (the rest is drawn at the Outside Group opacity), or null. */
  enteredGroupIds(doc: BoardDoc) { return enteredGroupIds(doc); },
  selectedTopGroup(ctx: PcbCtx) { bind(ctx); return ctx.doc ? selectedTopGroup(ctx) : null; },
  /** A double-click on a group member (PCB_SELECTION_TOOL: a lone selected PCB_GROUP -> EnterGroup, then selectPoint). */
  enterGroupAt(ctx: PcbCtx, id: string) {
    bind(ctx); if (!ctx.doc) return false; const it = ctx.doc.items.get(id); if (!it) return false;
    const top = it.kind === "group" ? it : topParentOf(ctx.doc, id); if (!top || top.kind !== "group") return false;
    enterGroup(ctx, top.id);
    // selectPoint inside the group: the item itself, or the sub-group it belongs to
    const pick = topParentOf(ctx.doc, id) ? Array.from(expandGroups(ctx.doc, [id])) : [id];
    applySelection(ctx, pick); return true;
  },
  /** PCB_SELECTION_TOOL::selectPoint: a click outside the entered group's box leaves the group. */
  leaveGroupOutside(mm: Pt, ctx: PcbCtx) {
    bind(ctx); if (!S.enteredGroup || !ctx.doc) return false; const b = groupBox(ctx.doc, S.enteredGroup);
    if (b && mm[0] >= b[0] && mm[0] <= b[2] && mm[1] >= b[1] && mm[1] <= b[3]) return false;
    return exitGroup(ctx, false);
  },
  /**
   * FilterCollectorForHierarchy's entered-group rule: with a group entered, only items within its scope (PCB_GROUP::
   * WithinScope, members to any depth) may be picked by a box or Select All; with none entered the ids pass unchanged.
   */
  withinEnteredGroup(doc: BoardDoc, ids: string[]) { return withinEnteredGroup(doc, ids); },
  /** Esc with nothing selected leaves the entered group (PCB_SELECTION_TOOL::Main). */
  exitGroup(ctx?: PcbCtx) { return exitGroup(ctx || null, false); },
  brightenedIds() { return S.modTool === "delete" && S.hover && S.hover.del && S.hover.del.id ? [S.hover.del.id] : []; },
  /** The selected pad as { item, index }, or null. */
  selectedPad(doc: BoardDoc) { const k = S.padSel; if (!k || !doc) return null; const i = k.lastIndexOf("#"); const it = doc.items.get(k.slice(0, i)); return it ? { item: it, index: +k.slice(i + 1) } : null; },
  onSelectDown(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
    bind(ctx); if (!ctx.doc || (ev.button !== undefined && ev.button !== 0)) return false;
    const it = hitTestItem(ctx.doc, mm[0], mm[1], HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
    if (!it) return false;
    const allowed = root.CollabEditor && root.CollabEditor.pickAllowed; if (allowed && !allowed(it)) return false;   // the Selection Filter pane (kinds, locked items, hidden objects)
    const f = ctx.selFilter || {};
    if ((it.kind === "segment" || it.kind === "arc") && f.tracks === false) return false;
    if (it.kind === "via" && f.vias === false) return false;
    if (it.kind === "zone" && f.zones === false) return false;
    if ((it.kind === "gr_text" || it.kind === "gr_text_box") && f.text === false) return false;
    if (/^gr_/.test(it.kind) && it.kind !== "gr_text" && it.kind !== "gr_text_box" && f.graphics === false) return false;
    S.downHandled = ev;
    // MOUSE_DRAG_ACTION::DRAG_SELECTED (KiCad's default left drag): a drag that starts on the selection drags it; on
    // anything not selected it draws a selection box.  The press still picks the item, as the click would.
    const wasSelected = S.sel.has(it.id), mode = selMode(ev);   // Shift adds, Ctrl toggles, Ctrl+Shift removes
    if (mode !== "add") S.padSel = null;                          // Shift adds to the pads picked, too
    // FilterCollectorForHierarchy: a member of a group or generator (a tuning pattern's meander) selects its parent,
    // which in this selection model is the parent's id with all its members
    const pick = topParentOf(ctx.doc, it.id) ? Array.from(expandGroups(ctx.doc, [it.id])) : [it.id];
    if (mode) { const on = mode === "toggle" ? !S.sel.has(it.id) : mode === "add"; for (const id of pick) applySelMode(S.sel, id, mode === "toggle" ? (on ? "add" : "remove") : mode); }
    else if (!wasSelected) S.sel = new Set(pick);
    if (ctx.setSelection && !mode && !wasSelected) ctx.setSelection([]);   // the module owns this pick; app.js's selection empties
    S.pending = (!ctx.viewOnly && ctx.live && !mode && wasSelected) ? { ids: Array.from(S.sel), item: it, mm: mm.slice(), client: [ev.clientX || 0, ev.clientY || 0] } : null;
    ctx.requestRender(); return (wasSelected || mode) ? true : "box";
  },
  onPointerMove(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
    bind(ctx); const t = S.modTool; if (!t || !ctx.doc) return;
    if (ev && typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY!];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "routediff" || t === "via" || t === "gridorigin" || t === "drillorigin" || t === "pickpoint" || t === "anchor" || !!PAD_TOOLS[t], ev); S.hover = hv;
    if (t === "enumpads") enumMove(ev, mm, ctx);
    if (t === "delete") hv.del = ctx.viewOnly ? null : deleteCandidate(ctx, mm);
    if (S.violations && Math.hypot(hv.x - S.violations.at[0], hv.y - S.violations.at[1]) > 0.5) S.violations = null;
    if (S.route) { S.route.cursor = [hv.x, hv.y]; updateHead(ctx); }
    if (S.drag) dragMove(ctx, mm);
    if (isTuneTool(t)) tuneMove(ctx, mm);
    if (S.draw) { S.drawRaw = [hv.x, hv.y]; S.drawCtrl = !!(ev && (ev.ctrlKey || ev.metaKey)); if (S.draw.shape === "garc") arcMove(S.draw, S.drawRaw, S.drawCtrl); else drawTrack(S.draw, S.drawRaw, S.drawCtrl); }
    ctx.requestRender();
  },
  onPointerUp() {},
  onKey(k: string, ev: PtrEvent, ctx: PcbCtx) {
    bind(ctx); if (!ctx.doc) return false;
    const editing = () => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
    const shift = !!ev.shiftKey;
    if (S.padPlace && (k === "r" || k === "R")) { S.padPlace.angle = (S.padPlace.angle + (shift ? -90 : 90) + 360) % 360; ctx.requestRender(); return true; }   // IPO_ROTATE
    switch (k) {
    case "x": case "X": if (!shift) { ctx.setTool("route"); return true; } return false;
    // V: ACT_PlaceThroughVia while the router is active (a via rides the head; idle, the next route starts with one),
    // elsewhere PCB_ACTIONS::layerToggle (the spec table); Place Vias is Ctrl+Shift+X
    case "v": case "V": if (shift) return false; if (S.route || S.modTool === "route" || S.modTool === "routediff") { if (editing()) runAction("ACT_PlaceThroughVia", ctx); return true; } return false;
    case "<": if (S.route) { if (editing()) runAction("ACT_SelLayerAndPlaceThroughVia", ctx); return true; } return false;
    case "ViaTool": ctx.setTool("via"); return true;
    case "d": case "D": case "g": case "G":
      if (shift) return false;
      return dragKey(ctx, k === "g" || k === "G");
    case "q": case "Q": if (!shift && !(ev.ctrlKey || ev.metaKey || ev.altKey) && (S.route || S.modTool === "route" || S.modTool === "routediff")) return runAction("ACT_CustomTrackWidth", ctx); return false;
    case "t": case "T": if (!shift) { ctx.setTool("gtext"); return true; } return false;
    case "L": if (shift) { ctx.setTool("gline"); return true; } return false;
    // @ts-expect-error -- TS7029: the fall-through to "r" below is intended
    case "R": if (shift) { ctx.setTool("grect"); return true; }
      // fall through: plain R (caps lock) rotates like r
    case "r": return editing() && rotateSelected(ctx);   // false lets app.js's orientation-only fallback run when nothing applies
    case "Circle": ctx.setTool("gcircle"); return true;
    case "Arc": ctx.setTool("garc"); return true;
    case "Polygon": ctx.setTool("gpoly"); return true;
    case "Bezier": ctx.setTool("gcurve"); return true;
    case "Ortho": ctx.setTool("dimortho"); return true;
    case "Zone": ctx.setTool("zone"); return true;
    case "RuleArea": ctx.setTool("rulearea"); return true;
    case "Flip": return editing() && flipSelected(ctx);
    case "/": if ((ev.ctrlKey || ev.metaKey) && (S.modTool === "route" || S.modTool === "routediff")) return runAction("ACT_SwitchCornerModeToNext", ctx);
      if (S.modTool === "garc" && !(ev.ctrlKey || ev.metaKey)) return runAction(ev.altKey ? "cycleArcDrawMode" : "arcPosture", ctx);
      if (S.route) { const rt = S.route; tracerFlip(rt.tracer, rt.head && rt.head.length > 1 ? dir8(rt.head[0], rt.head[1]) : -1); updateHead(ctx); ctx.requestRender(); return true; } return false;   // ACT_SwitchPosture, until the next fix
    case "PageUp": return runAction("layerTop", ctx);
    case "PageDown": return runAction("layerBottom", ctx);
    case "+": return runAction("layerNext", ctx);
    case "-": return runAction("layerPrev", ctx);
    case "1": case "2": case "3": case "4":
      if (!isTuneTool(S.modTool) || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
      return runAction(({ 1: "spacingIncrease", 2: "spacingDecrease", 3: "amplIncrease", 4: "amplDecrease" } as Record<string, string>)[k], ctx);
    case "Tab": return S.moveSeq ? runAction("skip", ctx) : false;   // PCB_ACTIONS::skip while moving individually
    case "End": if (S.route) { if (editing()) endRoute(ctx, true); return true; } return false;
    case "u": case "U": return expandSelection(ctx) || (selectionIds(ctx).size ? runAction("selectConnection", ctx) : false);   // app.js's selection goes through the action
    case "w": case "W": if (editing()) cycleWidth(ctx, shift ? -1 : 1); return true;
    // the non-tool commands on KiCad's hotkeys (Ctrl / Alt chords arrive re-posted from the capture handler)
    case "Copy": return runAction("copy", ctx);
    case "Cut": return runAction("cut", ctx);
    case "Paste": return runAction("paste", ctx);
    case "PasteSpecial": return runAction("pasteSpecial", ctx);
    case "Duplicate": return runAction("duplicate", ctx);
    case "Swap": return runAction("swap", ctx);
    case "M": return shift ? runAction("moveExactly", ctx) : false;
    case "P": return shift ? runAction("positionRelative", ctx) : false;
    case "p": return runAction("pack", ctx);
    case "l": return runAction("toggleLock", ctx);
    case "o": return runAction("selectUnconnected", ctx);
    case "O": return shift ? runAction("grabUnconnected", ctx) : runAction("selectUnconnected", ctx);
    case "`": return runAction("highlightNet", ctx);
    case "~": return runAction("clearHighlight", ctx);
    case "'": return runAction("viaSizeInc", ctx);
    case "\\": return runAction("viaSizeDec", ctx);
    case "Enter":   // ACTIONS::cursorClick: a click where the cursor is (it fixes the head and routing goes on)
      if (S.route) { if (editing()) { const rt = S.route; const hv = S.hover || { x: rt.cursor[0], y: rt.cursor[1], snap: null }; routeClick(ctx, hv, [hv.x, hv.y], { enter: true }); } return true; }
      if (S.draw && S.draw.shape === "garc") { finishArc(ctx, editing); return true; }
      if (S.draw) { if (POLY_TOOLS.has(S.draw.shape)) { if (editing()) finishPoly(ctx); } else { S.draw = null; ctx.requestRender(); } return true; }
      if (S.drag) { if (editing()) finishDrag(ctx, true, false); return true; }
      return false;
    // @ts-expect-error -- TS7029: the fall-through to "Delete" below is intended
    case "Backspace":
      if (S.route) { if (editing()) undoRouteLeg(ctx); return true; }   // routerUndoLastSegment: silent with nothing fixed
      if (!S.draw && !S.move && !ev.shiftKey && !ctx.viewOnly && unrouteSegment(ctx)) return true;   // PCB_ACTIONS::unrouteSegment on selected tracks / vias
      // fall through: deleteLastPoint and doDelete are the same while drawing; with nothing drawn Backspace deletes like Delete
    case "Delete":
      if (S.draw && S.draw.shape === "garc") { arcBackup(ctx); return true; }   // ARC_MODE_SESSION::RemoveLastPoint
      // DeleteLastCorner: the last corner goes and the leader is drawn again from the one before; the first ends the shape
      if (S.draw && (POLY_TOOLS.has(S.draw.shape) || S.draw.shape === "gcurve")) {
        const d = S.draw; if (d.pending) return true;
        if (d.pts.length > 1) { d.pts.pop(); if (POLY_TOOLS.has(d.shape)) drawTrack(d, d.cur, !!S.drawCtrl); } else S.draw = null;
        ctx.requestRender(); return true;
      }
      // deleteLastPoint / doDelete in a line chain: take the last committed segment back; with none, end the line
      if (S.draw && S.draw.shape === "gline") { if (editing() && !undoChainSegment(ctx)) { S.draw = null; ctx.requestRender(); } return true; }
      if (S.route) { if (editing()) undoRouteLeg(ctx); return true; }   // ACTIONS::doDelete while routing: undo the last segment
      if (shift && selectionIds(ctx).size && connectedRun(ctx.doc, selectionIds(ctx)).size) return runAction("deleteFull", ctx);   // Shift+Delete: the whole connected run
      if (S.sel.size) { if (editing()) deleteSelection(ctx); return true; }
      if (ctx.selection && ctx.selection.size) { if (editing()) { const free = unlockedIds(ctx, Array.from(ctx.selection)); if (free.length) { ctx.commit(deleteChanges(ctx.doc, free), "delete"); applySelection(ctx, []); } } return true; }   // app.js's box selection of one item
      if (!selectionIds(ctx).size && !S.padSel) { if (editing()) hoverDelete(ctx); return true; }   // nothing selected: what is under the cursor
      return false;
    default: return false;
    }
  },
  drawOverlay,
  undoRedo(ctx: PcbCtx, which: string) { bind(ctx); return undoRedoInFlight(ctx, which); },
  // Called when a document loads and again after every applied change (our own commits included):
  // only a new document object resets the tool state; an update just prunes what vanished.
  onDocChanged(ctx: PcbCtx) {
    bind(ctx); S.ratsDirty = true; S.docVer++;
    if (S.route && ctx.doc === S.doc) { routeHighlight(ctx, S.route); if (S.route.cursor) updateHead(ctx); }   // the routed net stays bright as legs are fixed (or a peer edits)
    if (ctx.doc !== S.doc) { S.doc = ctx.doc; cancelOps(); S.sel.clear(); S.padSel = null; S.hover = null; S.markers = []; S.hiddenNets.clear(); S.highlightNet = null; }
    else if (ctx.doc) {
      for (const id of Array.from(S.sel)) if (!ctx.doc.items.has(id)) S.sel.delete(id);
      if (S.drag && S.drag.subs.some((d) => Array.from(d.ids).some((id) => !ctx.doc.items.has(id)))) { const D = S.drag; S.drag = null; routeUnhighlight(ctx, D.subs[0]); }   // a peer removed what is being dragged
      if (S.move && [...S.move.orig.keys()].some((id) => !ctx.doc.items.has(id))) S.move = null;
      S.pending = null;
    }
    refreshChip(ctx);
  },
  // app.js deletes a multi-selection through this; the prompt and the image picker are swappable for tests
  deleteChanges,
  // the app's drag of a mixed selection, and Move: everything selected goes along (sticky = follows the cursor until a click)
  beginMove(ctx: PcbCtx, at: Pt, sticky: boolean) { bind(ctx); return beginCarryMove(ctx, { at, sticky }); },
  /**
   * DRAWING_TOOL::PlaceImportedGraphics after the dialog: the shapes (in a new group when asked and there are two or
   * more) committed where they are, or, with interactive placement, hung on the cursor by the file's origin until a
   * click places them as one "Import Graphics" step.
   */
  placeImported(ctx: PcbCtx, nodes: SNode[], opts: { interactive: boolean; group: boolean; label?: string }) {
    bind(ctx); const doc = ctx.doc; if (!doc || ctx.viewOnly || !nodes.length) return false;
    const label = opts.label || "Import Graphics", at = opts.interactive ? cursorPoint(ctx) : null;
    const changes: PcbChange[] = [], ids: string[] = [];
    for (const n of nodes) { if (at) translateNode(n, at[0], at[1]); const c = addedChange(doc, n); changes.push(c); ids.push(c.id); }
    let sel = ids.slice();
    if (opts.group && ids.length >= 2) { const g = addedChange(doc, groupNode("", ids)); changes.push(g); sel = [g.id]; }
    if (!at) { ctx.commit(changes, label); applySelection(ctx, sel); return true; }
    ctx.commit(changes, label, { tentative: true }); applySelection(ctx, sel); beginCarryMove(ctx, { placing: ids.slice(), at });
    return true;
  },
  unlockedIds(ctx: PcbCtx, ids: string[], quiet: boolean) { bind(ctx); return unlockedIds(ctx, ids, quiet); },
  /** RequestSelection for an app-side action (Properties): { ids, items, hover } or null; opts as requestSelection. */
  requestSelection(ctx: PcbCtx, opts?: RequestOpts) { bind(ctx); return requestSelection(ctx, opts); },
  setPrompt(fn: PromptFn) { setPromptImpl(fn); },
  setImagePicker(fn: PickerFn) { setPickerImpl(fn); },
  cancel() { cancelOps(); },              // drop whatever is in flight and put a moved item back (a lost button release, Escape)
  // ---- the parity pass: commands, queries and dialogs app.js can call
  actions: ACTIONS,                       // { id: { label, key, run(ctx) -> handled } }, KiCad's ids and default hotkeys
  runAction,                              // runAction(id, ctx): run with error reporting
  // the toolbar's layer selector: a copper layer is the routing layer, any other the one the graphic tools draw on
  setLayer(ctx: PcbCtx, layer: string) {
    bind(ctx); if (!layer) return; const R = sizesOf(ctx);
    if (/\.Cu$/.test(layer)) { if (layer !== (S.route ? S.route.layer : S.layer) || R.activeLayer !== layer) setLayer(ctx, layer); return; }
    if (R.activeLayer === layer && S.gfxLayer === layer) return;
    S.gfxLayer = layer; R.setActiveLayer(layer); refreshChip(ctx); ctx.requestRender();
  },
  sizes: () => K.pcbSizes.state,
  setRoutingDialogs(d: RoutingDialogs | null | undefined) { setRoutingDialogsImpl(Object.assign({}, routingDialogs, d || {})); },
  /** The editor's properties dialogs for new items: { gr_text(ctx, node, done) } (done gets the edited node, or null). */
  setNewItemDialogs(d: Record<string, NewItemDialog | undefined> | null | undefined) { setNewItemDialogsImpl(Object.assign({}, newItemDialogs, d || {})); },
  /** The interactive router's settings (ROUTING_SETTINGS), and changing them (persisted per viewer). */
  routerSettings() { return Object.assign({}, S.rs); },
  setRouterSettings(patch: Partial<RouterSettings> | null | undefined) { setRouterSettings(patch || {}); },
  routerDefaults: () => Object.assign({}, RS_DEFAULTS),
  /** Check marks of the router mode and corner mode actions, by KiCad action name. */
  routerChecks,
  /**
   * DIFF_PAIR_MENU ("Select Differential Pair Dimensions", the router's menu while routing pairs): Use Net Class Values,
   * Use Custom Values... (which opens the dialog), then the list's entries.  [{ label, tip, checked, run() } | { sep: true }].
   */
  diffPairMenu(ctx: PcbCtx) {
    bind(ctx); const R = sizesOf(ctx); const u = sizeUnits(); const fmt = (v: number) => messageText(v, u === "mil" ? "mil" : u === "in" ? "in" : "mm", "pcb", true);
    const pick = (i: number) => () => { R.setDiffPairIndex(i); if (S.route && S.route.dp && lastCtx) { S.route.dpSizes = dpSizes(lastCtx, { P: S.route.net }); S.route.width = S.route.dpSizes.width; updateHead(lastCtx); lastCtx.requestRender(); } };
    const rows: ({ label: string; tip?: string; checked: boolean; run: () => void; sep?: undefined } | { sep: true; label?: undefined })[] = [
      { label: "Use Net Class Values", tip: "Use differential pair dimensions from the net class", checked: !R.useCustomDiffPair && R.diffPairIndex === 0, run: pick(0) },
      { label: "Use Custom Values...", tip: "Specify custom differential pair dimensions", checked: R.useCustomDiffPair, run: () => { R.setDiffPairIndex("custom"); runAction("routerDiffPairDialog", lastCtx || ctx); } },
      { sep: true },
    ];
    R.diffPairLabels(fmt).forEach((label, k) => rows.push({ label, checked: !R.useCustomDiffPair && R.diffPairIndex === k + 1, run: pick(k + 1) }));
    return rows;
  },
  /**
   * TRACK_WIDTH_MENU ("Select Track/Via Width", router_tool.cpp): Use Starting Track Width, Use Net Class Values, Use
   * Custom Values..., the pre-defined track widths ("Track netclass width" first) and via sizes ("Via netclass values"
   * first), each a check item.  [{ label, tip, checked, run() } | { sep: true }].
   */
  trackWidthMenu(ctx: PcbCtx) {
    bind(ctx); const R = sizesOf(ctx);
    const u = sizeUnits(), fmt = (v: number) => messageText(v, u === "mil" ? "mil" : u === "in" ? "in" : "mm", "pcb", true);
    const useIndex = !R.useConnectedWidth && !R.useCustomTrackVia;
    const changed = () => { if (lastCtx) { const rt = S.route; if (rt) { rt.width = R.routeWidth(netNameOf(lastCtx, rt.net), rt.connected); updateHead(lastCtx); } lastCtx.requestRender(); } };
    const rows: ({ label: string; tip?: string; checked: boolean; run: () => void; sep?: undefined } | { sep: true; label?: undefined })[] = [
      { label: "Use Starting Track Width", tip: "Route using the width of the starting track.", checked: R.useConnectedWidth && !R.useCustomTrackVia,
        run: () => { R.setUseCustomTrackVia(false); R.setUseConnectedWidth(true); R.tempOverride = false; changed(); } },
      { label: "Use Net Class Values", tip: "Use track and via sizes from the net class", checked: useIndex && R.trackIndex === 0 && R.viaIndex === 0,
        run: () => { R.setUseConnectedWidth(false); R.setViaIndex(0); R.setTrackIndex(0); changed(); } },
      { label: "Use Custom Values...", tip: "Specify custom track and via sizes", checked: R.useCustomTrackVia,
        run: () => { R.setUseCustomTrackVia(true); R.tempOverride = true; runAction("ACT_CustomTrackWidth", lastCtx || ctx); } },
      { sep: true },
    ];
    R.sizes.trackWidths.forEach((w, i) => rows.push({ label: i === 0 ? "Track netclass width" : `Track ${fmt(w)}`, checked: useIndex && R.trackIndex === i,
      run: () => { R.tempOverride = true; R.setTrackIndex(i); changed(); } }));
    rows.push({ sep: true });
    R.sizes.vias.forEach((v, i) => rows.push({ label: i === 0 ? "Via netclass values" : v.drill > 0 ? `Via ${fmt(v.diameter)}, hole ${fmt(v.drill)}` : `Via ${fmt(v.diameter)}`,
      checked: useIndex && R.viaIndex === i, run: () => { R.setViaIndex(i); changed(); } }));
    return rows;
  },
  /** PCB_ACTIONS::trackViaSizeChanged: a route in progress takes the new sizes. */
  /** PCB_SELECTION_TOOL with m_CtrlClickHighlight: a Ctrl+click runs highlightNet at the click (not the selection). */
  highlightNetAt(ctx: PcbCtx, at: Pt) { return highlightNetAt(ctx, at); },
  trackViaSizeChanged(ctx: PcbCtx) { ctx = ctx || lastCtx; if (!ctx) return; bind(ctx); const rt = S.route; if (rt) { rt.width = sizesOf(ctx).routeWidth(netNameOf(ctx, rt.net), rt.connected); updateHead(ctx); } ctx.requestRender(); },
  /** The net being routed (the first of a pair), "" with none: what the size dialogs resolve the netclass of. */
  routedNet() { return S.route && S.route.net ? S.route.net.name || "" : ""; },
  /** The router's pair sizes changed (the Differential Pair Dimensions dialog): a pair being routed takes them at once. */
  diffPairSizesChanged(ctx: PcbCtx) { ctx = ctx || lastCtx; if (!ctx) return; bind(ctx); const rt = S.route; if (rt && rt.dp) { rt.dpSizes = dpSizes(ctx, { P: rt.net }); rt.width = rt.dpSizes.width; updateHead(ctx); ctx.requestRender(); } },
  /** The layer picker the Select Layer and Place Via commands open (PCB_EDIT_FRAME::SelectOneLayer). */
  setLayerPicker(fn: LayerPicker | null | undefined) { setLayerPickerImpl(fn || ((o, done) => done(null))); },
  netlist, ratsnest, localRatsnest, netInspector, netLengths, copperStack, stackupItems, layerDistance, netItemIds, netHighlightIds, msgPanelInfo, boardLayerName, drc, designSettings, inspectClearance, boardStatistics,
  padAt, padProperties, tunerProperties, groupOf, expandGroups, groupMembers: (doc: BoardDoc, id: string) => { const it = doc.items.get(id); return it && it.kind === "group" ? groupMembers(it.node) : []; },
  clipboardText, pasteChanges, cursorPoint, selectionIds, selMode, editPoints, editPointNode, addCornerChanges, removeCornerChanges, canAddCorner, canRemoveCorner,
  get markers() { return S.markers; },
  runDRC(ctx: PcbCtx) { return runAction("runDRC", ctx); },
  setDesignSettings(src: Parameters<typeof designSettings>[0]) { S.settings = src ? designSettings(src) : null; S.settingsSrc = null; },
  setCustomRules(text: string | null) { setCustomRules(text); },
  setForm(fn: (spec: FormSpec) => boolean) { setFormImpl(fn); },
};
root.CollabTools = root.CollabTools || {};
root.CollabTools.pcb = pcb;
root.PcbTools = { OffsetItemState, snapAnchors, textGraphics: textGraphicsApi, layerStyle, globalDeletion: globalDeletionApi, enabledLayerPairs, resetLayerPairCycle, itemOnLayer, itemRatsnestAnchors, uniqueZoneName, subtractOutline, footprintRefChoices, footprintByRef, netNameCmp, fieldEdit: { requestField, rotateFieldChange, flipFieldChange, hideFieldChanges, footprintFieldNode }, boardFindHits, edaMatches, findStep, unescapeKiCad, nearestSnapLinePoint, angleSnapDirections, MOVE_SNAP_MSG, ANGLE_SNAP_MSG, DRAWING_TOOL_IDS, useFootprintEditorDefaults, LINE_W, TEXT_STYLE, state: S, pad: padToolApi, exchange: exchangeApi, fpProps: fpPropsApi, fpPads: fpPadsApi, fpCheck: fpCheckApi, fpUsers: fpUsersApi, setEnumParams, openForm: (spec: FormSpec) => formImpl(spec), arcEditMode, setArcEditMode, arcEditGeometry, editPoints, editPointNode, ArcGeom, arcDrawMode, setArcDrawMode, arcFromStartEndMidDrag, arcFromStartEndCenterDrag, arcFromStartTangentEnd, arcTangentSeedAt, arcTangentSeedNear, snapVec45, netTable, zoneTemplate, build45Leader, polyOutline, angleSnapMode, setAngleSnap, constrainDraw, snap90, undoChainSegment, stepDrawWidth, withStroke, dimensionLabel, unfillChanges, alignBox, splitChanges, WIDTHS, BOARD_VERSION, routeLeg, segmentNode, viaNode, lineNode, rectNode, circleNode, arcNode, polyNode, textNode, netOf, netNode, netStyle,
  wrapBoard, addedChange, replacedChange, removedChange, padsOf, snapTarget, netUnder, hitTestItem, itemAt, deleteAt, connectedRun, rotateFootprintNode, flipFootprintNode,
  flipLayerName, pt, selectMoveTo, finishSelectMove, assembleLine, dragStart, startPendingDrag, finishDrag, dragMove, dragTo, dragSolution, dragChanges, dragSegment45, optimizeDragged, changedArea, componentDragHits, isFreePad, dragCorner45, dragCornerFree, initialTrace, routableItems, nextWidth, norm180, norm360, DELETE_CURSOR,
  // the interactive router (Highlight collisions, Shove, Walk around)
  RS_DEFAULTS, parseRouterSettings, setRouterSettings, routerChecks, foldMicro, cornerStyleName, cornerLeg, roundCorners, elemsPts, headElems, branchDoc, branchChanges, viaPlan,
  octagon, walkAroundHull, selfIntersecting, shoveWorld, shoveRun, shoveLine, shoveOps, insideConvex, routerKeyAction, splitOps, adoptNetOps, branchOpFresh, undoRedoInFlight, nextLineMode, guessCandidates, fieldCandidateId, hitTestDistance,
  matchDpSuffix, dpNetPair, dpPrimitives, findDpPrimitivePair, dpGateway, offsetPts, DP_MSG_NETS, DP_MSG_START, DP_MSG_NOWHERE, DP_MSG_GAP,
  padBreakouts, smartPadsSingle, runSmartPads, cornerCost, dpCoupledSegment, loopRemovals, antennaRemovals, removeRedundant, isTuningPattern, tuningPatternInfo, regenerateTuningChanges, selectedTuningPattern, editTuningPattern, tuningEditNode, tuningEditPoints, tuningOutline, genStartEdit, genUpdateEdit, genFinishEdit, genCancelEdit, topParentOf, tuningRemoveChanges, setTargetSkew, coupledLength, TUNE_MSG_SKEW_PICK, TUNE_MSG_SKEW_NETS, TUNE_MSG_DP_NETS, dpMeanderMove, coupledSegmentPairs, assembleDiffPair, tuneHiddenIds, chPoints, setCustomRules, parseDru, evalRuleConstraint,
  /** PANEL_SETUP_RULES::OnShowMatching: the ids of the board items (footprints for their pads) a named rule's condition and layer select. */
  ruleMatchingItems: (doc: BoardDoc, s: Parameters<typeof matchedLengthMarkers>[1], text: string, name: string): string[] | null => {
    const rule = parseDru(text).rules.find((r) => r.name === name); if (!rule) return null;
    const ids = new Set<string>();
    for (const it of ruleItems(doc)) { const host = it.item || it.parent; if (host && !ids.has(host.id) && ruleMatches(rule, doc, s, it, null)) ids.add(host.id); }
    return [...ids];
  }, parseCondition, wildMatch, tuneStatus, matchedLengthMarkers, customRuleMarkers: (doc: BoardDoc, s: Parameters<typeof matchedLengthMarkers>[1], text: string | null) => text ? ((r) => matchedLengthMarkers(doc, s, r).concat(diffPairMarkers(doc, s, r)))(parseDru(text).rules) : [], diffPairMarkers, meanderDefaults, setTargetLength, meanderMove, segSegDist, layerOf, widthOf, splitLine, tunePieces, tuningPatternNode, tuneSettingsView, applyTuneSettings, chLength, TUNE_IU, LENGTH_UNCONSTRAINED, TUNE_MSG_INSIDE, TUNE_MSG_SELECT, TUNE_MSG_PICK,
  routerWorld, routeObstacles, routeClearance, walkHead, walkTo, pathClear, pathHits, hullOf, legPts, simplifyPts, dir8, newTracer, trailAdd, tracerPosture, tracerFlip, saturated,
  // the new board tools
  layerClass, gfxWidth, textStyle, effectsNode, curveNode, textBoxNode, tableGrid, tableNode, imageNode, imageInfo, base64Bytes, imageMm,
  zoneNode, ruleAreaNode, zonePriority, setZoneFillMode, setThieving, thievingOf, zoneFillMode, thievingZoneNode, thievingDefaults, thievingAllowed, THIEVING_FILE_VERSION, THIEVING_NEEDS_VERSION_MSG, boardNets, dimensionNode, dimGeometry, dimRead, dimUpdate, dimWrite, dimEditPoints, dimEditNode, dimBaseText, dimValueText, readableAngle, snap45, typeNameOf, deleteChanges,
  DIM_TYPE, DIM_CLASS, TEXTBOX_MARGIN, EXT_HEIGHT, ARROW_LEN, EXT_OFFSET, RULE_AREA_LAYERS,
  // the rules engine in the router and DRC (sweep 4)
  customRouteClearance, rulePairClearance, ruleSizes, routedRuleItem, pinnedOpt, sizeMarkers, trackAngleMarkers, disallowMarkers, assertionMarkers, ruleItems, segCross, ruleCallFunc: callFunc, itemShape, footprintSelector,
  // silkscreen and solder mask DRC (sweep 4)
  starvedThermalMarkers, isolatedCopperMarkers, padZoneConnection, thermalGap, padOutline,
  silkClearanceMarkers, silkEdgeMarkers, silkToMaskMarkers, maskBridgeMarkers, silkMaskMarkers, boardElements, maskSetup, primShapes, geomShapes, elementGap,
  // the parity pass
  courtyardMarkers, courtyardOutlines, disabledLayerMarkers, effectivePenWidth, holeClearanceMarkers, holeToHoleMarkers, keepoutMarkers, moreDrcMarkers, textDimsMarkers, textMirroringMarkers, textOnEdgeCutsMarkers,
  DRCET, DRC_RUN_TEXT, fixDrcEntry, inspectDrcAction, violatingRuleName, applyExclusions, exclusionKey, exclusionOf, legacyExclusion, projectExclusions, readExclusion, withExclusion, withoutExclusions,
  ACTIONS, runAction, mapNodePoints, translateNode, rotateNode, rotateTextBoxNode, setTextBoxAngleSliding, textBoxAngle, flipNode, mirrorNode, anchorOf, selectionCenter, transformChanges, moveChanges, rotateChanges, flipChanges, mirrorChanges,
  moveExactChanges, positionRelativeChanges, swapLayerChanges, topLeftAnchor, alignChanges, distributeChanges, distributeDeltasGaps, distributeDeltasPoints, swapChanges, packChanges,
  selectionIds, applySelection, requestSelection, bestDragOrigin, snapCursor, itemAnchors, unlockedIds, moveTransform, modificationPoint, clearNets, LOCKED_WARNING, groupNode, groupOf, groupMembers, expandGroups, groupChanges, ungroupChanges, groupMembersChanges, isLocked, setLocked, lockChanges,
  // netTable, editPoints and editPointNode are listed above (the script named them twice, to the same values)
  shapeGap, coreDist, segsIntersect, polyPolyDist, padShape, padCopperLayers, viaLayers, arcPoints, arcLength, conductors, clusterRoots, netlist, ratsnest, localRatsnest, netInspector, netLengths, copperStack, stackupItems, layerDistance, netItemIds, netHighlightIds, msgPanelInfo, boardLayerName, itemDescription, dynamicRatsnest, selMode, addCornerChanges, removeCornerChanges, canAddCorner, canRemoveCorner, connectedCopperIds,
  sliverMarkers, sliverPoints, clipperArea, PolygonTest, padAnnulus, connectionWidthMarkers, boxGrid, boxesTouch, circleOutside, ovalOutside, circleApprox, ovalApprox, splitCollinearOutlines,
  designSettings, netclassOf, netClearance, DEFAULT_SETTINGS, edgeShapes, chainLoops, boardOutline, courtyards, drc, trackEditChanges, trackLayerChanges, breakTrackChanges, cleanupPlan, cleanupChanges, unusedPadLayerChanges,
  layersBlock, referencePoint, clipboardText, parseClipboard, freshUuids, rewriteNets, annotate, pasteChanges, duplicateChanges, arrayChanges, arraySize, arrayTransform, arrayStacked, arrayOrigin, pickInteractively, cursorPoint,
  adjustColor, courtyardConflicts, drawSnapIndicator, gridOriginColor, snapTypeOf, startLayerOf, groupBox, enteredGroupIds, withinEnteredGroup, drawGroupFrames, clearanceOutlines, drawClearanceOutlines, drawStatusNote, statusNoteDims,
  padAt, padProperties, convertChanges, selectionLoops, justifyChanges, zonePriorityChanges, footprintAttrChanges, boardStatistics, idsOnLayer, filterIds, SELECTION_TYPES, inspectClearance, VIA_SIZES, PCB_KINDS };
