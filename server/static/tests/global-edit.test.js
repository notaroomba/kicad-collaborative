// global-edit.test.js — Edit Text & Graphics Properties (dialog_global_edit_text_and_graphics.cpp visitItem /
// processItem) over s-expression nodes.  Run: node server/static/tests/global-edit.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/global-edit-logic.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("edit text & graphics under node");
const F = "(effects (font (size 1.27 1.27)))";
const sym = K.parse(`(symbol (lib_id "Device:R") (at 100 50 0) (unit 1) (uuid "s1")
  (property "Reference" "R1" (at 102 50 0) ${F}) (property "Value" "10k" (at 102 52 0) ${F}) (property "MPN" "X" (at 100 50 0) (hide yes) ${F})
  (instances (project "demo" (path "/root" (reference "R1") (unit 1)))))`);
const ctx = (over = {}) => Object.assign({ netOf: () => null, attached: () => ({ wire: true, bus: false }), refOf: (n) => L.refOnInstance(n, ["root"]), isPower: () => false, selected: () => false }, over);
const nf = { fieldName: null, reference: null, libId: null, power: null, net: null, selectedOnly: false };
const scope = (o) => Object.assign(L.emptyScope(), o);
const prop = (n, name) => K.kids(n, "property").find((p) => K.str(p[1]) === name);

