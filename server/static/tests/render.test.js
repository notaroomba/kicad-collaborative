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
  for (const n of ["setTransform", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash", "drawImage"]) ctx[n] = () => rec(n);
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

// ---------------------------------------------------------------- tables, images, sheet pins, highlight, selection
/** Recording context that also logs the stroke/fill/alpha/dash in force at each drawing call. */
function recCtx(w, h) {
  const ctx = stubCtx(w, h); const ops = []; let stroke = "", fill = "", alpha = 1, dash = [];
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) { const rec = ctx[n]; ctx[n] = (...args) => { rec(); ops.push({ op: n, stroke, fill, alpha, dash: dash.slice(), args }); }; }
  ctx.setLineDash = (d) => { ctx.calls.setLineDash = (ctx.calls.setLineDash || 0) + 1; dash = d; };
  ctx.ops = ops; return ctx;
}
const SCH_HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const PCB_HEAD = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (41 "Cmts.User" user) (49 "Dwgs.User" user)) ';
const lines = (it) => it.geom.filter((g) => g.t === "line");
const seg = (g) => [g.x1, g.y1, g.x2, g.y2].map((v) => +v.toFixed(6));
const schCell = (text, x, y, w, h, extra, id) => `(table_cell "${text}" (at ${x} ${y} 0) (size ${w} ${h}) (margins 0.5 0.5 0.5 0.5) ${extra} (uuid "${id}"))`;
const schTable = (border, seps, cells) => SCH_HEAD + `(table (column_count 2) ${border} ${seps} (column_widths 20 10) (row_heights 5 5) (uuid "tb1") (cells ${cells}))` + ")";

