// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { PCB_BG, PCB_PAGE_LIMITS, PCB_SHEET, SCH, schTheme } from "./colors";
import { inSchTheme } from "./geom";
import { bboxOf } from "./hit";
import { FONT_EM, FONT_FAMILY, HIDDEN_TEXT_ALPHA, cssFamily, dashPattern, faceAvailable, makeCanvas, render, textMode, tracePath } from "./render";
import { isList, kid, quotedMask, str, splitLines } from "./sexpr";
import { documentDrawingSheet } from "./sheet";
import { TEXT_INTERLINE, lineOffsets, textWidth } from "./text";
import { strokeLine, strokeOrigin } from "./stroke-font";
import type { Doc, DrawTextG, ExportOpts, Geom, Item, PathSink, SAtom } from "./types";

/** An SvgPath: the `d` string built so far, the current point and the subpath start. */
export interface SvgPathT extends PathSink { d: string; cx: number | null; cy: number | null; sx: number; sy: number }
/** SvgPath is a constructor function (called with new); this is its type as one. */
type SvgPathCtor = new () => SvgPathT;
// ---------------------------------------------------------------- export (File → Plot / Export)
export const fmt = (v: number | string): string => { const s = (+v).toFixed(4); return s.replace(/\.?0+$/, "") === "-0" ? "0" : s.replace(/\.?0+$/, "") || "0"; };

export const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A canvas-path-shaped sink that builds an SVG path `d` string, so tracePath / tracePad serve both targets. */
export function SvgPath(this: SvgPathT): void { this.d = ""; this.cx = null; this.cy = null; this.sx = 0; this.sy = 0; }

SvgPath.prototype.moveTo = function (this: SvgPathT, x: number, y: number) { this.d += "M" + fmt(x) + " " + fmt(y); this.cx = this.sx = x; this.cy = this.sy = y; };

SvgPath.prototype.lineTo = function (this: SvgPathT, x: number, y: number) { if (this.cx === null) return this.moveTo(x, y); this.d += "L" + fmt(x) + " " + fmt(y); this.cx = x; this.cy = y; };

SvgPath.prototype.closePath = function (this: SvgPathT) { if (this.cx !== null) { this.d += "Z"; this.cx = this.sx; this.cy = this.sy; } };

SvgPath.prototype.rect = function (this: SvgPathT, x: number, y: number, w: number, h: number) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); };

SvgPath.prototype.arc = function (this: SvgPathT, x: number, y: number, r: number, a0: number, a1: number, acw?: boolean) {
  // canvas semantics: a line from the current point to the arc start, then the arc (clamped to one full turn)
  const p0x = x + r * Math.cos(a0), p0y = y + r * Math.sin(a0);
  if (this.cx === null) this.moveTo(p0x, p0y); else if (Math.hypot(this.cx - p0x, this.cy! - p0y) > 1e-9) this.lineTo(p0x, p0y);
  const TAU = 2 * Math.PI; let sweep: number;
  if (!acw) { sweep = a1 - a0; sweep = sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU; }
  else { sweep = a0 - a1; sweep = -(sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU); }
  const sf = acw ? 0 : 1, rs = fmt(r);
  if (Math.abs(sweep) >= TAU - 1e-9) {
    const am = a0 + (acw ? -Math.PI : Math.PI);
    this.d += "A" + rs + " " + rs + " 0 1 " + sf + " " + fmt(x + r * Math.cos(am)) + " " + fmt(y + r * Math.sin(am)) + "A" + rs + " " + rs + " 0 1 " + sf + " " + fmt(p0x) + " " + fmt(p0y);
    this.cx = p0x; this.cy = p0y; return;
  }
  const p1x = x + r * Math.cos(a0 + sweep), p1y = y + r * Math.sin(a0 + sweep);
  this.d += "A" + rs + " " + rs + " 0 " + (Math.abs(sweep) > Math.PI ? 1 : 0) + " " + sf + " " + fmt(p1x) + " " + fmt(p1y);
  this.cx = p1x; this.cy = p1y;
};

