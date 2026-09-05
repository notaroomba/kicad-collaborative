// kicad-canvas.js — parse KiCad s-expression documents (schematic sheets and
// boards) and draw them on a 2D canvas, applying live collaboration ops per item.
//
// Coordinates are millimetres with Y down (KiCad's screen convention) for both
// document types; library symbol geometry (Y up) is mapped through KiCad's own
// orientation matrices.  Nothing here touches the DOM except the canvas context
// handed to render(), so the parser also runs under node for tests.
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
const isList = Array.isArray;
function kid(node, key) { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
function kids(node, key) { const out = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
function num(v, d = 0) { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }
function str(v) { return v === undefined || v === null ? "" : String(v); }
function has(node, tok) { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
function yesNo(node, key) { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key); }
function uuidOf(node) { const u = kid(node, "uuid") || kid(node, "tstamp"); return u ? str(u[1]) : ""; }
function atOf(node) { const a = kid(node, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0]; }
function ptsOf(node) { const p = kid(node, "pts"); return p ? kids(p, "xy").map((x) => [num(x[1]), num(x[2])]) : []; }
function widthOf(node, def) {
  const s = kid(node, "stroke"); const w = s && kid(s, "width"); if (w) return num(w[1], def);
  const w2 = kid(node, "width"); return w2 ? num(w2[1], def) : def;
}
function fillOf(node) { const f = kid(node, "fill"); if (!f) return "none"; const t = kid(f, "type"); if (t) return str(t[1]); return has(f, "yes") ? "solid" : "none"; }
function effectsOf(node) {
  const e = kid(node, "effects");
  const r = { size: 1.27, thick: 0, hide: false, just: [], mirror: false };
  if (e) {
    const f = kid(e, "font");
    if (f) { const s = kid(f, "size"); if (s) r.size = num(s[2], num(s[1], 1.27)); const t = kid(f, "thickness"); if (t) r.thick = num(t[1]); }
    const j = kid(e, "justify"); if (j) { r.just = j.slice(1).map(str); if (r.just.includes("mirror")) r.mirror = true; }
    if (has(e, "hide")) r.hide = true; const h = kid(e, "hide"); if (h && str(h[1]) === "yes") r.hide = true;
  }
  if (has(node, "hide")) r.hide = true; const h2 = kid(node, "hide"); if (h2 && str(h2[1]) === "yes") r.hide = true;
  return r;
}
function justOf(just) {
  const h = just.includes("left") ? "left" : just.includes("right") ? "right" : "center";
  const v = just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "middle";
  return { h, v };
}
function arcFrom3(p0, pm, p1) {
  // centre of the circle through three points; null when collinear
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
  // choose the sweep direction that passes through the mid point
  const norm = (a) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = norm(a1 - a0), ccwMid = norm(am - a0);
  const ccw = ccwMid <= ccwSweep;   // canvas "anticlockwise" flag is false for increasing angles
  return { x: ux, y: uy, r, a0, a1, anticlockwise: !ccw };
}

// ---------------------------------------------------------------- colours
const SCH = {
  bg: "#F5F4EF", grid: "#B5B5B5", wire: "#009600", bus: "#0000C2", junction: "#009600", outline: "#840000",
  body: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", ref: "#006464", value: "#006464",
  field: "#840084", label: "#0F0F0F", glabel: "#840000", hlabel: "#725600", sheet: "#840000", sheetName: "#006464",
  sheetFile: "#725600", sheetFields: "#840084", sheetLabel: "#006464", noconnect: "#000084", notes: "#0000C2",
  busEntry: "#0000C2", dnp: "#DC090D",
};
const SCH_LAYERS = [
  ["Wires", SCH.wire], ["Buses", SCH.bus], ["Junctions", SCH.junction], ["Symbols", SCH.outline], ["Pins", SCH.pin],
  ["Pin names", SCH.pinName], ["Pin numbers", SCH.pinNum], ["Reference & value", SCH.ref], ["Fields", SCH.field],
  ["Labels", SCH.label], ["Sheets", SCH.sheet], ["Notes", SCH.notes], ["No-connects", SCH.noconnect],
];
const PCB_COLORS = {
  "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "In1.Cu": "#7FC87F", "In2.Cu": "#CE7D2C", "In3.Cu": "#4FCBCB", "In4.Cu": "#DB628B",
  "In5.Cu": "#A7A5C6", "In6.Cu": "#28CCD9", "In7.Cu": "#E8B2A7", "In8.Cu": "#F2EDA1", "In9.Cu": "#8DCB81", "In10.Cu": "#ED7C33",
  "In11.Cu": "#5BC3EB", "In12.Cu": "#F76F8E", "In13.Cu": "#4D7FC4", "In14.Cu": "#C83434",
  "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Mask": "#D864FF", "B.Mask": "#02FFEE", "F.Paste": "#B4B4B4", "B.Paste": "#00C2C2",
  "F.Adhes": "#A7A5C6", "B.Adhes": "#8B4FC5", "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2", "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF",
  "F.Fab": "#AFAFAF", "B.Fab": "#585D84", "Dwgs.User": "#C2C200", "Cmts.User": "#5C5CFF", "Eco1.User": "#5DB2A2", "Eco2.User": "#B2B22A",
};
const PCB_BG = "#001023", PCB_GRID = "#848484", VIA = "#ECECEC", HOLE = "#212121", PAD_TEXT = "#FFFFFF";
const PCB_HIDDEN_DEFAULT = new Set(["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Margin", "Eco1.User", "Eco2.User"]);
function pcbColor(layer) { if (PCB_COLORS[layer]) return PCB_COLORS[layer]; if (/^User\.\d+$/.test(layer)) return "#C2C2C2"; if (/\.Cu$/.test(layer)) return "#7FC87F"; return "#C2C2C2"; }
function pcbZ(layer) {
  if (layer === "B.Cu") return 10; if (/^In\d+\.Cu$/.test(layer)) return 12; if (layer === "F.Cu") return 20;
  if (layer === "B.Adhes" || layer === "B.Paste") return 22; if (layer === "F.Adhes" || layer === "F.Paste") return 23;
  if (layer === "B.SilkS") return 30; if (layer === "F.SilkS") return 31; if (layer === "B.Mask") return 32; if (layer === "F.Mask") return 33;
  if (layer === "B.Fab") return 40; if (layer === "F.Fab") return 41; if (layer === "B.CrtYd") return 42; if (layer === "F.CrtYd") return 43;
  if (layer === "Edge.Cuts") return 50; return 45;
}

// ---------------------------------------------------------------- documents
function newDoc(type) { return { type, items: new Map(), lib: new Map(), page: [297, 210], layers: new Map(), bbox: null }; }
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
    else if (type === "pcb" && k === "layers") { for (const l of node.slice(1)) if (isList(l)) doc.layers.set(str(l[2]), { id: num(l[0]), type: str(l[3]) }); }
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
  const item = { id, kind: k, node, geom: [], bbox: null, movable: false };
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
function G(item, g) { item.geom.push(g); if (g.t === "line") { bboxAdd(item, g.x1, g.y1, g.w / 2); bboxAdd(item, g.x2, g.y2, g.w / 2); }
  else if (g.t === "poly") for (const p of g.pts) bboxAdd(item, p[0], p[1], g.w / 2);
  else if (g.t === "circle") { bboxAdd(item, g.x - g.r, g.y - g.r); bboxAdd(item, g.x + g.r, g.y + g.r); }
  else if (g.t === "arc") { bboxAdd(item, g.x - g.r, g.y - g.r); bboxAdd(item, g.x + g.r, g.y + g.r); }
  else if (g.t === "rect") { bboxAdd(item, g.x, g.y); bboxAdd(item, g.x + g.w, g.y + g.h); }
  else if (g.t === "text") bboxAdd(item, g.x, g.y, g.size * 0.6);
  return g; }

function buildGeom(doc, item) {
  item.geom = []; item.bbox = null;
  if (doc.type === "sch") buildSchGeom(doc, item); else buildPcbGeom(doc, item);
}

// ---- schematic ----
const ORIENT = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
function resolveLib(doc, name, depth) {
  const s = doc.lib.get(name); if (!s) return null;
  const ext = kid(s, "extends");
  if (ext && (depth || 0) < 4) {
    const parent = resolveLib(doc, name.split(":")[0] + ":" + str(ext[1]), (depth || 0) + 1) || resolveLib(doc, str(ext[1]), (depth || 0) + 1);
    if (parent) { const merged = s.slice(); for (const c of parent.slice(1)) if (isList(c) && (c[0] === "symbol" || c[0] === "pin_names" || c[0] === "pin_numbers")) merged.push(c); return merged; }
  }
  return s;
}
function textGeom(item, x, y, text, size, color, rot, just, layer, extra) {
  const j = justOf(just || []);
  return G(item, Object.assign({ t: "text", x, y, text, size: size || 1.27, w: 0, color, rot: rot || 0, h: j.h, v: j.v, layer }, extra || {}));
}
function buildSchGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "wire" || k === "bus" || k === "polyline") {
    const p = ptsOf(n); const isBus = k === "bus";
    const w = widthOf(n, 0) || (isBus ? 0.3048 : k === "polyline" ? 0.1524 : 0.1524);
    G(item, { t: "poly", pts: p, close: false, w, color: isBus ? SCH.bus : k === "polyline" ? SCH.notes : SCH.wire, layer: isBus ? "Buses" : k === "polyline" ? "Notes" : "Wires" });
  } else if (k === "bus_entry") {
    const [x, y] = atOf(n); const s = kid(n, "size"); const dx = s ? num(s[1]) : 2.54, dy = s ? num(s[2]) : 2.54;
    G(item, { t: "line", x1: x, y1: y, x2: x + dx, y2: y + dy, w: widthOf(n, 0) || 0.1524, color: SCH.busEntry, layer: "Buses" });
  } else if (k === "junction") {
    const [x, y] = atOf(n); const d = kid(n, "diameter"); const r = (d && num(d[1]) > 0 ? num(d[1]) : 0.9144) / 2;
    G(item, { t: "circle", x, y, r, w: 0, color: SCH.junction, fill: SCH.junction, layer: "Junctions" });
  } else if (k === "no_connect") {
    const [x, y] = atOf(n); const s = 0.635;
    G(item, { t: "line", x1: x - s, y1: y - s, x2: x + s, y2: y + s, w: 0.1524, color: SCH.noconnect, layer: "No-connects" });
    G(item, { t: "line", x1: x - s, y1: y + s, x2: x + s, y2: y - s, w: 0.1524, color: SCH.noconnect, layer: "No-connects" });
  } else if (k === "label" || k === "global_label" || k === "hierarchical_label" || k === "netclass_flag" || k === "directive_label") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n); const text = str(n[1]);
    const color = k === "label" ? SCH.label : k === "global_label" ? SCH.glabel : SCH.hlabel;
    const just = ef.just.length ? ef.just : ["left", "bottom"];
    if (k === "label") textGeom(item, x, y, text, ef.size, color, rot, just, "Labels");
    else {
      // outline around the text, pointing along the label's direction
      const len = text.length * ef.size * 0.75 + ef.size * 1.2, h = ef.size * 1.4;
      const dir = ((rot % 360) + 360) % 360;
      const pts = [[0, -h / 2], [len, -h / 2], [len + h / 2, 0], [len, h / 2], [0, h / 2]];
      const rad = dir * Math.PI / 180;
      const tp = pts.map(([px, py]) => [x + px * Math.cos(rad) - py * Math.sin(rad), y - (px * Math.sin(rad) + py * Math.cos(rad))]);
      if (k !== "netclass_flag" && k !== "directive_label") G(item, { t: "poly", pts: tp, close: true, w: 0.1524, color, layer: "Labels" });
      textGeom(item, x + Math.cos(rad) * ef.size * 0.4, y - Math.sin(rad) * ef.size * 0.4, text, ef.size, color, dir === 180 ? 0 : dir === 270 ? 90 : dir, dir === 180 ? ["right"] : dir === 270 ? ["right"] : ["left"], "Labels");
    }
  } else if (k === "text") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n);
    const lines = str(n[1]).split("\n");
    lines.forEach((ln, i) => textGeom(item, x, y + i * ef.size * 1.5, ln, ef.size, SCH.notes, rot, ef.just.length ? ef.just : ["left", "bottom"], "Notes"));
  } else if (k === "text_box") {
    const [x, y, rot] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 10, h = s ? num(s[2]) : 5; const ef = effectsOf(n);
    G(item, { t: "rect", x, y, w, h, wd: widthOf(n, 0) || 0.1524, color: SCH.notes, fill: null, layer: "Notes" });
    str(n[1]).split("\n").forEach((ln, i) => textGeom(item, x + 0.5, y + 0.5 + i * ef.size * 1.5, ln, ef.size, SCH.notes, 0, ["left", "top"], "Notes"));
  } else if (k === "rectangle") {
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return;
    const f = fillOf(n);
    G(item, { t: "rect", x: Math.min(num(s[1]), num(e[1])), y: Math.min(num(s[2]), num(e[2])), w: Math.abs(num(e[1]) - num(s[1])), h: Math.abs(num(e[2]) - num(s[2])), wd: widthOf(n, 0) || 0.1524, color: SCH.notes, fill: f === "none" ? null : SCH.notes, alpha: f === "none" ? 1 : 0.15, layer: "Notes" });
  } else if (k === "circle") {
    const c = kid(n, "center"), r = kid(n, "radius"); if (!c) return;
    G(item, { t: "circle", x: num(c[1]), y: num(c[2]), r: r ? num(r[1]) : 1, w: widthOf(n, 0) || 0.1524, color: SCH.notes, fill: null, layer: "Notes" });
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return;
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) G(item, Object.assign({ t: "arc", w: widthOf(n, 0) || 0.1524, color: SCH.notes, layer: "Notes" }, a));
  } else if (k === "sheet") {
    const [x, y] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 20, h = s ? num(s[2]) : 20;
    G(item, { t: "rect", x, y, w, h, wd: widthOf(n, 0) || 0.1524, color: SCH.sheet, fill: "#FFFFFF", alpha: 0.35, layer: "Sheets" });
    item.movable = true; item.x = x; item.y = y; item.w = w; item.h = h; item.rot = 0;
    for (const p of kids(n, "property")) {
      const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p); if (ef.hide || !val) continue;
      const [px, py, pr] = atOf(p);
      const color = name === "Sheetname" ? SCH.sheetName : name === "Sheetfile" ? SCH.sheetFile : SCH.sheetFields;
      if (name === "Sheetname") item.name = val; if (name === "Sheetfile") item.file = val;
      textGeom(item, px, py, (name === "Sheetfile" ? "File: " : "") + val, ef.size, color, pr, ef.just.length ? ef.just : ["left", "bottom"], "Sheets");
    }
    for (const pin of kids(n, "pin")) {
      const [px, py, pr] = atOf(pin); const ef = effectsOf(pin);
      G(item, { t: "rect", x: px - 0.6, y: py - 0.6, w: 1.2, h: 1.2, wd: 0.1524, color: SCH.sheetLabel, fill: null, layer: "Sheets" });
      const dir = ((pr % 360) + 360) % 360;
      textGeom(item, px + (dir === 0 ? -1 : dir === 180 ? 1 : 0), py, str(pin[1]), ef.size, SCH.sheetLabel, dir === 90 || dir === 270 ? 90 : 0, dir === 0 ? ["right"] : dir === 180 ? ["left"] : ["center"], "Sheets");
    }
  } else if (k === "symbol") {
    buildSymbolGeom(doc, item);
  }
}
function buildSymbolGeom(doc, item) {
  const n = item.node;
  const libId = str((kid(n, "lib_id") || [])[1]);
  const [ax, ay, rot] = atOf(n);
  const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1;
  const styleN = kid(n, "body_style") || kid(n, "convert"); const style = styleN ? num(styleN[1], 1) : 1;
  const dnp = yesNo(n, "dnp");
  let T = ORIENT[((Math.round(rot) % 360) + 360) % 360] || ORIENT[0];
  if (mirror === "y") T = [-T[0], -T[1], T[2], T[3]];
  if (mirror === "x") T = [T[0], T[1], -T[2], -T[3]];
  const tf = (lx, ly) => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  item.movable = true; item.x = ax; item.y = ay; item.rot = rot; item.lib = libId; item.unit = unit;
  const lib = resolveLib(doc, libId);
  const bodyLayer = "Symbols";
  if (lib) {
    const pn = kid(lib, "pin_names"); const nameOff = pn && kid(pn, "offset") ? num(kid(pn, "offset")[1]) : 0.508;
    const hideNames = !!(pn && (has(pn, "hide") || (kid(pn, "hide") && str(kid(pn, "hide")[1]) === "yes")));
    const pnu = kid(lib, "pin_numbers"); const hideNums = !!(pnu && (has(pnu, "hide") || (kid(pnu, "hide") && str(kid(pnu, "hide")[1]) === "yes")));
    const subs = kids(lib, "symbol");
    for (const sub of subs) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || s !== style) continue;
      for (let j = 2; j < sub.length; j++) {
        const g = sub[j]; if (!isList(g)) continue;
        const gk = g[0]; const f = fillOf(g); const fillColor = f === "background" ? SCH.body : f === "outline" ? SCH.outline : null;
        const w = widthOf(g, 0) || 0.1524;
        if (gk === "rectangle") {
          const s0 = kid(g, "start"), e0 = kid(g, "end"); if (!s0 || !e0) continue;
          const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]);
          G(item, { t: "poly", pts: [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)], close: true, w, color: SCH.outline, fill: fillColor, layer: bodyLayer });
        } else if (gk === "polyline" || gk === "bezier") {
          const p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) continue;
          G(item, { t: "poly", pts: p, close: !!fillColor, w, color: SCH.outline, fill: fillColor, layer: bodyLayer });
        } else if (gk === "circle") {
          const c = kid(g, "center"), r = kid(g, "radius"); if (!c) continue; const [cx, cy] = tf(num(c[1]), num(c[2]));
          G(item, { t: "circle", x: cx, y: cy, r: r ? num(r[1]) : 1, w, color: SCH.outline, fill: fillColor, layer: bodyLayer });
        } else if (gk === "arc") {
          const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !m0 || !e0) continue;
          const a = arcFrom3(tf(num(s0[1]), num(s0[2])), tf(num(m0[1]), num(m0[2])), tf(num(e0[1]), num(e0[2])));
          if (a) G(item, Object.assign({ t: "arc", w, color: SCH.outline, layer: bodyLayer }, a));
        } else if (gk === "text") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g); if (ef.hide) continue; const [px, py] = tf(tx, ty);
          textGeom(item, px, py, str(g[1]), ef.size, SCH.outline, (tr + rot) % 360, ef.just, "Symbols");
        } else if (gk === "pin") {
          const [px, py, pr] = atOf(g); const lenN = kid(g, "length"); const len = lenN ? num(lenN[1]) : 2.54;
          const hidden = has(g, "hide") || (kid(g, "hide") && str(kid(g, "hide")[1]) === "yes");
          if (hidden) continue;
          const dir = ((Math.round(pr) % 360) + 360) % 360;
          const d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
          const ex = px + d[0] * len, ey = py + d[1] * len;
          const a = tf(px, py), b = tf(ex, ey);
          G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 0.1524, color: SCH.pin, layer: "Pins" });
          // pin electrical type marker for unconnected ends is a KiCad ERC thing; skip.
          const nameN = kid(g, "name"), numN = kid(g, "number");
          const nameEf = nameN ? effectsOf(nameN) : { size: 1.27, hide: false }, numEf = numN ? effectsOf(numN) : { size: 1.27, hide: false };
          const pinName = nameN ? str(nameN[1]) : "", pinNum = numN ? str(numN[1]) : "";
          // screen-space direction of the pin (from connection point into the body)
          const sd = [b[0] - a[0], b[1] - a[1]]; const sl = Math.hypot(sd[0], sd[1]) || 1; sd[0] /= sl; sd[1] /= sl;
          const horizontal = Math.abs(sd[0]) > Math.abs(sd[1]);
          if (!hideNums && pinNum && !numEf.hide) {
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
            const off = numEf.size * 0.5 + 0.2;
            const ox = horizontal ? 0 : -off, oy = horizontal ? -off : 0;
            textGeom(item, mx + ox, my + oy, pinNum, numEf.size, SCH.pinNum, horizontal ? 0 : 90, ["center", "middle"], "Pin numbers");
          }
          if (!hideNames && pinName && pinName !== "~" && !nameEf.hide) {
            const nx = b[0] + sd[0] * nameOff, ny = b[1] + sd[1] * nameOff;
            let just;
            if (horizontal) just = sd[0] > 0 ? ["left", "middle"] : ["right", "middle"];
            else just = sd[1] > 0 ? ["right", "middle"] : ["left", "middle"];   // rotated 90: reading direction along -y
            textGeom(item, nx, ny, pinName, nameEf.size, SCH.pinName, horizontal ? 0 : 90, just, "Pin names");
          }
          bboxAdd(item, a[0], a[1]); bboxAdd(item, b[0], b[1]);
        }
      }
    }
  } else {
    G(item, { t: "rect", x: ax - 2.54, y: ay - 2.54, w: 5.08, h: 5.08, wd: 0.1524, color: SCH.outline, fill: null, layer: bodyLayer });
  }
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Reference") item.ref = val; if (name === "Value") item.value = val;
    if (ef.hide || !val || name === "Footprint" && ef.hide) continue;
    if (name.startsWith("ki_")) continue;
    const [px, py, pr] = atOf(p);
    const color = name === "Reference" || name === "Value" ? SCH.ref : SCH.field;
    textGeom(item, px, py, val, ef.size, color, pr, ef.just, name === "Reference" || name === "Value" ? "Reference & value" : "Fields");
  }
  if (dnp) {
    const b = item.bbox; if (b) { G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 0.3, color: SCH.dnp, layer: "Symbols" }); G(item, { t: "line", x1: b[0], y1: b[3], x2: b[2], y2: b[1], w: 0.3, color: SCH.dnp, layer: "Symbols" }); }
  }
  if (!item.bbox) bboxAdd(item, ax, ay, 2.54);
}

