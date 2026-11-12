// pcb-tools/dragger.ts — PNS DRAGGER: the track drag (D, G, a left-drag on a selected track).
import type { BoardDoc, DragSolution, DragSub, Joints, Obstacle, PcbCtx, Pt, TrackLine } from "./types";
import { ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { padCopperLayers, viaLayers } from "./distances";
import { viaNow } from "./edit-commands";
import { isLocked } from "./groups";
import { netTable } from "./netlist";
import { netOf } from "./nets";
import { padsOf } from "./route-geom";
import { K, S } from "./state";
import { layerOf, pt, r6, samePt, widthOf } from "./util";
import { DIRS8, dir8, dirAngle, isDiagDir, now, pathClear, pathHits, ptsLength, routeObstacles, segHit, simplifyPts, walkTo } from "./walkaround";

// ---------------------------------------------------------------- PNS DRAGGER: track drag (D, G, a left-drag on a selected track)
// KiCad's interactive drag runs the router: the grabbed segment's whole LINE (the chain of same-net, same-width segments
// between two non-trivial joints - a pad, a via, a T, a width change) is rebuilt by LINE::dragSegment45 (the neighbours
// keep their direction, new 45° knees grow where needed, the ends never leave their pad or via) or LINE::dragCorner45
// (a vertex follows the cursor with straight + 45° legs).  Drag Free Angle (G) moves the nearer vertex at any angle.  A
// via takes the lines that end on it along (DM_VIA).  Every step is checked against other nets' copper at the design
// rules' clearance (walk around, KiCad's default mode); a step that cannot be made keeps the last valid one.
export const PEPS = 5e-7;   // half a nanometre: points this close are one (KiCad works in whole nm)
export const peq = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < PEPS && Math.abs(a[1] - b[1]) < PEPS;
export const rp = (p: Pt): Pt => [r6(p[0]) + 0, r6(p[1]) + 0];
export const d45Right = (d: number) => (d < 0 ? -1 : (d + 1) % 8), d45Left = (d: number) => (d < 0 ? -1 : (d + 7) % 8);
/** SEG::IntersectLines: where the infinite lines through a1-a2 and b1-b2 cross (null when parallel). */
export function lineX(a1: Pt, a2: Pt, b1: Pt, b2: Pt) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den; return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::Intersect: the crossing of two segments, ends included; parallel (and zero-length) segments never cross. */
export function segX(a1: Pt, a2: Pt, b1: Pt, b2: Pt) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den, u = ((b1[0] - a1[0]) * ey - (b1[1] - a1[1]) * ex) / den;
  const e = 1e-9; if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::LineDistance: distance from p to the infinite line through a-b. */
export function lineDist(a: Pt, b: Pt, p: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return L < 1e-12 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L; }
export const chainAppend = (out: Pt[], pts: Pt[]) => { for (const p of pts) if (!out.length || !peq(out[out.length - 1], p)) out.push(p.slice()); return out; };   // SHAPE_LINE_CHAIN::Append
export const chainLen = (pts: Pt[]) => ptsLength(pts);
/** SHAPE_LINE_CHAIN::Simplify on nm-rounded points. */
export const chainSimplify = (pts: Pt[]) => simplifyPts(pts.map(rp));
/**
 * DIRECTION_45::BuildInitialTrace (mitred 45°): from p0 to p1, a straight run and a diagonal; it starts diagonal when
 * the direction `d` is diagonal (or, for an undefined direction, when startDiag says so).
 */
export function initialTrace(p0: Pt, p1: Pt, d: number, startDiag?: boolean) {
  const diag = d >= 0 ? isDiagDir(d) : !!startDiag;
  const w = Math.abs(p1[0] - p0[0]), h = Math.abs(p1[1] - p0[1]), sw = Math.sign(p1[0] - p0[0]), sh = Math.sign(p1[1] - p0[1]);
  if (w < PEPS || h < PEPS || Math.abs(w - h) < PEPS) return chainAppend([], [p0, p1]);
  let mp0, mp1;
  if (w > h) { mp0 = [(w - h) * sw, 0]; mp1 = [h * sw, h * sh]; } else { mp0 = [0, sh * (h - w)]; mp1 = [sw * w, sh * w]; }
  const m = diag ? mp1 : mp0; return chainAppend([], [p0, rp([p0[0] + m[0], p0[1] + m[1]]), p1]);
}
/** dragCornerInternal: rebuild the end of a chain towards p, keeping as much of it as can carry on at 45°. */
export function dragCornerInternal(origin: Pt[], p: Pt) {
  if (origin.length === 1) return initialTrace(origin[0], p, -1, false);
  if (origin.length === 2) return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[1], origin[0])));
  let picked: Pt[] | null = null, i: number;
  for (i = origin.length - 2; i >= 0; i--) {
    const dStart = dir8(origin[i], origin[i + 1]), pStart = origin[i], dPrev = i > 0 ? dir8(origin[i - 1], origin[i]) : -1;
    const path = initialTrace(pStart, p, dStart); if (path.length < 2) continue;
    const d0 = dir8(path[0], path[1]);
    if (d0 === dStart) { picked = path; break; }
    if (dPrev >= 0 && dirAngle(d0, dPrev) === 1) { picked = path; break; }
  }
  if (picked) return chainAppend(origin.slice(0, i + 1).map((q: Pt) => q.slice()), picked);
  return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[origin.length - 2], origin[origin.length - 1])));
}
/** LINE::snapDraggedCorner: a dragged corner within the threshold of where two obtuse neighbours would meet goes there. */
export function snapDraggedCorner(pts: Pt[], p: Pt, idx: number, thresh: number) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, s0 = Math.max(idx - 2, 0), s1 = Math.min(idx + 2, segs - 1); let best = p, bd = Infinity;
  for (let i = s0; i <= s1; i++) for (let j = s0; j < i; j++) {
    if (dirAngle(dir8(pts[i], pts[i + 1]), dir8(pts[j], pts[j + 1])) !== 1) continue;
    const ip = lineX(pts[i], pts[i + 1], pts[j], pts[j + 1]); if (!ip) continue;
    const d = Math.hypot(ip[0] - p[0], ip[1] - p[1]); if (d < thresh && d < bd) { bd = d; best = ip; }
  }
  return best;
}
/** LINE::dragCorner45: vertex idx follows p; both legs are rebuilt with 45° corners (only one at the line's ends). */
export function dragCorner45(pts: Pt[], idx: number, p: Pt, thresh: number) {
  const snapped = snapDraggedCorner(pts, p, idx, thresh); const segs = pts.length - 1; let path: Pt[];
  if (idx === 0) path = dragCornerInternal(pts.slice().reverse(), snapped).reverse();
  else if (idx === segs) path = dragCornerInternal(pts, snapped);
  else path = chainAppend(dragCornerInternal(pts.slice(0, idx + 1), snapped), dragCornerInternal(pts.slice(idx).reverse(), snapped).reverse());
  return chainSimplify(path);
}
/** LINE::dragCornerFree (Drag Free Angle): the vertex goes exactly to p. */
export function dragCornerFree(pts: Pt[], idx: number, p: Pt) { const out = pts.map((q: Pt) => q.slice()); out[idx] = p.slice(); return chainSimplify(out); }
/** LINE::snapToNeighbourSegments: a dragged segment near a parallel segment two away snaps onto its line. */
export function snapToNeighbourSegments(pts: Pt[], p: Pt, idx: number, thresh: number) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, dragDir = dir8(pts[idx], pts[idx + 1]); let best = p, bd = Infinity;
  for (const k of [idx - 2, idx + 2]) {
    if (k < 0 || k > segs - 1 || (k > idx && idx >= segs - 2)) continue;
    const a = pts[k], b = pts[k + 1]; if (dir8(a, b) !== dragDir) continue;
    const d = lineDist(a, b, p); if (d < bd && d <= thresh) { bd = d; best = a.slice(); }
  }
  return best;
}
/**
 * LINE::dragSegment45: segment idx is moved through p keeping its direction; the segments before and after keep theirs
 * (or turn 45° where they ran straight on), a pad or via end stays where it is and a new 45° segment grows from it.
 * Of the guide-line intersections the shortest chain wins.
 */
