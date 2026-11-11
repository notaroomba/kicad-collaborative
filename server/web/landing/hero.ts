// The hero: the demo board mid-design, with three scripted collaborators finishing it on a
// loop.  The visitor's own pointer joins in: parts highlight under it and the status bar
// reads out its position, as the editor's does.

import {
  BOARD, BoardState, Cam, COL, PARTS, PART, Part, Pt, TRACKS,
  drawBoard, drawCursor, ease, lerp, partial, planeTransform, project, span,
} from "./board";
import { MONO, SANS, Stage, makeStage, reducedMotion } from "./stage";

const ADA = ["Ada", "#D9822B"] as const, MARA = ["Mara", "#A45BD6"] as const, JUN = ["Jun", "#149C94"] as const;
const LOOP = 17.5;
const D1_FROM: Pt = [31.6, 23.1];
const NOTE = "10u on C3 blinks at about 1.4 Hz. Keep it?";
const REPLY = "Keep it.";

/** A pointer path: [time, x, y] keys in board millimetres, eased between. */
type Key = [number, number, number];
function along(keys: Key[], t: number): Pt {
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) { const a = keys[i - 1], b = keys[i], k = ease(span(t, a[0], b[0])); return [lerp(a[1], b[1], k), lerp(a[2], b[2], k)]; }
  }
  const l = keys[keys.length - 1];
  return [l[1], l[2]];
}

const D1 = PART.D1;
const JUN_PATH: Key[] = [[0, 39.5, 25.5], [1.2, D1_FROM[0] + 0.5, D1_FROM[1] + 0.4], [1.6, D1_FROM[0] + 0.5, D1_FROM[1] + 0.4], [3.0, D1.x + 0.5, D1.y + 0.4], [3.6, D1.x + 0.5, D1.y + 0.4], [5.6, 39.6, 9.2], [10.4, 39.2, 9.6], [11.2, 38.6, 13.4], [14.5, 38.9, 13.2], [16.6, 39.5, 25.5]];
const ADA_PATH: Key[] = [[0, 30, -3], [6.0, 33, 2], [7.4, 38.4, 16.6], [10.2, 38.6, 16.9], [12, 34, 21.5], [15, 33.5, 21], [17, 30, -3]];
const MARA_IDLE: Key[] = [[0, 12, 5.5], [2.0, 13, 5], [3.4, 24.3, 14.635]];
const MARA_AFTER: Key[] = [[8.6, 27.5, 22.5], [10, 14, 19.5], [13.5, 13, 20.5], [16, 12.5, 6], [17.5, 12, 5.5]];

export function startHero(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const xy = root.querySelector<HTMLElement>("[data-xy]");
  const still = reducedMotion();
  let t0 = 0, pointer: Pt | null = null, cam: Cam | null = null;

  const stage: Stage = makeStage(canvas, (s, now) => {
    if (!t0) t0 = now;
    const t = still ? 13.6 : ((now - t0) / 1000 + 0.8) % LOOP;
    cam = render(s, t, pointer);
    return !still;
  });

  function toBoard(e: PointerEvent): Pt | null {
    if (!cam) return null;
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left - cam.ox) / cam.scale + cam.cx, (e.clientY - r.top - cam.oy) / cam.scale + cam.cy];
  }
  canvas.addEventListener("pointermove", (e) => {
    pointer = toBoard(e);
    if (pointer && xy) xy.textContent = `X ${pointer[0].toFixed(2)}  Y ${pointer[1].toFixed(2)}`;
    stage.invalidate();
  });
  canvas.addEventListener("pointerleave", () => { pointer = null; if (xy) xy.textContent = "X --.--  Y --.--"; stage.invalidate(); });
}

