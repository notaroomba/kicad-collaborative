// The scroll story: one design carried from schematic to placed, routed and fabricated.
// Scrolling picks the chapter; each chapter then plays to its end on its own clock, so a
// wire that starts being drawn always arrives.  Everything flat is the real KiCad files
// painted by the editor's renderer; only the last chapter's solid is drawn here.

import {
  BOARD, Box, HIDDEN, K, PEERS, Pt, Rat, View, clamp, dist, drawCursor, ease, easeOut, fit, lerp, loadPcb, loadSch, meta, mixBox,
  ratsnest, span, toPx,
} from "./demo";
import { Cam, boardTexture, drawBodies, drawFace, drawLed, drawSlab } from "./solid";
import { MONO, SANS, Stage, makeStage, reducedMotion } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DUR = [10, 8, 10, 4.2];                       // seconds each chapter takes to play
const FAST = 7;                                     // how much faster a chapter finishes once scrolled past
const PCB_BG = "#001023";

interface Line { ids: string[]; pts: Pt[]; len: number; at: number; who: number }
const lengthOf = (pts: Pt[]): number => { let l = 0; for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]); return l; };

/** Split lines between two people, each drawing their own in order. */
function schedule(lines: { ids: string[]; pts: Pt[]; who: number }[]): { lines: Line[]; total: [number, number] } {
  const total: [number, number] = [0, 0], out: Line[] = [];
  for (const l of lines) { const len = lengthOf(l.pts); out.push({ ids: l.ids, pts: l.pts, len, at: total[l.who], who: l.who }); total[l.who] += len; }
  return { lines: out, total };
}
const WIRES = schedule(meta.sch.wires.map((w, i) => ({ ids: w.ids, pts: w.pts, who: i % 2 })));
const ROUTES = schedule(meta.routes);

// Placement: two people take turns pulling parts out of the pile.
const PLACE = ["J1", "U1", "C1", "C2", "R1", "R3", "R2", "R4", "C4", "C3", "R5", "D1"].map((ref) => meta.parts.find((p) => p.ref === ref)!);

const same = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
function onLine(pts: Pt[], p: Pt): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.abs(dist(a, p) + dist(p, b) - dist(a, b)) < 0.01) return true;
  }
  return false;
}
const JUNCTION_WIRES = meta.sch.junctions.map((j) => WIRES.lines.map((w, i) => onLine(w.pts, j.at) ? i : -1).filter((i) => i >= 0));
const POWER_WIRE = meta.sch.power.map((p) => WIRES.lines.findIndex((w) => same(w.pts[0], p.at) || same(w.pts[w.pts.length - 1], p.at)));

