// pcb-tools/drc-rules.ts — the DRC providers that resolve a constraint per item through DRC_ENGINE::EvalRules: a
// custom rule (.kicad_dru) that matches decides, else the implicit Board Setup rule ("board setup constraints").
// DRC_TEST_PROVIDER_TRACK_WIDTH, _VIA_DIAMETER, _HOLE_SIZE, _ANNULAR_WIDTH, _TRACK_ANGLE, _TRACK_SEGMENT_LENGTH,
// _DISALLOW (rule disallow constraints) and _MISC::testAssertions, with KiCad's messages.
import type { BoardDoc, Conductor, CopperShape, DesignSettings, DrcMarker, PadInfo, Pt, SAtom } from "./types";
import { dPS, shapeGap } from "./distances";
import type { DruRule, RuleItem } from "./dru";
import { evalAssertion, evalRuleConstraint, ruleMatches } from "./dru";
import { viaTypeOf } from "./dru-eval";
import { marker, mm4 } from "./drc";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { layerOf, pt, rotator } from "./util";
import { padShapePolygon } from "./pad-outline";
import { pointInPoly } from "./hit";
import { clipperArea, copperCtx, type CopperCtx } from "./drc-sliver";
import { padPrims } from "../../fab/plot";
import { type Prim, type Pt as FPt } from "../../fab/prims";
import { primPolys, stadium, subtract as subtractPolys, union as unionPolys } from "../../fab/poly";

/** A resolved constraint: min / max and the name the message gives it; null when the rule says ignore. */
export interface Resolved { min: number | null; max: number | null; name: string; severity: string | null }
/** EvalRules( type, A, B ): the custom rule that matches, else the implicit board-setup rule (`implicit`, a min). */
export function resolve(rules: DruRule[], type: string, doc: BoardDoc, s: DesignSettings, A: RuleItem, B: RuleItem | null, implicitMin: number | null, implicitName = "board setup constraints"): Resolved | null {
  const h = rules.length ? evalRuleConstraint(rules, type, doc, s, A, B) : null;
  if (h) return h.severity === "ignore" ? null : { min: h.min, max: h.max, name: h.name, severity: h.severity || null };
  return implicitMin != null && implicitMin > 0 ? { min: implicitMin, max: null, name: implicitName, severity: null } : null;
}
/** min / max test of `actual` against a resolved constraint: the failing bound or null. */
function fails(c: Resolved | null, actual: number, eps = 1e-6): { kind: "min" | "max"; v: number } | null {
  if (!c) return null;
  if (c.min != null && c.min > 0 && actual < c.min - eps) return { kind: "min", v: c.min };
  if (c.max != null && actual > c.max + eps) return { kind: "max", v: c.max };
  return null;
}
const sev = (c: Resolved) => c.severity === "warning" || c.severity === "error" ? c.severity : "error";
const deg = (v: number) => v.toFixed(1) + "°";

