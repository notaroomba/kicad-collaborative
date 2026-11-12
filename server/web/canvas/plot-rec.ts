// kicad-canvas / plot-rec — a recording 2D context: the painter (render.ts) draws into it exactly as it
// draws the screen, and it keeps what was drawn as plot items (stroked polylines with round caps, filled
// polygons, circles) in page millimetres.  This is how a schematic sheet, a print page or the drawing
// sheet of a board plot becomes vector output (SVG / PDF / PostScript / DXF writers in web/fab and the
// print dialog): KiCad's SCH_PLOTTER draws through the same item painters as the screen too.
//
// Arcs, ellipses and curves are flattened (chord error 2 µm on the page); dashes are split into segments
// (setLineDash semantics), so a writer only has to draw polylines and polygons.  Text arrives as the stroke
// font's strokes (the painter's "stroke" text mode); a native fillText (an outline font the browser has) is
// redrawn with KiCad's stroke font at the same size.
import { strokeLine, strokeOrigin } from "./stroke-font";
import { drawDrawingSheet, render } from "./render";
import { inSchTheme } from "./geom";
import { root } from "./env";
import type { documentDrawingSheet } from "./sheet";
import type { Ctx2D, Doc, Pt } from "./types";

export type PlotItem = (
  /** a stroked polyline, round caps and joins (PLOTTER::ThickSegment / PlotPoly with a width) */
  | { k: "line"; pts: Pt[]; w: number; color: string; alpha?: number; closed?: boolean; cap?: string }
  /** filled polygons, one fill (nonzero winding; holes run the other way) */
  | { k: "fill"; polys: Pt[][]; color: string; alpha?: number; evenOdd?: boolean }
  /** a circle: filled (w = 0) or stroked */
  | { k: "circle"; x: number; y: number; r: number; w: number; fill: boolean; color: string; alpha?: number }
) & {
  /** the board text this item draws (page frame, page units; one object shared by all of the text's items):
   *  the DXF writer may put it out as a TEXT entity instead (DXF_PLOTTER::plotOneLineOfText) */
  text?: PageText;
};

export interface PageText { text: string; x: number; y: number; size: number; sizeX: number; rot: number; h: string; v: string; italic: boolean; bold: boolean; mirror: boolean }

/** An affine matrix [a, b, c, d, e, f] (canvas order). */
export type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** A Path2D stand-in the painters may build (only used when a caller hands one in). */
class RecPath { subs: Pt[][] = []; }

interface State { m: Mat; fill: string; stroke: string; lw: number; cap: string; join: string; alpha: number; dash: number[]; dashOff: number; font: string; align: string; base: string }

const CHORD = 0.002;   // page mm

/**
 * The recording context.  `outer` maps the painter's device space to page millimetres (the painter's own
 * transform is applied first); `colorMap` rewrites colours (black and white); `ppm` is only what the painter
 * is told one millimetre measures in device units (its text and hairline culling work in device pixels).
 */
