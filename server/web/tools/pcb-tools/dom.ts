// pcb-tools/dom.ts — DOM: select-mode picking, stolen keys, the layer chip, the text prompt and the image picker.
import type { Hover, PcbCtx, Pt, PtrEvent } from "./types";

/** The inline prompt: done(text) on Enter, done(null) on Escape or a blur; options are suggestions. */
export type PromptFn = (title: string, initial: string, client: Pt, done: (v: string | null) => void, options: string[] | null) => void;
/** The reference image the file dialog hands back. */
export interface PickedImage { base64: string; name?: string }
/** The reference image file dialog: done(file) or done(null). */
export type PickerFn = (done: (res: PickedImage | null) => void) => void;
import { root } from "../root";
import { runAction } from "./actions";
import { appGlobal, appTool, editorState, gfxLayers, isPcbDoc, liveDoc, liveSelected, liveZoom, sizesOf } from "./app-state";
import { cancelOps } from "./assistants";
import { gfxTool, stepDrawWidth } from "./draw-modes";
import { itemAt } from "./guess";
import { hitTestItem } from "./hit";
import { editHandleUp, onHandlePointerDown } from "./point-editor";
import { undoRouteLeg } from "./route-tool";
import { onStagePointerMove, onStagePointerUp, onStickyPointerDown } from "./select-move";
import { HIT_MM, K, S, bind, lastCtx } from "./state";

// set once the stage listeners are installed (ensureDom)
export let domReady = false;
import { tuneCancel } from "./tuning-patterns";

// ---------------------------------------------------------------- DOM: select-mode picking, stolen keys, layer chip, text prompt
export function ensureDom(ctx: PcbCtx) {
  if (domReady || typeof document === "undefined" || !ctx.stage) return; domReady = true;
  // The module's pointer hooks only run while one of its tools is active; picking tracks in the app's own
  // select tool listens on the stage after app.js has had its turn with the footprints.
  ctx.stage.addEventListener("pointerdown", onStagePointerDown);
  window.addEventListener("pointerdown", onStickyPointerDown, true);   // before every stage listener: the click that drops a Move is nobody else's
  window.addEventListener("pointerdown", onHandlePointerDown, true);   // a press on an edit point belongs to the point editor
  ctx.stage.addEventListener("pointermove", onStagePointerMove, true);
  ctx.stage.addEventListener("pointerup", onStagePointerUp, true);
  ctx.stage.addEventListener("pointercancel", onStagePointerUp, true);
  // Keys app.js consumes before the module (F = fit view, Shift+C = comment, Escape) are caught in the
  // capture phase and re-posted under names of our own so they still arrive through onKey with a fresh ctx.
  document.addEventListener("keydown", onCaptureKey, true);
  // pcbnew has no canvas chip: the active layer, track width and via size live in the aux toolbar's combos
  K.pcbSizes.state.subscribe(() => { refreshChip(lastCtx!); if (lastCtx && lastCtx.requestRender) lastCtx.requestRender(); });   // the toolbar's selectors and the size hotkeys land here
  refreshChip(ctx);
}
/** Keeps the graphic tools' layer on a layer they can draw on (the toolbar's layer combo shows it). */
export function refreshChip(ctx: PcbCtx) {
  if (!isPcbDoc() || !gfxTool(S.modTool)) return;
  const opts = gfxLayers(ctx && ctx.doc);
  if (!opts.includes(S.gfxLayer)) { S.gfxLayer = opts[0] || "F.SilkS"; if (ctx) sizesOf(ctx).setActiveLayer(S.gfxLayer); }
}
export function onStagePointerDown(ev: PointerEvent) {
  if (ev.button !== 0 || !isPcbDoc() || appTool() !== "select") return;
  if (S.downHandled === ev) return;                                // onSelectDown already took this click
  if ((ev.target as Element).closest && ((ev.target as Element).closest("#cmtPanel") || (ev.target as Element).closest("#signinOverlay"))) return;
  const ctx = lastCtx, doc = liveDoc(); if (!ctx || !doc) return;
  const [x, y] = ctx.worldMm(ev);
  if (K.hitTest(doc, x, y, Math.min(5 / Math.max(1, liveZoom()! * 0.6), 0.5))) { if (S.sel.size && !selMode(ev)) { S.sel.clear(); ctx.requestRender(); } return; }   // app.js took the footprint (a modifier keeps the module's picks)
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  const mode = selMode(ev);
  if (it) { if (mode) applySelMode(S.sel, it.id, mode); else S.sel = new Set([it.id]); }
  else if (!mode) S.sel.clear();
  ctx.requestRender();
}
/** SELECTION_TOOL::setModifiersState: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift removes; null replaces. */
export function selMode(ev: PtrEvent) { const c = !!(ev && (ev.ctrlKey || ev.metaKey)), sh = !!(ev && ev.shiftKey); return c && sh ? "remove" : c ? "toggle" : sh ? "add" : null; }
export function applySelMode(set: Set<string>, id: string, mode: string | null) { if (mode === "add") set.add(id); else if (mode === "remove") set.delete(id); else if (mode === "toggle") { if (set.has(id)) set.delete(id); else set.add(id); } }
// KiCad's Ctrl+Shift chords (app.js swallows every Ctrl combo) and Alt+Z, the macOS zone hotkey — Ctrl+Shift+Z is
// the web's redo — are re-posted under names of our own.
export const CTRL_SHIFT_KEYS: Record<string, string> = { a: "Arc", p: "Polygon", b: "Bezier", h: "Ortho", k: "RuleArea", c: "Circle", v: "PasteSpecial" };
// KiCad's Ctrl+C / X / V / D (app.js would take C for the comment tool) and Alt+S (swap)
export const CTRL_KEYS: Record<string, string> = { c: "Copy", x: "Cut", v: "Paste", d: "Duplicate" };
export function repost(ev: KeyboardEvent, key: string) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
export const liveSelection = () => appGlobal(() => editorState()!.selection, null);
/**
 * ROUTER_TOOL's context hotkeys with a modifier (router_tool.cpp ACT_*), ahead of the board-wide ones they shadow while
 * the router runs: Ctrl+Z / Ctrl+V / Alt+Shift+V / Alt+< only while a track is being routed (undo the last segment,
 * microvia, blind via, select layer and place a blind via), the corner modes (Ctrl+/, Ctrl+W, Ctrl+Shift+W,
 * Ctrl+Alt+W, Alt+W) whenever the Route tool is active.  The browser keeps Ctrl+W and Ctrl+Shift+W for itself.
 */