export function dragSegment45(line: Pt[], aIndex: number, aP: Pt, thresh: number) {
  const path = line.map((q: Pt) => q.slice()); let index = aIndex; const segs0 = line.length - 1;
  const target = snapToNeighbourSegments(path, aP, aIndex, thresh);
  if (index === 0) { path.splice(0, 0, path[0].slice()); index++; }
  if (index === path.length - 2) path.splice(path.length - 1, 0, path[path.length - 1].slice());
  const seg = (i: number) => [path[i], path[i + 1]];
  let dragged = seg(index); const dragDir = dir8(dragged[0], dragged[1]);
  let sPrev = seg(index - 1), sNext = seg(index + 1); let dirPrev = dir8(sPrev[0], sPrev[1]), dirNext = dir8(sNext[0], sNext[1]);
  if (dirPrev === dragDir) { dirPrev = d45Left(dirPrev); path.splice(index, 0, path[index].slice()); index++; }
  else if (dirPrev < 0) dirPrev = d45Left(dragDir);
  if (dirNext === dragDir) { dirNext = d45Right(dirNext); path.splice(index + 1, 0, path[index + 1].slice()); }
  else if (dirNext < 0) dirNext = d45Right(dragDir);
  sPrev = seg(index - 1); sNext = seg(index + 1); dragged = seg(index);
  const guide = (p: Pt, d: number) => [p, [p[0] + DIRS8[d][0], p[1] + DIRS8[d][1]]];
  const wide = (d: number) => { const a = dirAngle(d, dragDir); return a === 1 || a === 4; };   // ANG_OBTUSE | ANG_HALF_FULL
  let gA: Pt[][], gB: Pt[][];
  if (aIndex === 0) gA = [guide(dragged[0], d45Right(dragDir)), guide(dragged[0], d45Left(dragDir))];
  else if (wide(dirPrev)) gA = [guide(sPrev[0], d45Left(dragDir)), guide(sPrev[0], d45Right(dragDir))];
  else gA = [guide(dragged[0], dirPrev), guide(dragged[0], dirPrev)];
  if (aIndex === segs0 - 1) gB = [guide(dragged[1], d45Right(dragDir)), guide(dragged[1], d45Left(dragDir))];
  else if (wide(dirNext)) gB = [guide(sNext[1], d45Left(dragDir)), guide(sNext[1], d45Right(dragDir))];
  else gB = [guide(dragged[1], dirNext), guide(dragged[1], dirNext)];
  const cur = guide(target, dragDir);
  let best: Pt[] | null = null, bestLen = Infinity;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const ip1 = lineX(cur[0], cur[1], gA[i][0], gA[i][1]), ip2 = lineX(cur[0], cur[1], gB[j][0], gB[j][1]); if (!ip1 || !ip2) continue;
    const s1 = [sPrev[0], ip1], s3 = [ip2, sNext[1]]; let np: Pt[], ip: Pt | null;
    if ((ip = segX(s1[0], s1[1], sNext[0], sNext[1]))) np = [s1[0], ip, sNext[1]];
    else if ((ip = segX(s3[0], s3[1], sPrev[0], sPrev[1]))) np = [sPrev[0], ip, s3[1]];
    else if ((ip = segX(s1[0], s1[1], s3[0], s3[1]))) np = [sPrev[0], ip, sNext[1]];
    else np = [sPrev[0], ip1, ip2, sNext[1]];
    np = chainAppend([], np); const L = chainLen(np); if (L < bestLen) { bestLen = L; best = np; }
  }
  if (!best) return chainSimplify(line);
  let out: Pt[];
  if (segs0 === 1 || aIndex === 0) out = best.concat(line.slice(2));
  else if (aIndex === segs0 - 1) out = line.slice(0, line.length - 2).concat(best);
  else out = line.slice(0, aIndex).concat(best, line.slice(aIndex + 2));
  return chainSimplify(out);
}

