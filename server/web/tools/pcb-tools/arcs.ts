// pcb-tools/arcs.ts — arc drawing: ARC_DRAW_MODE, ARC_GEOM_MANAGER and ARC_MODE_SESSION.
import type { Arc3, DrawState, PcbCtx, Pt } from "./types";
import { dimensionLabel, textNextToCursor } from "./assistants";
import { addedChange } from "./changes";
import { angleSnapMode, withStroke } from "./draw-modes";
import { applySelection } from "./groups";
import { arcNode } from "./nodes";
import { line, ring } from "./overlay";
import { lsGet, lsSet } from "./router-settings";
import { K, S } from "./state";
import { norm360, vadd, vmul, vsub } from "./util";

// ---------------------------------------------------------------- arcs: ARC_DRAW_MODE, ARC_GEOM_MANAGER, ARC_MODE_SESSION
// include/tool/arc_draw_mode.h: the five ways Draw Arcs builds an arc, in the order Cycle Arc Drawing Mode (Alt+/) walks;
// the mode is an application setting (APP_SETTINGS_BASE::m_ArcDrawMode), so it is remembered between sessions.
export const ARC_CENTER_START_END = 0, ARC_START_END_MID = 1, ARC_START_END_CENTER = 2, ARC_TANGENT = 3, ARC_START_DIR_END = 4;
export const ARC_MODE_ACTIONS = ["drawArcCenter", "drawArcStartEndMid", "drawArcStartEndCenter", "drawArcTangent", "drawArcStartDirEnd"];
export const ARC_MODE_KEY = "kc.pcb.arcDrawMode";
export function arcDrawMode() {
  if (S.arcMode == null) { const v = lsGet(ARC_MODE_KEY); S.arcMode = v !== null && /^[0-4]$/.test(v) ? +v : ARC_CENTER_START_END; }
  return S.arcMode;
}
/** PCB_BASE_FRAME::SelectToolbarAction( DrawArcForMode ): the Arc toolbar group shows the mode's button. */
export function showArcMode(ctx: PcbCtx) { if (ctx && ctx.setGroupCurrent) ctx.setGroupCurrent("Arc", ARC_MODE_ACTIONS[arcDrawMode()]); }
export function setArcDrawMode(m: number) { S.arcMode = m; lsSet(ARC_MODE_KEY, String(m)); }

