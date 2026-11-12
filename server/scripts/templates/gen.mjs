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

// How the sheets are drawn (the person's rules, 2026-11-12): each block is a titled section; inside one, parts
// are joined by wires, and a net label or power symbol appears only where a net leaves the section.  Supplies
// point up and grounds down, each ground straight under its pin; labels are horizontal; a series resistor lies
// in line with the pin it serves; a regulator's capacitors hang under its input and output wires.

/** Power on a connector pin: the wire from the pin runs out to `x` and turns to the power symbol.  With `flag`, the
 *  wire carries on to a PWR_FLAG clear of the pins: the supply comes in here, and ERC has to be told. */
function supplyPin(s, pin, id, x, flag) {
  const [, py] = s.pin(pin), ground = /GND/.test(id), d = ground ? 2.54 : -2.54;
  s.wire(pin, [x, py], [x, py + d]); s.power(id, x, py + d);
  if (flag) { s.wire([x, py], [x - 10.16, py]); s.flag(x - 10.16, py); }
}

/** The USB-C power inlet every USB template starts with: 5k1 on each CC line, shield to ground. */
function usbInlet(s, x, y) {
  s.sym("J1", "Connector:USB_C_Receptacle_PowerOnly_6P", "USB-C", USBC, x, y, 0, [-10.16, -17.78, "left"], [-10.16, -15.24, "left"]);
  // the CC resistors in line with their pins, tied together to one ground
  const e1 = s.inline("R1", "5k1", R06, "J1.A5"), e2 = s.inline("R2", "5k1", R06, "J1.B5");
  s.wire(e1, [e1[0] + 7.62, e1[1]], [e1[0] + 7.62, e2[1]]); s.wire(e2, [e2[0] + 7.62, e2[1]]); s.gnd([e2[0] + 7.62, e2[1]], 2.54);
  // shield and ground, each straight down to its own symbol
  s.gnd("J1.SH", 2.54); s.gnd("J1.A12", 2.54);
}

const TEMPLATES = {};

