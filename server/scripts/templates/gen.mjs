// node server/scripts/templates/gen.mjs [name…]
//
// Writes the starter templates in server/templates/: for each one a KiCad project (.kicad_pro), schematic and
// board, a preview of each, and an entry in index.json.  The designs are described below with KiCad's own
// library parts; the netlist, the zone fill, the saved files and the previews all come from KiCad 10 itself
// (kicad-cli in the kicad/kicad:10.0 image), and a template is only written when KiCad's ERC and DRC, schematic
// parity included, report nothing at any severity.  See README.md for what has to be running.
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { Board, HERE, K, P, Schematic, kicad, netlist, pretty } from "./kit.mjs";

const OUT = path.join(HERE, "..", "..", "templates");
const META = { date: "2026-11-11", rev: "A", comment: "Starter template" };
const R06 = "Resistor_SMD:R_0603_1608Metric", C06 = "Capacitor_SMD:C_0603_1608Metric", C08 = "Capacitor_SMD:C_0805_2012Metric", LED08 = "LED_SMD:LED_0805_2012Metric";
const SOIC8 = "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", USBC = "Connector_USB:USB_C_Receptacle_GCT_USB4125-xx-x_6P_TopMnt_Horizontal";
const HDR = (n) => `Connector_PinHeader_2.54mm:PinHeader_1x${String(n).padStart(2, "0")}_P2.54mm_Vertical`;
const LEFT = [-2.54, -1.27, "right"], LEFTV = [-2.54, 1.27, "right"];

/** The USB-C power inlet every USB template starts with: 5k1 on each CC line, shield to ground. */
function usbInlet(s, x, y) {
  s.sym("J1", "Connector:USB_C_Receptacle_PowerOnly_6P", "USB-C", USBC, x, y, 0, [-10.16, -17.78, "left"], [-10.16, -15.24, "left"]);
  const cc1 = s.pin("J1.A5"), cc2 = s.pin("J1.B5"), g = s.pin("J1.A12"), sh = s.pin("J1.SH");
  s.sym("R1", "Device:R", "5k1", R06, cc1[0] + 15.24, cc1[1] + 8.89);
  s.sym("R2", "Device:R", "5k1", R06, cc2[0] + 5.08, cc2[1] + 6.35);
  s.wire("J1.A5", "R1.1"); s.wire("J1.B5", "R2.1");
  s.gnd("R1.2"); s.gnd("R2.2", 2.54);
  const bus = g[1] + 2.54;
  s.wire([sh[0] - 7.62, bus], [g[0], bus]); s.wire(sh, [sh[0], bus]); s.wire(g, [g[0], bus]); s.gnd([g[0], bus], 2.54);
  s.flag(sh[0] - 7.62, bus);
}

const TEMPLATES = {};

