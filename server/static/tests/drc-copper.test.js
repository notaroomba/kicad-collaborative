// drc-copper.test.js — DRC_TEST_PROVIDER_SLIVER_CHECKER (copper_sliver) and DRC_TEST_PROVIDER_CONNECTION_WIDTH
// (connection_width) against KiCad's own regression boards (qa/tests/pcbnew/drc/test_drc_copper_sliver.cpp and
// test_drc_copper_conn.cpp give the counts), and the Board Setup minimums a project leaves out.
// Run: node server/static/tests/drc-copper.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("DRC: copper slivers, connection width, implicit board setup minimums");
const read = (f, ext) => { try { return fs.readFileSync(path.join(QA, f + ext), "utf8"); } catch (e) { return null; } };
function run(name, code) {
  const doc = K.parseDoc(read(name, ".kicad_pcb"), "kicad_pcb"); const pro = read(name, ".kicad_pro");
  return P.drc(doc, P.designSettings(pro ? JSON.parse(pro) : null), { unconnected: false, rules: read(name, ".kicad_dru") }).filter((m) => m.code === code);
}

test("copper_sliver: sliver has one, the issue boards none (test_drc_copper_sliver.cpp)", () => {
  const s = run("sliver", "copper_sliver");
  assert.equal(s.length, 1); assert.equal(s[0].text, "Copper sliver (F.Cu)"); assert.equal(s[0].severity, "warning"); assert.equal(s[0].layer, "F.Cu");
  for (const f of ["issue14449", "issue14549_2"]) assert.equal(run(f, "copper_sliver").length, 0, f);
});
test("copper_sliver: a sharp spike past the width tolerance, not a right angle", () => {
  // a 10 x 2 mm block with an 11° spike out to (15, 1) on its right side, wound as Clipper's outer contours are
  let poly = [[0, 0], [10e6, 0], [10e6, 0.5e6], [15e6, 1e6], [10e6, 1.5e6], [10e6, 2e6], [0, 2e6]];
  if (P.clipperArea(poly) < 0) poly = poly.reverse();
  assert.deepEqual(P.sliverPoints(poly), [[15e6, 1e6]]);
  let blunt = [[0, 0], [10e6, 0], [10e6, 0.5e6], [11e6, 1e6], [10e6, 1.5e6], [10e6, 2e6], [0, 2e6]];   // 53°: no sliver
  if (P.clipperArea(blunt) < 0) blunt = blunt.reverse();
  assert.deepEqual(P.sliverPoints(blunt), []);
});
test("connection_width: the rule and board setup minimums of connection_width_rules (3), none on issue12831 / issue14130", () => {
  const m = run("connection_width_rules", "connection_width");
  assert.equal(m.length, 3);
  assert.deepEqual(m.map((x) => x.rule).sort(), ["board setup constraints", "rule 'high_current_area'", "rule 'high_current_netclass'"]);
  assert.match(m[0].text, /^Copper connection too narrow \((rule '[a-z_]+'|board setup constraints) minimum connection width 0\.\d{4} mm; actual 0\.\d{4} mm\) \(F\.Cu\)$/);
  for (const f of ["issue12831", "issue14130"]) assert.equal(run(f, "connection_width").length, 0, f);
});
test("POLYGON_TEST finds the neck of a dumbbell and nothing in a plain rectangle", () => {
  const T = new P.PolygonTest(200000);
  const bell = [[0, 0], [1e6, 0], [1e6, 0.45e6], [2e6, 0.45e6], [2e6, 0], [3e6, 0], [3e6, 1e6], [2e6, 1e6], [2e6, 0.55e6], [1e6, 0.55e6], [1e6, 1e6], [0, 1e6]];
  assert.ok(T.findPairs(bell).length >= 1);
  assert.deepEqual(new P.PolygonTest(200000).findPairs([[0, 0], [3e6, 0], [3e6, 1e6], [0, 1e6]]), []);
});
test("implicit board setup minimums: KiCad's defaults when the project leaves them out, the project's value otherwise", () => {
  const d = P.designSettings(null);
  assert.deepEqual([d.minThroughDrill, d.minTrackWidth, d.minViaDiameter, d.minMicroViaDrill, d.minHoleToHole, d.holeClearance, d.edgeClearance, d.minResolvedSpokes, d.minClearance, d.minViaAnnular], [0.3, 0.2, 0.5, 0.1, 0.25, 0.25, 0.5, 2, 0, 0.1]);
  const p = P.designSettings({ board: { design_settings: { rules: { min_track_width: 0.15, min_through_hole_diameter: 0 } } } });
  assert.equal(p.minTrackWidth, 0.15); assert.equal(p.minThroughDrill, 0); assert.equal(p.minViaDiameter, 0.5, "absent: the default stays");
  assert.equal(p.minViaDrill, undefined, "renamed to minThroughDrill");
});
test("annular width slow path: trapezoid, custom and offset pads measured to their outline; a hole outside is 0", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (net 0 "")
  (footprint "X:Y" (layer "F.Cu") (uuid "fp1") (at 20 20)
    (property "Reference" "J1" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole trapezoid (at 0 0) (size 2 2) (rect_delta 0 0.6) (drill 1) (layers "*.Cu" "*.Mask") (uuid "p1"))
    (pad "2" thru_hole custom (at 6 0) (size 1.2 1.2) (drill 1) (layers "*.Cu" "*.Mask") (options (clearance outline) (anchor circle))
      (primitives (gr_rect (start -0.5 -0.5) (end 3 0.5) (width 0) (fill yes))) (uuid "p2"))
    (pad "3" thru_hole rect (at 12 0) (size 2 2) (drill 0.6 (offset 1.5 0)) (layers "*.Cu" "*.Mask") (uuid "p3"))))`, "kicad_pcb");
  const pads = P.padsOf(doc.items.get("fp1"));
  const w = pads.map((p) => P.padAnnulus(p, [], { min: 1, max: null }));
  assert.ok(Math.abs(w[0] - (Math.cos(Math.atan(0.3)) - 0.5)) < 0.005, "trapezoid: the slanted side's distance less the hole radius, got " + w[0]);
  assert.equal(w[1], null, "a custom outline comes from the plotter, which drc() hands in");
  assert.equal(w[2], 0, "the hole 1.5 off a 2 mm square is outside the copper");
  const m = P.drc(doc, P.designSettings({ board: { design_settings: { rules: { min_via_annular_width: 0.15 } } } }), { unconnected: false }).filter((x) => x.code === "annular_width");
  assert.deepEqual(m.map((x) => x.text), ["Annular width (board setup constraints min annular width 0.1500 mm; actual 0.0953 mm)", "Annular width (board setup constraints min annular width 0.1500 mm; actual 0.0000 mm)"],
    "the custom pad's disc anchor (1.2 mm, 1 mm hole) is the narrowest part of its merged outline");
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
