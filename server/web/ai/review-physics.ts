// review-physics.ts — the layout review's physics: what the copper has to do for the board to work, radiate where it
// should and nowhere else, stay cool and stay safe.
//
// review.ts judges a board against the layout checklist (is it tidy, labelled, assembled).  This judges it against
// the electrical rules that the standard references agree on and a program can measure from the copper:
//   RF            an antenna in the clear at a board edge, its ground edge stitched with vias, a short 50 ohm feed
//                 over unbroken ground with a via fence and no layer change (Espressif hardware design guidelines,
//                 Johanson and Silicon Labs antenna notes).
//   high speed    every fast net over an unbroken ground plane, a ground via beside each layer change, pairs matched
//                 and coupled (Johnson and Graham, Bogatin, TI SPRAAR7).
//   power         a switching converter's input capacitor loop, switch node and feedback track (TI and ADI converter
//                 layout notes), thermal pad vias (TI SLMA002), a ground return at every decoupling capacitor.
//   analog, opto  quiet nets away from switch nodes, a photodiode's summing node short, guarded and alone (ADI,
//                 TI OPA85x), nothing under an isolator.
//   safety        conductor spacing for the voltage (IPC-2221 table 6-1).
// The written reference is server/docs/pcb-design-rules.md; the thresholds here are its numbers.  Every finding names
// the parts and nets and the harness call that fixes it.  `physicsPlan` works out where that copper goes (the vias of
// an antenna's ground edge, a fence along a net, a thermal pad's array) so the Python calls stay thin.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { netKind, pairName } from "../router/route";
import { stackupOf, traceOn, widthFor, z0 } from "../router/impedance";

type Level = "error" | "warning" | "note";
type Add = (rule: string, level: Level, message: string, items?: string[]) => void;
type Box = [number, number, number, number];
type Pt = [number, number];

/** The numbers the checks use (millimetres unless named otherwise); pcb-design-rules.md gives the source of each. */
export const LIMITS = {
  antennaClear: 0.5,        // no copper inside the antenna's courtyard grown by this (the datasheet's keep-out is usually larger)
  antennaKeepout: 2.0,      // what board.antenna() clears around the part by default
  antennaEdge: 3.0,         // an antenna further than this from every board edge is not at the edge
  fencePitch: 3.0,          // ground vias no further apart than a twentieth of a wavelength at 2.4 GHz in FR-4
  fenceReach: 2.5,          // a point of a ground edge or an RF track is fenced when a ground via is this close
  rfShort: 6.0,             // a feed shorter than a tenth of a wavelength: its impedance hardly matters
  impedanceTol: 0.2,        // an RF track's impedance may be this far from 50 ohm before it is reported
  returnVia: 5.08,          // a ground via within 200 mil of a fast net's layer change (TI SPRAAR7); closer is better
  usbSkew: 1.27,            // USB 2.0 pair length mismatch, 50 mil
  fastSkew: 0.13,           // USB 3, HDMI, PCIe, SATA, SGMII pair mismatch, 5 mil
  pairSkew: 0.5,            // any other pair
  crystalFar: 10,           // a crystal further than this from its oscillator pins
  crystalCap: 5,            // a load capacitor further than this from its crystal
  hotLoopCap: 3,            // a converter's input capacitor further than this from its VIN pin
  hotLoop: 10,              // VIN pin to capacitor to ground pin, around the loop
  switchNode: 12,           // length of track on a switch node
  bypassVia: 2.0,           // a decoupling capacitor's ground pad reaches the plane within this
  quiet: 0.5,               // analog or high-impedance copper this close to a switch node or another net
  highZLength: 10,          // length of a photodiode's summing node
  esdFar: 10,               // an ESD part further than this from the connector it protects
  thermalDrill: 0.33,       // a thermal via drill above this wicks solder out of the joint (TI SLMA002)
  thermalPitch: 1.2,        // pitch of a thermal pad's via array
};

export const PHYSICS_RULES: { id: string; what: string }[] = [
  { id: "antenna.keepout", what: "An antenna sits at a board edge with no copper under or around it on any layer" },
  { id: "antenna.fence", what: "The ground edge around an antenna's clear area is stitched with vias no more than a twentieth of a wavelength apart" },
  { id: "rf.feed", what: "An RF feed is short, one width, 50 ohm, on an outer layer with no via, bends gently, runs over unbroken ground and has ground vias down both sides" },
  { id: "stackup.reference", what: "Fast and RF signals have a ground plane on the layer next to them" },
  { id: "return.path", what: "Every fast net runs over unbroken ground for its whole length: never across a gap or a split in the plane" },
  { id: "return.vias", what: "A fast net that changes layer has a ground via beside the signal via for its return current" },
  { id: "pairs", what: "The two tracks of a differential pair are the same length, change layer together, run side by side and stay within the interface's length" },
  { id: "bus.match", what: "The lines of a memory or card bus (SD, eMMC, QSPI flash, DDR) are matched to their clock or strobe" },
  { id: "amplifier.input", what: "An amplifier's inverting input node is tiny: feedback parts at the pin, almost no track" },
  { id: "crystal", what: "A crystal sits against its oscillator pins with its load capacitors, over ground, with no via in its tracks and nothing routed under it" },
  { id: "switcher.loop", what: "A switching converter's input capacitor is at its VIN and ground pins, so the loop that carries the switched current is tiny" },
  { id: "switcher.node", what: "A converter's switch node is short and on one layer, and its feedback track keeps away from the switch node and the inductor" },
  { id: "bypass.return", what: "Every decoupling capacitor's ground pad reaches the ground plane right at the pad" },
  { id: "thermal.pad", what: "An exposed thermal pad is tied to the planes through an array of small vias" },
  { id: "esd.near", what: "ESD protection sits at the connector, before anything else on the line" },
  { id: "analog.separation", what: "Analog tracks keep away from switch nodes" },
  { id: "analog.highz", what: "A photodiode's or other high-impedance node is short, on one layer and has nothing routed beside it" },
  { id: "isolation", what: "Nothing crosses the gap under an optocoupler or isolator, on any layer" },
  { id: "creepage", what: "Conductors are spaced for the voltage between them (IPC-2221 table 6-1)" },
  { id: "dfm.via_in_pad", what: "No open via in a small part's solder pad" },
  { id: "flex.bend", what: "On a flex board nothing rigid sits where it bends: no vias, pads or parts, tracks straight across, no solid copper" },
  { id: "flex.copper", what: "A flex board's copper suits bending: tracks on the two sides staggered, copper back from the edge, few layers where it flexes" },
  { id: "stackup.material", what: "The board material suits the job: low-loss laminate for long gigahertz runs, one-sided copper on a metal core" },
];
export const PHYSICS_MANUAL = [
  "The antenna's datasheet layout was followed exactly (same ground size, same keep-out, same orientation), and the matching network was tuned on the finished board with a network analyser.",
  "Nothing metal (battery, shield can, connector shell, display, enclosure wall) is within about 15 mm of the antenna in the assembled product.",
  "Controlled-impedance tracks were sized with the fabricator's own stackup, and the order says which nets are controlled.",
  "Every IC's datasheet layout section was read and its example followed (regulators, radios, converters and precision amplifiers above all).",
  "Current-carrying tracks and vias are sized for their current and the allowed temperature rise (kh.calc.track_width, kh.calc.via_current).",
  "Mains or other hazardous voltages: creepage and clearance meet the safety standard for the product (IEC 62368-1 or 60664-1), which asks for more than IPC-2221.",
  "Precision analog: guard rings are driven at the potential of the node they guard, and the board is cleaned of flux where leakage matters.",
];
export const PHYSICS_SOURCE = "Layout physics: Espressif Hardware Design Guidelines (PCB layout); Johanson Technology and Silicon Labs AN1088 antenna layout notes; TI SPRAAR7 High-Speed Interface Layout Guidelines; TI SLMA002 PowerPAD; TI converter layout guidelines; ADI precision photodiode design; Johnson and Graham, High-Speed Digital Design; Bogatin, Signal and Power Integrity Simplified; Ott, Electromagnetic Compatibility Engineering; IPC-2221 table 6-1. Summarised in server/docs/pcb-design-rules.md.";

const GROUND = /^(?:[ADP]?GND\w*|GNDREF|VSS\w*|EARTH|0V)$/i;
const SUPPLY = /^(?:[+-]\d|\d+V\d*$|\d+(?:\.\d+)?V$|V(?:CC|DD|BUS|USB|BAT|IN|OUT|SYS|PP|AA|REF|MOTOR|S)\w*|VD?D?[A-Z]*_\w+|V\d+V?\d*|\w+_\d+V\d*$)/i;
const bare = (n: string) => n.replace(/^\/(.*\/)?/, "");
const isGnd = (n: string) => !!n && GROUND.test(bare(n));
const isSup = (n: string) => !!n && !isGnd(n) && SUPPLY.test(bare(n)) && !/_(EN|PG|FB|SENSE|OK)$/i.test(n);
const r2 = (v: number) => Math.round(v * 100) / 100;
const at = (x: number, y: number) => `(${r2(x)}, ${r2(y)})`;
const grow = (b: Box, m: number): Box => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const inBox = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const boxGap = (a: Box, b: Box) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
const rectShape = (b: Box) => ({ t: "rect", x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, w: b[2] - b[0], h: b[3] - b[1], rot: 0, rr: 0 });
const inPoly = (pts: Pt[], x: number, y: number) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

/** The voltage a net's name states (+48V, 12V0, VBUS, HV_400V); mains names count as their peak. */
export function netVolts(name: string): number | null {
  const n = bare(name);
  let m = /(-?\d+)V(\d+)(?!\d)/i.exec(n); if (m) return Number(`${m[1]}.${m[2]}`);
  m = /(-?\d+(?:\.\d+)?)\s*V(?![A-Za-z])/i.exec(n); if (m) return Number(m[1]);
  if (/^(AC_?[LN12]?|MAINS\w*|LINE|LIVE|NEUTRAL|VAC\w*|L_?IN|N_?IN|L|N)$/i.test(n)) return 325;
  if (/^V?(BUS|USB)\b|VBUS|VUSB/i.test(n)) return 5;
  if (/VBAT|LIPO|VCELL/i.test(n)) return 4.2;
  return null;
}

/** IPC-2221 table 6-1: the least spacing in mm between conductors with `volts` (DC or AC peak) between them.
 *  column: B1 internal layers, B2 external bare copper, B4 external under solder mask, A6 coated component leads,
 *  A7 bare component leads. */
export function ipcSpacing(volts: number, column: "B1" | "B2" | "B4" | "A6" | "A7" = "B4"): number {
  const bands = [15, 30, 50, 100, 150, 170, 250, 300, 500];
  const table: Record<string, number[]> = {
    B1: [0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.25], B2: [0.1, 0.1, 0.64, 0.64, 0.64, 1.25, 1.25, 1.25, 2.5], B4: [0.075, 0.075, 0.3, 0.3, 0.8, 0.8, 0.8, 0.8, 1.6],
    A6: [0.13, 0.13, 0.13, 0.13, 0.4, 0.4, 0.4, 0.4, 0.8], A7: [0.13, 0.25, 0.4, 0.5, 0.8, 0.8, 0.8, 0.8, 1.5],
  };
  const slope: Record<string, number> = { B1: 0.0025, B2: 0.005, B4: 0.00305, A6: 0.00305, A7: 0.00305 };
  const v = Math.abs(volts), row = table[column] || table.B4; const i = bands.findIndex((b) => v <= b);
  return i >= 0 ? row[i] : row[8] + (v - 500) * slope[column];
}

/** Routing rules of the common interfaces: z single-ended and zd differential impedance in ohm, skew within a pair,
 *  bus = match to the clock or strobe, max = longest run, all in mm; vias per track.  kicad_harness/physics.py has
 *  the same table with the notes (kh.calc.interface). */
