// sweep6-spice.test.js — File > Export > Netlist > SPICE as NETLIST_EXPORTER_SPICE writes it (sim/spice-netlist.ts):
// the hierarchy read (symbols by uuid, power / # references skipped, pins in StrNumCmp order with their nets, an
// unconnected pin NC-<n>), the library .include, model lines, .save / .probe options, directives, item lines, .end;
// against the rectifier schematic of qa/data/eeschema/spice_netlists.
// Run: node server/static/tests/sweep6-spice.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
console.log("SPICE netlist export under node");
const esbuild = require("esbuild");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const SP = load("sim/spice-netlist.ts"), SL = load("dialogs/sim-model-logic.ts");
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "spice_netlists");
const QA2 = fs.existsSync(QA) ? QA : "/home/claude/kicad-collaborative/qa/data/eeschema/spice_netlists";

function exportDir(name, options, edit) {
  const dir = path.join(QA2, name);
  let text = fs.readFileSync(path.join(dir, name + ".kicad_sch"), "utf8"); if (edit) text = edit(text);
  const doc = K.parseDoc(text, "kicad_sch"), uuid = String((K.kid(K.parse(text), "uuid") || [])[1]);
  const root = { doc, uuid, file: name + ".kicad_sch" };
  const nl = N.buildNetlist(root, () => null, helpers, name);
  const sheets = nl.instances.map((i) => ({ index: i.index, uuidPath: i.uuidPath, doc }));
  const { symbols, texts } = SP.readHierarchy({ sheets, netMap: nl.netMap, symbolPins: helpers.symbolPins, isPower: helpers.isPower, project: name });
  return SP.spiceNetlist({ symbols, texts, options, library: (p) => { const f = path.join(dir, p); return fs.existsSync(f) ? SL.parseSpiceLibrary(fs.readFileSync(f, "utf8")) : null; } });
}
const ALL = SP.OPTION_SAVE_ALL_VOLTAGES | SP.OPTION_SAVE_ALL_CURRENTS | SP.OPTION_SIM_COMMAND;

test("rectifier: the netlist KiCad writes (title, include, saves, directive, items by uuid, end)", () => {
  const out = exportDir("rectifier", ALL);
  const lines = out.split("\n");
  assert.strictEqual(lines[0], ".title KiCad schematic");
  assert.strictEqual(lines[1], '.include "diode.lib"');
  assert.ok(lines.includes(".save all") && lines.includes(".probe alli") && lines.includes(".tran 1u 10m"), out);
  assert.ok(/^D1 \/in \/out DIODE1 ?$/m.test(out), out);
  assert.ok(/^R1 \/out GND 10k ?$/m.test(out), out);
  assert.ok(/^C1 \/out GND 10u ?$/m.test(out), out);
  assert.ok(/^V1 \/in GND DC 0 SIN\( 0 5 1k \) ?$/m.test(out), out);
  assert.strictEqual(lines[lines.length - 2], ".end");
  // KiCad 10 writes no blank line between the directives and the items (the QA file predates it); items by uuid
  assert.deepStrictEqual(lines.slice(5, 9).map((l) => l.split(" ")[0]), ["V1", "C1", "D1", "R1"]);
});
test("without the simulation-command option the directive is left out; without saves no .save / .probe", () => {
  const out = exportDir("rectifier", 0);
  assert.ok(!out.includes(".tran") && !out.includes(".save all") && !out.includes(".probe"), out);
});
test("convertToSpiceMarkup: unescapes, spaces to underscores, leading slash kept", () => {
  assert.strictEqual(SP.convertToSpiceMarkup("/a{slash}b c"), "/a/b_c");
});

// ---------------------------------------------------------------- OrcadPCB2 / CadStar / PADS against kicad-cli's output
const NFM = load("sim/netlist-formats.ts");
const CLI = fs.existsSync(path.join(QA2, "..", "..", "cli")) ? path.join(QA2, "..", "..", "cli", "basic_test") : "/home/claude/kicad-collaborative/qa/data/cli/basic_test";
function basicNetlist() {
  const text = fs.readFileSync(path.join(CLI, "basic_test.kicad_sch"), "utf8");
  const doc = K.parseDoc(text, "kicad_sch"), uuid = String((K.kid(K.parse(text), "uuid") || [])[1]);
  return N.buildNetlist({ doc, uuid, file: "basic_test.kicad_sch" }, () => null, helpers, "basic_test");
}
const ref = (f) => fs.readFileSync(path.join(CLI, "basic_test.netlist." + f), "utf8");
test("OrcadPCB2: kicad-cli's basic_test netlist, byte for byte (but the time)", () => {
  const want = ref("orcadpcb2"), stamp = /created  (\S+) \}/.exec(want)[1];
  const got = NFM.orcadPcb2(basicNetlist(), new Date()).replace(/created  \S+ \}/, `created  ${stamp} }`);
  assert.strictEqual(got, want);
});
test("PADS: kicad-cli's basic_test netlist, byte for byte", () => { assert.strictEqual(NFM.pads(basicNetlist()), ref("pads")); });
test("CadStar: kicad-cli's basic_test netlist, byte for byte (but the time and the build)", () => {
  const want = ref("cadstar"), t = /^\.TIM (.*)$/m.exec(want)[1], app = /^\.APP "Eeschema (.*)"$/m.exec(want)[1];
  assert.strictEqual(NFM.cadstar(basicNetlist(), new Date(), app).replace(/^\.TIM .*$/m, ".TIM " + t), want);
});
test("PADS / OrcadPCB2: the value's field references resolved (GetValue( RESOLVED )): V1 is V_SIN", () => {
  const text = fs.readFileSync(path.join(QA2, "rectifier", "rectifier.kicad_sch"), "utf8");
  const doc = K.parseDoc(text, "kicad_sch"), uuid = String((K.kid(K.parse(text), "uuid") || [])[1]);
  const nl = N.buildNetlist({ doc, uuid, file: "rectifier.kicad_sch" }, () => null, helpers, "rectifier");
  assert.ok(/^V1 {15}V_SIN$/m.test(NFM.pads(nl)), NFM.pads(nl));
});
test("iso8601: GetISO8601CurrentDateTime's shape", () => { assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/.test(NFM.iso8601(new Date()))); });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
