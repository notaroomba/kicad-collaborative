// node server/static/tests/pcb-visuals.test.js — board feedback colours as PCB_PAINTER / PCB_RENDER_SETTINGS::GetColor paint them.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

function recCtx(w, h) {
  const calls = {}; const ops = []; let stroke = "", fill = "", alpha = 1, lw = 1;
  const ctx = { canvas: { width: w, height: h }, calls, font: "", textAlign: "", textBaseline: "", lineCap: "", lineJoin: "" };
  for (const n of ["setTransform", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "setLineDash", "clearRect", "bezierCurveTo", "quadraticCurveTo", "ellipse"]) ctx[n] = () => {};
  ctx.measureText = (t) => ({ width: t.length * 0.7 });
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage", "clip"]) ctx[n] = (...args) => ops.push({ op: n, stroke, fill, alpha, lw, args });
  ctx.ops = ops; return ctx;
}
const HEAD = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user)) (net 0 "") (net 1 "A") ';
const view = (doc) => { const b = doc.bbox; const ppm = Math.min(800 / (b[2] - b[0] + 4), 600 / (b[3] - b[1] + 4)); return { ppm, zoom: 1, panX: 0, panY: 0, x0: b[0] - 2, y0: b[1] - 2, dpr: 1 }; };
const doc = K.parseDoc(HEAD + '(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1")) (segment (start 0 5) (end 10 5) (width 0.25) (layer "B.Cu") (net 0) (uuid "s2"))'
  + ' (gr_line (start -1 -1) (end 11 -1) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "e1")))');
const draw = (opts, d) => { const ctx = recCtx(800, 600); K.render(d || doc, ctx, view(d || doc), Object.assign({ frame: false, netNames: false }, opts)); return ctx.ops; };
const cu = K.pcbColor("F.Cu"), bcu = K.pcbColor("B.Cu"), edge = K.pcbColor("Edge.Cuts");
const strokes = (ops, c) => ops.filter((o) => o.op === "stroke" && o.stroke === c);

test("COLOR4D helpers: Darkened, Mix, a brightened item", () => {
  assert.strictEqual(K.darkened("#C83434", 0.5), "#641a1a");
  assert.strictEqual(K.mixColor("#FFFFFF", "#000000", 0.2), "#333333");
  assert.strictEqual(K.mixColor("rgba(200,52,52,0.6)", "#001023", 0.2).toLowerCase().replace(/\s/g, ""), "rgba(40,23,38,0.6)");
  assert.strictEqual(K.brightenedItemColor("#C83434").replace(/\s/g, ""), "rgba(228,154,154,0.8)");
});

test("net highlight: the rest darkened 0.5 toward black, opaque; a selected item keeps its selected colour; no halo", () => {
  let ops = draw({ highlight: new Set(["s1"]) });
  assert(strokes(ops, K.highlightColor(cu, true)).length === 1, "s1 brightened");
  assert(strokes(ops, K.darkened(bcu, 0.5)).length === 1 && strokes(ops, K.darkened(bcu, 0.5))[0].alpha === 1, "s2 darkened, opaque");
  assert(!ops.some((o) => o.op === "stroke" && o.alpha < 1), "no halo pass");
  ops = draw({ highlight: new Set(["s1"]), selected: new Set(["s2"]) });
  assert(strokes(ops, K.selectedColor(bcu)).length === 1, "selected s2 is not darkened");
});

test("high contrast: inactive layers mixed with the background, Edge.Cuts at 0.3, selection and highlight exempt", () => {
  let ops = draw({ highContrast: true, activeLayer: "F.Cu" });
  assert(strokes(ops, cu).length === 1, "active layer untouched");
  assert(strokes(ops, K.mixColor(bcu, K.PCB_BG, 0.2)).length === 1, "B.Cu mixed at 0.2");
  assert(strokes(ops, K.mixColor(edge, K.PCB_BG, 0.3)).length === 1, "Edge.Cuts floor 0.3");
  ops = draw({ highContrast: true, activeLayer: "F.Cu", inactiveHide: true });
  assert(!ops.some((o) => o.stroke === K.mixColor(bcu, K.PCB_BG, 0.2) || o.stroke === bcu), "hide: B.Cu gone");
  assert(strokes(ops, K.mixColor(edge, K.PCB_BG, 0.3)).length === 1, "hide: Edge.Cuts still drawn, mixed");
  ops = draw({ highContrast: true, activeLayer: "F.Cu", selected: new Set(["s2"]) });
  assert(strokes(ops, K.selectedColor(bcu)).length === 1, "a selected item on an inactive layer is not dimmed");
  ops = draw({ highContrast: true, activeLayer: "F.Cu", highlight: new Set(["s2"]) });
  assert(strokes(ops, K.highlightColor(bcu, true)).length === 1, "a highlighted item on an inactive layer is not dimmed");
  ops = draw({ highContrast: true, activeLayer: "F.Cu", hcDimming: 0.9 });
  assert(strokes(ops, K.mixColor(bcu, K.PCB_BG, 0.1)).length === 1 && strokes(ops, K.mixColor(edge, K.PCB_BG, 0.3)).length === 1, "dimming factor 0.9: 0.1, Edge.Cuts still 0.3");
});