export const INTERFACES: Record<string, { z: number | null; zd: number | null; skew: number | null; bus: number | null; max: number | null; vias: number | null }> = {
  usb2: { z: 45, zd: 90, skew: 1.27, bus: null, max: 300, vias: 4 }, usb3: { z: 45, zd: 90, skew: 0.13, bus: null, max: 140, vias: 2 },
  hdmi: { z: 50, zd: 100, skew: 0.13, bus: 2.5, max: 100, vias: 2 }, displayport: { z: 50, zd: 100, skew: 0.13, bus: 2.5, max: 150, vias: 2 },
  ethernet: { z: 50, zd: 100, skew: 1.27, bus: 2.5, max: 100, vias: 2 }, pcie: { z: 42.5, zd: 85, skew: 0.13, bus: null, max: 250, vias: 2 },
  sata: { z: 50, zd: 100, skew: 0.13, bus: null, max: 140, vias: 2 }, mipi: { z: 50, zd: 100, skew: 0.13, bus: 1.0, max: 250, vias: 2 },
  lvds: { z: 50, zd: 100, skew: 0.25, bus: 2.5, max: 300, vias: 2 }, can: { z: null, zd: 120, skew: null, bus: null, max: null, vias: null }, rs485: { z: null, zd: 120, skew: null, bus: null, max: null, vias: null },
  sdram: { z: 50, zd: null, skew: null, bus: 10, max: 150, vias: 2 }, ddr1: { z: 50, zd: 100, skew: 0.65, bus: 1.27, max: 150, vias: 2 }, ddr2: { z: 50, zd: 100, skew: 0.25, bus: 0.65, max: 125, vias: 2 },
  ddr3: { z: 40, zd: 80, skew: 0.13, bus: 0.5, max: 100, vias: 2 }, ddr4: { z: 40, zd: 80, skew: 0.13, bus: 0.25, max: 100, vias: 2 }, ddr5: { z: 40, zd: 75, skew: 0.13, bus: 0.13, max: 75, vias: 2 },
  lpddr4: { z: 40, zd: 80, skew: 0.13, bus: 0.25, max: 50, vias: 2 }, emmc: { z: 50, zd: null, skew: null, bus: 2.5, max: 100, vias: 2 }, sd: { z: 50, zd: null, skew: null, bus: 2.5, max: 100, vias: 2 },
  qspi: { z: 50, zd: null, skew: null, bus: 2.5, max: 50, vias: 2 }, spi: { z: null, zd: null, skew: null, bus: null, max: 150, vias: null }, i2c: { z: null, zd: null, skew: null, bus: null, max: null, vias: null },
  i2s: { z: null, zd: null, skew: null, bus: 5, max: 150, vias: null }, jtag: { z: null, zd: null, skew: null, bus: null, max: 150, vias: null }, rf: { z: 50, zd: null, skew: null, bus: null, max: null, vias: 0 },
};
/** The interface a differential pair belongs to, from its name; "" when the name does not say. */
export function pairInterface(name: string): string {
  const n = name.toUpperCase();
  if (/SS[TR]X|USB3|USB_?SS/.test(n)) return "usb3";
  if (/HDMI|TMDS/.test(n)) return "hdmi";
  if (/(^|_)E?DP\d?_?(ML|LANE|AUX|TX)|DISPLAYPORT/.test(n)) return "displayport";
  if (/PCIE|PEX|(^|_)PE[TR]|SGMII/.test(n)) return "pcie";
  if (/SATA/.test(n)) return "sata";
  if (/CSI|DSI|MIPI/.test(n)) return "mipi";
  if (/LVDS/.test(n)) return "lvds";
  if (/MDI|ETH|ENET|(^|_)T[RD]D?\d?_?$|(^|_)RD\d?_?$|PHY_?[TR]X/.test(n)) return "ethernet";
  if (/DQS|(^|_)CK\d?_?$|DDR|MEM_?CLK/.test(n)) return "ddr3";
  if (/USB|(^|_)U?D_?$|(^|_)D[PM]?_?$/.test(n)) return "usb2";
  return "";
}
/** The memory and card buses whose lines are matched to a clock or strobe: how to tell the bus, its clock and its data. */
const BUSES: { name: string; iface: string; bus: RegExp; clk: RegExp; data: RegExp }[] = [
  { name: "eMMC", iface: "emmc", bus: /^(E?MMC\d*)[_.]/i, clk: /^(CLK|CK|SCK)$/i, data: /^(D|DAT|DATA)\d$|^CMD$|^DS$/i },
  { name: "SD card", iface: "sd", bus: /^(U?SD(IO|MMC|HC)?\d*|TF)[_.]/i, clk: /^(CLK|CK|SCK)$/i, data: /^(D|DAT|DATA)\d$|^CMD$/i },
  { name: "flash", iface: "qspi", bus: /^((Q|O|X)SPI\d*|(SPI_?)?FLASH\d*|SPIQ|SPIHD)[_.]/i, clk: /^(S?CLK|SCK|CK)$/i, data: /^(IO|D|DQ|SIO|SD)\d$|^(MOSI|MISO|SDI|SDO|WP|HOLD)$/i },
];

/** The highest radio frequency the board works at, in GHz, read from its parts and net names (2.45 when nothing says). */
const FLEX_MATERIAL = /polyimide|kapton|^PI\b|\bFPC\b|flex/i, METAL_CORE = /alumin|copper core|metal core|IMS/i, BEND_NAME = /bend|flex|fold/i; const FLEX_EDGE = 0.3;
/** The board's physical stackup as the file has it: every layer top to bottom, the finish, and whether it had to be assumed. */
function physicalStack(doc: any, k: any): { rows: { name: string; type: string; copper: boolean; thickness: number; material: string; er: number; loss: number }[]; thickness: number; finish: string; assumed: boolean } {
  const st = doc.stackup || null; const rows: any[] = []; let finish = "None";
  if (st) {
    for (const l of k.kids(st, "layer")) {
      const name = k.str(l[1]); const groups: any[][] = [[]]; for (let j = 2; j < l.length; j++) { if (l[j] === "addsublayer") groups.push([]); else if (Array.isArray(l[j])) groups[groups.length - 1].push(l[j]); }
      const type = k.str((groups[0].find((c) => c[0] === "type") || [0, ""])[1]);
      for (const g of groups) { const v = (key: string) => { const c = g.find((q) => q[0] === key); return c ? c[1] : undefined; }; const t = Number(v("thickness")); if (!(t > 0)) continue;
        rows.push({ name, type, copper: type === "copper", thickness: t, material: v("material") === undefined ? "" : k.str(v("material")), er: Number(v("epsilon_r")) || 0, loss: Number(v("loss_tangent")) || 0 }); }
    }
    const cf = k.kid(st, "copper_finish"); if (cf) finish = k.str(cf[1]);
  }
  const have = rows.filter((r) => r.copper).length >= 2;
  return { rows: have ? rows : [], thickness: have ? r2(rows.reduce((a, r) => a + r.thickness, 0)) : 0, finish, assumed: !have };
}
function radioGHz(fps: { value: string; lib: string }[], nets: Iterable<string>): { ghz: number; why: string } {
  const text = fps.map((f) => f.value + " " + f.lib).join(" ") + " " + Array.from(nets).join(" ");
  const found: [number, string][] = [];
  if (/5\.?[0-9]?\s?GHZ|WIFI_?5G|5G_?WIFI|U-?NII|802\.11A[CX]?\b|UWB|DW1000|DW3/i.test(text)) found.push([5.8, "5 GHz"]);
  if (/2\.4|2450|BLE|BLUETOOTH|WIFI|WLAN|ESP32|ESP8266|ESP-|NRF5|NRF24|ZIGBEE|THREAD|CC25|CC26|RP2040W|CYW43|ATWINC/i.test(text)) found.push([2.45, "2.4 GHz"]);
  if (/GPS|GNSS|GLONASS|GALILEO|NEO-|MAX-M|L76|L80|L86|SAM-M|ATGM|TESEO|1575/i.test(text)) found.push([1.575, "GPS L1"]);
  if (/LTE|GSM|NB-?IOT|CAT-?M|SIM7|SIM8|BG9\d|EC2\d|SARA-|CELLULAR/i.test(text)) found.push([2.7, "cellular"]);
  if (/LORA|SX12[67]\d|RFM9\d|RFM6\d|LLCC68|STM32WL|RA-0\d|E22-|E220|915M|868M|SUB-?G|CC1[12]\d\d|SI44\d\d|RFM69/i.test(text)) found.push([0.915, "sub-GHz (LoRa, 868/915 MHz)"]);
  if (/433M|RFM9[68]|315M/i.test(text) && !found.length) found.push([0.433, "433 MHz"]);
  if (!found.length) return { ghz: 2.45, why: "2.4 GHz assumed" };
  found.sort((a, b) => b[0] - a[0]); return { ghz: found[0][0], why: found[0][1] };
}
/** A twentieth of a wavelength in FR-4, held to what a board can use (1 to 8 mm). */
const viaPitchFor = (ghz: number) => Math.max(1, Math.min(8, 299.79 / ghz / Math.sqrt(4.4) / 20));

interface Pad { number: string; x: number; y: number; net: string; fn: string; type: string; box: Box; layers: Set<string>; fp: Fp }
interface Fp { ref: string; value: string; lib: string; x: number; y: number; side: string; box: Box; pads: Pad[]; id: string }
interface Stitch { x: number; y: number }

/** Everything the checks and the plans read, gathered once. */
function survey(doc: any, P: any, k: any) {
  const copper: string[] = doc.copper && doc.copper.length ? doc.copper.slice() : ["F.Cu", "B.Cu"];
  const conds: any[] = P.conductors(doc); const NT = P.netTable(doc);
  const fps: Fp[] = []; const byId = new Map<string, Fp>(); const noCourtyard = new Set<Fp>(); const keepouts: { box: Box; layers: string[]; copper: boolean; name: string }[] = []; const zoneOutlines: { net: string; layers: string[]; pts: Pt[]; hatched?: boolean }[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; let zones = 0;
  const expand = (ls: string[]) => ls.flatMap((l) => (l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : l === "*.Cu" ? copper : [l]));
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.edge && it.bbox) { x0 = Math.min(x0, it.bbox[0]); y0 = Math.min(y0, it.bbox[1]); x1 = Math.max(x1, it.bbox[2]); y1 = Math.max(y1, it.bbox[3]); }
    if (it.kind === "footprint") {
      let cy: Box | null = null; try { const c = P.courtyards({ node: it.node }); let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity; for (const kk of Object.keys(c)) for (const loop of c[kk]) for (const q of loop) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); cc = Math.max(cc, q[0]); d = Math.max(d, q[1]); } if (a <= cc) cy = [a, b, cc, d]; } catch { /* no courtyard */ }
      const f: Fp = { ref: it.ref || "?", value: it.value || "", lib: it.lib || "", x: it.x, y: it.y, side: it.layer === "B.Cu" ? "back" : "front", box: (cy || it.bbox || [it.x - 0.5, it.y - 0.5, it.x + 0.5, it.y + 0.5]) as Box, pads: [], id: it.id };
      fps.push(f); byId.set(it.id, f); if (!cy) noCourtyard.add(f);
    } else if (it.kind === "zone") {
      const n = it.node; const ls = k.kid(n, "layers") || k.kid(n, "layer"); const layers = expand(ls ? ls.slice(1).map((x: any) => k.str(x)) : []);
      const poly = k.kid(n, "polygon"); const pts: Pt[] = poly ? k.ptsOf(poly) : []; if (!pts.length) continue;
      const ko = k.kid(n, "keepout");
      if (ko) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const q of pts) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } const cp = k.kid(ko, "copperpour"); const nm = k.kid(n, "name"); keepouts.push({ box: [a, b, c, d], layers, copper: !!cp && k.str(cp[1]) === "not_allowed", name: nm ? k.str(nm[1]) : "" }); }
      else { zones++; const nn = k.kid(n, "net_name"); const net = NT.key(P.netOf(n)) || (nn ? k.str(nn[1]) : ""); const fl = k.kid(n, "fill"); const md = fl ? k.kid(fl, "mode") : null; zoneOutlines.push({ net, layers, pts, hatched: !!md && k.str(md[1]) === "hatch" }); }
    }
  }
  const fills = new Map<string, { net: string; pts: Pt[]; box: Box }[]>(); let filled = 0;
  const tracks: any[] = [], vias: any[] = []; const stitches: Stitch[] = [];
  for (const c of conds) {
    if (c.kind === "pad") { const f = byId.get(c.item.id); if (!f) continue; const fnN = k.kid(c.pad.node, "pinfunction"); f.pads.push({ number: c.pad.number, x: c.pad.x, y: c.pad.y, net: c.net || "", fn: fnN ? k.str(fnN[1]) : "", type: c.pad.type, box: c.bbox, layers: c.layers, fp: f }); if (isGnd(c.net) && c.pad.type === "thru_hole") stitches.push({ x: c.pad.x, y: c.pad.y }); }
    else if (c.kind === "segment" || c.kind === "arc") tracks.push(c);
    else if (c.kind === "via") { vias.push(c); if (isGnd(c.net)) stitches.push({ x: c.shape.x, y: c.shape.y }); }
    else if (c.kind === "zone") { filled++; for (const l of c.layers) { const e = fills.get(l) || []; fills.set(l, e); e.push({ net: c.net, pts: c.shape.pts, box: c.bbox }); } }
  }
  for (const f of noCourtyard) { if (!f.pads.length) continue; let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of f.pads) { a = Math.min(a, p.box[0]); b = Math.min(b, p.box[1]); c = Math.max(c, p.box[2]); d = Math.max(d, p.box[3]); } f.box = [a - 0.25, b - 0.25, c + 0.25, d + 0.25]; }   // no courtyard: the pads' own extent, not the silkscreen text
  const outline: Box | null = isFinite(x0) ? [x0, y0, x1, y1] : null;
  /** What lies on a layer at a point: "gnd", "plane" (another net's pour) or "". */
  const pourAt = (x: number, y: number, layer: string): string => {
    let other = "";
    if (filled) { for (const f of fills.get(layer) || []) { if (!inBox(f.box, x, y) || !inPoly(f.pts, x, y)) continue; if (isGnd(f.net)) return "gnd"; other = "plane"; } return other; }
    for (const z of zoneOutlines) { if (!z.layers.includes(layer) || !inPoly(z.pts, x, y)) continue; if (isGnd(z.net)) return "gnd"; other = "plane"; }   // not filled yet: where the pour will be
    return other;
  };
  const gndLayersAt = (x: number, y: number) => copper.filter((l) => pourAt(x, y, l) === "gnd").length;
  const refLayers = (layer: string) => { const i = copper.indexOf(layer); return i < 0 ? [] : [copper[i - 1], copper[i + 1]].filter(Boolean) as string[]; };
  const nearestStitch = (x: number, y: number, skip?: Stitch) => { let d = Infinity; for (const s of stitches) { if (skip && Math.abs(s.x - skip.x) < 1e-6 && Math.abs(s.y - skip.y) < 1e-6) continue; d = Math.min(d, Math.hypot(s.x - x, s.y - y)); } return d; };
  /** Walk a track in steps: fn(x, y) at each. */
  const walk = (c: any, step: number, fn: (x: number, y: number) => void) => {
    const pts: Pt[] = c.shape.t === "seg" ? [c.shape.a, c.shape.b] : c.shape.pts;
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.round(L / step)); for (let j = 0; j < n; j++) { const t = (j + 0.5) / n; fn(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); } }
  };
  const tracksOf = new Map<string, any[]>(); for (const t of tracks) { if (!t.net) continue; const e = tracksOf.get(t.net) || []; tracksOf.set(t.net, e); e.push(t); }
  const viasOf = new Map<string, any[]>(); for (const v of vias) { if (!v.net) continue; const e = viasOf.get(v.net) || []; viasOf.set(v.net, e); e.push(v); }
  const padsOf = new Map<string, Pad[]>(); for (const f of fps) for (const p of f.pads) { if (!p.net) continue; const e = padsOf.get(p.net) || []; padsOf.set(p.net, e); e.push(p); }
  const lengthOf = (net: string) => (tracksOf.get(net) || []).reduce((a, t) => a + t.length, 0);
  return { copper, conds, fps, keepouts, zoneOutlines, zones, filled, outline, tracks, vias, stitches, pourAt, gndLayersAt, refLayers, nearestStitch, walk, tracksOf, viasOf, padsOf, lengthOf };
}
type Survey = ReturnType<typeof survey>;

