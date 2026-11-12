// pcb-tools/rule-resolver.ts — PNS_PCBNEW_RULE_RESOLVER (pcbnew/router/pns_kicad_iface.cpp) for the custom rules:
// the router's clearance and size queries go through the same .kicad_dru rules DRC evaluates (S.dru, parsed once by
// setCustomRules), so a rule that widens the clearance between two classes moves the walkaround, the shove, the
// collision highlight and the drag the same way it moves the DRC markers.  Without custom rules every query falls
// back to the implicit rules (netclass clearance, Board Setup minimums) the router used before.
import type { BoardDoc, DesignSettings } from "./types";
import type { DruRule, RuleItem } from "./dru";
import { evalRuleConstraint } from "./dru";
import { netClearance } from "./drc";
import { S } from "./state";

/** The constraint types a clearance query can resolve. */
const CLR_TYPES = new Set(["clearance", "hole_clearance", "edge_clearance", "physical_clearance", "physical_hole_clearance", "hole_to_hole"]);
/** The routed item a query is about: a track or via of a net on a layer (a synthetic node, as PNS::ITEM has no board item yet). */
export interface RoutedItem { kind?: "segment" | "via" | "arc"; net: string; layer: string | null; width?: number; size?: number; drill?: number }
/** The obstacle side of a query: its router kind, net, and the board item it stands for when it has one. */
export interface RuleObstacle { kind: string; net: string; id?: string | null; rule?: RuleItem | null }

/** The custom rules with any constraint the router asks about, or null when there are none. */
export function routerRules(): DruRule[] | null {
  const d = S.dru; if (!d || !d.rules.length) return null;
  if (S.routerRulesFor !== d) { S.routerRulesFor = d; S.routerRulesList = d.rules.filter((r) => !r.error && r.constraints.some((c) => CLR_TYPES.has(c.type))); }
  return S.routerRulesList && S.routerRulesList.length ? S.routerRulesList : null;
}
/** A synthetic board item for the routed track or via, so A.NetClass, A.Type, A.Layer … read what the router will make. */
export function routedRuleItem(A: RoutedItem): RuleItem {
  const net = ["net", A.net || ""];
  if (A.kind === "via") return { kind: "via", node: ["via", ["at", 0, 0], ["size", A.size || 0.6], ["drill", A.drill || 0.3], ["layers", "F.Cu", "B.Cu"], net], layer: A.layer };
  return { kind: A.kind || "segment", node: [A.kind || "segment", ["start", 0, 0], ["end", 0, 0], ["width", A.width || 0.25], ["layer", A.layer || "F.Cu"], net], layer: A.layer };
}
/** The obstacle as a rule item: the board item behind it (pad, track, via, zone) or a stand-in of its kind and net. */
export function obstacleRuleItem(ob: RuleObstacle, layer: string | null): RuleItem {
  if (ob.rule) return Object.assign({}, ob.rule, { layer });
  if (ob.kind === "edge") return { kind: "gr_line", node: ["gr_line", ["layer", "Edge.Cuts"]], layer };
  const kind = ob.kind === "track" || ob.kind === "line" ? "segment" : ob.kind;
  return { kind, node: [kind, ["layer", layer || "F.Cu"], ["net", ob.net || ""]], layer };
}
const cache = new Map<string, number | null>(); let cacheVer: unknown = null, cacheDru: unknown = null;
/**
 * PNS_PCBNEW_RULE_RESOLVER::Clearance against the custom rules: the largest clearance a matching rule gives, by the
 * obstacle's kind — hole_clearance (and physical_hole_clearance) for a hole, edge_clearance for the board edge,
 * clearance for copper of another net (floored at the board minimum), physical_clearance whatever the nets — with
 * A and B taken either way round.  null when no custom rule matches and the implicit rules decide.
 */
