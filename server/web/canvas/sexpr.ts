// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { rgba } from "./colors";
import type { Arc3, BoxRot, FillInfo, Pt, SAtom, StrokeInfo, TextEffects } from "./types";
// ---------------------------------------------------------------- s-expressions
/**
 * node -> bitmask of the slots that were quoted in the source text.  Kept beside the nodes
 * rather than on them so a node still deep-equals a plain array; serialize() reads it back.
 */
export const QUOTED = new WeakMap<SNode, number>();

export function quotedMask(node: SNode): number { return (QUOTED.get(node) as number) | 0; }

/** Deep copy of a node that keeps the quoting marks (JSON round-trips lose them). */
export function cloneNode<T extends SAtom>(node: T): T;
export function cloneNode(node: SAtom): SAtom {
  if (!isList(node)) return node;
  const out: SNode = node.map(cloneNode);
  const q = QUOTED.get(node); if (q) QUOTED.set(out, q);
  return out;
}

export function parse(text: string): SNode | null {
  let i = 0; const n = text.length;
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
  function list(): SNode {
    i++; const out: SNode = []; let q = 0;
    for (;;) {
      while (i < n && ws(text.charCodeAt(i))) i++;
      if (i >= n) break;
      const c = text[i];
      if (c === ")") { i++; break; }
      if (c === "(") out.push(list());
      // Which atoms were quoted is not decoration: KiCad's parsers demand a
      // quoted string where the format says string (a group's name, for one —
      // parseGROUP wants T_STRING and throws on a bare symbol) and a bare token
      // where the format says token.  Record the quoted slots so serialize()
      // can reproduce them instead of guessing from the text.
      else if (c === '"') { const at = out.length; if (at < 30) q |= 1 << at; out.push(quoted()); }
      else out.push(atom());
    }
    if (q) QUOTED.set(out, q);
    return out;
  }
  function quoted() {
    i++; let s = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") { const d = text[i + 1]; s += d === "n" ? "\n" : d === "t" ? "\t" : d; i += 2; continue; }
      if (c === '"') { i++; break; }
      s += c; i++;
    }
    return s;
  }
  function atom() {
    const st = i;
    while (i < n) { const c = text.charCodeAt(i); if (ws(c) || c === 40 || c === 41) break; i++; }
    const a = text.slice(st, i);
    const v = Number(a);
    return a !== "" && !isNaN(v) && /^[-+.\d]/.test(a) ? v : a;
  }
  while (i < n && ws(text.charCodeAt(i))) i++;
  return text[i] === "(" ? list() : null;
}

export function parseAll(text: string): SNode[] {
  const out: SNode[] = [];
  // cheap split on top-level parentheses: parse, then continue after the consumed prefix
  let i = 0; const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n || text[i] !== "(") break;
    let depth = 0, j = i, inStr = false;
    for (; j < n; j++) {
      const c = text[j];
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    }
    const node = parse(text.slice(i, j)); if (node) out.push(node);
    i = j;
  }
  return out;
}

export const isList = Array.isArray;

// The readers take any list (`readonly unknown[]`: the typed modules that keep their own node alias pass theirs).
export function kid(node: readonly unknown[], key: string): SNode | null { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }

export function kids(node: readonly unknown[], key: string): SNode[] { const out: SNode[] = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }

export function num(v: unknown, d = 0): number { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }

export function str(v: unknown): string { return v === undefined || v === null ? "" : String(v); }

export function has(node: readonly unknown[], tok: SAtom): boolean { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }

export function yesNo(node: SNode, key: string): boolean { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key); }

export function uuidOf(node: SNode): string {
  const u = kid(node, "uuid") || kid(node, "tstamp"); if (u) return str(u[1]);
  // A schematic rule area has no uuid of its own: saveRuleArea prints "(rule_area "
  // and hands the item to saveShape, which writes the SCH_RULE_AREA's uuid inside the
  // nested (polyline …).  Keying it by a synthetic id would make every op for it miss.
  if (node[0] === "rule_area") { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c)) { const nested = kid(c, "uuid"); if (nested) return str(nested[1]); } } }
  return "";
}

