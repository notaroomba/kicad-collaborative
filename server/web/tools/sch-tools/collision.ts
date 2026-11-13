import type { Pt, SchDrag } from "./types";
import { connPoints, isNetLine } from "./drag";
import { ercNets } from "./erc";
import { K, S, kid, num } from "./state";
import { onSegMid, same, segDist, segs } from "./util";

// ---------------------------------------------------------------- SCH_DRAG_NET_COLLISION_MONITOR (eeschema/tools/sch_drag_net_collision.cpp)
// While a selection moves (not graphics only), each preview junction where items of two different nets meet with a
// moved item among them gets a red circle, and each connection the selection had before the move that the move broke
// gets a circle at both of its points joined by a line.  The cursor turns into KICURSOR::WARNING meanwhile.

/** Net of every connection point before the move ("id#index"), and the connections the selection had then. */
export interface NetCollision { nets: Map<string, number>; orig: { a: string; ia: number; b: string; ib: number }[]; moved: Set<string> }
export interface CollisionMarkers { junctions: { p: Pt; r: number }[]; breaks: { a: Pt; b: Pt; r: number }[] }

const IU = 1e-4;                                           // one schematic IU in mm
const MIN_R = 800 * IU;                                    // the markers' 800 IU floor
const LINE_PX = 4;                                         // selection.drag_net_collision_width default
const BASE: [number, number, number, number] = [255, 0, 0, 0.8];   // COLOR4D( 1, 0, 0, 0.8 ) unless the theme sets LAYER_DRAG_NET_COLLISION
// cursor-warning-black.xpm (KICURSOR::WARNING off Windows), hotspot ( 1, 1 )
export const WARNING_CURSOR = "url(\"data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" shape-rendering="crispEdges"><path fill="#FFFFFF" d="M0 0h1v1h-1zM0 1h2v1h-2zM0 2h1v1h-1zM2 2h1v1h-1zM0 3h1v1h-1zM3 3h1v1h-1zM0 4h1v1h-1zM4 4h1v1h-1zM0 5h1v1h-1zM5 5h1v1h-1zM0 6h1v1h-1zM6 6h1v1h-1zM0 7h1v1h-1zM7 7h1v1h-1zM0 8h1v1h-1zM8 8h1v1h-1zM0 9h1v1h-1zM9 9h1v1h-1zM0 10h1v1h-1zM10 10h1v1h-1zM0 11h1v1h-1zM7 11h5v1h-5zM0 12h1v1h-1zM7 12h1v1h-1zM0 13h1v1h-1zM3 13h2v1h-2zM7 13h1v1h-1zM0 14h1v1h-1zM2 14h1v1h-1zM4 14h1v1h-1zM8 14h1v1h-1zM0 15h2v1h-2zM5 15h1v1h-1zM8 15h1v1h-1zM0 16h1v1h-1zM5 16h1v1h-1zM9 16h1v1h-1zM6 17h1v1h-1zM8 17h1v1h-1zM21 17h1v1h-1zM6 18h2v1h-2zM20 18h3v1h-3zM19 19h5v1h-5zM9 20h2v1h-2zM21 20h1v1h-1zM8 21h4v1h-4zM17 21h1v1h-1zM21 21h1v1h-1zM25 21h1v1h-1zM8 22h1v1h-1zM11 22h1v1h-1zM16 22h2v1h-2zM21 22h1v1h-1zM25 22h2v1h-2zM7 23h2v1h-2zM11 23h2v1h-2zM15 23h13v1h-13zM7 24h2v1h-2zM11 24h2v1h-2zM16 24h2v1h-2zM21 24h1v1h-1zM25 24h2v1h-2zM6 25h3v1h-3zM11 25h3v1h-3zM17 25h1v1h-1zM21 25h1v1h-1zM25 25h1v1h-1zM5 26h10v1h-10zM21 26h1v1h-1zM5 27h4v1h-4zM11 27h4v1h-4zM19 27h5v1h-5zM4 28h5v1h-5zM11 28h5v1h-5zM20 28h3v1h-3zM4 29h12v1h-12zM21 29h1v1h-1z"/><path fill="#000000" d="M1 2h1v1h-1zM1 3h2v1h-2zM1 4h3v1h-3zM1 5h4v1h-4zM1 6h5v1h-5zM1 7h6v1h-6zM1 8h7v1h-7zM1 9h8v1h-8zM1 10h9v1h-9zM1 11h6v1h-6zM1 12h6v1h-6zM1 13h2v1h-2zM5 13h2v1h-2zM1 14h1v1h-1zM5 14h3v1h-3zM6 15h2v1h-2zM6 16h3v1h-3zM21 16h1v1h-1zM7 17h1v1h-1zM20 17h1v1h-1zM22 17h1v1h-1zM19 18h1v1h-1zM23 18h1v1h-1zM18 19h1v1h-1zM24 19h1v1h-1zM17 20h1v1h-1zM19 20h2v1h-2zM22 20h2v1h-2zM25 20h1v1h-1zM16 21h1v1h-1zM18 21h1v1h-1zM20 21h1v1h-1zM22 21h1v1h-1zM24 21h1v1h-1zM26 21h1v1h-1zM9 22h2v1h-2zM15 22h1v1h-1zM18 22h3v1h-3zM22 22h3v1h-3zM27 22h1v1h-1zM9 23h2v1h-2zM14 23h1v1h-1zM28 23h1v1h-1zM9 24h2v1h-2zM15 24h1v1h-1zM18 24h3v1h-3zM22 24h3v1h-3zM27 24h1v1h-1zM9 25h2v1h-2zM16 25h1v1h-1zM18 25h1v1h-1zM20 25h1v1h-1zM22 25h1v1h-1zM24 25h1v1h-1zM26 25h1v1h-1zM17 26h1v1h-1zM19 26h2v1h-2zM22 26h2v1h-2zM25 26h1v1h-1zM9 27h2v1h-2zM18 27h1v1h-1zM24 27h1v1h-1zM9 28h2v1h-2zM19 28h1v1h-1zM23 28h1v1h-1zM20 29h1v1h-1zM22 29h1v1h-1zM21 30h1v1h-1z"/><path fill="#FF0000" d="M9 18h2v1h-2zM8 19h4v1h-4zM7 20h2v1h-2zM11 20h2v1h-2zM7 21h1v1h-1zM12 21h1v1h-1zM6 22h2v1h-2zM12 22h2v1h-2zM6 23h1v1h-1zM13 23h1v1h-1zM5 24h2v1h-2zM13 24h2v1h-2zM4 25h2v1h-2zM14 25h2v1h-2zM4 26h1v1h-1zM15 26h1v1h-1zM3 27h2v1h-2zM15 27h2v1h-2zM3 28h1v1h-1zM16 28h1v1h-1zM2 29h2v1h-2zM16 29h2v1h-2zM2 30h16v1h-16zM3 31h14v1h-14z"/></svg>') + "\") 1 1, auto";

