// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { updateMsgPanel } from "./msgpanel";
import { state, store } from "./appstore";
import { refreshCrosshair } from "./crosshair";
import { drawComments } from "./comments";
import { loadBase } from "./doc";
import { $, NS } from "./dom";
import { drawHover } from "./gestures";
import { anchorMm, breakFollow, peerName, renderPeers, sendPresence } from "./peers";
import { drawSelection, selectedSet } from "./selection";
import { E } from "./state";
import { paintConfig, paintDocument, settledFrame, stats as paintStats } from "./paint";
import { activeModule, toolCtx } from "./tools";
import { drawAppOverlays } from "./overlays";
import { toast } from "./util";
import type { PeerEntry, PeerGhost } from "./types";
// ================================================================ EDITOR
export const stage = $("#stage"), world = $("#world"), base = $("#base"), overlay = $("#overlay");

export const peersG = $<SVGGElement>("#peersG"), selG = $<SVGGElement>("#selG"), dragG = $<SVGGElement>("#dragG"), cmtG = $<SVGGElement>("#cmtG");

export const cmtPanel = $("#cmtPanel");




              // SVG viewBox units per mm (board plots: 1; schematic plots differ)
export const mmW = () => E.vb[2] / E.vbPerMm, mmH = () => E.vb[3] / E.vbPerMm, mmX0 = () => E.vb[0] / E.vbPerMm, mmY0 = () => E.vb[1] / E.vbPerMm;



              // hierarchical sheets on a schematic sheet
export const isSch = () => E.DOC_TYPE === "kicad_sch";












// ---- canvas renderer (the document itself, mirrored from the collaboration stream) ----
export const canvas = $<HTMLCanvasElement>("#canvas"), cctx = canvas.getContext("2d")!;

/** Repaint everything on the next frame (the document pass included). */
export function requestRender() { E.renderFull = true; requestRepaint(); }
/** The last frame of a wheel zoom: the view changed, nothing else did, so the zoom levels (paint.ts) are kept. */
export function requestZoomEnd() { if (E.renderFull !== true && E.renderFull !== "rest") E.renderFull = "zoomEnd"; requestRepaint(); }
/** The full pass once the view rests after a zoom or pan stand-in (the zoom levels are kept). */
function requestRestRender() { if (E.renderFull !== true) E.renderFull = "rest"; requestRepaint(); }
E.paintStats = paintStats;   // frame counters (full passes, strip pans, blits, scaled zoom frames) for the perf tests
E.paintConfig = paintConfig;   // paint tuning the perf tests flip (paint.ts)
/** Repaint on the next frame, re-rendering the document only when it, the options or the view changed (paint.ts). */
export function requestRepaint() { if (E.renderReq || !E.kdoc) return; E.renderReq = requestAnimationFrame(() => { E.renderReq = 0; drawCanvas(); }); }
E.requestRepaint = requestRepaint;
   // bitmaps decode asynchronously; repaint once they are ready
