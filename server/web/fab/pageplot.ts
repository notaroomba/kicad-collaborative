// web/fab/pageplot — a board layer on a page, as pcbnew's StartPlotBoard / initializePlotter /
// PlotBoardLayers (plot_board_layers.cpp) put it there for the page-based formats (PostScript, SVG, DXF,
// PDF, PNG): the board's paper size (or A4), auto-scale to 80 % of the page or a fixed scale centred on the
// board, the drill / place origin at 1:1, a horizontal mirror, the drawing sheet unscaled and unmirrored
// with the layer name as sheet name, drill marks knocked out in white, a negative plot over a black field
// 5 mm larger than the board, and the PDF footprint popups and "Footprints" bookmarks.
import type { PlotParams } from "../canvas/plot-params";
import type { PlotItem } from "../canvas/plot-rec";
import { type BoardModel, type FabDoc, type Footprint } from "./model";
import { PlotLog, type PlotOptions, plotFile } from "./plot";
import { primPolys } from "./poly";
import { type Prim, type Pt, arcPoints } from "./prims";
import { type PlotLink, type PlotPage, type Viewport, toPage } from "./plotter";

interface CanvasPlotApi { sheetPlotItems(doc: unknown, color: string): PlotItem[] }
const canvasPlot = (): CanvasPlotApi | null => { const K = (globalThis as unknown as { KiCadCanvas?: { plot?: CanvasPlotApi } }).KiCadCanvas; return K && K.plot ? K.plot : null; };

export const SMALL_DRILL = 0.35;   // ADVANCED_CFG::m_SmallDrillMarkSize
const A4: Pt = [297, 210];

export interface PagePlotRequest {
  params: PlotParams;
  /** the layer the page is for, and the layers plotted with it (Plot on All Layers, in list order) */
  layer: string; common: string[];
  /** layer name shown in the drawing sheet ("F.Cu" or the user name) */
  layerName: string;
  /** colours of the PCB colour theme, by layer; the drawing sheet's colour */
  colors: Record<string, string>; sheetColor: string;
  /** PDF / PNG background colour (colour mode only) */
  background?: string | null;
  pageNumber: number; pageCount: number;
  /** the PDF interactive layer (property popups and bookmarks) */
  interactive?: boolean;
}

/** PCB_PLOT_PARAMS::GetScale for a scale selection (0 = auto). */
export const SCALES = [1, 1, 1.5, 2, 3];

/** The board's box as BOARD::ComputeBoundingBox(false, false) gives it (the canvas keeps it on the document). */
export function boardBox(doc: FabDoc): [number, number, number, number] | null {
  const b = doc.bbox as unknown as number[] | null;
  return b && b[2] > b[0] && b[3] > b[1] ? [b[0], b[1], b[2], b[3]] : null;
}

/** initializePlotter: the viewport and the page size for a set of options. */
export function boardViewport(doc: FabDoc, o: { autoScale: boolean; scale: number; mirror: boolean; useAuxOrigin: boolean; a4: boolean; auxOrigin: Pt }): { vp: Viewport; page: Pt } {
  const pageSize: Pt = [doc.page[0], doc.page[1]];
  let paper: Pt = pageSize, paperscale = 1, autocenter: boolean;
  if (o.a4) { paper = A4; paperscale = A4[0] / pageSize[0]; autocenter = true; }
  else autocenter = o.scale !== 1 || o.autoScale;
  const bb = boardBox(doc);
  const centre: Pt = bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : [0, 0];
  const size: Pt = bb ? [bb[2] - bb[0], bb[3] - bb[1]] : [0, 0];
  let k: number;
  if (o.autoScale && size[0] > 0 && size[1] > 0) k = Math.min(paper[0] * 0.8 / size[0], paper[1] * 0.8 / size[1]) * paperscale;
  else k = o.scale * paperscale;
  let offset: Pt = [0, 0];
  if (autocenter) offset = [centre[0] - paper[0] / 2 / k, centre[1] - paper[1] / 2 / k];
  else if (o.useAuxOrigin) offset = o.auxOrigin;
  return { vp: { offset, scale: k, mirror: o.mirror, pageW: paper[0] }, page: paper };
}

