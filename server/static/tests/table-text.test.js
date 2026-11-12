// table-text.test.js — a table cell's shown text (PCB_TABLECELL::GetUnwrappedShownText / SCH_TABLECELL::GetShownText:
// ${ROW} ${COL} ${ADDR} ${LAYER} ${CELL(…)} and the document's variables, as the canvas draws them) and the
// WX_VIEW_CONTROLS auto-pan step the cell drag-selection uses.
// Run: node server/static/tests/table-text.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("table cell text and auto-pan under node");

let n = 0; const uuid = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
const q = (t) => JSON.stringify(t);
const pcbCell = (t, x0, y0, x1, y1) => `(table_cell ${q(t)} (start ${x0} ${y0}) (end ${x1} ${y1}) (margins 1 1 1 1) (span 1 1) (layer "F.SilkS") (uuid "${uuid()}") (effects (font (size 1.27 1.27)) (justify left)) (knockout no))`;
function pcbTable(texts) {
  const cells = []; for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) cells.push(pcbCell(texts[r * 2 + c], 10 + c * 20, 10 + r * 5, 30 + c * 20, 15 + r * 5));
  return `(table (column_count 2) (layer "F.SilkS") (border (external yes) (header yes) (stroke (width 0.1) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid))) (column_widths 20 20) (row_heights 5 5) (cells ${cells.join(" ")}) (uuid "tbl"))`;
}
const schCell = (t, x, y) => `(table_cell ${q(t)} (exclude_from_sim no) (at ${x} ${y} 0) (size 20.32 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid "${uuid()}"))`;
function schTable(texts) {
  const cells = []; for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) cells.push(schCell(texts[r * 2 + c], 10 + c * 20.32, 20 + r * 5.08));
  return `(table (column_count 2) (border (external yes) (header yes) (stroke (width 0) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0) (type solid))) (column_widths 20.32 20.32) (row_heights 5.08 5.08) (cells ${cells.join(" ")}) (uuid "tbl"))`;
}
const PCB_HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (25 "Edge.Cuts" user))`;
const pcbDoc = (body) => K.parseDoc(PCB_HEAD + "\n" + body + "\n)", "kicad_pcb");
const schDoc = (body) => K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "0000") (paper "A4")\n${body}\n)`, "kicad_sch");
const drawn = (doc) => doc.items.get("tbl").geom.filter((g) => g.t === "text").map((g) => g.text);

