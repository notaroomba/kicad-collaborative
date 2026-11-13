// sch-sweep9.test.js — schematic parity fixes of sweep 9: ERC pin conflicts per pin (TestPinToPin), the pin map's
// UNCONNECTED value, hidden and stacked pins, and the dangling cache after a cancelled duplicate.
// Run: node server/static/tests/sch-sweep9.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(),
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
// a one-pin symbol of the given type; `pins` overrides with several (type, name, number, x, y, hide)
const PIN = (type, name, num, x, y, hide) => `(pin ${type} line (at ${x} ${y} 0) (length 2.54)${hide ? " (hide yes)" : ""} (name "${name}" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))`;
const LIB = (name, ref, pins) => `(symbol "${name}" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "${ref}" (at 0 -2.54 0) (effects (font (size 1.27 1.27)))) (property "Value" "${name.split(":")[1]}" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
  (symbol "${name.split(":")[1]}_1_1" ${pins}))`;
function fresh() { const d = K.parseDoc(HEAD + ")"), c = makeCtx(d); sch.onDocChanged(c); return { d, c }; }
function place(c, lib, at, ref) { const n = _.symbolNode(c.doc, lib, at, 0, ""); if (ref) _.setReference(n, ref); return K.createItem(c.doc, n); }
const wire = (d, a, b) => K.createItem(d, _.lineNode("wire", a, b));
const p2p = (ms) => ms.filter((m) => m.code === "pin_to_pin");

test("pin map: UNCONNECTED (3) is an error like PP_ERROR, only WARNING (1) is a warning (ercErrorCode)", () => {
  const { d, c } = fresh();
  d.lib.set("T:OUT", K.parse(LIB("T:OUT", "U", PIN("output", "P", "1", 0, 0))));
  place(c, "T:OUT", [50.8, 50.8], "U1"); place(c, "T:OUT", [76.2, 50.8], "U2"); wire(d, [50.8, 50.8], [76.2, 50.8]);
  const map = (v) => Array.from({ length: 12 }, () => Array(12).fill(v));
  assert.strictEqual(p2p(sch.ercCheck(d, { pinMap: map(0) })).length, 0);
  assert.deepStrictEqual(p2p(sch.ercCheck(d, { pinMap: map(1) })).map((m) => m.severity), ["warning"]);
  assert.deepStrictEqual(p2p(sch.ercCheck(d, { pinMap: map(2) })).map((m) => m.severity), ["error"]);
  assert.deepStrictEqual(p2p(sch.ercCheck(d, { pinMap: map(3) })).map((m) => m.severity), ["error"], "UNCONNECTED is ERCE_PIN_TO_PIN_ERROR");
  assert.strictEqual(_.pinErrorSeverity(3), "error"); assert.strictEqual(_.pinErrorSeverity(1), "warning");
  // an out-of-range entry is skipped by ERC_SETTINGS' loader: the default stays
  const bad = map(7); assert.strictEqual(_.pinErrorAt(bad, "output", "output"), 2);
});

test("pin-to-pin: one marker per offending pin, heaviest pin type first, paired with its nearest conflicting pin", () => {
  const { d, c } = fresh();
  d.lib.set("T:OUT", K.parse(LIB("T:OUT", "U", PIN("output", "P", "1", 0, 0))));
  place(c, "T:OUT", [50.8, 50.8], "U1"); place(c, "T:OUT", [76.2, 50.8], "U2"); place(c, "T:OUT", [127, 50.8], "U3");
  wire(d, [50.8, 50.8], [127, 50.8]);
  const ms = p2p(sch.ercCheck(d));
  // U1 (sorted first) pairs with U2, its nearest; U3 still conflicts with U2: a second marker on U2 paired with U3
  assert.deepStrictEqual(ms.map((m) => m.text).sort(), ["Pins of type Output and Output are connected: U1 pin 1 (P) and U2 pin 1 (P)", "Pins of type Output and Output are connected: U2 pin 1 (P) and U3 pin 1 (P)"]);
  // an unspecified pin (weight 10) outranks the outputs (3): it carries the first marker
  d.lib.set("T:UNS", K.parse(LIB("T:UNS", "U", PIN("unspecified", "Q", "1", 0, 0))));
  const u = place(c, "T:UNS", [101.6, 63.5], "U4"); wire(d, [101.6, 63.5], [101.6, 50.8]);
  const ms2 = p2p(sch.ercCheck(d));
  assert.ok(ms2.some((m) => m.ids[0] === u.id && m.severity === "warning" && /Unspecified and Output/.test(m.text)), ms2.map((m) => m.text).join(" | "));
});

