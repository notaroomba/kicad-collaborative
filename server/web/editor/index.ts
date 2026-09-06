// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
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
import { HANDLERS, dispatchAction } from "./actions";
import { state, store } from "./appstore";
import { placeComment } from "./comments";
import { renderObjects, snapMm, syncItemsFromDoc, updateGridStatus } from "./doc";
import { $ } from "./dom";
import { loadMe, renderHome, route } from "./home";
import { sendOp } from "./net";
import { applyTheme, syncSchModes } from "./panes";
import { breakFollow, sendPresence } from "./peers";
import { drawDrag, drawMeasure, drawZoomRect, finishGroupDrag, finishZoomRect, measureClick, moveGroupDrag, openSelectionProperties, startGroupDrag } from "./pointer";
import { clearSelection, drawBoxSel, drawSelection, fieldLocalDelta, fieldOf, finishBoxSel, groupExpand, hitAny, nearestFootprint, renderProps, renderPropsInto } from "./selection";
import { E } from "./state";
import { activeModule, commitChanges, deleteSelected, deleteSelection, moduleTool, moveOp, publishUndo, redoLast, redoStack, rotateSelected, runModuleHotkey, selectAll, setTool, toolCtx, undoLast, undoStack } from "./tools";
import { closePopover, toast } from "./util";
import { applyView, cmtPanel, dragG, fitView, isSch, requestRender, stage, world, worldMm, zoomBy } from "./view";
import { applyView, fitView, requestRender, worldMm } from "./view";
import { commitChanges, redoLast, setTool, toolCtx, undoLast } from "./tools";
import { clearSelection, drawSelection, hitOpts, nearestFootprint, renderProps } from "./selection";
import { HANDLERS, dispatchAction } from "./actions";
import { applyChanges, enterSheet, openDoc, snapMm } from "./doc";
import { state, store } from "./appstore";
import { E } from "./state";
window.CollabApp = { getState: store.get, subscribe: store.subscribe, dispatch: (a) => dispatchAction(a), renderProps: (el) => renderPropsInto(el) };


// ---------- home navigation (the home view is still rendered here) ----------
document.addEventListener("click", (ev) => {
  const nav = ev.target.closest("#home [data-nav]");
  if (nav) { state.homeTab = nav.dataset.nav; renderHome(); }
});

window.addEventListener("popstate", route);

KiCadCanvas.onAssetLoaded = () => requestRender();


// ---- editing tools (schematic / board modules register on window.CollabTools) ----
// A module: { id, tools: [{ id, label, key, icon (svg inner markup), cursor }],
//   onActivate(toolId, ctx), onPointerDown(ev, mm, ctx) -> handled?, onPointerMove(ev, mm, ctx),
//   onPointerUp(ev, mm, ctx), onKey(key, ev, ctx) -> handled?, drawOverlay(ctx2d, view, ctx),
//   onDocChanged(ctx) }.  Everything a module needs travels in ctx (see toolCtx()).
window.CollabTools = window.CollabTools || {};

stage.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomBy(Math.pow(1.0018, -ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });

   // until the user pans/zooms, resizes just refit
new ResizeObserver(() => {
  if (state.view !== "editor") return;
  const sw = stage.clientWidth;
  if (sw && E.lastStageW && sw !== E.lastStageW) {
    if (!E.viewTouched && (E.kdoc || Object.keys(E.layers).length)) { fitView(); return; }
    const r = sw / E.lastStageW; E.panX *= r; E.panY *= r; world.style.width = sw + "px";
  }
  if (sw) E.lastStageW = sw;
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
  }
  const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
  if (f) { KDialogs.openField(ctx, f.item, f.name); return; }
  const best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (best) { const it = E.kdoc.items.get(best.id); if (it) KDialogs.openItem(ctx, it); return; }
  if (isSch()) { const sh = E.sheets.find((r) => x >= r.x / E.IU && x <= (r.x + r.w) / E.IU && y >= r.y / E.IU && y <= (r.y + r.h) / E.IU); if (sh) { const it = E.kdoc.items.get(sh.id); if (it) { KDialogs.openItem(ctx, it); return; } } }
  const other = hitAny([x, y]); const it = other && E.kdoc.items.get(other.id);
  if (it) KDialogs.openItem(ctx, it);
});

stage.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || E.tool !== "select" || !E.kdoc || E.selection.size < 2 || E.viewOnly || ev.shiftKey) return;
  const mm = worldMm(ev); const hit = hitAny(mm);
  if (!hit || !E.selection.has(hit.id)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  startGroupDrag(hit, mm, ev);
}, true);

