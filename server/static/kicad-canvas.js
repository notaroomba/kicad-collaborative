// kicad-canvas.js — parse KiCad s-expression documents (schematic sheets and
// boards) and draw them on a 2D canvas, applying live collaboration ops per item.
//
// Coordinates are millimetres with Y down (KiCad's screen convention) for both
// document types; library symbol geometry (Y up) is mapped through KiCad's own
// orientation matrices.  Nothing here touches the DOM except the canvas context
// handed to render(), so the parser also runs under node for tests.
//
// Placement rules follow eeschema/sch_painter.cpp, eeschema/pin_layout_cache.cpp,
// eeschema/sch_label.cpp and pcbnew/pcb_painter.cpp; colours are KiCad's default
// theme (common/settings/builtin_color_themes.h).
(function (root) {
"use strict";

// ---------------------------------------------------------------- s-expressions
function parse(text) {
  let i = 0; const n = text.length;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  function list() {
    i++; const out = [];
    for (;;) {
      while (i < n && ws(text.charCodeAt(i))) i++;
      if (i >= n) break;
      const c = text[i];
      if (c === ")") { i++; break; }
      if (c === "(") out.push(list());
      else if (c === '"') out.push(quoted());
      else out.push(atom());
    }
    return out;
  }
  function quoted() {
    i++; let s = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") { const d = text[i + 1]; s += d === "n" ? "\n" : d === "t" ? "\t" : d; i += 2; continue; }
      if (c === '"') { i++; break; }
      s += c; i++;
    }
    return s;
  }
  function atom() {
    const st = i;
    while (i < n) { const c = text.charCodeAt(i); if (ws(c) || c === 40 || c === 41) break; i++; }
    const a = text.slice(st, i);
    const v = Number(a);
    return a !== "" && !isNaN(v) && /^[-+.\d]/.test(a) ? v : a;
  }
  while (i < n && ws(text.charCodeAt(i))) i++;
  return text[i] === "(" ? list() : null;
}
function parseAll(text) {
  const out = [];
  // cheap split on top-level parentheses: parse, then continue after the consumed prefix
  let i = 0; const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n || text[i] !== "(") break;
    let depth = 0, j = i, inStr = false;
    for (; j < n; j++) {
      const c = text[j];
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    }
    const node = parse(text.slice(i, j)); if (node) out.push(node);
    i = j;
  }
  return out;
}
const isList = Array.isArray;
function kid(node, key) { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
function kids(node, key) { const out = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
function num(v, d = 0) { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }
function str(v) { return v === undefined || v === null ? "" : String(v); }
function has(node, tok) { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
function yesNo(node, key) { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key); }
function uuidOf(node) { const u = kid(node, "uuid") || kid(node, "tstamp"); return u ? str(u[1]) : ""; }
function atOf(node) {
  const t = kid(node, "transform");
  if (t) { const tr = kid(t, "translate"), ro = kid(t, "rotate"); return [tr ? num(tr[1]) : 0, tr ? num(tr[2]) : 0, ro ? num(ro[1]) : 0]; }
  const a = kid(node, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0];
}
function ptsOf(node) { const p = kid(node, "pts"); return p ? kids(p, "xy").map((x) => [num(x[1]), num(x[2])]) : []; }
function widthOf(node, def) {
  const s = kid(node, "stroke"); const w = s && kid(s, "width"); if (w) return num(w[1], def);
  const w2 = kid(node, "width"); return w2 ? num(w2[1], def) : def;
}
function colorOf(node) {
  // (color r g b a) child with a > 0, as a CSS colour; null when unspecified
  const c = kid(node, "color"); if (!c) return null; const a = num(c[4], 1); if (a <= 0) return null;
  return rgba(num(c[1]), num(c[2]), num(c[3]), a);
}
function strokeColorOf(node) { const s = kid(node, "stroke"); return s ? colorOf(s) : null; }
/** fill descriptor: {type: none|outline|background|color|solid, color} */
function fillOf(node) {
  const f = kid(node, "fill"); if (!f) return { type: "none", color: null };
  const t = kid(f, "type"); let type = t ? str(t[1]) : (has(f, "yes") || has(f, "solid") ? "solid" : "none");
  if (type === "yes") type = "solid";
  return { type, color: colorOf(f) };
}
function effectsOf(node) {
  const e = kid(node, "effects");
  const r = { size: 1.27, sizeX: 1.27, thick: 0, hide: false, just: [], mirror: false, bold: false, italic: false };
  if (e) {
    const f = kid(e, "font");
    if (f) {
      const s = kid(f, "size"); if (s) { r.size = num(s[2], num(s[1], 1.27)); r.sizeX = num(s[1], r.size); }
      const t = kid(f, "thickness"); if (t) r.thick = num(t[1]);
      r.bold = yesNo(f, "bold"); r.italic = yesNo(f, "italic");
    }
    const j = kid(e, "justify"); if (j) { r.just = j.slice(1).map(str); if (r.just.includes("mirror")) r.mirror = true; }
    if (has(e, "hide")) r.hide = true; const h = kid(e, "hide"); if (h && str(h[1]) === "yes") r.hide = true;
  }
  if (has(node, "hide")) r.hide = true; const h2 = kid(node, "hide"); if (h2 && str(h2[1]) === "yes") r.hide = true;
  return r;
}
function justOf(just, defH, defV) {
  const h = just.includes("left") ? "left" : just.includes("right") ? "right" : (defH || "center");
  const v = just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : (defV || "middle");
  return { h, v };
}
const flipH = (h) => h === "left" ? "right" : h === "right" ? "left" : h;
const flipV = (v) => v === "top" ? "bottom" : v === "bottom" ? "top" : v;
function arcFrom3(p0, pm, p1) {
  // centre of the circle through three points; null when collinear
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
  // choose the sweep direction that passes through the mid point (mirrored inputs flip it naturally)
  const norm = (a) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = norm(a1 - a0), ccwMid = norm(am - a0);
  const ccw = ccwMid <= ccwSweep;   // canvas "anticlockwise" flag is false for increasing angles
  return { x: ux, y: uy, r, a0, a1, anticlockwise: !ccw };
}
function bezierPts(p, segs) {
  // cubic (4 control points) flattened into line segments; quadratic-ish 3-point input is promoted
  if (p.length < 3) return p.slice();
  const [a, b, c, d] = p.length >= 4 ? p : [p[0], p[1], p[1], p[2]];
  const out = []; segs = segs || 16;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
              u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]);
  }
  return out;
}
// KiCad's RotatePoint: positive angles turn counter-clockwise on the (Y down) screen
function rotPt(x, y, deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; }
function rotator(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; }
function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- text metrics
// Newstroke advance widths (units of 1/21 of the text size) for ASCII 32..126, read
// from common/newstroke_font.cpp; KiCad's string width = Σadvance·size − 0.2·size + 3·thickness.
const STROKE_ADV = [16, 10, 16, 21, 20, 24, 26, 10, 14, 14, 16, 26, 10, 26, 10, 22, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 26, 26, 26, 18, 27, 18, 21, 21, 21, 19, 18, 21, 22, 10, 16, 21, 17, 24, 22, 22, 21, 22, 21, 20, 16, 22, 18, 24, 20, 18, 20, 14, 14, 14, 12, 16, 8, 19, 19, 18, 19, 18, 12, 19, 19, 10, 10, 17, 11, 28, 19, 19, 19, 19, 13, 17, 12, 19, 16, 22, 17, 16, 17, 14, 20, 14, 15];
function textWidth(text, size, thick) {
  let w = 0;
  for (const ch of text) { const c = ch.charCodeAt(0) - 32; w += (c >= 0 && c < 95 ? STROKE_ADV[c] : 21) / 21; }
  return text.length ? Math.max(0, w - 0.2) * size + 3 * (thick || 0) : 0;
}
/** Strip KiCad text markup; overbar spans (~{...}) are kept as [start, end) indices of the shown text. */
function parseMarkup(s) {
  if (s.indexOf("{") < 0) return { text: s, bars: null };
  let out = "", bars = null; const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], d = s[i + 1];
    if ((c === "~" || c === "_" || c === "^") && d === "{") { stack.push({ kind: c, start: out.length }); i++; continue; }
    if (c === "}" && stack.length) { const o = stack.pop(); if (o.kind === "~") (bars = bars || []).push([o.start, out.length]); continue; }
    out += c;
  }
  return { text: out, bars };
}
const INTERLINE = 1.68 * 0.9583;   // stroke font line pitch (font_metrics.h × STROKE_FONT legacy factor)
const SCH_PEN = 0.1524;             // DEFAULT_LINE_WIDTH_MILS (6 mil)
const MIL = 0.0254;
function textPen(ef, size) {
  // EDA_TEXT::GetEffectiveTextPenWidth with the schematic default pen (0): size/8, bold size/5, clamped to size/4
  let pen = ef.thick > 0.001 ? ef.thick : (ef.bold ? size / 5 : size / 8);
  return Math.min(pen, size * 0.25);
}

