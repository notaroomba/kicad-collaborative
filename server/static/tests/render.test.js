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
  const ch = K.moveItem(doc, it, 20, 20, 10000); assert.strictEqual(ch.kind, "MODIFIED"); assert.strictEqual(ch.typeName, "SCH_TABLE"); assert(ch.sexpr.startsWith("(table"), ch.sexpr.slice(0, 40));   // bare item root: the copyable-only grammar the desktop parses fragments with
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
  const ch = K.moveItem(doc, it, 100, 100, 1e6); assert.strictEqual(ch.typeName, "PCB_TABLE"); assert(ch.sexpr.startsWith("(kicad_pcb ") && ch.sexpr.includes("(table"), ch.sexpr.slice(0, 40));   // PCB_IO_KICAD_SEXPR::Parse takes only kicad_pcb / footprint at top level assert.deepStrictEqual(seg(lines(it).find((g) => g.dash && g.y1 === 100 && g.y2 === 100)), [100, 100, 120, 100]);
  const hid = new Set(["Cmts.User"]); const ctx = stubCtx(800, 600); K.render(doc, ctx, fitView(doc, 800, 600), { hidden: hid, frame: false }); assert(!ctx.calls.fillText, "hidden layer hides the table");
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

// ---------------------------------------------------------------- the drawing sheet (web/canvas/sheet.ts)
// Every number below is KiCad's own: the (kicad_wks …) description in
// common/drawing_sheet/drawing_sheet_default_description.cpp:117-151 resolved through
// DS_DATA_ITEM::GetStartPos / IsInsidePage (ds_data_item.cpp:263-358) for an A4 landscape page.
const A4_SCH = '(kicad_sch (version 20250114) (generator "eeschema") (paper "A4") (title_block (title "My Board") (date "2026-01-02") (rev "B") (company "Acme") (comment 1 "one") (comment 4 "four")) (sheet_instances (path "/" (page "3"))))';
const sheetDoc = () => { const d = K.parseDoc(A4_SCH); d.fileName = "my_board.kicad_sch"; d.sheetPath = "/"; d.sheetCount = 5; d.kicadVersion = "9.9.9"; return d; };
// KiCad stores A4 as 11693 x 8268 mils (common/page_info.cpp:34,42-49), so the page — and with it every
// right/bottom-anchored coordinate on the sheet — is 297.0022 x 210.0072 mm, not 297 x 210.
const A4W = 297.0022, A4H = 210.0072;
const sheetOf = (doc) => { const it = K.documentDrawingSheet(doc); return { all: it,
  rects: it.filter((g) => g.t === "rect"), lines: it.filter((g) => g.t === "line"), texts: it.filter((g) => g.t === "text") }; };
const seg4 = (l) => [l.x1, l.y1, l.x2, l.y2].map((v) => +v.toFixed(6));

test("drawing sheet: the built-in description parses to KiCad's setup and item list", () => {
  const wks = K.parseDrawingSheet(K.DEFAULT_DRAWING_SHEET);
  assert.deepStrictEqual(wks.setup, { textSizeX: 1.5, textSizeY: 1.5, lineWidth: 0.15, textLineWidth: 0.15, left: 10, right: 10, top: 10, bottom: 10 });
  assert.strictEqual(wks.items.length, 29, "2 rects + 8 tick/label runs + 19 title-block items");
  const [tb, frame, topTick, topLabel] = wks.items;
  assert.deepStrictEqual(tb.start, { x: 110, y: 34, anchor: "rb" }); assert.deepStrictEqual(tb.end, { x: 2, y: 2, anchor: "rb" });
  assert.strictEqual(frame.repeat, 2); assert.deepStrictEqual(frame.incr, [2, 2]); assert.deepStrictEqual(frame.start.anchor, "lt");
  assert.strictEqual(topTick.repeat, 30); assert.deepStrictEqual(topTick.incr, [50, 0]);
  assert.strictEqual(topLabel.text, "1"); assert.strictEqual(topLabel.repeat, 100); assert.strictEqual(topLabel.sizeY, 1.3);
  assert.strictEqual(topLabel.hjust, "left"); assert.strictEqual(topLabel.vjust, "middle", "only (justify center) items are centred");
  const rowLabel = wks.items.find((i) => i.text === "A"); assert.strictEqual(rowLabel.hjust, "center"); assert.strictEqual(rowLabel.vjust, "middle", "(justify center) sets both axes");
  const title = wks.items.find((i) => i.text === "Title: ${TITLE}");
  assert.strictEqual(title.sizeY, 2); assert.strictEqual(title.bold, true); assert.strictEqual(title.italic, true);
});

test("drawing sheet: pages are whole mils, as PAGE_INFO stores them", () => {
  // MMsize( mm ) = EDA_UNIT_UTILS::Mm2mils( mm ) = KiROUND( mm * 1000 / 25.4 ) (common/page_info.cpp:34,
  // common/eda_units.cpp:72), so the ISO papers are NOT their nominal millimetres.
  const page = (paper) => K.parseDoc(`(kicad_sch (version 1) (generator "e") (paper "${paper}"))`).page.map((v) => +v.toFixed(4));
  assert.deepStrictEqual(page("A5"), [210.0072, 148.0058]);
  assert.deepStrictEqual(page("A4"), [297.0022, 210.0072]);
  assert.deepStrictEqual(page("A3"), [419.989, 297.0022]);
  assert.deepStrictEqual(page("A2"), [594.0044, 419.989]);
  assert.deepStrictEqual(page("A1"), [840.994, 594.0044]);
  assert.deepStrictEqual(page("A0"), [1188.9994, 840.994]);
  assert.strictEqual(K.mm2mils(297), 11693); assert.strictEqual(K.mm2mils(420), 16535);
  // the imperial papers are already whole mils, so they are exact
  assert.deepStrictEqual(page("USLetter"), [279.4, 215.9]);
  assert.deepStrictEqual(page("USLegal"), [355.6, 215.9]);
  assert.deepStrictEqual(page("USLedger"), [431.8, 279.4]);
  // a custom page keeps its millimetres: SetWidthMM feeds SetWidthMils a double (include/page_info.h:136)
  assert.deepStrictEqual(page2(K.parseDoc('(kicad_sch (version 1) (generator "e") (paper "User" 200 150))')), [200, 150]);
});
function page2(d) { return d.page.map((v) => +v.toFixed(4)); }

test("drawing sheet: frame rectangles, tick counts and label sequences for A4 landscape", () => {
  const { rects, lines, texts } = sheetOf(sheetDoc());
  const r4 = (v) => +v.toFixed(4);
  // item 1: the title-block box; item 2 (repeat 2, incr 2 2): the frame on the margins and 2 mm inside it
  assert.deepStrictEqual(rects.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h].map(r4)),
    [[177.0022, 166.0072, 285.0022, 198.0072], [10, 10, 287.0022, 200.0072], [12, 12, 285.0022, 198.0072]]);
  for (const r of rects) near(r.lw, 0.15, 1e-9);
  // 50 mm ticks spanning the 2 mm band, one run per edge; the run stops when a copy leaves the framed area
  const at = (pred) => lines.filter(pred).map(seg4).map((l) => l.map(r4));
  assert.deepStrictEqual(at((l) => l.y1 === 12 && l.y2 === 10), [[60, 12, 60, 10], [110, 12, 110, 10], [160, 12, 160, 10], [210, 12, 210, 10], [260, 12, 260, 10]], "top ticks");
  assert.deepStrictEqual(at((l) => r4(l.y1) === r4(A4H - 12) && r4(l.y2) === r4(A4H - 10)),
    [[60, 198.0072, 60, 200.0072], [110, 198.0072, 110, 200.0072], [160, 198.0072, 160, 200.0072], [210, 198.0072, 210, 200.0072], [260, 198.0072, 260, 200.0072]], "bottom ticks");
  assert.deepStrictEqual(at((l) => l.x1 === 10 && l.x2 === 12), [[10, 60, 12, 60], [10, 110, 12, 110], [10, 160, 12, 160]], "left ticks");
  assert.deepStrictEqual(at((l) => r4(l.x1) === r4(A4W - 10)),
    [[287.0022, 60, 285.0022, 60], [287.0022, 110, 285.0022, 110], [287.0022, 160, 285.0022, 160]], "right ticks");
  // labels: one more than the ticks — the last one lands exactly on RB and IsInsidePage is inclusive
  const lab = (pred) => texts.filter(pred).map((t) => [t.text, r4(t.x), r4(t.y)]);
  assert.deepStrictEqual(lab((t) => t.y === 11), [["1", 35, 11], ["2", 85, 11], ["3", 135, 11], ["4", 185, 11], ["5", 235, 11], ["6", 285, 11]], "top column labels");
  assert.deepStrictEqual(lab((t) => r4(t.y) === r4(A4H - 11)),
    [["1", 35, 199.0072], ["2", 85, 199.0072], ["3", 135, 199.0072], ["4", 185, 199.0072], ["5", 235, 199.0072], ["6", 285, 199.0072]], "bottom column labels");
  assert.deepStrictEqual(lab((t) => t.x === 11), [["A", 11, 35], ["B", 11, 85], ["C", 11, 135], ["D", 11, 185]], "left row labels");
  assert.deepStrictEqual(lab((t) => r4(t.x) === r4(A4W - 11)),
    [["A", 286.0022, 35], ["B", 286.0022, 85], ["C", 286.0022, 135], ["D", 286.0022, 185]], "right row labels");
  for (const t of texts.filter((x) => x.size === 1.3)) { near(t.w, 0.15, 1e-9); assert.strictEqual(t.v, "middle"); }
  // A3 is wider and taller: the runs simply go further.  RB.x is 419.989 - 10 = 409.989, so the copy at
  // x = 410 falls OUTSIDE the framed area and IsInsidePage drops it — 7 ticks, not 8.
  const a3 = K.parseDoc(A4_SCH.replace('(paper "A4")', '(paper "A3")'));
  const s3 = sheetOf(a3);
  assert.deepStrictEqual(s3.rects.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h].map(r4)),
    [[299.989, 253.0022, 407.989, 285.0022], [10, 10, 409.989, 287.0022], [12, 12, 407.989, 285.0022]]);
  assert.deepStrictEqual(s3.lines.filter((l) => l.y1 === 12 && l.y2 === 10).map((l) => l.x1), [60, 110, 160, 210, 260, 310, 360], "A3 top ticks stop at 360");
  assert.deepStrictEqual(s3.texts.filter((t) => t.y === 11).map((t) => t.text), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepStrictEqual(s3.texts.filter((t) => t.x === 11).map((t) => t.text), ["A", "B", "C", "D", "E", "F"]);
  // A2 is 419.989 tall, so its left and right tick runs stop at 360 for the same reason
  const a2 = sheetOf(K.parseDoc(A4_SCH.replace('(paper "A4")', '(paper "A2")')));
  assert.deepStrictEqual(a2.lines.filter((l) => l.x1 === 10 && l.x2 === 12).map((l) => l.y1), [60, 110, 160, 210, 260, 310, 360], "A2 left ticks stop at 360");
  // portrait A4: the page swaps, so the bands do too
  const port = K.parseDoc(A4_SCH.replace('(paper "A4")', '(paper "A4" portrait)'));
  assert.deepStrictEqual(port.page.map(r4), [210.0072, 297.0022]);
  const pr = sheetOf(port).rects[1];
  assert.deepStrictEqual([pr.x, pr.y, r4(pr.w), r4(pr.h), pr.lw], [10, 10, 190.0072, 277.0022, 0.15]);
});

