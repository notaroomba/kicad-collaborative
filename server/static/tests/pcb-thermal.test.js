// pcb-thermal.test.js — DRC_TEST_PROVIDER_ZONE_CONNECTIONS (starved_thermal): spokes counted where the zone's fill
// crosses the pad outline grown by half the thermal gap, the zone / footprint / pad connection overrides, islands
// that touch only the pad, hand-drawn spokes, and min_resolved_spokes from Board Setup and from a rule; and isolated copper fill islands.
// Run: node server/static/tests/pcb-thermal.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("zone connections: starved thermal reliefs");

// a fill to the right of the pad with spokes reaching into it: one spoke going right, optionally one going left
const right = "(xy 11 0) (xy 20 0) (xy 20 20) (xy 11 20) (xy 11 10.25) (xy 10 10.25) (xy 10 9.75) (xy 11 9.75)";
const left = "(xy 0 0) (xy 9 0) (xy 9 9.75) (xy 10 9.75) (xy 10 10.25) (xy 9 10.25) (xy 9 20) (xy 0 20)";
const board = ({ fills, connect = "", padExtra = "", fpExtra = "", extra = "" }) => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "") (net 1 "GND")
  (footprint "TP" (layer "F.Cu") (uuid "fp1") (at 10 10) ${fpExtra}
    (property "Reference" "TP1" (at 0 -2) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND") ${padExtra} (uuid "p1")))
  (via (at 15 15) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via (at 3 15) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads ${connect} (clearance 0.5)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 20 0) (xy 20 20) (xy 0 20)))
    ${fills.map((f) => `(filled_polygon (layer "F.Cu") (pts ${f}))`).join(" ")})
  ${extra})`;
function run(o, pro, rules) { const doc = K.parseDoc(board(o), "kicad_pcb"); const s = P.designSettings(pro || null); return P.starvedThermalMarkers(doc, s, rules ? P.parseDru(rules).rules : []); }

test("one spoke of the default two is starved, with KiCad's message, layer and items", () => {
  const m = run({ fills: [right] }); assert.equal(m.length, 1);
  assert.equal(m[0].code, "starved_thermal"); assert.equal(m[0].severity, "error"); assert.equal(m[0].layer, "F.Cu"); assert.deepEqual(m[0].ids, ["z1", "fp1"]);
  assert.equal(m[0].text, "Thermal relief connection to zone incomplete (layer F.Cu; board setup constraints zone fill strategy min spoke count 2; actual 1)");
  assert.deepEqual([m[0].x, m[0].y], [10, 10]);
});
test("two spokes satisfy the default", () => { assert.equal(run({ fills: [right, left] }).length, 0); });
test("Board Setup's minimum and a min_resolved_spokes rule decide the count", () => {
  assert.equal(run({ fills: [right] }, { board: { design_settings: { rules: { min_resolved_spokes: 1 } } } }).length, 0);
  const m = run({ fills: [right, left] }, null, `(version 1)\n(rule "four" (constraint min_resolved_spokes (min 4)) (condition "A.Type == 'Pad'"))`);
  assert.equal(m.length, 1); assert.match(m[0].text, /\(layer F\.Cu; rule 'four' min spoke count 4; actual 2\)$/);
});
test("a solid or no connection is not a thermal relief; the pad and footprint override the zone", () => {
  assert.equal(run({ fills: [right], connect: "yes" }).length, 0);
  assert.equal(run({ fills: [right], connect: "no" }).length, 0);
  assert.equal(run({ fills: [right], padExtra: "(zone_connect 2)" }).length, 0);
  assert.equal(run({ fills: [right], fpExtra: "(zone_connect 2)" }).length, 0);
  assert.equal(run({ fills: [right], connect: "thru_hole_only" }).length, 0);   // an SMD pad is solid under THT thermals
  assert.equal(run({ fills: [right], connect: "yes", padExtra: "(zone_connect 1)" }).length, 1);
});
test("a pad the fill does not reach is left to the connectivity check", () => {
  assert.equal(run({ fills: ["(xy 12 0) (xy 20 0) (xy 20 20) (xy 12 20)"] }).length, 0);
});
test("spokes into an island that touches only the pad do not count when another spoke reaches real copper", () => {
  // left island touches the pad only (v2 moved out); right fill holds v1
  const island = "(xy 7 9) (xy 9 9) (xy 9 9.75) (xy 10 9.75) (xy 10 10.25) (xy 9 10.25) (xy 9 11) (xy 7 11)";
  const m = run({ fills: [right, island] }); assert.equal(m.length, 1);
  assert.match(m[0].text, /\(layer F\.Cu; 1 spokes connected to isolated island\)$/);
});
test("a track from inside the pad outline to the fill is a spoke", () => {
  const trk = `(segment (start 10 10) (end 10 13) (width 0.3) (layer "F.Cu") (net 1) (uuid "t1"))`;
  const big = "(xy 11 0) (xy 20 0) (xy 20 20) (xy 9 20) (xy 9 12) (xy 11 12) (xy 11 10.25) (xy 10 10.25) (xy 10 9.75) (xy 11 9.75)";
  assert.equal(run({ fills: [big] }).length, 1);
  assert.equal(run({ fills: [big], extra: trk }).length, 0);
});
test("drc() reports it", () => {
  const doc = K.parseDoc(board({ fills: [right] }), "kicad_pcb");
  assert.equal(P.drc(doc, null, { unconnected: false }).filter((m) => m.code === "starved_thermal").length, 1);
});

test("isolated copper: a fill island no item of the net touches (thieving and netless zones are not reported)", () => {
  const island = "(xy 2 2) (xy 4 2) (xy 4 4) (xy 2 4)";
  const doc = K.parseDoc(board({ fills: [right, left, island] }), "kicad_pcb");
  const m = P.isolatedCopperMarkers(doc); assert.equal(m.length, 1);
  assert.equal(m[0].code, "isolated_copper"); assert.equal(m[0].severity, "warning"); assert.equal(m[0].text, "Isolated copper fill"); assert.deepEqual(m[0].ids, ["z1"]); assert.equal(m[0].layer, "F.Cu"); assert.deepEqual([m[0].x, m[0].y], [2, 2]);
  assert.equal(P.isolatedCopperMarkers(K.parseDoc(board({ fills: [right, left] }), "kicad_pcb")).length, 0);
  const thief = board({ fills: [right, island] }).replace("(fill yes (thermal_gap 0.5)", "(fill yes (mode thieving) (thermal_gap 0.5)");
  assert.equal(P.isolatedCopperMarkers(K.parseDoc(thief, "kicad_pcb")).length, 0);
  assert.ok(P.drc(doc, null, { unconnected: false }).some((x) => x.code === "isolated_copper"));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