/**
 * PCB_PICKER_TOOL: the next click hands a point (selectPointInteractively, snapped like the cursor) or the item under
 * the cursor (selectItemInteractively) to done(); Escape hands back null.  Either way the tool goes back to Select.
 */
export function pickInteractively(ctx: PcbCtx, mode: string, prompt: string, done: (res: Pt | KItem | null) => void) {
  bind(ctx); S.pick = { done, prompt }; ctx.setTool(mode === "item" ? "pickitem" : "pickpoint");   // the prompt is the tool's hint
}
export function pickClick(ctx: PcbCtx, t: string, hv: Hover, mm: Pt) {
  const pk = S.pick; S.pick = null;
  let res: Pt | KItem | null = null;
  if (t === "pickpoint") res = [hv.x, hv.y];
  else { const it = itemAt(ctx, mm); res = it || null; if (!it) { S.pick = pk; return; } }   // a click on nothing keeps picking
  ctx.setTool("select");
  if (pk && pk.done) pk.done(res);
}
export function pickCancel() { const pk = S.pick; S.pick = null; if (lastCtx) lastCtx.setTool("select"); if (pk && pk.done) pk.done(null); return true; }
/** The first Escape: the operation in flight is cancelled, KiCad style (the next one leaves the tool).  False with none. */
export function cancelInFlight(any?: boolean) {
  if (S.pick) return pickCancel();
  if (S.pedit && lastCtx) { editHandleUp(lastCtx, false); return true; }
  if (S.tune.pattern) return tuneCancel(lastCtx!);   // the first Escape drops the pattern, the next leaves the tool
  if (S.route || S.draw || S.drag || S.text || S.image || (S.move && (any || S.move.sticky))) {
    const dragTool = S.drag && S.drag.tool;
    cancelOps();
    if (dragTool && lastCtx) lastCtx.setTool("select");   // Escape ends InlineDrag: back to the selection tool
    if (lastCtx) { refreshChip(lastCtx); lastCtx.requestRender(); }   // Esc cancels silently
    return true;
  }
  return false;
}
/**
 * ACTIONS::undo / ACTIONS::redo from the menu or the toolbar while an operation is in flight (tools.ts undoLast): the
 * board's undo list is behind pcbnew's UndoRedoBlock.  Routing takes Undo as Undo Last Segment (router_tool.cpp
 * performRouting); a drag, a move or a shape being drawn takes it as a cancel ("Perform undo locally",
 * edit_tool_move_fct.cpp / drawing_tool.cpp); Redo does nothing.  True when the action was taken here.
 */
