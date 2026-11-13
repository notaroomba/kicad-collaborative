// sch-edit-points.test.js — SCH_POINT_EDITOR behaviours ported in sweep 7: polygon / rule-area edge handles with
// POLYGON_EDGE_DRAG_POLICY's converging drag, ellipse and elliptical-arc points (EDA_ELLIPSE_POINT_EDIT_BEHAVIOR),
// reference image corners / origin / rotation (REFERENCE_IMAGE_POINT_EDIT_BEHAVIOR), ellipse rotate / mirror.
// Run: node server/static/tests/sch-edit-points.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
const pe = (item, idx, ep) => ({ item, ep: ep || _.editPoints(null, item), idx, orig: JSON.parse(JSON.stringify(item.node)), followers: [], start: [0, 0], moved: true, last: [0, 0] });
const val = (n, k) => +K.kid(n, k)[1];

test("a polygon (polyline of more than two points) gets an edge handle on every side, the closing one included", () => {
  const doc = K.parseDoc(HEAD + '(polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0) (type default)) (fill (type none)) (uuid "p1")))');
  const ep = _.editPoints(doc, doc.items.get("p1"));
  assert.deepStrictEqual(ep.lines, [[0, 1], [1, 2], [2, 3], [3, 0]]);
  const two = K.parseDoc(HEAD + '(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "l1")))');
  assert.deepStrictEqual(_.editPoints(two, two.items.get("l1")).lines, [], "a graphic line (SCH_LINE) has no edge handles");
});

test("POLYGON_EDGE_DRAG_POLICY: a square's side moves parallel, its corners sliding along the neighbouring sides", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const out = _.polygonEdgeDrag(sq, 1, [14, 5]);           // the right side, dragged 4 mm right
  assert.ok(nearPt(out[1], [14, 0]) && nearPt(out[2], [14, 10]), JSON.stringify(out));
  assert.ok(nearPt(out[0], [0, 0]) && nearPt(out[3], [0, 10]));
  const along = _.polygonEdgeDrag(sq, 1, [14, 8]);          // the handle's motion along the edge is ignored
  assert.ok(nearPt(along[1], [14, 0]) && nearPt(along[2], [14, 10]), JSON.stringify(along));
});

test("POLYGON_EDGE_DRAG_POLICY: a trapezoid's top converges and stops at the sides' meeting point", () => {
  const tz = [[0, 10], [4, 0], [6, 0], [10, 10]];           // top edge 1-2 between two slanted sides meeting at (5, -2.5)
  const out = _.polygonEdgeDrag(tz, 1, [5, -1]);
  assert.ok(near(out[1][1], -1) && near(out[2][1], -1), JSON.stringify(out));
  assert.ok(near(out[1][0], 4.4) && near(out[2][0], 5.6), JSON.stringify(out));
  const far = _.polygonEdgeDrag(tz, 1, [5, -20]);           // past the convergence point: both corners on it
  assert.ok(nearPt(far[1], [5, -2.5], 1e-6) && nearPt(far[2], [5, -2.5], 1e-6), JSON.stringify(far));
});

test("rule area edge drag writes the polyline's points", () => {
  const doc = K.parseDoc(HEAD + '(rule_area (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "r1"))))');
  const it = doc.items.get("r1"); const ep = _.editPoints(doc, it); assert.strictEqual(ep.lines.length, 4);
  _.applyPointEdit(doc, pe(it, ep.pts.length + 2, ep), [5, 12.54]);   // the bottom edge down
  const pts = K.kid(K.kid(it.node, "polyline"), "pts").slice(1).map((p) => [+p[1], +p[2]]);
  assert.deepStrictEqual(pts, [[0, 0], [10, 0], [10, 12.54], [0, 12.54]]);
});

test("ellipse points: centre, major end, minor end; an arc adds its start and end with indicator lines", () => {
  const doc = K.parseDoc(HEAD + '(ellipse (center 10 10) (major_radius 5) (minor_radius 2) (rotation_angle 0) (stroke (width 0) (type default)) (fill (type none)) (uuid "e1")) (ellipse_arc (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 90) (start_angle 0) (end_angle 90) (stroke (width 0) (type default)) (fill (type none)) (uuid "e2")))');
  const e1 = _.editPoints(doc, doc.items.get("e1"));
  assert.ok(nearPt(e1.pts[0], [10, 10]) && nearPt(e1.pts[1], [15, 10]) && nearPt(e1.pts[2], [10, 12]));
  const e2 = _.editPoints(doc, doc.items.get("e2"));
  assert.strictEqual(e2.pts.length, 5); assert.deepStrictEqual(e2.guides, [[0, 3], [0, 4]]);
  assert.ok(nearPt(e2.pts[3], [0, 4]) && nearPt(e2.pts[4], [-2, 0]), JSON.stringify(e2.pts));
});

