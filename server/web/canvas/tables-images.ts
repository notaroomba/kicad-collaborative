// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { root } from "./env";
import { SCH, SCH_Z, Z_BITMAP, pcbColor, pcbZ } from "./colors";
import { G, bboxAdd, textLines } from "./geom";
import { layerOf, pcbTextGeom } from "./geom-pcb";
import { atOf, boolOf, boxOf, colorOf, cornersInSequence, effectsOf, fillOf, justOf, kid, kids, num, rotPt, str, strokeOf } from "./sexpr";
import { SCH_PEN, textPen } from "./text";
// ---------------------------------------------------------------- tables and images
/**
 * (table (column_count N) (border (external yes) (header yes) (stroke …)) (separators (rows yes) (cols yes) (stroke …))
 *   (column_widths …) (row_heights …) (cells (table_cell "text" (at x y r) (size w h) (margins l t r b) (span c r)
 *   (fill …) (effects …) (uuid)) …) (uuid))
 * Boards add (layer …) and write their cells with (start)/(end) [+ (angle)].  Border lines follow
 * SCH_TABLE/PCB_TABLE::DrawBorders; cell text is anchored per SCH_TEXTBOX/PCB_TEXTBOX::GetDrawPos.
 * Cells covered by a span carry (span 0 0) and draw nothing.  The table's anchor is its first cell's position.
 */
export function buildTableGeom(doc, item, n) {
  const isPcb = doc.type === "pcb";
  const cols = Math.max(1, Math.round(num((kid(n, "column_count") || [])[1], 1)) || 1);
  const cellsN = kid(n, "cells"); const cellNodes = cellsN ? kids(cellsN, "table_cell") : [];
  const rows = Math.ceil(cellNodes.length / cols);
  const layer = isPcb ? layerOf(n, "Dwgs.User") : "Notes";
  const z = isPcb ? pcbZ(layer) : SCH_Z.notes, zBg = isPcb ? pcbZ(layer) - 0.5 : SCH_Z.notesBg;
  const borderN = kid(n, "border"), sepN = kid(n, "separators");
  const external = boolOf(borderN, "external", true), header = boolOf(borderN, "header", true);
  const rowsOn = boolOf(sepN, "rows", true), colsOn = boolOf(sepN, "cols", true);
  const bs = strokeOf(borderN, isPcb ? 0 : SCH_PEN), ss = strokeOf(sepN, isPcb ? 0 : SCH_PEN);
  const lineColor = (st) => isPcb ? pcbColor(layer) : (st.color || SCH.notes);
  const lineWidth = (st) => isPcb ? Math.max(st.w, 0) : (st.w > 0 ? st.w : SCH_PEN);   // SCH_PAINTER: width 0 → default pen
  const cells = cellNodes.map((c, i) => {
    const b = boxOf(c); if (!b) return null;
    const sp = kid(c, "span"); const cs = sp ? num(sp[1], 1) : 1, rs = sp ? num(sp[2], 1) : 1;
    return { node: c, box: b, cs, rs };
  });
  const first = cells.find((c) => c);
  item.movable = true; item.rot = 0; if (isPcb) item.layer = layer;
  if (!first) { const [x, y] = atOf(n); item.x = x; item.y = y; bboxAdd(item, x, y, 1); return; }
  const a0 = kid(first.node, "at") || kid(first.node, "start"); item.x = num(a0[1]); item.y = num(a0[2]);
  const drawAngle = first.box.rot;
  // cells: fill + text
  for (const c of cells) {
    if (!c) continue;
    const b = c.box; bboxAdd(item, b.x0, b.y0); bboxAdd(item, b.x1, b.y1);
    if (c.cs <= 0 || c.rs <= 0) continue;
    const cn = c.node; const ef = effectsOf(cn);
    if (!isPcb) {
      const f = fillOf(cn); const fill = f.type === "color" ? f.color : f.type === "background" ? SCH.body : f.type === "solid" || f.type === "outline" ? SCH.notes : null;
      if (fill) G(item, { t: "rect", x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, wd: 0, color: fill, fill, layer, z: zBg, noStroke: true });
    }
    const text = str(cn[1]); if (ef.hide || !text) continue;
    const mg = kid(cn, "margins"); const dm = ef.size * 0.75;
    const lm = mg ? num(mg[1]) : dm, tm = mg ? num(mg[2]) : dm, rm = mg ? num(mg[3]) : dm, bm = mg ? num(mg[4]) : dm;
    const j = justOf(ef.just, "center", "middle");   // parseEDA_TEXT resets to centre before reading (justify …)
    if (isPcb) {
      // PCB_TEXTBOX::GetDrawPos: the corner / mid-point matching the justification, offset by the margins in the text frame
      const cr = cornersInSequence(b, b.rot);
      const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const anchor = j.v === "top" ? (j.h === "left" ? cr[0] : j.h === "right" ? cr[1] : mid(cr[0], cr[1]))
        : j.v === "bottom" ? (j.h === "left" ? cr[3] : j.h === "right" ? cr[2] : mid(cr[3], cr[2]))
        : (j.h === "left" ? mid(cr[0], cr[3]) : j.h === "right" ? mid(cr[1], cr[2]) : mid(mid(cr[0], cr[2]), mid(cr[1], cr[3])));
      const ox = j.h === "left" ? lm : j.h === "right" ? -rm : 0, oy = j.v === "top" ? tm : j.v === "bottom" ? -bm : 0;
      const [dx, dy] = rotPt(ox, oy, b.rot);
      pcbTextGeom(item, cn, anchor[0] + dx, anchor[1] + dy, text, b.rot, layer, { defH: "center", defV: "middle" });
    } else {
      // SCH_TEXTBOX::GetDrawPos
      const vert = ((Math.round(b.rot) % 180) + 180) % 180 === 90; let tx, ty;
      if (vert) { ty = j.h === "left" ? b.y1 - bm : j.h === "right" ? b.y0 + tm : (b.y0 + b.y1) / 2; tx = j.v === "top" ? b.x0 + lm : j.v === "bottom" ? b.x1 - rm : (b.x0 + b.x1) / 2; }
      else { tx = j.h === "left" ? b.x0 + lm : j.h === "right" ? b.x1 - rm : (b.x0 + b.x1) / 2; ty = j.v === "top" ? b.y0 + tm : j.v === "bottom" ? b.y1 - bm : (b.y0 + b.y1) / 2; }
      textLines(item, tx, ty, text, ef.size, colorOf(cn) || SCH.notes, b.rot, [j.h, j.v], layer, { z, w: textPen(ef, ef.size) });
    }
  }
  // borders: SCH_TABLE::DrawBorders / PCB_TABLE::DrawBorders
  const cellAt = (r, c) => cells[r * cols + c] || null;
  const line = (p, q, st) => G(item, { t: "line", x1: p[0], y1: p[1], x2: q[0], y2: q[1], w: lineWidth(st), color: lineColor(st), layer, z, cap: "butt", dash: st.dash || undefined, dashType: st.type || undefined });
  for (let col = 0; col < cols - 1; col++) for (let row = 0; row < rows; row++) {
    const st = row === 0 && header ? bs : colsOn ? ss : null; if (!st) continue;
    const c = cellAt(row, col); if (!c || c.cs <= 0 || col + c.cs === cols) continue;
    const cr = cornersInSequence(c.box, drawAngle); line(cr[1], cr[2], st);
  }
  for (let row = 0; row < rows - 1; row++) {
    const st = row === 0 && header ? bs : rowsOn ? ss : null; if (!st) continue;
    for (let col = 0; col < cols; col++) {
      const c = cellAt(row, col); if (!c || c.rs <= 0 || row + c.rs === rows) continue;
      const cr = cornersInSequence(c.box, drawAngle); line(cr[2], cr[3], st);
    }
  }
  if (external && bs.w >= 0) {
    const tl = cellAt(0, 0), tr = cellAt(0, cols - 1), bl = cellAt(rows - 1, 0), br = cellAt(rows - 1, cols - 1);
    if (tl && tr && bl && br) {
      const TL = cornersInSequence(tl.box, drawAngle), TR = cornersInSequence(tr.box, drawAngle), BL = cornersInSequence(bl.box, drawAngle), BR = cornersInSequence(br.box, drawAngle);
      line(TL[0], TR[1], bs); line(TR[1], BR[2], bs); line(BR[2], BL[3], bs); line(BL[3], TL[0], bs);
    }
  }
  if (item.bbox) { item.w = item.bbox[2] - item.bbox[0]; item.h = item.bbox[3] - item.bbox[1]; }
}

