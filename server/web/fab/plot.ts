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
import { type Prim, type Pt, arcPoints, circlePoints, rot } from "./prims";

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

/** One text record as stroke-font segments (the transform drawStrokeText composes for the screen). */
function textPrims(g: KGeom, out: Prim[], knock: Prim[], log: PlotLog): void {
  const text = S(g.raw) || S(g.text); if (!text) return;
  const size = N(g.size, 1), sizeX = N(g.sizeX) > 0 ? N(g.sizeX) : size;
  const pen = clampPen(N(g.w) > 0 ? N(g.w) : size / 8, size, sizeX);
  if (g.face) log.warn(`Text set in the font "${S(g.face)}" is plotted with the KiCad stroke font: a browser cannot read the outlines of an installed font.`);
  const C = canvas(); const line = C.strokeLine(text, !!g.italic);
  const [ox, oy] = C.strokeOrigin(line.advance, S(g.h) || "center", S(g.v) || "middle", pen / sizeX, pen / size);
  const a = -N(g.rot) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = g.mirror ? -1 : 1;
  const x0 = N(g.x), y0 = N(g.y);
  // local (unit) → board: T(x, y) · Rot(a) · MirrorX · Scale(sx, sy) · T(ox, oy)
  const P = (u: number, v: number): Pt => { const lx = (u + ox) * sizeX * mx, ly = (v + oy) * size; return [x0 + lx * c - ly * sn, y0 + lx * sn + ly * c]; };
  const dst = g.knockout ? knock : out;
  if (g.knockout) {
    // PCB_TEXT knockout: the text box grown by GetKnockoutTextMargin = max(pen / 2, size / 9), the glyphs cleared out of it
    const m = Math.max(pen / 2, size / 9);
    const bx0 = ox * sizeX - m, by0 = (oy - 20 / 21) * size - m, bx1 = bx0 + line.width * sizeX + 2 * m, by1 = by0 + size + 2 * m;
    const Q = (lx: number, ly: number): Pt => [x0 + lx * mx * c - ly * sn, y0 + lx * mx * sn + ly * c];
    knock.push({ k: "region", pts: [Q(bx0, by0), Q(bx1, by0), Q(bx1, by1), Q(bx0, by1)] });
  }
  for (const st of line.strokes) {
    if (st.length === 2) { const p = P(st[0], st[1]); dst.push({ k: "seg", x1: p[0], y1: p[1], x2: p[0], y2: p[1], w: pen, clear: g.knockout ? true : undefined }); continue; }
    for (let i = 0; i + 3 < st.length; i += 2) {
      const p = P(st[i], st[i + 1]), q = P(st[i + 2], st[i + 3]);
      dst.push({ k: "seg", x1: p[0], y1: p[1], x2: q[0], y2: q[1], w: pen, clear: g.knockout ? true : undefined });
    }
  }
}

/** A geometry record of the canvas as primitives; `grow` widens strokes and fills (a solder mask margin on a copper graphic). */
function geomPrims(g: KGeom, out: Prim[], knock: Prim[], log: PlotLog, grow = 0): void {
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
function padPrims(pad: Pad, layer: string, m: BoardModel, out: Prim[]): void {
  const shape = padShapeOn(pad, layer, m.copper);
  const onMask = /\.Mask$/.test(layer), onPaste = /\.Paste$/.test(layer);
  let mx = 0, my = 0;
  if (onMask) mx = my = maskMargin(pad, m, shape);
  if (onPaste) [mx, my] = pasteMargin(pad, m, shape);
  const same = Math.abs(mx - my) < 1e-9;
  const w = shape.w + 2 * mx, h = shape.h + 2 * my;
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
      const rr = Math.min(same ? Math.max(0, r0 + mx) : shape.rratio * Math.min(w, h), Math.min(w, h) / 2);
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

function footprintGeoms(fp: Footprint, layer: string, opt: PlotOptions): KGeom[] {
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
    else out.push([p.x, p.y]);
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

/** The primitives of one layer, in plot order. */
export function plotLayer(m: BoardModel, layer: string, opt: PlotOptions, log: PlotLog, conn?: Connections): Prim[] {
  const out: Prim[] = [], knock: Prim[] = [];
  const cu = isCopper(layer), mask = /\.Mask$/.test(layer);
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
    for (const g of item.geom) {
      if (g.layer !== layer && g.maskLayer !== layer) continue;
      if (g.hiddenText || g.point) continue;
      useGeom(g);
    }
  }
  // footprint text, then footprint graphics
  const hidden = (fp: Footprint): boolean => fp.dnp && isFab(layer) && !!opt.hideDnpOnFab;
  const fpGeoms = m.footprints.map((fp) => (hidden(fp) ? [] : footprintGeoms(fp, layer, opt)));
  for (const gs of fpGeoms) for (const g of gs) if (g.t === "text") useGeom(g);
  for (const gs of fpGeoms) for (const g of gs) if (g.t !== "text") useGeom(g);

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
    padPrims(pad, layer, m, out);
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
    if (d > 0) out.push({ k: "circle", x: v.x, y: v.y, d });
  }

  // tracks
  for (const t of m.tracks) {
    let w = t.w;
    if (t.layer !== layer) {
      if (!mask || t.maskLayer !== layer) continue;
      w += 2 * (t.maskMargin ?? m.settings.maskExpansion);
    }
    if (!(w > 0)) continue;
    if (t.arc && Math.hypot(t.x2 - t.x1, t.y2 - t.y1) > 1e-5) out.push({ k: "arc", cx: t.arc.cx, cy: t.arc.cy, r: t.arc.r, a0: t.arc.a0, a1: t.arc.a1, acw: t.arc.acw, w });
    else out.push({ k: "seg", x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, w });
  }

  // zone fills
  for (const f of m.fills) if (f.layer === layer) out.push({ k: "region", pts: f.pts });

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