export function atOf(node: readonly unknown[]): [number, number, number] {
  const t = kid(node, "transform");
  if (t) { const tr = kid(t, "translate"), ro = kid(t, "rotate"); return [tr ? num(tr[1]) : 0, tr ? num(tr[2]) : 0, ro ? num(ro[1]) : 0]; }
  const a = kid(node, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0];
}

export function ptsOf(node: SNode): [number, number][] { const p = kid(node, "pts"); return p ? kids(p, "xy").map((x): [number, number] => [num(x[1]), num(x[2])]) : []; }

/** The outline a (pts …) list draws: its points, with a side that is an arc flattened (ptsOf keeps to the stored vertices). */
export function polyPtsOf(node: SNode): Pt[] {
  const p = kid(node, "pts"); if (!p) return [];
  const out: Pt[] = [];
  for (let i = 1; i < p.length; i++) {
    const c = p[i]; if (!isList(c)) continue;
    if (c[0] === "xy") out.push([num(c[1]), num(c[2])]);
    else if (c[0] === "arc") {
      // a polygon side that is an arc (SHAPE_LINE_CHAIN with arcs): flattened to chords 5 µm off the arc at most
      const s = kid(c, "start"), m = kid(c, "mid"), e = kid(c, "end"); if (!s || !m || !e) continue;
      const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
      if (!a) { out.push([num(s[1]), num(s[2])], [num(e[1]), num(e[2])]); continue; }
      const TAU = 2 * Math.PI; let sweep = a.anticlockwise ? a.a0 - a.a1 : a.a1 - a.a0; sweep = ((sweep % TAU) + TAU) % TAU;
      const step = a.r > 0.005 ? 2 * Math.acos(1 - 0.005 / a.r) : Math.PI / 2, n = Math.max(2, Math.ceil(sweep / step));
      out.push([num(s[1]), num(s[2])]);
      for (let k = 1; k < n; k++) { const t = a.a0 + (a.anticlockwise ? -1 : 1) * sweep * k / n; out.push([a.x + a.r * Math.cos(t), a.y + a.r * Math.sin(t)]); }
      out.push([num(e[1]), num(e[2])]);
    }
  }
  return out;
}

export function widthOf(node: SNode, def: number): number {
  const s = kid(node, "stroke"); const w = s && kid(s, "width"); if (w) return num(w[1], def);
  const w2 = kid(node, "width"); return w2 ? num(w2[1], def) : def;
}

export function colorOf(node: SNode): string | null {
  // (color r g b a) child with a > 0, as a CSS colour; null when unspecified
  const c = kid(node, "color"); if (!c) return null; const a = num(c[4], 1); if (a <= 0) return null;
  return rgba(num(c[1]), num(c[2]), num(c[3]), a);
}

export function strokeColorOf(node: SNode): string | null { const s = kid(node, "stroke"); return s ? colorOf(s) : null; }

/** (stroke (width w) (type t) (color …)) → {w, color, dash, type}; w = def when unspecified; type = dash|dot|dash_dot|dash_dot_dot or null */
export function strokeOf(node: SNode | null | undefined, def: number): StrokeInfo {
  const s = node && kid(node, "stroke"); if (!s) return { w: def, color: null, dash: false, type: null };
  const wN = kid(s, "width"), tN = kid(s, "type"); const type = tN ? str(tN[1]) : "default";
  const dash = type !== "default" && type !== "solid";
  return { w: wN ? num(wN[1], def) : def, color: colorOf(s), dash, type: dash ? type : null };
}

/** {dash: true, dashType} for a node whose (stroke (type …)) is not solid, else {} — spread into a stroked geometry record. */
export const NO_DASH: { dash?: boolean; dashType?: string } = {};

export function dashOf(node: SNode | null | undefined): { dash?: boolean; dashType?: string } { const t = strokeOf(node, 0).type; return t ? { dash: true, dashType: t } : NO_DASH; }

/** (net N) of a board item, -1 when absent (0 = no net). */
export function netOf(node: SNode | null | undefined): number { const nn = node && kid(node, "net"); return nn ? num(nn[1], -1) : -1; }