stage.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay")) return;
  if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && E.tool === "pan")) {
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
      clearSelection(); E.selField = { id: f.item.id, name: f.name }; drawSelection(); renderProps(); renderObjects(); requestRender();
      const pn = fieldOf(f.item, f.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at && !E.viewOnly && E.ws && E.ws.readyState === 1) { E.fdrag = { id: f.item.id, name: f.name, startMm: [x, y], orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], moved: false }; stage.setPointerCapture(ev.pointerId); }
      ev.preventDefault(); return;
    }
  }
  let best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  // Board: a track / via / graphic under the cursor beats a footprint whose only claim is its empty bounding box
  // (KiCad picks the item whose geometry is under the cursor; the footprint wins on its own pads and outline).
  if (!isSch() && best && E.lastFpHit && !E.lastFpHit.onGeom && mod && mod.onSelectDown && E.tool === "select") {
    try { if (mod.onSelectDown(ev, [x, y], toolCtx())) { clearSelection(); drawSelection(); renderProps(); renderObjects(); stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); }
  }
  if (!best && mod && mod.onSelectDown) { try { if (mod.onSelectDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (!best) {
    if (!ev.shiftKey) { clearSelection(); drawSelection(); renderProps(); renderObjects(); }
    if (E.tool === "select" && E.kdoc) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: ev.shiftKey, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    return;
  }
  if (ev.shiftKey) {                                   // KiCad: Shift+click adds to / removes from the selection
    if (E.selection.has(best.id)) E.selection.delete(best.id); else E.selection.add(best.id);
    E.selected = E.selection.has(best.id) ? best : (E.selected && E.selected.id === best.id ? null : E.selected);
    drawSelection(); renderProps(); renderObjects(); return;
  }
  if (!E.selection.has(best.id)) E.selection.clear();
  E.selected = best; drawSelection(); renderProps(); renderObjects();
  if (E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if (!isSch()) { const g = groupExpand([best.id]); if (g.size > 1) { E.selection = g; drawSelection(); renderObjects(); startGroupDrag({ id: best.id, fp: best }, [x, y], ev); return; } }   // a group member moves its group
  E.drag = { fp: best, startMm: [x, y], curMm: [best.x / E.IU, best.y / E.IU], moved: false, grabOff: [x - best.x / E.IU, y - best.y / E.IU], wires: [], engine: false };
  // Schematic moves run through sch-tools' connected drag: attached wires stretch (with bends in
  // 90° mode), a pin or junction under a moved pin gets a new wire, no-connects follow — KiCad's drag.
  if (E.kdoc && isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    const it = E.kdoc.items.get(best.id);
    try { if (it && CollabTools.sch.beginDrag(toolCtx(), it, [x, y], true)) E.drag.engine = true; } catch (e) { console.warn(e); }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});

stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  E.lastCursorMm = mm; store.slice("viewport", { cursor: mm });
  if (E.crosshairMode !== "small") { const r = stage.getBoundingClientRect(); const cy = ev.clientY - r.top, cx = ev.clientX - r.left; $("#chH").setAttribute("y1", cy); $("#chH").setAttribute("y2", cy); $("#chV").setAttribute("x1", cx); $("#chV").setAttribute("x2", cx); }
  if (E.zoomRect) { drawZoomRect(ev); return; }
  if (E.boxSel) { E.boxSel.cur = mm; if (E.boxSel.lasso) E.boxSel.pts.push(mm); drawBoxSel(); return; }
  if (E.measure && !E.measure.b) { drawMeasure(snapMm(mm)); }
  if (E.pan) { E.viewTouched = true; E.panX = ev.clientX - E.pan.x; E.panY = ev.clientY - E.pan.y; breakFollow(); applyView(); return; }
  const modM = activeModule();
  if (modM && moduleTool(E.tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm); return; }
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
  if (!E.drag) { sendPresence(mm); return; }
  if (E.drag.group) { moveGroupDrag(mm); sendPresence(mm); return; }
  if (E.drag.engine) {
    const d = CollabTools.sch.state.drag;
    if (!d) { E.drag = null; sendPresence(mm); return; }           // cancelled (Escape) or already dropped
    CollabTools.sch.moveDrag(toolCtx(), mm);
    if (!d.moved) { sendPresence(mm); return; }
    E.drag.moved = true; E.drag.curMm = [E.drag.fp.x / E.IU + d.last[0], E.drag.fp.y / E.IU + d.last[1]];
    const nowE = Date.now();
    if (nowE - E.lastLiveMove > 150 && d.kind === "symbol") { E.lastLiveMove = nowE; sendOp([moveOp(E.drag.fp, Math.round(E.drag.curMm[0] * E.IU), Math.round(E.drag.curMm[1] * E.IU))]); }
    sendPresence(mm); return;
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
  if (now - E.lastLiveMove > 150) { E.lastLiveMove = now; sendOp([moveOp(E.drag.fp, Math.round(target[0] * E.IU), Math.round(target[1] * E.IU))]); }
  const s = 4;
  const g = [[mm[0]-s, mm[1]-s, mm[0]+s, mm[1]-s], [mm[0]+s, mm[1]-s, mm[0]+s, mm[1]+s],
             [mm[0]+s, mm[1]+s, mm[0]-s, mm[1]+s], [mm[0]-s, mm[1]+s, mm[0]-s, mm[1]-s]]
    .map((sg) => [...sg.map((v) => Math.round(v * E.IU)), 100000]);
  sendPresence(mm, g);
});

stage.addEventListener("pointerup", (ev) => {
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
  if (modU && moduleTool(E.tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } return; }
  if (ev.button !== 0 || !E.drag) return;
  if (E.drag.group) { finishGroupDrag(); return; }
  if (E.drag.engine) {
    const fpE = E.drag.fp, cur = E.drag.curMm; E.drag = null; dragG.replaceChildren();
    if (CollabTools.sch.state.drag) { try { CollabTools.sch.endDrag(toolCtx(), true); } catch (e) { console.warn(e); } }
    sendPresence(cur, []);
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
    if (E.ws && E.ws.readyState === 1) sendOp(changes);
    // inverse: put the symbol and the wire ends back
    const inverse = [moveOp({ id: fp.id, x: nx, y: ny }, fp.x, fp.y)];
    for (const w of wires) { const p = KiCadCanvas.ptsOf(w.item.node).map((q) => q.slice()); p[w.index] = w.orig; inverse.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: "(kicad_sch (version 20250114) (generator \"kicad-collab-web\") " + KiCadCanvas.serialize(Object.assign([], w.item.node, { })).replace(/\(pts[^]*?\)\)/, "(pts " + p.map((q) => `(xy ${q[0]} ${q[1]})`).join(" ") + ")") + ")" }); }
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  }
  fp.x = nx; fp.y = ny; if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
});


