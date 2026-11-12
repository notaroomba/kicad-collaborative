// pcb-tools/transforms.ts — generic item transforms (move / rotate / flip / mirror), align and distribute.
import type { BoardDoc, Box, PcbChange, Pt } from "./types";

/** A point map (x, y) → [x, y]. */
export type PointFn = (x: number, y: number) => number[];
import { replacedChange } from "./changes";
import { flipFootprintNode, flipLayerKid, rotateFootprintNode, toggleMirror } from "./footprint";
import { K } from "./state";
import { clone, corners, isList, norm360, pt, r6, rotator, vadd, xy } from "./util";

// ================================================================ parity pass: the non-tool commands of pcbnew
// Everything below is DOM-free geometry and node editing (the dialogs at the end are swappable) so the node
// tests can drive it; app.js reaches it through pcb.actions and the exported query functions.
export const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated"]);
export const EPS = 1e-3;   // touching copper, in mm (KiCad's connectivity uses exact contact on integer nanometres)
export const DRC_EPS = 0.0005;   // ADVANCED_CFG::m_DRCEpsilon: half a micron short of a rule is not a violation
export const isFootprintNode = (n: SNode) => n[0] === "footprint";

// ---------------------------------------------------------------- generic item transforms (move / rotate / flip / mirror)
/** Every absolute (x, y) of a board-level item through fn; angles are untouched.  Footprints move as a whole. */
export function mapNodePoints(node: SNode, fn: PointFn) {
  const k = node[0];
  const mapKey = (n: SNode, key: string) => { const c = K.kid(n, key); if (!c || c.length < 3) return; const [x, y] = fn(K.num(c[1]), K.num(c[2])); c[1] = r6(x); c[2] = r6(y); };
  const mapPts = (n: SNode) => { const p = K.kid(n, "pts"); if (p) for (const xy of p.slice(1)) if (isList(xy) && xy[0] === "xy") { const [x, y] = fn(K.num(xy[1]), K.num(xy[2])); xy[1] = r6(x); xy[2] = r6(y); } };
  if (k === "footprint") { const [x, y] = K.atOf(node); const [nx, ny] = fn(x, y); K.setAt(node, r6(nx), r6(ny)); return node; }
  if (k === "table") {   // a table sits where its first cell does: every cell shifts with it
    const cells = K.kid(node, "cells"); const first = cells && K.kids(cells, "table_cell")[0]; const s = first && K.kid(first, "start"); if (!s) return node;
    const [ax, ay] = [K.num(s[1]), K.num(s[2])]; const [nx, ny] = fn(ax, ay); K.shiftTable(node, nx - ax, ny - ay); return node;
  }
  for (const key of ["start", "end", "mid", "center", "at"]) mapKey(node, key);
  mapPts(node);
  if (k === "zone") for (const poly of K.kids(node, "polygon").concat(K.kids(node, "filled_polygon"))) mapPts(poly);
  if (k === "generated") {   // PCB_GENERATOR::Move / Rotate: its stored points (origin, end, base lines) go with it
    for (const key of ["origin", "end"]) { const c = K.kid(node, key); const xy = c && K.kid(c, "xy"); if (xy) { const [x, y] = fn(K.num(xy[1]), K.num(xy[2])); xy[1] = r6(x); xy[2] = r6(y); } }
    for (const key of ["base_line", "base_line_coupled"]) { const c = K.kid(node, key); if (c) mapPts(c); }
  }
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) mapKey(gt, "at"); }
  return node;
}
export const translateNode = (node: SNode, dx: number, dy: number) => mapNodePoints(node, (x: number, y: number) => [x + dx, y + dy]);
export function angleKid(node: SNode) { const at = K.kid(node, "at"); return at ? K.num(at[3]) : 0; }
export function setAngleKid(node: SNode, a: number) { const at = K.kid(node, "at"); if (!at) return; a = r6(norm360(a)); if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
/** Turn an item by deg (KiCad's positive = counter-clockwise on screen) about (cx, cy). */
export function rotateNode(node: SNode, cx: number, cy: number, deg: number) {
  const k = node[0]; const R = rotator(deg); const about = (x: number, y: number) => { const [dx, dy] = R(x - cx, y - cy); return [cx + dx, cy + dy]; };
  if (k === "footprint") { rotateFootprintNode(node, deg); return mapNodePoints(node, about); }
  if (k === "gr_rect" && norm360(deg) % 90 !== 0) {   // PCB_SHAPE::Rotate: a rectangle off the axes becomes a polygon
    const a = pt(node, "start"), b = pt(node, "end"); const [x0, y0, x1, y1] = corners(a!, b!);
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => about(x, y));
    node[0] = "gr_poly"; for (const key of ["start", "end"]) { const i = node.indexOf(K.kid(node, key)!); if (i > 0) node.splice(i, 1); }
    node.splice(1, 0, ["pts", ...pts.map(xy)]); return node;
  }
  if ((k === "gr_text_box" || k === "table_cell") && K.kid(node, "start") && K.kid(node, "end")) return rotateTextBoxNode(node, cx, cy, deg);
  mapNodePoints(node, about);
  if (k === "gr_rect" || k === "gr_text_box") {   // corners stay a corner pair: re-normalise start / end
    const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start")!.splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end")!.splice(1, 2, r6(x1), r6(y1)); }
    if (k === "gr_text_box") setTextBoxAngle(node, textBoxAngle(node) + deg);
  }
  if (k === "gr_text") setAngleKid(node, angleKid(node) + deg);
  if (k === "image") {   // REFERENCE_IMAGE::Rotate: the centre turns about the point, the orientation is its own (rotate) after the layer
    const r = K.kid(node, "rotate"), a = norm360((r ? K.num(r[1]) : 0) + deg);
    if (r) { if (a) r[1] = r6(a); else node.splice(node.indexOf(r), 1); }
    else if (a) { const ly = K.kid(node, "layer"); node.splice(ly ? node.indexOf(ly) + 1 : 2, 0, ["rotate", r6(a)]); }
  }
  if (k === "dimension") {
    const gt = K.kid(node, "gr_text"); if (gt) setAngleKid(gt, angleKid(gt) + deg);
    const o = K.kid(node, "orientation"); if (o && norm360(deg) % 180 === 90) o[1] = K.num(o[1]) ? 0 : 1;
  }
  return node;
}
/** A text box's (angle), 0 when absent. */
export function textBoxAngle(node: SNode) { const an = K.kid(node, "angle"); return an ? K.num(an[1]) : 0; }
/** Write a text box's (angle) normalised to [0, 360): KiCad writes it before the layer, and drops it at 0. */
export function setTextBoxAngle(node: SNode, deg: number) {
  const an = K.kid(node, "angle"); const a1 = r6(norm360(deg)) % 360;
  if (an) { if (a1) an[1] = a1; else node.splice(node.indexOf(an), 1); return; }
  if (!a1) return;
  const ly = K.kid(node, "layer"); const i = ly ? node.indexOf(ly) : node.length; node.splice(i, 0, ["angle", a1]);
}
/**
 * PCB_TEXTBOX::Rotate: "Slide the axis-aligned box, rotation lives in the text angle."  The box's centre turns about
 * (cx, cy); start and end move by that delta rounded to the nanometre (KiROUND), keeping the width and height, and
 * the text angle becomes (angle + deg).Normalize().
 */
