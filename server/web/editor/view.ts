// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { drawComments } from "./comments";
import { loadBase } from "./doc";
import { $, NS } from "./dom";
import { drawHover } from "./gestures";
import { anchorMm, breakFollow, peerName, renderPeers, sendPresence } from "./peers";
import { drawSelection, selectedSet } from "./selection";
import { E } from "./state";
import { paintDocument, stats as paintStats } from "./paint";
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

/** Repaint everything on the next frame (the document pass included). */
export function requestRender() { E.renderFull = true; requestRepaint(); }
E.paintStats = paintStats;   // frame counters (full passes, strip pans, blits, scaled zoom frames) for the perf tests
/** Repaint on the next frame, re-rendering the document only when it, the options or the view changed (paint.ts). */
export function requestRepaint() { if (E.renderReq || !E.kdoc) return; E.renderReq = requestAnimationFrame(() => { E.renderReq = 0; drawCanvas(); }); }
   // bitmaps decode asynchronously; repaint once they are ready
export function sizeCanvas() {
  // the backing store is the stage in device pixels exactly (E.canvasPx, from the device-pixel-content-box
  // observer in gestures.ts, where the browser has one): anything else is resampled and blurs every stroke
  const dpr = window.devicePixelRatio || 1, px = E.canvasPx, w0 = Math.round(stage.clientWidth * dpr), h0 = Math.round(stage.clientHeight * dpr);
  const exact = px && Math.abs(px[0] - w0) <= 2 && Math.abs(px[1] - h0) <= 2;   // a stale or unscaled report is not trusted
  const w = exact ? px[0] : w0, h = exact ? px[1] : h0;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

export function drawCanvas() {
  if (!E.kdoc) return; sizeCanvas();
  const ppm = stage.clientWidth / mmW();
  const view = { ppm, zoom: E.zoom, panX: E.panX, panY: E.panY, x0: mmX0(), y0: mmY0(), dpr: window.devicePixelRatio || 1 };
  const ghosts = E.peerGhosts || [];
  const skip = ghosts.length ? new Set(ghosts.flatMap((g) => [...g.ids])) : null;
  const force = E.renderFull !== false; E.renderFull = false;
  paintDocument(E.kdoc, cctx, view, Object.assign({ hidden: E.hiddenLayers, grid: E.gridOn ? E.gridPitch : 0, selected: selectedSet(), highlight: E.highlightIds, skip: skip || undefined }, E.renderOpts), force, !!E.zoomAnim, requestRender);
  // A peer's items mid-drag: drawn where the peer has them (presence `at`), translucent, over everything else.
  if (ghosts.length) {
    const off = E.ghostCanvas || (E.ghostCanvas = document.createElement("canvas"));
    if (off.width !== canvas.width || off.height !== canvas.height) { off.width = canvas.width; off.height = canvas.height; }
    const octx = off.getContext("2d"); const sc = view.ppm * view.zoom;
    for (const g of ghosts) {
      if (g.hideOnly) continue;   // a wire whose stretched shape the overlay draws instead
      octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, off.width, off.height);
      KiCadCanvas.render(E.kdoc, octx, Object.assign({}, view, { panX: view.panX + g.dx * sc, panY: view.panY + g.dy * sc }),
        Object.assign({}, E.renderOpts, { hidden: E.hiddenLayers, grid: 0, frame: false, background: false, ids: g.ids, markers: null, ratsnest: null, highlight: null, selected: null }));
      cctx.setTransform(1, 0, 0, 1, 0, 0); cctx.globalAlpha = 0.6; cctx.drawImage(off, 0, 0); cctx.globalAlpha = 1;
    }
  }
  const m = activeModule();
  if (m && m.drawOverlay) { try { cctx.save(); KiCadCanvas.setViewTransform(cctx, view); m.drawOverlay(cctx, view, toolCtx()); } catch (e) { console.warn(e); } finally { cctx.restore(); } }
  drawHover(cctx, view);
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
  requestRepaint();
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
  if (E.zoomAnim) { cancelAnimationFrame(E.zoomAnim.raf); E.zoomAnim = null; }
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) { setTimeout(fitView, 100); return; }
  world.style.width = sw + "px";
  const ppm = sw / mmW();                       // px per mm at zoom 1
  const [bx, by, bw, bh] = box;
  // a fit may go below the manual zoom-out limit (a very large board still has to fit), never above the zoom-in one
  E.zoom = Math.min(zoomLimits()[1], Math.max(1e-4, Math.min(sw / (bw * ppm), sh / (bh * ppm)) * (margin || 1)));
  E.panX = sw / 2 - ((bx - mmX0()) + bw / 2) * ppm * E.zoom;
  E.panY = sh / 2 - ((by - mmY0()) + bh / 2) * ppm * E.zoom;
  E.lastStageW = sw; E.lastStageH = sh;   // the resize observer must not rescale pans computed at this size
  applyView();
}

/** The zoom range as E.zoom values: KiCad's zoom-factor range for the editor (include/zoom_defines.h, 0.05–100 / 0.13–300). */
export function zoomLimits() {
  const ppm = stage.clientWidth / mmW(); if (!(ppm > 0)) return [0.2, 400];
  const z1 = Number(KiCadCanvas.PX_PER_MM_ZOOM1) || 3.58;   // css px per mm at KiCad zoom factor 1
  const [lo, hi] = isSch() ? [0.05, 100] : [0.13, 300];
  return [(lo * z1) / ppm, (hi * z1) / ppm];
}