document.addEventListener("keydown", (ev) => {
  if (["TEXTAREA", "INPUT"].includes(ev.target.tagName) || state.view !== "editor") return;
  const k = ev.key;
  if (window.KDialogs && KDialogs.isOpen()) return;                     // the dialog owns the keyboard
  if (k === "Escape") { if (store.get().popover) { closePopover(); return; }
    if (E.selField || E.fdrag) { E.selField = null; E.fdrag = null; requestRender(); }
    if (E.drag && E.drag.engine && CollabTools.sch && CollabTools.sch.cancelDrag) { try { CollabTools.sch.cancelDrag(toolCtx()); } catch (e) { console.warn(e); } }
    E.drag = null; E.boxSel = null; clearSelection(); if (E.highlightIds) { E.highlightIds = null; } dragG.replaceChildren(); drawSelection(); renderProps(); cmtPanel.style.display = "none"; setTool("select"); return; }
  if ((k === "Delete" || k === "Backspace") && E.selection.size > 1 && !E.viewOnly) { ev.preventDefault(); deleteSelection(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "a" || k === "A")) { ev.preventDefault(); selectAll(); return; }
  if (k === "f" || k === "F") { fitView(); return; }
  if (k === "+" || k === "=") { zoomBy(1.25); return; }
  if (k === "-" || k === "_") { zoomBy(0.8); return; }
  if (k === "s" || k === "S") { setTool("select"); return; }
  if (k === "h" || k === "H") { setTool("pan"); return; }
  if (k === "c" || k === "C") { setTool("comment"); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "z" || k === "Z")) { ev.preventDefault(); if (ev.shiftKey) redoLast(); else undoLast(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "y" || k === "Y")) { ev.preventDefault(); redoLast(); return; }
  // The module's menu actions ({id: {label, key, run(ctx) -> handled}}) bind KiCad's default hotkeys after the
  // editor's own fixed keys (F, S, H, C, ±, undo); an action that reports "not handled" lets the key fall through.
  if (runModuleHotkey(ev)) { ev.preventDefault(); return; }
  const modK = activeModule();
  if (modK && modK.onKey && !ev.metaKey && !ev.ctrlKey) { try { if (modK.onKey(k, ev, toolCtx())) { ev.preventDefault(); syncSchModes(); return; } } catch (e) { console.warn(e); } }
  if (k === " " && !ev.shiftKey) { ev.preventDefault(); E.localOrigin = E.lastCursorMm.slice(); store.slice("viewport", { origin: E.localOrigin.slice() }); return; }
  if ((k === "e" || k === "E") && !ev.metaKey && !ev.ctrlKey) { if (openSelectionProperties()) { ev.preventDefault(); return; } }
  if (k === "g" || k === "G") { E.gridOn = !E.gridOn; updateGridStatus(); requestRender(); return; }
  if (k === "n" || k === "N") { E.snapOn = !E.snapOn; updateGridStatus(); return; }
  if (!E.selected || E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if ((k === "r" || k === "R") && !isSch()) rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

store.slice("tool", { handled: Object.keys(HANDLERS) });


// ---------- boot ----------
applyTheme();

(async () => { await loadMe(); route(); })();

// exposed for tests and tooling (window.CollabEditor.api)
E.api = { HANDLERS, applyChanges, applyView, clearSelection, commitChanges, dispatchAction, drawSelection, enterSheet, fitView, hitOpts, nearestFootprint, openDoc, redoLast, renderProps, requestRender, setTool, snapMm, state, store, toolCtx, undoLast, worldMm };
