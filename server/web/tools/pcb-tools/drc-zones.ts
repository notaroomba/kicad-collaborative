// pcb-tools/drc-zones.ts — DRC_TEST_PROVIDER_ZONE_CONNECTIONS (starved_thermal): a pad joined to its net's zone by
// thermal relief must reach the zone's fill through at least min_resolved_spokes spokes.  The spokes are counted as
// KiCad counts them: the pad outline grown by half the thermal gap, crossed by the fill's outlines (each pair of
// crossings is one spoke); spokes into an island that touches nothing else are not counted, tracks from the pad to
// the fill are.  Works on the fill stored in the board (as KiCad's DRC does when it does not refill).
import type { Conductor, DesignSettings, DrcMarker, PadInfo, Pt } from "./types";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { coreDist, padShape, polyPolyDist, shapeBBox, shapeOffset } from "./distances";
import { zoneFillMode } from "./nodes";
import { marker } from "./drc";
import type { DruRule, RuleItem } from "./dru";
import { evalRuleConstraint } from "./dru";
import { conductors } from "./netlist";
import { pointInPoly } from "./hit";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { rotator } from "./util";

const defaultSeverity = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
type Conn = "none" | "thermal" | "solid" | "tht_thermal";
const CONN_CODES: Conn[] = ["none", "thermal", "solid", "tht_thermal"];

/** A zone's own pad connection: (connect_pads yes) solid, (connect_pads no) none, thru_hole_only, else thermal reliefs. */
function zoneConnection(z: SNode): Conn {
  const cp = K.kid(z, "connect_pads"); if (!cp) return "thermal";
  const mode = cp.slice(1).find((x) => !Array.isArray(x)); const m = mode === undefined ? "" : K.str(mode);
  return m === "yes" ? "solid" : m === "no" ? "none" : m === "thru_hole_only" ? "tht_thermal" : "thermal";
}
const localConn = (n: SNode | null): Conn | null => { const z = n && K.kid(n, "zone_connect"); if (!z) return null; const v = K.num(z[1], -1); return CONN_CODES[v] || null; };
/** DRC_ENGINE::EvalZoneConnection: the pad's override, its footprint's, else the zone's; THT thermal is solid for an SMD pad. */
export function padZoneConnection(pad: PadInfo, fp: KItem, zone: SNode): Conn {
  const c = localConn(pad.node) || localConn(fp.node) || zoneConnection(zone);
  if (c === "tht_thermal") return pad.type === "thru_hole" || pad.type === "np_thru_hole" ? "thermal" : "solid";
  return c;
}
/** THERMAL_RELIEF_GAP_CONSTRAINT: the pad's thermal gap, its footprint's, else the zone's (fill (thermal_gap …)). */
export function thermalGap(pad: PadInfo, fp: KItem, zone: SNode) {
  for (const n of [pad.node, fp.node]) { const g = K.kid(n, "thermal_gap"); if (g) return K.num(g[1], 0.5); }
  const f = K.kid(zone, "fill"); const g = f && K.kid(f, "thermal_gap"); return g ? K.num(g[1], 0.5) : 0.5;
}

/** PAD::TransformShapeToPolygon( …, clearance ): the pad's outline grown by `grow`, a closed polygon. */
export function padOutline(p: PadInfo, grow: number): Pt[] {
  const s = padShape(p); const N = 32; const out: Pt[] = [];
  if (s.t === "circle") { for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; out.push([s.x + (s.r + grow) * Math.cos(a), s.y + (s.r + grow) * Math.sin(a)]); } return out; }
  if (s.t === "seg") {
    const r = s.r + grow; const a = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
    for (let i = 0; i <= N / 2; i++) { const t = a + Math.PI / 2 + Math.PI * i / (N / 2); out.push([s.a[0] + r * Math.cos(t), s.a[1] + r * Math.sin(t)]); }
    for (let i = 0; i <= N / 2; i++) { const t = a - Math.PI / 2 + Math.PI * i / (N / 2); out.push([s.b[0] + r * Math.cos(t), s.b[1] + r * Math.sin(t)]); }
    return out;
  }
  if (s.t === "rect") {
    const rr = Math.max(0, s.rr + grow); const hw = s.w / 2 - s.rr, hh = s.h / 2 - s.rr; const R = rotator(s.rot || 0);
    const corners: [number, number, number][] = [[hw, hh, 0], [-hw, hh, Math.PI / 2], [-hw, -hh, Math.PI], [hw, -hh, 3 * Math.PI / 2]];
    for (const [cx, cy, a0] of corners) for (let i = 0; i <= 8; i++) { const t = a0 + Math.PI / 2 * i / 8; const [dx, dy] = R(cx + rr * Math.cos(t), cy + rr * Math.sin(t)); out.push([s.x + dx, s.y + dy]); }
    return out;
  }
  return out;
}
/** SHAPE_LINE_CHAIN::Intersect: the points where two closed outlines cross, each point once. */
function crossings(P: Pt[], Q: Pt[], qb: number[]): Pt[] {
  const out: Pt[] = []; const seen = new Set<string>();
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (Math.max(a[0], b[0]) < qb[0] || Math.min(a[0], b[0]) > qb[2] || Math.max(a[1], b[1]) < qb[1] || Math.min(a[1], b[1]) > qb[3]) continue;
    for (let j = 0; j < Q.length; j++) {
      const c = Q[j], d = Q[(j + 1) % Q.length];
      const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]]; const den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-15) continue;
      const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const p: Pt = [a[0] + t * r[0], a[1] + t * r[1]]; const k = Math.round(p[0] * 1e6) + "," + Math.round(p[1] * 1e6); if (seen.has(k)) continue; seen.add(k); out.push(p);
    }
  }
  return out;
}
const boxOf = (pts: Pt[]) => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of pts) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; return b; };
const isTeardrop = (z: SNode) => { const a = K.kid(z, "attr"); return !!a && !!K.kid(a, "teardrop"); };
/** PAD::FlashLayer on a copper layer (unused-layer removal keeps the ends and connected layers; treated as flashed here). */
const padOnLayer = (p: PadInfo, layer: string) => p.layers.some((l) => l === layer || l === "*.Cu" || (l === "F&B.Cu" && (layer === "F.Cu" || layer === "B.Cu")));

