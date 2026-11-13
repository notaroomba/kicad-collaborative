import type { EditFollower, EditPoints, PointEdit, PtrEvent, SchCtx, Pt, Box } from "./types";
import { restoreNode } from "./drag";
import { TEXTBOX_MARGIN } from "./nodes";
import { mmPerPx, snapConn } from "./snap";
import { K, S, atOf, kid, kids, num, ptsOf, setPts, str } from "./state";
import { deep, modChange, r4, same } from "./util";

// ---------------------------------------------------------------- point editor (eeschema/tools/sch_point_editor.cpp)
// A single selected line, shape, text box, sheet or rule area shows KiCad's edit points; dragging one reshapes
// the item ("Move Point").  Rectangles, text boxes and sheets also get the four edge handles (EDIT_LINE midpoints)
// that move one side; a rectangle's centre point moves it whole.  Graphic lines drag the graphic line joined at
// the edited end (LINE_POINT_EDIT_BEHAVIOR, notes layer only); a sheet's pins stay on their edges
// (SCH_SHEET::Resize / ConstrainOnEdge) and the wires and no-connects on them follow.
export const PE_MIN = 0.0254;                                   // schIUScale.MilsToIU( 1 )
export const RECT_LINES = [[0, 1], [1, 3], [3, 2], [2, 0]];      // RECT_TOP, RECT_RIGHT, RECT_BOT, RECT_LEFT
export function boxOf(item: Pick<KItem, "kind" | "node">): Box {
  const n = item.node;
  if (item.kind === "rectangle") { const s = kid(n, "start")!, e = kid(n, "end")!; return [Math.min(num(s[1]), num(e[1])), Math.min(num(s[2]), num(e[2])), Math.max(num(s[1]), num(e[1])), Math.max(num(s[2]), num(e[2]))]; }
  const at = kid(n, "at")!, sz = kid(n, "size")!; const x = num(at[1]), y = num(at[2]), w = num(sz[1]), h = num(sz[2]);
  return [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)];
}
export const rectRadius = (n: SNode): number => { const r = kid(n, "radius"); return r ? Math.max(0, num(r[1])) : 0; };
// Dragging RECT_RADIUS: x clamped to [ right - min( w, h ) / 2, right ], radius = right - x.
export function rectRadiusFor(box: Box, x: number): number {
  const maxR = Math.min(box[2] - box[0], box[3] - box[1]) / 2;
  return box[2] - Math.min(Math.max(x, box[2] - maxR), box[2]);
}
export function circleOf(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
export const kp = (n: SNode, key: string): Pt | null => { const k = kid(n, key); return k ? [num(k[1]), num(k[2])] : null; };
// The edit points of an item: { pts, lines (edge handles, by point index pairs), guides (indicator lines) } or null.
export function editPoints(doc: KDoc, item: KItem): EditPoints | null {
  if (!item) return null;
  const k = item.kind, n = item.node;
  if (k === "wire" || k === "bus" || k === "polyline" || k === "bezier") {
    const pts = ptsOf(n); if (pts.length < 2) return null;
    // a graphic polyline of more than two points is a SHAPE_T::POLY: EDA_POLYGON_POINT_EDIT_BEHAVIOR gives it edge handles
    if (k === "polyline" && pts.length > 2) return { pts, lines: polyLines(pts.length), guides: [] };
    return { pts, lines: [], guides: k === "bezier" && pts.length === 4 ? [[0, 1], [3, 2]] : [] };
  }
  if (k === "rule_area") { const pl = kid(n, "polyline"); const pts = pl ? ptsOf(pl) : []; return pts.length ? { pts, lines: pts.length > 1 ? polyLines(pts.length) : [], guides: [] } : null; }
  if (k === "rectangle" || k === "text_box" || k === "sheet") {
    const [x0, y0, x1, y1] = boxOf(item);
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    if (k !== "sheet") pts.push([(x0 + x1) / 2, (y0 + y1) / 2]);     // RECT_CENTER
    // RECT_RADIUS (RECTANGLE_POINT_EDIT_BEHAVIOR::MakePoints): a circle at ( right - corner radius, top ).  Text boxes
    // get it in KiCad too, but the file format keeps no text box radius, so only rectangles carry it here.
    if (k === "rectangle") { pts.push([x1 - rectRadius(n), y0]); return { pts, lines: RECT_LINES, guides: [], circles: [5] }; }
    return { pts, lines: RECT_LINES, guides: [] };
  }
  if (k === "image") {
    // REFERENCE_IMAGE_POINT_EDIT_BEHAVIOR: the bounding box's corners, the transform origin and the rotation handle,
    // with the box outline and the origin-to-handle line as indicator lines
    const g = imageGeom(item); if (!g) return null;
    const [bw, bh] = imageBoundingSize(g.w, g.h, g.rot), [x, y] = g.pos, off = imageOriginOffset(item.id);
    const origin: Pt = [x + off[0], y + off[1]];
    const local = rotDeg(off, -g.rot), len = local[1] + g.h * 0.7, toRot = rotDeg([0, -len], g.rot);
    return { pts: [[x - bw / 2, y - bh / 2], [x + bw / 2, y - bh / 2], [x + bw / 2, y + bh / 2], [x - bw / 2, y + bh / 2], origin, [origin[0] + toRot[0], origin[1] + toRot[1]]],
      lines: [], guides: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5]] };
  }
  if (k === "ellipse" || k === "ellipse_arc") {
    // EDA_ELLIPSE_POINT_EDIT_BEHAVIOR::MakePoints: centre, major end ( t = 0 ), minor end ( t = 90 ), and for an arc its
    // start and end with indicator lines from the centre
    const e = ellipseOf(n); if (!e) return null;
    const pts = [e.c, ellipseAt(e, 0), ellipseAt(e, 90)];
    if (k === "ellipse_arc") { pts.push(ellipseAt(e, e.t0), ellipseAt(e, e.t1)); return { pts, lines: [], guides: [[0, 3], [0, 4]] }; }
    return { pts, lines: [], guides: [] };
  }
  if (k === "circle") { const c = kp(n, "center"), r = num((kid(n, "radius") || [])[1]); return c ? { pts: [c, [c[0] + r, c[1]]], lines: [], guides: [] } : null; }
  if (k === "arc") {
    const s = kp(n, "start"), m = kp(n, "mid"), e = kp(n, "end"); if (!s || !m || !e) return null;
    const c = circleOf(s, m, e); if (!c) return null;
    return { pts: [s, m, e, c], lines: [], guides: [[3, 0], [3, 2]] };            // ARC_START, ARC_MID, ARC_END, ARC_CENTER
  }
  return null;
}
/**
 * POLYGON_POINT_EDIT_BEHAVIOR::BuildForPolyOutline: an edge from each corner to the next, and the closing one from
 * the last corner back to the first (one contour; schematic shapes have no holes).
 */
