// lib-table.test.js — Update / Change Footprint finds a library footprint through the project's fp-lib-table
// nickname (FP_LIB_TABLE::FootprintLoad), then by its .pretty folder (web/library/sources.ts, bundled on the fly).
// Run: node server/static/tests/lib-table.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
globalThis.window = globalThis; globalThis.addEventListener = globalThis.addEventListener || (() => {});
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "library", "sources.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
const mod = { exports: {} }; new Function("exports", "module", "require", built.outputFiles[0].text)(mod.exports, mod, require); const L = mod.exports;

const TABLE = `(fp_lib_table (version 7)
  (lib (name "Custom")(type "KiCad")(uri "\${KIPRJMOD}/lib/fp.pretty")(options "")(descr ""))
  (lib (name "Resistor_SMD")(type "KiCad")(uri "\${KICAD10_FOOTPRINT_DIR}/Resistor_SMD.pretty")(options "")(descr "")))`;
const docs = [
  { docId: "t", path: "fp-lib-table", docType: "other" },
  { docId: "a", path: "lib/fp.pretty/R_Custom.kicad_mod", docType: "footprint" },
  { docId: "b", path: "Mine.pretty/C_Mine.kicad_mod", docType: "footprint" },
];
const texts = { t: TABLE, a: "(footprint \"R_Custom\")", b: "(footprint \"C_Mine\")" };
globalThis.fetch = async (url) => { const id = /\/api\/docs\/([^/]+)\/content/.exec(url)[1]; return { ok: true, status: 200, text: async () => texts[id] }; };

test("table rows and ${KIPRJMOD} folders", () => {
  const rows = L.libTableRows(TABLE);
  assert.deepEqual(rows.map((r) => r.name), ["Custom", "Resistor_SMD"]);
  assert.equal(L.projectRelativeUri("${KIPRJMOD}/lib/fp.pretty/"), "lib/fp.pretty");
  assert.equal(L.projectRelativeUri("${KICAD10_FOOTPRINT_DIR}/X.pretty"), null);
  assert.equal(L.libTableFootprintDoc(rows, "Custom", "R_Custom", docs).docId, "a");
  assert.equal(L.libTableFootprintDoc(rows, "Custom", "Nope", docs), null);
  assert.equal(L.libTableFootprintDoc(rows, "Resistor_SMD", "R_0603", docs), undefined, "a global row: the official libraries");
  assert.equal(L.libTableFootprintDoc(rows, "Mine", "C_Mine", docs), undefined);
});
test("a footprint by its nickname, then by its folder name", async () => {
  assert.equal(await L.projectFootprintByLibId("Custom", "R_Custom", docs), texts.a);
  assert.equal(await L.projectFootprintByLibId("Mine", "C_Mine", docs), texts.b);
  assert.equal(await L.projectFootprintByLibId("Custom", "Missing", docs), null);
  assert.equal(await L.projectFootprintByLibId("Resistor_SMD", "R_0603", docs), null, "not a project library");
});
