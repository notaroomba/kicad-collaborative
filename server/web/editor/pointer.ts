// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { fpName, snapMm, syncItemsFromDoc } from "./doc";
import { NS } from "./dom";
import { sendOp } from "./net";
import { drawSelection, groupExpand, renderProps } from "./selection";
import { E } from "./state";
import { appClipboard, moveOp, publishUndo, redoStack, toolCtx, undoStack, unlockedForEdit } from "./tools";
import { rulerStrings, snapped45, type RulerUnits } from "./ruler";
import type { ItemSummary } from "./types";
import { dragG, fitBox, isSch, pxPerMm, requestRender, requestRepaint, stage, svgText, worldMm, zoomBy } from "./view";
/** E: KiCad's "Edit properties" for whatever is selected — a field, the app selection, or a tool module's own selection. */
export function openSelectionProperties() {
  if (!E.kdoc || !window.KDialogs) return false;
  const ctx = toolCtx();
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.tunerProperties && CollabTools.pcb.tunerProperties(ctx)) return true;
  if (E.selField) { const it = E.kdoc.items.get(E.selField.id); if (it) { KDialogs!.openField(ctx, it, E.selField.name); return true; } }
  if (isSch() && KDialogs!.schProperties && KDialogs!.schProperties()) return true;   // SCH_EDIT_TOOL::Properties (web/dialogs/sch-items.ts)
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.selectedPad && CollabTools.pcb.padProperties) {   // a pad picked on its own: Pad Properties
    const p = CollabTools.pcb.selectedPad(E.kdoc); if (p) { CollabTools.pcb.padProperties(ctx, p.item, p.index); return true; }
  }
  const modSel = isSch() ? (CollabTools.sch && CollabTools.sch.state && CollabTools.sch.state.sel) : (CollabTools.pcb && CollabTools.pcb.state && CollabTools.pcb.state.sel);
  // the board module keeps a Set of ids (tracks, vias, graphics, zones), the schematic module one id
  const first = (s: unknown): string | null => (s && typeof s === "object" && typeof (s as Iterable<string>)[Symbol.iterator] === "function" ? (s as Set<string>).values().next().value : s as string | null) || null;
  const id = E.selected ? E.selected.id : (first(modSel) || first(E.selection));
  const it = id && E.kdoc.items.get(id);
  if (!it && !isSch() && CollabTools.pcb && CollabTools.pcb.requestSelection) {
    // EDIT_TOOL::Properties with nothing selected: the item under the cursor (a hover selection, not kept)
    const sel = CollabTools.pcb.requestSelection(ctx, { locks: false, rerun: () => { openSelectionProperties(); } });
    if (sel && sel.items.length) KDialogs!.openItem(ctx, sel.items[0]);
    return true;
  }
  if (!it) return false;
  KDialogs!.openItem(ctx, it); return true;
}

export function drawDrag() {
  dragG.replaceChildren();
  if (!E.drag) return;
  if (E.kdoc && !isSch()) return;   // a board shows the footprint itself moving, as pcbnew does: no leader line or library name on top
  const s = pxPerMm(), [x, y] = E.drag.curMm;
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", E.drag.fp.x / E.IU); line.setAttribute("y1", E.drag.fp.y / E.IU);
  line.setAttribute("x2", x); line.setAttribute("y2", y);
  line.setAttribute("stroke", "#ffb43a"); line.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); line.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(line);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4 / s);
  dot.setAttribute("fill", "none"); dot.setAttribute("stroke", "#ffb43a"); dot.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(dot);
  dragG.appendChild(svgText(x + 6 / s, y - 6 / s, 12 / s, "#ffb43a", isSch() ? fpName(E.drag.fp) : E.drag.fp.lib.split(":").pop()));
}

/** One footprint / symbol of a group drag (E.drag.group): where it started, in internal units. */
type GroupMember = { fp: ItemSummary; ox: number; oy: number };

// ---- measure tool: PCB_VIEWER_TOOLS::MeasureTool with a RULER_ITEM (drawn by overlays.ts, in nm) ----
const toNm = (mm: number[]): [number, number] => [Math.round(mm[0] * 1e6), Math.round(mm[1] * 1e6)];

/** A click (or the press of a drag) sets the origin; the next click, or the release of that drag, freezes the ruler where it is. */
export function measureDown(mm: number[], ev: { clientX: number; clientY: number }): void {
  if (!E.measure || !E.measure.set) { const p = toNm(mm); E.measure = { a: p, b: p, set: true, down: [ev.clientX, ev.clientY] }; requestRepaint(); return; }
  measureStop();
}
export function measureUp(ev: { clientX: number; clientY: number }): void {
  const m = E.measure; if (!m || !m.set || !m.down) return;
  if (Math.hypot(ev.clientX - m.down[0], ev.clientY - m.down[1]) > 3) { measureStop(); return; }   // the mouse-up that ends a drag
  m.down = null;                                                                                  // a click: the ruler now follows the cursor
}
function measureStop(): void { const m = E.measure; if (!m) return; m.set = false; m.down = null; requestRepaint(); }

/** The cursor moved: the end follows it, held to 45° steps with Shift (LEADER_MODE::DEG45). */
export function measureMove(mm: number[], shift: boolean): void {
  const m = E.measure; if (!m || !m.set) return;
  const p = toNm(mm); m.b = shift ? snapped45(m.a, p) : p; requestRepaint();
}

