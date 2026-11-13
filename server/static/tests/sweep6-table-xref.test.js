// sweep6-table-xref.test.js — the board Table Properties dialog under a peer's concurrent edit, and the board's
// text-variable cross-reference conversion (BOARD::ConvertCrossReferencesToKIIDs / ConvertKIIDsToCrossReferences).
//  - two clients: B edits cell (0,1) while A's dialog is open on the old table; A edits cell (0,0) and presses OK:
//    both edits survive, and one undo on A restores B's state exactly;
//  - a peer's row insert / back-layer table / layer change / untouched strokes keep the file's bytes;
//  - ${R1:VALUE} ↔ ${<uuid>:VALUE}; escaped expressions, unknown references and unresolvable tokens stay as typed.
// Run: node server/static/tests/sweep6-table-xref.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, M = K.tableModel;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("board table dialog concurrency and cross-references under node");

const esbuild = require("esbuild");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; globalThis.window = globalThis.window || globalThis; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const T = load("editor/pcbdialogs/table.ts"), X = load("editor/pcbdialogs/xref.ts");
const cellTexts = (n) => K.kids(K.kid(n, "cells"), "table_cell").map((c) => c[1]);

/** A board with one 2 x 2 table, shared by two clients (each its own parsed document). */
function board(layer = "F.SilkS") {
  const t = P.tableNode([0, 0], [30, 6], layer, 0);
  return `(kicad_pcb (version 20250000) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (36 "B.SilkS" user)) ${K.serialize(t)})`;
}
const tableItem = (doc) => Array.from(doc.items.values()).find((i) => i.kind === "table");
/** a client: its doc, and commit/undo as the editor does them (the change's pre-state is the item at commit time) */
function client(text) {
  const doc = K.parseDoc(text, "pcb"); const undo = [];
  return { doc, commit(item, node, peers) { const before = K.serialize(doc.items.get(item.id).node); const ch = K.replaceChange(doc, { ...item, node, geom: [], bbox: null }); undo.push({ id: item.id, before }); for (const d of [doc, ...peers]) K.applyChange(d, ch, 1); },
    undo(peers) { const u = undo.pop(); const it = doc.items.get(u.id); const ch = K.replaceChange(doc, { ...it, node: K.parse(u.before), geom: [], bbox: null }); for (const d of [doc, ...peers]) K.applyChange(d, ch, 1); } };
}

test("A's Table Properties OK keeps B's concurrent cell edit; one undo on A restores B's state exactly", () => {
  const text = board(); const A = client(text), B = client(text);
  const tA0 = tableItem(A.doc), node0 = tA0.node, v0 = T.tableValues(node0);   // A opens the dialog
  // B edits cell (0,1) meanwhile
  const tB = tableItem(B.doc), nb = K.cloneNode(tB.node); K.kids(K.kid(nb, "cells"), "table_cell")[1][1] = "peer"; B.commit(tB, nb, [A.doc]);
  const afterB = K.serialize(tableItem(A.doc).node);
  assert.deepEqual(cellTexts(tableItem(A.doc).node), ["", "peer", "", ""]);
  // A types into (0,0) and presses OK
  const v = { ...v0, cells: [["mine", ""], ["", ""]] };
  const cur = tableItem(A.doc), node = T.applyTableEdit(node0, cur.node, v0, v);
  assert.ok(node, "a change");
  A.commit(cur, node, [B.doc]);
  for (const d of [A.doc, B.doc]) assert.deepEqual(cellTexts(tableItem(d).node), ["mine", "peer", "", ""]);
  A.undo([B.doc]);
  for (const d of [A.doc, B.doc]) assert.equal(K.serialize(tableItem(d).node), afterB, "undo restores B's state byte for byte");
});

test("a peer's Add Row Above while the dialog is open: A's edit lands on the cell it was typed into", () => {
  const t = P.tableNode([0, 0], [30, 6], "F.SilkS", 0); const v0 = T.tableValues(t);
  const base = M.addRow(t, true, 0, false, () => K.newUuid());
  const n = T.applyTableEdit(t, base, v0, { ...v0, cells: [["", ""], ["", "low right"]] });
  const texts = cellTexts(n); assert.equal(texts.length, 6); assert.equal(texts[5], "low right", JSON.stringify(texts));
});

