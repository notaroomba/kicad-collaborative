// fp-browse.test.js — the fields grids' footprint / datasheet browse buttons (web/library/fpchoice.ts): the symbol
// netlist the footprint chooser gets (BuildFootprintChooserSymbolNetlist: pins of every unit, body style 1, stacked
// numbers expanded; ki_fp_filters), the grouped-row rule, FOOTPRINT_CHOOSER_FRAME::filterFootprint and the
// check box labels, GetAssociatedDocument's link test (kicad-embed://, ${VAR}) and IsURL.  Run: node server/static/tests/fp-browse.test.js
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
  assert.deepStrictEqual(F.datasheetLink("kicad-embed://lm358.pdf"), { kind: "embed", url: "lm358.pdf" }, "an embedded file is not 'not found'");
  assert.deepStrictEqual(F.datasheetLink("${DS}/lm358.pdf", { DS: "https://ti.com/ds" }), { kind: "url", url: "https://ti.com/ds/lm358.pdf" }, "ResolveUriByEnvVars first");
  assert.deepStrictEqual(F.datasheetLink("${EMB}", { EMB: "kicad-embed://a.pdf" }), { kind: "embed", url: "a.pdf" });
  assert.strictEqual(F.datasheetLink("${NOPE}/x", { DS: "y" }).url, "${NOPE}/x", "an unknown variable stays");
  assert.strictEqual(F.datasheetLink("javascript:alert(1)").kind, "other");
  assert.strictEqual(F.datasheetLink("file:///home/x.pdf").kind, "other");
});

test("SCH_FIELD::HasHypertext's IsURL: a link anywhere in the text", () => {
  assert.ok(F.isURL("https://www.ti.com/lit/ds/lm358.pdf")); assert.ok(F.isURL("see ftp://x.org/a")); assert.ok(F.isURL("file:///home/a.pdf"));
  assert.ok(!F.isURL("www.ti.com")); assert.ok(!F.isURL("mailto:a@b.c")); assert.ok(!F.isURL("10k")); assert.ok(!F.isURL("https://"));
});
test("the netlist string: every pin's number and name in order, then the filters; a grouped row needs the same string", () => {
  assert.strictEqual(F.chooserNetlist(R), "1 \t2 \rR_*\r");
  assert.strictEqual(F.chooserNetlist(STACKED), "1 D\t2 D\t3 D\t4 G\t5 S\t5 S2\r\r");
  assert.strictEqual(F.chooserNetlist(OPAMP).split("\r")[0].split("\t")[0], "1 ", "'~' is no name");
  // same pin count and filters, different pin names: KiCad sends no netlist, so no toggles
  const R2 = K.parse(`(symbol "R2" (property "ki_fp_filters" "R_*" (at 0 0 0) (hide yes) ${FONT}) (symbol "R2_1_1" ${pin(1, "A")} ${pin(2, "B")}))`);
  assert.deepStrictEqual(F.chooserFilters(R2), F.chooserFilters(R));
  assert.strictEqual(F.commonChooserFilters([R, R2]), null);
  const R3 = K.parse(`(symbol "R3" (property "ki_fp_filters" "R_*" (at 0 0 0) (hide yes) ${FONT}) (symbol "R3_1_1" ${pin(2, "")} ${pin(1, "")}))`);
  assert.strictEqual(F.commonChooserFilters([R, R3]), null, "pin order counts");
});
test("SCH_PROPERTIES_PANEL's netlist keeps a stacked number as it is", () => {
  assert.deepStrictEqual(F.chooserFilters(STACKED, false), { pins: 3, filters: [] }, "[1-3], 4 and 5: three, where the grids count five");
  assert.strictEqual(F.chooserNetlist(STACKED, false), "[1-3] D\t4 G\t5 S\t5 S2\r\r");
  assert.deepStrictEqual(F.netlistFilters(""), null);
  assert.deepStrictEqual(F.netlistFilters("\r\r"), null);
});

console.log(`fp-browse.test.js: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
