// pcb-drc-sweep4.test.js — PCBEXPR receivers (CreateVarRef: A.Parent.<field>, L.Layer, null, AB.<function>),
// DRC_TEST_PROVIDER_HOLE_SIZE on a slot's major / minor axis, DRC_TEST_PROVIDER_ANNULAR_WIDTH on plated pads,
// isolated copper by connectivity cluster (CN_CLUSTER::IsOrphaned), DRC_TEST_PROVIDER_TRACK_ANGLE at T-junctions.
// Run: node server/static/tests/pcb-drc-sweep4.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("DRC: rule receivers, slot holes, pad annulus, isolated islands, track angles");

const board = (body) => K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "SIG")
  (gr_rect (start 0 0) (end 60 60) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e1"))
  ${body}
)`, "kicad_pcb");
const FP = `(footprint "X:Y" (layer "F.Cu") (uuid "fp1") (at 20 20)
    (property "Reference" "J1" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole oval (at 0 0) (size 3 2) (drill oval 2.5 1.0) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "p1"))
    (pad "2" thru_hole circle (at 5 0) (size 1.0 1.0) (drill 0.9) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "p2"))
    (pad "3" thru_hole circle (at 10 0) (size 2 2) (drill 0.8 (offset 0.5 0)) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "p3")))`;
const plain = P.designSettings({});

test("CreateVarRef receivers compile: A.Parent.<field>, L.Layer, null, AB.<function>; others are refused", () => {
  for (const c of ["A.Parent.Reference == 'R1'", "L.Layer == 'F.Cu'", "A.Layer == null", "AB.isCoupledDiffPair()", "A.inDiffPair('*') && !AB.isCoupledDiffPair()", "A.Parent.Parent.Type == 'x'", "B.Parent.memberOfGroup('g')"])
    assert.deepEqual(P.parseDru(`(version 1) (rule "r" (condition "${c}") (constraint clearance (min 1mm)))`).errors, [], c);
  for (const c of ["AB.Type == 'Pad'", "L.Net == 'x'", "AB.Parent.Type == 'x'", "L.Parent.Layer == 'x'", "A.Child.Type == 'x'", "Q.Type == 'x'"])
    assert.match(P.parseDru(`(version 1) (rule "r" (condition "${c}") (constraint clearance (min 1mm)))`).errors[0] || "", /Unrecognized item/, c);
});
test("A.Parent.Reference reaches the pad's footprint; L.Layer is the layer under test; null equals an unset optional", () => {
  const doc = board(FP + `
  (segment (start 30 40) (end 40 40) (width 0.25) (layer "F.Cu") (net 2) (uuid "tf"))
  (segment (start 30 45) (end 40 45) (width 0.25) (layer "B.Cu") (net 2) (uuid "tb"))`);
  const holes = (cond) => P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "h" (condition "${cond}") (constraint hole_size (max 0.1mm)))` }).filter((m) => m.code === "drill_out_of_range");
  assert.equal(holes("A.Parent.Reference == 'J1'").length, 3);
  assert.equal(holes("A.Parent.Reference == 'J2'").length, 0);
  assert.equal(holes("A.Clearance_Override == null").length, 3, "a pad with no clearance override has a null one");
  assert.equal(holes("A.Pad_Number == null").length, 0, "a set property is not null");
  const widths = P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "w" (condition "L.Layer == 'F.Cu'") (constraint track_width (min 1mm)))` }).filter((m) => m.code === "track_width");
  assert.deepEqual(widths.map((m) => m.ids[0]), ["tf"]);
});
test("hole_size: max against the slot's major axis, min against its minor axis (checkPadHole)", () => {
  const doc = board(FP);
  const m = P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "maxhole" (condition "A.Pad_Number == '1'") (constraint hole_size (max 2mm)))` }).filter((x) => x.code === "drill_out_of_range");
  assert.deepEqual(m.map((x) => x.text), ["Hole size out of range (rule 'maxhole' max hole 2.0000 mm; actual 2.5000 mm)"]);
  const n = P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "minhole" (condition "A.Pad_Number == '1'") (constraint hole_size (min 1.2mm)))` }).filter((x) => x.code === "drill_out_of_range");
  assert.deepEqual(n.map((x) => x.text), ["Hole size out of range (rule 'minhole' min hole 1.2000 mm; actual 1.0000 mm)"]);
});
test("annular_width covers plated pads: the board setup minimum and custom rules, offset holes measured to the outline", () => {
  const doc = board(FP);
  const s = P.designSettings({ board: { design_settings: { rules: { min_via_annular_width: 0.1 } } } });
  const m = P.drc(doc, s, { unconnected: false }).filter((x) => x.code === "annular_width");
  assert.deepEqual(m.map((x) => x.text), ["Annular width (board setup constraints min annular width 0.1000 mm; actual 0.0500 mm)"]);
  const r = P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "ring" (condition "A.Type == 'Pad'") (constraint annular_width (min 0.2mm)))` }).filter((x) => x.code === "annular_width");
  assert.deepEqual(r.map((x) => x.text).sort(), ["Annular width (rule 'ring' min annular width 0.2000 mm; actual 0.0500 mm)", "Annular width (rule 'ring' min annular width 0.2000 mm; actual 0.1000 mm)"].sort(),
    "pad 2 (0.05) and pad 3, whose 0.8 hole sits 0.5 off a 2 mm disc's centre (1 - 0.5 - 0.4 = 0.1)");
});
test("isolated copper: an island reached only by a track (no pad in its cluster) is isolated; through a track to a pad it is not", () => {
  const zone = (extra) => board(`(footprint "X:Y" (layer "F.Cu") (uuid "fp1") (at 10 10)
    (property "Reference" "J1" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "GND") (uuid "p1")))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads yes (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 5 5) (xy 55 5) (xy 55 55) (xy 5 55)))
    (filled_polygon (layer "F.Cu") (pts (xy 5 5) (xy 15 5) (xy 15 15) (xy 5 15)))
    (filled_polygon (layer "F.Cu") (pts (xy 40 40) (xy 50 40) (xy 50 50) (xy 40 50))))
  ${extra}`);
  assert.equal(P.isolatedCopperMarkers(zone(`(segment (start 45 45) (end 52 52) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`)).length, 1);
  assert.equal(P.isolatedCopperMarkers(zone(`(segment (start 45 45) (end 10 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`)).length, 0);
  assert.equal(P.isolatedCopperMarkers(zone(`(segment (start 45 45) (end 30 30) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 30 30) (end 10 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))`)).length, 0, "the cluster, not just what touches the island");
});
test("track_angle: a T-junction is measured where the centre lines meet, angles over 90° fold back by 90°", () => {
  const doc = board(`(segment (start 10 30) (end 30 30) (width 0.25) (layer "F.Cu") (net 2) (uuid "a"))
  (segment (start 20 30) (end 25 25) (width 0.25) (layer "F.Cu") (net 2) (uuid "b"))`);
  const m = P.drc(doc, plain, { unconnected: false, rules: `(version 1) (rule "ang" (condition "A.Type == 'Track'") (constraint track_angle (min 60deg)))` }).filter((x) => x.code === "track_angle");
  assert.deepEqual(m.map((x) => [x.ids.join(","), x.x, x.y, x.text]).sort(), [
    ["a,b", 20, 30, "Track angle (rule 'ang' min angle 60.0°; actual 45.0°)"], ["b,a", 20, 30, "Track angle (rule 'ang' min angle 60.0°; actual 45.0°)"]]);
});

console.log(`pcb-drc-sweep4: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