export function sizeCanvas() {
  // the backing store is the stage in device pixels exactly (E.canvasPx, from the device-pixel-content-box
  // observer in gestures.ts, where the browser has one): anything else is resampled and blurs every stroke
  const dpr = window.devicePixelRatio || 1, px = E.canvasPx, w0 = Math.round(stage.clientWidth * dpr), h0 = Math.round(stage.clientHeight * dpr);
  const exact = px && Math.abs(px[0] - w0) <= 2 && Math.abs(px[1] - h0) <= 2;   // a stale or unscaled report is not trusted
  const w = exact ? px[0] : w0, h = exact ? px[1] : h0;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

/** The app's selection plus the board module's own picks (tracks, vias, graphics, zones): all repainted brightened. */
function boardSelected(): Set<string> | null {
  const base = selectedSet(); const pcb = CollabTools.pcb && (CollabTools.pcb.state as unknown as { sel?: Set<string>; padSel?: string | null });
  if (isSch()) {
    // the schematic module's own selection (wires, labels, junctions …) and what it is dragging get the same
    // selection shadow as the host's symbols
    const S = CollabTools.sch && (CollabTools.sch.state as unknown as { sel?: string | null; drag?: { items?: { item?: { id?: string } }[] } | null });
    const extra: string[] = []; if (S && S.sel) extra.push(S.sel);
    // a field or pins selected on their own: that part of the symbol alone ("id#field:Name", "id#pin:N")
    if (E.selField) extra.push(E.selField.id + "#field:" + E.selField.name);
    for (const p of (E.selPins || []) as { id: string; number: string }[]) extra.push(p.id + "#pin:" + p.number);
    if (S && S.drag && S.drag.items) for (const e of S.drag.items) if (e && e.item && e.item.id) extra.push(e.item.id);
    if (!extra.length && !base) return base;
    const out = new Set<string>(base || []); for (const id of extra) out.add(id);
    // a line selected by one end ("id#end:N", STARTPOINT / ENDPOINT): the painter squares its other end
    const keys = (CollabTools.sch as unknown as { selEndKeys?: (ids: Iterable<string>) => string[] }).selEndKeys;
    if (keys) for (const k of keys([...out])) out.add(k);
    return out;
  }
  if (!pcb || ((!pcb.sel || !pcb.sel.size) && !pcb.padSel)) return base;
  const out = new Set<string>(base || []); if (pcb.sel) for (const id of pcb.sel) out.add(id); if (pcb.padSel) out.add(pcb.padSel);
  const more = CollabTools.pcb && CollabTools.pcb.selectedPadKeys ? CollabTools.pcb.selectedPadKeys() : []; for (const k of more) out.add(k);
  return out;
}
/** Paint a frame now with the whole picture in #canvas itself (for a reader of its pixels: a zoom frame may otherwise leave it blank over a plate). */
export function drawCanvasSettled() { if (E.kdoc) settledFrame(drawCanvas); }
E.drawCanvasSettled = drawCanvasSettled;
/**
 * What the schematic painter needs from the tools besides the selection: the dangling local labels (a selected
 * one shows no anchor) and the items moved whole (their fields show no anchor, SCH_PAINTER's parentMoving).
 */
function schPaintState(selected: Set<string> | null): { dangling?: Set<string>; moving?: Set<string> } {
  if (!isSch() || !E.kdoc || !CollabTools.sch) return {};
  const tools = CollabTools.sch as unknown as { _?: { danglingLabelIds?: (d: KDoc) => Set<string> }; state?: { drag?: { items?: { item?: { id?: string } }[] } | null } };
  const out: { dangling?: Set<string>; moving?: Set<string> } = {};
  if (selected && selected.size && tools._ && tools._.danglingLabelIds) { try { out.dangling = tools._.danglingLabelIds(E.kdoc); } catch (e) { /* no tools yet */ } }
  const d = tools.state && tools.state.drag;
  if (d && d.items && d.items.length) out.moving = new Set(d.items.map((e) => (e && e.item && e.item.id) || "").filter((id) => id));
  // a field dragged on its own draws its umbilical line instead of its anchor
  const fd = E.fdrag as { id: string; name: string; moved: boolean } | null;
  if (fd && fd.moved) (out.moving || (out.moving = new Set())).add(fd.id + "#field:" + fd.name);
  return out;
}
/** Board items repainted brightened (EDA_ITEM::IsBrightened): the Clarify Selection row under the pointer, the delete tool's target. */
function boardBrightened(): Set<string> | null {
  if (isSch()) return null;
  const out = new Set<string>();
  if (E.hoverPinned && E.hoverId) out.add(E.hoverId as string);
  const pcb = CollabTools.pcb; if (pcb && pcb.brightenedIds) { try { for (const id of pcb.brightenedIds()) out.add(id); } catch (e) { /* older module */ } }
  return out.size ? out : null;
}
export function drawCanvas() {
  if (!E.kdoc) return; sizeCanvas();
  const ppm = stage.clientWidth / mmW();
  const view = { ppm, zoom: E.zoom, panX: E.panX, panY: E.panY, x0: mmX0(), y0: mmY0(), dpr: window.devicePixelRatio || 1 };
  const ghosts: PeerGhost[] = E.peerGhosts || [];
  const m0 = activeModule() as { hiddenIds?: () => Set<string> | null } | null;
  const own = m0 && m0.hiddenIds ? m0.hiddenIds() : null;   // the board module's items drawn elsewhere (a router drag's lines)
  const skip = ghosts.length || own ? new Set([...ghosts.flatMap((g) => [...g.ids]), ...(own || [])]) : null;
  const force: boolean | "rest" | "zoomEnd" = E.renderFull === "rest" || E.renderFull === "zoomEnd" ? E.renderFull : E.renderFull !== false; E.renderFull = false;
  // pinned comment threads sit on their part or net: a full render means items may have moved (a local move
  // updates the item's box only when it lands, after the document version was bumped)
  if (force && E.comments && E.comments.length) drawComments();
  updateMsgPanel();
  const selected = boardSelected();
  paintDocument(E.kdoc, cctx, view, Object.assign({ hidden: E.hiddenLayers, grid: E.gridOn ? E.gridPitch : 0, selected, highlight: E.highlightIds, brightened: boardBrightened(), skip: skip || undefined }, schPaintState(selected), E.renderOpts), force, E.zoomAnim ? { to: E.zoomAnim.to, cx: E.zoomAnim.cx, cy: E.zoomAnim.cy } : null, requestRestRender);
  // A peer's items mid-drag: drawn where the peer has them (presence `at`), translucent, over everything else.
  if (ghosts.length) {
    const off: HTMLCanvasElement = E.ghostCanvas || (E.ghostCanvas = document.createElement("canvas"));
    if (off.width !== canvas.width || off.height !== canvas.height) { off.width = canvas.width; off.height = canvas.height; }
    const octx = off.getContext("2d")!; const sc = view.ppm * view.zoom;
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
  try { cctx.save(); KiCadCanvas.setViewTransform(cctx, view); drawAppOverlays(cctx, view, isSch()); } catch (e) { console.warn(e); } finally { cctx.restore(); }
  drawHover(cctx, view);
  if (E.selPins.length && CollabTools.sch && CollabTools.sch._) {
    // the selected pins drawn in the selection colour over their symbols
    const of = (CollabTools.sch._ as unknown as { pinOf?: (d: KDoc, r: unknown) => { pin: { x: number; y: number; root: [number, number] } } | null }).pinOf;
    const found = E.selPins.map((p: unknown) => (of ? of(E.kdoc, p) : null));
    if (found.some((h: unknown) => !h)) E.selPins = E.selPins.filter((_p: unknown, i: number) => !!found[i]);
    // their selection shadow is drawn by the canvas pass (boardSelected adds "id#pin:N")
  }
  if (E.selField) { const it = E.kdoc.items.get(E.selField.id); if (!it) E.selField = null; }   // its shadow and anchor come from the canvas pass
}


// ---- view transform ----
/** GAL::GetZoomFactor: the zoom as KiCad states it (1.0 is a millimetre at KiCad's screen scale), for the zoom choices. */
export function kicadZoom(): number {
  const w = stage.clientWidth, mm = mmW();
  return w > 0 && mm > 0 ? (KiCadCanvas.zoomFactor as (v: { ppm: number; zoom: number; panX: number; panY: number; x0: number; y0: number }) => number)({ ppm: w / mm, zoom: E.zoom, panX: 0, panY: 0, x0: 0, y0: 0 }) : 1;
}
export function applyView() {
  world.style.transform = `translate(${E.panX}px, ${E.panY}px) scale(${E.zoom})`;
  store.slice("viewport", { zoom: E.zoom, kzoom: kicadZoom() });
  // Everything on the overlay is sized in screen pixels, so a zoom or fit
  // must redraw peers too (they otherwise keep the previous scale until the
  // next presence message).
  drawComments(); drawSelection(); drawPeers(E.peerState); refreshCrosshair();
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

export function fitBox(box: number[], margin?: number) {
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

export function zoomBy(factor: number, cx?: number, cy?: number) {
  E.viewTouched = true;
  if (cx === undefined) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
  const [lo, hi] = zoomLimits();
  const next = Math.min(Math.max(hi, E.zoom), Math.max(Math.min(lo, E.zoom), E.zoom * factor));   // a view outside the range (a fit) can still zoom back in
  E.panX = cx! - (cx! - E.panX) * (next / E.zoom);
  E.panY = cy! - (cy! - E.panY) * (next / E.zoom);
  E.zoom = next; breakFollow(); applyView();
  // A peer following us reads `viewport` out of presence; without a send here a wheel zoom
  // (or a pan, below) never reaches them and "follow" sits a screen behind.
  sendPresence(null);
}


export function worldMm(ev: { clientX: number; clientY: number }): [number, number] {
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
export function svgText(x: number, y: number, size: number, color: string, text: string) {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y); t.setAttribute("fill", color); t.setAttribute("font-size", size);
  t.setAttribute("font-family", "system-ui, sans-serif"); t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "#001023"); t.setAttribute("stroke-width", size / 4); t.textContent = text;
  return t;
}

/** Our own boxes [x, y, w, h] (internal units) of the items a peer selected by id. */
function peerBoxesOf(ids: Iterable<string>) {
  const out: number[][] = [], board = !isSch();
  for (const id of ids) {
    const it = E.kdoc.items.get(id); if (!it) continue;
    const b = it.bbox, box = board ? KiCadCanvas.boardItemBox(it, E.IU) : b ? [b[0] * E.IU, b[1] * E.IU, (b[2] - b[0]) * E.IU, (b[3] - b[1]) * E.IU] : null;
    if (box) out.push(box);
  }
  return out;
}

export function drawPeers(peers: Record<string, PeerEntry>) {
  peersG.replaceChildren();
  const s = pxPerMm(), mm = (nm: number) => nm / E.IU;
  const ghosts: PeerGhost[] = [];
  for (const [cid, p] of Object.entries(peers)) {
    const st = p.state || {}, color = (p.user && p.user.color) || "#4477ee", name = peerName(p);
    // Items the peer is dragging: `at[i]` is where they hold selection[i]; a displacement from our copy's own
    // anchor is a live drag, drawn by drawCanvas as a ghost (one render per distinct offset).
    if (E.kdoc && Array.isArray(st.at) && Array.isArray(st.selection)) {
      const byOff = new Map<string, PeerGhost>();
      for (let i = 0; i < st.selection.length && i < st.at.length; i++) {
        const a = st.at[i], it = E.kdoc.items.get(st.selection[i]); if (!a || !it) continue;
        const mine = anchorMm(it); if (!mine) continue;
        const dx = a[0] / E.IU - mine[0], dy = a[1] / E.IU - mine[1];
        if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) continue;
        const key = dx.toFixed(4) + "," + dy.toFixed(4); let g = byOff.get(key); if (!g) byOff.set(key, g = { ids: new Set<string>(), dx, dy });
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
    let own = (st.boxes || []).filter((b, i: number) => !(dragAdded.size && dragAdded.has(sel[i])));
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
