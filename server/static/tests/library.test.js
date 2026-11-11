// library.test.js — the library module's document logic (server/web/library/core.ts, bundled on
// the fly) under node: flattening, the embedded copy, a new symbol instance, a library
// footprint on the board and the chooser's search.  Run:
//   node server/static/tests/library.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "library", "core.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
const mod = { exports: {} }; new Function("exports", "module", built.outputFiles[0].text)(mod.exports, mod); const L = mod.exports;
const { kid, kids, str } = K;
let n = 0; const ok = (name, fn) => { fn(); n++; };

const FONT = "(effects (font (size 1.27 1.27)))";
const R = `(symbol "R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no)
  (property "Reference" "R" (at 2.032 0 90) (show_name no) (do_not_autoplace no) ${FONT})
  (property "Value" "R" (at 0 0 90) (show_name no) (do_not_autoplace no) ${FONT})
  (property "Footprint" "" (at -1.778 0 90) (show_name no) (do_not_autoplace no) (hide yes) ${FONT})
  (property "Datasheet" "" (at 0 0 0) (show_name no) (do_not_autoplace no) (hide yes) ${FONT})
  (property "Description" "Resistor" (at 0 0 0) (show_name no) (do_not_autoplace no) (hide yes) ${FONT})
  (property "ki_keywords" "R res resistor" (at 0 0 0) (hide yes) ${FONT})
  (property "ki_fp_filters" "R_*" (at 0 0 0) (hide yes) ${FONT})
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "" ${FONT}) (number "1" ${FONT}))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "" ${FONT}) (number "2" ${FONT})))
  (embedded_fonts no))`;
const LM2904 = `(symbol "LM2904" (pin_names (offset 0.127)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${FONT})
  (property "Value" "LM2904" (at 0 -5.08 0) ${FONT})
  (property "Footprint" "" (at 0 0 0) (hide yes) ${FONT})
  (property "Datasheet" "http://www.ti.com/lit/ds/symlink/lm358.pdf" (at 0 0 0) (hide yes) ${FONT})
  (property "Description" "Dual Operational Amplifiers" (at 0 0 0) (hide yes) ${FONT})
  (property "ki_keywords" "dual opamp" (at 0 0 0) (hide yes) ${FONT})
  (property "ki_fp_filters" "SOIC*3.9x4.9mm*P1.27mm* DIP*W7.62mm*" (at 0 0 0) (hide yes) ${FONT})
  (symbol "LM2904_1_1" (pin output line (at 7.62 0 180) (length 2.54) (name "~" ${FONT}) (number "1" ${FONT}))
    (pin input line (at -7.62 -2.54 0) (length 2.54) (name "-" ${FONT}) (number "2" ${FONT})) (pin input line (at -7.62 2.54 0) (length 2.54) (name "+" ${FONT}) (number "3" ${FONT})))
  (symbol "LM2904_2_1" (pin input line (at -7.62 2.54 0) (length 2.54) (name "+" ${FONT}) (number "5" ${FONT}))
    (pin input line (at -7.62 -2.54 0) (length 2.54) (name "-" ${FONT}) (number "6" ${FONT})) (pin output line (at 7.62 0 180) (length 2.54) (name "~" ${FONT}) (number "7" ${FONT})))
  (symbol "LM2904_3_1" (pin power_in line (at -2.54 -7.62 90) (length 3.81) (name "V-" ${FONT}) (number "4" ${FONT}))
    (pin power_in line (at -2.54 7.62 270) (length 3.81) (name "V+" ${FONT}) (number "8" ${FONT}))))`;
const LM358 = `(symbol "LM358" (extends "LM2904")
  (property "Reference" "U" (at 0 5.08 0) ${FONT})
  (property "Value" "LM358" (at 0 -5.08 0) ${FONT})
  (property "Footprint" "" (at 0 0 0) (hide yes) ${FONT})
  (property "Datasheet" "" (at 0 0 0) (hide yes) ${FONT})
  (property "Description" "Low-Power, Dual Operational Amplifiers, DIP-8/SOIC-8/TO-99-8" (at 0 0 0) (hide yes) ${FONT})
  (property "ki_keywords" "" (at 0 0 0) (hide yes) ${FONT})
  (property "MPN" "LM358N" (at 0 0 0) (hide yes) ${FONT}))`;
const GND = `(symbol "GND" (power global) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -6.35 0) (hide yes) ${FONT})
  (property "Value" "GND" (at 0 -3.81 0) ${FONT})
  (property "Footprint" "" (at 0 0 0) (hide yes) ${FONT})
  (property "Datasheet" "" (at 0 0 0) (hide yes) ${FONT})
  (property "Description" "Power symbol creates a global label with name \\"GND\\" , ground" (at 0 0 0) (hide yes) ${FONT})
  (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "~" ${FONT}) (number "1" ${FONT}))))`;
