// importgfx/model.ts — GRAPHICS_IMPORT_MGR's vector plugins without a DOM: SVG_IMPORT_PLUGIN (nanosvg's reading —
// every outline a run of cubic Béziers in millimetres, lines included) and DXF_IMPORT_PLUGIN (LINE, CIRCLE, ARC,
// LWPOLYLINE / POLYLINE with bulges, SPLINE, ELLIPSE, POINT, INSERT of a BLOCK), both filling a
// GRAPHICS_IMPORTER_BUFFER of IMPORTED_* shapes.  ImportTo then scales and offsets them (GRAPHICS_IMPORTER::MapCoordinate,
// MapLineWidth) and turns each into one primitive the editors write as their own shapes: SVG_IMPORT_PLUGIN::DrawPath
// makes a closed or filled path a polygon (GatherInterpolatedCubicBezierPath) and an open one a Bézier per segment,
// and setupSplineOrLine turns a straight Bézier into a segment.

export type V = [number, number];
export interface Stroke { width: number; dash: "solid" | "dash" | "dot" | "dash_dot" | "dash_dot_dot" }
export type Imported =
  | { t: "line"; a: V; b: V; stroke: Stroke; layer: string }
  | { t: "circle"; c: V; r: number; stroke: Stroke; filled: boolean; layer: string }
  | { t: "arc"; a: V; m: V; b: V; stroke: Stroke; layer: string }
  | { t: "poly"; pts: V[]; stroke: Stroke; filled: boolean; layer: string }
  | { t: "spline"; a: V; c1: V; c2: V; b: V; stroke: Stroke; layer: string };
export interface ImportResult { shapes: Imported[]; width: number; height: number; layers: string[]; messages: string[] }

const NO_STROKE: Stroke = { width: -1, dash: "solid" };

// ---------------------------------------------------------------- Bézier helpers (svg_import_plugin.cpp)
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function bezierAt(p: V[], t: number): V { const q0 = lerp(p[0], p[1], t), q1 = lerp(p[1], p[2], t), q2 = lerp(p[2], p[3], t); return lerp(lerp(q0, q1, t), lerp(q1, q2, t), t); }
function distToLine(p: V, a: V, b: V): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
  if (l === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
}
/** GatherInterpolatedCubicBezierCurve: halve until the midpoint is within 0.1% of the curve's box of the chord. */
function flattenCurve(p: V[], out: V[]): void {
  const xs = [p[0][0], p[1][0], p[2][0]], ys = [p[0][1], p[1][1], p[2][1]];
  const thr = 0.001 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const start = bezierAt(p, 0), end = bezierAt(p, 1);
  const last = out[out.length - 1];
  if (!last || last[0] !== start[0] || last[1] !== start[1]) out.push(start);
  const seg = (s: V, e: V, off: number, step: number, depth: number): void => {
    const mid = bezierAt(p, off + step);
    if (depth < 16 && distToLine(mid, s, e) > thr) { seg(s, mid, off, step / 2, depth + 1); out.push(mid); seg(mid, e, off + step, step / 2, depth + 1); }
  };
  seg(start, end, 0, 0.5, 0);
  out.push(end);
}
/** nanosvg's path: a start point then three points per cubic. */
export function flattenPath(pts: V[]): V[] { const out: V[] = []; for (let i = 0; i + 3 < pts.length; i += 3) flattenCurve(pts.slice(i, i + 4), out); return out; }
/** SEG::ApproxCollinear on both control arms: the Bézier is really a segment. */
export function straightBezier(a: V, c1: V, c2: V, b: V): boolean {
  const tol = 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
  return distToLine(c1, a, b) <= tol && distToLine(c2, a, b) <= tol;
}