/** One geometry record as SVG markup (same fill / stroke rules as the canvas painter), or "" when it draws nothing. */
export function svgGeom(g: Geom | DrawTextG, hairline: number, isPcb: boolean, bg: string | null | false | undefined): string {
  const t = g.t; const sw = (w: number | undefined) => Math.max(w || 0, hairline);
  const op = g.alpha !== undefined && g.alpha < 1 ? ` opacity="${fmt(g.alpha)}"` : "";
  const dash = (w: number) => g.dash ? ` stroke-dasharray="${dashPattern(g.dashType, w).map(fmt).join(" ")}"` : "";
  const cap = g.cap || (t === "poly" || t === "line" ? "round" : "butt");
  const stroke = (w: number | undefined, color?: string) => { const lw = sw(w); return ` stroke="${color || g.color}" stroke-width="${fmt(lw)}" stroke-linecap="${cap}"${dash(lw)}`; };
  if (t === "text") {
    if (!g.text) return "";
    const outline = !!g.face && faceAvailable(g.face);
    if (!outline && textMode() === "stroke") return svgStrokeText(g, hairline, bg, op);
    const size = g.size, base0 = g.v === "top" ? size : g.v === "bottom" ? 0 : size / 2;
    const tr = `translate(${fmt(g.x)} ${fmt(g.y)})` + (g.rot ? ` rotate(${fmt(-g.rot)})` : "") + (g.mirror ? " scale(-1 1)" : "");
    const anchor = g.h === "left" ? "start" : g.h === "right" ? "end" : "middle";
    const pen = g.w || 0, extra = pen - 0.13 * size;
    let color: string | null | false | undefined = g.color, pre = "";
    if (g.knockout) {
      const w = textWidth(g.text, size, pen), m = Math.max(pen / 2, size / 9); const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2;
      pre = `<rect x="${fmt(x0 - m)}" y="${fmt(base0 - size - m)}" width="${fmt(w + 2 * m)}" height="${fmt(size + 2 * m)}" fill="${g.color}"/>`; color = bg;
    }
    const bold = !g.knockout && !g.padText && !g.bold && extra > 0.01 && isPcb ? ` stroke="${color}" stroke-width="${fmt(extra)}" stroke-linejoin="round" paint-order="stroke"` : "";
    let bars = "";
    if (g.bars && g.bars.length) {
      const total = textWidth(g.text, size, pen); const shift = g.h === "center" ? -total / 2 : g.h === "right" ? -total : 0; const y = base0 - size * 1.23;
      let d = ""; for (const [i0, i1] of g.bars) d += `M${fmt(shift + textWidth(g.text.slice(0, i0), size, pen))} ${fmt(y)}L${fmt(shift + textWidth(g.text.slice(0, i1), size, pen))} ${fmt(y)}`;
      bars = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${fmt(Math.max(pen || size / 8, hairline))}"/>`;
    }
    const face = (g.bold ? ' font-weight="600"' : "") + (g.italic ? ' font-style="italic"' : "");
    const attrs = `font-family='${outline ? cssFamily(g.face!) + ", " : ""}${FONT_FAMILY}' font-size="${fmt(size * FONT_EM)}" text-anchor="${anchor}" fill="${color}"${face}${bold}`;
    // A multiline drawing-sheet field becomes one <text> per line, an interline apart, with the block
    // centred on the anchor — EDA_TEXT::GetLinePositions.  SVG would swallow the newline otherwise.
    let body: string;
    if (g.multiline && g.text.indexOf("\n") >= 0) {
      const ls = splitLines(g.text), step = size * TEXT_INTERLINE, offs = lineOffsets(ls.length, g.v);
      body = ls.map((t, i) => `<text y="${fmt(base0 + offs[i] * step)}" ${attrs}>${esc(t)}</text>`).join("");
    } else body = `<text y="${fmt(base0)}" ${attrs}>${esc(g.text)}</text>`;
    return `<g transform="${tr}"${op}>${pre}${body}${bars}</g>`;
  }
  if (t === "image") {
    const e = g.entry; if (!e || !e.url) return "";
    return `<image x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" preserveAspectRatio="none" href="${e.url}"${op}/>`;
  }
  if (t === "rect") {
    const fill = g.fill ? ` fill="${g.fill}"` : ' fill="none"';
    return `<rect x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}"${fill}${g.noStroke ? "" : stroke(g.wd)}${op}/>`;
  }
  if (t === "line") return `<path d="M${fmt(g.x1)} ${fmt(g.y1)}L${fmt(g.x2)} ${fmt(g.y2)}" fill="none"${stroke(g.w)}${op}/>`;
  if (t === "poly" && (!g.pts || g.pts.length < 2)) return "";
  const p = new (SvgPath as unknown as SvgPathCtor)(); tracePath(p, g);
  const fill = g.fill ? ` fill="${g.fill}"` : ' fill="none"';
  const stroked = !g.noStroke && ((t as string) === "line" || t === "arc" || (t === "poly" && (g.w > 0 || !g.fill)) || (t === "circle" && (g.w > 0 || !g.fill)) || (t === "pad" && !g.fill));
  if (t === "circle" && !g.pie) return `<circle cx="${fmt(g.x)}" cy="${fmt(g.y)}" r="${fmt(g.r)}"${fill}${stroked ? stroke(g.w) : ""}${op}/>`;
  return `<path d="${p.d}"${fill}${stroked ? stroke(g.w) : ""}${op}/>`;
}