// ---------------------------------------------------------------- colours
function rgba(r, g, b, a) { return a === undefined || a >= 1 ? "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("") : `rgba(${r},${g},${b},${+a.toFixed(3)})`; }
function parseColor(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(c); if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, 1]; }
  const n = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c); if (n) return [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  return [0, 0, 0, 1];
}
/** KiCad's "dimmed" item colour: desaturate then mix 50/50 with the sheet background. */
function dimColor(c, bg) {
  const [r, g, b, a] = parseColor(c), [br, bgc, bb] = parseColor(bg);
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;   // HSL lightness = desaturated grey
  return rgba(Math.round((l + br) / 2), Math.round((l + bgc) / 2), Math.round((l + bb) / 2), a);
}
const SCH = {
  bg: "#F5F4EF", grid: "#B5B5B5", wire: "#009600", bus: "#000084", junction: "#009600", outline: "#840000",
  body: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", ref: "#006464", value: "#006464",
  field: "#840084", label: "#0F0F0F", glabel: "#840000", hlabel: "#725600", sheet: "#840000", sheetName: "#006464",
  sheetFile: "#725600", sheetFields: "#840084", sheetLabel: "#006464", noconnect: "#000084", notes: "#0000C2",
  busEntry: "#009600", dnp: "rgba(220,9,13,0.85)", netclass: "#484848", ruleArea: "#FF0000", excluded: "rgba(194,194,194,0.95)",
  hidden: "#C2C2C2", privateNotes: "#4848FF", frame: "#840000",
};
// draw order (eeschema SCH_VIEW layer order, bottom first)
const SCH_Z = { sheetBg: -6, sheetFields: -5, sheet: -4, notesBg: -3, deviceBg: -2, notes: -1, device: 0, pinName: 1, pinNum: 2, pin: 3,
  wire: 4, bus: 5, junction: 6, noconnect: 7, loclabel: 8, globlabel: 9, hierlabel: 10, ruleArea: 11, netclass: 12, fields: 13, value: 14, ref: 15, marker: 16 };
const SCH_LAYERS = [
  ["Wires", SCH.wire], ["Buses", SCH.bus], ["Junctions", SCH.junction], ["Symbols", SCH.outline], ["Pins", SCH.pin],
  ["Pin names", SCH.pinName], ["Pin numbers", SCH.pinNum], ["Reference & value", SCH.ref], ["Fields", SCH.field],
  ["Labels", SCH.label], ["Sheets", SCH.sheet], ["Notes", SCH.notes], ["No-connects", SCH.noconnect], ["Rule areas", SCH.ruleArea],
];
const PCB_COLORS = {
  "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "In1.Cu": "#7FC87F", "In2.Cu": "#CE7D2C", "In3.Cu": "#4FCBCB", "In4.Cu": "#DB628B",
  "In5.Cu": "#A7A5C6", "In6.Cu": "#28CCD9", "In7.Cu": "#E8B2A7", "In8.Cu": "#F2EDA1", "In9.Cu": "#8DCB81", "In10.Cu": "#ED7C33",
  "In11.Cu": "#5BC3EB", "In12.Cu": "#F76F8E", "In13.Cu": "#A7A5C6", "In14.Cu": "#28CCD9", "In15.Cu": "#E8B2A7", "In16.Cu": "#F2EDA1",
  "In17.Cu": "#ED7C33", "In18.Cu": "#5BC3EB", "In19.Cu": "#F76F8E", "In20.Cu": "#A7A5C6", "In21.Cu": "#28CCD9", "In22.Cu": "#E8B2A7",
  "In23.Cu": "#F2EDA1", "In24.Cu": "#ED7C33", "In25.Cu": "#5BC3EB", "In26.Cu": "#F76F8E", "In27.Cu": "#A7A5C6", "In28.Cu": "#28CCD9",
  "In29.Cu": "#E8B2A7", "In30.Cu": "#F2EDA1",
  "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Mask": "rgba(216,100,255,0.4)", "B.Mask": "rgba(2,255,238,0.4)",
  "F.Paste": "rgba(180,160,154,0.9)", "B.Paste": "rgba(0,194,194,0.9)", "F.Adhes": "#840084", "B.Adhes": "#000084",
  "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2", "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF", "F.Fab": "#AFAFAF", "B.Fab": "#585D84",
  "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC", "Eco1.User": "#B4DBD2", "Eco2.User": "#D8C852",
};
const USER_COLORS = ["#C2C2C2", "#5994DC", "#B4DBD2", "#D8C852"];   // User.1.. cycle (User.9 = B.SilkS colour in the theme)
const PCB_BG = "#001023", PCB_GRID = "#848484", VIA_HOLE = "#E3B72E", HOLE_WALL = "#ECECEC", NPTH = "#1AC4D2", PAD_TEXT = "rgba(255,255,255,0.9)";
const PCB_HIDDEN_DEFAULT = new Set(["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Margin", "Eco1.User", "Eco2.User"]);
function pcbColor(layer) {
  if (PCB_COLORS[layer]) return PCB_COLORS[layer];
  const u = /^User\.(\d+)$/.exec(layer); if (u) return +u[1] === 9 ? "#E8B2A7" : USER_COLORS[(+u[1] - 1) % 4];
  if (/\.Cu$/.test(layer)) return "#7FC87F"; return "#C2C2C2";
}
// pcbnew GAL_LAYER_ORDER, bottom first; copper groups carry fill/track/pad/via sub-orders
const PCB_ORDER = ["B.Fab", "B.CrtYd", "B.Adhes", "B.Paste", "B.SilkS", "B.Mask", "B.Cu"];
for (let i = 30; i >= 1; i--) PCB_ORDER.push("In" + i + ".Cu");
PCB_ORDER.push("F.Fab", "F.CrtYd", "F.Adhes", "F.Paste", "F.SilkS", "F.Mask", "F.Cu", "holes");
for (let i = 45; i >= 1; i--) PCB_ORDER.push("User." + i);
PCB_ORDER.push("Margin", "Edge.Cuts", "Eco2.User", "Eco1.User", "Cmts.User", "Dwgs.User");
const PCB_ZMAP = new Map(PCB_ORDER.map((l, i) => [l, i * 10]));
function pcbZ(layer) { const z = PCB_ZMAP.get(layer); return z === undefined ? 5 : z; }
const Z_PAD = 2, Z_VIA = 3, Z_TEXT = 4, Z_ZONE = -1;
function padLayers(doc, names) {
  // expand *.Cu / F&B.Cu etc. against the board's copper layers (front→back order)
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const out = [];
  for (const n of names) {
    if (n === "*.Cu") out.push(...copper);
    else if (n === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (n.startsWith("*.")) out.push("F" + n.slice(1), "B" + n.slice(1));
    else out.push(n);
  }
  return out.filter((l, i) => out.indexOf(l) === i);
}

// ---------------------------------------------------------------- documents
function newDoc(type) { return { type, items: new Map(), lib: new Map(), page: [297, 210], layers: new Map(), copper: [], bbox: null }; }
function paperSize(node) {
  const name = str(node[1]);
  const sizes = { A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
    A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
    USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4] };
  let s = sizes[name] || (name === "User" ? [num(node[2], 297), num(node[3], 210)] : [297, 210]);
  if (has(node, "portrait")) s = [s[1], s[0]];
  return s.slice();
}

