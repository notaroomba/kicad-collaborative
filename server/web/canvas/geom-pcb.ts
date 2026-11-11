// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { HOLE_WALL as HOLE_WALL_COLOR, NPTH, PAD_TEXT, PAD_TEXT_DARK, PCB_BG, VIA_HOLE, Z_PAD, Z_TEXT, Z_VIA, Z_ZONE, padLayers, pcbColor, pcbZ } from "./colors";
import { G, bboxAdd, textLines } from "./geom";
import { expandDocVars } from "./geom-sch";
import { arcFrom3, atOf, bezierPts, dashOf, effectsOf, faceOf, ellipsePts, fillOf, has, isList, justOf, kid, kids, netOf, num, pointInPoly, ptsOf, rotPt, rotator, str, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { parseMarkup, textWidth, unescapeText } from "./text";
import { linebreakText } from "./stroke-font";
import { code128, code39 } from "./barcode";
// ---- board ----
/**
 * Net code of a board item.  Files up to 2025 carry (net N) or (net N "name"); KiCad 10 names the net only —
 * (net "GND") — and has no net table, so those get a code from the document's own table, assigned on first
 * sight (doc.nets: code → name, doc.netCodes: name → code).  No net / the empty name is 0, a missing node -1.
 */
export function netCode(doc, node) {
  const nn = node && kid(node, "net"); if (!nn) return -1;
  const v = nn[1];
  if (typeof v === "number") { if (nn.length > 2 && doc && doc.nets && !doc.nets.has(v)) doc.nets.set(v, str(nn[2])); return v; }
  const name = str(v); if (!name) return 0;
  if (!doc || !doc.nets) return -1;
  const codes = doc.netCodes || (doc.netCodes = new Map());
  let c = codes.get(name);
  if (c === undefined) {
    let next = doc.netSeq || 0; if (!next) for (const k of doc.nets.keys()) if (k > next) next = k;
    c = next + 1; doc.netSeq = c; codes.set(name, c); doc.nets.set(c, name);
  }
  return c;
}

const DISPLAY_NAMES = new Map();
/** NETINFO_ITEM::GetDisplayNetname: the short net name (after the last sheet-path slash), unescaped ({slash} → /). */
export function displayNetName(name) {
  if (!name) return "";
  let v = DISPLAY_NAMES.get(name);
  if (v === undefined) {
    const i = name.lastIndexOf("/");
    v = unescapeText(i >= 0 ? name.slice(i + 1) : name);
    if (DISPLAY_NAMES.size > 20000) DISPLAY_NAMES.clear();
    DISPLAY_NAMES.set(name, v);
  }
  return v;
}

/** PrintableCharCount: the characters of a marked-up string that take room (markup braces and tabs do not). */
export function printableCharCount(t) { return parseMarkup(t.replace(/\t/g, "")).text.length; }

export function layerOf(node, def) { const l = kid(node, "layer"); return l ? str(l[1]) : def; }

export function padCopperLayer(pad) {
  const ls = kid(pad, "layers"); const names = ls ? ls.slice(1).map(str) : [];
  if (names.some((x) => x === "F.Cu" || x === "*.Cu" || x === "F&B.Cu")) return "F.Cu";
  if (names.some((x) => x === "B.Cu")) return "B.Cu";
  const inner = names.find((x) => /\.Cu$/.test(x)); return inner || null;
}

/**
 * Board text.  Hidden text (fp_text / property with hide yes) is not part of item.geom or the bbox: it is kept
 * in item.hiddenGeom tagged hiddenText, drawn only under the showHiddenText render option.  Knockout text
 * ((layer "F.Cu" knockout) or (knockout yes)) is tagged knockout: the painter fills the text box, inflated by
 * GetKnockoutTextMargin = max(pen/2, size/9), in the layer colour and cuts the glyphs out of it.
 */
export function pcbTextGeom(item, n, x, y, text, rot, layer, extra) {
  const ef = effectsOf(n); if (!text) return null;
  const color = pcbColor(layer); const z = pcbZ(layer) + Z_TEXT;
  const thick = ef.thick > 0 ? ef.thick : (ef.bold ? ef.size / 5 : ef.size / 8);
  const ln = kid(n, "layer"); const knockout = (ln && has(ln, "knockout")) || yesNo(n, "knockout");
  const ex = Object.assign({ z, w: thick, mirror: ef.mirror, pcb: true, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX }, knockout ? { knockout: true } : null, extra || {});
  if (ef.hide) {
    const shadow = { geom: [], bbox: null }; textLines(shadow, x, y, text, ef.size, color, rot, ef.just, layer, ex);
    for (const g of shadow.geom) g.hiddenText = true;
    if (shadow.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...shadow.geom);
    return null;
  }
  return textLines(item, x, y, text, ef.size, color, rot, ef.just, layer, ex);
}

export function buildPcbGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "segment") {
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const layer = layerOf(n, "F.Cu"); const net = netCode(doc, n); item.net = net;
    G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return; const layer = layerOf(n, "F.Cu"); const net = netCode(doc, n); item.net = net;
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) G(item, Object.assign({ t: "arc", w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net }, a));
    else G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
  } else if (k === "via") {
    buildViaGeom(doc, item, n);
  } else if (k === "zone") {
    buildZoneGeom(doc, item, n);
  } else if (k === "gr_line" || k === "gr_rect" || k === "gr_circle" || k === "gr_arc" || k === "gr_poly" || k === "gr_curve" || k === "gr_ellipse" || k === "gr_ellipse_arc") {
    graphicGeom(item, n, k.replace("gr_", ""), (x, y) => [x, y], layerOf(n, "Dwgs.User"));
  } else if (k === "point") {
    pointGeom(item, n, (x, y) => [x, y]);
  } else if (k === "barcode") {
    barcodeGeom(item, n, (x, y) => [x, y], 0);
  } else if (k === "gr_text") {
    const [x, y, rot] = atOf(n); const tl = layerOf(n, "Dwgs.User"); pcbTextGeom(item, n, x, y, expandDocVars(doc, str(n[1]).replace(/\$\{LAYER\}/g, tl)), rot, tl);
  } else if (k === "gr_text_box") {
    buildTextBoxGeom(item, n, (x, y) => [x, y], layerOf(n, "Dwgs.User"), 0);
  } else if (k === "dimension") {
    buildDimensionGeom(item, n);
  } else if (k === "target") {
    const [x, y] = atOf(n); const layer = layerOf(n, "Edge.Cuts"); const color = pcbColor(layer); const z = pcbZ(layer);
    const sizeN = kid(n, "size"); const size = sizeN ? num(sizeN[1]) : 5; const w = widthOf(n, 0.15);
    const xShape = has(n, "x"); const R = rotator(xShape ? 45 : 0);
    const arm = xShape ? 2 * size / 3 : size / 2, r = xShape ? size / 2 : size / 3;
    for (const [a, b] of [[[-arm, 0], [arm, 0]], [[0, -arm], [0, arm]]]) { const p = R(a[0], a[1]), q = R(b[0], b[1]); G(item, { t: "line", x1: x + p[0], y1: y + p[1], x2: x + q[0], y2: y + q[1], w, color, layer, z }); }
    G(item, { t: "circle", x, y, r, w, color, layer, z });
  } else if (k === "footprint") {
    buildFootprintGeom(doc, item);
  } else if (k === "table") {
    buildTableGeom(doc, item, n);
  } else if (k === "image") {
    buildImageGeom(doc, item, n);
  }
  // groups, gr_bbox, generated items: nothing to draw
}

