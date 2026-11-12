// fpedit-dialogs.test.js — the logic behind the Footprint Editor's dialogs and pad commands, under node:
// Footprint Properties (web/tools/pcb-tools/fp-props.ts), Push Pad Properties, Edit Pad as Graphic Shapes / Finish Pad
// Edit, the Pad Table, interactive Renumber Pads (fp-pads.ts) and the Footprint Checker (fp-check.ts).
// Run: node server/static/tests/fpedit-dialogs.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, FD = K.footprintDoc;
const FPP = P.fpProps, PADS = P.fpPads, CHK = P.fpCheck, IU = 1e6;

const FP = `(footprint "R_0603"
	(version 20241229)
	(generator "pcbnew")
	(layer "F.Cu")
	(descr "Resistor")
	(property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (uuid "11111111-1111-4111-8111-111111111111") (effects (font (size 1 1) (thickness 0.15))))
	(property "Value" "R_0603" (at 0 1.43 0) (layer "F.Fab") (uuid "22222222-2222-4222-8222-222222222222") (effects (font (size 1 1) (thickness 0.15))))
	(attr smd)
	(fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "33333333-3333-4333-8333-333333333333"))
	(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "44444444-4444-4444-8444-444444444444"))
	(pad "2" smd rect (at 0.825 0 90) (size 0.6 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "55555555-5555-4555-8555-555555555555"))
	(pad "3" smd roundrect (at 2.825 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "66666666-6666-4666-8666-666666666666"))
	(model "\${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`;
const fpDoc = (t = FP) => K.parseDoc(t, "footprint");
const apply = (doc, changes) => { for (const c of changes) K.applyChange(doc, c, IU); };
const pads = (doc) => [...doc.items.values()].filter((i) => i.kind === "pad");
const pad = (doc, n) => pads(doc).find((i) => i.node[1] === n);

test("Footprint Properties: reads the header and the fields as the dialog shows them", () => {
  const m = FPP.readFpProps(fpDoc());
  assert.equal(m.name, "R_0603"); assert.equal(m.descr, "Resistor"); assert.equal(m.type, "smd");
  assert.deepEqual(m.fields.map((f) => f.name), ["Reference", "Value"]);
  assert.equal(m.fields[0].layer, "F.SilkS"); assert.equal(m.fields[0].thick, 0.15);
  assert.ok(isNaN(m.clearance)); assert.equal(m.zoneConnect, ""); assert.equal(m.models.length, 1); assert.equal(m.models[0].scale[0], 1);
  assert.equal(m.customStackup, false); assert.equal(m.copperCount, 2);
});

