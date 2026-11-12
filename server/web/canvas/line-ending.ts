// canvas/line-ending.ts — KiCad 10 line endings (common/line_ending.cpp, EDA_SHAPE::Shorten*ForEndings and
// GetEndingTangents): the (start_shape …) / (end_shape …) of graphic lines, polylines, arcs and beziers, both on
// the sheet and inside library symbols.
//   (start_shape arrow|arrow_open|circle|square [(length L)] [(width W)] [(stroke (width T) (type …))])
// The shapes are drawn at the end point, oriented along the outward tangent; the body is shortened so that a
// filled arrow's tip, or the middle of a circle / square, sits on the end point.
import { G } from "./geom";
import { isList, kid, num, str } from "./sexpr";
import type { GeomSink, Pt } from "./types";

export type EndingStyle = "arrow" | "arrow_open" | "circle" | "square";
export interface LineEnding { style: EndingStyle; length: number; width: number; strokeW: number }
const STYLES = new Set(["arrow", "arrow_open", "circle", "square"]);
/** DEFAULT_RATIO_LENGTH / DEFAULT_RATIO_WIDTH: with no size the ending is 5x the line width. */
export const DEFAULT_RATIO = 5;

/** parseLineEnding: null for (… none) or no token. */
export function readEnding(n: SNode | null | undefined, key: "start_shape" | "end_shape"): LineEnding | null {
  const e = n && kid(n, key); if (!e) return null;
  const style = str(e[1]); if (!STYLES.has(style)) return null;
  const l = kid(e, "length"), w = kid(e, "width"), s = kid(e, "stroke"), sw = s && kid(s, "width");
  return { style: style as EndingStyle, length: l ? num(l[1]) : 0, width: w ? num(w[1]) : 0, strokeW: sw ? num(sw[1]) : 0 };
}
export function readEndings(n: SNode | null | undefined): { start: LineEnding | null; end: LineEnding | null } { return { start: readEnding(n, "start_shape"), end: readEnding(n, "end_shape") }; }

/** GetEffectiveSize: [length, width]; a missing one falls back to the other, both missing to 5x the line width. */
export function effectiveSize(e: LineEnding, lineW: number): [number, number] {
  const len = e.length > 0 ? e.length : e.width > 0 ? e.width : lineW * DEFAULT_RATIO;
  const wid = e.width > 0 ? e.width : e.length > 0 ? e.length : lineW * DEFAULT_RATIO;
  return [len, wid];
}
/** GetShortenDepth: arrow L, open arrow 0, circle / square L/2; less half the ending's own stroke. */
export function shortenDepth(e: LineEnding | null, lineW: number): number {
  if (!e) return 0;
  const [len] = effectiveSize(e, lineW);
  let raw = e.style === "arrow" ? len : e.style === "arrow_open" ? 0 : len / 2;
  if (e.strokeW > 0) raw = Math.max(0, raw - e.strokeW / 2);
  return raw;
}
/** GetCurveOrientationDepth: an open arrow is oriented along the curve over its full length. */
export function curveOrientationDepth(e: LineEnding, lineW: number): number { return e.style === "arrow_open" ? effectiveSize(e, lineW)[0] : shortenDepth(e, lineW); }

