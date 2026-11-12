// table-model — the structure edits of a table (EDIT_TABLE_TOOL_BASE, include/tool/edit_table_tool_base.h) and the
// layout PCB_TABLE::Normalize / SCH_TABLE::Normalize, on the table's s-expression node.
//
// A table is one document item; its cells are the (cells (table_cell …) …) list read row-major with (column_count N)
// columns.  A cell's index in that list is its address here (row = i / cols, col = i % cols), as SCH_TABLE /
// PCB_TABLE::GetCell index m_cells.  Board cells are (start)/(end) [+ (angle)] boxes, schematic cells (at x y r) +
// (size w h); every function takes `isPcb` and writes the cell the way that file's writer does.  Nothing here
// mutates the node it is given: each edit returns a new node (cloneNode keeps the quoting marks), so the original
// is exactly what undo puts back.  The file version is never touched.
import { cloneNode, kid, kids, num, rotPt, str } from "./sexpr";
import type { Pt } from "./types";

export interface TableInfo { cols: number; rows: number; cells: SNode[]; widths: number[]; heights: number[] }

/** Internal-unit grid in mm: pcbIUScale is 1 nm, schIUScale 100 nm. */
const iu = (isPcb: boolean): number => (isPcb ? 1e-6 : 1e-4);
const roundIU = (v: number, isPcb: boolean): number => { const q = iu(isPcb); const r = Math.round(v / q) * q; return +r.toFixed(isPcb ? 6 : 4) + 0; };

export function tableInfo(node: SNode): TableInfo {
  const cols = Math.max(1, Math.round(num((kid(node, "column_count") || [])[1], 1)) || 1);
  const cellsN = kid(node, "cells"); const cells = cellsN ? kids(cellsN, "table_cell") : [];
  const rows = Math.floor(cells.length / cols);
  const cw = kid(node, "column_widths"), rh = kid(node, "row_heights");
  const widths = cw ? cw.slice(1).map((v) => num(v)) : [], heights = rh ? rh.slice(1).map((v) => num(v)) : [];
  return { cols, rows, cells, widths, heights };
}
/** GetColWidth / GetRowHeight: a missing entry is 0. */
const at0 = (a: number[], i: number): number => (i >= 0 && i < a.length && isFinite(a[i]) ? a[i] : 0);

export function spanOf(cell: SNode | null | undefined): [number, number] {
  const sp = cell ? kid(cell, "span") : null; return sp ? [num(sp[1], 1), num(sp[2], 1)] : [1, 1];
}
function setSpan(cell: SNode, cs: number, rs: number): void {
  const sp = kid(cell, "span"); if (sp) { sp[1] = cs; sp[2] = rs; return; }
  // (span) follows (margins) in both writers
  const m = cell.findIndex((c) => Array.isArray(c) && c[0] === "margins");
  cell.splice(m > 0 ? m + 1 : cell.length, 0, ["span", cs, rs]);
}
export const cellText = (cell: SNode | null | undefined): string => (cell ? str(cell[1]) : "");
function setText(cell: SNode, text: string): void { cell[1] = text; }

/** A cell's start / end corners as stored (the board's (start)/(end), the schematic's (at) and (at)+(size)). */
export function cellStartEnd(cell: SNode, isPcb: boolean): { s: Pt; e: Pt; angle: number } {
  if (isPcb) {
    const s = kid(cell, "start"), e = kid(cell, "end"), a = kid(cell, "angle");
    return { s: [num(s && s[1]), num(s && s[2])], e: [num(e && e[1]), num(e && e[2])], angle: a ? num(a[1]) : 0 };
  }
  const a = kid(cell, "at"), sz = kid(cell, "size");
  const s: Pt = [num(a && a[1]), num(a && a[2])];
  return { s, e: [s[0] + num(sz && sz[1]), s[1] + num(sz && sz[2])], angle: a ? num(a[3]) : 0 };
}
/** SetStart + SetEnd, written in place in the cell's own tokens. */
export function setCellStartEnd(cell: SNode, isPcb: boolean, s: Pt, e: Pt): void {
  const r = (v: number) => roundIU(v, isPcb);
  if (isPcb) {
    const sN = kid(cell, "start"), eN = kid(cell, "end");
    if (sN) { sN[1] = r(s[0]); sN[2] = r(s[1]); } if (eN) { eN[1] = r(e[0]); eN[2] = r(e[1]); }
    return;
  }
  const a = kid(cell, "at"), sz = kid(cell, "size");
  if (a) { a[1] = r(s[0]); a[2] = r(s[1]); }
  if (sz) { sz[1] = r(e[0] - s[0]); sz[2] = r(e[1] - s[1]); }
}

