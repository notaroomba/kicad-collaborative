// pcb-dialogs.test.js — the pure modules behind the board dialogs, under node: the .kicad_pro editor
// (canvas/project-file.ts), the board's (layers)/(setup) sections (canvas/board-setup.ts), the schematic
// netlist with Update PCB from Schematic's plan and the schematic parity check (canvas/pcb-netlist.ts).
// Run: node server/static/tests/pcb-dialogs.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, P = K.projectFile, B = K.boardSetup, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("board dialogs under node");

// ---------------------------------------------------------------- project file
const PRO = `{
  "board": {
    "design_settings": {
      "defaults": {
        "copper_line_width": 0.2,
        "silk_text_italic": false
      },
      "rule_severities": {
        "clearance": "error"
      },
      "rules": {
        "max_error": 0.005,
        "min_clearance": 0.0,
        "min_resolved_spokes": 2,
        "min_track_width": 0.2
      },
      "track_widths": [
        0.0,
        0.25
      ],
      "via_dimensions": [
        {
          "diameter": 0.0,
          "drill": 0.0
        }
      ]
    }
  },
  "meta": {
    "filename": "demo.kicad_pro",
    "version": 3
  },
  "net_settings": {
    "classes": [
      {
        "bus_width": 12,
        "clearance": 0.2,
        "name": "Default",
        "priority": 2147483647,
        "track_width": 0.2
      }
    ],
    "netclass_patterns": []
  },
  "text_variables": {}
}
`;
test("project file: parse and write back is byte for byte KiCad's JSON (sorted keys, 2 spaces, 0.0 kept)", () => {
  assert.strictEqual(P.stringifyProject(P.parseProject(PRO)), PRO);
});
test("project file: an edit touches only its line; whole doubles keep their .0, counts stay integers", () => {
  const r = P.editProject(PRO, [{ path: ["board", "design_settings", "rules", "min_clearance"], value: 0.3 }, { path: ["board", "design_settings", "rules", "min_track_width"], value: 1 },
    { path: ["board", "design_settings", "rules", "min_resolved_spokes"], value: 4, ints: true }, { path: ["board", "design_settings", "rules", "max_error"], value: 0.005 }]);
  assert.deepStrictEqual(r.changed.map((e) => e.path[3]), ["min_clearance", "min_track_width", "min_resolved_spokes"], "an unchanged value is not an edit");
  const a = PRO.split("\n"), b = r.text.split("\n"); assert.strictEqual(a.length, b.length);
  const diff = b.filter((l, i) => l !== a[i]).map((l) => l.trim());
  assert.deepStrictEqual(diff, ['"min_clearance": 0.3,', '"min_resolved_spokes": 4,', '"min_track_width": 1.0']);
});
test("project file: new keys land sorted; lists and netclasses are written in KiCad's shape", () => {
  const r = P.editProject(PRO, [{ path: ["board", "design_settings", "rules", "min_hole_to_hole"], value: 0.25 }, { path: ["board", "design_settings", "track_widths"], value: [0, 0.25, 0.5] },
    { path: ["net_settings", "classes"], value: [{ bus_width: 12, clearance: 0.2, name: "Default", priority: 2147483647, track_width: 0.2 }, { bus_width: 12, clearance: 0.3, name: "POWER", priority: 0, track_width: 1 }] },
    { path: ["text_variables"], value: { REV: "B" } }]);
  const j = JSON.parse(r.text);
  assert.deepStrictEqual(Object.keys(j.board.design_settings.rules), ["max_error", "min_clearance", "min_hole_to_hole", "min_resolved_spokes", "min_track_width"]);
  assert.ok(/"track_widths": \[\n        0\.0,\n        0\.25,\n        0\.5\n      \]/.test(r.text), "list numbers are doubles");
  assert.ok(/"bus_width": 12,\n        "clearance": 0\.3,\n        "name": "POWER",\n        "priority": 0,\n        "track_width": 1\.0/.test(r.text), r.text.slice(r.text.indexOf("POWER") - 80, r.text.indexOf("POWER") + 90));
  assert.strictEqual(j.text_variables.REV, "B");
  assert.ok(r.text.endsWith("}\n"));
});

