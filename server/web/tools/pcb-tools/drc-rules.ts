// pcb-tools/drc-rules.ts — the DRC providers that resolve a constraint per item through DRC_ENGINE::EvalRules: a
// custom rule (.kicad_dru) that matches decides, else the implicit Board Setup rule ("board setup constraints").
// DRC_TEST_PROVIDER_TRACK_WIDTH, _VIA_DIAMETER, _HOLE_SIZE, _ANNULAR_WIDTH, _TRACK_ANGLE, _TRACK_SEGMENT_LENGTH,
// _DISALLOW (rule disallow constraints) and _MISC::testAssertions, with KiCad's messages.
import type { BoardDoc, Conductor, DesignSettings, DrcMarker, Pt, SAtom } from "./types";
import type { DruRule, RuleItem } from "./dru";
import { evalAssertion, evalRuleConstraint, ruleMatches } from "./dru";
import { viaTypeOf } from "./dru-eval";
import { marker, mm4 } from "./drc";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { layerOf, pt } from "./util";

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
      const rh = resolve(rules, "hole_size", doc, s, A, null, micro ? (s.minMicroViaDrill || 0) : (s.minViaDrill || 0), micro ? "board setup constraints micro-via" : "board setup constraints"); const fh = fails(rh, c.drill);
      if (rh && fh) out.push(marker(micro ? "microvia_drill_out_of_range" : "drill_out_of_range", sev(rh), a[0], a[1], `${micro ? "Micro via hole size out of range" : "Hole size out of range"} (${rh.name} ${fh.kind} hole ${mm4(fh.v)}; actual ${mm4(c.drill)})`, [c.id]));
      const ann = (c.size - c.drill) / 2; const ra = resolve(rules, "annular_width", doc, s, A, null, s.minViaAnnular || 0); const fa = fails(ra, ann);
      if (ra && fa) out.push(marker("annular_width", sev(ra), a[0], a[1], `Annular width (${ra.name} ${fa.kind} annular width ${mm4(fa.v)}; actual ${mm4(ann)})`, [c.id]));
    }
  }
  // pad holes: DRC_TEST_PROVIDER_HOLE_SIZE checks every drilled pad against hole_size (the implicit rule is the minimum through hole)
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const p of padsOf(it)) {
      const d = K.kid(p.node, "drill"); if (!d) continue; const oval = K.str(d[1] as SAtom) === "oval";
      const w = oval ? K.num(d[2]) : K.num(d[1]); const h = oval ? K.num(d[3], w) : w; const hole = Math.min(w, h); if (!(hole > 0)) continue;
      const A: RuleItem = { kind: "pad", node: p.node, parent: it, layer: null };
      const r = resolve(rules, "hole_size", doc, s, A, null, s.minViaDrill || 0); const f = fails(r, hole);
      if (r && f) out.push(marker("drill_out_of_range", sev(r), p.x, p.y, `Hole size out of range (${r.name} ${f.kind} hole ${mm4(f.v)}; actual ${mm4(hole)})`, [it.id]));
    }
  }
  return out;
}

/** DRC_TEST_PROVIDER_TRACK_ANGLE: connected straight segments of a net meeting at an angle outside the rule (not at a pad). */
export function trackAngleMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], conds: Conductor[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "track_angle"))) return out;
  const segs = conds.filter((c) => c.kind === "segment") as (Conductor & { kind: "segment" })[];
  const pads = conds.filter((c) => c.kind === "pad");
  const eq = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  const seen = new Set<string>();
  for (const a of segs) for (const b of segs) {
    if (a === b || a.net !== b.net) continue; const la = layerOf(a.item.node); if (la !== layerOf(b.item.node)) continue;
    const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id; if (seen.has(key)) continue;
    const [a0, a1] = a.anchors, [b0, b1] = b.anchors; const p0 = [a0, a1].find((p) => eq(p, b0) || eq(p, b1)); if (!p0) continue;
    seen.add(key);
    if (pads.some((c) => c.layers.has(la) && c.kind === "pad" && Math.hypot(c.pad.x - p0[0], c.pad.y - p0[1]) < 1e-6)) continue;
    const r = resolve(rules, "track_angle", doc, s, { kind: "segment", node: a.item.node, item: a.item, layer: la }, { kind: "segment", node: b.item.node, item: b.item, layer: la }, null); if (!r) continue;
    const dir = (u: Pt, v: Pt, at: Pt) => { let d = [v[0] - u[0], v[1] - u[1]]; if (eq(v, at)) d = [-d[0], -d[1]]; const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
    const da = dir(a0, a1, p0), db = dir(b0, b1, p0);
    const actual = Math.acos(Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1]))) * 180 / Math.PI;
    let f: { kind: string; v: number } | null = null;
    if (r.min != null && actual < r.min - 1e-9) f = { kind: "min", v: r.min }; if (r.max != null && actual > r.max + 1e-9) f = { kind: "max", v: r.max };
    if (f) out.push(marker("track_angle", sev(r), p0[0], p0[1], `Track angle (${r.name} ${f.kind} angle ${deg(f.v)}; actual ${deg(actual)})`, [a.id, b.id]));
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
