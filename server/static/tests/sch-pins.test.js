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
  assert.strictEqual(_.pinAt(doc, [53.5, 51.5], 0.2), null, "the body");
  // show_pin_alt_icons: pin 4 (PA0, with alternates) draws its icon beyond its inside name, near the body centre,
  // and PIN_LAYOUT_CACHE::GetPinBoundingBox merges that icon's box
  assert.strictEqual(_.pinAt(doc, [50.8, 50.8], 0.2).pin.number, "4", "the alternate icon is part of the pin");
  assert.strictEqual(_.pinAt(doc, [58.42, 53.34], 0.2), null, "a hidden pin");
  assert.strictEqual(_.pinAt(doc, [58.42, 53.34], 0.2, true).pin.number, "5", "shown hidden pins");
});
test("Properties: a selected pin shows SCH_PIN's rows (name, number, type, style, library orientation, length)", () => {
  const doc = K.parseDoc(SHEET);
  const v = (r) => r.map((x) => [x.name, x.type, x.value]);
  assert.deepStrictEqual(v(_.pinProperties(doc, { id: "u1", number: "2" })), [["Pin Name", "text", "OUT"], ["Pin Number", "text", "2"], ["Electrical Type", "enum", "output"], ["Graphic Style", "enum", "line"], ["Orientation", "enum", "180"], ["Length", "length", 2.54]]);
  const q = _.pinProperties(doc, { id: "u1", number: "3" });
  assert.strictEqual(q[0].value, "~", "GetName keeps the raw name");
  assert.strictEqual(q[4].choices.find((c) => c[0] === q[4].value)[1], "Down", "270 is PIN_DOWN");
  assert.strictEqual(q[2].choices.find((c) => c[0] === q[2].value)[1], "Bidirectional");
  assert.strictEqual(_.pinProperties(doc, { id: "u1", number: "9" }), null, "a pin that is gone");
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
test("Pin Helpers > Wire with a pointer: the stub ends ride the cursor at once; the click pushes \"Wire Pins\", Esc leaves nothing", () => {
  _.setFollow(true);
  try {
    const doc = K.parseDoc(SHEET), ctx = makeCtx(doc); ctx.cursor = [52, 40];
    const ids = _.pinHelper(ctx, [{ id: "u1", number: "3" }, { id: "u1", number: "1" }], "wire");
    assert.strictEqual(ids.length, 2); assert.strictEqual(ctx.log.length, 0, "nothing committed while dragging");
    assert.deepStrictEqual([...ctx.selection].sort(), ids.slice().sort(), "the stubs are the selection");
    assert.deepStrictEqual(ptsOf(doc.items.get(ids[0]).node), [[50.8, 43.18], [50.8, 41.91]], "one grid step out");
    sch.moveDrag(ctx, [52 + 2.54, 40 - 1.27]);
    assert.deepStrictEqual(ptsOf(doc.items.get(ids[0]).node), [[50.8, 43.18], [53.34, 40.64]], "the end follows, the pin end stays");
    assert.deepStrictEqual(ptsOf(doc.items.get(ids[1]).node), [[43.18, 48.26], [44.45, 46.99]], "every stub end moves by the same step");
    sch.endDrag(ctx, true);
    assert.strictEqual(ctx.log.length, 1); assert.strictEqual(ctx.log[0].label, "Wire Pins");
    const wires = ctx.log[0].changes.filter((c) => c.kind === "ADDED").map((c) => doc.items.get(c.id)).filter((it) => it && it.kind === "wire");
    assert.strictEqual(wires.length, 2); assert.deepStrictEqual(ptsOf(wires[0].node), [[50.8, 43.18], [53.34, 40.64]]);
    // Esc: the commit is reverted, the stubs go
    const doc2 = K.parseDoc(SHEET), ctx2 = makeCtx(doc2); ctx2.cursor = [52, 40]; const n0 = doc2.items.size;
    const ids2 = _.pinHelper(ctx2, [{ id: "u1", number: "2" }], "wire"); assert.ok(doc2.items.has(ids2[0]));
    sch.endDrag(ctx2, false);
    assert.strictEqual(ctx2.log.length, 0); assert.strictEqual(doc2.items.size, n0); assert.strictEqual(ctx2.selection.size, 0);
  } finally { _.setFollow(false); }
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

test("pinAt: the pin's shown name and number are part of it (GetBoundingBox( false, true )); m_PinSymbolSize / 4 floors an exact hit", () => {
  const doc = K.parseDoc(SHEET);
  // pin 1 (IN): connection point 43.18, root 45.72, the name inside the body from 46.736
  const h = _.pinAt(doc, [47.4, 48.26], 0); assert.ok(h, "on the name text"); assert.strictEqual(h.pin.number, "1");
  assert.strictEqual(_.pinAt(doc, [44.45, 47.2], 0).pin.number, "1", "on the number above the line");
  assert.strictEqual(_.pinAt(doc, [43.18 - 0.1, 48.26], 0).pin.number, "1", "just off the connection point, inside the floor");
  assert.strictEqual(_.pinAt(doc, [43.18 - 0.5, 48.26], 0), null, "beyond the floor");
  assert.strictEqual(_.pinAt(doc, [53.5, 51.5], 0), null, "inside the body, clear of the pins");
  const u = doc.items.get("u1"), b = _.pinBox(u, _.pinOf(doc, { id: "u1", number: "1" }).pin);
  assert.ok(b[2] > 46.736 && b[2] < 50.8, "the box reaches over the name, not to the centre: " + b);
});
test("Pin Helpers: No Connect leaves nothing selected (ClearSelection); Wire selects the stub", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc); ctx.selection = new Set(["u1"]);
  _.pinHelper(ctx, [{ id: "u1", number: "2" }], "noconnect");
  assert.deepStrictEqual([...ctx.selection], []);
  _.pinHelper(ctx, [{ id: "u1", number: "1" }], "wire");
  assert.strictEqual(ctx.selection.size, 1);
});
test("Pin Helpers: a label on a pin with an alternate takes the alternate's name and type (GetShownName / GetType)", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc), r = { id: "u1", number: "4" };
  assert.ok(_.setAltPinFunction(ctx, r, "UART_TX"));
  _.pinHelper(ctx, [r], "global_label");
  const [g] = added(ctx); assert.strictEqual(str(g.node[1]), "UART_TX"); assert.strictEqual(str(kid(g.node, "shape")[1]), "output");
  assert.ok(_.setAltPinFunction(ctx, r, "PA0"));
  _.pinHelper(ctx, [r], "global_label");
  const [g2] = added(ctx); assert.strictEqual(str(g2.node[1]), "PA0"); assert.strictEqual(str(kid(g2.node, "shape")[1]), "passive");
});
test("Attributes: Toggle Attribute turns the flag on when any selected item has it off, writes in_pos_files after on_board", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc); ctx.selection = new Set(["u1"]);
  assert.ok(sch.runAction("setExcludeFromPosFiles", ctx));
  const c = ctx.log[ctx.log.length - 1]; assert.strictEqual(c.label, "Toggle Attribute");
  assert.ok(/\(on_board yes\) \(in_pos_files no\) \(dnp no\)/.test(c.changes[0].sexpr), c.changes[0].sexpr);
  assert.ok(sch.runAction("setExcludeFromPosFiles", ctx));
  assert.ok(/\(in_pos_files yes\)/.test(ctx.log[ctx.log.length - 1].changes[0].sexpr));
  assert.ok(sch.runAction("setDNP", ctx)); assert.deepStrictEqual(kid(doc.items.get("u1").node, "dnp"), ["dnp", "yes"]);
});
test("Attributes: the editor's toggleAttribute hook gets the selection with the flag test and setter", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc); ctx.selection = new Set(["u1"]);
  const E0 = globalThis.CollabEditor; let got = null;
  globalThis.CollabEditor = Object.assign({}, E0 || {}, { toggleAttribute(c, items, isOn, set) { got = { items: items.map((i) => i.id), on: isOn(items[0].node), set: set(items[0].node, true) }; return true; } });
  try { assert.ok(sch.runAction("setExcludeFromBOM", ctx)); } finally { globalThis.CollabEditor = E0; }
  assert.deepStrictEqual(got.items, ["u1"]); assert.strictEqual(got.on, false); assert.deepStrictEqual(kid(got.set, "in_bom"), ["in_bom", "no"]);
  assert.strictEqual(ctx.log.length, 0, "the hook commits");
});

