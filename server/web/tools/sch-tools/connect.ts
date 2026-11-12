import type { Pt } from "./types";
import { junctionNode, lineNode } from "./nodes";
import { K, atOf, kid, ptsOf, setPts } from "./state";
import { addNode, deep, modChange, onSegMid, r4, replaceKid, same, segs } from "./util";

// ---------------------------------------------------------------- connectivity
export function pinsAt(doc: KDoc, x: number, y: number, r?: number) {
  const out: { item: KItem; x: number; y: number }[] = []; r = r || 0.02;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" || !it.bbox) continue; const b = it.bbox;
    if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
    for (const p of K.pinPoints(doc, it)) if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) out.push({ item: it, x: p.x, y: p.y });
  }
  return out;
}
export function junctionAt(doc: KDoc, x: number, y: number) { for (const it of doc.items.values()) if (it.kind === "junction" && same(atOf(it.node), [x, y])) return it; return null; }
export function lineMidsAt(doc: KDoc, x: number, y: number, kind: string) { const out: KItem[] = []; for (const it of doc.items.values()) { if (it.kind !== kind) continue; for (const [a, b] of segs(it)) if (onSegMid([x, y], a, b)) { out.push(it); break; } } return out; }
export function lineEndsAt(doc: KDoc, x: number, y: number, kind: string) { return K.wireEndsAt(doc, x, y, 1e-3).filter((e) => e.item.kind === kind); }
// KiCad's rule: a junction where a line ends on (or a pin sits on) the middle of another line,
// where three or more line ends meet, or where two non-collinear line ends share a pin.
export function needsJunction(doc: KDoc, x: number, y: number, kind: string) {
  const ends = lineEndsAt(doc, x, y, kind), mids = lineMidsAt(doc, x, y, kind).length;
  const pins = kind === "wire" ? pinsAt(doc, x, y).length : 0;
  if (mids > 0 && (ends.length > 0 || pins > 0)) return true;
  if (ends.length >= 3) return true;
  if (pins > 0 && ends.length >= 2) {
    const dirs = ends.map((e) => { const p = ptsOf(e.item.node); const q = p[e.index === 0 ? 1 : e.index - 1] || p[e.index]; return [q[0] - x, q[1] - y]; });
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) if (Math.abs(dirs[i][0] * dirs[j][1] - dirs[i][1] * dirs[j][0]) > 1e-6) return true;
  }
  return false;
}
export function connectsAt(doc: KDoc, p: Pt, kind: string) {
  if (kind === "wire" && pinsAt(doc, p[0], p[1]).length) return true;
  return lineEndsAt(doc, p[0], p[1], kind).length > 0 || lineMidsAt(doc, p[0], p[1], kind).length > 0;
}
// Junction changes for every point in pts that now needs one (items must already be in the doc).
export function junctionChanges(doc: KDoc, pts: Pt[], kind: string) {
  const out: KChange[] = [];
  for (const p of pts) if (!junctionAt(doc, p[0], p[1]) && needsJunction(doc, p[0], p[1], kind)) { out.push(...breakLinesAt(doc, p, kind)); out.push(addNode(doc, junctionNode(p)).change); }
  return out;
}
// KiCad's AddJunction() breaks the lines running through the point (SCH_LINE_WIRE_BUS_TOOL::BreakSegments):
// each becomes two segments that end on the junction.
export function breakLinesAt(doc: KDoc, p: Pt, kind: string) {
  const out: KChange[] = [];
  for (const it of lineMidsAt(doc, p[0], p[1], kind)) {
    const pts = ptsOf(it.node); if (pts.length !== 2) continue;
    const a = deep(it.node); setPts(a, [pts[0], [r4(p[0]), r4(p[1])]]);
    const tail = lineNode(it.kind, p, pts[1]), st = kid(it.node, "stroke"); if (st) replaceKid(tail, deep(st));
    const b = addNode(doc, tail); doc.items.delete(b.item.id);
    out.push(modChange(doc, it, a), b.change);
  }
  return out;
}
