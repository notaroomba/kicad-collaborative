// pcb-tools/meander.ts — length tuning: PNS::MEANDER_PLACER and MEANDER_SHAPE in KiCad's internal units.
import type { Pt } from "./types";

/** A tuning target: min / opt / max in IU. */
export interface TuneRange { min: number; opt: number; max: number }
/** MEANDER_SETTINGS, lengths in IU. */
export interface MeanderSettings {
  minAmp: number; maxAmp: number; step: number; spacing: number; crPct: number; round: boolean; singleSided: boolean; initialSide: number;
  target: TuneRange; skew: TuneRange; overrideCustomRules: boolean; keepEndpoints: boolean;
}
/** A node of a chain with arcs: reached from the node before straight, or along an arc through m. */
export interface ChNode { p: Pt; m?: Pt }
export type Chain = ChNode[];
/** SEG */
export interface Seg { A: Pt; B: Pt }
/** MEANDER_PLACER as the shapes reach it: its settings, clearance, the line being built and the fit check. */
export interface MeanderPlacer { st: MeanderSettings; clearance: number; width: number; result: MLine | null; checkFit(m: MeanderShape): boolean }
/** MEANDER_SHAPE */
export interface MeanderShape {
  pl: MeanderPlacer; width: number; type: number; amp: number; side: boolean; p0: Pt; baseSeg: Seg; clipped: Seg; line: Chain;
  meanCr: number; targetBaseLen: number; offset: number;
}
/** MEANDERED_LINE */
export interface MLine { pl: MeanderPlacer; width: number; meanders: MeanderShape[]; last: Pt }
/** What meanderMove tunes: the line and the stretch of it (IU), the settings, and the collision check. */
export interface MeanderParams {
  pts: Pt[]; origin: Pt; end: Pt; cursor?: Pt | null; st: MeanderSettings; width: number; clearance: number; lineLength: number;
  collides?: ((line: Chain) => boolean) | null;
}
import { arcLength, segSegDist } from "./distances";
import { closestOnSeg } from "./point-editor";
import { K } from "./state";
import { vadd, vmul, vsub } from "./util";

