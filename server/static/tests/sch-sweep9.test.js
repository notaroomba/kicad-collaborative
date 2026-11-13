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

// ---- ERC_TESTER tests beyond connectivity
const lab = (d, kind, text, at) => K.createItem(d, _.labelNode(kind, text, at, 0));
const POWER_LIB = (name, pinName) => `(symbol "${name}" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -2.54 0) (effects (font (size 1.27 1.27)))) (property "Value" "${name.split(":")[1]}" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
  (symbol "${name.split(":")[1]}_1_1" ${PIN("power_in", pinName, "1", 0, 0, true)}))`;
const codes = (ms, code) => ms.filter((m) => m.code === code);

test("ERC helpers: isGround, stacked pin notation, LetterSubReference, similar-name normalisation", () => {
  for (const n of ["GND", "AGND", "gnd_iso", "EARTH", "EARTH_1", "VSS", "vssa"]) assert.ok(_.isGroundName(n), n);
  for (const n of ["VCC", "EARTHX", "VSSD", ""]) assert.ok(!_.isGroundName(n), n);
  for (const n of ["1", "A1", "[1,2,3]", "[1-4]", "[A1-A4,B2]", "[1\\-2]"]) assert.ok(_.stackedPinNotationValid(n), n);
  for (const n of ["1]", "[1", "A[1]", "[4-1]", "[A1-B4]", "[]", "[A-B]"]) assert.ok(!_.stackedPinNotationValid(n), n);
  assert.deepStrictEqual([1, 2, 26, 27, 52, 53].map(_.letterSubReference), ["A", "B", "Z", "AA", "AZ", "BA"]);
  assert.strictEqual(_.normalizeSimilar(" +5V "), "5v"); assert.strictEqual(_.normalizeSimilar("10µF"), "10uf");
  assert.strictEqual(_.normalizeSimilar("10μF"), "10uf"); assert.strictEqual(_.normalizeSimilar("Net"), "net");
});

test("ERC: duplicate sheet names, field name whitespace, empty power value, undefined netclass", () => {
  const { d, c } = fresh();
  const sh = (name, x) => K.createItem(d, K.parse(`(sheet (at ${x} 25.4) (size 12.7 12.7) (uuid "${name}-${x}") (property "Sheetname" "${name}" (at ${x} 24.4 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "${x}.kicad_sch" (at ${x} 39 0) (effects (font (size 1.27 1.27)))))`));
  sh("Power", 25.4); sh("power", 50.8);
  d.lib.set("T:R", K.parse(LIB("T:R", "R", PIN("passive", "~", "1", 0, 0))));
  const r = place(c, "T:R", [101.6, 101.6], "R1");
  r.node.push(K.parse('(property " MPN" "x" (at 104 104 0) (effects (font (size 1.27 1.27)) (hide yes)))'));
  d.lib.set("power:VBUS", K.parse(POWER_LIB("power:VBUS", "VBUS")));
  const p = place(c, "power:VBUS", [127, 76.2], "#PWR1");
  K.kids(p.node, "property").find((q) => K.str(q[1]) === "Value")[2] = "";
  const nc = K.createItem(d, K.parse('(netclass_flag "" (length 2.54) (shape round) (at 152.4 76.2 0) (uuid "nc1") (property "Netclass" "HighSpeed" (at 153 74 0) (effects (font (size 1.27 1.27)))))'));
  let ms = sch.ercCheck(d, { netclasses: ["Default", "Power"] });
  const dup = codes(ms, "duplicate_sheet_names"); assert.strictEqual(dup.length, 1); assert.strictEqual(dup[0].text, "Duplicate sheet names within a given sheet");
  const ws = codes(ms, "field_name_whitespace"); assert.strictEqual(ws.length, 1); assert.strictEqual(ws[0].text, "Field name has leading or trailing whitespace: ' MPN'"); assert.deepStrictEqual([ws[0].x, ws[0].y], [104, 104]);
  const ep = codes(ms, "empty_power_value"); assert.strictEqual(ep.length, 1); assert.deepStrictEqual([ep[0].x, ep[0].y], [127, 76.2]);
  const un = codes(ms, "undefined_netclass"); assert.deepStrictEqual(un.map((m) => m.text), ["Netclass HighSpeed is not defined"]); assert.deepStrictEqual(un[0].ids, [nc.id]);
  // without the project's netclasses the test is not run; a defined class passes
  assert.strictEqual(codes(sch.ercCheck(d), "undefined_netclass").length, 0);
  assert.strictEqual(codes(sch.ercCheck(d, { netclasses: ["HighSpeed"] }), "undefined_netclass").length, 0);
});

