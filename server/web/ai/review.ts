// review.ts — the design review: a schematic or a board checked against a written checklist.
//
// The rules are Andrew Greenberg's "Actually Useful Schematics" talk (KiCon 2025) with his Checklist for Schematics
// and Checklist for PCB Layout, and Graham Sutherland's "Creating high quality electronics schematics".  Every item a
// program can judge from the files is judged here and comes back as a finding that names the parts and nets; the
// items only a person can judge (peer review, stock, a revision table) come back as `manual`, so nothing on the
// lists is silently skipped.  ERC and DRC answer whether the design is connected; this answers whether it reads
// well and whether the usual mistakes are in it.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ED, K, ToolError, fieldsOf, resolveDoc, schNets } from "./design";
import { checkLayout } from "./layout";
import { PHYSICS_MANUAL, PHYSICS_RULES, PHYSICS_SOURCE, physicsPlan, reviewPhysics } from "./review-physics";
import { CIRCUIT_MANUAL, CIRCUIT_RULES, reviewCircuit } from "./review-circuit";

const W = window as any;
const SCH = (): any => (W.CollabTools && W.CollabTools.sch) || null;
const PCB = (): any => W.PcbTools || null;
const r2 = (v: number) => Math.round(v * 100) / 100;

type Level = "error" | "warning" | "note";
interface Finding { rule: string; level: Level; message: string; count?: number; items?: string[] }
interface Rule { id: string; what: string }

const GROUND = /^(?:[ADP]?GND\w*|GNDREF|VSS\w*|EARTH|0V)$/i;
const NEGATIVE = /^(?:-\d|VEE|V-|VNEG)/i;
const SUPPLY = /^(?:[+-]\d|\d+V\d*$|\d+(?:\.\d+)?V$|V(?:CC|DD|BUS|USB|BAT|IN|OUT|SYS|PP|AA|REF|MOTOR|S)\w*|VD?D?[A-Z]*_\w+|V\d+V?\d*|\w+_\d+V\d*$)/i;
const VAGUE_SUPPLY = /^(?:VCC|VDD|VEE|VPP|VAA|V\+|V-|VIN|VOUT|PWR|POWER)$/i;
const isGround = (n: string) => GROUND.test(n);

/** The voltage a net's name states: +3V3 is 3.3, VBUS is 5, 1V8 is 1.8; null when the name does not say. */
export function voltsOf(name: string): number | null {
  const n = name.replace(/^\//, "");
  let m = /(-?\d+)V(\d+)(?!\d)/i.exec(n); if (m) return Number(`${m[1]}.${m[2]}`);
  m = /(-?\d+(?:\.\d+)?)\s*V(?![A-Za-z])/i.exec(n); if (m) return Number(m[1]);
  if (/^V?(BUS|USB)\b|VBUS|VUSB/i.test(n)) return 5;
  if (/VBAT|LIPO|VCELL/i.test(n)) return 4.2;
  return null;
}
const SI: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1, "Ω": 1 };
/** A resistor's value in ohms: 10k, 4k7, 4.7k, 100R, 0R, 330, 1M. */
export function ohms(v: string): number | null {
  const s = v.trim().split(/[\s,/]/)[0].replace(/ohms?$/i, "").replace(/Ω$/, "");
  let m = /^(\d+)([RrkKM])(\d+)$/.exec(s); if (m) return Number(`${m[1]}.${m[3]}`) * SI[m[2]];
  m = /^(\d+(?:\.\d+)?)([RrkKMG]?)$/.exec(s); if (m) return Number(m[1]) * (m[2] ? SI[m[2]] : 1);
  return null;
}
/** A capacitor's value in farads: 100nF, 4u7, 10uF, 22p. */
export function farads(v: string): number | null {
  const s = v.trim().split(/[\s,/]/)[0].replace(/F$/i, "");
  let m = /^(\d+)([pnuµμm])(\d+)$/.exec(s); if (m) return Number(`${m[1]}.${m[3]}`) * SI[m[2]];
  m = /^(\d+(?:\.\d+)?)([pnuµμm])$/.exec(s); if (m) return Number(m[1]) * SI[m[2]];
  return null;
}
const field = (f: Record<string, string>, re: RegExp): string => { for (const k of Object.keys(f)) if (re.test(k) && f[k] && f[k] !== "~") return f[k]; return ""; };
const MFR = /^(mfr|mfg|manufacturer|manufacturer[ _-]?name)$/i, MPN = /^(mpn|manufacturer[ _-]?part.*|mfr[ _-]?(pn|part.*)|part[ _-]?(number|no)|pn)$/i;
const DIST = /^(lcsc.*|jlc.*|digi-?key.*|mouser.*|farnell.*|rs.*part.*|supplier.*|vendor.*|sku|distributor.*)$/i;
/** What a chip resistor of this footprint may dissipate, in watts (the usual thick film ratings). */
function wattsOf(f: Record<string, string>): number | null {
  const p = field(f, /^(power|power[ _-]?rating|rating)$/i) || "";
  let m = /(\d+)\s*\/\s*(\d+)\s*W/i.exec(p + " " + (f.Value || "")); if (m) return Number(m[1]) / Number(m[2]);
  m = /(\d+(?:\.\d+)?)\s*(m?)W/i.exec(p + " " + (f.Value || "")); if (m) return Number(m[1]) * (m[2] ? 1e-3 : 1);
  const fp = f.Footprint || "";
  const size: Record<string, number> = { "0201": 0.05, "0402": 0.0625, "0603": 0.1, "0805": 0.125, "1206": 0.25, "1210": 0.5, "2010": 0.75, "2512": 1 };
  m = /_(0201|0402|0603|0805|1206|1210|2010|2512)_/.exec(fp); return m ? size[m[1]] : null;
}
function capVolts(f: Record<string, string>): number | null {
  const v = field(f, /^(voltage|voltage[ _-]?rating|rated[ _-]?voltage|rating)$/i) + " " + (f.Value || "").replace(/^\S+/, "");
  const m = /(\d+(?:\.\d+)?)\s*V/i.exec(v); return m ? Number(m[1]) : null;
}
const few = (l: string[], n = 8) => (l.length > n ? l.slice(0, n).concat(`and ${l.length - n} more`) : l);
const refSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// ---------------------------------------------------------------- schematic

const SCH_RULES: Rule[] = [
  { id: "power.symbols", what: "Power is distributed through supply symbols, not wires or labels" },
  { id: "power.direction", what: "Positive supplies point up; ground and negative supplies point down. Always" },
  { id: "power.names", what: "Supplies have useful names (VUSB is better than 5V, which is better than VCC)" },
  { id: "power.ratings", what: "Every supply states its voltage range and current as text: VUSB = (4.5, 5.0, 5.5) V @ (, 35, 500) mA" },
  { id: "nets.named", what: "All important nets are descriptively named" },
  { id: "nets.naming", what: "One net naming convention: no dots in names, one case, one spelling per signal" },
  { id: "labels.stubs", what: "A net stub (a wire that reaches one pin) carries a global or hierarchical label with a direction shape, not a plain label" },
  { id: "labels.shape", what: "A global label's shape (input, output, bidirectional) agrees with the pins on its wire" },
  { id: "wires.first", what: "Nets are mostly connected by wires; labels only where a wire would be awkward" },
  { id: "wires.straight", what: "Wires run up, down, left or right, on the grid, with few crossings (no wire crossed more than three times)" },
  { id: "wires.pins", what: "A wire leaves every pin: no pin placed directly on another part's pin" },
  { id: "buses", what: "Groups of four or more related nets are collected into a bus" },
  { id: "blocks.labelled", what: "Functional blocks are grouped, separated by white space or a box, and labelled" },
  { id: "title", what: "The sheet has a frame and a title block with title, revision and date" },
  { id: "space", what: "Nothing is drawn over anything else and the sheet is not overcrowded (add a sheet instead)" },
  { id: "symbols.logical", what: "Symbols are schematic symbols, not packages: inputs left, outputs right, power on top, ground at the bottom" },
  { id: "symbols.pin_types", what: "Pins have the correct electrical type for the ERC" },
  { id: "values", what: "All components have a value or are marked do not populate" },
  { id: "caps.voltage", what: "Capacitors are rated for at least twice their working voltage" },
  { id: "resistors.power", what: "Power dissipation is checked on all resistors" },
  { id: "mosfets", what: "MOSFETs are oriented correctly with respect to the body diode" },
  { id: "bypass", what: "Small ceramic bypass capacitors on every IC supply" },
  { id: "domains", what: "Signal levels match across power domains, and an unpowered domain is not fed through its inputs" },
  { id: "uart", what: "UART TX goes to RX and RX to TX, and the nets are named after their source (MCU_TX)" },
  { id: "pullups", what: "Pull-ups on open-drain lines (I2C) and a defined default state on reset, enable and boot pins" },
  { id: "test.points", what: "Test points on power, ground and reset; a way to program every programmable IC; debug aids" },
  { id: "fail.safe", what: "Supplies can be separated (0 ohm links or jumpers), inputs are protected, unused pins are reachable" },
  { id: "erc", what: "No unapproved errors or warnings in the ERC" },
  { id: "bom", what: "Every component has MFR and MPN fields (and ideally a distributor number and a datasheet)" },
];
const SCH_MANUAL = [
  "Data and power flow left to right across the sheet, or at least follow a path the eye can track.",
  "Circuits use recognisable patterns (divider, filter, follower, regulator, high-side switch, crystal) drawn the way a datasheet draws them.",
  "Notes say why for every value that was calculated, every I2C address, every deviation from the datasheet and every layout requirement.",
  "Layout features that are circuit elements (a copper inductor, an antenna) are labelled in the schematic.",
  "IC part numbers reflect the correct package.",
  "The hardware revision is readable in hardware (GPIO straps).",
  "The schematic was reviewed by someone not involved in the design.",
  "Specialised parts are in stock at a distributor (parts.lookup tells you).",
  "If this is a revision, the changes are recorded in a table on the sheet; the version and date in the title block are current.",
];

