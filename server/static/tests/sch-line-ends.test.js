// sch-line-ends.test.js — a SCH_LINE selected by one end (SCH_SELECTION_TOOL's STARTPOINT / ENDPOINT flags): the
// click threshold, the box's contained-mode dangling ends, the painter keys, SCH_MOVE_TOOL moving that end alone
// (and what is attached at it), and an exact undo.
// Run: node server/static/tests/sch-line-ends.test.js
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
    commit(changes, label) { ctx.log.push({ changes, label, before: changes.map((c) => { const it = doc.items.get(c.id); return it ? K.serializeItem(doc, it) : null; }) }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
const pts = (it) => K.kid(it.node, "pts").slice(1).map((p) => [+p[1], +p[2]]);
const W = (id, a, b) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;

test("selectPoint's threshold is max( 5 px, |grid| / 2 ) and only the two ends of a SCH_LINE count", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [25.4, 0]) + ")"), w = doc.items.get("w1"), c = makeCtx(doc);
  const thr = _.selectThreshold ? _.selectThreshold(c) : null;
  assert.ok(Math.abs(thr - Math.max(5 / 4, Math.hypot(1.27, 1.27) / 2)) < 1e-9, "threshold " + thr);
  assert.strictEqual(_.lineEndAt(w, [0.5, 0.2], thr), 0);
  assert.strictEqual(_.lineEndAt(w, [24.9, 0], thr), 1);
  assert.strictEqual(_.lineEndAt(w, [12, 0], thr), null);
  const poly = K.parseDoc(HEAD + '(polyline (pts (xy 0 0) (xy 5 0) (xy 5 5)) (stroke (width 0) (type default)) (uuid "p1")))').items.get("p1");
  assert.strictEqual(_.lineEndAt(poly, [0, 0], thr), null, "a multi-point shape is not a SCH_LINE");
});

test("a line selected by its start: the painter key names that end, the drag moves it alone and undo restores it exactly", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [25.4, 0]) + W("w2", [25.4, 0], [25.4, 12.7]) + ")"), c = makeCtx(doc); sch.onDocChanged(c); sch.setDragMode(c, "move");
  const w = doc.items.get("w1"), before = K.serializeItem(doc, w);
  sch.state.sel = "w1"; sch.putSelEnd("w1", 0);
  assert.deepStrictEqual(sch.selEndKeys(["w1", "w2"]), ["w1#end:0"]);
  assert.ok(_.beginDrag(c, w, [0, 0], true)); _.moveDrag(c, [0, 5.08]); _.endDrag(c, true);
  const com = c.log[c.log.length - 1]; assert.ok(com, "committed");
  assert.deepStrictEqual(pts(doc.items.get("w1")), [[0, 5.08], [25.4, 0]], "the start moved, the end stayed");
  assert.deepStrictEqual(pts(doc.items.get("w2")), [[25.4, 0], [25.4, 12.7]], "the other wire untouched");
  // undo: the inverse of each change restores the line
  const i = com.changes.findIndex((ch) => ch.id === "w1"); assert.strictEqual(com.before[i], before);
});

test("drag mode: a wire end attached at the moved end stretches with it; a fully selected line keeps both ends", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [12.7, 0]) + W("w2", [12.7, 0], [12.7, 12.7]) + ")"), c = makeCtx(doc); sch.onDocChanged(c); sch.setDragMode(c, "drag"); sch.setLineMode(c, "free");
  sch.state.selEnds = null; sch.putSelEnd("w1", 1);
  assert.ok(_.beginDrag(c, doc.items.get("w1"), [12.7, 0], true)); _.moveDrag(c, [15.24, 2.54]); _.endDrag(c, true);
  assert.deepStrictEqual(pts(doc.items.get("w1")), [[0, 0], [15.24, 2.54]]);
  assert.deepStrictEqual(pts(doc.items.get("w2"))[0], [15.24, 2.54], "the attached end followed");
  sch.state.selEnds = null;
  const d2 = K.parseDoc(HEAD + W("w1", [0, 0], [12.7, 0]) + ")"), c2 = makeCtx(d2); sch.onDocChanged(c2); sch.setDragMode(c2, "move");
  assert.ok(_.beginDrag(c2, d2.items.get("w1"), [5, 0], true)); _.moveDrag(c2, [5, 2.54]); _.endDrag(c2, true);
  assert.deepStrictEqual(pts(d2.items.get("w1")), [[0, 2.54], [12.7, 2.54]]);
});

