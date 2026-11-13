// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { installDialogs } from "../dialogs/index";
import { installSchNets } from "./schnets";
import "./dom";
import "./appstore";
import "./util";
import "./home";
import "./view";
import "./tools";
import "./selection";
import "./doc";
import "./peers";
import "./pointer";
import "./comments";
import "./history";
import "./net";
import "./actions";
import "./panes";
import { installSymbolEditor } from "../symedit";
import "./pcbdialogs";
import { preloadPcbToolsWhenIdle } from "./pcbtools-loader";
import { HANDLERS, dispatchAction } from "./actions";
import { state, store } from "./appstore";
import { closeThread, placeComment } from "./comments";
import { noteModifiers, refreshCursor } from "./cursors";
import { followHypertext } from "./hypertext-follow";
import { dragKeeps, dragModifier, selModifier } from "./selmodes";
import { renderObjects, snapMm, syncItemsFromDoc, updateGridStatus, applyChanges, enterSheet, openDoc } from "./doc";
import { $ } from "./dom";
import { cancelLongPress, moveLongPress, openClarifyMenu, openContextMenu, startLongPress } from "./contextmenu";
import { DRAG_THRESHOLD_PX, cancelInteraction, clearAllSelection, rotateFieldMove, copperUnderBeatsFootprint, installGestures, pinForClick, registerPointerUp, selectionChanged, selectionIds, startMove } from "./gestures";
import { loadMe, navigate, route } from "./home";
import { sendOp } from "./net";
import { applyTheme, syncSchModes } from "./panes";
import { placeCrosshair } from "./crosshair";
import { installPcbRouting, pcbLayerKey } from "./pcbrouting";
import { installProjectWatch } from "./projectwatch";
import { breakFollow, sendPresence } from "./peers";
import { collapseSelectionTo, drawDrag, drawZoomRect, finishGroupDrag, finishZoomRect, measureCopy, measureDown, measureMove, measureUp, moveGroupDrag, openSelectionProperties, startGroupDrag } from "./pointer";
import { clearSelection, selectedSet, drawBoxSel, drawSelection, fieldLocalDelta, fieldOf, finishBoxSel, groupExpand, hitAny, nearestFootprint, renderProps, renderPropsInto, hitOpts } from "./selection";
import { E } from "./state";
import "./panels/index";
import { activeModule, commitChanges, commitObservers, deleteSelected, deleteSelection, moduleTool, moveOp, publishUndo, redoLast, redoStack, rotateSelected, runModuleHotkey, selectAll, setTool, toolCtx, undoLast, undoStack, unlockedForEdit } from "./tools";
import { api, closePopover, toast } from "./util";
import { saveTextDocument } from "./projectfile";
import { applyView, cmtPanel, dragG, fitView, isSch, requestRender, stage, world, worldMm, zoomBy } from "./view";
import type { ItemSummary, SheetEntry } from "./types";
/** The schematic module's drag in flight (sch-tools S.drag), as far as the app reads it. */
type SchDrag = { moved?: boolean; last: number[]; kind?: string };
import { installLibrary } from "./library";
import { importFootprintFiles, installFpEditHandlers } from "./fpedit";
import { importSymbolLibraries } from "../symedit/dialogs";
import { comboOf, keyHooks, kicadActionAvailable, runKicadAction, runSpecHotkey, typingTarget } from "./hotkeys";
import { selectionCount } from "./menu-actions";
import { installTableCells } from "./tablecells";   // last: its imports must not reorder the modules above
import { fontCommitObserver, initFonts } from "./fonts";
window.CollabApp = { getState: store.get, subscribe: store.subscribe, dispatch: (a) => dispatchAction(a), renderProps: (el) => renderPropsInto(el), selectionCount };


// ---------- home navigation (the home view is still rendered here) ----------
document.addEventListener("click", (ev) => {
  const nav = (ev.target as Element).closest<HTMLElement>("#home [data-nav]");
  if (nav) { ev.preventDefault(); navigate(nav.dataset.nav === "explore" ? "/gallery" : "/"); }
});

window.addEventListener("popstate", route);

KiCadCanvas.onAssetLoaded = () => requestRender();
initFonts({ doc: () => E.kdoc, send: (changes) => sendOp(changes as never) });
commitObservers.push(fontCommitObserver);


// ---- editing tools (schematic / board modules register on window.CollabTools) ----
// A module: { id, tools: [{ id, label, key, icon (svg inner markup), cursor }],
//   onActivate(toolId, ctx), onPointerDown(ev, mm, ctx) -> handled?, onPointerMove(ev, mm, ctx),
//   onPointerUp(ev, mm, ctx), onKey(key, ev, ctx) -> handled?, drawOverlay(ctx2d, view, ctx),
//   onDocChanged(ctx) }.  Everything a module needs travels in ctx (see toolCtx()).
window.CollabTools = window.CollabTools || {};

/**
 * The active tool's in-flight geometry, in internal units, for the peer overlay: [x1, y1, x2, y2,
 * width] per segment.  The desktop ghosts its own in-flight wires and router legs to us; without
 * this the web direction showed peers a bare cursor until the item was committed.
 */
/** A tool module that streams its in-flight geometry (mm: x1, y1, x2, y2, width per segment). */
type GhostModule = ToolModule & { ghostSegs?: (ctx: ToolCtx) => number[][] | null };
function moduleGhost(mod: GhostModule | null | undefined) {
  if (!mod || typeof mod.ghostSegs !== "function") return null;
  let segs: number[][] = [];
  try { segs = mod.ghostSegs(toolCtx()) || []; } catch (e) { console.warn(e); return null; }
  return segs.map((g) => [Math.round(g[0] * E.IU), Math.round(g[1] * E.IU), Math.round(g[2] * E.IU), Math.round(g[3] * E.IU), Math.round((g[4] || 0.1) * E.IU)]);
}

/**
 * The ghost to attach to a presence message: the module's in-flight geometry while there is any, one empty
 * list when it ends (the "stopped" signal, which bypasses the rate limit) and nothing after that.
 */
let ghostLive = false;
function liveGhost(mod: GhostModule | null | undefined) {
  const g = moduleGhost(mod);
  if (g && g.length) { ghostLive = true; return g; }
  if (ghostLive) { ghostLive = false; return []; }
  return undefined;
}

// wheel, middle / right button, hover and lost-release recovery: KiCad's mouse model (gestures.ts).
// Installed before every other stage listener so it sees each event first.
installGestures(openContextMenu);
installTableCells();   // table cells as selectable items and the table edit tool (editor/tablecells.ts)

   // until the user pans/zooms, resizes just refit
