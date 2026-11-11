// node server/scripts/landing-demo/gen.cjs
//
// Writes the home page's demo design: a USB-C powered 555 LED blinker as a real KiCad schematic
// and board (server/web/landing/demo/blinker.kicad_sch / .kicad_pcb) plus blinker.json, the
// order the page draws things in.  The symbols and footprints in lib/ are KiCad's own library
// files (kicad-symbols / kicad-footprints, CC-BY-SA 4.0 with the design exception), copied
// unchanged; this script only instantiates them, wires them and routes the board.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
require(path.join(__dirname, "..", "..", "static", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const LIB = path.join(__dirname, "lib"), OUT = path.join(__dirname, "..", "..", "web", "landing", "demo");

const uuid = (name) => { const h = crypto.createHash("sha1").update("blinker/" + name).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/** KiCad's file layout: one token per line, tab indented, short lists inline. */
function pretty(node, depth = 0) {
  const mask = K.quotedMask(node), ind = "\t".repeat(depth);
  const atom = (c, j) => typeof c === "number" ? String(r3(c)) : (j < 30 && (mask >> j) & 1) ? q(c) : String(c);
  const flat = node.every((c) => !Array.isArray(c));
  const inline = new Set(["xy", "at", "size", "start", "end", "mid", "center", "offset", "drill", "layers", "color", "font", "justify", "stroke", "width", "type", "net", "pts", "uuid", "layer", "thickness", "hide", "fill", "effects", "radius", "rect_delta", "tstamp", "page", "reference", "unit", "path"]);
  if (flat || (inline.has(node[0]) && JSON.stringify(node).length < 110)) return ind + flatText(node);
  let out = ind + "(" + atom(node[0], 0), j = 1;
  for (; j < node.length && !Array.isArray(node[j]); j++) out += " " + atom(node[j], j);
  out += "\n";
  for (; j < node.length; j++) out += (Array.isArray(node[j]) ? pretty(node[j], depth + 1) : "\t".repeat(depth + 1) + atom(node[j], j)) + "\n";
  return out + ind + ")";
}
function flatText(node) {
  const mask = K.quotedMask(node);
  return "(" + node.map((c, j) => Array.isArray(c) ? flatText(c) : typeof c === "number" ? String(r3(c)) : (j < 30 && (mask >> j) & 1) ? q(c) : String(c)).join(" ") + ")";
}
const P = (text) => K.parse(text);
const kid = K.kid, kids = K.kids;

// ================================================================== schematic

const ROOT = uuid("sheet");
const SYM_LIBS = { "Device:R": "R", "Device:C": "C", "Device:LED": "LED", "power:GND": "GND", "power:+5V": "+5V", "Timer:NE555D": "NE555D", "Connector:USB_C_Receptacle_PowerOnly_6P": "USB_C_Receptacle_PowerOnly_6P" };
const libSyms = {};
for (const [id, file] of Object.entries(SYM_LIBS)) {
  const lib = P(fs.readFileSync(path.join(LIB, file + ".kicad_sym"), "utf8"));
  const s = kids(lib, "symbol")[0]; s[1] = id; libSyms[id] = s;
}
const FOOTPRINTS = {
  R: "Resistor_SMD:R_0603_1608Metric", C6: "Capacitor_SMD:C_0603_1608Metric", C8: "Capacitor_SMD:C_0805_2012Metric", LED: "LED_SMD:LED_0805_2012Metric",
  U: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", J: "Connector_USB:USB_C_Receptacle_GCT_USB4125-xx-x_6P_TopMnt_Horizontal",
};

// ref, lib, value, footprint, x, y, rot, reference field [dx, dy, angle, justify], value field
const SYMS = [
  ["J1", "Connector:USB_C_Receptacle_PowerOnly_6P", "USB-C", FOOTPRINTS.J, 30.48, 60.96, 0, [-10.16, -17.78, 0, "left"], [-10.16, -15.24, 0, "left"]],
  ["R1", "Device:R", "5k1", FOOTPRINTS.R, 60.96, 72.39, 0, [2.54, -1.27, 0, "left"], [2.54, 1.27, 0, "left"]],
  ["R2", "Device:R", "5k1", FOOTPRINTS.R, 53.34, 74.93, 0, [-2.54, -1.27, 0, "right"], [-2.54, 1.27, 0, "right"]],
  ["C1", "Device:C", "10u", FOOTPRINTS.C8, 60.96, 49.53, 0, [3.81, -1.27, 0, "left"], [3.81, 1.27, 0, "left"]],
  ["C2", "Device:C", "100n", FOOTPRINTS.C6, 71.12, 49.53, 0, [3.81, -1.27, 0, "left"], [3.81, 1.27, 0, "left"]],
  ["R3", "Device:R", "10k", FOOTPRINTS.R, 86.36, 50.8, 0, [-2.54, -1.27, 0, "right"], [-2.54, 1.27, 0, "right"]],
  ["R4", "Device:R", "47k", FOOTPRINTS.R, 86.36, 62.23, 0, [-2.54, -1.27, 0, "right"], [-2.54, 1.27, 0, "right"]],
  ["C3", "Device:C", "10u", FOOTPRINTS.C8, 86.36, 76.2, 0, [-3.81, -1.27, 0, "right"], [-3.81, 1.27, 0, "right"]],
  ["U1", "Timer:NE555D", "NE555D", FOOTPRINTS.U, 114.3, 66.04, 0, [-7.62, -9.525, 0, "left"], [3.81, 9.525, 0, "left"]],
  ["C4", "Device:C", "10n", FOOTPRINTS.C6, 129.54, 49.53, 0, [3.81, -1.27, 0, "left"], [3.81, 1.27, 0, "left"]],
  ["R5", "Device:R", "330", FOOTPRINTS.R, 138.43, 66.04, 90, [0, -2.54, 90, ""], [0, 2.54, 90, ""]],
  ["D1", "Device:LED", "LED", FOOTPRINTS.LED, 147.32, 72.39, 90, [5.08, -1.27, 90, "left"], [5.08, 1.27, 90, "left"]],
];
const POWER = [   // id, lib, x, y
  ["P5a", "power:+5V", 50.8, 40.64], ["P5b", "power:+5V", 116.84, 53.34],
  ["G1", "power:GND", 30.48, 83.82], ["G2", "power:GND", 53.34, 81.28], ["G3", "power:GND", 60.96, 78.74], ["G4", "power:GND", 60.96, 55.88], ["G5", "power:GND", 71.12, 55.88],
  ["G6", "power:GND", 86.36, 82.55], ["G7", "power:GND", 114.3, 78.74], ["G8", "power:GND", 129.54, 55.88], ["G9", "power:GND", 147.32, 78.74],
];

function field(name, value, x, y, angle, justify, hide) {
  return `(property ${q(name)} ${q(value)} (at ${r3(x)} ${r3(y)} ${angle}) (effects (font (size 1.27 1.27))${justify ? ` (justify ${justify})` : ""}${hide ? " (hide yes)" : ""}))`;
}
function symbolNode(key, lib, ref, value, fp, x, y, rot, rf, vf) {
  const pins = [];
  for (const sub of kids(libSyms[lib], "symbol")) for (const p of kids(sub, "pin")) pins.push(K.str(kid(p, "number")[1]));
  const power = lib.startsWith("power:");
  const refF = power ? field("Reference", ref, x, y + (value === "GND" ? 6.35 : -3.81), 0, "", true) : field("Reference", ref, x + rf[0], y + rf[1], rf[2], rf[3]);
  const valF = power ? field("Value", value, x, y + (value === "GND" ? 3.81 : -3.556), 0, "") : field("Value", value, x + vf[0], y + vf[1], vf[2], vf[3]);
  return P(`(symbol (lib_id ${q(lib)}) (at ${x} ${y} ${rot}) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes) (uuid ${q(uuid("sym/" + key))})
    ${refF} ${valF} ${field("Footprint", fp, x, y, 0, "", true)} ${field("Datasheet", "", x, y, 0, "", true)} ${field("Description", "", x, y, 0, "", true)}
    ${[...new Set(pins)].map((n) => `(pin ${q(n)} (uuid ${q(uuid(`pin/${key}/${n}`))}))`).join(" ")}
    (instances (project "blinker" (path ${q("/" + ROOT)} (reference ${q(ref)}) (unit 1)))))`);
}
const symNodes = [];
for (const [ref, lib, value, fp, x, y, rot, rf, vf] of SYMS) symNodes.push({ key: ref, ref, node: symbolNode(ref, lib, ref, value, fp, x, y, rot, rf, vf) });
POWER.forEach(([key, lib, x, y], i) => symNodes.push({ key, ref: "#PWR" + String(i + 1).padStart(2, "0"), power: true, node: symbolNode(key, lib, "#PWR" + String(i + 1).padStart(2, "0"), lib.split(":")[1], "", x, y, 0) }));

// Pin positions come from the renderer's own symbol maths, so a wire end is exactly on its pin.
const probe = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (lib_symbols ${Object.values(libSyms).map(flatText).join(" ")}) ${symNodes.map((s) => flatText(s.node)).join(" ")})`);
const PIN = {};
for (const s of symNodes) for (const p of K.pinPoints(probe, probe.items.get(uuid("sym/" + s.key)))) PIN[`${s.key}.${p.number}`] = PIN[`${s.key}.${p.name}`] = [r3(p.x), r3(p.y)];
const pin = (name) => { if (!PIN[name]) throw new Error("no pin " + name); return PIN[name]; };

// Wires in the order someone would draw them.  A string is a pin, a pair is a corner.
const RAIL = 43.18;
const WIRES = [
  ["J1.A9", [50.8, 53.34], [50.8, RAIL]], [[50.8, RAIL], "P5a.1"],
  [[50.8, RAIL], [60.96, RAIL]], [[60.96, RAIL], "C1.1"], ["C1.2", "G4.1"],
  [[60.96, RAIL], [71.12, RAIL]], [[71.12, RAIL], "C2.1"], ["C2.2", "G5.1"],
  ["J1.A5", [60.96, 66.04], "R1.1"], ["R1.2", "G3.1"],
  ["J1.B5", [53.34, 68.58], "R2.1"], ["R2.2", "G2.1"],
  ["J1.SH", [22.86, 81.28], [30.48, 81.28]], ["J1.A12", [30.48, 81.28]], [[30.48, 81.28], "G1.1"],
  [[71.12, RAIL], [86.36, RAIL]], [[86.36, RAIL], "R3.1"],
  ["R3.2", "R4.1"], ["R4.2", "C3.1"], ["C3.2", "G6.1"],
  [[86.36, RAIL], [99.06, RAIL], [99.06, 60.96], "U1.4"],
  [[86.36, 55.88], [93.98, 55.88], [93.98, 63.5], "U1.7"],
  [[86.36, 68.58], [99.06, 68.58]], [[99.06, 68.58], "U1.6"], [[99.06, 68.58], [99.06, 71.12], "U1.2"],
  ["U1.8", "P5b.1"], ["U1.1", "G7.1"],
  ["U1.5", [114.3, 45.72], [129.54, 45.72]], ["C4.2", "G8.1"],
  ["U1.3", "R5.2"], ["R5.1", [147.32, 66.04], "D1.2"], ["D1.1", "G9.1"],
];
const JUNCTIONS = [[50.8, RAIL], [60.96, RAIL], [71.12, RAIL], [86.36, RAIL], [30.48, 81.28], [86.36, 55.88], [86.36, 68.58], [99.06, 68.58]];

const schItems = [], schWires = [];
WIRES.forEach((w, wi) => {
  const pts = w.map((p) => typeof p === "string" ? pin(p) : p), ids = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[0] !== b[0] && a[1] !== b[1]) throw new Error(`wire ${wi} is not orthogonal: ${JSON.stringify(w)} -> ${JSON.stringify(pts)}`);
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const id = uuid(`wire/${wi}/${i}`); ids.push(id);
    schItems.push(`(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid ${q(id)}))`);
  }
  schWires.push({ ids, pts });
});
const junctionIds = JUNCTIONS.map(([x, y], i) => { const id = uuid("junction/" + i); schItems.push(`(junction (at ${x} ${y}) (diameter 0) (color 0 0 0 0) (uuid ${q(id)}))`); return id; });
// C4's top pin sits on the wire's last corner.
if (pin("C4.1")[0] !== 129.54 || pin("C4.1")[1] !== 45.72) throw new Error("C4.1 moved: " + pin("C4.1"));
schItems.push(`(text "f = 1.44 / ((R3 + 2 R4) C3) = 1.4 Hz" (exclude_from_sim no) (at 83.82 91.44 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${q(uuid("note/f"))}))`);
schItems.push(`(text "5k1 on each CC line asks the charger for 5 V" (exclude_from_sim no) (at 20.32 91.44 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${q(uuid("note/cc"))}))`);

const schText = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid ${q(ROOT)}) (paper "User" 170 142)
  (title_block (title "555 blinker") (date "2026-11-11") (rev "A") (company "KiCad Collaborative") (comment 1 "Home page demo"))
  (lib_symbols ${Object.values(libSyms).map(flatText).join(" ")})
  ${schItems.join("\n")}
  ${symNodes.map((s) => flatText(s.node)).join("\n")}
  (sheet_instances (path "/" (page "1"))) (embedded_fonts no))`;

// ================================================================== board

const OX = 127, OY = 91.5;                 // board corner on the page
const BW = 42, BH = 27, BR = 2;
const NETS = ["", "GND", "+5V", "Net-(J1-CC1)", "Net-(J1-CC2)", "Net-(U1-DISCH)", "Net-(U1-THRES)", "Net-(U1-CONT)", "Net-(U1-OUT)", "Net-(D1-A)"];
const N = { GND: 1, V: 2, CC1: 3, CC2: 4, DIS: 5, THR: 6, CTRL: 7, OUT: 8, LED: 9 };

// ref, footprint file, value, x, y, rot, pad nets, reference offset (footprint-local), pile position
const FPS = [
  ["J1", FOOTPRINTS.J, "USB-C", 4, 13.5, 270, { A5: N.CC1, B5: N.CC2, A9: N.V, B9: N.V, A12: N.GND, B12: N.GND, SH: N.GND }, [-6.0, -3.6], [51, 6]],
  ["R1", FOOTPRINTS.R, "5k1", 11.2, 12.2, 0, { 1: N.CC1, 2: N.GND }, [0, -1.3], [48, 15]],
  ["R2", FOOTPRINTS.R, "5k1", 11.2, 14.8, 0, { 1: N.CC2, 2: N.GND }, [0, 1.35], [52.5, 15]],
  ["C1", FOOTPRINTS.C8, "10u", 17, 10.75, 270, { 1: N.V, 2: N.GND }, [-2.1, 0], [57, 15]],
  ["C2", FOOTPRINTS.C6, "100n", 20.5, 10.575, 270, { 1: N.V, 2: N.GND }, [-2.0, 0], [61, 15]],
  ["U1", FOOTPRINTS.U, "NE555D", 27, 14, 0, { 1: N.GND, 2: N.THR, 3: N.OUT, 4: N.V, 5: N.CTRL, 6: N.THR, 7: N.DIS, 8: N.V }, [0, 3.45], [59, 6.5]],
  ["R3", FOOTPRINTS.R, "10k", 33, 12.095, 0, { 1: N.V, 2: N.DIS }, [0, -1.3], [48, 19.5]],
  ["R4", FOOTPRINTS.R, "47k", 36.3, 12.92, 270, { 1: N.DIS, 2: N.THR }, [0, -1.75], [52.5, 19.5]],
  ["C3", FOOTPRINTS.C8, "10u", 36.3, 17.15, 270, { 1: N.THR, 2: N.GND }, [0, -1.9], [57, 19.5]],
  ["C4", FOOTPRINTS.C6, "10n", 33, 15.905, 0, { 1: N.CTRL, 2: N.GND }, [-0.9, 1.5], [61, 19.5]],
  ["R5", FOOTPRINTS.R, "330", 20.5, 19.425, 270, { 1: N.OUT, 2: N.LED }, [0, -1.55], [50, 24]],
  ["D1", FOOTPRINTS.LED, "LED", 25.1, 22.5, 180, { 1: N.GND, 2: N.LED }, [0, 1.6], [57, 24]],
];
const HOLES = [[3.5, 3.5], [38.5, 3.5], [3.5, 23.5], [38.5, 23.5]];
const symUuid = Object.fromEntries(SYMS.map((s) => [s[0], uuid("sym/" + s[0])]));

function footprintNode(ref, libId, value, x, y, rot, padNets, refAt, hole) {
  const src = P(fs.readFileSync(path.join(LIB, libId.split(":")[1] + ".kicad_mod"), "utf8"));
  const id = uuid("fp/" + ref);
  const out = ["footprint", libId, P('(layer "F.Cu")'), P(`(uuid ${q(id)})`), ["at", r3(OX + x), r3(OY + y), ...(rot ? [rot] : [])]];
  K.QUOTED && 0;
  const marked = P(`(footprint ${q(libId)})`);           // carries the "name is a string" mark
  const turn = (at) => { if (!at) return; const a = ((at[3] || 0) + rot) % 360; if (a) at[3] = a; else at.length = 3; };
  let padNo = 0, shape = 0;
  const body = [];
  for (const c of src.slice(2)) {
    if (!Array.isArray(c)) continue;
    const k = c[0];
    if (k === "version" || k === "generator" || k === "generator_version" || k === "layer" || k === "embedded_fonts") continue;
    if (k === "property") {
      const name = K.str(c[1]);
      if (name === "Reference") { c[2] = ref; if (refAt) { const at = kid(c, "at"); at[1] = refAt[0]; at[2] = refAt[1]; } }
      if (name === "Value") c[2] = value;
      // KiCad keeps footprint text upright: it turns with the footprint only as far as it stays readable.
      const at = kid(c, "at"); if (at) { const a = name === "Reference" ? 0 : (((at[3] || 0) + rot) % 180 + 180) % 180; if (a) at[3] = a; else at.length = 3; }
      const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/prop/${name}`);
      if (hole && name === "Reference") { const fx = kid(c, "effects") ; c.splice(c.indexOf(fx), 0, P("(hide yes)")); }
    } else if (k === "pad") {
      const num = K.str(c[1]); turn(kid(c, "at"));
      const net = padNets[num];
      const u = kid(c, "uuid"); const pid = uuid(`fp/${ref}/pad/${num}/${padNo++}`); if (u) u[1] = pid; else c.push(P(`(uuid ${q(pid)})`));
      if (net) c.splice(c.length - 1, 0, P(`(net ${net} ${q(NETS[net])})`));
    } else if (k === "fp_text") { turn(kid(c, "at")); const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/text/${shape++}`); }
    else { const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/shape/${shape++}`); }
    body.push(c);
  }
  // descr and tags first, as pcbnew writes them, then the link back to the schematic symbol
  const head = body.filter((c) => c[0] === "descr" || c[0] === "tags"), rest = body.filter((c) => c[0] !== "descr" && c[0] !== "tags");
  const props = rest.filter((c) => c[0] === "property"), other = rest.filter((c) => c[0] !== "property");
  const link = symUuid[ref] ? [P(`(path ${q("/" + symUuid[ref])})`), P('(sheetname "/")'), P('(sheetfile "blinker.kicad_sch")')] : [];
  const node = [...out, ...head, ...props, ...link, ...other];
  const text = flatText(node).replace(/^\(footprint [^ ]+ /, `(footprint ${q(libId)} `);
  void marked;
  return { id, text };
}

// Routes in the order they get drawn.  [net, layer, width, points, who]; coordinates are board-local.
const PWR = 0.4, SIG = 0.25;
const ROUTES = [
  [N.CC1, "F.Cu", SIG, [[7.08, 13.0], [8.6, 13.0], [9.4, 12.2], [10.375, 12.2]], 0],
  [N.CC2, "F.Cu", SIG, [[7.08, 14.0], [8.6, 14.0], [9.4, 14.8], [10.375, 14.8]], 0],
  [N.GND, "F.Cu", PWR, [[12.025, 12.2], [13.3, 12.2]], 0, "via"],
  [N.GND, "F.Cu", PWR, [[12.025, 14.8], [13.3, 14.8]], 0, "via"],
  [N.V, "F.Cu", PWR, [[7.08, 11.98], [8.4, 11.98]], 1, "via"],
  [N.V, "F.Cu", PWR, [[8.4, 11.98], [10.58, 9.8], [17, 9.8]], 1],
  [N.V, "F.Cu", PWR, [[17, 9.8], [20.5, 9.8]], 1],
  [N.V, "F.Cu", PWR, [[20.5, 9.8], [28.4, 9.8], [29.475, 10.875], [29.475, 12.095]], 1],
  [N.V, "F.Cu", PWR, [[7.08, 15.02], [8.4, 15.02]], 0, "via"],
  [N.V, "B.Cu", PWR, [[8.4, 15.02], [8.4, 11.98]], 0],
  [N.GND, "F.Cu", PWR, [[7.08, 10.75], [7.08, 9.4]], 0],
  [N.GND, "F.Cu", PWR, [[7.08, 16.25], [7.08, 17.6]], 0],
  [N.GND, "F.Cu", PWR, [[17, 11.7], [17, 13.1]], 1, "via"],
  [N.GND, "F.Cu", PWR, [[20.5, 11.35], [20.5, 12.7]], 1, "via"],
  [N.GND, "F.Cu", PWR, [[24.525, 12.095], [23.0, 12.095], [22.3, 11.395]], 1, "via"],
  [N.V, "F.Cu", PWR, [[29.475, 12.095], [32.175, 12.095]], 0],
  [N.V, "F.Cu", SIG, [[24.525, 15.905], [26.0, 15.905], [26.6, 15.305], [26.6, 10.4], [27.2, 9.8]], 1],
  [N.DIS, "F.Cu", SIG, [[29.475, 13.365], [32.555, 13.365], [33.825, 12.095]], 0],
  [N.DIS, "F.Cu", SIG, [[33.825, 12.095], [36.3, 12.095]], 0],
  [N.THR, "F.Cu", SIG, [[24.525, 13.365], [22.7, 13.365]], 1, "via"],
  [N.THR, "B.Cu", SIG, [[22.7, 13.365], [23.97, 14.635], [31.2, 14.635]], 1, "via"],
  [N.THR, "F.Cu", SIG, [[29.475, 14.635], [31.2, 14.635], [35.41, 14.635], [36.3, 13.745]], 0],
  [N.THR, "F.Cu", SIG, [[36.3, 13.745], [36.3, 16.2]], 0],
  [N.CTRL, "F.Cu", SIG, [[29.475, 15.905], [32.225, 15.905]], 1],
  [N.GND, "F.Cu", PWR, [[33.775, 15.905], [33.775, 17.3]], 1, "via"],
  [N.GND, "F.Cu", PWR, [[36.3, 18.1], [36.3, 19.5]], 0, "via"],
  [N.OUT, "F.Cu", SIG, [[24.525, 14.635], [22.5, 14.635], [20.5, 16.635], [20.5, 18.6]], 1],
  [N.LED, "F.Cu", SIG, [[20.5, 20.25], [20.5, 21.6], [21.4, 22.5], [24.163, 22.5]], 0],
  [N.GND, "F.Cu", PWR, [[26.038, 22.5], [27.5, 22.5]], 1, "via"],
];

const fps = FPS.map(([ref, lib, value, x, y, rot, nets, refAt]) => footprintNode(ref, lib, value, x, y, rot, nets, refAt));
const holes = HOLES.map(([x, y], i) => footprintNode("H" + (i + 1), "MountingHole:MountingHole_2.2mm_M2", "M2", x, y, 0, {}, null, true));
const pcbItems = [], routes = [], vias = [];
ROUTES.forEach(([net, layer, w, pts, who, via], ri) => {
  const ids = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], id = uuid(`track/${ri}/${i}`); ids.push(id);
    pcbItems.push(`(segment (start ${r3(OX + a[0])} ${r3(OY + a[1])}) (end ${r3(OX + b[0])} ${r3(OY + b[1])}) (width ${w}) (layer ${q(layer)}) (net ${net}) (uuid ${q(id)}))`);
  }
  let viaId = null;
  if (via) {
    const e = pts[pts.length - 1]; viaId = uuid(`via/${ri}`);
    if (!vias.some((v) => v.x === e[0] && v.y === e[1])) { vias.push({ id: viaId, x: e[0], y: e[1], after: ri }); pcbItems.push(`(via (at ${r3(OX + e[0])} ${r3(OY + e[1])}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}) (uuid ${q(viaId)}))`); }
    else viaId = null;
  }
  routes.push({ net: NETS[net], layer, ids, pts: pts.map(([x, y]) => [r3(OX + x), r3(OY + y)]), who, via: viaId });
});
const E = (kind, body) => pcbItems.push(`(${kind} ${body} (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid ${q(uuid("edge/" + pcbItems.length))}))`);
const X0 = OX, Y0 = OY, X1 = OX + BW, Y1 = OY + BH, k = BR * (1 - Math.SQRT1_2);
E("gr_line", `(start ${X0 + BR} ${Y0}) (end ${X1 - BR} ${Y0})`); E("gr_arc", `(start ${X1 - BR} ${Y0}) (mid ${r3(X1 - k)} ${r3(Y0 + k)}) (end ${X1} ${Y0 + BR})`);
E("gr_line", `(start ${X1} ${Y0 + BR}) (end ${X1} ${Y1 - BR})`); E("gr_arc", `(start ${X1} ${Y1 - BR}) (mid ${r3(X1 - k)} ${r3(Y1 - k)}) (end ${X1 - BR} ${Y1})`);
E("gr_line", `(start ${X1 - BR} ${Y1}) (end ${X0 + BR} ${Y1})`); E("gr_arc", `(start ${X0 + BR} ${Y1}) (mid ${r3(X0 + k)} ${r3(Y1 - k)}) (end ${X0} ${Y1 - BR})`);
E("gr_line", `(start ${X0} ${Y1 - BR}) (end ${X0} ${Y0 + BR})`); E("gr_arc", `(start ${X0} ${Y0 + BR}) (mid ${r3(X0 + k)} ${r3(Y0 + k)}) (end ${X0 + BR} ${Y0})`);
const silk = (name, s, x, y, size, th) => pcbItems.push(`(gr_text ${q(s)} (at ${OX + x} ${OY + y}) (layer "F.SilkS") (uuid ${q(uuid("silk/" + name))}) (effects (font (size ${size} ${size}) (thickness ${th}))))`);
silk("title", "555 BLINKER", 21, 4.4, 1.5, 0.25); silk("rev", "REV A", 32.2, 23.4, 1, 0.15);
const zoneId = uuid("zone/gnd");
const zi = 0.5;
pcbItems.push(`(zone (net ${N.GND}) (net_name "GND") (layer "B.Cu") (uuid ${q(zoneId)}) (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no)
  (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy ${X0 + zi} ${Y0 + zi}) (xy ${X1 - zi} ${Y0 + zi}) (xy ${X1 - zi} ${Y1 - zi}) (xy ${X0 + zi} ${Y1 - zi}))))`);

const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user)
  (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments")
  (21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))`;
const pcbText = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6) (legacy_teardrops no)) (paper "A4")
  (title_block (title "555 blinker") (date "2026-11-11") (rev "A") (company "KiCad Collaborative") (comment 1 "Home page demo"))
  ${LAYERS}
  (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) (tenting front back) (grid_origin ${OX} ${OY}))
  ${NETS.map((n, i) => `(net ${i} ${q(n)})`).join(" ")}
  ${fps.map((f) => f.text).join("\n")}
  ${holes.map((f) => f.text).join("\n")}
  ${pcbItems.join("\n")}
  (embedded_fonts no))`;

// ================================================================== write

fs.mkdirSync(OUT, { recursive: true });
const schOut = pretty(P(schText)) + "\n", pcbOut = pretty(P(pcbText)) + "\n";
fs.writeFileSync(path.join(OUT, "blinker.kicad_sch"), schOut);
fs.writeFileSync(path.join(OUT, "blinker.kicad_pcb"), pcbOut);
const meta = {
  board: { x: OX, y: OY, w: BW, h: BH, r: BR },
  parts: FPS.map(([ref, lib, value, x, y, rot, , , pile], i) => ({ ref, value, id: fps[i].id, x: r3(OX + x), y: r3(OY + y), rot, pile: [OX + pile[0], OY + pile[1]] })),
  holes: holes.map((h) => h.id),
  routes, vias: vias.map((v) => ({ id: v.id, x: r3(OX + v.x), y: r3(OY + v.y), after: v.after })), zone: zoneId,
  sch: {
    symbols: symNodes.filter((s) => !s.power).map((s) => ({ ref: s.ref, id: uuid("sym/" + s.key) })),
    power: symNodes.filter((s) => s.power).map((s) => ({ id: uuid("sym/" + s.key), at: pin(s.key + ".1") })),
    wires: schWires, junctions: junctionIds.map((id, i) => ({ id, at: JUNCTIONS[i] })),
    notes: [uuid("note/f"), uuid("note/cc")],
  },
};
fs.writeFileSync(path.join(OUT, "blinker.json"), JSON.stringify(meta) + "\n");

// Both files must read back, and every item the page animates must exist.
const sch = K.parseDoc(schOut), pcb = K.parseDoc(pcbOut);
for (const id of [...meta.parts.map((p) => p.id), ...routes.flatMap((r) => r.ids), ...meta.vias.map((v) => v.id), zoneId]) if (!pcb.items.has(id)) throw new Error("board is missing " + id);
for (const id of [...meta.sch.symbols.map((s) => s.id), ...meta.sch.wires.flatMap((w) => w.ids), ...meta.sch.junctions.map((j) => j.id)]) if (!sch.items.has(id)) throw new Error("schematic is missing " + id);
console.log(`schematic: ${sch.items.size} items, ${schOut.length} bytes; board: ${pcb.items.size} items, ${pcbOut.length} bytes`);
