// hop-over.ts — Schematic Setup > Formatting > Hop-over size (SCHEMATIC_SETTINGS::m_HopOverSizeChoice): where a wire or
// bus crosses another one it does not connect to, the shallower of the two draws a small arc over the other
// (SCH_LINE::ShouldHopOver / BuildWireWithHopShape, drawn by SCH_PAINTER::draw( SCH_LINE )).  The radius is the default
// line width times hopover_size_mult_list[ choice ].  The shapes depend on every other wire, so they are worked out at
// paint time and cached while the sheet's wire geometry is unchanged.
import type { Doc, Geom, Pt } from "./types";
import { ptsOf } from "./sexpr";

/** schematic_settings.cpp hopover_size_mult_list. */
export const HOPOVER_MULT = [0, 1.7, 4, 6, 9, 12];
/** The hop arc radius in mm (0: no hops), set from the project. */
export const hopOver = { radius: 0 };

/** A wire's drawn path: straight runs and hop arcs (start, mid, end), in order from its start point. */
export type HopPiece = { t: "seg"; a: Pt; b: Pt } | { t: "arc"; a: Pt; m: Pt; b: Pt };

interface Seg { id: string; a: Pt; b: Pt }
const eqPt = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

/** SCH_LINE::ShouldHopOver: should `me` hop over `other`?  Horizontal wires hop over vertical ones, else the shallower. */
export function shouldHopOver(me: Seg, other: Seg): boolean {
  const meV = me.b[0] === me.a[0], oV = other.b[0] === other.a[0];
  if (meV && !oV) return false;
  if (oV && !meV) return true;
  const sMe = (me.b[1] - me.a[1]) / (me.b[0] - me.a[0]), sO = (other.b[1] - other.a[1]) / (other.b[0] - other.a[0]);
  if (Math.abs(sMe) === Math.abs(sO)) return sMe < sO;
  return Math.abs(sMe) < Math.abs(sO);
}
/** SEG::Intersect( aSeg, aIgnoreEndpoints = true ): the crossing point of two segments, not where they only touch end to end. */
function crossing(p: Seg, q: Seg): Pt | null {
  const r = [p.b[0] - p.a[0], p.b[1] - p.a[1]], s = [q.b[0] - q.a[0], q.b[1] - q.a[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q.a[0] - p.a[0]) * s[1] - (q.a[1] - p.a[1]) * s[0]) / den, u = ((q.a[0] - p.a[0]) * r[1] - (q.a[1] - p.a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const x: Pt = [p.a[0] + t * r[0], p.a[1] + t * r[1]];
  if ((eqPt(x, p.a) || eqPt(x, p.b)) && (eqPt(x, q.a) || eqPt(x, q.b))) return null;   // ignore endpoints
  return x;
}
/** SCH_LINE::BuildWireWithHopShape for one segment among `all`, radius R (mm). */
export function wireHopShape(me: Seg, all: Seg[], R: number): HopPiece[] {
  const hits: Pt[] = [];
  for (const o of all) {
    if (eqPt(o.a, me.a) && eqPt(o.b, me.b)) continue;
    if (!shouldHopOver(me, o)) continue;
    const x = crossing(me, o); if (!x) continue;
    if (eqPt(x, me.a) || eqPt(x, me.b) || eqPt(x, o.a) || eqPt(x, o.b)) continue;   // a T or an end on the line: not a crossing
    if (!hits.length || !eqPt(hits[hits.length - 1], x)) hits.push(x);
  }
  if (!hits.length) return [{ t: "seg", a: me.a, b: me.b }];
  const d = (p: Pt) => Math.hypot(p[0] - me.a[0], p[1] - me.a[1]);
  hits.sort((p, q) => d(p) - d(q));
  const ang = Math.atan2(me.b[1] - me.a[1], me.b[0] - me.a[0]);
  let arcAng = ang; if (arcAng < 0) arcAng += Math.PI; else if (arcAng >= Math.PI) arcAng -= Math.PI;   // the arc's side does not depend on the direction
  const out: HopPiece[] = []; let cur = me.a;
  for (const h of hits) {
    const m: Pt = [h[0] + R * Math.sin(arcAng), h[1] - R * Math.cos(arcAng)];
    const before: Pt = [h[0] - R * Math.cos(ang), h[1] - R * Math.sin(ang)], after: Pt = [h[0] + R * Math.cos(ang), h[1] + R * Math.sin(ang)];
    out.push({ t: "seg", a: cur, b: before }, { t: "arc", a: before, m, b: after });
    cur = after;
  }
  out.push({ t: "seg", a: cur, b: me.b });
  return out;
}

const CACHE = new WeakMap<object, { geoms: Geom[]; radius: number; shapes: Map<Geom, HopPiece[]> }>();
/** The hop shapes of the sheet's wires and buses, by their stroke geometry (only the ones that hop). */
export function hopShapes(doc: Doc): Map<Geom, HopPiece[]> | null {
  const R = hopOver.radius; if (!(R > 0) || doc.type !== "sch") return null;
  const geoms: Geom[] = [], segs: Seg[] = [], bySeg: Geom[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "wire" && it.kind !== "bus") continue;
    const g = it.geom.find((x) => x.t === "poly"); if (!g) continue;
    geoms.push(g);
    const p = ptsOf(it.node); if (p.length !== 2) continue;
    segs.push({ id: it.id, a: [+p[0][0], +p[0][1]], b: [+p[1][0], +p[1][1]] }); bySeg.push(g);
  }
  const c = CACHE.get(doc);
  if (c && c.radius === R && c.geoms.length === geoms.length && c.geoms.every((g, i) => g === geoms[i])) return c.shapes;
  const shapes = new Map<Geom, HopPiece[]>();
  segs.forEach((s, i) => { const sh = wireHopShape(s, segs, R); if (sh.length > 1) shapes.set(bySeg[i], sh); });
  CACHE.set(doc, { geoms, radius: R, shapes });
  return shapes;
}
/** Trace a hop shape: the runs as lines (dash pattern applies), the arcs solid, as SCH_PAINTER draws them. */
export function strokeHopShape(ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void; stroke(): void; setLineDash(d: number[]): void },
  pieces: HopPiece[], dash: number[] | null): void {
  ctx.beginPath(); if (dash) ctx.setLineDash(dash);
  for (const p of pieces) if (p.t === "seg") { ctx.moveTo(p.a[0], p.a[1]); ctx.lineTo(p.b[0], p.b[1]); }
  ctx.stroke(); if (dash) ctx.setLineDash([]);
  ctx.beginPath();
  for (const p of pieces) {
    if (p.t !== "arc") continue;
    const c = circleThrough(p.a, p.m, p.b); if (!c) { ctx.moveTo(p.a[0], p.a[1]); ctx.lineTo(p.b[0], p.b[1]); continue; }
    const n180 = (x: number) => { while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    const a0 = Math.atan2(p.a[1] - c[1], p.a[0] - c[0]), am = Math.atan2(p.m[1] - c[1], p.m[0] - c[0]), a1 = Math.atan2(p.b[1] - c[1], p.b[0] - c[0]);
    const sweep = n180(am - a0) + n180(a1 - am), r = Math.hypot(p.a[0] - c[0], p.a[1] - c[1]);
    ctx.moveTo(p.a[0], p.a[1]); ctx.arc(c[0], c[1], r, a0, a0 + sweep, sweep < 0);
  }
  ctx.stroke();
}
function circleThrough(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