// libs/kimath/src/geometry/arc_construction.cpp, in internal units (nm) so the same points round the same way
export const NM = 1e6;
export const toNm = (p: Pt): Pt => [Math.round(p[0] * NM), Math.round(p[1] * NM)];
export const fromNm = (p: Pt): Pt => [p[0] / NM, p[1] / NM];
export const kiRound = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));   // KiROUND: halves away from zero
export const crossZ = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
/** One arc construction's solution (start / mid / end / center in nm), or none. */
export type ArcSol = { valid: false } | { valid: true; start: Pt; end: Pt; mid: Pt; center: Pt; radius: number };
export const NO_ARC: ArcSol = Object.freeze({ valid: false as const });
export function arcOnChord(s: Pt, e: Pt, side: number, centerT: number, radius: number): ArcSol {
  const cx = e[0] - s[0], cy = e[1] - s[1], len = Math.hypot(cx, cy);
  if (len <= 0 || !isFinite(radius) || radius <= 0) return NO_ARC;
  const n = [-cy / len, cx / len], m = [(s[0] + e[0]) * 0.5, (s[1] + e[1]) * 0.5], half = len * 0.5, off = Math.abs(centerT);
  // radius - offset cancels for shallow arcs, so use the equivalent half^2 / ( radius + offset )
  const height = side * centerT <= 0 ? half * half / (radius + off) : radius + off;
  const mx = m[0] + n[0] * side * height, my = m[1] + n[1] * side * height;
  if (!isFinite(mx) || !isFinite(my) || Math.abs(mx) > 2147483646 || Math.abs(my) > 2147483646) return NO_ARC;
  const mid = [kiRound(mx), kiRound(my)];
  if (crossZ(cx, cy, mid[0] - s[0], mid[1] - s[1]) === 0) return NO_ARC;   // an apex on the chord is no arc
  return { valid: true as const, start: s.slice(), end: e.slice(), mid, center: [m[0] + n[0] * centerT, m[1] + n[1] * centerT], radius };
}
export function projectToChordBisector(s: Pt, e: Pt, cur: Pt) {
  const cx = e[0] - s[0], cy = e[1] - s[1], len = Math.hypot(cx, cy); if (len <= 0) return cur.slice();
  const n = [-cy / len, cx / len], m = [(s[0] + e[0]) * 0.5, (s[1] + e[1]) * 0.5];
  const t = (cur[0] - m[0]) * n[0] + (cur[1] - m[1]) * n[1];
  return [kiRound(m[0] + n[0] * t), kiRound(m[1] + n[1] * t)];
}
export function arcThroughPoints(s: Pt, on: Pt, e: Pt) {
  const b = [e[0] - s[0], e[1] - s[1]], c = [on[0] - s[0], on[1] - s[1]], d = crossZ(b[0], b[1], c[0], c[1]);
  if (d === 0) return NO_ARC;
  const bb = b[0] * b[0] + b[1] * b[1], cc = c[0] * c[0] + c[1] * c[1];
  const rel = [(c[1] * bb - b[1] * cc) / (2 * d), (b[0] * cc - c[0] * bb) / (2 * d)];
  const len = Math.hypot(b[0], b[1]);
  const centerT = (-rel[0] * b[1] + rel[1] * b[0]) / len;
  return arcOnChord(s, e, d > 0 ? 1 : -1, centerT, Math.hypot(rel[0], rel[1]));
}
export function arcFromStartEndMidDrag(s: Pt, e: Pt, cur: Pt): ArcSol {
  const p = projectToChordBisector(s, e, cur); const sol = arcThroughPoints(s, p, e);
  return sol.valid ? Object.assign({}, sol, { mid: p }) : sol;
}
export function arcFromStartEndCenterDrag(s: Pt, e: Pt, cur: Pt, major: boolean) {
  const cx = e[0] - s[0], cy = e[1] - s[1], len = Math.hypot(cx, cy); if (len <= 0) return NO_ARC;
  const n = [-cy / len, cx / len], m = [(s[0] + e[0]) * 0.5, (s[1] + e[1]) * 0.5];
  const centerT = (cur[0] - m[0]) * n[0] + (cur[1] - m[1]) * n[1];
  let side = centerT < 0 ? -1 : 1; if (!major) side = -side;   // the minor arc bulges away from the center
  return arcOnChord(s, e, side, centerT, Math.hypot(len * 0.5, centerT));
}
export function arcFromStartTangentEnd(s: Pt, tan: Pt, e: Pt) {
  const tl = Math.hypot(tan[0], tan[1]); if (!(tl > 0) || !isFinite(tl)) return NO_ARC;
  const t = [tan[0] / tl, tan[1] / tl], d = [e[0] - s[0], e[1] - s[1]], dd = d[0] * d[0] + d[1] * d[1], cross = crossZ(d[0], d[1], t[0], t[1]);
  if (dd <= 0 || cross === 0) return NO_ARC;
  const k = -dd / (2 * cross), n = [-t[1], t[0]], len = Math.sqrt(dd), cn = [-d[1] / len, d[0] / len];
  return arcOnChord(s, e, cross > 0 ? 1 : -1, k * (n[0] * cn[0] + n[1] * cn[1]), Math.abs(k));
}

