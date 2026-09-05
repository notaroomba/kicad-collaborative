// sch-tools.js — schematic editing tools for the web editor: wires and buses with
// KiCad's 90° routing and automatic junctions, bus entries, no-connects, labels,
// text, symbol and power-symbol placement, directive labels, graphic shapes
// (rectangle, circle, arc, lines, text box), rotate / mirror / duplicate,
// wire-segment drag, KiCad's interactive delete tool and delete of the
// non-symbol items app.js does not select itself.
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
const DRAW_TOOLS = new Set(["rect", "circle", "arc", "lines", "textbox"]);
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
];
const toolOf = (id) => TOOLS.find((t) => t.id === id) || null;

// Module state: one in-progress operation at a time, plus a selection of our own
// for the items app.js's select tool ignores (everything but symbols).
const S = { ctx: null, tool: "select", wire: null, carry: null, drag: null, pending: null, sel: null, hover: null,
  cursor: null, cursorClient: null, prompt: null, picker: null, dom: false, draw: null };

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

// MODIFIED change from a cloned node: the doc item stays untouched until commit applies it,
// which is what lets app.js record the pre-edit item as the undo step.
function modChange(doc, item, node) { return { id: item.id, kind: "MODIFIED", typeName: K.typeNameOf(item), sexpr: K.serializeItem(doc, { kind: item.kind, node }) }; }
function addNode(doc, node) { const item = K.createItem(doc, node); return { item, change: K.addChange(doc, item) }; }
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
// Directive label (netclass flag) with its Netclass field where SCH_DIRECTIVE_LABEL::AutoplaceFields puts it
// for the spin style of the angle: symbol size 20 mil + text offset (0.15 × size) beside the pin-length flag.
const FLAG_LENGTH = 2.54, FLAG_SYMBOL = 0.508, FLAG_MARGIN = r4(0.15 * 1.27);
function classLabelNode(name, p, rot) {
  rot = ((Math.round(rot || 0) % 360) + 360) % 360;
  const off = rot === 180 ? [FLAG_SYMBOL + FLAG_MARGIN, FLAG_LENGTH] : rot === 90 ? [-FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)]
    : rot === 270 ? [FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)] : [FLAG_SYMBOL + FLAG_MARGIN, -FLAG_LENGTH];
  const fieldRot = rot === 90 || rot === 270 ? 90 : 0;
  return ["netclass_flag", "", ["length", FLAG_LENGTH], ["shape", "round"], ["at", r4(p[0]), r4(p[1]), rot], ["fields_autoplaced", "yes"],
    ["effects", fontNode(1.27), ["justify", "left", "bottom"]], ["uuid", K.newUuid()],
    ["property", "Netclass", name, ["at", r4(p[0] + off[0]), r4(p[1] + off[1]), fieldRot], ["effects", fontNode(1.27), ["justify", "left", "bottom"]]]];
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
  if (LINE_KINDS.has(kind)) { const p = ptsOf(node); return p[0] || [0, 0]; }
  if (SHAPE_KINDS.has(kind)) { const k = kid(node, SHAPE_POINTS[kind][0]); return k ? [num(k[1]), num(k[2])] : [0, 0]; }
  const [x, y] = atOf(node); return [x, y];
}
function shiftNode(kind, node, dx, dy) {
  if (!dx && !dy) return;
  if (LINE_KINDS.has(kind)) { setPts(node, ptsOf(node).map(([x, y]) => [x + dx, y + dy])); return; }
  if (SHAPE_KINDS.has(kind)) { for (const key of SHAPE_POINTS[kind]) { const k = kid(node, key); if (k) { k[1] = r4(num(k[1]) + dx); k[2] = r4(num(k[2]) + dy); } } return; }
  const [x, y] = atOf(node); setAt(node, r4(x + dx), r4(y + dy));
  for (const pr of kids(node, "property")) { const a = kid(pr, "at"); if (a) { a[1] = r4(num(a[1]) + dx); a[2] = r4(num(a[2]) + dy); } }
  if (kind === "sheet") for (const pin of kids(node, "pin")) { const a = kid(pin, "at"); if (a) { a[1] = r4(num(a[1]) + dx); a[2] = r4(num(a[2]) + dy); } }
}
// A copy with a fresh identity; the desktop re-annotates and rebuilds instance data.
function cloneNode(item) {
  const node = deep(item.node);
  replaceKid(node, ["uuid", K.newUuid()]);
  for (const pin of kids(node, "pin")) replaceKid(pin, ["uuid", K.newUuid()]);
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
  if (pts.length < 2) { ctx.requestRender(); return; }
  const doc = ctx.doc, changes = [];
  for (let i = 1; i < pts.length; i++) changes.push(addNode(doc, lineNode(w.kind, pts[i - 1], pts[i])).change);
  changes.push(...junctionChanges(doc, w.pts, w.kind));
  ctx.commit(changes, w.kind);
  ctx.requestRender();
}

