// The hero: a cut-down board editor the visitor can use.  It is the demo board with four
// connections left open, painted by the editor's renderer, with just enough tools to finish
// it: move a footprint, route a track, drop a via, switch layer, undo.  Two scripted
// collaborators keep their pointers on the board, as teammates would in a real project.

import {
  BOARD, Box, HIDDEN, K, PEERS, Pt, Rat, View, clamp, copperAt, drawCursor, ease, fit, lerp, loadPcb, meta, ratsnest, span, toMm, toPx, trackAt,
} from "./demo";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tool = "select" | "route" | "via";
type Layer = "F.Cu" | "B.Cu";
const GRID = 0.25, VIA = { size: 0.6, drill: 0.3 };
const LAYER_COLOR: Record<Layer, string> = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4" };
const HOME: Box = [BOARD.x - 3, BOARD.y - 3, BOARD.x + BOARD.w + 3, BOARD.y + BOARD.h + 3];
/** Routes left for the visitor: the back-layer jumper, the output, the LED and its ground. */
const OPEN = [20, 26, 27, 28];
const PARTS = new Set(meta.parts.map((p) => p.id));
const snap = (v: number, o: number): number => o + Math.round((v - o) / GRID) * GRID;

/** A pointer path: [time, x, y] keys in board millimetres, eased between, looping. */
type Key = [number, number, number];
function along(keys: Key[], t: number): Pt {
  const end = keys[keys.length - 1][0]; t = ((t % end) + end) % end;
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const a = keys[i - 1], b = keys[i], k = ease(span(t, a[0], b[0])); return [lerp(a[1], b[1], k), lerp(a[2], b[2], k)]; }
  return [keys[0][1], keys[0][2]];
}
const MARA: Key[] = [[0, 9, 5], [3, 11.6, 13.2], [7, 11.6, 13.2], [9.5, 17.6, 8.2], [13, 18, 7.6], [16, 6, 19.5], [19, 6.5, 20], [22, 9, 5]];
const JUN: Key[] = [[0, 39, 21], [2.5, 36.9, 13.4], [9, 36.9, 13.4], [11, 33.4, 9.2], [14.5, 33, 9.6], [17, 39.5, 17.5], [20, 39, 21]];
/** What each of them has selected, and when in their loop. */
const HOLDS: [number, string, number, number][] = [[0, "R1", 3.2, 7], [1, "R4", 2.8, 9]];

