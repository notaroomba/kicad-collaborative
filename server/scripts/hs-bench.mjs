// High-speed routing benchmark: small boards with the nets that need care — HDMI lanes, Ethernet pairs, a Bluetooth
// antenna feed — on a 4-layer stackup (signal over a ground plane 0.21 mm below), routed from nothing.  Reports for
// each: completion, rule errors, which pairs ran coupled, the widths chosen for impedance, and how well lengths match.
//   node scripts/hs-bench.mjs [outDir]
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url); const here = path.dirname(fileURLToPath(import.meta.url)); const S = path.join(here, "..", "static");
require(path.join(S, "kicad-canvas.js")); require(path.join(S, "pcb-tools.js")); require(path.join(S, "dist", "autoroute.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter; const out = process.argv[2] || null;

let n = 0;
const head = (layers, x1, y1) => `(kicad_pcb (version 20260728) (generator "pcbnew") (general (thickness 1.6))
  (layers (0 "F.Cu" signal)${layers === 4 ? ' (4 "In1.Cu" power) (6 "In2.Cu" power)' : ""} (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035))${layers === 4
    ? ' (layer "dielectric 1" (type "prepreg") (thickness 0.2104) (material "FR4") (epsilon_r 4.4)) (layer "In1.Cu" (type "copper") (thickness 0.0152)) (layer "dielectric 2" (type "core") (thickness 1.065) (material "FR4") (epsilon_r 4.6)) (layer "In2.Cu" (type "copper") (thickness 0.0152)) (layer "dielectric 3" (type "prepreg") (thickness 0.2104) (material "FR4") (epsilon_r 4.4))'
    : ' (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5))'} (layer "B.Cu" (type "copper") (thickness 0.035))))
  (gr_rect (start 90 40) (end ${x1} ${y1}) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
  ${layers === 4 ? `(zone (net "GND") (layer "In1.Cu") (uuid "plane") (connect_pads (clearance 0.2)) (min_thickness 0.2) (polygon (pts (xy 90 40) (xy ${x1} 40) (xy ${x1} ${y1}) (xy 90 ${y1}))))` : ""}`;
const fp = (ref, x, y, pads) => `(footprint "HS:${ref}" (layer "F.Cu") (uuid "fp-${++n}") (at ${x} ${y}) (property "Reference" "${ref}" (at 0 -2) (layer "F.SilkS") (uuid "r-${n}"))
${pads.map((p) => p.tht
    ? `    (pad "${p.n}" thru_hole circle (at ${p.dx} ${p.dy}) (size ${p.w} ${p.w}) (drill ${p.h}) (layers "*.Cu" "*.Mask")${p.net ? ` (net "${p.net}")` : ""} (uuid "p-${n}-${p.n}"))`
    : `    (pad "${p.n}" smd rect (at ${p.dx} ${p.dy}) (size ${p.w} ${p.h}) (layers "F.Cu" "F.Mask")${p.net ? ` (net "${p.net}")` : ""} (uuid "p-${n}-${p.n}"))`).join("\n")})`;
const col = (nets, pitch, w, h) => nets.map((net, i) => ({ n: i + 1, dx: 0, dy: +(i * pitch).toFixed(3), w, h, net }));

const boards = {
  hdmi: () => head(4, 125, 66) + "\n" + [
    fp("J1", 93, 46, col(["HDMI_D2_P", "GND", "HDMI_D2_N", "HDMI_D1_P", "GND", "HDMI_D1_N", "HDMI_D0_P", "GND", "HDMI_D0_N", "HDMI_CK_P", "GND", "HDMI_CK_N", "CEC", "", "DDC_SCL", "DDC_SDA", "GND", "+5V", "HPD"], 0.5, 1.9, 0.28)),
    fp("U1", 118, 52, col(["HDMI_D2_P", "HDMI_D2_N", "HDMI_D1_P", "HDMI_D1_N", "HDMI_D0_P", "HDMI_D0_N", "HDMI_CK_P", "HDMI_CK_N", "GND", "CEC", "DDC_SCL", "DDC_SDA", "HPD", "+5V"], 0.5, 0.8, 0.25)),
  ].join("\n") + "\n)",
  ethernet: () => head(4, 125, 66) + "\n" + [
    fp("U1", 96, 50, col(["ETH_TX_P", "ETH_TX_N", "GND", "ETH_RX_P", "ETH_RX_N", "+3V3"], 0.5, 0.8, 0.25)),
    fp("J1", 118, 46, [["ETH_TX_P", 0], ["ETH_TX_N", 2.54], ["ETH_RX_P", 7.62], ["ETH_RX_N", 10.16], ["GND", 13.5], ["+3V3", 16]].map(([net, dy], i) => ({ n: i + 1, dx: 0, dy, w: 1.5, h: 0.9, net, tht: true }))),
  ].join("\n") + "\n)",
  bluetooth: (layers = 4) => head(layers, 118, 62) + "\n" + [
    fp("U1", 96, 50, [{ n: 1, dx: 0, dy: 0, w: 1.0, h: 0.6, net: "RF_OUT" }, { n: 2, dx: 0, dy: 1.27, w: 1.0, h: 0.6, net: "GND" }, { n: 3, dx: 0, dy: -1.27, w: 1.0, h: 0.6, net: "GND" }]),
    fp("C1", 102, 50, [{ n: 1, dx: -0.48, dy: 0, w: 0.56, h: 0.62, net: "RF_OUT" }, { n: 2, dx: 0.48, dy: 0, w: 0.56, h: 0.62, net: "ANT" }]),
    fp("L1", 104.5, 51.6, [{ n: 1, dx: 0, dy: -0.48, w: 0.62, h: 0.56, net: "ANT" }, { n: 2, dx: 0, dy: 0.48, w: 0.62, h: 0.56, net: "GND" }]),
    fp("AE1", 112, 47, [{ n: 1, dx: 0, dy: 0, w: 0.8, h: 1.0, net: "ANT" }]),
    // ground poured on the outer layers too, as on a real radio board: the fence vias tie it to the plane
    ...["F.Cu", "B.Cu"].map((l) => `(zone (net "GND") (layer "${l}") (uuid "pour-${l}") (connect_pads (clearance 0.2)) (min_thickness 0.2) (polygon (pts (xy 90 40) (xy 118 40) (xy 118 62) (xy 90 62))))`),
  ].join("\n") + "\n)",
  "bluetooth-2layer": () => boards.bluetooth(2),
};

const summary = {};
for (const [name, make] of Object.entries(boards)) {
  const text = make(); const doc = K.parseDoc(text, "kicad_pcb"); const settings = P.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.15, track_width: 0.15, via_diameter: 0.5, via_drill: 0.25 }] } });
  const res = R.route(K, P, doc, settings, { passes: 3 }); for (const i of res.items) K.createItem(doc, i.node);
  const errs = P.drc(doc, settings).filter((m) => m.severity === "error" && m.code !== "unconnected_items");
  const s = summary[name] = { routed: `${res.routed}/${res.total}`, vias: res.vias, ruleErrors: errs.length, pairs: res.pairs, impedance: res.impedance, matched: res.matched, open: res.connections.filter((c) => !c.routed).map((c) => `${c.net}: ${c.reason}`) };
  console.log(`\n== ${name}: ${s.routed} routed, ${s.vias} vias, ${s.ruleErrors} rule errors${errs.length ? " (" + [...new Set(errs.map((m) => m.code))].join(", ") + ")" : ""}`);
  for (const z of res.impedance) console.log(`   impedance ${z.nets.join(" / ")}: ${z.target} Ω ${z.differential ? "differential" : "single-ended"} → ${z.applied ? `${z.width} mm${z.gap ? ` tracks, ${z.gap} mm gap` : ""} (${z.achieved} Ω by the model)` : z.note}`);
  for (const p of res.pairs) console.log(`   pair ${p.p} / ${p.n}: ${p.coupled ? `coupled on ${p.layer}, ${p.width}/${p.gap} mm, ${p.lengthP} and ${p.lengthN} mm (skew ${p.skew})` : "not coupled: " + p.reason}`);
  for (const g of res.matched) console.log(`   matched group ${g.group}: target ${g.target} mm ± ${g.tolerance}: ` + g.members.map((m) => `${m.nets[0]} ${m.before} → ${m.length}${m.matched ? "" : " (" + m.note + ")"}`).join("; "));
  for (const f of res.fences || []) console.log(`   ground vias for ${f.net}: ${f.fence} in the fence (every ${f.spacing} mm), ${f.returns} beside layer changes${f.note ? " — " + f.note : ""}`);
  if (res.domains) console.log(`   kept apart (${res.domains.quiet} mm from digital, ${res.domains.noisy} mm from noisy): ` + Object.entries(res.domains.kinds).map(([n, k]) => `${n} ${k}`).join(", ") + (res.domains.relaxed.length ? `; relaxed for ${res.domains.relaxed.join(", ")}` : ""));
  s.fences = res.fences; s.domains = res.domains;
  for (const o of s.open) console.log("   open " + o);
  if (out) { const tree = K.parse(text); for (const i of res.items) tree.push(i.node); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name + ".kicad_pcb"), K.serialize(tree)); }
}
if (out) fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(summary, null, 2));
