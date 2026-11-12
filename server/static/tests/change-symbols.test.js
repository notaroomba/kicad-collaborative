// change-symbols.test.js — Change Symbols / Update Symbols from Library (dialog_change_symbols.cpp processSymbols)
// over s-expression nodes, under node: matching, the field list, what one symbol becomes with each option, the
// reference renumbering on a prefix change and the report wording.  Run: node server/static/tests/change-symbols.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/change-symbols-logic.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("change / update symbols under node");
const F = "(effects (font (size 1.27 1.27)))";
const LIB_R = K.parse(`(symbol "Device:R" (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes)
  (property "Reference" "R" (at 2.032 0 90) ${F}) (property "Value" "R" (at 0 0 90) ${F})
  (property "Footprint" "Resistor_SMD:R_0603" (at -1.778 0 90) (hide yes) ${F}) (property "Datasheet" "~" (at 0 0 0) (hide yes) ${F})
  (property "Description" "Resistor" (at 0 0 0) (hide yes) ${F}) (property "Sim.Device" "R" (at 0 5 0) (hide yes) (effects (font (size 2 2) bold)))
  (property "ki_keywords" "R res" (at 0 0 0) (hide yes) ${F})
  (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F})) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${F}) (number "2" ${F}))))`);
const LIB_C = K.parse(`(symbol "Device:C" (in_bom no) (property "Reference" "C" (at 1 1 0) ${F}) (property "Value" "C" (at 1 -1 0) ${F}) (property "Footprint" "" (at 0 0 0) (hide yes) ${F})
  (symbol "C_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F})) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${F}) (number "2" ${F}))
    (pin input line (at 0 0 0) (length 1.27) (name "X" ${F}) (number "3" ${F}) (alternate "Y" input line))))`);
const placed = (ref, extra = "") => K.parse(`(symbol (lib_id "Device:R") (lib_name "R_1") (at 100 50 0) (unit 1) (exclude_from_sim no) (in_bom no) (on_board yes) (dnp no) (fields_autoplaced yes) (uuid "u-${ref}")
  (property "Reference" "${ref}" (at 102 50 0) ${F}) (property "Value" "10k" (at 102 52 0) ${F}) (property "Footprint" "Old:FP" (at 100 50 0) (hide yes) ${F})
  (property "MPN" "X1" (at 100 50 0) (hide yes) ${F}) ${extra}
  (pin "1" (uuid "p1") (alternate "Q")) (pin "2" (uuid "p2"))
  (instances (project "demo" (path "/root" (reference "${ref}") (unit 1)))))`);
const prop = (n, name) => { const p = L.fieldOf(n, name); return p ? L.propValue(p) : null; };
const ctx = () => ({ used: new Set(["R1", "R2", "C1"]), renamed: new Map() });
let uid = 0; const nu = () => "new-" + (++uid);

