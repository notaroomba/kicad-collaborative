// kicad-bbox — a board item's bounding box as the desktop defines it (BOARD_ITEM::GetBoundingBox), in internal
// units, for the presence payload: [x, y, width, height] of a BOX2I.
//
// Why not item.bbox: that one is the renderer's culling box (a pad is its circumscribed circle, an arc its
// whole circle, text an estimate).  The desktop compares a peer's box with its own GetBoundingBox() of the
// same item and treats the difference as "the peer is dragging this" (PCB_COLLAB_TOOL::rebuildOverlay), so
// what the web sends has to be the same rectangle:
//   PCB_TRACK   start/end grown by the rounded-up half width, size + 1 (the box is [pos, dim))
//   PCB_VIA     the centre grown by the rounded-up radius of the larger of pad and hole, size + 1
//   PCB_SHAPE   EDA_SHAPE::getBoundingBox: the shape's own points (an arc only where it sweeps), grown by width / 2
//   ZONE        the outline polygon(s)
//   PCB_TEXT    EDA_TEXT::GetTextBox turned about the text position
//   PAD         the pad shape's box (a turned rectangle, not its circumscribed circle)
//   FOOTPRINT   the position grown by 0.25 mm, merged with its graphics, pads, zones and visible texts
import { kid, kids, num, rotator } from "./sexpr";
import { textWidth } from "./text";

export type BoxIU = [number, number, number, number];
interface Geom { t: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number; w?: number; h?: number | string; r?: number; rot?: number; pts?: number[][];
  a0?: number; a1?: number; anticlockwise?: boolean; shape?: string; text?: string; size?: number; sizeX?: number; v?: string; mirror?: boolean; noBox?: boolean; via?: boolean; hole?: boolean; fill?: unknown; track?: boolean; zoneFill?: boolean }
interface Item { kind: string; node: unknown[]; geom?: Geom[]; bbox?: number[] | null; x?: number; y?: number }

class Box {
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
  add(x: number, y: number, pad = 0): void { if (x - pad < this.x0) this.x0 = x - pad; if (y - pad < this.y0) this.y0 = y - pad; if (x + pad > this.x1) this.x1 = x + pad; if (y + pad > this.y1) this.y1 = y + pad; }
  get empty(): boolean { return this.x0 > this.x1; }
}
const TWO_PI = Math.PI * 2;
const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** The extent of an arc: its two ends and whichever of the four axis points it sweeps over (EDA_SHAPE::computeArcBBox). */
function addArc(b: Box, g: Geom, pad: number): void {
  const cx = g.x || 0, cy = g.y || 0, r = g.r || 0, a0 = g.a0 || 0, a1 = g.a1 || 0;
  const from = g.anticlockwise ? a1 : a0, sweep = norm((g.anticlockwise ? a0 : a1) - from) || TWO_PI;
  b.add(cx + r * Math.cos(a0), cy + r * Math.sin(a0), pad); b.add(cx + r * Math.cos(a1), cy + r * Math.sin(a1), pad);
  for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2; if (norm(a - from) <= sweep) b.add(cx + r * Math.cos(a), cy + r * Math.sin(a), pad); }
}

