// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { drawComments } from "./comments";
import { loadBase } from "./doc";
import { $, NS } from "./dom";
import { breakFollow, peerName, renderPeers } from "./peers";
import { drawSelection, selectedSet } from "./selection";
import { E } from "./state";
import { activeModule, toolCtx } from "./tools";
import { toast } from "./util";
// ================================================================ EDITOR
export const stage = $("#stage"), world = $("#world"), base = $("#base"), overlay = $("#overlay");

export const peersG = $("#peersG"), selG = $("#selG"), dragG = $("#dragG"), cmtG = $("#cmtG");

export const cmtPanel = $("#cmtPanel");




              // SVG viewBox units per mm (board plots: 1; schematic plots differ)
export const mmW = () => E.vb[2] / E.vbPerMm, mmH = () => E.vb[3] / E.vbPerMm, mmX0 = () => E.vb[0] / E.vbPerMm, mmY0 = () => E.vb[1] / E.vbPerMm;



              // hierarchical sheets on a schematic sheet
export const isSch = () => E.DOC_TYPE === "kicad_sch";












// ---- canvas renderer (the document itself, mirrored from the collaboration stream) ----
export const canvas = $("#canvas"), cctx = canvas.getContext("2d");

export function requestRender() { if (E.renderReq || !E.kdoc) return; E.renderReq = requestAnimationFrame(() => { E.renderReq = 0; drawCanvas(); }); }
   // bitmaps decode asynchronously; repaint once they are ready
export function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
}

export function drawCanvas() {
  if (!E.kdoc) return; sizeCanvas();
  const ppm = stage.clientWidth / mmW();
  const view = { ppm, zoom: E.zoom, panX: E.panX, panY: E.panY, x0: mmX0(), y0: mmY0(), dpr: window.devicePixelRatio || 1 };
  KiCadCanvas.render(E.kdoc, cctx, view, Object.assign({ hidden: E.hiddenLayers, grid: E.gridOn ? E.gridPitch : 0, selected: selectedSet(), highlight: E.highlightIds }, E.renderOpts));
  const m = activeModule();
  if (m && m.drawOverlay) { try { cctx.save(); KiCadCanvas.setViewTransform(cctx, view); m.drawOverlay(cctx, view, toolCtx()); } catch (e) { console.warn(e); } finally { cctx.restore(); } }
  if (E.selField) {
    const it = E.kdoc.items.get(E.selField.id); if (!it) { E.selField = null; return; }
    cctx.save(); KiCadCanvas.setViewTransform(cctx, view);
    const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
    cctx.fillStyle = "rgba(102,178,255,0.35)"; cctx.strokeStyle = "#4D7FC4"; cctx.lineWidth = 1.5 * px;
    for (const f of KiCadCanvas.fieldBoxes(it, E.hiddenLayers)) { if (f.name !== E.selField.name) continue; cctx.beginPath(); f.pts.forEach((q, i) => i ? cctx.lineTo(q[0], q[1]) : cctx.moveTo(q[0], q[1])); cctx.closePath(); cctx.fill(); cctx.stroke(); }
    cctx.restore();
  }
}


// ---- view transform ----
export function applyView() {
  world.style.transform = `translate(${E.panX}px, ${E.panY}px) scale(${E.zoom})`;
  store.slice("viewport", { zoom: E.zoom });
  // Everything on the overlay is sized in screen pixels, so a zoom or fit
  // must redraw peers too (they otherwise keep the previous scale until the
  // next presence message).
  drawComments(); drawSelection(); drawPeers(E.peerState);
  requestRender();
}

export function contentBoxMm() {
  if (E.kdoc && !isSch()) { const b = E.kdoc.bbox; return [b[0], b[1], Math.max(1, b[2] - b[0]), Math.max(1, b[3] - b[1])]; }
  if (isSch()) return [mmX0(), mmY0(), mmW(), mmH()];
  // Union of the board outline and copper: what a person means by "the board".
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const hex of ["D0D2CD", "C83434", "4D7FC4"]) {
    for (const el of (E.layers[hex] || { nodes: [] }).nodes) {
      if (typeof el.getBBox !== "function") continue;
      let b; try { b = el.getBBox(); } catch { continue; }
      if (!b.width && !b.height) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); n++;
    }
  }
  if (!n || x1 - x0 < 1 || y1 - y0 < 1) return [mmX0(), mmY0(), mmW(), mmH()];
  return [x0 / E.vbPerMm, y0 / E.vbPerMm, (x1 - x0) / E.vbPerMm, (y1 - y0) / E.vbPerMm];
}

export function fitView() { fitBox(contentBoxMm(), isSch() ? 0.97 : 0.85); }

