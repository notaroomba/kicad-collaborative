// label-autorotate.test.js — the global / hierarchical label "Auto" option: SCH_SCREEN::GetLabelOrientationForPoint
// and AutoRotateItem at placement and after a move.  Run: node server/static/tests/label-autorotate.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._, IU = 1e4;
const { kid, atOf } = K;

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "root-uuid") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
  (wire (pts (xy 50.8 50.8) (xy 76.2 50.8)) (stroke (width 0) (type default)) (uuid "wh"))
  (wire (pts (xy 101.6 76.2) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "wv"))
  (bus (pts (xy 152.4 50.8) (xy 152.4 101.6)) (stroke (width 0) (type default)) (uuid "b1"))
  (bus_entry (at 152.4 63.5) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "be"))
  (symbol (lib_id "Device:R") (at 25.4 100.33 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
    (property "Reference" "R1" (at 27.432 99.06 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 27.432 101.6 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2")))
  (global_label "G1" (shape input) (at 76.2 50.8 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g1")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27)))))
)`;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
function makeCtx(doc) {
  const ctx = { K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null,
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; }, setSelection(ids) { ctx.selection = new Set(ids); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, enterSheet() {}, setTool(t) { sch.onActivate(t, ctx); } };
  return ctx;
}
const R = 0, U = 1, L = 2, B = 3;

test("a horizontal wire: its end faces RIGHT, its start LEFT; elsewhere on it LEFT", () => {
  const doc = K.parseDoc(SHEET);
  assert.strictEqual(_.labelOrientationForPoint(doc, [76.2, 50.8], B), R);
  assert.strictEqual(_.labelOrientationForPoint(doc, [50.8, 50.8], B), L);
  assert.strictEqual(_.labelOrientationForPoint(doc, [63.5, 50.8], B), L);
});
test("a vertical wire drawn upwards: its end (top) faces UP, its start BOTTOM", () => {
  const doc = K.parseDoc(SHEET);
  assert.strictEqual(_.labelOrientationForPoint(doc, [101.6, 50.8], R), U);
  assert.strictEqual(_.labelOrientationForPoint(doc, [101.6, 76.2], R), B);
});
test("a bus entry on a vertical bus: the side of the bus decides LEFT / RIGHT", () => {
  const doc = K.parseDoc(SHEET);
  assert.strictEqual(_.labelOrientationForPoint(doc, [154.94, 66.04], L), R);
});
test("a pin: GetPinSpinStyle (pin 1 of an upright R points up)", () => {
  const doc = K.parseDoc(SHEET);
  assert.strictEqual(_.labelOrientationForPoint(doc, [25.4, 96.52], R), U);
  assert.strictEqual(_.labelOrientationForPoint(doc, [25.4, 104.14], R), B);
});
test("nothing there: the default spin stays", () => {
  const doc = K.parseDoc(SHEET);
  assert.strictEqual(_.labelOrientationForPoint(doc, [10, 10], B), B);
});
test("placement with Auto: the label faces away from the wire start, with the matching justify", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  sch.state.lastAutoRotate = true;
  const n = _.labelNode("global_label", "NEW", [0, 0], 0);
  _.startCarry(ctx, "global_label", n, [50.8, 50.8]); _.placeCarry(ctx, [50.8, 50.8]);
  const it = _.dropCarry(ctx);
  assert.ok(it); const placed = doc.items.get(it.id);
  assert.strictEqual(atOf(placed.node)[2], 180);
  assert.deepStrictEqual(kid(kid(placed.node, "effects"), "justify"), ["justify", "right"]);
  assert.ok(_.autoRotateOf(it.id));
  assert.ok(!ctx.log[ctx.log.length - 1].changes[0].sexpr.includes("auto_rotate"), "nothing new in the file");
  sch.state.lastAutoRotate = false;
});
test("placement without Auto keeps the spin", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  sch.state.lastAutoRotate = false;
  _.startCarry(ctx, "global_label", _.labelNode("global_label", "NEW", [0, 0], 0), [50.8, 50.8]); _.placeCarry(ctx, [50.8, 50.8]);
  const it = _.dropCarry(ctx); assert.strictEqual(atOf(doc.items.get(it.id).node)[2], 0); assert.ok(!_.autoRotateOf(it.id));
});
test("a move ends with the flagged label re-spun for where it lands; an unflagged one keeps its spin", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  sch.onActivate("select", ctx);
  _.setAutoRotate("g1", true);
  const g = doc.items.get("g1");
  assert.ok(_.beginDrag(ctx, g, [76.2, 50.8], true)); _.moveDrag(ctx, [101.6, 76.2]); _.endDrag(ctx, true);
  const after = doc.items.get("g1"); assert.strictEqual(atOf(after.node)[2], 270, "start of the upward wire: BOTTOM");
  _.setAutoRotate("g1", false);
  assert.ok(_.beginDrag(ctx, after, [101.6, 76.2], true)); _.moveDrag(ctx, [50.8, 50.8]); _.endDrag(ctx, true);
  assert.strictEqual(atOf(doc.items.get("g1").node)[2], 270);
});

test("Repeat Item (Insert) copies the Auto flag to the repeated label (SCH_ITEM::Duplicate copies m_autoRotateOnPlacement)", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.setAutoRotate("g1", true); _.rememberPlaced("global_label", doc.items.get("g1").node);
  assert.ok(sch.runAction("repeatLast", ctx));
  const id = ctx.log[ctx.log.length - 1].changes.find((c) => c.kind === "ADDED" && /global_label/.test(c.sexpr)).id;
  assert.notStrictEqual(id, "g1"); assert.ok(_.autoRotateOf(id), "the copy keeps Auto");
  _.setAutoRotate("g1", false); _.setAutoRotate(id, false); _.rememberPlaced("global_label", doc.items.get("g1").node);
  assert.ok(sch.runAction("repeatLast", ctx));
  const id2 = ctx.log[ctx.log.length - 1].changes.find((c) => c.kind === "ADDED" && /global_label/.test(c.sexpr)).id;
  assert.ok(!_.autoRotateOf(id2), "an unflagged label repeats unflagged");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
