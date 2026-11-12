// pcb-silk.test.js — the silkscreen and solder mask DRC providers: DRC_TEST_PROVIDER_SILK_CLEARANCE (silk_overlap,
// silk_over_copper), the edge clearance provider's silk part (silk_edge_clearance, resolveSilkDisposition) and
// DRC_TEST_PROVIDER_SOLDER_MASK (silk against the healed mask, solder_mask_bridge).
// Run: node server/static/tests/pcb-silk.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("silkscreen and solder mask DRC");

const board = (setup, body) => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (7 "B.SilkS" user) (25 "Edge.Cuts" user))
  (setup ${setup})
  (net 0 "") (net 1 "A") (net 2 "B")
  (gr_rect (start 0 0) (end 60 60) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
  ${body})`;
const FP = (attr = "") => `(footprint "R" (layer "F.Cu") (uuid "fp1") (at 20 20) ${attr}
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 3) (layer "F.Fab") (uuid "v1") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -2 -2) (end 2 -2) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1"))
    (fp_line (start -2 -2.5) (end -2 -1.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l2"))
    (pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "p1"))
    (pad "2" smd rect (at 0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (net 2 "B") (uuid "p2")))`;
function run(setup, body, pro, rules) {
  const text = board(setup, body); const doc = K.parseDoc(text, "kicad_pcb");
  const s = P.designSettings(pro || null); s.boardSetup = K.kid(K.parse(text), "setup");
  return { doc, s, markers: P.silkMaskMarkers(doc, s, rules ? P.parseDru(rules).rules : []), all: () => P.drc(doc, s, { rules: rules || null }) };
}
const codes = (ms, code) => ms.filter((m) => m.code === code);

test("a field over a board text is a silk overlap; two drawings of one footprint are not", () => {
  const r = run("(pad_to_mask_clearance 0)", FP() + `(gr_text "HELLO" (at 20 21) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`);
  const o = codes(r.markers, "silk_overlap"); assert.equal(o.length, 1); assert.deepEqual(o[0].ids.slice().sort(), ["fp1", "t1"]);
  assert.equal(o[0].text, "Silkscreen clearance"); assert.equal(o[0].severity, "warning");
});
test("board drawings crossing each other are one compound shape (no overlap)", () => {
  const r = run("(pad_to_mask_clearance 0)", `(gr_line (start 10 10) (end 13 10) (stroke (width 0.2) (type solid)) (layer "F.SilkS") (uuid "s1"))
    (gr_line (start 11 9) (end 11 11) (stroke (width 0.2) (type solid)) (layer "F.SilkS") (uuid "s2"))`);
  assert.equal(codes(r.markers, "silk_overlap").length, 0);
});
test("the silk clearance of Board Setup is reported with its value", () => {
  const body = `(gr_text "AB" (at 10 10) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))
    (gr_text "CD" (at 10 11.3) (layer "F.SilkS") (uuid "t2") (effects (font (size 1 1) (thickness 0.15))))`;
  assert.equal(codes(run("", body).markers, "silk_overlap").length, 0);
  const r = run("", body, { board: { design_settings: { rules: { min_silk_clearance: 0.5 } } } });
  const o = codes(r.markers, "silk_overlap"); assert.equal(o.length, 1);
  assert.match(o[0].text, /^Silkscreen clearance \(board setup constraints silk clearance 0\.5000 mm; actual 0\.\d{4} mm\)$/);
});
test("a silk_clearance rule with severity ignore drops the overlap", () => {
  const r = run("", FP() + `(gr_text "HELLO" (at 20 21) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`, null,
    `(version 1)\n(rule "no silk" (constraint silk_clearance) (severity ignore))`);
  assert.equal(codes(r.markers, "silk_overlap").length, 0);
});
test("silk over a pad's mask opening is clipped; silk off the opening is not", () => {
  const r = run("(pad_to_mask_clearance 0.05)", FP());
  const c = codes(r.markers, "silk_over_copper"); assert.equal(c.length, 2); assert.equal(c[0].text, "Silkscreen clipped by solder mask"); assert.deepEqual(c[0].ids, ["fp1"]);
  const far = run("(pad_to_mask_clearance 0.05)", FP().replace('(at 0 0) (layer "F.SilkS")', '(at 0 5) (layer "F.SilkS")'));
  assert.equal(codes(far.markers, "silk_over_copper").length, 0);
});
test("a tented via is no mask opening; an open one is", () => {
  const text = `(gr_text "VV" (at 30 30) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`;
  const tented = run("(pad_to_mask_clearance 0) (tenting (front yes) (back yes))", text + `(via (at 30 30) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))`);
  assert.equal(codes(tented.markers, "silk_over_copper").length, 0);
  const open = run("(pad_to_mask_clearance 0) (tenting (front yes) (back yes))", text + `(via (at 30 30) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (tenting (front no) (back no)) (net 1) (uuid "v1"))`);
  assert.equal(codes(open.markers, "silk_over_copper").length, 1);
});
test("silk across the board edge is clipped by it", () => {
  const r = run("", `(gr_text "EDGE" (at 60 30) (layer "F.SilkS") (uuid "t2") (effects (font (size 1 1) (thickness 0.15))))
    (gr_text "IN" (at 30 30) (layer "F.SilkS") (uuid "t3") (effects (font (size 1 1) (thickness 0.15))))`);
  const e = codes(r.markers, "silk_edge_clearance"); assert.equal(e.length, 1); assert.deepEqual(e[0].ids, ["edge", "t2"]); assert.equal(e[0].text, "Silkscreen clipped by board edge");
});
test("a mask aperture exposing tracks of two nets bridges them; one net does not", () => {
  const ap = `(gr_rect (start 40 39) (end 42 41) (stroke (width 0) (type solid)) (fill yes) (layer "F.Mask") (uuid "ap"))`;
  const two = run("", ap + `(segment (start 40 40) (end 45 40) (width 0.25) (layer "F.Cu") (net 2) (uuid "trk"))
    (segment (start 41 39.5) (end 41 37) (width 0.25) (layer "F.Cu") (net 1) (uuid "trk2"))`);
  const b = codes(two.markers, "solder_mask_bridge"); assert.equal(b.length, 1);
  assert.equal(b[0].text, "Front solder mask aperture bridges items with different nets"); assert.equal(b[0].message, true); assert.deepEqual(b[0].ids, ["ap", "trk", "trk2"]);
  const one = run("", ap + `(segment (start 40 40) (end 45 40) (width 0.25) (layer "F.Cu") (net 2) (uuid "trk"))
    (segment (start 41 39.5) (end 41 37) (width 0.25) (layer "F.Cu") (net 2) (uuid "trk2"))`);
  assert.equal(codes(one.markers, "solder_mask_bridge").length, 0);
});
test("pad openings closer than the minimum web width bridge, unless the footprint allows it", () => {
  const near = FP().replace("(at -0.8 0)", "(at -0.45 0)").replace("(at 0.8 0)", "(at 0.45 0)").replace('(at 0 0) (layer "F.SilkS")', '(at 0 5) (layer "F.SilkS")');
  assert.equal(codes(run("(pad_to_mask_clearance 0)", near).markers, "solder_mask_bridge").length, 0);   // 0.1 mm apart, no web width
  const r = run("(pad_to_mask_clearance 0) (solder_mask_min_width 0.2)", near); const b = codes(r.markers, "solder_mask_bridge");
  assert.equal(b.length, 1); assert.deepEqual(b[0].ids, ["fp1"]);
  assert.equal(codes(run("(pad_to_mask_clearance 0) (solder_mask_min_width 0.2) (allow_soldermask_bridges_in_footprints yes)", near).markers, "solder_mask_bridge").length, 0);
  assert.equal(codes(run("(pad_to_mask_clearance 0) (solder_mask_min_width 0.2)", near.replace('(at 20 20)', '(at 20 20) (attr smd allow_soldermask_bridges)')).markers, "solder_mask_bridge").length, 0);
});
test("with a minimum web width, silk in a web too narrow to print is clipped (the healed mask)", () => {
  const pads = `(footprint "J" (layer "F.Cu") (uuid "fp2") (at 30 30)
    (property "Reference" "J1" (at 0 5) (layer "F.SilkS") (uuid "jr") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.6 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "q1"))
    (pad "2" smd rect (at 0.6 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "q2")))
    (gr_line (start 30 28) (end 30 32) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "web"))`;
  assert.equal(codes(run("(pad_to_mask_clearance 0)", pads).markers, "silk_over_copper").length, 0);   // in the 0.2 mm web, touching neither
  const r = run("(pad_to_mask_clearance 0) (solder_mask_min_width 0.3)", pads); const c = codes(r.markers, "silk_over_copper");
  assert.equal(c.length, 1); assert.deepEqual(c[0].ids, ["web"]);
});
test("drc() runs the providers and applies the project's severities", () => {
  const r = run("(pad_to_mask_clearance 0.05)", FP() + `(gr_text "HELLO" (at 20 21) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`);
  const all = r.all(); assert.ok(codes(all, "silk_overlap").length === 1 && codes(all, "silk_over_copper").length >= 2);
  const r2 = run("(pad_to_mask_clearance 0.05)", FP(), { board: { design_settings: { rule_severities: { silk_over_copper: "ignore", silk_overlap: "error" } } } });
  assert.equal(codes(r2.all(), "silk_over_copper").length, 0);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
