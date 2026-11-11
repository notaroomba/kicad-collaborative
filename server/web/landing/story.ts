// The scroll story: one design carried from schematic to placed, routed and fabricated, with
// scroll position as the only clock.  `g` runs 0..4 across the four chapters.

import {
  BOARD, BoardState, Cam, COL, PARTS, PART, Part, Pt, SHEET, TOTAL_LEN, TRACKS,
  clamp, drawBoard, drawBodies, drawCursor, drawFootprint, drawSheet, drawSlab, drawSymbol, ease, easeOut, lerp, mix,
  partial, planeTransform, project, span,
} from "./board";
import { MONO, SANS, Stage, makeStage, reducedMotion } from "./stage";

const PEERS = { ada: ["Ada", "#D9822B"], mara: ["Mara", "#A45BD6"], jun: ["Jun", "#149C94"] } as const;

// Placement order, and who places what.
const PLACE = ["J1", "U1", "C1", "R1", "C2", "R2", "R3", "C4", "R4", "R5", "C3", "D1"];
const WIN = 0.16;                                         // share of the chapter one move takes
const startOf = (i: number) => (i / PLACE.length) * (1 - WIN);

// Cumulative track lengths, for drawing them on in order.
const TRACK_AT: number[] = [];
{ let s = 0; for (const t of TRACKS) { TRACK_AT.push(s); s += t.len; } }

export function startStory(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const steps = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
  const track = root.querySelector<HTMLElement>(".story-track")!;
  const still = reducedMotion();
  let target = 0, g = 0, chapter = -1;
  // In the last chapter the board can be turned by dragging; it settles back when let go.
  let turn = 0, turnTo = 0, drag: { x: number; from: number } | null = null;

  function readScroll(): void {
    const r = track.getBoundingClientRect();
    const room = r.height - window.innerHeight;
    target = room > 0 ? clamp(-r.top / room) * 4 : 0;
    stage.invalidate();
  }

  function setChapter(i: number): void {
    if (i === chapter) return;
    chapter = i;
    steps.forEach((el, k) => { el.classList.toggle("on", k === i); el.classList.toggle("done", k < i); });
    root.dataset.chapter = String(i);
  }

  const stage: Stage = makeStage(canvas, (s, now, dt) => {
    // Ease toward the scroll position so wheel steps do not show as jumps.
    if (still) g = target; else { g += (target - g) * (1 - Math.exp(-dt / 110)); if (Math.abs(target - g) < 0.0004) g = target; }
    setChapter(g < 0.93 ? 0 : g < 2.02 ? 1 : g < 2.97 ? 2 : 3);
    const local = [span(g, 0, 0.93), span(g, 0.93, 2.02), span(g, 2.02, 2.97), span(g, 2.97, 4)];
    steps.forEach((el, k) => el.style.setProperty("--p", local[k].toFixed(3)));
    if (!drag && chapter !== 3) turnTo = 0;
    turn = still ? turnTo : turn + (turnTo - turn) * (1 - Math.exp(-dt / 90));
    if (Math.abs(turnTo - turn) < 0.0005) turn = turnTo;
    const blinking = render(s, g, now, still, turn);
    return g !== target || turn !== turnTo || blinking;
  });

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
    const at = [0.3, 1.7, 2.9, 3.75][k] / 4;
    window.scrollTo({ top: window.scrollY + r.top + room * at, behavior: still ? "auto" : "smooth" });
  }));
}