// ---------------------------------------------------------------- board sections
const LAYERS = '(layers (0 "F.Cu" signal "top") (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments") (21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user) (39 "User.1" user))';
const SETUP = '(setup (stackup (layer "F.SilkS" (type "Top Silk Screen")) (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01)) (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02)) (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)) (copper_finish "None") (dielectric_constraints no)) (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) (tenting (front yes) (back yes)) (pcbplotparams (layerselection "0x00010fc_ffffffff") (dashed_line_dash_ratio 12) (dashed_line_gap_ratio 3) (svgprecision 4)))';
const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6) (legacy_teardrops no)) (paper "A4") ${LAYERS} ${SETUP} (net 0 "") (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1")))`;
test("board header: (general) (layers) (setup) are found without reading the items", () => {
  const h = B.boardHeader(BOARD);
  assert.strictEqual(h.version, 20241229); assert.strictEqual(K.str(K.kid(h.general, "thickness")[1]), "1.6");
  assert.strictEqual(B.sectionText(h.layers), LAYERS, "the layers section writes back as read");
  assert.strictEqual(B.sectionText(h.setup), SETUP, "the setup section writes back as read");
});
test("layers: the panel's rows write back the file's section; renaming, disabling and a 4 layer stack", () => {
  const h = B.boardHeader(BOARD); let rows = B.layerRows(h.layers);
  assert.strictEqual(B.layersText(rows), LAYERS, "unchanged rows give the same section");
  assert.deepStrictEqual(rows.filter((r) => r.mandatory && !r.copper).map((r) => r.name), ["F.CrtYd", "B.CrtYd", "Edge.Cuts", "Margin"]);
  const fab = rows.find((r) => r.name === "F.Fab");
  assert.ok(B.layerNameError(rows, fab, "bad name"), "spaces are refused"); assert.ok(B.layerNameError(rows, fab, "top"), "a name in use is refused"); assert.strictEqual(B.layerNameError(rows, fab, "Fab_Top"), "");
  fab.userName = "Fab_Top"; rows.find((r) => r.name === "Eco2.User").enabled = false;
  rows = B.setCopperCount(rows, 4);
  const text = B.layersText(rows);
  assert.ok(text.startsWith('(layers (0 "F.Cu" signal "top") (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes"'), text.slice(0, 120));
  assert.ok(text.includes('(35 "F.Fab" user "Fab_Top")') && !text.includes("Eco2.User") && text.endsWith('(39 "User.1" user))'));
  assert.deepStrictEqual(B.setCopperCount(rows, 2).filter((r) => r.copper).map((r) => r.name), ["F.Cu", "B.Cu"]);
});
test("setup: mask / paste follow formatSetup's order and omissions; finish and copper stack go into the stackup", () => {
  const h = B.boardHeader(BOARD);
  assert.deepStrictEqual(B.maskPaste(h.setup), { maskExpansion: 0, maskMinWidth: 0, pasteClearance: 0, pasteRatio: 0, allowBridges: false, tentFront: true, tentBack: true });
  const e = B.editSetup(h.setup, { maskPaste: { maskExpansion: 0.05, maskMinWidth: 0.1, pasteClearance: -0.02, pasteRatio: 0, allowBridges: true, tentFront: true, tentBack: false },
    finish: { copperFinish: "ENIG", edgeConnector: "bevelled", edgePlating: true, hasStackup: true }, dash: { dash: 10, gap: 4 }, copper: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], boardThickness: 1.6 });
  const t = B.sectionText(e);
  assert.ok(t.includes('(copper_finish "ENIG") (dielectric_constraints no) (edge_connector bevelled) (edge_plating yes)) (pad_to_mask_clearance 0.05) (solder_mask_min_width 0.1) (pad_to_paste_clearance -0.02) (allow_soldermask_bridges_in_footprints yes) (tenting (front yes) (back no)) (pcbplotparams'), t.slice(t.indexOf("(copper_finish"), t.indexOf("(pcbplotparams") + 20));
  assert.ok(t.includes('(layer "In1.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 2" (type "prepreg")') && t.includes('(layer "dielectric 3" (type "core")'), "new copper and dielectric layers");
  assert.ok(t.includes("(dashed_line_dash_ratio 10) (dashed_line_gap_ratio 4)"));
  assert.strictEqual(B.sectionText(h.setup), SETUP, "the source node is not touched");
  assert.deepStrictEqual(B.stackupRows(e).filter((r) => r.type === "Copper").map((r) => r.layer), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
  assert.strictEqual(B.boardFinish(e).copperFinish, "ENIG"); assert.strictEqual(B.maskPaste(e).tentBack, false);
  const back = B.sectionText(B.editSetup(e, { maskPaste: B.maskPaste(h.setup) }));
  assert.ok(!back.includes("solder_mask_min_width") && !back.includes("pad_to_paste_clearance"), "zero values are not written");
});
test("BOARD_SETUP change: applies to an open board's layer table and replays over a header", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); assert.deepStrictEqual(doc.copper, ["F.Cu", "B.Cu"]);
  const rows = B.setCopperCount(B.layerRows(B.boardHeader(BOARD).layers), 4);
  const change = B.boardSetupChange({ layers: B.layersText(rows) });
  assert.strictEqual(change.typeName, "BOARD_SETUP"); assert.strictEqual(change.kind, "MODIFIED");
  assert.strictEqual(B.applyBoardSetup(doc, change), true);
  assert.deepStrictEqual(doc.copper, ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]); assert.strictEqual(doc.layers.get("F.Cu").userName, "top");
  assert.strictEqual(B.applyBoardSetup(doc, { id: "x", kind: "MODIFIED", typeName: "PCB_TRACK" }), false);
  assert.strictEqual(K.applyChange(doc, change, 1e6), false, "the item applier leaves it alone");
  const h = B.applyHeaderChange(B.boardHeader(BOARD), change);
  assert.strictEqual(B.layerRows(h.layers).filter((r) => r.copper).length, 4);
});

