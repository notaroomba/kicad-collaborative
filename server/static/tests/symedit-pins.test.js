// symedit-pins.test.js — the Symbol Editor pin tool (SYMBOL_EDITOR_PIN_TOOL in web/symedit/model.ts): IncrementString, Repeat Pin,
// synchronized pins mode (CreateImagePins, SynchronizeOtherUnits), the occupied-position test and the pin table CSV.
// Run: node server/static/tests/symedit-pins.test.js
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
console.log("symbol editor pins under node");
const mk = (units = 2) => M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "U", unitCount: units }));
const MIL = M.MIL;

test("IncrementString: last digit run steps, leading zeros kept, names without digits unchanged", () => {
  assert.strictEqual(M.incrementString("A1", 1), "A2"); assert.strictEqual(M.incrementString("D09", 1), "D10");
  assert.strictEqual(M.incrementString("PA07_x", 1), "PA08_x"); assert.strictEqual(M.incrementString("CLK", 1), "CLK");
  assert.strictEqual(M.incrementString("1", -2), "1"); assert.strictEqual(M.incrementString("12", -1), "11");
});
test("Repeat Pin: horizontal pins step down (file y - 100 mil), vertical pins step right; name and number increment", () => {
  const p = M.newPinInfo(0, 0, M.initialPinDefaults(), 1, 1); p.name = "D0"; p.number = "1";
  const r = M.repeatPin(p); assert.strictEqual(r.y, -2.54); assert.strictEqual(r.x, 0); assert.strictEqual(r.name, "D1"); assert.strictEqual(r.number, "2");
  p.orient = 90; const v = M.repeatPin(p); assert.strictEqual(v.x, 2.54); assert.strictEqual(v.y, 0);
});
test("new pins start from the last pin's settings; common unit / body give unit 0 / body 0", () => {
  const last = M.initialPinDefaults(); const p = M.newPinInfo(1, 2, last, 2, 1);
  assert.strictEqual(p.unit, 2); assert.strictEqual(p.length, 100 * MIL); assert.strictEqual(p.type, "input"); assert.strictEqual(p.name, "", "KiCad 10: a new pin has no name (SCH_PIN leaves m_name empty)");
  p.type = "output"; p.unit = 0; p.length = 5.08; M.rememberPin(last, p);
  const q = M.newPinInfo(0, 0, last, 2, 1); assert.strictEqual(q.unit, 0); assert.strictEqual(q.type, "output"); assert.strictEqual(q.length, 5.08);
});
test("pin node is written the way savePin writes it", () => {
  const p = M.newPinInfo(-5.08, 2.54, M.initialPinDefaults(), 1, 1); p.name = "IN"; p.number = "3"; p.visible = false;
  p.alternates.push({ name: "ALT", type: "output", shape: "inverted" });
  assert.strictEqual(M.text(M.pinNode(p)), '(pin input line (at -5.08 2.54 0) (length 2.54) (hide yes) (name "IN" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))) (alternate "ALT" output inverted))');
  const back = M.pinInfo(M.pinNode(p), 1, 1); assert.strictEqual(back.visible, false); assert.strictEqual(back.alternates[0].shape, "inverted");
});
test("ChangeLength keeps the body end: a right pin's connection point moves left as it grows", () => {
  const p = M.newPinInfo(0, 0, M.initialPinDefaults(), 1, 1); M.changeLength(p, 5.08); assert.strictEqual(p.x, -2.54); assert.strictEqual(p.length, 5.08);
});
test("sync mode: a new pin of unit A gets images '<num>-U<letter>' in every other unit", () => {
  const s = mk(3); const p = M.newPinInfo(0, 0, M.initialPinDefaults(), 1, 1); p.number = "5";
  M.placePin(s, p, true);
  const pins = M.allPins(s).map((d) => [d.unit, M.pinInfo(d.node).number]).sort();
  assert.deepStrictEqual(pins, [[1, "5"], [2, "5-UB"], [3, "5-UC"]]);
  assert.strictEqual(M.occupiedBy(s, Object.assign({}, p, { unit: 2 })), 1);
  assert.strictEqual(M.OCCUPIED_MSG(2), "This position is already occupied by another pin, in unit 2.");
});
test("SynchronizeOtherUnits: matching pins in other units follow the edit; position only within the same body style", () => {
  const s = mk(2); const a = M.newPinInfo(0, 0, M.initialPinDefaults(), 1, 1); a.name = "X"; a.number = "1";
  M.placePin(s, a, true);
  const pinA = M.allPins(s).find((d) => d.unit === 1).node; const before = M.pinInfo(pinA, 1, 1);
  const edited = Object.assign({}, before, { name: "Y", x: 2.54, type: "output" }); M.setPin(pinA, edited);
  const removed = M.synchronizeOtherUnits(s, pinA, before); assert.strictEqual(removed, 0);
  const b = M.allPins(s).find((d) => d.unit === 2); const bi = M.pinInfo(b.node);
  assert.strictEqual(bi.name, "Y"); assert.strictEqual(bi.type, "output"); assert.strictEqual(bi.x, 2.54); assert.strictEqual(bi.number, "1-UB");
});
test("SynchronizeOtherUnits: a pin made common to all units removes its copies", () => {
  const s = mk(2); const a = M.newPinInfo(0, 0, M.initialPinDefaults(), 1, 1); a.number = "1"; M.placePin(s, a, true);
  const pinA = M.allPins(s).find((d) => d.unit === 1).node; const before = M.pinInfo(pinA, 1, 1);
  M.relocatePin(s, pinA, 0, 1);
  const removed = M.synchronizeOtherUnits(s, pinA, before); assert.strictEqual(removed, 1);
  assert.deepStrictEqual(M.allPins(s).map((d) => d.unit), [0]);
});
test("Push pin length to other pins: same or common body style only", () => {
  const s = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "D", alternateBodyStyle: true }));
  const mkp = (x, body) => { const p = M.newPinInfo(x, 0, M.initialPinDefaults(), 1, body); p.number = String(x); M.placePin(s, p, false); };
  mkp(0, 1); mkp(2.54, 1); mkp(5.08, 2);
  const src = M.allPins(s)[0].node; const i = M.pinInfo(src); M.changeLength(i, 5.08); M.setPin(src, i);
  assert.strictEqual(M.pushPinProperty(s, src, "length", 1), 1);
  const lens = M.allPins(s).map((d) => [d.body, M.pinInfo(d.node).length]); assert.deepStrictEqual(lens.sort(), [[1, 5.08], [1, 5.08], [2, 2.54]]);
});
test("pin table: CSV export and import round-trip, summary collapses runs and lists duplicates", () => {
  const s = mk(2); for (const [n, x, u] of [["1", 0, 1], ["2", 2.54, 1], ["3", 5.08, 2], ["3", 7.62, 2]]) { const p = M.newPinInfo(x, 0, M.initialPinDefaults(), u, 1); p.number = n; p.name = "P" + n; M.placePin(s, p, false); }
  const rows = M.pinRows(s); const csv = M.pinsToCsv(rows, s);
  assert.ok(csv.startsWith("Number,Name,Electrical Type,Graphic Style,Orientation,"), csv);
  const back = M.pinsFromCsv(csv, s);
  assert.deepStrictEqual(back.map((r) => [r.number, r.name, r.type, r.shape, r.x, r.unit]), rows.map((r) => [r.number, r.name, r.type, r.shape, r.x, r.unit]));
  const sum = M.pinNumberSummary(rows); assert.strictEqual(sum.numbers, "1-3"); assert.strictEqual(sum.count, 4); assert.strictEqual(sum.duplicates, "3");
  M.applyPinRows(s, back.slice(0, 2)); assert.strictEqual(M.allPins(s).length, 2);
});
test("anchor move shifts every item and field the other way", () => {
  const s = mk(1); const p = M.newPinInfo(2.54, 2.54, M.initialPinDefaults(), 1, 1); M.placePin(s, p, false);
  M.moveAnchor(s, 2.54, 2.54); const i = M.pinInfo(M.allPins(s)[0].node); assert.strictEqual(i.x, 0); assert.strictEqual(i.y, 0);
});

