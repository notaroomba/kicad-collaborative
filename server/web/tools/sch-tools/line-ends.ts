import type { SchCtx, Pt } from "./types";
import { connPoints } from "./drag";
import { danglingList } from "./dangling";
import { mmPerPx } from "./snap";
import { LINE_KINDS, S, atOf, kids, ptsOf } from "./state";
import { same, segDist, segs } from "./util";

// ---------------------------------------------------------------- partly selected lines (STARTPOINT / ENDPOINT)
// SCH_SELECTION_TOOL::selectPoint sets STARTPOINT on a SCH_LINE clicked within the collector threshold of its start,
// ENDPOINT near its end, and both anywhere else; SelectMultiple in contained (left-to-right) mode takes a line whose
// ends are not both in the box by its dangling ends that are.  SCH_MOVE_TOOL then moves only the flagged end, and
// SCH_PAINTER draws the unflagged end's small square on the shadow pass.  S.selEnds holds, for a line selected by
// one end only, the index of that end (0 start, 1 end); a line selected whole has no entry.

/** SCH_SELECTION_TOOL::CollectHits' threshold: max( 5 px, the grid size's Euclidean norm / 2 ). */
export function selectThreshold(ctx: SchCtx): number {
  const g = ctx.gridPitch || 1.27;
  return Math.max(5 * mmPerPx(ctx), Math.hypot(g, g) / 2);
}
/** A two-point SCH_LINE (wire, bus, graphic line): selectPoint's flags for a click at mm, 0 / 1 for one end, null for both. */
export function lineEndAt(it: KItem, mm: Pt, threshold: number): 0 | 1 | null {
  if (!LINE_KINDS.has(it.kind)) return null;
  const p = ptsOf(it.node); if (p.length !== 2) return null;
  if (Math.hypot(p[0][0] - mm[0], p[0][1] - mm[1]) <= threshold) return 0;
  if (Math.hypot(p[1][0] - mm[0], p[1][1] - mm[1]) <= threshold) return 1;
  return null;
}
/** Record which end of the module's own pick (S.sel) the click selected; any other selection clears it. */
export function setSelEnd(id: string | null, end: 0 | 1 | null) {
  S.selEnds = id && end !== null ? new Map([[id, end]]) : null;
}
/** Add (Shift / box) or clear one line's partial-end entry. */
export function putSelEnd(id: string, end: 0 | 1 | null) {
  if (end === null) { if (S.selEnds) S.selEnds.delete(id); return; }
  (S.selEnds || (S.selEnds = new Map())).set(id, end);
}
/** The selected end of a line selected by one end only, or null (the whole line, or not partly selected). */
export function selEndOf(id: string): 0 | 1 | null {
  const e = S.selEnds ? S.selEnds.get(id) : undefined; return e === 0 || e === 1 ? e : null;
}
/** Selection keys for the painter: "id#end:N" names the one selected end of each partly selected line in `selected`. */
export function selEndKeys(selected: Iterable<string>): string[] {
  const out: string[] = []; if (!S.selEnds || !S.selEnds.size) return out;
  for (const id of selected) { const e = selEndOf(id); if (e !== null) out.push(id + "#end:" + e); }
  return out;
}

/**
 * SCH_LINE::IsStartDangling / IsEndDangling (UpdateDanglingState): a wire end with no other wire end, pin, label,
 * sheet pin, junction, no-connect or wire-side bus-entry end on it; a bus end with no other bus end, bus-side entry
 * end, label or sheet pin; a graphic line is never dangling.
 */
export function lineEndDangling(doc: KDoc, it: KItem, end: 0 | 1): boolean {
  const pts = ptsOf(it.node); if (pts.length < 2) return false;
  const p = end ? pts[pts.length - 1] : pts[0];
  if (it.kind === "wire") return danglingList(doc).some((d) => d.what === "wire" && d.item === it && same(d.p, p));
  if (it.kind !== "bus") return false;
  for (const o of doc.items.values()) {
    if (o === it) continue;
    if (o.kind === "bus") { const q = ptsOf(o.node); if (q.length > 1 && (same(q[0], p) || same(q[q.length - 1], p))) return false; if (segs(o).some(([a, b]) => segDist(p, a, b) <= 1e-3)) return false; }
    else if (o.kind === "bus_entry") { if (same(connPoints(doc, o)[0], p)) return false; }
    else if (o.kind === "label" || o.kind === "global_label" || o.kind === "hierarchical_label") { if (same(atOf(o.node), p)) return false; }
    else if (o.kind === "sheet") { if (kids(o.node, "pin").some((pin) => same(atOf(pin), p))) return false; }
  }
  return true;
}
/**
 * SelectMultiple's SCH_LINE flags for a box [x0, y0, x1, y1]: "whole" when the box takes the whole line (touch mode
 * and the line crosses it, or both ends inside), the one end (0 / 1) contained mode takes because it is inside and
 * dangling, or null.  Both dangling ends inside is the whole line.  undefined for anything but a two-point SCH_LINE.
 */
export function boxLineFlags(doc: KDoc, it: KItem, box: [number, number, number, number], contained: boolean): "whole" | 0 | 1 | null | undefined {
  if (!LINE_KINDS.has(it.kind)) return undefined;
  const pts = ptsOf(it.node); if (pts.length !== 2) return undefined;
  const [x0, y0, x1, y1] = box, inBox = (q: Pt) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
  const a = inBox(pts[0]), b = inBox(pts[1]);
  if (a && b) return "whole";
  if (!contained) return segHitsBox(pts[0], pts[1], box) ? "whole" : null;
  const s = a && lineEndDangling(doc, it, 0), e = b && lineEndDangling(doc, it, 1);
  return s && e ? "whole" : s ? 0 : e ? 1 : null;
}
/** Does segment a-b touch the box (SCH_LINE::HitTest( BOX2I, false ))? */
export function segHitsBox(a: Pt, b: Pt, box: [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = box;
  // Liang-Barsky clip
  let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p: number, q: number) => { if (p === 0) return q >= 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
  return clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dy, a[1] - y0) && clip(dy, y1 - a[1]);
}
