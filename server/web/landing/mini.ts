// The hero: a cut-down board editor the visitor can use.  It is the demo board with four
// connections left open, painted by the editor's renderer, with just enough tools to finish
// it: move a footprint or a text, route a track, drop a via, switch layer, undo.  Two scripted
// collaborators keep their pointers on the board, as teammates would in a real project, and
// when the visitor has changed something one of them comes over and puts it back by hand.

import {
  BOARD, Box, HIDDEN, K, PEERS, boardText, Pt, Rat, View, clamp, clash, copperAt, dist, drawCursor, ease, fit, lerp, loadPcbOpen, meta, ratsnest, span, toMm, toPx, trackAt,
} from "./demo";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tool = "select" | "route" | "via";
type Layer = "F.Cu" | "B.Cu";
const GRID = 0.25, VIA = { size: 0.6, drill: 0.3 };
/** The board's net class clearance: new copper keeps this far from every other net. */
const CLEARANCE = 0.2;
const LAYER_COLOR: Record<Layer, string> = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4" };
const HOME: Box = [BOARD.x - 3, BOARD.y - 3, BOARD.x + BOARD.w + 3, BOARD.y + BOARD.h + 3];
/** Routes left for the visitor: the back-layer jumper, the output, the LED and its ground. */
const OPEN = [20, 26, 27, 28];
const PARTS = new Set(meta.parts.map((p) => p.id));
const snap = (v: number, o: number): number => o + Math.round((v - o) / GRID) * GRID;

/** What a scripted teammate does on their own, round and round: go to a part (`ref`) or a
 *  point on the board ([x, y] from its corner, millimetres), click, and stay `dwell` seconds.
 *  `hold` keeps the part selected while they stay, as someone looking it over would. */
interface Stop { ref?: string; at?: Pt; dwell: number; hold?: boolean }
const ROUNDS: Stop[][] = [
  [{ ref: "R1", dwell: 3.4, hold: true }, { at: [14.75, 9], dwell: 1.1 }, { ref: "C1", dwell: 2.2, hold: true }, { at: [9.5, 13.25], dwell: 0.9 }, { ref: "R2", dwell: 2.6, hold: true }, { at: [6, 20], dwell: 1.8 }, { ref: "J1", dwell: 1.4 }],
  [{ ref: "R4", dwell: 3.8, hold: true }, { at: [33.75, 15.25], dwell: 1 }, { ref: "C3", dwell: 2.4, hold: true }, { at: [39, 21], dwell: 2 }, { ref: "R3", dwell: 2.8, hold: true }, { at: [29.5, 13.25], dwell: 1.2 }],
];
/** Where one of them is on their round: moving from `from` to `to`, then staying until `until`. */
interface Walk { i: number; from: Pt; to: Pt; t0: number; dur: number; until: number }
/** A change the visitor made, kept so that it can be taken back: by them, or by a teammate. */
type Edit = { kind: "move"; id: string; from: Pt } | { kind: "add"; ids: string[] } | { kind: "del"; item: any };
/** One stretch of a teammate's pointer while they undo something. */
interface Step { dur: number; to: Pt; straight?: boolean; start?: () => void; tick?: (at: Pt) => void; end?: () => void }
interface Job { who: number; steps: Step[]; i: number; t0: number; from: Pt; at: Pt; move: { id: string; from: Pt } | null }
const CLICK = 0.11;                                 // the pause on a point before the click lands
const IDLE = 2200, GAP = 900;                       // ms the visitor is left alone before, and between, undos
const minJerk = (u: number): number => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u);