/** Track endpoints by layer and point, vias and pad centres by point: what NODE::FindJoint looks up. */
export function jointIndex(doc: BoardDoc): Joints {
  if (doc.__bc && doc.__bc.joints) return doc.__bc.joints;
  if (!doc.__bc && S.joints && S.joints.doc === doc && S.joints.ver === S.docVer) return S.joints;
  const NT = netTable(doc); const ends: Joints["ends"] = new Map(), vias: Joints["vias"] = new Map(), pads: Joints["pads"] = new Map(); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const add = <V>(m: Map<string, V[]>, k: string, v: V) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(v); };
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue; const L = layerOf(it.node); add(ends, L + "|" + ptKey(a), it); add(ends, L + "|" + ptKey(b), it); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) add(vias, ptKey(a), { item: it, layers: viaLayers(it.node, copper), net: NT.key(netOf(it.node)) }); }
    else if (it.kind === "footprint") for (const p of padsOf(it)) add(pads, ptKey([p.x, p.y]), { item: it, pad: p, layers: padCopperLayers(p, copper) });
  }
  const J: Joints = { doc, ver: S.docVer, ends, vias, pads, NT };
  if (doc.__bc) doc.__bc.joints = J; else S.joints = J;
  return J;
}
export const trackEnds = (it: KItem) => [pt(it.node, "start"), pt(it.node, "end")] as Pt[];   // a track always has both
/**
 * NODE::AssembleLine: the segment and every segment reached through trivial joints (exactly two same-net segments of
 * one width meeting, no via, no pad centre, no arc, and the next segment not locked).  { ids, pts, index (the seed's segment index), width, layer, net, netKey }.
 */
