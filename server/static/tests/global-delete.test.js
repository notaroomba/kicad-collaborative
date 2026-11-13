// global-delete.test.js — DIALOG_GLOBAL_DELETION::DoGlobalDeletions (web/tools/pcb-tools/global-delete.ts): which
// items each check box, lock filter and the layer filter remove.
// Run: node server/static/tests/global-delete.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, G = globalThis.PcbTools.globalDeletion;

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND")
  (footprint "Lib:A" (layer "F.Cu") (uuid "fp-front") (at 10 10) (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15)))))
  (footprint "Lib:B" (locked yes) (layer "B.Cu") (uuid "fp-back-locked") (at 20 10) (property "Reference" "U2" (at 0 0 0) (layer "B.SilkS") (uuid "r2") (effects (font (size 1 1) (thickness 0.15)))))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "trk-f"))
  (segment (start 0 1) (end 5 1) (width 0.25) (layer "B.Cu") (locked yes) (net 1) (uuid "trk-b-locked"))
  (via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "via"))
  (gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "silk"))
  (gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "F.Cu") (uuid "copper-line"))
  (gr_rect (start 0 0) (end 30 30) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
  (gr_text "hello" (at 3 3 0) (layer "F.SilkS") (uuid "text") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "zone-f") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "teardrop") (hatch edge 0.5) (attr (teardrop (type padvia))) (connect_pads (clearance 0)) (min_thickness 0.0254) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const del = (o, layer = "F.Cu") => G.globalDeletionIds(doc(), Object.assign({}, G.GLOBAL_DELETION_DEFAULTS, o), layer).sort();

test("nothing checked deletes nothing; Clear board deletes everything", () => {
  assert.deepEqual(del({}), []);
  const d = doc(); const all = G.globalDeletionIds(d, { all: true }, "F.Cu");
  for (const id of ["fp-front", "fp-back-locked", "trk-f", "trk-b-locked", "via", "silk", "copper-line", "edge", "text", "zone-f", "teardrop"]) assert.ok(all.includes(id), id);
});
test("zones and teardrops are separate boxes", () => {
  assert.deepEqual(del({ zones: true }), ["zone-f"]);
  assert.deepEqual(del({ teardrops: true }), ["teardrop"]);
});
test("footprints and tracks follow the lock filters (unlocked only by default)", () => {
  assert.deepEqual(del({ footprints: true }), ["fp-front"]);
  assert.deepEqual(del({ footprints: true, lockedFootprints: true }), ["fp-back-locked", "fp-front"]);
  assert.deepEqual(del({ tracks: true }), ["trk-f", "via"]);
  assert.deepEqual(del({ tracks: true, lockedTracks: true, unlockedVias: false }), ["trk-b-locked", "trk-f"]);
});
test("graphics are the non-copper shapes other than Edge.Cuts; board outlines Edge.Cuts; texts only with no shapes", () => {
  assert.deepEqual(del({ graphics: true }), ["silk"], "a copper graphic and the text stay");
  assert.deepEqual(del({ boardOutlines: true }), ["edge"]);
  assert.deepEqual(del({ texts: true }), ["text"]);
  assert.deepEqual(del({ texts: true, graphics: true }), ["silk"], "KiCad's else-if: with shapes checked the texts stay");
});
test("current layer only", () => {
  assert.deepEqual(del({ footprints: true, lockedFootprints: true, currentLayerOnly: true }, "B.Cu"), ["fp-back-locked"]);
  assert.deepEqual(del({ tracks: true, currentLayerOnly: true }, "F.Cu"), ["trk-f", "via"]);
  assert.deepEqual(del({ graphics: true, currentLayerOnly: true }, "F.Cu"), []);
  assert.deepEqual(del({ graphics: true, currentLayerOnly: true }, "F.SilkS"), ["silk"]);
});
