// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { installDialogs } from "../dialogs/index";
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
import "./pcbdialogs";
import { HANDLERS, dispatchAction } from "./actions";
import { state, store } from "./appstore";
import { closeThread, placeComment } from "./comments";
import { renderObjects, snapMm, syncItemsFromDoc, updateGridStatus, applyChanges, enterSheet, openDoc } from "./doc";
import { $ } from "./dom";
import { cancelLongPress, moveLongPress, openClarifyMenu, openContextMenu, startLongPress } from "./contextmenu";
import { cancelInteraction, clearAllSelection, copperUnderBeatsFootprint, installGestures, registerPointerUp, selectionChanged, selectionIds, startMove } from "./gestures";
import { loadMe, navigate, route } from "./home";
import { sendOp } from "./net";
import { applyTheme, syncSchModes } from "./panes";
import { placeCrosshair } from "./crosshair";
import { installPcbRouting, pcbLayerKey } from "./pcbrouting";
import { installProjectWatch } from "./projectwatch";
import { breakFollow, sendPresence } from "./peers";
import { collapseSelectionTo, drawDrag, drawMeasure, drawZoomRect, finishGroupDrag, finishZoomRect, measureClick, moveGroupDrag, openSelectionProperties, startGroupDrag } from "./pointer";
import { clearSelection, selectedSet, drawBoxSel, drawSelection, fieldLocalDelta, fieldOf, finishBoxSel, groupExpand, hitAny, nearestFootprint, renderProps, renderPropsInto, hitOpts } from "./selection";
import { E } from "./state";
import "./panels/index";
import { activeModule, commitChanges, deleteSelected, deleteSelection, moduleTool, moveOp, publishUndo, redoLast, redoStack, rotateSelected, runModuleHotkey, selectAll, setTool, toolCtx, undoLast, undoStack, unlockedForEdit } from "./tools";
import { closePopover, toast } from "./util";
import { applyView, cmtPanel, dragG, fitView, isSch, requestRender, stage, world, worldMm, zoomBy } from "./view";
import { installLibrary } from "./library";
import { comboOf, kicadActionAvailable, runKicadAction, runSpecHotkey, typingTarget } from "./hotkeys";
import { selectionCount } from "./menu-actions";
window.CollabApp = { getState: store.get, subscribe: store.subscribe, dispatch: (a) => dispatchAction(a), renderProps: (el) => renderPropsInto(el), selectionCount };


// ---------- home navigation (the home view is still rendered here) ----------
document.addEventListener("click", (ev) => {
  const nav = ev.target.closest("#home [data-nav]");
  if (nav) { ev.preventDefault(); navigate(nav.dataset.nav === "explore" ? "/gallery" : "/"); }
});

window.addEventListener("popstate", route);

KiCadCanvas.onAssetLoaded = () => requestRender();


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
function moduleGhost(mod) {
  if (!mod || typeof mod.ghostSegs !== "function") return null;
  let segs = [];
  try { segs = mod.ghostSegs(toolCtx()) || []; } catch (e) { console.warn(e); return null; }
  return segs.map((g) => [Math.round(g[0] * E.IU), Math.round(g[1] * E.IU), Math.round(g[2] * E.IU), Math.round(g[3] * E.IU), Math.round((g[4] || 0.1) * E.IU)]);
}

/**
 * The ghost to attach to a presence message: the module's in-flight geometry while there is any, one empty
 * list when it ends (the "stopped" signal, which bypasses the rate limit) and nothing after that.
 */
let ghostLive = false;
function liveGhost(mod) {
  const g = moduleGhost(mod);
  if (g && g.length) { ghostLive = true; return g; }
  if (ghostLive) { ghostLive = false; return []; }
  return undefined;
}