// ------------------------------------------------------------------ USB-C to 3.3 V
TEMPLATES["usb-c-3v3-regulator"] = {
  title: "USB-C 3.3 V regulator",
  summary: "A USB-C power inlet, an AMS1117-3.3 linear regulator and a power LED, broken out to a three-pin header.",
  detail: "The supply most small boards start from: 5 V from any USB-C charger, regulated down to 3.3 V at up to 800 mA. Copy the regulator block into your own design, or swap the header for whatever you are powering.",
  level: "Beginner", tags: ["Power", "USB-C"], paper: '"A5"',
  sch(s) {
    usbInlet(s, 50.8, 58.42);
    const RAIL = s.pin("J1.A9")[1];
    s.sym("C1", "Device:C", "10u", C08, 96.52, RAIL + 3.81);
    s.sym("U1", "Regulator_Linear:AMS1117-3.3", "AMS1117-3.3", "Package_TO_SOT_SMD:SOT-223-3_TabPin2", 114.3, RAIL, 0, [-3.81, -6.35, "left"], [0, -3.81, "left"]);
    s.sym("C2", "Device:C", "22u", C08, 132.08, RAIL + 3.81);
    s.sym("R3", "Device:R", "1k", R06, 147.32, RAIL + 3.81);
    s.sym("D1", "Device:LED", "PWR", LED08, 147.32, RAIL + 12.7, 90, [5.08, -1.27, "left", 90], [5.08, 1.27, "left", 90]);
    s.sym("J2", "Connector_Generic:Conn_01x03", "OUT", HDR(3), 185.42, RAIL + 12.7, 0, [0, -6.35, ""], [0, 6.35, ""]);
    s.wire("J1.A9", "C1.1", "U1.VI"); s.wire("U1.VO", "C2.1", "R3.1");
    s.rail("power:+5V", [86.36, RAIL], 2.54); s.flag(76.2, RAIL);
    s.rail("power:+3V3", [139.7, RAIL], 2.54);
    s.gnd("C1.2", 2.54); s.gnd("U1.GND", 2.54); s.gnd("C2.2", 2.54);
    s.wire("R3.2", "D1.A"); s.gnd("D1.K", 2.54);
    const [jx, j1] = s.pin("J2.1"), j2 = s.pin("J2.2")[1], j3 = s.pin("J2.3")[1];
    s.wire("J2.1", [jx - 7.62, j1], [jx - 7.62, j1 - 2.54]); s.power("power:+5V", jx - 7.62, j1 - 2.54);
    s.wire("J2.2", [jx - 15.24, j2], [jx - 15.24, j1 - 2.54]); s.power("power:+3V3", jx - 15.24, j1 - 2.54);
    s.wire("J2.3", [jx - 7.62, j3], [jx - 7.62, j3 + 2.54]); s.power("power:GND", jx - 7.62, j3 + 2.54);
    s.text("5k1 on each CC line asks the charger for 5 V", 35.56, 96.52);
    s.text("AMS1117-3.3: up to 800 mA, input at least 4.4 V", 96.52, 81.28);
  },
  size: [34, 22, 2], holes: [[3, 3], [31, 3], [3, 19], [31, 19]],
  place: {
    J1: [4, 11, 270, { refAt: [-6, -3.6] }], R1: [11.2, 9.7, 0, { refAt: [0, -1.3] }], R2: [11.2, 12.3, 0, { refAt: [0, 1.35] }],
    C1: [14.6, 17.2, 90], U1: [19.5, 11, 0], C2: [26, 5.4, 90], R3: [19, 18.6, 0], D1: [23.6, 18.6, 0], J2: [30.6, 8.46, 0],
  },
  silk: [["USB-C 3V3", 15, 3.2, 1.3, 0.2], ["5V", 27.7, 8.46, 0.8, 0.12], ["3V3", 27.4, 11, 0.8, 0.12], ["GND", 27.3, 13.54, 0.8, 0.12]],
  power: ["+5V", "+3V3"],
};