const isConnector = (f: Fp) => /^(J|P|CN|X|USB)\d/i.test(f.ref) || /^Connector/i.test(f.lib);
const isAntenna = (f: Fp) => (/^(AE|ANT)\d/i.test(f.ref) || /antenna/i.test(f.lib + " " + f.value)) && !isConnector(f) && !/u\.?fl|sma|ipex|mmcx|coax/i.test(f.lib + " " + f.value);
const isCrystal = (f: Fp) => (/^(Y|XTAL)\d/i.test(f.ref) || /crystal|xtal|resonator/i.test(f.lib + " " + f.value)) && !f.pads.some((p) => isSup(p.net));
const isPowerInductor = (f: Fp) => /^L\d/i.test(f.ref) && (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) >= 4;
const isEsd = (f: Fp) => /(^|[^a-z])(tvs|esd)|usblc|prtr5v|tpd\d|sp05|pesd|srv05|ip4220|pusb|nup\d|rclamp|esda|sm[abc]j\d|smf\d/i.test(f.lib + " " + f.value);
const isIsolator = (f: Fp) => /isolator|optocoupl|opto_/i.test(f.lib) || /^(pc8\d\d|tlp\d|6n13\d|4n\d\d|hcpl|acpl|ltv-?\d|el8\d\d|fod\d|moc\d|vo\d{3}|iso\d{4}|adum\d|si8[6-9]\d|il7\d\d|sfh6\d)/i.test(f.value);
const isPhotodiode = (f: Fp) => /photo_?diode|bpw\d|sfh2\d|vemd\d|temd\d|vbpw|s1223|s1337|s5971|pin_?pd/i.test(f.lib + " " + f.value);
const isPatch = (f: Fp) => /patch/i.test(f.lib + " " + f.value);
const isOpamp = (f: Fp) => /^Amplifier_(Operational|Instrumentation|Current|Difference|Audio|Video|Buffer)/i.test(f.lib) || /^(OPA\d|LM358|LM324|LM29\d\d|LMV\d|LMC\d|LMH\d|TL0[678]\d|TLV\d{3,4}|TLC\d{3}|AD8\d|ADA4|LT\d{4}|LTC6\d|MCP6\d|NE553|MAX4\d|MAX9\d|INA\d|OP\d{2,3}[A-Z]|THS\d|NCS\d|TSV\d|OPAMP)/i.test(f.value);
const few = (l: string[], n = 8) => (l.length > n ? l.slice(0, n).concat(`and ${l.length - n} more`) : l);

/** The exposed pad of a package: its one large pad in the middle. */
function thermalPad(f: Fp): Pad | null {
  if (f.pads.length < 5) return null; const area = (p: Pad) => (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
  const sorted = f.pads.filter((p) => p.type === "smd").slice().sort((a, b) => area(b) - area(a)); if (sorted.length < 5) return null;
  const big = sorted[0], med = area(sorted[Math.floor(sorted.length / 2)]);
  if (area(big) < 2 || area(big) < 3 * med) return null;
  const w = f.box[2] - f.box[0], h = f.box[3] - f.box[1];
  return Math.abs(big.x - (f.box[0] + f.box[2]) / 2) < w / 4 && Math.abs(big.y - (f.box[1] + f.box[3]) / 2) < h / 4 ? big : null;
}

/** The area an antenna needs clear: its courtyard grown by `clear`, run out to the board edge where the edge is near. */
function antennaRegion(S: Survey, f: Fp, clear: number): Box {
  const b = grow(f.box, clear); const o = S.outline; if (!o) return b;
  const out: Box = [b[0], b[1], b[2], b[3]];
  if (b[0] - o[0] < LIMITS.antennaEdge) out[0] = o[0]; if (o[2] - b[2] < LIMITS.antennaEdge) out[2] = o[2];
  if (b[1] - o[1] < LIMITS.antennaEdge) out[1] = o[1]; if (o[3] - b[3] < LIMITS.antennaEdge) out[3] = o[3];
  return [Math.max(out[0], o[0]), Math.max(out[1], o[1]), Math.min(out[2], o[2]), Math.min(out[3], o[3])];
}
/** Points around a box, `off` outside it, about `pitch` apart, that lie on the board. */
function ringPoints(S: Survey, b: Box, off: number, pitch: number, margin: number): Pt[] {
  const g = grow(b, off), o = S.outline; const out: Pt[] = [];
  const side = (ax: number, ay: number, bx: number, by: number) => { const L = Math.hypot(bx - ax, by - ay); const n = Math.max(1, Math.ceil(L / pitch)); for (let i = 0; i < n; i++) out.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]); };
  side(g[0], g[1], g[2], g[1]); side(g[2], g[1], g[2], g[3]); side(g[2], g[3], g[0], g[3]); side(g[0], g[3], g[0], g[1]);
  return o ? out.filter(([x, y]) => x >= o[0] + margin && x <= o[2] - margin && y >= o[1] + margin && y <= o[3] - margin) : out;
}