/** The width, via, hole and annular checks for the conductors (tracks, arcs, vias) and the pads' holes. */
export function sizeMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], conds: Conductor[]): DrcMarker[] {
  const out: DrcMarker[] = [];
  for (const c of conds) {
    if (c.kind === "segment" || c.kind === "arc") {
      const [a, b] = c.anchors; const layer = layerOf(c.item.node); const A: RuleItem = { kind: c.kind, node: c.item.node, item: c.item, layer, shape: c.shape };
      const r = resolve(rules, "track_width", doc, s, A, null, s.minTrackWidth || 0); const f = fails(r, c.width);
      if (r && f) out.push(marker("track_width", sev(r), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, `Track width (${r.name} ${f.kind} width ${mm4(f.v)}; actual ${mm4(c.width)})`, [c.id]));
      if (c.kind === "segment" && rules.length) {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const rl = resolve(rules, "track_segment_length", doc, s, A, null, null); const fl = fails(rl, L);
        if (rl && fl) out.push(marker("track_segment_length", sev(rl), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, `Track segment length (${rl.name} ${fl.kind} length ${mm4(fl.v)}; actual ${mm4(L)})`, [c.id]));
      }
    } else if (c.kind === "via") {
      const [a] = c.anchors; const A: RuleItem = { kind: "via", node: c.item.node, item: c.item, layer: null, shape: c.shape };
      if (c.drill >= c.size - 1e-6) { out.push(marker("annular_width", "error", a[0], a[1], `Annular width (drill ${mm4(c.drill)} is not smaller than the via diameter ${mm4(c.size)})`, [c.id])); continue; }
      const rd = resolve(rules, "via_diameter", doc, s, A, null, s.minViaDiameter || 0); const fd = fails(rd, c.size);
      if (rd && fd) out.push(marker("via_diameter", sev(rd), a[0], a[1], `Via diameter (${rd.name} ${fd.kind} diameter ${mm4(fd.v)}; actual ${mm4(c.size)})`, [c.id]));
      const micro = viaTypeOf(c.item.node) === "micro";
      const rh = resolve(rules, "hole_size", doc, s, A, null, micro ? (s.minMicroViaDrill || 0) : (s.minThroughDrill || 0), micro ? "board setup constraints micro-via" : "board setup constraints"); const fh = fails(rh, c.drill);
      if (rh && fh) out.push(marker(micro ? "microvia_drill_out_of_range" : "drill_out_of_range", sev(rh), a[0], a[1], `${micro ? "Micro via hole size out of range" : "Hole size out of range"} (${rh.name} ${fh.kind} hole ${mm4(fh.v)}; actual ${mm4(c.drill)})`, [c.id]));
      const ann = (c.size - c.drill) / 2; const ra = resolve(rules, "annular_width", doc, s, A, null, s.minViaAnnular || 0); const fa = fails(ra, ann);
      if (ra && fa) out.push(marker("annular_width", sev(ra), a[0], a[1], `Annular width (${ra.name} ${fa.kind} annular width ${mm4(fa.v)}; actual ${mm4(ann)})`, [c.id]));
    }
  }
  out.push(...padAnnularMarkers(doc, s, rules));
  // pad holes: DRC_TEST_PROVIDER_HOLE_SIZE checks every drilled pad against hole_size (the implicit rule is the minimum through hole)
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const p of padsOf(it)) {
      const d = K.kid(p.node, "drill"); if (!d) continue; const oval = K.str(d[1] as SAtom) === "oval";
      const w = oval ? K.num(d[2]) : K.num(d[1]); const h = oval ? K.num(d[3], w) : w;
      const minor = Math.min(w, h), major = Math.max(w, h); if (!(minor > 0)) continue;   // checkPadHole: holeMinor / holeMajor
      const A: RuleItem = { kind: "pad", node: p.node, parent: it, layer: null };
      const r = resolve(rules, "hole_size", doc, s, A, null, s.minThroughDrill || 0); if (!r) continue;
      // max is tested against the major axis, min against the minor one; when both fail the min message is reported
      const f = r.min != null && r.min > 0 && minor < r.min - 1e-6 ? { kind: "min", v: r.min, actual: minor }
        : r.max != null && major > r.max + 1e-6 ? { kind: "max", v: r.max, actual: major } : null;
      if (f) out.push(marker("drill_out_of_range", sev(r), p.x, p.y, `Hole size out of range (${r.name} ${f.kind} hole ${mm4(f.v)}; actual ${mm4(f.actual)})`, [it.id]));
    }
  }
  return out;
}

/** The copper outline of a pad (PAD::TransformShapeToPolygon), board frame: pad-outline.ts' exact port for the
 *  built-in shapes; a custom pad's comes from `custom` (the plotter's merged primitives), else null. */
