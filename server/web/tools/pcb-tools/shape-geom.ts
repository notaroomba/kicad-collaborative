// pcb-tools/shape-geom.ts — the geometry notebook of DIALOG_SHAPE_PROPERTIES (dialog_shape_properties.cpp's
// GEOM_SYNCERs): each shape's pages (rectangle by corners / corner and size / center and size, line by endpoints /
// length and angle / start and midpoint, arc by center-start-angle / start-mid-end / center-radius-angles, circle by
// center-radius / center-point, Bezier control points), what each page shows for a geometry, and the geometry a
// page's values make.  Angles are degrees in KiCad's convention (EDA_ANGLE of a vector, Y down).
import type { Pt } from "./types";
import { K } from "./state";

export type ShapeGeom =
  | { kind: "rect"; start: Pt; end: Pt }
  | { kind: "line"; start: Pt; end: Pt }
  | { kind: "arc"; start: Pt; mid: Pt; end: Pt }
  | { kind: "circle"; center: Pt; end: Pt }
  | { kind: "bezier"; pts: [Pt, Pt, Pt, Pt] };
export type GeomFieldKind = "x" | "y" | "len" | "angle";
/** AddXYPointToSizer (a titled X / Y pair; `size` makes it a width / height pair) or AddFieldToSizer. */
export type GeomGroup = { title: string; x: string; y: string; size?: boolean } | { title: string; field: string; kind: "len" | "angle" };
export interface GeomPage { title: string; groups: GeomGroup[]; get(g: ShapeGeom): Record<string, number>; set(v: Record<string, number>, g: ShapeGeom): ShapeGeom | null; validate?(v: Record<string, number>): string | null }

const deg = (r: number): number => (r * 180) / Math.PI, rad = (d: number): number => (d * Math.PI) / 180;
/** EDA_ANGLE( VECTOR2I ): atan2 in board coordinates, 0..360. */
const angleOf = (v: Pt): number => { let a = deg(Math.atan2(v[1], v[0])); if (a < 0) a += 360; return a; };
const norm360 = (a: number): number => { let r = a % 360; if (r < 0) r += 360; return r; };
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const P = (x: number, y: number): Pt => [r6(x), r6(y)];
function arcCenter(a: Pt, m: Pt, b: Pt): Pt | null { const c = K.arcFrom3(a, m, b) as { x: number; y: number } | null; return c ? [c.x, c.y] : null; }
/** EDA_SHAPE::CalcArcAngles / GetArcAngle: from the start radial to the end radial, (0, 360]. */
function arcAngles(g: { start: Pt; mid: Pt; end: Pt }): { c: Pt; r: number; sa: number; ea: number; sweep: number } | null {
  const c = arcCenter(g.start, g.mid, g.end); if (!c) return null;
  const sa = angleOf([g.start[0] - c[0], g.start[1] - c[1]]); let ea = angleOf([g.end[0] - c[0], g.end[1] - c[1]]);
  if (Math.abs(ea - sa) < 1e-9) ea = sa + 360; while (ea < sa) ea += 360;
  return { c, r: Math.hypot(g.start[0] - c[0], g.start[1] - c[1]), sa, ea, sweep: ea - sa };
}
const onCircle = (c: Pt, r: number, a: number): Pt => P(c[0] + r * Math.cos(rad(a)), c[1] + r * Math.sin(rad(a)));
/** SetArcGeometry from a centre, a radius, a start angle and a sweep (negative: the ends swap, SetArcAngleAndEnd). */
function arcFrom(c: Pt, r: number, sa: number, sweep: number): ShapeGeom {
  if (sweep < 0) { sa += sweep; sweep = -sweep; }
  return { kind: "arc", start: onCircle(c, r, sa), mid: onCircle(c, r, sa + sweep / 2), end: onCircle(c, r, sa + sweep) };
}
const straight = (a: Pt, m: Pt, b: Pt): boolean => Math.abs((m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0])) < 1e-12;

