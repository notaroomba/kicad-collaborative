// node server/static/tests/render.test.js — parser/geometry checks for kicad-canvas.js (no canvas needed).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

const SAMPLES = process.env.KICAD_SAMPLES || "/private/tmp/claude-502/-Users-roomba-Documents-GitHub-kicad-collaborative/dbbcf49c-094f-41fc-be3a-cd8a1023d083/scratchpad/shape-test/orig";
const schPath = path.join(SAMPLES, "StickHub.kicad_sch"), pcbPath = path.join(SAMPLES, "StickHub.kicad_pcb");
const haveSamples = fs.existsSync(schPath) && fs.existsSync(pcbPath);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= (tol || 1e-6), (msg || "") + ` expected ${b}, got ${a}`);
const count = (doc) => { const c = {}; for (const it of doc.items.values()) c[it.kind] = (c[it.kind] || 0) + 1; return c; };
const texts = (item, pred) => item.geom.filter((g) => g.t === "text" && (!pred || pred(g)));
const findSym = (doc, pred) => { for (const it of doc.items.values()) if (it.kind === "symbol" && pred(it)) return it; return null; };

/** Recording 2D-context stub with every method render() uses. */
function stubCtx(w, h) {
  const calls = {}; const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
  const ctx = { canvas: { width: w, height: h }, calls, font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", lineJoin: "", globalAlpha: 1 };
  for (const n of ["setTransform", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash"]) ctx[n] = () => rec(n);
  ctx.measureText = (t) => { rec("measureText"); return { width: t.length * 0.7 }; };
  return ctx;
}
function fitView(doc, W, H) {
  const b = doc.bbox; const ppm = Math.min(W / (b[2] - b[0]), H / (b[3] - b[1]));
  return { ppm, zoom: 1, panX: 0, panY: 0, x0: b[0], y0: b[1], dpr: 1 };
}

// ---------------------------------------------------------------- pure helpers
test("stroke-font width matches KiCad's plotted textLength", () => {
  near(K.textWidth("GND", 1.27, 0.1524), 4.0737, 0.002);   // from the KiCad SVG plot of the sample
  near(K.textWidth("1", 1.27, 0.1524), 1.4127, 0.002);
  near(K.textWidth("C17", 0.9906, 0.1524), 3.1365, 0.003);
  assert.strictEqual(K.textWidth("", 1.27, 0.15), 0);
});
test("markup: overbars become bar spans, braces are stripped", () => {
  assert.deepStrictEqual(K.parseMarkup("~{RST}"), { text: "RST", bars: [[0, 3]] });
  assert.deepStrictEqual(K.parseMarkup("A~{B}C"), { text: "ABC", bars: [[1, 2]] });
  assert.deepStrictEqual(K.parseMarkup("V_{CC}"), { text: "VCC", bars: null });
  assert.deepStrictEqual(K.parseMarkup("plain"), { text: "plain", bars: null });
});
test("symbol transforms: mirror y negates the X row, mirror x the Y row", () => {
  assert.deepStrictEqual(K.symbolTransform(0, ""), [1, 0, 0, -1]);
  assert.deepStrictEqual(K.symbolTransform(90, "x"), [0, -1, 1, 0]);
  assert.deepStrictEqual(K.symbolTransform(270, "x"), [0, 1, -1, 0]);
  assert.deepStrictEqual(K.symbolTransform(0, "y"), [-1, 0, 0, -1]);
  assert.deepStrictEqual(K.ORIENT[180], [-1, 0, 0, 1]);
});
test("three-point arcs keep their winding through a mirror", () => {
  const a = K.arcFrom3([0, 0], [1, 1], [2, 0]), b = K.arcFrom3([0, 0], [-1, 1], [-2, 0]);
  assert(a && b); assert.notStrictEqual(a.anticlockwise, b.anticlockwise);
  for (const [arc, mid] of [[a, [1, 1]], [b, [-1, 1]]]) {
    // the sweep from a0 to a1 in the stored direction must pass through the mid point
    let sweep = arc.a1 - arc.a0; if (!arc.anticlockwise && sweep < 0) sweep += 2 * Math.PI; if (arc.anticlockwise && sweep > 0) sweep -= 2 * Math.PI;
    const am = arc.a0 + sweep / 2; near(arc.x + arc.r * Math.cos(am), mid[0], 1e-6); near(arc.y + arc.r * Math.sin(am), mid[1], 1e-6);
  }
});
test("bezier flattening starts and ends on the control endpoints", () => {
  const p = K.bezierPts([[0, 0], [0, 10], [10, 10], [10, 0]], 8);
  assert.strictEqual(p.length, 9); assert.deepStrictEqual(p[0], [0, 0]); assert.deepStrictEqual(p[8], [10, 0]); assert(p[4][1] > 5);
});
test("zone border hatch lines stay inside the outline", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const segs = K.hatchLines(sq, -1, 1, 1);
  assert(segs.length > 10);
  for (const [x1, y1, x2, y2] of segs) for (const [x, y] of [[x1, y1], [x2, y2]]) assert(x >= -1e-6 && x <= 10 + 1e-6 && y >= -1e-6 && y <= 10 + 1e-6, "hatch end outside");
  const full = K.hatchLines(sq, 1, 2, -1); assert(full.length > 0 && full.length < segs.length);
});
test("board colours and draw order follow the KiCad theme", () => {
  assert.strictEqual(K.pcbColor("In1.Cu"), "#7FC87F"); assert.strictEqual(K.pcbColor("In30.Cu"), "#F2EDA1");
  assert.strictEqual(K.pcbColor("User.2"), "#5994DC"); assert.strictEqual(K.pcbColor("User.9"), "#E8B2A7"); assert.strictEqual(K.pcbColor("Cmts.User"), "#5994DC");
  assert.strictEqual(K.PCB_COLORS["F.Mask"], "rgba(216,100,255,0.4)"); assert.strictEqual(K.PCB_COLORS["B.Adhes"], "#000084");
  assert(K.pcbZ("B.Cu") < K.pcbZ("In1.Cu") && K.pcbZ("In1.Cu") < K.pcbZ("F.SilkS") && K.pcbZ("F.SilkS") < K.pcbZ("F.Cu"));
  assert(K.pcbZ("F.Cu") < K.pcbZ("holes") && K.pcbZ("holes") < K.pcbZ("User.1") && K.pcbZ("Edge.Cuts") < K.pcbZ("Dwgs.User"));
  assert.strictEqual(K.SCH.bus, "#000084"); assert.strictEqual(K.SCH.body, "#FFFFC2");
});

// ---------------------------------------------------------------- synthetic documents
test("global label outline and text follow SCH_GLOBALLABEL rules", () => {
  const doc = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (global_label "A" (shape input) (at 10 20 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g1")))');
  const it = doc.items.get("g1"); const poly = it.geom.find((g) => g.t === "poly"); const txt = texts(it)[0];
  const size = 1.27, margin = 0.375 * size, halfSize = size / 2 + margin, pen = size / 8;
  const bx = K.textWidth("A", size, pen) + 2 * margin + pen, by = halfSize + pen;
  // spin RIGHT rotates the template by 180 about the anchor: (px + xo, py) -> (-(px + xo), -py); input shape: xo = -halfSize, pts[0].x += halfSize
  near(poly.pts[0][0], 10, 1e-6); near(poly.pts[0][1], 20, 1e-6);
  near(poly.pts[1][0], 10 + halfSize, 1e-6); near(poly.pts[1][1], 20 + by, 1e-6);
  near(poly.pts[2][0], 10 + bx + halfSize, 1e-6);
  assert.strictEqual(poly.pts.length, 6); assert(poly.close);
  assert.strictEqual(txt.h, "left"); assert.strictEqual(txt.v, "middle"); assert.strictEqual(txt.rot, 0);
  near(txt.x, 10 + margin + size * 0.75, 1e-6); near(txt.y, 20 + size * 0.0715, 1e-6);
});
test("hierarchical label uses the template shape and text width offset", () => {
  const doc = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (hierarchical_label "H" (shape input) (at 0 0 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "h1")))');
  const it = doc.items.get("h1"); const poly = it.geom.find((g) => g.t === "poly"); const hs = 0.635;
  assert.deepStrictEqual(poly.pts.map((p) => p.map((v) => +(v / hs).toFixed(6))), [[0, 0], [1, 1], [2, 1], [2, -1], [1, -1], [0, 0]]);   // TemplateIN_HI
  const txt = texts(it)[0]; near(txt.x, 0.15 * 1.27 + 1.27, 1e-6); assert.strictEqual(txt.h, "left"); assert.strictEqual(txt.v, "middle");
});
test("sheet pins swap input/output shapes and read into the sheet", () => {
  const doc = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (sheet (at 50 50) (size 20 10) (stroke (width 0.1524)) (fill (color 0 0 0 0)) (uuid "s1") (property "Sheetname" "sub" (at 50 49 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "sub.kicad_sch" (at 50 61 0) (effects (font (size 1.27 1.27)) (justify left top))) (pin "P" input (at 70 55 0) (effects (font (size 1.27 1.27)) (justify right)) (uuid "p1"))))');
  const it = doc.items.get("s1");
  const file = texts(it, (g) => g.text.startsWith("File: "))[0]; assert(file, "sheet file field gets the File: prefix");
  const pin = texts(it, (g) => g.text === "P")[0]; assert.strictEqual(pin.h, "right"); near(pin.x, 70 - (0.15 * 1.27 + 1.27), 1e-6);
  const shape = it.geom.find((g) => g.t === "poly" && g.pts.length === 6); const hs = 0.635;
  assert.deepStrictEqual(shape.pts.map((p) => [+((p[0] - 70) / hs).toFixed(6), +((p[1] - 55) / hs).toFixed(6)]), [[-2, 0], [-1, 1], [0, 1], [0, -1], [-1, -1], [-2, 0]]);   // input pin draws the OUTPUT_HN template
  assert(!it.geom.some((g) => g.t === "rect" && g.fill), "transparent sheet background is not filled");
});
test("directive label, no-connect, junction and bus entry defaults", () => {
  const doc = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (netclass_flag "" (length 2.54) (shape round) (at 5 5 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "n1") (property "Netclass" "Power" (at 6 4 0) (effects (font (size 1.27 1.27)) (justify left bottom)))) (no_connect (at 1 1) (uuid "nc")) (junction (at 2 2) (diameter 0) (color 0 0 0 0) (uuid "j")) (bus_entry (at 3 3) (size 2.54 -2.54) (stroke (width 0) (type default)) (uuid "be")))');
  const flag = doc.items.get("n1"); assert(flag.geom.some((g) => g.t === "circle" && !g.fill)); assert(texts(flag, (g) => g.text === "Power")[0]);
  const nc = doc.items.get("nc"); near(nc.geom[0].x2 - nc.geom[0].x1, 1.2192, 1e-6); assert.strictEqual(nc.geom[0].color, "#000084");
  near(doc.items.get("j").geom[0].r, 0.4572, 1e-6);
  const be = doc.items.get("be").geom[0]; assert.strictEqual(be.color, "#009600"); near(be.x2, 5.54, 1e-6); near(be.y2, 0.46, 1e-6);
});
test("symbol bodies: fills, De Morgan body style, extends, DNP cross, sim-exclusion", () => {
  const lib = '(lib_symbols (symbol "L:Base" (pin_names (offset 0)) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "Base_0_1" (rectangle (start -2 2) (end 2 -2) (stroke (width 0)) (fill (type background))) (arc (start -1 0) (mid 0 1) (end 1 0) (stroke (width 0)) (fill (type none))) (bezier (pts (xy -2 -3) (xy -1 -4) (xy 1 -4) (xy 2 -3)) (stroke (width 0)) (fill (type none)))) (symbol "Base_0_2" (circle (center 0 0) (radius 2) (stroke (width 0)) (fill (type outline)))) (symbol "Base_1_1" (pin input inverted (at -5 0 0) (length 3) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin output clock (at 5 0 180) (length 3) (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))) (symbol "L:Derived" (extends "Base") (property "Value" "D" (at 0 0 0) (effects (font (size 1.27 1.27))))))';
  const sch = (body) => K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") ' + lib + " " + body + ")");
  let doc = sch('(symbol (lib_id "L:Base") (at 100 100 0) (unit 1) (body_style 1) (exclude_from_sim no) (dnp no) (uuid "a") (property "Reference" "U1" (at 100 95 0) (effects (font (size 1.27 1.27)))))');
  let it = doc.items.get("a");
  const bg = it.geom.find((g) => g.t === "poly" && g.fill === "#FFFFC2"); assert(bg && bg.z < 0, "background fill drawn below the body");
  assert(it.geom.some((g) => g.t === "arc")); assert(it.geom.some((g) => g.t === "poly" && g.pts.length === 17), "bezier flattened");
  const inv = it.geom.filter((g) => g.t === "circle" && g.layer === "Pins"); assert.strictEqual(inv.length, 1); near(inv[0].r, 0.635, 1e-6); near(inv[0].x, 100 - 2 - 0.635, 1e-6);
  assert(it.geom.some((g) => g.t === "poly" && g.layer === "Pins" && g.pts.length === 3), "clock tick");
  const name = texts(it, (g) => g.text === "IN")[0]; assert.strictEqual(name.h, "center"); near(name.y, 100 - (0.635 + 0.2032 + 0.1524), 1e-6);   // names outside → above the pin
  const numb = texts(it, (g) => g.text === "1")[0]; near(numb.x, 100 - 5 + 1.5, 1e-6); near(numb.y, 100 + 0.2032 + 0.635 + 0.1524, 1e-6);   // number below, centred on the pin
  doc = sch('(symbol (lib_id "L:Base") (at 100 100 0) (unit 1) (body_style 2) (uuid "b"))');
  it = doc.items.get("b"); assert(it.geom.some((g) => g.t === "circle" && g.fill === "#840000") && !it.geom.some((g) => g.t === "arc"), "body style 2 draws the alternate body");
  doc = sch('(symbol (lib_id "L:Derived") (at 100 100 0) (unit 1) (body_style 1) (dnp yes) (exclude_from_sim yes) (uuid "c"))');
  it = doc.items.get("c"); assert(it.geom.some((g) => g.t === "arc"), "derived symbol inherits the parent drawing");
  assert.strictEqual(it.geom.filter((g) => g.color === "rgba(220,9,13,0.85)").length, 2, "DNP cross");
  assert(it.geom.some((g) => g.alpha === 0.5), "excluded-from-sim body is dimmed"); assert(it.geom.some((g) => g.color === "rgba(194,194,194,0.95)"), "exclusion marker");
  assert(!it.geom.find((g) => g.t === "arc").color.startsWith("#840000"), "DNP body colour is desaturated");
});
test("board dimension, target, chamfered and trapezoid pads, blind via, keepout", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user) (49 "Dwgs.User" user)) ' +
    '(dimension (type aligned) (layer "Dwgs.User") (uuid "d1") (pts (xy 0 0) (xy 10 0)) (height 5) (gr_text "10 mm" (at 5 5 0) (layer "Dwgs.User") (effects (font (size 1 1) (thickness 0.15)))) (format (units 3) (units_format 1) (precision 4)) (style (thickness 0.15) (arrow_length 1.27) (text_position_mode 1) (extension_height 0.5) (extension_offset 0) (keep_text_aligned yes))) ' +
    '(target plus (at 20 20) (size 5) (width 0.15) (layer "Edge.Cuts") (uuid "t1")) ' +
    '(via blind (at 30 30) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net 0) (uuid "v1")) ' +
    '(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "z1") (hatch full 0.5) (keepout (tracks not_allowed)) (polygon (pts (xy 40 40) (xy 50 40) (xy 50 50) (xy 40 50)))) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 60 60 90) (property "Reference" "R9" (at 0 -2 90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0 90) (size 2 1) (layers "F.Cu" "F.Mask") (chamfer_ratio 0.5) (chamfer top_left bottom_right) (uuid "p1")) (pad "2" smd trapezoid (at 3 0 90) (size 2 1) (rect_delta 0 0.5) (layers "F.Cu") (uuid "p2")) (pad "3" thru_hole circle (at 6 0 90) (size 1.5 1.5) (drill oval 0.6 1 (offset 0.1 0)) (layers "*.Cu" "*.Mask") (uuid "p3"))))');
  assert.deepStrictEqual(doc.copper, ["F.Cu", "In1.Cu", "B.Cu"]);
  const dim = doc.items.get("d1"); const lines = dim.geom.filter((g) => g.t === "line"); assert(lines.length >= 7, "extension lines, crossbar pieces and 4 arrow barbs");
  assert(texts(dim, (g) => g.text === "10 mm")[0]);
  // height > 0 puts the crossbar at y = +5 (extension = (-d.y, d.x)); the inline text knocks its middle out
  const cross = lines.filter((g) => Math.abs(g.y1 - 5) < 1e-6 && Math.abs(g.y2 - 5) < 1e-6 && Math.abs(g.x2 - g.x1) > 1); assert.strictEqual(cross.length, 2, "crossbar is knocked out around the text");
  const gap = cross.map((g) => [Math.min(g.x1, g.x2), Math.max(g.x1, g.x2)]).sort((a, b) => a[0] - b[0]); near(gap[0][0], 0, 1e-6); near(gap[1][1], 10, 1e-6); assert(gap[0][1] < 5 && gap[1][0] > 5);
  const tg = doc.items.get("t1"); assert.strictEqual(tg.geom.filter((g) => g.t === "line").length, 2); assert(tg.geom.some((g) => g.t === "circle" && Math.abs(g.r - 5 / 3) < 1e-9));
  const via = doc.items.get("v1"); assert.deepStrictEqual(via.geom.filter((g) => g.t === "circle").map((g) => g.layer), ["F.Cu", "In1.Cu"]); assert.strictEqual(via.geom.filter((g) => g.pie).length, 2);
  const z = doc.items.get("z1"); assert(!z.geom.some((g) => g.fill), "rule areas are not filled"); assert(z.geom.filter((g) => g.t === "line").length > 4, "full hatch");
  const fp = doc.items.get("fp1");
  const cham = fp.geom.find((g) => g.t === "poly" && g.layer === "F.Cu" && g.pts.length === 6); assert(cham, "two chamfered corners give a hexagon");
  const trap = fp.geom.find((g) => g.t === "poly" && g.layer === "F.Cu" && g.pts.length === 4); assert(trap);
  const R = (x, y) => [60 + x * Math.cos(Math.PI / 2) + y * Math.sin(Math.PI / 2), 60 - x * Math.sin(Math.PI / 2) + y * Math.cos(Math.PI / 2)];
  const [cx, cy] = R(3, 0); near(trap.pts.reduce((a, p) => a + p[0], 0) / 4, cx, 1e-6); near(trap.pts.reduce((a, p) => a + p[1], 0) / 4, cy, 1e-6);
  const widths = [Math.hypot(trap.pts[1][0] - trap.pts[0][0], trap.pts[1][1] - trap.pts[0][1]), Math.hypot(trap.pts[3][0] - trap.pts[2][0], trap.pts[3][1] - trap.pts[2][1])]; near(Math.abs(widths[0] - widths[1]), 1, 1e-6, "rect_delta skews the two parallel sides by the delta");
  const thr = fp.geom.filter((g) => g.t === "pad" && g.layer !== "holes" && /\.Cu$/.test(g.layer)).map((g) => g.layer); assert.deepStrictEqual(thr.sort(), ["B.Cu", "F.Cu", "In1.Cu"]);
  const hole = fp.geom.find((g) => g.layer === "holes" && g.fill === "#001023"); assert(hole && hole.shape === "oval"); const [hx, hy] = R(6.1, 0); near(hole.x, hx, 1e-6); near(hole.y, hy, 1e-6);
  const ref = texts(fp, (g) => g.text === "R9")[0]; assert.strictEqual(ref.rot, 90); assert.strictEqual(ref.mirror, false);
});
test("board text: keep-upright only for locked footprint text, mirror only from the file", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (36 "B.SilkS" user) (37 "F.SilkS" user)) (gr_text "STATUS" (at 1 1 270) (layer "F.SilkS") (uuid "g1") (effects (font (size 0.8 0.8) (thickness 0.15)))) (gr_text "B" (at 1 1 0) (layer "B.SilkS") (uuid "g2") (effects (font (size 0.8 0.8)))) (footprint "T:Y" (layer "B.Cu") (uuid "f1") (at 5 5 180) (property "Reference" "C1" (at 0 0 180) (layer "B.SilkS") (effects (font (size 1 1)) (justify mirror))) (fp_text user "${REFERENCE}" (at 0 1 225 unlocked) (layer "B.Fab") (effects (font (size 1 1)) (justify mirror)))))');
  const g1 = texts(doc.items.get("g1"))[0]; assert.strictEqual(g1.rot, 270, "board text keeps its angle");
  assert.strictEqual(texts(doc.items.get("g2"))[0].mirror, false, "no implicit mirroring on back layers");
  const fp = doc.items.get("f1"); const ref = texts(fp, (g) => g.text === "C1")[0]; assert.strictEqual(ref.rot, 0, "kept upright: 180 → 0"); assert.strictEqual(ref.mirror, true);
  const user = texts(fp, (g) => g.text === "C1" && g !== ref)[0]; assert(user, "${REFERENCE} expands"); assert.strictEqual(user.rot, 225, "unlocked text keeps 225°");
});
test("render works with a stub context on synthetic documents", () => {
  const doc = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (label "~{RST}" (at 10 10 90) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1")) (text "multi\\nline" (at 20 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t1")))');
  const lbl = texts(doc.items.get("l1"))[0]; assert.strictEqual(lbl.text, "RST"); assert.deepStrictEqual(lbl.bars, [[0, 3]]); assert.strictEqual(lbl.rot, 90); near(lbl.x, 10 - (0.15 * 1.27 + 1.27 / 8), 1e-6);
  assert.strictEqual(texts(doc.items.get("t1")).length, 2);
  const ctx = stubCtx(800, 600); K.render(doc, ctx, fitView(doc, 800, 600), { grid: 1.27, selected: new Set(["l1"]) });
  assert(ctx.calls.fillText >= 3 && ctx.calls.stroke >= 1);
});