// ---------------------------------------------------------------- length tuning (PNS::MEANDER_PLACER, MEANDER_SHAPE, PCB_TUNING_PATTERN)
// Tune Length of a Single Track (7): the router's meander placer, ported from pns_meander.cpp /
// pns_meander_placer.cpp / pns_meander_placer_base.cpp in KiCad's internal units (nm) so the amplitude steps, the
// corner radii and the length tolerances land where pcbnew's do.  The first click anchors the pattern on a track,
// the cursor drags its end along the track (the side it is on picks the side the meanders go), the second click
// commits "Tune": the line rebuilt with its meanders and a (generated (type tuning_pattern) …) holding them.
export const TUNE_IU = 1e6;
export const LENGTH_UNCONSTRAINED = 1e6 * TUNE_IU, DEFAULT_LENGTH_TOLERANCE = 0.1 * TUNE_IU, LENGTH_TARGET_TOLERANCE = 20;
export const DELAY_UNCONSTRAINED_MM = 1e6;   // DELAY_UNCONSTRAINED (1e6 ps · IU_PER_PS) as set_iu writes it (÷ IU_PER_MM)
export const MT_SINGLE = 1, MT_START = 2, MT_FINISH = 3, MT_TURN = 4, MT_CHECK_START = 5, MT_CHECK_FINISH = 6, MT_CORNER = 7, MT_ARC = 8, MT_EMPTY = 9;
export const TUNED = "tuned", TOO_SHORT = "too_short", TOO_LONG = "too_long";
export const TUNE_MSG_INSIDE = "Unable to tune segments inside other tuning patterns.";
export const TUNE_MSG_SELECT = "Select a track to tune first.";
export const TUNE_MSG_PICK = "Please select a track whose length you want to tune.";
export const TUNE_STATUS_TEXT: Record<string, string> = { [TOO_LONG]: "too long", [TOO_SHORT]: "too short", [TUNED]: "tuned" };
/** MEANDER_SETTINGS() */
export function meanderDefaults() {
  const st = { minAmp: 200000, maxAmp: 1000000, step: 50000, spacing: 600000, crPct: 80, round: true, singleSided: false, initialSide: -1,
    target: null, overrideCustomRules: false, keepEndpoints: false } as unknown as MeanderSettings;   // target and skew are set just below
  setTargetLength(st, LENGTH_UNCONSTRAINED); setTargetSkew(st, 0); return st;
}
/** MEANDER_SETTINGS::SetTargetSkew */
export function setTargetSkew(st: MeanderSettings, opt: number) { st.skew = { min: opt - DEFAULT_LENGTH_TOLERANCE, opt, max: opt + DEFAULT_LENGTH_TOLERANCE }; }
/** MEANDER_SETTINGS::SetTargetLength */
export function setTargetLength(st: MeanderSettings, opt: number) {
  st.target = opt === LENGTH_UNCONSTRAINED ? { min: 0, opt, max: opt } : { min: opt - DEFAULT_LENGTH_TOLERANCE, opt, max: opt + DEFAULT_LENGTH_TOLERANCE };
}
export const tuneCopy = (st: MeanderSettings): MeanderSettings => Object.assign({}, st, { target: Object.assign({}, st.target), skew: Object.assign({}, st.skew) });
// vectors in IU (doubles; KiCad's VECTOR2D turtle) — the y axis points down as on the board
export const vsubI = vsub;
export const vlen = (a: Pt) => Math.hypot(a[0], a[1]);
export const vresize = (a: Pt, l: number): Pt => { const n = vlen(a); return n ? [a[0] * l / n, a[1] * l / n] : [0, 0]; };
export const vperp = (a: Pt): Pt => [-a[1], a[0]];                         // VECTOR2::Perpendicular
export const vrot = (a: Pt, cw: boolean): Pt => cw ? [a[1], -a[0]] : [-a[1], a[0]];   // RotatePoint by ANGLE_90 (cw) / -ANGLE_90
export const veq = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
/** SEG::Side: the sign of (B - A) × (P - A). */
export const segSide = (s: Seg, p: Pt) => { const d = (s.B[0] - s.A[0]) * (p[1] - s.A[1]) - (s.B[1] - s.A[1]) * (p[0] - s.A[0]); return d < 0 ? -1 : d > 0 ? 1 : 0; };
/** SEG::LineProject: the point's projection onto the segment's line. */
export function lineProject(s: Seg, p: Pt): Pt { const d = vsubI(s.B, s.A), l2 = d[0] * d[0] + d[1] * d[1]; if (!l2) return s.A.slice(); const t = ((p[0] - s.A[0]) * d[0] + (p[1] - s.A[1]) * d[1]) / l2; return [s.A[0] + d[0] * t, s.A[1] + d[1] * t]; }
/** SEG::ApproxParallel( aSeg, 1 ) */
export function approxParallel(s: Seg, o: Seg) {
  const p = s.A[1] - s.B[1], q = s.B[0] - s.A[0], r = -p * s.A[0] - q * s.A[1], n = Math.hypot(p, q); if (!n) return true;
  return Math.abs((p * o.A[0] + q * o.A[1] + r) / n - (p * o.B[0] + q * o.B[1] + r) / n) <= 1;
}
// SHAPE_LINE_CHAIN with arcs: [{ p }, { p, m }] — a node with m is reached from the one before along an arc through m
export function chAppend(ch: Chain, p: Pt) { if (ch.length && veq(ch[ch.length - 1].p, p)) return; ch.push({ p: p.slice() }); }
export function chAppendChain(ch: Chain, o: Chain) { o.forEach((n, i: number) => { if (!i || !n.m) chAppend(ch, n.p); else ch.push({ p: n.p.slice(), m: n.m.slice() }); }); }
export function chLength(ch: Chain) {
  let L = 0;
  for (let i = 1; i < ch.length; i++) {
    const a = ch[i - 1].p, b = ch[i].p, m = ch[i].m;
    if (m) { const c = K.arcFrom3(a, m, b); if (c) { L += arcLength(c); continue; } }
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}
/** The chain as points (arcs flattened to 10° steps): what collision checks walk. */
export function chPoints(ch: Chain) {
  const out: Pt[] = [];
  ch.forEach((n, i: number) => {
    if (i && n.m) {
      const a = ch[i - 1].p, c = K.arcFrom3(a, n.m, n.p);
      if (c) { let sw = c.anticlockwise ? c.a0 - c.a1 : c.a1 - c.a0; sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); const k = Math.max(2, Math.ceil(sw / (Math.PI / 18)));
        for (let j = 1; j < k; j++) { const t = c.a0 + (c.anticlockwise ? -1 : 1) * sw * j / k; out.push([c.x + c.r * Math.cos(t), c.y + c.r * Math.sin(t)]); } }
    }
    out.push(n.p);
  });
  return out;
}
export function chMirror(ch: Chain, P: Pt, dir: Pt): Chain {
  const s = { A: P, B: vadd(P, dir) };
  const m = (p: Pt) => { const q = lineProject(s, p); return [2 * q[0] - p[0], 2 * q[1] - p[1]]; };
  return ch.map((n) => n.m ? { p: m(n.p), m: m(n.m) } : { p: m(n.p) });
}
/** SHAPE_LINE_CHAIN::Simplify: duplicate and collinear points out, arcs kept. */
export function chSimplify(ch: Chain) {
  const out: Chain = [];
  for (const n of ch) {
    if (out.length && !n.m && veq(out[out.length - 1].p, n.p)) continue;
    if (out.length >= 2 && !n.m && !out[out.length - 1].m) {
      const a = out[out.length - 2].p, b = out[out.length - 1].p, c = n.p;
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) / Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1])) < 1 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0) { out[out.length - 1] = { p: c.slice() }; continue; }
    }
    out.push(n.m ? { p: n.p.slice(), m: n.m.slice() } : { p: n.p.slice() });
  }
  return out;
}