function parseDoc(text, docType) {
  const tree = parse(text);
  if (!tree) throw new Error("not an s-expression document");
  const type = tree[0] === "kicad_sch" ? "sch" : tree[0] === "kicad_pcb" ? "pcb" : (docType === "kicad_sch" ? "sch" : "pcb");
  const doc = newDoc(type);
  if (type === "sch") { const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s); }
  for (let j = 1; j < tree.length; j++) {
    const node = tree[j]; if (!isList(node)) continue;
    const k = node[0];
    if (k === "paper") doc.page = paperSize(node);
    else if (type === "pcb" && k === "layers") {
      // (0 "F.Cu" signal ["user name"])
      for (const l of node.slice(1)) if (isList(l)) { const name = str(l[1]), ltype = str(l[2]); doc.layers.set(name, { id: num(l[0]), type: ltype, userName: l[3] !== undefined ? str(l[3]) : "" }); if (/\.Cu$/.test(name) && ltype !== "user") doc.copper.push(name); }
    }
    else if (k === "lib_symbols" || k === "version" || k === "generator" || k === "generator_version" || k === "general" || k === "setup" || k === "net" || k === "title_block" || k === "sheet_instances" || k === "symbol_instances" || k === "embedded_fonts" || k === "embedded_files" || k === "uuid") continue;
    else addItem(doc, node);
  }
  computeBBox(doc);
  return doc;
}

const SCH_KINDS = new Set(["symbol", "wire", "bus", "junction", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect", "sheet", "text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "bus_entry", "image", "table", "rule_area"]);
const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated"]);

function addItem(doc, node) {
  const k = node[0];
  if (doc.type === "sch" ? !SCH_KINDS.has(k) : !PCB_KINDS.has(k)) return null;
  let id = uuidOf(node);
  if (!id) id = "anon-" + (doc.items.size + 1) + "-" + Math.random().toString(36).slice(2, 8);
  const item = { id, kind: k, node, geom: [], bbox: null, movable: false, hiddenGeom: null };
  buildGeom(doc, item);
  doc.items.set(id, item);
  return item;
}

function computeBBox(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (b) => { if (!b) return; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); };
  if (doc.type === "pcb") {
    // What a person means by "the board": the outline together with the copper.
    for (const it of doc.items.values()) if (it.edge || it.kind === "segment" || it.kind === "via" || it.kind === "footprint" || it.kind === "zone" || it.kind === "arc") take(it.bbox);
    if (!isFinite(x0)) for (const it of doc.items.values()) take(it.bbox);
  } else {
    x0 = 0; y0 = 0; x1 = doc.page[0]; y1 = doc.page[1];
  }
  doc.bbox = isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, doc.page[0], doc.page[1]];
}

