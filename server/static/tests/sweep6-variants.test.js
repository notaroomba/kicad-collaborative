// sweep6-variants.test.js — design variants as KiCad 10 reads and writes them (canvas/variant-model.ts):
//  - a board footprint's (variant …) is written as PCB_IO_KICAD_SEXPR writes it (flags only when they differ from the
//    footprint's, fields only when they differ from the field's text, fields by name, variants in name order);
//  - the view through a variant (DNP / BOM flags, field texts); …ForVariant getters;
//  - Toggle Attribute with a current variant writes the variant (ToggleFootprintAttribute; SCH_EDIT_TOOL);
//  - a symbol instance's (variant …): writer order, inverted in_bom / on_board / in_pos_files, dropped with no
//    differentials; rename / copy / delete across instances;
//  - the .kicad_pro registry (schematic.variants) and ValidateNewVariantName's messages;
//  - GetVariantNamesForUI (StrNumCmp) and ${VARIANT} / ${VARIANT_DESC} in the drawing-sheet variables.
// Run: node server/static/tests/sweep6-variants.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("design variants under node");

const esbuild = require("esbuild");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const VM = load("canvas/variant-model.ts");

const fpOf = (c) => { const n = K.parse(c.sexpr || c.itemSexpr); return n[0] === "footprint" ? n : K.kid(n, "footprint"); };
const FP = `(footprint "R:R_0603" (layer "F.Cu") (uuid "f1") (at 10 10)
  (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
  (property "Value" "10k" (at 0 1) (layer "F.Fab") (uuid "p2") (effects (font (size 1 1))))
  (attr smd)
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
  (embedded_fonts no))`;