test("ERC: ground pins, stacked pin syntax and endpoints off the connection grid", () => {
  const { d, c } = fresh();
  d.lib.set("T:REG", K.parse(LIB("T:REG", "U", PIN("power_in", "GND", "1", 0, 0) + " " + PIN("power_in", "AGND", "2", 0, 2.54) + " " + PIN("passive", "X", "[3-1]", 0, 5.08))));
  d.lib.set("power:GND", K.parse(POWER_LIB("power:GND", "GND")));
  const u = place(c, "T:REG", [50.8, 50.8], "U1");
  // pin 1 on GND, pin 2 (named AGND) on net SIG: pin 2 is a ground pin off ground
  place(c, "power:GND", [45.72, 50.8], "#PWR1"); wire(d, [45.72, 50.8], [50.8, 50.8]);
  wire(d, [50.8, 48.26], [40.64, 48.26]); lab(d, "label", "SIG", [40.64, 48.26]);
  let ms = sch.ercCheck(d);
  const g = codes(ms, "ground_pin_not_ground"); assert.deepStrictEqual(g.map((m) => m.text), ["Pin AGND not connected to ground net"]); assert.deepStrictEqual([g[0].x, g[0].y], [50.8, 48.26]);
  assert.strictEqual(codes(ms, "stacked_pin_name").length, 1, "[3-1] counts down");
  assert.strictEqual(codes(ms, "endpoint_off_grid").length, 0);
  // a wire end off the 50 mil grid (its start is checked first), and a symbol with an off-grid pin (one marker)
  const w = wire(d, [60.96, 60.96], [61.5, 60.96]);
  const v = place(c, "T:REG", [80.3, 80.01], "U2");
  ms = sch.ercCheck(d);
  const og = codes(ms, "endpoint_off_grid"); assert.strictEqual(og.length, 2);
  assert.ok(og.some((m) => m.ids[0] === w.id && m.x === 61.5)); assert.ok(og.some((m) => m.ids[0] === v.id && m.x === 80.3 && m.y === 80.01));
  // a coarser connection grid (100 mil) moves the wire off it too
  const w2 = wire(d, [3.81, 3.81], [6.35, 3.81]);
  assert.ok(!codes(sch.ercCheck(d), "endpoint_off_grid").some((m) => m.ids[0] === w2.id));
  assert.deepStrictEqual(codes(sch.ercCheck(d, { connectionGrid: 2.54 }), "endpoint_off_grid").filter((m) => m.ids[0] === w2.id).map((m) => [m.x, m.y]), [[3.81, 3.81]]);
});

