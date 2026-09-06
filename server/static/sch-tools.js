// sch-tools.js — schematic editing tools for the web editor: wires and buses with
// KiCad's 90° routing and automatic junctions, bus entries, no-connects, labels,
// text, symbol and power-symbol placement, directive labels, graphic shapes
// (rectangle, circle, arc, lines, polygon, bezier, text box, table, rule area,
// image), hierarchical sheets (their file is created on the server first) and
// sheet pins, net highlighting, rotate / mirror / duplicate, the connected drag
// of one item or a multi-selection, KiCad's interactive delete tool and delete
// of the non-symbol items app.js does not select itself.
//
// Registers on window.CollabTools.sch; app.js drives the hooks documented at its
// "editing tools" seam.  Edits are whole-item changes built from a *cloned* node,
// so commit() can still serialise the untouched original as the undo step.  The
// DOM is only touched once a stage is handed over, so the logic runs under node.
(function (root) {
"use strict";
const K = root.KiCadCanvas;
if (!K) throw new Error("sch-tools.js needs kicad-canvas.js loaded first");
const { kid, kids, num, str, atOf, ptsOf, setPts, setAt, uuidOf } = K;

const CLR = { wire: "#009600", bus: "#0000C2", sel: "#FFB43A", hover: "#4D7FC4" };
const LINE_KINDS = new Set(["wire", "bus", "polyline"]);
const TEXT_KINDS = new Set(["label", "global_label", "hierarchical_label", "text"]);
const POINT_KINDS = new Set(["junction", "no_connect", "bus_entry"]);
const SHAPE_KINDS = new Set(["rectangle", "circle", "arc"]);          // sheet-level SCH_SHAPEs (polyline is a LINE_KIND)
const DRAW_TOOLS = new Set(["rect", "circle", "arc", "lines", "textbox", "sheet", "table", "bezier", "polygon", "rulearea"]);
// Kinds the canvas has no SCH_TYPE_NAMES entry for: the desktop's GetClass() names.
const TYPE_NAMES = { bezier: "SCH_SHAPE", image: "SCH_BITMAP", table: "SCH_TABLE", rule_area: "SCH_RULE_AREA" };
// KiCad's delete cursor: a small bin with a crosshair hotspot
const DELETE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 8h12M8 2v12M4 8h8M8 4v8" stroke="#fff" stroke-width="3"/><path d="M2 8h12M8 2v12" stroke="#000" stroke-width="1.2"/><path d="M14 10h8l-1 12h-6zM13 8h10M17 6h2v2h-2z" fill="#fff" stroke="#c00" stroke-width="1.2"/></svg>') + '") 8 8, crosshair';
const TOOLS = [
  { id: "wire", label: "Wire", key: "W", kind: "wire", cursor: "crosshair", icon: '<path d="M3 18h8v-9h10"/>' },
  { id: "bus", label: "Bus", key: "B", kind: "bus", cursor: "crosshair", icon: '<path d="M3 18h8v-9h10" stroke-width="3.2"/>' },
  { id: "busentry", label: "Bus entry", key: "Z", cursor: "crosshair", icon: '<path d="M4 20h7l9-9"/><path d="M4 4v16" stroke-width="3.2"/>' },
  { id: "junction", label: "Junction", key: "J", cursor: "crosshair", icon: '<path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3" fill="currentColor"/>' },
  { id: "noconnect", label: "No connect", key: "Q", cursor: "crosshair", icon: '<path d="M12 3v9M7 7l10 10M17 7L7 17"/>' },
  { id: "label", label: "Net label", key: "L", kind: "label", cursor: "crosshair", icon: '<path d="M6 17l5-11 5 11M8.5 13h5M4 21h16"/>' },
  { id: "glabel", label: "Global label", key: "Shift+L", kind: "global_label", cursor: "crosshair", icon: '<path d="M3 8h13l4 4-4 4H3z"/>' },
  { id: "hlabel", label: "Hierarchical label", key: "Shift+H", kind: "hierarchical_label", cursor: "crosshair", icon: '<path d="M3 8h13l4 4-4 4H3zM7 12h6"/>' },
  { id: "text", label: "Text", key: "T", kind: "text", cursor: "crosshair", icon: '<path d="M5 6h14M12 6v13M9 19h6"/>' },
  { id: "place", label: "Place symbol", key: "A", cursor: "crosshair", icon: '<rect x="7" y="5" width="10" height="14"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4"/>' },
  { id: "power", label: "Power symbol", key: "P", cursor: "crosshair", icon: '<path d="M12 21v-9M6 12h12M12 12l-5-7M12 12l5-7"/>' },
  { id: "classlabel", label: "Directive label", key: "", cursor: "crosshair", icon: '<path d="M4 20l8-8"/><circle cx="14" cy="10" r="2.5"/><path d="M15 4h6v3h-6z"/>' },
  { id: "lines", label: "Lines", key: "I", cursor: "crosshair", icon: '<path d="M3 20l6-10 5 6 7-12"/>' },
  { id: "rect", label: "Rectangle", key: "", cursor: "crosshair", icon: '<rect x="4" y="6" width="16" height="12"/>' },
  { id: "circle", label: "Circle", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: "arc", label: "Arc", key: "", cursor: "crosshair", icon: '<path d="M4 18a8 8 0 0 1 16 0"/>' },
  { id: "textbox", label: "Text box", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M8 9h8M12 9v7"/>' },
  { id: "delete", label: "Delete", key: "", cursor: DELETE_CURSOR, icon: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>' },
  // KiCad's drawSheet hotkey (S) is app.js's select key, so the sheet tool has none here
  { id: "sheet", label: "Hierarchical sheet", key: "", cursor: "crosshair", icon: '<rect x="4" y="6" width="16" height="13"/><path d="M4 6V3h6M4 9h3M17 15h3"/>' },
  { id: "sheetpin", label: "Sheet pin", key: "", cursor: "crosshair", icon: '<rect x="8" y="4" width="12" height="16"/><path d="M2 12h6M6 10l2 2-2 2"/>' },
  { id: "table", label: "Table", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 10h18M3 14h18M9 5v14M15 5v14"/>' },
  { id: "bezier", label: "Bezier curve", key: "", cursor: "crosshair", icon: '<path d="M3 19C3 8 21 16 21 5"/><path d="M3 19l4-8M21 5l-4 8" stroke-dasharray="1.5 1.5"/>' },
  { id: "polygon", label: "Polygon", key: "", cursor: "crosshair", icon: '<path d="M4 9l8-5 8 5-3 10H7z"/>' },
  { id: "rulearea", label: "Rule area", key: "", cursor: "crosshair", icon: '<path d="M4 5h16v14H4z" stroke-dasharray="2 2"/><path d="M8 9l8 6M16 9l-8 6"/>' },
  { id: "image", label: "Image", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 16l5-5 4 4 3-3 6 5"/><circle cx="16" cy="9" r="1.5"/>' },
  // ` is KiCad's net-highlight hotkey (highlightNetTool itself has no default)
  { id: "highlight", label: "Highlight net", key: "`", cursor: "crosshair", icon: '<path d="M3 12h6l3-6 3 12 3-6h3"/><circle cx="12" cy="12" r="9" stroke-dasharray="2 2"/>' },
];
const toolOf = (id) => TOOLS.find((t) => t.id === id) || null;

// Module state: one in-progress operation at a time, plus a selection of our own
// for the items app.js's select tool ignores (everything but symbols).
const S = { ctx: null, tool: "select", wire: null, carry: null, drag: null, pending: null, sel: null, hover: null,
  cursor: null, cursorClient: null, prompt: null, picker: null, dom: false, draw: null, highlight: null, sheetJob: null, imageWait: false };

// ---------------------------------------------------------------- small helpers
const deep = (n) => JSON.parse(JSON.stringify(n));
const r4 = (v) => +(+v).toFixed(4);
const same = (a, b, tol) => Math.abs(a[0] - b[0]) <= (tol || 1e-3) && Math.abs(a[1] - b[1]) <= (tol || 1e-3);
const area = (b) => b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function onSegMid(p, a, b) { return !same(p, a) && !same(p, b) && segDist(p, a, b) <= 1e-3; }
function segs(item) { const p = ptsOf(item.node), out = []; for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]); return out; }
function replaceKid(node, child) { const i = node.findIndex((c) => Array.isArray(c) && c[0] === child[0]); if (i >= 0) node[i] = child; else node.push(child); }
function dropKid(node, key) { const i = node.findIndex((c) => Array.isArray(c) && c[0] === key); if (i >= 0) node.splice(i, 1); }

// The desktop class name for a change (the canvas knows only the KiCad 9 kinds).
function typeNameFor(item) { return TYPE_NAMES[item.kind] || K.typeNameOf(item); }
// A rule area's uuid sits inside its polyline (formatPoly writes it there); the canvas keys the item by
// that uuid and pushes a direct (uuid) child the desktop parser would reject, so strip it before sending.
function ruleAreaId(node) { const pl = kid(node, "polyline"); return pl ? uuidOf(pl) : ""; }
function itemSexpr(doc, kind, node) {
  if (kind === "rule_area" && kid(node, "uuid")) { node = deep(node); dropKid(node, "uuid"); }
  let s = K.serializeItem(doc, { kind, node });
  // a sheet's page number is a string to KiCad (its parser wants a symbol): keep the quotes the canvas drops
  if (kind === "sheet") s = s.replace(/\(page (\d+)\)/g, '(page "$1")');
  return s;
}
// MODIFIED change from a cloned node: the doc item stays untouched until commit applies it,
// which is what lets app.js record the pre-edit item as the undo step.
function modChange(doc, item, node) { return { id: item.id, kind: "MODIFIED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, node) }; }
function removeChange(item) { return { id: item.id, kind: "REMOVED", typeName: typeNameFor(item), properties: [] }; }
function addNode(doc, node) {
  if (node[0] === "rule_area") {
    let pl = kid(node, "polyline"); if (!pl) { pl = ["polyline", ["pts"]]; node.splice(1, 0, pl); }
    if (!uuidOf(pl)) pl.push(["uuid", K.newUuid()]);
    const item = K.addItem(doc, node), id = ruleAreaId(node);
    doc.items.delete(item.id); item.id = id; doc.items.set(id, item);
    return { item, change: { id, kind: "ADDED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, node) } };
  }
  const item = K.createItem(doc, node);
  return { item, change: { id: item.id, kind: "ADDED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, item.node) } };
}
// Geometry for a node that is not (yet) part of the document: borrow the canvas builder.
function ghost(doc, node) { if (!uuidOf(node)) node.push(["uuid", K.newUuid()]); const it = K.addItem(doc, node); if (it) doc.items.delete(it.id); return it; }

// ---------------------------------------------------------------- node builders (KiCad 9 file shapes)
const fontNode = (size) => ["font", ["size", size, size]];
function lineNode(kind, a, b) { return [kind, ["pts", ["xy", r4(a[0]), r4(a[1])], ["xy", r4(b[0]), r4(b[1])]], ["stroke", ["width", 0], ["type", "default"]]]; }
function junctionNode(p) { return ["junction", ["at", r4(p[0]), r4(p[1])], ["diameter", 0], ["color", 0, 0, 0, 0]]; }
function noConnectNode(p) { return ["no_connect", ["at", r4(p[0]), r4(p[1])]]; }
function busEntryNode(p, dx, dy) { return ["bus_entry", ["at", r4(p[0]), r4(p[1])], ["size", dx, dy], ["stroke", ["width", 0], ["type", "default"]]]; }
function labelJustify(kind, rot) {
  const right = rot === 180 || rot === 270;
  return kind === "label" || kind === "text" ? ["justify", right ? "right" : "left", "bottom"] : ["justify", right ? "right" : "left"];
}
function labelNode(kind, text, p, rot) {
  rot = ((Math.round(rot || 0) % 360) + 360) % 360;
  const at = ["at", r4(p[0]), r4(p[1]), rot];
  if (kind === "label") return ["label", text, at, ["effects", fontNode(1.27), labelJustify(kind, rot)]];
  if (kind === "text") return ["text", text, ["exclude_from_sim", "no"], at, ["effects", fontNode(1.27), labelJustify(kind, rot)]];
  const n = [kind, text, ["shape", "input"], at];
  if (kind === "global_label") n.push(["fields_autoplaced", "yes"]);
  n.push(["effects", fontNode(1.27), labelJustify(kind, rot)], ["uuid", K.newUuid()]);
  // KiCad always stores the intersheet-refs field on global labels
  if (kind === "global_label") n.push(["property", "Intersheetrefs", "${INTERSHEET_REFS}", ["at", r4(p[0]), r4(p[1]), 0], ["hide", "yes"], ["effects", fontNode(1.27), ["justify", "left"]]]);
  return n;
}
// Sheet-level graphic shapes (sch_io_kicad_sexpr_common.cpp formatRect/Circle/Arc/Poly): stroke, fill, then the uuid.
const stroke0 = () => ["stroke", ["width", 0], ["type", "default"]];
const fillNone = () => ["fill", ["type", "none"]];
const xy = (p) => ["xy", r4(p[0]), r4(p[1])];
function corners(a, b) { return [r4(Math.min(a[0], b[0])), r4(Math.min(a[1], b[1])), r4(Math.max(a[0], b[0])), r4(Math.max(a[1], b[1]))]; }
function rectangleNode(a, b) { const [x0, y0, x1, y1] = corners(a, b); return ["rectangle", ["start", x0, y0], ["end", x1, y1], stroke0(), fillNone()]; }
function circleNode(c, r) { return ["circle", ["center", r4(c[0]), r4(c[1])], ["radius", r4(r)], stroke0(), fillNone()]; }
function arcNode(a, m, b) { return ["arc", ["start", r4(a[0]), r4(a[1])], ["mid", r4(m[0]), r4(m[1])], ["end", r4(b[0]), r4(b[1])], stroke0(), fillNone()]; }
function polylineNode(pts) { return ["polyline", ["pts", ...pts.map(xy)], stroke0(), fillNone()]; }
// SCH_TEXTBOX: (at) is the top-left corner, (size) the extent; margins default to stroke/2 + 0.75 × text size.
const TEXTBOX_MARGIN = r4(1.27 * 0.75);
function textBoxNode(text, a, b) {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["text_box", text, ["exclude_from_sim", "no"], ["at", x0, y0, 0], ["size", r4(x1 - x0), r4(y1 - y0)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN],
    stroke0(), fillNone(), ["effects", fontNode(1.27), ["justify", "left", "top"]]];
}
// Hierarchical sheet (sch_io_kicad_sexpr.cpp saveSheet): flags, 6 mil solid border, transparent fill, uuid,
// then the Sheetname / Sheetfile fields where SCH_SHEET::AutoplaceFields puts them for a horizontal sheet:
// margin = round(border/2) + 4 IU + text size × 0.5 (name, above) or × 0.4 (file, below).
const SHEET_BORDER = 0.1524, SHEET_NAME_OFF = r4(SHEET_BORDER / 2 + 0.000004 + 1.27 * 0.5), SHEET_FILE_OFF = r4(SHEET_BORDER / 2 + 0.000004 + 1.27 * 0.4);
function sheetNode(a, b, name, file) {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["sheet", ["at", x0, y0], ["size", r4(x1 - x0), r4(y1 - y0)], ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"], ["fields_autoplaced", "yes"],
    ["stroke", ["width", SHEET_BORDER], ["type", "solid"]], ["fill", ["color", 0, 0, 0, 0]], ["uuid", K.newUuid()],
    ["property", "Sheetname", name, ["at", x0, r4(y0 - SHEET_NAME_OFF), 0], ["effects", fontNode(1.27), ["justify", "left", "bottom"]]],
    ["property", "Sheetfile", file, ["at", x0, r4(y1 + SHEET_FILE_OFF), 0], ["effects", fontNode(1.27), ["justify", "left", "top"]]]];
}
// Sheet pin on one side of the sheet: SCH_SHEET_PIN::SetSide picks the spin style (left edge reads
// rightwards = justify left, right edge leftwards = justify right, top like right, bottom like left)
// and getSheetPinAngle the stored angle (right 0, top 90, left 180, bottom 270).
const PIN_SIDE = { right: [0, "right"], top: [90, "right"], left: [180, "left"], bottom: [270, "left"] };
function sheetPinNode(name, p, side) {
  const [rot, just] = PIN_SIDE[side] || PIN_SIDE.left;
  return ["pin", name, "input", ["at", r4(p[0]), r4(p[1]), rot], ["uuid", K.newUuid()], ["effects", fontNode(1.27), ["justify", just]]];
}
// Table (saveTable): border and separator strokes, column widths, row heights, uuid, then the cells as
// SCH_TABLECELLs (saveTextBox without a stroke).  Cells are the corner box split evenly, rounded to the
// grid with KiCad's 5 × 2 grid-step minimum (SCH_DRAWING_TOOLS::DrawTable).
function tableNode(a, b, rows, cols, grid) {
  const [x0, y0, x1, y1] = corners(a, b); grid = grid > 0 ? grid : 1.27; rows = Math.max(1, rows | 0); cols = Math.max(1, cols | 0);
  const cw = r4(Math.max(5 * grid, Math.round((x1 - x0) / cols / grid) * grid)), ch = r4(Math.max(2 * grid, Math.round((y1 - y0) / rows / grid) * grid));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push(["table_cell", "", ["exclude_from_sim", "no"], ["at", r4(x0 + c * cw), r4(y0 + r * ch), 0], ["size", cw, ch],
    ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN], ["span", 1, 1], fillNone(), ["effects", fontNode(1.27), ["justify", "left", "top"]], ["uuid", K.newUuid()]]);
  return ["table", ["column_count", cols], ["border", ["external", "yes"], ["header", "yes"], stroke0()], ["separators", ["rows", "yes"], ["cols", "yes"], stroke0()],
    ["column_widths", ...Array(cols).fill(cw)], ["row_heights", ...Array(rows).fill(ch)], ["uuid", K.newUuid()], ["cells", ...cells]];
}
// formatBezier: start, control 1, control 2, end.
function bezierNode(p0, c1, c2, p1) { return ["bezier", ["pts", xy(p0), xy(c1), xy(c2), xy(p1)], stroke0(), fillNone()]; }
// A polygon is an open SCH_SHAPE polyline closed by hand: the drawing tool ends on the first point,
// so the file repeats it (SCH_SHAPE::EndEdit keeps the outline open).
function polygonNode(pts) { return ["polyline", ["pts", ...pts.map(xy), xy(pts[0])], stroke0(), fillNone()]; }
// saveRuleArea: the exclude flags, then the closed polyline (dashed, no repeat) carrying the uuid.
function ruleAreaNode(pts) {
  return ["rule_area", ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"],
    ["polyline", ["pts", ...pts.map(xy)], ["stroke", ["width", 0], ["type", "dash"]], fillNone(), ["uuid", K.newUuid()]]];
}
// saveBitmap: (at) is the image centre; (scale) is only written when it is not 1; the PNG/JPEG bytes
// follow base64-encoded in 76-character lines (KICAD_FORMAT::FormatStreamData).
const IMAGE_LINE = 76, IMAGE_PPI = 300;                     // BITMAP_BASE's default resolution
function imageNode(p, base64) {
  const chunks = []; for (let i = 0; i < base64.length; i += IMAGE_LINE) chunks.push(base64.slice(i, i + IMAGE_LINE));
  return ["image", ["at", r4(p[0]), r4(p[1])], ["uuid", K.newUuid()], ["data", ...chunks]];
}
function imageData(node) { const d = kid(node, "data"); return d ? d.slice(1).map(str).join("") : ""; }
// Pixel size from a PNG IHDR or the first JPEG SOF marker; null for anything else.
function imageSize(b) {
  if (!b || b.length < 4) return null;
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b.length >= 24) return [u32(16), u32(20)];
  if (b[0] === 0xFF && b[1] === 0xD8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1]; if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  try { if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64")); const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  catch (e) { return null; }
}
// Directive label (netclass flag) with its Netclass field where SCH_DIRECTIVE_LABEL::AutoplaceFields puts it
// for the spin style of the angle: symbol size 20 mil + text offset (0.15 × size) beside the pin-length flag.
const FLAG_LENGTH = 2.54, FLAG_SYMBOL = 0.508, FLAG_MARGIN = r4(0.15 * 1.27);
function flagFieldAt(p, rot) {
  const off = rot === 180 ? [FLAG_SYMBOL + FLAG_MARGIN, FLAG_LENGTH] : rot === 90 ? [-FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)]
    : rot === 270 ? [FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)] : [FLAG_SYMBOL + FLAG_MARGIN, -FLAG_LENGTH];
  return ["at", r4(p[0] + off[0]), r4(p[1] + off[1]), rot === 90 || rot === 270 ? 90 : 0];
}
function classLabelNode(name, p, rot) {
  rot = ((Math.round(rot || 0) % 360) + 360) % 360;
  return ["netclass_flag", "", ["length", FLAG_LENGTH], ["shape", "round"], ["at", r4(p[0]), r4(p[1]), rot], ["fields_autoplaced", "yes"],
    ["effects", fontNode(1.27), ["justify", "left", "bottom"]], ["uuid", K.newUuid()],
    ["property", "Netclass", name, flagFieldAt(p, rot), ["effects", fontNode(1.27), ["justify", "left", "bottom"]]]];
}
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
function symbolNode(doc, libId, p, rot, mirror) {
  const lib = K.resolveLib(doc, libId);
  const T = tFrom(rot || 0, mirror || "");
  const tf = (lx, ly) => [r4(p[0] + T[0] * lx + T[1] * ly), r4(p[1] + T[2] * lx + T[3] * ly)];
  const n = ["symbol", ["lib_id", libId], ["at", r4(p[0]), r4(p[1]), rot || 0]];
  if (mirror) n.push(["mirror", mirror]);
  n.push(["unit", 1], ["body_style", 1], ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"], ["uuid", K.newUuid()]);
  const libProps = lib ? kids(lib, "property").filter((lp) => !str(lp[1]).startsWith("ki_")) : [];
  const fromLib = (name) => libProps.find((lp) => str(lp[1]) === name);
  const prop = (name, lp) => {
    let val = lp ? str(lp[2]) : (name === "Value" ? libId.split(":").pop() : name === "Datasheet" ? "~" : "");
    if (name === "Reference") val = (val || "U") + "?";                       // the desktop annotates
    else if (name === "Value" && !val) val = libId.split(":").pop();
    const [lx, ly, lr] = lp ? atOf(lp) : [0, 0, 0]; const [px, py] = tf(lx, ly);
    const out = ["property", name, val, ["at", px, py, lr || 0]];
    const h = lp && kid(lp, "hide");
    const hidden = lp ? (h ? str(h[1]) !== "no" : lp.includes("hide")) : name !== "Reference" && name !== "Value";
    if (hidden) out.push(["hide", "yes"]);
    const ef = lp && kid(lp, "effects"); out.push(ef ? deep(ef) : ["effects", fontNode(1.27)]);
    return out;
  };
  for (const name of MANDATORY) n.push(prop(name, fromLib(name)));
  for (const lp of libProps) if (!MANDATORY.includes(str(lp[1]))) n.push(prop(str(lp[1]), lp));
  if (lib) for (const sub of kids(lib, "symbol")) for (const pin of kids(sub, "pin")) { const nn = kid(pin, "number"); n.push(["pin", str(nn ? nn[1] : ""), ["uuid", K.newUuid()]]); }
  return n;
}

// ---------------------------------------------------------------- orientation (KiCad's transform algebra)
// T = [x1, y1, x2, y2] maps library coords (Y up) to screen offsets; mirrors pre-multiply like the parser does.
const ROT = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
const MX = [1, 0, 0, -1], MY = [-1, 0, 0, 1], RCCW = [0, 1, -1, 0], RCW = [0, -1, 1, 0];
const OP_M = { ccw: RCCW, cw: RCW, x: MX, y: MY };
const SCREEN_OP = { ccw: (dx, dy) => [dy, -dx], cw: (dx, dy) => [-dy, dx], x: (dx, dy) => [dx, -dy], y: (dx, dy) => [-dx, dy] };
function mul(A, B) { return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]].map((v) => v || 0); }   // no -0
function tFrom(rot, mirror) { let T = ROT[((Math.round(rot) % 360) + 360) % 360] || ROT[0]; if (mirror === "y") T = mul(MY, T); if (mirror === "x") T = mul(MX, T); return T; }
// KiCad's own search order when it writes a transform back out as (at … rot) + (mirror …)
const ORIENTS = [[0, ""], [90, ""], [180, ""], [270, ""], [0, "x"], [90, "x"], [270, "x"], [0, "y"], [90, "y"], [180, "y"], [270, "y"]];
function orientOf(T) { for (const [rot, m] of ORIENTS) { const U = tFrom(rot, m); if (U[0] === T[0] && U[1] === T[1] && U[2] === T[2] && U[3] === T[3]) return { rot, mirror: m }; } return { rot: 0, mirror: "" }; }
function symOrient(node) { const m = kid(node, "mirror"); return { rot: atOf(node)[2], mirror: m ? str(m[1]) : "" }; }
// Rotate / mirror a symbol node in place: compose the transform, rewrite (at … rot)/(mirror …)
// and carry the fields around the anchor with the same screen-space map.
function orientSymbol(node, op) {
  const { rot, mirror } = symOrient(node); const o = orientOf(mul(OP_M[op], tFrom(rot, mirror)));
  const [ax, ay] = atOf(node); setAt(node, undefined, undefined, o.rot);
  dropKid(node, "mirror");
  if (o.mirror) { const ai = node.findIndex((c) => Array.isArray(c) && c[0] === "at"); node.splice(ai + 1, 0, ["mirror", o.mirror]); }
  const f = SCREEN_OP[op];
  for (const p of kids(node, "property")) { const a = kid(p, "at"); if (!a) continue; const [dx, dy] = f(num(a[1]) - ax, num(a[2]) - ay); a[1] = r4(ax + dx); a[2] = r4(ay + dy); }
  return o;
}
function setTextRot(kind, node, rot) {
  rot = ((rot % 360) + 360) % 360;
  const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  let ef = kid(node, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; node.push(ef); }
  replaceKid(ef, labelJustify(kind, rot));
}
function rotateNode(kind, node, cw) {
  if (kind === "symbol") return orientSymbol(node, cw ? "cw" : "ccw");
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[cw ? "cw" : "ccw"](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) { setTextRot(kind, node, atOf(node)[2] + (cw ? 270 : 90)); return true; }
  return false;
}
function mirrorNode(kind, node, axis) {
  if (kind === "symbol") return orientSymbol(node, axis);
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[axis](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) {   // labels flip their reading direction instead
    const rot = atOf(node)[2]; const flip = axis === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 };
    if (flip[rot] === undefined) return false; setTextRot(kind, node, flip[rot]); return true;
  }
  return false;
}
const SHAPE_POINTS = { rectangle: ["start", "end"], circle: ["center"], arc: ["start", "mid", "end"] };
function anchorOf(kind, node) {
  if (LINE_KINDS.has(kind) || kind === "bezier") { const p = ptsOf(node); return p[0] || [0, 0]; }
  if (SHAPE_KINDS.has(kind)) { const k = kid(node, SHAPE_POINTS[kind][0]); return k ? [num(k[1]), num(k[2])] : [0, 0]; }
  if (kind === "rule_area") { const pl = kid(node, "polyline"); const p = pl ? ptsOf(pl) : []; return p[0] || [0, 0]; }
  if (kind === "table") { const cells = kid(node, "cells"); const c = cells && kid(cells, "table_cell"); if (c) { const [x, y] = atOf(c); return [x, y]; } return [0, 0]; }
  const [x, y] = atOf(node); return [x, y];
}
function shiftAt(n, dx, dy) { const a = kid(n, "at"); if (a) { a[1] = r4(num(a[1]) + dx); a[2] = r4(num(a[2]) + dy); } }
function shiftNode(kind, node, dx, dy) {
  if (!dx && !dy) return;
  if (LINE_KINDS.has(kind) || kind === "bezier") { setPts(node, ptsOf(node).map(([x, y]) => [x + dx, y + dy])); return; }
  if (SHAPE_KINDS.has(kind)) { for (const key of SHAPE_POINTS[kind]) { const k = kid(node, key); if (k) { k[1] = r4(num(k[1]) + dx); k[2] = r4(num(k[2]) + dy); } } return; }
  if (kind === "rule_area") { for (const pl of kids(node, "polyline")) setPts(pl, ptsOf(pl).map(([x, y]) => [x + dx, y + dy])); return; }
  if (kind === "table") { const cells = kid(node, "cells"); if (cells) for (const c of kids(cells, "table_cell")) shiftAt(c, dx, dy); return; }
  const [x, y] = atOf(node); setAt(node, r4(x + dx), r4(y + dy));
  for (const pr of kids(node, "property")) shiftAt(pr, dx, dy);
  if (kind === "sheet") for (const pin of kids(node, "pin")) shiftAt(pin, dx, dy);
}
// A copy with a fresh identity; the desktop re-annotates and rebuilds instance data.
function cloneNode(item) {
  const node = deep(item.node);
  if (item.kind === "rule_area") { dropKid(node, "uuid"); for (const pl of kids(node, "polyline")) replaceKid(pl, ["uuid", K.newUuid()]); return node; }
  replaceKid(node, ["uuid", K.newUuid()]);
  for (const pin of kids(node, "pin")) replaceKid(pin, ["uuid", K.newUuid()]);
  const cells = item.kind === "table" ? kid(node, "cells") : null; if (cells) for (const c of kids(cells, "table_cell")) replaceKid(c, ["uuid", K.newUuid()]);
  dropKid(node, "instances");
  return node;
}

// ---------------------------------------------------------------- connectivity
function pinsAt(doc, x, y, r) {
  const out = []; r = r || 0.02;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" || !it.bbox) continue; const b = it.bbox;
    if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
    for (const p of K.pinPoints(doc, it)) if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) out.push({ item: it, x: p.x, y: p.y });
  }
  return out;
}
function junctionAt(doc, x, y) { for (const it of doc.items.values()) if (it.kind === "junction" && same(atOf(it.node), [x, y])) return it; return null; }
function lineMidsAt(doc, x, y, kind) { const out = []; for (const it of doc.items.values()) { if (it.kind !== kind) continue; for (const [a, b] of segs(it)) if (onSegMid([x, y], a, b)) { out.push(it); break; } } return out; }
function lineEndsAt(doc, x, y, kind) { return K.wireEndsAt(doc, x, y, 1e-3).filter((e) => e.item.kind === kind); }
// KiCad's rule: a junction where a line ends on (or a pin sits on) the middle of another line,
// where three or more line ends meet, or where two non-collinear line ends share a pin.
function needsJunction(doc, x, y, kind) {
  const ends = lineEndsAt(doc, x, y, kind), mids = lineMidsAt(doc, x, y, kind).length;
  const pins = kind === "wire" ? pinsAt(doc, x, y).length : 0;
  if (mids > 0 && (ends.length > 0 || pins > 0)) return true;
  if (ends.length >= 3) return true;
  if (pins > 0 && ends.length >= 2) {
    const dirs = ends.map((e) => { const p = ptsOf(e.item.node); const q = p[e.index === 0 ? 1 : e.index - 1] || p[e.index]; return [q[0] - x, q[1] - y]; });
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) if (Math.abs(dirs[i][0] * dirs[j][1] - dirs[i][1] * dirs[j][0]) > 1e-6) return true;
  }
  return false;
}
function connectsAt(doc, p, kind) {
  if (kind === "wire" && pinsAt(doc, p[0], p[1]).length) return true;
  return lineEndsAt(doc, p[0], p[1], kind).length > 0 || lineMidsAt(doc, p[0], p[1], kind).length > 0;
}
// Junction changes for every point in pts that now needs one (items must already be in the doc).
function junctionChanges(doc, pts, kind) {
  const out = [];
  for (const p of pts) if (!junctionAt(doc, p[0], p[1]) && needsJunction(doc, p[0], p[1], kind)) out.push(addNode(doc, junctionNode(p)).change);
  return out;
}

// ---------------------------------------------------------------- net highlighting (connectivity on this sheet)
// Terminals of an item: { p, net: "wire" | "bus" | "any", key }.  Terminals join where they share a
// point (a wire never joins a bus directly, everything else is agnostic) or sit on the middle of a
// net line; `key` names a net that spans the sheet — net labels by text, global labels and power
// symbols by name, hierarchical labels by text.  Net lines, junctions and bus entries conduct
// between all their terminals; a symbol's or sheet's pins are separate nets.
const NET_PICK = new Set(["wire", "bus", "junction", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
function terminalsOf(doc, it) {
  const k = it.kind, n = it.node, at = () => atOf(n).slice(0, 2).map(r4);
  if (isNetLine(k)) return ptsOf(n).map((p) => ({ p: p.map(r4), net: k }));
  if (k === "junction" || k === "netclass_flag" || k === "directive_label") return [{ p: at(), net: "any" }];
  if (k === "bus_entry") return connPoints(doc, it).map((p) => ({ p, net: "any" }));
  if (k === "label") return [{ p: at(), net: "any", key: "local:" + str(n[1]) }];
  if (k === "global_label") return [{ p: at(), net: "any", key: "global:" + str(n[1]) }];
  if (k === "hierarchical_label") return [{ p: at(), net: "any", key: "hier:" + str(n[1]) }];
  if (k === "symbol") {
    const libId = str((kid(n, "lib_id") || [])[1]), value = kids(n, "property").find((p) => str(p[1]) === "Value");
    const key = isPowerSymbol(doc, libId) && value ? "global:" + str(value[2]) : undefined;
    return K.pinPoints(doc, it).map((q) => ({ p: [r4(q.x), r4(q.y)], net: "wire", key }));
  }
  if (k === "sheet") return kids(n, "pin").map((pin) => ({ p: atOf(pin).slice(0, 2).map(r4), net: "any" }));
  return [];
}
const conducts = (it) => isNetLine(it.kind) || it.kind === "junction" || it.kind === "bus_entry";
const joins = (a, b) => a.net === "any" || b.net === "any" || a.net === b.net;
/** Ids of everything on the net of `item` on this sheet; `near` picks the pin of a symbol or sheet. */
function netItems(doc, item, near) {
  const terms = new Map();
  for (const it of doc.items.values()) { const t = terminalsOf(doc, it); if (t.length) terms.set(it, t); }
  const mine = terms.get(item), set = new Set([item.id]); if (!mine) return set;
  const done = new Set(), keys = new Set(), keysDone = new Set(), work = [];
  const reach = (it, t) => {
    set.add(it.id);
    for (const u of conducts(it) ? terms.get(it) : [t]) { if (done.has(u)) continue; done.add(u); work.push(u); if (u.key) keys.add(u.key); }
    if (isNetLine(it.kind)) {                                 // things sitting on the middle of a reached line
      const sg = segs(it), lineT = { net: it.kind };
      for (const [o, ts] of terms) { if (o === it) continue; for (const u of ts) if (!done.has(u) && joins(lineT, u) && sg.some(([a, b]) => onSegMid(u.p, a, b))) reach(o, u); }
    }
  };
  if (item.kind === "symbol" || item.kind === "sheet") {
    let best = mine[0], bd = Infinity;
    if (near) for (const t of mine) { const dd = Math.hypot(t.p[0] - near[0], t.p[1] - near[1]); if (dd < bd) { bd = dd; best = t; } }
    reach(item, best);
  } else for (const t of mine) reach(item, t);
  for (;;) {
    while (work.length) {
      const t = work.pop();
      for (const [it, ts] of terms) {
        for (const u of ts) if (!done.has(u) && joins(t, u) && same(u.p, t.p)) reach(it, u);
        if (isNetLine(it.kind) && !set.has(it.id) && joins(t, { net: it.kind }) && segs(it).some(([a, b]) => onSegMid(t.p, a, b))) reach(it, ts[0]);
      }
    }
    const fresh = Array.from(keys).filter((k) => !keysDone.has(k)); if (!fresh.length) break;
    for (const key of fresh) { keysDone.add(key); for (const [o, ts] of terms) for (const u of ts) if (u.key === key && !done.has(u)) reach(o, u); }
  }
  return set;
}
// What the highlight tool picks under the cursor: a net item, a symbol pin, or a sheet pin.
function pickNet(ctx, mm) {
  const doc = ctx.doc, tol = Math.max(0.3, 5 * mmPerPx(ctx)), pinTol = Math.max(tol, 0.6);
  const hit = hitNonSymbol(doc, mm[0], mm[1], tol);
  if (hit && NET_PICK.has(hit.kind)) return { item: hit, at: mm };
  const pins = pinsAt(doc, mm[0], mm[1], pinTol); if (pins.length) return { item: pins[0].item, at: [pins[0].x, pins[0].y] };
  for (const it of doc.items.values()) if (it.kind === "sheet") for (const pin of kids(it.node, "pin")) { const [x, y] = atOf(pin); if (Math.hypot(x - mm[0], y - mm[1]) <= pinTol) return { item: it, at: [x, y] }; }
  return null;
}
function setHighlight(ctx, ids) {
  S.highlight = ids && ids.size ? ids : null;
  if (typeof ctx.setHighlight === "function") ctx.setHighlight(S.highlight);
  ctx.requestRender();
}
function highlightClick(ctx, mm) {
  const pick = pickNet(ctx, mm);
  if (!pick) { setHighlight(ctx, null); return null; }
  const ids = netItems(ctx.doc, pick.item, pick.at); setHighlight(ctx, ids); return ids;
}

// ---------------------------------------------------------------- cursor snapping
function mmPerPx(ctx) {
  if (ctx.worldMm && ctx.stage) { try { const a = ctx.worldMm({ clientX: 0, clientY: 0 }), b = ctx.worldMm({ clientX: 100, clientY: 0 }); const v = (b[0] - a[0]) / 100; if (v > 0 && isFinite(v)) return v; } catch (e) { /* no layout yet */ } }
  return ctx.pxPerMm ? 1 / ctx.pxPerMm : 0.25;
}
// Grid snap, but a pin or line end within reach wins (KiCad's connection snapping).
function snapConn(ctx, mm, kind) {
  const g = ctx.snap([mm[0], mm[1]]);
  const r = Math.max((ctx.gridPitch || 1.27) * 0.45, 6 * mmPerPx(ctx));
  let best = null, bd = r;
  const take = (x, y) => { const d = Math.hypot(x - mm[0], y - mm[1]); if (d < bd) { bd = d; best = [x, y]; } };
  if (kind !== "bus") for (const p of pinsAt(ctx.doc, mm[0], mm[1], r)) take(p.x, p.y);
  for (const it of ctx.doc.items.values()) { if (it.kind !== (kind || "wire")) continue; for (const p of ptsOf(it.node)) if (Math.abs(p[0] - mm[0]) <= r && Math.abs(p[1] - mm[1]) <= r) take(p[0], p[1]); }
  return best ? [r4(best[0]), r4(best[1])] : [r4(g[0]), r4(g[1])];
}

// ---------------------------------------------------------------- wires and buses
// One leg from the last fixed point to the cursor: straight when aligned, else two segments.
function legPoints(a, c, hFirst, flip) {
  if (same(a, c)) return [];
  const dx = c[0] - a[0], dy = c[1] - a[1];
  if (S.lineMode === "free" || Math.abs(dx) <= 1e-6 || Math.abs(dy) <= 1e-6) return [c];
  if (S.lineMode === "45") {                                // straight run then a 45° diagonal; '/' goes diagonal first
    const ax = Math.abs(dx), ay = Math.abs(dy), sx = Math.sign(dx), sy = Math.sign(dy);
    if (Math.abs(ax - ay) <= 1e-6) return [c];
    if (ax > ay) return flip ? [[r4(a[0] + sx * ay), c[1]], c] : [[r4(c[0] - sx * ay), a[1]], c];
    return flip ? [[c[0], r4(a[1] + sy * ax)], c] : [[a[0], r4(c[1] - sy * ax)], c];
  }
  return hFirst ? [[c[0], a[1]], c] : [[a[0], c[1]], c];
}
function posture(w) { const a = w.pts[w.pts.length - 1], c = w.cur; const auto = Math.abs(c[0] - a[0]) >= Math.abs(c[1] - a[1]); return w.flip ? !auto : auto; }
function simplify(pts) {
  const out = [];
  for (const p of pts) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  for (let i = 1; i < out.length - 1;) {   // merge collinear runs that keep going the same way
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-6 && dot > 0) out.splice(i, 1); else i++;
  }
  return out;
}
function startWire(ctx, kind, p) { S.wire = { kind, pts: [p], cur: p, flip: false, legs: [] }; ctx.requestRender(); }
function wireClick(ctx, p) {
  const w = S.wire, last = w.pts[w.pts.length - 1];
  if (same(last, p)) { finishWire(ctx); return; }          // click on the last point (or a double click) ends it
  w.cur = p; const leg = legPoints(last, p, posture(w), w.flip); w.pts.push(...leg); w.legs.push(leg.length);
  if (connectsAt(ctx.doc, p, w.kind)) finishWire(ctx);     // KiCad ends a wire on reaching a pin or another line
  else ctx.requestRender();
}
function undoLeg(ctx) {
  const w = S.wire; if (!w) return;
  if (!w.legs.length) { S.wire = null; ctx.requestRender(); return; }
  w.pts.length -= w.legs.pop(); ctx.requestRender();
}
function finishWire(ctx) {
  const w = S.wire; S.wire = null; if (!w) return;
  const pts = simplify(w.pts);
  if (pts.length < 2) { S.unfold = null; ctx.requestRender(); return; }
  const doc = ctx.doc, changes = []; let lastNode = null;
  for (let i = 1; i < pts.length; i++) { lastNode = lineNode(w.kind, pts[i - 1], pts[i]); changes.push(addNode(doc, lastNode).change); }
  changes.push(...junctionChanges(doc, w.pts, w.kind));
  ctx.commit(changes, w.kind);
  rememberPlaced(w.kind, lastNode);
  if (S.unfold) {                              // the unfolded member label rides to the end of the wire (KiCad moves it with the cursor)
    const u = S.unfold; S.unfold = null; const lb = doc.items.get(u.labelId), last = pts[pts.length - 1];
    if (lb && !same(atOf(lb.node), last)) { const n = deep(lb.node); setAt(n, last[0], last[1]); ctx.commit([modChange(doc, lb, n)], "unfold bus"); }
  }
  ctx.requestRender();
}

// ---------------------------------------------------------------- carried item (ghost that follows the cursor)
function startCarry(ctx, kind, node, mm) {
  S.carry = { kind, node, item: null, pos: null };
  placeCarry(ctx, mm || S.cursor || [ctx.doc.page[0] / 2, ctx.doc.page[1] / 2]);
}
function placeCarry(ctx, mm) {
  const c = S.carry; if (!c) return;
  const gridOnly = c.kind === "symbol" || TEXT_KINDS.has(c.kind) || SHAPE_KINDS.has(c.kind) || c.kind === "text_box" || c.kind === "netclass_flag"
    || c.kind === "image" || c.kind === "table" || c.kind === "bezier" || c.kind === "rule_area" || c.kind === "sheet";
  const p = gridOnly ? ctx.snap([mm[0], mm[1]]).map(r4) : snapConn(ctx, mm, c.kind === "bus" ? "bus" : "wire");
  if (c.pos && same(c.pos, p)) return;
  const a = anchorOf(c.kind, c.node); shiftNode(c.kind, c.node, r4(p[0] - a[0]), r4(p[1] - a[1]));
  c.pos = p; c.item = ghost(ctx.doc, c.node); ctx.requestRender();
}
function refreshCarry(ctx) { const c = S.carry; if (c) { c.item = ghost(ctx.doc, c.node); ctx.requestRender(); } }
function cancelCarry(ctx) { S.carry = null; ctx.requestRender(); }
function dropCarry(ctx) {
  const c = S.carry; if (!c) return null; S.carry = null;
  const doc = ctx.doc, p = anchorOf(c.kind, c.node);
  if (c.kind === "junction" && junctionAt(doc, p[0], p[1])) { ctx.toast("There is already a junction here"); ctx.requestRender(); return null; }
  const { item, change } = addNode(doc, c.node); const changes = [change];
  if (c.kind === "symbol") changes.push(...junctionChanges(doc, K.pinPoints(doc, item).map((q) => [q.x, q.y]), "wire"));
  else if (LINE_KINDS.has(c.kind) && c.kind !== "polyline") changes.push(...junctionChanges(doc, ptsOf(c.node), c.kind));
  ctx.commit(changes, c.kind === "symbol" ? "place " + (item.ref || "symbol") : c.kind.replace("_", " "));
  rememberPlaced(item.kind, item.node);
  if (c.kind === "symbol" || c.kind === "sheet") ctx.setSelected({ id: item.id }); else { S.sel = item.id; ctx.setSelected(null); }
  ctx.requestRender();
  return item;
}
// Create a label/text straight away at p (the inline prompt's Enter).
function placeText(ctx, kind, text, p, rot) {
  const doc = ctx.doc; const { item, change } = addNode(doc, labelNode(kind, text, p, rot || 0));
  ctx.commit([change], kind.replace("_", " "));
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null); ctx.requestRender();
  return item;
}

// ---------------------------------------------------------------- hit testing for non-symbol items
function fontSize(node) { const e = kid(node, "effects"), f = e && kid(e, "font"), s = f && kid(f, "size"); return s ? num(s[2], num(s[1], 1.27)) : 1.27; }
// Estimated footprint of a label/text on screen (the canvas only boxes the anchor).
function textRect(item) {
  const n = item.node, [x, y, rot] = atOf(n), size = fontSize(n), lines = str(n[1]).split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  let w = longest * size * 0.75 + size * 0.4; if (item.kind !== "label" && item.kind !== "text") w += size * 1.6;
  const v0 = -size * 1.4, v1 = (lines.length - 1) * size * 1.5 + size * 0.2;
  const th = (((Math.round(rot) % 360) + 360) % 360) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const map = (u, v) => [x + u * cs + v * sn, y - u * sn + v * cs];
  const c = [map(0, v0), map(w, v0), map(w, v1), map(0, v1)];
  return [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
}
function rectOf(item) { return TEXT_KINDS.has(item.kind) ? textRect(item) : item.bbox || (() => { const [x, y] = atOf(item.node); return [x - 0.6, y - 0.6, x + 0.6, y + 0.6]; })(); }
const boxDist = (b, x, y) => b ? Math.max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0) : Infinity;
function inSweep(t, g) { const n = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return g.anticlockwise ? n(g.a0 - t) <= n(g.a0 - g.a1) : n(t - g.a0) <= n(g.a1 - g.a0); }
/** Distance from (x, y) to a canvas geometry's stroke (shapes are picked by their outline, like KiCad). */
function geomDist(g, x, y) {
  if (g.t === "line") return segDist([x, y], [g.x1, g.y1], [g.x2, g.y2]);
  if (g.t === "poly") { const n = g.pts.length; if (n < 2) return Infinity; let d = Infinity; for (let i = 0; i < (g.close ? n : n - 1); i++) d = Math.min(d, segDist([x, y], g.pts[i], g.pts[(i + 1) % n])); return d; }
  if (g.t === "circle") return Math.abs(Math.hypot(x - g.x, y - g.y) - g.r);
  if (g.t === "arc") return inSweep(Math.atan2(y - g.y, x - g.x), g) ? Math.abs(Math.hypot(x - g.x, y - g.y) - g.r) : Infinity;
  if (g.t === "rect") return boxDist([g.x, g.y, g.x + g.w, g.y + g.h], x, y);
  return Infinity;
}
function hitNonSymbol(doc, x, y, tol) {
  let best = null, bd = Infinity;
  for (const it of doc.items.values()) {
    let d;
    if (LINE_KINDS.has(it.kind)) { d = Infinity; for (const [a, b] of segs(it)) d = Math.min(d, segDist([x, y], a, b)); d += 0.01; }   // small things on a line win ties
    else if (SHAPE_KINDS.has(it.kind) || it.kind === "bezier" || it.kind === "rule_area") { d = Infinity; for (const g of it.geom) if (!g.noStroke) d = Math.min(d, geomDist(g, x, y)); d += 0.01; }
    else if (it.kind === "text_box" || it.kind === "netclass_flag" || it.kind === "directive_label" || it.kind === "table" || it.kind === "image") d = boxDist(it.bbox, x, y);
    else if (it.kind === "bus_entry") { const [ax, ay] = atOf(it.node), s = kid(it.node, "size"); d = segDist([x, y], [ax, ay], [ax + (s ? num(s[1]) : 2.54), ay + (s ? num(s[2]) : 2.54)]); }
    else if (it.kind === "junction" || it.kind === "no_connect") { const [ax, ay] = atOf(it.node); d = Math.max(0, Math.hypot(ax - x, ay - y) - 0.6); }
    else if (TEXT_KINDS.has(it.kind)) { const b = textRect(it); d = Math.max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0); }
    else continue;
    if (d <= tol && d < bd) { bd = d; best = it; }
  }
  return best;
}
// Our pick for the select tool; null hands the click back to app.js (symbols, empty space).
function pickNonSymbol(ctx, mm) {
  const hit = hitNonSymbol(ctx.doc, mm[0], mm[1], Math.max(0.3, 5 * mmPerPx(ctx))); if (!hit) return null;
  const symId = K.hitTest(ctx.doc, mm[0], mm[1], 0.5);
  if (symId && !LINE_KINDS.has(hit.kind)) { const sym = ctx.doc.items.get(symId); if (sym && area(sym.bbox) < area(rectOf(hit))) return null; }
  return hit;
}
// Anything under the cursor: our own items first, then the symbols and sheets app.js selects (K.hitTest).
function pickAny(ctx, mm) {
  const hit = pickNonSymbol(ctx, mm); if (hit) return hit;
  const id = K.hitTest(ctx.doc, mm[0], mm[1], Math.max(0.3, 5 * mmPerPx(ctx)));
  return id ? ctx.doc.items.get(id) || null : null;
}

// ---------------------------------------------------------------- drag (KiCad's "drag": attached ends stretch)
// ---------------------------------------------------------------- connected drag (eeschema/tools/sch_move_tool.cpp)
// KiCad's DRAG keeps the moved item's connections: a wire end sitting on a moved
// connection point stretches (in 90° / 45° mode the wire stays on its own axis and
// grows a bend segment), a fixed pin, junction, label or sheet pin sitting on the
// point gets a brand-new wire, and no-connects ride along.  Afterwards junctions are
// added or dropped and collinear wires merged the way AddJunctionsIfNeeded and
// SCHEMATIC::CleanUp do on the desktop.  MOVE (M) is KiCad's plain move: the item
// goes, its connections stay where they were.
S.dragMode = "drag";                       // "drag" (G) | "move" (M)
S.lineMode = "90";                         // "90" | "45" | "free"  (eeschema's LINE_MODE)
const LINE_MODES = ["90", "45", "free"];
const LINE_MODE_LABEL = { "90": "90°", "45": "45°", free: "free" };
const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const RIDER_KINDS = new Set(["junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const DRAG_KINDS = new Set(["symbol", "sheet", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text",
  "text_box", "rectangle", "circle", "arc", "bezier", "rule_area", "table", "image"]);
const isNetLine = (k) => k === "wire" || k === "bus";

function modeText() { return `${S.dragMode === "drag" ? "drag keeps connections (G)" : "move leaves connections (M)"} · wires ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; }
function announceModes(ctx) {
  if (ctx && ctx.setStatus) ctx.setStatus(modeText());
  if (typeof document !== "undefined") { const b = document.querySelector("[data-act=linemode]"); if (b) { b.textContent = LINE_MODE_LABEL[S.lineMode]; b.title = `Wire angle mode: ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; } }
}
function setLineMode(ctx, mode) {
  if (!LINE_MODES.includes(mode)) return S.lineMode;
  S.lineMode = mode; announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  else if (S.wire) ctx.requestRender();
  return mode;
}
function cycleLineMode(ctx) { return setLineMode(ctx, LINE_MODES[(LINE_MODES.indexOf(S.lineMode) + 1) % LINE_MODES.length]); }
function setDragMode(ctx, mode) {
  S.dragMode = mode === "move" ? "move" : "drag"; announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  return S.dragMode;
}