test("a label on the moved end follows it in drag mode only (getConnectedDragItems); move mode leaves it", () => {
  for (const mode of ["drag", "move"]) {
    const doc = K.parseDoc(HEAD + W("w1", [0, 0], [12.7, 0]) + '(label "N" (at 12.7 0 0) (effects (font (size 1.27 1.27))) (uuid "l1")))'), c = makeCtx(doc); sch.onDocChanged(c); sch.setDragMode(c, mode);
    sch.state.selEnds = null; sch.putSelEnd("w1", 1);
    assert.ok(_.beginDrag(c, doc.items.get("w1"), [12.7, 0], true)); _.moveDrag(c, [12.7, 5.08]); _.endDrag(c, true);
    assert.deepStrictEqual(pts(doc.items.get("w1"))[1], [12.7, 5.08], mode);
    const at = K.kid(doc.items.get("l1").node, "at"); assert.deepStrictEqual([+at[1], +at[2]], mode === "drag" ? [12.7, 5.08] : [12.7, 0], mode);
  }
  sch.state.selEnds = null;
});

test("orthoLineDrag: DRAG in 90 mode keeps an attached orthogonal line orthogonal; a free far end just follows", () => {
  const run = (extra, to) => {
    const doc = K.parseDoc(HEAD + W("w1", [0, 0], [12.7, 0]) + extra + ")"), c = makeCtx(doc); sch.onDocChanged(c); sch.setDragMode(c, "drag"); sch.setLineMode(c, "90");
    sch.state.selEnds = null; sch.putSelEnd("w1", 1);
    assert.ok(_.beginDrag(c, doc.items.get("w1"), [12.7, 0], true)); _.moveDrag(c, to); _.endDrag(c, true); sch.state.selEnds = null;
    const lines = [...doc.items.values()].filter((it) => it.kind === "wire").map((it) => pts(it));
    return { doc, lines, w1: doc.items.get("w1") ? pts(doc.items.get("w1")) : null, com: c.log[c.log.length - 1] };
  };
  // nothing at the far end: the end just moves (a diagonal line)
  assert.deepStrictEqual(run("", [15.24, 5.08]).w1, [[0, 0], [15.24, 5.08]]);
  // a vertical wire at the far end runs the way of the move: it stretches and the whole line shifts down
  const r = run(W("w2", [0, -10.16], [0, 0]), [15.24, 5.08]);
  assert.deepStrictEqual(r.w1, [[0, 5.08], [15.24, 5.08]]);
  assert.deepStrictEqual(pts(r.doc.items.get("w2")), [[0, -10.16], [0, 5.08]]);
  // a label at the far end: the line stays and gets a bend at the moved end
  const b = run('(label "N" (at 0 0 0) (effects (font (size 1.27 1.27))) (uuid "l1"))', [15.24, 5.08]);
  assert.deepStrictEqual(b.w1, [[0, 0], [15.24, 0]]);
  assert.ok(b.lines.some((l) => JSON.stringify(l) === JSON.stringify([[15.24, 0], [15.24, 5.08]])), JSON.stringify(b.lines));
  // a junction alone: a new wire from the old far end to the shifted one
  const j = run(W("w3", [0, 0], [-5.08, 0]) + W("w4", [0, 0], [0, -5.08]) + '(junction (at 0 0) (diameter 0) (color 0 0 0 0) (uuid "j1"))', [12.7, 2.54]);
  assert.deepStrictEqual(j.w1, [[0, 2.54], [12.7, 2.54]]);
});

test("box selection: touch mode takes a crossed line whole; contained mode takes only a dangling end inside the box", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [25.4, 0]) + W("w2", [25.4, 0], [25.4, 10]) + ")");
  const w1 = doc.items.get("w1");
  assert.strictEqual(sch.boxLineFlags(doc, w1, [-1, -1, 5, 1], false), "whole");
  assert.strictEqual(sch.boxLineFlags(doc, w1, [-1, -1, 5, 1], true), 0, "its start dangles and is inside");
  assert.strictEqual(sch.boxLineFlags(doc, w1, [20, -1, 30, 1], true), null, "its end is connected to w2: not taken");
  assert.strictEqual(sch.boxLineFlags(doc, w1, [-1, -1, 30, 1], true), "whole");
  assert.strictEqual(sch.boxLineFlags(doc, w1, [5, 5, 10, 10], false), null);
  assert.strictEqual(sch.boxLineFlags(doc, doc.items.get("w2"), [24, 9, 26, 11], true), 1);
});

test("the painter squares the unselected end of a line named by an end key", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [10, 0]) + ")");
  const ops = []; const ctx = { canvas: { width: 300, height: 200 }, measureText: (t) => ({ width: t.length }) };
  for (const n of ["setTransform", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "setLineDash", "clearRect", "stroke", "fill", "fillRect", "fillText", "ellipse", "bezierCurveTo", "quadraticCurveTo", "drawImage", "strokeText"]) ctx[n] = () => {};
  ctx.strokeRect = (x, y, w, h) => ops.push([x + w / 2, y + h / 2]);
  K.render(doc, ctx, { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 }, { selected: new Set(["w1", "w1#end:0"]) });
  const near = (x, y) => ops.filter((o) => Math.abs(o[0] - x) < 1e-6 && Math.abs(o[1] - y) < 1e-6).length;
  assert.strictEqual(near(10, 0), 1, "square at the unselected end"); assert.strictEqual(near(0, 0), 0, "none at the selected one");
});

console.log(`sch-line-ends: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