export function undoRedoInFlight(ctx: PcbCtx, which: string) {
  if (S.tune.pattern) { if (which === "undo") tuneCancel(ctx); return true; }   // Undo drops the pattern being placed
  if (S.route) { if (which === "undo" && !ctx.viewOnly) undoRouteLeg(ctx); return true; }
  if (!(S.pedit || S.draw || S.drag || S.image || S.move)) return false;
  if (which === "undo") cancelInFlight(true);
  return true;
}
export function routerKeyAction(ev: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key"> & { code?: string }) {
  const ctrl = !!(ev.ctrlKey || ev.metaKey), alt = !!ev.altKey, shift = !!ev.shiftKey, code = ev.code || "", k = ev.key;
  if (S.route) {
    if (ctrl && !alt && !shift && (k === "z" || k === "Z")) return "routerUndoLastSegment";
    if (ctrl && !alt && !shift && (code === "KeyV" || k === "v" || k === "V")) return "ACT_PlaceMicroVia";
    if (alt && shift && !ctrl && code === "KeyV") return "ACT_PlaceBlindVia";
    if (alt && !ctrl && (k === "<" || (shift && code === "Comma"))) return "ACT_SelLayerAndPlaceBlindVia";
  }
  if (ctrl && !alt && k === "/") return "ACT_SwitchCornerModeToNext";
  if (code === "KeyW" && alt && !ctrl && !shift) return "ACT_SwitchCornerModeArc90";
  if (code === "KeyW" && alt && ctrl && !shift) return "ACT_SwitchCornerMode90";
  if (code === "KeyW" && ctrl && !alt && !shift) return "ACT_SwitchCornerMode45";
  if (code === "KeyW" && ctrl && shift && !alt) return "ACT_SwitchCornerModeArc45";
  return null;
}
export function onCaptureKey(ev: KeyboardEvent) {
  if (!isPcbDoc()) return;
  const tag = ev.target && (ev.target as Element).tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "K-SELECT") return;
  if (ev.target && typeof (ev.target as Element).closest === "function" && (ev.target as Element).closest("[data-prop-label]")) return;   // a Properties row (its Ctrl+C copies the value)
  if (root.KDialogs && root.KDialogs.isOpen && root.KDialogs.isOpen()) return;
  // a context menu or the menu bar owns the keys while it is open (Escape closes the menu, not the route under it)
  if ((typeof document !== "undefined" && document.body && document.body.dataset.menuOpen === "1") || appGlobal(() => !!root.CollabApp!.getState().contextMenu, false)) return;
  const k = ev.key;
  if (S.route || S.modTool === "route" || S.modTool === "routediff") { const id = routerKeyAction(ev); if (id && lastCtx) { ev.stopImmediatePropagation(); ev.preventDefault(); runAction(id, lastCtx); return; } }
  // DRAWING_TOOL's incWidth / decWidth (Ctrl++ / Ctrl+-) while a shape is drawn, ahead of the browser's zoom
  if (S.draw && (ev.ctrlKey || ev.metaKey) && !ev.altKey && (k === "+" || k === "=" || k === "-" || k === "_") && lastCtx) {
    ev.stopImmediatePropagation(); ev.preventDefault(); stepDrawWidth(lastCtx, k === "-" || k === "_" ? -1 : 1); return;
  }
  // lineModeNext (Shift+Space, AS_GLOBAL)
  if (k === " " && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && lastCtx) { ev.stopImmediatePropagation(); ev.preventDefault(); runAction("lineModeNext", lastCtx); return; }
  if (ev.altKey && !ev.metaKey) { if (!ev.ctrlKey && !ev.shiftKey && ev.code === "KeyZ") repost(ev, "Zone"); else if (!ev.ctrlKey && !ev.shiftKey && ev.code === "KeyS") repost(ev, "Swap"); return; }
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.altKey) return;
    if (k === " " && !ev.shiftKey && lastCtx) { ev.stopImmediatePropagation(); ev.preventDefault(); runAction("cycleArcEditMode", lastCtx); return; }   // ACTIONS::cycleArcEditMode
    const ctrlRemap = typeof k === "string" ? (ev.shiftKey ? CTRL_SHIFT_KEYS[k.toLowerCase()] : CTRL_KEYS[k.toLowerCase()]) : null;
    if (ctrlRemap && !(ev.metaKey && ctrlRemap === "Circle")) repost(ev, ctrlRemap);
    return;
  }
  if (k === "Escape") {
    if (cancelInFlight()) { ev.stopImmediatePropagation(); ev.preventDefault(); }
    else if (S.sel.size || S.padSel) { S.sel.clear(); S.padSel = null; S.escCleared = ev; if (lastCtx) lastCtx.requestRender(); }   // this Esc cleared a selection: it does not also leave an entered group
    return;
  }
  let remap = null;
  const sel = liveSelection();
  if ((k === "f" || k === "F") && !ev.shiftKey && (liveSelected() || (sel && sel.size) || S.sel.size)) remap = "Flip";
  else if (k === "C" && ev.shiftKey) remap = "Circle";
  if (remap) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key: remap, bubbles: true, cancelable: true })); }
}
// Positioned prompt over the stage (text, table size, zone net — with the board's nets as suggestions); Enter commits
// the trimmed value, Escape or a blur cancels with null.  Swappable through pcb.setPrompt for the node tests.
export let promptImpl: PromptFn = function (title: string, initial, client: Pt, done, options) {
  if (typeof document === "undefined") { done(null); return; }
  closeTextPrompt();
  const x = client ? client[0] + 6 : 40, y = client ? client[1] - 14 : 40;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${Math.max(4, Math.min(x, (window.innerWidth || 800) - 330))}px;top:${Math.max(4, y)}px;z-index:60;display:flex;gap:6px;align-items:center;padding:4px 6px;border-radius:3px;border:1px solid #4D7FC4;background:#111D2C;color:#E6E6E6;font:12px var(--mono,ui-monospace,monospace)`;
  const label = document.createElement("span"); label.textContent = title; label.style.cssText = "color:#9FB3CC;white-space:nowrap"; box.appendChild(label);
  const inp = document.createElement("input"); inp.value = initial || ""; inp.placeholder = "Enter to place, Esc to cancel"; inp.spellcheck = false;
  inp.style.cssText = "width:200px;padding:2px 5px;border-radius:2px;border:1px solid #24374E;background:#0A1421;color:inherit;font:inherit;outline:none";
  if (options && options.length) {
    const dl = document.createElement("datalist"); dl.id = "pcbPromptList";
    for (const o of options) { const op = document.createElement("option"); op.value = o; dl.appendChild(op); }
    box.appendChild(dl); inp.setAttribute("list", dl.id);
  }
  box.appendChild(inp);
  let closed = false; const finish = (v: string | null) => { if (closed) return; closed = true; closeTextPrompt(); done(v); };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(inp.value.trim()); else if (e.key === "Escape") finish(null); });
  inp.addEventListener("blur", () => setTimeout(() => finish(null), 0));
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(box); S.text = { box };
  setTimeout(() => { inp.focus(); inp.select(); }, 0);   // after app.js's preventDefault on the pointerdown that opened it
};
export function closeTextPrompt() { const t = S.text; S.text = null; if (t && t.box && t.box.parentNode) t.box.parentNode.removeChild(t.box); }
// The reference image file dialog: done({ base64, name }) or done(null).  Swappable through pcb.setImagePicker.
export let pickerImpl: PickerFn = function (done) {
  if (typeof document === "undefined") { done(null); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg"; inp.style.display = "none";
  let finished = false; const finish = (v: PickedImage | null) => { if (finished) return; finished = true; if (inp.parentNode) inp.parentNode.removeChild(inp); done(v); };
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0]; if (!f) { finish(null); return; }
    const fr = new FileReader(); fr.onload = () => finish({ base64: String(fr.result).replace(/^data:[^,]*,/, ""), name: f.name }); fr.onerror = () => finish(null); fr.readAsDataURL(f);
  });
  inp.addEventListener("cancel", () => finish(null));
  document.body.appendChild(inp); inp.click();
};
/** pcb.setPrompt / pcb.setImagePicker: swap the prompt and the image picker (the node tests). */
export function setPromptImpl(fn: PromptFn) { promptImpl = fn; }
export function setPickerImpl(fn: PickerFn) { pickerImpl = fn; }
