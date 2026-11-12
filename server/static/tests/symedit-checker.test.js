// symedit-checker.test.js — the Symbol Checker (CheckLibSymbol in web/symedit/model.ts): KiCad's messages for empty or
// numbered references, duplicate and stacked pins, power symbols, hidden power pins, off-grid pins and degenerate graphics.
// Run: node server/static/tests/symedit-checker.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("symedit/model.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("symbol checker under node");
const MIL = M.MIL;
const mk = (o) => M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "U" }, o || {}));
const pin = (s, num, x, y, unit = 1, body = 1, o = {}) => { const p = Object.assign(M.newPinInfo(x, y, M.initialPinDefaults(), unit, body), { number: num }, o); M.placePin(s, p, false); return p; };
const plain = (m) => m.replace(/<[^>]+>/g, "");

test("a clean symbol has no issues", () => { const s = mk(); pin(s, "1", 0, 0); pin(s, "2", 0, -2.54); assert.deepStrictEqual(M.checkSymbol(s), []); });
test("empty reference / reference ending in a digit", () => {
  assert.strictEqual(plain(M.checkSymbol(mk({ reference: "" }))[0]), "Warning: reference is empty");
  assert.strictEqual(plain(M.checkSymbol(mk({ reference: "U1" }))[0]), "Warning: reference prefixprefix ending by '0123456789?' can create issues if saved in a symbol library");
});
test("duplicate pin numbers, single and multi unit wording", () => {
  const s = mk(); pin(s, "1", 0, 0, 1, 1, { name: "A" }); pin(s, "1", 0, -2.54, 1, 1, { name: "B" });
  const m = M.checkSymbol(s, 50 * MIL, (v) => M.fmt(v) + " mm");
  assert.strictEqual(m.length, 1); assert.strictEqual(plain(m[0]), "Duplicate pin 1  'B' at location (0 mm, -2.54 mm) conflicts with pin 1 'A' at location (0 mm, 0 mm) in units A and A.");
  const t = mk({ unitCount: 2 }); pin(t, "7", 0, 0, 1); pin(t, "7", 2.54, 0, 2);
  assert.ok(plain(M.checkSymbol(t)[0]).endsWith("in units B and A."), M.checkSymbol(t)[0]);
});
test("stacked pin numbers count as their logical numbers", () => {
  assert.deepStrictEqual(M.stackedNumbers("[1,3-5]"), ["1", "3", "4", "5"]); assert.strictEqual(M.stackedNumbers("12"), null);
  const s = mk(); pin(s, "[1-2]", 0, 0); pin(s, "2", 0, -2.54);
  assert.ok(plain(M.checkSymbol(s)[0]).startsWith("Duplicate pin 2"), M.checkSymbol(s)[0]);
});
test("power symbols: one unit, one pin, power in or out, visible input", () => {
  const s = mk({ power: true, reference: "#PWR" });
  assert.deepStrictEqual(M.checkSymbol(s).map(plain), ["A Power Symbol should have exactly one pin"]);
  pin(s, "1", 0, 0, 1, 1, { type: "passive" });
  assert.deepStrictEqual(M.checkSymbol(s).map(plain), ["Suspicious Power SymbolOnly an input or output power pin has meaning"]);
  const t = mk({ power: true, reference: "#PWR" }); pin(t, "1", 0, 0, 1, 1, { type: "power_in", visible: false });
  assert.deepStrictEqual(M.checkSymbol(t).map(plain), ["Suspicious Power SymbolInvisible input power pins are no longer required"]);
});
test("hidden power input pin on an ordinary symbol is reported as Info", () => {
  const s = mk(); pin(s, "1", 0, 0, 1, 1, { type: "power_in", visible: false, name: "VCC" });
  assert.strictEqual(plain(M.checkSymbol(s)[0]), "Info: Hidden power pin 1 'VCC' at location (0 mm, 0 mm).(Hidden power pins will drive their pin names on to any connected nets.)");
});
test("off-grid pins against the 50 mil grid (25 mil minimum)", () => {
  const s = mk(); pin(s, "1", 0.635, 0);
  assert.strictEqual(plain(M.checkSymbol(s)[0]), "Off grid pin 1  at location (0.635 mm, 0 mm).");
  assert.deepStrictEqual(M.checkSymbol(s, 25 * MIL), []);
  assert.deepStrictEqual(M.checkSymbol(s, 10 * MIL), [], "grid below 25 mil is clamped");
});
test("degenerate graphics: zero radius circle and zero size rectangle", () => {
  const s = mk(); M.addDrawItem(s, 1, 1, M.node("(circle (center 1 1) (radius 0) (stroke (width 0) (type default)) (fill (type none)))"));
  M.addDrawItem(s, 1, 1, M.node("(rectangle (start 2 2) (end 2 2) (stroke (width 0) (type default)) (fill (type none)))"));
  assert.deepStrictEqual(M.checkSymbol(s).map(plain), ["Graphic circle has radius = 0 at location (1 mm, 1 mm).", "Graphic rectangle has size 0 at location (2 mm, 2 mm)."]);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
