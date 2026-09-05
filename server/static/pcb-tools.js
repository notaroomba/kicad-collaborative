// pcb-tools.js — board editing tools for the web editor, mirroring pcbnew's
// interactions: route (X) with KiCad's 45° posture, via (V), active layer
// (PgUp/PgDn), rotate (R) / flip (F) of the selected footprint, selection and
// delete of tracks, vias and graphics, expand to the connected run (U), drag a
// segment (D), width cycling (W), graphic line/rect/circle/arc/polygon/bezier
// (Shift+L/R/C, Ctrl+Shift+A/P/B), text (T), text boxes, tables, reference
// images, copper zones (Alt+Z) and rule areas (Ctrl+Shift+K), the five
// dimension tools (orthogonal on Ctrl+Shift+H) and KiCad's interactive delete
// tool.
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
// KiCad's delete cursor: a small bin with a crosshair hotspot
const DELETE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 8h12M8 2v12M4 8h8M8 4v8" stroke="#fff" stroke-width="3"/><path d="M2 8h12M8 2v12" stroke="#000" stroke-width="1.2"/><path d="M14 10h8l-1 12h-6zM13 8h10M17 6h2v2h-2z" fill="#fff" stroke="#c00" stroke-width="1.2"/></svg>') + '") 8 8, crosshair';
const SNAP_MM = 0.5, HIT_MM = 0.2, DBL_MS = 400;
// The desktop applier only parses kicad_pcb documents (a bare item takes the
// legacy-format branches), so every fragment travels wrapped.  The version is
// the one boards from this build carry — it must never exceed the desktop's.
const BOARD_VERSION = 20260728;

const S = {
  layer: "F.Cu", gfxLayer: "F.SilkS", widths: {}, via: { size: 0.8, drill: 0.4 },
  sel: new Set(), route: null, drag: null, draw: null, hover: null, text: null, modTool: null, doc: null,
  image: null,                            // the picked reference image riding the cursor: { base64, info, w, h, name }
  client: null,                           // last pointer position in client px, where prompts open
};
let lastCtx = null, chip = null, chipSel = null, domReady = false;

// ---------------------------------------------------------------- small helpers
const isList = Array.isArray;
const r6 = (v) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };   // no -0 in files
const norm360 = (a) => ((a % 360) + 360) % 360;
const norm180 = (a) => { const v = norm360(a); return v > 180 ? v - 360 : v; };   // KiCad's footprint range
const clone = (n) => JSON.parse(JSON.stringify(n));
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
  let style = "code";
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kid(it.node, "pad") : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && K.kid(probe, "net"); if (!n) continue;
    style = typeof n[1] === "number" ? "code" : "name"; break;
  }
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
function textNode(text, x, y, layer) {
  const eff = ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]];
  if (/^B\./.test(layer)) eff.push(["justify", "mirror"]);   // back-side text reads mirrored, like KiCad's
  return ["gr_text", text, ["at", r6(x), r6(y), 0], ["layer", layer], eff];
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
  if (type === "aligned" || type === "orthogonal") style.push(["extension_height", EXT_HEIGHT]);
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
  : item.kind === "image" ? "PCB_REFERENCE_IMAGE" : item.kind === "table" ? "PCB_TABLE" : K.typeNameOf(item);
function upsertChange(item, kind, net) {
  const c = { id: item.id, kind, typeName: typeNameOf(item), sexpr: wrapBoard(item.node) };
  const n = net || netOf(item.node); if (n.name) c.netName = n.name;   // the desktop re-resolves nets by name
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
  for (const pad of K.kids(n, "pad")) {
    const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const sz = K.kid(pad, "size"); const ls = K.kid(pad, "layers");
    out.push({ x: fx + rx, y: fy + ry, rot: prot, w: sz ? K.num(sz[1]) : 1, h: sz ? K.num(sz[2], K.num(sz[1])) : 1,
      net: netOf(pad), layers: ls ? ls.slice(1).map(K.str) : [], number: K.str(pad[1]) });
  }
  return out;
}
const padOnLayer = (p, layer) => p.layers.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
function padCovers(p, x, y) { const [lx, ly] = rotator(-p.rot)(x - p.x, y - p.y); return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2; }

