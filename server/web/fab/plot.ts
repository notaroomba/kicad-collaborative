// web/fab/plot — one board layer reduced to plot primitives, following pcbnew's PlotStandardLayer
// (plot_board_layers.cpp) and BRDITEMS_PLOTTER (plot_brditems_plotter.cpp):
//
//   graphics and text   every drawing on the layer; text as KiCad's stroke font, knockout text as a box with
//                       the glyphs cleared out of it
//   pads                flashed with the layer's own size: the copper shape, the solder mask opening (shape
//                       grown by the pad / footprint / board mask expansion) or the paste aperture (shrunk by
//                       the paste margin and ratio); an NPTH pad no larger than its hole flashes no copper
//   vias                on the copper they span, and on the mask where they are not tented
//   tracks              round pen draws; arcs stay arcs
//   zones               their stored fills as regions
//
// Graphics, text, dimensions, tables and barcodes come from the geometry the canvas already built for the
// screen (the same strokes the editor shows); pads, vias, tracks and zones are read from the nodes, because
// what a fabricator needs of them (mask, paste, unused-layer removal) is not what the screen draws.
import { isList, kid, num, polyPtsOf, str } from "../canvas/sexpr";
import { type BoardModel, type Footprint, type Node, type Pad, type PadShape, type Via, isBack, isCopper, isFront, padShapeOn } from "./model";
import { MAX_ERROR, clockwise, fracture, inflate, primPolys, stadium, union } from "./poly";
import { outlineFontHeld, outlineText } from "./outline-font";
import { type GbrMeta, type PlotText, type Prim, type Pt, arcPoints, circlePoints, rot } from "./prims";

export interface PlotOptions {
  plotReference: boolean; plotValue: boolean;
  /** Clear the solder mask openings out of the silkscreen (KiCad's "Subtract soldermask from silkscreen"). */
  subtractMaskFromSilk: boolean;
  /** Tent every via regardless of the board (JLCPCB's default for the cheapest service is to accept either). */
  forceTentVias?: boolean;
  /** Layers plotted into every file as well (KiCad's "Plot on all layers", usually Edge.Cuts). */
  commonLayers?: string[];
  /** "Do not populate" footprints on the Fab layers: left out, drawn as outlines, crossed out (KiCad draws outlines and a cross). */
  hideDnpOnFab?: boolean; sketchDnpOnFab?: boolean; crossoutDnpOnFab?: boolean;
  /** "Sketch pads on fabrication layers" and its "Include pad numbers" */
  sketchPadsOnFab?: boolean; plotPadNumbers?: boolean;
  /** BRDITEMS_PLOTTER::getFineWidthAdj: PostScript's "Track width correction", mm, added to tracks and to the copper
   *  of pads and vias (and taken off the drill marks) */
  widthAdj?: number;
}
/** PCB_PLOT_PARAMS::m_sketchPadLineWidth and the Fab layers' default line thickness, mm. */
const SKETCH_WIDTH = 0.1, FAB_LINE_WIDTH = 0.1;
const isFab = (l: string): boolean => l === "F.Fab" || l === "B.Fab";

interface StrokeLineLike { strokes: number[][]; width: number; advance: number }
interface CanvasText {
  strokeLine(text: string, italic?: boolean): StrokeLineLike;
  strokeOrigin(width: number, h: string, v: string, penX: number, penY: number): [number, number];
  dashPattern(type: string, w: number): number[];
}
const canvas = (): CanvasText => (globalThis as unknown as { KiCadCanvas: CanvasText }).KiCadCanvas;

const K = (n: Node | null, key: string): Node | null => (n ? (kid(n, key) as Node | null) : null);
const N = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const S = (v: unknown): string => (typeof v === "string" ? v : "");

/** Warnings a plot can raise; the dialog shows them once each. */
export class PlotLog {
  readonly messages = new Set<string>();
  warn(m: string): void { this.messages.add(m); }
}

// ---------------------------------------------------------------- canvas geometry → primitives
/** Break a polyline into dashes (STROKE_PARAMS::Stroke); `pattern` alternates drawn and skipped lengths. */
function dashed(pts: Pt[], pattern: number[], w: number, out: Prim[]): void {
  let pi = 0, left = pattern[0], on = true;
  for (let i = 0; i + 1 < pts.length; i++) {
    let [x, y] = pts[i]; const [ex, ey] = pts[i + 1];
    let len = Math.hypot(ex - x, ey - y); if (len < 1e-9) continue;
    const ux = (ex - x) / len, uy = (ey - y) / len;
    while (len > 1e-9) {
      const step = Math.min(left, len); const nx = x + ux * step, ny = y + uy * step;
      if (on) out.push({ k: "seg", x1: x, y1: y, x2: nx, y2: ny, w });
      x = nx; y = ny; len -= step; left -= step;
      if (left <= 1e-9) { pi = (pi + 1) % pattern.length; left = pattern[pi]; on = !on; }
    }
  }
}

function polyline(pts: Pt[], close: boolean, w: number, g: KGeom, out: Prim[]): void {
  if (!(w > 0) || pts.length < 2) return;
  const path = close ? pts.concat([pts[0]]) : pts;
  if (g.dash) { dashed(path, canvas().dashPattern(S(g.dashType), w), w, out); return; }
  for (let i = 0; i + 1 < path.length; i++) out.push({ k: "seg", x1: path[i][0], y1: path[i][1], x2: path[i + 1][0], y2: path[i + 1][1], w });
}

/** EDA_TEXT::GetEffectiveTextPenWidth: the pen never exceeds a quarter of the glyph size. */
const clampPen = (pen: number, size: number, sizeX: number): number => Math.min(pen, Math.min(Math.abs(size), Math.abs(sizeX)) * 0.25);

interface OutlineCache { node: Node; x: number; y: number; rot: number; shown: string; polys?: Pt[][] | null }