const keyOf = (id: string, i: number) => id + "#" + i;
const lineWidth = (it: KItem) => { const st = kid(it.node, "stroke"), w = st ? num((kid(st, "width") || [])[1], 0) : 0; return w > 0 ? w : it.kind === "bus" ? 0.3048 : it.kind === "wire" ? 0.1524 : 0; };

/** Initialize: the net of each connection point (SCH_CONNECTION net codes; an unconnected point has none) and recordOriginalConnections. */
export function collisionInit(doc: KDoc, d: SchDrag, fresh: boolean): NetCollision {
  const nets = new Map<string, number>(), moved = new Set(d.items.map((e) => e.item.id));
  let info: ReturnType<typeof ercNets>;
  try { info = ercNets(doc); } catch (e) { return { nets, orig: [], moved }; }
  info.nets.forEach((n, ni) => {
    if (n.ids.size < 2 && !n.terms.some((t) => isNetLine(t.item.kind) || t.item.kind.endsWith("label"))) return;   // IsUnconnected: no net code
    for (const t of n.terms) {
      const pts = connPoints(doc, t.item);
      if (isNetLine(t.item.kind)) { pts.forEach((_, i) => nets.set(keyOf(t.item.id, i), ni)); continue; }
      pts.forEach((p, i) => { if (same(p, t.p, 1e-4)) nets.set(keyOf(t.item.id, i), ni); });
    }
  });
  const orig: NetCollision["orig"] = [];
  if (!fresh) {                                             // new or pasted items were connected to nothing
    const seen = new Set<string>();
    for (const e of d.items) {
      const pts = connPoints(doc, e.item); if (!pts.length) continue;
      pts.forEach((p, ia) => {
        for (const o of doc.items.values()) {
          if (o === e.item) continue;
          if ((e.item.kind === "bus") !== (o.kind === "bus") && isNetLine(e.item.kind) && isNetLine(o.kind)) continue;   // CanConnect
          const ib = connPoints(doc, o).findIndex((q) => same(q, p, 1e-4)); if (ib < 0) continue;
          let A = { id: e.item.id, i: ia }, B = { id: o.id, i: ib }; if (B.id < A.id) [A, B] = [B, A];
          const k = A.id + ":" + A.i + "|" + B.id + ":" + B.i; if (seen.has(k)) continue; seen.add(k);
          orig.push({ a: A.id, ia: A.i, b: B.id, ib: B.i });
        }
      });
    }
  }
  return { nets, orig, moved };
}