export class PlotRecorder {
  readonly __plot = true;
  readonly items: PlotItem[] = [];
  canvas: { width: number; height: number };
  private st: State; private stack: State[] = [];
  private path: Pt[][] = []; private cur: Pt[] | null = null;
  constructor(width: number, height: number, private outer: Mat, private colorMap?: (c: string, fill: boolean) => string | null) {
    this.canvas = { width, height };
    this.st = { m: [1, 0, 0, 1, 0, 0], fill: "#000000", stroke: "#000000", lw: 1, cap: "butt", join: "miter", alpha: 1, dash: [], dashOff: 0, font: "10px sans-serif", align: "start", base: "alphabetic" };
  }
  // ---- state
  get fillStyle(): string { return this.st.fill; } set fillStyle(v: string) { if (typeof v === "string") this.st.fill = v; }
  get strokeStyle(): string { return this.st.stroke; } set strokeStyle(v: string) { if (typeof v === "string") this.st.stroke = v; }
  get lineWidth(): number { return this.st.lw; } set lineWidth(v: number) { if (v > 0 && isFinite(v)) this.st.lw = v; }
  get lineCap(): string { return this.st.cap; } set lineCap(v: string) { this.st.cap = v; }
  get lineJoin(): string { return this.st.join; } set lineJoin(v: string) { this.st.join = v; }
  get globalAlpha(): number { return this.st.alpha; } set globalAlpha(v: number) { if (v >= 0 && v <= 1) this.st.alpha = v; }
  get lineDashOffset(): number { return this.st.dashOff; } set lineDashOffset(v: number) { this.st.dashOff = v; }
  get font(): string { return this.st.font; } set font(v: string) { this.st.font = v; }
  get textAlign(): string { return this.st.align; } set textAlign(v: string) { this.st.align = v; }
  get textBaseline(): string { return this.st.base; } set textBaseline(v: string) { this.st.base = v; }
  globalCompositeOperation = "source-over"; imageSmoothingEnabled = true; miterLimit = 10; shadowBlur = 0; shadowColor = "transparent"; filter = "none";
  save(): void { this.stack.push(Object.assign({}, this.st, { m: this.st.m.slice() as Mat, dash: this.st.dash.slice() })); }
  restore(): void { const s = this.stack.pop(); if (s) this.st = s; }
  setTransform(a: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (typeof a === "object") this.st.m = [a.a, a.b, a.c, a.d, a.e, a.f]; else this.st.m = [a, b!, c!, d!, e!, f!];
  }
  resetTransform(): void { this.st.m = [1, 0, 0, 1, 0, 0]; }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } { const m = this.st.m; return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.st.m = mul(this.st.m, [a, b, c, d, e, f]); }
  translate(x: number, y: number): void { this.st.m = mul(this.st.m, [1, 0, 0, 1, x, y]); }
  scale(x: number, y: number): void { this.st.m = mul(this.st.m, [x, 0, 0, y, 0, 0]); }
  rotate(a: number): void { const c = Math.cos(a), s = Math.sin(a); this.st.m = mul(this.st.m, [c, s, -s, c, 0, 0]); }
  setLineDash(d: number[]): void { this.st.dash = (d || []).filter((v) => v >= 0); if (this.st.dash.length % 2) this.st.dash = this.st.dash.concat(this.st.dash); }
  getLineDash(): number[] { return this.st.dash.slice(); }
  clip(): void { /* plots are not clipped */ }
  clearRect(): void { /* the page starts blank */ }
  drawImage(): void { /* bitmaps are not plotted by this recorder */ }
  createLinearGradient(): { addColorStop(): void } { return { addColorStop() { /* none */ } }; }
  createPattern(): null { return null; }
  measureText(t: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } {
    const px = parseFloat(/([\d.]+)px/.exec(this.st.font)?.[1] || "10");
    return { width: strokeLine(t).width * px * 0.95, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2 };
  }
  isPointInPath(): boolean { return false; }
  // ---- path
  private dev(x: number, y: number): Pt { return apply(this.st.m, x, y); }
  /** device → page tolerance in device units for the current matrix */
  private segs(r: number, sweep: number): number {
    const k = scaleOf(this.st.m) * scaleOf(this.outer) * Math.max(r, 1e-9);
    const step = k > CHORD ? 2 * Math.acos(Math.max(-1, 1 - CHORD / k)) : Math.PI / 2;
    return Math.max(1, Math.min(2000, Math.ceil(Math.abs(sweep) / step)));
  }
  beginPath(): void { this.path = []; this.cur = null; }
  moveTo(x: number, y: number): void { this.cur = [this.dev(x, y)]; this.path.push(this.cur); }
  lineTo(x: number, y: number): void { if (!this.cur) { this.moveTo(x, y); return; } this.cur.push(this.dev(x, y)); }
  closePath(): void { if (this.cur && this.cur.length) { const f = this.cur[0]; (this.cur as Pt[] & { closed?: boolean }).closed = true; this.cur = [f]; this.path.push(this.cur); } }
  rect(x: number, y: number, w: number, h: number): void { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  roundRect(x: number, y: number, w: number, h: number): void { this.rect(x, y, w, h); }
  arc(x: number, y: number, r: number, a0: number, a1: number, acw?: boolean): void {
    const TAU = 2 * Math.PI; let sweep: number;
    if (!acw) { sweep = a1 - a0; sweep = sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU; } else { sweep = a0 - a1; sweep = -(sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU); }
    const n = this.segs(r, sweep);
    for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; const px = x + r * Math.cos(a), py = y + r * Math.sin(a); if (i === 0 && !this.cur) this.moveTo(px, py); else this.lineTo(px, py); }
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, acw?: boolean): void {
    const TAU = 2 * Math.PI; let sweep = acw ? -(((a0 - a1) % TAU) + TAU) % TAU : (((a1 - a0) % TAU) + TAU) % TAU;
    if (Math.abs(a1 - a0) >= TAU - 1e-9) sweep = acw ? -TAU : TAU;
    const n = this.segs(Math.max(rx, ry), sweep), c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; const ex = rx * Math.cos(a), ey = ry * Math.sin(a); const px = x + ex * c - ey * s, py = y + ex * s + ey * c; if (i === 0 && !this.cur) this.moveTo(px, py); else this.lineTo(px, py); }
  }
  arcTo(x1: number, y1: number): void { this.lineTo(x1, y1); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.cur) { this.moveTo(cx, cy); }
    const inv = this.inverse(); const p0 = apply(inv, this.cur![this.cur!.length - 1][0], this.cur![this.cur!.length - 1][1]);
    const n = 16; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; this.lineTo(u * u * p0[0] + 2 * u * t * cx + t * t * x, u * u * p0[1] + 2 * u * t * cy + t * t * y); }
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.cur) { this.moveTo(c1x, c1y); }
    const inv = this.inverse(); const p0 = apply(inv, this.cur![this.cur!.length - 1][0], this.cur![this.cur!.length - 1][1]);
    const n = 24; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; this.lineTo(u * u * u * p0[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * p0[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y); }
  }
  private inverse(): Mat {
    const [a, b, c, d, e, f] = this.st.m; const det = a * d - b * c || 1e-12;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  }
  // ---- output
  private color(c: string, fill: boolean): string | null { if (!c || c === "transparent" || c === "none") return null; return this.colorMap ? this.colorMap(c, fill) : c; }
  private toPage(p: Pt): Pt { return apply(this.outer, p[0], p[1]); }
  private subpaths(path?: unknown): { pts: Pt[]; closed: boolean }[] {
    const subs = path instanceof RecPath ? path.subs.map((s) => s.map((q) => this.dev(q[0], q[1]))) : this.path;
    return subs.filter((s) => s.length > 0).map((s) => ({ pts: s.map((q) => this.toPage(q)), closed: !!(s as Pt[] & { closed?: boolean }).closed }));
  }
  private alpha(c: string): number | undefined {
    let a = this.st.alpha;
    const m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(c); if (m) a *= +m[1];
    const h = /^#[0-9a-f]{8}$/i.exec(c); if (h) a *= parseInt(c.slice(7, 9), 16) / 255;
    return a < 1 ? a : undefined;
  }
  fill(path?: unknown, rule?: string): void {
    if (typeof path === "string") { rule = path; path = undefined; }
    const color = this.color(this.st.fill, true); if (!color || this.globalCompositeOperation === "destination-out") return;
    const polys = this.subpaths(path).map((s) => s.pts).filter((s) => s.length >= 3);
    if (!polys.length) return;
    this.items.push({ k: "fill", polys, color, alpha: this.alpha(this.st.fill), evenOdd: rule === "evenodd" || undefined });
  }
  stroke(path?: unknown): void {
    const color = this.color(this.st.stroke, false); if (!color) return;
    const w = this.st.lw * scaleOf(this.st.m) * scaleOf(this.outer);
    const alpha = this.alpha(this.st.stroke);
    const dash = this.st.dash.length && this.st.dash.some((v) => v > 0) ? this.st.dash.map((v) => v * scaleOf(this.st.m) * scaleOf(this.outer)) : null;
    for (const { pts: s, closed } of this.subpaths(path)) {
      if (s.length < 2) continue;   // a lone moveTo draws nothing
      const pts = closed && (s[0][0] !== s[s.length - 1][0] || s[0][1] !== s[s.length - 1][1]) ? s.concat([s[0]]) : s;
      if (dash) { for (const run of dashRuns(pts, dash, this.st.dashOff * scaleOf(this.st.m) * scaleOf(this.outer))) this.items.push({ k: "line", pts: run, w, color, alpha, cap: this.st.cap }); continue; }
      this.items.push({ k: "line", pts, w, color, alpha, closed: closed || undefined, cap: this.st.cap });
    }
  }
  fillRect(x: number, y: number, w: number, h: number): void { const keep = this.path, cur = this.cur; this.beginPath(); this.rect(x, y, w, h); this.fill(); this.path = keep; this.cur = cur; }
  strokeRect(x: number, y: number, w: number, h: number): void { const keep = this.path, cur = this.cur; this.beginPath(); this.rect(x, y, w, h); this.stroke(); this.path = keep; this.cur = cur; }
  /** native text: redrawn in KiCad's stroke font at the font's pixel size (cap height ≈ 0.72 em) */
  fillText(text: string, x: number, y: number): void { this.textAsStrokes(text, x, y, this.st.fill); }
  strokeText(text: string, x: number, y: number): void { this.textAsStrokes(text, x, y, this.st.stroke); }
  private textAsStrokes(text: string, x: number, y: number, color: string): void {
    const px = parseFloat(/([\d.]+)px/.exec(this.st.font)?.[1] || "10"), size = px * 0.72, pen = size / 8;
    const line = strokeLine(String(text));
    const h = this.st.align === "center" ? "center" : this.st.align === "right" || this.st.align === "end" ? "right" : "left";
    const v = this.st.base === "middle" ? "middle" : this.st.base === "top" || this.st.base === "hanging" ? "top" : "bottom";
    const [ox, oy] = strokeOrigin(line.advance, h, v, pen / size, pen / size);
    const keepStroke = this.st.stroke, keepLw = this.st.lw, keepCap = this.st.cap;
    this.st.stroke = color; this.st.lw = pen; this.st.cap = "round";
    this.beginPath();
    for (const st of line.strokes) { this.moveTo(x + (st[0] + ox) * size, y + (st[1] + oy) * size); for (let i = 2; i < st.length; i += 2) this.lineTo(x + (st[i] + ox) * size, y + (st[i + 1] + oy) * size); }
    this.stroke();
    this.st.stroke = keepStroke; this.st.lw = keepLw; this.st.cap = keepCap;
  }
}