function render(s: Stage, t: number, pointer: Pt | null): Cam {
  const { ctx, w: W, h: H, dpr } = s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.canvas; ctx.fillRect(0, 0, W, H);

  const scale = Math.min((W - 28) / (BOARD.w + 3), (H - 28) / (BOARD.h + 3));
  const cam: Cam = { cx: BOARD.w / 2, cy: BOARD.h / 2, scale, yaw: 0, pitch: 0, ox: W / 2, oy: H / 2 };

  // The loop ends by undoing itself: tracks retract and the LED goes back where it was.
  const undo = span(t, 15.4, 16.9);
  const live = 1 - span(t, 15.0, 15.5);                    // comment and selections
  const dragK = ease(span(t, 1.6, 3.0)) * (1 - ease(undo));
  const d1: Pt = [lerp(D1_FROM[0], D1.x, dragK), lerp(D1_FROM[1], D1.y, dragK)];
  const routed = (a: number, b: number) => span(t, a, b) * (1 - undo);
  const tOut = routed(3.4, 5.3), tLed = routed(5.8, 7.5), tGnd = routed(8.0, 8.5);

  const st: BoardState = {
    pos: { D1: d1 },
    trackT: (i) => i === 25 ? tOut : i === 26 ? tLed : i === 27 ? tGnd : 1,
    zone: 1, rats: 1, real: 0, outline: 1, silk: 1, mono: MONO,
  };

  planeTransform(ctx, cam, dpr);
  // Grid.
  ctx.fillStyle = "rgba(132,150,176,0.3)";
  const step = 2.54, r = 0.05 + 0.6 / scale;
  const gx0 = Math.floor((cam.cx - W / 2 / scale) / step) * step, gy0 = Math.floor((cam.cy - H / 2 / scale) / step) * step;
  for (let x = gx0; x < cam.cx + W / 2 / scale; x += step) for (let y = gy0; y < cam.cy + H / 2 / scale; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  drawBoard(ctx, st);

  // A track being routed shows in its author's colour until it is committed.
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const preview = (i: number, k: number) => {
    if (k <= 0 || k >= 1 || undo > 0) return;
    const pts = partial(TRACKS[i].pts, k).pts;
    ctx.strokeStyle = MARA[1]; ctx.globalAlpha = 0.9; ctx.lineWidth = 0.62;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
    ctx.strokeStyle = COL.fcu; ctx.globalAlpha = 1; ctx.lineWidth = 0.3;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
  };
  preview(25, tOut); preview(26, tLed); preview(27, tGnd);

  // Jun's selection: the outline follows the part, a dashed ghost marks where it came from.
  const sel = span(t, 1.2, 1.5) * (1 - span(t, 3.6, 4.2));
  const outlineOf = (p: Part, at: Pt, pad = 0.45) => {
    const hw = Math.max(p.bw / 2, ...p.pads.map((x) => Math.abs(x.dx) + x.w / 2)) + pad, hh = Math.max(p.bh / 2, ...p.pads.map((x) => Math.abs(x.dy) + x.h / 2)) + pad;
    ctx.strokeRect(at[0] - hw, at[1] - hh, hw * 2, hh * 2);
  };
  if (sel > 0) {
    ctx.strokeStyle = JUN[1]; ctx.lineWidth = 0.15; ctx.globalAlpha = sel; outlineOf(D1, d1);
    if (dragK > 0.02 && dragK < 1) { ctx.setLineDash([0.45, 0.35]); ctx.globalAlpha = sel * 0.7; outlineOf(D1, D1_FROM); ctx.setLineDash([]); }
    ctx.globalAlpha = 1;
  }

  // The visitor's hover.
  let hover: Part | null = null;
  if (pointer) for (const p of PARTS) {
    const c = p.ref === "D1" ? d1 : [p.x, p.y];
    const hw = Math.max(p.bw / 2, ...p.pads.map((x) => Math.abs(x.dx) + x.w / 2)) + 0.3, hh = Math.max(p.bh / 2, ...p.pads.map((x) => Math.abs(x.dy) + x.h / 2)) + 0.3;
    if (Math.abs(pointer[0] - c[0]) <= hw && Math.abs(pointer[1] - c[1]) <= hh) { hover = p; ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 0.12; ctx.globalAlpha = 0.9; outlineOf(p, c as Pt, 0.3); ctx.globalAlpha = 1; break; }
  }

  // ---- screen space: comment, cursors, hover label
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const at = (x: number, y: number) => project(cam, x, y, 0);

  // Ada's comment pin and its thread.
  const pinIn = span(t, 7.4, 7.7) * live;
  if (pinIn > 0) {
    const [px, py] = at(38.3, 16.5);
    ctx.globalAlpha = pinIn;
    ctx.fillStyle = ADA[1]; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py - 9 - (1 - pinIn) * 8, 8, Math.PI * 0.75, Math.PI * 2.25); ctx.lineTo(px, py); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `600 9px ${SANS}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("1", px, py - 9);
    const typed = NOTE.slice(0, Math.round(NOTE.length * span(t, 7.8, 9.9)));
    const reply = span(t, 11.2, 11.5);
    if (typed) {
      ctx.font = `400 12px ${SANS}`;
      const bw = Math.min(250, Math.max(190, W * 0.3)), lines = wrap(ctx, typed, bw - 24);
      const bh = 30 + lines.length * 16 + (reply > 0 ? 38 : 0);
      let bx = px - bw - 14, by = py - 26;
      if (bx < 8) { bx = Math.max(8, px - bw / 2); by = py + 10; }
      if (by + bh > H - 8) by = H - 8 - bh;
      ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
      ctx.fillStyle = "#F7F6F1"; roundRect(ctx, bx, by, bw, bh, 5); ctx.fill();
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.textAlign = "left";
      ctx.fillStyle = ADA[1]; ctx.font = `600 11px ${SANS}`; ctx.fillText("Ada", bx + 12, by + 15);
      ctx.fillStyle = "#1B1B1B"; ctx.font = `400 12px ${SANS}`;
      lines.forEach((l, i) => ctx.fillText(l, bx + 12, by + 33 + i * 16));
      if (reply > 0) {
        const ry = by + 30 + lines.length * 16;
        ctx.globalAlpha = pinIn * reply;
        ctx.strokeStyle = "#D9D7CF"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(bx + 12, ry); ctx.lineTo(bx + bw - 12, ry); ctx.stroke();
        ctx.fillStyle = JUN[1]; ctx.font = `600 11px ${SANS}`; ctx.fillText("Jun", bx + 12, ry + 13);
        ctx.fillStyle = "#1B1B1B"; ctx.font = `400 12px ${SANS}`; ctx.fillText(REPLY, bx + 12, ry + 28);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Mara routes; her pointer rides the head of the track.
  let mara: Pt;
  const head = (i: number, k: number) => partial(TRACKS[i].pts, k).head;
  if (t < 3.4) mara = along(MARA_IDLE, t);
  else if (t < 5.3) mara = head(25, span(t, 3.4, 5.3));
  else if (t < 5.8) { const a = head(25, 1), b = TRACKS[26].pts[0], k = ease(span(t, 5.3, 5.8)); mara = [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }
  else if (t < 7.5) mara = head(26, span(t, 5.8, 7.5));
  else if (t < 8.0) { const a = head(26, 1), b = TRACKS[27].pts[0], k = ease(span(t, 7.5, 8.0)); mara = [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }
  else if (t < 8.6) mara = head(27, span(t, 8.0, 8.5));
  else mara = along(MARA_AFTER, t);
  const jun = t < 1.6 || t > 3.0 ? along(JUN_PATH, t) : [d1[0] + 0.5, d1[1] + 0.4] as Pt;
  const ada = along(ADA_PATH, t);
  const cur = (p: Pt, who: readonly [string, string]) => { const q = at(p[0], p[1]); drawCursor(ctx, q[0], q[1], who[0], who[1], SANS); };
  cur(mara, MARA); cur(jun, JUN); cur(ada, ADA);

  if (pointer) {
    const q = at(pointer[0], pointer[1]);
    const label = hover ? `${hover.ref}  ${hover.val}` : "You";
    ctx.font = `500 11px ${hover ? MONO : SANS}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const w = ctx.measureText(label).width + 12;
    const x = Math.min(q[0] + 14, W - w - 6), y = q[1] + 16;
    ctx.fillStyle = hover ? "#F7F6F1" : COL.fcu; roundRect(ctx, x, y, w, 18, 3); ctx.fill();
    ctx.fillStyle = hover ? "#1B1B1B" : "#fff"; ctx.fillText(label, x + 6, y + 9.5);
  }
  return cam;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, s: string, width: number): string[] {
  const out: string[] = []; let line = "";
  for (const word of s.split(" ")) {
    const next = line ? line + " " + word : word;
    if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}