// ---------------------------------------------------------------- geometry builders
function bboxAdd(item, x, y, pad) {
  pad = pad || 0;
  if (!item.bbox) item.bbox = [x - pad, y - pad, x + pad, y + pad];
  else { const b = item.bbox; if (x - pad < b[0]) b[0] = x - pad; if (y - pad < b[1]) b[1] = y - pad; if (x + pad > b[2]) b[2] = x + pad; if (y + pad > b[3]) b[3] = y + pad; }
}
function boxUnion(b, x0, y0, x1, y1) { if (!b) return [x0, y0, x1, y1]; return [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)]; }
function G(item, g) {
  item.geom.push(g);
  if (g.t === "line") { bboxAdd(item, g.x1, g.y1, g.w / 2); bboxAdd(item, g.x2, g.y2, g.w / 2); }
  else if (g.t === "poly") for (const p of g.pts) bboxAdd(item, p[0], p[1], g.w / 2);
  else if (g.t === "circle" || g.t === "arc") { bboxAdd(item, g.x - g.r, g.y - g.r); bboxAdd(item, g.x + g.r, g.y + g.r); }
  else if (g.t === "rect") { bboxAdd(item, g.x, g.y); bboxAdd(item, g.x + g.w, g.y + g.h); }
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

function buildGeom(doc, item) {
  item.geom = []; item.bbox = null; item.hiddenGeom = null;
  if (doc.type === "sch") buildSchGeom(doc, item); else buildPcbGeom(doc, item);
}

// ---- schematic ----
// KiCad TRANSFORM matrices on library (Y up) coordinates: screen = T·lib + origin (x' = T0·x + T1·y, y' = T2·x + T3·y)
const ORIENT = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
function symbolTransform(rot, mirror) {
  let T = ORIENT[((Math.round(rot) % 360) + 360) % 360] || ORIENT[0];
  if (mirror === "y") T = [-T[0], -T[1], T[2], T[3]];   // mirror y negates the X row
  if (mirror === "x") T = [T[0], T[1], -T[2], -T[3]];   // mirror x negates the Y row
  return T.map((v) => v + 0);   // no -0 entries
}
// KiCad's own (internal, Y-down lib coordinates) matrix, used for field/text justification: T·diag(1,-1)
const internalT = (T) => [T[0], -T[1], T[2], -T[3]];
function resolveLib(doc, name, depth) {
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
/**
 * Text geometry.  Schematic text is never upside down: 180/270 become 0/90 with the anchor flipped.
 * extra.pcb keeps the angle as given (pcbnew draws any angle); extra.upright applies the footprint
 * keep-upright rule (angle kept within (-90, 90]).  Markup (~{overbar}) is stripped into g.bars.
 */
function textGeom(item, x, y, text, size, color, rot, just, layer, extra) {
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
function textLines(item, x, y, text, size, color, rot, just, layer, extra) {
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
function transformedText(item, Ti, x, y, text, size, color, angle, just, layer, extra) {
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

// label flag shapes (eeschema/sch_label.cpp)
const SPIN = { 0: "R", 90: "U", 180: "L", 270: "B" };   // file angle → spin style
const SPIN_ROT = { L: 0, U: -90, R: 180, B: 90 };        // template rotation per spin (RotatePoint sign)
const SPIN_IDX = { L: 0, U: 1, R: 2, B: 3 };
const HIER_TPL = {
  input: [[0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0], [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0], [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0], [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0]],
  output: [[-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0], [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2], [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0], [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2]],
  bidirectional: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  tri_state: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  passive: [[0, -1, -2, -1, -2, 1, 0, 1, 0, -1], [1, 0, 1, -2, -1, -2, -1, 0, 1, 0], [0, -1, 2, -1, 2, 1, 0, 1, 0, -1], [1, 0, 1, 2, -1, 2, -1, 0, 1, 0]],
};
function hierShape(x, y, size, shape, spin) {
  const t = (HIER_TPL[shape] || HIER_TPL.input)[SPIN_IDX[spin]]; const hs = size / 2; const pts = [];
  for (let i = 0; i < t.length; i += 2) pts.push([x + hs * t[i], y + hs * t[i + 1]]);
  return pts;
}
function spinText(spin) { return { rot: spin === "U" || spin === "B" ? 90 : 0, h: spin === "R" || spin === "U" ? "left" : "right" }; }
function labelFields(item, n, color, layer, z) {
  for (const p of kids(n, "property")) {
    const ef = effectsOf(p); const val = str(p[2]); if (ef.hide || !val || /^\$\{.*\}$/.test(val)) continue;
    const [px, py, pr] = atOf(p);
    textLines(item, px, py, val, ef.size, color, pr, ef.just, layer, { z, w: textPen(ef, ef.size), defH: "left", defV: "bottom" });
  }
}

function buildSchGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "wire" || k === "bus" || k === "polyline") {
    const p = ptsOf(n); const isBus = k === "bus";
    const w = widthOf(n, 0) || (isBus ? 0.3048 : 0.1524);
    const color = strokeColorOf(n) || (isBus ? SCH.bus : k === "polyline" ? SCH.notes : SCH.wire);
    G(item, { t: "poly", pts: p, close: false, w, color, layer: isBus ? "Buses" : k === "polyline" ? "Notes" : "Wires", z: isBus ? SCH_Z.bus : k === "polyline" ? SCH_Z.notes : SCH_Z.wire, cap: "round" });
  } else if (k === "bus_entry") {
    // wire-to-bus entries take the wire colour and width
    const [x, y] = atOf(n); const s = kid(n, "size"); const dx = s ? num(s[1]) : 2.54, dy = s ? num(s[2]) : 2.54;
    G(item, { t: "line", x1: x, y1: y, x2: x + dx, y2: y + dy, w: widthOf(n, 0) || 0.1524, color: strokeColorOf(n) || SCH.busEntry, layer: "Wires", z: SCH_Z.wire, cap: "round" });
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
    if (border > 0) G(item, { t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: border, color: strokeColorOf(n) || SCH.notes, fill: null, layer: "Notes", z: SCH_Z.notes });
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
      G(item, { t: "poly", pts: p, close: true, w: widthOf(pl, 0) || SCH_PEN, color: strokeColorOf(pl) || SCH.ruleArea, layer: "Rule areas", z: SCH_Z.ruleArea });
    }
  } else if (k === "sheet") {
    buildSheetGeom(item, n);
  } else if (k === "symbol") {
    buildSymbolGeom(doc, item);
  }
}
/** Graphic shape shared by sheet-level notes and library bodies (tf maps node coords to screen). */
function shapeGeom(item, g, gk, tf, color, layer, z, zBg, w, bodyFill) {
  const f = fillOf(g); const sc = strokeColorOf(g) || color;
  const fill = f.type === "background" ? SCH.body : f.type === "outline" ? sc : f.type === "color" ? f.color : f.type === "solid" ? sc : null;
  const fz = f.type === "outline" || f.type === "solid" ? z : zBg;   // KiCad fills device-coloured shapes in the foreground
  const closed = f.type !== "none";
  if (gk === "rectangle") {
    const s0 = kid(g, "start"), e0 = kid(g, "end"); if (!s0 || !e0) return;
    const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]);
    const pts = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    if (fill) G(item, { t: "poly", pts, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, { t: "poly", pts, close: true, w, color: sc, layer, z });
  } else if (gk === "polyline" || gk === "bezier") {
    let p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    if (gk === "bezier") p = bezierPts(p);
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, { t: "poly", pts: p, close: false, w, color: sc, layer, z });
  } else if (gk === "circle") {
    const c = kid(g, "center"), r = kid(g, "radius"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const rad = r ? num(r[1]) : 1;
    if (fill) G(item, { t: "circle", x: cx, y: cy, r: rad, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    G(item, { t: "circle", x: cx, y: cy, r: rad, w, color: sc, layer, z });
  } else if (gk === "arc") {
    const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !m0 || !e0) return;
    const a = arcFrom3(tf(num(s0[1]), num(s0[2])), tf(num(m0[1]), num(m0[2])), tf(num(e0[1]), num(e0[2])));
    if (a) G(item, Object.assign({ t: "arc", w, color: sc, layer, z, fill: closed ? fill : null }, a));
    else { const p0 = tf(num(s0[1]), num(s0[2])), p1 = tf(num(e0[1]), num(e0[2])); G(item, { t: "line", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color: sc, layer, z }); }
  }
}
function buildLabelGeom(item, n, k) {
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
function buildSheetGeom(item, n) {
  const [x, y] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 20, h = s ? num(s[2]) : 20;
  const f = fillOf(n); const bw = widthOf(n, 0) || SCH_PEN;
  if (f.color) G(item, { t: "rect", x, y, w, h, wd: 0, color: f.color, fill: f.color, layer: "Sheets", z: SCH_Z.sheetBg, noStroke: true });
  G(item, { t: "rect", x, y, w, h, wd: bw, color: strokeColorOf(n) || SCH.sheet, fill: null, layer: "Sheets", z: SCH_Z.sheet });
  item.movable = true; item.x = x; item.y = y; item.w = w; item.h = h; item.rot = 0;
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
const PIN_TEXT_OFFSET = Math.round(24 * 0.15) * MIL, PIN_TEXT_MARGIN = 4 * MIL, TARGET_PIN_RADIUS = 15 * MIL;
const pinHidden = (g) => has(g, "hide") || !!(kid(g, "hide") && str(kid(g, "hide")[1]) === "yes");
function buildSymbolGeom(doc, item) {
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
    transformedText(item, Ti, px, py, val, ef.size, color, pr, ef.just, isRef || isVal ? "Reference & value" : "Fields", { z: isRef ? SCH_Z.ref : isVal ? SCH_Z.value : SCH_Z.fields, w: textPen(ef, ef.size), alpha });
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
function buildPinGeom(item, g, tf, sym) {
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

// ---- board ----
function layerOf(node, def) { const l = kid(node, "layer"); return l ? str(l[1]) : def; }
function padCopperLayer(pad) {
  const ls = kid(pad, "layers"); const names = ls ? ls.slice(1).map(str) : [];
  if (names.some((x) => x === "F.Cu" || x === "*.Cu" || x === "F&B.Cu")) return "F.Cu";
  if (names.some((x) => x === "B.Cu")) return "B.Cu";
  const inner = names.find((x) => /\.Cu$/.test(x)); return inner || null;
}
function pcbTextGeom(item, n, x, y, text, rot, layer, extra) {
  const ef = effectsOf(n); if (ef.hide || !text) return null;
  const color = pcbColor(layer); const z = pcbZ(layer) + Z_TEXT;
  const thick = ef.thick > 0 ? ef.thick : (ef.bold ? ef.size / 5 : ef.size / 8);
  return textLines(item, x, y, text, ef.size, color, rot, ef.just, layer, Object.assign({ z, w: thick, mirror: ef.mirror, pcb: true }, extra || {}));
}
function buildPcbGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "segment") {
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const layer = layerOf(n, "F.Cu");
    G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true });
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return; const layer = layerOf(n, "F.Cu");
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) G(item, Object.assign({ t: "arc", w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true }, a));
    else G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true });
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
  }
  // groups, gr_bbox, images, generated items: nothing to draw
}
function buildViaGeom(doc, item, n) {
  const [x, y] = atOf(n); const sz = kid(n, "size"), dr = kid(n, "drill"); const size = sz ? num(sz[1]) : 0.8, drill = dr ? num(dr[1]) : 0.4;
  const vtype = has(n, "blind") ? "blind" : has(n, "micro") ? "micro" : "through";
  const ls = kid(n, "layers"); const pair = ls ? [str(ls[1]), str(ls[2])] : ["F.Cu", "B.Cu"];
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  let layers = copper;
  if (vtype !== "through") { const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); if (i0 >= 0 && i1 >= 0) layers = copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1); else layers = pair; }
  for (const layer of layers) G(item, { t: "circle", x, y, r: size / 2, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_VIA, via: true });
  const zh = pcbZ("holes");
  if (vtype === "through") G(item, { t: "circle", x, y, r: drill / 2, w: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, via: true });
  else {
    // blind/buried and micro vias show their layer pair in the hole: top-colour upper half, bottom-colour lower half
    G(item, { t: "arc", x, y, r: drill / 2, a0: Math.PI, a1: 2 * Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[0]), fill: pcbColor(pair[0]), layer: "holes", z: zh, pie: true, via: true });
    G(item, { t: "arc", x, y, r: drill / 2, a0: 0, a1: Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[1]), fill: pcbColor(pair[1]), layer: "holes", z: zh, pie: true, via: true });
  }
  item.viaType = vtype;
}
function buildZoneGeom(doc, item, n) {
  const single = kid(n, "layer"); const multi = kid(n, "layers");
  let layersZ = single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"];
  layersZ = padLayers(doc, layersZ);
  const keepout = !!kid(n, "keepout");
  const hatchN = kid(n, "hatch"); const hatchStyle = hatchN ? str(hatchN[1]) : "edge"; const pitch = hatchN ? num(hatchN[2], 0.5) : 0.5;
  for (const poly of kids(n, "polygon")) {
    const p = ptsOf(poly); if (p.length < 2) continue;
    for (const layer of layersZ) {
      const color = pcbColor(layer); const z = pcbZ(layer) + (keepout ? Z_TEXT : 0.5);
      G(item, { t: "poly", pts: p, close: true, w: 0, color, layer, z });
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
    G(item, { t: "poly", pts: p, close: true, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_ZONE, noStroke: true, zoneFill: true });
  }
}
/** SHAPE_POLY_SET::GenerateHatchLines for one outline: lines y = slope·x + a every `spacing`, clipped to the polygon. */
function hatchLines(pts, slope, spacing, lineLen) {
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
function graphicGeom(item, g, shape, tf, layer, z) {
  const w = widthOf(g, 0); const color = pcbColor(layer); z = z === undefined ? pcbZ(layer) : z;
  if (layer === "Edge.Cuts") item.edge = true;   // board outline: what "fit" and the board box mean
  const f = fillOf(g); const fillColor = f.type === "solid" ? color : null;
  if (shape === "line") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return; const a = tf(num(s[1]), num(s[2])), b = tf(num(e[1]), num(e[2]));
    G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  } else if (shape === "rect") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return;
    const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]);
    G(item, { t: "poly", pts: [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)], close: true, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 });
  } else if (shape === "circle") {
    const c = kid(g, "center"), e = kid(g, "end"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const r = e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : num((kid(g, "radius") || [])[1], 1);
    G(item, { t: "circle", x: cx, y: cy, r, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 });
  } else if (shape === "arc") {
    const s = kid(g, "start"), m = kid(g, "mid"), e = kid(g, "end"); if (!s || !m || !e) return;
    const a = arcFrom3(tf(num(s[1]), num(s[2])), tf(num(m[1]), num(m[2])), tf(num(e[1]), num(e[2])));
    if (a) G(item, Object.assign({ t: "arc", w, color, layer, z, cap: "round" }, a));
    else { const p0 = tf(num(s[1]), num(s[2])), p1 = tf(num(e[1]), num(e[2])); G(item, { t: "line", x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color, layer, z, cap: "round" }); }
  } else if (shape === "poly" || shape === "curve") {
    let p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    if (shape === "curve") p = bezierPts(p);
    G(item, { t: "poly", pts: p, close: shape === "poly", w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 });
  }
}
function buildTextBoxGeom(item, n, tf, layer, rotBase) {
  const ef = effectsOf(n); if (ef.hide) return;
  let pts = ptsOf(n).map(([x, y]) => tf(x, y));
  if (pts.length < 4) { const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]); pts = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)]; }
  const w = widthOf(n, 0); const color = pcbColor(layer); const z = pcbZ(layer);
  if (yesNo(n, "border") || w > 0) G(item, { t: "poly", pts, close: true, w, color, layer, z });
  const angN = kid(n, "angle"); const ang = angN ? num(angN[1]) : rotBase;
  const mg = kid(n, "margins"); const m = mg ? num(mg[1]) : w / 2 + ef.size * 0.75;
  const R = rotator(ang); const [dx, dy] = R(m, m);
  pcbTextGeom(item, n, pts[0][0] + dx, pts[0][1] + dy, str(n[1]), ang, layer, { defH: "left", defV: "top" });
}
function buildDimensionGeom(item, n) {
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
    let ext; if (ortho) ext = horiz ? [0, height] : [height, 0]; else { const d = [e[0] - s[0], e[1] - s[1]]; ext = height > 0 ? [-d[1], d[0]] : [d[1], -d[0]]; }
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
function buildFootprintGeom(doc, item) {
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
    pcbTextGeom(item, p, x, y, expand(text), pr, layer, { upright: !unlocked });
  };
  for (const p of kids(n, "property")) textAt(p, str(p[2]));
  for (let j = 2; j < n.length; j++) {
    const g = n[j]; if (!isList(g)) continue; const gk = g[0];
    if (gk === "fp_line" || gk === "fp_rect" || gk === "fp_circle" || gk === "fp_arc" || gk === "fp_poly" || gk === "fp_curve") {
      graphicGeom(item, g, gk.replace("fp_", ""), tf, layerOf(g, "F.SilkS"));
    } else if (gk === "fp_text") {
      textAt(g, str(g[2]));
    } else if (gk === "fp_text_box") {
      buildTextBoxGeom(item, g, tf, layerOf(g, "F.SilkS"), frot);
    } else if (gk === "pad") {
      buildPadGeom(item, g, tf, side, doc);
    } else if (gk === "zone") {
      const before = item.geom.length; buildZoneGeom(doc, item, g);
      for (let i = before; i < item.geom.length; i++) { const z = item.geom[i]; if (z.pts) z.pts = z.pts.map(([x, y]) => tf(x, y)); else if (z.t === "line") { const a = tf(z.x1, z.y1), b = tf(z.x2, z.y2); z.x1 = a[0]; z.y1 = a[1]; z.x2 = b[0]; z.y2 = b[1]; } }
    }
  }
  if (!item.bbox) bboxAdd(item, fx, fy, 1);
}
/** Outline polygon (local, unrotated) for chamfered / trapezoid pads. */
function padPolygon(pad, shape, w, h) {
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
function buildPadGeom(item, pad, tf, side, doc) {
  const number = str(pad[1]), type = str(pad[2]); let shape = str(pad[3]);
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
    for (let i = from; i < item.geom.length; i++) item.geom[i].pad = true;   // tagged for the outlinePads render option
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
    if (npth) G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: NPTH, fill: NPTH, layer: "holes", z: zh });
    else {
      // plated: hole in the background colour with a thin plating wall (LAYER_PAD_HOLEWALLS uses the via hole colour)
      G(item, { t: "pad", x: hx, y: hy, w: dw + 0.04, h: dh + 0.04, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh });
      G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: PCB_BG, fill: PCB_BG, layer: "holes", z: zh });
    }
  }
  // pad number + net name (PCB_PAINTER netname layer): sized to fit, drawn only when legible
  const netN = kid(pad, "net"); const netname = netN ? str(netN[2]) : "";
  if (number || netname) {
    let pw = w, ph = h; const rotated = pw < ph * 0.95; if (rotated) { const t = pw; pw = ph; ph = t; }
    let size = Math.min(ph, 2.5);   // MAX_FONT_SIZE
    const textLayer = copper || layers[0] || side; const z = pcbZ("holes") + 1; const rot = rotated ? 90 : 0;
    let yNet = 0, yNum = 0;
    if (number && netname) { size = size / 2.5; yNet = size / 1.4; yNum = size / 1.7; }
    if (netname) { let ts = Math.min(1.5 * pw / Math.max(netname.length + 1, 5), size) * 0.85; const [dx, dy] = rotPt(0, Math.min(ts * 1.4, yNet), rot); G(item, { t: "text", x: cx + dx, y: cy + dy, text: netname, size: ts, w: 0, color: PAD_TEXT, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, minPx: 7, noBox: true }); }
    if (number) { const ts = Math.min(1.5 * pw / Math.max(number.length, 3), size) * 0.85; const [dx, dy] = rotPt(0, -yNum, rot); G(item, { t: "text", x: cx + dx, y: cy + dy, text: number, size: ts, w: 0, color: PAD_TEXT, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, minPx: 7, noBox: true }); }
  }
}

