// pcb-tools/posture.ts — DIRECTION_45::BuildInitialTrace in every corner mode, and track elements.
import type { BoardDoc, NetRef, Pt, TrackElem } from "./types";
import { chainAppend, peq, rp } from "./dragger";
import { netNode } from "./nets";
import { is90, isRounded } from "./router-settings";
import { K } from "./state";
import { r6, samePt, vadd, vmul, vsub, vunit } from "./util";
import { legPts } from "./walkaround";

// ---------------------------------------------------------------- DIRECTION_45::BuildInitialTrace in every corner mode
/**
 * The two-segment trace from a to b.  diagFirst is the posture (DIRECTION_45::IsDiagonal of the guessed direction).
 * 45° modes: a straight and a diagonal run; 90° modes: one horizontal and one vertical leg, the longer axis first in
 * the straight posture (`startDiagonal == ( h >= w )` takes E first).  Free angle (Highlight collisions only): a
 * single segment.
 */
export function cornerLeg(a: Pt, b: Pt, diagFirst: boolean, cm: number, free: boolean) {
  if (free) return samePt(a, b) ? [a.slice()] : [a.slice(), b.slice()];
  if (!is90(cm)) return legPts(a, b, diagFirst);
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (w < 1e-9 || h < 1e-9) return samePt(a, b) ? [a.slice()] : [a.slice(), b.slice()];
  const mid = diagFirst === (h >= w) ? [b[0], a[1]] : [a[0], b[1]];
  return [a.slice(), rp(mid), b.slice()];
}
/**
 * The rounded corner modes: every corner of a mitred line becomes a tangent arc.  BuildInitialTrace's fillet uses
 * the whole of the shorter leg (ROUNDED_45: radius diagLength / (2 cos 67.5°), the chord over the diagonal;
 * ROUNDED_90: the radius is the shorter of the two runs), so the tangent length at a corner is the shorter
 * adjacent run — half of a run that has a corner at both ends.  Returns elements [{ t: "seg", a, b } | { t: "arc", a, m, b }].
 */
export function roundCorners(pts: Pt[]): TrackElem[] {
  const n = pts.length; if (n < 3) return pts.length > 1 ? [{ t: "seg", a: pts[0].slice(), b: pts[1].slice() }] : [];
  const len = (i: number) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const corners: ({ a: Pt; b: Pt; m: Pt } | null)[] = [];
  for (let i = 1; i < n - 1; i++) {
    const lp = len(i - 1) * (i - 1 === 0 ? 1 : 0.5), ln = len(i) * (i + 1 === n - 1 ? 1 : 0.5); const t = Math.min(lp, ln);
    const u1 = vunit(vsub(pts[i - 1], pts[i])), u2 = vunit(vsub(pts[i + 1], pts[i]));
    const cos = u1[0] * u2[0] + u1[1] * u2[1];
    if (t < 1e-6 || cos < -1 + 1e-9) { corners.push(null); continue; }   // straight on: no corner
    const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2; const bis = vunit(vadd(u1, u2));
    const R = t * Math.tan(half), dc = t / Math.cos(half);
    corners.push({ a: rp(vadd(pts[i], vmul(u1, t))), b: rp(vadd(pts[i], vmul(u2, t))), m: rp(vadd(pts[i], vmul(bis, dc - R))) });
  }
  const out: TrackElem[] = []; let cur = pts[0].slice();
  for (let i = 1; i < n - 1; i++) {
    const c = corners[i - 1]; if (!c) continue;
    if (!peq(cur, c.a)) out.push({ t: "seg", a: cur, b: c.a });
    out.push({ t: "arc", a: c.a, m: c.m, b: c.b }); cur = c.b;
  }
  if (!peq(cur, pts[n - 1])) out.push({ t: "seg", a: cur, b: pts[n - 1].slice() });
  return out;
}
/** A line's elements as a polyline (arcs at 8 chords): what the clearance checks walk. */
export function elemsPts(els: TrackElem[]) {
  const out: Pt[] = [];
  for (const e of els) {
    if (e.t === "seg") { chainAppend(out, [e.a, e.b]); continue; }
    const arc = K.arcFrom3(e.a, e.m, e.b); if (!arc) { chainAppend(out, [e.a, e.b]); continue; }
    let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const pts = [e.a]; for (let k = 1; k < 8; k++) { const a = arc.a0 + (arc.anticlockwise ? -1 : 1) * sweep * k / 8; pts.push([arc.x + arc.r * Math.cos(a), arc.y + arc.r * Math.sin(a)]); }
    pts.push(e.b); chainAppend(out, pts);
  }
  return out;
}
/** The head's elements in the current corner mode: rounded only where the fillet keeps clear (the mitred corner otherwise). */
export function headElems(pts: Pt[], cm: number, clear?: ((pts: Pt[]) => boolean) | null): TrackElem[] {
  const plain = () => pts.slice(0, -1).map((p: Pt, i: number): TrackElem => ({ t: "seg", a: p.slice(), b: pts[i + 1].slice() }));
  if (!isRounded(cm) || pts.length < 3) return plain();
  const els = roundCorners(pts); return !clear || clear(elemsPts(els)) ? els : plain();
}
export function arcTrackNode(doc: BoardDoc, a: Pt, m: Pt, b: Pt, width: number, layer: string, net: NetRef | null): SNode {
  return ["arc", ["start", r6(a[0]), r6(a[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(b[0]), r6(b[1])], ["width", r6(width)], ["layer", layer], netNode(doc, net)];
}
