// node server/static/tests/shapes.test.js — the board and schematic shapes kicad-canvas.js added late: ellipses and
// elliptical arcs (KiCad 10), points, barcodes, and the SVG export of text in the stroke font.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= (tol || 1e-6), (msg || "") + ` expected ${b}, got ${a}`);
const pcb = (body) => K.parseDoc(`(kicad_pcb (version 20240108) (generator "pcbnew") (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user))
  ${body})`, "kicad_pcb");
const only = (doc) => Array.from(doc.items.values())[0];
const extent = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const polyPts = (it) => { const g = it.geom.find((x) => x.pts && x.pts.length > 8); assert(g, "a polyline geometry: " + JSON.stringify(it.geom.map((x) => x.t))); return g.pts; };

test("gr_ellipse: an outline through the four ends of its axes", () => {
  const doc = pcb(`(gr_ellipse (center 10 20) (major_radius 4) (minor_radius 2) (rotation_angle 0) (stroke (width 0.2) (type solid)) (fill no) (layer "F.SilkS") (uuid "a"))`);
  const it = only(doc); assert(it, "item parsed");
  const e = extent(polyPts(it));
  near(e[0], 6, 0.02, "left"); near(e[2], 14, 0.02, "right"); near(e[1], 18, 0.02, "top"); near(e[3], 22, 0.02, "bottom");
});
test("gr_ellipse rotated a quarter turn swaps its extents", () => {
  const doc = pcb(`(gr_ellipse (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 90) (stroke (width 0.2) (type solid)) (fill no) (layer "F.SilkS") (uuid "a"))`);
  const e = extent(polyPts(only(doc)));
  near(e[2] - e[0], 4, 0.03, "width"); near(e[3] - e[1], 8, 0.03, "height");
});
test("gr_ellipse_arc: a part of the outline only", () => {
  const doc = pcb(`(gr_ellipse_arc (center 0 0) (major_radius 4) (minor_radius 2) (rotation_angle 0) (start_angle 0) (end_angle 90) (stroke (width 0.2) (type solid)) (layer "F.SilkS") (uuid "a"))`);
  const e = extent(polyPts(only(doc)));
  assert(e[0] > -0.01 && e[2] < 4.01, "x within the first quadrant: " + e);
});
test("point: a marker at its position", () => {
  const doc = pcb(`(point (at 5 6) (size 1) (layer "F.SilkS") (uuid "p"))`);
  const it = only(doc); assert(it && it.geom.length > 0, "point has geometry");
  assert(it.bbox[0] <= 5 && it.bbox[2] >= 5 && it.bbox[1] <= 6 && it.bbox[3] >= 6, "bbox holds the point: " + it.bbox);
});
test("barcode (Code 39): bars inside its box", () => {
  const doc = pcb(`(barcode (at 10 10 0) (layer "F.SilkS") (size 20 5) (text "AB1") (type code39) (uuid "b"))`);
  const it = only(doc); assert(it, "barcode parsed");
  const bars = it.geom.filter((g) => g.t === "poly" || g.t === "rect" || (g.pts && g.pts.length === 4));
  assert(bars.length >= 10, "bars drawn: " + it.geom.length);
  assert(it.bbox[2] - it.bbox[0] <= 20.5, "within its width: " + it.bbox);
});
test("SVG export draws board text in the stroke font when the stroke font is on", () => {
  const doc = pcb(`(gr_text "HELLO" (at 10 10 0) (layer "F.SilkS") (effects (font (size 1.5 1.5) (thickness 0.2))) (uuid "t"))`);
  const prev = K.textMode;
  try {
    K.textMode = "stroke"; const s = K.renderSvg(doc, {});
    assert(!/<text/.test(s), "no <text> elements"); assert(/<path[^>]*d="M/.test(s), "stroked paths");
    K.textMode = "native"; assert(/<text/.test(K.renderSvg(doc, {})), "canvas fonts still give <text>");
  } finally { K.textMode = prev; }
});

console.log(`shapes: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
