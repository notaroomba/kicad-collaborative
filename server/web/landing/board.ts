// The demo design the landing page draws: a USB-C powered 555 LED blinker, as a schematic and
// as a two-layer board.  Everything here is data plus pure canvas drawing; the hero and the
// scroll story decide what state to draw it in.
//
// Board coordinates are millimetres, origin at the board's top-left corner.  Schematic
// coordinates are sheet units (one unit is a 50 mil grid step).

export type Pt = [number, number];

export const BOARD = { w: 42, h: 27, r: 2, thick: 1.6 };
export const HOLES: Pt[] = [[3.5, 3.5], [38.5, 3.5], [3.5, 23.5], [38.5, 23.5]];

export interface Pad { dx: number; dy: number; w: number; h: number; net: string; th?: boolean }
export interface Box { x: number; y: number; w: number; h: number; z0: number; z1: number; top: string; side: string }
export type SymKind = "conn" | "r" | "c" | "led" | "ic";
export interface Part {
  ref: string; val: string; kind: SymKind;
  x: number; y: number;              // board centre
  bw: number; bh: number;            // body outline on the board
  pads: Pad[];
  label: Pt;                         // silkscreen reference, relative to the centre
  boxes: Box[];                      // 3D body
  sch: Pt; horiz?: boolean; left?: boolean;   // schematic centre, orientation, label side
  cl: Pt;                            // where the part lands after "update board from schematic"
}

const SILVER = "#C5C8CC", SILVER_S = "#8E9297";

function chip(ref: string, val: string, kind: "r" | "c" | "led", size: "0603" | "0805", x: number, y: number, vert: boolean,
              n1: string, n2: string, label: Pt, sch: Pt, cl: Pt, horiz = false, left = false): Part {
  const big = size === "0805";
  const pitch = big ? 1.0 : 0.8, pl = big ? 1.0 : 0.8, pw = big ? 1.3 : 0.9;
  const len = big ? 2.0 : 1.6, wid = big ? 1.25 : 0.8, hgt = kind === "r" ? 0.45 : kind === "led" ? 0.75 : big ? 1.0 : 0.8;
  const pad = (s: number, net: string): Pad => vert ? { dx: 0, dy: s * pitch, w: pw, h: pl, net } : { dx: s * pitch, dy: 0, w: pl, h: pw, net };
  const body = kind === "r" ? ["#1B1B1E", "#0E0E10"] : kind === "c" ? ["#B79A68", "#8A7147"] : ["#F4EED8", "#CFC8AE"];
  const cap = len * 0.22;
  const seg = (c: number, l: number, top: string, side: string, z1: number): Box =>
    vert ? { x: 0, y: c, w: wid, h: l, z0: 0, z1, top, side } : { x: c, y: 0, w: l, h: wid, z0: 0, z1, top, side };
  const boxes = [
    seg(-(len - cap) / 2, cap, SILVER, SILVER_S, hgt),
    seg(0, len - 2 * cap, body[0], body[1], hgt + (kind === "r" ? 0.03 : 0)),
    seg((len - cap) / 2, cap, SILVER, SILVER_S, hgt),
  ];
  return { ref, val, kind, x, y, bw: vert ? wid : len, bh: vert ? len : wid, pads: [pad(-1, n1), pad(1, n2)], label, boxes, sch, cl, horiz, left };
}

const U1_PADS: Pad[] = (() => {
  const nets = ["GND", "TRIG", "OUT", "+5V", "CTRL", "THR", "DIS", "+5V"];
  const ys = [-1.905, -0.635, 0.635, 1.905];
  const out: Pad[] = [];
  for (let i = 0; i < 4; i++) out.push({ dx: -2.7, dy: ys[i], w: 1.6, h: 0.6, net: nets[i] });
  for (let i = 0; i < 4; i++) out.push({ dx: 2.7, dy: ys[3 - i], w: 1.6, h: 0.6, net: nets[4 + i] });
  return out;
})();

