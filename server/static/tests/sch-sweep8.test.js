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

test("sizeSheet: the sheet keeps its origin, is at least 500 x 150 mil and its corner sits on the grid", () => {
  assert.deepStrictEqual(_.sheetCorner([100.33, 50.8], [90, 40], 1.27), [113.03, 54.61], "up-left of the click: the minimum, from the origin");
  assert.deepStrictEqual(_.sheetCorner([100.33, 50.8], [130.2, 70.1], 1.27), [130.81, 69.85]);
  assert.deepStrictEqual(_.sheetCorner([100, 50], [100.1, 50.1], 1.27), [113.03, 54.61], "never rounded inside the minimum");
});

test("Lock writes (locked yes) where SCH_IO_KICAD_SEXPR does, and locked items sit out of rotate, move and delete", () => {
  const w = '(wire (pts (xy 0 0) (xy 10.16 0)) (stroke (width 0) (type default)) (uuid "w1"))';
  const sym = '(symbol (lib_id "Device:R") (at 50.8 50.8 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes) (uuid "s1"))';
  const sh = '(sheet (at 100 50) (size 20 10) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "h1"))';
  const ra = '(rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 0 0) (xy 5 0) (xy 5 5)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "r1")))';
  const s = (kind, src) => K.serialize(_.setLockedNode(kind, K.parse(src), true));
  assert.ok(/\(uuid "w1"\) \(locked yes\)\)$/.test(s("wire", w)), s("wire", w));
  assert.ok(/\(dnp no\) \(locked yes\) \(fields_autoplaced yes\)/.test(s("symbol", sym)));
  assert.ok(/\(dnp no\) \(locked yes\) \(fields_autoplaced yes\)/.test(s("sheet", sh)));
  assert.ok(/^\(rule_area \(locked yes\) \(exclude_from_sim/.test(s("rule_area", ra)));
  assert.strictEqual(K.serialize(_.setLockedNode("wire", _.setLockedNode("wire", K.parse(w), true), false)), K.serialize(K.parse(w)), "unlock gives the node back");
  const doc = K.parseDoc(HEAD + w + '(wire (pts (xy 0 10.16) (xy 10.16 10.16)) (stroke (width 0) (type default)) (uuid "w2"))' + ")");
  const c = makeCtx(doc); c.selection = new Set(["w1"]);
  assert.strictEqual(sch.runAction("toggleLock", c), true);
  assert.strictEqual(c.log.length, 1); assert.strictEqual(c.log[0].label, "Lock");
  assert.ok(_.isLockedNode(doc.items.get("w1").node));
  const before = K.serialize(doc.items.get("w1").node);
  c.selection = new Set(["w1"]); sch.runAction("rotateSelection", c);
  assert.strictEqual(K.serialize(doc.items.get("w1").node), before, "rotate leaves the locked wire");
  assert.strictEqual(sch.beginDrag(c, doc.items.get("w1"), [5, 0], false), null, "move does not take it");
  c.selection = new Set(["w1"]); sch.runAction("toggleLock", c);
  assert.strictEqual(c.log[c.log.length - 1].label, "Unlock"); assert.ok(!_.isLockedNode(doc.items.get("w1").node));
});

test("Draw Ellipses / Draw Elliptical Arcs: the box's inscribed ellipse, then the arc's start and end angles", () => {
  const doc = K.parseDoc(HEAD + ")"); const c = makeCtx(doc);
  sch.onActivate("ellipse", c);
  sch._.drawClick(c, "ellipse", [10.16, 10.16]); sch._.drawClick(c, "ellipse", [30.48, 20.32]);
  assert.strictEqual(c.log.length, 1);
  const e = [...doc.items.values()].find((it) => it.kind === "ellipse");
  assert.ok(e, "an ellipse was added");
  assert.ok(/^\(ellipse \(center 20\.32 15\.24\) \(major_radius 10\.16\) \(minor_radius 5\.08\) \(rotation_angle 0\) \(stroke \(width 0\) \(type default\)\) \(fill \(type none\)\) \(uuid/.test(K.serialize(e.node)), K.serialize(e.node));
  const tall = _.ellipseFromBox([0, 0], [5.08, 20.32]); assert.strictEqual(tall.rotation, 90); assert.strictEqual(tall.major, 10.16);
  sch.onActivate("ellipse_arc", c);
  for (const p of [[50.8, 10.16], [71.12, 20.32], [81.28, 15.24], [60.96, 20.32]]) sch._.drawClick(c, "ellipse_arc", p);
  const a = [...doc.items.values()].find((it) => it.kind === "ellipse_arc");
  assert.ok(a, "an elliptical arc was added");
  const v = (k) => +K.kid(a.node, k)[1];
  assert.strictEqual(v("start_angle"), 0); assert.strictEqual(v("end_angle"), 90, "the end after the start (Y down: the bottom is +90)");
});

test("IsLocked reads only the (locked yes) child: a label or text reading 'locked' is not locked", () => {
  const lab = K.parse('(label "locked" (at 10.16 10.16 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))');
  const txt = K.parse('(text "locked" (exclude_from_sim no) (at 10.16 10.16 0) (effects (font (size 1.27 1.27))) (uuid "t1"))');
  assert.strictEqual(_.isLockedNode(lab), false); assert.strictEqual(_.isLockedNode(txt), false);
  const on = _.setLockedNode("label", lab, true);
  assert.strictEqual(_.isLockedNode(on), true);
  assert.strictEqual(K.serialize(_.setLockedNode("label", on, false)), K.serialize(lab), "unlock keeps the label's text");
  const doc = K.parseDoc(HEAD + K.serialize(lab) + ")"), c = makeCtx(doc); c.selection = new Set(["l1"]);
  sch.runAction("rotateSelection", c);
  assert.strictEqual(c.log.length, 1, "a label reading 'locked' still rotates");
});

test("Align to Grid leaves locked items; Align Edges keeps them in place as the anchor", () => {
  const lab = (id, x, y, lock) => `(label "N${id}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id}")${lock ? " (locked yes)" : ""})`;
  let doc = K.parseDoc(HEAD + lab("a", 10.5, 10.5, true) + lab("b", 20.5, 20.5, false) + ")"), c = makeCtx(doc);
  c.selection = new Set(["a", "b"]);
  _.alignToGrid(c);
  assert.deepStrictEqual(K.kid(doc.items.get("a").node, "at").slice(1, 3), [10.5, 10.5], "the locked label stays off the grid");
  const b = K.kid(doc.items.get("b").node, "at").slice(1, 3);
  assert.ok(Math.abs(b[0] / 1.27 - Math.round(b[0] / 1.27)) < 1e-6, "the free one is on the grid: " + b);
  doc = K.parseDoc(HEAD + lab("a", 10.16, 30.48, true) + lab("b", 20.32, 10.16, false) + lab("c", 30.48, 20.32, false) + ")"); c = makeCtx(doc);
  c.selection = new Set(["a", "b", "c"]); c.cursor = [0, 0];
  const top = (id) => { const it = doc.items.get(id); return (it.bbox || K.itemBBox?.(doc, it) || [0, 0, 0, 0])[1]; };
  const aTop = top("a");
  _.alignEdges(c, "top");
  assert.deepStrictEqual(K.kid(doc.items.get("a").node, "at").slice(1, 3), [10.16, 30.48], "the locked label is not moved");
  assert.ok(Math.abs(top("b") - aTop) < 0.01 && Math.abs(top("c") - aTop) < 0.01, "the others take the locked one's top: " + [top("b"), top("c"), aTop]);
});

test("Autoplace sheet pins: a hand-placed field below the sheet stays as the sheet grows; pins take the default text size", () => {
  const sheet = (ap) => `(sheet (at 100 50) (size 20 5) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)${ap ? " (fields_autoplaced yes)" : ""} (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "h1") (property "Sheetname" "S" (at 100 49.3 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "s.kicad_sch" (at 100 55.6 0) (effects (font (size 1.27 1.27)) (justify left top))))`;
  const sub = K.parseDoc(HEAD + ["A", "B", "C", "D"].map((n, i) => `(hierarchical_label "${n}" (shape input) (at 10 ${10 + i * 2.54} 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "hl${i}"))`).join("") + ")");
  const fileAt = (n) => K.kid(K.kids(n, "property").find((p) => p[1] === "Sheetfile"), "at")[2];
  const manual = _.autoPlaceSheetPinsNode(K.parse(sheet(false)), sub, 2.54);
  assert.ok(+K.kid(manual, "size")[2] > 5, "the sheet grew");
  assert.strictEqual(fileAt(manual), 55.6, "the hand-placed field stays put");
  assert.deepStrictEqual(K.kid(K.kid(K.kids(manual, "pin")[0], "effects"), "font").slice(1)[0].slice(1), [2.54, 2.54], "pin text at the default text size");
  const auto = _.autoPlaceSheetPinsNode(K.parse(sheet(true)), sub, 2.54);
  assert.ok(fileAt(auto) > 55.6, "an autoplaced field follows the bottom edge");
});

console.log(`sch-sweep8: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
