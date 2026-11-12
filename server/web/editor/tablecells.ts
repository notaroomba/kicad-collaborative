// tablecells.ts — interactive table editing on the board and the schematic: table cells as selectable items and the
// table edit tool (PCB_EDIT_TABLE_TOOL / SCH_EDIT_TABLE_TOOL, include/tool/edit_table_tool_base.h).
//
// A table is one document item; a cell selection is { table id, cell indexes, anchor } kept here, beside the
// editors' item selections (clearSelection clears it too).  KiCad's selection tools collect PCB_TABLECELL_T /
// SCH_TABLECELL_T, so:
//   - a click inside a table selects the cell under the cursor (a covered cell, span 0, is never picked); the whole
//     table is selected by a box or lasso that holds it, or by Select Table;
//   - Shift+click with a cell selection of the same table selects the block between the anchor cell's centre and
//     the clicked cell's (extendTableCellSelectionTo); Ctrl+click toggles one cell and drops the anchor;
//   - a left drag that starts on a cell selects the cells the box from the press to the cursor touches
//     (selectTableCells): Shift adds (from the anchor), Ctrl+Shift removes, Ctrl toggles against the cells
//     selected before the drag; Esc puts the selection back.  A table already selected as a whole moves instead.
// The edits (Add Row Above … Unmerge Cells, Paste Cells, Delete on cells, Resize Table Cells and the cell dialog)
// build the new table node with canvas/table-model.ts and commit one replace (or a removal) with KiCad's label, so
// a peer receives the same single change and undo puts the original node back.  Move / Rotate / Flip / Mirror /
// Drag on a cell selection act on the parent table (SCH_COLLECTOR's "promoted to parent table").
import { appClipboard, runModuleAction, toolCtx } from "./tools";
import { tableMenu } from "./contextmenu";
import { overlayHooks } from "./overlays";
import { propertiesHooks } from "./pointer";
import { clearHooks } from "./selection";
import { clearAllSelection, interactionBusy, pcbState, schState, selectionChanged, selectionIds, stage, worldMm } from "./gestures";
import { keyHooks } from "./hotkeys";
import { E } from "./state";
import { cellPropsDialog, errorMessage, newSchTableDialog, tablePropsDialog } from "./tabledialogs";
import { selFilter } from "./selection";
import { download } from "./pcbdialogs/ui";
import { applyView, isSch, pxPerMm, requestRender } from "./view";
import { toast } from "./util";
import { breakFollow } from "./peers";
import { msgHooks, type MsgItem } from "./msgpanel";

type Pt = number[];
/** `node` is the table node the indexes were taken on: when the document's node is another (an edit, ours or a peer's), the indexes follow the cells by uuid. */
export interface CellSel { tableId: string; cells: Set<number>; anchor: number | null; node: SNode }

let sel: CellSel | null = null;
const M = () => KiCadCanvas.tableModel;
const isPcb = (): boolean => !isSch();

/**
 * The cell selection, followed onto the document's current table node (a peer may have added or removed rows or
 * columns, or the table or some of its cells) and pruned.
 */
export function cellSelection(): { item: KItem; cells: number[]; anchor: number | null } | null {
  if (!sel || !E.kdoc) return null;
  const item = (E.kdoc as KDoc).items.get(sel.tableId);
  if (!item || item.kind !== "table") { sel = null; return null; }
  if (sel.node !== item.node) {
    const a = sel.anchor !== null ? M().remapCells(sel.node, item.node, [sel.anchor]) : [];
    sel = { tableId: sel.tableId, cells: new Set(M().remapCells(sel.node, item.node, sel.cells)), anchor: a.length ? a[0] : null, node: item.node };
  }
  const n = M().tableInfo(item.node).cells;
  const cells = Array.from(sel.cells).filter((i) => i >= 0 && i < n.length && M().selectableCell(n[i])).sort((a, b) => a - b);
  if (!cells.length) { sel = null; return null; }
  return { item, cells, anchor: sel.anchor !== null && sel.anchor < n.length ? sel.anchor : null };
}
export function hasCellSelection(): boolean { return !!cellSelection(); }
/** Drop the cell selection (selection.ts clearSelection calls this). */
export function clearCells(): void { if (sel) { sel = null; requestRender(); } }
/** Select cells by their indexes in `node` (the table node they were read from). */
function setCells(tableId: string, cells: Iterable<number>, anchor: number | null, node: SNode): void {
  const s = new Set(cells); sel = s.size ? { tableId, cells: s, anchor, node } : null;
  publish();
}
function publish(): void { selectionChanged(); requestRender(); }
/** A generated table (a drill table…): its structure and text are the board's (canEditTableStructure). */
const structureEditable = (item: KItem): boolean => item.kind === "table" && item.node[0] === "table";

