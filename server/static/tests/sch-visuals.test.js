// sch-visuals.test.js — eeschema's visual feedback in the canvas painter: net highlight without dimming, the selection
// VIEW_GROUP drawn over the sheet (backgrounds at half alpha, then the shadow, then the strokes), the text box's filled
// shadow, label / text anchors, unselected line-end squares, bus-connected labels, rounded and hatched shapes,
// sim-exclusion markers and their View toggle, ERC marker filters, the local power icon and bus-entry dangling ends.
// Run: node server/static/tests/sch-visuals.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, _ = globalThis.CollabTools.sch._;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
function recCtx(w, h) {
  const ops = []; let stroke = "", fill = "", alpha = 1, lw = 1;
  const ctx = { canvas: { width: w, height: h }, font: "", textAlign: "", textBaseline: "", lineCap: "", lineJoin: "", calls: {} };
  for (const n of ["setTransform", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "setLineDash", "clearRect", "bezierCurveTo", "quadraticCurveTo", "ellipse"]) ctx[n] = () => {};
  ctx.measureText = (t) => ({ width: t.length * 0.7 });
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = (...args) => { ops.push({ op: n, stroke, fill, alpha, lw, args }); };
  ctx.ops = ops; return ctx;
}
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
const SH = K.SCH.selection;
const LIB = `(lib_symbols (symbol "L:R" (pin_names (offset 0)) (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (symbol "R_0_1" (rectangle (start -1 2) (end 1 -2) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.81) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
const SYM = (id, x, y, extra = "") => `(symbol (lib_id "L:R") (at ${x} ${y} 0) (unit 1) ${extra} (uuid "${id}") (property "Reference" "R1" (at ${x + 3} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "10k" (at ${x + 3} ${y + 2} 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "R_0603" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) hide)))`;

test("net highlight: the net brightened, every other item drawn as it is (SCH_EDITOR_CONTROL has no dimming)", () => {
  const doc = K.parseDoc(HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (uuid "w1")) (wire (pts (xy 0 5) (xy 10 5)) (uuid "w2")))');
  const ctx = recCtx(400, 300); K.render(doc, ctx, view, { highlight: new Set(["w1"]) });
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === K.SCH.wire && o.alpha === 1));
  assert(!ctx.ops.some((o) => o.alpha === K.HL_DIM));
});
test("selection: the selected symbol is drawn after every unselected item, its body at half alpha, under its shadow", () => {
  const doc = K.parseDoc(HEAD + LIB + SYM("r1", 20, 20) + '(wire (pts (xy 15 20) (xy 25 20)) (uuid "w1")))');
  const ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["r1"]) });
  const ops = ctx.ops, body = ops.findIndex((o) => o.op === "fill" && o.fill === K.SCH.body);
  const wire = ops.findIndex((o) => o.op === "stroke" && o.stroke === K.SCH.wire), shadow = ops.findIndex((o) => o.stroke === SH);
  const outline = ops.findIndex((o, i) => i > shadow && o.op === "stroke" && o.stroke === K.SCH.outline);
  assert(wire >= 0 && body > wire, "the selected body comes after the unselected wire");
  assert.strictEqual(ops[body].alpha, 0.5, "LAYER_DEVICE_BACKGROUND WithAlpha( 0.5 )");
  assert(shadow > body && outline > shadow, "background, then shadow, then the strokes");
  // unselected: full alpha
  const c2 = recCtx(800, 600); K.render(doc, c2, view, {}); assert.strictEqual(c2.ops.find((o) => o.op === "fill" && o.fill === K.SCH.body).alpha, 1);
});
test("text box and table: the selection shadow fills the box, no glyph shadow", () => {
  const doc = K.parseDoc(HEAD + '(text_box "Hi" (at 10 10 0) (size 20 8) (stroke (width 0) (type solid)) (fill (type none)) (effects (font (size 1.27 1.27))) (uuid "tb")))');
  const ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["tb"]) });
  const fills = ctx.ops.filter((o) => o.op === "fillRect" && o.fill === SH);
  assert.strictEqual(fills.length, 1); assert.deepStrictEqual(fills[0].args.map((v) => +v.toFixed(3)), [10, 10, 20, 8]);
  assert(!ctx.ops.some((o) => o.op === "stroke" && o.stroke === SH), "no stroked shadow around the border or the glyphs");
});
test("anchors: a selected text always, a local label only when not dangling, a global label never", () => {
  const doc = K.parseDoc(HEAD + '(text "T" (at 5 5 0) (effects (font (size 1.27 1.27))) (uuid "t1")) (label "A" (at 20 5 0) (effects (font (size 1.27 1.27))) (uuid "l1")) (global_label "G" (shape input) (at 40 5 0) (effects (font (size 1.27 1.27))) (uuid "g1")))');
  const anchorStrokes = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.filter((o) => o.op === "stroke" && o.stroke === "#0000FF").length; };
  assert.strictEqual(anchorStrokes({ selected: new Set(["t1"]) }), 1, "text");
  assert.strictEqual(anchorStrokes({ selected: new Set(["l1"]) }), 1, "label not dangling");
  assert.strictEqual(anchorStrokes({ selected: new Set(["l1"]), dangling: new Set(["l1"]) }), 0, "dangling label");
  assert.strictEqual(anchorStrokes({ selected: new Set(["g1"]) }), 0, "global label");
  assert.strictEqual(anchorStrokes({ selected: new Set(["l1"]), moving: new Set(["l1"]) }), 0, "the label itself moving");
});
test("line ends: a line with one end selected squares the other end in the inverted shadow colour", () => {
  const doc = K.parseDoc(HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (uuid "w1")))');
  let c = recCtx(800, 600); K.render(doc, c, view, { frame: false, selected: new Set(["w1"]) });
  assert(!c.ops.some((o) => o.op === "strokeRect"), "a line selected whole: both ends selected, no squares");
  c = recCtx(800, 600); K.render(doc, c, view, { frame: false, selected: new Set(["w1", "w1#end:0"]) });
  const sq = c.ops.filter((o) => o.op === "strokeRect");
  assert.strictEqual(sq.length, 1); assert.strictEqual(sq[0].stroke, "rgba(184,130,77,0.8)");
  assert(Math.abs(sq[0].args[0] + sq[0].args[2] / 2 - 10) < 1e-9, "at the unselected end");
});
test("labels on a bus take the bus colour (HasBusConnection)", () => {
  const doc = K.parseDoc(HEAD + '(bus (pts (xy 0 0) (xy 20 0)) (uuid "b1")) (label "D[0..3]" (at 5 0 0) (effects (font (size 1.27 1.27))) (uuid "l1")) (label "X" (at 5 10 0) (effects (font (size 1.27 1.27))) (uuid "l2")))');
  K.textMode = "native";
  const c = recCtx(800, 600); K.render(doc, c, view, {});
  K.textMode = undefined;
  const texts = c.ops.filter((o) => o.op === "fillText");
  assert(texts.some((o) => o.args[0] === "D[0..3]" && o.fill === K.SCH.bus), "bus label");
  assert(texts.some((o) => o.args[0] === "X" && o.fill === K.SCH.label), "other label");
});
test("rounded rectangle and hatch fills (ROUNDRECT, EDA_SHAPE::UpdateHatching)", () => {
  const doc = K.parseDoc(HEAD + '(rectangle (start 0 0) (end 20 10) (radius 2) (stroke (width 0) (type default)) (fill (type hatch)) (uuid "r1")) (circle (center 40 5) (radius 5) (stroke (width 0) (type default)) (fill (type cross_hatch)) (uuid "c1")))');
  const r = doc.items.get("r1"), outline = r.geom.find((g) => g.t === "poly" && !g.noStroke);
  assert(outline.pts.length > 8, "corner arcs");
  assert(outline.pts.every(([x, y]) => x >= -1e-9 && x <= 20 + 1e-9 && y >= -1e-9 && y <= 10 + 1e-9));
  assert(!outline.pts.some(([x, y]) => Math.hypot(x, y) < 0.5), "the corner is cut");
  const hatch = r.geom.filter((g) => g.t === "line" && g.noShadow);
  assert(hatch.length > 5, "hatch lines"); assert(hatch.every((g) => Math.abs(g.w - 0.1524 / 2) < 1e-9), "width = pen / 2");
  assert(hatch.every((g) => Math.abs((g.y2 - g.y1) / (g.x2 - g.x1) + 1) < 1e-6), "slope -1");
  const ch = doc.items.get("c1").geom.filter((g) => g.t === "line" && g.noShadow);
  assert(ch.some((g) => (g.y2 - g.y1) / (g.x2 - g.x1) > 0) && ch.some((g) => (g.y2 - g.y1) / (g.x2 - g.x1) < 0), "cross hatch: both slopes");
});
test("excluded from simulation: full colours, the marker only, hidden by markSimExclusions off", () => {
  const doc = K.parseDoc(HEAD + LIB + SYM("r1", 20, 20, "(exclude_from_sim yes)") + ")");
  const it = doc.items.get("r1");
  assert(!it.geom.some((g) => g.alpha === 0.5)); assert(it.geom.some((g) => g.simMarker));
  const has = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.some((o) => o.stroke === K.SCH.excluded); };
  assert(has({}), "on by default"); assert(!has({ markSimExclusions: false }), "View > Mark Simulation Exclusions off");
});
test("sheet: DNP cross and dimmed pins, sim exclusion at half alpha", () => {
  const doc = K.parseDoc(HEAD + '(sheet (at 10 10) (size 20 15) (dnp yes) (exclude_from_sim yes) (stroke (width 0) (type solid)) (fill (color 0 0 0 0)) (uuid "s1") (property "Sheetname" "Sub" (at 10 9 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "sub.kicad_sch" (at 10 26 0) (effects (font (size 1.27 1.27)) (justify left top))) (pin "IN" input (at 10 15 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid "p1"))))');
  const it = doc.items.get("s1");
  assert.strictEqual(it.geom.filter((g) => g.color === K.SCH.dnp).length, 2, "the cross");
  assert(!it.geom.some((g) => g.color === K.SCH.sheetLabel), "pins dimmed");
  assert(it.geom.some((g) => g.simMarker && /,0\.5\)$/.test(g.color)), "marker at alpha 0.5");
});
test("hidden fields: kept aside in LAYER_HIDDEN, drawn under showHiddenText", () => {
  const doc = K.parseDoc(HEAD + LIB + SYM("r1", 20, 20) + ")");
  const it = doc.items.get("r1");
  assert(!it.geom.some((g) => g.field === "Footprint")); const h = (it.hiddenGeom || []).filter((g) => g.field === "Footprint");
  assert(h.length && h.every((g) => g.color === K.SCH.hidden && g.hiddenText));
  K.textMode = "native";
  const shown = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.filter((o) => o.op === "fillText" && o.args[0] === "R_0603"); };
  assert.strictEqual(shown({}).length, 0); const s = shown({ showHiddenText: true }); assert.strictEqual(s.length, 1); assert.strictEqual(s[0].alpha, 1);
  K.textMode = undefined;
});
test("ERC markers: warnings and errors shown by default, exclusions hidden, each one toggled", () => {
  const doc = K.parseDoc(HEAD + ")");
  const markers = [{ x: 1, y: 1, severity: "error" }, { x: 5, y: 1, severity: "warning" }, { x: 9, y: 1, severity: "exclusion" }];
  const n = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, Object.assign({ markers }, opts)); return c.ops.filter((o) => o.op === "fill").length; };
  const all = n({ showErcExclusions: true }); assert(all > 0);
  assert.strictEqual(n({}), all * 2 / 3); assert.strictEqual(n({ showErcErrors: false, showErcExclusions: true }), all * 2 / 3);
  assert.strictEqual(n({ showErcErrors: false, showErcWarnings: false }), 0);
});
test("directive labels: hidden by View > Show Directive Labels off unless selected", () => {
  const doc = K.parseDoc(HEAD + '(directive_label "" (at 10 10 0) (shape round) (effects (font (size 1.27 1.27))) (uuid "d1")))');
  const n = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.filter((o) => o.op === "stroke" && o.stroke === K.SCH.netclass).length; };
  assert(n({}) > 0); assert.strictEqual(n({ showDirectiveLabels: false }), 0); assert(n({ showDirectiveLabels: false, selected: new Set(["d1"]) }) > 0);
});
test("local power symbol: the Value field carries drawLocalPowerIcon", () => {
  const lib = `(lib_symbols (symbol "P:LOC" (power local) (pin_names (offset 0) hide) (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "LOC_0_1" (polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "LOC_1_1" (pin power_in line (at 0 0 90) (length 0) hide (name "L" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
  const sym = (lid, id) => `(symbol (lib_id "${lid}") (at 20 20 0) (unit 1) (uuid "${id}") (property "Reference" "#PWR1" (at 20 25 0) (effects (font (size 1.27 1.27)) hide)) (property "Value" "LOCAL" (at 20 16 0) (effects (font (size 1.27 1.27)))))`;
  const doc = K.parseDoc(HEAD + lib + sym("P:LOC", "p1") + ")");
  const g = doc.items.get("p1").geom.filter((x) => x.field === "Value" && x.t !== "text");
  assert.strictEqual(g.filter((x) => x.t === "poly").length, 3, "three beziers"); assert.strictEqual(g.filter((x) => x.t === "circle" && x.fill).length, 1, "the dot");
  const val = doc.items.get("p1").geom.find((x) => x.t === "text" && x.field === "Value");
  assert(g.every((x) => (x.t === "circle" ? x.x : Math.max(...x.pts.map((p) => p[0]))) < val.x), "left of the text");
});
test("bus entries: a free end dangles (SCH_BUS_WIRE_ENTRY::UpdateDanglingState)", () => {
  const doc = K.parseDoc(HEAD + '(bus (pts (xy 0 0) (xy 20 0)) (uuid "b1")) (bus_entry (at 5 0) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "e1")) (bus_entry (at 10 0) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "e2")) (wire (pts (xy 12.54 2.54) (xy 12.54 10)) (uuid "w1")))');
  const d = _.danglingEnds(doc).filter((x) => x.what === "busEntry");
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].item.id, "e1"); assert.deepStrictEqual(d[0].p.map((v) => +v.toFixed(2)), [7.54, 2.54]);
});
test("pin alternate icons: drawn on the sheet by default, rebuilt off with setSchDisplay", () => {
  const lib = `(lib_symbols (symbol "L:M" (pin_names (offset 1.016)) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "M_1_1" (rectangle (start -5 5) (end 5 -5) (stroke (width 0.254) (type default)) (fill (type none)))
      (pin bidirectional line (at -7.62 0 0) (length 2.54) (name "PA0" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))) (alternate "TX" output line)))))`;
  const doc = K.parseDoc(HEAD + lib + '(symbol (lib_id "L:M") (at 20 20 0) (unit 1) (uuid "u1")))');
  const n = () => doc.items.get("u1").geom.filter((g) => g.layer === "Pin names" && g.t !== "text").length;
  assert(n() > 0); K.setSchDisplay({ pinAltIcons: false }, doc); assert.strictEqual(n(), 0); K.setSchDisplay({ pinAltIcons: true }, doc); assert(n() > 0);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