test("nothing changed in the dialog: no commit; untouched strokes and lock keep the peer's bytes", () => {
  const t = P.tableNode([0, 0], [30, 6], "F.SilkS", 0); const v0 = T.tableValues(t);
  assert.equal(T.applyTableEdit(t, t, v0, { ...v0 }), null);
  // a peer changed the border width; A only edits a cell: the peer's stroke stays
  const base = K.cloneNode(t); K.kid(K.kid(K.kid(base, "border"), "stroke"), "width")[1] = 0.3;
  const n = T.applyTableEdit(t, base, v0, { ...v0, cells: [["x", ""], ["", ""]] });
  assert.ok(K.serialize(n).includes("(border (external yes) (header yes) (stroke (width 0.3) (type default)))"), K.serialize(n));
  // A's own stroke change is written
  const n2 = T.applyTableEdit(t, base, v0, { ...v0, sepStyle: "dash" });
  assert.ok(K.serialize(n2).includes("(separators (rows yes) (cols yes) (stroke (width 0.1) (type dash)))"));
});

test("back-layer table: the grid is mirrored; a layer change writes the layer of every current cell", () => {
  const t = P.tableNode([0, 0], [30, 6], "B.SilkS", 0); const v0 = T.tableValues(t);
  const n = T.applyTableEdit(t, t, v0, { ...v0, cells: [["left", ""], ["", ""]] });
  assert.deepEqual(cellTexts(n), ["", "left", "", ""]);
  const base = M.addRow(t, true, 0, false, () => K.newUuid());
  const n2 = T.applyTableEdit(t, base, v0, { ...v0, layer: "F.SilkS" });
  const s = K.serialize(n2); assert.equal((s.match(/\(layer "F\.SilkS"\)/g) || []).length, 7, "the table and its six cells");
  assert.ok(!s.includes("B.SilkS"));
});

test("\\r is stripped and cross-references are converted on OK", () => {
  const t = P.tableNode([0, 0], [30, 6], "F.SilkS", 0); const v0 = T.tableValues(t);
  const fps = [{ uuid: "aaaa-1", ref: "R1", fields: new Set(["Reference", "Value"]), pads: new Set(["1"]) }];
  const n = T.applyTableEdit(t, t, v0, { ...v0, cells: [["a\r\nb", "${r1:VALUE}"], ["", ""]] }, undefined, (s) => X.refsToKiids(fps, s));
  assert.deepEqual(cellTexts(n).slice(0, 2), ["a\nb", "${aaaa-1:VALUE}"]);
});

test("ConvertCrossReferencesToKIIDs / ConvertKIIDsToCrossReferences", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20250000) (layers (0 "F.Cu" signal))
    (footprint "R:R_0603" (layer "F.Cu") (uuid "11111111-2222-3333-4444-555555555555") (at 10 10)
      (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
      (property "Value" "10k" (at 0 1) (layer "F.Fab") (uuid "p2") (effects (font (size 1 1))))
      (property "MPN" "RC0603" (at 0 1) (layer "F.Fab") (hide yes) (uuid "p3") (effects (font (size 1 1))))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))))`, "pcb");
  const x = X.boardXref(doc), id = "11111111-2222-3333-4444-555555555555";
  assert.equal(x.toKiids("V=${R1:VALUE} ${r1:MPN} ${R1:NET_NAME(1)}"), `V=\${${id}:VALUE} \${${id}:MPN} \${${id}:NET_NAME(1)}`);
  assert.equal(x.toKiids("${R1:NOPE} ${R9:VALUE} ${R1:NET_NAME(2)}"), "${R1:NOPE} ${R9:VALUE} ${R1:NET_NAME(2)}", "unresolvable tokens stay");
  assert.equal(x.toKiids("\\${R1:VALUE} \\@{${R1:VALUE}}"), "\\${R1:VALUE} \\@{${R1:VALUE}}", "escaped expressions copied verbatim");
  assert.equal(x.toKiids("${SHEETNAME} ${R1:VALUE"), `\${SHEETNAME} \${${id}:VALUE}`, "an unterminated token is closed, as KiCad's loop does");
  assert.equal(x.toRefs(`\${${id}:VALUE} \${0000:VALUE}`), "${R1:VALUE} ${0000:VALUE}");
  assert.equal(x.toRefs("plain"), "plain");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
