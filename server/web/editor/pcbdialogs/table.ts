// pcbdialogs/table — Table Properties (DIALOG_TABLE_PROPERTIES) for a board table.
// The cell contents sit in a grid shaped like the table (columns reversed on a back layer, as the dialog shows the
// table as it reads); a cell covered by a merged neighbour is greyed and read-only.  Below: Layer and Locked, then
// External border / Header border with their width and style, and Row lines / Column lines with theirs.  OK
// (TransferDataFromWindow) writes every cell's text and layer, the table's layer and lock, and the two strokes
// (a stroke with neither of its lines on is written without width, its width -1); one "Edit Table" change.  The
// table tool (DRAWING_TOOL::DrawTable) opens it on the table just drawn and commits "Draw Table" on OK.
import { box, checkField, form, h, lenField, openDialog, selectField, unitLabel, type Field } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const kids = (n: SNode | null, key: string): SNode[] => (n ? n.filter((c) => isList(c) && c[0] === key) as SNode[] : []);
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const f6 = (v: number): string => String(+(+v).toFixed(6));
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");

interface LockApi { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode; gfxWidth?(layer: string): number }
const PT = (): LockApi => (window as unknown as { PcbTools: LockApi }).PcbTools;

function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
function put(node: SNode, key: string, text: string | null, before: string[] = []): void {
  const i = idxOf(node, key);
  if (text === null) { if (i > 0) node.splice(i, 1); return; }
  const n = K().parse(text) as SNode;
  if (i > 0) { node[i] = n; return; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, n);
}
const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };
const layerOptions = (doc: KDoc, cur: string): [string, string][] => {
  const all = Array.from(doc.layers.keys()).map((n): [string, string] => [n, layerLabel(doc, n)]);
  return cur && !all.some((o) => o[0] === cur) ? [[cur, cur], ...all] : all;
};
const isBack = (layer: string): boolean => layer.startsWith("B.");   // IsBackLayer

