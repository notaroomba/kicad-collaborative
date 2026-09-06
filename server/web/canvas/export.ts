// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { PCB_BG, SCH } from "./colors";
import { bboxOf } from "./hit";
import { FONT_EM, FONT_FAMILY, HIDDEN_TEXT_ALPHA, dashPattern, makeCanvas, render, tracePath } from "./render";
import { isList, kid, str } from "./sexpr";
import { textWidth } from "./text";
// ---------------------------------------------------------------- export (File → Plot / Export)
export const fmt = (v) => { const s = (+v).toFixed(4); return s.replace(/\.?0+$/, "") === "-0" ? "0" : s.replace(/\.?0+$/, "") || "0"; };

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A canvas-path-shaped sink that builds an SVG path `d` string, so tracePath / tracePad serve both targets. */
export function SvgPath() { this.d = ""; this.cx = null; this.cy = null; this.sx = 0; this.sy = 0; }

SvgPath.prototype.moveTo = function (x, y) { this.d += "M" + fmt(x) + " " + fmt(y); this.cx = this.sx = x; this.cy = this.sy = y; };

SvgPath.prototype.lineTo = function (x, y) { if (this.cx === null) return this.moveTo(x, y); this.d += "L" + fmt(x) + " " + fmt(y); this.cx = x; this.cy = y; };

SvgPath.prototype.closePath = function () { if (this.cx !== null) { this.d += "Z"; this.cx = this.sx; this.cy = this.sy; } };

SvgPath.prototype.rect = function (x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); };

