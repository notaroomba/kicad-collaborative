// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setStatusBar } from "./appstore";
import { fpName, snapMm, syncItemsFromDoc } from "./doc";
import { NS } from "./dom";
import { sendOp } from "./net";
import { drawSelection, groupExpand, renderProps } from "./selection";
import { E } from "./state";
import { moveOp, publishUndo, redoStack, toolCtx, undoStack } from "./tools";
import { UNITS, fmtLen } from "./util";
import { dragG, fitBox, isSch, pxPerMm, requestRender, stage, svgText, worldMm, zoomBy } from "./view";
/** E: KiCad's "Edit properties" for whatever is selected — a field, the app selection, or a tool module's own selection. */
export function openSelectionProperties() {
  if (!E.kdoc || !window.KDialogs) return false;
  const ctx = toolCtx();
  if (E.selField) { const it = E.kdoc.items.get(E.selField.id); if (it) { KDialogs.openField(ctx, it, E.selField.name); return true; } }
  const modSel = isSch() ? (CollabTools.sch && CollabTools.sch.state && CollabTools.sch.state.sel) : (CollabTools.pcb && CollabTools.pcb.state && CollabTools.pcb.state.sel);
  const id = E.selected ? E.selected.id : modSel;
  const it = id && E.kdoc.items.get(id); if (!it) return false;
  KDialogs.openItem(ctx, it); return true;
}

export function drawDrag() {
  dragG.replaceChildren();
  if (!E.drag) return;
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

// measure tool: two clicks, the distance goes to the status bar
export function measureClick(mm) {
  if (!E.measure || E.measure.b) { E.measure = { a: mm }; dragG.replaceChildren(); setStatusBar({ message: "Measure — click the second point" }); return; }
  E.measure.b = mm; drawMeasure(mm);
  const dx = mm[0] - E.measure.a[0], dy = mm[1] - E.measure.a[1];
  setStatusBar({ message: `dist ${fmtLen(Math.hypot(dx, dy))} ${UNITS[E.units].name} · dx ${fmtLen(dx)} · dy ${fmtLen(dy)} · ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°` });
}

export function drawMeasure(mm) {
  if (!E.measure) return; dragG.replaceChildren();
  const s = pxPerMm(), a = E.measure.a;
  const line = document.createElementNS(NS, "line"); line.setAttribute("x1", a[0]); line.setAttribute("y1", a[1]); line.setAttribute("x2", mm[0]); line.setAttribute("y2", mm[1]);
  line.setAttribute("stroke", "#ffb43a"); line.setAttribute("stroke-width", 1.5 / s); dragG.appendChild(line);
  const t = svgText((a[0] + mm[0]) / 2, (a[1] + mm[1]) / 2 - 6 / s, 11 / s, "#ffb43a", `${fmtLen(Math.hypot(mm[0] - a[0], mm[1] - a[1]))} ${UNITS[E.units].name}`); t.setAttribute("text-anchor", "middle"); dragG.appendChild(t);
}

// zoom-area tool: drag a rectangle, the view fits it
export function drawZoomRect(ev) {
  dragG.replaceChildren(); const a = worldMm({ clientX: E.zoomRect.start[0], clientY: E.zoomRect.start[1] }), b = worldMm(ev);
  const r = document.createElementNS(NS, "rect"); r.setAttribute("x", Math.min(a[0], b[0])); r.setAttribute("y", Math.min(a[1], b[1])); r.setAttribute("width", Math.abs(b[0] - a[0])); r.setAttribute("height", Math.abs(b[1] - a[1]));
  r.setAttribute("fill", "#4D7FC433"); r.setAttribute("stroke", "#4D7FC4"); r.setAttribute("stroke-width", 1 / pxPerMm()); dragG.appendChild(r);
}

export function finishZoomRect(ev) {
  const a = worldMm({ clientX: E.zoomRect.start[0], clientY: E.zoomRect.start[1] }), b = worldMm(ev); E.zoomRect = null; dragG.replaceChildren();
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (w < 0.5 || h < 0.5) { zoomBy(2, ev.clientX, ev.clientY); return; }
  fitBox([Math.min(a[0], b[0]), Math.min(a[1], b[1]), w, h], 0.9);
}

export function startGroupDrag(hit, mm, ev) {
  E.selection = groupExpand(E.selection);
  const its = [...E.selection].map((id) => E.kdoc.items.get(id)).filter(Boolean);
  const fp = hit.fp || { id: hit.id, x: Math.round(KiCadCanvas.atOf(hit.item.node)[0] * E.IU), y: Math.round(KiCadCanvas.atOf(hit.item.node)[1] * E.IU) };
  if (isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    let d = null; try { d = CollabTools.sch.beginDrag(toolCtx(), its, mm, true); } catch (e) { d = null; }
    if (d) { E.drag = { fp, engine: true, startMm: mm, curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, wires: [] }; stage.setPointerCapture(ev.pointerId); return; }
  }
  // board (or a schematic module without group support): move the footprints together
  const members = its.filter((it) => it.kind === "footprint" || it.kind === "symbol").map((it) => { const f = E.items.find((q) => q.id === it.id); return f ? { fp: f, ox: f.x, oy: f.y } : null; }).filter(Boolean);
  if (!members.length) return;
  E.drag = { fp, group: members, startMm: mm, grab: snapMm(mm), curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, last: [0, 0] };
  stage.setPointerCapture(ev.pointerId);
}

export function moveGroupDrag(mm) {
  const t = snapMm(mm); const dx = Math.round((t[0] - E.drag.grab[0]) * E.IU), dy = Math.round((t[1] - E.drag.grab[1]) * E.IU);
  if (dx === E.drag.last[0] && dy === E.drag.last[1]) return; E.drag.last = [dx, dy]; E.drag.moved = true;
  for (const m of E.drag.group) { const nx = m.ox + dx, ny = m.oy + dy; KiCadCanvas.applyChange(E.kdoc, moveOp(m.fp, nx, ny), E.IU); m.fp.x = nx; m.fp.y = ny; }
  requestRender();
  const now = Date.now(); if (now - E.lastLiveMove > 150) { E.lastLiveMove = now; sendOp(E.drag.group.map((m) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y)), true); }
}

export function finishGroupDrag() {
  const g = E.drag; E.drag = null; dragG.replaceChildren(); if (!g.moved || (!g.last[0] && !g.last[1])) return;
  const changes = g.group.map((m) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y));
  const inverse = g.group.map((m) => moveOp({ id: m.fp.id, x: m.fp.x, y: m.fp.y }, m.ox, m.oy));
  sendOp(changes);
  undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
}