/** Magnetic target near (x, y): a pad (centre within tol, or the cursor over it), via or track end on the layer. */
function snapTarget(doc, x, y, tol, layer, net) {
  let best = null, bd = Infinity;
  const take = (px, py, n, kind, inside) => {
    const d = Math.hypot(px - x, py - y); if (!inside && d > tol) return;
    if (hasNet(net) && hasNet(n) && !sameNet(n, net)) return;   // never pull a routed net onto another net
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
function setAngle(c, a) { const at = K.kid(c, "at"); a = norm180(r6(a)); if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
function rotateFootprintNode(node, deg) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(a0 + deg); K.setAt(node, x, y, a1);
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
  const [x, y, a0] = K.atOf(node); const a1 = norm180(-a0); K.setAt(node, x, y, a1);
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

// ---------------------------------------------------------------- track drag (D)
function dragPlan(doc, seg) {
  const a0 = pt(seg.node, "start"), b0 = pt(seg.node, "end"); if (!a0 || !b0) return null;
  const L = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]); if (L < 1e-6) return null;
  const n = [-(b0[1] - a0[1]) / L + 0, (b0[0] - a0[0]) / L + 0]; const layer = layerOf(seg.node);   // + 0 clears a -0
  const viaAt = [false, false], nb = [];
  for (const it of doc.items.values()) if (it.kind === "via") { const p = pt(it.node, "at"); if (!p) continue; if (samePt(p, a0)) { viaAt[0] = true; nb.push({ item: it, key: "at", which: 0 }); } else if (samePt(p, b0)) { viaAt[1] = true; nb.push({ item: it, key: "at", which: 1 }); } }
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" || it.id === seg.id) continue;
    for (const key of ["start", "end"]) {
      const p = pt(it.node, key); if (!p) continue;
      const w = samePt(p, a0) ? 0 : samePt(p, b0) ? 1 : -1;
      if (w >= 0 && (layerOf(it.node) === layer || viaAt[w])) nb.push({ item: it, key, which: w });   // a via at the joint drags the other side's tracks too
    }
  }
  return { id: seg.id, item: seg, a0, b0, n, nb, off: 0, anchor: null };
}
/** New nodes for the dragged segment and its attached neighbours at a normal offset. */
function dragNodes(plan, off) {
  const a = [r6(plan.a0[0] + plan.n[0] * off), r6(plan.a0[1] + plan.n[1] * off)], b = [r6(plan.b0[0] + plan.n[0] * off), r6(plan.b0[1] + plan.n[1] * off)];
  const seg = clone(plan.item.node); K.kid(seg, "start").splice(1, 2, a[0], a[1]); K.kid(seg, "end").splice(1, 2, b[0], b[1]);
  const out = [{ item: plan.item, node: seg }];
  for (const nb of plan.nb) { const node = clone(nb.item.node); const p = nb.which === 0 ? a : b; K.kid(node, nb.key).splice(1, 2, p[0], p[1]); out.push({ item: nb.item, node }); }
  return out;
}