// wheel, middle / right button, hover and lost-release recovery: KiCad's mouse model (gestures.ts).
// Installed before every other stage listener so it sees each event first.
installGestures(openContextMenu);

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
  if (ev.target.closest("#cmtPanel") || ev.target.closest("[data-schtools]")) return;
  const [x, y] = worldMm(ev); const ctx = toolCtx();
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.padProperties) {       // a pad first: KiCad opens Pad Properties on a pad
    let pad = null;
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
  if (f) { KDialogs.openField(ctx, f.item, f.name); return; }
  const best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (best) { const it = E.kdoc.items.get(best.id); if (it && it.kind === "sheet" && it.file) { enterSheet(it.file); return; } if (it) KDialogs.openItem(ctx, it); return; }   // nearestFootprint() picks sheets too
  // KiCad: a double-click on a hierarchical sheet enters it (E opens its properties)
  if (isSch()) { const sh = E.sheets.find((r) => x >= r.x / E.IU && x <= (r.x + r.w) / E.IU && y >= r.y / E.IU && y <= (r.y + r.h) / E.IU); if (sh) { const it = E.kdoc.items.get(sh.id); if (it && it.file) { enterSheet(it.file); return; } if (it) { KDialogs.openItem(ctx, it); return; } } }
  const other = hitAny([x, y]); const it = other && E.kdoc.items.get(other.id);
  if (it) KDialogs.openItem(ctx, it);
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
  if (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay")) return;
  if ((ev.button === 2 && E.rightDragPan !== false) || (ev.button === 1 && E.middleDragPan !== false) || (ev.button === 0 && E.tool === "pan")) {
    E.pan = { x: ev.clientX - E.panX, y: ev.clientY - E.panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (E.tool === "zoomtool") { E.zoomRect = { start: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (E.tool === "measure") { measureClick(snapMm(worldMm(ev))); return; }
  if (E.tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const mod = activeModule();
  if (mod && moduleTool(E.tool) && mod.onPointerDown) { if (E.viewOnly && E.tool !== "highlight") { toast("View-only access"); return; } try { if (mod.onPointerDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (E.tool === "select" && E.kdoc && !ev.shiftKey && window.KDialogs) {   // KiCad: a click on a field selects (and drags) the field, not its symbol
    const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
    if (f) {
      const wasField = !!(E.selField && E.selField.id === f.item.id && E.selField.name === f.name);   // DRAG_SELECTED: only a selected field drags
      clearSelection(); E.selField = { id: f.item.id, name: f.name }; drawSelection(); renderProps(); renderObjects(); requestRender();
      const pn = fieldOf(f.item, f.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (!wasField) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); }
      else if (at && !E.viewOnly && E.ws && E.ws.readyState === 1) { E.fdrag = { id: f.item.id, name: f.name, startMm: [x, y], orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], moved: false }; stage.setPointerCapture(ev.pointerId); }
      ev.preventDefault(); return;
    }
  }
  let best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  // Board: a click on a pad selects the pad, not its footprint (PCB_SELECTION_TOOL; the footprint is picked by its body)
  let padWasSelected = false;
  if (!isSch() && E.tool === "select" && mod && mod.selectPadAt) {
    const ps = CollabTools.pcb && CollabTools.pcb.state;
    let r: unknown = false;
    if (!smodeOf(ev)) { try { r = mod.selectPadAt(ev, [x, y], toolCtx()); } catch (e) { console.warn(e); } }
    if (r === "box") { E.selection.clear(); E.selected = null; E.selField = null; drawSelection(); renderProps(); renderObjects(); requestRender(); startModuleBox(ev, x, y); return; }
    // a press on the selected pad: a move promotes it to its footprint (FilterCollectorForFreePads, allow free pads off)
    padWasSelected = r === true;
    if (ps) ps.padSel = null;
  }
  // Board: a track / via / graphic under the cursor beats a footprint whose only claim is its empty bounding box
  // (KiCad picks the item whose geometry is under the cursor; the footprint wins on its own pads and outline).
  if (!isSch() && best && E.lastFpHit && (!E.lastFpHit.onGeom || copperUnderBeatsFootprint([x, y])) && mod && mod.onSelectDown && E.tool === "select") {
    try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { E.selection.clear(); E.selected = null; E.selField = null; drawSelection();   /* the footprint the box reached is dropped, the module's own pick stays (clearSelection would clear it too) */ renderProps(); renderObjects(); if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); }
  }
  if (!best && mod && mod.onSelectDown) { try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); } }
  const smode = selModifier(ev);
  if (!best) {
    if (!smode) { clearSelection(); drawSelection(); renderProps(); renderObjects(); }
    if (E.tool === "select" && E.kdoc) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: !!smode, mode: smode, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    return;
  }
  if (smode) {                                         // KiCad: Shift+click adds, Ctrl+click toggles, Ctrl+Shift+click removes
    if (E.selected) E.selection.add(E.selected.id);   // the single selection joins the set it is being extended to
    if (smode === "add") E.selection.add(best.id); else if (smode === "remove") E.selection.delete(best.id); else if (E.selection.has(best.id)) E.selection.delete(best.id); else E.selection.add(best.id);
    E.selected = E.selection.has(best.id) ? best : (E.selected && E.selected.id === best.id ? null : E.selected);
    if (!E.selected) for (const id of E.selection) { const f = E.items.find((q) => q.id === id); if (f) { E.selected = f; break; } }
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
  E.drag = { fp: best, startMm: [x, y], curMm: [best.x / E.IU, best.y / E.IU], moved: false, grabOff: [x - best.x / E.IU, y - best.y / E.IU], wires: [], engine: false };
  // Schematic moves run through sch-tools' connected drag: attached wires stretch (with bends in
  // 90° mode), a pin or junction under a moved pin gets a new wire, no-connects follow — KiCad's drag.
  if (E.kdoc && isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    const it = E.kdoc.items.get(best.id);
    try { if (it && CollabTools.sch.beginDrag(toolCtx(), it, [x, y], true)) E.drag.engine = true; } catch (e) { console.warn(e); }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});

/** SELECTION_TOOL::setModifiersState: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift removes; null replaces. */
const smodeOf = (ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => selModifier(ev);
function selModifier(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): "add" | "toggle" | "remove" | null {
  const c = ev.ctrlKey || ev.metaKey; return c && ev.shiftKey ? "remove" : c ? "toggle" : ev.shiftKey ? "add" : null;
}
/** DRAG_SELECTED on an item that was not selected: the press picked it (the board module's own pick), a drag draws a box. */
function startModuleBox(ev: PointerEvent, x: number, y: number): void {
  if (E.tool !== "select" || !E.kdoc) return;
  E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] };
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
}

stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  E.lastCursorMm = mm; E.lastClient = [ev.clientX, ev.clientY]; store.slice("viewport", { cursor: mm });
  placeCrosshair(mm);
  if (E.zoomRect) { drawZoomRect(ev); return; }
  if (E.boxSel) { E.boxSel.cur = mm; if (E.boxSel.lasso) E.boxSel.pts.push(mm); drawBoxSel(); return; }
  if (E.measure && !E.measure.b) { drawMeasure(snapMm(mm)); }
  if (E.pan) { E.viewTouched = true; E.panX = ev.clientX - E.pan.x; E.panY = ev.clientY - E.pan.y; breakFollow(); applyView(); sendPresence(mm); return; }
  const modM = activeModule();
  if (modM && moduleTool(E.tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm, liveGhost(modM)); return; }
  if (E.fdrag) {
    if (!E.fdrag.moved && Math.hypot(mm[0] - E.fdrag.startMm[0], mm[1] - E.fdrag.startMm[1]) > 0.4) E.fdrag.moved = true;
    if (E.fdrag.moved) {
      const it = E.kdoc && E.kdoc.items.get(E.fdrag.id), pn = it && fieldOf(it, E.fdrag.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at) {
        const w = snapMm([mm[0] - E.fdrag.startMm[0], mm[1] - E.fdrag.startMm[1]]); const [ldx, ldy] = fieldLocalDelta(it, w[0], w[1]);
        at[1] = +(E.fdrag.orig[0] + ldx).toFixed(4); at[2] = +(E.fdrag.orig[1] + ldy).toFixed(4);
        KiCadCanvas.replaceChange(E.kdoc, it); requestRender();
      }
    }
    sendPresence(mm); return;
  }
  if (!E.drag) { sendPresence(mm, liveGhost(modM)); return; }   // a Move / Drag (M / G) or a paste following the cursor ghosts to peers too
  if (E.drag.group) { moveGroupDrag(mm); sendPresence(mm); return; }
  if (E.drag.engine) {
    const d = CollabTools.sch.state.drag;
    if (!d) { E.drag = null; sendPresence(mm); return; }           // cancelled (Escape) or already dropped
    CollabTools.sch.moveDrag(toolCtx(), mm);
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
});

const onPointerUp = (ev) => {
  if (E.pan) { E.pan = null; return; }
  if (E.fdrag) {
    const fd = E.fdrag; E.fdrag = null;
    const it = E.kdoc && E.kdoc.items.get(fd.id), pn = it && fieldOf(it, fd.name), at = pn && KiCadCanvas.kid(pn, "at");
    if (fd.moved && at) {
      const nx = at[1], ny = at[2];
      at[1] = fd.orig[0]; at[2] = fd.orig[1]; KiCadCanvas.replaceChange(E.kdoc, it);          // original back so commit records the inverse
      if (nx !== fd.orig[0] || ny !== fd.orig[1]) {
        const node = JSON.parse(JSON.stringify(it.node)); const p2 = fieldOf({ node }, fd.name); const a2 = KiCadCanvas.kid(p2, "at"); a2[1] = nx; a2[2] = ny;
        commitChanges([KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null }))], "move " + fd.name.toLowerCase());
      }
      requestRender();
    }
    return;
  }
  if (E.zoomRect) { finishZoomRect(ev); return; }
  if (E.boxSel) { finishBoxSel(ev); return; }
  const modU = activeModule();
  if (modU && moduleTool(E.tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } sendPresence(worldMm(ev), liveGhost(modU)); return; }
  if (ev.button !== 0 || !E.drag) return;
  if (E.drag.group) { finishGroupDrag(); return; }
  if (E.drag.engine) {
    const fpE = E.drag.fp, cur = E.drag.curMm, clickId = E.drag.moved ? null : E.drag.clickId; E.drag = null; dragG.replaceChildren();
    if (CollabTools.sch.state.drag) { try { CollabTools.sch.endDrag(toolCtx(), true); } catch (e) { console.warn(e); } }
    sendPresence(cur, []);
    if (clickId) { collapseSelectionTo(clickId); return; }
    if (E.kdoc) syncItemsFromDoc(); E.selected = E.items.find((f) => f.id === fpE.id) || E.selected; drawSelection(); renderProps(); requestRender();
    return;
  }
  const fp = E.drag.fp, wasMoved = E.drag.moved, wires = E.drag.wires || [];
  const nx = Math.round(E.drag.curMm[0] * E.IU), ny = Math.round(E.drag.curMm[1] * E.IU);
  E.drag = null; dragG.replaceChildren();
  sendPresence([nx / E.IU, ny / E.IU], []);
  if (!wasMoved) return;
  const changes = [];
  if (nx !== fp.x || ny !== fp.y) changes.push(moveOp(fp, nx, ny));
  for (const w of wires) changes.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, w.item) });
  if (changes.length) {
    // our copy must end where we say it ends: a peer's move of the same item that arrived while the button was
    // down (and the pointer still) would otherwise stay on screen here although the server has ours
    if (E.kdoc && (nx !== fp.x || ny !== fp.y)) KiCadCanvas.applyChange(E.kdoc, moveOp(fp, nx, ny), E.IU);
    sendOp(changes);
    // inverse: put the symbol and the wire ends back
    const inverse = [moveOp({ id: fp.id, x: nx, y: ny }, fp.x, fp.y)];
    for (const w of wires) {   // the undo step: the same wire with this end back where it was
      const node = KiCadCanvas.cloneNode(w.item.node); const p = KiCadCanvas.ptsOf(node).map((q) => q.slice()); p[w.index] = w.orig; KiCadCanvas.setPts(node, p);
      inverse.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, Object.assign({}, w.item, { node })) });
    }
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  }
  fp.x = nx; fp.y = ny; if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
};
stage.addEventListener("pointerup", onPointerUp);
registerPointerUp(onPointerUp);

