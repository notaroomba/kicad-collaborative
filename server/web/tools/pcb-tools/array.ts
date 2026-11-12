// pcb-tools/array.ts — Create Array / Arrange: ARRAY_OPTIONS and ARRAY_TOOL in nanometres.
import type { BoardDoc, PcbChange, Pt } from "./types";

/** ARRAY_OPTIONS as the dialog fills it in: a grid's or a circular array's fields (see arrayTransform), and the tool's own. */
export interface ArrayOpts {
  type: string; nx?: number; ny?: number; dx?: number; dy?: number; offX?: number; offY?: number; stagger?: number; staggerRows?: boolean;
  centred?: boolean; hThenV?: boolean; reverseAlt?: boolean;
  centre?: Pt; angle?: number; angleOffset?: number; clockwise?: boolean; count?: number; rotateItems?: boolean;
  arrange?: boolean; keepRefs?: boolean;
}
/** One copy's move: the offset in mm and the rotation in degrees. */
export interface ArrayStep { offset: Pt; rot: number }
import { duplicateChanges } from "./clipboard";
import { expandGroups, groupOf } from "./groups";
import { anchorOf, rotateNode, selectionCenter, transformChanges, translateNode } from "./transforms";
import { r6, rotator } from "./util";

// ---------------------------------------------------------------- ARRAY_OPTIONS (common/array_options.cpp), in nanometres
export const AIU = 1e6;
/** ARRAY_OPTIONS::GetArraySize. */
export const arraySize = (o: ArrayOpts) => o.type === "circular" ? Math.max(0, Math.trunc(o.count!)) : Math.max(0, Math.trunc(o.nx!)) * Math.max(0, Math.trunc(o.ny!));
/** ARRAY_GRID_OPTIONS::getGridCoords. */
export function arrayGridCoords(o: ArrayOpts, n: number) {
  const axis = (o.hThenV ? o.nx : o.ny)!; let x = n % axis; const y = Math.trunc(n / axis);
  if (o.reverseAlt && (y % 2)) x = axis - x - 1;
  return [x, y];
}
/**
 * ARRAY_OPTIONS::GetTransform( n, aPos ): { offset (mm), rot (degrees) } for the n-th copy of an item whose position
 * (GetPosition) is pos.  Grid: o = { type: "grid", nx, ny, dx, dy, offX, offY (mm), stagger, staggerRows, centred, hThenV,
 * reverseAlt }; circular: o = { type: "circular", centre (mm), angle, angleOffset (degrees), clockwise, count, rotateItems }.
 */
