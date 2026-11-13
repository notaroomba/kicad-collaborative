// sweep6-netlists.test.js — File > Export > Netlist: the KiCad netlist of the whole hierarchy (NETLIST_EXPORTER_KICAD
// over NETLIST_EXPORTER_XML, sim/netlist-kicad.ts) against netlists KiCad 10 wrote, the Allegro netlist against
// kicad-cli's basic_test file byte for byte, and the SPICE .subckt model (NETLIST_EXPORTER_SPICE_MODEL).
// Run: node server/static/tests/sweep6-netlists.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 8).join("\n       ")); } }
console.log("KiCad / Allegro / SPICE model netlists under node");
const esbuild = require("esbuild");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const NK = load("sim/netlist-kicad.ts"), SP = load("sim/spice-netlist.ts"), SL = load("dialogs/sim-model-logic.ts");
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const QA = fs.existsSync(path.join(__dirname, "..", "..", "..", "qa", "data")) ? path.join(__dirname, "..", "..", "..", "qa", "data") : "/home/claude/kicad-collaborative/qa/data";

/** The project in `dir` as the dialog reads it: every sheet file, the net map, the sheets by page. */
function project(dir, name, edit) {
  const files = new Map();
  const loadFile = (f) => {
    if (files.has(f)) return files.get(f);
    const p = path.join(dir, f); if (!fs.existsSync(p)) return null;
    let t = fs.readFileSync(p, "utf8"); if (edit) t = edit(f, t);
    const r = { doc: K.parseDoc(t, "kicad_sch"), uuid: String((K.kid(K.parse(t), "uuid") || [])[1]), file: f }; files.set(f, r); return r;
  };
  const root = loadFile(name + ".kicad_sch");
  const nl = N.buildNetlist(root, (f) => loadFile(f), helpers, name);
  const sheets = NK.nlSheets(nl.instances, (f) => (loadFile(f) || {}).doc || null);
  let pro = {}; try { pro = JSON.parse(fs.readFileSync(path.join(dir, name + ".kicad_pro"), "utf8")); } catch (e) { /* none */ }
  const rootSheetName = ((pro.sheets || []).find((e) => e[0] === root.uuid) || [])[1] || "";
  return { root, nl, sheets, pro, rootSheetName };
}
function kicadAgainst(dir, name, netFile, extra) {
  const want = fs.readFileSync(path.join(dir, netFile), "utf8");
  const pr = project(dir, name);
  const src = /\(source "([^"]*)"\)/.exec(want)[1], date = /\(date "([^"]*)"\)/.exec(want)[1], ver = /\(tool "Eeschema ([^"]*)"\)/.exec(want)[1];
  const got = NK.kicadNetlist(Object.assign({ sheets: pr.sheets, netlist: pr.nl, source: src.replace(/\\\\/g, "\\"), date, version: ver, textVars: pr.pro.text_variables || {}, rootSheetName: pr.rootSheetName }, extra || {}));
  return { want, got };
}
function firstDiff(a, b) { const x = a.split("\n"), y = b.split("\n"); for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i + 1}:\n want ${JSON.stringify(x[i])}\n got  ${JSON.stringify(y[i])}`; return ""; }

test("KiCad netlist: KiCad 10.0.7's body_styles.net byte for byte (header, components, units, variants, libparts, nets)", () => {
  const { want, got } = kicadAgainst(path.join(QA, "downgrade", "golden", "v10"), "body_styles", "body_styles.net");
  assert.strictEqual(got, want, firstDiff(want, got));
});
test("KiCad netlist: a hierarchy of shared sheets (sheets by page number, then the walk), rule-area component classes, libraries", () => {
  const dir = path.join(QA, "eeschema", "netlists", "hierarchical_component_classes");
  const { want, got } = kicadAgainst(dir, "hierarchical_component_classes", "hierarchical_component_classes.net", { libUri: (n) => "${KICAD9_SYMBOL_DIR}/" + n + ".kicad_sym" });
  // the reference was written by KiCad 9, before makeVariants: KiCad 10 adds an empty (variants) after (groups)
  assert.strictEqual(got.replace("\t(variants)\n", ""), want, firstDiff(want, got.replace("\t(variants)\n", "")));
});
test("KiCad netlist: a variant's differences are written under the component, (variants (variant (name …) (description …)))", () => {
  const dir = path.join(QA, "cli", "basic_test");
  const pr = project(dir, "basic_test", (f, t) => t.replace(/(\(path "\/[0-9a-f-]+"\s*\(reference "R1"\)\s*\(unit 1\))/, '$1 (variant (name "Lite") (dnp yes) (field (name "Value") (value "22k")))'));
  const got = NK.kicadNetlist({ sheets: pr.sheets, netlist: pr.nl, source: "basic_test.kicad_sch", date: "d", version: "10.0", variants: [{ name: "Lite", description: "No R1" }] });
  assert.ok(/\(variants\n\t\t\(variant\n\t\t\t\(name "Lite"\)\n\t\t\t\(description "No R1"\)\n\t\t\)\n\t\)/.test(got), got.slice(got.indexOf("(groups")));
  const r1 = got.slice(got.indexOf('(ref "R1")'), got.indexOf('(ref "R2")'));
  assert.ok(/\(variant\n\t+\(name "Lite"\)\n\t+\(property\n\t+\(name "dnp"\)\n\t+\(value "1"\)\n\t+\)\n\t+\(fields\n\t+\(field\n\t+\(name "Value"\) "22k"\)/.test(r1), r1);
});
test("Allegro: kicad-cli's basic_test netlist byte for byte (but the date), and the device files", () => {
  const dir = path.join(QA, "cli", "basic_test"), want = fs.readFileSync(path.join(dir, "basic_test.netlist.allegro"), "utf8");
  const pr = project(dir, "basic_test");
  const a = NK.allegroNetlist({ sheets: pr.sheets, netlist: pr.nl, source: /\(Source: (.*)\)/.exec(want)[1], date: /\(Date: (.*)\)/.exec(want)[1], version: "10.0" });
  assert.strictEqual(a.netlist, want, firstDiff(want, a.netlist));
  assert.deepStrictEqual([...a.devices.keys()].sort(), ["10k_resistor_smd_r_1206_3216metric.txt", "10u_capacitor_smd_c_1206_3216metric.txt", "conn_01x01_pin_testpoint_testpoint_pad_3_0x3_0mm.txt", "tlv2371dbv_package_to_sot_smd_sot-23-5.txt"]);
  assert.strictEqual(a.devices.get("tlv2371dbv_package_to_sot_smd_sot-23-5.txt"),
    "PACKAGE 'sot-23-5'\nCLASS IC\nPINCOUNT 5\nPINORDER MAIN ,\n\t__1,\n\tV-__2,\n\t+__3,\n\t-__4,\n\tV+__5\nFUNCTION MAIN MAIN ,\n\t1,\n\t2,\n\t3,\n\t4,\n\t5\nPACKAGEPROP VALUE TLV2371DBV\nEND\n");
});
test("Allegro helpers: formatText, formatDevice, formatRoom", () => {
  assert.strictEqual(NK.allegroText("10µF"), "10uF");
  assert.strictEqual(NK.allegroText("a b"), "'a b'");
  assert.strictEqual(NK.allegroText("it's"), "'it?s'");
  assert.strictEqual(NK.allegroDevice("10k_R:0603"), "10k_r_0603");
  assert.strictEqual(NK.allegroRoom("/Power Supply/Sub/", "top"), "Power_Supply-Sub");
  assert.strictEqual(NK.allegroRoom("/", "my board"), "my_board");
});
test("stacked pin notation and page order helpers", () => {
  assert.deepStrictEqual(NK.expandStackedPins("[1-3,5]").nums, ["1", "2", "3", "5"]);
  assert.deepStrictEqual(NK.expandStackedPins("[A1-A3]").nums, ["A1", "A2", "A3"]);
  assert.strictEqual(NK.expandStackedPins("[1-").valid, false);
  assert.ok(NK.comparePageNum("2", "10") < 0 && NK.comparePageNum("10", "A") < 0 && NK.comparePageNum("", "3") > 0);
});

// ---------------------------------------------------------------- the SPICE .subckt model
const SPICE = fs.existsSync(path.join(QA, "eeschema", "spice_netlists")) ? path.join(QA, "eeschema", "spice_netlists") : null;
test("SPICE Model: .subckt <project> with its hierarchical-label ports, the port names on the items, .ends", () => {
  const dir = path.join(SPICE, "rectifier");
  const pr = project(dir, "rectifier", (f, t) => t.replace('(label "in" (at 134.62 96.52 0)', '(hierarchical_label "in" (shape input) (at 134.62 96.52 0)').replace('(label "out" (at 165.1 96.52 0)', '(hierarchical_label "out" (shape output) (at 165.1 96.52 0)'));
  const sheets = pr.nl.instances.map((i) => ({ index: i.index, uuidPath: i.uuidPath, doc: pr.root.doc }));
  const h = SP.readHierarchy({ sheets, netMap: pr.nl.netMap, symbolPins: helpers.symbolPins, isPower: helpers.isPower, project: "rectifier" });
  assert.deepStrictEqual([...h.ports.entries()], [["/in", { name: "in", shape: "input" }], ["/out", { name: "out", shape: "output" }]]);
  const out = SP.spiceNetlist({ symbols: h.symbols, texts: h.texts, options: 0, library: (p) => { const f = path.join(dir, p); return fs.existsSync(f) ? SL.parseSpiceLibrary(fs.readFileSync(f, "utf8")) : null; }, subckt: { name: "rectifier", ports: h.ports } });
  assert.ok(out.startsWith("*\n\n.subckt rectifier\n+       in ; input\n+       out ; output\n\n\n.include \"diode.lib\"\n"), out);
  assert.ok(/^D1 in out DIODE1 ?$/m.test(out) && /^R1 out GND 10k ?$/m.test(out), out);
  assert.ok(out.endsWith("\n\n.ends\n") && !out.includes(".title") && !/^\.end$/m.test(out), out);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