// ---------------------------------------------------------------- ops
function fragmentItems(doc, sexpr) {
  const out = [];
  for (const tree of parseAll(sexpr)) {
    if (tree[0] === "kicad_sch" || tree[0] === "kicad_pcb") {
      const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s);
      for (const c of tree.slice(1)) if (isList(c) && (doc.type === "sch" ? SCH_KINDS.has(c[0]) : PCB_KINDS.has(c[0]))) out.push(c);
    } else if (tree[0] === "lib_symbols") { for (const s of kids(tree, "symbol")) doc.lib.set(str(s[1]), s); }
    else out.push(tree);
  }
  return out;
}
function setAt(node, x, y, rot) {
  const t = kid(node, "transform");
  if (t) {
    let tr = kid(t, "translate"); if (!tr) { tr = ["translate", 0, 0]; t.push(tr); }
    let ro = kid(t, "rotate"); if (!ro) { ro = ["rotate", 0]; t.push(ro); }
    if (x !== undefined) tr[1] = x; if (y !== undefined) tr[2] = y; if (rot !== undefined) ro[1] = rot;
    return;
  }
  let a = kid(node, "at");
  if (!a) { a = ["at", 0, 0]; node.splice(2, 0, a); }
  if (x !== undefined) a[1] = x; if (y !== undefined) a[2] = y;
  if (rot !== undefined) { if (a.length >= 4) a[3] = rot; else a.push(rot); }
}
/** Apply one wire-format change {id, kind, sexpr?, itemSexpr?, properties?} (IU per mm given). */
function applyChange(doc, change, IU) {
  const id = str(change.id), kind = str(change.kind).toUpperCase();
  if (kind === "REMOVED") return doc.items.delete(id);
  const frag = change.sexpr || change.itemSexpr;
  if (frag) {
    const nodes = fragmentItems(doc, frag);
    let applied = false;
    for (const node of nodes) {
      const nid = uuidOf(node) || id;
      if (nid !== id && nodes.length > 1) continue;
      if (!uuidOf(node)) node.push(["uuid", id]);
      doc.items.delete(nid);
      const it = addItem(doc, node); if (it) { applied = true; }
    }
    if (applied) return true;
  }
  const item = doc.items.get(id);
  if (!item) return false;
  if (kind === "MODIFIED" && Array.isArray(change.properties) && change.properties.length) {
    let nx, ny, nrot, changed = false;
    const p2 = ptsOf(item.node);
    for (const p of change.properties) {
      const after = p.after && p.after.v;
      if (after === undefined || after === null) continue;
      const v = Number(after);
      switch (p.name) {
      case "Position X": nx = v / IU; break;
      case "Position Y": ny = v / IU; break;
      case "Orientation": case "Rotation": nrot = v; break;
      case "Start X": if (p2[0]) { p2[0][0] = v / IU; changed = true; } break;
      case "Start Y": if (p2[0]) { p2[0][1] = v / IU; changed = true; } break;
      case "End X": if (p2[1]) { p2[1][0] = v / IU; changed = true; } break;
      case "End Y": if (p2[1]) { p2[1][1] = v / IU; changed = true; } break;
      case "Value": case "Reference": case "Text":
        if (doc.type === "sch" && item.kind === "symbol") { for (const pr of kids(item.node, "property")) if (str(pr[1]) === p.name) { pr[2] = String(after); changed = true; } }
        else if (typeof item.node[1] === "string") { item.node[1] = String(after); changed = true; }
        break;
      default: break;
      }
    }
    if (changed && p2.length) setPts(item.node, p2);
    if (nx !== undefined || ny !== undefined || nrot !== undefined) {
      const ox = item.x !== undefined ? item.x : atOf(item.node)[0], oy = item.y !== undefined ? item.y : atOf(item.node)[1];
      const dx = nx !== undefined ? nx - ox : 0, dy = ny !== undefined ? ny - oy : 0;
      setAt(item.node, nx, ny, nrot);
      if (doc.type === "sch" && item.kind === "symbol" && (dx || dy)) for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
      changed = true;
    }
    if (changed) { buildGeom(doc, item); return true; }
  }
  return false;
}
function setPts(node, pts) {
  let p = kid(node, "pts"); if (!p) { p = ["pts"]; node.splice(1, 0, p); }
  p.length = 1; for (const [x, y] of pts) p.push(["xy", +x.toFixed(4), +y.toFixed(4)]);
}