/** Shift every cell of a table node by (dx, dy) — tables have no (at) of their own. */
export function shiftTable(node, dx, dy) {
  const cellsN = kid(node, "cells"); if (!cellsN) return;
  for (const c of kids(cellsN, "table_cell")) for (const key of ["at", "start", "end"]) { const p = kid(c, key); if (p) { p[1] = +(num(p[1]) + dx).toFixed(4); p[2] = +(num(p[2]) + dy).toFixed(4); } }
}


/**
 * (image (at x y) [(layer …)] [(scale s)] (uuid …) (data "base64" "…" …)) — KiCad writes the base64 in 76-character
 * string atoms.  The bitmap is centred on `at`; its size is pixels × 25.4 mm / PPI (BITMAP_BASE::m_pixelSizeIu =
 * 254000 IU / PPI, PPI from the file's own resolution, 300 by default) × scale.  Decoding is lazy and cached per
 * item id + data hash; until the browser has decoded the image a placeholder frame is drawn.  When an image
 * finishes loading (or fails) KiCadCanvas.onAssetLoaded({ id, kind: "image", ok }) is called, if set, so the
 * app can request a repaint.
 */
export const IMAGE_CACHE = new Map(), IMAGE_CACHE_MAX = 64;

export const DATA_CACHE = new WeakMap();
   // (data …) node → { b64, hash }: geometry rebuilds (drags) must not re-join / re-hash megabytes
