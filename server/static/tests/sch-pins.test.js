// sch-pins.test.js — a bare symbol pin as the selection: SCH_PIN::HitTest, PIN_TRICKS_MENU (Pin Helpers) and
// ALT_PIN_FUNCTION_MENU (SetAltPinFunction).  Run: node server/static/tests/sch-pins.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._, IU = 1e4;
const { kid, kids, str, atOf, ptsOf } = K;

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "root-uuid") (paper "A4")
  (lib_symbols
    (symbol "Dev:U" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 6.35 0) (effects (font (size 1.27 1.27))))
      (property "Value" "U" (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
      (symbol "U_0_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol "U_1_1"
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin output line (at 7.62 2.54 180) (length 2.54) (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
        (pin bidirectional line (at 0 7.62 270) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
        (pin unspecified line (at 0 -7.62 90) (length 2.54) (name "PA0" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27))))
          (alternate "UART_TX" output line) (alternate "ADC0" input line))
        (pin passive line (at 7.62 -2.54 180) (length 2.54) hide (name "NC" (effects (font (size 1.27 1.27)))) (number "5" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Dev:U") (at 50.8 50.8 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "u1")
    (property "Reference" "U1" (at 50.8 44.45 0) (effects (font (size 1.27 1.27))))
    (property "Value" "U" (at 50.8 57.15 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2")) (pin "3" (uuid "p3")) (pin "4" (uuid "p4")) (pin "5" (uuid "p5"))
    (instances (project "t" (path "/root-uuid" (reference "U1") (unit 1)))))
)`;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
function makeCtx(doc) {
  const ctx = { K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null,
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; }, setSelection(ids) { ctx.selection = new Set(ids); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU), c.sexpr); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); } };
  return ctx;
}
const added = (ctx) => ctx.log[ctx.log.length - 1].changes.map((c) => ctx.doc.items.get(c.id));

test("pinAt: the pin's line from its end to the body; the body itself and hidden pins are not pins", () => {
  const doc = K.parseDoc(SHEET);
  const h = _.pinAt(doc, [43.18, 48.26], 0.2); assert.ok(h); assert.strictEqual(h.pin.number, "1"); assert.strictEqual(h.item.id, "u1");
  assert.strictEqual(_.pinAt(doc, [44.45, 48.26], 0.2).pin.number, "1", "along the pin");
  assert.strictEqual(_.pinAt(doc, [50.8, 50.8], 0.2), null, "the body");
  assert.strictEqual(_.pinAt(doc, [58.42, 53.34], 0.2), null, "a hidden pin");
  assert.strictEqual(_.pinAt(doc, [58.42, 53.34], 0.2, true).pin.number, "5", "shown hidden pins");
});
test("Pin Helpers: Net Label named after the pin, facing away from the body (\"Label Pins\")", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.pinHelper(ctx, [{ id: "u1", number: "1" }], "label");
  const [l] = added(ctx); assert.strictEqual(ctx.log[0].label, "Label Pins");
  assert.strictEqual(l.kind, "label"); assert.strictEqual(str(l.node[1]), "IN");
  assert.deepStrictEqual(atOf(l.node), [43.18, 48.26, 180]);
  assert.deepStrictEqual(kid(kid(l.node, "effects"), "justify"), ["justify", "right", "bottom"]);
  assert.deepStrictEqual([...ctx.selection], [l.id]);
});
test("Pin Helpers: Global Label shape from the pin type; an unnamed pin is REF_NUMBER", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.pinHelper(ctx, [{ id: "u1", number: "2" }], "global_label");
  let [g] = added(ctx); assert.strictEqual(str(kid(g.node, "shape")[1]), "output"); assert.strictEqual(atOf(g.node)[2], 0);
  _.pinHelper(ctx, [{ id: "u1", number: "3" }], "hierarchical_label");
  [g] = added(ctx); assert.strictEqual(g.kind, "hierarchical_label"); assert.strictEqual(str(g.node[1]), "U1_3");
  assert.strictEqual(str(kid(g.node, "shape")[1]), "bidirectional"); assert.strictEqual(atOf(g.node)[2], 90, "top pin: UP");
  _.pinHelper(ctx, [{ id: "u1", number: "4" }], "global_label");
  [g] = added(ctx); assert.strictEqual(str(kid(g.node, "shape")[1]), "passive", "unspecified -> L_UNSPECIFIED"); assert.strictEqual(atOf(g.node)[2], 270);
});
test("Pin Helpers: No Connect on the pin, Wire stub one grid step out", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.pinHelper(ctx, [{ id: "u1", number: "2" }], "noconnect");
  let [n] = added(ctx); assert.strictEqual(ctx.log[0].label, "No Connect Pins"); assert.strictEqual(n.kind, "no_connect"); assert.deepStrictEqual(atOf(n.node).slice(0, 2), [58.42, 48.26]);
  _.pinHelper(ctx, [{ id: "u1", number: "3" }], "wire");
  [n] = added(ctx); assert.strictEqual(ctx.log[1].label, "Wire Pins"); assert.deepStrictEqual(ptsOf(n.node), [[50.8, 43.18], [50.8, 41.91]]);
});
test("Pin Function: alternates by name after the base; choosing one writes (alternate …), the base clears it", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc), r = { id: "u1", number: "4" };
  assert.strictEqual(_.pinAlternates(doc, { id: "u1", number: "1" }), null);
  const a = _.pinAlternates(doc, r); assert.deepStrictEqual(a, { base: "PA0", alts: ["UART_TX", "ADC0"], current: "" });
  assert.ok(_.setAltPinFunction(ctx, r, "ADC0"));
  const c = ctx.log[0].changes[0]; assert.ok(/\(pin "4" \(uuid "p4"\) \(alternate "ADC0"\)\)/.test(c.sexpr), c.sexpr);
  assert.strictEqual(_.pinAlternates(doc, r).current, "ADC0");
  assert.ok(_.setAltPinFunction(ctx, r, "PA0")); assert.strictEqual(_.pinAlternates(doc, r).current, "");
  assert.ok(!_.setAltPinFunction(ctx, r, "PA0"), "no change, no commit");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