export function customRouteClearance(doc: BoardDoc | null, s: DesignSettings, A: RoutedItem, ob: RuleObstacle, layer: string | null): number | null {
  const rules = routerRules(); if (!rules || !doc) return null;
  if (cacheVer !== S.docVer || cacheDru !== S.dru) { cache.clear(); cacheVer = S.docVer; cacheDru = S.dru; }
  const key = (A.kind || "segment") + "|" + A.net + "|" + (layer || "") + "|" + (A.width || "") + "|" + ob.kind + "|" + (ob.id || "") + "|" + ob.net;
  if (cache.has(key)) return cache.get(key)!;
  const a = routedRuleItem(Object.assign({}, A, { layer })), b = obstacleRuleItem(ob, layer);
  const q = (type: string) => { const h = evalRuleConstraint(rules, type, doc, s, a, b) || evalRuleConstraint(rules, type, doc, s, b, a); return h ? (h.severity === "ignore" ? 0 : h.min) : null; };
  let rv: number | null = null; const take = (v: number | null) => { if (v != null) rv = Math.max(rv ?? 0, v); };
  const sameNet = !!A.net && A.net === ob.net;
  if (ob.kind === "hole") { if (!sameNet) take(q("hole_clearance")); take(q("physical_hole_clearance")); }
  else if (ob.kind === "edge") take(q("edge_clearance"));
  else if (ob.kind !== "keepout" && !sameNet) { const c = q("clearance"); if (c != null) take(c > 0 ? Math.max(c, s.minClearance || 0) : 0); }
  take(q("physical_clearance"));
  cache.set(key, rv); return rv;
}
/** The pair clearance two routed lines need (the shove's line-against-line and line-against-via checks). */
export function rulePairClearance(doc: BoardDoc | null, s: DesignSettings, netA: string, netB: string, layer: string | null, kindB?: string): number {
  const base = Math.max(netClearance(s, netA), netClearance(s, netB), s.minClearance || 0);
  const c = customRouteClearance(doc, s, { net: netA, layer }, { kind: kindB === "via" ? "via" : "segment", net: netB }, layer);
  return c == null ? base : c;
}

/** MINOPTMAX::PinnedOpt: the opt clamped to min / max, or the min when there is no opt. */
export const pinnedOpt = (h: { min: number | null; opt: number | null; max: number | null }) => {
  if (h.opt == null) return h.min; let v = h.opt; if (h.min != null) v = Math.max(v, h.min); if (h.max != null) v = Math.min(v, h.max); return v;
};
/**
 * The sizes PNS::SIZES_SETTINGS takes from the custom rules while the toolbar follows the netclass
 * (PNS_KICAD_IFACE_BASE::ImportSizes): track_width / via_diameter / hole_size pinned opt from the rule that matches
 * a track (via) of the routed net, and for a pair the track_width opt and diff_pair_gap pinned opt with B the
 * coupled net's track.  Each is null when no custom rule gives it (the netclass value then applies).
 */
export function ruleSizes(doc: BoardDoc | null, s: DesignSettings, net: string, layer: string | null, coupled?: string | null) {
  const d = S.dru; const out = { width: null as number | null, viaDiameter: null as number | null, viaDrill: null as number | null, dpGap: null as number | null, dpWidth: null as number | null, widthRule: null as string | null, gapRule: null as string | null };
  if (!d || !d.rules.length || !doc) return out;
  const tr = routedRuleItem({ net, layer }), via = routedRuleItem({ kind: "via", net, layer }), co = coupled ? routedRuleItem({ net: coupled, layer }) : null;
  const w = evalRuleConstraint(d.rules, "track_width", doc, s, tr, null); if (w) out.width = pinnedOpt(w);
  const vd = evalRuleConstraint(d.rules, "via_diameter", doc, s, via, null); if (vd) out.viaDiameter = pinnedOpt(vd);
  const vh = evalRuleConstraint(d.rules, "hole_size", doc, s, via, null); if (vh) out.viaDrill = pinnedOpt(vh);
  const pw = evalRuleConstraint(d.rules, "track_width", doc, s, tr, co); if (pw && pw.opt != null) { out.dpWidth = pw.opt; out.widthRule = pw.name; }
  const g = evalRuleConstraint(d.rules, "diff_pair_gap", doc, s, tr, co); if (g) { out.dpGap = pinnedOpt(g); out.gapRule = g.name; }
  return out;
}
