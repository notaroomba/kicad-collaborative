// Node tests for the board editor's sweep 9: the Net Inspector's figures (LENGTH_DELAY_CALCULATION:
// via heights from the stackup, tracks clipped in vias and pads, die lengths, unrouted airlines).
// Run: node server/static/tests/sweep9-pcb.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;

const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (at 100 50)
    (pad "1" smd rect (at -1.5 0) (size 1 2) (layers "F.Cu") (net "/VPP{slash}MCLR") (die_length 0.5) (uuid "pad-1"))
    (pad "2" smd rect (at 1.5 0) (size 1 2) (layers "F.Cu") (net "VCC") (uuid "pad-2")))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-2") (at 130 50)
    (pad "1" smd rect (at 0 0) (size 1 2) (layers "F.Cu") (net "/VPP{slash}MCLR") (uuid "pad-3")))
  (segment (start 98.5 50) (end 110 50) (width 0.25) (layer "F.Cu") (net "/VPP{slash}MCLR") (uuid "s-1"))
  (via (at 110 50) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "/VPP{slash}MCLR") (uuid "v-1"))
  (segment (start 110 50) (end 120 50) (width 0.25) (layer "B.Cu") (net "/VPP{slash}MCLR") (uuid "s-2"))
)`;

test("BuildDefaultStackupList + GetLayerDistance: 35 µm copper both ends, the rest of 1.6 mm less masks between", () => {
  const items = P.stackupItems(K.parse("(general (thickness 1.6))"), null, ["F.Cu", "B.Cu"]);
  assert.ok(Math.abs(P.layerDistance(items, "F.Cu", "B.Cu") - 1.58) < 1e-9);
  assert.equal(P.layerDistance(items, "F.Cu", "F.Cu"), 0);
  // an inner layer counts half its copper
  const four = P.stackupItems(null, null, ["F.Cu", "B.Cu", "In1.Cu", "In2.Cu"]);
  const d = (1.6 - 0.035 * 4 - 0.02) / 3;
  assert.ok(Math.abs(P.layerDistance(four, "F.Cu", "In1.Cu") - (0.035 + d + 0.0175)) < 1e-9);
  assert.deepEqual(P.copperStack(["F.Cu", "B.Cu", "In2.Cu", "In1.Cu"]), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
});

test("netLengths: tracks clipped at the via and the pad, the via's stackup height, die length, airline", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb");
  const rows = P.netLengths(doc, null, {});
  const r = rows.find((x) => x.name === "/VPP{slash}MCLR");
  assert.ok(r);
  assert.equal(r.padCount, 2); assert.equal(r.viaCount, 1);
  // s-1 starts on pad-1's position: clipped at the pad edge (0.5 mm), ends in the via (0.4 mm radius)
  assert.ok(Math.abs(r.layerLengths["F.Cu"] - (11.5 - 0.5 - 0.4)) < 1e-6, String(r.layerLengths["F.Cu"]));
  assert.ok(Math.abs(r.layerLengths["B.Cu"] - (10 - 0.4)) < 1e-6);
  assert.ok(Math.abs(r.viaLength - 1.58) < 1e-6);
  assert.equal(r.dieLength, 0.5);
  assert.ok(Math.abs(r.totalLength - (r.trackLength + r.viaLength + r.dieLength)) < 1e-9);
  assert.ok(r.unroutedLength > 0);   // the track ends short of pad-3
  // nets without pads are left out unless asked for
  assert.ok(!rows.some((x) => !x.padCount));
});
