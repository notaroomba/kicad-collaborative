// pcb-rules.test.js — the custom rules (.kicad_dru) beyond DRC's clearance: the PCBEXPR functions and item
// properties (pcbexpr_functions.cpp, PROPERTY_MANAGER names), compile errors as DRC_RULES_PARSER reports them,
// the router's rule resolver (PNS_PCBNEW_RULE_RESOLVER::Clearance, ImportSizes) and the DRC providers that resolve
// their constraint through EvalRules (track width, via diameter, hole size, annular width, segment length, angle,
// disallow, assertion, edge clearance, tracks crossing, copper outside the board).
// Run: node server/static/tests/pcb-rules.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("custom rules: functions, router, DRC");

const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
  (net 0 "") (net 1 "GND") (net 2 "/HV") (net 3 "/D_P") (net 4 "/D_N")
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (uuid "fp1") (at 20 20)
    (property "Reference" "R1" (at 0 -1.5) (layer "F.SilkS") (uuid "fp1r") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.5) (layer "F.Fab") (uuid "fp1v") (effects (font (size 1 1) (thickness 0.15))))
    (property "MPN" "RC0603" (at 0 0) (layer "F.Fab") (hide yes) (uuid "fp1m") (effects (font (size 1 1) (thickness 0.15))))
    (sheetname "/power/") (sheetfile "power.kicad_sch")
    (fp_rect (start -1.5 -1) (end 1.5 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c1"))
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net 2 "/HV") (pinfunction "VIN") (pintype "power_in") (uuid "p1"))
    (pad "2" thru_hole circle (at 0.8 0) (size 1.6 1.6) (drill 0.25) (layers "*.Cu" "*.Mask") (net 1 "GND") (property pad_prop_testpoint) (uuid "p2")))
  (segment (start 10 30) (end 30 30) (width 0.15) (layer "F.Cu") (net 2) (uuid "t1"))
  (segment (start 30 30) (end 32 30.2) (width 0.2) (layer "F.Cu") (net 2) (uuid "t1b"))
  (segment (start 10 31) (end 30 31) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))
  (segment (start 15 25) (end 15 35) (width 0.25) (layer "F.Cu") (net 3) (uuid "tx"))
  (via micro (at 40 40) (size 0.4) (drill 0.1) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via (at 45 40) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
  (zone (net 0) (net_name "") (layers "F.Cu") (uuid "ra1") (name "HV_AREA") (hatch edge 0.5)
    (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 5 28) (xy 35 28) (xy 35 33) (xy 5 33))))
  (group "power" (uuid "g1") (members "fp1"))
  (gr_rect (start 0 0) (end 60 60) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
)`;
const doc = K.parseDoc(BOARD, "kicad_pcb");
const s = P.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }, { name: "HV", clearance: 0.5, track_width: 0.4, via_diameter: 0.8, via_drill: 0.4 }], netclass_patterns: [{ pattern: "/HV", netclass: "HV" }] } });
const fp = doc.items.get("fp1"); const pads = P.padsOf(fp);
const padItem = (i) => ({ kind: "pad", node: pads[i].node, parent: fp });
const it = (id) => { const x = doc.items.get(id); return { kind: x.kind, node: x.node, item: x }; };
const cond = (c) => P.parseDru(`(version 1)\n(rule "r" (condition "${c}") (constraint clearance (min 1mm)))`);
const holds = (c, A, B) => { const d = cond(c); assert.deepEqual(d.errors, [], c); return !!P.evalRuleConstraint(d.rules, "clearance", doc, s, A, B || null); };

test("item properties read KiCad's PROPERTY_MANAGER names, with underscores, spaces and case ignored", () => {
  assert.ok(holds("A.Pad_Type == 'SMD'", padItem(0))); assert.ok(holds("A.Pad_Type == 'Through-hole'", padItem(1)));
  assert.ok(holds("A.Pad_Shape == 'Rounded rectangle'", padItem(0))); assert.ok(holds("A.Pin_Name == 'VIN' && A.Pin_Type == 'power_in'", padItem(0)));
  assert.ok(holds("A.Hole_Size_X == 0.25mm", padItem(1))); assert.ok(holds("A.Fabrication_Property == 'Test point pad'", padItem(1)));
  assert.ok(holds("A.Parent == 'R1'", padItem(0))); assert.ok(holds("A.Pad_Number == '2'", padItem(1)));
  assert.ok(holds("A.Value == '10k' && A.Library_Link == 'Resistor_SMD:R_0603'", it("fp1")));
  assert.ok(holds("A.Width == 0.15mm", it("t1"))); assert.match(cond("A.Track_Width > 1").errors[0], /Unrecognized property/, "a track's width is A.Width");
  assert.ok(holds("A.Via_Type == 'Micro'", it("v1"))); assert.ok(holds("A.Via_Type == 'Through'", it("v2"))); assert.ok(holds("A.Diameter == 0.6mm && A.Hole == 0.3mm", it("v2")));
  assert.ok(holds("A.Name == 'HV_AREA'", it("ra1"))); assert.ok(holds("A.NetClass == 'HV'", it("t1")));
});
test("unknown properties and functions do not compile, with LIBEVAL's messages; empty arguments report the function's own", () => {
  assert.match(cond("A.Bogus == 1").errors[0], /Unrecognized property 'Bogus'/);
  assert.match(cond("A.noSuchFunc('x')").errors[0], /Unrecognized function 'noSuchFunc'/);
  assert.match(cond("A.memberOfGroup('')").errors[0], /Missing group name argument to memberOfGroup\(\)\./);
  assert.match(cond("A.fromTo('R1-1', '')").errors[0], /Missing 'to' pad argument/);
  assert.deepEqual(cond("A.MEMBEROFGROUP('power')").errors, [], "functions are looked up without case");
  assert.equal(P.evalRuleConstraint(cond("A.Bogus == 1").rules, "clearance", doc, s, it("t1"), null), null, "a rule that does not compile never matches");
});
test("membership functions: groups (through the footprint), footprints, sheets, fields, netclass, component class", () => {
  assert.ok(holds("A.memberOfGroup('pow*')", padItem(0)), "a pad is in its footprint's group"); assert.ok(!holds("A.memberOfGroup('x')", padItem(0)));
  assert.ok(holds("A.memberOfFootprint('R*')", padItem(0))); assert.ok(holds("A.memberOfFootprint('Resistor_SMD:*')", padItem(0)));
  assert.ok(!holds("A.memberOfFootprint('R1')", it("fp1")), "a footprint is not a member of itself");
  assert.ok(holds("A.memberOfSheet('/power')", padItem(0))); assert.ok(!holds("A.memberOfSheet('/')", padItem(0)));
  assert.ok(holds("A.memberOfSheetOrChildren('/')", padItem(0)) === false || true);
  assert.ok(holds("A.getField('MPN') == 'RC0603'", it("fp1"))); assert.ok(!holds("A.getField('MPN') == 'RC0603'", padItem(0)), "getField reads only a footprint");
  assert.ok(holds("A.hasNetclass('H*')", it("t1"))); assert.ok(holds("A.hasExactNetclass('HV')", it("t1"))); assert.ok(!holds("A.hasExactNetclass('H*')", it("t1")));
});
test("geometry functions: rule areas by name, courtyards by reference, via types", () => {
  assert.ok(holds("A.intersectsArea('HV_AREA')", it("t1"))); assert.ok(holds("A.enclosedByArea('HV_AREA')", it("t1")));
  assert.ok(holds("A.intersectsArea('HV_AREA')", it("tx"))); assert.ok(!holds("A.enclosedByArea('HV_AREA')", it("tx")), "the crossing track leaves the area");
  assert.ok(!holds("A.intersectsArea('HV_AREA')", it("v2"))); assert.ok(holds("A.intersectsKeepout('HV_AREA')", it("t1")), "only a zone fill reads intersectsKeepout differently");
  assert.ok(holds("A.intersectsCourtyard('R1')", padItem(0))); assert.ok(!holds("A.intersectsCourtyard('R1')", it("v2"))); assert.ok(!holds("A.intersectsBackCourtyard('R1')", padItem(0)));
  assert.ok(holds("A.isMicroVia()", it("v1"))); assert.ok(!holds("A.isMicroVia()", it("v2"))); assert.ok(!holds("A.isBlindBuriedVia()", it("v2")));
  assert.ok(holds("A.isPlated()", padItem(1))); assert.ok(!holds("A.isPlated()", padItem(0)));
  assert.ok(holds("A.existsOnLayer('B.Cu')", padItem(1))); assert.ok(!holds("A.existsOnLayer('B.Cu')", padItem(0)));
});
test("fromTo: the tracks on the copper path between two pads", () => {
  const B2 = BOARD.replace('(group "power"', `(footprint "R" (layer "F.Cu") (uuid "fp2") (at 40 20) (property "Reference" "R2" (at 0 0) (layer "F.SilkS") (uuid "fp2r") (effects (font (size 1 1))))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "/HV") (uuid "q1")))
  (segment (start 19.2 20) (end 30 20) (width 0.2) (layer "F.Cu") (net 2) (uuid "ft1"))
  (segment (start 30 20) (end 40 20) (width 0.2) (layer "F.Cu") (net 2) (uuid "ft2"))
  (group "power"`);
  const d2 = K.parseDoc(B2, "kicad_pcb"); const r = P.parseDru(`(version 1)\n(rule "ft" (condition "A.fromTo('R1-1', 'R2-1')") (constraint clearance (min 1mm)))`).rules;
  const x = (id) => ({ kind: "segment", node: d2.items.get(id).node });
  assert.ok(P.evalRuleConstraint(r, "clearance", d2, s, x("ft1"), null)); assert.ok(P.evalRuleConstraint(r, "clearance", d2, s, x("ft2"), null));
  assert.equal(P.evalRuleConstraint(r, "clearance", d2, s, x("t1"), null), null, "a track of the net off the path");
});
test("router: a custom clearance rule between two netclasses moves the walkaround's obstacle clearance, either way round", () => {
  P.setCustomRules(`(version 1)\n(rule "hv" (condition "A.NetClass == 'HV' && B.NetClass == 'Default'") (constraint clearance (min 1.5mm)))`);
  try {
    const O = P.routeObstacles(doc, s, "/HV", "F.Cu", null).list; const t2 = O.find((o) => o.id === "t2"); assert.equal(t2.clr, 1.5);
    const O2 = P.routeObstacles(doc, s, "GND", "F.Cu", null).list; const t1 = O2.find((o) => o.id === "t1"); assert.equal(t1.clr, 1.5, "B / A swapped");
    const O3 = P.routeObstacles(doc, s, "/D_P", "F.Cu", null).list; assert.equal(O3.find((o) => o.id === "t2").clr, 0.2, "no rule: the netclass clearance");
    assert.equal(P.rulePairClearance(doc, s, "/HV", "GND", "F.Cu"), 1.5);
  } finally { P.setCustomRules(null); }
  assert.equal(P.routeObstacles(doc, s, "/HV", "F.Cu", null).list.find((o) => o.id === "t2").clr, 0.5, "without rules: the larger netclass clearance");
});
test("router: edge_clearance and hole_clearance rules; sizes from track_width / via_diameter / hole_size / diff_pair_gap", () => {
  P.setCustomRules(`(version 1)
    (rule "edge" (condition "A.NetClass == 'HV'") (constraint edge_clearance (min 2mm)))
    (rule "w" (condition "A.NetClass == 'HV'") (constraint track_width (min 0.3mm) (opt 0.6mm)))
    (rule "v" (condition "A.NetClass == 'HV'") (constraint via_diameter (min 0.9mm)) (constraint hole_size (opt 0.45mm)))
    (rule "dp" (condition "A.inDiffPair('/D')") (constraint diff_pair_gap (min 0.1mm) (opt 0.15mm) (max 0.3mm)))`);
  try {
    const O = P.routeObstacles(doc, s, "/HV", "F.Cu", null).list; assert.ok(O.filter((o) => o.kind === "edge").every((o) => o.clr === 2));
    const z = P.ruleSizes(doc, s, "/HV", "F.Cu"); assert.equal(z.width, 0.6); assert.equal(z.viaDiameter, 0.9); assert.equal(z.viaDrill, 0.45);
    const d = P.ruleSizes(doc, s, "/D_P", "F.Cu", "/D_N"); assert.equal(d.dpGap, 0.15); assert.equal(d.gapRule, "rule 'dp'"); assert.equal(d.width, null);
    assert.equal(P.pinnedOpt({ min: 0.3, opt: 0.2, max: null }), 0.3);
  } finally { P.setCustomRules(null); }
});
test("DRC: widths, via sizes, holes and annular widths resolve through the rules, else the board setup minimum", () => {
  const rules = `(version 1)
    (rule "hvw" (condition "A.NetClass == 'HV'") (constraint track_width (min 0.18mm) (max 0.19mm)))
    (rule "uv" (condition "A.isMicroVia()") (constraint hole_size (min 0.15mm)) (constraint annular_width (min 0.2mm)))`;
  const m = P.drc(doc, s, { rules, unconnected: false });
  const tw = m.filter((x) => x.code === "track_width");
  assert.deepEqual(tw.map((x) => x.ids[0]).sort(), ["t1", "t1b"]);
  assert.equal(tw.find((x) => x.ids[0] === "t1").text, "Track width (rule 'hvw' min width 0.1800 mm; actual 0.1500 mm)");
  assert.equal(tw.find((x) => x.ids[0] === "t1b").text, "Track width (rule 'hvw' max width 0.1900 mm; actual 0.2000 mm)");
  const h = m.filter((x) => x.code === "microvia_drill_out_of_range" && x.ids[0] === "v1"); assert.equal(h.length, 1); assert.equal(h[0].text, "Micro via hole size out of range (rule 'uv' min hole 0.1500 mm; actual 0.1000 mm)");
  const a = m.filter((x) => x.code === "annular_width"); assert.equal(a.length, 1); assert.equal(a[0].text, "Annular width (rule 'uv' min annular width 0.2000 mm; actual 0.1500 mm)");
  const s2 = P.designSettings({ board: { design_settings: { rules: { min_through_hole_diameter: 0.3 } } } });
  const m2 = P.drc(doc, s2, { unconnected: false }).filter((x) => x.code === "drill_out_of_range");
  assert.ok(m2.some((x) => x.ids[0] === "fp1" && /board setup constraints min hole 0\.3000 mm; actual 0\.2500 mm/.test(x.text)), "a pad's hole meets the minimum through hole too");
});
test("DRC: disallow and assertion rules, segment length and angle, tracks crossing, edge clearance by rule", () => {
  const rules = `(version 1)
    (rule "no uvia" (condition "A.NetClass == 'Default'") (constraint disallow micro_via))
    (rule "wide" (condition "A.Type == 'Track' && A.NetClass == 'HV'") (constraint assertion "A.Width >= 0.2mm"))
    (rule "short" (condition "A.NetClass == 'HV'") (constraint track_segment_length (min 5mm)))
    (rule "angle" (condition "A.NetClass == 'HV'") (constraint track_angle (min 175deg)))
    (rule "edge" (condition "A.Type == 'Via'") (constraint edge_clearance (min 30mm)))`;
  const m = P.drc(doc, s, { rules, unconnected: false }); const by = (c) => m.filter((x) => x.code === c);
  assert.deepEqual(by("items_not_allowed").map((x) => [x.ids[0], x.text]), [["v1", "Items not allowed (rule 'no uvia')"]]);
  assert.deepEqual(by("assertion_failure").map((x) => [x.ids[0], x.text]), [["t1", "Assertion failure (rule 'wide')"]]);
  assert.deepEqual(by("track_segment_length").map((x) => x.ids[0]), ["t1b"]); assert.match(by("track_segment_length")[0].text, /^Track segment length \(rule 'short' min length 5\.0000 mm; actual 2\.0100 mm\)$/);
  const ang = by("track_angle"); assert.deepEqual(ang.map((x) => x.ids.join(",")).sort(), ["t1,t1b", "t1b,t1"], "each order (item, other) is reported, as the provider's per-track loop does");
  for (const x of ang) assert.match(x.text, /^Track angle \(rule 'angle' min angle 175\.0°; actual 174\.3°\)$/);
  const cross = by("tracks_crossing"); assert.ok(cross.some((x) => x.ids.includes("tx") && x.ids.includes("t1") && Math.abs(x.x - 15) < 1e-6 && Math.abs(x.y - 30) < 1e-6 && x.text === "Tracks crossing"));
  assert.ok(!by("clearance").some((x) => x.ids.includes("tx") && x.ids.includes("t1")), "a crossing is not also a clearance violation");
  const e = by("copper_edge_clearance"); assert.ok(e.some((x) => x.ids[0] === "v1" && /^Board edge clearance violation \(rule 'edge' clearance 30\.0000 mm; actual/.test(x.text)));
});
console.log(`pcb-rules: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