// ---------------------------------------------------------------- hit testing
/** The table and selectable cell under a point (the topmost table whose cell holds it), honouring the Selection Filter. */
export function cellUnder(mm: Pt): { item: KItem; cell: number } | null {
  const d = E.kdoc as KDoc | null; if (!d) return null;
  if (selFilter().text === false) return null;   // includePcbTexts / m_filter.text gate table cells
  let best: { item: KItem; cell: number } | null = null;
  const slop = 2 / Math.max(1, pxPerMm());
  for (const it of d.items.values()) {
    if (it.kind !== "table" || !it.bbox) continue;
    const b = it.bbox; if (mm[0] < b[0] - slop || mm[0] > b[2] + slop || mm[1] < b[1] - slop || mm[1] > b[3] + slop) continue;
    if (isPcb() && !KiCadCanvas.itemVisible(it, E.hiddenLayers)) continue;
    const c = M().cellAt(it.node, isPcb(), mm[0], mm[1]); if (c >= 0) best = { item: it, cell: c };
  }
  return best;
}

// ---------------------------------------------------------------- whole-table selection (Select Table, promotion)
/** Replace the selection with the given tables as items, in whichever store a click would put them. */
export function selectTables(ids: string[]): void {
  sel = null; clearAllSelection(false);
  if (isSch()) {
    E.selection = new Set(ids);
    const fp = (E.items as { id: string }[]).find((f) => f.id === ids[0]); if (fp) E.selected = fp;
  } else { const p = pcbState(); if (p) p.sel = new Set(ids); }
  publish();
}
/** SCH_COLLECTOR / PCB_SELECTION_TOOL promotion: a cell selection stands for its table. */
export function promoteToTable(): boolean { const c = cellSelection(); if (!c) return false; selectTables([c.item.id]); return true; }

// ---------------------------------------------------------------- pointer
interface Press { item: KItem; cell: number; origin: Pt; client: Pt; shift: boolean; ctrl: boolean; snapshot: Set<number>; anchor: number | null; dragging: boolean; pointerId: number }
let press: Press | null = null;