test("brightened items: Brightened(0.5) at alpha 0.8, over selection and highlight", () => {
  const ops = draw({ brightened: new Set(["s2"]), highlight: new Set(["s1"]), selected: new Set(["s2"]) });
  assert(strokes(ops, K.brightenedItemColor(bcu)).length === 1, "s2 brightened");
});

test("locked item shadow: board units, margin 4 × silk line width; a footprint fills its body box", () => {
  assert.strictEqual(K.lockedShadowMargin(), 0.4); assert.strictEqual(K.lockedShadowMargin(0.15), 0.6);
  const objects = { hide: new Set(), show: new Set(["lockedShadow"]), opacity: {} };
  let ops = draw({ objects, lockedIds: new Set(["s1"]) });
  const sh = ops.filter((o) => o.op === "stroke" && o.stroke === "#FF26E2");
  assert(sh.length === 1 && Math.abs(sh[0].lw - 0.65) < 1e-9 && sh[0].alpha === 0.5, "track: width + margin at alpha 0.5 " + JSON.stringify(sh.map((o) => [o.lw, o.alpha])));
  ops = draw({ objects, lockedIds: new Set(["s1"]), silkLineWidth: 0.2 });
  assert(Math.abs(ops.find((o) => o.op === "stroke" && o.stroke === "#FF26E2").lw - 1.05) < 1e-9, "the board's silk width sets the margin");
  ops = draw({ objects, lockedIds: new Set(["s2"]), highContrast: true, activeLayer: "F.Cu" });
  assert(!ops.some((o) => o.stroke === "#FF26E2"), "no shadow for a track on a dimmed layer");
  ops = draw({ objects, lockedIds: new Set(["s1"]), hidden: new Set(["F.Cu"]) });
  assert(!ops.some((o) => o.stroke === "#FF26E2"), "no shadow on a hidden layer");
  const fp = K.parseDoc(HEAD + '(footprint "T:R" (layer "F.Cu") (uuid "fp") (at 5 5) (fp_line (start -2 -1) (end 2 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1"))'
    + ' (fp_text reference "R1" (at 0 -6) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))'
    + ' (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1"))))');
  ops = draw({ objects, lockedIds: new Set(["fp"]) }, fp);
  const body = ops.find((o) => o.op === "fill" && o.fill === "#FF26E2");
  assert(body, "body box filled");
  const box = K.footprintBodyBox(fp.items.get("fp"));
  assert(box[1] > -1.5 && box[1] < 4, "the body box leaves the reference text out " + JSON.stringify(box));
});

test("markers: a selected marker is LAYER_DRC_HIGHLIGHTED", () => {
  const ctx = recCtx(100, 100);
  K.drawMarkers(ctx, [{ x: 0, y: 0, severity: "error" }, { x: 5, y: 5, severity: "warning", selected: true }], "pcb", 0.16, K.PCB_BG);
  const fills = ctx.ops.filter((o) => o.op === "fill").map((o) => o.fill);
  assert(fills.includes(K.MARKER_COLORS.pcb.error) && fills.includes("#FF00FF"), JSON.stringify(fills));
});

test("high contrast: a blind via that does not reach the active copper layer is not drawn (PCB_VIA::ViewGetLOD)", () => {
  assert(K.viaSpans(["F.Cu", "In2.Cu"], "In1.Cu") && K.viaSpans(["F.Cu", "In2.Cu"], "F.Cu") && !K.viaSpans(["F.Cu", "In2.Cu"], "B.Cu") && !K.viaSpans(["In2.Cu", "B.Cu"], "In1.Cu"));
  const d = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user)) (net 0 "")'
    + ' (via blind (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net 0) (uuid "v1"))'
    + ' (via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v2")))');
  const rings = (ops) => ops.filter((o) => o.op === "fill" && o.fill === K.pcbColor("F.Cu")).length;
  const on = (layer) => draw({ highContrast: true, activeLayer: layer }, d);
  const offB = draw({ highContrast: true, activeLayer: "B.Cu" }, d).filter((o) => o.op === "fill").length;
  const onF = draw({ highContrast: true, activeLayer: "F.Cu" }, d).filter((o) => o.op === "fill").length;
  assert(onF > offB, "the blind via drawn on F.Cu, hidden on B.Cu (" + onF + " vs " + offB + ")");
  assert(rings(on("F.SilkS")) >= 1, "a front technical layer counts as F.Cu");
});