/**
 * The outlines KiCad stored for a text set in an outline font, when they still belong to the text: the same
 * string and angle, and the block still sitting on the text's anchor (a text moved or resized here since KiCad
 * wrote the file has outlines of where it was).
 */
function cachedOutlines(oc: OutlineCache, size: number, sizeX: number): Pt[][] | null {
  if (oc.polys !== undefined) return oc.polys;
  oc.polys = null;
  const rc = oc.node; if (S(rc[1]) !== oc.shown) return null;
  const turn = ((num(rc[2], 0) - oc.rot) % 360 + 360) % 360;
  if (Math.min(turn, 360 - turn) > 0.01) return null;
  const polys: Pt[][] = [];
  for (const p of rc.slice(3)) {
    if (!isList(p) || str(p[0]) !== "polygon") continue;
    const outlines = (p as Node[]).filter((c) => isList(c) && str(c[0]) === "pts").map((c) => polyPtsOf(["x", c] as unknown as Node) as Pt[]).filter((o) => o.length >= 3);
    if (!outlines.length) continue;
    // an outline with holes (KiCad stores them fractured, so this is the exception) is fractured here
    if (outlines.length === 1) polys.push(outlines[0]); else for (const o of fracture([clockwise(outlines[0])].concat(outlines.slice(1).map((h) => clockwise(h).slice().reverse())))) polys.push(o);
  }
  if (!polys.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const q of poly) { const [lx, ly] = rot(q[0] - oc.x, q[1] - oc.y, -oc.rot); if (lx < x0) x0 = lx; if (ly < y0) y0 = ly; if (lx > x1) x1 = lx; if (ly > y1) y1 = ly; }
  const tx = 0.35 * Math.abs(sizeX) + 0.1, ty = 0.6 * Math.abs(size) + 0.1;
  const onX = Math.abs(x0) <= tx || Math.abs(x1) <= tx || Math.abs((x0 + x1) / 2) <= tx;
  const onY = Math.abs(y0) <= ty || Math.abs(y1) <= ty || Math.abs((y0 + y1) / 2) <= ty;
  if (!onX || !onY) return null;
  oc.polys = polys;
  return polys;
}

/** The box a knockout text is cut out of: the box of what the text draws, in the text's own frame, grown by the margin. */
export function knockoutBox(pts: Pt[], x: number, y: number, deg: number, margin: number): Pt[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { const [lx, ly] = rot(q[0] - x, q[1] - y, -deg); if (lx < x0) x0 = lx; if (ly < y0) y0 = ly; if (lx > x1) x1 = lx; if (ly > y1) y1 = ly; }
  return ([[x0 - margin, y0 - margin], [x1 + margin, y0 - margin], [x1 + margin, y1 + margin], [x0 - margin, y1 + margin]] as Pt[]).map(([lx, ly]) => { const [rx, ry] = rot(lx, ly, deg); return [x + rx, y + ry] as Pt; });
}

/** One text record: the outlines KiCad cached for an outline font, else stroke-font segments (the transform drawStrokeText composes for the screen). */
function textPrims(g: KGeom, out: Prim[], knock: Prim[], log: PlotLog): void {
  const at = out.length;
  textPrimsOf(g, out, knock, log);
  // a PCB_TEXT / PCB_FIELD that is not knocked out goes through PLOTTER::PlotText: a DXF plot without the KiCad font writes it as text
  const dt = g.dxfText as { bold: boolean } | undefined;
  if (!dt || g.knockout || out.length === at) return;
  const size = N(g.size, 1);
  const info: PlotText = { text: S(g.raw) || S(g.text), x: N(g.x), y: N(g.y), size, sizeX: N(g.sizeX) > 0 ? N(g.sizeX) : size, rot: N(g.rot), h: S(g.h) || "center", v: S(g.v) || "middle",
    italic: !!g.italic, bold: !!dt.bold, mirror: !!g.mirror };
  for (let i = at; i < out.length; i++) out[i].text = info;
}

