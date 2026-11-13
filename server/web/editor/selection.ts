// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { setStatusBar, store } from "./appstore";
import { fpName, renderObjects } from "./doc";
import { $, NS } from "./dom";
import { sendOp } from "./net";
import { editorId } from "./panes";
import { E } from "./state";
import { activeModule, deleteSelected, moveOp, rotateSelected, toolCtx } from "./tools";
import { esc } from "./util";

/** Called by clearSelection: selections kept outside E (the table cell selection, editor/tablecells.ts). */
export const clearHooks: (() => void)[] = [];
/** GENERAL_COLLECTOR's accuracy (collectors.h: 5 px): one hit tolerance for a board click, the hover selection
 *  R / F / M / Del use and the Clarify Selection candidates, so a point is a hit for all of them or for none. */
export const HIT_PX = 5;
import type { BoxSel, ItemSummary, SheetEntry } from "./types";
import { dragG, isSch, pxPerMm, requestRender, requestRepaint, selG, svgText } from "./view";
/** Board groups: a member drags/deletes with its whole group (KiCad's default). */
export function groupExpand(ids: Iterable<string>) { const m = isSch() ? CollabTools.sch : CollabTools.pcb; if (!E.kdoc || !m || !m.expandGroups) return new Set(ids); try { return new Set(m.expandGroups(E.kdoc, [...ids])); } catch (e) { return new Set(ids); } }




export function selectedSet() { const s = new Set<string>(E.selection); if (E.selected) s.add(E.selected.id); return s.size ? s : null; }

   // a selected symbol / footprint field {id, name} and its drag {id, name, startMm, orig, moved}
export function clearSelection() {
  E.selection.clear(); E.selected = null; E.selField = null; E.selPins = []; for (const f of clearHooks) f();   // a table cell selection too
  if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null);
  const pcb = CollabTools.pcb && CollabTools.pcb.state; if (pcb && pcb.sel) pcb.sel.clear(); if (pcb) pcb.padSel = null;   // the board module's own picks (tracks, vias, graphics) clear with everything else
}

/** World-space delta → the field's own coordinate frame (schematic fields are absolute; footprint fields ride the footprint's rotation/scale). */
export function fieldLocalDelta(item: KItem, dx: number, dy: number) {
  if (isSch() || item.kind !== "footprint") return [dx, dy];
  const [, , frot] = KiCadCanvas.atOf(item.node); const tr = KiCadCanvas.kid(item.node, "transform"), sc = tr && KiCadCanvas.kid(tr, "scale");
  const sx = sc ? KiCadCanvas.num(sc[1], 1) || 1 : 1, sy = sc ? KiCadCanvas.num(sc[2], 1) || 1 : 1;
  const r = frot * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  return [(dx * c - dy * sn) / sx, (dx * sn + dy * c) / sy];
}

export function fieldOf(item: Pick<KItem, "node">, name: string) { return window.KDialogs && KDialogs!._ ? (KDialogs!._.fieldNode as (node: SNode, name: string) => SNode | null)(item.node, name) : null; }

// KiCad's selection filter categories for an item kind.
export function filterKey(kind: string, it?: KItem | null) {
  if (isSch()) return kind === "symbol" ? "symbols" : (kind === "wire" || kind === "bus") ? "wires" : /label|netclass_flag/.test(kind) ? "labels" : kind === "image" ? "images" : (kind === "text" || kind === "text_box") ? "text" : kind === "rule_area" ? "ruleAreas" : /rectangle|circle|arc|polyline|bezier/.test(kind) ? "graphics" : "other";
  return kind === "footprint" ? "footprints" : (kind === "segment" || kind === "arc") ? "tracks" : kind === "via" ? "vias" : kind === "zone" ? (it && it.node && KiCadCanvas.kid(it.node, "keepout") ? "keepouts" : "zones") : kind === "dimension" ? "dimensions" : (kind === "gr_text" || kind === "gr_text_box") ? "text" : /^gr_|image|table/.test(kind) ? "graphics" : "other";
}