new ResizeObserver(() => {
  if (state.view !== "editor") return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (sw && sh && E.lastStageW && (sw !== E.lastStageW || sh !== E.lastStageH)) {
    const w0 = E.lastStageW, h0 = E.lastStageH || sh; E.lastStageH = sh;
    if (!E.viewTouched && (E.kdoc || Object.keys(E.layers).length)) { fitView(); return; }
    // zoom 1 is "the sheet as wide as the stage": keep the scale on screen and the point at the centre where they were
    E.zoom *= w0 / sw; E.panX += (sw - w0) / 2; E.panY += (sh - h0) / 2; world.style.width = sw + "px";
  }
  if (sw) { E.lastStageW = sw; E.lastStageH = sh; }
  applyView();
}).observe(stage);


// ---- pointer interaction ----
stage.addEventListener("contextmenu", (ev) => ev.preventDefault());

stage.addEventListener("dblclick", (ev) => {
  if (!E.kdoc || !window.KDialogs || (E.tool !== "select" && E.tool !== "highlight")) return;
  if ((ev.target as Element).closest("#cmtPanel") || (ev.target as Element).closest("[data-schtools]")) return;
  const [x, y] = worldMm(ev); const ctx = toolCtx();
  // PCB_SELECTION_TOOL: a double-click when the selection is a lone group enters it (and picks the item under the cursor)
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.enterGroupAt && CollabTools.pcb.selectedTopGroup) {
    try { const gid = CollabTools.pcb.selectedTopGroup(ctx); const h = gid ? hitAny([x, y]) : null; if (h && CollabTools.pcb.enterGroupAt(ctx, h.id)) { selectionChanged(); return; } } catch (e) { console.warn(e); }
  }
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.padProperties) {       // a pad first: KiCad opens Pad Properties on a pad
    let pad: { item: KItem; index: number } | null = null;
    try { pad = KiCadCanvas.padAt ? KiCadCanvas.padAt(E.kdoc, x, y) : null; if (!pad && CollabTools.pcb.padAt) pad = CollabTools.pcb.padAt(E.kdoc, x, y); } catch (e) { pad = null; }
    if (pad && pad.item && pad.index !== undefined) { CollabTools.pcb.padProperties(ctx, pad.item, pad.index); return; }
    // the first click picked a track, via, graphic or zone (the board module's selection): its dialog, as pcbnew's double-click
    const ps = CollabTools.pcb.state && CollabTools.pcb.state.sel;
    if (ps && ps.size === 1 && !E.selected && openSelectionProperties()) return;
  }
  if (isSch() && CollabTools.sch && CollabTools.sch.enterGroupAt) {         // a double-click on a group enters it (KiCad), it does not open a dialog
    const g = hitAny([x, y]); try { if (g && CollabTools.sch.enterGroupAt(ctx, g.id)) return; } catch (e) { console.warn(e); }
  }
  const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
  if (f) { KDialogs!.openField(ctx, f.item, f.name); return; }
  const best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (best) { const it = E.kdoc.items.get(best.id); if (it && it.kind === "sheet" && it.file) { enterSheet(it.file); return; } if (it) KDialogs!.openItem(ctx, it); return; }   // nearestFootprint() picks sheets too
  // KiCad: a double-click on a hierarchical sheet enters it (E opens its properties)
  if (isSch()) { const sh = E.sheets.find((r: SheetEntry) => x >= r.x / E.IU && x <= (r.x + r.w) / E.IU && y >= r.y / E.IU && y <= (r.y + r.h) / E.IU); if (sh) { const it = E.kdoc.items.get(sh.id); if (it && it.file) { enterSheet(it.file); return; } if (it) { KDialogs!.openItem(ctx, it); return; } } }
  const other = hitAny([x, y]); const it = other && E.kdoc.items.get(other.id);
  if (it) KDialogs!.openItem(ctx, it);
});

// a press held still over overlapping items opens Clarify Selection (m_disambiguateTimer)
window.addEventListener("pointerdown", (ev) => { if (ev.target instanceof Element && stage.contains(ev.target) && !ev.target.closest("#cmtPanel")) startLongPress(ev); else cancelLongPress(); }, true);
window.addEventListener("pointermove", (ev) => moveLongPress(ev), true);
window.addEventListener("pointerup", () => cancelLongPress(), true);
window.addEventListener("pointercancel", () => cancelLongPress(), true);

// Alt+click: KiCad's Clarify Selection popup when more than one item is under the cursor (window capture, ahead of the
// tool modules' own stage listeners)
window.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || !ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  if (openClarifyMenu(ev)) { ev.stopImmediatePropagation(); ev.preventDefault(); }
}, true);

// SCH_SELECTION_TOOL: a click (IsClick: press and release without a drag) on hypertext under the cursor
// (HasHoveredHypertext) follows it and leaves the selection as it was (selCancelled); a drag that starts on it
// selects and moves the item like any other (IsDrag), so the press is not swallowed.
let hyperPress: { href: string; x: number; y: number; id: number; sel: Set<string>; selected: unknown; selField: unknown; selPins: unknown } | null = null;
window.addEventListener("pointerdown", (ev) => {
  hyperPress = null;
  const hh = E.hyperHover as { id: string; href: string } | null;
  if (!hh || ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || E.tool !== "select" || !isSch() || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const sch = CollabTools.sch; if (sch && (sch.state.drag || sch.state.carry || sch.state.wire)) return;
  hyperPress = { href: hh.href, x: ev.clientX, y: ev.clientY, id: ev.pointerId, sel: new Set(E.selection), selected: E.selected, selField: E.selField, selPins: E.selPins };
}, true);
window.addEventListener("pointermove", (ev) => {
  if (hyperPress && ev.pointerId === hyperPress.id && Math.hypot(ev.clientX - hyperPress.x, ev.clientY - hyperPress.y) > DRAG_THRESHOLD_PX) hyperPress = null;   // IsDrag
}, true);
window.addEventListener("pointercancel", () => { hyperPress = null; }, true);
window.addEventListener("pointerup", (ev) => {
  const hp = hyperPress; hyperPress = null;
  if (!hp || ev.button !== 0 || ev.pointerId !== hp.id || Math.hypot(ev.clientX - hp.x, ev.clientY - hp.y) > DRAG_THRESHOLD_PX) return;
  cancelLongPress();
  // after the stage's own release handling (a press that did not move drops its drag / box): put the selection back
  setTimeout(() => {
    E.boxSel = null; E.drag = null;
    clearSelection(); for (const id of hp.sel) E.selection.add(id);
    E.selected = hp.selected as typeof E.selected; E.selField = hp.selField as typeof E.selField; E.selPins = hp.selPins as typeof E.selPins;
    drawSelection(); renderProps(); renderObjects(); requestRender();
    followHypertext(hp.href, ev);
  }, 0);
}, true);

stage.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || E.tool !== "select" || !E.kdoc || E.selection.size < 2 || E.viewOnly || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;   // a modifier edits the selection
  if (isSch() && CollabTools.sch && CollabTools.sch.state.drag) return;   // a Move / paste is following the cursor: this click drops it (sch-tools)
  const mm = worldMm(ev); const hit = hitAny(mm);
  if (!hit || !E.selection.has(hit.id)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  // a selection of tracks (or one via) is dragged by the router (PCB_SELECTION_TOOL: routable -> drag45Degree), not moved
  const pm = CollabTools.pcb as unknown as { routableDown?: (e: PointerEvent, p: number[], c: unknown, ids: string[]) => boolean } | undefined;
  if (!isSch() && pm && pm.routableDown) { try { if (pm.routableDown(ev, mm, toolCtx(), [...E.selection])) { stage.setPointerCapture(ev.pointerId); return; } } catch (e) { console.warn(e); } }
  startGroupDrag(hit, mm, ev);
}, true);

