// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { SCH, SCH_Z, dimColor } from "./colors";
import { G, bboxAdd, boxUnion, textGeom, textLines, transformedText } from "./geom";
import { arcFrom3, atOf, bezierPts, colorOf, dashOf, effectsOf, fillOf, has, isList, justOf, kid, kids, num, ptsOf, rotPt, str, strokeColorOf, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { MIL, SCH_PEN, parseMarkup, textPen, textWidth } from "./text";
// ---- schematic ----
// KiCad TRANSFORM matrices on library (Y up) coordinates: screen = T·lib + origin (x' = T0·x + T1·y, y' = T2·x + T3·y)
export const ORIENT = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };

export function symbolTransform(rot, mirror) {
  let T = ORIENT[((Math.round(rot) % 360) + 360) % 360] || ORIENT[0];
  if (mirror === "y") T = [-T[0], -T[1], T[2], T[3]];   // mirror y negates the X row
  if (mirror === "x") T = [T[0], T[1], -T[2], -T[3]];   // mirror x negates the Y row
  return T.map((v) => v + 0);   // no -0 entries
}

// KiCad's own (internal, Y-down lib coordinates) matrix, used for field/text justification: T·diag(1,-1)
export const internalT = (T) => [T[0], -T[1], T[2], -T[3]];

export function resolveLib(doc, name, depth) {
  const s = doc.lib.get(name); if (!s) return null;
  const ext = kid(s, "extends");
  if (ext && (depth || 0) < 4) {
    const parent = resolveLib(doc, name.split(":")[0] + ":" + str(ext[1]), (depth || 0) + 1) || resolveLib(doc, str(ext[1]), (depth || 0) + 1);
    if (parent) {
      // a derived symbol inherits the parent's drawing, pin settings and power flag
      const merged = s.slice();
      for (const c of parent.slice(1)) if (isList(c) && (c[0] === "symbol" || (c[0] === "pin_names" && !kid(s, "pin_names")) || (c[0] === "pin_numbers" && !kid(s, "pin_numbers")) || (c[0] === "power" && !kid(s, "power")))) merged.push(c);
      return merged;
    }
  }
  return s;
}


// label flag shapes (eeschema/sch_label.cpp)
export const SPIN = { 0: "R", 90: "U", 180: "L", 270: "B" };
   // file angle → spin style
export const SPIN_ROT = { L: 0, U: -90, R: 180, B: 90 };
        // template rotation per spin (RotatePoint sign)
export const SPIN_IDX = { L: 0, U: 1, R: 2, B: 3 };

export const HIER_TPL = {
  input: [[0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0], [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0], [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0], [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0]],
  output: [[-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0], [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2], [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0], [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2]],
  bidirectional: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  tri_state: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  passive: [[0, -1, -2, -1, -2, 1, 0, 1, 0, -1], [1, 0, 1, -2, -1, -2, -1, 0, 1, 0], [0, -1, 2, -1, 2, 1, 0, 1, 0, -1], [1, 0, 1, 2, -1, 2, -1, 0, 1, 0]],
};

export function hierShape(x, y, size, shape, spin) {
  const t = (HIER_TPL[shape] || HIER_TPL.input)[SPIN_IDX[spin]]; const hs = size / 2; const pts = [];
  for (let i = 0; i < t.length; i += 2) pts.push([x + hs * t[i], y + hs * t[i + 1]]);
  return pts;
}

export function spinText(spin) { return { rot: spin === "U" || spin === "B" ? 90 : 0, h: spin === "R" || spin === "U" ? "left" : "right" }; }

export function labelFields(item, n, color, layer, z) {
  for (const p of kids(n, "property")) {
    const ef = effectsOf(p); const val = str(p[2]); if (ef.hide || !val || /^\$\{.*\}$/.test(val)) continue;
    const [px, py, pr] = atOf(p);
    textLines(item, px, py, val, ef.size, color, pr, ef.just, layer, { z, w: textPen(ef, ef.size), defH: "left", defV: "bottom" });
  }
}


