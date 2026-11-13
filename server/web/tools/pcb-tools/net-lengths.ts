// pcb-tools/net-lengths.ts — the Net Inspector's per-net figures (PCB_NET_INSPECTOR_PANEL::calculateNets with
// LENGTH_DELAY_CALCULATION::CalculateLengthDetails, opts OptimiseVias + MergeTracks + OptimiseTracesInPads).
//
//  - Track Length: the net's tracks and arcs, a chain end inside a via (OptimiseTraceInVia) or ending on a pad's
//    position inside the pad (OptimiseTraceInPad) clipped at the via's or pad's edge; also per layer.
//  - Via Length: per via, the stackup height (BOARD_STACKUP::GetLayerDistance) between the outermost layers the
//    signal actually uses there (optimiseVias: tracks ending in the via, plus a coincident pad's side).
//  - Die Length: the pads' (die_length …).  Total Length = track + via + die (LIST_ITEM::GetTotalLength).
//  - Unrouted Length: the net's ratsnest airlines (RN_NET::GetTotalAirlineLength).
import type { BoardDoc, Conductor, Netlist, Pt } from "./types";
import { shapeGap } from "./distances";
import { netlist, ratsnest } from "./netlist";
import { K } from "./state";

export interface NetLengthRow {
  name: string; code: number; padCount: number; viaCount: number;
  trackLength: number; viaLength: number; dieLength: number; unroutedLength: number; totalLength: number;
  layerLengths: Record<string, number>;
}
interface StackItem { layer: string | null; th: number[] }