export function rotateTextBoxNode(node: SNode, cx: number, cy: number, deg: number) {
  const s = K.kid(node, "start"), e = K.kid(node, "end"); if (!s || !e) return node;
  const sx = K.num(s[1]), sy = K.num(s[2]), ex = K.num(e[1]), ey = K.num(e[2]);
  const ox = (sx + ex) / 2, oy = (sy + ey) / 2; const [rx, ry] = rotator(deg)(ox - cx, oy - cy);
  const dx = Math.round((cx + rx - ox) * 1e6) / 1e6, dy = Math.round((cy + ry - oy) * 1e6) / 1e6;
  s[1] = r6(sx + dx); s[2] = r6(sy + dy); e[1] = r6(ex + dx); e[2] = r6(ey + dy);
  setTextBoxAngle(node, textBoxAngle(node) + deg);
  return node;
}
/** PCB_TEXTBOX::SetTextAngle: a new angle turns the box by the difference about GetPosition() (its start). */
export function setTextBoxAngleSliding(node: SNode, deg: number) {
  const s = K.kid(node, "start"); const delta = norm360(deg) - norm360(textBoxAngle(node)); if (!delta) return node;
  if (!s || !K.kid(node, "end")) { setTextBoxAngle(node, deg); return node; }
  return rotateTextBoxNode(node, K.num(s[1]), K.num(s[2]), delta);
}
/** ZONE::Mirror: the hatch and thieving orientations reflect over the mirror axis (axis angle 0 for a top / bottom mirror, -90 for left / right), Normalized. */
export function reflectZoneOrientations(node: SNode, leftRight: boolean) {
  const f = K.kid(node, "fill"); if (!f) return;
  const axis = leftRight ? -90 : 0; const refl = (c: SNode | null | undefined) => { if (c && c.length > 1) c[1] = r6(norm360(2 * axis - K.num(c[1]))); };
  const h = K.kid(f, "hatch_orientation"); if (h) refl(h);
  const t = K.kid(f, "thieving"); if (t) refl(K.kid(t, "orientation"));
}
/** KiCad's Flip (left / right) about the vertical axis x = cx: other side, layers swapped, texts mirrored. */
export function flipNode(node: SNode, cx: number, doc: BoardDoc) {
  const k = node[0]; const mirror = (x: number, y: number) => [2 * cx - x, y];
  if (k === "footprint") { flipFootprintNode(node); return mapNodePoints(node, mirror); }
  mapNodePoints(node, mirror); flipLayerKid(node);
  if (k === "zone") reflectZoneOrientations(node, true);
  if (k === "via") { const ls = K.kid(node, "layers"); if (ls && doc) { const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const names = ls.slice(1).map(K.str).sort((a, b) => copper.indexOf(a) - copper.indexOf(b)); ls.splice(1, ls.length - 1, ...names); } }
  if (k === "gr_text" || k === "gr_text_box") { toggleMirror(node); setAngleKid(node, -angleKid(node)); }
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) { flipLayerKid(gt); toggleMirror(gt); setAngleKid(gt, -angleKid(gt)); } }
  if (k === "table") { const cells = K.kid(node, "cells"); if (cells) for (const c of K.kids(cells, "table_cell")) { flipLayerKid(c); toggleMirror(c); } }
  return node;
}
/** Mirror in place (no side change): "h" about the vertical axis through cx, "v" about the horizontal one through cy. */
export function mirrorNode(node: SNode, cx: number, cy: number, axis: string) {
  const k = node[0]; if (k === "footprint") return false;   // pcbnew refuses to mirror footprints outside the footprint editor
  mapNodePoints(node, axis === "v" ? (x: number, y: number) => [x, 2 * cy - y] : (x: number, y: number) => [2 * cx - x, y]);
  const text = (n: SNode) => { toggleMirror(n); setAngleKid(n, axis === "v" ? 180 - angleKid(n) : -angleKid(n)); };
  if (k === "gr_text" || k === "gr_text_box") text(node);
  if (k === "zone") reflectZoneOrientations(node, axis !== "v");
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) text(gt); }
  if (k === "gr_rect" || k === "gr_text_box") { const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start")!.splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end")!.splice(1, 2, r6(x1), r6(y1)); } }
  return node;
}
/** The point an item is placed by: its (at) / origin, else the middle of its bounding box. */
export function anchorOf(item: KItem): Pt {
  const n = item.node, k = item.kind;
  if (k === "footprint" || k === "via" || k === "gr_text" || k === "image" || k === "target") { const [x, y] = K.atOf(n); return [x, y]; }
  if (k === "segment" || k === "arc" || k === "gr_line" || k === "gr_arc") { const p = pt(n, "start"); if (p) return p; }
  if (k === "gr_circle") { const p = pt(n, "center"); if (p) return p; }
  const b = item.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
export function bboxUnion(items: KItem[]) { let b: Box | null = null; for (const it of items) { if (!it.bbox) continue; b = b ? [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] : it.bbox.slice(); } return b; }
/** KiCad's modification point: a lone item turns about its own anchor, a group about the middle of its bounding box. */
export function selectionCenter(items: KItem[]) {
  if (items.length === 1) return anchorOf(items[0]);
  const b = bboxUnion(items); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
/** MODIFIED changes for the items whose clones fn edits (return false from fn to leave one alone). */
export function transformChanges(doc: BoardDoc, ids: Iterable<string>, fn: (node: SNode, it: KItem) => unknown) {
  const out: PcbChange[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it || it.kind === "group") continue;
    const node = clone(it.node); if (fn(node, it) === false) continue; out.push(replacedChange(it, node));
  }
  return out;
}
export const moveChanges = (doc: BoardDoc, ids: Iterable<string>, dx: number, dy: number) => (dx || dy) ? transformChanges(doc, ids, (n) => translateNode(n, dx, dy)) : [];
export const rotateChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number, cy: number, deg: number) => transformChanges(doc, ids, (n) => rotateNode(n, cx, cy, deg));
export const flipChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number) => transformChanges(doc, ids, (n) => flipNode(n, cx, doc));
export const mirrorChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number, cy: number, axis: string) => transformChanges(doc, ids, (n) => mirrorNode(n, cx, cy, axis));
/** DIALOG_MOVE_EXACT: translate, then turn about the selection centre, each item's own anchor, or a point. */
export function moveExactChanges(doc: BoardDoc, ids: string[], opts: { dx?: number; dy?: number; rotation?: number; about?: string | Pt }) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; const dx = opts.dx || 0, dy = opts.dy || 0, rot = opts.rotation || 0;
  const b = bboxUnion(items);   // ROTATE_AROUND_SEL_CENTER is the bounding box's middle, a lone item included
  let c: Pt | null = opts.about === "anchor" ? null : isList(opts.about) ? opts.about as Pt : b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : selectionCenter(items);
  if (c) c = [c[0] + dx, c[1] + dy];
  return transformChanges(doc, ids, (n, it: KItem) => { translateNode(n, dx, dy); if (rot) { const p = c || vadd(anchorOf(it), [dx, dy]); rotateNode(n, p[0], p[1], rot); } });
}
/** PCB_SELECTION::GetTopLeftItem: the item whose anchor is leftmost, then topmost — the selection's own anchor. */
export function topLeftAnchor(items: KItem[]) { let best: Pt | null = null; for (const it of items) { const p = anchorOf(it); if (!best || p[0] < best[0] - 1e-9 || (Math.abs(p[0] - best[0]) <= 1e-9 && p[1] < best[1])) best = p; } return best || [0, 0]; }
/** POSITION_RELATIVE_TOOL: put the selection's anchor at the reference point plus the offset. */
export function positionRelativeChanges(doc: BoardDoc, ids: string[], ref: Pt, dx: number, dy: number) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; if (!items.length) return [];
  const a = topLeftAnchor(items); return moveChanges(doc, ids, ref[0] + dx - a[0], ref[1] + dy - a[1]);
}
// ALIGN_DISTRIBUTE_TOOL: bounding boxes; the target is the item under the cursor, else the first after sorting.
export const ALIGN: Record<string, { sort(b: Box): number; target(b: Box): number; move(b: Box, t: number): number[] }> = {
  left: { sort: (b: Box) => b[0], target: (b: Box) => b[0], move: (b: Box, t: number) => [t - b[0], 0] },
  right: { sort: (b: Box) => -b[2], target: (b: Box) => b[2], move: (b: Box, t: number) => [t - b[2], 0] },
  top: { sort: (b: Box) => b[1], target: (b: Box) => b[1], move: (b: Box, t: number) => [0, t - b[1]] },
  bottom: { sort: (b: Box) => -b[3], target: (b: Box) => b[3], move: (b: Box, t: number) => [0, t - b[3]] },
  centerX: { sort: (b: Box) => (b[0] + b[2]) / 2, target: (b: Box) => (b[0] + b[2]) / 2, move: (b: Box, t: number) => [t - (b[0] + b[2]) / 2, 0] },
  centerY: { sort: (b: Box) => (b[1] + b[3]) / 2, target: (b: Box) => (b[1] + b[3]) / 2, move: (b: Box, t: number) => [0, t - (b[1] + b[3]) / 2] },
};
/**
 * align_distribute_tool.cpp getBoundingBox: a footprint by FOOTPRINT::GetBoundingBox( false ) — its pads and shapes
 * without the texts (and pads by their copper, not their mask / paste openings) — anything else by its own box.
 */