/** GetShapes: the ending's outline at `p`, `dir` the unit outward tangent (from the line into the end point). */
export function endingShape(e: LineEnding, p: Pt, dir: Pt, lineW: number): Pt[] {
  const [sx, sy] = effectiveSize(e, lineW); const ux = dir[0], uy = dir[1], nx = -uy, ny = ux;
  const at = (x: number, y: number): Pt => [p[0] + x * ux + y * nx, p[1] + x * uy + y * ny];
  const hw = sy / 2, hx = sx / 2;
  switch (e.style) {
    case "arrow": return [at(0, 0), at(-sx, hw), at(-sx, -hw), at(0, 0)];
    case "arrow_open": return [at(-sx, -hw), at(0, 0), at(-sx, hw)];
    case "circle": { const out: Pt[] = []; for (let i = 0; i <= 32; i++) { const a = 2 * Math.PI * i / 32; out.push(at(hx * Math.cos(a), hw * Math.sin(a))); } return out; }
    case "square": return [at(hx, hw), at(hx, -hw), at(-hx, -hw), at(-hx, hw), at(hx, hw)];
  }
  return [];
}
/** LINE_ENDING::Draw as geometry: filled (and stroked when it has its own stroke), an open arrow stroked only. */
export function emitEnding(item: GeomSink, e: LineEnding | null, p: Pt, dir: Pt | null, lineW: number, color: string, layer: string, z: number): void {
  if (!e || !dir) return;
  const pts = endingShape(e, p, dir, lineW); if (!pts.length) return;
  if (e.style === "arrow_open") { G(item, { t: "poly", pts, close: false, w: e.strokeW > 0 ? e.strokeW : lineW, color, layer, z, cap: "round" }); return; }
  if (e.strokeW > 0) G(item, { t: "poly", pts, close: true, w: e.strokeW, color, fill: color, layer, z });
  else G(item, { t: "poly", pts, close: true, w: 0, color, fill: color, layer, z, noStroke: true });
}
const unit = (dx: number, dy: number): Pt | null => { const l = Math.hypot(dx, dy); return l > 1e-12 ? [dx / l, dy / l] : null; };

/** ShortenSegmentForEndings (2-point graphic lines): the shortened body, null when the endings eat it all. */
export function shortenSegment(a: Pt, b: Pt, start: LineEnding | null, end: LineEnding | null, lineW: number): [Pt, Pt] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len === 0) return [a, b];
  const s = shortenDepth(start, lineW), t = shortenDepth(end, lineW), tot = Math.max(0, s) + Math.max(0, t);
  if (tot <= 0) return [a, b]; if (tot >= len) return null;
  const ux = dx / len, uy = dy / len;
  return [[a[0] + ux * s, a[1] + uy * s], [b[0] - ux * t, b[1] - uy * t]];
}
/** ShortenPolyForEndings (n-point polylines): only the first and last segments are trimmed. */
export function shortenPoly(pts: Pt[], start: LineEnding | null, end: LineEnding | null, lineW: number): Pt[] | null {
  if (pts.length < 2) return pts;
  const s = shortenDepth(start, lineW), t = shortenDepth(end, lineW); if (s + t <= 0) return pts;
  const out = pts.map((p) => [p[0], p[1]] as Pt);
  const first = pts[0], second = pts[1], last = pts[pts.length - 1], pen = pts[pts.length - 2];
  const sLen = Math.hypot(second[0] - first[0], second[1] - first[1]), eLen = Math.hypot(last[0] - pen[0], last[1] - pen[1]);
  if (pts.length === 2 && sLen <= s + t) return null;
  if (s > 0) out[0] = sLen > s ? [first[0] + (second[0] - first[0]) * (s / sLen), first[1] + (second[1] - first[1]) * (s / sLen)] : [second[0], second[1]];
  if (t > 0) out[out.length - 1] = eLen > t ? [last[0] - (last[0] - pen[0]) * (t / eLen), last[1] - (last[1] - pen[1]) * (t / eLen)] : [pen[0], pen[1]];
  return out;
}
/** Outward tangents of a polyline at its two ends (POLY / SEGMENT in GetEndingTangents). */
export function polyTangents(pts: Pt[]): [Pt | null, Pt | null] {
  if (pts.length < 2) return [null, null]; const n = pts.length;
  return [unit(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), unit(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1])];
}