const FP = `(footprint "R_0603_1608Metric" (version 20260206) (generator "kicad-footprint-generator") (layer "F.Cu")
  (descr "Resistor SMD 0603") (tags "resistor")
  (property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R_0603_1608Metric" (at 0 1.43 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (property "KiLib_Generator" "SMD_2terminal_chip_molded" (at 0 0 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
  (attr smd) (duplicate_pad_numbers_are_jumpers no)
  (fp_line (start -0.237258 -0.5225) (end 0.237258 -0.5225) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_rect (start -1.48 -0.73) (end 1.48 0.73) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (effects (font (size 0.4 0.4) (thickness 0.06))))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net 3 "GND"))
  (embedded_fonts no)
  (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`;
const prop = (node, name) => kids(node, "property").find((p) => str(p[1]) === name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

ok("lib ids", () => {
  assert.deepStrictEqual(L.parseLibId("Device:R"), { lib: "Device", name: "R" });
  assert.deepStrictEqual(L.parseLibId("R"), { lib: "", name: "R" });
  assert.strictEqual(L.unitName(1), "Unit A"); assert.strictEqual(L.unitName(26), "Unit Z"); assert.strictEqual(L.unitName(27), "Unit AA");
});

ok("embedded copy: full lib id on the symbol, bare names on its units, text otherwise untouched", () => {
  const e = L.embedSymbol("Device:R", R);
  assert.strictEqual(str(e[1]), "Device:R");
  assert.deepStrictEqual(kids(e, "symbol").map((s) => str(s[1])), ["R_0_1", "R_1_1"]);
  const s = K.serialize(e);
  assert.ok(s.startsWith('(symbol "Device:R" (pin_numbers (hide yes))'), s.slice(0, 80));
  assert.ok(s.includes('(property "Reference" "R" (at 2.032 0 90)'), "strings stay quoted");
  assert.ok(s.includes('(property "ki_fp_filters" "R_*"'), "footprint filters stay with the copy");
  assert.ok(s.endsWith("(embedded_fonts no))"));
  // whitespace aside it is the library's own text
  assert.strictEqual(s.replace('"Device:R"', '"R"'), K.serialize(K.parse(R)));
  assert.throws(() => L.embedSymbol("Amplifier_Operational:LM358", LM358), /flatten/);
});

ok("flatten: the parent's drawing under the child's name and fields", () => {
  const f = L.flattenSymbol(LM358, [LM2904]);
  assert.strictEqual(str(f[1]), "LM358");
  assert.ok(!kid(f, "extends"));
  assert.deepStrictEqual(kids(f, "symbol").map((s) => str(s[1])), ["LM358_1_1", "LM358_2_1", "LM358_3_1"]);
  assert.strictEqual(str(prop(f, "Value")[2]), "LM358");
  assert.strictEqual(str(prop(f, "Description")[2]), "Low-Power, Dual Operational Amplifiers, DIP-8/SOIC-8/TO-99-8");
  assert.strictEqual(str(prop(f, "Datasheet")[2]), "http://www.ti.com/lit/ds/symlink/lm358.pdf", "an empty mandatory field keeps the parent's");
  assert.strictEqual(str(prop(f, "ki_keywords")[2]), "dual opamp", "empty keywords fall back to the parent's");
  assert.strictEqual(str(prop(f, "ki_fp_filters")[2]), "SOIC*3.9x4.9mm*P1.27mm* DIP*W7.62mm*");
  assert.strictEqual(str(prop(f, "MPN")[2]), "LM358N", "the child's own fields join");
  const names = kids(f, "property").map((p) => str(p[1]));
  assert.ok(names.indexOf("MPN") > names.indexOf("ki_fp_filters"));
  assert.ok(f.indexOf(prop(f, "MPN")) < f.indexOf(kids(f, "symbol")[0]), "fields before the units");
  const info = L.symbolInfo(f);
  assert.strictEqual(info.units, 3); assert.strictEqual(info.pins, 8); assert.strictEqual(info.reference, "U"); assert.strictEqual(info.power, false);
  assert.throws(() => L.flattenSymbol(LM358), /extends/);
  // a root symbol comes back as an independent copy
  const r = L.flattenSymbol(R); assert.strictEqual(K.serialize(r), K.serialize(K.parse(R)));
  const e = L.embedSymbol("Amplifier_Operational:LM358", f);
  assert.strictEqual(str(e[1]), "Amplifier_Operational:LM358"); assert.strictEqual(str(kids(e, "symbol")[0][1]), "LM358_1_1");
});

ok("a new symbol instance in the schematic writer's shape", () => {
  const lib = L.embedSymbol("Device:R", R);
  const node = L.symbolInstance({ libId: "Device:R", symbol: lib, at: [100.33, 50.8], project: "demo", path: "/root-uuid" });
  const s = K.serialize(node);
  assert.ok(s.startsWith('(symbol (lib_id "Device:R") (at 100.33 50.8 0) (unit 1) (body_style 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (dnp no) (uuid "'), s.slice(0, 200));
  assert.ok(UUID.test(K.uuidOf(node)));
  assert.deepStrictEqual(kids(node, "property").map((p) => str(p[1])), ["Reference", "Value", "Footprint", "Datasheet", "Description"]);
  assert.ok(s.includes('(property "Reference" "R?" (at 102.362 50.8 90) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27))))'), s);
  assert.ok(s.includes('(property "Value" "R" (at 100.33 50.8 90) (show_name no)'));
  assert.ok(s.includes('(property "Footprint" "" (at 98.552 50.8 90) (hide yes) (show_name no) (do_not_autoplace no) (effects'), "hide comes before show_name on an instance");
  assert.ok(s.includes('(property "Description" "Resistor" (at 100.33 50.8 0) (hide yes)'));
  assert.ok(!s.includes("ki_keywords"), "library metadata is not a field of the instance");
  const pins = kids(node, "pin"); assert.deepStrictEqual(pins.map((p) => str(p[1])), ["1", "2"]);
  assert.ok(pins.every((p) => UUID.test(str(kid(p, "uuid")[1]))) && str(kid(pins[0], "uuid")[1]) !== str(kid(pins[1], "uuid")[1]));
  assert.ok(s.endsWith('(instances (project "demo" (path "/root-uuid" (reference "R?") (unit 1)))))'), s.slice(-120));
  // the result parses back and draws as a schematic item
  const doc = K.parseDoc(`(kicad_sch (version 20260101) (generator "eeschema") (paper "A4") (lib_symbols ${K.serialize(lib)}) ${s})`);
  const it = doc.items.get(K.uuidOf(node)); assert.ok(it && it.bbox, "the symbol has geometry"); assert.strictEqual(it.ref, "R?");
});

ok("units, field overrides and extra fields", () => {
  const lib = L.embedSymbol("Amplifier_Operational:LM358", L.flattenSymbol(LM358, [LM2904]));
  const node = L.symbolInstance({ libId: "Amplifier_Operational:LM358", symbol: lib, at: [50.8, 50.8], unit: 2, reference: "U3", project: "p", path: "/a/b",
    fields: { Value: "LM358DR", Footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", LCSC: "C7950", MPN: "LM358DR2G" } });
  const s = K.serialize(node);
  assert.ok(s.includes("(unit 2) (body_style 1)"));
  assert.strictEqual(str(prop(node, "Reference")[2]), "U3");
  assert.strictEqual(str(prop(node, "Value")[2]), "LM358DR");
  assert.strictEqual(str(prop(node, "Footprint")[2]), "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm");
  assert.strictEqual(str(prop(node, "MPN")[2]), "LM358DR2G", "an override of a field the library has");
  assert.ok(s.includes('(property "LCSC" "C7950" (at 50.8 50.8 0) (hide yes) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27))))'), "a new field is hidden at the anchor");
  assert.strictEqual(kids(node, "pin").length, 8, "every unit's pins belong to the symbol");
  assert.ok(s.endsWith('(instances (project "p" (path "/a/b" (reference "U3") (unit 2)))))'));
  // library Y points up: the reference 5.08 above the anchor
  assert.deepStrictEqual(K.atOf(prop(node, "Reference")).slice(0, 2), [50.8, 45.72]);
});

ok("power symbols and annotation", () => {
  const lib = L.embedSymbol("power:GND", GND);
  assert.ok(L.symbolInfo(lib).power);
  const node = L.symbolInstance({ libId: "power:GND", symbol: lib, at: [10.16, 20.32] });
  const s = K.serialize(node);
  assert.ok(s.includes('(property "Reference" "#PWR?" (at 10.16 26.67 0) (hide yes)'), s);
  assert.ok(s.includes('(property "Value" "GND" (at 10.16 24.13 0) (show_name no)'));
  assert.ok(!kid(node, "instances"), "no sheet path known: no instances block");
  assert.strictEqual(L.nextReference("R", ["R1", "R2", "R4"], false), "R?");
  assert.strictEqual(L.nextReference("R", ["R1", "R2", "R4"], true), "R3");
  assert.strictEqual(L.nextReference("", [], false), "U?");
  assert.ok(L.isPowerRow({ power: true })); assert.ok(L.isPowerRow({ reference: "#PWR" })); assert.ok(!L.isPowerRow({ reference: "R" }));
});

ok("a library footprint becomes a board footprint", () => {
  const node = L.footprintInstance({ fpid: "Resistor_SMD:R_0603_1608Metric", footprint: FP, at: [120.5, 80.25] });
  const s = K.serialize(node);
  assert.ok(s.startsWith('(footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (uuid "'), s.slice(0, 120));
  assert.ok(/^\(footprint "[^"]+" \(layer "F.Cu"\) \(uuid "[0-9a-f-]{36}"\) \(at 120.5 80.25\) \(descr "Resistor SMD 0603"\) \(tags "resistor"\) \(property "Reference" "REF\*\*" \(at 0 -1.43 0\) \(layer "F.SilkS"\) \(uuid "[0-9a-f-]{36}"\) \(effects/.test(s), s.slice(0, 330));
  assert.ok(!/\(version|\(generator/.test(s), "the library header does not travel");
  assert.deepStrictEqual(kids(node, "property").map((p) => str(p[1])), ["Reference", "Value", "Datasheet", "Description", "KiLib_Generator"]);
  assert.ok(s.includes('(property "Datasheet" "" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "'));
  const ids = new Set();
  const walk = (n) => { for (const c of n) if (Array.isArray(c)) { if (c[0] === "uuid") { assert.ok(UUID.test(str(c[1]))); ids.add(str(c[1])); } else walk(c); } };
  walk(node);
  assert.strictEqual(ids.size, 1 + 5 + 2 + 1 + 2, "the footprint, its fields, graphics, text and pads each have their own uuid");
  assert.ok(/\(fp_line \(start [^)]*\) \(end [^)]*\) \(stroke \(width 0.12\) \(type solid\)\) \(layer "F.SilkS"\) \(uuid "[0-9a-f-]{36}"\)\)/.test(s), "graphics: uuid after the layer");
  assert.ok(/\(fp_text user "\$\{REFERENCE\}" \(at 0 0 0\) \(layer "F.Fab"\) \(uuid "[0-9a-f-]{36}"\) \(effects/.test(s), "texts: uuid before the effects");
  assert.ok(/\(pad "2" smd roundrect \(at 0.825 0\) \(size 0.8 0.95\) \(layers "F.Cu" "F.Mask" "F.Paste"\) \(roundrect_rratio 0.25\) \(uuid "[0-9a-f-]{36}"\)\)/.test(s), "pads come without nets");
  assert.ok(s.includes('(embedded_fonts no) (model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"'));
  // it parses as a board item with pads
  const doc = K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) ${s})`);
  const it = doc.items.get(K.uuidOf(node)); assert.ok(it && it.kind === "footprint" && it.bbox); assert.strictEqual(it.ref, "REF**");
  // field overrides (the vendor import path)
  const v = L.footprintInstance({ fpid: "X:Y", footprint: FP, at: [0, 0], fields: { Value: "10k", LCSC: "C25804" } });
  assert.strictEqual(str(prop(v, "Value")[2]), "10k"); assert.strictEqual(str(prop(v, "Reference")[2]), "REF**"); assert.strictEqual(str(prop(v, "LCSC")[2]), "C25804");
  assert.deepStrictEqual(L.footprintInfo(FP), { name: "R_0603_1608Metric", description: "Resistor SMD 0603", keywords: "resistor", pads: 2 });
  assert.throws(() => L.footprintInstance({ fpid: "a:b", footprint: "(symbol \"x\")", at: [0, 0] }), /not a footprint/);
});

ok("search: every term must match; the name outranks keywords and description", () => {
  const rows = [{ name: "R", description: "Resistor", keywords: "R res resistor", library: "Device" }, { name: "R_Small", description: "Resistor, small symbol", keywords: "R resistor", library: "Device" },
    { name: "C", description: "Unpolarized capacitor", keywords: "cap capacitor", library: "Device" }, { name: "LM358", description: "Low-Power, Dual Operational Amplifiers", keywords: "dual opamp", library: "Amplifier_Operational" }];
  const rank = (q) => rows.map((r) => [r.name, L.searchScore(r, q)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  assert.deepStrictEqual(rank(""), ["R", "R_Small", "C", "LM358"]);
  assert.deepStrictEqual(rank("r"), ["R", "R_Small"].concat(rank("r").slice(2)));
  assert.strictEqual(rank("r")[0], "R");
  assert.deepStrictEqual(rank("resistor small"), ["R_Small"]);
  assert.deepStrictEqual(rank("opamp"), ["LM358"]);
  assert.deepStrictEqual(rank("capacitor"), ["C"]);
  assert.deepStrictEqual(rank("device:r"), ["R", "R_Small"]);
  assert.deepStrictEqual(rank("zzz"), []);
});

console.log(`library.test.js: ${n} groups passed`);