test("pin-to-pin: hidden pins take part, stacked pins of one symbol do not", () => {
  const { d, c } = fresh();
  d.lib.set("T:OUT", K.parse(LIB("T:OUT", "U", PIN("output", "P", "1", 0, 0))));
  d.lib.set("T:HID", K.parse(LIB("T:HID", "U", PIN("output", "H", "1", 0, 0, true))));
  place(c, "T:OUT", [50.8, 50.8], "U1"); place(c, "T:HID", [76.2, 50.8], "U2"); wire(d, [50.8, 50.8], [76.2, 50.8]);
  assert.strictEqual(p2p(sch.ercCheck(d)).length, 1, "a hidden output still clashes (erc.cpp collects every SCH_PIN)");
  const { d: d2, c: c2 } = fresh();
  d2.lib.set("T:STK", K.parse(LIB("T:STK", "U", PIN("output", "OUT", "1", 0, 0) + PIN("output", "OUT", "2", 0, 0) + PIN("passive", "OUT", "3", 0, 0))));
  place(c2, "T:STK", [50.8, 50.8], "U1"); wire(d2, [50.8, 50.8], [63.5, 50.8]);
  assert.strictEqual(p2p(sch.ercCheck(d2)).length, 0, "stacked pins (same place, same name) never conflict");
  assert.ok(_.stackedPins({ item: 1, p: [0, 0], pin: { name: "A", type: "output" } }, { item: 1, p: [0, 0], pin: { name: "A", type: "passive" } }));
  assert.ok(!_.stackedPins({ item: 1, p: [0, 0], pin: { name: "A", type: "output" } }, { item: 1, p: [0, 0], pin: { name: "A", type: "input" } }));
  assert.ok(!_.stackedPins({ item: 1, p: [0, 0], pin: { name: "A", type: "output" } }, { item: 2, p: [0, 0], pin: { name: "A", type: "output" } }));
});

test("StrNumCmp orders references and pin numbers numerically", () => {
  assert.deepStrictEqual(["U10", "U2", "U1", "R3"].sort(_.strNumCmp), ["R3", "U1", "U2", "U10"]);
});

test("duplicate, move, Esc: the dropped copy's ends no longer dangle, so a click there does not autostart a wire", () => {
  const { d, c } = fresh();
  const w = wire(d, [25.4, 25.4], [50.8, 25.4]);
  K.createItem(d, _.labelNode("label", "A", [25.4, 25.4], 0)); K.createItem(d, _.labelNode("label", "B", [50.8, 25.4], 0));
  if (_.setFollow) _.setFollow(true);
  c.selection = new Set([w.id]); sch.select(w.id);
  const n0 = d.items.size;
  assert.ok(sch.runAction("duplicate", c));
  assert.ok(sch.state.drag, "the copy rides the cursor");
  _.moveDrag(c, [38.1, 38.1]);
  const tip = sch.state.drag ? null : null; void tip;
  // the in-flight copy's ends dangle somewhere below the original
  const loose = _.danglingEnds(d).filter((e) => e.item.kind === "wire").map((e) => e.p);
  assert.ok(loose.length >= 1, "the copy dangles while in flight");
  // the cache is rebuilt while dragging: make sure it holds the in-flight ends
  assert.ok(loose.some((p) => _.autostartKind(d, p) === "wire"));
  _.endDrag(c, false);
  assert.strictEqual(d.items.size, n0, "the copy is gone");
  for (const p of loose) assert.strictEqual(_.autostartKind(d, p), null, "nothing dangles at " + p);
  if (_.setFollow) _.setFollow(false);
});