// ------------------------------------------------------------------ I2C sensor breakout
TEMPLATES["i2c-sensor-breakout"] = {
  title: "I2C temperature sensor breakout",
  summary: "An LM75B temperature sensor with its decoupling capacitor and bus pull-ups on a five-pin header.",
  detail: "The shape of nearly every sensor breakout: one chip, one capacitor, pull-ups on the bus, and a header. Replace the LM75B with the part you need and keep the rest. The address pins are tied low, so the sensor answers at 0x48.",
  level: "Beginner", tags: ["Sensor", "I2C"], paper: '"A5"',
  sch(s) {
    const RAIL = 50.8;
    s.sym("U1", "Sensor_Temperature:LM75B", "LM75B", SOIC8, 101.6, 68.58, 0, [2.54, -11.43, "left"], [2.54, -8.89, "left"]);
    s.sym("C1", "Device:C", "100n", C06, 73.66, 60.96);
    s.sym("R1", "Device:R", "4k7", R06, 121.92, RAIL + 3.81); s.sym("R2", "Device:R", "4k7", R06, 132.08, RAIL + 3.81); s.sym("R3", "Device:R", "10k", R06, 142.24, RAIL + 3.81);
    s.sym("J1", "Connector_Generic:Conn_01x05", "I2C", HDR(5), 167.64, 68.58, 0, [0, -8.89, ""], [0, 8.89, ""]);
    const sda = s.pin("U1.SDA")[1], scl = s.pin("U1.SCL")[1], os = s.pin("U1.3")[1], jx = s.pin("J1.1")[0];
    // supply
    s.wire([66.04, RAIL], [152.4, RAIL], "J1.1"); s.flag(66.04, RAIL); s.rail("power:+3V3", [86.36, RAIL], 2.54);
    s.wire("C1.1", [73.66, RAIL]); s.wire("U1.8", [101.6, RAIL]); s.gnd("C1.2", 2.54); s.gnd("U1.4", 2.54);
    // the address pins, all low: 0x48
    const ax = s.pin("U1.A0")[0] - 5.08;
    s.wire("U1.A0", [ax, s.pin("U1.A0")[1]], [ax, s.pin("U1.A2")[1] + 5.08]); s.wire("U1.A1", [ax, s.pin("U1.A1")[1]]); s.wire("U1.A2", [ax, s.pin("U1.A2")[1]]);
    s.power("power:GND", ax, s.pin("U1.A2")[1] + 5.08);
    // the bus, pulled up
    s.wire("U1.SDA", [jx, sda]); s.wire("U1.SCL", [jx, scl]); s.wire("U1.3", [jx, os]);
    s.wire("R1.2", [121.92, sda]); s.wire("R2.2", [132.08, scl]); s.wire("R3.2", [142.24, os]);
    s.label("SDA", [147.32, sda]); s.label("SCL", [147.32, scl]); s.label("ALERT", [147.32, os]);
    s.wire("J1.5", [jx - 5.08, s.pin("J1.5")[1]]); s.gnd([jx - 5.08, s.pin("J1.5")[1]], 2.54);
    s.wire([66.04, s.pin("C1.2")[1] + 2.54], [73.66, s.pin("C1.2")[1] + 2.54]); s.flag(66.04, s.pin("C1.2")[1] + 2.54);
    s.text("A0, A1 and A2 low: the sensor answers at address 0x48", 66.04, 93.98);
    s.text("O.S. is open drain and pulls low above the set temperature", 66.04, 97.79);
  },
  size: [26, 18, 1.5], holes: [[2.8, 2.8], [23.2, 2.8]],
  place: {
    U1: [13, 7.2, 0], C1: [18.8, 4.6, 90], R1: [7.3, 4.4, 0, { refAt: [-2.4, 0] }], R2: [7.3, 6.2, 0, { refAt: [-2.4, 0] }], R3: [7.3, 8, 0, { refAt: [-2.4, 0] }],
    J1: [7.92, 14.6, 90, { refAt: [0, -2.3] }],
  },
  silk: [["LM75B", 13, 1.6, 1, 0.15], ["3V3", 7.92, 11.9, 0.8, 0.12], ["SDA", 10.46, 11.9, 0.8, 0.12], ["SCL", 13, 11.9, 0.8, 0.12], ["OS", 15.54, 11.9, 0.8, 0.12], ["GND", 18.08, 11.9, 0.8, 0.12]],
  power: ["+3V3"],
};