test("Footprint Properties: unchanged dialog makes no change; edits touch only what changed", () => {
  const doc = fpDoc();
  assert.deepEqual(FPP.fpPropsChanges(doc, FPP.readFpProps(doc)), []);
  const m = FPP.readFpProps(doc);
  m.tags = "resistor 0603"; m.clearance = 0.2; m.zoneConnect = "2"; m.dnp = true; m.privateLayers = ["User.2", "F.SilkS"]; m.netTieGroups = ["1, 2"];
  m.fields[1].value = "10k"; m.fields.push(FPP.newFieldRow(m, "F.Fab", () => ({ w: 1, h: 1, thick: 0.15, italic: false })));
  m.models[0].opacity = 0.5;
  const ch = FPP.fpPropsChanges(doc, m);
  const h = ch.find((c) => c.id === "footprint"); assert.ok(h);
  assert.match(h.sexpr, /\(tags "resistor 0603"\)/); assert.match(h.sexpr, /\(clearance 0\.2\)/); assert.match(h.sexpr, /\(zone_connect 2\)/);
  assert.match(h.sexpr, /\(attr smd dnp\)/); assert.match(h.sexpr, /\(private_layers "F\.SilkS" "User\.2"\)/); assert.match(h.sexpr, /\(net_tie_pad_groups "1, 2"\)/);
  assert.match(h.sexpr, /\(opacity 0\.5\)/);
  assert.equal(ch.filter((c) => c.kind === "ADDED").length, 1, "the new field is added");
  assert.ok(ch.some((c) => c.kind === "MODIFIED" && c.id === "22222222-2222-4222-8222-222222222222"));
  apply(doc, ch);
  const out = FD.serializeFootprintDoc(doc);
  assert.match(out, /\(property "Field2" ""/); assert.match(out, /\(property "Value" "10k"/);
  // the writer's order: tags before the fields, clearance / zone_connect / attr after them, the model last
  assert.ok(out.indexOf("(tags") < out.indexOf('(property "Reference"')); assert.ok(out.indexOf("(clearance") > out.indexOf('(property "Field2"'));
  assert.ok(out.indexOf("(model") > out.indexOf('(pad "3"'));
  assert.match(out, /\(version 20241229\)/, "the file version is never bumped");
});

test("Footprint Properties: Validate() messages", () => {
  const doc = fpDoc(); const m = FPP.readFpProps(doc);
  m.name = ""; assert.equal(FPP.validateFpProps(doc, m).msg, "Footprint must have a name.");
  m.name = "a/b"; assert.match(FPP.validateFpProps(doc, m).msg, /^Footprint name may not contain/);
  m.name = "R_0603"; m.fields[0].w = 0; assert.match(FPP.validateFpProps(doc, m).msg, /^The text width must be between/);
  m.fields[0].w = 1; m.fields[0].thick = 0.6; const e = FPP.validateFpProps(doc, m); assert.equal(e.msg, "The text thickness is too large for the text size.\nIt will be clamped."); e.fix(); assert.equal(m.fields[0].thick, 0.25);
  m.jumperGroups = ["1, 9"]; assert.equal(FPP.validateFpProps(doc, m).msg, "Pad '9' in jumper pad group 1 does not exist in this footprint.");
  m.jumperGroups = []; m.customStackup = true; m.copperCount = 2; assert.equal(FPP.validateFpProps(doc, m), null);
  assert.equal(FPP.validateFpProps(doc, m, { libHas: (n) => n === "R_0805" }), null);
  m.name = "R_0805"; assert.equal(FPP.validateFpProps(doc, m, { libHas: (n) => n === "R_0805" }).overwrite, "R_0805");
  const p = FPP.parsePaste("-0.1 mm - 5%", (t) => parseFloat(t)); assert.equal(p.offset, -0.1); assert.equal(p.ratio, -0.05);
  assert.equal(FPP.parsePaste("5%", parseFloat).ratio, 0.05); assert.ok(isNaN(FPP.parsePaste("", parseFloat).offset));
  assert.equal(FPP.formatPaste(-0.1, -0.05, (v) => v + " mm"), "-0.1 mm - 5%");
});

test("Push Pad Properties: the filters, and ImportSettingsFrom keeping number, position and uuid", () => {
  const doc = fpDoc(); const src = pad(doc, "1");
  let ch = PADS.pushPadChanges(doc, src.id, { shape: false, size: false, orient: false, layers: false, type: false });
  assert.equal(ch.length, 2);
  ch = PADS.pushPadChanges(doc, src.id, { shape: true, size: false, orient: false, layers: false, type: false });
  assert.equal(ch.length, 1, "the rect pad has another shape");
  ch = PADS.pushPadChanges(doc, src.id, { shape: false, size: false, orient: true, layers: false, type: false });
  assert.equal(ch.length, 1, "pad 2 is rotated");
  apply(doc, PADS.pushPadChanges(doc, src.id, { shape: false, size: false, orient: false, layers: false, type: false }));
  const p2 = pad(doc, "2").node;
  assert.equal(p2[3], "roundrect"); assert.deepEqual(K.kid(p2, "at").slice(1), [0.825, 0]); assert.equal(K.kid(p2, "uuid")[1], "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(K.kid(p2, "size").slice(1), [0.8, 0.95]);
});

test("Edit Pad as Graphic Shapes, then Finish Pad Edit puts the shapes back as primitives", () => {
  const T = FP.replace(`(pad "3" smd roundrect (at 2.825 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "66666666-6666-4666-8666-666666666666"))`,
    `(pad "3" smd custom (at 3 0 90) (size 0.5 0.5) (layers "F.Cu" "F.Mask" "F.Paste") (options (clearance outline) (anchor rect)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0) (fill yes))) (uuid "66666666-6666-4666-8666-666666666666"))`);
  const doc = fpDoc(T); const p3 = pad(doc, "3");
  const ch = PADS.explodePadChanges(doc, p3.id); apply(doc, ch);
  assert.equal(pad(doc, "3").node[3], "rect"); assert.equal(K.kid(pad(doc, "3").node, "primitives"), null);
  const poly = [...doc.items.values()].find((i) => i.kind === "gr_poly"); assert.ok(poly);
  assert.equal(K.kid(poly.node, "layer")[1], "F.Cu");
  // rotated 90° about the pad and moved to it: (1,0) -> (3, -1)
  const pts = K.kid(poly.node, "pts").slice(1).map((xy) => [xy[1], xy[2]]); assert.deepEqual(pts[1], [3, -1]);
  const r = PADS.recombinePadChanges(doc, p3.id); assert.deepEqual(r.merged, [poly.id]);
  apply(doc, r.changes);
  const back = pad(doc, "3").node; assert.equal(back[3], "custom"); assert.equal(K.kid(K.kid(back, "options"), "anchor")[1], "rect");
  const prim = K.kid(K.kid(back, "primitives"), "gr_poly"); assert.deepEqual(K.kid(prim, "pts").slice(1).map((xy) => [xy[1], xy[2]]), [[0, 0], [1, 0], [1, 1]]);
  assert.equal([...doc.items.values()].filter((i) => i.kind === "gr_poly").length, 0);
});

test("Pad Table: rows, type / shape setters, one 'Edit Pads' change set, CSV round trip", () => {
  const doc = fpDoc(); const rows = PADS.padTableRows(doc, P.pad.strNumCmp);
  assert.deepEqual(rows.map((r) => [r.number, r.type, r.shape]), [["1", "smd", "roundrect"], ["2", "smd", "rect"], ["3", "smd", "roundrect"]]);
  rows[0].x = -1; rows[1].type = "thru_hole"; rows[1].dx = 0.4; rows[2].shape = "circle"; rows[2].type = "aperture";
  const ch = PADS.padTableChanges(doc, rows, () => PADS.importPadSettings(["pad", "", "smd", "rect", ["at", 0, 0], ["size", 1, 1], ["layers", "F.Cu"]], P.pad.defaultPad("smd")));
  assert.equal(ch.length, 3); apply(doc, ch);
  assert.deepEqual(K.kid(pad(doc, "1").node, "at").slice(1, 3), [-1, 0]);
  assert.equal(pad(doc, "2").node[2], "thru_hole"); assert.deepEqual(K.kid(pad(doc, "2").node, "drill"), ["drill", 0.4]);
  const p3 = pads(doc).find((p) => p.id === "66666666-6666-4666-8666-666666666666").node;
  assert.equal(p3[3], "circle"); assert.equal(p3[1], "", "an aperture pad has no number"); assert.deepEqual(K.kid(p3, "layers").slice(1), ["F.Paste"]); assert.equal(K.kid(p3, "roundrect_rratio"), null);
  const csv = PADS.toCsv([["Number", "Type"], ["1", "a,b"]]); assert.equal(csv, 'Number,Type\n1,"a,b"\n');
  assert.deepEqual(PADS.parseCsv(csv), [["Number", "Type"], ["1", "a,b"]]);
  assert.deepEqual(PADS.parseCsv("Number\tPos X\n1\t2\n"), [["Number", "Pos X"], ["1", "2"]]);
  assert.equal(PADS.colForLabel("pos x"), "x"); assert.equal(PADS.colForLabel("X Position"), "x"); assert.equal(PADS.colForLabel("nope"), null);
  assert.deepEqual(PADS.padNumberSummary(["1", "2", "3", "5", "A1", "2"], P.pad.strNumCmp), { summary: "1-3, 5, A1", duplicates: "2" });
});

test("Renumber Pads: click order, a second click gives the number back, drags sample the path", () => {
  const doc = fpDoc(); const st = PADS.enumBegin("P", 1, 1);
  assert.equal(PADS.enumPopup(st), "Click on pad P1\nPress <esc> to cancel all; double-click to finish");
  assert.equal(PADS.padsAt(doc, [2.825, 0]).length, 1);
  PADS.enumPick(st, doc, PADS.padsAt(doc, [2.825, 0]), true);
  PADS.enumPick(st, doc, PADS.padsAt(doc, [-0.825, 0]), true);
  assert.equal(PADS.enumPopup(st).split("\n")[0], "Click on pad P3");
  PADS.enumPick(st, doc, PADS.padsAt(doc, [-0.825, 0]), true);   // un-number pad 1: P2 is stored for the next pad
  assert.equal(PADS.enumNextValue(st), 2);
  PADS.enumPick(st, doc, PADS.padsAlong(doc, [-0.825, 0], [0.825, 0]), false);
  const ch = PADS.enumChanges(doc, st); apply(doc, ch);
  assert.deepEqual(pads(doc).map((p) => p.node[1]).sort(), ["P1", "P2", "P3"]);
  assert.equal(pad(doc, "P1").id, "66666666-6666-4666-8666-666666666666");
});

test("Footprint Checker: missing courtyard (warning), shorting pads, TH pad without a hole, net-tie groups, clipped silk", () => {
  let doc = fpDoc(); let m = CHK.checkFootprint(doc);
  assert.deepEqual(m.map((x) => [x.severity, x.title]), [["warning", "Footprint has no courtyard defined"]]);
  const T = FP.replace(`(at 2.825 0)`, `(at 0 0)`).replace(`(attr smd)`, `(attr smd)\n\t(net_tie_pad_groups "1, 7")`)
    .replace(`(fp_line (start -0.8 -0.4)`, `(fp_line (start -2 0) (end 2 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "77777777-7777-4777-8777-777777777777"))\n\t(fp_line (start -0.8 -0.4)`)
    .replace(`(pad "2" smd rect`, `(pad "2" thru_hole rect`);
  doc = fpDoc(T); m = CHK.checkFootprint(doc);
  const titles = m.map((x) => x.title + (x.detail ? " " + x.detail : ""));
  assert.ok(titles.includes("Items shorting two nets"), titles.join("|"));
  assert.ok(titles.includes("Through hole pad has no hole"));
  assert.ok(titles.includes("Footprint is not valid (net-tie pad group contains unknown pad number 7)"));
  assert.ok(titles.includes("Silkscreen clipped by solder mask"));
  assert.deepEqual(CHK.checkPad(["pad", "1", "smd", "rect", ["at", 0, 0], ["size", 1, 1], ["drill", 0.3], ["layers", "F.Cu", "B.Cu", "B.Mask"]]).map((r) => r.msg),
    ["SMD pad has a hole", "SMD pad has more than one copper layer", "SMD pad has copper and mask layers on different sides of the board"]);
});

test("Footprint Properties round trip on real library footprints: an unchanged dialog changes nothing", () => {
  const dir = path.join(__dirname, "..", "..", "..", "demos", "stickhub", "footprints.pretty");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".kicad_mod")).slice(0, 25)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8"); const doc = fpDoc(text);
    assert.deepEqual(FPP.fpPropsChanges(doc, FPP.readFpProps(doc)), [], f);
    CHK.checkFootprint(doc);   // runs on every real footprint
  }
});

