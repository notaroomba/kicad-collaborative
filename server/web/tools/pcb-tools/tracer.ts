// pcb-tools/tracer.ts — MOUSE_TRAIL_TRACER: the posture follows the mouse.
import type { Pt } from "./types";
import { segSegDist } from "./distances";
import { polyArea } from "./drc";
import { dir8, dirAngle, isDiagDir, legPts, simplifyPts } from "./walkaround";

// ---------------------------------------------------------------- MOUSE_TRAIL_TRACER: the posture follows the mouse
export function newTracer(tol: number, lastSegDir: number) {
  const t = { trail: [] as Pt[], tol, direction: lastSegDir >= 0 ? lastSegDir : 0, lastSegDir: lastSegDir >= 0 ? lastSegDir : -1, forced: false, manuallyForced: false };
  return t;
}
/** The mouse trail and the posture it settled on. */
export type Tracer = ReturnType<typeof newTracer>;
export function trailAdd(t: Tracer, p: Pt) {
  const tr = t.trail;
  if (tr.length >= 1) {
    const last = tr[tr.length - 1];
    if (tr.length - 1 > 2) {
      const lim = t.tol;
      for (let i = 0; i < tr.length - 1 - 2; i++) if (segSegDist(tr[i], tr[i + 1], last, p) <= lim) { tr.length = i + 1; break; }
    }
  }
  tr.push(p.slice());
  t.trail = simplifyPts(tr);
}
export const polyAreaAbs = (pts: Pt[]) => Math.abs(polyArea(pts));
/** MOUSE_TRAIL_TRACER::GetPosture: the direction the first segment from the trail's start takes towards p. */
export function tracerPosture(t: Tracer, p: Pt) {
  if (t.trail.length < 2 || t.manuallyForced) { if (!t.manuallyForced && t.lastSegDir >= 0) t.direction = t.lastSegDir; return t.direction; }
  const p0 = t.trail[0]; const refLength = Math.hypot(p[0] - p0[0], p[1] - p0[1]);
  const rev = t.trail.slice().reverse();
  const straight = simplifyPts(legPts(p0, p, false).concat(rev)), diag = simplifyPts(legPts(p0, p, true).concat(rev));
  const areaS = polyAreaAbs(straight), areaD = polyAreaAbs(diag);
  const IU = 1e6;   // KiCad's areas are in nm² and the ratio's +1 is one nm²
  const ratio = (areaS * IU * IU) / (areaD * IU * IU + 1);
  if (t.forced && refLength < 10 * t.tol) { t.forced = false; t.trail = [p0.slice()]; }
  let areaOk = false;
  if (!t.forced && refLength > 6 * t.tol) { if (polyAreaAbs(t.trail) > t.tol * refLength) areaOk = true; }
  const straightDir = dir8(straight[0], straight[1]), diagDir = dir8(diag[0], diag[1]);
  let nd: number;
  if (!t.forced && areaOk && ratio > 1.3 + 0.25) nd = diagDir;
  else if (!t.forced && areaOk && ratio < 1 / 1.3 - 0.25) nd = straightDir;
  else nd = isDiagDir(t.direction) ? diagDir : straightDir;
  t.direction = nd;
  if (!t.manuallyForced && t.lastSegDir >= 0) {
    if (straightDir === t.lastSegDir) t.direction = straightDir;
    else if (diagDir === t.lastSegDir) t.direction = diagDir;
    else {
      const ang = dirAngle(t.direction, t.lastSegDir); const cand = isDiagDir(t.direction) ? straightDir : diagDir;
      if (ang === 4) t.direction = cand;
      else if (ang === 3) { if (dirAngle(cand, t.lastSegDir) === 2) t.direction = cand; }
      else if (ang === 2) { if (dirAngle(cand, t.lastSegDir) === 1) t.direction = cand; }
    }
  }
  if (!t.forced && refLength > 30 * t.tol) t.forced = true;
  return t.direction;
}
/** MOUSE_TRAIL_TRACER::FlipPosture ('/'): the other posture, held until the next fix. */
export function tracerFlip(t: Tracer, currentFirstDir: number) {
  if (!t.manuallyForced && currentFirstDir >= 0) { t.direction = currentFirstDir; t.lastSegDir = -1; }   // LINE_PLACER::FlipPosture: from the line as drawn
  t.direction = (t.direction + 1) % 8;   // DIRECTION_45::Right(): one 45° step, so straight and diagonal swap
  t.forced = true; t.manuallyForced = true;
}
