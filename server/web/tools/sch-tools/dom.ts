import type { SchCtx, Pt, Mods, PtrEvent } from "./types";
import { lineEndAt, selectThreshold, setSelEnd } from "./line-ends";
import { root } from "../root";
import { cancelCarry, placeText, startCarry } from "./carry";
import { cancelPinPlace } from "./sheets";
import { schArcUndo } from "./arcs";
import { AUTOSTART_CURSOR, AUTOSTART_TOOL, autostartKind } from "./dangling";
import { beginDrag, endDrag, moveDrag } from "./drag";
import { clearHighlight } from "./highlight";
import { pickNonSymbol } from "./hit";
import { busyMessage, syntheticClick, wireKey } from "./hooks";
import { cancelWire, switchTool } from "./junction";
import { classLabelNode, labelNode, symbolNode } from "./nodes";
import { pointEditEnd, pointEditMove, pointEditStart } from "./point-edit";
import { rememberPlaced } from "./repeat";
import { cancelDraw } from "./shapes";
import { mmPerPx, snapConn } from "./snap";
import { K, S, kid, kids, str, toolOf } from "./state";
import { breakAgain } from "./transforms";
import { addNode, deep, r4, replaceKid, segDist, segs } from "./util";
import { startWire } from "./wire";

// ---------------------------------------------------------------- DOM: inline prompt, symbol picker, capture hooks
export const hasDom = () => typeof document !== "undefined" && S.ctx && S.ctx.stage;
export function el<T extends keyof HTMLElementTagNameMap>(tag: T, css: string, text?: string): HTMLElementTagNameMap[T] { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; e.dataset.schtools = "1"; return e; }
export const PANEL_CSS = "position:absolute;z-index:30;background:var(--panel,#fff);color:var(--ink,#1b1b1b);border:1px solid var(--line,#ccc);border-radius:4px;box-shadow:var(--shadow,0 6px 20px #0003);font:12px var(--font,system-ui,sans-serif);";
export const INPUT_CSS = "background:var(--paper,#f5f4ef);color:inherit;border:1px solid var(--line,#ccc);border-radius:3px;padding:3px 6px;font:12px var(--mono,ui-monospace,monospace);outline:none;";
export function placePanel(box: HTMLElement, client: Pt | null | undefined) {
  const r = S.ctx!.stage.getBoundingClientRect();
  const x = client ? client[0] - r.left + 10 : 12, y = client ? client[1] - r.top + 10 : 12;
  box.style.left = Math.max(4, Math.min(r.width - 280, x)) + "px"; box.style.top = Math.max(4, Math.min(r.height - 60, y)) + "px";
}
// Positioned <input> over the stage; Enter commits, Escape cancels.  Swappable for tests.
/** The inline prompt: title, initial text, where to open it (client px), and done(text or null). */
export type PromptFn = (title: string, initial: string, client: Pt | null | undefined, done: (v: string | null) => void) => void;
export let promptImpl: PromptFn = function (title, initial, client, done) {
  if (!hasDom()) { done(null); return; }
  closePrompt();
  const box = el("div", PANEL_CSS + "display:flex;gap:6px;align-items:center;padding:5px 8px;");
  box.appendChild(el("span", "color:var(--ink-2,#666);white-space:nowrap", title));
  const inp = el("input", INPUT_CSS + "width:170px"); inp.value = initial || ""; inp.spellcheck = false; box.appendChild(inp);
  let closed = false;
  const finish = (v: string | null) => { if (closed) return; closed = true; closePrompt(); done(v); };
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(inp.value.trim() || null); else if (ev.key === "Escape") finish(null); });
  inp.addEventListener("blur", () => setTimeout(() => finish(null), 0));
  placePanel(box, client); S.ctx!.stage.appendChild(box); S.prompt = box; inp.focus(); inp.select();
};
/** CollabTools.sch.setPrompt: swap the prompt (tests, the chrome's dialogs). */
export function setPromptImpl(fn: PromptFn) { promptImpl = fn; }
export function closePrompt() { if (S.prompt) { S.prompt.remove(); S.prompt = null; } }
// A library symbol counts as a power symbol the way KiCad's chooser filters them: the (power) flag,
// the power: library, or a #PWR / #FLG reference.
export function isPowerSymbol(doc: KDoc, name: string) {
  const lib = K.resolveLib(doc, name) || doc.lib.get(name); if (!lib) return false;
  if (kid(lib, "power")) return true;
  if (/^power:/i.test(name)) return true;
  const ref = kids(lib, "property").find((p) => str(p[1]) === "Reference"); const v = ref ? str(ref[2]) : "";
  return v === "#PWR" || v === "#FLG";
}
export function powerSymbols(doc: KDoc) { return Array.from(doc.lib.keys()).filter((n) => isPowerSymbol(doc, n)).sort((a, b) => a.localeCompare(b)); }
// Chosen from the picker (or by a test): the symbol rides on the cursor until the click.
export function pickSymbol(ctx: SchCtx, name: string) { closePicker(); startCarry(ctx, "symbol", symbolNode(ctx.doc, name, S.cursor || [0, 0], 0, ""), S.cursor); }
/** The built-in symbol picker's options: the names to list, its title, and the text shown when there are none. */
export interface PickerOpts { names?: string[]; title?: string; empty?: string }
export function openPicker(ctx: SchCtx, client: Pt | null | undefined, opts?: PickerOpts) {
  if (!hasDom()) return; closePicker();
  if (!opts && root.KiCadLibrary && root.KiCadLibrary.toolChooser) { root.KiCadLibrary.toolChooser(ctx, "place"); return; }   // KiCad's Choose Symbol dialog (web/editor/library.ts)
  const o: PickerOpts = opts || {};
  const names = o.names || Array.from(ctx.doc.lib.keys()).sort((a, b) => a.localeCompare(b));
  const box = el("div", PANEL_CSS + "width:260px;padding:6px;display:flex;flex-direction:column;gap:6px;");
  const head = el("div", "display:flex;gap:6px;align-items:center"); head.appendChild(el("span", "color:var(--ink-2,#666);white-space:nowrap", o.title || "Place symbol"));
  const inp = el("input", INPUT_CSS + "flex:1;min-width:0"); inp.placeholder = "filter…"; inp.spellcheck = false; head.appendChild(inp); box.appendChild(head);
  const list = el("div", "max-height:240px;overflow:auto;border-top:1px solid var(--line,#ccc)"); box.appendChild(list);
  const pick = (name: string) => pickSymbol(ctx, name);
  const fill = () => {
    const q = inp.value.trim().toLowerCase(); list.replaceChildren();
    const shown = names.filter((n) => !q || n.toLowerCase().includes(q));
    if (!shown.length) list.appendChild(el("div", "padding:6px 8px;color:var(--ink-2,#666)", names.length ? "No match" : o.empty || "This sheet has no library symbols yet"));
    for (const n of shown.slice(0, 200)) {
      const row = el("div", "padding:3px 8px;cursor:pointer;font:12px var(--mono,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", n);
      row.title = n; row.addEventListener("mouseenter", () => row.style.background = "var(--paper,#f5f4ef)"); row.addEventListener("mouseleave", () => row.style.background = "");
      row.addEventListener("click", () => pick(n)); list.appendChild(row);
    }
    list.dataset.first = shown[0] || "";
  };
  inp.addEventListener("input", fill);
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && list.dataset.first) pick(list.dataset.first); else if (ev.key === "Escape") { closePicker(); } });
  fill(); placePanel(box, client); ctx.stage.appendChild(box); S.picker = box; inp.focus();
}
export function closePicker() { if (S.picker) { S.picker.remove(); S.picker = null; } }
export const NO_POWER = "This sheet's library has no power symbols yet — place one from the desktop first";
// The power tool's picker: only power symbols; with none in the sheet library the tool stays armed and says so.
export function openPowerPicker(ctx: SchCtx, client: Pt | null | undefined) {
  if (hasDom() && root.KiCadLibrary && root.KiCadLibrary.toolChooser) return root.KiCadLibrary.toolChooser(ctx, "power");   // Choose Power Symbol
  const names = powerSymbols(ctx.doc);
  if (!names.length) { ctx.toast(NO_POWER, 3500); return false; }
  openPicker(ctx, client, { title: "Place power symbol", names, empty: NO_POWER });
  return true;
}
export function schActive() { return typeof document === "undefined" || !!document.querySelector('#ltools [data-modtool="wire"]'); }
export function curTool() { if (typeof document !== "undefined") { const b = document.querySelector<HTMLElement>("#ltools .tb.on"); if (b) return b.dataset.modtool || b.dataset.tool || S.tool; } return S.tool; }
// app.js owns the stage events; capture-phase listeners let this module see the clicks the
// select tool would otherwise drop (non-symbol items) and the keys app.js swallows (Escape, Shift+H).
export function installDom(ctx: SchCtx) {
  if (S.dom || typeof document === "undefined" || !ctx.stage) return; S.dom = true;
  const stage = ctx.stage;
  stage.addEventListener("pointerdown", onDownCapture, true);
  stage.addEventListener("pointermove", onMoveCapture, true);
  stage.addEventListener("pointerup", onUpCapture, true);
  stage.addEventListener("dblclick", (ev) => {
    if (!schActive()) return;
    const ctx = S.ctx;
    // a double click always finishes a move, even breaks (pointerdown carries no click count, the dblclick does);
    // the double click that ended one opens no properties dialog either
    if (S.drag && ctx) { endDrag(ctx, true); ev.stopImmediatePropagation(); ev.preventDefault(); return; }
    if (toolOf(curTool()) || Date.now() - (S.dragEndedAt || 0) < 600) { ev.stopImmediatePropagation(); ev.preventDefault(); }
  }, true);
  document.addEventListener("keydown", onKeyCapture, true);
}
export function onDownCapture(ev: PointerEvent) {
  const ctx = S.ctx; if (!ctx || !schActive()) return;
  const tgt = ev.target as Partial<Element> | null;
  if (tgt && tgt.closest && tgt.closest("[data-schtools]")) { ev.stopImmediatePropagation(); return; }
  closePrompt(); closePicker();
  const tool = curTool();
  if (toolOf(tool)) return;                                  // app.js forwards these to onPointerDown
  if (tool !== "select" || ev.button !== 0) return;
  const mm = ctx.worldMm(ev);
  if (S.drag) {                                              // a key-started drag is dropped by the click (BREAK: a single click breaks again)
    if (!(S.drag.brk && breakAgain(ctx))) endDrag(ctx, true);
    ev.stopImmediatePropagation(); ev.preventDefault(); return;
  }
  if (!ev.shiftKey && pointEditStart(ctx, mm, ev)) { ev.stopImmediatePropagation(); ev.preventDefault(); return; }   // SCH_POINT_EDITOR runs ahead of the selection tool
  // SCH_SELECTION_TOOL runs autostartEvent only for IsClick( BUT_LEFT ): remember the press, and start the line on
  // the release if the pointer has not travelled (a press-drag from the same place box-selects or moves instead)
  S.autoPress = autostartAt(ctx, mm, ev, true) ? { mm, client: [ev.clientX, ev.clientY], mods: ev } : null;
  const hit = ctx.viewOnly ? null : pickNonSymbol(ctx, mm);
  if (!hit) { if (S.sel) { S.sel = null; setSelEnd(null, null); ctx.requestRender(); } return; }
  ev.stopImmediatePropagation(); ev.preventDefault();
  // selectPoint: a line clicked near one end is selected by that end (STARTPOINT / ENDPOINT).  A press on the item
  // already selected keeps the selection as it is, so a drag moves what was selected (SCH_SELECTION_TOOL::Main only
  // re-selects on a click, which onUpCapture does)
  const already = S.sel === hit.id;
  S.sel = hit.id; S.hover = null; ctx.setSelected(null);
  if (!already) setSelEnd(hit.id, lineEndAt(hit, mm, selectThreshold(ctx)));
  S.pending = { item: hit, mm };
  try { ctx.stage.setPointerCapture(ev.pointerId); } catch (e) { /* not a real pointer */ }
  ctx.requestRender();
}
// A plain click with the selection tool on a dangling anchor starts the wire (bus, line) there; finishing it
// returns to the selection tool (quitOnDraw).
export function autostartAt(ctx: SchCtx, mm: Pt, ev: Mods | null | undefined, probe?: boolean) {
  if (!S.autoStartWires || ctx.viewOnly || (ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey))) return false;
  const p = snapConn(ctx, mm, "wire"), kind = autostartKind(ctx.doc, p); if (!kind) return false;
  if (Math.hypot(p[0] - mm[0], p[1] - mm[1]) > Math.max((ctx.gridPitch || 1.27) * 0.5, 6 * mmPerPx(ctx))) return false;
  if (probe) return true;
  S.sel = null; S.hover = null; S.pending = null; S.selEnds = null; if (ctx.setSelection) ctx.setSelection([]); else ctx.setSelected(null);
  switchTool(ctx, AUTOSTART_TOOL[kind]);
  startWire(ctx, kind, p, { quitOnDraw: true }); S.cursor = p;
  return true;
}
// The selection tool's hover cursor over an anchor that would start a line (SCH_SELECTION_TOOL::Main).
export function autostartCursor(ctx: SchCtx, mm: Pt) {
  if (!ctx.stage || !S.autoStartWires || ctx.viewOnly) return;
  const p = snapConn(ctx, mm, "wire"); let kind: string | null = null;
  if (Math.hypot(p[0] - mm[0], p[1] - mm[1]) <= Math.max((ctx.gridPitch || 1.27) * 0.5, 6 * mmPerPx(ctx))) kind = autostartKind(ctx.doc, p);
  const want = kind ? AUTOSTART_CURSOR[kind] : "";
  S.autoCursor = want || null;   // the editor's cursor (editor/cursors.ts) shows it
}
/**
 * The KICURSOR the running tool switches to (null: its declared one): a symbol, sheet or other item riding on the
 * cursor shows MOVING (sch_drawing_tools.cpp:213, sch_move_tool.cpp), a label, text or sheet pin about to be
 * placed PLACE (setCursor at 1938), a drag MOVING.
 */