function textPrimsOf(g: KGeom, out: Prim[], knock: Prim[], log: PlotLog): void {
  const text = S(g.raw) || S(g.text); if (!text) return;
  const size = N(g.size, 1), sizeX = N(g.sizeX) > 0 ? N(g.sizeX) : size;
  const pen = clampPen(N(g.w) > 0 ? N(g.w) : size / 8, size, sizeX);
  const margin = Math.max(pen / 2, size / 9);   // PCB_TEXT::GetKnockoutTextMargin
  const dst = g.knockout ? knock : out, clear = g.knockout ? true : undefined;
  if (g.face) {
    const oc = g.outline as OutlineCache | undefined, polys = oc ? cachedOutlines(oc, size, sizeX) : null;
    if (oc && polys) {
      if (!g.outlineFirst) return;   // the outlines hold every line of the text: they go out with its first
      if (g.knockout) knock.push({ k: "region", pts: knockoutBox(polys.flat(), oc.x, oc.y, oc.rot, margin) });
      for (const pts of polys) dst.push({ k: "region", pts, clear });
      return;
    }
    // no outlines KiCad stored (or they no longer fit): draw them from the font file, as pcbnew does
    const blk = g.block as { x: number; y: number; text: string } | undefined;
    if (blk && !g.outlineFirst && outlineFontHeld(S(g.face), !!g.bold, !!g.italic)) return;   // every line goes out with the first
    const drawn = outlineText({ face: S(g.face), bold: !!g.bold, italic: !!g.italic, text: blk ? blk.text : text, x: blk ? blk.x : N(g.x), y: blk ? blk.y : N(g.y),
      rot: N(g.rot), size, sizeX, h: S(g.h) || "center", v: S(g.v) || "middle", mirror: !!g.mirror });
    if (drawn) {
      const bars: Prim[] = drawn.bars.map(([x1, y1, x2, y2]) => ({ k: "seg", x1, y1, x2, y2, w: pen, clear }));
      if (g.knockout) {
        const pts = drawn.polys.flat(); for (const [x1, y1, x2, y2] of drawn.bars) pts.push([x1, y1], [x2, y2]);
        if (pts.length) knock.push({ k: "region", pts: knockoutBox(pts, blk ? blk.x : N(g.x), blk ? blk.y : N(g.y), N(g.rot), margin) });
      }
      for (const pts of drawn.polys) dst.push({ k: "region", pts, clear });
      for (const b of bars) dst.push(b);
      return;
    }
    log.warn(`The font "${S(g.face)}" could not be loaded${typeof document === "undefined" ? "" : " from the project"}, so text set in it is plotted with the KiCad stroke font.`);
  }
  const C = canvas(); const line = C.strokeLine(text, !!g.italic);
  const lay = g.knockout && g.layoutW !== undefined ? N(g.layoutW) : pen;
  const [ox, oy] = C.strokeOrigin(line.advance, S(g.h) || "center", S(g.v) || "middle", lay / sizeX, lay / size);
  const a = -N(g.rot) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = g.mirror ? -1 : 1;
  const x0 = N(g.x), y0 = N(g.y);
  // local (unit) → board: T(x, y) · Rot(a) · MirrorX · Scale(sx, sy) · T(ox, oy)
  const P = (u: number, v: number): Pt => { const lx = (u + ox) * sizeX * mx, ly = (v + oy) * size; return [x0 + lx * c - ly * sn, y0 + lx * sn + ly * c]; };
  const segs: Prim[] = []; const ends: Pt[] = [];
  for (const st of line.strokes) {
    if (st.length === 2) { const p = P(st[0], st[1]); ends.push(p); segs.push({ k: "seg", x1: p[0], y1: p[1], x2: p[0], y2: p[1], w: pen, clear }); continue; }
    for (let i = 0; i + 3 < st.length; i += 2) {
      const p = P(st[i], st[i + 1]), q = P(st[i + 2], st[i + 3]); ends.push(p, q);
      segs.push({ k: "seg", x1: p[0], y1: p[1], x2: q[0], y2: q[1], w: pen, clear });
    }
  }
  // PCB_TEXT knockout: the box of the drawn glyphs (pen included) grown by the margin, the glyphs cleared out of it
  if (g.knockout && ends.length) knock.push({ k: "region", pts: knockoutBox(ends, x0, y0, N(g.rot), margin + pen / 2) });
  for (const p of segs) dst.push(p);
}

/** PLOTTER::PlotText with the stroke font: one line of text as pen strokes (board frame, mm). */
export function strokeTextPrims(text: string, x: number, y: number, size: number, pen: number, h: "left" | "center" | "right", v: "top" | "middle" | "bottom"): Prim[] {
  const out: Prim[] = [], knock: Prim[] = [];
  textPrims({ t: "text", raw: text, x, y, size, w: pen, h, v, rot: 0 } as unknown as KGeom, out, knock, new PlotLog());
  return out;
}

/**
 * PCB_TEXT::TransformShapeToPolygon (buildBoundingHull): the box of the drawn text in its own frame, grown by
 * `gap` — what a zone fill knocks out around a copper text.  A knockout text instead leaves its glyphs alone as
 * holes (ZONE_FILLER::addKnockout).
 */
export function textKnockout(g: KGeom, gap: number, log: PlotLog): Pt[][] {
  const out: Prim[] = [], knock: Prim[] = [];
  textPrims(Object.assign({}, g, { knockout: false }), out, knock, log);
  if (!out.length) return [];
  if (g.knockout) { const polys: Pt[][] = []; for (const p of out) for (const q of primPolys(p)) polys.push(q); return polys; }
  const pts: Pt[] = []; let pen = 0;
  for (const p of out) { if (p.k === "seg") { pts.push([p.x1, p.y1], [p.x2, p.y2]); pen = Math.max(pen, p.w); } else if (p.k === "region") for (const q of p.pts) pts.push(q); }
  if (!pts.length) return [];
  const oc = (g.face ? g.outline || g.block : undefined) as { x: number; y: number; rot: number } | undefined;
  const x = oc ? oc.x : N(g.x), y = oc ? oc.y : N(g.y), deg = oc ? oc.rot : N(g.rot);
  return [knockoutBox(pts, x, y, deg, gap + pen / 2)];
}

/** A geometry record of the canvas as primitives; `grow` widens strokes and fills (a solder mask margin on a copper graphic). */
export function geomPrims(g: KGeom, out: Prim[], knock: Prim[], log: PlotLog, grow = 0): void {
  const w = N(g.w) + 2 * grow;
  if (g.t === "line") {
    const pts: Pt[] = [[N(g.x1), N(g.y1)], [N(g.x2), N(g.y2)]];
    polyline(pts, false, w, g, out);
  } else if (g.t === "arc") {
    if (g.pie || !(w > 0)) return;
    const cx = N(g.x), cy = N(g.y), r = N(g.r), a0 = N(g.a0), a1 = N(g.a1), acw = !!g.anticlockwise;
    if (g.dash) dashed(arcPoints(cx, cy, r, a0, a1, acw, MAX_ERROR), canvas().dashPattern(S(g.dashType), w), w, out);
    else out.push({ k: "arc", cx, cy, r, a0, a1, acw, w });
  } else if (g.t === "circle") {
    const x = N(g.x), y = N(g.y), r = N(g.r);
    if (g.fill) { const d = 2 * r + (g.noStroke ? 0 : N(g.w)) + 2 * grow; if (d > 0) out.push({ k: "circle", x, y, d }); }
    else if (w > 0) {
      if (g.dash) dashed(circlePoints(x, y, r, MAX_ERROR).concat([[x + r, y]]), canvas().dashPattern(S(g.dashType), w), w, out);
      else out.push({ k: "arc", cx: x, cy: y, r, a0: 0, a1: 2 * Math.PI, acw: false, w });
    }
  } else if (g.t === "poly") {
    const pts = (g.pts as Pt[]) || []; if (pts.length < 2) return;
    if (g.fill && pts.length >= 3) out.push({ k: "region", pts });
    if (!g.noStroke || grow > 0) polyline(pts, !!g.close, g.noStroke ? 2 * grow : w, g, out);
  } else if (g.t === "text") textPrims(g, out, knock, log);
}