// ------------------------------------------------------------------ ATtiny85
TEMPLATES["attiny85-dev-board"] = {
  title: "ATtiny85 development board",
  summary: "An ATtiny85 with a programming header, a reset button, an LED and two spare pins on a header.",
  detail: "A complete small microcontroller board: decoupling, reset with a pull-up and a button, the six-pin ISP header every AVR programmer plugs into, an LED on PB3 and a header for PB3, PB4 and power. A good first board to build and to grow.",
  level: "Intermediate", tags: ["Microcontroller", "AVR"], paper: '"A4"',
  sch(s) {
    s.sym("U1", "MCU_Microchip_ATtiny:ATtiny85-20S", "ATtiny85-20S", "Package_SO:SOIC-8_5.3x5.3mm_P1.27mm", 101.6, 76.2, 0, [1.27, -16.51, "left"], [1.27, -13.97, "left"]);
    s.sym("C1", "Device:C", "100n", C06, 76.2, 76.2);
    const pb = (n) => s.pin("U1." + ({ 0: 5, 1: 6, 2: 7, 3: 2, 4: 3, 5: 1 })[n]), px = pb(0)[0];
    // supply
    s.wire([68.58, 58.42], [101.6, 58.42], "U1.8"); s.wire("C1.1", [76.2, 58.42]); s.rail("power:VCC", [88.9, 58.42], 2.54); s.flag(68.58, 58.42);
    s.wire([68.58, 93.98], [101.6, 93.98], "U1.4"); s.wire("C1.2", [76.2, 93.98]); s.gnd([88.9, 93.98], 2.54); s.flag(68.58, 93.98);
    // programming pins
    for (const [n, name] of [[0, "MOSI"], [1, "MISO"], [2, "SCK"], [4, "PB4"], [5, "~{RESET}"]]) { s.wire(pb(n), [px + 2.54, pb(n)[1]]); s.label(name, [px + 2.54, pb(n)[1]]); }
    // LED on PB3
    s.sym("R2", "Device:R", "330", R06, px + 19.05, pb(3)[1], 90, [0, -2.54, "", 90], [0, 2.54, "", 90]);
    s.sym("D1", "Device:LED", "LED", LED08, px + 30.48, pb(3)[1], 180, [0, -3.81, ""], [0, 3.81, ""]);
    s.wire(pb(3), "R2.1"); s.wire("R2.2", "D1.A"); s.wire("D1.K", [px + 38.1, pb(3)[1]]); s.gnd([px + 38.1, pb(3)[1]], 2.54); s.label("PB3", [px + 2.54, pb(3)[1]]);
    // ISP header
    s.sym("J1", "Connector:AVR-ISP-6", "AVR-ISP-6", "Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical", 180.34, 73.66, 0, [-8.89, -11.43, "left"], [1.27, -11.43, "left"]);
    for (const [pin, name] of [["MISO", "MISO"], ["MOSI", "MOSI"], ["SCK", "SCK"], ["5", "~{RESET}"]]) { const p = s.pin("J1." + pin); s.wire(p, [p[0] + 2.54, p[1]]); s.label(name, [p[0] + 2.54, p[1]]); }
    s.rail("power:VCC", "J1.2"); s.gnd("J1.6");
    // reset: pulled up, button to ground
    s.sym("R1", "Device:R", "10k", R06, 142.24, 104.14);
    s.sym("SW1", "Switch:SW_Push", "RESET", "Button_Switch_SMD:SW_SPST_B3U-1000P", 152.4, 113.03, 0, [0, -6.35, ""], [0, 3.81, ""]);
    s.rail("power:VCC", "R1.1"); s.wire("R1.2", [142.24, 113.03]); s.wire([129.54, 113.03], "SW1.1"); s.label("~{RESET}", [129.54, 113.03]);
    s.wire("SW1.2", [162.56, 113.03]); s.gnd([162.56, 113.03], 2.54);
    // spare pins
    s.sym("J2", "Connector_Generic:Conn_01x04", "IO", HDR(4), 200.66, 107.95, 0, [0, -7.62, ""], [0, 7.62, ""]);
    const jx = s.pin("J2.1")[0];
    s.wire("J2.1", [jx - 5.08, s.pin("J2.1")[1]], [jx - 5.08, s.pin("J2.1")[1] - 2.54]); s.power("power:VCC", jx - 5.08, s.pin("J2.1")[1] - 2.54);
    s.wire("J2.2", [jx - 12.7, s.pin("J2.2")[1]]); s.label("PB3", [jx - 12.7, s.pin("J2.2")[1]]);
    s.wire("J2.3", [jx - 12.7, s.pin("J2.3")[1]]); s.label("PB4", [jx - 12.7, s.pin("J2.3")[1]]);
    s.wire("J2.4", [jx - 5.08, s.pin("J2.4")[1]], [jx - 5.08, s.pin("J2.4")[1] + 2.54]); s.power("power:GND", jx - 5.08, s.pin("J2.4")[1] + 2.54);
    s.text("Program over the ISP header with any AVR programmer (USBasp, Atmel-ICE, an Arduino as ISP)", 68.58, 129.54);
    s.text("PB0 to PB2 are shared with the programmer; PB3 drives the LED and is also on the header", 68.58, 133.35);
  },
  size: [32, 24, 2], holes: [[3, 3], [29, 3], [3, 21], [29, 21]],
  place: {
    U1: [13, 11.5, 0], C1: [19.3, 7.6, 90], J1: [23.2, 7.4, 0], R2: [8, 4.4, 0], D1: [12.6, 4.4, 0],
    R1: [17, 17.4, 0], SW1: [22.4, 19, 0], J2: [8.9, 20.6, 90, { refAt: [0, -2.3] }],
  },
  silk: [["ATtiny85", 20, 2.6, 1.1, 0.17], ["ISP", 28.4, 10, 0.8, 0.12, 90]],
  power: ["VCC"],
};