/** An arc as the canvas draws it: centre, radius, start / end angle and direction. */
export interface ArcGeom { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean }
/** ShortenArcForEndings; null when the endings eat the whole arc. */
export function shortenArc(a: ArcGeom, start: LineEnding | null, end: LineEnding | null, lineW: number): ArcGeom | null {
  if (a.r <= 0) return a;
  const s = Math.max(0, shortenDepth(start, lineW)), t = Math.max(0, shortenDepth(end, lineW)); if (s + t <= 0) return a;
  const sgn = a.anticlockwise ? -1 : 1;
  let sweep = sgn * (a.a1 - a.a0); while (sweep < 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  if (s + t >= a.r * sweep) return null;
  return Object.assign({}, a, { a0: a.a0 + sgn * s / a.r, a1: a.a1 - sgn * t / a.r });
}
/** GetEndingTangents for an arc: perpendicular to the radius, pointing away from the arc (unshortened). */
export function arcTangents(a: ArcGeom): [Pt, Pt] {
  const sgn = a.anticlockwise ? -1 : 1;
  const d = (ang: number): Pt => [-Math.sin(ang) * sgn, Math.cos(ang) * sgn];   // direction of travel
  const ds = d(a.a0), de = d(a.a1);
  return [[-ds[0], -ds[1]], de];
}
export const arcEnds = (a: ArcGeom): [Pt, Pt] => [[a.x + a.r * Math.cos(a.a0), a.y + a.r * Math.sin(a.a0)], [a.x + a.r * Math.cos(a.a1), a.y + a.r * Math.sin(a.a1)]];

/** The point at arc length `d` along a flattened polyline (from its start). */
function along(pts: Pt[], d: number): { p: Pt; i: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + l >= d && l > 0) { const f = (d - acc) / l; return { p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f], i }; }
    acc += l;
  }
  return { p: pts[pts.length - 1], i: pts.length - 1 };
}
const plen = (pts: Pt[]): number => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
/**
 * ShortenedBezierPolyline + the BEZIER tangents of GetEndingTangents, over the flattened curve `flat` (its control
 * points `ctrl`): the trimmed body (null when nothing is left) and the outward tangent at each end.
 */
export function bezierEndings(flat: Pt[], ctrl: Pt[], start: LineEnding | null, end: LineEnding | null, lineW: number): { body: Pt[] | null; tan: [Pt | null, Pt | null] } {
  const total = plen(flat), s = shortenDepth(start, lineW), t = shortenDepth(end, lineW);
  let body: Pt[] | null = flat;
  if ((s > 0 || t > 0) && total > 0) {
    if (s + t >= total) body = null;
    else {
      const a = along(flat, s), b = along(flat, total - t);
      body = [a.p, ...flat.slice(a.i, b.i), b.p];
    }
  }
  const P0 = flat[0], P1 = flat[flat.length - 1];
  const fbStart = (): Pt | null => unit(ctrl[0][0] - ctrl[1][0], ctrl[0][1] - ctrl[1][1]) || unit(P0[0] - flat[1][0], P0[1] - flat[1][1]);
  const fbEnd = (): Pt | null => { const c2 = ctrl[ctrl.length - 2], e = ctrl[ctrl.length - 1]; return unit(e[0] - c2[0], e[1] - c2[1]) || unit(P1[0] - flat[flat.length - 2][0], P1[1] - flat[flat.length - 2][1]); };
  let ts: Pt | null = body ? unit(P0[0] - body[0][0], P0[1] - body[0][1]) || fbStart() : fbStart();
  let te: Pt | null = body ? unit(P1[0] - body[body.length - 1][0], P1[1] - body[body.length - 1][1]) || fbEnd() : fbEnd();
  // an open arrow follows the curve over its own length
  if (start && start.style === "arrow_open" && total > 0) { const d = Math.min(curveOrientationDepth(start, lineW), total); const q = along(flat, d).p; ts = unit(P0[0] - q[0], P0[1] - q[1]) || ts; }
  if (end && end.style === "arrow_open" && total > 0) { const d = Math.min(curveOrientationDepth(end, lineW), total); const q = along(flat, total - d).p; te = unit(P1[0] - q[0], P1[1] - q[1]) || te; }
  return { body, tan: [ts, te] };
}
/** Whether a node carries any ending (a quick test before the work above). */
export const hasEndings = (n: SNode): boolean => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && (c[0] === "start_shape" || c[0] === "end_shape")) return true; } return false; };