// ---------------------------------------------------------------- the sample project
if (!haveSamples) {
  console.log("sample documents not found under " + SAMPLES + " — set KICAD_SAMPLES to run the project checks");
} else {
  const sch = K.parseDoc(fs.readFileSync(schPath, "utf8"), "kicad_sch");
  const pcb = K.parseDoc(fs.readFileSync(pcbPath, "utf8"), "kicad_pcb");
  test("sample item counts", () => {
    assert.deepStrictEqual(count(sch), { text: 2, junction: 141, no_connect: 2, wire: 475, polyline: 4, label: 26, symbol: 140 });
    assert.strictEqual(sch.items.size, 790); assert.deepStrictEqual(sch.page, [420, 297]); assert.strictEqual(sch.lib.size, 22);
    assert.deepStrictEqual(count(pcb), { footprint: 94, gr_poly: 12, gr_line: 15, gr_arc: 8, gr_text: 9, segment: 1118, via: 87, arc: 180, zone: 5, group: 1 });
    assert.deepStrictEqual(pcb.copper, ["F.Cu", "B.Cu"]);
    near(pcb.bbox[0], 140.5, 0.05); near(pcb.bbox[3], 120.525, 0.05);
  });
  test("rotated + mirrored power symbol body matches KiCad's plot", () => {
    const gnd = sch.items.get("090d21fc-658e-4e52-ac1d-2a96842b3b13");   // GND at (347.98, 72.39) rot 90 mirror x
    const body = gnd.geom.find((g) => g.t === "poly" && g.layer === "Symbols");
    assert.deepStrictEqual(body.pts.map((p) => p.map((v) => +v.toFixed(4))), [[347.98, 72.39], [349.25, 72.39], [349.25, 73.66], [350.52, 72.39], [349.25, 71.12], [349.25, 72.39]]);
    const val = texts(gnd, (g) => g.text === "GND")[0]; assert.strictEqual(val.rot, 90); near(val.x, 351.79, 1e-6); near(val.y, 72.39, 1e-6);
    assert.strictEqual(texts(gnd).length, 1, "hidden power pin draws no name/number");
  });
  test("pin connection points of a rotated + mirrored symbol", () => {
    const d13 = sch.items.get("0b8dbfc1-102d-4031-a2eb-d5b8b6915854");   // D_TVS at (326.39, 175.26) rot 270 mirror x; pins at lib (∓3.81, 0)
    const pts = K.pinPoints(sch, d13).map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), p.number]);
    // T = ORIENT[270] with the Y row negated = [0, 1, -1, 0]: (x, y) -> (y, -x)
    assert.deepStrictEqual(pts, [[326.39, 179.07, "1"], [326.39, 171.45, "2"]]);
    assert(d13.geom.some((g) => g.t === "poly" && g.fill === "#840000"), "outline-filled triangles");
  });
  test("field justification under symbol rotation and mirroring", () => {
    const r11 = sch.items.get("01bc4446-2f2f-4610-83f0-090dc0167739");   // RSMALL rot 270: fields stored at 90°
    const ref = texts(r11, (g) => g.text === "R11")[0], val = texts(r11, (g) => g.text === "470")[0];
    assert.strictEqual(ref.rot, 0); assert.strictEqual(ref.h, "right"); near(ref.x, 262.382, 1e-6); near(ref.y, 205.486, 1e-6);
    assert.strictEqual(val.rot, 0); assert.strictEqual(val.h, "left");
    const c17 = sch.items.get("13f55e82-3c7c-40b8-a54b-9ac60e170cc1");   // Csmall mirror y: left-justified fields flip to the left
    const c = texts(c17, (g) => g.text === "C17")[0]; assert.strictEqual(c.h, "right"); assert.strictEqual(c.rot, 0); near(c.x, 103.632, 1e-6);
    assert(!texts(c17, (g) => g.text.startsWith("footprints:"))[0], "hidden Footprint field is not drawn");
    assert(!texts(c17, (g) => g.text === "C" && g.layer === "Fields")[0] === false, "user fields are drawn");
  });
  test("pin name inside the body and number above the pin midpoint", () => {
    const u2 = findSym(sch, (it) => it.lib === "RobotProtos:Dialog_SLG5NT1487V");   // no pin_names node → offset 0.508
    const one = texts(u2, (g) => g.text === "1" && g.layer === "Pin numbers")[0]; near(one.x, 38.1, 1e-6); near(one.y, 193.04 - (0.2032 + 0.635 + 0.1524), 1e-6);
    const vdd = texts(u2, (g) => g.text === "VDD")[0]; assert.strictEqual(vdd.h, "left"); near(vdd.x, 36.83 + 2.54 + 0.508, 1e-6); near(vdd.y, 193.04, 1e-6);
    const s = texts(u2, (g) => g.text === "S")[0]; assert.strictEqual(s.h, "right"); near(s.x, 52.07 - 2.54 - 0.508, 1e-6);
  });
  test("local label anchor: spin style from the angle, lifted by offset + pen", () => {
    const xi = [...sch.items.values()].find((it) => it.kind === "label" && it.node[1] === "XI"); const t = texts(xi)[0];
    assert.strictEqual(t.rot, 0); assert.strictEqual(t.h, "right"); assert.strictEqual(t.v, "bottom"); near(t.x, 204.47, 1e-6); near(t.y, 132.08 - (0.15 * 1.27 + 1.27 / 8), 1e-6);
    const led = [...sch.items.values()].find((it) => it.kind === "label" && it.node[1] === "LED1"); assert.strictEqual(texts(led)[0].h, "left");
  });
  test("footprint pad centre after the board transform; back-side text is mirrored", () => {
    const c36 = pcb.items.get("01343d3d-4853-4738-a3f9-e885006c7455");   // B.Cu, translate (151.392893, 88.342893) rotate 45
    const padNode = K.kids(c36.node, "pad")[0]; const [px, py] = K.atOf(padNode);
    const r = Math.PI / 4, ex = 151.392893 + px * Math.cos(r) + py * Math.sin(r), ey = 88.342893 - px * Math.sin(r) + py * Math.cos(r);
    const pad = c36.geom.find((g) => g.t === "pad" && g.layer === "B.Cu"); near(pad.x, ex, 1e-6); near(pad.y, ey, 1e-6); assert.strictEqual(pad.rot, K.atOf(padNode)[2]);
    assert.deepStrictEqual(c36.geom.filter((g) => g.t === "pad" && Math.abs(g.x - ex) < 1e-6).map((g) => g.layer).sort(), ["B.Cu", "B.Mask", "B.Paste"]);
    const val = texts(c36, (g) => g.text === "22uF 10V")[0]; assert.strictEqual(val.mirror, true); assert.strictEqual(val.rot, 45); assert.strictEqual(val.layer, "B.Fab");
    assert(!texts(c36, (g) => g.text === "C36" && g.layer === "B.SilkS")[0], "hidden reference not drawn");
  });
  test("through vias, zone fills with edge hatch, custom pads, board outline", () => {
    const via = pcb.items.get("09d8aa89-5091-4c37-bafb-67bd11198631");
    assert.deepStrictEqual(via.geom.map((g) => g.layer), ["F.Cu", "B.Cu", "holes"]); assert.strictEqual(via.geom[2].color, "#E3B72E"); near(via.geom[2].r, 0.15, 1e-9);
    const zone = pcb.items.get("04ee1ef8-4bc6-4962-aa1e-b5b891802d7b");
    assert(zone.geom.some((g) => g.t === "poly" && g.fill === "#C83434" && g.z < K.pcbZ("F.Cu")), "fill below tracks");
    assert(zone.geom.filter((g) => g.t === "line").length > 8, "edge hatch ticks");
    const jp = [...pcb.items.values()].find((it) => it.kind === "footprint" && it.lib === "footprints:JP-2_1.5x1.5");
    assert(jp.geom.filter((g) => g.t === "poly" && g.fill === "#4D7FC4").length >= 3, "custom pad primitives");
    assert([...pcb.items.values()].some((it) => it.edge));
  });
  test("layer lists", () => {
    const keys = K.layerList(pcb).map((l) => l.key); assert(keys.includes("F.Cu") && keys.includes("B.Fab") && keys.includes("Edge.Cuts") && !keys.includes("holes"));
    assert.strictEqual(keys[0], "Dwgs.User", "sorted top layer first");
    const sk = K.layerList(sch).map((l) => l.key); assert(sk.includes("Pin names") && sk.includes("Labels"));
  });
  test("render both samples with a stub context (all layers, hidden layers, selection)", () => {
    for (const doc of [sch, pcb]) {
      const ctx = stubCtx(1600, 1200);
      const t0 = Date.now(); K.render(doc, ctx, fitView(doc, 1600, 1200), { grid: 1.27, selected: new Set([doc.items.keys().next().value]) }); const ms = Date.now() - t0;
      assert(ctx.calls.stroke > 100 && ctx.calls.fill > 10 && ctx.calls.fillText > 10, "drew things: " + JSON.stringify(ctx.calls));
      assert(ms < 500, "render loop overhead " + ms + " ms");
      const hidden = new Set(K.layerList(doc).map((l) => l.key));
      const ctx2 = stubCtx(1600, 1200); K.render(doc, ctx2, fitView(doc, 1600, 1200), { hidden });
      assert(!ctx2.calls.fillText, "hiding every layer draws no text");
      // text is skipped below 3 device px
      const ctx3 = stubCtx(200, 150); K.render(doc, ctx3, fitView(doc, 200, 150), {}); assert((ctx3.calls.fillText || 0) < (ctx.calls.fillText || 0));
    }
  });
  test("edits rebuild geometry: moveItem and applyChange", () => {
    const it = sch.items.get("090d21fc-658e-4e52-ac1d-2a96842b3b13"); const before = it.geom[0];
    const ch = K.moveItem(sch, it, 300, 70, 10000); assert.strictEqual(ch.kind, "MODIFIED"); assert.notStrictEqual(it.geom[0], before); near(it.geom.find((g) => g.t === "poly").pts[0][0], 300, 1e-6);
    K.moveItem(sch, it, 347.98, 72.39, 10000);
    assert(K.applyChange(sch, { id: it.id, kind: "MODIFIED", properties: [{ name: "Position X", after: { v: 3479800 } }] }, 10000));
  });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
