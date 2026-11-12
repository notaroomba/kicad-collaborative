// table-model.test.js — the table structure edits (EDIT_TABLE_TOOL_BASE) and Normalize (PCB_TABLE / SCH_TABLE) of
// web/canvas/table-model.ts under node: add / delete rows and columns, merge / unmerge, the selection conditions,
// the clipboard trim, paste into cells, CSV, cell hit tests; every edit leaves the original node byte-identical
// (that node is what undo restores).
// Run: node server/static/tests/table-model.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas, M = K.tableModel;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("table model under node");

let n = 0; const uuid = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
const pcbCell = (t, x0, y0, x1, y1, extra = "") => `(table_cell "${t}" (start ${x0} ${y0}) (end ${x1} ${y1}) (margins 1 1 1 1) (span 1 1)${extra} (layer "Dwgs.User") (uuid "${uuid()}") (effects (font (size 1.27 1.27)) (justify left)) (knockout no))`;
/** a 3 × 2 board table at (25, 24.5), columns 16 / 10 / 6, rows 3.5 / 5 */
function pcbTable(angle) {
  const xs = [25, 41, 51, 57], ys = [24.5, 28, 33]; const cells = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) cells.push(pcbCell(`r${r}c${c}`, xs[c], ys[r], xs[c + 1], ys[r + 1], angle ? ` (angle ${angle})` : ""));
  return K.parse(`(table (uuid "t1") (layer "Dwgs.User") (column_count 3) (border (external yes) (header yes) (stroke (width 0.1) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid))) (column_widths 16 10 6) (row_heights 3.5 5) (cells ${cells.join(" ")}))`);
}
const schCell = (t, x, y, w, h) => `(table_cell "${t}" (exclude_from_sim no) (at ${x} ${y} 0) (size ${w} ${h}) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid "${uuid()}"))`;
function schTable() {
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) cells.push(schCell(`${r}${c}`, 10 + c * 20.32, 20 + r * 5.08, 20.32, 5.08));
  return K.parse(`(table (column_count 2) (border (external yes) (header yes) (stroke (width 0) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0) (type solid))) (column_widths 20.32 20.32) (row_heights 5.08 5.08 5.08) (cells ${cells.join(" ")}) (uuid "s1"))`);
}
const texts = (node) => M.tableInfo(node).cells.map((c) => M.cellText(c));
const box = (node, i, pcb = true) => { const { s, e } = M.cellStartEnd(M.tableInfo(node).cells[i], pcb); return [s[0], s[1], e[0], e[1]]; };
/** run an edit and check the input node did not change */
function pure(node, fn) { const before = K.serialize(node); const out = fn(node); assert.equal(K.serialize(node), before, "the original node is untouched (undo restores it exactly)"); return out; }

