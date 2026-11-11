// The finished board as a solid: the board file painted onto a slab in fabrication colours,
// with a simple body standing on each footprint.  The top face is the editor's renderer again
// (tracks under solder mask, bare pads, white silkscreen), drawn once into a texture.

import { BOARD, K, PartMeta, Pt, meta } from "./demo";

/* eslint-disable @typescript-eslint/no-explicit-any */
const THICK = 1.6;
const C = { mask: "#1E6A3C", maskCu: "#2A8A4F", gold: "#D9B45C", silk: "#F3F3EC", fr4: "#B49B62", hole: "#0A0D10" };

export interface Cam { cx: number; cy: number; scale: number; yaw: number; pitch: number; ox: number; oy: number }

/** World (mm, z up) to canvas pixels: turn about the board centre, tilt, then scale. */
export function project(c: Cam, x: number, y: number, z: number): Pt {
  const dx = x - c.cx, dy = y - c.cy, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
  return [c.ox + rx * c.scale, c.oy + (ry * Math.cos(c.pitch) - z * Math.sin(c.pitch)) * c.scale];
}

/** The same projection for the plane at height z, as a canvas transform. */
export function planeTransform(ctx: CanvasRenderingContext2D, c: Cam, dpr: number, z = 0): void {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), cp = Math.cos(c.pitch), s = c.scale;
  const o = project(c, 0, 0, z);
  ctx.setTransform(s * cs * dpr, s * sn * cp * dpr, -s * sn * dpr, s * cs * cp * dpr, o[0] * dpr, o[1] * dpr);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = (s: number) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

function outline(): Pt[] {
  const { x, y, w, h, r } = BOARD, pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return pts;
}
const OUTLINE = outline();

/** Pixels per millimetre of the top-face texture. */
const TEX = 30;

/** The board's top face as it comes back from the fab. */
export function boardTexture(doc: KDoc): HTMLCanvasElement {
  const tex = document.createElement("canvas"); tex.width = BOARD.w * TEX; tex.height = BOARD.h * TEX;
  const pass = document.createElement("canvas"); pass.width = tex.width; pass.height = tex.height;
  const t = tex.getContext("2d")!, p = pass.getContext("2d")!;
  t.setTransform(TEX, 0, 0, TEX, -BOARD.x * TEX, -BOARD.y * TEX);
  t.beginPath(); OUTLINE.forEach((q, i) => i ? t.lineTo(q[0], q[1]) : t.moveTo(q[0], q[1])); t.closePath();
  t.fillStyle = C.mask; t.fill();
  t.setTransform(1, 0, 0, 1, 0, 0);
  const view = { ppm: TEX, zoom: 1, dpr: 1, panX: 0, panY: 0, x0: BOARD.x, y0: BOARD.y };
  const all: string[] = K.layerList(doc).map((l: { key: string }) => l.key).concat(["holes"]);
  const layer = (ids: string[], keep: string[], colors: [string, string][]) => {
    K.render(doc, p, view, { background: false, grid: 0, ids: new Set(ids), hidden: new Set(all.filter((l) => !keep.includes(l))),
      layerColors: new Map(colors), netNames: false, padNumbers: false });
    p.setTransform(1, 0, 0, 1, 0, 0);
    t.drawImage(pass, 0, 0);
  };
  const tracks: string[] = [], rest: string[] = [];
  for (const it of doc.items.values()) (it.kind === "segment" || it.kind === "via" ? tracks : it.kind === "zone" ? [] : rest).push(it.id);
  layer(tracks, ["F.Cu"], [["F.Cu", C.maskCu]]);
  layer(rest, ["F.Cu", "F.SilkS"], [["F.Cu", C.gold], ["F.SilkS", C.silk]]);
  // Drilled holes show the bench through them.
  t.setTransform(TEX, 0, 0, TEX, -BOARD.x * TEX, -BOARD.y * TEX); t.fillStyle = C.hole;
  for (const it of doc.items.values()) for (const g of it.geom as any[]) {
    if (g.layer !== "holes" || g.via) continue;
    const turned = Math.round((g.rot || 0) / 90) % 2 !== 0, w = (turned ? g.h : g.w) || g.r * 2, h = (turned ? g.w : g.h) || g.r * 2, r = Math.min(w, h) / 2;
    t.beginPath(); t.roundRect(g.x - w / 2, g.y - h / 2, w, h, r); t.fill();
  }
  t.setTransform(1, 0, 0, 1, 0, 0);
  return tex;
}