export function arrayTransform(o: ArrayOpts, n: number, pos: Pt): ArrayStep {
  const iu = (v: number | undefined) => Math.round((v || 0) * AIU);
  if (o.type === "circular") {
    let a = !o.angle ? 360 * n / o.count! : o.angle * n;
    a += o.angleOffset || 0; if (o.clockwise) a = -a;
    const p = [iu(pos[0]), iu(pos[1])], c = [iu(o.centre![0]), iu(o.centre![1])];
    const [rx, ry] = rotator(a)(p[0] - c[0], p[1] - c[1]); const np = [Math.round(c[0] + rx), Math.round(c[1] + ry)];   // RotatePoint: KiROUND
    return { offset: [(np[0] - p[0]) / AIU, (np[1] - p[1]) / AIU], rot: o.rotateItems ? a : 0 };
  }
  let [cx, cy] = arrayGridCoords(o, n); if (!o.hThenV) [cx, cy] = [cy, cx];
  const dx = iu(o.dx), dy = iu(o.dy), ox = iu(o.offX), oy = iu(o.offY);
  let x = cx * dx + cy * ox, y = cy * dy + cx * oy;
  const st = Math.trunc(o.stagger || 0);
  if (Math.abs(st) > 1) {
    const S_ = Math.abs(st), sr = !!o.staggerRows, idx = (sr ? cy : cx) % S_, f = Math.sign(st) * idx;
    // VECTOR2I * double, then / int: each step truncates toward zero
    x += Math.trunc(Math.trunc((sr ? dx : ox) * f) / S_); y += Math.trunc(Math.trunc((sr ? oy : dy) * f) / S_);
  }
  if (o.centred) {
    const ex = (o.nx! - 1) * dx + (o.ny! - 1) * ox, ey = (o.ny! - 1) * dy + (o.nx! - 1) * oy;
    x -= Math.trunc(ex / 2); y -= Math.trunc(ey / 2);
  }
  return { offset: [x / AIU, y / AIU], rot: 0 };
}
/** arrayHasStackedPositions: two copies would land on the same offset and rotation. */
export function arrayStacked(o: ArrayOpts, pos: Pt) {
  const seen = new Set<string>();
  for (let i = 0; i < arraySize(o); i++) { const t = arrayTransform(o, i, pos); const k = `${Math.round(t.offset[0] * AIU)},${Math.round(t.offset[1] * AIU)},${r6(t.rot)}`; if (seen.has(k)) return true; seen.add(k); }
  return false;
}
/** ARRAY_TOOL's origin: a lone item's position, else the selection's centre. */
export function arrayOrigin(doc: BoardDoc, ids: string[]) { const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; return items.length === 1 ? anchorOf(items[0]) : selectionCenter(items); }
/** TransformItem: Move by the offset, then Rotate about the item's (new) position. */
export function arrayApply(node: SNode, t: ArrayStep, pos: Pt) { if (t.offset[0] || t.offset[1]) translateNode(node, t.offset[0], t.offset[1]); if (t.rot) rotateNode(node, pos[0] + t.offset[0], pos[1] + t.offset[1], t.rot); }
/**
 * ARRAY_TOOL::onDialogClosed.  Duplicate (o.arrange false): the selection is copied into every other cell of the array
 * (BOARD_ITEM::Duplicate / PCB_GROUP::DeepDuplicate, copies in a group join it), footprints reannotated unless
 * o.keepRefs; the originals take the first cell, which moves them only for a centred grid or a circular first angle.
 * "Create Array", the copies and the originals selected.  Arrange (o.arrange): the selected items, in order, go one
 * to a cell starting from the first one's position — "Arrange selection".  Returns { changes, ids, label }.
 */
export function arrayChanges(doc: BoardDoc, ids: string[], o: ArrayOpts) {
  const N = arraySize(o); const sel = new Set(ids); const out: { changes: PcbChange[]; ids: string[]; label: string } = { changes: [], ids: [], label: o.arrange ? "Arrange selection" : "Create Array" };
  const coveredByGroup = (id: string) => { for (let g = groupOf(doc, id); g; g = groupOf(doc, g.id)) if (sel.has(g.id)) return true; return false; };
  const roots = ids.map((id: string) => doc.items.get(id)).filter((it: KItem | undefined) => it && it.kind !== "generated" && !coveredByGroup(it.id)) as KItem[];
  const moveRoot = (it: KItem, fn: (n: SNode, it: KItem) => unknown) => { const members = Array.from(expandGroups(doc, [it.id])); out.changes.push(...transformChanges(doc, members, fn)); };
  if (o.arrange) {
    const first = roots[0]; if (!first) return out; const p0 = anchorOf(first);
    roots.slice(0, N).forEach((it: KItem, i: number) => {
      const pos = anchorOf(it), t = arrayTransform(o, i, p0), d = [p0[0] - pos[0], p0[1] - pos[1]];
      if (!t.offset[0] && !t.offset[1] && !t.rot && !d[0] && !d[1]) return;
      moveRoot(it, (n: SNode) => { translateNode(n, d[0], d[1]); arrayApply(n, t, p0); });
    });
    out.ids = roots.map((it: KItem) => it.id);
    return out;
  }
  const posOf = new Map(roots.map((it: KItem) => [it.id, anchorOf(it)] as [string, Pt]));
  for (let k = 1; k < N; k++) {
    const r = duplicateChanges(doc, roots.map((it: KItem) => it.id), null, { annotations: o.keepRefs ? "keep" : "unique",
      xform: (n, root) => { const pos = posOf.get(root.id)!; arrayApply(n, arrayTransform(o, k, pos), pos); } });
    out.changes.push(...r.changes); out.ids.push(...r.ids);
  }
  for (const it of roots) { const pos = posOf.get(it.id)!, t = arrayTransform(o, 0, pos); if (t.offset[0] || t.offset[1] || t.rot) moveRoot(it, (n: SNode) => arrayApply(n, t, pos)); }
  out.ids.push(...roots.map((it: KItem) => it.id));
  return out;
}
