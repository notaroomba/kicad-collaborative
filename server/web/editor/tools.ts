// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { setGroupCurrent, setStatusBar, state, store } from "./appstore";
import { refreshCrosshair, toolCursor } from "./crosshair";
import { applyChanges, enterSheet, publishDocs, renderObjects, snapMm } from "./doc";
import { toolChanging } from "./gestures";
import { sendOp } from "./net";
import { cycleFollow } from "./peers";
import { clearSelection, drawSelection, filterAllows, groupExpand, renderProps, selFilter } from "./selection";
import { E } from "./state";
import { api, toast } from "./util";
import type { CommitOpts, ItemSummary, UndoEntry } from "./types";
import { dragG, isSch, pxPerMm, requestRender, requestRepaint, stage, worldMm } from "./view";
   // ERC/DRC markers handed over by the tool modules; the project's .kicad_pro text (design rules)
// KiCad's clipboard is s-expression text: the modules write it here and to the system clipboard when allowed.
// read() takes the system clipboard when it holds any s-expression (a lone (text …), (bus …), (sheet …) is one too).
export const appClipboard = { text: "", get() { return appClipboard.text; }, set(t: unknown) { appClipboard.text = String(t || ""); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(appClipboard.text).catch(() => {}); },
  async read() { try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t && /^\s*\(\s*[a-z_]+[\s("]/i.test(t)) return t; } } catch (e) { /* permission denied: use the buffer */ } return appClipboard.text; } };

export const undoStack: UndoEntry[] = [], redoStack: UndoEntry[] = [];

export function activeModule(): SchToolModule | PcbToolModule | null | undefined { if (!E.kdoc) return null; return isSch() ? CollabTools.sch : CollabTools.pcb; }

export function toolCtx(extra?: Record<string, unknown>) {
  return Object.assign({
    K: KiCadCanvas, doc: E.kdoc, IU: E.IU, isSch: isSch(), fpEditor: !!(E.kdoc && E.kdoc.fpEditor), zoom: E.zoom, pxPerMm: pxPerMm(), gridPitch: E.gridPitch, snapOn: E.snapOn, snap: snapMm, tool: E.tool, selFilter: selFilter(), activeLayer: E.activeLayer,
    selected: E.selected, items: E.items, sheets: E.sheets, viewOnly: E.viewOnly, live: !!(E.ws && E.ws.readyState === 1), stage, worldMm, selection: E.selection, docs: state.docs!, project: state.project, api, docId: state.docId,
    setHighlight(ids: Set<string> | null) { E.highlightIds = ids && ids.size ? new Set(ids) : null; requestRender(); },
    cursor: E.lastCursorMm, clipboard: appClipboard, designSettings: E.proSettings, customRules: E.druText,
    setSelection(ids: Iterable<string> | null) { E.selection = new Set([...(ids || [])].filter((id) => E.kdoc && E.kdoc.items.has(id))); E.selected = null; E.selField = null; E.selPins = []; for (const id of E.selection) { const f = E.items.find((x: ItemSummary) => x.id === id); if (f) { E.selected = f; break; } } store.slice("selection", { ids: [...E.selection], primary: E.selected ? E.selected.id : null, version: (state.selection ? state.selection.version || 0 : 0) + 1 }); drawSelection(); renderProps(); renderObjects(); requestRender(); },
    setMarkers(list: unknown) { E.markers = Array.isArray(list) ? list : []; E.renderOpts.markers = E.markers.length ? E.markers : undefined; store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); if (E.markers.length) toast(`${E.markers.length} marker${E.markers.length === 1 ? "" : "s"}`); },
    setSelected(fp: { id: string } | null) { E.selected = fp ? (E.items.find((f: ItemSummary) => f.id === fp.id) || fp) : null; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    // opts.amend folds the change into the previous undo step (a paste and the move that places it are one step)
    commit(changes: KChange[], label?: string, opts?: CommitOpts) { commitChanges(changes, label, opts); },
    undo() { undoLast(); },
    applyLocal(changes: KChange[]) { applyChanges(changes); },
    requestRender: requestRepaint, toast, enterSheet, setTool,
    // PCB_BASE_FRAME::SelectToolbarAction: a toolbar group shows the given action (the arc tool's drawing mode)
    setGroupCurrent(group: string, id: string) { if (store.get().groupCurrent[group] !== id) setGroupCurrent(group, id); },
    // PCB_SELECTION_TOOL's hover selection: the Clarify Selection candidates under a point, the popup that asks
    // between them (the pick is selected, then `then` runs with a fresh context), and the app's own footprint
    // drag handed to the module's move (a turn in flight)
    candidatesAt(mm: [number, number]) { return E.hooks && E.hooks.candidatesAt ? E.hooks.candidatesAt(mm) : null; },
    clarify(ids: string[], then: (ctx: ToolCtx) => void) { if (E.hooks && E.hooks.clarify) E.hooks.clarify(ids, () => then(toolCtx())); },
    handoffDrag() { return !!(E.hooks && E.hooks.handoffDrag && E.hooks.handoffDrag()); },
    // Ask a desktop editor in this document to do what the browser cannot (fill zones).
    requestDesktop(action: string) { if (!E.ws || E.ws.readyState !== 1 || !E.joinedDocId) return false; E.ws.send(JSON.stringify({ type: "request", docId: E.joinedDocId, action })); return true; },
    setStatus(text: string) { setStatusBar({ mode: text || "" }); },
    // WarpMouseCursor: the browser cannot move the pointer, so the crosshair and the cursor position go there
    warpCursor(mm: [number, number] | null) { if (!mm) return; E.lastCursorMm = [mm[0], mm[1]]; store.slice("viewport", { cursor: E.lastCursorMm }); refreshCrosshair(); requestRender(); },
  }, extra || {});
}

// Local apply + broadcast, with an inverse recorded for undo.
/**
 * opts.amend folds the changes into the last undo step (a paste and the move that places it are one step, as in
 * pcbnew's commit); with opts.discard as well the step is dropped (the paste was cancelled and the amend took it out).
 * opts.tentative marks a step whose items still follow the cursor: a discard brings the redo list back.
 */
/** Watchers of local edits (ZONE_FILLER_TOOL's dirty-zone refill): called before the edit applies and after. */
export const commitObservers: ((phase: "before" | "after", changes: unknown[], label: string | undefined, opts: unknown) => void)[] = [];
export function commitChanges(changes: KChange[] | null | undefined, label?: string, opts?: CommitOpts) {
  // EDIT_TOOL::DeleteItems on fields only: "Hide Field(s)", or the info bar when nothing changes (pcb-tools deleteChanges)
  const tag = changes as (KChange[] & { hideLabel?: string; infoError?: string }) | null | undefined;
  if (tag && tag.infoError && !tag.length) { toast(tag.infoError, 4000); return; }
  if (tag && tag.hideLabel && (label === "delete" || label === "Delete")) label = tag.hideLabel;
  if (!changes || !changes.length) return;
  for (const f of commitObservers) { try { f("before", changes, label, opts); } catch (e) { console.error(e); } }
  const inverse: KChange[] = [];
  for (const c of changes) {
    const it = E.kdoc && E.kdoc.items.get(c.id);
    if (c.kind === "ADDED") inverse.push({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] });
    else if (c.kind === "REMOVED" && it) inverse.push({ id: c.id, kind: "ADDED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
    else if (c.kind === "MODIFIED" && c.id === "footprint" && E.kdoc && E.kdoc.fpEditor) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.footprintDoc.footprintHeaderSexpr(E.kdoc) });   // the Footprint Editor's own footprint
    else if (c.kind === "MODIFIED" && it) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
  }
  applyChanges(changes);
  sendOp(changes);   // journalled and replayed on reconnect even when the socket is down
  const top = opts && opts.amend ? undoStack[undoStack.length - 1] : null;
  const held = top && top.heldRedo ? top.heldRedo : null; if (top) delete top.heldRedo;
  for (const e of undoStack) delete e.heldRedo;   // any other edit settles a tentative step
  if (top && opts!.discard) { undoStack.pop(); if (held) { redoStack.length = 0; redoStack.push(...held); publishUndo(); return; } }   // a cancelled paste: BOARD_COMMIT::Revert leaves the redo list alone
  else if (top) { top.changes = top.changes.concat(changes); top.inverse = inverse.concat(top.inverse); }
  else {
    const entry: UndoEntry = { label: label || "edit", changes, inverse };
    // opts.tentative: items that still follow the cursor (a paste, a duplicate) — the redo list is kept aside until
    // the step is placed (amend) or cancelled (amend + discard), when it comes back
    if (opts && opts.tentative) entry.heldRedo = redoStack.slice();
    undoStack.push(entry); if (undoStack.length > 200) undoStack.shift();
  }
  redoStack.length = 0; publishUndo();
  if (isSch() && label === "sheet") publishDocs();   // a new sheet file joined the project
  for (const f of commitObservers) { try { f("after", changes, label, opts); } catch (e) { console.error(e); } }
}

// One undo list per document.  The stacks used to be global: Ctrl+Z after entering another sheet applied the
// previous sheet's inverse to the sheet now open (its items were written into the wrong file, for everyone).
// The exported arrays stay the same objects (other modules push onto them); their contents follow the open document.
const undoByDoc = new Map<string, { undo: UndoEntry[]; redo: UndoEntry[] }>(); let undoDocId: string | null = null;
export function bindUndoDoc(docId: string | null | undefined) {
  docId = docId || null; if (docId === undoDocId) return;
  if (undoDocId) undoByDoc.set(undoDocId, { undo: undoStack.slice(), redo: redoStack.slice() });
  const next = docId ? undoByDoc.get(docId) : null;
  undoStack.length = 0; redoStack.length = 0;
  if (next) { undoStack.push(...next.undo); redoStack.push(...next.redo); }
  undoDocId = docId; publishUndo();
}

/** Record an undo step for a document that is not the open one (an edit made there from here: Replace All, Sync Sheet Pins). */
export function pushUndoFor(docId: string | null | undefined, entry: UndoEntry) {
  if (!docId || docId === undoDocId) { undoStack.push(entry); redoStack.length = 0; publishUndo(); return; }
  const st = undoByDoc.get(docId) || { undo: [], redo: [] }; st.undo.push(entry); st.redo = []; undoByDoc.set(docId, st);
}

export function publishUndo() { store.set({ undo: { undo: undoStack.length, redo: redoStack.length } }); }

/**
 * Undo / Redo while a tool has an operation in flight (a route, a drag, a move, a shape being drawn) never reach the
 * board's undo list: pcbnew holds an UndoRedoBlock there and the tool takes ACTIONS::undo itself (the router's Undo
 * Last Segment, a move or a drawing cancelled).  The active module answers true when it took the action.
 */
function moduleTakesUndo(which: string) {
  const m = activeModule(); if (!m || typeof m.undoRedo !== "function") return false;
  try { return !!m.undoRedo(toolCtx(), which); } catch (e) { console.warn(e); return false; }
}

export function undoLast() {
  if (moduleTakesUndo("undo")) return;
  const e = undoStack.pop(); if (!e) { toast("Nothing to undo"); return; }
  const redo = e.changes.map((c): KChange => { const it = E.kdoc.items.get(c.id); return c.kind === "REMOVED" ? c : (it ? { id: c.id, kind: c.kind === "ADDED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) } : c); });
  applyChanges(e.inverse); sendOp(e.inverse);
  if (e.undoOthers) e.undoOthers();   // one commit over several sheets (Edit Text and Graphics) undoes them all
  redoStack.push({ label: e.label, changes: redo, inverse: e.inverse, undoOthers: e.undoOthers, redoOthers: e.redoOthers }); publishUndo();   // pcbnew / eeschema say nothing on an undo
}

export function redoLast() {
  if (moduleTakesUndo("redo")) return;
  const e = redoStack.pop(); if (!e) { toast("Nothing to redo"); return; }
  applyChanges(e.changes); sendOp(e.changes);
  if (e.redoOthers) e.redoOthers();
  undoStack.push(e); publishUndo();
}

/** The active module's tools and menu actions ({id: {label, key, run(ctx)}}), for the toolbar and the menus. */
export function renderModuleTools() {
  const m = activeModule();
  const tools = m && m.tools ? m.tools.map((t) => ({ id: t.id, label: t.label, key: t.key || "", icon: t.icon || "", cursor: t.cursor || "" })) : [];
  const actions = m && m.actions ? Object.entries(m.actions).map(([id, a]) => ({ id, label: (a && a.label) || id, key: (a && a.key) || null, menu: (a && a.menu) || null })) : [];
  store.slice("tool", { moduleTools: tools, moduleActions: actions });
}

/** Run a module action; false means the module declined it (its run() returned false), anything else counts as handled. */
export function runModuleAction(id: string) {
  const m = activeModule(); const a = m && m.actions && m.actions[id];
  if (!a || typeof a.run !== "function") return false;
  // Whoever watches what the person does (the guided first project) hears that the action ran.
  try { const ok = a.run(toolCtx()) !== false; window.dispatchEvent(new CustomEvent("kc:action", { detail: { id } })); return ok; } catch (e) { console.warn(e); toast("Action failed: " + (e as Error).message, 3000); return true; }
}

// Hotkeys in the spec's notation ("Ctrl+Shift+G", "Del", "Space"); Cmd counts as Ctrl on a Mac.
export const KEY_NAMES: Record<string, string> = { Del: "Delete", Esc: "Escape", Space: " ", Ins: "Insert", PgUp: "PageUp", PgDn: "PageDown", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

export function hotkeyMatches(ev: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, key: string | null | undefined) {
  if (!key) return false;
  const parts = String(key).split("+"); const k = parts.pop()!;
  if (parts.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey) || parts.includes("Shift") !== ev.shiftKey || parts.includes("Alt") !== ev.altKey) return false;
  const want = KEY_NAMES[k] || k;
  return want.length === 1 ? ev.key.toUpperCase() === want.toUpperCase() : ev.key === want;
}

export function runModuleHotkey(ev: KeyboardEvent) {
  const m = activeModule(); if (!m || !m.actions) return false;
  for (const [id, a] of Object.entries(m.actions)) if (a && a.key && hotkeyMatches(ev, a.key)) { if (runModuleAction(id)) return true; }
  return false;
}

export function moduleTool(id: string) { const m = activeModule(); return m && m.tools ? m.tools.find((t) => t.id === id) : null; }


// ---- tools ----
export function setTool(t: string) {
  if (t === "follow") { cycleFollow(); return; }
  // a viewer may highlight, measure and pan; a drawing or editing tool does not start (KiCad greys it, and so do our bars)
  if (E.viewOnly && moduleTool(t) && t !== "highlight") { toast("View-only access"); if (E.tool !== "select" && moduleTool(E.tool) && E.tool !== "highlight") setTool("select"); return; }
  // KiCad refuses to activate another tool while a wire, a placement or a move is in flight (the module says
  // "Press <ESC> to cancel …" in the infobar and keeps going)
  const vm = activeModule() as unknown as { vetoTool?: (id: string, c: unknown) => boolean } | null;
  if (vm && vm.vetoTool && t !== "pan" && t !== "zoomtool") { try { if (vm.vetoTool(t, toolCtx())) return; } catch (e) { console.warn(e); } }
  const prev = E.tool; if (t !== prev) toolChanging(t);   // a drag in flight is put back; a drawing tool starts with nothing selected
  E.tool = t;
  store.slice("tool", { current: t });
  const mt = moduleTool(t);
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : t === "zoomtool" ? "zoomtool" : t === "measure" ? "measure" : "";
  if (t !== "measure" && E.measure) { E.measure = null; requestRepaint(); }
  stage.style.cursor = mt && mt.cursor ? toolCursor(mt.cursor) : "";
  if (t === "comment" && !E.canComment) { toast(state.me ? "You have view-only access: ask the owner to let you comment" : "Sign in to comment"); setTool("select"); return; }
  const m = activeModule(); if (m && m.onActivate && (mt || moduleTool(prev))) { try { m.onActivate(t, toolCtx()); } catch (e) { console.warn(e); } }
  requestRender();
}


export function rotateSelected(delta?: unknown) {
  const d = typeof delta === "number" ? delta : 90;
  const before = E.selected.rot || 0, after = (((before + d) % 360) + 360) % 360;
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
  E.selected.rot = after;
  if (E.kdoc) applyChanges([{ id: E.selected.id, kind: "MODIFIED", properties: [{ name: "Orientation", after: { v: after } }] }]);
  drawSelection(); renderProps();
}

/** The ids a board edit may touch: locked items sit out unless "Override locks" is on (a schematic has no locks). */
export function unlockedForEdit(ids: string[], quiet = false) {
  const m = !isSch() && CollabTools.pcb;
  if (!m || !m.unlockedIds || !E.kdoc) return ids;
  try { return m.unlockedIds(toolCtx(), ids, quiet); } catch (e) { console.warn(e); return ids; }
}

export function deleteSelected() {
  if (!E.selected) return;
  // through commitChanges, so the delete has an inverse: Undo brings the item back (it used to be gone for good)
  const doomed = E.kdoc && E.kdoc.items.get(E.selected.id);
  if (doomed) {
    if (!unlockedForEdit([doomed.id]).length) return;
    const m = activeModule(); let changes: KChange[] | null = null;
    if (m && m.deleteChanges) { try { changes = m.deleteChanges(E.kdoc, [doomed]); } catch (e) { console.warn(e); } }
    if (!changes) changes = [KiCadCanvas.removeChange(doomed)];
    clearSelection(); commitChanges(changes, "delete"); drawSelection(); renderProps(); renderObjects(); requestRender();   // EDIT_TOOL::Remove says nothing
    return;
  }
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "REMOVED", properties: [] }]);
  if (E.kdoc) E.kdoc.items.delete(E.selected.id);
  E.items = E.items.filter((f: ItemSummary) => f.id !== E.selected.id);
  E.selected = null; drawSelection(); renderProps(); renderObjects(); requestRender();
}

export function moveOp(fp: { id: string; x: number; y: number }, nx: number, ny: number): KChange {
  return { id: fp.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Position X", before: { type: "int", v: fp.x }, after: { type: "int", v: nx } },
    { name: "Position Y", before: { type: "int", v: fp.y }, after: { type: "int", v: ny } }] };
}

export function schKey(k: string) { const m = CollabTools.sch; if (!m || !isSch()) return false; try { return !!m.onKey!(k, {}, toolCtx()); } catch (e) { console.warn(e); return false; } }

export function orientSelected(kind: "ccw" | "cw" | "mv" | "mh") {
  if (isSch()) { if (!schKey({ ccw: "r", cw: "R", mv: "y", mh: "x" }[kind])) toast("Select a symbol or item first"); return; }
  // board: EDIT_TOOL::Rotate / Mirror in the module (the selection or the item under the cursor; footprints are never
  // mirrored, KiCad's infobar says to use Flip)
  if (CollabTools.pcb) { runModuleAction({ ccw: "rotateSelection", cw: "rotateSelectionCw", mh: "mirrorH", mv: "mirrorV" }[kind]); return; }
  if (!E.selected) return;
  if (kind === "ccw") rotateSelected(-90); else if (kind === "cw") rotateSelected(90);
}

export function deleteAction() {
  if (schKey("Delete")) return;
  // board: EDIT_TOOL::Remove — the module's selection, or with nothing selected the item under the cursor (silent)
  const m = !isSch() && activeModule();
  if (m && m.onKey && !E.viewOnly) { try { if (m.onKey("Delete", { shiftKey: false, preventDefault() {} }, toolCtx())) return; } catch (e) { console.warn(e); } }
  if (E.selection.size > 1 && !E.viewOnly) { deleteSelection(); return; }
  if (E.selected && !E.viewOnly) deleteSelected();
}

export function selectAll() {
  if (!E.kdoc) return; E.selection.clear();
  for (const it of E.kdoc.items.values()) if (it.bbox && filterAllows(it.kind, it)) E.selection.add(it.id);
  E.selected = E.items.find((f: ItemSummary) => E.selection.has(f.id)) || null;
  drawSelection(); renderProps(); renderObjects(); setStatusBar({ message: `${E.selection.size} items selected` });
}

export function deleteSelection() {
  if (!E.kdoc || !E.selection.size) return;
  E.selection = groupExpand(E.selection);
  const its: KItem[] = unlockedForEdit([...E.selection]).map((id) => E.kdoc.items.get(id)).filter(Boolean);
  if (!its.length) return;
  const m = activeModule(); let changes: KChange[] | null = null;
  if (m && m.deleteChanges) { try { changes = m.deleteChanges(E.kdoc, its); } catch (e) { console.warn(e); } }
  if (!changes) changes = its.map((it) => KiCadCanvas.removeChange(it));
  clearSelection(); commitChanges(changes, "delete"); drawSelection(); renderProps(); renderObjects();
}