// ---- board ----
function rotator(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; }
function layerOf(node, def) { const l = kid(node, "layer"); return l ? str(l[1]) : def; }
function padCopperLayer(pad) {
  const ls = kid(pad, "layers"); const names = ls ? ls.slice(1).map(str) : [];
  if (names.some((x) => x === "F.Cu" || x === "*.Cu" || x === "F&B.Cu")) return "F.Cu";
  if (names.some((x) => x === "B.Cu")) return "B.Cu";
  const inner = names.find((x) => /\.Cu$/.test(x)); return inner || null;
}
function buildPcbGeom(doc, item) {
  const n = item.node, k = item.kind;
  if (k === "segment") {
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const layer = layerOf(n, "F.Cu");
    G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round" });
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return; const layer = layerOf(n, "F.Cu");
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) G(item, Object.assign({ t: "arc", w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round" }, a));
  } else if (k === "via") {
    const [x, y] = atOf(n); const sz = kid(n, "size"), dr = kid(n, "drill");
    G(item, { t: "circle", x, y, r: (sz ? num(sz[1]) : 0.8) / 2, w: 0, color: VIA, fill: VIA, layer: "F.Cu", z: 25 });
    G(item, { t: "circle", x, y, r: (dr ? num(dr[1]) : 0.4) / 2, w: 0, color: HOLE, fill: HOLE, layer: "F.Cu", z: 60 });
  } else if (k === "zone") {
    const single = kid(n, "layer"); const multi = kid(n, "layers");
    const layersZ = single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"];
    const keepout = !!kid(n, "keepout");
    for (const poly of kids(n, "polygon")) {
      const p = ptsOf(poly); if (p.length < 2) continue;
      for (const layer of layersZ) G(item, { t: "poly", pts: p, close: true, w: 0.05, color: keepout ? "#FF0000" : pcbColor(layer), layer, z: pcbZ(layer) - 6, dash: true });
    }
    for (const fp of kids(n, "filled_polygon")) {
      const layer = layerOf(fp, layersZ[0]); const p = ptsOf(fp); if (p.length < 3) continue;
      G(item, { t: "poly", pts: p, close: true, w: 0, color: pcbColor(layer), fill: pcbColor(layer), alpha: 0.45, layer, z: pcbZ(layer) - 5 });
    }
  } else if (k === "gr_line" || k === "gr_rect" || k === "gr_circle" || k === "gr_arc" || k === "gr_poly" || k === "gr_curve") {
    graphicGeom(item, n, k.replace("gr_", ""), (x, y) => [x, y], layerOf(n, "Dwgs.User"));
  } else if (k === "gr_text" || k === "gr_text_box") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n); const layer = layerOf(n, "Dwgs.User"); if (ef.hide) return;
    str(n[1]).split("\n").forEach((ln, i) => textGeom(item, x, y + i * ef.size * 1.5, ln, ef.size, pcbColor(layer), rot, ef.just, layer, { z: pcbZ(layer) + 1, w: ef.thick, mirror: ef.mirror || /^B\./.test(layer) }));
  } else if (k === "footprint") {
    buildFootprintGeom(doc, item);
  }
}
function graphicGeom(item, g, shape, tf, layer, z) {
  const w = widthOf(g, 0.12); const color = pcbColor(layer); z = z === undefined ? pcbZ(layer) : z;
  if (layer === "Edge.Cuts") item.edge = true;   // board outline: what "fit" and the board box mean
  const f = fillOf(g); const fillColor = f === "solid" || f === "yes" ? color : null;
  if (shape === "line") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return; const a = tf(num(s[1]), num(s[2])), b = tf(num(e[1]), num(e[2]));
    G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  } else if (shape === "rect") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return;
    const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]);
    G(item, { t: "poly", pts: [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)], close: true, w, color, fill: fillColor, layer, z });
  } else if (shape === "circle") {
    const c = kid(g, "center"), e = kid(g, "end"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const r = e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : num((kid(g, "radius") || [])[1], 1);
    G(item, { t: "circle", x: cx, y: cy, r, w, color, fill: fillColor, layer, z });
  } else if (shape === "arc") {
    const s = kid(g, "start"), m = kid(g, "mid"), e = kid(g, "end"); if (!s || !m || !e) return;
    const a = arcFrom3(tf(num(s[1]), num(s[2])), tf(num(m[1]), num(m[2])), tf(num(e[1]), num(e[2])));
    if (a) G(item, Object.assign({ t: "arc", w, color, layer, z, cap: "round" }, a));
  } else if (shape === "poly" || shape === "curve") {
    const p = ptsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    G(item, { t: "poly", pts: p, close: true, w, color, fill: fillColor, layer, z });
  }
}
function buildFootprintGeom(doc, item) {
  const n = item.node;
  const [fx, fy, frot] = atOf(n); const side = layerOf(n, "F.Cu"); const R = rotator(frot);
  const tf = (lx, ly) => { const [x, y] = R(lx, ly); return [fx + x, fy + y]; };
  item.movable = true; item.x = fx; item.y = fy; item.rot = frot; item.layer = side; item.lib = str(n[1]);
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]);
    if (name === "Reference") item.ref = val; if (name === "Value") item.value = val;
    if (!isList(kid(p, "at"))) continue;
    const ef = effectsOf(p); if (ef.hide || !val) continue;
    const [px, py, pr] = atOf(p); const layer = layerOf(p, side === "B.Cu" ? "B.SilkS" : "F.SilkS"); const [x, y] = tf(px, py);
    textGeom(item, x, y, val, ef.size, pcbColor(layer), pr + frot, ef.just, layer, { z: pcbZ(layer) + 1, w: ef.thick, mirror: ef.mirror || /^B\./.test(layer) });
  }
  for (let j = 2; j < n.length; j++) {
    const g = n[j]; if (!isList(g)) continue; const gk = g[0];
    if (gk === "fp_line" || gk === "fp_rect" || gk === "fp_circle" || gk === "fp_arc" || gk === "fp_poly" || gk === "fp_curve") {
      graphicGeom(item, g, gk.replace("fp_", ""), tf, layerOf(g, "F.SilkS"));
    } else if (gk === "fp_text") {
      const [px, py, pr] = atOf(g); const ef = effectsOf(g); if (ef.hide) continue; const layer = layerOf(g, "F.SilkS"); const [x, y] = tf(px, py);
      textGeom(item, x, y, str(g[2]), ef.size, pcbColor(layer), pr + frot, ef.just, layer, { z: pcbZ(layer) + 1, w: ef.thick, mirror: ef.mirror || /^B\./.test(layer) });
    } else if (gk === "pad") {
      buildPadGeom(item, g, tf, side);
    }
  }
  if (!item.bbox) bboxAdd(item, fx, fy, 1);
}
function buildPadGeom(item, pad, tf, side) {
  const number = str(pad[1]), type = str(pad[2]), shape = str(pad[3]);
  const [px, py, prot] = atOf(pad); const sz = kid(pad, "size"); const w = sz ? num(sz[1]) : 1, h = sz ? num(sz[2], num(sz[1])) : 1;
  const [cx, cy] = tf(px, py);
  const copper = padCopperLayer(pad);
  const color = type === "np_thru_hole" ? "#7A7A7A" : pcbColor(copper || (side === "B.Cu" ? "B.Cu" : "F.Cu"));
  const z = copper ? pcbZ(copper) + 2 : 24;
  const rrN = kid(pad, "roundrect_rratio"); const rr = rrN ? num(rrN[1]) : (shape === "roundrect" ? 0.25 : 0);
  const geom = { t: "pad", x: cx, y: cy, w, h, rot: prot, shape, rr: rr * Math.min(w, h), color, fill: color, layer: copper || side, z, cap: "round" };
  if (shape === "custom") {
    const prims = kid(pad, "primitives");
    if (prims) {
      const Rp = rotator(prot);
      const ptf = (lx, ly) => { const [x, y] = Rp(lx, ly); return [cx + x, cy + y]; };
      for (const pr of prims.slice(1)) if (isList(pr)) graphicGeom(item, pr, pr[0].replace("gr_", ""), ptf, copper || side, z);
      geom.shape = str((kid(pad, "options") && kid(kid(pad, "options"), "anchor") || [])[1]) === "circle" ? "circle" : "rect";
    } else geom.shape = "rect";
  }
  if (type !== "np_thru_hole") G(item, geom); else G(item, Object.assign({}, geom, { fill: null, w: 0.1 }));
  bboxAdd(item, cx, cy, Math.max(w, h) / 2);
  const dr = kid(pad, "drill");
  if (dr) {
    const oval = str(dr[1]) === "oval"; const dw = oval ? num(dr[2]) : num(dr[1]), dh = oval ? num(dr[3], dw) : dw;
    const off = kid(dr, "offset"); let hx = cx, hy = cy;
    if (off) { const [ox, oy] = rotator(prot)(num(off[1]), num(off[2])); hx += ox; hy += oy; }
    if (dw > 0) G(item, { t: "pad", x: hx, y: hy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: HOLE, fill: HOLE, layer: "holes", z: 60 });
  }
  if (number) G(item, { t: "text", x: cx, y: cy, text: number, size: Math.min(w, h) * 0.55, w: 0, color: PAD_TEXT, rot: 0, h: "center", v: "middle", layer: copper || side, z: 61, padText: true, minPx: 7 });
}