export type PadOutlineFn = (q: PadInfo) => Pt[][] | null;
function builtinOutline(q: PadInfo): Pt[][] | null {
  if (q.shape === "custom") return null;
  const [ox, oy] = rotator(q.rot)(q.off[0], q.off[1]);
  return [padShapePolygon(q.node, [q.x + ox, q.y + oy])];
}
/** GetEffectiveHoleShape: the hole's centre line (a point for a round hole) and its radius. */
function holeSlot(q: PadInfo): { a: Pt; b: Pt; r: number } | null {
  const d = K.kid(q.node, "drill"); if (!d) return null; const oval = K.str(d[1] as SAtom) === "oval";
  const dx = oval ? K.num(d[2]) : K.num(d[1]), dy = oval ? K.num(d[3], dx) : dx; if (!(Math.min(dx, dy) > 0)) return null;
  const half = Math.abs(dx - dy) / 2, [hx, hy] = dx >= dy ? rotator(q.rot)(half, 0) : rotator(q.rot)(0, half);
  return { a: [q.x - hx, q.y - hy], b: [q.x + hx, q.y + hy], r: Math.min(dx, dy) / 2 };
}
function bboxOfPolys(polys: Pt[][]): [number, number, number, number] {
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const q of p) b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])];
  return b;
}
const boxHit = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const boxIn = (outer: number[], inner: number[]) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
/** Segment-to-segment distance (SEG::NearestPoints). */
function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(dPS(a, c, d), dPS(b, c, d), dPS(c, a, b), dPS(d, a, b));
}
/** SHAPE_POLY_SET::NearestPoints( slot ): the outline edge nearest the hole's centre line, moved out by the hole's
 *  radius toward it — |distance - radius|, 0 when the centre line touches an edge. */
function slotToOutline(polys: Pt[][], slot: { a: Pt; b: Pt; r: number }): number {
  let d = Infinity;
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) d = Math.min(d, segSegDist(slot.a, slot.b, p[j], p[i]));
  return !isFinite(d) || d === 0 ? 0 : Math.abs(d - slot.r);
}
/**
 * The annulus of a plated pad (DRC_TEST_PROVIDER_ANNULAR_WIDTH getPadAnnulusPts): with no shape offset a circle, oval,
 * rectangle, rounded or lightly chamfered rectangle takes the narrower of (size - drill) / 2 on each axis; otherwise
 * (custom, trapezoid, heavily chamfered, offset shapes, or same-number pads overlapping it) the slow path: the
 * distance from the hole to the pad's outline — or to the outline of it and every same-number pad merged, their own
 * holes cut out — and 0 when the hole is outside the copper.  null when an outline cannot be had.
 */
