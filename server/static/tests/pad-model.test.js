// pad-model.test.js — Pad Properties' pure half (web/canvas/pad-model.ts) under node: reading a pad into the
// dialog's model, writing back only what changed in PCB_IO_KICAD_SEXPR::format( PAD )'s order, the layer
// wildcards, flipped footprints and CheckPad's messages.
// Run: node server/static/tests/pad-model.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas, M = K.padModel;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("pad model under node");

const doc = (fps) => ({ copper: ["F.Cu", "B.Cu"], items: new Map(fps.map((n, i) => [String(i), { kind: "footprint", node: n }])) });
const FP_THT = `(footprint "R" (layer "F.Cu") (at 10 20 90) (property "Reference" "R1")
  (pad "1" thru_hole circle (at 1 0 90) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net "/VPP") (pintype "passive") (uuid "a")))`;
const FP_SMD_BACK = `(footprint "C" (layer "B.Cu") (at 0 0) (property "Reference" "C1")
  (pad "2" smd roundrect (at 0.95 0) (size 1 0.9) (layers "B.Cu" "B.Mask" "B.Paste") (roundrect_rratio 0.25) (net "GND") (uuid "b")))`;
const clone = (o) => structuredClone(o);
const pad0 = (fp) => K.kids(fp, "pad")[0];

