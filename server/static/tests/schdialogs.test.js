// schdialogs.test.js — the pure logic behind the schematic dialogs (Page Settings, Find and Replace, Symbol Fields
// Table / BOM, groups, grid overrides, ERC severities), under node.  Run: node server/static/tests/schdialogs.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "dialogs", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("logic.ts"), R = load("erc-rules.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const sym = (id, ref, value, fp, at, extra) => `(symbol (lib_id "Device:R") (at ${at} 0) (unit 1) ${extra || ""} (uuid "${id}")
    (property "Reference" "${ref}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "${fp}" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "${id}-p1")))`;
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4")
  (title_block (title "Old") (date "2020-01-01") (rev "1") (company "ACME") (comment 2 "second"))
  (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))
  ${sym("s1", "R1", "10k", "Resistor_SMD:R_0603", "25.4 100.33")}
  ${sym("s2", "R2", "10k", "Resistor_SMD:R_0603", "35.56 100.33")}
  ${sym("s3", "R3", "4k7", "Resistor_SMD:R_0603", "45.72 100.33")}
  ${sym("s4", "R10", "10k", "Resistor_SMD:R_0603", "55.88 100.33", "(dnp yes)")}
  (label "VPP_ON" (at 50 50 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
  (global_label "vpp_on_b" (shape input) (at 60 50 0) (effects (font (size 1.27 1.27))) (uuid "l2"))
  (text "note about VPP" (at 70 70 0) (effects (font (size 1.27 1.27))) (uuid "t1"))
  (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "w1")))`;
console.log("schematic dialogs logic under node");
const fresh = () => K.parseDoc(SHEET);

test("page settings: paper and title block s-expressions as KiCad writes them", () => {
  assert.strictEqual(L.paperSexpr({ paper: "A3", portrait: false, width: 420, height: 297 }), '(paper "A3")');
  assert.strictEqual(L.paperSexpr({ paper: "A4", portrait: true, width: 210, height: 297 }), '(paper "A4" portrait)');
  assert.strictEqual(L.paperSexpr({ paper: "User", portrait: false, width: 400, height: 250.5 }), '(paper "User" 400 250.5)');
  const tb = L.titleBlockSexpr({ title: 'A "quoted" title', date: "2026-11-11", rev: "", company: "", comments: ["", "", "third"] });
  assert.ok(/\(title "A \\"quoted\\" title"\)/.test(tb), tb); assert.ok(/\(date "2026-11-11"\)/.test(tb)); assert.ok(/\(comment 3 "third"\)/.test(tb), tb);
  assert.ok(!/\(rev /.test(tb) && !/comment 1/.test(tb), "empty entries are not written: " + tb);
});
test("page settings: the document carries them and a doc-props change applies them", () => {
  const doc = fresh(), p = L.pageSettingsOf(doc);
  assert.strictEqual(p.paper, "A4"); assert.strictEqual(p.title, "Old"); assert.strictEqual(p.company, "ACME"); assert.strictEqual(p.comments[1], "second");
  p.paper = "A3"; p.title = "New"; p.comments[0] = "c1";
  const ch = L.pageSettingsChange(p); assert.ok(L.isDocPropsChange(ch)); assert.ok(!L.isDocPropsChange({ id: "s1", kind: "MODIFIED" }));
  K.applyDocProps(doc, ch.docProps);
  assert.strictEqual(doc.paper, "A3"); assert.ok(Math.abs(doc.page[0] - 420) < 0.1 && Math.abs(doc.page[1] - 297) < 0.1, doc.page.join());
  assert.strictEqual(doc.titleBlock.title, "New"); assert.strictEqual(doc.titleBlock.comment1, "c1"); assert.strictEqual(doc.titleBlock.comment2, "second");
  assert.strictEqual(doc.items.size, fresh().items.size, "no design item is touched");
});
test("find: plain, case, whole word, regex", () => {
  const doc = fresh();
  const ids = (o) => L.findHits(doc, o).map((h) => h.id + (h.field ? ":" + h.field : "")).sort();
  assert.deepStrictEqual(ids({ query: "vpp" }), ["l1", "l2", "t1"]);
  assert.deepStrictEqual(ids({ query: "VPP", matchCase: true }), ["l1", "t1"]);
  assert.deepStrictEqual(ids({ query: "VPP", wholeWord: true }), [], "KiCad's whole-word match is the whole text");
  assert.deepStrictEqual(ids({ query: "vpp_on", wholeWord: true }), ["l1"]); assert.deepStrictEqual(ids({ query: "vpp*" }), ["l1", "l2"], "wildcards");
  assert.deepStrictEqual(ids({ query: "^R1\\d*$", regex: true }), ["s1:Reference", "s4:Reference"]);
  assert.deepStrictEqual(ids({ query: "10k" }), ["s1:Value", "s2:Value", "s4:Value"]);
  assert.deepStrictEqual(ids({ query: "0603" }), [], "hidden fields are skipped by default");
  assert.strictEqual(ids({ query: "0603", hiddenFields: true }).length, 4);
  assert.strictEqual(L.matcher({ query: "(", regex: true }), null, "a broken regular expression matches nothing");
  assert.deepStrictEqual(L.findHits(doc, { query: "10k", selectionOnly: true }, new Set(["s2"])).map((h) => h.id), ["s2"], "selection only");
});
test("replace: text, value field; references only on request", () => {
  const doc = fresh(), o = { query: "VPP_ON", matchCase: true };
  assert.strictEqual(L.replaceText("xVPP_ONy VPP_ON", o, "EN"), "xENy EN"); assert.strictEqual(L.replaceText("nothing", o, "EN"), null);
  const hit = L.findHits(doc, o)[0], node = K.cloneNode(doc.items.get("l1").node);
  assert.ok(L.replaceInNode(node, hit, o, "VPP_EN")); assert.strictEqual(node[1], "VPP_EN");
  const vo = { query: "10k" }, vh = L.findHits(doc, vo).find((h) => h.id === "s1"), sn = K.cloneNode(doc.items.get("s1").node);
  assert.ok(L.replaceInNode(sn, vh, vo, "12k")); assert.ok(/"Value","12k"/.test(JSON.stringify(sn)));
  const ro = { query: "R1" }, rh = L.findHits(doc, ro).find((h) => h.id === "s1" && h.field === "Reference");
  assert.strictEqual(rh.replaceable, false, "references are not replaced unless asked");
  assert.strictEqual(L.findHits(doc, { query: "R1", replaceRefs: true }).find((h) => h.id === "s1" && h.field === "Reference").replaceable, true);
});
test("BOM: reference sorting and ranges", () => {
  assert.deepStrictEqual(["R10", "R2", "C1", "R1"].sort(L.refCmp), ["C1", "R1", "R2", "R10"]);
  assert.strictEqual(L.refShorthand(["R3", "R1", "R2", "R10"], ",", "-"), "R1-R3,R10");
  assert.strictEqual(L.refShorthand(["R1", "R2", "R4"], ", ", ""), "R1, R2, R4");
});
test("BOM: grouping by value, quantity, DNP exclusion, CSV export", () => {
  const rows = L.symbolRows(fresh()); assert.strictEqual(rows.length, 4);
  const preset = JSON.parse(JSON.stringify(L.BOM_PRESETS.find((p) => p.name === "Grouped By Value")));
  const g = L.bomRows(rows, preset, ",", "-");
  const by = (v) => g.find((r) => r.cells.Value === v && !r.rows.some((x) => x.dnp));
  assert.strictEqual(by("10k").cells.Reference, "R1,R2"); assert.strictEqual(by("10k").cells[L.QTY], "2"); assert.strictEqual(by("4k7").cells[L.QTY], "1");
  preset.exclude_dnp = true; assert.ok(!L.bomRows(rows, preset).some((r) => r.rows.some((x) => x.ref === "R10")), "DNP symbols leave the BOM");
  preset.group_symbols = false; assert.strictEqual(L.bomRows(rows, preset).length, 3);
  preset.group_symbols = true; preset.fields_ordered = [{ name: "Reference", label: "Refs", show: true, group_by: false }, { name: "Value", label: "Value", show: true, group_by: true }, { name: L.QTY, label: "Qty", show: true, group_by: false }];
  const csv = L.bomExport(rows, preset, L.BOM_FMT_PRESETS.find((f) => f.name === "CSV")).trim().split("\n");
  assert.strictEqual(csv[0], '"Refs","Value","Qty"'); assert.ok(csv.includes('"R1,R2","10k","2"'), csv.join(" / ")); assert.ok(csv.includes('"R3","4k7","1"'));
});
test("groups: s-expression, membership, expansion to the outermost group", () => {
  const sx = L.groupSexpr("amp", "g1", ["s2", "s1", "s1"]); assert.strictEqual(sx, '(group "amp" (uuid "g1") (members "s1" "s2"))');
  const doc = fresh(); const add = (s) => { const n = K.parseSexpr ? K.parseSexpr(s) : null; return n; };
  const d2 = K.parseDoc(SHEET.replace(/\)\s*$/, `\n  ${sx}\n  ${L.groupSexpr("", "g2", ["g1", "s3"])})`));
  const g1 = d2.items.get("g1"); assert.ok(g1 && g1.kind === "group", "a schematic group is a document item");
  assert.deepStrictEqual(L.groupMembers(g1.node), ["s1", "s2"]); assert.strictEqual(L.groupOf(d2, "s1").id, "g1"); assert.strictEqual(L.topGroupOf(d2, "s1").id, "g2");
  assert.deepStrictEqual([...L.expandGroups(d2, ["s1"])].sort(), ["g1", "g2", "s1", "s2", "s3"]);
  assert.deepStrictEqual([...L.expandGroups(d2, ["s1"], "g2")].sort(), ["g1", "s1", "s2"], "inside an entered group its children select on their own");
  assert.deepStrictEqual([...L.expandGroups(d2, ["s4"])], ["s4"]); assert.strictEqual(L.groupOf(doc, "s1"), null); void add;
});
test("grid overrides: wires / text / graphics snap to their own grid only when enabled", () => {
  const o = Object.assign({}, L.SCH_GRID_OVERRIDES);
  assert.strictEqual(L.schGridClassOfKind("wire"), "wires"); assert.strictEqual(L.schGridClassOfKind("symbol"), "connected"); assert.strictEqual(L.schGridClassOfKind("text"), "text");
  assert.strictEqual(L.gridPitchFor("wires", o, 0.635), 1.27); assert.ok(Math.abs(L.gridPitchFor("text", o, 1.27) - 0.254) < 1e-9);
  assert.strictEqual(L.gridPitchFor("graphics", o, 0.635), 0.635, "graphics override is off by default");
  o.enabled = false; assert.strictEqual(L.gridPitchFor("wires", o, 0.635), 0.635); assert.strictEqual(L.gridPitchFor(null, L.SCH_GRID_OVERRIDES, 2.54), 2.54);
});
test("ERC severities from the project file: ignore drops, warning / error relabel", () => {
  const m = [{ code: "pin_not_connected", severity: "error" }, { code: "label_dangling", severity: "error" }, { code: "lib_symbol_issues", severity: "warning" }];
  const out = R.applySeverities(m, { pin_not_connected: "ignore", label_dangling: "warning" });
  assert.deepStrictEqual(out.map((x) => x.code + ":" + x.severity), ["label_dangling:warning", "lib_symbol_issues:warning"]);
  assert.strictEqual(R.applySeverities(m, null).length, 3); assert.strictEqual(R.defaultSeverity("pin_not_connected"), "error");
  assert.strictEqual(R.DEFAULT_PIN_MAP.length, 12); assert.strictEqual(R.PIN_TYPE_NAMES.length, 12);
});
test("dialog widgets are exported", () => {
  require(path.join(__dirname, "..", "props.js")); require(path.join(__dirname, "..", "kicad-dialogs.js"));
  for (const k of ["open", "notebook", "treebook", "grid", "staticBox"]) assert.strictEqual(typeof globalThis.KDialogs[k], "function", k);
});
test("ERC Previous / Next Marker (RC_TREE_MODEL::PrevMarker / NextMarker): first / last with none picked, stops at the ends", () => {
  const rows = [0, 2, 5];
  assert.strictEqual(R.stepMarker(rows, -1, 1), 0); assert.strictEqual(R.stepMarker(rows, -1, -1), 5);
  assert.strictEqual(R.stepMarker(rows, 0, 1), 2); assert.strictEqual(R.stepMarker(rows, 2, 1), 5); assert.strictEqual(R.stepMarker(rows, 5, 1), null);
  assert.strictEqual(R.stepMarker(rows, 2, -1), 0); assert.strictEqual(R.stepMarker(rows, 0, -1), null);
  assert.strictEqual(R.stepMarker([], -1, 1), null);
});

console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