function onDown(ev: PointerEvent): void {
  if (ev.button !== 0 || ev.altKey || !E.kdoc || E.tool !== "select" || (window.KDialogs && window.KDialogs.isOpen())) return;
  if (!(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  if (interactionBusy()) return;
  if (isSch()) { const s = schState() as unknown as { carry?: unknown; drag?: unknown } | null; if (s && (s.carry || s.drag)) return; }
  else { const p = pcbState() as unknown as { move?: unknown; carry?: unknown } | null; if (p && (p.move || p.carry)) return; }
  const mm = worldMm(ev); const hit = cellUnder(mm); if (!hit) return;
  // a pad on top of the table is the pad's (PCB_SELECTION_TOOL prefers it)
  if (isPcb()) { try { if (KiCadCanvas.padAt && KiCadCanvas.padAt(E.kdoc as KDoc, mm[0], mm[1])) return; } catch { /* no pad */ } }
  const ids = selectionIds();
  if (ids.includes(hit.item.id)) return;   // the table itself is selected: the press moves it
  const cur = cellSelection(); const same = !!cur && cur.item.id === hit.item.id;
  const ctrl = ev.ctrlKey || ev.metaKey, shift = ev.shiftKey;
  // a modifier click that extends a selection holding other items stays with the item selection
  if ((ctrl || shift) && !same && (ids.length || cur)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  press = { item: hit.item, cell: hit.cell, origin: mm, client: [ev.clientX, ev.clientY], shift, ctrl, snapshot: new Set(same && cur ? cur.cells : []),
    anchor: same && cur ? (cur.anchor !== null ? cur.anchor : cur.cells[0]) : null, dragging: false, pointerId: ev.pointerId };
  try { stage.setPointerCapture(ev.pointerId); } catch { /* synthetic event */ }
  window.addEventListener("pointermove", onMove, true); window.addEventListener("pointerup", onUp, true);
}

function dragRange(p: Press, mm: Pt): Set<number> {
  const node = p.item.node, cells = M().tableInfo(node).cells;
  const start: Pt = p.shift && p.anchor !== null && cells[p.anchor] ? M().cellCentre(cells[p.anchor], isPcb()) : p.origin;
  const range = M().cellsInRect(node, isPcb(), start, mm);
  const out = new Set<number>(p.snapshot);
  if (p.ctrl && p.shift) for (const i of range) out.delete(i);                 // subtractive
  else if (p.ctrl) for (const i of range) { if (p.snapshot.has(i)) out.delete(i); else out.add(i); }   // exclusive or
  else if (p.shift) for (const i of range) out.add(i);                         // additive
  else return new Set(range);
  return out;
}

function onMove(ev: PointerEvent): void {
  const p = press; if (!p) return;
  ev.stopImmediatePropagation();
  if (!p.dragging && Math.hypot(ev.clientX - p.client[0], ev.clientY - p.client[1]) < 4) return;
  if (!p.dragging) { p.dragging = true; if (!p.shift && !p.ctrl) clearAllSelection(false); }
  lastClient = [ev.clientX, ev.clientY];
  dragTo(p, worldMm(ev));
  autoPan();
}

// ---------------------------------------------------------------- auto-pan (selectTableCells runs with SetAutoPan( true ))
let lastClient: Pt = [0, 0], panRaf = 0, panT = 0;
/** WX_VIEW_CONTROLS::onTimer while AUTO_PANNING: the cursor in the border pans the view, and the range follows the cursor. */
function autoPan(): void {
  if (panRaf) return;
  const tick = (t: number) => {
    panRaf = 0; const p = press; if (!p || !p.dragging) return;
    const r = stage.getBoundingClientRect();
    const [dx, dy] = KiCadCanvas.autoPanStep(lastClient[0] - r.left, lastClient[1] - r.top, r.width, r.height);
    if (!dx && !dy) { panT = 0; return; }
    const ticks = panT ? Math.min(12, Math.max(0, t - panT) / KiCadCanvas.AUTOPAN_TICK_MS) : 1; panT = t;
    E.viewTouched = true; E.panX -= dx * ticks; E.panY -= dy * ticks; breakFollow(); applyView();
    dragTo(p, worldMm({ clientX: lastClient[0], clientY: lastClient[1] }));
    panRaf = requestAnimationFrame(tick);
  };
  panRaf = requestAnimationFrame(tick);
}
function stopAutoPan(): void { if (panRaf) cancelAnimationFrame(panRaf); panRaf = 0; panT = 0; }

function dragTo(p: Press, mm: Pt): void {
  const cells = dragRange(p, mm);
  sel = cells.size ? { tableId: p.item.id, cells, anchor: p.shift ? p.anchor : (sel ? sel.anchor : null), node: p.item.node } : null;
  if (sel && !p.shift && sel.anchor === null) sel.anchor = M().cellAt(p.item.node, isPcb(), p.origin[0], p.origin[1]);
  requestRender();
}

function endPress(): void { stopAutoPan(); window.removeEventListener("pointermove", onMove, true); window.removeEventListener("pointerup", onUp, true); press = null; }

function onUp(ev: PointerEvent): void {
  const p = press; if (!p) return;
  ev.stopImmediatePropagation(); endPress();
  try { stage.releasePointerCapture(p.pointerId); } catch { /* not captured */ }
  if (p.dragging) { publish(); return; }
  const node = p.item.node;
  if (p.ctrl && !p.shift) {                     // toggleTableCellSelection
    const s = new Set(p.snapshot); if (s.has(p.cell)) s.delete(p.cell); else s.add(p.cell);
    if (!p.snapshot.size) clearAllSelection(false);
    setCells(p.item.id, s, null, node); return;
  }
  if (p.shift && p.anchor !== null && p.snapshot.size) {   // extendTableCellSelectionTo
    const cells = M().tableInfo(node).cells;
    const a = M().cellCentre(cells[p.anchor], isPcb()), b = M().cellCentre(cells[p.cell], isPcb());
    setCells(p.item.id, M().cellsInRect(node, isPcb(), a, b), p.anchor, node); return;
  }
  clearAllSelection(false); setCells(p.item.id, [p.cell], p.cell, node);
}

function cancelPress(): boolean {
  const p = press; if (!p) return false;
  endPress();
  // the button is still down: its release belongs to the cancelled drag, not to the select tool underneath
  const swallow = (ev: PointerEvent) => { if (ev.pointerId !== p.pointerId) return; ev.stopImmediatePropagation(); window.removeEventListener("pointerup", swallow, true); };
  window.addEventListener("pointerup", swallow, true);
  if (p.dragging) { sel = p.snapshot.size ? { tableId: p.item.id, cells: new Set(p.snapshot), anchor: p.anchor, node: p.item.node } : null; publish(); }
  return true;
}

// ---------------------------------------------------------------- the canvas wash
/** PCB_PAINTER: each selected cell filled with its layer colour at 0.5 alpha; SCH_PAINTER: the cell's selection shadow. */
export function drawCellSelection(ctx: CanvasRenderingContext2D): void {
  const c = cellSelection(); if (!c) return;
  const list = M().tableInfo(c.item.node).cells, pcb = isPcb();
  ctx.save();
  if (pcb) {
    const layer = String((KiCadCanvas.kid(c.item.node, "layer") || [])[1] || "Dwgs.User");
    ctx.fillStyle = KiCadCanvas.PCB_COLORS[layer] || "#c2c2c2"; ctx.globalAlpha = 0.5;
  } else { ctx.fillStyle = "#66B2FF"; ctx.globalAlpha = 0.55; }
  for (const i of c.cells) {
    const q = M().cellCorners(list[i], pcb);
    ctx.beginPath(); q.forEach((pt, k) => (k ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]))); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- the edit tool
const editing = (): boolean => { if (E.viewOnly) { toast("View-only access"); return false; } return true; };
function commitTable(item: KItem, node: SNode | "remove", label: string): void {
  const ctx = toolCtx(); const doc = ctx.doc as KDoc;
  if (node === "remove") { sel = null; ctx.commit([KiCadCanvas.removeChange(item)], label); publish(); return; }
  ctx.commit([KiCadCanvas.replaceChange(doc, { ...item, node, geom: [], bbox: null } as KItem)], label);
}
/** The cells of the selection mapped onto a new node through their uuids (inserted rows / columns shift indexes). */
function reselect(item: KItem, before: SNode, after: SNode, cells: number[]): void {
  const old = M().tableInfo(before).cells, now = M().tableInfo(after).cells;
  const pos = new Map(now.map((c, i) => [KiCadCanvas.uuidOf(c), i]));
  const out = cells.map((i) => pos.get(KiCadCanvas.uuidOf(old[i]))).filter((i): i is number => i !== undefined);
  const a = sel && sel.anchor !== null && old[sel.anchor] ? pos.get(KiCadCanvas.uuidOf(old[sel.anchor])) : undefined;
  sel = out.length ? { tableId: item.id, cells: new Set(out), anchor: a === undefined ? null : a, node: after } : null;
}

type Edit = "addRowAbove" | "addRowBelow" | "addColBefore" | "addColAfter" | "deleteRows" | "deleteColumns" | "mergeCells" | "unmergeCells";
/** EDIT_TABLE_TOOL_BASE::do*: the structure edits. */
export function runEdit(what: Edit): boolean {
  const c = cellSelection(); if (!c) return false;
  if (!editing()) return true;
  if (!structureEditable(c.item)) return true;   // selectionAllowsStructureEdits
  const node0 = c.item.node, T = M().tableInfo(node0), pcb = isPcb(), uuid = () => KiCadCanvas.newUuid();
  const rows = c.cells.map((i) => Math.floor(i / T.cols)), cols = c.cells.map((i) => i % T.cols);
  let out: SNode | "remove"; let label: string;
  switch (what) {
  case "addRowAbove": out = M().addRow(node0, pcb, Math.min(...rows), false, uuid); label = "Add Row Above"; break;
  case "addRowBelow": out = M().addRow(node0, pcb, Math.max(...rows), true, uuid); label = "Add Row Below"; break;
  case "addColBefore": out = M().addCol(node0, pcb, Math.min(...cols), false, uuid); label = "Add Column Before"; break;
  case "addColAfter": out = M().addCol(node0, pcb, Math.max(...cols), true, uuid); label = "Add Column After"; break;
  case "deleteRows": { const r = M().rowsOf(node0, c.cells); out = M().deleteRows(node0, pcb, r); label = r.length > 1 ? "Delete Rows" : "Delete Row"; break; }
  case "deleteColumns": { const k = M().colsOf(node0, c.cells); out = M().deleteCols(node0, pcb, k); label = k.length > 1 ? "Delete Columns" : "Delete Column"; break; }
  case "mergeCells": if (!M().isCellBlock(node0, c.cells)) return true; out = M().mergeCells(node0, pcb, c.cells); label = "Merge Cells"; break;
  case "unmergeCells": if (!M().hasMergedCell(node0, c.cells)) return true; out = M().unmergeCells(node0, pcb, c.cells); label = "Unmerge Cells"; break;
  }
  if (out === "remove" || what === "deleteRows" || what === "deleteColumns") { sel = null; commitTable(c.item, out, label); publish(); return true; }   // clearSelection()
  if (what === "mergeCells") { const b = M().cellBlockBounds(node0, c.cells); sel = { tableId: c.item.id, cells: new Set([b.rowMin * T.cols + b.colMin]), anchor: null, node: out }; }
  else reselect(c.item, node0, out, c.cells);
  commitTable(c.item, out, label); publish();
  return true;
}

/** Select Row(s) / Select Column(s) / Select Table (PCB_SELECTION_TOOL / SCH_SELECTION_TOOL). */
export function selectRowsCols(which: "rows" | "cols" | "table"): boolean {
  const c = cellSelection(); if (!c) return false;
  if (which === "table") { selectTables([c.item.id]); return true; }
  const all = which === "rows" ? M().expandToRows(c.item.node, c.cells) : M().expandToCols(c.item.node, c.cells);
  sel = { tableId: c.item.id, cells: new Set(all), anchor: c.anchor, node: c.item.node }; publish(); return true;
}

/** EDIT_TOOL::Properties / SCH_EDIT_TOOL::Properties on a cell selection: Table Cell Properties, then maybe the table's. */
export function cellProperties(): boolean {
  const c = cellSelection(); if (!c) return false;
  const ctx = toolCtx(), pcb = isPcb(), id = c.item.id;
  cellPropsDialog(ctx, c.item, c.cells, pcb, {
    generated: !structureEditable(c.item),
    editTable: () => { const it = (E.kdoc as KDoc | null)?.items.get(id); if (it) tablePropsDialog(toolCtx(), it, pcb); },
  });
  return true;
}
/** ACTIONS::editTable (Ctrl+E): the parent table's dialog. */
export function editTable(): boolean { const c = cellSelection(); if (!c) return false; tablePropsDialog(toolCtx(), c.item, isPcb()); return true; }

/** ACTIONS::exportTableCSV: the cells' shown text, saved as a file. */
export function exportCsv(): boolean {
  const c = cellSelection(); if (!c) return false;
  const shown = (t: string, r: number, col: number) => shownCellText(c.item, t, r, col);
  download("table.csv", M().tableCsv(c.item.node, shown), "text/csv;charset=utf-8");
  return true;
}
/** GetShownText of a cell (canvas/tables-images.ts tableCellShownText, the text the canvas draws): ${ROW} ${COL} ${ADDR} ${LAYER}, ${CELL(…)} and the document's own variables. */
export function shownCellText(item: KItem, _text: string, row: number, col: number): string {
  const cols = M().tableInfo(item.node).cols;
  return KiCadCanvas.tableCellShownText(E.kdoc as never, item.node, row * cols + col, isPcb());
}

/** DoDelete on cells: their text is cleared (a generated table's cells have none of the user's). */
function deleteCellText(): boolean {
  const c = cellSelection(); if (!c) return false;
  if (!editing() || !structureEditable(c.item)) return true;
  const node = M().clearCellText(c.item.node, c.cells);
  if (KiCadCanvas.serialize(node) !== KiCadCanvas.serialize(c.item.node)) commitTable(c.item, node, "Delete");
  return true;
}

// ---------------------------------------------------------------- clipboard
/**
 * EDIT_TOOL::copyToClipboard's reference point for cells (PCB_GRID_HELPER::BestDragOrigin): the selected cells'
 * corner nearest the cursor, else the cursor.
 */
export function cellCopyOrigin(node: SNode, cells: number[], cursor: Pt | null): Pt {
  const list = M().tableInfo(node).cells; if (!cursor) return list[cells[0]] ? M().cellStartEnd(list[cells[0]], true).s : [0, 0];
  let best: Pt | null = null, bd = Infinity;
  for (const i of cells) if (list[i]) for (const p of M().cellCorners(list[i], true)) { const d = Math.hypot(p[0] - cursor[0], p[1] - cursor[1]); if (d < bd) { bd = d; best = p; } }
  return best || cursor;
}
/**
 * The clipboard copy of a cell selection.  On a board, CLIPBOARD_IO::SaveSelection: the table clone is unlocked and
 * moved so the reference point sits at (0, 0), then deleteUnselectedCells cuts it down and Normalizes it.
 */
export function cellsClipboardNode(node0: SNode, cells: number[], pcb: boolean, cursor: Pt | null): SNode {
  if (!pcb) return M().trimToSelection(node0, false, cells);
  const node = KiCadCanvas.cloneNode(node0);
  const lk = node.findIndex((c, i) => i > 0 && Array.isArray(c) && c[0] === "locked"); if (lk > 0) node.splice(lk, 1);
  const ref = cellCopyOrigin(node0, cells, cursor);
  KiCadCanvas.shiftTable(node, -ref[0], -ref[1]);
  return M().trimToSelection(node, true, cells);
}
/** Copy of a cell selection: the table cut down to the selected block, in the editor's clipboard format. */
function copyCells(): boolean {
  const c = cellSelection(); if (!c) return false;
  const cur = E.lastCursorMm as Pt | null | undefined;
  const node = cellsClipboardNode(c.item.node, c.cells, isPcb(), cur && cur.length >= 2 ? cur : null);
  let text = KiCadCanvas.serialize(node);
  if (isPcb()) text = `(kicad_pcb (version ${(E.kdoc as unknown as { version?: number }).version || 20260728}) (generator "kicad-collab-web") (generator_version "10.0")\n${text}\n)`;
  appClipboard.set(text);
  return true;
}
/** Paste into a cell selection: the clipboard's table goes into the block (validatePasteIntoSelection's messages). */
function pasteCells(): boolean {
  const c = cellSelection(); if (!c) return false;
  if (!editing()) return true;
  const id = c.item.id, cells0 = c.cells, node0 = c.item.node;
  Promise.resolve(appClipboard.read()).then((text: string) => {
    let src: SNode | null = null;
    try { for (const t of KiCadCanvas.parseAll(String(text || ""))) { const list = t[0] === "kicad_pcb" || t[0] === "kicad_sch" ? t.slice(1) : [t]; for (const n of list) if (Array.isArray(n) && n[0] === "table") { src = n as SNode; break; } if (src) break; } } catch { src = null; }
    const item = (E.kdoc as KDoc | null)?.items.get(id);
    if (!item) return;
    if (!src) { pasteAsItems(); return; }   // no table on the clipboard: the ordinary paste
    const cells = M().remapCells(node0, item.node, cells0);   // a peer may have changed the table meanwhile
    const err = M().pasteIntoError(item.node, cells, !structureEditable(item));
    if (err) { errorMessage(err); return; }
    const out = M().pasteCells(item.node, isPcb(), cells, src, () => KiCadCanvas.newUuid());
    commitTable(item, out, "Paste Cells"); publish();
  });
  return true;
}
function pasteAsItems(): void { sel = null; runModuleAction("paste"); }

// ---------------------------------------------------------------- the point editor (COL_WIDTH / ROW_HEIGHT handles)
/**
 * A drag of a COL_WIDTH / ROW_HEIGHT handle.  `base` is the document's item the resize applies to and `preview` the
 * item shown while dragging (set in the document locally, never sent).  A peer's change to the table during the drag
 * replaces the preview in the document: it becomes the new base, so the one commit at the release carries the
 * peer's edit with the resize on top instead of overwriting it.  `node0` / `cell` are the cell as it was pressed.
 */
interface Resize { id: string; cell: number; node0: SNode; which: "col" | "row"; base: KItem; preview: KItem | null; pointerId: number }
let resize: Resize | null = null;
const HANDLE_PX = 4;
/** The one selected cell's handles (the point editor works on a single selected item). */
function handles(): { item: KItem; cell: number; col: Pt; row: Pt } | null {
  const c = cellSelection(); if (!c || c.cells.length !== 1 || E.viewOnly) return null;
  const cell = M().tableInfo(c.item.node).cells[c.cells[0]];
  if (isPcb()) { const a = Number((KiCadCanvas.kid(cell, "angle") || [])[1] || 0); if (a % 90) return null; }   // no point editing of a rotated table
  const hd = M().cellHandles(cell, isPcb()); return { item: c.item, cell: c.cells[0], col: hd.col, row: hd.row };
}
function onHandleDown(ev: PointerEvent): void {
  if (ev.button !== 0 || E.tool !== "select" || !(ev.target instanceof Element) || !stage.contains(ev.target)) return;
  const h = handles(); if (!h) return;
  const mm = worldMm(ev), tol = (HANDLE_PX + 2) / Math.max(1, pxPerMm());
  const which = Math.hypot(mm[0] - h.col[0], mm[1] - h.col[1]) <= tol ? "col" : Math.hypot(mm[0] - h.row[0], mm[1] - h.row[1]) <= tol ? "row" : null;
  if (!which) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  resize = { id: h.item.id, cell: h.cell, node0: h.item.node, which, base: h.item, preview: null, pointerId: ev.pointerId };
  try { stage.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
  window.addEventListener("pointermove", onHandleMove, true); window.addEventListener("pointerup", onHandleUp, true);
}
/** Take a peer's change made during the drag as the new base; false when the table or the cell is gone. */
function resizeBase(r: Resize): boolean {
  const cur = (E.kdoc as KDoc | null)?.items.get(r.id);
  if (!cur || cur.kind !== "table") return false;
  if (cur !== r.preview && cur !== r.base) r.base = cur;
  return M().remapCells(r.node0, r.base.node, [r.cell]).length > 0;
}
function resizedNode(r: Resize, ev: { clientX: number; clientY: number }): SNode {
  const mm = worldMm(ev); const ctx = toolCtx(); const p = ctx.snap ? ctx.snap(mm) : mm;
  const idx = M().remapCells(r.node0, r.base.node, [r.cell])[0];
  return M().resizeCell(r.base.node, isPcb(), idx, r.which, p);
}
/** Put the base back in the document if our preview is what it shows. */
function dropPreview(r: Resize): void {
  const doc = E.kdoc as KDoc | null; if (!doc || !r.preview) return;
  if (doc.items.get(r.id) === r.preview) doc.items.set(r.id, r.base);
  r.preview = null;
}
function endResize(): void { window.removeEventListener("pointermove", onHandleMove, true); window.removeEventListener("pointerup", onHandleUp, true); resize = null; }
function onHandleMove(ev: PointerEvent): void {
  const r = resize; if (!r) return; ev.stopImmediatePropagation();
  if (!resizeBase(r)) { dropPreview(r); endResize(); requestRender(); return; }
  const doc = E.kdoc as KDoc; const node = resizedNode(r, ev);
  const pv = { ...r.base, node, geom: [], bbox: null } as unknown as KItem;
  KiCadCanvas.replaceChange(doc, pv);   // builds the preview's geometry
  doc.items.set(r.id, pv); r.preview = pv;   // the live preview, shown locally only
  requestRender();
}
function onHandleUp(ev: PointerEvent): void {
  const r = resize; if (!r) return; ev.stopImmediatePropagation();
  endResize();
  const ok = resizeBase(r); dropPreview(r);   // back to the document's table, then one commit
  if (ok) {
    const node = resizedNode(r, ev);
    if (KiCadCanvas.serialize(node) !== KiCadCanvas.serialize(r.base.node)) commitTable(r.base, node, "Resize Table Cells");
  }
  requestRender();
}
function cancelResize(): boolean {
  const r = resize; if (!r) return false;
  endResize(); resizeBase(r); dropPreview(r); requestRender(); return true;
}
/** The two handles, drawn like the point editor's (EDIT_POINTS_PAINTER: a filled square). */
export function drawCellHandles(ctx: CanvasRenderingContext2D): void {
  const h = handles(); if (!h) return;
  const s = HANDLE_PX / Math.max(1e-6, pxPerMm());
  ctx.save(); ctx.fillStyle = isPcb() ? "#cc4cff" : "#d6a800"; ctx.strokeStyle = isPcb() ? "#ffffff" : "#000000"; ctx.lineWidth = 1 / Math.max(1e-6, pxPerMm());
  for (const p of [h.col, h.row]) { ctx.fillRect(p[0] - s, p[1] - s, 2 * s, 2 * s); ctx.strokeRect(p[0] - s, p[1] - s, 2 * s, 2 * s); }
  ctx.restore();
}

// ---------------------------------------------------------------- keys
const PROMOTE = new Set(["m", "M", "r", "R", "f", "F", "x", "X", "y", "Y", "g", "G", "d", "D"]);
function onKey(ev: KeyboardEvent): boolean {
  if (ev.key === "Escape") { if (cancelResize() || cancelPress()) { ev.preventDefault(); return true; } if (sel) { sel = null; publish(); } return false; }
  const c = cellSelection(); if (!c || E.tool !== "select") return false;
  const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key;
  const take = (fn: () => unknown): boolean => { ev.preventDefault(); fn(); return true; };
  if (ctrl && !ev.altKey && (k === "e" || k === "E") && !ev.shiftKey) return take(editTable);
  if (ctrl && !ev.altKey && !ev.shiftKey && (k === "c" || k === "C")) return take(copyCells);
  if (ctrl && !ev.altKey && !ev.shiftKey && (k === "x" || k === "X")) return take(() => { copyCells(); deleteCellText(); });
  if (ctrl && !ev.altKey && !ev.shiftKey && (k === "v" || k === "V")) return take(pasteCells);
  if (ctrl || ev.altKey) return false;
  if (k === "Delete" || k === "Backspace") return take(deleteCellText);
  if (k === "e" || k === "E") return take(cellProperties);
  if (PROMOTE.has(k)) promoteToTable();   // the key goes on to act on the table
  return false;
}

// ---------------------------------------------------------------- the context menu's view
/** MenuCtx fields for a cell selection (EDIT_TABLE_TOOL_BASE::addMenus conditions). */
export function cellMenuState(): { n: number; block: boolean; merged: boolean; structure: boolean } | null {
  const c = cellSelection(); if (!c) return null;
  return { n: c.cells.length, block: M().isCellBlock(c.item.node, c.cells), merged: M().hasMergedCell(c.item.node, c.cells), structure: structureEditable(c.item) };
}
/** A right click: a cell under the cursor that is not selected becomes the selection (selectPoint). */
export function contextPick(mm: Pt): boolean {
  const hit = cellUnder(mm); if (!hit) return false;
  if (selectionIds().includes(hit.item.id)) return false;
  const c = cellSelection(); if (c && c.item.id === hit.item.id && c.cells.includes(hit.cell)) return true;
  clearAllSelection(false); setCells(hit.item.id, [hit.cell], hit.cell, hit.item.node); return true;
}
/** The context menu's runners for the table actions, by KiCad action name. */
export const TABLE_ACTIONS: Record<string, () => boolean> = {
  "ACTIONS::selectColumns": () => selectRowsCols("cols"), "ACTIONS::selectRows": () => selectRowsCols("rows"), "ACTIONS::selectTable": () => selectRowsCols("table"),
  "ACTIONS::addRowAbove": () => runEdit("addRowAbove"), "ACTIONS::addRowBelow": () => runEdit("addRowBelow"),
  "ACTIONS::addColBefore": () => runEdit("addColBefore"), "ACTIONS::addColAfter": () => runEdit("addColAfter"),
  "ACTIONS::deleteRows": () => runEdit("deleteRows"), "ACTIONS::deleteColumns": () => runEdit("deleteColumns"),
  "ACTIONS::mergeCells": () => runEdit("mergeCells"), "ACTIONS::unmergeCells": () => runEdit("unmergeCells"),
  "ACTIONS::editTable": editTable, "ACTIONS::exportTableCSV": exportCsv,
  "SCH_ACTIONS::properties": cellProperties, "PCB_ACTIONS::properties": cellProperties,
  "ACTIONS::copy": copyCells, "ACTIONS::paste": pasteCells, "ACTIONS::doDelete": deleteCellText,
  "ACTIONS::cut": () => { copyCells(); return deleteCellText(); },
};

// ---------------------------------------------------------------- message panel
/** MessageTextFromValue: "%.4f mm", "%.2f mils", "%.4f in". */
const msgValue = (v: number, units: string) => units === "mil" ? (v / 0.0254).toFixed(2) + " mils" : units === "in" ? (v / 25.4).toFixed(4) + " in" : v.toFixed(4) + " mm";
/** KIUI::EllipsizeStatusText: unescaped, line breaks and tabs as spaces, cut with an ellipsis to 30 % of the first 800 px of the window plus 60 % of the rest. */
export function ellipsizeStatusText(text: string, windowPx: number, charPx = 7): string {
  let msg = String(text || "").replace(/\{(slash|backslash|lt|gt|colon|dblquote|quote|space|tab|return|brace|bar)\}/g, (_m, k: string) => ({ slash: "/", backslash: "\\", lt: "<", gt: ">", colon: ":", dblquote: '"', quote: "'", space: " ", tab: "\t", return: "\n", brace: "{", bar: "|" } as Record<string, string>)[k]);
  msg = msg.replace(/[\n\r\t]/g, " ");
  const px = Math.min(windowPx, 800) * 0.3 + Math.max(windowPx - 800, 0) * 0.6, max = Math.max(1, Math.floor(px / charPx));
  return msg.length > max ? msg.slice(0, Math.max(0, max - 1)) + "\u2026" : msg;
}
/** PCB_TABLECELL / SCH_TABLECELL::GetMsgPanelInfo for a single selected cell (the frame shows one item's panel only). */
export function cellMsgPanel(units: string): MsgItem[] | null {
  const c = cellSelection(); if (!c || c.cells.length !== 1) return null;
  const pcb = isPcb(), T = M().tableInfo(c.item.node), i = c.cells[0], cell = T.cells[i]; if (!cell) return null;
  const row = Math.floor(i / T.cols), col = i % T.cols;
  const out: MsgItem[] = []; const add = (title: string, value: string) => out.push({ title, value });
  const K = KiCadCanvas as unknown as { effectsOf(n: SNode): { size: number; sizeX: number; thick: number; bold?: boolean; italic?: boolean; face?: string; mirror?: boolean; just?: string[] } };
  const ef = K.effectsOf(cell);
  const fontN = KiCadCanvas.kid(KiCadCanvas.kid(cell, "effects") || [], "font"); const faceN = fontN ? KiCadCanvas.kid(fontN, "face") : null;
  const font = faceN && String(faceN[1] || "") ? String(faceN[1]) : "Default";
  const { s: a, e: b } = M().cellStartEnd(cell, pcb);
  add("Table Cell", KiCadCanvas.cellAddr(row, col, pcb));
  add("Text", ellipsizeStatusText(M().cellText(cell), stage.clientWidth || 800));   // GetText, not the shown text
  if (pcb) {
    // "Status: Locked" needs the cell's own m_isLocked or a locked group of the cell; a cell has neither (BOARD_ITEM::IsLocked)
    const ln = String((KiCadCanvas.kid(c.item.node, "layer") || [])[1] || "Dwgs.User");
    const L = (E.kdoc as unknown as { layers?: Map<string, { userName?: string }> }).layers; const l = L && L.get ? L.get(ln) : null;
    add("Layer", l && l.userName ? l.userName : ln);
    add("Mirror", ef.mirror ? "Yes" : "No");
  }
  add("Cell Width", msgValue(Math.abs(b[0] - a[0]), units));
  add("Cell Height", msgValue(Math.abs(b[1] - a[1]), units));
  add("Font", font);
  if (pcb) {
    add("Text Thickness", ef.thick > 0 ? msgValue(ef.thick, units) : "Auto");
    add("Text Width", msgValue(ef.sizeX, units));
    add("Text Height", msgValue(ef.size, units));
  } else {
    add("Style", ef.bold && ef.italic ? "Bold Italic" : ef.bold ? "Bold" : ef.italic ? "Italic" : "Normal");
    add("Text Size", msgValue(ef.sizeX, units));
  }
  return out;
}

// ---------------------------------------------------------------- install
let installed = false;
export function installTableCells(): void {
  if (installed || typeof window === "undefined") return; installed = true;
  window.addEventListener("pointerdown", onHandleDown, true);
  window.addEventListener("pointerdown", onDown, true);
  stage.addEventListener("dblclick", (ev) => {
    if (!E.kdoc || E.tool !== "select") return;
    const hit = cellUnder(worldMm(ev)); const c = cellSelection();
    if (!hit || !c || c.item.id !== hit.item.id || !c.cells.includes(hit.cell)) return;
    ev.stopImmediatePropagation(); ev.preventDefault(); cellProperties();
  }, true);
  keyHooks.push(onKey);
  clearHooks.push(clearCells);
  overlayHooks.push(drawCellSelection, drawCellHandles);
  propertiesHooks.push(cellProperties);
  msgHooks.push(cellMsgPanel);
  tableMenu.state = cellMenuState; tableMenu.pick = contextPick; tableMenu.actions = TABLE_ACTIONS;
  (window as unknown as { CollabTableCells?: unknown }).CollabTableCells = { newSchTableDialog, cellSelection, clearCells, selectTables, runEdit, selectRowsCols, cellProperties, editTable, exportCsv, cellUnder, promoteToTable, TABLE_ACTIONS, cellMenuState };
}