export const PARTS: Part[] = [
  {
    ref: "J1", val: "USB-C", kind: "conn", x: 3.75, y: 14, bw: 7.5, bh: 9.4,
    pads: [
      { dx: 1.25, dy: -4.5, w: 1.6, h: 0.9, net: "GND" }, { dx: 1.25, dy: -2.7, w: 1.6, h: 0.9, net: "+5V" },
      { dx: 1.25, dy: -0.9, w: 1.6, h: 0.9, net: "CC1" }, { dx: 1.25, dy: 0.9, w: 1.6, h: 0.9, net: "CC2" },
      { dx: 1.25, dy: 2.7, w: 1.6, h: 0.9, net: "+5V" }, { dx: 1.25, dy: 4.5, w: 1.6, h: 0.9, net: "GND" },
      { dx: -0.75, dy: -6.4, w: 1.7, h: 1.7, net: "GND", th: true }, { dx: -0.75, dy: 6.4, w: 1.7, h: 1.7, net: "GND", th: true },
    ],
    label: [5.4, -6.6],
    boxes: [{ x: -1.55, y: 0, w: 6.8, h: 8.9, z0: 0, z1: 3.1, top: "#D4D7DB", side: "#9A9EA4" }],
    sch: [15, 34], cl: [50, 7.5],
  },
  chip("R1", "5k1", "r", "0603", 11.5, 13.1, false, "CC1", "GND", [0, -1.25], [40, 45], [47, 17.5]),
  chip("R2", "5k1", "r", "0603", 11.5, 14.9, false, "CC2", "GND", [0, 1.35], [32, 45], [52, 17.5]),
  chip("C1", "10u", "c", "0805", 17, 10.8, true, "+5V", "GND", [-1.75, 0.4], [44, 31], [57, 17.5]),
  chip("C2", "100n", "c", "0603", 20.5, 10.6, true, "+5V", "GND", [1.9, -1.65], [52, 31], [62, 17.5]),
  {
    ref: "U1", val: "NE555", kind: "ic", x: 27, y: 14, bw: 3.9, bh: 4.9, pads: U1_PADS, label: [0, -3.55],
    boxes: [
      { x: 0, y: 0, w: 3.9, h: 4.9, z0: 0.1, z1: 1.5, top: "#1D1D20", side: "#0D0D0F" },
      ...U1_PADS.map((p): Box => ({ x: p.dx * 0.86, y: p.dy, w: 1.0, h: 0.4, z0: 0, z1: 0.25, top: SILVER, side: SILVER_S })),
    ],
    sch: [81, 43], cl: [60, 8],
  },
  chip("R3", "10k", "r", "0603", 33, 12.095, false, "+5V", "DIS", [0, -1.25], [66, 29], [47, 22.5], false, true),
  chip("R4", "47k", "r", "0603", 36.3, 12.895, true, "DIS", "THR", [1.75, 0], [66, 43], [52, 22.5], false, true),
  chip("C3", "10u", "c", "0805", 36.3, 17.2, true, "THR", "GND", [1.95, 0], [66, 57], [57, 22.5], false, true),
  chip("C4", "10n", "c", "0603", 33, 15.905, false, "CTRL", "GND", [-0.2, 1.35], [98, 57], [62, 22.5]),
  chip("R5", "330", "r", "0603", 20.5, 19.4, true, "OUT", "LED_A", [-1.75, 0], [103, 38], [52, 27.5], true),
  chip("D1", "LED", "led", "0805", 25.1, 22.5, false, "LED_A", "GND", [0, -1.5], [112, 45], [58, 27.5], false, true),
];
export const PART: Record<string, Part> = Object.fromEntries(PARTS.map((p) => [p.ref, p]));

export interface Track { net: string; layer: "F" | "B"; pts: Pt[]; a?: string; b?: string; len: number }
function tk(net: string, layer: "F" | "B", pts: Pt[], a?: string, b?: string): Track {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { net, layer, pts, a, b, len };
}
/** In routing order.  `a`/`b` name the parts an airwire joins until the track exists. */
export const TRACKS: Track[] = [
  tk("CC1", "F", [[5, 13.1], [10.7, 13.1]], "J1", "R1"),
  tk("CC2", "F", [[5, 14.9], [10.7, 14.9]], "J1", "R2"),
  tk("GND", "F", [[12.3, 13.1], [13.6, 13.1]]),
  tk("GND", "F", [[12.3, 14.9], [13.6, 14.9]]),
  tk("+5V", "F", [[5, 11.3], [7.2, 11.3], [8.7, 9.8], [17, 9.8]], "J1", "C1"),
  tk("+5V", "F", [[17, 9.8], [20.5, 9.8]], "C1", "C2"),
  tk("+5V", "F", [[20.5, 9.8], [28.6, 9.8], [29.7, 10.9], [29.7, 12.095]], "C2", "U1"),
  tk("+5V", "F", [[5, 16.7], [7.2, 16.7]]),
  tk("+5V", "B", [[7.2, 16.7], [7.2, 11.3]]),
  tk("GND", "F", [[5, 9.5], [4.2, 9.5], [3, 8.3], [3, 7.6]]),
  tk("GND", "F", [[5, 18.5], [4.2, 18.5], [3, 19.7], [3, 20.4]]),
  tk("GND", "F", [[17, 11.8], [17, 13.2]]),
  tk("GND", "F", [[20.5, 11.4], [20.5, 12.7]]),
  tk("GND", "F", [[24.3, 12.095], [23.2, 12.095], [22.4, 11.295]]),
  tk("+5V", "F", [[29.7, 12.095], [32.2, 12.095]], "U1", "R3"),
  tk("+5V", "F", [[24.3, 15.905], [25.4, 15.905], [29.21, 12.095], [29.7, 12.095]]),
  tk("DIS", "F", [[29.7, 13.365], [32.53, 13.365], [33.8, 12.095]], "U1", "R3"),
  tk("DIS", "F", [[33.8, 12.095], [36.3, 12.095]], "R3", "R4"),
  tk("THR", "F", [[29.7, 14.635], [35.36, 14.635], [36.3, 13.695]], "U1", "R4"),
  tk("THR", "F", [[36.3, 13.695], [36.3, 16.2]], "R4", "C3"),
  tk("TRIG", "F", [[24.3, 13.365], [22.7, 13.365]]),
  tk("TRIG", "B", [[22.7, 13.365], [23.97, 14.635], [31.1, 14.635]]),
  tk("CTRL", "F", [[29.7, 15.905], [32.2, 15.905]], "U1", "C4"),
  tk("GND", "F", [[33.8, 15.905], [33.8, 17.3]]),
  tk("GND", "F", [[36.3, 18.2], [36.3, 19.6]]),
  tk("OUT", "F", [[24.3, 14.635], [22.5, 14.635], [20.5, 16.635], [20.5, 18.6]], "U1", "R5"),
  tk("LED_A", "F", [[20.5, 20.2], [20.5, 21.6], [21.4, 22.5], [24.1, 22.5]], "R5", "D1"),
  tk("GND", "F", [[26.1, 22.5], [27.5, 22.5]]),
];
export const TOTAL_LEN = TRACKS.reduce((s, t) => s + t.len, 0);