test("tableInfo reads columns, rows, widths and heights", () => {
  const t = M.tableInfo(pcbTable()); assert.equal(t.cols, 3); assert.equal(t.rows, 2); assert.deepEqual(t.widths, [16, 10, 6]); assert.deepEqual(t.heights, [3.5, 5]);
});
test("Normalize of a laid-out table changes nothing", () => {
  const t = pcbTable(), s0 = K.serialize(t); M.normalizeTable(t, true); assert.equal(K.serialize(t), s0);
  const s = schTable(), s1 = K.serialize(s); M.normalizeTable(s, false); assert.equal(K.serialize(s), s1);
});
test("Add Row Above copies the row's formatting under new uuids, with no text, and pushes the table down", () => {
  const t = pcbTable(); const out = pure(t, (x) => M.addRow(x, true, 0, false, uuid));
  assert.deepEqual(texts(out), ["", "", "", "r0c0", "r0c1", "r0c2", "r1c0", "r1c1", "r1c2"]);
  assert.deepEqual(M.tableInfo(out).heights, [3.5, 3.5, 5]);
  assert.deepEqual(box(out, 0), [25, 24.5, 41, 28]); assert.deepEqual(box(out, 3), [25, 28, 41, 31.5]); assert.deepEqual(box(out, 8), [51, 31.5, 57, 36.5]);
  const cells = M.tableInfo(out).cells; assert.notEqual(K.uuidOf(cells[0]), K.uuidOf(cells[3]));
  assert.ok(/\(table_cell "" \(start 25 24.5\) \(end 41 28\) \(margins 1 1 1 1\) \(span 1 1\) \(layer "Dwgs.User"\) \(uuid "[^"]+"\) \(effects/.test(K.serialize(cells[0])), K.serialize(cells[0]));
});
test("Add Row Below repeats the source row's height", () => {
  const out = pure(pcbTable(), (x) => M.addRow(x, true, 1, true, uuid));
  assert.deepEqual(M.tableInfo(out).heights, [3.5, 5, 5]); assert.deepEqual(box(out, 6), [25, 33, 41, 38]);
  assert.deepEqual(texts(out).slice(6), ["", "", ""]);
});
test("Add Column Before / After interleave one cell per row and keep the source width", () => {
  const before = pure(pcbTable(), (x) => M.addCol(x, true, 1, false, uuid));
  assert.equal(M.tableInfo(before).cols, 4); assert.deepEqual(M.tableInfo(before).widths, [16, 10, 10, 6]);
  assert.deepEqual(texts(before), ["r0c0", "", "r0c1", "r0c2", "r1c0", "", "r1c1", "r1c2"]);
  assert.deepEqual(box(before, 3), [61, 24.5, 67, 28]);
  const after = pure(pcbTable(), (x) => M.addCol(x, true, 2, true, uuid));
  assert.deepEqual(texts(after), ["r0c0", "r0c1", "r0c2", "", "r1c0", "r1c1", "r1c2", ""]); assert.deepEqual(M.tableInfo(after).widths, [16, 10, 6, 6]);
});
test("Delete Row(s) / Column(s) remap the surviving sizes; all of them removes the table", () => {
  const t = pcbTable();
  const r = pure(t, (x) => M.deleteRows(x, true, [0]));
  assert.deepEqual(texts(r), ["r1c0", "r1c1", "r1c2"]); assert.deepEqual(M.tableInfo(r).heights, [5]);
  assert.deepEqual(box(r, 0), [25, 24.5, 41, 29.5]);   // SetPosition(pos) keeps the table where it was
  const c = pure(t, (x) => M.deleteCols(x, true, [0, 2]));
  assert.equal(M.tableInfo(c).cols, 1); assert.deepEqual(texts(c), ["r0c1", "r1c1"]); assert.deepEqual(M.tableInfo(c).widths, [10]);
  assert.deepEqual(box(c, 0), [25, 24.5, 35, 28]);
  assert.equal(M.deleteRows(t, true, [0, 1]), "remove"); assert.equal(M.deleteCols(t, true, [0, 1, 2]), "remove");
  assert.deepEqual(M.rowsOf(t, [0, 4, 5]), [0, 1]); assert.deepEqual(M.colsOf(t, [0, 4, 5]), [0, 1, 2]);
});
test("Merge Cells joins the texts, spans the top-left cell and covers the rest", () => {
  const t = pcbTable(); assert.ok(M.isCellBlock(t, [0, 1, 3, 4])); assert.ok(!M.isCellBlock(t, [0, 4])); assert.ok(!M.isCellBlock(t, [0]));
  const out = pure(t, (x) => M.mergeCells(x, true, [0, 1, 3, 4]));
  const cells = M.tableInfo(out).cells;
  assert.equal(M.cellText(cells[0]), "r0c0\nr0c1\nr1c0\nr1c1"); assert.deepEqual(M.spanOf(cells[0]), [2, 2]);
  for (const i of [1, 3, 4]) { assert.deepEqual(M.spanOf(cells[i]), [0, 0]); assert.equal(M.cellText(cells[i]), ""); }
  assert.deepEqual(box(out, 0), [25, 24.5, 51, 33]);
  assert.ok(M.hasMergedCell(out, [0])); assert.ok(!M.hasMergedCell(t, [0, 1]));
  assert.ok(M.isCellBlock(out, [0, 2, 5]));          // the merged cell counts its span area
  assert.equal(M.cellAt(out, true, 45, 30), 0);      // a covered cell is not selectable: the merged one is hit
  const un = pure(out, (x) => M.unmergeCells(x, true, [0]));
  for (const i of [0, 1, 3, 4]) assert.deepEqual(M.spanOf(M.tableInfo(un).cells[i]), [1, 1]);
  assert.deepEqual(box(un, 0), box(t, 0)); assert.deepEqual(box(un, 4), box(t, 4));
  assert.equal(M.cellText(M.tableInfo(un).cells[0]), "r0c0\nr0c1\nr1c0\nr1c1");   // the text stays in the top-left cell
});
test("cellAt, cellsInRect and the row / column expansions", () => {
  const t = pcbTable();
  assert.equal(M.cellAt(t, true, 30, 26), 0); assert.equal(M.cellAt(t, true, 55, 30), 5); assert.equal(M.cellAt(t, true, 80, 30), -1);
  assert.deepEqual(M.cellsInRect(t, true, M.cellCentre(M.tableInfo(t).cells[0], true), M.cellCentre(M.tableInfo(t).cells[4], true)), [0, 1, 3, 4]);
  assert.deepEqual(M.expandToRows(t, [1]), [0, 1, 2]); assert.deepEqual(M.expandToCols(t, [1]), [1, 4]);
});
test("a rotated board table keeps cell 0's centre and turns the layout about it", () => {
  const t = pcbTable(90); const c0 = M.cellCentre(M.tableInfo(t).cells[0], true);
  M.normalizeTable(t, true);
  assert.deepEqual(M.cellCentre(M.tableInfo(t).cells[0], true), c0);
  const c1 = M.cellCentre(M.tableInfo(t).cells[1], true);   // one column to the right, turned 90° (counter-clockwise on screen: up)
  assert.ok(Math.abs(c1[0] - c0[0]) < 1e-9 && Math.abs(c1[1] - (c0[1] - 13)) < 1e-9, JSON.stringify([c0, c1]));
  assert.equal(M.cellAt(t, true, c1[0], c1[1]), 1);
});
test("schematic tables write (at)/(size) and lay out from the position", () => {
  const s = schTable();
  const out = pure(s, (x) => M.addCol(x, false, 0, true, uuid));
  assert.ok(/\(at 30.32 20 0\) \(size 20.32 5.08\)/.test(K.serialize(M.tableInfo(out).cells[1])), K.serialize(M.tableInfo(out).cells[1]));
  assert.ok(/\(column_count 3\)/.test(K.serialize(out))); assert.ok(/\(column_widths 20.32 20.32 20.32\)/.test(K.serialize(out)));
  const m = pure(s, (x) => M.mergeCells(x, false, [0, 1]));
  assert.ok(/\(table_cell "00\\n01" \(exclude_from_sim no\) \(at 10 20 0\) \(size 40.64 5.08\)/.test(K.serialize(M.tableInfo(m).cells[0])), K.serialize(M.tableInfo(m).cells[0]));
  assert.deepEqual(M.cellHandles(M.tableInfo(s).cells[0], false), { col: [30.32, 22.54], row: [20.16, 25.08] });
  const w = pure(s, (x) => M.resizeCell(x, false, 0, "col", [35.4, 22]));
  assert.deepEqual(M.tableInfo(w).widths, [25.4, 20.32]); assert.deepEqual(box(w, 1, false), [35.4, 20, 55.72, 25.08]);
});
test("the clipboard copy keeps only the selected block", () => {
  const t = pcbTable(); const c = pure(t, (x) => M.trimToSelection(x, true, [1, 2, 4, 5]));
  assert.equal(M.tableInfo(c).cols, 2); assert.deepEqual(texts(c), ["r0c1", "r0c2", "r1c1", "r1c2"]);
  assert.deepEqual(M.tableInfo(c).widths, [10, 6]); assert.deepEqual(M.tableInfo(c).heights, [3.5, 5]);
});
test("paste into cells: KiCad's validation messages, and the table grows to fit", () => {
  const t = pcbTable();
  assert.equal(M.pasteIntoError(t, [], false), "No cells selected");
  assert.equal(M.pasteIntoError(t, [0], true), "Cannot paste into a table whose cells are generated");
  assert.equal(M.pasteIntoError(t, [0, 5], false), "Selected cells must form a contiguous block");
  assert.equal(M.pasteIntoError(M.mergeCells(t, true, [0, 1]), [0], false), "Cannot paste into merged cells");
  assert.equal(M.pasteIntoError(t, [0, 1], false, true), "Selection contains non-cell items");
  assert.equal(M.pasteIntoError(t, [4], false), "");
  const src = M.trimToSelection(t, true, [0, 1]);   // "r0c0" "r0c1"
  const out = pure(t, (x) => M.pasteCells(x, true, [5], src, uuid));
  assert.equal(M.tableInfo(out).cols, 4); assert.deepEqual(M.tableInfo(out).widths, [16, 10, 6, 10]);
  assert.deepEqual(texts(out), ["r0c0", "r0c1", "r0c2", "", "r1c0", "r1c1", "r0c0", "r0c1"]);
});
test("CSV export quotes commas, quotes and line breaks", () => {
  const t = pcbTable(); const c = M.tableInfo(t).cells; c[0][1] = 'a,b'; c[1][1] = 'say "hi"'; c[2][1] = "x\ny";
  assert.equal(M.tableCsv(t), '"a,b","say ""hi""","x\ny"\nr1c0,r1c1,r1c2\n');
  assert.equal(M.columnName(0), "A"); assert.equal(M.columnName(25), "Z"); assert.equal(M.columnName(26), "AA");
});
test("clearing cell text and resizing a row", () => {
  const t = pcbTable(); const c = pure(t, (x) => M.clearCellText(x, [0, 4])); assert.deepEqual(texts(c), ["", "r0c1", "r0c2", "r1c0", "", "r1c2"]);
  const h = pure(t, (x) => M.resizeCell(x, true, 3, "row", [33, 39])); assert.deepEqual(M.tableInfo(h).heights, [3.5, 11]);
  assert.deepEqual(box(h, 3), [25, 28, 41, 39]); assert.deepEqual(box(h, 0), [25, 24.5, 41, 28]);
  // dragging cell 0's bottom edge: its end moves first, so Normalize's stable centre keeps the top where it was
  const h0 = pure(t, (x) => M.resizeCell(x, true, 0, "row", [33, 30.5])); assert.deepEqual(M.tableInfo(h0).heights, [6, 5]);
  assert.deepEqual(box(h0, 0), [25, 24.5, 41, 30.5]); assert.deepEqual(box(h0, 3), [25, 30.5, 41, 35.5]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