// ---------------------------------------------------------------- ops
function fragmentItems(doc, sexpr) {
  const tree = parse(sexpr); if (!tree) return [];
  if (tree[0] === "kicad_sch" || tree[0] === "kicad_pcb") {
    const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s);
    return tree.slice(1).filter((c) => isList(c) && (doc.type === "sch" ? SCH_KINDS.has(c[0]) : PCB_KINDS.has(c[0])));
  }
  if (tree[0] === "lib_symbols") { for (const s of kids(tree, "symbol")) doc.lib.set(str(s[1]), s); return []; }
  return [tree];
}
function setAt(node, x, y, rot) {
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
    let nx, ny, nrot;
    for (const p of change.properties) {
      const after = p.after && p.after.v;
      if (after === undefined || after === null) continue;
      if (p.name === "Position X") nx = Number(after) / IU;
      else if (p.name === "Position Y") ny = Number(after) / IU;
      else if (p.name === "Orientation" || p.name === "Rotation") nrot = Number(after);
    }
    if (nx !== undefined || ny !== undefined || nrot !== undefined) {
      const ox = item.x || 0, oy = item.y || 0;
      const dx = nx !== undefined ? nx - ox : 0, dy = ny !== undefined ? ny - oy : 0;
      setAt(item.node, nx, ny, nrot);
      if (doc.type === "sch" && item.kind === "symbol" && (dx || dy)) for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
      buildGeom(doc, item);
      return true;
    }
  }
  return false;
}

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
/**
 * view: { ppm (css px per mm at zoom 1), zoom, panX, panY (css px), x0, y0 (mm origin), dpr }
 * opts: { hidden: Set(layer keys), grid: pitch mm (0 = off), selected: Set(item ids) }
 */