test("nothing in scope changes nothing", () => {
  assert.strictEqual(L.visitItem({ id: "s1", kind: "symbol", node: sym }, L.emptyScope(), nf, { textSize: 2 }, ctx()), null);
});
test("references: text size and bold on Reference only, the input node untouched", () => {
  const before = JSON.stringify(sym);
  const n = L.visitItem({ id: "s1", kind: "symbol", node: sym }, scope({ references: true }), nf, { textSize: 2, bold: true }, ctx());
  assert.strictEqual(JSON.stringify(sym), before);
  const r = K.kid(K.kid(prop(n, "Reference"), "effects"), "font");
  assert.deepStrictEqual(K.kid(r, "size").slice(1), [2, 2]); assert.deepStrictEqual(K.kid(r, "bold"), ["bold", "yes"]);
  assert.deepStrictEqual(K.kid(K.kid(K.kid(prop(n, "Value"), "effects"), "font"), "size").slice(1), [1.27, 1.27]);
});
test("reference filter (wildcard) and power filter", () => {
  assert.strictEqual(L.visitItem({ id: "s1", kind: "symbol", node: sym }, scope({ values: true }), Object.assign({}, nf, { reference: "C*" }), { textSize: 2 }, ctx()), null);
  assert.ok(L.visitItem({ id: "s1", kind: "symbol", node: sym }, scope({ values: true }), Object.assign({}, nf, { reference: "r?" }), { textSize: 2 }, ctx()));
  assert.strictEqual(L.visitItem({ id: "s1", kind: "symbol", node: sym }, scope({ values: true }), Object.assign({}, nf, { power: true }), { textSize: 2 }, ctx()), null);
});
test("other fields: visibility and the field-name filter", () => {
  const n = L.visitItem({ id: "s1", kind: "symbol", node: sym }, scope({ otherFields: true }), Object.assign({}, nf, { fieldName: "MPN" }), { visible: true }, ctx());
  assert.strictEqual(K.kid(prop(n, "MPN"), "hide"), null);
});
test("wire stroke: width, style and colour; bus untouched with only wires in scope", () => {
  const w = K.parse(`(wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1"))`);
  const n = L.visitItem({ id: "w1", kind: "wire", node: w }, scope({ wires: true }), nf, { lineWidth: 0.3, lineStyle: "dash", lineColor: [255, 0, 0, 1] }, ctx());
  const st = K.kid(n, "stroke");
  assert.deepStrictEqual(K.kid(st, "width"), ["width", 0.3]); assert.deepStrictEqual(K.kid(st, "type"), ["type", "dash"]); assert.deepStrictEqual(K.kid(st, "color"), ["color", 255, 0, 0, 1]);
  assert.strictEqual(L.visitItem({ id: "b1", kind: "bus", node: w }, scope({ wires: true }), nf, { lineWidth: 0.3 }, ctx()), null);
});
test("label orientation sets the spin and its justification; net filter", () => {
  const l = K.parse(`(global_label "VCC" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "l1"))`);
  const n = L.visitItem({ id: "l1", kind: "global_label", node: l }, scope({ globalLabels: true }), nf, { orientation: 2 }, ctx());
  assert.strictEqual(K.kid(n, "at")[3], 180); assert.deepStrictEqual(K.kid(K.kid(n, "effects"), "justify"), ["justify", "right"]);
  assert.strictEqual(L.visitItem({ id: "l1", kind: "global_label", node: l }, scope({ globalLabels: true }), Object.assign({}, nf, { net: "GND" }), { orientation: 2 }, ctx({ netOf: () => "VCC" })), null);
});
test("junction size and colour follow the wires scope", () => {
  const j = K.parse(`(junction (at 1 1) (diameter 0) (color 0 0 0 0) (uuid "j1"))`);
  const n = L.visitItem({ id: "j1", kind: "junction", node: j }, scope({ wires: true }), nf, { junctionSize: 1.2, junctionColor: [0, 0, 255, 1] }, ctx());
  assert.deepStrictEqual(K.kid(n, "diameter"), ["diameter", 1.2]); assert.deepStrictEqual(K.kid(n, "color"), ["color", 0, 0, 255, 1]);
});
test("selected items only", () => {
  const t = K.parse(`(text "hi" (at 0 0 0) ${F} (uuid "t1"))`);
  assert.strictEqual(L.visitItem({ id: "t1", kind: "text", node: t }, scope({ schTextAndGraphics: true }), Object.assign({}, nf, { selectedOnly: true }), { italic: true }, ctx()), null);
  assert.ok(L.visitItem({ id: "t1", kind: "text", node: t }, scope({ schTextAndGraphics: true }), Object.assign({}, nf, { selectedOnly: true }), { italic: true }, ctx({ selected: () => true })));
});
test("colour helpers and wildcards", () => {
  assert.deepStrictEqual(L.hexToColor("#ff8000"), [255, 128, 0, 1]); assert.strictEqual(L.colorToHex([255, 128, 0, 1]), "#ff8000");
  assert.ok(L.wild("U*", "u12")); assert.ok(!L.wild("U?", "U12"));
});
test("V Align flips on a symbol whose TRANSFORM y1 < 0 (the parser's 270, not 90)", () => {
  const at = (rot, mirror = "") => K.parse(`(symbol (lib_id "Device:R") (at 100 50 ${rot}) ${mirror} (unit 1) (uuid "s1") (property "Reference" "R1" (at 102 50 0) ${F}) (instances (project "demo" (path "/root" (reference "R1") (unit 1)))))`);
  assert.deepStrictEqual(L.symbolTransform(at(90)), { x1: 0, y1: 1 });
  assert.deepStrictEqual(L.symbolTransform(at(270)), { x1: 0, y1: -1 });
  assert.deepStrictEqual(L.symbolTransform(at(180)), { x1: -1, y1: 0 });
  assert.deepStrictEqual(L.symbolTransform(at(90, "(mirror y)")), { x1: -0, y1: -1 });
  assert.deepStrictEqual(L.symbolTransform(at(90, "(mirror x)")), { x1: 0, y1: 1 });
  const j = (rot) => { const n = L.visitItem({ id: "s1", kind: "symbol", node: at(rot) }, scope({ references: true }), nf, { vAlign: "top" }, ctx()); return K.serialize(K.kid(K.kid(prop(n, "Reference"), "effects"), "justify")); };
  assert.strictEqual(j(0), "(justify top)"); assert.strictEqual(j(90), "(justify top)");
  assert.strictEqual(j(180), "(justify top)"); assert.strictEqual(j(270), "(justify bottom)");
});
test("fill goes on a polygon (SCH_SHAPE), never on a 2-point graphic line (SCH_LINE)", () => {
  const line = K.parse(`(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "l"))`);
  const poly = K.parse(`(polyline (pts (xy 0 0) (xy 10 0) (xy 10 10)) (stroke (width 0) (type default)) (fill (type none)) (uuid "p"))`);
  const s = { lineWidth: 0.3, fillColor: [255, 0, 0, 1] };
  const a = L.visitItem({ id: "l", kind: "polyline", node: line }, scope({ schTextAndGraphics: true }), nf, s, ctx());
  assert.strictEqual(K.kid(a, "fill"), null); assert.deepStrictEqual(K.kid(K.kid(a, "stroke"), "width"), ["width", 0.3]);
  const b = L.visitItem({ id: "p", kind: "polyline", node: poly }, scope({ schTextAndGraphics: true }), nf, s, ctx());
  assert.strictEqual(K.serialize(K.kid(b, "fill")), "(fill (type color) (color 255 0 0 1))");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