// Connection points of an item (mm): symbol pins, sheet pins, bus-entry ends, net-line ends, anchors.
function connPoints(doc, item) {
  const k = item.kind, n = item.node;
  if (k === "symbol") return K.pinPoints(doc, item).map((p) => [r4(p.x), r4(p.y)]);
  if (k === "sheet") return kids(n, "pin").map((p) => atOf(p).slice(0, 2).map(r4));
  if (k === "bus_entry") { const [x, y] = atOf(n), s = kid(n, "size"); return [[r4(x), r4(y)], [r4(x + num(s && s[1], 2.54)), r4(y + num(s && s[2], 2.54))]]; }
  if (isNetLine(k)) { const p = ptsOf(n); return p.length > 1 ? [p[0].slice(), p[p.length - 1].slice()] : []; }
  if (POINT_KINDS.has(k) || LABEL_KINDS.has(k)) return [atOf(n).slice(0, 2).map(r4)];
  return [];
}
function labelsAt(doc, p, skip) { const out = []; for (const it of doc.items.values()) if (LABEL_KINDS.has(it.kind) && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
function sheetPinsAt(doc, p, skip) { const out = []; for (const it of doc.items.values()) if (it.kind === "sheet" && it !== skip) for (const pin of kids(it.node, "pin")) if (same(atOf(pin), p)) { out.push(it); break; } return out; }
function noConnectsAt(doc, p, skip) { const out = []; for (const it of doc.items.values()) if (it.kind === "no_connect" && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
function busEntriesAt(doc, p, skip) { const out = []; for (const it of doc.items.values()) if (it.kind === "bus_entry" && it !== skip && connPoints(doc, it).some((q) => same(q, p))) out.push(it); return out; }
// Which net lines a dragged item attaches to at a point (pins and sheet pins take wires only).
function lineKindsFor(item) { return item.kind === "bus" ? ["bus"] : item.kind === "symbol" || item.kind === "sheet" || item.kind === "wire" || item.kind === "no_connect" ? ["wire"] : ["wire", "bus"]; }

// One anchor per connection point: the line ends that stretch, the stub wire to create and the
// no-connects that follow.  `moving` holds the ids travelling with the drag; they never anchor.
function makeAnchor(doc, item, p, moving) {
  const a = { p: [r4(p[0]), r4(p[1])], ends: [], stub: null, followers: [] };
  const j = junctionAt(doc, p[0], p[1]);
  const fixedJunction = j && !moving.has(j.id) ? j : null;
  const ends = [];
  for (const kd of lineKindsFor(item)) for (const e of lineEndsAt(doc, p[0], p[1], kd)) if (!moving.has(e.item.id) && ptsOf(e.item.node).length > 1) ends.push(e);
  // An unselected junction on the point isolates the lines from the drag: the junction itself
  // gets the new stub wire and the lines stay put (getConnectedDragItems' ptHasUnselectedJunction).
  if (fixedJunction) a.stub = { from: a.p, kind: item.kind === "bus" || ends.some((e) => e.item.kind === "bus") ? "bus" : "wire" };
  else for (const e of ends) a.ends.push({ item: e.item, index: e.index, orig: ptsOf(e.item.node).map((q) => q.slice()) });
  if (!a.stub && item.kind !== "no_connect") {
    const fixed = pinsAt(doc, p[0], p[1]).some((q) => !moving.has(q.item.id))
      || labelsAt(doc, a.p, item).some((l) => !moving.has(l.id))
      || sheetPinsAt(doc, a.p, item).some((s) => !moving.has(s.id))
      || (item.kind !== "bus_entry" && busEntriesAt(doc, a.p, item).some((b) => !moving.has(b.id)));
    if (fixed) a.stub = { from: a.p, kind: item.kind === "bus" ? "bus" : "wire" };
    else if (LABEL_KINDS.has(item.kind)) {           // a label dragged off the middle of a line splits it (KiCad adds the junction)
      for (const kd of ["wire", "bus"]) { const mids = lineMidsAt(doc, p[0], p[1], kd).filter((m) => !moving.has(m.id) && ptsOf(m.node).length === 2); if (mids.length) { a.stub = { from: a.p, kind: kd, split: mids[0] }; break; } }
    }
  }
  if (item.kind !== "no_connect") for (const nc of noConnectsAt(doc, a.p, item)) if (!moving.has(nc.id)) a.followers.push({ item: nc, orig: atOf(nc.node).slice(0, 2) });
  return a;
}
// Items riding on a dragged net line: labels, junctions, entries and no-connects sitting on it.
// A junction at an end of the line is not a rider — it stays and gets a stub wire instead.
function ridersOf(doc, item) {
  const out = []; if (!isNetLine(item.kind)) return out;
  const pts = ptsOf(item.node); if (pts.length < 2) return out;
  const endsP = [pts[0], pts[pts.length - 1]], sg = segs(item);
  for (const it of doc.items.values()) {
    if (!RIDER_KINDS.has(it.kind) || it === item) continue;
    const cps = it.kind === "bus_entry" ? connPoints(doc, it) : [atOf(it.node).slice(0, 2)];
    if (!cps.some((c) => sg.some(([a, b]) => segDist(c, a, b) <= 1e-3))) continue;
    if (it.kind === "junction" && endsP.some((e) => same(e, atOf(it.node)))) continue;
    out.push({ item: it, orig: atOf(it.node).slice(0, 2) });
  }
  return out;
}

// End state of a stretched 2-point line: fixed end Q, moving end P -> Pn.  90°/45° keep an
// orthogonal line on its axis and add a bend; anything else (free mode, diagonal lines) stretches.
function bendPath(Q, P, Pn, lineMode) {
  if (same(P, Pn)) return [Q, P];
  if (lineMode === "free" || same(Q, P)) return [Q, Pn];
  const horiz = Math.abs(Q[1] - P[1]) <= 1e-3, vert = Math.abs(Q[0] - P[0]) <= 1e-3;
  if (!horiz && !vert) return [Q, Pn];
  let C = horiz ? [Pn[0], Q[1]] : [Q[0], Pn[1]];
  if (lineMode === "45") {                                 // the jog leaves the axis at 45°
    const ax = Math.abs(Pn[0] - Q[0]), ay = Math.abs(Pn[1] - Q[1]);
    const C45 = horiz ? [r4(Pn[0] - Math.sign(Pn[0] - Q[0]) * ay), Q[1]] : [Q[0], r4(Pn[1] - Math.sign(Pn[1] - Q[1]) * ax)];
    const run = horiz ? (C45[0] - Q[0]) * (Pn[0] - Q[0]) : (C45[1] - Q[1]) * (Pn[1] - Q[1]);
    if (run > 1e-6) C = C45; else if ((horiz ? ax : ay) <= 1e-6) return [Q, Pn];
  }
  C = [r4(C[0]), r4(C[1])];
  if (same(C, Q) || same(C, Pn)) return [Q, Pn];
  return [Q, C, Pn];
}
// New point list for a stretched end plus the extra bend segment (null when there is none).
function endGeometry(e, Pn, lineMode) {
  const pts = e.orig.map((q) => q.slice());
  if (pts.length !== 2) { pts[e.index] = Pn.slice(); return { pts, extra: null, zero: false }; }
  const P = pts[e.index], Q = pts[e.index === 0 ? 1 : 0];
  const path = bendPath(Q, P, Pn, lineMode);
  if (path.length === 3) return { pts: e.index === 0 ? [path[1], path[0]] : [path[0], path[1]], extra: [path[1], path[2]], zero: false };
  return { pts: e.index === 0 ? [path[1], path[0]] : [path[0], path[1]], extra: null, zero: same(path[0], path[1]) };
}
function restoreNode(node, orig) { node.length = 0; for (const c of deep(orig)) node.push(c); }
function lineCovers(doc, kind, a, b) {                   // an existing collinear line already spans a-b
  for (const it of doc.items.values()) { if (it.kind !== kind) continue; for (const [s, e] of segs(it)) if (segDist(a, s, e) <= 1e-3 && segDist(b, s, e) <= 1e-3) return true; }
  return false;
}

// One item or a list of them (a multi-selection): every connection point of every moved item is an
// anchor, riders of every moved net line come along, and a line whose ends all sit on moved items
// (a wire between two dragged symbols) is promoted into the moved set so it just moves.
function beginDrag(ctx, items, mm, byPointer) {
  const doc = ctx.doc, seen = new Set(), list = [];
  for (const it of Array.isArray(items) ? items : [items]) if (it && DRAG_KINDS.has(it.kind) && !seen.has(it.id)) { seen.add(it.id); list.push(it); }
  if (!list.length) return null;
  if (S.drag) endDrag(ctx, false);
  const item = list[0], anchor0 = anchorOf(item.kind, item.node);
  const d = { items: list.map((it) => ({ item: it, kind: it.kind, orig: deep(it.node) })), item, kind: item.kind, orig: null, anchor0, grab: [mm[0] - anchor0[0], mm[1] - anchor0[1]],
    last: [0, 0], applied: [0, 0], moved: false, byPointer: !!byPointer, riders: [], anchors: [], preview: [] };
  d.orig = d.items[0].orig;
  for (let pass = 0; pass < 8; pass++) {                   // re-resolve after each promotion, the moved set grew
    const moving = new Set(d.items.map((e) => e.item.id));
    d.riders = [];
    for (const e of d.items) for (const r of ridersOf(doc, e.item)) if (!moving.has(r.item.id)) { moving.add(r.item.id); d.riders.push(r); }
    d.anchors = [];
    for (const e of d.items) for (const p of connPoints(doc, e.item)) d.anchors.push(makeAnchor(doc, e.item, p, moving));
    for (const r of d.riders) {
      if (r.item.kind === "junction") d.anchors.push(makeAnchor(doc, r.item, r.orig, moving));
      else if (r.item.kind === "bus_entry") for (const p of connPoints(doc, r.item)) d.anchors.push(makeAnchor(doc, r.item, p, moving));
    }
    const seenEnd = new Set();                              // a line end belongs to one anchor only
    for (const a of d.anchors) a.ends = a.ends.filter((e) => { const k = e.item.id + ":" + e.index; if (seenEnd.has(k)) return false; seenEnd.add(k); return true; });
    const spanned = [], idx = new Map();
    for (const a of d.anchors) for (const e of a.ends) { if (!idx.has(e.item.id)) idx.set(e.item.id, new Set()); idx.get(e.item.id).add(e.index); }
    for (const [id, ends] of idx) { const it = doc.items.get(id); const n = it ? ptsOf(it.node).length : 0; if (it && n > 1 && ends.has(0) && ends.has(n - 1)) spanned.push(it); }
    if (!spanned.length) { for (const a of d.anchors) for (const f of a.followers) moving.add(f.item.id); break; }
    for (const it of spanned) d.items.push({ item: it, kind: it.kind, orig: deep(it.node) });
  }
  S.drag = d; announceModes(ctx); return d;
}
// Live preview: the moved items and stretched ends are edited in place (restored by endDrag),
// stub wires are drawn from d.preview by the overlay.
function applyDrag(doc, d, dx, dy) {
  for (const e of d.items) {
    if (!dx && !dy) restoreNode(e.item.node, e.orig);
    else shiftNode(e.kind, e.item.node, r4(dx - d.applied[0]), r4(dy - d.applied[1]));
    K.replaceChange(doc, e.item);
  }
  d.applied = [dx, dy];
  for (const r of d.riders) { const [cx, cy] = atOf(r.item.node); shiftNode(r.item.kind, r.item.node, r4(r.orig[0] + dx - cx), r4(r.orig[1] + dy - cy)); K.replaceChange(doc, r.item); }
  d.preview = [];
  const connected = S.dragMode === "drag";
  for (const a of d.anchors) {
    const Pn = [r4(a.p[0] + dx), r4(a.p[1] + dy)];
    for (const e of a.ends) {
      let pts = e.orig.map((q) => q.slice());
      if (connected) { const g = endGeometry(e, Pn, S.lineMode); pts = g.extra ? (e.index === 0 ? [g.extra[1], g.extra[0], g.pts[1]] : [g.pts[0], g.extra[0], g.extra[1]]) : g.pts; }
      setPts(e.item.node, pts); K.replaceChange(doc, e.item);
    }
    for (const f of a.followers) { const to = connected ? Pn : f.orig; const [cx, cy] = atOf(f.item.node); shiftNode("no_connect", f.item.node, r4(to[0] - cx), r4(to[1] - cy)); K.replaceChange(doc, f.item); }
    if (connected && a.stub && !same(a.p, Pn)) d.preview.push({ kind: a.stub.kind, pts: [a.p, Pn] });
  }
}
function moveDrag(ctx, mm) {
  const d = S.drag; if (!d) return;
  const t = ctx.snap([mm[0] - d.grab[0], mm[1] - d.grab[1]]);
  const dx = r4(t[0] - d.anchor0[0]), dy = r4(t[1] - d.anchor0[1]);
  if (dx === d.last[0] && dy === d.last[1]) return;
  d.last = [dx, dy]; d.moved = true;
  applyDrag(ctx.doc, d, dx, dy); ctx.requestRender();
}
function endDrag(ctx, commit) {
  const d = S.drag; S.drag = null; if (!d) return;
  const [dx, dy] = d.last, doc = ctx.doc;
  applyDrag(doc, d, 0, 0);                      // originals back first, so commit() records a true inverse
  if (!commit || !d.moved || (!dx && !dy)) { ctx.requestRender(); return; }
  const changes = dragChanges(ctx, d, dx, dy);
  if (changes.length) ctx.commit(changes, S.dragMode === "drag" ? "drag" : "move");
  ctx.requestRender();
}
function cancelDrag(ctx) { if (S.drag) endDrag(ctx, false); }

// The committed change set for a finished drag, built from cloned nodes.
function dragChanges(ctx, d, dx, dy) {
  const doc = ctx.doc, connected = S.dragMode === "drag", out = new Map();
  const put = (c) => {
    const prev = out.get(c.id);
    if (prev && prev.kind === "ADDED" && c.kind === "REMOVED") { out.delete(c.id); doc.items.delete(c.id); return; }
    if (prev && prev.kind === "ADDED" && c.kind === "MODIFIED") c = Object.assign({}, c, { kind: "ADDED" });
    out.set(c.id, c);
  };
  const touched = [];
  for (const e of d.items) { const n = deep(e.item.node); shiftNode(e.kind, n, dx, dy); put(modChange(doc, e.item, n)); }
  for (const r of d.riders) { const n = deep(r.item.node); shiftNode(r.item.kind, n, dx, dy); put(modChange(doc, r.item, n)); }
  for (const e of d.items) for (const p of connPoints(doc, e.item)) touched.push(p, [r4(p[0] + dx), r4(p[1] + dy)]);
  if (connected) for (const a of d.anchors) {
    const Pn = [r4(a.p[0] + dx), r4(a.p[1] + dy)]; touched.push(a.p, Pn);
    for (const e of a.ends) {
      const g = endGeometry(e, Pn, S.lineMode);
      if (g.zero) { put(K.removeChange(e.item)); continue; }
      const n = deep(e.item.node); setPts(n, g.pts); put(modChange(doc, e.item, n));
      if (g.extra) { put(addNode(doc, lineNode(e.item.kind, g.extra[0], g.extra[1])).change); touched.push(g.extra[0]); }
    }
    for (const f of a.followers) { const n = deep(f.item.node); setAt(n, Pn[0], Pn[1]); put(modChange(doc, f.item, n)); }
    if (a.stub && !same(a.p, Pn)) {
      if (a.stub.split) {                        // the line the label sat on becomes two lines meeting at the stub
        const m = a.stub.split, mp = ptsOf(m.node), n = deep(m.node);
        setPts(n, [mp[0], a.p]); put(modChange(doc, m, n));
        put(addNode(doc, lineNode(m.kind, a.p, mp[1])).change);
      }
      if (!lineCovers(doc, a.stub.kind, a.p, Pn)) put(addNode(doc, lineNode(a.stub.kind, a.p, Pn)).change);
    }
  }
  const keep = new Set([...d.items.map((e) => e.item.id), ...d.riders.map((r) => r.item.id)]);
  for (const c of cleanupAt(doc, Array.from(out.values()), touched, keep, ctx.IU || 1e4)) put(c);
  for (const c of out.values()) if (c.kind === "ADDED") doc.items.delete(c.id);   // commit re-adds them from the fragments
  return Array.from(out.values());
}
// SCHEMATIC::CleanUp + AddJunctionsIfNeeded around the touched points, evaluated on a dry run
// of the changes (applied, inspected, then swapped back so the document is untouched).
function cleanupAt(doc, changes, touched, keep, IU) {
  const saved = new Map(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  for (const c of changes) K.applyChange(doc, c, IU);
  const out = [], seen = new Set();
  try {
    for (const p of touched) {
      const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
      const j = junctionAt(doc, p[0], p[1]);
      const needed = needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      const dropJ = j && !needed && !keep.has(j.id);
      if (dropJ) out.push(K.removeChange(j));
      else if (!j && needed) out.push(addNode(doc, junctionNode(p)).change);
      if ((!j || dropJ) && !needed) for (const kd of ["wire", "bus"]) { const m = mergeAt(doc, p, kd); if (m) { out.push(...m); break; } }
    }
  } finally {
    for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); }
  }
  return out;
}
// Two same-kind lines meeting end to end at p with nothing else there: one straight line.
function mergeAt(doc, p, kind) {
  const ends = lineEndsAt(doc, p[0], p[1], kind); if (ends.length !== 2 || ends[0].item === ends[1].item) return null;
  if (pinsAt(doc, p[0], p[1]).length || labelsAt(doc, p).length || sheetPinsAt(doc, p).length || noConnectsAt(doc, p).length || busEntriesAt(doc, p).length) return null;
  if (lineMidsAt(doc, p[0], p[1], "wire").length || lineMidsAt(doc, p[0], p[1], "bus").length) return null;
  const [A, B] = ends, pa = ptsOf(A.item.node), pb = ptsOf(B.item.node); if (pa.length !== 2 || pb.length !== 2) return null;
  const fa = pa[A.index === 0 ? 1 : 0], fb = pb[B.index === 0 ? 1 : 0];
  const u = [fa[0] - p[0], fa[1] - p[1]], v = [fb[0] - p[0], fb[1] - p[1]];
  if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-6 || u[0] * v[0] + u[1] * v[1] >= 0) return null;   // must run straight through p
  const n = deep(A.item.node); setPts(n, A.index === 0 ? [fb, fa] : [fa, fb]);
  return [modChange(doc, A.item, n), K.removeChange(B.item)];
}

// ---------------------------------------------------------------- edits on the current selection
function selectedItem(ctx) { const id = ctx.selected ? ctx.selected.id : S.sel; return id ? ctx.doc.items.get(id) || null : null; }
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically, (mirror x)) | "y" (Mirror Horizontally, (mirror y)).
// One item turns about its own anchor (or, for items without an orientation of their own, about
// its half-grid box centre); a multi-selection turns as a whole about the selection centre.
function orientSelected(ctx, op) {
  const c = S.carry;
  if (c) { const ok = op === "x" || op === "y" ? mirrorNode(c.kind, c.node, op) : rotateNode(c.kind, c.node, op === "cw"); if (ok === false) transformNode(c.kind, c.node, op, anchorOf(c.kind, c.node)); refreshCarry(ctx); return true; }
  const items = selectedItems(ctx);
  if (items.length > 1) return transformSelected(ctx, op, items);
  const it = items[0]; if (!it) return false;
  if (ctx.viewOnly) return false;
  const node = deep(it.node);
  const ok = op === "x" || op === "y" ? mirrorNode(it.kind, node, op) : rotateNode(it.kind, node, op === "cw");
  if (ok === false) { if (!DRAG_KINDS.has(it.kind)) return false; return transformSelected(ctx, op, [it], rotationCentre([it])); }
  ctx.commit([modChange(ctx.doc, it, node)], op === "x" || op === "y" ? "mirror" : "rotate");
  return true;
}
// Removal of one item (or a list — a multi-selection) plus the junctions that only existed for them:
// a line's own points, or the connection points (pins, ends, anchors) of anything else —
// SCH_EDIT_TOOL::DoDelete's junction pass, evaluated with every listed item out of the document.
function deleteChanges(doc, items) {
  const list = [], ids = new Set();
  for (const it of Array.isArray(items) ? items : [items]) if (it && !ids.has(it.id)) { ids.add(it.id); list.push(it); }
  const changes = list.map(removeChange), pts = [];
  for (const it of list) { const line = LINE_KINDS.has(it.kind); for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) pts.push({ p, kind: line ? it.kind : null }); }
  if (!pts.length) return changes;
  const saved = list.map((it) => [it.id, doc.items.get(it.id)]);
  for (const it of list) doc.items.delete(it.id);
  try {
    for (const { p, kind } of pts) {
      const j = junctionAt(doc, p[0], p[1]); if (!j || ids.has(j.id) || changes.some((c) => c.id === j.id)) continue;
      const needed = kind ? needsJunction(doc, p[0], p[1], kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (!needed) changes.push(removeChange(j));
    }
  } finally { for (const [id, obj] of saved) if (obj) doc.items.set(id, obj); }
  return changes;
}
function deleteSelected(ctx) {
  const it = S.sel ? ctx.doc.items.get(S.sel) : null; if (!it) return false;
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  ctx.commit(changes, "delete");
  ctx.requestRender();
  return true;
}
// The delete tool's click: whatever is under the cursor goes (symbols and sheets included).
function deleteAt(ctx, mm) {
  const it = pickAny(ctx, mm); if (!it) return null;
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  if (ctx.selected && ctx.selected.id === it.id) ctx.setSelected(null);
  ctx.commit(changes, "delete");
  ctx.requestRender();
  return it;
}
function duplicateSelected(ctx) {
  const it = selectedItem(ctx); if (!it || it.kind === "sheet") return false;
  const node = cloneNode(it); shiftNode(it.kind, node, 2.54, 2.54);
  S.carry = { kind: it.kind, node, item: ghost(ctx.doc, node), pos: anchorOf(it.kind, node) };
  S.sel = null; ctx.setSelected(null);
  ctx.setTool("place");                         // onActivate sees the carry and skips the picker
  ctx.requestRender();
  return true;
}

// ---------------------------------------------------------------- DOM: inline prompt, symbol picker, capture hooks
const hasDom = () => typeof document !== "undefined" && S.ctx && S.ctx.stage;
function el(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; e.dataset.schtools = "1"; return e; }
const PANEL_CSS = "position:absolute;z-index:30;background:var(--panel,#fff);color:var(--ink,#1b1b1b);border:1px solid var(--line,#ccc);border-radius:4px;box-shadow:var(--shadow,0 6px 20px #0003);font:12px var(--font,system-ui,sans-serif);";
const INPUT_CSS = "background:var(--paper,#f5f4ef);color:inherit;border:1px solid var(--line,#ccc);border-radius:3px;padding:3px 6px;font:12px var(--mono,ui-monospace,monospace);outline:none;";
function placePanel(box, client) {
  const r = S.ctx.stage.getBoundingClientRect();
  const x = client ? client[0] - r.left + 10 : 12, y = client ? client[1] - r.top + 10 : 12;
  box.style.left = Math.max(4, Math.min(r.width - 280, x)) + "px"; box.style.top = Math.max(4, Math.min(r.height - 60, y)) + "px";
}
// Positioned <input> over the stage; Enter commits, Escape cancels.  Swappable for tests.
let promptImpl = function (title, initial, client, done) {
  if (!hasDom()) { done(null); return; }
  closePrompt();
  const box = el("div", PANEL_CSS + "display:flex;gap:6px;align-items:center;padding:5px 8px;");
  box.appendChild(el("span", "color:var(--ink-2,#666);white-space:nowrap", title));
  const inp = el("input", INPUT_CSS + "width:170px"); inp.value = initial || ""; inp.spellcheck = false; box.appendChild(inp);
  let closed = false;
  const finish = (v) => { if (closed) return; closed = true; closePrompt(); done(v); };
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(inp.value.trim() || null); else if (ev.key === "Escape") finish(null); });
  inp.addEventListener("blur", () => setTimeout(() => finish(null), 0));
  placePanel(box, client); S.ctx.stage.appendChild(box); S.prompt = box; inp.focus(); inp.select();
};
function closePrompt() { if (S.prompt) { S.prompt.remove(); S.prompt = null; } }
// A library symbol counts as a power symbol the way KiCad's chooser filters them: the (power) flag,
// the power: library, or a #PWR / #FLG reference.
function isPowerSymbol(doc, name) {
  const lib = K.resolveLib(doc, name) || doc.lib.get(name); if (!lib) return false;
  if (kid(lib, "power")) return true;
  if (/^power:/i.test(name)) return true;
  const ref = kids(lib, "property").find((p) => str(p[1]) === "Reference"); const v = ref ? str(ref[2]) : "";
  return v === "#PWR" || v === "#FLG";
}
function powerSymbols(doc) { return Array.from(doc.lib.keys()).filter((n) => isPowerSymbol(doc, n)).sort((a, b) => a.localeCompare(b)); }
// Chosen from the picker (or by a test): the symbol rides on the cursor until the click.
function pickSymbol(ctx, name) { closePicker(); startCarry(ctx, "symbol", symbolNode(ctx.doc, name, S.cursor || [0, 0], 0, ""), S.cursor); }
function openPicker(ctx, client, opts) {
  if (!hasDom()) return; closePicker();
  opts = opts || {};
  const names = opts.names || Array.from(ctx.doc.lib.keys()).sort((a, b) => a.localeCompare(b));
  const box = el("div", PANEL_CSS + "width:260px;padding:6px;display:flex;flex-direction:column;gap:6px;");
  const head = el("div", "display:flex;gap:6px;align-items:center"); head.appendChild(el("span", "color:var(--ink-2,#666);white-space:nowrap", opts.title || "Place symbol"));
  const inp = el("input", INPUT_CSS + "flex:1;min-width:0"); inp.placeholder = "filter…"; inp.spellcheck = false; head.appendChild(inp); box.appendChild(head);
  const list = el("div", "max-height:240px;overflow:auto;border-top:1px solid var(--line,#ccc)"); box.appendChild(list);
  const pick = (name) => pickSymbol(ctx, name);
  const fill = () => {
    const q = inp.value.trim().toLowerCase(); list.replaceChildren();
    const shown = names.filter((n) => !q || n.toLowerCase().includes(q));
    if (!shown.length) list.appendChild(el("div", "padding:6px 8px;color:var(--ink-2,#666)", names.length ? "No match" : opts.empty || "This sheet has no library symbols yet"));
    for (const n of shown.slice(0, 200)) {
      const row = el("div", "padding:3px 8px;cursor:pointer;font:12px var(--mono,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", n);
      row.title = n; row.addEventListener("mouseenter", () => row.style.background = "var(--paper,#f5f4ef)"); row.addEventListener("mouseleave", () => row.style.background = "");
      row.addEventListener("click", () => pick(n)); list.appendChild(row);
    }
    list.dataset.first = shown[0] || "";
  };
  inp.addEventListener("input", fill);
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && list.dataset.first) pick(list.dataset.first); else if (ev.key === "Escape") { closePicker(); } });
  fill(); placePanel(box, client); ctx.stage.appendChild(box); S.picker = box; inp.focus();
}
function closePicker() { if (S.picker) { S.picker.remove(); S.picker = null; } }
const NO_POWER = "This sheet's library has no power symbols yet — place one from the desktop first";
// The power tool's picker: only power symbols; with none in the sheet library the tool stays armed and says so.
function openPowerPicker(ctx, client) {
  const names = powerSymbols(ctx.doc);
  if (!names.length) { ctx.toast(NO_POWER, 3500); return false; }
  openPicker(ctx, client, { title: "Place power symbol", names, empty: NO_POWER });
  return true;
}
function schActive() { return typeof document === "undefined" || !!document.querySelector('#ltools [data-modtool="wire"]'); }
function curTool() { if (typeof document !== "undefined") { const b = document.querySelector("#ltools .tb.on"); if (b) return b.dataset.modtool || b.dataset.tool || S.tool; } return S.tool; }
// app.js owns the stage events; capture-phase listeners let this module see the clicks the
// select tool would otherwise drop (non-symbol items) and the keys app.js swallows (Escape, Shift+H).
function installDom(ctx) {
  if (S.dom || typeof document === "undefined" || !ctx.stage) return; S.dom = true;
  const stage = ctx.stage;
  stage.addEventListener("pointerdown", onDownCapture, true);
  stage.addEventListener("pointermove", onMoveCapture, true);
  stage.addEventListener("pointerup", onUpCapture, true);
  stage.addEventListener("dblclick", (ev) => { if (schActive() && toolOf(curTool())) { ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
  document.addEventListener("keydown", onKeyCapture, true);
}
function onDownCapture(ev) {
  const ctx = S.ctx; if (!ctx || !schActive()) return;
  if (ev.target && ev.target.closest && ev.target.closest("[data-schtools]")) { ev.stopImmediatePropagation(); return; }
  closePrompt(); closePicker();
  const tool = curTool();
  if (toolOf(tool)) return;                                  // app.js forwards these to onPointerDown
  if (tool !== "select" || ev.button !== 0) return;
  const mm = ctx.worldMm(ev);
  if (S.drag) { endDrag(ctx, true); ev.stopImmediatePropagation(); ev.preventDefault(); return; }   // a key-started drag is dropped by the click
  const hit = ctx.viewOnly ? null : pickNonSymbol(ctx, mm);
  if (!hit) { if (S.sel) { S.sel = null; ctx.requestRender(); } return; }
  ev.stopImmediatePropagation(); ev.preventDefault();
  S.sel = hit.id; S.hover = null; ctx.setSelected(null);
  S.pending = { item: hit, mm };
  try { ctx.stage.setPointerCapture(ev.pointerId); } catch (e) { /* not a real pointer */ }
  ctx.requestRender();
}
function onMoveCapture(ev) {
  const ctx = S.ctx; if (!ctx || !schActive()) return;
  const mm = ctx.worldMm(ev); S.cursor = mm; S.cursorClient = [ev.clientX, ev.clientY];
  if (S.drag) { moveDrag(ctx, mm); return; }
  if (S.pending) {
    if (Math.hypot(mm[0] - S.pending.mm[0], mm[1] - S.pending.mm[1]) > 0.4) { const p = S.pending; S.pending = null; if (beginDrag(ctx, p.item, p.mm, true)) moveDrag(ctx, mm); }
    return;
  }
  const tool = curTool();
  if (tool !== "select") { if (S.hover && tool !== "delete") { S.hover = null; ctx.requestRender(); } return; }   // the delete tool keeps its own hover
  const hit = ctx.viewOnly ? null : pickNonSymbol(ctx, mm), id = hit ? hit.id : null;
  if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
}
function onUpCapture() {
  const ctx = S.ctx; if (!ctx) return;
  S.pending = null;
  if (S.drag && S.drag.byPointer) endDrag(ctx, true);
}
function onKeyCapture(ev) {
  const ctx = S.ctx; if (!ctx || !schActive() || ev.metaKey || ev.ctrlKey) return;
  const tag = ev.target && ev.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (ev.key === "Escape") {
    let took = true;
    if (S.picker) closePicker(); else if (S.prompt) closePrompt(); else if (S.wire) finishWire(ctx); else if (S.draw) cancelDraw(ctx);
    else if (S.carry) cancelCarry(ctx); else if (S.drag) endDrag(ctx, false); else if (S.highlight) setHighlight(ctx, null); else took = false;
    if (S.sel || S.hover) { S.sel = null; S.hover = null; S.pending = null; ctx.requestRender(); }
    if (took) { ev.stopImmediatePropagation(); ev.preventDefault(); }   // first Escape ends the operation, the next one leaves the tool
  } else if (ev.key === "H" && ev.shiftKey && !ctx.viewOnly) {
    ev.stopImmediatePropagation(); ev.preventDefault(); ctx.setTool("hlabel");
    if (S.cursor) promptFor(ctx, "hierarchical_label", S.cursor, S.cursorClient);
  }
}
function promptFor(ctx, kind, mm, client) {
  const p = ctx.snap([mm[0], mm[1]]).map(r4);
  const title = kind === "text" ? "Text" : kind === "label" ? "Net label" : kind === "global_label" ? "Global label" : "Hierarchical label";
  promptImpl(title, "", client, (text) => { if (text) placeText(ctx, kind, text, p, 0); });
}
// Directive label: the netclass name comes from the inline prompt, the flag lands on the grid point clicked.
function promptClassLabel(ctx, mm, client) {
  const p = ctx.snap([mm[0], mm[1]]).map(r4);
  promptImpl("Netclass", "", client, (name) => { if (name) placeClassLabel(ctx, name, p, 0); });
}
function placeClassLabel(ctx, name, p, rot) {
  const doc = ctx.doc; const { item, change } = addNode(doc, classLabelNode(name, p, rot || 0));
  ctx.commit([change], "directive label");
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null); ctx.requestRender();
  return item;
}

// ---------------------------------------------------------------- hierarchical sheets (the sheet file lives on the server first)
const SHEET_EXT = ".kicad_sch";
const baseName = (p) => str(p).split("/").pop();
const dirName = (p) => { const s = str(p).split("/"); s.pop(); return s.join("/"); };
const joinPath = (dir, file) => dir ? dir + "/" + file : file;
// Relative path from directory `dir` to `path` (both project-relative, "/" separated) — what Sheetfile holds.
function relPath(dir, path) {
  const a = dir ? dir.split("/") : [], b = path.split("/"); let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
function schDocs(ctx) { return (ctx.docs || []).filter((d) => d && d.docType === "kicad_sch"); }
// The schematic doc being edited: ctx.docId when the app says, else the project's root sheet.
function currentDoc(ctx) {
  const docs = schDocs(ctx);
  if (ctx.docId) { const d = docs.find((x) => x.docId === ctx.docId); if (d) return d; }
  if (ctx.docPath) return { path: ctx.docPath };
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro"), stem = pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : null;
  return (stem && docs.find((d) => baseName(d.path) === stem + SHEET_EXT)) || docs.slice().sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.length - y.path.length)[0] || null;
}
function normSheetFile(file) { file = str(file).trim().replace(/\\/g, "/").replace(/^\/+/, ""); if (!file) return ""; if (!/\.kicad_sch$/i.test(file)) file += SHEET_EXT; return file; }
function sheetFileFor(name) { return normSheetFile(str(name).trim().replace(/[\\/:*?"<>|]+/g, "_")); }
function emptySheetDoc() { return `(kicad_sch (version 20250114) (generator "kicad-collab-web") (generator_version "9.0") (uuid "${K.newUuid()}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))\n`; }
// Reference the project doc for a sheet file, creating it (POST …/docs, then snapshot 0) when there is none.
async function ensureSheetDoc(ctx, file) {
  file = normSheetFile(file); if (!file) throw new Error("no sheet file name");
  const cur = currentDoc(ctx), dir = cur ? dirName(cur.path) : "", target = joinPath(dir, file);
  const found = schDocs(ctx).find((d) => d.path === target || d.path === file) || schDocs(ctx).find((d) => baseName(d.path) === baseName(file));
  if (found) return { file: relPath(dir, found.path), docId: found.docId, created: false };
  if (typeof ctx.api !== "function" || !ctx.project || !ctx.project.projectId) throw new Error("this session cannot create sheet files");
  const res = await ctx.api(`/api/projects/${ctx.project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: target, docType: "kicad_sch" }) });
  if (!res || !res.docId) throw new Error("no document id returned");
  if (!res.existing) await ctx.api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" }, body: emptySheetDoc() });
  const entry = { docId: res.docId, path: res.path || target, docType: "kicad_sch" };
  if (Array.isArray(ctx.docs) && !ctx.docs.some((d) => d && d.docId === entry.docId)) ctx.docs.push(entry);
  return { file, docId: entry.docId, created: !res.existing };
}
// The sheet path and project name this screen's symbols and sheets record in their instance data:
// a sheet's instance path is the path of the sheet *containing* it, the same path its symbols use.
function sheetPathHere(doc) {
  const paths = new Map(), names = new Map(), vote = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) { vote(names, str(pr[1])); for (const pa of kids(pr, "path")) vote(paths, str(pa[1])); }
  }
  const top = (m) => { let best = null, bn = 0; for (const [k, n] of m) if (n > bn) { bn = n; best = k; } return best; };
  return { path: top(paths), project: top(names) };
}
// Next free page: the project's sheet count (root is page 1), bumped past the pages used on this screen.
function nextPage(ctx, doc) {
  const used = new Set(["1"]);
  for (const it of doc.items.values()) if (it.kind === "sheet") for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const pg = kid(pa, "page"); if (pg) used.add(str(pg[1])); }
  let n = Math.max(2, schDocs(ctx).length);
  while (used.has(String(n))) n++;
  return n;
}
function sheetInstance(ctx, doc, page) {
  const { path, project } = sheetPathHere(doc);
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro");
  const name = project || (pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : "") || (ctx.project && ctx.project.name) || "";
  if (!path || !name) return null;
  return ["instances", ["project", name, ["path", path, ["page", String(page)]]]];
}
// Place a sheet: make sure its file is a project doc, then commit the sheet node.  One at a time;
// clicks are ignored while the request is out, and a document switch drops the result.
function placeSheet(ctx, a, b, name, file) {
  if (S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return S.sheetJob.promise; }
  const doc = ctx.doc, job = { doc, promise: null }; S.sheetJob = job;
  job.promise = (async () => {
    try {
      const ref = await ensureSheetDoc(ctx, normSheetFile(file));
      if (S.sheetJob !== job || ctx.doc !== doc) return null;
      const node = sheetNode(a, b, name, ref.file);
      const inst = sheetInstance(ctx, doc, nextPage(ctx, doc)); if (inst) node.push(inst);
      const { item, change } = addNode(doc, node);
      ctx.commit([change], "sheet");
      rememberPlaced(item.kind, item.node);
      ctx.setSelected({ id: item.id });
      return item;
    } catch (e) { ctx.toast("Could not create the sheet: " + ((e && e.message) || e), 4000); return null; }
    finally { if (S.sheetJob === job) S.sheetJob = null; ctx.requestRender(); }
  })();
  return job.promise;
}
// The sheet border within tol of p and its nearest side (SCH_SHEET_PIN::ConstrainOnEdge's NearestSegment).
function sheetEdgeAt(doc, p, tol) {
  let best = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const [x, y] = atOf(it.node), s = kid(it.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
    const edges = { top: [[x, y], [x + w, y]], right: [[x + w, y], [x + w, y + h]], bottom: [[x, y + h], [x + w, y + h]], left: [[x, y], [x, y + h]] };
    for (const side of ["top", "right", "bottom", "left"]) { const d = segDist(p, edges[side][0], edges[side][1]); if (d <= tol && (!best || d < best.d)) best = { item: it, side, d, x, y, w, h }; }
  }
  return best;
}
// The pin sits on the edge, its free coordinate grid-snapped and clamped to the edge (ConstrainOnEdge).
function sheetPinPoint(ctx, edge, p) {
  const g = ctx.snap([p[0], p[1]]), clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (edge.side === "left") return [r4(edge.x), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "right") return [r4(edge.x + edge.w), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "top") return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y)];
  return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y + edge.h)];
}
function sheetPinClick(ctx, mm) {
  const edge = sheetEdgeAt(ctx.doc, mm, Math.max(1.27, 8 * mmPerPx(ctx)));
  if (!edge) { ctx.toast("Click on the border of a sheet"); return null; }
  const p = sheetPinPoint(ctx, edge, mm);
  promptImpl("Sheet pin", "", S.cursorClient, (name) => { if (name) placeSheetPin(ctx, edge.item, name, p, edge.side); });
  return edge;
}
// The pin goes into a clone of the sheet node after the fields (before instance data), committed as a whole-item change.
function placeSheetPin(ctx, sheet, name, p, side) {
  const node = deep(sheet.node), pin = sheetPinNode(name, p, side);
  const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances");
  if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "sheet pin");
  ctx.requestRender();
  return pin;
}

// ---------------------------------------------------------------- images (a file picker, then the bitmap rides on the cursor)
// done({ name, bytes }) or done({ base64 }) — or done(null).  Swappable for tests, like the prompt.
let imagePickerImpl = function (ctx, done) {
  if (!hasDom()) { done(null); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg"; inp.style.display = "none"; inp.dataset.schtools = "1";
  document.body.appendChild(inp);
  let sent = false; const finish = (v) => { if (sent) return; sent = true; inp.remove(); done(v); };
  inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; if (!f) { finish(null); return; } f.arrayBuffer().then((buf) => finish({ name: f.name, bytes: new Uint8Array(buf) })).catch(() => finish(null)); });
  inp.addEventListener("cancel", () => finish(null));
  // a dismissed dialog fires no change in older browsers: once focus is back and nothing was chosen, give up
  window.addEventListener("focus", () => setTimeout(() => { if (!inp.files || !inp.files.length) finish(null); }, 800), { once: true });
  inp.click();
};
function openImagePicker(ctx) {
  if (S.imageWait) return; S.imageWait = true;
  imagePickerImpl(ctx, (file) => {
    S.imageWait = false;
    if (!file || S.tool !== "image") return;
    const bytes = file.bytes || (file.base64 ? base64ToBytes(file.base64) : null);
    const base64 = file.base64 || (bytes ? bytesToBase64(bytes) : "");
    if (!base64) { ctx.toast("Could not read the image"); return; }
    const px = bytes ? imageSize(bytes) : null;               // drawn at BITMAP_BASE's 300 PPI
    startCarry(ctx, "image", imageNode(S.cursor || [0, 0], base64), S.cursor);
    if (S.carry) S.carry.size = px ? [px[0] * 25.4 / IMAGE_PPI, px[1] * 25.4 / IMAGE_PPI] : [20, 20];
  });
}

// ---------------------------------------------------------------- graphic shapes (KiCad's two/three-click drawing)
// S.draw = { shape, pts (fixed clicks), cur (cursor) }: rect and textbox take two corners, circle its
// centre then a radius point, arc its start, end and then a point on the arc, lines any number of
// points until Enter, a double click or a click on the last point.
function drawPoint(ctx, mm) { return ctx.snap([mm[0], mm[1]]).map(r4); }
function startDraw(ctx, shape, p) { S.draw = { shape, pts: [p], cur: p.slice() }; ctx.requestRender(); }
function cancelDraw(ctx) { S.draw = null; closePrompt(); ctx.requestRender(); }
function undoDrawPoint(ctx) { const d = S.draw; if (!d) return; if (d.pts.length > 1) d.pts.pop(); else S.draw = null; ctx.requestRender(); }
function drawClick(ctx, shape, p) {
  const d = S.draw;
  if (!d || d.shape !== shape) { startDraw(ctx, shape, p); return; }
  d.cur = p.slice();
  const last = d.pts[d.pts.length - 1];
  if (shape === "lines" || shape === "polygon" || shape === "rulearea") {
    if (same(p, last)) { finishDraw(ctx); return; }
    if (shape !== "lines" && d.pts.length >= 3 && same(p, d.pts[0])) { finishDraw(ctx); return; }   // back on the first point closes it
    d.pts.push(p); ctx.requestRender(); return;
  }
  if (shape === "bezier") {                        // start, control 1, end, then the far handle (BEZIER_GEOM_MANAGER)
    if (d.pts.length === 2 && same(p, d.pts[0])) { ctx.toast("The curve's end must differ from its start"); return; }
    d.pts.push(p); if (d.pts.length === 4) finishDraw(ctx); else ctx.requestRender(); return;
  }
  if (shape === "arc") {
    if (d.pts.length === 1) { if (!same(p, last)) d.pts.push(p); ctx.requestRender(); return; }
    if (!K.arcFrom3(d.pts[0], p, d.pts[1]) || same(p, d.pts[0]) || same(p, d.pts[1])) { ctx.toast("Click a point on the arc, off the line between its ends"); return; }
    d.pts.push(p); finishDraw(ctx); return;
  }
  if (same(p, last)) return;                     // a zero-size shape is not a shape
  d.pts.push(p); finishDraw(ctx);
}
function finishDraw(ctx) {
  const d = S.draw; if (!d) return;
  const doc = ctx.doc, pts = d.pts; let node = null, label = d.shape;
  if (d.shape === "rect") node = rectangleNode(pts[0], pts[1]), label = "rectangle";
  else if (d.shape === "circle") node = circleNode(pts[0], Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
  else if (d.shape === "arc") node = arcNode(pts[0], pts[2], pts[1]);
  else if (d.shape === "lines") { const p = simplify(pts); if (p.length >= 2) node = polylineNode(p); label = "lines"; }
  else if (d.shape === "polygon") { const p = simplify(pts); if (p.length >= 3) node = polygonNode(p); }
  else if (d.shape === "rulearea") { const p = simplify(pts); if (p.length >= 3) node = ruleAreaNode(p); label = "rule area"; }
  else if (d.shape === "bezier") {
    // KiCad's fourth click is the handle beyond the end: control 2 is its reflection over the end point
    if (pts.length === 4) { const e = pts[2], c2 = [r4(2 * e[0] - pts[3][0]), r4(2 * e[1] - pts[3][1])]; node = bezierNode(pts[0], pts[1], c2, e); }
  }
  else if (d.shape === "table") {
    d.await = true; ctx.requestRender();
    promptImpl("Rows x cols", "2x2", S.cursorClient, (spec) => {
      if (S.draw !== d) return; S.draw = null;
      const m = spec && spec.match(/^\s*(\d+)\s*[x×*,\s]\s*(\d+)\s*$/i);
      if (m) commitShape(ctx, tableNode(pts[0], pts[1], +m[1], +m[2], ctx.gridPitch), "table");
      else if (spec) ctx.toast("Rows x cols, e.g. 3x2");
      ctx.requestRender();
    });
    return;
  }
  else if (d.shape === "sheet") {
    // the rectangle is fixed; the name and file name come from two prompts, then the file is created
    d.await = true; ctx.requestRender();
    promptImpl("Sheet name", "", S.cursorClient, (name) => {
      if (S.draw !== d) return;
      if (!name) { S.draw = null; ctx.requestRender(); return; }
      promptImpl("Sheet file", sheetFileFor(name), S.cursorClient, (file) => {
        if (S.draw !== d) return; S.draw = null;
        if (file) placeSheet(ctx, pts[0], pts[1], name, file); else ctx.requestRender();
      });
    });
    return;
  }
  else if (d.shape === "textbox") {
    // the box is fixed, the text comes from the inline prompt; Escape there drops the box
    d.await = true; ctx.requestRender();
    promptImpl("Text box", "", S.cursorClient, (text) => { if (S.draw !== d) return; S.draw = null; if (text) commitShape(ctx, textBoxNode(text, pts[0], pts[1]), "text box"); ctx.requestRender(); });
    return;
  }
  S.draw = null;
  if (node) commitShape(ctx, node, label);
  ctx.requestRender();
}
function commitShape(ctx, node, label) {
  const { item, change } = addNode(ctx.doc, node);
  ctx.commit([change], label);
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null);
  return item;
}

// ---------------------------------------------------------------- overlay painting
function paint(c, item, alpha, px) {
  c.save(); c.globalAlpha = alpha;
  for (const g of item.geom) {
    const w = Math.max(g.w || g.wd || 0, px);
    if (g.t === "line") { c.strokeStyle = g.color; c.lineWidth = w; c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
    else if (g.t === "poly") { if (g.pts.length < 2) continue; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); if (g.fill) { c.fillStyle = g.fill; c.fill(); } c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); }
    else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); if (g.fill) { c.fillStyle = g.fill; c.fill(); } if (g.w > 0 || !g.fill) { c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); } }
    else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.strokeStyle = g.color; c.lineWidth = w; c.stroke(); }
    else if (g.t === "rect") { if (g.fill) { c.fillStyle = g.fill; c.fillRect(g.x, g.y, g.w, g.h); } c.strokeStyle = g.color; c.lineWidth = w; c.strokeRect(g.x, g.y, g.w, g.h); }
    else if (g.t === "text") {
      c.save(); c.translate(g.x, g.y); if (g.rot) c.rotate(-g.rot * Math.PI / 180);
      c.font = `${g.size * 0.92}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`; c.textAlign = g.h; c.textBaseline = g.v === "top" ? "top" : g.v === "bottom" ? "alphabetic" : "middle";
      c.fillStyle = g.color; c.fillText(g.text, 0, 0); c.restore();
    }
  }
  c.restore();
}
function outline(c, item, color, px, width) {
  c.save(); c.strokeStyle = color; c.lineWidth = width * px; c.globalAlpha = 0.9;
  if (LINE_KINDS.has(item.kind)) { const p = ptsOf(item.node); if (p.length > 1) { c.lineCap = "round"; c.lineWidth = Math.max(0.5, 5 * px); c.globalAlpha = 0.45; c.beginPath(); c.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]); c.stroke(); } }
  else { const b = rectOf(item), pad = 0.4; c.setLineDash([4 * px, 3 * px]); c.strokeRect(b[0] - pad, b[1] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad); }
  c.restore();
}
function drawOverlay(c, view, ctx) {
  S.ctx = ctx; installDom(ctx);
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1)), doc = ctx.doc;
  if (S.hover && S.hover !== S.sel && !S.drag) { const it = doc.items.get(S.hover); if (it) outline(c, it, CLR.hover, px, 1.5); }
  if (S.sel) { const it = doc.items.get(S.sel); if (it) outline(c, it, CLR.sel, px, 2); }
  if (S.highlight && typeof ctx.setHighlight !== "function") {   // app.js paints the highlight when it can; else a plain outline
    for (const id of S.highlight) { const it = doc.items.get(id); if (it) outline(c, it, "#FF40FF", px, 2); }
  }
  if (S.markers.length && S.markersDoc === doc && typeof ctx.setMarkers !== "function") {   // ERC markers: KiCad's little arrow, red for errors
    for (const m of S.markers) {
      const s = 6 * px; c.save(); c.fillStyle = m.severity === "error" ? "rgba(255,0,0,0.85)" : "rgba(255,180,0,0.9)"; c.strokeStyle = "#000"; c.lineWidth = px;
      c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(m.x + 1.6 * s, m.y - 0.6 * s); c.lineTo(m.x + 1.1 * s, m.y - 1.1 * s); c.lineTo(m.x + 0.6 * s, m.y - 1.6 * s); c.closePath(); c.fill(); c.stroke(); c.restore();
    }
  }
  if (S.drag) {
    for (const e of S.drag.items) outline(c, e.item, CLR.sel, px, 2);
    for (const s of S.drag.preview || []) {                 // new wires the drop will create
      c.save(); c.strokeStyle = s.kind === "bus" ? CLR.bus : CLR.wire; c.lineWidth = Math.max(s.kind === "bus" ? 0.3048 : 0.1524, 2 * px); c.lineCap = "round"; c.globalAlpha = 0.85;
      c.beginPath(); c.moveTo(s.pts[0][0], s.pts[0][1]); for (let i = 1; i < s.pts.length; i++) c.lineTo(s.pts[i][0], s.pts[i][1]); c.stroke(); c.restore();
    }
  }
  const w = S.wire;
  if (w) {
    const pts = w.pts.concat(legPoints(w.pts[w.pts.length - 1], w.cur, posture(w), w.flip));
    c.save(); c.strokeStyle = w.kind === "bus" ? CLR.bus : CLR.wire; c.lineWidth = Math.max(w.kind === "bus" ? 0.3048 : 0.1524, 2 * px); c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.stroke();
    c.fillStyle = CLR.sel; const h = 3 * px; for (const p of w.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h);
    c.restore();
  }
  const d = S.draw;
  if (d) {
    c.save(); c.strokeStyle = K.SCH.notes; c.lineWidth = Math.max(0.1524, 2 * px); c.lineCap = "round"; c.lineJoin = "round"; c.globalAlpha = 0.85;
    const cur = d.await ? d.pts[1] : d.cur, p0 = d.pts[0];
    if (d.shape === "sheet") c.strokeStyle = K.SCH.sheet; else if (d.shape === "rulearea") { c.strokeStyle = K.SCH.ruleArea; c.setLineDash([4 * px, 3 * px]); }
    if (d.shape === "rect" || d.shape === "textbox" || d.shape === "sheet" || d.shape === "table") c.strokeRect(Math.min(p0[0], cur[0]), Math.min(p0[1], cur[1]), Math.abs(cur[0] - p0[0]), Math.abs(cur[1] - p0[1]));
    else if (d.shape === "circle") { c.beginPath(); c.arc(p0[0], p0[1], Math.hypot(cur[0] - p0[0], cur[1] - p0[1]), 0, Math.PI * 2); c.stroke(); }
    else if (d.shape === "arc") {
      const a = d.pts.length > 1 ? K.arcFrom3(p0, cur, d.pts[1]) : null;
      c.beginPath();
      if (a) c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); else { c.moveTo(p0[0], p0[1]); c.lineTo(cur[0], cur[1]); }
      c.stroke();
    } else if (d.shape === "bezier") {
      // the manager's preview: end and control 2 trail the cursor until they are fixed
      const n = d.pts.length, e = n > 2 ? d.pts[2] : cur;
      const ctrl = n === 1 ? [p0, cur, cur, cur] : n === 2 ? [p0, d.pts[1], cur, cur] : [p0, d.pts[1], [2 * e[0] - cur[0], 2 * e[1] - cur[1]], e];
      const bp = K.bezierPts(ctrl, 24); c.beginPath(); c.moveTo(bp[0][0], bp[0][1]); for (let i = 1; i < bp.length; i++) c.lineTo(bp[i][0], bp[i][1]); c.stroke();
      c.save(); c.setLineDash([2 * px, 2 * px]); c.globalAlpha = 0.5; c.beginPath(); c.moveTo(ctrl[0][0], ctrl[0][1]); c.lineTo(ctrl[1][0], ctrl[1][1]); c.moveTo(ctrl[3][0], ctrl[3][1]); c.lineTo(ctrl[2][0], ctrl[2][1]); c.stroke(); c.restore();
    } else {
      c.beginPath(); c.moveTo(p0[0], p0[1]); for (let i = 1; i < d.pts.length; i++) c.lineTo(d.pts[i][0], d.pts[i][1]); c.lineTo(cur[0], cur[1]);
      if (d.shape !== "lines" && d.pts.length >= 2) c.closePath();   // polygons and rule areas close back to the first point
      c.stroke();
    }
    c.fillStyle = CLR.sel; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h);
    c.restore();
  }
  if (S.carry && S.carry.item) {
    paint(c, S.carry.item, 0.65, px);
    const b = S.carry.item.bbox;
    if (b) { c.save(); c.strokeStyle = CLR.hover; c.lineWidth = px; c.setLineDash([3 * px, 3 * px]); c.strokeRect(b[0] - 0.3, b[1] - 0.3, b[2] - b[0] + 0.6, b[3] - b[1] + 0.6); c.restore(); }
    else if (S.carry.kind === "image" && S.carry.size) {   // the canvas draws no bitmap: a crossed box of the image's size, centred on the anchor
      const [w, h] = S.carry.size, [x, y] = anchorOf("image", S.carry.node);
      c.save(); c.strokeStyle = CLR.hover; c.lineWidth = px; c.setLineDash([3 * px, 3 * px]);
      c.strokeRect(x - w / 2, y - h / 2, w, h); c.beginPath(); c.moveTo(x - w / 2, y - h / 2); c.lineTo(x + w / 2, y + h / 2); c.moveTo(x + w / 2, y - h / 2); c.lineTo(x - w / 2, y + h / 2); c.stroke(); c.restore();
    }
  }
  const t = toolOf(S.tool);
  if (t && S.cursor && !S.carry && t.id !== "delete") {   // where the next click lands
    const p = t.kind === "wire" || t.kind === "bus" ? snapConn(ctx, S.cursor, t.kind) : ctx.snap(S.cursor);
    c.save(); c.strokeStyle = CLR.hover; c.lineWidth = px; const h = 5 * px; c.strokeRect(p[0] - h, p[1] - h, 2 * h, 2 * h); c.restore();
  }
}

// ---------------------------------------------------------------- hooks (see app.js "editing tools")
function onActivate(toolId, ctx) {
  S.ctx = ctx; installDom(ctx); announceModes(ctx);
  S.tool = toolId;
  if (S.wire) finishWire(ctx);                    // leaving the wire tool keeps what was drawn
  closePrompt(); S.pending = null; if (S.drag) endDrag(ctx, false);
  if (S.draw) S.draw = null;                      // an unfinished shape is dropped with its tool
  if (!toolOf(toolId)) { closePicker(); S.carry = null; ctx.requestRender(); return; }
  S.sel = null; S.hover = null;
  if (toolId !== "place" && toolId !== "power" && toolId !== "image") S.carry = null;   // a carried duplicate rides into the place tool
  if (toolId !== "image") S.imageWait = false;    // a file chosen after leaving the tool is ignored anyway
  if (toolId === "junction") startCarry(ctx, "junction", junctionNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "noconnect") startCarry(ctx, "no_connect", noConnectNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "busentry") startCarry(ctx, "bus_entry", busEntryNode(S.cursor || [0, 0], 2.54, 2.54), S.cursor);
  else if (toolId === "place" && !S.carry) openPicker(ctx, S.cursorClient);
  else if (toolId === "power" && !S.carry) openPowerPicker(ctx, S.cursorClient);
  else if (toolId === "image" && !S.carry) openImagePicker(ctx);
  ctx.requestRender();
}
function onPointerDown(ev, mm, ctx) {
  S.ctx = ctx; installDom(ctx);
  if (ev.button !== undefined && ev.button !== 0) return false;
  const t = toolOf(S.tool); if (!t) return false;
  S.cursor = mm; if (ev.clientX !== undefined) S.cursorClient = [ev.clientX, ev.clientY];
  if (t.kind === "wire" || t.kind === "bus") {
    const p = snapConn(ctx, mm, t.kind);
    if (!S.wire) startWire(ctx, t.kind, p); else wireClick(ctx, p);
    return true;
  }
  if (TEXT_KINDS.has(t.kind)) {
    if (S.carry) dropCarry(ctx); else promptFor(ctx, t.kind, mm, S.cursorClient);
    return true;
  }
  if (t.id === "junction" || t.id === "noconnect" || t.id === "busentry") {
    if (!S.carry) onActivate(t.id, ctx);
    placeCarry(ctx, mm); dropCarry(ctx);
    onActivate(t.id, ctx);                       // the tool stays armed with a fresh ghost
    return true;
  }
  if (t.id === "place" || t.id === "power") {
    if (S.carry) { placeCarry(ctx, mm); dropCarry(ctx); }
    else if (t.id === "place") openPicker(ctx, S.cursorClient);
    else openPowerPicker(ctx, S.cursorClient);
    return true;
  }
  if (t.id === "classlabel") { promptClassLabel(ctx, mm, S.cursorClient); return true; }
  if (t.id === "image") { if (S.carry) { placeCarry(ctx, mm); dropCarry(ctx); } else openImagePicker(ctx); return true; }
  if (t.id === "sheetpin") { sheetPinClick(ctx, mm); return true; }
  if (t.id === "highlight") { highlightClick(ctx, mm); return true; }   // empty space clears it
  if (t.id === "sheet" && S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return true; }
  if (DRAW_TOOLS.has(t.id)) { if (S.draw && S.draw.await) return true; drawClick(ctx, t.id, drawPoint(ctx, mm)); return true; }
  if (t.id === "delete") { deleteAt(ctx, mm); return true; }   // an empty click is ours too: the tool stays armed
  return false;
}
function onPointerMove(ev, mm, ctx) {
  S.ctx = ctx; S.cursor = mm; if (ev && ev.clientX !== undefined) S.cursorClient = [ev.clientX, ev.clientY];
  if (S.wire) { const p = snapConn(ctx, mm, S.wire.kind); if (!same(S.wire.cur, p)) { S.wire.cur = p; ctx.requestRender(); } return; }
  if (S.carry) { placeCarry(ctx, mm); return; }
  if (S.draw && !S.draw.await) { const p = drawPoint(ctx, mm); if (!same(S.draw.cur, p)) { S.draw.cur = p; ctx.requestRender(); } return; }
  if (S.tool === "highlight" || S.tool === "sheetpin") {   // what the click would pick: a net item / pin, or the sheet whose border is near
    let id = null;
    if (S.tool === "highlight") { const p = pickNet(ctx, mm); id = p ? p.item.id : null; }
    else if (!ctx.viewOnly) { const e = sheetEdgeAt(ctx.doc, mm, Math.max(1.27, 8 * mmPerPx(ctx))); id = e ? e.item.id : null; }
    if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
    return;
  }
  if (S.tool === "delete") {                      // what the click would remove
    const hit = ctx.viewOnly ? null : pickAny(ctx, mm), id = hit ? hit.id : null;
    if (id !== S.hover) { S.hover = id; ctx.requestRender(); }
    return;
  }
  if (toolOf(S.tool)) ctx.requestRender();        // cursor marker
}
function onPointerUp() { /* clicks are handled on pointerdown, drags in the capture hooks */ }
function onKey(key, ev, ctx) {
  S.ctx = ctx; installDom(ctx);
  if (ctx.viewOnly) return false;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const armTool = (id, kind) => {
    ctx.setTool(id);
    if (S.cursor && (kind === "wire" || kind === "bus")) startWire(ctx, kind, snapConn(ctx, S.cursor, kind));   // KiCad starts drawing under the cursor
    else if (S.cursor && TEXT_KINDS.has(kind)) promptFor(ctx, kind, S.cursor, S.cursorClient);
    return true;
  };
  if (S.wire) {
    if (key === "/") { S.wire.flip = !S.wire.flip; ctx.requestRender(); return true; }
    if (key === "Enter" || lower === "k") { finishWire(ctx); return true; }
    if (key === "Backspace") { undoLeg(ctx); return true; }
  }
  if (S.draw && !S.draw.await) {
    if (key === "Enter") {
      const sh = S.draw.shape, n = S.draw.pts.length;
      if ((sh === "lines" && n >= 2) || ((sh === "polygon" || sh === "rulearea") && n >= 3)) finishDraw(ctx); else cancelDraw(ctx);
      return true;
    }
    if (key === "Backspace") { undoDrawPoint(ctx); return true; }
    if (key === "Escape") { cancelDraw(ctx); return true; }
  }
  switch (key) {
  case "`": return armTool("highlight");
  case "w": case "W": return armTool("wire", "wire");
  case "b": case "B": return armTool("bus", "bus");
  case "z": case "Z": return armTool("busentry");
  case "j": case "J": return armTool("junction");
  case "q": case "Q": return armTool("noconnect");
  case "p": case "P": return armTool("power");
  case "i": case "I": return armTool("lines");
  case "l": return armTool("label", "label");
  case "L": return armTool("glabel", "global_label");
  case "t": case "T": return armTool("text", "text");
  case "a": case "A": return armTool("place");
  case "r": return orientSelected(ctx, "ccw");
  case "R": return orientSelected(ctx, ev && ev.shiftKey ? "cw" : "ccw");
  case "x": case "X": return orientSelected(ctx, "y");     // KiCad's X is Mirror Horizontally: (mirror y)
  case "y": case "Y": return orientSelected(ctx, "x");     // Y is Mirror Vertically: (mirror x)
  case "d": case "D": return duplicateSelected(ctx);
  case "Insert": return repeatLast(ctx);
  case "o": case "O": return autoplaceSelection(ctx);
  case "u": case "U": return editFieldPrompt(ctx, "Reference", "Reference", true);
  case "v": case "V": return editFieldPrompt(ctx, "Value", "Value", true);
  case "~": if (!S.highlight) return false; setHighlight(ctx, null); return true;
  case "g": case "G": case "m": case "M": {
    setDragMode(ctx, lower === "m" ? "move" : "drag");
    if (S.drag) return true;                                // switched mid-drag: the preview re-resolved
    const it = S.sel ? ctx.doc.items.get(S.sel) : null; if (!it || !S.cursor) return true;
    return !!beginDrag(ctx, it, S.cursor, false);
  }
  case " ": if (ev && ev.shiftKey) { cycleLineMode(ctx); return true; } return false;
  case "Delete": case "Backspace": return deleteSelected(ctx);
  default: return false;
  }
}
function onDocChanged(ctx) {
  S.ctx = ctx; installDom(ctx);
  S.wire = null; S.carry = null; S.drag = null; S.pending = null; S.sel = null; S.hover = null; S.draw = null; S.sheetJob = null; S.imageWait = false;
  if (S.docRef !== ctx.doc) {                   // a different sheet (app.js also calls this after every commit, same doc): repeat memory, ERC markers and an unfold in progress belong to the old one
    S.docRef = ctx.doc; S.lastPlaced = null; S.unfold = null;
    if (S.markersDoc !== ctx.doc) { S.markers = []; S.markersDoc = null; }
  }
  if (S.highlight) setHighlight(ctx, null);
  closePrompt(); closePicker(); announceModes(ctx);
  S.tool = curTool();
}

// ================================================================ commands (CollabTools.sch.actions)
// Everything below is KiCad's non-tool command set: clipboard, select connection, repeat, type
// conversions, autoplace fields, annotation, ERC, swap / align / move exactly, group rotate and
// mirror, the symbol fields table and bus unfolding.  app.js binds menus and keys to the `actions`
// map at the bottom; every run(ctx) returns true when it handled the request.  The pure helpers are
// exported on `_` for the tests.
S.markers = [];                    // ERC findings [{ x, y, severity, text, ids, code }] (app.js renders them)
S.markersDoc = null;
S.lastPlaced = null;               // { kind, node } of the last item placed, for Insert
S.repeatOffset = [0, 2.54];        // eeschema's default_repeat_offset (0 mil, 100 mil)
S.repeatIncrement = 1;             // repeat_label_increment
S.annotateAuto = false;            // toggleAnnotateAuto: pasted / repeated symbols get the next free number
S.unfold = null;                   // { labelId } while a bus unfold's wire is being drawn
S.docRef = null;

// ---------------------------------------------------------------- selection, cursor and clipboard plumbing
// ctx carries `selection` (Set of ids), `selected` (primary), `setSelection(ids)`, `clipboard` ({ get(), set(text) })
// and `cursor` (mm); each has a fallback so the module also runs against today's ctx.
function selectedItems(ctx) {
  const doc = ctx.doc, out = [], seen = new Set();
  const take = (id) => { if (!id || seen.has(id)) return; const it = doc.items.get(id); if (it) { seen.add(id); out.push(it); } };
  // the multi-selection when there is one, else the app's primary item, else this module's own pick (selectedItem's precedence)
  if (ctx.selection && typeof ctx.selection.forEach === "function" && ctx.selection.size) { ctx.selection.forEach((id) => take(id)); if (ctx.selected) take(ctx.selected.id); }
  else if (ctx.selected) take(ctx.selected.id);
  else take(S.sel);
  return out;
}
function setSelectionIds(ctx, ids) {
  ids = Array.from(ids || []).filter((id) => ctx.doc.items.has(id));
  S.sel = null; S.hover = null; S.pending = null;
  if (typeof ctx.setSelection === "function") ctx.setSelection(ids);
  else {
    if (ctx.selection && typeof ctx.selection.clear === "function") { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); }
    const prim = ids.map((id) => ctx.doc.items.get(id)).find((it) => it.kind === "symbol" || it.kind === "sheet");
    if (prim) ctx.setSelected({ id: prim.id }); else { ctx.setSelected(null); S.sel = ids[0] || null; }
  }
  ctx.requestRender();
}
function cursorOf(ctx) { return ctx.cursor || S.cursor || [ctx.doc.page[0] / 2, ctx.doc.page[1] / 2]; }
function snapCursor(ctx) { const c = cursorOf(ctx); return ctx.snap([c[0], c[1]]).map(r4); }
function editable(ctx) { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; }
const CLIP = { text: "" };         // internal buffer when the page has no clipboard access
function clipWrite(ctx, text) {
  CLIP.text = text;
  if (ctx.clipboard && typeof ctx.clipboard.set === "function") { try { ctx.clipboard.set(text); } catch (e) { /* buffer only */ } }
  else if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}
function clipRead(ctx) {           // a string, or a Promise of one when the browser clipboard must be asked
  if (ctx.clipboard && typeof ctx.clipboard.get === "function") { try { const v = ctx.clipboard.get(); if (v !== undefined && v !== null) return v; } catch (e) { /* fall through */ } }
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText().then((t) => t || CLIP.text, () => CLIP.text);
  return CLIP.text;
}
const PASTE_KINDS = new Set(["symbol", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label",
  "text", "text_box", "rectangle", "circle", "arc", "bezier", "rule_area", "sheet", "table", "image"]);

// ---------------------------------------------------------------- copy / cut / paste / duplicate
// What the desktop puts on the clipboard (SCH_IO_KICAD_SEXPR::Format for a selection): the library
// symbols used, then the items — no (kicad_sch …) wrapper, which its copyable-only parser rejects.
// opts.wrap gives the document form for anything that wants a whole sheet.
function clipboardText(doc, items, opts) {
  const libs = new Map();
  for (const it of items) if (it.kind === "symbol") { const name = str((kid(it.node, "lib_id") || [])[1]); const lib = doc.lib.get(name); if (lib && !libs.has(name)) libs.set(name, lib); }
  const parts = [];
  if (libs.size) parts.push("(lib_symbols " + Array.from(libs.values()).map((l) => K.serialize(l)).join(" ") + ")");
  for (const it of items) {
    let node = it.node;
    if (it.kind === "rule_area" && kid(node, "uuid")) { node = deep(node); dropKid(node, "uuid"); }
    let s = K.serialize(node); if (it.kind === "sheet") s = s.replace(/\(page (\d+)\)/g, '(page "$1")');
    parts.push(s);
  }
  const body = parts.join("\n");
  return opts && opts.wrap ? `(kicad_sch (version 20250114) (generator "kicad-collab-web") (generator_version "9.0")\n${body}\n)` : body;
}
// Both clipboard forms: a bare item sequence (the desktop's) or a (kicad_sch …) document.
function parseClipboard(text) {
  let trees; try { trees = K.parseAll(str(text)); } catch (e) { return null; }
  const nodes = [], libs = [];
  const takeLibs = (ls) => { for (const s of kids(ls, "symbol")) libs.push(s); };
  for (const t of trees || []) {
    if (!Array.isArray(t)) continue;
    if (t[0] === "kicad_sch") { const ls = kid(t, "lib_symbols"); if (ls) takeLibs(ls); for (const c of t.slice(1)) if (Array.isArray(c) && PASTE_KINDS.has(c[0])) nodes.push(c); }
    else if (t[0] === "lib_symbols") takeLibs(t);
    else if (PASTE_KINDS.has(t[0])) nodes.push(t);
  }
  return nodes.length ? { nodes, libs } : null;
}
const refPrefix = (ref) => str(ref).replace(/\?$/, "").replace(/\d+$/, "");
const unannotated = (ref) => refPrefix(ref) + "?";
const refNumber = (ref) => { const m = str(ref).match(/(\d+)$/); return m ? +m[1] : -1; };
function usedReferences(doc, skip) { const used = new Set(); for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !(skip && skip.has(it.id))) used.add(it.ref); return used; }
function refField(node) { return kids(node, "property").find((p) => str(p[1]) === "Reference") || null; }
// Set a symbol node's reference designator, keeping its instance data in step.
function setReference(node, ref) {
  const p = refField(node); if (p) p[2] = ref;
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const r = kid(pa, "reference"); if (r) r[1] = ref; }
}
// Pasted / repeated symbols keep a reference that is still free on the sheet; anything else becomes "R?"
// (or, with automatic annotation on, the next free number for its prefix).
function assignPastedRef(doc, node, used) {
  const p = refField(node); if (!p) return;
  const ref = str(p[2]);
  if (!/\?$/.test(ref) && !used.has(ref)) { used.add(ref); return; }
  let next = unannotated(ref);
  if (S.annotateAuto) { const prefix = refPrefix(ref); let n = 1; while (used.has(prefix + n)) n++; next = prefix + n; used.add(next); }
  setReference(node, next);
}
// Junctions the new items need: every connection point of every new item (items must be in the doc).
function junctionsForNew(doc, items) {
  const out = [], seen = new Set();
  for (const it of items) {
    const line = isNetLine(it.kind);
    for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) {
      const key = r4(p[0]) + "," + r4(p[1]); if (seen.has(key)) continue; seen.add(key);
      if (junctionAt(doc, p[0], p[1])) continue;
      const need = line ? needsJunction(doc, p[0], p[1], it.kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (need) out.push(addNode(doc, junctionNode(p)).change);
    }
  }
  return out;
}
// Fresh copies of clipboard nodes landed at `at` (mm): the first symbol's anchor (else the first
// item's) goes to the point, like the desktop's paste-then-move.  Returns { changes, ids }.
function pasteChanges(doc, parsed, at, opts) {
  for (const lib of parsed.libs) { const name = str(lib[1]); if (!doc.lib.has(name)) doc.lib.set(name, lib); }   // the sheet's own copy wins (ChoosePasteLibSymbol)
  const fresh = parsed.nodes.map((n) => cloneNode({ kind: n[0], node: deep(n) }));
  const used = usedReferences(doc);
  for (const n of fresh) if (n[0] === "symbol" && !(opts && opts.keepAnnotations)) assignPastedRef(doc, n, used);
  const lead = fresh.find((n) => n[0] === "symbol") || fresh[0], a = anchorOf(lead[0], lead);
  const dx = r4(at[0] - a[0]), dy = r4(at[1] - a[1]);
  for (const n of fresh) shiftNode(n[0], n, dx, dy);
  const changes = [], items = [];
  for (const n of fresh) { const { item, change } = addNode(doc, n); changes.push(change); items.push(item); }
  changes.push(...junctionsForNew(doc, items));
  return { changes, ids: items.map((it) => it.id) };
}
function copySelection(ctx) {
  const items = selectedItems(ctx); if (!items.length) { ctx.toast("Nothing selected"); return false; }
  clipWrite(ctx, clipboardText(ctx.doc, items)); return true;
}
function cutSelection(ctx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) { ctx.toast("Nothing selected"); return false; }
  clipWrite(ctx, clipboardText(ctx.doc, items));
  const changes = deleteChanges(ctx.doc, items);
  setSelectionIds(ctx, []); ctx.commit(changes, "cut"); ctx.requestRender();
  return true;
}
function pasteText(ctx, text, opts) {
  const parsed = parseClipboard(text);
  if (!parsed) { if (str(text).trim()) ctx.toast("Clipboard has no schematic items"); return false; }
  const { changes, ids } = pasteChanges(ctx.doc, parsed, (opts && opts.at) || snapCursor(ctx), opts);
  ctx.commit(changes, (opts && opts.label) || "paste");
  setSelectionIds(ctx, ids);
  return true;
}
function pasteSelection(ctx, opts) {
  if (!editable(ctx)) return false;
  const v = clipRead(ctx);
  if (v && typeof v.then === "function") { v.then((t) => pasteText(ctx, t, opts)); return true; }
  return pasteText(ctx, v, opts);
}
function duplicateSelection(ctx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) { ctx.toast("Nothing selected"); return false; }
  if (items.length === 1 && items[0].kind !== "sheet") { if (ctx.selected && ctx.selected.id !== items[0].id) ctx.setSelected({ id: items[0].id }); S.sel = items[0].id; return duplicateSelected(ctx); }
  return pasteText(ctx, clipboardText(ctx.doc, items), { label: "duplicate" });
}
function copyAsText(ctx) {
  const items = selectedItems(ctx); if (!items.length) return false;
  const lines = [];
  for (const it of items) {
    if (it.kind === "symbol") lines.push([it.ref, it.value].filter(Boolean).join(" "));
    else if (TEXT_KINDS.has(it.kind) || it.kind === "text_box") lines.push(str(it.node[1]));
    else if (it.kind === "netclass_flag" || it.kind === "directive_label") { const nc = kids(it.node, "property").find((p) => str(p[1]) === "Netclass"); if (nc) lines.push(str(nc[2])); }
    else if (it.kind === "sheet") lines.push([it.name, it.file].filter(Boolean).join(" "));
  }
  clipWrite(ctx, lines.join("\n")); return true;
}

// ---------------------------------------------------------------- select connection / node, net walking
function selectConnection(ctx) {
  const doc = ctx.doc, ids = new Set();
  for (const it of selectedItems(ctx)) if (NET_PICK.has(it.kind) || it.kind === "symbol" || it.kind === "sheet") for (const id of netItems(doc, it, cursorOf(ctx))) ids.add(id);
  if (!ids.size) { const pick = pickNet(ctx, cursorOf(ctx)); if (pick) for (const id of netItems(doc, pick.item, pick.at)) ids.add(id); }
  if (!ids.size) return false;
  setSelectionIds(ctx, ids); return true;
}
function selectNode(ctx) {
  const hit = hitNonSymbol(ctx.doc, cursorOf(ctx)[0], cursorOf(ctx)[1], Math.max(0.3, 5 * mmPerPx(ctx)));
  if (!hit || !isNetLine(hit.kind)) return false;
  setSelectionIds(ctx, [hit.id]); return true;
}
function stepNetItem(ctx, dir) {
  const items = selectedItems(ctx); if (!items.length) return false;
  const ids = Array.from(netItems(ctx.doc, items[0], cursorOf(ctx))).sort(); if (ids.length < 2) return false;
  const i = ids.indexOf(items[0].id), next = ids[((i < 0 ? 0 : i) + dir + ids.length) % ids.length];
  setSelectionIds(ctx, [next]); return true;
}
function unselectAll(ctx) { setSelectionIds(ctx, []); return true; }

// ---------------------------------------------------------------- repeat last item (Insert)
function rememberPlaced(kind, node) { S.lastPlaced = { kind, node: deep(node) }; }
// common/increment.cpp IncrementString: the last run of digits steps, leading zeros kept; null below zero.
function incrementText(text, delta) {
  const m = str(text).match(/^([\s\S]*?)(\d+)(\D*)$/); if (!m) return str(text);
  const n = parseInt(m[2], 10) + (delta === undefined ? 1 : delta); if (n < 0) return null;
  return m[1] + String(n).padStart(m[2].length, "0") + m[3];
}
function repeatLast(ctx) {
  if (!editable(ctx)) return false;
  const lp = S.lastPlaced; if (!lp) { ctx.toast("Nothing to repeat yet"); return false; }
  const doc = ctx.doc, node = cloneNode({ kind: lp.kind, node: deep(lp.node) });
  if (LABEL_KINDS.has(lp.kind) && lp.kind !== "netclass_flag" && lp.kind !== "directive_label") {
    const t = incrementText(node[1], S.repeatIncrement); if (t === null) ctx.toast("Label value cannot go below zero"); else node[1] = t;
  }
  if (lp.kind === "symbol") { const p = snapCursor(ctx), a = anchorOf("symbol", node); shiftNode("symbol", node, r4(p[0] - a[0]), r4(p[1] - a[1])); assignPastedRef(doc, node, usedReferences(doc)); }
  else shiftNode(lp.kind, node, S.repeatOffset[0], S.repeatOffset[1]);
  const { item, change } = addNode(doc, node);
  const changes = [change, ...junctionsForNew(doc, [item])];
  ctx.commit(changes, "repeat");
  S.lastPlaced = { kind: item.kind, node: deep(item.node) };
  setSelectionIds(ctx, [item.id]);
  return true;
}
function incrementSelection(ctx, delta) {
  if (!editable(ctx)) return false;
  const changes = [];
  for (const it of selectedItems(ctx)) {
    if (!TEXT_KINDS.has(it.kind) && it.kind !== "text_box") continue;
    const t = incrementText(it.node[1], delta); if (t === null || t === str(it.node[1])) continue;
    const n = deep(it.node); n[1] = t; changes.push(modChange(ctx.doc, it, n));
  }
  if (!changes.length) return false;
  ctx.commit(changes, delta < 0 ? "decrement" : "increment"); return true;
}

// ---------------------------------------------------------------- type conversions (SCH_EDIT_TOOL::ChangeTextType)
const CONVERT_KINDS = new Set(["label", "global_label", "hierarchical_label", "text", "text_box", "netclass_flag", "directive_label"]);
const LABEL_SIZE_RATIO = 0.375;    // SCHEMATIC_SETTINGS::m_LabelSizeRatio
function copyFont(from, to) {
  const ef = kid(from, "effects"), f = ef && kid(ef, "font"); if (!f) return;
  const tef = kid(to, "effects"); if (!tef) return;
  replaceKid(tef, deep(f));
}
// KiCad's getValidNetname: line breaks and tabs become underscores, so do spaces unless it is a bus group.
function validNetname(text) {
  let t = str(text).replace(/[\r\n\t]/g, "_");
  if (!/^[^\s{}]*\{.*\}$/.test(t)) t = t.replace(/ /g, "_");
  return t || "<empty>";
}
function convertNode(item, toKind, gridPitch) {
  const n = item.node, from = item.kind;
  let text = str(n[1]), p = atOf(n).slice(0, 2), rot = atOf(n)[2] || 0;
  const shapeN = kid(n, "shape"), shape = shapeN && (from === "global_label" || from === "hierarchical_label") ? str(shapeN[1]) : null;
  if (from === "netclass_flag" || from === "directive_label") { const nc = kids(n, "property").find((q) => str(q[1]) === "Netclass"); text = nc ? str(nc[2]) : "<empty>"; }
  if (from === "text") rot = 0;                                   // a text's angle is not a spin style: labels start out reading right
  if (from === "text_box") {
    const s = kid(n, "size"), mg = kid(n, "margins"), size = fontSize(n);
    const m = mg ? [num(mg[1]), num(mg[2]), num(mg[3]), num(mg[4])] : [TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN];
    let box = [p[0] + m[0], p[1] + m[1], p[0] + num(s && s[1]) - m[2], p[1] + num(s && s[2]) - m[3]];
    if (toKind === "label" || toKind === "global_label" || toKind === "hierarchical_label") { const inf = LABEL_SIZE_RATIO * size; box = [box[0] - inf, box[1] - inf, box[2] + inf, box[3] + inf]; }
    const ef = kid(n, "effects"), j = ef && kid(ef, "justify"), right = !!(j && j.includes("right")), vertical = rot === 90 || rot === 270;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    if (vertical) { rot = right ? 270 : 90; p = right ? [cx, box[1]] : [cx, box[3]]; } else { rot = right ? 180 : 0; p = right ? [box[2], cy] : [box[0], cy]; }
    const g = gridPitch || 1.27; p = [r4(K.snap(p[0], g)), r4(K.snap(p[1], g))];
  }
  let out;
  if (toKind === "text_box") {
    const r = TEXT_KINDS.has(from) ? textRect(item) : (item.bbox || [p[0], p[1] - 1.27, p[0] + 5, p[1]]);
    const size = fontSize(n), mg = r4(0.75 * size), slop = r4(mg / 20);
    let x0 = r[0] - mg, y0 = r[1] - mg, x1 = r[2] + mg, y1 = r[3] + mg;
    if (rot === 90 || rot === 270) { if (rot === 270) y1 += slop; else y0 -= slop; } else if (rot === 180) x0 -= slop; else x1 += slop;
    out = textBoxNode(text, [x0, y0], [x1, y1]);
  } else if (toKind === "netclass_flag" || toKind === "directive_label") out = classLabelNode(from === "netclass_flag" || from === "directive_label" ? text : text, p, rot);
  else if (toKind === "text") out = labelNode("text", text, p, rot);
  else { out = labelNode(toKind, validNetname(text), p, rot); if (shape && toKind !== "label") replaceKid(out, ["shape", shape]); }
  if (!uuidOf(out)) out.push(["uuid", K.newUuid()]);
  copyFont(n, out);
  return out;
}
function convertSelection(ctx, toKind) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes = [], ids = [];
  for (const it of selectedItems(ctx)) {
    if (!CONVERT_KINDS.has(it.kind) || it.kind === toKind || (toKind === "netclass_flag" && it.kind === "directive_label")) continue;
    const node = convertNode(it, toKind, ctx.gridPitch);
    const added = addNode(doc, node); doc.items.delete(added.item.id);       // commit adds it; keep the doc untouched until then
    changes.push(removeChange(it), added.change); ids.push(added.item.id);
  }
  if (!changes.length) return false;
  ctx.commit(changes, "change to " + toKind.replace("_", " "));
  setSelectionIds(ctx, ids); return true;
}