// ---------------------------------------------------------------- app.js state (read defensively)
// app.js keeps the editor state in script-scope lets (tool, kdoc, DOC_TYPE, zoom, selected, state) that
// the module hooks don't carry live; they are read under try/catch, falling back to the last ctx seen.
function appGlobal(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
/* global tool, kdoc, DOC_TYPE, zoom, selected, state */
const appTool = () => appGlobal(() => tool, S.modTool || "select");
const isPcbDoc = () => appGlobal(() => DOC_TYPE === "kicad_pcb" && !!kdoc && state.view === "editor", !!(lastCtx && !lastCtx.isSch && lastCtx.doc));
const liveDoc = () => appGlobal(() => kdoc, lastCtx && lastCtx.doc);
const liveZoom = () => appGlobal(() => zoom, lastCtx ? lastCtx.zoom : 1);
const liveSelected = () => appGlobal(() => selected, lastCtx && lastCtx.selected);

function bind(ctx) { lastCtx = ctx; if (ctx && ctx.K) K = ctx.K; if (ctx) ensureDom(ctx); }
const widthFor = (layer) => S.widths[layer] || 0.25;
function nextWidth(w) { const i = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6); return WIDTHS[(i + 1) % WIDTHS.length]; }
/** Layer names of the board.  kicad-canvas keys doc.layers by the layer *type* for (n "F.Cu" signal) entries, so fall back to what the items use. */
function layerNames(doc) {
  const names = new Set(doc ? Array.from(doc.layers.keys()).filter((l) => /\./.test(l)) : []);
  if (!names.size && doc) for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && /\./.test(g.layer)) names.add(g.layer);
  return names;
}
function gfxLayers(doc) {
  const names = Array.from(layerNames(doc)).filter((l) => !/\.Cu$/.test(l));
  const out = ["Edge.Cuts", "F.SilkS", "B.SilkS", "Dwgs.User", "Cmts.User", "F.Fab", "B.Fab"];   // every board has these
  for (const l of names) if (!out.includes(l)) out.push(l);
  return out;
}