export function reviewPhysics(doc: any, P: any, k: any, settings: any, add: Add): void {
  const S = survey(doc, P, k); const { copper, fps, tracksOf, viasOf, padsOf } = S;
  const gz = S.zones > 0; const twoGround = gz && copper.length >= 2;
  const pairBase = new Map<string, { p?: string; n?: string }>(); for (const net of padsOf.keys()) { const pn = pairName(net); if (!pn) continue; const e = pairBase.get(pn.base) || {}; pairBase.set(pn.base, e); if (pn.pol > 0) e.p = net; else e.n = net; }
  const paired = new Set<string>(); for (const e of pairBase.values()) if (e.p && e.n) { paired.add(e.p); paired.add(e.n); }
  const antennas = fps.filter(isAntenna);
  const feedNets = new Set<string>(); for (const a of antennas) for (const p of a.pads) if (p.net && !isGnd(p.net)) feedNets.add(p.net);
  const kindOf = (net: string) => (isGnd(net) ? "supply" : feedNets.has(net) ? "rf" : netKind(net, paired.has(net) || undefined));
  const rfNets = Array.from(padsOf.keys()).filter((n) => kindOf(n) === "rf"), fastNets = Array.from(padsOf.keys()).filter((n) => kindOf(n) === "fast");
  const radio = radioGHz(fps, padsOf.keys()); const pitch = r2(viaPitchFor(radio.ghz)), reach = pitch / 2 + 1, rfShort = Math.max(3, r2(pitch * 2));
  if (gz && !S.filled) add("return.path", "note", "The zones are not filled, so the ground checks below read each pour's outline instead of its real copper. Fill them first (board.fill()).");

  // ---- antennas: clear of copper, at an edge, their ground edge stitched
  const antRegions: Box[] = antennas.filter((a) => !isPatch(a)).map((a) => { const ko = S.keepouts.find((q) => q.copper && hit(q.box, a.box)); return grow(ko ? ko.box : antennaRegion(S, a, LIMITS.antennaClear), 0.3); });
  {
    const dirty: string[] = [], inland: string[] = [], open: string[] = [], bare_: string[] = [], thin: string[] = [], noGround: string[] = [];
    for (const a of antennas) {
      const own = new Set(a.pads.map((p) => p.net).filter(Boolean)); const core = grow(a.box, LIMITS.antennaClear), shape = rectShape(core); const what = new Set<string>();
      if (isPatch(a)) {      // a patch antenna is the opposite case: it works against the ground under it
        const cx = (a.box[0] + a.box[2]) / 2, cy = (a.box[1] + a.box[3]) / 2; if (gz && !copper.some((l) => S.pourAt(cx, cy, l) === "gnd")) noGround.push(`${a.ref}: no ground under it`);
        const ringP = ringPoints(S, a.box, 1.0, 0.5, 0.4).filter(([x, y]) => S.gndLayersAt(x, y) >= 2); if (ringP.length >= 4) { const gaps = ringP.filter(([x, y]) => S.nearestStitch(x, y) > reach); if (gaps.length > ringP.length * 0.5) thin.push(`${a.ref}: ${Math.round(gaps.length * 0.5)} mm of the ground round the patch has no via within ${r2(reach)} mm`); }
        continue;
      }
      for (const c of S.conds) {
        if (!hit(c.bbox, core)) continue;
        if (c.kind === "pad") { const f = c.item.id === a.id ? null : fps.find((q) => q.id === c.item.id); if (f) what.add(`${f.ref} sits in it`); continue; }
        if (c.kind !== "zone" && own.has(c.net)) continue;
        if (P.shapeGap(c.shape, shape) > 0) continue;
        what.add(c.kind === "zone" ? `${bare(c.net) || "copper"} pour on ${Array.from(c.layers).join(", ")}` : `${c.kind === "via" ? "a via" : "a track"} of ${bare(c.net) || "no net"}`);
      }
      if (what.size) dirty.push(`${a.ref}: ${Array.from(what).slice(0, 5).join("; ")}`);
      if (S.outline) { const o = S.outline; const d = Math.min(a.box[0] - o[0], o[2] - a.box[2], a.box[1] - o[1], o[3] - a.box[3]); if (d > LIMITS.antennaEdge) inland.push(`${a.ref} is ${r2(d)} mm from the nearest board edge`); }
      const ko = S.keepouts.find((q) => q.copper && hit(q.box, a.box));
      if (gz && !ko) open.push(a.ref);
      // the ground edge that faces the antenna
      const region = ko ? ko.box : antennaRegion(S, a, LIMITS.antennaClear);
      const ring = ringPoints(S, region, 1.0, 0.5, 0.4).filter(([x, y]) => S.gndLayersAt(x, y) >= 2);
      if (ring.length >= 4) { const gaps = ring.filter(([x, y]) => S.nearestStitch(x, y) > reach); if (gaps.length === ring.length) bare_.push(a.ref); else if (gaps.length > ring.length * 0.2) thin.push(`${a.ref}: ${Math.round(gaps.length * 0.5)} mm of ${Math.round(ring.length * 0.5)} mm of ground edge has no via within ${r2(reach)} mm, first near ${at(gaps[0][0], gaps[0][1])}`); }
    }
    if (dirty.length) add("antenna.keepout", "error", "There is copper in an antenna's clear area. An antenna radiates into the space around it: copper under or beside it, on any layer, detunes it and swallows the signal. Clear every layer (board.antenna(ref) adds the keep-out and refills).", dirty);
    if (inland.length) add("antenna.keepout", "warning", `An antenna belongs at a board edge, preferably a corner, pointing away from the rest of the board (within ${LIMITS.antennaEdge} mm of the edge).`, inland);
    if (open.length) add("antenna.keepout", "warning", "No keep-out area covers these antennas, so the next zone fill pours copper under them. board.antenna(ref) adds one on every layer.", open);
    if (bare_.length) add("antenna.fence", "error", `The ground around these antennas has no stitching vias. The edge of a ground pour that faces an antenna is part of the antenna: unstitched, the top and bottom pours are driven against each other and the edge radiates and resonates on its own. Tie the layers together along that edge with vias no more than ${pitch} mm apart (a twentieth of a wavelength; ${radio.why}): board.antenna(ref).`, bare_);
    if (thin.length) add("antenna.fence", "warning", `The ground edge around an antenna needs a via at least every ${pitch} mm (a twentieth of a wavelength; ${radio.why}). board.antenna(ref) fills the gaps.`, thin);
    if (noGround.length) add("antenna.keepout", "warning", "A patch antenna (GPS, GNSS) works against the ground plane under it: it needs unbroken ground beneath and around it, as large as its datasheet asks (often 50 mm square or more), not a keep-out.", noGround);
  }

  // ---- RF feeds
  {
    const stack = stackupOf(k, doc);
    for (const net of rfNets) {
      const segs = tracksOf.get(net) || []; if (!segs.length) continue; const name = bare(net); const L = S.lengthOf(net); const items: string[] = []; let level: Level = "warning";
      const nv = (viasOf.get(net) || []).length; if (nv) items.push(`${nv} via${nv > 1 ? "s" : ""}: an RF track stays on one outer layer`);
      const widths = Array.from(new Set(segs.map((t) => r2(t.width)))); if (widths.length > 1) items.push(`width changes (${widths.join(", ")} mm): every step is an impedance step`);
      const layers = Array.from(new Set(segs.flatMap((t) => Array.from(t.layers as Set<string>)))); if (layers.some((l) => l !== copper[0] && l !== copper[copper.length - 1])) items.push(`runs on ${layers.join(", ")}: keep it on an outer layer`);
      if (L > rfShort) { const tr = traceOn(stack, layers[0]); if (tr) { const z = z0(tr, widths[0]); if (Math.abs(z - 50) / 50 > LIMITS.impedanceTol) { const w = widthFor(tr, 50); items.push(`${r2(widths[0])} mm wide is about ${Math.round(z)} ohm over ${r2(tr.h)} mm of board${w ? `; 50 ohm needs ${r2(w)} mm` : ""}${tr.h > 0.5 ? " (a coplanar track with ground close beside it, a thinner board or four layers gets a practical width)" : ""}`); } } }
      // corners
      let sharp = 0; const ends: { p: Pt; d: Pt }[] = [];
      for (const t of segs) { if (t.shape.t !== "seg") continue; const a: Pt = t.shape.a, b: Pt = t.shape.b; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; ends.push({ p: a, d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] }, { p: b, d: [(a[0] - b[0]) / l, (a[1] - b[1]) / l] }); }
      for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) { if (Math.hypot(ends[i].p[0] - ends[j].p[0], ends[i].p[1] - ends[j].p[1]) > 1e-3) continue; const dot = ends[i].d[0] * ends[j].d[0] + ends[i].d[1] * ends[j].d[1]; if (dot > -0.7 && dot < 0.999) sharp++; }   // the two legs make less than 135 degrees
      if (sharp) items.push(`${sharp} sharp corner${sharp > 1 ? "s" : ""}: bend an RF track at 135 degrees or in an arc`);
      // ground under it and a fence beside it
      let n = 0, noRef = 0, noFence = 0; let first: Pt | null = null;
      for (const t of segs) { const refs = S.refLayers(Array.from(t.layers as Set<string>)[0]); S.walk(t, 0.5, (x, y) => { n++; if (antRegions.some((b) => inBox(b, x, y))) return;      // the last of the feed, inside the antenna's clear area, is part of the antenna
          if (refs.length && !refs.some((l) => S.pourAt(x, y, l) === "gnd")) { noRef++; if (!first) first = [x, y]; } if (S.nearestStitch(x, y) > Math.max(pitch, 2.5)) noFence++; }); }
      if (gz && noRef * 0.5 > 0.5 && first) { items.push(`${r2(noRef * 0.5)} mm of its ${r2(L)} mm has no ground under it on the next layer, first near ${at(first[0], first[1])}`); level = "error"; }
      if (twoGround && L > 3 && noFence > n * 0.3) items.push(`no ground via within ${Math.max(pitch, 2.5)} mm along ${Math.round(100 * noFence / n)} % of it: fence it (board.fence_net("${name}"))`);
      if (items.length) add("rf.feed", level, `RF net ${name} (${r2(L)} mm).`, items);
      const pads = padsOf.get(net) || [];
      if (pads.some((p) => isAntenna(p.fp)) && pads.some((p) => /^(U|IC)\d/i.test(p.fp.ref))) add("rf.feed", "note", `${name} runs straight from the chip to the antenna. Leave room for a pi matching network (a series part and a shunt to ground each side, placed at the antenna or the chip as its datasheet says) so the antenna can be tuned on the finished board.`);
    }
  }

  // ---- the reference plane
  const fastWithTracks = rfNets.concat(fastNets).filter((n) => (tracksOf.get(n) || []).length);
  if (fastWithTracks.length) {
    if (copper.length >= 4) { const o = S.outline; const probe: Pt[] = o ? [0.25, 0.5, 0.75].flatMap((u) => [0.25, 0.5, 0.75].map((v) => [o[0] + (o[2] - o[0]) * u, o[1] + (o[3] - o[1]) * v] as Pt)) : []; const hits = probe.filter(([x, y]) => S.pourAt(x, y, copper[1]) === "gnd").length; if (probe.length && hits < 5) add("stackup.reference", "warning", `${copper[1]}, the layer under the parts, is not a ground plane. On four layers make it one, unbroken (signal, ground, power, signal or signal, ground, ground, signal): board.layers(4, planes=["${copper[1]}"]) and board.zone("GND", layer="${copper[1]}").`); }
    else if (rfNets.some((n) => S.lengthOf(n) > rfShort)) { const st = stackupOf(k, doc); const tr = traceOn(st, copper[0]); if (tr && tr.h > 1.0) add("stackup.reference", "note", `A 50 ohm track on a two-layer ${r2(tr.h)} mm board is about ${r2(widthFor(tr, 50) || 3)} mm wide. Keep the feed shorter than ${rfShort} mm (a tenth of a wavelength; ${radio.why}), or use four layers (ground ${0.2} mm under the top) or a thinner board.`); }
  }
  {
    const cut: string[] = [], power: string[] = []; let noPlane = 0;
    for (const net of fastNets) {
      const segs = tracksOf.get(net) || []; if (!segs.length) continue; let n = 0, bad = 0, pl = 0; let first: Pt | null = null;
      for (const t of segs) { const refs = S.refLayers(Array.from(t.layers as Set<string>)[0]); if (!refs.length) continue; S.walk(t, 0.5, (x, y) => { n++; const what = refs.map((l) => S.pourAt(x, y, l)); if (what.includes("gnd")) return; if (what.includes("plane")) pl++; else { bad++; if (!first) first = [x, y]; } }); }
      if (!n) continue; if (!gz) { noPlane++; continue; }
      if (bad * 0.5 > Math.max(1, n * 0.05) && first) cut.push(`${bare(net)}: ${r2(bad * 0.5)} mm of ${r2(n * 0.5)} mm has no plane under it, first near ${at(first[0], first[1])}`);
      else if (pl > n * 0.5) power.push(bare(net));
    }
    if (noPlane) add("return.path", "warning", `${noPlane} fast net${noPlane > 1 ? "s run" : " runs"} on a board with no ground plane. A signal's return current flows in the plane directly under its track; with no plane it finds its own way round, and the loop it makes radiates and picks up noise. Pour ground on the layer next to the signals.`);
    if (cut.length) add("return.path", "warning", "These fast nets cross places with no ground on the layer next to them (a gap, a slot cut by other tracks, the edge of the pour). The return current has to detour round the gap, which makes a loop antenna and couples into every net that shares the detour. Move the track, close the gap, or route what cuts the plane somewhere else.", cut);
    if (power.length) add("return.path", "note", "These fast nets run over a supply pour instead of ground. It works only where that supply is tightly decoupled to ground at both ends of the track; ground is the better reference.", power);
  }
  if (twoGround) {
    const far: string[] = [];
    for (const net of rfNets.concat(fastNets)) for (const v of viasOf.get(net) || []) { const d = S.nearestStitch(v.shape.x, v.shape.y); if (d > LIMITS.returnVia) far.push(`${bare(net)} at ${at(v.shape.x, v.shape.y)}${isFinite(d) ? `: nearest ground via ${r2(d)} mm away` : ""}`); }
    if (far.length) add("return.vias", "warning", "Where a fast signal changes layer its return current must change planes too, and it can only do that through a ground via. Put one beside each of these signal vias, as close as fits (board.route(fence=...) does it while routing; board.via(\"GND\", (x, y)) by hand).", far);
  }

  // ---- differential pairs
  {
    const skew: string[] = [], vias: string[] = [], apart: string[] = [], long: string[] = [];
    for (const [base, e] of pairBase) {
      if (!e.p || !e.n) continue; const tp = tracksOf.get(e.p) || [], tn = tracksOf.get(e.n) || []; if (!tp.length || !tn.length) continue;
      const name = bare(base).replace(/[_\-]$/, "") || bare(e.p); const lp = S.lengthOf(e.p), ln = S.lengthOf(e.n);
      const ifc = pairInterface(bare(e.p)); const rule = ifc ? INTERFACES[ifc] : null; const label = ifc ? `${name} (${ifc})` : name;
      const limit = rule && rule.skew ? rule.skew : LIMITS.pairSkew;
      if (Math.abs(lp - ln) > limit + 1e-6) skew.push(`${label}: ${r2(lp)} mm and ${r2(ln)} mm, ${r2(Math.abs(lp - ln))} mm apart (limit ${limit} mm)`);
      if (rule && rule.max && Math.max(lp, ln) > rule.max) long.push(`${label}: ${r2(Math.max(lp, ln))} mm (at most about ${rule.max} mm)`);
      const vp = (viasOf.get(e.p) || []).length, vn = (viasOf.get(e.n) || []).length, vmax = rule && rule.vias ? rule.vias : 2;
      if (vp !== vn) vias.push(`${name}: ${vp} via${vp === 1 ? "" : "s"} on one track and ${vn} on the other`); else if (vp > vmax) vias.push(`${name}: ${vp} vias on each track (at most ${vmax})`);
      let n = 0, lone = 0; for (const t of tp) { const lay = Array.from(t.layers as Set<string>)[0]; const others = tn.filter((q) => q.layers.has(lay)); S.walk(t, 0.5, (x, y) => { n++; const reach = Math.max(1, 4 * t.width); if (!others.some((q) => P.shapeGap({ t: "circle", x, y, r: 0 }, q.shape) <= reach)) lone++; }); }
      if (lone * 0.5 > Math.max(3, n * 0.5 * 0.25)) apart.push(`${name}: ${r2(lone * 0.5)} mm of ${r2(lp)} mm runs without its partner beside it`);
    }
    if (skew.length) add("pairs", "warning", "The two tracks of a pair must be the same length, or the signal turns into common mode (noise out, noise in). Add a small serpentine to the shorter one at the end where the mismatch arises (board.route matches lengths when it routes the pair).", skew);
    if (vias.length) add("pairs", "warning", "Both tracks of a pair change layer together, at the same place, the same number of times, and as rarely as possible.", vias);
    if (long.length) add("pairs", "warning", "These pairs are longer than their interface is specified for on ordinary FR-4. Move the parts closer, or check the loss budget of the link.", long);
    if (apart.length) add("pairs", "warning", "A pair's tracks run side by side at a constant gap from pad to pad. These split up: move the parts in the pair's path so both tracks reach them in the same order.", apart);
  }

  // ---- memory and card buses: every line matched to its clock or strobe
  {
    const out: string[] = []; const routed = Array.from(tracksOf.keys());
    for (const b of BUSES) {
      const groups = new Map<string, { clk?: string; data: string[] }>();
      for (const net of routed) { const n = bare(net); const m = b.bus.exec(n); if (!m) continue; const rest = n.slice(m[0].length); const g = groups.get(m[1].toUpperCase()) || { data: [] }; groups.set(m[1].toUpperCase(), g); if (b.clk.test(rest)) g.clk = net; else if (b.data.test(rest)) g.data.push(net); }
      for (const [prefix, g] of groups) {
        if (!g.clk || g.data.length < 2) continue; const lim = INTERFACES[b.iface].bus as number, max = INTERFACES[b.iface].max as number; const lc = S.lengthOf(g.clk);
        const off = g.data.map((n) => ({ n, d: S.lengthOf(n) - lc })).filter((q) => Math.abs(q.d) > lim).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
        if (off.length) out.push(`${prefix} (${b.name}): clock ${r2(lc)} mm; ${off.slice(0, 4).map((q) => `${bare(q.n)} ${q.d > 0 ? "+" : ""}${r2(q.d)} mm`).join(", ")} (within ${lim} mm)`);
        const longest = Math.max(lc, ...g.data.map((n) => S.lengthOf(n))); if (longest > max) out.push(`${prefix} (${b.name}): ${r2(longest)} mm long (keep it under about ${max} mm)`);
      }
    }
    // DDR: each data line against the strobe of its byte lane, address and control against the clock
    const dq = routed.map((net) => ({ net, m: /^(.*?)_?DQ(\d+)$/i.exec(bare(net)) })).filter((q) => q.m);
    if (dq.length >= 8) {
      const strobe = (prefix: string, lane: number) => routed.find((n) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_?(L|U)?DQS_?${lane}?_?(P|T|\\+)?$`, "i").test(bare(n)) && (lane > 0 || !/DQS_?[1-9]/i.test(bare(n))));
      const gen = /DDR5/i.test(fps.map((f) => f.value).join(" ")) ? "ddr5" : /DDR4/i.test(fps.map((f) => f.value).join(" ")) ? "ddr4" : /DDR2/i.test(fps.map((f) => f.value).join(" ")) ? "ddr2" : "ddr3"; const lim = INTERFACES[gen].bus as number;
      const lanes = new Map<string, string[]>(); for (const q of dq) { const key = `${q.m![1]}|${Math.floor(Number(q.m![2]) / 8)}`; const l = lanes.get(key) || []; lanes.set(key, l); l.push(q.net); }
      for (const [key, nets] of lanes) { const [prefix, lane] = key.split("|"); const st = strobe(prefix, Number(lane)); if (!st) continue; const ls = S.lengthOf(st); const off = nets.map((n) => ({ n, d: S.lengthOf(n) - ls })).filter((q) => Math.abs(q.d) > lim); const lay = new Set(nets.flatMap((n) => (tracksOf.get(n) || []).flatMap((t) => Array.from(t.layers as Set<string>))));
        if (off.length) out.push(`${prefix || "DDR"} byte lane ${lane} (${gen}): strobe ${r2(ls)} mm; ${off.slice(0, 4).map((q) => `${bare(q.n)} ${q.d > 0 ? "+" : ""}${r2(q.d)} mm`).join(", ")} (within ${lim} mm)`);
        if (lay.size > 2) out.push(`${prefix || "DDR"} byte lane ${lane}: routed on ${Array.from(lay).join(", ")}; keep a byte lane on one layer (two at most, with equal vias)`); }
    }
    if (out.length) add("bus.match", "warning", "The lines of a clocked bus must arrive together. Match each data line to its clock or strobe by lengthening the short ones with a gentle serpentine, away from the clock.", out);
  }

  // ---- amplifier inputs
  {
    const out: string[] = [];
    for (const u of fps.filter(isOpamp)) for (const p of u.pads) {
      if (!/^(-|IN-|-IN|INN|IN_N|VIN-|INM|IN\d-|-IN[A-D]?|IN[A-D]-|\d?IN-)$/i.test(p.fn) || !p.net || isGnd(p.net) || isSup(p.net)) continue;
      const L = S.lengthOf(p.net); if (L > 8) out.push(`${u.ref}.${p.number} (${bare(p.net)}): ${r2(L)} mm of track on the inverting input`);
      const farP = (padsOf.get(p.net) || []).filter((q) => /^(R|C)\d/i.test(q.fp.ref) && Math.hypot(q.x - p.x, q.y - p.y) > 6).map((q) => q.fp.ref);
      if (farP.length) out.push(`${u.ref}.${p.number} (${bare(p.net)}): ${Array.from(new Set(farP)).slice(0, 4).join(", ")} more than 6 mm from the pin`);
      const nv = (viasOf.get(p.net) || []).length; if (nv > 1) out.push(`${u.ref}.${p.number} (${bare(p.net)}): ${nv} vias on the inverting input`);
    }
    if (out.length) add("amplifier.input", "warning", "An amplifier's inverting input is its summing node: capacitance there adds a pole inside the feedback loop (peaking, ringing, oscillation) and the node picks up everything near it. Put the feedback and gain parts right at the pin, keep the track a few millimetres long, and for a fast amplifier clear the planes under it.", out);
  }

  // ---- crystals
  {
    const out: string[] = [];
    for (const y of fps.filter(isCrystal)) {
      const sig = y.pads.filter((p) => p.net && !isGnd(p.net)); if (!sig.length) continue; const nets = new Set(sig.map((p) => p.net));
      for (const p of sig) {
        const ic = (padsOf.get(p.net) || []).filter((q) => /^(U|IC)\d/i.test(q.fp.ref));
        for (const q of ic) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d > LIMITS.crystalFar) out.push(`${y.ref}: ${r2(d)} mm from ${q.fp.ref}.${q.number}; a crystal sits right at its oscillator pins`); }
        const nv = (viasOf.get(p.net) || []).length; if (nv) out.push(`${y.ref}: ${nv} via${nv > 1 ? "s" : ""} in ${bare(p.net)}; a crystal's tracks stay on the part's layer`);
        for (const c of (padsOf.get(p.net) || []).filter((q) => /^C\d/i.test(q.fp.ref))) { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d > LIMITS.crystalCap) out.push(`${y.ref}: load capacitor ${c.fp.ref} is ${r2(d)} mm away; it belongs beside the crystal with its ground at the crystal's ground`); }
      }
      const under = new Set<string>(); const shape = rectShape(y.box);
      for (const c of S.conds) { if (c.kind !== "segment" && c.kind !== "arc" && c.kind !== "via") continue; if (!c.net || nets.has(c.net) || isGnd(c.net) || !hit(c.bbox, y.box)) continue; if (P.shapeGap(c.shape, shape) <= 0) under.add(bare(c.net)); }
      if (under.size) out.push(`${y.ref}: ${Array.from(under).slice(0, 5).join(", ")} routed under or through it; keep every other signal out from under a crystal, on every layer`);
      if (gz && copper.length >= 2) { const cx = (y.box[0] + y.box[2]) / 2, cy = (y.box[1] + y.box[3]) / 2; const lay = y.side === "back" ? copper[copper.length - 1] : copper[0]; if (!S.refLayers(lay).some((l) => S.pourAt(cx, cy, l) === "gnd")) out.push(`${y.ref}: no ground under it on the next layer`); }
      for (const l of fps.filter(isPowerInductor)) { const d = boxGap(l.box, y.box); if (d < 5) out.push(`${y.ref}: inductor ${l.ref} is ${r2(d)} mm away; keep magnetic parts away from a crystal`); }
    }
    if (out.length) add("crystal", "warning", "A crystal's two nodes are the most sensitive on a digital board: a few picofarads or a little coupled noise shifts or stops the oscillator.", out);
  }

  // ---- switching converters
  {
    const loop: string[] = [], node: string[] = []; const inductors = fps.filter(isPowerInductor);
    const swNets = Array.from(padsOf.keys()).filter((n) => kindOf(n) === "switching");
    for (const sw of swNets) {
      const pads = padsOf.get(sw) || []; const lp = pads.find((p) => /^L\d/i.test(p.fp.ref)), up = pads.find((p) => /^(U|IC)\d/i.test(p.fp.ref)); if (!lp || !up) continue;
      const reg = up.fp, ind = lp.fp; const outNet = (ind.pads.find((p) => p.net !== sw) || { net: "" }).net;
      const gndPads = reg.pads.filter((p) => isGnd(p.net));
      let vin = reg.pads.filter((p) => /^(P?VIN|IN|PVDD|AVIN|VCC|VDD|VS|SUP)\d*$/i.test(p.fn) && p.net && !isGnd(p.net) && p.net !== outNet);
      if (!vin.length) vin = reg.pads.filter((p) => isSup(p.net) && p.net !== outNet);
      const seen = new Set<string>();
      for (const v of vin) {
        if (seen.has(v.net)) continue; seen.add(v.net); let best = Infinity, cap: Pad | null = null, capGnd: Pad | null = null;
        for (const c of (padsOf.get(v.net) || []).filter((q) => /^C\d/i.test(q.fp.ref))) { const g = c.fp.pads.find((q) => isGnd(q.net)); if (!g) continue; const near = Math.min(...reg.pads.filter((q) => q.net === v.net).map((q) => Math.hypot(q.x - c.x, q.y - c.y))); if (near < best) { best = near; cap = c; capGnd = g; } }
        if (!cap || !capGnd) { loop.push(`${reg.ref}: no capacitor from ${bare(v.net)} to ground`); continue; }
        const back = gndPads.length ? Math.min(...gndPads.map((q) => Math.hypot(q.x - capGnd!.x, q.y - capGnd!.y))) : 0; const round = best + back + Math.hypot(cap.x - capGnd.x, cap.y - capGnd.y);
        if (best > LIMITS.hotLoopCap) loop.push(`${reg.ref}: input capacitor ${cap.fp.ref} is ${r2(best)} mm from the ${bare(v.net)} pin (at most ${LIMITS.hotLoopCap} mm)`);
        else if (round > LIMITS.hotLoop) loop.push(`${reg.ref}: the loop ${bare(v.net)} pin, ${cap.fp.ref}, ground pin is ${r2(round)} mm round (at most ${LIMITS.hotLoop} mm); turn ${cap.fp.ref} so its ground pad faces the ground pin`);
      }
      const len = S.lengthOf(sw); if (len > LIMITS.switchNode) node.push(`${bare(sw)}: ${r2(len)} mm of track; move ${ind.ref} against ${reg.ref}`);
      const nv = (viasOf.get(sw) || []).length; if (nv) node.push(`${bare(sw)}: ${nv} via${nv > 1 ? "s" : ""}; keep the switch node on one layer`);
      const swCopper = S.conds.filter((c) => c.net === sw && c.kind !== "zone");
      for (const fbp of reg.pads.filter((p) => /^(V?FB|VSENSE|VOS|ADJ)\d*$/i.test(p.fn) || /(^|[_\-.])V?FB\d*$/i.test(bare(p.net)))) {
        const segs = tracksOf.get(fbp.net) || []; let close = false, over = false;
        for (const t of segs) { if (swCopper.some((c) => [...c.layers].some((l: string) => t.layers.has(l)) && c.kind !== "pad" && P.shapeGap(t.shape, c.shape) < LIMITS.quiet)) close = true; if (hit(t.bbox, ind.box) && P.shapeGap(t.shape, rectShape(ind.box)) <= 0) over = true; }
        if (close) node.push(`${bare(fbp.net)}: the feedback track runs within ${LIMITS.quiet} mm of ${bare(sw)}`); if (over) node.push(`${bare(fbp.net)}: the feedback track passes under ${ind.ref}`);
      }
    }
    for (const l of inductors.filter((q) => q.pads.some((p) => kindOf(p.net) === "switching"))) for (const a of antennas) { const d = boxGap(l.box, a.box); if (d < 10) node.push(`${l.ref} is ${r2(d)} mm from antenna ${a.ref}; put the converter at the far end of the board`); }
    if (loop.length) add("switcher.loop", "warning", "In a switching converter the full load current is switched on and off in the loop from the input capacitor through the switches and back, in nanoseconds. That loop is the board's loudest transmitter: make it as small as the parts allow, capacitor right at the VIN and ground pins, on the same layer, with wide copper.", loop);
    if (node.length) add("switcher.node", "warning", "The switch node swings the full input voltage at every cycle. Keep its copper short and just wide enough for the current, and take the feedback from the output capacitor along a quiet path.", node);
  }

  // ---- decoupling return, thermal pads, via in pad
  {
    const epads = new Map<Pad, Fp>(); for (const f of fps) { const e = thermalPad(f); if (e) epads.set(e, f); }
    if (gz) {
      const lost: string[] = []; const ics = fps.filter((f) => /^(U|IC)\d/i.test(f.ref));
      for (const c of fps.filter((f) => /^C\d/i.test(f.ref) && f.pads.length === 2)) {
        const g = c.pads.find((p) => isGnd(p.net)), s = c.pads.find((p) => p.net && !isGnd(p.net)); if (!g || !s) continue;
        if (!ics.some((u) => u.pads.some((p) => p.net === s.net && Math.hypot(p.x - s.x, p.y - s.y) < 5))) continue;
        const lay = c.side === "back" ? copper[copper.length - 1] : copper[0];
        if (S.pourAt(g.x, g.y, lay) === "gnd" && (copper.length < 3 || S.nearestStitch(g.x, g.y) <= LIMITS.bypassVia * 2)) continue;
        if (S.nearestStitch(g.x, g.y) <= LIMITS.bypassVia) continue;
        lost.push(`${c.ref} (${bare(s.net)}) at ${at(g.x, g.y)}`);
      }
      if (lost.length) add("bypass.return", "warning", `A decoupling capacitor only works through a short loop: supply pin, capacitor, ground, and back to the chip's ground. These capacitors' ground pads are not in the ground pour and have no ground via within ${LIMITS.bypassVia} mm. Put a via to the plane right at each ground pad (board.via("GND", (x, y))).`, lost);
    }
    if (copper.length >= 2) {
      const none: string[] = [], fewV: string[] = [], wide: string[] = [];
      for (const [e, f] of epads) {
        const inside = S.vias.filter((v) => inBox(e.box, v.shape.x, v.shape.y)); const area = (e.box[2] - e.box[0]) * (e.box[3] - e.box[1]); const need = Math.max(1, Math.min(9, Math.floor(area / 1.5)));
        if (!inside.length) none.push(`${f.ref} ${f.value} pad ${e.number} (${r2(e.box[2] - e.box[0])} x ${r2(e.box[3] - e.box[1])} mm, ${bare(e.net) || "no net"})`);
        else if (inside.length < need) fewV.push(`${f.ref} pad ${e.number}: ${inside.length} via${inside.length > 1 ? "s" : ""}, room for ${need}`);
        const big = inside.filter((v) => v.drill > LIMITS.thermalDrill + 1e-6); if (big.length) wide.push(`${f.ref} pad ${e.number}: ${big[0].drill} mm drill`);
      }
      if (none.length) add("thermal.pad", "warning", "An exposed pad is the package's heat path and usually its main ground. Tie it to the planes with an array of vias inside the pad (board.thermal_vias(ref)); connect them to the plane solidly, not through thermal spokes.", none);
      if (fewV.length) add("thermal.pad", "note", `More vias carry more heat: five to nine suit a small package, on about a ${LIMITS.thermalPitch} mm pitch (board.thermal_vias(ref)).`, fewV);
      if (wide.length) add("thermal.pad", "note", `Vias in a solder pad wick solder away from the joint. Keep their drill at ${LIMITS.thermalDrill} mm or less, or have them plugged or tented from the far side.`, wide);
    }
    const inPad: string[] = [];
    for (const f of fps) { if (f.pads.length > 3) continue; for (const p of f.pads) { if (p.type !== "smd" || epads.has(p)) continue; const a = (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]); if (a > 4) continue; if (S.vias.some((v) => inBox(p.box, v.shape.x, v.shape.y))) inPad.push(`${f.ref}.${p.number}`); } }
    if (inPad.length) add("dfm.via_in_pad", "warning", "A via in a small part's solder pad drains the solder and stands the part on end (tombstoning) unless the fabricator fills and caps it, which costs extra. Move the via just off the pad on a short track.", inPad);
  }

  // ---- flex boards and the board material
  {
    const lyr = (t: any): string => Array.from(t.layers as Set<string>)[0]; const st = physicalStack(doc, k); const flex = st.rows.some((r) => !r.copper && FLEX_MATERIAL.test(r.material));
    const bends = S.keepouts.filter((q) => BEND_NAME.test(q.name));
    if (flex || bends.length) {
      const total = st.thickness || doc.thickness || 0; const rmin = total ? r2(total * (copper.length <= 1 ? 6 : 10)) : 0;
      if (!bends.length) add("flex.bend", "note", "This is a flex board with no bend area marked. Mark where it bends (board.bend_area(box)): vias and parts are then kept out of it, and the review checks the copper that crosses it." + (rmin ? ` At ${r2(total)} mm thick it should bend no tighter than a ${rmin} mm radius once (about ${r2(total * 15)} mm if it flexes in use).` : ""));
      const rigid: string[] = [], corners: string[] = [], solid: string[] = [], stacked: string[] = [];
      for (const b of bends) {
        const where = `the bend area at ${at((b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2)}`;
        for (const v of S.vias) if (inBox(b.box, v.shape.x, v.shape.y)) rigid.push(`via at ${at(v.shape.x, v.shape.y)} (${bare(v.net) || "no net"})`);
        for (const f of fps) { if (hit(f.box, b.box)) rigid.push(`${f.ref} ${f.value}`.trim() + ` is in ${where}`); }
        const inside = S.tracks.filter((t) => hit(t.bbox, b.box));
        // a track should cross the bend straight: a corner inside it concentrates the strain
        const ends = new Map<string, number[]>();
        for (const t of inside) { if (t.shape.t !== "seg") { corners.push(`${bare(t.net)}: a curved track in ${where}`); continue; } const dir = Math.atan2(t.shape.b[1] - t.shape.a[1], t.shape.b[0] - t.shape.a[0]); for (const q of [t.shape.a, t.shape.b]) { if (!inBox(b.box, q[0], q[1])) continue; const key = `${t.net}|${lyr(t)}|${Math.round(q[0] * 100)}|${Math.round(q[1] * 100)}`; const e = ends.get(key) || []; ends.set(key, e); e.push(dir); } }
        const bent = new Set<string>(); for (const [key, dirs] of ends) if (dirs.length > 1 && dirs.some((d) => Math.abs(Math.sin(d - dirs[0])) > 0.09)) bent.add(key.split("|")[0]);
        for (const n of bent) corners.push(`${bare(n)} turns a corner inside ${where}`);
        // tracks directly over each other on the two sides make an I-beam that cracks: stagger them
        const top = inside.filter((t) => lyr(t) === copper[0] && t.shape.t === "seg"), bot = inside.filter((t) => lyr(t) === copper[copper.length - 1] && t.shape.t === "seg"); const beams = new Set<string>();
        for (const a of top) for (const c of bot) { if (!hit(a.bbox, c.bbox)) continue; const mx = (a.shape.a[0] + a.shape.b[0]) / 2, my = (a.shape.a[1] + a.shape.b[1]) / 2; const dx = c.shape.b[0] - c.shape.a[0], dy = c.shape.b[1] - c.shape.a[1]; const L = Math.hypot(dx, dy) || 1; const off = Math.abs((mx - c.shape.a[0]) * dy - (my - c.shape.a[1]) * dx) / L; const para = Math.abs(Math.sin(Math.atan2(dy, dx) - Math.atan2(a.shape.b[1] - a.shape.a[1], a.shape.b[0] - a.shape.a[0]))) < 0.09; if (para && off < ((a.shape.r || 0.1) + (c.shape.r || 0.1)) / 2) beams.add(`${bare(a.net)} over ${bare(c.net)}`); }
        for (const x of beams) stacked.push(`${x} in ${where}`);
        for (const z of S.zoneOutlines) { if (z.hatched) continue; let a = Infinity, bb = Infinity, c = -Infinity, d = -Infinity; for (const q of z.pts) { a = Math.min(a, q[0]); bb = Math.min(bb, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } if (hit([a, bb, c, d], b.box)) solid.push(`the ${bare(z.net) || "unconnected"} pour on ${z.layers.join(", ")} crosses ${where}`); }
      }
      if (rigid.length) add("flex.bend", "error", "Vias, pads and parts do not bend: a plated hole or a solder joint in a bend area cracks. Move them onto a part of the board that stays flat, or onto a stiffener.", few(rigid));
      if (corners.length) add("flex.bend", "warning", "Run tracks straight across a bend, at right angles to the fold line, and turn corners outside it. A corner inside the bend concentrates the strain where the copper is weakest.", few(corners));
      if (stacked.length) add("flex.copper", "warning", "Tracks lie directly over each other on the two sides of the bend (an I-beam). That stiffens the fold and cracks the outer copper: stagger them so each sits over the gap between the tracks on the other side.", few(stacked));
      if (solid.length) add("flex.bend", "warning", "A solid copper pour across a bend is stiff and cracks. Use a hatched (cross-hatch) pour there, or keep the pour out of the bend area and carry ground across on a wide track.", few(solid));
      if (bends.length && copper.length > 2) add("flex.copper", "warning", `The board has ${copper.length} copper layers and a bend area. Keep the bending part to one or two layers (the fabricator can leave the inner layers out of that region); bend radius grows with every layer.`);
      if (S.outline) { const o = S.outline; const near: string[] = []; for (const t of S.tracks) { const d = Math.min(t.bbox[0] - o[0], o[2] - t.bbox[2], t.bbox[1] - o[1], o[3] - t.bbox[3]); if (d < FLEX_EDGE - 1e-6) near.push(`${bare(t.net)} on ${lyr(t)}: ${r2(Math.max(0, d))} mm from the edge`); if (near.length > 12) break; } if (near.length) add("flex.copper", "warning", `Copper on a flex board stays at least ${FLEX_EDGE} mm from the outline (JLCPCB's flex limit); a tear starts where copper meets the cut edge.`, few(near)); }
    }
    const metal = st.rows.find((r) => !r.copper && METAL_CORE.test(r.material));
    if (metal) {
      const back = S.tracks.filter((t) => lyr(t) !== copper[0]).length, through = S.vias.length + fps.reduce((a, f) => a + f.pads.filter((p) => p.type === "thru_hole").length, 0);
      if (back || through) add("stackup.material", "error", `The board is on a ${metal.material} core, which is one-sided: the copper is on the front only and a plated hole would short to the metal. Take away the ${back ? `${back} track${back > 1 ? "s" : ""} off the front layer` : ""}${back && through ? " and the " : ""}${through ? `${through} via${through > 1 ? "s" : ""} or through-hole pad${through > 1 ? "s" : ""}` : ""}, and use surface-mount parts only.`);
    }
    if (!st.assumed && radio.ghz >= 1) {
      const lossy = st.rows.find((r) => !r.copper && r.loss >= 0.015); const long: string[] = [];
      for (const n of rfNets) { const L = S.lengthOf(n); if (L > 300 / (radio.ghz * 2)) long.push(`${bare(n)}: ${r2(L)} mm at ${radio.ghz} GHz`); }
      if (lossy && long.length) add("stackup.material", "note", `These radio tracks are long for ${lossy.material || "FR-4"} (loss tangent ${lossy.loss}): standard FR-4 loses roughly 0.1 to 0.3 dB per 25 mm at 2.4 GHz and more above. Shorten them, or build the board on a low-loss laminate (kh.materials: Rogers RO4350B, PTFE).`, long);
    }
  }

  // ---- ESD protection at the connector
  {
    const out: string[] = [];
    for (const d of fps.filter(isEsd)) for (const p of d.pads) {
      if (!p.net || isGnd(p.net)) continue; const on = padsOf.get(p.net) || []; const conn = on.filter((q) => q.fp !== d && isConnector(q.fp)); if (!conn.length) continue;
      const dc = Math.min(...conn.map((q) => Math.hypot(q.x - p.x, q.y - p.y))); const ic = on.filter((q) => /^(U|IC)\d/i.test(q.fp.ref) && q.fp !== d); const di = ic.length ? Math.min(...ic.map((q) => Math.hypot(q.x - p.x, q.y - p.y))) : Infinity;
      if (dc > LIMITS.esdFar || dc > di) { out.push(`${d.ref} on ${bare(p.net)}: ${r2(dc)} mm from ${conn[0].fp.ref}${isFinite(di) && dc > di ? `, nearer to ${ic[0].fp.ref} (${r2(di)} mm)` : ""}`); break; }
    }
    if (out.length) add("esd.near", "warning", "An ESD strike must meet the protection before it meets anything else. Put the protection part right at the connector, with the track running connector, protection, then chip, and its ground straight into the plane.", out);
  }

  // ---- analog and high-impedance nodes
  {
    const swCopper = S.conds.filter((c) => c.net && c.kind !== "zone" && c.kind !== "pad" && kindOf(c.net) === "switching");
    const near: string[] = [];
    if (swCopper.length) for (const [net, segs] of tracksOf) { if (kindOf(net) !== "analog") continue; let worst = Infinity, who = ""; for (const t of segs) for (const c of swCopper) { if (![...c.layers].some((l: string) => t.layers.has(l)) || boxGap(t.bbox, c.bbox) > LIMITS.quiet) continue; const g = P.shapeGap(t.shape, c.shape); if (g < worst) { worst = g; who = bare(c.net); } } if (worst < LIMITS.quiet) near.push(`${bare(net)}: ${r2(worst)} mm from ${who}`); }
    if (near.length) add("analog.separation", "warning", `Analog tracks pick up whatever switches next to them. Keep them at least ${LIMITS.quiet} mm from a switch node, further where there is room, and never parallel to it (board.route(separate=...) holds the gap while routing).`, near);
    const hz: string[] = [];
    for (const d of fps.filter(isPhotodiode)) for (const p of d.pads) {
      if (!p.net || isGnd(p.net) || isSup(p.net)) continue; const segs = tracksOf.get(p.net) || []; const name = bare(p.net); const L = S.lengthOf(p.net);
      if (L > LIMITS.highZLength) hz.push(`${d.ref} ${name}: ${r2(L)} mm of track; put the amplifier's input right at the photodiode`);
      const nv = (viasOf.get(p.net) || []).length; if (nv) hz.push(`${d.ref} ${name}: ${nv} via${nv > 1 ? "s" : ""}; keep the photodiode and its amplifier on one side`);
      const beside = new Set<string>(); for (const t of segs) for (const c of S.conds) { if (c.kind === "zone" || c.kind === "pad" || !c.net || c.net === p.net || isGnd(c.net) || ![...c.layers].some((l: string) => t.layers.has(l)) || boxGap(t.bbox, c.bbox) > LIMITS.quiet) continue; if (P.shapeGap(t.shape, c.shape) < LIMITS.quiet) beside.add(bare(c.net)); }
      if (beside.size) hz.push(`${d.ref} ${name}: ${Array.from(beside).slice(0, 4).join(", ")} within ${LIMITS.quiet} mm; leave a wide routing keep-out round it, or a guard track driven at the node's own potential`);
    }
    if (hz.length) add("analog.highz", "warning", "A photodiode's output is a current of nanoamps into a node of very high impedance: every picofarad on it costs bandwidth and adds noise, and any leakage across the board is signal.", hz);
  }

  // ---- isolation gaps
  {
    const bridged: string[] = [], shared: string[] = [];
    for (const f of fps.filter(isIsolator)) {
      if (f.pads.length < 4) continue;
      const gapOn = (axis: 0 | 1) => { const ps = f.pads.slice().sort((a, b) => (axis ? a.y - b.y : a.x - b.x)); let best = 0, cut = -1; for (let i = 1; i < ps.length; i++) { const g = axis ? ps[i].box[1] - ps[i - 1].box[3] : ps[i].box[0] - ps[i - 1].box[2]; if (g > best) { best = g; cut = i; } } return { best, lo: ps.slice(0, cut), hi: ps.slice(cut) }; };
      const gx = gapOn(0), gy = gapOn(1); const axis = gx.best >= gy.best ? 0 : 1; const g = axis ? gy : gx; if (g.best < 1 || !g.lo.length || !g.hi.length) continue;
      const a = Math.max(...g.lo.map((p) => p.box[axis + 2])), b = Math.min(...g.hi.map((p) => p.box[axis]));
      const strip: Box = axis ? [f.box[0], a + 0.1, f.box[2], b - 0.1] : [a + 0.1, f.box[1], b - 0.1, f.box[3]]; const shape = rectShape(strip); const what = new Set<string>();
      for (const c of S.conds) { if (c.kind === "pad" && c.item.id === f.id) continue; if (!hit(c.bbox, strip) || P.shapeGap(c.shape, shape) > 0) continue; what.add(c.kind === "zone" ? `${bare(c.net) || "copper"} pour on ${Array.from(c.layers).join(", ")}` : `${bare(c.net) || "copper"} ${c.kind}`); }
      if (what.size) bridged.push(`${f.ref} ${f.value} (${r2(b - a)} mm gap): ${Array.from(what).slice(0, 4).join("; ")}`);
      const lo = new Set(g.lo.map((p) => p.net).filter(Boolean)); const both = Array.from(new Set(g.hi.map((p) => p.net).filter((n) => n && lo.has(n))));
      if (both.length) shared.push(`${f.ref}: ${both.map(bare).join(", ")} on both sides`);
    }
    if (bridged.length) add("isolation", "error", "There is copper in the gap under an isolator. The gap between its two pin rows is the isolation barrier: any copper in it, on any layer, shortens the creepage path to less than the part's own rating. Keep every layer clear between the rows (board.keepout(box)), and for mains consider a slot in the board there.", bridged);
    if (shared.length) add("isolation", "warning", "The same net is on both sides of an isolator, so nothing is isolated. Each side needs its own supply and its own ground.", shared);
  }

  // ---- spacing for the voltage
  {
    const hv = new Map<string, number>(); for (const net of padsOf.keys()) { if (isGnd(net)) continue; const v = netVolts(net); if (v !== null && Math.abs(v) >= 30) hv.set(net, v); }
    if (hv.size) {
      const worst = new Map<string, { gap: number; need: number; x: number; y: number; v: number }>(); const outer = new Set([copper[0], copper[copper.length - 1]]);
      const others = S.conds.filter((c) => c.kind !== "zone");
      for (const c of others) {
        const v = hv.get(c.net); if (v === undefined) continue;
        for (const o of others) {
          if (o.net === c.net || (c.kind === "pad" && o.kind === "pad" && c.item.id === o.item.id && !o.net)) continue; if (![...c.layers].some((l: string) => o.layers.has(l))) continue;
          const ov = hv.get(o.net) ?? (o.net ? netVolts(o.net) ?? 0 : 0); const dv = Math.abs(v - ov) < 1 && hv.has(o.net) ? Math.abs(v) : Math.abs(v - ov); if (dv < 30) continue;
          const inner = ![...c.layers].some((l: string) => outer.has(l) && o.layers.has(l)); const need = ipcSpacing(dv, inner ? "B1" : "B4");
          if (boxGap(c.bbox, o.bbox) >= need) continue; const g = P.shapeGap(c.shape, o.shape); if (g >= need - 1e-6) continue;
          const key = [c.net, o.net].sort().join(" / "); const w = worst.get(key); if (!w || g < w.gap) worst.set(key, { gap: g, need, x: (c.bbox[0] + c.bbox[2]) / 2, y: (c.bbox[1] + c.bbox[3]) / 2, v: dv });
        }
      }
      if (worst.size) add("creepage", "error", "These conductors are closer than IPC-2221 allows for the voltage between them (table 6-1: B4 for outer layers under solder mask, B1 for inner layers). Widen the gap or raise the net class clearance (board.rules or a net class). A product connected to mains needs the larger distances of its safety standard, and a slot where the board cannot give them.", Array.from(worst.entries()).map(([kk, w]) => `${kk.split(" / ").map((n) => bare(n) || "unconnected copper").join(" to ")}: ${r2(w.gap)} mm near ${at(w.x, w.y)}, ${Math.round(w.v)} V needs ${w.need} mm`));
    }
  }
  void settings;
}

