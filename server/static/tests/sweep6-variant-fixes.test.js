// sweep6-variant-fixes.test.js — the design-variant and SPICE fixes of the sweep6 review:
//  - a variant's (in_bom …) read and written with the meaning the file's version gives it (positive from 20260306,
//    "excluded" before: sch_io_kicad_sexpr_parser.cpp:3934-3939);
//  - a sheet's variant holds no board / position-file flag; Toggle Attribute on a rule area or a sheet's Exclude
//    from Board keeps the item's own flag whatever the variant; the instance on screen takes the variant edit;
//  - undo / redo of a variant command swaps only the variants and registry entries it touched (a peer's survive);
//  - SPICE export: field texts resolved (GetShownText), sheets and rule areas excluded from simulation left out;
//  - ${REF:PROPERTY.…} and the board's text variables convert to ${uuid:…} as FOOTPRINT::ResolveTextVar resolves them;
//  - the footprint (attr …) with exclude_from_sim in the writer's order.
// Run: node server/static/tests/sweep6-variant-fixes.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
console.log("design variant and SPICE fixes under node");
const esbuild = require("esbuild");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const VM = load("canvas/variant-model.ts"), SP = load("sim/spice-netlist.ts"), SL = load("dialogs/sim-model-logic.ts"), X = load("editor/pcbdialogs/xref.ts");

const SYM = `(symbol (lib_id "Device:R") (at 50 50 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
  (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 0 0))
  (instances (project "demo" (path "/root-uuid" (reference "R1") (unit 1)) (path "/root-uuid/sheet2" (reference "R101") (unit 1)))))`;

test("variant in_bom: positive from 20260306, 'excluded' in older files (read and written alike)", () => {
  const s0 = K.parse(SYM);
  const cur = VM.setSymbolVariant(s0, "Lite", { flags: { excludedFromBOM: true } }, null, 20260306);
  assert.ok(K.serialize(cur).includes(`(variant (name "Lite") (in_bom no))`), K.serialize(cur));
  const old = VM.setSymbolVariant(s0, "Lite", { flags: { excludedFromBOM: true } }, null, 20250114);
  assert.ok(K.serialize(old).includes(`(variant (name "Lite") (in_bom yes))`), K.serialize(old));
  assert.equal(VM.symbolFlagsForVariant(old, "Lite", null, 20250114).excludedFromBOM, true);
  assert.equal(VM.symbolFlagsForVariant(old, "Lite", null, 20260306).excludedFromBOM, false, "the same token read as a new file: in the BOM");
  assert.equal(VM.symbolFlagsForVariant(cur, "Lite").excludedFromBOM, true, "no version: the current meaning");
  // the view writes the symbol's own (in_bom …), which is positive in every version
  assert.deepEqual(K.kid(VM.symbolViewForVariant(old, "Lite", null, 20250114), "in_bom"), ["in_bom", "no"]);
  assert.equal(VM.variantInBomPositive(20251012), false); assert.equal(VM.variantInBomPositive(20260306), true); assert.equal(VM.variantInBomPositive(0), true);
});

test("a sheet's variant writes no on_board / in_pos_files", () => {
  const sh = K.parse(`(sheet (at 10 10) (size 20 20) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "sh1")
    (property "Sheetname" "S" (at 0 0 0)) (property "Sheetfile" "s.kicad_sch" (at 0 0 0))
    (instances (project "demo" (path "/root-uuid" (page "2")))))`);
  const n = VM.setSymbolVariant(sh, "Lite", { flags: { excludedFromBoard: true, excludedFromPosFiles: true } });
  assert.ok(!K.serialize(n).includes("(variant"), K.serialize(n));
  const d = VM.setSymbolVariant(sh, "Lite", { flags: { dnp: true, excludedFromBoard: true } });
  assert.ok(K.serialize(d).includes(`(variant (name "Lite") (dnp yes))`), K.serialize(d));
});

test("the variant edit and view go to the instance asked for", () => {
  const n = VM.setSymbolVariant(K.parse(SYM), "Lite", { flags: { dnp: true } }, "/root-uuid/sheet2");
  assert.ok(K.serialize(n).includes(`(path "/root-uuid/sheet2" (reference "R101") (unit 1) (variant (name "Lite") (dnp yes)))`), K.serialize(n));
  assert.equal(VM.symbolFlagsForVariant(n, "Lite", "/root-uuid").dnp, false);
  assert.equal(VM.symbolFlagsForVariant(n, "Lite", "/root-uuid/sheet2").dnp, true);
});