export function padAnnulus(p: PadInfo, sameNum: PadInfo[] = [], c: { min: number | null; max: number | null } | null = { min: 1, max: null }, custom?: PadOutlineFn): number | null {
  const d = K.kid(p.node, "drill"); if (!d) return null; const oval = K.str(d[1] as SAtom) === "oval";
  const dx = oval ? K.num(d[2]) : K.num(d[1]), dy = oval ? K.num(d[3], dx) : dx;
  const cr = K.kid(p.node, "chamfer_ratio"), chamfered = !!K.kid(p.node, "chamfer") && !!cr;
  const offset = Math.abs(p.off[0]) > 1e-9 || Math.abs(p.off[1]) > 1e-9;
  const handled = !offset && (["circle", "oval", "rect", "roundrect"].includes(p.shape) && (!chamfered || K.num(cr![1]) <= 0.30));
  const fast = offset ? null : Math.abs(Math.min((p.w - dx) / 2, (p.h - dy) / 2));   // |ptA - ptB|: the distance, never negative
  const outline = (q: PadInfo) => builtinOutline(q) || (custom ? custom(q) : null);
  const mine = outline(p); if (!mine) return handled ? fast : null;
  const box = bboxOfPolys(mine);
  const overlapping = sameNum.filter((q) => { const o = outline(q); return !!o && boxHit(bboxOfPolys(o), box); });
  let covers = false, holeCuts = false;
  for (const q of overlapping) {
    if (boxIn(bboxOfPolys(outline(q)!), box)) covers = true;
    const h = holeSlot(q); if (h) { const hb = [Math.min(h.a[0], h.b[0]) - h.r, Math.min(h.a[1], h.b[1]) - h.r, Math.max(h.a[0], h.b[0]) + h.r, Math.max(h.a[1], h.b[1]) + h.r]; if (boxHit(hb, box)) holeCuts = true; }
  }
  const hasMin = !!c && c.min != null && c.min > 0, hasMax = !!c && c.max != null;
  if (handled && overlapping.length && !holeCuts && !covers && hasMin && !hasMax) {
    if (p.shape === "circle") return fast;
    if (fast! >= c!.min! - 1e-9) return fast;
  }
  if (handled && !overlapping.length) return fast;
  const slot = holeSlot(p); if (!slot) return fast;
  if (!sameNum.length) return pointInPoly(mine[0], p.x, p.y) || mine.some((q) => pointInPoly(q, p.x, p.y)) ? slotToOutline(mine, slot) : 0;
  if (!hasMin) return fast;
  let agg: Pt[][] = mine.slice(); const holes: Pt[][] = [];
  for (const q of sameNum) { const o = outline(q); if (o) agg.push(...o); const h = holeSlot(q); if (h) holes.push(stadiumPts(h.a, h.b, h.r)); }
  agg = subtractPolys(unionPolys(agg as FPt[][]), holes as FPt[][]);
  if (!agg.some((q) => clipperArea(q as FPt[]) > 0 && pointInPoly(q, p.x, p.y)) || agg.some((q) => clipperArea(q as FPt[]) < 0 && pointInPoly(q, p.x, p.y))) return 0;
  return slotToOutline(agg, slot);
}
/** A slot (or round hole) as a polygon, ERROR_INSIDE. */
function stadiumPts(a: Pt, b: Pt, r: number): Pt[] { return stadium(a[0], a[1], b[0], b[1], 2 * r) as Pt[]; }
/** DRC_TEST_PROVIDER_ANNULAR_WIDTH for the pads: every plated through-hole pad against annular_width on its layer. */
export function padAnnularMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = [];
  if (!((s.minViaAnnular || 0) > 0) && !rules.some((r) => r.constraints.some((c) => c.type === "annular_width"))) return out;   // HasRulesForConstraintType
  let cc: CopperCtx | null = null;
  const custom: PadOutlineFn = (q) => { const fp = (cc = cc || copperCtx(doc)).pads.get(q.node); if (!fp) return null; const prims: Prim[] = []; padPrims(fp, "F.Cu", cc.m, prims); const polys = unionPolys(prims.flatMap(primPolys)); return polys.length ? polys : null; };
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue; const pads = padsOf(it);
    for (const p of pads) {
      if (p.type !== "thru_hole" || !K.kid(p.node, "drill")) continue;
      const sameNum = p.number ? pads.filter((q) => q !== p && q.number === p.number) : [];
      const A: RuleItem = { kind: "pad", node: p.node, parent: it, layer: "F.Cu" };   // a normal padstack: one unique layer
      const r = resolve(rules, "annular_width", doc, s, A, null, s.minViaAnnular || 0); if (!r) continue;
      const w = padAnnulus(p, sameNum, r, custom); if (w == null) continue;
      const f = fails(r, w); if (!f) continue;
      out.push(marker("annular_width", sev(r), p.x, p.y, `Annular width (${r.name} ${f.kind} annular width ${mm4(f.v)}; actual ${mm4(w)})`, [it.id]));
    }
  }
  return out;
}

/** SEG::Intersect( other ) for track centre lines: the crossing point (touching ends included), the middle of the
 *  overlap for collinear segments, or null. */