/** Vias appear when track `after` is finished. */
export const VIAS: { x: number; y: number; after: number }[] = [
  { x: 13.6, y: 13.1, after: 2 }, { x: 13.6, y: 14.9, after: 3 }, { x: 7.2, y: 11.3, after: 4 }, { x: 7.2, y: 16.7, after: 7 },
  { x: 17, y: 13.2, after: 11 }, { x: 20.5, y: 12.7, after: 12 }, { x: 22.4, y: 11.295, after: 13 }, { x: 22.7, y: 13.365, after: 20 },
  { x: 31.1, y: 14.635, after: 21 }, { x: 33.8, y: 17.3, after: 23 }, { x: 36.3, y: 19.6, after: 24 }, { x: 27.5, y: 22.5, after: 27 },
];

/** Ground airwires: part, pad index, part, pad index, and the track that retires each. */
const GND_RATS: [string, number, string, number, number][] = [
  ["J1", 0, "R1", 1, 2], ["R1", 1, "R2", 1, 3], ["R1", 1, "C1", 1, 11], ["C1", 1, "C2", 1, 12], ["C2", 1, "U1", 0, 13],
  ["J1", 5, "R2", 1, 10], ["U1", 4, "C4", 1, 23], ["C4", 1, "C3", 1, 24], ["C4", 1, "D1", 1, 27], ["U1", 3, "U1", 7, 15],
  ["J1", 1, "J1", 4, 8], ["U1", 1, "U1", 5, 21],
];

// ------------------------------------------------------------------ colours

export const COL = {
  canvas: "#001023", fcu: "#C83434", bcu: "#4D7FC4", silk: "#F2EDA1", edge: "#D0D2CD", via: "#ECECEC", hole: "#001023",
  rats: "#FFFFFF", fab: "#AFAFAF",
  mask: "#1E6A3C", maskCu: "#2C8A50", gold: "#D9B45C", realSilk: "#F3F3EC", fr4: "#B49B62", fr4Dark: "#8E7948",
  schBg: "#F5F4EF", schLine: "#840000", schFill: "#FFFFC2", wire: "#009600", schText: "#006464", pinNum: "#A90000",
};

function mix(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = (s: number) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}
export { mix };

// ------------------------------------------------------------------ board, flat

export interface BoardState {
  /** Part centres that differ from the placed position. */
  pos?: Record<string, Pt>;
  /** Parts not drawn at all (the caller draws them itself). */
  hide?: Record<string, boolean>;
  /** How much of each track exists, 0..1. */
  trackT: (i: number) => number;
  zone: number;      // ground pour opacity
  rats: number;      // airwire opacity
  real: number;      // 0 = editor colours, 1 = fabricated board
  outline: number;   // board outline opacity
  silk: number;      // silkscreen opacity
  mono: string;      // font family for text
  /** Drawn with a 3D body on top: leave the 2D part graphics to pads and silk. */
  bodies3d?: boolean;
}

export function partPos(p: Part, st: BoardState): Pt { return (st.pos && st.pos[p.ref]) || [p.x, p.y]; }

export function boardPath(ctx: CanvasRenderingContext2D, inset = 0): void {
  const { w, h } = BOARD, r = Math.max(0.2, BOARD.r - inset), i = inset;
  ctx.beginPath();
  ctx.moveTo(i + r, i); ctx.lineTo(w - i - r, i); ctx.arcTo(w - i, i, w - i, i + r, r);
  ctx.lineTo(w - i, h - i - r); ctx.arcTo(w - i, h - i, w - i - r, h - i, r);
  ctx.lineTo(i + r, h - i); ctx.arcTo(i, h - i, i, h - i - r, r);
  ctx.lineTo(i, i + r); ctx.arcTo(i, i, i + r, i, r);
  ctx.closePath();
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Text in millimetre (or sheet unit) sizes.  Canvas fonts misbehave below a few pixels, so the
 *  glyphs are set at 20x and scaled down. */
export function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, font: string,
                     align: CanvasTextAlign = "center", weight = 500): void {
  ctx.save();
  ctx.translate(x, y); ctx.scale(size / 20, size / 20);
  ctx.font = `${weight} 20px ${font}`; ctx.textAlign = align; ctx.textBaseline = "middle";
  ctx.fillText(s, 0, 0);
  ctx.restore();
}

/** The polyline up to fraction `t` of its length, and the point where it stops. */
export function partial(pts: Pt[], t: number): { pts: Pt[]; head: Pt } {
  if (t >= 1) return { pts, head: pts[pts.length - 1] };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * Math.max(0, t);
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (left >= d) { out.push(pts[i]); left -= d; continue; }
    const k = d ? left / d : 0;
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]);
    break;
  }
  return { pts: out, head: out[out.length - 1] };
}