export function buildSchGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "wire" || k === "bus" || k === "polyline") {
    const p = ptsOf(n); const isBus = k === "bus";
    const w = widthOf(n, 0) || (isBus ? 0.3048 : 0.1524);
    const color = strokeColorOf(n) || (isBus ? SCH.bus : k === "polyline" ? SCH.notes : SCH.wire);
    if (k === "polyline" && p.length > 2) {
      // a closed polyline with a fill (drawPolygon writes one): SCH_SHAPE fill rules, as for library bodies
      const f = fillOf(n);
      const fill = f.type === "background" ? SCH.body : f.type === "outline" || f.type === "solid" ? color : f.type === "color" ? f.color : null;
      if (fill) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer: "Notes", z: f.type === "outline" || f.type === "solid" ? SCH_Z.notes : SCH_Z.notesBg, noStroke: true });
    }
    G(item, Object.assign({ t: "poly", pts: p, close: false, w, color, layer: isBus ? "Buses" : k === "polyline" ? "Notes" : "Wires", z: isBus ? SCH_Z.bus : k === "polyline" ? SCH_Z.notes : SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "bus_entry") {
    // wire-to-bus entries take the wire colour and width
    const [x, y] = atOf(n); const s = kid(n, "size"); const dx = s ? num(s[1]) : 2.54, dy = s ? num(s[2]) : 2.54;
    G(item, Object.assign({ t: "line", x1: x, y1: y, x2: x + dx, y2: y + dy, w: widthOf(n, 0) || 0.1524, color: strokeColorOf(n) || SCH.busEntry, layer: "Wires", z: SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "junction") {
    const [x, y] = atOf(n); const d = kid(n, "diameter"); const r = (d && num(d[1]) > 0 ? num(d[1]) : 0.9144) / 2;
    G(item, { t: "circle", x, y, r, w: 0, color: colorOf(n) || SCH.junction, fill: colorOf(n) || SCH.junction, layer: "Junctions", z: SCH_Z.junction });
  } else if (k === "no_connect") {
    const [x, y] = atOf(n); const s = Math.max(1.2192, SCH_PEN * 3) / 2;   // DEFAULT_NOCONNECT_SIZE 48 mil
    G(item, { t: "line", x1: x - s, y1: y - s, x2: x + s, y2: y + s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
    G(item, { t: "line", x1: x - s, y1: y + s, x2: x + s, y2: y - s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
  } else if (k === "label" || k === "global_label" || k === "hierarchical_label" || k === "netclass_flag" || k === "directive_label") {
    buildLabelGeom(item, n, k);
  } else if (k === "text") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n);
    // SCH_TEXT::GetSchematicTextOffset: a fixed 0.25 mm lift; angles are kept upright (KeepUpright)
    textLines(item, x, y - 0.25, str(n[1]), ef.size, colorOf(n) || SCH.notes, rot, ef.just, "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size), defH: "left", defV: "bottom" });
  } else if (k === "text_box") {
    const [x, y, rot] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 10, h = s ? num(s[2]) : 5; const ef = effectsOf(n);
    const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h), x1 = Math.max(x, x + w), y1 = Math.max(y, y + h);
    const bw = widthOf(n, 0); const border = bw < 0 ? 0 : (bw || SCH_PEN); const f = fillOf(n);
    const fill = f.type === "color" ? f.color : f.type === "background" ? SCH.body : f.type === "solid" ? SCH.notes : null;
    if (fill) G(item, { t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: 0, color: fill, fill, layer: "Notes", z: SCH_Z.notesBg, noStroke: true });
    if (border > 0) G(item, Object.assign({ t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: border, color: strokeColorOf(n) || SCH.notes, fill: null, layer: "Notes", z: SCH_Z.notes }, dashOf(n)));
    const mg = kid(n, "margins"); const lm = mg ? num(mg[1]) : border / 2 + ef.size * 0.75, tm = mg ? num(mg[2]) : lm, rm = mg ? num(mg[3]) : lm, bm = mg ? num(mg[4]) : lm;
    const j = justOf(ef.just, "left", "top"); const vert = ((rot % 180) + 180) % 180 === 90;
    // SCH_TEXTBOX::GetDrawPos: anchor on the box edge matching the justification
    let tx, ty;
    if (vert) { ty = j.h === "left" ? y1 - bm : j.h === "right" ? y0 + tm : (y0 + y1) / 2; tx = j.v === "top" ? x0 + lm : j.v === "bottom" ? x1 - rm : (x0 + x1) / 2; }
    else { tx = j.h === "left" ? x0 + lm : j.h === "right" ? x1 - rm : (x0 + x1) / 2; ty = j.v === "top" ? y0 + tm : j.v === "bottom" ? y1 - bm : (y0 + y1) / 2; }
    textLines(item, tx, ty, str(n[1]), ef.size, colorOf(n) || SCH.notes, rot, [j.h, j.v], "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size) });
  } else if (k === "rectangle" || k === "circle" || k === "arc" || k === "bezier") {
    shapeGeom(item, n, k, (x, y) => [x, y], SCH.notes, "Notes", SCH_Z.notes, SCH_Z.notesBg, widthOf(n, 0) || SCH_PEN);
  } else if (k === "rule_area") {
    for (const pl of kids(n, "polyline")) {
      const p = ptsOf(pl); if (p.length < 2) continue;
      G(item, Object.assign({ t: "poly", pts: p, close: true, w: widthOf(pl, 0) || SCH_PEN, color: strokeColorOf(pl) || SCH.ruleArea, layer: "Rule areas", z: SCH_Z.ruleArea }, dashOf(pl)));
    }
  } else if (k === "table") {
    buildTableGeom(doc, item, n);
  } else if (k === "image") {
    buildImageGeom(doc, item, n);
  } else if (k === "sheet") {
    buildSheetGeom(item, n);
  } else if (k === "symbol") {
    buildSymbolGeom(doc, item);
  }
}

/** Graphic shape shared by sheet-level notes and library bodies (tf maps node coords to screen). */
export function shapeGeom(item, g, gk, tf, color, layer, z, zBg, w, bodyFill) {
  const f = fillOf(g); const sc = strokeColorOf(g) || color;
  const fill = f.type === "background" ? SCH.body : f.type === "outline" ? sc : f.type === "color" ? f.color : f.type === "solid" ? sc : null;
  const fz = f.type === "outline" || f.type === "solid" ? z : zBg;   // KiCad fills device-coloured shapes in the foreground
  const closed = f.type !== "none"; const ds = dashOf(g);
  if (gk === "rectangle") {
    const s0 = kid(g, "start"), e0 = kid(g, "end"); if (!s0 || !e0) return;
    const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]);
    const pts = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    if (fill) G(item, { t: "poly", pts, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, Object.assign({ t: "poly", pts, close: true, w, color: sc, layer, z }, ds));
  } else if (gk === "polyline" || gk === "bezier") {
    let p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    if (gk === "bezier") p = bezierPts(p);
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, Object.assign({ t: "poly", pts: p, close: false, w, color: sc, layer, z }, ds));
  } else if (gk === "circle") {
    const c = kid(g, "center"), r = kid(g, "radius"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const rad = r ? num(r[1]) : 1;
    if (fill) G(item, { t: "circle", x: cx, y: cy, r: rad, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, Object.assign({ t: "circle", x: cx, y: cy, r: rad, w, color: sc, layer, z }, ds));
  } else if (gk === "arc") {
    const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !m0 || !e0) return;
    const a = arcFrom3(tf(num(s0[1]), num(s0[2])), tf(num(m0[1]), num(m0[2])), tf(num(e0[1]), num(e0[2])));
    if (a) G(item, Object.assign({ t: "arc", w, color: sc, layer, z, fill: closed ? fill : null }, a, ds));
    else { const p0 = tf(num(s0[1]), num(s0[2])), p1 = tf(num(e0[1]), num(e0[2])); G(item, Object.assign({ t: "line", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color: sc, layer, z }, ds)); }
  }
}

export function buildLabelGeom(item, n, k) {
  const [x, y, rot] = atOf(n); const ef = effectsOf(n); const text = str(n[1]); const size = ef.size;
  const spin = SPIN[((Math.round(rot) % 360) + 360) % 360] || "R"; const st = spinText(spin);
  const pen = textPen(ef, size); const off = 0.15 * size;   // DEFAULT_TEXT_OFFSET_RATIO
  const shapeN = kid(n, "shape"); const shape = shapeN ? str(shapeN[1]) : "";
  if (k === "label") {
    const d = off + pen; const tx = st.rot ? x - d : x, ty = st.rot ? y : y - d;
    textGeom(item, tx, ty, text, size, colorOf(n) || SCH.label, st.rot, [st.h, "bottom"], "Labels", { z: SCH_Z.loclabel, w: pen });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else if (k === "global_label") {
    const color = colorOf(n) || SCH.glabel; const margin = 0.375 * size;   // DEFAULT_LABEL_SIZE_RATIO
    let horiz = margin; if (shape === "input" || shape === "bidirectional" || shape === "tri_state") horiz += size * 0.75;
    const vert = size * 0.0715;
    const to = spin === "L" ? [-horiz, vert] : spin === "U" ? [vert, -horiz] : spin === "R" ? [horiz, vert] : [vert, horiz];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.globlabel, w: pen });
    // outline: SCH_GLOBALLABEL::CreateGraphicShape
    const halfSize = size / 2 + margin; const symbLen = textWidth(parseMarkup(text).text, size, pen) + 2 * margin;
    const bx = symbLen + pen, by = halfSize + pen;
    let pts = [[0, 0], [0, -by], [-bx, -by], [-bx, 0], [-bx, by], [0, by]]; let xo = 0;
    if (shape === "input") { xo = -halfSize; pts[0][0] += halfSize; }
    else if (shape === "output") pts[3][0] -= halfSize;
    else if (shape === "bidirectional" || shape === "tri_state") { xo = -halfSize; pts[0][0] += halfSize; pts[3][0] -= halfSize; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px + xo, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    G(item, { t: "poly", pts, close: true, w: pen, color, layer: "Labels", z: SCH_Z.globlabel });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else if (k === "hierarchical_label") {
    const color = colorOf(n) || SCH.hlabel; const d = off + ef.sizeX;
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.hierlabel, w: pen });
    G(item, { t: "poly", pts: hierShape(x, y, size, shape || "input", spin), close: false, w: pen, color, layer: "Labels", z: SCH_Z.hierlabel });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else {
    // directive label / netclass flag: SCH_DIRECTIVE_LABEL::CreateGraphicShape
    const color = colorOf(n) || SCH.netclass; const lenN = kid(n, "length"); const pinLen = lenN ? num(lenN[1]) : 2.54;
    const symSize = 0.508; let s = symSize; let pts, kind = shape || "round";
    if (kind === "dot") { s = symSize * 0.7; pts = [[0, 0], [0, pinLen - s], [0, pinLen]]; }
    else if (kind === "round") pts = [[0, 0], [0, pinLen - s], [0, pinLen]];
    else if (kind === "diamond") pts = [[0, 0], [0, pinLen - s], [-2 * symSize, pinLen], [0, pinLen + s], [2 * symSize, pinLen], [0, pinLen - s]];
    else { s = symSize * 0.8; pts = [[0, 0], [0, pinLen - s], [-2 * s, pinLen - s], [-2 * s, pinLen + s], [2 * s, pinLen + s], [2 * s, pinLen - s], [0, pinLen - s]]; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    const w = Math.max(pen, SCH_PEN);
    if (kind === "dot" || kind === "round") {
      G(item, { t: "line", x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], w, color, layer: "Labels", z: SCH_Z.netclass });
      G(item, { t: "circle", x: pts[2][0], y: pts[2][1], r: Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]), w, color, fill: kind === "dot" ? color : null, layer: "Labels", z: SCH_Z.netclass });
    } else G(item, { t: "poly", pts, close: false, w, color, layer: "Labels", z: SCH_Z.netclass });
    if (text) textGeom(item, x, y, text, size, color, st.rot, [st.h, "bottom"], "Labels", { z: SCH_Z.netclass, w: pen });
    labelFields(item, n, SCH.netclass, "Labels", SCH_Z.netclass);
  }
}

export function buildSheetGeom(item, n) {
  const [x, y] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 20, h = s ? num(s[2]) : 20;
  const f = fillOf(n); const bw = widthOf(n, 0) || SCH_PEN;
  if (f.color) G(item, { t: "rect", x, y, w, h, wd: 0, color: f.color, fill: f.color, layer: "Sheets", z: SCH_Z.sheetBg, noStroke: true });
  G(item, Object.assign({ t: "rect", x, y, w, h, wd: bw, color: strokeColorOf(n) || SCH.sheet, fill: null, layer: "Sheets", z: SCH_Z.sheet }, dashOf(n)));
  item.movable = true; item.x = x; item.y = y; item.w = w; item.h = h; item.rot = 0;
  // A subsheet's page number lives HERE, in the parent's instance data — the child's own file has no
  // (sheet_instances …) at all.  SCH_SCREEN::GetPageNumber() is what feeds the child's ${#}
  // (eeschema/sch_view.cpp:134), so the child cannot answer it from its own text.
  const inst = kid(n, "instances");
  if (inst) for (const proj of kids(inst, "project")) for (const path of kids(proj, "path")) { const pg = kid(path, "page"); if (pg) { item.page = str(pg[1]); break; } }
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Sheetname") item.name = val; if (name === "Sheetfile") item.file = val;
    if (ef.hide || !val) continue;
    const [px, py, pr] = atOf(p);
    const color = name === "Sheetname" ? SCH.sheetName : name === "Sheetfile" ? SCH.sheetFile : SCH.sheetFields;
    textLines(item, px, py, (name === "Sheetfile" ? "File: " : "") + val, ef.size, color, pr, ef.just, "Sheets", { z: SCH_Z.sheetFields, w: textPen(ef, ef.size), defH: "left", defV: "bottom" });
  }
  for (const pin of kids(n, "pin")) {
    const [px, py, pr] = atOf(pin); const ef = effectsOf(pin); const size = ef.size; const pen = textPen(ef, size);
    // side → spin: right edge reads leftwards into the sheet, etc. (SCH_SHEET_PIN::SetSide)
    const side = ((Math.round(pr) % 360) + 360) % 360; const spin = side === 0 ? "L" : side === 90 ? "B" : side === 180 ? "R" : "U";
    let shape = str(pin[2]) || "input"; if (shape === "input") shape = "output"; else if (shape === "output") shape = "input";
    G(item, { t: "poly", pts: hierShape(px, py, size, shape, spin), close: false, w: SCH_PEN, color: SCH.sheetLabel, layer: "Sheets", z: SCH_Z.sheet });
    const d = 0.15 * size + ef.sizeX; const st = spinText(spin);
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, px + to[0], py + to[1], str(pin[1]), size, SCH.sheetLabel, st.rot, [st.h, "middle"], "Sheets", { z: SCH_Z.sheet, w: pen });
  }
}

export const PIN_TEXT_OFFSET = Math.round(24 * 0.15) * MIL, PIN_TEXT_MARGIN = 4 * MIL, TARGET_PIN_RADIUS = 15 * MIL;

export const pinHidden = (g) => has(g, "hide") || !!(kid(g, "hide") && str(kid(g, "hide")[1]) === "yes");

export function buildSymbolGeom(doc, item) {
  const n = item.node;
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const [ax, ay, rot] = atOf(n);
  const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1;
  const styleN = kid(n, "body_style") || kid(n, "convert"); const style = styleN ? num(styleN[1], 1) : 1;
  const dnp = yesNo(n, "dnp"); const noSim = yesNo(n, "exclude_from_sim");
  const T = symbolTransform(rot, mirror); const Ti = internalT(T);
  const tf = (lx, ly) => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  item.movable = true; item.x = ax; item.y = ay; item.rot = rot; item.lib = str((kid(n, "lib_id") || [])[1]) || libId; item.unit = unit;
  const lib = resolveLib(doc, libId) || (libId !== str((kid(n, "lib_id") || [])[1]) ? resolveLib(doc, str((kid(n, "lib_id") || [])[1])) : null);
  const col = dnp ? (c) => dimColor(c, SCH.bg) : (c) => c;
  const alpha = noSim ? 0.5 : undefined;
  const bodyLayer = "Symbols";
  let bodyBox = null, pinBox = null;
  const take = (g0) => { const b = item.bbox; if (!b) return; if (g0 === "pin") pinBox = boxUnion(pinBox, b[0], b[1], b[2], b[3]); else bodyBox = boxUnion(bodyBox, b[0], b[1], b[2], b[3]); };
  if (lib) {
    const pn = kid(lib, "pin_names"); const nameOff = pn && kid(pn, "offset") ? num(kid(pn, "offset")[1]) : 0.508;
    const hideNames = !!(pn && (has(pn, "hide") || (kid(pn, "hide") && str(kid(pn, "hide")[1]) === "yes")));
    const pnu = kid(lib, "pin_numbers"); const hideNums = !!(pnu && (has(pnu, "hide") || (kid(pnu, "hide") && str(kid(pnu, "hide")[1]) === "yes")));
    const subs = kids(lib, "symbol");
    // tallest visible pin name of the whole symbol positions names above horizontal pins
    let maxNameHalf = 0;
    for (const sub of subs) for (const p of kids(sub, "pin")) { const nm = kid(p, "name"); if (nm && str(nm[1]) && str(nm[1]) !== "~") maxNameHalf = Math.max(maxNameHalf, effectsOf(nm).size / 2); }
    const sym = { nameOff, hideNames, hideNums, maxNameHalf, col, alpha };
    const geomStart = item.geom.length;
    for (const sub of subs) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || s !== style) continue;
      for (let j = 2; j < sub.length; j++) {
        const g = sub[j]; if (!isList(g)) continue;
        const gk = g[0];
        if (yesNo(g, "private")) continue;
        const before = item.bbox ? item.bbox.slice() : null; item.bbox = null;
        if (gk === "rectangle" || gk === "polyline" || gk === "bezier" || gk === "circle" || gk === "arc") {
          shapeGeom(item, g, gk, tf, col(SCH.outline), bodyLayer, SCH_Z.device, SCH_Z.deviceBg, widthOf(g, 0) || SCH_PEN);
          take("body");
        } else if (gk === "text") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g);
          if (!ef.hide) { const [px, py] = tf(tx, ty); transformedText(item, Ti, px, py, str(g[1]), ef.size, col(strokeColorOf(g) || SCH.outline), tr, ef.just, bodyLayer, { z: SCH_Z.device, w: textPen(ef, ef.size), alpha }); take("body"); }
        } else if (gk === "text_box") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g); const sz = kid(g, "size"); const [px, py] = tf(tx, ty);
          if (!ef.hide) { transformedText(item, Ti, px, py, str(g[1]), ef.size, col(SCH.outline), tr, ef.just, bodyLayer, { z: SCH_Z.device, w: textPen(ef, ef.size), alpha, defH: "left", defV: "top" }); take("body"); }
        } else if (gk === "pin") {
          if (pinHidden(g)) {
            // kept aside, untouched bbox: drawn only under the showHiddenPins render option, in KiCad's hidden-item colour
            const shadow = { geom: [], bbox: null };
            buildPinGeom(shadow, g, tf, Object.assign({}, sym, { col: () => SCH.hidden, showHidden: true }));
            if (shadow.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...shadow.geom);
          } else { buildPinGeom(item, g, tf, sym); take("pin"); }
        }
        if (before) item.bbox = item.bbox ? boxUnion(item.bbox, before[0], before[1], before[2], before[3]) : before;
      }
    }
    if (alpha !== undefined) for (let i = geomStart; i < item.geom.length; i++) if (item.geom[i].alpha === undefined) item.geom[i].alpha = alpha;
    if (alpha !== undefined && item.hiddenGeom) for (const hg of item.hiddenGeom) if (hg.alpha === undefined) hg.alpha = alpha;
  } else {
    G(item, { t: "rect", x: ax - 2.54, y: ay - 2.54, w: 5.08, h: 5.08, wd: SCH_PEN, color: SCH.outline, fill: null, layer: bodyLayer, z: SCH_Z.device });
    bodyBox = item.bbox.slice();
  }
  if (!bodyBox) bodyBox = [ax, ay, ax, ay]; if (!pinBox) pinBox = bodyBox.slice();
  const union = boxUnion(bodyBox, pinBox[0], pinBox[1], pinBox[2], pinBox[3]);
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Reference") item.ref = val; if (name === "Value") item.value = val;
    if (ef.hide || !val || name.startsWith("ki_")) continue;
    const [px, py, pr] = atOf(p);
    const isRef = name === "Reference", isVal = name === "Value";
    const color = col(isRef || isVal ? SCH.ref : SCH.field);
    transformedText(item, Ti, px, py, val, ef.size, color, pr, ef.just, isRef || isVal ? "Reference & value" : "Fields", { z: isRef ? SCH_Z.ref : isVal ? SCH_Z.value : SCH_Z.fields, w: textPen(ef, ef.size), alpha, field: name });
  }
  if (dnp) {
    // SCH_PAINTER: body box grown toward the pins, crossed at 3× the default line width
    const mx0 = Math.max(bodyBox[0] - union[0], union[2] - bodyBox[2]), my0 = Math.max(bodyBox[1] - union[1], union[3] - bodyBox[3]);
    const mx = Math.max(mx0 * 0.6, my0 * 0.3), my = Math.max(my0 * 0.6, mx0 * 0.3);
    const b = [bodyBox[0] - mx, bodyBox[1] - my, bodyBox[2] + mx, bodyBox[3] + my];
    G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
    G(item, { t: "line", x1: b[0], y1: b[3], x2: b[2], y2: b[1], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
  }
  if (noSim) {
    // exclude-from-simulation marker: grey frame plus the wave badge at the bottom-right corner
    const sw = 25 * MIL; const b = [bodyBox[0] - sw / 2, bodyBox[1] - sw / 2, bodyBox[2] + sw / 2, bodyBox[3] + sw / 2];
    G(item, { t: "poly", pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], close: true, w: sw, color: SCH.excluded, layer: "Symbols", z: SCH_Z.marker });
    const off = 2 * sw; const cx = b[2] + off + sw, cy = b[3] - off;
    G(item, { t: "circle", x: cx, y: cy, r: off, w: sw, color: SCH.excluded, fill: "rgba(194,194,194,0.1)", layer: "Symbols", z: SCH_Z.marker });
    G(item, { t: "poly", pts: bezierPts([[cx - off, cy], [cx, cy + off], [cx, cy - off], [cx + off, cy]], 12), close: false, w: sw, color: SCH.excluded, layer: "Symbols", z: SCH_Z.marker });
  }
  if (!item.bbox) bboxAdd(item, ax, ay, 2.54);
}