export function segIntersect(a0: Pt, a1: Pt, b0: Pt, b1: Pt): Pt | null {
  const e = 1e-9;
  if (Math.max(a0[0], a1[0]) < Math.min(b0[0], b1[0]) - e || Math.max(b0[0], b1[0]) < Math.min(a0[0], a1[0]) - e
    || Math.max(a0[1], a1[1]) < Math.min(b0[1], b1[1]) - e || Math.max(b0[1], b1[1]) < Math.min(a0[1], a1[1]) - e) return null;
  const d1 = [a1[0] - a0[0], a1[1] - a0[1]], d2 = [b1[0] - b0[0], b1[1] - b0[1]], off = [b0[0] - a0[0], b0[1] - a0[1]];
  const det = d2[0] * d1[1] - d2[1] * d1[0];
  if (Math.abs(det) < 1e-12) {   // parallel: collinear segments meet over their overlap (checkCollinearOverlap)
    if (Math.abs(d1[0] * off[1] - d1[1] * off[0]) > 1e-9) return null;
    const ax = Math.abs(d1[0]) >= Math.abs(d1[1]) ? 0 : 1, o = 1 - ax;
    const s1 = [Math.min(a0[ax], a1[ax]), Math.max(a0[ax], a1[ax])], s2 = [Math.min(b0[ax], b1[ax]), Math.max(b0[ax], b1[ax])];
    if (s1[1] < s2[0] - e || s2[1] < s1[0] - e) return null;
    const proj = (Math.max(s1[0], s2[0]) + Math.min(s1[1], s2[1])) / 2;
    const other = a1[ax] !== a0[ax] ? a0[o] + (proj - a0[ax]) * (a1[o] - a0[o]) / (a1[ax] - a0[ax]) : a0[o];
    const r: Pt = [0, 0]; r[ax] = proj; r[o] = other; return r;
  }
  const t = (d2[0] * off[1] - d2[1] * off[0]) / det, u = (d1[0] * off[1] - d1[1] * off[0]) / det;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [a0[0] + t * d1[0], a0[1] + t * d1[1]];
}
/**
 * DRC_TEST_PROVIDER_TRACK_ANGLE: each straight track against the straight tracks connectivity joins to it (an end on
 * the other's copper), at the point their centre lines meet unless a pad is there.  A meeting point inside either
 * segment (a T) folds angles over 90° back by 90°.  Each order (item, other) is its own violation.
 */
export function trackAngleMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], conds: Conductor[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "track_angle"))) return out;
  const segs = conds.filter((c) => c.kind === "segment") as (Conductor & { kind: "segment" })[];
  const pads = conds.filter((c) => c.kind === "pad");
  const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 5e-7 && Math.abs(p[1] - q[1]) < 5e-7;
  // CN_CONNECTIVITY_ALGO: tracks connect when an end anchor lies on the other track's copper
  const touches = (a: Conductor & { kind: "segment" }, b: Conductor & { kind: "segment" }) => a.anchors.some((p) => dPS(p, b.anchors[0], b.anchors[1]) <= b.width / 2 + 1e-9);
  for (const a of segs) {
    const la = layerOf(a.item.node);
    for (const b of segs) {
      if (a === b || a.id === b.id || (a.net && b.net && a.net !== b.net) || la !== layerOf(b.item.node)) continue;
      if (!touches(a, b) && !touches(b, a)) continue;
      const [a0, a1] = a.anchors, [b0, b1] = b.anchors; const p0 = segIntersect(a0, a1, b0, b1); if (!p0) continue;
      if (pads.some((c) => c.layers.has(la) && shapeGap(c.shape, { t: "circle", x: p0[0], y: p0[1], r: 0 }) <= 0)) continue;   // BOARD::GetPad( p0, layer )
      const r = resolve(rules, "track_angle", doc, s, { kind: "segment", node: a.item.node, item: a.item, layer: la }, { kind: "segment", node: b.item.node, item: b.item, layer: la }, null); if (!r) continue;
      const unit = (u: Pt, v: Pt) => { const d = [v[0] - u[0], v[1] - u[1]]; const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
      let da = unit(a0, a1), db = unit(b0, b1), below90 = false;
      if (same(a1, p0)) da = [-da[0], -da[1]]; else if (!same(a0, p0)) below90 = true;
      if (same(b1, p0)) db = [-db[0], -db[1]]; else if (!same(b0, p0)) below90 = true;
      let actual = Math.acos(Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1]))) * 180 / Math.PI;
      if (below90 && actual > 90) actual -= 90;
      const fmin = r.min != null && actual < r.min, fmax = r.max != null && actual > r.max;
      if (!fmin && !fmax) continue;
      const v = fmax ? r.max! : r.min!;   // constraintAngle: the max when both fail; the text names min first
      out.push(marker("track_angle", sev(r), p0[0], p0[1], `Track angle (${r.name} ${fmin ? "min" : "max"} angle ${deg(v)}; actual ${deg(actual)})`, [a.id, b.id]));
    }
  }
  return out;
}