test("ERC: similar names, local vs global names, single global labels (TestSimilarLabels / TestSameLocalGlobalLabel)", () => {
  const { d, c } = fresh();
  lab(d, "label", "Data", [25.4, 25.4]); lab(d, "label", "DATA", [50.8, 25.4]);
  lab(d, "global_label", "CLK", [25.4, 50.8]); lab(d, "label", "CLK", [50.8, 50.8]);
  d.lib.set("power:+5V", K.parse(POWER_LIB("power:+5V", "+5V"))); d.lib.set("power:5v", K.parse(POWER_LIB("power:5v", "5v")));
  place(c, "power:+5V", [76.2, 76.2], "#PWR1"); place(c, "power:5v", [101.6, 76.2], "#PWR2");
  const ms = sch.ercCheck(d);
  assert.strictEqual(codes(ms, "similar_labels").length, 1); assert.strictEqual(codes(ms, "similar_labels")[0].text, "Labels are similar");
  assert.strictEqual(codes(ms, "similar_power").length, 1, "+5V and 5v are the same once the + prefix and case go");
  const sg = codes(ms, "same_local_global_label"); assert.strictEqual(sg.length, 1); assert.strictEqual(sg[0].text, "Local and global labels have same name");
  assert.deepStrictEqual([sg[0].x, sg[0].y], [25.4, 50.8], "on the global one");
  const single = codes(ms, "single_global_label"); assert.strictEqual(single.length, 1, "reported; ERC_SETTINGS ignores it by default");
  // across sheets: local labels on different sheets are fine, a global label used on two sheets is not single
  const a = fresh().d, b = fresh().d;
  lab(a, "label", "net1", [25.4, 25.4]); lab(b, "label", "NET1", [25.4, 25.4]);
  lab(a, "global_label", "BUS", [50.8, 25.4]); lab(b, "global_label", "BUS", [50.8, 25.4]);
  const per = sch.ercHierarchy([{ doc: a, key: "a" }, { doc: b, key: "b" }]);
  assert.strictEqual(per.flat().filter((m) => m.code === "similar_labels").length, 0);
  assert.strictEqual(per.flat().filter((m) => m.code === "single_global_label").length, 0);
});

test("ERC: multi-unit symbols: missing units, different footprints and values across units", () => {
  const { d, c } = fresh();
  const unit = (u, pins) => `(symbol "OPA_${u}_1" ${pins})`;
  d.lib.set("T:OPA", K.parse(`(symbol "T:OPA" (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "OPA" (at 0 0 0) (effects (font (size 1.27 1.27))))
    ${unit(1, PIN("output", "O", "1", 0, 0))} ${unit(2, PIN("input", "I", "2", 0, 0))} ${unit(3, PIN("power_in", "V", "3", 0, 0))} (symbol "OPA_4_1" (unit_name "Bias") ${PIN("bidirectional", "B", "4", 0, 0)}))`));
  const fp = (it, f) => { const p = K.kids(it.node, "property").find((q) => K.str(q[1]) === "Footprint"); if (p) p[2] = f; else it.node.push(K.parse(`(property "Footprint" "${f}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))`)); };
  const a = place(c, "T:OPA", [50.8, 50.8], "U1");
  fp(a, "Package_SO:SOIC-8");
  const ms = sch.ercCheck(d);
  assert.deepStrictEqual(codes(ms, "missing_unit").map((m) => m.text), ["Symbol U1 has unplaced units [ B, C, Bias ]"]);
  assert.deepStrictEqual(codes(ms, "missing_input_pin").map((m) => m.text), ["Symbol U1 has input pins in units [ B ] that are not placed"]);
  assert.deepStrictEqual(codes(ms, "missing_power_pin").map((m) => m.text), ["Symbol U1 has input power pins in units [ C ] that are not placed"]);
  assert.deepStrictEqual(codes(ms, "missing_bidi_pin").map((m) => m.text), ["Symbol U1 has bidirectional pins in units [ Bias ] that are not placed"]);
  // unit B with another footprint and value on a second sheet
  const { d: d2, c: c2 } = fresh(); d2.lib.set("T:OPA", d.lib.get("T:OPA"));
  const b = place(c2, "T:OPA", [50.8, 50.8], "U1"); b.node.splice(b.node.findIndex((x) => Array.isArray(x) && x[0] === "unit"), 1, ["unit", 2]);
  fp(b, "Package_SO:SOIC-14"); K.kids(b.node, "property").find((q) => K.str(q[1]) === "Value")[2] = "OPA2";
  const per = sch.ercHierarchy([{ doc: d, key: "root" }, { doc: d2, key: "sub" }]);
  const dfp = per[1].filter((m) => m.code === "different_unit_footprint"); assert.deepStrictEqual(dfp.map((m) => m.text), ["Different footprints assigned to U1A and U1B"]);
  assert.deepStrictEqual(per[0].filter((m) => m.code === "unit_value_mismatch").map((m) => m.text), ["Different values for U1A (OPA) and U1B (OPA2)"]);
  assert.deepStrictEqual(per[0].filter((m) => m.code === "missing_unit").map((m) => m.text), ["Symbol U1 has unplaced units [ C, Bias ]"]);
});