const PLACE_KINDS = new Set(["label", "global_label", "hierarchical_label", "directive_label", "netclass_flag", "text", "text_box", "sheet_pin", "junction", "no_connect", "bus_entry"]);
/**
 * VIEW_CONTROLS::GetCursorPosition while a tool forces it: the end of the wire being drawn, an item riding the
 * cursor, a shape's corner, or (Draw Wires / Buses / Lines idle) the pin or wire end the next click starts on.
 */
export function cursorPos(): Pt | null {
  if (S.wire) return S.wire.cur.slice();
  if (S.carry && S.carry.pos) return S.carry.pos.slice();
  if (S.draw && S.draw.cur && !S.draw.await) return S.draw.cur.slice();
  const ctx = S.ctx; const t = S.tool;
  if (ctx && ctx.doc && S.cursor && (t === "wire" || t === "bus" || t === "lines")) return snapConn(ctx, S.cursor, t === "lines" ? "polyline" : t);
  return null;
}
export function cursorNow(): string | null {
  if (S.drag && (S.drag as { moved?: boolean }).moved !== false) return "MOVING";
  if (S.carry) return PLACE_KINDS.has(S.carry.kind) ? "PLACE" : "MOVING";
  return null;
}
export function onMoveCapture(ev: PointerEvent) {
  const ctx = S.ctx; if (!ctx || !schActive()) return;
  const mm = ctx.worldMm(ev); S.cursor = mm; S.cursorClient = [ev.clientX, ev.clientY];
  if (S.pedit) { pointEditMove(ctx, mm, ev); return; }
  if (S.drag) { moveDrag(ctx, mm); return; }
  if (S.pending) {
    if (Math.hypot(mm[0] - S.pending.mm[0], mm[1] - S.pending.mm[1]) > 0.4) { const p = S.pending; S.pending = null; if (beginDrag(ctx, p.item, p.mm, true)) moveDrag(ctx, mm); }
    return;
  }
  const tool = curTool();
  if (tool !== "select") { S.autoCursor = null; if (S.hover && tool !== "delete") { S.hover = null; ctx.requestRender(); } return; }   // the delete tool keeps its own hover
  const hit = ctx.viewOnly ? null : pickNonSymbol(ctx, mm), id = hit ? hit.id : null;
  if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
  if (!ev.buttons) autostartCursor(ctx, mm);
}
export function onUpCapture(ev?: PtrEvent) {
  const ctx = S.ctx; if (!ctx) return;
  const press = S.autoPress; S.autoPress = null;
  const pend = S.pending;
  S.pending = null;
  if (pend && S.sel === pend.item.id && !S.drag) setSelEnd(pend.item.id, lineEndAt(pend.item, pend.mm, selectThreshold(ctx)));   // the click's selectPoint
  if (S.pedit) pointEditEnd(ctx, true);
  if (S.drag && S.drag.byPointer) { endDrag(ctx, true); return; }
  if (press && ev && Math.hypot(ev.clientX! - press.client[0], ev.clientY! - press.client[1]) < CLICK_PX && curTool() === "select" && !S.drag && !S.wire) {
    // after the release has run its course (the press may have selected the symbol under the pin): start the line
    setTimeout(() => { if (curTool() === "select" && !S.drag && !S.wire && !S.carry) { autostartAt(ctx, press.mm, press.mods); ctx.requestRender(); } }, 0);
  }
}
export const CLICK_PX = 4;                                          // a press that travels less than this is a click (the box-select threshold)
export function onKeyCapture(ev: KeyboardEvent) {
  const ctx = S.ctx; if (!ctx || !schActive()) return;
  const tgt = ev.target as (Partial<HTMLInputElement> & { closest?: Element["closest"] }) | null;
  const tag = tgt && tgt.tagName; if (tag === "TEXTAREA" || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color)$/.test(tgt!.type!))) return;
  if (tgt && tgt.closest && tgt.closest(".kd-overlay, [role='dialog'], [role='menu'], [data-prop-label]")) return;
  // keys that would otherwise reach the document's undo / redo or the selection's delete mid-operation
  const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key && ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
  const combo = ctrl ? "Ctrl+" + (ev.shiftKey ? "Shift+" : "") + k : k === "Delete" ? "Del" : k;
  if (S.wire && (combo === "Del" || combo === "Backspace" || combo === "Ctrl+Z" || combo === "Ctrl+Y" || combo === "Ctrl+Shift+Z")) {
    if (wireKey(ctx, combo)) { ev.stopImmediatePropagation(); ev.preventDefault(); }
    return;
  }
  const eat = () => { ev.stopImmediatePropagation(); ev.preventDefault(); };
  // EE_GRAPHIC_TOOL::drawManagedShape: once an arc is started undo drops just that arc (cleanup(), the tool stays for
  // the next one) and redo beeps; before that both reach the document
  if (S.draw && S.draw.arc && S.draw.started) {
    if (combo === "Ctrl+Z") { schArcUndo(ctx); eat(); return; }
    if (combo === "Ctrl+Y" || combo === "Ctrl+Shift+Z") { eat(); return; }
  }
  // SCH_MOVE_TOOL (move, drag, paste, break): undo cancels, redo and duplicate beep, delete ends the move (a paste in
  // flight then has nothing left: it goes without a trace)
  if (S.drag && !S.pedit) {
    if (combo === "Ctrl+Z") { S.drag.cancel = "undo"; endDrag(ctx, false); eat(); return; }
    if (combo === "Ctrl+Y" || combo === "Ctrl+Shift+Z" || combo === "Ctrl+D") { eat(); return; }
    if (combo === "Del" || combo === "Backspace") { if (S.drag.local) { endDrag(ctx, false); eat(); return; } endDrag(ctx, true); return; }
  }
  // TwoClickPlace / PlaceSymbol: undo with an item on the cursor cancels it, delete too, redo beeps
  if (S.pinPlace && (combo === "Ctrl+Z" || combo === "Del" || combo === "Backspace")) { cancelPinPlace(ctx); eat(); return; }
  if (S.carry && busyMessage()) {
    if (combo === "Ctrl+Z" || combo === "Del" || combo === "Backspace") { cancelCarry(ctx); eat(); return; }
    if (combo === "Ctrl+Y" || combo === "Ctrl+Shift+Z") { eat(); return; }
  }
  if (ctrl) return;
  if (tag === "INPUT" && (ev.key === " " || ev.key === "Enter")) return;   // a ticked filter box keeps Space / Enter
  if (ev.key === "Escape") {
    let took = true;
    if (S.pedit) pointEditEnd(ctx, false); else if (S.picker) closePicker(); else if (S.prompt) closePrompt(); else if (S.wire) cancelWire(ctx); else if (S.draw) cancelDraw(ctx);   // KiCad: Esc discards the wire being drawn
    else if (S.carry) cancelCarry(ctx); else if (S.pinPlace) cancelPinPlace(ctx); else if (S.drag) endDrag(ctx, false); else if (S.highlight && S.escClearsNetHighlight !== false) clearHighlight(ctx); else took = false;
    if (S.sel || S.hover) { S.sel = null; S.hover = null; S.pending = null; S.selEnds = null; ctx.requestRender(); }
    if (took) { ev.stopImmediatePropagation(); ev.preventDefault(); }   // first Escape ends the operation, the next one leaves the tool
  } else if (ev.key === "H" && ev.shiftKey && !ctx.viewOnly) {
    ev.stopImmediatePropagation(); ev.preventDefault();
    const busy = busyMessage(); if (busy) { if (S.tool === "hlabel") syntheticClick(ctx); else ctx.toast(busy); return; }
    ctx.setTool("hlabel");
    if (S.cursor) promptFor(ctx, "hierarchical_label", S.cursor, S.cursorClient);
  }
}
// KiCad's label and text tools (SCH_DRAWING_TOOLS::createNewLabel / createNewText) open the properties dialog
// of the new item first; OK puts it on the cursor and the next click places it.  A local or global label clicked
// onto a wire whose net is driven by a label takes that name with no dialog (findWireLabelDriverName).  New labels
// take the schematic's default text size and the bold / italic / orientation / shape last used
// (m_lastTextBold, m_lastTextItalic, m_lastTextOrientation, m_lastGlobalLabelShape, m_lastNetClassFlagShape); the
// dialog's "Multiple label input" list is placed one label per click.
export function wireAtPoint(doc: KDoc, p: Pt) {
  for (const it of doc.items.values()) if (it.kind === "wire") for (const [a, b] of segs(it)) if (segDist(p, a, b) < 1e-6) return it;
  return null;
}
export function labelDefaults() { const d = S.netHL && S.netHL.labelDefaults ? S.netHL.labelDefaults() : null; return { textSize: d && d.textSize > 0 ? d.textSize : 1.27, intersheetRefsShow: !!(d && d.intersheetRefsShow) }; }
export const SPIN_ROT = [0, 90, 180, 270];
export function newLabelNode(ctx: SchCtx, kind: string, p: Pt) {
  const d = labelDefaults(), spin = S.lastTextSpin || 0, rot = SPIN_ROT[spin] || 0;
  let node: SNode;
  if (kind === "netclass_flag") {
    node = classLabelNode("", p, rot);
    const sh = kid(node, "shape"); if (sh && S.lastFlagShape) sh[1] = S.lastFlagShape;
    // createNewLabel: a Netclass field and an italic, visible Component Class field
    const nc = kids(node, "property").find((q) => str(q[1]) === "Netclass")!;
    const cc: SNode = ["property", "Component Class", "", deep(kid(nc, "at")!), ["effects", ["font", ["size", d.textSize, d.textSize], ["italic", "yes"]], ["justify", "left", "bottom"]]];
    node.splice(node.indexOf(nc) + 1, 0, cc);
    return node;
  }
  if (kind === "text") {
    node = labelNode("text", "", p, S.lastTextVertical ? 90 : 0);
    const e = kid(node, "effects")!, f = kid(e, "font")!; replaceKid(f, ["size", d.textSize, d.textSize]);
    if (S.lastTextBold) f.push(["bold", "yes"]); if (S.lastTextItalic) f.push(["italic", "yes"]);
    if (S.lastTextH || S.lastTextV) { const jv: string[] = []; if (S.lastTextH && S.lastTextH !== "center") jv.push(S.lastTextH); if (S.lastTextV && S.lastTextV !== "center") jv.push(S.lastTextV); replaceKid(e, ["justify", ...jv]); if (!jv.length) e.splice(e.indexOf(kid(e, "justify")!), 1); }
    return node;
  }
  node = labelNode(kind, "", p, rot);
  const e = kid(node, "effects")!, f = kid(e, "font")!; replaceKid(f, ["size", d.textSize, d.textSize]);
  if (S.lastTextBold) f.push(["bold", "yes"]); if (S.lastTextItalic) f.push(["italic", "yes"]);
  if ((kind === "global_label" || kind === "hierarchical_label") && S.lastLabelShape) { const sh = kid(node, "shape"); if (sh) sh[1] = S.lastLabelShape; }
  if (kind === "global_label") { const isr = kids(node, "property").find((q) => str(q[1]) === "Intersheetrefs"); if (isr) { const hd = kid(isr, "hide"); if (d.intersheetRefsShow && hd) isr.splice(isr.indexOf(hd), 1); } }
  return node;
}
export function promptFor(ctx: SchCtx, kind: string, mm: Pt, client: Pt | null | undefined) {
  const p = ctx.snap([mm[0], mm[1]]).map(r4);
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (KD && KD.openNew && !ctx.viewOnly) {
    const node = newLabelNode(ctx, kind, p);
    if ((kind === "label" || kind === "global_label") && S.netHL && S.netHL.wireDriverName) {
      const w = wireAtPoint(ctx.doc, p), name = w ? S.netHL.wireDriverName(w.id) : "";
      if (name) { node[1] = name; startCarry(ctx, kind, node, S.cursor || p); return; }   // Auto-create from attached wire
    }
    KD.openNew(ctx, kind, node, (staged: SNode, more?: SNode[]) => {
      if (kind !== "netclass_flag" && !str(staged[1]).trim()) { ctx.toast(kind === "text" ? "Text can not be empty." : "Label can not be empty."); return false; }
      const sh = kid(staged, "shape"); if (sh && (kind === "global_label" || kind === "hierarchical_label")) S.lastLabelShape = str(sh[1]);
      S.labelQueue = Array.isArray(more) ? more.slice() : [];
      startCarry(ctx, kind, staged, S.cursor || p);
    });
    return;
  }
  const title = kind === "text" ? "Text" : kind === "label" ? "Net label" : kind === "global_label" ? "Global label" : "Hierarchical label";
  promptImpl(title, "", client, (text) => { if (text) placeText(ctx, kind, text, p, 0); });
}
// Directive label: the label dialog first (Netclass and Component Class fields), then the flag rides on the cursor.
export function promptClassLabel(ctx: SchCtx, mm: Pt, client: Pt | null | undefined) {
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (KD && (KD.openNew as typeof KD.openNew | undefined) && !ctx.viewOnly) { promptFor(ctx, "netclass_flag", mm, client); return; }
  const p = ctx.snap([mm[0], mm[1]]).map(r4);
  promptImpl("Netclass", "", client, (name) => { if (name) placeClassLabel(ctx, name, p, 0); });
}
export function placeClassLabel(ctx: SchCtx, name: string, p: Pt, rot: number) {
  const doc = ctx.doc; const { item, change } = addNode(doc, classLabelNode(name, p, rot || 0));
  ctx.commit([change], "directive label");
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null); ctx.requestRender();
  return item;
}