// ---------------------------------------------------------------- SVG (nanosvg)
interface XmlEl { name: string; attrs: Record<string, string>; kids: XmlEl[] }
/** A small XML reader: elements and attributes (text, comments, CDATA and the prolog are skipped). */
export function parseXml(text: string): XmlEl | null {
  const root: XmlEl = { name: "#root", attrs: {}, kids: [] }; const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a: RegExpExecArray | null;
    while ((a = ar.exec(m[3] || ""))) attrs[a[1]] = (a[3] !== undefined ? a[3] : a[4]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const el: XmlEl = { name: m[2].replace(/^svg:/, ""), attrs, kids: [] };
    stack[stack.length - 1].kids.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.kids.find((k) => k.name === "svg") || null;
}
type M6 = [number, number, number, number, number, number];
const ID: M6 = [1, 0, 0, 1, 0, 0];
const mul = (a: M6, b: M6): M6 => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M6, p: V): V => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const nums = (s: string): number[] => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
export function parseTransform(s: string | undefined): M6 {
  let m = ID; if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const v = nums(t[2]); let n: M6 = ID;
    if (t[1] === "matrix" && v.length >= 6) n = [v[0], v[1], v[2], v[3], v[4], v[5]];
    else if (t[1] === "translate") n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
    else if (t[1] === "scale") n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (t[1] === "rotate") { const r = (v[0] || 0) * Math.PI / 180, c = Math.cos(r), s2 = Math.sin(r); n = [c, s2, -s2, c, 0, 0]; if (v.length >= 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]); }
    else if (t[1] === "skewX") n = [1, 0, Math.tan((v[0] || 0) * Math.PI / 180), 1, 0, 0];
    else if (t[1] === "skewY") n = [1, Math.tan((v[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}
/** nsvg__convertToPixels with units "mm" at 96 dpi: a length in millimetres. */
export function svgLength(s: string | undefined, dpi = 96, ref = 0): number | null {
  if (!s) return null; const m = s.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?$/); if (!m) return null;
  const v = Number(m[1]), u = m[2] || "px";
  const px = u === "px" ? v : u === "pt" ? v / 72 * dpi : u === "pc" ? v / 6 * dpi : u === "mm" ? v / 25.4 * dpi : u === "cm" ? v / 2.54 * dpi : u === "in" ? v * dpi : u === "%" ? v / 100 * ref : v * 16;
  return px / dpi * 25.4;
}
interface Style { fill: string | null; stroke: string | null; strokeWidth: number; dash: number[]; fillOpacity: number; display: boolean; fillRule: string }
function styleOf(el: XmlEl, parent: Style): Style {
  const props: Record<string, string> = {};
  for (const k of ["fill", "stroke", "stroke-width", "stroke-dasharray", "fill-opacity", "opacity", "display", "visibility", "fill-rule"]) if (el.attrs[k] !== undefined) props[k] = el.attrs[k];
  if (el.attrs.style) for (const d of el.attrs.style.split(";")) { const i = d.indexOf(":"); if (i > 0) props[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  const s: Style = { ...parent };
  if (props.fill !== undefined) s.fill = props.fill === "none" ? null : props.fill;
  if (props.stroke !== undefined) s.stroke = props.stroke === "none" ? null : props.stroke;
  // lengths in user units (the transform scales them with the outline)
  if (props["stroke-width"] !== undefined) { const w = svgLength(props["stroke-width"]); if (w !== null) s.strokeWidth = w / 25.4 * 96; }
  if (props["stroke-dasharray"] !== undefined) s.dash = props["stroke-dasharray"] === "none" ? [] : nums(props["stroke-dasharray"]);
  if (props["fill-opacity"] !== undefined) s.fillOpacity = Number(props["fill-opacity"]);
  if (props.display === "none" || props.visibility === "hidden") s.display = false;
  if (props["fill-rule"] !== undefined) s.fillRule = props["fill-rule"];
  return s;
}
/** nanosvg's path reader: every command as cubic Béziers; a path is one subpath (closed or not). */
export function pathToCubics(d: string): { pts: V[]; closed: boolean }[] {
  const out: { pts: V[]; closed: boolean }[] = []; let cur: V[] = [];
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, prev = "";
  const flush = (closed: boolean): void => { if (cur.length > 3) out.push({ pts: cur, closed }); cur = []; };
  const lineTo = (nx: number, ny: number): void => { if (!cur.length) cur.push([x, y]); const dx = nx - x, dy = ny - y; cur.push([x + dx / 3, y + dy / 3], [nx - dx / 3, ny - dy / 3], [nx, ny]); x = nx; y = ny; };
  const cubicTo = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number): void => { if (!cur.length) cur.push([x, y]); cur.push([x1, y1], [x2, y2], [nx, ny]); x = nx; y = ny; };
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cmd = "";
  const n = (): number => Number(tokens[i++]);
  const flag = (): number => { const t = tokens[i]; if (t && /^[01]{2,}/.test(t)) { tokens[i] = t.slice(1); return Number(t[0]); } i++; return Number(t); };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case "M": { flush(false); x = ox + n(); y = oy + n(); sx = x; sy = y; cur = [[x, y]]; cmd = rel ? "l" : "L"; cx = x; cy = y; break; }
      case "L": { const nx = ox + n(), ny = oy + n(); lineTo(nx, ny); cx = x; cy = y; break; }
      case "H": { lineTo(rel ? x + n() : n(), y); cx = x; cy = y; break; }
      case "V": { lineTo(x, rel ? y + n() : n()); cx = x; cy = y; break; }
      case "C": { const x1 = ox + n(), y1 = oy + n(), x2 = ox + n(), y2 = oy + n(), nx = ox + n(), ny = oy + n(); cubicTo(x1, y1, x2, y2, nx, ny); cx = x2; cy = y2; break; }
      case "S": { const r = /^[CS]$/i.test(prev); const x1 = r ? 2 * x - cx : x, y1 = r ? 2 * y - cy : y; const x2 = ox + n(), y2 = oy + n(), nx = ox + n(), ny = oy + n(); cubicTo(x1, y1, x2, y2, nx, ny); cx = x2; cy = y2; break; }
      case "Q": { const qx = ox + n(), qy = oy + n(), nx = ox + n(), ny = oy + n(); cubicTo(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny), nx, ny); cx = qx; cy = qy; break; }
      case "T": { const r = /^[QT]$/i.test(prev); const qx = r ? 2 * x - cx : x, qy = r ? 2 * y - cy : y; const nx = ox + n(), ny = oy + n(); cubicTo(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny), nx, ny); cx = qx; cy = qy; break; }
      case "A": { const rx = n(), ry = n(), rot = n(), la = flag(), sw = flag(), nx = ox + n(), ny = oy + n(); arcTo(rx, ry, rot, la, sw, nx, ny); cx = x; cy = y; break; }
      case "Z": { if (x !== sx || y !== sy) lineTo(sx, sy); flush(true); x = sx; y = sy; cur = []; cx = x; cy = y; break; }
      default: i++;
    }
    prev = C;
  }
  flush(false);
  return out;
  // nsvg__pathArcTo: split into quarter turns, each one cubic
  function arcTo(rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number): void {
    const x1 = x, y1 = y; rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < 1e-9 || ry < 1e-9 || (x1 === x2 && y1 === y2)) { lineTo(x2, y2); return; }
    const rot = rotDeg * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cr * dx + sr * dy, y1p = -sr * dx + cr * dy;
    let d = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry); if (d > 1) { d = Math.sqrt(d); rx *= d; ry *= d; }
    let s = 0; const sa = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, sb = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    if (sa > 0 && sb > 0) s = Math.sqrt(sa / sb); if (large === sweep) s = -s;
    const cxp = s * rx * y1p / ry, cyp = s * -ry * x1p / rx;
    const ccx = (x1 + x2) / 2 + cr * cxp - sr * cyp, ccy = (y1 + y2) / 2 + sr * cxp + cr * cyp;
    const ang = (ux: number, uy: number, vx: number, vy: number): number => { const r = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)); return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, r))); };
    const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    const a1 = ang(1, 0, ux, uy); let da = ang(ux, uy, vx, vy);
    if (!sweep && da > 0) da -= 2 * Math.PI; else if (sweep && da < 0) da += 2 * Math.PI;
    const ndivs = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2) - 1e-6)), hda = da / ndivs / 2;
    let kappa = Math.abs(4 / 3 * (1 - Math.cos(hda)) / Math.sin(hda)); if (da < 0) kappa = -kappa;
    let px = 0, py = 0, ptanx = 0, ptany = 0;
    for (let k = 0; k <= ndivs; k++) {
      const a = a1 + da * (k / ndivs), dxx = Math.cos(a), dyy = Math.sin(a);
      const X = ccx + cr * dxx * rx - sr * dyy * ry, Y = ccy + sr * dxx * rx + cr * dyy * ry;
      const tanx = cr * -dyy * rx * kappa - sr * dxx * ry * kappa, tany = sr * -dyy * rx * kappa + cr * dxx * ry * kappa;
      if (k > 0) cubicTo(px + ptanx, py + ptany, X - tanx, Y - tany, X, Y);
      px = X; py = Y; ptanx = tanx; ptany = tany;
    }
    x = x2; y = y2;
  }
}
const KAPPA = 0.5522847493;
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx + rx},${cy} C${cx + rx},${cy + ry * KAPPA} ${cx + rx * KAPPA},${cy + ry} ${cx},${cy + ry} C${cx - rx * KAPPA},${cy + ry} ${cx - rx},${cy + ry * KAPPA} ${cx - rx},${cy} `
    + `C${cx - rx},${cy - ry * KAPPA} ${cx - rx * KAPPA},${cy - ry} ${cx},${cy - ry} C${cx + rx * KAPPA},${cy - ry} ${cx + rx},${cy - ry * KAPPA} ${cx + rx},${cy} Z`;
}
/** The dash style SVG_IMPORT_PLUGIN guesses from the dash array (a dash under 1.9 stroke widths is a dot). */
function dashStyle(dash: number[], width: number): Stroke["dash"] {
  if (!dash.length) return "solid";
  let dots = 0, dashes = 0; for (let i = 0; i < dash.length; i += 2) { if (dash[i] < width * 1.9) dots++; else dashes++; }
  return dots > 0 && dashes === 0 ? "dot" : dots === 0 && dashes > 0 ? "dash" : dots === 1 && dashes === 1 ? "dash_dot" : dots === 2 && dashes === 1 ? "dash_dot_dot" : "solid";
}
/** SVG_IMPORT_PLUGIN::Load + Import: shapes in millimetres, with the drawing's size. */
export function importSvg(text: string): ImportResult {
  const svg = parseXml(text); const messages: string[] = [];
  if (!svg) return { shapes: [], width: 0, height: 0, layers: [], messages: ["Not an SVG file."] };
  const vb = svg.attrs.viewBox ? nums(svg.attrs.viewBox) : null;
  const vbw = vb && vb.length === 4 ? vb[2] : 0, vbh = vb && vb.length === 4 ? vb[3] : 0;
  let w = svgLength(svg.attrs.width, 96, vbw / 96 * 25.4), hgt = svgLength(svg.attrs.height, 96, vbh / 96 * 25.4);
  // the user units are pixels; the viewBox maps onto width / height (xMidYMid meet)
  const px = 25.4 / 96;
  if (w === null) w = vbw * px; if (hgt === null) hgt = vbh * px;
  let root: M6 = [px, 0, 0, px, 0, 0];
  if (vb && vb.length === 4 && vbw > 0 && vbh > 0) {
    const s = Math.min(w / vbw, hgt / vbh), tx = (w - vbw * s) / 2 - vb[0] * s, ty = (hgt - vbh * s) / 2 - vb[1] * s;
    root = [s, 0, 0, s, tx, ty];
  }
  const shapes: Imported[] = [];
  const base: Style = { fill: "#000", stroke: null, strokeWidth: 1, dash: [], fillOpacity: 1, display: true, fillRule: "nonzero" };
  const defs = new Map<string, XmlEl>();
  const index = (el: XmlEl): void => { if (el.attrs.id) defs.set(el.attrs.id, el); el.kids.forEach(index); };
  index(svg);
  const scaleOf = (m: M6): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const emit = (subs: { pts: V[]; closed: boolean }[], m: M6, st: Style): void => {
    if (!st.display || (!st.fill && !st.stroke)) return;
    const k = scaleOf(m);
    const stroke: Stroke = st.stroke ? { width: st.strokeWidth * k, dash: dashStyle(st.dash, st.strokeWidth) } : NO_STROKE;
    const filled = !!st.fill && st.fillOpacity > 0;
    for (const sp of subs) {
      const pts = sp.pts.map((p) => apply(m, p));
      const draw = (closed: boolean, s: Stroke, fill: boolean): void => {
        if (closed) { const poly = flattenPath(pts); if (poly.length > 2) { shapes.push({ t: "poly", pts: poly, stroke: s, filled: fill, layer: "" }); return; } }
        for (let i = 0; i + 3 < pts.length; i += 3) shapes.push({ t: "spline", a: pts[i], c1: pts[i + 1], c2: pts[i + 2], b: pts[i + 3], stroke: s, layer: "" });
      };
      if (filled && !sp.closed) { draw(true, NO_STROKE, true); if (stroke.width > 0) draw(false, stroke, false); }
      else draw(sp.closed || filled, stroke, filled);
    }
  };
  const walk = (el: XmlEl, m: M6, st: Style): void => {
    const s = styleOf(el, st); if (!s.display) return;
    const mm = mul(m, parseTransform(el.attrs.transform));
    const a = (k: string): number => Number(el.attrs[k] || 0);
    switch (el.name) {
      case "svg": case "g": case "a": case "switch": for (const k of el.kids) walk(k, mm, s); return;
      case "defs": case "symbol": case "clipPath": case "mask": case "pattern": case "linearGradient": case "radialGradient": case "style": case "title": case "desc": case "metadata": return;
      case "use": { const ref = (el.attrs.href || el.attrs["xlink:href"] || "").replace(/^#/, ""); const t = defs.get(ref); if (t) walk(t.name === "symbol" ? { ...t, name: "g" } : t, mul(mm, [1, 0, 0, 1, a("x"), a("y")]), s); return; }
      case "path": emit(pathToCubics(el.attrs.d || ""), mm, s); return;
      case "rect": {
        const x = a("x"), y = a("y"), w2 = a("width"), h2 = a("height"); if (w2 <= 0 || h2 <= 0) return;
        let rx = Number(el.attrs.rx ?? el.attrs.ry ?? 0), ry = Number(el.attrs.ry ?? el.attrs.rx ?? 0); rx = Math.min(rx, w2 / 2); ry = Math.min(ry, h2 / 2);
        const d = rx > 0 || ry > 0
          ? `M${x + rx},${y} L${x + w2 - rx},${y} C${x + w2 - rx * (1 - KAPPA)},${y} ${x + w2},${y + ry * (1 - KAPPA)} ${x + w2},${y + ry} L${x + w2},${y + h2 - ry} C${x + w2},${y + h2 - ry * (1 - KAPPA)} ${x + w2 - rx * (1 - KAPPA)},${y + h2} ${x + w2 - rx},${y + h2} L${x + rx},${y + h2} C${x + rx * (1 - KAPPA)},${y + h2} ${x},${y + h2 - ry * (1 - KAPPA)} ${x},${y + h2 - ry} L${x},${y + ry} C${x},${y + ry * (1 - KAPPA)} ${x + rx * (1 - KAPPA)},${y} ${x + rx},${y} Z`
          : `M${x},${y} L${x + w2},${y} L${x + w2},${y + h2} L${x},${y + h2} Z`;
        emit(pathToCubics(d), mm, s); return;
      }
      case "circle": { const r = a("r"); if (r > 0) emit(pathToCubics(ellipsePath(a("cx"), a("cy"), r, r)), mm, s); return; }
      case "ellipse": { const rx = a("rx"), ry = a("ry"); if (rx > 0 && ry > 0) emit(pathToCubics(ellipsePath(a("cx"), a("cy"), rx, ry)), mm, s); return; }
      case "line": emit(pathToCubics(`M${a("x1")},${a("y1")} L${a("x2")},${a("y2")}`), mm, { ...s, fill: null }); return;
      case "polyline": case "polygon": { const p = nums(el.attrs.points || ""); if (p.length < 4) return; let d = `M${p[0]},${p[1]}`; for (let i = 2; i + 1 < p.length; i += 2) d += ` L${p[i]},${p[i + 1]}`; if (el.name === "polygon") d += " Z"; emit(pathToCubics(d), mm, s); return; }
      case "text": messages.push("Text elements are not imported."); return;
      case "image": messages.push("Embedded images are not imported."); return;
      default: return;
    }
  };
  walk(svg, root, base);
  return { shapes, width: w, height: hgt, layers: [], messages: Array.from(new Set(messages)) };
}

// ---------------------------------------------------------------- DXF (dl_dxf reading through DXF_IMPORT_PLUGIN)
/** DXF_IMPORT_UNITS in the dialog's order (dxfImportUnitChoices) and their millimetre factors. */
export const DXF_UNIT_CHOICES: [string, number][] = [["Inches", 25.4], ["Feet", 304.8], ["Millimeters", 1], ["Centimeter", 10], ["Mils", 0.0254]];
const INSUNITS: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100 };
interface Pair { code: number; value: string }
function dxfPairs(text: string): Pair[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) { const c = parseInt(lines[i].trim(), 10); if (isNaN(c)) { i--; continue; } out.push({ code: c, value: lines[i + 1].trim() }); }
  return out;
}
interface Entity { type: string; g: Pair[] }
const gv = (e: Entity, code: number, d = 0): number => { const p = e.g.find((x) => x.code === code); return p ? Number(p.value) : d; };
const gs = (e: Entity, code: number, d = ""): string => { const p = e.g.find((x) => x.code === code); return p ? p.value : d; };
const gall = (e: Entity, code: number): number[] => e.g.filter((x) => x.code === code).map((x) => Number(x.value));

/** de Boor's B-spline split into cubic Béziers by knot insertion (Boehm), as DXF_IMPORT_PLUGIN::insertSpline gets from tinyspline. */
export function bsplineToBeziers(degree: number, ctrl: V[], knots: number[]): V[][] {
  if (degree < 1 || ctrl.length < degree + 1) return [];
  if (knots.length !== ctrl.length + degree + 1) { knots = []; const n = ctrl.length; for (let i = 0; i < n + degree + 1; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree); }
  let P = ctrl.map((p) => [p[0], p[1]] as V), U = knots.slice();
  const insert = (u: number): void => {
    let k = -1; for (let i = degree; i < U.length - degree - 1; i++) if (U[i] <= u && u < U[i + 1]) { k = i; break; } if (k < 0) return;
    const Q: V[] = [];
    for (let i = 0; i < P.length + 1; i++) {
      if (i <= k - degree) Q.push(P[i]); else if (i > k) Q.push(P[i - 1]);
      else { const a = (u - U[i]) / (U[i + degree] - U[i]); Q.push([(1 - a) * P[i - 1][0] + a * P[i][0], (1 - a) * P[i - 1][1] + a * P[i][1]]); }
    }
    U.splice(k + 1, 0, u); P = Q;
  };
  const lo = U[degree], hi = U[U.length - degree - 1];
  for (const u of Array.from(new Set(U.filter((x) => x > lo && x < hi)))) { const mult = U.filter((x) => x === u).length; for (let r = mult; r < degree; r++) insert(u); }
  // clamp the ends
  for (let r = U.filter((x) => x === lo).length; r < degree + 1; r++) insert(lo);
  const segs: V[][] = [];
  // after full insertion every span is a Bézier of `degree`: control points step by `degree`
  const offset = U.lastIndexOf(lo) - degree;
  for (let i = offset; i + degree < P.length; i += degree) {
    const b = P.slice(i, i + degree + 1); if (b.length < degree + 1) break;
    if (degree === 3) segs.push(b);
    else if (degree === 2) segs.push([b[0], [b[0][0] + 2 / 3 * (b[1][0] - b[0][0]), b[0][1] + 2 / 3 * (b[1][1] - b[0][1])], [b[2][0] + 2 / 3 * (b[1][0] - b[2][0]), b[2][1] + 2 / 3 * (b[1][1] - b[2][1])], b[2]]);
    else if (degree === 1) segs.push([b[0], lerp(b[0], b[1], 1 / 3), lerp(b[0], b[1], 2 / 3), b[1]]);
    if (segs.length > 10000) break;
  }
  return segs;
}

/** DXF_IMPORT_PLUGIN: entities in millimetres, the Y axis turned down (mapY), lineweights in 1/100 mm or the default width. */
export function importDxf(text: string, defaultUnit = 2, defaultWidth = 0.2): ImportResult {
  const pairs = dxfPairs(text), messages: string[] = [];
  let unit = DXF_UNIT_CHOICES[defaultUnit] ? DXF_UNIT_CHOICES[defaultUnit][1] : 1;
  const layerWeight = new Map<string, number>(), layers: string[] = [];
  const blocks = new Map<string, { base: V; ents: Entity[] }>();
  const ents: Entity[] = [];
  let section = "", i = 0;
  const readEntities = (into: Entity[], stop: (p: Pair) => boolean): void => {
    let cur: Entity | null = null;
    for (; i < pairs.length; i++) {
      const p = pairs[i];
      if (stop(p)) { if (cur) into.push(cur); return; }
      if (p.code === 0) { if (cur) into.push(cur); cur = { type: p.value, g: [] }; } else if (cur) cur.g.push(p);
    }
    if (cur) into.push(cur);
  };
  for (; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 0 && p.value === "SECTION") { section = pairs[i + 1] ? pairs[i + 1].value : ""; i++; continue; }
    if (p.code === 0 && p.value === "ENDSEC") { section = ""; continue; }
    if (section === "HEADER" && p.code === 9 && p.value === "$INSUNITS") { const v = pairs[i + 1]; if (v && INSUNITS[Number(v.value)]) unit = INSUNITS[Number(v.value)]; i++; continue; }
    if (section === "TABLES" && p.code === 0 && p.value === "LAYER") {
      const e: Entity = { type: "LAYER", g: [] }; i++; for (; i < pairs.length && pairs[i].code !== 0; i++) e.g.push(pairs[i]); i--;
      const name = gs(e, 2); if (name) { if (!layers.includes(name)) layers.push(name); layerWeight.set(name, gv(e, 370, -3)); }
      continue;
    }
    if (section === "BLOCKS" && p.code === 0 && p.value === "BLOCK") {
      const head: Entity = { type: "BLOCK", g: [] }; i++; for (; i < pairs.length && pairs[i].code !== 0; i++) head.g.push(pairs[i]);
      const list: Entity[] = []; readEntities(list, (q) => q.code === 0 && q.value === "ENDBLK");
      blocks.set(gs(head, 2), { base: [gv(head, 10), gv(head, 20)], ents: list });
      continue;
    }
    if (section === "ENTITIES" && p.code === 0) { readEntities(ents, (q) => q.code === 0 && q.value === "ENDSEC"); section = ""; continue; }
  }
  const shapes: Imported[] = [];
  const widthOf = (e: Entity): number => {
    let lw = gv(e, 370, -1); const layer = gs(e, 8, "0");
    if (lw === -1) lw = layerWeight.has(layer) ? layerWeight.get(layer)! : -3;
    return lw >= 0 ? lw / 100 : defaultWidth;
  };
  type T = (p: V) => V;
  const draw = (list: Entity[], tf: T, depth: number, inLayer?: string): void => {
    for (let k = 0; k < list.length; k++) {
      const e = list[k]; const layer = gs(e, 8, inLayer || "0") === "0" && inLayer ? inLayer : gs(e, 8, "0"), stroke: Stroke = { width: widthOf(e), dash: "solid" };
      const map = (x: number, y: number): V => { const q = tf([x, y]); return [q[0] * unit, -q[1] * unit]; };
      switch (e.type) {
        case "LINE": shapes.push({ t: "line", a: map(gv(e, 10), gv(e, 20)), b: map(gv(e, 11), gv(e, 21)), stroke, layer }); break;
        case "POINT": break;
        case "CIRCLE": { const c = map(gv(e, 10), gv(e, 20)), r = gv(e, 40), q = map(gv(e, 10) + r, gv(e, 20)); shapes.push({ t: "circle", c, r: Math.hypot(q[0] - c[0], q[1] - c[1]), stroke, filled: false, layer }); break; }
        case "ARC": {
          const cx = gv(e, 10), cy = gv(e, 20), r = gv(e, 40), a1 = gv(e, 50), a2 = gv(e, 51);
          let sweep = a2 - a1; while (sweep <= 0) sweep += 360;
          const at = (deg: number): V => map(cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180));
          shapes.push({ t: "arc", a: at(a1), m: at(a1 + sweep / 2), b: at(a1 + sweep), stroke, layer }); break;
        }
        case "LWPOLYLINE": {
          const flags = gv(e, 70), cw = gv(e, 43, 0);
          // bulges belong to the vertex they follow (group 42 after that vertex's 10/20)
          const verts: { p: V; bulge: number }[] = []; for (const g of e.g) { if (g.code === 10) verts.push({ p: [Number(g.value), 0], bulge: 0 }); else if (g.code === 20 && verts.length) verts[verts.length - 1].p[1] = Number(g.value); else if (g.code === 42 && verts.length) verts[verts.length - 1].bulge = Number(g.value); }
          const st: Stroke = cw > 0 ? { width: cw * unit, dash: "solid" } : stroke;
          polyline(verts, (flags & 1) === 1, map, st, layer); break;
        }
        case "POLYLINE": {
          const flags = gv(e, 70), verts: { p: V; bulge: number }[] = []; let w0 = 0;
          for (k++; k < list.length && list[k].type === "VERTEX"; k++) { const v = list[k]; verts.push({ p: [gv(v, 10), gv(v, 20)], bulge: gv(v, 42) }); if (!w0) w0 = gv(v, 40) || gv(v, 41); }
          const st: Stroke = w0 > 0 ? { width: w0 / 100, dash: "solid" } : stroke;
          polyline(verts, (flags & 1) === 1, map, st, layer); break;
        }
        case "SPLINE": {
          const deg = gv(e, 71, 3), knots = gall(e, 40), cx = gall(e, 10), cy = gall(e, 20);
          const ctrl: V[] = cx.map((x, j) => [x, cy[j] || 0]);
          const fit = gall(e, 11), fy = gall(e, 21);
          const pts = ctrl.length ? ctrl : fit.map((x, j) => [x, fy[j] || 0] as V);
          for (const b of bsplineToBeziers(ctrl.length ? deg : Math.min(3, pts.length - 1), pts, ctrl.length ? knots : [])) {
            const m4 = b.map((p) => map(p[0], p[1]));
            shapes.push({ t: "spline", a: m4[0], c1: m4[1], c2: m4[2], b: m4[3], stroke, layer });
          }
          break;
        }
        case "ELLIPSE": {
          // centre, major axis end (relative), ratio, start / end parameters: a Bézier per quarter, as an outline
          const c: V = [gv(e, 10), gv(e, 20)], maj: V = [gv(e, 11), gv(e, 21)], ratio = gv(e, 40, 1);
          let t0 = gv(e, 41, 0), t1 = gv(e, 42, Math.PI * 2); while (t1 <= t0) t1 += Math.PI * 2;
          const mn: V = [-maj[1] * ratio, maj[0] * ratio];
          const P = (t: number): V => [c[0] + maj[0] * Math.cos(t) + mn[0] * Math.sin(t), c[1] + maj[1] * Math.cos(t) + mn[1] * Math.sin(t)];
          const D = (t: number): V => [-maj[0] * Math.sin(t) + mn[0] * Math.cos(t), -maj[1] * Math.sin(t) + mn[1] * Math.cos(t)];
          const n = Math.max(1, Math.ceil((t1 - t0) / (Math.PI / 2) - 1e-9)), dt = (t1 - t0) / n, kk = 4 / 3 * Math.tan(dt / 4);
          for (let j = 0; j < n; j++) {
            const a = t0 + j * dt, b = a + dt, pa = P(a), pb = P(b), da = D(a), db = D(b);
            const m4 = [pa, [pa[0] + kk * da[0], pa[1] + kk * da[1]], [pb[0] - kk * db[0], pb[1] - kk * db[1]], pb].map((p) => map(p[0], p[1]));
            shapes.push({ t: "spline", a: m4[0], c1: m4[1], c2: m4[2], b: m4[3], stroke, layer });
          }
          break;
        }
        case "INSERT": {
          const blk = blocks.get(gs(e, 2)); if (!blk || depth > 8) break;
          const ip: V = [gv(e, 10), gv(e, 20)], sx = gv(e, 41, 1), sy = gv(e, 42, 1), rot = gv(e, 50, 0) * Math.PI / 180;
          const c = Math.cos(rot), s = Math.sin(rot);
          const t2: T = (p) => { const x = (p[0] - blk.base[0]) * sx, y = (p[1] - blk.base[1]) * sy; return tf([ip[0] + x * c - y * s, ip[1] + x * s + y * c]); };
          draw(blk.ents, t2, depth + 1, layer); break;
        }
        case "TEXT": case "MTEXT": case "ATTRIB": case "ATTDEF": messages.push("Text is not imported."); break;
        case "HATCH": case "SOLID": case "3DFACE": case "DIMENSION": case "LEADER": case "IMAGE": case "VIEWPORT": messages.push(`${e.type} entities are not imported.`); break;
        default: break;
      }
    }
  };
  function polyline(verts: { p: V; bulge: number }[], closed: boolean, map: (x: number, y: number) => V, stroke: Stroke, layer: string): void {
    const n = verts.length; if (n < 2) return;
    const seg = (a: { p: V; bulge: number }, b: { p: V; bulge: number }): void => {
      if (Math.abs(a.bulge) < 1e-6) { shapes.push({ t: "line", a: map(a.p[0], a.p[1]), b: map(b.p[0], b.p[1]), stroke, layer }); return; }
      // insertArc: the sagitta (bulge × half chord) to the right of the chord for a positive (counter-clockwise) bulge
      const bulge = Math.max(-2000, Math.min(2000, a.bulge));
      const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], len = Math.hypot(dx, dy); if (len === 0) return;
      const s = bulge * len / 2, mx = (a.p[0] + b.p[0]) / 2 + s * dy / len, my = (a.p[1] + b.p[1]) / 2 - s * dx / len;
      shapes.push({ t: "arc", a: map(a.p[0], a.p[1]), m: map(mx, my), b: map(b.p[0], b.p[1]), stroke, layer });
    };
    for (let j = 0; j + 1 < n; j++) seg(verts[j], verts[j + 1]);
    if (closed) seg(verts[n - 1], verts[0]);
  }
  draw(ents, (p) => p, 0);
  const box = dxfLimits(shapes);
  return { shapes, width: box ? box[2] - box[0] : 0, height: box ? box[3] - box[1] : 0, layers: layers.length ? layers : Array.from(new Set(shapes.map((s) => s.layer))), messages: Array.from(new Set(messages)) };
}

/** DXF_IMPORT_PLUGIN::updateImageLimits as each entity calls it: line and spline ends, arcs and circles as centre ± radius. */
export function dxfLimits(shapes: Imported[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: V, r = 0): void => { x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); };
  for (const s of shapes) {
    if (s.t === "line" || s.t === "spline") { add(s.a); add(s.b); }
    else if (s.t === "circle") add(s.c, s.r);
    else if (s.t === "arc") { const c = center3(s.a, s.m, s.b); if (c) add(c, Math.hypot(s.a[0] - c[0], s.a[1] - c[1])); else { add(s.a); add(s.b); } }
    else s.pts.forEach((p) => add(p));
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}
function center3(a: V, b: V, c: V): V | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

// ---------------------------------------------------------------- ImportTo
export function bboxOf(shapes: Imported[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: V, r = 0): void => { x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); };
  for (const s of shapes) {
    if (s.t === "line") { add(s.a); add(s.b); } else if (s.t === "circle") add(s.c, s.r); else if (s.t === "arc") { add(s.a); add(s.m); add(s.b); }
    else if (s.t === "poly") s.pts.forEach((p) => add(p)); else { add(s.a); add(s.c1); add(s.c2); add(s.b); }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}
/** What an editor makes of the buffer: KiCad's shapes in millimetres, scaled and offset, a straight Bézier as a segment. */
export type Prim =
  | { t: "segment"; a: V; b: V; width: number; dash: Stroke["dash"]; layer: string }
  | { t: "circle"; c: V; r: number; width: number; dash: Stroke["dash"]; filled: boolean; layer: string }
  | { t: "arc"; a: V; m: V; b: V; width: number; dash: Stroke["dash"]; layer: string }
  | { t: "poly"; pts: V[]; width: number; dash: Stroke["dash"]; filled: boolean; layer: string }
  | { t: "bezier"; a: V; c1: V; c2: V; b: V; width: number; dash: Stroke["dash"]; layer: string };
/**
 * GRAPHICS_IMPORTER_BUFFER::ImportTo through an editor's importer: MapCoordinate (scale, then the offset, rounded to
 * the editor's internal unit `iu` in mm), MapLineWidth (the mean scale; a width of 0 or less takes `lineWidth`), and
 * `noStroke` for the width an unstroked shape gets (pcbnew 0, eeschema -1).
 */
export function toPrims(shapes: Imported[], o: { scale: [number, number]; offset: V; lineWidth: number; iu: number; noStroke: number; layerOk?: (layer: string) => boolean }): Prim[] {
  const q = (v: number): number => Math.round(v / o.iu) * o.iu;
  const mapP = (p: V): V => [+(q(p[0] * o.scale[0] + o.offset[0])).toFixed(6), +(q(p[1] * o.scale[1] + o.offset[1])).toFixed(6)];
  const k = (Math.abs(o.scale[0]) + Math.abs(o.scale[1])) / 2;
  const width = (s: Stroke): number => (s.width === -1 ? o.noStroke : +(q((s.width <= 0 ? o.lineWidth : s.width) * k)).toFixed(6));
  const out: Prim[] = [];
  for (const s of shapes) {
    if (o.layerOk && !o.layerOk(s.layer)) continue;
    const w = width(s.stroke), dash = s.stroke.dash;
    if (s.t === "line") { const a = mapP(s.a), b = mapP(s.b); if (a[0] !== b[0] || a[1] !== b[1]) out.push({ t: "segment", a, b, width: w, dash, layer: s.layer }); }
    else if (s.t === "circle") { const c = mapP(s.c), e = mapP([s.c[0] + s.r, s.c[1]]); out.push({ t: "circle", c, r: Math.hypot(e[0] - c[0], e[1] - c[1]), width: w, dash, filled: s.filled, layer: s.layer }); }
    else if (s.t === "arc") out.push({ t: "arc", a: mapP(s.a), m: mapP(s.m), b: mapP(s.b), width: w, dash, layer: s.layer });
    else if (s.t === "poly") { const pts = s.pts.map(mapP).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]); if (pts.length) out.push({ t: "poly", pts, width: w, dash, filled: s.filled, layer: s.layer }); }
    else {
      const a = mapP(s.a), c1 = mapP(s.c1), c2 = mapP(s.c2), b = mapP(s.b);
      if (straightBezier(a, c1, c2, b)) { if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 20e-6) out.push({ t: "segment", a, b, width: w, dash, layer: s.layer }); }
      else out.push({ t: "bezier", a, c1, c2, b, width: w, dash, layer: s.layer });
    }
  }
  return out;
}
/** ConnectBoardShapes in its simplest form: open ends closer than the tolerance are moved onto each other. */
export function fixDiscontinuities(prims: Prim[], tol: number): void {
  type End = { p: V };
  const ends: End[] = [];
  for (const s of prims) if (s.t === "segment" || s.t === "arc" || s.t === "bezier") { ends.push({ p: s.a }, { p: s.b }); }
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const a = ends[i].p, b = ends[j].p, d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > 0 && d <= tol) { const m: V = [+((a[0] + b[0]) / 2).toFixed(6), +((a[1] + b[1]) / 2).toFixed(6)]; a[0] = b[0] = m[0]; a[1] = b[1] = m[1]; }
  }
}
export const importerFor = (name: string): "svg" | "dxf" | null => { const e = name.toLowerCase().split(".").pop(); return e === "svg" ? "svg" : e === "dxf" ? "dxf" : null; };