SvgPath.prototype.arc = function (x, y, r, a0, a1, acw) {
  // canvas semantics: a line from the current point to the arc start, then the arc (clamped to one full turn)
  const p0x = x + r * Math.cos(a0), p0y = y + r * Math.sin(a0);
  if (this.cx === null) this.moveTo(p0x, p0y); else if (Math.hypot(this.cx - p0x, this.cy - p0y) > 1e-9) this.lineTo(p0x, p0y);
  const TAU = 2 * Math.PI; let sweep;
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
export function svgGeom(g, hairline, isPcb, bg) {
  const t = g.t; const sw = (w) => Math.max(w || 0, hairline);
  const op = g.alpha !== undefined && g.alpha < 1 ? ` opacity="${fmt(g.alpha)}"` : "";
  const dash = (w) => g.dash ? ` stroke-dasharray="${dashPattern(g.dashType, w).map(fmt).join(" ")}"` : "";
  const cap = g.cap || (t === "poly" || t === "line" ? "round" : "butt");
  const stroke = (w, color) => { const lw = sw(w); return ` stroke="${color || g.color}" stroke-width="${fmt(lw)}" stroke-linecap="${cap}"${dash(lw)}`; };
  if (t === "text") {
    if (!g.text) return "";
    const size = g.size, base0 = g.v === "top" ? size : g.v === "bottom" ? 0 : size / 2;
    const tr = `translate(${fmt(g.x)} ${fmt(g.y)})` + (g.rot ? ` rotate(${fmt(-g.rot)})` : "") + (g.mirror ? " scale(-1 1)" : "");
    const anchor = g.h === "left" ? "start" : g.h === "right" ? "end" : "middle";
    const pen = g.w || 0, extra = pen - 0.13 * size;
    let color = g.color, pre = "";
    if (g.knockout) {
      const w = textWidth(g.text, size, pen), m = Math.max(pen / 2, size / 9); const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2;
      pre = `<rect x="${fmt(x0 - m)}" y="${fmt(base0 - size - m)}" width="${fmt(w + 2 * m)}" height="${fmt(size + 2 * m)}" fill="${g.color}"/>`; color = bg;
    }
    const bold = !g.knockout && !g.padText && extra > 0.01 && isPcb ? ` stroke="${color}" stroke-width="${fmt(extra)}" stroke-linejoin="round" paint-order="stroke"` : "";
    let bars = "";
    if (g.bars && g.bars.length) {
      const total = textWidth(g.text, size, pen); const shift = g.h === "center" ? -total / 2 : g.h === "right" ? -total : 0; const y = base0 - size * 1.23;
      let d = ""; for (const [i0, i1] of g.bars) d += `M${fmt(shift + textWidth(g.text.slice(0, i0), size, pen))} ${fmt(y)}L${fmt(shift + textWidth(g.text.slice(0, i1), size, pen))} ${fmt(y)}`;
      bars = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${fmt(Math.max(pen || size / 8, hairline))}"/>`;
    }
    return `<g transform="${tr}"${op}>${pre}<text y="${fmt(base0)}" font-family='${FONT_FAMILY}' font-size="${fmt(size * FONT_EM)}" text-anchor="${anchor}" fill="${color}"${bold}>${esc(g.text)}</text>${bars}</g>`;
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
  const p = new SvgPath(); tracePath(p, g);
  const fill = g.fill ? ` fill="${g.fill}"` : ' fill="none"';
  const stroked = !g.noStroke && (t === "line" || t === "arc" || (t === "poly" && (g.w > 0 || !g.fill)) || (t === "circle" && (g.w > 0 || !g.fill)) || (t === "pad" && !g.fill));
  if (t === "circle" && !g.pie) return `<circle cx="${fmt(g.x)}" cy="${fmt(g.y)}" r="${fmt(g.r)}"${fill}${stroked ? stroke(g.w) : ""}${op}/>`;
  return `<path d="${p.d}"${fill}${stroked ? stroke(g.w) : ""}${op}/>`;
}

/** The export area: opts.bbox, else the union of opts.ids, else the board bbox / the sheet page; margin in mm. */
export function exportBox(doc, opts) {
  const isPcb = doc.type === "pcb"; const ids = opts.ids ? (opts.ids instanceof Set ? opts.ids : new Set(opts.ids)) : null;
  let box = opts.bbox || (ids ? bboxOf(doc, ids) : null) || (isPcb ? doc.bbox : [0, 0, doc.page[0], doc.page[1]]) || [0, 0, 10, 10];
  const margin = opts.margin !== undefined ? opts.margin : (opts.bbox ? 0 : (ids || isPcb ? 1 : 0));
  return { ids, x0: box[0] - margin, y0: box[1] - margin, w: Math.max(box[2] - box[0] + 2 * margin, 1e-3), h: Math.max(box[3] - box[1] + 2 * margin, 1e-3) };
}

/**
 * The document as an SVG string (mm user units, 1 mm = 1 unit, width/height in mm) built from the geometry records
 * in draw order with KiCad's colours.  opts: ids (Set/array: only those items), bbox ([x0, y0, x1, y1] mm: the
 * export area), margin (mm around the area; 1 mm for boards / subsets, 0 for a whole sheet), hidden (Set of
 * layer keys, honoured like render), background (css or false; default the theme background), frame (schematic
 * page frame; default only for whole sheets), zoneOutline, showHiddenPins, showHiddenText, padNumbers,
 * hairline (mm, the width zero-width strokes get; 0.1).  Text is <text> with the same anchoring, rotation and
 * mirroring as the canvas (board text keeps its mirror), images become data-URI <image>s.
 */
export function renderSvg(doc, opts) {
  opts = opts || {}; const isPcb = doc.type === "pcb"; const hidden = opts.hidden || new Set();
  const { ids, x0, y0, w, h } = exportBox(doc, opts); const x1 = x0 + w, y1 = y0 + h;
  const hairline = opts.hairline !== undefined ? opts.hairline : 0.1;
  const bg = opts.background === undefined ? (isPcb ? PCB_BG : SCH.bg) : opts.background;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" stroke-linejoin="round">`];
  if (bg) out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="${bg}"/>`);
  const frame = opts.frame !== undefined ? opts.frame : (!isPcb && !ids && !opts.bbox);
  if (frame && !isPcb) out.push(`<rect x="0" y="0" width="${fmt(doc.page[0])}" height="${fmt(doc.page[1])}" fill="none" stroke="${SCH.frame}" stroke-width="0.15"/>`);
  const buckets = new Map();
  const take = (g) => { const z = g.z === undefined ? 0 : g.z; let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g); };
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
  for (const z of zs) for (const g of buckets.get(z)) {
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
export function renderPng(doc, opts) {
  opts = opts || {}; const dpi = opts.dpi > 0 ? opts.dpi : 300; const ppm = dpi / 25.4;
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
  if (typeof canvas.toBlob === "function") return new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error("renderPng: toBlob failed")), type, opts.quality));
  return Promise.reject(new Error("renderPng: canvas cannot produce a blob"));
}


export function serialize(node) {
  if (!isList(node)) {
    if (typeof node === "number") return Number.isInteger(node) ? String(node) : String(+node.toFixed(6));
    const s = String(node);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '"' + s + '"';   // KiCad always quotes uuids
    return /^[A-Za-z_][\w.:*-]*$/.test(s) ? s : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  }
  return "(" + node.map(serialize).join(" ") + ")";
}

export function serializeItem(doc, item) {
  // the desktop applier loads schematic fragments as a document, so wrap them
  if (doc.type === "sch") {
    const lib = item.kind === "symbol" ? doc.lib.get(str((kid(item.node, "lib_id") || [])[1])) : null;
    return "(kicad_sch (version 20250114) (generator \"kicad-collab-web\")" + (lib ? " (lib_symbols " + serialize(lib) + ")" : "") + " " + serialize(item.node) + ")";
  }
  return serialize(item.node);
}