/** MEANDER_SHAPE */
export function newShape(pl: MeanderPlacer, width: number): MeanderShape { return { pl, width, type: MT_EMPTY, amp: 0, side: false, p0: [0, 0], baseSeg: { A: [0, 0], B: [0, 0] }, clipped: { A: [0, 0], B: [0, 0] }, line: [], meanCr: 0, targetBaseLen: 0, offset: 0 }; }
export const shapeCopy = (m: MeanderShape): MeanderShape => Object.assign({}, m, { baseSeg: { A: m.baseSeg.A.slice(), B: m.baseSeg.B.slice() }, clipped: { A: m.clipped.A.slice(), B: m.clipped.B.slice() }, line: m.line.map((n) => Object.assign({}, n)) });
export const isMeanderType = (t: number) => t === MT_SINGLE || t === MT_START || t === MT_FINISH || t === MT_TURN;
/** MEANDER_SHAPE::spacing */
export const shapeSpacing = (m: MeanderShape) => Math.max(m.width + m.pl.clearance, m.pl.st.spacing);
/** MEANDER_SHAPE::MinAmplitude */
export function minAmplitude(m: MeanderShape) {
  const st = m.pl.st;
  if (st.round) return Math.max(st.minAmp, Math.abs(m.offset) + m.width);
  return Math.max(st.minAmp, Math.abs(m.offset) + Math.trunc(m.width * Math.tan(1 - Math.tan(Math.PI / 8))));
}
/** MEANDER_SHAPE::cornerRadius */
export function cornerRadius(m: MeanderShape) {
  if (m.amp === 0) return 0;
  const st = m.pl.st;
  const minCr = st.round ? Math.abs(m.offset) + Math.trunc(m.width / 2) : Math.abs(m.offset) + Math.trunc(m.width / 2 * (1 - Math.tan(Math.PI / 8)));
  const maxCr = Math.min(Math.trunc((m.amp + Math.abs(m.offset)) / 2), Math.trunc(shapeSpacing(m) / 2));
  if (maxCr < minCr) return maxCr;
  const optCr = Math.trunc(shapeSpacing(m) * st.crPct / 200);
  return Math.min(Math.max(optCr, minCr), maxCr);
}
/** MEANDER_SHAPE::genMeanderShape (with start / forward / turn / miter / uShape / makeMiterShape) */
export function genMeanderShape(m: MeanderShape, P: Pt, dir: Pt, side: boolean, type: number, baseOffset: number) {
  let cr = cornerRadius(m), offset = baseOffset; const spc = shapeSpacing(m), amplitude = m.amp, tbl = m.targetBaseLen;
  if (side) offset *= -1;
  const dub = vresize(dir, offset), dvb = vperp(dub);
  if (2 * cr > amplitude + Math.abs(offset)) cr = Math.trunc((amplitude + Math.abs(offset)) / 2);
  if (2 * cr > spc) cr = Math.trunc(spc / 2);
  if (cr - offset < 0) cr = offset;
  m.meanCr = cr;
  const sCorner = cr - offset, uCorner = cr + offset, startSide = amplitude - 2 * cr + Math.abs(offset), turnSide = amplitude - cr;
  let top = spc - 2 * cr;
  let lc: Chain = [], pos!: Pt, cur!: Pt;   // pos and cur are set by start() before any use
  const start = (w: Pt, d: Pt) => { lc = [{ p: w.slice() }]; pos = w.slice(); cur = d.slice(); };
  const forward = (len: number) => { if (len < 5) return; pos = vadd(pos, vresize(cur, len)); chAppend(lc, pos); };
  const turn = (cw: boolean) => { cur = vrot(cur, cw); };
  const miter = (r: number, s: boolean) => {
    if (r <= 0) { turn(s); return; }
    const u = vresize(cur, r), v = vperp(u), sv = s ? -1 : 1;
    const end = vadd(vadd(pos, u), vmul(v, sv));
    if (m.pl.st.round) {
      const c = vadd(pos, vmul(v, sv)); const mid = vadd(c, vmul(vadd(vsubI(pos, c), vsubI(end, c)), Math.SQRT1_2));
      chAppend(lc, pos); lc.push({ p: end, m: mid });
    } else { chAppend(lc, pos); chAppend(lc, end); }
    pos = end; turn(s);
  };
  const uShape = (sides: number, corner: number, t: number) => { forward(sides); miter(corner, true); forward(t); miter(corner, true); forward(sides); };
  start(vadd(P, dvb), dir);
  switch (type) {
  case MT_EMPTY: chAppend(lc, vadd(vadd(P, dvb), dir)); break;
  case MT_START:
    if (tbl) top = Math.max(top, tbl - sCorner - uCorner * 2 + offset);
    miter(sCorner, false); uShape(startSide, uCorner, top); forward(Math.min(sCorner, uCorner)); forward(Math.abs(offset)); break;
  case MT_FINISH:
    if (tbl) top = Math.max(top, tbl - cr - spc);
    start(vsubI(P, dub), dir); turn(false); forward(Math.min(sCorner, uCorner)); forward(Math.abs(offset));
    uShape(startSide, uCorner, top); miter(sCorner, false);
    chAppend(lc, vadd(vadd(P, dvb), vresize(dir, tbl >= spc + cr ? tbl : 2 * spc - cr))); break;
  case MT_TURN:
    if (tbl) top = Math.max(top, tbl - uCorner * 2 + offset * 2);
    start(vsubI(P, dub), dir); turn(false); forward(Math.abs(offset)); uShape(turnSide, uCorner, top); forward(Math.abs(offset)); break;
  case MT_SINGLE:
    if (tbl) top = Math.max(top, Math.trunc((tbl - sCorner * 2 - uCorner * 2) / 2));
    miter(sCorner, false); uShape(startSide, uCorner, top); miter(sCorner, false);
    chAppend(lc, vadd(vadd(P, dvb), vresize(dir, 2 * spc))); break;
  default: break;
  }
  return side ? chMirror(lc, P, dir) : lc;
}
/** MEANDER_SHAPE::updateBaseSegment */
export function updateBaseSegment(m: MeanderShape) { m.clipped = { A: lineProject(m.baseSeg, m.line[0].p), B: lineProject(m.baseSeg, m.line[m.line.length - 1].p) }; }
export const baselineLength = (m: MeanderShape) => vlen(vsubI(m.clipped.B, m.clipped.A));
export const currentLength = (m: MeanderShape) => chLength(m.line);
/** MEANDER_SHAPE::Recalculate / Resize / MakeEmpty / MinTunableLength */
export function recalcShape(m: MeanderShape) { m.line = genMeanderShape(m, m.p0, vsubI(m.baseSeg.B, m.baseSeg.A), m.side, m.type, 0); updateBaseSegment(m); }
export function resizeShape(m: MeanderShape, a: number) { if (a < 0) return; m.amp = Math.max(a, minAmplitude(m)); recalcShape(m); }
export function makeEmpty(m: MeanderShape) { updateBaseSegment(m); const d = vsubI(m.clipped.B, m.clipped.A); m.type = MT_EMPTY; m.amp = 0; m.line = genMeanderShape(m, m.p0, d, m.side, MT_EMPTY, 0); }
export function minTunableLength(m: MeanderShape) { const c = shapeCopy(m); c.targetBaseLen = baselineLength(m); resizeShape(c, minAmplitude(c)); return currentLength(c); }
/** MEANDER_SHAPE::Fit */
export function fitShape(m: MeanderShape, type: number, seg: Seg, P: Pt, side: boolean): boolean {
  const st = m.pl.st;
  if (type === MT_CHECK_START || type === MT_CHECK_FINISH) {
    const prim1 = type === MT_CHECK_START ? MT_START : MT_TURN, prim2 = type === MT_CHECK_START ? MT_TURN : MT_FINISH;
    const m1 = newShape(m.pl, m.width), m2 = newShape(m.pl, m.width);
    const c1 = fitShape(m1, prim1, seg, P, side); const c2 = c1 && fitShape(m2, prim2, seg, m1.clipped.B, !side);
    if (c1 && c2) { Object.assign(m, shapeCopy(m1)); m.type = prim1; m.p0 = P.slice(); m.side = side; updateBaseSegment(m); return true; }
    return false;
  }
  const minAmpl = minAmplitude(m), maxAmpl = Math.max(st.maxAmp, minAmpl), minCr = Math.trunc(m.width / 2);
  for (let ampl = maxAmpl; ampl >= minAmpl; ampl -= st.step) {
    m.amp = ampl;
    m.line = genMeanderShape(m, P, vsubI(seg.B, seg.A), side, type, 0);
    m.type = type; m.baseSeg = { A: seg.A.slice(), B: seg.B.slice() }; m.p0 = P.slice(); m.side = side;
    updateBaseSegment(m);
    if (m.meanCr < minCr) continue;   // nearly square corners (issue #8629)
    if (m.pl.checkFit(m)) return true;
  }
  return false;
}
/** MEANDERED_LINE */
export function newMLine(pl: MeanderPlacer, width: number): MLine { return { pl, width, meanders: [], last: [0, 0] }; }
export function mlAddCorner(L: MLine, a: Pt) { const m = newShape(L.pl, L.width); m.type = MT_CORNER; m.line = [{ p: a.slice() }]; m.clipped = { A: a.slice(), B: a.slice() }; L.last = a.slice(); L.meanders.push(m); }
export function mlAddMeander(L: MLine, m: MeanderShape) { L.last = m.clipped.B.slice(); L.meanders.push(shapeCopy(m)); }
/** MEANDERED_LINE::CheckSelfIntersections */
export function checkSelfIntersections(L: MLine, shape: MeanderShape, clearance: number) {
  let pts: Pt[] | null = null;
  for (let i = L.meanders.length - 1; i >= 0; i--) {
    const m = L.meanders[i]; if (m.type === MT_EMPTY || m.type === MT_CORNER) continue;
    if (approxParallel(shape.clipped, m.clipped)) continue;
    pts = pts || chPoints(shape.line); const mp = chPoints(m.line);
    for (let j = mp.length - 2; j >= 0; j--) for (let k = 0; k + 1 < pts.length; k++) if (segSegDist(pts[k], pts[k + 1], mp[j], mp[j + 1]) < clearance) return false;
  }
  return true;
}
/** MEANDERED_LINE::MeanderSegment */
export function meanderSegment(L: MLine, base: Seg, aSide: boolean) {
  const st = L.pl.st, baseLen = vlen(vsubI(base.B, base.A)), singleSided = st.singleSided, dir = vsubI(base.B, base.A);
  let side = aSide;
  mlAddCorner(L, base.A);
  let turning = false, started = false;
  L.last = base.A.slice();
  for (let guard = 0; guard < 100000; guard++) {
    const m = newShape(L.pl, L.width);
    const thr = shapeSpacing(m); let fail = false;
    let remaining = baseLen - vlen(vsubI(L.last, base.A));
    const flipInitialSide = () => { L.pl.st.initialSide = -L.pl.st.initialSide; };
    const addSingleIfFits = () => {
      fail = true;
      if (fitShape(m, MT_SINGLE, base, L.last, side)) { mlAddMeander(L, m); fail = false; started = false; }
      if (fail && !singleSided && fitShape(m, MT_SINGLE, base, L.last, !side)) { if (!started) flipInitialSide(); mlAddMeander(L, m); fail = false; started = false; side = !side; }
    };
    if (remaining < st.step) break;
    if (!singleSided && remaining > 3.0 * thr) {
      if (!turning) {
        for (let i = 0; i < 2; i++) {
          const checkSide = i === 0 ? side : !side;
          if (fitShape(m, MT_CHECK_START, base, L.last, checkSide)) {
            if (!started && checkSide !== side) flipInitialSide();
            turning = true; mlAddMeander(L, m); side = !checkSide; started = true; break;
          }
        }
        if (!turning) addSingleIfFits();
      } else {
        if (fitShape(m, MT_CHECK_FINISH, base, L.last, side)) { fitShape(m, MT_TURN, base, L.last, side); mlAddMeander(L, m); side = !side; started = true; }
        else { fitShape(m, MT_FINISH, base, L.last, side); started = false; mlAddMeander(L, m); turning = false; }
      }
    } else if (!singleSided && started) {
      if (fitShape(m, MT_FINISH, base, L.last, side)) mlAddMeander(L, m);
      break;
    } else if (!turning && remaining > thr * 2.0) addSingleIfFits();
    else fail = true;
    remaining = baseLen - vlen(vsubI(L.last, base.A));
    if (remaining < st.step) break;
    if (fail) {
      const tmp = newShape(L.pl, L.width);
      const nextP = shapeSpacing(tmp) - 2 * cornerRadius(tmp) + st.step;
      const pn = vadd(L.last, vresize(dir, nextP));
      // SEG::Contains: on the segment within √3 IU
      const q = lineProject(base, pn), t = ((pn[0] - base.A[0]) * dir[0] + (pn[1] - base.A[1]) * dir[1]) / (baseLen * baseLen || 1);
      if (t >= 0 && t <= 1 && vlen(vsubI(q, pn)) <= 1.8) mlAddCorner(L, pn); else break;
    }
  }
  mlAddCorner(L, base.B);
}
/** findAmplitudeBinarySearch / findAmplitudeForLength (pns_meander_placer_base.cpp) */
export function findAmplitudeBinarySearch(copy: MeanderShape, targetLength: number, minAmp: number, maxAmp: number): number {
  if (minAmp === maxAmp) return maxAmp;
  resizeShape(copy, minAmp); const minLen = Math.trunc(currentLength(copy));
  resizeShape(copy, maxAmp); const maxLen = Math.trunc(currentLength(copy));
  if (minLen > targetLength || maxLen < targetLength) return 0;
  const minError = minLen - targetLength, maxError = maxLen - targetLength;
  if (Math.abs(minError) < LENGTH_TARGET_TOLERANCE || Math.abs(maxError) < LENGTH_TARGET_TOLERANCE) return Math.abs(minError) < Math.abs(maxError) ? minAmp : maxAmp;
  const mid = Math.trunc((minAmp + maxAmp) / 2);
  return findAmplitudeBinarySearch(copy, targetLength, minAmp, mid) || findAmplitudeBinarySearch(copy, targetLength, mid, maxAmp) || 0;
}
export function findAmplitudeForLength(m: MeanderShape, targetLength: number, minAmp: number, maxAmp: number) {
  const copy = shapeCopy(m); copy.targetBaseLen = baselineLength(m);
  const initialGuess = Math.trunc(m.amp - (currentLength(m) - targetLength) / 2);
  if (initialGuess >= minAmp && initialGuess <= maxAmp) { resizeShape(copy, minAmp); if (Math.abs(currentLength(copy) - targetLength) < LENGTH_TARGET_TOLERANCE) return initialGuess; }
  return findAmplitudeBinarySearch(copy, targetLength, minAmp, maxAmp);
}
/** MEANDER_PLACER_BASE::tuneLineLength */
export function tuneLineLength(L: MLine, elongation: number) {
  let maxElongation = 0, minElongation = 0, finished = false;
  for (const m of L.meanders) {
    if (m.type === MT_CORNER || m.type === MT_ARC) continue;
    const end = shapeCopy(m); const endType = m.type === MT_START || m.type === MT_SINGLE ? MT_SINGLE : MT_FINISH;
    end.type = endType; recalcShape(end);
    const maxEndElongation = currentLength(end) - baselineLength(end);
    if (maxElongation + maxEndElongation > elongation) {
      if (!finished) {
        m.type = endType; recalcShape(m);
        if (endType === MT_SINGLE) { const endMin = minTunableLength(m) - baselineLength(m); if (minElongation + endMin >= elongation) makeEmpty(m); }
        finished = true;
      } else makeEmpty(m);
    }
    maxElongation += currentLength(m) - baselineLength(m);
    minElongation += minTunableLength(m) - baselineLength(m);
  }
  let remaining = elongation, count = 0;
  for (const m of L.meanders) if (m.type !== MT_CORNER && m.type !== MT_ARC && m.type !== MT_EMPTY) { remaining -= currentLength(m) - baselineLength(m); count++; }
  let reductionLeft = -remaining, left = count;
  if (reductionLeft < 0 || !left) return;
  for (const m of L.meanders) {
    if (m.type === MT_CORNER || m.type === MT_ARC || m.type === MT_EMPTY) continue;
    const here = reductionLeft / left, initialLen = currentLength(m), minAmpl = minAmplitude(m);
    let amp = findAmplitudeForLength(m, Math.trunc(initialLen - here), minAmpl, m.amp);
    if (amp < minAmpl) amp = minAmpl;
    m.targetBaseLen = baselineLength(m); resizeShape(m, amp);
    reductionLeft -= initialLen - currentLength(m); left--;
    if (!left) break;
  }
}
/** SHAPE_LINE_CHAIN::Split( start, end ): the line cut at the two points nearest them, reversed when the end comes first. */
export function splitLine(pts: Pt[], a: Pt, b: Pt) {
  const near = (p: Pt) => { let best: { d: number; i: number; q: Pt } | null = null; for (let i = 0; i + 1 < pts.length; i++) { const q = closestOnSeg(p, pts[i], pts[i + 1]); const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (!best || d < best.d - 1e-9) best = { d, i, q }; } return best; };
  const at = (n: { i: number; q: Pt }) => { const s = pts[n.i]; return n.i + Math.hypot(n.q[0] - s[0], n.q[1] - s[1]) / Math.max(1e-12, Math.hypot(pts[n.i + 1][0] - s[0], pts[n.i + 1][1] - s[1])); };
  let na: { i: number; q: Pt } | null = near(a), nb: { i: number; q: Pt } | null = near(b); let P = pts;
  if (at(na!) > at(nb!)) { P = pts.slice().reverse(); const ra = { i: P.length - 2 - na!.i, q: na!.q }, rb = { i: P.length - 2 - nb!.i, q: nb!.q }; na = ra; nb = rb; }
  const pre: Chain = P.slice(0, na!.i + 1).map((p: Pt) => ({ p: p.slice() })); chAppend(pre, na!.q);
  const mid: Chain = [{ p: na!.q.slice() }]; for (let i = na!.i + 1; i <= nb!.i; i++) chAppend(mid, P[i]); chAppend(mid, nb!.q);
  const post: Chain = [{ p: nb!.q.slice() }]; for (let i = nb!.i + 1; i < P.length; i++) chAppend(post, P[i]);
  return { pre, mid, post, start: na!.q, end: nb!.q };
}
/**
 * MEANDER_PLACER::doMove: the tuned stretch from P.origin to P.end meandered toward the side the settings (or the
 * cursor) pick, trimmed by tuneLineLength to the target.  Everything in IU.  Returns { final, tuned, status, length,
 * hasMeanders, settings }.
 */
