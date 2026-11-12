// pcb-tools/drag-optimize.ts — the dragged line's optimizer (DRAGGER::optimizeAndUpdateDraggedLine) and the drag's changes.
import type { Box, DragSolution, DragSub, ObstacleIndex, PcbChange, PcbCtx, Pt } from "./types";
import { branchChanges, branchDoc } from "./branch";
import { addedChange, removedChange, replacedChange } from "./changes";
import { settingsOf } from "./dialogs";
import { viaLayers } from "./distances";
import { PEPS, dragObstacles, dragSolution, initialTrace, peq, rp, solutionHits, trackEnds, walkSolution } from "./dragger";
import { viaNow } from "./edit-commands";
import { distSeg } from "./hit";
import { segmentNode } from "./nodes";
import { RM_MARK, RM_SHOVE } from "./router-settings";
import { shoveOps, shovePreview, shoveRun, shoveWorld } from "./shove";
import { cornerCost } from "./smartpads";
import { K, S } from "./state";
import { clone, r6 } from "./util";
import { dir8, pathClear, pathHits, routeObstacles, simplifyPts } from "./walkaround";

// ---- OPTIMIZER as DRAGGER::optimizeAndUpdateDraggedLine runs it: MERGE_SEGMENTS | MERGE_COLINEAR (smooth_dragged_segments),
// the vertex under the cursor preserved, the changes kept inside the area the drag changed (optimize_entire_dragged_track off)
export const CORNER_COST = [5, 10, 30, 50, 60];   // COST_ESTIMATOR::CornerCost by DIRECTION_45::Angle: straight, obtuse, right, acute, half full
// (a first cornerCost() stood here; the later declaration of the same name hoisted over it, so it never ran)
export const segPtDist = (a: Pt, b: Pt, p: Pt) => distSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
/** LINE::ChangedArea: the box around the part of `pts` that differs from `orig`, grown by the width (null when nothing changed). */
export function changedArea(pts: Pt[], orig: Pt[], w: number): Box | null {
  const self = simplifyPts(pts), other = simplifyPts(orig); const ns = self.length, no = other.length, n = Math.min(ns, no);
  let iStart = -1, iEndS = -1, iEndO = -1;
  for (let i = 0; i < n; i++) if (!peq(self[i], other[i])) { if (i !== n - 1) { if (segPtDist(self[i], self[i + 1], other[i]) > PEPS) { iStart = i; break; } } else { iStart = i; break; } }
  for (let i = 0; i < n; i++) if (!peq(self[ns - 1 - i], other[no - 1 - i])) { iEndS = ns - 1 - i; iEndO = no - 1 - i; break; }
  if (iStart < 0) iStart = n; if (iEndS < 0) iEndS = ns - 1; if (iEndO < 0) iEndO = no - 1;
  let box: Box | null = null; const ext = (p: Pt) => { box = box ? [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
  for (let i = iStart; i <= iEndS; i++) ext(self[i]); for (let i = iStart; i <= iEndO; i++) ext(other[i]);
  const bb = box as Box | null;   // set inside ext()
  return bb ? [bb[0] - w, bb[1] - w, bb[2] + w, bb[3] + w] : null;
}
export const inBox = (b: Box, p: Pt) => p[0] >= b[0] - PEPS && p[0] <= b[2] + PEPS && p[1] >= b[1] - PEPS && p[1] <= b[3] + PEPS;
/** OPTIMIZER::mergeStep's constraints: PRESERVE_VERTEX_CONSTRAINT and AREA_CONSTRAINT (strict) for replacing vertices v1..v2. */
export function mergeAllowed(path: Pt[], v1: number, v2: number, bypass: Pt[], anchor: Pt, area: Box) {
  let covers = false; for (let i = v1; i < v2; i++) if (segPtDist(path[i], path[i + 1], anchor) <= 1e-6) { covers = true; break; }
  if (covers) { let keeps = false; for (let i = 0; i + 1 < bypass.length; i++) if (segPtDist(bypass[i], bypass[i + 1], anchor) <= 1e-6) { keeps = true; break; } if (!keeps) return false; }
  const p1 = path[v1], p2 = path[v2], in1 = inBox(area, p1), in2 = inBox(area, p2);
  if (in1 && in2) return true;
  const horiz = (a0: Pt, a1: Pt, b0: Pt, b1: Pt) => { const d1 = dir8(a0, a1), d2 = dir8(b0, b1); return d1 >= 0 && d1 === d2; };   // SEG::Angle(...).IsHorizontal(): the bypass carries on the kept segment
  if (v1 < path.length - 1 && !in1 && in2 && inBox(area, path[v1 + 1])) return horiz(bypass[0], bypass[1], path[v1], path[v1 + 1]);
  if (in1 && !in2 && inBox(area, path[v2 - 1])) return horiz(bypass[bypass.length - 2], bypass[bypass.length - 1], path[v2 - 1], path[v2]);
  return false;
}
/**
 * DRAGGER::optimizeAndUpdateDraggedLine: OPTIMIZER::mergeFull (each run of segments replaced by the cheaper of the two 45°
 * two-segment bypasses when it is clear and the corner cost drops) then mergeColinear, the cursor's vertex kept, the
 * changes kept to the area the drag touched.
 */
export function optimizeDragged(O: ObstacleIndex, pts: Pt[], orig: Pt[], p: Pt, w: number) {
  if (pts.length < 3) return pts;
  // bestAnchorForPoint: the cursor's vertex, or the nearest point of the line, split in there
  let anchor: Pt | null = null, at = -1, bd = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; const q = rp([a[0] + k * dx, a[1] + k * dy]); const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; anchor = q; at = i; } }
  let path = pts.map((q: Pt) => q.slice()); if (!path.some((q: Pt) => peq(q, anchor!))) path.splice(at + 1, 0, anchor!);
  const area = changedArea(pts, orig, w) || [p[0], p[1], p[0], p[1]];
  const r = w / 2; path = simplifyPts(path); let step = path.length - 2;
  for (let guard = 0; guard < 200; guard++) {
    const nSegs = path.length - 1; if (step > nSegs - 2) step = nSegs - 2; if (step < 1) break;
    const costOrig = cornerCost(path); let picked: Pt[] | null = null;
    for (let n = 0; n < nSegs - step && !picked; n++) {
      const a = path[n], b = path[n + step + 1]; const cands: (Pt[] | null)[] = [null, null], cost = [Infinity, Infinity];
      for (let i = 0; i < 2; i++) {
        const bypass = initialTrace(a, b, -1, i === 1); if (bypass.length < 2) continue;
        if (!pathClear(O, bypass, r) || !mergeAllowed(path, n, n + step + 1, bypass, anchor!, area)) continue;
        cands[i] = simplifyPts(path.slice(0, n).concat(bypass, path.slice(n + step + 2))); cost[i] = cornerCost(cands[i]!);
      }
      if (cost[0] < costOrig && cost[0] < cost[1]) picked = cands[0]; else if (cost[1] < costOrig) picked = cands[1];
    }
    if (picked) path = picked; else step--;
    if (!step) break;
  }
  return simplifyPts(path);   // mergeColinear
}
/**
 * DRAGGER::dragShove's SHOVE run: each dragged line is a head (the via a proxy that carries its fanout), the dragged
 * items themselves left out of the world.  { ops, preview } or null when the shove cannot make room.
 */