// ---------------------------------------------------------------- carried item (ghost that follows the cursor)
function startCarry(ctx, kind, node, mm) {
  S.carry = { kind, node, item: null, pos: null };
  placeCarry(ctx, mm || S.cursor || [ctx.doc.page[0] / 2, ctx.doc.page[1] / 2]);
}
function placeCarry(ctx, mm) {
  const c = S.carry; if (!c) return;
  const gridOnly = c.kind === "symbol" || TEXT_KINDS.has(c.kind) || SHAPE_KINDS.has(c.kind) || c.kind === "text_box" || c.kind === "netclass_flag";
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
  if (c.kind === "symbol") ctx.setSelected({ id: item.id }); else { S.sel = item.id; ctx.setSelected(null); }
  ctx.requestRender();
  return item;
}
// Create a label/text straight away at p (the inline prompt's Enter).
function placeText(ctx, kind, text, p, rot) {
  const doc = ctx.doc; const { item, change } = addNode(doc, labelNode(kind, text, p, rot || 0));
  ctx.commit([change], kind.replace("_", " "));
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
    else if (SHAPE_KINDS.has(it.kind)) { d = Infinity; for (const g of it.geom) if (!g.noStroke) d = Math.min(d, geomDist(g, x, y)); d += 0.01; }
    else if (it.kind === "text_box" || it.kind === "netclass_flag" || it.kind === "directive_label") d = boxDist(it.bbox, x, y);
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
const DRAG_KINDS = new Set(["symbol", "sheet", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text"]);
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

function beginDrag(ctx, item, mm, byPointer) {
  const doc = ctx.doc; if (!item || !DRAG_KINDS.has(item.kind)) return null;
  if (S.drag) endDrag(ctx, false);
  const anchor0 = anchorOf(item.kind, item.node);
  const d = { item, kind: item.kind, orig: deep(item.node), anchor0, grab: [mm[0] - anchor0[0], mm[1] - anchor0[1]], last: [0, 0], applied: [0, 0],
    moved: false, byPointer: !!byPointer, riders: ridersOf(doc, item), anchors: [], preview: [] };
  const moving = new Set([item.id, ...d.riders.map((r) => r.item.id)]);
  for (const p of connPoints(doc, item)) d.anchors.push(makeAnchor(doc, item, p, moving));
  for (const r of d.riders) {
    if (r.item.kind === "junction") d.anchors.push(makeAnchor(doc, r.item, r.orig, moving));
    else if (r.item.kind === "bus_entry") for (const p of connPoints(doc, r.item)) d.anchors.push(makeAnchor(doc, r.item, p, moving));
  }
  const seenEnd = new Set();                                // a line end belongs to one anchor only
  for (const a of d.anchors) { a.ends = a.ends.filter((e) => { const k = e.item.id + ":" + e.index; if (seenEnd.has(k)) return false; seenEnd.add(k); return true; }); for (const f of a.followers) moving.add(f.item.id); }
  S.drag = d; announceModes(ctx); return d;
}
// Live preview: the moved items and stretched ends are edited in place (restored by endDrag),
// stub wires are drawn from d.preview by the overlay.
function applyDrag(doc, d, dx, dy) {
  if (!dx && !dy) { restoreNode(d.item.node, d.orig); }
  else shiftNode(d.kind, d.item.node, r4(dx - d.applied[0]), r4(dy - d.applied[1]));
  d.applied = [dx, dy]; K.replaceChange(doc, d.item);
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
  { const n = deep(d.item.node); shiftNode(d.kind, n, dx, dy); put(modChange(doc, d.item, n)); }
  for (const r of d.riders) { const n = deep(r.item.node); shiftNode(r.item.kind, n, dx, dy); put(modChange(doc, r.item, n)); }
  for (const p of connPoints(doc, d.item)) touched.push(p, [r4(p[0] + dx), r4(p[1] + dy)]);
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
  const keep = new Set([d.item.id, ...d.riders.map((r) => r.item.id)]);
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
function orientSelected(ctx, op) {
  const c = S.carry;
  if (c) { const ok = op === "x" || op === "y" ? mirrorNode(c.kind, c.node, op) : rotateNode(c.kind, c.node, op === "cw"); if (ok !== false) refreshCarry(ctx); return true; }
  const it = selectedItem(ctx); if (!it) return false;
  const node = deep(it.node);
  const ok = op === "x" || op === "y" ? mirrorNode(it.kind, node, op) : rotateNode(it.kind, node, op === "cw");
  if (ok === false) return false;
  ctx.commit([modChange(ctx.doc, it, node)], op === "x" || op === "y" ? "mirror" : "rotate");
  return true;
}
// Removal of one item plus the junctions that only existed for it: a line's own points, or the
// connection points (pins, ends, anchors) of anything else — SCH_EDIT_TOOL::DoDelete's junction pass.
function deleteChanges(doc, it) {
  const changes = [K.removeChange(it)];
  const line = LINE_KINDS.has(it.kind), pts = line ? ptsOf(it.node) : connPoints(doc, it);
  if (!pts.length) return changes;
  doc.items.delete(it.id);
  try {
    for (const p of pts) {
      const j = junctionAt(doc, p[0], p[1]); if (!j || changes.some((c) => c.id === j.id)) continue;
      const needed = line ? needsJunction(doc, p[0], p[1], it.kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (!needed) changes.push(K.removeChange(j));
    }
  } finally { doc.items.set(it.id, it); }
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
    else if (S.carry) cancelCarry(ctx); else if (S.drag) endDrag(ctx, false); else took = false;
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
  S.sel = item.id; ctx.setSelected(null); ctx.requestRender();
  return item;
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
  if (shape === "lines") { if (same(p, last)) finishDraw(ctx); else { d.pts.push(p); ctx.requestRender(); } return; }
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
  if (S.drag) {
    const it = S.drag.item; if (it) outline(c, it, CLR.sel, px, 2);
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
    if (d.shape === "rect" || d.shape === "textbox") c.strokeRect(Math.min(p0[0], cur[0]), Math.min(p0[1], cur[1]), Math.abs(cur[0] - p0[0]), Math.abs(cur[1] - p0[1]));
    else if (d.shape === "circle") { c.beginPath(); c.arc(p0[0], p0[1], Math.hypot(cur[0] - p0[0], cur[1] - p0[1]), 0, Math.PI * 2); c.stroke(); }
    else if (d.shape === "arc") {
      const a = d.pts.length > 1 ? K.arcFrom3(p0, cur, d.pts[1]) : null;
      c.beginPath();
      if (a) c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); else { c.moveTo(p0[0], p0[1]); c.lineTo(cur[0], cur[1]); }
      c.stroke();
    } else { c.beginPath(); c.moveTo(p0[0], p0[1]); for (let i = 1; i < d.pts.length; i++) c.lineTo(d.pts[i][0], d.pts[i][1]); c.lineTo(cur[0], cur[1]); c.stroke(); }
    c.fillStyle = CLR.sel; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h);
    c.restore();
  }
  if (S.carry && S.carry.item) {
    paint(c, S.carry.item, 0.65, px);
    const b = S.carry.item.bbox; if (b) { c.save(); c.strokeStyle = CLR.hover; c.lineWidth = px; c.setLineDash([3 * px, 3 * px]); c.strokeRect(b[0] - 0.3, b[1] - 0.3, b[2] - b[0] + 0.6, b[3] - b[1] + 0.6); c.restore(); }
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
  if (toolId !== "place" && toolId !== "power") S.carry = null;   // a carried duplicate rides into the place tool
  if (toolId === "junction") startCarry(ctx, "junction", junctionNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "noconnect") startCarry(ctx, "no_connect", noConnectNode(S.cursor || [0, 0]), S.cursor);
  else if (toolId === "busentry") startCarry(ctx, "bus_entry", busEntryNode(S.cursor || [0, 0], 2.54, 2.54), S.cursor);
  else if (toolId === "place" && !S.carry) openPicker(ctx, S.cursorClient);
  else if (toolId === "power" && !S.carry) openPowerPicker(ctx, S.cursorClient);
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
  if (DRAW_TOOLS.has(t.id)) { if (S.draw && S.draw.await) return true; drawClick(ctx, t.id, drawPoint(ctx, mm)); return true; }
  if (t.id === "delete") { deleteAt(ctx, mm); return true; }   // an empty click is ours too: the tool stays armed
  return false;
}
function onPointerMove(ev, mm, ctx) {
  S.ctx = ctx; S.cursor = mm; if (ev && ev.clientX !== undefined) S.cursorClient = [ev.clientX, ev.clientY];
  if (S.wire) { const p = snapConn(ctx, mm, S.wire.kind); if (!same(S.wire.cur, p)) { S.wire.cur = p; ctx.requestRender(); } return; }
  if (S.carry) { placeCarry(ctx, mm); return; }
  if (S.draw && !S.draw.await) { const p = drawPoint(ctx, mm); if (!same(S.draw.cur, p)) { S.draw.cur = p; ctx.requestRender(); } return; }
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
    if (key === "Enter") { if (S.draw.shape === "lines" && S.draw.pts.length >= 2) finishDraw(ctx); else cancelDraw(ctx); return true; }
    if (key === "Backspace") { undoDrawPoint(ctx); return true; }
    if (key === "Escape") { cancelDraw(ctx); return true; }
  }
  switch (key) {
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
  case "x": case "X": return orientSelected(ctx, "x");
  case "y": case "Y": return orientSelected(ctx, "y");
  case "d": case "D": return duplicateSelected(ctx);
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
  S.wire = null; S.carry = null; S.drag = null; S.pending = null; S.sel = null; S.hover = null; S.draw = null;
  closePrompt(); closePicker(); announceModes(ctx);
  S.tool = curTool();
}

root.CollabTools = root.CollabTools || {};
root.CollabTools.sch = {
  id: "sch", tools: TOOLS.map((t) => ({ id: t.id, label: t.label, key: t.key, icon: t.icon, cursor: t.cursor })),
  onActivate, onPointerDown, onPointerMove, onPointerUp, onKey, drawOverlay, onDocChanged,
  // for tests and the props panel
  state: S, select(id) { S.sel = id || null; }, setPrompt(fn) { promptImpl = fn; },
  // connected drag engine, shared with app.js's select tool (symbols and sheets)
  beginDrag, moveDrag, endDrag, cancelDrag, setDragMode, setLineMode, cycleLineMode, modeText,
  _: { lineNode, junctionNode, noConnectNode, busEntryNode, labelNode, symbolNode, orientSymbol, rotateNode, mirrorNode, cloneNode, shiftNode,
    tFrom, orientOf, mul, RCCW, MX, MY, needsJunction, junctionAt, pinsAt, snapConn, legPoints, simplify, hitNonSymbol, textRect, pickNonSymbol,
    beginDrag, moveDrag, endDrag, placeText, bendPath, connPoints, makeAnchor, ridersOf, cleanupAt, mergeAt, startCarry, placeCarry, dropCarry, finishWire, deleteSelected, duplicateSelected, orientSelected, modChange,
    // graphic shapes, directive labels, power symbols and the delete tool
    rectangleNode, circleNode, arcNode, polylineNode, textBoxNode, classLabelNode, placeClassLabel, isPowerSymbol, powerSymbols, pickSymbol,
    drawClick, finishDraw, cancelDraw, deleteChanges, deleteAt, pickAny, geomDist, anchorOf, DELETE_CURSOR },
};
})(typeof window !== "undefined" ? window : globalThis);