export function meanderMove(P: MeanderParams) {
  const st = P.st;
  const pl: MeanderPlacer = { st, clearance: P.clearance, width: P.width, result: null,
    checkFit(m: MeanderShape) { if (P.collides && P.collides(m.line)) return false; return checkSelfIntersections(this.result!, m, m.width + st.spacing); } };
  const sp = splitLine(P.pts, P.origin, P.end);
  const L = newMLine(pl, P.width); pl.result = L;
  for (let i = 0; i + 1 < sp.mid.length; i++) {
    const s = { A: sp.mid[i].p, B: sp.mid[i + 1].p };
    const side = st.initialSide === 0 ? segSide(s, P.cursor || P.end) < 0 : st.initialSide < 0;
    mlAddCorner(L, s.A); meanderSegment(L, s, side); mlAddCorner(L, s.B);
  }
  const lineLen = P.lineLength; let lastLength = lineLen, status = TUNED, hasMeanders = false;
  let tuned: Chain = sp.mid;
  if (lineLen > st.target.max) status = TOO_LONG;
  else { lastLength = lineLen - chLength(sp.mid); tuneLineLength(L, st.target.opt - lineLen); }
  if (status !== TOO_LONG) {
    tuned = [];
    for (const m of L.meanders) if (m.type !== MT_EMPTY) { chAppendChain(tuned, m.line); hasMeanders = hasMeanders || isMeanderType(m.type); }
    lastLength += chLength(tuned);
    status = lastLength > st.target.max ? TOO_LONG : lastLength < st.target.min ? TOO_SHORT : TUNED;
  }
  const fin: Chain = [];
  if (st.keepEndpoints) { chAppendChain(fin, chSimplify(sp.pre)); chAppendChain(fin, chSimplify(tuned)); chAppendChain(fin, chSimplify(sp.post)); }
  else { chAppendChain(fin, sp.pre); chAppendChain(fin, tuned); chAppendChain(fin, sp.post); }
  return { final: st.keepEndpoints ? fin : chSimplify(fin), tuned: chSimplify(tuned), status, length: lastLength, hasMeanders, settings: st, start: sp.start, end: sp.end, baseline: sp.mid };
}