test("ellipse edits: the major end sets radius and rotation, the minor end the projected radius, an arc end its angle", () => {
  const doc = K.parseDoc(HEAD + '(ellipse_arc (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 0) (start_angle 0) (end_angle 90) (stroke (width 0) (type default)) (fill (type none)) (uuid "e2")))');
  const it = doc.items.get("e2");
  _.applyPointEdit(doc, pe(it, 1), [0, 6]);
  assert.strictEqual(val(it.node, "major_radius"), 6); assert.strictEqual(val(it.node, "rotation_angle"), 90);
  const it2 = K.parseDoc(HEAD + '(ellipse (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 0) (stroke (width 0) (type default)) (fill (type none)) (uuid "e1")))').items.get("e1");
  _.applyPointEdit(doc, pe(it2, 2), [3, -3]);
  assert.strictEqual(val(it2.node, "minor_radius"), 3, "the drag projected on the minor axis, absolute");
  const it3 = K.parseDoc(HEAD + '(ellipse_arc (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 0) (start_angle 0) (end_angle 90) (stroke (width 0) (type default)) (fill (type none)) (uuid "e3")))').items.get("e3");
  _.applyPointEdit(doc, pe(it3, 3), [0, -2]);              // the start to t = -90: the sweep is kept
  assert.strictEqual(val(it3.node, "start_angle"), -90); assert.strictEqual(val(it3.node, "end_angle"), 0);
});

test("ellipse rotate / mirror: the centre turns, the rotation steps a quarter, a mirror negates it and reflects the arc", () => {
  const doc = K.parseDoc(HEAD + '(ellipse_arc (center 10 0) (major_radius 4) (minor_radius 2) (rotation_angle 30) (start_angle 10) (end_angle 100) (stroke (width 0) (type default)) (fill (type none)) (uuid "e2")))');
  const n = doc.items.get("e2").node;
  _.transformNode("ellipse_arc", n, "ccw", [0, 0]);
  assert.deepStrictEqual([val(n, "rotation_angle")], [-60]); assert.deepStrictEqual([+K.kid(n, "center")[1], +K.kid(n, "center")[2]], [0, -10]);
  _.transformNode("ellipse_arc", n, "y", [0, 0]);
  assert.strictEqual(val(n, "rotation_angle"), 60); assert.strictEqual(val(n, "start_angle"), 80); assert.strictEqual(val(n, "end_angle"), 170);
  _.transformNode("ellipse_arc", n, "x", [0, 0]);
  assert.strictEqual(val(n, "rotation_angle"), -60); assert.strictEqual(val(n, "start_angle"), -170); assert.strictEqual(val(n, "end_angle"), -80);
});

test("reference image: corners on the box, the origin at the centre, the rotation handle above it; a corner scales about the origin", () => {
  const doc = K.parseDoc(HEAD + '(image (at 50 50) (uuid "i1") (data "")))');
  const it = doc.items.get("i1"); it.w = 20; it.h = 10;
  const ep = _.editPoints(doc, it);
  assert.deepStrictEqual(ep.pts.slice(0, 5), [[40, 45], [60, 45], [60, 55], [40, 55], [50, 50]]);
  assert.ok(nearPt(ep.pts[5], [50, 43]), "handle 0.7 x height above the origin: " + ep.pts[5]);
  assert.deepStrictEqual(ep.guides, [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5]]);
  const p = pe(it, 2, ep); p.imgOrigin0 = [0, 0]; p.imgSize0 = [20, 10];
  _.applyPointEdit(doc, p, [70, 60]);                       // twice as far from the origin: scale 2
  assert.strictEqual(val(it.node, "scale"), 2); assert.deepStrictEqual([+K.kid(it.node, "at")[1], +K.kid(it.node, "at")[2]], [50, 50]);
  const tiny = pe(it, 2, ep); tiny.imgOrigin0 = [0, 0]; tiny.imgSize0 = [20, 10];
  _.applyPointEdit(doc, tiny, [45, 45]);                    // across the origin: clamped to the 50 mil minimum
  assert.ok(near(val(it.node, "scale"), 0.127, 1e-6), String(val(it.node, "scale")));
  const rot = pe(it, 5, ep); rot.imgOrigin0 = [0, 0]; rot.imgSize0 = [20, 10];
  _.applyPointEdit(doc, rot, [43, 50]);                     // the handle to the left: a quarter turn counter-clockwise
  assert.strictEqual(val(it.node, "rotate"), 90);
  const back = pe(it, 5, ep); back.imgOrigin0 = [0, 0]; back.imgSize0 = [20, 10];
  _.applyPointEdit(doc, back, [50, 40]);
  assert.strictEqual(K.kid(it.node, "rotate"), null, "upright again: no (rotate)");
  assert.deepStrictEqual(_.imageBoundingSize(20, 10, 90), [10, 20]);
});

console.log(`sch-edit-points: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