export function strHash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + "-" + s.length; }

/** Decode base64 to bytes (only the first `limit` characters when given — headers live at the front). */
export function base64Bytes(b64, limit) {
  let s = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, ""); if (limit && s.length > limit) s = s.slice(0, limit - (limit % 4));
  if (typeof Buffer !== "undefined" && Buffer.from) return new Uint8Array(Buffer.from(s, "base64"));
  if (typeof atob === "function") { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  return new Uint8Array(0);
}

/** Pixel size, MIME type and PPI from a PNG (IHDR / pHYs) or JPEG (SOFn / JFIF density) header: BITMAP_BASE::updatePPI rules, 300 PPI default. */
export function imageInfo(bytes) {
  const info = { mime: "image/png", w: 0, h: 0, ppi: 300 };
  const be32 = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0, be16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    info.w = be32(16); info.h = be32(20);
    for (let p = 8; p + 8 <= bytes.length;) {
      const len = be32(p), type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (type === "IDAT" || type === "IEND") break;
      // pHYs in pixels per metre: wx reports px/cm, KiCad rounds px/cm × 2.54
      if (type === "pHYs" && p + 17 <= bytes.length && bytes[p + 16] === 1) { const dpcm = be32(p + 8) / 100; if (dpcm > 1) info.ppi = Math.round(dpcm * 2.54); }
      p += 12 + len;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    info.mime = "image/jpeg";
    for (let p = 2; p + 4 <= bytes.length;) {
      if (bytes[p] !== 0xFF) break;
      const m = bytes[p + 1];
      if (m === 0xFF) { p++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      const len = be16(p + 2);
      if (m === 0xE0 && len >= 14 && bytes[p + 4] === 0x4A && bytes[p + 5] === 0x46 && bytes[p + 6] === 0x49 && bytes[p + 7] === 0x46) {
        const units = bytes[p + 11], xd = be16(p + 12);   // JFIF density: 1 = dots/inch, 2 = dots/cm
        if (units === 2 && xd > 0) info.ppi = Math.round(xd * 2.54); else if (xd > 1) info.ppi = xd;
      }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { info.h = be16(p + 5); info.w = be16(p + 7); break; }
      if (m === 0xDA || m === 0xD9) break;
      p += 2 + len;
    }
  }
  return info;
}

export function notifyAsset(id, ok) {
  const cb = root.KiCadCanvas && root.KiCadCanvas.onAssetLoaded;
  if (typeof cb === "function") { try { cb({ id, kind: "image", ok }); } catch (e) { /* a repaint hook must not break the loader */ } }
}

/** Cached decoded image per item id + data hash: {url, mime, w, h (px), ppi, img, loaded, failed}. */
export function imageEntry(id, b64, hash) {
  const key = id + ":" + (hash || strHash(b64));
  let e = IMAGE_CACHE.get(key); if (e) return e;
  const info = imageInfo(base64Bytes(b64, 1 << 17));
  e = { key, id, url: b64 ? "data:" + info.mime + ";base64," + b64 : "", mime: info.mime, w: info.w, h: info.h, ppi: info.ppi, img: null, loaded: false, failed: false };
  if (IMAGE_CACHE.size >= IMAGE_CACHE_MAX) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
  IMAGE_CACHE.set(key, e);
  const Img = root.Image;
  if (b64 && typeof Img === "function") {
    const img = new Img(); e.img = img;
    img.onload = () => { e.loaded = true; if (img.naturalWidth > 0) { e.w = img.naturalWidth; e.h = img.naturalHeight; } notifyAsset(id, true); };
    img.onerror = () => { e.failed = true; notifyAsset(id, false); };
    img.src = e.url;
  }
  return e;
}

export function buildImageGeom(doc, item, n) {
  const isPcb = doc.type === "pcb"; const [x, y] = atOf(n);
  const scN = kid(n, "scale"); let scale = scN ? num(scN[1], 1) : 1; if (!(scale > 0) || !isFinite(scale)) scale = 1;
  const dataN = kid(n, "data"); let d = dataN ? DATA_CACHE.get(dataN) : null;
  if (!d) { const b64 = dataN ? dataN.slice(1).map(str).join("") : ""; d = { b64, hash: strHash(b64) }; if (dataN) DATA_CACHE.set(dataN, d); }
  const e = imageEntry(item.id, d.b64, d.hash);
  const pxMm = 25.4 / (e.ppi || 300);
  const w = (e.w * pxMm * scale) || 10, h = (e.h * pxMm * scale) || 10;   // unknown pixel size: a 10 mm placeholder
  const layer = isPcb ? layerOf(n, "Dwgs.User") : "Images";
  G(item, { t: "image", x: x - w / 2, y: y - h / 2, w, h, entry: e, pxMm, scale, color: isPcb ? pcbColor(layer) : SCH.notes, layer, z: isPcb ? Z_BITMAP : SCH_Z.bitmap });
  item.movable = true; item.x = x; item.y = y; item.rot = 0; item.w = w; item.h = h; item.scale = scale; if (isPcb) item.layer = layer;
}