// ---------------------------------------------------------------- editing helpers (for the tools layer)
/** Move an item's anchor to (x, y) mm; symbols carry their fields along.  Returns the wire-format change. */
function moveItem(doc, item, x, y, IU) {
  const [ox, oy] = atOf(item.node);
  const dx = x - ox, dy = y - oy;
  if (doc.type === "sch" && (item.kind === "wire" || item.kind === "bus" || item.kind === "polyline")) {
    const p = ptsOf(item.node).map(([px, py]) => [px + dx, py + dy]); setPts(item.node, p); buildGeom(doc, item);
    return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) };
  }
  setAt(item.node, x, y);
  if (doc.type === "sch" && item.kind === "symbol") for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
  buildGeom(doc, item);
  return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), properties: [
    { name: "Position X", before: { type: "int", v: Math.round(ox * IU) }, after: { type: "int", v: Math.round(x * IU) } },
    { name: "Position Y", before: { type: "int", v: Math.round(oy * IU) }, after: { type: "int", v: Math.round(y * IU) } }] };
}
/** Whole-item replace change for an item whose node was edited in place. */
function replaceChange(doc, item) { buildGeom(doc, item); return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) }; }
function addChange(doc, item) { return { id: item.id, kind: "ADDED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) }; }
function removeChange(item) { return { id: item.id, kind: "REMOVED", typeName: typeNameOf(item), properties: [] }; }
const SCH_TYPE_NAMES = { symbol: "SCH_SYMBOL", wire: "SCH_LINE", bus: "SCH_LINE", polyline: "SCH_LINE", junction: "SCH_JUNCTION", label: "SCH_LABEL", global_label: "SCH_GLOBALLABEL", hierarchical_label: "SCH_HIERLABEL", no_connect: "SCH_NO_CONNECT", sheet: "SCH_SHEET", text: "SCH_TEXT", text_box: "SCH_TEXTBOX", bus_entry: "SCH_BUS_WIRE_ENTRY", rectangle: "SCH_SHAPE", circle: "SCH_SHAPE", arc: "SCH_SHAPE", netclass_flag: "SCH_DIRECTIVE_LABEL", directive_label: "SCH_DIRECTIVE_LABEL" };
const PCB_TYPE_NAMES = { footprint: "FOOTPRINT", segment: "PCB_TRACK", arc: "PCB_ARC", via: "PCB_VIA", zone: "ZONE", gr_line: "PCB_SHAPE", gr_rect: "PCB_SHAPE", gr_circle: "PCB_SHAPE", gr_arc: "PCB_SHAPE", gr_poly: "PCB_SHAPE", gr_text: "PCB_TEXT", gr_text_box: "PCB_TEXTBOX" };
function typeNameOf(item) { return (SCH_TYPE_NAMES[item.kind] || PCB_TYPE_NAMES[item.kind] || item.kind.toUpperCase()); }
/** Screen-space connection points of a symbol's pins (mm). */
function pinPoints(doc, item) {
  const out = [];
  if (item.kind !== "symbol") return out;
  const n = item.node; const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]); const lib = resolveLib(doc, libId) || resolveLib(doc, str((kid(n, "lib_id") || [])[1])); if (!lib) return out;
  const [ax, ay, rot] = atOf(n); const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1;
  const T = symbolTransform(rot, mirror);
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0; if (u !== 0 && u !== unit) continue;
    for (const g of kids(sub, "pin")) { const [px, py] = atOf(g); out.push({ x: ax + T[0] * px + T[1] * py, y: ay + T[2] * px + T[3] * py, number: str((kid(g, "number") || [])[1]), name: str((kid(g, "name") || [])[1]) }); }
  }
  return out;
}
/** Wires/buses with an endpoint within tol of (x, y): [{item, index}] */
function wireEndsAt(doc, x, y, tol) {
  const out = []; tol = tol || 0.01;
  for (const it of doc.items.values()) {
    if (it.kind !== "wire" && it.kind !== "bus") continue;
    const p = ptsOf(it.node);
    p.forEach((pt, i) => { if (Math.abs(pt[0] - x) <= tol && Math.abs(pt[1] - y) <= tol) out.push({ item: it, index: i }); });
  }
  return out;
}
function newUuid() { return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }); }
/** Build a fresh item node of a kind and add it to the document. */
function createItem(doc, node) { if (!uuidOf(node)) node.push(["uuid", newUuid()]); return addItem(doc, node); }


// ---------------------------------------------------------------- queries
function movableItems(doc) {
  const out = [];
  for (const it of doc.items.values()) {
    if (!it.movable) continue;
    out.push({ id: it.id, kind: it.kind, x: it.x, y: it.y, rot: it.rot || 0, ref: it.ref || "", value: it.value || "", lib: it.lib || "", layer: it.layer || "", bbox: it.bbox, name: it.name, file: it.file, w: it.w, h: it.h });
  }
  return out;
}
function hitTest(doc, x, y, slopMm) {
  let best = null, bestArea = Infinity; slopMm = slopMm || 0;
  for (const it of doc.items.values()) {
    if (!it.movable || !it.bbox) continue;
    const b = it.bbox;
    if (x < b[0] - slopMm || x > b[2] + slopMm || y < b[1] - slopMm || y > b[3] + slopMm) continue;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (area < bestArea) { best = it; bestArea = area; }
  }
  return best ? best.id : null;
}
function layerList(doc) {
  const counts = new Map();
  for (const it of doc.items.values()) for (const g of it.geom) counts.set(g.layer, (counts.get(g.layer) || 0) + 1);
  if (doc.type === "sch") return SCH_LAYERS.map(([name, color]) => ({ key: name, name, color, count: counts.get(name) || 0 })).filter((l) => l.count);
  const out = [];
  for (const [layer, count] of counts) if (layer !== "holes") out.push({ key: layer, name: layer, color: pcbColor(layer), count, z: pcbZ(layer) });
  out.sort((a, b) => b.z - a.z);
  return out;
}
function snap(v, pitch) { return pitch > 0 ? Math.round(v / pitch) * pitch : v; }