const SCHDOC = (body) => K.parseDoc(`(kicad_sch (version 20260306) (generator "eeschema") (uuid "root-uuid") (paper "A4") (lib_symbols) ${body})`, "sch");
const ctxFor = (doc, ids, commits) => ({ doc, K, IU: 1e6, isSch: true, selection: new Set(ids), selected: { id: ids[0] }, viewOnly: false,
  commit(ch, label) { commits.push({ ch, label }); for (const c of ch) K.applyChange(doc, c, 1e6); }, toast() {}, setSelection() {}, setHighlight() {} });

test("Toggle Attribute with a variant: the instance on screen takes it; a rule area and a sheet's Exclude from Board keep their own flag", () => {
  const RA = `(rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra1")))`;
  const SH = `(sheet (at 100 10) (size 20 20) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "sh1") (property "Sheetname" "S" (at 0 0 0)) (property "Sheetfile" "s.kicad_sch" (at 0 0 0)) (instances (project "demo" (path "/root-uuid" (page "2")))))`;
  const doc = SCHDOC(SYM + RA + SH);
  const ids = [...doc.items.values()].filter((i) => i.kind === "rule_area" || i.kind === "sheet").map((i) => i.id);
  const ra = ids.find((id) => doc.items.get(id).kind === "rule_area"), sh = ids.find((id) => doc.items.get(id).kind === "sheet");
  const commits = [];
  globalThis.CollabEditor = { currentVariant: "Lite", currentSheetPathOf: () => "/root-uuid/sheet2" };
  try {
    assert.ok(sch.runAction("setDNP", ctxFor(doc, [ra], commits)));
    assert.ok(sch.runAction("setExcludeFromBoard", ctxFor(doc, [sh], commits)));
    assert.ok(sch.runAction("setDNP", ctxFor(doc, ["s1"], commits)));
  } finally { delete globalThis.CollabEditor; }
  assert.equal(commits.length, 3);
  assert.deepEqual(K.kid(doc.items.get(ra).node, "dnp"), ["dnp", "yes"], "the rule area's own DNP");
  assert.deepEqual(K.kid(doc.items.get(sh).node, "on_board"), ["on_board", "no"], "the sheet's own board flag");
  assert.ok(!K.serialize(doc.items.get(sh).node).includes("(variant"));
  const s = K.serialize(doc.items.get("s1").node);
  assert.ok(s.includes(`(path "/root-uuid/sheet2" (reference "R101") (unit 1) (variant (name "Lite") (dnp yes)))`), s);
  assert.ok(s.includes(`(path "/root-uuid" (reference "R1") (unit 1))`), "instance 1 untouched");
});

test("undo of a variant command swaps only the variants it touched: a peer's variant and edit survive", () => {
  const before = VM.setSymbolVariant(K.parse(SYM), "B", { flags: { dnp: true } });
  const after = VM.renameSymbolVariants(before, "B", "C");
  // a peer adds "Peer" and edits the Value meanwhile
  let now = VM.setSymbolVariant(after, "Peer", { flags: { excludedFromSim: true } });
  K.kids(now, "property")[1][2] = "22k";
  const undone = VM.restoreSymbolVariants(now, before, ["B", "C"]);
  const t = K.serialize(undone);
  assert.ok(t.includes(`(variant (name "B") (dnp yes)) (variant (name "Peer") (exclude_from_sim yes))`), t);
  assert.ok(!t.includes(`(name "C")`) && t.includes(`"22k"`), t);
  const redone = VM.restoreSymbolVariants(undone, after, ["B", "C"]);
  assert.ok(K.serialize(redone).includes(`(variant (name "C") (dnp yes)) (variant (name "Peer") (exclude_from_sim yes))`), K.serialize(redone));
  assert.equal(VM.restoreSymbolVariants(now, before, []), now, "nothing named: the same node");
  // the registry
  const b = new Map([["A", ""]]), a = new Map([["A", ""], ["Assembly", "x"]]);
  const delta = VM.registryDelta(b, a);
  assert.deepEqual(delta, [{ name: "Assembly", before: undefined, after: "x" }]);
  const peer = new Map([["A", ""], ["Assembly", "x"], ["Lite2", ""]]);
  VM.applyRegistryDelta(peer, delta, "before");
  assert.deepEqual([...peer.keys()], ["A", "Lite2"], "the peer's Lite2 stays");
  VM.applyRegistryDelta(peer, delta, "after");
  assert.deepEqual([...peer.keys()].sort(), ["A", "Assembly", "Lite2"]);
});