export function polyLines(n: number): number[][] { const out: number[][] = []; for (let i = 0; i < n; i++) out.push([i, (i + 1) % n]); return out; }
const sub2 = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]], add2 = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]], dot2 = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
/** SEG::IntersectLines: the two infinite lines a1-a2 and b1-b2 meet here, or null when parallel. */
export function lineX(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const r = sub2(a2, a1), s = sub2(b2, b1), den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * s[1] - (b1[1] - a1[1]) * s[0]) / den; return [a1[0] + t * r[0], a1[1] + t * r[1]];
}
/** SEG::Intersect: the two segments cross (ends included), or null. */
export function segX(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const r = sub2(a2, a1), s = sub2(b2, b1), den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * s[1] - (b1[1] - a1[1]) * s[0]) / den, u = ((b1[0] - a1[0]) * r[1] - (b1[1] - a1[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a1[0] + t * r[0], a1[1] + t * r[1]] : null;
}
/** SEG::Angle: the angle between two segments' directions, degrees in [0, 180]. */
function segAngle(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  const n180 = (d: number) => { while (d <= -180) d += 360; while (d > 180) d -= 360; return d; };
  const ta = n180(Math.atan2(a1[1] - a2[1], a1[0] - a2[0]) * 180 / Math.PI), tb = n180(Math.atan2(b1[1] - b2[1], b1[0] - b2[0]) * 180 / Math.PI);
  return Math.abs(n180(ta - tb));
}
/**
 * POLYGON_EDGE_DRAG_POLICY (CONVERGING, the schematic's mode): the dragged edge `line` of the closed outline `pts`
 * moves parallel to itself through the handle; its corners slide along the neighbouring sides, the centre stops at
 * the sides' convergence point, and two collinear neighbours keep the corners on that line.  Returns the new corners.
 */
export function polygonEdgeDrag(pts: Pt[], line: number, handle: Pt): Pt[] {
  const n = pts.length, out = pts.map((q) => q.slice());
  const oi = line, ei = (line + 1) % n, pi = (oi - 1 + n) % n, ni = (ei + 1) % n;
  const O = pts[oi], Eo = pts[ei], prev = pts[pi], next = pts[ni];
  const originSideDir = sub2(O, prev), endSideDir = sub2(Eo, next), dragged = sub2(Eo, O);
  const center: Pt = [(O[0] + Eo[0]) / 2, (O[1] + Eo[1]) / 2], perp: Pt = [-dragged[1], dragged[0]];
  const triangle = pi === ni;
  const originCollinear = segAngle(O, Eo, O, prev) < 10, endCollinear = segAngle(O, Eo, Eo, next) < 10;
  const conv = lineX(O, prev, Eo, next) || center;
  // Apply: the new centre is where the line through the handle (parallel to the edge) crosses the edge's perpendicular
  let nc = lineX(center, add2(center, perp), handle, add2(handle, dragged)) || handle;
  if (!triangle) { const den = dot2(sub2(conv, center), perp); if (den !== 0 && dot2(sub2(nc, center), perp) / den > 1) nc = conv; }
  // applyConverging
  let o: Pt = out[oi], e: Pt = out[ei];
  if (originCollinear && endCollinear) {
    const proj = (q: Pt) => { const d = originSideDir, l2 = dot2(d, d); if (!l2) return q; const t = dot2(sub2(q, prev), d) / l2; return [prev[0] + t * d[0], prev[1] + t * d[1]] as Pt; };
    out[oi] = proj(add2(nc, [-dragged[0] / 2, -dragged[1] / 2])); out[ei] = proj(add2(nc, [dragged[0] / 2, dragged[1] / 2]));
    return out;
  }
  const d0 = add2(nc, [-dragged[0] / 2, -dragged[1] / 2]), d1 = add2(nc, [dragged[0] / 2, dragged[1] / 2]);
  o = lineX(d0, d1, prev, add2(prev, originSideDir)) || O; e = lineX(d0, d1, next, add2(next, endSideDir)) || Eo;
  if (!triangle) { const x = segX(e, next, o, prev); if (x) { o = x; e = x; } }
  out[oi] = o; out[ei] = e;
  return out;
}
/** An ellipse's ELLIPSE<int> fields from its node (mm, degrees). */
export function ellipseOf(n: SNode): { c: Pt; a: number; b: number; phi: number; t0: number; t1: number } | null {
  const c = kp(n, "center"); if (!c) return null;
  const v = (key: string) => num((kid(n, key) || [])[1], 0);
  return { c, a: v("major_radius"), b: v("minor_radius"), phi: v("rotation_angle"), t0: v("start_angle"), t1: v("end_angle") };
}
/** ELLIPSE::GetPointAtAngle (degrees). */
export function ellipseAt(e: { c: Pt; a: number; b: number; phi: number }, deg: number): Pt {
  const t = deg * Math.PI / 180, r = e.phi * Math.PI / 180, ex = e.a * Math.cos(t), ey = e.b * Math.sin(t);
  return [e.c[0] + ex * Math.cos(r) - ey * Math.sin(r), e.c[1] + ex * Math.sin(r) + ey * Math.cos(r)];
}
/** ELLIPSE::GetAngleAtPoint (degrees): the parametric angle of a point, radii floored at 1 IU. */
export function ellipseAngleAt(e: { c: Pt; a: number; b: number; phi: number }, p: Pt): number {
  const a = Math.max(PE_IU, e.a), b = Math.max(PE_IU, e.b), r = e.phi * Math.PI / 180, dx = p[0] - e.c[0], dy = p[1] - e.c[1];
  const lx = dx * Math.cos(r) + dy * Math.sin(r), ly = -dx * Math.sin(r) + dy * Math.cos(r);
  return Math.atan2(ly / b, lx / a) * 180 / Math.PI;
}
const PE_IU = 1e-4;
/** RotatePoint( v, angle ): positive degrees turn counter-clockwise on the Y-down screen. */
export function rotDeg(v: Pt, deg: number): Pt { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c]; }
/** An image's position, unrotated size (mm, from the canvas's decoded bitmap), orientation and scale. */
export function imageGeom(item: KItem): { pos: Pt; w: number; h: number; rot: number; scale: number } | null {
  const n = item.node, a = kid(n, "at"); if (!a) return null;
  const sc = kid(n, "scale"), r = kid(n, "rotate");
  return { pos: [num(a[1]), num(a[2])], w: item.w || 10, h: item.h || 10, rot: r ? num(r[1], 0) : 0, scale: sc ? num(sc[1], 1) : 1 };
}
/** REFERENCE_IMAGE::boundingSize: the axis-aligned extent of the turned raster. */
export function imageBoundingSize(w: number, h: number, rot: number): Pt {
  const a = ((rot % 360) + 360) % 360;
  if (a === 0 || a === 180) return [w, h];
  if (a === 90 || a === 270) return [h, w];
  const c = Math.abs(Math.cos(a * Math.PI / 180)), s = Math.abs(Math.sin(a * Math.PI / 180));
  return [w * c + h * s, w * s + h * c];
}
export function imageOriginOffset(id: string): Pt { const o = S.imgOrigin && S.imgOrigin.get(id); return o ? o.slice() : [0, 0]; }
function setImageOriginOffset(id: string, o: Pt) { (S.imgOrigin || (S.imgOrigin = new Map())).set(id, o); }
export const IMAGE_MIN_SIZE = 50 * 0.0254;                       // schIUScale.MilsToIU( 50 )
/** Set or drop a token right after (at …): (rotate a) / (scale s), written only when not the default. */
function setImageToken(n: SNode, key: string, v: number, dflt: number) {
  const k = kid(n, key), i = k ? n.indexOf(k) : -1;
  if (Math.abs(v - dflt) < 1e-12) { if (i >= 0) n.splice(i, 1); return; }
  if (k) { k[1] = v; return; }
  const after = key === "scale" ? (kid(n, "rotate") || kid(n, "at")) : kid(n, "at");
  n.splice(after ? n.indexOf(after) + 1 : 1, 0, [key, v]);
}                                              // one schematic IU (100 nm)
// Handles in pick order: the points, then each edge's midpoint (index pts.length + line).
export function editHandles(ep: EditPoints): Pt[] { return ep.pts.concat(ep.lines.map(([a, b]) => [(ep.pts[a][0] + ep.pts[b][0]) / 2, (ep.pts[a][1] + ep.pts[b][1]) / 2])); }
export const normA = (a: number) => { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
// The arc through start and end on circle c, swept the way the original arc went: its true midpoint.
export function arcMid(c: Pt, s: Pt, e: Pt, ccw: boolean): Pt {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = Math.atan2(e[1] - c[1], e[0] - c[0]), r = Math.hypot(s[0] - c[0], s[1] - c[1]);
  const am = ccw ? a0 + normA(a1 - a0) / 2 : a0 - normA(a0 - a1) / 2;
  return [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)];
}
export const resize = (c: Pt, v: Pt, r: number): Pt => { const l = Math.hypot(v[0], v[1]) || 1; return [c[0] + v[0] / l * r, c[1] + v[1] / l * r]; };
// PinEditedCorner: the edited corner (or edge) stays inside the opposite one by the minimum size.
export function pinCorner(idx: number, tl: Pt, tr: Pt, bl: Pt, br: Pt, minW: number, minH: number) {
  if (idx === 0) { tl[0] = Math.min(tl[0], br[0] - minW); tl[1] = Math.min(tl[1], br[1] - minH); tr[1] = tl[1]; bl[0] = tl[0]; }
  else if (idx === 1) { tr[0] = Math.max(tr[0], bl[0] + minW); tr[1] = Math.min(tr[1], bl[1] - minH); tl[1] = tr[1]; br[0] = tr[0]; }
  else if (idx === 2) { bl[0] = Math.min(bl[0], tr[0] - minW); bl[1] = Math.max(bl[1], tr[1] + minH); br[1] = bl[1]; tl[0] = bl[0]; }
  else if (idx === 3) { br[0] = Math.max(br[0], tl[0] + minW); br[1] = Math.max(br[1], tl[1] + minH); bl[1] = br[1]; tr[0] = br[0]; }
}
// The new box for a dragged corner (0..3), centre (4, rectangles only) or edge (lines: top, right, bottom, left).
export function editBox(box: Box, ep: EditPoints, idx: number, p: Pt, minW: number, minH: number): Box {
  let [x0, y0, x1, y1] = box;
  const np = ep.pts.length;
  if (idx < 4) {
    const tl = [x0, y0], tr = [x1, y0], bl = [x0, y1], br = [x1, y1], c = [tl, tr, bl, br][idx];
    c[0] = p[0]; c[1] = p[1];
    if (idx === 0) { tr[1] = p[1]; bl[0] = p[0]; } else if (idx === 1) { tl[1] = p[1]; br[0] = p[0]; } else if (idx === 2) { br[1] = p[1]; tl[0] = p[0]; } else { bl[1] = p[1]; tr[0] = p[0]; }
    pinCorner(idx, tl, tr, bl, br, minW, minH);
    return [tl[0], tl[1], br[0], br[1]];
  }
  if (idx === 4 && np >= 5) { const dx = p[0] - (x0 + x1) / 2, dy = p[1] - (y0 + y1) / 2; return [x0 + dx, y0 + dy, x1 + dx, y1 + dy]; }
  const edge = idx - np;
  if (edge === 0) y0 = Math.min(p[1], y1 - minH); else if (edge === 1) x1 = Math.max(p[0], x0 + minW);
  else if (edge === 2) y1 = Math.max(p[1], y0 + minH); else if (edge === 3) x0 = Math.min(p[0], x1 - minW);
  return [x0, y0, x1, y1];
}
// Sheet minimum size (SCH_SHEET::GetMinWidth / GetMinHeight): the pins on the moving edges' perpendicular sides keep fitting.
export function sheetMin(node: SNode, box: Box, fromRight: boolean, fromBottom: boolean) {
  let w = PE_MIN, h = PE_MIN;
  for (const pin of kids(node, "pin")) {
    const [x, y, rot] = atOf(pin), r = ((Math.round(rot || 0) % 360) + 360) % 360;
    if (r === 90 || r === 270) w = Math.max(w, fromRight ? x - box[0] : box[2] - x);
    else h = Math.max(h, fromBottom ? y - box[1] : box[3] - y);
  }
  return [w, h];
}
// SCH_TEXTBOX::GetMinSize: the text's own box height (EDA_TEXT::GetTextBox: the stroke glyph extent inflated by
// 1.5 x pen width each side, + 17 %, + an interline pitch per further line, + an overbar's sixth) plus the top
// and bottom margins — or, for vertical text, that plus the left and right margins as a minimum width.  Empty
// text: no minimum.
export function textBoxMinSize(node: SNode): Pt {
  const text = str(node[1]); if (!text) return [0, 0];
  const ef = kid(node, "effects"), f = ef && kid(ef, "font"), sz = f && kid(f, "size"), th = f && kid(f, "thickness"), ls = f && kid(f, "line_spacing");
  const size = sz ? num(sz[2], num(sz[1], 1.27)) : 1.27, bold = !!(f && (f.includes("bold") || (kid(f, "bold") && str(kid(f, "bold")![1]) !== "no")));
  const pen = th && num(th[1]) > 0.001 ? num(th[1]) : Math.min(bold ? size / 5 : size / 8, size / 4);
  const lines = text.split("\n").length, ext = size + 2 * 1.5 * pen;
  let h = ext + 0.17 * ext + (lines - 1) * size * 1.68 * 0.9583 * (ls ? num(ls[1], 1) : 1);
  if (text.includes("~{")) h += ext / 6;
  const mg = kid(node, "margins"), m = mg ? [num(mg[1]), num(mg[2]), num(mg[3]), num(mg[4])] : [TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN];
  const rot = Math.round(num((kid(node, "at") || [])[3], 0)) % 180;
  return rot === 90 ? [r4(h + m[0] + m[2]), 0] : [0, r4(h + m[1] + m[3])];
}
// Apply a dragged edit point: mutates the item's node (and its followers') in place, from the originals in pe.
export function applyPointEdit(doc: KDoc, pe: PointEdit, p: Pt) {
  const item = pe.item, n = item.node, k = item.kind, ep = pe.ep, idx = pe.idx;
  restoreNode(n, pe.orig); for (const f of pe.followers) restoreNode(f.item.node, f.orig);
  const touched = [item];
  if ((k === "polyline" || k === "rule_area") && idx >= ep.pts.length) {
    const pts = polygonEdgeDrag(ep.pts, idx - ep.pts.length, p).map((q) => [r4(q[0]), r4(q[1])]);
    setPts(k === "rule_area" ? kid(n, "polyline")! : n, pts);
  } else if (k === "wire" || k === "bus" || k === "polyline" || k === "bezier") {
    const pts = ep.pts.map((q: Pt) => q.slice()); pts[idx] = [r4(p[0]), r4(p[1])]; setPts(n, pts);
    for (const f of pe.followers) if (f.end === idx) { const q: Pt[] = ptsOf(f.item.node); q[f.index!] = pts[idx].slice(); setPts(f.item.node, q); touched.push(f.item); }
  } else if (k === "rule_area") {
    const pl = kid(n, "polyline")!, pts = ep.pts.map((q: Pt) => q.slice()); pts[idx] = [r4(p[0]), r4(p[1])]; setPts(pl, pts);
  } else if (k === "image") {
    // REFERENCE_IMAGE_POINT_EDIT_BEHAVIOR::UpdateItem
    const g = imageGeom({ ...item, node: pe.orig, w: pe.imgSize0 ? pe.imgSize0[0] : item.w, h: pe.imgSize0 ? pe.imgSize0[1] : item.h } as KItem)!, off0 = pe.imgOrigin0 || [0, 0];
    setImageOriginOffset(item.id, off0.slice());
    const origin: Pt = [g.pos[0] + off0[0], g.pos[1] + off0[1]];
    if (idx === 4) setImageOriginOffset(item.id, [p[0] - g.pos[0], p[1] - g.pos[1]]);
    else if (idx === 5) {
      // Rotate( origin, target - orientation ): the handle points the image's up direction at the cursor
      const cv = [p[0] - origin[0], p[1] - origin[1]];
      const target = Math.atan2(-cv[1], cv[0]) * 180 / Math.PI - 90, d = target - g.rot;
      const np = rotDeg([g.pos[0] - origin[0], g.pos[1] - origin[1]], d), at = kid(n, "at")!;
      at[1] = r4(origin[0] + np[0]); at[2] = r4(origin[1] + np[1]);
      setImageOriginOffset(item.id, rotDeg(off0, d));
      let a = (g.rot + d) % 360; if (a < 0) a += 360; setImageToken(n, "rotate", +a.toFixed(4), 0);
    } else if (idx < 4) {
      const size = imageBoundingSize(g.w, g.h, g.rot), sx = [-1, 1, 1, -1][idx], sy = [-1, -1, 1, 1][idx];
      const oldCorner: Pt = [g.pos[0] + sx * size[0] / 2 - origin[0], g.pos[1] + sy * size[1] / 2 - origin[1]];
      let nc: Pt = [p[0] - origin[0], p[1] - origin[1]];
      if (Math.sign(nc[0]) !== Math.sign(oldCorner[0]) || Math.sign(nc[1]) !== Math.sign(oldCorner[1])) nc = [0, 0];   // never across the origin
      const oldLen = Math.hypot(oldCorner[0], oldCorner[1]);
      let ratio = oldLen > 0 ? Math.hypot(nc[0], nc[1]) / oldLen : 1;
      ratio = Math.min(Math.max(size[0] * ratio, IMAGE_MIN_SIZE) / size[0], Math.max(size[1] * ratio, IMAGE_MIN_SIZE) / size[1]);
      if (ratio > 0 && isFinite(ratio)) {
        // scaleBy: the transform origin stays put, the centre and the offset scale about it
        const noff: Pt = [off0[0] * ratio, off0[1] * ratio], at = kid(n, "at")!;
        at[1] = r4(origin[0] - noff[0]); at[2] = r4(origin[1] - noff[1]);
        setImageOriginOffset(item.id, noff);
        setImageToken(n, "scale", +(g.scale * ratio).toPrecision(6), 1);
      }
    }
  } else if (k === "ellipse" || k === "ellipse_arc") {
    // EDA_ELLIPSE_POINT_EDIT_BEHAVIOR::UpdateItem
    const e = ellipseOf(pe.orig)!;
    const set = (key: string, v: number) => { const kk = kid(n, key); v = r4(v); if (kk) kk[1] = v; else n.push([key, v]); };
    if (idx === 0) { const ck = kid(n, "center")!; ck[1] = r4(p[0]); ck[2] = r4(p[1]); }
    else if (idx === 1) { const v = [p[0] - e.c[0], p[1] - e.c[1]]; set("major_radius", Math.max(PE_IU, Math.hypot(v[0], v[1]))); set("rotation_angle", Math.atan2(v[1], v[0]) * 180 / Math.PI); }
    else if (idx === 2) { const r = e.phi * Math.PI / 180, v = [p[0] - e.c[0], p[1] - e.c[1]]; set("minor_radius", Math.max(PE_IU, Math.abs(-v[0] * Math.sin(r) + v[1] * Math.cos(r)))); }
    else if (k === "ellipse_arc") {
      const prev = idx === 3 ? e.t0 : e.t1; let raw = ellipseAngleAt(e, p);
      while (raw - prev > 180) raw -= 360; while (prev - raw > 180) raw += 360;
      if (idx === 3) { set("start_angle", raw); set("end_angle", raw + (e.t1 - e.t0)); } else set("end_angle", raw);
    }
  } else if (k === "circle") {
    const c = ep.pts[0];
    if (idx === 0) { const ck = kid(n, "center")!; ck[1] = r4(p[0]); ck[2] = r4(p[1]); }
    else { const rk = kid(n, "radius")!; rk[1] = r4(Math.max(PE_MIN, Math.hypot(p[0] - c[0], p[1] - c[1]))); }
  } else if (k === "arc") {
    const [s, m, e, c] = ep.pts, ccw = normA(Math.atan2(m[1] - c[1], m[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0])) < normA(Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]));
    let ns = s, ne = e, cc = c;
    if (idx === 3) { const dx = p[0] - c[0], dy = p[1] - c[1]; ns = [s[0] + dx, s[1] + dy]; ne = [e[0] + dx, e[1] + dy]; cc = p; }
    else if (idx === 1) { const r = Math.max(PE_MIN, Math.hypot(p[0] - c[0], p[1] - c[1])); ns = resize(c, [s[0] - c[0], s[1] - c[1]], r); ne = resize(c, [e[0] - c[0], e[1] - c[1]], r); }   // EditArcMidKeepCenter
    else {                                                                                                                                            // EditArcEndpointKeepCenter
      const mv = idx === 0 ? s : e, other = idx === 0 ? e : s;
      let v1: Pt = [p[0] - c[0], p[1] - c[1]]; if (!v1[0] && !v1[1]) v1 = [mv[0] - c[0], mv[1] - c[1]];
      let v2: Pt = [other[0] - c[0], other[1] - c[1]]; if (!v2[0] && !v2[1]) v2 = [1, 0];
      const r = Math.max(PE_MIN, Math.hypot(v1[0], v1[1])), p1 = resize(c, v1, r), p2 = resize(c, v2, r);
      if (idx === 0) { ns = p1; ne = p2; } else { ns = p2; ne = p1; }
    }
    const nm = arcMid(cc, ns, ne, ccw);
    for (const [key, q] of [["start", ns], ["mid", nm], ["end", ne]] as [string, Pt][]) { const kk = kid(n, key)!; kk[1] = r4(q[0]); kk[2] = r4(q[1]); }
  } else if (k === "rectangle" && idx === 5 && ep.pts.length === 6) {
    const r = r4(rectRadiusFor(boxOf({ kind: k, node: pe.orig }), p[0]));
    const rk = kid(n, "radius"), at = rk ? n.indexOf(rk) : -1;
    if (r > 0) { if (rk) rk[1] = r; else n.splice(n.indexOf(kid(n, "end")!) + 1, 0, ["radius", r]); }
    else if (at >= 0) n.splice(at, 1);
  } else if (k === "rectangle" || k === "text_box") {
    const mn = k === "text_box" ? textBoxMinSize(pe.orig) : [0, 0];
    const b = editBox(boxOf({ kind: k, node: pe.orig }), ep, idx, p, Math.max(PE_MIN, mn[0]), Math.max(PE_MIN, mn[1])).map(r4);
    if (k === "rectangle") { const s = kid(n, "start")!, e = kid(n, "end")!; s[1] = b[0]; s[2] = b[1]; e[1] = b[2]; e[2] = b[3]; }
    else { const at = kid(n, "at")!, sz = kid(n, "size")!; at[1] = b[0]; at[2] = b[1]; sz[1] = r4(b[2] - b[0]); sz[2] = r4(b[3] - b[1]); }
  } else if (k === "sheet") {
    const ob = boxOf({ kind: k, node: pe.orig }), np = ep.pts.length, edge = idx - np;
    const fromRight = idx === 1 || idx === 3 || edge === 1, fromBottom = idx === 2 || idx === 3 || edge === 2;
    const [mw, mh] = sheetMin(pe.orig, ob, fromRight, fromBottom);
    const b = editBox(ob, ep, idx, p, mw, mh).map(r4);
    const at = kid(n, "at")!, sz = kid(n, "size")!, dx = r4(b[0] - ob[0]), dy = r4(b[1] - ob[1]);
    at[1] = b[0]; at[2] = b[1]; sz[1] = r4(b[2] - b[0]); sz[2] = r4(b[3] - b[1]);
    if (dx || dy) for (const f of kids(n, "property")) { const fa = kid(f, "at"); if (fa) { fa[1] = r4(num(fa[1]) + dx); fa[2] = r4(num(fa[2]) + dy); } }   // SetPositionIgnoringPins moves the fields
    const moved: Pt[][] = [];
    for (const pin of kids(n, "pin")) {                                                                     // ConstrainOnEdge( pos, false )
      const pa = kid(pin, "at")!, r = ((Math.round(num(pa[3]) || 0) % 360) + 360) % 360, was = [num(pa[1]), num(pa[2])];
      if (r === 0 || r === 180) { pa[1] = r === 180 ? b[0] : b[2]; pa[2] = r4(Math.min(Math.max(num(pa[2]), b[1]), b[3])); }
      else { pa[2] = r === 90 ? b[1] : b[3]; pa[1] = r4(Math.min(Math.max(num(pa[1]), b[0]), b[2])); }
      moved.push([was, [num(pa[1]), num(pa[2])]]);
    }
    for (const f of pe.followers) {
      const mvp = moved.find(([w]) => same(w, f.at!)); if (!mvp || same(mvp[0], mvp[1])) continue;
      if (f.item.kind === "no_connect") { const fa = kid(f.item.node, "at")!; fa[1] = mvp[1][0]; fa[2] = mvp[1][1]; }
      else { const q: Pt[] = ptsOf(f.item.node); q[f.index!] = mvp[1].slice(); setPts(f.item.node, q); }
      touched.push(f.item);
    }
  }
  for (const it of new Set(touched.concat(pe.followers.map((f) => f.item)))) K.replaceChange(doc, it);
  return touched;
}
// The items that follow an edit: graphic lines joined at a graphic line's ends, the wires / no-connects on a sheet's pins.
export function editFollowers(doc: KDoc, item: KItem, ep: EditPoints) {
  const out: EditFollower[] = [];
  if (item.kind === "polyline" && ep.pts.length === 2) {
    for (let end = 0; end < 2; end++) {
      for (const o of doc.items.values()) {
        if (o === item || o.kind !== "polyline") continue;
        const q = ptsOf(o.node); if (q.length !== 2) continue;
        const i = same(q[0], ep.pts[end], 1e-6) ? 0 : same(q[1], ep.pts[end], 1e-6) ? 1 : -1;
        if (i >= 0) { out.push({ item: o, orig: deep(o.node), end, index: i }); break; }
      }
    }
  } else if (item.kind === "sheet") {
    for (const pin of kids(item.node, "pin")) {
      const [x, y] = atOf(pin);
      for (const o of doc.items.values()) {
        if (o.kind === "wire" || o.kind === "bus") { const q = ptsOf(o.node); const i = same(q[0], [x, y], 1e-6) ? 0 : same(q[q.length - 1], [x, y], 1e-6) ? q.length - 1 : -1; if (i >= 0) out.push({ item: o, orig: deep(o.node), at: [x, y], index: i }); }
        else if (o.kind === "no_connect" && same(atOf(o.node), [x, y], 1e-6)) out.push({ item: o, orig: deep(o.node), at: [x, y] });
      }
    }
  }
  return out;
}
// The one item the point editor works on: a single selection of an editable kind.
export function pointEditTarget(ctx: SchCtx) {
  if (S.multi && S.multi.size > 1) return null;
  if (ctx.selection && ctx.selection.size > 1) return null;
  const it = S.sel ? ctx.doc.items.get(S.sel) : ctx.selected ? ctx.doc.items.get(ctx.selected.id) : null;
  if (!it) return null;
  const ep = editPoints(ctx.doc, it); return ep ? { item: it, ep } : null;
}
export const EDIT_POINT_PX = 8;                                  // EDIT_POINT::POINT_SIZE
export function pointEditStart(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null) {
  if (ctx.viewOnly || S.drag || S.wire || S.carry) return false;
  const t = pointEditTarget(ctx); if (!t) return false;
  const tol = (EDIT_POINT_PX / 2 + 2) * mmPerPx(ctx), hs = editHandles(t.ep);
  let best = -1, bd = Infinity;
  hs.forEach((h, i) => { const d = Math.max(Math.abs(h[0] - mm[0]), Math.abs(h[1] - mm[1])); if (d <= tol && d < bd) { bd = d; best = i; } });
  if (best < 0) return false;
  S.pedit = { item: t.item, ep: t.ep, idx: best, orig: deep(t.item.node), followers: editFollowers(ctx.doc, t.item, t.ep), start: hs[best], moved: false, last: hs[best] };
  if (t.item.kind === "image") { S.pedit.imgOrigin0 = imageOriginOffset(t.item.id); S.pedit.imgSize0 = [t.item.w || 10, t.item.h || 10]; }
  try { if (ev && ev.pointerId !== undefined) ctx.stage.setPointerCapture(ev.pointerId); } catch (e) { /* not a real pointer */ }
  ctx.requestRender();
  return true;
}
export function pointEditSnap(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null): Pt {
  const pe = S.pedit!, k = pe.item.kind;
  if (k === "wire" || k === "bus") return snapConn(ctx, mm, k, ev);
  if (ev && (ev.ctrlKey || ev.metaKey)) return [r4(mm[0]), r4(mm[1])];
  return ctx.snap([mm[0], mm[1]]).map(r4);
}
export function pointEditMove(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null) {
  const pe = S.pedit; if (!pe) return;
  const p = pointEditSnap(ctx, mm, ev);
  if (!pe.moved && same(p, pe.start)) return;
  pe.moved = true; pe.last = p;
  applyPointEdit(ctx.doc, pe, p); ctx.requestRender();
}
export function pointEditEnd(ctx: SchCtx, commit: boolean) {
  const pe = S.pedit; S.pedit = null; if (!pe) return null;
  const doc = ctx.doc;
  let nodes: { it: KItem; node: SNode }[] | null = null;
  if (commit && pe.moved) { const touched = applyPointEdit(doc, pe, pe.last); nodes = touched.map((it) => ({ it, node: deep(it.node) })); }
  restoreNode(pe.item.node, pe.orig); for (const f of pe.followers) restoreNode(f.item.node, f.orig);   // originals back, so commit() records a true inverse
  if (pe.imgOrigin0 && !(commit && pe.moved)) setImageOriginOffset(pe.item.id, pe.imgOrigin0);
  K.replaceChange(doc, pe.item); for (const f of pe.followers) K.replaceChange(doc, f.item);
  let changes: KChange[] = [];
  if (nodes) {
    const seen = new Set<string>();
    for (const { it, node } of nodes) { if (seen.has(it.id)) continue; seen.add(it.id); if (K.serialize(node) !== K.serialize(it.node)) changes.push(modChange(doc, it, node)); }
    if (changes.length) ctx.commit(changes, "Move Point");
  }
  ctx.requestRender();
  return changes;
}
// EDIT_POINTS::ViewDraw: each point a square (or a circle, SetDrawCircle) of POINT_SIZE px, filled in the
// LAYER_AUX_ITEMS colour (inverted when too close to the background) then stroked BORDER_SIZE px in its border
// shade; each edge's centre handle a circle the same way; indicator lines solid at BORDER_SIZE / 4 in the
// border shade.  SCH_POINT_EDITOR never sets a point's hover or active state, so none is drawn here.
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const EDIT_BORDER_PX = IS_MAC ? 3 : 2;                  // EDIT_POINT::BORDER_SIZE (3 on macOS)
export function editPointColors(aux: string, bg: string) {
  let d = parseRgb(aux) || [0, 0, 0]; const b = parseRgb(bg);
  if (b && (d[0] - b[0]) ** 2 + (d[1] - b[1]) ** 2 + (d[2] - b[2]) ** 2 < 0.5) d = [1 - d[0], 1 - d[1], 1 - d[2]];   // COLOR4D::Distance < 0.5: Invert
  const br = d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.117;
  const shade = (f: number, dark: boolean) => "rgba(" + d.map((v) => Math.round(255 * (dark ? v * (1 - f) : v + (1 - v) * f))).join(",") + ",0.8)";
  const [bf, dark] = br > 0.5 ? [0.7, true] : br > 0.2 ? [0.4, false] : [0.7, false];
  return { fill: "rgb(" + d.map((v) => Math.round(255 * v)).join(",") + ")", border: shade(bf as number, dark as boolean) };
}
function parseRgb(c: string): number[] | null {
  if (!c) return null;
  let m = /^#([0-9a-f]{6})/i.exec(c); if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255);
  m = /^#([0-9a-f]{3})$/i.exec(c); if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16) / 255);
  m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c); return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : null;
}
export function drawEditPoints(c: CanvasRenderingContext2D, ctx: SchCtx, px: number) {
  const t = S.pedit ? { item: S.pedit.item, ep: editPoints(ctx.doc, S.pedit.item) } : pointEditTarget(ctx); if (!t || !t.ep) return;
  const { fill, border } = editPointColors(K.SCH.aux || "#000000", K.SCH.bg || "#F5F4EF"), size = EDIT_POINT_PX * px / 2, bw = EDIT_BORDER_PX * px;
  const ep = t.ep, circ = new Set(ep.circles || []);
  c.save();
  c.fillStyle = fill; c.strokeStyle = border; c.lineWidth = bw;
  const dot = (h: Pt, round: boolean) => {
    c.beginPath(); if (round) c.arc(h[0], h[1], size, 0, 2 * Math.PI); else c.rect(h[0] - size, h[1] - size, 2 * size, 2 * size);
    c.fill(); c.stroke();
  };
  ep.pts.forEach((h, i) => dot(h, circ.has(i)));
  for (const h of editHandles(ep).slice(ep.pts.length)) dot(h, true);
  if (ep.guides.length) { c.lineWidth = bw / 4; c.beginPath(); for (const [a, b] of ep.guides) { c.moveTo(ep.pts[a][0], ep.pts[a][1]); c.lineTo(ep.pts[b][0], ep.pts[b][1]); } c.stroke(); }
  c.restore();
}
