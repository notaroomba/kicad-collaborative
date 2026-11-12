// table-collab.test.js — table edits that must follow KiCad and survive a peer's concurrent edit:
//  - cell indexes follow their cells across a peer's row / column insert (remapCells);
//  - the board clipboard copy of cells is Normalized (CLIPBOARD_IO::SaveSelection deleteUnselectedCells);
//  - paste into cells keeps the target's margins and knockout (pasteCellsIntoSelection copies text, attributes,
//    stroke and fill only);
//  - a schematic table turns in place (SCH_EDIT_TOOL::Rotate's re-centring Move), four turns bring it back;
//  - a board table turns its cells (PCB_TABLE::Rotate), four turns bring it back;
//  - Draw Table sizes from the schematic's default text size.
// Run: node server/static/tests/table-collab.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, M = K.tableModel, sch = globalThis.CollabTools.sch, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("table collaboration and transforms under node");

let n = 0; const uuid = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
const pcbCell = (t, x0, y0, x1, y1, extra = "") => `(table_cell "${t}" (start ${x0} ${y0}) (end ${x1} ${y1}) (margins 1 1 1 1) (span 1 1)${extra} (layer "Dwgs.User") (uuid "${uuid()}") (effects (font (size 1.27 1.27)) (justify left)) (knockout no))`;
/** a 3 x 2 board table at (25, 24.5), columns 16 / 10 / 6, rows 3.5 / 5 */
function pcbTable() {
  const xs = [25, 41, 51, 57], ys = [24.5, 28, 33]; const cells = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) cells.push(pcbCell(`r${r}c${c}`, xs[c], ys[r], xs[c + 1], ys[r + 1]));
  return K.parse(`(table (uuid "t1") (layer "Dwgs.User") (column_count 3) (border (external yes) (header yes) (stroke (width 0.1) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid))) (column_widths 16 10 6) (row_heights 3.5 5) (cells ${cells.join(" ")}))`);
}
const schCell = (t, x, y, w, h) => `(table_cell "${t}" (exclude_from_sim no) (at ${x} ${y} 0) (size ${w} ${h}) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid "${uuid()}"))`;
/** 2 columns of 20.32, 3 rows of 2.54, at (20.32, 20.32): centre (40.64, 24.13) */
function schTable() {
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) cells.push(schCell(`${r}${c}`, 20.32 + c * 20.32, 20.32 + r * 2.54, 20.32, 2.54));
  return K.parse(`(table (column_count 2) (border (external yes) (header yes) (stroke (width 0) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0) (type solid))) (column_widths 20.32 20.32) (row_heights 2.54 2.54 2.54) (cells ${cells.join(" ")}) (uuid "s1"))`);
}
const texts = (node) => M.tableInfo(node).cells.map((c) => M.cellText(c));
const bbox = (node, pcb) => { let b = null; for (const c of M.tableInfo(node).cells) { const { s, e } = M.cellStartEnd(c, pcb); for (const p of [s, e]) b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; } return b.map((v) => +v.toFixed(4)); };
const near = (a, b, eps = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

test("cell indexes follow their cells across a peer's Add Row Above", () => {
  const t = pcbTable(); const i = texts(t).indexOf("r1c1");   // index 4
  const t2 = M.addRow(t, true, 0, false, uuid);
  const j = M.remapCells(t, t2, [i, 0]);
  assert.deepEqual(j.map((k) => texts(t2)[k]), ["r1c1", "r0c0"]);
  assert.deepEqual(M.remapCells(t, t, [4]), [4]);
  // a deleted cell drops out
  const t3 = M.deleteRows(t, true, [1]); assert.deepEqual(M.remapCells(t, t3, [4]), []);
  // the same table re-parsed (a commit coming back) keeps the indexes
  assert.deepEqual(M.remapCells(t, K.parse(K.serialize(t)), [1, 5]), [1, 5]);
});
test("a board clipboard copy of a non-rectangular selection is Normalized into one row", () => {
  const t = pcbTable(); const c = M.trimToSelection(t, true, [0, 4]);   // r0c0 and r1c1
  assert.equal(M.tableInfo(c).cols, 2); assert.equal(M.tableInfo(c).rows, 1); assert.deepEqual(texts(c), ["r0c0", "r1c1"]);
  const b0 = M.cellStartEnd(M.tableInfo(c).cells[0], true), b1 = M.cellStartEnd(M.tableInfo(c).cells[1], true);
  assert.deepEqual([b0.s, b0.e], [[25, 24.5], [41, 28]]);
  assert.deepEqual([b1.s, b1.e], [[41, 24.5], [51, 28]], "the second cell sits beside the first");
  // a schematic copy keeps the cells where they were (saveTable)
  const s = schTable(); const sc = M.trimToSelection(s, false, [1]); assert.deepEqual(M.cellStartEnd(M.tableInfo(sc).cells[0], false).s, [40.64, 20.32]);
});
test("paste into cells copies text, effects, stroke and fill, and keeps the target's margins and knockout", () => {
  const t = pcbTable(); const src = M.trimToSelection(t, true, [0]);
  const sc = M.tableInfo(src).cells[0]; K.kid(sc, "margins").splice(1, 4, 3, 3, 3, 3); K.kid(sc, "knockout")[1] = "yes"; K.kid(K.kid(K.kid(sc, "effects"), "font"), "size").splice(1, 2, 2, 2);
  const out = M.pasteCells(t, true, [4], src, uuid); const c = M.tableInfo(out).cells[4];
  assert.equal(M.cellText(c), "r0c0");
  assert.deepEqual(K.kid(c, "margins"), ["margins", 1, 1, 1, 1]);
  assert.deepEqual(K.kid(c, "knockout"), ["knockout", "no"]);
  assert.deepEqual(K.kid(K.kid(K.kid(c, "effects"), "font"), "size"), ["size", 2, 2]);
});
test("a lone schematic table turns in place; four turns bring it back", () => {
  const t = schTable(), b0 = bbox(t, false); const node = K.cloneNode(t);
  const centre = (x) => { const b = bbox(x, false); return [+((b[0] + b[2]) / 2).toFixed(4), +((b[1] + b[3]) / 2).toFixed(4)]; };
  for (let k = 1; k <= 4; k++) {
    assert.ok(sch._.transformNode("table", node, "ccw", [0, 0], true));
    const c = centre(node); assert.ok(Math.abs(c[0] - 40.64) <= 0.635 && Math.abs(c[1] - 24.13) <= 0.635, `turn ${k}: centre ${c}`);
  }
  assert.deepEqual(bbox(node, false), b0);
  assert.deepEqual(texts(node), texts(t));
  const c0 = M.cellStartEnd(M.tableInfo(node).cells[0], false); assert.deepEqual([c0.s, c0.angle], [[20.32, 20.32], 0]);
  // in a multi-selection the table's centre goes where the rotation about C takes it
  const m = K.cloneNode(t); sch._.transformNode("table", m, "ccw", [0, 0], false);
  const cm = centre(m); assert.ok(near(cm, [24.13, -40.64]), String(cm));
});
test("a board table turns its cells (PCB_TABLE::Rotate) and four turns bring it back", () => {
  const t = pcbTable(), node = K.cloneNode(t);
  P.rotateNode(node, 41, 28.75, 90);
  const c = M.tableInfo(node).cells; const a = M.cellStartEnd(c[0], true);
  assert.equal(a.angle, 90); assert.ok(c.every((x) => M.cellStartEnd(x, true).angle === 90));
  for (let k = 0; k < 3; k++) P.rotateNode(node, 41, 28.75, 90);
  assert.ok(near(bbox(node, true), bbox(t, true)), String(bbox(node, true)));
  assert.ok(M.tableInfo(node).cells.every((x) => !K.kid(x, "angle")));
});
test("Draw Table sizes from the schematic's default text size", () => {
  const z = sch._.drawTableSize([0, 0], [60, 10], 1.27);
  assert.deepEqual([z.cols, z.rows], [3, 3]);
  const big = sch._.drawTableSize([0, 0], [60, 10], 1.27, 2.54);
  assert.deepEqual([big.cols, big.rows], [1, 1]);
  const node = sch._.drawTableNode([0, 0], [60, 10], 1.27, 2.54);
  assert.deepEqual(K.kid(K.kid(K.kid(M.tableInfo(node).cells[0], "effects"), "font"), "size"), ["size", 2.54, 2.54]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