/** (locked yes) — or the bare `locked` token of older files — on an item's node. */
export function itemLocked(it: KItem | null | undefined) { const n = it && it.node; if (!n) return false; const l = KiCadCanvas.kid(n, "locked"); return l ? KiCadCanvas.str(l[1]) !== "no" : n.indexOf("locked") > 0; }

/** The selection filter's verdict on an item kind; with the item itself also "Locked items" and Rule Areas (a keepout zone). */
export function filterAllows(kind: string, it?: KItem | null) { const f = selFilter(); if (it && f.lockedItems === false && itemLocked(it)) return false; const k = filterKey(kind, it); return f[k] !== false; }

/** Hit-test options: hidden layers never count and the active layer's side is preferred (KiCad's candidate rules). */
export function hitOpts() { return { hidden: E.hiddenLayers, side: !isSch() && E.activeLayer && /^B\./.test(E.activeLayer) ? "B" : "F" }; }

   // {id, onGeom} of the latest nearestFootprint() call
export function nearestFootprint(x: number, y: number, radiusMm: number): ItemSummary | SheetEntry | null {
  if (E.kdoc) { const f = selFilter(); if ((isSch() && f.symbols === false) || (!isSch() && f.footprints === false)) return null; E.lastFpHit = KiCadCanvas.hitTestDetail(E.kdoc, x, y, Math.min(radiusMm, (isSch() ? 3 : HIT_PX) / Math.max(1, pxPerMm())) /* KiCad's hit accuracy: GENERAL_COLLECTOR's 5 px on a board */, hitOpts()); const id = E.lastFpHit ? E.lastFpHit.id : null; const hitIt = id ? E.kdoc.items.get(id) : null; if (hitIt && !filterAllows(hitIt.kind, hitIt)) return null; return id ? E.items.find((f2: ItemSummary) => f2.id === id) || E.sheets.find((sh: SheetEntry) => sh.id === id) /* a hierarchical sheet is picked like a symbol */ || null : null; }
  let best: ItemSummary | null = null, bestD = radiusMm;
  for (const fp of E.items) { const d = Math.hypot(fp.x / E.IU - x, fp.y / E.IU - y); if (d < bestD) { best = fp; bestD = d; } }
  return best;
}

export function drawSelection() {
  selG.replaceChildren();
  if (!E.selected) return;
  if (E.kdoc) { requestRender(); return; }   // the renderer draws KiCad's selection halo around the item itself
  const s = pxPerMm(), x = E.selected.x / E.IU, y = E.selected.y / E.IU;
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", x); ring.setAttribute("cy", y); ring.setAttribute("r", 10 / s);
  ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#ffb43a");
  ring.setAttribute("stroke-width", 2.5 / s); ring.setAttribute("stroke-dasharray", `${5 / s} ${3 / s}`);
  selG.appendChild(ring);
  selG.appendChild(svgText(x + 12 / s, y - 12 / s, 12 / s, "#ffb43a", isSch() ? fpName(E.selected) : `${E.selected.lib.split(":").pop()} (${Math.round(E.selected.rot || 0)}°)`));
}


// ---- panels ----
// The docked panes are React (server/web/components/panes); app.js publishes what they show.
/** Publish the selection; bumping its version makes the Properties island redraw (props.js). */
export function renderProps() {
  const v = store.get().selection.version + 1;
  store.set({ selection: { ids: Array.from(selectedSet() || []), primary: E.selected ? Object.assign({}, E.selected) : null, field: E.selField ? { id: E.selField.id, name: E.selField.name } : null, version: v } });
}

