// The demo design the home page draws: a USB-C powered 555 LED blinker, as a real KiCad
// schematic and board (demo/blinker.kicad_sch, demo/blinker.kicad_pcb, written by
// scripts/landing-demo/gen.cjs).  They are parsed and painted by the web editor's own renderer
// (web/canvas), so what the page shows is what the editor shows.  This module holds the shared
// pieces: the documents, fitting a view, the unrouted-connection lines, and pointer drawing.

import "../canvas/index";
import SCH_TEXT from "./demo/blinker.kicad_sch";
import PCB_TEXT from "./demo/blinker.kicad_pcb";
import META from "./demo/blinker.json";

export type Pt = [number, number];
export type Box = [number, number, number, number];

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The editor's canvas library (web/canvas/index.ts registers it). */
export const K: any = (globalThis as any).KiCadCanvas;

export interface Route { net: string; layer: string; ids: string[]; pts: Pt[]; who: number; via: string | null }
export interface PartMeta { ref: string; value: string; id: string; x: number; y: number; rot: number; pile: Pt }
export const meta = META as unknown as {
  board: { x: number; y: number; w: number; h: number; r: number };
  parts: PartMeta[]; holes: string[];
  routes: Route[]; vias: { id: string; x: number; y: number; after: number }[]; zone: string;
  sch: {
    symbols: { ref: string; id: string }[]; power: { id: string; at: Pt }[];
    wires: { ids: string[]; pts: Pt[] }[]; junctions: { id: string; at: Pt }[]; notes: string[];
  };
};
export const BOARD = meta.board;

export const loadSch = (): KDoc => K.parseDoc(SCH_TEXT);
export const loadPcb = (): KDoc => K.parseDoc(PCB_TEXT);

/** Layers the page keeps off, as most people do: fabrication drawings and paste. */
export const HIDDEN = new Set(["F.Fab", "B.Fab", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes"]);

// ------------------------------------------------------------------ views

export interface View { ppm: number; zoom: number; dpr: number; panX: number; panY: number; x0: number; y0: number }

/** The view that shows `box` (mm) whole and centred in a w by h (css px) canvas. */
export function fit(w: number, h: number, dpr: number, box: Box): View {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const ppm = Math.min(w / bw, h / bh);
  return { ppm, zoom: 1, dpr, panX: (w - bw * ppm) / 2, panY: (h - bh * ppm) / 2, x0: box[0], y0: box[1] };
}
export const toPx = (v: View, x: number, y: number): Pt => [v.panX + (x - v.x0) * v.ppm * v.zoom, v.panY + (y - v.y0) * v.ppm * v.zoom];
export const toMm = (v: View, px: number, py: number): Pt => [v.x0 + (px - v.panX) / (v.ppm * v.zoom), v.y0 + (py - v.panY) / (v.ppm * v.zoom)];
export const mixBox = (a: Box, b: Box, t: number): Box => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];

// ------------------------------------------------------------------ unrouted connections

interface Node { id: string; net: number; kind: "pad" | "via" | "seg"; x: number; y: number; x2?: number; y2?: number; r: number; hw?: number; hh?: number; layers: string[] | null }

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** The copper of a board as simple shapes: one node per pad, via and track segment. */
function copper(doc: KDoc, only: Set<string> | null): Node[] {
  const out: Node[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      const seen = new Map<number, Node>();
      for (const g of it.geom as any[]) {
        if (!g.pad || g.hole || g.padIndex === undefined || g.t === "text" || !/\.Cu$/.test(g.layer) || !g.net) continue;
        const n = seen.get(g.padIndex);
        if (n) { n.layers!.push(g.layer); continue; }
        const turned = Math.round((g.rot || 0) / 90) % 2 !== 0;
        const w = g.w || (g.r || 0) * 2, h = g.h || (g.r || 0) * 2;
        const node: Node = { id: it.id, net: g.net, kind: "pad", x: g.x, y: g.y, r: 0, hw: (turned ? h : w) / 2, hh: (turned ? w : h) / 2, layers: [g.layer] };
        seen.set(g.padIndex, node); out.push(node);
      }
    } else if (it.kind === "segment") {
      if (only && !only.has(it.id)) continue;
      const g = (it.geom as any[])[0]; if (!g || !g.net) continue;
      out.push({ id: it.id, net: g.net, kind: "seg", x: g.x1, y: g.y1, x2: g.x2, y2: g.y2, r: g.w / 2, layers: [g.layer] });
    } else if (it.kind === "via") {
      if (only && !only.has(it.id)) continue;
      const g = (it.geom as any[])[0]; if (!g || !g.net) continue;
      out.push({ id: it.id, net: g.net, kind: "via", x: g.x, y: g.y, r: g.r, layers: null });
    }
  }
  return out;
}