export function fitBox(box, margin) {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) { setTimeout(fitView, 100); return; }
  world.style.width = sw + "px";
  const ppm = sw / mmW();                       // px per mm at zoom 1
  const [bx, by, bw, bh] = box;
  E.zoom = Math.min(400, Math.max(0.2, Math.min(sw / (bw * ppm), sh / (bh * ppm)) * (margin || 1)));
  E.panX = sw / 2 - ((bx - mmX0()) + bw / 2) * ppm * E.zoom;
  E.panY = sh / 2 - ((by - mmY0()) + bh / 2) * ppm * E.zoom;
  E.lastStageW = sw;   // the resize observer must not rescale pans computed at this width
  applyView();
}

export function zoomBy(factor, cx, cy) {
  E.viewTouched = true;
  if (cx === undefined) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
  const next = Math.min(40, Math.max(0.2, E.zoom * factor));
  E.panX = cx - (cx - E.panX) * (next / E.zoom);
  E.panY = cy - (cy - E.panY) * (next / E.zoom);
  E.zoom = next; breakFollow(); applyView();
}


export function worldMm(ev) {
  const r = world.getBoundingClientRect();
  return [mmX0() + ((ev.clientX - r.left) / r.width) * mmW(), mmY0() + ((ev.clientY - r.top) / r.height) * mmH()];
}

export function pxPerMm() { const r = world.getBoundingClientRect(); return r.width > 0 ? r.width / mmW() : 4; }

export function visibleRectNm() {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (wr.width <= 0) return null;
  const x = mmX0() + ((sr.left - wr.left) / wr.width) * mmW(), y = mmY0() + ((sr.top - wr.top) / wr.height) * mmH();
  const w = (sr.width / wr.width) * mmW(), h = (sr.height / wr.height) * mmH();
  return [x, y, w, h].map((v) => Math.round(v * E.IU));
}


// ---- overlay drawing ----
export function svgText(x, y, size, color, text) {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y); t.setAttribute("fill", color); t.setAttribute("font-size", size);
  t.setAttribute("font-family", "system-ui, sans-serif"); t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "#001023"); t.setAttribute("stroke-width", size / 4); t.textContent = text;
  return t;
}

export function drawPeers(peers) {
  peersG.replaceChildren();
  const s = pxPerMm(), mm = (nm) => nm / E.IU;
  for (const [cid, p] of Object.entries(peers)) {
    const st = p.state || {}, color = (p.user && p.user.color) || "#4477ee", name = peerName(p);
    for (const g of st.ghost || []) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(g[0])); line.setAttribute("y1", mm(g[1])); line.setAttribute("x2", mm(g[2])); line.setAttribute("y2", mm(g[3]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", Math.max(mm(g[4] || 0), 2 / s)); line.setAttribute("stroke-linecap", "round");
      peersG.appendChild(line);
    }
    for (const b of st.boxes || []) {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mm(b[0])); rect.setAttribute("y", mm(b[1])); rect.setAttribute("width", mm(b[2])); rect.setAttribute("height", mm(b[3]));
      rect.setAttribute("fill", color); rect.setAttribute("fill-opacity", "0.18"); rect.setAttribute("stroke", color); rect.setAttribute("stroke-width", 3 / s);
      peersG.appendChild(rect);
    }
    if (Array.isArray(st.cursor)) {
      const x = mm(st.cursor[0]), y = mm(st.cursor[1]), t = 14 / s;
      const tri = document.createElementNS(NS, "path");
      tri.setAttribute("d", `M ${x} ${y} L ${x + 0.38 * t} ${y + t} L ${x + t} ${y + 0.38 * t} Z`);
      tri.setAttribute("fill", color); tri.setAttribute("stroke", "white"); tri.setAttribute("stroke-width", 1 / s);
      peersG.appendChild(tri);
      const label = svgText(x + 1.1 * t, y + 1.7 * t, 12 / s, color, E.followPeer === cid ? name + " ✔" : name);
      label.style.pointerEvents = "auto"; label.style.cursor = "pointer";
      label.addEventListener("click", (ev) => { ev.stopPropagation(); E.followPeer = E.followPeer === cid ? null : cid; toast(E.followPeer ? `Following ${name}` : "Stopped following"); renderPeers(); });
      peersG.appendChild(label);
    }
  }
}

export function scheduleRenderRefresh() {
  E.renderDirtySince = Date.now();
  if (E.renderTimer) return;
  E.renderTimer = setInterval(async () => {
    if (Date.now() - E.renderDirtySince > 120000 || state.view !== "editor") { clearInterval(E.renderTimer); E.renderTimer = 0; return; }
    await loadBase(false);
  }, 8000);
}
