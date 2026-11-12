// pcb-edit3.test.js — pcbnew editing actions (sweep 3): PCB_TEXTBOX::Rotate slides the axis-aligned box (the angle
// lives in the text), PCB_TEXTBOX::SetTextAngle rotates about the box's start; copper thieving zone fills.
// Run: node server/static/tests/pcb-edit3.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 5).join("\n       ")); } }
const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
const box = (extra = []) => ["gr_text_box", "hi", ["start", 10, 20], ["end", 16, 22], ...extra, ["layer", "F.SilkS"], ["uuid", "tb"]];

test("Rotate 90 about the box centre keeps the box, the angle becomes 90", () => {
  const n = box(); P.rotateNode(n, 13, 21, 90);
  assert.deepEqual(kid(n, "start").slice(1), [10, 20]); assert.deepEqual(kid(n, "end").slice(1), [16, 22]);
  assert.deepEqual(kid(n, "angle"), ["angle", 90]);
  assert.ok(n.indexOf(kid(n, "angle")) < n.indexOf(kid(n, "layer")), "(angle) is written before (layer)");
});
test("Rotate 90 about another point slides the box without swapping width and height", () => {
  const n = box(); P.rotateNode(n, 0, 0, 90);
  // centre (13, 21) turns counter-clockwise on screen (y down) to (21, -13): delta (8, -34)
  assert.deepEqual(kid(n, "start").slice(1), [18, -14]); assert.deepEqual(kid(n, "end").slice(1), [24, -12]);
  assert.equal(kid(n, "angle")[1], 90);
});
test("Rotate off-axis keeps the corner pair axis-aligned and normalises the angle", () => {
  const n = box([["angle", 350]]); P.rotateNode(n, 13, 21, 30);
  assert.deepEqual(kid(n, "start").slice(1), [10, 20]); assert.deepEqual(kid(n, "end").slice(1), [16, 22]);
  assert.equal(kid(n, "angle")[1], 20);
});
test("Rotate back to 0 drops (angle)", () => {
  const n = box([["angle", 270]]); P.rotateNode(n, 13, 21, 90); assert.equal(kid(n, "angle"), undefined);
});
test("SetTextAngle slides the box about its start (PCB_SHAPE::GetPosition)", () => {
  const n = box(); P.setTextBoxAngleSliding(n, 90);
  // centre (13, 21) about start (10, 20) by 90: offset (3, 1) -> (1, -3): centre (11, 17), delta (-2, -4)
  assert.deepEqual(kid(n, "start").slice(1), [8, 16]); assert.deepEqual(kid(n, "end").slice(1), [14, 18]);
  assert.equal(kid(n, "angle")[1], 90);
});
test("Mirror reflects the box centre only", () => {
  const n = box(); P.mirrorNode(n, 0, 0, "h");
  assert.deepEqual(kid(n, "start").slice(1), [-16, 20]); assert.deepEqual(kid(n, "end").slice(1), [-10, 22]);
});

// ---- copper thieving zones (ZONE_CREATE_HELPER m_thieving, ZONE::SetFillMode, THIEVING_SETTINGS)
const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (net 1 "GND"))`;
test("Draw Copper Thieving Zone's template: net 0, no pad connections, (mode thieving) and the default settings in token order", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb");
  const z = P.thievingZoneNode(doc, [[0, 0], [10, 0], [10, 10]], "F.Cu");
  assert.equal(kid(z, "net"), undefined);
  const cp = kid(z, "connect_pads"); assert.equal(cp[1], "no");
  const f = kid(z, "fill"); assert.deepEqual(f[1], ["mode", "thieving"]);
  assert.deepEqual(f[f.length - 1], ["thieving", ["type", "dots"], ["size", 0.5], ["gap", 1], ["width", 0.3], ["stagger", "no"], ["orientation", 0]]);
  assert.equal(P.zoneFillMode(z), "thieving");
});
test("Fill Mode edits: thieving clamps to one layer and drops the net; hatch writes its keys; solid clears both", () => {
  const z = ["zone", ["net", 1], ["net_name", "GND"], ["layers", "F.Cu", "B.Cu"], ["uuid", "u"], ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25], ["fill", "yes", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5], ["island_removal_mode", 0]], ["polygon", ["pts"]]];
  P.setZoneFillMode(z, "thieving");
  assert.deepEqual(kid(z, "layer"), ["layer", "F.Cu"]); assert.equal(kid(z, "layers"), undefined); assert.equal(kid(z, "net"), undefined);
  assert.deepEqual(kid(z, "fill").slice(0, 3), ["fill", "yes", ["mode", "thieving"]]);
  P.setThieving(z, { type: "hatch", width: 0.4, stagger: true });
  assert.deepEqual(kid(kid(z, "fill"), "thieving"), ["thieving", ["type", "hatch"], ["size", 0.5], ["gap", 1], ["width", 0.4], ["stagger", "yes"], ["orientation", 0]]);
  P.setZoneFillMode(z, "hatch");
  const f = kid(z, "fill"); assert.equal(kid(f, "thieving"), undefined); assert.deepEqual(kid(f, "mode"), ["mode", "hatch"]); assert.deepEqual(kid(f, "hatch_thickness"), ["hatch_thickness", 1]); assert.deepEqual(kid(f, "hatch_gap"), ["hatch_gap", 1.5]);
  P.setZoneFillMode(z, "solid");
  assert.equal(kid(kid(z, "fill"), "mode"), undefined); assert.equal(kid(kid(z, "fill"), "hatch_gap"), undefined);
});
test("ZONE::Mirror reflects the thieving orientation over the axis", () => {
  const z = ["zone", ["layer", "F.Cu"], ["fill", ["mode", "thieving"], ["thieving", ["type", "dots"], ["size", 0.5], ["gap", 1], ["width", 0.3], ["stagger", "no"], ["orientation", 30]]], ["polygon", ["pts", ["xy", 0, 0], ["xy", 1, 0], ["xy", 1, 1]]]];
  P.mirrorNode(z, 0, 0, "h"); assert.equal(kid(kid(kid(z, "fill"), "thieving"), "orientation")[1], 150);
  P.mirrorNode(z, 0, 0, "v"); assert.equal(kid(kid(kid(z, "fill"), "thieving"), "orientation")[1], 210);
});

module.exports = { test, K, P, assert, kid };
process.on("exit", () => { console.log(`\npcb-edit3: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