// ---------------------------------------------------------------- pads
/** PAD::GetSolderMaskExpansion. */
function maskMargin(pad: Pad, m: BoardModel, shape: PadShape): number {
  if (![...pad.layers].some(isCopper)) return 0;   // a pad on technical layers only keeps its own shape
  let v = pad.maskMargin ?? pad.fp.maskMargin ?? m.settings.maskExpansion;
  if (v < 0) v = Math.max(v, -Math.min(shape.w, shape.h) / 2);
  return v;
}
/** PAD::GetSolderPasteMargin: an absolute margin plus a ratio of the pad's size, per axis. */
function pasteMargin(pad: Pad, m: BoardModel, shape: PadShape): Pt {
  if (![...pad.layers].some(isCopper)) return [0, 0];
  const abs = pad.pasteMargin ?? pad.fp.pasteMargin ?? m.settings.pasteClearance;
  const ratio = pad.pasteRatio ?? pad.fp.pasteRatio ?? m.settings.pasteRatio;
  let mx = abs + shape.w * ratio, my = abs + shape.h * ratio;
  if (shape.shape !== "custom") { mx = Math.max(mx, -shape.w / 2); my = Math.max(my, -shape.h / 2); }
  return [mx, my];
}

/** TransformRoundChamferedRectToPolygon: a rectangle with some corners cut and the others rounded, pad frame. */
function chamferedRect(w: number, h: number, radius: number, ratio: number, corners: string[]): Pt[] {
  const hx = w / 2, hy = h / 2, c = Math.max(0, ratio * Math.min(w, h)); const pts: Pt[] = [];
  const corner = (name: string, x: number, y: number, sx: number, sy: number, a0: number): void => {
    // the corner at (x, y); sx, sy point into the rectangle along each axis; corners run clockwise on screen
    if (corners.includes(name)) {
      if (c <= 0) { pts.push([x, y]); return; }
      // the first point lies on the edge we arrive along, the second on the edge we leave by
      const horizFirst = name === "top_right" || name === "bottom_left";
      if (horizFirst) pts.push([x + sx * c, y], [x, y + sy * c]); else pts.push([x, y + sy * c], [x + sx * c, y]);
    } else if (radius > 1e-9) {
      for (const p of arcPoints(x + sx * radius, y + sy * radius, radius, a0, a0 + Math.PI / 2, false, MAX_ERROR)) pts.push(p);
    } else pts.push([x, y]);
  };
  corner("top_left", -hx, -hy, 1, 1, Math.PI);
  corner("top_right", hx, -hy, -1, 1, 3 * Math.PI / 2);
  corner("bottom_right", hx, hy, -1, -1, 0);
  corner("bottom_left", -hx, hy, 1, -1, Math.PI / 2);
  return pts;
}

/** A custom pad's anchor and primitives as polygons in the pad frame (PAD::MergePrimitivesAsPolygon, before the union). */
function customPolys(shape: PadShape): Pt[][] {
  const polys: Pt[][] = [];
  if (shape.anchor === "circle") polys.push(circlePoints(0, 0, shape.w / 2, MAX_ERROR));
  else polys.push([[-shape.w / 2, -shape.h / 2], [shape.w / 2, -shape.h / 2], [shape.w / 2, shape.h / 2], [-shape.w / 2, shape.h / 2]]);
  if (!shape.primitives) return polys;
  const widthOf = (p: Node): number => { const st = K(p, "stroke"); const wn = st ? K(st, "width") : K(p, "width"); return wn ? num(wn[1], 0) : 0; };
  const filled = (p: Node): boolean => { const f = K(p, "fill"); if (!f) return false; const t = K(f, "type"); const v = t ? str(t[1]) : str(f[1]); return v === "yes" || v === "solid"; };
  const stroke = (pts: Pt[], w: number, close: boolean): void => {
    if (!(w > 0)) return;
    const path = close ? pts.concat([pts[0]]) : pts;
    for (let i = 0; i + 1 < path.length; i++) polys.push(stadium(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], w));
  };
  for (const p of shape.primitives.slice(1)) {
    if (!isList(p)) continue; const kind = str(p[0]); const w = widthOf(p);
    if (kind === "gr_poly") {
      const pts = polyPtsOf(p) as Pt[]; if (pts.length < 3) continue;
      polys.push(pts); stroke(pts, w, true);
    } else if (kind === "gr_line") {
      const s = K(p, "start"), e = K(p, "end"); if (s && e) stroke([[num(s[1]), num(s[2])], [num(e[1]), num(e[2])]], w, false);
    } else if (kind === "gr_rect") {
      const s = K(p, "start"), e = K(p, "end"); if (!s || !e) continue;
      const pts: Pt[] = [[num(s[1]), num(s[2])], [num(e[1]), num(s[2])], [num(e[1]), num(e[2])], [num(s[1]), num(e[2])]];
      if (filled(p)) polys.push(pts); stroke(pts, w, true);
    } else if (kind === "gr_circle") {
      const c = K(p, "center"), e = K(p, "end"); if (!c || !e) continue;
      const r = Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]));
      if (filled(p)) polys.push(circlePoints(num(c[1]), num(c[2]), r + w / 2, MAX_ERROR));
      else stroke(circlePoints(num(c[1]), num(c[2]), r, MAX_ERROR), w, true);
    } else if (kind === "gr_arc") {
      const s = K(p, "start"), mid = K(p, "mid"), e = K(p, "end"), ang = K(p, "angle"); if (!s || !e) continue;
      let pts: Pt[] = [];
      if (mid) {
        const [ax, ay, bx, by, cx, cy] = [num(s[1]), num(s[2]), num(mid[1]), num(mid[2]), num(e[1]), num(e[2])];
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-12) pts = [[ax, ay], [cx, cy]];
        else {
          const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
          const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
          const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
          const nm = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          pts = arcPoints(ux, uy, Math.hypot(ax - ux, ay - uy), a0, a1, !(nm(am - a0) <= nm(a1 - a0)), MAX_ERROR);
        }
      } else if (ang) {
        // KiCad 5: (start centre) (end start-point) (angle degrees, clockwise on screen)
        const cx = num(s[1]), cy = num(s[2]), sx = num(e[1]), sy = num(e[2]); const r = Math.hypot(sx - cx, sy - cy), a0 = Math.atan2(sy - cy, sx - cx), sweep = num(ang[1]) * Math.PI / 180;
        pts = arcPoints(cx, cy, r, a0, a0 + sweep, sweep < 0, MAX_ERROR);
      }
      stroke(pts, w, false);
    } else if (kind === "gr_curve") {
      const cp = polyPtsOf(p) as Pt[]; if (cp.length !== 4) continue;
      const pts: Pt[] = []; const n = 32;
      for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u * u * u * cp[0][0] + 3 * u * u * t * cp[1][0] + 3 * u * t * t * cp[2][0] + t * t * t * cp[3][0], u * u * u * cp[0][1] + 3 * u * u * t * cp[1][1] + 3 * u * t * t * cp[2][1] + t * t * t * cp[3][1]]); }
      stroke(pts, w, false);
    }
  }
  return polys.map(clockwise);
}