// ---------------------------------------------------------------- interactions
function hoverPoint(ctx, mm, magnetic) {
  const g = ctx.snap(mm); const out = { x: g[0], y: g[1], snap: null };
  if (magnetic && ctx.doc) {
    const s = snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, S.route ? S.route.layer : S.layer, S.route ? S.route.net : null);
    if (s) { out.x = s.x; out.y = s.y; out.snap = s; }
  }
  return out;
}
function currentLeg(rt) { return routeLeg(rt.last, rt.target, rt.diagFirst); }
function fixLeg(ctx, target) {
  const rt = S.route; const segs = routeLeg(rt.last, target, rt.diagFirst); if (!segs.length) return false;
  const changes = segs.map(([a, b]) => addedChange(ctx.doc, segmentNode(ctx.doc, a, b, rt.width, rt.layer, rt.net), rt.net));
  S.widths[rt.layer] = rt.width;
  ctx.commit(changes, "route"); rt.last = target.slice(); rt.target = target.slice();
  return true;
}
function endRoute(ctx, fixCurrent) {
  const rt = S.route; if (!rt) return;
  if (fixCurrent && !samePt(rt.target, rt.last)) fixLeg(ctx, rt.target);
  S.route = null; refreshChip(ctx); ctx.requestRender();
}
function routeClick(ctx, hv) {
  const now = Date.now(); const p = [hv.x, hv.y];
  if (!S.route) {
    const net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, S.layer);
    S.route = { last: p, target: p.slice(), net, layer: S.layer, width: widthFor(S.layer), diagFirst: true, clickT: now, clickAt: p.slice() };
    ctx.toast(`Routing ${net.name ? net.name + " " : ""}on ${S.layer} · ${fmt(S.route.width)} mm — click corners, / posture, V via, Enter or double-click to end`, 3500);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const rt = S.route;
  const dbl = now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  fixLeg(ctx, p);
  if (hv.snap && hv.snap.kind === "pad") { S.route = null; ctx.toast("Route finished at pad"); refreshChip(ctx); }   // landing on a pad ends the trace, as in KiCad
  ctx.requestRender();
}
/** V while routing: fix the leg to the cursor, drop a via there and continue on the other side. */
function routeVia(ctx, toLayer) {
  const rt = S.route; const p = rt.target.slice(); const doc = ctx.doc;
  const changes = routeLeg(rt.last, p, rt.diagFirst).map(([a, b]) => addedChange(doc, segmentNode(doc, a, b, rt.width, rt.layer, rt.net), rt.net));
  changes.push(addedChange(doc, viaNode(doc, p[0], p[1], S.via.size, S.via.drill, rt.net), rt.net));
  S.widths[rt.layer] = rt.width;
  ctx.commit(changes, "route via");
  rt.last = p; rt.target = p.slice(); rt.layer = toLayer || otherSide(rt.layer); S.layer = rt.layer; rt.width = widthFor(rt.layer);
  ctx.toast(`Via placed — now routing on ${rt.layer}`); refreshChip(ctx); ctx.requestRender();
}
function placeVia(ctx, hv) {
  const net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, null);
  ctx.commit([addedChange(ctx.doc, viaNode(ctx.doc, hv.x, hv.y, S.via.size, S.via.drill, net), net)], "via");
}
function setLayer(ctx, layer) {
  if (S.route) { if (layer !== S.route.layer) routeVia(ctx, layer); return; }   // layer change mid-route goes through a via
  S.layer = layer; ctx.toast(`Active layer: ${layer}`); refreshChip(ctx); ctx.requestRender();
}
function rotateSelected(ctx) {
  const fp = ctx.selected && ctx.doc.items.get(ctx.selected.id); if (!fp || fp.kind !== "footprint") return false;
  ctx.commit([replacedChange(fp, rotateFootprintNode(clone(fp.node), 90))], "rotate"); return true;
}
function flipSelected(ctx) {
  const fp = ctx.selected && ctx.doc.items.get(ctx.selected.id); if (!fp || fp.kind !== "footprint") return false;
  const node = flipFootprintNode(clone(fp.node));
  ctx.commit([replacedChange(fp, node)], "flip"); ctx.toast(`${fp.ref || "Footprint"} flipped to ${layerOf(node)}`); return true;
}
function deleteSelection(ctx) {
  const changes = []; for (const id of S.sel) { const it = ctx.doc.items.get(id); if (it) changes.push(removedChange(it)); }
  S.sel.clear(); if (!changes.length) return;
  ctx.commit(changes, "delete"); ctx.toast(`Deleted ${changes.length} item${changes.length > 1 ? "s" : ""}`);
}
function cycleWidth(ctx) {
  if (S.route) { S.route.width = nextWidth(S.route.width); ctx.toast(`Track width ${fmt(S.route.width)} mm`); refreshChip(ctx); ctx.requestRender(); return; }
  const segs = Array.from(S.sel, (id) => ctx.doc.items.get(id)).filter((it) => it && (it.kind === "segment" || it.kind === "arc"));
  if (segs.length) {
    const w = nextWidth(widthOf(segs[0].node, 0.25));
    const changes = segs.map((it) => { const node = clone(it.node); const wn = K.kid(node, "width"); if (wn) wn[1] = w; else node.push(["width", w]); return replacedChange(it, node); });
    ctx.commit(changes, "track width"); S.widths[layerOf(segs[0].node)] = w; ctx.toast(`Track width ${fmt(w)} mm`); refreshChip(ctx); return;
  }
  S.widths[S.layer] = nextWidth(widthFor(S.layer)); ctx.toast(`Track width ${fmt(S.widths[S.layer])} mm on ${S.layer}`); refreshChip(ctx);
}
function expandSelection(ctx) {
  if (!S.sel.size) return false;
  const before = S.sel.size; S.sel = connectedRun(ctx.doc, S.sel);
  ctx.toast(S.sel.size > before ? `Selected the connected run (${S.sel.size} items)` : "Nothing else connected"); ctx.requestRender(); return true;
}
function beginDrag(ctx) {
  const seg = Array.from(S.sel, (id) => ctx.doc.items.get(id)).find((it) => it && it.kind === "segment"); if (!seg) return false;
  const plan = dragPlan(ctx.doc, seg); if (!plan) return false;
  S.drag = plan; S.sel = new Set([seg.id]); return true;
}
function dragMove(ctx, mm) {
  const d = S.drag; if (!d.anchor) { d.anchor = mm.slice(); return; }
  let off = (mm[0] - d.anchor[0]) * d.n[0] + (mm[1] - d.anchor[1]) * d.n[1];
  if (ctx.snapOn && ctx.gridPitch > 0) { const base = d.a0[0] * d.n[0] + d.a0[1] * d.n[1]; off = K.snap(base + off, ctx.gridPitch) - base; }   // keep the moved line on the grid
  d.off = off;
}
function finishDrag(ctx) {
  const d = S.drag; S.drag = null;
  if (d && Math.abs(d.off) > 1e-6) ctx.commit(dragNodes(d, d.off).map(({ item, node }) => replacedChange(item, node)), "drag track");
  ctx.setTool("select");
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
function cancelOps() { S.route = null; S.draw = null; S.drag = null; S.image = null; closeTextPrompt(); }

// ---------------------------------------------------------------- DOM: select-mode picking, stolen keys, layer chip, text prompt
function ensureDom(ctx) {
  if (domReady || typeof document === "undefined" || !ctx.stage) return; domReady = true;
  // The module's pointer hooks only run while one of its tools is active; picking tracks in the app's own
  // select tool listens on the stage after app.js has had its turn with the footprints.
  ctx.stage.addEventListener("pointerdown", onStagePointerDown);
  // Keys app.js consumes before the module (F = fit view, Shift+C = comment, Escape) are caught in the
  // capture phase and re-posted under names of our own so they still arrive through onKey with a fresh ctx.
  document.addEventListener("keydown", onCaptureKey, true);
  chip = document.createElement("div"); chip.id = "pcbChip";
  chip.style.cssText = "position:absolute;left:8px;top:8px;z-index:5;display:none;align-items:center;gap:8px;padding:3px 8px;border-radius:3px;background:rgba(0,16,35,.82);border:1px solid #24374E;color:#D0D2CD;font:11px var(--mono,ui-monospace,monospace);pointer-events:auto;user-select:none";
  chip.innerHTML = '<span data-k="layer" title="Active copper layer — click to swap (PgUp / PgDn)" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><i data-k="sw" style="width:10px;height:10px;border-radius:2px;display:inline-block"></i><b data-k="name"></b></span>'
    + '<span data-k="w" title="Track width (W cycles)"></span><span data-k="v" title="Via size / drill"></span>'
    + '<label data-k="gfx" style="display:none;align-items:center;gap:4px">on <select data-k="gsel" style="font:inherit;background:#0A1421;color:inherit;border:1px solid #24374E;border-radius:2px"></select></label>';
  chip.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  chip.querySelector('[data-k="layer"]').addEventListener("click", () => { if (lastCtx) setLayer(lastCtx, otherSide(S.layer)); });
  chipSel = chip.querySelector('[data-k="gsel"]');
  chipSel.addEventListener("change", () => { S.gfxLayer = chipSel.value; chipSel.blur(); if (lastCtx) lastCtx.toast("Drawing on " + S.gfxLayer); });   // blur hands the hotkeys back
  ctx.stage.appendChild(chip);
  // the layer list is rebuilt whenever a document opens: that is the cue to show or hide the chip
  const layersEl = document.getElementById("layers");
  if (layersEl && typeof MutationObserver !== "undefined") new MutationObserver(() => refreshChip(lastCtx)).observe(layersEl, { childList: true });
  refreshChip(ctx);
}
function refreshChip(ctx) {
  if (!chip) return;
  const show = isPcbDoc(); chip.style.display = show ? "flex" : "none"; if (!show) return;
  chip.querySelector('[data-k="sw"]').style.background = color(S.layer);
  chip.querySelector('[data-k="name"]').textContent = S.layer;
  chip.querySelector('[data-k="w"]').textContent = fmt(S.route ? S.route.width : widthFor(S.layer)) + " mm";
  chip.querySelector('[data-k="v"]').textContent = "via " + fmt(S.via.size) + "/" + fmt(S.via.drill);
  const drawing = gfxTool(S.modTool);
  chip.querySelector('[data-k="gfx"]').style.display = drawing ? "inline-flex" : "none";
  if (drawing) {
    const opts = gfxLayers(ctx && ctx.doc);
    if (Array.from(chipSel.options, (o) => o.value).join() !== opts.join()) chipSel.innerHTML = opts.map((l) => `<option value="${l}">${l}</option>`).join("");
    if (!opts.includes(S.gfxLayer)) S.gfxLayer = opts[0] || "F.SilkS";
    chipSel.value = S.gfxLayer;
  }
}
function onStagePointerDown(ev) {
  if (ev.button !== 0 || !isPcbDoc() || appTool() !== "select") return;
  if (ev.target.closest && (ev.target.closest("#cmtPanel") || ev.target.closest("#pcbChip") || ev.target.closest("#signinOverlay"))) return;
  const ctx = lastCtx, doc = liveDoc(); if (!ctx || !doc) return;
  const [x, y] = ctx.worldMm(ev);
  if (K.hitTest(doc, x, y, Math.min(5 / Math.max(1, liveZoom() * 0.6), 0.5))) { if (S.sel.size) { S.sel.clear(); ctx.requestRender(); } return; }   // app.js took the footprint
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  if (it) { if (ev.shiftKey) { if (S.sel.has(it.id)) S.sel.delete(it.id); else S.sel.add(it.id); } else S.sel = new Set([it.id]); }
  else if (!ev.shiftKey) S.sel.clear();
  ctx.requestRender();
}
// KiCad's Ctrl+Shift chords (app.js swallows every Ctrl combo) and Alt+Z, the macOS zone hotkey — Ctrl+Shift+Z is
// the web's redo — are re-posted under names of our own.
const CTRL_SHIFT_KEYS = { a: "Arc", p: "Polygon", b: "Bezier", h: "Ortho", k: "RuleArea" };
function repost(ev, key) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
function onCaptureKey(ev) {
  if (!isPcbDoc() || ev.metaKey) return;
  const tag = ev.target && ev.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const k = ev.key;
  if (ev.altKey) { if (!ev.ctrlKey && !ev.shiftKey && ev.code === "KeyZ") repost(ev, "Zone"); return; }
  if (ev.ctrlKey) {
    const ctrlRemap = ev.shiftKey && typeof k === "string" ? CTRL_SHIFT_KEYS[k.toLowerCase()] : null;
    if (ctrlRemap) repost(ev, ctrlRemap);
    return;
  }
  if (k === "Escape") {
    if (S.route || S.draw || S.drag || S.text || S.image) {   // first Escape only cancels the operation, KiCad style; the next one leaves the tool
      cancelOps(); ev.stopImmediatePropagation(); ev.preventDefault();
      if (lastCtx) { lastCtx.toast("Cancelled"); refreshChip(lastCtx); lastCtx.requestRender(); }
    } else if (S.sel.size) { S.sel.clear(); if (lastCtx) lastCtx.requestRender(); }
    return;
  }
  let remap = null;
  if ((k === "f" || k === "F") && !ev.shiftKey && liveSelected()) remap = "Flip";
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
function strokeGeom(c, g) {
  if (g.t === "line") { c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
  else if (g.t === "poly") { if (g.pts.length < 2) return; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); c.stroke(); }
  else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); c.stroke(); }
  else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.stroke(); }
  else if (g.t === "rect" || g.t === "image") c.strokeRect(g.x, g.y, g.w, g.h);
}
function line(c, a, b) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
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
  if (chip && chip.style.display === "none") refreshChip(ctx);   // the first document renders before the layer-list observer exists
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
  c.lineCap = "round"; c.lineJoin = "round";
  // selection highlight
  c.strokeStyle = HL; c.globalAlpha = 0.85;
  for (const id of S.sel) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") { const b = it.bbox; if (b) { c.lineWidth = 1.5 * px; c.strokeRect(b[0] - 0.2, b[1] - 0.2, b[2] - b[0] + 0.4, b[3] - b[1] + 0.4); } continue; }
    for (const g of it.geom) { if (it.kind === "zone" && g.fill) continue; c.lineWidth = (g.w || 0) + 3 * px; strokeGeom(c, g); }
  }
  // drag preview: the moved segment and its neighbours at their new places
  if (S.drag && S.drag.anchor) {
    c.globalAlpha = 0.9;
    for (const { item, node } of dragNodes(S.drag, S.drag.off)) {
      const lay = layerOf(node); c.strokeStyle = item.kind === "via" ? VIA : color(lay);
      if (item.kind === "via") { c.lineWidth = 2 * px; ring(c, pt(node, "at"), K.num((K.kid(node, "size") || [0, 0.8])[1]) / 2); }
      else { c.lineWidth = widthOf(node, 0.25); line(c, pt(node, "start"), pt(node, "end")); }
    }
  }
  // route in progress: fixed legs are already in the document, the current one lives here
  if (S.route) {
    const rt = S.route; c.globalAlpha = 0.75; c.strokeStyle = color(rt.layer); c.lineWidth = rt.width;
    for (const [a, b] of currentLeg(rt)) line(c, a, b);
    c.globalAlpha = 1; c.strokeStyle = "#FFFFFF"; c.lineWidth = 1.5 * px; ring(c, rt.last, 4 * px);
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
    if (S.modTool === "via" && !S.route) { c.globalAlpha = 0.6; c.strokeStyle = VIA; c.lineWidth = (S.via.size - S.via.drill) / 2; ring(c, [hv.x, hv.y], (S.via.size + S.via.drill) / 4); }
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
  delete: "Delete — click an item to remove it; Esc to leave the tool" };