// ---------------------------------------------------------------- symbol pins with their electrical type (lib symbol + transform)
function symbolPins(doc, item) {
  const n = item.node, out = [];
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, str((kid(n, "lib_id") || [])[1])); if (!lib) return out;
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
  const tf = (lx, ly) => [r4(ax + T[0] * lx + T[1] * ly), r4(ay + T[2] * lx + T[3] * ly)];
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
    if ((u !== 0 && u !== unit) || (m && s !== style)) continue;
    for (const g of kids(sub, "pin")) {
      const [px, py, pr] = atOf(g), lenN = kid(g, "length"), len = lenN ? num(lenN[1]) : 2.54;
      const dir = ((Math.round(pr) % 360) + 360) % 360, d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
      const pos = tf(px, py), root = tf(px + d[0] * len, py + d[1] * len);
      const h = kid(g, "hide"); const hidden = h ? str(h[1]) !== "no" : g.includes("hide");
      let ox = pos[0] - root[0], oy = pos[1] - root[1]; const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
      if (!ox && !oy) { const tip = tf(px - d[0], py - d[1]); ox = Math.sign(tip[0] - pos[0]); oy = Math.sign(tip[1] - pos[1]); }
      out.push({ x: pos[0], y: pos[1], root, number: str((kid(g, "number") || [])[1]), name: str((kid(g, "name") || [])[1]), type: str(g[1]) || "passive", hidden, len,
        side: ox > 0 ? "right" : ox < 0 ? "left" : oy < 0 ? "top" : "bottom" });
    }
  }
  return out;
}
function symbolLibId(node) { return str((kid(node, "lib_id") || [])[1]); }
function symbolIsPower(doc, item) { return isPowerSymbol(doc, symbolLibId(item.node)); }