// ---------------------------------------------------------------- netlist
const LIB = `(lib_symbols
  (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
  (symbol "power:GND" (power) (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
    (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
const sym = (lib, ref, value, fp, x, y, uuid, inst) => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (uuid "${uuid}") (property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "${value}" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "${fp}" (at ${x} ${y} 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "MPN" "X-${ref}" (at ${x} ${y} 0) (hide yes) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${uuid}-p1")) (pin "2" (uuid "${uuid}-p2")) (instances (project "demo" (path "${inst}" (reference "${ref}") (unit 1)))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const U_ROOT = "11111111-1111-1111-1111-111111111111", U_SUB = "22222222-2222-2222-2222-222222222222", U_SHEET = "33333333-3333-3333-3333-333333333333";
// root: R1 between the label SIG and the sheet pin IN; R2 from SIG to GND, its other... sub: R3 from the hierarchical label IN to a local label
function build() {
  const rootSyms = sym("Device:R", "R1", "10k", "Resistor_SMD:R_0603_1608Metric", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", "/" + U_ROOT) + sym("Device:R", "R2", "4k7", "Resistor_SMD:R_0603_1608Metric", 120, 50, "aaaaaaaa-0000-0000-0000-000000000002", "/" + U_ROOT)
    + `(symbol (lib_id "power:GND") (at 120 60 0) (unit 1) (uuid "aaaaaaaa-0000-0000-0000-000000000009") (property "Reference" "#PWR01" (at 120 66 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "GND" (at 120 64 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "g1")) (instances (project "demo" (path "/${U_ROOT}" (reference "#PWR01") (unit 1)))))`;
  const probe = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB} ${rootSyms})`, "kicad_sch");
  const pins = (id) => { const o = {}; for (const p of helpers.symbolPins(probe, probe.items.get(id))) o[p.number] = [p.x, p.y]; return o; };
  const r1 = pins("aaaaaaaa-0000-0000-0000-000000000001"), r2 = pins("aaaaaaaa-0000-0000-0000-000000000002"), g = pins("aaaaaaaa-0000-0000-0000-000000000009");
  const sheetPin = [80, r1[2][1]];
  const root = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB} ${rootSyms}
    ${wire(r1[1], r2[1], "w1")} (label "SIG" (at ${r1[1][0]} ${r1[1][1]} 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
    ${wire(r2[2], g[1], "w2")} ${wire(r1[2], sheetPin, "w3")}
    (sheet (at 60 ${sheetPin[1] - 5}) (size 20 10) (stroke (width 0) (type solid)) (fill (color 0 0 0 0)) (uuid "${U_SHEET}") (property "Sheetname" "sub" (at 60 40 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "sub.kicad_sch" (at 60 56 0) (effects (font (size 1.27 1.27))))
      (pin "IN" input (at 80 ${sheetPin[1]} 0) (effects (font (size 1.27 1.27))) (uuid "sp1")) (instances (project "demo" (path "/${U_ROOT}" (page "2")))))
    (sheet_instances (path "/" (page "1"))))`;
  const subSyms = sym("Device:R", "R3", "1k", "Resistor_SMD:R_0603_1608Metric", 100, 50, "bbbbbbbb-0000-0000-0000-000000000003", `/${U_ROOT}/${U_SHEET}`);
  const sub = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_SUB}") (paper "A4") ${LIB} ${subSyms}
    (hierarchical_label "IN" (shape input) (at ${r1[1][0]} ${r1[1][1]} 180) (effects (font (size 1.27 1.27))) (uuid "h1"))
    (label "LOCAL" (at ${r1[2][0]} ${r1[2][1]} 0) (effects (font (size 1.27 1.27))) (uuid "l2")))`;
  const file = (text, uuid, name) => ({ doc: K.parseDoc(text, "kicad_sch"), uuid, file: name });
  const files = { "demo.kicad_sch": file(root, U_ROOT, "demo.kicad_sch"), "sub.kicad_sch": file(sub, U_SUB, "sub.kicad_sch") };
  return N.buildNetlist(files["demo.kicad_sch"], (f) => files[f] || null, helpers, "demo");
}
const netOf = (nl, ref, pin) => { for (const [name, pins] of nl.nets) if (pins.some((p) => p.ref === ref && p.pin === pin)) return name; return null; };
let nl = null;
test("netlist: components with their symbol paths, power symbols left out, fields carried", () => {
  nl = build();
  assert.deepStrictEqual(nl.components.map((c) => c.ref).sort(), ["R1", "R2", "R3"]);
  const r3 = nl.components.find((c) => c.ref === "R3");
  assert.deepStrictEqual(r3.paths, [`/${U_SHEET}/bbbbbbbb-0000-0000-0000-000000000003`]); assert.strictEqual(r3.sheetName, "/sub/"); assert.strictEqual(r3.sheetFile, "sub.kicad_sch");
  assert.strictEqual(r3.fields.MPN, "X-R3"); assert.strictEqual(r3.footprint, "Resistor_SMD:R_0603_1608Metric");
});
test("netlist: KiCad's net names — local label, global power, sheet pin through the hierarchy, a lone label in the sub sheet", () => {
  assert.strictEqual(netOf(nl, "R1", "1"), "/SIG"); assert.strictEqual(netOf(nl, "R2", "1"), "/SIG");
  assert.strictEqual(netOf(nl, "R2", "2"), "GND");
  assert.strictEqual(netOf(nl, "R1", "2"), netOf(nl, "R3", "1"), "the sheet pin joins the two sheets");
  assert.strictEqual(netOf(nl, "R1", "2"), "/sub/IN");
  assert.strictEqual(netOf(nl, "R3", "2"), "/sub/LOCAL");
});
const pad = (n, net) => `(pad "${n}" smd roundrect (at ${n === "1" ? -0.8 : 0.8} 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25)${net ? ` (net "${net}")` : ""} (uuid "pad-${Math.random().toString(36).slice(2)}"))`;
const fp = (ref, value, x, uuid, p, n1, n2) => `(footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (uuid "${uuid}") (at ${x} 20) (property "Reference" "${ref}" (at 0 -1.4 0) (layer "F.SilkS") (uuid "${uuid}-r") (effects (font (size 1 1) (thickness 0.15)))) (property "Value" "${value}" (at 0 1.4 0) (layer "F.Fab") (uuid "${uuid}-v") (effects (font (size 1 1) (thickness 0.15)))) (path "${p}") (sheetname "/") (sheetfile "demo.kicad_sch") (attr smd) ${pad("1", n1)} ${pad("2", n2)})`;
const PCB = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (paper "A4") ${LAYERS}
  ${fp("R1", "10k", 10, "f1", "/aaaaaaaa-0000-0000-0000-000000000001", "/SIG", "/OLD")}
  ${fp("R2", "999", 20, "f2", "/aaaaaaaa-0000-0000-0000-000000000002", "/SIG", "GND")}
  ${fp("R9", "0R", 30, "f9", "/cccccccc-0000-0000-0000-000000000009", "", "")}
  (segment (start 10.8 20) (end 15 20) (width 0.25) (layer "F.Cu") (net "/OLD") (uuid "t1")))`;
test("update PCB: the dry run reports like BOARD_NETLIST_UPDATER and nothing is changed until applied", () => {
  const doc = K.parseDoc(PCB, "kicad_pcb"), before = K.serialize(doc.items.get("f1").node);
  const plan = N.planUpdate(doc, nl, { updateFields: true, replaceFootprints: true });
  const text = plan.report.map((r) => r.text).join("\n");
  assert.ok(text.includes("Change R2 value from 999 to 4k7."), text);
  assert.ok(/Reconnect R1 pin 2 from \/OLD to \/sub\/IN\./.test(text), text);
  assert.ok(text.includes("Add net /sub/IN."), text);
  assert.ok(/Cannot add R3 \(footprint 'Resistor_SMD:R_0603_1608Metric': library not available\)\./.test(text), text);
  assert.ok(/Total warnings: \d+, errors: 1\./.test(text), text);
  assert.strictEqual(K.serialize(doc.items.get("f1").node), before, "the document is untouched");
  assert.ok(plan.modified.has("f1") && plan.modified.has("f2") && !plan.removed.length && !plan.added.length);
  const f1 = K.serialize(plan.modified.get("f1")); assert.ok(f1.includes('(net "/sub/IN")') && f1.includes('(property "MPN" "X-R1"'), f1.slice(0, 700));
  assert.ok(plan.modified.has("t1") && K.serialize(plan.modified.get("t1")).includes('(net "/sub/IN")'), "the track of the renamed net follows");
});
test("update PCB: delete unused footprints, and a library footprint is added below the board", () => {
  const doc = K.parseDoc(PCB, "kicad_pcb");
  const mod = K.parse('(footprint "R_0603_1608Metric" (version 20241229) (generator "pcbnew") (layer "F.Cu") (property "Reference" "REF**" (at 0 -1.4 0) (layer "F.SilkS") (uuid "x1") (effects (font (size 1 1) (thickness 0.15)))) (property "Value" "R_0603" (at 0 1.4 0) (layer "F.Fab") (uuid "x2") (effects (font (size 1 1) (thickness 0.15)))) (attr smd) (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "x3")) (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "x4")))');
  let n = 0;
  const plan = N.planUpdate(doc, nl, { updateFields: true, deleteUnused: true, footprintFor: (fpid) => N.footprintFromLibrary(mod, fpid, () => "new-" + (++n)), newUuid: () => "new-" + (++n) });
  const text = plan.report.map((r) => r.text).join("\n");
  assert.ok(text.includes("Remove unused footprint R9."), text); assert.deepStrictEqual(plan.removed, ["f9"]);
  assert.ok(text.includes("Add R3 (footprint 'Resistor_SMD:R_0603_1608Metric')."), text);
  assert.strictEqual(plan.added.length, 1);
  const a = K.serialize(plan.added[0]);
  assert.ok(a.startsWith('(footprint "Resistor_SMD:R_0603_1608Metric"') && a.includes('(property "Reference" "R3"') && a.includes('(property "Value" "1k"') && a.includes(`(path "/${U_SHEET}/bbbbbbbb-0000-0000-0000-000000000003")`), a.slice(0, 500));
  assert.ok(a.includes('(net "/sub/IN")') && a.includes('(net "/sub/LOCAL")') && !a.includes('"x3"'), "pads get their nets and fresh uuids");
  assert.ok(K.atOf(plan.added[0])[1] > 20, "placed below the board");
  assert.ok(K.addItem(K.parseDoc(PCB, "kicad_pcb"), plan.added[0]), "the new footprint is a board item");
});
test("schematic parity: missing and extra footprints, value and pad net mismatches", () => {
  const doc = K.parseDoc(PCB, "kicad_pcb");
  const issues = N.schematicParity(doc, nl), by = (code) => issues.filter((i) => i.code === code).map((i) => i.text);
  assert.deepStrictEqual(by("missing_footprint"), ["Missing footprint R3 (1k)"]);
  assert.deepStrictEqual(by("extra_footprint"), ["Extra footprint (R9)"]);
  assert.ok(by("footprint_symbol_mismatch").includes("Value (999) doesn't match symbol value (4k7)"));
  assert.deepStrictEqual(by("net_conflict"), ["R1 pad 2: Pad net (/OLD) doesn't match net given by schematic (/sub/IN)"]);
  assert.deepStrictEqual(issues.find((i) => i.code === "net_conflict").ids, ["f1"]);
});
test("DRC item table: KiCad's order, headings and default severities", () => {
  const D = K.DRC_ITEMS; assert.strictEqual(D[0][0], "Electrical"); assert.strictEqual(D[0][1], "");
  const get = (code) => D.find((i) => i[1] === code);
  assert.strictEqual(get("clearance")[2], "error"); assert.strictEqual(get("track_dangling")[2], "warning"); assert.strictEqual(get("missing_courtyard")[2], "ignore");
  assert.strictEqual(get("unconnected_items")[0], "Missing connection between items");
  assert.strictEqual(new Set(D.filter((i) => i[1]).map((i) => i[1])).size, D.filter((i) => i[1]).length, "codes are unique");
});

// ---------------------------------------------------------------- Board Setup validation (ValidateDesignRules, ValidateViaParameters)
test("validateDesignRules: KiCad's ranges and message, in the editor's units", () => {
  assert.deepStrictEqual(B.validateDesignRules({ min_clearance: 0.2, max_error: 0.005, min_resolved_spokes: 2 }), []);
  const e = B.validateDesignRules({ min_clearance: -5 });
  assert.strictEqual(e.length, 1); assert.strictEqual(e[0].setting, "min_clearance");
  assert.strictEqual(e[0].message, "Value must be between 0 mm and 25 mm.");
  assert.strictEqual(B.validateDesignRules({ min_copper_edge_clearance: -0.02 })[0].message, "Value must be between -0.01 mm and 25 mm.");
  assert.strictEqual(B.validateDesignRules({ max_error: 0.5 }, "mil")[0].message, "Value must be between 0.04 mils and 3.94 mils.");
  assert.strictEqual(B.validateDesignRules({ min_resolved_spokes: 100 })[0].message, "Value must be between 0 and 99.");
  assert.strictEqual(B.validateDesignRules({}, "mm", { pasteRatio: 1.5 })[0].setting, "solder_paste_margin_ratio");
  assert.strictEqual(B.validateDesignRules({}, "mm", { maskExpansion: 30 })[0].setting, "solder_mask_expansion");
});
test("designRuleWarnings: a minimum via diameter under drill + 2 x annulus has no effect", () => {
  assert.deepStrictEqual(B.designRuleWarnings({ min_via_diameter: 0.5, min_through_hole_diameter: 0.3, min_via_annular_width: 0.1 }), []);
  const w = B.designRuleWarnings({ min_via_diameter: 0.4, min_through_hole_diameter: 0.3, min_via_annular_width: 0.1 });
  assert.strictEqual(w.length, 1); assert.match(w[0].message, /effective minimum via diameter is 0.5 mm/);
});
test("validateViaParameters: KiCad's messages for a Pre-defined Sizes via row", () => {
  assert.strictEqual(B.validateViaParameters(0.6, 0.3), null);
  assert.strictEqual(B.validateViaParameters(0.6, NaN).message, "No via hole size defined.");
  assert.strictEqual(B.validateViaParameters(NaN, 0.3).message, "No via diameter defined.");
  assert.strictEqual(B.validateViaParameters(0, 0.3).message, "Via diameter is too small.");
  assert.deepStrictEqual(B.validateViaParameters(0.3, 0.3), { message: "Via hole size must be smaller than via diameter", field: "drill" });
});

// ---------------------------------------------------------------- Physical Stackup, edited
const STACK_SETUP = `(setup (stackup (layer "F.SilkS" (type "Top Silk Screen")) (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
  (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
  (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)) (layer "B.SilkS" (type "Bottom Silk Screen"))
  (copper_finish "None") (dielectric_constraints no)) (pad_to_mask_clearance 0))`;
test("stackup: read, a dielectric sub-layer added, written back with addsublayer", () => {
  const setup = B.boardHeader(`(kicad_pcb (version 20240108) (generator "t") ${STACK_SETUP})`).setup;
  const L = B.stackupLayers(setup);
  assert.strictEqual(L.length, 7); assert.strictEqual(B.stackupLayersThickness(L), 1.6);
  const d = L.find((l) => l.name === "dielectric 1");
  d.subs.push({ thickness: 0.1, material: "FR4", epsilonR: 4.5, lossTangent: 0.02 });
  const text = B.stackupText(L, B.boardFinish(setup), true);
  assert.match(text, /\(layer "dielectric 1" \(type "core"\) \(thickness 1\.51\) \(material "FR4"\) \(epsilon_r 4\.5\) \(loss_tangent 0\.02\) addsublayer \(thickness 0\.1\)/);
  assert.match(text, /\(dielectric_constraints yes\)/);
  const back = B.stackupLayers(B.setupWithStackup(setup, text));
  assert.strictEqual(back.find((l) => l.name === "dielectric 1").subs.length, 1);
  assert.strictEqual(B.stackupLayersThickness(back), 1.7);
});
test("adjustDielectrics: unlocked dielectrics take the rest; all locked is KiCad's message", () => {
  const setup = B.boardHeader(`(kicad_pcb (version 20240108) (generator "t") ${STACK_SETUP})`).setup;
  const L = B.stackupLayers(setup);
  assert.strictEqual(B.stackupFixedThickness(L), 0.09);
  assert.strictEqual(B.adjustDielectrics(L, 1.0), null);
  assert.strictEqual(L.find((l) => l.name === "dielectric 1").thickness, 0.91);
  L.find((l) => l.name === "dielectric 1").locked = true;
  assert.strictEqual(B.adjustDielectrics(L, 1.6), "All dielectric  thickness layers are locked");
});

// ---------------------------------------------------------------- Drill Chart (drill_symbol_profile)
test("drill profile: the default writes nothing; a change writes formatDrillSymbolProfile", () => {
  const setup = B.boardHeader(`(kicad_pcb (version 20240108) (generator "t") (setup (pad_to_mask_clearance 0)))`).setup;
  const p = B.drillProfile(setup);
  assert.deepStrictEqual(p, B.DRILL_PROFILE_DEFAULT);
  assert.ok(!/drill_symbol_profile/.test(B.sectionText(B.editSetup(setup, { drillProfile: p }))));
  const edited = B.sectionText(B.editSetup(setup, { drillProfile: { ...p, groupBy: ["size", "plating"], size: 2 } }));
  assert.match(edited, /\(drill_symbol_profile \(group_by size plating\) \(default_marks shapes_then_letters\) \(size 2\) \(width 0\.15\) \(freeze_assignments yes\)\)/);
  assert.deepStrictEqual(B.drillProfile(B.boardHeader(`(kicad_pcb (version 1) ${edited})`).setup).groupBy, ["size", "plating"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