/** The Properties pane's imperative island: props.js draws into the pane's div (window.CollabApp.renderProps). */
export function renderPropsInto(el: HTMLElement | null) {
  if (!el) return;
  const $ = (sel: string) => el.querySelector(sel) as HTMLInputElement;
  if (E.kdoc && CollabTools.props && CollabTools.props.render) { try { CollabTools.props.render(el, E.selected || (E.selField ? { id: E.selField.id } : null), toolCtx()); return; } catch (e) { console.warn(e); } }
  if (!E.selected) { el.innerHTML = `<p class="note">Select a footprint on the board to see its properties.</p>`; return; }
  const ro = E.viewOnly ? "disabled" : "";
  if (isSch()) {
    el.innerHTML = `<div class="kv">
      <label>Reference</label><div class="ro">${esc(E.selected.ref || "")}</div>
      <label>Value</label><div class="ro">${esc(E.selected.value || "")}</div>
      <label>Symbol</label><div class="ro" title="${esc(E.selected.lib)}">${esc(E.selected.lib)}</div>
      <label>X (mm)</label><input id="pX" type="number" step="0.01" value="${(E.selected.x / E.IU).toFixed(2)}" ${ro}>
      <label>Y (mm)</label><input id="pY" type="number" step="0.01" value="${(E.selected.y / E.IU).toFixed(2)}" ${ro}>
      <label>Rotation</label><div class="ro">${Math.round(E.selected.rot || 0)}°</div>
      <label>UUID</label><div class="ro muted">${esc(E.selected.id)}</div></div>
      <div class="actions"><button class="btn sm danger" id="pDelBtn" ${ro}>Delete</button></div>`;
    if (E.viewOnly) return;
    const commitPos = () => {
      const nx = Math.round(parseFloat($("#pX").value) * E.IU), ny = Math.round(parseFloat($("#pY").value) * E.IU);
      if (isNaN(nx) || isNaN(ny) || (nx === E.selected.x && ny === E.selected.y)) return;
      sendOp([moveOp(E.selected, nx, ny)]); E.selected.x = nx; E.selected.y = ny; drawSelection();
    };
    $("#pX").onchange = commitPos; $("#pY").onchange = commitPos; $("#pDelBtn").onclick = deleteSelected;
    return;
  }
  el.innerHTML = `<div class="kv">
    <label>Footprint</label><div class="ro" title="${esc(E.selected.lib)}">${esc(E.selected.lib)}</div>
    <label>X (mm)</label><input id="pX" type="number" step="0.01" value="${(E.selected.x / E.IU).toFixed(3)}" ${ro}>
    <label>Y (mm)</label><input id="pY" type="number" step="0.01" value="${(E.selected.y / E.IU).toFixed(3)}" ${ro}>
    <label>Rotation</label><input id="pRot" type="number" step="1" value="${Math.round(E.selected.rot || 0)}" ${ro}>
    <label>UUID</label><div class="ro muted">${esc(E.selected.id)}</div></div>
    <div class="actions"><button class="btn sm" id="pRotBtn" ${ro}>Rotate 90°</button><button class="btn sm danger" id="pDelBtn" ${ro}>Delete</button></div>`;
  if (E.viewOnly) return;
  const commitPos = () => {
    const nx = Math.round(parseFloat($("#pX").value) * E.IU), ny = Math.round(parseFloat($("#pY").value) * E.IU);
    if (isNaN(nx) || isNaN(ny) || (nx === E.selected.x && ny === E.selected.y)) return;
    sendOp([moveOp(E.selected, nx, ny)]); E.selected.x = nx; E.selected.y = ny; drawSelection();
  };
  $("#pX").onchange = commitPos; $("#pY").onchange = commitPos;
  $("#pRot").onchange = () => {
    const after = ((parseFloat($("#pRot").value) % 360) + 360) % 360, before = E.selected.rot || 0;
    if (isNaN(after) || after === before) return;
    sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [{ name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
    E.selected.rot = after; drawSelection();
  };
  $("#pRotBtn").onclick = rotateSelected; $("#pDelBtn").onclick = deleteSelected;
}

// Selection filter (panel_*selection_filter_base): per editor, a category is enabled unless set false.
export const FILTER_KEYS: Record<"sch" | "pcb", string[]> = { sch: ["symbols", "pins", "wires", "labels", "graphics", "images", "text", "other", "ruleAreas"], pcb: ["footprints", "text", "tracks", "vias", "pads", "graphics", "zones", "keepouts", "dimensions", "gridItems", "points", "other"] };

// Remembered per editor (kui.filter.<editor>), as KiCad keeps it in the project's local settings.
export const filters = (() => { const out: Record<string, Record<string, boolean>> = {}; for (const ed of ["sch", "pcb"]) { try { const v = JSON.parse(localStorage.getItem("kui.filter." + ed) || "null"); if (v && typeof v === "object") out[ed] = v; } catch (e) { /* no storage */ } } return out; })();

export function selFilter() { return filters[editorId()] || {}; }

export function setFilter(key: string, on?: unknown) {
  const ed = editorId(); const f = filters[ed] = filters[ed] || {};
  if (key === "all") { for (const k of FILTER_KEYS[ed]) f[k] = !!on; }
  else if (key.startsWith("only:")) { for (const k of FILTER_KEYS[ed]) f[k] = k === key.slice(5); }   // the right-click "Only …" entry
  else f[key] = !!on;
  try { localStorage.setItem("kui.filter." + ed, JSON.stringify(f)); } catch (e) { /* no storage */ }
  store.set({ filter: Object.assign({}, f) });
  E.selected = null; drawSelection(); renderProps();
}

// ---- multi-selection: box / lasso, group move, group delete ----
export function hitAny(mm: [number, number]): { id: string; kind: string; fp?: ItemSummary | SheetEntry; item?: KItem } | null {
  const fp = nearestFootprint(mm[0], mm[1], 5 / Math.max(1, E.zoom * 0.6)); if (fp) return { id: fp.id, kind: isSch() ? "symbol" : "footprint", fp };
  const m = activeModule(); const pick = m && m._ && (m._.pickNonSymbol as ((ctx: ToolCtx, mm: [number, number]) => KItem | null) | undefined);
  if (pick) { try { const it = pick(toolCtx(), mm); if (it && filterAllows(it.kind, it)) return { id: it.id, kind: it.kind, item: it }; } catch (e) { /* module without pick */ } }
  return null;
}

export function itemBoxCentre(it: KItem) { const b = it.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; }

export function pointInPoly(p: readonly number[], poly: readonly (readonly number[])[]) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }

/** The box / lasso is a SELECTION_AREA painted on the canvas (overlays.ts). */
export function drawBoxSel() { requestRepaint(); }

// KiCad: dragging left-to-right selects what the box encloses, right-to-left what it touches; the lasso takes what it contains.
/** PCB_SELECTION_TOOL::FilterCollectorForHierarchy: with a board group entered, items outside it are dropped (in place). */
export function scopeToEnteredGroup(items: KItem[]): void {
  const pcb = !isSch() && CollabTools.pcb; if (!pcb || !pcb.withinEnteredGroup || !E.kdoc) return;
  let keep: Set<string>; try { keep = new Set(pcb.withinEnteredGroup(E.kdoc, items.map((it) => it.id))); } catch (e) { console.warn(e); return; }
  for (let i = items.length - 1; i >= 0; i--) if (!keep.has(items[i].id)) items.splice(i, 1);
}
export function finishBoxSel(ev: { clientX: number; clientY: number }) {
  const b: BoxSel | null = E.boxSel; E.boxSel = null; requestRepaint(); if (!b || !E.kdoc) return;
  const moved = Math.hypot(ev.clientX - b.startClient[0], ev.clientY - b.startClient[1]);
  if (moved < 4) {
    if (b.clickHighlight) { const pm = CollabTools.pcb as unknown as { highlightNetAt?: (c: unknown, at: number[]) => unknown } | undefined; if (pm && pm.highlightNetAt) { pm.highlightNetAt(toolCtx(), b.start); requestRender(); } }
    return;
  }
  const picked: KItem[] = [];
  // SelectMultiple: a line is taken by the box as a whole, or (contained mode) by one dangling end inside it
  const schM = isSch() ? (CollabTools.sch as unknown as { boxLineFlags?: (d: KDoc, it: KItem, box: [number, number, number, number], contained: boolean) => "whole" | 0 | 1 | null | undefined; putSelEnd?: (id: string, end: 0 | 1 | null) => void; state?: { selEnds?: Map<string, number> | null } }) : null;
  const partEnds = new Map<string, 0 | 1>();
  if (b.lasso) { for (const it of E.kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind, it)) continue; const c = itemBoxCentre(it); if (c && pointInPoly(c, b.pts)) picked.push(it); } }
  else {
    const x0 = Math.min(b.start[0], b.cur[0]), x1 = Math.max(b.start[0], b.cur[0]), y0 = Math.min(b.start[1], b.cur[1]), y1 = Math.max(b.start[1], b.cur[1]), enclose = b.cur[0] >= b.start[0];
    const board = !isSch();
    for (const it of E.kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind, it)) continue; const bb = it.bbox;
      if (board && !KiCadCanvas.itemVisible(it, E.hiddenLayers)) continue;                 // nothing of it is shown: not selectable
      const lf = schM && schM.boxLineFlags && (it.kind === "wire" || it.kind === "bus" || it.kind === "polyline") ? schM.boxLineFlags(E.kdoc, it, [x0, y0, x1, y1], enclose) : undefined;
      if (lf !== undefined) { if (lf !== null) { if (lf !== "whole") partEnds.set(it.id, lf); picked.push(it); } continue; }   // a SCH_LINE by its own segment
      const inside = bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1; let touches = bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1;
      // a board item counts by its own shape (a diagonal track by its copper, a zone by its outline), a footprint by its box
      if (touches && !inside && board && it.kind !== "footprint" && it.geom && it.geom.length) touches = KiCadCanvas.itemTouchesRect(it, x0, y0, x1, y1, E.hiddenLayers);
      if (enclose ? inside : touches) picked.push(it); }
  }
  scopeToEnteredGroup(picked);
  const pcbSel = CollabTools.pcb && CollabTools.pcb.state && CollabTools.pcb.state.sel;
  if (schM && schM.state && !b.add) schM.state.selEnds = null;
  if (!b.add) { E.selPins = []; E.selected = null; E.selection.clear(); if (pcbSel) pcbSel.clear(); if (CollabTools.pcb && CollabTools.pcb.state) CollabTools.pcb.state.padSel = null; }   // a box replaces the board module's own pick too
  // SelectMultiple(area, subtractive, exclusive_or): Ctrl+Shift takes the boxed items out, Ctrl toggles them, Shift adds;
  // on the board Alt only drops the kept selection (m_drag_additive), so Alt+Ctrl+Shift takes out of nothing
  if (b.mode === "remove" || b.mode === "toggle") {
    if (E.selected) E.selection.add(E.selected.id);
    for (const it of picked) { const was = E.selection.has(it.id) || (pcbSel && pcbSel.has(it.id)); E.selection.delete(it.id); if (pcbSel) pcbSel.delete(it.id); if (b.mode === "toggle" && !was) E.selection.add(it.id); }
    if (E.selected && !E.selection.has(E.selected.id)) E.selected = null;
    if (!E.selected) { for (const id of E.selection) { const f = E.items.find((x: ItemSummary) => x.id === id); if (f) { E.selected = f; break; } } }
    drawSelection(); renderProps(); renderObjects(); requestRender();
    setStatusBar({ message: "" });
    return;
  }
  for (const it of picked) { const had = E.selection.has(it.id); E.selection.add(it.id); if (schM && schM.putSelEnd && (!had || !partEnds.has(it.id))) schM.putSelEnd(it.id, partEnds.has(it.id) ? partEnds.get(it.id)! : null); }
  // FilterCollectorForHierarchy: a boxed member of a group or generator (a tuning pattern's meanders) brings its
  // top-level parent, which this selection holds as the parent's id with all its members
  if (!isSch()) E.selection = groupExpand(E.selection);
  const prim = picked.find((it) => it.kind === "symbol" || it.kind === "footprint");
  E.selected = prim ? (E.items.find((f: ItemSummary) => f.id === prim.id) || E.selected) : (b.add ? E.selected : null);
  if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null);
  drawSelection(); renderProps(); renderObjects();
  setStatusBar({ message: E.selection.size ? `${E.selection.size} item${E.selection.size === 1 ? "" : "s"} selected` : "" });
}