export const degOf = (v: Pt) => { let a = Math.atan2(v[1], v[0]) * 180 / Math.PI; if (Math.abs(a) < 1e-12) a = 0; return a; };   // EDA_ANGLE( VECTOR2 )
/** common/preview_items/arc_geom_manager.cpp over MULTISTEP_GEOM_MANAGER: the construction of one arc, point by point. */
export class ArcGeom {
  declare mode: number; declare step: number; declare last: Pt; declare changed: boolean;
  declare cw: boolean; declare locked: boolean; declare snap: boolean; declare origin: Pt; declare radius: number; declare sa: number; declare ea: number;
  declare pts: Pt[]; declare dir: Pt; declare hasSeed: boolean; declare seedAxis: boolean; declare axisFlipped: boolean; declare axis: Pt;
  declare major: boolean; declare sol: ArcSol;
  constructor(mode: number) { this.mode = mode; this.reset(); }
  reset() {   // ARC_GEOM_MANAGER::Reset (the mode stays)
    this.step = 0; this.last = [0, 0]; this.changed = true;
    this.cw = true; this.locked = false; this.snap = false; this.origin = [0, 0]; this.radius = 0; this.sa = 0; this.ea = 0;
    this.pts = [[0, 0], [0, 0], [0, 0]]; this.dir = [0, 0]; this.hasSeed = false; this.seedAxis = false; this.axisFlipped = false; this.axis = [0, 0];
    this.major = false; this.sol = NO_ARC;
  }
  hasTangentSeed() { return this.mode === ARC_TANGENT && this.hasSeed; }
  maxStep() { return this.hasTangentSeed() ? 1 : 3; }
  isReset() { return this.step === 0; }
  isComplete() { return this.step === this.maxStep(); }
  getStep() { return this.isComplete() ? 3 : this.step; }
  hasPreview() { return !this.isReset() || this.hasTangentSeed(); }
  usesExact() { return this.mode !== ARC_CENTER_START_END; }
  usesDirectionClick() { return this.mode === ARC_START_DIR_END || (this.mode === ARC_TANGENT && !this.hasSeed); }
  pointIndex() { return this.step + (this.hasTangentSeed() ? 1 : 0); }
  addPoint(p: Pt, lockIn: boolean) {
    this.last = p.slice(); const ok = this.accept(p);
    if (lockIn && (ok || this.mode === ARC_CENTER_START_END)) this.performStep(ok);   // rejectRegresses: only the center mode steps back
    this.changed = true;
  }
  removeLastPoint() { this.performStep(false); this.accept(this.last); this.changed = true; }
  performStep(fwd: boolean) { this.step = Math.max(0, Math.min(this.maxStep(), this.step + (fwd ? 1 : -1))); }
  accept(p: Pt) {
    if (this.mode !== ARC_CENTER_START_END) return this.acceptExact(p);
    switch (this.step) { case 0: return this.setOrigin(p); case 1: return this.setStart(p); case 2: return this.setEnd(p); default: return false; }
  }
  acceptExact(p: Pt) {
    if (this.isComplete()) return false;
    const i = this.pointIndex(); this.pts[i] = p.slice();
    if (i < 2 && !this.hasTangentSeed()) {   // the points before the last only draw guides
      this.clearSolution(); if (i === 0) return true;
      return this.usesDirectionClick() ? this.setDirection(p) : (p[0] !== this.pts[0][0] || p[1] !== this.pts[0][1]);
    }
    if (this.hasTangentSeed() && this.seedAxis) {   // the nearer way along the axis gives a sweep up to a half turn
      const ch = [p[0] - this.pts[0][0], p[1] - this.pts[0][1]];
      const sign = ((ch[0] * this.axis[0] + ch[1] * this.axis[1] >= 0) !== this.axisFlipped) ? 1 : -1;
      this.dir = [this.axis[0] * sign, this.axis[1] * sign];
    }
    let sol: ArcSol = NO_ARC;
    if (this.mode === ARC_START_END_MID) sol = arcFromStartEndMidDrag(this.pts[0], this.pts[1], p);
    else if (this.mode === ARC_START_END_CENTER) sol = arcFromStartEndCenterDrag(this.pts[0], this.pts[1], p, this.major);
    else sol = arcFromStartTangentEnd(this.pts[0], this.dir, p);
    if (sol.valid) this.applySolution(sol);
    return sol.valid;
  }
  applySolution(sol: Extract<ArcSol, { valid: true }>) {
    this.sol = sol; const c = sol.center;
    const s = [sol.start[0] - c[0], sol.start[1] - c[1]], e = [sol.end[0] - c[0], sol.end[1] - c[1]], m = [sol.mid[0] - c[0], sol.mid[1] - c[1]];
    this.origin = [kiRound(c[0]), kiRound(c[1])]; this.radius = sol.radius;
    this.sa = norm360(degOf(s)); this.ea = norm360(degOf(e));
    this.cw = crossZ(s[0], s[1], m[0], m[1]) < 0;
  }
  clearSolution() { this.sol = NO_ARC; this.origin = [0, 0]; this.radius = 0; this.sa = 0; this.ea = 0; this.cw = true; }
  setDirection(p: Pt) {
    const v = [p[0] - this.pts[0][0], p[1] - this.pts[0][1]], len = Math.hypot(v[0], v[1]); if (len === 0) return false;
    this.dir = v;
    if (this.snap) { const d = Math.SQRT1_2, units = [[1, 0], [d, d], [0, 1], [-d, d], [-1, 0], [-d, -d], [0, -1], [d, -d]];
      const oct = ((kiRound(degOf(v) / 45) % 8) + 8) % 8; this.dir = [units[oct][0] * len, units[oct][1] * len]; }
    return true;
  }
  setMode(m: number) {
    if (m === this.mode) return;
    if (this.isReset()) { this.mode = m; this.clearSolution(); this.changed = true; return; }   // nothing locked: a seed stays
    // only the first point of a start-first mode carries over, and only into another start-first mode
    const keep = this.mode !== ARC_CENTER_START_END && m !== ARC_CENTER_START_END;
    const start = this.pts[0].slice(), cursor = this.last.slice(), snap = this.snap;
    this.mode = m; this.reset();
    if (!keep) return;
    this.snap = snap; this.addPoint(start, true); this.addPoint(cursor, false);
  }
  setTangentSeed(start: Pt, dir: Pt, isAxis: boolean) {
    if (!this.isReset() || (dir[0] === 0 && dir[1] === 0)) return;
    this.pts[0] = start.slice(); this.dir = dir.slice(); this.axis = dir.slice(); this.seedAxis = !!isAxis; this.axisFlipped = false; this.hasSeed = true;
    this.clearSolution(); this.changed = true;
  }
  /** Switch Arc Posture (/): the center mode's direction, the start-end-center mode's major / minor arc, a tangent seed's side of its axis. */
  toggleClockwise() {
    if (this.mode === ARC_CENTER_START_END) { this.cw = !this.cw; this.locked = true; this.changed = true; }
    else if (this.mode === ARC_START_END_CENTER) { this.major = !this.major; if (this.step === 2) this.accept(this.last); this.changed = true; }
    else if (this.mode === ARC_TANGENT && this.hasTangentSeed() && this.seedAxis) { this.axisFlipped = !this.axisFlipped; this.accept(this.last); this.changed = true; }
  }
  getOrigin() { return this.usesExact() && !this.sol.valid ? this.pts[0] : this.origin; }
  startRadiusEnd() {
    if (this.usesExact()) return this.pts[0];
    const r = Math.trunc(this.radius), a = this.sa * Math.PI / 180;
    return [this.origin[0] + kiRound(r * Math.cos(a)), this.origin[1] + kiRound(r * Math.sin(a))];
  }
  endRadiusEnd() {
    if (this.usesExact()) return this.sol.valid ? this.sol.end : this.pts[0];
    const r = Math.trunc(this.radius), a = this.ea * Math.PI / 180;
    return [this.origin[0] + kiRound(r * Math.cos(a)), this.origin[1] + kiRound(r * Math.sin(a))];
  }
  startAngle() { let a = this.sa; if (this.cw) a -= 360; return -a; }
  subtended() { let a = this.ea - this.sa; if (this.ea <= this.sa) a += 360; if (this.cw) a -= 360; return -a; }
  setOrigin(p: Pt) { this.origin = p.slice(); this.sa = 0; this.ea = 0; return true; }
  setStart(p: Pt) {
    const v = [p[0] - this.origin[0], p[1] - this.origin[1]]; this.radius = Math.hypot(v[0], v[1]);
    this.sa = degOf(v); if (this.snap) this.sa = 45 * kiRound(this.sa / 45);
    while (this.sa < 0) this.sa += 360;
    this.ea = this.sa; return this.radius !== 0;
  }
  setEnd(p: Pt) {
    const v = [p[0] - this.origin[0], p[1] - this.origin[1]];
    this.ea = degOf(v); if (this.snap) this.ea = 45 * kiRound(this.ea / 45);
    while (this.ea < 0) this.ea += 360;
    if (!this.locked) {
      let ccw = this.ea - this.sa; if (this.ea <= this.sa) ccw += 360;
      const cw = Math.abs(ccw - 360);
      if (Math.min(ccw, cw) >= 90) this.locked = true; else this.cw = cw < ccw;
    } else if (Math.abs(this.subtended()) < 90) this.locked = false;
    return this.ea !== this.sa;
  }
  /** ARC_DRAW_BEHAVIOR::ApplyToShape as start / mid / end in nm, or null while there is no arc yet. */
  shape(): { start: Pt; mid: Pt; end: Pt; center: Pt } | null {
    if (this.usesExact()) return this.sol.valid ? { start: this.sol.start, mid: this.sol.mid, end: this.sol.end, center: this.sol.center } : null;
    if (this.step < 2 || !this.radius) return null;
    const sub = this.subtended(); if (!sub) return null;
    const [s, e] = sub < 0 ? [this.startRadiusEnd(), this.endRadiusEnd()] : [this.endRadiusEnd(), this.startRadiusEnd()];
    // EDA_SHAPE: from start to end the polar angle grows (clockwise on the board); the mid is halfway along
    const c = this.origin, a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let sweep = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const r = Math.hypot(s[0] - c[0], s[1] - c[1]), am = a0 + sweep / 2;
    return { start: s, mid: [kiRound(c[0] + r * Math.cos(am)), kiRound(c[1] + r * Math.sin(am))], end: e, center: c };
  }
}