/**
 * A text geometry in KiCad's stroke font, as KiCad's SVG plotter writes it: the glyph strokes as one path with round
 * caps and joins (the same layout, anchor fudges and markup as the canvas painter, drawStrokeText), the knockout box
 * under it.  Coordinates are document millimetres.
 */
export function svgStrokeText(g: DrawTextG, hairline: number, bg: string | null | false | undefined, op: string): string {
  const text = g.raw || g.text || "", size = g.size, sx = g.sizeX! > 0 ? g.sizeX! : size;
  const pen = Math.max(g.w > 0 ? g.w : size / 8, hairline);
  const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = g.mirror ? -1 : 1;
  const m0 = c * mx * sx, m1 = sn * mx * sx, m2 = -sn * size, m3 = c * size;
  const lines = g.multiline && text.indexOf("\n") >= 0 ? splitLines(text) : [text];
  const offs = lines.length > 1 ? lineOffsets(lines.length, g.v) : [0];
  let d = "", pre = "", color: string | null | false | undefined = g.color;
  for (let i = 0; i < lines.length; i++) {
    const line = strokeLine(lines[i], !!g.italic); if (!line.strokes.length) continue;
    const [ox, oy0] = strokeOrigin(line.advance, g.h, g.v, pen / sx, pen / size); const oy = oy0 + offs[i] * TEXT_INTERLINE;
    const X = (u: number, v: number) => g.x + m0 * (u + ox) + m2 * (v + oy), Y = (u: number, v: number) => g.y + m1 * (u + ox) + m3 * (v + oy);
    if (g.knockout && i === 0) {
      const m = Math.max(pen / 2, size / 9) / size, mxu = Math.max(pen / 2, size / 9) / sx;   // the inflated glyph cell, in unit space
      const u0 = -mxu, u1 = line.width + mxu, v0 = -20 / 21 - m, v1 = 1 / 21 + m;
      pre = `<path d="M${fmt(X(u0, v0))} ${fmt(Y(u0, v0))}L${fmt(X(u1, v0))} ${fmt(Y(u1, v0))}L${fmt(X(u1, v1))} ${fmt(Y(u1, v1))}L${fmt(X(u0, v1))} ${fmt(Y(u0, v1))}Z" fill="${g.color}"/>`;
      color = bg;
    }
    for (const st of line.strokes) { d += `M${fmt(X(st[0], st[1]))} ${fmt(Y(st[0], st[1]))}`; for (let k = 2; k < st.length; k += 2) d += `L${fmt(X(st[k], st[k + 1]))} ${fmt(Y(st[k], st[k + 1]))}`; }
  }
  if (!d) return pre;
  return `<g${op}>${pre}<path d="${d}" fill="none" stroke="${color}" stroke-width="${fmt(pen)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

/** The export area: opts.bbox, else the union of opts.ids, else the board bbox / the sheet page; margin in mm. */
export function exportBox(doc: Doc, opts: ExportOpts): { ids: Set<string> | null; x0: number; y0: number; w: number; h: number } {
  const isPcb = doc.type === "pcb"; const ids = opts.ids ? (opts.ids instanceof Set ? opts.ids : new Set(opts.ids)) : null;
  let box = opts.bbox || (ids ? bboxOf(doc, ids) : null) || (isPcb ? doc.bbox : [0, 0, doc.page[0], doc.page[1]]) || [0, 0, 10, 10];
  const margin = opts.margin !== undefined ? opts.margin : (opts.bbox ? 0 : (ids || isPcb ? 1 : 0));
  return { ids, x0: box[0] - margin, y0: box[1] - margin, w: Math.max(box[2] - box[0] + 2 * margin, 1e-3), h: Math.max(box[3] - box[1] + 2 * margin, 1e-3) };
}

/**
 * KiCad's drawing sheet as SVG elements, under the document — the same records the canvas paints
 * (web/canvas/sheet.ts), then DS_PAINTER::DrawBorder's page outline in the page-limits colour.
 */
export function svgDrawingSheet(doc: Doc, hairline: number): string[] {
  const isPcb = doc.type === "pcb";
  const ink = isPcb ? PCB_SHEET : SCH.frame;
  const out: string[] = [];
  for (const it of documentDrawingSheet(doc)) {
    if (it.t === "line") out.push(`<line x1="${fmt(it.x1)}" y1="${fmt(it.y1)}" x2="${fmt(it.x2)}" y2="${fmt(it.y2)}" stroke="${ink}" stroke-width="${fmt(it.w)}"/>`);
    else if (it.t === "rect") out.push(`<rect x="${fmt(it.x)}" y="${fmt(it.y)}" width="${fmt(it.w)}" height="${fmt(it.h)}" fill="none" stroke="${ink}" stroke-width="${fmt(it.lw)}"/>`);
    else if (it.t === "text") out.push(svgGeom({ t: "text", x: it.x, y: it.y, text: it.text, size: it.size, w: it.w, color: it.color || ink,
      rot: it.rot, h: it.h, v: it.v, bold: it.bold, italic: it.italic, multiline: it.multiline }, hairline, isPcb, null));
  }
  out.push(`<rect x="0" y="0" width="${fmt(doc.page[0])}" height="${fmt(doc.page[1])}" fill="none" stroke="${isPcb ? PCB_PAGE_LIMITS : SCH.pageLimits}" stroke-width="${fmt(hairline)}"/>`);
  return out;
}


/**
 * The document as an SVG string (mm user units, 1 mm = 1 unit, width/height in mm) built from the geometry records
 * in draw order with KiCad's colours.  opts: ids (Set/array: only those items), bbox ([x0, y0, x1, y1] mm: the
 * export area), margin (mm around the area; 1 mm for boards / subsets, 0 for a whole sheet), hidden (Set of
 * layer keys, honoured like render), background (css or false; default the theme background), frame (KiCad's
 * drawing sheet — frame, tick band, title block and page outline; default only for a whole schematic page,
 * since a board export is cropped to the board), zoneOutline, showHiddenPins, showHiddenText, padNumbers,
 * hairline (mm, the width zero-width strokes get; 0.1).  Text is <text> with the same anchoring, rotation and
 * mirroring as the canvas (board text keeps its mirror), images become data-URI <image>s.
 */
export function renderSvg(doc: Doc, opts?: ExportOpts | null): string {
  // a schematic exports in KiCad Default unless the caller names a theme (opts.colorTheme), whatever the screen shows
  if (doc.type === "sch" && (opts && opts.colorTheme || "default") !== schTheme()) return inSchTheme(doc, opts && opts.colorTheme || "default", (d) => renderSvg(d, opts));
  opts = opts || {}; const isPcb = doc.type === "pcb"; const hidden = opts.hidden || new Set();
  const { ids, x0, y0, w, h } = exportBox(doc, opts); const x1 = x0 + w, y1 = y0 + h;
  const hairline = opts.hairline !== undefined ? opts.hairline : 0.1;
  const bg = opts.background === undefined ? (isPcb ? PCB_BG : SCH.bg) : opts.background;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" stroke-linejoin="round">`];
  if (bg) out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="${bg}"/>`);
  // The board export crops to the board, so the sheet would come out sliced: it is drawn only for a
  // whole schematic page unless the caller asks (opts.frame), which is the contract this always had.
  const frame = opts.frame !== undefined ? opts.frame : (!isPcb && !ids && !opts.bbox);
  if (frame) out.push(...svgDrawingSheet(doc, hairline));
  const buckets = new Map<number, Geom[]>();
  const take = (g: Geom) => { const z = g.z === undefined ? 0 : g.z; let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g); };
  for (const it of doc.items.values()) {
    if (ids && !ids.has(it.id)) continue;
    const b = it.bbox; if (b && (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1)) continue;
    for (const g of it.geom) {
      if (hidden.has(g.layer) || (opts.zoneOutline && g.zoneFill) || (opts.padNumbers === false && g.padNum)) continue;
      take(g);
    }
    if (it.hiddenGeom) for (const g of it.hiddenGeom) { if (hidden.has(g.layer) || (g.hiddenText ? !opts.showHiddenText : !opts.showHiddenPins)) continue; take(g); }
  }
  const zs = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const z of zs) for (const g of buckets.get(z)!) {
    if (g.hiddenText) { const s = svgGeom(g, hairline, isPcb, bg || PCB_BG); if (s) out.push(`<g opacity="${HIDDEN_TEXT_ALPHA}">` + s + "</g>"); continue; }
    const s = svgGeom(g, hairline, isPcb, bg || PCB_BG); if (s) out.push(s);
  }
  out.push("</svg>");
  return out.join("\n");
}

/**
 * The document rasterised at opts.dpi (300) → Promise<Blob> (image/png) on an offscreen canvas (KiCadCanvas.createCanvas:
 * OffscreenCanvas, else a DOM canvas).  Same area / subset / layer options as renderSvg plus every render() display
 * option (flip, netNames, zoneFill, markers, …); the grid, selection and highlight are off.  opts.maxPixels (default
 * 64 M) caps the raster.
 */
export function renderPng(doc: Doc, opts?: ExportOpts | null): Promise<Blob> {
  if (doc.type === "sch" && (opts && opts.colorTheme || "default") !== schTheme()) return inSchTheme(doc, opts && opts.colorTheme || "default", (d) => renderPng(d, opts));
  opts = opts || {}; const dpi = opts.dpi! > 0 ? opts.dpi! : 300; const ppm = dpi / 25.4;
  const { x0, y0, w, h } = exportBox(doc, opts);
  let W = Math.max(1, Math.ceil(w * ppm)), H = Math.max(1, Math.ceil(h * ppm));
  const maxPixels = opts.maxPixels || 64e6;
  if (W * H > maxPixels) return Promise.reject(new Error(`renderPng: ${W}×${H} exceeds ${maxPixels} pixels — lower the dpi`));
  const canvas = makeCanvas(W, H);
  if (!canvas) return Promise.reject(new Error("renderPng: no canvas available (OffscreenCanvas / document)"));
  const ctx = canvas.getContext("2d"); if (!ctx) return Promise.reject(new Error("renderPng: no 2D context"));
  const view = { ppm, zoom: 1, panX: 0, panY: 0, x0, y0, dpr: 1 };
  const isPcb = doc.type === "pcb";
  const ropts = Object.assign({}, opts, { grid: 0, selected: null, highlight: null, frame: opts.frame !== undefined ? opts.frame : (!isPcb && !opts.ids && !opts.bbox) });
  render(doc, ctx, view, ropts);
  const type = opts.type || "image/png";
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type, quality: opts.quality });
  if (typeof canvas.toBlob === "function") return new Promise((res, rej) => canvas.toBlob!((b) => b ? res(b) : rej(new Error("renderPng: toBlob failed")), type, opts.quality));
  return Promise.reject(new Error("renderPng: canvas cannot produce a blob"));
}


export function atomText(v: unknown, quoted: boolean): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  const s = String(v);
  if (quoted || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)   // KiCad always quotes uuids
      || !/^[A-Za-z_][\w.:*-]*$/.test(s))
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  return s;
}

// Slots KiCad's writers always emit as quoted strings (Quotew / Quotes), whatever the text looks like:
// (label "VCC" ...), (property "Reference" "R1" ...), (lib_id "Device:R"), (reference "R1"), (page "1").
// The reader records the quoting of what it parsed; this covers nodes built by hand, where a bare
// identifier-shaped text would otherwise go out as a token KiCad's parser rejects (it wants T_STRING).
const STRING_SLOTS: Record<string, number> = {
  label: 1, global_label: 1, hierarchical_label: 1, netclass_flag: 1, directive_label: 1, text: 1, text_box: 1, table_cell: 1,
  property: 2, lib_id: 1, lib_name: 1, reference: 1, page: 1, path: 1, project: 1, name: 1, number: 1, face: 1, href: 1,
  title: 1, date: 1, rev: 1, company: 1, paper: 1, generator: 1, generator_version: 1, group: 1, bus_alias: 1, members: 99, comment: -2,
};
function stringSlot(node: SNode, j: number): boolean {
  const head = node[0]; if (typeof head !== "string" || j === 0 || typeof node[j] !== "string") return false;
  if (head === "pin") return j === 1 && !node.some((c) => isList(c) && c[0] === "name");   // an instance / sheet pin, not a library pin's electrical type
  if (head === "symbol") return j === 1;
  if (head === "property") return j <= 2 && typeof node[2] === "string";                   // not a pad's (property pad_prop_bga)
  const n = Object.prototype.hasOwnProperty.call(STRING_SLOTS, head) ? STRING_SLOTS[head] : 0;
  return n < 0 ? j === -n : j <= n;
}

/**
 * Board side of the same rule. Where KiCad's writers print a string with Quotew() whatever it looks like — (layer "F.Cu"), (net "VCC"),
 * (property "Reference" "R1") — so a node built by hand (no quote mask from the reader) comes out exactly as
 * PCB_IO_KICAD_SEXPR / SCH_IO_KICAD_SEXPR would write it rather than as a bare token.  head -> the slots that
 * are strings (0 = every slot after the head).
 */
const PCB_STRING_SLOTS: Record<string, readonly number[] | 0> = {
  layer: [1], layers: 0, net: 0, net_name: 0, uuid: 0, tstamp: 0, name: 0, descr: 0, tags: 0, path: 0, sheetname: 0, sheetfile: 0,
  model: 0, pinfunction: 0, pintype: 0, prefix: 0, suffix: 0, override_value: 0, generator: 0, generator_version: 0,
  title: 0, date: 0, rev: 0, company: 0, comment: 0, members: 0, face: 0, lib_id: 0, lib_name: 0, reference: 0, page: 0,
  property: [1, 2], group: [1], gr_text: [1], gr_text_box: [1], fp_text_box: [1], fp_text: [2], footprint: [1], pad: [1],
  label: [1], global_label: [1], hierarchical_label: [1], text: [1], text_box: [1], component_class: 0, class: 0,
};
/** Boards older than the quoted-names format (KiCad 5) keep bare layer names: see serializeItem. */
let legacyBare = false;
function isStringSlot(node: SNode, j: number): boolean {
  if (legacyBare || j === 0 || typeof node[0] !== "string") return false;
  const slots = PCB_STRING_SLOTS[node[0]];
  if (slots === undefined) return false;
  if (node[0] === "property" && (node[1] === "private" || typeof node[2] !== "string" || j > 2)) return false;   // not a pad's (property pad_prop_bga)
  return slots === 0 || slots.indexOf(j) >= 0;
}

export function serialize(node: SAtom): string {
  if (!isList(node)) return atomText(node, false);
  // The reader records which slots were quoted (sexpr.ts QUOTED): reproduce them
  // verbatim, because "identifier-shaped" is not the same question as "was a string
  // in the file" — KiCad's parsers demand T_STRING where the format says string.
  // Hand-built nodes carry no mask and fall back to the shape heuristic.
  const q = quotedMask(node); let out = "(";
  for (let j = 0; j < node.length; j++) {
    if (j) out += " ";
    const c = node[j];
    out += isList(c) ? serialize(c) : atomText(c, (j < 30 && ((q >> j) & 1) === 1) || stringSlot(node, j) || (!q && typeof c === "string" && isStringSlot(node, j)));
  }
  return out + ")";
}

/** A fragment in the shape the desktop's applier parses: see the comment in serializeItem. */
export function wrapFragment(doc: Pick<Doc, "type" | "version">, body: string): string {
  // Schematic: SCH_COLLAB::parseItemSexpr goes through SCH_IO_KICAD_SEXPR::LoadContent,
  // i.e. ParseSchematic(aIsCopyableOnly = true) — the clipboard grammar, which is a bare
  // sequence of top-level items (optionally preceded by lib_symbols) and has no case for
  // a (kicad_sch …) wrapper at all.  Board: PCB_IO_KICAD_SEXPR::Parse accepts only
  // kicad_pcb or footprint at top level, so a bare (segment …) is rejected outright.
  if (doc.type === "sch") return body;
  return "(kicad_pcb (version " + (doc.version || BOARD_FILE_VERSION) + ") (generator \"kicad-collab-web\") " + body + ")";
}

/** The board file version the desktop writes; only a fallback — a parsed document's own version wins. */
export const BOARD_FILE_VERSION = 20260728;

export function serializeItem(doc: Pick<Doc, "type" | "version" | "lib">, item: Pick<Item, "kind" | "node">): string {
  if (doc.type === "sch") {
    // the library copy the symbol draws from: its (lib_name …) when it has one (a split-off variant), else its lib_id
    const lib = item.kind === "symbol" ? (doc.lib.get(str((kid(item.node, "lib_name") || [])[1])) || doc.lib.get(str((kid(item.node, "lib_id") || [])[1]))) : null;
    return (lib ? "(lib_symbols " + serialize(lib) + ") " : "") + serialize(item.node);
  }
  legacyBare = Number(doc.version) > 0 && Number(doc.version) < 20200000;
  try { return wrapFragment(doc, serialize(item.node)); } finally { legacyBare = false; }
}