/** The copper layers in stack order: F.Cu, In1.Cu … InN.Cu, B.Cu. */
export function copperStack(copper: string[]): string[] {
  const inner = copper.filter((l) => /^In\d+\.Cu$/.test(l)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
  return ["F.Cu", ...inner, "B.Cu"];
}
/**
 * BOARD_STACKUP's item list as far as GetLayerDistance reads it: copper layers and dielectrics (null) with their
 * sub-layer thicknesses.  From the board's (setup (stackup …)) when it has one, else BuildDefaultStackupList:
 * 35 µm copper, 10 µm masks, the rest of the board thickness split evenly between the dielectrics.
 */
export function stackupItems(general: SNode | null, setup: SNode | null, copper: string[]): StackItem[] {
  const st = setup ? K.kid(setup, "stackup") : null;
  const out: StackItem[] = [];
  if (st) {
    for (const l of K.kids(st, "layer")) {
      const name = K.str(l[1]), diel = /^dielectric \d+$/.test(name);
      if (!diel && !/\.Cu$/.test(name)) continue;   // silk, paste, mask
      const th: number[] = [];
      let cur = K.kid(l, "thickness"); th.push(cur ? K.num(cur[1], 0) : 0);
      for (let j = 2; j < l.length; j++) if (l[j] === "addsublayer") { cur = null; for (let k = j + 1; k < l.length && l[k] !== "addsublayer"; k++) { const c = l[k]; if (Array.isArray(c) && c[0] === "thickness") cur = c as SNode; } th.push(cur ? K.num(cur[1], 0) : 0); }
      out.push({ layer: diel ? null : name, th });
    }
    if (out.length) return out;
  }
  const stack = copperStack(copper), n = stack.length;
  const thick = general && K.kid(general, "thickness") ? K.num(K.kid(general, "thickness")![1], 1.6) : 1.6;
  const diel = (thick - 0.035 * n - 0.01 * 2) / Math.max(1, n - 1);
  stack.forEach((l, i) => { out.push({ layer: l, th: [0.035] }); if (i < n - 1) out.push({ layer: null, th: [diel] }); });
  return out;
}
/** BOARD_STACKUP::GetLayerDistance: the copper and dielectric between two copper layers, half of an inner end layer. */
export function layerDistance(items: StackItem[], a: string, b: string): number {
  if (a === b) return 0;
  const ia = items.findIndex((it) => it.layer === a), ib = items.findIndex((it) => it.layer === b);
  if (ia < 0 || ib < 0) return 0;
  const [first, second] = ia < ib ? [a, b] : [b, a];
  const outer = (l: string) => l === "F.Cu" || l === "B.Cu";
  let total = 0, start = false;
  for (const it of items) {
    let half = false;
    if (!start && it.layer === first) { start = true; if (!outer(first)) half = true; }
    else if (!start) continue;
    if (it.layer === second && !outer(second)) half = true;
    for (const t of it.th) total += half ? t / 2 : t;
    if (it.layer === second) break;
  }
  return total;
}

const inside = (p: Pt, c: Conductor): boolean => shapeGap({ t: "circle", x: p[0], y: p[1], r: 0 }, c.shape) <= 1e-9;
/** How far along a→b the line stays inside the shape (the clipped-off part), by bisection on the boundary. */
function insideRun(a: Pt, b: Pt, c: Conductor): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!len) return 0;
  if (inside(b, c)) return len;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (inside([a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m], c)) lo = m; else hi = m; }
  return lo * len;
}
const samePt = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** The Net Inspector figures of every net that has a pad (calculateNets without "Show Zero Pad Nets"), by net name. */
export function netLengths(doc: BoardDoc, header: { general?: SNode | null; setup?: SNode | null } | null, opts: { useHeight?: boolean; includeZeroPadNets?: boolean } = {}, nl?: Netlist | null): NetLengthRow[] {
  nl = nl || netlist(doc);
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const own = doc as unknown as { generalNode?: SNode | null; setupNode?: SNode | null };   // parseDoc keeps the board's (general …) and (setup …)
  const stack = copperStack(copper), items = stackupItems(header?.general ?? own.generalNode ?? null, header?.setup ?? own.setupNode ?? null, copper);
  const useHeight = opts.useHeight !== false;
  const unrouted = new Map<string, number>();
  for (const l of ratsnest(doc, nl)) unrouted.set(l.net, (unrouted.get(l.net) || 0) + l.length);
  const rows: NetLengthRow[] = [];
  for (const net of nl.nets.values()) {
    if (!opts.includeZeroPadNets && !net.pads.length) continue;
    const layerLengths: Record<string, number> = {};
    let track = 0, viaLen = 0, die = 0;
    // chain ends: a track end no other track of the net meets on that layer (mergeLines leaves only those)
    const ends = new Map<string, number>();
    const key = (p: Pt, l: string) => `${l}:${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    for (const t of net.tracks) { const l = [...t.layers][0]; for (const p of t.anchors) ends.set(key(p, l), (ends.get(key(p, l)) || 0) + 1); }
    for (const t of net.tracks) {
      const l = [...t.layers][0], [a, b] = t.anchors;
      let len = (t as Extract<Conductor, { length: number }>).length;
      if (t.kind === "segment") {
        for (const [p, q] of [[a, b], [b, a]] as [Pt, Pt][]) {
          if ((ends.get(key(p, l)) || 0) > 1) continue;
          const via = net.vias.find((v) => v.layers.has(l) && inside(p, v));
          if (via) { len -= insideRun(p, q, via); continue; }
          const pad = net.pads.find((c) => c.kind === "pad" && c.layers.has(l) && samePt([c.pad.x, c.pad.y], p) && inside(p, c));
          if (pad) len -= insideRun(p, q, pad);
        }
      }
      len = Math.max(0, len);
      track += len; layerLengths[l] = (layerLengths[l] || 0) + len;
    }
    for (const v of net.vias) {
      if (!useHeight) continue;   // CalculateLengthDetails counts vias (NumVias) only when heights are used
      const span = new Set<string>();
      for (const t of net.tracks) { const l = [...t.layers][0]; if (v.layers.has(l) && t.anchors.some((p) => inside(p, v))) span.add(l); }
      const pad = net.pads.find((c) => c.kind === "pad" && shapeGap(c.shape, v.shape) <= 1e-9 && [...c.layers].some((l) => v.layers.has(l)));
      if (pad && pad.kind === "pad") {
        const smd = pad.pad.type === "smd" || pad.pad.type === "connect";
        span.add(smd ? stack.find((l) => pad.layers.has(l)) || "F.Cu" : K.str((K.kid(pad.item.node, "layer") || [])[1]) || "F.Cu");
      }
      const used = stack.filter((l) => span.has(l));
      if (used.length >= 2) viaLen += layerDistance(items, used[0], used[used.length - 1]);
    }
    for (const p of net.pads) if (p.kind === "pad") die += K.num((K.kid(p.pad.node, "die_length") || [])[1], 0);
    rows.push({ name: net.name, code: net.code, padCount: net.pads.length, viaCount: useHeight ? net.vias.length : 0, trackLength: track, viaLength: viaLen, dieLength: die,
      unroutedLength: unrouted.get(net.key) || 0, totalLength: track + viaLen + die, layerLengths });
  }
  return rows.sort((a, b) => a.code - b.code || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
