// Board evaluation — the numbers a reviewer (a person or the assistant's model) judges a layout by: what is still
// unrouted and how far apart, how much track and how many vias, and which nets wander furthest from the shortest
// way between their pads.  Pure and cheap: no routing grid is built.
import { mst } from "./place";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface NetEval { net: string; pads: number; unrouted: number; trackLength: number; vias: number; shortest: number; detourRatio: number; layers: string[] }
export interface Evaluation {
  ratsnest: number; unrouted: number; vias: number; trackLength: number; nets: number; routedNets: number;
  worstDetours: { net: string; ratio: number; trackLength: number; shortest: number }[]; perNet: NetEval[];
  drc?: { errors: number; warnings: number; byCode: Record<string, number> };
}

export function evaluate(K: any, P: any, doc: any, settings: any, opts: { drc?: boolean } = {}): Evaluation {
  void K; const nl = P.netlist(doc); const rats = P.ratsnest(doc, nl); const open = new Map<string, number>(); let ratsnest = 0;
  for (const l of rats) { open.set(l.net, (open.get(l.net) || 0) + 1); ratsnest += l.length; }
  const acc = new Map<string, { pads: [number, number][]; len: number; vias: number; layers: Set<string> }>();
  const of = (net: string) => { let e = acc.get(net); if (!e) acc.set(net, e = { pads: [], len: 0, vias: 0, layers: new Set() }); return e; };
  for (const c of nl.conductors) {
    if (!c.net) continue; const e = of(c.net);
    if (c.kind === "pad") e.pads.push([c.pad.x, c.pad.y]);
    else if (c.kind === "via") e.vias++;
    else if (c.kind === "segment" || c.kind === "arc") { const a = c.anchors[0], b = c.anchors[c.anchors.length - 1]; e.len += c.length !== undefined ? c.length : Math.hypot(b[0] - a[0], b[1] - a[1]); for (const l of c.layers as Set<string>) e.layers.add(l); }
  }
  const perNet: NetEval[] = []; let vias = 0, trackLength = 0, routedNets = 0;
  for (const [net, e] of acc) {
    if (e.pads.length < 2) { vias += e.vias; trackLength += e.len; continue; }
    const shortest = mst(e.pads); const unrouted = open.get(net) || 0; vias += e.vias; trackLength += e.len; if (!unrouted) routedNets++;
    perNet.push({ net, pads: e.pads.length, unrouted, trackLength: +e.len.toFixed(3), vias: e.vias, shortest: +shortest.toFixed(3), detourRatio: shortest > 1e-6 && !unrouted ? +(e.len / shortest).toFixed(2) : 0, layers: Array.from(e.layers).sort() });
  }
  perNet.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));
  // a net routed pad to pad never beats its spanning tree by much; well above it, the route wanders
  const worstDetours = perNet.filter((n) => n.detourRatio > 1.3 && n.trackLength - n.shortest > 2).sort((a, b) => (b.trackLength - b.shortest) - (a.trackLength - a.shortest)).slice(0, 10).map((n) => ({ net: n.net, ratio: n.detourRatio, trackLength: n.trackLength, shortest: n.shortest }));
  const out: Evaluation = { ratsnest: +ratsnest.toFixed(3), unrouted: rats.length, vias, trackLength: +trackLength.toFixed(3), nets: perNet.length, routedNets, worstDetours, perNet };
  if (opts.drc) { const byCode: Record<string, number> = {}; let errors = 0, warnings = 0; for (const m of P.drc(doc, settings)) { byCode[m.code] = (byCode[m.code] || 0) + 1; if (m.severity === "error") errors++; else warnings++; } out.drc = { errors, warnings, byCode }; }
  return out;
}