/** The disallow keywords of DRC_RULES_PARSER and the items they name. */
function disallowKinds(kind: string, node: SNode): string[] {
  if (kind === "segment" || kind === "arc") return ["track"];
  if (kind === "via") { const t = viaTypeOf(node); return ["via", t === "micro" ? "micro_via" : t === "blind" ? "blind_via" : t === "buried" ? "buried_via" : "through_via"]; }
  if (kind === "pad") return ["pad"];
  if (kind === "zone") return ["zone"];
  if (kind === "footprint") return ["footprint"];
  if (/^(gr|fp)_text/.test(kind) || kind === "text" || kind === "property") return ["text"];
  if (/^(gr|fp)_(line|rect|circle|arc|poly|curve)$/.test(kind)) return ["graphic"];
  return [];
}
/** Every board item a rule can name (tracks, vias, zones, footprints and their pads, graphics, texts), as rule items. */
export function ruleItems(doc: BoardDoc): RuleItem[] {
  const out: RuleItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "group" || it.kind === "generated") continue;
    out.push({ kind: it.kind, node: it.node, item: it, layer: null });
    if (it.kind === "footprint") for (const p of K.kids(it.node, "pad")) out.push({ kind: "pad", node: p, parent: it, layer: null });
  }
  return out;
}
const anchorOf = (it: RuleItem): Pt => {
  if (it.kind === "pad" && it.parent) { const p = padsOf(it.parent).find((q) => q.node === it.node); if (p) return [p.x, p.y]; }
  const p = pt(it.node, "at") || pt(it.node, "start") || pt(it.node, "center"); if (p) return p as Pt;
  const poly = K.kid(it.node, "polygon"); const pts = poly ? K.ptsOf(poly) : []; if (pts.length) return pts[0];
  const b = it.item && it.item.bbox; return b ? [b[0], b[1]] : [0, 0];
};
const idOf = (it: RuleItem) => (it.parent ? it.parent.id : it.item ? it.item.id : "");

/** DRC_TEST_PROVIDER_DISALLOW for custom rules: "Items not allowed (rule 'x')" for each item a disallow rule names. */
export function disallowMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], items?: RuleItem[]): DrcMarker[] {
  const out: DrcMarker[] = []; const dr = rules.filter((r) => !r.error && r.constraints.some((c) => c.type === "disallow")); if (!dr.length) return out;
  for (const it of items || ruleItems(doc)) {
    const kinds = disallowKinds(it.kind, it.node); if (!kinds.length) continue;
    for (let i = rules.length - 1; i >= 0; i--) {   // EvalRules: the last matching disallow rule decides
      const r = rules[i], c = r.constraints.find((k) => k.type === "disallow"); if (!c || !ruleMatches(r, doc, s, it, null)) continue;
      if (r.severity === "ignore") break;
      const flags = c.options || []; if (!flags.some((f) => kinds.includes(f) || (f === "hole" && (it.kind === "via" || (it.kind === "pad" && !!K.kid(it.node, "drill")))))) break;
      const p = anchorOf(it); out.push(marker("items_not_allowed", r.severity === "warning" ? "warning" : "error", p[0], p[1], `Items not allowed (rule '${r.name}')`, [idOf(it)])); break;
    }
  }
  return out;
}
/** DRC_TEST_PROVIDER_MISC::testAssertions: every item a rule with an assertion matches must satisfy it. */
export function assertionMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], items?: RuleItem[]): DrcMarker[] {
  const out: DrcMarker[] = []; const ar = rules.filter((r) => !r.error && r.constraints.some((c) => c.type === "assertion")); if (!ar.length) return out;
  for (const it of items || ruleItems(doc)) {
    for (const r of ar) {
      if (r.severity === "ignore" || !ruleMatches(r, doc, s, it, null)) continue;
      for (const c of r.constraints) {
        if (c.type !== "assertion") continue; const ok = evalAssertion(r, c, doc, s, it); if (ok !== false) continue;
        const p = anchorOf(it); out.push(marker("assertion_failure", r.severity === "warning" ? "warning" : "error", p[0], p[1], `Assertion failure (rule '${r.name}')`, [idOf(it)]));
      }
    }
  }
  return out;
}
