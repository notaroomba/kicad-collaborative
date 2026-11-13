// sweep6-update-variants.test.js — Update PCB from Schematic carries the symbols' design variants to the footprints
// (BOARD_NETLIST_UPDATER::applyComponentVariants): the component's variants as the KiCad netlist hands them over,
// the per-variant flags and field overrides written on the footprint, stale variants removed, KiCad's report wording.
// Run: node server/static/tests/sweep6-update-variants.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("update PCB with design variants");

const SYM = K.parse(`(symbol (lib_id "Device:C") (at 10 10 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
  (property "Reference" "C1" (at 0 0 0)) (property "Value" "47uF" (at 0 0 0)) (property "Footprint" "Capacitor_SMD:C_0805" (at 0 0 0)) (property "MPN" "GRM1" (at 0 0 0))
  (instances (project "demo" (path "/root" (reference "C1") (unit 1)
    (variant (name "Lite") (dnp yes) (field (name "Value") (value "47uF LITE")))
    (variant (name "full") (in_bom no) (field (name "MPN") (value "GRM1")))
    (variant (name "Same") (field (name "Value") (value "47uF")))))))`);

test("componentVariants: only what differs, names in case-insensitive order", () => {
  const v = N.componentVariants(SYM, "/root", "C1");
  assert.deepStrictEqual(v.map((x) => x.name), ["full", "Lite"]);
  assert.strictEqual(v[0].excludedFromBOM, true); assert.strictEqual(v[0].fields.size, 0, "an override equal to the symbol's text is not sent");
  assert.strictEqual(v[1].dnp, true); assert.strictEqual(v[1].excludedFromBOM, undefined);
  assert.deepStrictEqual([...v[1].fields], [["Value", "47uF LITE"]]);
  assert.deepStrictEqual(N.componentVariants(SYM, "/other", "C1"), [], "another instance has no variants");
});

const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
const fp = (extra) => `(footprint "Capacitor_SMD:C_0805" (layer "F.Cu") (uuid "f1") (at 10 10)
  (property "Reference" "C1" (at 0 -1.4 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "47uF" (at 0 1.4 0) (layer "F.Fab") (uuid "v1") (effects (font (size 1 1) (thickness 0.15))))
  (property "MPN" "GRM1" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "m1") (effects (font (size 1 1) (thickness 0.15))))
  (path "/s1") (sheetname "/") (sheetfile "demo.kicad_sch") (attr smd)
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (uuid "p1")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (uuid "p2"))${extra})`;
const board = (extra) => K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (paper "A4") ${LAYERS}\n${fp(extra)})`, "kicad_pcb");
const netlist = (variants) => ({ components: [{ ref: "C1", value: "47uF", footprint: "Capacitor_SMD:C_0805", libId: "Device:C", paths: ["/s1"], fields: { MPN: "GRM1" }, sheetName: "/", sheetFile: "demo.kicad_sch",
  dnp: false, excludeFromBom: false, excludeFromBoard: false, pins: new Map(), variants }], nets: new Map(), warnings: [] });
const lines = (plan) => plan.report.filter((r) => r.severity === "action").map((r) => r.text);

test("new variants: KiCad's messages, the footprint's (variant …) written as the board writer writes it", () => {
  const doc = board(""), before = K.serialize(doc.items.get("f1").node);
  const plan = N.planUpdate(doc, netlist(N.componentVariants(SYM, "/root", "C1")), { updateFields: true });
  assert.deepStrictEqual(lines(plan), ["Add C1 'exclude from BOM' attribute to variant full.", "Add C1 'Do not place' attribute to variant Lite.", "Change C1 field 'Value' to '47uF LITE' on variant Lite."]);
  const out = K.serialize(plan.modified.get("f1"));
  assert.ok(/\(variant\s+\(name "full"\)\s+\(exclude_from_bom yes\)\s*\)\s*\(variant\s+\(name "Lite"\)\s+\(dnp yes\)\s+\(field\s+\(name "Value"\)\s+\(value "47uF LITE"\)\s*\)\s*\)/.test(out), out);
  assert.strictEqual(K.serialize(doc.items.get("f1").node), before, "the document itself is untouched");
});

test("up to date: no change; a stale variant and a stale field override are removed", () => {
  const doc = board(` (variant (name "full") (exclude_from_bom yes)) (variant (name "Lite") (dnp yes) (field (name "Value") (value "47uF LITE")))`);
  const plan = N.planUpdate(doc, netlist(N.componentVariants(SYM, "/root", "C1")), { updateFields: true });
  assert.deepStrictEqual(lines(plan), []); assert.ok(!plan.modified.has("f1"));
  const doc2 = board(` (variant (name "Lite") (dnp yes) (field (name "MPN") (value "OLD")) (field (name "Value") (value "47uF LITE"))) (variant (name "Old") (dnp yes))`);
  const plan2 = N.planUpdate(doc2, netlist(N.componentVariants(SYM, "/root", "C1")), { updateFields: true });
  assert.deepStrictEqual(lines(plan2), ["Add C1 'exclude from BOM' attribute to variant full.", "Remove C1 field 'MPN' override on variant Lite.", "Remove variant C1:Old no longer associated with footprint Capacitor_SMD:C_0805."]);
  const out = K.serialize(plan2.modified.get("f1"));
  assert.ok(!/"Old"/.test(out) && !/"OLD"/.test(out) && /\(name "Lite"\)\s+\(dnp yes\)\s+\(field\s+\(name "Value"\)/.test(out), out);
});

test("a variant whose Footprint field names another footprint does not belong to this one", () => {
  const vs = [{ name: "Alt", dnp: true, fields: new Map([["Footprint", "Capacitor_SMD:C_1206"]]) }];
  const doc = board(` (variant (name "Alt") (dnp yes))`);
  const plan = N.planUpdate(doc, netlist(vs), { updateFields: true });
  assert.deepStrictEqual(lines(plan), ["Remove variant C1:Alt no longer associated with footprint Capacitor_SMD:C_0805."]);
});

test("Update Footprint Fields off: flags still go to the variant, field overrides are left alone", () => {
  const doc = board("");
  const plan = N.planUpdate(doc, netlist(N.componentVariants(SYM, "/root", "C1")), { updateFields: false });
  assert.deepStrictEqual(lines(plan), ["Add C1 'exclude from BOM' attribute to variant full.", "Add C1 'Do not place' attribute to variant Lite."]);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