export function assembleLine(doc: BoardDoc, seg: KItem): TrackLine | null {
  const J = jointIndex(doc); const L = layerOf(seg.node), w = widthOf(seg.node, 0.25), net = netOf(seg.node), key = J.NT.key(net);
  const [A, B] = trackEnds(seg); if (!A || !B) return null;
  const ids = [seg.id], pts = [A.slice(), B.slice()];
  const walk = (from: KItem, p: Pt, atEnd: boolean) => {
    let cur = from, q = p;
    for (let guard = 0; guard < 10000; guard++) {
      const k = ptKey(q);
      if ((J.vias.get(k) || []).some((v) => v.layers.has(L))) return;
      if ((J.pads.get(k) || []).some((x) => x.layers.has(L) && samePt([x.pad.x, x.pad.y], q))) return;
      const links = (J.ends.get(L + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === key);
      if (links.length !== 2) return;
      const o = links[0] === cur ? links[1] : links[0];
      if (o.kind !== "segment" || ids.includes(o.id) || Math.abs(widthOf(o.node, 0.25) - w) > 1e-9) return;
      if (isLocked(o.node)) return;   // JOINT::NextSegment( aAllowLockedSegs = false ): a locked segment ends the line
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) { ids.push(o.id); pts.push(nq.slice()); } else { ids.unshift(o.id); pts.unshift(nq.slice()); }
      cur = o; q = nq;
    }
  };
  walk(seg, B, true); walk(seg, A, false);
  return { ids, pts, index: ids.indexOf(seg.id), width: w, layer: L, net, netKey: key };
}
/** findViaFanoutByHandle: every same-net line ending on the via, on any of its layers. */
export function viaFanout(doc: BoardDoc, via: KItem) {
  const J = jointIndex(doc); const at = pt(via.node, "at"); if (!at) return [];
  const key = J.NT.key(netOf(via.node)); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const layers = viaLayers(via.node, copper);
  const out: TrackLine[] = [], seen = new Set<string>();
  for (const L of layers) for (const o of J.ends.get(L + "|" + ptKey(at)) || []) {
    if ((o.kind !== "segment" && o.kind !== "arc") || seen.has(o.id) || J.NT.key(netOf(o.node)) !== key) continue;
    if (o.kind === "arc") { const ln = arcStubLine(o, at, L, key); seen.add(o.id); if (ln) out.push(ln); continue; }
    const ln = assembleLine(doc, o); if (!ln) continue; ln.ids.forEach((id) => seen.add(id));
    if (peq(ln.pts[ln.pts.length - 1], at) && !peq(ln.pts[0], at)) { ln.pts.reverse(); ln.ids.reverse(); }
    ln.vertex = 0; out.push(ln);
  }
  return out;
}
/**
 * An arc ending on a dragged via (an ARC_T link of the via's joint): the arc keeps its shape and a new line grows from its
 * end to where the via goes, leaving at 45° or straight as the arc's tangent there does (dragCornerInternal on a line
 * whose last piece is the arc).  ids is empty — the arc itself is never replaced.
 */
