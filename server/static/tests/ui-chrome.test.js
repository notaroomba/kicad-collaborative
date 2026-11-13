// ui-chrome.test.js — the frame chrome ported from KiCad: MessageTextFromValue (status bar, grid menu), the zoom
// list stepping of COMMON_TOOLS::doZoomInOut and ZoomToFit's margins, and the schematic message panel
// (SCH_*::GetMsgPanelInfo).  Run: node server/static/tests/ui-chrome.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const U = load(["units.ts"]), Z = load(["editor", "zoomlist.ts"]);
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

test("MessageTextFromValue: board long form, schematic short form (one trailing mm zero dropped)", () => {
  assert.equal(U.messageText(101.6, "mm", "pcb", false), "101.6000");
  assert.equal(U.messageText(101.6, "mm", "sch", false), "101.60");
  assert.equal(U.messageText(1.27, "mm", "sch", false), "1.27");
  assert.equal(U.messageText(113.592, "mm", "sch", false), "113.592");
  assert.equal(U.messageText(1.27, "mil", "sch", false), "50");
  assert.equal(U.messageText(1.27, "mil", "pcb", false), "50.00");
  assert.equal(U.messageText(101.6, "in", "sch", false), "4.000");
  assert.equal(U.messageText(101.6, "in", "pcb", false), "4.0000");
  assert.equal(U.messageText(0, "mm", "sch", false), "0.00");
  assert.equal(U.messageText(-1e-9, "mm", "pcb", false), "0.0000");                  // below one IU: zero, never "-0"
  assert.equal(U.messageText(0.0002, "mm", "sch", false), "2.000e-04");              // a non-zero value that prints as zeros
  assert.equal(U.messageText(1.27, "mm", "sch", true), "1.27 mm");
  assert.equal(U.unitsMsg("in"), "inches"); assert.equal(U.unitsMsg("mil"), "mils"); assert.equal(U.unitsMsg("mm"), "mm");
});

test("GRID::MessageText and GRID_MENU labels", () => {
  assert.equal(U.gridMessageText(1.27, 1.27, "mm", "sch", false), "1.27");
  assert.equal(U.gridMessageText(1.27, 2.54, "mil", "sch", false), "50 x 100");
  assert.equal(U.gridChoiceText({ mm: 1.27 }, "mil", "mil", "sch"), "50 mils (1.27 mm)");
  assert.equal(U.gridChoiceText({ mm: 0.25 }, "mm", "mil", "pcb"), "0.2500 mm (9.84 mils)");
  assert.equal(U.gridChoiceText({ mm: 0.25, name: "Fine" }, "mm", "in", "pcb"), "Fine: 0.2500 mm (0.0098 in)");
});