// ---------------------------------------------------------------- plans

/** Is a via of this size allowed at a point: on the board, clear of parts and of every other net's copper. */
function viaFits(S: Survey, P: any, x: number, y: number, r: number, clr: number, net: string, pads: boolean): boolean {
  const o = S.outline; if (o && (x < o[0] + r + 0.3 || x > o[2] - r - 0.3 || y < o[1] + r + 0.3 || y > o[3] - r - 0.3)) return false;
  for (const kz of S.keepouts) if (inBox(grow(kz.box, r), x, y)) return false;
  const b: Box = [x - r - clr, y - r - clr, x + r + clr, y + r + clr]; const sh = { t: "circle", x, y, r };
  for (const c of S.conds) {
    if (c.kind === "zone" || !hit(c.bbox, b)) continue;
    if (c.kind === "pad" && !pads && P.shapeGap(sh, c.shape) < (c.net === net ? 0.1 : clr)) return false;
    if (c.kind === "via" && Math.hypot(c.shape.x - x, c.shape.y - y) < r + c.shape.r + 0.25) return false;
    if (c.net !== net && P.shapeGap(sh, c.shape) < clr) return false;
  }
  return true;
}

/** Where the copper of a fix goes.  plan.what:
 *   "antenna"  { ref, clearance?, pitch?, size? }: the keep-out box of an antenna and the ground vias round it.
 *   "fence"    { net | path: [[x, y], ...], spacing?, offset?, size? }: ground vias down both sides of a net's tracks or a path.
 *   "thermal"  { ref, pitch?, size? }: the via array of a part's exposed pad. */
