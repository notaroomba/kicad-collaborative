// pcb-tools/smartpads.ts — OPTIMIZER::SMART_PADS: pad breakouts.
import type { BoardDoc, PadInfo, Pt } from "./types";
import { ptKey } from "./connected";
import { padShape, shapeGap } from "./distances";
import { chainLen, jointIndex, rp } from "./dragger";
import { segIntersect } from "./shove";
import { rotator, samePt } from "./util";
import { dir8, legPts, simplifyPts } from "./walkaround";

// ---- OPTIMIZER::SMART_PADS (pns_optimizer.cpp computeBreakouts / smartPadsSingle / runSmartPads)
export const ANG_OBTUSE = 1, ANG_RIGHT = 2, ANG_ACUTE = 4, ANG_STRAIGHT = 8, ANG_HALF_FULL = 16, ANG_UNDEFINED = 32;
/** DIRECTION_45::Angle as KiCad's AngleType flags. */
export function angleType(d1: number, d2: number) {
  if (d1 < 0 || d2 < 0) return ANG_UNDEFINED;
  const d = Math.abs(d1 - d2);
  return d === 1 || d === 7 ? ANG_OBTUSE : d === 2 || d === 6 ? ANG_RIGHT : d === 3 || d === 5 ? ANG_ACUTE : d === 4 ? ANG_HALF_FULL : ANG_STRAIGHT;
}
/** COST_ESTIMATOR::CornerCost of a point chain. */
export function cornerCost(pts: Pt[]) {
  const C: Record<number, number> = { [ANG_OBTUSE]: 10, [ANG_STRAIGHT]: 5, [ANG_ACUTE]: 50, [ANG_RIGHT]: 30, [ANG_HALF_FULL]: 60 };
  let t = 0; for (let i = 0; i + 2 < pts.length; i++) t += C[angleType(dir8(pts[i], pts[i + 1]), dir8(pts[i + 1], pts[i + 2]))] || 100; return t;
}
/** LINE::CountCorners( aAngles ) */
export function countCorners(pts: Pt[], mask: number) { let n = 0; for (let i = 0; i + 2 < pts.length; i++) if (angleType(dir8(pts[i], pts[i + 1]), dir8(pts[i + 1], pts[i + 2])) & mask) n++; return n; }
/**
 * OPTIMIZER::computeBreakouts for a pad: rectBreakouts (rect, rounded rect, chamfered, an oval as its segment's
 * rectangle) on axis-aligned pads, circleBreakouts on round ones, customBreakouts (the 8 rays to the outline) on the rest.
 */
