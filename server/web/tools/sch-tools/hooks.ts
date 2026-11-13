import type { SchCtx, Pt, Mods, PtrEvent } from "./types";
import { root } from "../root";
import { editFieldPrompt } from "./annotate";
import { autoplaceSelection } from "./autoplace";
import { dropCarry, placeCarry, singleClickPlace, startCarry } from "./carry";
import { closePicker, closePrompt, curTool, installDom, openPicker, openPowerPicker, promptClassLabel, promptFor } from "./dom";
import { announceModes, beginDrag, cycleLineMode, endDrag, setDragMode } from "./drag";
import { clearHighlight, highlightClick, highlightNetNow, pickNet, setHighlight } from "./highlight";
import { pickAny } from "./hit";
import { openImagePicker } from "./images";
import { finishWire } from "./junction";
import { busEntryNode, junctionNode, noConnectNode } from "./nodes";
import { repeatLast } from "./repeat";
import { deleteAt, deleteSelected, duplicateSelected, orientSelected } from "./selection-edits";
import { finishSchArc, showSchArcMode, schArcBackup, schArcDrawMode, schArcMove, schArcPosture, switchSchArcMode } from "./arcs";
import { cancelDraw, drawClick, drawPoint, finishDraw, undoDrawPoint } from "./shapes";
import { beginPinPlace, movePinPlace, sheetAt, sheetPinClick } from "./sheets";
import { mmPerPx, snapConn } from "./snap";
import { DRAW_TOOLS, S, TEXT_KINDS, atOf, toolOf } from "./state";
import { restoreBreak } from "./transforms";
import { ghost, same } from "./util";
import { startWire, switchPosture, undoSegment, wireClick, wireFollow } from "./wire";