// ------------------------------------------------------------------ build

function build(id) {
  const t = TEMPLATES[id], stem = id, dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-template-"));
  const meta = { ...META, comment: t.summary.length > 60 ? "Starter template" : t.summary };
  const s = new Schematic(stem, t.title, t.paper); t.sch(s);
  fs.writeFileSync(path.join(dir, stem + ".kicad_sch"), s.render(meta));
  const nl = netlist(dir, stem);
  const b = new Board(s, nl, [148.5 - t.size[0] / 2, 105 - t.size[1] / 2].map((v) => Math.round(v * 2) / 2), t.size);
  b.place(t.place); b.edge();
  t.holes.forEach(([x, y], i) => b.hole(i + 1, x, y));
  for (const [text, x, y, size, th, angle] of t.silk || []) b.silk(text, x, y, size, th, angle);
  b.pour("GND", ["B.Cu"]);
  if (t.tracks) t.tracks(b);
  const pro = project(stem, t);
  let text = b.render(meta);
  const { res, text: routed } = b.autoroute(text, pro, t.route || {});
  console.log(`${id}: ${nl.parts.length} parts, ${nl.nets.length - 1} nets, routed ${res.routed}/${res.total}, vias ${res.vias}`);
  for (const c of res.connections || []) if (c.reason) console.log("   not routed:", c.net, c.reason, JSON.stringify(c.blockedBy || ""));
  text = b.render(meta, routed);
  fs.writeFileSync(path.join(dir, stem + ".kicad_pcb"), text);
  fs.writeFileSync(path.join(dir, stem + ".kicad_pro"), JSON.stringify(pro, null, 2) + "\n");
  return { t, dir, stem, nl };
}

/** The project file: KiCad's default rules, with the supply nets in a wider net class. */
function project(stem, t) {
  return {
    board: { design_settings: { defaults: {}, diff_pair_dimensions: [], drc_exclusions: [], rules: { min_clearance: 0.2, min_track_width: 0.2, min_via_diameter: 0.5, min_through_hole_diameter: 0.3, min_copper_edge_clearance: 0.5, min_hole_clearance: 0.25, min_hole_to_hole: 0.25 },
      track_widths: [0, 0.25, 0.4], via_dimensions: [{ diameter: 0, drill: 0 }, { diameter: 0.6, drill: 0.3 }] } },
    boards: [], libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] }, meta: { filename: stem + ".kicad_pro", version: 3 },
    net_settings: {
      classes: [
        { name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, bus_width: 12, wire_width: 6, line_style: 0, pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", priority: 2147483647 },
        { name: "Power", clearance: 0.2, track_width: 0.4, via_diameter: 0.6, via_drill: 0.3, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, bus_width: 12, wire_width: 6, line_style: 0, pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", priority: 0 },
      ],
      meta: { version: 4 }, net_colors: null, netclass_assignments: null,
      netclass_patterns: ["GND", ...(t.power || [])].map((n) => ({ netclass: "Power", pattern: n })),
    },
    pcbnew: { page_layout_descr_file: "" }, sheets: [], text_variables: {},
  };
}