// ---------------------------------------------------------------- rendering
const HAS_PATH2D = typeof Path2D !== "undefined";
const FONT_FAMILY = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';
const FONT_EM = 1.4;   // cap height ≈ 0.72 em for these faces; KiCad's text size is the cap height
const FONT_CACHE = new Map();
/** Lazily built Path2D (mm units) for a geometry; rebuilt geometry objects start without one. */
function pathOf(g) {
  if (g._p) return g._p;
  if (!HAS_PATH2D) return null;
  const p = new Path2D(); tracePath(p, g); g._p = p; return p;
}
function tracePath(ctx, g) {
  if (g.t === "line") { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
  else if (g.t === "poly") { const pts = g.pts; ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (g.close) ctx.closePath(); }
  else if (g.t === "rect") ctx.rect(g.x, g.y, g.w, g.h);
  else if (g.t === "circle") ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
  else if (g.t === "arc") { if (g.pie) ctx.moveTo(g.x, g.y); ctx.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); if (g.pie) ctx.closePath(); }
  else if (g.t === "pad") tracePad(ctx, g);
}
function tracePad(ctx, g) {
  const c = Math.cos(-g.rot * Math.PI / 180), s = Math.sin(-g.rot * Math.PI / 180);
  const X = (x, y) => g.x + x * c - y * s, Y = (x, y) => g.y + x * s + y * c;
  const w = g.w, h = g.h;
  if (g.shape === "circle") { ctx.moveTo(X(w / 2, 0), Y(w / 2, 0)); ctx.arc(g.x, g.y, Math.max(w, h) / 2, 0, Math.PI * 2); return; }
  const r = g.shape === "oval" ? Math.min(w, h) / 2 : Math.min(g.rr || 0, w / 2, h / 2);
  if (r <= 0) { ctx.moveTo(X(-w / 2, -h / 2), Y(-w / 2, -h / 2)); ctx.lineTo(X(w / 2, -h / 2), Y(w / 2, -h / 2)); ctx.lineTo(X(w / 2, h / 2), Y(w / 2, h / 2)); ctx.lineTo(X(-w / 2, h / 2), Y(-w / 2, h / 2)); ctx.closePath(); return; }
  // rounded rectangle traced with arcs (works for ovals, roundrects and rotated pads alike)
  const a = -g.rot * Math.PI / 180; const hw = w / 2 - r, hh = h / 2 - r;
  ctx.moveTo(X(-hw, -h / 2), Y(-hw, -h / 2));
  ctx.lineTo(X(hw, -h / 2), Y(hw, -h / 2)); ctx.arc(X(hw, -hh), Y(hw, -hh), r, a - Math.PI / 2, a, false);
  ctx.lineTo(X(w / 2, hh), Y(w / 2, hh)); ctx.arc(X(hw, hh), Y(hw, hh), r, a, a + Math.PI / 2, false);
  ctx.lineTo(X(-hw, h / 2), Y(-hw, h / 2)); ctx.arc(X(-hw, hh), Y(-hw, hh), r, a + Math.PI / 2, a + Math.PI, false);
  ctx.lineTo(X(-w / 2, -hh), Y(-w / 2, -hh)); ctx.arc(X(-hw, -hh), Y(-hw, -hh), r, a + Math.PI, a + 3 * Math.PI / 2, false);
  ctx.closePath();
}
/**
 * view: { ppm (css px per mm at zoom 1), zoom, panX, panY (css px), x0, y0 (mm origin), dpr }
 * opts: { hidden: Set(layer keys), grid: pitch mm (0 = off), selected: Set(item ids) }
 *   plus KiCad's display options (all optional, default off):
 *   showHiddenPins (schematic) — draw the pins a library symbol marks hidden, with their names and
 *                                numbers, in the hidden-item grey (they are kept in item.hiddenGeom
 *                                so hit boxes stay as they were);
 *   zoneOutline    (board)     — zones as outlines with their hatch only, no copper fill;
 *   outlinePads, outlineTracks, outlineVias (board) — KiCad's sketch display modes: the pad shapes,
 *                                the track/arc stadium outlines and the via rings are stroked with a
 *                                hairline instead of filled;
 *   highContrast + activeLayer (board) — high-contrast mode: everything not on `activeLayer` is
 *                                dimmed to HC_DIM alpha (holes stay visible), the active layer is
 *                                drawn at full colour.
 */
const HC_DIM = 0.2;
function render(doc, ctx, view, opts) {
  opts = opts || {}; const hidden = opts.hidden || new Set();
  const isPcb = doc.type === "pcb";
  const showHiddenPins = !!opts.showHiddenPins && doc.type === "sch", zoneOutline = isPcb && !!opts.zoneOutline;
  const sketchPads = isPcb && !!opts.outlinePads, sketchTracks = isPcb && !!opts.outlineTracks, sketchVias = isPcb && !!opts.outlineVias;
  const hcLayer = isPcb && opts.highContrast && opts.activeLayer ? String(opts.activeLayer) : null;
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = view.dpr || 1;
  const s = view.ppm * view.zoom * dpr;                 // device px per mm
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = doc.type === "sch" ? SCH.bg : PCB_BG; ctx.fillRect(0, 0, W, H);
  const tx = view.panX * dpr - view.x0 * s, ty = view.panY * dpr - view.y0 * s;
  ctx.setTransform(s, 0, 0, s, tx, ty);
  const vx0 = -tx / s, vy0 = -ty / s, vx1 = vx0 + W / s, vy1 = vy0 + H / s;   // visible mm rect
  // grid (dots), thinned so dots stay >= 9 device px apart
  if (opts.grid > 0) {
    let pitch = opts.grid; const mult = [1, 2, 5, 10, 20, 50, 100];
    let m = 0; while (pitch * mult[m] * s < 9 && m < mult.length - 1) m++;
    pitch *= mult[m];
    const gx0 = Math.floor(vx0 / pitch) * pitch, gy0 = Math.floor(vy0 / pitch) * pitch;
    const nx = Math.ceil((vx1 - gx0) / pitch), ny = Math.ceil((vy1 - gy0) / pitch);
    if (nx * ny < 80000) {
      ctx.fillStyle = doc.type === "sch" ? SCH.grid : PCB_GRID; const d = Math.max(1, dpr) / s;
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) ctx.fillRect(gx0 + i * pitch - d / 2, gy0 + j * pitch - d / 2, d, d);
    }
  }
  // page frame for schematics
  if (doc.type === "sch") { ctx.strokeStyle = SCH.frame; ctx.lineWidth = Math.max(0.15, 1 / s); ctx.strokeRect(0, 0, doc.page[0], doc.page[1]); }
  // collect visible geometry
  const buckets = new Map();
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    for (const g of it.geom) {
      if (hidden.has(g.layer) || (zoneOutline && g.zoneFill)) continue;
      const z = g.z === undefined ? 0 : g.z;
      let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g);
    }
    if (showHiddenPins && it.hiddenGeom) for (const g of it.hiddenGeom) {
      if (hidden.has(g.layer)) continue;
      const z = g.z === undefined ? 0 : g.z;
      let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g);
    }
  }
  const zs = Array.from(buckets.keys()).sort((a, b) => a - b);
  const minW = Math.max(1, dpr) / s;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  let curStroke = null, curFill = null, curWidth = -1, curAlpha = -1, curCap = "round";
  const setStroke = (c) => { if (c !== curStroke) { ctx.strokeStyle = c; curStroke = c; } };
  const setFill = (c) => { if (c !== curFill) { ctx.fillStyle = c; curFill = c; } };
  const setWidth = (w) => { if (w !== curWidth) { ctx.lineWidth = w; curWidth = w; } };
  const setAlpha = (a) => { if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; } };
  const setCap = (c) => { if (c !== curCap) { ctx.lineCap = c; curCap = c; } };
  const strokeG = (g) => { const p = pathOf(g); if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); } };
  const fillG = (g) => { const p = pathOf(g); if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } };
  for (const z of zs) {
    for (const g of buckets.get(z)) {
      let alpha = g.alpha === undefined ? 1 : g.alpha;
      if (hcLayer && g.layer !== hcLayer && g.layer !== "holes") alpha *= HC_DIM;
      setAlpha(alpha);
      const t = g.t;
      if (t === "text") { drawText(ctx, g, s, doc.type, minW); curStroke = curFill = null; curWidth = -1; curCap = "round"; continue; }
      if ((sketchPads && g.pad) || (sketchVias && g.via)) {   // sketch mode: the shape's outline in a hairline, nothing filled
        if (t === "poly" && g.pts.length < 2) continue;
        setStroke(g.color); setWidth(minW); setCap("butt"); strokeG(g); continue;
      }
      if (sketchTracks && g.track) { setStroke(g.color); setWidth(minW); setCap("butt"); ctx.beginPath(); traceTrackOutline(ctx, g); ctx.stroke(); continue; }
      if (t === "rect") {
        if (g.fill) { setFill(g.fill); ctx.fillRect(g.x, g.y, g.w, g.h); }
        if (!g.noStroke) { setStroke(g.color); setWidth(Math.max(g.wd || 0, minW)); ctx.strokeRect(g.x, g.y, g.w, g.h); }
        continue;
      }
      if (t === "poly" && g.pts.length < 2) continue;
      if (g.fill) { setFill(g.fill); fillG(g); }
      if (g.noStroke) continue;
      if (t === "line" || t === "arc" || (t === "poly" && (g.w > 0 || !g.fill)) || (t === "circle" && (g.w > 0 || !g.fill)) || (t === "pad" && !g.fill)) {
        setStroke(g.color); setWidth(Math.max(g.w, minW)); setCap(g.cap || (t === "poly" || t === "line" ? "round" : "butt"));
        if (g.dash) ctx.setLineDash([0.4, 0.3]);
        strokeG(g);
        if (g.dash) ctx.setLineDash([]);
      }
    }
  }
  ctx.globalAlpha = 1;
  // selection: KiCad's selection shadow — a translucent halo around the item's own geometry
  if (opts.selected && opts.selected.size) drawSelectionHalo(ctx, doc, opts.selected, s, dpr, hidden);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