export function geomPages(kind: ShapeGeom["kind"]): GeomPage[] {
  switch (kind) {
    case "rect": return [
      { title: "By Corners", groups: [{ title: "Start Point", x: "sx", y: "sy" }, { title: "End Point", x: "ex", y: "ey" }],
        get: (g) => { const r = g as Extract<ShapeGeom, { kind: "rect" }>; return { sx: r.start[0], sy: r.start[1], ex: r.end[0], ey: r.end[1] }; },
        set: (v) => ({ kind: "rect", start: P(v.sx, v.sy), end: P(v.ex, v.ey) }),
        validate: (v) => (v.sx === v.ex && v.sy === v.ey ? "Rectangle cannot be zero-sized." : null) },
      { title: "By Corner and Size", groups: [{ title: "Start Point", x: "cx", y: "cy" }, { title: "Size", x: "w", y: "h", size: true }],
        get: (g) => { const r = g as Extract<ShapeGeom, { kind: "rect" }>; return { cx: r.start[0], cy: r.start[1], w: Math.abs(r.end[0] - r.start[0]), h: Math.abs(r.end[1] - r.start[1]) }; },
        set: (v) => ({ kind: "rect", start: P(v.cx, v.cy), end: P(v.cx + v.w, v.cy + v.h) }) },
      { title: "By Center and Size", groups: [{ title: "Center", x: "mx", y: "my" }, { title: "Size", x: "w", y: "h", size: true }],
        get: (g) => { const r = g as Extract<ShapeGeom, { kind: "rect" }>; return { mx: (r.start[0] + r.end[0]) / 2, my: (r.start[1] + r.end[1]) / 2, w: Math.abs(r.end[0] - r.start[0]), h: Math.abs(r.end[1] - r.start[1]) }; },
        set: (v) => ({ kind: "rect", start: P(v.mx - v.w / 2, v.my - v.h / 2), end: P(v.mx + v.w / 2, v.my + v.h / 2) }) }];
    case "line": return [
      { title: "By Endpoints", groups: [{ title: "Start Point", x: "sx", y: "sy" }, { title: "End Point", x: "ex", y: "ey" }],
        get: (g) => { const l = g as Extract<ShapeGeom, { kind: "line" }>; return { sx: l.start[0], sy: l.start[1], ex: l.end[0], ey: l.end[1] }; },
        set: (v) => ({ kind: "line", start: P(v.sx, v.sy), end: P(v.ex, v.ey) }) },
      { title: "By Length and Angle", groups: [{ title: "Start Point", x: "px", y: "py" }, { title: "Length", field: "len", kind: "len" }, { title: "Angle", field: "ang", kind: "angle" }],
        // updatePolar: the angle is -EDA_ANGLE( end - start ), counter-clockwise on screen
        get: (g) => { const l = g as Extract<ShapeGeom, { kind: "line" }>; const d: Pt = [l.end[0] - l.start[0], l.end[1] - l.start[1]]; let a = -deg(Math.atan2(d[1], d[0])); if (a <= -180) a += 360; if (a > 180) a -= 360; return { px: l.start[0], py: l.start[1], len: Math.hypot(d[0], d[1]), ang: r6(a) }; },
        set: (v) => ({ kind: "line", start: P(v.px, v.py), end: P(v.px + v.len * Math.cos(rad(v.ang)), v.py - v.len * Math.sin(rad(v.ang))) }) },
      { title: "By Start/Midpoint", groups: [{ title: "Start Point", x: "qx", y: "qy" }, { title: "Mid Point", x: "mx", y: "my" }],
        get: (g) => { const l = g as Extract<ShapeGeom, { kind: "line" }>; return { qx: l.start[0], qy: l.start[1], mx: (l.start[0] + l.end[0]) / 2, my: (l.start[1] + l.end[1]) / 2 }; },
        set: (v) => ({ kind: "line", start: P(v.qx, v.qy), end: P(2 * v.mx - v.qx, 2 * v.my - v.qy) }) }];
    case "arc": return [
      { title: "By Center/Start/Angle", groups: [{ title: "Center", x: "cx", y: "cy" }, { title: "Start Point", x: "sx", y: "sy" }, { title: "Included Angle", field: "ang", kind: "angle" }],
        get: (g) => { const a = arcAngles(g as Extract<ShapeGeom, { kind: "arc" }>), s = (g as Extract<ShapeGeom, { kind: "arc" }>).start; return a ? { cx: a.c[0], cy: a.c[1], sx: s[0], sy: s[1], ang: r6(a.sweep) } : { cx: 0, cy: 0, sx: s[0], sy: s[1], ang: 0 }; },
        set: (v) => { const r = Math.hypot(v.sx - v.cx, v.sy - v.cy); if (!(r > 0) || !v.ang) return null; return arcFrom([v.cx, v.cy], r, angleOf([v.sx - v.cx, v.sy - v.cy]), v.ang); },
        validate: (v) => (!v.ang ? "Arc angle must be greater than 0" : null) },
      { title: "By Start/Mid/End", groups: [{ title: "Start Point", x: "sx2", y: "sy2" }, { title: "Mid Point", x: "mx", y: "my" }, { title: "End Point", x: "ex", y: "ey" }],
        get: (g) => { const a = g as Extract<ShapeGeom, { kind: "arc" }>; return { sx2: a.start[0], sy2: a.start[1], mx: a.mid[0], my: a.mid[1], ex: a.end[0], ey: a.end[1] }; },
        // collinear typed points have no arc: the previous geometry stays
        set: (v) => { const s = P(v.sx2, v.sy2), m = P(v.mx, v.my), e = P(v.ex, v.ey); return straight(s, m, e) ? null : { kind: "arc", start: s, mid: m, end: e }; },
        validate: (v) => ((v.sx2 === v.mx && v.sy2 === v.my) || (v.mx === v.ex && v.my === v.ey) ? "Arc must have at least 2 distinct points" : null) },
      { title: "By Center/Radius/Angles", groups: [{ title: "Center", x: "rcx", y: "rcy" }, { title: "Radius", field: "rad", kind: "len" }, { title: "Start Angle", field: "sa", kind: "angle" }, { title: "End Angle", field: "ea", kind: "angle" }],
        get: (g) => { const a = arcAngles(g as Extract<ShapeGeom, { kind: "arc" }>); return a ? { rcx: a.c[0], rcy: a.c[1], rad: a.r, sa: r6(norm360(a.sa)), ea: r6(norm360(a.ea)) } : { rcx: 0, rcy: 0, rad: 0, sa: 0, ea: 0 }; },
        set: (v) => { if (!(v.rad > 0)) return null; let sweep = norm360(v.ea - v.sa); if (sweep === 0) sweep = 360; return arcFrom([v.rcx, v.rcy], v.rad, v.sa, sweep); },
        validate: (v) => (!(v.rad > 0) ? "Radius must be greater than 0" : null) }];
    case "circle": return [
      { title: "By Center/Radius", groups: [{ title: "Center", x: "cx", y: "cy" }, { title: "Radius", field: "r", kind: "len" }],
        get: (g) => { const c = g as Extract<ShapeGeom, { kind: "circle" }>; return { cx: c.center[0], cy: c.center[1], r: Math.hypot(c.end[0] - c.center[0], c.end[1] - c.center[1]) }; },
        set: (v) => ({ kind: "circle", center: P(v.cx, v.cy), end: P(v.cx + v.r, v.cy) }),
        validate: (v) => (!(v.r > 0) ? "Radius must be greater than 0" : null) },
      { title: "By Center/Point", groups: [{ title: "Center", x: "pcx", y: "pcy" }, { title: "Point on Circle", x: "px", y: "py" }],
        get: (g) => { const c = g as Extract<ShapeGeom, { kind: "circle" }>; return { pcx: c.center[0], pcy: c.center[1], px: c.end[0], py: c.end[1] }; },
        set: (v) => ({ kind: "circle", center: P(v.pcx, v.pcy), end: P(v.px, v.py) }) }];
    case "bezier": return [
      { title: "Bezier Control Points", groups: [{ title: "Start Point", x: "sx", y: "sy" }, { title: "End Point", x: "ex", y: "ey" }, { title: "Control Point 1", x: "c1x", y: "c1y" }, { title: "Control Point 2", x: "c2x", y: "c2y" }],
        get: (g) => { const p = (g as Extract<ShapeGeom, { kind: "bezier" }>).pts; return { sx: p[0][0], sy: p[0][1], c1x: p[1][0], c1y: p[1][1], c2x: p[2][0], c2y: p[2][1], ex: p[3][0], ey: p[3][1] }; },
        set: (v) => ({ kind: "bezier", pts: [P(v.sx, v.sy), P(v.c1x, v.c1y), P(v.c2x, v.c2y), P(v.ex, v.ey)] }) }];
  }
}