test("a circular PTH pad reads as KiCad's dialog shows it", () => {
  const fp = K.parse(FP_THT), m = M.readPad(doc([fp]), fp, pad0(fp), "/VPP");
  assert.equal(m.type, "pth"); assert.equal(m.shape, "circle"); assert.equal(m.copper, 0);
  assert.deepEqual([m.x, m.y], [10, 19]);                 // (1,0) rotated 90° about the footprint
  assert.equal(m.angle, 0); assert.equal(m.hx, 0.8); assert.ok(m.tech["F.Mask"] && m.tech["B.Mask"] && !m.tech["F.Paste"]);
  assert.ok(isNaN(m.clearance) && isNaN(m.mask)); assert.equal(m.spokeAngle, 45);
});
test("an unchanged model writes nothing", () => {
  const fp = K.parse(FP_THT), before = K.serialize(fp), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "/VPP");
  M.writePad(d, fp, pad0(fp), clone(was), was, () => 0); assert.equal(K.serialize(fp), before);
});
test("shape, size, margins and zone connection land in the writer's order", () => {
  const fp = K.parse(FP_THT), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "/VPP"); const m = clone(was);
  Object.assign(m, { shape: "roundrect", w: 2, rratio: 0.3, spokeAngle: 90, zoneConnect: 2, gap: 0.3, mask: 0.05, paste: -0.1, pasteRatio: -0.05 });
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  assert.equal(K.serialize(pad0(fp)), '(pad "1" thru_hole roundrect (at 1 0 90) (size 2 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (roundrect_rratio 0.3) (net "/VPP") (pintype "passive") (solder_mask_margin 0.05) (solder_paste_margin -0.1) (solder_paste_margin_ratio -0.05) (zone_connect 2) (thermal_gap 0.3) (uuid "a"))');
});
test("position and angle go back to footprint coordinates", () => {
  const fp = K.parse(FP_THT), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "/VPP"); const m = clone(was);
  m.x = 10; m.y = 18; m.angle = 90;                          // two along the footprint's axis, turned with it
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  assert.equal(K.serialize(K.kid(pad0(fp), "at")), "(at 2 0 180)");
});
test("PTH copper choices: connected layers only", () => {
  const fp = K.parse(FP_THT), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "/VPP"); const m = clone(was); m.copper = 2;
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  assert.match(K.serialize(pad0(fp)), /\(layers "\*\.Cu" "\*\.Mask"\) \(remove_unused_layers yes\) \(keep_end_layers no\) \(zone_layer_connections\) \(net/);
  assert.equal(M.readPad(d, fp, pad0(fp), "/VPP").copper, 2);
});
test("a flipped footprint shows front layers and writes back layers", () => {
  const fp = K.parse(FP_SMD_BACK), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "GND");
  assert.equal(was.type, "smd"); assert.equal(was.copper, 0); assert.ok(was.tech["F.Mask"] && was.tech["F.Paste"] && !was.tech["B.Mask"]);
  const m = clone(was); m.tech["F.Paste"] = false; m.tech["F.SilkS"] = true;
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  assert.equal(K.serialize(K.kid(pad0(fp), "layers")), '(layers "B.Cu" "B.Mask" "B.SilkS")');
});
test("chamfered corners and NPTH conversion", () => {
  const fp = K.parse(FP_SMD_BACK), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "GND"); const m = clone(was);
  Object.assign(m, { shape: "chamfer", cratio: 0.2, corners: [true, false, false, true] });
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  assert.match(K.serialize(pad0(fp)), /\(roundrect_rratio 0\) \(chamfer_ratio 0\.2\) \(chamfer top_left bottom_right\) \(net "GND"\)/);
  assert.equal(M.readPad(d, fp, pad0(fp), "GND").shape, "chamfer");
  const fp2 = K.parse(FP_THT), d2 = doc([fp2]); const w2 = M.readPad(d2, fp2, pad0(fp2), "/VPP"); const m2 = clone(w2); m2.type = "npth"; m2.copper = 3; m2.tech["F.Mask"] = m2.tech["B.Mask"] = true;
  M.writePad(d2, fp2, pad0(fp2), m2, w2, () => 0);
  assert.equal(K.serialize(pad0(fp2)), '(pad "" np_thru_hole circle (at 1 0 90) (size 1.6 1.6) (drill 0.8) (layers "*.Mask") (pintype "passive") (uuid "a"))');
});
test("numbered nets keep their code", () => {
  const fp = K.parse(`(footprint "R" (layer "F.Cu") (at 0 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net 3 "VCC")))`), d = doc([fp]);
  const was = M.readPad(d, fp, pad0(fp), "VCC"); const m = clone(was); m.net = "GND";
  M.writePad(d, fp, pad0(fp), m, was, (n) => (n === "GND" ? 7 : 0));
  assert.equal(K.serialize(K.kid(pad0(fp), "net")), '(net 7 "GND")');
});
test("layer wildcards follow formatLayers", () => {
  assert.deepEqual(M.formatPadLayers(new Set(["F.Cu", "F.Paste", "F.Mask"]), ["F.Cu", "B.Cu"]), ["F.Cu", "F.Mask", "F.Paste"]);
  assert.deepEqual(M.formatPadLayers(new Set(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "F.Mask", "B.Mask"]), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]), ["*.Cu", "*.Mask"]);
  assert.deepEqual(Array.from(M.expandLayers(["*.Cu", "*.Mask"], ["F.Cu", "B.Cu"])).sort(), ["B.Cu", "B.Mask", "F.Cu", "F.Mask"]);
});
test("CheckPad: errors stop, warnings tell", () => {
  const fp = K.parse(FP_THT), d = doc([fp]); const m = M.readPad(d, fp, pad0(fp), "/VPP");
  assert.deepEqual(M.checkPad(m), { errors: [], warnings: [] });
  assert.deepEqual(M.checkPad(Object.assign(clone(m), { hx: 0 })).errors, ["Error: Through hole pad has no hole."]);
  assert.deepEqual(M.checkPad(Object.assign(clone(m), { hx: 2, hy: 2 })).warnings, ["Warning: (PTH pad hole leaves no copper)"]);
});
test("pad to die delay, simulation electrical type and teardrops write where the writer puts them", () => {
  const fp = K.parse(FP_THT), d = doc([fp]); const was = M.readPad(d, fp, pad0(fp), "/VPP");
  assert.equal(was.dieDelayOn, false); assert.equal(was.simType, ""); assert.deepEqual(was.td, M.TD_DEFAULTS);
  const m = clone(was); m.dieDelayOn = true; m.dieDelay = 12.5; m.simType = "source"; m.td.enabled = true;
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  const out = K.serialize(pad0(fp));
  assert.ok(/\(drill 0\.8\)\s*\(sim_electrical_type source\)\s*\(layers/.test(out), out);
  assert.ok(/\(pintype "passive"\)\s*\(die_delay 12\.5\)/.test(out), out);
  assert.ok(/\(teardrops \(best_length_ratio 0\.5\) \(max_length 1\) \(best_width_ratio 1\) \(max_width 2\) \(curved_edges no\) \(filter_ratio 0\.9\) \(enabled yes\) \(allow_two_segments yes\) \(prefer_zone_connections yes\)\)\s*\(uuid/.test(out), out);
  const back = M.readPad(d, fp, pad0(fp), "/VPP"); assert.equal(back.dieDelay, 12.5); assert.equal(back.simType, "source"); assert.equal(back.td.enabled, true);
  // back to the defaults drops (teardrops …)
  const m2 = clone(back); m2.td.enabled = false; m2.simType = ""; m2.dieDelayOn = false; M.writePad(d, fp, pad0(fp), m2, back, () => 0);
  const out2 = K.serialize(pad0(fp)); assert.ok(!/teardrops|sim_electrical_type|die_delay/.test(out2), out2);
});
test("readTeardrops follows parseTEARDROP_PARAMETERS: a present node starts with every flag off, bare keywords", () => {
  const td = (inner) => M.readTeardrops(K.parse(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") ${inner})`));
  assert.deepEqual(td(""), M.TD_DEFAULTS);
  const partial = td("(teardrops (best_length_ratio 0.4))");
  assert.equal(partial.enabled, false); assert.equal(partial.twoSegments, false); assert.equal(partial.preferZone, false); assert.equal(partial.lenRatio, 0.4); assert.equal(partial.maxLen, 1);
  const bare = td("(teardrops (enabled) (allow_two_segments) (curved_edges) (prefer_zone_connections))");
  assert.equal(bare.enabled, true); assert.equal(bare.twoSegments, true); assert.equal(bare.curved, true); assert.equal(bare.preferZone, false);
  assert.equal(td("(teardrops (prefer_zone_connections yes) (curve_points 5))").preferZone, true);
  assert.equal(td("(teardrops (curve_points 5))").curved, true);
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