// ---------------------------------------------------------------- autoplace fields (eeschema/autoplace_fields.cpp)
const AP_HPADDING = 0.635, AP_VPADDING = 0.381, AP_GRID = 1.27, AP_WIRE_V = 2.54, AP_FIELD_PADDING = 0.381;
const SIDES = { right: [1, 0], top: [0, -1], left: [-1, 0], bottom: [0, 1] };
// round_n on positive IU: up or down to the next multiple of n
function roundN(v, n, up) { const q = v / n, r = Math.round(q); if (Math.abs(q - r) < 1e-6) return r4(r * n); return r4((up ? Math.ceil(q) : Math.floor(q)) * n); }
function fieldHidden(p) { const h = kid(p, "hide"); if (h) return str(h[1]) !== "no"; const ef = kid(p, "effects"); return !!(ef && (ef.includes("hide") || (kid(ef, "hide") && str(kid(ef, "hide")[1]) !== "no"))); }
function fieldFont(p) { const ef = kid(p, "effects"), f = ef && kid(ef, "font"), s = f && kid(f, "size"), th = f && kid(f, "thickness"); const size = s ? num(s[2], num(s[1], 1.27)) : 1.27; const bold = !!(f && (f.includes("bold") || (kid(f, "bold") && str(kid(f, "bold")[1]) !== "no"))); const thick = th && num(th[1]) > 0.001 ? num(th[1]) : Math.min(bold ? size / 5 : size / 8, size / 4); return { size, thick, bold }; }
// EDA_TEXT::GetTextBox for the stroke font: glyph extents inflated by 1.5 × pen, 17% taller.
function fieldExtent(p) {
  const { size, thick } = fieldFont(p), text = str(p[2]);
  const lines = text.split("\n"), w = Math.max(...lines.map((l) => K.textWidth(l, size, 0))) + 3 * thick;
  return { w: r4(w), h: r4((size + 3 * thick) * 1.17 + (lines.length - 1) * size * 1.61) };
}
// The body box: the library drawing (no pins, no fields) plus the visible pin roots, on the sheet.
function bodyBox(doc, item) {
  const n = item.node, libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, symbolLibId(n));
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  const tf = (lx, ly) => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  let b = null; const take = (p) => { b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
  if (lib) {
    const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
    for (const sub of kids(lib, "symbol")) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || (m && s !== style)) continue;
      for (const g of sub.slice(2)) {
        if (!Array.isArray(g)) continue;
        const gk = g[0];
        if (gk === "rectangle") { const a = kid(g, "start"), e = kid(g, "end"); take(tf(num(a[1]), num(a[2]))); take(tf(num(e[1]), num(e[2]))); }
        else if (gk === "circle") { const c = kid(g, "center"), r = num((kid(g, "radius") || [])[1]); for (const [dx, dy] of [[-r, -r], [r, r], [-r, r], [r, -r]]) take(tf(num(c[1]) + dx, num(c[2]) + dy)); }
        else if (gk === "arc") { for (const key of ["start", "mid", "end"]) { const k = kid(g, key); if (k) take(tf(num(k[1]), num(k[2]))); } }
        else if (gk === "polyline" || gk === "bezier") { for (const [x, y] of ptsOf(g)) take(tf(x, y)); }
        else if (gk === "text") { const [tx, ty] = atOf(g), ef = K.effectsOf(g); if (!ef.hide) { const w = K.textWidth(str(g[1]), ef.size, 0) / 2; take(tf(tx - w, ty - ef.size / 2)); take(tf(tx + w, ty + ef.size / 2)); } }
      }
    }
  }
  for (const pin of symbolPins(doc, item)) if (!pin.hidden) take(pin.root);
  return (b || [ax, ay, ax, ay]).map(r4);
}
const boxW = (b) => b[2] - b[0], boxH = (b) => b[3] - b[1];
function boxesIntersect(a, b) { return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function autoplaceNode(doc, item, opts) {
  opts = opts || {};
  const node = deep(item.node), power = symbolIsPower(doc, item), pins = symbolPins(doc, item).filter((p) => !p.hidden || power);
  const fields = kids(node, "property").filter((p) => !fieldHidden(p) && !str(p[1]).startsWith("ki_") && str(p[2]) !== "");
  if (!fields.length) return null;
  const [, , rot] = atOf(node), mN = kid(node, "mirror"), mirror = mN ? str(mN[1]) : "", T = K.symbolTransform(rot, mirror);
  const fieldRot = T[1] !== 0 ? 90 : 0;                          // vertical storage counters the transform: fields always display horizontally
  const flipStored = (T[1] !== 0 ? T[1] : T[0]) < 0;             // the canvas (and IsHorizJustifyFlipped) render the stored justify flipped
  const body = bodyBox(doc, item), symW = boxW(body), symH = boxH(body);
  const ext = fields.map(fieldExtent);
  let fbox = { w: Math.max(...ext.map((e) => e.w)), h: ext.reduce((t, e) => t + roundN(e.h, AP_GRID, true), 0) };
  const pinsOn = (side) => pins.filter((p) => p.side === side).length;
  // getPreferredSides
  let sides = ["right", "top", "left", "bottom"].map((s) => ({ side: s, pins: pinsOn(s) }));
  const swap = (i, j) => { const t = sides[i]; sides[i] = sides[j]; sides[j] = t; };
  if (power) { if (rot === 0) { swap(0, 1); swap(1, 3); } else if (rot === 90) { swap(0, 2); swap(1, 2); } else if (rot === 180) swap(0, 3); else if (rot === 270) swap(1, 2); }
  else { if (mirror === "x" && (rot === 0 || rot === 180)) swap(0, 2); if (symH > 0 && symW / symH > 3) { swap(0, 1); swap(1, 3); } }
  // fieldBoxPlacement
  const place = (sp, size) => {
    const [sx, sy] = SIDES[sp.side], cx = (body[0] + body[2]) / 2, cy = (body[1] + body[3]) / 2;
    let ox = (symW + size.w) / 2, oy = (symH + size.h) / 2; if (sx) ox += AP_HPADDING; else if (sy) oy += AP_VPADDING;
    let x = cx + sx * ox - size.w / 2, y = cy + sy * oy - size.h / 2;
    if (sp.pins > 0) {
      let pb = null; for (const p of pins) if (p.side === sp.side) for (const q of [[p.x, p.y], p.root]) pb = pb ? [Math.min(pb[0], q[0]), Math.min(pb[1], q[1]), Math.max(pb[2], q[0]), Math.max(pb[3], q[1])] : [q[0], q[1], q[0], q[1]];
      if (pb) { if (sy) x = pb[2] + 2 * AP_HPADDING; else y = pb[1] - (size.h + 2 * AP_VPADDING); }
    }
    return [x, y];
  };
  // chooseSideForFields (manual: sides whose field box collides with other items go last)
  const others = Array.from(doc.items.values()).filter((it) => it !== item && it.id !== item.id && it.bbox);
  const collision = (sp) => {
    const [x, y] = place(sp, fbox), box = [x, y, x + fbox.w, y + fbox.h]; let coll = "none";
    for (const it of others) { if (!boxesIntersect(it.bbox, box)) continue; if (isNetLine(it.kind) && !SIDES[sp.side][0] && ptsOf(it.node).every((p) => Math.abs(p[1] - ptsOf(it.node)[0][1]) < 1e-6) && coll !== "objects") coll = "hwires"; else coll = "objects"; }
    return coll;
  };
  sides.reverse();
  let side = { side: "right", pins: Infinity };
  if (opts.manual !== false) {
    const colliding = new Map(); for (const sp of sides) { const c = collision(sp); if (c !== "none") colliding.set(sp.side, c); }
    for (const kind of ["objects", "hwires"]) sides = sides.filter((sp) => { if (colliding.get(sp.side) !== kind) return true; if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; return false; });
  }
  let chosen = null;
  for (let i = sides.length - 1; i >= 0; i--) if (!sides[i].pins) { chosen = sides[i]; break; }
  if (!chosen) { for (const sp of sides) if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; chosen = side; }
  let [bx, by] = place(chosen, fbox);
  const [sx, sy] = SIDES[chosen.side];
  // fitFieldsBetweenWires: only horizontal wires in the way -> fixed 100 mil rows on the wire pitch
  let wireSpacing = false;
  if (opts.manual !== false && sy) {
    const box = [bx, by, bx + fbox.w, by + fbox.h], hits = others.filter((it) => boxesIntersect(it.bbox, box));
    if (hits.length && hits.every((it) => isNetLine(it.kind) && ptsOf(it.node).length > 1 && Math.abs(ptsOf(it.node)[0][1] - ptsOf(it.node)[1][1]) < 1e-6)) {
      const offs = new Set(hits.map((it) => r4(1.5 * AP_WIRE_V - (ptsOf(it.node)[0][1] % AP_WIRE_V))));
      if (offs.size === 1) { wireSpacing = true; fbox = { w: fbox.w, h: fields.length * AP_WIRE_V }; by = roundN(by, AP_WIRE_V, chosen.side === "bottom"); }
    }
  }
  // move the fields
  let lastY = by;
  fields.forEach((p, i) => {
    let hj = sx ? (sx > 0 ? "left" : "right") : "center";
    if (chosen.pins > 0) hj = sy ? "left" : "center";
    let x = hj === "left" ? bx : hj === "right" ? bx + fbox.w : bx + fbox.w / 2;
    const fh = wireSpacing ? AP_WIRE_V / 2 : ext[i].h, pad = wireSpacing ? AP_WIRE_V / 2 : roundN(fh, AP_GRID, true) - fh;
    let y = lastY + pad / 2 + fh / 2; lastY += pad + fh;
    if (sx) x = roundN(x, AP_GRID, sx >= 0);
    if (sy) y = roundN(y, AP_GRID, sy >= 0);
    const a = kid(p, "at"); const keep = a ? a.slice(4) : [];
    replaceKid(p, ["at", r4(x), r4(y), fieldRot, ...keep]);
    const stored = flipStored ? (hj === "left" ? "right" : hj === "right" ? "left" : "center") : hj;
    let ef = kid(p, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; p.push(ef); }
    if (stored === "center") dropKid(ef, "justify"); else replaceKid(ef, ["justify", stored]);
  });
  dropKid(node, "fields_autoplaced");
  const ui = node.findIndex((c) => Array.isArray(c) && c[0] === "uuid");
  node.splice(ui >= 0 ? ui : node.length, 0, ["fields_autoplaced", "yes"]);
  return node;
}
function autoplaceSelection(ctx, opts) {
  if (!editable(ctx)) return false;
  const changes = [];
  for (const it of selectedItems(ctx)) { if (it.kind !== "symbol") continue; const n = autoplaceNode(ctx.doc, it, opts); if (n) changes.push(modChange(ctx.doc, it, n)); }
  if (!changes.length) return false;
  ctx.commit(changes, "autoplace fields"); return true;
}

// ---------------------------------------------------------------- annotation (sch_reference_list.cpp Annotate / sortByXPosition)
function splitRef(ref) {
  ref = str(ref); if (!ref) return { prefix: "U", num: -1, isNew: true };
  if (/\?$/.test(ref)) return { prefix: ref.slice(0, -1), num: -1, isNew: true };
  const m = ref.match(/^(.*?)(\d+)$/); if (!m) return { prefix: ref, num: -1, isNew: true };
  return { prefix: m[1], num: +m[2], isNew: false };
}
// opts: { order: "x" | "y", keep: true (incremental) | false (renumber everything), start: 0, sheetInterval: 0 | 100 | 1000, sheetNumber: 1, only: Set of ids }
function annotateChanges(doc, opts) {
  opts = opts || {};
  const order = opts.order === "y" ? "y" : "x", keep = opts.keep !== false, start = opts.start | 0, interval = opts.sheetInterval | 0, sheetNum = opts.sheetNumber || 1;
  const refs = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const p = refField(it.node); if (!p) continue;
    const r = splitRef(p[2]); const [x, y] = atOf(it.node); const unitN = kid(it.node, "unit");
    refs.push({ item: it, prefix: r.prefix, num: r.num, isNew: (r.isNew || !keep) && (!opts.only || opts.only.has(it.id)), old: str(p[2]), x, y, unit: unitN ? num(unitN[1], 1) : 1 });
  }
  refs.sort((a, b) => a.prefix.localeCompare(b.prefix) || (order === "x" ? (a.x - b.x || a.y - b.y) : (a.y - b.y || a.x - b.x)) || (a.item.id < b.item.id ? -1 : 1));
  const used = new Map();       // prefix -> Set of numbers in use
  const take = (prefix, n) => { if (!used.has(prefix)) used.set(prefix, new Set()); used.get(prefix).add(n); };
  for (const r of refs) if (!r.isNew && r.num >= 0) take(r.prefix, r.num);
  const minRef = interval ? sheetNum * interval + 1 : start + 1;
  const assigned = new Map();   // old full reference of a multi-unit package -> its new number
  const changes = [];
  for (const r of refs) {
    if (!r.isNew) continue;
    let n;
    // units of one multi-unit package (same old reference) stay together, like KiCad's locked-unit map
    const packageKey = r.old && !/\?$/.test(r.old) && libUnits(doc, r.item.node).units > 1 ? r.prefix + ":" + r.old : null;
    if (packageKey && assigned.has(packageKey)) n = assigned.get(packageKey);
    else { n = minRef; const set = used.get(r.prefix); while (set && set.has(n)) n++; take(r.prefix, n); if (packageKey) assigned.set(packageKey, n); }
    const ref = r.prefix + n; if (ref === r.old) continue;
    const node = deep(r.item.node); setReference(node, ref); changes.push(modChange(doc, r.item, node));
  }
  return changes;
}
function clearAnnotationChanges(doc, only) {
  const changes = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" || (only && !only.has(it.id))) continue;
    const p = refField(it.node); if (!p || /\?$/.test(str(p[2]))) continue;
    const node = deep(it.node); setReference(node, unannotated(str(p[2]))); changes.push(modChange(doc, it, node));
  }
  return changes;
}
function annotate(ctx, opts) {
  if (!editable(ctx)) return false;
  const changes = annotateChanges(ctx.doc, Object.assign({ sheetNumber: ctx.pageNumber }, opts || {}));
  if (!changes.length) { ctx.toast("Nothing to annotate"); return true; }
  ctx.commit(changes, "annotate"); ctx.toast(`Annotated ${changes.length} symbol${changes.length === 1 ? "" : "s"}`); return true;
}
function clearAnnotation(ctx, opts) {
  if (!editable(ctx)) return false;
  const changes = clearAnnotationChanges(ctx.doc, opts && opts.only);
  if (!changes.length) return true;
  ctx.commit(changes, "clear annotation"); return true;
}
function editFieldPrompt(ctx, name, title, quiet) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) { if (!quiet) ctx.toast("Select a symbol first"); return false; }
  const p = kids(it.node, "property").find((q) => str(q[1]) === name); const cur = p ? str(p[2]) : "";
  promptImpl(title, cur, S.cursorClient, (text) => {
    if (text === null || text === undefined || text === cur) return;
    const node = deep(it.node);
    if (name === "Reference") setReference(node, text);
    else { let q = kids(node, "property").find((z) => str(z[1]) === name); if (!q) { q = ["property", name, "", ["at", ...atOf(node).slice(0, 2), 0], ["hide", "yes"], ["effects", fontNode(1.27)]]; insertField(node, q); } q[2] = text; }
    ctx.commit([modChange(ctx.doc, it, node)], name.toLowerCase());
  });
  return true;
}
function insertField(node, p) { const at = node.findIndex((c) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances")); if (at >= 0) node.splice(at, 0, p); else node.push(p); }
const FLAG_KEYS = { setDNP: ["dnp", "yes", "no"], setExcludeFromBOM: ["in_bom", "no", "yes"], setExcludeFromSim: ["exclude_from_sim", "yes", "no"], setExcludeFromBoard: ["on_board", "no", "yes"] };
function toggleSymbolFlag(ctx, which) {
  if (!editable(ctx)) return false;
  const [key, onVal, offVal] = FLAG_KEYS[which], changes = [];
  const items = selectedItems(ctx).filter((it) => it.kind === "symbol"); if (!items.length) return false;
  const allOn = items.every((it) => { const k = kid(it.node, key); return k && str(k[1]) === onVal; });
  for (const it of items) { const node = deep(it.node); replaceKid(node, [key, allOn ? offVal : onVal]); changes.push(modChange(ctx.doc, it, node)); }
  ctx.commit(changes, which.replace(/^set/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()); return true;
}
function libUnits(doc, node) {
  const lib = K.resolveLib(doc, symbolLibId(node)); const units = new Set(), styles = new Set();
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m) { if (+m[1] > 0) units.add(+m[1]); styles.add(+m[2]); } }
  return { units: Math.max(1, ...units), styles: Math.max(1, ...styles) };
}
function stepUnit(ctx, dir) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("Symbol has a single unit"); return false; }
  const cur = kid(it.node, "unit") ? num(kid(it.node, "unit")[1], 1) : 1, next = ((cur - 1 + dir + units) % units) + 1;
  const node = deep(it.node); replaceKid(node, ["unit", next]);
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const u = kid(pa, "unit"); if (u) u[1] = next; }
  ctx.commit([modChange(ctx.doc, it, node)], "unit"); return true;
}
function cycleBodyStyle(ctx) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { styles } = libUnits(ctx.doc, it.node); if (styles < 2) { ctx.toast("Symbol has no alternate body style"); return false; }
  const cur = kid(it.node, "body_style") ? num(kid(it.node, "body_style")[1], 1) : 1;
  const node = deep(it.node); replaceKid(node, ["body_style", (cur % styles) + 1]);
  ctx.commit([modChange(ctx.doc, it, node)], "body style"); return true;
}
function placeNextUnit(ctx) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("Symbol has a single unit"); return false; }
  const inUse = new Set(); for (const o of ctx.doc.items.values()) if (o.kind === "symbol" && o.ref === it.ref) inUse.add(kid(o.node, "unit") ? num(kid(o.node, "unit")[1], 1) : 1);
  let next = 1; while (inUse.has(next) && next <= units) next++;
  if (next > units) { ctx.toast("All units of " + it.ref + " are placed"); return false; }
  const node = cloneNode(it); replaceKid(node, ["unit", next]);
  S.carry = { kind: "symbol", node, item: ghost(ctx.doc, node), pos: anchorOf("symbol", node) };
  S.sel = null; ctx.setSelected(null); ctx.setTool("place"); ctx.requestRender(); return true;
}
function showDatasheet(ctx) {
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const p = kids(it.node, "property").find((q) => str(q[1]) === "Datasheet"); const url = p ? str(p[2]).trim() : "";
  if (!url || url === "~") { ctx.toast("No datasheet defined"); return false; }
  if (typeof window !== "undefined" && window.open && /^https?:/i.test(url)) window.open(url, "_blank"); else ctx.toast("Datasheet: " + url);
  return true;
}

