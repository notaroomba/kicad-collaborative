// symedit-find.test.js — the Symbol Editor's Find / Find and Replace (SCH_FIND_REPLACE_TOOL over LIB_SYMBOL::GetDrawItems).
// Run: node server/static/tests/symedit-find.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("symedit/model.ts"), Fd = load("symedit/find.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const sym = () => M.node(`(symbol "S" (property "Reference" "U" (at -5 5 0) (effects (font (size 1.27 1.27))))
  (property "Value" "SDA_buf" (at 0 -6 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "SDA_fp" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
  (property "ki_keywords" "SDA" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
  (symbol "S_0_1" (rectangle (start -2 -2) (end 2 2) (stroke (width 0) (type default)) (fill (type none))) (text "SDA here" (at 3 1 0) (effects (font (size 1.27 1.27)))))
  (symbol "S_1_1" (pin bidirectional line (at -7.62 2.54 0) (length 2.54) (name "SDA" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin input line (at -7.62 -2.54 0) (length 2.54) (name "SCL" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
  (symbol "S_2_1" (pin input line (at 7.62 0 180) (length 2.54) (name "X" (effects (font (size 1.27 1.27)))) (number "SDA" (effects (font (size 1.27 1.27)))))))`);
const opts = (o) => Object.assign({ query: "SDA", replacement: "", matchCase: false, wholeWord: false, regex: false, hiddenFields: false, selectionOnly: false, pins: true, searchAndReplace: false }, o);

console.log("symbol editor find");
test("items in nextMatch order: X, then Y down; ki_ properties are not fields", () => {
  const ids = Fd.findItems(sym()).map((i) => i.id);
  assert.deepStrictEqual(ids, ["p:S_1_1:2", "p:S_1_1:3", "f:Reference", "f:Footprint", "f:Value", "g:S_0_1:3", "p:S_2_1:2"]);
});
test("matches: pins by name or number in every unit, texts, visible fields; never the Reference; hidden fields on request", () => {
  const s = sym(); const items = Fd.findItems(s); const o = opts();
  assert.deepStrictEqual(items.filter((i) => Fd.itemMatches(i, o)).map((i) => i.id), ["p:S_1_1:2", "f:Value", "g:S_0_1:3", "p:S_2_1:2"]);
  assert.ok(items.filter((i) => Fd.itemMatches(i, opts({ hiddenFields: true }))).some((i) => i.id === "f:Footprint"));
  assert.ok(!items.some((i) => Fd.itemMatches(i, opts({ query: "U", wholeWord: true }))), "a library Reference never matches");
});
test("nextMatch walks forward and backward from the last hit; none after the last", () => {
  const items = Fd.findItems(sym()); const o = opts();
  assert.strictEqual(Fd.nextMatch(items, null, o, false).id, "p:S_1_1:2");
  assert.strictEqual(Fd.nextMatch(items, "p:S_1_1:2", o, false).id, "f:Value");
  assert.strictEqual(Fd.nextMatch(items, "p:S_2_1:2", o, false), null);
  assert.strictEqual(Fd.nextMatch(items, null, o, true).id, "p:S_2_1:2");
  assert.strictEqual(Fd.nextMatch(items, "f:Value", o, true).id, "p:S_1_1:2");
});
test("replace: a field's text, a text, a pin's name and number (EDA_ITEM::Replace on each)", () => {
  const s = sym(); const o = opts({ replacement: "SDA0", searchAndReplace: true });
  assert.ok(Fd.replaceIn(s, "f:Value", o)); assert.strictEqual(M.fieldValue(s, "Value"), "SDA0_buf");
  assert.ok(Fd.replaceIn(s, "g:S_0_1:3", o)); assert.ok(M.text(s).includes('(text "SDA0 here"'));
  assert.ok(Fd.replaceIn(s, "p:S_2_1:2", o)); assert.ok(M.text(s).includes('(number "SDA0"'));
  assert.ok(!Fd.replaceIn(s, "p:S_1_1:3", o), "SCL has nothing to replace");
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