interface SPin { ref: string; number: string; name: string; type: string; x: number; y: number; side: string; part: any }

export async function reviewSchematic(doc: any, path: string): Promise<any> {
  const s = SCH(), k = K(); if (!s) throw new ToolError("The schematic tools are not loaded.");
  const out: Finding[] = []; const add = (rule: string, level: Level, message: string, items?: string[]) => out.push({ rule, level, message, count: items ? items.length : undefined, items: items && items.length ? few(items) : undefined });
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

  // ---- what is on the sheet
  const parts: any[] = [], powers: any[] = [], labels: any[] = [], texts: { text: string; x: number; y: number }[] = [], segs: number[][] = [], buses: number[][] = [], junctions = new Set<string>();
  let sheets = 0;
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind === "symbol") {
      let power = false; try { power = !!s._.isPowerSymbol(doc, it.lib || ""); } catch { power = /^power:/i.test(it.lib || ""); }
      const pins: SPin[] = s._.symbolPins(doc, it).map((p: any) => ({ ref: it.ref || "?", number: p.number, name: p.name === "~" ? "" : p.name, type: p.type, x: p.x, y: p.y, side: p.side, part: it }));
      const row = { it, ref: it.ref || "?", value: it.value || "", lib: it.lib || "", fields: fieldsOf(it.node), pins, dnp: !!(k.kid(it.node, "dnp") && k.str(k.kid(it.node, "dnp")[1]) === "yes") };
      (power ? powers : parts).push(row);
    } else if (it.kind === "wire" || it.kind === "bus") { const pts = k.ptsOf(it.node); for (let i = 1; i < pts.length; i++) (it.kind === "wire" ? segs : buses).push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]); }
    else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") { const a = k.atOf(it.node); const sh = k.kid(it.node, "shape"); labels.push({ kind: it.kind, text: k.str(it.node[1]), x: a[0], y: a[1], shape: sh ? k.str(sh[1]) : "" }); }
    else if (it.kind === "text" || it.kind === "text_box") { const a = k.atOf(it.node); texts.push({ text: k.str(it.node[1]), x: a[0], y: a[1] }); }
    else if (it.kind === "junction") { const a = k.atOf(it.node); junctions.add(key(a[0], a[1])); }
    else if (it.kind === "sheet") sheets++;
  }
  const allText = texts.map((t) => t.text).join("\n");
  const nets = schNets(doc);
  const netOf = new Map<string, string>(); for (const n of nets) for (const p of n.pins) netOf.set(`${p.ref}\u0000${p.number}`, n.name);
  const pinNet = (p: SPin) => netOf.get(`${p.ref}\u0000${p.number}`) || "";
  const byRef = new Map<string, any>(); for (const p of parts) byRef.set(p.ref, p);
  const powerNames = new Set(powers.map((p) => p.value));
  const supplyNets = new Set<string>(); for (const n of nets) if (powerNames.has(n.name) || (SUPPLY.test(n.name) && !/_(EN|PG|FB|SENSE|OK)$/i.test(n.name))) supplyNets.add(n.name);
  const rails = Array.from(supplyNets).filter((n) => !isGround(n));
  const isPassive = (p: any) => p.pins.length <= 2 && /^(R|C|L|FB|D|F|JP|SB|TP)\d/i.test(p.ref);
  const isIc = (p: any) => /^(U|IC)\d/i.test(p.ref) || (p.pins.length >= 5 && !/^(J|P|CN|X|SW|K|RN)\d/i.test(p.ref) && p.pins.some((q: SPin) => q.type === "power_in"));
  const isConn = (p: any) => /^(J|P|CN|X)\d/i.test(p.ref) && /conn|usb|jack|header|socket|terminal|barrel/i.test(p.lib + " " + p.value) || /^Connector/i.test(p.lib);
  const isTp = (p: any) => /^TP\d/i.test(p.ref) || /test ?point/i.test(p.lib + " " + p.value);
  const netPins = new Map<string, SPin[]>(); for (const p of parts) for (const q of p.pins) { const n = pinNet(q); if (!n) continue; const l = netPins.get(n); if (l) l.push(q); else netPins.set(n, [q]); }
  // supply voltages: what the sheet's text states wins over what a name implies
  const stated = new Map<string, number>();
  for (const m of allText.matchAll(/([A-Za-z_+\-][\w+.\-]*)\s*(?:=|:)\s*\(?\s*(-?[\d.]*)\s*,\s*(-?[\d.]*)\s*,\s*(-?[\d.]*)\s*\)?\s*V\b/g)) { const mx = Number(m[4] || m[3] || m[2]); if (isFinite(mx)) stated.set(m[1].toUpperCase(), mx); }
  const railV = (n: string): number | null => (isGround(n) ? 0 : stated.has(n.toUpperCase()) ? (stated.get(n.toUpperCase()) as number) : voltsOf(n));

  // ---- the wires as drawn: which pins and labels each connected piece of wire touches
  const par: number[] = segs.map((_, i) => i); const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const onSeg = (x: number, y: number, g: number[]) => Math.abs((g[2] - g[0]) * (y - g[1]) - (g[3] - g[1]) * (x - g[0])) < 1e-3 && x >= Math.min(g[0], g[2]) - 1e-3 && x <= Math.max(g[0], g[2]) + 1e-3 && y >= Math.min(g[1], g[3]) - 1e-3 && y <= Math.max(g[1], g[3]) + 1e-3;
  const ends = new Map<string, number[]>(); segs.forEach((g, i) => { for (const e of [key(g[0], g[1]), key(g[2], g[3])]) { const l = ends.get(e); if (l) l.push(i); else ends.set(e, [i]); } });
  for (const l of ends.values()) for (let i = 1; i < l.length; i++) par[find(l[i])] = find(l[0]);
  segs.forEach((g, i) => { for (const e of [[g[0], g[1]], [g[2], g[3]]]) segs.forEach((h, j) => { if (i !== j && find(i) !== find(j) && onSeg(e[0], e[1], h)) par[find(i)] = find(j); }); });
  const groupAt = (x: number, y: number): number => { for (let i = 0; i < segs.length; i++) if (onSeg(x, y, segs[i])) return find(i); return -1; };
  const groupPins = new Map<number, SPin[]>();
  for (const p of parts) for (const q of p.pins) { const g = groupAt(q.x, q.y); if (g < 0) continue; const l = groupPins.get(g); if (l) l.push(q); else groupPins.set(g, [q]); }

  // ---- power.symbols / power.direction / power.names / power.ratings
  {
    const bad = labels.filter((l) => SUPPLY.test(l.text) && !/_(EN|PG|FB|SENSE|OK)$/i.test(l.text) || isGround(l.text)).map((l) => `${l.text} at (${r2(l.x)}, ${r2(l.y)})`);
    if (bad.length) add("power.symbols", "error", "These supplies are carried by net labels. Use a supply symbol (sch.net or sch.power draws one, sch.supply(name) makes one for a name KiCad's library lacks).", Array.from(new Set(bad)));
    const turned: string[] = [];
    for (const p of powers) { const mir = k.kid(p.it.node, "mirror"); if ((p.it.rot || 0) % 360 !== 0 || (mir && k.str(mir[1]) === "x")) turned.push(`${p.value} at (${r2(p.it.x)}, ${r2(p.it.y)}) is turned ${p.it.rot || 0}°${mir ? " and mirrored" : ""}`); }
    if (turned.length) add("power.direction", "error", "Supply symbols point up and ground or negative symbols point down, always. Bend the wire and give the symbol room instead of turning it.", turned);
    const vague = rails.filter((n) => VAGUE_SUPPLY.test(n));
    if (vague.length) add("power.names", "warning", "These supply names say nothing about the rail. Name a rail after its source and voltage (VUSB, VBAT, +3V3, MCU_3V3).", vague);
    const unrated = rails.filter((n) => !stated.has(n.toUpperCase()) && !new RegExp(`(^|[^\\w+])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^\\n]{0,40}\\d\\s*(V|A|mA)\\b`, "i").test(allText));
    if (unrated.length) add("power.ratings", "warning", "No text on the sheet states the voltage range and current of these supplies. Write it with sch.supply(name, volts=(min, typ, max), amps=(min, typ, max)).", unrated);
  }

  // ---- nets.named / nets.naming
  {
    const auto = nets.filter((n) => !n.named && !supplyNets.has(n.name) && (n.pins.length >= 3 || new Set(n.pins.map((p) => p.ref).filter((r) => { const q = byRef.get(r); return q && isIc(q); })).size >= 2 || n.pins.some((p) => /^(~?\{?N?RST|~?\{?RESET|EN|SDA|SCL|SCK|MOSI|MISO|TX|RX|SWDIO|SWCLK|D[+-]|DP|DM)/i.test(p.name) && byRef.get(p.ref) && isIc(byRef.get(p.ref)))));
    if (auto.length) add("nets.named", "warning", "These nets have no name of their own (KiCad calls them after a pin). Name every net that joins ICs, has three or more pins, or carries a reset, enable, clock or bus signal: put a label on its wire.", auto.map((n) => `${n.name}: ${n.pins.slice(0, 4).map((p) => `${p.ref}.${p.number}`).join(", ")}`));
    const names = nets.filter((n) => n.named).map((n) => n.name); const odd: string[] = [];
    for (const n of names) { if (/\d\.\d/.test(n)) odd.push(`${n}: write the decimal point as V (3V3), a dot is easy to misread`); else if (/\s/.test(n)) odd.push(`${n}: no spaces in a net name`); }
    const upper = names.filter((n) => /[a-z]/.test(n) && !/[A-Z]{2}/.test(n)), caps = names.filter((n) => !/[a-z]/.test(n));
    if (upper.length && caps.length > upper.length) for (const n of upper) odd.push(`${n}: the other nets are upper case`);
    const seen = new Map<string, string>(); for (const n of names) { const c = n.toUpperCase().replace(/ENABLE/g, "EN").replace(/RESET/g, "RST").replace(/[_\-.]/g, ""); const o = seen.get(c); if (o && o !== n) odd.push(`${o} and ${n} read as the same signal: use one spelling`); else seen.set(c, n); }
    if (odd.length) add("nets.naming", "warning", "Net names are not consistent.", odd);
  }

  // ---- labels.stubs / labels.shape / wires.first
  {
    const stubs: string[] = [], shapes: string[] = []; let byLabel = 0, byWire = 0;
    const count = new Map<string, number>(); for (const l of labels) count.set(l.text, (count.get(l.text) || 0) + 1);
    for (const l of labels) {
      const g = groupAt(l.x, l.y); const pins = (g >= 0 ? groupPins.get(g) : null) || parts.flatMap((p: any) => p.pins.filter((q: SPin) => Math.abs(q.x - l.x) < 1e-3 && Math.abs(q.y - l.y) < 1e-3));
      if (l.kind === "label" && pins.length <= 1 && ((count.get(l.text) || 0) > 1 || sheets > 0)) stubs.push(`"${l.text}" at (${r2(l.x)}, ${r2(l.y)})${pins.length ? ` on ${pins[0].ref}.${pins[0].number}` : ""}`);
      if (l.kind !== "label" && pins.length) {
        const drives = pins.some((q: SPin) => q.type === "output" || q.type === "power_out"), listens = pins.some((q: SPin) => q.type === "input"), both = pins.some((q: SPin) => q.type === "bidirectional" || q.type === "tri_state");
        const want = both || (drives && listens) ? "bidirectional" : drives ? "output" : listens ? "input" : "";
        if (want && l.shape && l.shape !== want && !(want === "bidirectional" && l.shape === "tri_state")) shapes.push(`"${l.text}" at (${r2(l.x)}, ${r2(l.y)}) is drawn as ${l.shape}; its wire has ${want === "bidirectional" ? "bidirectional pins" : want === "output" ? "an output pin, so the signal leaves here: output" : "only input pins, so the signal arrives here: input"}`);
      }
    }
    if (stubs.length) add("labels.stubs", "warning", "A plain label on a wire that reaches one pin is just text: the reader cannot tell the net goes somewhere else. Use a global label with a direction shape (sch.globalize() converts them, sch.label draws one; a name that also labels a drawn-through wire is converted once that label is moved to a wire end).", stubs);
    if (shapes.length) add("labels.shape", "warning", "These global labels have the wrong direction shape (sch.globalize() sets it from the pins).", shapes);
    for (const n of nets) { if (supplyNets.has(n.name) || n.pins.length < 2 || n.pins.some((p) => { const q = byRef.get(p.ref); return q && isConn(q) && q.pins.length >= 8; })) continue; const groups = new Set(n.pins.map((p) => { const q = byRef.get(p.ref); const sp = q && q.pins.find((z: SPin) => z.number === p.number); return sp ? groupAt(sp.x, sp.y) : -1; })); if (groups.size > 1 || groups.has(-1)) byLabel++; else byWire++; }
    if (byLabel + byWire >= 6 && byLabel > byWire) add("wires.first", "warning", `${byLabel} of ${byLabel + byWire} signal nets are joined by labels and only ${byWire} by a drawn wire. The eye follows a wire far faster than it finds a label: wire the parts of a block together and keep labels for nets that leave the block.`);
  }

  // ---- wires.straight / wires.pins / buses
  {
    const slanted = segs.filter((g) => Math.abs(g[0] - g[2]) > 1e-3 && Math.abs(g[1] - g[3]) > 1e-3).map((g) => `(${r2(g[0])}, ${r2(g[1])}) to (${r2(g[2])}, ${r2(g[3])})`);
    const off: string[] = []; const og = (v: number) => Math.abs(v / 1.27 - Math.round(v / 1.27)) > 1e-3;
    for (const p of parts) if (p.pins.some((q: SPin) => og(q.x) || og(q.y))) off.push(p.ref);
    const cross = segs.map(() => 0); let total = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i], b = segs[j]; const d = (a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0]); if (Math.abs(d) < 1e-9) continue;
      const t = ((b[0] - a[0]) * (b[3] - b[1]) - (b[1] - a[1]) * (b[2] - b[0])) / d, u = ((b[0] - a[0]) * (a[3] - a[1]) - (b[1] - a[1]) * (a[2] - a[0])) / d;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 && find(i) !== find(j)) { cross[i]++; cross[j]++; total++; }
    }
    const busy = segs.filter((_, i) => cross[i] > 3).map((g) => `(${r2(g[0])}, ${r2(g[1])}) to (${r2(g[2])}, ${r2(g[3])}) is crossed ${cross[segs.indexOf(g)]} times`);
    if (slanted.length) add("wires.straight", "warning", "Wires run in the four cardinal directions; these are at an angle.", slanted);
    if (off.length) add("wires.straight", "warning", "These parts have pins off the 1.27 mm grid, so wires to them need small jogs.", off.sort(refSort));
    if (busy.length) add("wires.straight", "warning", `A wire should not be crossed more than three times (the sheet has ${total} crossings in all). Reorder the pins, move the part, or use a label or a bus here.`, busy);
    const at = new Map<string, SPin[]>(); for (const p of parts) for (const q of p.pins) { const l = at.get(key(q.x, q.y)); if (l) l.push(q); else at.set(key(q.x, q.y), [q]); }
    const direct: string[] = []; for (const l of at.values()) { const refs = Array.from(new Set(l.map((q) => q.ref))); if (refs.length > 1) direct.push(`${l.map((q) => `${q.ref}.${q.number}`).join(" on ")}`); }
    if (direct.length) add("wires.pins", "note", "These pins sit directly on each other. Put a short wire between them: it is easier to align, to add a label or another connection to, and to see a mistake in.", direct);
    if (!buses.length) {
      const fam = new Map<string, Set<string>>(); for (const n of nets) { const m = /^(.*?[A-Za-z_])(\d+)$/.exec(n.name); if (m && n.named && !supplyNets.has(n.name)) { const l = fam.get(m[1]); if (l) l.add(n.name); else fam.set(m[1], new Set([n.name])); } }
      const wide = Array.from(fam.entries()).filter(([, v]) => v.size >= 4).map(([p, v]) => `${p}[${Array.from(v).map((n) => Number(/\d+$/.exec(n)![0])).sort((a, b) => a - b)[0]}..] (${v.size} nets)`);
      if (wide.length) add("buses", "note", "These groups of four or more numbered nets could be drawn as a bus where they run together.", wide);
    }
  }

  // ---- blocks / notes / title / space
  let lay: any = null; try { lay = await checkLayout({ limit: 6 }); } catch { /* no layout check */ }
  {
    const sections: { title: string; box: number[]; parts: string[] }[] = (lay && lay.sections) || [];
    const real = parts.filter((p) => !isTp(p));
    if (real.length > 8 && !sections.length) add("blocks.labelled", "warning", `${real.length} parts and no labelled block. Group the sheet into functional blocks, each with a title (sch.build(groups=...) or sch.section(title, refs)).`);
    if (sections.length) {
      const inside = new Set(sections.flatMap((x) => x.parts)); const loose = real.map((p) => p.ref).filter((r) => !inside.has(r) && !/^(FID|H|MH|LOGO|NT)\d/i.test(r));
      if (loose.length) add("blocks.labelled", "warning", "These parts belong to no labelled block.", loose.sort(refSort));
      const untitled = sections.filter((x) => !x.title).length; if (untitled) add("blocks.labelled", "warning", `${untitled} framed block${untitled > 1 ? "s have" : " has"} no title.`);
    }
    const tb = doc.titleBlock || {}; const missing = ["title", "rev", "date"].filter((f) => !tb[f]);
    if (missing.length) add("title", "warning", `The title block has no ${missing.join(", ")}. Fill it in with sch.title(title, rev=..., date=...).`);
    if (lay && lay.count) add("space", "warning", `${lay.count} place${lay.count > 1 ? "s" : ""} where something is drawn over something else (sch.overlaps() lists them, sch.tidy() moves fields).`, (lay.overlaps || []).slice(0, 6).map((o: any) => `${o.what}: ${o.a} / ${o.b} at (${o.x}, ${o.y})`));
    const page = (doc.page || [297, 210]); const room = Math.round((page[0] * page[1]) / 1100);
    if (real.length > room) add("space", "warning", `${real.length} parts on one ${doc.paper || "A4"} sheet is crowded. Use a larger page (11 x 17 in or A3 is the usual size) or move a block to its own sheet.`);
  }

  // ---- symbols
  {
    const pack: string[] = [], sides: string[] = [], libSides: string[] = [], untyped: string[] = [];
    for (const p of parts) {
      if (p.pins.length < 6 || isConn(p) || /^(RN|SW|K|T|TR)\d/i.test(p.ref)) continue;
      const lr = p.pins.filter((q: SPin) => q.side === "left" || q.side === "right"); const nums = p.pins.every((q: SPin) => /^\d+$/.test(q.number));
      if (nums && lr.length === p.pins.length) {
        const left = p.pins.filter((q: SPin) => q.side === "left").sort((a: SPin, b: SPin) => a.y - b.y).map((q: SPin) => Number(q.number)), right = p.pins.filter((q: SPin) => q.side === "right").sort((a: SPin, b: SPin) => b.y - a.y).map((q: SPin) => Number(q.number));
        const seq = left.concat(right); const inOrder = seq.every((n: number, i: number) => i === 0 || n === seq[i - 1] + 1);
        if (inOrder && left.length && right.length && p.pins.some((q: SPin) => q.type === "power_in")) pack.push(`${p.ref} ${p.value}: pins run 1 to ${seq.length} around the body like the package`);
      }
      const wrong: string[] = [];
      for (const q of p.pins as SPin[]) {
        const n = pinNet(q); const gnd = q.type === "power_in" && (isGround(q.name) || isGround(n)), sup = q.type === "power_in" && !gnd;
        if (gnd && q.side === "top") wrong.push(`${q.name || q.number} (ground) on top`); else if (sup && q.side === "bottom" && !NEGATIVE.test(q.name)) wrong.push(`${q.name || q.number} (supply) at the bottom`);
      }
      const ins = p.pins.filter((q: SPin) => q.type === "input"), outs = p.pins.filter((q: SPin) => q.type === "output");
      if (ins.length >= 2 && ins.filter((q: SPin) => q.side === "right").length > ins.length / 2) wrong.push("most inputs on the right");
      if (outs.length >= 2 && outs.filter((q: SPin) => q.side === "left").length > outs.length / 2) wrong.push("most outputs on the left");
      if (wrong.length) (/^(Generated|Vendor|LCSC|EasyEDA)/i.test(p.lib) ? sides : libSides).push(`${p.ref} ${p.value}: ${wrong.slice(0, 4).join(", ")}`);
      if (isIc(p) && p.pins.every((q: SPin) => q.type === "passive" || q.type === "unspecified")) untyped.push(`${p.ref} ${p.value}`);
    }
    if (pack.length) add("symbols.logical", "warning", "These symbols copy the physical package. A symbol shows function: inputs left, outputs right, supply pins on top, ground at the bottom, pins grouped by what they do (parts.make or part.fix(pins=...) with sides, or a KiCad library symbol).", pack);
    if (sides.length) add("symbols.logical", "warning", "Pins on the wrong side of the symbol: redraw it with inputs left, outputs right, supplies on top and ground at the bottom (part.fix(pins=...)).", sides);
    if (libSides.length) add("symbols.logical", "note", "These library symbols have pins on an unusual side.", libSides);
    if (untyped.length) add("symbols.pin_types", "warning", "Every pin of these ICs is passive or unspecified, so the ERC cannot check them. Give the pins their real types (input, output, power input, open collector).", untyped);
  }

  // ---- values, capacitors, resistors, MOSFETs
  {
    const blank = parts.filter((p) => !p.dnp && !isTp(p) && (!p.value || p.value === "~" || /^(R|C|L|D|Q|U)$/i.test(p.value) || p.value === p.lib.split(":").pop() && /^Device:(R|C|L)(_|$)/.test(p.lib))).map((p) => p.ref);
    if (blank.length) add("values", "error", "These parts have no value. Give each a value, or mark it do not populate.", blank.sort(refSort));
    const noRating: string[] = [], under: string[] = [], hot: string[] = [], warm: string[] = [];
    for (const p of parts) {
      if (p.pins.length !== 2 || p.dnp) continue; const [a, b] = p.pins.map(pinNet); const va = railV(a), vb = railV(b);
      if (/^C\d/i.test(p.ref)) {
        const work = va !== null && vb !== null ? Math.abs(va - vb) : null; const rated = capVolts(p.fields);
        if (work !== null && work > 0) { if (rated === null) noRating.push(`${p.ref} ${p.value} on ${isGround(a) ? b : a} (${work} V)`); else if (rated < 2 * work - 1e-9) under.push(`${p.ref} ${p.value} is rated ${rated} V on ${isGround(a) ? b : a} (${work} V): use ${Math.ceil(2 * work)} V or more`); }
      } else if (/^R\d/i.test(p.ref)) {
        const r = ohms(p.value); const v = va !== null && vb !== null ? Math.abs(va - vb) : null; if (r === null || !r || v === null || !v) continue;
        const w = (v * v) / r, max = wattsOf(p.fields); if (max === null) continue;
        if (w > max) hot.push(`${p.ref} ${p.value} across ${a} and ${b} dissipates ${r2(w * 1000)} mW; its package is good for ${r2(max * 1000)} mW`); else if (w > max / 2) warm.push(`${p.ref} ${p.value} across ${a} and ${b} dissipates ${r2(w * 1000)} mW of ${r2(max * 1000)} mW`);
      }
    }
    if (under.length) add("caps.voltage", "error", "Capacitors are rated for at least twice the voltage they work at (a ceramic loses most of its capacitance near its rated voltage).", under);
    if (noRating.length) add("caps.voltage", "warning", "These capacitors sit on a supply and state no voltage rating. Add a Voltage field (sch.set(ref, Voltage=\"16V\")) of at least twice the rail.", noRating.sort(refSort));
    if (hot.length) add("resistors.power", "error", "These resistors dissipate more than their package allows.", hot);
    if (warm.length) add("resistors.power", "warning", "These resistors run above half their rated power.", warm);
    const fets: string[] = [];
    for (const p of parts) {
      if (!/^Q\d/i.test(p.ref) || !/mos|fet/i.test(p.lib + " " + p.value)) continue;
      const pin = (n: string) => p.pins.find((q: SPin) => q.name.toUpperCase() === n); const d = pin("D"), sr = pin("S"); if (!d || !sr) continue;
      const dn = pinNet(d), sn = pinNet(sr), dv = railV(dn), sv = railV(sn); const pch = /pmos|p-?ch|_P_|PMOS/i.test(p.lib + " " + p.value);
      if (!pch && dv !== null && sv !== null && sv > dv) fets.push(`${p.ref} (N channel): source on ${sn} (${sv} V) is above drain on ${dn} (${dv} V), so the body diode conducts all the time`);
      if (pch && dv !== null && sv !== null && dv > sv) fets.push(`${p.ref} (P channel): drain on ${dn} (${dv} V) is above source on ${sn} (${sv} V), so the body diode conducts all the time`);
    }
    if (fets.length) add("mosfets", "error", "Check these MOSFETs against the body diode. If the diode is meant to conduct (reverse polarity protection), say so in a note beside the part.", fets);
  }

  // ---- bypass capacitors, power domains
  const icSupply = new Map<string, number>();
  {
    const none: string[] = [], bulkOnly: string[] = [];
    const capsOn = (net: string) => (netPins.get(net) || []).filter((q) => /^C\d/i.test(q.ref)).map((q) => byRef.get(q.ref)).filter((c: any) => c && c.pins.some((z: SPin) => isGround(pinNet(z))));
    for (const p of parts) {
      if (!isIc(p)) continue; let top: number | null = null;
      const sup = Array.from(new Set(p.pins.filter((q: SPin) => q.type === "power_in" && !isGround(pinNet(q)) && !isGround(q.name)).map(pinNet).filter(Boolean))) as string[];
      for (const n of sup) {
        const v = railV(n); if (v !== null && (top === null || v > top)) top = v;
        const caps = capsOn(n);
        if (!caps.length) none.push(`${p.ref} ${p.value}: no capacitor from ${n} to ground`);
        else if (!caps.some((c: any) => { const f = farads(c.value); return f !== null && f <= 1.01e-6; })) bulkOnly.push(`${p.ref} ${p.value}: ${n} has only ${caps.map((c: any) => `${c.ref} ${c.value}`).slice(0, 3).join(", ")}`);
      }
      if (top !== null) icSupply.set(p.ref, top);
    }
    if (none.length) add("bypass", "error", "Every IC supply pin needs a small ceramic bypass capacitor to ground (sch.decouple(pin, \"100nF\"); check the datasheet for the value).", none);
    if (bulkOnly.length) add("bypass", "warning", "These supplies have bulk capacitance but no small (100 nF class) ceramic for the fast edges.", bulkOnly);
    const mixed: string[] = [];
    for (const n of nets) {
      if (supplyNets.has(n.name)) continue; const vs = new Map<number, string[]>();
      for (const q of n.pins) { const v = icSupply.get(q.ref); if (v === undefined || !/^(input|output|bidirectional|tri_state|open_collector)$/.test(q.type)) continue; const l = vs.get(v); if (l) l.push(`${q.ref}.${q.number}`); else vs.set(v, [`${q.ref}.${q.number}`]); }
      if (vs.size > 1) mixed.push(`${n.name}: ${Array.from(vs.entries()).map(([v, l]) => `${l.join(", ")} at ${v} V`).join("; ")}`);
    }
    if (mixed.length) add("domains", "warning", "These signals join ICs on different supply voltages. Check that each input tolerates the other side's level, and that neither side is powered through its pins while its own supply is off (a level shifter or a series resistor where it is not).", mixed);
  }

  // ---- UART, pull-ups, default states
  {
    const swapped: string[] = [], bare: string[] = [], open: string[] = [], floating: string[] = [];
    const pulled = (net: string): boolean => (netPins.get(net) || []).some((q) => { if (!/^(R|RN)\d/i.test(q.ref)) return false; const r = byRef.get(q.ref); return r && r.pins.some((z: SPin) => z !== q && supplyNets.has(pinNet(z))); });
    for (const n of nets) {
      if (supplyNets.has(n.name) || (n.pins.length < 2 && !n.named)) continue;      // a pin on nothing is the ERC's business
      const ic = n.pins.filter((q) => { const p = byRef.get(q.ref); return p && (isIc(p) || isConn(p)); });
      const tx = ic.filter((q) => /(^|[^A-Z])TXD?\d*($|[^A-Z])|UART\d*_?TX/i.test(q.name)), rx = ic.filter((q) => /(^|[^A-Z])RXD?\d*($|[^A-Z])|UART\d*_?RX/i.test(q.name));
      const icOnly = (l: typeof ic) => l.filter((q) => isIc(byRef.get(q.ref)));
      if (icOnly(tx).length >= 2 && !rx.length) swapped.push(`${n.name}: ${tx.map((q) => `${q.ref}.${q.name}`).join(" and ")} are both transmitters`);
      if (icOnly(rx).length >= 2 && !tx.length) swapped.push(`${n.name}: ${rx.map((q) => `${q.ref}.${q.name}`).join(" and ")} are both receivers`);
      if (n.named && /^(UART\d*_?)?(TXD?|RXD?)\d*$/i.test(n.name)) bare.push(`${n.name}: whose TX? Name it after its source (MCU_TX, GPS_TX)`);
      const od = n.pins.some((q) => q.type === "open_collector" || q.type === "open_emitter") || n.pins.some((q) => /^(SDA|SCL|SCK\/SCL|SDA\/SDI|I2C\d*_?(SDA|SCL))\d*$/i.test(q.name)) || /(^|_)(SDA|SCL)\d*$/i.test(n.name);
      if (od && n.pins.some((q) => isIc(byRef.get(q.ref) || { pins: [], ref: "" })) && !pulled(n.name)) open.push(`${n.name}: ${n.pins.slice(0, 3).map((q) => `${q.ref}.${q.name || q.number}`).join(", ")}`);
      const ctl = n.pins.filter((q) => q.type === "input" && /^~?\{?(N?RST|N?RESET|RUN|EN|ENABLE|SHDN|N?SHUTDOWN|BOOT\d*|CE|CHIP_EN|CHIP_PU|PWRKEY)\}?$/i.test(q.name) && isIc(byRef.get(q.ref) || { pins: [], ref: "" }));
      if (ctl.length && !pulled(n.name) && !n.pins.some((q) => q.type === "output" || q.type === "power_out") ) floating.push(`${n.name}: ${ctl.map((q) => `${q.ref}.${q.name}`).join(", ")}`);
    }
    if (swapped.length) add("uart", "error", "UART lines cross: one side's TX goes to the other side's RX.", swapped);
    if (bare.length) add("uart", "warning", "UART nets are named after the device that transmits on them.", bare);
    if (open.length) add("pullups", "error", "Open-drain lines need a pull-up resistor to their supply (I2C: one on SDA and one on SCL).", open);
    if (floating.length) add("pullups", "warning", "These reset, enable or boot pins have nothing that holds them in a known state at power up. Add a pull-up or pull-down resistor, or say in a note that the pin has one inside.", floating);
  }

  // ---- design for test, design for fail
  {
    const tpNets = new Set<string>(); for (const p of parts) if (isTp(p) || isConn(p)) for (const q of p.pins) { const n = pinNet(q); if (n) tpNets.add(n); }
    const want = Array.from(supplyNets).concat(nets.filter((n) => /(^|_|~|\{)(N?RST|N?RESET|RUN)\}?$/i.test(n.name) || n.pins.some((q) => /^~?\{?(N?RST|N?RESET|RUN)\}?$/i.test(q.name))).map((n) => n.name));
    const untested = Array.from(new Set(want)).filter((n) => !tpNets.has(n));
    if (parts.some(isIc) && untested.length) add("test.points", "warning", "No test point or connector pin on these nets. Put test points on every supply, on ground and on reset (sch.test_point(net)), and say in a note what to expect there.", untested);
    const prog = nets.filter((n) => n.pins.some((q) => /^(SWDIO|SWCLK|SWD|TCK|TMS|TDI|TDO|UPDI|PDI|ICSP\w*|PGC|PGD)$/i.test(q.name) && isIc(byRef.get(q.ref) || { pins: [], ref: "" })));
    const unreachable = prog.filter((n) => !tpNets.has(n.name)).map((n) => `${n.name} (${n.pins.filter((q) => isIc(byRef.get(q.ref) || { pins: [], ref: "" })).map((q) => `${q.ref}.${q.name}`).join(", ")})`);
    if (unreachable.length) add("test.points", "error", "These programming and debug pins reach no connector or pad, so the IC cannot be programmed on the board.", unreachable);
    if (parts.some(isIc) && !parts.some((p) => /led/i.test(p.lib + " " + p.value)) && !parts.some(isTp)) add("test.points", "note", "The board has no LED and no test point. Add something to debug with: a status LED, a UART header, a scope probe point.");
    const feeds = (p: any) => p && isConn(p) && /usb|barrel|jack|batt|terminal|screw|jst|dc|power|pwr/i.test(p.lib + " " + p.value);
    const entry = rails.filter((n) => (netPins.get(n) || []).some((q) => feeds(byRef.get(q.ref))) && !(netPins.get(n) || []).some((q) => /^(F|D|Q|TVS|FB)\d/i.test(q.ref) || q.type === "power_out"));
    if (entry.length) add("fail.safe", "warning", "These supplies come in through a connector with no fuse, diode, TVS or MOSFET on them. Add over-voltage and reverse polarity protection where a user can get it wrong.", entry);
    const regs = parts.filter((p) => isIc(p) && p.pins.some((q: SPin) => q.type === "power_out"));
    if (regs.length && !parts.some((p) => /^(JP|SB)\d/i.test(p.ref) || (/^R\d/i.test(p.ref) && ohms(p.value) === 0))) add("fail.safe", "note", `${regs.length} regulator${regs.length > 1 ? "s" : ""} and no 0 ohm link or cuttable jumper. One in series with each regulator output lets a faulty supply be cut off from the rest of the board.`, regs.map((p) => p.ref));
    let nc = 0; try { for (const it of doc.items.values() as Iterable<any>) if (it.kind === "no_connect") nc++; } catch { /* none */ }
    if (nc >= 4) add("fail.safe", "note", `${nc} pins carry a no-connect flag. Bring spare GPIO pins out to test points or a header: they are what saves a board when something was forgotten.`);
  }

  // ---- ERC and the bill of materials
  {
    try { const marks: any[] = s.ercCheck(doc, {}); const e = marks.filter((m) => m.severity === "error"), w = marks.filter((m) => m.severity !== "error");
      if (e.length) add("erc", "error", `The ERC reports ${e.length} error${e.length > 1 ? "s" : ""} (sch.check() lists them).`, Array.from(new Set(e.map((m) => m.code))));
      if (w.length) add("erc", "warning", `The ERC reports ${w.length} warning${w.length > 1 ? "s" : ""}. Fix each, or write beside it why it is accepted.`, Array.from(new Set(w.map((m) => m.code))));
    } catch { /* no ERC here */ }
    const noPn = parts.filter((p) => !p.dnp && !isTp(p) && !/^(H|MH|FID|LOGO|NT)\d/i.test(p.ref) && !(field(p.fields, MPN) && field(p.fields, MFR))).map((p) => p.ref);
    if (noPn.length) add("bom", "warning", "These parts lack an MFR or an MPN field, so the bill of materials cannot be ordered from (sch.set(ref, MFR=..., MPN=...); a part placed from parts.find brings them).", noPn.sort(refSort));
    const noDs = parts.filter((p) => !p.dnp && isIc(p) && !/^https?:/i.test(p.fields.Datasheet || "")).map((p) => p.ref);
    const noDist = parts.filter((p) => !p.dnp && !isTp(p) && field(p.fields, MPN) && !field(p.fields, DIST)).length;
    if (noDs.length) add("bom", "note", "These ICs have no datasheet link.", noDs.sort(refSort));
    if (noDist) add("bom", "note", `${noDist} parts have an MPN but no distributor part number.`);
  }

  // the support circuits (review-circuit.ts): bypass per pin, pull-ups, crystal load, USB-C, regulators, LEDs, net-name slips
  try { reviewCircuit({ parts, nets, byRef, netPins, supplyNets, pinNet, railV, isIc, isGround, add }); } catch (err) { add("erc", "note", `The circuit checks could not run: ${err instanceof Error ? err.message : String(err)}`); }
  return report("schematic review", path, SCH_RULES.concat(CIRCUIT_RULES), out, SCH_MANUAL.concat(CIRCUIT_MANUAL));
}

