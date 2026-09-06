// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { rgba } from "./colors";
// ---------------------------------------------------------------- s-expressions
export function parse(text) {
  let i = 0; const n = text.length;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  function list() {
    i++; const out = [];
    for (;;) {
      while (i < n && ws(text.charCodeAt(i))) i++;
      if (i >= n) break;
      const c = text[i];
      if (c === ")") { i++; break; }
      if (c === "(") out.push(list());
      else if (c === '"') out.push(quoted());
      else out.push(atom());
    }
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

export function parseAll(text) {
  const out = [];
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

export function kid(node, key) { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }

export function kids(node, key) { const out = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }

export function num(v, d = 0) { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }

export function str(v) { return v === undefined || v === null ? "" : String(v); }

export function has(node, tok) { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }

export function yesNo(node, key) { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key); }

export function uuidOf(node) { const u = kid(node, "uuid") || kid(node, "tstamp"); return u ? str(u[1]) : ""; }

export function atOf(node) {
  const t = kid(node, "transform");
  if (t) { const tr = kid(t, "translate"), ro = kid(t, "rotate"); return [tr ? num(tr[1]) : 0, tr ? num(tr[2]) : 0, ro ? num(ro[1]) : 0]; }
  const a = kid(node, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0];
}

export function ptsOf(node) { const p = kid(node, "pts"); return p ? kids(p, "xy").map((x) => [num(x[1]), num(x[2])]) : []; }

export function widthOf(node, def) {
  const s = kid(node, "stroke"); const w = s && kid(s, "width"); if (w) return num(w[1], def);
  const w2 = kid(node, "width"); return w2 ? num(w2[1], def) : def;
}

export function colorOf(node) {
  // (color r g b a) child with a > 0, as a CSS colour; null when unspecified
  const c = kid(node, "color"); if (!c) return null; const a = num(c[4], 1); if (a <= 0) return null;
  return rgba(num(c[1]), num(c[2]), num(c[3]), a);
}

export function strokeColorOf(node) { const s = kid(node, "stroke"); return s ? colorOf(s) : null; }

/** (stroke (width w) (type t) (color …)) → {w, color, dash, type}; w = def when unspecified; type = dash|dot|dash_dot|dash_dot_dot or null */
export function strokeOf(node, def) {
  const s = node && kid(node, "stroke"); if (!s) return { w: def, color: null, dash: false, type: null };
  const wN = kid(s, "width"), tN = kid(s, "type"); const type = tN ? str(tN[1]) : "default";
  const dash = type !== "default" && type !== "solid";
  return { w: wN ? num(wN[1], def) : def, color: colorOf(s), dash, type: dash ? type : null };
}

/** {dash: true, dashType} for a node whose (stroke (type …)) is not solid, else {} — spread into a stroked geometry record. */
export const NO_DASH = {};

export function dashOf(node) { const t = strokeOf(node, 0).type; return t ? { dash: true, dashType: t } : NO_DASH; }

/** (net N) of a board item, -1 when absent (0 = no net). */
export function netOf(node) { const nn = node && kid(node, "net"); return nn ? num(nn[1], -1) : -1; }

/** (key yes|no) child, or a bare `key` token; def when absent */
export function boolOf(node, key, def) { const k = node && kid(node, key); if (k) return str(k[1]) !== "no"; return (node && has(node, key)) ? true : def; }

/** Axis-aligned box of a text box / table cell: (at x y r) + (size w h), or (start) + (end) [+ (angle a)]. */
export function boxOf(node) {
  const s0 = kid(node, "start"), e0 = kid(node, "end"); const a = kid(node, "at");
  let x0, y0, x1, y1, rot = 0;
  if (a) { x0 = num(a[1]); y0 = num(a[2]); rot = num(a[3]); const sz = kid(node, "size"); x1 = x0 + (sz ? num(sz[1]) : 0); y1 = y0 + (sz ? num(sz[2]) : 0); }
  else if (s0 && e0) { x0 = num(s0[1]); y0 = num(s0[2]); x1 = num(e0[1]); y1 = num(e0[2]); }
  else return null;
  const angN = kid(node, "angle"); if (angN) rot = num(angN[1]);
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), rot };
}

/** EDA_SHAPE::GetCornersInSequence: the box corners starting at the text's own top-left for its angle. */
export function cornersInSequence(b, angle) {
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
export function fillOf(node) {
  const f = kid(node, "fill"); if (!f) return { type: "none", color: null };
  const t = kid(f, "type"); let type = t ? str(t[1]) : (has(f, "yes") || has(f, "solid") ? "solid" : "none");
  if (type === "yes") type = "solid";
  return { type, color: colorOf(f) };
}

export function effectsOf(node) {
  const e = kid(node, "effects");
  const r = { size: 1.27, sizeX: 1.27, thick: 0, hide: false, just: [], mirror: false, bold: false, italic: false };
  if (e) {
    const f = kid(e, "font");
    if (f) {
      const s = kid(f, "size"); if (s) { r.size = num(s[2], num(s[1], 1.27)); r.sizeX = num(s[1], r.size); }
      const t = kid(f, "thickness"); if (t) r.thick = num(t[1]);
      r.bold = yesNo(f, "bold"); r.italic = yesNo(f, "italic");
    }
    const j = kid(e, "justify"); if (j) { r.just = j.slice(1).map(str); if (r.just.includes("mirror")) r.mirror = true; }
    if (has(e, "hide")) r.hide = true; const h = kid(e, "hide"); if (h && str(h[1]) === "yes") r.hide = true;
  }
  if (has(node, "hide")) r.hide = true; const h2 = kid(node, "hide"); if (h2 && str(h2[1]) === "yes") r.hide = true;
  return r;
}

export function justOf(just, defH, defV) {
  const h = just.includes("left") ? "left" : just.includes("right") ? "right" : (defH || "center");
  const v = just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : (defV || "middle");
  return { h, v };
}

export const flipH = (h) => h === "left" ? "right" : h === "right" ? "left" : h;

export const flipV = (v) => v === "top" ? "bottom" : v === "bottom" ? "top" : v;

export function arcFrom3(p0, pm, p1) {
  // centre of the circle through three points; null when collinear
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
  // choose the sweep direction that passes through the mid point (mirrored inputs flip it naturally)
  const norm = (a) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = norm(a1 - a0), ccwMid = norm(am - a0);
  const ccw = ccwMid <= ccwSweep;   // canvas "anticlockwise" flag is false for increasing angles
  return { x: ux, y: uy, r, a0, a1, anticlockwise: !ccw };
}

export function bezierPts(p, segs) {
  // cubic (4 control points) flattened into line segments; quadratic-ish 3-point input is promoted
  if (p.length < 3) return p.slice();
  const [a, b, c, d] = p.length >= 4 ? p : [p[0], p[1], p[1], p[2]];
  const out = []; segs = segs || 16;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
              u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]);
  }
  return out;
}

// KiCad's RotatePoint: positive angles turn counter-clockwise on the (Y down) screen
export function rotPt(x, y, deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; }

export function rotator(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; }

export function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