/**
 * The cell's outline on the canvas as four corners.  A board cell is an axis-aligned box turned about its centre by
 * its text angle (PCB_TEXTBOX keeps the rotation in the angle); a schematic cell's start/end are already turned.
 */
export function cellCorners(cell: SNode, isPcb: boolean): Pt[] {
  const { s, e, angle } = cellStartEnd(cell, isPcb);
  const x0 = Math.min(s[0], e[0]), x1 = Math.max(s[0], e[0]), y0 = Math.min(s[1], e[1]), y1 = Math.max(s[1], e[1]);
  const pts: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (!isPcb || !angle) return pts;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return pts.map(([x, y]) => { const [rx, ry] = rotPt(x - cx, y - cy, angle); return [cx + rx, cy + ry] as Pt; });
}
export function cellCentre(cell: SNode, isPcb: boolean): Pt { const { s, e } = cellStartEnd(cell, isPcb); return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2]; }

function inQuad(q: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i], b = q[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}
/** Selectable cells: a cell covered by a merged neighbour (span 0) is not (SCH_SELECTION_TOOL::Selectable). */
export const selectableCell = (cell: SNode | null | undefined): boolean => { const [c, r] = spanOf(cell); return c > 0 && r > 0; };

/** The index of the selectable cell under (x, y), or -1 (PCB_TABLECELL / SCH_TABLECELL HitTest(point)). */
export function cellAt(node: SNode, isPcb: boolean, x: number, y: number, accuracy = 0): number {
  const T = tableInfo(node);
  for (let i = 0; i < T.cells.length; i++) {
    const c = T.cells[i]; if (!selectableCell(c)) continue;
    const q = cellCorners(c, isPcb);
    if (inQuad(q, x, y)) return i;
    if (accuracy > 0) {
      const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
      if (x >= Math.min(...xs) - accuracy && x <= Math.max(...xs) + accuracy && y >= Math.min(...ys) - accuracy && y <= Math.max(...ys) + accuracy && inQuadGrown(q, x, y, accuracy)) return i;
    }
  }
  return -1;
}
function inQuadGrown(q: Pt[], x: number, y: number, d: number): boolean {
  if (inQuad(q, x, y)) return true;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; if (segDist(a, b, x, y) <= d) return true; }
  return false;
}
function segDist(a: Pt, b: Pt, x: number, y: number): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; let t = l ? ((x - a[0]) * dx + (y - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}

/**
 * selectCellsBetween: every selectable cell whose outline the axis-aligned box between two points touches
 * (cell->HitTest( rect, false )).
 */
export function cellsInRect(node: SNode, isPcb: boolean, a: Pt, b: Pt): number[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const T = tableInfo(node), out: number[] = [];
  T.cells.forEach((c, i) => {
    if (!selectableCell(c)) return;
    const q = cellCorners(c, isPcb);
    const cx0 = Math.min(...q.map((p) => p[0])), cx1 = Math.max(...q.map((p) => p[0])), cy0 = Math.min(...q.map((p) => p[1])), cy1 = Math.max(...q.map((p) => p[1]));
    if (cx1 < x0 || cx0 > x1 || cy1 < y0 || cy0 > y1) return;
    out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------- Normalize
/** PCB_TABLE::Normalize / SCH_TABLE::Normalize on the node, in place. */
export function normalizeTable(node: SNode, isPcb: boolean): void {
  const T = tableInfo(node); if (!T.cells.length) return;
  const W = (c: number) => at0(T.widths, c), H = (r: number) => at0(T.heights, r);
  const size = (row: number, col: number, cell: SNode): [number, number] => {
    let w = W(col), h = H(row); const [cs, rs] = spanOf(cell);
    if (cs > 1 || rs > 1) { for (let i = col + 1; i < col + cs; i++) w += W(i); for (let i = row + 1; i < row + rs; i++) h += H(i); }
    return [w, h];
  };
  if (isPcb) {
    const c0 = cellStartEnd(T.cells[0], true), angle = c0.angle;
    // BOX2I::GetCenter of cell 0's (normalised) box
    const sc: Pt = [(c0.s[0] + c0.e[0]) / 2, (c0.s[1] + c0.e[1]) / 2];
    const [w0, h0] = size(0, 0, T.cells[0]);
    const ox = sc[0] - w0 / 2, oy = sc[1] - h0 / 2;
    let y = oy;
    for (let row = 0; row < T.rows; row++) {
      let x = ox;
      for (let col = 0; col < T.cols; col++) {
        const cell = T.cells[row * T.cols + col]; if (!cell) continue;
        const [w, h] = size(row, col, cell);
        let s: Pt = [x, y], e: Pt = [x + w, y + h];
        if (angle) {
          // PCB_TEXTBOX::Rotate slides the box: its centre turns about the stable centre, the box stays axis-aligned
          const cx = (s[0] + e[0]) / 2, cy = (s[1] + e[1]) / 2; const [rx, ry] = rotPt(cx - sc[0], cy - sc[1], angle);
          const dx = sc[0] + rx - cx, dy = sc[1] + ry - cy; s = [s[0] + dx, s[1] + dy]; e = [e[0] + dx, e[1] + dy];
        }
        setCellStartEnd(cell, true, s, e);
        x += W(col);
      }
      y += H(row);
    }
    return;
  }
  const p0 = cellStartEnd(T.cells[0], false).s;
  let y = p0[1];
  for (let row = 0; row < T.rows; row++) {
    let x = p0[0];
    for (let col = 0; col < T.cols; col++) {
      const cell = T.cells[row * T.cols + col]; if (!cell) continue;
      const angle = cellStartEnd(cell, false).angle;
      const turn = (p: Pt): Pt => { if (!angle) return p; const [rx, ry] = rotPt(p[0] - p0[0], p[1] - p0[1], angle); return [p0[0] + rx, p0[1] + ry]; };
      const [w, h] = size(row, col, cell);
      setCellStartEnd(cell, false, turn([x, y]), turn([x + w, y + h]));
      x += W(col);
    }
    y += H(row);
  }
}

// ---------------------------------------------------------------- table position (cell 0) and node plumbing
export function tablePosition(node: SNode, isPcb: boolean): Pt { const T = tableInfo(node); return T.cells.length ? cellStartEnd(T.cells[0], isPcb).s : [0, 0]; }
/** SetPosition: move every cell so cell 0 starts at `pos`. */
export function setTablePosition(node: SNode, isPcb: boolean, pos: Pt): void {
  const cur = tablePosition(node, isPcb), dx = pos[0] - cur[0], dy = pos[1] - cur[1];
  if (!dx && !dy) return;
  for (const c of tableInfo(node).cells) { const { s, e } = cellStartEnd(c, isPcb); setCellStartEnd(c, isPcb, [s[0] + dx, s[1] + dy], [e[0] + dx, e[1] + dy]); }
}
function writeSizes(node: SNode, isPcb: boolean, widths: number[], heights: number[], cols: number, rows: number): void {
  const r = (v: number) => roundIU(v, isPcb);
  const cw = kid(node, "column_widths"), rh = kid(node, "row_heights");
  const wv = Array.from({ length: cols }, (_, i) => r(at0(widths, i))), hv = Array.from({ length: rows }, (_, i) => r(at0(heights, i)));
  if (cw) cw.splice(1, cw.length - 1, ...wv); else node.splice(insertAt(node, ["row_heights", "uuid", "cells"]), 0, ["column_widths", ...wv]);
  const rh2 = kid(node, "row_heights");
  if (rh2) rh2.splice(1, rh2.length - 1, ...hv); else node.splice(insertAt(node, ["uuid", "cells"], "column_widths"), 0, ["row_heights", ...hv]);
  void rh;
}
function insertAt(node: SNode, before: string[], after?: string): number {
  if (after) { const j = node.findIndex((c) => Array.isArray(c) && c[0] === after); if (j > 0) return j + 1; }
  for (const b of before) { const j = node.findIndex((c) => Array.isArray(c) && c[0] === b); if (j > 0) return j; }
  return node.length;
}
function setColCount(node: SNode, n: number): void { const cc = kid(node, "column_count"); if (cc) cc[1] = n; else node.splice(1, 0, ["column_count", n]); }
/** Replace the cell list (keeps the (cells) node itself and anything in it that is not a cell). */
function setCells(node: SNode, cells: SNode[]): void {
  const cn = kid(node, "cells"); if (!cn) { node.push(["cells", ...cells]); return; }
  const rest = cn.slice(1).filter((c) => !(Array.isArray(c) && c[0] === "table_cell"));
  cn.splice(1, cn.length - 1, ...cells, ...rest);
}

/** copyCell: the source's formatting (font, justification, margins, fill, span) under a new uuid, with no text. */
export function copyCell(src: SNode, uuid: string): SNode {
  const c = cloneNode(src); setText(c, "");
  const u = kid(c, "uuid"); if (u) u[1] = uuid; else c.push(["uuid", uuid]);
  return c;
}

type Uuid = () => string;
const rowOf = (i: number, cols: number) => Math.floor(i / cols), colOf = (i: number, cols: number) => i % cols;

// ---------------------------------------------------------------- structure edits
/** doAddRowAbove (below = false) / doAddRowBelow on row `row`. */
export function addRow(node0: SNode, isPcb: boolean, row: number, below: boolean, uuid: Uuid): SNode {
  const node = cloneNode(node0), T = tableInfo(node); const pos = tablePosition(node, isPcb);
  const sources = Array.from({ length: T.cols }, (_, c) => T.cells[row * T.cols + c]);
  const cells = T.cells.slice(); const at = (below ? row + 1 : row) * T.cols;
  cells.splice(at, 0, ...sources.map((s) => copyCell(s, uuid())));
  const rows = T.rows + 1, heights = T.heights.slice(0, Math.max(T.heights.length, rows));
  for (let r = rows - 1; r > row; r--) heights[r] = at0(heights, r - 1);
  setCells(node, cells); writeSizes(node, isPcb, T.widths, heights, T.cols, rows);
  setTablePosition(node, isPcb, pos); normalizeTable(node, isPcb);
  return node;
}

/** doAddColumnBefore (after = false) / doAddColumnAfter on column `col`. */
export function addCol(node0: SNode, isPcb: boolean, col: number, after: boolean, uuid: Uuid): SNode {
  const node = cloneNode(node0), T = tableInfo(node); const pos = tablePosition(node, isPcb);
  const sources = Array.from({ length: T.rows }, (_, r) => T.cells[r * T.cols + col]);
  const cols = T.cols + 1, cells = T.cells.slice();
  for (let r = 0; r < T.rows; r++) cells.splice(r * cols + col + (after ? 1 : 0), 0, copyCell(sources[r], uuid()));
  const widths = T.widths.slice(0, Math.max(T.widths.length, cols));
  for (let c = cols - 1; c > col; c--) widths[c] = at0(widths, c - 1);
  setColCount(node, cols); setCells(node, cells); writeSizes(node, isPcb, widths, T.heights, cols, T.rows);
  setTablePosition(node, isPcb, pos); normalizeTable(node, isPcb);
  return node;
}

/** The rows (or columns) holding a selected cell, ascending. */
export function rowsOf(node: SNode, sel: Iterable<number>): number[] { const T = tableInfo(node); return Array.from(new Set(Array.from(sel, (i) => rowOf(i, T.cols)))).filter((r) => r < T.rows).sort((a, b) => a - b); }
export function colsOf(node: SNode, sel: Iterable<number>): number[] { const T = tableInfo(node); return Array.from(new Set(Array.from(sel, (i) => colOf(i, T.cols)))).sort((a, b) => a - b); }

/** doDeleteRows: "remove" when every row goes (the table is removed), else the new node. */
export function deleteRows(node0: SNode, isPcb: boolean, rows: number[]): SNode | "remove" {
  const T0 = tableInfo(node0); const del = new Set(rows.filter((r) => r >= 0 && r < T0.rows));
  if (del.size === T0.rows) return "remove";
  const node = cloneNode(node0), T = tableInfo(node); const pos = tablePosition(node, isPcb);
  const cells = T.cells.filter((_, i) => !del.has(rowOf(i, T.cols)));
  const keep = Array.from({ length: T.rows }, (_, r) => r).filter((r) => !del.has(r));
  setCells(node, cells); writeSizes(node, isPcb, T.widths, keep.map((r) => at0(T.heights, r)), T.cols, keep.length);
  setTablePosition(node, isPcb, pos); normalizeTable(node, isPcb);
  return node;
}
export function deleteCols(node0: SNode, isPcb: boolean, cols: number[]): SNode | "remove" {
  const T0 = tableInfo(node0); const del = new Set(cols.filter((c) => c >= 0 && c < T0.cols));
  if (del.size === T0.cols) return "remove";
  const node = cloneNode(node0), T = tableInfo(node); const pos = tablePosition(node, isPcb);
  const cells = T.cells.filter((_, i) => !del.has(colOf(i, T.cols)));
  const keep = Array.from({ length: T.cols }, (_, c) => c).filter((c) => !del.has(c));
  setColCount(node, keep.length); setCells(node, cells); writeSizes(node, isPcb, keep.map((c) => at0(T.widths, c)), T.heights, keep.length, T.rows);
  setTablePosition(node, isPcb, pos); normalizeTable(node, isPcb);
  return node;
}

/** The block the selected cells cover: [colMin, colMax) × [rowMin, rowMax) with spans, and the summed span area. */
export function cellBlockBounds(node: SNode, sel: Iterable<number>): { colMin: number; colMax: number; rowMin: number; rowMax: number; area: number; n: number } {
  const T = tableInfo(node); let colMin = Infinity, colMax = 0, rowMin = Infinity, rowMax = 0, area = 0, n = 0;
  for (const i of sel) {
    const c = T.cells[i]; if (!c) continue; const [cs, rs] = spanOf(c); const r = rowOf(i, T.cols), k = colOf(i, T.cols);
    colMin = Math.min(colMin, k); colMax = Math.max(colMax, k + cs); rowMin = Math.min(rowMin, r); rowMax = Math.max(rowMax, r + rs); area += cs * rs; n++;
  }
  return { colMin, colMax, rowMin, rowMax, area, n };
}
/** addMenus' cellBlockSelection: two or more cells whose spans tile their bounding block. */
export function isCellBlock(node: SNode, sel: Iterable<number>): boolean {
  const b = cellBlockBounds(node, sel); return b.n >= 2 && b.area === (b.colMax - b.colMin) * (b.rowMax - b.rowMin);
}
/** mergedCellsSelection */
export function hasMergedCell(node: SNode, sel: Iterable<number>): boolean {
  const T = tableInfo(node); for (const i of sel) { const [cs, rs] = spanOf(T.cells[i]); if (cs > 1 || rs > 1) return true; } return false;
}

/** doMergeCells */
export function mergeCells(node0: SNode, isPcb: boolean, sel: number[]): SNode {
  const node = cloneNode(node0), T = tableInfo(node); const b = cellBlockBounds(node, sel);
  if (!b.n) return node;
  let content = ""; let ex = 0, ey = 0;
  for (let row = b.rowMin; row < b.rowMax; row++) {
    ey += at0(T.heights, row); ex = 0;
    for (let col = b.colMin; col < b.colMax; col++) {
      ex += at0(T.widths, col);
      const cell = T.cells[row * T.cols + col]; if (!cell) continue;
      const t = cellText(cell); if (t) { if (content) content += "\n"; content += t; }
      setSpan(cell, 0, 0); setText(cell, "");
    }
  }
  const tl = T.cells[b.rowMin * T.cols + b.colMin];
  if (tl) {
    setSpan(tl, b.colMax - b.colMin, b.rowMax - b.rowMin); setText(tl, content);
    const { s } = cellStartEnd(tl, isPcb); setCellStartEnd(tl, isPcb, s, [s[0] + ex, s[1] + ey]);
  }
  normalizeTable(node, isPcb);
  return node;
}

/** doUnmergeCells */
export function unmergeCells(node0: SNode, isPcb: boolean, sel: number[]): SNode {
  const node = cloneNode(node0), T = tableInfo(node);
  for (const i of sel) {
    const cell = T.cells[i]; if (!cell) continue; const [cs, rs] = spanOf(cell); const r0 = rowOf(i, T.cols), c0 = colOf(i, T.cols);
    for (let row = r0; row < r0 + rs; row++) for (let col = c0; col < c0 + cs; col++) {
      const t = T.cells[row * T.cols + col]; if (!t) continue;
      setSpan(t, 1, 1); const { s } = cellStartEnd(t, isPcb); setCellStartEnd(t, isPcb, s, [s[0] + at0(T.widths, col), s[1] + at0(T.heights, row)]);
    }
  }
  normalizeTable(node, isPcb);
  return node;
}

/** Select Row(s) / Select Column(s): every cell of each row (column) holding a selected cell is added. */
export function expandToRows(node: SNode, sel: Iterable<number>): number[] {
  const T = tableInfo(node); const out = new Set(sel);
  for (const r of rowsOf(node, sel)) for (let c = 0; c < T.cols; c++) { const i = r * T.cols + c; if (selectableCell(T.cells[i])) out.add(i); }
  return Array.from(out).sort((a, b) => a - b);
}
export function expandToCols(node: SNode, sel: Iterable<number>): number[] {
  const T = tableInfo(node); const out = new Set(sel);
  for (const c of colsOf(node, sel)) for (let r = 0; r < T.rows; r++) { const i = r * T.cols + c; if (selectableCell(T.cells[i])) out.add(i); }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * The clipboard copy of a cell selection (saveTable / format with SKIP_STRUCT): the selected cells only, with the
 * row heights and column widths of their range; cells keep their own positions (no Normalize, as KiCad).
 */
export function trimToSelection(node0: SNode, isPcb: boolean, sel: Iterable<number>): SNode {
  const node = cloneNode(node0), T = tableInfo(node); const s = new Set(sel);
  let minR = T.rows, maxR = -1, minC = T.cols, maxC = -1;
  for (let i = 0; i < T.cells.length; i++) if (s.has(i)) { const r = rowOf(i, T.cols), c = colOf(i, T.cols); minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c); }
  if (maxR < 0) return node;
  const heights = T.heights.slice(), widths = T.widths.slice();
  for (let r = minR, d = 0; r <= maxR; r++) heights[d++] = at0(T.heights, r);
  for (let c = minC, d = 0; c <= maxC; c++) widths[d++] = at0(T.widths, c);
  const cols = maxC - minC + 1, cells = T.cells.filter((_, i) => s.has(i));
  setColCount(node, cols); setCells(node, cells);
  writeSizes(node, isPcb, widths, heights, cols, Math.floor(cells.length / cols));
  return node;
}

/** validatePasteIntoSelection: the error text, or "" when cells can be pasted into the selection. */
export function pasteIntoError(node: SNode | null, sel: number[], generated: boolean, mixed = false): string {
  if (!sel.length || !node) return "No cells selected";
  if (mixed) return "Selection contains non-cell items";
  if (generated) return "Cannot paste into a table whose cells are generated";
  const T = tableInfo(node);
  for (const i of sel) { const [cs, rs] = spanOf(T.cells[i]); if (cs > 1 || rs > 1) return "Cannot paste into merged cells"; }
  const b = cellBlockBounds(node, sel);
  if (sel.length > 1 && b.area !== (b.colMax - b.colMin) * (b.rowMax - b.rowMin)) return "Selected cells must form a contiguous block";
  return "";
}

/** The attributes SetAttributes / SetStroke / SetFill* copy from a source cell (everything but the text, place and id). */
const CELL_ATTRS = ["effects", "fill", "stroke", "margins", "knockout"];
/** pasteCellsIntoSelection: the target table grows to fit, then each source cell's text and attributes land on the block. */
export function pasteCells(target0: SNode, isPcb: boolean, sel: number[], src: SNode, uuid: Uuid): SNode {
  let node = cloneNode(target0); const S = tableInfo(src); const b = cellBlockBounds(node, sel);
  const endRow = b.rowMin + S.rows, endCol = b.colMin + S.cols;
  let T = tableInfo(node);
  if (endRow > T.rows || endCol > T.cols) {
    const pos = tablePosition(node, isPcb);
    const rowsToAdd = Math.max(0, endRow - T.rows), colsToAdd = Math.max(0, endCol - T.cols);
    let cells = T.cells.slice(), cols = T.cols, rows = T.rows; const heights = T.heights.slice(), widths = T.widths.slice();
    for (let k = 0; k < rowsToAdd; k++) {
      const insertRow = rows, clipRow = insertRow - b.rowMin;
      const sources = Array.from({ length: S.cols }, (_, c) => S.cells[clipRow * S.cols + c]);
      const add: SNode[] = []; for (let c = 0; c < cols; c++) add.push(copyCell(c < S.cols ? sources[c] : sources[0], uuid()));
      cells.splice(insertRow * cols, 0, ...add); rows++;
      for (let r = rows - 1; r > insertRow; r--) heights[r] = at0(heights, r - 1);
      heights[insertRow] = at0(S.heights, clipRow);
    }
    for (let k = 0; k < colsToAdd; k++) {
      const insertCol = cols, clipCol = insertCol - b.colMin; cols++;
      const sources = Array.from({ length: S.rows }, (_, r) => S.cells[r * S.cols + clipCol]);
      for (let r = 0; r < rows; r++) cells.splice(r * cols + insertCol, 0, copyCell(r < S.rows ? sources[r] : sources[0], uuid()));
      for (let c = cols - 1; c > insertCol; c--) widths[c] = at0(widths, c - 1);
      widths[insertCol] = at0(S.widths, clipCol);
    }
    setColCount(node, cols); setCells(node, cells); writeSizes(node, isPcb, widths, heights, cols, rows);
    setTablePosition(node, isPcb, pos); normalizeTable(node, isPcb);
    T = tableInfo(node); cells = T.cells;
  }
  for (let sr = 0; sr < S.rows; sr++) for (let sc = 0; sc < S.cols; sc++) {
    const dr = b.rowMin + sr, dc = b.colMin + sc; if (dr >= T.rows || dc >= T.cols) continue;
    const s = S.cells[sr * S.cols + sc], t = T.cells[dr * T.cols + dc]; if (!s || !t) continue;
    setText(t, cellText(s));
    for (const key of CELL_ATTRS) {
      const sv = kid(s, key), ti = t.findIndex((c) => Array.isArray(c) && c[0] === key);
      if (sv && ti > 0) t[ti] = cloneNode(sv);
      else if (sv) { const u = t.findIndex((c) => Array.isArray(c) && (c[0] === "uuid" || c[0] === "effects")); t.splice(u > 0 ? u : t.length, 0, cloneNode(sv)); }
      else if (ti > 0 && key !== "margins") t.splice(ti, 1);
    }
  }
  normalizeTable(node, isPcb);
  node = node as SNode;
  return node;
}

/** CSV of the table (ExportTableToCSV's escapeCSV), each cell's shown text. */
export function tableCsv(node: SNode, shown: (text: string, row: number, col: number) => string = (t) => t): string {
  const T = tableInfo(node); let out = "";
  const esc = (f: string) => (/[,"\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f);
  for (let r = 0; r < T.rows; r++) {
    for (let c = 0; c < T.cols; c++) { out += esc(shown(cellText(T.cells[r * T.cols + c]), r, c)); if (c < T.cols - 1) out += ","; }
    out += "\n";
  }
  return out;
}

/** Spreadsheet-style column letters (A..Z, AA..) as PCB_TABLECELL::GetAddr / SCH_TABLECELL::GetColumnName use. */
export function columnName(col: number): string { let s = "", n = col; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; }

/** Clear the text of the given cells (DoDelete on a cell selection). */
export function clearCellText(node0: SNode, sel: Iterable<number>): SNode {
  const node = cloneNode(node0), T = tableInfo(node); for (const i of sel) if (T.cells[i]) setText(T.cells[i], ""); return node;
}

/**
 * The point editor's two handles of a cell (EDA_TABLECELL_POINT_EDIT_BEHAVIOR): COL_WIDTH on the middle of the right
 * edge, ROW_HEIGHT on the middle of the bottom edge (a board cell's edges as drawn, turned by its angle).
 */
export function cellHandles(cell: SNode, isPcb: boolean): { col: Pt; row: Pt } {
  if (isPcb) { const c = cellCorners(cell, true); return { col: [(c[1][0] + c[2][0]) / 2, (c[1][1] + c[2][1]) / 2], row: [(c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2] }; }
  const { s, e } = cellStartEnd(cell, false); return { col: [e[0], e[1] - (e[1] - s[1]) / 2], row: [e[0] - (e[0] - s[0]) / 2, e[1]] };
}

/**
 * PCB_TABLECELL_POINT_EDIT_BEHAVIOR / SCH_TABLECELL_POINT_EDIT_BEHAVIOR::UpdateItem: the cell's end follows the dragged
 * handle, the last column (row) of its span takes the new size, then Normalize.
 */
export function resizeCell(node0: SNode, isPcb: boolean, idx: number, which: "col" | "row", pt: Pt): SNode {
  const node = cloneNode(node0), T = tableInfo(node); const cell = T.cells[idx]; if (!cell) return node;
  const { s, e, angle } = cellStartEnd(cell, isPcb); const [cs, rs] = spanOf(cell); const row = rowOf(idx, T.cols), col = colOf(idx, T.cols);
  let p = pt;
  if (isPcb && angle) { const cx = (s[0] + e[0]) / 2, cy = (s[1] + e[1]) / 2; const [rx, ry] = rotPt(pt[0] - cx, pt[1] - cy, -angle); p = [cx + rx, cy + ry]; }
  const widths = T.widths.slice(), heights = T.heights.slice();
  const schRot = !isPcb && ((Math.round(angle) % 180) + 180) % 180 !== 0;
  if (which === "col") {
    const ne: Pt = [roundIU(p[0], isPcb), e[1]]; setCellStartEnd(cell, isPcb, s, ne);
    if (schRot) { let h = Math.abs(ne[0] - s[0]); for (let k = 0; k < rs - 1; k++) h -= at0(heights, row + k); heights[row + rs - 1] = h; }
    else { let w = ne[0] - s[0]; if (isPcb) w = Math.abs(w); for (let k = 0; k < cs - 1; k++) w -= at0(widths, col + k); widths[col + cs - 1] = w; }
  } else {
    const ne: Pt = [e[0], roundIU(p[1], isPcb)]; setCellStartEnd(cell, isPcb, s, ne);
    if (schRot) { let w = Math.abs(ne[1] - s[1]); for (let k = 0; k < cs - 1; k++) w -= at0(widths, col + k); widths[col + cs - 1] = w; }
    else { let h = ne[1] - s[1]; if (isPcb) h = Math.abs(h); for (let k = 0; k < rs - 1; k++) h -= at0(heights, row + k); heights[row + rs - 1] = h; }
  }
  writeSizes(node, isPcb, widths, heights, T.cols, T.rows); normalizeTable(node, isPcb);
  return node;
}

export const tableModel = {
  tableInfo, spanOf, cellText, cellStartEnd, setCellStartEnd, cellCorners, cellCentre, selectableCell, cellAt, cellsInRect, normalizeTable,
  tablePosition, setTablePosition, copyCell, addRow, addCol, rowsOf, colsOf, deleteRows, deleteCols, cellBlockBounds, isCellBlock, hasMergedCell,
  mergeCells, unmergeCells, expandToRows, expandToCols, trimToSelection, pasteIntoError, pasteCells, tableCsv, columnName, clearCellText,
  cellHandles, resizeCell,
};
export type TableModel = typeof tableModel;
