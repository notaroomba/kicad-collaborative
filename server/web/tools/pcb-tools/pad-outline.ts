// pcb-tools/pad-outline.ts — PAD::TransformShapeToPolygon (pad.cpp) for a pad with no clearance, as PAD::Recombine
// asks for it (ERROR_INSIDE, the board's maximum error): the shape-building helpers of
// libs/kimath/src/convert_basic_shapes_to_polygon.cpp ported in internal units (nm), then back to mm.
//
//   circle                 TransformCircleToPolygon (16 segments at least, rounded up to a multiple of 8)
//   oval                   TransformOvalToPolygon: a stadium (the segment between the two arc centres, half the
//                          shorter side as radius); an oval with equal sides is a circle
//   rect / trapezoid       TransformTrapezoidToPolygon (the rect_delta skews the sides)
//   roundrect / chamfered  TransformRoundChamferedRectToPolygon (corner radius = rratio x shorter side; chamfered
//                          corners cut by chamfer_ratio x shorter side, the others rounded)
import type { Pt } from "./types";
import { K } from "./state";
import { rotator } from "./util";

type V = [number, number];
const IU = 1e6;
/** BOARD_DESIGN_SETTINGS::m_MaxError default (ARC_HIGH_DEF): 0.005 mm. */
export const MAX_ERROR_IU = 5000;
const MIN_SEGCOUNT_FOR_CIRCLE = 8;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown) => { const x = Number(v); return isNaN(x) ? 0 : x; };
const rnd = (v: number) => Math.round(v);

/** GetArcToSegmentCount (geometry_utils.cpp). */
export function arcToSegmentCount(radius: number, errorMax: number, arcDeg: number): number {
  radius = Math.max(1, radius); errorMax = Math.max(1, errorMax);
  const rel = errorMax / radius;
  let inc = 180 / Math.PI * Math.acos(1 - rel) * 2;
  inc = Math.min(360 / MIN_SEGCOUNT_FOR_CIRCLE, inc);
  return Math.max(rnd(Math.abs(arcDeg) / inc), 2);
}
/** RotatePoint( pt, angle ) (KiCad's y-down convention). */
const rot = (p: V, deg: number): V => rotator(deg)(p[0], p[1]) as V;
const resize = (v: V, len: number): V => { const l = Math.hypot(v[0], v[1]); return l ? [rnd(v[0] * len / l), rnd(v[1] * len / l)] : [0, 0]; };
const perp = (v: V): V => [-v[1], v[0]];
/** SEG( a, b ).ReflectPoint( p ). */
function reflect(a: V, b: V, p: V): V {
  const d: V = [b[0] - a[0], b[1] - a[1]]; const l2 = d[0] * d[0] + d[1] * d[1]; if (!l2) return p;
  const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2; const q: V = [a[0] + t * d[0], a[1] + t * d[1]];
  return [rnd(2 * q[0] - p[0]), rnd(2 * q[1] - p[1])];
}

/** TransformCircleToPolygon( SHAPE_POLY_SET ), ERROR_INSIDE. */
export function circleToPolygon(c: V, radius: number, error: number, minSeg: number): V[] {
  let n = Math.max(minSeg, arcToSegmentCount(radius, error, 360)); n = Math.floor((n + 7) / 8) * 8;
  const delta = 360 / n; const out: V[] = [];
  for (let a = delta / 2; a < 360 - 1e-9; a += delta) { const p = rot([radius, 0], a); out.push([rnd(p[0]) + c[0], rnd(p[1]) + c[1]]); }
  return out;
}
/** TransformOvalToPolygon, ERROR_INSIDE (the clamp to the segment's box removes nothing then). */
export function ovalToPolygon(start: V, end: V, width: number, error: number, minSeg: number): V[] {
  const radius = Math.trunc(width / 2);
  let n = Math.max(minSeg, arcToSegmentCount(radius, error, 360)); n = Math.floor((n + 7) / 8) * 8;
  const delta = 360 / n;
  let endp: V = [end[0] - start[0], end[1] - start[1]], startp = start;
  if (endp[0] < 0) { endp = [start[0] - end[0], start[1] - end[1]]; startp = end; }
  const ang = Math.atan2(endp[1], endp[0]) * 180 / Math.PI; const len = rnd(Math.hypot(endp[0], endp[1]));
  const poly: V[] = [[len, radius]];
  for (let a = delta / 2; a < 180 - 1e-9; a += delta) { const p = rot([0, radius], a); poly.push([rnd(p[0]) + len, rnd(p[1])]); }
  poly.push([len, -radius], [0, -radius]);
  for (let a = delta / 2; a < 180 - 1e-9; a += delta) { const p = rot([0, -radius], a); poly.push([rnd(p[0]), rnd(p[1])]); }
  poly.push([0, radius]);
  return poly.map((p) => { const q = rot(p, -ang); return [rnd(q[0]) + startp[0], rnd(q[1]) + startp[1]] as V; });
}