export function alignBox(it: KItem) {
  if (it.kind !== "footprint" || !K.boardItemBox || !it.geom) return it.bbox;
  const geom = it.geom.filter((g) => g.t !== "text" && !g.padNum && !g.padText && !(g.pad && /\.(Mask|Paste)$/.test(g.layer || "")));
  const r = K.boardItemBox(Object.assign({}, it, { geom }), 1e6); if (!r) return it.bbox;
  return [r[0] / 1e6, r[1] / 1e6, (r[0] + r[2]) / 1e6, (r[1] + r[3]) / 1e6];
}
export const alignItems = (doc: BoardDoc, ids: string[]) => (ids.map((id: string) => doc.items.get(id)).filter((it) => it && it.bbox && it.kind !== "group") as KItem[]).map((it: KItem) => ({ id: it.id, kind: it.kind, bbox: alignBox(it)! }));
/** An item as Align / Distribute see it. */
export type AlignItem = ReturnType<typeof alignItems>[number];
export function alignChanges(doc: BoardDoc, ids: string[], mode: string, cursor: Pt | null | undefined) {
  const A = ALIGN[mode]; if (!A) return [];
  const items = alignItems(doc, ids); if (items.length < 2) return [];
  items.sort((p, q) => A.sort(p.bbox) - A.sort(q.bbox));
  const under = cursor && items.find((it) => cursor[0] >= it.bbox[0] && cursor[0] <= it.bbox[2] && cursor[1] >= it.bbox[1] && cursor[1] <= it.bbox[3]);
  const t = A.target((under || items[0]).bbox); const out: PcbChange[] = [];
  for (const it of items) { const [dx, dy] = A.move(it.bbox, t); if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) out.push(...moveChanges(doc, [it.id], dx, dy)); }
  return out;
}
/** GetDeltasForDistributeByGaps / ByPoints (libs/kimath geometry/distribute.cpp), in mm. */
export function distributeDeltasGaps(extents: number[][]) {
  const d = extents.map(() => 0); if (extents.length < 3) return d;
  let gap = extents[extents.length - 1][0] - extents[0][1]; for (let i = 1; i < extents.length - 1; i++) gap -= extents[i][1] - extents[i][0];
  const per = gap / (extents.length - 1); let target = extents[0][1];
  for (let i = 1; i < extents.length - 1; i++) { d[i] = target - extents[i][0] + i * per; target += extents[i][1] - extents[i][0]; }
  return d;
}
export function distributeDeltasPoints(pos: number[]) {
  const d = pos.map(() => 0); if (pos.length < 3) return d; const gap = (pos[pos.length - 1] - pos[0]) / (pos.length - 1);
  for (let i = 1; i < pos.length - 1; i++) d[i] = pos[0] + i * gap - pos[i];
  return d;
}
export function distributeChanges(doc: BoardDoc, ids: string[], axis: string, byCenters: boolean) {
  const items = alignItems(doc, ids); if (items.length < 3) return [];
  const x = axis === "x"; const lo = (b: Box) => x ? b[0] : b[1], hi = (b: Box) => x ? b[2] : b[3], mid = (b: Box) => (lo(b) + hi(b)) / 2;
  items.sort((p, q) => (byCenters ? mid(p.bbox) - mid(q.bbox) : lo(p.bbox) - lo(q.bbox)));
  const d = byCenters ? distributeDeltasPoints(items.map((it) => mid(it.bbox))) : distributeDeltasGaps(items.map((it) => [lo(it.bbox), hi(it.bbox)]));
  const out: PcbChange[] = []; items.forEach((it, i: number) => { if (Math.abs(d[i]) > 1e-9) out.push(...moveChanges(doc, [it.id], x ? d[i] : 0, x ? 0 : d[i])); }); return out;
}
/** EDIT_TOOL::Swap: each item takes the place of the next (positions; footprints also trade orientation and side). */
export function swapChanges(doc: BoardDoc, ids: string[]) {
  const items = ids.map((id: string) => doc.items.get(id)).filter((it) => it && it.kind !== "group") as KItem[]; if (items.length < 2) return [];
  const slots = items.map((it: KItem) => ({ p: anchorOf(it), rot: it.kind === "footprint" ? it.rot : 0, layer: it.kind === "footprint" ? it.layer : null }));
  const out: PcbChange[] = [];
  items.forEach((it: KItem, i: number) => {
    const to = slots[(i + 1) % items.length], from = slots[i]; const node = clone(it.node);
    translateNode(node, to.p[0] - from.p[0], to.p[1] - from.p[1]);
    if (it.kind === "footprint") { if (to.layer !== from.layer) flipNode(node, to.p[0], doc); if (to.rot !== K.atOf(node)[2]) rotateFootprintNode(node, to.rot! - K.atOf(node)[2]); }
    out.push(replacedChange(it, node));
  });
  return out;
}
/** Pack the footprints into rows (KiCad's P): biggest first, 1 mm apart, from the selection's top-left corner. */
export function packChanges(doc: BoardDoc, ids: string[], gap?: number) {
  gap = gap === undefined ? 1 : gap;
  const fps = ids.map((id: string) => doc.items.get(id)).filter((it) => it && it.kind === "footprint" && it.bbox) as (KItem & { bbox: Box })[]; if (fps.length < 2) return [];
  const b = bboxUnion(fps)!; const rowW = Math.max(b[2] - b[0], Math.sqrt(fps.reduce((s, f) => s + (f.bbox[2] - f.bbox[0] + gap!) * (f.bbox[3] - f.bbox[1] + gap), 0)) * 1.2);
  fps.sort((p, q) => (q.bbox[2] - q.bbox[0]) * (q.bbox[3] - q.bbox[1]) - (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]));
  let x = b[0], y = b[1], rowH = 0; const out: PcbChange[] = [];
  for (const f of fps) {
    const w = f.bbox[2] - f.bbox[0], h = f.bbox[3] - f.bbox[1];
    if (x > b[0] && x + w > b[0] + rowW) { x = b[0]; y += rowH + gap!; rowH = 0; }
    out.push(...moveChanges(doc, [f.id], x - f.bbox[0], y - f.bbox[1])); x += w + gap!; rowH = Math.max(rowH, h);
  }
  return out;
}
