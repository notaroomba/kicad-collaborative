// sym-props.test.js — DIALOG_SYMBOL_PROPERTIES' own logic (web/dialogs/sym-props-logic.ts): the passthrough token,
// local power, body style names, the composed reference suffix, SCH_SYMBOL::SyncOtherUnits / CollectOtherUnits and
// the pin-to-pad maps of PANEL_SYMBOL_PIN_MAP.  Run: node server/static/tests/sym-props.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const P = load("dialogs/sym-props-logic.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const S = (n) => K.serialize(n), N = (s) => K.parse(s);
console.log("symbol properties logic under node");

const SYM = `(symbol (lib_id "74xx:74HC00") (at 50 50 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes) (uuid "u1")
  (property "Reference" "U1" (at 52 48 0) (effects (font (size 1.27 1.27))))
  (property "Value" "74HC00" (at 52 52 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "Package_DIP:DIP-14" (at 50 50 0) (hide yes) (effects (font (size 1.27 1.27))))
  (property "MPN" "SN74HC00N" (at 55 55 0) (hide yes) (effects (font (size 1.27 1.27))))
  (pin "1" (uuid "p1") (alternate "IN_A")) (pin "2" (uuid "p2"))
  (instances (project "demo" (path "/root" (reference "U1") (unit 1)))))`;

