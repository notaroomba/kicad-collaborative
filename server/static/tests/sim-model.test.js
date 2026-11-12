// sim-model.test.js — DIALOG_SIM_MODEL's model side (web/dialogs/sim-model-logic.ts): SIM_VALUE notation, StrNumCmp,
// InferSimModel, the Sim.Params / Sim.Pins serializer, WriteFields' erase / append-hidden rules, the SPICE library
// reader and the Code page preview.  Run: node server/static/tests/sim-model.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/sim-model-logic.ts");
L.setNgspiceData(load("dialogs/sim-model-ngspice.ts").NGSPICE);
const D = load("dialogs/sim-model-data.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.message || e).toString().split("\n").slice(0, 30).join("\n       ")); } }
console.log("simulation model logic under node");

const row = (name, value, show = true) => ({ name, value, show });
const mk = (name, value, visible) => ({ name, value, show: visible, added: true });
const clone = (r) => ({ ...r });
const base = (value, extra = []) => [row("Reference", "R1"), row("Value", value), row("Footprint", "", false), row("Datasheet", "", false), row("Description", "", false), ...extra];
const pins2 = [{ number: "1", name: "~" }, { number: "2", name: "~" }];
const dump = (rows) => rows.map((r) => `${r.name}=${r.value}${r.show ? "" : " (hidden)"}`);

test("tables come from the C++: devices in DEVICE_T order, Device: menu entries", () => {
  const menu = D.DEVICES.filter((d) => d[3] && d[2]).map((d) => d[2]);
  assert.deepStrictEqual(menu, ["Resistor", "Capacitor", "Inductor", "Mutual Inductance Statement", "Transmission Line", "Switch", "Diode", "NPN BJT", "PNP BJT", "N-channel JFET", "P-channel JFET", "N-channel MESFET", "P-channel MESFET", "N-channel MOSFET", "P-channel MOSFET", "Voltage Source", "Current Source", "XSPICE Code Model", "Raw SPICE Element"]);
  assert.strictEqual(L.typeInfo("V_PULSE").fieldValue, "PULSE");
  assert.strictEqual(L.spiceInfo("NMOS_BSIM4").level, "14");
  const m = L.createModel("NMOS_BSIM4"); assert.ok(m.params.length > 300, String(m.params.length));
  assert.deepStrictEqual(L.createModel("D").pinNames(), ["A", "K"]);
  assert.deepStrictEqual(L.createModel("V_PULSE").params.map((p) => p.info.name).slice(0, 8), ["y1", "y2", "td", "tr", "tf", "tw", "per", "np"]);
  assert.strictEqual(L.createModel("SW_V").params[4].value, "none", "enum params start at their default");
});

test("SIM_VALUE: ConvertNotation / ToSpice / Normalize / {:g}", () => {
  assert.strictEqual(L.toSpice("10k"), "10k");
  assert.strictEqual(L.toSpice("4.7M"), "4.7Meg");
  assert.strictEqual(L.toSpice("1500"), "1500");
  assert.strictEqual(L.toSpice("1u"), "1u");
  assert.strictEqual(L.toSpice("1/tstop"), "1/tstop");
  assert.strictEqual(L.convertNotation("2.2Meg", "SPICE", "SI"), "2.2M");
  assert.strictEqual(L.convertNotation("1,5k", "SI", "SI"), "1.5k");
  assert.strictEqual(L.normalize(0.0047), "4.7m");
  assert.strictEqual(L.fmtG(1e12), "1e+12");
  assert.strictEqual(L.fmtG(0.0001), "0.0001");
  assert.strictEqual(L.fmtG(123456789), "1.23457e+08");
  assert.ok(L.isValidValue("10k") && L.isValidValue("1e-3") && !L.isValidValue("10kk") && !L.isValidValue("abc"));
  assert.ok(L.isValidValue("2Meg", "FLOAT", "SPICE") && !L.isValidValue("2.5", "INT"));
});

test("StrNumCmp (ignore case) orders pin numbers as KiCad does", () => {
  const s = ["10", "2", "A1", "a2", "1", "B"].sort((a, b) => L.strNumCmp(a, b));
  assert.deepStrictEqual(s, ["1", "2", "10", "A1", "a2", "B"]);
});

test("InferSimModel: R '10k' -> r=\"10k\", pins '1=+ 2=-'; thousands/decimal separators; Meg -> M", () => {
  let r = L.inferSimModel("R", ["1", "2"], base("10k"));
  assert.deepStrictEqual([r.ok, r.deviceType, r.modelType, r.params, r.pinMap], [true, "R", "", 'r="10k"', "1=+ 2=-"]);
  assert.strictEqual(L.inferSimModel("C", ["1", "2"], base("3,300u")).params, 'c="3300u"');
  assert.strictEqual(L.inferSimModel("C", ["1", "2"], base("3,3u")).params, 'c="3.3u"');
  assert.strictEqual(L.inferSimModel("R", ["1", "2"], base("4k7")).params, 'r="4.7k"');
  assert.strictEqual(L.inferSimModel("R", ["1", "2"], base("2.2Meg")).params, 'r="2.2M"');
  assert.strictEqual(L.inferSimModel("C", ["1", "2"], base("100µF")).params, 'c="100u"');
  const b = L.inferSimModel("R", ["1", "2"], base("V(1)*2"));
  assert.deepStrictEqual([b.modelType, b.params], ["=", 'r="V(1)*2"']);
  const v = L.inferSimModel("V", ["1", "2"], [row("Reference", "V1"), row("Value", "DC 5")]);
  assert.deepStrictEqual([v.deviceType, v.modelType, v.params], ["V", "DC", 'dc="5" ']);
  assert.strictEqual(L.inferSimModel("R", ["1", "2", "3"], base("10k")).ok, false);
  assert.strictEqual(L.inferSimModel("U", ["1", "2"], base("10k")).ok, false);
});

test("Sim.Params / Sim.Pins parse and serialize (quotes, escapes, flags, StrNumCmp order)", () => {
  assert.deepStrictEqual(L.parseParamsField(' r="10k" model="a \\"b\\" c" off '), [{ name: "r", value: "10k" }, { name: "model", value: 'a "b" c' }, { name: "off", value: "1", flag: true }]);
  assert.throws(() => L.parseParamsField("r"));
  const m = L.createModel("V_PULSE"); L.readDataFields(m, null, ["10", "2"]);
  assert.deepStrictEqual(m.pins.map((p) => p.symbolPinNumber), ["10", "2"]);
  assert.strictEqual(L.generatePins(m), "2=- 10=+");
  m.setParamValue("y2", "5"); m.setParamValue("tw", "1m");
  assert.strictEqual(L.generateParams(m), 'y1=0 y2=5 td=0 tr=0 tf=0 tw=1m', "a source fills every preceding value (SIM_MODEL_SOURCE autofill)");
  const p = L.createModel("V_PWL"); p.setParamValue("pwl", "0 0 1m 5");
  assert.strictEqual(L.generateParams(p), 'pwl="0 0 1m 5"');
});

/** The dialog run: rows in, OK pressed (finish), rows out. */
function run(rows, ctx, act) {
  const s = new L.SimSession(rows, Object.assign({ prefix: "R", pins: pins2, unitCount: 1 }, ctx), mk, clone);
  s.begin(); s.finishBegin(null); if (act) act(s); return { s, out: s.finish() };
}

test("R '10k' with Save in Value on: Sim.Device / Sim.Pins written, Value stays '10k', no Sim.Params", () => {
  const { s, out } = run(base("10k"));
  assert.strictEqual(s.source, "builtin"); assert.strictEqual(s.curType, "R"); assert.strictEqual(s.storeInValue, true);
  assert.strictEqual(s.saveInValueLabel().label, "Save parameter 'Resistance (r)' in Value field");
  assert.deepStrictEqual(dump(out), ["Reference=R1", "Value=10k", "Footprint= (hidden)", "Datasheet= (hidden)", "Description= (hidden)", "Sim.Device=R", "Sim.Pins=1=+ 2=-"]);
});

test("R with Save in Value off: Sim.Params 'r=10k', Value put back verbatim (RestoreInferredValue)", () => {
  const { out } = run(base("10k"), {}, (s) => { s.storeInValue = false; });
  assert.deepStrictEqual(dump(out).slice(1), ["Value=10k", "Footprint= (hidden)", "Datasheet= (hidden)", "Description= (hidden)", "Sim.Device=R", "Sim.Params=r=10k", "Sim.Pins=1=+ 2=-"]);
});

test("a PULSE source: Sim.Device=V, Sim.Type=PULSE plus params, new fields hidden", () => {
  const rows = [row("Reference", "V1"), row("Value", "")];
  const { out } = run(rows, { prefix: "V" }, (s) => {
    s.selectDevice("Voltage Source"); s.selectType("Pulse");
    const m = s.curModel(); m.setParamValue("y1", "0"); m.setParamValue("y2", "3.3"); m.setParamValue("tw", "1u"); m.setParamValue("per", "2u");
  });
  assert.deepStrictEqual(dump(out), ["Reference=V1", "Value=", "Sim.Device=V (hidden)", "Sim.Type=PULSE (hidden)", "Sim.Pins=1=+ 2=- (hidden)", "Sim.Params=y1=0 y2=3.3 td=0 tr=0 tf=0 tw=1u per=2u (hidden)"]);
});

test("existing Sim.* fields are read back and re-written unchanged; erasing a model param erases Sim.Params", () => {
  const rows = [row("Reference", "D1"), row("Value", "1N4148"), row("Sim.Device", "D", false), row("Sim.Pins", "1=K 2=A", false), row("Sim.Params", "is=2.52n rs=0.568", false)];
  const { s, out } = run(rows, { prefix: "D" });
  assert.strictEqual(s.curType, "D");
  assert.deepStrictEqual(dump(out), dump(rows));
  const r2 = run(rows, { prefix: "D" }, (x) => { const m = x.curModel(); m.setParamValue("is", ""); m.setParamValue("rs", ""); }).out;
  assert.deepStrictEqual(dump(r2), ["Reference=D1", "Value=1N4148", "Sim.Device=D (hidden)", "Sim.Pins=1=K 2=A (hidden)"]);
});

test("pin assignment: a model pin goes to one symbol pin; Not Connected drops it", () => {
  const rows = [row("Reference", "Q1"), row("Value", "Q"), row("Sim.Device", "NPN", false), row("Sim.Type", "GUMMELPOON", false)];
  const pins = [{ number: "1", name: "B" }, { number: "2", name: "C" }, { number: "3", name: "E" }];
  const { s, out } = run(rows, { prefix: "Q", pins }, (x) => {
    assert.deepStrictEqual(x.pinRows().map((r) => r.symbol + "|" + r.model), ['1 ("B")|1 ("C")', '2 ("C")|2 ("B")', '3 ("E")|3 ("E")']);
    x.setPinAssignment(0, '2 ("B")'); x.setPinAssignment(1, '1 ("C")');
    assert.deepStrictEqual(x.pinRows()[0].choices, ['1 ("C")', '2 ("B")', '3 ("E")', "Not Connected"], "the optional substrate pin <S> is left out with three symbol pins");
  });
  void s;
  assert.strictEqual(out.find((r) => r.name === "Sim.Pins").value, "1=B 2=C 3=E");
});

test("SPICE library: .model and .subckt with continuations and comments; library model fields", () => {
  const text = `* test library
.model D1N4148 D(Is=2.52n Rs=.568 N=1.752 Cjo=4p M=.4 tt=20n mfg=OnSemi type=silicon)
.model DLT D(Is=1n Iave=200m Vpk=75)
.MODEL Q2N3904 NPN(IS=1E-14 VAF=100
+ BF=300 ; a tail comment
* a comment between continuations
+ CJE=4.5P)
.subckt OPAMP inp inn out vcc vee params: gain=1e5
E1 out 0 inp inn {gain}
.ends OPAMP
`;
  const lib = L.parseSpiceLibrary(text);
  assert.deepStrictEqual(lib.models.map((m) => [m.name, m.model.type, m.model.fallback]), [["D1N4148", "D", false], ["DLT", "D", true], ["Q2N3904", "NPN_GUMMELPOON", false], ["OPAMP", "SUBCKT", false]], "an unknown parameter (Iave) makes a SIM_MODEL_SPICE_FALLBACK");
  const d = lib.models[0].model; assert.strictEqual(d.findParam("is").value, "2.52n"); assert.strictEqual(d.findParam("rs").value, ".568");
  assert.strictEqual(lib.models[2].model.findParam("cje").value, "4.5p");
  assert.deepStrictEqual(lib.models[3].model.pins.map((p) => p.name), ["inp", "inn", "out", "vcc", "vee"]);
  const rows = [row("Reference", "U1"), row("Value", "OPAMP"), row("Sim.Library", "models/test.lib", false), row("Sim.Name", "OPAMP", false)];
  const pins = ["1", "2", "3", "4", "5"].map((n) => ({ number: n, name: "" }));
  const s = new L.SimSession(rows, { prefix: "U", pins, unitCount: 1 }, mk, clone);
  assert.strictEqual(s.begin().libraryPath, "models/test.lib"); s.finishBegin(text);
  assert.strictEqual(s.curType, "SUBCKT"); assert.deepStrictEqual(s.modelNames(), ["D1N4148", "DLT", "OPAMP", "Q2N3904"]); assert.deepStrictEqual(s.modelNames("Q2"), ["Q2N3904"]);
  const out = s.finish();
  assert.deepStrictEqual(dump(out), ["Reference=U1", "Value=OPAMP", "Sim.Library=models/test.lib (hidden)", "Sim.Name=OPAMP (hidden)", "Sim.Device=SUBCKT (hidden)", "Sim.Pins=1=inp 2=inn 3=out 4=vcc 5=vee (hidden)"]);
});

test("an unreadable library keeps the symbol's model fields and shows <unknown>", () => {
  const rows = [row("Reference", "U1"), row("Value", "X"), row("Sim.Library", "gone.lib", false), row("Sim.Name", "X", false), row("Sim.Device", "SUBCKT", false), row("Sim.Pins", "1=a 2=b", false)];
  const s = new L.SimSession(rows, { prefix: "U", pins: pins2, unitCount: 1 }, mk, clone); s.begin(); s.finishBegin(null);
  assert.deepStrictEqual(s.modelNames(), ["<unknown>"]);
  assert.deepStrictEqual(dump(s.finish()), dump(rows));
});

test("Code page preview: ideal R, DC and PULSE sources, a diode .model, raw SPICE", () => {
  const prev = (rows, ctx, act) => { const s = new L.SimSession(rows, Object.assign({ prefix: "R", pins: pins2, unitCount: 1 }, ctx), mk, clone); s.begin(); s.finishBegin(null); if (act) act(s); return s.previewText(); };
  assert.strictEqual(prev(base("10k")), "R NC--0 NC--1 10k");
  assert.strictEqual(prev([row("Reference", "V1"), row("Value", "5")], { prefix: "V" }), "V NC--0 NC--1 DC 5");
  assert.strictEqual(prev([row("Reference", "V1"), row("Value", "x"), row("Sim.Device", "V"), row("Sim.Type", "PULSE"), row("Sim.Params", "y1=0 y2=1 td=0 tr=1n tf=1n tw=1u")], { prefix: "V" }),
    "V NC--0 NC--1 PULSE( 0 1 0 1n 1n 1u 0 1 )");
  assert.strictEqual(prev([row("Reference", "D1"), row("Value", "x"), row("Sim.Device", "D"), row("Sim.Params", "is=1n")], { prefix: "D" }), ".model D1 D\n+         is=1n\n\n\nD NC--0 NC--1 D1");
  assert.strictEqual(prev([row("Reference", "X1"), row("Value", "x"), row("Sim.Device", "SPICE"), row("Sim.Params", 'type="X" model="foo"')], { prefix: "X" }), "foo");
});

test("WriteFields drops non-adjacent duplicate names; OnEditSpiceModel merge keeps order and removes erased rows", () => {
  const rows = [row("A", "1"), row("B", "2"), row("A", "3")];
  const m = L.createModel("NONE"); L.writeFields(m, rows, mk);
  assert.deepStrictEqual(dump(rows), ["A=1", "B=2"]);
  const merged = L.mergeEditedFields([row("Reference", "R1"), row("Value", "1k"), row("Sim.Params", "r=1k", false)], [row("Reference", "R1"), row("Value", "2k"), mk("Sim.Device", "R", false)]);
  assert.deepStrictEqual(dump(merged), ["Reference=R1", "Value=2k", "Sim.Device=R (hidden)"]);
});

test("multi-unit symbols write Sim.Decomposition only in Repeat per unit mode", () => {
  const rows = [row("Reference", "U1"), row("Value", "x"), row("Sim.Device", "SPICE"), row("Sim.Params", 'model="foo"')];
  const r1 = run(rows, { prefix: "U", unitCount: 2 }, (s) => { s.decompositionRepeat = true; s.sharedPins = "4, 8"; }).out;
  assert.strictEqual(r1.find((r) => r.name === "Sim.Decomposition").value, "mode=repeat shared=4,8");
  const r2 = run(r1, { prefix: "U", unitCount: 2 }, (s) => { assert.deepStrictEqual([s.decompositionRepeat, s.sharedPins], [true, "4, 8"]); s.decompositionRepeat = false; }).out;
  assert.ok(!r2.some((r) => r.name === "Sim.Decomposition"));
});

const F = load("dialogs/sim-files.ts");
test("GetPrefix, every unit's pins without De Morgan, project and embedded model files", () => {
  assert.deepStrictEqual(["R12", "U?", "Q*", "SW~1", "#PWR01", ""].map(F.refPrefix), ["R", "U", "Q", "SW", "#PWR", ""]);
  const pin = (n, nm) => ["pin", "passive", "line", ["at", 0, 0, 0], ["length", 2.54], ["name", nm], ["number", n]];
  const lib = ["symbol", "X", ["symbol", "X_0_0", pin("7", "VSS")], ["symbol", "X_1_1", pin("1", "A")], ["symbol", "X_1_2", pin("1", "A")], ["symbol", "X_2_1", pin("2", "B")]];
  assert.deepStrictEqual(F.simPinsOfLib(lib).map((p) => p.number + p.name), ["7VSS", "1A", "2B"]);
  const single = ["symbol", "Y", ["symbol", "Y_1_1", pin("1", "A"), pin("1", "A2")]];
  assert.deepStrictEqual(F.simPinsOfLib(single).length, 2);
  const docs = [{ docId: "a", path: "m/x.lib", docType: "spice_model" }, { docId: "b", path: "top.kicad_sch", docType: "kicad_sch" }, { docId: "c", path: "y.SUB", docType: "other" }];
  assert.deepStrictEqual(F.projectModelFiles(docs).map((f) => f.path), ["m/x.lib", "y.SUB"]);
  const owner = ["symbol", "X", ["embedded_files", ["file", ["name", "d.lib"], ["type", "model"], ["data", "|KLUv|"]]]];
  assert.deepStrictEqual(F.embeddedModelFiles([owner, null]).map((f) => f.path), ["kicad-embed://d.lib"]);
});


// SCH_SYMBOL::ResolveTextVar: missing Sim.* fields read as "" on the canvas (other unknown names stay ${…})
global.window = global.window || global;
require(path.join(__dirname, "..", "kicad-canvas.js"));
{
  const K = global.KiCadCanvas || global.window.KiCadCanvas;
  const sch = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "u0") (paper "A4")
 (lib_symbols (symbol "L:R" (property "Reference" "R" (at 0 0 0)) (symbol "R_1_1" (rectangle (start -1 -2) (end 1 2)))))
 (symbol (lib_id "L:R") (at 50 50 0) (unit 1) (uuid "s1")
  (property "Reference" "R1" (at 52 48 0)) (property "Value" "1k" (at 52 50 0))
  (property "Note" "[\${SIM.PARAMS}][\${SIM.Params}][\${FOO}]" (at 52 52 0))))`;
  const doc = K.parseDoc(sch, "kicad_sch"); const it = doc.items.get("s1");
  const texts = it.geom.filter((g) => g.t === "text").map((g) => g.text || g.s || g.str || "");
  const note = texts.find((t) => /^\[/.test(t)) || JSON.stringify(it.geom.filter((g) => g.field === "Note"));
  const ok = note === "[][${SIM.Params}][${FOO}]";
  if (ok) { passed++; console.log("  ok   ${SIM.*} of a symbol without the field resolves to an empty string (case-sensitive)"); } else { failed++; console.log("  FAIL ${SIM.*} resolution: " + note); }
}
// SPICE_LIBRARY_PARSER: a .include brings the included file's models in where it stands (relative to the including file)
(async () => {
  try {
    const files = { "models/main.lib": `.model DA D(is=1n)\n.include "sub/more.lib"\n.INC 'missing.lib'\n.model DZ D(is=2n)\n.subckt X a b\n.include inner.lib\nR1 a b 1k\n.ends\n`,
      "models/sub/more.lib": `.model DB D(is=3n)\n.inc ../loop.lib\n`, "models/loop.lib": `.model DC D(is=4n)\n.include main.lib\n` };
    const tried = [];
    const read = async (c) => { tried.push(c.join("|")); for (const p of c) if (files[p] !== undefined) return files[p]; return null; };
    const errs = [];
    const text = await L.expandSpiceIncludes(files["models/main.lib"], "models/main.lib", read, errs);
    const lib = L.parseSpiceLibrary(text);
    assert.deepStrictEqual(lib.models.map((m) => m.name), ["DA", "DB", "DC", "DZ", "X"]);
    assert.deepStrictEqual(errs, ["File 'models/missing.lib' does not exist."]);
    assert.ok(/\.include inner\.lib/.test(lib.models.find((m) => m.name === "X").code), "a .include inside a .subckt stays in its code");
    assert.deepStrictEqual(L.includeCandidates("${KIPRJMOD}/x.lib", "models/a.lib"), ["${KIPRJMOD}/x.lib"]);
    assert.deepStrictEqual(L.includeCandidates("x.lib", "a.lib"), ["x.lib"]);
    passed++; console.log("  ok   .include: the included models in place, relative paths, a missing file reported, no cycles");
  } catch (e) { failed++; console.log("  FAIL .include: " + (e.stack || e)); }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
