// fp-browse.test.js — the fields grids' footprint / datasheet browse buttons (web/library/fpchoice.ts): the symbol
// netlist the footprint chooser gets (BuildFootprintChooserSymbolNetlist: pins of every unit, body style 1, stacked
// numbers expanded; ki_fp_filters), the grouped-row rule, FOOTPRINT_CHOOSER_FRAME::filterFootprint and the
// check box labels, and GetAssociatedDocument's link test.  Run: node server/static/tests/fp-browse.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const F = load("library/fpchoice.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("footprint chooser filters under node");

const FONT = "(effects (font (size 1.27 1.27)))";
const pin = (num, name) => `(pin passive line (at 0 0 0) (length 2.54) (name "${name}" ${FONT}) (number "${num}" ${FONT}))`;
// a dual op-amp: units 1 and 2, a shared power unit 3, and a De Morgan body style 2 whose pins must not count twice
const OPAMP = K.parse(`(symbol "LM358" (property "Reference" "U" (at 0 0 0) ${FONT})
  (property "ki_fp_filters" "SOIC*3.9x4.9mm*P1.27mm* DIP*W7.62mm*" (at 0 0 0) (hide yes) ${FONT})
  (symbol "LM358_1_1" ${pin(1, "~")} ${pin(2, "-")} ${pin(3, "+")})
  (symbol "LM358_2_1" ${pin(5, "+")} ${pin(6, "-")} ${pin(7, "~")})
  (symbol "LM358_2_2" ${pin(5, "+")} ${pin(6, "-")} ${pin(7, "~")} ${pin(99, "x")})
  (symbol "LM358_3_1" ${pin(4, "V-")} ${pin(8, "V+")}))`);
const R = K.parse(`(symbol "R" (property "ki_fp_filters" "R_*" (at 0 0 0) (hide yes) ${FONT}) (symbol "R_1_1" ${pin(1, "")} ${pin(2, "")}))`);
const STACKED = K.parse(`(symbol "Q" (symbol "Q_0_1" ${pin("[1-3]", "D")} ${pin(4, "G")} ${pin(5, "S")} ${pin(5, "S2")}))`);

test("pins: every unit of body style 1 (and the shared body style 0), distinct numbers", () => {
  assert.deepStrictEqual(F.chooserPinNumbers(OPAMP), ["1", "2", "3", "5", "6", "7", "4", "8"]);
  assert.deepStrictEqual(F.chooserFilters(OPAMP), { pins: 8, filters: ["SOIC*3.9x4.9mm*P1.27mm*", "DIP*W7.62mm*"] });
});
test("pins: a stacked number counts its pins; a repeated number counts once", () => {
  assert.deepStrictEqual(F.chooserPinNumbers(STACKED), ["1", "2", "3", "4", "5", "5"]);
  assert.deepStrictEqual(F.chooserFilters(STACKED), { pins: 5, filters: [] });
});
test("no symbol, or one with neither pins nor filters: no filters at all", () => {
  assert.strictEqual(F.chooserFilters(null), null);
  assert.strictEqual(F.chooserFilters(K.parse(`(symbol "X" (property "Reference" "X" (at 0 0 0) ${FONT}))`)), null);
});
test("a grouped row: filters only when every symbol's agree", () => {
  assert.deepStrictEqual(F.commonChooserFilters([R, K.parse(K.serialize(R))]), { pins: 2, filters: ["R_*"] });
  assert.strictEqual(F.commonChooserFilters([R, OPAMP]), null);
  assert.strictEqual(F.commonChooserFilters([R, null]), null);
  assert.strictEqual(F.commonChooserFilters([]), null);
});
test("filterFootprint: anchored wildcards over the lower-cased name, the library only when the pattern has ':'", () => {
  const soic = { library: "Package_SO", name: "SOIC-8_3.9x4.9mm_P1.27mm", pads: 8 };
  const dip = { library: "Package_DIP", name: "DIP-8_W7.62mm", pads: 8 };
  const tssop = { library: "Package_SO", name: "TSSOP-8_4.4x3mm_P0.65mm", pads: 8 };
  const f = F.chooserFilters(OPAMP), on = { pins: true, filters: true };
  assert.ok(F.footprintPasses(soic, f, on)); assert.ok(F.footprintPasses(dip, f, on)); assert.ok(!F.footprintPasses(tssop, f, on));
  assert.ok(F.footprintPasses(tssop, f, { pins: true, filters: false }));
  assert.ok(!F.footprintPasses({ library: "Package_SO", name: "SOIC-8-1EP_3.9x4.9mm_P1.27mm", pads: 9 }, f, on), "9 pads against 8 pins");
  assert.ok(F.footprintPasses({ library: "Package_SO", name: "SOIC-8-1EP_3.9x4.9mm_P1.27mm", pads: 9 }, f, { pins: false, filters: true }));
  assert.ok(F.matchesFpFilters({ library: "Resistor_SMD", name: "r_0603_1608Metric" }, ["R_*"]), "case is ignored");
  assert.ok(!F.matchesFpFilters({ library: "Resistor_SMD", name: "XR_0603" }, ["R_*"]), "anchored at the start");
  assert.ok(F.matchesFpFilters({ library: "Resistor_SMD", name: "R_0603" }, ["resistor_smd:R_*"]));
  assert.ok(!F.matchesFpFilters({ library: "Resistor_THT", name: "R_Axial" }, ["Resistor_SMD:R_*"]));
  assert.ok(F.matchesFpFilters({ library: "L", name: "R_0603" }, ["R_060?"]));
  assert.ok(F.footprintPasses({ library: "x", name: "y" }, f, { pins: true, filters: false }), "an unknown pad count is kept");
  assert.ok(F.footprintPasses(tssop, null, on), "no netlist: nothing is filtered");
});
test("the check boxes say what they filter on, and only the ones the netlist allows show", () => {
  assert.deepStrictEqual(F.filterLabels(F.chooserFilters(OPAMP)), { pins: "Filter by pin count (8)", filters: "Apply footprint filters (SOIC*3.9x4.9mm*P1.27mm* DIP*W7.62mm*)" });
  assert.deepStrictEqual(F.filterLabels(F.chooserFilters(STACKED)), { pins: "Filter by pin count (5)", filters: null });
  assert.deepStrictEqual(F.filterLabels(null), { pins: null, filters: null });
});
test("GetAssociatedDocument: web and mail links open, '~' and blank are none, a path is reported", () => {
  assert.deepStrictEqual(F.datasheetLink(" https://www.ti.com/lit/ds/symlink/lm358.pdf "), { kind: "url", url: "https://www.ti.com/lit/ds/symlink/lm358.pdf" });
  assert.strictEqual(F.datasheetLink("HTTP://x").kind, "url");
  assert.strictEqual(F.datasheetLink("mailto:a@b.c").kind, "url");
  assert.strictEqual(F.datasheetLink("~").kind, "none");
  assert.strictEqual(F.datasheetLink("").kind, "none");
  assert.strictEqual(F.datasheetLink("${KIPRJMOD}/doc.pdf").kind, "other");
  assert.strictEqual(F.datasheetLink("javascript:alert(1)").kind, "other");
  assert.strictEqual(F.datasheetLink("file:///home/x.pdf").kind, "other");
});

console.log(`fp-browse.test.js: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