interface Corner { p: V; r: number }
/** CornerListToPolygon, no inflation, ERROR_INSIDE. */
function cornerListToPolygon(cs: Corner[], error: number): V[] {
  const out: V[] = []; let incoming: V = [cs[0].p[0] - cs[cs.length - 1].p[0], cs[0].p[1] - cs[cs.length - 1].p[1]];
  for (let i = 0; i < cs.length; i++) {
    const cur = cs[i], next = cs[(i + 1) % cs.length]; const outgoing: V = [next.p[0] - cur.p[0], next.p[1] - cur.p[1]];
    if (!cur.r) out.push(cur.p);
    else {
      const radius = cur.r; let endAngle: number, tan2: number;
      if ((incoming[0] === 0 && outgoing[1] === 0) || (incoming[1] === 0 && outgoing[0] === 0)) { endAngle = 90; tan2 = 1; }
      else {
        const cosNum = incoming[0] * outgoing[0] + incoming[1] * outgoing[1], cosDen = Math.hypot(incoming[0], incoming[1]) * Math.hypot(outgoing[0], outgoing[1]);
        const a = Math.acos(cosNum / cosDen); tan2 = Math.tan((Math.PI - a) / 2); endAngle = a * 180 / Math.PI;
      }
      const numSegs = Math.max(16, arcToSegmentCount(radius, error, 360)); const angDelta = 360 / numSegs;
      let lastSeg = endAngle;
      if (lastSeg > 0) { while (lastSeg > angDelta) lastSeg -= angDelta; } else { while (lastSeg < -angDelta) lastSeg += angDelta; }
      let angPos = Math.abs(lastSeg) < 1e-12 ? angDelta : (angDelta + lastSeg) / 2;
      const dist = tan2 > 0 ? radius / tan2 : 0;
      const r1 = resize(incoming, dist); const arcStart: V = [cur.p[0] - r1[0], cur.p[1] - r1[1]];
      const r2 = resize(perp(incoming), radius); const center: V = [arcStart[0] + r2[0], arcStart[1] + r2[1]];
      const arcEnd = reflect(cur.p, center, arcStart); const origin: V = [arcStart[0] - center[0], arcStart[1] - center[1]];
      out.push(arcStart);
      for (; angPos < endAngle - 1e-9; angPos += angDelta) { const q = rot(origin, -angPos); out.push([rnd(q[0]) + center[0], rnd(q[1]) + center[1]]); }
      out.push(arcEnd);
    }
    incoming = outgoing;
  }
  return out;
}
function removeDuplicates(cs: Corner[]): void {
  let prev = cs[0].p;
  for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].p[0] === prev[0] && cs[i].p[1] === prev[1]) cs.splice(i, 1); else prev = cs[i].p; }
}
/** TransformTrapezoidToPolygon, no inflation (pad frame, unrotated). */
export function trapezoidToPolygon(size: V, ddx: number, ddy: number, error: number): V[] {
  const s: V = [Math.trunc(size[0] / 2), Math.trunc(size[1] / 2)];
  const cs: Corner[] = [{ p: [-s[0] + ddy, -s[1] - ddx], r: 0 }, { p: [s[0] - ddy, -s[1] + ddx], r: 0 }, { p: [s[0] + ddy, s[1] - ddx], r: 0 }, { p: [-s[0] - ddy, s[1] + ddx], r: 0 }];
  if (Math.abs(ddy) === Math.abs(s[0]) || Math.abs(ddx) === Math.abs(s[1])) removeDuplicates(cs);
  return cornerListToPolygon(cs, error);
}
const CHAMFER_BITS: Record<string, number> = { top_left: 1, top_right: 2, bottom_left: 4, bottom_right: 8 };
/** TransformRoundChamferedRectToPolygon, no inflation (pad frame, unrotated). */
export function roundChamferedRectToPolygon(size: V, radius: number, chamferRatio: number, chamferCorners: number, error: number): V[] {
  const s: V = [Math.trunc(size[0] / 2), Math.trunc(size[1] / 2)];
  const cs: Corner[] = [{ p: [-s[0], -s[1]], r: radius }, { p: [s[0], -s[1]], r: radius }, { p: [s[0], s[1]], r: radius }, { p: [-s[0], s[1]], r: radius }];
  if (chamferCorners) {
    const shorter = Math.min(size[0], size[1]); const chamfer = Math.max(0, rnd(chamferRatio * shorter));
    const chamId = [CHAMFER_BITS.top_left, CHAMFER_BITS.top_right, CHAMFER_BITS.bottom_right, CHAMFER_BITS.bottom_left];
    const sign = [0, 1, -1, 0, 0, -1, 1, 0];
    for (let cc = 0, pos = 0; cc < 4; cc++, pos++) {
      if (!(chamferCorners & chamId[cc])) continue;
      cs[pos].r = 0;
      if (chamfer === 0) continue;
      cs.splice(pos + 1, 0, { p: [cs[pos].p[0], cs[pos].p[1]], r: 0 });
      cs[pos].p = [cs[pos].p[0] + sign[(2 * cc) & 7] * chamfer, cs[pos].p[1] + sign[(2 * cc - 2) & 7] * chamfer];
      cs[pos + 1].p = [cs[pos + 1].p[0] + sign[(2 * cc + 1) & 7] * chamfer, cs[pos + 1].p[1] + sign[(2 * cc - 1) & 7] * chamfer];
      pos++;
    }
    let cnt = 0; for (const b of chamId) if (chamferCorners & b) cnt++;
    if (cnt > 1 && 2 * chamfer >= shorter) removeDuplicates(cs);
  }
  return cornerListToPolygon(cs, error);
}