/** A board shape node's geometry (gr_rect / gr_line / gr_arc / gr_circle / gr_curve); null for a polygon. */
export function shapeGeomOf(n: SNode): ShapeGeom | null {
  const p = (k: string): Pt => { const c = K.kid(n, k); return c ? [K.num(c[1]), K.num(c[2])] : [0, 0]; };
  switch (String(n[0]).replace(/^(gr|fp)_/, "")) {
    case "rect": return { kind: "rect", start: p("start"), end: p("end") };
    case "line": return { kind: "line", start: p("start"), end: p("end") };
    case "arc": return { kind: "arc", start: p("start"), mid: p("mid"), end: p("end") };
    case "circle": return { kind: "circle", center: p("center"), end: p("end") };
    case "curve": { const pts = K.ptsOf(n) as Pt[]; return pts.length === 4 ? { kind: "bezier", pts: [pts[0], pts[1], pts[2], pts[3]] } : null; }
  }
  return null;
}
/** Write a geometry back into the node's points, in place (EDA_SHAPE keeps an arc's winding: start to end clockwise on screen). */
export function setShapeGeom(n: SNode, g: ShapeGeom): void {
  const set = (k: string, v: Pt): void => { const c = K.kid(n, k); if (c) { c[1] = r6(v[0]); c[2] = r6(v[1]); } };
  if (g.kind === "rect" || g.kind === "line") { set("start", g.start); set("end", g.end); }
  else if (g.kind === "circle") { set("center", g.center); set("end", g.end); }
  else if (g.kind === "arc") {
    let { start, end } = g; const m = g.mid;
    if ((m[0] - start[0]) * (end[1] - m[1]) - (m[1] - start[1]) * (end[0] - m[0]) < 0) [start, end] = [end, start];
    set("start", start); set("mid", m); set("end", end);
  } else {
    const pts = K.kid(n, "pts"); if (!pts) return;
    const xy = pts.filter((c) => Array.isArray(c) && c[0] === "xy") as SNode[];
    g.pts.forEach((p, i) => { if (xy[i]) { xy[i][1] = r6(p[0]); xy[i][2] = r6(p[1]); } });
  }
}