test("repeat: a directive label steps its Netclass and Component Class fields (SCH_DIRECTIVE_LABEL::IncrementLabel)", () => {
  const n = K.parse('(netclass_flag "" (length 2.54) (shape round) (at 10 10 0) (property "Netclass" "BUS3" (at 10 8 0)) (property "Component Class" "grp09" (at 10 6 0)) (property "Other" "X1" (at 10 4 0)))');
  assert.strictEqual(_.incrementLabelNode("netclass_flag", n, 2), true);
  const val = (name) => K.str(K.kids(n, "property").find((q) => K.str(q[1]) === name)[2]);
  assert.deepStrictEqual([val("Netclass"), val("Component Class"), val("Other")], ["BUS5", "grp11", "X1"]);
  assert.strictEqual(_.incrementLabelNode("netclass_flag", n, -20), false, "below zero");
  assert.strictEqual(val("Netclass"), "BUS5");
  const l = K.parse('(label "D7" (at 0 0 0))'); assert.ok(_.incrementLabelNode("label", l, 1)); assert.strictEqual(l[1], "D8");
  assert.ok(!_.incrementLabelNode("label", l, -9)); assert.strictEqual(l[1], "D8");
  // Insert after placing one: the repeated flag carries the next class
  const { d, c } = fresh(); sch.state.repeatOffset = [0, 2.54]; sch.state.repeatIncrement = 1;
  const it = K.createItem(d, K.parse('(netclass_flag "" (length 2.54) (shape round) (at 25.4 25.4 0) (uuid "f1") (property "Netclass" "HS1" (at 25.4 23 0) (effects (font (size 1.27 1.27)))))'));
  _.rememberPlaced(it.kind, it.node); assert.ok(_.repeatLast(c));
  const flags = Array.from(d.items.values()).filter((x) => x.kind === "netclass_flag").map((x) => K.str(K.kids(x.node, "property")[0][2]));
  assert.deepStrictEqual(flags.sort(), ["HS1", "HS2"]);
});

test("Increment Annotations From: references of the start's prefix numbered at least the start's move up", () => {
  const { d, c } = fresh();
  d.lib.set("T:R", K.parse(LIB("T:R", "R", PIN("passive", "~", "1", 0, 0))));
  const refs = ["R1", "R5", "R7", "R12", "RV3", "C7"]; refs.forEach((r, i) => place(c, "T:R", [25.4 + i * 12.7, 25.4], r));
  const ch = sch.incrementAnnotationChanges(d, "R5", 10);
  assert.strictEqual(ch.length, 3);
  for (const x of ch) assert.ok(K.applyChange(d, x, IU));
  const now = Array.from(d.items.values()).filter((x) => x.kind === "symbol").map((x) => K.str(K.kids(x.node, "property").find((q) => K.str(q[1]) === "Reference")[2]));
  assert.deepStrictEqual(now.sort(), ["C7", "R1", "R15", "R17", "R22", "RV3"]);
  assert.strictEqual(sch.incrementAnnotationChanges(d, "R", 1).length, 0, "no number: nothing to split");
});

console.log(`sch-sweep9: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