function render(s: Stage, g: number, now: number, still: boolean, turn: number): boolean {
  const { ctx, w: W, h: H, dpr } = s;
  const morph = span(g, 0.85, 1.3);
  const tilt = ease(span(g, 3.0, 3.5));

  // ---- background: schematic paper, then the board canvas
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = ease(span(morph, 0.45, 1));
  ctx.fillStyle = mix(COL.schBg, COL.canvas, dark);
  ctx.fillRect(0, 0, W, H);
  if (tilt > 0) {
    const gr = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
    gr.addColorStop(0, `rgba(46,74,112,${0.5 * tilt})`); gr.addColorStop(1, "rgba(0,16,35,0)");
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }

  // ---- cameras
  const pad = Math.min(W, H) * 0.045;
  const fit = (vw: number, vh: number) => Math.min((W - pad * 2) / vw, (H - pad * 2) / vh);
  const sSch = fit(SHEET.w, SHEET.h);
  const schX = (x: number) => W / 2 + (x - (SHEET.x + SHEET.w / 2)) * sSch, schY = (y: number) => H / 2 + (y - (SHEET.y + SHEET.h / 2)) * sSch;
  const zoomIn = ease(span(g, 1.78, 2.06));
  const wide = W / H > 1.15;
  // Before placement the parts sit in a pile beside the outline (wide canvas) or below it.
  const pile = (p: Part): Pt => wide ? p.cl : [p.cl[0] - 55 + 21, p.cl[1] + 27];
  const clusterView = wide ? { cx: 32.5, cy: 14.5, w: 71, h: 34 } : { cx: 21, cy: 28.5, w: 46, h: 62 };
  const boardView = { cx: BOARD.w / 2, cy: BOARD.h / 2, w: BOARD.w + 3, h: BOARD.h + 3 };
  const s0 = fit(clusterView.w, clusterView.h), s1 = fit(boardView.w, boardView.h);
  const s3 = Math.min((W - pad * 2) / 50, (H - pad * 2) / 38);
  const cam: Cam = {
    cx: lerp(clusterView.cx, boardView.cx, zoomIn), cy: lerp(clusterView.cy, boardView.cy, zoomIn),
    scale: lerp(lerp(s0, s1, zoomIn), s3, tilt),
    yaw: tilt * -0.62 + ease(span(g, 3.35, 4)) * 0.9 + turn * tilt, pitch: tilt * 0.98,
    ox: W / 2, oy: H / 2 + tilt * H * 0.03,
  };

  // ---- chapter 1: the schematic
  const sheetFade = 1 - span(g, 0.8, 0.98);
  let cursor: { at: Pt; who: readonly [string, string]; a: number } | null = null;
  if (sheetFade > 0) {
    ctx.setTransform(dpr * sSch, 0, 0, dpr * sSch, dpr * schX(0), dpr * schY(0));
    const build = span(g, 0.02, 0.74);
    const { head } = drawSheet(ctx, build, sheetFade, MONO);
    if (head) cursor = { at: [schX(head[0]), schY(head[1])], who: PEERS.ada, a: sheetFade };
  }

  // ---- the board plane
  const boardIn = span(morph, 0.55, 1);
  const q = span(g, 1.3, 1.98);                     // placement
  const rt = span(g, 2.06, 2.84);                   // routing
  const real = span(g, 3.0, 3.3);
  const pos: Record<string, Pt> = {};
  const hide: Record<string, boolean> = {};
  let dragging: { p: Part; at: Pt; who: readonly [string, string] } | null = null;
  PLACE.forEach((ref, i) => {
    const p = PART[ref], k = ease(span(q, startOf(i), startOf(i) + WIN)), from = pile(p);
    pos[ref] = [lerp(from[0], p.x, k), lerp(from[1], p.y, k)];
    if (k > 0 && k < 1) dragging = { p, at: pos[ref], who: i % 2 ? PEERS.jun : PEERS.mara };
    if (morph < 1) hide[ref] = true;
  });
  const st: BoardState = {
    pos, hide,
    trackT: (i) => clamp((rt * TOTAL_LEN - TRACK_AT[i]) / TRACKS[i].len),
    zone: span(g, 2.84, 2.95), rats: span(morph, 0.85, 1) * (1 - span(g, 2.84, 2.9)), real,
    outline: boardIn, silk: boardIn, mono: MONO, bodies3d: true,
  };

  if (boardIn > 0) {
    drawSlab(ctx, cam, tilt, "rgba(0,0,0,0.5)");
    planeTransform(ctx, cam, dpr);
    // Grid dots, as on the editor canvas.
    if (real < 1 && morph >= 1) {
      ctx.fillStyle = `rgba(132,150,176,${0.28 * (1 - real)})`;
      const step = 2.54, r = 0.06 + 0.5 / cam.scale;
      for (let x = -step * 6; x < BOARD.w + step * 14; x += step) for (let y = -step * 14; y < BOARD.h + step * 16; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    ctx.save(); ctx.globalAlpha = 1; drawBoard(ctx, st); ctx.restore();
    if (dragging) {
      // The part someone is moving is outlined in their colour.
      const d = dragging as { p: Part; at: Pt; who: readonly [string, string] };
      const bw = Math.max(d.p.bw, ...d.p.pads.map((x) => Math.abs(x.dx) * 2 + x.w)) + 0.8, bh = Math.max(d.p.bh, ...d.p.pads.map((x) => Math.abs(x.dy) * 2 + x.h)) + 0.8;
      ctx.strokeStyle = d.who[1]; ctx.lineWidth = 0.16;
      ctx.strokeRect(d.at[0] - bw / 2, d.at[1] - bh / 2, bw, bh);
    }
  }

  // ---- the morph: each symbol travels to where its footprint first lands
  if (morph < 1) {
    const k = ease(morph);
    for (const p of PARTS) {
      const to = project(cam, pile(p)[0], pile(p)[1], 0);
      const x = lerp(schX(p.sch[0]), to[0], k), y = lerp(schY(p.sch[1]), to[1], k);
      const symA = 1 - span(morph, 0.12, 0.42), fpA = span(morph, 0.22, 0.52);
      if (symA > 0) {
        const sc = sSch * lerp(1, 0.55, k);
        ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * x, dpr * y);
        ctx.globalAlpha = symA; drawSymbol(ctx, p, MONO); ctx.globalAlpha = 1;
      }
      if (fpA > 0) {
        ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * x, dpr * y);
        drawFootprint(ctx, p, { ...st, silk: fpA }, fpA);
      }
    }
  }

  // ---- 3D bodies
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rise = easeOut(span(g, 3.18, 3.6));
  const lit = g > 3.4;
  const ledOn = !lit ? 0 : still ? 1 : (now % 1100) < 520 ? 1 : 0;
  drawBodies(ctx, cam, rise, span(g, 3.15, 3.3), ledOn);

  // ---- collaborators
  if (dragging) {
    const d = dragging as { p: Part; at: Pt; who: readonly [string, string] };
    cursor = { at: project(cam, d.at[0] + 0.5, d.at[1] + 0.4, 0), who: d.who, a: 1 };
  } else if (q > 0 && q < 1) {
    // Between moves: glide from the last drop to the next pick-up.
    let prev = -1;
    PLACE.forEach((_, i) => { if (startOf(i) + WIN <= q) prev = i; });
    const next = prev + 1;
    if (next < PLACE.length) {
      const a = prev >= 0 ? PART[PLACE[prev]] : null, b = PART[PLACE[next]];
      const from: Pt = a ? [a.x, a.y] : [pile(b)[0] + 6, pile(b)[1] - 8], to = pile(b);
      const t0 = prev >= 0 ? startOf(prev) + WIN : 0, k = ease(span(q, t0, startOf(next)));
      cursor = { at: project(cam, lerp(from[0], to[0], k) + 0.5, lerp(from[1], to[1], k) + 0.4, 0), who: next % 2 ? PEERS.jun : PEERS.mara, a: 1 };
    }
  } else if (rt > 0 && rt < 1) {
    for (let i = 0; i < TRACKS.length; i++) {
      const k = st.trackT(i);
      if (k > 0 && k < 1) { const h = partial(TRACKS[i].pts, k).head; cursor = { at: project(cam, h[0], h[1], 0), who: PEERS.jun, a: 1 }; break; }
    }
  }
  if (cursor) drawCursor(ctx, cursor.at[0], cursor.at[1], cursor.who[0], cursor.who[1], SANS, cursor.a);

  return lit && !still;
}
