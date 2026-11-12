// pcb-tools/redundant.ts — Remove redundant tracks: removeLoops and removeAntennas.
import type { Antenna, BoardDoc, BranchCache, Pt, Route, TrackElem } from "./types";
import { ptKey } from "./connected";
import { jointIndex, trackEnds } from "./dragger";
import { isLocked } from "./groups";
import { netOf } from "./nets";
import { S } from "./state";
import { layerOf, samePt, widthOf } from "./util";
import { dir8 } from "./walkaround";

export const dirOfElem = (e: TrackElem) => (e.t === "seg" ? dir8(e.a, e.b) : -1);
// ---- "Remove redundant tracks" (ROUTING_SETTINGS::RemoveLoops): PLACEMENT_ALGO::removeLoops and LINE_PLACER::removeAntennas
/** The copper meeting at one point of one layer, on one net: the tracks ending there and whether a pad or via anchors it (a JOINT). */
export function jointAt(doc: BoardDoc, layer: string, p: Pt, netKey: string) {
  const J = jointIndex(doc); const k = ptKey(p);
  const links = (J.ends.get(layer + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === netKey);
  const solid = (J.vias.get(k) || []).some((v) => v.layers.has(layer) && v.net === netKey) ||
    (J.pads.get(k) || []).some((x) => x.layers.has(layer) && samePt([x.pad.x, x.pad.y], p) && J.NT.key(x.pad.net) === netKey);
  return { links, solid, count: links.length + (solid ? 1 : 0) };
}
/** NODE::AssembleLine with arcs: the track and those reached through line corners (two tracks of one width, no pad or via, unlocked). */
export function assembleLoopLine(doc: BoardDoc, it: KItem) {
  const L = layerOf(it.node), w = widthOf(it.node, 0.25), key = jointIndex(doc).NT.key(netOf(it.node));
  const [A, B] = trackEnds(it); if (!A || !B) return null;
  const ids = [it.id], pts = [A.slice(), B.slice()];
  const corner = (j: ReturnType<typeof jointAt>) => !j.solid && j.links.length === 2 && j.links.every((o) => !isLocked(o.node)) && Math.abs(widthOf(j.links[0].node, 0.25) - widthOf(j.links[1].node, 0.25)) < 1e-9;
  const walk = (q: Pt, atEnd: boolean) => {
    let cur = it;
    for (let guard = 0; guard < 10000; guard++) {
      const j = jointAt(doc, L, q, key); if (!corner(j)) return;
      const o = j.links[0] === cur ? j.links[1] : j.links[0]; if (ids.includes(o.id)) return;
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) { ids.push(o.id); pts.push(nq.slice()); } else { ids.unshift(o.id); pts.unshift(nq.slice()); }
      cur = o; q = nq;
    }
  };
  if (!isLocked(it.node)) { walk(B, true); walk(A, false); }
  return { ids, pts, layer: L, netKey: key, width: w };
}
/**
 * PLACEMENT_ALGO::removeLoops over the routed board: for each new track, the line through it and its two end joints;
 * every other line leaving the first joint that passes the second (clipped to the stretch between them) is erased
 * unless one of its tracks is locked.  Returns the ids to delete.
 */
export function loopRemovals(base: BoardDoc, b: BoardDoc) {
  const fresh = [...b.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && !base.items.has(it.id));
  const erase = new Set<string>(), freshIds = new Set(fresh.map((f) => f.id));
  for (const seg of fresh) {
    const our = assembleLoopLine(b, seg); if (!our) continue;
    let a = our.pts[0], z = our.pts[our.pts.length - 1];
    if (samePt(a, z)) continue;
    const ja = jointAt(b, our.layer, a, our.netKey);
    for (const o of ja.links) {
      if (our.ids.includes(o.id)) continue;
      const line = assembleLoopLine(b, o); if (!line || line.ids.includes(seg.id)) continue;
      let i0 = line.pts.findIndex((p) => samePt(p, a)), i1 = line.pts.findIndex((p) => samePt(p, z));
      if (i0 < 0 || i1 < 0) continue;
      if (i1 < i0) [i0, i1] = [i1, i0];
      const links = line.ids.slice(i0, i1);   // ClipVertexRange: the tracks between the two joints
      if (!links.length || links.some((id) => freshIds.has(id) || isLocked(b.items.get(id)!.node))) continue;
      for (const id of links) erase.add(id);
    }
  }
  return erase;
}
/** LINE_PLACER::removeAntennas: the dangling half of a track the route split at its start or end, once the route is anchored. */
export function antennaRemovals(base: BoardDoc, b: BoardDoc, ant: Antenna, netKey: string) {
  const halves = ant.ids.map((id: string) => b.items.get(id)).filter(Boolean); if (!halves.length) return [];
  const J = jointAt(b, ant.layer, ant.p, netKey);
  const isNew = (o: KItem) => !base.items.has(o.id), isTarget = (o: KItem) => ant.ids.includes(o.id);
  const newLinks = J.links.filter(isNew); if (!newLinks.length) return [];
  const reachesAnchor = (start: Pt, includeNew: boolean, skipTarget: boolean) => {
    const pending = [start], seen = new Set<string>();
    while (pending.length) {
      const q = pending.pop()!; const k = ptKey(q); if (samePt(q, ant.p) || seen.has(k)) continue; seen.add(k);
      const j = jointAt(b, ant.layer, q, netKey); if (j.solid) return true;
      for (const o of j.links) {
        if ((!includeNew && isNew(o)) || (skipTarget && isTarget(o))) continue;
        for (const e of trackEnds(o)) if (!samePt(e, q)) pending.push(e);
      }
    }
    return false;
  };
  let anchored = false;
  for (const o of newLinks) for (const e of trackEnds(o)) if (!samePt(e, ant.p) && reachesAnchor(e, true, true)) anchored = true;
  if (!anchored) return [];
  const candidates: string[][] = []; let hasAnchoredSide = false, sides = 0;
  for (const h of J.links.filter(isTarget)) {
    sides++;
    const [a0, a1] = trackEnds(h); const far = samePt(a0, ant.p) ? a1 : a0;
    if (reachesAnchor(far, false, false)) { hasAnchoredSide = true; continue; }
    let link = h, from = ant.p; const branch: string[] = [], seen = new Set<string>();
    while (link && !isLocked(link.node) && !seen.has(link.id)) {
      seen.add(link.id);
      const [e0, e1] = trackEnds(link); if (!samePt(e0, from) && !samePt(e1, from)) break;
      branch.push(link.id); const fe = samePt(e0, from) ? e1 : e0;
      const j = jointAt(b, ant.layer, fe, netKey);
      if (j.count === 1) { candidates.push(branch); break; }
      if (j.count !== 2 || j.solid) break;
      link = j.links[0] === link ? j.links[1] : j.links[0]; from = fe;
    }
  }
  return (sides === 2 && hasAnchoredSide) || sides === 1 ? candidates.flat() : [];
}
/** The routed board with the redundant tracks taken out (Remove redundant tracks on). */
export function removeRedundant(base: BoardDoc, b: BoardDoc, rt: Route) {
  if (!S.rs.remove_loops) return b;
  const out = Object.assign({}, b, { items: new Map(b.items), __bc: {} as BranchCache });
  for (const id of loopRemovals(base, out)) out.items.delete(id);
  out.__bc = {};
  for (const st of rt.stages) for (const ant of st.antennas || []) {
    const key = st.netKey; for (const id of antennaRemovals(base, out, ant, key)) out.items.delete(id); out.__bc = {};
  }
  return out;
}