test("drawing sheet: title-block rules and text land on KiCad's anchors, with its sizes and pen widths", () => {
  const { lines, texts } = sheetOf(sheetDoc());
  const r4 = (v) => +v.toFixed(4);
  const inTb = (x, y) => x >= 177 && x <= 286 && y >= 166 && y <= 199;   // inside the title-block box, so not the tick runs
  const rules = lines.filter((l) => inTb(l.x1, l.y1) && inTb(l.x2, l.y2)).map(seg4).map((l) => l.map(r4));
  assert.deepStrictEqual(rules, [[177.0022, 194.5072, 285.0022, 194.5072], [177.0022, 191.5072, 285.0022, 191.5072],
    [177.0022, 187.5072, 285.0022, 187.5072], [177.0022, 181.5072, 285.0022, 181.5072],
    [197.0022, 191.5072, 197.0022, 194.5072], [261.0022, 191.5072, 261.0022, 198.0072]], "four horizontal rules and the two short verticals");
  const by = (t) => texts.find((g) => g.text === t);
  const place = (t) => { const g = by(t); assert(g, "expected " + JSON.stringify(t)); return [r4(g.x), r4(g.y), g.size, +g.w.toFixed(6), g.h, g.v, !!g.bold, !!g.italic]; };
  assert.deepStrictEqual(place("Date: 2026-01-02"), [200.0022, 193.1072, 1.5, 0.15, "left", "middle", false, false]);
  assert.deepStrictEqual(place("Size: A4"), [178.0022, 193.1072, 1.5, 0.15, "left", "middle", false, false]);
  assert.deepStrictEqual(place("Rev: B"), [263.0022, 193.1072, 1.5, 0.3, "left", "middle", true, false], "bold feeds pen 0, so the auto-bold size/5 applies");
  assert.deepStrictEqual(place("Id: 3/5"), [263.0022, 195.9072, 1.5, 0.15, "left", "middle", false, false], "${#} from (sheet_instances), ${##} from the app");
  assert.deepStrictEqual(place("Title: My Board"), [178.0022, 189.3072, 2, 0.4, "left", "middle", true, true]);
  assert.deepStrictEqual(place("File: my_board.kicad_sch"), [178.0022, 185.7072, 1.5, 0.15, "left", "middle", false, false]);
  assert.deepStrictEqual(place("Sheet: /"), [178.0022, 183.0072, 1.5, 0.15, "left", "middle", false, false]);
  assert.deepStrictEqual(place("Acme"), [178.0022, 180.0072, 1.5, 0.3, "left", "middle", true, false]);
  assert.deepStrictEqual(place("one"), [178.0022, 177.0072, 1.5, 0.15, "left", "middle", false, false]);
  assert.deepStrictEqual(place("four"), [178.0022, 168.0072, 1.5, 0.15, "left", "middle", false, false]);
  // ${KICAD_VERSION} is `productName + " " + GetBaseVersion()` (ds_painter.cpp:40,119-121) — the cell
  // at wks (pos 109 4.1), bottom-left of the title block.  The base version is baked in from the KiCad
  // this tree builds (canvas/version.ts) so the desktop and the web read the same string.
  assert.deepStrictEqual(place("KiCad E.D.A. 9.9.9"), [178.0022, 195.9072, 1.5, 0.15, "left", "middle", false, false]);
  assert.strictEqual(K.PRODUCT_NAME, "KiCad E.D.A.");
  assert(!texts.some((t) => t.text.indexOf("KICAD_VERSION") >= 0 || t.text.indexOf("${") >= 0), "no unresolved references");
});

test("drawing sheet: empty title-block fields keep their labels, as KiCad's resolver does", () => {
  const bare = K.parseDoc('(kicad_sch (version 20250114) (generator "e") (paper "A4"))');
  const { texts } = sheetOf(bare);
  for (const t of ["Date: ", "Rev: ", "Title: ", "File: ", "Sheet: ", "Size: A4", "Id: 1/1"]) assert(texts.some((g) => g.text === t), "expected " + JSON.stringify(t));
  assert(texts.some((g) => g.text.startsWith("KiCad E.D.A. ")), "the version cell is drawn on every page");
  assert(!texts.some((t) => t.text === ""), "an empty ${COMPANY} / ${COMMENTn} draws nothing at all");
  assert.strictEqual(K.parseDoc(A4_SCH).pageNumber, "3");
  assert.deepStrictEqual(K.parseDoc(A4_SCH).titleBlock, { title: "My Board", date: "2026-01-02", rev: "B", company: "Acme", comment1: "one", comment4: "four" });
  assert.strictEqual(K.parseDoc(A4_SCH).paper, "A4");
});

test("drawing sheet: text variables expand like ExpandTextVars, unresolved ones stay put", () => {
  const vars = K.sheetTextVars(Object.assign(K.parseDoc(A4_SCH), { fileName: "b.kicad_sch", sheetPath: "/sub/", sheetCount: 4 }));
  assert.strictEqual(vars.TITLE, "My Board"); assert.strictEqual(vars.REVISION, "B"); assert.strictEqual(vars.ISSUE_DATE, "2026-01-02");
  assert.strictEqual(vars.COMMENT1, "one"); assert.strictEqual(vars.COMMENT2, ""); assert.strictEqual(vars["#"], "3"); assert.strictEqual(vars["##"], "4");
  const r = K.varResolver(vars);
  assert.strictEqual(K.expandTextVars("Title: ${TITLE}", r), "Title: My Board");
  assert.strictEqual(K.expandTextVars("Id: ${#}/${##}", r), "Id: 3/4");
  assert.strictEqual(K.expandTextVars("x ${NOPE} y", r), "x ${NOPE} y", "an unresolved reference is left verbatim");
  assert.strictEqual(K.expandTextVars("plain", r), "plain");
  assert.strictEqual(K.expandTextVars("${COMPANY}${COMMENT2}", r), "Acme");
  // BuildFullText re-runs the worksheet resolver over a resolved title-block value with
  // `m_titleBlock = nullptr` (ds_painter.cpp:174-186), so a WORKSHEET token nested in a title-block
  // field resolves and another TITLE-BLOCK token deliberately does not.
  const nest = (over) => K.expandTextVars("${TITLE}", K.varResolver(Object.assign({}, vars, over)));
  assert.strictEqual(nest({ TITLE: "v${REVISION}" }), "v${REVISION}", "a title-block token inside a title-block field stays put");
  assert.strictEqual(nest({ TITLE: "p${PAPER}" }), "pA4", "a worksheet token inside one still resolves");
  assert.strictEqual(nest({ TITLE: "${COMMENT1}" }), "${COMMENT1}");
  // TITLE_BLOCK::TextVarResolver rewrites *aToken to the field's value BEFORE deciding it did not
  // resolve it (title_block.cpp:186-188), and ExpandTextVars then wraps the rewritten token
  // (common.cpp:311-315): a self-referencing field really does come out doubled.
  assert.strictEqual(K.expandTextVars("Rev: ${REVISION}", K.varResolver(Object.assign({}, vars, { REVISION: "${REVISION}" }))), "Rev: ${${REVISION}}");
  // the project's text_variables are the last resolver (ds_painter.cpp:222-223), and they are what
  // rescue a real (rev "${REVISION}") — qa/data/eeschema/netlists/issue24220 is shaped that way
  const proj = { project: { REVISION: "r7", MYVAR: "from project" } };
  assert.strictEqual(K.expandTextVars("Rev: ${REVISION}", K.varResolver(Object.assign({}, vars, { REVISION: "${REVISION}" }), proj)), "Rev: r7");
  assert.strictEqual(K.expandTextVars("${TITLE}", K.varResolver(Object.assign({}, vars, { TITLE: "${MYVAR}" }), proj)), "from project");
  assert.strictEqual(K.expandTextVars("${MYVAR}", K.varResolver(vars, proj)), "from project", "a token nothing else claims falls through to the project");
  assert(K.WS_TOKENS.has("KICAD_VERSION") && K.WS_TOKENS.has("FILEPATH") && K.TB_TOKENS.has("COMMENT9") && !K.TB_TOKENS.has("COMMENT10"));
});

test("drawing sheet: a \\n in a field becomes a centred multiline run, as EDA_TEXT lays it out", () => {
  // DS_DATA_ITEM_TEXT::ReplaceAntiSlashSequence turns the escape into a newline and marks the item
  // multiline; EDA_TEXT::GetLinePositions (common/eda_text.cpp:937-978) then spreads the lines one
  // STROKE_FONT interline apart and centres the block on the anchor, so one line never moves.
  const doc = K.parseDoc('(kicad_sch (version 1) (generator "e") (paper "A4") (title_block (comment 2 "lit $ {NOT} \\n done")))');
  const g = sheetOf(doc).texts.find((t) => t.multiline);
  assert(g, "the field is flagged multiline");
  assert.strictEqual(g.text, "lit $ {NOT} \n done");
  near(K.TEXT_INTERLINE, 1.68 * 0.9583, 1e-12);
  assert.deepStrictEqual(K.lineOffsets(2, "middle"), [-0.5, 0.5]);
  assert.deepStrictEqual(K.lineOffsets(1, "middle"), [0], "a single line sits exactly where it always did");
  assert.deepStrictEqual(K.lineOffsets(3, "top"), [0, 1, 2]);
  assert.deepStrictEqual(K.lineOffsets(3, "bottom"), [-2, -1, 0]);
  // the canvas draws one run per line, 2.4149 mm apart for 1.5 mm text, centred on the anchor's baseline
  const ctx = recCtx(1200, 900); K.render(doc, ctx, fitView(doc, 1200, 900), { grid: 0 });
  const runs = ctx.ops.filter((o) => o.op === "fillText" && /lit|done/.test(o.args[0])).map((o) => [o.args[0], +o.args[2].toFixed(4)]);
  assert.deepStrictEqual(runs, [["lit $ {NOT} ", -0.4575], [" done", 1.9575]], "two baselines an interline apart, straddling the single-line baseline of 0.75");
  near(runs[1][1] - runs[0][1], 1.5 * K.TEXT_INTERLINE, 1e-4);   // the values above are rounded to 4 dp
  // and the SVG export emits one <text> per line instead of one that whitespace-collapses
  const svg = K.renderSvg(doc, {});
  assert(svg.includes('<text y="-0.4575"') && svg.includes('<text y="1.9575"'), "two <text> elements");
  assert(!/<text[^>]*>[^<]*\n[^<]*<\/text>/.test(svg), "no literal newline left inside a <text>");
});