test("Swap Pin Labels: each pin's single net label takes the next pin's text, one commit (SwapPinLabels)", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.pinHelper(ctx, [{ id: "u1", number: "1" }, { id: "u1", number: "2" }, { id: "u1", number: "4" }], "label");
  const txt = () => ["1", "2", "4"].map((n) => str(_.singleNetLabelForPin(doc, { id: "u1", number: n }).node[1]));
  assert.deepStrictEqual(txt(), ["IN", "OUT", "PA0"]);
  ctx.log.length = 0;
  assert.strictEqual(_.swapPinLabels(ctx, [{ id: "u1", number: "1" }, { id: "u1", number: "2" }]), null);
  assert.strictEqual(ctx.log.length, 1); assert.strictEqual(ctx.log[0].label, "Swap Pin Labels"); assert.strictEqual(ctx.log[0].changes.length, 2);
  assert.deepStrictEqual(txt(), ["OUT", "IN", "PA0"]);
  // three pins rotate in selection order: a<->b, then b<->c
  _.swapPinLabels(ctx, [{ id: "u1", number: "1" }, { id: "u1", number: "2" }, { id: "u1", number: "4" }]);
  assert.deepStrictEqual(txt(), ["IN", "PA0", "OUT"]);
});
test("Swap Pin Labels: a pin without exactly one net label, or wired to another pin, is refused with the infobar error", () => {
  const doc = K.parseDoc(SHEET), ctx = makeCtx(doc);
  _.pinHelper(ctx, [{ id: "u1", number: "1" }], "label");
  assert.strictEqual(_.singleNetLabelForPin(doc, { id: "u1", number: "2" }), null);
  const n0 = ctx.log.length;
  assert.strictEqual(_.swapPinLabels(ctx, [{ id: "u1", number: "1" }, { id: "u1", number: "2" }]), "Each selected pin must have exactly one attached net label and no other pin connections.");
  assert.strictEqual(ctx.log.length, n0, "nothing committed");
  // a second label on the same pin: no single label
  _.pinHelper(ctx, [{ id: "u1", number: "1" }], "global_label");
  assert.strictEqual(_.singleNetLabelForPin(doc, { id: "u1", number: "1" }), null);
  // pin 2 wired to pin 1's net (a wire between the two pin ends) puts two pins in the subgraph
  const doc2 = K.parseDoc(SHEET), ctx2 = makeCtx(doc2);
  _.pinHelper(ctx2, [{ id: "u1", number: "1" }], "label");
  ctx2.commit([{ id: "w1", kind: "ADDED", typeName: "SCH_LINE", sexpr: '(wire (pts (xy 43.18 48.26) (xy 58.42 48.26)) (stroke (width 0) (type default)) (uuid "w1"))' }], "w");
  assert.strictEqual(_.singleNetLabelForPin(doc2, { id: "u1", number: "1" }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