/** Split a polyline into the drawn runs of a dash pattern (CanvasRenderingContext2D.setLineDash semantics). */
export function dashRuns(pts: Pt[], pattern: number[], offset = 0): Pt[][] {
  const total = pattern.reduce((a, b) => a + b, 0); if (!(total > 0)) return [pts];
  let pi = 0, left = pattern[0], on = true;
  let o = ((offset % total) + total) % total;
  while (o > 0) { const st = Math.min(o, left); left -= st; o -= st; if (left <= 1e-12) { pi = (pi + 1) % pattern.length; left = pattern[pi]; on = !on; } }
  const out: Pt[][] = []; let run: Pt[] | null = on ? [pts[0]] : null;
  for (let i = 0; i + 1 < pts.length; i++) {
    let [x, y] = pts[i]; const [ex, ey] = pts[i + 1];
    let len = Math.hypot(ex - x, ey - y); if (len < 1e-12) continue;
    const ux = (ex - x) / len, uy = (ey - y) / len;
    while (len > 1e-12) {
      const step = Math.min(left, len); x += ux * step; y += uy * step; len -= step; left -= step;
      if (on && run) run.push([x, y]);
      if (left <= 1e-12) {
        pi = (pi + 1) % pattern.length; left = pattern[pi]; on = !on;
        if (on) run = [[x, y]]; else { if (run && run.length > 1) out.push(run); run = null; }
      }
    }
  }
  if (on && run && run.length > 1) out.push(run);
  return out;
}