/** Plot primitives as page items in one colour; a cleared primitive is drawn in `clearColor` (KiCad's white knockout). */
export function primItems(prims: Prim[], vp: Viewport, color: string, clearColor: string, out: PlotItem[]): void {
  const P = (x: number, y: number): Pt => toPage(vp, x, y);
  for (const p of prims) {
    const c = p.clear ? clearColor : color;
    if (p.k === "seg") out.push({ k: "line", pts: [P(p.x1, p.y1), P(p.x2, p.y2)], w: p.w * vp.scale, color: c });
    else if (p.k === "arc") out.push({ k: "line", pts: arcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, 0.002 / Math.max(vp.scale, 1e-6)).map((q) => P(q[0], q[1])), w: p.w * vp.scale, color: c });
    else if (p.k === "circle") { const q = P(p.x, p.y); out.push({ k: "circle", x: q[0], y: q[1], r: p.d / 2 * vp.scale, w: 0, fill: true, color: c }); }
    else if (p.k === "region") out.push({ k: "fill", polys: [p.pts.map((q) => P(q[0], q[1]))], color: c });
    else { const polys = primPolys(p); if (polys.length) out.push({ k: "fill", polys: polys.map((poly) => poly.map((q) => P(q[0], q[1]))), color: c }); }
  }
}

/** BRDITEMS_PLOTTER::PlotDrillMarks: every hole, white where it knocks out a plotted pad, black elsewhere. */
export function drillMarkItems(m: BoardModel, layers: Set<string>, small: boolean, vp: Viewport, out: PlotItem[], white: string): void {
  const mark = (x: number, y: number, w: number, h: number, rotDeg: number, color: string): void => {
    let dw = w, dh = h;
    if (small) { dw = Math.min(SMALL_DRILL, w); dh = Math.min(SMALL_DRILL, h); }
    const q = toPage(vp, x, y);
    if (Math.abs(dw - dh) < 1e-9) { out.push({ k: "circle", x: q[0], y: q[1], r: dw / 2 * vp.scale, w: 0, fill: true, color }); return; }
    const polys = primPolys({ k: "oval", x, y, w: dw, h: dh, rot: rotDeg });
    out.push({ k: "fill", polys: polys.map((poly) => poly.map((p) => toPage(vp, p[0], p[1]))), color });
  };
  for (const v of m.vias) {
    if (!(v.drill > 0) || !v.layers.some((l) => layers.has(l))) continue;
    mark(v.x, v.y, v.drill, v.drill, 0, white);
  }
  for (const fp of m.footprints) for (const pad of fp.pads) {
    if (!pad.drill || !(pad.drill.w > 0)) continue;
    let color = "#000000";
    for (const l of layers) { if (!pad.layers.has(l)) continue; const s = pad.stack.get(l) || pad.base; if (s.w > pad.drill.w || s.h > pad.drill.h) { color = white; break; } }
    mark(pad.x, pad.y, pad.drill.w, pad.drill.oval ? pad.drill.h : pad.drill.w, pad.rot, color);
  }
}

/** PS_PLOTTER's negative mode: every colour inverted. */
export const invert = (c: string): string => {
  const m = /^#([0-9a-f]{6})/i.exec(c.length === 4 ? "#" + c.slice(1).replace(/./g, "$&$&") : c);
  if (!m) return "#FFFFFF";
  const v = 0xffffff - parseInt(m[1], 16);
  return "#" + v.toString(16).padStart(6, "0").toUpperCase();
};

/** Did the footprint draw anything on these layers (PLOTTER::WasFootprintPlotted)? */
function fpOnLayers(fp: Footprint, layers: Set<string>): boolean {
  for (const p of fp.pads) for (const l of p.layers) if (layers.has(l)) return true;
  for (const g of fp.item.geom) if (layers.has(g.layer) && !g.hiddenText) return true;
  return false;
}