export function arcStubLine(arc: KItem, at: Pt, layer: string, netKey: string): TrackLine | null {
  const a = pt(arc.node, "start"), m = pt(arc.node, "mid"), b = pt(arc.node, "end"); if (!a || !m || !b) return null;
  const e = samePt(a, at) ? a : b; const c = K.arcFrom3(a, m, b); let diag = false;
  if (c) { let t = [-(e[1] - c.y), e[0] - c.x]; if ((m[0] - e[0]) * t[0] + (m[1] - e[1]) * t[1] > 0) t = [-t[0], -t[1]]; diag = isDiagDir(dir8(e, [e[0] + t[0], e[1] + t[1]])); }
  return { ids: [], pts: [at.slice(), at.slice()], index: 0, vertex: 0, width: widthOf(arc.node, 0.25), layer, net: netOf(arc.node), netKey, arc, arcDiag: diag, tmpl: arc };
}
/** TOOL_BASE::snapToItem: a grab within half the width of a track end takes the end, otherwise the nearest (grid) point on it. */
export function snapGrab(ctx: PcbCtx, it: KItem, mm: Pt) {
  if (it.kind === "via") return pt(it.node, "at")!.slice();
  const [a, b] = trackEnds(it); const w2 = widthOf(it.node, 0.25) / 2;
  const da = Math.hypot(mm[0] - a[0], mm[1] - a[1]), db = Math.hypot(mm[0] - b[0], mm[1] - b[1]);
  if (da < w2 || db < w2) return (da < db ? a : b).slice();
  const g = ctx.snapOn ? ctx.snap(mm.slice()) : mm;   // GRID_HELPER::AlignToSegment: the grid point, put back on the segment
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((g[0] - a[0]) * dx + (g[1] - a[1]) * dy) / l2)) : 0;
  return rp([a[0] + k * dx, a[1] + k * dy]);
}
/**
 * DRAGGER::Start: the drag of one item grabbed at mm.  A segment gives DM_SEGMENT, or DM_CORNER when grabbed within half
 * its width of an end (Free Angle: always DM_CORNER, at the nearer vertex); a via gives DM_VIA.  null when it cannot drag.
 */