// m_HoleWallThickness (0.020 mm) × m_HoleWallPaintingMultiplier (1.5): how wide the plating is painted
export const HOLE_WALL = 0.020 * 1.5;

/** Pad label colour on a copper layer: the netname layer colour, inverted on bright copper (PCB_RENDER_SETTINGS::LoadColors). */
export function padNameColor(layer) {
  const m = /^#([0-9a-f]{6})$/i.exec(pcbColor(layer)); if (!m) return PAD_TEXT;
  const v = parseInt(m[1], 16); const br = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return br > 0.5 ? PAD_TEXT_DARK : PAD_TEXT;
}

export function buildViaGeom(doc, item, n) {
  const [x, y] = atOf(n); const sz = kid(n, "size"), dr = kid(n, "drill"); const size = sz ? num(sz[1]) : 0.8, drill = dr ? num(dr[1]) : 0.4;
  const vtype = has(n, "blind") ? "blind" : has(n, "micro") ? "micro" : "through";
  const ls = kid(n, "layers"); const pair = ls ? [str(ls[1]), str(ls[2])] : ["F.Cu", "B.Cu"];
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  let layers = copper;
  if (vtype !== "through") { const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); if (i0 >= 0 && i1 >= 0) layers = copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1); else layers = pair; }
  const net = netCode(doc, n); item.net = net;
  for (const layer of layers) G(item, { t: "circle", x, y, r: size / 2, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_VIA, via: true, net, viaSize: size, viaType: vtype, viaLayers: pair, viaLabel: layer === layers[0] || undefined });
  const zh = pcbZ("holes");
  // LAYER_VIA_HOLEWALLS: the plating, a ring just outside the drill clamped to the via's copper.  It rides on
  // the hole geometry (wallR / wallColor) and is painted right under it, so a via stays rings + hole.
  const wallR = Math.min(drill / 2 + HOLE_WALL, size / 2); const wall = wallR > drill / 2 ? { wallR, wallColor: HOLE_WALL_COLOR } : null;
  if (vtype === "through") G(item, Object.assign({ t: "circle", x, y, r: drill / 2, w: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, via: true, hole: true, net }, wall));
  else {
    // blind/buried and micro vias show their layer pair in the hole: top-colour upper half, bottom-colour lower half
    G(item, Object.assign({ t: "arc", x, y, r: drill / 2, a0: Math.PI, a1: 2 * Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[0]), fill: pcbColor(pair[0]), layer: "holes", z: zh, pie: true, via: true, hole: true, net }, wall));
    G(item, { t: "arc", x, y, r: drill / 2, a0: 0, a1: Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[1]), fill: pcbColor(pair[1]), layer: "holes", z: zh, pie: true, via: true, hole: true, net });
  }
  item.viaType = vtype;
}

export function buildZoneGeom(doc, item, n) {
  const single = kid(n, "layer"); const multi = kid(n, "layers");
  let layersZ = single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"];
  layersZ = padLayers(doc, layersZ);
  const keepout = !!kid(n, "keepout");
  const hatchN = kid(n, "hatch"); const hatchStyle = hatchN ? str(hatchN[1]) : "edge"; const pitch = hatchN ? num(hatchN[2], 0.5) : 0.5;
  const net = netCode(doc, n); if (item.kind === "zone") item.net = net;
  // (connect_pads [yes|no|thru_hole_only] (clearance c)): the copper clearance the fill keeps from other nets (0.5 mm default)
  const cp = kid(n, "connect_pads"); const clN = cp && kid(cp, "clearance"); const clearance = clN ? num(clN[1], 0.5) : 0.5;
  const unfilled = !keepout && !kids(n, "filled_polygon").length;
  for (const poly of kids(n, "polygon")) {
    const p = ptsOf(poly); if (p.length < 2) continue;
    for (const layer of layersZ) {
      const color = pcbColor(layer); const z = pcbZ(layer) + (keepout ? Z_TEXT : 0.5);
      G(item, keepout ? { t: "poly", pts: p, close: true, w: 0, color, layer, z } : { t: "poly", pts: p, close: true, w: 0, color, layer, z, zoneOutline: true, net, zoneClearance: clearance, zoneUnfilled: unfilled });
      if (hatchStyle !== "none" && pitch > 0) {
        // ZONE::HatchBorder: short diagonal ticks along the border (edge) or full diagonals (full); slope by layer parity
        const info = doc.layers.get(layer); const slope = info && (info.id & 1) ? 1 : -1;
        const segs = hatchLines(p, slope, hatchStyle === "full" ? pitch * 2 : pitch, hatchStyle === "full" ? -1 : pitch);
        for (const s of segs) G(item, { t: "line", x1: s[0], y1: s[1], x2: s[2], y2: s[3], w: 0, color, layer, z });
      }
    }
  }
  if (keepout) return;   // rule areas have no fill
  for (const fp of kids(n, "filled_polygon")) {
    const layer = layerOf(fp, layersZ[0]); const p = ptsOf(fp); if (p.length < 3) continue;
    G(item, { t: "poly", pts: p, close: true, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_ZONE, noStroke: true, zoneFill: true, net });
  }
}