stage.addEventListener("pointerdown", (ev) => {
  if ((ev.target as Element).closest("#cmtPanel") || (ev.target as Element).closest("#signinOverlay")) return;
  if ((ev.button === 2 && E.rightDragPan !== false) || (ev.button === 1 && E.middleDragPan !== false) || (ev.button === 0 && E.tool === "pan")) {
    E.pan = { x: ev.clientX - E.panX, y: ev.clientY - E.panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (E.fdrag && E.fdrag.sticky) { commitFieldDrag(); ev.preventDefault(); return; }   // the click that drops a field's Move
  if (E.tool === "zoomtool") { E.zoomRect = { start: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (E.tool === "measure") { measureDown(snapMm(worldMm(ev)), ev); return; }
  if (E.tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const mod = activeModule();
  if (mod && moduleTool(E.tool) && mod.onPointerDown) { if (E.viewOnly && E.tool !== "highlight") { toast("View-only access"); return; } try { if (mod.onPointerDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (E.tool === "select" && E.kdoc && !ev.shiftKey && window.KDialogs) {   // KiCad: a click on a field selects (and drags) the field, not its symbol
    const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
    if (f) {
      const wasField = !!(E.selField && E.selField.id === f.item.id && E.selField.name === f.name);   // DRAG_SELECTED: only a selected field drags
      clearSelection(); E.selField = { id: f.item.id, name: f.name };
      const pst = !isSch() && CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev;   // one item per click: the board module does not pick what lies under the field
      drawSelection(); renderProps(); renderObjects(); requestRender();
      const pn = fieldOf(f.item, f.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (!wasField) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); }
      else if (at && !E.viewOnly && E.ws && E.ws.readyState === 1) { E.fdrag = { id: f.item.id, name: f.name, startMm: [x, y], orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], origAt: at.slice(), moved: false }; stage.setPointerCapture(ev.pointerId); }
      ev.preventDefault(); return;
    }
  }
  let pinPromote: { id: string; number: string } | null = null, pinClick: { id: string; number: string } | null = null;
  // Shift+click adds a pin to the selected pins, Ctrl+click toggles it, Ctrl+Shift+click removes it (SCH_SELECTION_TOOL
  // with the pin ahead of its symbol), while the selection holds only pins
  const pinMode = E.tool === "select" && E.kdoc && isSch() && !ev.altKey ? selModifier(ev) : null;
  if (pinMode && !E.selection.size && !E.selected && !E.selField) {
    const pin = pinForClick([x, y]);
    if (pin) {
      const pins = E.selPins as { id: string; number: string }[]; const i = pins.findIndex((p) => p.id === pin.id && p.number === pin.number);
      if (pinMode === "add") { if (i < 0) E.selPins = [...pins, pin]; }
      else if (pinMode === "remove") { if (i >= 0) E.selPins = pins.filter((_p, j) => j !== i); }
      else E.selPins = i >= 0 ? pins.filter((_p, j) => j !== i) : [...pins, pin];
      drawSelection(); renderProps(); renderObjects(); requestRender(); ev.preventDefault(); return;
    }
  }
  if (E.tool === "select" && E.kdoc && isSch() && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    // SCH_SELECTION_TOOL: a pin under the cursor is selected on its own, ahead of its symbol's body
    const pin = pinForClick([x, y]);
    if (pin) {
      const was = (E.selPins as { id: string; number: string }[]).some((p) => p.id === pin.id && p.number === pin.number);
      // its symbol is already selected: a drag moves the selection (RequestSelection( MovableItems )), only a click
      // (released where it was pressed) selects the pin on its own
      const symSel = !was && (E.selection.has(pin.id) || (!!E.selected && E.selected.id === pin.id));
      if (symSel) { pinPromote = pin; pinClick = pin; }
      else if (!was) {
        clearSelection(); E.selPins = [pin]; drawSelection(); renderProps(); renderObjects(); requestRender();
        E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId);
        ev.preventDefault(); return;
      }
      // a press on a selected pin moves its symbol: on a drag start SCH_SELECTION_TOOL unselects every selected pin and
      // selects its parent symbol instead (RequestSelection( { SCH_PIN_T } ) -> parents), then runs move; a click
      // without a drag still leaves this pin alone selected
      else {
        const parents = Array.from(new Set((E.selPins as { id: string }[]).map((p) => p.id))).filter((id) => E.kdoc.items.has(id));
        E.selPins = []; const fp = (E.items as ItemSummary[]).find((f) => f.id === pin.id);
        if (parents.length > 1 && fp && !E.viewOnly && E.ws && E.ws.readyState === 1) {
          E.selection = new Set(parents); E.selected = fp; drawSelection(); renderProps(); renderObjects();
          startGroupDrag({ id: pin.id, fp }, [x, y], ev);
          if (E.drag) { E.drag.clickId = null; E.drag.clickPin = pin; }
          ev.preventDefault(); return;
        }
        if (fp) E.selected = fp; pinPromote = pin; pinClick = pin;
      }
    }
  }
  let best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (pinPromote) { const fp = (E.items as ItemSummary[]).find((f) => f.id === pinPromote!.id); if (fp) best = fp; }
  // Board: a click on a pad selects the pad, not its footprint (PCB_SELECTION_TOOL; the footprint is picked by its body)
  let padWasSelected = false;
  if (!isSch() && E.tool === "select" && CollabTools.pcb && CollabTools.pcb.leaveGroupOutside) { try { CollabTools.pcb.leaveGroupOutside([x, y], toolCtx()); } catch (e) { console.warn(e); } }
  if (!isSch() && E.tool === "select" && mod && mod.selectPadAt) {
    const ps = CollabTools.pcb && CollabTools.pcb.state;
    let r: unknown = false;
    const padMode = smodeOf(ev);
    if (!padMode || padMode === "add") { try { r = mod.selectPadAt(ev, [x, y], toolCtx()); } catch (e) { console.warn(e); } }
    // Shift+click on a pad adds it to the pads (and items) already selected (PCB_SELECTION_TOOL selectPoint, add mode)
    if (r && padMode === "add") { drawSelection(); renderProps(); renderObjects(); requestRender(); ev.preventDefault(); return; }
    if (r === "box") { E.selection.clear(); E.selected = null; E.selField = null; E.selPins = []; drawSelection(); renderProps(); renderObjects(); requestRender(); startModuleBox(ev, x, y); return; }
    // a press on the selected pad: a move promotes it to its footprint (FilterCollectorForFreePads, allow free pads off)
    padWasSelected = r === true;
    if (ps) ps.padSel = null;
  }
  // Board: a track / via / graphic under the cursor beats a footprint whose only claim is its empty bounding box
  // (KiCad picks the item whose geometry is under the cursor; the footprint wins on its own pads and outline).
  // A press on a footprint that is already selected drags the selection, whatever is under it (DRAG_SELECTED:
  // PCB_SELECTION_TOOL's SelectionContains( DragOrigin ) check comes before any new pick)
  const pressOnSelected = !isSch() && !!best && !smodeOf(ev) && !!selectedSet()?.has(best.id);
  if (!isSch() && best && !pressOnSelected && E.lastFpHit && (!E.lastFpHit.onGeom || copperUnderBeatsFootprint([x, y])) && mod && mod.onSelectDown && E.tool === "select") {
    try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { E.selection.clear(); E.selected = null; E.selField = null; E.selPins = []; drawSelection();   /* the footprint the box reached is dropped, the module's own pick stays (clearSelection would clear it too) */ renderProps(); renderObjects(); if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); }
  }
  if (!best && mod && mod.onSelectDown) { try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); } }
  const smode = selModifier(ev);
  if (!best) {
    if (!smode) { clearSelection(); drawSelection(); renderProps(); renderObjects(); }
    if (E.tool === "select" && E.kdoc) { { const dm = dragModifier(ev, isSch()); E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: dragKeeps(ev), mode: dm, startClient: [ev.clientX, ev.clientY] }; } stage.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    return;
  }
  if (smode) {                                         // KiCad: Shift+click adds, Ctrl+click toggles, Ctrl+Shift+click removes
    E.selPins = [];                                    // (the pin selection does not mix with whole items here)
    if (E.selected) E.selection.add(E.selected.id);   // the single selection joins the set it is being extended to
    if (smode === "add") E.selection.add(best.id); else if (smode === "remove") E.selection.delete(best.id); else if (E.selection.has(best.id)) E.selection.delete(best.id); else E.selection.add(best.id);
    E.selected = E.selection.has(best.id) ? best : (E.selected && E.selected.id === best.id ? null : E.selected);
    if (!E.selected) for (const id of E.selection) { const f = E.items.find((q: ItemSummary) => q.id === id); if (f) { E.selected = f; break; } }
    drawSelection(); renderProps(); renderObjects(); requestRender(); return;
  }
  // KiCad's default left drag (MOUSE_DRAG_ACTION::DRAG_SELECTED): with nothing selected a drag draws a selection
  // box even when it starts on a part; only an existing selection moves.  The press still selects, as the click would.
  const hadSelection = !!selectedSet() || padWasSelected;
  if (!E.selection.has(best.id)) E.selection.clear();
  E.selected = best;
  { const g = groupExpand([best.id]); if (g.size > 1) for (const id of g) E.selection.add(id); }   // a click on a group member selects its group (KiCad)
  drawSelection(); renderProps(); renderObjects();
  if (!hadSelection && E.tool === "select") { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if (!isSch() && !unlockedForEdit([best.id], true).length) return;   // a locked footprint is selected by the click but does not follow a drag
  { const g = groupExpand([best.id]); if (g.size > 1) { E.selection = g; drawSelection(); renderObjects(); startGroupDrag({ id: best.id, fp: best }, [x, y], ev); return; } }   // a group member moves its group
  E.drag = { fp: best, startMm: [x, y], curMm: [best.x / E.IU, best.y / E.IU], moved: false, grabOff: [x - best.x / E.IU, y - best.y / E.IU], wires: [], engine: false, clickPin: pinClick };
  // Schematic moves run through sch-tools' connected drag: attached wires stretch (with bends in
  // 90° mode), a pin or junction under a moved pin gets a new wire, no-connects follow — KiCad's drag.
  if (E.kdoc && isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    const it = E.kdoc.items.get(best.id);
    try { if (it && CollabTools.sch.beginDrag(toolCtx(), it, [x, y], true)) E.drag.engine = true; } catch (e) { console.warn(e); }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});

/** SelectPoint on a pin of the selected symbol: the click (no drag) leaves the pin alone selected. */
function selectPinOnly(pin: { id: string; number: string }): void {
  if (!E.kdoc || !E.kdoc.items.has(pin.id)) return;
  clearSelection(); E.selPins = [pin]; drawSelection(); renderProps(); renderObjects(); requestRender();
}

const smodeOf = (ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => selModifier(ev);
/** PCB_SELECTION_TOOL::selectMultiple re-reads the modifiers on every event: Shift / Ctrl pressed or let go mid-drag change the mode. */
function boxSelModifiers(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): void {
  const b = E.boxSel as { add?: boolean; mode?: string | null } | null; if (!b) return;
  b.mode = dragModifier(ev, isSch()); b.add = dragKeeps(ev);
}
for (const t of ["keydown", "keyup"]) window.addEventListener(t, (ev) => { const k = (ev as KeyboardEvent).key; if (E.boxSel && (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt")) { boxSelModifiers(ev as KeyboardEvent); drawBoxSel(); } });
/** DRAG_SELECTED on an item that was not selected: the press picked it (the board module's own pick), a drag draws a box. */
function startModuleBox(ev: PointerEvent, x: number, y: number): void {
  if (E.tool !== "select" || !E.kdoc) return;
  E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] };
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
}

/** Drop a field drag or Move: the original goes back first so the commit records the inverse (undo restores it exactly). */
function commitFieldDrag(): void {
  const fd = E.fdrag; E.fdrag = null; if (!fd) return;
  const it = E.kdoc && E.kdoc.items.get(fd.id), pn = it && fieldOf(it, fd.name), at = pn && KiCadCanvas.kid(pn, "at");
  if (fd.moved && at) {
    const now = at.slice(), orig = fd.origAt || [at[0], fd.orig[0], fd.orig[1], ...at.slice(3)];
    at.splice(0, at.length, ...orig); KiCadCanvas.replaceChange(E.kdoc, it);
    if (JSON.stringify(now) !== JSON.stringify(orig)) {
      const node = JSON.parse(JSON.stringify(it.node)); const p2 = fieldOf({ node }, fd.name); const a2 = KiCadCanvas.kid(p2!, "at")!; a2.splice(0, a2.length, ...now);
      commitChanges([KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null }))], "move " + fd.name.toLowerCase());
    }
    requestRender();
  }
}

stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  E.lastCursorMm = mm; E.lastClient = [ev.clientX, ev.clientY];
  try { stagePointerMove(ev, mm); } finally {
    // GetCursorPosition(): where the crosshair is — the position the active tool forced (ForceCursorPosition: the
    // magnetic snap to a pad, a pin or a wire end, an angle snap line, the moved reference), else the grid-snapped one
    const at = placeCrosshair(mm, forcedCursor()) || snapMm(mm);
    store.slice("viewport", { cursor: [at[0]!, at[1]!] });
  }
});
/** The cursor a module tool holds (VIEW_CONTROLS::ForceCursorPosition), or null when it follows the grid. */
function forcedCursor(): number[] | null {
  const m = activeModule() as { cursorPos?: (ctx: unknown) => number[] | null } | null;
  if (!m || !m.cursorPos) return null;
  try { const p = m.cursorPos(toolCtx()); return p && isFinite(p[0]!) && isFinite(p[1]!) ? [p[0]!, p[1]!] : null; } catch (e) { console.warn(e); return null; }
}
function stagePointerMove(ev: PointerEvent, mm: [number, number]): void {
  if (E.zoomRect) { drawZoomRect(ev); return; }
  if (E.boxSel) { E.boxSel.cur = mm; if (E.boxSel.lasso) E.boxSel.pts.push(mm); boxSelModifiers(ev); drawBoxSel(); return; }
  if (E.measure && E.measure.set) { measureMove(snapMm(mm), ev.shiftKey); }
  if (E.pan) { E.viewTouched = true; E.panX = ev.clientX - E.pan.x; E.panY = ev.clientY - E.pan.y; breakFollow(); applyView(); sendPresence(mm); return; }
  const modM = activeModule();
  if (modM && moduleTool(E.tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm, liveGhost(modM)); return; }
  if (E.fdrag) {
    if (!E.fdrag.moved && (E.fdrag.sticky || Math.hypot(mm[0] - E.fdrag.startMm[0], mm[1] - E.fdrag.startMm[1]) > 0.4)) E.fdrag.moved = true;
    if (E.fdrag.moved) {
      const it = E.kdoc && E.kdoc.items.get(E.fdrag.id), pn = it && fieldOf(it, E.fdrag.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at) {
        // a Move (M) brings the text's own position to the snapped cursor; a held-button drag moves it by the snapped delta
        const sp = E.fdrag.sticky ? snapMm(mm) : null;
        const w = sp ? [sp[0] - E.fdrag.origin[0], sp[1] - E.fdrag.origin[1]] : snapMm([mm[0] - E.fdrag.startMm[0], mm[1] - E.fdrag.startMm[1]]); const [ldx, ldy] = fieldLocalDelta(it, w[0], w[1]);
        at[1] = +(E.fdrag.orig[0] + ldx).toFixed(4); at[2] = +(E.fdrag.orig[1] + ldy).toFixed(4);
        KiCadCanvas.replaceChange(E.kdoc, it); requestRender();
      }
    }
    sendPresence(mm); return;
  }
  if (!E.drag) { sendPresence(mm, liveGhost(modM)); return; }   // a Move / Drag (M / G) or a paste following the cursor ghosts to peers too
  if (E.drag.group) { moveGroupDrag(mm); sendPresence(mm); return; }
  if (E.drag.engine) {
    const d = CollabTools.sch!.state.drag as SchDrag | null;
    if (!d) { E.drag = null; sendPresence(mm); return; }           // cancelled (Escape) or already dropped
    CollabTools.sch!.moveDrag(toolCtx(), mm);
    if (!d.moved) { sendPresence(mm, liveGhost(modM)); return; }
    E.drag.moved = true; E.drag.curMm = [E.drag.fp.x / E.IU + d.last[0], E.drag.fp.y / E.IU + d.last[1]];
    const nowE = Date.now();
    if (nowE - E.lastLiveMove > 150 && d.kind === "symbol") { E.lastLiveMove = nowE; sendOp([moveOp(E.drag.fp, Math.round(E.drag.curMm[0] * E.IU), Math.round(E.drag.curMm[1] * E.IU))], true); }
    sendPresence(mm, liveGhost(modM)); return;
  }
  if (!E.drag.moved && Math.hypot(mm[0] - E.drag.startMm[0], mm[1] - E.drag.startMm[1]) > 0.4) E.drag.moved = true;
  if (!E.drag.moved) return;
  // Keep the grab offset, then snap the item's own anchor to the grid.
  const off = E.drag.grabOff || [0, 0];
  const target = snapMm([mm[0] - off[0], mm[1] - off[1]]);
  E.drag.curMm = target;
  drawDrag();
  if (E.kdoc) {
    KiCadCanvas.applyChange(E.kdoc, moveOp(E.drag.fp, Math.round(target[0] * E.IU), Math.round(target[1] * E.IU)), E.IU);
    for (const w of E.drag.wires) { const p = KiCadCanvas.ptsOf(w.item.node); p[w.index] = [target[0] + w.off[0], target[1] + w.off[1]]; KiCadCanvas.setPts(w.item.node, p); w.item.geom = []; w.item.bbox = null; }
    for (const w of E.drag.wires) KiCadCanvas.replaceChange(E.kdoc, w.item);
    requestRender();
  }
  const now = Date.now();
  if (now - E.lastLiveMove > 150) { E.lastLiveMove = now; sendOp([moveOp(E.drag.fp, Math.round(target[0] * E.IU), Math.round(target[1] * E.IU))], true); }
  // peers see the move itself: the live op above moves their copy, and the presence boxes (peers.ts) carry the
  // footprint's own outline at its position right now — in the units and box definition the desktop draws from
  sendPresence(mm);
}

const onPointerUp = (ev: PointerEvent) => {
  if (E.pan) { E.pan = null; return; }
  if (E.fdrag) { if (!E.fdrag.sticky) commitFieldDrag(); return; }   // a Move (M) drops on the next click instead
  if (E.zoomRect) { finishZoomRect(ev); return; }
  if (E.boxSel) { finishBoxSel(ev); return; }
  if (E.tool === "measure" && ev.button === 0) { measureUp(ev); return; }
  const modU = activeModule();
  if (modU && moduleTool(E.tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } sendPresence(worldMm(ev), liveGhost(modU)); return; }
  if (ev.button !== 0 || !E.drag) return;
  if (E.drag.group) { finishGroupDrag(); return; }
  if (E.drag.engine) {
    const fpE = E.drag.fp, cur = E.drag.curMm, clickId = E.drag.moved ? null : E.drag.clickId, clickPin = E.drag.moved ? null : E.drag.clickPin; E.drag = null; dragG.replaceChildren();
    if (CollabTools.sch!.state.drag) { try { CollabTools.sch!.endDrag(toolCtx(), true); } catch (e) { console.warn(e); } }
    sendPresence(cur, []);
    if (clickId) { collapseSelectionTo(clickId); return; }
    if (clickPin) { selectPinOnly(clickPin); return; }
    if (E.kdoc) syncItemsFromDoc(); E.selected = E.items.find((f: ItemSummary) => f.id === fpE.id) || E.selected; drawSelection(); renderProps(); requestRender();
    return;
  }
  const fp = E.drag.fp, wasMoved = E.drag.moved, wires = E.drag.wires || [], clickPin0 = E.drag.clickPin as { id: string; number: string } | null;
  const nx = Math.round(E.drag.curMm[0] * E.IU), ny = Math.round(E.drag.curMm[1] * E.IU);
  E.drag = null; dragG.replaceChildren();
  sendPresence([nx / E.IU, ny / E.IU], []);
  if (!wasMoved) { if (clickPin0) selectPinOnly(clickPin0); return; }
  const changes: KChange[] = [];
  if (nx !== fp.x || ny !== fp.y) changes.push(moveOp(fp, nx, ny));
  for (const w of wires) changes.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, w.item) });
  if (changes.length) {
    // our copy must end where we say it ends: a peer's move of the same item that arrived while the button was
    // down (and the pointer still) would otherwise stay on screen here although the server has ours
    if (E.kdoc && (nx !== fp.x || ny !== fp.y)) KiCadCanvas.applyChange(E.kdoc, moveOp(fp, nx, ny), E.IU);
    sendOp(changes);
    // inverse: put the symbol and the wire ends back
    const inverse: KChange[] = [moveOp({ id: fp.id, x: nx, y: ny }, fp.x, fp.y)];
    for (const w of wires) {   // the undo step: the same wire with this end back where it was
      const node = KiCadCanvas.cloneNode(w.item.node); const p = KiCadCanvas.ptsOf(node).map((q) => q.slice()); p[w.index] = w.orig; KiCadCanvas.setPts(node, p);
      inverse.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, Object.assign({}, w.item, { node })) });
    }
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  }
  fp.x = nx; fp.y = ny; if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
};
stage.addEventListener("pointerup", onPointerUp);
// the KICURSOR follows every press, move and release, after the handlers above changed what is going on (cursors.ts)
for (const t of ["pointerdown", "pointermove", "pointerup"] as const) stage.addEventListener(t, (ev) => { noteModifiers(ev); refreshCursor(); });
registerPointerUp(onPointerUp);

