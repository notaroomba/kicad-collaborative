// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { buildPcbGeom } from "./geom-pcb";
import { buildSchGeom } from "./geom-sch";
import { flipH, flipV, justOf, rotator, str } from "./sexpr";
import { INTERLINE, parseMarkup, textWidth } from "./text";
// ---------------------------------------------------------------- geometry builders
export function bboxAdd(item, x, y, pad) {
  pad = pad || 0;
  if (!item.bbox) item.bbox = [x - pad, y - pad, x + pad, y + pad];
  else { const b = item.bbox; if (x - pad < b[0]) b[0] = x - pad; if (y - pad < b[1]) b[1] = y - pad; if (x + pad > b[2]) b[2] = x + pad; if (y + pad > b[3]) b[3] = y + pad; }
}

export function boxUnion(b, x0, y0, x1, y1) { if (!b) return [x0, y0, x1, y1]; return [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)]; }

export function G(item, g) {
  item.geom.push(g);
  if (g.t === "line") { bboxAdd(item, g.x1, g.y1, g.w / 2); bboxAdd(item, g.x2, g.y2, g.w / 2); }
  else if (g.t === "poly") for (const p of g.pts) bboxAdd(item, p[0], p[1], g.w / 2);
  else if (g.t === "circle" || g.t === "arc") { bboxAdd(item, g.x - g.r, g.y - g.r); bboxAdd(item, g.x + g.r, g.y + g.r); }
  else if (g.t === "rect" || g.t === "image") { bboxAdd(item, g.x, g.y); bboxAdd(item, g.x + g.w, g.y + g.h); }
  else if (g.t === "pad") bboxAdd(item, g.x, g.y, Math.hypot(g.w, g.h) / 2);
  else if (g.t === "text" && !g.noBox) {
    // approximate extents so culling/hit-testing sees the text: along the reading direction per justification
    const w = textWidth(g.text, g.size, g.w), h = g.size;
    const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2;
    const R = rotator(g.rot || 0);
    for (const [px, py] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) { const [rx, ry] = R(g.mirror ? -px : px, py); bboxAdd(item, g.x + rx, g.y + ry); }
  }
  return g;
}


export function buildGeom(doc, item) {
  item.geom = []; item.bbox = null; item.hiddenGeom = null;
  if (doc.type === "sch") buildSchGeom(doc, item); else buildPcbGeom(doc, item);
}

/**
 * Text geometry.  Schematic text is never upside down: 180/270 become 0/90 with the anchor flipped.
 * extra.pcb keeps the angle as given (pcbnew draws any angle); extra.upright applies the footprint
 * keep-upright rule (angle kept within (-90, 90]).  Markup (~{overbar}) is stripped into g.bars.
 */
export function textGeom(item, x, y, text, size, color, rot, just, layer, extra) {
  extra = extra || {};
  const j = justOf(just || [], extra.defH, extra.defV);
  let r = rot || 0;
  if (extra.pcb) {
    r = ((r % 360) + 360) % 360;
    if (extra.upright) { while (r > 90) r -= 180; while (r <= -90) r += 180; }
  } else {
    r = ((Math.round(r) % 360) + 360) % 360;
    if (r === 180 || r === 270) { r -= 180; j.h = flipH(j.h); j.v = flipV(j.v); }
  }
  const m = parseMarkup(text);
  const g = { t: "text", x, y, text: m.text, bars: m.bars, size: size || 1.27, w: 0, color, rot: r, h: j.h, v: j.v, layer };
  for (const k in extra) if (k !== "defH" && k !== "defV" && k !== "pcb" && k !== "upright") g[k] = extra[k];
  return G(item, g);
}

/** Multi-line text: one geom per line, the block anchored per the vertical justification. */
export function textLines(item, x, y, text, size, color, rot, just, layer, extra) {
  const lines = str(text).split("\n"); if (lines.length === 1) return textGeom(item, x, y, lines[0], size, color, rot, just, layer, extra);
  const j = justOf(just || [], extra && extra.defH, extra && extra.defV); const il = size * INTERLINE;
  const off0 = j.v === "top" ? 0 : j.v === "bottom" ? -(lines.length - 1) * il : -(lines.length - 1) * il / 2;
  const R = rotator(rot || 0); const out = [];
  lines.forEach((ln, i) => { const [dx, dy] = R(0, off0 + i * il); out.push(textGeom(item, x + dx, y + dy, ln, size, color, rot, just, layer, extra)); });
  return out[0];
}

/**
 * A field of a rotated/mirrored symbol (or a lib text item): KiCad lays the text out unrotated,
 * turns the box by the text angle, applies the symbol transform and draws it centred, readable.
 * The equivalent here: keep the anchor, swap the angle when the transform rotates, and flip the
 * justification when the transformed reading/down directions are reversed.
 */
export function transformedText(item, Ti, x, y, text, size, color, angle, just, layer, extra) {
  const a = ((Math.round(angle) % 360) + 360) % 360; const vertical = a === 90 || a === 270;
  const j = justOf(just || [], extra && extra.defH, extra && extra.defV);
  if (a === 180 || a === 270) { j.h = flipH(j.h); j.v = flipV(j.v); }
  const read = vertical ? [0, -1] : [1, 0], down = vertical ? [1, 0] : [0, 1];   // KiCad text-local axes on screen
  const rv = [Ti[0] * read[0] + Ti[1] * read[1], Ti[2] * read[0] + Ti[3] * read[1]];
  const dv = [Ti[0] * down[0] + Ti[1] * down[1], Ti[2] * down[0] + Ti[3] * down[1]];
  const outVertical = Ti[1] !== 0 ? !vertical : vertical;
  let h = j.h, v = j.v;
  if (outVertical ? rv[1] > 0 : rv[0] < 0) h = flipH(h);
  if (outVertical ? dv[0] < 0 : dv[1] < 0) v = flipV(v);
  return textLines(item, x, y, text, size, color, outVertical ? 90 : 0, [h, v], layer, extra);
}
