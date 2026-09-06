// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { NPTH, PAD_TEXT, PCB_BG, VIA_HOLE, Z_PAD, Z_TEXT, Z_VIA, Z_ZONE, padLayers, pcbColor, pcbZ } from "./colors";
import { G, bboxAdd, textLines } from "./geom";
import { arcFrom3, atOf, bezierPts, dashOf, effectsOf, fillOf, has, isList, kid, kids, netOf, num, pointInPoly, ptsOf, rotPt, rotator, str, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { parseMarkup, textWidth } from "./text";
// ---- board ----
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
  const ex = Object.assign({ z, w: thick, mirror: ef.mirror, pcb: true }, knockout ? { knockout: true } : null, extra || {});
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
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const layer = layerOf(n, "F.Cu"); const net = netOf(n); item.net = net;
    G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return; const layer = layerOf(n, "F.Cu"); const net = netOf(n); item.net = net;
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) G(item, Object.assign({ t: "arc", w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net }, a));
    else G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
  } else if (k === "via") {
    buildViaGeom(doc, item, n);
  } else if (k === "zone") {
    buildZoneGeom(doc, item, n);
  } else if (k === "gr_line" || k === "gr_rect" || k === "gr_circle" || k === "gr_arc" || k === "gr_poly" || k === "gr_curve") {
    graphicGeom(item, n, k.replace("gr_", ""), (x, y) => [x, y], layerOf(n, "Dwgs.User"));
  } else if (k === "gr_text") {
    const [x, y, rot] = atOf(n); pcbTextGeom(item, n, x, y, str(n[1]), rot, layerOf(n, "Dwgs.User"));
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

export function buildViaGeom(doc, item, n) {
  const [x, y] = atOf(n); const sz = kid(n, "size"), dr = kid(n, "drill"); const size = sz ? num(sz[1]) : 0.8, drill = dr ? num(dr[1]) : 0.4;
  const vtype = has(n, "blind") ? "blind" : has(n, "micro") ? "micro" : "through";
  const ls = kid(n, "layers"); const pair = ls ? [str(ls[1]), str(ls[2])] : ["F.Cu", "B.Cu"];
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  let layers = copper;
  if (vtype !== "through") { const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); if (i0 >= 0 && i1 >= 0) layers = copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1); else layers = pair; }
  const net = netOf(n); item.net = net;
  for (const layer of layers) G(item, { t: "circle", x, y, r: size / 2, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_VIA, via: true, net, viaSize: size, viaType: vtype, viaLayers: pair, viaLabel: layer === layers[0] || undefined });
  const zh = pcbZ("holes");
  if (vtype === "through") G(item, { t: "circle", x, y, r: drill / 2, w: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, via: true, hole: true, net });
  else {
    // blind/buried and micro vias show their layer pair in the hole: top-colour upper half, bottom-colour lower half
    G(item, { t: "arc", x, y, r: drill / 2, a0: Math.PI, a1: 2 * Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[0]), fill: pcbColor(pair[0]), layer: "holes", z: zh, pie: true, via: true, hole: true, net });
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
  const net = netOf(n); if (item.kind === "zone") item.net = net;
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
  const mg = kid(n, "margins"); const m = mg ? num(mg[1]) : w / 2 + ef.size * 0.75;
  const R = rotator(ang); const [dx, dy] = R(m, m);
  pcbTextGeom(item, n, pts[0][0] + dx, pts[0][1] + dy, str(n[1]), ang, layer, { defH: "left", defV: "top" });
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
    if (gk === "fp_line" || gk === "fp_rect" || gk === "fp_circle" || gk === "fp_arc" || gk === "fp_poly" || gk === "fp_curve") {
      graphicGeom(item, g, gk.replace("fp_", ""), tf, layerOf(g, "F.SilkS"));
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
  const netN = kid(pad, "net"); const net = netN ? num(netN[1], -1) : -1, netname = netN ? str(netN[2]) : "";
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
      G(item, { t: "pad", x: hx, y: hy, w: dw + 0.04, h: dh + 0.04, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, hole: true, padIndex, net });
      G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: PCB_BG, fill: PCB_BG, layer: "holes", z: zh, hole: true, padIndex, net });
    }
  }
  // pad number + net name (PCB_PAINTER netname layer): sized to fit, drawn only when legible
  if (number || netname) {
    let pw = w, ph = h; const rotated = pw < ph * 0.95; if (rotated) { const t = pw; pw = ph; ph = t; }
    let size = Math.min(ph, 2.5);   // MAX_FONT_SIZE
    const textLayer = copper || layers[0] || side; const z = pcbZ("holes") + 1; const rot = rotated ? 90 : 0;
    let yNet = 0, yNum = 0;
    if (number && netname) { size = size / 2.5; yNet = size / 1.4; yNum = size / 1.7; }
    if (netname) { let ts = Math.min(1.5 * pw / Math.max(netname.length + 1, 5), size) * 0.85; const [dx, dy] = rotPt(0, Math.min(ts * 1.4, yNet), rot); G(item, { t: "text", x: cx + dx, y: cy + dy, text: netname, size: ts, w: 0, color: PAD_TEXT, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, padNet: true, minPx: 7, noBox: true }); }
    if (number) { const ts = Math.min(1.5 * pw / Math.max(number.length, 3), size) * 0.85; const [dx, dy] = rotPt(0, -yNum, rot); G(item, { t: "text", x: cx + dx, y: cy + dy, text: number, size: ts, w: 0, color: PAD_TEXT, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, padNum: true, minPx: 7, noBox: true }); }
  }
}
