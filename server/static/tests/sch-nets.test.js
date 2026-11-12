// sch-nets.test.js — the schematic net highlight across the hierarchy and the Net Navigator's model, under node:
// the net map of canvas/pcb-netlist.ts buildNetlist (every net with its items, sheet instance by sheet instance),
// canvas/sch-nets.ts (highlight keys, name lookup, KiCad's item wording, the filter) and the pin-level highlight
// keys the renderer understands.
// Run: node server/static/tests/sch-nets.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, SN = K.schNets, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("schematic nets under node");

const LIB = `(lib_symbols
  (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
  (symbol "power:GND" (power) (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
    (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
const sym = (lib, ref, value, fp, x, y, uuid, inst) => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (uuid "${uuid}") (property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "${value}" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "${fp}" (at ${x} ${y} 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "MPN" "X-${ref}" (at ${x} ${y} 0) (hide yes) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${uuid}-p1")) (pin "2" (uuid "${uuid}-p2")) (instances (project "demo" (path "${inst}" (reference "${ref}") (unit 1)))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const U_ROOT = "11111111-1111-1111-1111-111111111111", U_SUB = "22222222-2222-2222-2222-222222222222", U_SHEET = "33333333-3333-3333-3333-333333333333";
// root: R1 between the label SIG and the sheet pin IN; R2 from SIG to GND, its other... sub: R3 from the hierarchical label IN to a local label
function build() {
  const rootSyms = sym("Device:R", "R1", "10k", "Resistor_SMD:R_0603_1608Metric", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", "/" + U_ROOT) + sym("Device:R", "R2", "4k7", "Resistor_SMD:R_0603_1608Metric", 120, 50, "aaaaaaaa-0000-0000-0000-000000000002", "/" + U_ROOT)
    + `(symbol (lib_id "power:GND") (at 120 60 0) (unit 1) (uuid "aaaaaaaa-0000-0000-0000-000000000009") (property "Reference" "#PWR01" (at 120 66 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "GND" (at 120 64 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "g1")) (instances (project "demo" (path "/${U_ROOT}" (reference "#PWR01") (unit 1)))))`;
  const probe = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB} ${rootSyms})`, "kicad_sch");
  const pins = (id) => { const o = {}; for (const p of helpers.symbolPins(probe, probe.items.get(id))) o[p.number] = [p.x, p.y]; return o; };
  const r1 = pins("aaaaaaaa-0000-0000-0000-000000000001"), r2 = pins("aaaaaaaa-0000-0000-0000-000000000002"), g = pins("aaaaaaaa-0000-0000-0000-000000000009");
  const sheetPin = [80, r1[2][1]];
  const root = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB} ${rootSyms}
    ${wire(r1[1], r2[1], "w1")} (label "SIG" (at ${r1[1][0]} ${r1[1][1]} 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
    ${wire(r2[2], g[1], "w2")} ${wire(r1[2], sheetPin, "w3")}
    (sheet (at 60 ${sheetPin[1] - 5}) (size 20 10) (stroke (width 0) (type solid)) (fill (color 0 0 0 0)) (uuid "${U_SHEET}") (property "Sheetname" "sub" (at 60 40 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "sub.kicad_sch" (at 60 56 0) (effects (font (size 1.27 1.27))))
      (pin "IN" input (at 80 ${sheetPin[1]} 0) (effects (font (size 1.27 1.27))) (uuid "sp1")) (instances (project "demo" (path "/${U_ROOT}" (page "2")))))
    (sheet_instances (path "/" (page "1"))))`;
  const subSyms = sym("Device:R", "R3", "1k", "Resistor_SMD:R_0603_1608Metric", 100, 50, "bbbbbbbb-0000-0000-0000-000000000003", `/${U_ROOT}/${U_SHEET}`);
  const sub = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_SUB}") (paper "A4") ${LIB} ${subSyms}
    (hierarchical_label "IN" (shape input) (at ${r1[1][0]} ${r1[1][1]} 180) (effects (font (size 1.27 1.27))) (uuid "h1"))
    (label "LOCAL" (at ${r1[2][0]} ${r1[2][1]} 0) (effects (font (size 1.27 1.27))) (uuid "l2")))`;
  const file = (text, uuid, name) => ({ doc: K.parseDoc(text, "kicad_sch"), uuid, file: name });
  const files = { "demo.kicad_sch": file(root, U_ROOT, "demo.kicad_sch"), "sub.kicad_sch": file(sub, U_SUB, "sub.kicad_sch") };
  return { files, nl: N.buildNetlist(files["demo.kicad_sch"], (f) => files[f] || null, helpers, "demo") };
}

const { files, nl } = build();
const map = nl.netMap, inst = nl.instances;
const R1 = "aaaaaaaa-0000-0000-0000-000000000001", R2 = "aaaaaaaa-0000-0000-0000-000000000002", PWR = "aaaaaaaa-0000-0000-0000-000000000009", R3 = "bbbbbbbb-0000-0000-0000-000000000003";

test("net map: every named net, the hierarchy instances root first", () => {
  assert.deepStrictEqual(inst.map((i) => i.human), ["/", "/sub/"]);
  assert.deepStrictEqual(inst.map((i) => i.file), ["demo.kicad_sch", "sub.kicad_sch"]);
  for (const n of ["/SIG", "GND", "/sub/IN", "/sub/LOCAL"]) assert.ok(map.has(n), n + " in " + Array.from(map.keys()).join(", "));
});
test("net map: a net crossing a sheet pin holds the items of both sheets", () => {
  const e = map.get("/sub/IN"), on = (i) => e.members.filter((m) => m.inst === i).map((m) => m.kind + ":" + m.id + (m.pin ? "#" + m.pin : "")).sort();
  assert.deepStrictEqual(on(0), [`pin:${R1}#2`, `sheet_pin:${U_SHEET}#IN`, "wire:w3"].sort());
  assert.deepStrictEqual(on(1), [`hierarchical_label:h1`, `pin:${R3}#1`].sort());
});
test("collectKeys: the items of the named net on the sheet on screen, pins as symbol#pin:N", () => {
  assert.deepStrictEqual(Array.from(SN.collectKeys(map, "/sub/IN", 0)).sort(), [`${R1}#pin:2`, `${U_SHEET}#pin:IN`, "w3"].sort());
  assert.deepStrictEqual(Array.from(SN.collectKeys(map, "/sub/IN", 1)).sort(), [`${R3}#pin:1`, "h1"].sort());
  assert.strictEqual(SN.collectKeys(map, "/SIG", 1).size, 0, "a net of the root sheet has nothing on the sub-sheet");
  assert.strictEqual(SN.collectKeys(map, null, 0).size, 0);
});
test("collectKeys: a power symbol on the net brightens its pin and its Reference / Value fields", () => {
  const k = SN.collectKeys(map, "GND", 0);
  assert.ok(k.has(`${PWR}#pin:1`) && k.has(`${PWR}#field:Value`) && k.has(`${PWR}#field:Reference`), Array.from(k).join(","));
  assert.ok(k.has(`${R2}#pin:2`) && k.has("w2"));
  assert.ok(!k.has(`${R2}#pin:1`), "the other pin of R2 is on /SIG");
});
test("nameIndex: GetConnectionName of a wire, a label, a pin and a sheet pin", () => {
  const ix = SN.nameIndex(map);
  assert.strictEqual(ix.get("0|w1"), "/SIG"); assert.strictEqual(ix.get("0|l1"), "/SIG");
  assert.strictEqual(ix.get(`0|${R1}#pin:2`), "/sub/IN"); assert.strictEqual(ix.get(`0|${U_SHEET}#pin:IN`), "/sub/IN");
  assert.strictEqual(ix.get(`1|${R3}#pin:2`), "/sub/LOCAL"); assert.strictEqual(ix.get(`0|${PWR}#pin:1`), "GND");
});
test("instanceFor: the instance of the file on screen", () => {
  assert.strictEqual(SN.instanceFor(inst, "sub.kicad_sch").human, "/sub/");
  assert.strictEqual(SN.instanceFor(inst, "sub.kicad_sch", "/nope/").index, 1, "an unknown path falls back to the first instance");
  assert.strictEqual(SN.instanceFor(inst, "other.kicad_sch"), null);
});
test("navigator: one node per sheet path, items in KiCad's wording, lines and junctions left out, sorted", () => {
  const f = (v) => (Math.round(v * 100) / 100) + " mm";
  const docOf = (i) => files[i.file].doc;
  const s = SN.navSheets(map, "/sub/IN", inst, "demo", docOf, f);
  assert.deepStrictEqual(s.map((x) => x.label), ["demo", "demo/sub"]);
  assert.deepStrictEqual(s[0].items.map((x) => x.label), ["Sheet 'sub' pin 'IN'", "Symbol 'R1' pin '2'"]);
  assert.ok(/^Hierarchical label 'IN' at \(/.test(s[1].items[0].label), s[1].items[0].label);
  assert.strictEqual(s[1].items[1].label, "Symbol 'R3' pin '1'");
  const g = SN.navSheets(map, "GND", inst, "demo", docOf, f)[0].items.map((x) => x.label);
  assert.ok(g.includes("Symbol '#PWR01' pin '1' (GND)"), g.join(" | "));
  assert.ok(SN.navSheets(map, "/SIG", inst, "demo", docOf, f)[0].items.some((x) => /^Label 'SIG' at \(\d/.test(x.label)));
});
test("navigator: the Nets list holds every net, unnamed Net-(…) ones too, and no buses", () => {
  const names = SN.netNames(map);
  assert.ok(names.includes("/SIG") && names.includes("GND"));
  assert.deepStrictEqual(names, names.slice().sort());
});
test("filter: wildcard substring by default, * and ? as given, case-insensitive; regex mode; bad regex filters nothing", () => {
  assert.ok(SN.netFilter("sig")("/SIG")); assert.ok(!SN.netFilter("gnd")("/SIG"));
  assert.ok(SN.netFilter("/s*")("/SIG")); assert.ok(!SN.netFilter("s*")("/SIG"), "a pattern with * is anchored");
  assert.ok(SN.netFilter("/S?G")("/SIG"));
  assert.ok(SN.netFilter("^G", false)("GND")); assert.ok(!SN.netFilter("^G", false)("/GND"));
  assert.ok(SN.netFilter("(", false)("anything"));
  assert.ok(SN.wildCompare("*", "")); assert.ok(SN.wildCompare("a*b*c", "aXXbYc")); assert.ok(!SN.wildCompare("a*b", "ab c"));
});
test("status text: 'Highlighted net: <name>' unescaped, empty when cleared", () => {
  assert.strictEqual(SN.highlightStatus("/A{slash}B"), "Highlighted net: /A/B");
  assert.strictEqual(SN.highlightStatus(null), "");
});
test("geometry: every geometry of a pin carries its number, a sheet pin its name", () => {
  const root = files["demo.kicad_sch"].doc;
  const r1 = root.items.get(R1); assert.ok(r1.geom.some((g) => g.pinNo === "1") && r1.geom.some((g) => g.pinNo === "2"));
  assert.ok(r1.geom.some((g) => g.field === "Reference" && g.pinNo === undefined));
  const sh = root.items.get(U_SHEET); assert.ok(sh.geom.some((g) => g.pinNo === "IN"));
});
test("sch-tools: with a highlighter installed, a highlight click hands it the pick; Esc and ~ clear through it", () => {
  const doc = files["demo.kicad_sch"].doc; const calls = [];
  const ctx = { doc, snap: (p) => p, requestRender() {}, toast() {}, setHighlight() {}, pxPerMm: 4 };
  sch.setNetHighlighter({ highlightPick: (c, pick) => calls.push(["pick", pick && pick.item.id]), clear: () => calls.push(["clear"]), active: () => true, docChanged: () => calls.push(["doc"]) });
  try {
    const w1 = doc.items.get("w1"), p = K.ptsOf(w1.node)[0];
    sch._.highlightClick(ctx, [(p[0] + K.ptsOf(w1.node)[1][0]) / 2, p[1]]);
    sch._.highlightClick(ctx, [5, 5]);
    sch.actions.clearHighlight.run(ctx);
    assert.deepStrictEqual(calls, [["pick", "w1"], ["pick", null], ["clear"]]);
  } finally { sch.setNetHighlighter(null); }
});

test("update PCB from the schematic: the project's board is <project>.kicad_pcb; a new board parses with two copper layers", () => {
  const docs = [{ docId: "1", path: "dir/demo.kicad_pro", docType: "kicad_pro" }, { docId: "2", path: "dir/demo.kicad_sch", docType: "kicad_sch" }, { docId: "3", path: "dir/other.kicad_pcb", docType: "kicad_pcb" }];
  assert.deepStrictEqual(N.projectBoardPath(docs), { path: "dir/demo.kicad_pcb", doc: null }, "another board is not the project's");
  docs.push({ docId: "4", path: "dir/demo.kicad_pcb", docType: "kicad_pcb" });
  assert.strictEqual(N.projectBoardPath(docs).doc.docId, "4");
  const b = K.parseDoc(N.newBoardText(20260728), "kicad_pcb");
  assert.strictEqual(b.type, "pcb"); assert.ok(/\(version 20260728\)/.test(N.newBoardText(20260728)));
  assert.deepStrictEqual(b.copper, ["F.Cu", "B.Cu"]); assert.ok(b.layers.has("Edge.Cuts"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
