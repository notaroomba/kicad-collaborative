// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setStatusBar, state, store } from "./appstore";
import { applyChanges, enterSheet, publishDocs, renderObjects, snapMm } from "./doc";
import { sendOp } from "./net";
import { cycleFollow } from "./peers";
import { clearSelection, drawSelection, filterAllows, groupExpand, renderProps, selFilter } from "./selection";
import { E } from "./state";
import { api, toast } from "./util";
import { dragG, isSch, pxPerMm, requestRender, stage, worldMm } from "./view";
   // ERC/DRC markers handed over by the tool modules; the project's .kicad_pro text (design rules)
// KiCad's clipboard is s-expression text: the modules write it here and to the system clipboard when allowed.
export const appClipboard = { text: "", get() { return appClipboard.text; }, set(t) { appClipboard.text = String(t || ""); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(appClipboard.text).catch(() => {}); },
  async read() { try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t && /^\s*\((kicad_sch|kicad_pcb|lib_symbols|symbol|wire|footprint|segment|via|zone|gr_|label|junction)/.test(t)) return t; } } catch (e) { /* permission denied: use the buffer */ } return appClipboard.text; } };

export const undoStack = [], redoStack = [];

export function activeModule() { if (!E.kdoc) return null; return isSch() ? CollabTools.sch : CollabTools.pcb; }

export function toolCtx(extra) {
  return Object.assign({
    K: KiCadCanvas, doc: E.kdoc, IU: E.IU, isSch: isSch(), zoom: E.zoom, pxPerMm: pxPerMm(), gridPitch: E.gridPitch, snapOn: E.snapOn, snap: snapMm, tool: E.tool, selFilter: selFilter(), activeLayer: E.activeLayer,
    selected: E.selected, items: E.items, sheets: E.sheets, viewOnly: E.viewOnly, live: !!(E.ws && E.ws.readyState === 1), stage, worldMm, selection: E.selection, docs: state.docs, project: state.project, api, docId: state.docId,
    setHighlight(ids) { E.highlightIds = ids && ids.size ? new Set(ids) : null; requestRender(); },
    cursor: E.lastCursorMm, clipboard: appClipboard, designSettings: E.proSettings,
    setSelection(ids) { E.selection = new Set([...(ids || [])].filter((id) => E.kdoc && E.kdoc.items.has(id))); E.selected = null; E.selField = null; for (const id of E.selection) { const f = E.items.find((x) => x.id === id); if (f) { E.selected = f; break; } } store.slice("selection", { ids: [...E.selection], primary: E.selected ? E.selected.id : null, version: (state.selection ? state.selection.version || 0 : 0) + 1 }); drawSelection(); renderProps(); renderObjects(); requestRender(); },
    setMarkers(list) { E.markers = Array.isArray(list) ? list : []; E.renderOpts.markers = E.markers.length ? E.markers : undefined; store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); if (E.markers.length) toast(`${E.markers.length} marker${E.markers.length === 1 ? "" : "s"}`); },
    setSelected(fp) { E.selected = fp ? (E.items.find((f) => f.id === fp.id) || fp) : null; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    commit(changes, label) { commitChanges(changes, label); },
    applyLocal(changes) { applyChanges(changes); },
    requestRender, toast, enterSheet, setTool,
    setStatus(text) { setStatusBar({ mode: text || "" }); },
  }, extra || {});
}

