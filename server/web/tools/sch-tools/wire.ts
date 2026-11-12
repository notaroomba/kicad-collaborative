import type { SchCtx, SchWire, Pt } from "./types";
import { junctionAt, lineEndsAt, lineMidsAt, pinsAt } from "./connect";
import { busEntriesAt, labelsAt, sheetPinsAt } from "./drag";
import { finishWire, unfoldFollow } from "./junction";
import { lineNode } from "./nodes";
import { S, atOf, kid, kids, ptsOf } from "./state";
import { deep, r4, replaceKid, same, segDist, segs } from "./util";

// ---------------------------------------------------------------- wires and buses (eeschema/tools/sch_line_wire_bus_tool.cpp)
// KiCad's model: m_wires is a list of segments [start, end]; the last one (and in 90° / 45° mode the one
// before it) are live and follow the cursor through computeBreakPoint.  A click fixes the first live
// segment in 90° mode (the second becomes the first of the next pair, so it keeps stretching along its
// axis) and both in 45° mode.  `kind` is "wire", "bus" or "polyline" (drawLines, LAYER_NOTES).
S.posture = false;                         // doDrawSegments' static posture flag: kept across invocations
/** A segment [start, end]. */
export type Seg = Pt[];
export const segNull = (s: Seg) => same(s[0], s[1]);
export const twoSegments = () => S.lineMode !== "free";
// The sheet pin at p, with the side of the sheet it sits on (SCH_SCREEN::GetSheetPin).
export function sheetPinSideAt(doc: KDoc, p: Pt) {
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    for (const pin of kids(it.node, "pin")) {
      const [x, y, rot] = atOf(pin); if (!same([x, y], p)) continue;
      const r = ((Math.round(rot || 0) % 360) + 360) % 360;
      return { x, y, side: r === 0 ? "right" : r === 90 ? "top" : r === 180 ? "left" : "bottom", item: it };
    }
  }
  return null;
}
/**
 * computeBreakPoint: bend `seg` / `next` so that the pair runs from seg's start to `pos`.  The first segment
 * keeps its current orientation when it can (preferVertical / preferHorizontal), a sheet-pin start forces a
 * horizontal first leg and pushes a cursor on the pin's x one grid outside the sheet.  Returns the end point.
 */