// ---------------------------------------------------------------- hooks (see app.js "editing tools")
// What an operation in flight says when another tool is activated (KiCad refuses the activation and keeps going).
export function busyMessage() {
  if (S.wire) return "Press <ESC> to cancel drawing.";
  if (S.drag) return S.drag.mode === "break" ? "Press <ESC> to cancel break." : S.drag.mode === "slice" ? "Press <ESC> to cancel slice."
    : S.dragMode === "move" ? "Press <ESC> to cancel move." : "Press <ESC> to cancel drag.";
  if (S.draw && S.draw.shape === "sheet") return "Press <ESC> to cancel sheet creation.";
  if (S.pinPlace) return "Press <ESC> to cancel item creation.";
  if (S.carry) {
    const k = S.carry.kind;
    if (k === "symbol") return "Press <ESC> to cancel symbol creation.";
    if (k === "image") return "Press <ESC> to cancel image creation.";
    if (TEXT_KINDS.has(k) || k === "netclass_flag" || k === "directive_label" || k === "text_box") return "Press <ESC> to cancel item creation.";
  }
  return null;
}
/** The app asks before it changes tool: true refuses (the infobar says how to cancel what is in flight). */
export function vetoTool(toolId: string, ctx: SchCtx) {
  if (S.internalSwitch) return false;
  const msg = busyMessage(); if (!msg) return false;
  if (ctx && ctx.toast) ctx.toast(msg);
  return true;
}
// The active tool's own hotkey while it is drawing counts as a click at the cursor (isSyntheticClick).
export function syntheticClick(ctx: SchCtx) {
  if (!S.cursor) return false;
  return onPointerDown({ button: 0, synthetic: true }, S.cursor, ctx);
}
export function onActivate(toolId: string, ctx: SchCtx) {
  S.ctx = ctx; installDom(ctx); announceModes(ctx);
  if (!S.internalSwitch && busyMessage()) { ctx.toast(busyMessage()!); ctx.requestRender(); return; }   // refused: the operation keeps going
  S.tool = toolId;
  closePrompt(); S.pending = null; if (S.drag) endDrag(ctx, false);
  if (S.draw) S.draw = null;                      // an unfinished shape is dropped with its tool
  if (toolId === "arc") showSchArcMode(ctx);       // SelectToolbarAction( DrawArcForMode ): the Arc group shows the mode
  if (!toolOf(toolId)) { closePicker(); S.carry = null; ctx.requestRender(); return; }
  S.sel = null; S.hover = null; S.selEnds = null;
  if (toolId !== "place" && toolId !== "power" && toolId !== "image") S.carry = null;   // a carried duplicate rides into the place tool
  if (toolId !== "image") S.imageWait = false;    // a file chosen after leaving the tool is ignored anyway
  // TwoClickPlace( placeSheetPin ): the selected sheet is the one to work on, and the first pin comes up at once
  S.pinPlace = null; S.pinSheet = null;
  if (toolId === "sheetpin" && !ctx.viewOnly) {
    const ids = ctx.selection ? Array.from(ctx.selection as Iterable<string>) : [];
    const sh = ids.map((id) => ctx.doc.items.get(id)).find((it) => it && it.kind === "sheet") || (ctx.selected ? ctx.doc.items.get(ctx.selected.id) : undefined);
    if (sh && sh.kind === "sheet") { S.pinSheet = sh.id; beginPinPlace(ctx, sh, S.cursor || atOf(sh.node) as Pt); }
  }
  if (toolId === "junction") startCarry(ctx, "junction", junctionNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "noconnect") startCarry(ctx, "no_connect", noConnectNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "busentry") startCarry(ctx, "bus_entry", busEntryNode(S.cursor || [0, 0], 2.54, 2.54), S.cursor);
  else if (toolId === "place" && !S.carry) openPicker(ctx, S.cursorClient);
  else if (toolId === "power" && !S.carry) openPowerPicker(ctx, S.cursorClient);
  else if (toolId === "image" && !S.carry) openImagePicker(ctx);
  ctx.requestRender();
}
// pointerdown carries no click count in every browser (Chrome reports 0): count it here like the OS double-click (500 ms, 4 px)
let lastDown: { t: number; x: number; y: number; n: number } | null = null;
export function clickCount(ev: PtrEvent) {
  if (ev.detail! >= 2) return ev.detail!;
  const t = ev.timeStamp, x = ev.clientX, y = ev.clientY!;
  if (t === undefined || x === undefined) return ev.detail || 1;
  const n = lastDown && t - lastDown.t < 500 && Math.hypot(x - lastDown.x, y - lastDown.y) <= 4 ? lastDown.n + 1 : 1;
  lastDown = { t, x, y, n }; return n;
}
/** A pointer press as the hooks see it; a synthetic one (the tool's own hotkey) carries only the button. */
export type DownEvent = PtrEvent & { synthetic?: boolean };
export function onPointerDown(ev: DownEvent, mm: Pt, ctx: SchCtx) {
  S.ctx = ctx; installDom(ctx);
  if (ev.button !== undefined && ev.button !== 0) return false;
  const t = toolOf(S.tool); if (!t) return false;
  const dbl = clickCount(ev) === 2;
  S.cursor = mm; if (ev.clientX !== undefined) S.cursorClient = [ev.clientX, ev.clientY!];
  if (t.kind === "wire" || t.kind === "bus" || t.kind === "polyline") {
    const p = snapConn(ctx, mm, t.kind, ev);
    if (!S.wire) { if (!dbl) startWire(ctx, t.kind, p); } else wireClick(ctx, p, dbl);
    return true;
  }
  if (TEXT_KINDS.has(t.kind as string)) {   // tools without a kind are never text tools
    if (S.carry) dropCarry(ctx); else promptFor(ctx, t.kind as string, mm, S.cursorClient);
    return true;
  }
  if (t.id === "junction" || t.id === "noconnect" || t.id === "busentry") {
    if (!S.carry) onActivate(t.id, ctx);
    placeCarry(ctx, mm, ev); singleClickPlace(ctx, t.id, dbl);
    return true;
  }
  if (t.id === "place" || t.id === "power") {
    if (S.carry) { placeCarry(ctx, mm); const placed = dropCarry(ctx); if (root.KiCadLibrary && root.KiCadLibrary.afterPlace) root.KiCadLibrary.afterPlace(ctx, placed, t.id); }
    else if (t.id === "place") openPicker(ctx, S.cursorClient);
    else openPowerPicker(ctx, S.cursorClient);
    return true;
  }
  if (t.id === "classlabel") { if (S.carry) { placeCarry(ctx, mm); dropCarry(ctx); } else promptClassLabel(ctx, mm, S.cursorClient); return true; }
  if (t.id === "image") { if (S.carry) { placeCarry(ctx, mm); dropCarry(ctx); } else openImagePicker(ctx); return true; }
  if (t.id === "sheetpin") { sheetPinClick(ctx, mm); return true; }
  if (t.id === "highlight") { highlightClick(ctx, mm); return true; }   // empty space clears it
  if (t.id === "sheet" && S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return true; }
  if (DRAW_TOOLS.has(t.id)) {
    if (S.draw && S.draw.await) return true;
    if (t.id === "arc" && dbl && S.draw && S.draw.arc) { finishSchArc(ctx); return true; }   // drawManagedShape: IsDblClick keeps what is drawn
    drawClick(ctx, t.id, drawPoint(ctx, mm)); return true;
  }
  if (t.id === "delete") { deleteAt(ctx, mm); return true; }   // an empty click is ours too: the tool stays armed
  return false;
}
export function onPointerMove(ev: PtrEvent | null | undefined, mm: Pt, ctx: SchCtx) {
  S.ctx = ctx; S.cursor = mm; if (ev && ev.clientX !== undefined) S.cursorClient = [ev.clientX, ev.clientY!];
  S.mods = ev ? { shiftKey: !!ev.shiftKey, ctrlKey: !!ev.ctrlKey, metaKey: !!ev.metaKey, altKey: !!ev.altKey } : null;
  if (S.wire) { const p = snapConn(ctx, mm, S.wire.kind, ev); if (!same(S.wire.cur, p)) { wireFollow(ctx, p); ctx.requestRender(); } return; }
  if (S.carry) { placeCarry(ctx, mm, ev); return; }
  if (S.draw && S.draw.arc) { const p = drawPoint(ctx, mm); if (!same(S.draw.cur, p)) { schArcMove(S.draw, p); ctx.requestRender(); } return; }
  if (S.draw && !S.draw.await) { const p = drawPoint(ctx, mm); if (!same(S.draw.cur, p)) { S.draw.cur = p; ctx.requestRender(); } return; }
  if (S.pinPlace) { movePinPlace(ctx, mm); return; }
  if (S.tool === "highlight" || S.tool === "sheetpin") {   // what the click would pick: a net item / pin, or the sheet under the cursor
    let id: string | null = null;
    if (S.tool === "highlight") { const p = pickNet(ctx, mm); id = p ? p.item.id : null; }
    else if (!ctx.viewOnly) { const e = S.pinSheet ? ctx.doc.items.get(S.pinSheet) : sheetAt(ctx.doc, mm, Math.max(0.5, 4 * mmPerPx(ctx))); id = e ? e.id : null; }
    if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
    return;
  }
  if (S.tool === "delete") {                      // what the click would remove
    const hit = ctx.viewOnly ? null : pickAny(ctx, mm), id = hit ? hit.id : null;
    if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
    return;
  }
  if (toolOf(S.tool)) ctx.requestRender();        // cursor marker
}
export function onPointerUp() { /* clicks are handled on pointerdown, drags in the capture hooks */ }
/**
 * Keys while a wire is being drawn (doDrawSegments): '/' switches the posture, End / Enter / K finish,
 * Backspace (undoLastSegment), Del (doDelete) and Ctrl+Z (undo) take back the last segment.  With nothing
 * left to take back Ctrl+Z reaches the document's undo and the others do nothing; Ctrl+Y (redo) does nothing.
 */