test("schematic table: external border + header separator, cell text per justification, fills", () => {
  const doc = K.parseDoc(schTable('(border (external yes) (header yes) (stroke (width 0.2) (type default)))', '(separators (rows yes) (cols no) (stroke (width 0.05) (type dash)))',
    schCell("A", 10, 10, 20, 5, '(span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top))', "c1") +
    schCell("B", 30, 10, 10, 5, '(span 1 1) (fill (type color) (color 255 0 0 1)) (effects (font (size 1.27 1.27)) (justify right bottom))', "c2") +
    schCell("C", 10, 15, 20, 5, '(span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)))', "c3") +
    schCell("D", 30, 15, 10, 5, '(span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)))', "c4")));
  const it = doc.items.get("tb1"); assert(it && it.kind === "table");
  // SCH_TABLE::DrawBorders: header column separator (right edge of cell 0,0), header row separator under both first-row cells, 4 external edges
  const ls = lines(it).map(seg).sort();
  assert.deepStrictEqual(ls, [[10, 10, 40, 10], [10, 20, 10, 10], [30, 10, 30, 15], [30, 15, 10, 15], [40, 10, 40, 20], [40, 15, 30, 15], [40, 20, 10, 20]].sort());
  for (const g of lines(it)) { near(g.w, 0.2, 1e-9); assert.strictEqual(g.color, K.SCH.notes); assert.strictEqual(g.layer, "Notes"); assert(!g.dash); }
  // SCH_TEXTBOX::GetDrawPos: the anchor is the box edge matching the justification, inset by the margin; no (justify …) = centred
  const a = texts(it, (g) => g.text === "A")[0]; assert.strictEqual(a.h, "left"); assert.strictEqual(a.v, "top"); near(a.x, 10.5, 1e-9); near(a.y, 10.5, 1e-9);
  const b = texts(it, (g) => g.text === "B")[0]; assert.strictEqual(b.h, "right"); assert.strictEqual(b.v, "bottom"); near(b.x, 39.5, 1e-9); near(b.y, 14.5, 1e-9);
  const d = texts(it, (g) => g.text === "D")[0]; assert.strictEqual(d.h, "center"); assert.strictEqual(d.v, "middle"); near(d.x, 35, 1e-9); near(d.y, 17.5, 1e-9);
  const fill = it.geom.find((g) => g.t === "rect" && g.fill); assert(fill, "colour-filled cell"); assert.strictEqual(fill.fill, "#ff0000"); assert.deepStrictEqual([fill.x, fill.y, fill.w, fill.h], [30, 10, 10, 5]); assert(fill.z < 0, "cell fills go to the notes background");
  // movable by the first cell's position, hit-testable by bbox, moving shifts every cell
  const mv = K.movableItems(doc).find((m) => m.id === "tb1"); assert(mv); assert.strictEqual(mv.x, 10); assert.strictEqual(mv.y, 10); assert.strictEqual(mv.kind, "table");
  assert.strictEqual(K.hitTest(doc, 20, 12, 0), "tb1"); assert.strictEqual(K.hitTest(doc, 45, 12, 0), null);
  near(it.bbox[0], 10, 0.11); near(it.bbox[1], 10, 0.11); near(it.bbox[2], 40, 0.11); near(it.bbox[3], 20, 0.11);   // ± half the border width
  const ch = K.moveItem(doc, it, 20, 20, 10000); assert.strictEqual(ch.kind, "MODIFIED"); assert.strictEqual(ch.typeName, "SCH_TABLE"); assert(ch.sexpr.includes("(table") && ch.sexpr.includes("(kicad_sch"));
  assert.strictEqual(it.x, 20); assert.strictEqual(it.y, 20); assert(!K.kid(it.node, "at"), "no (at) is invented on the table node");
  assert.deepStrictEqual(K.atOf(K.kids(K.kid(it.node, "cells"), "table_cell")[3]).slice(0, 2), [40, 25]);
  assert.deepStrictEqual(lines(it).map(seg).sort()[0], [20, 20, 50, 20]);
  assert(K.applyChange(doc, { id: "tb1", kind: "MODIFIED", properties: [{ name: "Position X", after: { v: 300000 } }] }, 10000)); assert.strictEqual(it.x, 30);
  assert.deepStrictEqual(K.atOf(K.kids(K.kid(it.node, "cells"), "table_cell")[0]).slice(0, 2), [30, 20]);
  assert.strictEqual(K.typeNameOf(it), "SCH_TABLE");
});
test("schematic table: row/column separators, spans, and the border flags", () => {
  // every separator on, no header stroke: 1 column line per row + 1 row line per column + external
  let doc = K.parseDoc(schTable('(border (external yes) (header no) (stroke (width 0.2) (type default)))', '(separators (rows yes) (cols yes) (stroke (width 0.05) (type dash)))',
    schCell("A", 10, 10, 20, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c1") + schCell("B", 30, 10, 10, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c2") +
    schCell("C", 10, 15, 20, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c3") + schCell("D", 30, 15, 10, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c4")));
  let it = doc.items.get("tb1"); let ls = lines(it);
  assert.strictEqual(ls.length, 8); assert.strictEqual(ls.filter((g) => g.dash && Math.abs(g.w - 0.05) < 1e-9).length, 4, "separators use the separators stroke");
  assert.strictEqual(ls.filter((g) => !g.dash && Math.abs(g.w - 0.2) < 1e-9).length, 4, "external border uses the border stroke");
  // a cell spanning both columns: no column line beside it, the covered cell (span 0 0) draws nothing
  doc = K.parseDoc(schTable('(border (external yes) (header yes) (stroke (width 0.2) (type default)))', '(separators (rows yes) (cols yes) (stroke (width 0.05) (type default)))',
    schCell("A", 10, 10, 30, 5, '(span 2 1) (effects (font (size 1.27 1.27)))', "c1") + schCell("B", 30, 10, 10, 5, '(span 0 0) (effects (font (size 1.27 1.27)))', "c2") +
    schCell("C", 10, 15, 20, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c3") + schCell("D", 30, 15, 10, 5, '(span 1 1) (effects (font (size 1.27 1.27)))', "c4")));
  it = doc.items.get("tb1"); ls = lines(it).map(seg).sort();
  assert.deepStrictEqual(ls, [[10, 10, 40, 10], [10, 20, 10, 10], [30, 15, 30, 20], [40, 10, 40, 20], [40, 15, 10, 15], [40, 20, 10, 20]].sort());
  assert(!texts(it, (g) => g.text === "B")[0], "spanned-over cell is not drawn"); assert(texts(it, (g) => g.text === "A")[0]);
  // nothing stroked at all
  doc = K.parseDoc(schTable('(border (external no) (header no))', '(separators (rows no) (cols no))', schCell("A", 10, 10, 20, 5, '(effects (font (size 1.27 1.27)))', "c1") + schCell("B", 30, 10, 10, 5, '(effects (font (size 1.27 1.27)))', "c2")));
  it = doc.items.get("tb1"); assert.strictEqual(lines(it).length, 0); assert(it.movable && it.bbox);
  const ctx = stubCtx(800, 600); K.render(doc, ctx, fitView(doc, 800, 600), {}); assert(ctx.calls.fillText >= 2);
  // corners in sequence for a rotated cell (EDA_SHAPE::GetCornersInSequence)
  assert.deepStrictEqual(K.cornersInSequence({ x0: 0, y0: 0, x1: 10, y1: 4 }, 90), [[0, 4], [0, 0], [10, 0], [10, 4]]);
  assert.deepStrictEqual(K.cornersInSequence({ x0: 0, y0: 0, x1: 10, y1: 4 }, 180), [[10, 4], [0, 4], [0, 0], [10, 0]]);
});
test("board table: layer colour and z, dashed border stroke, PCB_TEXTBOX::GetDrawPos anchors", () => {
  const cell = (t, x0, y0, x1, y1, extra, id) => `(table_cell "${t}" (start ${x0} ${y0}) (end ${x1} ${y1}) (margins 0.5 0.5 0.5 0.5) (span 1 1) (layer "Cmts.User") (uuid "${id}") (effects (font (size 1 1) (thickness 0.15)) ${extra}))`;
  const doc = K.parseDoc(PCB_HEAD + '(table (column_count 2) (uuid "pt1") (layer "Cmts.User") (border (external yes) (header no) (stroke (width 0.1) (type dash))) (separators (rows yes) (cols yes) (stroke (width 0.05) (type default))) (column_widths 10 10) (row_heights 4 4) (cells ' +
    cell("x", 0, 0, 10, 4, "(justify right bottom)", "k1") + cell("y", 10, 0, 20, 4, "", "k2") + cell("z", 0, 4, 10, 8, "(justify left top)", "k3") + cell("w", 10, 4, 20, 8, "", "k4") + ")))");
  const it = doc.items.get("pt1"); assert(it && it.kind === "table"); assert.strictEqual(it.layer, "Cmts.User");
  const ls = lines(it); assert.strictEqual(ls.length, 8);
  for (const g of ls) { assert.strictEqual(g.color, "#5994DC"); assert.strictEqual(g.layer, "Cmts.User"); assert.strictEqual(g.z, K.pcbZ("Cmts.User")); }
  assert.deepStrictEqual(ls.filter((g) => g.dash).map(seg).sort(), [[0, 0, 20, 0], [0, 8, 0, 0], [20, 0, 20, 8], [20, 8, 0, 8]].sort(), "external border: dashed 0.1");
  assert.deepStrictEqual(ls.filter((g) => !g.dash).map(seg).sort(), [[10, 0, 10, 4], [10, 4, 0, 4], [10, 4, 10, 8], [20, 4, 10, 4]].sort(), "separators: solid 0.05");
  for (const g of ls) near(g.w, g.dash ? 0.1 : 0.05, 1e-9);
  const x = texts(it, (g) => g.text === "x")[0]; assert.strictEqual(x.h, "right"); assert.strictEqual(x.v, "bottom"); near(x.x, 9.5, 1e-9); near(x.y, 3.5, 1e-9); assert.strictEqual(x.color, "#5994DC"); assert.strictEqual(x.layer, "Cmts.User");
  const y = texts(it, (g) => g.text === "y")[0]; assert.strictEqual(y.h, "center"); assert.strictEqual(y.v, "middle"); near(y.x, 15, 1e-9); near(y.y, 2, 1e-9);
  const z = texts(it, (g) => g.text === "z")[0]; assert.strictEqual(z.h, "left"); assert.strictEqual(z.v, "top"); near(z.x, 0.5, 1e-9); near(z.y, 4.5, 1e-9);
  assert.strictEqual(K.hitTest(doc, 5, 2, 0), "pt1"); assert.strictEqual(K.movableItems(doc).find((m) => m.id === "pt1").layer, "Cmts.User"); assert.strictEqual(K.typeNameOf(it), "PCB_TABLE");
  const ch = K.moveItem(doc, it, 100, 100, 1e6); assert.strictEqual(ch.typeName, "PCB_TABLE"); assert(ch.sexpr.startsWith("(table")); assert.deepStrictEqual(seg(lines(it).find((g) => g.dash && g.y1 === 100 && g.y2 === 100)), [100, 100, 120, 100]);
  const hid = new Set(["Cmts.User"]); const ctx = stubCtx(800, 600); K.render(doc, ctx, fitView(doc, 800, 600), { hidden: hid }); assert(!ctx.calls.fillText, "hidden layer hides the table");
  assert(K.layerList(doc).some((l) => l.key === "Cmts.User"));
});

// tiny PNG / JPEG builders: enough header for BITMAP_BASE's size/PPI rules
function pngB64(w, h, ppm) {
  const chunk = (type, data) => Buffer.concat([Buffer.from([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255]), Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr)];
  if (ppm) { const p = Buffer.alloc(9); p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1; parts.push(chunk("pHYs", p)); }
  parts.push(chunk("IDAT", Buffer.from([0, 0, 0])), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts).toString("base64");
}
const JPEG_B64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x96, 0x00, 0x96, 0x00, 0x00,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x0A, 0x00, 0x14, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]).toString("base64");
const dataAtoms = (b64) => "(data " + b64.match(/.{1,76}/g).map((c) => '"' + c + '"').join(" ") + ")";
class FakeImage { constructor() { FakeImage.made.push(this); this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; } set src(v) { this._src = v; } get src() { return this._src; } }
FakeImage.made = [];

test("image headers: PNG IHDR/pHYs and JPEG SOF/JFIF give pixel size and PPI (300 by default)", () => {
  const png = K.imageInfo(K.base64Bytes(pngB64(4, 2, 3780))); assert.deepStrictEqual(png, { mime: "image/png", w: 4, h: 2, ppi: 96 });
  assert.deepStrictEqual(K.imageInfo(K.base64Bytes(pngB64(7, 3, 0))), { mime: "image/png", w: 7, h: 3, ppi: 300 });
  assert.deepStrictEqual(K.imageInfo(K.base64Bytes(JPEG_B64)), { mime: "image/jpeg", w: 20, h: 10, ppi: 150 });
  assert.deepStrictEqual(K.imageInfo(K.base64Bytes("AAAA")), { mime: "image/png", w: 0, h: 0, ppi: 300 });
  assert.strictEqual(K.base64Bytes("").length, 0);
});
test("schematic image: base64 atoms join, size = px × 25.4/PPI × scale centred on `at`, placeholder until loaded, onAssetLoaded hook, cache", () => {
  const b64 = pngB64(4, 2, 3780); const body = `(image (at 100 50) (scale 2) (uuid "im1") ${dataAtoms(b64)})`;
  assert(b64.length > 76 && K.kid(K.parse(body), "data").length >= 3, "data is split across several string atoms");
  const prevImage = globalThis.Image; globalThis.Image = FakeImage; FakeImage.made.length = 0;
  const events = []; const prevHook = K.onAssetLoaded;
  try {
    const doc = K.parseDoc(SCH_HEAD + body + ")"); const it = doc.items.get("im1"); assert(it && it.kind === "image");
    const g = it.geom.find((x) => x.t === "image"); assert(g, "image geometry record");
    const pxMm = 25.4 / 96; near(g.w, 4 * pxMm * 2, 1e-9); near(g.h, 2 * pxMm * 2, 1e-9); near(g.x + g.w / 2, 100, 1e-9); near(g.y + g.h / 2, 50, 1e-9);
    assert.strictEqual(g.layer, "Images"); assert(g.z < -6, "bitmaps draw under everything"); assert.strictEqual(g.color, K.SCH.notes);
    assert.strictEqual(g.entry.url, "data:image/png;base64," + b64); assert.strictEqual(FakeImage.made.length, 1); assert.strictEqual(FakeImage.made[0].src, g.entry.url);
    assert(!g.entry.loaded);
    // movable + hit-testable, listed on the Images layer
    const mv = K.movableItems(doc).find((m) => m.id === "im1"); assert(mv && mv.x === 100 && mv.y === 50 && mv.kind === "image");
    assert.strictEqual(K.hitTest(doc, 100, 50, 0), "im1"); assert.strictEqual(K.hitTest(doc, 100, 60, 0), null); assert.strictEqual(K.typeNameOf(it), "SCH_BITMAP");
    assert(K.layerList(doc).some((l) => l.key === "Images"));
    // before the bitmap decodes: a dashed placeholder frame, no drawImage
    const view = fitView(doc, 800, 600); let ctx = recCtx(800, 600); K.render(doc, ctx, view, {});
    const ph = ctx.ops.find((o) => o.op === "strokeRect" && o.stroke === K.SCH.notes); assert(ph, "placeholder frame"); assert.deepStrictEqual(ph.dash, [0.6, 0.4]); assert(!ctx.ops.some((o) => o.op === "drawImage"));
    near(ph.args[2], g.w, 1e-9);
    // the load hook: called with { id, kind, ok } once the browser has decoded the image
    K.onAssetLoaded = (info) => events.push(info);
    FakeImage.made[0].naturalWidth = 4; FakeImage.made[0].naturalHeight = 2; FakeImage.made[0].onload();
    assert.deepStrictEqual(events, [{ id: "im1", kind: "image", ok: true }]); assert(g.entry.loaded);
    ctx = recCtx(800, 600); K.render(doc, ctx, view, {});
    const di = ctx.ops.find((o) => o.op === "drawImage"); assert(di, "decoded image is drawn"); assert.strictEqual(di.args[0], FakeImage.made[0]);
    near(di.args[1], g.x, 1e-9); near(di.args[2], g.y, 1e-9); near(di.args[3], g.w, 1e-9); near(di.args[4], g.h, 1e-9);
    assert(!ctx.ops.some((o) => o.op === "strokeRect" && o.dash.length), "no placeholder once loaded");
    // selection halo and highlight cover the image
    ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["im1"]) }); assert(ctx.ops.some((o) => o.op === "strokeRect" && o.stroke === "#66B2FF" && o.alpha === 0.55));
    // a failed decode reports ok: false and keeps the placeholder
    const doc2 = K.parseDoc(SCH_HEAD + `(image (at 10 10) (uuid "im2") ${dataAtoms(b64)})` + ")"); assert.strictEqual(FakeImage.made.length, 2, "a different item id gets its own entry");
    FakeImage.made[1].onerror(); assert.deepStrictEqual(events[1], { id: "im2", kind: "image", ok: false });
    ctx = recCtx(800, 600); K.render(doc2, ctx, fitView(doc2, 800, 600), {}); assert(!ctx.ops.some((o) => o.op === "drawImage")); assert(ctx.ops.some((o) => o.op === "strokeRect" && o.dash.length));
    near(doc2.items.get("im2").geom[0].w, 4 * pxMm, 1e-9, "scale defaults to 1");
    // same id + same data: the cache is reused, no new Image and no new load event
    const doc3 = K.parseDoc(SCH_HEAD + body + ")"); assert.strictEqual(FakeImage.made.length, 2); assert(doc3.items.get("im1").geom[0].entry === g.entry && g.entry.loaded);
    // the hook is optional
    K.onAssetLoaded = null; const doc4 = K.parseDoc(SCH_HEAD + `(image (at 10 10) (uuid "im4") ${dataAtoms(pngB64(1, 1, 0))})` + ")"); FakeImage.made[2].onload();
    near(doc4.items.get("im4").geom[0].w, 25.4 / 300, 1e-9, "no pHYs: 300 PPI"); assert.strictEqual(events.length, 2);
    // an image whose data is missing still has a 10 mm placeholder and is movable
    const doc5 = K.parseDoc(SCH_HEAD + '(image (at 20 20) (uuid "im5"))' + ")"); const g5 = doc5.items.get("im5").geom[0]; near(g5.w, 10, 1e-9); assert.strictEqual(K.hitTest(doc5, 20, 20, 0), "im5");
    const ch = K.moveItem(doc5, doc5.items.get("im5"), 30, 30, 10000); assert.strictEqual(ch.typeName, "SCH_BITMAP"); near(doc5.items.get("im5").geom[0].x + 5, 30, 1e-9);
  } finally { globalThis.Image = prevImage; K.onAssetLoaded = prevHook; }
});
test("board image: layer colour, scale, JPEG density, drawn under every board layer", () => {
  const prevImage = globalThis.Image; delete globalThis.Image;   // no Image constructor at all (headless): placeholder only, no throw
  try {
    const doc = K.parseDoc(PCB_HEAD + `(image (at 50 50) (layer "F.SilkS") (scale 0.5) (uuid "bi1") ${dataAtoms(JPEG_B64)})` + ")");
    const it = doc.items.get("bi1"); const g = it.geom[0]; assert.strictEqual(g.t, "image");
    const pxMm = 25.4 / 150; near(g.w, 20 * pxMm * 0.5, 1e-9); near(g.h, 10 * pxMm * 0.5, 1e-9); near(g.x + g.w / 2, 50, 1e-9); near(g.y + g.h / 2, 50, 1e-9);
    assert.strictEqual(g.layer, "F.SilkS"); assert.strictEqual(g.color, "#F2EDA1"); assert(g.z < K.pcbZ("B.Fab") && g.z < K.pcbZ("B.Cu") - 1);
    assert.strictEqual(g.entry.mime, "image/jpeg"); assert.strictEqual(g.entry.img, null); assert.strictEqual(it.layer, "F.SilkS"); assert.strictEqual(K.typeNameOf(it), "PCB_REFERENCE_IMAGE");
    assert.strictEqual(K.hitTest(doc, 50, 50, 0), "bi1"); assert(K.movableItems(doc).some((m) => m.id === "bi1" && m.layer === "F.SilkS"));
    const ctx = recCtx(800, 600); K.render(doc, ctx, fitView(doc, 800, 600), {}); assert(ctx.ops.some((o) => o.op === "strokeRect" && o.stroke === "#F2EDA1"));
    const ctx2 = recCtx(800, 600); K.render(doc, ctx2, fitView(doc, 800, 600), { hidden: new Set(["F.SilkS"]) }); assert(!ctx2.ops.some((o) => o.op === "strokeRect" && o.stroke === "#F2EDA1"));
  } finally { if (prevImage) globalThis.Image = prevImage; }
});
test("sheet pins: every side reads into the sheet with the swapped input/output shapes", () => {
  const pin = (name, type, x, y, r, id) => `(pin "${name}" ${type} (at ${x} ${y} ${r}) (effects (font (size 1.27 1.27)) (justify right)) (uuid "${id}"))`;
  const doc = K.parseDoc(SCH_HEAD + '(sheet (at 50 50) (size 20 10) (stroke (width 0.1524)) (fill (color 0 0 0 0)) (uuid "s1") (property "Sheetname" "sub" (at 50 49 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "sub.kicad_sch" (at 50 61 0) (effects (font (size 1.27 1.27)) (justify left top))) ' +
    pin("R", "input", 70, 55, 0, "p1") + pin("T", "output", 60, 50, 90, "p2") + pin("L", "bidirectional", 50, 55, 180, "p3") + pin("B", "tri_state", 60, 60, 270, "p4") + pin("P", "passive", 65, 60, 270, "p5") + "))");
  const it = doc.items.get("s1"); const d = 0.15 * 1.27 + 1.27, hs = 0.635;
  const pins = { R: [70, 55], T: [60, 50], L: [50, 55], B: [60, 60], P: [65, 60] };
  const shapes = it.geom.filter((g) => g.t === "poly" && g.layer === "Sheets" && g.color === K.SCH.sheetLabel && (g.pts.length === 5 || g.pts.length === 6));
  assert.strictEqual(shapes.length, 5);
  const shapeOf = (name) => shapes.find((g) => g.pts.every((p) => Math.hypot(p[0] - pins[name][0], p[1] - pins[name][1]) <= 3 * hs));   // templates reach at most √5·hs from the pin
  const tR = texts(it, (g) => g.text === "R")[0], tT = texts(it, (g) => g.text === "T")[0], tL = texts(it, (g) => g.text === "L")[0], tB = texts(it, (g) => g.text === "B")[0];
  // right edge (rot 0): text reads leftwards into the sheet; the input pin shows the hierarchical OUTPUT shape pointing out of the sheet
  assert.strictEqual(tR.rot, 0); assert.strictEqual(tR.h, "right"); near(tR.x, 70 - d, 1e-9); near(tR.y, 55, 1e-9);
  let sh = shapeOf("R"); assert.strictEqual(sh.pts.length, 6); assert(sh.pts.every((p) => p[0] <= 70 + 1e-9)); assert(sh.pts.some((p) => Math.abs(p[0] - (70 - 2 * hs)) < 1e-9), "flag tip inside the sheet");
  // top edge (rot 90): vertical text reading down into the sheet; output pin shows the INPUT shape
  assert.strictEqual(tT.rot, 90); assert.strictEqual(tT.h, "right"); near(tT.x, 60, 1e-9); near(tT.y, 50 + d, 1e-9);
  sh = shapeOf("T"); assert.strictEqual(sh.pts.length, 6); assert(sh.pts.every((p) => p[1] >= 50 - 1e-9)); assert(sh.pts.some((p) => Math.abs(p[1] - (50 + 2 * hs)) < 1e-9));
  // left edge (rot 180): text reads rightwards
  assert.strictEqual(tL.rot, 0); assert.strictEqual(tL.h, "left"); near(tL.x, 50 + d, 1e-9);
  sh = shapeOf("L"); assert.strictEqual(sh.pts.length, 5); assert(sh.pts.every((p) => p[0] >= 50 - 1e-9)); assert(sh.pts.some((p) => Math.abs(p[0] - (50 + 2 * hs)) < 1e-9), "bidirectional diamond");
  // bottom edge (rot 270): vertical text reading up into the sheet
  assert.strictEqual(tB.rot, 90); assert.strictEqual(tB.h, "left"); near(tB.y, 60 - d, 1e-9);
  sh = shapeOf("B"); assert.strictEqual(sh.pts.length, 5); assert(sh.pts.every((p) => p[1] <= 60 + 1e-9));
  sh = shapeOf("P"); assert.strictEqual(sh.pts.length, 5); assert(sh.pts.every((p) => p[1] <= 60 + 1e-9)); assert.strictEqual(sh.pts.filter((p) => Math.abs(p[1] - (60 - 2 * hs)) < 1e-9).length, 2, "passive: a box");
  for (const g of shapes) { assert.strictEqual(g.layer, "Sheets"); assert(g.w > 0); }
});
test("highlight option: the set is drawn brightened with a halo, everything else at 25% alpha", () => {
  assert.strictEqual(K.brightened("#C83434", 0.5), "#e49a9a"); assert.strictEqual(K.highlightColor("#C83434", true), "#e49a9a"); assert.strictEqual(K.highlightColor("#009600", false), K.SCH.brightened); assert.strictEqual(K.HL_DIM, 0.25);
  const sch = K.parseDoc(SCH_HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1")) (wire (pts (xy 0 5) (xy 10 5)) (stroke (width 0) (type default)) (uuid "w2")) (junction (at 5 0) (diameter 0) (color 0 0 0 0) (uuid "j1")) (label "NET" (at 2 5 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1")))');
  const view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
  let ctx = recCtx(800, 600); K.render(sch, ctx, view, { highlight: new Set(["w1", "j1"]) });
  const strokes = ctx.ops.filter((o) => o.op === "stroke");
  assert(strokes.some((o) => o.stroke === K.SCH.brightened && o.alpha === 1), "highlighted wire in LAYER_BRIGHTENED");
  assert(strokes.some((o) => o.stroke === K.SCH.wire && o.alpha === 0.25), "the other wire is dimmed");
  assert(ctx.ops.some((o) => o.op === "fill" && o.fill === K.SCH.brightened && o.alpha === 1), "junction fill takes the highlight colour");
  assert(ctx.ops.some((o) => o.op === "fillText" && o.alpha === 0.25 && o.fill === K.SCH.label), "text of other items is dimmed");
  assert(strokes.filter((o) => o.stroke === K.SCH.brightened && o.alpha === 0.15).length >= 2, "halo pass around the highlighted geometry");
  ctx = recCtx(800, 600); K.render(sch, ctx, view, { highlight: null }); assert(!ctx.ops.some((o) => o.alpha === 0.25 || o.stroke === K.SCH.brightened), "null highlight: normal drawing");
  ctx = recCtx(800, 600); K.render(sch, ctx, view, { highlight: new Set() }); assert(!ctx.ops.some((o) => o.alpha === 0.25), "empty set: normal drawing");
  // boards brighten the item's own colour by the highlight factor
  const pcb = K.parseDoc(PCB_HEAD + '(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 0) (uuid "s1")) (segment (start 0 5) (end 10 5) (width 0.25) (layer "B.Cu") (net 0) (uuid "s2")))');
  ctx = recCtx(800, 600); K.render(pcb, ctx, view, { highlight: new Set(["s1"]) });
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#e49a9a" && o.alpha === 1)); assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#4D7FC4" && o.alpha === 0.25));
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#e49a9a" && o.alpha === 0.35), "board halo");
  // highlight composes with high-contrast dimming and hidden layers
  ctx = recCtx(800, 600); K.render(pcb, ctx, view, { highlight: new Set(["s1"]), hidden: new Set(["F.Cu"]) }); assert(!ctx.ops.some((o) => o.stroke === "#e49a9a"));
});
test("selected: a halo for every id in the set; polylines with a fill", () => {
  const doc = K.parseDoc(SCH_HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1")) (wire (pts (xy 0 5) (xy 10 5)) (stroke (width 0) (type default)) (uuid "w2")) (wire (pts (xy 0 8) (xy 10 8)) (stroke (width 0) (type default)) (uuid "w3")) (junction (at 5 0) (diameter 0) (color 0 0 0 0) (uuid "j1")))');
  const view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
  let ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["w1", "w2", "w3"]) });
  assert.strictEqual(ctx.ops.filter((o) => o.op === "stroke" && o.stroke === "#66B2FF" && o.alpha === 0.55).length, 3, "one halo stroke per selected wire");
  ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["w1", "j1", "nope"]) });
  assert.strictEqual(ctx.ops.filter((o) => o.op === "stroke" && o.stroke === "#66B2FF").length, 2); assert.strictEqual(ctx.ops.filter((o) => o.op === "fill" && o.fill === "#66B2FF").length, 1, "filled circle halo");
  // sheet-level polylines: a closed outline with (fill …) is filled like an SCH_SHAPE (drawPolygon writes these)
  const poly = (fill, id) => SCH_HEAD + `(polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 0)) (stroke (width 0) (type default)) (fill ${fill}) (uuid "${id}")))`;
  let it = K.parseDoc(poly("(type background)", "p1")).items.get("p1"); assert.strictEqual(it.geom.length, 2);
  assert.strictEqual(it.geom[0].fill, K.SCH.body); assert(it.geom[0].close && it.geom[0].noStroke); assert(it.geom[0].z < it.geom[1].z, "background fill below the outline"); assert.strictEqual(it.geom[1].fill, undefined); assert.strictEqual(it.geom[1].color, K.SCH.notes); assert(!it.geom[1].close);
  it = K.parseDoc(poly("(type outline)", "p2")).items.get("p2"); assert.strictEqual(it.geom[0].fill, K.SCH.notes); assert.strictEqual(it.geom[0].z, it.geom[1].z);
  it = K.parseDoc(poly("(type color) (color 0 255 0 1)", "p3")).items.get("p3"); assert.strictEqual(it.geom[0].fill, "#00ff00");
  it = K.parseDoc(poly("(type none)", "p4")).items.get("p4"); assert.strictEqual(it.geom.length, 1);
  it = K.parseDoc(SCH_HEAD + '(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (fill (type outline)) (uuid "p5")))').items.get("p5"); assert.strictEqual(it.geom.length, 1, "two points cannot fill");
  ctx = stubCtx(800, 600); K.render(K.parseDoc(poly("(type background)", "p6")), ctx, view, {}); assert(ctx.calls.fill >= 1);
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