export interface RecordOptions {
  /** the document area that lands on the page: [x0, y0] at the page origin */
  x0?: number; y0?: number;
  /** page mm per document mm, and a horizontal mirror about the page width */
  scale?: number; mirror?: boolean; pageWidth?: number;
  /** page size the painter is told (mm); also the culling area */
  width: number; height: number;
  colorMap?: (c: string, fill: boolean) => string | null;
  /** device pixels per document mm the painter works at (text and hairline culling) */
  ppm?: number;
}
/** A recorder set up for a document drawn 1:1 (or scaled / mirrored) onto a page, and the view to render with. */
export function plotRecorder(o: RecordOptions): { rec: PlotRecorder; view: { ppm: number; zoom: number; panX: number; panY: number; x0: number; y0: number; dpr: number } } {
  const ppm = o.ppm || 100, k = (o.scale || 1) / ppm;
  const outer: Mat = o.mirror ? [-k, 0, 0, k, o.pageWidth ?? o.width, 0] : [k, 0, 0, k, 0, 0];
  const rec = new PlotRecorder(Math.ceil(o.width / (o.scale || 1) * ppm), Math.ceil(o.height / (o.scale || 1) * ppm), outer, o.colorMap);
  return { rec, view: { ppm, zoom: 1, panX: 0, panY: 0, x0: o.x0 || 0, y0: o.y0 || 0, dpr: 1 } };
}

