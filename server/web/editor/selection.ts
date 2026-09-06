// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setStatusBar, store } from "./appstore";
import { fpName, renderObjects } from "./doc";
import { $, NS } from "./dom";
import { sendOp } from "./net";
import { editorId } from "./panes";
import { E } from "./state";
import { activeModule, deleteSelected, moveOp, rotateSelected, toolCtx } from "./tools";
import { esc } from "./util";
import { dragG, isSch, pxPerMm, requestRender, selG, svgText } from "./view";
/** Board groups: a member drags/deletes with its whole group (KiCad's default). */
export function groupExpand(ids) { const m = CollabTools.pcb; if (isSch() || !E.kdoc || !m || !m.expandGroups) return new Set(ids); try { return new Set(m.expandGroups(E.kdoc, [...ids])); } catch (e) { return new Set(ids); } }




export function selectedSet() { const s = new Set(E.selection); if (E.selected) s.add(E.selected.id); return s.size ? s : null; }

   // a selected symbol / footprint field {id, name} and its drag {id, name, startMm, orig, moved}
export function clearSelection() { E.selection.clear(); E.selected = null; E.selField = null; if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null); }

/** World-space delta → the field's own coordinate frame (schematic fields are absolute; footprint fields ride the footprint's rotation/scale). */
export function fieldLocalDelta(item, dx, dy) {
  if (isSch() || item.kind !== "footprint") return [dx, dy];
  const [, , frot] = KiCadCanvas.atOf(item.node); const tr = KiCadCanvas.kid(item.node, "transform"), sc = tr && KiCadCanvas.kid(tr, "scale");
  const sx = sc ? KiCadCanvas.num(sc[1], 1) || 1 : 1, sy = sc ? KiCadCanvas.num(sc[2], 1) || 1 : 1;
  const r = frot * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  return [(dx * c - dy * sn) / sx, (dx * sn + dy * c) / sy];
}

export function fieldOf(item, name) { return window.KDialogs && KDialogs._ ? KDialogs._.fieldNode(item.node, name) : null; }

// KiCad's selection filter categories for an item kind.
export function filterKey(kind) {
  if (isSch()) return kind === "symbol" ? "symbols" : (kind === "wire" || kind === "bus") ? "wires" : /label|netclass_flag/.test(kind) ? "labels" : kind === "image" ? "images" : (kind === "text" || kind === "text_box") ? "text" : /rectangle|circle|arc|polyline|bezier|rule_area/.test(kind) ? "graphics" : "other";
  return kind === "footprint" ? "footprints" : (kind === "segment" || kind === "arc") ? "tracks" : kind === "via" ? "vias" : kind === "zone" ? "zones" : kind === "dimension" ? "dimensions" : (kind === "gr_text" || kind === "gr_text_box") ? "text" : /^gr_|image|table/.test(kind) ? "graphics" : "other";
}

export function filterAllows(kind) { const f = selFilter(); const k = filterKey(kind); return f[k] !== false; }

/** Hit-test options: hidden layers never count and the active layer's side is preferred (KiCad's candidate rules). */
export function hitOpts() { return { hidden: E.hiddenLayers, side: !isSch() && E.activeLayer && /^B\./.test(E.activeLayer) ? "B" : "F" }; }

   // {id, onGeom} of the latest nearestFootprint() call
