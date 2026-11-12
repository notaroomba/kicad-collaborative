/**
 * The measure tool's ruler: KIGFX::PREVIEW::RULER_ITEM (common/preview_items/ruler_item.cpp) with the
 * preview_utils.cpp helpers it uses (DimensionLabel, GetConstantGlyphHeight, DrawTextNextToCursor).
 * Drawn on the canvas in KiCad's stroke font, at a constant size on screen, with the drop-shadow pass
 * under the line pass as the GAL draws the two overlay layers.  Lengths are worked in nanometres (pcbIUScale).
 */

export type RulerUnits = "mm" | "in" | "mil";
type Pt = [number, number];

const IU_PER_MM = 1e6;
const MAX_TICK_DENSITY = 10.0;          // min pixels between tick marks
const MID_TICK_LENGTH_FACTOR = 1.5;
const MAJOR_TICK_LENGTH_FACTOR = 2.5;

/** EDA_ANGLE( VECTOR2D ): the exact cardinal and diagonal cases, atan2 otherwise (degrees, (-180, 180]). */
export function edaAngle(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  if (y === 0) return x >= 0 ? 0 : -180;
  if (x === 0) return y >= 0 ? 90 : -90;
  if (x === y) return x >= 0 ? 45 : -180 + 45;
  if (x === -y) return x >= 0 ? -45 : 180 - 45;
  return Math.atan2(y, x) * 180 / Math.PI;
}

/** printf's %.Nf: a negative zero keeps its sign ("-0.0"), as wxString::Format prints it. */
function fixed(v: number, d: number): string {
  const s = v.toFixed(d);
  return (Object.is(v, -0) || (v < 0 && !s.startsWith("-"))) ? "-" + s : s;
}

const UNIT_TEXT: Record<string, string> = { mm: " mm", in: " in", mil: " mils", deg: "°" };

/** KIGFX::PREVIEW::DimensionLabel: `aVal` in IU (nm) for lengths, degrees for "deg". */
export function dimensionLabel(prefix: string, val: number, units: RulerUnits | "deg", includeUnits = true): string {
  let str = prefix ? prefix + ": " : "";
  switch (units) {
    case "mm": str += fixed(val / IU_PER_MM, 3); break;
    case "mil": str += fixed(val / (IU_PER_MM * 0.0254), 1); break;
    case "in": str += fixed(val / (IU_PER_MM * 25.4), 4); break;
    default: str += fixed(val, 1); break;
  }
  return includeUnits ? str + UNIT_TEXT[units] : str;
}

/** RULER_ITEM::GetDimensionStrings for a ruler from `a` to `b` (nm). */
export function rulerStrings(a: Pt, b: Pt, units: RulerUnits, flipX = false, flipY = false): string[] {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const tx = flipX ? -vx : vx, ty = flipY ? -vy : vy;
  const ang = edaAngle(vx, vy);
  return [dimensionLabel("x", tx, units), dimensionLabel("y", ty, units), dimensionLabel("r", Math.hypot(vx, vy), units),
    dimensionLabel("θ", -ang, "deg")];
}

/** GetVectorSnapped45: the ruler end with Shift held (TWO_POINT_GEOMETRY_MANAGER, LEADER_MODE::DEG45). */
export function snapped45(origin: Pt, end: Pt): Pt {
  const x = end[0] - origin[0], y = end[1] - origin[1], ax = Math.abs(x), ay = Math.abs(y);
  let nx = x, ny = y;
  if (ax > ay * 2) ny = 0;
  else if (ay > ax * 2) nx = 0;
  else if (ax > ay) ny = Math.sign(y) < 0 || Object.is(y, -0) ? -ax : ax;
  else nx = Math.sign(x) < 0 || Object.is(x, -0) ? -ay : ay;
  return [origin[0] + nx, origin[1] + ny];
}

export interface TickFormat { divisionBase: number; majorStep: number; midStep: number }
const TICK_FORMATS: TickFormat[] = [
  { divisionBase: 2, majorStep: 10, midStep: 5 },    // |....:....|
  { divisionBase: 2, majorStep: 5, midStep: 0 },     // |....|
  { divisionBase: 2.5, majorStep: 2, midStep: 0 },   // |.|.|
];

/** getTickFormatForScale: `scale` is screen pixels per IU; the tick space comes back in IU. */
export function tickFormatForScale(scale: number, units: RulerUnits): { format: TickFormat; space: number } {
  let space = 1;
  if (units !== "mm") space *= 2.54;
  let f = 0;
  for (let guard = 0; guard < 200; guard++) {
    if (space * scale >= MAX_TICK_DENSITY) break;
    f = (f + 1) % TICK_FORMATS.length;
    space *= TICK_FORMATS[f].divisionBase;
  }
  return { format: TICK_FORMATS[f], space };
}