/** One page of a board plot: the drawing sheet, the layer and its companions, the drill marks. */
export function boardPage(m: BoardModel, r: PagePlotRequest, log: PlotLog): PlotPage {
  const p = r.params, doc = m.doc;
  const autoScale = p.scaleSelection === 0, scale = SCALES[p.scaleSelection] || 1;
  const fit = p.format === 5 && !!p.svgFitPageToBoard;
  const mono = p.blackAndWhite;
  const a4 = p.format === 2 && p.a4Output;
  let { vp, page } = boardViewport(doc, { autoScale, scale, mirror: p.mirror, useAuxOrigin: p.useAuxOrigin, a4, auxOrigin: m.settings.auxOrigin });
  let viewBox: [number, number, number, number] | null = null;
  if (fit) {
    const bb = outlineBox(m) || boardBox(doc) || [0, 0, doc.page[0], doc.page[1]];
    page = [bb[2] - bb[0], bb[3] - bb[1]];
    vp = { offset: [0, 0], scale: 1, mirror: p.mirror, pageW: page[0] };
    viewBox = [p.mirror ? page[0] - bb[0] - page[0] : bb[0], bb[1], page[0], page[1]];
  }
  const items: PlotItem[] = [];
  const bg = !mono && (p.format === 4 || p.format === 6) && r.background ? r.background : null;
  const paper = "#FFFFFF";
  // the drawing sheet: never mirrored or scaled (StartPlotBoard plots it with a 1:1 viewport, A4 still scaled)
  if (p.plotFrameRef && !fit) {
    const C = canvasPlot();
    if (C) {
      const sheetDoc = Object.assign({}, doc as unknown as object, { sheetName: r.layerName, sheetLayer: r.layerName, pageNumber: String(r.pageNumber), sheetCount: r.pageCount, isFirstPage: r.pageNumber === 1 });
      const k = a4 ? A4[0] / doc.page[0] : 1;
      for (const it of C.sheetPlotItems(sheetDoc, mono ? "#000000" : r.sheetColor)) items.push(k === 1 ? it : scaleItem(it, k));
    }
  }
  // negative: a black field 5 mm larger than the board, then everything in inverted colours
  const neg = p.negative && p.format !== 1;
  const start = items.length;
  if (neg) { const bb = boardBox(doc); if (bb) { const a = toPage(vp, bb[0] - 5, bb[1] - 5), b = toPage(vp, bb[2] + 5, bb[3] + 5); items.push({ k: "fill", polys: [[[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]], color: "#FFFFFF" }); } }
  const opt: PlotOptions = { plotReference: p.plotReference !== false, plotValue: p.plotValue !== false, subtractMaskFromSilk: p.subtractMaskFromSilk, hideDnpOnFab: p.hideDnpOnFab,
    sketchDnpOnFab: p.sketchDnpOnFab, crossoutDnpOnFab: p.crossoutDnpOnFab, sketchPadsOnFab: p.sketchPadsOnFab, plotPadNumbers: p.plotPadNumbers };
  const seq = [r.layer, ...r.common.filter((l) => l !== r.layer)];
  // PlotBoardLayers plots the sequence bottom up: the layer itself last, on top
  for (const l of seq.slice().reverse()) {
    if (!m.doc.layers.has(l) && m.doc.layers.size) continue;
    const prims = plotFile(m, l, opt, log);
    primItems(prims, vp, mono ? "#000000" : r.colors[l] || "#000000", bg || paper, items);
  }
  if (p.drillMarks && p.format !== 1) drillMarkItems(m, new Set(seq), p.drillMarks === 1, vp, items, bg || paper);
  if (neg) for (let i = start; i < items.length; i++) items[i] = Object.assign({}, items[i], { color: invert(items[i].color) });
  const out: PlotPage = { w: page[0], h: page[1], name: r.layerName, items, background: bg, viewBox };
  // PlotInteractiveLayer: a property menu over each footprint, a bookmark under "Footprints"
  if (r.interactive && p.format === 4) {
    const layers = new Set(seq); const links: PlotLink[] = []; const marks: PlotPage["bookmarks"] = [];
    for (const fp of m.footprints) {
      const back = fp.side === "B.Cu";
      if ((!back && !p.pdfFrontPopups) || (back && !p.pdfBackPopups) || !fpOnLayers(fp, layers)) continue;
      const bb = fp.item.bbox; if (!bb) continue;
      const a = toPage(vp, bb[0], bb[1]), b = toPage(vp, bb[2], bb[3]);
      const menu: [string, string][] = [[`Reference designator = ${fp.ref}`, ""], [`Value = ${fp.value}`, ""], [`Footprint = ${fp.name}`, ""]];
      for (const [k, v] of fp.props) if (k !== "Reference" && k !== "Value" && v) { const url = /(https?:|file:)\S*/.exec(v); menu.push([`${k} = ${v}`, url ? url[0] : ""]); }
      links.push({ box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], menu });
      marks!.push({ group: "Footprints", title: fp.ref });
    }
    out.links = links; out.bookmarks = marks;
  }
  return out;
}

function scaleItem(it: PlotItem, k: number): PlotItem {
  if (it.k === "line") return Object.assign({}, it, { pts: it.pts.map((q) => [q[0] * k, q[1] * k] as Pt), w: it.w * k });
  if (it.k === "fill") return Object.assign({}, it, { polys: it.polys.map((poly) => poly.map((q) => [q[0] * k, q[1] * k] as Pt)) });
  return Object.assign({}, it, { x: it.x * k, y: it.y * k, r: it.r * k, w: it.w * k });
}

/** The board outline's box (BOARD::GetBoardPolygonOutlines' bbox), from the Edge.Cuts centre lines. */
function outlineBox(m: BoardModel): [number, number, number, number] | null {
  const log = new PlotLog();
  const prims = plotFile(m, "Edge.Cuts", { plotReference: false, plotValue: false, subtractMaskFromSilk: false }, log);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of prims) {
    const pts: Pt[] = p.k === "seg" ? [[p.x1, p.y1], [p.x2, p.y2]] : p.k === "arc" ? arcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, 0.005) : p.k === "region" ? p.pts : [];
    for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}