test("drawing sheet: a subsheet's ${#} and ${SHEETPATH} come from the PARENT's (sheet …) node", () => {
  // A child .kicad_sch has no (sheet_instances …) at all: its page number lives in the parent's
  // (sheet … (instances (project … (path … (page "N"))))) and reaches the title block through
  // SCH_SCREEN::GetPageNumber() (eeschema/sch_view.cpp:134).  The web has to read it the same way.
  const parent = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (paper "A4")
    (sheet (at 10 10) (size 20 20) (uuid "s1") (property "Sheetname" "Power") (property "Sheetfile" "power.kicad_sch")
      (instances (project "proj" (path "/root-uuid" (page "2")))))
    (sheet_instances (path "/" (page "1"))))`);
  const sheets = K.movableItems(parent).filter((m) => m.kind === "sheet");
  assert.deepStrictEqual(sheets.map((m) => [m.name, m.file, m.page]), [["Power", "power.kicad_sch", "2"]]);
  assert.strictEqual(parent.pageNumber, "1", "the root still reads its own (sheet_instances …)");
  // the child, given what its parent says, prints "Id: 2/2" and "Sheet: /Power/"
  const child = K.parseDoc('(kicad_sch (version 20250114) (generator "eeschema") (paper "A4"))');
  assert.strictEqual(child.pageNumber, "1", "on its own the child can only say 1");
  child.pageNumber = sheets[0].page; child.sheetName = sheets[0].name; child.sheetPath = "/" + sheets[0].name + "/"; child.sheetCount = 2;
  const t = sheetOf(child).texts;
  assert(t.some((g) => g.text === "Id: 2/2"), "Id: 2/2");
  assert(t.some((g) => g.text === "Sheet: /Power/"), "Sheet: /Power/");
  // …and on KiCad's own five-page hierarchy the numbers are 1..5, matching a kicad-cli PDF of it
  const hier = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "issue22938");
  if (fs.existsSync(path.join(hier, "issue22938.kicad_sch"))) {
    const root = K.parseDoc(fs.readFileSync(path.join(hier, "issue22938.kicad_sch"), "utf8"), "kicad_sch");
    assert.strictEqual(root.pageNumber, "1");
    const byName = {}; for (const m of K.movableItems(root)) if (m.kind === "sheet") byName[m.name] = m.page;
    assert.deepStrictEqual(byName, { Spannungsversorgung: "2", Anschluss: "3", Schrittmotor: "4", Kompressor: "5" });
  }
});

test("drawing sheet: repeated labels step like STRING_INCREMENTER", () => {
  assert.strictEqual(K.incrementLabel("1", 1), "2"); assert.strictEqual(K.incrementLabel("9", 1), "10");
  assert.strictEqual(K.incrementLabel("09", 1), "10"); assert.strictEqual(K.incrementLabel("009", 1), "010", "zero padding survives only while the number is no wider");
  assert.strictEqual(K.incrementLabel("A", 1), "B"); assert.strictEqual(K.incrementLabel("A", 25), "Z");
  assert.strictEqual(K.incrementLabel("A", 26), "AA", "past Z the label grows: Z -> AA -> AB");
  assert.strictEqual(K.incrementLabel("A", 27), "AB"); assert.strictEqual(K.incrementLabel("A", 51), "AZ"); assert.strictEqual(K.incrementLabel("A", 52), "BA");
  assert.strictEqual(K.incrementLabel("a", 1), "b", "case is kept");
  assert.strictEqual(K.incrementLabel("Sheet A", 1), "Sheet B", "only the rightmost incrementable chunk moves");
  assert.strictEqual(K.incrementLabel("A1", 1), "A2", "an integer suffix wins over the letters before it");
  assert.strictEqual(K.incrementLabel("--", 1), "--", "nothing incrementable: the base text stands");
  assert.strictEqual(K.indexFromAlphabetic("A"), 0); assert.strictEqual(K.indexFromAlphabetic("Z"), 25);
  assert.strictEqual(K.indexFromAlphabetic("AA"), 26); assert.strictEqual(K.indexFromAlphabetic("BA"), 52);
  assert.strictEqual(K.alphabeticFromIndex(0), "A"); assert.strictEqual(K.alphabeticFromIndex(26), "AA"); assert.strictEqual(K.alphabeticFromIndex(52), "BA");
  // a page big enough to run the column labels past Z
  const wide = K.parseDoc('(kicad_sch (version 1) (generator "e") (paper "User" 1400 300))');
  const cols = sheetOf(wide).texts.filter((t) => t.y === 11).map((t) => t.text);
  assert.deepStrictEqual(cols.slice(0, 3), ["1", "2", "3"]); assert.strictEqual(cols.length, 28);
});

test("drawing sheet: KiCad's colours and widths on the canvas, page limits last and in the lighter grey", () => {
  const doc = sheetDoc();
  const ctx = recCtx(1200, 900); K.render(doc, ctx, fitView(doc, 1200, 900), { grid: 0 });
  const sheetStrokes = ctx.ops.filter((o) => o.op === "stroke" && o.stroke === K.SCH.frame);
  assert(sheetStrokes.length >= 1, "the sheet is stroked in LAYER_SCHEMATIC_DRAWINGSHEET #840000");
  assert.strictEqual(K.SCH.frame, "#840000"); assert.strictEqual(K.SCH.pageLimits, "#B5B5B5");
  const border = ctx.ops.filter((o) => o.op === "strokeRect" && o.stroke === K.SCH.pageLimits);
  assert.strictEqual(border.length, 1, "one page outline, in LAYER_SCHEMATIC_PAGE_LIMITS grey — not the sheet's dark red");
  assert.deepStrictEqual(border[0].args.map((v) => +v.toFixed(4)), [0, 0, A4W, A4H]);
  assert.strictEqual(ctx.ops.indexOf(border[0]), ctx.ops.length - 1 - ctx.ops.slice().reverse().indexOf(border[0]), "drawn once");
  assert(ctx.ops.some((o) => o.op === "fillText" && o.args[0] === "Title: My Board"), "the title block's text is drawn");
  // the board draws the same sheet in the board's own layer colours (pcbnew shares DS_DATA_MODEL)
  const pcb = K.parseDoc(PCB_HEAD + '(gr_line (start 0 0) (end 10 0) (stroke (width 0.2) (type solid)) (layer "Edge.Cuts") (uuid "e1")))');
  const pctx = recCtx(1200, 900); K.render(pcb, pctx, fitView(pcb, 1200, 900), { grid: 0 });
  assert(pctx.ops.some((o) => o.op === "stroke" && o.stroke === "#C872AB"), "LAYER_DRAWINGSHEET pink on a board");
  assert(pctx.ops.some((o) => o.op === "strokeRect" && o.stroke === "#848484"), "LAYER_PAGE_LIMITS grey on a board");
  // Flip Board View mirrors the board but not the sheet — "Draw the title block normally even if the
  // view is flipped" (ds_proxy_view_item.cpp:114-128)
  const fctx = fullCtx(1200, 900); K.render(pcb, fctx, fitView(pcb, 1200, 900), { grid: 0, flip: true });
  const sheetTf = fctx.ops.filter((o) => o.op === "strokeRect" && o.stroke === "#848484");
  assert.strictEqual(sheetTf.length, 1); assert(sheetTf[0].tf[0] > 0, "the sheet keeps an unmirrored transform under flip");
  // opts.frame === false still skips the whole sheet (the subset-export contract)
  const off = recCtx(1200, 900); K.render(doc, off, fitView(doc, 1200, 900), { grid: 0, frame: false });
  assert(!off.ops.some((o) => o.stroke === K.SCH.frame || o.stroke === K.SCH.pageLimits), "frame: false draws no sheet at all");
  assert(!off.ops.some((o) => o.op === "fillText"), "and none of its text");
});

test("drawing sheet: renderSvg emits the same geometry for a whole page and none of it for a subset", () => {
  const doc = sheetDoc();
  const svg = K.renderSvg(doc, {});
  assert(svg.includes('<rect x="10" y="10" width="277.0022" height="190.0072" fill="none" stroke="#840000" stroke-width="0.15"/>'), "outer frame");
  assert(svg.includes('<rect x="12" y="12" width="273.0022" height="186.0072" fill="none" stroke="#840000" stroke-width="0.15"/>'), "inner frame");
  assert(svg.includes('<rect x="177.0022" y="166.0072" width="108" height="32" fill="none" stroke="#840000" stroke-width="0.15"/>'), "title-block box");
  assert(svg.includes('<line x1="60" y1="12" x2="60" y2="10" stroke="#840000" stroke-width="0.15"/>'), "a tick");
  assert(svg.includes('<rect x="0" y="0" width="297.0022" height="210.0072" fill="none" stroke="#B5B5B5"'), "page outline in the page-limits grey");
  assert(svg.includes(">Title: My Board</text>") && svg.includes('font-weight="600" font-style="italic"'), "the bold italic title");
  assert(svg.includes(">Sheet: /</text>") && svg.includes(">Id: 3/5</text>"));
  const sub = K.renderSvg(doc, { ids: [], background: false });
  assert(!sub.includes("#840000") && !sub.includes("#B5B5B5") && !sub.includes("Title:"), "a subset export carries no sheet");
});

// ---------------------------------------------------------------- display options: stroke styles, nets, ratsnest, markers, net names, zone previews, flip, hidden text, exports
/** Recording context that also logs the composite mode, line width, text alignment and the transform in force at each drawing call. */
function fullCtx(w, h) {
  const calls = {}; const ops = []; const transforms = []; const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
  let stroke = "", fill = "", alpha = 1, dash = [], comp = "source-over", lw = 1, align = "", tf = null;
  const ctx = { canvas: { width: w, height: h }, calls, ops, transforms, font: "", textBaseline: "", lineCap: "", lineJoin: "" };
  for (const n of ["beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "clearRect", "clip"]) ctx[n] = () => rec(n);
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = (...args) => { rec(n); ops.push({ op: n, stroke, fill, alpha, dash: dash.slice(), comp, lw, align, tf, args }); };
  ctx.setTransform = (...a) => { rec("setTransform"); tf = a; transforms.push(a); };
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  Object.defineProperty(ctx, "globalCompositeOperation", { set: (v) => { comp = v; }, get: () => comp });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  Object.defineProperty(ctx, "textAlign", { set: (v) => { align = v; }, get: () => align });
  ctx.setLineDash = (d) => { rec("setLineDash"); dash = d; }; ctx.measureText = (t) => ({ width: t.length * 0.7 });
  return ctx;
}
const PENDING = [];
function testAsync(name, fn) { PENDING.push(Promise.resolve().then(fn).then(() => { passed++; }, (e) => { failed++; console.error("FAIL", name + ":", e.message); })); }
const NET_HEAD = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user) (49 "Dwgs.User" user)) (net 0 "") (net 1 "GND") (net 2 "VCC") ';
const V40 = { ppm: 40, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };   // 40 css px per mm, 1000×800 shows x −5..20, y −5..15
const textOps = (ctx, t) => ctx.ops.filter((o) => o.op === "fillText" && (t === undefined || o.args[0] === t));

test("stroke types: dash / dot / dash_dot / dash_dot_dot records, KiCad's ISO 128-2 dash pattern, solid geometry untouched", () => {
  const sch = K.parseDoc(SCH_HEAD + '(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0.2) (type dash)) (uuid "p1")) (rectangle (start 0 0) (end 5 5) (stroke (width 0.1) (type dot)) (fill (type none)) (uuid "r1")) (wire (pts (xy 0 5) (xy 10 5)) (stroke (width 0) (type default)) (uuid "w1")) (circle (center 20 20) (radius 2) (stroke (width 0) (type dash_dot_dot)) (fill (type none)) (uuid "c1")))');
  const p1 = sch.items.get("p1").geom[0]; assert.strictEqual(p1.dash, true); assert.strictEqual(p1.dashType, "dash");
  const r1 = sch.items.get("r1").geom[0]; assert.strictEqual(r1.dashType, "dot"); assert.strictEqual(sch.items.get("c1").geom[0].dashType, "dash_dot_dot");
  const w1 = sch.items.get("w1").geom[0]; assert.strictEqual(w1.dash, undefined); assert.strictEqual(w1.dashType, undefined);
  assert.deepStrictEqual(K.strokeOf(K.parse("(x (stroke (width 0.1) (type dash_dot)))"), 0), { w: 0.1, color: null, dash: true, type: "dash_dot" });
  assert.deepStrictEqual(K.strokeOf(K.parse("(x (stroke (width 0.1) (type solid)))"), 0).type, null);
  // STROKE_PARAMS::Stroke with the render settings' ratios (12 / 3, correction 1): dash 11 w, gap 4 w, dot 0.2 w
  assert.deepStrictEqual(K.dashPattern("dash", 0.2).map((v) => +v.toFixed(6)), [2.2, 0.8]);
  assert.deepStrictEqual(K.dashPattern("dot", 1).map((v) => +v.toFixed(6)), [0.2, 4]);
  assert.deepStrictEqual(K.dashPattern("dash_dot", 1), [11, 4, 0.2, 4]); assert.deepStrictEqual(K.dashPattern("dash_dot_dot", 1).length, 6);
  const pcb = K.parseDoc(NET_HEAD + '(gr_line (start 0 0) (end 10 0) (stroke (width 0.2) (type dash_dot)) (layer "Dwgs.User") (uuid "l1")) (gr_circle (center 5 5) (end 6 5) (stroke (width 0.1) (type dash)) (fill none) (layer "Dwgs.User") (uuid "c1")) (gr_text_box "tb" (start 0 8) (end 10 12) (stroke (width 0.1) (type dot)) (border yes) (layer "Dwgs.User") (uuid "tb1") (effects (font (size 1 1)))) (gr_line (start 0 14) (end 10 14) (stroke (width 0.2) (type solid)) (layer "Dwgs.User") (uuid "l2")))');
  assert.strictEqual(pcb.items.get("l2").geom[0].dash, undefined);
  assert.strictEqual(pcb.items.get("l1").geom[0].dashType, "dash_dot"); assert.strictEqual(pcb.items.get("c1").geom[0].dashType, "dash"); assert.strictEqual(pcb.items.get("tb1").geom.find((g) => g.t === "poly").dashType, "dot");
  const ctx = fullCtx(1000, 800); K.render(pcb, ctx, V40, { frame: false });   // frame: false — count the items' strokes, not the drawing sheet's
  const dashed = ctx.ops.filter((o) => o.op === "stroke" && o.dash.length);
  assert(dashed.some((o) => o.dash.map((v) => +v.toFixed(6)).join() === "2.2,0.8,0.04,0.8"), "gr_line dash_dot pattern from its 0.2 mm width");
  assert(dashed.some((o) => o.dash.map((v) => +v.toFixed(6)).join() === "1.1,0.4"), "dashed circle");
  assert.strictEqual(ctx.ops.filter((o) => o.op === "stroke" && !o.dash.length).length, 1, "the solid line stays solid"); assert.strictEqual(ctx.calls.setLineDash, 6, "every dashed stroke sets and resets the dash");
});
test("board net table and net numbers on copper geometry; pad tags for padAt / net colours", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (arc (start 10 0) (mid 12 2) (end 10 4) (width 0.5) (layer "F.Cu") (net 2) (uuid "a1")) (via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (zone (net 2) (net_name "VCC") (layer "B.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.25)) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))) (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)))) (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z2") (hatch edge 0.5) (polygon (pts (xy 20 0) (xy 30 0) (xy 30 10) (xy 20 10)))) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 40 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "p1")) (pad "2" thru_hole circle (at 3 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu") (net 2 "VCC") (uuid "p2")) (pad "" np_thru_hole circle (at 6 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "p3"))))');
  assert.deepStrictEqual([...doc.nets], [[0, ""], [1, "GND"], [2, "VCC"]]);
  assert.strictEqual(doc.items.get("s1").geom[0].net, 1); assert.strictEqual(doc.items.get("s1").net, 1); assert.strictEqual(doc.items.get("a1").geom[0].net, 2);
  const via = doc.items.get("v1"); assert.deepStrictEqual(via.geom.map((g) => [g.net, !!g.hole, g.viaLabel]), [[1, false, true], [1, false, undefined], [1, false, undefined], [1, true, undefined]], "three copper layers: three rings (the first carries the label) + the hole"); assert.strictEqual(via.geom[0].viaSize, 0.8);
  const z1 = doc.items.get("z1"); const o1 = z1.geom.find((g) => g.zoneOutline); assert(o1); assert.strictEqual(o1.net, 2); assert.strictEqual(o1.zoneClearance, 0.25); assert.strictEqual(o1.zoneUnfilled, false); assert.strictEqual(z1.geom.find((g) => g.zoneFill).net, 2);
  const o2 = doc.items.get("z2").geom.find((g) => g.zoneOutline); assert.strictEqual(o2.zoneUnfilled, true); assert.strictEqual(o2.zoneClearance, 0.5, "0.5 mm default clearance");
  const fp = doc.items.get("fp1"); const p1 = fp.geom.filter((g) => g.pad && g.padIndex === 0); assert.deepStrictEqual(p1.map((g) => g.layer).sort(), ["F.Cu", "F.Mask"]);
  assert.strictEqual(p1[0].padNumber, "1"); assert.strictEqual(p1[0].net, 1); assert.strictEqual(p1[0].netName, "GND"); assert.strictEqual(p1[0].padType, "smd");
  const p2 = fp.geom.filter((g) => g.padIndex === 1); assert(p2.some((g) => g.pad && g.layer === "In1.Cu" && g.net === 2)); assert.strictEqual(p2.filter((g) => g.hole).length, 2, "plated hole: wall + hole"); assert(!p2.some((g) => g.npth));
  const p3 = fp.geom.filter((g) => g.padIndex === 2); assert.strictEqual(p3.length, 1); assert(p3[0].npth && p3[0].hole && !p3[0].pad, "NPTH: hole only, no copper");
  assert(fp.geom.some((g) => g.padNum && g.text === "1") && fp.geom.some((g) => g.padNet && g.text === "GND"));
  // the existing records are untouched: pad shapes, fills, colours, bbox
  assert.strictEqual(p1.find((g) => g.layer === "F.Cu").fill, "#C83434"); near(fp.bbox[0], 40 - Math.hypot(1, 1) / 2, 1e-9);
});
test("ratsnest: LAYER_RATSNEST hairlines above copper and holes, below the user layers; nets filter; cross for coincident ends; net colours", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (gr_line (start -1 -1) (end 12 -1) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1")))');
  const rats = [{ net: 1, name: "GND", a: [10, 0], b: [5, 5] }, { net: 2, name: "VCC", a: [2, 2], b: [8, 8] }, { net: 2, name: "VCC", a: [3, 3], b: [3, 3] }, { net: 1, name: "GND", a: [100, 100], b: [120, 120] }];
  let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ratsnest: rats });
  const rs = ctx.ops.filter((o) => o.op === "stroke" && o.stroke === K.RATSNEST_COLOR); assert.strictEqual(rs.length, 1, "one batched stroke"); near(rs[0].lw, 0.5 / 40, 1e-9, "0.5 device px"); assert.strictEqual(rs[0].alpha, 1);
  assert.strictEqual(K.RATSNEST_COLOR, "rgba(0,248,255,0.35)");
  const idx = ctx.ops.indexOf(rs[0]); const lastCu = ctx.ops.map((o, i) => (o.op === "stroke" && o.stroke === "#C83434") || (o.op === "fill" && (o.fill === "#C83434" || o.fill === "#E3B72E")) ? i : -1).filter((i) => i >= 0).pop();
  const edge = ctx.ops.findIndex((o) => o.op === "stroke" && o.stroke === "#D0D2CD"); assert(lastCu < idx && idx < edge, "ratsnest between the copper/holes and Edge.Cuts: " + lastCu + " < " + idx + " < " + edge);
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ratsnest: rats, ratsnestNets: new Set([2]) });
  const base = fullCtx(1000, 800); K.render(doc, base, V40, {});
  assert.strictEqual(ctx.calls.moveTo - base.calls.moveTo, 3, "one line + the cross (two moves) for net 2; net 1 filtered; off-screen line culled");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ratsnest: rats, netColors: new Map([[2, "#abcdef"]]) });
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#abcdef") && ctx.ops.some((o) => o.op === "stroke" && o.stroke === K.RATSNEST_COLOR), "net colour per batch");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ratsnest: [] }); assert(!ctx.ops.some((o) => o.stroke === K.RATSNEST_COLOR));
  const sch = K.parseDoc(SCH_HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1")))'); ctx = fullCtx(800, 600); K.render(sch, ctx, V40, { ratsnest: rats }); assert(!ctx.ops.some((o) => o.stroke === K.RATSNEST_COLOR), "board only");
});
test("markers: MARKER_BASE flag polygon, DRC / ERC colours, zoom scale, shadow, draw order, markerAt", () => {
  assert.deepStrictEqual(K.MARKER_CORNERS, [[0, 0], [8, 1], [4, 3], [13, 8], [9, 9], [8, 13], [3, 4], [1, 8]]);
  assert.deepStrictEqual(K.MARKER_SCALE, { pcb: 0.1625, sch: 0.15 });
  assert.deepStrictEqual(K.markerPolygon({ x: 10, y: 20 }, 0.1625)[3].map((v) => +v.toFixed(6)), [10 + 13 * 0.1625, 20 + 8 * 0.1625]);
  // PCB_MARKER::SetZoom( 1 / sqrt( zoom ) ): the flag shrinks with √zoom; schematic markers keep 0.15 mm per unit
  const z1 = { ppm: K.PX_PER_MM_ZOOM1, zoom: 1 }; near(K.zoomFactor(z1), 1, 1e-9); near(K.markerScale("pcb", z1), 0.1625, 1e-9); near(K.markerScale("pcb", { ppm: K.PX_PER_MM_ZOOM1, zoom: 4 }), 0.1625 / 2, 1e-9);
  near(K.markerScale("sch", { ppm: 100, zoom: 3 }), 0.15, 1e-12); near(K.PX_PER_MM_ZOOM1, 91 / 25.4, 1e-9);
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")))');
  const markers = [{ x: 1, y: 1, severity: "error", text: "Clearance" }, { x: 5, y: 5, severity: "warning", text: "Silk" }, { x: 8, y: 2, severity: "exclusion", text: "x" }, { x: 9, y: 9, severity: "bogus" }];
  let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { markers, selected: new Set(["s1"]) });
  const fills = ctx.ops.filter((o) => o.op === "fill" && Object.values(K.MARKER_COLORS.pcb).includes(o.fill));
  assert.deepStrictEqual(fills.map((o) => o.fill), [K.MARKER_COLORS.pcb.error, K.MARKER_COLORS.pcb.warning, K.MARKER_COLORS.pcb.exclusion, K.MARKER_COLORS.pcb.error], "unknown severities draw as errors");
  assert.strictEqual(K.MARKER_COLORS.pcb.error, "rgba(215,91,107,0.8)"); assert.strictEqual(K.MARKER_COLORS.pcb.warning, "rgba(255,208,66,0.8)"); assert.strictEqual(K.MARKER_COLORS.sch.error, "rgba(230,9,13,0.8)"); assert.strictEqual(K.MARKER_COLORS.sch.warning, "rgba(209,146,0,0.8)");
  const shadows = ctx.ops.filter((o) => o.op === "stroke" && o.stroke === "rgba(0,16,35,0.5)"); assert.strictEqual(shadows.length, 4, "LAYER_MARKER_SHADOWS: background @ 0.5"); near(shadows[0].lw, K.markerScale("pcb", V40), 1e-9, "shadow one scale unit wide");
  const track = ctx.ops.findIndex((o) => o.op === "stroke" && o.stroke === "#C83434"), first = ctx.ops.indexOf(fills[0]), sel = ctx.ops.findIndex((o) => o.stroke === "#66B2FF");
  assert(track < first && first < sel, "markers above the geometry, below the selection halo");
  assert.strictEqual(ctx.calls.moveTo - 8 * 0, ctx.calls.moveTo); assert(ctx.calls.lineTo >= 4 * 7, "8 corners per flag");
  const sch = K.parseDoc(SCH_HEAD + '(wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1")))');
  ctx = fullCtx(800, 600); K.render(sch, ctx, V40, { markers: [{ x: 2, y: 2, severity: "warning" }] });
  assert(ctx.ops.some((o) => o.op === "fill" && o.fill === K.MARKER_COLORS.sch.warning)); assert(!ctx.ops.some((o) => o.op === "stroke" && /rgba\(245,244,239/.test(o.stroke)), "no shadow on schematics");
  // hover look-up: inside the flag, outside it, and within a tolerance of its box
  assert.strictEqual(K.markerAt(markers, 1.5, 1.2, 0), markers[0]); assert.strictEqual(K.markerAt(markers, 1.0, 2.0, 0), null, "inside the box but outside the flag");
  assert.strictEqual(K.markerAt(markers, 1.0, 2.0, 0.1), markers[0], "tolerance falls back to the box"); assert.strictEqual(K.markerAt(markers, 5.1, 5.1, 0, 0.15), markers[1]); assert.strictEqual(K.markerAt(markers, 50, 50, 1), null); assert.strictEqual(K.markerAt(null, 0, 0, 1), null);
});
test("netNames: track labels sized to the track, skipped when short or too thin on screen; via names and layer pairs; pad labels unaffected", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 12 0) (width 1) (layer "F.Cu") (net 1) (uuid "s1")) (segment (start 0 3) (end 12 3) (width 0.25) (layer "F.Cu") (net 2) (uuid "s2")) (segment (start 0 6) (end 2 6) (width 1) (layer "F.Cu") (net 2) (uuid "s3")) (segment (start 14 0) (end 14 10) (width 1) (layer "B.Cu") (net 1) (uuid "s4")) (segment (start 0 8) (end 4 12) (width 1) (layer "F.Cu") (net 0) (uuid "s5")) ' +
    '(via (at 8 8) (size 2) (drill 1) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (via blind (at 12 8) (size 2) (drill 1) (layers "F.Cu" "In1.Cu") (net 2) (uuid "v2")) (via (at 16 8) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v3")) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 18 2) (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 2 "VCC") (uuid "p1"))))');
  let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { frame: false });   // frame: false — the drawing sheet's title block is text too
  assert.deepStrictEqual(textOps(ctx).map((o) => o.args[0]).sort(), ["1", "VCC"], "without the option only the pad number and pad net name");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { netNames: true, frame: false });
  const labels = textOps(ctx).filter((o) => !o.args[0].match(/^(1|VCC)$/) || o.fill !== "rgba(255,255,255,0.9)");
  const gnd = labels.filter((o) => o.args[0] === "GND"); assert.strictEqual(gnd.length, 3, "s1 (1 mm wide), s4 (vertical), and the 2 mm via; not the 0.6 mm via: " + JSON.stringify(labels.map((o) => o.args[0])));
  assert(gnd.some((o) => o.fill === "rgba(255,255,255,0.7)"), "NETNAMES_LAYER_ID_START white @ 0.7 on the dark copper"); assert(gnd.some((o) => o.fill === K.VIA_NETNAME_COLOR), "LAYER_VIA_NETNAMES on the via"); assert.strictEqual(K.VIA_NETNAME_COLOR, "rgba(50,50,50,0.9)");
  assert(!labels.some((o) => o.args[0] === "VCC" && o.fill === "rgba(255,255,255,0.7)"), "0.25 mm track is 10 px wide: under the 4 mm-at-zoom-1 LOD; 2 mm-long s3 is shorter than width × 3 chars");
  assert(labels.some((o) => o.args[0] === "1-2"), "blind via shows its layer pair"); assert(labels.some((o) => o.args[0] === "VCC" && o.fill === K.VIA_NETNAME_COLOR), "blind via net name");
  const s1 = gnd.find((o) => o.fill === "rgba(255,255,255,0.7)" && Math.abs(o.tf[1]) < 1e-9); assert(s1, "horizontal label"); near(s1.tf[0], 40, 1e-9); near(s1.tf[4], (6 + 5) * 40, 1e-6, "centred on the segment (x = 6 mm, view origin −5)");
  const vert = gnd.find((o) => o.fill === "rgba(255,255,255,0.7)" && Math.abs(o.tf[1]) > 1); assert(vert, "vertical label rotated 90°"); near(vert.tf[0], 0, 1e-9); near(vert.tf[1], -40, 1e-9);
  assert.strictEqual(K.trackNameColor("#C83434"), "rgba(255,255,255,0.7)"); assert.strictEqual(K.trackNameColor("#F2EDA1"), "rgba(0,0,0,0.7)", "dark labels on bright copper");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 }, { netNames: true });
  assert(!textOps(ctx).some((o) => o.args[0] === "GND"), "zoomed out (1 mm = 10 px < 4 mm at zoom 1): no track or via names");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { netNames: true, hidden: new Set(["F.Cu"]) }); assert(!textOps(ctx).some((o) => o.args[0] === "GND" && Math.abs(o.tf[1]) < 1e-9), "hidden layer hides its labels");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { netNames: true, highContrast: true, activeLayer: "B.Cu" }); assert.strictEqual(textOps(ctx, "GND").filter((o) => o.fill === "rgba(255,255,255,0.7)").length, 1, "no names on dimmed tracks");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { netNames: true, outlineTracks: true }); assert(!textOps(ctx).some((o) => o.args[0] === "GND" && o.fill === "rgba(255,255,255,0.7)"), "sketch tracks carry no names");
});
test("netColors: NET_COLOR_MODE::ALL colours copper of the net — tracks, vias, pads, zone fills; nothing else", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (segment (start 0 2) (end 10 2) (width 0.5) (layer "F.Cu") (net 2) (uuid "s2")) (via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "z1") (hatch edge 0.5) (polygon (pts (xy 0 6) (xy 10 6) (xy 10 10) (xy 0 10))) (filled_polygon (layer "B.Cu") (pts (xy 1 7) (xy 9 7) (xy 9 9) (xy 1 9)))) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 12 2) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "p1"))))');
  const ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { netColors: new Map([[1, "#00ff00"]]), hidden: new Set() });
  const green = ctx.ops.filter((o) => (o.op === "stroke" && o.stroke === "#00ff00") || (o.op === "fill" && o.fill === "#00ff00"));
  assert.strictEqual(green.length, 1 + 3 + 1 + 1, "track stroke, three via rings, zone fill, pad fill: " + green.length);
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#C83434"), "net 2 keeps the layer colour"); assert(ctx.ops.some((o) => o.op === "fill" && o.fill === "#E3B72E"), "via hole keeps its colour");
  assert(!ctx.ops.some((o) => o.op === "fill" && o.fill === "#00ff00" && o.alpha < 1)); assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#4D7FC4"), "zone outline / hatch on B.Cu keep the layer colour");
});
test("zoneFill: unfilled zones get a preview at the zone opacity minus the clearance rings, on an offscreen canvas", () => {
  const doc = K.parseDoc(NET_HEAD + '(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.3)) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))) (zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "z2") (hatch edge 0.5) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))) (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)))) ' +
    '(segment (start 1 5) (end 9 5) (width 0.5) (layer "F.Cu") (net 2) (uuid "s1")) (segment (start 1 6) (end 9 6) (width 0.5) (layer "B.Cu") (net 2) (uuid "s2")) (segment (start 1 7) (end 9 7) (width 0.5) (layer "F.Cu") (net 1) (uuid "s3")) (via (at 5 2) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 2) (uuid "v1")) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 3 3) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "VCC") (uuid "p1")) (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p2")) (pad "" np_thru_hole circle (at 4 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "p3"))))');
  const made = []; const prev = K.createCanvas;
  K.createCanvas = (w, h) => { const c = { width: w, height: h, ctx: fullCtx(w, h) }; c.getContext = () => c.ctx; made.push(c); return c; };
  try {
    let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { zoneFill: true });
    assert.strictEqual(made.length, 1); const off = made[0]; assert.strictEqual(off.width, 1000);
    const fills = off.ctx.ops.filter((o) => o.op === "fill" && o.comp === "source-over"); assert.strictEqual(fills.length, 1, "the F.Cu outline filled once"); assert.strictEqual(fills[0].fill, "#C83434"); assert.strictEqual(fills[0].alpha, 1);
    const cut = off.ctx.ops.filter((o) => o.comp === "destination-out");
    // other-net track: stroke at width + 2·clearance; other-net via: filled disc of r + clearance; other-net pad: fill + ring; NPTH hole: fill + ring
    const trackCut = cut.find((o) => o.op === "stroke" && Math.abs(o.lw - (0.5 + 0.6)) < 1e-9); assert(trackCut, "net 2 track knocked out with the clearance: " + JSON.stringify(cut.map((o) => [o.op, o.lw])));
    assert.strictEqual(cut.filter((o) => o.op === "stroke" && Math.abs(o.lw - 0.6) < 1e-9).length, 2, "pad ring + NPTH ring at 2·clearance");
    assert.strictEqual(cut.filter((o) => o.op === "fill").length, 3, "via disc, pad, NPTH");
    assert.strictEqual(cut.length, 6, "same-net track / pad and the B.Cu track are not cut: " + cut.length);
    const comp = ctx.ops.find((o) => o.op === "drawImage"); assert(comp, "composited onto the board"); assert.strictEqual(comp.args[0], off); assert.strictEqual(comp.alpha, K.ZONE_OPACITY); assert.strictEqual(K.ZONE_OPACITY, 0.6); assert.deepStrictEqual(comp.tf, [1, 0, 0, 1, 0, 0]);
    const zoneFillOps = ctx.ops.filter((o) => o.op === "fill" && o.fill === "#4D7FC4"); assert.strictEqual(zoneFillOps.length, 2, "the filled B.Cu zone keeps its normal fill (+ the via's B.Cu ring)");
    assert.strictEqual(ctx.ops.filter((o) => o.op === "drawImage").length, 1, "no preview for the filled zone");
    const outline = ctx.ops.findIndex((o) => o.op === "stroke" && o.stroke === "#C83434"), di = ctx.ops.indexOf(comp); assert(di < outline, "preview drawn below the zone outline and tracks");
    assert(!doc.items.get("z1").geom.some((g) => g.fill), "nothing written into the geometry"); assert(!K.kid(doc.items.get("z1").node, "filled_polygon"), "nothing written into the document");
    ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, {}); assert(!ctx.ops.some((o) => o.op === "drawImage"), "off by default");
    ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { zoneFill: true, zoneOutline: true }); assert.strictEqual(ctx.ops.filter((o) => o.op === "drawImage").length, 1, "previews still shown in outline mode (they are not fills of the document)");
    ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { zoneFill: true, hidden: new Set(["F.Cu"]) }); assert(!ctx.ops.some((o) => o.op === "drawImage"), "hidden layer: no preview");
    assert.strictEqual(made.length, 1, "the offscreen canvas is reused");
  } finally { K.createCanvas = prev; }
});
test("flip: X mirrored about the board centre; side-specific text mirrors with the board, other text and pad labels stay readable", () => {
  const doc = K.parseDoc(NET_HEAD + '(gr_line (start 0 0) (end 20 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1")) (gr_line (start 0 10) (end 20 10) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e2")) ' +
    '(gr_text "FRONT" (at 5 2 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1)) (justify left))) (gr_text "BACK" (at 5 4 0) (layer "B.SilkS") (uuid "t2") (effects (font (size 1 1)) (justify left mirror))) (gr_text "USER" (at 5 6 0) (layer "Dwgs.User") (uuid "t3") (effects (font (size 1 1)) (justify left))) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 15 5) (pad "7" smd rect (at 0 0) (size 3 3) (layers "F.Cu") (net 1 "GND") (uuid "p1"))))');
  near(K.flipCentre(doc), 10, 1e-9); near(K.flipX(doc, 3), 17, 1e-9); near(K.unflipX(doc, K.flipX(doc, 3)), 3, 1e-9); near(K.unflipX(doc, 17), 3, 1e-9);
  const view = { ppm: 40, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
  const ctx = fullCtx(1000, 800); K.render(doc, ctx, view, { flip: true });
  assert.deepStrictEqual(ctx.transforms[1], [-40, 0, 0, 40, 5 * 40 + 2 * 10 * 40, 5 * 40], "base transform mirrors X about x = 10");
  const t = (s) => textOps(ctx, s)[0];
  assert(t("FRONT").tf[0] < 0 && t("FRONT").align === "left", "front silk text mirrors with the view"); assert(t("BACK").tf[0] > 0 && t("BACK").align === "left", "mirrored back text reads normally from the back");
  assert(t("USER").tf[0] > 0 && t("USER").align === "right", "Dwgs.User text is re-mirrored with its justification swapped (same box)");
  assert(t("7").tf[0] > 0 && t("GND").tf[0] > 0, "pad labels stay readable");
  near(t("USER").tf[4], (2 * 10 - 5 + 5) * 40, 1e-6, "anchor at the mirrored position");
  const plain = fullCtx(1000, 800); K.render(doc, plain, view, {}); assert(textOps(plain, "FRONT")[0].tf[0] > 0 && textOps(plain, "BACK")[0].tf[0] < 0 && textOps(plain, "USER")[0].align === "left");
  assert.strictEqual(plain.calls.stroke, ctx.calls.stroke, "same geometry drawn");
  const o = fullCtx(10, 10); K.setViewTransform(o, view, doc); assert.deepStrictEqual(o.transforms[0], [-40, 0, 0, 40, 1000, 200]); K.setViewTransform(o, view); assert.deepStrictEqual(o.transforms[1], [40, 0, 0, 40, 200, 200]);
  // culling works in the mirrored space: an item only visible after the flip is drawn
  const doc2 = K.parseDoc(NET_HEAD + '(gr_line (start 0 0) (end 100 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1")) (gr_text "FAR" (at 95 2 0) (layer "Dwgs.User") (uuid "t1") (effects (font (size 1 1)))))');
  const c1 = fullCtx(1000, 800); K.render(doc2, c1, view, {}); assert(!textOps(c1, "FAR").length); const c2 = fullCtx(1000, 800); K.render(doc2, c2, view, { flip: true }); assert(textOps(c2, "FAR").length === 1);
  const sch = K.parseDoc(SCH_HEAD + '(text "S" (at 5 5 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t1")))'); const c3 = fullCtx(800, 600); K.render(sch, c3, view, { flip: true }); assert(c3.transforms[1][0] > 0, "schematics never flip");
});
test("padNumbers, showHiddenText and knockout text", () => {
  const doc = K.parseDoc(NET_HEAD + '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 5 5) (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1)))) (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1)))) (fp_text user "note" (at 0 3 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1)))) (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "GND") (uuid "p1"))) ' +
    '(gr_text "KO" (at 12 2 0) (layer "F.SilkS" knockout) (uuid "k1") (effects (font (size 1 1) (thickness 0.15)))) (gr_text_box "box" (start 12 4) (end 18 6) (layer "F.SilkS") (knockout yes) (uuid "k2") (effects (font (size 1 1)))))');
  const fp = doc.items.get("fp1");
  assert(!texts(fp, (g) => g.text === "R1")[0] && !texts(fp, (g) => g.text === "note")[0], "hidden text is not in item.geom");
  assert.deepStrictEqual(fp.hiddenGeom.map((g) => [g.text, g.hiddenText, g.layer]), [["R1", true, "F.SilkS"], ["note", true, "F.Fab"]]);
  const bare = K.parseDoc(NET_HEAD + '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 5 5) (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1)))) (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "GND") (uuid "p1"))))');
  assert.deepStrictEqual(fp.bbox, bare.items.get("fp1").bbox, "hidden text does not grow the bbox");
  let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { frame: false }); assert.deepStrictEqual(textOps(ctx).map((o) => o.args[0]).sort(), ["1", "10k", "GND", "KO", "box"]);
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { padNumbers: false, frame: false }); assert.deepStrictEqual(textOps(ctx).map((o) => o.args[0]).sort(), ["10k", "GND", "KO", "box"], "pad numbers off, net names kept");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { showHiddenText: true, hidden: new Set(["F.Fab"]) });
  const r1 = textOps(ctx, "R1"); assert.strictEqual(r1.length, 1); assert.strictEqual(r1[0].alpha, K.HIDDEN_TEXT_ALPHA); assert.strictEqual(r1[0].fill, "#F2EDA1"); assert(!textOps(ctx, "note").length, "hidden text on a hidden layer stays hidden");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { showHiddenText: true, showHiddenPins: true }); assert.strictEqual(textOps(ctx, "note").length, 1);
  const sch = K.parseDoc(SCH_HEAD + '(lib_symbols (symbol "L:P" (symbol "P_1_1" (pin power_in line (at 0 0 0) (length 2.54) hide (name "VCC" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))) (symbol (lib_id "L:P") (at 10 10 0) (unit 1) (uuid "u1")))');
  ctx = fullCtx(800, 600); K.render(sch, ctx, V40, { showHiddenText: true }); assert(!textOps(ctx, "VCC").length, "showHiddenText is a board option: hidden pins stay hidden"); ctx = fullCtx(800, 600); K.render(sch, ctx, V40, { showHiddenPins: true }); assert.strictEqual(textOps(ctx, "VCC").length, 1);
  // knockout: (layer … knockout) on text, (knockout yes) on text boxes → the box in the layer colour, the glyphs in the background colour
  const ko = texts(doc.items.get("k1"))[0]; assert.strictEqual(ko.knockout, true); assert.strictEqual(ko.color, "#F2EDA1"); assert.strictEqual(texts(doc.items.get("k2"))[0].knockout, true);
  assert.strictEqual(texts(fp, (g) => g.text === "10k")[0].knockout, undefined);
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, {});
  const koText = textOps(ctx, "KO")[0]; assert.strictEqual(koText.fill, "#001023"); const koIdx = ctx.ops.indexOf(koText); const box = ctx.ops[koIdx - 1]; assert.strictEqual(box.op, "fillRect"); assert.strictEqual(box.fill, "#F2EDA1");
  const w = K.textWidth("KO", 1, 0.15), m = Math.max(0.15 / 2, 1 / 9); near(box.args[2], w + 2 * m, 1e-9, "box = text width + 2 × GetKnockoutTextMargin"); near(box.args[3], 1 + 2 * m, 1e-9);
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { background: "#ffffff" }); assert.strictEqual(textOps(ctx, "KO")[0].fill, "#ffffff", "glyphs cut in the actual background colour");
});
test("render: ids subset, background off, grid as one path", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (segment (start 0 2) (end 10 2) (width 0.5) (layer "B.Cu") (net 2) (uuid "s2")))');
  let ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ids: ["s2"] }); assert(ctx.ops.some((o) => o.stroke === "#4D7FC4") && !ctx.ops.some((o) => o.stroke === "#C83434"));
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { ids: new Set(["s1"]) }); assert(!ctx.ops.some((o) => o.stroke === "#4D7FC4"));
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { background: false }); assert(!ctx.ops.some((o) => o.op === "fillRect"), "no background fill"); assert.strictEqual(ctx.calls.clearRect, 1);
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { background: "#123456" }); assert.strictEqual(ctx.ops[0].op, "fillRect"); assert.strictEqual(ctx.ops[0].fill, "#123456");
  ctx = fullCtx(1000, 800); K.render(doc, ctx, V40, { grid: 1 }); assert(ctx.calls.rect > 100, "grid dots as path rects"); assert.strictEqual(ctx.ops.filter((o) => o.op === "fillRect").length, 1, "only the background uses fillRect"); assert.strictEqual(ctx.ops.filter((o) => o.op === "fill" && o.fill === "#848484").length, 1, "one fill for the whole grid");
});
test("bboxOf and padAt", () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (via (at 20 20) (size 1) (drill 0.5) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) ' +
    '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 30 0 0) (pad "1" smd roundrect (at 0 0 45) (size 4 2) (layers "F.Cu") (roundrect_rratio 0.25) (net 1 "GND") (uuid "p1")) (pad "2" thru_hole circle (at 6 0) (size 2 2) (drill 1) (layers "*.Cu") (net 2 "VCC") (uuid "p2")) (pad "3" smd trapezoid (at 12 0 0) (size 2 2) (rect_delta 0 1) (layers "F.Cu") (uuid "p3")) (pad "4" smd oval (at 18 0 90) (size 4 1) (layers "F.Cu") (uuid "p4")) (pad "5" smd rect (at 6 0) (size 6 6) (layers "F.Cu") (uuid "p5"))))');
  assert.deepStrictEqual(K.bboxOf(doc, ["s1", "v1"]).map((v) => +v.toFixed(6)), [-0.25, -0.25, 20.5, 20.5]); assert.deepStrictEqual(K.bboxOf(doc, new Set(["v1", "nope"])).map((v) => +v.toFixed(6)), [19.5, 19.5, 20.5, 20.5]); assert.strictEqual(K.bboxOf(doc, []), null); assert.strictEqual(K.bboxOf(doc, ["nope"]), null);
  const at = (x, y) => { const p = K.padAt(doc, x, y); return p && p.number; };
  // rotated roundrect: 4×2 at 45° — along its own long axis it reaches 2 mm, across it 1 mm
  assert.strictEqual(at(30 + 1.9 * Math.SQRT1_2, 0 - 1.9 * Math.SQRT1_2), "1"); assert.strictEqual(at(30 + 1.9 * Math.SQRT1_2, 0 + 1.9 * Math.SQRT1_2), null, "outside across the short axis");
  assert.strictEqual(at(30 + 1.95 * Math.SQRT1_2 + 0.95 * Math.SQRT1_2, -1.95 * Math.SQRT1_2 + 0.95 * Math.SQRT1_2), null, "the rounded corner is cut off (r = 0.5)");
  assert.strictEqual(at(36.9, 0), "2", "circle THT wins over the 6 mm square pad that also covers it (smallest area)"); assert.strictEqual(at(38.5, 0), "5"); assert.strictEqual(at(36, 0), "2", "the hole belongs to its pad");
  assert.strictEqual(at(42, -0.9), "3"); assert.strictEqual(at(42.9, -0.9), null, "trapezoid: the narrow side"); assert.strictEqual(at(42.9, 0.9), "3", "trapezoid: the wide side");
  assert.strictEqual(at(48, 1.9), "4", "oval rotated 90°: 4 mm tall"); assert.strictEqual(at(48.45, 1.9), null, "oval cap");
  const p = K.padAt(doc, 30, 0); assert.strictEqual(p.index, 0); assert.strictEqual(p.item.id, "fp1"); assert.strictEqual(p.pad[0], "pad"); assert.strictEqual(K.str(p.pad[1]), "1"); assert.strictEqual(p.net, 1); assert.strictEqual(p.netName, "GND"); near(p.x, 30, 1e-9); near(p.y, 0, 1e-9);
  assert.strictEqual(K.padAt(doc, 5, 0), null, "tracks are not pads"); assert.strictEqual(K.padAt(doc, 100, 100), null);
});
test("renderSvg: whole document, subsets, layer visibility, text anchoring, arcs, images, knockout, dashes", () => {
  const b64 = pngB64(4, 2, 0); const prevImage = globalThis.Image; delete globalThis.Image;
  try {
    const sch = K.parseDoc(SCH_HEAD + '(wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "w1")) (label "~{RST}" (at 12 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1")) (arc (start 30 10) (mid 32 12) (end 30 14) (stroke (width 0.2) (type dash)) (fill (type none)) (uuid "a1")) (circle (center 40 40) (radius 3) (stroke (width 0) (type default)) (fill (type background)) (uuid "c1")) (text "rot" (at 50 50 90) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t1")) ' + `(image (at 60 60) (uuid "im1") ${dataAtoms(b64)})` + ")");
    const svg = K.renderSvg(sch, {});
    assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith("</svg>"));
    assert(svg.includes('width="297.0022mm" height="210.0072mm" viewBox="0 0 297.0022 210.0072"'), "whole sheet"); assert(svg.includes(`fill="${K.SCH.bg}"`), "sheet background"); assert(svg.includes(`stroke="${K.SCH.frame}"`), "page frame");
    assert(svg.includes('<path d="M10 10L20 10" fill="none" stroke="#009600" stroke-width="0.1524" stroke-linecap="round"/>'), "wire");
    assert(/<text y="0" font-family='[^']*' font-size="1.778" text-anchor="start" fill="#0F0F0F">RST<\/text>/.test(svg), "label text with the same anchoring as the canvas"); assert(/<path d="M0 -1\.5621L[\d.]+ -1\.5621" fill="none" stroke="#0F0F0F"/.test(svg), "overbar");
    assert(/<path d="M30 10A2 2 0 0 [01] 30 14" fill="none" stroke="#0000C2" stroke-width="0.2" stroke-linecap="butt" stroke-dasharray="2.2 0.8"\/>/.test(svg), "dashed arc as an A command");
    assert(svg.includes('<circle cx="40" cy="40" r="3" fill="#FFFFC2"/>') && svg.includes('<circle cx="40" cy="40" r="3" fill="none" stroke="#0000C2" stroke-width="0.1524" stroke-linecap="butt"/>'), "filled circle body + outline");
    assert(svg.includes('<g transform="translate(50 49.75) rotate(-90)">'), "rotated text");
    assert(svg.includes('<image x="') && svg.includes(`href="data:image/png;base64,${b64}"`), "image as a data URI");
    const noImg = K.renderSvg(sch, { hidden: new Set(["Images", "Wires"]) }); assert(!noImg.includes("<image") && !noImg.includes('stroke="#009600"'), "hidden layers");
    const sub = K.renderSvg(sch, { ids: ["w1"], background: false }); const wb = K.bboxOf(sch, ["w1"]); const f4 = (v) => String(+(+v).toFixed(4));
    assert(sub.includes(`viewBox="${f4(wb[0] - 1)} ${f4(wb[1] - 1)} ${f4(wb[2] - wb[0] + 2)} ${f4(wb[3] - wb[1] + 2)}"`) && sub.includes(`width="${f4(wb[2] - wb[0] + 2)}mm"`), "subset: union bbox + 1 mm margin: " + sub.slice(0, 160)); assert(!sub.includes(`fill="${K.SCH.bg}"`) && !sub.includes("RST") && !sub.includes(`stroke="${K.SCH.frame}"`));
    const box = K.renderSvg(sch, { bbox: [0, 0, 100, 50], margin: 0 }); assert(box.includes('viewBox="0 0 100 50"') && box.includes("RST") && !box.includes('cx="40"') === false);
    const box2 = K.renderSvg(sch, { bbox: [200, 100, 250, 150] }); assert(!box2.includes("RST"), "items outside the area are dropped");
    const pcb = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (gr_text "KO" (at 2 2 0) (layer "F.SilkS" knockout) (uuid "k1") (effects (font (size 1 1) (thickness 0.15)))) (gr_text "M" (at 2 4 0) (layer "B.SilkS") (uuid "m1") (effects (font (size 1 1) (thickness 0.3)) (justify mirror))) (gr_arc (start 8 0) (mid 10 2) (end 8 4) (stroke (width 0.2) (type default)) (layer "Dwgs.User") (uuid "ga")) ' +
      '(footprint "T:X" (layer "F.Cu") (uuid "fp1") (at 15 5) (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1)))) (pad "1" smd roundrect (at 0 0 30) (size 2 1) (layers "F.Cu") (roundrect_rratio 0.25) (net 1 "GND") (uuid "p1"))))');
    const s = K.renderSvg(pcb, {});
    assert(s.includes('viewBox="-1.25 -1.25') && s.includes(`fill="${K.PCB_COLORS["F.Cu"]}"`) && s.includes('fill="#001023"'), "board bbox + 1 mm margin, board background");
    assert(s.includes('<path d="M0 0L10 0" fill="none" stroke="#C83434" stroke-width="0.5" stroke-linecap="round"/>'), "track");
    assert(s.includes('<circle cx="5" cy="5" r="0.4" fill="#C83434"/>') && s.includes('r="0.2" fill="#E3B72E"'), "via rings and hole");
    const kw = K.textWidth("KO", 1, 0.15), km = Math.max(0.15 / 2, 1 / 9);
    assert(s.includes(`<rect x="${f4(-kw / 2 - km)}" y="${f4(0.5 - 1 - km)}" width="${f4(kw + 2 * km)}" height="${f4(1 + 2 * km)}" fill="#F2EDA1"/><text y="0.5"`) && s.includes('fill="#001023">KO</text>'), "knockout: box in the layer colour, glyphs in the background");
    assert(s.includes('<g transform="translate(2 4) scale(-1 1)"><text') && /stroke="#E8B2A7" stroke-width="0\.17" stroke-linejoin="round" paint-order="stroke">M<\/text>/.test(s), "mirrored back text, bold stroke");
    assert(/<path d="M8 0A2 2 0 0 1 8 4" fill="none" stroke="#C2C2C2"/.test(s), "board arc (inside the export area: gr_arcs do not feed the board bbox)");
    const pad = /<path d="M[^"]*A0\.25 0\.25[^"]*Z" fill="#C83434"\/>/.exec(s); assert(pad, "roundrect pad as a path with corner arcs"); assert((pad[0].match(/A0\.25/g) || []).length === 4);
    assert(!s.includes(">R1<"), "hidden text absent"); assert(K.renderSvg(pcb, { showHiddenText: true }).includes('<g opacity="0.5">'), "showHiddenText draws it dimmed");
    assert(s.includes(">1<") && s.includes(">GND<")); assert(!K.renderSvg(pcb, { padNumbers: false }).includes(">1<"));
    assert(K.renderSvg(pcb, { hidden: new Set(["F.Cu"]) }).indexOf('stroke="#C83434"') < 0);
    // SVG path builder: canvas arc semantics (line to the arc start, sweep direction, full circles)
    const p = new K.SvgPath(); p.moveTo(0, 0); p.arc(5, 0, 2, Math.PI, 0, false); assert.strictEqual(p.d, "M0 0L3 0A2 2 0 0 1 7 0");
    const q = new K.SvgPath(); q.arc(0, 0, 1, 0, Math.PI * 2, false); assert.strictEqual(q.d, "M1 0A1 1 0 1 1 -1 0A1 1 0 1 1 1 0");
    const r = new K.SvgPath(); r.arc(0, 0, 1, 0, -Math.PI / 2, true); assert.strictEqual(r.d, "M1 0A1 1 0 0 0 0 -1");
  } finally { if (prevImage) globalThis.Image = prevImage; }
});
testAsync("renderPng: offscreen raster at the dpi, area and options of renderSvg", async () => {
  const doc = K.parseDoc(NET_HEAD + '(segment (start 0 0) (end 20 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1")) (gr_line (start 0 -5) (end 30 -5) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1")) (gr_line (start 0 5) (end 30 5) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e2")))');
  const made = []; const prev = K.createCanvas;
  K.createCanvas = (w, h) => { const c = { width: w, height: h, ctx: fullCtx(w, h) }; c.getContext = () => c.ctx; c.convertToBlob = (o) => Promise.resolve({ type: o.type, size: w * h }); made.push(c); return c; };
  try {
    const blob = await K.renderPng(doc, {});
    assert.strictEqual(blob.type, "image/png"); const c = made[0];
    // the board bbox (edge lines + the track, stroke widths included) + 1 mm margin at 300 dpi
    const bb = doc.bbox, s = 300 / 25.4; near(bb[0], -0.25, 1e-9); near(bb[2], 30.05, 1e-9);
    assert.strictEqual(c.width, Math.ceil((bb[2] - bb[0] + 2) * s)); assert.strictEqual(c.height, Math.ceil((bb[3] - bb[1] + 2) * s));
    assert(c.ctx.ops.some((o) => o.op === "stroke" && o.stroke === "#C83434")); assert.strictEqual(c.ctx.ops[0].fill, "#001023"); assert(!c.ctx.calls.rect, "no grid");
    const tf = c.ctx.transforms[1]; near(tf[0], s, 1e-9); near(tf[3], s, 1e-9); near(tf[4], -(bb[0] - 1) * s, 1e-6, "1 mm = dpi/25.4 px, origin at the area corner"); near(tf[5], -(bb[1] - 1) * s, 1e-6);
    const b2 = await K.renderPng(doc, { dpi: 100, ids: ["s1"], background: false, margin: 0 }); const c2 = made[1];
    assert.strictEqual(c2.width, Math.ceil(20.5 * 100 / 25.4)); assert.strictEqual(c2.height, Math.ceil(0.5 * 100 / 25.4)); assert(!c2.ctx.ops.some((o) => o.op === "fillRect")); assert.strictEqual(b2.size, c2.width * c2.height);
    await K.renderPng(doc, { bbox: [0, 0, 10, 10], dpi: 50, flip: true, markers: [{ x: 1, y: 1, severity: "error" }] }); const c3 = made[2]; assert.strictEqual(c3.width, Math.ceil(10 * 50 / 25.4)); assert(c3.ctx.transforms[1][0] < 0, "display options pass through"); assert(c3.ctx.ops.some((o) => o.fill === K.MARKER_COLORS.pcb.error));
    await K.renderPng(doc, { dpi: 100000 }).then(() => assert.fail("should reject"), (e) => assert(/exceeds/.test(e.message)));
    K.createCanvas = () => null; await K.renderPng(doc, {}).then(() => assert.fail("should reject"), (e) => assert(/no canvas/.test(e.message)));
  } finally { K.createCanvas = prev; }
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
  test("render loop stays inside a frame budget on the board sample (stub context, all options that cost anything)", () => {
    const ctx = stubCtx(1600, 1200); const view = fitView(pcb, 1600, 1200);
    const opts = { grid: 1.27, netNames: true, zoneFill: true, markers: [{ x: 150, y: 100, severity: "error" }], ratsnest: [{ net: 1, a: [150, 100], b: [160, 110] }] };
    K.render(pcb, ctx, view, opts);
    const N = 10; const t0 = process.hrtime.bigint(); for (let i = 0; i < N; i++) K.render(pcb, ctx, view, opts); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    assert(ms < 16, "render loop " + ms.toFixed(2) + " ms/frame");
    const svg = K.renderSvg(pcb, {}); assert(svg.length > 100000 && svg.includes("<svg") && svg.endsWith("</svg>"), "board SVG export");
    assert(K.padAt(pcb, 150, 100) === null || K.padAt(pcb, 150, 100).item.kind === "footprint");
  });
  test("edits rebuild geometry: moveItem and applyChange", () => {
    const it = sch.items.get("090d21fc-658e-4e52-ac1d-2a96842b3b13"); const before = it.geom[0];
    const ch = K.moveItem(sch, it, 300, 70, 10000); assert.strictEqual(ch.kind, "MODIFIED"); assert.notStrictEqual(it.geom[0], before); near(it.geom.find((g) => g.t === "poly").pts[0][0], 300, 1e-6);
    K.moveItem(sch, it, 347.98, 72.39, 10000);
    assert(K.applyChange(sch, { id: it.id, kind: "MODIFIED", properties: [{ name: "Position X", after: { v: 3479800 } }] }, 10000));
  });
}


// An item kind the reader does not know is not merely unrendered: addItem() returns null,
// so a peer's op for it is dropped with no error and the two views diverge for good.
test("every item token either editor writes is carried, even without geometry", () => {
  const schDoc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (paper "A4")
    (ellipse (center 10 10) (radius 5 3) (stroke (width 0) (type default)) (fill (type none)) (uuid "e-1"))
    (ellipse_arc (center 20 20) (radius 5 3) (start 25 20) (end 20 23) (stroke (width 0) (type default)) (fill (type none)) (uuid "e-2"))
    (net_chain "PWR" (members "a") (uuid "n-1")))`, "kicad_sch");
  assert.deepStrictEqual([...schDoc.items.keys()].sort(), ["e-1", "e-2", "n-1"]);
  const pcbDoc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal))
    (gr_ellipse (center 1 1) (radius 2 1) (stroke (width 0.1) (type default)) (fill no) (layer "F.Cu") (uuid "ge-1"))
    (gr_ellipse_arc (center 3 3) (radius 2 1) (start 5 3) (end 3 4) (stroke (width 0.1) (type default)) (layer "F.Cu") (uuid "ge-2"))
    (barcode (at 5 5) (kind qrcode) (text "hi") (layer "F.SilkS") (uuid "bc-1"))
    (point (at 7 7) (layer "F.Cu") (uuid "pt-1"))
    (grid_item (at 9 9) (layer "F.Cu") (uuid "gi-1")))`, "kicad_pcb");
  assert.deepStrictEqual([...pcbDoc.items.keys()].sort(), ["bc-1", "ge-1", "ge-2", "gi-1", "pt-1"]);
  // and an op for one of them lands
  assert(K.applyChange(pcbDoc, { id: "bc-1", kind: "REMOVED" }, 1e6));
  assert(!pcbDoc.items.has("bc-1"));
});

// SCH_IO_KICAD_SEXPR::saveRuleArea prints "(rule_area " and hands the item to saveShape, which
// writes the uuid inside the nested (polyline …).  Keyed by a synthetic id, every op for it misses.
test("a rule area is keyed by the uuid inside its polyline, not a synthetic id", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (paper "A4")
    (rule_area (polyline (pts (xy 10 10) (xy 30 10) (xy 30 20) (xy 10 20) (xy 10 10))
      (stroke (width 0) (type default)) (fill (type none)) (uuid "ra-uuid")))
    )`, "kicad_sch");
  assert.deepStrictEqual([...doc.items.keys()], ["ra-uuid"]);
  assert(K.applyChange(doc, { id: "ra-uuid", kind: "REMOVED" }, 10000), "a desktop delete matches");
  assert.strictEqual(doc.items.size, 0);
});

Promise.all(PENDING).then(() => {
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
