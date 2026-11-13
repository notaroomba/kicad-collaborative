// sch-format.test.js — Schematic Setup > Formatting values the painter takes at paint time: the hop-over arcs where
// wires cross (SCH_LINE::ShouldHopOver / BuildWireWithHopShape) and the overbar height (overbar_offset_ratio).
// Run: node server/static/tests/sch-format.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const W = (id, a, b, k = "wire") => `(${k} (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
function recCtx() {
  const ops = []; const ctx = { canvas: { width: 400, height: 300 }, measureText: (t) => ({ width: t.length * 0.7 }), lineWidth: 1, globalAlpha: 1 };
  for (const n of ["setTransform", "beginPath", "closePath", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "setLineDash", "clearRect", "bezierCurveTo", "quadraticCurveTo", "ellipse", "stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = () => {};
  ctx.moveTo = (x, y) => ops.push(["M", x, y]); ctx.lineTo = (x, y) => ops.push(["L", x, y]); ctx.arc = (...a) => ops.push(["A", ...a]);
  ctx.ops = ops; return ctx;
}
const view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };

test("ShouldHopOver: a horizontal wire hops over a vertical one, never the other way; else the shallower hops", () => {
  const h = { a: [0, 0], b: [10, 0] }, v = { a: [5, -5], b: [5, 5] }, d1 = { a: [0, 0], b: [10, 5] }, d2 = { a: [0, 0], b: [5, 10] };
  assert.strictEqual(K.wireHopShape ? true : true, true);
  const S = (m, o) => K.wireHopShape(m, [m, o], 1).length > 1;
  assert.ok(S(h, v)); assert.ok(!S(v, h));
  const d1x = { a: [0, 5], b: [10, 0] }, steep = { a: [4, -5], b: [6, 5] };
  assert.ok(S(d1x, steep) && !S(steep, d1x), "the shallower of two slanted wires hops");
});

test("BuildWireWithHopShape: runs and an arc of the hop radius over each crossing; ends and T-junctions do not hop", () => {
  const me = { a: [0, 0], b: [20, 0] }, all = [me, { a: [5, -5], b: [5, 5] }, { a: [12, -5], b: [12, 5] }, { a: [15, 0], b: [15, 6] }];
  const sh = K.wireHopShape(me, all, 0.5);
  assert.deepStrictEqual(sh.map((p) => p.t), ["seg", "arc", "seg", "arc", "seg"]);
  assert.deepStrictEqual(sh[0].b, [4.5, 0]); assert.deepStrictEqual(sh[1].m, [5, -0.5], "the arc rises above a horizontal wire");
  assert.deepStrictEqual(sh[4].b, [20, 0]);
});

test("the painter draws hop arcs only when the project's hop-over size is set", () => {
  const doc = K.parseDoc(HEAD + W("w1", [0, 5], [20, 5]) + W("w2", [10, 0], [10, 10]) + ")");
  K.setSchFormatting({ hopOverChoice: 0 }, doc);
  let ctx = recCtx(); K.render(doc, ctx, view, {}); assert.ok(!ctx.ops.some((o) => o[0] === "A" && Math.abs(o[1] - 10) < 1e-6), "no hop at size None");
  K.setSchFormatting({ hopOverChoice: 3 }, doc);
  assert.ok(Math.abs(K.hopOver.radius - 0.1524 * 6) < 1e-9, "Medium: 6 x the default line width");
  ctx = recCtx(); K.render(doc, ctx, view, {});
  const arc = ctx.ops.find((o) => o[0] === "A" && Math.abs(o[1] - 10) < 1e-6 && Math.abs(o[2] - 5) < 1e-6);
  assert.ok(arc, "an arc centred on the crossing"); assert.ok(Math.abs(arc[3] - 0.9144) < 1e-6, "radius " + arc[3]);
  K.setSchFormatting({ hopOverChoice: 0 }, doc);
});

test("overbar_offset_ratio moves the ~{overbar} stroke", () => {
  const doc = K.parseDoc(HEAD + '(text "~{RST}" (at 0 0 0) (effects (font (size 2 2)) (justify left bottom)) (uuid "t1")))');
  const barY = () => { const ctx = recCtx(); K.render(doc, ctx, view, {}); const ys = []; for (let i = 0; i + 1 < ctx.ops.length; i++) { const a = ctx.ops[i], b = ctx.ops[i + 1]; if (a[0] === "M" && b[0] === "L" && Math.abs(a[2] - b[2]) < 1e-9 && Math.abs(b[1] - a[1]) > 2) ys.push(a[2]); } return Math.min(...ys); };
  const y0 = barY();
  K.setSchFormatting({ overbarHeight: 1.5 }, doc);
  const y1 = barY();
  K.setSchFormatting({ overbarHeight: 1.23 }, doc);
  assert.ok(y1 < y0 - 0.3, `higher bar: ${y0} -> ${y1}`);
});

console.log(`sch-format: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
