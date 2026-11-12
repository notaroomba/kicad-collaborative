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

// ---- DRC exclusions (DRC_EXCLUSION ProtoJSON in board.design_settings.drc_exclusions)
const XBOARD = `(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (net 1 "A") (net 2 "B")
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "aaaaaaaa-0000-0000-0000-000000000001"))
  (segment (start 0 0.3) (end 10 0.3) (width 0.25) (layer "F.Cu") (net 2) (uuid "aaaaaaaa-0000-0000-0000-000000000002")))`;
test("exclusionOf writes DRC_EXCLUSION's ProtoJSON: DRCET type, nm position as strings, item KIIDs, MT_DRC", () => {
  const doc = K.parseDoc(XBOARD, "kicad_pcb"); const ids = [...doc.items.values()].filter((i) => i.kind === "segment").map((i) => i.id);
  const ex = P.exclusionOf(doc, { code: "clearance", x: 5, y: 0.15, ids }, "known");
  assert.deepEqual(ex, { marker: { error_type: "DRCET_CLEARANCE", position: { x_nm: "5000000", y_nm: "150000" }, items: [{ value: "aaaaaaaa-0000-0000-0000-000000000001" }, { value: "aaaaaaaa-0000-0000-0000-000000000002" }], marker_type: "MT_DRC" }, comment: "known" });
  const st = P.exclusionOf(doc, { code: "starved_thermal", x: 0, y: 1, ids: [] });
  assert.equal(st.marker.layer, "BL_F_Cu"); assert.equal(st.marker.position.x_nm, undefined, "zero fields are left out");
});
test("applyExclusions marks the matching markers (comment kept), legacy strings and objects alike; withoutExclusions removes by key", () => {
  const doc = K.parseDoc(XBOARD, "kicad_pcb"); const ids = [...doc.items.values()].filter((i) => i.kind === "segment").map((i) => i.id);
  const m1 = { code: "clearance", x: 5, y: 0.15, ids, severity: "error" }, m2 = { code: "track_width", x: 1, y: 1, ids: [ids[0]], severity: "error" };
  let entries = P.withExclusion([], P.exclusionOf(doc, m1, "ok by design"));
  entries.push(["track_width|1000000|1000000|aaaaaaaa-0000-0000-0000-000000000001|00000000-0000-0000-0000-000000000000", "legacy"]);
  const out = P.applyExclusions(doc, [m1, m2, { code: "clearance", x: 6, y: 0.15, ids, severity: "error" }], entries);
  assert.equal(out[0].excluded, true); assert.equal(out[0].comment, "ok by design");
  assert.equal(out[1].excluded, true, "a legacy pipe-delimited entry still matches"); assert.equal(out[1].comment, "legacy");
  assert.equal(out[2].excluded, undefined, "another position is another violation");
  entries = P.withExclusion(entries, P.exclusionOf(doc, m1, "edited"));
  assert.equal(entries.length, 2, "re-excluding replaces (erase + insert)"); assert.equal(entries[1].comment, "edited");
  const left = P.withoutExclusions(entries, new Set([P.exclusionKey(P.exclusionOf(doc, m1))]));
  assert.equal(left.length, 1); assert.ok(Array.isArray(left[0]), "the other (legacy) entry is kept as written");
});
test("projectExclusions reads board.design_settings.drc_exclusions", () => {
  assert.deepEqual(P.projectExclusions(JSON.stringify({ board: { design_settings: { drc_exclusions: [{ marker: { error_type: "DRCET_CLEARANCE" } }] } } })), [{ marker: { error_type: "DRCET_CLEARANCE" } }]);
  assert.deepEqual(P.projectExclusions("{bad"), []); assert.deepEqual(P.projectExclusions(null), []);
});

