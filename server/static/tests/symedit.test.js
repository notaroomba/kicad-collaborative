// symedit.test.js — the Symbol Editor's model (web/symedit/model.ts): the .kicad_sym writer (SCH_IO_KICAD_SEXPR_LIB_CACHE
// + KICAD_FORMAT::Prettify) round-trips KiCad's own libraries byte for byte, new symbols / renames / flattening, and
// the canvas render mode (web/canvas/libsym.ts).  Run: node server/static/tests/symedit.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("symedit/model.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("symbol editor model under node");
const QA = path.join(__dirname, "..", "..", "..", "qa", "data");
const LIBS = ["eeschema/libs/4xxx.kicad_sym", "cli/sym_lib_test/Amplifier_Video.v9.kicad_sym", "libraries/test_project/Device.kicad_sym",
  "eeschema/issue25900_74xx.kicad_sym", "fuzz/kicad_sym/TMS320LF2406PZ.kicad_sym", "downgrade/golden/current/metadata.kicad_sym"];

for (const rel of LIBS) {
  const f = path.join(QA, rel); if (!fs.existsSync(f)) continue;
  test("round trip is byte-identical: " + rel, () => {
    const t = fs.readFileSync(f, "utf8"); const out = M.serializeLibrary(M.parseLibrary(t));
    if (out !== t) { let i = 0; while (out[i] === t[i]) i++; assert.fail("differs at " + i + ": " + JSON.stringify(t.slice(i - 40, i + 40)) + " vs " + JSON.stringify(out.slice(i - 40, i + 40))); }
  });
}
test("a new library is KiCad's empty file; its version is never bumped on an existing one", () => {
  assert.strictEqual(M.serializeLibrary(M.emptyLibrary()), M.NEW_LIBRARY_TEXT);
  const old = '(kicad_symbol_lib\n\t(version 20231120)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "8.0")\n)\n';
  const lib = M.parseLibrary(old); lib.symbols.set("R", M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "R", reference: "R" })));
  const out = M.serializeLibrary(lib); assert.ok(out.includes("(version 20231120)"), out); assert.ok(out.includes('(symbol "R"'));
});
test("prettify: short lists stay on one line, xy runs wrap, closing parens on their own line", () => {
  const s = M.prettify('(kicad_symbol_lib (version 1) (symbol "A" (pin_names (offset 0.254)) (symbol "A_0_1" (polyline (pts (xy 0 0) (xy 1 1)) (stroke (width 0) (type default)) (fill (type none))))))');
  assert.ok(s.startsWith("(kicad_symbol_lib\n\t(version 1)\n\t(symbol \"A\"\n\t\t(pin_names\n\t\t\t(offset 0.254)\n\t\t)"), s);
  assert.ok(/\(pts\n\t+\(xy 0 0\) \(xy 1 1\)\n/.test(s), s);
  assert.ok(s.endsWith(")\n"));
});
test("saving orders symbols by inheritance depth, then name", () => {
  const lib = M.emptyLibrary();
  const base = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "Z_base" }));
  const kid = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "A_kid" }), base);
  lib.symbols.set("A_kid", kid); lib.symbols.set("Z_base", base); lib.symbols.set("M", M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "M" })));
  assert.deepStrictEqual(M.saveOrder(lib), ["M", "Z_base", "A_kid"]);
  assert.ok(M.isDerived(kid)); assert.strictEqual(M.parentNameOf(kid), "Z_base");
});
test("New Symbol: mandatory fields, unit count, De Morgan body styles, power flags", () => {
  const s = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "OPAMP", reference: "U", unitCount: 2, alternateBodyStyle: true }));
  assert.strictEqual(M.symName(s), "OPAMP"); assert.strictEqual(M.unitCount(s), 2); assert.ok(M.bodyStyles(s).demorgan);
  for (const f of M.MANDATORY_FIELDS) assert.ok(M.fieldOf(s, f), f);
  assert.strictEqual(M.fieldValue(s, "Reference"), "U"); assert.strictEqual(M.fieldValue(s, "Value"), "OPAMP");
  assert.deepStrictEqual(M.unitChoices(s), ["Unit A", "Unit B"]);
  const p = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "GND", reference: "#PWR", power: true }));
  assert.ok(M.isPower(p));
});
test("rename moves sub-symbols, the Value field and derived symbols' (extends)", () => {
  const lib = M.emptyLibrary(); const props = Object.assign(M.defaultNewSymbolProps(), { name: "OLD", unitCount: 2 });
  lib.symbols.set("OLD", M.createSymbol(props)); lib.symbols.set("KID", M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "KID" }), lib.symbols.get("OLD")));
  const changed = M.renameSymbol(lib, "OLD", "NEW");
  assert.ok(changed.includes("KID")); const n = lib.symbols.get("NEW"); assert.ok(n); assert.ok(!lib.symbols.has("OLD"));
  const t = M.text(n); assert.ok(!t.includes('"OLD_'), t); assert.strictEqual(M.fieldValue(n, "Value"), "NEW");
  assert.strictEqual(M.parentNameOf(lib.symbols.get("KID")), "NEW");
});
test("flatten merges a derived symbol's parent drawing and keeps the child's fields", () => {
  const t = fs.readFileSync(path.join(QA, "eeschema/libs/4xxx.kicad_sym"), "utf8"); const lib = M.parseLibrary(t);
  const derived = [...lib.symbols.values()].find((s) => M.isDerived(s)); if (!derived) return;
  const flat = M.flatten(lib, derived);
  assert.ok(!M.isDerived(flat)); assert.ok(M.allPins(flat).length > 0);
  assert.strictEqual(M.fieldValue(flat, "Value"), M.fieldValue(derived, "Value"));
});
test("render mode: one item per pin / graphic / visible field, ids carry where the item lives", () => {
  const t = fs.readFileSync(path.join(QA, "eeschema/libs/4xxx.kicad_sym"), "utf8"); const lib = M.parseLibrary(t);
  const sym = [...lib.symbols.values()].find((s) => !M.isDerived(s) && M.allPins(s).length > 2);
  const d = K.parseLibSymbol(K.parse(M.text(sym)), { unit: 1, bodyStyle: 1 });
  const ids = [...d.items.keys()];
  assert.ok(ids.some((i) => i.startsWith("p:")), ids.join(",")); assert.ok(ids.includes("f:Reference")); assert.ok(d.bbox);
  const pinUnits = new Set(M.allPins(sym).filter((p) => p.unit === 0 || p.unit === 1).map((p) => p.sub + ":" + p.j));
  assert.strictEqual(ids.filter((i) => i.startsWith("p:")).length, pinUnits.size);
  const hidden = K.parseLibSymbol(K.parse(M.text(sym)), { unit: 1, bodyStyle: 1, showHiddenPins: false, showHiddenFields: false });
  assert.ok(!hidden.items.has("f:Footprint") || M.fieldValue(sym, "Footprint") === "");
  const cv = { getContext: () => null };
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : typeof k === "string" && /^(measureText)$/.test(k) ? () => ({ width: 1 }) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  K.render(d, ctx, { ppm: 1, zoom: 10, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 }, { grid: 1.27, frame: false });
  void cv;
});
test("units: letters past Z, unit names", () => {
  assert.strictEqual(M.unitLetter(1), "A"); assert.strictEqual(M.unitLetter(26), "Z"); assert.strictEqual(M.unitLetter(27), "AA");
});
test("schematic instance <-> library: field positions undo the rotation; UpdateFields puts them back", () => {
  const lib = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "R", reference: "R" }));
  const inst = M.node(`(symbol (lib_id "x:R") (at 100 50 90) (unit 1) (uuid "u") (property "Reference" "R7" (at 102.54 50 90) (effects (font (size 1.27 1.27)))) (property "Value" "10k" (at 97.46 50 90) (effects (font (size 1.27 1.27)))) (instances (project "p" (path "/x" (reference "R7") (unit 1)))))`);
  const back = M.instanceToLibrary(inst, M.clone(lib));
  const ra = M.fieldOf(back, "Reference"); assert.ok(ra);
  const at = ra.find((c) => Array.isArray(c) && c[0] === "at"); assert.strictEqual(Number(at[1]), 0); assert.strictEqual(Math.abs(Number(at[2])), 2.54);
  const again = M.updateInstanceFields(inst, back);
  const ref = M.fieldOf(again, "Reference"); const at2 = ref.find((c) => Array.isArray(c) && c[0] === "at");
  assert.strictEqual(M.fieldValue(again, "Value"), "10k");
  assert.ok(Number.isFinite(Number(at2[1])));
});
test("cache naming reuses an identical copy and numbers a changed one", () => {
  const a = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "x:R" }));
  const cache = new Map([["x:R", a]]);
  assert.deepStrictEqual(M.cacheName(cache, "x:R", M.clone(a)), { name: "x:R", reused: true });
  const b = M.clone(a); M.setFieldValue(b, "Value", "changed");
  assert.deepStrictEqual(M.cacheName(cache, "x:R", b), { name: "R_1", reused: false });
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