/** SHAPE_POLY_SET::GenerateHatchLines for one outline: lines y = slope·x + a every `spacing`, clipped to the polygon. */
export function hatchLines(pts, slope, spacing, lineLen) {
  const out = []; if (pts.length < 3) return out;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const maxA = slope > 0 ? maxY - slope * minX : maxY - slope * maxX, minA0 = slope > 0 ? minY - slope * maxX : minY - slope * minX;
  const minA = Math.floor(minA0 / spacing) * spacing;
  if ((maxA - minA) / spacing > 4000) return out;   // pathological: skip rather than stall
  const buf = [];
  for (let a = minA; a < maxA; a += spacing) {
    buf.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const x1 = pts[j][0], y1 = pts[j][1], x2 = pts[i][0], y2 = pts[i][1];
      // intersection of segment with the line y = slope·x + a
      const den = (y2 - y1) - slope * (x2 - x1); if (Math.abs(den) < 1e-12) continue;
      const t = (slope * x1 + a - y1) / den; if (t < 0 || t > 1) continue;
      const x = x1 + t * (x2 - x1), y = y1 + t * (y2 - y1);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      buf.push([x, y]);
    }
    if (buf.length > 2) buf.sort((p, q) => q[0] - p[0]);
    for (let i = 0; i + 1 < buf.length; i++) {
      const p1 = buf[i], p2 = buf[i + 1]; if (Math.abs(p1[0] - p2[0]) < 1e-9 && Math.abs(p1[1] - p2[1]) < 1e-9) continue;
      if (!pointInPoly(pts, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)) continue;
      let dx = p2[0] - p1[0];
      if (lineLen === -1 || Math.abs(dx) < 2 * lineLen) out.push([p1[0], p1[1], p2[0], p2[1]]);
      else {
        const sl = (p2[1] - p1[1]) / dx; dx = dx > 0 ? lineLen : -lineLen;
        out.push([p1[0], p1[1], p1[0] + dx, p1[1] + dx * sl]); out.push([p2[0], p2[1], p2[0] - dx, p2[1] - dx * sl]);
      }
    }
  }
  return out;
}

/** PCB_PAINTER::draw(PCB_POINT): an X of the point's size in LAYER_POINTS and a ring of half that in the layer colour. */
export function pointGeom(item, n, tf) {
  const at = kid(n, "at"); if (!at) return; const [x, y] = tf(num(at[1]), num(at[2]));
  const sz = kid(n, "size"), size = (sz ? num(sz[1]) : 1) / 2, layer = layerOf(n, "F.SilkS"), z = pcbZ(layer) + 0.9, w = 0.01;
  for (const [dx, dy] of [[1, 1], [1, -1]]) G(item, { t: "line", x1: x - size * dx, y1: y - size * dy, x2: x + size * dx, y2: y + size * dy, w, color: POINT_COLOR, layer, z, cap: "butt" });
  G(item, { t: "circle", x, y, r: size / 2, w, color: pcbColor(layer), layer, z });
}
export const POINT_COLOR = "#FF26E2";   // LAYER_POINTS (builtin_color_themes.h)

/**
 * PCB_BARCODE: the symbol scaled to (size w h) and centred on (at x y), its text under it (1 mm gap, text_height),
 * the knockout box inflated by its margins (at least 10 % of the smaller side), all turned by the angle about the
 * position.  Code 39 / Code 128 bars are encoded as Zint encodes them (barcode.ts); the 2D symbologies draw their
 * finder patterns only.
 */
