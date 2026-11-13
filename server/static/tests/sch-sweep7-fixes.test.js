// sch-sweep7-fixes.test.js — fixes to the schematic editing / painting ports: a one-end line selection is dropped by
// a new selection, rotate / mirror of a line selected by one end (SCH_LINE::Rotate / Mirror* move the flagged end,
// SCH_EDIT_TOOL::Rotate's line pivot), a lone reference image turning (SCH_BITMAP::Rotate), the bus colour of labels
// from their own names (SCH_CONNECTION::IsBusLabel) and the Formatting parameter ranges (PARAM::Load).
// Run: node server/static/tests/sch-sweep7-fixes.test.js
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
const near = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-6 && Math.abs(p[1] - b[i][1]) < 1e-6);
function pick(doc, id, end) { sch.select(null); sch.select(id); sch.putSelEnd(id, end); return makeCtx(doc); }

test("select(null) and a new pick drop the one-end flags (SelectAll / ClearSelection)", () => {
  const doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")");
  sch.select("w1"); sch.putSelEnd("w1", 0);
  assert.deepStrictEqual(sch.selEndKeys(["w1"]), ["w1#end:0"]);
  sch.select(null); assert.deepStrictEqual(sch.selEndKeys(["w1"]), [], "cleared even though nothing else was picked");
  sch.select("w1"); sch.putSelEnd("w1", 0); sch.state.sel = null; sch.select(null);
  assert.deepStrictEqual(sch.selEndKeys(["w1"]), [], "cleared when the module's own pick was already gone");
  assert.ok(doc);
});

test("R on a wire selected by its start turns the start about the end (SCH_EDIT_TOOL::Rotate, SCH_LINE::Rotate)", () => {
  const doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")"), c = pick(doc, "w1", 0);
  assert.ok(_.orientSelected(c, "ccw"));
  assert.ok(near(pts(doc.items.get("w1")), [[209.55, 59.69], [209.55, 40.64]]), JSON.stringify(pts(doc.items.get("w1"))));
});
test("R on a wire selected by its end turns the end about the start", () => {
  const doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")"), c = pick(doc, "w1", 1);
  assert.ok(_.orientSelected(c, "ccw"));
  assert.ok(near(pts(doc.items.get("w1")), [[190.5, 40.64], [190.5, 21.59]]), JSON.stringify(pts(doc.items.get("w1"))));
});
test("a whole lone wire turns about its end point (both flags: rotPoint = GetEndPoint)", () => {
  const doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")"), c = pick(doc, "w1", null);
  assert.ok(_.orientSelected(c, "cw"));
  assert.ok(near(pts(doc.items.get("w1")), [[209.55, 21.59], [209.55, 40.64]]), JSON.stringify(pts(doc.items.get("w1"))));
});
test("mirror of a start-only wire about its start changes nothing; of an end-only one flips the end", () => {
  let doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")"), c = pick(doc, "w1", 0);
  _.orientSelected(c, "y");
  assert.ok(near(pts(doc.items.get("w1")), [[190.5, 40.64], [209.55, 40.64]]), "point order kept: " + JSON.stringify(pts(doc.items.get("w1"))));
  doc = K.parseDoc(HEAD + W("w1", [190.5, 40.64], [209.55, 40.64]) + ")"); c = pick(doc, "w1", 1);
  _.orientSelected(c, "y");
  assert.ok(near(pts(doc.items.get("w1")), [[190.5, 40.64], [171.45, 40.64]]), JSON.stringify(pts(doc.items.get("w1"))));
});
test("a partly selected wire in a multi-selection moves only its flagged end", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 0], [10.16, 0]) + '(no_connect (at 10.16 5.08) (uuid "n1")))'), c = makeCtx(doc);
  sch.select(null); sch.putSelEnd("w1", 1);
  assert.ok(_.transformSelected(c, "ccw", [doc.items.get("w1"), doc.items.get("n1")], [10.16, 2.54]));
  assert.ok(near(pts(doc.items.get("w1")), [[0, 0], [7.62, 2.54]]), JSON.stringify(pts(doc.items.get("w1"))));
  sch.select(null);
});