const pcb = {
  id: "pcb", tools: TOOLS, state: S,
  onActivate(t, ctx) {
    bind(ctx);
    const mine = TOOLS.some((x) => x.id === t);
    if (S.route && t !== "route") S.route = null;   // leaving the tool drops the unfixed leg
    if (S.drag && t !== "drag") S.drag = null;
    S.draw = null; closeTextPrompt(); S.hover = null; if (t !== "image") S.image = null;
    S.modTool = mine ? t : null;
    if (t === "drag" && !beginDrag(ctx)) { S.modTool = null; ctx.toast("Click a track segment first, then press D to drag it"); ctx.setTool("select"); return; }
    if (mine) ctx.toast(gfxTool(t) ? `${TOOL_HINT[t]} — on ${S.gfxLayer}` : t === "zone" ? `${TOOL_HINT[t]} — on ${S.layer}` : TOOL_HINT[t], 3000);
    refreshChip(ctx); ctx.requestRender();
    if (t === "image" && !S.image && !ctx.viewOnly) openImagePicker();   // KiCad opens the file dialog as the tool starts
  },
  onPointerDown(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || ev.button !== 0 || !ctx.doc) return false;
    if (typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via"); S.hover = hv;
    if (t === "route") routeClick(ctx, hv);
    else if (t === "via") placeVia(ctx, hv);
    else if (t === "drag") finishDrag(ctx);
    else if (t === "gtext") { const at = [hv.x, hv.y]; askText(ctx, "Text", "", (v) => { if (v) placeText(ctx, at, v); }); }
    else if (t === "image") { if (S.image) placeImage(ctx, hv); else openImagePicker(); }
    else if (t === "delete") deleteAt(ctx, mm);   // an empty click is ours too: the tool stays armed
    else drawClick(ctx, hv, t);
    return true;
  },
  onPointerMove(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || !ctx.doc) return;
    if (ev && typeof ev.clientX === "number") S.client = [ev.clientX, ev.clientY];
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via"); S.hover = hv;
    if (t === "delete") hv.del = ctx.viewOnly ? null : itemAt(ctx, mm);
    if (S.route) S.route.target = [hv.x, hv.y];
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
    case "d": case "D": if (shift || !S.sel.size) return false; if (editing()) ctx.setTool("drag"); return true;
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
    case "/": if (S.route) { S.route.diagFirst = !S.route.diagFirst; ctx.requestRender(); return true; } return false;
    case "PageUp": setLayer(ctx, "F.Cu"); return true;
    case "PageDown": setLayer(ctx, "B.Cu"); return true;
    case "u": case "U": return expandSelection(ctx);
    case "w": case "W": if (editing()) cycleWidth(ctx); return true;
    case "Enter":
      if (S.route) { if (editing()) endRoute(ctx, true); return true; }
      if (S.draw) { if (POLY_TOOLS.has(S.draw.shape)) { if (editing()) finishPoly(ctx); } else { S.draw = null; ctx.requestRender(); } return true; }
      if (S.drag) { if (editing()) finishDrag(ctx); return true; }
      return false;
    case "Backspace":
      if (S.draw && (POLY_TOOLS.has(S.draw.shape) || S.draw.shape === "gcurve")) { if (S.draw.pts.length > 1) S.draw.pts.pop(); else S.draw = null; ctx.requestRender(); return true; }
      // fall through: with nothing being drawn Backspace deletes like Delete
    case "Delete": if (!S.sel.size) return false; if (editing()) deleteSelection(ctx); return true;
    default: return false;
    }
  },
  drawOverlay,
  // Called when a document loads and again after every applied change (our own commits included):
  // only a new document object resets the tool state; an update just prunes what vanished.
  onDocChanged(ctx) {
    bind(ctx);
    if (ctx.doc !== S.doc) { S.doc = ctx.doc; cancelOps(); S.sel.clear(); S.hover = null; }
    else if (ctx.doc) {
      for (const id of Array.from(S.sel)) if (!ctx.doc.items.has(id)) S.sel.delete(id);
      if (S.drag && !ctx.doc.items.has(S.drag.id)) S.drag = null;
    }
    refreshChip(ctx);
  },
  // app.js deletes a multi-selection through this; the prompt and the image picker are swappable for tests
  deleteChanges,
  setPrompt(fn) { promptImpl = fn; },
  setImagePicker(fn) { pickerImpl = fn; },
};
root.CollabTools = root.CollabTools || {};
root.CollabTools.pcb = pcb;
root.PcbTools = { state: S, WIDTHS, BOARD_VERSION, routeLeg, segmentNode, viaNode, lineNode, rectNode, circleNode, arcNode, polyNode, textNode, netOf, netNode, netStyle,
  wrapBoard, addedChange, replacedChange, removedChange, padsOf, snapTarget, netUnder, hitTestItem, itemAt, deleteAt, connectedRun, rotateFootprintNode, flipFootprintNode,
  flipLayerName, dragPlan, dragNodes, nextWidth, norm180, norm360, DELETE_CURSOR,
  // the new board tools
  layerClass, gfxWidth, textStyle, effectsNode, curveNode, textBoxNode, tableCounts, tableLayout, tableNode, imageNode, imageInfo, base64Bytes, imageMm,
  zoneNode, ruleAreaNode, zonePriority, boardNets, dimensionNode, dimGeometry, dimValueText, readableAngle, snap45, typeNameOf, deleteChanges,
  DIM_TYPE, DIM_CLASS, TEXTBOX_MARGIN, EXT_HEIGHT, ARROW_LEN, EXT_OFFSET, RULE_AREA_LAYERS };
})(typeof window !== "undefined" ? window : globalThis);