test("passthrough: Default omits the token; Block / Force go after (dnp) and are read back", () => {
  const n = N(SYM); assert.strictEqual(P.passthroughOf(n), "default");
  P.setPassthrough(n, "block"); assert.ok(/\(dnp no\) \(passthrough block\) \(fields_autoplaced yes\)/.test(S(n)), S(n));
  assert.strictEqual(P.passthroughOf(n), "block");
  P.setPassthrough(n, "force"); assert.ok(/\(passthrough force\)/.test(S(n)) && !/block/.test(S(n)));
  P.setPassthrough(n, "default"); assert.ok(!/passthrough/.test(S(n)));
  const m = N(`(symbol (lib_id "x") (dnp no) (pin_map_override (mode identity)) (uuid "a"))`); P.setPassthrough(m, "block");
  assert.ok(/\(pin_map_override \(mode identity\)\) \(passthrough block\)/.test(S(m)), S(m));
});
test("local power: (power local) / (power global); a non-power symbol is left alone", () => {
  const g = N(`(symbol "power:GND" (power) (pin_names (offset 0)))`);
  assert.ok(P.isPowerLib(g) && !P.isLocalPower(g));
  assert.ok(P.setLocalPower(g, true)); assert.ok(/\(symbol "power:GND" \(power local\)/.test(S(g)), S(g)); assert.ok(P.isLocalPower(g));
  assert.ok(P.setLocalPower(g, false)); assert.ok(/\(power global\)/.test(S(g)));
  assert.ok(!P.setLocalPower(g, false), "no change, nothing written");
  const r = N(`(symbol "Device:R" (pin_names (offset 0)))`); assert.ok(!P.setLocalPower(r, true)); assert.ok(!/power/.test(S(r)));
});
test("body styles: De Morgan reads Standard / Alternate, custom names from (body_styles …), else one", () => {
  assert.deepStrictEqual(P.bodyStyleNames(N(`(symbol "a" (symbol "a_1_1") (symbol "a_1_2"))`)), ["Standard", "Alternate"]);
  assert.deepStrictEqual(P.bodyStyleNames(N(`(symbol "a" (body_styles demorgan) (symbol "a_1_1"))`)), ["Standard", "Alternate"]);
  assert.deepStrictEqual(P.bodyStyleNames(N(`(symbol "a" (body_styles "Big" "Small" "Tiny") (symbol "a_1_1"))`)), ["Big", "Small", "Tiny"]);
  assert.deepStrictEqual(P.bodyStyleNames(N(`(symbol "a" (symbol "a_1_1"))`)), ["Standard"]);
});
test("composed reference: the path's Reference Suffix fields joined; unannotated references stay unsuffixed", () => {
  const s1 = N(`(sheet (property "Sheetname" "a") (property "Reference Suffix" "_L"))`), s2 = N(`(sheet (property "Sheetname" "b") (property "Reference Suffix" "2"))`);
  assert.strictEqual(P.composeRefSuffix([s1, null, s2]), "_L2");
  assert.strictEqual(P.composedReference("R12", "_L"), "R12_L"); assert.strictEqual(P.composedReference("R?", "_L"), "R?");
});
test("SyncOtherUnits: Value, footprint and other fields, flags, alternates; the reference and position stay", () => {
  const src = N(SYM.replace('"74HC00" (at', '"74HCT00" (at').replace("(dnp no)", "(dnp yes)").replace("(in_bom yes)", "(in_bom no)"));
  const dst = N(`(symbol (lib_id "74xx:74HC00") (at 100 50 0) (unit 2) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "u2")
    (property "Reference" "U1" (at 102 48 0) (effects (font (size 1.27 1.27)))) (property "Value" "74HC00" (at 102 52 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 100 50 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "Extra" "gone" (at 100 50 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "q1")) (pin "2" (uuid "q2") (alternate "OLD")) (instances (project "demo" (path "/root" (reference "U1") (unit 2)))))`);
  const out = P.syncUnit(src, dst); const s = S(out);
  assert.ok(/\(property "Value" "74HCT00" \(at 102 52 0\)/.test(s), "value text, own position");
  assert.ok(/\(property "Footprint" "Package_DIP:DIP-14" \(at 100 50 0\)/.test(s));
  assert.ok(/\(property "MPN" "SN74HC00N" \(at 105 55 0\)/.test(s), "a missing field is added at the same offset: " + s);
  assert.ok(!/Extra/.test(s), "a user field the source lacks is removed");
  assert.ok(/\(in_bom no\)/.test(s) && /\(dnp yes\)/.test(s));
  assert.ok(/\(pin "1" \(uuid "q1"\) \(alternate "IN_A"\)\)/.test(s) && /\(pin "2" \(uuid "q2"\)\)/.test(s), s);
  assert.ok(/\(property "Reference" "U1" \(at 102 48 0\)/.test(s) && /\(unit 2\)/.test(s));
  assert.ok(/\(exclude_from_sim no\)/.test(s), "exclude from simulation is not synced");
  assert.strictEqual(P.syncUnit(out, out), null, "nothing to do -> null");
});
test("SyncOtherUnits with a property filter: only that property", () => {
  const src = N(SYM.replace('"74HC00" (at', '"X" (at').replace("(dnp no)", "(dnp yes)"));
  const dst = N(SYM.replace('(uuid "u1")', '(uuid "u2")'));
  const v = S(P.syncUnit(src, dst, P.syncFor("Value"))); assert.ok(/"Value" "X"/.test(v) && /\(dnp no\)/.test(v));
  const d = S(P.syncUnit(src, dst, P.syncFor("Do not Populate"))); assert.ok(/"Value" "74HC00"/.test(d) && /\(dnp yes\)/.test(d));
});
test("CollectOtherUnits: same reference on that path, same lib_id, other unit; power symbols never", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4") (lib_symbols)
    ${SYM}
    ${SYM.replace('(uuid "u1")', '(uuid "u2")').replace("(unit 1) (exclude", "(unit 2) (exclude").replace('(reference "U1") (unit 1)', '(reference "U1") (unit 2)')}
    ${SYM.replace('(uuid "u1")', '(uuid "u3")').replace('(reference "U1") (unit 1)', '(reference "U2") (unit 2)')}
    ${SYM.replace('(uuid "u1")', '(uuid "u4")').replace('"74xx:74HC00"', '"74xx:74HC04"').replace('(reference "U1") (unit 1)', '(reference "U1") (unit 3)')})`, "kicad_sch");
  const self = doc.items.get("u1");
  const hits = P.collectOtherUnits([{ path: "/root", doc }], self, "U1", 1, "74xx:74HC00", "demo", () => false);
  assert.deepStrictEqual(hits.map((x) => x.item.id), ["u2"]);
  assert.deepStrictEqual(P.collectOtherUnits([{ path: "/root", doc }], self, "U1", 1, "74xx:74HC00", "demo", () => true), []);
  assert.ok(P.isAnnotated("U1") && !P.isAnnotated("U?"));
});
test("pin maps: read, edit (identity not stored), rename-safe write in KiCad's order before the units", () => {
  const lib = N(`(symbol "Q:NPN" (property "Reference" "Q" (at 0 0 0)) (associated_footprints (footprint "Package_TO_SOT_THT:TO-92" (map "TO92"))) (pin_maps (pin_map "TO92" (entry "1" "3") (entry "3" "1")) (pin_map "SOT23")) (symbol "NPN_1_1"))`);
  const st = P.readPinMaps(lib);
  assert.deepStrictEqual(st.maps.map((m) => m.name), ["TO92", "SOT23"]); assert.strictEqual(st.footprints.get("TO92"), "Package_TO_SOT_THT:TO-92");
  assert.strictEqual(P.pinMapCell(st.maps[0], "1"), "3"); assert.strictEqual(P.pinMapCell(st.maps[0], "2"), "2");
  P.setPinMapCell(st.maps[1], "1", "2"); P.setPinMapCell(st.maps[0], "1", "1");
  st.maps.push({ name: P.newMapName(st.maps), entries: new Map() }); assert.strictEqual(st.maps[2].name, "map1");
  st.footprints.set("SOT23", "Package_TO_SOT_SMD:SOT-23");
  P.writePinMaps(lib, st); const s = S(lib);
  assert.ok(s.indexOf("(associated_footprints") < s.indexOf("(pin_maps") && s.indexOf("(pin_maps") < s.indexOf('(symbol "NPN_1_1"'), s);
  assert.ok(/\(pin_map "TO92" \(entry "3" "1"\)\)/.test(s), "the identity entry is dropped: " + s);
  assert.ok(/\(pin_map "SOT23" \(entry "1" "2"\)\)/.test(s) && /\(pin_map "map1"\)/.test(s));
  assert.ok(/\(footprint "Package_TO_SOT_SMD:SOT-23" \(map "SOT23"\)\)/.test(s));
  assert.ok(P.validFootprintId("Package_TO_SOT_SMD:SOT-23") && !P.validFootprintId("SOT-23") && !P.validFootprintId(":x"));
  assert.strictEqual(P.PIN_MAP_MSG.removeAsk("TO92"), "Remove pin map 'TO92' and its footprint association?");
  const ov = P.readOverride(N(`(symbol (pin_map_override (mode named_map) (map "SOT23") (edit "1" "2")))`));
  assert.deepStrictEqual([ov.mode, ov.map, Array.from(ov.edits)], ["named_map", "SOT23", [["1", "2"]]]);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