/** DRC_TEST_PROVIDER_ZONE_CONNECTIONS::testZoneLayer for every copper zone and layer. */
export function starvedThermalMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[], conds?: Conductor[]): DrcMarker[] {
  const out: DrcMarker[] = []; const sev = defaultSeverity("starved_thermal");
  const all = conds || conductors(doc as never);
  const fills = new Map<string, Map<string, Pt[][]>>();   // zone id → layer → fill outlines
  for (const c of all) if (c.kind === "zone") { const l = [...c.layers][0]; let m = fills.get(c.id); if (!m) fills.set(c.id, m = new Map()); const a = m.get(l); const pts = (c.shape as { pts: Pt[] }).pts; if (a) a.push(pts); else m.set(l, [pts]); }
  if (!fills.size) return out;
  const fps = [...doc.items.values()].filter((it) => it.kind === "footprint"); const padsByFp = new Map(fps.map((fp) => [fp, padsOf(fp)]));
  const netOfPad = (p: PadInfo) => p.net.name || (p.net.code > 0 && doc.nets ? String(doc.nets.get(p.net.code) || "") : "");
  const defMin = typeof s.minResolvedSpokes === "number" ? s.minResolvedSpokes as number : 2;
  for (const z of doc.items.values()) {
    if (z.kind !== "zone" || K.kid(z.node, "keepout") || isTeardrop(z.node)) continue;
    const zf = fills.get(z.id); if (!zf) continue;
    const zNet = (all.find((c) => c.id === z.id) || { net: "" }).net; if (!zNet) continue;
    for (const [layer, outlines] of zf) {
      const obox = outlines.map(boxOf); const zb = [Math.min(...obox.map((b) => b[0])), Math.min(...obox.map((b) => b[1])), Math.max(...obox.map((b) => b[2])), Math.max(...obox.map((b) => b[3]))];
      const single = new Map<number, boolean>();
      // ISOLATED_ISLANDS::m_SingleConnectionOutlines: a fill outline that only one item of the net touches
      const singleConn = (jj: number) => {
        let v = single.get(jj); if (v !== undefined) return v; const poly = { t: "poly" as const, pts: outlines[jj] }; const ids = new Set<string>();
        for (const c of all) {
          if (c.kind === "zone" || c.net !== zNet || !c.layers.has(layer)) continue; const b = c.bbox; const ob = obox[jj];
          if (b[0] > ob[2] || b[2] < ob[0] || b[1] > ob[3] || b[3] < ob[1]) continue;
          if (coreDist(c.shape, poly) - shapeOffset(c.shape) <= 1e-6) ids.add(c.kind === "pad" ? c.id + ":" + c.index : c.id);
          if (ids.size > 1) break;
        }
        v = ids.size <= 1; single.set(jj, v); return v;
      };
      for (const fp of fps) for (const p of padsByFp.get(fp)!) {
        const net = netOfPad(p); if (!net || net !== zNet) continue;
        if (!padOnLayer(p, layer)) continue;
        const pb = shapeBBox(padShape(p)); if (pb[0] > zb[2] || pb[2] < zb[0] || pb[1] > zb[3] || pb[3] < zb[1]) continue;
        if (padZoneConnection(p, fp, z.node) !== "thermal") continue;
        const A: RuleItem = { kind: "pad", node: p.node, parent: fp, layer }, B: RuleItem = { kind: "zone", node: z.node, item: z, layer };
        const hit = rules.length ? evalRuleConstraint(rules, "min_resolved_spokes", doc as never, s, A, B) : null;
        if (hit && hit.severity === "ignore") continue;
        const minCount = hit && hit.min != null ? hit.min : defMin; const name = hit ? hit.name : "board setup constraints zone fill strategy";
        if (!(minCount > 0)) continue;
        const gh = rules.length ? evalRuleConstraint(rules, "thermal_relief_gap", doc as never, s, A, B) : null;
        const midGap = (gh && gh.min != null ? gh.min : thermalGap(p, fp, z.node)) / 2;
        const outline = padOutline(p, midGap); if (outline.length < 3) continue; const ob = boxOf(outline);
        let spokes = 0, ignored = 0; let ignoredPos: Pt | null = null;
        outlines.forEach((fo, jj) => {
          const b = obox[jj]; if (b[0] > ob[2] || b[2] < ob[0] || b[1] > ob[3] || b[3] < ob[1]) return;
          const x = crossings(fo, outline, ob); if (x.length < 2) return;
          if (singleConn(jj)) { ignored += Math.floor(x.length / 2); ignoredPos = [(x[0][0] + x[1][0]) / 2, (x[0][1] + x[1][1]) / 2]; }
          else spokes += Math.floor(x.length / 2);
        });
        if (spokes === 0 && ignored === 0) continue;   // not connected at all
        if (spokes < minCount) {
          // tracks drawn by hand from inside the pad outline to the fill
          const inFill = (q: Pt) => outlines.some((fo) => pointInPoly(fo, q[0], q[1]));
          for (const c of all) {
            if ((c.kind !== "segment" && c.kind !== "arc") || c.net !== zNet || !c.layers.has(layer)) continue;
            const [a0, a1] = c.anchors;
            if (pointInPoly(outline, a0[0], a0[1])) { if (inFill(a1)) spokes++; }
            else if (pointInPoly(outline, a1[0], a1[1])) { if (inFill(a0)) spokes++; }
          }
        }
        if (spokes === 0) { spokes += ignored; ignored = 0; }
        if (spokes >= minCount) continue;
        const pos: Pt = ignored && ignoredPos ? ignoredPos : [p.x, p.y];
        const detail = ignored ? `(layer ${layer}; ${ignored} spokes connected to isolated island)` : `(layer ${layer}; ${name} min spoke count ${minCount}; actual ${spokes})`;
        const m = marker("starved_thermal", sev, pos[0], pos[1], `Thermal relief connection to zone incomplete ${detail}`, [z.id, fp.id]) as DrcMarker & { layer?: string };
        m.layer = layer; out.push(m);
      }
    }
  }
  return out;
}

