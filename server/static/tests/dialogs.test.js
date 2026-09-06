// dialogs.test.js — the field helpers behind KiCad's "Edit Text and Field Properties" dialog and the
// canvas field hit boxes, under node.  Run: node server/static/tests/dialogs.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "props.js")); require(path.join(__dirname, "..", "kicad-dialogs.js"));
const K = globalThis.KiCadCanvas, D = globalThis.KDialogs._, { kid, kids, str, atOf } = K;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4")
  (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Device:R") (at 25.4 100.33 0) (unit 1) (uuid "s1")
    (property "Reference" "R1" (at 27.432 99.06 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 27.432 101.6 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at 23.622 100.33 90) (hide yes) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "p1"))))`;
console.log("dialog helpers under node");
const doc = K.parseDoc(SHEET), s1 = doc.items.get("s1");
test("field boxes: reference and value get quads; a point inside the Value text hits it", () => {
  const boxes = K.fieldBoxes(s1); assert.deepStrictEqual(boxes.map((b) => b.name).sort(), ["Reference", "Value"], "hidden Footprint has no box");
  const v = boxes.find((b) => b.name === "Value"); assert.strictEqual(v.pts.length, 4);
  const hit = K.fieldAt(doc, 28.5, 101.6); assert.ok(hit && hit.name === "Value" && hit.item === s1, JSON.stringify(hit && hit.name));
  assert.strictEqual(K.fieldAt(doc, 25.4, 100.33), null, "the body is not a field");
});
test("effects round-trip: size, bold/italic as (bold yes), justify drops center, hide handled by props", () => {
  const node = JSON.parse(JSON.stringify(s1.node)); const p = D.fieldNode(node, "Value");
  assert.deepStrictEqual(D.fieldEffects(p), { size: 1.27, thick: 0, bold: false, italic: false, h: "left", v: "center", mirror: false });
  D.setFieldEffects(p, { size: 2, bold: true, italic: true, h: "center", v: "top", mirror: false });
  assert.deepStrictEqual(kid(p, "effects"), ["effects", ["font", ["size", 2, 2], ["bold", "yes"], ["italic", "yes"]], ["justify", "top"]]);
  D.setFieldEffects(p, { size: 1.27, bold: false, italic: false, h: "center", v: "center" });
  assert.deepStrictEqual(kid(p, "effects"), ["effects", ["font", ["size", 1.27, 1.27]]], "centered text writes no justify at all");
  D.setFieldAt(p, 30, 40, 90); assert.deepStrictEqual(kid(p, "at"), ["at", 30, 40, 90]);
  assert.strictEqual(D.fieldHidden(p), false); D.setFieldHidden(node, p, true); assert.strictEqual(D.fieldHidden(D.fieldNode(node, "Value")), true);
  assert.deepStrictEqual(kid(D.fieldNode(node, "Value"), "hide"), ["hide", "yes"]);
  D.setFieldHidden(node, D.fieldNode(node, "Value"), false); assert.strictEqual(D.fieldHidden(D.fieldNode(node, "Value")), false);
  const out = K.serializeItem(doc, Object.assign({}, s1, { node })); assert.ok(/\(property "?Value"? "10k" \(at 30 40 90\) \(effects \(font \(size 1\.27 1\.27\)\)\)\)/.test(out), out);
});
test("footprint fields: thickness, layer, keep-upright and legacy fp_text nodes", () => {
  const fp = K.parse(`(footprint "R_0603" (layer "F.Cu") (uuid "f1") (at 10 10 90)
    (property "Reference" "R1" (at 0 -1.43 0) (layer "F.SilkS") (uuid "u1") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1.43 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)))))`);
  const ref = D.fieldNode(fp, "Reference"), val = D.fieldNode(fp, "Value");
  assert.strictEqual(ref[0], "property"); assert.strictEqual(val[0], "fp_text"); assert.strictEqual(D.fieldText(val), "10k");
  D.setFieldEffects(ref, { size: 1.2, thick: 0.2, bold: false, italic: false, h: "right", v: "bottom", mirror: true });
  assert.deepStrictEqual(kid(ref, "effects"), ["effects", ["font", ["size", 1.2, 1.2], ["thickness", 0.2]], ["justify", "right", "bottom", "mirror"]]);
  D.setFieldLayer(ref, "B.SilkS"); assert.deepStrictEqual(kid(ref, "layer"), ["layer", "B.SilkS"]);
  D.setFieldUnlocked(ref, true); assert.deepStrictEqual(kid(ref, "unlocked"), ["unlocked", "yes"]); D.setFieldUnlocked(ref, false); assert.strictEqual(kid(ref, "unlocked"), null);
  assert.strictEqual(D.fieldLayer(ref), "B.SilkS");
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