// ---------------------------------------------------------------- ERC (eeschema/erc/erc.cpp subset)
const PIN_TYPES = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"];
const PIN_TYPE_TEXT = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
// ERC_SETTINGS::m_defaultPinMap: 0 ok, 1 warning, 2 error
const PIN_MATRIX = [
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2], [0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
  [0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2], [0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]];
const DRIVING = new Set(["output", "power_out", "passive", "tri_state", "bidirectional"]), DRIVEN = new Set(["input", "power_in"]);
const pinTypeIndex = (t) => { const i = PIN_TYPES.indexOf(t); return i < 0 ? 6 : i; };
const ptKey = (p) => r4(p[0]) + "," + r4(p[1]);
// Every terminal on the sheet joined into nets (the rules of netItems, evaluated once with union-find).
function ercNets(doc) {
  const terms = [];
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") {
      const power = symbolIsPower(doc, it), value = kids(it.node, "property").find((p) => str(p[1]) === "Value");
      for (const pin of symbolPins(doc, it)) {
        let key; if (power && value) key = "global:" + str(value[2]); else if (pin.hidden && pin.type === "power_in") key = "global:" + pin.name;
        terms.push({ item: it, p: [pin.x, pin.y], net: "wire", key, pin, power });
      }
    } else if (it.kind === "sheet") { for (const pin of kids(it.node, "pin")) terms.push({ item: it, p: atOf(pin).slice(0, 2).map(r4), net: "any", sheetPin: str(pin[1]) }); }
    else for (const t of terminalsOf(doc, it)) terms.push(Object.assign({ item: it }, t));
  }
  const parent = terms.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const byItem = new Map(), byPoint = new Map(), byKey = new Map(), touch = terms.map(() => false);
  terms.forEach((t, i) => {
    if (!byItem.has(t.item)) byItem.set(t.item, []); byItem.get(t.item).push(i);
    const pk = ptKey(t.p); if (!byPoint.has(pk)) byPoint.set(pk, []); byPoint.get(pk).push(i);
    if (t.key) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key).push(i); }
  });
  for (const [it, idx] of byItem) if (conducts(it)) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  for (const idx of byPoint.values()) for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) if (terms[idx[a]].item !== terms[idx[b]].item && joins(terms[idx[a]], terms[idx[b]])) { union(idx[a], idx[b]); touch[idx[a]] = touch[idx[b]] = true; }
  for (const [it, idx] of byItem) {
    if (!isNetLine(it.kind)) continue;
    const sg = segs(it), lineT = { net: it.kind };
    terms.forEach((u, i) => { if (u.item === it || !joins(lineT, u)) return; if (sg.some(([a, b]) => onSegMid(u.p, a, b))) { union(idx[0], i); touch[i] = true; } });
  }
  for (const idx of byKey.values()) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  const nets = new Map();
  terms.forEach((t, i) => { const r = find(i); if (!nets.has(r)) nets.set(r, { terms: [], ids: new Set() }); const n = nets.get(r); n.terms.push(t); n.ids.add(t.item.id); t.attached = touch[i]; });
  return { terms, nets: Array.from(nets.values()) };
}
// A no-connect flag at p, a sheet pin at p, any net line end / middle at p.
function noConnectAt(doc, p) { return noConnectsAt(doc, p).length > 0; }
function pinLabel(t) { return `${t.item.ref || "?"} pin ${t.pin.number}${t.pin.name && t.pin.name !== "~" ? " (" + t.pin.name + ")" : ""}`; }
function ercCheck(doc, opts) {
  opts = opts || {};
  const markers = [], mark = (code, severity, p, text, ids) => markers.push({ code, severity, x: r4(p[0]), y: r4(p[1]), text, ids: Array.from(new Set(ids || [])) });
  const { nets } = ercNets(doc);
  // symbols: annotation and duplicate references
  const byRef = new Map();
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const ref = it.ref || "", [x, y] = atOf(it.node);
    if (!ref || /\?$/.test(ref)) { mark("unannotated", "error", [x, y], `Symbol ${ref || "(no reference)"} is not annotated`, [it.id]); continue; }
    const unit = kid(it.node, "unit") ? num(kid(it.node, "unit")[1], 1) : 1, k = ref + "#" + unit;
    if (byRef.has(k)) mark("duplicate_reference", "error", [x, y], `Duplicate reference designators ${ref}`, [it.id, byRef.get(k).id]); else byRef.set(k, it);
  }
  // nets: pins, drivers, labels
  for (const net of nets) {
    const pins = net.terms.filter((t) => t.pin), labels = net.terms.filter((t) => LABEL_KINDS.has(t.item.kind));
    const leaves = net.terms.some((t) => t.sheetPin || t.item.kind === "hierarchical_label" || t.item.kind === "global_label" || t.power || (t.pin && t.key));
    for (const t of pins) {
      if (t.pin.hidden || t.pin.type === "no_connect" || t.key) continue;
      if (!t.attached && !noConnectAt(doc, t.p)) mark("pin_not_connected", "error", t.p, `Pin not connected: ${pinLabel(t)}`, [t.item.id]);
      if (t.pin.type === "no_connect" || (noConnectAt(doc, t.p) && net.terms.some((u) => u !== t && u.item !== t.item)))
        mark("no_connect_connected", "warning", t.p, `A pin with a "no connection" flag is connected: ${pinLabel(t)}`, [t.item.id]);
    }
    const visible = pins.filter((t) => !t.pin.hidden || t.power);
    let hasDriver = false, isPower = visible.some((t) => t.pin.type === "power_in"), needs = null, worst = null;
    for (let i = 0; i < visible.length; i++) {
      const a = visible[i];
      if (isPower ? a.pin.type === "power_out" : DRIVING.has(a.pin.type)) hasDriver = true;
      if (DRIVEN.has(a.pin.type) && (!needs || (isPower && a.pin.type === "power_in" && needs.pin.type !== "power_in"))) needs = a;
      for (let j = i + 1; j < visible.length; j++) {
        const b = visible[j]; if (a.item === b.item && a.pin.number === b.pin.number) continue;
        const e = PIN_MATRIX[pinTypeIndex(a.pin.type)][pinTypeIndex(b.pin.type)];
        if (e && (!worst || e > worst.e)) worst = { e, a, b };
      }
    }
    if (worst) mark(worst.e === 2 ? "pin_to_pin_error" : "pin_to_pin_warning", worst.e === 2 ? "error" : "warning", worst.a.p, `Pins of type ${PIN_TYPE_TEXT[worst.a.pin.type]} and ${PIN_TYPE_TEXT[worst.b.pin.type]} are connected: ${pinLabel(worst.a)} and ${pinLabel(worst.b)}`, [worst.a.item.id, worst.b.item.id]);
    if (needs && !hasDriver && visible.length > 1 && !net.terms.some((t) => t.pin && noConnectAt(doc, t.p))) {
      const leavesSheet = net.terms.some((t) => t.sheetPin || t.item.kind === "hierarchical_label");
      if (!leavesSheet) mark(isPower ? "power_pin_not_driven" : "pin_not_driven", leaves ? "warning" : "error", needs.p,
        (isPower ? "Input Power pin not driven by any Output Power pins" : "Input pin not driven by any Output pins") + ": " + pinLabel(needs) + (leaves ? " (no driver on this sheet)" : ""), [needs.item.id]);
    }
    for (const t of labels) {
      if (t.item.kind === "netclass_flag" || t.item.kind === "directive_label") continue;
      const text = str(t.item.node[1]);
      if (!text.trim()) mark("empty_label_name", "error", t.p, "Label has an empty name", [t.item.id]);
      if (!t.attached) mark("label_dangling", "error", t.p, `Label not connected: ${text}`, [t.item.id]);
      else if (t.item.kind === "label" && pins.length === 1 && labels.length === 1 && !leaves) mark("isolated_pin_label", "warning", t.p, `Label connected to only one pin: ${text}`, [t.item.id]);
      const wires = new Set(); for (const it of doc.items.values()) if (it.kind === "wire" && (K.wireEndsAt(doc, t.p[0], t.p[1], 1e-3).some((e) => e.item === it) || segs(it).some(([a, b]) => onSegMid(t.p, a, b)))) wires.add(it.id);
      if (wires.size > 1) mark("label_multiple_wires", "warning", t.p, `Label connects more than one wire: ${text}`, [t.item.id, ...wires]);
    }
  }
  // wires: dangling ends
  for (const it of doc.items.values()) {
    if (!isNetLine(it.kind)) continue;
    const pts = ptsOf(it.node); if (pts.length < 2) continue;
    const loose = [pts[0], pts[pts.length - 1]].filter((p) => {
      if (K.wireEndsAt(doc, p[0], p[1], 1e-3).some((e) => e.item !== it)) return false;
      if (lineMidsAt(doc, p[0], p[1], "wire").length || lineMidsAt(doc, p[0], p[1], "bus").length) return false;
      if (it.kind === "wire" && pinsAt(doc, p[0], p[1]).length) return false;
      return !labelsAt(doc, p).length && !sheetPinsAt(doc, p).length && !busEntriesAt(doc, p).length && !noConnectsAt(doc, p).length;
    });
    if (loose.length === 2) mark("wire_dangling", "error", [(pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2], "Wires not connected to anything", [it.id]);
    else for (const p of loose) mark("unconnected_wire_endpoint", "warning", p, "Unconnected wire endpoint", [it.id]);
  }
  // no-connect flags on nothing, four-way junctions
  for (const it of doc.items.values()) {
    if (it.kind === "no_connect") { const [x, y] = atOf(it.node); if (!pinsAt(doc, x, y).length && !K.wireEndsAt(doc, x, y, 1e-3).length) mark("no_connect_dangling", "warning", [x, y], 'Unconnected "no connection" flag', [it.id]); }
    if (it.kind === "junction") { const [x, y] = atOf(it.node); if (lineEndsAt(doc, x, y, "wire").length >= 4) mark("four_way_junction", "warning", [x, y], "Four connection points are joined together", [it.id]); }
  }
  // similar labels (case-insensitive twins)
  const names = new Map();
  for (const it of doc.items.values()) if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") { const t = str(it.node[1]); const k = t.toLowerCase(); if (!names.has(k)) names.set(k, new Map()); names.get(k).set(t, it); }
  for (const m of names.values()) if (m.size > 1) { const its = Array.from(m.values()); mark("similar_labels", "warning", atOf(its[0].node), `Labels are similar: ${Array.from(m.keys()).join(", ")}`, its.map((x) => x.id)); }
  // sheet pins vs the sub-sheet's hierarchical labels (when the sub-sheet document is known)
  const sheetDocs = opts.sheetDocs || null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const sub = sheetDocs ? subsheetDoc(sheetDocs, it) : null;
    const pinNames = new Map(); for (const pin of kids(it.node, "pin")) pinNames.set(str(pin[1]), pin);
    if (sub) {
      const hier = new Set(); for (const o of sub.items.values()) if (o.kind === "hierarchical_label") hier.add(str(o.node[1]));
      for (const [name, pin] of pinNames) if (!hier.has(name)) mark("hier_label_mismatch", "error", atOf(pin), `Sheet pin ${name} has no matching hierarchical label in ${it.file || "the sheet"}`, [it.id]);
      const [x, y] = atOf(it.node);
      for (const name of hier) if (!pinNames.has(name)) mark("hier_label_mismatch", "error", [x, y], `Hierarchical label ${name} in ${it.file || "the sheet"} has no sheet pin`, [it.id]);
    }
  }
  if (opts.parentPins) { const pp = new Set(opts.parentPins); for (const it of doc.items.values()) if (it.kind === "hierarchical_label" && !pp.has(str(it.node[1]))) mark("hier_label_mismatch", "error", atOf(it.node), `Hierarchical label ${str(it.node[1])} has no sheet pin on the parent sheet`, [it.id]); }
  markers.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.y - b.y || a.x - b.x);
  return markers;
}
// ctx.sheetDocs: a Map or object of Sheetfile (or docId / path) -> parsed doc or its text.
function subsheetDoc(sheetDocs, sheet) {
  const get = (k) => (typeof sheetDocs.get === "function" ? sheetDocs.get(k) : sheetDocs[k]);
  const file = sheet.file || str((kids(sheet.node, "property").find((p) => str(p[1]) === "Sheetfile") || [])[2]);
  let d = get(file) || get(baseName(file)) || get(sheet.id); if (!d) return null;
  if (typeof d === "string") { try { d = K.parseDoc(d); } catch (e) { return null; } if (typeof sheetDocs.set === "function") sheetDocs.set(file, d); }
  return d && d.items ? d : null;
}
function runERC(ctx, opts) {
  const markers = ercCheck(ctx.doc, Object.assign({ sheetDocs: ctx.sheetDocs, parentPins: ctx.parentSheetPins }, opts || {}));
  S.markers = markers; S.markersDoc = ctx.doc;
  if (typeof ctx.setMarkers === "function") ctx.setMarkers(markers);
  const errors = markers.filter((m) => m.severity === "error").length;
  ctx.toast(markers.length ? `ERC: ${errors} error${errors === 1 ? "" : "s"}, ${markers.length - errors} warning${markers.length - errors === 1 ? "" : "s"}` : "ERC: no problems found");
  ctx.requestRender(); return true;
}
// Sheet pins the sub-sheet's hierarchical labels ask for (syncSheetPins); cleanupSheetPins removes the orphans.
function syncSheetPins(ctx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes = []; let added = 0;
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    const have = new Set(kids(it.node, "pin").map((p) => str(p[1]))); const node = deep(it.node);
    const [x, y] = atOf(node), s = kid(node, "size"), h = num(s && s[2]); let row = 0;
    for (const o of sub.items.values()) {
      if (o.kind !== "hierarchical_label" || have.has(str(o.node[1]))) continue;
      const py = Math.min(y + h, r4(y + 1.27 * (++row)));
      const pin = sheetPinNode(str(o.node[1]), [x, py], "left"); const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
      have.add(str(o.node[1])); added++;
    }
    if (added) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "sync sheet pins"); return true;
}
function cleanupSheetPins(ctx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes = [];
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    const hier = new Set(); for (const o of sub.items.values()) if (o.kind === "hierarchical_label") hier.add(str(o.node[1]));
    const node = deep(it.node); const before = kids(node, "pin").length;
    for (let i = node.length - 1; i > 0; i--) if (Array.isArray(node[i]) && node[i][0] === "pin" && !hier.has(str(node[i][1]))) node.splice(i, 1);
    if (kids(node, "pin").length !== before) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "cleanup sheet pins"); return true;
}