/** One pad on one layer (plotPadLayer in PlotStandardLayer, then BRDITEMS_PLOTTER::PlotPad). */
export function padPrims(pad: Pad, layer: string, m: BoardModel, out: Prim[], adj = 0): void {
  const shape = padShapeOn(pad, layer, m.copper);
  const onMask = /\.Mask$/.test(layer), onPaste = /\.Paste$/.test(layer);
  let mx = 0, my = 0;
  if (onMask) mx = my = maskMargin(pad, m, shape);
  if (onPaste) [mx, my] = pasteMargin(pad, m, shape);
  const same = Math.abs(mx - my) < 1e-9;
  // padPlotsSize: the size grown by the margins and the width correction
  const w = shape.w + 2 * mx + adj, h = shape.h + 2 * my + adj;
  if (shape.shape !== "custom" && (w <= 0 || h <= 0)) return;
  const [ox, oy] = rot(shape.offset[0], shape.offset[1], pad.rot);
  const x = pad.x + ox, y = pad.y + oy, r = pad.rot;
  const flashPolys = (polys: Pt[][]): void => {
    // pad frame → board, as offsets from the flash position
    for (const poly of fracture(polys)) out.push({ k: "poly", x, y, pts: poly.map((p) => rot(p[0], p[1], r)) });
  };
  switch (shape.shape) {
    case "circle": out.push({ k: "circle", x, y, d: w }); break;
    case "oval": if (Math.abs(w - h) < 1e-9) out.push({ k: "circle", x, y, d: w }); else out.push({ k: "oval", x, y, w, h, rot: r }); break;
    case "rect":
      // a mask opening grows a rectangle with round corners of the margin's radius
      if (mx > 0 && same) out.push({ k: "roundrect", x, y, w, h, r: mx, rot: r });
      else out.push({ k: "rect", x, y, w, h, rot: r });
      break;
    case "roundrect": {
      const r0 = shape.rratio * Math.min(shape.w, shape.h);
      const rr = Math.min(same ? Math.max(0, r0 + mx + adj / 2) : shape.rratio * Math.min(w, h), Math.min(w, h) / 2);
      if (rr <= 1e-9) out.push({ k: "rect", x, y, w, h, rot: r });
      else if (Math.abs(w - h) < 1e-9 && Math.abs(rr - w / 2) < 1e-9) out.push({ k: "circle", x, y, d: w });
      else out.push({ k: "roundrect", x, y, w, h, r: rr, rot: r });
      break;
    }
    case "trapezoid": {
      const hx = shape.w / 2, hy = shape.h / 2, dx = shape.delta[0] / 2, dy = shape.delta[1] / 2;
      const pts: Pt[] = [[-hx - dy, hy + dx], [hx + dy, hy - dx], [hx - dy, -hy + dx], [-hx + dy, -hy - dx]];
      flashPolys(mx ? inflate([pts], mx) : [pts]);
      break;
    }
    case "chamfer": {
      if (mx <= 0 || !same) flashPolys([chamferedRect(w, h, shape.rratio * Math.min(w, h), shape.chamferRatio, shape.chamfers)]);
      else flashPolys(inflate([chamferedRect(shape.w, shape.h, shape.rratio * Math.min(shape.w, shape.h), shape.chamferRatio, shape.chamfers)], mx));
      break;
    }
    case "custom": {
      let polys = union(customPolys(shape));
      if (mx) polys = inflate(polys, mx);
      flashPolys(polys);
      break;
    }
    default: out.push({ k: "rect", x, y, w, h, rot: r });
  }
}

// ---------------------------------------------------------------- unused-layer removal
/** Where tracks end and zones reach on each copper layer: what keeps an inner annular ring. */
class Connections {
  private readonly ends = new Map<string, Map<string, Pt[]>>();
  constructor(m: BoardModel) {
    const add = (layer: string, x: number, y: number): void => {
      let cells = this.ends.get(layer); if (!cells) { cells = new Map(); this.ends.set(layer, cells); }
      const key = Math.floor(x) + "," + Math.floor(y); const c = cells.get(key); if (c) c.push([x, y]); else cells.set(key, [[x, y]]);
    };
    for (const t of m.tracks) { add(t.layer, t.x1, t.y1); add(t.layer, t.x2, t.y2); }
  }
  /** Does a track end within `r` of (x, y) on the layer? */
  near(layer: string, x: number, y: number, r: number): boolean {
    const cells = this.ends.get(layer); if (!cells) return false;
    for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      const c = cells.get(cx + "," + cy); if (!c) continue;
      for (const p of c) if (Math.hypot(p[0] - x, p[1] - y) <= r) return true;
    }
    return false;
  }
}

