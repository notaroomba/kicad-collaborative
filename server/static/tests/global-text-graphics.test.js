// global-text-graphics.test.js — DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS (web/tools/pcb-tools/global-text-graphics.ts):
// scope, filters, the specified values and the layer defaults (StyleFromSettings).
// Run: node server/static/tests/global-text-graphics.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools.textGraphics;

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user) (35 "F.Fab" user))
  (footprint "Lib:R_0603" (layer "F.Cu") (uuid "fp1") (at 10 10)
    (property "Reference" "R1" (at 0 -1.5 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.5 0) (layer "F.Fab") (uuid "v1") (effects (font (size 1 1) (thickness 0.15))))
    (property "MPN" "X" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "m1") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (uuid "t1") (effects (font (size 0.5 0.5) (thickness 0.08))))
    (fp_line (start 0 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1")))
  (footprint "Lib:C_0603" (layer "F.Cu") (uuid "fp2") (at 20 10)
    (property "Reference" "C1" (at 0 -1.5 0) (layer "F.SilkS") (uuid "r2") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "1u" (at 0 1.5 0) (layer "F.Fab") (uuid "v2") (effects (font (size 1 1) (thickness 0.15)))))
  (gr_text "hello" (at 3 3 0) (layer "F.SilkS") (uuid "gt") (effects (font (size 2 2) (thickness 0.3))))
  (gr_line (start 0 0) (end 30 0) (stroke (width 0.5) (type default)) (layer "Edge.Cuts") (uuid "edge"))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const run = (job) => new Map(T.editTextAndGraphics(doc(), Object.assign({ filter: {}, values: {}, specified: true }, job)));
const prop = (n, name) => K.kids(n, "property").find((p) => p[1] === name);
const size = (n) => K.kid(K.kid(K.kid(n, "effects"), "font"), "size").slice(1);

test("specified text height on the reference designators only", () => {
  const m = run({ scope: { references: true }, values: { textHeight: 1.27 } });
  assert.deepEqual([...m.keys()].sort(), ["fp1", "fp2"]);
  assert.deepEqual(size(prop(m.get("fp1"), "Reference")), [1.27, 1]);
  assert.deepEqual(size(prop(m.get("fp1"), "Value")), [1, 1], "the value is out of scope");
  // the ${REFERENCE} user text goes with the references (when footprint texts are not in scope)
  assert.deepEqual(size(K.kids(m.get("fp1"), "fp_text")[0]), [1.27, 0.5]);
});
test("filters: parent reference wildcard, layer, footprint library link", () => {
  assert.deepEqual([...run({ scope: { references: true, values: true }, filter: { reference: "C*" }, values: { textWidth: 2 } }).keys()], ["fp2"]);
  const m = run({ scope: { references: true, values: true }, filter: { layer: "F.Fab" }, values: { textWidth: 2 } });
  assert.deepEqual(size(prop(m.get("fp1"), "Reference")), [1, 1]); assert.deepEqual(size(prop(m.get("fp1"), "Value")), [1, 2]);
  assert.deepEqual([...run({ scope: { values: true }, filter: { footprint: "lib:r_*" }, values: { textWidth: 2 } }).keys()], ["fp1"]);
});
test("visible (fields only), bold / italic, layer, keep upright, line width", () => {
  const m = run({ scope: { otherFootprintFields: true, footprintGraphics: true, boardText: true }, values: { visible: true, italic: true, lineWidth: 0.2, layer: "F.Fab" } });
  const fp = m.get("fp1");
  assert.equal(K.kid(prop(fp, "MPN"), "hide"), null, "the hidden field is shown");
  assert.ok(K.serialize(prop(fp, "MPN")).includes("(italic yes)"));
  assert.equal(K.kid(K.kids(fp, "fp_line")[0], "stroke")[1][1], 0.2);
  assert.equal(K.kid(K.kids(fp, "fp_line")[0], "layer")[1], "F.Fab");
  assert.equal(K.kid(m.get("gt"), "layer")[1], "F.Fab");
  const up = run({ scope: { values: true }, values: { keepUpright: false } }).get("fp1");
  assert.ok(K.kid(prop(up, "Value"), "unlocked"), "keep upright off: (unlocked yes)");
});
test("selected items only: a selected footprint's children, a selected board item", () => {
  const m = new Map(T.editTextAndGraphics(doc(), { scope: { references: true, boardText: true }, filter: { selectedOnly: true }, specified: true, values: { textHeight: 3 }, selection: new Set(["fp2", "gt"]) }));
  assert.deepEqual([...m.keys()].sort(), ["fp2", "gt"]);
});
test("set to layer default values: StyleFromSettings (line width, text size, thickness)", () => {
  const m = run({ scope: { boardText: true, boardGraphics: true, references: true }, specified: false });
  const st = globalThis.PcbTools.layerStyle;
  assert.equal(K.kid(m.get("edge"), "stroke")[1][1], st("Edge.Cuts").line);
  const s = st("F.SilkS");
  assert.deepEqual(size(m.get("gt")), [s.h, s.w]);
  assert.equal(K.kid(K.kid(K.kid(m.get("gt"), "effects"), "font"), "thickness")[1], s.thick);
  assert.deepEqual(size(prop(m.get("fp1"), "Reference")), [s.h, s.w]);
});
test("nothing in scope changes nothing", () => { assert.equal(run({ scope: {}, values: { textHeight: 3 } }).size, 0); });