// ---------------------------------------------------------------- group transforms: rotate / mirror about the selection centre, swap, align, move exactly
const HALF_GRID = 0.635;
const halfGrid = (v) => r4(Math.round(v / HALF_GRID) * HALF_GRID);
function itemsBox(items) { let b = null; for (const it of items) { const r = it.bbox || rectOf(it); if (!r) continue; b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r.slice(); } return b; }
function selectionCentre(items) { const b = itemsBox(items); return b ? [halfGrid((b[0] + b[2]) / 2), halfGrid((b[1] + b[3]) / 2)] : [0, 0]; }
// SCH_EDIT_TOOL::Rotate's pivot: a lone connectable item turns about its position, anything else about its
// half-grid box centre; a multi-selection about the selection centre.
function rotationCentre(items) {
  if (items.length !== 1) return selectionCentre(items);
  const it = items[0], own = it.kind === "symbol" || LABEL_KINDS.has(it.kind) || POINT_KINDS.has(it.kind) || TEXT_KINDS.has(it.kind);
  return own ? anchorOf(it.kind, it.node) : selectionCentre(items);
}
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically: y flips) | "y" (Mirror Horizontally: x flips)
function mapPoint(op, C, p) { const [dx, dy] = SCREEN_OP[op](p[0] - C[0], p[1] - C[1]); return [r4(C[0] + dx), r4(C[1] + dy)]; }
function setFlagRot(node, rot) {
  rot = ((rot % 360) + 360) % 360; const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  const p = [num(a[1]), num(a[2])]; for (const pr of kids(node, "property")) replaceKid(pr, flagFieldAt(p, rot));
}
function sideOfEdge(p, box) { const d = [["left", Math.abs(p[0] - box[0])], ["right", Math.abs(p[0] - box[2])], ["top", Math.abs(p[1] - box[1])], ["bottom", Math.abs(p[1] - box[3])]]; d.sort((a, b) => a[1] - b[1]); return d[0][0]; }
function transformNode(kind, node, op, C) {
  const rot = op === "ccw" || op === "cw";
  const mapAt = (n) => { const a = kid(n, "at"); if (!a) return; const q = mapPoint(op, C, [num(a[1]), num(a[2])]); a[1] = q[0]; a[2] = q[1]; };
  const mapPts = (n) => setPts(n, ptsOf(n).map((p) => mapPoint(op, C, p)));
  const moveTo = (p0) => { const p1 = mapPoint(op, C, p0); shiftNode(kind, node, r4(p1[0] - p0[0]), r4(p1[1] - p0[1])); };
  switch (kind) {
  case "symbol": { const p0 = anchorOf(kind, node); orientSymbol(node, op); moveTo(p0); return true; }
  case "label": case "global_label": case "hierarchical_label": case "text": {
    const p0 = anchorOf(kind, node);
    if (rot) setTextRot(kind, node, atOf(node)[2] + (op === "cw" ? 270 : 90)); else mirrorNode(kind, node, op);
    moveTo(p0); return true;
  }
  case "netclass_flag": case "directive_label": {
    const p0 = anchorOf(kind, node), r0 = atOf(node)[2] || 0;
    if (rot) setFlagRot(node, r0 + (op === "cw" ? 270 : 90)); else { const flip = op === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 }; if (flip[r0] !== undefined) setFlagRot(node, flip[r0]); }
    moveTo(p0); return true;
  }
  case "junction": case "no_connect": case "image": mapAt(node); return true;
  case "bus_entry": { mapAt(node); const s = kid(node, "size"); if (s) { const [dx, dy] = SCREEN_OP[op](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); } return true; }
  case "wire": case "bus": case "polyline": case "bezier": mapPts(node); return true;
  case "rule_area": for (const pl of kids(node, "polyline")) mapPts(pl); return true;
  case "rectangle": { const a = kid(node, "start"), b = kid(node, "end"); const [x0, y0, x1, y1] = corners(mapPoint(op, C, [num(a[1]), num(a[2])]), mapPoint(op, C, [num(b[1]), num(b[2])])); a[1] = x0; a[2] = y0; b[1] = x1; b[2] = y1; return true; }
  case "circle": { const c = kid(node, "center"); const p = mapPoint(op, C, [num(c[1]), num(c[2])]); c[1] = p[0]; c[2] = p[1]; return true; }
  case "arc": { for (const key of ["start", "mid", "end"]) { const k = kid(node, key); if (k) { const p = mapPoint(op, C, [num(k[1]), num(k[2])]); k[1] = p[0]; k[2] = p[1]; } } return true; }
  case "text_box": {
    const [x, y, a] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    const vertical = a === 90 || a === 270;
    setAt(node, x0, y0, rot ? (vertical ? 0 : 90) : a); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    if (!rot && ((op === "y" && !vertical) || (op === "x" && vertical))) { const ef = kid(node, "effects"), j = ef && kid(ef, "justify"); if (j) { const i = j.indexOf("left") > 0 ? j.indexOf("left") : j.indexOf("right"); if (i > 0) j[i] = j[i] === "left" ? "right" : "left"; } }
    return true;
  }
  case "table": { const cells = kid(node, "cells"), c0 = cells && kid(cells, "table_cell"); if (!c0) return false; moveTo(atOf(c0).slice(0, 2)); return true; }   // tables keep their orientation
  case "sheet": {
    const [x, y] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    setAt(node, x0, y0); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    for (const pin of kids(node, "pin")) {
      const pp = mapPoint(op, C, atOf(pin).slice(0, 2)), [prot, just] = PIN_SIDE[sideOfEdge(pp, [x0, y0, x1, y1])];
      setAt(pin, pp[0], pp[1], prot); let ef = kid(pin, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; pin.push(ef); } replaceKid(ef, ["justify", just]);
    }
    const auto = kid(node, "fields_autoplaced") && str(kid(node, "fields_autoplaced")[1]) !== "no";
    for (const pr of kids(node, "property")) {
      const name = str(pr[1]);
      if (auto && name === "Sheetname") replaceKid(pr, ["at", x0, r4(y0 - SHEET_NAME_OFF), 0]);
      else if (auto && name === "Sheetfile") replaceKid(pr, ["at", x0, r4(y1 + SHEET_FILE_OFF), 0]);
      else shiftAt(pr, r4(x0 - x), r4(y0 - y));
    }
    return true;
  }
  default: return false;
  }
}
// MODIFIED changes for the items transformed about C, plus the junction / merge cleanup around every connection point.
function transformChanges(ctx, items, op, C, times) {
  const doc = ctx.doc, out = [], touched = [], keep = new Set();
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    for (let k = 0; k < (times || 1) && ok; k++) ok = transformNode(it.kind, n, op, C) !== false;
    if (!ok) continue;
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);   // commit re-adds them from the fragments
  return out.concat(extra);
}
function transformSelected(ctx, op, items, centre) {
  if (!editable(ctx)) return false;
  items = items || selectedItems(ctx); if (!items.length) return false;
  const C = centre || selectionCentre(items);
  const changes = transformChanges(ctx, items, op, C);
  if (!changes.length) return false;
  ctx.commit(changes, op === "x" || op === "y" ? "mirror" : "rotate");
  return true;
}
function moveExactChanges(ctx, items, dx, dy, rot) {
  const doc = ctx.doc, turns = ((Math.round((rot || 0) / 90) % 4) + 4) % 4, C = rotationCentre(items);
  const out = [], touched = [], keep = new Set();
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    for (let k = 0; k < turns && ok; k++) ok = transformNode(it.kind, n, "ccw", C) !== false;
    if (!ok) continue;
    shiftNode(it.kind, n, r4(dx || 0), r4(dy || 0));
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
function moveExactly(ctx, opts) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) { ctx.toast("Nothing selected"); return false; }
  const apply = (dx, dy, rot) => { const changes = moveExactChanges(ctx, items, dx, dy, rot); if (changes.length) ctx.commit(changes, "move exactly"); return changes.length > 0; };
  if (opts && (opts.dx !== undefined || opts.dy !== undefined || opts.rot !== undefined)) return apply(num(opts.dx), num(opts.dy), num(opts.rot));
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null; if (!KD) return false;
  KD.open({ title: "Move Exactly", width: 360,
    build(body) { body.innerHTML = '<div class="kv"><label>Move X (mm)</label><input id="kd-mx" type="number" step="0.01" value="0"><label>Move Y (mm)</label><input id="kd-my" type="number" step="0.01" value="0"><label>Rotate (°)</label><select id="kd-mr"><option value="0">0</option><option value="90">90</option><option value="180">180</option><option value="270">270</option></select></div><p class="kd-note">Rotation is about the centre of the selection, counterclockwise.</p>'; },
    ok() { const g = (id) => document.getElementById(id); apply(num(g("kd-mx").value), num(g("kd-my").value), num(g("kd-mr").value)); } });
  return true;
}
// Swap the positions of the selected items pairwise in selection order (SCH_EDIT_TOOL::Swap).
function swapNodes(items) {
  const nodes = items.map((it) => deep(it.node));
  if (items.length < 2) return nodes;
  for (let i = 0; i < items.length - 1; i++) {
    const A = nodes[i], B = nodes[i + 1], ka = items[i].kind, kb = items[i + 1].kind;
    const pa = anchorOf(ka, A), pb = anchorOf(kb, B);
    shiftNode(ka, A, r4(pb[0] - pa[0]), r4(pb[1] - pa[1])); shiftNode(kb, B, r4(pa[0] - pb[0]), r4(pa[1] - pb[1]));
    if (ka !== kb) continue;
    if (TEXT_KINDS.has(ka)) { const ra = atOf(A)[2] || 0, rb = atOf(B)[2] || 0; setTextRot(ka, A, rb); setTextRot(kb, B, ra); }
    else if (ka === "symbol" && symbolLibId(A) === symbolLibId(B)) {
      const oa = symOrient(A), ob = symOrient(B);
      for (const [n, o] of [[A, ob], [B, oa]]) { setAt(n, undefined, undefined, o.rot); dropKid(n, "mirror"); if (o.mirror) { const ai = n.findIndex((c) => Array.isArray(c) && c[0] === "at"); n.splice(ai + 1, 0, ["mirror", o.mirror]); } }
    }
  }
  return nodes;
}
function swapChanges(doc, items) { if (items.length < 2) return []; const nodes = swapNodes(items); return items.map((it, i) => modChange(doc, it, nodes[i])); }
function swapSelection(ctx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx).filter((it) => DRAG_KINDS.has(it.kind));
  if (items.length < 2) { ctx.toast("Select two or more items to swap"); return false; }
  const doc = ctx.doc, nodes = swapNodes(items), changes = items.map((it, i) => modChange(doc, it, nodes[i])), touched = [];
  items.forEach((it, i) => { touched.push(...connPoints(doc, it), ...connPoints(doc, { kind: it.kind, node: nodes[i], id: it.id })); });
  const extra = cleanupAt(doc, changes, touched, new Set(items.map((it) => it.id)), ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  ctx.commit(changes.concat(extra), "swap"); return true;
}
// Align to grid (SCH_MOVE_TOOL::AlignToGrid): pins, line ends and anchors land on the grid; sheets by their corners.
function alignToGridChanges(ctx, items) {
  const doc = ctx.doc, out = [], touched = [], keep = new Set();
  const snap = (p) => ctx.snap([p[0], p[1]]).map(r4);
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node);
    if (LINE_KINDS.has(it.kind) || it.kind === "bezier") setPts(n, ptsOf(n).map(snap));
    else if (it.kind === "sheet") {
      const [x, y] = atOf(n), s = kid(n, "size"), tl = snap([x, y]), br = snap([x + num(s[1]), y + num(s[2])]);
      setAt(n, tl[0], tl[1]); s[1] = r4(br[0] - tl[0]); s[2] = r4(br[1] - tl[1]);
      for (const pr of kids(n, "property")) shiftAt(pr, r4(tl[0] - x), r4(tl[1] - y));
      for (const pin of kids(n, "pin")) { const [px, py, prot] = atOf(pin), q = snap([px, py]); const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v)); if (prot === 180) setAt(pin, tl[0], clamp(q[1], tl[1], br[1])); else if (prot === 0) setAt(pin, br[0], clamp(q[1], tl[1], br[1])); else if (prot === 90) setAt(pin, clamp(q[0], tl[0], br[0]), tl[1]); else setAt(pin, clamp(q[0], tl[0], br[0]), br[1]); }
    } else {
      const pins = it.kind === "symbol" ? connPoints(doc, it) : [];
      const a = pins[0] || anchorOf(it.kind, n), q = snap(a);
      shiftNode(it.kind, n, r4(q[0] - a[0]), r4(q[1] - a[1]));
    }
    if (JSON.stringify(n) === JSON.stringify(it.node)) continue;
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
function alignToGrid(ctx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) { ctx.toast("Nothing selected"); return false; }
  const changes = alignToGridChanges(ctx, items); if (!changes.length) { ctx.toast("Already on the grid"); return true; }
  ctx.commit(changes, "align to grid"); return true;
}
// Edge alignment (sch_align_tool.cpp): every item's box edge moves to the extreme edge of the selection.
function alignEdgeChanges(ctx, items, which) {
  const doc = ctx.doc, boxes = items.map((it) => it.bbox || rectOf(it)).filter(Boolean); if (boxes.length < 2) return [];
  const target = which === "top" ? Math.min(...boxes.map((b) => b[1])) : which === "bottom" ? Math.max(...boxes.map((b) => b[3])) : which === "left" ? Math.min(...boxes.map((b) => b[0])) : which === "right" ? Math.max(...boxes.map((b) => b[2]))
    : which === "centerX" ? boxes.reduce((t, b) => t + (b[0] + b[2]) / 2, 0) / boxes.length : boxes.reduce((t, b) => t + (b[1] + b[3]) / 2, 0) / boxes.length;
  const out = [], touched = [], keep = new Set();
  for (const it of items) {
    const b = it.bbox || rectOf(it); if (!b || !DRAG_KINDS.has(it.kind)) continue;
    const cur = which === "top" ? b[1] : which === "bottom" ? b[3] : which === "left" ? b[0] : which === "right" ? b[2] : which === "centerX" ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
    const d = ctx.snap ? r4(K.snap(target - cur, ctx.gridPitch || 1.27)) : r4(target - cur); if (!d) continue;
    const n = deep(it.node); shiftNode(it.kind, n, which === "left" || which === "right" || which === "centerX" ? d : 0, which === "top" || which === "bottom" || which === "centerY" ? d : 0);
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
function alignEdges(ctx, which) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (items.length < 2) { ctx.toast("Select two or more items"); return false; }
  const changes = alignEdgeChanges(ctx, items, which); if (!changes.length) return true;
  ctx.commit(changes, "align " + which.toLowerCase()); return true;
}
// Break the wire under the cursor (or the selected one) into two at the grid point.
function breakWireChanges(doc, item, p) {
  if (!isNetLine(item.kind)) return [];
  const pts = ptsOf(item.node); if (pts.length !== 2) return [];
  const q = closestOnSeg(p, pts[0], pts[1]); if (same(q, pts[0]) || same(q, pts[1])) return [];
  const a = deep(item.node); setPts(a, [pts[0], q]);
  const b = addNode(doc, lineNode(item.kind, q, pts[1])); doc.items.delete(b.item.id);
  return [modChange(doc, item, a), b.change];
}
function closestOnSeg(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return [r4(a[0] + t * dx), r4(a[1] + t * dy)]; }
function breakWire(ctx) {
  if (!editable(ctx)) return false;
  const c = cursorOf(ctx); let it = selectedItems(ctx).find((x) => isNetLine(x.kind));
  if (!it) { const hit = hitNonSymbol(ctx.doc, c[0], c[1], Math.max(0.3, 5 * mmPerPx(ctx))); if (hit && isNetLine(hit.kind)) it = hit; }
  if (!it) { ctx.toast("Point at a wire"); return false; }
  const changes = breakWireChanges(ctx.doc, it, snapCursor(ctx)); if (!changes.length) return false;
  ctx.commit(changes, "break wire"); setSelectionIds(ctx, [changes[1].id]); return true;
}

// ---------------------------------------------------------------- symbol fields table (Tools → Symbol Fields Table)
const refCmp = (a, b) => { const ma = str(a).match(/^(.*?)(\d*)$/), mb = str(b).match(/^(.*?)(\d*)$/); return ma[1].localeCompare(mb[1]) || ((+ma[2] || 0) - (+mb[2] || 0)) || str(a).localeCompare(str(b)); };
function fieldsTableRows(doc) {
  const fields = ["Reference", "Value", "Footprint", "Datasheet"], rows = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const values = {};
    for (const p of kids(it.node, "property")) { const nm = str(p[1]); if (nm.startsWith("ki_")) continue; values[nm] = str(p[2]); if (!fields.includes(nm)) fields.push(nm); }
    rows.push({ id: it.id, ref: values.Reference || "", values });
  }
  rows.sort((a, b) => refCmp(a.ref, b.ref));
  return { fields, rows };
}
// edits: [{ id, values: { name: text } }] -> one MODIFIED change per symbol that actually changed
function fieldsTableChanges(doc, edits) {
  const out = [];
  for (const e of edits || []) {
    const it = doc.items.get(e.id); if (!it || it.kind !== "symbol") continue;
    const n = deep(it.node); let changed = false;
    for (const [name, text] of Object.entries(e.values || {})) {
      let p = kids(n, "property").find((q) => str(q[1]) === name);
      if (!p) { if (str(text) === "") continue; p = ["property", name, "", ["at", ...atOf(n).slice(0, 2), 0], ["hide", "yes"], ["effects", fontNode(1.27)]]; insertField(n, p); }
      if (str(p[2]) === str(text)) continue;
      if (name === "Reference") setReference(n, str(text)); else p[2] = str(text);
      changed = true;
    }
    if (changed) out.push(modChange(doc, it, n));
  }
  return out;
}
function openFieldsTable(ctx) {
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null; if (!KD) return false;
  const doc = ctx.doc, table = fieldsTableRows(doc); if (!table.rows.length) { ctx.toast("No symbols on this sheet"); return false; }
  const escapeHtml = (s) => str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let fields = table.fields.slice(), body = null;
  const render = () => {
    const ro = ctx.viewOnly ? " disabled" : "";
    body.innerHTML = `<div style="overflow:auto;max-height:60vh"><table class="kd-table" style="border-collapse:collapse;font:12px var(--mono,ui-monospace,monospace)"><thead><tr>${fields.map((f) => `<th style="text-align:left;padding:2px 6px;border-bottom:1px solid var(--line,#ccc)">${escapeHtml(f)}</th>`).join("")}</tr></thead><tbody>${
      table.rows.map((r) => `<tr>${fields.map((f) => `<td style="padding:1px 3px"><input data-id="${escapeHtml(r.id)}" data-field="${escapeHtml(f)}" value="${escapeHtml(r.values[f] || "")}" style="width:${f === "Reference" ? 60 : 130}px"${ro}></td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="kd-note" style="margin-top:8px">Edit any cell; OK commits every changed symbol as one change.${ctx.viewOnly ? "" : ' <button class="btn sm" id="kd-addfield">Add field…</button>'}</p>`;
    const add = body.querySelector("#kd-addfield");
    if (add) add.addEventListener("click", () => { const name = (typeof window !== "undefined" && window.prompt) ? window.prompt("New field name") : null; if (name && !fields.includes(name)) { collect(); fields.push(name); render(); } });
  };
  const collect = () => { for (const inp of body.querySelectorAll("input[data-id]")) { const r = table.rows.find((x) => x.id === inp.dataset.id); if (r) r.values[inp.dataset.field] = inp.value; } };
  const original = new Map(table.rows.map((r) => [r.id, Object.assign({}, r.values)]));
  KD.open({ title: "Symbol Fields Table", width: Math.min(960, 80 + fields.length * 150), readOnly: !!ctx.viewOnly,
    build(b) { body = b; render(); },
    ok() {
      if (ctx.viewOnly) return; collect();
      const edits = [];
      for (const r of table.rows) { const o = original.get(r.id), values = {}; let any = false; for (const [k, v] of Object.entries(r.values)) if (str(o[k] || "") !== str(v)) { values[k] = v; any = true; } if (any) edits.push({ id: r.id, values }); }
      const changes = fieldsTableChanges(doc, edits); if (changes.length) ctx.commit(changes, "symbol fields");
    } });
  return true;
}

// ---------------------------------------------------------------- unfold bus (SCH_LINE_WIRE_BUS_TOOL::UnfoldBus)
// NET_SETTINGS::ParseBusVector / ParseBusGroup: "DATA[0..3]" -> DATA0..DATA3 (a +-PN suffix rides along),
// "{A B C}" -> A B C, "NAME{A B}" -> NAME.A NAME.B; vectors nest inside groups.
function busMembers(text) {
  text = str(text).trim();
  const v = text.match(/^([^\s\[\]{}]*)\[(\d+)\.\.(\d+)\]([+\-PN]*)$/);
  if (v) { let a = +v[2], b = +v[3]; if (a === b) return null; if (a > b) { const t = a; a = b; b = t; } const members = []; for (let i = a; i <= b; i++) members.push(v[1] + i + v[4]); return { name: v[1], members, vector: true }; }
  const g = text.match(/^([^\s\[\]{}]*)\{(.*)\}$/);
  if (g) {
    const prefix = g[1] ? g[1] + "." : "", members = [];
    for (const m of g[2].split(/[\s,]+/).filter(Boolean)) { const sub = busMembers(m); if (sub && sub.vector) members.push(...sub.members.map((x) => prefix + x)); else members.push(prefix + m); }
    return members.length ? { name: g[1], members, group: true } : null;
  }
  return null;
}
function busLabelsOf(doc, bus) {
  const out = [];
  for (const id of netItems(doc, bus)) { const it = doc.items.get(id); if (it && (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label")) { const m = busMembers(it.node[1]); if (m) out.push(Object.assign({ label: it }, m)); } }
  return out;
}
function unfoldMembers(doc, bus) { const seen = new Set(), out = []; for (const b of busLabelsOf(doc, bus)) for (const m of b.members) if (!seen.has(m)) { seen.add(m); out.push(m); } return out; }
function nearestOnLine(item, p) { let best = null, bd = Infinity; for (const [a, b] of segs(item)) { const q = closestOnSeg(p, a, b), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } } return best; }
// Bus entry at the point, the member label on its far end (spun away from the bus like
// SCH_SCREEN::GetLabelOrientationForPoint), then the wire tool takes over from that end.
function unfoldBus(ctx, bus, member, at) {
  const doc = ctx.doc, c = at || cursorOf(ctx), snapped = ctx.snap([c[0], c[1]]).map(r4);
  const p = nearestOnLine(bus, snapped); if (!p) return null;
  const seg = segs(bus)[0], horizontal = Math.abs(seg[0][1] - seg[1][1]) < 1e-6, vertical = Math.abs(seg[0][0] - seg[1][0]) < 1e-6;
  const sx = c[0] < p[0] ? -1 : 1, sy = c[1] < p[1] ? -1 : 1;
  const dx = 2.54 * sx, dy = 2.54 * sy, end = [r4(p[0] + dx), r4(p[1] + dy)];
  let rot = 0; if (vertical) rot = end[0] < p[0] ? 180 : 0; else if (horizontal) rot = end[1] < p[1] ? 90 : 270;
  const entry = addNode(doc, busEntryNode(p, r4(dx), r4(dy))), label = addNode(doc, labelNode("label", member, end, rot));
  ctx.commit([entry.change, label.change], "unfold bus");
  ctx.setTool("wire");
  startWire(ctx, "wire", end);
  S.unfold = { labelId: label.item.id, entryId: entry.item.id };
  return { entry: entry.item, label: label.item, start: end };
}
function unfoldAction(ctx, opts) {
  if (!editable(ctx)) return false;
  opts = opts || {};
  const doc = ctx.doc; let bus = opts.bus ? (typeof opts.bus === "string" ? doc.items.get(opts.bus) : opts.bus) : selectedItems(ctx).find((it) => it.kind === "bus");
  if (!bus) { const c = cursorOf(ctx), hit = hitNonSymbol(doc, c[0], c[1], Math.max(0.6, 8 * mmPerPx(ctx))); if (hit && hit.kind === "bus") bus = hit; }
  if (!bus) { ctx.toast("Select a bus first"); return false; }
  const members = unfoldMembers(doc, bus); if (!members.length) { ctx.toast("No bus label names this bus's members"); return false; }
  const go = (m) => { if (m && members.includes(m)) unfoldBus(ctx, bus, m, opts.at); };
  if (opts.member) { go(opts.member); return true; }
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (!KD) { go(members[0]); return true; }
  KD.open({ title: "Unfold from Bus", width: 320,
    build(body) { body.innerHTML = `<div class="kv"><label>Net</label><select id="kd-member">${members.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">${m.replace(/</g, "&lt;")}</option>`).join("")}</select></div>`; },
    ok() { go(document.getElementById("kd-member").value); } });
  return true;
}

// ---------------------------------------------------------------- the actions map (ids stable: app.js binds menus and keys to them)
function act(id, label, key, run) { return { id, label, key, run }; }
const ACTION_LIST = [
  act("cut", "Cut", "Ctrl+X", (ctx) => cutSelection(ctx)),
  act("copy", "Copy", "Ctrl+C", (ctx) => copySelection(ctx)),
  act("copyAsText", "Copy as Text", "Ctrl+Shift+C", (ctx) => copyAsText(ctx)),
  act("paste", "Paste", "Ctrl+V", (ctx, opts) => pasteSelection(ctx, opts)),
  act("pasteSpecial", "Paste Special...", "Ctrl+Shift+V", (ctx, opts) => pasteSelection(ctx, Object.assign({ keepAnnotations: true }, opts || {}))),
  act("duplicate", "Duplicate", "Ctrl+D", (ctx) => duplicateSelection(ctx)),
  act("unselectAll", "Unselect All", "Ctrl+Shift+A", (ctx) => unselectAll(ctx)),
  act("selectConnection", "Select/Expand Connection", "Ctrl+4", (ctx) => selectConnection(ctx)),
  act("selectNode", "Select Node", "Alt+3", (ctx) => selectNode(ctx)),
  act("nextNetItem", "Next Net Item", "Tab", (ctx) => stepNetItem(ctx, 1)),
  act("previousNetItem", "Previous Net Item", "Shift+Tab", (ctx) => stepNetItem(ctx, -1)),
  act("repeatLast", "Repeat Last Item", "Insert", (ctx) => repeatLast(ctx)),
  act("increment", "Increment", "", (ctx) => incrementSelection(ctx, 1)),
  act("decrement", "Decrement", "", (ctx) => incrementSelection(ctx, -1)),
  act("toLabel", "Change to Label", "", (ctx) => convertSelection(ctx, "label")),
  act("toGLabel", "Change to Global Label", "", (ctx) => convertSelection(ctx, "global_label")),
  act("toHLabel", "Change to Hierarchical Label", "", (ctx) => convertSelection(ctx, "hierarchical_label")),
  act("toDLabel", "Change to Directive Label", "", (ctx) => convertSelection(ctx, "netclass_flag")),
  act("toText", "Change to Text", "", (ctx) => convertSelection(ctx, "text")),
  act("toTextBox", "Change to Text Box", "", (ctx) => convertSelection(ctx, "text_box")),
  act("autoplace", "Autoplace Fields", "O", (ctx, opts) => autoplaceSelection(ctx, opts)),
  act("editReference", "Edit Reference Designator...", "U", (ctx) => editFieldPrompt(ctx, "Reference", "Reference", false)),
  act("editValue", "Edit Value...", "V", (ctx) => editFieldPrompt(ctx, "Value", "Value", false)),
  act("editFootprint", "Edit Footprint...", "F", (ctx) => editFieldPrompt(ctx, "Footprint", "Footprint", false)),
  act("setDNP", "Do not Populate", "", (ctx) => toggleSymbolFlag(ctx, "setDNP")),
  act("setExcludeFromBOM", "Exclude from Bill of Materials", "", (ctx) => toggleSymbolFlag(ctx, "setExcludeFromBOM")),
  act("setExcludeFromSim", "Exclude from Simulation", "", (ctx) => toggleSymbolFlag(ctx, "setExcludeFromSim")),
  act("setExcludeFromBoard", "Exclude from Board", "", (ctx) => toggleSymbolFlag(ctx, "setExcludeFromBoard")),
  act("nextUnit", "Next Symbol Unit", "", (ctx) => stepUnit(ctx, 1)),
  act("previousUnit", "Previous Symbol Unit", "", (ctx) => stepUnit(ctx, -1)),
  act("placeNextSymbolUnit", "Place Next Symbol Unit", "", (ctx) => placeNextUnit(ctx)),
  act("cycleBodyStyle", "Cycle Body Style", "", (ctx) => cycleBodyStyle(ctx)),
  act("showDatasheet", "Show Datasheet", "D", (ctx) => showDatasheet(ctx)),
  act("annotate", "Annotate Schematic...", "", (ctx, opts) => annotate(ctx, opts)),
  act("clearAnnotation", "Clear Annotation", "", (ctx, opts) => clearAnnotation(ctx, opts)),
  act("toggleAnnotateAuto", "Annotate Automatically", "", (ctx) => { S.annotateAuto = !S.annotateAuto; if (ctx && ctx.toast) ctx.toast("Automatic annotation " + (S.annotateAuto ? "on" : "off")); return true; }),
  act("runERC", "Electrical Rules Checker", "", (ctx, opts) => runERC(ctx, opts)),
  act("clearMarkers", "Clear ERC Markers", "", (ctx) => { S.markers = []; if (typeof ctx.setMarkers === "function") ctx.setMarkers([]); ctx.requestRender(); return true; }),
  act("swap", "Swap", "Alt+S", (ctx) => swapSelection(ctx)),
  act("alignToGrid", "Align Items to Grid", "", (ctx) => alignToGrid(ctx)),
  act("alignTop", "Align to Top", "", (ctx) => alignEdges(ctx, "top")),
  act("alignBottom", "Align to Bottom", "", (ctx) => alignEdges(ctx, "bottom")),
  act("alignLeft", "Align to Left", "", (ctx) => alignEdges(ctx, "left")),
  act("alignRight", "Align to Right", "", (ctx) => alignEdges(ctx, "right")),
  act("alignCenterX", "Align to Horizontal Center", "", (ctx) => alignEdges(ctx, "centerX")),
  act("alignCenterY", "Align to Vertical Center", "", (ctx) => alignEdges(ctx, "centerY")),
  act("moveExactly", "Move Exactly...", "", (ctx, opts) => moveExactly(ctx, opts)),
  act("rotateSelection", "Rotate Counterclockwise", "R", (ctx) => orientSelected(ctx, "ccw")),
  act("rotateSelectionCW", "Rotate Clockwise", "Shift+R", (ctx) => orientSelected(ctx, "cw")),
  act("mirrorSelectionX", "Mirror Horizontally", "X", (ctx) => orientSelected(ctx, "y")),
  act("mirrorSelectionY", "Mirror Vertically", "Y", (ctx) => orientSelected(ctx, "x")),
  act("breakWire", "Break", "", (ctx) => breakWire(ctx)),
  act("slice", "Slice", "", (ctx) => breakWire(ctx)),
  act("fieldsTable", "Symbol Fields Table...", "", (ctx) => openFieldsTable(ctx)),
  act("unfoldBus", "Unfold from Bus", "C", (ctx, opts) => unfoldAction(ctx, opts)),
  act("syncSheetPins", "Sync Sheet Pins...", "", (ctx) => syncSheetPins(ctx)),
  act("cleanupSheetPins", "Cleanup Sheet Pins", "", (ctx) => cleanupSheetPins(ctx)),
  act("highlightNet", "Highlight Net", "`", (ctx) => { ctx.setTool("highlight"); return true; }),
  act("clearHighlight", "Clear Net Highlighting", "~", (ctx) => { setHighlight(ctx, null); return true; }),
];
const actions = {}; for (const a of ACTION_LIST) actions[a.id] = a;
function runAction(id, ctx, opts) { const a = actions[id]; if (!a) return false; S.ctx = ctx; installDom(ctx); try { return !!a.run(ctx, opts); } catch (e) { console.warn(e); if (ctx && ctx.toast) ctx.toast(a.label + " failed: " + (e && e.message)); return false; } }

root.CollabTools = root.CollabTools || {};
root.CollabTools.sch = {
  id: "sch", tools: TOOLS.map((t) => ({ id: t.id, label: t.label, key: t.key, icon: t.icon, cursor: t.cursor })),
  onActivate, onPointerDown, onPointerMove, onPointerUp, onKey, drawOverlay, onDocChanged,
  // for tests and the props panel
  state: S, select(id) { S.sel = id || null; }, setPrompt(fn) { promptImpl = fn; }, setImagePicker(fn) { imagePickerImpl = fn; },
  // connected drag engine, shared with app.js's select tool (symbols and sheets; an array drags a multi-selection)
  beginDrag, moveDrag, endDrag, cancelDrag, setDragMode, setLineMode, cycleLineMode, modeText,
  // REMOVED changes (plus junction cleanup) for one item or a multi-selection; the net of an item on this sheet
  deleteChanges, netItems,
  // KiCad's non-tool commands: { id: { id, label, key, run(ctx, opts) -> handled } }; app.js binds menus and keys to them
  actions, runAction, markers() { return S.markers; },
  // clipboard text in the desktop's format and its parser, ERC and annotation as pure functions over a doc
  clipboardText, parseClipboard, ercCheck, annotateChanges, clearAnnotationChanges, fieldsTableRows, fieldsTableChanges, busMembers,
  _: { selectedItems, setSelectionIds, cursorOf, pasteChanges, pasteText, cutSelection, copySelection, duplicateSelection, copyAsText, incrementText, repeatLast, rememberPlaced,
    convertNode, convertSelection, validNetname, symbolPins, bodyBox, fieldExtent, autoplaceNode, autoplaceSelection, splitRef, setReference, assignPastedRef, annotate, clearAnnotation,
    ercNets, runERC, subsheetDoc, syncSheetPins, cleanupSheetPins, transformNode, transformChanges, transformSelected, selectionCentre, halfGrid, swapNodes, swapChanges, swapSelection,
    alignToGridChanges, alignToGrid, alignEdgeChanges, alignEdges, moveExactChanges, moveExactly, rotationCentre, breakWireChanges, breakWire, openFieldsTable, unfoldMembers, busLabelsOf, unfoldBus, unfoldAction,
    selectConnection, selectNode, stepNetItem, incrementSelection, editFieldPrompt, toggleSymbolFlag, stepUnit, cycleBodyStyle, placeNextUnit, libUnits, showDatasheet, CLIP, clipWrite, clipRead,
    lineNode, junctionNode, noConnectNode, busEntryNode, labelNode, symbolNode, orientSymbol, rotateNode, mirrorNode, cloneNode, shiftNode,
    tFrom, orientOf, mul, RCCW, MX, MY, needsJunction, junctionAt, pinsAt, snapConn, legPoints, simplify, hitNonSymbol, textRect, pickNonSymbol,
    beginDrag, moveDrag, endDrag, placeText, bendPath, connPoints, makeAnchor, ridersOf, cleanupAt, mergeAt, startCarry, placeCarry, dropCarry, finishWire, deleteSelected, duplicateSelected, orientSelected, modChange,
    // graphic shapes, directive labels, power symbols and the delete tool
    rectangleNode, circleNode, arcNode, polylineNode, textBoxNode, classLabelNode, placeClassLabel, isPowerSymbol, powerSymbols, pickSymbol,
    drawClick, finishDraw, cancelDraw, deleteChanges, deleteAt, pickAny, geomDist, anchorOf, DELETE_CURSOR,
    // sheets, sheet pins, tables, curves, polygons, rule areas, images and net highlighting
    sheetNode, sheetPinNode, tableNode, bezierNode, polygonNode, ruleAreaNode, imageNode, imageData, imageSize, bytesToBase64, base64ToBytes,
    placeSheet, ensureSheetDoc, sheetInstance, sheetPathHere, nextPage, emptySheetDoc, relPath, currentDoc, sheetEdgeAt, sheetPinPoint, sheetPinClick, placeSheetPin,
    openImagePicker, netItems, terminalsOf, pickNet, highlightClick, setHighlight, typeNameFor, ruleAreaId, itemSexpr, SHEET_NAME_OFF, SHEET_FILE_OFF },
};
})(typeof window !== "undefined" ? window : globalThis);