test("cellAddr: one letter ('A' + col % 26) and the row, 1-based on a board, 0-based in a schematic", () => {
  assert.equal(K.cellAddr(0, 0, true), "A1"); assert.equal(K.cellAddr(2, 1, true), "B3");
  assert.equal(K.cellAddr(0, 0, false), "A0"); assert.equal(K.cellAddr(2, 1, false), "B2");
  assert.equal(K.cellAddr(0, 27, true), "B1");   // GetAddr wraps at Z
});
test("parseCellAddress reads multi-letter columns and 0-based rows", () => {
  assert.deepEqual(K.parseCellAddress("A0"), { row: 0, col: 0 }); assert.deepEqual(K.parseCellAddress("b12"), { row: 12, col: 1 });
  assert.deepEqual(K.parseCellAddress("AA3"), { row: 3, col: 26 });
  assert.equal(K.parseCellAddress("12"), null); assert.equal(K.parseCellAddress("A"), null); assert.equal(K.parseCellAddress("A-1"), null);
});
test("board cells resolve ${ROW} ${COL} 1-based, ${ADDR} and ${LAYER}", () => {
  const t = K.parse(pcbTable(["${ROW}/${COL}", "${ADDR}", "${LAYER}", "plain"]));
  const d = { type: "pcb" };
  assert.equal(K.tableCellShownText(d, t, 0, true), "1/1"); assert.equal(K.tableCellShownText(d, t, 1, true), "B1");
  assert.equal(K.tableCellShownText(d, t, 2, true), "F.SilkS"); assert.equal(K.tableCellShownText(d, t, 3, true), "plain");
});
test("schematic cells resolve ${ROW} ${COL} 0-based and ${ADDR}", () => {
  const t = K.parse(schTable(["${ROW}/${COL}", "${ADDR}", "${ROW}${COL}", "x"]));
  assert.equal(K.tableCellShownText({}, t, 0, false), "0/0"); assert.equal(K.tableCellShownText({}, t, 1, false), "B0");
  assert.equal(K.tableCellShownText({}, t, 2, false), "10");
});
test("schematic ${CELL(\"A0\")} / ${CELL(r, c)} give the other cell's shown text, with KiCad's unresolved messages", () => {
  const t = K.parse(schTable(["head", "${CELL(\"A0\")}+${ADDR}", "${CELL(0, 1)}", "${CELL(5,5)} ${CELL(\"9\")} ${CELL(x)}"]));
  assert.equal(K.tableCellShownText({}, t, 1, false), "head+B0");
  assert.equal(K.tableCellShownText({}, t, 2, false), "head+B0");   // a reference to a reference resolves through
  assert.equal(K.tableCellShownText({}, t, 3, false), "<Unresolved: Cell F5 not found> <Unresolved: Invalid cell address: 9> <Unresolved: Invalid CELL() syntax: x>");
});
test("a circular CELL() reference stops at the recursion depth", () => {
  const t = K.parse(schTable(["${CELL(\"B0\")}", "${CELL(\"A0\")}", "", ""]));
  assert.equal(K.tableCellShownText({}, t, 0, false), "<Circular reference>");
});
test("unknown variables stay as written; the project's text variables resolve", () => {
  const t = K.parse(pcbTable(["${NOPE}", "${REV}", "", ""]));
  assert.equal(K.tableCellShownText({ type: "pcb" }, t, 0, true), "${NOPE}");
  assert.equal(K.tableCellShownText({ type: "pcb", projectVars: { REV: "C" } }, t, 1, true), "C");
});
test("the board canvas draws the resolved text, the node keeps the variables", () => {
  const doc = pcbDoc(pcbTable(["${ADDR}", "${COL}", "${ROW}", "${LAYER}"]));
  const tx = drawn(doc); for (const want of ["A1", "2", "F.Silkscreen"]) assert(tx.includes(want), `drawn ${want} (got ${JSON.stringify(tx)})`);
  assert(!tx.some((s) => s.includes("${")), "no raw ${…} on the canvas");
  assert.equal(String(doc.items.get("tbl").node[0]), "table");
  assert(K.serialize(doc.items.get("tbl").node).includes("${ADDR}"), "the file keeps ${ADDR}");
});
test("${LAYER} is the board's name for the layer (GetLayerName)", () => {
  const doc = pcbDoc(pcbTable(["${LAYER}", "", "", ""]));
  assert(drawn(doc).includes("F.Silkscreen"), JSON.stringify(drawn(doc)));
});
test("the schematic canvas draws the resolved text", () => {
  const doc = schDoc(schTable(["${ADDR}", "${CELL(\"A0\")}!", "r${ROW}", "c${COL}"]));
  const tx = drawn(doc); for (const want of ["A0", "A0!", "r1", "c1"]) assert(tx.includes(want), `drawn ${want} (got ${JSON.stringify(tx)})`);
});
test("auto-pan: nothing inside the 2 % border, the distance into it, the border past half, border × 1.5 at the edge and beyond", () => {
  // 1000 × 800 canvas: border = min(20, 16) = 16 px
  assert.deepEqual(K.autoPanStep(500, 400, 1000, 800), [0, 0]);
  assert.deepEqual(K.autoPanStep(990, 400, 1000, 800), [6, 0]);           // 6 px in: under half the border, the distance itself
  assert.deepEqual(K.autoPanStep(500, 795, 1000, 800), [0, 16]);          // 11 px in (> 8): the border size
  assert.deepEqual(K.autoPanStep(-40, 400, 1000, 800), [-24, 0]);         // 56 px past: border × (0.5 + 5 / 5)
  const [dx, dy] = K.autoPanStep(-100, -100, 1000, 800); assert(Math.abs(Math.hypot(dx, dy) - 24) < 1e-9 && dx < 0 && dy < 0);
  assert.equal(Math.round(K.AUTOPAN_TICK_MS * 60), 250);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