export function barcodeGeom(item, n, tf, frot) {
  const at = kid(n, "at"); if (!at) return;
  const [px, py] = tf(num(at[1]), num(at[2])); const rot = num(at[3]) + (frot || 0);
  const sz = kid(n, "size"), W = sz ? num(sz[1]) : 5, H = sz ? num(sz[2], W) : 5; if (!(W > 0) || !(H > 0)) return;
  const layer = layerOf(n, "F.SilkS"), color = pcbColor(layer), z = pcbZ(layer);
  const text = str((kid(n, "text") || [])[1] || ""), th = num((kid(n, "text_height") || [])[1], 1.5);
  const type = str((kid(n, "type") || [])[1] || "code39"), showText = !yesNo(n, "hide"), knockout = yesNo(n, "knockout");
  const back = /^B\./.test(layer), mx = back ? -1 : 1;   // side-specific: mirrored on the back
  const R = rotator(rot); const P = (x, y) => { const [dx, dy] = R(mx * x, y); return [px + dx, py + dy]; };
  const rects = [];   // symbol modules, in the barcode's frame (centred)
  if (type === "code39" || type === "code128") {
    const bc = type === "code39" ? code39(text) : code128(text);
    if (bc) for (const [a, b] of bc.bars) rects.push([-W / 2 + W * a / bc.modules, -H / 2, -W / 2 + W * b / bc.modules, H / 2]);
  } else {
    // QR / Micro QR: the 7-module finder squares in the corners; Data Matrix: its solid L and dotted clock edges
    if (type === "datamatrix") {
      const m = Math.min(W, H) / 14;
      rects.push([-W / 2, -H / 2, -W / 2 + m, H / 2], [-W / 2, H / 2 - m, W / 2, H / 2]);
      for (let x = -W / 2; x < W / 2 - m / 2; x += 2 * m) rects.push([x, -H / 2, x + m, -H / 2 + m]);
      for (let y = H / 2 - m; y > -H / 2 + m / 2; y -= 2 * m) rects.push([W / 2 - m, y - m, W / 2, y]);
    } else {
      const k = type === "microqr" ? 11 : 21, mw = W / k, mh = H / k;
      const finder = (x0, y0) => {
        rects.push([x0, y0, x0 + 7 * mw, y0 + mh], [x0, y0 + 6 * mh, x0 + 7 * mw, y0 + 7 * mh], [x0, y0 + mh, x0 + mw, y0 + 6 * mh], [x0 + 6 * mw, y0 + mh, x0 + 7 * mw, y0 + 6 * mh]);
        rects.push([x0 + 2 * mw, y0 + 2 * mh, x0 + 5 * mw, y0 + 5 * mh]);
      };
      finder(-W / 2, -H / 2);
      if (type !== "microqr") { finder(W / 2 - 7 * mw, -H / 2); finder(-W / 2, H / 2 - 7 * mh); }
    }
  }
  let y1 = H / 2;
  const textY = H / 2 + 1;
  if (showText && text) y1 = textY + th;
  if (knockout) {
    const minSide = Math.min(W, H), m = Math.max(Math.ceil(minSide * 0.1 / 0.1 - 1e-9) * 0.1, 0);
    const mg = kid(n, "margins"), ml = Math.max(mg ? num(mg[1]) : 0, m), mt = Math.max(mg ? num(mg[2]) : 0, m);
    G(item, { t: "poly", pts: [P(-W / 2 - ml, -H / 2 - mt), P(W / 2 + ml, -H / 2 - mt), P(W / 2 + ml, y1 + mt), P(-W / 2 - ml, y1 + mt)], close: true, w: 0, color, fill: color, layer, z, noStroke: true });
  }
  const ink = knockout ? PCB_BG : color;
  for (const [x0, y0, x2, y2] of rects) G(item, { t: "poly", pts: [P(x0, y0), P(x2, y0), P(x2, y2), P(x0, y2)], close: true, w: 0, color: ink, fill: ink, layer, z: z + 0.01, noStroke: true });
  if (showText && text) {
    const [tx, ty] = P(0, textY);
    textLines(item, tx, ty, text, th, ink, rot, ["center", "top"], layer, { pcb: true, z: z + 0.01, w: th * 0.15, mirror: back || undefined });
  }
}