export function padBreakouts(pad: PadInfo, width: number) {
  const c: Pt = [pad.x, pad.y]; const rot = ((pad.rot % 360) + 360) % 360; const out: Pt[][] = [];
  if (pad.shape === "circle") {
    const r = pad.w / 2; for (let a = 0; a < 360; a += 45) { const t = -a * Math.PI / 180; out.push([c, [c[0] + r * Math.SQRT2 * Math.cos(t), c[1] - r * Math.SQRT2 * Math.sin(t)]]); }
    return out;
  }
  if (rot % 90 === 0 && /^(rect|roundrect|oval|chamfered_rect)$/.test(pad.shape)) {
    const swap = rot % 180 === 90; const sx = swap ? pad.h : pad.w, sy = swap ? pad.w : pad.h;
    const off: Pt = [sx > sy ? (sx - sy) / 2 : 0, sx < sy ? (sy - sx) / 2 : 0];
    const add = (...v: Pt[]) => v.reduce((a, b) => [a[0] + b[0], a[1] + b[1]]); const neg = (v: Pt): Pt => [-v[0], -v[1]];
    const dv: Pt = [0, sy / 2 + width], dh: Pt = [sx / 2 + width, 0];
    out.push([c, add(c, dh)], [c, add(c, neg(dh))], [c, add(c, dv)], [c, add(c, neg(dv))]);
    const l = width + Math.min(sx, sy) / 2;
    if (sx >= sy) {
      out.push([c, add(c, off), add(c, off, [l, l])], [c, add(c, off), add(c, off, neg([-l, l]))], [c, add(c, neg(off)), add(c, neg(off), [-l, l])], [c, add(c, neg(off)), add(c, neg(off), neg([l, l]))]);
    } else {
      out.push([c, add(c, off), add(c, off, [l, l])], [c, add(c, neg(off)), add(c, neg(off), neg([-l, l]))], [c, add(c, off), add(c, off, [-l, l])], [c, add(c, neg(off)), add(c, neg(off), neg([l, l]))]);
    }
    return out.map((b) => b.map(rp));
  }
  // customBreakouts: from the centre to where each 45° ray leaves the pad's outline
  const R = rotator(pad.rot); const hw = pad.w / 2, hh = pad.h / 2;
  const poly = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => { const [rx, ry] = R(x, y); return [c[0] + rx, c[1] + ry] as Pt; });
  const len = Math.max(pad.w, pad.h) / 2 + 5e-6;
  for (let a = 0; a < 360; a += 45) {
    const t = -a * Math.PI / 180; const v: Pt = [c[0] + len * Math.cos(t), c[1] - len * Math.sin(t)];
    let hit = null; for (let i = 0; i < 4; i++) { const q = segIntersect(c, v, poly[i], poly[(i + 1) % 4]); if (q) { hit = q; break; } }
    // segIntersect is shove's (the later declaration won): it answers { t, u, p }, which rp reads as [NaN, NaN] as it always has
    if (hit) out.push([c, rp(hit as unknown as Pt)]);
  }
  return out;
}
// (a first segIntersect() stood here; the later declaration of the same name hoisted over it, so it never ran)
/** OPTIMIZER::findPadOrVia: the pad (or via) of the net centred on the point on the layer. */
export function padOrViaAt(doc: BoardDoc, layer: string, netKey: string, p: Pt) {
  const J = jointIndex(doc); const k = ptKey(p);
  if ((J.vias.get(k) || []).some((v) => v.layers.has(layer) && v.net === netKey)) return { via: true };
  const x = (J.pads.get(k) || []).find((x) => x.layers.has(layer) && samePt([x.pad.x, x.pad.y], p) && J.NT.key(x.pad.net) === netKey);
  return x ? { pad: x.pad } : null;
}
/** OPTIMIZER::smartPadsSingle: the cheapest collision-free breakout from the pad replacing the line's first vertices. */
export function smartPadsSingle(line: Pt[], pad: PadInfo, width: number, atEnd: boolean, endVertex: number, clear: (pts: Pt[]) => boolean) {
  const forbidden = ANG_ACUTE | ANG_RIGHT | ANG_HALF_FULL | ANG_UNDEFINED;
  // don't do optimized connections for offset pads (solid->Offset() != 0)
  if (pad.off && (pad.off[0] !== 0 || pad.off[1] !== 0)) return null;
  const L = atEnd ? line.slice().reverse() : line; const pEnd = Math.min(endVertex, Math.min(3, L.length - 1));
  const breakouts = padBreakouts(pad, width); const variants: { p: number; len: number; pts: Pt[] }[] = []; const lineLen = chainLen(L); const shape = padShape(pad);
  for (let p = 1; p <= pEnd; p++) {
    // "If the line is contained inside the pad, don't optimize": solid->Shape( -1 )->Collide( SEG( line[0], line[p] ), width / 2 ) false → skip p
    const gap = shapeGap(shape, { t: "seg", a: L[0], b: L[p], r: 0 });
    if (!(gap === 0 || gap < width / 2)) continue;
    for (const br of breakouts) {
      for (let diag = 0; diag < 2; diag++) {
        const last = br[br.length - 1]; const connect = legPts(last, L[p], diag === 0);
        if (connect.length < 2 || samePt(connect[0], connect[connect.length - 1])) continue;
        const ang1 = angleType(dir8(br[br.length - 2], last), dir8(connect[0], connect[1]));
        if (ang1 & forbidden) continue;
        const bl = chainLen(br); if (bl > lineLen) continue;
        const v = br.concat(connect.slice(1)); for (let i = p + 1; i < L.length; i++) v.push(L[i]);
        if (countCorners(simplifyPts(v), forbidden) === 0) variants.push({ p, len: bl, pts: simplifyPts(atEnd ? v.slice().reverse() : v) });
      }
    }
  }
  let minCost = cornerCost(line), maxLen = 0, best: (typeof variants)[number] | null = null;
  for (const vp of variants) {
    const cost = cornerCost(vp.pts);
    if (!clear(vp.pts)) continue;
    if (cost < minCost || (cost === minCost && vp.len > maxLen)) { best = vp; if (cost <= minCost) maxLen = Math.max(vp.len, maxLen); minCost = Math.min(cost, minCost); }
  }
  return best;
}
/** OPTIMIZER::runSmartPads on the head: the start and end pads' breakouts.  The new points, or null when nothing changed. */
export function runSmartPads(doc: BoardDoc, pts: Pt[], width: number, layer: string, netKey: string, clear: (pts: Pt[]) => boolean) {
  if (!netKey || pts.length < 3) return null;
  let line = pts.map((q: Pt) => q.slice()), changed = false, vtx = -1;
  const sp = padOrViaAt(doc, layer, netKey, line[0]);
  if (sp && sp.pad) { const r = smartPadsSingle(line, sp.pad, width, false, 3, clear); if (r) { line = r.pts; vtx = r.p; changed = true; } }
  const ep = padOrViaAt(doc, layer, netKey, line[line.length - 1]);
  if (ep && ep.pad) { const r = smartPadsSingle(line, ep.pad, width, true, vtx < 0 ? line.length - 1 : line.length - 1 - vtx, clear); if (r) { line = r.pts; changed = true; } }
  return changed ? simplifyPts(line) : null;
}
