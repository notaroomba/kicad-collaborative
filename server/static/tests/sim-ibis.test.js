// sim-ibis.test.js — IBIS in the Simulation Model Editor (web/dialogs/sim-ibis.ts and the SIM_LIBRARY_IBIS /
// SIM_MODEL_IBIS side of web/dialogs/sim-model-logic.ts): the reader, the pins and their models, Differential, the
// KIBIS waveform types and the Sim.Ibis.Pin / Sim.Ibis.Model / Sim.Ibis.Diff fields.
// Run: node server/static/tests/sim-ibis.test.js
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/sim-model-logic.ts");
L.setNgspiceData(load("dialogs/sim-model-ngspice.ts").NGSPICE);
const I = load("dialogs/sim-ibis.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 12).join("\n       ")); } }
console.log("IBIS simulation models under node");

const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema");
const qa = (n) => { const p = path.join(QA, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
const row = (name, value, show = true) => ({ name, value, show });
const mk = (name, value, visible) => ({ name, value, show: visible });
const clone = (r) => ({ ...r });
const V11 = `[IBIS Ver] 1.1
[Comment char] #_char
[File name] v.ibs
[Component] Virtual
[Manufacturer] KiCad
[Package]
R_pkg 1m 1m 1m
[Pin] signal_name model_name
1 VCC POWER
2 GND GND
3 X Input   # the input
4 Y Output
[Model] Input
Model_type Input
[Model] Output
Model_type Output
[END]
`;
const DIFF = `[IBIS Ver] 5.1
[Component] Pair
[Manufacturer] KiCad
[Pin] signal_name model_name R_pin L_pin C_pin
1 P DQ 1m NA NA
2 N DQ 1m NA NA
3 S SW
4 T SW
5 G GND
[Diff Pin] inv_pin vdiff tdelay_typ
1 2 0.2 0
[Series Pin Mapping] pin_2 model_name
3 4 SW
[Model Selector] DQ
DQ40 Data
DQ60 Data 60
[Model] DQ40
Model_type I/O
[Model] DQ60
Model_type I/O
[Model] SW
Model_type Series_switch
[END]
`;
const symPins = [{ number: "1", name: "GND" }, { number: "2", name: "IO" }, { number: "3", name: "IO2" }];
const fields = (extra = []) => [row("Reference", "U1"), row("Value", "X"), row("Footprint", "", false), row("Datasheet", "", false), row("Description", "", false), ...extra];
const session = (rows, text, p = "chip.ibs") => {
  const s = new L.SimSession(rows, { prefix: "U", pins: symPins, unitCount: 1 }, mk, clone);
  const b = s.begin(); assert.strictEqual(b.libraryPath, p); s.finishBegin(text); return s;
};

test("parser: components, pins with their models, comment char, [END]", () => {
  const k = I.parseIbis(V11);
  assert.ok(k.valid, k.errors.join("; "));
  assert.deepStrictEqual(k.components.map((c) => c.name), ["Virtual"]);
  assert.deepStrictEqual(k.components[0].pins.map((p) => [p.number, p.signal, p.models.join(",")]), [["1", "VCC", ""], ["2", "GND", ""], ["3", "X", "Input"], ["4", "Y", "Output"]]);
  assert.deepStrictEqual(k.models, [{ name: "Input", type: "Input" }, { name: "Output", type: "Output" }]);
});
test("parser: [Model Selector], [Diff Pin] and [Series Pin Mapping]", () => {
  const k = I.parseIbis(DIFF); assert.ok(k.valid, k.errors.join("; "));
  const c = k.components[0];
  assert.deepStrictEqual(c.pins[0].models, ["DQ40", "DQ60"]);
  assert.strictEqual(c.pins[0].complementary, "2"); assert.strictEqual(c.pins[1].complementary, "1"); assert.strictEqual(c.pins[2].complementary, "");
  assert.strictEqual(I.seriesPartner(c, "4"), "3");
  assert.ok(I.isSeriesSwitchType("Series_switch") && I.isSeriesType("Series") && !I.isSeriesType("I/O"));
});
test("parser: a file without [IBIS Ver] is invalid", () => {
  const k = I.parseIbis("[Component] A\n[Pin] s m\n1 A B\n"); assert.strictEqual(k.valid, false);
  const lib = L.parseIbisLibrary("[Component] A\n", "x.ibs"); assert.deepStrictEqual(lib.errors, ["Invalid IBIS file 'x.ibs'"]);
});
test("parser: the QA IBIS files read", () => {
  for (const n of ["ibis_v1_1.ibs", "ibis_v4_1_series_pin_mapping.ibs", "ibis_v5_1.ibs", "ibis_v4_1_r_series.ibs"]) {
    const t = qa(n); if (t === null) continue;
    const k = I.parseIbis(t); assert.ok(k.valid, n + ": " + k.errors.join("; ")); assert.ok(k.components.length >= 1, n);
  }
  const t = qa("ibis_v5_1.ibs");
  if (t) { const c = I.parseIbis(t).components[0]; assert.deepStrictEqual(c.pins.find((p) => p.number === "B2").models, ["DQ40", "DQ40_ODT40"]); assert.deepStrictEqual(c.pins.find((p) => p.number === "A1").models, []); }
});
test("SIM_LIBRARY_IBIS: one KIBIS_DEVICE per component, single-ended pins GND / IN/OUT", () => {
  const lib = L.parseIbisLibrary(V11, "v.ibs");
  assert.deepStrictEqual(lib.models.map((m) => [m.name, m.model.type]), [["Virtual", "KIBIS_DEVICE"]]);
  const m = lib.models[0].model;
  assert.deepStrictEqual(m.pins.map((p) => `${p.symbolPinNumber}=${p.name}`), ["1=GND", "2=IN/OUT"]);
  assert.deepStrictEqual(m.params.map((p) => `${p.info.name}=${p.value}`), ["vcc=typ", "rpin=typ", "lpin=typ", "cpin=typ"]);
  assert.ok(!/\.model/i.test(L.preview(m, { refName: "", modelName: "Virtual", baseModelName: "" })), "no .model line for an IBIS device");
});
test("the dialog: pin, model, waveform and the fields it writes", () => {
  const rows = fields([row("Sim.Library", "chip.ibs", false), row("Sim.Name", "Virtual", false)]);
  const s = session(rows, V11);
  assert.ok(s.ibisLoaded());
  assert.deepStrictEqual(s.ibisPinLabels(), ["1 - VCC", "2 - GND", "3 - X", "4 - Y"]);
  assert.deepStrictEqual(s.ibisModelChoices(), []);
  s.selectIbisPin(3); assert.deepStrictEqual(s.ibisModelChoices(), ["Output"]); assert.strictEqual(s.ibisModelValue, "Output", "the only model is selected");
  assert.strictEqual(s.ibisCanDiff(), false);
  assert.deepStrictEqual(s.waveformChoices(), { items: ["Device", "DC driver", "Rectangular wave driver", "PRBS driver"], sel: 0 });
  s.selectWaveform("Rectangular wave driver");
  const m = s.curModel(); assert.strictEqual(m.type, "KIBIS_DRIVER_RECT");
  assert.deepStrictEqual(m.params.map((p) => p.info.name), ["vcc", "rpin", "lpin", "cpin", "ton", "toff", "td", "n"]);
  m.setParamValue("ton", "10n"); m.setParamValue("toff", "10n");
  const out = s.finish();
  const v = (n) => { const f = out.find((r) => r.name === n); return f ? f.value : undefined; };
  assert.strictEqual(v("Sim.Library"), "chip.ibs"); assert.strictEqual(v("Sim.Name"), "Virtual");
  assert.strictEqual(v("Sim.Ibis.Pin"), "4"); assert.strictEqual(v("Sim.Ibis.Model"), "Output"); assert.strictEqual(v("Sim.Ibis.Diff"), undefined);
  assert.strictEqual(v("Sim.Device"), "IBIS"); assert.strictEqual(v("Sim.Type"), "RECTDRIVER");
  assert.strictEqual(v("Sim.Pins"), "1=GND 2=IN/OUT");
  assert.strictEqual(v("Sim.Params"), "ton=10n toff=10n");
  // the dialog opened again shows the same pin, model and waveform
  const s2 = session(out.map(clone), V11);
  assert.strictEqual(s2.ibisPinSel, 3); assert.strictEqual(s2.ibisModelValue, "Output");
  assert.strictEqual(s2.curModel().type, "KIBIS_DRIVER_RECT"); assert.strictEqual(s2.curModel().findParam("ton").value, "10n");
  // a device keeps the IBIS fields too
  const out2 = s2.finish(); assert.strictEqual(out2.find((r) => r.name === "Sim.Ibis.Pin").value, "4");
});
test("the dialog: Differential only for a [Diff Pin] pin, Sim.Ibis.Diff=1 and three model pins", () => {
  const s = session(fields([row("Sim.Library", "chip.ibs", false), row("Sim.Name", "Pair", false)]), DIFF);
  s.selectIbisPin(0); assert.ok(s.ibisCanDiff()); assert.deepStrictEqual(s.ibisModelChoices(), ["DQ40", "DQ60"]); assert.strictEqual(s.ibisModelValue, "");
  s.selectIbisModel("DQ60"); s.setIbisDiff(true);
  assert.deepStrictEqual(s.curModel().pins.map((p) => p.name), ["GND", "+", "-"]);
  const out = s.finish(); const v = (n) => (out.find((r) => r.name === n) || {}).value;
  assert.strictEqual(v("Sim.Ibis.Diff"), "1"); assert.strictEqual(v("Sim.Ibis.Model"), "DQ60"); assert.strictEqual(v("Sim.Pins"), "1=GND 2=+ 3=-");
  const s2 = session(out.map(clone), DIFF); assert.ok(s2.ibisDiff); assert.deepStrictEqual(s2.curModel().pins.map((p) => p.name), ["GND", "+", "-"]);
  // a pin without a partner: the checkbox goes and the flag is not written
  s2.selectIbisPin(4); assert.strictEqual(s2.ibisCanDiff(), false);
  const out3 = s2.finish(); assert.strictEqual(out3.find((r) => r.name === "Sim.Ibis.Diff"), undefined);
});
test("the dialog: a Series_switch model makes PIN_A / PIN_B and a switch state", () => {
  const s = session(fields([row("Sim.Library", "chip.ibs", false), row("Sim.Name", "Pair", false)]), DIFF);
  s.selectIbisPin(2); assert.strictEqual(s.ibisModelValue, "SW"); s.selectIbisModel("SW");
  const m = s.curModel(); assert.deepStrictEqual(m.pins.map((p) => p.name), ["PIN_A", "PIN_B"]); assert.strictEqual(m.ibis.partnerPin, "4");
  assert.strictEqual(m.findParam("sw_state").value, "");
  assert.strictEqual(m.findParam("sw_state").info.defaultValue, "1");
});
test("the dialog: a non-IBIS library hides nothing new and writes no IBIS fields", () => {
  const s = new L.SimSession(fields([row("Sim.Library", "d.lib", false), row("Sim.Name", "D1", false)]), { prefix: "D", pins: symPins.slice(0, 2), unitCount: 1 }, mk, clone);
  s.begin(); s.finishBegin(".model D1 D(is=1n)\n");
  assert.strictEqual(s.ibisLoaded(), false);
  assert.ok(!s.finish().some((r) => r.name.startsWith("Sim.Ibis")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
