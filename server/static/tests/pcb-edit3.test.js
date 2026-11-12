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

module.exports = { test, K, P, assert, kid };
process.on("exit", () => { console.log(`\npcb-edit3: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
