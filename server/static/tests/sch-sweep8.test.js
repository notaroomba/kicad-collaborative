// sch-sweep8.test.js — schematic parity fixes of sweep 8: R / X / Y during a Move or Drag act inside the move
// (SCH_MOVE_TOOL::handleMoveToolActions) and one undo / Esc takes it all back.
// Run: node server/static/tests/sch-sweep8.test.js
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
const pts = (it) => K.kid(it.node, "pts").slice(1).map((p) => [+p[1], +p[2]]);
const W = (id, a, b) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const L = (id, p, r = 0) => `(label "N1" (at ${p[0]} ${p[1]} ${r}) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id}"))`;
const snap = (doc) => { const m = {}; for (const it of doc.items.values()) m[it.id] = K.serialize(it.node); return JSON.stringify(m); };

test("R during a drag turns the item in flight, the drag goes on and Esc puts it all back", () => {
  const doc = K.parseDoc(HEAD + W("w1", [10.16, 10.16], [20.32, 10.16]) + L("l1", [15.24, 10.16]) + ")"), c = makeCtx(doc);
  const before = snap(doc);
  sch.select("w1");
  assert.ok(_.beginDrag(c, doc.items.get("w1"), [10.16, 10.16], false));
  _.moveDrag(c, [12.7, 12.7]);
  assert.ok(_.orientSelected(c, "ccw"));
  assert.ok(sch.state.drag, "the move keeps going");
  assert.strictEqual(c.log.length, 0, "nothing committed yet");
  _.moveDrag(c, [15.24, 15.24]);
  const p = pts(doc.items.get("w1"));
  assert.ok(Math.abs(p[0][0] - p[1][0]) < 1e-6, "the wire is vertical now: " + JSON.stringify(p));
  _.endDrag(c, false);
  assert.strictEqual(snap(doc), before, "Esc restores the wire and its label unturned");
});
test("a turned drag commits once and its undo record is the pre-drag item", () => {
  const doc = K.parseDoc(HEAD + W("w1", [10.16, 10.16], [20.32, 10.16]) + L("l1", [15.24, 10.16]) + ")"), c = makeCtx(doc);
  const orig = K.serialize(doc.items.get("w1").node);
  let seenOld = null; const commit = c.commit; c.commit = (ch, label) => { seenOld = K.serialize(doc.items.get("w1").node); commit(ch, label); };
  sch.select("w1");
  assert.ok(_.beginDrag(c, doc.items.get("w1"), [10.16, 10.16], false));
  _.moveDrag(c, [12.7, 12.7]); _.orientSelected(c, "cw"); _.orientSelected(c, "y");
  _.endDrag(c, true);
  assert.strictEqual(c.log.length, 1, "one commit");
  assert.strictEqual(seenOld, orig, "the document still held the pre-drag wire when the commit ran");
  const lab = doc.items.get("l1"), at = K.atOf(lab.node);
  const p = pts(doc.items.get("w1"));
  assert.ok(Math.abs(p[0][0] - p[1][0]) < 1e-6, "vertical after cw + mirror: " + JSON.stringify(p));
  assert.ok(Math.abs(at[0] - p[0][0]) < 1e-6, "the label rode along on the turned wire " + JSON.stringify([at, p]));
});
test("an unmoved drag that was only turned still commits the turn", () => {
  const doc = K.parseDoc(HEAD + L("l1", [15.24, 10.16]) + ")"), c = makeCtx(doc);
  sch.select("l1");
  assert.ok(_.beginDrag(c, doc.items.get("l1"), [15.24, 10.16], false));
  _.orientSelected(c, "ccw"); _.endDrag(c, true);
  assert.strictEqual(c.log.length, 1);
  assert.strictEqual(K.atOf(doc.items.get("l1").node)[2], 90);
});

test("Clarify Selection rows use GetItemDescription wording", () => {
  const doc = K.parseDoc(HEAD + W("w1", [10.16, 10.16], [20.32, 10.16]) + L("l1", [15.24, 10.16]) +
    '(bus (pts (xy 0 0) (xy 0 5.08)) (stroke (width 0) (type default)) (uuid "b1"))' +
    '(polyline (pts (xy 0 0) (xy 5.08 5.08) (xy 10.16 0)) (stroke (width 0) (type default)) (uuid "p1"))' +
    '(polyline (pts (xy 0 0) (xy 5.08 5.08)) (stroke (width 0) (type default)) (uuid "p2"))' +
    '(junction (at 1 1) (diameter 0) (color 0 0 0 0) (uuid "j1"))' +
    '(global_label "A_VERY_LONG_GLOBAL_LABEL_NAME_THAT_GOES_ON_AND_ON" (shape input) (at 3 3 0) (effects (font (size 1.27 1.27))) (uuid "g1"))' + ")");
  assert.strictEqual(sch.itemDescription(doc, "w1", "mm"), "Horizontal Wire, length 10.16 mm");
  assert.strictEqual(sch.itemDescription(doc, "b1", "mil"), "Vertical Bus, length 200 mils");
  assert.strictEqual(sch.itemDescription(doc, "p1", "mm"), "Polyline, 3 points");
  assert.ok(/^Graphic Line, length /.test(sch.itemDescription(doc, "p2", "mm")));
  assert.strictEqual(sch.itemDescription(doc, "l1", "mm"), "Label 'N1'");
  assert.strictEqual(sch.itemDescription(doc, "j1", "mm"), "Junction");
  assert.strictEqual(sch.itemDescription(doc, "g1", "mm"), "Global Label 'A_VERY_LONG_GLOBAL_LABEL_NAME_THAT...'");
});