// common/tool/arc_tangent_seed.cpp: where a tangent arc starts and which way it leaves, from a graphic on the layer
export const unitOf = (v: Pt): Pt | null => { const l = Math.hypot(v[0], v[1]); return l === 0 ? null : [v[0] / l, v[1] / l]; };
export const perp = (v: Pt): Pt => [-v[1], v[0]];   // VECTOR2::Perpendicular
export function nearestEnd(a: Pt, b: Pt, p: Pt, tol?: number) {
  const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
  const first = da <= db; if (tol !== undefined && (first ? da : db) > tol) return null;
  return first ? a : b;
}
/** The graphic as nm geometry the seed functions read: segment / arc / bezier / poly. */
/** A graphic's geometry in nm, as the tangent seed reads it. */
export type SeedShape = { t: "seg"; start: Pt; end: Pt } | { t: "arc"; start: Pt; mid: Pt; end: Pt; center: Pt } | { t: "bez"; start: Pt; c1: Pt; c2: Pt; end: Pt } | { t: "poly"; pts: Pt[] };
/** Where a tangent arc starts and which way it leaves (axis: either way along it). */
export interface ArcSeed { start: Pt; dir: Pt; axis: boolean }
export function seedShapeOf(it: KItem): SeedShape | null {
  // a graphic of these kinds carries its points (a missing one fails as it always has)
  const n = it.node, pt = (k: string) => { const c = K.kid(n, k); return (c ? toNm([+c[1], +c[2]]) : null) as Pt; };
  if (it.kind === "gr_line") return { t: "seg", start: pt("start"), end: pt("end") };
  if (it.kind === "gr_arc") { const s = pt("start"), m = pt("mid"), e = pt("end"); const a = K.arcFrom3(fromNm(s), fromNm(m), fromNm(e)); return a ? { t: "arc", start: s, mid: m, end: e, center: toNm([a.x, a.y]) } : null; }
  if (it.kind === "gr_curve") { const ps = K.kids(K.kid(n, "pts") || [], "xy").map((c) => toNm([+c[1], +c[2]])); return ps.length === 4 ? { t: "bez", start: ps[0], c1: ps[1], c2: ps[2], end: ps[3] } : null; }
  if (it.kind === "gr_poly") { const ps = K.kids(K.kid(n, "pts") || [], "xy").map((c) => toNm([+c[1], +c[2]])); return ps.length > 1 ? { t: "poly", pts: ps } : null; }
  return null;
}
export function tangentAtEndpoint(sh: Exclude<SeedShape, { t: "poly" }>, p: Pt) {
  const atStart = p[0] === sh.start[0] && p[1] === sh.start[1];
  if (!atStart && (p[0] !== sh.end[0] || p[1] !== sh.end[1])) return null;
  if (sh.t === "seg") return unitOf(atStart ? vsub(sh.start, sh.end) : vsub(sh.end, sh.start));
  if (sh.t !== "arc") return null;
  const turn = crossZ(sh.mid[0] - sh.start[0], sh.mid[1] - sh.start[1], sh.end[0] - sh.mid[0], sh.end[1] - sh.mid[1]);
  if (turn === 0) return null;
  let t = perp(vsub(p, sh.center)); if ((turn > 0) === atStart) t = [-t[0], -t[1]];
  return unitOf(t);
}
export function arcTangentSeedNear(sh: Extract<SeedShape, { t: "arc" }>, near: Pt): ArcSeed | null {
  const end = nearestEnd(sh.start, sh.end, near)!; const d = tangentAtEndpoint(sh, end);
  return d ? { start: end.slice(), dir: d, axis: false } : null;
}
export function segDist(a: Pt, b: Pt, p: Pt) { const v = vsub(b, a), L = v[0] * v[0] + v[1] * v[1]; let t = L ? ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / L : 0; t = Math.max(0, Math.min(1, t)); const q = [a[0] + v[0] * t, a[1] + v[1] * t]; return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q: [kiRound(q[0]), kiRound(q[1])] }; }
export function polylineSeedAt(vs: Pt[], closed: boolean, p: Pt, tol: number): ArcSeed | null {
  const n = vs.length; if (n < 2) return null;
  if (!closed) {
    const end = nearestEnd(vs[0], vs[n - 1], p, tol);
    if (end) { const inner = end === vs[0] ? vs[1] : vs[n - 2]; const d = unitOf(vsub(end, inner)); return d ? { start: end.slice(), dir: d, axis: false } : null; }
  }
  let best: { a: Pt; b: Pt; q: Pt } | null = null, bestD = tol;
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = vs[i], b = vs[(i + 1) % n], r = segDist(a, b, p); if (r.d <= bestD) { best = { a, b, q: r.q }; bestD = r.d; } }
  if (!best) return null;
  const ax = unitOf(vsub(best.b, best.a)); return ax ? { start: best.q, dir: ax, axis: true } : null;
}
export function arcTangentSeedAt(sh: SeedShape, p: Pt, tol: number): ArcSeed | null {
  if (sh.t === "seg") return polylineSeedAt([sh.start, sh.end], false, p, tol);
  if (sh.t === "bez") {
    const ctrl = [sh.start, sh.c1, sh.c2, sh.end];
    const xs = ctrl.map((c) => c[0]), ys = ctrl.map((c) => c[1]);
    if (p[0] < Math.min(...xs) - tol || p[0] > Math.max(...xs) + tol || p[1] < Math.min(...ys) - tol || p[1] > Math.max(...ys) + tol) return null;
    const poly = K.bezierPts(ctrl.map(fromNm)).map(toNm);
    poly[0] = sh.start.slice(); poly[poly.length - 1] = sh.end.slice();
    const seed = polylineSeedAt(poly, false, p, tol);
    if (seed && !seed.axis) {   // at an end the control polygon gives the exact tangent
      const atStart = seed.start[0] === sh.start[0] && seed.start[1] === sh.start[1];
      const end = atStart ? sh.start : sh.end, others = atStart ? [sh.c1, sh.c2, sh.end] : [sh.c2, sh.c1, sh.start];
      for (const c of others) { const d = unitOf(vsub(end, c)); if (d) { seed.dir = d; break; } }
    }
    return seed;
  }
  if (sh.t === "arc") {
    const end = nearestEnd(sh.start, sh.end, p, tol);
    if (end) { const d = tangentAtEndpoint(sh, end); return d ? { start: end.slice(), dir: d, axis: false } : null; }
    const a = K.arcFrom3(fromNm(sh.start), fromNm(sh.mid), fromNm(sh.end)); if (!a) return null;
    // the nearest point of the arc: on the circle when its angle is inside the sweep, else an end (already ruled out)
    const c = sh.center, ang = Math.atan2(p[1] - c[1], p[0] - c[0]), r = a.r * NM;
    const q = [kiRound(c[0] + r * Math.cos(ang)), kiRound(c[1] + r * Math.sin(ang))];
    if (!arcContainsAngle(a, ang) || Math.hypot(q[0] - p[0], q[1] - p[1]) > tol) return null;
    const ax = unitOf(perp(vsub(q, c))); return ax ? { start: q, dir: ax, axis: true } : null;
  }
  if (sh.t === "poly") return polylineSeedAt(sh.pts, true, p, tol);
  return null;
}
export function arcContainsAngle(a: Arc3, ang: number) {
  // K.arcFrom3's canvas arc: from a0 to a1, anticlockwise or not (canvas angles grow clockwise on screen)
  const tw = 2 * Math.PI, nrm = (x: number) => ((x % tw) + tw) % tw;
  const sweep = a.anticlockwise ? nrm(a.a0 - a.a1) : nrm(a.a1 - a.a0), off = a.anticlockwise ? nrm(a.a0 - ang) : nrm(ang - a.a0);
  return off <= sweep + 1e-12;
}
/** DRAWING_TOOL::drawManagedShape's findTangentSeed: a graphic on the drawing layer within 5 px (ARC_SEED_PICK_PIXELS). */
export function findTangentSeed(ctx: PcbCtx, pos: Pt) {
  const tol = kiRound(5 / Math.max(1e-9, ctx.pxPerMm || 1) * NM), layer = S.gfxLayer;
  for (const it of ctx.doc.items.values()) {
    if (!/^gr_(line|arc|curve|poly)$/.test(it.kind)) continue;
    const l = K.kid(it.node, "layer"); if (!l || K.str(l[1]) !== layer) continue;
    if (it.bbox && (pos[0] / NM < it.bbox[0] - tol / NM || pos[0] / NM > it.bbox[2] + tol / NM || pos[1] / NM < it.bbox[1] - tol / NM || pos[1] / NM > it.bbox[3] + tol / NM)) continue;
    const sh = seedShapeOf(it); if (!sh) continue;
    const seed = arcTangentSeedAt(sh, pos, tol); if (seed) return seed;
  }
  return null;
}