/** The home page's 555 blinker (server/web/landing/demo, written by scripts/landing-demo) is the first template as it
 *  stands; the guided first project starts from the same board with four connections left open, as the home page's
 *  mini editor shows it. */
const DEMO = path.join(HERE, "..", "..", "web", "landing", "demo");
const BLINKER = {
  title: "555 LED blinker",
  summary: "The board from the home page: a USB-C powered 555 timer that blinks an LED about once a second.",
  detail: "A classic first circuit with everything a real board has: a connector, a timer chip, the resistors and capacitors that set its rate, a ground pour and mounting holes. The guided first project uses this board.",
  level: "Beginner", tags: ["Timer", "USB-C"], size: [42, 27, 2], power: ["+5V"],
};
const OPEN_ROUTES = [20, 26, 27, 28];   // web/landing/mini.ts OPEN
function buildBlinker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-template-")), stem = "blinker";
  for (const ext of ["kicad_sch", "kicad_pcb"]) fs.copyFileSync(path.join(DEMO, `blinker.${ext}`), path.join(dir, `${stem}.${ext}`));
  fs.writeFileSync(path.join(dir, stem + ".kicad_pro"), JSON.stringify(project(stem, BLINKER), null, 2) + "\n");
  // The guided board: the open connections taken out, nothing else touched.  The pour keeps KiCad's fill, so ground
  // stays joined and exactly these connections show as unrouted; the fill is as stale as any pour is after an edit.
  const meta = JSON.parse(fs.readFileSync(path.join(DEMO, "blinker.json"), "utf8")), drop = new Set();
  for (const i of OPEN_ROUTES) { for (const id of meta.routes[i].ids) drop.add(id); if (meta.routes[i].via) drop.add(meta.routes[i].via); }
  const tree = K.parse(fs.readFileSync(path.join(DEMO, "blinker.kicad_pcb"), "utf8"));
  const kept = tree.filter((c) => !(Array.isArray(c) && (c[0] === "segment" || c[0] === "via") && drop.has(K.uuidOf(c))));
  if (tree.length - kept.length !== drop.size) throw new Error(`the guided board should lose ${drop.size} items, lost ${tree.length - kept.length}`);
  const guided = pretty(Object.assign(kept, {})) + "\n";
  const doc = K.parseDoc(guided, "kicad_pcb"), open = P.ratsnest(doc).length;
  if (open !== OPEN_ROUTES.length) throw new Error(`the guided board should have ${OPEN_ROUTES.length} connections to route, has ${open}`);
  return { t: BLINKER, dir, stem, guided, open, parts: 12, nets: 9 };
}