export function startMini(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const xy = q("[data-xy]"), zoomOut = q("[data-z]"), counts = q("[data-counts]"), unrouted = q("[data-unrouted]"), toolName = q("[data-toolname]");
  const still = reducedMotion();

  let doc = loadPcb();
  let tool: Tool = "select", layer: Layer = "F.Cu", box: Box = HOME.slice() as Box;
  let view: View | null = null, selected: string | null = null, hover: Pt | null = null;
  let rats: Rat[] = [], dirty = true, touched = false;
  let drag: { id: string; from: Pt; grab: Pt; moved: boolean } | null = null;
  let pan: { at: Pt; box: Box } | null = null;
  let route: { net: number; from: Pt; layer: Layer; made: string[] } | null = null;
  const undo: (() => void)[] = [];
  let base: HTMLCanvasElement | null = null, t0 = 0, serial = 0;

  function open(): void {
    for (const i of OPEN) { const r = meta.routes[i]; for (const id of r.ids) doc.items.delete(id); if (r.via) doc.items.delete(r.via); }
  }
  open();

  const netWidth = (net: number): number => net === 1 || net === 2 ? 0.4 : 0.25;
  const newId = (): string => `mini-${++serial}-${Math.random().toString(36).slice(2, 8)}`;
  const f3 = (v: number): number => Math.round(v * 1000) / 1000;
  function addSegment(a: Pt, b: Pt, net: number, on: Layer): string {
    const id = newId();
    K.addItem(doc, K.parse(`(segment (start ${f3(a[0])} ${f3(a[1])}) (end ${f3(b[0])} ${f3(b[1])}) (width ${netWidth(net)}) (layer "${on}") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  function addVia(at: Pt, net: number): string {
    const id = newId();
    K.addItem(doc, K.parse(`(via (at ${f3(at[0])} ${f3(at[1])}) (size ${VIA.size}) (drill ${VIA.drill}) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  /** One undo step that takes back everything added since `made` was started. */
  function remember(made: string[]): void { if (made.length) undo.push(() => { for (const id of made) doc.items.delete(id); }); }
  function change(): void { dirty = true; touched = true; stage.invalidate(); sync(); }

  /** KiCad's two-leg track: straight along the longer axis, then 45 degrees into the target. */
  function legs(a: Pt, b: Pt): Pt[] {
    const dx = b[0] - a[0], dy = b[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-3 || ay < 1e-3 || Math.abs(ax - ay) < 1e-3) return [a, b];
    const d = Math.min(ax, ay);
    const mid: Pt = ax > ay ? [b[0] - Math.sign(dx) * d, a[1]] : [a[0], b[1] - Math.sign(dy) * d];
    return [a, mid, b];
  }
  /** Where a click lands while a tool is active: copper of the right net if there is some, else the grid. */
  function target(at: Pt, net: number | null): { at: Pt; net: number; onCopper: boolean } {
    const c = copperAt(doc, at[0], at[1], layer);
    if (c && (net === null || net === 0 || c.net === net)) return { at: [c.x, c.y], net: c.net, onCopper: true };
    return { at: [snap(at[0], BOARD.x), snap(at[1], BOARD.y)], net: net || 0, onCopper: false };
  }

  function setTool(t: Tool): void {
    if (route && t !== "route") endRoute();
    tool = t; if (t !== "select") selected = null;
    sync(); stage.invalidate();
  }
  function setLayer(l: Layer): void {
    if (l === layer) return;
    // Changing layer mid-track drops a via, as the router does.
    if (route && hover) { const made = route.made; const t = target(hover, route.net); const pts = legs(route.from, t.at); for (let i = 1; i < pts.length; i++) made.push(addSegment(pts[i - 1], pts[i], route.net, route.layer)); made.push(addVia(t.at, route.net)); route = { net: route.net, from: t.at, layer: l, made }; }
    layer = l; dirty = true; sync(); stage.invalidate();
  }
  function endRoute(): void { if (route) { remember(route.made); route = null; change(); } }
  function reset(): void {
    doc = loadPcb(); open(); undo.length = 0; route = null; drag = null; selected = null; box = HOME.slice() as Box; tool = "select"; layer = "F.Cu";
    dirty = true; touched = false; sync(); stage.invalidate();
  }
  function zoom(k: number, about?: Pt): void {
    const cx = about ? about[0] : (box[0] + box[2]) / 2, cy = about ? about[1] : (box[1] + box[3]) / 2;
    const w = clamp((box[2] - box[0]) * k, (HOME[2] - HOME[0]) / 6, (HOME[2] - HOME[0]) * 1.5), r = w / (box[2] - box[0]);
    box = [cx - (cx - box[0]) * r, cy - (cy - box[1]) * r, cx + (box[2] - cx) * r, cy + (box[3] - cy) * r];
    dirty = true; stage.invalidate();
  }
  function removeSelected(): void {
    if (!selected) return;
    const it = doc.items.get(selected); if (!it || (it.kind !== "segment" && it.kind !== "via")) return;
    doc.items.delete(it.id); undo.push(() => { doc.items.set(it.id, it); }); selected = null; change();
  }

  /** Status bar, toolbar states. */
  function sync(): void {
    root.dataset.tool = tool; root.dataset.layer = layer;
    root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.toolBtn === tool)));
    root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layerBtn === layer)));
    const u = q<HTMLButtonElement>("[data-act=undo]"); if (u) u.disabled = !undo.length && !route;
    const r = q<HTMLButtonElement>("[data-act=reset]"); if (r) r.disabled = !touched;
    if (toolName) toolName.textContent = tool === "route" ? (route ? "Route Tracks: click to place, double-click to finish" : "Route Tracks: click a pad to start") : tool === "via" ? "Add Via" : "Select item(s)";
    if (dirty) rats = ratsnest(doc, { poured: 1 });
    if (counts) {
      let vias = 0, segs = 0; for (const it of doc.items.values()) { if (it.kind === "via") vias++; else if (it.kind === "segment") segs++; }
      counts.textContent = `Pads 42   Vias ${vias}   Track Segments ${segs}   Nets 9`;
      if (unrouted) { unrouted.textContent = `Unrouted ${rats.length}`; unrouted.classList.toggle("ok", rats.length === 0); }
    }
  }

  const stage: Stage = makeStage(canvas, (s, now) => {
    if (!t0) t0 = now;
    const { ctx, w: W, h: H, dpr } = s;
    view = fit(W, H, dpr, box);
    if (!base) base = document.createElement("canvas");
    if (base.width !== canvas.width || base.height !== canvas.height) { base.width = canvas.width; base.height = canvas.height; dirty = true; }
    if (dirty) {
      rats = ratsnest(doc, { poured: 1 });
      K.render(doc, base.getContext("2d")!, view, { hidden: HIDDEN, grid: 1, ratsnest: rats, selected: selected ? new Set([selected]) : null, zoneFill: true, activeLayer: layer });
      dirty = false;
      if (zoomOut) zoomOut.textContent = `Z ${(view.ppm / 3.78).toFixed(2)}`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (p: Pt): Pt => toPx(view!, p[0], p[1]);

    // The track being routed and the via that a layer change would drop.
    if (route && hover) {
      const t = target(hover, route.net), pts = legs(route.from, t.at).map(px);
      ctx.strokeStyle = LAYER_COLOR[route.layer]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, netWidth(route.net) * view.ppm); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (tool === "via" && hover) {
      const t = target(hover, null), c = px(t.at);
      ctx.globalAlpha = 0.8; ctx.fillStyle = "#ECECEC"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.size / 2 * view.ppm, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#001023"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.drill / 2 * view.ppm, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (tool !== "select" && hover) {
      // The snapped point, as the editor's crosshair shows it.
      const t = target(hover, route ? route.net : null), c = px(t.at);
      ctx.strokeStyle = "#FFFFFFB0"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(c[0]) + 0.5, c[1] - 9); ctx.lineTo(Math.round(c[0]) + 0.5, c[1] + 9); ctx.moveTo(c[0] - 9, Math.round(c[1]) + 0.5); ctx.lineTo(c[0] + 9, Math.round(c[1]) + 0.5); ctx.stroke();
      if (t.onCopper) { ctx.beginPath(); ctx.arc(c[0], c[1], 6, 0, 6.3); ctx.stroke(); }
    }

    // The scripted collaborators: a pointer each, and an outline on what they hold.
    const t = still ? 5 : (now - t0) / 1000;
    [MARA, JUN].forEach((path, who) => {
      const peer = PEERS[who], end = path[path.length - 1][0], tt = t % end;
      for (const [w, ref, a, b] of HOLDS) {
        if (w !== who || tt < a || tt > b) continue;
        const it = doc.items.get(meta.parts.find((p) => p.ref === ref)!.id); if (!it || !it.bbox) continue;
        const p0 = toPx(view!, it.bbox[0], it.bbox[1]), p1 = toPx(view!, it.bbox[2], it.bbox[3]);
        ctx.strokeStyle = peer.color; ctx.lineWidth = 1.5; ctx.strokeRect(p0[0] - 3, p0[1] - 3, p1[0] - p0[0] + 6, p1[1] - p0[1] + 6);
      }
      const at = along(path, t), c = toPx(view!, BOARD.x + at[0], BOARD.y + at[1]);
      drawCursor(ctx, c[0], c[1], peer.name, peer.color, SANS);
    });
    return !still;
  });

  // ------------------------------------------------------------------ input

  function where(e: { clientX: number; clientY: number }): Pt | null {
    if (!view) return null;
    const r = canvas.getBoundingClientRect();
    return toMm(view, e.clientX - r.left, e.clientY - r.top);
  }
  canvas.addEventListener("pointerdown", (e) => {
    const at = where(e); if (!at || e.button !== 0) return;
    canvas.focus({ preventScroll: true }); hover = at;
    if (tool === "select") {
      const hit: string | null = K.hitTest(doc, at[0], at[1], 0.3, { hidden: HIDDEN });
      if (hit && PARTS.has(hit)) {
        const it = doc.items.get(hit)!; selected = hit;
        drag = { id: hit, from: [it.x!, it.y!], grab: at, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        selected = trackAt(doc, at[0], at[1], 0.25);
        if (!selected) { pan = { at: [e.clientX, e.clientY], box: box.slice() as Box }; canvas.setPointerCapture(e.pointerId); }
      }
      dirty = true; stage.invalidate();
    } else if (tool === "via") {
      const t = target(at, null); remember([addVia(t.at, t.net)]); change();
    } else if (!route) {
      const t = target(at, null);
      route = { net: t.net, from: t.at, layer, made: [] }; sync(); stage.invalidate();
    } else {
      const t = target(at, route.net), pts = legs(route.from, t.at);
      if (pts.length === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1]) { endRoute(); return; }
      for (let i = 1; i < pts.length; i++) route.made.push(addSegment(pts[i - 1], pts[i], route.net, route.layer));
      route.from = t.at;
      if (t.onCopper) endRoute(); else change();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const at = where(e); if (!at) return;
    hover = at;
    if (xy) xy.textContent = `X ${(at[0] - BOARD.x).toFixed(2)}  Y ${(at[1] - BOARD.y).toFixed(2)}`;
    if (drag) {
      const dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      const it = doc.items.get(drag.id)!, x = drag.from[0] + dx, y = drag.from[1] + dy;
      if (it.x !== x || it.y !== y) { K.moveItem(doc, it, x, y, 1e6); drag.moved = true; dirty = true; }
    } else if (pan && view) {
      const dx = (e.clientX - pan.at[0]) / view.ppm, dy = (e.clientY - pan.at[1]) / view.ppm;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; dirty = true;
    } else if (tool === "select") {
      const hit: string | null = K.hitTest(doc, at[0], at[1], 0.3, { hidden: HIDDEN });
      canvas.style.cursor = hit && PARTS.has(hit) ? "move" : "";
    }
    stage.invalidate();
  });
  const release = () => {
    if (drag && drag.moved) { const d = drag; undo.push(() => { K.moveItem(doc, doc.items.get(d.id), d.from[0], d.from[1], 1e6); }); change(); }
    drag = null; pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => { if (!drag && !pan) { hover = null; if (xy) xy.textContent = "X --.--  Y --.--"; stage.invalidate(); } });
  canvas.addEventListener("dblclick", () => { if (route) endRoute(); });
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;               // a plain wheel scrolls the page
    e.preventDefault(); const at = where(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, at || undefined);
  }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); act("undo"); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "escape") { if (route) endRoute(); else if (tool !== "select") setTool("select"); else { selected = null; dirty = true; stage.invalidate(); } }
    else if (k === "x") setTool("route");
    else if (k === "v") { if (route) setLayer(layer === "F.Cu" ? "B.Cu" : "F.Cu"); else setTool("via"); }
    else if (k === "pageup") { e.preventDefault(); setLayer("F.Cu"); }
    else if (k === "pagedown") { e.preventDefault(); setLayer("B.Cu"); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); removeSelected(); }
    else if (k === "+" || k === "=") zoom(1 / 1.25);
    else if (k === "-") zoom(1.25);
    else if (k === "home") { e.preventDefault(); box = HOME.slice() as Box; dirty = true; stage.invalidate(); }
  });

  function act(name: string): void {
    if (name === "undo") {
      if (route) { for (const id of route.made) doc.items.delete(id); route = null; change(); }
      else { const u = undo.pop(); if (u) { u(); selected = null; change(); } }
    } else if (name === "zoom-in") zoom(1 / 1.25);
    else if (name === "zoom-out") zoom(1.25);
    else if (name === "zoom-fit") { box = HOME.slice() as Box; dirty = true; stage.invalidate(); }
    else if (name === "reset") reset();
  }
  root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.toolBtn as Tool)));
  root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layerBtn as Layer)));
  root.querySelectorAll<HTMLElement>("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act!)));
  sync();
}