/** A new arc on the cursor: DRAWING_TOOL::DrawArc's loop body (drawManagedShape with an ARC_MODE_SESSION). */
export function newArcDraw(chainSeed: ArcSeed | null) {
  const g = new ArcGeom(arcDrawMode());
  const d: DrawState = { shape: "garc", arc: g, chainSeeded: false, clickSeeded: false, started: false, start: [0, 0], cur: [0, 0], pts: [] };
  if (chainSeed) { g.setTangentSeed(chainSeed.start, chainSeed.dir, chainSeed.axis); d.chainSeeded = true; d.started = true; d.start = fromNm(chainSeed.start); }
  return d;
}
/** ARC_MODE_SESSION::SetMode, from a mode action or Cycle Arc Drawing Mode while the tool runs. */
export function switchArcMode(ctx: PcbCtx, m: number) {
  setArcDrawMode(m); showArcMode(ctx);
  const d = S.draw; if (d && d.shape === "garc") { d.arc!.setMode(m); d.chainSeeded = false; d.clickSeeded = false; syncArcDraw(d); }
  ctx.requestRender();
}
export function syncArcDraw(d: DrawState) { const g = d.arc!; d.pts = g.hasPreview() ? [fromNm(g.pts[0])] : []; d.start = fromNm(g.pts[0]); }
export function arcClick(ctx: PcbCtx, p: Pt) {
  let d = S.draw; if (!d || d.shape !== "garc") { d = S.draw = newArcDraw(null); }
  const g = d.arc!, pos = toNm(p);
  if (!d.started) { applySelection(ctx, []); d.started = true; }
  // ARC_MODE_SESSION::PlacePoint: in the tangent mode the first click on a graphic seeds the arc from it
  const first = !d.chainSeeded && !d.clickSeeded && g.getStep() === 0;
  if (first && g.mode === ARC_TANGENT) { const seed = findTangentSeed(ctx, pos); if (seed) { g.setTangentSeed(seed.start, seed.dir, seed.axis); d.clickSeeded = true; syncArcDraw(d); ctx.requestRender(); return; } }
  g.addPoint(pos, true); d.clickSeeded = false; d.lastClick = pos; syncArcDraw(d);
  if (g.isComplete()) commitArc(ctx, d);
  ctx.requestRender();
}
export function commitArc(ctx: PcbCtx, d: DrawState) {
  const sh = d.arc!.shape(); S.draw = null;
  if (!sh) return;
  const node = withStroke(arcNode(fromNm(sh.start), fromNm(sh.mid), fromNm(sh.end), S.gfxLayer));
  const add = addedChange(ctx.doc, node); ctx.commit([add], "Draw Arc");
  if (add.id) applySelection(ctx, [add.id]);   // the committed arc is selected (ACTIONS::selectItem)
  // the tool goes on with the next arc; in the tangent mode it leaves from the end of this one
  const committed = { t: "arc" as const, start: sh.start, mid: sh.mid, end: sh.end, center: [sh.center[0], sh.center[1]] };
  S.draw = newArcDraw(arcDrawMode() === ARC_TANGENT ? arcTangentSeedNear(committed, d.lastClick || sh.end) : null);
}
export function arcMove(d: DrawState, p: Pt, ctrl: boolean) {
  const g = d.arc!; d.cur = p.slice();
  g.snap = !ctrl && angleSnapMode() !== "free";   // SetAngleSnap( angleSnap != LEADER_MODE::DIRECT )
  if (g.hasPreview()) g.addPoint(toNm(p), false);
}
/** ARC_MODE_SESSION::RemoveLastPoint (Backspace). */
export function arcBackup(ctx: PcbCtx) {
  const d = S.draw!, g = d.arc!;
  if (d.clickSeeded) { g.reset(); d.clickSeeded = false; }
  else if (g.isReset() && !g.hasTangentSeed()) { S.draw = null; }
  else g.removeLastPoint();
  if (S.draw) syncArcDraw(d);
  ctx.requestRender();
}
/** finishInteractive (Enter): the arc drawn so far is kept and the tool ends (SHAPE_DRAW_RESULT::FINISHED). */
export function finishArc(ctx: PcbCtx, editing: () => boolean) {
  const d = S.draw!, sh = d.started ? d.arc!.shape() : null; S.draw = null;
  if (sh && editing()) { const add = addedChange(ctx.doc, withStroke(arcNode(fromNm(sh.start), fromNm(sh.mid), fromNm(sh.end), S.gfxLayer))); ctx.commit([add], "Draw Arc"); if (add.id) applySelection(ctx, [add.id]); }
  ctx.setTool("select"); ctx.requestRender();
}
/** ARC_ASSISTANT::ViewDraw: the arc's construction guides and the values next to the cursor. */
export function drawArcPreview(c: CanvasRenderingContext2D, d: DrawState, px: number, colour: string) {
  const g = d.arc!; if (!g.hasPreview()) return;
  const sh = g.shape(), mm = fromNm;
  if (sh) { const a = K.arcFrom3(mm(sh.start), mm(sh.mid), mm(sh.end)); if (a) { c.beginPath(); c.arc(a.x, a.y, a.r, a.a0, a.a1, a.anticlockwise); c.stroke(); } }
  c.save(); c.globalAlpha = 1; c.lineWidth = px; c.strokeStyle = colour;
  const guide = (a: Pt, b: Pt, dim: boolean) => { c.globalAlpha = dim ? 0.45 : 0.9; line(c, mm(a), mm(b)); };
  const dashed = (a: Pt, b: Pt) => { const v = vsub(b, a), L = Math.hypot(v[0], v[1]), lim = 400 * px * NM; const e = L > lim ? vadd(a, vmul(v, lim / L)) : b;
    c.globalAlpha = 0.9; c.setLineDash([12 * px, 6 * px]); line(c, mm(a), mm(e)); c.setLineDash([]); };
  const strs: string[] = []; let anchor = mm(g.startRadiusEnd()); const cursor = mm(g.last);
  if (g.mode === ARC_CENTER_START_END) {
    const o = g.getOrigin(); anchor = mm(o);
    guide(o, g.startRadiusEnd(), g.getStep() > 1);
    if (g.getStep() === 1) { strs.push(dimensionLabel("r", g.radius / NM)); let a = g.startAngle(); while (a < -360) a += 360; while (a >= 360) a -= 360; strs.push(dimensionLabel("θ", a, true)); }
    else { guide(o, g.endRadiusEnd(), false); guide(o, g.last, true);
      const sub = g.subtended(); let end = g.startAngle() + sub; end = ((end + 180) % 360 + 360) % 360 - 180;
      strs.push(dimensionLabel("Δθ", sub, true)); strs.push(dimensionLabel("θ", end, true)); }
  } else {
    const i = g.pointIndex(); if (i === 0) { c.restore(); return; }
    const start = g.startRadiusEnd(), sol = g.sol;
    if (g.mode === ARC_START_END_MID || g.mode === ARC_START_END_CENTER) {
      const chordEnd = i === 1 ? g.last : g.pts[1], mid = [(start[0] + chordEnd[0]) / 2, (start[1] + chordEnd[1]) / 2];
      guide(start, chordEnd, i > 1); anchor = mm(mid);
      if (i > 1 && sol.valid) {
        const marked = g.mode === ARC_START_END_MID ? sol.mid : sol.center;
        dashed(mid, marked); c.globalAlpha = 0.9; ring(c, mm(marked), 4 * px);
        if (g.mode === ARC_START_END_CENTER) { guide(marked, sol.start, true); guide(marked, sol.end, true); }
        strs.push(dimensionLabel("r", sol.radius / NM)); strs.push(dimensionLabel("s", Math.hypot(sol.mid[0] - mid[0], sol.mid[1] - mid[1]) / NM));
      }
    } else {
      const dir = g.dir, L = Math.hypot(dir[0], dir[1]);
      if (L > 0) dashed(start, vadd(start, vmul(dir, Math.max(L, 100 * px * NM) / L)));
      if (i === 1) { guide(start, g.last, true); strs.push(dimensionLabel("θ", degOf(dir), true)); }
      else if (sol.valid) { guide(start, sol.end, true); strs.push(dimensionLabel("r", sol.radius / NM)); }
    }
    if (sol.valid) strs.push(dimensionLabel("Δθ", g.subtended(), true));
  }
  c.restore();
  if (strs.length) textNextToCursor(c, cursor, vsub(anchor, cursor), strs, px, colour);
}