// Local apply + broadcast, with an inverse recorded for undo.
export function commitChanges(changes, label) {
  if (!changes || !changes.length) return;
  const inverse = [];
  for (const c of changes) {
    const it = E.kdoc && E.kdoc.items.get(c.id);
    if (c.kind === "ADDED") inverse.push({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] });
    else if (c.kind === "REMOVED" && it) inverse.push({ id: c.id, kind: "ADDED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
    else if (c.kind === "MODIFIED" && it) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
  }
  applyChanges(changes);
  sendOp(changes);   // journalled and replayed on reconnect even when the socket is down
  undoStack.push({ label: label || "edit", changes, inverse }); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; publishUndo();
  if (isSch() && label === "sheet") publishDocs();   // a new sheet file joined the project
}

export function publishUndo() { store.set({ undo: { undo: undoStack.length, redo: redoStack.length } }); }

export function undoLast() {
  const e = undoStack.pop(); if (!e) { toast("Nothing to undo"); return; }
  const redo = e.changes.map((c) => { const it = E.kdoc.items.get(c.id); return c.kind === "REMOVED" ? c : (it ? { id: c.id, kind: c.kind === "ADDED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) } : c); });
  applyChanges(e.inverse); sendOp(e.inverse);
  redoStack.push({ label: e.label, changes: redo, inverse: e.inverse }); publishUndo(); toast("Undo " + e.label);
}

export function redoLast() {
  const e = redoStack.pop(); if (!e) { toast("Nothing to redo"); return; }
  applyChanges(e.changes); sendOp(e.changes);
  undoStack.push(e); publishUndo(); toast("Redo " + e.label);
}

/** The active module's tools and menu actions ({id: {label, key, run(ctx)}}), for the toolbar and the menus. */
export function renderModuleTools() {
  const m = activeModule();
  const tools = m && m.tools ? m.tools.map((t) => ({ id: t.id, label: t.label, key: t.key || "", icon: t.icon || "", cursor: t.cursor || "" })) : [];
  const actions = m && m.actions ? Object.entries(m.actions).map(([id, a]) => ({ id, label: (a && a.label) || id, key: (a && a.key) || null, menu: (a && a.menu) || null })) : [];
  store.slice("tool", { moduleTools: tools, moduleActions: actions });
}

/** Run a module action; false means the module declined it (its run() returned false), anything else counts as handled. */
export function runModuleAction(id) {
  const m = activeModule(); const a = m && m.actions && m.actions[id];
  if (!a || typeof a.run !== "function") return false;
  try { return a.run(toolCtx()) !== false; } catch (e) { console.warn(e); toast("Action failed: " + e.message, 3000); return true; }
}

// Hotkeys in the spec's notation ("Ctrl+Shift+G", "Del", "Space"); Cmd counts as Ctrl on a Mac.
export const KEY_NAMES = { Del: "Delete", Esc: "Escape", Space: " ", Ins: "Insert", PgUp: "PageUp", PgDn: "PageDown", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

export function hotkeyMatches(ev, key) {
  if (!key) return false;
  const parts = String(key).split("+"); const k = parts.pop();
  if (parts.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey) || parts.includes("Shift") !== ev.shiftKey || parts.includes("Alt") !== ev.altKey) return false;
  const want = KEY_NAMES[k] || k;
  return want.length === 1 ? ev.key.toUpperCase() === want.toUpperCase() : ev.key === want;
}

export function runModuleHotkey(ev) {
  const m = activeModule(); if (!m || !m.actions) return false;
  for (const [id, a] of Object.entries(m.actions)) if (a && a.key && hotkeyMatches(ev, a.key)) { if (runModuleAction(id)) return true; }
  return false;
}

export function moduleTool(id) { const m = activeModule(); return m && m.tools ? m.tools.find((t) => t.id === id) : null; }


// ---- tools ----
export function setTool(t) {
  if (t === "follow") { cycleFollow(); return; }
  const prev = E.tool; E.tool = t;
  store.slice("tool", { current: t });
  const mt = moduleTool(t);
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : t === "zoomtool" ? "zoomtool" : t === "measure" ? "measure" : "";
  if (t !== "measure" && E.measure) { E.measure = null; dragG.replaceChildren(); setStatusBar({ message: "" }); }
  if (mt && mt.cursor) stage.style.cursor = mt.cursor; else stage.style.cursor = "";
  if (t === "comment" && !E.canJoin) { toast("Sign in to comment"); setTool("select"); return; }
  const m = activeModule(); if (m && m.onActivate && (mt || moduleTool(prev))) { try { m.onActivate(t, toolCtx()); } catch (e) { console.warn(e); } }
  requestRender();
}


export function rotateSelected(delta) {
  const d = typeof delta === "number" ? delta : 90;
  const before = E.selected.rot || 0, after = (((before + d) % 360) + 360) % 360;
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
  E.selected.rot = after;
  if (E.kdoc) applyChanges([{ id: E.selected.id, kind: "MODIFIED", properties: [{ name: "Orientation", after: { v: after } }] }]);
  drawSelection(); renderProps();
}

export function deleteSelected() {
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "REMOVED", properties: [] }]);
  if (E.kdoc) E.kdoc.items.delete(E.selected.id);
  E.items = E.items.filter((f) => f.id !== E.selected.id);
  E.selected = null; drawSelection(); renderProps(); renderObjects(); requestRender(); toast("Deleted");
}

export function moveOp(fp, nx, ny) {
  return { id: fp.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Position X", before: { type: "int", v: fp.x }, after: { type: "int", v: nx } },
    { name: "Position Y", before: { type: "int", v: fp.y }, after: { type: "int", v: ny } }] };
}

export function schKey(k) { const m = CollabTools.sch; if (!m || !isSch()) return false; try { return !!m.onKey(k, {}, toolCtx()); } catch (e) { console.warn(e); return false; } }

export function orientSelected(kind) {
  if (isSch()) { if (!schKey({ ccw: "r", cw: "R", mv: "y", mh: "x" }[kind])) toast("Select a symbol or item first"); return; }
  if (!E.selected) { toast("Select a footprint first"); return; }
  if (kind === "ccw") rotateSelected(-90); else if (kind === "cw") rotateSelected(90);
  else { const h = CollabTools.props && CollabTools.props.helpers; if (h && h.setFootprintSide) { const it = E.kdoc.items.get(E.selected.id); const side = (it && it.layer === "B.Cu") ? "F.Cu" : "B.Cu"; try { h.setFootprintSide(toolCtx(), it, side); } catch (e) { toast("Flip failed: " + e.message); } } else toast("Flip runs in the desktop app"); }
}

export function deleteAction() { if (schKey("Delete")) return; if (E.selected && !E.viewOnly) deleteSelected(); else toast("Nothing selected"); }

export function selectAll() {
  if (!E.kdoc) return; E.selection.clear();
  for (const it of E.kdoc.items.values()) if (it.bbox && filterAllows(it.kind)) E.selection.add(it.id);
  E.selected = E.items.find((f) => E.selection.has(f.id)) || null;
  drawSelection(); renderProps(); renderObjects(); setStatusBar({ message: `${E.selection.size} items selected` });
}

export function deleteSelection() {
  if (!E.kdoc || !E.selection.size) return;
  E.selection = groupExpand(E.selection);
  const its = [...E.selection].map((id) => E.kdoc.items.get(id)).filter(Boolean);
  const m = activeModule(); let changes = null;
  if (m && m.deleteChanges) { try { changes = m.deleteChanges(E.kdoc, its); } catch (e) { console.warn(e); } }
  if (!changes) changes = its.map((it) => KiCadCanvas.removeChange(it));
  clearSelection(); commitChanges(changes, "delete"); drawSelection(); renderProps(); renderObjects();
  toast(`Deleted ${its.length} item${its.length === 1 ? "" : "s"}`);
}