/** GetConstantGlyphHeight (the non-HiDPI table), in IU at `scale` pixels per IU. */
export function glyphDims(scale: number, rel = 0): { size: number; stroke: number; shadow: number; pitch: number } {
  const sizes = [8, 10, 12, 14, 15, 16, 18];
  const h = sizes[3 + rel] / scale;
  return { size: h, stroke: h * 0.2, shadow: h * 0.15, pitch: h * 1.9 };
}

/** One stroke of the ruler: a line, or a text run (KiCad stroke font, centred vertically). */
export type RulerOp =
  | { kind: "line"; a: Pt; b: Pt; w: number; shadow: boolean }
  | { kind: "text"; text: string; at: Pt; size: number; pen: number; rot: number; h: "left" | "right"; shadow: boolean };

export interface RulerView {
  scale: number;                       // screen pixels per IU (GAL::GetWorldScale)
  toScreen(p: Pt): Pt;                 // IU -> screen pixels
  screen: Pt;                          // the canvas size in pixels
  viewport: [number, number, number, number];   // the visible area, IU: x0, y0, x1, y1
  textWidth(text: string, size: number, pen: number): number;   // FONT::StringBoundaryLimits().x
}

const resize = (v: Pt, len: number): Pt => { const n = Math.hypot(v[0], v[1]); return n ? [v[0] * len / n, v[1] * len / n] : [0, 0]; };
const rot90 = (v: Pt): Pt => [v[1], -v[0]];          // RotatePoint( v, ANGLE_90 )
const rotM90 = (v: Pt): Pt => [-v[1], v[0]];         // RotatePoint( v, -ANGLE_90 )
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

/** drawTicksAlongLine */
function ticksAlongLine(ops: RulerOp[], view: RulerView, origin: Pt, line: Pt, minorLen: number, units: RulerUnits, shadow: boolean): void {
  const { format, space } = tickFormatForScale(view.scale, units);
  const majorLen = minorLen * (MAJOR_TICK_LENGTH_FACTOR + 1);
  const tickLine = rot90(line);
  const rulerLen = Math.hypot(line[0], line[1]);
  if (!(rulerLen > 0) || !(space > 0) || !isFinite(rulerLen)) return;
  const lastRulerTick = Math.max(0, Math.ceil(rulerLen / space) - 1);
  const dims = glyphDims(view.scale, -1);
  const labelAngle = -edaAngle(tickLine[0], tickLine[1]);
  const labelOffset = resize(tickLine, majorLen);
  let stroke = dims.stroke, shadowX = 0;
  if (shadow) { stroke += 2 * dims.shadow; shadowX = dims.shadow * 1.2; }
  let h: "left" | "right", rot: number;
  if (edaAngle(line[0], line[1]) > 0) {
    h = "left"; rot = labelAngle;
    labelOffset[0] -= shadowX * Math.cos(rot * Math.PI / 180); labelOffset[1] += shadowX * Math.sin(rot * Math.PI / 180);
  } else {
    h = "right"; rot = labelAngle + 180;
    labelOffset[0] += shadowX * Math.cos(rot * Math.PI / 180); labelOffset[1] -= shadowX * Math.sin(rot * Math.PI / 180);
  }
  // only the ticks whose projection on the ruler falls in the (inflated) viewport
  const inf = majorLen * 2, vp = view.viewport;
  const ux = line[0] / rulerLen, uy = line[1] / rulerLen;
  const cx = (vp[0] + vp[2]) / 2, cy = (vp[1] + vp[3]) / 2, hw = (vp[2] - vp[0]) / 2 + inf, hh = (vp[3] - vp[1]) / 2 + inf;
  const cp = (cx - origin[0]) * ux + (cy - origin[1]) * uy, hp = Math.abs(hw * ux) + Math.abs(hh * uy);
  if (!isFinite(cp - hp) || !isFinite(cp + hp)) return;
  const first = Math.max(0, Math.floor((cp - hp) / space) - 1), last = Math.min(lastRulerTick, Math.ceil((cp + hp) / space) + 1);
  const dir: Pt = [tickLine[0] / rulerLen, tickLine[1] / rulerLen];
  for (let i = first; i <= last; i++) {
    const pos: Pt = [origin[0] + ux * space * i, origin[1] + uy * space * i];
    let len = minorLen, label = false;
    if (i % format.majorStep === 0) { label = true; len *= MAJOR_TICK_LENGTH_FACTOR; }
    else if (format.midStep && i % format.midStep === 0) { label = true; len *= MID_TICK_LENGTH_FACTOR; }
    ops.push({ kind: "line", a: pos, b: [pos[0] + dir[0] * len, pos[1] + dir[1] * len], w: stroke / 2, shadow });
    if (label) ops.push({ kind: "text", text: dimensionLabel("", space * i, units, false), at: add(pos, labelOffset), size: dims.size, pen: stroke, rot, h, shadow });
  }
}