function addGeom(b: Box, g: Geom): void {
  const hw = Math.max(0, typeof g.w === "number" ? g.w : 0) / 2;
  if (g.t === "line") { b.add(g.x1 || 0, g.y1 || 0, hw); b.add(g.x2 || 0, g.y2 || 0, hw); }
  else if (g.t === "poly") { for (const p of g.pts || []) b.add(p[0], p[1], hw); }
  else if (g.t === "circle") { b.add(g.x || 0, g.y || 0, (g.r || 0) + (g.via || g.hole ? 0 : hw)); }
  else if (g.t === "arc") addArc(b, g, hw);
  else if (g.t === "rect" || g.t === "image") { b.add(g.x || 0, g.y || 0); b.add((g.x || 0) + (g.w || 0), (g.y || 0) + Number(g.h || 0)); }
  else if (g.t === "pad") {
    const w = g.w || 0, h = Number(g.h) || 0, x = g.x || 0, y = g.y || 0;
    if (g.shape === "circle") { b.add(x, y, Math.max(w, h) / 2); return; }
    const a = (g.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    if (g.shape === "oval") { const rr = Math.min(w, h) / 2, l = Math.max(w, h) / 2 - rr; const ex = (w >= h ? c : s) * l, ey = (w >= h ? s : c) * l; b.add(x - ex, y - ey, rr); b.add(x + ex, y + ey, rr); return; }
    const ex = (w * c + h * s) / 2, ey = (w * s + h * c) / 2; b.add(x - ex, y - ey); b.add(x + ex, y + ey);
  } else if (g.t === "text" && !g.noBox) {
    // EDA_TEXT::GetTextBox for the stroke font: the string's width, the size grown by the 0.17 "fudge" that
    // covers descenders, placed by the justification, then turned about the anchor
    const size = g.size || 1, lines = String(g.text || "").split("\n");
    let w = 0; for (const l of lines) w = Math.max(w, textWidth(l, g.sizeX || size, typeof g.w === "number" ? g.w : 0));
    const fudge = size * 0.17, h = size + fudge + (lines.length - 1) * size * 1.68 * 0.9583;
    const hj = String(g.h || "center");
    const x0 = hj === "left" ? 0 : hj === "right" ? -w : -w / 2;
    const y0 = g.v === "top" ? -fudge : g.v === "bottom" ? -h + fudge : -h / 2;
    const R = rotator(g.rot || 0) as (x: number, y: number) => [number, number];
    for (const [px, py] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) { const [rx, ry] = R(g.mirror ? -px : px, py); b.add((g.x || 0) + rx, (g.y || 0) + ry); }
  }
}

const iu = (mm: number, IU: number): number => Math.round(mm * IU);
function toIU(b: Box, IU: number): BoxIU | null {
  if (b.empty) return null;
  const x = iu(b.x0, IU), y = iu(b.y0, IU);
  return [x, y, iu(b.x1, IU) - x, iu(b.y1, IU) - y];
}
const pt = (node: unknown[], key: string): [number, number] | null => { const c = kid(node, key); return c ? [num(c[1]), num(c[2])] : null; };

/** The item's bounding box as pcbnew computes it, in internal units; null for an item with no extent. */
export function boardItemBox(item: Item, IU = 1e6): BoxIU | null {
  const n = item.node, k = item.kind;
  if (k === "segment") {
    const s = pt(n, "start"), e = pt(n, "end"); if (!s || !e) return null;
    const wN = kid(n, "width"), radius = Math.floor((iu(wN ? num(wN[1]) : 0, IU) + 1) / 2);
    const xs = [iu(s[0], IU), iu(e[0], IU)], ys = [iu(s[1], IU), iu(e[1], IU)];
    const x0 = Math.min(xs[0], xs[1]) - radius, y0 = Math.min(ys[0], ys[1]) - radius;
    return [x0, y0, Math.max(xs[0], xs[1]) + radius - x0 + 1, Math.max(ys[0], ys[1]) + radius - y0 + 1];
  }
  if (k === "via") {
    const at = pt(n, "at"); if (!at) return null;
    const sN = kid(n, "size"), dN = kid(n, "drill");
    const radius = Math.floor((Math.max(iu(sN ? num(sN[1]) : 0, IU), iu(dN ? num(dN[1]) : 0, IU)) + 1) / 2), x = iu(at[0], IU), y = iu(at[1], IU);
    return [x - radius, y - radius, 2 * radius + 1, 2 * radius + 1];
  }
  const b = new Box();
  if (k === "zone") {
    for (const poly of kids(n, "polygon")) { const pts = kid(poly, "pts"); if (pts) for (const xy of kids(pts, "xy")) b.add(num(xy[1]), num(xy[2])); }
    if (!b.empty) return toIU(b, IU);
  }
  if (k === "arc") {
    // PCB_ARC: the arc's own extent grown by the rounded-up half width, + 1 like a segment
    const wN = kid(n, "width"), radius = Math.floor((iu(wN ? num(wN[1]) : 0, IU) + 1) / 2);
    for (const g of item.geom || []) if (g.t === "arc") addArc(b, g, 0); else if (g.t === "line") { b.add(g.x1 || 0, g.y1 || 0); b.add(g.x2 || 0, g.y2 || 0); }
    const r = toIU(b, IU); return r ? [r[0] - radius, r[1] - radius, r[2] + 2 * radius + 1, r[3] + 2 * radius + 1] : null;
  }
  if (k === "footprint" && typeof item.x === "number" && typeof item.y === "number") b.add(item.x, item.y, 0.25);
  for (const g of item.geom || []) { if (g.zoneFill) continue; addGeom(b, g); }
  if (b.empty && item.bbox) { b.add(item.bbox[0], item.bbox[1]); b.add(item.bbox[2], item.bbox[3]); }
  return toIU(b, IU);
}

interface Doc { type?: string; items: Map<string, Item> }
export interface PresenceSelection { selection: string[]; boxes?: BoxIU[] }
/**
 * The `selection` / `boxes` pair of a presence update (see editor/peers.ts for why): a board at rest names its
 * items only, a board with a move in flight adds pcbnew's box of each, a schematic always sends the renderer's
 * extents.  Both lists stop at `max` and stay paired by index.
 */
export function presenceSelection(doc: Doc | null, selection: Iterable<string> | null, IU: number, moving: boolean, max = 60): PresenceSelection | null {
  if (!doc || !selection) return null;
  const board = doc.type !== "sch";
  const ids: string[] = [], boxes: BoxIU[] = [], plain: string[] = [];
  for (const id of selection) {
    if (ids.length >= max) break;
    const it = doc.items.get(id);
    if (!it) continue;                       // gone from the document: nothing a peer could outline
    if (board && !moving) { ids.push(id); continue; }
    let box: BoxIU | null = null;
    if (board) box = boardItemBox(it, IU);
    else if (it.bbox) { const b = it.bbox; box = [Math.round(b[0] * IU), Math.round(b[1] * IU), Math.round((b[2] - b[0]) * IU), Math.round((b[3] - b[1]) * IU)]; }
    if (!box) { plain.push(id); continue; }
    // rebuildOverlay pairs selection[i] with boxes[i], so only items that contribute a box go in both lists
    ids.push(id); boxes.push(box);
  }
  if (boxes.length) return { selection: ids, boxes };
  if (ids.length) return { selection: ids };
  return plain.length ? { selection: plain } : null;
}