/** Outline of a track segment (stadium) or track arc (band with round caps) for the sketch display mode. */
function traceTrackOutline(ctx, g) {
  const hw = (g.w || 0) / 2;
  if (g.t === "line") {
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1, L = Math.hypot(dx, dy);
    if (L < 1e-9 || hw <= 0) { ctx.moveTo(g.x1 + hw, g.y1); ctx.arc(g.x1, g.y1, Math.max(hw, 1e-6), 0, Math.PI * 2); return; }
    const ang = Math.atan2(dy, dx), nx = -dy / L * hw, ny = dx / L * hw;
    ctx.moveTo(g.x1 + nx, g.y1 + ny); ctx.lineTo(g.x2 + nx, g.y2 + ny);
    ctx.arc(g.x2, g.y2, hw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.lineTo(g.x1 - nx, g.y1 - ny);
    ctx.arc(g.x1, g.y1, hw, ang - Math.PI / 2, ang + Math.PI / 2, true);
    ctx.closePath();
  } else if (g.t === "arc") {
    const acw = !!g.anticlockwise, p0 = [g.x + g.r * Math.cos(g.a0), g.y + g.r * Math.sin(g.a0)], p1 = [g.x + g.r * Math.cos(g.a1), g.y + g.r * Math.sin(g.a1)];
    ctx.moveTo(g.x + (g.r + hw) * Math.cos(g.a0), g.y + (g.r + hw) * Math.sin(g.a0));
    ctx.arc(g.x, g.y, g.r + hw, g.a0, g.a1, acw);
    ctx.arc(p1[0], p1[1], hw, g.a1, g.a1 + Math.PI, acw);
    if (g.r - hw > 1e-9) ctx.arc(g.x, g.y, g.r - hw, g.a1, g.a0, !acw); else ctx.lineTo(g.x, g.y);
    ctx.arc(p0[0], p0[1], hw, g.a0 + Math.PI, g.a0, acw);
    ctx.closePath();
  } else tracePath(ctx, g);
}
/** Draw KiCad's selection shadow around every geom of the given item ids (canvas must be in document space). */
function drawSelectionHalo(ctx, doc, ids, s, dpr, hidden) {
  const halo = "#66B2FF", minW = Math.max(1, dpr) / s, extra = 5 * dpr / s;
  ctx.save();
  ctx.globalAlpha = 0.55; ctx.strokeStyle = halo; ctx.fillStyle = halo; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    for (const g of it.geom) {
      if (hidden && hidden.has(g.layer)) continue;
      if (g.t === "text") {
        const w = typeof textWidth === "function" ? textWidth(g.text || "", g.size, g.w || 0.1524) : (g.text || "").length * g.size * 0.75;
        const h = g.size * 1.35;
        ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180); if (g.mirror) ctx.scale(-1, 1);
        const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2;
        ctx.fillRect(x0 - extra / 2, y0 - extra / 4, w + extra, h + extra / 2); ctx.restore();
        continue;
      }
      if (g.t === "rect") { ctx.lineWidth = Math.max(g.wd || 0, minW) + extra; ctx.strokeRect(g.x, g.y, g.w, g.h); continue; }
      if (g.t === "poly" && (!g.pts || g.pts.length < 2)) continue;
      ctx.lineWidth = Math.max(g.w || 0, minW) + extra;
      const p = pathOf(g);
      if (g.fill || g.t === "pad" || g.t === "circle") { if (p) ctx.fill(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.fill(); } }
      if (p) ctx.stroke(p); else { ctx.beginPath(); tracePath(ctx, g); ctx.stroke(); }
    }
  }
  ctx.restore();
}
/** One text run: KiCad's size is the cap height; the baseline sits size/2 below a "middle" anchor. */
function drawText(ctx, g, s, docType, minW) {
  const px = g.size * s; if (px < (g.minPx || 3)) return;
  ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180); if (g.mirror) ctx.scale(-1, 1);
  let font = FONT_CACHE.get(g.size); if (!font) { font = `${g.size * FONT_EM}px ${FONT_FAMILY}`; FONT_CACHE.set(g.size, font); }
  ctx.font = font;
  ctx.textAlign = g.h; ctx.textBaseline = "alphabetic";
  const base = g.v === "top" ? g.size : g.v === "bottom" ? 0 : g.size / 2;
  ctx.fillStyle = g.color;
  if (g.padText) { ctx.fillText(g.text, 0, base); ctx.restore(); return; }
  // stroke-font thickness beyond a filled face's own stem (~0.13·size) reads as bold
  const extra = g.w - 0.13 * g.size;
  if (extra > 0.01 && docType === "pcb") { ctx.lineWidth = extra; ctx.strokeStyle = g.color; ctx.lineJoin = "round"; ctx.strokeText(g.text, 0, base); }
  ctx.fillText(g.text, 0, base);
  if (g.bars && ctx.measureText) {
    // overbar: KiCad draws it 1.23·size above the baseline with the text pen
    const total = ctx.measureText(g.text).width; const shift = g.h === "center" ? -total / 2 : g.h === "right" ? -total : 0;
    const y = base - g.size * 1.23; ctx.lineWidth = Math.max(g.w || g.size / 8, minW); ctx.strokeStyle = g.color; ctx.beginPath();
    for (const [i0, i1] of g.bars) { const x0 = shift + ctx.measureText(g.text.slice(0, i0)).width, x1 = shift + ctx.measureText(g.text.slice(0, i1)).width; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }
  ctx.restore();
}
/** Put the canvas into document space (mm) for a given view — for tool overlays. */
function setViewTransform(ctx, view) {
  const dpr = view.dpr || 1, s = view.ppm * view.zoom * dpr;
  ctx.setTransform(s, 0, 0, s, view.panX * dpr - view.x0 * s, view.panY * dpr - view.y0 * s);
  return s;
}
function drawPad(ctx, g, minW) {
  ctx.beginPath(); tracePad(ctx, g);
  if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
  if (!g.fill || g.w === 0.1) { ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(0.05, minW); ctx.stroke(); }
}

function serialize(node) {
  if (!isList(node)) {
    if (typeof node === "number") return Number.isInteger(node) ? String(node) : String(+node.toFixed(6));
    const s = String(node);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '"' + s + '"';   // KiCad always quotes uuids
    return /^[A-Za-z_][\w.:*-]*$/.test(s) || /^[-+]?\d*\.?\d+$/.test(s) ? s : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  }
  return "(" + node.map(serialize).join(" ") + ")";
}
function serializeItem(doc, item) {
  // the desktop applier loads schematic fragments as a document, so wrap them
  if (doc.type === "sch") {
    const lib = item.kind === "symbol" ? doc.lib.get(str((kid(item.node, "lib_id") || [])[1])) : null;
    return "(kicad_sch (version 20250114) (generator \"kicad-collab-web\")" + (lib ? " (lib_symbols " + serialize(lib) + ")" : "") + " " + serialize(item.node) + ")";
  }
  return serialize(item.node);
}
root.KiCadCanvas = { parse, parseAll, serialize, serializeItem, parseDoc, setViewTransform, drawSelectionHalo, moveItem, replaceChange, addChange, removeChange, typeNameOf, pinPoints, wireEndsAt, newUuid, createItem, setPts, setAt, atOf, ptsOf, kid, kids, num, str, uuidOf, resolveLib, ORIENT, addItem, applyChange, render, movableItems, hitTest, layerList, snap, computeBBox, PCB_HIDDEN_DEFAULT, SCH, PCB_COLORS,
  // exposed for tests and tools
  symbolTransform, textWidth, parseMarkup, hatchLines, arcFrom3, bezierPts, pcbColor, pcbZ, drawPad, buildGeom, effectsOf, fillOf };
})(typeof window !== "undefined" ? window : globalThis);
