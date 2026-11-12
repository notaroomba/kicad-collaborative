// fp-wizard.test.js — the footprint editor's Footprint Wizard (web/editor/fpwizard*.ts): the "footprint_wizard"
// manifest scope, what a wizard's answer is checked into, the footprint it exports (at the origin, with a new
// footprint's header) and the Python runtime's side (kicad_wizard.web_op) on a legacy FootprintWizardBase wizard.
// Run: node server/static/tests/fp-wizard.test.js
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs"), os = require("os");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("editor/fpwizard-model.ts");
const T = load("plugins/types.ts");
const SX = load("canvas/sexpr.ts"), EX = load("canvas/export.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.message || e).toString().split("\n").slice(0, 30).join("\n       ")); } }
console.log("footprint wizard under node");

const manifest = (scopes) => ({ identifier: "com.example.wiz", name: "Wiz", description: "A wizard", runtime: { type: "web", entrypoint: "main.js" }, actions: [{ identifier: "qfn", name: "QFN", description: "QFN packages", scopes }] });
test("a manifest action may be of scope footprint_wizard (api.v1 PluginAction scope)", () => {
  assert.deepStrictEqual(T.validateManifest(manifest(["footprint_wizard"])), []);
  const bad = T.validateManifest(manifest(["footprint_editor"]));
  assert.ok(bad.some((b) => /footprint_wizard/.test(b)), JSON.stringify(bad));
});

test("a wizard's answer is checked into pages, values, messages and a footprint", () => {
  const st = M.wizardState({ name: "QFN", description: "QFN packages", pages: [{ name: "Pads", params: [{ name: "n", value: 16, units: "integer" }, { name: "pitch", value: "0.5", units: "mm", error: "too small" }] }, { name: "Package", params: [{ name: "style", value: "b", units: "a,b,c" }, { name: "ep", value: "1", units: "bool" }] }, null], footprint: "  " });
  assert.strictEqual(st.pages.length, 3);
  assert.deepStrictEqual(M.pageValues(st), [["16", "0.5"], ["b", "1"], []]);
  assert.strictEqual(st.pages[0].params[1].error, "too small");
  assert.strictEqual(st.footprint, null, "a blank footprint is no footprint");
  assert.strictEqual(M.buildMessage(st), "The wizard did not build a footprint.");
  assert.strictEqual(M.buildMessage(Object.assign({}, st, { messages: "Cannot build" })), "Cannot build");
  assert.strictEqual(M.buildMessage(Object.assign({}, st, { footprint: "(footprint \"x\")" })), "QFN packages", "a built footprint shows the wizard's description (RegenerateFootprint)");
  assert.deepStrictEqual(["mm", "mils", "degrees", "radians", "%", "integer", "float", "bool", "string", "a,b"].map(M.unitsLabel), ["mm", "mils", "deg", "rad", "%", "", "", "", "", ""]);
  assert.deepStrictEqual(M.wizardState("nonsense"), { name: "", description: "", pages: [], messages: "", footprint: null });
});

test("the exported footprint is at the origin with a new footprint's header; the rest is untouched", () => {
  const src = '(footprint "Ring_8" (version 20241229) (generator "kicad_collaborative_wizard") (generator_version "10.0") (layer "F.Cu") (at 10 20 90) (locked yes) (property "Reference" "REF**" (at 0 -8) (layer "F.Fab")) (pad "1" smd circle (at 5 0) (size 1.2 1.2) (layers "F.Cu" "F.Mask")))';
  const t = M.wizardFootprintTree(SX.parse(src), 20260728, SX.parse);
  assert.strictEqual(EX.serialize(t), '(footprint "Ring_8" (version 20260728) (generator "pcbnew") (generator_version "10.0") (layer "F.Cu") (property "Reference" "REF**" (at 0 -8) (layer "F.Fab")) (pad "1" smd circle (at 5 0) (size 1.2 1.2) (layers "F.Cu" "F.Mask")))');
});

const py = spawnSync("python3", ["--version"]);
if (py.status !== 0) console.log("  skip the Python wizard (no python3)");
else test("a legacy Python wizard answers describe / build / reset through kicad_wizard.web_op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpwiz-"));
  const script = [
    "import sys, json",
    "sys.path.insert(0, " + JSON.stringify(path.join(__dirname, "..", "..", "plugins", "python")) + ")",
    "import pcbnew, FootprintWizardBase, kicad_wizard",
    "class Ring(FootprintWizardBase.FootprintWizard):",
    "    GetName = lambda self: 'Test ring'",
    "    GetDescription = lambda self: 'A ring of pads'",
    "    GetValue = lambda self: 'Ring_%d' % self.parameters['Pads']['Count']",
    "    def GenerateParameterList(self):",
    "        self.AddParam('Pads', 'Count', self.uInteger, 8, min_value=2, max_value=64)",
    "        self.AddParam('Pads', 'Radius', self.uMM, 5, min_value=1)",
    "        self.AddParam('Outline', 'Circle', self.uBool, True)",
    "    def CheckParameters(self):",
    "        pass",
    "    def BuildThisFootprint(self):",
    "        import math",
    "        n, r = self.parameters['Pads']['Count'], self.parameters['Pads']['Radius']",
    "        for i in range(n):",
    "            pad = pcbnew.PAD(self.module)",
    "            pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.2), pcbnew.FromMM(1.2)))",
    "            pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)",
    "            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)",
    "            pad.SetLayerSet(pad.SMDMask())",
    "            pad.SetPosition(pcbnew.VECTOR2I(int(r * math.cos(2 * math.pi * i / n)), int(r * math.sin(2 * math.pi * i / n))))",
    "            pad.SetNumber(str(i + 1))",
    "            self.module.Add(pad)",
    "        if self.parameters['Outline']['Circle']:",
    "            self.draw.Circle(0, 0, r + pcbnew.FromMM(1.5))",
    "w = Ring()",
    "out = [kicad_wizard.web_op(w, {'op': 'describe'}), kicad_wizard.web_op(w, {'op': 'build', 'values': [['12', '4'], ['0']]}),",
    "       kicad_wizard.web_op(w, {'op': 'build', 'values': [['1', '4']]}), kicad_wizard.web_op(w, {'op': 'reset'})]",
    "print(json.dumps(out))",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "t.py"), script);
  const r = spawnSync("python3", ["-I", path.join(dir, "t.py")], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  const [d, b, bad, reset] = JSON.parse(r.stdout.trim().split("\n").pop()).map(M.wizardState);
  assert.deepStrictEqual(d.pages.map((p) => p.name), ["Pads", "Outline"]);
  assert.deepStrictEqual(M.pageValues(d), [["8", "5"], ["1"]]);
  assert.strictEqual(d.name, "Test ring");
  assert.strictEqual((d.footprint.match(/\(pad /g) || []).length, 8);
  assert.ok(/^\(footprint "Ring_8"/.test(d.footprint), d.footprint.slice(0, 40));
  assert.strictEqual((b.footprint.match(/\(pad /g) || []).length, 12);
  assert.ok(/\(fp_circle /.test(d.footprint) && !/\(fp_circle /.test(b.footprint), "the outline follows its checkbox");
  assert.strictEqual(bad.footprint, null);
  assert.ok(/below minimum/.test(bad.pages[0].params[0].error), JSON.stringify(bad.pages[0].params[0]));
  assert.ok(/Parameters have errors/.test(M.buildMessage(bad)), bad.messages);
  assert.deepStrictEqual(M.pageValues(reset), [["8", "5"], ["1"]]);
  assert.ok(reset.footprint);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