function render(doc, ctx, view, opts) {
  opts = opts || {}; const hidden = opts.hidden || new Set();
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
  if (doc.type === "sch") { ctx.strokeStyle = "#840000"; ctx.lineWidth = Math.max(0.15, 1 / s); ctx.strokeRect(0, 0, doc.page[0], doc.page[1]); }
  // collect visible geometry
  const buckets = new Map();
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    for (const g of it.geom) {
      if (hidden.has(g.layer)) continue;
      const z = g.z === undefined ? 0 : g.z;
      let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g);
    }
  }
  const zs = Array.from(buckets.keys()).sort((a, b) => a - b);
  const minW = Math.max(1, dpr) / s;
  ctx.lineJoin = "round";
  for (const z of zs) {
    for (const g of buckets.get(z)) {
      ctx.globalAlpha = g.alpha === undefined ? 1 : g.alpha;
      if (g.t === "line") {
        ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(g.w, minW); ctx.lineCap = g.cap || "butt";
        ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
      } else if (g.t === "poly") {
        if (g.pts.length < 2) continue;
        ctx.beginPath(); ctx.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) ctx.closePath();
        if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
        if (g.w > 0 || !g.fill) { ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(g.w, minW); ctx.lineCap = "round"; if (g.dash) ctx.setLineDash([0.4, 0.3]); ctx.stroke(); if (g.dash) ctx.setLineDash([]); }
      } else if (g.t === "rect") {
        if (g.fill) { ctx.fillStyle = g.fill; ctx.fillRect(g.x, g.y, g.w, g.h); }
        ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(g.wd || 0, minW); ctx.globalAlpha = 1; ctx.strokeRect(g.x, g.y, g.w, g.h);
      } else if (g.t === "circle") {
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
        if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
        if (g.w > 0 || !g.fill) { ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(g.w, minW); ctx.stroke(); }
      } else if (g.t === "arc") {
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise);
        ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(g.w, minW); ctx.lineCap = g.cap || "butt"; ctx.stroke();
      } else if (g.t === "pad") {
        drawPad(ctx, g, minW);
      } else if (g.t === "text") {
        const px = g.size * s; if (px < (g.minPx || 2.5)) continue;
        ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180); if (g.mirror) ctx.scale(-1, 1);
        ctx.font = `${g.size * 0.92}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = g.h; ctx.textBaseline = g.v === "top" ? "top" : g.v === "bottom" ? "alphabetic" : "middle";
        if (g.padText) { ctx.fillStyle = g.color; ctx.globalAlpha = 0.85; ctx.fillText(g.text, 0, 0); }
        else if (g.w > 0.02 && doc.type === "pcb") { ctx.lineWidth = g.w; ctx.strokeStyle = g.color; ctx.lineJoin = "round"; ctx.strokeText(g.text, 0, 0); ctx.fillStyle = g.color; ctx.fillText(g.text, 0, 0); }
        else { ctx.fillStyle = g.color; ctx.fillText(g.text, 0, 0); }
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
  // selection
  if (opts.selected && opts.selected.size) {
    ctx.strokeStyle = "#FFB43A"; ctx.lineWidth = 2 * dpr / s; ctx.setLineDash([6 * dpr / s, 4 * dpr / s]);
    for (const id of opts.selected) { const it = doc.items.get(id); if (!it || !it.bbox) continue; const b = it.bbox; ctx.strokeRect(b[0] - 0.3, b[1] - 0.3, b[2] - b[0] + 0.6, b[3] - b[1] + 0.6); }
    ctx.setLineDash([]);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function drawPad(ctx, g, minW) {
  ctx.save(); ctx.translate(g.x, g.y); if (g.rot) ctx.rotate(-g.rot * Math.PI / 180);
  const w = g.w, h = g.h; ctx.beginPath();
  if (g.shape === "circle") ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2);
  else if (g.shape === "oval") { const r = Math.min(w, h) / 2; if (w >= h) { ctx.moveTo(-w / 2 + r, -h / 2); ctx.lineTo(w / 2 - r, -h / 2); ctx.arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(-w / 2 + r, h / 2); ctx.arc(-w / 2 + r, 0, r, Math.PI / 2, 3 * Math.PI / 2); } else { ctx.moveTo(w / 2, -h / 2 + r); ctx.lineTo(w / 2, h / 2 - r); ctx.arc(0, h / 2 - r, r, 0, Math.PI); ctx.lineTo(-w / 2, -h / 2 + r); ctx.arc(0, -h / 2 + r, r, Math.PI, 2 * Math.PI); } ctx.closePath(); }
  else if (g.rr > 0 && typeof ctx.roundRect === "function") ctx.roundRect(-w / 2, -h / 2, w, h, g.rr);
  else ctx.rect(-w / 2, -h / 2, w, h);
  if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(); }
  if (!g.fill || g.w === 0.1) { ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(0.05, minW); ctx.stroke(); }
  ctx.restore();
}

root.KiCadCanvas = { parse, parseDoc, addItem, applyChange, render, movableItems, hitTest, layerList, snap, computeBBox, PCB_HIDDEN_DEFAULT, SCH, PCB_COLORS };
})(typeof window !== "undefined" ? window : globalThis);