/** (key yes|no) child, or a bare `key` token; def when absent */
export function boolOf(node: SNode | null | undefined, key: string, def: boolean): boolean;
export function boolOf(node: SNode | null | undefined, key: string, def?: boolean): boolean | undefined;
export function boolOf(node: SNode | null | undefined, key: string, def?: boolean): boolean | undefined { const k = node && kid(node, key); if (k) return str(k[1]) !== "no"; return (node && has(node, key)) ? true : def; }

/** Axis-aligned box of a text box / table cell: (at x y r) + (size w h), or (start) + (end) [+ (angle a)]. */
export function boxOf(node: SNode): BoxRot | null {
  const s0 = kid(node, "start"), e0 = kid(node, "end"); const a = kid(node, "at");
  let x0: number, y0: number, x1: number, y1: number, rot = 0;
  if (a) { x0 = num(a[1]); y0 = num(a[2]); rot = num(a[3]); const sz = kid(node, "size"); x1 = x0 + (sz ? num(sz[1]) : 0); y1 = y0 + (sz ? num(sz[2]) : 0); }
  else if (s0 && e0) { x0 = num(s0[1]); y0 = num(s0[2]); x1 = num(e0[1]); y1 = num(e0[2]); }
  else return null;
  const angN = kid(node, "angle"); if (angN) rot = num(angN[1]);
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), rot };
}

/** EDA_SHAPE::GetCornersInSequence: the box corners starting at the text's own top-left for its angle. */
export function cornersInSequence(b: { x0: number; y0: number; x1: number; y1: number }, angle: number | null | undefined): Pt[] {
  const a = ((Math.round(angle || 0) % 360) + 360) % 360;
  const TL = [b.x0, b.y0], TR = [b.x1, b.y0], BR = [b.x1, b.y1], BL = [b.x0, b.y1];
  if (a === 0) return [TL, TR, BR, BL];
  if (a === 90) return [BL, TL, TR, BR];
  if (a === 180) return [BR, BL, TL, TR];
  if (a === 270) return [TR, BR, BL, TL];
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return [TL, TR, BR, BL].map(([x, y]) => { const [rx, ry] = rotPt(x - cx, y - cy, a); return [cx + rx, cy + ry]; });
}

/** fill descriptor: {type: none|outline|background|color|solid, color} */
export function fillOf(node: SNode): FillInfo {
  const f = kid(node, "fill"); if (!f) return { type: "none", color: null };
  const t = kid(f, "type"); let type = t ? str(t[1]) : (has(f, "yes") || has(f, "solid") ? "solid" : "none");
  if (type === "yes") type = "solid";
  return { type, color: colorOf(f) };
}

export function effectsOf(node: SNode): TextEffects {
  const e = kid(node, "effects");
  const r: TextEffects = { size: 1.27, sizeX: 1.27, thick: 0, hide: false, just: [], mirror: false, bold: false, italic: false };
  if (e) {
    const f = kid(e, "font");
    if (f) {
      const s = kid(f, "size"); if (s) { r.size = num(s[1], 1.27); r.sizeX = num(s[2], r.size); }   // (size HEIGHT WIDTH): the parser reads "text height" first
      const t = kid(f, "thickness"); if (t) r.thick = num(t[1]);
      r.bold = yesNo(f, "bold"); r.italic = yesNo(f, "italic");
      const fc = kid(f, "face"); if (fc && str(fc[1])) r.face = str(fc[1]);   // an outline (TrueType) font by name
    }
    const j = kid(e, "justify"); if (j) { r.just = j.slice(1).map(str); if (r.just.includes("mirror")) r.mirror = true; }
    if (has(e, "hide")) r.hide = true; const h = kid(e, "hide"); if (h && str(h[1]) === "yes") r.hide = true;
  }
  if (has(node, "hide")) r.hide = true; const h2 = kid(node, "hide"); if (h2 && str(h2[1]) === "yes") r.hide = true;
  return r;
}

/** The text-geometry fields of an outline font: { face, bold } when the effects name a face, else null. */
export function faceOf(ef: { face?: string; bold?: boolean } | null | undefined): { face: string; bold: boolean } | null { return ef && ef.face ? { face: ef.face, bold: !!ef.bold } : null; }