/** PAD::FlashLayer / PCB_VIA::FlashLayer on a copper layer. */
function flashed(removeUnused: boolean, keepEnds: boolean, zoneLayers: Set<string>, layer: string, first: string, last: string, x: number, y: number, r: number, conn: Connections): boolean {
  if (!removeUnused) return true;
  if (keepEnds && (layer === first || layer === last)) return true;
  if (zoneLayers.has(layer)) return true;
  return conn.near(layer, x, y, r);
}

// ---------------------------------------------------------------- the layer
function viaOnMask(v: Via, front: boolean, m: BoardModel, opt: PlotOptions): boolean {
  if (opt.forceTentVias) return false;
  if (!v.layers.includes(front ? "F.Cu" : "B.Cu")) return false;
  const own = front ? v.tentFront : v.tentBack;
  const tented = own !== null ? own : front ? m.settings.tentFront : m.settings.tentBack;
  return !tented;
}

export function footprintGeoms(fp: Footprint, layer: string, opt: PlotOptions): KGeom[] {
  if (fp.privateLayers.has(layer)) return [];
  const out: KGeom[] = [];
  for (const g of fp.item.geom) {
    if (g.pad || g.hole || g.padText || g.zoneOutline || g.zoneFill || g.zoneHatch || g.point) continue;
    if (g.layer !== layer && g.maskLayer !== layer) continue;
    if (g.t === "text") {
      if (g.field === "Reference" && !opt.plotReference) continue;
      if (g.field === "Value" && !opt.plotValue) continue;
    }
    // a part that is not populated is drawn as an outline on the Fab layers
    if (fp.dnp && isFab(layer) && opt.sketchDnpOnFab !== false && g.t !== "text") out.push(Object.assign({}, g, { w: SKETCH_WIDTH, fill: null, noStroke: false }) as KGeom);
    else out.push(g);
  }
  return out;
}

/** The centre-line points of plotted shapes (what a courtyard or a board outline spans, without its pen). */
export function centrePoints(prims: Prim[]): Pt[] {
  const out: Pt[] = [];
  for (const p of prims) {
    if (p.clear) continue;
    if (p.k === "seg") out.push([p.x1, p.y1], [p.x2, p.y2]);
    else if (p.k === "arc") for (const q of arcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, 0.005)) out.push(q);
    else if (p.k === "region") for (const q of p.pts) out.push(q);
    else if (p.k === "poly") for (const q of p.pts) out.push([p.x + q[0], p.y + q[1]]);
    else if (p.k !== "td") out.push([p.x, p.y]);
  }
  return out;
}

/**
 * The cross over a footprint that is not populated: the diagonals of its courtyard's box, taken in the
 * footprint's own frame so it stays tight on a turned part (everything the footprint draws when it has no courtyard).
 */