/** lineTypeNames: the combo's order is LINE_STYLE's (SOLID = 0 …); DEFAULT shows as the first entry. */
export const LINE_STYLES: [string, string][] = [["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];

export interface TableValues {
  cells: string[][]; layer: string; locked: boolean; external: boolean; header: boolean; borderWidth: number; borderStyle: string;
  rows: boolean; cols: boolean; sepWidth: number; sepStyle: string;
}

/** The table's cells as rows × columns (null for a cell the file lacks). */
export function tableCells(node: SNode): { rows: number; cols: number; cell(r: number, c: number): SNode | null } {
  const cols = Math.max(1, nval(kid(node, "column_count"), 1, 1)), list = kids(kid(node, "cells"), "table_cell");
  const rows = Math.max(1, Math.ceil(list.length / cols));
  return { rows, cols, cell: (r, c) => list[r * cols + c] || null };
}
const covered = (cell: SNode | null): boolean => { const sp = kid(cell, "span"); return !!sp && (nval(sp, 1, 1) === 0 || nval(sp, 2, 1) === 0); };
const strokeOf = (n: SNode | null): { width: number; style: string } => {
  const st = kid(n, "stroke"); const w = kid(st, "width"), t = sval(kid(st, "type"));
  return { width: st && w ? nval(w) : -1, style: t && t !== "default" ? t : "solid" };
};

/** TransferDataToWindow. */
export function tableValues(node: SNode): TableValues {
  const layer = sval(kid(node, "layer")), T = tableCells(node), back = isBack(layer);
  const cells: string[][] = [];
  for (let r = 0; r < T.rows; r++) { const row: string[] = []; for (let c = 0; c < T.cols; c++) { const cell = T.cell(r, back ? T.cols - 1 - c : c); row.push(cell && !covered(cell) ? sval(cell) : ""); } cells.push(row); }
  const border = kid(node, "border"), seps = kid(node, "separators"), bs = strokeOf(border), ss = strokeOf(seps);
  const rows = yes(kid(seps, "rows")) && ss.width >= 0, cols = yes(kid(seps, "cols")) && ss.width >= 0;
  return { cells, layer, locked: PT().isLocked(node), external: yes(kid(border, "external")), header: yes(kid(border, "header")),
    borderWidth: bs.width, borderStyle: bs.style, rows, cols, sepWidth: ss.width, sepStyle: ss.style };
}

/** TransferDataFromWindow on a copy of the node. */
export function applyTable(orig: SNode, v: TableValues): SNode {
  const node = (K().cloneNode as (n: SNode) => SNode)(orig), T = tableCells(node), back = isBack(sval(kid(orig, "layer")));
  for (let r = 0; r < T.rows; r++) for (let c = 0; c < T.cols; c++) {
    const cell = T.cell(r, back ? T.cols - 1 - c : c); if (!cell) continue;
    cell[1] = covered(cell) ? "" : (v.cells[r] && v.cells[r][c] !== undefined ? v.cells[r][c] : sval(cell)).replace(/\r/g, "");
    put(cell, "layer", `(layer ${quote(v.layer)})`, ["uuid", "effects"]);
  }
  put(node, "layer", `(layer ${quote(v.layer)})`, ["column_count"]);
  if (v.locked !== PT().isLocked(node)) PT().setLocked(node, v.locked);
  const stroke = (on: boolean, w: number, style: string): string => (on ? ` (stroke (width ${f6(Math.max(0, isFinite(w) ? w : 0))}) (type ${style}))` : "");
  put(node, "border", `(border (external ${v.external ? "yes" : "no"}) (header ${v.header ? "yes" : "no"})${stroke(v.external || v.header, v.borderWidth, v.borderStyle)})`, ["separators", "column_widths"]);
  put(node, "separators", `(separators (rows ${v.rows ? "yes" : "no"}) (cols ${v.cols ? "yes" : "no"})${stroke(v.rows || v.cols, v.sepWidth, v.sepStyle)})`, ["column_widths", "row_heights"]);
  return node;
}

/** DIALOG_TABLE_PROPERTIES.  `create`: the dialog of a table being drawn (OK hands the node over, Cancel null). */
export function tableDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, ro = !!ctx.viewOnly, v0 = tableValues(node0), T = tableCells(node0), back = isBack(v0.layer);
  const inputs: (HTMLTextAreaElement | null)[][] = [];
  let f: Record<string, Field<string | number | boolean>> = {};
  const current = (): TableValues => ({
    cells: inputs.map((row, r) => row.map((t, c) => (t ? t.value : v0.cells[r][c]))), layer: String(f.layer.get()), locked: !!f.locked.get(),
    external: !!f.external.get(), header: !!f.header.get(), borderWidth: Number(f.borderWidth.get()), borderStyle: String(f.borderStyle.get()),
    rows: !!f.rows.get(), cols: !!f.cols.get(), sepWidth: Number(f.sepWidth.get()), sepStyle: String(f.sepStyle.get()) });
  return !!openDialog({ title: "Table Properties", width: 640, readOnly: ro, noEnter: true,
    build(body) {
      // the cell grid, sized like the table (sizeGridToTable)
      const widths = (kid(node0, "column_widths") || []).slice(1).map(Number), heights = (kid(node0, "row_heights") || []).slice(1).map(Number);
      const tw = widths.reduce((a, b) => a + b, 0) || 1;
      const cols = Array.from({ length: T.cols }, (_, c) => `${Math.max(0.5, (widths[back ? T.cols - 1 - c : c] || tw / T.cols) / tw * T.cols)}fr`).join(" ");
      const gridEl = h("div", { class: "pd-tablegrid", "data-k": "cells", style: `display:grid;grid-template-columns:${cols};gap:1px;background:var(--line);border:1px solid var(--line);max-height:260px;overflow:auto` });
      let first: HTMLTextAreaElement | null = null;
      for (let r = 0; r < T.rows; r++) {
        const row: (HTMLTextAreaElement | null)[] = [];
        for (let c = 0; c < T.cols; c++) {
          const cell = T.cell(r, back ? T.cols - 1 - c : c);
          const hgt = Math.max(28, Math.min(90, (heights[r] || 3) * 8));
          if (covered(cell)) { gridEl.append(h("div", { class: "pd-covered", style: `min-height:${hgt}px;background:var(--panel-2)`, title: "Covered by a merged cell" })); row.push(null); continue; }
          const t = h("textarea", { "data-k": `cell-${r}-${c}`, readOnly: ro, spellcheck: false, style: `min-height:${hgt}px;resize:none;border:0;border-radius:0;padding:3px 4px;font:inherit;background:var(--bench);color:var(--ink)` });
          t.value = v0.cells[r][c];
          t.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); if (ev.shiftKey) { ev.preventDefault(); const ok = (body.parentElement as HTMLElement).querySelector<HTMLButtonElement>(".kd-foot > button:last-child"); if (ok) ok.click(); } } });
          if (!first) first = t;
          gridEl.append(t); row.push(t);
        }
        inputs.push(row);
      }
      if (first) { const fc = first; setTimeout(() => fc.focus(), 0); }
      const lineW = (): number => { const lw = PT().gfxWidth ? (PT().gfxWidth as (l: string) => number)(String(f.layer.get())) : 0.1; return lw; };
      const layer = selectField<string>(v0.layer, layerOptions(doc, v0.layer), { ro, key: "layer" });
      const locked = checkField(v0.locked, "Locked", { ro, key: "locked" });
      const bw = lenField(v0.borderWidth >= 0 ? v0.borderWidth : NaN, { ro: ro || !(v0.external || v0.header), key: "borderWidth", allowEmpty: true });
      const bstyle = selectField<string>(v0.borderStyle, LINE_STYLES, { ro: ro || !(v0.external || v0.header), key: "borderStyle" });
      const sw = lenField(v0.sepWidth >= 0 ? v0.sepWidth : NaN, { ro: ro || !(v0.rows || v0.cols), key: "sepWidth", allowEmpty: true });
      const sstyle = selectField<string>(v0.sepStyle, LINE_STYLES, { ro: ro || !(v0.rows || v0.cols), key: "sepStyle" });
      // onBorderChecked / onHeaderChecked: a stroke turned on with no width takes the layer class's line thickness
      const sync = (): void => {
        const b = !!f.external.get() || !!f.header.get(), s = !!f.rows.get() || !!f.cols.get();
        if (b && !(bw.get() >= 0)) bw.set(lineW());
        if (s && !(sw.get() >= 0)) sw.set(lineW());
        bw.input.disabled = bstyle.input.disabled = ro || !b; sw.input.disabled = sstyle.input.disabled = ro || !s;
      };
      const external = checkField(v0.external, "External border", { ro, key: "external", onChange: sync }), header = checkField(v0.header, "Header border", { ro, key: "header", onChange: sync });
      const rows = checkField(v0.rows, "Row lines", { ro, key: "rows", onChange: sync }), cols2 = checkField(v0.cols, "Column lines", { ro, key: "cols", onChange: sync });
      f = { layer, locked, external, header, borderWidth: bw, borderStyle: bstyle, rows, cols: cols2, sepWidth: sw, sepStyle: sstyle } as unknown as Record<string, Field<string | number | boolean>>;
      body.append(h("label", { class: "pd-lbl" }, "Cell contents:"), gridEl,
        h("div", { class: "pd-cols2", style: "margin-top:10px" }, form([["Layer:", layer.el]], true), h("div", { class: "pd-row" }, locked.el)),
        h("div", { class: "pd-cols2" },
          box("", external.el, header.el, form([["Width:", bw.el, unitLabel()], ["Style:", bstyle.el]], true)),
          box("", rows.el, cols2.el, form([["Width:", sw.el, unitLabel()], ["Style:", sstyle.el]], true))));
      for (const b of Array.from(body.querySelectorAll<HTMLElement>(".pd-box > .hd"))) if (!b.textContent) b.remove();
    },
    cancel: create ? () => create(null) : undefined,
    ok() {
      if (ro) return true;
      const v = current();
      if (!create && JSON.stringify(v) === JSON.stringify(v0)) return true;   // nothing changed
      const node = applyTable(node0, v);
      if (create) { create(node); return true; }
      if (K().serialize(node) === K().serialize(node0)) return true;
      ctx.commit([K().replaceChange(doc, { ...item, node, geom: [], bbox: null })], "Edit Table");
      return true;
    } });
}

/** The table tool: the dialog on the table just drawn; done gets the node, or null on Cancel. */
export function newTableDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = tableDialog(ctx, { id: "", kind: "table", node, geom: [], bbox: null } as unknown as KItem, done);
  if (!ok) done(null);
  return ok;
}