export function justOf(just: readonly string[], defH?: string | null, defV?: string | null): { h: string; v: string } {
  const h = just.includes("left") ? "left" : just.includes("right") ? "right" : (defH || "center");
  const v = just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : (defV || "middle");
  return { h, v };
}

/** wxStringSplit on line ends, as FONT::getLinePositions splits a text: a final empty piece is not a line. */
export function splitLines(text: unknown): string[] { const l = String(text).split("\n"); if (l.length > 1 && l[l.length - 1] === "") l.pop(); return l; }

export const flipH = (h: string): string => h === "left" ? "right" : h === "right" ? "left" : h;

export const flipV = (v: string): string => v === "top" ? "bottom" : v === "bottom" ? "top" : v;

export function arcFrom3(p0: readonly number[], pm: readonly number[], p1: readonly number[]): Arc3 | null {
  // centre of the circle through three points; null when collinear
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
  // choose the sweep direction that passes through the mid point (mirrored inputs flip it naturally)
  const norm = (a: number) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = norm(a1 - a0), ccwMid = norm(am - a0);
  const ccw = ccwMid <= ccwSweep;   // canvas "anticlockwise" flag is false for increasing angles
  return { x: ux, y: uy, r, a0, a1, anticlockwise: !ccw };
}

export function bezierPts(p: Pt[], segs?: number): Pt[] {
  // cubic (4 control points) flattened into line segments; quadratic-ish 3-point input is promoted
  if (p.length < 3) return p.slice();
  const [a, b, c, d] = p.length >= 4 ? p : [p[0], p[1], p[1], p[2]];
  const out: Pt[] = []; segs = segs || 16;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
              u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]);
  }
  return out;
}

/**
 * (ellipse …) / (ellipse_arc …) / (gr_ellipse …) / (fp_ellipse …) flattened, in the node's own coordinates.  The
 * angles are KiCad's internal (Y down) ones in every file — SHAPE_ELLIPSE's eval, an arc swept from start_angle up to
 * end_angle (sweepRange) — while a symbol library writes the centre with Y up, so `invertY` maps through that.
 */
export function ellipsePts(g: SNode, invertY?: boolean, segs?: number): { pts: Pt[]; closed: boolean } | null {
  const c = kid(g, "center"); if (!c) return null;
  const a = num((kid(g, "major_radius") || [])[1], 0), b = num((kid(g, "minor_radius") || [])[1], 0);
  const phi = num((kid(g, "rotation_angle") || [])[1], 0) * Math.PI / 180, cr = Math.cos(phi), sr = Math.sin(phi);
  const arc = /ellipse_arc$/.test(String(g[0]));
  let t0 = 0, t1 = 2 * Math.PI;
  if (arc) {
    t0 = num((kid(g, "start_angle") || [])[1], 0) * Math.PI / 180; t1 = num((kid(g, "end_angle") || [])[1], 0) * Math.PI / 180;
    if (t1 - t0 >= 2 * Math.PI || t1 - t0 <= -2 * Math.PI) t1 = t0 + 2 * Math.PI; else if (t1 < t0) t1 += 2 * Math.PI;
  }
  const cx = num(c[1]), cy = invertY ? -num(c[2]) : num(c[2]);
  const n = Math.max(8, segs || Math.ceil(64 * (t1 - t0) / (2 * Math.PI))), out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    if (!arc && i === n) break;
    const t = t0 + (t1 - t0) * i / n, lx = a * Math.cos(t), ly = b * Math.sin(t);
    const x = cx + lx * cr - ly * sr, y = cy + lx * sr + ly * cr;
    out.push([x, invertY ? -y : y]);
  }
  return { pts: out, closed: !arc };
}

// KiCad's RotatePoint: positive angles turn counter-clockwise on the (Y down) screen
export function rotPt(x: number, y: number, deg: number): [number, number] { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; }

export function rotator(deg: number): (x: number, y: number) => [number, number] { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x: number, y: number): [number, number] => [x * c + y * s, -x * s + y * c]; }

export function pointInPoly(pts: readonly (readonly number[])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