export function physicsPlan(doc: any, P: any, k: any, settings: any, plan: any): any {
  const S = survey(doc, P, k); const size = plan.size > 0 ? plan.size : 0.6, r = size / 2; const clr = Math.max(0.15, (settings && settings.clearance) || 0.2);
  const gndNet = Array.from(S.padsOf.keys()).find((n) => isGnd(n) && /^\/?GND$/i.test(n)) || Array.from(S.padsOf.keys()).find(isGnd) || "GND";
  const find = (ref: string) => S.fps.find((f) => f.ref.toLowerCase() === String(ref || "").toLowerCase());
  const taken: Pt[] = []; const free = (x: number, y: number, gap: number) => !taken.some((q) => Math.hypot(q[0] - x, q[1] - y) < gap);
  const ground = (x: number, y: number) => (S.zones ? S.gndLayersAt(x, y) >= Math.min(2, S.copper.length) : true);
  if (plan.what === "antenna") {
    const ants = plan.ref ? [find(plan.ref)].filter(Boolean) as Fp[] : S.fps.filter(isAntenna);
    if (!ants.length) return { error: plan.ref ? `There is no part ${plan.ref} on the board.` : "The board has no antenna (a part with reference AE or ANT, or an antenna footprint)." };
    const pitch = Math.max(0.8, plan.pitch || 2), out: any[] = [];
    const radio = radioGHz(S.fps, S.padsOf.keys());
    for (const a of ants) {
      const patch = plan.kind ? plan.kind === "patch" : isPatch(a);
      const box = patch ? a.box : antennaRegion(S, a, plan.clearance >= 0 ? plan.clearance : LIMITS.antennaKeepout); const have = S.keepouts.some((q) => q.copper && hit(q.box, a.box));
      const pts: Pt[] = []; let skipped = 0;
      for (const [x, y] of ringPoints(S, box, r + 0.4, pitch, r + 0.3)) {
        if (S.nearestStitch(x, y) < pitch * 0.6 || !free(x, y, pitch * 0.6)) continue;
        let ok: Pt | null = null; for (const [dx, dy] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) { const px = x + dx, py = y + dy; if (inBox(grow(box, r + 0.2), px, py)) continue; if (ground(px, py) && viaFits(S, P, px, py, r, clr, gndNet, false) && free(px, py, pitch * 0.6)) { ok = [px, py]; break; } }
        if (ok) { pts.push(ok); taken.push(ok); } else skipped++;
      }
      const remove: string[] = [], blocked = new Set<string>(); const own = new Set(a.pads.map((p) => p.net).filter(Boolean)); const shape = rectShape(box);
      if (!patch) for (const c of S.conds) { if (c.kind === "zone" || c.kind === "pad" || !hit(c.bbox, box) || P.shapeGap(c.shape, shape) > 0) continue; if (c.kind === "via" && isGnd(c.net) && inBox(box, c.shape.x, c.shape.y)) remove.push(c.id); else if (!own.has(c.net)) blocked.add(`${c.kind === "via" ? "a via" : "a track"} of ${bare(c.net) || "no net"}`); }
      const edge = S.outline ? Math.min(a.box[0] - S.outline[0], S.outline[2] - a.box[2], a.box[1] - S.outline[1], S.outline[3] - a.box[3]) : 0;
      out.push({ ref: a.ref, box: box.map(r2), has_keepout: have, remove, blocked: Array.from(blocked), patch, frequency_ghz: radio.ghz, vias: pts.map((p) => [r2(p[0]), r2(p[1])]), no_room: skipped, edge_distance: r2(edge), feed: a.pads.map((p) => p.net).filter((n) => n && !isGnd(n)).map(bare) });
    }
    return { what: "antenna", net: gndNet, layers: S.copper, antennas: out };
  }
  if (plan.what === "fence") {
    const spacing = Math.max(0.6, plan.spacing || 2); let paths: { pts: Pt[]; w: number }[] = []; let net = "";
    if (plan.path) paths = [{ pts: plan.path.map((p: number[]) => [p[0], p[1]] as Pt), w: plan.width || 0.3 }];
    else {
      const want = String(plan.net || ""); net = Array.from(S.tracksOf.keys()).find((n) => n === want || bare(n) === bare(want)) || "";
      if (!net) return { error: `No routed net named ${want}. Route it first, or give path=[(x, y), ...].` };
      paths = (S.tracksOf.get(net) || []).map((t) => ({ pts: (t.shape.t === "seg" ? [t.shape.a, t.shape.b] : t.shape.pts) as Pt[], w: t.width }));
    }
    const pts: Pt[] = []; let wanted = 0;
    for (const p of paths) {
      const off = plan.offset > 0 ? plan.offset : p.w / 2 + Math.max(clr + 0.25, 0.5) + r;
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue; const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; const n = Math.max(1, Math.round(L / spacing));
        for (let j = 0; j <= n; j++) for (const sgn of [1, -1]) {
          const bx = a[0] + ux * L * j / n, by = a[1] + uy * L * j / n; wanted++; let ok: Pt | null = null;
          for (const [dt, extra] of [[0, 0], [0, 0.3], [spacing / 4, 0], [-spacing / 4, 0], [0, 0.6]]) { const x = bx + ux * dt - uy * sgn * (off + extra), y = by + uy * dt + ux * sgn * (off + extra); if (!free(x, y, spacing * 0.6)) { ok = null; wanted--; break; } if (S.nearestStitch(x, y) < spacing * 0.5) { ok = null; wanted--; break; } if (ground(x, y) && viaFits(S, P, x, y, r, clr, gndNet, false)) { ok = [x, y]; break; } }
          if (ok) { pts.push(ok); taken.push(ok); }
        }
      }
    }
    return { what: "fence", net: gndNet, of: bare(net), vias: pts.map((p) => [r2(p[0]), r2(p[1])]), no_room: Math.max(0, wanted - pts.length), spacing };
  }
  if (plan.what === "thermal") {
    const parts = plan.ref ? [find(plan.ref)].filter(Boolean) as Fp[] : S.fps; if (plan.ref && !parts.length) return { error: `There is no part ${plan.ref} on the board.` };
    const pitch = Math.max(0.6, plan.pitch || LIMITS.thermalPitch), out: any[] = [];
    for (const f of parts) {
      const e = thermalPad(f); if (!e) { if (plan.ref) return { error: `${f.ref} has no exposed pad (one large pad in the middle of the package).` }; continue; }
      const w = e.box[2] - e.box[0] - 2 * (r + 0.15), h = e.box[3] - e.box[1] - 2 * (r + 0.15); const nx = Math.max(1, Math.floor(w / pitch) + 1), ny = Math.max(1, Math.floor(h / pitch) + 1); const pts: Pt[] = [];
      const cx = (e.box[0] + e.box[2]) / 2, cy = (e.box[1] + e.box[3]) / 2; const have = S.vias.filter((v) => inBox(e.box, v.shape.x, v.shape.y));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const x = cx + (i - (nx - 1) / 2) * Math.min(pitch, nx > 1 ? w / (nx - 1) : 0), y = cy + (j - (ny - 1) / 2) * Math.min(pitch, ny > 1 ? h / (ny - 1) : 0); if (have.some((v) => Math.hypot(v.shape.x - x, v.shape.y - y) < r + v.shape.r + 0.2)) continue; pts.push([x, y]); }
      out.push({ ref: f.ref, pad: e.number, net: e.net, size: [r2(e.box[2] - e.box[0]), r2(e.box[3] - e.box[1])], had: have.length, vias: pts.map((p) => [r2(p[0]), r2(p[1])]) });
    }
    return { what: "thermal", pads: out };
  }
  if (plan.what === "layout") return layoutPlan(S, doc, k, plan);
  if (plan.what === "stackup") {
    const st = physicalStack(doc, k); const sim = stackupOf(k, doc); const outer = traceOn(sim, S.copper[0]); const w50 = outer ? widthFor(outer, 50) : null;
    return { what: "stackup", copper_layers: S.copper, thickness: st.thickness || doc.thickness || 1.6, finish: st.finish, assumed: st.assumed, layers: st.rows.map((r) => ({ name: r.name, type: r.type, thickness: r.thickness, material: r.material, epsilon_r: r.er, loss_tangent: r.loss })),
      flex: st.rows.some((r) => !r.copper && FLEX_MATERIAL.test(r.material)), bend_areas: S.keepouts.filter((q) => BEND_NAME.test(q.name)).map((q) => q.box.map(r2)),
      outer: outer ? { kind: outer.kind, height: r2(outer.h), epsilon_r: r2(outer.er), reference: outer.reference, width_50_ohm: w50 ? r2(w50) : null } : null };
  }
  if (plan.what === "interfaces") return { what: "interfaces", interfaces: INTERFACES };
  return { error: `Unknown plan "${plan.what}": antenna, fence, thermal, layout, stackup or interfaces.` };
}