function strokePts(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/** One footprint around the origin: pads, body outline, reference. */
export function drawFootprint(ctx: CanvasRenderingContext2D, p: Part, st: BoardState, alpha = 1): void {
  const real = st.real;
  ctx.save();
  // Silkscreen outline (the body goes on top of it in 3D).
  if (st.silk > 0 && !(st.bodies3d && real > 0.6)) {
    ctx.globalAlpha = alpha * st.silk * (st.bodies3d ? 1 - real / 0.6 : 1);
    ctx.strokeStyle = mix(COL.silk, COL.realSilk, real); ctx.lineWidth = 0.13; ctx.lineJoin = "round";
    if (p.kind === "ic") {
      ctx.strokeRect(-p.bw / 2, -p.bh / 2, p.bw, p.bh);
      ctx.beginPath(); ctx.arc(-p.bw / 2 + 0.75, -p.bh / 2 + 0.75, 0.3, 0, 6.3); ctx.stroke();
    } else if (p.kind === "conn") {
      ctx.strokeRect(-p.bw / 2 + 0.1, -p.bh / 2, p.bw - 0.4, p.bh);
    } else {
      // Two short lines beside the body, as KiCad's chip footprints draw them.
      const v = p.bh > p.bw;
      ctx.beginPath();
      if (v) { ctx.moveTo(-p.bw / 2 - 0.28, -0.3); ctx.lineTo(-p.bw / 2 - 0.28, 0.3); ctx.moveTo(p.bw / 2 + 0.28, -0.3); ctx.lineTo(p.bw / 2 + 0.28, 0.3); }
      else { ctx.moveTo(-0.3, -p.bh / 2 - 0.28); ctx.lineTo(0.3, -p.bh / 2 - 0.28); ctx.moveTo(-0.3, p.bh / 2 + 0.28); ctx.lineTo(0.3, p.bh / 2 + 0.28); }
      ctx.stroke();
      if (p.kind === "led") { ctx.beginPath(); ctx.moveTo(-p.bw / 2 - 0.75, -0.75); ctx.lineTo(-p.bw / 2 - 0.75, 0.75); ctx.stroke(); }
    }
  }
  // Pads.
  ctx.globalAlpha = alpha;
  for (const pad of p.pads) {
    ctx.fillStyle = mix(COL.fcu, COL.gold, real);
    if (pad.th) {
      ctx.beginPath(); ctx.arc(pad.dx, pad.dy, pad.w / 2, 0, 6.3); ctx.fill();
      ctx.fillStyle = real > 0.5 ? "#0A0D10" : COL.hole;
      ctx.beginPath(); ctx.arc(pad.dx, pad.dy, pad.w * 0.28, 0, 6.3); ctx.fill();
    } else {
      rr(ctx, pad.dx - pad.w / 2, pad.dy - pad.h / 2, pad.w, pad.h, Math.min(pad.w, pad.h) * 0.25); ctx.fill();
    }
  }
  // Reference.
  if (st.silk > 0) {
    ctx.globalAlpha = alpha * st.silk;
    ctx.fillStyle = mix(COL.silk, COL.realSilk, real);
    text(ctx, p.ref, p.label[0], p.label[1], 0.95, st.mono);
  }
  ctx.restore();
}

/** The whole board on the z = 0 plane, under whatever transform the caller set. */
export function drawBoard(ctx: CanvasRenderingContext2D, st: BoardState): void {
  const real = st.real;
  // Substrate and solder mask.
  if (real > 0) {
    ctx.save(); ctx.globalAlpha = real; ctx.fillStyle = COL.mask; boardPath(ctx); ctx.fill(); ctx.restore();
  }
  // Ground pour on the back layer.
  if (st.zone > 0 && real < 1) {
    ctx.save(); ctx.globalAlpha = st.zone * 0.34 * (1 - real); ctx.fillStyle = COL.bcu; boardPath(ctx, 0.5); ctx.fill(); ctx.restore();
  }
  // Back copper, under everything else.  On the fabricated board it is on the other side.
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (real < 1) {
    ctx.save(); ctx.globalAlpha = 1 - real;
    TRACKS.forEach((t, i) => {
      if (t.layer !== "B") return;
      const k = st.trackT(i); if (k <= 0) return;
      const pts = partial(t.pts, k).pts;
      if (st.zone > 0) { ctx.strokeStyle = COL.canvas; ctx.lineWidth = 1.05; ctx.globalAlpha = st.zone * (1 - real); strokePts(ctx, pts); ctx.globalAlpha = 1 - real; }
      ctx.strokeStyle = COL.bcu; ctx.lineWidth = 0.42; strokePts(ctx, pts);
    });
    ctx.restore();
  }
  // Front copper.
  TRACKS.forEach((t, i) => {
    if (t.layer !== "F") return;
    const k = st.trackT(i); if (k <= 0) return;
    ctx.strokeStyle = mix(COL.fcu, COL.maskCu, real);
    ctx.lineWidth = t.net === "+5V" || t.net === "GND" ? 0.5 : 0.36;
    strokePts(ctx, partial(t.pts, k).pts);
  });
  // Mounting holes.
  for (const [x, y] of HOLES) {
    if (st.outline <= 0) break;
    ctx.save(); ctx.globalAlpha = st.outline;
    if (real > 0.5) { ctx.fillStyle = COL.gold; ctx.beginPath(); ctx.arc(x, y, 1.75, 0, 6.3); ctx.fill(); ctx.fillStyle = "#0A0D10"; ctx.beginPath(); ctx.arc(x, y, 1.1, 0, 6.3); ctx.fill(); }
    else { ctx.strokeStyle = COL.edge; ctx.lineWidth = 0.12; ctx.beginPath(); ctx.arc(x, y, 1.1, 0, 6.3); ctx.stroke(); }
    ctx.restore();
  }
  // Footprints.
  for (const p of PARTS) {
    if (st.hide && st.hide[p.ref]) continue;
    const [x, y] = partPos(p, st);
    ctx.save(); ctx.translate(x, y); drawFootprint(ctx, p, st); ctx.restore();
  }
  // Vias.
  for (const v of VIAS) {
    if (st.trackT(v.after) < 1) continue;
    ctx.fillStyle = mix(COL.via, COL.maskCu, real); ctx.beginPath(); ctx.arc(v.x, v.y, 0.42, 0, 6.3); ctx.fill();
    ctx.fillStyle = real > 0.5 ? "#0A0D10" : COL.hole; ctx.beginPath(); ctx.arc(v.x, v.y, 0.19, 0, 6.3); ctx.fill();
  }
  // Board lettering.
  if (st.silk > 0) {
    ctx.save(); ctx.globalAlpha = st.silk; ctx.fillStyle = mix(COL.silk, COL.realSilk, real);
    text(ctx, "555 BLINKER", 21, 4.3, 1.5, st.mono, "center", 600);
    text(ctx, "REV A", 31.2, 23.6, 1.0, st.mono, "center");
    ctx.restore();
  }
  // Airwires.
  if (st.rats > 0) {
    ctx.save(); ctx.strokeStyle = COL.rats; ctx.lineWidth = 0.07;
    const padAt = (ref: string, i: number): Pt => { const p = PART[ref], c = partPos(p, st); return [c[0] + p.pads[i].dx, c[1] + p.pads[i].dy]; };
    TRACKS.forEach((t, i) => {
      if (!t.a || !t.b) return;
      const k = st.trackT(i); if (k >= 1) return;
      const a = PART[t.a], b = PART[t.b], ca = partPos(a, st), cb = partPos(b, st);
      const s = t.pts[0], e = t.pts[t.pts.length - 1];
      ctx.globalAlpha = st.rats * 0.55 * (1 - k);
      ctx.beginPath(); ctx.moveTo(s[0] - a.x + ca[0], s[1] - a.y + ca[1]); ctx.lineTo(e[0] - b.x + cb[0], e[1] - b.y + cb[1]); ctx.stroke();
    });
    for (const [ra, ia, rb, ib, until] of GND_RATS) {
      const k = st.trackT(until); if (k >= 1) continue;
      const a = padAt(ra, ia), b = padAt(rb, ib);
      ctx.globalAlpha = st.rats * 0.55 * (1 - k);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }
  // Edge.Cuts.
  if (st.outline > 0 && real < 1) {
    ctx.save(); ctx.globalAlpha = st.outline * (1 - real); ctx.strokeStyle = COL.edge; ctx.lineWidth = 0.14; boardPath(ctx); ctx.stroke(); ctx.restore();
  }
}

// ------------------------------------------------------------------ board, 3D

export interface Cam { cx: number; cy: number; scale: number; yaw: number; pitch: number; ox: number; oy: number }

/** World (mm, z up) to canvas pixels: turn about the board centre, tilt, then scale. */
export function project(c: Cam, x: number, y: number, z: number): Pt {
  const dx = x - c.cx, dy = y - c.cy, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
  return [c.ox + rx * c.scale, c.oy + (ry * Math.cos(c.pitch) - z * Math.sin(c.pitch)) * c.scale];
}

/** The same projection for the z = `z` plane, as a canvas transform. */
export function planeTransform(ctx: CanvasRenderingContext2D, c: Cam, dpr: number, z = 0): void {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), cp = Math.cos(c.pitch), s = c.scale;
  const a = s * cs, b = s * sn * cp, cc = -s * sn, d = s * cs * cp;
  const o = project(c, 0, 0, z);
  ctx.setTransform(a * dpr, b * dpr, cc * dpr, d * dpr, o[0] * dpr, o[1] * dpr);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

/** The slab under the board: its side walls and a soft shadow.  Call before the top face. */
export function drawSlab(ctx: CanvasRenderingContext2D, c: Cam, alpha: number, shadow: string): void {
  if (alpha <= 0 || c.pitch < 0.01) return;
  // The outline as a polygon.
  const { w, h, r } = BOARD, pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  corner(w - r, r, -Math.PI / 2); corner(w - r, h - r, 0); corner(r, h - r, Math.PI / 2); corner(r, r, Math.PI);
  ctx.save();
  ctx.globalAlpha = alpha;
  // Shadow on the "table".
  ctx.save();
  ctx.shadowColor = shadow; ctx.shadowBlur = 26 * Math.min(1, c.pitch * 2); ctx.shadowOffsetY = 14 * c.pitch;
  ctx.fillStyle = shadow; ctx.beginPath();
  pts.forEach((p, i) => { const q = project(c, p[0], p[1], -BOARD.thick - 1.2); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // Walls: every edge, far ones end up behind the top face.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const a = project(c, p[0], p[1], 0), b = project(c, q[0], q[1], 0), b2 = project(c, q[0], q[1], -BOARD.thick), a2 = project(c, p[0], p[1], -BOARD.thick);
    const nx = q[1] - p[1], ny = -(q[0] - p[0]);                       // outward normal (clockwise outline)
    const facing = nx * Math.sin(c.yaw) + ny * Math.cos(c.yaw);        // toward the viewer
    if (facing <= 0) continue;
    const lit = 0.72 + 0.28 * Math.max(0, (nx * Math.cos(c.yaw) - ny * Math.sin(c.yaw)) / Math.hypot(nx, ny));
    ctx.fillStyle = shade(COL.fr4, lit); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

/** Component bodies as shaded boxes, far ones first.  `rise` grows them out of the board. */
export function drawBodies(ctx: CanvasRenderingContext2D, c: Cam, rise: number, alpha: number, ledOn: number): void {
  if (alpha <= 0 || rise <= 0) return;
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const all: { depth: number; b: Box; px: number; py: number; led: boolean }[] = [];
  for (const p of PARTS) for (const b of p.boxes) {
    const x = p.x + b.x, y = p.y + b.y;
    all.push({ depth: (x - c.cx) * sn + (y - c.cy) * cs + b.z1 * 0.01, b, px: x, py: y, led: p.kind === "led" && b.top === "#F4EED8" });
  }
  all.sort((u, v) => u.depth - v.depth);
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineJoin = "round";
  for (const { b, px, py, led } of all) {
    const z0 = b.z0 * rise, z1 = b.z0 + (b.z1 - b.z0) * rise;
    const x0 = px - b.w / 2, x1 = px + b.w / 2, y0 = py - b.h / 2, y1 = py + b.h / 2;
    const cr: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const nrm: Pt[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const [nx, ny] = nrm[i];
      if (nx * sn + ny * cs <= 0.001) continue;
      const p = cr[i], q = cr[(i + 1) % 4];
      const a = project(c, p[0], p[1], z1), bb = project(c, q[0], q[1], z1), b2 = project(c, q[0], q[1], z0), a2 = project(c, p[0], p[1], z0);
      const lit = 0.8 + 0.3 * Math.max(0, nx * cs - ny * sn);
      ctx.fillStyle = shade(b.side, lit); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(bb[0], bb[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = led ? mix(b.top, "#FF5A3C", ledOn) : b.top; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.5;
    ctx.beginPath();
    cr.forEach((p, i) => { const q = project(c, p[0], p[1], z1); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (led && ledOn > 0.01) {
      const o = project(c, px, py, z1), rad = c.scale * 4.2;
      const g = ctx.createRadialGradient(o[0], o[1], 0, o[0], o[1], rad);
      g.addColorStop(0, `rgba(255,96,60,${0.6 * ledOn})`); g.addColorStop(0.3, `rgba(255,80,50,${0.2 * ledOn})`); g.addColorStop(1, "rgba(255,80,50,0)");
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o[0], o[1], rad, 0, 6.3); ctx.fill(); ctx.restore();
    }
  }
  // The 555's marking and pin 1 dot.
  const u = PART.U1;
  ctx.save();
  planeTransformLocal(ctx, c, u.x, u.y, 1.5 * rise);
  ctx.globalAlpha = alpha * Math.max(0, rise * 2 - 1) * 0.7; ctx.fillStyle = "#B9BBBE";
  ctx.rotate(-Math.PI / 2);
  text(ctx, "NE555", 0, -0.35, 0.8, "ui-monospace, monospace"); text(ctx, "2614", 0, 0.75, 0.62, "ui-monospace, monospace");
  ctx.beginPath(); ctx.arc(1.75, -1.35, 0.22, 0, 6.3); ctx.fill();
  ctx.restore();
  ctx.restore();
}

/** Compose the plane transform at height z with a translate to (x, y), on top of the current
 *  device scale.  Used for markings on top of bodies. */
function planeTransformLocal(ctx: CanvasRenderingContext2D, c: Cam, x: number, y: number, z: number): void {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), cp = Math.cos(c.pitch), s = c.scale;
  const o = project(c, x, y, z);
  ctx.transform(s * cs, s * sn * cp, -s * sn, s * cs * cp, o[0], o[1]);
}

// ------------------------------------------------------------------ schematic

export const SHEET = { x: 0, y: 8, w: 126, h: 72 };

export const WIRES: Pt[][] = [
  [[24, 28], [28, 28], [28, 24]],
  [[24, 33], [40, 33], [40, 40]],
  [[24, 38], [32, 38], [32, 40]],
  [[44, 22], [84, 22]],
  [[44, 22], [44, 26]], [[52, 22], [52, 26]], [[66, 22], [66, 24]], [[78, 22], [78, 26]], [[84, 22], [84, 26]],
  [[66, 34], [66, 38]], [[66, 36], [70, 36]],
  [[66, 48], [66, 52]], [[66, 50], [70, 50]], [[70, 44], [68, 44], [68, 50]],
  [[92, 38], [98, 38]], [[108, 38], [112, 38], [112, 40]],
  [[92, 50], [98, 50], [98, 52]],
];
export const WIRE_LEN = WIRES.map((w) => { let l = 0; for (let i = 1; i < w.length; i++) l += Math.hypot(w[i][0] - w[i - 1][0], w[i][1] - w[i - 1][1]); return l; });
export const WIRE_TOTAL = WIRE_LEN.reduce((a, b) => a + b, 0);
const JUNCTIONS: [number, number, number][] = [[52, 22, 5], [66, 22, 6], [78, 22, 7], [66, 36, 10], [66, 50, 12], [68, 50, 13]];
const GNDS: [number, number, number][] = [[15, 48, 0], [32, 50, 2], [40, 50, 1], [44, 36, 3], [52, 36, 4], [66, 62, 8], [78, 60, 5], [98, 62, 9], [112, 50, 11]];
const PWRS: [number, number, number][] = [[28, 24, 0], [44, 22, 3]];

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

/** One symbol around the origin, in sheet units. */
export function drawSymbol(ctx: CanvasRenderingContext2D, p: Part, mono: string): void {
  ctx.lineWidth = 0.32; ctx.strokeStyle = COL.schLine; ctx.fillStyle = COL.schFill; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const label = (s: string, x: number, y: number, size = 2.1, align: CanvasTextAlign = "left", col = COL.schText) => { ctx.fillStyle = col; text(ctx, s, x, y, size, mono, align); ctx.fillStyle = COL.schFill; };
  if (p.kind === "conn") {
    ctx.fillRect(-5, -10, 10, 20); ctx.strokeRect(-5, -10, 10, 20);
    const pins: [string, number][] = [["VBUS", -6], ["CC1", -1], ["CC2", 4]];
    for (const [n, y] of pins) { line(ctx, 5, y, 9, y); label(n, 4, y, 1.8, "right"); }
    line(ctx, 0, 10, 0, 14); label("GND", 0, 8.4, 1.8, "center");
    label("J1", -5, -12.6); label("USB-C", 5, -12.5, 1.9, "right");
    return;
  }
  if (p.kind === "ic") {
    ctx.fillRect(-7, -13, 14, 26); ctx.strokeRect(-7, -13, 14, 26);
    const l: [string, string, number][] = [["DIS", "7", -7], ["THR", "6", 1], ["TR", "2", 7]];
    for (const [n, num, y] of l) { line(ctx, -11, y, -7, y); label(n, -6, y, 1.8); label(num, -8.2, y - 1.3, 1.4, "right", COL.pinNum); }
    const r: [string, string, number][] = [["Q", "3", -5], ["CV", "5", 7]];
    for (const [n, num, y] of r) { line(ctx, 7, y, 11, y); label(n, 6, y, 1.8, "right"); label(num, 8.2, y - 1.3, 1.4, "left", COL.pinNum); }
    line(ctx, -3, -17, -3, -13); label("VCC", -3, -11.3, 1.6, "center"); label("8", -3.7, -15, 1.4, "right", COL.pinNum);
    line(ctx, 3, -17, 3, -13); label("R", 3, -11.3, 1.6, "center"); label("4", 3.7, -15, 1.4, "left", COL.pinNum);
    line(ctx, -3, 13, -3, 17); label("GND", -3, 11.3, 1.6, "center"); label("1", -3.7, 15, 1.4, "right", COL.pinNum);
    label("U1", 8, -14.6); label("NE555", 8, 14.8, 1.9);
    return;
  }
  ctx.save();
  if (p.horiz) ctx.rotate(-Math.PI / 2);
  if (p.kind === "r") {
    line(ctx, 0, -5, 0, -3); line(ctx, 0, 3, 0, 5);
    ctx.fillRect(-1.1, -3, 2.2, 6); ctx.strokeRect(-1.1, -3, 2.2, 6);
  } else if (p.kind === "c") {
    line(ctx, 0, -5, 0, -0.8); line(ctx, 0, 0.8, 0, 5);
    ctx.lineWidth = 0.5; line(ctx, -2.1, -0.8, 2.1, -0.8); line(ctx, -2.1, 0.8, 2.1, 0.8); ctx.lineWidth = 0.32;
  } else {
    line(ctx, 0, -5, 0, -1.5); line(ctx, 0, 1.5, 0, 5);
    ctx.beginPath(); ctx.moveTo(-1.8, -1.5); ctx.lineTo(1.8, -1.5); ctx.lineTo(0, 1.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    line(ctx, -1.8, 1.5, 1.8, 1.5);
    for (const dy of [-0.6, 1.0]) { line(ctx, 2.4, dy, 4.0, dy + 1.4); line(ctx, 4.0, dy + 1.4, 3.1, dy + 1.3); line(ctx, 4.0, dy + 1.4, 3.9, dy + 0.5); }
  }
  ctx.restore();
  if (p.horiz) { label(p.ref, 0, -3.4, 2.1, "center"); label(p.val, 0, 3.6, 1.9, "center"); }
  else { const x = p.left ? -3 : 3; const al: CanvasTextAlign = p.left ? "right" : "left"; label(p.ref, x, -1.4, 2.1, al); label(p.val, x, 1.5, 1.9, al); }
}

/** Sheet frame, wires, power symbols.  `build` 0..1 draws the wiring on; `appear(i)` is each
 *  symbol's opacity; `fade` is the opacity of everything that is not a symbol. */
export function drawSheet(ctx: CanvasRenderingContext2D, build: number, fade: number, mono: string): { head: Pt | null } {
  let head: Pt | null = null;
  if (fade <= 0) return { head };
  ctx.save(); ctx.globalAlpha = fade;
  // Drawing frame and title block.
  ctx.strokeStyle = COL.schLine; ctx.lineWidth = 0.22;
  ctx.strokeRect(SHEET.x + 2, SHEET.y + 2, SHEET.w - 4, SHEET.h - 4);
  ctx.globalAlpha = fade * 0.5; ctx.strokeRect(SHEET.x + 0.6, SHEET.y + 0.6, SHEET.w - 1.2, SHEET.h - 1.2); ctx.globalAlpha = fade;
  const tx = SHEET.x + SHEET.w - 2 - 40, ty = SHEET.y + SHEET.h - 2 - 9;
  ctx.strokeRect(tx, ty, 40, 9); line(ctx, tx, ty + 4.5, tx + 40, ty + 4.5); line(ctx, tx + 27, ty + 4.5, tx + 27, ty + 9);
  ctx.fillStyle = COL.schLine;
  text(ctx, "555 blinker", tx + 1.5, ty + 2.3, 2.1, mono, "left", 600);
  text(ctx, "blinker.kicad_sch", tx + 1.5, ty + 6.8, 1.5, mono, "left"); text(ctx, "Rev A  1/1", tx + 28.2, ty + 6.8, 1.5, mono, "left");
  ctx.globalAlpha = fade * 0.75;
  for (let i = 0; i < 6; i++) text(ctx, String(i + 1), SHEET.x + 2 + (SHEET.w - 4) * (i + 0.5) / 6, SHEET.y + 1.3, 1.1, mono);
  ["A", "B", "C", "D"].forEach((s, i) => text(ctx, s, SHEET.x + 1.3, SHEET.y + 2 + (SHEET.h - 4) * (i + 0.5) / 4, 1.1, mono));
  ctx.globalAlpha = fade;
  // Wires, drawn on in order.
  let left = WIRE_TOTAL * build;
  const done: boolean[] = [];
  ctx.strokeStyle = COL.wire; ctx.lineWidth = 0.34; ctx.lineCap = "round"; ctx.lineJoin = "round";
  WIRES.forEach((w, i) => {
    const k = Math.max(0, Math.min(1, left / WIRE_LEN[i])); left -= WIRE_LEN[i];
    done[i] = k >= 1;
    if (k <= 0) return;
    const part = partial(w, k);
    strokePts(ctx, part.pts);
    if (k < 1) head = part.head;
  });
  ctx.fillStyle = COL.wire;
  for (const [x, y, after] of JUNCTIONS) if (done[after]) { ctx.beginPath(); ctx.arc(x, y, 0.62, 0, 6.3); ctx.fill(); }
  // Power symbols come in with the wiring.
  const shown = (n: number) => Math.max(0, Math.min(1, build * 14 - n));
  ctx.strokeStyle = COL.schLine; ctx.lineWidth = 0.32;
  for (const [x, y, n] of GNDS) {
    const a = shown(n); if (a <= 0) continue;
    ctx.globalAlpha = fade * a;
    line(ctx, x, y, x, y + 1.6); line(ctx, x - 2, y + 1.6, x + 2, y + 1.6); line(ctx, x - 1.2, y + 2.5, x + 1.2, y + 2.5); line(ctx, x - 0.45, y + 3.4, x + 0.45, y + 3.4);
  }
  for (const [x, y, n] of PWRS) {
    const a = shown(n); if (a <= 0) continue;
    ctx.globalAlpha = fade * a;
    line(ctx, x, y, x, y - 2.4); line(ctx, x - 1.6, y - 2.4, x + 1.6, y - 2.4);
    ctx.fillStyle = COL.schText; text(ctx, "+5V", x, y - 4.2, 1.9, mono);
  }
  ctx.restore();
  return { head };
}

// ------------------------------------------------------------------ cursors

/** A collaborator's pointer with a name tag, in canvas pixels. */
export function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string, font: string, alpha = 1): void {
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 15.5); ctx.lineTo(4.2, 11.6); ctx.lineTo(10.8, 11.2); ctx.closePath();
  ctx.fillStyle = color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.lineJoin = "round"; ctx.stroke(); ctx.fill();
  ctx.font = `500 11px ${font}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  const w = ctx.measureText(name).width + 12;
  rr(ctx, 9, 15, w, 18, 3); ctx.fillStyle = color; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(name, 15, 24.5);
  ctx.restore();
}

export const ease = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
export const easeOut = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
export const clamp = (t: number, a = 0, b = 1): number => t < a ? a : t > b ? b : t;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Progress of `t` through [a, b]. */
export const span = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