export function startStory(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const steps = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
  const track = root.querySelector<HTMLElement>(".story-track")!;
  const still = reducedMotion();
  let g = 0, chapter = -1;
  const p = [0, 0, 0, 0];
  // In the last chapter the board can be turned by dragging; it settles back when let go.
  let turn = 0, turnTo = 0, drag: { x: number; from: number } | null = null;

  let sch: KDoc | null = null, pcb: KDoc | null = null, tex: HTMLCanvasElement | null = null, under: HTMLCanvasElement | null = null;
  const frac = new Map<string, number>();            // how much of each wire / track segment is drawn
  const placed = new Map<string, string>();          // where each footprint was last put
  let symAt: Pt[] = [], cam: Pt | null = null, ratKey = "", rats: Rat[] = [];
  let resting: HTMLCanvasElement | null = null, rest = "";

  function readScroll(): void {
    const r = track.getBoundingClientRect();
    const room = r.height - window.innerHeight;
    g = room > 0 ? clamp(-r.top / room) * 4 : 0;
    // Back above the story: the next visit starts from an empty sheet.
    if (r.top > window.innerHeight * 0.9 && p[0] > 0) { p.fill(0); cam = null; }
    stage.invalidate();
  }

  function setChapter(i: number): void {
    if (i === chapter) return;
    chapter = i;
    steps.forEach((el, k) => { el.classList.toggle("on", k === i); el.classList.toggle("done", k < i); });
    root.dataset.chapter = String(i);
  }

  const stage: Stage = makeStage(canvas, (s, now, dt) => {
    const c = Math.min(3, Math.floor(g));
    setChapter(c);
    let moving = false;
    for (let i = 0; i < 4; i++) {
      const before = p[i];
      if (still) p[i] = i <= c ? 1 : 0;
      else if (g >= i + 1 || (i === 0 && g > 0.8)) p[i] = Math.min(1, p[i] + dt / 1000 * FAST / DUR[i]);
      else if (c === i && (i === 0 || p[i - 1] >= 1)) p[i] = Math.min(1, p[i] + dt / 1000 / DUR[i]);
      if (p[i] !== before || (c >= i && p[i] < 1)) moving = true;
      steps[i].style.setProperty("--p", p[i].toFixed(3));
    }
    if (!drag && c !== 3) turnTo = 0;
    turn = still ? turnTo : turn + (turnTo - turn) * (1 - Math.exp(-dt / 90));
    if (Math.abs(turnTo - turn) < 0.0005) turn = turnTo;
    const blinking = render(s, now, dt);
    return moving || turn !== turnTo || blinking || (cam !== null && camMoving);
  });
  let camMoving = false;

  canvas.addEventListener("pointerdown", (e) => {
    if (chapter !== 3) return;
    drag = { x: e.clientX, from: turnTo };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    turnTo = drag.from + (e.clientX - drag.x) * 0.008;
    stage.invalidate();
  });
  const release = () => { drag = null; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  window.addEventListener("scroll", readScroll, { passive: true });
  window.addEventListener("resize", readScroll);
  readScroll();

  // The chapter list doubles as navigation.
  steps.forEach((el, k) => el.addEventListener("click", () => {
    const r = track.getBoundingClientRect(), room = r.height - window.innerHeight;
    const at = [0.3, 1.5, 2.5, 3.6][k] / 4;
    window.scrollTo({ top: window.scrollY + r.top + room * at, behavior: still ? "auto" : "smooth" });
  }));

  // ------------------------------------------------------------------ drawing

  /** Draw `d` millimetres of a person's lines; returns where their pen is. */
  function drawOn(doc: KDoc, set: { lines: Line[]; total: [number, number] }, who: number, d: number, ids: Set<string>, isSch: boolean): { head: Pt; done: number[] } {
    let head: Pt = [0, 0], seen = false; const done: number[] = [];
    set.lines.forEach((l, li) => {
      if (l.who !== who) return;
      let left = d - l.at;
      if (!seen) { head = l.pts[0]; seen = true; }
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1], b = l.pts[i], len = dist(a, b), f = clamp(left / len), id = l.ids[i - 1];
        left -= len;
        if (f > 0) { ids.add(id); head = [lerp(a[0], b[0], f), lerp(a[1], b[1], f)]; }
        if (frac.get(id) === f) continue;
        frac.set(id, f);
        if (f <= 0) continue;
        const it = doc.items.get(id)!, e: Pt = [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
        if (isSch) K.setPts(it.node, [a, e]); else { const n = K.kid(it.node, "end"); n[1] = e[0]; n[2] = e[1]; }
        K.buildGeom(doc, it);
      }
      if (d >= l.at + l.len - 1e-6) done.push(li);
    });
    return { head, done };
  }

  /** The schematic at progress q: returns the pointers to draw over it. */
  function drawSchematic(s: Stage, ctx: CanvasRenderingContext2D, q: number, dt: number): { view: View; cursors: [Pt, number, number][] } {
    if (!sch) { sch = loadSch(); symAt = meta.sch.symbols.map((m) => { const a = K.atOf(sch!.items.get(m.id)!.node); return [a[0], a[1]] as Pt; }); }
    const ids = new Set<string>(), n = symAt.length;
    // Symbols first, set down one after another.
    const sp = span(q, 0.02, 0.3) * n, placedN = Math.min(n, Math.floor(sp));
    for (let i = 0; i < placedN; i++) ids.add(meta.sch.symbols[i].id);
    const from = symAt[Math.max(0, placedN - 1)], to = symAt[Math.min(n - 1, placedN)];
    let ada: Pt = [lerp(from[0], to[0], ease(sp - placedN)) + 2, lerp(from[1], to[1], ease(sp - placedN)) + 2];
    // Then the wiring, by two people at once.
    const wp = span(q, 0.31, 0.96);
    const a = drawOn(sch, WIRES, 0, wp * WIRES.total[0], ids, true), b = drawOn(sch, WIRES, 1, wp * WIRES.total[1], ids, true);
    const done = new Set([...a.done, ...b.done]);
    meta.sch.power.forEach((pw, i) => { if (done.has(POWER_WIRE[i])) ids.add(pw.id); });
    meta.sch.junctions.forEach((j, i) => { if (JUNCTION_WIRES[i].every((w) => done.has(w))) ids.add(j.id); });
    const notes = span(q, 0.955, 0.985);
    if (notes > 0) ids.add(meta.sch.notes[1]);
    if (notes >= 1) ids.add(meta.sch.notes[0]);
    if (wp > 0) { const k = ease(span(q, 0.31, 0.4)); ada = [lerp(ada[0], 126, k), lerp(ada[1], 92, k)]; }

    // The view follows the work, then steps back to the whole sheet.
    const W = s.w, H = s.h, page: Box = [0, 0, sch.page[0], sch.page[1]];
    let wmm = clamp(W / 6.4, 84, page[2]), hmm = wmm * H / W;
    if (hmm > 74) { hmm = 74; wmm = Math.max(60, hmm * W / H); hmm = wmm * H / W; }
    const focus: Pt = wp > 0 ? [(a.head[0] + b.head[0]) / 2, (a.head[1] + b.head[1]) / 2 - 2] : [ada[0], ada[1] - 4];
    const tx = clamp(focus[0], 14 + wmm / 2, Math.max(14 + wmm / 2, 162 - wmm / 2)), ty = clamp(focus[1], Math.min(60, 28 + hmm / 2), Math.max(60, 97 - hmm / 2));
    if (!cam || still) cam = [tx, ty];
    else { const k = 1 - Math.exp(-dt / 520); cam = [cam[0] + (tx - cam[0]) * k, cam[1] + (ty - cam[1]) * k]; }
    camMoving = Math.abs(tx - cam[0]) + Math.abs(ty - cam[1]) > 0.05 && q < 1;
    const near: Box = [cam[0] - wmm / 2, cam[1] - hmm / 2, cam[0] + wmm / 2, cam[1] + hmm / 2];
    const out = ease(span(q, 0.9, 1));
    const fullView = fit(W, H, s.dpr, [page[0] - 4, page[1] - 4, page[2] + 4, page[3] + 4]);
    const full: Box = [fullView.x0 - fullView.panX / fullView.ppm, fullView.y0 - fullView.panY / fullView.ppm, 0, 0];
    full[2] = full[0] + W / fullView.ppm; full[3] = full[1] + H / fullView.ppm;
    const view = fit(W, H, s.dpr, mixBox(near, full, out));
    K.render(sch, ctx, view, { ids, grid: 1.27 });
    const show = q > 0 ? 1 : 0;
    return { view, cursors: [[a.head, 0, show * span(q, 0.3, 0.33)], [b.head, 1, show * span(q, 0.3, 0.33)], [ada, 2, show]] };
  }

  /** The board with placement at q1 and routing at q2. */
  function drawBoard(s: Stage, ctx: CanvasRenderingContext2D, q1: number, q2: number): { view: View; cursors: [Pt, number, number][] } {
    if (!pcb) pcb = loadPcb();
    const doc = pcb, W = s.w, H = s.h, wide = W / H > 1.15, B = BOARD;
    const pile = (pt: Pt): Pt => wide ? pt : [B.x + 4 + (pt[0] - B.x - 47) * 2.3, B.y + 30 + (pt[1] - B.y - 5) * 0.75];
    const ids = new Set<string>(meta.holes), selected = new Set<string>(), cursors: [Pt, number, number][] = [];
    for (const it of doc.items.values()) if (it.kind !== "segment" && it.kind !== "via" && it.kind !== "zone") ids.add(it.id);

    // Placement: each person's turn is a walk to the pile, then a drag to the spot.
    const mp = span(q1, 0.05, 0.86), per = PLACE.length / 2;
    const hands: Pt[] = [[B.x + B.w + 8, B.y + 2], [B.x + B.w + 14, B.y + B.h - 2]].map((h) => pile(h as Pt));
    PLACE.forEach((part, i) => {
      const who = i % 2, turnN = (i - who) / 2, t = mp * per - turnN;
      const home = pile(part.pile), k = ease(span(t, 0.38, 1));
      const at: Pt = [lerp(home[0], part.x, k), lerp(home[1], part.y, k)];
      const key = at[0].toFixed(3) + "," + at[1].toFixed(3);
      if (placed.get(part.id) !== key) { placed.set(part.id, key); K.moveItem(doc, doc.items.get(part.id), at[0], at[1], 1e6); }
      if (t > 0 && t <= 1) {
        const prev: Pt = turnN > 0 ? [PLACE[i - 2].x, PLACE[i - 2].y] : hands[who], w = ease(span(t, 0, 0.36));
        hands[who] = t < 0.38 ? [lerp(prev[0], home[0], w), lerp(prev[1], home[1], w)] : at;
        if (t >= 0.36 && t < 1) selected.add(part.id);
      } else if (t > 1) hands[who] = [part.x, part.y];
    });

    // Routing.
    const rp = span(q2, 0.03, 0.9);
    const a = drawOn(doc, ROUTES, 0, rp * ROUTES.total[0], ids, false), b = drawOn(doc, ROUTES, 1, rp * ROUTES.total[1], ids, false);
    const done = new Set([...a.done, ...b.done]), whole = new Set<string>();
    for (const li of done) { const r = meta.routes[li]; r.ids.forEach((id) => whole.add(id)); if (r.via) { ids.add(r.via); whole.add(r.via); } }
    const poured = q2 >= 0.93;
    if (poured) ids.add(meta.zone);
    if (q2 > 0) { hands[0] = rp > 0 ? a.head : hands[0]; hands[1] = rp > 0 ? b.head : hands[1]; }

    const key = [...placed.values()].join(";") + "|" + whole.size + "|" + poured;
    if (key !== ratKey) { ratKey = key; rats = ratsnest(doc, { only: whole, poured: poured ? 1 : 0 }); }

    const tight: Box = [B.x - 3, B.y - 3, B.x + B.w + 3, B.y + B.h + 3];
    const loose: Box = wide ? [B.x - 3, B.y - 3, B.x + 66, B.y + B.h + 3] : [B.x - 3, B.y - 3, B.x + B.w + 3, B.y + 48];
    const view = fit(W, H, s.dpr, mixBox(loose, tight, ease(span(q1, 0.88, 1))));
    K.render(doc, ctx, view, { ids, hidden: HIDDEN, grid: 1, ratsnest: rats, selected: selected.size ? selected : null, zoneFill: poured, activeLayer: "F.Cu" });
    const show = q1 > 0 ? span(q1, 0, 0.04) : 0, away = 1 - span(q2, 0.95, 1) * 0;
    cursors.push([hands[0], 0, show * away], [hands[1], 1, show * away]);
    return { view, cursors };
  }

  function render(s: Stage, now: number, dt: number): boolean {
    const { ctx, w: W, h: H, dpr } = s;
    let blinking = false;
    const blend = p[0] >= 1 ? ease(span(g, 0.84, 1)) : g >= 1 ? 1 : 0;
    const pointers = (r: { view: View; cursors: [Pt, number, number][] }, alpha: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [at, who, a] of r.cursors) { const q = toPx(r.view, at[0], at[1]); drawCursor(ctx, q[0], q[1], PEERS[who].name, PEERS[who].color, SANS, a * alpha); }
    };

    if (blend < 1) pointers(drawSchematic(s, ctx, p[0], dt), 1 - blend);
    if (blend <= 0) return false;

    // The board goes onto its own canvas while the sheet is still fading out under it.
    let bctx = ctx;
    if (blend < 1) {
      if (!under) under = document.createElement("canvas");
      if (under.width !== canvas.width || under.height !== canvas.height) { under.width = canvas.width; under.height = canvas.height; }
      bctx = under.getContext("2d")!;
    }
    const q3 = p[2] >= 1 ? p[3] : 0, solid = q3 >= 0.3;
    // Once the fabricated face covers it, the editor view under it is not drawn at all.
    const board = solid ? null : drawBoard(s, bctx, p[1], p[1] >= 1 ? p[2] : 0);
    if (bctx !== ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = blend; ctx.drawImage(under!, 0, 0); ctx.globalAlpha = 1; }
    if (board) pointers(board, blend * (1 - span(q3, 0, 0.12)));
    if (q3 <= 0) return false;
    const ppm = fit(W, H, dpr, [BOARD.x - 3, BOARD.y - 3, BOARD.x + BOARD.w + 3, BOARD.y + BOARD.h + 3]).ppm;

    // The finished board: the editor view gives way to the fabricated face, which then tilts.
    if (!tex) tex = boardTexture(loadPcb());
    const fade = ease(span(q3, 0, 0.3)), tilt = ease(span(q3, 0.2, 0.82)), rise = easeOut(span(q3, 0.52, 0.97));
    const c: Cam = { cx: BOARD.x + BOARD.w / 2, cy: BOARD.y + BOARD.h / 2, scale: ppm * lerp(1, 0.86, tilt), yaw: -0.5 * tilt + turn, pitch: 0.98 * tilt, ox: W / 2, oy: H / 2 + tilt * H * 0.035 };
    const scene = (to: CanvasRenderingContext2D) => {
      to.setTransform(dpr, 0, 0, dpr, 0, 0);
      to.globalAlpha = fade; to.fillStyle = PCB_BG; to.fillRect(0, 0, W, H);
      const gr = to.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
      gr.addColorStop(0, `rgba(46,74,112,${0.5 * tilt})`); gr.addColorStop(1, "rgba(0,16,35,0)");
      to.fillStyle = gr; to.fillRect(0, 0, W, H); to.globalAlpha = 1;
      drawSlab(to, c, fade);
      drawFace(to, c, dpr, tex!, fade);
      to.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBodies(to, c, rise, fade, MONO);
    };
    if (q3 < 1 || turn !== turnTo || drag) { scene(ctx); rest = ""; return false; }
    // At rest only the LED changes, so the board is kept as a picture and the light drawn over it.
    const key = `${canvas.width}x${canvas.height}:${turn.toFixed(4)}`;
    if (!resting) resting = document.createElement("canvas");
    if (rest !== key) { resting.width = canvas.width; resting.height = canvas.height; scene(resting.getContext("2d")!); rest = key; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(resting, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let led = 1;
    if (!still) { const ph = (now / 1000 * 1.38) % 1; led = ph < 0.5 ? easeOut(span(ph, 0, 0.06)) : 1 - easeOut(span(ph, 0.5, 0.58)); blinking = chapter === 3; }
    drawLed(ctx, c, led);
    return blinking;
  }
}