/** One library pin mapped to the sheet: line, shape decoration, name and number (PIN_LAYOUT_CACHE rules). */
export function buildPinGeom(item, g, tf, sym) {
  const type = str(g[1]), shape = str(g[2]);
  const [px, py, pr] = atOf(g); const lenN = kid(g, "length"); const len = lenN ? num(lenN[1]) : 2.54;
  if (pinHidden(g) && !sym.showHidden) return;   // hidden (e.g. power) pins draw nothing unless asked for
  const dir = ((Math.round(pr) % 360) + 360) % 360;
  const d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];   // file angle points into the body
  const pos = tf(px, py), rootPt = tf(px + d[0] * len, py + d[1] * len);
  const tip = tf(px + d[0], py + d[1]); let ox = pos[0] - tip[0], oy = pos[1] - tip[1];   // outward: body → connection point
  const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
  // KiCad's PIN_RIGHT/LEFT/UP/DOWN name the direction from the connection point into the body
  const orient = ox < 0 ? "R" : ox > 0 ? "L" : oy > 0 ? "U" : "D"; const vertical = orient === "U" || orient === "D";
  const color = sym.col(SCH.pin); const w = SCH_PEN; const z = SCH_Z.pin, layer = "Pins";
  const nameN = kid(g, "name"), numN = kid(g, "number");
  const nameEf = nameN ? effectsOf(nameN) : { size: 1.27, hide: false }, numEf = numN ? effectsOf(numN) : { size: 1.27, hide: false };
  const radius = numEf.size / 2, diam = radius * 2, clock = (nameEf.size || numEf.size) / 2;
  const p0 = rootPt; const line = (a, b) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  const tri = (a, b, c) => G(item, { t: "poly", pts: [a, b, c], close: false, w, color, layer, z });
  const P = (dx, dy) => [p0[0] + dx, p0[1] + dy];
  if (len > 0 || shape !== "line") {
    if (type === "no_connect") {
      line(p0, pos); const r = TARGET_PIN_RADIUS;
      line([pos[0] - r, pos[1] - r], [pos[0] + r, pos[1] + r]); line([pos[0] + r, pos[1] - r], [pos[0] - r, pos[1] + r]);
    } else if (shape === "inverted") {
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "inverted_clock") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "clock_low" || shape === "edge_clock_high") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
      if (len > 0) line(p0, pos);
    } else if (shape === "clock") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(0, clock), P(-ox * clock, 0), P(0, -clock)); else tri(P(clock, 0), P(0, -oy * clock), P(-clock, 0));
    } else if (shape === "input_low") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
    } else if (shape === "output_low") {
      if (len > 0) line(p0, pos);
      if (!oy) line(P(0, -diam), P(ox * diam, 0)); else line(P(-diam, 0), P(0, oy * diam));
    } else if (shape === "non_logic") {
      if (len > 0) line(p0, pos);
      line(P(-(ox + oy) * radius, -(oy - ox) * radius), P((ox + oy) * radius, (oy - ox) * radius));
      line(P(-(ox - oy) * radius, -(ox + oy) * radius), P((ox - oy) * radius, (ox + oy) * radius));
    } else if (len > 0) line(p0, pos);
  }
  bboxAdd(item, pos[0], pos[1]); bboxAdd(item, p0[0], p0[1]);
  // --- text ---
  const pinName = nameN ? str(nameN[1]) : "", pinNum = numN ? str(numN[1]) : "";
  const showName = !!pinName && pinName !== "~" && !sym.hideNames && !nameEf.hide;
  const showNum = !!pinNum && !sym.hideNums && !numEf.hide;
  const nameThick = Math.min(SCH_PEN, 0.18 * nameEf.size), numThick = Math.min(SCH_PEN, 0.18 * numEf.size);
  const clearance = PIN_TEXT_OFFSET + PIN_TEXT_MARGIN; const halfLen = len / 2;
  const inside = sym.nameOff > 0;
  const both = !!pinName && pinName !== "~" && !sym.hideNames && !inside;   // name drawn outside → number moves to the other side
  const alongX = orient === "L" ? pos[0] - halfLen : pos[0] + halfLen, alongY = orient === "D" ? pos[1] + halfLen : pos[1] - halfLen;
  const nameColor = sym.col(SCH.pinName), numColor = sym.col(SCH.pinNum);
  if (showNum) {
    const perp = clearance + numEf.size / 2 + numThick;
    if (vertical) textGeom(item, both ? pos[0] + perp : pos[0] - perp, alongY, pinNum, numEf.size, numColor, 90, ["center", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
    else textGeom(item, alongX, both ? pos[1] + perp : pos[1] - perp, pinNum, numEf.size, numColor, 0, ["center", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
  }
  if (showName) {
    if (inside) {
      const dd = len + sym.nameOff;
      const at = orient === "R" ? [pos[0] + dd, pos[1]] : orient === "L" ? [pos[0] - dd, pos[1]] : orient === "U" ? [pos[0], pos[1] - dd] : [pos[0], pos[1] + dd];
      textGeom(item, at[0], at[1], pinName, nameEf.size, nameColor, vertical ? 90 : 0, [orient === "R" || orient === "U" ? "left" : "right", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else if (vertical) {
      textGeom(item, pos[0] - (clearance + nameEf.size / 2 + nameThick), alongY, pinName, nameEf.size, nameColor, 90, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else {
      textGeom(item, alongX, pos[1] - (sym.maxNameHalf + clearance + nameThick), pinName, nameEf.size, nameColor, 0, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    }
  }
}
