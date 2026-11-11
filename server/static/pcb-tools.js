// pcb-tools.js — board editing tools for the web editor, mirroring pcbnew's
// interactions: route (X) with KiCad's 45° posture, via (V), active layer
// (PgUp/PgDn), rotate (R) / flip (F) of the selected footprint, selection and
// delete of tracks, vias and graphics, expand to the connected run (U), drag a
// segment (D), width cycling (W), graphic line/rect/circle/arc/polygon/bezier
// (Shift+L/R/C, Ctrl+Shift+A/P/B), text (T), text boxes, tables, reference
// images, copper zones (Alt+Z) and rule areas (Ctrl+Shift+K), the five
// dimension tools (orthogonal on Ctrl+Shift+H) and KiCad's interactive delete
// tool.  The non-tool commands of pcbnew live in pcb.actions: clipboard
// (Ctrl+C/X/V/D, KiCad's own kicad_pcb clipboard format), move exactly,
// position relative, align / distribute, group rotate / flip / mirror / swap,
// swap layers, track width / via edits, cleanup tracks & vias, select net /
// connection / unconnected, groups, locks, conversions, the DRC subset, the
// ratsnest and the net inspector, with pad hit-testing and a pad dialog.
//
// Registers on window.CollabTools.pcb.  The geometry and node builders touch no
// DOM and are exported as PcbTools on the global so the node test can drive
// them against a parsed board.  Every node is built the way
// pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp writes the item (child order
// included) with the defaults pcbnew's drawing tool gives a new item.
(function (root) {
"use strict";

let K = root.KiCadCanvas;                 // re-bound from ctx.K on every hook
const WIDTHS = [0.2, 0.25, 0.3, 0.5, 0.8, 1.0];
const HL = "#FFB43A", VIA = "#ECECEC", DEL = "#FF5C5C";
const RATSNEST = "rgba(0, 248, 255, 0.35)";   // LAYER_RATSNEST (builtin_color_themes.h)
// the router's preview colours: the ratsnest Brightened(0.8) with alpha + 0.4 for the routed net, Brightened(0.5) for
// the leading line from the head (DisplayRatline), and DARKDARKGRAY clearance halos
const RATSNEST_BRIGHT = "rgba(204, 250, 255, 0.95)", RATSNEST_LEAD = "rgba(128, 252, 255, 0.95)", HALO_COLOR = "rgb(72, 72, 72)";
/** COLOR4D::Saturate(1.0): the same hue and value at full saturation (the head trace colour). */
function saturated(col) {
  let r, g, b; const m = /^#([0-9a-f]{6})/i.exec(col), q = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(col);
  if (m) { const v = parseInt(m[1], 16); r = v >> 16; g = (v >> 8) & 255; b = v & 255; } else if (q) { r = +q[1]; g = +q[2]; b = +q[3]; } else return col;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return `rgb(${r}, ${g}, ${b})`;
  const f = (x) => Math.round(max * (x - min) / (max - min));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}
// KiCad's delete cursor: a small bin with a crosshair hotspot
const DELETE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 8h12M8 2v12M4 8h8M8 4v8" stroke="#fff" stroke-width="3"/><path d="M2 8h12M8 2v12" stroke="#000" stroke-width="1.2"/><path d="M14 10h8l-1 12h-6zM13 8h10M17 6h2v2h-2z" fill="#fff" stroke="#c00" stroke-width="1.2"/></svg>') + '") 8 8, crosshair';
const SNAP_MM = 0.5, HIT_MM = 0.2, DBL_MS = 400;
// The desktop applier only parses kicad_pcb documents (a bare item takes the
// legacy-format branches), so every fragment travels wrapped.  The version is
// the one boards from this build carry — it must never exceed the desktop's.
const BOARD_VERSION = 20260728;

const S = {
  layer: "F.Cu", gfxLayer: "F.Cu",   // graphics, text and dimensions are drawn on the active layer, as DRAWING_TOOL does
  sel: new Set(), padSel: null, route: null,   // padSel: a pad picked on its own, "footprintId#padIndex" (PCB_SELECTION_TOOL selects PCB_PAD_T)
  drag: null, draw: null, hover: null, text: null, modTool: null, doc: null,
  image: null,                            // the picked reference image riding the cursor: { base64, info, w, h, name }
  client: null,                           // last pointer position in client px, where prompts open
  markers: [],                            // the last DRC run's markers [{ x, y, severity, text, ids, code }]
  showRatsnest: true, localRatsnest: false, hiddenNets: new Set(), rats: null, ratsDirty: true,   // ratsnest display (KiCad shows it by default)
  settings: null, settingsSrc: null, settingsCache: null, highlightNet: null,
  docVer: 0, rworld: null, nlc: null, violations: null,   // the router's caches (per document change) and the obstacles shown in violation
};
let lastCtx = null, domReady = false;

// ---------------------------------------------------------------- small helpers
const isList = Array.isArray;
const r6 = (v) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };   // no -0 in files
const norm360 = (a) => ((a % 360) + 360) % 360;
const norm180 = (a) => { const v = norm360(a); return v > 180 ? v - 360 : v; };   // KiCad's footprint range
const clone = (n) => K.cloneNode(n);   // not JSON: that drops the reader's record of which atoms were quoted
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
function rotator(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; }
const flipLayerName = (l) => /^F\./.test(l) ? "B." + l.slice(2) : /^B\./.test(l) ? "F." + l.slice(2) : l;
const sideSpecific = (l) => /^[FB]\./.test(l);
const otherSide = (l) => l === "F.Cu" ? "B.Cu" : "F.Cu";
const layerOf = (node, def) => { const l = K.kid(node, "layer"); return l ? K.str(l[1]) : (def || "F.Cu"); };
const pt = (node, key) => { const k = K.kid(node, key); return k ? [K.num(k[1]), K.num(k[2])] : null; };
const widthOf = (node, def) => { const w = K.kid(node, "width"); return w ? K.num(w[1], def) : def; };
const color = (layer) => (K.PCB_COLORS && K.PCB_COLORS[layer]) || (/\.Cu$/.test(layer) ? "#7FC87F" : "#C2C2C2");
const fmt = (v) => String(+v.toFixed(3));
// BOARD_DESIGN_SETTINGS::GetLayerClass and the class defaults pcbnew gives a new item on the layer:
// line width, text size and text thickness (board_design_settings.h DEFAULT_*).
const layerClass = (l) => /^[FB]\.SilkS$/.test(l) ? "silk" : /\.Cu$/.test(l) ? "copper" : l === "Edge.Cuts" ? "edges" : /^[FB]\.CrtYd$/.test(l) ? "courtyard" : /^[FB]\.Fab$/.test(l) ? "fab" : "others";
const LINE_W = { silk: 0.1, copper: 0.2, edges: 0.05, courtyard: 0.05, fab: 0.1, others: 0.1 };
const TEXT_STYLE = { silk: [1, 0.1], copper: [1.5, 0.3], edges: [1, 0.15], courtyard: [1, 0.15], fab: [1, 0.15], others: [1, 0.15] };
/** Take the project's per-layer-class defaults (board.design_settings.defaults) for new graphics and text. */
function layerDefaults(d) {
  for (const [cls, stem] of [["silk", "silk"], ["copper", "copper"], ["edges", "board_outline"], ["courtyard", "courtyard"], ["fab", "fab"], ["others", "other"]]) {
    const w = d[stem + "_line_width"]; if (typeof w === "number" && w > 0) LINE_W[cls] = w;
    const sz = d[stem + "_text_size_h"], th = d[stem + "_text_thickness"]; if (typeof sz === "number" && sz > 0) TEXT_STYLE[cls] = [sz, typeof th === "number" && th > 0 ? th : TEXT_STYLE[cls][1]];
  }
}
const textStyle = (layer) => { const [size, thick] = TEXT_STYLE[layerClass(layer)]; return { size, thick }; };
const isBack = (l) => /^B\./.test(l);
const xy = (p) => ["xy", r6(p[0]), r6(p[1])];
const corners = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1]], vadd = (a, b) => [a[0] + b[0], a[1] + b[1]], vmul = (a, k) => [a[0] * k, a[1] * k];
const vunit = (v) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : [0, 0]; };

// ---------------------------------------------------------------- nets
// Boards from this build reference nets by name — (net "GND") — while older
// ones carry (net 3 "GND") on pads and (net 3) on tracks; both are understood
// and new items are written in the document's own style.
function netOf(node) {
  const n = node && K.kid(node, "net"); if (!n) return { code: 0, name: "" };
  if (typeof n[1] === "number") return { code: n[1], name: n.length > 2 ? K.str(n[2]) : "" };
  return { code: -1, name: K.str(n[1]) };
}
const NET_STYLE = new WeakMap();
function netStyle(doc) {
  if (NET_STYLE.has(doc)) return NET_STYLE.get(doc);
  let style = null;
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kid(it.node, "pad") : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && K.kid(probe, "net"); if (!n) continue;
    style = typeof n[1] === "number" ? "code" : "name"; break;
  }
  if (!style) return "name";   // nothing on a net yet: this build's own form, and not remembered, so the first netted item decides
  NET_STYLE.set(doc, style); return style;
}
function netNode(doc, net) { return netStyle(doc) === "name" ? ["net", net && net.name ? net.name : ""] : ["net", net && net.code > 0 ? net.code : 0]; }
const hasNet = (n) => !!(n && (n.name || n.code > 0));
const sameNet = (a, b) => hasNet(a) && hasNet(b) && (a.name && b.name ? a.name === b.name : a.code === b.code);

// ---------------------------------------------------------------- node builders (KiCad board file shapes)
function segmentNode(doc, a, b, width, layer, net) {
  return ["segment", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], ["width", r6(width)], ["layer", layer], netNode(doc, net)];
}
function viaNode(doc, x, y, size, drill, net, layers) {
  return ["via", ["at", r6(x), r6(y)], ["size", r6(size)], ["drill", r6(drill)], ["layers"].concat(layers || ["F.Cu", "B.Cu"]), netNode(doc, net)];
}
const gfxWidth = (layer) => LINE_W[layerClass(layer)];
const strokeNode = (w) => ["stroke", ["width", r6(w)], ["type", "default"]];
function lineNode(a, b, layer) { return ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
function rectNode(a, b, layer) { return ["gr_rect", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
function circleNode(c, e, layer) { return ["gr_circle", ["center", r6(c[0]), r6(c[1])], ["end", r6(e[0]), r6(e[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
// PCB_IO_KICAD_SEXPR::format(PCB_SHAPE): start/mid/end, stroke, (fill only for closed shapes), layer, then the uuid
function arcNode(a, m, b, layer) { return ["gr_arc", ["start", r6(a[0]), r6(a[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
function polyNode(pts, layer) { return ["gr_poly", ["pts", ...pts.map((p) => ["xy", r6(p[0]), r6(p[1])])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
// DRAWING_TOOL::PlaceText: the layer class's size and thickness, left / bottom justified, mirrored on the back;
// PCB_IO_KICAD_SEXPR::format(PCB_TEXT) writes the text, (at), (layer), (uuid) and then the effects.
function textNode(text, x, y, layer) {
  return ["gr_text", text, ["at", r6(x), r6(y), 0], ["layer", layer], ["uuid", K.newUuid()], effectsNode(layer, ["left", "bottom"])];
}
/** EDA_TEXT::Format for a new item on a layer: the class's size and thickness, a justification, mirrored on the back. */
function effectsNode(layer, just) {
  const { size, thick } = textStyle(layer); const eff = ["effects", ["font", ["size", size, size], ["thickness", thick]]];
  const j = (just || []).slice(); if (isBack(layer)) j.push("mirror"); if (j.length) eff.push(["justify", ...j]);
  return eff;
}
// SHAPE_T::BEZIER: (gr_curve (pts start c1 c2 end) …)
function curveNode(pts, layer) { return ["gr_curve", ["pts", ...pts.map(xy)], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
// PCB_TEXTBOX as DRAWING_TOOL::DrawRectangle leaves it: the constructor's margins (half the default line width plus
// three quarters of the default 1.27 text size), the layer class's text, left/top, a border in the layer's line width.
// The uuid sits between the layer and the effects in the writer, so it is minted here.
const TEXTBOX_MARGIN = 1.0025;
function textBoxNode(text, a, b, layer) {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["gr_text_box", text, ["start", r6(x0), r6(y0)], ["end", r6(x1), r6(y1)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN],
    ["layer", layer], ["uuid", K.newUuid()], effectsNode(layer, ["left", "top"]), ["border", "yes"], strokeNode(gfxWidth(layer)), ["knockout", "no"]];
}
// DRAWING_TOOL::DrawTable sizes the grid from the dragged rectangle: one column per 15 text sizes, one row per 3, cells
// at least 5 × 3 text sizes and rounded to the grid.  The web asks for the counts and shares the rectangle out.
function tableCounts(a, b, layer) {
  const [x0, y0, x1, y1] = corners(a, b); const { size } = textStyle(layer);
  return { rows: Math.max(1, Math.floor((y1 - y0) / (size * 3))), cols: Math.max(1, Math.floor((x1 - x0) / (size * 15))) };
}
function tableLayout(a, b, rows, cols, layer, grid) {
  const [x0, y0, x1, y1] = corners(a, b); const { size } = textStyle(layer);
  let cw = Math.max(size * 5, (x1 - x0) / cols), ch = Math.max(size * 3, (y1 - y0) / rows);
  if (grid > 0) { cw = Math.max(grid, Math.round(cw / grid) * grid); ch = Math.max(grid, Math.round(ch / grid) * grid); }
  return { x: x0, y: y0, cw: r6(cw), ch: r6(ch), rows, cols };
}
// PCB_TABLE with PCB_TABLECELLs as the drawing tool creates them: borders and separators in the layer's line width,
// every cell empty with the text box constructor's margins and EDA_TEXT's own 1.27 size (auto thickness), left / middle.
function tableNode(a, b, rows, cols, layer, grid) {
  const L = tableLayout(a, b, rows, cols, layer, grid); const w = gfxWidth(layer); const cells = ["cells"];
  const just = ["justify", "left"]; if (isBack(layer)) just.push("mirror");
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = r6(L.x + c * L.cw), y = r6(L.y + r * L.ch);
    cells.push(["table_cell", "", ["start", x, y], ["end", r6(x + L.cw), r6(y + L.ch)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN], ["span", 1, 1],
      ["layer", layer], ["uuid", K.newUuid()], ["effects", ["font", ["size", 1.27, 1.27]], just.slice()], ["knockout", "no"]]);
  }
  return ["table", ["column_count", cols], ["uuid", K.newUuid()], ["layer", layer],
    ["border", ["external", "yes"], ["header", "yes"], strokeNode(w)], ["separators", ["rows", "yes"], ["cols", "yes"], strokeNode(w)],
    ["column_widths", ...Array(cols).fill(L.cw)], ["row_heights", ...Array(rows).fill(L.ch)], cells];
}
// PCB_REFERENCE_IMAGE: anchored at its centre, the file's own bytes as base64 in KICAD_FORMAT::FormatStreamData's
// 76-column rows.  (scale) is only written when it differs from 1, so a fresh image carries none.
function imageNode(x, y, base64, layer) {
  const data = ["data"]; for (let i = 0; i < base64.length; i += 76) data.push(base64.slice(i, i + 76));
  return ["image", ["at", r6(x), r6(y)], ["layer", layer], data];
}
// ZONE_SETTINGS defaults (zones.h): edge hatch 0.5, clearance 0.5, min thickness 0.25, thermal gap / spoke 0.5, islands
// always removed.  A new zone travels unfilled (no "yes" on fill) — every client refills for itself.
const zoneFillNode = () => ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5], ["island_removal_mode", 0]];
const zoneLayers = (node) => { const l = K.kid(node, "layer"); if (l) return [K.str(l[1])]; const ls = K.kid(node, "layers"); return ls ? ls.slice(1).map(K.str) : []; };
/** ZONE_CREATE_HELPER::setUniquePriority: the lowest priority no copper zone on the board uses yet. */
function zonePriority(doc) {
  const used = new Set();
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || K.kid(it.node, "keepout") || K.kid(it.node, "attr") || !zoneLayers(it.node).some((l) => /\.Cu$/.test(l))) continue;
    const p = K.kid(it.node, "priority"); used.add(p ? K.num(p[1]) : 0);
  }
  let p = 0; while (used.has(p)) p++; return p;
}
function zoneNode(doc, pts, layer, net) {
  const node = ["zone"]; const nn = netNode(doc, net); if (nn[1]) node.push(nn);   // (net …) only for a real net
  node.push(["layer", layer], ["uuid", K.newUuid()], ["hatch", "edge", 0.5]);
  const prio = zonePriority(doc); if (prio > 0) node.push(["priority", prio]);
  node.push(["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25], zoneFillNode(), ["polygon", ["pts", ...pts.map(xy)]]);
  return node;
}
// A rule area with ZONE_SETTINGS' default keepouts: tracks, vias and pads out; copper pours and footprints allowed.
function ruleAreaNode(pts, layers) {
  return ["zone", layers.length > 1 ? ["layers", ...layers] : ["layer", layers[0]], ["uuid", K.newUuid()], ["hatch", "edge", 0.5],
    ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25],
    ["keepout", ["tracks", "not_allowed"], ["vias", "not_allowed"], ["pads", "not_allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
    ["placement", ["enabled", "no"], ["sheetname", ""]], zoneFillNode(), ["polygon", ["pts", ...pts.map(xy)]]];
}

// ---------------------------------------------------------------- dimensions (pcb_dimension.cpp)
const DIM_CLASS = { aligned: "PCB_DIM_ALIGNED", orthogonal: "PCB_DIM_ORTHOGONAL", center: "PCB_DIM_CENTER", radial: "PCB_DIM_RADIAL", leader: "PCB_DIM_LEADER" };
const DIM_TYPE = { dimaligned: "aligned", dimortho: "orthogonal", dimcenter: "center", dimradial: "radial", leader: "leader" };
const ARROW_LEN = 1.27, EXT_OFFSET = 0.5;                      // 50 mil arrows, DEFAULT_DIMENSION_EXTENSION_OFFSET
const EXT_HEIGHT = 0.58642;                                    // int(arrow length × sin 27.5°) in nm, PCB_DIM_ALIGNED's constructor
const angleOf = (v) => (v[0] === 0 && v[1] === 0) ? 0 : Math.atan2(v[1], v[0]) * 180 / Math.PI;   // EDA_ANGLE(vector) on screen axes
/** The angle KiCad gives text kept aligned to a direction: 360 − angle, normalised, then turned into the readable half. */
function readableAngle(v) { let a = norm360(-angleOf(v)); if (a > 90 && a <= 270) a -= 180; return a; }
/** PCB_DIMENSION_BASE::GetValueText: mm, precision 4, zeroes suppressed, on a value rounded to nanometres. */
function dimValueText(mm) {
  let s = (Math.round(mm * 1e6) / 1e6).toFixed(4);
  while (s.endsWith("0")) { s = s.slice(0, -1); if (s.endsWith(".")) { s = s.slice(0, -1); break; } }
  return s;
}
/** GetVectorSnapped45: the nearest of the 0 / 45 / 90° directions, staying on the grid. */
function snap45(v) {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]);
  if (ax > ay * 2) return [v[0], 0]; if (ay > ax * 2) return [0, v[1]];
  return ax > ay ? [v[0], Math.sign(v[1]) * ax] : [Math.sign(v[0]) * ay, v[1]];
}
/**
 * Lines, arrows and text of a dimension: PCB_DIM_*::updateGeometry() / updateText() for the OUTSIDE text mode with
 * the text kept aligned.  d = { start, end, height, orientation ("h" | "v"), textPos, text }.  Arrows are [point, angle].
 */
function dimGeometry(type, d, layer) {
  const s = d.start, e = d.end; const { size, thick } = textStyle(layer); const lines = [], arrows = [];
  let text = "", tpos = s.slice(), tang = 0;
  if (type === "aligned" || type === "orthogonal") {
    const h = d.height || 0, dim = vsub(e, s), horiz = d.orientation !== "v"; let ext, cs, ce, value;
    if (type === "aligned") { ext = vunit(h > 0 ? [-dim[1], dim[0]] : [dim[1], -dim[0]]); cs = vadd(s, vmul(ext, Math.abs(h))); ce = vadd(e, vmul(ext, Math.abs(h))); value = Math.hypot(dim[0], dim[1]); }
    else { const sg = h < 0 ? -1 : 1; ext = horiz ? [0, sg] : [sg, 0]; cs = horiz ? [s[0], s[1] + h] : [s[0] + h, s[1]]; ce = horiz ? [e[0], cs[1]] : [cs[0], e[1]]; value = Math.abs(horiz ? dim[0] : dim[1]); }
    const extLen = Math.abs(h) - EXT_OFFSET + EXT_HEIGHT;
    lines.push([vadd(s, vmul(ext, EXT_OFFSET)), vadd(s, vmul(ext, EXT_OFFSET + extLen))]);
    if (type === "aligned") lines.push([vadd(e, vmul(ext, EXT_OFFSET)), vadd(e, vmul(ext, EXT_OFFSET + extLen))]);
    else { const e2 = vsub(e, ce), l2 = Math.hypot(e2[0], e2[1]), u2 = vunit(e2); const st = vsub(ce, vmul(u2, EXT_HEIGHT)); lines.push([st, vadd(st, vmul(u2, l2 - EXT_OFFSET + EXT_HEIGHT))]); }
    lines.push([cs, ce]);
    const cb = vsub(ce, cs), cbAng = angleOf(cb); arrows.push([cs, cbAng], [ce, cbAng + 180]);
    const cc = vmul(cb, 0.5), off = thick + size;   // GetEffectiveTextPenWidth() + GetTextHeight() off the crossbar
    if (type === "aligned") { const rot = cc[0] === 0 ? 90 * Math.sign(-cc[1]) : cc[0] < 0 ? -90 : 90; const to = rotator(rot)(cc[0], cc[1]); tpos = vadd(cs, vadd(cc, vmul(vunit(to), off))); tang = readableAngle(cc); }
    else { tpos = vadd(cs, vadd(cc, horiz ? [0, -off] : [-off, 0])); tang = Math.abs(cc[0]) > Math.abs(cc[1]) ? 0 : 90; }
    text = dimValueText(value);
  } else if (type === "radial") {
    lines.push([vsub(s, [0, ARROW_LEN]), vadd(s, [0, ARROW_LEN])], [vsub(s, [ARROW_LEN, 0]), vadd(s, [ARROW_LEN, 0])]);
    const radial = vmul(vunit(vsub(e, s)), ARROW_LEN * 3), knee = vadd(e, radial);   // leader length = 3 arrow lengths
    tpos = d.textPos ? d.textPos.slice() : vadd(knee, [e[0] < s[0] ? -ARROW_LEN * 10 : ARROW_LEN * 10, 0]);   // the drawing tool's first placement
    lines.push([e, knee], [knee, tpos]); arrows.push([e, angleOf(radial)]);
    tang = Math.round(readableAngle(vsub(tpos, knee))); text = "R " + dimValueText(Math.hypot(e[0] - s[0], e[1] - s[1]));
  } else if (type === "leader") {
    const st = vadd(s, vmul(vunit(vsub(e, s)), EXT_OFFSET));
    tpos = d.textPos ? d.textPos.slice() : vadd(e, [e[0] < s[0] ? -ARROW_LEN * 10 : ARROW_LEN * 10, 0]);
    lines.push([st, e], [e, tpos]); arrows.push([st, angleOf(vsub(e, s))]); text = d.text || "";
  } else {   // center: an arm through the centre and the same arm turned by 90°
    const arm = vsub(e, s), arm2 = [-arm[1], arm[0]]; lines.push([vsub(s, arm), vadd(s, arm)], [vsub(s, arm2), vadd(s, arm2)]);
  }
  return { lines, arrows, text, tpos, tang, size, thick };
}
/** (dimension …) as PCB_IO_KICAD_SEXPR::format writes it: the type's children in the writer's order, the text last. */
function dimensionNode(type, d, layer) {
  const uuid = K.newUuid(); const g = dimGeometry(type, d, layer); const measuring = type !== "center" && type !== "leader";
  const node = ["dimension", ["type", type], ["layer", layer], ["uuid", uuid], ["pts", xy(d.start), xy(d.end)]];
  if (type === "aligned" || type === "orthogonal") node.push(["height", r6(d.height || 0)]);
  if (type === "radial") node.push(["leader_length", r6(ARROW_LEN * 3)]);
  if (type === "orthogonal") node.push(["orientation", d.orientation === "v" ? 1 : 0]);
  if (type !== "center") {
    // measuring dimensions take the board defaults (automatic units, no suffix, four places, zeroes suppressed);
    // a leader keeps its constructor's units and shows its override text
    const format = ["format", ["prefix", type === "radial" ? "R " : ""], ["suffix", ""], ["units", measuring ? 3 : 0], ["units_format", 0], ["precision", 4]];
    if (type === "leader") format.push(["override_value", d.text || ""]); else format.push(["suppress_zeroes", "yes"]);
    node.push(format);
  }
  const style = ["style", ["thickness", r6(gfxWidth(layer))], ["arrow_length", ARROW_LEN], ["text_position_mode", 0]];
  if (type === "aligned" || type === "orthogonal") style.push(["arrow_direction", "outward"], ["extension_height", EXT_HEIGHT]);   // DIM_ARROW_DIRECTION::OUTWARD, always written
  if (type === "leader") style.push(["text_frame", 0]);
  style.push(["extension_offset", EXT_OFFSET]);
  if (type !== "leader") style.push(["keep_text_aligned", "yes"]);
  node.push(style);
  // the dimension is its own PCB_TEXT, so the gr_text repeats the item's uuid
  if (type !== "center") node.push(["gr_text", g.text, ["at", r6(g.tpos[0]), r6(g.tpos[1]), r6(g.tang)], ["layer", layer], ["uuid", uuid], effectsNode(layer)]);
  return node;
}

// ---------------------------------------------------------------- reference images
const IMAGE_PPI = 300;   // BITMAP_BASE's default when the file carries no resolution
function base64Bytes(b64) {
  if (typeof atob === "function") { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
/** Pixel size and resolution of a PNG / JPEG the way BITMAP_BASE reads them: pHYs / JFIF density, else 300 ppi. */
function imageInfo(b) {
  const be32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3], be16 = (i) => (b[i] << 8) + b[i + 1];
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (b.length > 24 && b[0] === 0x89 && tag(1) === "PNG\r") {
    const out = { type: "png", w: be32(16), h: be32(20), ppi: IMAGE_PPI };
    for (let i = 8; i + 8 <= b.length; i += 12 + be32(i)) {
      const t = tag(i + 4);
      if (t === "pHYs" && i + 17 <= b.length) { if (b[i + 16] === 1) out.ppi = Math.round(be32(i + 8) * 0.0254); break; }   // pixels per metre
      if (t === "IDAT" || t === "IEND") break;
    }
    return out.w && out.h ? out : null;
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    const out = { type: "jpeg", w: 0, h: 0, ppi: IMAGE_PPI };
    for (let i = 2; i + 4 <= b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1]; if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }   // standalone markers
      const len = be16(i + 2);
      if (m === 0xE0 && len >= 16 && tag(i + 4) === "JFIF") { const u = b[i + 11], dx = be16(i + 12); if (dx && u === 1) out.ppi = dx; else if (dx && u === 2) out.ppi = Math.round(dx * 2.54); }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { out.h = be16(i + 5); out.w = be16(i + 7); break; }   // SOFn
      if (m === 0xDA) break;
      i += 2 + len;
    }
    return out.w && out.h ? out : null;
  }
  return null;
}
const imageMm = (info) => [info.w * 25.4 / info.ppi, info.h * 25.4 / info.ppi];   // REFERENCE_IMAGE: 1000 mils / ppi per pixel

// ---------------------------------------------------------------- changes
function wrapBoard(node) { return `(kicad_pcb (version ${BOARD_VERSION}) (generator "pcbnew") ${K.serialize(node)})`; }
// The desktop's class names: kicad-canvas maps "arc" to the schematic shape name first (boards want PCB_ARC) and
// knows nothing of curves, dimensions, images and tables.
const typeNameOf = (item) => item.kind === "arc" ? "PCB_ARC" : item.kind === "gr_curve" ? "PCB_SHAPE"
  : item.kind === "dimension" ? (DIM_CLASS[K.str((K.kid(item.node, "type") || [])[1])] || "PCB_DIM_ALIGNED")
  : item.kind === "image" ? "PCB_REFERENCE_IMAGE" : item.kind === "table" ? "PCB_TABLE" : item.kind === "group" ? "PCB_GROUP" : item.kind === "target" ? "PCB_TARGET" : K.typeNameOf(item);
function upsertChange(item, kind, net) {
  const c = { id: item.id, kind, typeName: typeNameOf(item), sexpr: wrapBoard(item.node) };
  const n = net || netOf(item.node); if (n.name) c.netName = n.name;   // the desktop re-resolves nets by name
  // parseItemSexpr strips a parsed group's members (they point into its temporary parse
  // board) and rebuilds membership from this uuid list; without it the group lands empty
  // on the desktop, and a MODIFIED empties one that had members.
  if (item.kind === "group" || item.kind === "generated") c.groupMembers = K.groupMemberIds(item.node);
  if (item.kind === "footprint") {
    const pads = {};
    for (const p of K.kids(item.node, "pad")) { const pn = netOf(p); if (pn.name) pads[K.str(p[1])] = pn.name; }
    c.padNets = pads;
  }
  return c;
}
function addedChange(doc, node, net) { return upsertChange(K.createItem(doc, node), "ADDED", net); }
function replacedChange(item, node) { return upsertChange({ id: item.id, kind: item.kind, node }, "MODIFIED"); }
function removedChange(item) { const c = K.removeChange(item); c.typeName = typeNameOf(item); return c; }
/** REMOVED changes for a multi-selection (items or ids); app.js deletes a group through this. */
function deleteChanges(doc, items) {
  const out = [];
  for (const x of items || []) { const it = typeof x === "string" ? doc.items.get(x) : x; if (it && it.id && it.kind) out.push(removedChange(it)); }
  return out;
}
/** The board's nets, from every pad, track, via and zone (kicad-canvas drops the (net …) table). */
function boardNets(doc) {
  const byName = new Map(); const take = (n) => { if (n && n.name && !byName.has(n.name)) byName.set(n.name, n); };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { for (const p of K.kids(it.node, "pad")) take(netOf(p)); }
    else if (it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") take(netOf(it.node));
  }
  return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- routing geometry
/** One KiCad-style leg from a to b: a 45° diagonal plus an orthogonal run, in either order. */
function routeLeg(a, b, diagFirst) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.min(Math.abs(dx), Math.abs(dy));
  const diag = [Math.sign(dx) * d, Math.sign(dy) * d], orth = [dx - diag[0], dy - diag[1]];
  const first = diagFirst ? diag : orth, second = diagFirst ? orth : diag;
  const c = [a[0] + first[0], a[1] + first[1]]; const out = [];
  if (Math.hypot(first[0], first[1]) > 1e-6) out.push([a.slice(), c]);
  if (Math.hypot(second[0], second[1]) > 1e-6) out.push([c.slice(), b.slice()]);
  return out;
}

/** Absolute pad centres of a footprint item, with nets and copper layers. */
function padsOf(fp) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const out = [];
  K.kids(n, "pad").forEach((pad, index) => {
    const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const sz = K.kid(pad, "size"); const ls = K.kid(pad, "layers");
    out.push({ x: fx + rx, y: fy + ry, rot: prot, w: sz ? K.num(sz[1]) : 1, h: sz ? K.num(sz[2], K.num(sz[1])) : 1,
      net: netOf(pad), layers: ls ? ls.slice(1).map(K.str) : [], number: K.str(pad[1]), type: K.str(pad[2]), shape: K.str(pad[3]), node: pad, index });
  });
  return out;
}
const padOnLayer = (p, layer) => p.layers.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
function padCovers(p, x, y) { const [lx, ly] = rotator(-p.rot)(x - p.x, y - p.y); return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2; }

/** Magnetic target near (x, y): a pad (centre within tol, or the cursor over it), via or track end on the layer (strict: of `net` only). */
function snapTarget(doc, x, y, tol, layer, net, strict) {
  let best = null, bd = Infinity;
  const take = (px, py, n, kind, inside) => {
    const d = Math.hypot(px - x, py - y); if (!inside && d > tol) return;
    if (hasNet(net) && hasNet(n) && !sameNet(n, net)) return;   // never pull a routed net onto another net
    if (strict && !sameNet(n, net) && !(kind === "pad" && inside)) return;   // pickSingleItem: the routed net only; a free pad when the cursor is inside it
    if (d < bd) { bd = d; best = { x: px, y: py, net: n, kind }; }
  };
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) continue;
    if (it.kind === "footprint") { for (const p of padsOf(it)) if (padOnLayer(p, layer)) take(p.x, p.y, p.net, "pad", padCovers(p, x, y)); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) take(a[0], a[1], netOf(it.node), "via", false); }
    else if (it.kind === "segment" && layerOf(it.node) === layer) { for (const key of ["start", "end"]) { const p = pt(it.node, key); if (p) take(p[0], p[1], netOf(it.node), "track", false); } }
  }
  return best;
}
/** Net of whatever copper sits under (x, y): a pad, or a track/via on the layer. */
function netUnder(doc, x, y, layer) {
  for (const it of doc.items.values()) if (it.kind === "footprint" && it.bbox && x >= it.bbox[0] && x <= it.bbox[2] && y >= it.bbox[1] && y <= it.bbox[3]) {
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y)) return p.net;
  }
  const it = hitTestItem(doc, x, y, HIT_MM);
  if (it && (it.kind === "via" || ((it.kind === "segment" || it.kind === "arc") && (!layer || layerOf(it.node) === layer)))) return netOf(it.node);
  return { code: 0, name: "" };
}

// ---------------------------------------------------------------- hit testing (non-footprint items)
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function inSweep(t, g) {
  const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return g.anticlockwise ? norm(g.a0 - t) <= norm(g.a0 - g.a1) : norm(t - g.a0) <= norm(g.a1 - g.a0);
}
/** Distance from (x, y) to a geometry's stroke edge (0 inside a filled shape). */
function geomDist(g, x, y) {
  if (g.t === "line") return distSeg(x, y, g.x1, g.y1, g.x2, g.y2) - g.w / 2;
  if (g.t === "poly") {
    const n = g.pts.length; if (n < 2) return Infinity;
    if (g.fill && pointInPoly(g.pts, x, y)) return 0;
    let d = Infinity;
    for (let i = 0; i < (g.close ? n : n - 1); i++) { const a = g.pts[i], b = g.pts[(i + 1) % n]; d = Math.min(d, distSeg(x, y, a[0], a[1], b[0], b[1])); }
    return d - g.w / 2;
  }
  if (g.t === "circle") { const d = Math.hypot(x - g.x, y - g.y); return g.fill && d <= g.r ? d - g.r : Math.abs(d - g.r) - g.w / 2; }   // deep inside a via beats the tracks meeting under it
  if (g.t === "arc") { const d = Math.hypot(x - g.x, y - g.y); return inSweep(Math.atan2(y - g.y, x - g.x), g) ? Math.abs(d - g.r) - g.w / 2 : Infinity; }
  if (g.t === "rect" || g.t === "image") return (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) ? 0 : Infinity;
  return Infinity;
}
/** Nearest track / via / graphic / text within slop mm of (x, y); footprints are app.js's business. */
function hitTestItem(doc, x, y, slop) {
  let best = null, bd = slop;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint" || it.kind === "group" || it.kind === "generated" || !it.bbox) continue;
    const b = it.bbox; if (x < b[0] - slop || x > b[2] + slop || y < b[1] - slop || y > b[3] + slop) continue;
    let d = Infinity;
    if (it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") d = (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) ? slop * 0.5 : Infinity;   // precise copper hits win over a text box
    else for (const g of it.geom) { if (it.kind === "zone" && g.fill) continue; d = Math.min(d, geomDist(g, x, y)); }
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

// ---------------------------------------------------------------- connectivity (U)
function conductorEnds(it) {
  if (it.kind === "segment" || it.kind === "arc") return [pt(it.node, "start"), pt(it.node, "end")].filter(Boolean);
  if (it.kind === "via") { const a = pt(it.node, "at"); return a ? [a] : []; }
  return [];
}
const ptKey = (p) => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
/** Ids of every track / arc / via reachable from the seeds through shared endpoints (vias bridge layers). */
function connectedRun(doc, seedIds) {
  const index = new Map(), ends = new Map();
  for (const it of doc.items.values()) {
    const e = conductorEnds(it); if (!e.length) continue; ends.set(it.id, e);
    for (const p of e) { const k = ptKey(p); let arr = index.get(k); if (!arr) { arr = []; index.set(k, arr); } arr.push(it); }
  }
  const out = new Set(), q = [];
  for (const id of seedIds) if (ends.has(id)) { out.add(id); q.push(id); }
  while (q.length) {
    const id = q.pop(); const it = doc.items.get(id);
    for (const p of ends.get(id)) for (const o of index.get(ptKey(p)) || []) {
      if (out.has(o.id)) continue;
      const bridged = it.kind === "via" || o.kind === "via" || layerOf(it.node) === layerOf(o.node);
      if (bridged) { out.add(o.id); q.push(o.id); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- footprint rotate / flip (file-level)
// Pad and text angles in the file are absolute (KiCad writes lib angle + footprint angle), so a footprint
// turn re-derives each one from its angle relative to the footprint; a flip negates that relative angle.
const ANGLED = (c) => isList(c) && (c[0] === "pad" || c[0] === "property" || c[0] === "fp_text") && !!K.kid(c, "at");
// the writer leaves a zero orientation out of a pad's and a footprint's (at x y): "(at 1 2)", never "(at 1 2 0)"; text always carries its angle
function setAngle(c, a) { const at = K.kid(c, "at"); a = norm180(r6(a)); if (a === 0 && c[0] === "pad") { at.length = Math.min(at.length, 3); return; } if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
function setFootprintAt(node, x, y, a) { K.setAt(node, x, y, a); const at = K.kid(node, "at"); if (at && !K.kid(node, "transform") && a === 0 && at.length === 4 && typeof at[3] === "number") at.length = 3; }
function rotateFootprintNode(node, deg) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(a0 + deg); setFootprintAt(node, x, y, a1);
  for (const c of node) if (ANGLED(c)) setAngle(c, K.atOf(c)[2] - a0 + a1);
  return node;
}
function mirrorShapeX(g) {
  for (const key of ["start", "end", "center", "mid"]) { const k = K.kid(g, key); if (k) k[1] = r6(-K.num(k[1])); }
  const pts = K.kid(g, "pts");
  if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") p[1] = r6(-K.num(p[1])); else mirrorShapeX(p); }
}
function flipLayerKid(c) {
  const l = K.kid(c, "layer"); if (l) l[1] = flipLayerName(K.str(l[1]));
  const ls = K.kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayerName(K.str(ls[i]));
}
function toggleMirror(c) {
  const l = K.kid(c, "layer"); if (!l || !sideSpecific(K.str(l[1]))) return;   // user layers have no side: no mirroring
  let eff = K.kid(c, "effects"); if (!eff) { eff = ["effects"]; c.push(eff); }
  const j = K.kid(eff, "justify");
  if (!j) { eff.push(["justify", "mirror"]); return; }
  const i = j.indexOf("mirror");
  if (i < 0) j.push("mirror"); else { j.splice(i, 1); if (j.length === 1) eff.splice(eff.indexOf(j), 1); if (eff.length === 1) c.splice(c.indexOf(eff), 1); }
}
/** Flip to the other side about the footprint's own origin (KiCad's F): mirror local X, negate angles, swap F./B. layers. */
function flipFootprintNode(node) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(-a0); setFootprintAt(node, x, y, a1);
  const lay = K.kid(node, "layer"); if (lay) lay[1] = flipLayerName(K.str(lay[1]));
  for (const c of node) {
    if (!isList(c)) continue; const t = c[0];
    if (ANGLED(c)) { const at = K.kid(c, "at"); at[1] = r6(-K.num(at[1])); setAngle(c, -(K.atOf(c)[2] - a0) + a1); }
    if (t === "pad") {
      flipLayerKid(c);
      const dr = K.kid(c, "drill"); const off = dr && K.kid(dr, "offset"); if (off) off[1] = r6(-K.num(off[1]));
      const prims = K.kid(c, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) mirrorShapeX(p);
    } else if (t === "property" || t === "fp_text") { if (ANGLED(c)) { flipLayerKid(c); toggleMirror(c); } }
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(t)) { mirrorShapeX(c); flipLayerKid(c); }
    else if (t === "fp_text_box" || t === "zone") { mirrorShapeX(c); flipLayerKid(c); for (const poly of K.kids(c, "polygon").concat(K.kids(c, "filled_polygon"))) mirrorShapeX(poly); if (t === "fp_text_box") toggleMirror(c); }
  }
  return node;
}

// ---------------------------------------------------------------- PNS DRAGGER: track drag (D, G, a left-drag on a selected track)
// KiCad's interactive drag runs the router: the grabbed segment's whole LINE (the chain of same-net, same-width segments
// between two non-trivial joints - a pad, a via, a T, a width change) is rebuilt by LINE::dragSegment45 (the neighbours
// keep their direction, new 45° knees grow where needed, the ends never leave their pad or via) or LINE::dragCorner45
// (a vertex follows the cursor with straight + 45° legs).  Drag Free Angle (G) moves the nearer vertex at any angle.  A
// via takes the lines that end on it along (DM_VIA).  Every step is checked against other nets' copper at the design
// rules' clearance (walk around, KiCad's default mode); a step that cannot be made keeps the last valid one.
const PEPS = 5e-7;   // half a nanometre: points this close are one (KiCad works in whole nm)
const peq = (a, b) => Math.abs(a[0] - b[0]) < PEPS && Math.abs(a[1] - b[1]) < PEPS;
const rp = (p) => [r6(p[0]) + 0, r6(p[1]) + 0];
const d45Right = (d) => (d < 0 ? -1 : (d + 1) % 8), d45Left = (d) => (d < 0 ? -1 : (d + 7) % 8);
/** SEG::IntersectLines: where the infinite lines through a1-a2 and b1-b2 cross (null when parallel). */
function lineX(a1, a2, b1, b2) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den; return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::Intersect: the crossing of two segments, ends included; parallel (and zero-length) segments never cross. */
function segX(a1, a2, b1, b2) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den, u = ((b1[0] - a1[0]) * ey - (b1[1] - a1[1]) * ex) / den;
  const e = 1e-9; if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::LineDistance: distance from p to the infinite line through a-b. */
function lineDist(a, b, p) { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return L < 1e-12 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L; }
const chainAppend = (out, pts) => { for (const p of pts) if (!out.length || !peq(out[out.length - 1], p)) out.push(p.slice()); return out; };   // SHAPE_LINE_CHAIN::Append
const chainLen = (pts) => ptsLength(pts);
/** SHAPE_LINE_CHAIN::Simplify on nm-rounded points. */
const chainSimplify = (pts) => simplifyPts(pts.map(rp));
/**
 * DIRECTION_45::BuildInitialTrace (mitred 45°): from p0 to p1, a straight run and a diagonal; it starts diagonal when
 * the direction `d` is diagonal (or, for an undefined direction, when startDiag says so).
 */
function initialTrace(p0, p1, d, startDiag) {
  const diag = d >= 0 ? isDiagDir(d) : !!startDiag;
  const w = Math.abs(p1[0] - p0[0]), h = Math.abs(p1[1] - p0[1]), sw = Math.sign(p1[0] - p0[0]), sh = Math.sign(p1[1] - p0[1]);
  if (w < PEPS || h < PEPS || Math.abs(w - h) < PEPS) return chainAppend([], [p0, p1]);
  let mp0, mp1;
  if (w > h) { mp0 = [(w - h) * sw, 0]; mp1 = [h * sw, h * sh]; } else { mp0 = [0, sh * (h - w)]; mp1 = [sw * w, sh * w]; }
  const m = diag ? mp1 : mp0; return chainAppend([], [p0, rp([p0[0] + m[0], p0[1] + m[1]]), p1]);
}
/** dragCornerInternal: rebuild the end of a chain towards p, keeping as much of it as can carry on at 45°. */
function dragCornerInternal(origin, p) {
  if (origin.length === 1) return initialTrace(origin[0], p, -1, false);
  if (origin.length === 2) return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[1], origin[0])));
  let picked = null, i;
  for (i = origin.length - 2; i >= 0; i--) {
    const dStart = dir8(origin[i], origin[i + 1]), pStart = origin[i], dPrev = i > 0 ? dir8(origin[i - 1], origin[i]) : -1;
    const path = initialTrace(pStart, p, dStart); if (path.length < 2) continue;
    const d0 = dir8(path[0], path[1]);
    if (d0 === dStart) { picked = path; break; }
    if (dPrev >= 0 && dirAngle(d0, dPrev) === 1) { picked = path; break; }
  }
  if (picked) return chainAppend(origin.slice(0, i + 1).map((q) => q.slice()), picked);
  return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[origin.length - 2], origin[origin.length - 1])));
}
/** LINE::snapDraggedCorner: a dragged corner within the threshold of where two obtuse neighbours would meet goes there. */
function snapDraggedCorner(pts, p, idx, thresh) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, s0 = Math.max(idx - 2, 0), s1 = Math.min(idx + 2, segs - 1); let best = p, bd = Infinity;
  for (let i = s0; i <= s1; i++) for (let j = s0; j < i; j++) {
    if (dirAngle(dir8(pts[i], pts[i + 1]), dir8(pts[j], pts[j + 1])) !== 1) continue;
    const ip = lineX(pts[i], pts[i + 1], pts[j], pts[j + 1]); if (!ip) continue;
    const d = Math.hypot(ip[0] - p[0], ip[1] - p[1]); if (d < thresh && d < bd) { bd = d; best = ip; }
  }
  return best;
}
/** LINE::dragCorner45: vertex idx follows p; both legs are rebuilt with 45° corners (only one at the line's ends). */
function dragCorner45(pts, idx, p, thresh) {
  const snapped = snapDraggedCorner(pts, p, idx, thresh); const segs = pts.length - 1; let path;
  if (idx === 0) path = dragCornerInternal(pts.slice().reverse(), snapped).reverse();
  else if (idx === segs) path = dragCornerInternal(pts, snapped);
  else path = chainAppend(dragCornerInternal(pts.slice(0, idx + 1), snapped), dragCornerInternal(pts.slice(idx).reverse(), snapped).reverse());
  return chainSimplify(path);
}
/** LINE::dragCornerFree (Drag Free Angle): the vertex goes exactly to p. */
function dragCornerFree(pts, idx, p) { const out = pts.map((q) => q.slice()); out[idx] = p.slice(); return chainSimplify(out); }
/** LINE::snapToNeighbourSegments: a dragged segment near a parallel segment two away snaps onto its line. */
function snapToNeighbourSegments(pts, p, idx, thresh) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, dragDir = dir8(pts[idx], pts[idx + 1]); let best = p, bd = Infinity;
  for (const k of [idx - 2, idx + 2]) {
    if (k < 0 || k > segs - 1 || (k > idx && idx >= segs - 2)) continue;
    const a = pts[k], b = pts[k + 1]; if (dir8(a, b) !== dragDir) continue;
    const d = lineDist(a, b, p); if (d < bd && d <= thresh) { bd = d; best = a.slice(); }
  }
  return best;
}
/**
 * LINE::dragSegment45: segment idx is moved through p keeping its direction; the segments before and after keep theirs
 * (or turn 45° where they ran straight on), a pad or via end stays where it is and a new 45° segment grows from it.
 * Of the guide-line intersections the shortest chain wins.
 */
function dragSegment45(line, aIndex, aP, thresh) {
  const path = line.map((q) => q.slice()); let index = aIndex; const segs0 = line.length - 1;
  const target = snapToNeighbourSegments(path, aP, aIndex, thresh);
  if (index === 0) { path.splice(0, 0, path[0].slice()); index++; }
  if (index === path.length - 2) path.splice(path.length - 1, 0, path[path.length - 1].slice());
  const seg = (i) => [path[i], path[i + 1]];
  let dragged = seg(index); const dragDir = dir8(dragged[0], dragged[1]);
  let sPrev = seg(index - 1), sNext = seg(index + 1); let dirPrev = dir8(sPrev[0], sPrev[1]), dirNext = dir8(sNext[0], sNext[1]);
  if (dirPrev === dragDir) { dirPrev = d45Left(dirPrev); path.splice(index, 0, path[index].slice()); index++; }
  else if (dirPrev < 0) dirPrev = d45Left(dragDir);
  if (dirNext === dragDir) { dirNext = d45Right(dirNext); path.splice(index + 1, 0, path[index + 1].slice()); }
  else if (dirNext < 0) dirNext = d45Right(dragDir);
  sPrev = seg(index - 1); sNext = seg(index + 1); dragged = seg(index);
  const guide = (p, d) => [p, [p[0] + DIRS8[d][0], p[1] + DIRS8[d][1]]];
  const wide = (d) => { const a = dirAngle(d, dragDir); return a === 1 || a === 4; };   // ANG_OBTUSE | ANG_HALF_FULL
  let gA, gB;
  if (aIndex === 0) gA = [guide(dragged[0], d45Right(dragDir)), guide(dragged[0], d45Left(dragDir))];
  else if (wide(dirPrev)) gA = [guide(sPrev[0], d45Left(dragDir)), guide(sPrev[0], d45Right(dragDir))];
  else gA = [guide(dragged[0], dirPrev), guide(dragged[0], dirPrev)];
  if (aIndex === segs0 - 1) gB = [guide(dragged[1], d45Right(dragDir)), guide(dragged[1], d45Left(dragDir))];
  else if (wide(dirNext)) gB = [guide(sNext[1], d45Left(dragDir)), guide(sNext[1], d45Right(dragDir))];
  else gB = [guide(dragged[1], dirNext), guide(dragged[1], dirNext)];
  const cur = guide(target, dragDir);
  let best = null, bestLen = Infinity;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const ip1 = lineX(cur[0], cur[1], gA[i][0], gA[i][1]), ip2 = lineX(cur[0], cur[1], gB[j][0], gB[j][1]); if (!ip1 || !ip2) continue;
    const s1 = [sPrev[0], ip1], s3 = [ip2, sNext[1]]; let np, ip;
    if ((ip = segX(s1[0], s1[1], sNext[0], sNext[1]))) np = [s1[0], ip, sNext[1]];
    else if ((ip = segX(s3[0], s3[1], sPrev[0], sPrev[1]))) np = [sPrev[0], ip, s3[1]];
    else if ((ip = segX(s1[0], s1[1], s3[0], s3[1]))) np = [sPrev[0], ip, sNext[1]];
    else np = [sPrev[0], ip1, ip2, sNext[1]];
    np = chainAppend([], np); const L = chainLen(np); if (L < bestLen) { bestLen = L; best = np; }
  }
  if (!best) return chainSimplify(line);
  let out;
  if (segs0 === 1 || aIndex === 0) out = best.concat(line.slice(2));
  else if (aIndex === segs0 - 1) out = line.slice(0, line.length - 2).concat(best);
  else out = line.slice(0, aIndex).concat(best, line.slice(aIndex + 2));
  return chainSimplify(out);
}

/** Track endpoints by layer and point, vias and pad centres by point: what NODE::FindJoint looks up. */
function jointIndex(doc) {
  if (S.joints && S.joints.doc === doc && S.joints.ver === S.docVer) return S.joints;
  const NT = netTable(doc); const ends = new Map(), vias = new Map(), pads = new Map(); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const add = (m, k, v) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(v); };
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue; const L = layerOf(it.node); add(ends, L + "|" + ptKey(a), it); add(ends, L + "|" + ptKey(b), it); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) add(vias, ptKey(a), { item: it, layers: viaLayers(it.node, copper), net: NT.key(netOf(it.node)) }); }
    else if (it.kind === "footprint") for (const p of padsOf(it)) add(pads, ptKey([p.x, p.y]), { item: it, pad: p, layers: padCopperLayers(p, copper) });
  }
  S.joints = { doc, ver: S.docVer, ends, vias, pads, NT };
  return S.joints;
}
const trackEnds = (it) => [pt(it.node, "start"), pt(it.node, "end")];
/**
 * NODE::AssembleLine: the segment and every segment reached through trivial joints (exactly two same-net segments of
 * one width meeting, no via, no pad centre, no arc).  { ids, pts, index (the seed's segment index), width, layer, net, netKey }.
 */
function assembleLine(doc, seg) {
  const J = jointIndex(doc); const L = layerOf(seg.node), w = widthOf(seg.node, 0.25), net = netOf(seg.node), key = J.NT.key(net);
  const [A, B] = trackEnds(seg); if (!A || !B) return null;
  const ids = [seg.id], pts = [A.slice(), B.slice()];
  const walk = (from, p, atEnd) => {
    let cur = from, q = p;
    for (let guard = 0; guard < 10000; guard++) {
      const k = ptKey(q);
      if ((J.vias.get(k) || []).some((v) => v.layers.has(L))) return;
      if ((J.pads.get(k) || []).some((x) => x.layers.has(L) && samePt([x.pad.x, x.pad.y], q))) return;
      const links = (J.ends.get(L + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === key);
      if (links.length !== 2) return;
      const o = links[0] === cur ? links[1] : links[0];
      if (o.kind !== "segment" || ids.includes(o.id) || Math.abs(widthOf(o.node, 0.25) - w) > 1e-9) return;
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) { ids.push(o.id); pts.push(nq.slice()); } else { ids.unshift(o.id); pts.unshift(nq.slice()); }
      cur = o; q = nq;
    }
  };
  walk(seg, B, true); walk(seg, A, false);
  return { ids, pts, index: ids.indexOf(seg.id), width: w, layer: L, net, netKey: key };
}
/** findViaFanoutByHandle: every same-net line ending on the via, on any of its layers. */
function viaFanout(doc, via) {
  const J = jointIndex(doc); const at = pt(via.node, "at"); if (!at) return [];
  const key = J.NT.key(netOf(via.node)); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const layers = viaLayers(via.node, copper);
  const out = [], seen = new Set();
  for (const L of layers) for (const o of J.ends.get(L + "|" + ptKey(at)) || []) {
    if (o.kind !== "segment" || seen.has(o.id) || J.NT.key(netOf(o.node)) !== key) continue;
    const ln = assembleLine(doc, o); if (!ln) continue; ln.ids.forEach((id) => seen.add(id));
    if (peq(ln.pts[ln.pts.length - 1], at) && !peq(ln.pts[0], at)) { ln.pts.reverse(); ln.ids.reverse(); }
    ln.vertex = 0; out.push(ln);
  }
  return out;
}
/** TOOL_BASE::snapToItem: a grab within half the width of a track end takes the end, otherwise the nearest (grid) point on it. */
function snapGrab(ctx, it, mm) {
  if (it.kind === "via") return pt(it.node, "at").slice();
  const [a, b] = trackEnds(it); const w2 = widthOf(it.node, 0.25) / 2;
  const da = Math.hypot(mm[0] - a[0], mm[1] - a[1]), db = Math.hypot(mm[0] - b[0], mm[1] - b[1]);
  if (da < w2 || db < w2) return (da < db ? a : b).slice();
  const g = ctx.snapOn ? ctx.snap(mm.slice()) : mm;   // GRID_HELPER::AlignToSegment: the grid point, put back on the segment
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((g[0] - a[0]) * dx + (g[1] - a[1]) * dy) / l2)) : 0;
  return rp([a[0] + k * dx, a[1] + k * dy]);
}
/**
 * DRAGGER::Start: the drag of one item grabbed at mm.  A segment gives DM_SEGMENT, or DM_CORNER when grabbed within half
 * its width of an end (Free Angle: always DM_CORNER, at the nearer vertex); a via gives DM_VIA.  null when it cannot drag.
 */
function dragStart(ctx, it, mm, free) {
  const doc = ctx.doc; if (!it || (it.kind !== "segment" && it.kind !== "via")) return null;
  const p = snapGrab(ctx, it, mm); const d = { id: it.id, free: !!free, start: p.slice(), cursor: p.slice(), forceMark: false, first: true, status: true, sol: null, last: null, lastValid: p.slice(), obs: new Map() };
  if (it.kind === "via") {
    d.mode = "via"; d.via = it; d.viaAt = pt(it.node, "at").slice(); d.lines = viaFanout(doc, it); d.netKey = netTable(doc).key(netOf(it.node));
  } else {
    const ln = assembleLine(doc, it); if (!ln) return null;
    const a = ln.pts[ln.index], b = ln.pts[ln.index + 1], w2 = ln.width / 2;
    const da = Math.hypot(p[0] - a[0], p[1] - a[1]), db = Math.hypot(p[0] - b[0], p[1] - b[1]);
    d.mode = "segment"; ln.vertex = ln.index;
    if (da < w2 || db < w2) { d.mode = "corner"; if (db <= da) ln.vertex++; }
    else if (d.free) { if (db < da && ln.index < ln.pts.length - 2) ln.vertex++; d.mode = "corner"; }
    d.lines = [ln]; d.netKey = ln.netKey;
  }
  d.ids = new Set(); for (const l of d.lines) for (const id of l.ids) d.ids.add(id); if (d.via) d.ids.add(d.via.id);
  d.sol = dragSolution(d, d.start);   // the item as it is: what an Escape or a refused step shows
  return d;
}
/** One drag step's geometry: each line rebuilt for cursor p (no collision handling). */
function dragSolution(d, p) {
  const thresh = (l) => (d.free ? 0 : l.width / 4);   // smooth_dragged_segments: a quarter width in walk around
  if (d.mode === "via") return { lines: d.lines.map((l) => ({ l, pts: d.free ? dragCornerFree(l.pts, l.vertex, p) : dragCorner45(l.pts, l.vertex, p, 0) })), viaAt: p.slice() };
  const l = d.lines[0];
  const pts = d.mode === "segment" ? dragSegment45(l.pts, l.index, p, thresh(l)) : d.free ? dragCornerFree(l.pts, l.vertex, p) : dragCorner45(l.pts, l.vertex, p, thresh(l));
  return { lines: [{ l, pts }] };
}
function dragObstacles(ctx, d, layer) {
  let O = d.obs.get(layer); if (O) return O;
  O = routeObstacles(ctx.doc, settingsOf(ctx), d.netKey, layer, d.netKey ? null : d.ids); d.obs.set(layer, O); return O;
}
/** NODE::CheckColliding for a drag solution: every obstacle a dragged line or the dragged via violates. */
function solutionHits(ctx, d, sol) {
  const out = [];
  for (const { l, pts } of sol.lines) for (const ob of pathHits(dragObstacles(ctx, d, l.layer), pts, l.width / 2)) if (!out.includes(ob)) out.push(ob);
  if (sol.viaAt) { const copper = ctx.doc.copper.length ? ctx.doc.copper : ["F.Cu", "B.Cu"]; const r = viaNow(d.via.node).size / 2; for (const L of viaLayers(d.via.node, copper)) for (const ob of pathHits(dragObstacles(ctx, d, L), [sol.viaAt], r)) if (!out.includes(ob)) out.push(ob); }
  return out;
}
/** DRAGGER::tryWalkaround, locally: a dragged segment that crosses an obstacle hugs it at clearance (its ends must be clear). */
function walkSolution(ctx, d, sol) {
  const lines = [];
  for (const { l, pts } of sol.lines) {
    const O = dragObstacles(ctx, d, l.layer), r = l.width / 2; if (pathClear(O, pts, r)) { lines.push({ l, pts }); continue; }
    const out = [pts[0].slice()];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!segHit(O, a, b, r)) { out.push(b.slice()); continue; }
      if (segHit(O, a, a, r) || segHit(O, b, b, r)) return null;
      const w = walkTo(O, a, b, r, isDiagDir(dir8(a, b)), i > 0 ? dir8(pts[i - 1], a) : -1, now() + 30); if (!w) return null;
      if (ptsLength(w) > 30 * Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), l.width)) return null;   // SetLengthLimit( true, 30.0 )
      chainAppend(out, w);
    }
    const s = chainSimplify(out); if (s.length < 2 || !pathClear(O, s, r)) return null; lines.push({ l, pts: s });
  }
  return Object.assign({}, sol, { lines });
}
/**
 * DRAGGER::Drag: free angle (and a drag that started in violation) marks obstacles - the step is taken, its status is
 * whether it is clear; walk around takes a step only when it is clear (walking around what it crosses), otherwise the
 * last valid solution stays.  A first step that cannot be made switches to forced mark-obstacles mode.
 */
function dragTo(ctx, d, p) {
  d.cursor = p.slice(); const first = d.first; d.first = false;
  const raw = dragSolution(d, p);
  if (d.free || d.forceMark) { d.sol = raw; d.hits = solutionHits(ctx, d, raw); d.status = !d.hits.length; d.lastValid = p.slice(); return true; }
  const viaClear = !raw.viaAt || !solutionHits(ctx, d, { lines: [], viaAt: raw.viaAt }).length;
  const walked = viaClear ? walkSolution(ctx, d, raw) : null;
  if (walked) { d.sol = walked; d.hits = []; d.status = true; d.lastValid = p.slice(); return true; }
  if (first) { d.forceMark = true; d.sol = raw; d.hits = solutionHits(ctx, d, raw); d.status = !d.hits.length; d.lastValid = p.slice(); return true; }
  d.status = true; d.hits = []; return false;   // the previous solution stays
}
/** ROUTER::CommitRouting for a drag: the old line's segments out, the new line's in (an unchanged segment is kept), the via moved. */
function dragChanges(ctx, d) {
  const doc = ctx.doc; const changes = [];
  for (const { l, pts } of d.sol.lines) {
    const olds = l.ids.map((id) => doc.items.get(id)).filter(Boolean); const kept = new Set();
    const fresh = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const same = olds.find((o) => !kept.has(o.id) && (() => { const [p, q] = trackEnds(o); return (peq(p, a) && peq(q, b)) || (peq(p, b) && peq(q, a)); })());
      if (same) kept.add(same.id); else fresh.push([a, b]);
    }
    for (const o of olds) if (!kept.has(o.id)) changes.push(removedChange(o));
    for (const [a, b] of fresh) {   // a new segment carries the dragged one's own attributes (locked, tstamp-less uuid fresh)
      const tmpl = olds[0] ? clone(olds[0].node) : segmentNode(doc, a, b, l.width, l.layer, l.net);
      const u = K.kid(tmpl, "uuid"); if (u) tmpl.splice(tmpl.indexOf(u), 1);
      K.kid(tmpl, "start").splice(1, 2, r6(a[0]), r6(a[1])); K.kid(tmpl, "end").splice(1, 2, r6(b[0]), r6(b[1]));
      changes.push(addedChange(doc, tmpl, l.net));
    }
  }
  if (d.sol.viaAt && d.via && !peq(d.sol.viaAt, d.viaAt)) { const node = clone(d.via.node); K.kid(node, "at").splice(1, 2, r6(d.sol.viaAt[0]), r6(d.sol.viaAt[1])); changes.push(replacedChange(d.via, node)); }
  return changes;
}
const solutionChanged = (d) => d.sol && (d.sol.lines.some(({ l, pts }) => pts.length !== l.pts.length || pts.some((p, i) => !peq(p, l.pts[i]))) || (d.sol.viaAt && !peq(d.sol.viaAt, d.viaAt)));
/** DRAGGER::FixRoute: commit when valid; in forced mark-obstacles mode only with Ctrl; otherwise from the last valid point. */
function dragFix(ctx, d, force) {
  if (!d.status) {
    if (d.forceMark) { if (!force) return false; }
    else { dragTo(ctx, d, d.lastValid); if (!d.status) return false; }
  }
  if (!solutionChanged(d)) return false;
  const changes = dragChanges(ctx, d); if (!changes.length) return false;
  ctx.commit(changes, "drag track"); return true;
}

// ---------------------------------------------------------------- app.js state (read defensively)
// app.js keeps the editor state in script-scope lets (tool, kdoc, DOC_TYPE, zoom, selected, state) that
// the module hooks don't carry live; they are read under try/catch, falling back to the last ctx seen.
function appGlobal(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
/* the editor's live state is read through window.CollabEditor (see web/editor/state.ts) */
const editorState = () => root.CollabEditor || null;   // the editor bundle's state object (the former app.js script-scope lets)
const appTool = () => appGlobal(() => editorState().tool, S.modTool || "select");
const isPcbDoc = () => appGlobal(() => editorState().DOC_TYPE === "kicad_pcb" && !!editorState().kdoc && root.CollabApp.getState().view === "editor", !!(lastCtx && !lastCtx.isSch && lastCtx.doc));
const liveDoc = () => appGlobal(() => editorState().kdoc, lastCtx && lastCtx.doc);
const liveZoom = () => appGlobal(() => editorState().zoom, lastCtx ? lastCtx.zoom : 1);
const liveSelected = () => appGlobal(() => editorState().selected, lastCtx && lastCtx.selected);

function bind(ctx) { lastCtx = ctx; if (ctx && ctx.K) K = ctx.K; if (ctx) ensureDom(ctx); }
// The track / via sizes in force live in KiCadCanvas.pcbSizes.state (web/canvas/pcb-sizes.ts) — BOARD_DESIGN_SETTINGS'
// pre-defined lists, the selected entries, "use netclass", the connected-width option and the routing layer pair.
// The toolbar's selectors, W / ' / \ and the router all read and step that one object.
let seenDesign;
/** The board's sizes; a context carrying a project file this module has not seen yet (re)loads the lists from it. */
function sizesOf(ctx) { const R = K.pcbSizes.state; if (ctx && ctx.designSettings !== seenDesign) { seenDesign = ctx.designSettings; R.load(seenDesign); } return R; }
const widthFor = () => sizesOf(lastCtx).currentTrackWidth();
const netNameOf = (ctx, net) => (net && net.name) || (net && net.code > 0 && ctx.doc && ctx.doc.nets && ctx.doc.nets.get(net.code)) || "";
/** The width of the track a route would continue at p: the segment under it, or one ending on the pad / via there (inheritTrackWidth). */
function connectedWidth(doc, p, layer, towards) {
  let best = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if ((it.kind !== "segment" && it.kind !== "arc") || layerOf(it.node) !== layer) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue; const w = widthOf(it.node, 0);
    const ends = samePt(a, p) ? b : samePt(b, p) ? a : null;
    if (!ends && !(it.kind === "segment" && distSeg(p[0], p[1], a[0], a[1], b[0], b[1]) <= w / 2 + 1e-6)) continue;
    const d = ends && towards ? Math.hypot(ends[0] - towards[0], ends[1] - towards[1]) : 0;   // several stubs on a pad: the one pointing at the cursor
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}
function nextWidth(w, dir) { const i = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6); return WIDTHS[(i + (dir === -1 ? -1 : 1) + WIDTHS.length) % WIDTHS.length]; }
/** Layer names of the board.  kicad-canvas keys doc.layers by the layer *type* for (n "F.Cu" signal) entries, so fall back to what the items use. */
function layerNames(doc) {
  const names = new Set(doc ? Array.from(doc.layers.keys()).filter((l) => /\./.test(l)) : []);
  if (!names.size && doc) for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && /\./.test(g.layer)) names.add(g.layer);
  return names;
}
function gfxLayers(doc) {
  const names = Array.from(layerNames(doc)).filter((l) => !/\.Cu$/.test(l));
  const out = copperOf(doc).concat(["Edge.Cuts", "F.SilkS", "B.SilkS", "Dwgs.User", "Cmts.User", "F.Fab", "B.Fab"]);   // the copper stack, then what every board has
  for (const l of names) if (!out.includes(l)) out.push(l);
  return out;
}

// ---------------------------------------------------------------- interactions
function hoverPoint(ctx, mm, magnetic) {
  const g = ctx.snap(mm); const out = { x: g[0], y: g[1], snap: null };
  if (magnetic && ctx.doc) {
    const rt = S.route;
    // TOOL_BASE::updateEndItem: while routing only the routed net's items are end candidates (a route without a net has none)
    const s = rt ? (rt.netKey ? snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, rt.layer, rt.net, true) : null) : snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, S.layer, null);
    if (s) { out.x = s.x; out.y = s.y; out.snap = s; }
  }
  return out;
}
/** The board's netlist, rebuilt after a document change and kept until the next one. */
function netlistCached(doc) {
  if (!S.nlc || S.nlc.doc !== doc || S.nlc.ver !== S.docVer) S.nlc = { doc, ver: S.docVer, nl: netlist(doc) };
  return S.nlc.nl;
}
/** The route's own net-less items (its start item and fixed segments): a route without a net does not collide with itself. */
function routeOwn(rt) { const s = new Set(rt.startIds || []); for (const l of rt.legs) for (const id of l.ids) s.add(id); return s; }
function routeObs(ctx, rt, layer) {
  layer = layer || rt.layer; const key = S.docVer + "|" + layer + "|" + rt.width + "|" + rt.legs.length;
  if (!rt.obs || rt.obs.key !== key) { rt.obs = routeObstacles(ctx.doc, settingsOf(ctx), rt.netKey, layer, rt.netKey ? null : routeOwn(rt)); rt.obs.key = key; }
  return rt.obs;
}
/** ROUTING_SETTINGS' displayed clearance (ImportSizes): the routed net's class clearance, never below the board minimum. */
function routeHaloClearance(ctx, rt) { const s = settingsOf(ctx); return Math.max(netClearance(s, rt.netKey), s.minClearance || 0); }
/** LINE_PLACER::Move: the posture from the mouse trail, then the head walked around the obstacles to the cursor. */
function updateHead(ctx) {
  const rt = S.route; if (!rt || !ctx.doc) return;
  const O = routeObs(ctx, rt); const r = rt.width / 2;
  trailAdd(rt.tracer, rt.cursor);
  rt.diagFirst = isDiagDir(tracerPosture(rt.tracer, rt.cursor));
  const res = walkHead(O, rt.last, rt.cursor, r, rt.diagFirst, rt.tracer.lastSegDir);
  rt.head = res.pts; rt.reached = res.reached; rt.target = rt.head[rt.head.length - 1].slice();
  rt.ratline = leadingRatline(ctx, rt);
}
/**
 * TOPOLOGY::LeadingRatLine: from the head's end to the nearest anchor of the routed net that is not already connected
 * to the line (its start's copper, or what its end lands on).  None for a route without a net.
 */
function leadingRatline(ctx, rt) {
  if (!rt.netKey) return null;
  const nl = netlistCached(ctx.doc); const net = nl.nets.get(rt.netKey); if (!net) return null;
  const end = rt.target; const probe = (p) => ({ t: "circle", x: p[0], y: p[1], r: 0 });
  const touches = (cl, p, layer) => cl.items.some((c) => c.kind !== "zone" && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, probe(p)) <= EPS);
  let best = null, bd = Infinity;
  for (const cl of net.clusters) {
    if (touches(cl, rt.last, rt.layer) || touches(cl, end, rt.layer)) continue;
    for (const a of cl.anchors) { const d = Math.hypot(a.p[0] - end[0], a.p[1] - end[1]); if (d < bd) { bd = d; best = a.p; } }
  }
  return best ? [end.slice(), best.slice()] : null;
}
/** highlightNets( true, { net } ): the routed net brightened, the rest dimmed; a highlight the user had on that net is kept for afterwards. */
function routeHighlight(ctx, rt) { if (rt && rt.netKey) highlightIds(ctx, netHighlightIds(ctx.doc, rt.netKey, netlistCached(ctx.doc))); }
function routeUnhighlight(ctx, rt) {
  if (!ctx || !rt || !rt.netKey) return;
  if (rt.keepHighlight && S.highlightNet === rt.netKey) highlightIds(ctx, netHighlightIds(ctx.doc, rt.netKey, netlistCached(ctx.doc)));
  else { S.highlightNet = null; highlightIds(ctx, null); }
}
/** LINE_PLACER::FixRoute: commit the head (the walked line since the last click); refused while it violates clearance. */
function fixHead(ctx) {
  const rt = S.route; const pts = rt.head; if (!pts || pts.length < 2) return false;
  if (!pathClear(routeObs(ctx, rt), pts, rt.width / 2)) return false;   // AllowDRCViolations() is false outside Highlight collisions
  const changes = []; for (let i = 0; i + 1 < pts.length; i++) changes.push(addedChange(ctx.doc, segmentNode(ctx.doc, pts[i], pts[i + 1], rt.width, rt.layer, rt.net), rt.net));
  const ids = changes.map((c) => c.id);
  if (rt.split) { changes.push(...splitChanges(ctx.doc, rt.split)); rt.split = null; }
  const end = pts[pts.length - 1].slice(), lastDir = dir8(pts[pts.length - 2], end);
  rt.legs.push({ ids, from: rt.last.slice(), layer: rt.layer });
  ctx.commit(changes, "route");
  rt.last = end; rt.head = [end.slice()]; rt.target = end.slice(); rt.cursor = end.slice(); rt.ratline = null;
  rt.tracer = newTracer(rt.width, lastDir); trailAdd(rt.tracer, rt.last);   // the next leg prefers to carry on the last segment's direction
  return true;
}
function endRoute(ctx, fixCurrent) {
  const rt = S.route; if (!rt) return;
  if (fixCurrent && rt.head && rt.head.length > 1) fixHead(ctx);
  S.route = null; routeUnhighlight(ctx, rt); sizesOf(ctx).endRoute(); refreshChip(ctx); ctx.requestRender();
}
/** Backspace while routing (the router's UndoLastSegment): take back the last fixed leg — and its via — and carry on from where it began. */
function undoRouteLeg(ctx) {
  const rt = S.route; const leg = rt && rt.legs.pop(); if (!leg) return false;
  const changes = leg.ids.map((id) => ctx.doc.items.get(id)).filter(Boolean).map(removedChange);
  if (changes.length) ctx.commit(changes, "undo segment");
  rt.last = leg.from.slice(); if (leg.layer !== rt.layer) { rt.layer = leg.layer; S.layer = leg.layer; sizesOf(ctx).setActiveLayer(leg.layer); }
  rt.tracer = newTracer(rt.width, -1); trailAdd(rt.tracer, rt.last); rt.head = [rt.last.slice()]; rt.target = rt.last.slice();
  if (rt.cursor) updateHead(ctx);
  refreshChip(ctx); ctx.requestRender(); return true;
}
/**
 * PNS LINE_PLACER::splitAdjacentSegments: a route that starts in the middle of a track breaks that track there — the
 * track keeps its start and uuid and ends at the point, a new track of the same width, layer and net carries on to
 * the old end.  Nothing when the track has changed since the route began or the point is one of its ends.
 */
function splitChanges(doc, split) {
  const it = doc.items.get(split.id); if (!it || it.kind !== "segment" || K.serialize(it.node) !== K.serialize(split.node)) return [];
  const a = pt(it.node, "start"), b = pt(it.node, "end"), p = split.point; if (!a || !b || samePt(a, p) || samePt(b, p)) return [];
  const head = clone(it.node); K.kid(head, "end").splice(1, 2, r6(p[0]), r6(p[1]));
  const tail = clone(it.node); const u = K.kid(tail, "uuid"); if (u) tail.splice(tail.indexOf(u), 1);
  K.kid(tail, "start").splice(1, 2, r6(p[0]), r6(p[1]));
  return [replacedChange(it, head), addedChange(doc, tail, netOf(tail))];
}
/** The segment on `layer` under (x, y) with the point projected onto its centre line: where a route started on a track begins. */
function trackUnder(doc, x, y, layer) {
  const it = hitTestItem(doc, x, y, HIT_MM); if (!it || it.kind !== "segment" || layerOf(it.node) !== layer) return null;
  const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return { item: it, point: [r6(a[0] + k * dx), r6(a[1] + k * dy)] };
}
/** The obstacles in violation, shown as KiCad's router does (pure green over a clearance halo) until the cursor moves on. */
function showViolations(obs, at) { S.violations = obs.length ? { obs, at: at.slice() } : null; }
/**
 * ROUTER::isStartingPointRoutable and ROUTER_TOOL's start checks: no route from a non-plated hole, inside a rule area
 * that keeps tracks out, from copper text, or where a zero-length track (at the route width, then the board minimum)
 * already violates clearance.  Returns the refusal message or null.
 */
function startRefusal(ctx, p, mm, net, width, layer, own, snapped) {
  const doc = ctx.doc; const q = mm || p;
  const pad = padAt(doc, q[0], q[1], layer) || padAt(doc, q[0], q[1], null);
  if (pad && pad.pad.type === "np_thru_hole") return "Cannot start routing from a non-plated hole.";
  const W = routerWorld(doc);
  if (W.keepouts.some((k) => k.layers.has(layer) && pointInPoly(k.shape.pts, p[0], p[1]))) return "Rule area disallows tracks.";
  if (!snapped && !pad) { const t = hitTestItem(doc, q[0], q[1], HIT_MM); if (t && (t.kind === "gr_text" || t.kind === "gr_text_box") && /\.Cu$/.test(layerOf(t.node, ""))) return "Cannot start routing from a text item."; }
  if (!/\.Cu$/.test(layer)) return "Tracks on Copper layers only.";
  const s = settingsOf(ctx); const key = netTable(doc).key(net);
  const O = routeObstacles(doc, s, key, layer, key ? null : own);
  let hits = pathHits(O, [p], width / 2);
  if (hits.length && s.minTrackWidth > 0) hits = pathHits(O, [p], s.minTrackWidth / 2);
  if (hits.length) { showViolations(hits, p); return "The routing start point violates DRC."; }
  return null;
}
function routeClick(ctx, hv, mm) {
  const now = Date.now(); let p = [hv.x, hv.y];
  S.violations = null;
  if (!S.route) {
    let net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, S.layer);
    let split = null, startIds = [];
    if (!hv.snap) { const on = trackUnder(ctx.doc, mm ? mm[0] : hv.x, mm ? mm[1] : hv.y, S.layer); if (on) { p = on.point; net = netOf(on.item.node); split = { id: on.item.id, point: p.slice(), node: clone(on.item.node) }; startIds.push(on.item.id); } }   // started on a track: its centre line and its net
    else if (hv.snap.kind !== "pad") { const it = hitTestItem(ctx.doc, hv.x, hv.y, HIT_MM); if (it) startIds.push(it.id); }
    const R = sizesOf(ctx); const connected = connectedWidth(ctx.doc, p, S.layer, mm || p);
    const width = R.routeWidth(netNameOf(ctx, net), connected);   // ImportSizes: the connected track, the net's class, or the selected width
    const refusal = startRefusal(ctx, p, mm, net, width, S.layer, new Set(startIds), !!hv.snap);
    if (refusal) { ctx.toast(refusal); ctx.requestRender(); return; }
    const netKey = netTable(ctx.doc).key(net);
    S.route = { last: p, target: p.slice(), cursor: p.slice(), head: [p.slice()], reached: true, net, netKey, layer: S.layer, width, connected, diagFirst: false, clickT: now, clickAt: p.slice(), legs: [], split, startIds, ratline: null,
      tracer: newTracer(width, -1), keepHighlight: !!netKey && S.highlightNet === netKey };
    trailAdd(S.route.tracer, p);
    if (R.activeLayer !== S.layer) R.setActiveLayer(S.layer);
    routeHighlight(ctx, S.route); S.route.ratline = leadingRatline(ctx, S.route);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const rt = S.route;
  const dbl = now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  if (!samePt(p, rt.cursor || rt.last)) { rt.cursor = p.slice(); updateHead(ctx); }
  // landing on the routed net (a pad, via or track end) ends the trace once the walk reaches it, as in KiCad
  const lands = hv.snap && rt.netKey && sameNet(hv.snap.net, rt.net) && rt.reached && samePt(rt.target, [hv.x, hv.y]);
  if (!fixHead(ctx)) { ctx.requestRender(); return; }
  if (lands) { const done = S.route; S.route = null; routeUnhighlight(ctx, done); sizesOf(ctx).endRoute(); refreshChip(ctx); }
  ctx.requestRender();
}
/** The through via's layer span: the outer copper layers of the board. */
function viaSpan(doc) { const cu = K.pcbSizes.copperStack(copperOf(doc)); return [cu[0], cu[cu.length - 1]]; }
/** V while routing: fix the head, drop a via at its end and continue on the other layer of the routing pair — only where the via keeps its clearance. */
function routeVia(ctx, toLayer) {
  const rt = S.route; const doc = ctx.doc; const R = sizesOf(ctx); const s = settingsOf(ctx);
  const via = R.routeVia(netNameOf(ctx, rt.net)); const p = rt.target.slice(); const pts = rt.head && rt.head.length > 1 ? rt.head : [p];
  if (pts.length > 1 && !pathClear(routeObs(ctx, rt), pts, rt.width / 2)) return false;
  const own = rt.netKey ? null : routeOwn(rt); const hits = [];
  for (const l of copperOf(doc)) hits.push(...pathHits(routeObstacles(doc, s, rt.netKey, l, own), [p], via.diameter / 2));
  if (hits.length) { showViolations(hits, p); ctx.requestRender(); return false; }
  const changes = []; for (let i = 0; i + 1 < pts.length; i++) changes.push(addedChange(doc, segmentNode(doc, pts[i], pts[i + 1], rt.width, rt.layer, rt.net), rt.net));
  if (rt.split && changes.length) { changes.push(...splitChanges(doc, rt.split)); rt.split = null; }
  changes.push(addedChange(doc, viaNode(doc, p[0], p[1], via.diameter, via.drill, rt.net, viaSpan(doc)), rt.net));
  rt.legs.push({ ids: changes.filter((c) => c.kind === "ADDED").map((c) => c.id), from: rt.last.slice(), layer: rt.layer });
  ctx.commit(changes, "route via");
  rt.last = p; rt.target = p.slice(); rt.head = [p.slice()]; rt.layer = toLayer || R.pairedLayer(rt.layer); S.layer = rt.layer; R.setActiveLayer(rt.layer);
  rt.tracer = newTracer(rt.width, -1); trailAdd(rt.tracer, p);   // a line ending in a via has no last direction
  if (rt.cursor) updateHead(ctx);
  refreshChip(ctx); ctx.requestRender(); return true;
}
function placeVia(ctx, hv) {
  const net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, null);
  const via = sizesOf(ctx).routeVia(netNameOf(ctx, net));
  ctx.commit([addedChange(ctx.doc, viaNode(ctx.doc, hv.x, hv.y, via.diameter, via.drill, net, viaSpan(ctx.doc)), net)], "via");
}
function setLayer(ctx, layer) {
  if (S.route) { if (layer !== S.route.layer) routeVia(ctx, layer); return; }   // layer change mid-route goes through a via
  S.layer = layer; S.gfxLayer = layer; sizesOf(ctx).setActiveLayer(layer); refreshChip(ctx); ctx.requestRender();
}
/** + / - (PCB_CONTROL::LayerNext / LayerPrev): the next visible copper layer down or up the stack. */
function stepLayer(ctx, forward) {
  const R = sizesOf(ctx); const hidden = appGlobal(() => editorState().hiddenLayers, null);
  const to = K.pcbSizes.stepCopperLayer(copperOf(ctx.doc), S.route ? S.route.layer : (R.activeLayer || S.layer), forward, hidden);
  if (to) setLayer(ctx, to); return true;
}
// R / F: a lone footprint turns or flips about its own anchor; anything more goes through the selection actions
// (about the selection centre).  Nothing of ours selected lets app.js's orientation-only fallback run.
function rotateSelected(ctx) { if (!selectionIds(ctx).size) return false; return runAction("rotateSelection", ctx); }
function flipSelected(ctx) { if (!selectionIds(ctx).size) return false; return runAction("flipSelection", ctx); }
function deleteSelection(ctx) {
  const changes = []; for (const id of unlockedIds(ctx, Array.from(S.sel))) { const it = ctx.doc.items.get(id); if (it) changes.push(removedChange(it)); }
  S.sel.clear(); if (!changes.length) return;
  ctx.commit(changes, "delete"); ctx.toast(`Deleted ${changes.length} item${changes.length > 1 ? "s" : ""}`);
}
const sizeUnits = () => appGlobal(() => editorState().units, "mm") || "mm";
/** A size in the editor's units, trailing zeros trimmed: "0.25 mm", "9.84 mils". */
function fmtSize(v, bare) { const u = sizeUnits(); const x = u === "mil" ? +(v / 0.0254).toFixed(2) : u === "in" ? +(v / 25.4).toFixed(5) : +v.toFixed(4); return bare ? String(x) : x + (u === "mil" ? " mils" : u === "in" ? " in" : " mm"); }
/** Tracks, arcs and vias only, with the select tool: W and ' then edit the selection instead of the current size. */
function sizeSelection(ctx) {
  if (S.modTool) return null;
  const items = selectedItems(ctx); if (!items.length || !items.every((it) => it.kind === "segment" || it.kind === "arc" || it.kind === "via")) return null;
  return items;
}
/** W / Shift+W (BOARD_EDITOR_CONTROL::TrackWidthInc / Dec). */
function cycleWidth(ctx, dir) {
  const R = sizesOf(ctx), fwd = dir !== -1;
  if (S.route) {
    R.stepTrackWidth(fwd, true); S.route.width = R.routeWidth(netNameOf(ctx, S.route.net), S.route.connected);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const sel = sizeSelection(ctx);
  if (sel) {   // each selected track goes to the next larger (smaller) of the netclass width and the pre-defined widths
    const changes = [];
    for (const it of sel) {
      if (it.kind === "via") continue; const w = R.steppedWidth(widthOf(it.node, 0), fwd); if (w === null) continue;
      const node = clone(it.node); const wn = K.kid(node, "width"); if (wn) wn[1] = r6(w); else node.splice(node.indexOf(K.kid(node, "layer")), 0, ["width", r6(w)]); changes.push(replacedChange(it, node));
    }
    if (changes.length) ctx.commit(changes, fwd ? "Increase Track Width" : "Decrease Track Width");
    return;
  }
  R.stepTrackWidth(fwd, false); refreshChip(ctx);   // the toolbar's width combo shows it
}
/** ' / \ (ViaSizeInc / Dec). */
function cycleVia(ctx, dir) {
  const R = sizesOf(ctx), fwd = dir !== -1;
  const sel = S.route ? null : sizeSelection(ctx);
  if (sel) {
    const changes = [];
    for (const it of sel) {
      if (it.kind !== "via") continue; const sn = K.kid(it.node, "size"); const v = R.steppedVia(sn ? K.num(sn[1]) : 0, fwd); if (!v) continue;
      const node = clone(it.node); const s2 = K.kid(node, "size"), d2 = K.kid(node, "drill"); if (s2) s2[1] = r6(v.diameter); if (d2 && v.drill > 0) d2[1] = r6(v.drill); changes.push(replacedChange(it, node));
    }
    if (changes.length) ctx.commit(changes, fwd ? "Increase Via Size" : "Decrease Via Size");
    return true;
  }
  R.stepViaSize(fwd); refreshChip(ctx); if (ctx.requestRender) ctx.requestRender(); return true;
}
/** { size, drill } of a via node, or of the via the tools would place now. */
function viaNow(node) {
  if (node) { const s = K.kid(node, "size"), d = K.kid(node, "drill"); return { size: s ? K.num(s[1]) : 0, drill: d ? K.num(d[1]) : 0 }; }
  const R = sizesOf(lastCtx); const v = S.route ? R.routeVia(netNameOf(lastCtx || {}, S.route.net)) : R.currentVia(); return { size: v.diameter, drill: v.drill };
}
function expandSelection(ctx) {
  if (!S.sel.size) return false;
  const before = S.sel.size; S.sel = connectedRun(ctx.doc, S.sel);
  ctx.toast(S.sel.size > before ? `Selected the connected run (${S.sel.size} items)` : "Nothing else connected"); ctx.requestRender(); return true;
}
/** KiCad's `routable` selection (PCB_SELECTION_TOOL::Main): tracks, or one via, and nothing else.  Arcs are moved instead here. */
function routableItems(doc, ids) {
  const its = Array.from(ids, (id) => doc.items.get(id)).filter(Boolean);
  const segs = its.filter((it) => it.kind === "segment").length, vias = its.filter((it) => it.kind === "via").length;
  if (!its.length || segs + vias !== its.length || vias > 1 || (!segs && vias !== 1)) return null;
  return its;
}
const distToItem = (it, p) => { if (it.kind === "via") { const a = pt(it.node, "at"); return Math.hypot(p[0] - a[0], p[1] - a[1]); } const [a, b] = trackEnds(it); return distSeg(p[0], p[1], a[0], a[1], b[0], b[1]); };
/**
 * ROUTER_TOOL::InlineDrag: the item nearest the grab point leads (snapped onto it), the other selected tracks follow with
 * the same displacement (MULTI_DRAGGER), the dragged net is highlighted.  S.drag = { subs, tool, bySelect, moved }.
 */
function beginInlineDrag(ctx, its, mm, free, how) {
  if (!its || !its.length) return false;
  if (its.some((it) => isLocked(it.node)) && !overrideLocks()) { ctx.toast("Locked — tick Override locks to move it", 2500); return false; }
  const sorted = its.slice().sort((a, b) => distToItem(a, mm) - distToItem(b, mm));
  const lead = dragStart(ctx, sorted[0], mm, free); if (!lead) return false;
  const subs = [lead], taken = new Set(lead.ids);
  for (const it of sorted.slice(1)) {
    if (taken.has(it.id) || it.kind !== "segment") continue;
    const [a, b] = trackEnds(it); const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = dragStart(ctx, it, mid, false); if (!d) continue;
    if (d.mode !== "segment" && !free) d.mode = "segment";
    d.ids.forEach((id) => taken.add(id)); subs.push(d);
  }
  cancelOps(); S.violations = null;
  S.drag = { subs, tool: how === "tool", bySelect: how !== "tool", moved: false, cursor: lead.start.slice(), appSel: how === "app" };   // a left-drag commits on release, D / G on the next click
  dragHighlight(ctx, lead);
  ctx.requestRender(); return true;
}
/** NeighboringSegmentFilter: the track or via under the cursor when nothing is selected. */
function dragCandidate(ctx, p) {
  const it = hitTestItem(ctx.doc, p[0], p[1], HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  return it && (it.kind === "segment" || it.kind === "via") ? it : null;
}
/** EDIT_TOOL::Drag (D, G): the selected tracks / via, or the one under the cursor, follow the cursor until a click. */
function beginToolDrag(ctx, free) {
  const ids = selectionIds(ctx); const at = cursorPoint(ctx);
  let its = ids.size ? routableItems(ctx.doc, ids) : null;
  if (!its && !ids.size) { const c = dragCandidate(ctx, at); if (c) its = [c]; }
  return !!its && beginInlineDrag(ctx, its, at, free, "tool");
}
function dragHighlight(ctx, d) { if (!d.netKey) return; d.keepHighlight = S.highlightNet === d.netKey; highlightIds(ctx, netHighlightIds(ctx.doc, d.netKey, netlistCached(ctx.doc))); }
/** ROUTER::Move while dragging: every sub-drag to the snapped cursor (the followers by the lead's displacement). */
function dragMove(ctx, mm) {
  const D = S.drag; if (!D) return; const p = ctx.snapOn ? ctx.snap(mm.slice()) : mm.slice();
  D.cursor = mm.slice(); const lead = D.subs[0];
  if (!D.moved && peq(p, lead.start)) return;
  D.moved = true; const dx = p[0] - lead.start[0], dy = p[1] - lead.start[1];
  for (const d of D.subs) dragTo(ctx, d, d === lead ? p : rp([d.start[0] + dx, d.start[1] + dy]));
}
/** The changes a drag commits (FixRoute for each sub-drag), or null when any of them refuses. */
function dragFixChanges(ctx, d, force) {
  if (!d.status) {
    if (d.forceMark) { if (!force) return null; }
    else { dragTo(ctx, d, d.lastValid); if (!d.status) return null; }
  }
  return solutionChanged(d) ? dragChanges(ctx, d) : [];
}
/** End the drag: commit (Ctrl forces a drag in violation) or put everything back; the net highlight goes. */
function finishDrag(ctx, commit, force) {
  const D = S.drag; if (!D) return false; S.drag = null; let done = false;
  if (commit && D.moved && !ctx.viewOnly) {
    const all = []; let ok = true;
    for (const d of D.subs) { const ch = dragFixChanges(ctx, d, force); if (!ch) { ok = false; break; } all.push(...ch); }
    if (ok && all.length) { ctx.commit(all, "drag track"); done = true; }
    if (D.appSel && ctx.setSelection && ctx.selection) ctx.setSelection(Array.from(ctx.selection));
  }
  routeUnhighlight(ctx, D.subs[0]);
  if (D.tool) ctx.setTool("select");
  ctx.requestRender(); return done;
}
/** Items the canvas leaves out while their dragged shape is drawn in the overlay (ROUTER_IFACE::HideItem). */
function dragHiddenIds() {
  if (S.move && S.move.conns && S.move.conns.length && S.move.moved) { const out = new Set(); for (const c of S.move.conns) for (const id of c.l.ids) out.add(id); return out; }
  const D = S.drag; if (!D || !D.moved) return null;
  const out = new Set(); for (const d of D.subs) for (const id of d.ids) out.add(id); return out;
}
/** The drag in progress: the lines and via where they would go, obstacles in violation green, and KiCad's status note. */
function drawDragPreview(c, ctx, view, px) {
  const m = S.move;
  if (m && m.conns && m.conns.length && m.moved) {   // COMPONENT_DRAGGER's attached lines at the footprint's offset
    for (const { l, pts } of connLines(m, m.last[0], m.last[1])) { if (pts.length < 2) continue; c.globalAlpha = 0.8; c.strokeStyle = color(l.layer); c.lineWidth = l.width; polyline(c, pts, false); }
  }
  const D = S.drag; if (!D || !D.moved) return;
  for (const d of D.subs) {
    const bad = d.hits && d.hits.length; const s = settingsOf(ctx);
    if (bad) for (const ob of d.hits) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
    for (const { l, pts } of d.sol.lines) {
      if (pts.length < 2) continue;
      if (bad) { c.globalAlpha = 0.7; c.strokeStyle = HALO_COLOR; c.lineWidth = l.width + 2 * Math.max(netClearance(s, l.netKey), s.minClearance || 0); polyline(c, pts, false); }
      c.globalAlpha = 0.8; c.strokeStyle = color(l.layer); c.lineWidth = l.width; polyline(c, pts, false);   // ROUTER_PREVIEW_ITEM: the layer colour at alpha 0.8
    }
    if (d.via) {
      const at = d.sol.viaAt || d.viaAt, v = viaNow(d.via.node);
      c.globalAlpha = 0.8; c.strokeStyle = "rgb(179, 179, 179)"; c.lineWidth = Math.max((v.size - v.drill) / 2, px); ring(c, at, (v.size + v.drill) / 4);   // COLOR4D( 0.7, 0.7, 0.7, 0.8 ) around the hole
    }
  }
  if (D.subs.some((d) => d.forceMark && !d.status) && D.cursor) drawStatusNote(c, D.cursor, px * (view.dpr || 1), "Track violates DRC.", "(Ctrl+click to commit anyway.)");
}
/** ROUTER_STATUS_VIEW_ITEM: a boxed message and hint above and to the right of the cursor, in the UI's colours. */
function drawStatusNote(c, at, cpx, msg, hint) {
  const css = (name, dflt) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const fs = 13 * cpx, hs = 11 * cpx, m = 6 * cpx;
  c.save(); c.globalAlpha = 1;
  c.font = `${fs}px sans-serif`; const w1 = c.measureText(msg).width; c.font = `${hs}px sans-serif`; const w2 = c.measureText(hint).width;
  const w = Math.max(w1, w2) + 2 * m, h = fs + hs + 3 * m; const x = at[0] + 5 * m, y = at[1] - h - 5 * m;
  c.fillStyle = css("--color-panel", "#2b2b2b"); c.strokeStyle = css("--color-ink", "#e0e0e0"); c.lineWidth = cpx;
  c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
  c.fillStyle = css("--color-ink", "#e0e0e0"); c.textBaseline = "top";
  c.font = `${fs}px sans-serif`; c.fillText(msg, x + m, y + m); c.font = `${hs}px sans-serif`; c.fillText(hint, x + m, y + 2 * m + fs);
  c.restore();
}

// ---------------------------------------------------------------- select-tool drags (PCB_SELECTION_TOOL → EDIT_TOOL::doMoveSelection / drag45)
// KiCad: a left-drag on a track slides the segment (attached ends follow), a via or graphic moves
// freely with the tracks ending on it stretching along.  app.js calls onSelectDown when its own
// footprint hit-test found nothing on the footprint's geometry; the capture-phase stage listeners
// below then drive the drag while app.js's select tool stays passive.
function beginSelectDrag(ctx, it, mm) {
  if (isLocked(it.node) && !overrideLocks()) { ctx.toast("Locked — tick Override locks to move it", 2500); return false; }
  const m = { ids: [it.id], start: ctx.snapOn ? ctx.snap([mm[0], mm[1]]) : mm.slice(), orig: new Map(), ends: [], last: [0, 0], moved: false };
  m.orig.set(it.id, clone(it.node));
  if (it.kind === "via") {                                        // tracks ending on the via stretch with it
    const at = pt(it.node, "at");
    for (const sg of ctx.doc.items.values()) { if (sg.kind !== "segment" && sg.kind !== "arc") continue; for (const key of ["start", "end"]) { const q = pt(sg.node, key); if (q && at && samePt(q, at)) { m.ends.push({ id: sg.id, key }); if (!m.orig.has(sg.id)) m.orig.set(sg.id, clone(sg.node)); } } }
  }
  S.move = m; S.sel = new Set([it.id]); return true;
}
function moveNodesAt(m, dx, dy) {
  const out = [];
  for (const [id, orig] of m.orig) {
    const node = clone(orig);
    if (m.ids.includes(id)) translateNode(node, dx, dy);
    for (const e of m.ends) if (e.id === id) { const k = K.kid(node, e.key), o = K.kid(orig, e.key); if (k && o) { k[1] = r6(K.num(o[1]) + dx); k[2] = r6(K.num(o[2]) + dy); } }
    out.push({ id, node });
  }
  return out;
}
function moveApply(ctx, m, dx, dy) {   // live preview: the document's own nodes take the moved shape (originals come back on finish)
  for (const { id, node } of moveNodesAt(m, dx, dy)) { const it = ctx.doc.items.get(id); if (!it) continue; it.node.length = 0; it.node.push(...node); K.replaceChange(ctx.doc, it); }
}
function selectMoveTo(ctx, mm) {
  const m = S.move; if (!m) return;
  const sN = ctx.snapOn ? ctx.snap([mm[0], mm[1]]) : mm; const dx = r6(sN[0] - m.start[0]), dy = r6(sN[1] - m.start[1]);
  if (dx === m.last[0] && dy === m.last[1]) return;
  m.last = [dx, dy]; m.moved = true; moveApply(ctx, m, dx, dy); ctx.requestRender();
}
function finishSelectMove(ctx, commit, force) {
  const m = S.move; S.move = null; if (!m) return;
  const [dx, dy] = m.last; moveApply(ctx, m, 0, 0);            // originals back first, so commit() records a true inverse
  if (!commit && m.placing) {   // Escape on a paste / duplicate that still follows the cursor takes the new items out again
    const gone = m.placing.filter((id) => ctx.doc.items.has(id)).map((id) => ctx.doc.items.get(id));
    if (gone.length) ctx.commit(deleteChanges(ctx.doc, gone), "cancel", { amend: true, discard: true });
    applySelection(ctx, []); ctx.requestRender(); return;
  }
  if (!commit || !m.moved || (!dx && !dy)) { ctx.requestRender(); return; }
  const changes = moveNodesAt(m, dx, dy).map(({ id, node }) => replacedChange(ctx.doc.items.get(id), node));
  if (m.conns && m.conns.length) {
    const lines = connLines(m, dx, dy); const s = settingsOf(ctx); const hits = [];
    for (const { l, pts } of lines) hits.push(...pathHits(routeObstacles(ctx.doc, s, l.netKey, l.layer, l.netKey ? null : new Set(l.ids)), pts, l.width / 2));
    if (hits.length && !force) { showViolations(hits, lines[0].pts[0]); ctx.toast("Track violates DRC."); ctx.requestRender(); return; }   // COMPONENT_DRAGGER::FixRoute: refused while it collides (Ctrl+click forces)
    changes.push(...dragChanges(ctx, { sol: { lines } }));
  }
  ctx.commit(changes, m.conns && m.conns.length ? "drag" : "move", m.placing ? { amend: true } : undefined);
  ctx.requestRender();
}
/**
 * Move (M, EDIT_TOOL::Move): everything selected — tracks, vias, graphics, text, zones, footprints, the members of a
 * selected group — follows the cursor from where it is; a click drops it, Escape puts it back.  Unlike a drag,
 * nothing attached follows.  Locked items stay put unless "Override locks" is on.
 */
function beginCarryMove(ctx, opts) {
  const doc = ctx.doc; if (!doc) return false; opts = opts || {};
  const ids = Array.from(expandGroups(doc, opts.placing ? new Set(opts.placing) : selectionIds(ctx))).filter((id) => { const it = doc.items.get(id); return it && it.kind !== "group" && it.kind !== "generated"; });
  if (!ids.length) return false;
  const free = unlockedIds(ctx, ids);
  if (!free.length) return true;
  cancelOps();
  const at = opts.at ? (ctx.snapOn ? ctx.snap(opts.at.slice()) : opts.at.slice()) : cursorPoint(ctx);
  const m = { ids: free, start: at.slice(), orig: new Map(), ends: [], last: [0, 0], moved: false, sticky: opts.sticky !== false, placing: opts.placing || null };
  for (const id of free) m.orig.set(id, clone(doc.items.get(id).node));
  if (opts.drag) dragEnds(doc, m);
  S.move = m; ctx.requestRender(); return true;
}
/**
 * Drag (D, EDIT_TOOL::Drag -> COMPONENT_DRAGGER on footprints): every line attached to a moving pad (ending on its
 * centre or inside it) is re-routed with LINE::DragCorner - its attached end follows the pad, the rest bends at 45° - and
 * a line running between two pads that both move goes along whole.  A via's tracks stretch with it.
 */
function dragEnds(doc, m) {
  const pads = [], vias = [];
  for (const id of m.ids) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "footprint") for (const p of padsOf(it)) pads.push(p);
    else if (it.kind === "via") { const at = pt(it.node, "at"); if (at) vias.push(at); }
  }
  if (!pads.length && !vias.length) return;
  const onLayer = (layers, l) => layers.some((x) => x === l || (x === "*.Cu" && /\.Cu$/.test(l)) || (x === "F&B.Cu" && (l === "F.Cu" || l === "B.Cu")));
  const padAtEnd = (q, l) => pads.some((p) => onLayer(p.layers, l) && (samePt(q, [p.x, p.y]) || padCovers(p, q[0], q[1])));
  const seen = new Set(); m.conns = [];
  for (const sg of Array.from(doc.items.values())) {
    if (sg.kind !== "segment" || m.ids.includes(sg.id) || seen.has(sg.id)) continue;
    const l = layerOf(sg.node);
    for (const key of ["start", "end"]) {
      const q = pt(sg.node, key); if (!q) continue;
      if (vias.some((v) => samePt(q, v))) { m.ends.push({ id: sg.id, key }); if (!m.orig.has(sg.id)) m.orig.set(sg.id, clone(sg.node)); continue; }
      if (!padAtEnd(q, l) || seen.has(sg.id)) continue;
      const ln = assembleLine(doc, sg); if (!ln) continue; ln.ids.forEach((id) => seen.add(id));
      const first = ln.pts[0], last = ln.pts[ln.pts.length - 1];
      const atFirst = Math.hypot(first[0] - q[0], first[1] - q[1]) <= Math.hypot(last[0] - q[0], last[1] - q[1]);
      if (padAtEnd(first, l) && padAtEnd(last, l)) { for (const id of ln.ids) { if (!m.ids.includes(id)) m.ids.push(id); if (!m.orig.has(id)) m.orig.set(id, clone(doc.items.get(id).node)); } break; }   // between two moving pads: carried whole
      m.conns.push({ l: ln, vertex: atFirst ? 0 : ln.pts.length - 1 }); break;
    }
  }
}
/** The attached lines at a component drag's offset (LINE::DragCorner of the attached end, 45°). */
function connLines(m, dx, dy) { return (m.conns || []).map((c) => { const p = c.l.pts[c.vertex]; return { l: c.l, pts: dragCorner45(c.l.pts, c.vertex, rp([p[0] + dx, p[1] + dy]), 0) }; }); }
/** A press while the selection follows the cursor: the left button drops it there (and the click goes no further). */
function onStickyPointerDown(ev) {
  const ctx = lastCtx; const m = S.move; if (!m || !m.sticky || !ctx || !isPcbDoc()) return;
  if (ev.target.closest && (ev.target.closest("#pcbChip") || ev.target.closest("#cmtPanel"))) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  if (ev.button !== 0) return;
  selectMoveTo(ctx, ctx.worldMm(ev)); S.stickyUp = true; finishSelectMove(ctx, true, !!(ev.ctrlKey || ev.metaKey));
}
const DRAG_PX = 5;
/**
 * PCB_SELECTION_TOOL::Main on a left-drag that started on the selection: a routable selection (tracks, or one via) runs
 * the router's drag (drag45Degree, TRACK_DRAG_ACTION::DRAG), anything else is moved.
 */
function startPendingDrag(ctx, pd) {
  const ids = pd.ids.filter((id) => ctx.doc.items.has(id)); if (!ids.length) return false;
  const its = routableItems(ctx.doc, ids);
  if (its) return beginInlineDrag(ctx, its, pd.mm, false, pd.app ? "app" : "select");
  if (ids.length > 1) return beginCarryMove(ctx, { at: pd.mm, sticky: false });
  return beginSelectDrag(ctx, ctx.doc.items.get(ids[0]), pd.mm);
}
function onStagePointerMove(ev) {
  const ctx = lastCtx; if (!ctx || !isPcbDoc()) return;
  if (S.pending) {
    const pd = S.pending;
    // the drag starts past KiCad's drag threshold in screen pixels (gestures.ts DRAG_THRESHOLD_PX)
    if (Math.hypot(ev.clientX - pd.client[0], ev.clientY - pd.client[1]) <= DRAG_PX) return;
    S.pending = null; startPendingDrag(ctx, pd);
  }
  if (S.drag && S.drag.bySelect) { dragMove(ctx, ctx.worldMm(ev)); ctx.requestRender(); }
  else if (S.move) selectMoveTo(ctx, ctx.worldMm(ev));
}
function onStagePointerUp(ev) {
  const ctx = lastCtx; S.pending = null; if (!ctx) return;
  if (S.stickyUp) { S.stickyUp = false; if (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); } return; }   // the release of the click that dropped a Move
  if (S.drag && S.drag.bySelect) { if (ev) dragMove(ctx, ctx.worldMm(ev)); finishDrag(ctx, true, !!(ev && (ev.ctrlKey || ev.metaKey))); }   // Ctrl on release commits a drag in violation
  else if (S.move && !S.move.sticky) finishSelectMove(ctx, true);
}
// S.draw = { shape, start, cur, pts, … }: line/rect/circle take two clicks, an arc its start, end and
// then a point on the arc, a bezier its start, two control points and end, a polygon / zone / rule area
// any number of corners until the first corner is clicked again (or the last one twice, or Enter), a
// text box or table two corners and then a prompt, a dimension two points and (aligned, orthogonal,
// radial) a third for the offset or the text.
const POLY_TOOLS = new Set(["gpoly", "zone", "rulearea"]);
const gfxTool = (t) => /^g/.test(t || "") || t === "table" || t === "image" || !!DIM_TYPE[t];   // draws on the chip's graphics layer
const RULE_AREA_LAYERS = ["F.Cu", "B.Cu"];
function drawClick(ctx, hv, t) {
  const p = [hv.x, hv.y], layer = S.gfxLayer;
  if (!S.draw) { S.draw = { shape: t, start: p, cur: p.slice(), pts: [p] }; if (t === "dimortho") S.draw.orientation = "h"; ctx.requestRender(); return; }
  const d = S.draw;
  if (t === "garc") {
    if (d.pts.length === 1) { if (!samePt(p, d.start)) d.pts.push(p); ctx.requestRender(); return; }
    const [a, b] = d.pts;
    if (samePt(p, a) || samePt(p, b) || !K.arcFrom3(a, p, b)) { ctx.toast("Click a point on the arc, off the line between its ends"); return; }
    ctx.commit([addedChange(ctx.doc, arcNode(a, p, b, layer))], "arc");
    S.draw = null; ctx.requestRender(); return;
  }
  if (POLY_TOOLS.has(t)) {
    if (samePt(p, d.pts[0]) || samePt(p, d.pts[d.pts.length - 1])) finishPoly(ctx);
    else { d.pts.push(p); ctx.requestRender(); }
    return;
  }
  if (t === "gcurve") {
    if (samePt(p, d.pts[d.pts.length - 1])) { ctx.toast("Click a different point for the curve"); return; }
    d.pts.push(p);
    if (d.pts.length === 4) { ctx.commit([addedChange(ctx.doc, curveNode(d.pts, layer))], "curve"); S.draw = null; }
    ctx.requestRender(); return;
  }
  if (t === "gtextbox" || t === "table") {
    S.draw = null; ctx.requestRender();
    if (samePt(p, d.start)) return;   // clicking the corner again drops the box
    if (t === "gtextbox") { askText(ctx, "Text box", "", (text) => { if (text) ctx.commit([addedChange(ctx.doc, textBoxNode(text, d.start, p, layer))], "text box"); }); return; }
    const n = tableCounts(d.start, p, layer);
    askText(ctx, "Table rows x cols", `${n.rows} x ${n.cols}`, (v) => {
      const m = /^\s*(\d+)\s*[x×*,]\s*(\d+)\s*$/i.exec(v || "");
      if (!m || !+m[1] || !+m[2]) { if (v) ctx.toast("Table size as rows x cols, e.g. 2 x 3"); return; }
      ctx.commit([addedChange(ctx.doc, tableNode(d.start, p, +m[1], +m[2], layer, ctx.snapOn ? ctx.gridPitch : 0))], "table");
    });
    return;
  }
  if (DIM_TYPE[t]) { dimClick(ctx, p, t); return; }
  if (samePt(p, d.start)) { S.draw = null; ctx.requestRender(); return; }   // clicking the start again ends the chain
  const node = t === "gline" ? lineNode(d.start, p, layer) : t === "grect" ? rectNode(d.start, p, layer) : circleNode(d.start, p, layer);
  ctx.commit([addedChange(ctx.doc, node)], t === "gline" ? "line" : t === "grect" ? "rectangle" : "circle");
  S.draw = t === "gline" ? { shape: t, start: p, cur: p.slice(), pts: [p] } : null;   // lines chain like KiCad's polyline drawing
  ctx.requestRender();
}
function finishPoly(ctx) {
  const d = S.draw; if (!d || !POLY_TOOLS.has(d.shape)) return;
  S.draw = null; ctx.requestRender();
  if (d.pts.length < 3) { ctx.toast("A polygon needs at least three corners"); return; }
  if (d.shape === "gpoly") { ctx.commit([addedChange(ctx.doc, polyNode(d.pts, S.gfxLayer))], "polygon"); return; }
  if (d.shape === "rulearea") { ctx.commit([addedChange(ctx.doc, ruleAreaNode(d.pts, RULE_AREA_LAYERS))], "rule area"); return; }
  // a copper zone on the active layer: the net comes from the prompt, which offers the board's nets and
  // starts on whatever copper the first corner sits on (KiCad takes the highlighted or selected net)
  const layer = S.layer, nets = boardNets(ctx.doc), under = netUnder(ctx.doc, d.pts[0][0], d.pts[0][1], layer);
  askText(ctx, "Zone net", under.name, (name) => {
    if (name === null) return;
    const net = name ? (nets.find((n) => n.name === name) || { code: -1, name }) : { code: 0, name: "" };
    ctx.commit([addedChange(ctx.doc, zoneNode(ctx.doc, d.pts, layer, net), net)], "zone");
  }, nets.map((n) => n.name));
}
// DRAWING_TOOL::DrawDimension: SET_ORIGIN, SET_END (a centre dimension is done; a leader wants its text), then
// SET_HEIGHT where the cursor sets the aligned offset, the orthogonal axis and offset, or the radial text.
function dimClick(ctx, p, t) {
  const d = S.draw, type = DIM_TYPE[t];
  if (d.pts.length === 1) {
    if (samePt(p, d.start)) { ctx.toast("Click a different point: a dimension needs two"); return; }
    d.end = type === "center" ? vadd(d.start, snap45(vsub(p, d.start))) : p;   // the centre cross always sits on 45°
    d.pts.push(d.end);
    if (type === "orthogonal") d.orientation = Math.abs(d.end[0] - d.start[0]) < Math.abs(d.end[1] - d.start[1]) ? "v" : "h";
    if (type === "center") { commitDim(ctx, type, d); return; }
    if (type === "leader") { S.draw = null; ctx.requestRender(); askText(ctx, "Leader text", "Leader", (text) => { if (text) commitDim(ctx, type, Object.assign(d, { text })); }); return; }
    ctx.requestRender(); return;
  }
  dimTrack(d, p);
  commitDim(ctx, type, d);
}
function commitDim(ctx, type, d) { S.draw = null; ctx.commit([addedChange(ctx.doc, dimensionNode(type, d, S.gfxLayer))], "dimension"); ctx.requestRender(); }
/** The cursor after the second click (the tool's SET_HEIGHT motion). */
function dimTrack(d, p) {
  const type = DIM_TYPE[d.shape], s = d.start, e = d.end; if (!e) return;
  if (type === "aligned") { const a = Math.atan2(e[1] - s[1], e[0] - s[0]) + Math.PI / 2; d.height = (p[0] - e[0]) * Math.cos(a) + (p[1] - e[1]) * Math.sin(a); }
  else if (type === "orthogonal") {
    const x0 = Math.min(s[0], e[0]), x1 = Math.max(s[0], e[0]), y0 = Math.min(s[1], e[1]), y1 = Math.max(s[1], e[1]);
    if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) {   // the axis only changes outside the points' box
      let vert;
      if (x1 === x0) vert = true; else if (y1 === y0) vert = false;
      else if (p[0] > x0 && p[0] < x1) vert = false;            // above or below: measure X
      else if (p[1] > y0 && p[1] < y1) vert = true;             // beside: measure Y
      else vert = Math.abs(p[1] - (y0 + y1) / 2) < Math.abs(p[0] - (x0 + x1) / 2);
      d.orientation = vert ? "v" : "h";
    }
    d.height = d.orientation === "v" ? p[0] - s[0] : p[1] - s[1];
  } else if (type === "radial") d.textPos = p.slice();
}
// Reference images: the picker (a file dialog; tests swap it) hands back { base64, name }; the image then rides the
// cursor and a click places its centre, as PlaceReferenceImage does.
function loadImage(ctx, res) {
  if (!res || !res.base64) { ctx.toast("No image chosen"); return; }
  const info = imageInfo(base64Bytes(res.base64)); if (!info) { ctx.toast("Only PNG and JPEG images can be placed"); return; }
  const [w, h] = imageMm(info); S.image = { base64: res.base64, info, w, h, name: res.name || "" };
  ctx.toast(`${res.name || "Image"} ${info.w} × ${info.h} px at ${info.ppi} ppi — click to place its centre`, 3000); ctx.requestRender();
}
function openImagePicker() { pickerImpl((res) => { if (lastCtx && S.modTool === "image") loadImage(lastCtx, res); }); }
function placeImage(ctx, hv) {
  const img = S.image; S.image = null;
  ctx.commit([addedChange(ctx.doc, imageNode(hv.x, hv.y, img.base64, S.gfxLayer))], "image"); ctx.requestRender();
}
/** The inline prompt: done(text) on Enter ("" allowed), done(null) on Escape or blur. */
function askText(ctx, title, initial, done, options) { promptImpl(title, initial || "", S.client, (v) => { S.text = null; done(v); }, options || null); }
/** The delete tool's click: a track / via / graphic under the cursor first, else the footprint app.js would pick. */
function itemAt(ctx, mm) {
  const doc = ctx.doc, [x, y] = mm;
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1)); if (it) return it;
  const id = K.hitTest(doc, x, y, Math.min(5 / Math.max(1, (ctx.zoom || 1) * 0.6), 0.5));
  return id ? doc.items.get(id) || null : null;
}
function deleteAt(ctx, mm) {
  const it = itemAt(ctx, mm); if (!it) return null;
  S.sel.delete(it.id); if (S.hover) S.hover.del = null;
  if (ctx.selected && ctx.selected.id === it.id) ctx.setSelected(null);
  ctx.commit([removedChange(it)], "delete");
  ctx.toast(`Deleted ${it.kind === "footprint" ? (it.ref || "footprint") : it.kind.replace(/^gr_/, "")}`);
  ctx.requestRender();
  return it;
}
function placeText(ctx, mm, text) { ctx.commit([addedChange(ctx.doc, textNode(text, mm[0], mm[1], S.gfxLayer))], "text"); }
function cancelOps() { if (S.drag && lastCtx && lastCtx.doc) { const D = S.drag; S.drag = null; routeUnhighlight(lastCtx, D.subs[0]); } if (S.route) { K.pcbSizes.state.endRoute(); const rt = S.route; S.route = null; if (lastCtx && lastCtx.doc) routeUnhighlight(lastCtx, rt); } S.violations = null; S.draw = null; S.drag = null; S.image = null; S.pending = null; if (S.move && lastCtx) finishSelectMove(lastCtx, false); S.move = null; closeTextPrompt(); }

// ================================================================ parity pass: the non-tool commands of pcbnew
// Everything below is DOM-free geometry and node editing (the dialogs at the end are swappable) so the node
// tests can drive it; app.js reaches it through pcb.actions and the exported query functions.
const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated"]);
const EPS = 1e-3;   // touching copper, in mm (KiCad's connectivity uses exact contact on integer nanometres)
const DRC_EPS = 0.0005;   // ADVANCED_CFG::m_DRCEpsilon: half a micron short of a rule is not a violation
const isFootprintNode = (n) => n[0] === "footprint";

// ---------------------------------------------------------------- generic item transforms (move / rotate / flip / mirror)
/** Every absolute (x, y) of a board-level item through fn; angles are untouched.  Footprints move as a whole. */
function mapNodePoints(node, fn) {
  const k = node[0];
  const mapKey = (n, key) => { const c = K.kid(n, key); if (!c || c.length < 3) return; const [x, y] = fn(K.num(c[1]), K.num(c[2])); c[1] = r6(x); c[2] = r6(y); };
  const mapPts = (n) => { const p = K.kid(n, "pts"); if (p) for (const xy of p.slice(1)) if (isList(xy) && xy[0] === "xy") { const [x, y] = fn(K.num(xy[1]), K.num(xy[2])); xy[1] = r6(x); xy[2] = r6(y); } };
  if (k === "footprint") { const [x, y] = K.atOf(node); const [nx, ny] = fn(x, y); K.setAt(node, r6(nx), r6(ny)); return node; }
  if (k === "table") {   // a table sits where its first cell does: every cell shifts with it
    const cells = K.kid(node, "cells"); const first = cells && K.kids(cells, "table_cell")[0]; const s = first && K.kid(first, "start"); if (!s) return node;
    const [ax, ay] = [K.num(s[1]), K.num(s[2])]; const [nx, ny] = fn(ax, ay); K.shiftTable(node, nx - ax, ny - ay); return node;
  }
  for (const key of ["start", "end", "mid", "center", "at"]) mapKey(node, key);
  mapPts(node);
  if (k === "zone") for (const poly of K.kids(node, "polygon").concat(K.kids(node, "filled_polygon"))) mapPts(poly);
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) mapKey(gt, "at"); }
  return node;
}
const translateNode = (node, dx, dy) => mapNodePoints(node, (x, y) => [x + dx, y + dy]);
function angleKid(node) { const at = K.kid(node, "at"); return at ? K.num(at[3]) : 0; }
function setAngleKid(node, a) { const at = K.kid(node, "at"); if (!at) return; a = r6(norm360(a)); if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
/** Turn an item by deg (KiCad's positive = counter-clockwise on screen) about (cx, cy). */
function rotateNode(node, cx, cy, deg) {
  const k = node[0]; const R = rotator(deg); const about = (x, y) => { const [dx, dy] = R(x - cx, y - cy); return [cx + dx, cy + dy]; };
  if (k === "footprint") { rotateFootprintNode(node, deg); return mapNodePoints(node, about); }
  if (k === "gr_rect" && norm360(deg) % 90 !== 0) {   // PCB_SHAPE::Rotate: a rectangle off the axes becomes a polygon
    const a = pt(node, "start"), b = pt(node, "end"); const [x0, y0, x1, y1] = corners(a, b);
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => about(x, y));
    node[0] = "gr_poly"; for (const key of ["start", "end"]) { const i = node.indexOf(K.kid(node, key)); if (i > 0) node.splice(i, 1); }
    node.splice(1, 0, ["pts", ...pts.map(xy)]); return node;
  }
  mapNodePoints(node, about);
  if (k === "gr_rect" || k === "gr_text_box") {   // corners stay a corner pair: re-normalise start / end
    const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start").splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end").splice(1, 2, r6(x1), r6(y1)); }
    if (k === "gr_text_box") { const an = K.kid(node, "angle"); const a1 = norm360((an ? K.num(an[1]) : 0) + deg); if (an) an[1] = r6(a1); else if (a1 !== 0) node.splice(node.indexOf(K.kid(node, "layer")), 0, ["angle", r6(a1)]); }
  }
  if (k === "gr_text" || k === "image") setAngleKid(node, angleKid(node) + deg);
  if (k === "dimension") {
    const gt = K.kid(node, "gr_text"); if (gt) setAngleKid(gt, angleKid(gt) + deg);
    const o = K.kid(node, "orientation"); if (o && norm360(deg) % 180 === 90) o[1] = K.num(o[1]) ? 0 : 1;
  }
  return node;
}
/** KiCad's Flip (left / right) about the vertical axis x = cx: other side, layers swapped, texts mirrored. */
function flipNode(node, cx, doc) {
  const k = node[0]; const mirror = (x, y) => [2 * cx - x, y];
  if (k === "footprint") { flipFootprintNode(node); return mapNodePoints(node, mirror); }
  mapNodePoints(node, mirror); flipLayerKid(node);
  if (k === "via") { const ls = K.kid(node, "layers"); if (ls && doc) { const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const names = ls.slice(1).map(K.str).sort((a, b) => copper.indexOf(a) - copper.indexOf(b)); ls.splice(1, ls.length - 1, ...names); } }
  if (k === "gr_text" || k === "gr_text_box") { toggleMirror(node); setAngleKid(node, -angleKid(node)); }
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) { flipLayerKid(gt); toggleMirror(gt); setAngleKid(gt, -angleKid(gt)); } }
  if (k === "table") { const cells = K.kid(node, "cells"); if (cells) for (const c of K.kids(cells, "table_cell")) { flipLayerKid(c); toggleMirror(c); } }
  return node;
}
/** Mirror in place (no side change): "h" about the vertical axis through cx, "v" about the horizontal one through cy. */
function mirrorNode(node, cx, cy, axis) {
  const k = node[0]; if (k === "footprint") return false;   // pcbnew refuses to mirror footprints outside the footprint editor
  mapNodePoints(node, axis === "v" ? (x, y) => [x, 2 * cy - y] : (x, y) => [2 * cx - x, y]);
  const text = (n) => { toggleMirror(n); setAngleKid(n, axis === "v" ? 180 - angleKid(n) : -angleKid(n)); };
  if (k === "gr_text" || k === "gr_text_box") text(node);
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) text(gt); }
  if (k === "gr_rect" || k === "gr_text_box") { const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start").splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end").splice(1, 2, r6(x1), r6(y1)); } }
  return node;
}
/** The point an item is placed by: its (at) / origin, else the middle of its bounding box. */
function anchorOf(item) {
  const n = item.node, k = item.kind;
  if (k === "footprint" || k === "via" || k === "gr_text" || k === "image" || k === "target") { const [x, y] = K.atOf(n); return [x, y]; }
  if (k === "segment" || k === "arc" || k === "gr_line" || k === "gr_arc") { const p = pt(n, "start"); if (p) return p; }
  if (k === "gr_circle") { const p = pt(n, "center"); if (p) return p; }
  const b = item.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
function bboxUnion(items) { let b = null; for (const it of items) { if (!it.bbox) continue; b = b ? [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] : it.bbox.slice(); } return b; }
/** KiCad's modification point: a lone item turns about its own anchor, a group about the middle of its bounding box. */
function selectionCenter(items) {
  if (items.length === 1) return anchorOf(items[0]);
  const b = bboxUnion(items); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
/** MODIFIED changes for the items whose clones fn edits (return false from fn to leave one alone). */
function transformChanges(doc, ids, fn) {
  const out = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it || it.kind === "group" || it.kind === "generated") continue;
    const node = clone(it.node); if (fn(node, it) === false) continue; out.push(replacedChange(it, node));
  }
  return out;
}
const moveChanges = (doc, ids, dx, dy) => (dx || dy) ? transformChanges(doc, ids, (n) => translateNode(n, dx, dy)) : [];
const rotateChanges = (doc, ids, cx, cy, deg) => transformChanges(doc, ids, (n) => rotateNode(n, cx, cy, deg));
const flipChanges = (doc, ids, cx) => transformChanges(doc, ids, (n) => flipNode(n, cx, doc));
const mirrorChanges = (doc, ids, cx, cy, axis) => transformChanges(doc, ids, (n) => mirrorNode(n, cx, cy, axis));
/** DIALOG_MOVE_EXACT: translate, then turn about the selection centre, each item's own anchor, or a point. */
function moveExactChanges(doc, ids, opts) {
  const items = ids.map((id) => doc.items.get(id)).filter(Boolean); const dx = opts.dx || 0, dy = opts.dy || 0, rot = opts.rotation || 0;
  const b = bboxUnion(items);   // ROTATE_AROUND_SEL_CENTER is the bounding box's middle, a lone item included
  let c = opts.about === "anchor" ? null : isList(opts.about) ? opts.about : b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : selectionCenter(items);
  if (c) c = [c[0] + dx, c[1] + dy];
  return transformChanges(doc, ids, (n, it) => { translateNode(n, dx, dy); if (rot) { const p = c || vadd(anchorOf(it), [dx, dy]); rotateNode(n, p[0], p[1], rot); } });
}
/** PCB_SELECTION::GetTopLeftItem: the item whose anchor is leftmost, then topmost — the selection's own anchor. */
function topLeftAnchor(items) { let best = null; for (const it of items) { const p = anchorOf(it); if (!best || p[0] < best[0] - 1e-9 || (Math.abs(p[0] - best[0]) <= 1e-9 && p[1] < best[1])) best = p; } return best || [0, 0]; }
/** POSITION_RELATIVE_TOOL: put the selection's anchor at the reference point plus the offset. */
function positionRelativeChanges(doc, ids, ref, dx, dy) {
  const items = ids.map((id) => doc.items.get(id)).filter(Boolean); if (!items.length) return [];
  const a = topLeftAnchor(items); return moveChanges(doc, ids, ref[0] + dx - a[0], ref[1] + dy - a[1]);
}
// ALIGN_DISTRIBUTE_TOOL: bounding boxes; the target is the item under the cursor, else the first after sorting.
const ALIGN = {
  left: { sort: (b) => b[0], target: (b) => b[0], move: (b, t) => [t - b[0], 0] },
  right: { sort: (b) => -b[2], target: (b) => b[2], move: (b, t) => [t - b[2], 0] },
  top: { sort: (b) => b[1], target: (b) => b[1], move: (b, t) => [0, t - b[1]] },
  bottom: { sort: (b) => -b[3], target: (b) => b[3], move: (b, t) => [0, t - b[3]] },
  centerX: { sort: (b) => (b[0] + b[2]) / 2, target: (b) => (b[0] + b[2]) / 2, move: (b, t) => [t - (b[0] + b[2]) / 2, 0] },
  centerY: { sort: (b) => (b[1] + b[3]) / 2, target: (b) => (b[1] + b[3]) / 2, move: (b, t) => [0, t - (b[1] + b[3]) / 2] },
};
/**
 * align_distribute_tool.cpp getBoundingBox: a footprint by FOOTPRINT::GetBoundingBox( false ) — its pads and shapes
 * without the texts (and pads by their copper, not their mask / paste openings) — anything else by its own box.
 */
function alignBox(it) {
  if (it.kind !== "footprint" || !K.boardItemBox || !it.geom) return it.bbox;
  const geom = it.geom.filter((g) => g.t !== "text" && !g.padNum && !g.padText && !(g.pad && /\.(Mask|Paste)$/.test(g.layer || "")));
  const r = K.boardItemBox(Object.assign({}, it, { geom }), 1e6); if (!r) return it.bbox;
  return [r[0] / 1e6, r[1] / 1e6, (r[0] + r[2]) / 1e6, (r[1] + r[3]) / 1e6];
}
const alignItems = (doc, ids) => ids.map((id) => doc.items.get(id)).filter((it) => it && it.bbox && it.kind !== "group").map((it) => ({ id: it.id, kind: it.kind, bbox: alignBox(it) }));
function alignChanges(doc, ids, mode, cursor) {
  const A = ALIGN[mode]; if (!A) return [];
  const items = alignItems(doc, ids); if (items.length < 2) return [];
  items.sort((p, q) => A.sort(p.bbox) - A.sort(q.bbox));
  const under = cursor && items.find((it) => cursor[0] >= it.bbox[0] && cursor[0] <= it.bbox[2] && cursor[1] >= it.bbox[1] && cursor[1] <= it.bbox[3]);
  const t = A.target((under || items[0]).bbox); const out = [];
  for (const it of items) { const [dx, dy] = A.move(it.bbox, t); if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) out.push(...moveChanges(doc, [it.id], dx, dy)); }
  return out;
}
/** GetDeltasForDistributeByGaps / ByPoints (libs/kimath geometry/distribute.cpp), in mm. */
function distributeDeltasGaps(extents) {
  const d = extents.map(() => 0); if (extents.length < 3) return d;
  let gap = extents[extents.length - 1][0] - extents[0][1]; for (let i = 1; i < extents.length - 1; i++) gap -= extents[i][1] - extents[i][0];
  const per = gap / (extents.length - 1); let target = extents[0][1];
  for (let i = 1; i < extents.length - 1; i++) { d[i] = target - extents[i][0] + i * per; target += extents[i][1] - extents[i][0]; }
  return d;
}
function distributeDeltasPoints(pos) {
  const d = pos.map(() => 0); if (pos.length < 3) return d; const gap = (pos[pos.length - 1] - pos[0]) / (pos.length - 1);
  for (let i = 1; i < pos.length - 1; i++) d[i] = pos[0] + i * gap - pos[i];
  return d;
}
function distributeChanges(doc, ids, axis, byCenters) {
  const items = alignItems(doc, ids); if (items.length < 3) return [];
  const x = axis === "x"; const lo = (b) => x ? b[0] : b[1], hi = (b) => x ? b[2] : b[3], mid = (b) => (lo(b) + hi(b)) / 2;
  items.sort((p, q) => (byCenters ? mid(p.bbox) - mid(q.bbox) : lo(p.bbox) - lo(q.bbox)));
  const d = byCenters ? distributeDeltasPoints(items.map((it) => mid(it.bbox))) : distributeDeltasGaps(items.map((it) => [lo(it.bbox), hi(it.bbox)]));
  const out = []; items.forEach((it, i) => { if (Math.abs(d[i]) > 1e-9) out.push(...moveChanges(doc, [it.id], x ? d[i] : 0, x ? 0 : d[i])); }); return out;
}
/** EDIT_TOOL::Swap: each item takes the place of the next (positions; footprints also trade orientation and side). */
function swapChanges(doc, ids) {
  const items = ids.map((id) => doc.items.get(id)).filter((it) => it && it.kind !== "group"); if (items.length < 2) return [];
  const slots = items.map((it) => ({ p: anchorOf(it), rot: it.kind === "footprint" ? it.rot : 0, layer: it.kind === "footprint" ? it.layer : null }));
  const out = [];
  items.forEach((it, i) => {
    const to = slots[(i + 1) % items.length], from = slots[i]; const node = clone(it.node);
    translateNode(node, to.p[0] - from.p[0], to.p[1] - from.p[1]);
    if (it.kind === "footprint") { if (to.layer !== from.layer) flipNode(node, to.p[0], doc); if (to.rot !== K.atOf(node)[2]) rotateFootprintNode(node, to.rot - K.atOf(node)[2]); }
    out.push(replacedChange(it, node));
  });
  return out;
}
/** Pack the footprints into rows (KiCad's P): biggest first, 1 mm apart, from the selection's top-left corner. */
function packChanges(doc, ids, gap) {
  gap = gap === undefined ? 1 : gap;
  const fps = ids.map((id) => doc.items.get(id)).filter((it) => it && it.kind === "footprint" && it.bbox); if (fps.length < 2) return [];
  const b = bboxUnion(fps); const rowW = Math.max(b[2] - b[0], Math.sqrt(fps.reduce((s, f) => s + (f.bbox[2] - f.bbox[0] + gap) * (f.bbox[3] - f.bbox[1] + gap), 0)) * 1.2);
  fps.sort((p, q) => (q.bbox[2] - q.bbox[0]) * (q.bbox[3] - q.bbox[1]) - (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]));
  let x = b[0], y = b[1], rowH = 0; const out = [];
  for (const f of fps) {
    const w = f.bbox[2] - f.bbox[0], h = f.bbox[3] - f.bbox[1];
    if (x > b[0] && x + w > b[0] + rowW) { x = b[0]; y += rowH + gap; rowH = 0; }
    out.push(...moveChanges(doc, [f.id], x - f.bbox[0], y - f.bbox[1])); x += w + gap; rowH = Math.max(rowH, h);
  }
  return out;
}

// ---------------------------------------------------------------- selection helpers and groups
/** app.js's multi-selection, its footprint selection and the module's own picks, as one set of ids. */
function selectionIds(ctx) {
  const s = new Set(S.sel); if (ctx.selection) for (const id of ctx.selection) s.add(id); if (ctx.selected && ctx.selected.id) s.add(ctx.selected.id);
  for (const id of Array.from(s)) if (!ctx.doc.items.has(id)) s.delete(id);
  return s;
}
const selectedItems = (ctx) => Array.from(selectionIds(ctx), (id) => ctx.doc.items.get(id)).filter(Boolean);
/** Hand a selection back: app.js through setSelection (or setSelected for a lone footprint), the module for its own kinds. */
function applySelection(ctx, ids) {
  const arr = Array.from(ids).filter((id) => ctx.doc.items.has(id));
  if (typeof ctx.setSelection === "function") { S.sel.clear(); ctx.setSelection(arr); }   // app.js owns the whole selection
  else {
    S.sel = new Set(arr.filter((id) => ctx.doc.items.get(id).kind !== "footprint"));
    if (ctx.setSelected) { const fp = arr.map((id) => ctx.doc.items.get(id)).find((it) => it.kind === "footprint"); ctx.setSelected(fp ? { id: fp.id } : null); }
  }
  ctx.requestRender(); return arr;
}
const groupMembers = (node) => { const m = K.kid(node, "members"); return m ? m.slice(1).map(K.str) : []; };
function groupOf(doc, id) { for (const it of doc.items.values()) if (it.kind === "group" && groupMembers(it.node).includes(id)) return it; return null; }
/** The ids plus every member of any group they belong to (and the groups themselves), to any depth. */
function expandGroups(doc, ids) {
  const out = new Set(ids); let grew = true;
  while (grew) {
    grew = false;
    for (const it of doc.items.values()) {
      if (it.kind !== "group") continue; const m = groupMembers(it.node);
      if (!out.has(it.id) && !m.some((id) => out.has(id))) continue;
      for (const id of m.concat([it.id])) if (!out.has(id) && doc.items.has(id)) { out.add(id); grew = true; }
    }
  }
  return out;
}
/** (group "name" (uuid …) (members …)) as PCB_IO_KICAD_SEXPR::format(PCB_GROUP) writes it, member ids sorted. */
function groupNode(name, ids) { return ["group", name || "", ["uuid", K.newUuid()], ["members", ...Array.from(new Set(ids)).sort()]]; }
function groupChanges(doc, ids, name) {
  const members = Array.from(ids).filter((id) => { const it = doc.items.get(id); return it && it.kind !== "group"; });
  if (!members.length) return [];
  return [addedChange(doc, groupNode(name, members))];
}
function ungroupChanges(doc, ids) {
  const out = []; const seen = new Set();
  for (const id of ids) { const it = doc.items.get(id); const g = it && it.kind === "group" ? it : groupOf(doc, id); if (g && !seen.has(g.id)) { seen.add(g.id); out.push(removedChange(g)); } }
  return out;
}
function groupMembersChanges(doc, groupItem, add, remove) {
  const node = clone(groupItem.node); const set = new Set(groupMembers(node));
  for (const id of add || []) if (doc.items.has(id)) set.add(id); for (const id of remove || []) set.delete(id);
  if (!set.size) return [removedChange(groupItem)];
  const m = K.kid(node, "members"); m.splice(1, m.length - 1, ...Array.from(set).sort()); return [replacedChange(groupItem, node)];
}
// (locked yes) where each writer puts it: before the layer for footprints, tracks, shapes, dimensions and zones,
// before (at) for texts, after the layers for vias, after the uuid for groups and tables, after the layer for images.
const LOCK_BEFORE = { footprint: ["placed", "layer"], segment: ["layer", "layers"], arc: ["layer", "layers"], via: ["free", "net", "uuid"], zone: ["layer", "layers"], gr_text: ["at"], gr_text_box: ["start", "pts"], dimension: ["layer"], table: ["layer"], image: ["uuid", "data"], group: ["lib_id", "members"], target: ["at"] };
const isLocked = (node) => { const l = K.kid(node, "locked"); return l ? K.str(l[1]) !== "no" : node.includes("locked"); };
function setLocked(node, on) {
  const k = node[0]; const cur = K.kid(node, "locked"); const i = node.indexOf("locked"); if (i > 0) node.splice(i, 1);
  if (cur) { if (on) cur[1] = "yes"; else node.splice(node.indexOf(cur), 1); return node; }
  if (!on) return node;
  let at = node.length; const before = LOCK_BEFORE[k] || (/^gr_/.test(k) ? ["layer"] : ["layer", "uuid"]);
  for (const b of before) { const c = K.kid(node, b); if (c) { at = node.indexOf(c); break; } }
  if (k === "gr_text" || k === "gr_text_box" || k === "table" || k === "group") { const u = K.kid(node, "uuid"); if ((k === "table" || k === "group") && u) at = node.indexOf(u) + 1; }
  if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(k)) { const f = K.kid(node, "fill") || K.kid(node, "stroke"); if (f) at = node.indexOf(f) + 1; }
  node.splice(at, 0, ["locked", "yes"]); return node;
}
const lockChanges = (doc, ids, on) => transformChanges(doc, ids, (n) => { if (isLocked(n) === !!on) return false; setLocked(n, on); });

// ---------------------------------------------------------------- shapes and distances (copper geometry)
// A copper shape is a core (point, segment, polyline, axis-turned rectangle or polygon) plus an outward
// offset r: circle = point + r, track = segment + w/2, roundrect = shrunk rectangle + corner radius.  The gap
// between two shapes is the core distance less both offsets, clamped at zero when they overlap.
function segsIntersect(p1, p2, p3, p4) {
  const o = (a, b, c) => { const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return Math.abs(v) < 1e-12 ? 0 : Math.sign(v); };
  const on = (a, b, c) => Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  const o1 = o(p1, p2, p3), o2 = o(p1, p2, p4), o3 = o(p3, p4, p1), o4 = o(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4 && o1 && o2 && o3 && o4) return true;
  return (o1 === 0 && on(p1, p2, p3)) || (o2 === 0 && on(p1, p2, p4)) || (o3 === 0 && on(p3, p4, p1)) || (o4 === 0 && on(p3, p4, p2));
}
const dPS = (p, a, b) => distSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
function segSegDist(a, b, c, d) { return segsIntersect(a, b, c, d) ? 0 : Math.min(dPS(a, c, d), dPS(b, c, d), dPS(c, a, b), dPS(d, a, b)); }
/** Closed polygons (arrays of points): 0 when they touch or one holds the other, else the least vertex-to-edge gap. */
function polyPolyDist(P, Q) {
  if (P.some(([x, y]) => pointInPoly(Q, x, y)) || Q.some(([x, y]) => pointInPoly(P, x, y))) return 0;
  let d = Infinity;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; for (let j = 0; j < Q.length; j++) { const c = Q[j], e = Q[(j + 1) % Q.length]; if (segsIntersect(a, b, c, e)) return 0; d = Math.min(d, dPS(a, c, e), dPS(c, a, b)); } }
  return d;
}
function polySegDist(P, a, b) {
  if (pointInPoly(P, a[0], a[1]) || pointInPoly(P, b[0], b[1])) return 0; let d = Infinity;
  for (let i = 0; i < P.length; i++) { const c = P[i], e = P[(i + 1) % P.length]; if (segsIntersect(a, b, c, e)) return 0; d = Math.min(d, dPS(a, c, e), dPS(b, c, e), dPS(c, a, b), dPS(e, a, b)); }
  return d;
}
/** Do two closed polygons share interior area (touching along an edge or at a corner does not count)? */
function polysOverlap(P, Q) {
  const strictInside = (R, p) => pointInPoly(R, p[0], p[1]) && polyPointDist(R, p) > 1e-6;
  if (P.some((p) => strictInside(Q, p)) || Q.some((p) => strictInside(P, p))) return true;
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; for (let j = 0; j < Q.length; j++) { const c = Q[j], d = Q[(j + 1) % Q.length]; if (o(a, b, c) * o(a, b, d) < -1e-12 && o(c, d, a) * o(c, d, b) < -1e-12) return true; } }
  return false;
}
function polyPointDist(P, p) { if (pointInPoly(P, p[0], p[1])) return 0; let d = Infinity; for (let i = 0; i < P.length; i++) d = Math.min(d, dPS(p, P[i], P[(i + 1) % P.length])); return d; }
/** The core of a rectangle shape as a polygon (the rounding radius taken off each side). */
function rectCore(rc) { const R = rotator(rc.rot || 0); const hw = Math.max(rc.w / 2 - (rc.rr || 0), 0), hh = Math.max(rc.h / 2 - (rc.rr || 0), 0); return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => { const [dx, dy] = R(lx, ly); return [rc.x + dx, rc.y + dy]; }); }
function rectPointDist(rc, p) { const [lx, ly] = rotator(-(rc.rot || 0))(p[0] - rc.x, p[1] - rc.y); const hw = Math.max(rc.w / 2 - (rc.rr || 0), 0), hh = Math.max(rc.h / 2 - (rc.rr || 0), 0); return Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0)); }
const shapeOffset = (s) => s.t === "poly" ? 0 : s.t === "rect" ? (s.rr || 0) : (s.r || 0);
const shapeSegs = (s) => s.t === "seg" ? [[s.a, s.b]] : s.t === "path" ? s.pts.slice(0, -1).map((p, i) => [p, s.pts[i + 1]]) : [];
/** Distance between two shape cores; 0 when they overlap. */
function coreDist(s1, s2) {
  const rank = { circle: 0, seg: 1, path: 1, rect: 2, poly: 3 };
  if (rank[s1.t] > rank[s2.t]) return coreDist(s2, s1);
  const a = s1.t, b = s2.t;
  if (a === "circle") {
    const p = [s1.x, s1.y];
    if (b === "circle") return Math.hypot(s2.x - s1.x, s2.y - s1.y);
    if (b === "seg" || b === "path") return Math.min(...shapeSegs(s2).map(([c, d]) => dPS(p, c, d)));
    if (b === "rect") return rectPointDist(s2, p);
    return polyPointDist(s2.pts, p);
  }
  if (a === "seg" || a === "path") {
    const segs = shapeSegs(s1);
    if (b === "seg" || b === "path") { let d = Infinity; for (const [p, q] of segs) for (const [c, e] of shapeSegs(s2)) { d = Math.min(d, segSegDist(p, q, c, e)); if (d === 0) return 0; } return d; }
    const P = b === "rect" ? rectCore(s2) : s2.pts; let d = Infinity; for (const [p, q] of segs) { d = Math.min(d, polySegDist(P, p, q)); if (d === 0) return 0; } return d;
  }
  if (a === "rect") return polyPolyDist(rectCore(s1), b === "rect" ? rectCore(s2) : s2.pts);
  return Infinity;   // zone against zone: the filler's business
}
const shapeGap = (s1, s2) => Math.max(0, coreDist(s1, s2) - shapeOffset(s1) - shapeOffset(s2));
function shapeBBox(s) {
  const o = shapeOffset(s); let pts;
  if (s.t === "circle") pts = [[s.x, s.y]]; else if (s.t === "seg") pts = [s.a, s.b]; else if (s.t === "path" || s.t === "poly") pts = s.pts; else pts = rectCore(s);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - o, y0 - o, x1 + o, y1 + o];
}
const boxesTouch = (a, b, slop) => !(b[0] > a[2] + slop || b[2] < a[0] - slop || b[1] > a[3] + slop || b[3] < a[1] - slop);
/** Points along an arc from kicad-canvas's arcFrom3 result, start to end; chords stay within 0.1 µm of the arc. */
function arcPoints(arc, start, end) {
  let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); if (sweep === 0) sweep = 2 * Math.PI;
  const step = arc.r > 1e-4 ? 2 * Math.acos(Math.max(-1, 1 - 1e-4 / arc.r)) : Math.PI / 24;
  const n = Math.min(4096, Math.max(4, Math.ceil(sweep / step))); const out = [start.slice()];
  for (let i = 1; i < n; i++) { const t = arc.a0 + (arc.anticlockwise ? -1 : 1) * sweep * i / n; out.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]); }
  out.push(end.slice()); return out;
}
function arcLength(arc) { let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return arc.r * sweep; }
/** The copper outline of a pad from padsOf: a disc, a stadium, or a (rounded) rectangle — trapezoids, chamfers and custom pads take their bounding rectangle. */
function padShape(p) {
  if (p.shape === "circle") return { t: "circle", x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2 };
  if (p.shape === "oval") {
    const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h); const half = (long - short) / 2; const d = rotator(p.rot)(p.w >= p.h ? half : 0, p.w >= p.h ? 0 : half);
    return half > 1e-9 ? { t: "seg", a: [p.x - d[0], p.y - d[1]], b: [p.x + d[0], p.y + d[1]], r: short / 2 } : { t: "circle", x: p.x, y: p.y, r: short / 2 };
  }
  let rr = 0; if (p.shape === "roundrect") { const n = p.node && K.kid(p.node, "roundrect_rratio"); rr = (n ? K.num(n[1]) : 0.25) * Math.min(p.w, p.h); }
  return { t: "rect", x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot, rr };
}
function padCopperLayers(p, copper) { const out = new Set(); for (const l of p.layers) { if (l === "*.Cu" || l === "F&B.Cu") for (const c of copper) out.add(c); else if (/\.Cu$/.test(l)) out.add(l); } return out; }
function viaLayers(node, copper) {
  const ls = K.kid(node, "layers"); const pair = ls ? [K.str(ls[1]), K.str(ls[2])] : ["F.Cu", "B.Cu"];
  if (!node.includes("blind") && !node.includes("micro") && !node.includes("buried")) return new Set(copper);
  const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); return new Set(i0 >= 0 && i1 >= 0 ? copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1) : pair);
}
const shareLayer = (a, b) => { for (const l of a) if (b.has(l)) return true; return false; };

// ---------------------------------------------------------------- connectivity: netlist, clusters, ratsnest, net inspector
/** Net names for both file styles: (net "GND") inline, or (net 3) resolved through the pads' (net 3 "GND"). */
function netTable(doc) {
  const byCode = new Map(), byName = new Map();
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kids(it.node, "pad") : [it.node];
    for (const p of probe) { const n = netOf(p); if (n.code > 0 && n.name) byCode.set(n.code, n.name); if (n.name && !byName.has(n.name)) byName.set(n.name, n); }
    if (it.kind === "zone") { const nn = K.kid(it.node, "net_name"), n = netOf(it.node); if (nn && n.code > 0 && !byCode.has(n.code)) byCode.set(n.code, K.str(nn[1])); }
  }
  return { byCode, byName, key(net) { if (!net) return ""; if (net.name) return net.name; if (net.code > 0) return byCode.get(net.code) || "#" + net.code; return ""; } };
}
/** Every piece of copper on the board as a shape on a layer set with a net: pads, tracks, arcs, vias and zone fills. */
function conductors(doc) {
  const NT = netTable(doc); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const out = [];
  const push = (c) => { c.bbox = shapeBBox(c.shape); out.push(c); };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "footprint") {
      padsOf(it).forEach((p) => {
        const layers = padCopperLayers(p, copper); if (!layers.size || p.type === "np_thru_hole") return;
        push({ id: it.id, kind: "pad", item: it, pad: p, index: p.index, net: NT.key(p.net), netObj: p.net, layers, shape: padShape(p), anchors: [[p.x, p.y]] });
      });
    } else if (it.kind === "segment") {
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue; const w = widthOf(n, 0.25);
      push({ id: it.id, kind: "segment", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: new Set([layerOf(n)]), shape: { t: "seg", a, b, r: w / 2 }, anchors: [a, b], length: Math.hypot(b[0] - a[0], b[1] - a[1]), width: w });
    } else if (it.kind === "arc") {
      const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); if (!a || !m || !b) continue; const w = widthOf(n, 0.25); const arc = K.arcFrom3(a, m, b);
      push({ id: it.id, kind: "arc", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: new Set([layerOf(n)]), shape: { t: "path", pts: arc ? arcPoints(arc, a, b) : [a, b], r: w / 2 }, anchors: [a, b], length: arc ? arcLength(arc) : Math.hypot(b[0] - a[0], b[1] - a[1]), width: w });
    } else if (it.kind === "via") {
      const a = pt(n, "at"); if (!a) continue; const size = K.num((K.kid(n, "size") || [0, 0.8])[1], 0.8), drill = K.num((K.kid(n, "drill") || [0, 0.4])[1], 0.4);
      push({ id: it.id, kind: "via", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: viaLayers(n, copper), shape: { t: "circle", x: a[0], y: a[1], r: size / 2 }, anchors: [a], size, drill });
    } else if (it.kind === "zone" && !K.kid(n, "keepout")) {
      const net = NT.key(netOf(n)); const zl = zoneLayers(n);
      for (const fp of K.kids(n, "filled_polygon")) { const pts = K.ptsOf(fp); if (pts.length < 3) continue; push({ id: it.id, kind: "zone", item: it, net, netObj: netOf(n), layers: new Set([layerOf(fp, zl[0] || "F.Cu")]), shape: { t: "poly", pts }, anchors: [] }); }
    }
  }
  return out;
}
/** Union-find over touching copper on a shared layer; nets must agree, but net-less copper joins whatever it touches (KiCad's propagation). */
function clusterRoots(conds) {
  const parent = conds.map((_, i) => i); const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = conds.map((_, i) => i).sort((i, j) => conds[i].bbox[0] - conds[j].bbox[0]);
  for (let ii = 0; ii < order.length; ii++) {
    const i = order[ii], a = conds[i];
    for (let jj = ii + 1; jj < order.length; jj++) {
      const j = order[jj], b = conds[j]; if (b.bbox[0] > a.bbox[2] + EPS) break;
      if (a.net && b.net && a.net !== b.net) continue;
      if (b.bbox[1] > a.bbox[3] + EPS || b.bbox[3] < a.bbox[1] - EPS || !shareLayer(a.layers, b.layers)) continue;
      if (find(i) === find(j)) continue;
      if (shapeGap(a.shape, b.shape) <= EPS) parent[find(i)] = find(j);
    }
  }
  return conds.map((_, i) => find(i));
}
/**
 * The board's connectivity: nets → their pads / tracks / vias / zones and geometric clusters (islands of copper
 * that touch).  A cluster's ratsnest anchors are its pad and via centres, else its track ends, else fill corners.
 */
function netlist(doc) {
  const conds = conductors(doc); const roots = clusterRoots(conds);
  const byRoot = new Map();
  conds.forEach((c, i) => { let cl = byRoot.get(roots[i]); if (!cl) { cl = { items: [], nets: new Set(), net: "" }; byRoot.set(roots[i], cl); } cl.items.push(c); if (c.net) cl.nets.add(c.net); });
  const NT = netTable(doc); const nets = new Map();
  const netEntry = (key) => { let e = nets.get(key); if (!e) { const n = NT.byName.get(key); e = { key, name: key, code: n && n.code > 0 ? n.code : 0, pads: [], tracks: [], vias: [], zones: [], clusters: [], shorts: [] }; nets.set(key, e); } return e; };
  for (const c of conds) if (c.net) { const e = netEntry(c.net); (c.kind === "pad" ? e.pads : c.kind === "via" ? e.vias : c.kind === "zone" ? e.zones : e.tracks).push(c); }
  const clusters = [];
  for (const cl of byRoot.values()) {
    const padNet = cl.items.find((c) => c.kind === "pad" && c.net); cl.net = padNet ? padNet.net : (cl.nets.values().next().value || "");
    const pick = (kinds) => { const out = []; for (const c of cl.items) if (kinds.includes(c.kind)) for (const p of c.anchors) out.push({ p, id: c.id }); return out; };
    let anchors = pick(["pad", "via", "segment", "arc"]);
    if (!anchors.length) for (const c of cl.items) if (c.kind === "zone") { const step = Math.max(1, Math.ceil(c.shape.pts.length / 32)); for (let i = 0; i < c.shape.pts.length; i += step) anchors.push({ p: c.shape.pts[i], id: c.id }); }
    cl.anchors = anchors; clusters.push(cl);
    if (cl.net) { const e = netEntry(cl.net); e.clusters.push(cl); if (cl.nets.size > 1) e.shorts.push(cl); }
  }
  for (const e of nets.values()) e.unconnected = Math.max(0, e.clusters.filter((c) => c.anchors.length).length - 1);
  return { conductors: conds, clusters, nets, table: NT };
}
function nearestAnchors(c1, c2) {
  let best = [Infinity, null, null];
  for (const a of c1.anchors) for (const b of c2.anchors) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (d < best[0]) best = [d, a, b]; }
  return best;
}
/** KiCad's ratsnest: per net, the minimum spanning tree over its clusters through their nearest anchors. */
function ratsnest(doc, nl) {
  nl = nl || netlist(doc); const lines = [];
  for (const net of nl.nets.values()) {
    const cls = net.clusters.filter((c) => c.anchors.length); if (cls.length < 2) continue;
    const inTree = cls.map(() => false), best = cls.map(() => ({ d: Infinity, a: null, b: null }));
    const update = (k) => { for (let j = 0; j < cls.length; j++) { if (inTree[j]) continue; const [d, a, b] = nearestAnchors(cls[k], cls[j]); if (d < best[j].d) best[j] = { d, a, b }; } };
    inTree[0] = true; update(0);
    for (let n = 1; n < cls.length; n++) {
      let j = -1; for (let i = 0; i < cls.length; i++) if (!inTree[i] && (j < 0 || best[i].d < best[j].d)) j = i;
      inTree[j] = true; const e = best[j]; lines.push({ net: net.key, code: net.code, name: net.name, a: e.a.p.slice(), b: e.b.p.slice(), ids: [e.a.id, e.b.id], length: e.d }); update(j);
    }
  }
  return lines;
}
/** The ratsnest lines that reach a footprint's pads (what KiCad shows while it moves). */
function localRatsnest(doc, footprintId, nl) { return ratsnest(doc, nl).filter((l) => l.ids.includes(footprintId)); }
/** PCB_NET_INSPECTOR_PANEL's rows: per net the pad and via counts, the routed length (arcs by arc length) and the missing connections. */
function netInspector(doc, nl) {
  nl = nl || netlist(doc); const rows = [];
  for (const net of nl.nets.values()) rows.push({ name: net.name, code: net.code, padCount: net.pads.length, viaCount: net.vias.length, trackLength: r6(net.tracks.reduce((s, c) => s + c.length, 0)), zoneCount: new Set(net.zones.map((z) => z.id)).size, unconnected: net.unconnected });
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** Ids of everything on a net: its tracks, arcs, vias, zones and the footprints owning its pads. */
function netItemIds(doc, key, nl) {
  nl = nl || netlist(doc); const net = nl.nets.get(key); const ids = new Set(); if (!net) return ids;
  for (const list of [net.pads, net.tracks, net.vias, net.zones]) for (const c of list) ids.add(c.id);
  return ids;
}
/** What a net highlight brightens (PCB_PAINTER by netcode): the net's tracks, vias and zones by id and each of its
 *  pads as "footprintId#padIndex", so the footprint's other pads and its silk stay dark. */
function netHighlightIds(doc, key, nl) {
  nl = nl || netlist(doc); const net = nl.nets.get(key); const ids = new Set(); if (!net) return ids;
  for (const c of net.pads) ids.add(c.id + "#" + c.index);
  for (const list of [net.tracks, net.vias, net.zones]) for (const c of list) ids.add(c.id);
  return ids;
}
/** Nets of the selection: connected items give theirs, a footprint every net of its pads. */
function selectionNets(ctx, nl) {
  const keys = new Set();
  for (const it of selectedItems(ctx)) {
    if (it.kind === "footprint") { for (const p of padsOf(it)) { const k = nl.table.key(p.net); if (k) keys.add(k); } }
    else if (K.kid(it.node, "net")) { const k = nl.table.key(netOf(it.node)); if (k) keys.add(k); }
  }
  return keys;
}
/** Segments and vias touching the clusters that hold any of the seed items (a pad's footprint counts): KiCad's "Unroute". */
function connectedCopperIds(nl, seedIds) {
  const out = new Set();
  for (const cl of nl.clusters) if (cl.items.some((c) => seedIds.has(c.id))) for (const c of cl.items) if (c.kind === "segment" || c.kind === "arc" || c.kind === "via") out.add(c.id);
  return out;
}

// ---------------------------------------------------------------- design settings and DRC
// BOARD_DESIGN_SETTINGS / NETCLASS defaults (board_design_settings.h, netclass.cpp): what a board without a
// project file is checked against.  Rules can come from the .kicad_pro (parsed JSON) or a legacy board's (setup).
const DEFAULT_SETTINGS = () => ({ clearance: 0.2, edgeClearance: 0.5, trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3, minTrackWidth: 0, minViaDiameter: 0, minViaDrill: 0, netclasses: { Default: { clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 } }, netclassOf: {}, patterns: [], severities: {} });
function designSettings(src) {
  const s = DEFAULT_SETTINGS(); if (!src) return s;
  if (typeof src === "string" && /^\s*\{/.test(src)) { try { src = JSON.parse(src); } catch (e) { return s; } }   // the .kicad_pro as text (the editor's ctx.designSettings)
  if (typeof src === "string") {   // a legacy board's (setup … (net_class …)) block
    let tree = null; try { tree = K.parse(src); } catch (e) { return s; }
    const setup = tree && K.kid(tree, "setup"); if (setup) { for (const [key, prop] of [["clearance", "clearance"], ["trace_clearance", "clearance"], ["edge_clearance", "edgeClearance"], ["copper_edge_clearance", "edgeClearance"], ["trace_min", "minTrackWidth"], ["via_min_size", "minViaDiameter"], ["via_min_drill", "minViaDrill"], ["trace_width", "trackWidth"], ["via_size", "viaDiameter"], ["via_drill", "viaDrill"]]) { const c = K.kid(setup, key); if (c) s[prop] = K.num(c[1], s[prop]); } }
    for (const nc of (tree ? K.kids(tree, "net_class") : [])) { const name = K.str(nc[1]); const e = s.netclasses[name] = Object.assign({}, s.netclasses.Default); for (const [key, prop] of [["clearance", "clearance"], ["trace_width", "track_width"], ["via_dia", "via_diameter"], ["via_drill", "via_drill"]]) { const c = K.kid(nc, key); if (c) e[prop] = K.num(c[1]); } for (const a of K.kids(nc, "add_net")) s.netclassOf[K.str(a[1])] = name; }
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; }
    return s;
  }
  if (src.netclasses || src.clearance !== undefined) return Object.assign(s, src);   // already our shape
  const rules = src.board && src.board.design_settings && src.board.design_settings.rules;   // a .kicad_pro
  const sev = src.board && src.board.design_settings && src.board.design_settings.rule_severities; if (sev) for (const [k, v] of Object.entries(sev)) s.severities[k] = String(v);
  if (rules) { s.minClearance = rules.min_clearance || 0; s.minTrackWidth = rules.min_track_width || 0; s.minViaDiameter = rules.min_via_diameter || 0; s.minViaDrill = rules.min_through_hole_diameter || 0; s.minViaAnnular = rules.min_via_annular_width || 0; if (rules.min_hole_clearance !== undefined) s.holeClearance = rules.min_hole_clearance; if (rules.min_copper_edge_clearance !== undefined) s.edgeClearance = rules.min_copper_edge_clearance; }
  const dflt = src.board && src.board.design_settings && src.board.design_settings.defaults; if (dflt) layerDefaults(dflt);   // Board Setup > Text & Graphics > Defaults: what a new item gets
  const ns = src.net_settings;
  if (ns && isList(ns.classes)) {
    for (const c of ns.classes) if (c && c.name) s.netclasses[c.name] = { clearance: c.clearance !== undefined ? c.clearance : s.clearance, track_width: c.track_width !== undefined ? c.track_width : s.trackWidth, via_diameter: c.via_diameter !== undefined ? c.via_diameter : s.viaDiameter, via_drill: c.via_drill !== undefined ? c.via_drill : s.viaDrill };
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; s.viaDiameter = s.netclasses.Default.via_diameter; s.viaDrill = s.netclasses.Default.via_drill; }
    if (ns.netclass_assignments) for (const [net, cls] of Object.entries(ns.netclass_assignments)) s.netclassOf[net] = cls;
    if (isList(ns.netclass_patterns)) for (const p of ns.netclass_patterns) if (p && p.pattern) s.patterns.push({ re: new RegExp("^" + String(p.pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"), netclass: p.netclass });
  }
  return s;
}
function netclassName(s, net) { const name = net ? (s.netclassOf[net] || (s.patterns.find((p) => p.re.test(net)) || {}).netclass) : null; return name && s.netclasses[name] ? name : "Default"; }
function netclassOf(s, net) { return s.netclasses[netclassName(s, net)] || s.netclasses.Default || { clearance: s.clearance, track_width: s.trackWidth, via_diameter: s.viaDiameter, via_drill: s.viaDrill }; }
const netClearance = (s, net) => { const nc = netclassOf(s, net); return nc && nc.clearance !== undefined ? nc.clearance : s.clearance; };
const mm4 = (v) => v.toFixed(4) + " mm";
/** Edge.Cuts geometry as shapes (lines with their half width) and the polylines they form, board items and footprint drawings alike. */
function edgeShapes(doc) {
  const shapes = [], chains = [];
  const take = (kind, node, tf, layer) => {
    if (layer !== "Edge.Cuts") return; const w = K.kid(node, "stroke") ? K.num((K.kid(K.kid(node, "stroke"), "width") || [0, 0])[1]) : widthOf(node, 0);
    const P = (key) => { const p = pt(node, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) { shapes.push({ t: "seg", a, b, r: w / 2 }); chains.push([a, b]); } }
    else if (kind === "rect") { const a = P("start"), b = P("end"); if (a && b) { const c = tf(pt(node, "start")[0], pt(node, "end")[1]), d = tf(pt(node, "end")[0], pt(node, "start")[1]); const pts = [a, d, b, c]; shapes.push({ t: "path", pts: pts.concat([a]), r: w / 2 }); chains.push(pts.concat([a])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts = []; for (let i = 0; i < 48; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 24), c[1] + r * Math.sin(i * Math.PI / 24)]); pts.push(pts[0].slice()); shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); const pts = arc ? arcPoints(arc, a, b) : [a, b]; shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "poly") { const pts = K.ptsOf(node).map(([x, y]) => tf(x, y)); if (pts.length > 2) { shapes.push({ t: "path", pts: pts.concat([pts[0]]), r: w / 2 }); chains.push(pts.concat([pts[0]])); } }
    else if (kind === "curve") { const pts = K.bezierPts(K.ptsOf(node).map(([x, y]) => tf(x, y))); if (pts.length > 1) { shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
  };
  const id = (x, y) => [x, y];
  for (const it of doc.items.values()) {
    const n = it.node;
    if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)) take(it.kind.slice(3), n, id, layerOf(n, "Dwgs.User"));
    else if (it.kind === "footprint") { const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x, y) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; }; for (const g of n) if (isList(g) && /^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0])) take(g[0].slice(3), g, tf, layerOf(g, "F.SilkS")); }
  }
  return { shapes, chains };
}
/** Join open polylines end to end (0.01 mm) into closed loops; returns the loops and whether anything stayed open. */
function chainLoops(chains, tol) {
  tol = tol || 0.01; const loops = [], open = chains.map((c) => c.slice()); let dangling = false;
  const same = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  while (open.length) {
    let cur = open.pop(); if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) { loops.push(cur.slice(0, -1)); continue; }
    let grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false; const tail = cur[cur.length - 1];
      for (let i = 0; i < open.length; i++) {
        const c = open[i]; if (same(c[0], tail)) { cur = cur.concat(c.slice(1)); open.splice(i, 1); grew = true; break; }
        if (same(c[c.length - 1], tail)) { cur = cur.concat(c.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
      }
    }
    if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) loops.push(cur.slice(0, -1)); else dangling = true;
  }
  return { loops, dangling };
}
const polyArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
/** The board outline: the largest closed Edge.Cuts loop, or null (and whether edges exist that fail to close). */
function boardOutline(doc) {
  const { chains } = edgeShapes(doc); if (!chains.length) return { outline: null, dangling: false, hasEdges: false };
  const { loops, dangling } = chainLoops(chains); let best = null, bestA = 0;
  for (const l of loops) { const a = Math.abs(polyArea(l)); if (a > bestA) { bestA = a; best = l; } }
  return { outline: best, dangling, hasEdges: true, area: bestA };
}
/** A footprint's courtyard polygons per side, chained from its F.CrtYd / B.CrtYd drawings in board coordinates. */
function courtyards(fp) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x, y) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
  const out = { "F.CrtYd": [], "B.CrtYd": [] };
  for (const g of n) {
    if (!isList(g) || !/^fp_(line|rect|circle|arc|poly)$/.test(g[0])) continue; const layer = layerOf(g, ""); if (!out[layer]) continue;
    const kind = g[0].slice(3); const P = (key) => { const p = pt(g, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) out[layer].push([a, b]); }
    else if (kind === "rect") { const s = pt(g, "start"), e = pt(g, "end"); if (s && e) { const pts = [tf(s[0], s[1]), tf(e[0], s[1]), tf(e[0], e[1]), tf(s[0], e[1])]; out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts = []; for (let i = 0; i < 32; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); out[layer].push(arc ? arcPoints(arc, a, b) : [a, b]); } }
    else if (kind === "poly") { const pts = K.ptsOf(g).map(([x, y]) => tf(x, y)); if (pts.length > 2) out[layer].push(pts.concat([pts[0]])); }
  }
  const res = {}; for (const layer of Object.keys(out)) res[layer] = out[layer].length ? chainLoops(out[layer]).loops : [];
  return res;
}
const marker = (code, severity, x, y, text, ids) => ({ code, severity, x: r6(x), y: r6(y), text, ids });
const boxCenter = (a, b) => [(Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2, (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2];
/**
 * The DRC subset: copper clearance (pads, tracks, arcs, vias against different nets on a shared layer), copper to
 * board edge, missing connections (from the ratsnest), shorts, zero-length and dangling tracks, via annular
 * width, courtyard overlaps and items outside the outline.  Returns markers [{ x, y, severity, text, ids, code }].
 */
function drc(doc, settings, opts) {
  const s = settings && settings.netclasses ? settings : designSettings(settings); opts = opts || {}; const out = [];
  const nl = netlist(doc); const conds = nl.conductors.filter((c) => c.kind !== "zone");
  const clr = (c) => netClearance(s, c.net); const maxClr = Math.max(s.clearance, s.minClearance || 0, ...Object.values(s.netclasses).map((n) => n.clearance || 0), s.edgeClearance);
  // copper clearance
  const order = conds.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j]; if (b.bbox[0] > a.bbox[2] + maxClr) break;
      if (a.net && a.net === b.net) continue; if (!shareLayer(a.layers, b.layers)) continue;
      const need = Math.max(clr(a), clr(b), s.minClearance || 0); if (!boxesTouch(a.bbox, b.bbox, need)) continue;   // Board Setup > Constraints: the board minimum is a floor
      const gap = shapeGap(a.shape, b.shape); if (gap >= need - DRC_EPS) continue;
      const cls = clr(a) >= clr(b) ? netclassName(s, a.net) : netclassName(s, b.net);   // the stricter class of the pair names the rule
      const [x, y] = boxCenter(a.bbox, b.bbox);
      out.push(marker("clearance", "error", x, y, `Clearance violation (netclass '${cls}' clearance ${mm4(need)}; actual ${mm4(gap)})`, Array.from(new Set([a.id, b.id]))));
    }
  }
  // copper to board edge
  const edges = edgeShapes(doc);
  if (edges.shapes.length && s.edgeClearance > 0) {
    const eb = edges.shapes.map((e) => shapeBBox(e));
    for (const c of conds) for (let i = 0; i < edges.shapes.length; i++) {
      if (!boxesTouch(c.bbox, eb[i], s.edgeClearance)) continue; const gap = shapeGap(c.shape, edges.shapes[i]); if (gap >= s.edgeClearance - DRC_EPS) continue;
      const [x, y] = boxCenter(c.bbox, eb[i]); out.push(marker("copper_edge_clearance", "error", x, y, `Board edge clearance violation (board setup constraints edge clearance ${mm4(s.edgeClearance)}; actual ${mm4(gap)})`, [c.id])); break;
    }
  }
  // connectivity
  if (opts.unconnected !== false) for (const l of ratsnest(doc, nl)) out.push(marker("unconnected_items", "error", l.a[0], l.a[1], `Missing connection between items (net '${l.name}')`, l.ids.slice()));
  for (const net of nl.nets.values()) for (const cl of net.shorts) { const p = cl.anchors[0] ? cl.anchors[0].p : [0, 0]; out.push(marker("shorting_items", "error", p[0], p[1], `Items shorting two nets (${Array.from(cl.nets).join(", ")})`, Array.from(new Set(cl.items.map((c) => c.id))))); }
  // tracks and vias
  const touches = (p, layer, self) => conds.some((c) => c !== self && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS)
    || nl.conductors.some((c) => c.kind === "zone" && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && pointInPoly(c.shape.pts, p[0], p[1]));
  for (const c of conds) {
    if (c.kind === "segment" || c.kind === "arc") {
      const [a, b] = c.anchors; const layer = c.layers.values().next().value;
      if (c.length < EPS) { out.push(marker("zero_length", "warning", a[0], a[1], "Zero-length track", [c.id])); continue; }
      const loose = [a, b].find((p) => !touches(p, layer, c)); if (loose) out.push(marker("track_dangling", "warning", loose[0], loose[1], "Track has unconnected end", [c.id]));   // one marker per track, like DRCE_DANGLING_TRACK
      if (s.minTrackWidth > 0 && c.width < s.minTrackWidth - 1e-6) out.push(marker("track_width", "error", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, `Track width (board setup constraints min width ${mm4(s.minTrackWidth)}; actual ${mm4(c.width)})`, [c.id]));
    } else if (c.kind === "via") {
      const [a] = c.anchors;
      if (c.drill >= c.size - 1e-6) out.push(marker("annular_width", "error", a[0], a[1], `Annular width (drill ${mm4(c.drill)} is not smaller than the via diameter ${mm4(c.size)})`, [c.id]));
      else { if (s.minViaDiameter > 0 && c.size < s.minViaDiameter - 1e-6) out.push(marker("via_diameter", "error", a[0], a[1], `Via diameter (board setup constraints min diameter ${mm4(s.minViaDiameter)}; actual ${mm4(c.size)})`, [c.id])); if (s.minViaDrill > 0 && c.drill < s.minViaDrill - 1e-6) out.push(marker("drill_out_of_range", "error", a[0], a[1], `Hole size out of range (board setup constraints min ${mm4(s.minViaDrill)}; actual ${mm4(c.drill)})`, [c.id])); }
      if (!conds.some((o) => o !== c && o.id !== c.id && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS) && !nl.conductors.some((o) => o.kind === "zone" && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS)) out.push(marker("via_dangling", "warning", a[0], a[1], "Via is not connected or connected on only one layer", [c.id]));
    }
  }
  // courtyards
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint"); const cy = fps.map((fp) => courtyards(fp));
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
    if (!fps[i].bbox || !fps[j].bbox || !boxesTouch(fps[i].bbox, fps[j].bbox, 0)) continue;
    for (const layer of ["F.CrtYd", "B.CrtYd"]) { let hit = false; for (const P of cy[i][layer]) for (const Q of cy[j][layer]) if (polysOverlap(P, Q)) hit = true; if (hit) { const [x, y] = boxCenter(fps[i].bbox, fps[j].bbox); out.push(marker("courtyards_overlap", "error", x, y, `Courtyards overlap (${fps[i].ref || "footprint"} and ${fps[j].ref || "footprint"} on ${layer})`, [fps[i].id, fps[j].id])); } }
  }
  // outline
  const ol = boardOutline(doc);
  if (ol.hasEdges && !ol.outline) { const e = edges.shapes[0]; const p = e.a || e.pts[0]; out.push(marker("invalid_outline", "error", p[0], p[1], "Board has malformed outline (Edge.Cuts does not close)", [])); }
  else if (ol.outline && opts.outline !== false) {
    const seen = new Set();
    for (const c of nl.conductors) { if (seen.has(c.id) || c.kind === "zone") continue; const p = c.kind === "pad" ? [c.pad.x, c.pad.y] : c.anchors[0]; if (p && !pointInPoly(ol.outline, p[0], p[1])) { seen.add(c.id); out.push(marker("outside_outline", "warning", p[0], p[1], `Item outside board outline (${c.kind === "pad" ? (c.item.ref || "footprint") : c.kind})`, [c.id])); } }
  }
  // the project's rule severities: ignored rules drop out, the rest take the severity the project gives them
  return out.filter((m) => s.severities[m.code] !== "ignore").map((m) => { const sev = s.severities[m.code]; if (sev === "warning" || sev === "error") m.severity = sev; return m; });
}

// ---------------------------------------------------------------- interactive router: KiCad's default Walk around mode
// ROUTING_SETTINGS' defaults (pns_routing_settings.cpp): mode RM_Walkaround, start_diagonal false, auto_posture true,
// no DRC violations allowed.  Every pointer move walks the head line from the last fixed point to the cursor around
// other nets' copper (pads, tracks, arcs, vias), NPTH holes, Edge.Cuts and rule areas that keep tracks out, each
// inflated by the clearance the design rules give the pair plus half the track width.  Zone fills are not obstacles
// (PNS does not model them).  When the cursor cannot be reached the head stops at the reachable point closest to it.
const ROUTE_EPS = 1e-4;      // a gap this much short of the rule still passes (the router's clearance epsilon)
const HULL_EPS = 2e-3;       // hull corners sit this far outside the clearance boundary
const DIRS8 = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2], [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]];
const octile = (a, b) => { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
function shapeCorePts(s) { return s.t === "circle" ? [[s.x, s.y]] : s.t === "seg" ? [s.a, s.b] : s.t === "rect" ? rectCore(s) : s.pts; }

/** The board's copper and other routing obstacles, rebuilt when the document changes. */
function routerWorld(doc) {
  if (S.rworld && S.rworld.doc === doc && S.rworld.ver === S.docVer) return S.rworld;
  const copper = copperOf(doc); const conds = conductors(doc).filter((c) => c.kind !== "zone");
  const holes = [], keepouts = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        if (p.type !== "np_thru_hole") continue;
        const d = K.kid(p.node, "drill"); let w = p.w, h = p.h;
        if (d) { if (K.str(d[1]) === "oval") { w = K.num(d[2], w); h = K.num(d[3], w); } else { w = h = K.num(d[1], w); } }
        const shape = padShape(Object.assign({}, p, { w, h, shape: Math.abs(w - h) < 1e-9 ? "circle" : "oval" }));
        holes.push({ id: it.id, kind: "hole", pad: p, layers: new Set(copper), shape, bbox: shapeBBox(shape) });
      }
    } else if (it.kind === "zone" && K.kid(it.node, "keepout")) {
      const ko = K.kid(it.node, "keepout"); const tr = K.kid(ko, "tracks"); if (!tr || K.str(tr[1]) !== "not_allowed") continue;
      const layers = new Set(); for (const l of zoneLayers(it.node)) { if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => layers.add(c)); else layers.add(l); }
      const poly = K.kid(it.node, "polygon"); const pts = poly ? K.ptsOf(poly) : []; if (pts.length < 3) continue;
      const shape = { t: "poly", pts }; keepouts.push({ id: it.id, kind: "keepout", layers, shape, bbox: shapeBBox(shape) });
    }
  }
  const edges = edgeShapes(doc).shapes.map((shape) => ({ id: null, kind: "edge", shape, bbox: shapeBBox(shape) }));
  S.rworld = { doc, ver: S.docVer, conds, holes, keepouts, edges, copper };
  return S.rworld;
}
/** PNS_PCBNEW_RULE_RESOLVER::Clearance for the routed net against an obstacle (the larger netclass clearance, floored at the board minimum). */
function routeClearance(s, netKey, ob) {
  const minC = s.minClearance || 0; const mine = Math.max(netClearance(s, netKey), minC);
  if (ob.kind === "edge") return s.edgeClearance || 0;
  if (ob.kind === "hole") return Math.max(s.holeClearance !== undefined ? s.holeClearance : 0.25, mine);
  if (ob.kind === "keepout") return 0;
  return Math.max(mine, netClearance(s, ob.net), minC);
}
/**
 * The obstacles a route on `layer` meets: everything on the layer that is not the routed net's copper.  Pads without a
 * net are free pads (they collide with nothing); other net-less copper collides with every route but the route's own
 * items (`own`: the start item and the fixed segments of a route that has no net).
 */
function routeObstacles(doc, s, netKey, layer, own) {
  const W = routerWorld(doc); const out = [];
  const take = (o, net) => { const ob = { id: o.id, kind: o.kind, net: net || "", shape: o.shape, bbox: o.bbox, src: o }; ob.clr = routeClearance(s, netKey, ob); out.push(ob); };
  for (const c of W.conds) {
    if (!c.layers.has(layer)) continue;
    if (netKey && c.net === netKey) continue;
    if (c.kind === "pad" && !c.net) continue;
    if (own && own.has(c.id) && c.kind !== "pad") continue;
    take(c, c.net);
  }
  for (const h of W.holes) take(h, "");
  for (const k of W.keepouts) if (k.layers.has(layer)) take(k, "");
  for (const e of W.edges) take(e, "");
  // a coarse grid so a leg only meets the obstacles near it
  const CELL = 2.5, grid = new Map(); let maxClr = 0;
  out.forEach((ob, i) => {
    maxClr = Math.max(maxClr, ob.clr); const b = ob.bbox;
    for (let gx = Math.floor((b[0] - ob.clr) / CELL); gx <= Math.floor((b[2] + ob.clr) / CELL); gx++) for (let gy = Math.floor((b[1] - ob.clr) / CELL); gy <= Math.floor((b[3] + ob.clr) / CELL); gy++) {
      const key = gx + "," + gy; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(i);
    }
  });
  return { list: out, grid, CELL, maxClr, stamp: new Uint32Array(out.length), tick: 0 };
}
/** Obstacles whose clearance zone may reach the box [x0, y0, x1, y1] grown by r. */
function obstaclesNear(O, box, r, fn) {
  const C = O.CELL; O.tick++; if (O.tick > 4e9) { O.stamp.fill(0); O.tick = 1; }
  for (let gx = Math.floor((box[0] - r) / C); gx <= Math.floor((box[2] + r) / C); gx++) for (let gy = Math.floor((box[1] - r) / C); gy <= Math.floor((box[3] + r) / C); gy++) {
    const l = O.grid.get(gx + "," + gy); if (!l) continue;
    for (const i of l) { if (O.stamp[i] === O.tick) continue; O.stamp[i] = O.tick; const ob = O.list[i]; if (!boxesTouch(box, ob.bbox, r + ob.clr)) continue; if (fn(ob)) return ob; }
  }
  return null;
}
/** Does a track of half width r along a..b (a point when a === b) violate an obstacle's clearance? */
function obstacleHit(ob, a, b, r) {
  const sh = samePt(a, b) ? { t: "circle", x: a[0], y: a[1], r } : { t: "seg", a, b, r };
  if (ob.kind === "keepout") return pointInPoly(ob.shape.pts, a[0], a[1]) || pointInPoly(ob.shape.pts, b[0], b[1]) || polySegDist(ob.shape.pts, a, b) < r - ROUTE_EPS;
  return shapeGap(sh, ob.shape) < ob.clr - ROUTE_EPS;
}
/** The first obstacle a segment hits (null when clear). */
function segHit(O, a, b, r) {
  const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  return obstaclesNear(O, box, r, (ob) => obstacleHit(ob, a, b, r));
}
/** Every obstacle a polyline (or one point) at half width r violates. */
function pathHits(O, pts, r) {
  const out = new Set();
  const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(0, -1).map((p, i) => [p, pts[i + 1]]);
  for (const [a, b] of segs) { const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; obstaclesNear(O, box, r, (ob) => { if (!out.has(ob) && obstacleHit(ob, a, b, r)) out.add(ob); return false; }); }
  return Array.from(out);
}
const pathClear = (O, pts, r) => { if (pts.length === 1) return !segHit(O, pts[0], pts[0], r); for (let i = 0; i + 1 < pts.length; i++) if (segHit(O, pts[i], pts[i + 1], r)) return false; return true; };
/** The 45° octagon around an obstacle's clearance zone for a track of half width r: where the walk turns. */
function hullOf(ob, r) {
  const key = r.toFixed(6); if (ob.hullKey === key) return ob.hull;
  const core = shapeCorePts(ob.shape), off = (ob.kind === "keepout" ? 0 : shapeOffset(ob.shape) + ob.clr) + r + HULL_EPS;
  const h = DIRS8.map((u) => { let m = -Infinity; for (const p of core) m = Math.max(m, p[0] * u[0] + p[1] * u[1]); return m + off; });
  const out = [];
  for (let k = 0; k < 8; k++) {
    const u0 = DIRS8[k], u1 = DIRS8[(k + 1) % 8], h0 = h[k], h1 = h[(k + 1) % 8]; const det = u0[0] * u1[1] - u0[1] * u1[0];
    out.push([(h0 * u1[1] - h1 * u0[1]) / det, (u0[0] * h1 - u1[0] * h0) / det]);
  }
  ob.hullKey = key; ob.hull = out; return out;
}
/** DIRECTION_45 of a vector: 0 = E, 1 = SE (y down), … 7 = NE; -1 for a null vector. */
function dir8(a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return -1; return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8; }
/** DIRECTION_45::Angle: 0 straight, 1 obtuse, 2 right, 3 acute, 4 half full (a U-turn). */
const dirAngle = (d1, d2) => { const d = Math.abs(d1 - d2) % 8; return d > 4 ? 8 - d : d; };
const isDiagDir = (d) => d >= 0 && d % 2 === 1;
/** A leg as a point list (routeLeg's segments joined). */
function legPts(a, b, diagFirst) { const segs = routeLeg(a, b, diagFirst); return segs.length ? [segs[0][0]].concat(segs.map((s) => s[1])) : [a.slice()]; }
/** SHAPE_LINE_CHAIN::Simplify: drop repeated points and merge colinear segments. */
function simplifyPts(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    if (out.length >= 2) { const a = out[out.length - 2], b = out[out.length - 1]; if (dir8(a, b) === dir8(b, p) && Math.abs((b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])) < 1e-9) { out[out.length - 1] = p.slice(); continue; } }
    out.push(p.slice());
  }
  return out;
}
/** The point of a polyline at arc length t. */
function alongPts(pts, t) {
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (t <= L || i + 2 === pts.length) { const k = L > 0 ? Math.min(1, t / L) : 0; return { i, p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] }; } t -= L; }
  return { i: 0, p: pts[0].slice() };
}
const ptsLength = (pts) => { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return L; };
/** A clear polyline cut where it first violates clearance (cursorDistMinimum's fallback: the head just stops short). */
function clipPts(O, pts, r) {
  if (segHit(O, pts[0], pts[0], r)) return [pts[0].slice()];
  let lo = 0, hi = ptsLength(pts);
  const clearTo = (t) => { const { i, p } = alongPts(pts, t); return pathClear(O, pts.slice(0, i + 1).concat([p]), r); };
  if (clearTo(hi)) return pts.map((p) => p.slice());
  for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (clearTo(m)) lo = m; else hi = m; }
  const { i, p } = alongPts(pts, lo); return simplifyPts(pts.slice(0, i + 1).concat([[r6(p[0]), r6(p[1])]]));
}
/**
 * WALKAROUND: a 45° line from `start` to `goal` that keeps clear of every obstacle.  The posture line comes first;
 * when it is blocked the walk turns at the corners of the obstacles' octagonal hulls (both ways round, the shorter
 * wins), growing the set of obstacles it walks around until the goal is reached.  Returns the points or null.
 */
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
function walkTo(O, start, goal, r, diagFirst, lastDir, deadline) {
  deadline = deadline || now() + 40;
  const first = legPts(start, goal, diagFirst); if (pathClear(O, first, r)) return first;
  const second = legPts(start, goal, !diagFirst); if (pathClear(O, second, r)) return second;
  const active = new Set(pathHits(O, first, r).concat(pathHits(O, second, r)));
  const legMemo = new Map();   // clear legs between two points (either posture), shared by the rounds
  for (let round = 0; round < 8 && active.size; round++) {
    const nodes = [start, goal];
    for (const ob of active) for (const v of hullOf(ob, r)) if (!segHit(O, v, v, r)) nodes.push(v);
    if (nodes.length > 400) break;
    const blockers = new Set();
    const leg = (i, j) => {   // the clear leg between two nodes (either posture), or null
      const a = nodes[Math.min(i, j)], b = nodes[Math.max(i, j)]; const key = a[0] + "," + a[1] + ":" + b[0] + "," + b[1];
      let m = legMemo.get(key);
      if (!m) {
        m = { pts: null, hits: [] };
        for (const df of [false, true]) {
          const pts = legPts(a, b, df); let hit = null;
          for (let k = 0; k + 1 < pts.length && !hit; k++) hit = segHit(O, pts[k], pts[k + 1], r);
          if (!hit) { m.pts = pts; break; } m.hits.push(hit);
        }
        legMemo.set(key, m);
      }
      for (const h of m.hits) blockers.add(h);
      return m.pts && (i < j ? m.pts : m.pts.slice().reverse());
    };
    // lazy A* over the hull corners (octile lengths): a node's leg from its parent is only checked when it is taken
    const n = nodes.length, g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    g[0] = 0; let found = false; const closed = [];
    for (let iter = 0; iter < 4 * n; iter++) {
      if (now() > deadline) return null;
      let u = -1, bf = Infinity; for (let i = 0; i < n; i++) if (!done[i] && g[i] < Infinity) { const f = g[i] + octile(nodes[i], goal); if (f < bf) { bf = f; u = i; } }
      if (u < 0) break;
      if (u !== 0 && !leg(from[u], u)) {   // its optimistic parent cannot see it: the best closed node that can, if any
        let bp = -1, bc = Infinity;
        const order = closed.filter((c) => c !== from[u]).sort((x, y) => (g[x] + octile(nodes[x], nodes[u])) - (g[y] + octile(nodes[y], nodes[u])));
        for (const c of order.slice(0, 12)) if (leg(c, u)) { bp = c; bc = g[c] + octile(nodes[c], nodes[u]) + 1e-3; break; }
        if (bp < 0) { g[u] = Infinity; from[u] = -1; continue; }
        from[u] = bp; g[u] = bc;
      }
      done[u] = 1; closed.push(u); if (u === 1) { found = true; break; }
      for (let v = 1; v < n; v++) { if (done[v]) continue; const c = g[u] + octile(nodes[u], nodes[v]) + 1e-3; if (c < g[v]) { g[v] = c; from[v] = u; } }
    }
    if (found) {
      let seq = []; for (let v = 1; v >= 0; v = from[v]) seq.unshift(v);
      // pull the line tight (the optimizer's MERGE_SEGMENTS): skip corners a direct leg can do without
      const tight = [seq[0]]; let i = 0;
      while (i < seq.length - 1) { let j = seq.length - 1; while (j > i + 1 && !leg(seq[i], seq[j])) j--; tight.push(seq[j]); i = j; }
      // each leg in the posture that continues the previous segment best
      let pts = [start.slice()], prev = lastDir;
      for (let k = 0; k + 1 < tight.length; k++) {
        const a = nodes[tight[k]], b = nodes[tight[k + 1]]; const cands = [];
        for (const df of (k === 0 ? [diagFirst, !diagFirst] : [false, true])) { const p = legPts(a, b, df); if (pathClear(O, p, r)) cands.push(p); }
        if (!cands.length) { cands.push(leg(tight[k], tight[k + 1])); }
        let best = cands[0];
        if (prev >= 0 && cands.length > 1) { const score = (p) => dirAngle(prev, dir8(p[0], p[1])); if (score(cands[1]) < score(cands[0])) best = cands[1]; }
        pts = pts.concat(best.slice(1)); prev = dir8(best[best.length - 2], best[best.length - 1]);
      }
      return simplifyPts(pts);
    }
    let grew = false; for (const b of blockers) if (!active.has(b)) { active.add(b); grew = true; }
    if (!grew) break;
  }
  return null;
}
/**
 * LINE_PLACER::routeHead in Walk around: the clear line towards the cursor.  An unreachable cursor (inside another
 * net's clearance, or walled in) gives the reachable point nearest to it.  { pts, reached }.
 */
function walkHead(O, start, goal, r, diagFirst, lastDir) {
  const deadline = now() + 35;   // a mouse move must stay interactive: past this the head just stops short
  if (samePt(start, goal)) return { pts: [start.slice()], reached: true };
  if (segHit(O, start, start, r)) return { pts: [start.slice()], reached: false };
  if (!segHit(O, goal, goal, r)) { const p = walkTo(O, start, goal, r, diagFirst, lastDir, deadline); if (p) return { pts: p, reached: true }; }
  // the cursor sits in a clearance zone (or no walk reaches it): try the hull edges nearest to it, then clip
  const cands = [];
  obstaclesNear(O, [goal[0], goal[1], goal[0], goal[1]], r, (ob) => {
    if (!obstacleHit(ob, goal, goal, r)) return false; const H = hullOf(ob, r);
    for (let i = 0; i < 8; i++) { const a = H[i], b = H[(i + 1) % 8]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((goal[0] - a[0]) * dx + (goal[1] - a[1]) * dy) / l2)) : 0; cands.push([a[0] + k * dx, a[1] + k * dy]); }
    return false;
  });
  const options = [];
  const clip = clipPts(O, legPts(start, goal, diagFirst), r); options.push(clip);
  cands.sort((p, q) => Math.hypot(p[0] - goal[0], p[1] - goal[1]) - Math.hypot(q[0] - goal[0], q[1] - goal[1]));
  let tried = 0;
  for (const c of cands) { if (tried >= 2 || now() > deadline) break; if (segHit(O, c, c, r)) continue; tried++; const p = walkTo(O, start, [r6(c[0]), r6(c[1])], r, diagFirst, lastDir, deadline); if (p) options.push(p); }
  const dist = (p) => { const e = p[p.length - 1]; return Math.hypot(e[0] - goal[0], e[1] - goal[1]); };
  options.sort((a, b) => dist(a) - dist(b) || ptsLength(a) - ptsLength(b));
  return { pts: options[0], reached: false };
}

// ---------------------------------------------------------------- MOUSE_TRAIL_TRACER: the posture follows the mouse
function newTracer(tol, lastSegDir) {
  const t = { trail: [], tol, direction: lastSegDir >= 0 ? lastSegDir : 0, lastSegDir: lastSegDir >= 0 ? lastSegDir : -1, forced: false, manuallyForced: false };
  return t;
}
function trailAdd(t, p) {
  const tr = t.trail;
  if (tr.length >= 1) {
    const last = tr[tr.length - 1];
    if (tr.length - 1 > 2) {
      const lim = t.tol;
      for (let i = 0; i < tr.length - 1 - 2; i++) if (segSegDist(tr[i], tr[i + 1], last, p) <= lim) { tr.length = i + 1; break; }
    }
  }
  tr.push(p.slice());
  t.trail = simplifyPts(tr);
}
const polyAreaAbs = (pts) => Math.abs(polyArea(pts));
/** MOUSE_TRAIL_TRACER::GetPosture: the direction the first segment from the trail's start takes towards p. */
function tracerPosture(t, p) {
  if (t.trail.length < 2 || t.manuallyForced) { if (!t.manuallyForced && t.lastSegDir >= 0) t.direction = t.lastSegDir; return t.direction; }
  const p0 = t.trail[0]; const refLength = Math.hypot(p[0] - p0[0], p[1] - p0[1]);
  const rev = t.trail.slice().reverse();
  const straight = simplifyPts(legPts(p0, p, false).concat(rev)), diag = simplifyPts(legPts(p0, p, true).concat(rev));
  const areaS = polyAreaAbs(straight), areaD = polyAreaAbs(diag);
  const IU = 1e6;   // KiCad's areas are in nm² and the ratio's +1 is one nm²
  const ratio = (areaS * IU * IU) / (areaD * IU * IU + 1);
  if (t.forced && refLength < 10 * t.tol) { t.forced = false; t.trail = [p0.slice()]; }
  let areaOk = false;
  if (!t.forced && refLength > 6 * t.tol) { if (polyAreaAbs(t.trail) > t.tol * refLength) areaOk = true; }
  const straightDir = dir8(straight[0], straight[1]), diagDir = dir8(diag[0], diag[1]);
  let nd;
  if (!t.forced && areaOk && ratio > 1.3 + 0.25) nd = diagDir;
  else if (!t.forced && areaOk && ratio < 1 / 1.3 - 0.25) nd = straightDir;
  else nd = isDiagDir(t.direction) ? diagDir : straightDir;
  t.direction = nd;
  if (!t.manuallyForced && t.lastSegDir >= 0) {
    if (straightDir === t.lastSegDir) t.direction = straightDir;
    else if (diagDir === t.lastSegDir) t.direction = diagDir;
    else {
      const ang = dirAngle(t.direction, t.lastSegDir); const cand = isDiagDir(t.direction) ? straightDir : diagDir;
      if (ang === 4) t.direction = cand;
      else if (ang === 3) { if (dirAngle(cand, t.lastSegDir) === 2) t.direction = cand; }
      else if (ang === 2) { if (dirAngle(cand, t.lastSegDir) === 1) t.direction = cand; }
    }
  }
  if (!t.forced && refLength > 30 * t.tol) t.forced = true;
  return t.direction;
}
/** MOUSE_TRAIL_TRACER::FlipPosture ('/'): the other posture, held until the next fix. */
function tracerFlip(t, currentFirstDir) {
  if (!t.manuallyForced && currentFirstDir >= 0) { t.direction = currentFirstDir; t.lastSegDir = -1; }   // LINE_PLACER::FlipPosture: from the line as drawn
  t.direction = (t.direction + 1) % 8;   // DIRECTION_45::Right(): one 45° step, so straight and diagonal swap
  t.forced = true; t.manuallyForced = true;
}

// ---------------------------------------------------------------- track editing: widths, layers, cleanup, break, unroute
function trackEditChanges(doc, ids, edit, settings) {
  const s = settings || designSettings(null); const NT = netTable(doc);
  return transformChanges(doc, ids, (n, it) => {
    if (it.kind === "segment" || it.kind === "arc") {
      let w = edit.width; if (edit.netclass) w = netclassOf(s, NT.key(netOf(n))).track_width; if (!(w > 0)) return false;
      const wn = K.kid(n, "width"); if (wn) wn[1] = r6(w); else n.splice(n.indexOf(K.kid(n, "layer")), 0, ["width", r6(w)]);
    } else if (it.kind === "via") {
      let size = edit.viaSize, drill = edit.viaDrill; if (edit.netclass) { const nc = netclassOf(s, NT.key(netOf(n))); size = nc.via_diameter; drill = nc.via_drill; }
      let did = false;
      if (size > 0) { const sn = K.kid(n, "size"); if (sn) sn[1] = r6(size); did = true; } if (drill > 0) { const dn = K.kid(n, "drill"); if (dn) dn[1] = r6(drill); did = true; }
      if (edit.viaLayers && edit.viaLayers.length === 2) { const ls = K.kid(n, "layers"); if (ls) ls.splice(1, ls.length - 1, ...edit.viaLayers); did = true; }
      if (edit.viaType) { for (const t of ["blind", "micro", "buried"]) { const i = n.indexOf(t); if (i > 0) n.splice(i, 1); } if (edit.viaType !== "through") n.splice(1, 0, edit.viaType); did = true; }
      if (!did) return false;
    } else return false;
  });
}
/** Move tracks / arcs / vias' layer pair to the copper layer n steps up or down the stack (Ctrl++ / Ctrl+-). */
function trackLayerChanges(doc, ids, step, toLayer) {
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  return transformChanges(doc, ids, (n, it) => {
    if (it.kind !== "segment" && it.kind !== "arc") return false;
    const l = K.kid(n, "layer"); const i = copper.indexOf(K.str(l[1])); const target = toLayer || copper[Math.max(0, Math.min(copper.length - 1, i + step))];
    if (!target || target === K.str(l[1])) return false; l[1] = target;
  });
}
/** BREAK_TRACK at a point: the segment nearest the cursor splits there into two (the second with a fresh uuid). */
function breakTrackChanges(doc, p, seg) {
  seg = seg || (() => { const it = hitTestItem(doc, p[0], p[1], 0.3); return it && it.kind === "segment" ? it : null; })(); if (!seg) return [];
  const a = pt(seg.node, "start"), b = pt(seg.node, "end"); const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; if (L2 < 1e-12) return [];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2)); if (t < 1e-4 || t > 1 - 1e-4) return [];
  const m = [r6(a[0] + t * (b[0] - a[0])), r6(a[1] + t * (b[1] - a[1]))];
  const first = clone(seg.node); K.kid(first, "end").splice(1, 2, m[0], m[1]);
  const second = clone(seg.node); K.kid(second, "start").splice(1, 2, m[0], m[1]); const u = K.kid(second, "uuid"); if (u) second.splice(second.indexOf(u), 1);
  return [replacedChange(seg, first), addedChange(doc, second)];
}
/**
 * TRACKS_CLEANER: a dry plan of what "Cleanup Tracks & Vias" would do with KiCad's options — shorting tracks,
 * redundant vias, collinear merges (and contained / duplicate segments), zero-length segments, dangling ends
 * (iterated) and tracks fully inside pads.  { remove: Set, replace: [{item, node}], items: [{code, text, ids}] }.
 */
function cleanupPlan(doc, opts) {
  opts = Object.assign({ shorts: true, vias: true, merge: true, dangling: true, danglingVias: true, inPads: true }, opts || {});
  const remove = new Set(), replace = new Map(), items = []; const report = (code, text, ids) => items.push({ code, text, ids });
  const alive = (c) => !remove.has(c.id);
  let conds = conductors(doc); const tracks = () => conds.filter((c) => (c.kind === "segment" || c.kind === "arc") && alive(c));
  const nodeOf = (c) => replace.get(c.id) || c.item.node; const layerOfC = (c) => c.layers.values().next().value;
  const near = (p, q) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
  const touchesPt = (p, layer, self) => conds.filter(alive).some((c) => c !== self && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS);
  // zero length
  for (const c of tracks()) if (c.kind === "segment" && c.length < EPS) { remove.add(c.id); report("null_segment", "Remove zero-length track", [c.id]); }
  // shorting: a track touching pads of two nets
  if (opts.shorts) for (const c of tracks()) {
    const nets = new Set(); for (const o of conds) if (o.kind === "pad" && o.net && alive(o) && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS) nets.add(o.net);
    if (nets.size > 1) { remove.add(c.id); report("shorting_track", `Remove track shorting ${Array.from(nets).join(" and ")}`, [c.id]); }
  }
  // redundant vias: same spot, same layers (the later one goes); vias with nothing to connect
  if (opts.vias) {
    const vias = conds.filter((c) => c.kind === "via");
    for (let i = 0; i < vias.length; i++) for (let j = i + 1; j < vias.length; j++) if (alive(vias[j]) && near(vias[i].anchors[0], vias[j].anchors[0]) && Array.from(vias[i].layers).join() === Array.from(vias[j].layers).join()) { remove.add(vias[j].id); report("redundant_via", "Remove redundant via", [vias[j].id]); }
  }
  // tracks fully inside a pad
  if (opts.inPads) for (const c of tracks()) if (c.kind === "segment") {
    const [a, b] = c.anchors; const layer = layerOfC(c);
    const inside = (p) => conds.find((o) => o.kind === "pad" && o.layers.has(layer) && boxesTouch(o.bbox, [p[0], p[1], p[0], p[1]], 0) && coreDist(o.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= shapeOffset(o.shape) + 1e-9);
    const pa = inside(a), pb = inside(b); if (pa && pb && pa === pb) { remove.add(c.id); report("track_in_pad", "Remove track inside pad", [c.id]); }
  }
  // duplicates, contained and collinear segments
  if (opts.merge) {
    let changed = true;
    while (changed) {
      changed = false; const segs = tracks().filter((c) => c.kind === "segment");
      outer: for (let i = 0; i < segs.length; i++) for (let j = 0; j < segs.length; j++) {
        if (i === j) continue; const p = segs[i], q = segs[j]; if (layerOfC(p) !== layerOfC(q) || (p.net && q.net && p.net !== q.net)) continue;
        const pn = nodeOf(p), qn = nodeOf(q); const a = pt(pn, "start"), b = pt(pn, "end"), c = pt(qn, "start"), d = pt(qn, "end");
        const dir = [b[0] - a[0], b[1] - a[1]]; const L = Math.hypot(dir[0], dir[1]); if (L < EPS) continue;
        const cross = (r) => Math.abs((r[0] - a[0]) * dir[1] - (r[1] - a[1]) * dir[0]) / L; const along = (r) => ((r[0] - a[0]) * dir[0] + (r[1] - a[1]) * dir[1]) / L;
        if (cross(c) > EPS || cross(d) > EPS) continue;   // not collinear
        const tc = along(c), td = along(d), lo = Math.min(tc, td), hi = Math.max(tc, td);
        if (lo >= -EPS && hi <= L + EPS && widthOf(qn, 0.25) <= widthOf(pn, 0.25) + 1e-9) {   // q lies within p (a duplicate when equal)
          remove.add(q.id); report(Math.abs(lo) < EPS && Math.abs(hi - L) < EPS ? "duplicate_track" : "contained_track", Math.abs(lo) < EPS && Math.abs(hi - L) < EPS ? "Remove duplicate track" : "Remove track contained in another", [q.id]); changed = true; break outer;
        }
        if (Math.abs(widthOf(pn, 0.25) - widthOf(qn, 0.25)) > 1e-9) continue;
        // share exactly one end that is not a node (nothing else lands there): merge into one segment
        const joint = near(b, c) ? [b, a, d] : near(b, d) ? [b, a, c] : near(a, c) ? [a, b, d] : near(a, d) ? [a, b, c] : null; if (!joint) continue;
        if (Math.abs(along(joint[2]) - along(joint[1])) <= Math.abs(along(joint[0]) - along(joint[1])) + EPS && lo > -EPS && hi < L + EPS) continue;   // folds back on itself
        if (touchesPt(joint[0], layerOfC(p), p) && conds.filter(alive).some((o) => o !== p && o !== q && o.layers.has(layerOfC(p)) && (o.kind !== "segment" ? shapeGap(o.shape, { t: "circle", x: joint[0][0], y: joint[0][1], r: 0 }) <= EPS : o.anchors.some((r) => near(r, joint[0]))))) continue;
        const merged = clone(pn); K.kid(merged, "start").splice(1, 2, r6(joint[1][0]), r6(joint[1][1])); K.kid(merged, "end").splice(1, 2, r6(joint[2][0]), r6(joint[2][1]));
        replace.set(p.id, merged); remove.add(q.id); report("merge_collinear", "Merge collinear tracks", [p.id, q.id]);
        p.shape = { t: "seg", a: joint[1], b: joint[2], r: p.shape.r }; p.anchors = [joint[1], joint[2]]; p.bbox = shapeBBox(p.shape); p.length = Math.hypot(joint[2][0] - joint[1][0], joint[2][1] - joint[1][1]);
        changed = true; break outer;
      }
    }
  }
  // dangling ends, until nothing else comes loose
  if (opts.dangling || opts.danglingVias) {
    let again = true;
    while (again) {
      again = false;
      if (opts.dangling) for (const c of tracks()) { const layer = layerOfC(c); if (c.anchors.some((p) => !touchesPt(p, layer, c))) { remove.add(c.id); report("dangling_track", "Remove dangling track", [c.id]); again = true; } }
      if (opts.danglingVias) for (const c of conds) if (c.kind === "via" && alive(c) && !conds.filter(alive).some((o) => o !== c && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS)) { remove.add(c.id); report("dangling_via", "Remove dangling via", [c.id]); again = true; }
    }
  }
  const replaceOut = []; for (const [id, node] of replace) if (!remove.has(id)) replaceOut.push({ item: doc.items.get(id), node });
  return { remove, replace: replaceOut, items };
}
function cleanupChanges(doc, plan) { const out = []; for (const { item, node } of plan.replace) out.push(replacedChange(item, node)); for (const id of plan.remove) { const it = doc.items.get(id); if (it) out.push(removedChange(it)); } return out; }

// ---------------------------------------------------------------- clipboard (KiCad's own format: a kicad_pcb document)
// formatBoardLayers: the copper layers first, in stack order (the parser counts them there), then the rest by id.
function layersBlock(doc) {
  const rows = []; for (const [name, l] of doc.layers) if (/\./.test(name) || name === "Margin") rows.push([l.id, name, l.type || "user"].concat(l.userName ? [l.userName] : []));
  if (!rows.length) rows.push([0, "F.Cu", "signal"], [2, "B.Cu", "signal"]);
  const copper = copperOf(doc); const rank = (r) => { const i = copper.indexOf(r[1]); return i >= 0 ? i : (/\.Cu$/.test(r[1]) ? 500 + r[0] : 1000 + r[0]); };
  rows.sort((a, b) => rank(a) - rank(b)); return ["layers", ...rows];
}
/** The (layers …) block as text: KiCad's parser wants the layer names and user names quoted, which the serializer would leave bare. */
const quote = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function layersText(doc) { return "(layers " + layersBlock(doc).slice(1).map((r) => `(${r[0]} ${quote(r[1])} ${r[2]}${r[3] !== undefined ? " " + quote(r[3]) : ""})`).join(" ") + ")"; }
/** BestDragOrigin: the item anchor nearest the cursor, else the cursor, else the selection's centre. */
function referencePoint(doc, ids, cursor) {
  const items = ids.map((id) => doc.items.get(id)).filter(Boolean); let best = null, bd = Infinity;
  if (cursor) for (const it of items) { const pts = it.kind === "footprint" ? [anchorOf(it)].concat(padsOf(it).map((p) => [p.x, p.y])) : [anchorOf(it)].concat(conductorEnds(it)); for (const p of pts) { const d = Math.hypot(p[0] - cursor[0], p[1] - cursor[1]); if (d < bd) { bd = d; best = p; } } }
  return best || cursor || selectionCenter(items);
}
/** CLIPBOARD_IO::SaveSelection: a kicad_pcb with the board's layers, the nets in use and the items moved so ref sits at (0, 0); locks dropped. */
function clipboardText(doc, ids, ref) {
  ref = ref || [0, 0]; const NT = netTable(doc); const items = Array.from(expandGroups(doc, ids)).map((id) => doc.items.get(id)).filter(Boolean);
  const refd = new Map(); const take = (n) => { const key = NT.key(n); if (key && !refd.has(key)) refd.set(key, n.code > 0 ? n.code : 0); };
  for (const it of items) { if (it.kind === "footprint") for (const p of K.kids(it.node, "pad")) take(netOf(p)); else if (K.kid(it.node, "net")) take(netOf(it.node)); }
  let next = 1; const used = new Set(refd.values()); for (const [k, v] of refd) if (!v) { while (used.has(next)) next++; refd.set(k, next); used.add(next); }
  const parts = [`(kicad_pcb (version ${BOARD_VERSION}) (generator "kicad-collab-web") (generator_version "10.0")`, layersText(doc), '(net 0 "")'];
  for (const [name, code] of Array.from(refd).sort((a, b) => a[1] - b[1])) parts.push(`(net ${code} ${quote(name)})`);
  for (const it of items) { const node = clone(it.node); translateNode(node, -ref[0], -ref[1]); setLocked(node, false); parts.push(K.serialize(node)); }
  return parts.join("\n") + "\n)";
}
function parseClipboard(text) {
  let trees; try { trees = K.parseAll(text); } catch (e) { return null; }
  const nodes = [], codeToName = new Map();
  for (const t of trees || []) {
    if (!isList(t)) continue;
    if (t[0] === "kicad_pcb") { for (const c of t.slice(1)) { if (!isList(c)) continue; if (c[0] === "net" && typeof c[1] === "number") codeToName.set(c[1], K.str(c[2])); else if (PCB_KINDS.has(c[0])) nodes.push(c); } }
    else if (PCB_KINDS.has(t[0])) nodes.push(t);
  }
  return nodes.length ? { nodes, codeToName } : null;
}
/** Every (uuid) / (tstamp) at any depth gets a new id; group members follow the map (members left behind are dropped). */
function freshUuids(nodes) {
  const map = new Map();
  const walk = (n) => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (!isList(c)) continue; if ((c[0] === "uuid" || c[0] === "tstamp") && c.length > 1) { const old = K.str(c[1]); if (!map.has(old)) map.set(old, K.newUuid()); c[1] = map.get(old); } else walk(c); } };
  for (const n of nodes) walk(n);
  for (const n of nodes) if (n[0] === "group") { const m = K.kid(n, "members"); if (m) { const ids = m.slice(1).map(K.str).filter((id) => map.has(id)).map((id) => map.get(id)); m.splice(1, m.length - 1, ...ids); } }
  return map;
}
/** Nets are kept by name and rewritten in the target document's style; names the board lacks become unconnected in a code-style board. */
function rewriteNets(nodes, codeToName, doc) {
  const NT = netTable(doc); const style = netStyle(doc);
  const walk = (n) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "net" && c.length > 1 && n[0] !== "kicad_pcb") {
        const name = typeof c[1] === "number" ? (c.length > 2 ? K.str(c[2]) : (codeToName.get(c[1]) || "")) : K.str(c[1]);
        if (style === "name") n[i] = ["net", name];
        else { const t = name ? NT.byName.get(name) : null; const code = t && t.code > 0 ? t.code : 0; n[i] = c.length > 2 || n[0] === "pad" ? ["net", code, code ? name : ""] : ["net", code]; }
      } else walk(c);
    }
  };
  for (const n of nodes) walk(n);
}
const refProp = (node) => K.kids(node, "property").find((p) => K.str(p[1]) === "Reference");
/** Paste-special annotation modes: unique (the default), keep, clear (REF**). */
function annotate(nodes, doc, mode) {
  if (mode === "keep") return;
  const used = new Set(); for (const it of doc.items.values()) if (it.kind === "footprint" && it.ref) used.add(it.ref);
  for (const n of nodes) {
    if (!isFootprintNode(n)) continue; const p = refProp(n); if (!p) continue; const ref = K.str(p[2]);
    if (mode === "clear") { p[2] = "REF**"; continue; }
    const m = /^(.*?)(\d+)$/.exec(ref); if (!m) continue;
    if (!used.has(ref)) { used.add(ref); continue; }
    let k = 1; while (used.has(m[1] + k)) k++; p[2] = m[1] + k; used.add(p[2]);
  }
}
/** ADDED changes for clipboard text placed with its reference point at `at`; returns { changes, ids }. */
function pasteChanges(doc, text, at, opts) {
  opts = opts || {}; const parsed = parseClipboard(text); if (!parsed) return { changes: [], ids: [] };
  const nodes = parsed.nodes.map(clone); freshUuids(nodes); rewriteNets(nodes, parsed.codeToName, doc); annotate(nodes, doc, opts.annotations || "unique");
  const changes = [], ids = [];
  for (const n of nodes) { if (at && (at[0] || at[1])) translateNode(n, at[0], at[1]); const c = addedChange(doc, n); changes.push(c); ids.push(c.id); }
  return { changes, ids };
}
/** Copy + paste in place with fresh ids (KiCad's Ctrl+D leaves the copies under the cursor for a move). */
function duplicateChanges(doc, ids, offset) { return pasteChanges(doc, clipboardText(doc, ids, [0, 0]), offset || [0, 0], { annotations: "unique" }); }
/** createArray: a grid of copies (the originals stay in place as cell 0, 0). */
function arrayChanges(doc, ids, opts) {
  const nx = Math.max(1, Math.round(opts.nx || 1)), ny = Math.max(1, Math.round(opts.ny || 1)); const text = clipboardText(doc, ids, [0, 0]); const out = { changes: [], ids: [] };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { if (!i && !j) continue; const r = pasteChanges(doc, text, [i * (opts.dx || 0), j * (opts.dy || 0)], { annotations: "unique" }); out.changes.push(...r.changes); out.ids.push(...r.ids); }
  return out;
}
const textOfItem = (it) => it.kind === "footprint" ? (it.ref || "") : it.kind === "gr_text" || it.kind === "gr_text_box" ? K.str(it.node[1]) : it.kind === "dimension" ? K.str((K.kid(it.node, "gr_text") || [])[1]) : "";
// The clipboard: the browser's when it can be reached, an app-supplied one, else a buffer of our own.
let clipBuffer = "";
function clipSet(ctx, text) {
  clipBuffer = text; if (ctx.clipboard && ctx.clipboard.set) ctx.clipboard.set(text);
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}
function clipGet(ctx, done) {
  if (ctx.clipboard && ctx.clipboard.get) { const v = ctx.clipboard.get(); if (v && typeof v.then === "function") { v.then((t) => done(t || clipBuffer), () => done(clipBuffer)); return; } done(v || clipBuffer); return; }
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.readText) { navigator.clipboard.readText().then((t) => done(t && /\(kicad_pcb|\(footprint|\(segment|\(via|\(gr_|\(zone/.test(t) ? t : clipBuffer), () => done(clipBuffer)); return; }
  done(clipBuffer);
}
function cursorPoint(ctx) {
  let p = ctx.cursor || (S.hover ? [S.hover.x, S.hover.y] : null);
  if (!p && ctx.doc && ctx.doc.bbox) p = [(ctx.doc.bbox[0] + ctx.doc.bbox[2]) / 2, (ctx.doc.bbox[1] + ctx.doc.bbox[3]) / 2];
  if (!p) return [0, 0]; return ctx.snapOn && ctx.snap ? ctx.snap(p) : p;
}

// ---------------------------------------------------------------- pads
/** The pad under (x, y): { item, index, pad } from padsOf, the smallest pad covering the point on any copper layer. */
function padAt(doc, x, y, layer) {
  let best = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint" || !it.bbox || x < it.bbox[0] || x > it.bbox[2] || y < it.bbox[1] || y > it.bbox[3]) continue;
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y) && (!best || p.w * p.h < best.pad.w * best.pad.h)) best = { item: it, index: p.index, pad: p };
  }
  return best;
}

// ---------------------------------------------------------------- conversions (CONVERT_TOOL) and small edits
const closedShapeLoop = (it) => {
  const n = it.node;
  if (it.kind === "gr_rect") { const [x0, y0, x1, y1] = corners(pt(n, "start"), pt(n, "end")); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (it.kind === "gr_poly") return K.ptsOf(n);
  if (it.kind === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts = []; for (let i = 0; i < 32; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); return pts; }
  return null;
};
/** Lines and arcs of the selection chained into closed loops (world points), plus any closed shapes. */
function selectionLoops(items) {
  const chains = [], loops = [];
  for (const it of items) {
    const n = it.node;
    if (it.kind === "gr_line") { const a = pt(n, "start"), b = pt(n, "end"); if (a && b) chains.push([a, b]); }
    else if (it.kind === "gr_arc") { const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) chains.push(arcPoints(arc, a, b)); }
    else if (it.kind === "gr_curve") { const pts = K.bezierPts(K.ptsOf(n)); if (pts.length > 1) chains.push(pts); }
    else { const l = closedShapeLoop(it); if (l) loops.push(l); }
  }
  if (chains.length) loops.push(...chainLoops(chains).loops);
  return loops.map((l) => l.map(([x, y]) => [r6(x), r6(y)]));
}
function convertChanges(doc, ids, to, extra) {
  const items = ids.map((id) => doc.items.get(id)).filter(Boolean); const out = []; const layer = items.length ? layerOf(items[0].node, "F.SilkS") : "F.SilkS";
  if (to === "lines") {   // rectangles and polygons into their edges
    for (const it of items) { const loop = closedShapeLoop(it); if (!loop || it.kind === "gr_circle") continue; loop.forEach((p, i) => out.push(addedChange(doc, lineNode(p, loop[(i + 1) % loop.length], layerOf(it.node, layer))))); out.push(removedChange(it)); }
    return out;
  }
  if (to === "tracks") {   // graphic lines and arcs on copper become tracks with the line's width
    for (const it of items) {
      const n = it.node; const l = layerOf(n, layer); if (!/\.Cu$/.test(l) || (it.kind !== "gr_line" && it.kind !== "gr_arc")) continue;
      const w = K.kid(n, "stroke") ? K.num((K.kid(K.kid(n, "stroke"), "width") || [0, 0.2])[1], 0.2) : 0.2; const a = pt(n, "start"); const net = netUnder(doc, a[0], a[1], l);
      if (it.kind === "gr_line") out.push(addedChange(doc, segmentNode(doc, a, pt(n, "end"), w, l, net), net));
      else out.push(addedChange(doc, ["arc", ["start", ...a.map(r6)], ["mid", ...pt(n, "mid").map(r6)], ["end", ...pt(n, "end").map(r6)], ["width", r6(w)], ["layer", l], netNode(doc, net)], net));
      out.push(removedChange(it));
    }
    return out;
  }
  const loops = selectionLoops(items); if (!loops.length) return [];
  if (to === "poly") { for (const loop of loops) out.push(addedChange(doc, polyNode(loop, layer))); }
  else if (to === "zone") { const l = /\.Cu$/.test(layer) ? layer : (extra && extra.layer) || "F.Cu"; const net = (extra && extra.net) || { code: 0, name: "" }; for (const loop of loops) out.push(addedChange(doc, zoneNode(doc, loop, l, net), net)); }
  else if (to === "keepout") { for (const loop of loops) out.push(addedChange(doc, ruleAreaNode(loop, /\.Cu$/.test(layer) ? [layer] : RULE_AREA_LAYERS))); }
  else return [];
  if (!(extra && extra.keep)) for (const it of items) if (/^gr_(line|arc|rect|poly|circle|curve)$/.test(it.kind)) out.push(removedChange(it));
  return out;
}
function justifyChanges(doc, ids, how) {
  return transformChanges(doc, ids, (n, it) => {
    const t = it.kind === "dimension" ? K.kid(n, "gr_text") : (it.kind === "gr_text" || it.kind === "gr_text_box") ? n : null; if (!t) return false;
    let eff = K.kid(t, "effects"); if (!eff) { eff = ["effects"]; t.push(eff); } let j = K.kid(eff, "justify"); const rest = (j ? j.slice(1) : []).filter((x) => x !== "left" && x !== "right");
    const toks = (how === "center" ? [] : [how]).concat(rest);
    if (j) { if (toks.length) j.splice(1, j.length - 1, ...toks); else eff.splice(eff.indexOf(j), 1); } else if (toks.length) eff.push(["justify", ...toks]);
  });
}
function zonePriorityChanges(doc, ids, how) {
  const zones = Array.from(doc.items.values()).filter((it) => it.kind === "zone" && !K.kid(it.node, "keepout")); const prio = (it) => { const p = K.kid(it.node, "priority"); return p ? K.num(p[1]) : 0; };
  const top = zones.reduce((m, z) => Math.max(m, prio(z)), 0);
  return transformChanges(doc, ids, (n, it) => {
    if (it.kind !== "zone" || K.kid(n, "keepout")) return false; const cur = prio(it);
    const want = how === "raise" ? cur + 1 : how === "lower" ? Math.max(0, cur - 1) : how === "top" ? top + 1 : 0; if (want === cur) return false;
    const p = K.kid(n, "priority"); if (want) { if (p) p[1] = want; else n.splice(n.indexOf(K.kid(n, "connect_pads") || K.kid(n, "min_thickness")), 0, ["priority", want]); } else if (p) n.splice(n.indexOf(p), 1);
  });
}
function footprintAttrChanges(doc, ids, flag) {
  return transformChanges(doc, ids, (n, it) => {
    if (it.kind !== "footprint") return false; let a = K.kid(n, "attr"); const toks = a ? a.slice(1).map(K.str) : []; const i = toks.indexOf(flag);
    if (i >= 0) toks.splice(i, 1); else toks.push(flag);
    if (!toks.length) { n.splice(n.indexOf(a), 1); return; } if (a) a.splice(1, a.length - 1, ...toks); else { const before = n.find((c) => isList(c) && /^(fp_|pad|model|embedded_fonts)/.test(c[0])); n.splice(before ? n.indexOf(before) : n.length, 0, ["attr", ...toks]); }
  });
}
/** Board statistics (DIALOG_BOARD_STATISTICS): footprint, pad, via and track counts, board size and outline area. */
function boardStatistics(doc) {
  const st = { footprints: { total: 0, front: 0, back: 0, smd: 0, tht: 0, other: 0 }, pads: { total: 0, smd: 0, tht: 0, npth: 0, connect: 0 }, vias: { total: 0, through: 0, blind: 0, micro: 0 }, tracks: { count: 0, length: 0 }, zones: 0, drills: 0, width: 0, height: 0, area: 0 };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { st.footprints.total++; if (it.layer === "B.Cu") st.footprints.back++; else st.footprints.front++; const a = K.kid(it.node, "attr"); const toks = a ? a.slice(1).map(K.str) : []; if (toks.includes("smd")) st.footprints.smd++; else if (toks.includes("through_hole")) st.footprints.tht++; else st.footprints.other++;
      for (const p of K.kids(it.node, "pad")) { st.pads.total++; const t = K.str(p[2]); if (t === "smd") st.pads.smd++; else if (t === "thru_hole") { st.pads.tht++; st.drills++; } else if (t === "np_thru_hole") { st.pads.npth++; st.drills++; } else st.pads.connect++; } }
    else if (it.kind === "via") { st.vias.total++; st.drills++; if (it.node.includes("micro")) st.vias.micro++; else if (it.node.includes("blind")) st.vias.blind++; else st.vias.through++; }
    else if (it.kind === "segment") { const a = pt(it.node, "start"), b = pt(it.node, "end"); st.tracks.count++; if (a && b) st.tracks.length += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    else if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); st.tracks.count++; if (arc) st.tracks.length += arcLength(arc); }
    else if (it.kind === "zone" && !K.kid(it.node, "keepout")) st.zones++;
  }
  st.tracks.length = r6(st.tracks.length);
  const ol = boardOutline(doc); const b = ol.outline ? bboxOfPts(ol.outline) : doc.bbox;
  if (b) { st.width = r6(b[2] - b[0]); st.height = r6(b[3] - b[1]); } st.area = r6(ol.outline ? ol.area : (b ? (b[2] - b[0]) * (b[3] - b[1]) : 0));
  return st;
}
// ---------------------------------------------------------------- message panel (EDA_MSG_PANEL)
// The strip under the canvas: GetMsgPanelInfo of the one selected item (PCB_TRACK / PCB_VIA / PAD / FOOTPRINT / ZONE /
// PCB_SHAPE), the board summary (BOARD::GetMsgPanelInfo) otherwise, the router's (ROUTER_TOOL::UpdateMessagePanel)
// while a track is being routed.  Values follow MessageTextFromValue: "%.4f mm", "%.2f mils", "%.4f in"; areas short.
function msgValue(v, units) { const u = units || "mm"; return u === "mil" ? (v / 0.0254).toFixed(2) + " mils" : u === "in" ? (v / 25.4).toFixed(4) + " in" : v.toFixed(4) + " mm"; }
function msgArea(a, units) { const u = units || "mm"; return u === "mil" ? (a / 0.0254 / 0.0254).toFixed(0) + " mils²" : u === "in" ? (a / 25.4 / 25.4).toFixed(3) + " in²" : a.toFixed(3) + " mm²"; }
/** UnescapeString: the {slash}-style escapes KiCad keeps in net names, shown as the characters. */
const UNESC = { slash: "/", backslash: "\\", lt: "<", gt: ">", colon: ":", dblquote: '"', quote: "'", space: " ", tab: "\t", return: "\n", brace: "{", bar: "|" };
const unescapeName = (t) => String(t || "").replace(/\{(slash|backslash|lt|gt|colon|dblquote|quote|space|tab|return|brace|bar)\}/g, (_, k) => UNESC[k]);
const msgAngle = (v) => String(+(+v).toPrecision(4));
/** BOARD::GetLayerName: the user name the board gives a layer, else its canonical one. */
function boardLayerName(doc, name) { const l = doc && doc.layers && doc.layers.get ? doc.layers.get(name) : null; return l && l.userName ? l.userName : name; }
/** BOARD_ITEM::LayerMaskDescribe for a pad: all copper layers, else the first copper / technical / any layer, "and others". */
function padLayerDescribe(doc, p) {
  const copper = copperOf(doc), cu = padCopperLayers(p, copper);
  if (cu.size === copper.length) return "all copper layers";
  const tech = p.layers.filter((l) => !/\.Cu$/.test(l) && l !== "*.Cu");
  for (const set of [Array.from(cu), tech, p.layers]) if (set.length) return boardLayerName(doc, set[0].replace(/^\*\./, "F.")) + (set.length > 1 ? " and others" : "");
  return "no layers";
}
/** Clearance and its source as the DRC engine resolves it for an item on `net` (netclass rule, or the board minimum). */
function msgClearance(s, net) {
  const nc = netClearance(s, net), min = s.minClearance || 0;
  return nc >= min ? { v: nc, from: `netclass '${netclassName(s, net)}'` } : { v: min, from: "board setup constraints" };
}
/** BOARD::GetTrackLength: the summed length of the track run the item belongs to. */
function routedLength(doc, id) {
  let len = 0;
  for (const rid of connectedRun(doc, [id])) {
    const it = doc.items.get(rid); if (!it) continue;
    if (it.kind === "segment") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    else if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); len += arc ? arcLength(arc) : (a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0); }
  }
  return len;
}
/** EDA_SHAPE::getFriendlyName */
const SHAPE_NAMES = { line: "Segment", rect: "Rectangle", circle: "Circle", arc: "Arc", poly: "Polygon", curve: "Curve" };
/** BOARD_CONNECTED_ITEM::GetNetnameMsg */
const netnameMsg = (net) => (net && net.name ? `[${unescapeName(net.name)}]` : "[<no net>]");
/**
 * How pcbnew names an item in the Clarify Selection popup and elsewhere (GetItemDescription): "Track [VCC] on B.Cu,
 * length 0.6400 mm", "Via [GND] on F.Cu - B.Cu", "PTH pad 2 [VCC] of R10", "Footprint R10", "Zone [GND] on F.Cu, priority 0".
 * `id` may name a pad as "footprintId#padIndex".
 */
function itemDescription(doc, id, units) {
  const V = (v) => msgValue(v, units), L = (l) => boardLayerName(doc, l);
  const hash = String(id).indexOf("#"), it = doc.items.get(hash > 0 ? String(id).slice(0, hash) : id); if (!it) return "";
  const n = it.node;
  if (hash > 0 && it.kind === "footprint") {
    const p = padsOf(it)[+String(id).slice(hash + 1)]; if (!p) return "";
    const ref = it.ref || "";
    if (p.type === "np_thru_hole") return `NPTH pad of ${ref}`;
    const num = p.number ? p.number + " " : "";
    if (p.type === "smd" || p.type === "connect") return `Pad ${num}${netnameMsg(p.net)} of ${ref} on ${padLayerDescribe(doc, p)}`;
    return `PTH pad ${num}${netnameMsg(p.net)} of ${ref}`;
  }
  if (it.kind === "segment" || it.kind === "arc") {
    const a = pt(n, "start"), b = pt(n, "end"); let len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    if (it.kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) len = arcLength(arc); }
    return `${it.kind === "arc" ? "Track (arc)" : "Track"} ${netnameMsg(netOf(n))} on ${L(layerOf(n))}, length ${V(len)}`;
  }
  if (it.kind === "via") {
    const ls = K.kid(n, "layers"); const pair = ls ? ls.slice(1).map(K.str) : ["F.Cu", "B.Cu"];
    const kind = n.includes("micro") ? "Micro via" : n.includes("blind") ? "Blind via" : n.includes("buried") ? "Buried via" : "Via";
    return `${kind} ${netnameMsg(netOf(n))} on ${L(pair[0] || "F.Cu")} - ${L(pair[pair.length - 1] || "B.Cu")}`;
  }
  if (it.kind === "footprint") return `Footprint ${it.ref || "<no reference designator>"}`;
  if (it.kind === "zone") {
    const names = zoneLayers(n).map(L); const keep = K.kid(n, "keepout"); const nm = K.kid(n, "name"); const zn = nm ? K.str(nm[1]) : "";
    const ld = names.length === 1 ? `on ${names[0]}` : names.length === 2 ? `on ${names[0]} and ${names[1]}` : names.length === 3 ? `on ${names[0]}, ${names[1]} and ${names[2]}` : names.length > 3 ? `on ${names[0]}, ${names[1]} and ${names.length - 2} more` : "";
    if (keep) return zn ? `Rule area '${zn}' ${ld}` : `Rule Area ${ld}`;
    const pr = K.kid(n, "priority"); const prio = pr ? K.num(pr[1]) : 0;
    return zn ? `Zone '${zn}' ${netnameMsg(netOf(n))} ${ld}, priority ${prio}` : `Zone ${netnameMsg(netOf(n))} ${ld}, priority ${prio}`;
  }
  if (it.kind === "gr_text") { const t = K.str(n[1]); return `PCB text '${t.length > 36 ? t.slice(0, 33) + "..." : t}' on ${L(layerOf(n))}`; }
  const m = /^gr_(line|rect|circle|arc|poly|curve)$/.exec(it.kind);
  if (m) { const layer = layerOf(n); return /\.Cu$/.test(layer) ? `${SHAPE_NAMES[m[1]]} ${netnameMsg(netOf(n))} on ${L(layer)}` : `${SHAPE_NAMES[m[1]]} on ${L(layer)}`; }
  return "";
}
const PAD_ATTR = { thru_hole: "PTH", smd: "SMD", connect: "Conn", np_thru_hole: "NPTH" };
const PAD_SHAPE = { circle: "Circle", oval: "Oval", rect: "Rectangle", trapezoid: "Trapezoid", roundrect: "Rounded rectangle", chamfered_rect: "Chamfered rectangle", custom: "Custom shape" };
/**
 * The message panel's columns [{ title, value }] for the selection `ids` (an id, or "footprintId#padIndex" for a pad).
 * opts: { settings, units, route, nl }.  Nothing (or several things) selected gives the board summary, as pcbnew.
 */
function msgPanelInfo(doc, ids, opts) {
  opts = opts || {}; const units = opts.units || "mm", s = opts.settings || designSettings(null), out = [];
  const add = (title, value) => out.push({ title: String(title), value: String(value === undefined || value === null ? "" : value) });
  const V = (v) => msgValue(v, units), NN = (net) => netclassName(s, net);
  const rt = opts.route;
  if (rt) {   // ROUTER_TOOL::UpdateMessagePanel
    const net = rt.net && (rt.net.name || "");
    if (net) add(`Routing Track: ${unescapeName(net)}`, `Resolved Netclass: ${NN(net)}`); else add("Routing Track", "(no net)");
    add("Corner Style", rt.freeAngle ? "Free-angle" : "45-degree");
    add("Mode", "Walk around");
    const R = K.pcbSizes && K.pcbSizes.state;
    const widthFrom = rt.connected && R && R.useConnectedWidth && !R.tempOverride ? "existing track" : R && !R.useNetclassTrack ? "user choice" : `netclass '${NN(net)}'`;
    add(`Track Width: ${V(rt.width)}`, `(from ${widthFrom})`);
    const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from === "board setup constraints" ? "board minimum clearance" : c.from})`);
    return out;
  }
  const list = Array.from(ids || []);
  if (list.length === 1) {
    const id = String(list[0]), hash = id.indexOf("#");
    const it = doc.items.get(hash > 0 ? id.slice(0, hash) : id);
    if (it && hash > 0 && it.kind === "footprint") {   // PAD::GetMsgPanelInfo
      const p = padsOf(it)[+id.slice(hash + 1)];
      if (p) {
        add("Footprint", it.ref || "");
        add("Pad", p.number);
        const pf = K.kid(p.node, "pinfunction"), ptp = K.kid(p.node, "pintype");
        if (pf && K.str(pf[1])) add("Pin Name", K.str(pf[1]));
        if (ptp && K.str(ptp[1])) add("Pin Type", K.str(ptp[1]));
        add("Net", unescapeName(p.net.name)); add("Resolved Netclass", NN(p.net.name));
        if (isLocked(it.node) || isLocked(p.node)) add("Status", "Locked");
        if (p.type === "smd" || p.type === "connect") add("Layer", padLayerDescribe(doc, p));
        const prop = K.kid(p.node, "property"); const PROP = { pad_prop_bga: "BGA", pad_prop_fiducial_glob: "Fiducial global", pad_prop_fiducial_loc: "Fiducial local", pad_prop_testpoint: "Test point", pad_prop_heatsink: "Heat sink", pad_prop_castellated: "Castellated", pad_prop_mechanical: "Mechanical", pad_prop_pressfit: "Press-fit" };
        add(PAD_SHAPE[p.shape] || "???", (PAD_ATTR[p.type] || "???") + (prop && PROP[K.str(prop[1])] ? "," + PROP[K.str(prop[1])] : ""));
        if (p.shape === "circle" || (p.shape === "oval" && Math.abs(p.w - p.h) < 1e-9)) add("Diameter", V(p.w)); else { add("Width", V(p.w)); add("Height", V(p.h)); }
        const frot = K.atOf(it.node)[2] || 0; const prel = norm180(p.rot - frot);
        add("Rotation", frot ? `${msgAngle(prel)}(+ ${msgAngle(frot)})` : msgAngle(p.rot));
        const dr = K.kid(p.node, "drill");
        if (dr) { const oval = K.str(dr[1]) === "oval"; const nums = dr.slice(oval ? 2 : 1).filter((x) => typeof x === "number"); if (nums.length && nums[0] > 0) { if (oval) add("Hole X / Y", `${V(nums[0])} / ${V(nums.length > 1 ? nums[1] : nums[0])}`); else add("Hole", V(nums[0])); } }
        const c = msgClearance(s, p.net.name); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
        return out;
      }
    }
    if (it && (it.kind === "segment" || it.kind === "arc")) {   // PCB_TRACK::GetMsgPanelInfo
      const n = it.node, net = netOf(n).name || "", w = widthOf(n, 0.25), layer = layerOf(n);
      add("Type", it.kind === "arc" ? "Track (arc)" : "Track");
      add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); if (isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layer)); add("Width", V(w));
      const a = pt(n, "start"), b = pt(n, "end"); let len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
      if (it.kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) { len = arcLength(arc); add("Radius", V(arc.r)); add("Angle", (len / arc.r * 180 / Math.PI * (arc.anticlockwise ? -1 : 1)).toFixed(2) + "deg"); } }
      add("Segment Length", V(len));
      if (hasNet(netOf(n))) add("Routed Length", V(routedLength(doc, it.id)));
      add("Copper Area", msgArea(len * w + Math.PI * w * w / 4, units));
      const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
      const nc = netclassOf(s, net); const mn = s.minTrackWidth || 0; const parts = []; if (mn > 0) parts.push("min " + V(mn)); if (nc && nc.track_width !== undefined) parts.push("opt " + V(nc.track_width));
      if (parts.length) add(`Width Constraints: ${parts.join("; ")}`, `(from netclass '${NN(net)}')`);
      return out;
    }
    if (it && it.kind === "via") {   // PCB_VIA::GetMsgPanelInfo
      const n = it.node, net = netOf(n).name || ""; const v = viaNow(n);
      add("Type", n.includes("micro") ? "Micro Via" : n.includes("blind") ? "Blind Via" : n.includes("buried") ? "Buried Via" : "Through Via");
      add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); if (isLocked(n)) add("Status", "Locked");
      const ls = K.kid(n, "layers"); const pair = ls ? ls.slice(1).map(K.str) : ["F.Cu", "B.Cu"];
      add("Layer", `${boardLayerName(doc, pair[0] || "F.Cu")} - ${boardLayerName(doc, pair[pair.length - 1] || "B.Cu")}`);
      add("Diameter", V(v.size)); add("Hole", V(v.drill));
      const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
      add(`Min Annular Width: ${V(s.minViaAnnular || 0)}`, "(from board setup constraints)");
      return out;
    }
    if (it && it.kind === "footprint") {   // FOOTPRINT::GetMsgPanelInfo (board editor)
      const n = it.node; const val = K.kids(n, "property").find((q) => K.str(q[1]) === "Value");
      add(it.ref || "", it.value !== undefined ? it.value : val ? K.str(val[2]) : "");
      add("Board Side", it.layer === "B.Cu" ? "Back (Flipped)" : "Front");
      add("Rotation", msgAngle(K.atOf(n)[2] || 0));
      const status = [], attrs = []; if (isLocked(n)) status.push("Locked"); if (n.includes("placed") || K.kid(n, "placed")) status.push("autoplaced");
      const at = K.kid(n, "attr"); const toks = at ? at.slice(1).map(K.str) : [];
      if (toks.includes("board_only")) attrs.push("not in schematic"); if (toks.includes("exclude_from_pos_files")) attrs.push("exclude from pos files"); if (toks.includes("exclude_from_bom")) attrs.push("exclude from BOM"); if (toks.includes("dnp")) attrs.push("DNP");
      add("Status: " + status.join(", "), "Attributes: " + attrs.join(", "));
      const m3 = K.kid(n, "model");
      add(`Footprint: ${K.str(n[1])}`, `3D-Shape: ${m3 ? K.str(m3[1]) : "<none>"}`);
      const descr = K.kid(n, "descr"), tags = K.kid(n, "tags");
      add(`Doc: ${descr ? K.str(descr[1]) : ""}`, `Keywords: ${tags ? K.str(tags[1]) : ""}`);
      return out;
    }
    if (it && it.kind === "zone") {   // ZONE::GetMsgPanelInfo
      const n = it.node, keep = K.kid(n, "keepout"), net = netOf(n).name || "", zl = zoneLayers(n);
      add("Type", keep ? "Rule Area" : "Zone");
      if (keep) { const r = []; for (const [k, l] of [["vias", "No vias"], ["tracks", "No tracks"], ["pads", "No pads"], ["copperpour", "No zone fills"], ["footprints", "No footprints"]]) { const x = K.kid(keep, k); if (x && K.str(x[1]) === "not_allowed") r.push(l); } if (r.length) add("Restrictions", r.join(", ")); }
      else if (zl.some((l) => /\.Cu$/.test(l) || l === "*.Cu")) { add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); const pr = K.kid(n, "priority"); add("Priority", pr ? K.num(pr[1]) : 0); }
      if (isLocked(n)) add("Status", "Locked");
      const names = zl.map((l) => boardLayerName(doc, l));
      add("Layer", names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.length > 3 ? `${names[0]}, ${names[1]} and ${names.length - 2} more` : "");
      const nm = K.kid(n, "name"); if (nm && K.str(nm[1])) add("Name", K.str(nm[1]));
      if (!keep) {
        const fill = K.kid(n, "fill"); const hatched = fill && K.kid(fill, "mode") && K.str(K.kid(fill, "mode")[1]) === "hatch";
        add("Fill Mode", hatched ? "Hatched" : "Solid");
        let area = 0; for (const fp of K.kids(n, "filled_polygon")) { const q = K.ptsOf(fp); for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; area += a[0] * b[1] - b[0] * a[1]; } }
        add("Filled Area", msgArea(Math.abs(area) / 2, units));
        const cp = K.kid(n, "connect_pads"); const cc = cp && K.kid(cp, "clearance"); const c = msgClearance(s, net);
        const zc = cc ? K.num(cc[1]) : 0; const v = Math.max(zc, c.v); add(`Min Clearance: ${V(v)}`, `(from ${zc >= c.v && cc ? "zone" : c.from})`);
      }
      return out;
    }
    if (it && /^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)) {   // PCB_SHAPE::GetMsgPanelInfo (EDA_SHAPE::ShapeGetMsgPanelInfo)
      const n = it.node, kind = it.kind.slice(3); const SHAPE = SHAPE_NAMES;
      add("Type", "Drawing"); if (isLocked(n)) add("Status", "Locked");
      add("Shape", SHAPE[kind]);
      const a = pt(n, "start"), b = pt(n, "end"), c = pt(n, "center");
      if (kind === "circle" && c && b) add("Radius", V(Math.hypot(b[0] - c[0], b[1] - c[1])));
      else if (kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) { const L = arcLength(arc); add("Length", V(L)); add("Angle", (L / arc.r * 180 / Math.PI).toFixed(1) + "°"); add("Radius", V(arc.r)); } }
      else if (kind === "curve") { const q = K.bezierPts(K.ptsOf(n)); let L = 0; for (let i = 1; i < q.length; i++) L += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]); add("Length", V(L)); }
      else if (kind === "poly") add("Points", K.ptsOf(n).length);
      else if (kind === "rect" && a && b) { add("Width", V(Math.abs(b[0] - a[0]))); add("Height", V(Math.abs(b[1] - a[1]))); }
      else if (kind === "line" && a && b) { add("Length", V(Math.hypot(b[0] - a[0], b[1] - a[1]))); add("Angle", (Math.atan2(a[1] - b[1], b[0] - a[0]) * 180 / Math.PI).toFixed(1) + "°"); }
      const layer = layerOf(n); add("Layer", boardLayerName(doc, layer));
      if (/\.Cu$/.test(layer) && hasNet(netOf(n))) add("Net", unescapeName(netOf(n).name));
      return out;
    }
  }
  if (opts.net && !list.length) {   // NETINFO_ITEM::GetMsgPanelInfo: a net highlighted with nothing selected
    const NT = netTable(doc), name = opts.net; let code = 0;
    for (const [c, nm] of NT.byCode) if (nm === name) { code = c; break; }
    if (!code) { let i = 0; for (const nm of NT.byName.keys()) { i++; if (nm === name) { code = i; break; } } }
    let padCount = 0, viaCount = 0, first = null;
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") { for (const p of K.kids(it.node, "pad")) if (NT.key(netOf(p)) === name) padCount++; }
      else if ((it.kind === "via" || it.kind === "segment" || it.kind === "arc") && NT.key(netOf(it.node)) === name) { if (it.kind === "via") viaCount++; else if (!first) first = it; }
    }
    add("Net Name", unescapeName(name)); add("Net Code", code); add("Pads", padCount); add("Vias", viaCount);
    if (first) { const L = routedLength(doc, first.id); add("Net Length", V(L)); add("On Board", V(L)); add("In Package", V(0)); }
    return out;
  }
  // BOARD::GetMsgPanelInfo
  let pads = 0, vias = 0, segs = 0; const nets = new Set();
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") for (const p of K.kids(it.node, "pad")) { pads++; const nn = netOf(p); if (hasNet(nn)) nets.add(nn.name || nn.code); }
    else if (it.kind === "via" || it.kind === "segment" || it.kind === "arc") { if (it.kind === "via") vias++; else segs++; const nn = netOf(it.node); if (hasNet(nn)) nets.add(nn.name || nn.code); }
  }
  add("Pads", pads); add("Vias", vias); add("Track Segments", segs); add("Nets", nets.size);
  add("Unrouted", ratsnest(doc, opts.nl || netlist(doc)).length);
  return out;
}
function bboxOfPts(pts) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; }
/** Ids of everything with copper or drawings on a layer (footprints by their side). */
function idsOnLayer(doc, layer) {
  const out = new Set();
  for (const it of doc.items.values()) { if (it.kind === "group") continue; if ((it.kind === "footprint" && it.layer === layer) || it.geom.some((g) => g.layer === layer)) out.add(it.id); }
  return out;
}
const SELECTION_TYPES = { footprints: (it) => it.kind === "footprint", tracks: (it) => it.kind === "segment" || it.kind === "arc", vias: (it) => it.kind === "via", zones: (it) => it.kind === "zone", graphics: (it) => /^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind) || it.kind === "image", text: (it) => it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "table", dimensions: (it) => it.kind === "dimension", other: (it) => it.kind === "group" || it.kind === "target" || it.kind === "generated" };
function filterIds(doc, ids, keep) { return Array.from(ids).filter((id) => { const it = doc.items.get(id); if (!it) return false; for (const [type, test] of Object.entries(SELECTION_TYPES)) if (test(it)) return keep[type] !== false; return true; }); }
/** Clearance between two copper items, as the inspector shows it: the gap and what the rules ask for. */
function inspectClearance(doc, idA, idB, settings) {
  const s = settings && settings.netclasses ? settings : designSettings(settings); const conds = conductors(doc).filter((c) => c.kind !== "zone");
  const A = conds.filter((c) => c.id === idA), B = conds.filter((c) => c.id === idB); if (!A.length || !B.length) return null;
  let gap = Infinity; for (const a of A) for (const b of B) if (shareLayer(a.layers, b.layers)) gap = Math.min(gap, shapeGap(a.shape, b.shape));
  const need = Math.max(netClearance(s, A[0].net), netClearance(s, B[0].net));
  return { gap: gap === Infinity ? null : r6(gap), required: need, sameNet: !!(A[0].net && A[0].net === B[0].net), nets: [A[0].net, B[0].net] };
}

// ---------------------------------------------------------------- dialogs (KDialogs at runtime, a swappable form for the tests)
// A form spec: { title, width, fields: [{ k, label, type: num | text | select | check | note | table, value, options,
// columns, rows, onRow }], apply(values) -> false keeps the dialog open }.  The default implementation lays it out
// in KDialogs.open; pcb.setForm swaps it (the node tests call spec.apply themselves).
const KD = () => root.KDialogs;
const PROPS = () => root.CollabTools && root.CollabTools.props && root.CollabTools.props.helpers;
let formImpl = function (spec) {
  const kd = KD(); if (!kd || typeof document === "undefined") { if (lastCtx) lastCtx.toast(`${spec.title}: dialogs are unavailable here`); return false; }
  const inputs = {};
  kd.open({
    title: spec.title, width: spec.width || 420, readOnly: !!spec.readOnly,
    build(body) {
      for (const f of spec.fields) {
        if (f.type === "note") { const p = document.createElement("p"); p.className = "note"; p.style.margin = "4px 0"; p.textContent = f.value; body.appendChild(p); continue; }
        if (f.type === "table") {
          const box = document.createElement("div"); box.style.cssText = "max-height:320px;overflow:auto;border:1px solid var(--line,#24374E);border-radius:3px;font:12px var(--mono,ui-monospace,monospace);margin:4px 0";
          const head = document.createElement("div"); head.style.cssText = `display:grid;grid-template-columns:${f.columns.map((c) => c.width || "1fr").join(" ")};gap:0 10px;padding:3px 6px;position:sticky;top:0;background:var(--panel,#111D2C);opacity:.8`;
          head.innerHTML = f.columns.map((c) => `<span>${esc(c.label)}</span>`).join(""); box.appendChild(head);
          f.rows.forEach((row, i) => { const r = document.createElement("div"); r.style.cssText = head.style.cssText.replace("position:sticky;top:0;", "") + ";cursor:pointer;opacity:1"; r.innerHTML = row.map((v) => `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(String(v))}">${esc(String(v))}</span>`).join(""); if (f.onRow) r.addEventListener("click", () => f.onRow(i, r)); box.appendChild(r); });
          if (!f.rows.length) { const p = document.createElement("div"); p.style.padding = "6px"; p.className = "note"; p.textContent = f.empty || "Nothing to show."; box.appendChild(p); }
          body.appendChild(box); continue;
        }
        const row = document.createElement("label"); row.style.cssText = "display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;margin:4px 0";
        const span = document.createElement("span"); span.textContent = f.label; row.appendChild(span);
        let inp;
        if (f.type === "select") { inp = document.createElement("select"); for (const o of f.options) { const op = document.createElement("option"); op.value = isList(o) ? o[0] : o; op.textContent = isList(o) ? o[1] : o; inp.appendChild(op); } inp.value = f.value; }
        else if (f.type === "check") { inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!f.value; inp.style.width = "auto"; inp.style.justifySelf = "start"; }
        else { inp = document.createElement("input"); inp.type = f.type === "num" ? "number" : "text"; if (f.type === "num") inp.step = f.step || "any"; inp.value = f.value === undefined || f.value === null ? "" : f.value; }
        inp.dataset.k = f.k; inp.style.cssText += ";font:inherit;background:var(--panel,#0A1421);color:inherit;border:1px solid var(--line,#24374E);border-radius:3px;padding:3px 5px";
        inputs[f.k] = inp; row.appendChild(inp); body.appendChild(row);
      }
    },
    ok() {
      const v = {}; for (const [k, i] of Object.entries(inputs)) v[k] = i.type === "checkbox" ? i.checked : i.type === "number" ? (i.value === "" ? NaN : parseFloat(i.value)) : i.value;
      return spec.apply ? spec.apply(v) : undefined;
    },
  });
  return true;
};
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
const openForm = (spec) => formImpl(spec);
const copperOf = (doc) => doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
/** The design rules in force: ctx.designSettings (a .kicad_pro object, a legacy board text or our shape), pcb.setDesignSettings, else KiCad's defaults. */
function settingsOf(ctx) {
  const src = ctx && ctx.designSettings; if (src) { if (S.settingsSrc !== src) { S.settingsSrc = src; S.settingsCache = designSettings(src); } return S.settingsCache; }
  return S.settings || (S.settings = designSettings(null));
}
const num0 = (v, d) => (typeof v === "number" && !isNaN(v)) ? v : d;
function padProperties(ctx, fpItem, index) {
  bind(ctx); const H = PROPS(); if (!H || !H.setPad) { ctx.toast("Pad editing needs props.js"); return false; }
  const doc = ctx.doc, fp = doc.items.get(fpItem.id) || fpItem; const pads = padsOf(fp); const p = pads[index]; if (!p) return false;
  const info = H.padInfo(doc, p.node); const frot = K.atOf(fp.node)[2]; const nets = boardNets(doc).map((n) => n.name);
  const LAYER_SETS = [["F.Cu F.Paste F.Mask", "Front SMD (F.Cu F.Paste F.Mask)"], ["B.Cu B.Paste B.Mask", "Back SMD (B.Cu B.Paste B.Mask)"], ["*.Cu *.Mask", "Through hole (*.Cu *.Mask)"], ["F.Cu F.Mask", "Front copper + mask"], ["B.Cu B.Mask", "Back copper + mask"], ["*.Cu", "All copper"]];
  const cur = info.layers.join(" "); if (!LAYER_SETS.some((l) => l[0] === cur)) LAYER_SETS.unshift([cur, cur]);
  return openForm({
    title: `Pad Properties — ${fp.ref || "footprint"} pad ${info.number}`, width: 460, readOnly: !!ctx.viewOnly,
    fields: [
      { k: "number", label: "Pad number", type: "text", value: info.number },
      { k: "type", label: "Pad type", type: "select", value: info.type, options: [["smd", "SMD"], ["thru_hole", "Through-hole"], ["np_thru_hole", "NPTH, mechanical"], ["connect", "Edge connector"]] },
      { k: "shape", label: "Pad shape", type: "select", value: info.shape, options: [["circle", "Circular"], ["oval", "Oval"], ["rect", "Rectangular"], ["roundrect", "Rounded rectangle"], ["trapezoid", "Trapezoid"], ["custom", "Custom"]] },
      { k: "w", label: "Size X (mm)", type: "num", value: info.w }, { k: "h", label: "Size Y (mm)", type: "num", value: info.h },
      { k: "rot", label: "Orientation (°)", type: "num", value: r6(norm180(info.rot - frot)) },
      { k: "drill", label: "Hole size (mm, or WxH)", type: "text", value: info.drill },
      { k: "layers", label: "Copper layers", type: "select", value: cur, options: LAYER_SETS },
      { k: "net", label: "Net", type: "select", value: info.net, options: [["", "<no net>"]].concat(nets.includes(info.net) || !info.net ? [] : [[info.net, info.net]]).concat(nets.map((n) => [n, n])) },
      { k: "maskMargin", label: "Solder mask margin (mm)", type: "num", value: info.maskMargin === null ? "" : info.maskMargin },
      { k: "rratio", label: "Corner radius ratio", type: "num", value: info.rratio === null ? "" : info.rratio },
    ],
    apply(v) {
      if (ctx.viewOnly) return;
      const node = clone(fp.node); const drill = /^\s*$/.test(v.drill) ? "" : /x/i.test(v.drill) ? v.drill.split(/x/i).map((s) => parseFloat(s)) : parseFloat(v.drill);
      H.setPad(node, index, { number: v.number, type: v.type, shape: v.shape, w: num0(v.w, info.w), h: num0(v.h, info.h), rot: num0(v.rot, 0) + frot, drill, layers: v.layers.split(/\s+/).filter(Boolean), net: v.net, maskMargin: isNaN(v.maskMargin) ? null : v.maskMargin, rratio: isNaN(v.rratio) ? null : v.rratio }, doc);
      ctx.commit([replacedChange(fp, node)], "pad"); ctx.requestRender();
    },
  });
}

// ---------------------------------------------------------------- actions: pcbnew's non-tool commands
const VIA_SIZES = [[0.6, 0.3], [0.8, 0.4], [1.0, 0.5], [1.2, 0.6], [1.6, 0.8]];
const ACTIONS = {};
function act(id, label, key, run, extra) { ACTIONS[id] = Object.assign({ id, label, key, run }, extra || {}); return ACTIONS[id]; }
const alias = (id, of, label, key) => { ACTIONS[id] = Object.assign({}, ACTIONS[of], { id, label: label || ACTIONS[of].label, key: key || ACTIONS[of].key }); };
function runAction(id, ctx) { const a = ACTIONS[id]; if (!a) return false; bind(ctx); try { return !!a.run(ctx); } catch (e) { if (typeof console !== "undefined") console.warn(e); ctx.toast(`${a.label} failed: ${e.message}`); return true; } }
const canEdit = (ctx) => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
const needSel = (ctx, what) => { const ids = selectionIds(ctx); if (!ids.size) { ctx.toast(what || "Select something first"); return null; } return ids; };
const commitSel = (ctx, changes, label, keep) => { if (!changes.length) { ctx.toast(`${label}: nothing to change`); return true; } ctx.commit(changes, label); if (keep !== false) ctx.requestRender(); return true; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function highlightIds(ctx, ids) { if (ctx.setHighlight) ctx.setHighlight(ids && ids.size ? new Set(ids) : null); }
// clipboard
act("copy", "Copy", "Ctrl+C", (ctx) => {
  const ids = needSel(ctx, "Select items to copy"); if (!ids) return true;
  clipSet(ctx, clipboardText(ctx.doc, Array.from(ids), referencePoint(ctx.doc, Array.from(ids), cursorPoint(ctx)))); ctx.toast(`Copied ${plural(ids.size, "item")}`); return true;
});
act("cut", "Cut", "Ctrl+X", (ctx) => {
  const ids = needSel(ctx, "Select items to cut"); if (!ids || !canEdit(ctx)) return true;
  const all = Array.from(expandGroups(ctx.doc, ids)); clipSet(ctx, clipboardText(ctx.doc, all, referencePoint(ctx.doc, all, cursorPoint(ctx))));
  ctx.commit(deleteChanges(ctx.doc, all), "cut"); applySelection(ctx, []); ctx.toast(`Cut ${plural(all.length, "item")}`); return true;
});
function pasteAt(ctx, opts) {
  clipGet(ctx, (text) => {
    if (!text) { ctx.toast("Nothing to paste"); return; }
    const r = pasteChanges(ctx.doc, text, cursorPoint(ctx), opts); if (!r.changes.length) { ctx.toast("The clipboard holds no board items"); return; }
    // EDIT_TOOL::Paste: the pasted items hang on the cursor by their reference point until a click places them
    ctx.commit(r.changes, "paste"); applySelection(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice() });
  });
  return true;
}
act("paste", "Paste", "Ctrl+V", (ctx) => canEdit(ctx) && pasteAt(ctx, { annotations: "unique" }));
act("pasteSpecial", "Paste Special…", "Ctrl+Shift+V", (ctx) => canEdit(ctx) && openForm({ title: "Paste Special", fields: [{ k: "annotations", label: "Reference designators", type: "select", value: "unique", options: [["unique", "Assign unique reference designators"], ["keep", "Keep existing (may duplicate)"], ["clear", "Clear reference designators"]] }], apply: (v) => { pasteAt(ctx, { annotations: v.annotations }); } }));
act("duplicate", "Duplicate", "Ctrl+D", (ctx) => {
  const ids = needSel(ctx, "Select items to duplicate"); if (!ids || !canEdit(ctx)) return true;
  // EDIT_TOOL::Duplicate: the copies follow the cursor from where the originals are; a click places them, Escape drops them
  const r = duplicateChanges(ctx.doc, Array.from(ids)); ctx.commit(r.changes, "duplicate"); applySelection(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice() }); return true;
});
act("copyAsText", "Copy as Text", "", (ctx) => { const ids = needSel(ctx); if (!ids) return true; const t = Array.from(ids, (id) => textOfItem(ctx.doc.items.get(id))).filter(Boolean).join("\n"); clipSet(ctx, t); ctx.toast(t ? "Text copied" : "Nothing textual selected"); return true; });
// selection
act("selectNet", "Select Net", "", (ctx) => {
  const ids = needSel(ctx, "Select a track, via or footprint first"); if (!ids) return true; const nl = netlist(ctx.doc); const out = new Set(ids);
  for (const key of selectionNets(ctx, nl)) for (const id of netItemIds(ctx.doc, key, nl)) if (ctx.doc.items.get(id).kind !== "footprint") out.add(id);
  applySelection(ctx, out); ctx.toast(`${plural(out.size, "item")} selected`); return true;
});
act("deselectNet", "Deselect Net", "", (ctx) => { const ids = needSel(ctx); if (!ids) return true; const nl = netlist(ctx.doc); const drop = new Set(); for (const key of selectionNets(ctx, nl)) for (const id of netItemIds(ctx.doc, key, nl)) drop.add(id); applySelection(ctx, Array.from(ids).filter((id) => !drop.has(id))); return true; });
act("selectConnection", "Select/Expand Connection", "U", (ctx) => { const ids = needSel(ctx, "Select a track first"); if (!ids) return true; const run = connectedRun(ctx.doc, ids); if (!run.size) { ctx.toast("No tracks in the selection"); return true; } for (const id of ids) run.add(id); applySelection(ctx, run); ctx.toast(run.size > ids.size ? `Selected the connected run (${run.size} items)` : "Nothing else connected"); return true; });
function unconnectedNeighbours(ctx) {
  const ids = needSel(ctx, "Select a footprint first"); if (!ids) return null; const out = new Set();
  for (const l of ratsnest(ctx.doc)) { const [a, b] = l.ids; if (ids.has(a) && !ids.has(b)) out.add(b); else if (ids.has(b) && !ids.has(a)) out.add(a); }
  return Array.from(out).filter((id) => ctx.doc.items.get(id).kind === "footprint");
}
act("selectUnconnected", "Select Unconnected Footprints", "O", (ctx) => { const n = unconnectedNeighbours(ctx); if (!n) return true; if (!n.length) { ctx.toast("Nothing unconnected to reach"); return true; } applySelection(ctx, n); ctx.toast(`${plural(n.length, "footprint")} at the other end of the ratsnest selected`); return true; });
act("grabUnconnected", "Grab Unconnected Footprints", "Shift+O", (ctx) => { const n = unconnectedNeighbours(ctx); if (!n) return true; if (!n.length) { ctx.toast("Nothing unconnected to grab"); return true; } applySelection(ctx, n); ctx.toast(`${plural(n.length, "footprint")} selected — drag them into place`); return true; });
act("selectAllOnLayer", "Select All on Active Layer", "", (ctx) => { const layer = ctx.activeLayer || S.layer; const ids = idsOnLayer(ctx.doc, layer); applySelection(ctx, ids); ctx.toast(`${plural(ids.size, "item")} on ${layer}`); return true; });
act("selectSameSheet", "Select Footprints on Same Sheet", "", (ctx) => {
  const ids = needSel(ctx, "Select a footprint first"); if (!ids) return true; const sheets = new Set();
  for (const id of ids) { const it = ctx.doc.items.get(id); const sf = it.kind === "footprint" && (K.kid(it.node, "sheetfile") || K.kid(it.node, "sheetname")); if (sf) sheets.add(K.str(sf[1])); }
  if (!sheets.size) { ctx.toast("The selection carries no sheet"); return true; } const out = new Set();
  for (const it of ctx.doc.items.values()) if (it.kind === "footprint") { const sf = K.kid(it.node, "sheetfile") || K.kid(it.node, "sheetname"); if (sf && sheets.has(K.str(sf[1]))) out.add(it.id); }
  applySelection(ctx, out); ctx.toast(`${plural(out.size, "footprint")} on ${Array.from(sheets).join(", ")}`); return true;
});
act("filterSelection", "Filter Selected Items…", "", (ctx) => {
  const ids = needSel(ctx); if (!ids) return true;
  return openForm({ title: "Filter Selected Items", fields: Object.keys(SELECTION_TYPES).map((t) => ({ k: t, label: t[0].toUpperCase() + t.slice(1), type: "check", value: true })), apply: (v) => { const kept = filterIds(ctx.doc, ids, v); applySelection(ctx, kept); ctx.toast(`${plural(kept.length, "item")} kept`); } });
});
act("unselectAll", "Unselect All", "", (ctx) => { applySelection(ctx, []); return true; });
// placement
const overrideLocks = () => !!appGlobal(() => editorState().overrideLocks, false);
/**
 * Locked items sit out of every move, turn, flip and delete unless "Override locks" is ticked
 * (PCB_SELECTION_TOOL::FilterCollectorForLockedItems): the ids that may be edited, with a word about the rest.
 */
function unlockedIds(ctx, ids, quiet) {
  if (overrideLocks()) return ids;
  const free = ids.filter((id) => { const it = ctx.doc.items.get(id); return it && !isLocked(it.node); });
  if (free.length < ids.length && !quiet) ctx.toast(free.length ? "Locked items were left as they are — tick Override locks to edit them" : "The selection is locked — tick Override locks to edit it", 3500);
  return free;
}
function editableOrToast(ctx, what) { const ids = selectionOrToast(ctx, what); if (!ids) return null; const free = unlockedIds(ctx, ids); return free.length ? free : null; }
function selectionOrToast(ctx, what) { const ids = needSel(ctx, what); return ids && canEdit(ctx) ? Array.from(expandGroups(ctx.doc, ids)) : null; }
act("move", "Move", "M", (ctx) => {
  const items = selectedItems(ctx); if (!items.length) return false;
  if (items.every((it) => it.kind === "footprint")) return false;   // footprints alone: the app's own move, which also shows peers each step
  if (!canEdit(ctx)) return true;
  return beginCarryMove(ctx);
});
act("moveExactly", "Move Exactly…", "Shift+M", (ctx) => {
  const ids = editableOrToast(ctx, "Select items to move"); if (!ids) return true;
  return openForm({ title: "Move Item Exactly", fields: [{ k: "dx", label: "Move X (mm)", type: "num", value: 0 }, { k: "dy", label: "Move Y (mm)", type: "num", value: 0 }, { k: "rotation", label: "Rotate (°)", type: "num", value: 0 }, { k: "about", label: "Rotate around", type: "select", value: "center", options: [["center", "Selection center"], ["anchor", "Item anchor"]] }],
    apply: (v) => commitSel(ctx, moveExactChanges(ctx.doc, ids, { dx: num0(v.dx, 0), dy: num0(v.dy, 0), rotation: num0(v.rotation, 0), about: v.about }), "move exactly") });
});
alias("moveExact", "moveExactly");
act("positionRelative", "Position Relative To…", "Shift+P", (ctx) => {
  const ids = editableOrToast(ctx, "Select items to position"); if (!ids) return true;
  const fps = Array.from(ctx.doc.items.values()).filter((it) => it.kind === "footprint" && !ids.includes(it.id)).sort((a, b) => (a.ref || "").localeCompare(b.ref || "", undefined, { numeric: true }));
  const items = ids.map((id) => ctx.doc.items.get(id)).filter(Boolean); const a = topLeftAnchor(items);
  return openForm({ title: "Position Relative To Reference Item", fields: [
    { k: "ref", label: "Reference", type: "select", value: "origin", options: [["origin", "Grid origin (0, 0)"], ["point", "Point below"]].concat(fps.map((f) => [f.id, `${f.ref || f.lib} (${fmt(f.x)}, ${fmt(f.y)})`])) },
    { k: "px", label: "Point X (mm)", type: "num", value: r6(a[0]) }, { k: "py", label: "Point Y (mm)", type: "num", value: r6(a[1]) },
    { k: "dx", label: "Offset X (mm)", type: "num", value: 0 }, { k: "dy", label: "Offset Y (mm)", type: "num", value: 0 }],
    apply: (v) => { const ref = v.ref === "origin" ? [0, 0] : v.ref === "point" ? [num0(v.px, 0), num0(v.py, 0)] : anchorOf(ctx.doc.items.get(v.ref)); return commitSel(ctx, positionRelativeChanges(ctx.doc, ids, ref, num0(v.dx, 0), num0(v.dy, 0)), "position relative"); } });
});
for (const [id, mode, label] of [["alignLeft", "left", "Align to Left"], ["alignRight", "right", "Align to Right"], ["alignTop", "top", "Align to Top"], ["alignBottom", "bottom", "Align to Bottom"], ["alignCenterX", "centerX", "Align to Vertical Center"], ["alignCenterY", "centerY", "Align to Horizontal Center"]])
  act(id, label, "", (ctx) => { const ids = editableOrToast(ctx, "Select two or more items to align"); if (!ids) return true; return commitSel(ctx, alignChanges(ctx.doc, ids, mode, ctx.cursor), label.toLowerCase()); });
for (const [id, axis, centers, label] of [["distributeH", "x", false, "Distribute Horizontally by Gaps"], ["distributeV", "y", false, "Distribute Vertically by Gaps"], ["distributeHCenters", "x", true, "Distribute Horizontally by Centers"], ["distributeVCenters", "y", true, "Distribute Vertically by Centers"]])
  act(id, label, "", (ctx) => { const ids = editableOrToast(ctx, "Select three or more items to distribute"); if (!ids) return true; if (ids.length < 3) { ctx.toast("Distribute needs at least three items"); return true; } return commitSel(ctx, distributeChanges(ctx.doc, ids, axis, centers), label.toLowerCase()); });
alias("distributeHorizontallyGaps", "distributeH"); alias("distributeVerticallyGaps", "distributeV"); alias("distributeHorizontallyCenters", "distributeHCenters"); alias("distributeVerticallyCenters", "distributeVCenters");
function rotateBy(ctx, deg) {
  const ids = editableOrToast(ctx, "Select items to rotate"); if (!ids) return true; const items = ids.map((id) => ctx.doc.items.get(id)).filter((it) => it && it.kind !== "group");
  if (items.length === 1 && items[0].kind === "footprint") { ctx.commit([replacedChange(items[0], rotateFootprintNode(clone(items[0].node), deg))], "rotate"); return true; }
  const c = selectionCenter(items); return commitSel(ctx, rotateChanges(ctx.doc, ids, c[0], c[1], deg), "rotate");
}
act("rotateSelection", "Rotate Counterclockwise", "R", (ctx) => rotateBy(ctx, 90)); alias("rotateCcw", "rotateSelection");
act("rotateSelectionCw", "Rotate Clockwise", "", (ctx) => rotateBy(ctx, -90)); alias("rotateCw", "rotateSelectionCw");
act("flipSelection", "Flip", "F", (ctx) => {
  const ids = editableOrToast(ctx, "Select items to flip"); if (!ids) return true; const items = ids.map((id) => ctx.doc.items.get(id)).filter((it) => it && it.kind !== "group");
  if (items.length === 1 && items[0].kind === "footprint") { const node = flipFootprintNode(clone(items[0].node)); ctx.commit([replacedChange(items[0], node)], "flip"); ctx.toast(`${items[0].ref || "Footprint"} flipped to ${layerOf(node)}`); return true; }
  const c = selectionCenter(items); return commitSel(ctx, flipChanges(ctx.doc, ids, c[0]), "flip");
});
alias("flip", "flipSelection");
for (const [id, axis, label] of [["mirrorH", "h", "Mirror Horizontally"], ["mirrorV", "v", "Mirror Vertically"]])
  act(id, label, "", (ctx) => { const ids = editableOrToast(ctx, "Select items to mirror"); if (!ids) return true; const items = ids.map((i) => ctx.doc.items.get(i)); const c = selectionCenter(items); const ch = mirrorChanges(ctx.doc, ids, c[0], c[1], axis); if (!ch.length && items.some((it) => it.kind === "footprint")) { ctx.toast("Footprints cannot be mirrored in the board editor (use Flip)"); return true; } return commitSel(ctx, ch, label.toLowerCase()); });
act("swap", "Swap", "Alt+S", (ctx) => { const ids = editableOrToast(ctx, "Select two or more items to swap"); if (!ids) return true; return commitSel(ctx, swapChanges(ctx.doc, ids), "swap"); });
act("pack", "Pack and Move Footprints", "P", (ctx) => { const ids = editableOrToast(ctx, "Select footprints to pack"); if (!ids) return true; return commitSel(ctx, packChanges(ctx.doc, ids), "pack footprints"); });
alias("packAndMoveFootprints", "pack");
act("createArray", "Create Array…", "", (ctx) => {
  const ids = selectionOrToast(ctx, "Select items to array"); if (!ids) return true;
  return openForm({ title: "Create Array", fields: [{ k: "nx", label: "Horizontal count", type: "num", value: 2, step: "1" }, { k: "ny", label: "Vertical count", type: "num", value: 1, step: "1" }, { k: "dx", label: "Horizontal spacing (mm)", type: "num", value: 5 }, { k: "dy", label: "Vertical spacing (mm)", type: "num", value: 5 }],
    apply: (v) => { const r = arrayChanges(ctx.doc, ids, { nx: num0(v.nx, 1), ny: num0(v.ny, 1), dx: num0(v.dx, 0), dy: num0(v.dy, 0) }); if (!r.changes.length) { ctx.toast("Array: nothing to add (counts of 1)"); return; } ctx.commit(r.changes, "array"); applySelection(ctx, ids.concat(r.ids)); } });
});
act("swapLayers", "Swap Layers…", "", (ctx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const copper = copperOf(doc); const layers = copper.concat(gfxLayers(doc).filter((l) => !copper.includes(l)));
  return openForm({ title: "Swap Layers", width: 380, fields: layers.map((l) => ({ k: l, label: l, type: "select", value: l, options: layers })), apply: (v) => {
    const map = {}; for (const l of layers) if (v[l] && v[l] !== l) map[l] = v[l]; if (!Object.keys(map).length) { ctx.toast("No layers swapped"); return; }
    const ch = transformChanges(doc, Array.from(doc.items.keys()), (n, it) => {
      if (it.kind === "footprint" || it.kind === "group") return false; let did = false;
      const l = K.kid(n, "layer"); if (l && map[K.str(l[1])]) { l[1] = map[K.str(l[1])]; did = true; }
      const ls = K.kid(n, "layers"); if (ls) for (let i = 1; i < ls.length; i++) if (map[K.str(ls[i])]) { ls[i] = map[K.str(ls[i])]; did = true; }
      if (it.kind === "zone") for (const fp of K.kids(n, "filled_polygon")) { const fl = K.kid(fp, "layer"); if (fl && map[K.str(fl[1])]) { fl[1] = map[K.str(fl[1])]; did = true; } }
      if (it.kind === "dimension") { const gt = K.kid(n, "gr_text"); const gl = gt && K.kid(gt, "layer"); if (gl && map[K.str(gl[1])]) { gl[1] = map[K.str(gl[1])]; did = true; } }
      return did ? undefined : false;
    });
    commitSel(ctx, ch, "swap layers");
  } });
});
// tracks and vias
act("changeTrackWidth", "Change Track Width / Via Size…", "", (ctx) => {
  const ids = selectionOrToast(ctx, "Select tracks or vias first"); if (!ids) return true; const copper = copperOf(ctx.doc);
  const items = ids.map((id) => ctx.doc.items.get(id)); const seg = items.find((it) => it.kind === "segment" || it.kind === "arc"), via = items.find((it) => it.kind === "via");
  if (!seg && !via) { ctx.toast("No tracks or vias in the selection"); return true; }
  const vl = via ? (K.kid(via.node, "layers") || [0, "F.Cu", "B.Cu"]).slice(1).map(K.str) : ["F.Cu", "B.Cu"];
  return openForm({ title: "Track & Via Properties", fields: [
    { k: "netclass", label: "Use netclass values", type: "check", value: false },
    { k: "width", label: "Track width (mm)", type: "num", value: seg ? widthOf(seg.node, 0.25) : "" },
    { k: "viaSize", label: "Via diameter (mm)", type: "num", value: via ? K.num((K.kid(via.node, "size") || [0, 0.8])[1]) : "" }, { k: "viaDrill", label: "Via drill (mm)", type: "num", value: via ? K.num((K.kid(via.node, "drill") || [0, 0.4])[1]) : "" },
    { k: "viaType", label: "Via type", type: "select", value: via ? (via.node.includes("micro") ? "micro" : via.node.includes("blind") ? "blind" : "through") : "through", options: [["through", "Through"], ["blind", "Blind/buried"], ["micro", "Micro"]] },
    { k: "l0", label: "Via start layer", type: "select", value: vl[0], options: copper }, { k: "l1", label: "Via end layer", type: "select", value: vl[1] || copper[copper.length - 1], options: copper }],
    apply: (v) => commitSel(ctx, trackEditChanges(ctx.doc, ids, { netclass: v.netclass, width: num0(v.width, 0), viaSize: num0(v.viaSize, 0), viaDrill: num0(v.viaDrill, 0), viaType: v.viaType, viaLayers: [v.l0, v.l1] }, settingsOf(ctx)), "track width") });
});
alias("editTracksAndVias", "changeTrackWidth");
act("setTrackWidthFromNetclass", "Set Track / Via Sizes from Netclass", "", (ctx) => { const ids = selectionOrToast(ctx, "Select tracks or vias first"); if (!ids) return true; return commitSel(ctx, trackEditChanges(ctx.doc, ids, { netclass: true }, settingsOf(ctx)), "netclass sizes"); });
act("trackWidthInc", "Increase Track Width", "W", (ctx) => { if (canEdit(ctx)) cycleWidth(ctx, 1); return true; });
act("trackWidthDec", "Decrease Track Width", "Shift+W", (ctx) => { if (canEdit(ctx)) cycleWidth(ctx, -1); return true; });
act("viaSizeInc", "Increase Via Size", "'", (ctx) => { if (canEdit(ctx)) cycleVia(ctx, 1); return true; }); act("viaSizeDec", "Decrease Via Size", "\\", (ctx) => { if (canEdit(ctx)) cycleVia(ctx, -1); return true; });
act("autoTrackWidth", "Automatically select track width", "", (ctx) => { const on = sizesOf(ctx).toggleConnectedWidth(); ctx.toast(on ? "Routing from an existing track uses its width" : "New tracks take the current width setting"); return true; }, { toggle: () => !!K.pcbSizes.state.useConnectedWidth, menu: "-" });
// the active layer (PCB_CONTROL): PgUp / PgDn, + / -, and V with nothing being routed toggles within the routing pair
act("layerTop", "Switch to Component (F.Cu) layer", "PgUp", (ctx) => { setLayer(ctx, viaSpan(ctx.doc)[0]); return true; }, { menu: "-" });
act("layerBottom", "Switch to Copper (B.Cu) Layer", "PgDn", (ctx) => { setLayer(ctx, viaSpan(ctx.doc)[1]); return true; }, { menu: "-" });
act("layerNext", "Switch to Next Layer", "+", (ctx) => stepLayer(ctx, true), { menu: "-" });
act("layerPrev", "Switch to Previous Layer", "-", (ctx) => stepLayer(ctx, false), { menu: "-" });
act("layerToggle", "Toggle Layer", "", (ctx) => { setLayer(ctx, sizesOf(ctx).pairedLayer(S.route ? S.route.layer : S.layer)); return true; }, { menu: "-" });
act("ratsnestLineMode", "Curved Ratsnest Lines", "", (ctx) => { const R = sizesOf(ctx); R.setCurvedRatsnest(!R.curvedRatsnest); ctx.requestRender(); return true; }, { toggle: () => !!K.pcbSizes.state.curvedRatsnest, menu: "-" });
// the two routing dialogs are built by the editor bundle (web/editor/pcbrouting.ts) and handed over through pcb.setRoutingDialogs
let routingDialogs = {};
act("selectLayerPair", "Set Layer Pair...", "", (ctx) => { if (routingDialogs.layerPair) routingDialogs.layerPair(ctx); else ctx.toast("Set Layer Pair: dialogs are unavailable here"); return true; }, { menu: "-" });
act("editPredefinedSizes", "Edit Pre-defined Sizes...", "", (ctx) => { if (routingDialogs.sizes) routingDialogs.sizes(ctx); else ctx.toast("Edit Pre-defined Sizes: dialogs are unavailable here"); return true; }, { menu: "-" });
// the grid origin and the drill / place file origin: picked with a one-shot tool, reset to the page origin
act("gridResetOrigin", "Reset Grid Origin", "", (ctx) => { sizesOf(ctx).setGridOrigin([0, 0]); ctx.toast("Grid origin reset"); ctx.requestRender(); return true; }, { menu: "-" });
act("drillResetOrigin", "Reset Drill Origin", "", (ctx) => { if (canEdit(ctx)) { sizesOf(ctx).setAuxOrigin([0, 0]); ctx.toast("Drill/place file origin reset"); ctx.requestRender(); } return true; }, { menu: "-" });
act("changeTrackLayerNext", "Move Track to Next Layer", "", (ctx) => { const ids = selectionOrToast(ctx, "Select tracks first"); if (!ids) return true; return commitSel(ctx, trackLayerChanges(ctx.doc, ids, 1), "track layer"); });
act("changeTrackLayerPrev", "Move Track to Previous Layer", "", (ctx) => { const ids = selectionOrToast(ctx, "Select tracks first"); if (!ids) return true; return commitSel(ctx, trackLayerChanges(ctx.doc, ids, -1), "track layer"); });
act("cleanupTracks", "Cleanup Tracks & Vias…", "", (ctx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const preview = cleanupPlan(doc, {});
  const opts = [["shorts", "Delete tracks connecting different nets"], ["vias", "Delete redundant vias"], ["merge", "Merge co-linear tracks"], ["dangling", "Delete tracks unconnected at one end"], ["danglingVias", "Delete dangling vias"], ["inPads", "Delete tracks fully inside pads"]];
  return openForm({ title: "Cleanup Tracks and Vias", width: 480, fields: opts.map(([k, label]) => ({ k, label, type: "check", value: true })).concat([{ k: "list", type: "table", columns: [{ label: "Action", width: "1fr" }, { label: "Items", width: "60px" }], rows: preview.items.map((i) => [i.text, i.ids.length]), empty: "Nothing to clean up with every option on.", onRow: (i) => highlightIds(ctx, new Set(preview.items[i].ids)) }]),
    apply: (v) => { const plan = cleanupPlan(doc, v); const ch = cleanupChanges(doc, plan); highlightIds(ctx, null); if (!ch.length) { ctx.toast("Nothing to clean up"); return; } ctx.commit(ch, "cleanup tracks"); ctx.toast(`Cleanup: ${plural(plan.items.length, "change")}`); } });
});
alias("cleanupTracksAndVias", "cleanupTracks");
act("breakTrack", "Break Track", "", (ctx) => { if (!canEdit(ctx)) return true; const seg = selectedItems(ctx).find((it) => it.kind === "segment"); return commitSel(ctx, breakTrackChanges(ctx.doc, cursorPoint(ctx), seg && hitTestItem(ctx.doc, cursorPoint(ctx)[0], cursorPoint(ctx)[1], 0.3) === seg ? seg : null), "break track"); });
act("unrouteSelected", "Unroute Selected", "", (ctx) => { const ids = selectionOrToast(ctx, "Select footprints or tracks to unroute"); if (!ids) return true; const nl = netlist(ctx.doc); const seeds = new Set(ids); const remove = connectedCopperIds(nl, seeds); return commitSel(ctx, deleteChanges(ctx.doc, Array.from(remove)), "unroute"); });
act("deleteFull", "Delete Full Track", "Shift+Delete", (ctx) => { const ids = selectionOrToast(ctx, "Select a track first"); if (!ids) return true; const run = connectedRun(ctx.doc, ids); for (const id of ids) run.add(id); S.sel.clear(); return commitSel(ctx, deleteChanges(ctx.doc, Array.from(run)), "delete full track"); });
// inspection
act("runDRC", "Design Rules Checker…", "", (ctx) => {
  bind(ctx); S.markers = drc(ctx.doc, settingsOf(ctx)); ctx.requestRender();
  const errors = S.markers.filter((m) => m.severity === "error").length, warnings = S.markers.length - errors;
  openForm({ title: "DRC Control", width: 620, fields: [{ type: "note", value: `${plural(errors, "error")}, ${plural(warnings, "warning")} — click a row to highlight it.` }, { k: "list", type: "table", columns: [{ label: "Severity", width: "70px" }, { label: "Violation", width: "1fr" }], rows: S.markers.map((m) => [m.severity, m.text]), empty: "No violations found.", onRow: (i) => { highlightIds(ctx, new Set(S.markers[i].ids)); if (ctx.setSelection && S.markers[i].ids.length) applySelection(ctx, S.markers[i].ids); } }], apply: () => { highlightIds(ctx, null); } });
  return true;
});
act("clearMarkers", "Clear DRC Markers", "", (ctx) => { S.markers = []; ctx.requestRender(); return true; });
act("netInspector", "Net Inspector…", "", (ctx) => {
  const rows = netInspector(ctx.doc);
  return openForm({ title: "Net Inspector", width: 640, fields: [{ k: "list", type: "table", columns: [{ label: "Name", width: "2fr" }, { label: "Pads", width: "50px" }, { label: "Vias", width: "50px" }, { label: "Track length", width: "100px" }, { label: "Unconnected", width: "90px" }], rows: rows.map((r) => [r.name, r.padCount, r.viaCount, fmt(r.trackLength) + " mm", r.unconnected]), empty: "No nets on this board.", onRow: (i) => highlightIds(ctx, netHighlightIds(ctx.doc, rows[i].name)) }], apply: () => { highlightIds(ctx, null); } });
});
alias("showNetInspector", "netInspector");
act("boardStatistics", "Board Statistics…", "", (ctx) => {
  const s = boardStatistics(ctx.doc);
  return openForm({ title: "Board Statistics", width: 440, fields: [{ k: "list", type: "table", columns: [{ label: "Item", width: "1fr" }, { label: "Count", width: "120px" }], rows: [["Footprints (front / back)", `${s.footprints.total} (${s.footprints.front} / ${s.footprints.back})`], ["Footprints SMD / THT / other", `${s.footprints.smd} / ${s.footprints.tht} / ${s.footprints.other}`], ["Pads SMD / THT / NPTH", `${s.pads.smd} / ${s.pads.tht} / ${s.pads.npth}`], ["Vias through / blind / micro", `${s.vias.through} / ${s.vias.blind} / ${s.vias.micro}`], ["Tracks (count, length)", `${s.tracks.count}, ${fmt(s.tracks.length)} mm`], ["Zones", s.zones], ["Drill holes", s.drills], ["Board size", `${fmt(s.width)} × ${fmt(s.height)} mm`], ["Board area", `${fmt(s.area)} mm²`]] }] });
});
act("inspectClearance", "Clearance Resolution…", "", (ctx) => {
  const ids = Array.from(selectionIds(ctx)); if (ids.length !== 2) { ctx.toast("Select exactly two copper items"); return true; }
  const r = inspectClearance(ctx.doc, ids[0], ids[1], settingsOf(ctx)); if (!r) { ctx.toast("Both items need copper"); return true; }
  return openForm({ title: "Clearance Report", fields: [{ type: "note", value: r.sameNet ? `Both items are on net '${r.nets[0]}': no clearance applies.` : r.gap === null ? "The items share no copper layer." : `Clearance required ${mm4(r.required)}; actual ${mm4(r.gap)} — ${r.gap >= r.required ? "OK" : "VIOLATION"}` }] });
});
act("showRatsnest", "Show Ratsnest", "", (ctx) => { S.showRatsnest = !S.showRatsnest; ctx.toast(S.showRatsnest ? "Ratsnest shown" : "Ratsnest hidden"); ctx.requestRender(); return true; }, { toggle: () => !!S.showRatsnest });
act("localRatsnestTool", "Local Ratsnest (selected footprints only)", "", (ctx) => { S.localRatsnest = !S.localRatsnest; ctx.toast(S.localRatsnest ? "Ratsnest: selected footprints only" : "Ratsnest: whole board"); ctx.requestRender(); return true; }, { toggle: () => !!S.localRatsnest });
act("hideNetInRatsnest", "Hide Net in Ratsnest", "", (ctx) => { const nl = netlist(ctx.doc); const keys = selectionNets(ctx, nl); for (const k of keys) S.hiddenNets.add(k); ctx.toast(keys.size ? `Hidden: ${Array.from(keys).join(", ")}` : "Select something on a net"); ctx.requestRender(); return true; });
act("showNetInRatsnest", "Show Net in Ratsnest", "", (ctx) => { const nl = netlist(ctx.doc); const keys = selectionNets(ctx, nl); if (!keys.size) S.hiddenNets.clear(); else for (const k of keys) S.hiddenNets.delete(k); ctx.requestRender(); return true; });
act("highlightNet", "Highlight Net", "`", (ctx) => {
  const nl = netlist(ctx.doc); let keys = selectionNets(ctx, nl);
  if (!keys.size) { const p = cursorPoint(ctx); const k = nl.table.key(netUnder(ctx.doc, p[0], p[1], null)); if (k) keys = new Set([k]); }
  if (!keys.size) { highlightIds(ctx, null); S.highlightNet = null; return true; }
  const key = keys.values().next().value; if (S.highlightNet === key) { S.highlightNet = null; highlightIds(ctx, null); return true; }
  S.highlightNet = key; const ids = new Set(); for (const k of keys) for (const id of netHighlightIds(ctx.doc, k, nl)) ids.add(id); highlightIds(ctx, ids); return true;   // no infobar: the net shows in the message panel
});
act("clearHighlight", "Clear Net Highlighting", "~", (ctx) => { S.highlightNet = null; highlightIds(ctx, null); return true; });
alias("toggleNetHighlight", "highlightNet", "Toggle Last Net Highlight", "Alt+`"); alias("highlightNetSelection", "highlightNet", "Highlight Net of Selection", "");
// groups and locks
act("group", "Group Items", "", (ctx) => { const ids = needSel(ctx, "Select items to group"); if (!ids || !canEdit(ctx)) return true; const ch = groupChanges(ctx.doc, ids, ""); if (!ch.length) { ctx.toast("Nothing to group"); return true; } ctx.commit(ch, "group"); ctx.toast(`Grouped ${plural(ids.size, "item")}`); return true; });
act("ungroup", "Ungroup Items", "", (ctx) => { const ids = needSel(ctx, "Select a group or a member"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, ungroupChanges(ctx.doc, ids), "ungroup"); });
act("addToGroup", "Add Items to Group", "", (ctx) => { const ids = needSel(ctx); if (!ids || !canEdit(ctx)) return true; const g = Array.from(ids).map((id) => groupOf(ctx.doc, id) || (ctx.doc.items.get(id).kind === "group" ? ctx.doc.items.get(id) : null)).find(Boolean); if (!g) { ctx.toast("The selection touches no group"); return true; } return commitSel(ctx, groupMembersChanges(ctx.doc, g, Array.from(ids).filter((id) => id !== g.id), []), "add to group"); });
act("removeFromGroup", "Remove Items from Group", "", (ctx) => { const ids = needSel(ctx); if (!ids || !canEdit(ctx)) return true; const out = []; const seen = new Map(); for (const id of ids) { const g = groupOf(ctx.doc, id); if (g) { if (!seen.has(g.id)) seen.set(g.id, { g, ids: [] }); seen.get(g.id).ids.push(id); } } for (const { g, ids: rm } of seen.values()) out.push(...groupMembersChanges(ctx.doc, g, [], rm)); return commitSel(ctx, out, "remove from group"); });
act("toggleLock", "Toggle Lock", "L", (ctx) => { const ids = needSel(ctx, "Select items to lock"); if (!ids || !canEdit(ctx)) return true; const items = Array.from(ids, (id) => ctx.doc.items.get(id)); const on = !items.every((it) => isLocked(it.node)); const ch = lockChanges(ctx.doc, ids, on); ctx.toast(on ? "Locked" : "Unlocked"); return commitSel(ctx, ch, on ? "lock" : "unlock"); });
act("lock", "Lock", "", (ctx) => { const ids = needSel(ctx, "Select items to lock"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, lockChanges(ctx.doc, ids, true), "lock"); });
act("unlock", "Unlock", "", (ctx) => { const ids = needSel(ctx, "Select items to unlock"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, lockChanges(ctx.doc, ids, false), "unlock"); });
// footprint attributes, text, conversions, zones
act("toggleExcludeFromBOM", "Exclude from Bill of Materials", "", (ctx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_bom"), "exclude from BOM"); });
act("toggleExcludeFromPosFiles", "Exclude from Position Files", "", (ctx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_pos_files"), "exclude from position files"); });
act("toggleDNP", "Do Not Populate", "", (ctx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "dnp"), "dnp"); });
for (const [id, how, label] of [["leftJustify", "left", "Left Justify"], ["centerJustify", "center", "Center Justify"], ["rightJustify", "right", "Right Justify"]])
  act(id, label, "", (ctx) => { const ids = selectionOrToast(ctx, "Select text first"); if (!ids) return true; return commitSel(ctx, justifyChanges(ctx.doc, ids, how), label.toLowerCase()); });
for (const [id, to, label] of [["convertToPoly", "poly", "Create Polygon from Selection"], ["convertToLines", "lines", "Create Lines from Selection"], ["convertToTracks", "tracks", "Create Tracks from Selection"], ["convertToZone", "zone", "Create Zone from Selection"], ["convertToKeepout", "keepout", "Create Rule Area from Selection"]])
  act(id, label, "", (ctx) => {
    const ids = selectionOrToast(ctx, "Select graphic shapes first"); if (!ids) return true;
    if (to === "zone") { const items = ids.map((i) => ctx.doc.items.get(i)); const layer = /\.Cu$/.test(layerOf(items[0].node, "")) ? layerOf(items[0].node) : S.layer; const nets = boardNets(ctx.doc);
      askText(ctx, "Zone net", "", (name) => { if (name === null) return; const net = name ? (nets.find((n) => n.name === name) || { code: -1, name }) : { code: 0, name: "" }; commitSel(ctx, convertChanges(ctx.doc, ids, "zone", { layer, net }), "zone from shapes"); }, nets.map((n) => n.name)); return true; }
    return commitSel(ctx, convertChanges(ctx.doc, ids, to), label.toLowerCase());
  });
for (const [id, how, label] of [["zonePriorityRaise", "raise", "Raise Zone Priority"], ["zonePriorityLower", "lower", "Lower Zone Priority"], ["zonePriorityMoveToTop", "top", "Move Zone Priority to Top"], ["zonePriorityMoveToBottom", "bottom", "Move Zone Priority to Bottom"]])
  act(id, label, "", (ctx) => { const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; return commitSel(ctx, zonePriorityChanges(ctx.doc, ids, how), label.toLowerCase()); });
act("zoneDuplicate", "Duplicate Zone onto Layer…", "", (ctx) => {
  const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; const zones = ids.map((id) => ctx.doc.items.get(id)).filter((it) => it.kind === "zone"); if (!zones.length) { ctx.toast("No zone selected"); return true; }
  return openForm({ title: "Duplicate Zone", fields: [{ k: "layer", label: "Layer", type: "select", value: zoneLayers(zones[0].node)[0] || "F.Cu", options: copperOf(ctx.doc) }], apply: (v) => { const out = []; for (const z of zones) { const node = clone(z.node); const u = K.kid(node, "uuid"); if (u) node.splice(node.indexOf(u), 1); for (const fp of K.kids(node, "filled_polygon")) node.splice(node.indexOf(fp), 1); const l = K.kid(node, "layer"), ls = K.kid(node, "layers"); if (l) l[1] = v.layer; else if (ls) ls.splice(1, ls.length - 1, v.layer); out.push(addedChange(ctx.doc, node, netOf(node))); } commitSel(ctx, out, "duplicate zone"); } });
});
// Filling is the desktop application's job: its filler is what the fabrication output comes from, so the
// browser never approximates one.  It asks a desktop editor in the document to refill; the result arrives
// as an ordinary edit.
act("zoneFillAll", "Fill All Zones", "B", (ctx) => { if (ctx.viewOnly) { ctx.toast("View only"); return true; } if (!ctx.requestDesktop || !ctx.requestDesktop("fill_zones")) { ctx.toast("Not connected"); return true; } ctx.toast("Asked the desktop app to refill zones"); return true; });
// ZONE::UnFill (ZONE_FILLER_TOOL::ZoneUnfill / ZoneUnfillAll): the filled areas go and the zone is no longer marked
// filled — exactly what pcbnew writes after an unfill, so the browser can do it itself.
function unfillChanges(doc, zones) {
  const out = [];
  for (const z of zones) {
    if (!z || z.kind !== "zone") continue;
    const node = clone(z.node); let changed = false;
    for (let i = node.length - 1; i > 0; i--) if (Array.isArray(node[i]) && node[i][0] === "filled_polygon") { node.splice(i, 1); changed = true; }
    const fill = K.kid(node, "fill"); if (fill && fill[1] === "yes") { fill.splice(1, 1); changed = true; }
    if (changed) out.push(replacedChange(z, node));
  }
  return out;
}
act("zoneUnfill", "Unfill Selected Zone(s)", "", (ctx) => { if (!canEdit(ctx)) return true; const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; return commitSel(ctx, unfillChanges(ctx.doc, ids.map((id) => ctx.doc.items.get(id))), "Unfill Zone"); });
act("zoneUnfillAll", "Unfill All Zones", "Ctrl+B", (ctx) => { if (!canEdit(ctx)) return true; return commitSel(ctx, unfillChanges(ctx.doc, Array.from(ctx.doc.items.values())), "Unfill All Zones"); });
// The autorouter is its own bundle (web/router → dist/autoroute.js); this is its entry in the Route menu.
act("autoroute", "Autoroute…", "", (ctx) => { const r = root.PcbAutoRouter; if (!r || !r.open) { ctx.toast("The autorouter is not loaded"); return true; } return r.open(ctx); }, { menu: "Route" });
act("autoplace", "Auto Place Footprints…", "", (ctx) => { const r = root.PcbAutoRouter; if (!r || !r.openPlace) { ctx.toast("The placer is not loaded"); return true; } return r.openPlace(ctx); }, { menu: "Tools" });
// library access (web/editor/library.ts, window.KiCadLibrary): KiCad's footprint chooser and the footprint library browser
const libraryAction = (opts) => (ctx) => { const L = root.KiCadLibrary; if (!L || !L.chooseAndPlace) { ctx.toast("The library module is not loaded"); return true; } L.chooseAndPlace("footprint", opts); return true; };
act("placeFootprint", "Place Footprints", "A", libraryAction());
act("showFootprintBrowser", "Footprint Library Browser", "", libraryAction({ browser: true }));
Object.freeze(ACTIONS);

// ---------------------------------------------------------------- DOM: select-mode picking, stolen keys, layer chip, text prompt
function ensureDom(ctx) {
  if (domReady || typeof document === "undefined" || !ctx.stage) return; domReady = true;
  // The module's pointer hooks only run while one of its tools is active; picking tracks in the app's own
  // select tool listens on the stage after app.js has had its turn with the footprints.
  ctx.stage.addEventListener("pointerdown", onStagePointerDown);
  window.addEventListener("pointerdown", onStickyPointerDown, true);   // before every stage listener: the click that drops a Move is nobody else's
  ctx.stage.addEventListener("pointermove", onStagePointerMove, true);
  ctx.stage.addEventListener("pointerup", onStagePointerUp, true);
  ctx.stage.addEventListener("pointercancel", onStagePointerUp, true);
  // Keys app.js consumes before the module (F = fit view, Shift+C = comment, Escape) are caught in the
  // capture phase and re-posted under names of our own so they still arrive through onKey with a fresh ctx.
  document.addEventListener("keydown", onCaptureKey, true);
  // pcbnew has no canvas chip: the active layer, track width and via size live in the aux toolbar's combos
  K.pcbSizes.state.subscribe(() => { refreshChip(lastCtx); if (lastCtx && lastCtx.requestRender) lastCtx.requestRender(); });   // the toolbar's selectors and the size hotkeys land here
  refreshChip(ctx);
}
/** Keeps the graphic tools' layer on a layer they can draw on (the toolbar's layer combo shows it). */
function refreshChip(ctx) {
  if (!isPcbDoc() || !gfxTool(S.modTool)) return;
  const opts = gfxLayers(ctx && ctx.doc);
  if (!opts.includes(S.gfxLayer)) { S.gfxLayer = opts[0] || "F.SilkS"; if (ctx) sizesOf(ctx).setActiveLayer(S.gfxLayer); }
}
function onStagePointerDown(ev) {
  if (ev.button !== 0 || !isPcbDoc() || appTool() !== "select") return;
  if (S.downHandled === ev) return;                                // onSelectDown already took this click
  if (ev.target.closest && (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay"))) return;
  const ctx = lastCtx, doc = liveDoc(); if (!ctx || !doc) return;
  const [x, y] = ctx.worldMm(ev);
  if (K.hitTest(doc, x, y, Math.min(5 / Math.max(1, liveZoom() * 0.6), 0.5))) { if (S.sel.size && !selMode(ev)) { S.sel.clear(); ctx.requestRender(); } return; }   // app.js took the footprint (a modifier keeps the module's picks)
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  const mode = selMode(ev);
  if (it) { if (mode) applySelMode(S.sel, it.id, mode); else S.sel = new Set([it.id]); }
  else if (!mode) S.sel.clear();
  ctx.requestRender();
}
/** SELECTION_TOOL::setModifiersState: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift removes; null replaces. */
function selMode(ev) { const c = !!(ev && (ev.ctrlKey || ev.metaKey)), sh = !!(ev && ev.shiftKey); return c && sh ? "remove" : c ? "toggle" : sh ? "add" : null; }
function applySelMode(set, id, mode) { if (mode === "add") set.add(id); else if (mode === "remove") set.delete(id); else if (mode === "toggle") { if (set.has(id)) set.delete(id); else set.add(id); } }
// KiCad's Ctrl+Shift chords (app.js swallows every Ctrl combo) and Alt+Z, the macOS zone hotkey — Ctrl+Shift+Z is
// the web's redo — are re-posted under names of our own.
const CTRL_SHIFT_KEYS = { a: "Arc", p: "Polygon", b: "Bezier", h: "Ortho", k: "RuleArea", c: "Circle", v: "PasteSpecial" };
// KiCad's Ctrl+C / X / V / D (app.js would take C for the comment tool) and Alt+S (swap)
const CTRL_KEYS = { c: "Copy", x: "Cut", v: "Paste", d: "Duplicate" };
function repost(ev, key) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
const liveSelection = () => appGlobal(() => editorState().selection, null);
function onCaptureKey(ev) {
  if (!isPcbDoc()) return;
  const tag = ev.target && ev.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (root.KDialogs && root.KDialogs.isOpen && root.KDialogs.isOpen()) return;
  const k = ev.key;
  if (ev.altKey && !ev.metaKey) { if (!ev.ctrlKey && !ev.shiftKey && ev.code === "KeyZ") repost(ev, "Zone"); else if (!ev.ctrlKey && !ev.shiftKey && ev.code === "KeyS") repost(ev, "Swap"); return; }
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.altKey) return;
    const ctrlRemap = typeof k === "string" ? (ev.shiftKey ? CTRL_SHIFT_KEYS[k.toLowerCase()] : CTRL_KEYS[k.toLowerCase()]) : null;
    if (ctrlRemap && !(ev.metaKey && ctrlRemap === "Circle")) repost(ev, ctrlRemap);
    return;
  }
  if (k === "Escape") {
    if (S.route || S.draw || S.drag || S.text || S.image || (S.move && S.move.sticky)) {   // first Escape only cancels the operation, KiCad style; the next one leaves the tool
      const dragTool = S.drag && S.drag.tool;
      cancelOps(); ev.stopImmediatePropagation(); ev.preventDefault();
      if (dragTool && lastCtx) lastCtx.setTool("select");   // Escape ends InlineDrag: back to the selection tool
      if (lastCtx) { refreshChip(lastCtx); lastCtx.requestRender(); }   // Esc cancels silently
    } else if (S.sel.size || S.padSel) { S.sel.clear(); S.padSel = null; if (lastCtx) lastCtx.requestRender(); }
    return;
  }
  let remap = null;
  const sel = liveSelection();
  if ((k === "f" || k === "F") && !ev.shiftKey && (liveSelected() || (sel && sel.size) || S.sel.size)) remap = "Flip";
  else if (k === "C" && ev.shiftKey) remap = "Circle";
  if (remap) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key: remap, bubbles: true, cancelable: true })); }
}
// Positioned prompt over the stage (text, table size, zone net — with the board's nets as suggestions); Enter commits
// the trimmed value, Escape or a blur cancels with null.  Swappable through pcb.setPrompt for the node tests.
let promptImpl = function (title, initial, client, done, options) {
  if (typeof document === "undefined") { done(null); return; }
  closeTextPrompt();
  const x = client ? client[0] + 6 : 40, y = client ? client[1] - 14 : 40;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${Math.max(4, Math.min(x, (window.innerWidth || 800) - 330))}px;top:${Math.max(4, y)}px;z-index:60;display:flex;gap:6px;align-items:center;padding:4px 6px;border-radius:3px;border:1px solid #4D7FC4;background:#111D2C;color:#E6E6E6;font:12px var(--mono,ui-monospace,monospace)`;
  const label = document.createElement("span"); label.textContent = title; label.style.cssText = "color:#9FB3CC;white-space:nowrap"; box.appendChild(label);
  const inp = document.createElement("input"); inp.value = initial || ""; inp.placeholder = "Enter to place, Esc to cancel"; inp.spellcheck = false;
  inp.style.cssText = "width:200px;padding:2px 5px;border-radius:2px;border:1px solid #24374E;background:#0A1421;color:inherit;font:inherit;outline:none";
  if (options && options.length) {
    const dl = document.createElement("datalist"); dl.id = "pcbPromptList";
    for (const o of options) { const op = document.createElement("option"); op.value = o; dl.appendChild(op); }
    box.appendChild(dl); inp.setAttribute("list", dl.id);
  }
  box.appendChild(inp);
  let closed = false; const finish = (v) => { if (closed) return; closed = true; closeTextPrompt(); done(v); };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(inp.value.trim()); else if (e.key === "Escape") finish(null); });
  inp.addEventListener("blur", () => setTimeout(() => finish(null), 0));
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(box); S.text = { box };
  setTimeout(() => { inp.focus(); inp.select(); }, 0);   // after app.js's preventDefault on the pointerdown that opened it
};
function closeTextPrompt() { const t = S.text; S.text = null; if (t && t.box && t.box.parentNode) t.box.parentNode.removeChild(t.box); }
// The reference image file dialog: done({ base64, name }) or done(null).  Swappable through pcb.setImagePicker.
let pickerImpl = function (done) {
  if (typeof document === "undefined") { done(null); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg"; inp.style.display = "none";
  let finished = false; const finish = (v) => { if (finished) return; finished = true; if (inp.parentNode) inp.parentNode.removeChild(inp); done(v); };
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0]; if (!f) { finish(null); return; }
    const fr = new FileReader(); fr.onload = () => finish({ base64: String(fr.result).replace(/^data:[^,]*,/, ""), name: f.name }); fr.onerror = () => finish(null); fr.readAsDataURL(f);
  });
  inp.addEventListener("cancel", () => finish(null));
  document.body.appendChild(inp); inp.click();
};

// ---------------------------------------------------------------- overlay
/** The board's ratsnest, rebuilt after a document change and kept until the next one. */
function ratsnestLines(doc) {
  if (!S.rats || S.rats.doc !== doc || S.ratsDirty) { S.rats = { doc, lines: ratsnest(doc) }; S.ratsDirty = false; }
  return S.rats.lines;
}
/**
 * CONNECTIVITY_DATA::ComputeLocalRatsnest: while items move, one line per net from the moving copper to the nearest
 * stationary anchor of the same net (RN_NET::NearestBicoloredPair) -- the old tracks stay, so the line runs from the
 * moved pad back to where its track ends.  `moving` is a set of item ids; nets whose anchors all move draw nothing.
 */
function dynamicRatsnest(doc, moving) {
  if (!moving || !moving.size) return [];
  const NT = netTable(doc), dyn = new Map(), stat = new Map();
  const put = (m, net, p, id) => { if (!net) return; let a = m.get(net); if (!a) m.set(net, a = []); a.push({ p, id }); };
  for (const it of doc.items.values()) {
    const mv = moving.has(it.id);
    if (it.kind === "footprint") { for (const p of padsOf(it)) if (p.type !== "np_thru_hole") put(mv ? dyn : stat, NT.key(p.net), [p.x, p.y], it.id); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) put(mv ? dyn : stat, NT.key(netOf(it.node)), a, it.id); }
    else if (it.kind === "segment" || it.kind === "arc") { const k = NT.key(netOf(it.node)); for (const key of ["start", "end"]) { const a = pt(it.node, key); if (a) put(mv ? dyn : stat, k, a, it.id); } }
  }
  const out = [];
  for (const [net, ds] of dyn) {
    const ss = stat.get(net); if (!ss || !ss.length) continue;
    let best = null, bd = Infinity;
    for (const d of ds) for (const t of ss) { const dd = (d.p[0] - t.p[0]) ** 2 + (d.p[1] - t.p[1]) ** 2; if (dd < bd) { bd = dd; best = { a: d.p, b: t.p, net, ids: [d.id, t.id] }; } }
    if (best && bd > 1e-12) out.push(best);
  }
  return out;
}
/** Ids moving right now: the app's footprint drag / Move (M) and the module's own select-tool move. */
function movingIds() {
  const out = new Set(); const E = editorState();
  const d = E && E.drag; if (d && d.moved) { if (d.group) for (const g of d.group) out.add(g.fp.id); else if (d.fp) out.add(d.fp.id); }
  if (S.move && S.move.moved) { for (const id of S.move.ids || []) out.add(id); for (const c of S.move.conns || []) for (const id of c.l.ids) out.add(id); }   // a D drag's attached lines go with it
  return out;
}
function strokeGeom(c, g) {
  if (g.t === "line") { c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
  else if (g.t === "poly") { if (g.pts.length < 2) return; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); c.stroke(); }
  else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); c.stroke(); }
  else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.stroke(); }
  else if (g.t === "rect" || g.t === "image") c.strokeRect(g.x, g.y, g.w, g.h);
}
function line(c, a, b) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
/** A router shape grown by `grow` mm, filled (ROUTER_PREVIEW_ITEM's drawShape / drawClearanceHalo). */
function drawShape(c, sh, grow, colour, alpha) {
  c.globalAlpha = alpha; c.fillStyle = colour; c.strokeStyle = colour;
  const off = shapeOffset(sh) + grow;
  if (sh.t === "circle") { c.beginPath(); c.arc(sh.x, sh.y, Math.max(off, 1e-4), 0, Math.PI * 2); c.fill(); return; }
  const pts = sh.t === "seg" ? [sh.a, sh.b] : sh.t === "rect" ? rectCore(sh).concat([rectCore(sh)[0]]) : sh.pts;
  const closed = sh.t === "rect" || sh.t === "poly";
  if (closed) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath(); c.fill(); }
  if (off > 0) { c.lineWidth = 2 * off; c.lineJoin = "round"; c.lineCap = "round"; polyline(c, pts, closed); }
}
function ring(c, p, r) { c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.stroke(); }
function polyline(c, pts, close) { if (pts.length < 2) return; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); if (close) c.closePath(); c.stroke(); }
/** A dimension in progress, drawn from the same geometry the node gets. */
function drawDimPreview(c, d, px) {
  const type = DIM_TYPE[d.shape], layer = S.gfxLayer, s = d.start;
  const dd = { start: s, end: d.end || d.cur, height: d.height || 0, orientation: d.orientation, textPos: d.textPos, text: d.shape === "leader" ? "Leader" : "" };
  if (type === "center" && !d.end) dd.end = vadd(s, snap45(vsub(d.cur, s)));
  if (samePt(dd.start, dd.end)) return;
  const g = dimGeometry(type, dd, layer);
  c.lineWidth = Math.max(gfxWidth(layer), 1.5 * px);
  for (const [a, b] of g.lines) line(c, a, b);
  for (const [p, ang] of g.arrows) for (const barb of [27.5, -27.5]) { const r = (ang + barb) * Math.PI / 180; line(c, p, [p[0] + ARROW_LEN * Math.cos(r), p[1] + ARROW_LEN * Math.sin(r)]); }
  if (g.text) {
    c.save(); c.translate(g.tpos[0], g.tpos[1]); c.rotate(-g.tang * Math.PI / 180); c.font = `${g.size * 1.3}px sans-serif`;
    c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = c.strokeStyle; c.fillText(g.text, 0, 0); c.restore();
  }
}
function drawOverlay(c, view, ctx) {
  bind(ctx); const doc = ctx.doc; if (!doc) return;
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
  c.lineCap = "round"; c.lineJoin = "round";
  // the selection is not drawn here: the document pass repaints selected items in their layer's selected colour
  // (PCB_PAINTER::getColor, m_layerColorsSel), with no outline
  // ratsnest (KiCad's default colour), the whole board or only the lines reaching the selected footprints
  if (S.showRatsnest) {
    const lines = ratsnestLines(doc); const sel = S.localRatsnest ? selectionIds(ctx) : null;
    c.globalAlpha = 1; c.strokeStyle = RATSNEST; c.lineWidth = 1 * px; c.beginPath();
    const curved = K.pcbSizes.state.curvedRatsnest;   // RATSNEST_VIEW_ITEM: a Bezier whose two control points sit 10% off the midpoint
    const trace = (l) => {
      c.moveTo(l.a[0], l.a[1]);
      if (curved) { const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], mx = l.a[0] + 0.5 * dx - 0.1 * dy, my = l.a[1] + 0.5 * dy + 0.1 * dx; c.bezierCurveTo(mx, my, mx, my, l.b[0], l.b[1]); }
      else c.lineTo(l.b[0], l.b[1]);
    };
    const tinted = S.ratsnestColors && S.ratsnestColors.size ? [] : null;   // net name -> colour, set by the Appearance pane's Nets tab
    const hlNet = S.route && S.route.netKey ? S.route.netKey : null, bright = hlNet ? [] : null;   // while routing: the rest at half alpha, the routed net brightened 0.8, alpha + 0.4
    if (hlNet) c.globalAlpha = 0.5;
    const moving = movingIds();   // RATSNEST_VIEW_ITEM: the static lines of moving items give way to the dynamic ones
    for (const l of lines) { if (S.hiddenNets.has(l.net)) continue; if (sel && !l.ids.some((id) => sel.has(id))) continue; if (moving.size && l.ids.some((id) => moving.has(id))) continue; if (bright && l.net === hlNet) { bright.push(l); continue; } if (tinted && S.ratsnestColors.has(l.net)) { tinted.push(l); continue; } trace(l); }
    c.stroke();
    if (tinted) for (const l of tinted) { c.strokeStyle = S.ratsnestColors.get(l.net); c.beginPath(); trace(l); c.stroke(); }
    if (bright && bright.length) { c.globalAlpha = 1; c.strokeStyle = RATSNEST_BRIGHT; c.beginPath(); for (const l of bright) trace(l); c.stroke(); }
    if (moving.size) { c.globalAlpha = 1; c.strokeStyle = RATSNEST; c.beginPath(); for (const l of dynamicRatsnest(doc, moving)) { if (!S.hiddenNets.has(l.net)) trace(l); } c.stroke(); }
  }
  // the grid origin (circle + X) and the drill / place file origin (circle + cross, red): ORIGIN_VIEWITEM, 16 px, hidden at 0,0
  { const R = K.pcbSizes.state; const r = 16 * px; c.globalAlpha = 1; c.lineWidth = 1 * px;
    const g = S.modTool === "gridorigin" && S.hover ? [S.hover.x, S.hover.y] : R.gridOrigin, d = S.modTool === "drillorigin" && S.hover ? [S.hover.x, S.hover.y] : R.auxOrigin;
    if (g[0] || g[1]) { c.strokeStyle = "#C2C2C2"; ring(c, g, r); line(c, [g[0] - r, g[1] - r], [g[0] + r, g[1] + r]); line(c, [g[0] - r, g[1] + r], [g[0] + r, g[1] - r]); }
    if (d[0] || d[1]) { c.strokeStyle = "#CC0000"; ring(c, d, r); line(c, [d[0] - r, d[1]], [d[0] + r, d[1]]); line(c, [d[0], d[1] - r], [d[0], d[1] + r]); } }
  // DRC markers: PCB_PAINTER::draw(PCB_MARKER) -- MARKER_BASE's pin polygon scaled by 1/sqrt(zoom), filled in
  // LAYER_DRC_ERROR / LAYER_DRC_WARNING over the LAYER_MARKER_SHADOWS outline
  if (S.markers.length && K.drawMarkers) {
    const shown = S.hiddenSeverities && S.hiddenSeverities.size ? S.markers.filter((m) => !S.hiddenSeverities.has(m.severity)) : S.markers;
    if (shown.length) K.drawMarkers(c, shown, "pcb", K.markerScale("pcb", view), K.PCB_BG);
  }
  // drag in progress (ROUTER::moveDragging): the rebuilt lines over the hidden originals
  drawDragPreview(c, ctx, view, px);
  // route in progress: fixed legs are already in the document, the current one lives here
  // ROUTER::markViolations: obstacles in violation (a refused start or via) in pure green over their clearance halo
  if (S.violations) for (const ob of S.violations.obs) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
  // route in progress (ROUTER::movePlacing): the head since the last click over its clearance halo, then the leading ratsnest line
  if (S.route) {
    const rt = S.route; const pts = rt.head || [rt.last];
    if (pts.length > 1) {
      c.globalAlpha = 0.7; c.strokeStyle = HALO_COLOR; c.lineWidth = rt.width + 2 * routeHaloClearance(ctx, rt); polyline(c, pts, false);   // track_clearance_mode SHOW_WITH_VIA_WHILE_ROUTING
      c.globalAlpha = 0.8; c.strokeStyle = saturated(color(rt.layer)); c.lineWidth = rt.width; polyline(c, pts, false);                      // PNS_HEAD_TRACE: the layer colour saturated, alpha 0.8
    }
    if (rt.ratline && S.showRatsnest) { c.globalAlpha = 1; c.strokeStyle = RATSNEST_LEAD; c.lineWidth = 1 * px; line(c, rt.ratline[0], rt.ratline[1]); }
  }
  // drawing preview
  if (S.draw) {
    const d = S.draw; const layer = d.shape === "zone" ? S.layer : d.shape === "rulearea" ? RULE_AREA_LAYERS[0] : S.gfxLayer;
    c.globalAlpha = 0.85; c.strokeStyle = color(layer); c.lineWidth = Math.max(gfxWidth(layer), 1.5 * px);
    const box = () => [Math.min(d.start[0], d.cur[0]), Math.min(d.start[1], d.cur[1]), Math.abs(d.cur[0] - d.start[0]), Math.abs(d.cur[1] - d.start[1])];
    if (d.shape === "gline") line(c, d.start, d.cur);
    else if (d.shape === "grect" || d.shape === "gtextbox") c.strokeRect(...box());
    else if (d.shape === "table") {   // the rectangle and the grid KiCad would size it into
      const [x, y, w, h] = box(); c.strokeRect(x, y, w, h);
      const n = tableCounts(d.start, d.cur, layer); c.setLineDash([2 * px, 2 * px]);
      for (let i = 1; i < n.cols; i++) line(c, [x + w * i / n.cols, y], [x + w * i / n.cols, y + h]);
      for (let i = 1; i < n.rows; i++) line(c, [x, y + h * i / n.rows], [x + w, y + h * i / n.rows]);
      c.setLineDash([]);
    } else if (d.shape === "garc") {
      const a = d.pts.length > 1 ? K.arcFrom3(d.pts[0], d.cur, d.pts[1]) : null;
      if (a) { c.beginPath(); c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); c.stroke(); } else line(c, d.start, d.pts.length > 1 ? d.pts[1] : d.cur);
      if (d.pts.length > 1) { c.setLineDash([2 * px, 2 * px]); line(c, d.pts[0], d.pts[1]); c.setLineDash([]); }
    } else if (d.shape === "gcurve") {
      const pts = d.pts.concat([d.cur]); polyline(c, K.bezierPts(pts), false);
      c.setLineDash([2 * px, 2 * px]); polyline(c, pts, false); c.setLineDash([]);   // the control polygon
    } else if (POLY_TOOLS.has(d.shape)) {
      polyline(c, d.pts.concat([d.cur]), false);
      if (d.pts.length > 1) { c.setLineDash([2 * px, 2 * px]); line(c, d.cur, d.pts[0]); c.setLineDash([]); }
    } else if (DIM_TYPE[d.shape]) drawDimPreview(c, d, px);
    else ring(c, d.start, Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]));
    if (d.pts) { c.fillStyle = HL; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h); }
  }
  // the picked reference image, centred on the cursor
  if (S.image && S.hover && S.modTool === "image") {
    const img = S.image; c.globalAlpha = 0.85; c.strokeStyle = color(S.gfxLayer); c.lineWidth = 1.5 * px; c.setLineDash([4 * px, 3 * px]);
    c.strokeRect(S.hover.x - img.w / 2, S.hover.y - img.h / 2, img.w, img.h); c.setLineDash([]);
    line(c, [S.hover.x - img.w / 2, S.hover.y - img.h / 2], [S.hover.x + img.w / 2, S.hover.y + img.h / 2]);
    line(c, [S.hover.x + img.w / 2, S.hover.y - img.h / 2], [S.hover.x - img.w / 2, S.hover.y + img.h / 2]);
  }
  // delete tool: what the click would remove
  if (S.modTool === "delete" && S.hover && S.hover.del) {
    const it = S.hover.del; c.globalAlpha = 0.9; c.strokeStyle = DEL;
    if (it.kind === "footprint" || it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") { const b = it.bbox; if (b) { c.lineWidth = 1.5 * px; c.setLineDash([4 * px, 3 * px]); c.strokeRect(b[0] - 0.2, b[1] - 0.2, b[2] - b[0] + 0.4, b[3] - b[1] + 0.4); c.setLineDash([]); } }
    else for (const g of it.geom) { if (it.kind === "zone" && g.fill) continue; c.lineWidth = (g.w || 0) + 3 * px; strokeGeom(c, g); }
  }
  // cursor: the via about to be placed, and the magnetic snap marker
  const hv = S.hover;
  if (hv && S.modTool) {
    if (S.modTool === "via" && !S.route) { const v = sizesOf(ctx).routeVia(netNameOf(ctx, hv.snap ? hv.snap.net : null)); c.globalAlpha = 0.6; c.strokeStyle = VIA; c.lineWidth = (v.diameter - v.drill) / 2; ring(c, [hv.x, hv.y], (v.diameter + v.drill) / 4); }
    if (hv.snap) { c.globalAlpha = 1; c.strokeStyle = HL; c.lineWidth = 1.5 * px; ring(c, [hv.x, hv.y], 5 * px); }
  }
  c.globalAlpha = 1;
}

// ---------------------------------------------------------------- module
const TOOLS = [
  { id: "route", label: "Route track", key: "X", cursor: "crosshair", icon: '<path d="M4 18h6l4-4h6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="14" r="1.5"/>' },
  { id: "via", label: "Add via", key: "V", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>' },
  { id: "drag", label: "Drag track segment", key: "D", cursor: "move", icon: '<path d="M5 7h14"/><path d="M5 17h14" stroke-dasharray="2 2"/><path d="M12 9v5M9 12l3 3 3-3"/>' },
  { id: "gline", label: "Draw line", key: "Shift+L", cursor: "crosshair", icon: '<path d="M5 19L19 5"/>' },
  { id: "grect", label: "Draw rectangle", key: "Shift+R", cursor: "crosshair", icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  { id: "gcircle", label: "Draw circle", key: "Shift+C", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: "gtext", label: "Add text", key: "T", cursor: "text", icon: '<path d="M6 6h12M12 6v13M9 19h6"/>' },
  { id: "garc", label: "Draw arc", key: "Ctrl+Shift+A", cursor: "crosshair", icon: '<path d="M4 18a8 8 0 0 1 16 0"/>' },
  { id: "gpoly", label: "Draw polygon", key: "Ctrl+Shift+P", cursor: "crosshair", icon: '<path d="M12 3l9 7-4 11H7L3 10z"/>' },
  // KiCad's hotkeys where they do not collide with the web's (Ctrl+Shift+Z is redo, so the zone takes the macOS Alt+Z)
  { id: "gcurve", label: "Draw Bezier curve", key: "Ctrl+Shift+B", cursor: "crosshair", icon: '<path d="M4 18C8 4 16 20 20 6"/><path d="M4 18l4-6M20 6l-4 8" stroke-dasharray="1.5 1.5"/>' },
  { id: "gtextbox", label: "Draw text box", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M7 9h10M7 12h7M7 15h5"/>' },
  { id: "table", label: "Draw table", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 10h18M3 14.5h18M9 5v14M15 5v14"/>' },
  { id: "image", label: "Place reference image", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14" rx="1"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-7 7"/>' },
  { id: "zone", label: "Draw filled zone", key: "Alt+Z", cursor: "crosshair", icon: '<path d="M4 5h16v14H4z"/><path d="M4 12l7-7M4 19l14-14M11 19l9-9M18 19l2-2"/>' },
  { id: "rulearea", label: "Draw rule area", key: "Ctrl+Shift+K", cursor: "crosshair", icon: '<path d="M4 5h16v14H4z" stroke-dasharray="3 2"/><path d="M8 8l8 8M16 8l-8 8"/>' },
  { id: "dimaligned", label: "Draw aligned dimension", key: "", cursor: "crosshair", icon: '<path d="M4 20L20 4"/><path d="M4 20l6-1-5-5zM20 4l-6 1 5 5z"/>' },
  { id: "dimortho", label: "Draw orthogonal dimension", key: "Ctrl+Shift+H", cursor: "crosshair", icon: '<path d="M4 18h16M4 13v8M20 13v8"/><path d="M4 18l4-2v4zM20 18l-4-2v4z"/>' },
  { id: "dimcenter", label: "Draw center dimension", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/><path d="M12 3v18M3 12h18"/>' },
  { id: "dimradial", label: "Draw radial dimension", key: "", cursor: "crosshair", icon: '<circle cx="9" cy="15" r="6"/><path d="M9 15l10-10h2"/><path d="M15 9l-1 3 3-1z"/>' },
  { id: "leader", label: "Draw leader", key: "", cursor: "crosshair", icon: '<path d="M4 18l8-8h8"/><path d="M4 18l4-1-3-3z"/>' },
  { id: "delete", label: "Delete", key: "", cursor: DELETE_CURSOR, icon: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>' },
  // KiCad's one-shot pickers (ACTIONS::gridSetOrigin, PCB_ACTIONS::drillOrigin)
  { id: "gridorigin", label: "Grid Origin", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><path d="M7 7l10 10M17 7L7 17"/>' },
  { id: "drillorigin", label: "Drill/Place File Origin", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><path d="M12 3v18M3 12h18"/>' },
];
const TOOL_HINT = { route: "Route — click to start (pads snap), / posture, V via, W width, PgUp/PgDn layer, Enter or double-click to end",
  via: "Via — click to place", drag: "Drag — move the mouse, click to fix", gline: "Line — click start and end; click the start point or press Enter to stop",
  grect: "Rectangle — click two corners", gcircle: "Circle — click the centre, then the radius", gtext: "Text — click where it goes",
  garc: "Arc — click the start, the end, then a point on the arc", gpoly: "Polygon — click the corners; click the first corner or press Enter to close",
  gcurve: "Bezier — click the start, the first control point, the second control point, then the end",
  gtextbox: "Text box — click two corners, then type the text", table: "Table — click two corners, then give rows x cols",
  image: "Image — choose a PNG or JPEG, then click where its centre goes",
  zone: "Zone — click the corners; click the first corner or press Enter to close, then pick the net",
  rulearea: "Rule area — click the corners on F.Cu and B.Cu; click the first corner or press Enter to close",
  dimaligned: "Aligned dimension — click the two points, then how far out the crossbar goes",
  dimortho: "Orthogonal dimension — click the two points, then where the crossbar goes (beside the points measures Y, above or below them X)",
  dimcenter: "Center dimension — click the centre, then the size of the cross",
  dimradial: "Radial dimension — click the centre, a point on the circle, then the leader's end",
  leader: "Leader — click the arrow point and the elbow, then type the text",
  delete: "Delete — click an item to remove it; Esc to leave the tool",
  gridorigin: "Grid origin — click where the grid starts", drillorigin: "Drill/place file origin — click the origin point for drill and placement files" };

/**
 * The in-flight route leg, in mm, as [x1, y1, x2, y2, widthMm] segments — what a peer should see
 * while a track is being drawn.  Committed legs are already real items and travel as ops.
 */
function ghostSegs() {
  const rt = S.route;

  if (!rt)
    return [];

  const pts = rt.head || [rt.last];
  return pts.slice(0, -1).map((a, i) => [a[0], a[1], pts[i + 1][0], pts[i + 1][1], rt.width]);
}

const pcb = {
  id: "pcb", tools: TOOLS, state: S, ghostSegs,
  /** Drag (D / G) of the selected footprints and vias with their tracks attached; false when nothing can be dragged. */
  dragSelection(ctx) { bind(ctx); if (ctx.viewOnly || !ctx.doc) return false; return beginCarryMove(ctx, { drag: true }); },
  /** Drag 45 Degree / Drag Free Angle from a menu: the router's drag of the selected tracks or via. */
  inlineDrag(ctx, free) { bind(ctx); if (ctx.viewOnly || !ctx.doc) return false; S.dragFree = !!free; ctx.setTool("drag"); return S.modTool === "drag"; },
  /** A press on a multi-item app selection (a box selection): a routable one arms the router's drag instead of a Move. */
  routableDown(ev, mm, ctx, ids) {
    bind(ctx); if (!ctx.doc || ctx.viewOnly || !ctx.live || !routableItems(ctx.doc, ids)) return false;
    S.pending = { ids: Array.from(ids), item: ctx.doc.items.get(ids[0]), mm: mm.slice(), client: [ev.clientX || 0, ev.clientY || 0], app: true }; return true;
  },
  /** What the canvas leaves out while it is drawn elsewhere (the lines being dragged). */
  hiddenIds() { return dragHiddenIds(); },
  onActivate(t, ctx) {
    bind(ctx);
    const mine = TOOLS.some((x) => x.id === t);
    if (S.route && t !== "route") { const rt = S.route; S.route = null; routeUnhighlight(ctx, rt); }   // leaving the tool drops the unfixed leg
    S.violations = null;
    if (S.drag && t !== "drag") { const D = S.drag; S.drag = null; routeUnhighlight(ctx, D.subs[0]); }
    S.draw = null; closeTextPrompt(); S.hover = null; if (t !== "image") S.image = null;
    S.modTool = mine ? t : null;
    if (t === "drag" && !beginToolDrag(ctx, !!S.dragFree)) { S.modTool = null; ctx.toast("Select a track or a via first, or point at one, then press D to drag it"); ctx.setTool("select"); return; }
    refreshChip(ctx); ctx.requestRender();
    if (t === "image" && !S.image && !ctx.viewOnly) openImagePicker();   // KiCad opens the file dialog as the tool starts
  },
  onPointerDown(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || ev.button !== 0 || !ctx.doc) return false;
    if (typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via" || t === "gridorigin" || t === "drillorigin"); S.hover = hv;
    if (t === "route") routeClick(ctx, hv, mm);
    else if (t === "gridorigin") { sizesOf(ctx).setGridOrigin([hv.x, hv.y]); ctx.toast(`Grid origin set to ${fmtSize(hv.x, true)}, ${fmtSize(hv.y)}`); ctx.setTool("select"); }
    else if (t === "drillorigin") { if (!ctx.viewOnly) { sizesOf(ctx).setAuxOrigin([hv.x, hv.y]); ctx.toast(`Drill/place file origin set to ${fmtSize(hv.x, true)}, ${fmtSize(hv.y)}`); } ctx.setTool("select"); }
    else if (t === "via") placeVia(ctx, hv);
    else if (t === "drag") { if (S.drag) { dragMove(ctx, mm); if (S.drag.moved) finishDrag(ctx, true, !!(ev.ctrlKey || ev.metaKey)); } else ctx.setTool("select"); }   // a click after motion fixes the drag
    else if (t === "gtext") { const at = [hv.x, hv.y]; askText(ctx, "Text", "", (v) => { if (v) placeText(ctx, at, v); }); }
    else if (t === "image") { if (S.image) placeImage(ctx, hv); else openImagePicker(); }
    else if (t === "delete") deleteAt(ctx, mm);   // an empty click is ours too: the tool stays armed
    else drawClick(ctx, hv, t);
    return true;
  },
  /** Select tool, nothing on a footprint's own geometry under the cursor: pick a track / via / graphic and arm its drag. */
  /**
   * A click on a pad selects the pad (PCB_SELECTION_TOOL treats PCB_PAD_T as a selectable item; the Selection Filter's
   * Pads box gates it).  Returns "box" for a press on a pad that was not selected (DRAG_SELECTED: a drag draws a box),
   * true when it already was, false when no pad is under the cursor or pads are filtered out.
   */
  selectPadAt(ev, mm, ctx) {
    bind(ctx); if (!ctx.doc || (ev.button !== undefined && ev.button !== 0)) return false;
    if ((ctx.selFilter || {}).pads === false) return false;
    let pad = null; try { pad = K.padAt ? K.padAt(ctx.doc, mm[0], mm[1]) : null; } catch (e) { pad = null; }
    if (!pad || !pad.item || pad.index === undefined) return false;
    const allowed = root.CollabEditor && root.CollabEditor.pickAllowed; if (allowed && !allowed(pad.item)) return false;
    const key = pad.item.id + "#" + pad.index, was = S.padSel === key;
    S.sel.clear(); S.padSel = key; S.downHandled = ev; ctx.requestRender();
    return was ? true : "box";
  },
  /** The selected pad as { item, index }, or null. */
  selectedPad(doc) { const k = S.padSel; if (!k || !doc) return null; const i = k.lastIndexOf("#"); const it = doc.items.get(k.slice(0, i)); return it ? { item: it, index: +k.slice(i + 1) } : null; },
  onSelectDown(ev, mm, ctx) {
    bind(ctx); if (!ctx.doc || (ev.button !== undefined && ev.button !== 0)) return false;
    const it = hitTestItem(ctx.doc, mm[0], mm[1], HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
    if (!it) return false;
    const allowed = root.CollabEditor && root.CollabEditor.pickAllowed; if (allowed && !allowed(it)) return false;   // the Selection Filter pane (kinds, locked items, hidden objects)
    const f = ctx.selFilter || {};
    if ((it.kind === "segment" || it.kind === "arc") && f.tracks === false) return false;
    if (it.kind === "via" && f.vias === false) return false;
    if (it.kind === "zone" && f.zones === false) return false;
    if ((it.kind === "gr_text" || it.kind === "gr_text_box") && f.text === false) return false;
    if (/^gr_/.test(it.kind) && it.kind !== "gr_text" && it.kind !== "gr_text_box" && f.graphics === false) return false;
    S.downHandled = ev;
    // MOUSE_DRAG_ACTION::DRAG_SELECTED (KiCad's default left drag): a drag that starts on the selection drags it; on
    // anything not selected it draws a selection box.  The press still picks the item, as the click would.
    const wasSelected = S.sel.has(it.id), mode = selMode(ev);   // Shift adds, Ctrl toggles, Ctrl+Shift removes
    S.padSel = null;
    if (mode) applySelMode(S.sel, it.id, mode);
    else if (!wasSelected) S.sel = new Set([it.id]);
    if (ctx.setSelection && !mode && !wasSelected) ctx.setSelection([]);   // the module owns this pick; app.js's selection empties
    S.pending = (!ctx.viewOnly && ctx.live && !mode && wasSelected) ? { ids: Array.from(S.sel), item: it, mm: mm.slice(), client: [ev.clientX || 0, ev.clientY || 0] } : null;
    ctx.requestRender(); return (wasSelected || mode) ? true : "box";
  },
  onPointerMove(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || !ctx.doc) return;
    if (ev && typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via" || t === "gridorigin" || t === "drillorigin"); S.hover = hv;
    if (t === "delete") hv.del = ctx.viewOnly ? null : itemAt(ctx, mm);
    if (S.violations && Math.hypot(hv.x - S.violations.at[0], hv.y - S.violations.at[1]) > 0.5) S.violations = null;
    if (S.route) { S.route.cursor = [hv.x, hv.y]; updateHead(ctx); }
    if (S.drag) dragMove(ctx, mm);
    if (S.draw) { S.draw.cur = [hv.x, hv.y]; if (DIM_TYPE[S.draw.shape] && S.draw.end) dimTrack(S.draw, S.draw.cur); }
    ctx.requestRender();
  },
  onPointerUp() {},
  onKey(k, ev, ctx) {
    bind(ctx); if (!ctx.doc) return false;
    const editing = () => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
    const shift = !!ev.shiftKey;
    switch (k) {
    case "x": case "X": if (!shift) { ctx.setTool("route"); return true; } return false;
    case "v": case "V": if (shift) return false; if (S.route) { if (editing()) routeVia(ctx); } else ctx.setTool("via"); return true;
    case "d": case "D": case "g": case "G":
      if (shift) return false;
      { const ids = selectionIds(ctx); const it = liveSelected();
        if (!S.sel.size && it && ids.size === 1 && ctx.doc.items.get(it.id)?.kind === "footprint") return editing() && beginCarryMove(ctx, { drag: true });
        // EDIT_TOOL::Drag: tracks and a via go to the router (D = 45°, G = free angle); nothing selected picks under the cursor
        if (ids.size && !routableItems(ctx.doc, ids)) return false;
        if (!ids.size && !dragCandidate(ctx, cursorPoint(ctx))) return false;
        if (editing()) { S.dragFree = k === "g" || k === "G"; ctx.setTool("drag"); } return true; }
    case "t": case "T": if (!shift) { ctx.setTool("gtext"); return true; } return false;
    case "L": if (shift) { ctx.setTool("gline"); return true; } return false;
    case "R": if (shift) { ctx.setTool("grect"); return true; }
      // fall through: plain R (caps lock) rotates like r
    case "r": return editing() && rotateSelected(ctx);   // false lets app.js's orientation-only fallback run when nothing applies
    case "Circle": ctx.setTool("gcircle"); return true;
    case "Arc": ctx.setTool("garc"); return true;
    case "Polygon": ctx.setTool("gpoly"); return true;
    case "Bezier": ctx.setTool("gcurve"); return true;
    case "Ortho": ctx.setTool("dimortho"); return true;
    case "Zone": ctx.setTool("zone"); return true;
    case "RuleArea": ctx.setTool("rulearea"); return true;
    case "Flip": return editing() && flipSelected(ctx);
    case "/": if (S.route && (ev.ctrlKey || ev.metaKey)) return true;   // Ctrl+/ cycles the corner mode; only mitred 45° is drawn here
      if (S.route) { const rt = S.route; tracerFlip(rt.tracer, rt.head && rt.head.length > 1 ? dir8(rt.head[0], rt.head[1]) : -1); updateHead(ctx); ctx.requestRender(); return true; } return false;   // ACT_SwitchPosture, until the next fix
    case "PageUp": return runAction("layerTop", ctx);
    case "PageDown": return runAction("layerBottom", ctx);
    case "+": return runAction("layerNext", ctx);
    case "-": return runAction("layerPrev", ctx);
    case "End": if (S.route) { if (editing()) endRoute(ctx, true); return true; } return false;
    case "u": case "U": return expandSelection(ctx) || (selectionIds(ctx).size ? runAction("selectConnection", ctx) : false);   // app.js's selection goes through the action
    case "w": case "W": if (editing()) cycleWidth(ctx, shift ? -1 : 1); return true;
    // the non-tool commands on KiCad's hotkeys (Ctrl / Alt chords arrive re-posted from the capture handler)
    case "Copy": return runAction("copy", ctx);
    case "Cut": return runAction("cut", ctx);
    case "Paste": return runAction("paste", ctx);
    case "PasteSpecial": return runAction("pasteSpecial", ctx);
    case "Duplicate": return runAction("duplicate", ctx);
    case "Swap": return runAction("swap", ctx);
    case "M": return shift ? runAction("moveExactly", ctx) : false;
    case "P": return shift ? runAction("positionRelative", ctx) : false;
    case "p": return runAction("pack", ctx);
    case "l": return runAction("toggleLock", ctx);
    case "o": return runAction("selectUnconnected", ctx);
    case "O": return shift ? runAction("grabUnconnected", ctx) : runAction("selectUnconnected", ctx);
    case "`": return runAction("highlightNet", ctx);
    case "~": return runAction("clearHighlight", ctx);
    case "'": return runAction("viaSizeInc", ctx);
    case "\\": return runAction("viaSizeDec", ctx);
    case "Enter":
      if (S.route) { if (editing()) endRoute(ctx, true); return true; }
      if (S.draw) { if (POLY_TOOLS.has(S.draw.shape)) { if (editing()) finishPoly(ctx); } else { S.draw = null; ctx.requestRender(); } return true; }
      if (S.drag) { if (editing()) finishDrag(ctx, true, false); return true; }
      return false;
    case "Backspace":
      if (S.route) { if (editing() && !undoRouteLeg(ctx)) ctx.toast("No routed segment to undo"); return true; }
      if (S.draw && (POLY_TOOLS.has(S.draw.shape) || S.draw.shape === "gcurve")) { if (S.draw.pts.length > 1) S.draw.pts.pop(); else S.draw = null; ctx.requestRender(); return true; }
      // fall through: with nothing being drawn Backspace deletes like Delete
    case "Delete":
      if (shift && selectionIds(ctx).size && connectedRun(ctx.doc, selectionIds(ctx)).size) return runAction("deleteFull", ctx);   // Shift+Delete: the whole connected run
      if (S.sel.size) { if (editing()) deleteSelection(ctx); return true; }
      if (ctx.selection && ctx.selection.size) { if (editing()) { const free = unlockedIds(ctx, Array.from(ctx.selection)); if (free.length) { ctx.commit(deleteChanges(ctx.doc, free), "delete"); applySelection(ctx, []); } } return true; }   // app.js's box selection of one item
      return false;
    default: return false;
    }
  },
  drawOverlay,
  // Called when a document loads and again after every applied change (our own commits included):
  // only a new document object resets the tool state; an update just prunes what vanished.
  onDocChanged(ctx) {
    bind(ctx); S.ratsDirty = true; S.docVer++;
    if (S.route && ctx.doc === S.doc) { routeHighlight(ctx, S.route); if (S.route.cursor) updateHead(ctx); }   // the routed net stays bright as legs are fixed (or a peer edits)
    if (ctx.doc !== S.doc) { S.doc = ctx.doc; cancelOps(); S.sel.clear(); S.padSel = null; S.hover = null; S.markers = []; S.hiddenNets.clear(); S.highlightNet = null; }
    else if (ctx.doc) {
      for (const id of Array.from(S.sel)) if (!ctx.doc.items.has(id)) S.sel.delete(id);
      if (S.drag && S.drag.subs.some((d) => Array.from(d.ids).some((id) => !ctx.doc.items.has(id)))) { const D = S.drag; S.drag = null; routeUnhighlight(ctx, D.subs[0]); }   // a peer removed what is being dragged
      if (S.move && [...S.move.orig.keys()].some((id) => !ctx.doc.items.has(id))) S.move = null;
      S.pending = null;
    }
    refreshChip(ctx);
  },
  // app.js deletes a multi-selection through this; the prompt and the image picker are swappable for tests
  deleteChanges,
  // the app's drag of a mixed selection, and Move: everything selected goes along (sticky = follows the cursor until a click)
  beginMove(ctx, at, sticky) { bind(ctx); return beginCarryMove(ctx, { at, sticky }); },
  unlockedIds(ctx, ids, quiet) { bind(ctx); return unlockedIds(ctx, ids, quiet); },
  setPrompt(fn) { promptImpl = fn; },
  setImagePicker(fn) { pickerImpl = fn; },
  cancel() { cancelOps(); },              // drop whatever is in flight and put a moved item back (a lost button release, Escape)
  // ---- the parity pass: commands, queries and dialogs app.js can call
  actions: ACTIONS,                       // { id: { label, key, run(ctx) -> handled } }, KiCad's ids and default hotkeys
  runAction,                              // runAction(id, ctx): run with error reporting
  // the toolbar's layer selector: a copper layer is the routing layer, any other the one the graphic tools draw on
  setLayer(ctx, layer) {
    bind(ctx); if (!layer) return; const R = sizesOf(ctx);
    if (/\.Cu$/.test(layer)) { if (layer !== (S.route ? S.route.layer : S.layer) || R.activeLayer !== layer) setLayer(ctx, layer); return; }
    if (R.activeLayer === layer && S.gfxLayer === layer) return;
    S.gfxLayer = layer; R.setActiveLayer(layer); refreshChip(ctx); ctx.requestRender();
  },
  sizes: () => K.pcbSizes.state,
  setRoutingDialogs(d) { routingDialogs = d || {}; },
  netlist, ratsnest, localRatsnest, netInspector, netItemIds, netHighlightIds, msgPanelInfo, boardLayerName, drc, designSettings, inspectClearance, boardStatistics,
  padAt, padProperties, groupOf, expandGroups, groupMembers: (doc, id) => { const it = doc.items.get(id); return it && it.kind === "group" ? groupMembers(it.node) : []; },
  clipboardText, pasteChanges, cursorPoint, selectionIds, selMode,
  get markers() { return S.markers; },
  runDRC(ctx) { return runAction("runDRC", ctx); },
  setDesignSettings(src) { S.settings = src ? designSettings(src) : null; S.settingsSrc = null; },
  setForm(fn) { formImpl = fn; },
};
root.CollabTools = root.CollabTools || {};
root.CollabTools.pcb = pcb;
root.PcbTools = { state: S, unfillChanges, alignBox, splitChanges, WIDTHS, BOARD_VERSION, routeLeg, segmentNode, viaNode, lineNode, rectNode, circleNode, arcNode, polyNode, textNode, netOf, netNode, netStyle,
  wrapBoard, addedChange, replacedChange, removedChange, padsOf, snapTarget, netUnder, hitTestItem, itemAt, deleteAt, connectedRun, rotateFootprintNode, flipFootprintNode,
  flipLayerName, pt, selectMoveTo, finishSelectMove, assembleLine, dragStart, startPendingDrag, finishDrag, dragMove, dragTo, dragSolution, dragChanges, dragSegment45, dragCorner45, dragCornerFree, initialTrace, routableItems, nextWidth, norm180, norm360, DELETE_CURSOR,
  // the interactive router (Walk around)
  routerWorld, routeObstacles, routeClearance, walkHead, walkTo, pathClear, pathHits, hullOf, legPts, simplifyPts, dir8, newTracer, trailAdd, tracerPosture, tracerFlip, saturated,
  // the new board tools
  layerClass, gfxWidth, textStyle, effectsNode, curveNode, textBoxNode, tableCounts, tableLayout, tableNode, imageNode, imageInfo, base64Bytes, imageMm,
  zoneNode, ruleAreaNode, zonePriority, boardNets, dimensionNode, dimGeometry, dimValueText, readableAngle, snap45, typeNameOf, deleteChanges,
  DIM_TYPE, DIM_CLASS, TEXTBOX_MARGIN, EXT_HEIGHT, ARROW_LEN, EXT_OFFSET, RULE_AREA_LAYERS,
  // the parity pass
  ACTIONS, runAction, mapNodePoints, translateNode, rotateNode, flipNode, mirrorNode, anchorOf, selectionCenter, transformChanges, moveChanges, rotateChanges, flipChanges, mirrorChanges,
  moveExactChanges, positionRelativeChanges, topLeftAnchor, alignChanges, distributeChanges, distributeDeltasGaps, distributeDeltasPoints, swapChanges, packChanges,
  selectionIds, applySelection, groupNode, groupOf, groupMembers, expandGroups, groupChanges, ungroupChanges, groupMembersChanges, isLocked, setLocked, lockChanges,
  shapeGap, coreDist, segsIntersect, polyPolyDist, padShape, padCopperLayers, viaLayers, arcPoints, arcLength, netTable, conductors, clusterRoots, netlist, ratsnest, localRatsnest, netInspector, netItemIds, netHighlightIds, msgPanelInfo, boardLayerName, itemDescription, dynamicRatsnest, selMode, connectedCopperIds,
  designSettings, netclassOf, netClearance, DEFAULT_SETTINGS, edgeShapes, chainLoops, boardOutline, courtyards, drc, trackEditChanges, trackLayerChanges, breakTrackChanges, cleanupPlan, cleanupChanges,
  layersBlock, referencePoint, clipboardText, parseClipboard, freshUuids, rewriteNets, annotate, pasteChanges, duplicateChanges, arrayChanges, cursorPoint,
  padAt, padProperties, convertChanges, selectionLoops, justifyChanges, zonePriorityChanges, footprintAttrChanges, boardStatistics, idsOnLayer, filterIds, SELECTION_TYPES, inspectClearance, VIA_SIZES, PCB_KINDS };
})(typeof window !== "undefined" ? window : globalThis);