test("a footprint field selected on its own: repainted alone, with its umbilical line to the footprint anchor in LAYER_ANCHOR", () => {
  const fp = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 10 10 90) (uuid "fp")'
    + ' (property "Reference" "R1" (at 0 -3 90) (layer "F.SilkS") (uuid "r") (effects (font (size 1 1) (thickness 0.15))))'
    + ' (property "Value" "10k" (at 0 3 90) (layer "F.Fab") (uuid "v") (effects (font (size 1 1) (thickness 0.15))))'
    + ' (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1"))))');
  const it = fp.items.get("fp");
  const ref = it.geom.find((g) => g.t === "text" && g.field === "Reference");
  assert(ref && ref.textPos, "the field keeps its position");
  assert(Math.abs(ref.textPos[0] - 7) < 1e-9 && Math.abs(ref.textPos[1] - 10) < 1e-9, "rotated with the footprint: " + JSON.stringify(ref.textPos));
  assert.deepEqual(K.umbilicalLines(fp, new Set(["fp#field:Reference"])), [[ref.textPos, [10, 10]]]);
  assert.deepEqual(K.umbilicalLines(fp, new Set(["fp"])), [], "a selected footprint draws none");
  const ops = draw({ selected: new Set(["fp#field:Reference"]) }, fp);
  assert(ops.some((o) => o.op === "stroke" && o.stroke === "#FF26E2"), "the umbilical line");
  const silkSel = K.selectedColor(K.pcbColor("F.SilkS"));
  const inks = (c) => ops.filter((o) => (o.op === "stroke" && o.stroke === c) || (o.op === "fillText" && o.fill === c)).length;
  assert(inks(silkSel) > 0, "the reference in the selected colour");
  assert.strictEqual(inks(K.selectedColor(K.pcbColor("F.Fab"))), 0, "the value is not");
});

test("Footprint Editor: a selected field's umbilical runs to the origin", () => {
  const d = K.parseDoc('(footprint "x" (version 20240108) (generator "t") (layer "F.Cu") (property "Reference" "REF**" (at 1 -2 0) (layer "F.SilkS") (uuid "r") (effects (font (size 1 1) (thickness 0.15)))))');
  if (!d.fpEditor) return;   // the footprint document model is built elsewhere
  assert.deepEqual(K.umbilicalLines(d, new Set(["r"])), [[[1, -2], [0, 0]]]);
});

test("Footprint Editor: a selected user text (fp_text user) draws its umbilical to the origin too", () => {
  const d = K.parseDoc('(footprint "x" (version 20240108) (generator "t") (layer "F.Cu") (fp_text user "${REFERENCE}" (at 0.5 1.5 0) (layer "F.Fab") (uuid "t1") (effects (font (size 1 1) (thickness 0.15)))))');
  if (!d.fpEditor) return;
  const t = [...d.items.values()].find((it) => it.kind === "gr_text"); assert(t, "the user text is a gr_text item");
  assert.deepEqual(K.umbilicalLines(d, new Set([t.id])), [[[0.5, 1.5], [0, 0]]]);
});

test("via stitching generator: its outline and the inward hairline ticks every 2 mm, 0.5 mm long", () => {
  const node = K.parse('(generated (uuid "g") (type via_stitch) (name "") (pitch 2) (outline (pts (xy 0 0) (xy 10 0) (xy 10 6) (xy 0 6))) (members))');
  const pts = K.viaStitchOutline(node); assert.deepEqual(pts, [[0, 0], [10, 0], [10, 6], [0, 6]]);
  assert.equal(K.viaStitchOutline(K.parse('(generated (type tuning_pattern))')), null);
  const ticks = K.viaStitchTicks(pts);
  assert.equal(ticks.length, 4 + 2 + 4 + 2, "t = 2, 4, 6, 8 on the long sides, 2, 4 on the short ones");
  assert.deepEqual(ticks[0], [[2, 0], [2, 0.5]], "inward, toward the centroid");
  assert.deepEqual(ticks[4].map((p) => p.map((v) => +v.toFixed(9))), [[10, 2], [9.5, 2]]);
  const d = K.parseDoc(HEAD + '(generated (uuid "g") (type via_stitch) (name "") (outline (pts (xy 0 0) (xy 10 0) (xy 10 6) (xy 0 6))) (members))'
    + ' (gr_line (start -1 -1) (end 11 -1) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "e1")))');
  const objects = { show: new Set(["viaStitching"]), hide: new Set() };
  assert(draw({ objects }, d).some((o) => o.op === "stroke" && o.stroke === "#4DCCB2"), "drawn in LAYER_VIA_STITCHING");
  assert(!draw({ objects: { show: new Set(), hide: new Set() } }, d).some((o) => o.op === "stroke" && o.stroke === "#4DCCB2"), "hidden with its row off");
});

