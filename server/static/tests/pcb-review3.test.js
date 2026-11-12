// pcb-review3.test.js — fixes from the third board review (pcb-tools.js): Duplicate / Create Array of a tuning
// pattern copies the generator with its members (EDIT_TOOL::Duplicate, PCB_GROUP::DeepDuplicate), copper thieving
// is refused on a board in an older file format (SEXPR_BOARD_FILE_VERSION 20260513) and ZONE::SetFillMode leaves
// the pad connection alone, A.Type names (ENUM_MAP<KICAD_T>), A.inDiffPair's base name (DRC_ENGINE::MatchDpSuffix),
// and the DRC dialog's rule / inspect / fix menu entries (DIALOG_DRC::OnDRCItemRClick).
// Run: node server/static/tests/pcb-review3.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("board review 3 fixes under node");

const TUNED = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "SIG") (net 2 "GND")
  (segment (start 10 10) (end 12 10) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "m1"))
  (arc (start 12 10) (mid 13 11) (end 14 10) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "m2"))
  (segment (start 14 10) (end 20 10) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "m3"))
  (generated (uuid "gen1") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
    (base_line (pts (xy 10 10) (xy 20 10))) (corner_radius_percent 80) (end (xy 20 10)) (initial_side "right")
    (last_status "tuned") (max_amplitude 1) (min_amplitude 0.1) (min_spacing 0.6) (origin (xy 10 10)) (override_custom_rules no)
    (rounded yes) (single_sided no) (target_length 12) (target_length_max 12.1) (target_length_min 11.9) (tuning_mode "single")
    (members "m1" "m2" "m3"))
  (zone (net 2) (net_name "GND") (layers "F.Cu" "B.Cu") (uuid "z1") (name "") (hatch edge 0.5)
    (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no)
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30))))
)`;
// the board module reads net names through the document it is bound to (bind(ctx) / onDocChanged)
const bindDoc = (doc) => { const ctx = { K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.05, snapOn: true, selected: null, items: [], viewOnly: false, live: true, snap: (m) => m, worldMm: () => [0, 0],
  requestRender() {}, applyLocal() {}, setSelected() {}, commit() {}, toast() {}, setTool() {} }; pcb.onDocChanged(ctx); return doc; };
const parse = (text) => bindDoc(K.parseDoc(text, "kicad_pcb"));
const doc0 = () => parse(TUNED);
const nodeOf = (c) => { const t = K.parseAll(c.sexpr)[0]; return t[0] === "kicad_pcb" ? t.slice(1).find((x) => Array.isArray(x) && P.PCB_KINDS.has(x[0])) : t; };

test("Ctrl+D of a selected tuning pattern duplicates the generator holding copies of its members", () => {
  const doc = doc0(); const r = P.duplicateChanges(doc, ["gen1"], [0, 5]);
  assert.equal(r.changes.length, 4, "three members and the generator");
  const nodes = r.changes.map(nodeOf);
  const gen = nodes.find((n) => n[0] === "generated"); assert.ok(gen, "a new generator");
  assert.equal(nodes.indexOf(gen), nodes.length - 1, "members are added before their generator");
  const mem = K.kid(gen, "members").slice(1).map(K.str); const copies = r.ids.filter((id) => id !== K.str(K.kid(gen, "uuid")[1]));
  assert.deepEqual(new Set(mem), new Set(copies), "the copy's members are the copies, not the originals");
  for (const id of ["m1", "m2", "m3", "gen1"]) assert.ok(!r.ids.includes(id));
  assert.deepEqual(K.kid(K.kid(gen, "origin"), "xy").slice(1), [10, 15], "its stored points move with it");
  for (const c of r.changes) K.applyChange(doc, c, IU);
  assert.equal([...doc.items.values()].filter((it) => it.kind === "generated").length, 2);
  assert.equal(P.topParentOf(doc, copies[0]).id, K.str(K.kid(gen, "uuid")[1]), "a copied member belongs to the new pattern");
});

test("a member selected along with its tuning pattern is not copied twice; a lone member is copied loose", () => {
  const doc = doc0(); assert.equal(P.duplicateChanges(doc, ["gen1", "m1", "m2"]).changes.length, 4);
  const lone = P.duplicateChanges(doc, ["m3"]); assert.equal(lone.changes.length, 1); assert.equal(lone.restore.length, 0, "a generator is not a group the copy joins");
});

test("paste of a copied tuning pattern points the pasted generator at the pasted members", () => {
  const doc = doc0(); const text = P.clipboardText(doc, ["gen1"], [10, 10]); const r = P.pasteChanges(doc, text, [40, 40]);
  const gen = r.changes.map(nodeOf).find((n) => n[0] === "generated");
  const mem = K.kid(gen, "members").slice(1).map(K.str); assert.equal(mem.length, 3);
  for (const id of mem) { assert.ok(r.ids.includes(id), "member " + id + " is a pasted item"); assert.ok(!["m1", "m2", "m3"].includes(id)); }
});

test("Create Array of a tuning pattern copies the generator into each cell (ARRAY_TOOL DeepDuplicate)", () => {
  const doc = doc0(); const o = { arrange: false, type: "grid", nx: 2, ny: 1, dx: 0, dy: 5, keepRefs: true, offsetX: 0, offsetY: 0, stagger: 1, staggerRows: true, center: false, gridNumbering: "horizontal" };
  const r = P.arrayChanges(doc, ["gen1"], o);
  const gens = r.changes.map(nodeOf).filter((n) => n && n[0] === "generated");
  assert.equal(gens.length, 1, "a generator copy: " + JSON.stringify(r.changes.map((c) => c.typeName)));
  const mem = K.kid(gens[0], "members").slice(1).map(K.str); assert.equal(mem.length, 3);
  for (const id of mem) { assert.ok(r.ids.includes(id)); assert.ok(!["m1", "m2", "m3"].includes(id)); }
});

test("copper thieving is refused on a board in the KiCad 10 format; a newer or new board may use it", () => {
  assert.equal(P.THIEVING_FILE_VERSION, 20260513);
  assert.equal(P.thievingAllowed(doc0()), false);
  assert.equal(P.thievingAllowed(K.parseDoc(TUNED.replace("20260206", "20260513"), "kicad_pcb")), true);
  assert.equal(P.thievingAllowed(K.parseDoc(TUNED.replace("(version 20260206) ", ""), "kicad_pcb")), true, "a board without a version is written in the current format");
  const doc = doc0(); const log = { toasts: [], tool: null };
  const ctx = { K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.05, snapOn: true, selected: null, items: [], viewOnly: false, live: true, snap: (m) => m, worldMm: () => [0, 0],
    requestRender() {}, applyLocal() {}, setSelected() {}, commit() { throw new Error("no commit expected"); }, toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); } };
  pcb.onDocChanged(ctx); ctx.setTool("thievingzone");
  assert.equal(log.tool, "select", "the tool does not start"); assert.equal(P.state.modTool, null);
  assert.ok(/KiCad 11 file format/.test(log.toasts.at(-1)), log.toasts.at(-1));
});

test("Fill Mode thieving then solid keeps the zone's pad connection (ZONE::SetFillMode); a drawn thieving zone connects no pads", () => {
  const z = K.kid(K.parseAll(TUNED)[0], "zone");
  const n = JSON.parse(JSON.stringify(z)); P.setZoneFillMode(n, "thieving"); P.setZoneFillMode(n, "solid");
  assert.equal(K.serialize(K.kid(n, "connect_pads")), "(connect_pads (clearance 0.5))");
  const t = JSON.parse(JSON.stringify(z)); P.setZoneFillMode(t, "thieving");
  assert.equal(K.kid(t, "connect_pads")[1][0], "clearance", "no pad-connection keyword written"); assert.equal(K.kid(t, "net"), null); assert.ok(K.kid(t, "layer"));
  const drawn = P.thievingZoneNode(doc0(), [[0, 0], [5, 0], [5, 5]], "F.Cu"); assert.equal(K.kid(drawn, "connect_pads")[1], "no");
});

test("A.Type: an arc track and a straight one are both 'Track', text boxes 'Text Box', tables 'Table', dimensions 'Dimension'", () => {
  const doc = doc0(); const s = P.designSettings(null);
  const rules = P.parseDru(`(version 1)\n(rule "trk" (condition "A.Type == 'Track'") (constraint length (max 1mm)))`).rules;
  assert.ok(P.evalRuleConstraint(rules, "length", doc, s, doc.items.get("m1"), null));
  assert.ok(P.evalRuleConstraint(rules, "length", doc, s, doc.items.get("m2"), null), "an arc is a Track");
  const tb = (kind, extra) => ({ kind, node: [kind].concat(extra || []) });
  const cond = (t) => P.parseDru(`(version 1)\n(rule "r" (condition "A.Type == '${t}'") (constraint length (max 1mm)))`).rules;
  assert.ok(P.evalRuleConstraint(cond("Text Box"), "length", doc, s, tb("gr_text_box"), null));
  assert.ok(P.evalRuleConstraint(cond("Table"), "length", doc, s, tb("table"), null));
  assert.ok(P.evalRuleConstraint(cond("Dimension"), "length", doc, s, tb("dimension", [["type", "aligned"]]), null));
  assert.ok(P.evalRuleConstraint(cond("Leader"), "length", doc, s, tb("dimension", [["type", "leader"]]), null));
  assert.ok(P.evalRuleConstraint(cond("Reference Image"), "length", doc, s, tb("image"), null));
});

test("a net whose first item is an arc keeps its custom-rule length constraint in DRC", () => {
  const doc = parse(TUNED.replace(/\(segment \(start 10 10\)[^\n]*\n/, "")); const s = P.designSettings(null);
  const rules = P.parseDru(`(version 1)\n(rule "trk" (condition "A.Type == 'Track'") (constraint length (min 50mm)))`).rules;
  const m = P.matchedLengthMarkers(doc, s, rules); assert.equal(m.filter((x) => x.code === "length_out_of_range").length, 1, JSON.stringify(m));
});

test("A.inDiffPair: LVDS_P1 has the base name 'LVDS_' (MatchDpSuffix), so 'LVDS' and 'LVDS_*' match; the match is case-sensitive", () => {
  const B = `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal)) (net 0 "") (net 1 "LVDS_P1") (net 2 "LVDS_N1")
    (segment (start 0 0) (end 5 0) (width 0.2) (layer "F.Cu") (net "LVDS_P1") (uuid "p")) (segment (start 0 1) (end 5 1) (width 0.2) (layer "F.Cu") (net "LVDS_N1") (uuid "n")))`;
  const doc = parse(B); const s = P.designSettings(null);
  const has = (arg) => !!P.evalRuleConstraint(P.parseDru(`(version 1)\n(rule "r" (condition "A.inDiffPair('${arg}')") (constraint length (max 1mm)))`).rules, "length", doc, s, doc.items.get("p"), null);
  assert.equal(has("LVDS"), true); assert.equal(has("LVDS_*"), true); assert.equal(has("LVDS_"), true);
  assert.equal(has("lvds"), false, "wxString::Matches is case-sensitive"); assert.equal(has("LVDS_1"), false);
  assert.equal(P.matchDpSuffix("LVDS_P1").base, "LVDS_"); assert.equal(P.matchDpSuffix("LVDS_P1").complement, "LVDS_N1");
});

test("DRC menu: the violating custom rule, Inspect and Fix entries (OnDRCItemRClick, InspectDRCErrorMenuText, FixDRCErrorMenuText)", () => {
  assert.equal(P.violatingRuleName({ text: "Track length out of range (rule 'len' max length 1.0000 mm; actual 2.0000 mm)" }), "len");
  assert.equal(P.violatingRuleName({ text: "Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1000 mm)" }), null);
  assert.equal(P.violatingRuleName({ text: "Clearance violation (board setup constraints clearance 0.2000 mm; actual 0.1 mm)" }), null);
  assert.equal(P.inspectDrcAction("clearance"), "inspectClearance"); assert.equal(P.inspectDrcAction("text_height"), "inspectConstraints");
  assert.equal(P.inspectDrcAction("diff_pair_uncoupled_length_too_long"), "inspectConstraints"); assert.equal(P.inspectDrcAction("lib_footprint_mismatch"), "diffFootprint");
  assert.equal(P.inspectDrcAction("length_out_of_range"), null);
  assert.equal(P.DRC_RUN_TEXT.inspectConstraints, "Run: Inspect > Constraints Resolution");
  assert.deepEqual(P.fixDrcEntry("missing_footprint"), { label: "Run: Tools > Update PCB from Schematic...", action: "updatePcbFromSchematic" });
  assert.equal(P.fixDrcEntry("text_height", "dimension").label, "Edit Dimension Properties...");
  assert.equal(P.fixDrcEntry("text_height", "gr_text").label, "Edit Text Properties...");
  assert.equal(P.fixDrcEntry("lib_footprint_mismatch").label, "Run: Update Footprint...");
  assert.equal(P.fixDrcEntry("track_dangling").action, "cleanupTracksAndVias");
  assert.equal(P.fixDrcEntry("clearance"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