// The keyboard belongs to the canvas, as in KiCad: a click on it takes the focus from a panel's field, and when a
// dialog, prompt or popover closes with nothing focused, the focus goes back to it (not to the page).
stage.addEventListener("pointerdown", (ev) => {
  const t = ev.target as Element | null;
  if (t && t.closest && t.closest("input, textarea, select, k-select, button, a, [contenteditable], #cmtPanel")) return;
  if (document.activeElement !== stage) stage.focus({ preventScroll: true });
}, true);
const refocusCanvas = new MutationObserver((recs) => {
  if (state.view !== "editor" || !E.kdoc) return;
  const a = document.activeElement; if (a && a !== document.body && a.isConnected) return;
  if (recs.some((r) => r.removedNodes.length > 0)) stage.focus({ preventScroll: true });
});
refocusCanvas.observe(document.body, { childList: true });
const overlaysRoot = document.getElementById("ui-overlays"); if (overlaysRoot) refocusCanvas.observe(overlaysRoot, { childList: true, subtree: true });   // a click drops an item that follows the cursor after Move


// KiCad's edit actions run SCH_SELECTION_TOOL::RequestSelection: with nothing selected the item under the cursor
// becomes a hover selection for the one action, filtered by the types the action takes, and the action lets go
// of a hover selection when it is done.
const HOVER_KEYS = new Set(["E", "V", "U", "F", "M", "G", "R", "Shift+R", "X", "Y", "D", "Del", "Backspace", "Ctrl+D", "Ctrl+C", "Ctrl+X", "Ctrl+E", "Alt+3", "Ctrl+4"]);
// editValue / editReference / editFootprint: RequestSelection( { SCH_FIELD_T, SCH_SYMBOL_T, SCH_PIN_T } )
const HOVER_SYMBOL_ONLY = new Set(["V", "U", "F"]);
// rotate / mirror and Copy (sch_editor_control.cpp doCopy) clear a hover selection as they return
const HOVER_RELEASE = new Set(["R", "Shift+R", "X", "Y", "Ctrl+C"]);
// EditField and Properties (clearSelection = selection.IsHover() once the dialog closes), Move / Drag
// (finalizeMoveOperation with aUnselect = selection.IsHover()): released when the dialog or the move ends
const HOVER_HOLD = new Set(["E", "V", "U", "F", "M", "G"]);
type SchHoverState = { sel?: string | null; wire?: unknown; carry?: unknown; drag?: unknown; draw?: unknown; pedit?: unknown };
const schToolState = (): SchHoverState | null => CollabTools.sch ? (CollabTools.sch.state as unknown as SchHoverState) : null;
function hoverHeldOnly(id: string): boolean {
  const S = schToolState();
  if (E.selection.size > 1 || (E.selection.size === 1 && !E.selection.has(id))) return false;
  if (S && S.sel && S.sel !== id) return false;
  return E.selection.has(id) || !!(S && S.sel === id) || !!(E.selected && E.selected.id === id);
}
function releaseHover(id: string): void {
  if (!hoverHeldOnly(id)) return;
  clearAllSelection(); const S = schToolState(); if (S && S.sel === id && CollabTools.sch) CollabTools.sch.select(null);
  requestRender();
}
function hoverBusy(): boolean {
  const S = schToolState();
  return !!document.querySelector(".kd-overlay, .klib-overlay, [role='dialog']") || !!E.drag || !!(S && (S.drag || S.carry || S.pedit));
}
// Waits for the action's dialog or move to end; a dialog that is still loading gets a moment to show up.
function releaseHoverWhenDone(id: string, combo: string): void {
  const opened = Date.now(); let seenBusy = false;
  const tick = (): void => {
    if (!hoverHeldOnly(id) && !hoverBusy()) return;                   // something else took the selection
    if (hoverBusy()) { seenBusy = true; setTimeout(tick, 100); return; }
    if (!seenBusy && (combo === "E" || combo === "V" || combo === "U" || combo === "F") && Date.now() - opened < 1500) { setTimeout(tick, 100); return; }
    releaseHover(id);
  };
  setTimeout(tick, 0);
}
function hoverSelect(ev: KeyboardEvent): void {
  if (!isSch() || !E.kdoc || E.tool !== "select" || !E.lastCursorMm) return;
  const combo = comboOf(ev); if (!HOVER_KEYS.has(combo)) return;
  const S = schToolState();
  if (E.selected || E.selection.size || E.selField || E.selPins.length || (S && (S.sel || S.wire || S.carry || S.drag || S.draw))) return;
  const hit = hitAny(E.lastCursorMm); if (!hit) return;
  if (HOVER_SYMBOL_ONLY.has(combo) && hit.kind !== "symbol") return;
  if (hit.fp || !CollabTools.sch) toolCtx().setSelection([hit.id]);
  else { CollabTools.sch.select(hit.id); requestRender(); }                    // wires, labels and the rest live in the module's own selection
  if (HOVER_RELEASE.has(combo)) setTimeout(() => releaseHover(hit.id), 0);
  else if (HOVER_HOLD.has(combo)) releaseHoverWhenDone(hit.id, combo);
}