// ------------------------------------------------------------------ USB-C to 3.3 V
TEMPLATES["usb-c-3v3-regulator"] = {
  title: "USB-C 3.3 V regulator",
  summary: "A USB-C power inlet, an AMS1117-3.3 linear regulator and a power LED, broken out to a three-pin header.",
  detail: "The supply most small boards start from: 5 V from any USB-C charger, regulated down to 3.3 V at up to 800 mA. Copy the regulator block into your own design, or swap the header for whatever you are powering.",
  level: "Beginner", tags: ["Power", "USB-C"], paper: '"A4"',
  sch(s) {
    // ---- USB-C input
    s.frame("USB-C input", 30.48, 40.64, 109.22, 111.76);
    usbInlet(s, 50.8, 71.12);
    const [vx, vy] = s.pin("J1.A9");
    s.wire("J1.A9", [vx + 30.48, vy], [vx + 30.48, vy - 2.54]); s.power("power:+5V", vx + 30.48, vy - 2.54);
    s.flag(vx + 20.32, vy);
    // the ground flag: ERC wants to know the ground net is driven from outside
    s.flag(vx + 30.48, vy + 22.86); s.gnd([vx + 30.48, vy + 22.86], 2.54);
    s.text("5k1 on each CC line asks the charger for 5 V", 33.02, 107.95);
    // ---- regulator: the capacitors hang under the input and output wires
    s.frame("3.3 V regulator", 114.3, 40.64, 190.5, 111.76);
    const RAIL = 66.04;
    s.sym("U1", "Regulator_Linear:AMS1117-3.3", "AMS1117-3.3", "Package_TO_SOT_SMD:SOT-223-3_TabPin2", 142.24, RAIL, 0, [0, -8.89, ""], [0, -6.35, ""]);
    s.sym("C1", "Device:C", "10u", C08, 124.46, RAIL + 6.35, 0, LEFT, LEFTV);
    s.sym("C2", "Device:C", "22u", C08, 160.02, RAIL + 6.35);
    s.sym("R3", "Device:R", "1k", R06, 177.8, RAIL + 6.35);
    s.sym("D1", "Device:LED", "PWR", LED08, 177.8, RAIL + 16.51, 90, [6.35, -1.27, "left", 90], [6.35, 1.27, "left", 90]);
    s.wire([124.46, RAIL], "U1.VI"); s.wire([124.46, RAIL], "C1.1"); s.rail("power:+5V", [124.46, RAIL], 5.08);
    s.wire("U1.VO", [177.8, RAIL], "R3.1"); s.wire([160.02, RAIL], "C2.1"); s.rail("power:+3V3", [160.02, RAIL], 5.08);
    const G = RAIL + 26.67;
    for (const p of ["C1.2", "U1.GND", "C2.2", "D1.K"]) s.gnd(p, G - s.pin(p)[1]);
    s.wire("R3.2", "D1.A");
    s.text("AMS1117-3.3: up to 800 mA, input at least 4.4 V", 116.84, 107.95);
    // ---- output
    s.frame("Output", 195.58, 40.64, 241.3, 111.76);
    s.sym("J2", "Connector_Generic:Conn_01x03", "OUT", HDR(3), 228.6, 71.12, 0, [0, -6.35, ""], [0, 6.35, ""]);
    const jx = s.pin("J2.1")[0];
    supplyPin(s, "J2.1", "power:+5V", jx - 7.62);
    s.wire("J2.2", [jx - 17.78, s.pin("J2.2")[1]], [jx - 17.78, s.pin("J2.1")[1] - 2.54]); s.power("power:+3V3", jx - 17.78, s.pin("J2.1")[1] - 2.54);
    supplyPin(s, "J2.3", "power:GND", jx - 7.62);
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
  level: "Beginner", tags: ["Sensor", "I2C"], paper: '"A4"',
  sch(s) {
    // ---- the sensor: one supply rail for the chip, its capacitor and the pull-ups
    s.frame("Temperature sensor", 60.96, 38.1, 172.72, 114.3);
    const RAIL = 55.88;
    s.sym("U1", "Sensor_Temperature:LM75B", "LM75B", SOIC8, 101.6, 78.74, 0, [2.54, -11.43, "left"], [2.54, -8.89, "left"]);
    s.sym("C1", "Device:C", "100n", C06, 73.66, RAIL + 8.89);
    s.sym("R1", "Device:R", "4k7", R06, 127, RAIL + 6.35); s.sym("R2", "Device:R", "4k7", R06, 137.16, RAIL + 6.35); s.sym("R3", "Device:R", "10k", R06, 147.32, RAIL + 6.35);
    const sda = s.pin("U1.SDA")[1], scl = s.pin("U1.SCL")[1], os = s.pin("U1.3")[1];
    s.wire([73.66, RAIL], [147.32, RAIL]); s.rail("power:+3V3", [114.3, RAIL], 2.54);
    s.wire("C1.1", [73.66, RAIL]); s.wire("U1.8", [101.6, RAIL]);
    for (const r of ["R1", "R2", "R3"]) s.wire(r + ".1", [s.pin(r + ".1")[0], RAIL]);
    const G = s.pin("U1.4")[1] + 5.08;
    s.gnd("C1.2", G - s.pin("C1.2")[1]); s.gnd("U1.4", G - s.pin("U1.4")[1]);
    // the address pins, all low: 0x48
    const ax = s.pin("U1.A0")[0] - 5.08;
    s.wire("U1.A0", [ax, s.pin("U1.A0")[1]], [ax, G]); s.wire("U1.A1", [ax, s.pin("U1.A1")[1]]); s.wire("U1.A2", [ax, s.pin("U1.A2")[1]]);
    s.power("power:GND", ax, G);
    // the bus, pulled up; it leaves the section by name
    const out = 157.48;
    s.wire("U1.SDA", [out, sda]); s.wire("U1.SCL", [out, scl]); s.wire("U1.3", [out, os]);
    s.wire("R1.2", [127, sda]); s.wire("R2.2", [137.16, scl]); s.wire("R3.2", [147.32, os]);
    s.label("SDA", [out, sda]); s.label("SCL", [out, scl]); s.label("ALERT", [out, os]);
    s.text("A0, A1 and A2 low: the sensor answers at address 0x48", 63.5, 106.68);
    s.text("O.S. is open drain and pulls low above the set temperature", 63.5, 110.49);
    // ---- the header: power comes in here
    s.frame("I2C header", 177.8, 38.1, 231.14, 114.3);
    s.sym("J1", "Connector_Generic:Conn_01x05", "I2C", HDR(5), 218.44, 78.74, 0, [0, -8.89, ""], [0, 8.89, ""]);
    const jx = s.pin("J1.1")[0];
    supplyPin(s, "J1.1", "power:+3V3", jx - 17.78, true);
    for (const [n, name] of [[2, "SDA"], [3, "SCL"], [4, "ALERT"]]) { const y = s.pin("J1." + n)[1]; s.wire("J1." + n, [jx - 10.16, y]); s.label(name, [jx - 10.16, y]); }
    supplyPin(s, "J1.5", "power:GND", jx - 17.78, true);
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
    // ---- the microcontroller, its capacitor, and the LED wired to PB3
    s.frame("Microcontroller", 55.88, 38.1, 162.56, 119.38);
    s.sym("U1", "MCU_Microchip_ATtiny:ATtiny85-20S", "ATtiny85-20S", "Package_SO:SOIC-8_5.3x5.3mm_P1.27mm", 96.52, 81.28, 0, [1.27, -16.51, "left"], [1.27, -13.97, "left"]);
    const pb = (n) => s.pin("U1." + ({ 0: 5, 1: 6, 2: 7, 3: 2, 4: 3, 5: 1 })[n]), px = pb(0)[0];
    const top = s.pin("U1.8")[1] - 5.08;
    s.sym("C1", "Device:C", "100n", C06, 73.66, top + 6.35);
    s.wire("U1.8", [96.52, top], [73.66, top], "C1.1"); s.rail("power:VCC", [86.36, top], 2.54);
    s.gnd("U1.4", 2.54); s.gnd("C1.2", 2.54);
    // the pins that leave the section, by name
    for (const [n, name] of [[0, "MOSI"], [1, "MISO"], [2, "SCK"], [4, "PB4"], [5, "~{RESET}"]]) { s.wire(pb(n), [px + 5.08, pb(n)[1]]); s.label(name, [px + 5.08, pb(n)[1]]); }
    // LED on PB3: resistor in line with the pin
    const r = s.inline("R2", "330", R06, pb(3), 17.78);
    s.sym("D1", "Device:LED", "LED", LED08, r[0] + 10.16, pb(3)[1], 180, [0, -3.81, ""], [0, 3.81, ""]);
    s.wire(r, "D1.A"); s.wire("D1.K", [r[0] + 17.78, pb(3)[1]]); s.gnd([r[0] + 17.78, pb(3)[1]], 5.08); s.label("PB3", [px + 5.08, pb(3)[1]]);
    s.text("PB0 to PB2 are shared with the programmer; PB3 drives the LED and is also on the header", 58.42, 115.57);
    // ---- ISP header
    s.frame("Programming header", 167.64, 38.1, 241.3, 119.38);
    s.sym("J1", "Connector:AVR-ISP-6", "AVR-ISP-6", "Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical", 190.5, 78.74, 0, [-8.89, -11.43, "left"], [1.27, -11.43, "left"]);
    for (const [pin, name] of [["MISO", "MISO"], ["MOSI", "MOSI"], ["SCK", "SCK"], ["5", "~{RESET}"]]) { const p = s.pin("J1." + pin); s.wire(p, [p[0] + 5.08, p[1]]); s.label(name, [p[0] + 5.08, p[1]]); }
    s.rail("power:VCC", "J1.2", 2.54); s.gnd("J1.6", 2.54);
    s.text("Any AVR programmer: USBasp, Atmel-ICE,", 170.18, 111.76); s.text("or an Arduino as ISP", 170.18, 115.57);
    // ---- reset: pulled up, button to ground
    s.frame("Reset", 55.88, 124.46, 162.56, 172.72);
    s.sym("R1", "Device:R", "10k", R06, 99.06, 143.51);
    s.sym("SW1", "Switch:SW_Push", "RESET", "Button_Switch_SMD:SW_SPST_B3U-1000P", 114.3, 152.4, 0, [0, -6.35, ""], [0, 3.81, ""]);
    s.rail("power:VCC", "R1.1", 2.54); s.wire("R1.2", [99.06, 152.4]); s.wire([83.82, 152.4], "SW1.1"); s.label("~{RESET}", [83.82, 152.4]);
    s.wire("SW1.2", [127, 152.4]); s.gnd([127, 152.4], 5.08);
    // ---- spare pins and power
    s.frame("I/O header", 167.64, 124.46, 241.3, 172.72);
    s.sym("J2", "Connector_Generic:Conn_01x04", "IO", HDR(4), 223.52, 147.32, 0, [0, -7.62, ""], [0, 7.62, ""]);
    const jx = s.pin("J2.1")[0];
    supplyPin(s, "J2.1", "power:VCC", jx - 17.78, true);
    for (const [n, name] of [[2, "PB3"], [3, "PB4"]]) { const y = s.pin("J2." + n)[1]; s.wire("J2." + n, [jx - 10.16, y]); s.label(name, [jx - 10.16, y]); }
    supplyPin(s, "J2.4", "power:GND", jx - 17.78, true);
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
