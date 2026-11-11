// node server/static/tests/perf.test.js — perf smoke test for kicad-canvas.js: parsing and painting the big demo board
// (demos/video) with a recording 2D-context stub, at fit, mid and deep zoom, against generous budgets; and the
// editor's strip repaint (render's `region` option): clipped, and culled to the strip.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

const DEMO = path.join(__dirname, "..", "..", "..", "demos", "video");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

function stubCtx(w, h) {
  const calls = {}; const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
  const ctx = { canvas: { width: w, height: h }, calls, font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", lineJoin: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
  for (const n of ["setTransform", "fillRect", "strokeRect", "clearRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash", "drawImage", "clip"]) ctx[n] = () => rec(n);
  ctx.measureText = (t) => { rec("measureText"); return { width: t.length * 0.7 }; };
  return ctx;
}
const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

const pcbFile = path.join(DEMO, "video.kicad_pcb"), schFile = path.join(DEMO, "video.kicad_sch");
if (!fs.existsSync(pcbFile)) { console.log("perf: demos/video not found, skipped"); process.exit(0); }

const W = 1400, H = 860;
function viewAt(doc, zoom, fx, fy) {
  const b = doc.bbox, ppm = Math.min(W / (b[2] - b[0]), H / (b[3] - b[1]));
  const v = { ppm, zoom, panX: 0, panY: 0, x0: b[0], y0: b[1], dpr: 1 };
  if (zoom !== 1) { const mx = b[0] + (b[2] - b[0]) * fx, my = b[1] + (b[3] - b[1]) * fy; v.x0 = mx - W / (2 * ppm * zoom); v.y0 = my - H / (2 * ppm * zoom); }
  return v;
}

let pcb, sch;
test("parse budget: the demo board and its root sheet", () => {
  const tp = ms(() => { pcb = K.parseDoc(fs.readFileSync(pcbFile, "utf8"), "kicad_pcb"); });
  const ts = ms(() => { sch = K.parseDoc(fs.readFileSync(schFile, "utf8"), "kicad_sch"); });
  assert(pcb.items.size > 1000, "board items " + pcb.items.size);
  assert(tp < 6000, `board parse ${tp.toFixed(0)} ms over the 6 s budget`);
  assert(ts < 3000, `sheet parse ${ts.toFixed(0)} ms over the 3 s budget`);
});

for (const [name, zoom] of [["fit", 1], ["mid", 4], ["deep", 20]]) {
  test(`frame budget at ${name} zoom (board and sheet)`, () => {
    for (const doc of [pcb, sch]) {
      const v = viewAt(doc, zoom, 0.45, 0.5), ctx = stubCtx(W, H), ts = [];
      for (let i = 0; i < 5; i++) ts.push(ms(() => K.render(doc, ctx, v, { grid: doc.type === "pcb" ? 0.25 : 1.27, selected: new Set(), hidden: new Set() })));
      const m = median(ts);
      assert(m < 1500, `${doc.type} ${name}: ${m.toFixed(0)} ms per frame over the 1.5 s budget`);
    }
  });
}

test("region repaint: clipped to the strip, culled to it, and the context left balanced", () => {
  const v = viewAt(pcb, 4, 0.45, 0.5);
  const full = stubCtx(W, H); K.render(pcb, full, v, { grid: 0.25 });
  const strip = stubCtx(W, H); K.render(pcb, strip, v, { grid: 0.25, region: [0, 0, 24, H] });
  assert.strictEqual(strip.calls.clip, 1, "one clip for the region");
  assert.strictEqual(strip.calls.save || 0, strip.calls.restore || 0, "save / restore balanced");
  const work = (c) => (c.calls.fill || 0) + (c.calls.stroke || 0) + (c.calls.fillRect || 0) + (c.calls.strokeRect || 0);
  assert(work(strip) < work(full) / 3, `a 24 px strip drew ${work(strip)} shapes against ${work(full)} for the whole view`);
});

console.log(`perf: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