// ---------------------------------------------------------------- board

const PCB_RULES: Rule[] = [
  { id: "bypass.near", what: "Small bypass capacitors sit right next to the power and ground leads of their IC" },
  { id: "power.width", what: "Power lines are as wide as reasonably possible" },
  { id: "power.vias", what: "Power lines change layer through larger drills or several vias" },
  { id: "ground.planes", what: "Ground planes on both sides, with a zone clearance above the design rule" },
  { id: "ground.stitching", what: "Ground planes are stitched together with vias" },
  { id: "size", what: "The board is as small as it can be" },
  { id: "assembly.space", what: "There is physical space around components for assembly" },
  { id: "test.access", what: "Test points are in easily reached places, on a side the fixture can reach" },
  { id: "silk.refs", what: "Reference designators are small, readable and not on pads or vias" },
  { id: "silk.title", what: "Organisation, board name, version and date are on the silkscreen" },
  { id: "fiducials", what: "Three fiducials on every side that is machine assembled" },
  { id: "drc", what: "The final DRC has no errors" },
];
const PCB_MANUAL = [
  "No trace you need to probe is hidden under a part.",
  "Print the board 1:1 and lay the components on the printout to check the packages.",
  "All components are in stock before the board is ordered.",
];

export async function reviewBoard(doc: any, path: string): Promise<any> {
  const P = PCB(), k = K(); if (!P) throw new ToolError("The board tools are not loaded.");
  const out: Finding[] = []; const add = (rule: string, level: Level, message: string, items?: string[]) => out.push({ rule, level, message, count: items ? items.length : undefined, items: items && items.length ? few(items) : undefined });
  const NT = P.netTable(doc); const settings = P.designSettings(ED().proSettings || null);
  const fps: any[] = [], tracks: any[] = [], vias: any[] = [], zones: any[] = [], silk: { text: string; layer: string }[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const netById = new Map<string, string>(); try { for (const e of P.netlist(doc).nets.values()) for (const c of [...e.tracks, ...e.vias, ...e.zones]) netById.set(c.id, e.key); } catch { /* no netlist */ }
  const layerOf = (n: any) => { const l = k.kid(n, "layer"); return l ? k.str(l[1]) : ""; };
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.edge && it.bbox) { x0 = Math.min(x0, it.bbox[0]); y0 = Math.min(y0, it.bbox[1]); x1 = Math.max(x1, it.bbox[2]); y1 = Math.max(y1, it.bbox[3]); }
    if (it.kind === "footprint") {
      let cy: number[] | null = null; try { const c = P.courtyards({ node: it.node }); let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity; for (const kk of Object.keys(c)) for (const loop of c[kk]) for (const q of loop) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); cc = Math.max(cc, q[0]); d = Math.max(d, q[1]); } if (a <= cc) cy = [a, b, cc, d]; } catch { /* none */ }
      const pads = P.padsOf(it).map((p: any) => ({ number: p.number, x: p.x, y: p.y, w: p.w, h: p.h, type: p.type, net: NT.key(p.net) || "" }));
      fps.push({ ref: it.ref || "?", value: it.value || "", lib: it.lib || "", x: it.x, y: it.y, side: it.layer === "B.Cu" ? "back" : "front", box: cy || it.bbox, pads, node: it.node });
    } else if (it.kind === "segment" || it.kind === "arc") { const w = k.kid(it.node, "width"); tracks.push({ width: w ? k.num(w[1]) : 0, net: netById.get(it.id) || "", layer: layerOf(it.node) }); }
    else if (it.kind === "via") { const a = k.atOf(it.node), d = k.kid(it.node, "drill"); vias.push({ x: a[0], y: a[1], drill: d ? k.num(d[1]) : 0, net: netById.get(it.id) || "" }); }
    else if (it.kind === "zone") {
      const nn = k.kid(it.node, "net_name"), ls = k.kid(it.node, "layers") || k.kid(it.node, "layer"), cp = k.kid(it.node, "connect_pads"), cl = cp && k.kid(cp, "clearance");
      if (k.kid(it.node, "keepout")) continue;
      zones.push({ net: netById.get(it.id) || (nn ? k.str(nn[1]) : ""), layers: ls ? ls.slice(1).map((x: any) => k.str(x)) : [], clearance: cl ? k.num(cl[1]) : 0 });
    } else if (it.kind === "gr_text" || it.kind === "gr_text_box") { const l = layerOf(it.node); if (/SilkS/.test(l)) silk.push({ text: k.str(it.node[1]), layer: l }); }
  }
  const bare = (n: string) => n.replace(/^\//, "");
  const isGnd = (n: string) => isGround(bare(n)); const isSup = (n: string) => !isGnd(n) && SUPPLY.test(bare(n)) && !/_(EN|PG|FB|SENSE|OK)$/i.test(n);
  const ics = fps.filter((f) => /^(U|IC)\d/i.test(f.ref)), caps = fps.filter((f) => /^C\d/i.test(f.ref));
  const smd = (side: string) => fps.some((f) => f.side === side && f.pads.length >= 2 && f.pads.some((p: any) => p.type === "smd"));

  // ---- bypass capacitors at their pins
  {
    const far: string[] = [], none: string[] = [];
    for (const u of ics) {
      const seen = new Set<string>();
      for (const p of u.pads) {
        if (!isSup(p.net) || seen.has(p.net + p.number)) continue; seen.add(p.net + p.number);
        let best = Infinity, who = "";
        for (const c of caps) { if (!c.pads.some((q: any) => isGnd(q.net))) continue; for (const q of c.pads) if (q.net === p.net) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < best) { best = d; who = c.ref; } } }
        if (!isFinite(best)) none.push(`${u.ref}.${p.number} (${bare(p.net)})`); else if (best > 4) far.push(`${u.ref}.${p.number} (${bare(p.net)}): nearest capacitor ${who} is ${r2(best)} mm away`);
      }
    }
    if (far.length) add("bypass.near", "warning", "A bypass capacitor belongs within a couple of millimetres of the supply pin it serves, closer than anything else (board.autoplace(near={\"C1\": \"U1\"}) or board.place).", far);
    if (none.length) add("bypass.near", "error", "These IC supply pads have no capacitor on their net at all.", none);
  }
  // ---- power tracks and vias
  {
    const sig = tracks.filter((t) => t.net && !isSup(t.net) && !isGnd(t.net)).map((t) => t.width).sort((a, b) => a - b); const usual = sig.length ? sig[Math.floor(sig.length / 2)] : 0;
    const thin = new Map<string, number>(); for (const t of tracks) if (isSup(t.net) && usual && t.width <= usual + 1e-6) thin.set(bare(t.net), Math.min(thin.get(bare(t.net)) ?? Infinity, t.width));
    if (thin.size) add("power.width", "warning", `These supplies are routed no wider than a signal track (${usual} mm). Make power lines as wide as there is room for: board.route(widths={net: 0.5}) or a net class.`, Array.from(thin.entries()).map(([n, w]) => `${n}: ${w} mm`));
    const byNet = new Map<string, any[]>(); for (const v of vias) if (isSup(v.net)) { const l = byNet.get(v.net); if (l) l.push(v); else byNet.set(v.net, [v]); }
    const lone = Array.from(byNet.entries()).filter(([, l]) => l.length === 1 && l[0].drill <= 0.3 + 1e-6).map(([n, l]) => `${bare(n)}: one via with a ${l[0].drill} mm drill`);
    if (lone.length) add("power.vias", "warning", "These supplies change layer through a single small via. Use a larger drill or two or three vias side by side.", lone);
  }
  // ---- ground planes
  {
    const gz = zones.filter((z) => isGnd(z.net)); const layers = new Set(gz.flatMap((z) => z.layers.flatMap((l: string) => (l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : l === "*.Cu" ? doc.copper.slice() : [l]))));
    const copper: string[] = doc.copper.slice();
    if (tracks.length || fps.length > 3) {
      if (!gz.length) add("ground.planes", "warning", "The board has no ground plane. Pour ground on both sides: board.zone(\"GND\", layer=\"F.Cu\") and board.zone(\"GND\", layer=\"B.Cu\").");
      else if (copper.length <= 2 && layers.size < 2) add("ground.planes", "warning", `Ground is poured on ${Array.from(layers).join(", ")} only. Pour it on both sides.`);
      const tight = gz.filter((z) => z.clearance && z.clearance < settings.clearance * 1.25 - 1e-6);
      if (tight.length) add("ground.planes", "warning", `A ground zone's clearance (${tight[0].clearance} mm) is no larger than the design rule (${settings.clearance} mm). Give the pour more room than a track gets: about 0.2 mm for a 0.15 mm rule.`);
      if (layers.size >= 2 && isFinite(x0)) {
        const area = ((x1 - x0) * (y1 - y0)) / 100; const n = vias.filter((v) => isGnd(v.net)).length + fps.reduce((a, f) => a + f.pads.filter((p: any) => p.type === "thru_hole" && isGnd(p.net)).length, 0);
        if (n < Math.max(4, Math.round(area))) add("ground.stitching", "warning", `${n} ground via${n === 1 ? "" : "s"} tie the ground planes together on a ${r2(area)} cm² board. Stitch them about every centimetre, and beside every signal via (board.stitch()).`);
      }
    }
  }
  // ---- size, assembly space, test points
  {
    if (isFinite(x0) && fps.length) {
      const board = (x1 - x0) * (y1 - y0); let used = 0; for (const f of fps) if (f.box) used += (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
      const backToo = fps.some((f) => f.side === "back" && f.pads.length >= 2); const share = used / (board * (backToo ? 2 : 1));
      if (share < 0.2 && board > 400) add("size", "note", `Parts cover ${Math.round(share * 100)} % of the ${r2(x1 - x0)} x ${r2(y1 - y0)} mm board. Unless the size is fixed by a case or a connector pattern, it can be smaller.`);
    }
    const hit = (a: number[], b: number[], g: number) => a[0] < b[2] + g && a[2] > b[0] - g && a[1] < b[3] + g && a[3] > b[1] - g;
    const tight: string[] = [];
    for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) { const a = fps[i], b = fps[j]; if (a.side === b.side && a.box && b.box && hit(a.box, b.box, -0.01)) tight.push(`${a.ref} and ${b.ref}`); }
    if (tight.length) add("assembly.space", "error", "These courtyards overlap, so the parts cannot both be assembled (board.clashes() gives the amounts).", tight);
    const tps = fps.filter((f) => /^TP\d/i.test(f.ref) || /test ?point/i.test(f.lib));
    if (tps.length) {
      const sidesUsed = Array.from(new Set(tps.map((f) => f.side)));
      const hidden = tps.filter((t) => fps.some((f) => f !== t && f.side === t.side && f.box && t.x > f.box[0] && t.x < f.box[2] && t.y > f.box[1] && t.y < f.box[3])).map((t) => t.ref);
      if (hidden.length) add("test.access", "error", "These test points lie inside another part's courtyard and cannot be probed.", hidden);
      if (sidesUsed.length > 1) add("test.access", "note", `Test points are on both sides (${tps.filter((f) => f.side === "front").length} front, ${tps.filter((f) => f.side === "back").length} back). A bed-of-nails fixture reaches one side: keep them on one, or use through-hole test points.`);
    }
  }
  // ---- silkscreen, fiducials, DRC
  {
    const over: string[] = [];
    for (const f of fps) {
      for (const c of f.node) {
        if (!Array.isArray(c) || !(c[0] === "property" && k.str(c[1]) === "Reference" || c[0] === "fp_text" && k.str(c[1]) === "reference")) continue;
        const l = layerOf(c); if (!/SilkS/.test(l)) continue; if (k.kid(c, "hide") && k.str(k.kid(c, "hide")[1]) !== "no") continue;
        const a = k.atOf(c); if (!a) continue; const item = doc.items.get(k.str((k.kid(f.node, "uuid") || [])[1] || "")); const g = (item && item.geom || []).find((q: any) => q.t === "text" && String(q.text) === f.ref);
        const tx = g ? g.x : a[0], ty = g ? g.y : a[1]; const tw = (g ? k.textWidth(g.text, g.size, g.w || 0) : f.ref.length) / 2 + 0.1, th = (g ? g.size : 1) / 2 + 0.1;
        const printed = /^B\./.test(l) ? "back" : "front";      // a name printed on the other side of the board lies on that side's pads, not on its own part's
        for (const o of fps) { if (o.side !== printed && !o.pads.some((q: any) => q.type === "thru_hole")) continue; if (o === f) continue; const p = o.pads.find((q: any) => Math.abs(q.x - tx) < q.w / 2 + Math.min(tw, 0.3) && Math.abs(q.y - ty) < q.h / 2 + th * 0.5); if (p && g) { over.push(`${f.ref} is printed over pad ${o.ref}.${p.number}`); break; } }
      }
    }
    if (over.length) add("silk.refs", "warning", "Reference designators must not sit on pads: the fab cuts them off and they cannot be read. board.silkscreen() (or the silkscreen edit) moves, shrinks or turns every reference into the clear.", over);
    const all = silk.map((t) => t.text).join("\n");
    const lacks: string[] = [];
    if (!silk.length) lacks.push("any text"); else { if (!/\b(v|rev|r)\.?\s*\d|\bV\d/i.test(all)) lacks.push("a version"); if (!/\b(19|20)\d\d\b|\$\{(ISSUE_)?DATE\}/.test(all)) lacks.push("a date"); if (!/[A-Za-z]{3,}/.test(all.replace(/\b(rev|ver|version)\b/gi, ""))) lacks.push("the board's name"); }
    if (lacks.length && fps.length > 3) add("silk.title", "warning", `The silkscreen lacks ${lacks.join(", ")}. Put the organisation, the board's name, its version and the date on it: board.mark("Name", rev="V1").`);
    for (const side of ["front", "back"]) {
      if (!smd(side)) continue; const n = fps.filter((f) => f.side === side && (/^FID\d/i.test(f.ref) || /fiducial/i.test(f.lib))).length;
      // a board narrower than about 25 mm has no three corners to spare (a fiducial wants 3 mm of clear board): its
      // fiducials go on the panel rails, as the assembler does for small boards anyway
      const ext = fps.reduce((e, f) => [Math.min(e[0], f.box[0]), Math.min(e[1], f.box[1]), Math.max(e[2], f.box[2]), Math.max(e[3], f.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      const small = Math.min(ext[2] - ext[0], ext[3] - ext[1]) < 25;
      if (n < 3 && small) add("fiducials", "note", `The ${side} has ${n} fiducial${n === 1 ? "" : "s"}. The board is too narrow to hold three clear of its parts: have it assembled on a panel and put the three fiducials on the panel rails.`);
      else if (n < 3) add("fiducials", "warning", `The ${side} is machine assembled and has ${n} fiducial${n === 1 ? "" : "s"}; pick and place needs three (board.fiducials()).`);
    }
    try { const marks: any[] = P.drc(doc, settings, {}); const e = marks.filter((m) => m.severity === "error");
      if (e.length) { const kinds = new Map<string, number>(); for (const m of e) kinds.set(m.code, (kinds.get(m.code) || 0) + 1); add("drc", "error", `The DRC reports ${e.length} error${e.length > 1 ? "s" : ""} (board.check() lists them).`, Array.from(kinds.entries()).map(([c, n]) => `${c}: ${n}`)); }
    } catch { /* no DRC here */ }
  }
  // ---- the physics of the layout: RF, return paths, converters, heat, isolation (review-physics.ts)
  try { reviewPhysics(doc, P, k, settings, add); } catch (err) { add("drc", "note", `The layout physics checks could not run: ${(err as Error).message}`); }
  const r = report("layout review", path, PCB_RULES.concat(PHYSICS_RULES), out, PCB_MANUAL.concat(PHYSICS_MANUAL)); r.source += " " + PHYSICS_SOURCE; return r;
}

function report(check: string, path: string, rules: Rule[], findings: Finding[], manual: string[]) {
  const order: Record<Level, number> = { error: 0, warning: 1, note: 2 }; const pos = new Map(rules.map((r, i) => [r.id, i]));
  findings.sort((a, b) => order[a.level] - order[b.level] || (pos.get(a.rule) || 0) - (pos.get(b.rule) || 0));
  const failed = new Set(findings.filter((f) => f.level !== "note").map((f) => f.rule));
  return { document: path, check, errors: findings.filter((f) => f.level === "error").length, warnings: findings.filter((f) => f.level === "warning").length, notes: findings.filter((f) => f.level === "note").length,
    rules: rules.length, passed: rules.filter((r) => !failed.has(r.id)).map((r) => r.id), findings: findings.map((f) => Object.assign({ what: (rules.find((r) => r.id === f.rule) || { what: "" }).what }, f)),
    manual, source: "Andrew Greenberg, Actually Useful Schematics (KiCon 2025), Checklist for Schematics v2026-02-15 and Checklist for PCB Layout v2025-05-06; Graham Sutherland, Creating high quality electronics schematics (2025)." };
}

/** Review the open document (or the one named) against the checklists: a sheet against the schematic list, the board against the layout list. */
export async function reviewDesign(input: { doc?: string; level?: string; rule?: string; plan?: any } = {}): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc);
  if (input.plan) { const P = PCB(); if (doc.type === "sch" || !P) throw new ToolError("A layout plan needs the board."); return physicsPlan(doc, P, K(), P.designSettings(ED().proSettings || null), input.plan); }
  const r: any = doc.type === "sch" ? await reviewSchematic(doc, path) : await reviewBoard(doc, path);
  if (input.rule) r.findings = r.findings.filter((f: Finding) => f.rule === input.rule || f.rule.startsWith(input.rule + "."));
  if (input.level === "error") r.findings = r.findings.filter((f: Finding) => f.level === "error"); else if (input.level === "warning") r.findings = r.findings.filter((f: Finding) => f.level !== "note");
  return r;
}