export function zoomBy(factor, cx, cy) {
  E.viewTouched = true;
  if (cx === undefined) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
  const [lo, hi] = zoomLimits();
  const next = Math.min(Math.max(hi, E.zoom), Math.max(Math.min(lo, E.zoom), E.zoom * factor));   // a view outside the range (a fit) can still zoom back in
  E.panX = cx - (cx - E.panX) * (next / E.zoom);
  E.panY = cy - (cy - E.panY) * (next / E.zoom);
  E.zoom = next; breakFollow(); applyView();
  // A peer following us reads `viewport` out of presence; without a send here a wheel zoom
  // (or a pan, below) never reaches them and "follow" sits a screen behind.
  sendPresence(null);
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

/** Our own boxes [x, y, w, h] (internal units) of the items a peer selected by id. */
function peerBoxesOf(ids) {
  const out = [], board = !isSch();
  for (const id of ids) {
    const it = E.kdoc.items.get(id); if (!it) continue;
    const b = it.bbox, box = board ? KiCadCanvas.boardItemBox(it, E.IU) : b ? [b[0] * E.IU, b[1] * E.IU, (b[2] - b[0]) * E.IU, (b[3] - b[1]) * E.IU] : null;
    if (box) out.push(box);
  }
  return out;
}

export function drawPeers(peers) {
  peersG.replaceChildren();
  const s = pxPerMm(), mm = (nm) => nm / E.IU;
  const ghosts = [];
  for (const [cid, p] of Object.entries(peers)) {
    const st = p.state || {}, color = (p.user && p.user.color) || "#4477ee", name = peerName(p);
    // Items the peer is dragging: `at[i]` is where they hold selection[i]; a displacement from our copy's own
    // anchor is a live drag, drawn by drawCanvas as a ghost (one render per distinct offset).
    if (E.kdoc && Array.isArray(st.at) && Array.isArray(st.selection)) {
      const byOff = new Map();
      for (let i = 0; i < st.selection.length && i < st.at.length; i++) {
        const a = st.at[i], it = E.kdoc.items.get(st.selection[i]); if (!a || !it) continue;
        const mine = anchorMm(it); if (!mine) continue;
        const dx = a[0] / E.IU - mine[0], dy = a[1] / E.IU - mine[1];
        if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) continue;
        const key = dx.toFixed(4) + "," + dy.toFixed(4); let g = byOff.get(key); if (!g) byOff.set(key, g = { ids: new Set(), dx, dy });
        g.ids.add(it.id);
      }
      for (const g of byOff.values()) ghosts.push(g);
    }
    // Stretched wires of a schematic drag (uuid, x1, y1, x2, y2, width, layer): the exact geometry, in place of ours.
    for (const dl of st.dragLines || []) {
      if (!Array.isArray(dl) || dl.length < 5) continue;
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(dl[1])); line.setAttribute("y1", mm(dl[2])); line.setAttribute("x2", mm(dl[3])); line.setAttribute("y2", mm(dl[4]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.7"); line.setAttribute("stroke-width", Math.max(mm(dl[5] || 0), 2 / s)); line.setAttribute("stroke-linecap", "round");
      peersG.appendChild(line);
      if (E.kdoc && E.kdoc.items.has(dl[0])) ghosts.push({ ids: new Set([dl[0]]), dx: 0, dy: 0, hideOnly: true });
    }
    for (const g of st.ghost || []) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(g[0])); line.setAttribute("y1", mm(g[1])); line.setAttribute("x2", mm(g[2])); line.setAttribute("y2", mm(g[3]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", Math.max(mm(g[4] || 0), 2 / s)); line.setAttribute("stroke-linecap", "round");
      peersG.appendChild(line);
    }
    // Same rules as the desktop's COLLAB_CURSOR_ITEM: an outline in the peer colour and no
    // fill, one union box for a multi-selection, and nothing around the items a drag pulled
    // along (attached wires, riders -- listed in `dragAdded`), only what the peer picked.
    const dragAdded = new Set(st.dragAdded || []), sel = st.selection || [];
    let own = (st.boxes || []).filter((b, i) => !(dragAdded.size && dragAdded.has(sel[i])));
    // a peer that names what it selected without boxes (the web at rest): outline our own copy of those items
    if (!st.boxes && sel.length && E.kdoc) own = peerBoxesOf(sel);
    if (own.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of own) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]); }
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mm(x0)); rect.setAttribute("y", mm(y0)); rect.setAttribute("width", mm(x1 - x0)); rect.setAttribute("height", mm(y1 - y0));
      rect.setAttribute("fill", "none"); rect.setAttribute("stroke", color); rect.setAttribute("stroke-opacity", "0.9"); rect.setAttribute("stroke-width", 1.5 / s);
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
  const had = (E.peerGhosts || []).length; E.peerGhosts = ghosts;
  if (had || ghosts.length) requestRender();
}

export function scheduleRenderRefresh() {
  E.renderDirtySince = Date.now();
  if (E.renderTimer) return;
  E.renderTimer = setInterval(async () => {
    if (Date.now() - E.renderDirtySince > 120000 || state.view !== "editor") { clearInterval(E.renderTimer); E.renderTimer = 0; return; }
    await loadBase(false);
  }, 8000);
}