// ---------------------------------------------------------------- SPICE
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "spice_netlists");
const QA2 = fs.existsSync(QA) ? QA : "/home/claude/kicad-collaborative/qa/data/eeschema/spice_netlists";
function spice(edit, extra) {
  const dir = path.join(QA2, "rectifier");
  let text = fs.readFileSync(path.join(dir, "rectifier.kicad_sch"), "utf8"); if (edit) text = edit(text);
  const doc = K.parseDoc(text, "kicad_sch"), uuid = String((K.kid(K.parse(text), "uuid") || [])[1]);
  const nl = N.buildNetlist({ doc, uuid, file: "rectifier.kicad_sch" }, () => null, helpers, "rectifier");
  const sheets = nl.instances.map((i) => Object.assign({ index: i.index, uuidPath: i.uuidPath, doc }, (extra && extra.sheet) || {}));
  const { symbols, texts } = SP.readHierarchy(Object.assign({ sheets, netMap: nl.netMap, symbolPins: helpers.symbolPins, isPower: helpers.isPower, project: "rectifier" }, (extra && extra.input) || {}));
  return SP.spiceNetlist({ symbols, texts, options: SP.OPTION_SIM_COMMAND, library: (p) => { const f = path.join(dir, p); return fs.existsSync(f) ? SL.parseSpiceLibrary(fs.readFileSync(f, "utf8")) : null; } });
}
const R1_VALUE = /(\(property "Reference" "R1"[\s\S]*?\(property "Value" )"10K"/;

test("SPICE: a field's text variables and field references are resolved (GetShownText)", () => {
  const out = spice((t) => t.replace(R1_VALUE, `$1"\${RVAL}" (at 0 0 0)) (property "RVAL" "22k"`));
  assert.ok(/^R1 \/out GND 22k ?$/m.test(out), out);
  const out2 = spice((t) => t.replace(R1_VALUE, `$1"\${PROJVAL}"`), { input: { textVars: { PROJVAL: "47k" } } });
  assert.ok(/^R1 \/out GND 47k ?$/m.test(out2), out2);
  const out3 = spice((t) => t.replace(R1_VALUE, `$1"\${C1:VALUE}"`));
  assert.ok(/^R1 \/out GND 10u ?$/m.test(out3), out3);
});

test("SPICE: a symbol in a rule area excluded from simulation, and a sheet excluded from simulation, are left out", () => {
  const RA = `(rule_area (exclude_from_sim yes) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 164 97) (xy 167 97) (xy 167 103) (xy 164 103)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra-1")))`;
  const out = spice((t) => t.replace(/\)\s*$/, RA + ")"));
  assert.ok(!/^R1 /m.test(out), out);
  assert.ok(/^C1 /m.test(out), "the others stay");
  const RA2 = RA.replace("(exclude_from_sim yes)", "(exclude_from_sim no)");
  assert.ok(/^R1 /m.test(spice((t) => t.replace(/\)\s*$/, RA2 + ")"))));
  const gone = spice(null, { sheet: { sheetNode: ["sheet", ["exclude_from_sim", "yes"]] } });
  assert.ok(!/^(R1|C1|D1|V1) /m.test(gone) && !gone.includes(".tran"), gone);
});

// ---------------------------------------------------------------- cross-references
test("${REF:PROPERTY.x} and the board's text variables convert to ${uuid:…}", () => {
  const fp = K.parse(`(footprint "R:R" (layer "F.Cu") (uuid "u-r1") (property "Reference" "R1" (at 0 0)) (property "Value" "1k" (at 0 0)) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`);
  const fps = X.boardFootprints([{ kind: "footprint", node: fp }]);
  const vars = X.boardTextVarNames(JSON.stringify({ text_variables: { MYVAR: "x" } }), ["BOARDPROP"]);
  assert.equal(X.refsToKiids(fps, "${R1:PROPERTY.Library_Link}", vars), "${u-r1:PROPERTY.Library_Link}");
  assert.equal(X.refsToKiids(fps, "${R1:PROPERTY.Clearance_Override}", vars), "${R1:PROPERTY.Clearance_Override}", "an unset override has no value");
  assert.equal(X.refsToKiids(fps, "${R1:PROPERTY.Nope}", vars), "${R1:PROPERTY.Nope}");
  assert.equal(X.refsToKiids(fps, "${R1:TITLE} ${R1:COMMENT3} ${R1:MYVAR} ${R1:BOARDPROP}", vars), "${u-r1:TITLE} ${u-r1:COMMENT3} ${u-r1:MYVAR} ${u-r1:BOARDPROP}");
  assert.equal(X.refsToKiids(fps, "${R1:UNKNOWN}", vars), "${R1:UNKNOWN}");
});

test("footprint (attr …) carries exclude_from_sim in the writer's order", () => {
  const F = load("tools/props/footprint.ts");
  const n = K.parse(`(footprint "R:R" (layer "F.Cu") (attr smd dnp allow_missing_courtyard) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`);
  assert.equal(F.footprintAttrs(n).exclude_from_sim, false);
  F.setFootprintAttrs(n, { exclude_from_sim: true });
  assert.deepEqual(K.kid(n, "attr"), ["attr", "smd", "exclude_from_sim", "allow_missing_courtyard", "dnp"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
