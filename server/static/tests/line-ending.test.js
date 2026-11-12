// line-ending.test.js — KiCad 10 line endings (common/line_ending.cpp, EDA_SHAPE::Shorten*ForEndings,
// GetEndingTangents) in the schematic renderer: sizes, shortening, tangents and the geometry the sheet emits.
// Run: node server/static/tests/line-ending.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const LE = load("canvas/line-ending.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
console.log("line endings under node");

test("parse: style, length, width, stroke; none / missing is no ending", () => {
  const n = K.parse(`(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0.2) (type default)) (start_shape arrow_open (length 2) (width 1) (stroke (width 0.3) (type solid))) (end_shape none))`);
  assert.deepStrictEqual(LE.readEnding(n, "start_shape"), { style: "arrow_open", length: 2, width: 1, strokeW: 0.3 });
  assert.strictEqual(LE.readEnding(n, "end_shape"), null);
});
test("effective size: 5x the line width, length and width fall back to each other", () => {
  assert.deepStrictEqual(LE.effectiveSize({ style: "arrow", length: 0, width: 0, strokeW: 0 }, 0.2), [1, 1]);
  assert.deepStrictEqual(LE.effectiveSize({ style: "arrow", length: 2, width: 0, strokeW: 0 }, 0.2), [2, 2]);
  assert.deepStrictEqual(LE.effectiveSize({ style: "arrow", length: 0, width: 3, strokeW: 0 }, 0.2), [3, 3]);
});
test("shorten depth: arrow L, open arrow 0, circle / square L/2, less half the ending stroke", () => {
  const e = (style, strokeW = 0) => ({ style, length: 2, width: 1, strokeW });
  assert.strictEqual(LE.shortenDepth(e("arrow"), 0.2), 2); assert.strictEqual(LE.shortenDepth(e("arrow_open"), 0.2), 0);
  assert.strictEqual(LE.shortenDepth(e("circle"), 0.2), 1); assert.strictEqual(LE.shortenDepth(e("square"), 0.2), 1);
  assert.strictEqual(LE.shortenDepth(e("arrow", 0.4), 0.2), 1.8);
});
test("segment: shortened by both depths; eaten whole when they exceed the length", () => {
  const a = { style: "arrow", length: 2, width: 1, strokeW: 0 }, c = { style: "circle", length: 2, width: 2, strokeW: 0 };
  const s = LE.shortenSegment([0, 0], [10, 0], c, a, 0.2); assert.ok(nearPt(s[0], [1, 0]) && nearPt(s[1], [8, 0]), JSON.stringify(s));
  assert.strictEqual(LE.shortenSegment([0, 0], [2.5, 0], c, a, 0.2), null);
});
test("arrow shape: tip on the end point, base back along the line", () => {
  const pts = LE.endingShape({ style: "arrow", length: 2, width: 1, strokeW: 0 }, [10, 0], [1, 0], 0.2);
  assert.ok(nearPt(pts[0], [10, 0]) && nearPt(pts[1], [8, 0.5]) && nearPt(pts[2], [8, -0.5]));
  const sq = LE.endingShape({ style: "square", length: 2, width: 1, strokeW: 0 }, [0, 0], [0, 1], 0.2);
  assert.ok(sq.every((p) => near(Math.abs(p[0]), 0.5) && near(Math.abs(p[1]), 1)), JSON.stringify(sq));
  assert.strictEqual(LE.endingShape({ style: "circle", length: 2, width: 2, strokeW: 0 }, [0, 0], [1, 0], 0.2).length, 33);
});
test("polyline: only the first and last segments are trimmed; tangents point out of the ends", () => {
  const e = { style: "arrow", length: 1, width: 1, strokeW: 0 };
  const out = LE.shortenPoly([[0, 0], [5, 0], [5, 5]], e, e, 0.2);
  assert.ok(nearPt(out[0], [1, 0]) && nearPt(out[1], [5, 0]) && nearPt(out[2], [5, 4]));
  const t = LE.polyTangents([[0, 0], [5, 0], [5, 5]]); assert.ok(nearPt(t[0], [-1, 0]) && nearPt(t[1], [0, 1]));
});
test("arc: trimmed by angle in its own direction, tangents perpendicular to the radius pointing away", () => {
  const a = { x: 0, y: 0, r: 10, a0: 0, a1: Math.PI / 2, anticlockwise: false };
  const e = { style: "arrow", length: 1, width: 1, strokeW: 0 };
  const s = LE.shortenArc(a, e, e, 0.2); assert.ok(near(s.a0, 0.1) && near(s.a1, Math.PI / 2 - 0.1));
  const [ts, te] = LE.arcTangents(a); assert.ok(nearPt(ts, [0, -1]) && nearPt(te, [-1, 0]), JSON.stringify([ts, te]));
  const b = Object.assign({}, a, { a0: Math.PI / 2, a1: 0, anticlockwise: true }); const sb = LE.shortenArc(b, e, null, 0.2); assert.ok(near(sb.a0, Math.PI / 2 - 0.1) && near(sb.a1, 0));
});
test("sheet graphic line with an end arrow: body shortened, filled triangle in the line colour", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20260818) (generator "eeschema") (uuid "r") (paper "A4")
    (polyline (pts (xy 10 10) (xy 20 10)) (stroke (width 0.2) (type default)) (end_shape arrow (length 2) (width 1)) (uuid "p1")))`, "kicad_sch");
  const it = doc.items.get("p1"); const polys = it.geom.filter((g) => g.t === "poly");
  const body = polys.find((g) => !g.fill), head = polys.find((g) => g.fill);
  assert.ok(body && nearPt(body.pts[1], [18, 10]), JSON.stringify(body && body.pts));
  assert.ok(head && nearPt(head.pts[0], [20, 10]) && nearPt(head.pts[1], [18, 10.5]) && head.fill === head.color);
  assert.ok(it.bbox[2] >= 20 && it.bbox[3] >= 10.5, "the ending is inside the item's bbox");
});
test("library polyline with an open arrow keeps its body and strokes the arrow", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20260818) (generator "eeschema") (uuid "r") (paper "A4")
    (lib_symbols (symbol "L:A" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "A_0_1" (polyline (pts (xy 0 0) (xy 5 0)) (stroke (width 0.254) (type default)) (fill (type none)) (end_shape arrow_open)))))
    (symbol (lib_id "L:A") (at 50 50 0) (unit 1) (uuid "s1") (property "Reference" "U1" (at 0 0 0) (effects (font (size 1.27 1.27))))))`, "kicad_sch");
  const g = doc.items.get("s1").geom.filter((x) => x.t === "poly");
  const open = g.find((x) => x.pts.length === 3 && !x.close); assert.ok(open, JSON.stringify(g.map((x) => x.pts)));
  assert.ok(nearPt(open.pts[1], [55, 50], 1e-4), "tip at the end point: " + JSON.stringify(open.pts));
  assert.ok(g.some((x) => x.pts.length === 2 && nearPt(x.pts[1], [55, 50], 1e-4)), "open arrows do not shorten the body");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