export function dragStart(ctx: PcbCtx, it: KItem, mm: Pt, free: boolean) {
  const doc = ctx.doc; if (!it || (it.kind !== "segment" && it.kind !== "via")) return null;
  const p = snapGrab(ctx, it, mm); const d = { id: it.id, free: !!free, start: p.slice(), cursor: p.slice(), forceMark: false, first: true, status: true, sol: null, last: null, lastValid: p.slice(), obs: new Map() } as DragSub;   // mode, lines, netKey and ids follow
  if (it.kind === "via") {
    d.mode = "via"; d.via = it; d.viaAt = pt(it.node, "at")!.slice(); d.lines = viaFanout(doc, it); d.netKey = netTable(doc).key(netOf(it.node));
  } else {
    const ln = assembleLine(doc, it); if (!ln) return null;
    const a = ln.pts[ln.index], b = ln.pts[ln.index + 1], w2 = ln.width / 2;
    const da = Math.hypot(p[0] - a[0], p[1] - a[1]), db = Math.hypot(p[0] - b[0], p[1] - b[1]);
    d.mode = "segment"; ln.vertex = ln.index;
    if (da < w2 || db < w2) { d.mode = "corner"; if (db <= da) ln.vertex++; }
    else if (d.free) { if (db < da && ln.index < ln.pts.length - 2) ln.vertex++; d.mode = "corner"; }
    d.lines = [ln]; d.netKey = ln.netKey;
  }
  d.ids = new Set(); for (const l of d.lines) for (const id of l.ids) d.ids.add(id); if (d.via) d.ids.add(d.via.id);
  d.sol = dragSolution(d, d.start);   // the item as it is: what an Escape or a refused step shows
  return d;
}
/** One drag step's geometry: each line rebuilt for cursor p (no collision handling). */
export function dragSolution(d: DragSub, p: Pt): DragSolution {
  const thresh = (l: TrackLine) => (d.free ? 0 : l.width / 4);   // smooth_dragged_segments: a quarter width in walk around
  const viaLine = (l: TrackLine) => l.arc ? (d.free ? chainSimplify([p.slice(), l.pts[1].slice()]) : chainSimplify(initialTrace(l.pts[1], p, -1, l.arcDiag).reverse()))
    : d.free ? dragCornerFree(l.pts, l.vertex!, p) : dragCorner45(l.pts, l.vertex!, p, 0);
  if (d.mode === "via") return { lines: d.lines.map((l) => ({ l, pts: viaLine(l) })), viaAt: p.slice() };
  const l = d.lines[0];
  const pts = d.mode === "segment" ? dragSegment45(l.pts, l.index, p, thresh(l)) : d.free ? dragCornerFree(l.pts, l.vertex!, p) : dragCorner45(l.pts, l.vertex!, p, thresh(l));
  return { lines: [{ l, pts }] };
}
export function dragObstacles(ctx: PcbCtx, d: DragSub, layer: string) {
  let O = d.obs.get(layer); if (O) return O;
  O = routeObstacles(ctx.doc, settingsOf(ctx), d.netKey, layer, d.netKey ? null : d.ids, d.excl); d.obs.set(layer, O); return O;
}
/** NODE::CheckColliding for a drag solution: every obstacle a dragged line or the dragged via violates. */
export function solutionHits(ctx: PcbCtx, d: DragSub, sol: DragSolution) {
  const out: Obstacle[] = [];
  for (const { l, pts } of sol.lines) for (const ob of pathHits(dragObstacles(ctx, d, l.layer), pts, l.width / 2)) if (!out.includes(ob)) out.push(ob);
  if (sol.viaAt) { const copper = ctx.doc.copper.length ? ctx.doc.copper : ["F.Cu", "B.Cu"]; const r = viaNow(d.via!.node).size / 2; for (const L of viaLayers(d.via!.node, copper)) for (const ob of pathHits(dragObstacles(ctx, d, L), [sol.viaAt], r)) if (!out.includes(ob)) out.push(ob); }
  return out;
}
/** DRAGGER::tryWalkaround, locally: a dragged segment that crosses an obstacle hugs it at clearance (its ends must be clear). */
export function walkSolution(ctx: PcbCtx, d: DragSub, sol: DragSolution): DragSolution | null {
  const lines: DragSolution["lines"] = [];
  for (const { l, pts } of sol.lines) {
    const O = dragObstacles(ctx, d, l.layer), r = l.width / 2; if (pathClear(O, pts, r)) { lines.push({ l, pts }); continue; }
    const out = [pts[0].slice()];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!segHit(O, a, b, r)) { out.push(b.slice()); continue; }
      if (segHit(O, a, a, r) || segHit(O, b, b, r)) return null;
      const w = walkTo(O, a, b, r, isDiagDir(dir8(a, b)), i > 0 ? dir8(pts[i - 1], a) : -1, now() + 30); if (!w) return null;
      if (ptsLength(w) > 30 * Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), l.width)) return null;   // SetLengthLimit( true, 30.0 )
      chainAppend(out, w);
    }
    const s = chainSimplify(out); if (s.length < 2 || !pathClear(O, s, r)) return null; lines.push({ l, pts: s });
  }
  return Object.assign({}, sol, { lines });
}