test("Footprint users: filters, the footprint field (inherited), pin maps, derived symbols, match types", () => {
  const U = P.fpUsers;
  const lib = K.parse(`(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
    (symbol "R" (property "Reference" "R") (property "Value" "R") (property "Footprint" "")
      (property "ki_fp_filters" "R_*")
      (symbol "R_0_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "R_Small" (extends "R") (property "Reference" "R") (property "Footprint" "Resistor_SMD:R_0603_1608Metric"))
    (symbol "C" (property "Reference" "C") (property "Footprint" "Other:R_0603_1608Metric") (property "ki_fp_filters" "C_*"))
    (symbol "U" (property "Reference" "U") (property "Footprint" "")
      (associated_footprints (footprint "R_0603_1608Metric" (map "Two pin")))
      (symbol "U_0_1" (pin input line (at 0 0 0) (length 1) (name "A") (number "1")))))`);
  const libs = [{ nickname: "Device", tree: lib }];
  const r = U.footprintUsers(libs, { lib: "Resistor_SMD", name: "R_0603_1608Metric" });
  assert.deepEqual(r.matches.map((m) => [m.symbol, m.filter, m.field, m.pinMaps.join(","), m.derived, m.pins]),
    [["R", "R_*", false, "", false, 2], ["R_Small", "R_*", true, "", true, 2], ["U", "", false, "Two pin", false, 1]]);
  assert.equal(U.usersStatus(r.matches.length, r.limited), "This footprint is referenced by 3 symbols");
  // the C symbol names another library: no match; with no nickname on the footprint it does
  assert.ok(U.footprintUsers(libs, { lib: "", name: "R_0603_1608Metric" }).matches.some((m) => m.symbol === "C"));
  // match types switch independently; a symbol listed for one way still says the others
  const onlyField = U.footprintUsers(libs, { lib: "Resistor_SMD", name: "R_0603_1608Metric", filters: false, pinMaps: false });
  assert.deepEqual(onlyField.matches.map((m) => [m.symbol, m.filter]), [["R_Small", "R_*"]]);
  assert.equal(U.footprintUsers(libs, { lib: "Resistor_SMD", name: "R_0603_1608Metric", filters: false, field: false, pinMaps: false }).matches.length, 0);
  // a filter with a ':' includes the nickname; wildcards are anchored and case-insensitive
  assert.ok(U.filterMatches("resistor_smd:r_*", "Resistor_SMD", "R_0603")); assert.ok(!U.filterMatches("R_06", "X", "R_0603")); assert.ok(U.filterMatches("r_06??", "X", "R_0603"));
  const lim = U.footprintUsers(libs, { lib: "Resistor_SMD", name: "R_0603_1608Metric", max: 1 });
  assert.equal(lim.limited, true); assert.equal(U.usersStatus(lim.matches.length, lim.limited), "This footprint is referenced by more than 1 symbols");
});