/** Ctrl+C while measuring: the ruler's readout, one value a line (RULER_ITEM::GetDimensionStrings). */
export function measureCopy(): boolean {
  const m = E.measure; if (!m || !m.set) return false;
  appClipboard.set(rulerStrings(m.a, m.b, (E.units === "in" || E.units === "mil" ? E.units : "mm") as RulerUnits).join("\n"));
  return true;
}

/** Esc while the ruler follows the cursor drops it (the tool stays). */
export function measureCancel(): boolean { if (!E.measure || !E.measure.set) return false; E.measure = null; requestRepaint(); return true; }

// zoom-area tool: drag a rectangle, the view fits it
export function drawZoomRect(ev: { clientX: number; clientY: number }) {
  E.zoomRect.a = worldMm({ clientX: E.zoomRect.start[0], clientY: E.zoomRect.start[1] }); E.zoomRect.b = worldMm(ev); requestRepaint();
}

export function finishZoomRect(ev: { clientX: number; clientY: number }) {
  const a = worldMm({ clientX: E.zoomRect.start[0], clientY: E.zoomRect.start[1] }), b = worldMm(ev); E.zoomRect = null; requestRepaint();
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (w < 0.5 || h < 0.5) { zoomBy(2, ev.clientX, ev.clientY); return; }
  fitBox([Math.min(a[0], b[0]), Math.min(a[1], b[1]), w, h], 0.9);
}

export function startGroupDrag(hit: { id: string; fp?: ItemSummary | { id: string; x: number; y: number }; item?: KItem }, mm: [number, number], ev: { pointerId: number }) {
  E.selection = groupExpand(E.selection);
  const its: KItem[] = [...E.selection].map((id) => E.kdoc.items.get(id)).filter(Boolean);
  const fp = hit.fp || { id: hit.id, x: Math.round(KiCadCanvas.atOf(hit.item!.node)[0] * E.IU), y: Math.round(KiCadCanvas.atOf(hit.item!.node)[1] * E.IU) };
  if (isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    let d: unknown = null; try { d = CollabTools.sch.beginDrag(toolCtx(), its, mm, true); } catch (e) { d = null; }
    if (d) { E.drag = { fp, engine: true, clickId: hit.id, startMm: mm, curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, wires: [] }; stage.setPointerCapture(ev.pointerId); return; }
  }
  // board: tracks, vias, graphics, text or zones in the selection — the module moves everything together
  if (!isSch() && its.some((it) => it.kind !== "footprint") && CollabTools.pcb && CollabTools.pcb.beginMove) {
    try { if (CollabTools.pcb.beginMove(toolCtx(), mm, false)) stage.setPointerCapture(ev.pointerId); } catch (e) { console.warn(e); }
    return;
  }
  // board (or a schematic module without group support): move the footprints together
  const free = isSch() ? null : new Set(unlockedForEdit(its.map((it) => it.id)));
  const members = its.filter((it) => !free || free.has(it.id)).filter((it) => it.kind === "footprint" || it.kind === "symbol").map((it) => { const f = E.items.find((q: ItemSummary) => q.id === it.id); return f ? { fp: f, ox: f.x, oy: f.y } : null; }).filter(Boolean);
  if (!members.length) return;
  E.drag = { fp, group: members, clickId: hit.id, startMm: mm, grab: snapMm(mm), curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, last: [0, 0] };
  stage.setPointerCapture(ev.pointerId);
}

/** A plain click (no drag) on one item of a multi-selection selects that item alone, as in KiCad. */
export function collapseSelectionTo(id: string) {
  if (!id || !E.kdoc || !E.kdoc.items.has(id) || E.selection.size < 2) return;
  const keep = groupExpand([id]); if (keep.size === E.selection.size) return;
  toolCtx().setSelection(keep);
}

export function moveGroupDrag(mm: [number, number]) {
  const t = snapMm(mm); const dx = Math.round((t[0] - E.drag.grab[0]) * E.IU), dy = Math.round((t[1] - E.drag.grab[1]) * E.IU);
  if (dx === E.drag.last[0] && dy === E.drag.last[1]) return; E.drag.last = [dx, dy]; E.drag.moved = true;
  for (const m of E.drag.group as GroupMember[]) { const nx = m.ox + dx, ny = m.oy + dy; KiCadCanvas.applyChange(E.kdoc, moveOp(m.fp, nx, ny), E.IU); m.fp.x = nx; m.fp.y = ny; }
  requestRender();
  const now = Date.now(); if (now - E.lastLiveMove > 150) { E.lastLiveMove = now; sendOp(E.drag.group.map((m: GroupMember) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y)), true); }
}

export function finishGroupDrag() {
  const g = E.drag; E.drag = null; dragG.replaceChildren(); if (!g.moved) collapseSelectionTo(g.clickId); if (!g.moved || (!g.last[0] && !g.last[1])) return;
  const changes: KChange[] = g.group.map((m: GroupMember) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y));
  const inverse: KChange[] = g.group.map((m: GroupMember) => moveOp({ id: m.fp.id, x: m.fp.x, y: m.fp.y }, m.ox, m.oy));
  // our copy must end where we say it ends: a peer's move of the same footprint that arrived mid-drag would otherwise stay on screen here
  if (E.kdoc) for (const c of changes) KiCadCanvas.applyChange(E.kdoc, c, E.IU);
  sendOp(changes);
  undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
}