test("Pin Table: rows show Y down; OK keeps untouched pins exactly (custom properties) and an edited pin's extras", () => {
  const s = mk(1);
  for (const [n, y] of [["1", 2.54], ["2", -5.08]]) { const p = M.newPinInfo(0, y, M.initialPinDefaults(), 1, 1); p.number = n; p.name = "P" + n; M.placePin(s, p, false); }
  const pins = M.allPins(s); pins[0].node.push(M.node('(custom_property "MPN" "abc")')); pins[1].node.push(M.node('(custom_property "X" "y")'));
  const before1 = M.text(M.allPins(s)[0].node);
  const rows = M.pinRows(s);
  assert.deepStrictEqual(rows.map((r) => r.y), [-2.54, 5.08], "internal coordinates: a pin above the anchor has a negative Y");
  rows[1].name = "Q2"; rows[1].y = 7.62;
  M.applyPinRows(s, rows);
  const after = M.allPins(s);
  assert.strictEqual(M.text(after[0].node), before1, "the untouched row's pin is written back as it was");
  assert.ok(M.text(after[1].node).includes('(custom_property "X" "y")') && M.text(after[1].node).includes('(name "Q2"'));
  assert.strictEqual(M.pinInfo(after[1].node).y, -7.62);
});
test("symbol names: EscapeString( CTX_LIBID ) and back", () => {
  assert.strictEqual(M.escapeLibId('R<1>:"a"\\b\n'), "R{lt}1{gt}{colon}{dblquote}a{dblquote}{backslash}b");
  assert.strictEqual(M.unescapeLibId("R{lt}1{gt}{colon}x"), "R<1>:x");
  assert.strictEqual(M.escapeLibId(M.escapeLibId("A:B")), "A{colon}B", "escaping twice changes nothing");
  const s = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: M.escapeLibId("R<1>") }));
  assert.ok(M.text(s).startsWith('(symbol "R{lt}1{gt}"'), M.text(s).slice(0, 40));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