/** The drawing sheet of a document context (page, title block, sheet name …) as plot items, in `color`. */
export function sheetPlotItems(doc: Parameters<typeof documentDrawingSheet>[0] & { type?: string }, color: string): PlotItem[] {
  const ppm = 100;
  const { rec } = plotRecorder({ width: doc.page[0], height: doc.page[1], ppm, colorMap: () => color });
  rec.setTransform(ppm, 0, 0, ppm, 0, 0);
  drawDrawingSheet(rec as unknown as Ctx2D, doc as unknown as Doc, ppm, 1 / ppm);
  return rec.items;
}

/** Box of plot items (page mm). */
export function itemsBox(items: PlotItem[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, r: number): void => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const it of items) {
    if (it.k === "circle") add(it.x, it.y, it.r + it.w / 2);
    else if (it.k === "line") for (const p of it.pts) add(p[0], p[1], it.w / 2);
    else for (const poly of it.polys) for (const p of poly) add(p[0], p[1], 0);
  }
  return x1 >= x0 ? [x0, y0, x1, y1] : null;
}

/** Luminance 0…1 of a CSS colour (#rgb, #rrggbb, #rrggbbaa, rgb(a)()), or -1. */
export function luminance(c: string): number {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (m) { let h = m[1]; if (h.length === 3) h = h.replace(/./g, "$&$&"); return (0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16)) / 255; }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(c);
  if (m) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
  return -1;
}
/** PLOTTER::SetColor in black-and-white mode: every stroke black; a pale fill (a symbol body, a sheet background) paper white. */
export function blackAndWhite(c: string, fill: boolean): string { return fill && luminance(c) > 0.85 ? "#FFFFFF" : "#000000"; }

export interface DocPlotOptions {
  /** draw the drawing sheet (KiCad's "Plot drawing sheet") */
  frame?: boolean;
  /** black and white output */
  mono?: boolean;
  /** schematic colour theme id (KiCad Default when absent) */
  theme?: string | null;
  /** the part of the document on the page: the whole page (default) */
  x0?: number; y0?: number; width?: number; height?: number;
  /** page mm per document mm; mirror about the page width */
  scale?: number; mirror?: boolean;
  /** extra render options (hidden layers, …) */
  render?: Record<string, unknown>;
}
/**
 * A document drawn onto a page as plot items, through the screen painter (render.ts) with the plot rules:
 * no grid, selection, highlight or markers, no hidden pins or fields, the stroke font, no page outline.
 */
export function plotItems(doc: Doc, o: DocPlotOptions = {}, renderFn?: (doc: Doc, ctx: Ctx2D, view: unknown, opts: unknown) => void): PlotItem[] {
  const R = renderFn || (render as unknown as (d: Doc, c: Ctx2D, v: unknown, op: unknown) => void);
  const go = (d: Doc): PlotItem[] => {
    const width = o.width || d.page[0], height = o.height || d.page[1];
    const { rec, view } = plotRecorder({ x0: o.x0 || 0, y0: o.y0 || 0, scale: o.scale || 1, mirror: o.mirror, width, height, pageWidth: width * (o.scale || 1), colorMap: o.mono ? blackAndWhite : undefined });
    const K = (root as unknown as { KiCadCanvas: { textMode?: string } }).KiCadCanvas;
    const keep = K ? K.textMode : undefined; if (K) K.textMode = "stroke";
    try {
      R(d, rec as unknown as Ctx2D, view, Object.assign({ grid: 0, background: false, selected: null, highlight: null, markers: null, ratsnest: null, showHiddenPins: false, showHiddenText: false,
        frame: o.frame !== false, zoneOutline: false }, o.render || {}));
    } finally { if (K) K.textMode = keep; }
    return rec.items;
  };
  return d0IsSch(doc) && o.theme ? inSchTheme(doc, o.theme, go) : go(doc);
}
const d0IsSch = (d: Doc): boolean => d.type === "sch";
