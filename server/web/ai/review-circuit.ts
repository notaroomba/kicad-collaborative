// review-circuit — what a schematic's support circuits must be, checked from the netlist.
//
// The schematic review (review.ts) checks how a sheet is drawn and the basics of every part.  This file adds
// the circuit knowledge an engineer applies part by part: one bypass capacitor per supply pin, I2C pull-ups
// once per bus and of a sane value, crystal load capacitors that match the crystal, the two CC resistors of a
// USB-C socket, ESD protection on USB data, a regulator's capacitors, the output voltage its feedback divider
// really sets, what a linear regulator can dissipate in its package, LED current, and net names that are one
// slip apart.  Each finding names the parts and says what to change.
//
// It is called from reviewSchematic with what that function has already worked out, so nothing is read twice.
import { farads, ohms } from "./review";

type Level = "error" | "warning" | "note";
interface Pin { ref: string; number: string; name: string; type: string }
interface Part { ref: string; value: string; lib: string; fields: Record<string, string>; pins: Pin[]; dnp: boolean }
interface Net { name: string; named?: boolean; pins: Pin[] }
export interface CircuitContext {
  parts: Part[]; nets: Net[]; byRef: Map<string, Part>; netPins: Map<string, Pin[]>; supplyNets: Set<string>;
  pinNet(p: Pin): string; railV(net: string): number | null; isIc(p: Part): boolean; isGround(net: string): boolean;
  add(rule: string, level: Level, message: string, items?: string[]): void;
}

export const CIRCUIT_RULES: { id: string; what: string }[] = [
  { id: "bypass.count", what: "One small bypass capacitor for each supply pin, not one for the whole chip" },
  { id: "i2c.pullups", what: "Each I2C line has exactly one pull-up, of a value that suits the bus" },
  { id: "crystal.load", what: "A crystal has a load capacitor on each side, sized C = 2 x (CL - Cstray)" },
  { id: "usbc.cc", what: "A USB-C socket has its own resistor on CC1 and on CC2" },
  { id: "usb.esd", what: "USB data lines have ESD protection" },
  { id: "regulator.caps", what: "A regulator has a capacitor on its input and on its output" },
  { id: "regulator.setpoint", what: "An adjustable regulator's feedback divider sets the voltage its output net is named for" },
  { id: "regulator.heat", what: "A linear regulator's package can lose the heat of its voltage drop at the load current" },
  { id: "led.current", what: "Every LED has a series resistor that sets a sane current" },
  { id: "nets.typos", what: "No two net names are a slip apart, and no named net ends at a single pin" },
  { id: "passives.sizes", what: "Small resistors and capacitors use one package size where they can" },
];
export const CIRCUIT_MANUAL = [
  "Each IC's support circuit was compared with the typical application in its datasheet: capacitor values and count, pull-ups, strapping pins.",
  "The crystal's load capacitance (CL) and the stray capacitance assumed for its pins were taken from the datasheets, and the oscillator's drive level suits the crystal.",
  "Every regulator's load current is stated on the sheet, and its dissipation was checked at the highest input voltage.",
];

