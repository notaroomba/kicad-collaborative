// sch-items.test.js — eeschema's item property dialogs over s-expression nodes (web/dialogs/sch-items-logic.ts):
// text effects, the fields grid rows, label spin / shape / pin length, strokes, fills, junctions, the Properties
// dispatch (SCH_EDIT_TOOL::Properties), the field dialog titles and the pin options of Symbol Properties.
// Run: node server/static/tests/sch-items.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/sch-items-logic.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const S = (n) => K.serialize(n);
console.log("eeschema item dialogs under node");

test("text effects: read defaults, write face / size / bold / italic / colour / justify / href in KiCad's order", () => {
  const n = K.parse(`(text "hi" (exclude_from_sim no) (at 10 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t"))`);
  const fx = L.readFx(n);
  assert.deepStrictEqual([fx.font, fx.size, fx.bold, fx.italic, fx.color, fx.h, fx.v], ["KiCad Font", 1.27, false, false, null, "left", "bottom"]);
  L.writeFx(n, { font: "Arial", size: 2, bold: true, italic: true, color: [255, 0, 0, 1], h: "right", v: "top", href: "https://kicad.org" });
  assert.strictEqual(S(K.kid(n, "effects")), '(effects (font (face "Arial") (size 2 2) (bold yes) (italic yes) (color 255 0 0 1)) (justify right top) (href "https://kicad.org"))');
  L.writeFx(n, { font: "KiCad Font", bold: false, color: null, h: "center", v: "center", href: "" });
  assert.strictEqual(S(K.kid(n, "effects")), "(effects (font (size 2 2) (italic yes)))");
  assert.strictEqual(S(K.kid(n, "uuid")), '(uuid "t")', "other children untouched");
});
test("field rows: offsets from the parent, mandatory flags, visibility / show_name / autoplace", () => {
  const n = K.parse(`(global_label "VCC" (shape input) (at 100 50 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 110 50 0) (hide yes) (effects (font (size 1.27 1.27)) (justify left)))
    (property "MPN" "X" (at 101 52 90) (show_name yes) (do_not_autoplace yes) (effects (font (size 1 1) bold))))`);
  const rows = L.fieldRows(n, [100, 50], ["Intersheetrefs"]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual([rows[0].name, rows[0].mandatory, rows[0].show, rows[0].x, rows[0].y], ["Intersheetrefs", true, false, 10, 0]);
  assert.deepStrictEqual([rows[1].name, rows[1].show, rows[1].showName, rows[1].autoplace, rows[1].orient, rows[1].bold, rows[1].size, rows[1].x, rows[1].y], ["MPN", true, true, false, 90, true, 1, 1, 2]);
});
test("writeFields keeps the property block in place and the other children in order; a new row is added", () => {
  const n = K.parse(`(label "A" (at 10 10 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l") (property "X" "1" (at 10 12 0) (effects (font (size 1.27 1.27)))))`);
  const rows = L.fieldRows(n, [10, 10]); rows[0].value = "2"; rows.push(Object.assign(L.newRow("Y", [10, 10]), { value: "v", x: 1, y: 3 }));
  L.writeFields(n, rows, [10, 10]);
  assert.deepStrictEqual(n.filter(Array.isArray).map((c) => c[0]), ["at", "fields_autoplaced", "effects", "uuid", "property", "property"]);
  assert.strictEqual(L.fieldValue(K.kids(n, "property")[0]), "2");
  const y = K.kids(n, "property")[1]; assert.deepStrictEqual(K.kid(y, "at").slice(1), [11, 13, 0]);
});
test("tidyRows and the duplicate name check (DIALOG_LABEL_PROPERTIES / FIELDS_GRID_TABLE)", () => {
  const r = (name, value) => Object.assign(L.newRow(name, [0, 0]), { value });
  const out = L.tidyRows([r("", ""), r("", "text"), r("Netclass", ""), r("Netclass", "DIFF")]);
  assert.deepStrictEqual(out.map((x) => x.name + "=" + x.value), ["untitled=text", "Netclass=DIFF"]);
  assert.strictEqual(L.duplicateFieldName([r("A", "1"), r("A", "2")]), "Field name 'A' already in use.");
  assert.strictEqual(L.duplicateFieldName([r("A", "1"), r("B", "2")]), null);
});
test("labels: title per type, shape sets, spin with its justification, pin length of a directive label", () => {
  assert.strictEqual(L.labelTitle("hierarchical_label"), "Hierarchical Label Properties");
  assert.strictEqual(L.labelTitle("netclass_flag"), "Directive Label Properties");
  assert.deepStrictEqual(L.labelShapes("global_label").map((s) => s[1]), ["Input", "Output", "Bidirectional", "Tri-state", "Passive"]);
  assert.deepStrictEqual(L.labelShapes("netclass_flag").map((s) => s[1]), ["Dot", "Circle", "Diamond", "Rectangle"]);
  assert.deepStrictEqual(L.labelShapes("label"), []);
  const g = K.parse(`(global_label "VCC" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g"))`);
  const st = L.readLabel("global_label", g);
  L.writeLabel("global_label", g, Object.assign({}, st, { text: "VDD", shape: "passive", spin: 2, bold: true }));
  assert.strictEqual(S(g), '(global_label "VDD" (shape passive) (at 10 10 180) (effects (font (size 1.27 1.27) (bold yes)) (justify right)) (uuid "g"))');
  const l = K.parse(`(label "A" (at 0 0 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l"))`);
  L.setSpin("label", l, 1); assert.strictEqual(S(K.kid(l, "at")), "(at 0 0 90)"); assert.strictEqual(S(K.kid(K.kid(l, "effects"), "justify")), "(justify left bottom)");
  L.setSpin("label", l, 3); assert.strictEqual(S(K.kid(K.kid(l, "effects"), "justify")), "(justify right bottom)");
  const d = K.parse(`(netclass_flag "" (length 2.54) (shape round) (at 5 5 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "d"))`);
  const ds = L.readLabel("netclass_flag", d); assert.strictEqual(ds.size, 2.54);
  L.writeLabel("netclass_flag", d, Object.assign({}, ds, { size: 5.08, shape: "diamond" }));
  assert.strictEqual(S(K.kid(d, "length")), "(length 5.08)"); assert.strictEqual(S(K.kid(d, "shape")), "(shape diamond)"); assert.strictEqual(d[1], "");
});
test("multiple label input: one label per non-empty line", () => {
  assert.deepStrictEqual(L.labelLines("A\n\n B \r\nC", true), ["A", "B", "C"]);
  assert.deepStrictEqual(L.labelLines(" A ", false), ["A"]);
});
test("strokes, fills and junctions", () => {
  const w = K.parse(`(wire (pts (xy 0 0) (xy 1 0)) (stroke (width 0) (type default)) (uuid "w"))`);
  L.writeStroke(w, { width: 0.25, style: "dash_dot", color: [0, 0, 255, 1] });
  assert.strictEqual(S(K.kid(w, "stroke")), "(stroke (width 0.25) (type dash_dot) (color 0 0 255 1))");
  assert.deepStrictEqual(L.readStroke(w), { width: 0.25, style: "dash_dot", color: [0, 0, 255, 1] });
  const r = K.parse(`(rectangle (start 0 0) (end 1 1) (stroke (width 0) (type default)) (fill (type none)) (uuid "r"))`);
  L.writeFill(r, "solid", [10, 20, 30, 0.5]); assert.strictEqual(S(K.kid(r, "fill")), "(fill (type color) (color 10 20 30 0.5))");
  assert.deepStrictEqual(L.readFill(r), { mode: "solid", color: [10, 20, 30, 0.5] });
  L.writeFill(r, "cross_hatch", null); assert.strictEqual(L.readFill(r).mode, "cross_hatch");
  L.writeFill(r, "none", null); assert.strictEqual(S(K.kid(r, "fill")), "(fill (type none))");
  const j = K.parse(`(junction (at 1 1) (diameter 0) (color 0 0 0 0) (uuid "j"))`);
  L.writeJunction(j, { diameter: 1.016, color: [255, 0, 0, 1] }); assert.strictEqual(S(j), '(junction (at 1 1) (diameter 1.016) (color 255 0 0 1) (uuid "j"))');
  assert.strictEqual(L.common([1, 1]), 1); assert.strictEqual(L.common([1, 2]), undefined);
});
test("SCH_EDIT_TOOL::Properties dispatch", () => {
  const t = (...kinds) => L.propertiesTarget(kinds.map((k, i) => ({ id: "i" + i, kind: k }))).dialog;
  assert.strictEqual(t(), "none"); assert.strictEqual(t("polyline", "polyline"), "lines"); assert.strictEqual(t("junction", "junction"), "junctions");
  assert.strictEqual(t("wire", "bus", "junction", "bus_entry"), "wires"); assert.strictEqual(t("wire", "label"), "mixed");
  assert.strictEqual(t("no_connect"), "none"); assert.strictEqual(t("pin"), "promote"); assert.strictEqual(t("label"), "item"); assert.strictEqual(t("wire"), "wires");
});
test("field dialog titles and hyperlinks", () => {
  assert.strictEqual(L.fieldDialogTitle("Reference", "symbol"), "Edit Reference Designator Field");
  assert.strictEqual(L.fieldDialogTitle("Footprint", "symbol"), "Edit Footprint Field");
  assert.strictEqual(L.fieldDialogTitle("MPN", "symbol"), "Edit 'MPN' Field");
  assert.ok(L.validHyperlink("") && L.validHyperlink("#2") && L.validHyperlink("https://kicad.org") && L.validHyperlink("file:///x"));
  assert.ok(!L.validHyperlink("kicad.org"));
});
test("symbol pin options: pin text visibility on the library copy, alternates on the instance", () => {
  const lib = K.parse(`(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (in_bom yes) (symbol "R_1_1"))`);
  L.setPinVisibility(lib, "pin_numbers", true); L.setPinVisibility(lib, "pin_names", false);
  assert.strictEqual(S(lib), '(symbol "Device:R" (pin_names (offset 0) (hide yes)) (in_bom yes) (symbol "R_1_1"))');
  const n = K.parse(`(symbol (lib_id "X:U") (at 0 0 0) (uuid "s") (pin "1" (uuid "p1")) (instances (project "p" (path "/a" (reference "U1") (unit 1)))))`);
  L.setPinAlternate(n, "1", "GPIO"); assert.strictEqual(S(K.kids(n, "pin")[0]), '(pin "1" (uuid "p1") (alternate "GPIO"))');
  L.setPinAlternate(n, "1", ""); assert.strictEqual(S(K.kids(n, "pin")[0]), '(pin "1" (uuid "p1"))');
  L.setPinAlternate(n, "7", "SDA"); assert.deepStrictEqual(n.filter(Array.isArray).map((c) => c[0]), ["lib_id", "at", "uuid", "pin", "pin", "instances"]);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