export function dragShove(ctx: PcbCtx, d: DragSub, sol: DragSolution) {
  const doc = ctx.doc, s = settingsOf(ctx); const heads = [];
  for (const { l, pts } of sol.lines) {
    if (pts.length < 2) continue;
    // a dragged line still meets the solids it would cross: SHOVE never moves those
    if (pathHits(dragSolidObs(ctx, d, l.layer), pts, l.width / 2).length) return null;
    heads.push({ pts, w: l.width, layer: l.layer, net: l.netKey, ownIds: d.ids });
  }
  if (sol.viaAt && d.via) {
    const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const r = viaNow(d.via.node).size / 2; const layers = new Set(viaLayers(d.via.node, copper));
    for (const L of layers) if (pathHits(dragSolidObs(ctx, d, L), [sol.viaAt], r).length) return null;
    heads.push({ pts: [sol.viaAt.slice()], w: 0, layer: Array.from(layers)[0], net: d.netKey, ownIds: d.ids, viaId: d.via.id, via: { at: sol.viaAt.slice(), r, layers } });
  }
  if (!heads.length) return { ops: [], preview: { hidden: new Set<string>(), lines: [], vias: [] } };
  const SW = shoveWorld(doc, s, S.rs.shove_vias); const st = shoveRun(SW, heads, S.rs); if (!st) return null;
  return { ops: shoveOps(doc, st), preview: shovePreview(doc, st) };
}
/** The drag's obstacles that a shove cannot move (pads, holes, rule areas, the edge, locked items). */
export function dragSolidObs(ctx: PcbCtx, d: DragSub, layer: string) {
  const key = "s|" + layer + "|" + S.rs.shove_vias; let O = d.obs.get(key); if (O) return O;
  const s = settingsOf(ctx); const SW = shoveWorld(ctx.doc, s, S.rs.shove_vias); const skip = new Set([...SW.tracks.keys(), ...SW.vias.keys(), ...(d.excl || [])]);
  O = routeObstacles(ctx.doc, s, d.netKey, layer, d.netKey ? null : d.ids, skip); d.obs.set(key, O); return O;
}
/**
 * DRAGGER::Drag: free angle (and a drag that started in violation) marks obstacles - the step is taken, its status is
 * whether it is clear; walk around takes a step only when it is clear (walking around what it crosses), otherwise the
 * last valid solution stays.  A first step that cannot be made switches to forced mark-obstacles mode.
 */