// A lone selected pin: Properties and Edit Main Fields act on its parent symbol (SCH_EDIT_TOOL::Properties, EditField),
// which stays the pin's afterwards; Move and Drag take the parent symbol as the selection (SCH_MOVE_TOOL).
const PIN_PROMOTE = new Set(["E", "U", "V", "F", "M", "G"]);
function promotePin(ev: KeyboardEvent): void {
  if (!isSch() || E.selPins.length !== 1 || !E.kdoc || E.tool !== "select") return;
  const combo = comboOf(ev); if (!PIN_PROMOTE.has(combo)) return;
  const pin = E.selPins[0] as { id: string; number: string }, fp = (E.items as ItemSummary[]).find((f) => f.id === pin.id); if (!fp) return;
  E.selPins = []; E.selected = fp;
  if (combo === "M" || combo === "G") { drawSelection(); renderProps(); return; }
  setTimeout(() => { if (E.selected && E.selected.id === pin.id && !E.selection.size && !E.selPins.length) { E.selected = null; E.selPins = [pin]; renderProps(); requestRender(); } }, 0);
}
// A footprint field following the cursor (Move): R / Shift+R turn it inside the move (one commit at the drop, as
// EDIT_TOOL::Rotate in the move loop); other edits wait for the drop so no half-moved state is ever committed.  Window
// capture, ahead of the board module's own key handlers; Esc goes on to cancelInteraction.
keyHooks.unshift((ev) => {   // capture phase (hotkeys.ts preemptKey), ahead of the board module's own key handlers
  if (!E.fdrag || isSch() || ev.key === "Escape") return false;   // Esc goes on to cancelInteraction
  const c = comboOf(ev);
  if (c === "R" || c === "Shift+R") { ev.preventDefault(); rotateFieldMove(c === "R"); requestRender(); return true; }
  if (/^(F[1-9]|F1[0-2]|Home|Shift|Control|Alt|Meta| )$/.test(ev.key)) return false;
  ev.preventDefault(); return true;
});
document.addEventListener("keydown", (ev) => {
  if (state.view !== "editor" || typingTarget(ev)) return;              // a field, a dialog or an open menu owns the keyboard
  // A dialog or menu of the project UI (Share…) is open over the editor: it owns the keyboard.
  if (document.querySelector(".hp-scrim, .hp-menu-scrim")) return;
  const k = ev.key;
  if (k === "Escape") { if (store.get().popover) { closePopover(); return; }
    // KiCad's order: Esc first cancels what is in flight (the item goes back, the selection stays),
    // then leaves the tool, and only then clears the selection.
    if (cancelInteraction()) return;
    if (cmtPanel.classList.contains("open")) { closeThread(); return; }
    if (E.tool !== "select") { setTool("select"); return; }
    // an entered group is left by the Esc that finds nothing selected: the first Esc clears the selection (SCH_SELECTION_TOOL)
    if (isSch() && CollabTools.sch && CollabTools.sch.exitGroup && !selectionIds().length && !E.selField && !E.selPins.length) CollabTools.sch.exitGroup();
    if (!isSch() && CollabTools.pcb && CollabTools.pcb.exitGroup && !selectionIds().length && !E.selField && !(CollabTools.pcb.state && (CollabTools.pcb.state.padSel || (CollabTools.pcb.state as { escCleared?: unknown }).escCleared === ev))) CollabTools.pcb.exitGroup(toolCtx());
    clearAllSelection(false); if (E.highlightIds) { E.highlightIds = null; } dragG.replaceChildren(); selectionChanged(); return; }
  if (E.tool === "measure" && (comboOf(ev) === "Ctrl+C" || k === "Copy")) { ev.preventDefault(); measureCopy(); return; }   // MeasureTool takes ACTIONS::copy (the board module re-posts Ctrl+C as "Copy"): the readout of a live ruler
  promotePin(ev);
  hoverSelect(ev);                                                      // SCH_SELECTION_TOOL::RequestSelection: nothing selected -> the item under the cursor
  if ((k === "Delete" || k === "Backspace") && E.selection.size > 1 && !E.viewOnly) { ev.preventDefault(); deleteSelection(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "a" || k === "A")) { ev.preventDefault(); selectAll(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "g" || k === "G")) { ev.preventDefault(); HANDLERS.showSearch(); return; }   // ACTIONS::showSearch
  if (pcbLayerKey(ev)) { ev.preventDefault(); return; }               // the board editor's + / - step the active copper layer, as in pcbnew
  // KiCad binds no key to these on a sheet, so the web keeps +/- for zooming there (on a board they switch layers)
  if (isSch() && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (k === "+" || k === "=")) { zoomBy(1.25); return; }
  if (isSch() && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (k === "-" || k === "_")) { zoomBy(0.8); return; }
  if (comboOf(ev) === "Alt+C") { ev.preventDefault(); setTool("comment"); return; }   // the collab comment tool (C is KiCad's Unfold from Bus)
  // Ctrl+Shift+Z is redo on a Mac; elsewhere KiCad's redo is Ctrl+Y and a board has Add Filled Zone on Ctrl+Shift+Z
  if ((ev.metaKey || ev.ctrlKey) && (k === "z" || k === "Z")) { ev.preventDefault(); if (!ev.shiftKey) undoLast(); else if (!runSpecHotkey(ev)) redoLast(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "y" || k === "Y")) { ev.preventDefault(); redoLast(); return; }
  // The module's menu actions ({id: {label, key, run(ctx) -> handled}}) bind KiCad's default hotkeys after the
  // editor's own fixed keys (undo / redo, select all); an action that reports "not handled" lets the key fall through.
  // M on a board (PCB_ACTIONS::move): footprints alone go through the app's move (each step shows on peers), anything else through the module
  if (!isSch() && (k === "m" || k === "M") && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && E.tool === "select" && startMove("move")) { ev.preventDefault(); return; }
  if (runModuleHotkey(ev)) { ev.preventDefault(); return; }
  const modK = activeModule();
  if (modK && modK.onKey && !ev.metaKey && !ev.ctrlKey) { try { if (modK.onKey(k, ev, toolCtx())) { ev.preventDefault(); syncSchModes(); return; } } catch (e) { console.warn(e); } }
  if ((k === "e" || k === "E") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { if (openSelectionProperties()) { ev.preventDefault(); return; } }
  // KiCad's default hotkey table (hotkeys.ts): whichever handler, module action or tool implements the action bound to this key
  if (runSpecHotkey(ev)) { ev.preventDefault(); return; }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (!E.selected || E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if ((k === "r" || k === "R") && !isSch()) rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

installSchNets();   // the net highlight kept by name across the hierarchy (editor/schnets.ts)
installSymbolEditor(HANDLERS as unknown as Record<string, (a?: unknown) => void>);   // the Symbol Editor (web/symedit): showSymbolEditor, editWithLibEdit, editLibSymbolWithLibEdit
installDialogs(HANDLERS);   // Page Settings, Find and Replace, Symbol Fields Table / BOM, Assign Footprints, Schematic Setup, Preferences, groups
installFpEditHandlers(HANDLERS);   // the Footprint Editor's File / Edit / Place / Tools actions and Ctrl+E on the board (editor/fpedit.ts)
store.slice("tool", { handled: Object.keys(HANDLERS) });
installPcbRouting();
installProjectWatch();
installLibrary();   // window.KiCadLibrary + the placeFootprint / library browser actions (editor/library.ts)



// ---------- boot ----------
applyTheme();

(async () => { await loadMe(); route(); })();
// wherever the page started (the projects home included), the board tools are in before a board is likely to be opened
setTimeout(preloadPcbToolsWhenIdle, 2500);

// exposed for tests and tooling (window.CollabEditor.api)
E.hotkeys = { comboOf, runKicadAction, kicadActionAvailable };
/**
 * Library files made outside the editors (a plugin that imports vendor parts): symbol libraries and footprints become
 * documents of the project and rows of its library tables.  Paths are relative to the project folder.
 */
async function importLibraryFiles(files: { path: string; text: string }[]): Promise<{ added: string[]; updated: string[]; failed: string[] }> {
  const sym = await importSymbolLibraries(files.filter((f) => /\.kicad_sym$/i.test(f.path)));
  const fp = await importFootprintFiles(files.filter((f) => /\.kicad_mod$/i.test(f.path)));
  // 3D models the footprints name (${KIPRJMOD}/<library>.3dshapes/…): text files (STEP, VRML) kept as project documents
  const models = { added: [] as string[], updated: [] as string[], failed: [] as string[] };
  const project = state.project;
  for (const f of files.filter((x) => /\.(step|stp|wrl)$/i.test(x.path))) {
    if (!project || E.viewOnly) { models.failed.push(f.path); continue; }
    try {
      const have = project.docs.find((d) => d.path === f.path);
      if (have) {
        if (!(await saveTextDocument(have.docId, f.text, { id: "model", kind: "MODIFIED", typeName: "MODEL_FILE", properties: [] } as unknown as KChange))) throw new Error("not saved");
        models.updated.push(f.path);
      } else {
        const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: f.path, docType: "model3d" }) }) as { docId?: string; path?: string };
        if (!res.docId) throw new Error("no document");
        const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f.text });
        if (!r.ok) throw new Error(String(r.status));
        if (!project.docs.some((d) => d.docId === res.docId)) project.docs.push({ docId: res.docId, path: res.path || f.path, docType: "model3d" });
        models.added.push(f.path);
      }
    } catch (e) { console.warn(e); models.failed.push(f.path); }
  }
  if (models.added.length && project) store.set({ project: Object.assign({}, project) });
  return { added: [...sym.added, ...fp.added, ...models.added], updated: [...sym.updated, ...fp.updated, ...models.updated], failed: [...sym.failed, ...fp.failed, ...models.failed] };
}
// A 3D model kept in the project, for the 3D viewer and the model report (viewer3d/models.ts): the project path a
// footprint names, without its extension, to where that document's text is read.
(globalThis as { KiCadProjectModel?: (stem: string) => string | null }).KiCadProjectModel = (stem) => {
  const docs = state.project ? state.project.docs : [];
  const hit = [".step", ".stp"].map((ext) => docs.find((d) => d.docType === "model3d" && d.path.toLowerCase() === (stem + ext).toLowerCase())).find(Boolean);
  return hit ? `/api/docs/${hit.docId}/content` : null;
};
/** The project's custom design rules (.kicad_dru) replaced by `text`: the existing rules document, or a new one beside the board. */
async function saveCustomRules(path: string, text: string): Promise<boolean> {
  const project = state.project;
  if (!project || E.viewOnly) return false;
  try {
    const have = project.docs.find((d) => d.docType === "design_rules");
    if (have) {
      if (!(await saveTextDocument(have.docId, text, { id: "rules", kind: "MODIFIED", typeName: "DESIGN_RULES_FILE", properties: [{ name: "text", after: { type: "string", v: text } }] } as unknown as KChange))) return false;
    } else {
      const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path, docType: "design_rules" }) }) as { docId?: string; path?: string };
      if (!res.docId) return false;
      const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
      if (!r.ok) return false;
      if (!project.docs.some((d) => d.docId === res.docId)) project.docs.push({ docId: res.docId, path: res.path || path, docType: "design_rules" });
      store.set({ project: Object.assign({}, project) });
    }
    E.druText = text;        // DRC, the router and the length tuner read the rules from here
    requestRender();
    return true;
  } catch (e) { console.warn(e); return false; }
}

E.api = { importLibraryFiles, saveCustomRules, HANDLERS, applyChanges, applyView, clearSelection, commitChanges, dispatchAction, drawSelection, enterSheet, fitView, hitOpts, nearestFootprint, openDoc, redoLast, renderProps, requestRender, setTool, snapMm, startMove, state, store, toolCtx, undoLast, worldMm };
