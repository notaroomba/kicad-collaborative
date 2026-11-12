// pcb-tools/connected.ts — connectivity: conductor ends, point keys and the connected run (U).
import type { BoardDoc, Pt } from "./types";
import { layerOf, pt } from "./util";

// ---------------------------------------------------------------- connectivity (U)
export function conductorEnds(it: KItem) {
  if (it.kind === "segment" || it.kind === "arc") return [pt(it.node, "start"), pt(it.node, "end")].filter(Boolean) as Pt[];
  if (it.kind === "via") { const a = pt(it.node, "at"); return a ? [a] : []; }
  return [];
}
export const ptKey = (p: Pt) => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
/** Ids of every track / arc / via reachable from the seeds through shared endpoints (vias bridge layers). */
export function connectedRun(doc: BoardDoc, seedIds: Iterable<string>) {
  const index = new Map<string, KItem[]>(), ends = new Map<string, Pt[]>();
  for (const it of doc.items.values()) {
    const e = conductorEnds(it); if (!e.length) continue; ends.set(it.id, e);
    for (const p of e) { const k = ptKey(p); let arr = index.get(k); if (!arr) { arr = []; index.set(k, arr); } arr.push(it); }
  }
  const out = new Set<string>(), q: string[] = [];
  for (const id of seedIds) if (ends.has(id)) { out.add(id); q.push(id); }
  while (q.length) {
    const id = q.pop()!; const it = doc.items.get(id)!;
    for (const p of ends.get(id)!) for (const o of index.get(ptKey(p)) || []) {
      if (out.has(o.id)) continue;
      const bridged = it.kind === "via" || o.kind === "via" || layerOf(it.node) === layerOf(o.node);
      if (bridged) { out.add(o.id); q.push(o.id); }
    }
  }
  return out;
}