test("update: footprint text from the library, Reference / Value left alone by default, lib_name dropped", () => {
  const o = L.defaultOptions("update");
  const n = L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_R), "Device:R", o, ctx(), nu);
  assert.strictEqual(prop(n, "Footprint"), "Resistor_SMD:R_0603"); assert.strictEqual(prop(n, "Datasheet"), null, "a field the symbol lacks is not added when unchecked... mandatory ones stay as they are");
  assert.strictEqual(prop(n, "Reference"), "R1"); assert.strictEqual(prop(n, "Value"), "10k");
  assert.strictEqual(K.kid(n, "lib_name"), null); assert.strictEqual(K.str(K.kid(n, "lib_id")[1]), "Device:R");
  assert.strictEqual(K.str(K.kid(n, "in_bom")[1]), "no", "attributes stay unless asked");
});
test("update: Value checked takes the library text; a power symbol keeps its value unless 'Reset custom power symbols'", () => {
  const o = L.defaultOptions("update"); o.fields.add("Value");
  assert.strictEqual(prop(L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_R), "Device:R", o, ctx(), nu), "Value"), "R");
  const pwr = K.cloneNode(LIB_R); pwr.splice(2, 0, ["power"]);
  assert.strictEqual(prop(L.updateSymbolNode(placed("R1"), pwr, "Device:R", o, ctx(), nu), "Value"), "10k");
  o.resetCustomPower = true; assert.strictEqual(prop(L.updateSymbolNode(placed("R1"), K.cloneNode(pwr), "Device:R", o, ctx(), nu), "Value"), "R");
});
test("update: a checked library field the symbol lacks is added with the library's effects; Remove fields drops extras", () => {
  const o = L.defaultOptions("update"); o.fields.add("Sim.Device"); o.fields.add("MPN"); o.removeExtras = true;
  const n = L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_R), "Device:R", o, ctx(), nu);
  const sd = L.fieldOf(n, "Sim.Device"); assert.ok(sd); assert.ok(/\(size 2 2\) bold/.test(K.serialize(sd)), K.serialize(sd)); assert.ok(/\(hide yes\)/.test(K.serialize(sd)));
  assert.deepStrictEqual(K.kid(sd, "at").slice(1), [100, 45, 0], "library Y points up");
  assert.strictEqual(L.fieldOf(n, "MPN"), null, "MPN is not in the library symbol");
  assert.ok(L.fieldOf(L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_R), "Device:R", Object.assign(L.defaultOptions("update"), { removeExtras: true }), ctx(), nu), "MPN"), "an unchecked field is never touched");
});
test("update: visibility, styles and positions reset from the library when asked; attributes too", () => {
  const o = Object.assign(L.defaultOptions("update"), { resetVisibility: true, resetEffects: true, resetPositions: true, resetAttributes: true }); o.fields.add("Value");
  const n = L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_R), "Device:R", o, ctx(), nu);
  const v = L.fieldOf(n, "Value"); assert.deepStrictEqual(K.kid(v, "at").slice(1), [100, 50, 90]);
  assert.strictEqual(K.str(K.kid(n, "in_bom")[1]), "yes");
  const fp = L.fieldOf(n, "Footprint"); assert.ok(/\(hide yes\)/.test(K.serialize(fp)));
});
test("change: the new lib id, the reference prefix renumbered past the used ones, pins rebuilt, a stale alternate cleared", () => {
  const o = L.defaultOptions("change"); o.fields.add("Reference"); o.resetAlternates = false;
  const r = ctx(); const n = L.updateSymbolNode(placed("R1"), K.cloneNode(LIB_C), "Device:C", o, r, nu);
  assert.strictEqual(K.str(K.kid(n, "lib_id")[1]), "Device:C");
  assert.strictEqual(prop(n, "Reference"), "C2", "C1 is taken"); assert.strictEqual(K.str(K.kid(L.instancePaths(n)[0], "reference")[1]), "C2");
  assert.strictEqual(r.renamed.get("R1"), "C2"); assert.ok(r.used.has("C2"));
  const pins = K.kids(n, "pin").map((p) => K.str(p[1])); assert.deepStrictEqual(pins, ["1", "2", "3"]);
  assert.strictEqual(K.str(K.kid(K.kids(n, "pin")[0], "uuid")[1]), "p1", "a kept pin keeps its uuid");
  assert.strictEqual(K.kid(K.kids(n, "pin")[0], "alternate"), null, "'Q' is no alternate of the new symbol");
  const u = L.updateSymbolNode(placed("R?"), K.cloneNode(LIB_C), "Device:C", o, ctx(), nu); assert.strictEqual(prop(u, "Reference"), "C?");
});
test("matching: all, selection, reference / value wildcards (case-insensitive), library identifier", () => {
  const n = placed("R12");
  assert.ok(L.isMatch(n, "all", "", false)); assert.ok(!L.isMatch(n, "selected", "", false)); assert.ok(L.isMatch(n, "selected", "", true));
  assert.ok(L.isMatch(n, "reference", "r1*", false)); assert.ok(!L.isMatch(n, "reference", "R1", false)); assert.ok(L.isMatch(n, "reference", "R1?", false));
  assert.ok(L.isMatch(n, "value", "10K", false)); assert.ok(L.isMatch(n, "libid", "Device:R", false)); assert.ok(!L.isMatch(n, "libid", "Device:C", false));
});
test("field list: the other fields of the symbols and library symbols, sorted, no metadata", () => {
  assert.deepStrictEqual(L.fieldNames([placed("R1")], [LIB_R]), ["MPN", "Sim.Device"]);
});
test("report wording", () => {
  assert.strictEqual(L.reportLine("update", ["R1"], "Device:R", "Device:R"), "Update symbol R1 from 'Device:R' to 'Device:R'");
  assert.strictEqual(L.reportLine("change", ["U1", "U2"], "A:B", "C:D"), "Change symbols U1 U2 from 'A:B' to 'C:D'");
  assert.strictEqual(L.refPrefix("IC34"), "IC"); assert.strictEqual(L.refNumber("R?"), -1); assert.strictEqual(L.refNumber("R12"), 12);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
