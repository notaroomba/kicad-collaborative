// snap-anchors.test.js — object snapping on the active layer (PCB_GRID_HELPER::computeAnchors' itemIsSnappable,
// per view item): a footprint's origin follows its layer, each footprint graphic its own layer.
// Run: node server/static/tests/snap-anchors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;

const B = `(kicad_pcb (version 20250907) (generator "pcbnew")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user) (25 "Edge.Cuts" user))
 (footprint "Lib:SMD" (layer "F.Cu") (uuid "fpF") (at 30 10 90)
  (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r2") (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "p2"))))`;
const has = (pts, p) => pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6);
test("footprint graphics snap on their own layer, the origin on the footprint's", () => {
  const d = K.parseDoc(B, "kicad_pcb"), fp = d.items.get("fpF");
  const silk = P.snapAnchors(fp, "F.SilkS", 0);
  // (at 30 10 90): local (-1,-1) -> board (29, 11), local (1,-1) -> (29, 9)
  assert.ok(has(silk, [29, 11]) && has(silk, [29, 9]), JSON.stringify(silk));
  assert.ok(!has(silk, [30, 10]), "the footprint's origin is on F.Cu");
  const cu = P.snapAnchors(fp, "F.Cu", 0);
  assert.ok(has(cu, [30, 10]));
  assert.ok(!has(cu, [29, 11]), "the silkscreen line does not attract on F.Cu");
  const all = P.snapAnchors(fp, "", 0);
  assert.ok(has(all, [30, 10]) && has(all, [29, 11]));
});