export function wireKey(ctx: SchCtx, combo: string) {
  if (!S.wire) return false;
  if (combo === "/") { switchPosture(ctx); return true; }
  if (combo === "Enter" || combo === "End" || combo === "k" || combo === "K") { finishWire(ctx); return true; }   // ACTIONS::finishInteractive
  if (combo === "Backspace" || combo === "Del") { undoSegment(ctx); return true; }
  if (combo === "Ctrl+Z") return undoSegment(ctx);
  if (combo === "Ctrl+Y" || combo === "Ctrl+Shift+Z") return true;
  return false;
}
export function onKey(key: string, ev: Mods | null | undefined, ctx: SchCtx) {
  S.ctx = ctx; installDom(ctx);
  if (ctx.viewOnly) return false;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const armTool = (id: string, kind?: string) => {
    // mid-operation the tool's own hotkey is a click at the cursor; any other tool is refused (doDrawSegments)
    const busy = busyMessage();
    if (busy) { if (id === S.tool) syntheticClick(ctx); else ctx.toast(busy); return true; }
    ctx.setTool(id);
    if (S.cursor && (kind === "wire" || kind === "bus" || kind === "polyline")) startWire(ctx, kind, snapConn(ctx, S.cursor, kind));   // KiCad starts drawing under the cursor
    else if (S.cursor && TEXT_KINDS.has(kind as string)) promptFor(ctx, kind as string, S.cursor, S.cursorClient);   // undefined is never a text kind
    return true;
  };
  if (S.wire && wireKey(ctx, key === "Backspace" ? "Backspace" : key === "Delete" ? "Del" : key)) return true;
  if (S.draw && S.draw.arc) {   // EE_GRAPHIC_TOOL::drawManagedShape with an ARC_MODE_SESSION
    if (key === "Enter" || key === "End") { finishSchArc(ctx); return true; }
    // deleteLastPoint (Backspace) always backs up; doDelete (Del) only once the arc is started, before that it is the
    // selection's delete (the arc just committed is selected)
    if (key === "Backspace" || (key === "Delete" && S.draw.started)) { schArcBackup(ctx); return true; }
    if (key === "/") { if (ev && ev.altKey) switchSchArcMode(ctx, (schArcDrawMode() + 1) % 5); else schArcPosture(ctx); return true; }
    if (key === "Escape") { cancelDraw(ctx); return true; }
  }
  if (S.draw && !S.draw.await) {
    if (key === "Enter" || key === "End") {
      const sh = S.draw.shape, n = S.draw.pts.length;
      if ((sh === "lines" && n >= 2) || ((sh === "polygon" || sh === "rulearea") && n >= 3)) finishDraw(ctx); else cancelDraw(ctx);
      return true;
    }
    if (key === "Backspace") { undoDrawPoint(ctx); return true; }
    if (key === "Escape") { cancelDraw(ctx); return true; }
  }
  switch (key) {
  case "`": return highlightNetNow(ctx);                     // SCH_ACTIONS::highlightNet: at once, no tool
  case "w": case "W": return armTool("wire", "wire");
  case "b": case "B": return armTool("bus", "bus");
  case "z": case "Z": return armTool("busentry");
  case "j": case "J": return armTool("junction");
  case "q": case "Q": return armTool("noconnect");
  case "p": case "P": return armTool("power");
  case "i": case "I": return armTool("lines", "polyline");
  case "l": return armTool("label", "label");
  case "L": return armTool("glabel", "global_label");
  case "h": case "H": return armTool("hlabel", "hierarchical_label");   // KiCad's default for Add Hierarchical Label
  case "t": case "T": return armTool("text", "text");
  case "a": case "A": return armTool("place");
  case "r": return orientSelected(ctx, "ccw");
  case "R": return orientSelected(ctx, ev && ev.shiftKey ? "cw" : "ccw");
  case "x": case "X": return orientSelected(ctx, "y");     // KiCad's X is Mirror Horizontally: (mirror y)
  case "y": case "Y": return orientSelected(ctx, "x");     // Y is Mirror Vertically: (mirror x)
  case "d": case "D": return duplicateSelected(ctx);
  case "Insert": return repeatLast(ctx);
  case "o": case "O": return autoplaceSelection(ctx);
  case "u": case "U": return editFieldPrompt(ctx, "Reference", "Reference", true);
  case "v": case "V": return editFieldPrompt(ctx, "Value", "Value", true);
  case "~": if (!S.highlight && !(S.netHL && S.netHL.active())) return false; clearHighlight(ctx); return true;
  case "g": case "G": case "m": case "M": {
    setDragMode(ctx, lower === "m" ? "move" : "drag");
    if (S.drag) return true;                                // switched mid-drag: the preview re-resolved
    const it = S.sel ? ctx.doc.items.get(S.sel) : null; if (!it || !S.cursor) return false;   // a symbol / multi-selection is the editor's (startMove)
    return !!beginDrag(ctx, it, S.cursor, false);
  }
  case " ": if (ev && ev.shiftKey) { cycleLineMode(ctx); return true; } return false;
  case "Delete": case "Backspace": return deleteSelected(ctx);
  default: return false;
  }
}
export function onDocChanged(ctx: SchCtx) {
  S.ctx = ctx; installDom(ctx); S.docGen++;
  // An edit of the same sheet (ours or a peer's) leaves a wire, a shape or an item on the cursor alone, as an
  // undo does on the desktop; a different sheet ends them.
  const sameDoc = S.docRef === ctx.doc;
  if (!sameDoc) { S.wire = null; S.carry = null; S.draw = null; S.pinPlace = null; S.pinSheet = null; }
  else if (S.pinPlace) { const pp = S.pinPlace; pp.item = null; movePinPlace(ctx, S.cursor || pp.p); }
  else if (S.carry) S.carry.item = ghost(ctx.doc, S.carry.node);
  if (S.drag) {                                 // a paste or Pin Helpers > Wire in flight is ours alone and rides on; anything else in flight is dropped
    const d = S.drag;
    const ours = d.local || (d.brk && d.brk.mode === "wirepins" && d.brk.orig.size === 0 && [...d.brk.local].every((id) => ctx.doc.items.has(id)));
    if (!(ours && sameDoc)) {
      S.drag = null; if (d.restoreMode) S.dragMode = d.restoreMode;
      if (sameDoc && d.brk) restoreBreak(ctx.doc, d.brk);
    }
  }
  S.pending = null; S.hover = null; S.sheetJob = sameDoc ? S.sheetJob : null; S.imageWait = false;
  if (!sameDoc || !(S.sel && ctx.doc.items.has(S.sel))) S.sel = null;
  if (S.docRef !== ctx.doc) {                   // a different sheet (app.js also calls this after every commit, same doc): repeat memory, ERC markers and an unfold in progress belong to the old one
    S.docRef = ctx.doc; S.lastPlaced = null; S.unfold = null;
    if (S.markersDoc !== ctx.doc) { S.markers = []; S.markersDoc = null; }
  }
  if (S.netHL) S.netHL.docChanged(ctx, sameDoc);          // UpdateNetHighlighting: the named net is collected again on this sheet
  else if (S.highlight && !sameDoc) setHighlight(ctx, null);   // an edit of the same sheet keeps the net highlighted
  if (!sameDoc) { closePrompt(); closePicker(); }
  announceModes(ctx);
  S.tool = curTool();
}
