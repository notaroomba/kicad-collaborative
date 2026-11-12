// Node test for the measure tool's RULER_ITEM port (web/editor/ruler.ts) and the selection-area winding
// (web/editor/overlays.ts): readout strings, tick spacing per zoom, Shift's 45° end, the tick / label layout.
// Run: node server/static/tests/ruler.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const R = load(["editor", "ruler.ts"]);

const MM = 1e6;
const view = (pxPerMm) => ({ scale: pxPerMm / MM, toScreen: (p) => [p[0] * pxPerMm / MM + 500, p[1] * pxPerMm / MM + 500], screen: [1000, 1000], viewport: [-1e12, -1e12, 1e12, 1e12], textWidth: (t, size, pen) => t.length * size + pen });

test("GetDimensionStrings: x, y, r and θ (the angle negated: up is positive), as DimensionLabel formats them", () => {
  assert.deepEqual(R.rulerStrings([0, 0], [10 * MM, -10 * MM], "mm"), ["x: 10.000 mm", "y: -10.000 mm", "r: 14.142 mm", "θ: 45.0°"]);
  assert.deepEqual(R.rulerStrings([0, 0], [5 * MM, 0], "mm"), ["x: 5.000 mm", "y: 0.000 mm", "r: 5.000 mm", "θ: -0.0°"]);   // -EDA_ANGLE(0) prints as -0.0
  assert.deepEqual(R.rulerStrings([0, 0], [-25.4 * MM, 0], "in"), ["x: -1.0000 in", "y: 0.0000 in", "r: 1.0000 in", "θ: 180.0°"]);
  assert.deepEqual(R.rulerStrings([0, 0], [0, 2.54 * MM], "mil"), ["x: 0.0 mils", "y: 100.0 mils", "r: 100.0 mils", "θ: -90.0°"]);
  assert.deepEqual(R.rulerStrings([0, 0], [3 * MM, 4 * MM], "mm", true, false).slice(0, 2), ["x: -3.000 mm", "y: 4.000 mm"]);   // Invert X axis
});

test("getTickFormatForScale: 1/2/5 per decade from 1 nm (2.54 nm imperial), at least 10 px apart", () => {
  assert.deepEqual(R.tickFormatForScale(10 / MM, "mm"), { format: { divisionBase: 2, majorStep: 10, midStep: 5 }, space: 1e6 });
  const f4 = R.tickFormatForScale(4 / MM, "mm"); assert.equal(f4.format.majorStep, 2); assert.ok(Math.abs(f4.space - 5e6) < 1e-3);
  const fi = R.tickFormatForScale(10 / MM, "in"); assert.equal(fi.format.majorStep, 2); assert.ok(Math.abs(fi.space - 1.27e6) < 1e-3);
});

test("Shift holds the end to 45° (GetVectorSnapped45)", () => {
  assert.deepEqual(R.snapped45([0, 0], [10, 3]), [10, 0]);
  assert.deepEqual(R.snapped45([0, 0], [2, -9]), [0, -9]);
  assert.deepEqual(R.snapped45([0, 0], [10, -7]), [10, -10]);
  assert.deepEqual(R.snapped45([5, 5], [-1, 12]), [-2, 12]);
});

test("RULER_ITEM::ViewDraw: shadow pass then line pass; ticks to the last whole space; labels on the mid and major ticks", () => {
  assert.deepEqual(R.rulerOps([0, 0], [0, 0], "mm", view(10)), []);   // an empty ViewBBox: nothing drawn
  const ops = R.rulerOps([0, 0], [20 * MM, 0], "mm", view(10));
  const shadow = ops.filter((o) => o.shadow), line = ops.filter((o) => !o.shadow);
  assert.equal(shadow.length, line.length); assert.ok(ops.indexOf(line[0]) === shadow.length);
  assert.deepEqual(line[0], { kind: "line", a: [0, 0], b: [20 * MM, 0], w: 14 / 10 * MM * 0.2 * 0.8, shadow: false });
  const texts = line.filter((o) => o.kind === "text");
  assert.deepEqual(texts.slice(0, 4).map((t) => t.text), ["x: 20.000 mm", "y: 0.000 mm", "r: 20.000 mm", "θ: -0.0°"]);
  assert.deepEqual(texts.slice(4).map((t) => t.text), ["0.000", "5.000", "10.000", "15.000"]);   // tick 20 is past ceil(len/space) - 1
  const lab = texts[5]; assert.equal(lab.h, "right"); assert.equal(lab.rot, 270);                 // a rightward ruler: labels read along the ticks
  assert.ok(Math.abs(lab.at[0] - 5 * MM) < 1e-6 && Math.abs(lab.at[1] + 17.5 / 10 * MM) < 1e-6);  // majorTickLen = 5 px * 3.5 off the line
  assert.equal(lab.size, 12 / 10 * MM);
  const ticks = line.filter((o) => o.kind === "line").slice(1, 21);
  assert.equal(ticks.length, 20);
  assert.ok(Math.abs(ticks[0].b[1] + 12.5 / 10 * MM) < 1e-6);   // major: 5 px * 2.5, on the side of the labels
  assert.ok(Math.abs(ticks[1].b[1] + 5 / 10 * MM) < 1e-6);      // minor
  assert.ok(Math.abs(ticks[5].b[1] + 7.5 / 10 * MM) < 1e-6);    // mid
  // readout: quadrant (prefX, prefY) = (1, -1) for a rightward ruler: right-aligned 15 px left of the end, below it, one line pitch apart
  assert.equal(texts[0].h, "right"); assert.ok(Math.abs(texts[0].at[0] - (20 * MM - 15 / 10 * MM)) < 1e-6);
  assert.ok(Math.abs(texts[0].at[1] - 14 * 1.9 / 10 * MM) < 1e-6);
  assert.ok(Math.abs(texts[1].at[1] - texts[0].at[1] - 14 * 1.9 / 10 * MM) < 1e-6);
});

test("the readout moves to a quadrant that stays on screen", () => {
  const v = view(10); v.toScreen = () => [5, 500];   // the cursor at the left edge: the preferred left side does not fit
  const t = R.rulerOps([0, 0], [20 * MM, 0], "mm", v).filter((o) => !o.shadow && o.kind === "text")[0];
  assert.equal(t.h, "left");
});

test("selection lasso winding: clockwise on screen (y down) selects inside", () => {
  const O = load(["editor", "overlays.ts"]);
  assert.ok(O.lassoArea([[0, 0], [10, 0], [10, 10], [0, 10]]) > 0);
  assert.ok(O.lassoArea([[0, 0], [0, 10], [10, 10], [10, 0]]) < 0);
});