export function nearestFootprint(x, y, radiusMm) {
  if (E.kdoc) { const f = selFilter(); if ((isSch() && f.symbols === false) || (!isSch() && f.footprints === false)) return null; E.lastFpHit = KiCadCanvas.hitTestDetail(E.kdoc, x, y, Math.min(radiusMm, 3 / Math.max(1, pxPerMm())) /* ~3 device px, KiCad's hit tolerance */, hitOpts()); const id = E.lastFpHit ? E.lastFpHit.id : null; return id ? E.items.find((f2) => f2.id === id) || null : null; }
  let best = null, bestD = radiusMm;
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
export function renderPropsInto(el) {
  if (!el) return;
  const $ = (sel) => el.querySelector(sel);
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
export const FILTER_KEYS = { sch: ["symbols", "pins", "wires", "labels", "graphics", "images", "text", "other"], pcb: ["footprints", "text", "tracks", "vias", "pads", "graphics", "zones", "dimensions", "other"] };

export const filters = {};

export function selFilter() { return filters[editorId()] || {}; }

export function setFilter(key, on) {
  const ed = editorId(); const f = filters[ed] = filters[ed] || {};
  if (key === "all") { for (const k of FILTER_KEYS[ed]) f[k] = !!on; } else f[key] = !!on;
  store.set({ filter: Object.assign({}, f) });
  E.selected = null; drawSelection(); renderProps();
}

// ---- multi-selection: box / lasso, group move, group delete ----
export function hitAny(mm) {
  const fp = nearestFootprint(mm[0], mm[1], 5 / Math.max(1, E.zoom * 0.6)); if (fp) return { id: fp.id, kind: isSch() ? "symbol" : "footprint", fp };
  const m = activeModule(); const pick = m && m._ && m._.pickNonSymbol;
  if (pick) { try { const it = pick(toolCtx(), mm); if (it) return { id: it.id, kind: it.kind, item: it }; } catch (e) { /* module without pick */ } }
  return null;
}

export function itemBoxCentre(it) { const b = it.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; }

export function pointInPoly(p, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }

export function drawBoxSel() {
  dragG.replaceChildren(); if (!E.boxSel) return;
  const s = pxPerMm();
  if (E.boxSel.lasso) {
    const p = document.createElementNS(NS, "polygon"); p.setAttribute("points", E.boxSel.pts.map((q) => q.join(",")).join(" "));
    p.setAttribute("fill", "#4D7FC422"); p.setAttribute("stroke", "#4D7FC4"); p.setAttribute("stroke-width", 1 / s); p.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); dragG.appendChild(p);
  } else {
    const a = E.boxSel.start, b = E.boxSel.cur, ltr = b[0] >= a[0];
    const r = document.createElementNS(NS, "rect"); r.setAttribute("x", Math.min(a[0], b[0])); r.setAttribute("y", Math.min(a[1], b[1])); r.setAttribute("width", Math.abs(b[0] - a[0])); r.setAttribute("height", Math.abs(b[1] - a[1]));
    r.setAttribute("fill", ltr ? "#4D7FC422" : "#00960022"); r.setAttribute("stroke", ltr ? "#4D7FC4" : "#009600"); r.setAttribute("stroke-width", 1 / s); if (!ltr) r.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); dragG.appendChild(r);
  }
}

// KiCad: dragging left-to-right selects what the box encloses, right-to-left what it touches; the lasso takes what it contains.
export function finishBoxSel(ev) {
  const b = E.boxSel; E.boxSel = null; dragG.replaceChildren(); if (!b || !E.kdoc) return;
  const moved = Math.hypot(ev.clientX - b.startClient[0], ev.clientY - b.startClient[1]);
  if (moved < 4) return;
  const picked = [];
  if (b.lasso) { for (const it of E.kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind)) continue; const c = itemBoxCentre(it); if (c && pointInPoly(c, b.pts)) picked.push(it); } }
  else {
    const x0 = Math.min(b.start[0], b.cur[0]), x1 = Math.max(b.start[0], b.cur[0]), y0 = Math.min(b.start[1], b.cur[1]), y1 = Math.max(b.start[1], b.cur[1]), enclose = b.cur[0] >= b.start[0];
    for (const it of E.kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind)) continue; const bb = it.bbox;
      const inside = bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1, touches = bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1;
      if (enclose ? inside : touches) picked.push(it); }
  }
  if (!b.add) E.selection.clear();
  for (const it of picked) E.selection.add(it.id);
  const prim = picked.find((it) => it.kind === "symbol" || it.kind === "footprint");
  E.selected = prim ? (E.items.find((f) => f.id === prim.id) || E.selected) : (b.add ? E.selected : null);
  if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null);
  drawSelection(); renderProps(); renderObjects();
  setStatusBar({ message: E.selection.size ? `${E.selection.size} item${E.selection.size === 1 ? "" : "s"} selected` : "" });
}