// The keyboard belongs to the canvas, as in KiCad: a click on it takes the focus from a panel's field, and when a
// dialog, prompt or popover closes with nothing focused, the focus goes back to it (not to the page).
stage.addEventListener("pointerdown", (ev) => {
  const t = ev.target as Element | null;
  if (t && t.closest && t.closest("input, textarea, select, button, a, [contenteditable], #cmtPanel")) return;
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
// becomes a hover selection for the one action (and a rotate / mirror lets go of it afterwards).
const HOVER_KEYS = new Set(["E", "V", "U", "F", "M", "G", "R", "Shift+R", "X", "Y", "D", "Del", "Backspace", "Ctrl+D", "Ctrl+C", "Ctrl+X", "Ctrl+E", "Alt+3", "Ctrl+4"]);
const HOVER_RELEASE = new Set(["R", "Shift+R", "X", "Y"]);
function hoverSelect(ev: KeyboardEvent): void {
  if (!isSch() || !E.kdoc || E.tool !== "select" || !E.lastCursorMm) return;
  const combo = comboOf(ev); if (!HOVER_KEYS.has(combo)) return;
  const S = CollabTools.sch ? (CollabTools.sch.state as unknown as { sel?: string | null; wire?: unknown; carry?: unknown; drag?: unknown; draw?: unknown }) : null;
  if (E.selected || E.selection.size || E.selField || (S && (S.sel || S.wire || S.carry || S.drag || S.draw))) return;
  const hit = hitAny(E.lastCursorMm); if (!hit) return;
  if (hit.fp || !CollabTools.sch) toolCtx().setSelection([hit.id]);
  else { CollabTools.sch.select(hit.id); requestRender(); }                    // wires, labels and the rest live in the module's own selection
  if (HOVER_RELEASE.has(combo)) setTimeout(() => { if (E.selection.size === 1 && E.selection.has(hit.id)) clearAllSelection(); if (S && S.sel === hit.id && CollabTools.sch) CollabTools.sch.select(null); requestRender(); }, 0);
}

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
    if (isSch() && CollabTools.sch && CollabTools.sch.exitGroup && !selectionIds().length && !E.selField) CollabTools.sch.exitGroup();
    clearAllSelection(false); if (E.highlightIds) { E.highlightIds = null; } dragG.replaceChildren(); selectionChanged(); return; }
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

installDialogs(HANDLERS);   // Page Settings, Find and Replace, Symbol Fields Table / BOM, Assign Footprints, Schematic Setup, Preferences, groups
store.slice("tool", { handled: Object.keys(HANDLERS) });
installPcbRouting();
installProjectWatch();
installLibrary();   // window.KiCadLibrary + the placeFootprint / library browser actions (editor/library.ts)


// ---------- boot ----------
applyTheme();

(async () => { await loadMe(); route(); })();

// exposed for tests and tooling (window.CollabEditor.api)
E.hotkeys = { comboOf, runKicadAction, kicadActionAvailable };
E.api = { HANDLERS, applyChanges, applyView, clearSelection, commitChanges, dispatchAction, drawSelection, enterSheet, fitView, hitOpts, nearestFootprint, openDoc, redoLast, renderProps, requestRender, setTool, snapMm, state, store, toolCtx, undoLast, worldMm };
