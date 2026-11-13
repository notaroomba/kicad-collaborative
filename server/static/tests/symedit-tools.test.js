// symedit-tools.test.js — Symbol Editor drawing tools and the pieces added after the first frame: ellipses and
// elliptical arcs (ELLIPSE_GEOM_MANAGER, EDA_SHAPE::rotate / flip, formatEllipse), number precision on save.
// Run: node server/static/tests/symedit-tools.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("symedit/model.ts");
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const head = (n) => M.text(n).replace(/ \(stroke.*$/, "");

(async () => {
console.log("symbol editor tools under node");
await test("FormatAngle is {:.10g}", () => {
  assert.strictEqual(M.fmtAngle(33.690067525979785), "33.69006753");
  assert.strictEqual(M.fmtAngle(90), "90"); assert.strictEqual(M.fmtAngle(-0), "-0"); assert.strictEqual(M.fmtAngle(1e-11), "1e-11");
  assert.strictEqual(M.fmtAngle(-153.4349488), "-153.4349488"); assert.strictEqual(M.fmtAngle(0.5), "0.5");
});
await test("ellipse from a box: centre, major along the longer side, rotation 0 or 90 (calcEdit ELLIPSE)", () => {
  const w = M.ellipseFromBox([0, 0], [10.16, 5.08]);
  assert.deepStrictEqual([w.cx, w.cy, w.major, w.minor, w.rotation], [5.08, 2.54, 5.08, 2.54, 0]);
  const t = M.ellipseFromBox([0, 0], [2.54, -7.62]);
  assert.deepStrictEqual([t.cx, t.cy, t.major, t.minor, t.rotation], [1.27, -3.81, 3.81, 1.27, 90]);
  const z = M.ellipseFromBox([1, 1], [1, 1]); assert.strictEqual(z.major, 0.0001, "radii never below 1 IU");
  assert.strictEqual(head(M.ellipseNode(w, false)), "(ellipse (center 5.08 2.54) (major_radius 5.08) (minor_radius 2.54) (rotation_angle 0)");
});
await test("elliptical arc angles: internal (Y down) angle, end after start wrapped by 360", () => {
  const e = M.ellipseFromBox([-10, -5], [10, 5]);
  const a = M.ellipseArcAngles(e, [10, 0], [0, 5]);   // (0, 5) is up on screen: -90 internally, so 270
  assert.deepStrictEqual(a, { start: 0, end: 270 });
  const b = M.ellipseArcAngles(e, [0, 5]); assert.deepStrictEqual(b, { start: -90, end: 270 }, "while the end is not set the arc is whole");
  Object.assign(e, a);
  assert.strictEqual(head(M.ellipseNode(e, true)), "(ellipse_arc (center 0 0) (major_radius 10) (minor_radius 5) (rotation_angle 0) (start_angle 0) (end_angle 270)");
  const c = M.ellipseArcAngles(e, [10, 0], [10, 5]);   // atan2(-5/5, 10/10) = -45 -> 315
  assert.strictEqual(c.end, 315);
});
await test("rotate and mirror an ellipse arc as EDA_SHAPE does", () => {
  const e = Object.assign(M.ellipseFromBox([-10, -5], [10, 5]), { start: 0, end: 270 });
  const r = M.ellipseNode(e, true); M.rotateNode(r, 0, 0, true);
  assert.ok(M.text(r).includes("(rotation_angle -90) (start_angle 0) (end_angle 270)"), M.text(r));
  const r2 = M.ellipseNode(e, true); M.rotateNode(r2, 2, 0, false);
  assert.ok(M.text(r2).includes("(center 2 2)") && M.text(r2).includes("(rotation_angle -270)"), M.text(r2));
  const h = M.ellipseNode(e, true); M.mirrorNode(h, 0, 0, true);
  assert.ok(M.text(h).includes("(start_angle -90) (end_angle 180)"), M.text(h));
  const v = M.ellipseNode(e, true); M.mirrorNode(v, 0, 1, false);
  assert.ok(M.text(v).includes("(center 0 2)") && M.text(v).includes("(start_angle -270) (end_angle 0)"), M.text(v));
});
await test("a file's ten-digit angles and coordinates are written back as read", () => {
  const src = "(ellipse_arc (center 1.27 -2.54) (major_radius 3.81) (minor_radius 1.905) (rotation_angle 12.5) (start_angle 33.69006753) (end_angle 213.6900675))";
  assert.strictEqual(M.text(M.node(src)), src);
  const n = M.node("(xy 0 0)"); n[1] = 0.1 + 0.2; assert.strictEqual(M.text(n), "(xy 0.3 0)", "arithmetic noise still rounds");
});
await test("SYMBOL_IMPORT_MANAGER on 4xxx.kicad_sym: ancestors auto-included, descendants dropped with their parent", () => {
  const fs = require("fs"); const f = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "libs", "4xxx.kicad_sym");
  const lib = M.parseLibrary(fs.readFileSync(f, "utf8"));
  const m = new M.SymbolImportManager(lib, (n) => n === "4001");
  assert.strictEqual(m.names().length, 51);
  assert.deepStrictEqual([...m.ancestors("4066")], ["4016"]); assert.deepStrictEqual([...m.descendants("4538")].sort(), ["14528", "14538", "4528"]);
  m.setSelected("4066", true);
  assert.ok(m.infos.get("4066").checked && !m.infos.get("4016").checked && m.infos.get("4016").auto);
  assert.deepStrictEqual(m.toImport(), ["4016", "4066"]); assert.strictEqual(m.status(), "1 symbols selected, 1 parents auto-included");
  m.setSelected("4538", true); assert.ok(!m.infos.get("14528").checked && !m.infos.get("14528").auto, "a parent does not pull its children");
  m.setSelected("14528", true); m.setSelected("4528", true); m.deselectWithDescendants("4538");
  assert.deepStrictEqual(m.toImport(), ["4016", "4066"]);
  m.setSelected("4001", true); assert.deepStrictEqual(m.conflicts(), ["4001"]);
  m.deselectAll(); m.selectAll((n) => M.SymbolImportManager.matches(n, "453")); assert.deepStrictEqual(m.toImport(), ["14538", "4538"]); assert.strictEqual(m.status(), "2 symbols selected");
  m.selectAll(); assert.strictEqual(m.toImport().length, 51); assert.strictEqual(m.autoCount(), 0);
});
const SYM = '(symbol "X" (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) ' +
  '(symbol "X_0_1" (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none)))) ' +
  '(symbol "X_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) ' +
  '(pin output line (at 5.08 0 180) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))) (embedded_fonts no))';
await test("body styles: De Morgan copies body 1's pins, custom copies drawings too, fewer styles prune (SetBodyStyleCount)", () => {
  const s = M.node(SYM);
  M.setBodyStyles(s, "single"); assert.strictEqual(M.text(s), M.text(M.node(SYM)), "unchanged mode leaves the symbol alone");
  M.setBodyStyles(s, "demorgan"); let t = M.text(s);
  assert.ok(t.includes('(power') === false && /\(symbol "X" \(body_styles demorgan\) \(exclude_from_sim/.test(t), t.slice(0, 80));
  assert.ok(t.includes('(symbol "X_1_2" (pin input line (at -5.08 0 0)'), "pins copied to the alternate body");
  assert.ok(!t.includes('"X_0_2"'), "body-1 drawings are not copied for De Morgan");
  M.setBodyStyles(s, "custom", ["Narrow", "Wide", "Tall"]); t = M.text(s);
  assert.ok(t.includes('(body_styles "Narrow" "Wide" "Tall")'), t.slice(0, 120));
  assert.ok(t.includes('(symbol "X_0_3" (rectangle') && t.includes('(symbol "X_1_3" (pin input'), "custom styles copy drawings and pins");
  M.setBodyStyles(s, "single"); t = M.text(s);
  assert.ok(!t.includes("body_styles") && !/_\d_[23]"/.test(t), "back to one style: the others pruned");
  assert.deepStrictEqual(M.bodyStyles(s), { count: 1, demorgan: false, names: ["Standard"] });
});
await test("unit display names go into every sub-symbol of the unit; jumper groups parsed and written as KiCad does", () => {
  const s = M.node(SYM); M.setUnitCount(s, 2);
  M.setUnitNames(s, new Map([[1, "Amp"], [2, "Power"]]));
  assert.ok(M.text(s).includes('(symbol "X_1_1" (unit_name "Amp") (pin'), M.text(s)); assert.deepStrictEqual([...M.unitNames(s)], [[1, "Amp"], [2, "Power"]]);
  M.setUnitNames(s, new Map([[2, "Power"]])); assert.ok(!M.text(s).includes('"Amp"'));
  const bad = M.parseJumperGroups(["1, 7"], (n) => M.hasPinNumber(s, n)); assert.strictEqual(bad.error, "Pin '7' in jumper pin group 1 does not exist in this symbol.");
  const ok = M.parseJumperGroups(["2,1", "", "  "], (n) => M.hasPinNumber(s, n)); assert.deepStrictEqual(ok.groups, [["1", "2"]]);
  M.setJumperGroups(s, ok.groups);
  assert.ok(M.text(s).includes('(duplicate_pin_numbers_are_jumpers no) (jumper_pin_groups ("1" "2")) (property "Reference"'), M.text(s).slice(0, 260));
  assert.deepStrictEqual(M.jumperGroups(s), [["1", "2"]]);
  M.setJumperGroups(s, []); assert.ok(!M.text(s).includes("jumper_pin_groups"));
});
await test("Show Pin Alternate Icons: a pin with alternates and a shown name gets drawAltPinModesIcon's strokes, beside the name", () => {
  const L = load("canvas/libsym.ts");
  const s = M.node(SYM); const sub = s.find((c) => Array.isArray(c) && c[0] === "symbol" && c[1] === "X_1_1"); const pin = sub.find((c) => Array.isArray(c) && c[0] === "pin");
  pin.push(M.node('(alternate "SDA" bidirectional line)'));
  const count = (on) => { const d = L.parseLibSymbol(s, { showPinAltIcons: on }); let n = 0; for (const it of d.items.values()) n += it.geom.length; return n; };
  assert.strictEqual(count(true) - count(false), 7, "six strokes and the S-bend");
  const d = L.parseLibSymbol(s, {}); const g = [...d.items.values()].find((it) => it.geom.length > 0 && it.libRef && JSON.stringify(it.geom).includes('"Pin names"'));
  assert.ok(g, "drawn on the pin-name layer by default (SYMBOL_EDITOR_SETTINGS m_ShowPinAltIcons = true)");
  const s2 = M.node(SYM); assert.strictEqual(L.parseLibSymbol(s2, { showPinAltIcons: true }).items.size, L.parseLibSymbol(s2, { showPinAltIcons: false }).items.size);
});

await test("Update Symbol Fields: SyncFieldsFromParent options, field list, unselected fields kept", () => {
  const src = `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor") (generator_version "9.0")
  (symbol "P" (property "Reference" "U" (at 0 5 0) (effects (font (size 1.27 1.27)))) (property "Value" "P" (at 0 -5 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "ds" (at 0 0 0) (show_name yes) (effects (font (size 2 2) bold) (justify left)))
    (property "Description" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "MPN" "123" (at 1 2 90) (effects (font (size 1 1))))
    (property "ki_keywords" "kw" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (symbol "P_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none)))))
  (symbol "D" (extends "P") (property "Reference" "Q" (at 3 3 0) (effects (font (size 1.27 1.27)))) (property "Value" "D" (at 0 -5 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "fp" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "mine" (at 4 4 0) (hide yes) (effects (font (size 1.27 1.27)) (href "x")))
    (property "Description" "desc" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Extra" "e" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "ki_fp_filters" "SO*" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (embedded_fonts no)))`;
  const lib = M.parseLibrary(src); const d = () => M.clone(lib.symbols.get("D"));
  assert.deepStrictEqual(M.updatableFieldNames(lib, d()), ["Reference", "Value", "Footprint", "Datasheet", "Description", "Extra", "MPN"]);
  const all = new Set(M.updatableFieldNames(lib, d()));
  const o = { fields: all, removeExtra: false, resetEmpty: false, resetText: true, resetVisibility: true, resetEffects: true, resetPositions: true };
  const s = d(); assert.ok(M.syncFieldsFromParent(lib, s, o));
  const F = (n) => M.text(M.fieldOf(s, n));
  assert.strictEqual(F("Reference"), M.text(M.fieldOf(lib.symbols.get("P"), "Reference")), "every attribute reset");
  assert.strictEqual(M.fieldValue(s, "Footprint"), "fp", "empty parent text is kept unless 'Reset fields if empty'");
  assert.strictEqual(M.fieldValue(s, "Description"), "desc");
  assert.strictEqual(F("Datasheet"), '(property "Datasheet" "ds" (at 0 0 0) (show_name yes) (effects (font (size 2 2) bold) (justify left) (href "x")))', "visibility, show_name, effects, position; hyperlink kept");
  assert.strictEqual(F("MPN"), '(property "MPN" "123" (at 1 2 90) (effects (font (size 1 1))))', "missing parent field appended");
  assert.ok(M.fieldOf(s, "Extra") && M.fieldOf(s, "ki_fp_filters") && !M.fieldOf(s, "ki_keywords"), "extras kept; ki_ properties are not fields");
  const names = s.filter((c) => Array.isArray(c) && c[0] === "property").map((p) => p[1]); assert.deepStrictEqual(names.slice(-2), ["ki_fp_filters", "MPN"]);
  const r = d(); M.syncFieldsFromParent(lib, r, { ...o, removeExtra: true, resetEmpty: true });
  assert.ok(!M.fieldOf(r, "Extra")); assert.strictEqual(M.fieldValue(r, "Footprint"), ""); assert.ok(M.fieldOf(r, "ki_fp_filters"));
  const n = d(); M.syncFieldsFromParent(lib, n, { ...o, fields: new Set(["Datasheet"]), resetText: false, resetVisibility: false, resetEffects: false });
  assert.strictEqual(M.text(M.fieldOf(n, "Datasheet")), '(property "Datasheet" "mine" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27)) (href "x")))', "only the position moved");
  assert.strictEqual(M.text(M.fieldOf(n, "Reference")), M.text(M.fieldOf(lib.symbols.get("D"), "Reference")), "unselected fields untouched");
  assert.ok(!M.fieldOf(n, "MPN"));
  assert.strictEqual(M.syncFieldsFromParent(lib, M.clone(lib.symbols.get("P")), o), false, "not derived");
});

await test("pin maps: read / write as savePinMapData, logical pins with stacked numbers, ExpandStackedPinNotation, harvest", () => {
  const s = M.node(`(symbol "X" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "ki_keywords" "k" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (associated_footprints (footprint "Package_SO:SOIC-8" (map "STD-8")) (footprint "Lib:Other"))
    (pin_maps (pin_map "STD-8" (entry "1" "2") (entry "4" "[4,9]")))
    (symbol "X_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin input line (at 0 2.54 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "[3-4]" (effects (font (size 1.27 1.27))))))
    (symbol "X_2_1" (pin input line (at 0 0 0) (length 2.54) (name "C" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
    (embedded_fonts no))`);
  const d = M.pinMapData(s);
  assert.deepStrictEqual(d.maps, [{ name: "STD-8", entries: [["1", "2"], ["4", "[4,9]"]] }]);
  assert.deepStrictEqual(d.assocs, [{ fpid: "Package_SO:SOIC-8", map: "STD-8" }, { fpid: "Lib:Other", map: "" }]);
  assert.deepStrictEqual(M.logicalPinRows(s), [{ number: "1", name: "A", unit: 1 }, { number: "3", name: "B", unit: 1 }, { number: "4", name: "B", unit: 1 }]);
  assert.deepStrictEqual(M.expandStacked("[1,3-5,A1-A2]"), { pins: ["1", "3", "4", "5", "A1", "A2"], valid: true });
  assert.strictEqual(M.expandStacked("[5-3]").valid, false); assert.strictEqual(M.expandStacked("4]").valid, false); assert.strictEqual(M.expandStacked("[A1-B2]").valid, false);
  assert.deepStrictEqual(M.expandStacked("[a\\,b]"), { pins: ["a,b"], valid: true }); assert.strictEqual(M.expandStacked("[]").valid, false);
  const c = M.clone(s); M.setPinMapData(c, d.maps, d.assocs); assert.strictEqual(M.text(c), M.text(s), "round trip in place");
  const e = M.clone(s); M.setPinMapData(e, [], []); assert.ok(!/pin_maps|associated_footprints/.test(M.text(e)), "nothing written when empty");
  M.setPinMapData(e, [{ name: "m", entries: [["1", "7"]] }], []);
  const kinds = e.filter((x) => Array.isArray(x)).map((x) => x[0]); assert.deepStrictEqual(kinds.slice(0, 4), ["property", "property", "pin_maps", "symbol"], "after the fields");
  assert.ok(M.text(e).includes('(pin_maps (pin_map "m" (entry "1" "7")))'));
});

await test("sym-lib-table: parse, LIBRARY_TABLE::Format with (disabled) / (hidden), VerifyTable messages", () => {
  // PRETTIFIED_FILE_OUTPUTFORMATTER( FORMAT_MODE::LIBRARY_TABLE ): tab indent, one row per line, tokens space-separated
  const src = '(sym_lib_table\n\t(version 7)\n\t(lib (name "A") (type "KiCad") (uri "${KIPRJMOD}/A.kicad_sym") (options "") (descr "first"))\n\t(lib (name "B") (type "KiCad") (uri "${KIPRJMOD}/B.kicad_sym") (options "") (descr "") (disabled) (hidden))\n)\n';
  const rows = M.parseLibTable(src);
  assert.deepStrictEqual(rows.map((r) => [r.nickname, r.enabled, r.visible, r.descr]), [["A", true, true, "first"], ["B", false, false, ""]]);
  assert.strictEqual(M.formatLibTable(rows), src, "written as KiCad writes it");
  // a KiCad-written table (long rows past column 72 stay on one line) round-trips byte for byte
  const qa = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "qa", "data", "libraries", "sym-lib-table"), "utf8");
  assert.strictEqual(M.formatLibTable(M.parseLibTable(qa)), qa);
  const blank = { enabled: true, visible: true, nickname: "", uri: "", type: "KiCad", options: "", descr: "" };
  assert.deepStrictEqual(M.verifyLibTable([...rows, blank]).rows.length, 2, "a row without a path goes silently");
  assert.strictEqual(M.verifyLibTable([{ ...blank, uri: "x" }]).error, "Library must have a nickname.");
  assert.strictEqual(M.verifyLibTable([{ ...blank, uri: "x", nickname: "a:b" }]).error, "Illegal character ':' in nickname 'a:b'.");
  const dup = M.verifyLibTable([...rows, { ...blank, uri: "y", nickname: "A" }]); assert.strictEqual(dup.error, "Multiple libraries cannot share the same nickname ('A')."); assert.strictEqual(dup.row, 2);
});

await test("ARC_TANGENT seed: a polyline end or an arc end gives the direction the next arc leaves it with", () => {
  const sym = M.node('(symbol "T" (symbol "T_0_1" (polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (fill (type none))) (arc (start 20 0) (mid 25 5) (end 30 0) (stroke (width 0) (type default)) (fill (type none)))))');
  const n = (v) => { const l = Math.hypot(v[0], v[1]); return [Math.round(v[0] / l * 1e6) / 1e6 + 0, Math.round(v[1] / l * 1e6) / 1e6 + 0]; };
  assert.deepStrictEqual(n(M.arcTangentSeed(sym, [10, 0])), [1, 0]);
  assert.deepStrictEqual(n(M.arcTangentSeed(sym, [0, 0])), [-1, 0]);
  assert.deepStrictEqual(n(M.arcTangentSeed(sym, [30, 0])), [0, -1], "the arc comes down into its end");
  assert.deepStrictEqual(n(M.arcTangentSeed(sym, [20, 0])), [0, -1], "leaving the start backwards");
  assert.strictEqual(M.arcTangentSeed(sym, [5, 5]), null);
});
await test("Properties panel: SCH_PIN rows in internal Y-down coordinates, edits go back to the file", () => {
  const SP = load("symedit/props.ts");
  const sym = M.node('(symbol "R" (property "Reference" "R" (at 0 0 0) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "R_1_1" (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254) (type default)) (fill (type none))) (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))');
  const pin = M.allPins(sym)[0];
  const rows = SP.itemRows(sym, { node: pin.node, unit: 1, body: 1 });
  assert.deepStrictEqual(rows.map((r) => r.name), ["Pin Name", "Pin Number", "Electrical Type", "Graphic Style", "Position X", "Position Y", "Orientation", "Length", "Name Text Size", "Number Text Size", "Visible"]);
  assert.strictEqual(rows.find((r) => r.name === "Position Y").value, "-3.81", "eeschema shows Y down");
  SP.setItemProp(sym, { node: pin.node, unit: 1, body: 1 }, "Position Y", "-5.08");
  assert.match(M.text(pin.node), /\(at 0 5\.08 270\)/);
  SP.setItemProp(sym, { node: pin.node, unit: 1, body: 1 }, "Length", "2.54");   // ChangeLength keeps the body end
  assert.match(M.text(pin.node), /\(at 0 6\.35 270\) \(length 2\.54\)/);
  const rect = M.drawItems(sym).find((d) => d.node[0] === "rectangle");
  const rr = SP.itemRows(sym, { node: rect.node, unit: 1, body: 1 });
  assert.deepStrictEqual(rr.map((r) => r.name), ["Private", "Shape", "Start X", "Start Y", "End X", "End Y", "Width", "Height", "Line Width", "Line Style", "Fill Mode"]);
  assert.strictEqual(rr.find((r) => r.name === "Line Style").value, "solid", "a default stroke shows Solid");
  assert.strictEqual(rr.find((r) => r.name === "Height").value, "5.08");
  SP.setItemProp(sym, { node: rect.node, unit: 1, body: 1 }, "Fill Mode", "background");
  SP.setItemProp(sym, { node: rect.node, unit: 1, body: 1 }, "Private", "1");
  assert.match(M.text(rect.node), /^\(rectangle private .*\(fill \(type background\)\)/);
  const f = M.fieldOf(sym, "Reference");
  const fr = SP.itemRows(sym, { node: f, unit: 0, body: 0 });
  assert.ok(!fr.some((r) => r.name === "Private"), "a mandatory field has no Private");
  SP.setItemProp(sym, { node: f, unit: 0, body: 0 }, "Show Field Name", "1");
  SP.setItemProp(sym, { node: f, unit: 0, body: 0 }, "Bold", "1");
  assert.match(M.text(f), /\(show_name yes\) \(do_not_autoplace no\) \(effects \(font \(size 1\.27 1\.27\) \(bold yes\)\)\)/);
  const sr = SP.symbolRows(sym, sym);
  assert.deepStrictEqual([...new Set(sr.map((r) => r.group))], ["Fields", "Symbol Definition", "Pin Display", "Attributes", "Units and Body Styles"]);
  assert.ok(SP.setSymbolProp(sym, "Units are Interchangeable", "0")); assert.ok(M.unitsLocked(sym));
  assert.ok(SP.setSymbolProp(sym, "Exclude from Board", "1")); assert.match(M.text(sym), /\(on_board no\)/);
  const mixed = SP.sharedRows([[{ group: "G", name: "A", type: "text", value: "x" }], [{ group: "G", name: "A", type: "text", value: "y" }, { group: "G", name: "B", type: "text", value: "z" }]]);
  assert.deepStrictEqual(mixed.map((r) => [r.name, r.value, r.mixed]), [["A", "", true]]);
});
await test("canvas context menu: CONDITIONAL_MENU order, hidden entries, Zoom / Grid submenus", () => {
  const C = load("symedit/ctxmenu.ts");
  const base = { tool: "select", drawing: false, kinds: [], haveSymbol: true, editable: true, alias: false, canConvertStacked: false, canExplodeStacked: false };
  assert.deepStrictEqual(C.symCanvasMenu(base), ["paste", "-", "symbolProperties", "pinTable", "-", "selectAll", "unselectAll", "-", "zoomMenu", "gridMenu"]);
  assert.deepStrictEqual(C.symCanvasMenu({ ...base, kinds: ["pin"], canExplodeStacked: true }), ["move", "alignToGrid", "-", "rotateCCW", "rotateCW", "mirrorV", "mirrorH", "properties", "-", "explodeStackedPin", "-",
    "pushPinLength", "pushPinNameSize", "pushPinNumSize", "-", "cut", "copy", "copyAsText", "paste", "duplicate", "doDelete", "-", "selectAll", "unselectAll", "-", "zoomMenu", "gridMenu"]);
  const two = C.symCanvasMenu({ ...base, kinds: ["rectangle", "circle"] });
  assert.ok(two.includes("swap") && !two.includes("properties") && !two.includes("copyAsText"));
  assert.deepStrictEqual(C.symCanvasMenu({ ...base, tool: "draw", drawing: true, kinds: [] }), ["cancelInteractive", "-", "finishInteractive", "-", "zoomMenu", "gridMenu"]);
  assert.deepStrictEqual(C.symCanvasMenu({ ...base, tool: "zoom" }), ["cancelInteractive", "-", "zoomMenu", "gridMenu"]);
  assert.ok(!C.symCanvasMenu({ ...base, editable: false, kinds: ["pin"] }).includes("move"), "a read-only symbol has no Move");
});
await test("Align to Grid, Swap, Convert / Explode Stacked Pins", () => {
  const sym = M.node('(symbol "U" (symbol "U_1_1" (rectangle (start -2.6 2.6) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none))) (pin input line (at -5.1 1.3 0) (length 2.6) (name "A" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27))))) (pin input line (at -5.1 1.3 0) (length 2.6) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin input line (at -5.1 1.3 0) (length 2.6) (name "A" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))) (pin output line (at 5.08 0 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27)))))))');
  const items = M.drawItems(sym).map((d) => d.node);
  assert.ok(M.alignToGrid(items[0], 1.27)); assert.match(M.text(items[0]), /\(start -2\.54 2\.54\) \(end 2\.6 -2\.6\)/, "the shape moves, its size stays");
  M.alignToGrid(items[1], 1.27); assert.match(M.text(items[1]), /\(at -5\.08 1\.27 0\) \(length 2\.54\)/);
  assert.strictEqual(M.stackedNotation(["1", "2", "3", "5", "7", "8", "A1", "X"]), "[1-3,5,7,8,A1,X]");
  assert.strictEqual(M.convertStackedPins(sym, [items[3]]), "At least two pins are needed to convert to stacked pins");
  const cand = M.stackCandidates(sym, [items[2]]); assert.strictEqual(cand.length, 2, "pins at the selected pin's position");
  assert.strictEqual(M.convertStackedPins(sym, [items[1], items[2], items[3]]), "All pins must be at the same location");
  M.alignToGrid(items[2], 1.27); M.alignToGrid(items[3], 1.27);
  assert.strictEqual(M.convertStackedPins(sym, [items[1], items[2], items[3]]), null);
  assert.deepStrictEqual(M.allPins(sym).map((d) => M.pinInfo(d.node).number), ["[1-3]", "4"]);
  const ex = M.explodeStackedPin(sym, M.allPins(sym)[0].node); assert.strictEqual(ex.length, 3);
  assert.deepStrictEqual(M.allPins(sym).map((d) => [M.pinInfo(d.node).number, M.pinInfo(d.node).visible]), [["1", true], ["4", true], ["2", false], ["3", false]]);
  const a = M.allPins(sym)[0].node, b = M.allPins(sym)[1].node; M.swapItems([a, b]);
  assert.match(M.text(a), /\(at 5\.08 0 180\)/); assert.match(M.text(b), /\(at -5\.08 1\.27 0\)/);
});
await test("library tree menu: symbol_editor_control.cpp order and conditions, pin / hide library tree", () => {
  const C = load("symedit/ctxmenu.ts");
  const lib = C.symTreeMenu({ libSelected: true, libInferred: true, symbolSelected: false, derived: false, allPinned: false, allUnpinned: true });
  assert.deepStrictEqual(lib, ["pinLibrary", "-", "newSymbol", "-", "save", "saveLibraryAs", "revert", "-", "importSymbol", "-", "pasteSymbol", "-", "hideLibraryTree"]);
  const sym = C.symTreeMenu({ libSelected: false, libInferred: true, symbolSelected: true, derived: true, allPinned: true, allUnpinned: true });
  assert.deepStrictEqual(sym.slice(3), ["newSymbol", "deriveFromExistingSymbol", "-", "save", "saveSymbolAs", "saveSymbolCopyAs", "revert", "-", "importSymbol", "exportSymbol", "-",
    "cutSymbol", "copySymbol", "pasteSymbol", "duplicateSymbol", "deleteSymbol", "-", "renameSymbol", "symbolProperties", "flattenSymbol", "-", "hideLibraryTree"]);
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();

test("Library Symbol Properties: Derive from symbol choices leave out the symbol and its descendants", () => {
  const src = '(kicad_symbol_lib (version 20241209) (generator "t") (symbol "A") (symbol "B" (extends "A")) (symbol "C" (extends "B")) (symbol "D") (symbol "E" (extends "D")))';
  const lib = M.parseLibrary(src);
  assert.deepStrictEqual(M.parentChoices(lib, "B"), ["A", "D", "E"]);
  assert.deepStrictEqual(M.parentChoices(lib, "E"), ["A", "B", "C", "D"]);
  const e = M.clone(lib.symbols.get("E")); M.setParentName(e, "A"); assert.strictEqual(M.parentNameOf(e), "A");
});