test("a new footprint variant: AddVariant copies the flags; the writer keeps only differences, before (embedded_fonts)", () => {
  const fp = K.parse(FP);
  let n = VM.setFootprintVariant(fp, "Lite", { flags: { dnp: true } });
  assert.ok(K.serialize(n).includes(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (variant (name "Lite") (dnp yes)) (embedded_fonts no)`), K.serialize(n));
  n = VM.setFootprintVariant(n, "Lite", { fields: { Value: "4k7", Reference: "R1" } });
  assert.ok(K.serialize(n).includes(`(variant (name "Lite") (dnp yes) (field (name "Value") (value "4k7")))`), "a field equal to the footprint's is not written");
  n = VM.setFootprintVariant(n, "Full", { flags: { exclude_from_bom: true, exclude_from_pos_files: true } });
  const s = K.serialize(n);
  assert.ok(s.indexOf(`(variant (name "Full")`) < s.indexOf(`(variant (name "Lite")`), "variants in name order (case-insensitive map)");
  assert.ok(s.includes(`(variant (name "Full") (exclude_from_bom yes) (exclude_from_pos_files yes))`), s);
  // back to the footprint's own state: the variant stays (KiCad keeps the entry) with nothing differing
  n = VM.setFootprintVariant(n, "lite", { flags: { dnp: false } });
  assert.ok(K.serialize(n).includes(`(variant (name "Lite") (field (name "Value") (value "4k7")))`), "matched without case; name kept");
  assert.equal(K.serialize(fp), K.serialize(K.parse(FP)), "the input is not touched");
});

test("the view through a variant and the …ForVariant getters", () => {
  const fp = VM.setFootprintVariant(K.parse(FP), "Lite", { flags: { dnp: true }, fields: { Value: "4k7" } });
  assert.equal(VM.footprintViewForVariant(fp, ""), fp);
  assert.equal(VM.footprintViewForVariant(fp, "Other"), fp);
  const v = VM.footprintViewForVariant(fp, "Lite");
  assert.deepEqual(K.kid(v, "attr"), ["attr", "smd", "dnp"]);
  assert.equal(K.kids(v, "property")[1][2], "4k7");
  assert.equal(VM.footprintFieldForVariant(fp, "Lite", "Value"), "4k7");
  assert.equal(VM.footprintFieldForVariant(fp, "", "Value"), "10k");
  assert.deepEqual(VM.footprintFlagsForVariant(fp, "Lite"), { dnp: true, exclude_from_bom: false, exclude_from_sim: false, exclude_from_pos_files: false });
});

test("Toggle Attribute with a current variant writes the footprint's variant; one lacking the flag turns it on for all", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20250000) (layers (0 "F.Cu" signal)) ${FP} ${FP.replace(/"f1"/, '"f2"').replace('"R1"', '"R2"').replace("(attr smd)", "(attr smd exclude_from_bom)")})`, "pcb");
  const ids = Array.from(doc.items.values()).filter((i) => i.kind === "footprint").map((i) => i.id);
  const ch = P.footprintAttrChanges(doc, ids, "exclude_from_bom", "Lite");
  const nodes = ch.map(fpOf);
  assert.ok(K.serialize(nodes[0]).includes(`(variant (name "Lite") (exclude_from_bom yes))`), K.serialize(nodes[0]));
  assert.ok(K.serialize(nodes[1]).includes(`(variant (name "Lite"))`), "the second already had it: the variant holds no difference");
  assert.deepEqual(K.kid(nodes[0], "attr"), ["attr", "smd"], "the footprint's own flags stay");
  // without a variant: KiCad's new_state for all, written in the writer's token order
  const base = P.footprintAttrChanges(doc, ids, "exclude_from_bom", "").map(fpOf);
  assert.deepEqual(base.map((n) => K.kid(n, "attr")), [["attr", "smd", "exclude_from_bom"], ["attr", "smd", "exclude_from_bom"]]);
  const dnp = P.footprintAttrChanges(doc, [ids[1]], "dnp", "").map(fpOf);
  assert.deepEqual(K.kid(dnp[0], "attr"), ["attr", "smd", "exclude_from_bom", "dnp"]);
  const pos = P.footprintAttrChanges(doc, [ids[1]], "exclude_from_pos_files", "").map(fpOf);
  assert.deepEqual(K.kid(pos[0], "attr"), ["attr", "smd", "exclude_from_pos_files", "exclude_from_bom"]);
});

const SYM = `(symbol (lib_id "Device:R") (at 50 50 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
  (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 0 0))
  (instances (project "demo" (path "/root-uuid" (reference "R1") (unit 1)))))`;

test("a symbol instance's variant: writer order, inverted flags, dropped with no differentials", () => {
  const s0 = K.parse(SYM);
  let n = VM.setSymbolVariant(s0, "Lite", { flags: { dnp: true, excludedFromBOM: true } });
  assert.ok(K.serialize(n).includes(`(path "/root-uuid" (reference "R1") (unit 1) (variant (name "Lite") (dnp yes) (in_bom no)))`), K.serialize(n));
  n = VM.setSymbolVariant(n, "Lite", { fields: { Value: "4k7" } });
  assert.ok(K.serialize(n).includes(`(variant (name "Lite") (dnp yes) (in_bom no) (field (name "Value") (value "4k7")))`));
  assert.deepEqual(VM.symbolFlagsForVariant(n, "Lite"), { dnp: true, excludedFromSim: false, excludedFromBOM: true, excludedFromBoard: false, excludedFromPosFiles: false });
  const view = VM.symbolViewForVariant(n, "Lite");
  assert.deepEqual(K.kid(view, "dnp"), ["dnp", "yes"]); assert.deepEqual(K.kid(view, "in_bom"), ["in_bom", "no"]); assert.equal(K.kids(view, "property")[1][2], "4k7");
  // back to the symbol's own state: no differentials, no (variant …)
  n = VM.setSymbolVariant(K.parse(SYM), "Lite", { flags: { dnp: true } });
  n = VM.setSymbolVariant(n, "Lite", { flags: { dnp: false } });
  assert.equal(K.serialize(n), K.serialize(s0));
});

test("rename / copy / delete a variant across a symbol's instances", () => {
  let n = VM.setSymbolVariant(K.parse(SYM), "B", { flags: { dnp: true } });
  n = VM.renameSymbolVariants(n, "B", "A");
  assert.ok(K.serialize(n).includes(`(variant (name "A") (dnp yes))`));
  n = VM.renameSymbolVariants(n, "A", "A_copy", true);
  assert.ok(K.serialize(n).includes(`(variant (name "A") (dnp yes)) (variant (name "A_copy") (dnp yes))`), K.serialize(n));
  n = VM.renameSymbolVariants(n, "A", null);
  assert.ok(!K.serialize(n).includes(`(name "A")`) && K.serialize(n).includes(`(name "A_copy")`));
  const untouched = K.parse(SYM); assert.equal(VM.renameSymbolVariants(untouched, "X", "Y"), untouched, "no change: the same node");
});

test("Toggle Attribute in the schematic with a current variant writes the instance's variant", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "root-uuid") (paper "A4") (lib_symbols) ${SYM})`, "sch");
  const commits = [];
  const ctx = { doc, K, IU: 1e6, isSch: true, selection: new Set(["s1"]), selected: { id: "s1" }, viewOnly: false, commit(ch, label) { commits.push({ ch, label }); for (const c of ch) K.applyChange(doc, c, 1e6); }, toast() {}, setSelection() {}, setHighlight() {} };
  globalThis.CollabEditor = { currentVariant: "Lite" };
  try { assert.ok(sch.runAction("setDNP", ctx)); } finally { delete globalThis.CollabEditor; }
  assert.equal(commits.length, 1); assert.equal(commits[0].label, "Toggle Attribute");
  const s = K.serialize(doc.items.get("s1").node);
  assert.ok(s.includes(`(variant (name "Lite") (dnp yes))`), s);
  assert.ok(s.includes("(dnp no)"), "the symbol's own DNP stays");
});

test("the .kicad_pro registry and ValidateNewVariantName", () => {
  const pro = { schematic: { annotate_start_num: 0, drawing: {}, page_layout_descr_file: "" } };
  VM.writeVariantRegistry(pro, new Map([["Lite", ""], ["Full", "All parts"]]));
  assert.equal(JSON.stringify(pro.schematic), `{"annotate_start_num":0,"drawing":{},"page_layout_descr_file":"","variants":[{"description":"All parts","name":"Full"},{"name":"Lite"}]}`);
  const pro2 = { schematic: { annotate_start_num: 0, zz: 1 } };
  VM.writeVariantRegistry(pro2, new Map([["A", ""]]));
  assert.deepEqual(Object.keys(pro2.schematic), ["annotate_start_num", "variants", "zz"], "a new key in sorted position");
  assert.deepEqual([...VM.variantRegistry(pro)], [["Full", "All parts"], ["Lite", ""]]);
  assert.equal(VM.newVariantNameError("", []), "Variant name cannot be empty.");
  assert.equal(VM.newVariantNameError("< default >", []), "'< Default >' is a reserved variant name.");
  assert.equal(VM.newVariantNameError("lite", ["Lite"]), "Variant 'Lite' already exists.");
  assert.equal(VM.newVariantNameError("lite", ["Lite"], "Lite"), "", "a rename to a new case of itself");
});

test("GetVariantNamesForUI and the drawing sheet's ${VARIANT} / ${VARIANT_DESC}", () => {
  const v = K.parse(`(variants (variant (name "V10")) (variant (name "V2") (description "Two")) (variant (name "Alpha")))`);
  assert.deepEqual(VM.boardVariantNamesForUI(v), ["< Default >", "Alpha", "V2", "V10"]);
  assert.equal(VM.boardVariantDescription(v, "v2"), "Two");
  const vars = K.sheetTextVars({ variantName: "V2", variantDesc: "Two" });
  assert.equal(vars.VARIANT, "V2"); assert.equal(vars.VARIANT_DESC, "Two");
  assert.equal(K.sheetTextVars({}).VARIANT, "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