/** The reference voltage of common adjustable regulators, from their datasheets.  top: the feedback resistor that goes to the output. */
const VREF: [RegExp, number][] = [
  [/LM317|LM1117|AMS1117|LD1117|NCP1117|TLV1117|LM1085|LM1086|LT1086|LM350|LM338|XL6009|AP3012/i, 1.25],
  [/LM2596|LM2576|LM2594|LM2595|LM2575|LM2733|LM27313/i, 1.23], [/TPS5430|TPS5410|TPS5420/i, 1.221], [/MIC5219|MIC5205|MIC29\d\d/i, 1.242],
  [/TPS54331|TPS54231|TPS54332|MP1584|MP2315|MP2359|TPS62130|TPS62140|AP7361|AP7365|AP2127/i, 0.8], [/MP2307|MP1482/i, 0.925],
  [/MT3608|SX1308|TLV62569|TLV62568|SY8089|TPS62A01|AP3429|RT8059|TPS6282[0-9]|TPS61022/i, 0.6], [/TPS56[234]20[01]/i, 0.765],
  [/TPS61023/i, 0.595], [/TPS54302|TPS54202/i, 0.596], [/LMR336[0-9]0/i, 1.0], [/TPS73601|TPS73701|TPS61088|TPS61089/i, 1.204],
];
/** What a package can lose in still air on a small board, in watts (the usual rule of thumb; the datasheet's thermal resistance decides). */
const PACKAGE_W: [RegExp, number, string][] = [
  [/SOT-?223/i, 1.0, "SOT-223"], [/TO-?252|DPAK/i, 1.5, "DPAK"], [/TO-?263|D2PAK/i, 2.0, "D2PAK"], [/TO-?220/i, 2.0, "TO-220 without a heatsink"], [/SOT-?89/i, 0.5, "SOT-89"],
  [/SOT-?23|TSOT|SC-?59/i, 0.3, "SOT-23"], [/SC-?70|SOT-?323|SOT-?353|SOT-?363/i, 0.2, "SC-70"], [/DFN|SON|QFN|WSON|UDFN/i, 0.7, "DFN with its pad soldered"], [/SOIC|SOP-?8|MSOP/i, 0.6, "SOIC"],
];
const ESD = /(^|[^a-z])(tvs|esd)|usblc|prtr5v|tpd\d|sp05|pesd|srv05|ip4220|pusb|nup\d|rclamp|esda|ecmf|dt1042|d3v3|sm[abc]j\d|smf\d/i;
const fmtR = (r: number) => (r >= 1e6 ? `${+(r / 1e6).toFixed(2)}M` : r >= 1e3 ? `${+(r / 1e3).toFixed(2)}k` : `${+r.toFixed(1)}R`);
const fmtC = (c: number) => (c >= 1e-6 ? `${+(c * 1e6).toFixed(2)}uF` : c >= 1e-9 ? `${+(c * 1e9).toFixed(2)}nF` : `${+(c * 1e12).toFixed(1)}pF`);
const r2 = (v: number) => Math.round(v * 100) / 100;
const footprintOf = (p: Part) => { for (const k of Object.keys(p.fields)) if (/^footprint$/i.test(k)) return p.fields[k] || ""; return ""; };
const fieldOf = (p: Part, re: RegExp) => { for (const k of Object.keys(p.fields)) if (re.test(k) && p.fields[k] && p.fields[k] !== "~") return p.fields[k]; return ""; };