export function startMini(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const xy = q("[data-xy]"), zoomOut = q("[data-z]"), counts = q("[data-counts]"), unrouted = q("[data-unrouted]"), toolName = q("[data-toolname]");
  const still = reducedMotion();

  let doc = loadPcbOpen();
  let tool: Tool = "select", layer: Layer = "F.Cu", box: Box = HOME.slice() as Box;
  let view: View | null = null, selected: string | null = null, hover: Pt | null = null;
  let rats: Rat[] = [], dirty = true, touched = false;
  let drag: { id: string; from: Pt; grab: Pt; moved: boolean } | null = null;
  let pan: { at: Pt; box: Box } | null = null;
  let route: { net: number; from: Pt; layer: Layer; made: string[] } | null = null;
  const edits: Edit[] = [];
  let job: Job | null = null; const walks: (Walk | null)[] = [null, null];
  let mark: { id: string; who: number } | null = null, redo: { a: Pt; b: Pt; at: Pt; layer: Layer; w: number } | null = null;
  let lastAct = 0, nextJob = 0, stillTimer = 0, blocked: number | null = null;
  let base: HTMLCanvasElement | null = null, t0 = 0, serial = 0;

  function open(): void {
    for (const i of OPEN) { const r = meta.routes[i]; for (const id of r.ids) doc.items.delete(id); if (r.via) doc.items.delete(r.via); }
  }
  open();

  const netName = (net: number): string => { const n = (doc as any).nets && (doc as any).nets.get ? (doc as any).nets.get(net) : null; return typeof n === "string" && n ? n : `net ${net}`; };
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
  const posOf = (it: any): Pt => { const at = K.atOf(it.node); return [at[0], at[1]]; };
  /** What a press with the arrow tool takes hold of: the item under it, and a text anywhere in its box. */
  function pick(at: Pt): string | null {
    const hit: string | null = K.hitTest(doc, at[0], at[1], 0.3, { hidden: HIDDEN });
    if (hit && (PARTS.has(hit) || doc.items.get(hit)?.kind === "gr_text")) return hit;
    for (const it of doc.items.values()) if (it.kind === "gr_text" && it.bbox && at[0] >= it.bbox[0] && at[0] <= it.bbox[2] && at[1] >= it.bbox[1] && at[1] <= it.bbox[3]) return it.id;
    return hit;
  }
  /** The other net whose copper is under the pointer while a track is being laid, if any. */
  function foreign(at: Pt | null): number | null {
    if (!route || !at) return null;
    const c = copperAt(doc, at[0], at[1], route.layer);
    return c && c.net !== route.net ? c.net : null;
  }
  const movable = (id: string | null): boolean => !!id && (PARTS.has(id) || doc.items.get(id)?.kind === "gr_text");
  /** One undo step that takes back everything added since `made` was started. */
  function remember(made: string[]): void { if (made.length) edits.push({ kind: "add", ids: made }); }
  function revert(e: Edit): void {
    if (e.kind === "move") { const it = doc.items.get(e.id); if (it) K.moveItem(doc, it, e.from[0], e.from[1], 1e6); }
    else if (e.kind === "add") { for (const id of e.ids) doc.items.delete(id); }
    else doc.items.set(e.item.id, e.item);
  }
  function redraw(): void { dirty = true; stage.invalidate(); sync(); }
  function change(): void {
    touched = true; lastAct = performance.now(); redraw();
    // Without motion nobody walks over: the change is simply taken back after a moment.
    if (still) { clearTimeout(stillTimer); stillTimer = window.setTimeout(stillUndo, IDLE + 600); }
  }
  function stillUndo(): void {
    if (drag || route) { stillTimer = window.setTimeout(stillUndo, GAP); return; }
    const e = edits.pop(); if (!e) return;
    revert(e); selected = null; redraw();
    if (edits.length) stillTimer = window.setTimeout(stillUndo, GAP + 300);
  }

  // ------------------------------------------------------------------ teammates undoing

  /** Where a teammate's pointer is on their own loop, in board millimetres. */
  const refId = (ref: string): string | undefined => meta.parts.find((p) => p.ref === ref)?.id;
  /** Where a stop is now: the part where it stands at this moment, on the grid like everything else. */
  function stopAt(st: Stop): Pt {
    const it = st.ref ? doc.items.get(refId(st.ref) || "") : null;
    if (it) { const p = posOf(it); return [snap(p[0], BOARD.x), snap(p[1], BOARD.y)]; }
    const a = st.at || [0, 0]; return [BOARD.x + a[0], BOARD.y + a[1]];
  }
  /** The pointer of a teammate going about their round: KiCad-like, as in the story below.
   *  A quick deliberate move (minimum jerk, slightly bowed) to the next thing, a beat, the
   *  click, then stillness while they look at it. */
  function walkAt(who: number, now: number): { at: Pt; held: string | null } {
    const round = ROUNDS[who]; let w = walks[who];
    if (!w) { const p = stopAt(round[0]); w = walks[who] = { i: 0, from: p, to: p, t0: now, dur: 0, until: now + (still ? 1e12 : 1200 + who * 900) }; }
    if (!(job && job.who === who) && now >= w.until) {
      const i = (w.i + 1) % round.length, to = stopAt(round[i]), dur = travel(w.to, to) * 1000;
      w = walks[who] = { i, from: w.to, to, t0: now, dur, until: now + dur + (CLICK + round[i].dwell) * 1000 };
    }
    const u = w.dur ? (now - w.t0) / w.dur : 1, k = minJerk(u), dx = w.to[0] - w.from[0], dy = w.to[1] - w.from[1], d = Math.hypot(dx, dy) || 1;
    const bow = Math.sin(Math.PI * k) * Math.min(1.6, d * 0.07) * (who ? -1 : 1);
    const st = round[w.i], clicked = now >= w.t0 + w.dur + CLICK * 1000;
    return { at: [w.from[0] + dx * k - (dy / d) * bow, w.from[1] + dy * k + (dx / d) * bow], held: st.hold && st.ref && clicked ? refId(st.ref) || null : null };
  }
  /** After undoing something a teammate picks their round up again from where they stand. */
  function resume(who: number, from: Pt, now: number): void {
    const w = walks[who]; if (!w) return;
    const to = stopAt(ROUNDS[who][w.i]), dur = travel(from, to) * 1000;
    walks[who] = { i: w.i, from, to, t0: now, dur, until: now + dur + (CLICK + ROUNDS[who][w.i].dwell) * 1000 };
  }
  const travel = (a: Pt, b: Pt): number => clamp(0.35 + dist(a, b) / 28, 0.45, 1.1);
  /** One of the two, picked at random, sets off to take back the visitor's latest change the
   *  way a person would: over to it, press, and slowly back to where it was. */
  function startJob(now: number): void {
    const e = edits.pop()!, who = Math.random() < 0.5 ? 0 : 1, steps: Step[] = [];
    let at = walkAt(who, now).at;
    const from = at, go = (to: Pt): void => { steps.push({ dur: travel(at, to), to }); at = to; };
    let move: Job["move"] = null;
    if (e.kind === "move") {
      const it = doc.items.get(e.id); if (!it) return;
      const p = posOf(it), home = e.from; if (dist(p, home) < 1e-6) return;
      move = { id: e.id, from: home };
      go(p);
      steps.push({ dur: CLICK, to: p, end: () => { mark = { id: e.id, who }; } });
      steps.push({
        dur: clamp(dist(p, home) / 4.5, 1.2, 3.2), to: home, straight: true,
        tick: (c) => { const x = snap(c[0], home[0]), y = snap(c[1], home[1]), q = posOf(it); if (q[0] !== x || q[1] !== y) { K.moveItem(doc, it, x, y, 1e6); dirty = true; } },
        end: () => { K.moveItem(doc, it, home[0], home[1], 1e6); redraw(); },
      });
      steps.push({ dur: 0.3, to: home, end: () => { mark = null; } });
    } else if (e.kind === "add") {
      // Last placed first, one piece at a time, as repeated undo would.
      for (const id of e.ids.slice().reverse()) {
        const it = doc.items.get(id), g = it && (it.geom as any[])[0]; if (!g) continue;
        const c: Pt = it!.kind === "via" ? [g.x, g.y] : [(g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2];
        go(c);
        steps.push({ dur: CLICK + 0.28, to: c, start: () => { mark = { id, who }; }, end: () => { doc.items.delete(id); mark = null; redraw(); } });
      }
    } else {
      // Something the visitor deleted is laid again.
      const it = e.item, g = (it.geom as any[])[0];
      if (it.kind === "via" || !g) { const c: Pt = g ? [g.x, g.y] : at; go(c); steps.push({ dur: CLICK + 0.1, to: c, end: () => { doc.items.set(it.id, it); redraw(); } }); }
      else {
        const a: Pt = [g.x1, g.y1], b: Pt = [g.x2, g.y2];
        go(a);
        steps.push({ dur: CLICK, to: a, end: () => { redo = { a, b, at: a, layer: g.layer, w: g.w }; } });
        steps.push({ dur: clamp(dist(a, b) / 7, 0.5, 1.6), to: b, straight: true, tick: (c) => { if (redo) redo.at = c; } });
        steps.push({ dur: CLICK, to: b, end: () => { redo = null; doc.items.set(it.id, it); redraw(); } });
      }
    }
    if (!steps.length) return;
    steps.push({ dur: 0.25, to: at });
    job = { who, steps, i: 0, t0: now, from, at: from, move };
  }
  /** Moves the job along to `now`, running whatever its steps do on the way. */
  function runJob(now: number): void {
    while (job) {
      const j: Job = job, st = j.steps[j.i], u = (now - j.t0) / (st.dur * 1000);
      if (u >= 0 && st.start) { st.start(); st.start = undefined; }
      const k = minJerk(u), dx = st.to[0] - j.from[0], dy = st.to[1] - j.from[1], d = Math.hypot(dx, dy);
      const bow = st.straight || d < 0.5 ? 0 : Math.sin(Math.PI * k) * Math.min(1.6, d * 0.07) * (j.who ? -1 : 1);
      j.at = [j.from[0] + dx * k - (dy / (d || 1)) * bow, j.from[1] + dy * k + (dx / (d || 1)) * bow];
      if (st.tick) st.tick(j.at);
      if (u < 1) return;
      if (st.end) st.end();
      j.from = st.to; j.t0 += st.dur * 1000; j.i++;
      if (j.i >= j.steps.length) { endJob(now); return; }
    }
  }
  function endJob(now: number): void {
    if (!job) return;
    resume(job.who, job.at, now); job = null; mark = null; redo = null; nextJob = now + GAP;
  }
  /** The visitor took hold of what a teammate was carrying back: the teammate lets go. */
  function yieldTo(id: string): void {
    if (!job || !job.move || job.move.id !== id) return;
    edits.push({ kind: "move", id, from: job.move.from }); endJob(performance.now());
  }

  // "Keep going in a real project": the board as it stands is left for the app (web/onboarding/state.ts
  // reads it under this key), which makes a project of it with its schematic and opens it.  Signed
  // out, sign-in comes first and returns to the same place.
  const keep = document.querySelector<HTMLAnchorElement>("[data-keep]");   // under the window, beside the caption
  if (keep) {
    const next = "/?start=mini";
    keep.href = document.documentElement.dataset.me ? next : "/auth/github/login?next=" + encodeURIComponent(next);
    keep.addEventListener("click", () => {
      endRoute();
      try { localStorage.setItem("kc.onboard.mini", JSON.stringify({ board: boardText(doc), at: Date.now() })); } catch { /* without it the project starts from the same board, four connections open */ }
    });
  }

  /** KiCad's two-leg track: straight along the longer axis, then 45 degrees into the target. */
  function legs(a: Pt, b: Pt): Pt[] {
    const dx = b[0] - a[0], dy = b[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-3 || ay < 1e-3 || Math.abs(ax - ay) < 1e-3) return [a, b];
    const d = Math.min(ax, ay);
    const mid: Pt = ax > ay ? [b[0] - Math.sign(dx) * d, a[1]] : [a[0], b[1] - Math.sign(dy) * d];
    return [a, mid, b];
  }
  /** The same two legs the other way round: 45 degrees first, then straight. */
  function legsAlt(a: Pt, b: Pt): Pt[] {
    const p = legs(b, a); return p.length === 3 ? [a, p[1], b] : p;
  }
  /** How far along `pts` a track of `net` can be laid before it would come too close to
   *  another net's copper: the points of the part that may be placed. */
  function clear(pts: Pt[], net: number, on: Layer): { pts: Pt[]; whole: boolean; len: number } {
    const w = netWidth(net), out: Pt[] = [pts[0]]; let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = dist(a, b);
      if (!clash(doc, a, b, w, [on], net, CLEARANCE)) { out.push(b); len += d; continue; }
      let ok = 0;
      for (let s = 0.05; s < d; s += 0.05) { const p: Pt = [lerp(a[0], b[0], s / d), lerp(a[1], b[1], s / d)]; if (clash(doc, a, p, w, [on], net, CLEARANCE)) break; ok = s; }
      if (ok > 0) { out.push([lerp(a[0], b[0], ok / d), lerp(a[1], b[1], ok / d)]); len += ok; }
      return { pts: out, whole: false, len };
    }
    return { pts: out, whole: true, len };
  }
  /** The track from the last placed point towards `to`, as far as the net rule lets it go.
   *  A track belongs to the net it started on and never touches another one's copper. */
  function reach(from: Pt, to: Pt, net: number, on: Layer): { pts: Pt[]; whole: boolean } {
    const a = clear(legs(from, to), net, on); if (a.whole) return a;
    const b = clear(legsAlt(from, to), net, on);
    return b.whole || b.len > a.len + 1e-6 ? b : a;
  }
  const viaFits = (at: Pt, net: number): boolean => !clash(doc, at, at, VIA.size, null, net, CLEARANCE);
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
    if (route && hover) {
      const made = route.made, t = target(hover, route.net), r = reach(route.from, t.at, route.net, route.layer), end = r.pts[r.pts.length - 1];
      if (!viaFits(end, route.net)) return;                // no room for the via here: stay on this layer
      for (let i = 1; i < r.pts.length; i++) made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      made.push(addVia(end, route.net)); route = { net: route.net, from: end, layer: l, made };
    }
    layer = l; dirty = true; sync(); stage.invalidate();
  }
  function endRoute(): void { if (route) { remember(route.made); route = null; change(); } }
  function reset(): void {
    doc = loadPcbOpen(); open(); edits.length = 0; job = null; walks[0] = walks[1] = null; mark = null; redo = null; clearTimeout(stillTimer); route = null; drag = null; selected = null; box = HOME.slice() as Box; tool = "select"; layer = "F.Cu";
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
    doc.items.delete(it.id);
    // Taking out a piece the visitor laid themselves is not a change of its own: it just shortens that one.
    const own = edits.find((e) => e.kind === "add" && e.ids.includes(it.id));
    if (own && own.kind === "add") { own.ids.splice(own.ids.indexOf(it.id), 1); if (!own.ids.length) edits.splice(edits.indexOf(own), 1); }
    else edits.push({ kind: "del", item: it });
    selected = null; change();
  }

  /** Status bar, toolbar states. */
  function sync(): void {
    root.dataset.tool = tool; root.dataset.layer = layer;
    root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.toolBtn === tool)));
    root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layerBtn === layer)));
    const u = q<HTMLButtonElement>("[data-act=undo]"); if (u) u.disabled = !edits.length && !route;
    const r = q<HTMLButtonElement>("[data-act=reset]"); if (r) r.disabled = !touched;
    if (toolName) toolName.textContent = tool === "route" ? (route ? (foreign(hover) !== null ? `Route Tracks: ${netName(route.net)} cannot connect to ${netName(foreign(hover)!)}` : `Route Tracks: ${netName(route.net)}, click to place, double-click to finish`) : "Route Tracks: click a pad or a track to start") : tool === "via" ? "Add Via" : "Select item(s)";
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
      const t = target(hover, route.net), pts = reach(route.from, t.at, route.net, route.layer).pts.map(px);
      ctx.strokeStyle = LAYER_COLOR[route.layer]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, netWidth(route.net) * view.ppm); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (tool === "via" && hover) {
      const t = target(hover, null), c = px(t.at);
      ctx.globalAlpha = viaFits(t.at, t.net) ? 0.8 : 0.22; ctx.fillStyle = "#ECECEC"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.size / 2 * view.ppm, 0, 6.3); ctx.fill();
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
    if (!still) {
      if (!job && edits.length && !drag && !route && !pan && now - lastAct > IDLE && now > nextJob) startJob(now);
      runJob(now);
    }
    if (mark) {
      const it = doc.items.get(mark.id), g = it && (it.geom as any[])[0];
      ctx.strokeStyle = PEERS[mark.who].color; ctx.lineCap = "round";
      if (it && it.kind === "segment" && g) { const a = px([g.x1, g.y1]), b = px([g.x2, g.y2]); ctx.globalAlpha = 0.75; ctx.lineWidth = g.w * view.ppm + 4; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (it && it.bbox) { const p0 = px([it.bbox[0], it.bbox[1]]), p1 = px([it.bbox[2], it.bbox[3]]); ctx.lineWidth = 1.5; ctx.strokeRect(p0[0] - 3, p0[1] - 3, p1[0] - p0[0] + 6, p1[1] - p0[1] + 6); }
    }
    if (redo) {
      const a = px(redo.a), b = px(redo.at);
      ctx.strokeStyle = LAYER_COLOR[redo.layer] || LAYER_COLOR["F.Cu"]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, redo.w * view.ppm); ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.globalAlpha = 1;
    }
    ROUNDS.forEach((_, who) => {
      const peer = PEERS[who], w = walkAt(who, now), busy = !!job && job.who === who;
      const at: Pt = busy ? job!.at : w.at;
      const it = !busy && w.held ? doc.items.get(w.held) : null;
      if (it && it.bbox) {
        const p0 = toPx(view!, it.bbox[0], it.bbox[1]), p1 = toPx(view!, it.bbox[2], it.bbox[3]);
        ctx.strokeStyle = peer.color; ctx.lineWidth = 1.5; ctx.strokeRect(p0[0] - 3, p0[1] - 3, p1[0] - p0[0] + 6, p1[1] - p0[1] + 6);
      }
      const c = toPx(view!, at[0], at[1]);
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
    canvas.focus({ preventScroll: true }); hover = at; lastAct = performance.now();
    if (tool === "select") {
      const hit = pick(at);
      if (movable(hit)) {
        const it = doc.items.get(hit!)!; selected = hit; yieldTo(hit!);
        drag = { id: hit!, from: posOf(it), grab: at, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        selected = trackAt(doc, at[0], at[1], 0.25);
        if (!selected) { pan = { at: [e.clientX, e.clientY], box: box.slice() as Box }; canvas.setPointerCapture(e.pointerId); }
      }
      dirty = true; stage.invalidate();
    } else if (tool === "via") {
      const t = target(at, null);
      if (viaFits(t.at, t.net)) { remember([addVia(t.at, t.net)]); change(); }
    } else if (!route) {
      // A track takes its net from the copper it starts on, so it has to start on some.
      const t = target(at, null);
      if (t.onCopper) { route = { net: t.net, from: t.at, layer, made: [] }; sync(); stage.invalidate(); }
    } else {
      if (foreign(at) !== null) return;                     // another net's copper: the track may not land on it
      const t = target(at, route.net);
      if (dist(route.from, t.at) < 1e-6) { endRoute(); return; }
      const r = reach(route.from, t.at, route.net, route.layer);
      for (let i = 1; i < r.pts.length; i++) route.made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      route.from = r.pts[r.pts.length - 1];
      if (t.onCopper && r.whole) endRoute(); else change();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const at = where(e); if (!at) return;
    hover = at;
    if (xy) xy.textContent = `X ${(at[0] - BOARD.x).toFixed(2)}  Y ${(at[1] - BOARD.y).toFixed(2)}`;
    if (drag) {
      const dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      const it = doc.items.get(drag.id)!, x = drag.from[0] + dx, y = drag.from[1] + dy;
      const p = posOf(it); lastAct = performance.now();
      if (p[0] !== x || p[1] !== y) { K.moveItem(doc, it, x, y, 1e6); drag.moved = true; dirty = true; }
    } else if (pan && view) {
      const dx = (e.clientX - pan.at[0]) / view.ppm, dy = (e.clientY - pan.at[1]) / view.ppm;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; dirty = true;
    } else if (route) {
      const f = foreign(at); if (f !== blocked) { blocked = f; sync(); }
    } else if (tool === "select") {
      canvas.style.cursor = movable(pick(at)) ? "move" : "";
    }
    stage.invalidate();
  });
  const release = () => {
    if (drag && drag.moved) {
      // One entry per item, holding where it first was, so it goes all the way home in one carry.
      const d = drag; if (!edits.some((e) => e.kind === "move" && e.id === d.id)) edits.push({ kind: "move", id: d.id, from: d.from });
      change();
    }
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
    const k = e.key.toLowerCase(); lastAct = performance.now();
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
      else { const u = edits.pop(); if (u) { revert(u); selected = null; change(); } }
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