const shares = (a: Node, b: Node): boolean => !a.layers || !b.layers || a.layers.some((l) => b.layers!.includes(l));
const inPad = (p: Node, x: number, y: number, grow: number): boolean => Math.abs(x - p.x) <= p.hw! + grow && Math.abs(y - p.y) <= p.hh! + grow;

function touches(a: Node, b: Node): boolean {
  if (!shares(a, b)) return false;
  if (a.kind > b.kind) { const t = a; a = b; b = t; }                 // order: pad, seg, via
  const E = 0.02;
  if (a.kind === "pad" && b.kind === "pad") return false;
  if (a.kind === "pad" && b.kind === "seg") return inPad(a, b.x, b.y, E) || inPad(a, b.x2!, b.y2!, E);
  if (a.kind === "pad" && b.kind === "via") return inPad(a, b.x, b.y, E);
  if (a.kind === "seg" && b.kind === "seg") {
    const r = Math.max(a.r, b.r) + E;
    return segDist(a.x, a.y, b.x, b.y, b.x2!, b.y2!) <= r || segDist(a.x2!, a.y2!, b.x, b.y, b.x2!, b.y2!) <= r
      || segDist(b.x, b.y, a.x, a.y, a.x2!, a.y2!) <= r || segDist(b.x2!, b.y2!, a.x, a.y, a.x2!, a.y2!) <= r;
  }
  if (a.kind === "seg" && b.kind === "via") return segDist(b.x, b.y, a.x, a.y, a.x2!, a.y2!) <= b.r + E;
  return Math.hypot(a.x - b.x, a.y - b.y) <= E;
}

export interface Rat { net: number; name: string; a: Pt; b: Pt; ids: [string, string] }

/** KiCad's ratsnest: per net, the shortest lines that would join its separate islands of
 *  copper.  `poured` names the net whose back-layer pour is filled, joining everything of
 *  that net that reaches the back.  `only` limits tracks and vias to the ones that exist yet. */
export function ratsnest(doc: KDoc, opts: { only?: Set<string> | null; poured?: number } = {}): Rat[] {
  const nodes = copper(doc, opts.only || null), n = nodes.length;
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let pour = -1;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    if (opts.poured && a.net === opts.poured && (!a.layers || a.layers.includes("B.Cu"))) { if (pour < 0) pour = i; else parent[find(i)] = find(pour); }
    for (let j = i + 1; j < n; j++) { const b = nodes[j]; if (a.net === b.net && find(i) !== find(j) && touches(a, b)) parent[find(i)] = find(j); }
  }
  const byNet = new Map<number, Map<number, Node[]>>();
  nodes.forEach((nd, i) => {
    let cl = byNet.get(nd.net); if (!cl) byNet.set(nd.net, cl = new Map());
    const r = find(i); let list = cl.get(r); if (!list) cl.set(r, list = []);
    list.push(nd);
  });
  const lines: Rat[] = [];
  for (const [net, clusters] of byNet) {
    const cls = [...clusters.values()].map((list) => { const firm = list.filter((x) => x.kind !== "seg"); return firm.length ? firm : list; });
    if (cls.length < 2) continue;
    const name = String(doc.nets.get(net) || "");
    const near = (c1: Node[], c2: Node[]): [number, Node, Node] => {
      let best: [number, Node, Node] = [Infinity, c1[0], c2[0]];
      for (const a of c1) for (const b of c2) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d < best[0]) best = [d, a, b]; }
      return best;
    };
    const inTree = cls.map(() => false), best: ([number, Node, Node] | null)[] = cls.map(() => null);
    const update = (k: number) => { for (let j = 0; j < cls.length; j++) { if (inTree[j]) continue; const c = near(cls[k], cls[j]); if (!best[j] || c[0] < best[j]![0]) best[j] = c; } };
    inTree[0] = true; update(0);
    for (let c = 1; c < cls.length; c++) {
      let j = -1;
      for (let i = 0; i < cls.length; i++) if (!inTree[i] && (j < 0 || best[i]![0] < best[j]![0])) j = i;
      inTree[j] = true; const e = best[j]!;
      lines.push({ net, name, a: [e[1].x, e[1].y], b: [e[2].x, e[2].y], ids: [e[1].id, e[2].id] });
      update(j);
    }
  }
  return lines;
}