export function graphicGeom(item, g, shape, tf, layer, z) {
  const w = widthOf(g, 0); const color = pcbColor(layer); z = z === undefined ? pcbZ(layer) : z;
  if (layer === "Edge.Cuts") item.edge = true;   // board outline: what "fit" and the board box mean
  const f = fillOf(g); const fillColor = f.type === "solid" ? color : null; const ds = dashOf(g);
  if (shape === "line") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return; const a = tf(num(s[1]), num(s[2])), b = tf(num(e[1]), num(e[2]));
    G(item, Object.assign({ t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" }, ds));
  } else if (shape === "rect") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return;
    const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]);
    G(item, Object.assign({ t: "poly", pts: [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)], close: true, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
  } else if (shape === "circle") {
    const c = kid(g, "center"), e = kid(g, "end"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const r = e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : num((kid(g, "radius") || [])[1], 1);
    G(item, Object.assign({ t: "circle", x: cx, y: cy, r, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
  } else if (shape === "arc") {
    const s = kid(g, "start"), m = kid(g, "mid"), e = kid(g, "end"); if (!s || !m || !e) return;
    const a = arcFrom3(tf(num(s[1]), num(s[2])), tf(num(m[1]), num(m[2])), tf(num(e[1]), num(e[2])));
    if (a) G(item, Object.assign({ t: "arc", w, color, layer, z, cap: "round" }, a, ds));
    else { const p0 = tf(num(s[1]), num(s[2])), p1 = tf(num(e[1]), num(e[2])); G(item, Object.assign({ t: "line", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color, layer, z, cap: "round" }, ds)); }
  } else if (shape === "ellipse" || shape === "ellipse_arc") {
    const e = ellipsePts(g, false); if (!e) return; const p = e.pts.map(([x, y]) => tf(x, y));
    G(item, Object.assign({ t: "poly", pts: p, close: e.closed, w, color, fill: e.closed ? fillColor : null, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
  } else if (shape === "poly" || shape === "curve") {
    let p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    if (shape === "curve") p = bezierPts(p);
    G(item, Object.assign({ t: "poly", pts: p, close: shape === "poly", w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
  }
}

export function buildTextBoxGeom(item, n, tf, layer, rotBase) {
  const ef = effectsOf(n); if (ef.hide) return;
  let pts = ptsOf(n).map(([x, y]) => tf(x, y));
  if (pts.length < 4) { const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]); pts = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)]; }
  const w = widthOf(n, 0); const color = pcbColor(layer); const z = pcbZ(layer);
  if (yesNo(n, "border") || w > 0) G(item, Object.assign({ t: "poly", pts, close: true, w, color, layer, z }, dashOf(n)));
  const angN = kid(n, "angle"); const ang = angN ? num(angN[1]) : rotBase;
  const mg = kid(n, "margins"); const dm = w / 2 + ef.size * 0.75;
  const lm = mg ? num(mg[1]) : dm, tm = mg ? num(mg[2], lm) : dm, rm = mg ? num(mg[3], lm) : dm, bm = mg ? num(mg[4], tm) : dm;
  // PCB_TEXTBOX::GetDrawPos: the corner / edge mid-point matching the justification (file default centre / centre),
  // moved in by the margins along the box's own axes
  const j = justOf(ef.just); const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const anchor = j.v === "top" ? (j.h === "left" ? pts[0] : j.h === "right" ? pts[1] : mid(pts[0], pts[1]))
    : j.v === "bottom" ? (j.h === "left" ? pts[3] : j.h === "right" ? pts[2] : mid(pts[3], pts[2]))
    : (j.h === "left" ? mid(pts[0], pts[3]) : j.h === "right" ? mid(pts[1], pts[2]) : mid(pts[0], pts[2]));
  const ex = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], ey = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]];
  const el = Math.hypot(ex[0], ex[1]) || 1, yl = Math.hypot(ey[0], ey[1]) || 1;
  const ox = j.h === "left" ? lm : j.h === "right" ? -rm : 0, oy = j.v === "top" ? tm : j.v === "bottom" ? -bm : 0;
  // PCB_TEXTBOX::GetShownText: wrapped to the box's first edge less the side margins, with the effective pen
  const col = el - lm - rm;
  const pen = ef.thick > 0 ? ef.thick : (ef.bold ? ef.size / 5 : ef.size / 8);
  pcbTextGeom(item, n, anchor[0] + ex[0] / el * ox + ey[0] / yl * oy, anchor[1] + ex[1] / el * ox + ey[1] / yl * oy, linebreakText(unescapeText(str(n[1])), col, ef.sizeX, pen, ef.italic), ang, layer);
}

export function buildDimensionGeom(item, n) {
  const typeN = kid(n, "type"); const type = typeN ? str(typeN[1]) : "aligned";
  const layer = layerOf(n, "Dwgs.User"); const color = pcbColor(layer); const z = pcbZ(layer);
  const pts = ptsOf(n); if (pts.length < 2) return;
  const style = kid(n, "style") || []; const thick = num((kid(style, "thickness") || [])[1], 0.15); const arrowLen = num((kid(style, "arrow_length") || [])[1], 1.27);
  const extH = num((kid(style, "extension_height") || [])[1], 0.58586), extOff = num((kid(style, "extension_offset") || [])[1], 0);
  const inward = str((kid(style, "arrow_direction") || [])[1]) === "inward";
  const gt = kid(n, "gr_text"); const ef = gt ? effectsOf(gt) : { size: 1, thick: 0.15, just: [] };
  const [tx, ty, tr] = gt ? atOf(gt) : [0, 0, 0]; const text = gt ? str(gt[1]) : "";
  const tw = textWidth(parseMarkup(text).text, ef.size, ef.thick), th = ef.size;
  const line = (a, b) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: thick, color, layer, z, cap: "round" });
  const arrow = (p, ang, tail) => {   // PCB_DIMENSION_BASE::drawAnArrow: two 27.5° barbs (and an optional tail)
    if (tail) { const [dx, dy] = rotPt(tail, 0, -ang); line(p, [p[0] + dx, p[1] + dy]); }
    for (const s of [27.5, -27.5]) { const [dx, dy] = rotPt(arrowLen, 0, -ang + s); line(p, [p[0] + dx, p[1] + dy]); }
  };
  // knock the text box (inflated by size/2 along, pen across) out of a segment
  const knock = (a, b, inflY) => {
    if (!text) { line(a, b); return; }
    const hw = tw / 2 + ef.size / 2, hh = th / 2 + inflY; const R = rotator(-tr);
    const la = R(a[0] - tx, a[1] - ty), lb = R(b[0] - tx, b[1] - ty);
    let t0 = 0, t1 = 1; const dx = lb[0] - la[0], dy = lb[1] - la[1];
    for (const [p, q] of [[-dx, la[0] + hw], [dx, hw - la[0]], [-dy, la[1] + hh], [dy, hh - la[1]]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) { line(a, b); return; } continue; }
      const t = q / p; if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t0 >= t1) { line(a, b); return; }
    if (t0 > 0) line(a, [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
    if (t1 < 1) line([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], b);
  };
  const deg = (v) => Math.atan2(-v[1], v[0]) * 180 / Math.PI;   // EDA_ANGLE of a vector (CCW positive on screen)
  const [s, e] = pts;
  if (type === "aligned" || type === "orthogonal") {
    const height = num((kid(n, "height") || [])[1], 0); const orientN = kid(n, "orientation"); const ortho = type === "orthogonal";
    const horiz = ortho && num(orientN ? orientN[1] : 0) === 0;
    let ext; if (ortho) ext = horiz ? [0, 1] : [1, 0]; else { const d = [e[0] - s[0], e[1] - s[1]]; ext = [-d[1], d[0]]; }   // sgn below carries the height's sign (KiCad's Resize(negative))
    const el = Math.hypot(ext[0], ext[1]) || 1; const en = [ext[0] / el, ext[1] / el];
    const extLen = Math.abs(height) - extOff + extH;
    const sgn = height >= 0 ? 1 : -1;
    const cs = [s[0] + sgn * en[0] * Math.abs(height), s[1] + sgn * en[1] * Math.abs(height)];
    const ce = ortho ? (horiz ? [e[0], cs[1]] : [cs[0], e[1]]) : [e[0] + sgn * en[0] * Math.abs(height), e[1] + sgn * en[1] * Math.abs(height)];
    line([s[0] + en[0] * extOff, s[1] + en[1] * extOff], [s[0] + en[0] * (extOff + extLen), s[1] + en[1] * (extOff + extLen)]);
    if (ortho) { const e2 = [e[0] - ce[0], e[1] - ce[1]]; const l2 = Math.hypot(e2[0], e2[1]) || 1; const n2 = [e2[0] / l2, e2[1] / l2]; const st = [ce[0] - n2[0] * extH, ce[1] - n2[1] * extH]; line(st, [st[0] + n2[0] * (l2 - extOff + extH), st[1] + n2[1] * (l2 - extOff + extH)]); }
    else line([e[0] + en[0] * extOff, e[1] + en[1] * extOff], [e[0] + en[0] * (extOff + extLen), e[1] + en[1] * (extOff + extLen)]);
    knock(cs, ce, ortho ? ef.thick : -ef.thick);
    const ang = deg([ce[0] - cs[0], ce[1] - cs[1]]);
    if (inward) { arrow(cs, ang + 180, arrowLen * 2); arrow(ce, ang, arrowLen * 2); } else { arrow(cs, ang, 0); arrow(ce, ang + 180, 0); }
  } else if (type === "leader") {
    const d = [e[0] - s[0], e[1] - s[1]]; const dl = Math.hypot(d[0], d[1]) || 1; const st = [s[0] + d[0] / dl * extOff, s[1] + d[1] / dl * extOff];
    knock(st, e, 2 * ef.thick); arrow(st, deg(d), 0);
    if (text) knock(e, [tx, ty], 2 * ef.thick);
    const frame = str((kid(style, "text_frame") || [])[1]);
    if (text && frame === "1") { const hw = tw / 2 + ef.size / 2, hh = th / 2 + 2 * ef.thick; const R = rotator(tr); const box = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => { const [rx, ry] = R(px, py); return [tx + rx, ty + ry]; }); G(item, { t: "poly", pts: box, close: true, w: thick, color, layer, z }); }
    else if (text && frame === "2") G(item, { t: "circle", x: tx, y: ty, r: tw / 2 + ef.size / 2 - ef.thick / 2, w: thick, color, layer, z });
  } else if (type === "radial") {
    line([s[0], s[1] - arrowLen], [s[0], s[1] + arrowLen]); line([s[0] - arrowLen, s[1]], [s[0] + arrowLen, s[1]]);
    const r = [e[0] - s[0], e[1] - s[1]]; const rl = Math.hypot(r[0], r[1]) || 1; const ll = num((kid(n, "leader_length") || [])[1], 2.54);
    const b = [e[0] + r[0] / rl * ll, e[1] + r[1] / rl * ll];
    knock(e, b, ef.thick); if (text) knock(b, [tx, ty], ef.thick); arrow(e, deg(r), 0);
  } else if (type === "center") {
    const a = [e[0] - s[0], e[1] - s[1]]; line([s[0] - a[0], s[1] - a[1]], [s[0] + a[0], s[1] + a[1]]);
    const [rx, ry] = rotPt(a[0], a[1], -90); line([s[0] - rx, s[1] - ry], [s[0] + rx, s[1] + ry]);
  }
  if (gt) pcbTextGeom(item, gt, tx, ty, text, tr, layer);
}

export function buildFootprintGeom(doc, item) {
  const n = item.node;
  const [fx, fy, frot] = atOf(n); const side = layerOf(n, "F.Cu"); const R = rotator(frot);
  const trN = kid(n, "transform"); const scN = trN && kid(trN, "scale"); const sx = scN ? num(scN[1], 1) || 1 : 1, sy = scN ? num(scN[2], 1) || 1 : 1;
  const tf = (lx, ly) => { const [x, y] = R(lx * sx, ly * sy); return [fx + x, fy + y]; };   // TRANSFORM_TRS: scale, rotate, translate
  item.movable = true; item.x = fx; item.y = fy; item.rot = frot; item.layer = side; item.lib = str(n[1]);
  const props = {};
  for (const p of kids(n, "property")) { props[str(p[1])] = str(p[2]); }
  item.ref = props.Reference || ""; item.value = props.Value || "";
  const expand = (t) => t.replace(/\$\{(REFERENCE|VALUE|FOOTPRINT_NAME|LAYER)\}/g, (m, v) => v === "REFERENCE" ? item.ref : v === "VALUE" ? item.value : v === "LAYER" ? side : item.lib);
  const textAt = (p, text) => {
    if (!isList(kid(p, "at"))) return;
    const at = kid(p, "at"); const [px, py, pr] = atOf(p); const layer = layerOf(p, side === "B.Cu" ? "B.SilkS" : "F.SilkS"); const [x, y] = tf(px, py);
    const unlocked = has(at, "unlocked") || yesNo(p, "unlocked");
    const field = p[0] === "property" ? str(p[1]) : p[0] === "fp_text" ? (str(p[1]) === "reference" ? "Reference" : str(p[1]) === "value" ? "Value" : null) : null;
    pcbTextGeom(item, p, x, y, expand(text), pr, layer, field ? { upright: !unlocked, field } : { upright: !unlocked });
  };
  for (const p of kids(n, "property")) textAt(p, str(p[2]));
  let padIndex = 0;   // index among the footprint's (pad …) children: padAt() reports it and pcb-tools can map it back
  for (let j = 2; j < n.length; j++) {
    const g = n[j]; if (!isList(g)) continue; const gk = g[0];
    if (gk === "fp_line" || gk === "fp_rect" || gk === "fp_circle" || gk === "fp_arc" || gk === "fp_poly" || gk === "fp_curve" || gk === "fp_ellipse" || gk === "fp_ellipse_arc") {
      graphicGeom(item, g, gk.replace("fp_", ""), tf, layerOf(g, "F.SilkS"));
    } else if (gk === "point") {
      // files before FIRST_FP_AFFINE_TRANSFORM (20260616) kept a footprint's points in the board frame
      pointGeom(item, g, doc && doc.version > 0 && doc.version < 20260616 ? (x, y) => [x, y] : tf);
    } else if (gk === "barcode") {
      barcodeGeom(item, g, tf, frot);
    } else if (gk === "fp_text") {
      textAt(g, str(g[2]));
    } else if (gk === "fp_text_box") {
      buildTextBoxGeom(item, g, tf, layerOf(g, "F.SilkS"), frot);
    } else if (gk === "pad") {
      buildPadGeom(item, g, tf, side, doc, padIndex++);
    } else if (gk === "zone") {
      const before = item.geom.length; buildZoneGeom(doc, item, g);
      for (let i = before; i < item.geom.length; i++) { const z = item.geom[i]; if (z.pts) z.pts = z.pts.map(([x, y]) => tf(x, y)); else if (z.t === "line") { const a = tf(z.x1, z.y1), b = tf(z.x2, z.y2); z.x1 = a[0]; z.y1 = a[1]; z.x2 = b[0]; z.y2 = b[1]; } }
    }
  }
  if (!item.bbox) bboxAdd(item, fx, fy, 1);
}

/** Outline polygon (local, unrotated) for chamfered / trapezoid pads. */
export function padPolygon(pad, shape, w, h) {
  const hw = w / 2, hh = h / 2;
  if (shape === "trapezoid") {
    const d = kid(pad, "rect_delta"); const dx = d ? num(d[1]) : 0, dy = d ? num(d[2]) : 0;
    // TransformTrapezoidToPolygon: delta.x skews the vertical sides, delta.y the horizontal ones
    return [[-hw + dy / 2, -hh - dx / 2], [hw - dy / 2, -hh + dx / 2], [hw + dy / 2, hh - dx / 2], [-hw - dy / 2, hh + dx / 2]];
  }
  // chamfered rect: TransformRoundChamferedRectToPolygon (round corners of the other corners are ignored)
  const ch = kid(pad, "chamfer"); const corners = ch ? ch.slice(1).map(str) : [];
  const ratioN = kid(pad, "chamfer_ratio"); const c = Math.max(0, (ratioN ? num(ratioN[1]) : 0.25) * Math.min(w, h));
  const has_ = (s) => corners.includes(s);
  const pts = [];
  if (has_("top_left") && c > 0) pts.push([-hw, -hh + c], [-hw + c, -hh]); else pts.push([-hw, -hh]);
  if (has_("top_right") && c > 0) pts.push([hw - c, -hh], [hw, -hh + c]); else pts.push([hw, -hh]);
  if (has_("bottom_right") && c > 0) pts.push([hw, hh - c], [hw - c, hh]); else pts.push([hw, hh]);
  if (has_("bottom_left") && c > 0) pts.push([-hw + c, hh], [-hw, hh - c]); else pts.push([-hw, hh]);
  return pts;
}

export function buildPadGeom(item, pad, tf, side, doc, padIndex) {
  const number = str(pad[1]), type = str(pad[2]); let shape = str(pad[3]);
  const netN = kid(pad, "net"); const net = netCode(doc, pad);
  const netname = netN ? (typeof netN[1] === "number" ? (netN.length > 2 ? str(netN[2]) : str((doc && doc.nets && doc.nets.get(netN[1])) || "")) : str(netN[1])) : "";
  const [px, py, prot] = atOf(pad); const sz = kid(pad, "size"); const w = sz ? num(sz[1]) : 1, h = sz ? num(sz[2], num(sz[1])) : 1;
  const [cx, cy] = tf(px, py);
  const ls = kid(pad, "layers"); const layers = padLayers(doc || { copper: [] }, ls ? ls.slice(1).map(str) : [side]);
  const copper = padCopperLayer(pad);
  const rrN = kid(pad, "roundrect_rratio"); const rr = rrN ? num(rrN[1]) : (shape === "roundrect" ? 0.25 : 0);
  const dr = kid(pad, "drill");
  const oval = dr && str(dr[1]) === "oval"; const dw = dr ? (oval ? num(dr[2]) : num(dr[1])) : 0, dh = dr ? (oval ? num(dr[3], dw) : dw) : 0;
  let hx = cx, hy = cy;
  if (dr) { const off = kid(dr, "offset"); if (off) { const [ox, oy] = rotator(prot)(num(off[1]), num(off[2])); hx += ox; hy += oy; } }
  const npth = type === "np_thru_hole";
  // one geometry per layer the pad is on (copper, mask, paste): whichever is drawn last wins, like KiCad
  const shapes = [];
  const pushShape = (layer, z, color, fill) => {
    const from = item.geom.length;
    pushPadShape(layer, z, color, fill);
    for (let i = from; i < item.geom.length; i++) { const pg = item.geom[i]; pg.pad = true; pg.padIndex = padIndex; pg.padNumber = number; pg.padType = type; pg.net = net; pg.netName = netname; }   // tagged for outlinePads / padAt / net colours
  };
  const pushPadShape = (layer, z, color, fill) => {
    if (shape === "custom") {
      const prims = kid(pad, "primitives"); const anchor = str((kid(pad, "options") && kid(kid(pad, "options"), "anchor") || [])[1]);
      if (prims) { const Rp = rotator(prot); const ptf = (lx, ly) => { const [x, y] = Rp(lx, ly); return [cx + x, cy + y]; }; for (const pr of prims.slice(1)) if (isList(pr)) { const before = item.geom.length; graphicGeom(item, pr, pr[0].replace("gr_", ""), ptf, layer, z); for (let i = before; i < item.geom.length; i++) { const gg = item.geom[i]; gg.color = color; if (gg.fill) gg.fill = fill; if (!gg.fill && gg.w <= 0) { gg.fill = fill; gg.noStroke = true; } } } }
      shapes.push(G(item, { t: "pad", x: cx, y: cy, w, h, rot: prot, shape: anchor === "circle" ? "circle" : "rect", rr: 0, color, fill, layer, z }));
    } else if (shape === "trapezoid" || (shape === "rect" && kid(pad, "rect_delta")) || (shape === "custom" ? false : (kid(pad, "chamfer") && shape !== "circle" && shape !== "oval"))) {
      const Rp = rotator(prot); const pts = padPolygon(pad, shape === "trapezoid" || kid(pad, "rect_delta") ? "trapezoid" : "chamfer", w, h).map(([lx, ly]) => { const [x, y] = Rp(lx, ly); return [cx + x, cy + y]; });
      shapes.push(G(item, { t: "poly", pts, close: true, w: 0, color, fill, layer, z, noStroke: true }));
    } else {
      shapes.push(G(item, { t: "pad", x: cx, y: cy, w, h, rot: prot, shape: shape === "roundrect" ? "rect" : shape, rr: rr * Math.min(w, h), color, fill, layer, z }));
    }
  };
  for (const layer of layers) {
    const isCu = /\.Cu$/.test(layer); const color = pcbColor(layer);
    if (npth && isCu && !(w > dw + 0.001 || h > dh + 0.001)) continue;   // an NPTH pad with no annulus flashes no copper
    if (!isCu && !/\.(Mask|Paste|Adhes)$/.test(layer)) continue;
    pushShape(layer, pcbZ(layer) + (isCu ? Z_PAD : 0.5), color, color);
  }
  bboxAdd(item, cx, cy, Math.hypot(w, h) / 2);
  if (dr && dw > 0) {
    const zh = pcbZ("holes");
    if (npth) G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: NPTH, fill: NPTH, layer: "holes", z: zh, hole: true, npth: true, padIndex, net });
    else {
      // plated: hole in the background colour with a thin plating wall (LAYER_PAD_HOLEWALLS uses the via hole colour)
      G(item, { t: "pad", x: hx, y: hy, w: dw + 2 * Math.min(HOLE_WALL, w / 2, h / 2), h: dh + 2 * Math.min(HOLE_WALL, w / 2, h / 2), rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, hole: true, padIndex, net });
      G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: PCB_BG, fill: PCB_BG, layer: "holes", z: zh, hole: true, padIndex, net });
    }
  }
  // pad number + net name: PCB_PAINTER::draw( const PAD*, netname layer )
  const pinType = str((kid(pad, "pintype") || [])[1]);
  let shownNet = displayNetName(netname);
  if (pinType.indexOf("no_connect") >= 0) shownNet = "x";                                                   // PAD::IsNoConnectPad
  else if (pinType === "free" && shownNet.indexOf("unconnected-(") === 0) shownNet = "*";                  // PAD::IsFreePad
  if (number || shownNet) {
    // the pad's bounding box on the board decides the room and the reading direction
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const grow = (x, y, r) => { if (x - r < bx0) bx0 = x - r; if (y - r < by0) by0 = y - r; if (x + r > bx1) bx1 = x + r; if (y + r > by1) by1 = y + r; };
    const firstLayer = shapes.length ? shapes[0].layer : null;
    if (shape === "custom" && firstLayer) {
      for (const sg of item.geom) {
        if (!sg.pad || sg.padIndex !== padIndex || sg.layer !== firstLayer || sg.hole) continue;
        if (sg.t === "poly") for (const q of sg.pts) grow(q[0], q[1], (sg.w || 0) / 2);
        else if (sg.t === "circle" || sg.t === "arc") grow(sg.x, sg.y, sg.r + (sg.w || 0) / 2);
        else if (sg.t === "line") { grow(sg.x1, sg.y1, (sg.w || 0) / 2); grow(sg.x2, sg.y2, (sg.w || 0) / 2); }
        else if (sg.t === "pad") { const ca = Math.abs(Math.cos(sg.rot * Math.PI / 180)), sa = Math.abs(Math.sin(sg.rot * Math.PI / 180)); const ex = (sg.w * ca + sg.h * sa) / 2, ey = (sg.w * sa + sg.h * ca) / 2; grow(sg.x - ex, sg.y - ey, 0); grow(sg.x + ex, sg.y + ey, 0); }
      }
    }
    if (!isFinite(bx0)) {
      const ca = Math.abs(Math.cos(prot * Math.PI / 180)), sa = Math.abs(Math.sin(prot * Math.PI / 180));
      let ex, ey;
      if (shape === "circle") ex = ey = w / 2;
      else if (shape === "oval") { const r = Math.min(w, h) / 2, hx = w > h ? (w - h) / 2 : 0, hy = h > w ? (h - w) / 2 : 0; ex = hx * ca + hy * sa + r; ey = hx * sa + hy * ca + r; }
      else { ex = (w * ca + h * sa) / 2; ey = (w * sa + h * ca) / 2; }
      bx0 = cx - ex; bx1 = cx + ex; by0 = cy - ey; by1 = cy + ey;
    }
    const tcx = (bx0 + bx1) / 2, tcy = (by0 + by1) / 2;
    let pw = bx1 - bx0, ph = by1 - by0; const padMin = Math.min(pw, ph);
    if (shape !== "custom") { const limit = Math.min(w, h) * 1.1; if (pw > limit && ph > limit) { pw = limit; ph = limit; } }   // a 45° rotation must not bloat the box
    let size = ph; let rot = 0;
    if (pw < ph * 0.95) { rot = 90; size = pw; const t = pw; pw = ph; ph = t; }
    if (size > 10) size = 10;   // PCB_RENDER_SETTINGS::MAX_FONT_SIZE
    let yNet = 0, yNum = 0;
    if (number && shownNet) { size = size / 2.5; yNet = size / 1.4; yNum = size / 1.7; }
    // LAYER_PAD_NETNAMES (through-hole, above the holes) or the copper layer's own netname layer (SMD)
    const pth = type === "thru_hole" || (copper !== "F.Cu" && copper !== "B.Cu");
    const textLayer = copper || layers[0] || side; const z = pth ? pcbZ("holes") + 1 : pcbZ(textLayer) + 3.6;
    const color = pth ? PAD_TEXT : padNameColor(textLayer);
    const padCu = layers.filter((l) => /\.Cu$/.test(l));
    const label = (text, ts, dyLocal, tag) => {
      const [dx, dy] = rotPt(0, dyLocal, rot);
      const g = { t: "text", x: tcx + dx, y: tcy + dy, text, size: ts, sizeX: ts * 0.9, w: ts * 0.9 / 6, color, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, padMin, padLayers: padCu.length ? padCu : [textLayer], noBox: true, minPx: 3.5 };   // below 3.5 px the label is a smudge: skipped (KiCad would still paint it)
      g[tag] = true; G(item, g);
    };
    if (shownNet) {
      let ts = Math.min(1.5 * pw / Math.max(printableCharCount(shownNet) + 1, 5), size) * 0.85;
      if (shape === "circle" || shape === "oval") ts *= 0.9;   // round pads have less room
      label(shownNet, ts, Math.min(ts * 1.4, yNet), "padNet");
    }
    if (number) {
      const ts = Math.min(Math.min(1.5 * pw / Math.max(printableCharCount(number), 3), size) * 0.85, size);
      label(number, ts, -yNum, "padNum");
    }
  }
}