test("BUS_UNFOLD_MENU entries: a vector's nets, a group's nets and nested buses with their nets", () => {
  const doc = K.parseDoc(HEAD + '(bus (pts (xy 0 0) (xy 50.8 0)) (stroke (width 0) (type default)) (uuid "b1"))' +
    '(label "CTL{RD WR D[0..1]}" (at 10.16 0 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))' + ")");
  const e = _.unfoldEntries(doc, doc.items.get("b1"));
  assert.deepStrictEqual(e, [{ name: "CTL.RD", bus: false, members: [] }, { name: "CTL.WR", bus: false, members: [] }, { name: "CTL.D[0..1]", bus: true, members: ["CTL.D0", "CTL.D1"] }]);
  assert.strictEqual(_.printBusForUI("A{slash}B"), "A/B");
  assert.strictEqual(_.printBusForUI("~{RST}"), "~RST");
});

test("Unfold from Bus finds the bus under the cursor even when a graphic line lies on it", () => {
  const doc = K.parseDoc(HEAD + '(polyline (pts (xy 20.32 0) (xy 60.96 0)) (stroke (width 0) (type dash)) (uuid "g1"))' +
    '(bus (pts (xy 0 0) (xy 50.8 0)) (stroke (width 0) (type default)) (uuid "b1"))' + ")");
  const c = makeCtx(doc); c.cursor = [30.48, 0];
  const b = _.busForUnfolding(c);
  assert.ok(b && b.id === "b1");
  c.cursor = [58.42, 0]; assert.strictEqual(_.busForUnfolding(c), null);
});

test("AutoPlaceSheetPins: outputs right, the rest left, sorted, below existing pins, the sheet grows", () => {
  const sheet = '(sheet (at 100 50) (size 20.32 5.08) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "s1")' +
    '(property "Sheetname" "sub" (at 100 49.2884 0) (effects (font (size 1.27 1.27)) (justify left bottom)))' +
    '(property "Sheetfile" "sub.kicad_sch" (at 100 55.6646 0) (effects (font (size 1.27 1.27)) (justify left top)))' +
    '(pin "A" input (at 100 52.54 180) (uuid "p1") (effects (font (size 1.27 1.27)) (justify left)))' +
    '(instances (project "p" (path "/x" (page "2")))))';
  const doc = K.parseDoc(HEAD + sheet + ")");
  const HL = (n, shape) => `(hierarchical_label "${n}" (shape ${shape}) (at 10 10 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "${n}${shape}"))`;
  const sub = K.parseDoc(HEAD + HL("Z", "input") + HL("A", "input") + HL("B", "bidirectional") + HL("OUT", "output") + HL("B", "input") + ")");
  const n = _.autoPlaceSheetPinsNode(doc.items.get("s1").node, sub);
  const pins = K.kids(n, "pin").map((p) => [K.str(p[1]), K.str(p[2]), +K.kid(p, "at")[1], +K.kid(p, "at")[2], +K.kid(p, "at")[3]]);
  assert.deepStrictEqual(pins, [["A", "input", 100, 52.54, 180], ["B", "bidirectional", 100, 54.61, 180], ["Z", "input", 100, 57.15, 180], ["OUT", "output", 120.32, 52.07, 0]]);   // the column start is snapped to the 50 mil grid
  assert.strictEqual(+K.kid(n, "size")[2], 10.16, "grown to the last pin plus a pitch");
  const ff = K.kids(n, "property").find((p) => K.str(p[1]) === "Sheetfile");
  assert.strictEqual(+K.kid(ff, "at")[2], 60.7446, "the file field follows the bottom edge");
  assert.strictEqual(K.serialize(n).indexOf("(instances") > K.serialize(n).lastIndexOf("(pin "), true);
  assert.strictEqual(_.autoPlaceSheetPinsNode(n, sub), null, "nothing left to place");
});

console.log(`sch-sweep8: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