/**
 * DRC_TEST_PROVIDER_CONNECTIVITY's isolated copper: a zone fill island (one outline of the stored fill) that no item
 * of the zone's net touches — CN_CONNECTIVITY_ALGO::FillIsolatedIslandsMap's orphaned outlines.  Copper thieving is
 * netless dummy copper and never reported; a zone without a net has nothing to connect to and is left alone.
 */
export function isolatedCopperMarkers(doc: KDoc, conds?: Conductor[]): DrcMarker[] {
  const out: DrcMarker[] = []; const sev = defaultSeverity("isolated_copper");
  const all = conds || conductors(doc as never);
  const zonesCs = all.filter((c) => c.kind === "zone"); if (!zonesCs.length) return out;
  const others = all.filter((c) => c.kind !== "zone");
  for (const c of zonesCs) {
    if (!c.net || zoneFillMode(c.item.node) === "thieving" || isTeardrop(c.item.node)) continue;
    const layer = [...c.layers][0]; const poly = c.shape as { t: "poly"; pts: Pt[] }; const b = c.bbox;
    const touches = (o: Conductor) => o.net === c.net && o.layers.has(layer) && !(o.bbox[0] > b[2] || o.bbox[2] < b[0] || o.bbox[1] > b[3] || o.bbox[3] < b[1])
      && (o.kind === "zone" ? polyPolyDist(poly.pts, (o.shape as { pts: Pt[] }).pts) <= 1e-6 : coreDist(o.shape, poly) - shapeOffset(o.shape) <= 1e-6);
    if (others.some(touches) || zonesCs.some((o) => o !== c && o.id !== c.id && touches(o))) continue;
    const m = marker("isolated_copper", sev, poly.pts[0][0], poly.pts[0][1], "Isolated copper fill", [c.id]) as DrcMarker & { layer?: string };
    m.layer = layer; out.push(m);
  }
  return out;
}