test("grid items (PCB_GRID_ITEM): geometry, precedence, sparse pitch, drawn over the grid with a darkened outline", () => {
  const g = K.gridItemGeom(K.parse('(grid_item xy (at 10 20) (extent 5 3) (spacing 1 0.5) (angle 30) (priority 2) (tick_interval 5) (affects (cursor yes) (routing yes) (placement yes)) (uuid "g1"))'));
  assert.deepEqual([g.kind, g.origin, g.extent, g.pitch, g.priority, g.tick], ["xy", [10, 20], [5, 3], [1, 0.5], 2, 5]);
  assert(Math.abs(g.orientation - Math.PI / 6) < 1e-12);
  const p = K.gridItemGeom(K.parse('(grid_item polar (at 0 0) (extent 10 90) (spacing 2 15) (priority 1) (uuid "g2"))'));
  assert(Math.abs(p.extent[1] - Math.PI / 2) < 1e-12 && Math.abs(p.pitch[1] - Math.PI / 12) < 1e-12, "polar angles in radians");
  assert(Math.abs(K.gridItemArea(p) - 0.5 * 100 * Math.PI / 2) < 1e-9 && K.gridItemArea(g) === 60);
  assert(K.gridTakesPrecedence(g, p) && !K.gridTakesPrecedence(p, g), "higher priority first");
  const q = Object.assign({}, g, { priority: 1 }); assert(K.gridTakesPrecedence(q, p), "same priority: the smaller area");
  assert.strictEqual(K.autoSparsePitch(0.1, 10, 0.5), 1); assert.strictEqual(K.autoSparsePitch(0.1, 0, 0.5), 0.8); assert.strictEqual(K.autoSparsePitch(1, 10, 0.5), 1);
  const d = K.parseDoc(HEAD + '(grid_item xy (at 5 0) (extent 4 2) (spacing 1 1) (priority 1) (uuid "g1"))'
    + ' (gr_line (start -1 -1) (end 11 -1) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "e1")))');
  const ops = draw({ grid: 0.5 }, d);
  assert(ops.some((o) => o.op === "fill" && o.fill === "#C2C200"), "the lattice in LAYER_SUBGRIDS");
  assert(ops.some((o) => o.op === "stroke" && o.stroke === K.darkened("#C2C200", 0.75)), "the coverage outline");
  // drawGridSources claims the coverage in the stencil only: nothing is painted over it (the axes stay), and the
  // background grid is clipped to outside it
  assert(!ops.some((o) => o.op === "fill" && o.fill === K.PCB_BG), "the coverage is not painted with the background");
  const firstClip = ops.findIndex((o) => o.op === "clip"), gridDots = ops.findIndex((o) => o.op === "fill" && o.fill === "#848484");   // PCB_GRID
  assert(firstClip >= 0 && ops[firstClip].args[0] === "evenodd" && gridDots > firstClip, "the background grid is drawn outside the grid item's coverage");
  const axes = draw({ grid: 0.5, gridAxes: true }, d), axisIdx = axes.findIndex((o) => o.op === "stroke" && o.stroke === "#C2C2C2");   // PCB_GRID_AXES
  assert(axisIdx >= 0 && !axes.slice(axisIdx).some((o) => o.op === "fill" && o.fill === K.PCB_BG), "the axes are not covered afterwards");
  assert(!draw({ grid: 0.5, subgrids: false }, d).some((o) => o.fill === "#C2C200"), "Appearance ▸ Grids off");
  const lit = draw({ grid: 0.5, selected: new Set(["g1"]) }, d);
  assert(lit.some((o) => o.op === "fill" && o.fill === K.brightened("#C2C200", 0.5)), "a selected grid brightened");
  assert(lit.some((o) => o.op === "fill" && o.fill === K.PCB_BG && o.alpha === 0.4), "a selected grid only washes its area");
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