function dnpCross(fp: Footprint, m: BoardModel, log: PlotLog, out: Prim[]): void {
  const court = fp.side === "B.Cu" ? "B.CrtYd" : "F.CrtYd";
  let prims: Prim[] = []; const knock: Prim[] = [];
  for (const g of fp.item.geom) if (g.layer === court && g.t !== "text" && !g.pad && !g.hole && !g.padText) geomPrims(g, prims, knock, log, 0);
  let pts = centrePoints(prims);
  if (!pts.length) {
    prims = [];
    for (const g of fp.item.geom) if (g.t !== "text" && !g.pad && !g.hole && !g.padText && !g.zoneOutline && !g.zoneFill && !g.zoneHatch && !g.point) geomPrims(g, prims, knock, log, 0);
    for (const pad of fp.pads) for (const l of pad.layers) { if (isCopper(l)) { padPrims(pad, l, m, prims); break; } }
    pts = []; for (const p of prims) for (const poly of primPolys(p)) for (const q of poly) pts.push(q);
  }
  if (!pts.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { const [lx, ly] = rot(q[0] - fp.x, q[1] - fp.y, -fp.rot); if (lx < x0) x0 = lx; if (ly < y0) y0 = ly; if (lx > x1) x1 = lx; if (ly > y1) y1 = ly; }
  const back = (lx: number, ly: number): Pt => { const [x, y] = rot(lx, ly, fp.rot); return [fp.x + x, fp.y + y]; };
  const a = back(x0, y0), b = back(x1, y0), c = back(x1, y1), d = back(x0, y1);
  out.push({ k: "seg", x1: a[0], y1: a[1], x2: c[0], y2: c[1], w: FAB_LINE_WIDTH }, { k: "seg", x1: b[0], y1: b[1], x2: d[0], y2: d[1], w: FAB_LINE_WIDTH });
}

/** The net name of a board item node ((net N) or (net "name")). */
function netOf(n: Node, m: BoardModel): string {
  const nn = kid(n, "net") as Node | null; if (!nn) return "";
  return typeof nn[1] === "number" ? (nn.length > 2 ? str(nn[2]) : str(m.doc.nets.get(nn[1]) || "")) : str(nn[1]);
}

/** BRDITEMS_PLOTTER::PlotPad's GBR_METADATA (plot_brditems_plotter.cpp:162-287). */
export function padMeta(pad: Pad, layer: string, m: BoardModel): GbrMeta {
  const ref = pad.fp.ref;
  if (!isCopper(layer)) return { info: 4, ref };
  const external = layer === m.copper[0] || layer === m.copper[m.copper.length - 1] || layer === "F.Cu" || layer === "B.Cu";
  const fnNode = kid(pad.node, "pinfunction") as Node | null;
  const meta: GbrMeta = { info: external ? 7 : 6, ref, pad: pad.number, pinFn: pad.number && fnNode ? str(fnNode[1]) : "", net: pad.net, af: "Conductor",
    notInNet: pad.type === "np_thru_hole" || !pad.number };
  if (pad.type === "np_thru_hole") meta.af = "WasherPad";
  else if (pad.type === "thru_hole") meta.af = "ComponentPad";
  else if (pad.type === "connect") { if (external) meta.af = "ConnectorPad"; }
  else if (pad.type === "smd") { if (external) meta.af = "SMDPad,CuDef"; }
  switch (pad.property) {
    case "pad_prop_bga": if (external) meta.af = "BGAPad,CuDef"; break;
    case "pad_prop_fiducial_glob": meta.af = "FiducialPad,Global"; break;
    case "pad_prop_fiducial_loc": meta.af = "FiducialPad,Local"; break;
    case "pad_prop_testpoint": if (external) meta.af = "TestPad"; break;
    case "pad_prop_heatsink": meta.af = "HeatsinkPad"; break;
    case "pad_prop_castellated": meta.af = "CastellatedPad"; break;
    default: break;
  }
  if (pad.type === "np_thru_hole") meta.af = "WasherPad";
  return meta;
}

/** BRDITEMS_PLOTTER::PlotPadNumber: the number centred on the pad, sized for three characters, turned when the pad is tall. */
function padNumber(pad: Pad, shape: Prim[], out: Prim[]): void {
  const text = pad.number; if (!text || !shape.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of shape) for (const poly of primPolys(p)) for (const q of poly) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  if (!(x1 > x0)) return;
  let w = x1 - x0, h = y1 - y0; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const base = pad.base; const limit = Math.min(base.w, base.h) * 1.1;
  if (base.shape !== "custom" && w > limit && h > limit) { w = limit; h = limit; }
  let rotDeg = 0;
  if (w < h * 0.95) { rotDeg = 90; const t = w; w = h; h = t; }
  let size = w / Math.max(text.length, 3); size = Math.min(size, h, 5);
  const pen = size / 12;
  const C = canvas(); const line = C.strokeLine(text, false);
  const [ox, oy] = C.strokeOrigin(line.advance, "center", "middle", pen / size, pen / size);
  const a = -rotDeg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  const P = (u: number, v: number): Pt => { const lx = (u + ox) * size, ly = (v + oy) * size; return [cx + lx * c - ly * sn, cy + lx * sn + ly * c]; };
  for (const st of line.strokes) for (let i = 0; i + 3 < st.length; i += 2) { const p = P(st[i], st[i + 1]), q = P(st[i + 2], st[i + 3]); out.push({ k: "seg", x1: p[0], y1: p[1], x2: q[0], y2: q[1], w: pen }); }
}

/** The primitives of one layer, in plot order. */
export function plotLayer(m: BoardModel, layer: string, opt: PlotOptions, log: PlotLog, conn?: Connections): Prim[] {
  const out: Prim[] = [], knock: Prim[] = [];
  const cu = isCopper(layer), mask = /\.Mask$/.test(layer);
  const tag = (at: number, k0: number, meta: GbrMeta): void => { for (let i = at; i < out.length; i++) if (!out[i].meta) out[i].meta = meta; for (let i = k0; i < knock.length; i++) if (!knock[i].meta) knock[i].meta = meta; };
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  const connections = conn || new Connections(m);
  const growOf = (g: KGeom): number => (g.layer !== layer && g.maskLayer === layer ? (typeof g.maskMargin === "number" ? g.maskMargin : m.settings.maskExpansion) : 0);
  const useGeom = (g: KGeom): void => {
    const grow = growOf(g);
    if (grow < 0 && N(g.w) + 2 * grow <= 0 && !g.fill) return;
    geomPrims(g, out, knock, log, grow);
  };

  // board graphics, text, dimensions, tables, barcodes
  for (const item of m.doc.items.values()) {
    const k = item.kind;
    if (k === "footprint" || k === "segment" || k === "arc" || k === "via" || k === "zone" || k === "image" || k === "group" || k === "point" || k === "generated" || k === "gr_bbox" || k === "grid_item") continue;
    const at = out.length, k0 = knock.length;
    for (const g of item.geom) {
      if (g.layer !== layer && g.maskLayer !== layer) continue;
      if (g.hiddenText || g.point) continue;
      useGeom(g);
    }
    if (out.length > at || knock.length > k0) {
      const net = item.node ? netOf(item.node, m) : "";
      const text = /text|dimension|table|barcode/.test(k);
      tag(at, k0, layer === "Edge.Cuts" ? { af: "Profile" } : !cu ? {} : text || !net ? { af: "NonConductor" } : { af: "Conductor", info: 2, net });
    }
  }
  // footprint text, then footprint graphics
  const hidden = (fp: Footprint): boolean => fp.dnp && isFab(layer) && !!opt.hideDnpOnFab;
  const fpGeoms = m.footprints.map((fp) => (hidden(fp) ? [] : footprintGeoms(fp, layer, opt)));
  // GBR_METADATA of footprint items: the component (.C), etched copper on a copper layer, the board profile on Edge.Cuts
  const fpMeta = (fp: Footprint): GbrMeta => ({ info: 4, ref: fp.ref, af: layer === "Edge.Cuts" ? "Profile" : cu ? "EtchedComponent" : undefined });
  fpGeoms.forEach((gs, i) => { const at = out.length, k0 = knock.length; for (const g of gs) if (g.t === "text") useGeom(g); tag(at, k0, { info: 4, ref: m.footprints[i].ref, af: cu ? "NonConductor" : undefined }); });
  fpGeoms.forEach((gs, i) => { const at = out.length, k0 = knock.length; for (const g of gs) if (g.t !== "text") useGeom(g); tag(at, k0, fpMeta(m.footprints[i])); });

  // pads
  for (const fp of m.footprints) for (const pad of fp.pads) {
    if (!pad.layers.has(layer)) continue;
    if (cu) {
      const shape = padShapeOn(pad, layer, m.copper);
      if (pad.type === "np_thru_hole" && pad.drill && !shape.offset[0] && !shape.offset[1]) {
        // an NPTH pad no larger than its hole has no copper
        if (shape.shape === "circle" && !pad.drill.oval && pad.drill.w >= shape.w - 1e-9) continue;
        if (shape.shape === "oval" && pad.drill.w >= shape.w - 1e-9 && pad.drill.h >= shape.h - 1e-9) continue;
      }
      if (pad.type === "thru_hole" && !flashed(pad.removeUnused, pad.keepEnds, pad.zoneLayers, layer, first, last, pad.x, pad.y, Math.max(shape.w, shape.h) / 2, connections)) continue;
    }
    const at = out.length;
    padPrims(pad, layer, m, out, cu ? opt.widthAdj || 0 : 0);
    tag(at, knock.length, padMeta(pad, layer, m));
  }
  // "Sketch pads on fabrication layers": the copper outline of the side's pads at the sketch width, with their numbers
  if (isFab(layer) && opt.sketchPadsOnFab) {
    const side = layer === "F.Fab" ? "F.Cu" : "B.Cu";
    for (const fp of m.footprints) {
      if (hidden(fp)) continue;
      for (const pad of fp.pads) {
        if (pad.layers.has(layer) || !pad.layers.has(side)) continue;
        const shape: Prim[] = []; padPrims(pad, side, m, shape);
        for (const p of shape) for (const poly of primPolys(p)) polyline(poly, true, SKETCH_WIDTH, {} as KGeom, out);
        if (opt.plotPadNumbers) padNumber(pad, shape, out);
      }
    }
  }
  if (isFab(layer) && !opt.hideDnpOnFab && opt.crossoutDnpOnFab !== false)
    for (const fp of m.footprints) if (fp.dnp && (layer === "F.Fab") === (fp.side !== "B.Cu")) dnpCross(fp, m, log, out);

  // vias
  for (const v of m.vias) {
    let d = 0;
    if (cu) {
      if (!v.layers.includes(layer)) continue;
      d = v.sizes ? v.sizes.get(layer) ?? v.size : v.size;
      if (!flashed(v.removeUnused, v.keepEnds, v.zoneLayers, layer, v.layers[0], v.layers[v.layers.length - 1], v.x, v.y, d / 2, connections)) continue;
    } else if (mask) {
      const front = isFront(layer);
      if (!viaOnMask(v, front, m, opt)) continue;
      const cuLayer = front ? "F.Cu" : "B.Cu";
      d = (v.sizes ? v.sizes.get(cuLayer) ?? v.size : v.size) + 2 * m.settings.maskExpansion;
    } else continue;
    if (cu) d += opt.widthAdj || 0;
    if (d > 0) out.push({ k: "circle", x: v.x, y: v.y, d, meta: cu ? { af: "ViaPad", info: 2, net: v.net } : undefined });
  }

  // tracks
  for (const t of m.tracks) {
    let w = t.w;
    if (t.layer !== layer) {
      if (!mask || t.maskLayer !== layer) continue;
      w += 2 * (t.maskMargin ?? m.settings.maskExpansion);
    }
    w += opt.widthAdj || 0;
    if (!(w > 0)) continue;
    const meta: GbrMeta | undefined = cu ? { af: "Conductor", info: 2, net: t.net || "" } : undefined;
    if (t.arc && Math.hypot(t.x2 - t.x1, t.y2 - t.y1) > 1e-5) out.push({ k: "arc", cx: t.arc.cx, cy: t.arc.cy, r: t.arc.r, a0: t.arc.a0, a1: t.arc.a1, acw: t.arc.acw, w, meta });
    else out.push({ k: "seg", x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, w, meta });
  }

  // zone fills
  for (const f of m.fills) if (f.layer === layer) out.push({ k: "region", pts: f.pts, meta: cu ? (f.net ? { af: "Conductor", info: 2, net: f.net } : { af: "NonConductor" }) : undefined });

  // knockout text goes first: its cleared glyphs must not erase anything plotted before them
  return knock.concat(out);
}

/**
 * PlotSolderMaskLayer with a minimum web width: every opening grown by half the width, merged, and shrunk
 * back, so openings closer than the width join; the exact openings are then laid over the result.
 */
function maskWithMinWidth(prims: Prim[], minWidth: number): Prim[] {
  const half = minWidth / 2;
  const exact: Pt[][] = []; const cleared: Prim[] = [];
  for (const p of prims) { if (p.clear) cleared.push(p); else for (const poly of primPolys(p)) exact.push(poly); }
  const merged = union(exact);
  const closed = inflate(inflate(merged, half), -half);
  const all = union(closed.concat(merged));
  const out: Prim[] = fracture(all).map((pts) => ({ k: "region", pts } as Prim));
  return out.concat(cleared);
}

/** A whole layer file's primitives: the layer itself, the mask subtraction on silk, and the common layers. */
export function plotFile(m: BoardModel, layer: string, opt: PlotOptions, log: PlotLog): Prim[] {
  const conn = new Connections(m);
  let prims = plotLayer(m, layer, opt, log, conn);
  const mask = /\.Mask$/.test(layer), silk = /\.SilkS$/.test(layer);
  if (mask && m.settings.maskMinWidth > 0) prims = maskWithMinWidth(prims, m.settings.maskMinWidth);
  if (silk && opt.subtractMaskFromSilk) {
    // the openings of the same side's mask, cleared out of the legend (KiCad plots them with negative polarity)
    const maskLayer = isBack(layer) ? "B.Mask" : "F.Mask";
    let open = plotLayer(m, maskLayer, opt, log, conn).filter((p) => !p.clear);
    if (m.settings.maskMinWidth > 0) open = maskWithMinWidth(open, m.settings.maskMinWidth);
    for (const p of open) prims.push(Object.assign({}, p, { clear: true }));
  }
  for (const extra of opt.commonLayers || []) {
    if (extra === layer) continue;
    for (const p of plotLayer(m, extra, opt, log, conn)) prims.push(p);
  }
  return prims;
}