export function computeBreakPoint(doc: KDoc | null, seg: Seg, next: Seg, pos: Pt, mode: string, posture: boolean, grid: number) {
  pos = [pos[0], pos[1]];
  const start = seg[0], delta = [pos[0] - start[0], pos[1] - start[1]];
  const xDir = delta[0] > 0 ? 1 : -1, yDir = delta[1] > 0 ? 1 : -1;
  const nz = (v: number) => Math.abs(v) > 1e-9;
  let preferH: boolean, preferV: boolean;
  if (mode === "45" && posture) { preferH = nz(next[1][0] - next[0][0]); preferV = nz(next[1][1] - next[0][1]); }
  else { preferH = nz(seg[1][0] - seg[0][0]); preferV = nz(seg[1][1] - seg[0][1]); }
  const pin = doc ? sheetPinSideAt(doc, start) : null;
  if (pin && (pin.side === "left" || pin.side === "right")) {
    if (Math.abs(pos[0] - pin.x) < 1e-6) pos[0] = r4(pos[0] + (grid || 1.27) * (pin.side === "left" ? -1 : 1));   // push outside the sheet
    preferH = true; preferV = false;
  }
  let mid: Pt = [0, 0];
  const breakVertical = () => {
    if (mode === "45") mid = !posture ? [start[0], pos[1] - yDir * Math.abs(delta[0])] : [pos[0], start[1] + yDir * Math.abs(delta[0])];
    else mid = [start[0], pos[1]];
  };
  const breakHorizontal = () => {
    if (mode === "45") mid = !posture ? [pos[0] - xDir * Math.abs(delta[1]), start[1]] : [start[0] + xDir * Math.abs(delta[1]), pos[1]];
    else mid = [pos[0], start[1]];
  };
  if (preferV) breakVertical(); else if (preferH) breakHorizontal();
  const dm = [mid[0] - start[0], mid[1] - start[1]], sb = (v: number) => v < 0;
  if (mode === "45" && !posture && (sb(dm[0]) !== sb(delta[0]) || sb(dm[1]) !== sb(delta[1]))) { preferV = false; preferH = false; }
  else if (mode === "45" && posture && (Math.abs(dm[0]) > Math.abs(delta[0]) + 1e-9 || Math.abs(dm[1]) > Math.abs(delta[1]) + 1e-9)) { preferV = false; preferH = false; }
  if (!preferH && !preferV) { if (Math.abs(delta[0]) < Math.abs(delta[1])) breakVertical(); else breakHorizontal(); }
  mid = [r4(mid[0]), r4(mid[1])];
  seg[1] = mid; next[0] = mid.slice(); next[1] = pos.slice();
  return pos;
}
// The live segments follow the cursor (doDrawSegments' motion handler).
export function wireFollow(ctx: SchCtx, p: Pt) {
  const w = S.wire; if (!w) return;
  if (S.unfold && !S.unfold.placed) unfoldFollow(ctx, w, p);
  const n = w.segs.length, seg = w.segs[n - 1];
  if (twoSegments() && n >= 2) computeBreakPoint(ctx.doc, w.segs[n - 2], seg, p, S.lineMode, S.posture, ctx.gridPitch);
  else seg[1] = p.slice();
  w.cur = p.slice();
}
/** The drawn polyline: the points of every non-null segment, in order. */
export function wirePoints(w: SchWire) {
  const out: Pt[] = [];
  for (const s of w.segs) { if (segNull(s)) continue; if (!out.length || !same(out[out.length - 1], s[0])) out.push(s[0].slice()); out.push(s[1].slice()); }
  return out;
}
// startSegments: one segment at the point, two in 90° / 45° mode.  `opts.quitOnDraw` returns to the
// select tool once the wire is finished (a wire auto-started from a pin by the selection tool).
export function startWire(ctx: SchCtx, kind: string, p: Pt, opts?: { quitOnDraw?: boolean; source?: KItem | null }) {
  const segs: Seg[] = [[p.slice(), p.slice()]]; if (twoSegments()) segs.push([p.slice(), p.slice()]);
  const src = (opts && opts.source) || sourceLine(ctx.doc, kind, p), st = src && kid(src.node, "stroke");
  S.wire = { kind, segs, cur: p.slice(), quitOnDraw: !!(opts && opts.quitOnDraw), stroke: st ? deep(st) : null };
  ctx.requestRender();
}
// startSegments' SCH_SCREEN::GetLine( aPos, 0, aType ): the line of the same layer under the start point, whose
// Duplicate() the new segments are, so they inherit its stroke (width, style, colour).  A graphic line is a
// two-point polyline in the file.
export function sourceLine(doc: KDoc, kind: string, p: Pt) {
  for (const it of doc.items.values()) {
    if (it.kind !== kind) continue;
    const q = ptsOf(it.node); if (kind === "polyline" && q.length !== 2) continue;
    if (segs(it).some(([a, b]) => segDist(p, a, b) <= 1e-3)) return it;
  }
  return null;
}
// The drawn line's node: a fresh segment with the source line's stroke when there is one.
export function wireNode(w: Pick<SchWire, "kind" | "stroke">, a: Pt, b: Pt) {
  const n = lineNode(w.kind, a, b);
  if (w.stroke) replaceKid(n, deep(w.stroke));
  return n;
}
// SCH_SCREEN::IsTerminalPoint: where a click ends the wire by itself.
export function isTerminalPoint(doc: KDoc, p: Pt, kind: string) {
  if (kind === "polyline") { for (const it of doc.items.values()) if (it.kind === "polyline" && segs(it).some(([a, b]) => segDist(p, a, b) <= 1e-3)) return true; return false; }
  const lineAt = (k: string) => lineEndsAt(doc, p[0], p[1], k).length > 0 || lineMidsAt(doc, p[0], p[1], k).length > 0;
  if (kind === "bus") return lineAt("bus") || sheetPinsAt(doc, p).length > 0 || labelsAt(doc, p).some((l) => l.kind !== "netclass_flag" && l.kind !== "directive_label");
  if (busEntriesAt(doc, p).length || junctionAt(doc, p[0], p[1]) || pinsAt(doc, p[0], p[1]).length || lineAt("wire")) return true;
  return labelsAt(doc, p).length > 0 || sheetPinsAt(doc, p).length > 0;
}
export function wireClick(ctx: SchCtx, p: Pt, dbl: boolean) {
  const w = S.wire; if (!w) return;
  wireFollow(ctx, p);
  if (S.unfold && !S.unfold.placed) S.unfold.placed = true;        // the first click of an unfold places the label
  const n = w.segs.length, seg = w.segs[n - 1];
  if (!segNull(seg) || (twoSegments() && n >= 2 && !segNull(w.segs[n - 2]))) {
    if (isTerminalPoint(ctx.doc, p, w.kind)) { finishWire(ctx); return; }   // KiCad ends a wire on a pin, junction, label or line
    const placed = S.lineMode === "45" ? 2 : 1;                    // 45°: the angled end is what the user aims, both legs are placed
    seg[1] = p.slice();
    for (let i = 0; i < placed; i++) w.segs.push([p.slice(), p.slice()]);
  }
  if (dbl && S.wire) finishWire(ctx);
  else ctx.requestRender();
}
// SCH_ACTIONS::undoLastSegment / ACTIONS::doDelete / ACTIONS::undo while drawing: the last segment goes, the
// cursor goes to the new end and the bend is recomputed.  False when there is nothing left to take back
// (Ctrl+Z then falls through to the document's undo; Delete / Backspace just beep).
export function undoSegment(ctx: SchCtx) {
  const w = S.wire; if (!w) return false;
  const n = w.segs.length;
  if (!((S.lineMode === "free" && n > 1) || n > 2)) return false;
  w.segs.pop();
  const seg = w.segs[w.segs.length - 1], p = seg[1].slice();
  S.cursor = p.slice(); if (typeof ctx.warpCursor === "function") ctx.warpCursor(p);
  if (twoSegments() && w.segs.length >= 2) computeBreakPoint(ctx.doc, w.segs[w.segs.length - 2], seg, p, S.lineMode, S.posture, ctx.gridPitch);
  else seg[1] = p;
  w.cur = p; ctx.requestRender();
  return true;
}
// switchSegmentPosture ('/'), only with two or more segments: 90° swaps the two live legs, 45° flips the posture.
export function switchPosture(ctx: SchCtx) {
  const w = S.wire; if (!w || w.segs.length < 2) return false;
  S.posture = !S.posture;
  const n = w.segs.length, l2 = w.segs[n - 1], l1 = w.segs[n - 2];
  if (S.lineMode === "90") {
    const d2 = [l2[1][0] - l2[0][0], l2[1][1] - l2[0][1]], d1 = [l1[1][0] - l1[0][0], l1[1][1] - l1[0][1]];
    l2[0] = [r4(l2[1][0] - d1[0]), r4(l2[1][1] - d1[1])]; l1[1] = [r4(l1[0][0] + d2[0]), r4(l1[0][1] + d2[1])];
  } else computeBreakPoint(ctx.doc, l1, l2, w.cur || l2[1], S.lineMode, S.posture, ctx.gridPitch);
  ctx.requestRender(); return true;
}
// A line-mode change while drawing adds or drops the extra live segment.
export function wireModeChanged(ctx: SchCtx, from: string, to: string) {
  const w = S.wire; if (!w || from === to) return;
  const cur = (w.cur || w.segs[w.segs.length - 1][1]).slice();
  if (to === "free" && w.segs.length >= 2) { w.segs.pop(); w.segs[w.segs.length - 1][1] = cur; }
  else if (from === "free") { w.segs[w.segs.length - 1][1] = cur; w.segs.push([cur.slice(), cur.slice()]); }
  wireFollow(ctx, cur);
}
// simplifyWireList: null segments go, consecutive overlapping ones (a backtrack) merge.
export function simplifyWireList(segs: Seg[]) {
  const out: Seg[] = [];
  for (const s of segs) {
    if (segNull(s)) continue;
    const prev = out[out.length - 1], m = prev ? mergeOverlap(prev, s, null) : null;
    if (m) out[out.length - 1] = m; else out.push([s[0].slice(), s[1].slice()]);
  }
  return out;
}
// The legacy point-list form of simplifyWireList (graphic shapes still use it): drops repeats and
// collinear points that keep going the same way.
export function simplify(pts: Pt[]) {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  for (let i = 1; i < out.length - 1;) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-6 && dot > 0) out.splice(i, 1); else i++;
  }
  return out;
}
// SCH_LINE::MergeOverlap for two segments [a, b]: their union when collinear and overlapping or touching
// (touching ones only when `isJunctionAt(point)` says no junction is there), else null.
export function mergeOverlap(A: Seg, B: Seg, isJunctionAt: ((p: Pt) => unknown) | null): Seg | null {
  const less = (p: Pt, q: Pt) => (Math.abs(p[0] - q[0]) <= 1e-6 ? p[1] < q[1] - 1e-6 : p[0] < q[0]);
  const ord = (s: Seg) => (less(s[1], s[0]) ? [s[1], s[0]] : [s[0], s[1]]);
  let [ls, le] = ord(B), [rs, re] = ord(A);
  if (less(rs, ls)) { [ls, rs] = [rs, ls]; [le, re] = [re, le]; }
  const os = rs, oe = re;
  if (less(re, le)) { rs = ls; re = le; }
  if (less(le, os)) return null;                                   // one ends before the other begins
  if (same(ls, os) && same(le, oe)) return [ls.slice(), le.slice()];
  let colinear: boolean;
  if (Math.abs(ls[1] - le[1]) <= 1e-6 && Math.abs(os[1] - oe[1]) <= 1e-6) colinear = Math.abs(ls[1] - os[1]) <= 1e-6;
  else if (Math.abs(ls[0] - le[0]) <= 1e-6 && Math.abs(os[0] - oe[0]) <= 1e-6) colinear = Math.abs(ls[0] - os[0]) <= 1e-6;
  else {
    const dx = le[0] - ls[0], dy = le[1] - ls[1];
    colinear = Math.abs((os[1] - ls[1]) * dx - (os[0] - ls[0]) * dy) <= 1e-6 && Math.abs((oe[1] - ls[1]) * dx - (oe[0] - ls[0]) * dy) <= 1e-6;
  }
  if (!colinear) return null;
  if (same(le, rs) && isJunctionAt && isJunctionAt(le)) return null;   // touching at a junction: kept apart
  return [ls.slice(), re.slice()];
}