test("Place Sheet Pins: the next unplaced hierarchical label rides the sheet edge; KiCad's status texts", () => {
  const { d, c } = fresh();
  const sheet = K.createItem(d, _.sheetNode([50.8, 50.8], [76.2, 76.2], "Sub", "Sub.kicad_sch"));
  const HL = (n, sh, y) => `(hierarchical_label "${n}" (shape ${sh}) (at 10 ${y} 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "h-${n}"))`;
  c.sheetDocs = new Map([["Sub.kicad_sch", HEAD + HL("B", "output", 10) + HL("a10", "input", 20) + HL("A2", "bidirectional", 30) + ")"]]);
  c.toasts.length = 0;
  sch.onActivate("sheetpin", c);
  assert.ok(sch.onPointerDown({ button: 0 }, [10, 10], c));
  assert.ok(c.toasts.includes("Click over a sheet."), c.toasts.join("|"));
  // a click anywhere over the sheet starts: StrNumCmp ignoring case puts A2 before a10 before B
  sch.onPointerMove({}, [60, 60], c); sch.onPointerDown({ button: 0 }, [60, 60], c);
  const pp = sch.state.pinPlace; assert.ok(pp && pp.name === "A2" && pp.shape === "bidirectional", JSON.stringify(pp && pp.name));
  // it rides the nearest edge: the right one here
  sch.onPointerMove({}, [75, 63.5], c); assert.deepStrictEqual([sch.state.pinPlace.side, sch.state.pinPlace.p], ["right", [76.2, 63.5]]);
  sch.onPointerDown({ button: 0 }, [75, 63.5], c);
  let pins = K.kids(d.items.get(sheet.id).node, "pin"); assert.deepStrictEqual(pins.map((p) => [p[1], p[2]]), [["A2", "bidirectional"]]);
  assert.strictEqual(c.log[c.log.length - 1].label, "Add Sheet Pin");
  assert.strictEqual(sch.state.pinPlace.name, "a10", "the next label comes up at once");
  sch.onPointerMove({}, [52, 55.88], c); sch.onPointerDown({ button: 0 }, [52, 55.88], c);
  assert.strictEqual(sch.state.pinPlace.name, "B");
  // Esc drops the pin on the cursor; the next click over the sheet brings it back
  _.onKeyCapture({ key: "Escape", target: null, stopImmediatePropagation() {}, preventDefault() {} }); assert.ok(!sch.state.pinPlace);
  sch.onPointerDown({ button: 0 }, [60, 60], c); assert.strictEqual(sch.state.pinPlace.name, "B");
  sch.onPointerDown({ button: 0 }, [60, 76.2], c);
  pins = K.kids(d.items.get(sheet.id).node, "pin"); assert.deepStrictEqual(pins.map((p) => p[1]), ["A2", "a10", "B"]);
  assert.ok(!sch.state.pinPlace && c.toasts.includes("No new hierarchical labels found."), c.toasts.join("|"));
  sch.onActivate("select", c);
});

test("inter-sheet references: ${INTERSHEET_REFS} resolves from the page refs map, shown only with the Formatting option", () => {
  const R = (o) => Object.assign({ show: true, ownPage: true, short: false, prefix: "[", suffix: "]", pages: { SIG: [3, 1, 2] }, names: { 1: "1", 2: "2", 3: "7" }, current: 1 }, o || {});
  assert.strictEqual(K.intersheetRefsText(R(), "SIG"), "[1,2,7]");
  assert.strictEqual(K.intersheetRefsText(R({ ownPage: false }), "SIG"), "[2,7]");
  assert.strictEqual(K.intersheetRefsText(R({ short: true }), "SIG"), "[1..7]");
  assert.strictEqual(K.intersheetRefsText(R({ short: true, ownPage: false }), "SIG"), "[2,7]", "the short form needs more than two pages");
  assert.strictEqual(K.intersheetRefsText(R({ prefix: "<", suffix: ">" }), "OTHER"), "<?>");
  const d = K.parseDoc(HEAD + '(global_label "SIG" (shape input) (at 50.8 50.8 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g1") (property "Intersheetrefs" "${INTERSHEET_REFS}" (at 50.8 50.8 0) (hide yes) (effects (font (size 1.27 1.27)) (justify left)))))');
  const refText = () => d.items.get("g1").geom.filter((g) => g.field === "Intersheetrefs").map((g) => g.text);
  assert.deepStrictEqual(refText(), [], "hidden by default (no settings)");
  K.setIntersheetRefs(R(), d); assert.deepStrictEqual(refText(), ["[1,2,7]"]);
  const g = d.items.get("g1").geom.find((x) => x.field === "Intersheetrefs"); assert.ok(g.x > 52, "autoplaced beside the label body, not on its anchor");
  K.setIntersheetRefs(R({ show: false }), d); assert.deepStrictEqual(refText(), []);
});

console.log(`sch-sweep9: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