const count = (out, what) => { const m = new RegExp(`Found (\\d+) ${what}`).exec(out); return m ? +m[1] : -1; };
/** KiCad's verdict on a finished template folder: ERC, and DRC with schematic parity, at every severity. */
function verify(dir, stem) {
  const erc = kicad(dir, ["sch", "erc", "--severity-all", "--exit-code-violations", "-o", "erc.rpt", stem + ".kicad_sch"]);
  const drc = kicad(dir, ["pcb", "drc", "--severity-all", "--schematic-parity", "--exit-code-violations", "-o", "drc.rpt", stem + ".kicad_pcb"]);
  const res = { erc: count(erc, "violations"), drc: count(drc, "violations"), unconnected: count(drc, "unconnected items"), parity: count(drc, "schematic parity issues") };
  res.ok = res.erc === 0 && res.drc === 0 && res.unconnected === 0 && res.parity === 0;
  if (!res.ok) for (const f of ["erc.rpt", "drc.rpt"]) console.log(fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => /^\[|^ {4}@/.test(l)).join("\n"));
  return res;
}
/** KiCad's own pictures: the board as the 3D viewer renders it, and the schematic as it plots. */
async function previews(dir, stem) {
  kicad(dir, ["pcb", "render", "-o", "board.png", "-w", "900", "-h", "600", "--zoom", "1.25", "--quality", "basic", stem + ".kicad_pcb"]);
  kicad(dir, ["sch", "export", "svg", "-o", "svg", "--exclude-drawing-sheet", "--no-background-color", stem + ".kicad_sch"]);
  const svgFile = path.join(dir, "svg", stem + ".svg");
  if (!fs.existsSync(path.join(dir, "board.png")) || !fs.existsSync(svgFile)) throw new Error("kicad-cli wrote no previews in " + dir);
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const svg = fs.readFileSync(svgFile, "utf8").replace(/<\?xml[^>]*>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
  // crop to what is drawn, with a margin, and keep the picture 3:2 like the board's
  await page.evaluate(() => {
    const el = document.querySelector("svg"), b = el.getBBox(), m = 6;
    let x = b.x - m, y = b.y - m, w = b.width + 2 * m, h = b.height + 2 * m;
    if (w / h > 1.5) { const nh = w / 1.5; y -= (nh - h) / 2; h = nh; } else { const nw = h * 1.5; x -= (nw - w) / 2; w = nw; }
    el.setAttribute("viewBox", `${x} ${y} ${w} ${h}`); el.setAttribute("width", "1200"); el.setAttribute("height", "800"); el.style.display = "block";
  });
  await page.screenshot({ path: path.join(dir, "schematic.png"), clip: { x: 0, y: 0, width: 1200, height: 800 } });
  await browser.close();
}

const args = process.argv.slice(2), want = args.filter((a) => !a.startsWith("--")), check = args.includes("--check");
const index = [];
let bad = 0;
for (const id of ["blinker", ...Object.keys(TEMPLATES)]) {
  if (want.length && !want.includes(id)) continue;
  let b;
  if (id === "blinker") b = buildBlinker();
  else {
    b = build(id);
    // KiCad fills the pour and saves the board, then saves the schematic: both files are KiCad's own writing
    kicad(b.dir, ["pcb", "drc", "--refill-zones", "--save-board", "-o", "drc.rpt", b.stem + ".kicad_pcb"]);
    kicad(b.dir, ["sch", "upgrade", "--force", b.stem + ".kicad_sch"]);
    b.parts = b.nl.parts.length; b.nets = b.nl.nets.length - 1;
  }
  const v = verify(b.dir, b.stem);
  console.log(`${id}: ERC ${v.erc}, DRC ${v.drc}, unconnected ${v.unconnected}, parity ${v.parity}  ${v.ok ? "ok" : "FAILED"}   (${b.dir})`);
  if (!v.ok) { bad++; continue; }
  const files = [`${b.stem}.kicad_pro`, `${b.stem}.kicad_sch`, `${b.stem}.kicad_pcb`];
  const out = path.join(OUT, id);
  if (check) {
    for (const f of files) if (!fs.existsSync(path.join(out, f)) || (id === "blinker" && f !== files[0] && fs.readFileSync(path.join(out, f), "utf8") !== fs.readFileSync(path.join(b.dir, f), "utf8"))) { console.log(`  ${id}/${f} is not what the generator writes now`); bad++; }
  } else {
    await previews(b.dir, b.stem);
    fs.mkdirSync(out, { recursive: true });
    for (const f of [...files, "board.png", "schematic.png"]) fs.copyFileSync(path.join(b.dir, f), path.join(out, f));
    if (b.guided) fs.writeFileSync(path.join(out, `${b.stem}.guided.kicad_pcb`), b.guided);
  }
  const t = b.t;
  index.push({ id, title: t.title, summary: t.summary, detail: t.detail, level: t.level, tags: t.tags, parts: b.parts, nets: b.nets, size: [t.size[0], t.size[1]], layers: 2, stem: b.stem, guided: b.guided ? { open: b.open } : undefined });
  fs.rmSync(b.dir, { recursive: true, force: true });
}
if (!check && !want.length && !bad) fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ kicad: "10.0", templates: index }, null, 2) + "\n");
if (bad) { console.error(`${bad} problem(s): nothing in index.json was changed`); process.exit(1); }