/** What copper is under a point: the pad, via or track end a new track would start from. */
export function copperAt(doc: KDoc, x: number, y: number, layer: string): { net: number; x: number; y: number; kind: string; id: string } | null {
  let best: { net: number; x: number; y: number; kind: string; id: string; d: number } | null = null;
  for (const nd of copper(doc, null)) {
    let d = Infinity, sx = nd.x, sy = nd.y;
    if (nd.kind === "pad") { if ((!nd.layers || nd.layers.includes(layer)) && inPad(nd, x, y, 0.05)) d = 0; }
    else if (nd.kind === "via") { const dd = Math.hypot(x - nd.x, y - nd.y); if (dd <= nd.r + 0.1) d = 0.01; }
    else if (nd.layers!.includes(layer)) {
      const d1 = Math.hypot(x - nd.x, y - nd.y), d2 = Math.hypot(x - nd.x2!, y - nd.y2!);
      if (Math.min(d1, d2) <= nd.r + 0.2) { d = 0.02 + Math.min(d1, d2); if (d2 < d1) { sx = nd.x2!; sy = nd.y2!; } }
      else if (segDist(x, y, nd.x, nd.y, nd.x2!, nd.y2!) <= nd.r + 0.05) { d = 0.5; sx = x; sy = y; }
    }
    if (d < (best ? best.d : Infinity)) best = { net: nd.net, x: sx, y: sy, kind: nd.kind, id: nd.id, d };
  }
  return best;
}

/** The track or via under a point, for selecting one. */
export function trackAt(doc: KDoc, x: number, y: number, slop: number): string | null {
  let best: string | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    const g = (it.geom as any[])[0]; if (!g) continue;
    let d = Infinity;
    if (it.kind === "segment") d = segDist(x, y, g.x1, g.y1, g.x2, g.y2) - g.w / 2;
    else if (it.kind === "via") d = Math.hypot(x - g.x, y - g.y) - g.r - 0.05;
    if (d <= slop && d < bd) { bd = d; best = it.id; }
  }
  return best;
}

// ------------------------------------------------------------------ pointers and easing

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** A collaborator's pointer with a name tag, in css pixels. */
export function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string, font: string, alpha = 1): void {
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(Math.round(x), Math.round(y));
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 15.5); ctx.lineTo(4.2, 11.6); ctx.lineTo(10.8, 11.2); ctx.closePath();
  ctx.fillStyle = color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.lineJoin = "round"; ctx.stroke(); ctx.fill();
  ctx.font = `500 11px ${font}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  const w = ctx.measureText(name).width + 12;
  rr(ctx, 9, 15, w, 18, 3); ctx.fillStyle = color; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(name, 15, 24.5);
  ctx.restore();
}

export const PEERS = [{ name: "Mara", color: "#A45BD6" }, { name: "Jun", color: "#149C94" }, { name: "Ada", color: "#D9822B" }] as const;

export const ease = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
export const easeOut = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
export const clamp = (t: number, a = 0, b = 1): number => t < a ? a : t > b ? b : t;
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
/** Progress of `t` through [a, b]. */
export const span = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
export const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