test("R turns a lone reference image the way SCH_EDIT_TOOL::Rotate does (head->Rotate( rotPoint, clockwise ))", () => {
  const doc = K.parseDoc(HEAD + '(image (at 304.8 101.6) (rotate 315) (uuid "i1") (data "")))'), c = makeCtx(doc);
  sch.select("i1");
  assert.ok(_.orientSelected(c, "ccw"));
  const n = doc.items.get("i1").node;
  assert.strictEqual(+K.kid(n, "rotate")[1], 225, "R (counter-clockwise) passes aRotateCCW = false: ANGLE_270");
  assert.ok(_.orientSelected(c, "cw"));
  assert.strictEqual(+K.kid(doc.items.get("i1").node, "rotate")[1], 315);
  const m = ["image", ["at", 0, 0], ["uuid", "x"]];
  _.transformNode("image", m, "ccw", [10, 0]);
  assert.deepStrictEqual(m[1], ["at", 10, 10]); assert.deepStrictEqual(m[2], ["rotate", 90], "(rotate) written right after (at)");
  _.transformNode("image", m, "ccw", [10, 0]); _.transformNode("image", m, "ccw", [10, 0]); _.transformNode("image", m, "ccw", [10, 0]);
  assert.ok(!K.kid(m, "rotate"), "back to 0: the token is dropped");
  sch.select(null);
});

test("SCH_CONNECTION::IsBusLabel: vectors and groups, as NET_SETTINGS parses them", () => {
  const yes = ["D[0..7]", "D[7..0]", "A{B C}", "{SDA SCL}", "~{BE[0..3]}", "D_{[1..2]}", "DATA[0..3]+", "I^{2}C[0..7]", "MEM{D[0..7] A[0..15]}", "D{slash}X[0..1]"];
  const no = ["D[0..0]", "D[0..]", "D[a..3]", "VCC", "D[0..3]X", "A B{C}", "{", "D0", "~{RESET}", "A{B"];
  for (const t of yes) assert.ok(K.isBusLabel(t), t);
  for (const t of no) assert.ok(!K.isBusLabel(t), t);
});

test("bus colour from the label's own name, wherever it sits; bus-named sheet pins too (SCH_PAINTER HasBusConnection)", () => {
  const LB = (k, t, x, y, id) => `(${k} "${t}" (at ${x} ${y} 0) ${k === "label" ? "" : "(shape input) "}(effects (font (size 1.27 1.27))) (uuid "${id}"))`;
  const doc = K.parseDoc(HEAD + '(bus (pts (xy 0 0) (xy 20 0)) (uuid "b1")) ' + LB("label", "NET", 5, 0, "l1") + LB("label", "D[0..7]", 50, 50, "l2") +
    LB("global_label", "{A B}", 60, 60, "l3") + LB("hierarchical_label", "X", 70, 70, "l4") +
    '(sheet (at 100 100) (size 20 20) (uuid "s1") (property "Sheetname" "S" (at 100 99 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "s.kicad_sch" (at 100 121 0) (effects (font (size 1.27 1.27)))) ' +
    '(pin "Q[0..3]" input (at 100 105 180) (effects (font (size 1.27 1.27))) (uuid "p1")) (pin "CLK" input (at 100 110 180) (effects (font (size 1.27 1.27))) (uuid "p2"))))');
  const ids = K.busConnectedLabels(doc);
  assert.deepStrictEqual([...ids].sort(), ["l2", "l3", "s1"]);
  const s1 = doc.items.get("s1");
  const bus = s1.geom.filter((g) => K.busPinTint(s1, g)).map((g) => g.pinNo);
  assert.ok(bus.length && bus.every((p) => p === "Q[0..3]"), "only the bus-named pin");
});

test("Formatting values out of range fall back to the default (PARAM / PARAM_SCALED::Load), not the limit", () => {
  const esbuild = require("esbuild");
  const out = esbuild.buildSync({ stdin: { contents: 'export { schParamInRange } from "./logic";', resolveDir: path.join(__dirname, "..", "..", "web", "dialogs"), loader: "ts" }, bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  const f = m.exports.schParamInRange;
  assert.strictEqual(f(2, 6, 5, 1000), 6, "default_line_thickness 2 mil: the 6 mil default");
  assert.strictEqual(f(3, 0.15, 0, 2), 0.15, "text_offset_ratio 3");
  assert.strictEqual(f(1.5, 0.15, 0, 2), 1.5);
  assert.strictEqual(f(undefined, 25, 0, 1000), 25);
  assert.strictEqual(f(7, 3, 0, 5, true), 3, "junction_size_choice 7");
  assert.strictEqual(f(4.9, 3, 0, 5, true), 4, "PARAM<int> truncates");
});

console.log(`sch-sweep7-fixes: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