/** The layout worked out from the netlist, before a part is placed or a track laid: which parts belong beside which
 *  and why, what goes on an edge, what must be kept apart, what each net is and how wide it has to be, and the calls
 *  in the order they are made.  Placement and routing follow this; the review afterwards only proves it. */
function layoutPlan(S: Survey, doc: any, k: any, plan: any): any {
  const { fps, padsOf, copper } = S; const near: Record<string, string> = {}, why: Record<string, string> = {}, edges: Record<string, string> = {}; const apart: string[][] = [], notes: string[] = [];
  const put = (ref: string, by: string, reason: string) => { if (ref === by || near[ref]) return; near[ref] = by; why[ref] = reason; };
  const isIc = (f: Fp) => /^(U|IC)\d/i.test(f.ref); const two = (f: Fp) => f.pads.length === 2;
  const other = (f: Fp, net: string) => (f.pads.find((p) => p.net !== net) || { net: "" }).net;
  const pairBase = new Map<string, { p?: string; n?: string }>(); for (const net of padsOf.keys()) { const pn = pairName(net); if (!pn) continue; const e = pairBase.get(pn.base) || {}; pairBase.set(pn.base, e); if (pn.pol > 0) e.p = net; else e.n = net; }
  const paired = new Set<string>(); for (const e of pairBase.values()) if (e.p && e.n) { paired.add(e.p); paired.add(e.n); }
  const antennas = fps.filter(isAntenna); const feed = new Set<string>(); for (const a of antennas) for (const p of a.pads) if (p.net && !isGnd(p.net)) feed.add(p.net);
  const kindOf = (net: string) => (isGnd(net) ? "supply" : feed.has(net) ? "rf" : netKind(net, paired.has(net) || undefined));
  const radio = radioGHz(fps, padsOf.keys());

  // switching converters first: their loop decides where their parts go
  const converters: { reg: Fp; ind: Fp }[] = []; const claimed = new Set<string>();
  for (const [sw, pads] of padsOf) {
    if (kindOf(sw) !== "switching") continue; const lp = pads.find((p) => /^L\d/i.test(p.fp.ref)), up = pads.find((p) => isIc(p.fp)); if (!lp || !up) continue;
    const reg = up.fp, ind = lp.fp; converters.push({ reg, ind }); const outNet = other(ind, sw);
    put(ind.ref, reg.ref, `inductor of ${reg.ref}: the switch node between them stays short`);
    for (const c of pads.filter((p) => /^C\d/i.test(p.fp.ref))) put(c.fp.ref, reg.ref, `bootstrap capacitor of ${reg.ref}`);
    for (const d of pads.filter((p) => /^D\d/i.test(p.fp.ref))) put(d.fp.ref, reg.ref, `catch diode of ${reg.ref}: it is in the switched loop`);
    const vin = Array.from(new Set(reg.pads.filter((p) => isSup(p.net) && p.net !== outNet).map((p) => p.net)));
    for (const v of vin) { const caps = (padsOf.get(v) || []).filter((p) => /^C\d/i.test(p.fp.ref) && two(p.fp) && isGnd(other(p.fp, v)) && !claimed.has(p.fp.ref)); if (caps.length) { put(caps[0].fp.ref, reg.ref, `input capacitor of ${reg.ref}: at its VIN and ground pins, the loop that carries the switched current`); claimed.add(caps[0].fp.ref); } }
    if (outNet) { const caps = (padsOf.get(outNet) || []).filter((p) => /^C\d/i.test(p.fp.ref) && two(p.fp) && isGnd(other(p.fp, outNet)) && !claimed.has(p.fp.ref)); if (caps.length) { put(caps[0].fp.ref, ind.ref, `output capacitor of ${reg.ref}: at the inductor, its ground back at the converter's ground`); claimed.add(caps[0].fp.ref); } }
    for (const fb of reg.pads.filter((p) => /^(V?FB|VSENSE|VOS|ADJ)\d*$/i.test(p.fn) || /(^|[_\-.])V?FB\d*$/i.test(bare(p.net)))) for (const q of (padsOf.get(fb.net) || []).filter((p) => /^(R|C)\d/i.test(p.fp.ref))) put(q.fp.ref, reg.ref, `feedback divider of ${reg.ref}: at the FB pin, away from the inductor`);
  }
  // crystals and their load capacitors
  for (const y of fps.filter(isCrystal)) {
    const sig = y.pads.filter((p) => p.net && !isGnd(p.net)); const ic = sig.flatMap((p) => (padsOf.get(p.net) || []).filter((q) => isIc(q.fp)))[0];
    if (ic) put(y.ref, ic.fp.ref, `crystal of ${ic.fp.ref}: against its oscillator pins`);
    for (const p of sig) for (const c of (padsOf.get(p.net) || []).filter((q) => /^C\d/i.test(q.fp.ref))) { put(c.fp.ref, y.ref, `load capacitor of ${y.ref}`); claimed.add(c.fp.ref); }
    for (const c of converters) apart.push([y.ref, c.ind.ref]);
  }
  // decoupling: every IC supply pin gets a capacitor of its net, the small ones handed round the ICs on the rail
  const rails = Array.from(padsOf.keys()).filter(isSup);
  for (const rail of rails) {
    const caps = (padsOf.get(rail) || []).filter((p) => /^C\d/i.test(p.fp.ref) && two(p.fp) && isGnd(other(p.fp, rail)) && !claimed.has(p.fp.ref) && !near[p.fp.ref]).map((p) => p.fp);
    const pins = (padsOf.get(rail) || []).filter((p) => isIc(p.fp)); if (!caps.length || !pins.length) continue;
    const ics: Fp[] = []; for (const p of pins) if (!ics.includes(p.fp)) ics.push(p.fp);
    ics.sort((a, b) => b.pads.filter((p) => p.net === rail).length - a.pads.filter((p) => p.net === rail).length);
    const want: Fp[] = []; for (const u of ics) want.push(u); for (const u of ics) for (let i = 1; i < u.pads.filter((p) => p.net === rail).length; i++) want.push(u);
    caps.forEach((c, i) => put(c.ref, want[i % want.length].ref, `decoupling of ${want[i % want.length].ref} on ${bare(rail)}: at the supply pin, its ground straight into the plane`));
  }
  // antennas, their matching parts, and what must stay away from them
  for (const a of antennas) {
    if (!isPatch(a)) edges[a.ref] = typeof plan.edge === "string" ? plan.edge : "top";
    for (const net of a.pads.map((p) => p.net).filter((n) => n && !isGnd(n))) for (const q of padsOf.get(net) || []) if (q.fp !== a && two(q.fp)) { put(q.fp.ref, a.ref, `matching network of ${a.ref}: in line with the feed`); const far = other(q.fp, net); if (far && !isGnd(far)) for (const z of padsOf.get(far) || []) if (two(z.fp) && z.fp !== q.fp) put(z.fp.ref, q.fp.ref, `matching network of ${a.ref}`); }
    for (const c of converters) apart.push([a.ref, c.ind.ref]);
    for (const y of fps.filter(isCrystal)) apart.push([a.ref, y.ref]);
  }
  // protection at the connector, feedback parts at the amplifier, a photodiode at its amplifier
  for (const d of fps.filter(isEsd)) for (const p of d.pads) { if (!p.net || isGnd(p.net)) continue; const c = (padsOf.get(p.net) || []).find((q) => q.fp !== d && isConnector(q.fp)); if (c) { put(d.ref, c.fp.ref, `protection of ${c.fp.ref}: the strike meets it before anything else`); break; } }
  for (const u of fps.filter(isOpamp)) for (const p of u.pads) { if (!/^(-|IN-|-IN|INN|IN_N|VIN-|INM|IN\d-|-IN[A-D]?|IN[A-D]-|\d?IN-)$/i.test(p.fn) || !p.net || isGnd(p.net)) continue; for (const q of (padsOf.get(p.net) || []).filter((z) => /^(R|C)\d/i.test(z.fp.ref))) put(q.fp.ref, u.ref, `feedback part of ${u.ref}: at the inverting input, so the summing node is tiny`); }
  for (const d of fps.filter(isPhotodiode)) for (const p of d.pads) { if (!p.net || isGnd(p.net) || isSup(p.net)) continue; const u = (padsOf.get(p.net) || []).find((q) => isIc(q.fp)); if (u) put(d.ref, u.fp.ref, `photodiode of ${u.fp.ref}: its node is nanoamps into megohms, so millimetres of track`); }
  for (const f of fps.filter(isIsolator)) notes.push(`${f.ref} is an isolation barrier: put it across the gap between the two sides and keep every layer clear under it (board.keepout).`);

  // nets: what each is, how wide, in which order
  const st = stackupOf(k, doc); const top = traceOn(st, copper[0]); const widths: Record<string, number> = {}, kinds: Record<string, string> = {}; const order: string[] = []; const pairs: any[] = [];
  for (const [base, e] of pairBase) { if (!e.p || !e.n) continue; const ifc = pairInterface(bare(e.p)); const r = ifc ? INTERFACES[ifc] : null; pairs.push({ nets: [bare(e.p), bare(e.n)], interface: ifc || undefined, ohms: r ? r.zd : undefined, skew_mm: r ? r.skew : LIMITS.pairSkew, max_vias: r ? r.vias : 2 }); order.push(bare(e.p), bare(e.n)); void base; }
  for (const y of fps.filter(isCrystal)) for (const p of y.pads) if (p.net && !isGnd(p.net)) order.push(bare(p.net));
  for (const net of padsOf.keys()) {
    const kd = kindOf(net); const n = bare(net);
    if (kd === "rf") { kinds[n] = "rf"; order.push(n); const w = top ? widthFor(top, 50) : null; if (w && w <= 1.2) widths[n] = r2(w); else notes.push(`${n}: 50 ohm on this stackup needs a ${w ? r2(w) : "very wide"} mm track. Keep the feed under ${Math.max(3, r2(viaPitchFor(radio.ghz) * 2))} mm, or use four layers (board.stackup(layers=4)) so 50 ohm is about 0.35 mm.`); }
    else if (kd === "switching") widths[n] = 0.5;
    else if (isSup(net)) widths[n] = 0.5;
  }
  const fast = Array.from(padsOf.keys()).some((n) => ["rf", "fast"].includes(kindOf(n)));
  if (fast && copper.length < 4) notes.push("The board has RF or fast nets on two layers. Four layers with ground on the layer under the parts (board.stackup(layers=4) or board.layers(4, planes=[\"In1.Cu\"])) gives every signal an unbroken return path; on two layers keep the bottom an unbroken ground and route on top.");
  if (antennas.length) notes.push(`Radio: ${radio.why}. Ground vias no more than ${r2(viaPitchFor(radio.ghz))} mm apart round the antenna and along the feed. The antenna's own datasheet layout (ground size, keep-out, matching values) is binding.`);
  for (const c of converters) notes.push(`${c.reg.ref} is a switching converter: place it and ${c.ind.ref} at the far end of the board from ${antennas.length ? "the antenna and " : ""}the analog parts and the crystal.`);
  const steps = [
    "board.sync(); board.outline(...); board.stackup(fab=..., layers=...) or board.layers(...); board.rules(...)",
    "plan = board.plan(); board.autoplace(near=plan[\"place\"][\"near\"], edges={**plan[\"place\"][\"edges\"], ...your connectors...}, groups=...)",
    "board.zone(\"GND\", layer=...) on every ground layer",
    "board.prepare()    # antenna keep-outs and the ground vias along them, before any track is laid",
    "board.route(**plan[\"route\"])",
    "board.finish()     # RF fence, thermal vias, stitching, refill",
    "board.review()     # the proof: fix what it lists, in the placement if that is where it comes from",
  ];
  return { what: "layout", place: { near, edges }, why, apart: apart.map(([a, b]) => [a, b]), route: { widths, kinds, order: Array.from(new Set(order)) }, pairs, radio_ghz: antennas.length ? radio.ghz : undefined, copper_layers: copper.length, notes, steps };
}