export function dragTo(ctx: PcbCtx, d: DragSub, p: Pt) {
  d.cursor = p.slice(); const first = d.first; d.first = false;
  const raw = dragSolution(d, p); const mode = S.rs.mode;
  if (d.free || d.forceMark) { d.sol = raw; d.shove = null; d.hits = solutionHits(ctx, d, raw); d.status = !d.hits.length; d.lastValid = p.slice(); return true; }
  // DRAGGER::dragMarkObstacles: the step is always taken; it may be fixed when clear or when DRC violations are allowed
  if (mode === RM_MARK) { d.sol = raw; d.shove = null; d.hits = solutionHits(ctx, d, raw); d.status = !!S.rs.can_violate_drc || !d.hits.length; d.lastValid = p.slice(); return true; }
  // DRAGGER::dragShove: the dragged lines (and the via) push what they meet; a step the shove cannot make keeps the last one
  if (mode === RM_SHOVE) {
    const sh = dragShove(ctx, d, raw);
    if (sh) { d.sol = raw; d.shove = sh; d.hits = []; d.status = true; d.lastValid = p.slice(); return true; }
    if (first) { d.forceMark = true; d.sol = raw; d.shove = null; d.hits = solutionHits(ctx, d, raw); d.status = !d.hits.length; d.lastValid = p.slice(); return true; }
    d.status = true; d.hits = []; return false;
  }
  const viaClear = !raw.viaAt || !solutionHits(ctx, d, { lines: [], viaAt: raw.viaAt }).length;
  let walked = viaClear ? walkSolution(ctx, d, raw) : null;
  if (walked && (d.mode !== "via" || walked !== raw)) walked = Object.assign({}, walked, { lines: walked.lines.map(({ l, pts }, i: number) => (d.mode === "via" && pts === raw.lines[i].pts) ? { l, pts } : { l, pts: optimizeDragged(dragObstacles(ctx, d, l.layer), pts, l.pts, p, l.width) }) });
  if (walked) { d.sol = walked; d.hits = []; d.status = true; d.lastValid = p.slice(); return true; }
  if (first) { d.forceMark = true; d.sol = raw; d.hits = solutionHits(ctx, d, raw); d.status = !d.hits.length; d.lastValid = p.slice(); return true; }
  d.status = true; d.hits = []; return false;   // the previous solution stays
}
/** ROUTER::CommitRouting for a drag: the old line's segments out, the new line's in (an unchanged segment is kept), the via moved. */
export function dragChanges(ctx: PcbCtx, d: Pick<DragSub, "sol"> & Partial<DragSub>) {
  const doc = ctx.doc; const changes: PcbChange[] = [];
  for (const { l, pts } of d.sol!.lines) {
    const olds = l.ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; const kept = new Set<string>();
    const fresh: Pt[][] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]; if (peq(a, b)) continue;
      const same = olds.find((o) => !kept.has(o.id) && (() => { const [p, q] = trackEnds(o); return (peq(p, a) && peq(q, b)) || (peq(p, b) && peq(q, a)); })());
      if (same) kept.add(same.id); else fresh.push([a, b]);
    }
    for (const o of olds) if (!kept.has(o.id)) changes.push(removedChange(o));
    // a new segment carries the dragged segment's own attributes (its lock state; a fresh uuid) — the grabbed segment
    // when it is on this line, otherwise the line's own segments (all alike: a locked one ends a line); an arc's new
    // stub is a plain track of the arc's width, layer and net
    const own = olds.find((o) => o.id === d.id) || olds[0];
    for (const [a, b] of fresh) {
      const tmpl = own ? clone(own.node) : segmentNode(doc, a, b, l.width, l.layer, l.net);
      const u = K.kid(tmpl, "uuid"); if (u) tmpl.splice(tmpl.indexOf(u), 1);
      K.kid(tmpl, "start")!.splice(1, 2, r6(a[0]), r6(a[1])); K.kid(tmpl, "end")!.splice(1, 2, r6(b[0]), r6(b[1]));
      changes.push(addedChange(doc, tmpl, l.net));
    }
  }
  if (d.sol!.viaAt && d.via && !peq(d.sol!.viaAt, d.viaAt!)) { const node = clone(d.via.node); K.kid(node, "at")!.splice(1, 2, r6(d.sol!.viaAt[0]), r6(d.sol!.viaAt[1])); changes.push(replacedChange(d.via, node)); }
  if (d.shove && d.shove.ops.length) changes.push(...branchChanges(doc, branchDoc(doc, d.shove.ops)));   // what the drag pushed aside
  return changes;
}
export const solutionChanged = (d: DragSub) => d.sol && (d.sol.lines.some(({ l, pts }) => pts.length !== l.pts.length || pts.some((p: Pt, i: number) => !peq(p, l.pts[i]))) || (d.sol.viaAt && !peq(d.sol.viaAt, d.viaAt!)));
/** DRAGGER::FixRoute: commit when valid; in forced mark-obstacles mode only with Ctrl; otherwise from the last valid point. */
export function dragFix(ctx: PcbCtx, d: DragSub, force: boolean) {
  if (!d.status) {
    if (d.forceMark) { if (!force) return false; }
    else { dragTo(ctx, d, d.lastValid); if (!d.status) return false; }
  }
  if (!solutionChanged(d)) return false;
  const changes = dragChanges(ctx, d); if (!changes.length) return false;
  ctx.commit(changes, "drag track"); return true;
}