test("doZoomInOut: at least 1.3x, then the next zoom-list entry; pegged at the ends", () => {
  const L = Z.ZOOM_LIST.sch;
  assert.equal(Z.nextZoomPreset(L, 1.0, true), 1.5);
  assert.equal(Z.nextZoomPreset(L, 0.97, true), 1.5);    // 1.261 → 1.5
  assert.equal(Z.nextZoomPreset(L, 1.5, false), 1.0);
  assert.equal(Z.nextZoomPreset(L, 100, true), 100);
  assert.equal(Z.nextZoomPreset(L, 0.05, false), 0.05);
  assert.equal(Z.nextZoomPreset(Z.ZOOM_LIST.pcb, 1.0, true), 1.5);
  assert.ok(Math.abs(Z.fitMargin(900, false) - 1 / 1.04) < 1e-12);
  assert.ok(Math.abs(Z.fitMargin(700, false) - 1 / 1.10) < 1e-12);
  assert.ok(Math.abs(Z.fitMargin(900, true) - 1 / 1.48) < 1e-12);
});

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "root-uuid") (paper "A4")
  (lib_symbols
    (symbol "Dev:U" (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 6.35 0) (effects (font (size 1.27 1.27))))
      (property "Value" "U" (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
      (property "ki_keywords" "logic gate" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "U_1_1" (pin input inverted (at -7.62 2.54 0) (length 2.54) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
      (symbol "U_2_1" (pin output line (at 7.62 2.54 180) (length 2.54) (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Dev:U") (at 50.8 50.8 0) (unit 1) (exclude_from_sim no) (in_bom no) (on_board yes) (dnp yes) (uuid "u1")
    (property "Reference" "U1" (at 50.8 44.45 0) (effects (font (size 1.27 1.27))))
    (property "Value" "7400" (at 50.8 57.15 0) (effects (font (size 1.524 1.524) bold) (justify left)))
    (property "Footprint" "" (at 50.8 57.15 0) (effects (font (size 1.27 1.27)) hide))
    (property "Description" "Quad NAND" (at 50.8 57.15 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "p1"))
    (instances (project "t" (path "/root-uuid" (reference "U1") (unit 1)))))
  (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "w1"))
  (polyline (pts (xy 10 30) (xy 20 30)) (stroke (width 0.254) (type dash)) (uuid "g1"))
  (junction (at 20 10) (diameter 0) (color 0 0 0 0) (uuid "j1"))
  (label "SDA" (at 20 10 180) (effects (font (size 1.27 1.27)) (justify right bottom)) (uuid "l1"))
  (global_label "CLK" (shape output) (at 30 10 0) (effects (font (size 1.27 1.27) italic) (justify left)) (uuid "gl1"))
  (text "Hello" (exclude_from_sim yes) (at 40 40 0) (effects (font (size 2 2)) (justify left)) (uuid "t1"))
  (rectangle (start 60 60) (end 70 65) (stroke (width 0.1) (type solid)) (fill (type none)) (uuid "r1"))
  (no_connect (at 5 5) (uuid "nc1"))
)`;

test("SCH_*::GetMsgPanelInfo", () => {
  const doc = K.parseDoc(SHEET, "kicad_sch");
  const o = { units: "mm", sheetPath: "/", connection: (it) => (it.kind === "wire" || it.kind === "label" || it.kind === "junction" ? { name: "/SDA", bus: false, netclass: "Default" } : null) };
  const rows = (sel) => sch.msgPanelInfo(doc, sel, o).map((r) => r.title + "=" + r.value);
  assert.deepEqual(rows({ id: "u1" }), ["Reference=U1", "Value=7400", "Exclude from=BOM, DNP", "Name=U", "Library=Dev", "Footprint=<Unknown>", "Description: Quad NAND=Keywords: logic gate"]);
  assert.deepEqual(rows({ id: "w1" }), ["Line Type=Wire", "Line Style=from netclass", "Connection Name=/SDA", "Resolved Netclass=Default"]);
  assert.deepEqual(rows({ id: "g1" }), ["Line Type=Graphical", "Line Style=Dashed"]);
  assert.deepEqual(rows({ id: "j1" }), ["Junction=", "Size=0.914 mm", "Connection Name=/SDA", "Resolved Netclass=Default"]);
  assert.deepEqual(rows({ id: "l1" }), ["Label=SDA", "Font=Default", "Style=Normal", "Text Size=1.27 mm", "Justification=Align right", "Connection Name=/SDA", "Resolved Netclass=Default"]);
  assert.deepEqual(rows({ id: "gl1" }), ["Global Label=CLK", "Type=Output", "Font=Default", "Style=Italic", "Text Size=1.27 mm", "Justification=Align left"]);
  assert.deepEqual(rows({ id: "t1" }), ["Text=Hello", "Exclude from=Simulation", "Font=Default", "Style=Normal", "Text Size=2.00 mm", "Justification=Align left"]);
  assert.deepEqual(rows({ id: "r1" }), ["Shape=Rectangle", "Width=10.00 mm", "Height=5.00 mm", "Line Style=Solid", "Line Width=0.10 mm"]);
  assert.deepEqual(rows({ id: "nc1" }), []);
  assert.deepEqual(rows({ id: "u1", pin: "1" }), ["Type=Pin", "Unit=A", "Name=IN", "Number=1", "Type=Input", "Style=Inverted", "Visible=Yes", "Length=2.54 mm", "Orientation=Right", "U1=7400"]);
  assert.deepEqual(rows({ id: "u1", field: "Value" }), ["Symbol Field=Value", "Text=7400", "Visible=Yes", "Font=Default", "Style=Bold", "Text Size=1.524 mm", "H Justification=Left", "V Justification=Center"]);
  assert.equal(sch.msgPanelInfo(doc, { id: "w1" }, Object.assign({}, o, { units: "mil" })).length, 4);
});

test("KICURSOR bitmaps: every cursors_defs entry, 32 px PNGs, cursors.cpp hotspots", () => {
  const { KICURSOR_IMAGES } = load(["editor", "kicursors.generated.ts"]);
  const want = { LINE_WIRE: [5, 26], LINE_BUS: [5, 26], LINE_GRAPHIC: [5, 26], PENCIL: [4, 27], MOVING: [1, 1], PLACE: [1, 1], TEXT: [7, 7], LABEL_NET: [7, 7], LABEL_GLOBAL: [7, 7], LABEL_HIER: [7, 7], COMPONENT: [7, 7], REMOVE: [4, 4], MEASURE: [4, 4], ZOOM_IN: [6, 6], ZOOM_OUT: [6, 6], ADD: [7, 7], SUBTRACT: [7, 7], XOR: [7, 7], SELECT_WINDOW: [7, 10], SELECT_LASSO: [7, 7], TUNE: [1, 30], VOLTAGE_PROBE: [1, 31], CURRENT_PROBE: [4, 27], WARNING: [1, 1] };
  for (const [k, hot] of Object.entries(want)) {
    const e = KICURSOR_IMAGES[k]; assert.ok(e, k);
    assert.deepEqual([e[1], e[2]], hot, k);
    const png = Buffer.from(e[0].split(",")[1], "base64");
    assert.equal(png.readUInt32BE(16), 32, k); assert.equal(png.readUInt32BE(20), 32, k);
  }
});

test("hypertext: EDA_TEXT link definition (text and text box only), goto-page hrefs", () => {
  const H = load(["editor", "hypertext.ts"]);
  const it = { id: "t1", kind: "text", node: K.parse('(text "Site" (at 1 2 0) (effects (font (size 1.27 1.27)) (href "https://kicad.org")) (uuid "t1"))') };
  assert.equal(H.hrefOf(it), "https://kicad.org");
  assert.equal(H.hrefOf({ id: "t2", kind: "text", node: K.parse('(text "x" (at 1 2 0) (effects (font (size 1.27 1.27))))') }), "");
  assert.equal(H.hrefOf({ id: "l", kind: "label", node: K.parse('(label "x" (at 1 2 0) (effects (font (size 1.27 1.27)) (href "#2")))') }), "");
  assert.equal(H.gotoPageOf("#12"), "12");
  assert.equal(H.gotoPageOf("https://x"), null);
});

test("dialog geometry: a remembered place and size come back clamped to the window", () => {
  const S = load(["tools", "kicad-dialogs", "shell.ts"]);
  assert.deepEqual(S.clampGeometry({ left: 100, top: 50, width: 500, height: 300 }, 1440, 900), { left: 100, top: 50, width: 500, height: 300 });
  assert.deepEqual(S.clampGeometry({ left: 1300, top: 800, width: 500, height: 300 }, 1440, 900), { left: 940, top: 600, width: 500, height: 300 });
  assert.deepEqual(S.clampGeometry({ left: -20, top: -5, width: 2000, height: 1200 }, 1440, 900), { left: 0, top: 0, width: 1440, height: 900 });
});

test("ORIGIN_TRANSFORMS: the board status bar from the user origin, axes inverted", () => {
  assert.deepEqual(U.toDisplayAbs([149, 83.25], [10, 20], false, true), [139, -63.25]);
  assert.deepEqual(U.toDisplayAbs([149, 83.25], [0, 0], true, false), [-149, 83.25]);
  assert.deepEqual(U.toDisplayRel([2, -3], true, true), [-2, 3]);
});

console.log(`\nui-chrome: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