// ---- DRC test providers (drc-more.ts)
const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (37 "B.Fab" user))`;
const drcBoard = (body) => K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") ${LAYERS} (net 0 "") (net 1 "A") ${body})`, "kicad_pcb");
const codes = (m, code) => m.filter((x) => x.code === code);
test("DRC hole to hole: drilled holes closer than 0.25 mm, co-located holes, a slot measured along its axis", () => {
  const doc = drcBoard(`(via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
    (via (at 10.5 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
    (via (at 20 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v3"))
    (via (at 20 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v4"))
    (footprint "X" (layer "F.Cu") (uuid "fp1") (at 30 10) (pad "1" thru_hole oval (at 0 0) (size 3 1.5) (drill oval 2.5 1) (layers "*.Cu") (uuid "p1")))
    (via (at 31.5 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v5"))`);
  const m = P.drc(doc, null, { unconnected: false });
  const h = codes(m, "hole_to_hole"); assert.equal(h.length, 2, JSON.stringify(h));
  assert.equal(h[0].text, "Drilled hole too close to other hole (board setup constraints min 0.2500 mm; actual 0.2000 mm)"); assert.deepEqual(h[0].ids, ["v1", "v2"]); assert.equal(h[0].severity, "warning");
  assert.ok(h.some((x) => x.ids.includes("v5") && /actual 0\.1000 mm/.test(x.text)), "the slot end sits 0.75 mm from its centre: 1.5 - 0.75 - 0.5 - 0.15 = 0.1");
  const c = codes(m, "holes_co_located"); assert.equal(c.length, 1); assert.deepEqual(c[0].ids, ["v3", "v4"]);
  const s = P.designSettings({ board: { design_settings: { rules: { min_hole_to_hole: 0.1 } } } }); assert.equal(codes(P.drc(doc, s, { unconnected: false }), "hole_to_hole").length, 0);
  const r = P.drc(doc, null, { unconnected: false, rules: `(version 1) (rule tight (constraint hole_to_hole (min 0.15mm)))` }); assert.ok(codes(r, "hole_to_hole").every((x) => /rule 'tight' min 0\.1500 mm/.test(x.text)));
});
test("DRC text dimensions and mirroring: silk minimums from Board Setup, custom text rules, mirrored front / unmirrored back", () => {
  const doc = drcBoard(`(gr_text "small" (at 10 10) (layer "F.SilkS") (uuid "t1") (effects (font (size 0.5 0.5) (thickness 0.05))))
    (gr_text "fab" (at 10 20) (layer "F.Fab") (uuid "t2") (effects (font (size 0.5 0.5) (thickness 0.05))))
    (gr_text "ok" (at 10 30) (layer "F.SilkS") (uuid "t3") (effects (font (size 1 1) (thickness 0.15))))
    (gr_text "mirrored" (at 10 40) (layer "F.SilkS") (uuid "t4") (effects (font (size 1 1) (thickness 0.15)) (justify mirror)))
    (gr_text "back" (at 10 50) (layer "B.SilkS") (uuid "t5") (effects (font (size 1 1) (thickness 0.15))))
    (gr_text "hidden" (at 10 60) (layer "F.SilkS") (uuid "t6") (hide yes) (effects (font (size 0.2 0.2) (thickness 0.01))))`);
  const m = P.drc(doc, null, { unconnected: false });
  assert.deepEqual(codes(m, "text_height").map((x) => [x.ids[0], x.text]), [["t1", "Text height out of range (board setup constraints silk text height min height 0.8000 mm; actual 0.5000 mm)"]]);
  assert.deepEqual(codes(m, "text_thickness").map((x) => [x.ids[0], x.text]), [["t1", "Text thickness out of range (board setup constraints silk text thickness min thickness 0.0800 mm; actual 0.0500 mm)"]]);
  assert.deepEqual(codes(m, "mirrored_text_on_front_layer").map((x) => x.ids[0]), ["t4"]); assert.deepEqual(codes(m, "nonmirrored_text_on_back_layer").map((x) => x.ids[0]), ["t5"]);
  const r = P.drc(doc, null, { unconnected: false, rules: `(version 1) (rule fab (layer "F.Fab") (constraint text_height (min 0.6mm) (max 2mm)))` });
  assert.ok(codes(r, "text_height").some((x) => x.ids[0] === "t2" && /rule 'fab' min height 0\.6000 mm; actual 0\.5000 mm/.test(x.text)));
  assert.equal(P.effectivePenWidth(K.parse(`(gr_text "x" (effects (font (size 1 1))))`), 0), 0.125, "no thickness: size / 8");
  assert.equal(P.effectivePenWidth(K.parse(`(gr_text "x" (effects (font (size 1 1) (thickness 0.5))))`), 0), 0.25, "clamped to a quarter of the size");
});
test("DRC courtyards: malformed and missing courtyards, holes inside another footprint's courtyard", () => {
  const doc = drcBoard(`(footprint "A" (layer "F.Cu") (uuid "a") (at 10 10) (fp_rect (start -3 -3) (end 3 3) (layer "F.CrtYd") (uuid "ca")))
    (footprint "B" (layer "F.Cu") (uuid "b") (at 11 10) (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (uuid "pb")) (pad "2" np_thru_hole circle (at 1 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "pb2")))
    (footprint "C" (layer "F.Cu") (uuid "c") (at 40 10) (attr smd allow_missing_courtyard))
    (footprint "D" (layer "F.Cu") (uuid "d") (at 60 10) (fp_line (start -1 -1) (end 1 -1) (layer "F.CrtYd") (uuid "l1")) (fp_line (start 1 -1) (end 1 1) (layer "F.CrtYd") (uuid "l2")))`);
  const m = P.drc(doc, null, { unconnected: false });
  assert.equal(codes(m, "missing_courtyard").length, 0, "missing courtyards are ignored by default");
  const mal = codes(m, "malformed_courtyard"); assert.deepEqual(mal.map((x) => x.ids[0]), ["d"]); assert.equal(mal[0].text, "Footprint has malformed courtyard (not a closed shape)");
  assert.deepEqual(codes(m, "pth_inside_courtyard").map((x) => x.ids), [["b", "a"]]); assert.deepEqual(codes(m, "npth_inside_courtyard").map((x) => [x.x, x.y]), [[12, 10]]);
  const s = P.designSettings({ board: { design_settings: { rule_severities: { missing_courtyard: "warning" } } } });
  assert.deepEqual(codes(P.drc(doc, s, { unconnected: false }), "missing_courtyard").map((x) => [x.ids[0], x.severity]), [["b", "warning"]], "B has none; C allows it");
});
test("DRC disallow and misc: text on Edge.Cuts, tracks / vias in keepout areas, items on disabled copper layers", () => {
  const doc = drcBoard(`(gr_text "edge" (at 5 5) (layer "Edge.Cuts") (uuid "te") (effects (font (size 1 1) (thickness 0.15))))
    (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "ko") (name "keep") (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy 20 20) (xy 30 20) (xy 30 30) (xy 20 30))))
    (segment (start 15 25) (end 35 25) (width 0.2) (layer "F.Cu") (net 1) (uuid "s1"))
    (segment (start 15 30.05) (end 35 30.05) (width 0.2) (layer "F.Cu") (net 1) (uuid "s2"))
    (segment (start 15 30.1) (end 35 30.1) (width 0.2) (layer "B.Cu") (net 1) (uuid "s3"))
    (via (at 25 22) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
    (segment (start 50 50) (end 55 50) (width 0.2) (layer "In1.Cu") (net 1) (uuid "s4"))`);
  const m = P.drc(doc, null, { unconnected: false });
  assert.deepEqual(codes(m, "text_on_edge_cuts").map((x) => x.ids[0]), ["te"]);
  const ko = codes(m, "items_not_allowed"); assert.deepEqual(ko.map((x) => x.ids[0]).sort(), ["s1", "s2", "v1"], "s3 only touches the edge"); assert.ok(ko.every((x) => x.text === "Items not allowed (keepout area 'keep')"));
  const dl = codes(m, "item_on_disabled_layer"); assert.deepEqual(dl.map((x) => [x.ids[0], x.text]), [["s4", "Item on a disabled copper layer (layer In1.Cu)"]]);
  const s = P.designSettings({ board: { design_settings: { rule_severities: { items_not_allowed: "ignore", text_on_edge_cuts: "warning" } } } });
  const m2 = P.drc(doc, s, { unconnected: false }); assert.equal(codes(m2, "items_not_allowed").length, 0); assert.equal(codes(m2, "text_on_edge_cuts")[0].severity, "warning");
});
test("DRC hole clearance: copper of another net near an NPTH or a thin-ringed via; same-net tracks and copper-clearance pairs are not repeated", () => {
  const doc = drcBoard(`(net 2 "B")
    (footprint "H" (layer "F.Cu") (uuid "fh") (at 10 10) (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "ph")))
    (segment (start 5 10.6) (end 15 10.6) (width 0.2) (layer "F.Cu") (net 1) (uuid "s1"))
    (segment (start 5 9.4) (end 15 9.4) (width 0.2) (layer "F.Cu") (net 0) (uuid "s0"))
    (via (at 30 10) (size 0.35) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
    (segment (start 25 10.485) (end 35 10.485) (width 0.2) (layer "F.Cu") (net 2) (uuid "s2"))
    (segment (start 25 9.6) (end 35 9.6) (width 0.2) (layer "B.Cu") (net 2) (uuid "s3"))`);
  const m = codes(P.drc(doc, null, { unconnected: false }), "hole_clearance");
  assert.deepEqual(m.map((x) => x.ids.join()), ["s1,fh", "s2,v1"], JSON.stringify(m));
  assert.equal(m[0].text, "Hole clearance violation (board setup constraints hole clearance 0.2500 mm; actual 0.0000 mm)");
  assert.ok(/actual 0\.2350 mm/.test(m[1].text), m[1].text);
  const cl = codes(P.drc(doc, null, { unconnected: false }), "clearance"); assert.ok(cl.some((x) => x.ids.includes("s3")) && !m.some((x) => x.ids.includes("s3")), "s3 breaks the copper clearance and is reported as that");
  const s = P.designSettings({ board: { design_settings: { rules: { min_hole_clearance: 0.2 } } } }); assert.deepEqual(codes(P.drc(doc, s, { unconnected: false }), "hole_clearance").map((x) => x.ids[0]), ["s1"]);
});

module.exports = { test, K, P, assert, kid };
process.on("exit", () => { console.log(`\npcb-edit3: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