export function reviewCircuit(c: CircuitContext): void {
  const { parts, nets, byRef, netPins, supplyNets, pinNet, railV, isIc, isGround, add } = c;
  const live = parts.filter((p) => !p.dnp);
  const isR = (p?: Part) => !!p && /^R\d/i.test(p.ref) && p.pins.length === 2, isC = (p?: Part) => !!p && /^C\d/i.test(p.ref) && p.pins.length === 2;
  const other = (p: Part, pin: Pin) => p.pins.find((q) => q !== pin && q.number !== pin.number) as Pin;
  /** two-pin parts of a kind on a net, each with the net its other end is on */
  const across = (net: string, kind: (p?: Part) => boolean) => (netPins.get(net) || []).map((q) => ({ pin: q, part: byRef.get(q.ref) as Part })).filter((x) => kind(x.part) && !x.part.dnp).map((x) => ({ part: x.part, far: pinNet(other(x.part, x.pin)) }));
  const capsToGround = (net: string) => across(net, isC).filter((x) => isGround(x.far));
  const pinNamed = (p: Part, re: RegExp) => p.pins.filter((q) => re.test(q.name.replace(/[~{}]/g, "")));

  // ---- one bypass capacitor per supply pin
  {
    const short: string[] = [];
    for (const net of supplyNets) {
      if (isGround(net)) continue;
      const pins = (netPins.get(net) || []).filter((q) => { const p = byRef.get(q.ref); return p && !p.dnp && isIc(p) && q.type === "power_in"; });
      // pins that share a number-less stacked symbol pin are one pin; count distinct pin numbers per part
      const count = new Set(pins.map((q) => `${q.ref}.${q.number}`)).size; if (count < 2) continue;
      const small = capsToGround(net).filter((x) => { const f = farads(x.part.value); return f !== null && f <= 1.01e-6; }).length;
      if (small > 0 && small < count) { const by = new Map<string, number>(); for (const q of pins) by.set(q.ref, (by.get(q.ref) || 0) + 1); short.push(`${net}: ${count} supply pins (${Array.from(by.entries()).map(([r, n]) => `${r} x${n}`).join(", ")}) and ${small} small capacitor${small > 1 ? "s" : ""}`); }
    }
    if (short.length) add("bypass.count", "warning", "Each supply pin wants its own small ceramic (100 nF class) right at the pin; one capacitor cannot sit next to several pins. Add the missing ones (sch.decouple(pin, \"100nF\")), unless the datasheet says the pins share one.", short);
  }

  // ---- I2C pull-ups: once per bus, sane value
  {
    const twice: string[] = [], odd: string[] = [];
    for (const n of nets) {
      const i2c = /(^|[_/])(SDA|SCL)\d*$/i.test(n.name) || n.pins.some((q) => /^(SDA|SCL|I2C\d*_?(SDA|SCL))\d*$/i.test(q.name)); if (!i2c || supplyNets.has(n.name)) continue;
      const ups = across(n.name, isR).filter((x) => supplyNets.has(x.far) && !isGround(x.far)); if (!ups.length) continue;      // a missing pull-up is the pullups rule's
      const vals = ups.map((x) => ohms(x.part.value)).filter((v): v is number => v !== null && v > 0);
      const par = vals.length ? 1 / vals.reduce((a, v) => a + 1 / v, 0) : null; const v = railV(ups[0].far) || 3.3;
      if (ups.length > 1) twice.push(`${n.name}: ${ups.map((x) => `${x.part.ref} ${x.part.value}`).join(", ")}${par ? ` (together ${fmtR(par)})` : ""}`);
      // the bus sinks at most 3 mA at 0.4 V: R >= (V - 0.4) / 3 mA.  Above about 10k the rise time fails at 400 kHz on a normal bus.
      const rmin = (v - 0.4) / 0.003;
      if (par !== null && par < rmin * 0.95) odd.push(`${n.name}: ${fmtR(par)} to ${ups[0].far} asks the bus for ${r2((v - 0.4) / par * 1000)} mA; devices must sink only 3 mA, so no less than ${fmtR(rmin)}`);
      else if (par !== null && par > 10500) odd.push(`${n.name}: ${fmtR(par)} is weak; 2.2k to 4.7k suits 400 kHz, up to 10k a short 100 kHz bus`);
    }
    if (twice.length) add("i2c.pullups", "warning", "An I2C line has one pull-up for the whole bus. Several in parallel (often one on each module) lower the resistance until a device can no longer pull the line low. Keep one and leave the others unfitted.", twice);
    if (odd.length) add("i2c.pullups", "warning", "These I2C pull-ups are outside what the bus allows.", odd);
  }

  // ---- crystals: a load capacitor each side, of the right size
  {
    const missing: string[] = [], wrong: string[] = [], unknown: string[] = [];
    for (const p of live) {
      if (!(/^(Y|XTAL)\d/i.test(p.ref) || /crystal|xtal/i.test(p.lib)) || /oscillator|MEMS|TCXO|VCXO/i.test(p.lib + " " + p.value)) continue;
      if (p.pins.some((q) => supplyNets.has(pinNet(q)) && !isGround(pinNet(q)))) continue;            // it has a supply pin: an oscillator module
      const legs = Array.from(new Set(p.pins.map(pinNet).filter((n) => n && !isGround(n)))); if (legs.length !== 2) continue;
      if (/32\.?768|32k/i.test(p.value) && legs.every((n) => !capsToGround(n).length)) continue;      // watch crystals often use the chip's internal capacitors
      const caps = legs.map((n) => capsToGround(n)); const none = legs.filter((_, i) => !caps[i].length);
      if (none.length) { missing.push(`${p.ref} ${p.value}: no capacitor to ground on ${none.join(" and ")}`); continue; }
      const vals = caps.map((l) => farads(l[0].part.value)); if (vals[0] === null || vals[1] === null) continue;
      const names = caps.map((l) => `${l[0].part.ref} ${l[0].part.value}`).join(" and ");
      if (Math.abs(vals[0] - vals[1]) > 0.11 * Math.max(vals[0], vals[1])) wrong.push(`${p.ref}: ${names} differ; the two load capacitors are the same value`);
      const clText = fieldOf(p, /^(CL|C_?load|load[ _]?cap.*)$/i) || (/(\d+(?:\.\d+)?)\s*pF/i.exec(p.value) || [""])[0]; const cl = clText ? farads(clText.replace(/\s/g, "")) : null;
      if (cl === null) { unknown.push(`${p.ref} ${p.value} with ${names}`); continue; }
      // C = 2 x (CL - Cstray), with 2 to 5 pF of pin and track capacitance
      const lo = 2 * (cl - 5e-12), hi = 2 * (cl - 2e-12); const avg = (vals[0] + vals[1]) / 2;
      if (avg < lo * 0.9 || avg > hi * 1.1) wrong.push(`${p.ref} (CL ${fmtC(cl)}): ${names}; C = 2 x (CL - Cstray) gives ${fmtC(Math.max(lo, 1e-12))} to ${fmtC(hi)} for 2 to 5 pF of stray`);
    }
    if (missing.length) add("crystal.load", "error", "A crystal needs a capacitor to ground on each side, or the oscillator runs off frequency or does not start (unless the chip has them inside: say so in a note).", missing);
    if (wrong.length) add("crystal.load", "warning", "These crystal load capacitors do not match the crystal. The crystal is cut for its load capacitance CL, and each capacitor is C = 2 x (CL - Cstray).", wrong);
    if (unknown.length) add("crystal.load", "note", "These crystals do not state their load capacitance, so the capacitors cannot be checked. Add a CL field from the datasheet (sch.set(ref, CL=\"10pF\")).", unknown);
  }

  // ---- USB-C configuration channel, USB ESD
  {
    const cc: string[] = [], ccVal: string[] = [], noEsd: string[] = [];
    for (const p of live) {
      const usb = /usb/i.test(p.lib + " " + p.value); if (!usb || !/^(J|P|CN|X|USB)\d/i.test(p.ref)) continue;
      const c1 = pinNamed(p, /^CC1$/i), c2 = pinNamed(p, /^CC2$/i);
      if (c1.length && c2.length) {
        const n1 = pinNet(c1[0]), n2 = pinNet(c2[0]);
        if (n1 && n1 === n2) cc.push(`${p.ref}: CC1 and CC2 are joined (${n1}); each needs its own resistor, or a cable with a chip in it shorts them and no power arrives`);
        for (const [nm, n] of [["CC1", n1], ["CC2", n2]] as [string, string][]) {
          if (!n) { cc.push(`${p.ref}.${nm} is not connected; without its resistor a USB-C to USB-C cable supplies nothing`); continue; }
          if ((netPins.get(n) || []).some((q) => { const o = byRef.get(q.ref); return o && o !== p && isIc(o); })) continue;      // a port controller or the MCU handles it
          const rs = across(n, isR); const down = rs.filter((x) => isGround(x.far)), up = rs.filter((x) => supplyNets.has(x.far) && !isGround(x.far));
          if (!down.length && !up.length) { cc.push(`${p.ref}.${nm} (${n}) has no resistor: 5.1k to ground makes it a device that takes power, 56k, 22k or 10k to VBUS a source`); continue; }
          for (const x of down) { const v = ohms(x.part.value); if (v !== null && Math.abs(v - 5100) > 5100 * 0.06) ccVal.push(`${p.ref}.${nm}: ${x.part.ref} is ${x.part.value}; a device's pull-down is 5.1k`); }
          for (const x of up) { const v = ohms(x.part.value); if (v !== null && ![56000, 22000, 10000].some((t) => Math.abs(v - t) <= t * 0.06)) ccVal.push(`${p.ref}.${nm}: ${x.part.ref} is ${x.part.value}; a source's pull-up is 56k (default current), 22k (1.5 A) or 10k (3 A) to 5 V`); }
        }
      }
      const data = pinNamed(p, /^(D[+-]|DP\d*|DM\d*|DN\d*|D[PN]_?\w?|USB_?D[PMN+-])$/i).map(pinNet).filter(Boolean); const dn = Array.from(new Set(data));
      if (dn.length && !dn.some((n) => (netPins.get(n) || []).some((q) => { const o = byRef.get(q.ref); return o && ESD.test(o.lib + " " + o.value); }))) noEsd.push(`${p.ref} ${p.value}: ${dn.join(", ")}`);
    }
    if (cc.length) add("usbc.cc", "error", "A USB-C socket tells the other end what it is through CC1 and CC2, each with its own resistor.", cc);
    if (ccVal.length) add("usbc.cc", "warning", "These CC resistors are not the values the USB-C specification gives.", ccVal);
    if (noEsd.length) add("usb.esd", "warning", "USB data lines leave the board and take the discharge when a cable is plugged in. Put a low-capacitance ESD part (USBLC6-2, TPD2E, PRTR5V0U2X) on them at the connector.", noEsd);
  }

  // ---- regulators: capacitors, the voltage the divider sets, the heat
  {
    const noCap: string[] = [], off: string[] = [], noRef: string[] = [], hot: string[] = [], warm: string[] = [];
    for (const p of live) {
      const isReg = /^Regulator_|^Converter_DCDC/i.test(p.lib) || (isIc(p) && pinNamed(p, /^(VOUT|OUT|VO)$/i).length > 0 && pinNamed(p, /^(VIN|IN|VI)$/i).length > 0 && /reg|ldo|buck|boost|dcdc|conver/i.test(p.lib + " " + p.value + " " + fieldOf(p, /^description$/i)));
      if (!isReg) continue;
      const vin = pinNamed(p, /^(VIN|IN|VI|PVIN|AVIN|VCC|VDD)\d*$/i).map(pinNet).find(Boolean) || "", vout = pinNamed(p, /^(VOUT|OUT|VO|OUTPUT)\d*$/i).map(pinNet).find(Boolean) || "";
      const fb = pinNamed(p, /^(FB|ADJ|VFB|FB\/NC|VSENSE|SENSE|VOS)\d*$/i).map(pinNet).find(Boolean) || "";
      const sw = pinNamed(p, /^(SW|LX|PH|SWITCH)\d*$/i).map(pinNet).find(Boolean) || ""; const linear = !sw && (/^Regulator_Linear/i.test(p.lib) || !/Switching|DCDC/i.test(p.lib));
      for (const [what, n] of [["input", vin], ["output", vout]] as [string, string][]) if (n && !isGround(n) && !capsToGround(n).length) noCap.push(`${p.ref} ${p.value}: no capacitor on its ${what} (${n})`);
      // the feedback divider
      let setV: number | null = null, outNet = vout;
      if (fb && fb !== vout && !isGround(fb)) {
        const rs = across(fb, isR); const bottom = rs.filter((x) => isGround(x.far)), top = rs.filter((x) => !isGround(x.far) && x.far !== fb);
        if (bottom.length === 1 && top.length === 1) {
          const rt = ohms(top[0].part.value), rb = ohms(bottom[0].part.value); outNet = outNet || top[0].far;
          const stated = fieldOf(p, /^(Vref|V_?FB|Reference)$/i); let vref: number | null = stated ? parseFloat(stated) : null;
          if (vref === null || !isFinite(vref)) { const hit = VREF.find(([re]) => re.test(p.value + " " + p.lib)); vref = hit ? hit[1] : null; }
          if (rt !== null && rb !== null && rb > 0 && rt > 0) {
            if (vref === null) noRef.push(`${p.ref} ${p.value}: ${top[0].part.ref} ${top[0].part.value} over ${bottom[0].part.ref} ${bottom[0].part.value} gives Vref x ${r2(1 + rt / rb)}`);
            else {
              // an LM317 style part holds Vref between OUT and ADJ, so its divider reads the other way up
              const adj = /^ADJ$/i.test((pinNamed(p, /^(FB|ADJ|VFB)$/i)[0] || { name: "" }).name) && /LM317|LM1117|AMS1117|LD1117|NCP1117|LM108[56]|LT1086|LM350|LM338|TLV1117/i.test(p.value + " " + p.lib);
              setV = adj ? vref * (1 + rb / rt) : vref * (1 + rt / rb);
              const want = railV(top[0].far) ?? (vout ? railV(vout) : null);
              if (want !== null && want > 0 && Math.abs(setV - want) > Math.max(0.04 * want, 0.05)) off.push(`${p.ref} ${p.value}: ${top[0].part.ref} ${top[0].part.value} and ${bottom[0].part.ref} ${bottom[0].part.value} with Vref ${vref} V set ${r2(setV)} V, but the output net is ${top[0].far} (${want} V)`);
            }
          }
        }
      }
      // heat in a linear regulator: P = (Vin - Vout) x I
      if (linear && vin && (vout || setV !== null)) {
        const vi = railV(vin), vo = setV !== null ? setV : railV(vout || outNet); if (vi === null || vo === null || vi - vo < 0.3) continue;
        const pk = PACKAGE_W.find(([re]) => re.test(footprintOf(p) + " " + p.value)); if (!pk) continue;
        const drop = vi - vo, imax = pk[1] / drop; const line = `${p.ref} ${p.value}: ${vi} V in, ${r2(vo)} V out drops ${r2(drop)} V; a ${pk[2]} loses about ${pk[1]} W, so about ${Math.round(imax * 1000)} mA`;
        if (imax < 0.1) hot.push(line); else if (drop >= 1.5) warm.push(line);
      }
    }
    if (noCap.length) add("regulator.caps", "error", "A regulator needs a capacitor on its input and on its output, of the value and type its datasheet names; without the output capacitor most oscillate.", noCap);
    if (off.length) add("regulator.setpoint", "error", "The feedback divider does not set the voltage the output net is named for. For most parts Vout = Vref x (1 + Rtop / Rbottom); change a resistor or the net name.", off);
    if (noRef.length) add("regulator.setpoint", "note", "The reference voltage of these regulators is not known here, so the divider cannot be checked. Add a Vref field from the datasheet (sch.set(ref, Vref=\"0.8\")).", noRef);
    if (hot.length) add("regulator.heat", "warning", "These linear regulators burn off their whole voltage drop as heat, P = (Vin - Vout) x I, and their package allows very little current. Use a switching regulator, a lower input, or a larger package with copper under it.", hot);
    if (warm.length) add("regulator.heat", "note", "Linear regulators with a large drop: keep the load below the figure given, or give the tab copper and vias.", warm);
  }

  // ---- LEDs
  {
    const bare: string[] = [], bright: string[] = [];
    for (const p of live) {
      if (!(/^(D|LED)\d/i.test(p.ref) && /led/i.test(p.lib + " " + p.value)) || p.pins.length !== 2 || /WS28|SK68|APA10|neopixel|RGB/i.test(p.lib + " " + p.value)) continue;
      const ends = p.pins.map(pinNet); if (!ends[0] || !ends[1]) continue;
      // the resistor may be on either side
      let res: { part: Part; far: string } | null = null, rail = "", drive = "";
      for (let i = 0; i < 2; i++) { const r = across(ends[i], isR).filter((x) => x.part.ref !== p.ref); if (r.length && (netPins.get(ends[i]) || []).length <= 3) { res = r[0]; rail = r[0].far; drive = ends[1 - i]; } }
      if (!res) {
        const driver = ends.some((n) => (netPins.get(n) || []).some((q) => { const o = byRef.get(q.ref); return o && isIc(o) && /led|driver|sink|cc|pwm|charg|stat|pmic/i.test(o.lib + " " + o.value + " " + q.name); }));
        if (!driver && ends.some((n) => supplyNets.has(n))) bare.push(`${p.ref} ${p.value} between ${ends.join(" and ")}`);
        continue;
      }
      const r = ohms(res.part.value); if (r === null || r <= 0) continue;
      const va = railV(rail), vb = railV(drive); const icDrive = (netPins.get(drive) || []).some((q) => { const o = byRef.get(q.ref); return o && isIc(o); }) || (netPins.get(rail) || []).some((q) => { const o = byRef.get(q.ref); return o && isIc(o) && !supplyNets.has(rail); });
      const v = va !== null && vb !== null ? Math.abs(va - vb) : va !== null && va > 0 ? va : vb !== null && vb > 0 ? vb : null; if (v === null) continue;
      const vf = /blue|white|uv|pink|B\b/i.test(p.value) ? 3.0 : /green/i.test(p.value) ? 2.2 : 2.0; const ma = Math.max(0, (v - vf) / r * 1000);
      if (ma > 20.5) bright.push(`${p.ref} with ${res.part.ref} ${res.part.value} on ${v} V: about ${Math.round(ma)} mA; an indicator LED is rated 20 mA and is bright at 1 to 5 mA (${fmtR((v - vf) / 0.005)} gives 5 mA)`);
      else if (icDrive && ma > 8.5) bright.push(`${p.ref} with ${res.part.ref} ${res.part.value} on ${v} V: about ${Math.round(ma)} mA through an IC pin; many microcontroller pins give 4 to 8 mA (${fmtR((v - vf) / 0.004)} gives 4 mA)`);
    }
    if (bare.length) add("led.current", "error", "These LEDs sit straight across a supply with no resistor to limit the current. Add a series resistor, R = (V - Vf) / I.", bare);
    if (bright.length) add("led.current", "warning", "These LED currents are higher than the LED or the pin driving it should carry.", bright);
  }

  // ---- net names a slip apart, named nets that go nowhere
  {
    const named = nets.filter((n) => n.named && n.name); const twins: string[] = [], lone: string[] = [];
    const norm = (s: string) => s.replace(/^\//, "").replace(/[_\-.\s]/g, "").toUpperCase(); const groups = new Map<string, string[]>();
    for (const n of named) { const k = norm(n.name); const g = groups.get(k) || []; groups.set(k, g); if (!g.includes(n.name)) g.push(n.name); }
    for (const g of groups.values()) if (g.length > 1) twins.push(`${g.join(" and ")} differ only in case or separators`);
    // one letter dropped, added or swapped with its neighbour, in names long enough for that to be a slip
    const keys = Array.from(groups.keys()).filter((k) => k.length >= 5 && !supplyNets.has(groups.get(k)![0])); const slip = (a: string, b: string) => {
      if (a.length === b.length) { const d: number[] = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i); return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]] && !/\d/.test(a[d[0]] + a[d[1]]); }
      const [s, l] = a.length < b.length ? [a, b] : [b, a]; if (l.length - s.length !== 1) return false;
      for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return /[A-Z]/.test(l[i]) && !/^[PNMHLRXS]$/.test(l[i]) || (/[A-Z]/.test(l[i]) && i > 0 && i < l.length - 1 && l[i] === l[i - 1]);
      return false;
    };
    for (let i = 0; i < keys.length && twins.length < 12; i++) for (let j = i + 1; j < keys.length; j++) if (slip(keys[i], keys[j])) twins.push(`${groups.get(keys[i])![0]} and ${groups.get(keys[j])![0]} are one letter apart`);
    for (const n of named) { if (supplyNets.has(n.name) || n.pins.length !== 1) continue; const q = n.pins[0]; if (q.type === "no_connect") continue; const o = byRef.get(q.ref); if (o && /^(TP|J|P|CN|X)\d/i.test(o.ref)) continue; lone.push(`${n.name}: only ${q.ref}.${q.name || q.number}`); }
    if (twins.length) add("nets.typos", "warning", "These net names look like the same net spelled two ways, which leaves the two halves unconnected. Make them one name, or rename one so the difference is plain.", twins);
    if (lone.length) add("nets.typos", "warning", "These named nets reach a single pin, so the label connects it to nothing: a misspelled label, or the other end was never drawn.", lone.slice(0, 20));
  }

  // ---- one passive size
  {
    const sizes = new Map<string, string[]>();
    for (const p of live) { if (!/^[RC]\d/i.test(p.ref) || p.pins.length !== 2) continue; const f = farads(p.value); if (/^C/i.test(p.ref) && f !== null && f > 2.2e-6) continue; const m = /(?:^|[_:])(01005|0201|0402|0603|0805|1206|1210)(?:_|$)/.exec(footprintOf(p)); if (!m) continue; const l = sizes.get(m[1]) || []; sizes.set(m[1], l); l.push(p.ref); }
    if (sizes.size > 1) { const total = Array.from(sizes.values()).reduce((a, l) => a + l.length, 0); const rows = Array.from(sizes.entries()).sort((a, b) => b[1].length - a[1].length); const minor = rows.slice(1).filter(([, l]) => l.length <= Math.max(3, total * 0.15));
      if (minor.length) add("passives.sizes", "note", `Most small resistors and capacitors here are ${rows[0][0]}. One size keeps assembly cheap and the board easy to rework; move these to ${rows[0][0]} unless their voltage, power or value needs the other size.`, minor.map(([s, l]) => `${s}: ${l.slice(0, 6).join(", ")}${l.length > 6 ? ` and ${l.length - 6} more` : ""}`)); }
  }
}