/**
 * PAD::TransformShapeToPolygon( aClearance 0, ERROR_INSIDE ) of a non-custom pad, in the footprint frame (mm): the
 * outline about ShapePos, turned by the pad's orientation.  `shapePos` is the pad's shape position (mm).
 */
export function padShapePolygon(pad: SNode, shapePos: Pt, maxError = MAX_ERROR_IU): Pt[] {
  const at = K.kid(pad, "at") || []; const orient = num(at[3]);
  const sz = K.kid(pad, "size"); const w = rnd(num(sz && sz[1]) * IU), h = rnd(num(sz && sz[2]) * IU);
  const shape = str(pad[3]); const minSeg = 16;
  let local: V[];
  const dx = Math.trunc(w / 2), dy = Math.trunc(h / 2);
  if (shape === "circle" || shape === "oval") {
    if (dx === dy || shape === "circle") local = circleToPolygon([0, 0], dx, maxError, minSeg);
    else {
      // the stadium's segment is computed already turned (RotatePoint( delta, GetOrientation() )), so no turn after
      const half = Math.min(dx, dy); const d = rot([dx - half, dy - half], orient); const dd: V = [rnd(d[0]), rnd(d[1])];
      const pts = ovalToPolygon([-dd[0], -dd[1]], dd, half * 2, maxError, minSeg);
      return pts.map((p) => [r6mm(p[0]) + shapePos[0], r6mm(p[1]) + shapePos[1]] as Pt);
    }
  } else if (shape === "rect" || shape === "trapezoid") {
    const d = shape === "trapezoid" ? K.kid(pad, "rect_delta") : null;
    const ddx = d ? Math.trunc(rnd(num(d[1]) * IU) / 2) : 0, ddy = d ? Math.trunc(rnd(num(d[2]) * IU) / 2) : 0;
    local = trapezoidToPolygon([w, h], ddx, ddy, maxError);
  } else {
    // roundrect, and roundrect with (chamfer …) = CHAMFERED_RECT
    const rr = K.kid(pad, "roundrect_rratio"); const radius = rr ? rnd(num(rr[1]) * Math.min(w, h)) : 0;
    const ch = K.kid(pad, "chamfer"); let bits = 0; for (const c of ch ? ch.slice(1) : []) bits |= CHAMFER_BITS[str(c)] || 0;
    const cr = K.kid(pad, "chamfer_ratio"); const ratio = cr ? num(cr[1]) : 0.2;
    local = roundChamferedRectToPolygon([w, h], shape === "roundrect" ? radius : 0, bits ? ratio : 0, bits, maxError);
  }
  return local.map((p) => { const q = rot(p, orient); return [r6mm(rnd(q[0])) + shapePos[0], r6mm(rnd(q[1])) + shapePos[1]] as Pt; });
}
const r6mm = (iu: number) => +(iu / IU).toFixed(6);