/** Update: the markers for this step's preview junctions and the broken connections. */
export function collisionMarkers(doc: KDoc, nc: NetCollision, junctions: Pt[]): CollisionMarkers {
  const out: CollisionMarkers = { junctions: [], breaks: [] };
  // GetEffectiveDiameter() * 1.5 of the preview junction (no diameter of its own): SCHEMATIC_SETTINGS::GetJunctionSize,
  // the project's Schematic Setup > Formatting junction dot size, at least 1 IU
  const ss = (doc as KDoc & { schSettings?: { junctionDiameter?: number } | null }).schSettings;
  const jd = ss && typeof ss.junctionDiameter === "number" ? Math.max(ss.junctionDiameter, IU) : 0.9144;
  const jr = Math.max(jd * 1.5, MIN_R);
  for (const p of junctions) {
    let first: number | undefined, diff = false, movedNet = false;
    for (const it of doc.items.values()) {
      const pts = connPoints(doc, it); if (!pts.length) continue;
      let i = pts.findIndex((q) => same(q, p, 1e-4));
      if (i < 0 && isNetLine(it.kind) && segs(it).some(([a, b]) => onSegMid(p, a, b))) i = 0;
      if (i < 0) continue;
      const net = nc.nets.get(keyOf(it.id, i)); if (net === undefined) continue;
      if (first !== undefined && first !== net) diff = true;
      first = net; movedNet = movedNet || nc.moved.has(it.id);
    }
    if (movedNet && diff) out.junctions.push({ p, r: jr });
  }
  for (const c of nc.orig) {
    const A = doc.items.get(c.a), B = doc.items.get(c.b); if (!A || !B) continue;
    const pa = connPoints(doc, A)[c.ia], pb = connPoints(doc, B)[c.ib]; if (!pa || !pb) continue;
    if (same(pa, pb, 1e-4)) continue;
    if (isNetLine(B.kind) && segs(B).some(([a, b]) => segDist(pa, a, b) <= 1e-4)) continue;
    if (isNetLine(A.kind) && segs(A).some(([a, b]) => segDist(pb, a, b) <= 1e-4)) continue;
    if (!nc.moved.has(A.id) && !nc.moved.has(B.id)) continue;
    out.breaks.push({ a: pa, b: pb, r: Math.max(MIN_R, lineWidth(A), lineWidth(B)) });
  }
  return out;
}

/** The overlay: fill at 0.35 x the colour's alpha, stroke at its alpha, LINE_PX wide. */
export function drawCollision(c: CanvasRenderingContext2D, m: CollisionMarkers, px: number) {
  if (!m.junctions.length && !m.breaks.length) return;
  const col = (K.SCH && K.SCH.dragNetCollision) || null, [r, g, b, a] = col ? parseCol(col) : BASE, base = a > 0 ? a : 1;
  const fa = Math.min(Math.max(base * 0.35, 0.05), 1), sa = Math.min(Math.max(base, 0.05), 1);
  c.save(); c.fillStyle = `rgba(${r},${g},${b},${fa})`; c.strokeStyle = `rgba(${r},${g},${b},${sa})`; c.lineWidth = LINE_PX * px;
  const circle = (p: Pt, rad: number) => { c.beginPath(); c.arc(p[0], p[1], rad, 0, 2 * Math.PI); c.fill(); c.stroke(); };
  for (const j of m.junctions) circle(j.p, j.r);
  for (const k of m.breaks) { circle(k.a, k.r); circle(k.b, k.r); c.beginPath(); c.moveTo(k.a[0], k.a[1]); c.lineTo(k.b[0], k.b[1]); c.stroke(); }
  c.restore();
}
function parseCol(s: string): [number, number, number, number] {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  const h = /^#([0-9a-f]{6})/i.exec(s); return h ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16), 1] : BASE;
}
/** AdjustCursor: KICURSOR::WARNING while there is a collision, the tool's cursor back after. */
export function collisionCursor(stage: HTMLElement | null | undefined, on: boolean) {
  if (!stage) return;
  if (on && S.collisionCursor == null) { S.collisionCursor = stage.style.cursor || ""; stage.style.cursor = WARNING_CURSOR; }
  else if (!on && S.collisionCursor != null) { stage.style.cursor = S.collisionCursor; S.collisionCursor = null; }
}