/** The slab under the top face: a soft shadow and the side walls.  Call before the face. */
export function drawSlab(ctx: CanvasRenderingContext2D, c: Cam, alpha: number): void {
  if (alpha <= 0 || c.pitch < 0.01) return;
  const pts = OUTLINE;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 26 * Math.min(1, c.pitch * 2); ctx.shadowOffsetY = 14 * c.pitch;
  ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.beginPath();
  pts.forEach((p, i) => { const q = project(c, p[0], p[1], -THICK - 1.2); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
  ctx.closePath(); ctx.fill();
  ctx.restore();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const nx = q[1] - p[1], ny = -(q[0] - p[0]);                       // outward normal (clockwise outline)
    if (nx * Math.sin(c.yaw) + ny * Math.cos(c.yaw) <= 0) continue;    // faces away
    const a = project(c, p[0], p[1], 0), b = project(c, q[0], q[1], 0), b2 = project(c, q[0], q[1], -THICK), a2 = project(c, p[0], p[1], -THICK);
    const lit = 0.72 + 0.28 * Math.max(0, (nx * Math.cos(c.yaw) - ny * Math.sin(c.yaw)) / Math.hypot(nx, ny));
    ctx.fillStyle = shade(C.fr4, lit); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

/** The top face: the texture laid on the z = 0 plane. */
export function drawFace(ctx: CanvasRenderingContext2D, c: Cam, dpr: number, tex: HTMLCanvasElement, alpha: number): void {
  if (alpha <= 0) return;
  ctx.save(); planeTransform(ctx, c, dpr); ctx.globalAlpha = alpha; ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(tex, BOARD.x, BOARD.y, BOARD.w, BOARD.h);
  ctx.restore();
}

// ---- component bodies: boxes in footprint coordinates, turned with the footprint

interface BoxDef { x: number; y: number; w: number; h: number; z0: number; z1: number; top: string; side: string; led?: boolean }
const SILVER = "#C5C8CC", SILVER_S = "#8E9297";

function chipBody(len: number, wid: number, hgt: number, top: string, side: string, led = false): BoxDef[] {
  const cap = len * 0.22;
  return [
    { x: -(len - cap) / 2, y: 0, w: cap, h: wid, z0: 0, z1: hgt, top: SILVER, side: SILVER_S },
    { x: 0, y: 0, w: len - 2 * cap, h: wid, z0: 0, z1: hgt + 0.03, top, side, led },
    { x: (len - cap) / 2, y: 0, w: cap, h: wid, z0: 0, z1: hgt, top: SILVER, side: SILVER_S },
  ];
}
function bodyOf(p: PartMeta): BoxDef[] {
  const k = p.ref[0];
  if (k === "R") return chipBody(1.6, 0.8, 0.45, "#1B1B1E", "#0E0E10");
  if (k === "C") return p.value === "10u" ? chipBody(2.0, 1.25, 1.0, "#B79A68", "#8A7147") : chipBody(1.6, 0.8, 0.8, "#B79A68", "#8A7147");
  if (k === "D") return chipBody(2.0, 1.25, 0.75, "#F4EED8", "#CFC8AE", true);
  if (k === "U") {
    const leads: BoxDef[] = [];
    for (const sx of [-1, 1]) for (const y of [-1.905, -0.635, 0.635, 1.905]) leads.push({ x: sx * 2.45, y, w: 1.1, h: 0.4, z0: 0, z1: 0.25, top: SILVER, side: SILVER_S });
    return [{ x: 0, y: 0, w: 3.9, h: 4.9, z0: 0.1, z1: 1.5, top: "#1D1D20", side: "#0D0D0F" }, ...leads];
  }
  return [{ x: 0, y: 0.15, w: 8.94, h: 7.1, z0: 0, z1: 3.16, top: "#D4D7DB", side: "#9A9EA4" }];   // the USB-C shell
}
interface Body { x: number; y: number; w: number; h: number; z0: number; z1: number; top: string; side: string; led: boolean }
const BODIES: Body[] = [];
for (const p of meta.parts) {
  const a = p.rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), turned = Math.round(p.rot / 90) % 2 !== 0;
  for (const b of bodyOf(p)) BODIES.push({ x: p.x + b.x * cs + b.y * sn, y: p.y - b.x * sn + b.y * cs, w: turned ? b.h : b.w, h: turned ? b.w : b.h, z0: b.z0, z1: b.z1, top: b.top, side: b.side, led: !!b.led });
}
const U1 = meta.parts.find((p) => p.ref === "U1")!;
const LED = BODIES.find((b) => b.led)!;

/** The LED lit by `on`: its lens and the glow around it, over an already drawn board. */
export function drawLed(ctx: CanvasRenderingContext2D, c: Cam, on: number): void {
  if (on <= 0.01) return;
  const b = LED, x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, y0 = b.y - b.h / 2, y1 = b.y + b.h / 2;
  ctx.save();
  ctx.fillStyle = mix(b.top, "#FF5A3C", on); ctx.beginPath();
  ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pt[]).forEach((p, i) => { const q = project(c, p[0], p[1], b.z1); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
  ctx.closePath(); ctx.fill();
  const o = project(c, b.x, b.y, b.z1), rad = c.scale * 4.2;
  const g = ctx.createRadialGradient(o[0], o[1], 0, o[0], o[1], rad);
  g.addColorStop(0, `rgba(255,96,60,${0.6 * on})`); g.addColorStop(0.3, `rgba(255,80,50,${0.2 * on})`); g.addColorStop(1, "rgba(255,80,50,0)");
  ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o[0], o[1], rad, 0, 6.3); ctx.fill();
  ctx.restore();
}

/** Component bodies as shaded boxes, far ones first.  `rise` grows them out of the board. */
export function drawBodies(ctx: CanvasRenderingContext2D, c: Cam, rise: number, alpha: number, font: string): void {
  if (alpha <= 0 || rise <= 0) return;
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const all = BODIES.map((b) => ({ b, depth: (b.x - c.cx) * sn + (b.y - c.cy) * cs + b.z1 * 0.01 })).sort((u, v) => u.depth - v.depth);
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineJoin = "round";
  for (const { b } of all) {
    const z0 = b.z0 * rise, z1 = b.z0 + (b.z1 - b.z0) * rise;
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, y0 = b.y - b.h / 2, y1 = b.y + b.h / 2;
    const cr: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], nrm: Pt[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const [nx, ny] = nrm[i];
      if (nx * sn + ny * cs <= 0.001) continue;
      const p = cr[i], q = cr[(i + 1) % 4];
      const a = project(c, p[0], p[1], z1), bb = project(c, q[0], q[1], z1), b2 = project(c, q[0], q[1], z0), a2 = project(c, p[0], p[1], z0);
      ctx.fillStyle = shade(b.side, 0.8 + 0.3 * Math.max(0, nx * cs - ny * sn)); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(bb[0], bb[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = b.top; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.5;
    ctx.beginPath();
    cr.forEach((p, i) => { const q = project(c, p[0], p[1], z1); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  // The 555's marking and pin 1 dot, on top of its body.
  const o = project(c, U1.x, U1.y, 1.5 * rise), cp = Math.cos(c.pitch), s = c.scale;
  ctx.save();
  ctx.transform(s * cs, s * sn * cp, -s * sn, s * cs * cp, o[0], o[1]);
  ctx.globalAlpha = alpha * Math.max(0, rise * 2 - 1) * 0.7; ctx.fillStyle = "#B9BBBE";
  ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.save(); ctx.scale(0.04, 0.04); ctx.font = `500 20px ${font}`; ctx.fillText("NE555", 0, -9); ctx.restore();
  ctx.save(); ctx.scale(0.031, 0.031); ctx.font = `500 20px ${font}`; ctx.fillText("2614", 0, 24); ctx.restore();
  ctx.beginPath(); ctx.arc(1.75, -1.35, 0.22, 0, 6.3); ctx.fill();
  ctx.restore();
  ctx.restore();
}