/** drawBacksideTicks */
function backsideTicks(ops: RulerOp[], view: RulerView, origin: Pt, line: Pt, tickLen: number, divisions: number, shadow: boolean): void {
  const dims = glyphDims(view.scale, -1);
  const space = Math.hypot(line[0], line[1]) / divisions;
  const back = resize(rotM90(line), tickLen);
  const inf = tickLen * 4, vp = view.viewport;
  for (let i = 0; i < divisions + 1; i++) {
    const p = add(origin, resize(line, space * i));
    if (p[0] < vp[0] - inf || p[0] > vp[2] + inf || p[1] < vp[1] - inf || p[1] > vp[3] + inf) continue;
    ops.push({ kind: "line", a: p, b: add(p, back), w: dims.stroke * 0.8 + (shadow ? dims.shadow : 0), shadow });
  }
}

/** DrawTextNextToCursor */
function textNextToCursor(ops: RulerOp[], view: RulerView, cursor: Pt, quadrant: Pt, strings: string[], shadow: boolean): void {
  const dims = glyphDims(view.scale);
  const pos: Pt = [cursor[0], cursor[1]];
  if (quadrant[1] > 0) pos[1] -= dims.pitch * (strings.length + 1);
  let h: "left" | "right";
  if (quadrant[0] < 0) { h = "left"; pos[0] += 15 / view.scale; }
  else { h = "right"; pos[0] -= 15 / view.scale; }
  const sx = shadow ? Math.trunc(Math.trunc(dims.shadow) * 1.2) : 0;   // an int in IU, scaled by 1.2 and truncated again
  pos[0] += h === "left" ? -sx : sx;
  const pen = shadow ? dims.stroke + 2 * dims.shadow : dims.stroke;
  for (const s of strings) { pos[1] += dims.pitch; ops.push({ kind: "text", text: s, at: [pos[0], pos[1]], size: dims.size, pen, rot: 0, h, shadow }); }
}

/** RULER_ITEM::ViewDraw for one layer (the drop-shadow layer, then the overlay layer). */
function rulerPass(ops: RulerOp[], view: RulerView, origin: Pt, end: Pt, units: RulerUnits, shadow: boolean, flip: [boolean, boolean]): void {
  const dims = glyphDims(view.scale);
  const lineW = dims.stroke * 0.8 + (shadow ? dims.shadow : 0);
  ops.push({ kind: "line", a: origin, b: end, w: lineW, shadow });
  const vec: Pt = [end[0] - origin[0], end[1] - origin[1]];
  const strings = rulerStrings(origin, end, units, flip[0], flip[1]);
  // a text quadrant that keeps the readout on screen, preferring the side away from the origin
  const prefX = vec[1] < 0 ? -1 : 1, prefY = vec[0] < 0 ? 1 : -1;
  let width = 0; for (const s of strings) width = Math.max(width, view.textWidth(s, dims.size, dims.stroke));
  const height = dims.pitch * strings.length, scale = view.scale;
  const cs = view.toScreen(end), offX = 15, offY = dims.pitch * scale;
  const fits = (sx: number, sy: number): boolean => {
    const x0 = cs[0] + (sx < 0 ? offX : -offX);
    const left = sx < 0 ? x0 : x0 - width * scale, right = sx < 0 ? x0 + width * scale : x0;
    const bottom = sy > 0 ? cs[1] - offY : cs[1] + offY + height * scale, top = sy > 0 ? bottom - height * scale : cs[1] + offY;
    return left >= 0 && right <= view.screen[0] && top >= 0 && bottom <= view.screen[1];
  };
  const cands: Pt[] = [[prefX, prefY], [-prefX, prefY], [prefX, -prefY], [-prefX, -prefY]];
  let chosen = cands[0], best = -1;
  for (const c of cands) { const dot = c[0] * prefX + c[1] * prefY; if (dot >= 0 && fits(c[0], c[1]) && dot > best) { best = dot; chosen = c; } }
  textNextToCursor(ops, view, end, chosen, strings, shadow);
  const minor = 5 / scale, major = minor * MAJOR_TICK_LENGTH_FACTOR;
  ticksAlongLine(ops, view, origin, vec, minor, units, shadow);
  backsideTicks(ops, view, origin, vec, major, 2, shadow);
  // the back of the origin "crosshair"
  ops.push({ kind: "line", a: origin, b: add(origin, resize(vec, -minor * MID_TICK_LENGTH_FACTOR)), w: lineW, shadow });
}

/** The whole ruler as draw operations, shadow pass first.  Nothing while the origin and the end coincide (ViewBBox is empty). */
export function rulerOps(origin: Pt, end: Pt, units: RulerUnits, view: RulerView, flip: [boolean, boolean] = [false, false]): RulerOp[] {
  const ops: RulerOp[] = [];
  if (origin[0] === end[0] && origin[1] === end[1]) return ops;
  rulerPass(ops, view, origin, end, units, true, flip);
  rulerPass(ops, view, origin, end, units, false, flip);
  return ops;
}

/** GetShadowColor: black under a bright colour, white under a dark one. */
export function shadowColor(hex: string): string {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 0.299 + g * 0.587 + b * 0.117) / 255 > 0.5 ? "#000000" : "#ffffff";   // COLOR4D::GetBrightness
}
