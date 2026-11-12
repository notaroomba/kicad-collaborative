// pcb-tools/track-edit.ts — track editing: widths, layers, cleanup, break, unroute.
import type { BoardDoc, Conductor, PcbChange, Pt } from "./types";

/** Edit Track & Via Properties' changes: a width, via sizes, layers and type, or the net classes' values. */
export interface TrackEdit { width?: number; netclass?: boolean; viaSize?: number; viaDrill?: number; viaLayers?: string[]; viaType?: string }
/** One line of the cleanup report: its code, text and the items. */
export interface CleanupItem { code: string; text: string; ids: string[] }
/** TRACKS_CLEANER's options. */
export interface CleanupOpts { shorts?: boolean; vias?: boolean; merge?: boolean; dangling?: boolean; danglingVias?: boolean; inPads?: boolean }
/** What cleanupPlan found: the items to remove, those to replace, and the report. */
export interface CleanupPlan { remove: Set<string>; replace: { item: KItem; node: SNode }[]; items: CleanupItem[] }
type TrackConductor = Extract<Conductor, { length: number }>;
import { addedChange, removedChange, replacedChange } from "./changes";
import { boxesTouch, coreDist, shapeBBox, shapeGap, shapeOffset, shareLayer } from "./distances";
import { designSettings, netclassOf } from "./drc";
import { hitTestItem } from "./hit";
import { conductors, netTable } from "./netlist";
import { netOf } from "./nets";
import { K } from "./state";
import { EPS, transformChanges } from "./transforms";
import { clone, pt, r6, widthOf } from "./util";

// ---------------------------------------------------------------- track editing: widths, layers, cleanup, break, unroute
export function trackEditChanges(doc: BoardDoc, ids: Iterable<string>, edit: TrackEdit, settings?: ReturnType<typeof designSettings> | null) {
  const s = settings || designSettings(null); const NT = netTable(doc);
  return transformChanges(doc, ids, (n, it: KItem) => {
    if (it.kind === "segment" || it.kind === "arc") {
      let w = edit.width; if (edit.netclass) w = netclassOf(s, NT.key(netOf(n))).track_width; if (!(w! > 0)) return false;
      const wn = K.kid(n, "width"); if (wn) wn[1] = r6(w!); else n.splice(n.indexOf(K.kid(n, "layer")!), 0, ["width", r6(w!)]);
    } else if (it.kind === "via") {
      let size = edit.viaSize, drill = edit.viaDrill; if (edit.netclass) { const nc = netclassOf(s, NT.key(netOf(n))); size = nc.via_diameter; drill = nc.via_drill; }
      let did = false;
      if (size! > 0) { const sn = K.kid(n, "size"); if (sn) sn[1] = r6(size!); did = true; } if (drill! > 0) { const dn = K.kid(n, "drill"); if (dn) dn[1] = r6(drill!); did = true; }
      if (edit.viaLayers && edit.viaLayers.length === 2) { const ls = K.kid(n, "layers"); if (ls) ls.splice(1, ls.length - 1, ...edit.viaLayers); did = true; }
      if (edit.viaType) { for (const t of ["blind", "micro", "buried"]) { const i = n.indexOf(t); if (i > 0) n.splice(i, 1); } if (edit.viaType !== "through") n.splice(1, 0, edit.viaType); did = true; }
      if (!did) return false;
    } else return false;
  });
}
/** Move tracks / arcs / vias' layer pair to the copper layer n steps up or down the stack (Ctrl++ / Ctrl+-). */
export function trackLayerChanges(doc: BoardDoc, ids: Iterable<string>, step: number, toLayer?: string) {
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  return transformChanges(doc, ids, (n, it: KItem) => {
    if (it.kind !== "segment" && it.kind !== "arc") return false;
    const l = K.kid(n, "layer"); const i = copper.indexOf(K.str(l![1])); const target = toLayer || copper[Math.max(0, Math.min(copper.length - 1, i + step))];
    if (!target || target === K.str(l![1])) return false; l![1] = target;
  });
}
/** BREAK_TRACK at a point: the segment nearest the cursor splits there into two (the second with a fresh uuid). */
export function breakTrackChanges(doc: BoardDoc, p: Pt, seg?: KItem | null) {
  seg = seg || (() => { const it = hitTestItem(doc, p[0], p[1], 0.3); return it && it.kind === "segment" ? it : null; })(); if (!seg) return [];
  const a = pt(seg!.node, "start"), b = pt(seg!.node, "end"); const L2 = (b![0] - a![0]) ** 2 + (b![1] - a![1]) ** 2; if (L2 < 1e-12) return [];
  const t = Math.max(0, Math.min(1, ((p[0] - a![0]) * (b![0] - a![0]) + (p[1] - a![1]) * (b![1] - a![1])) / L2)); if (t < 1e-4 || t > 1 - 1e-4) return [];
  const m = [r6(a![0] + t * (b![0] - a![0])), r6(a![1] + t * (b![1] - a![1]))];
  const first = clone(seg!.node); K.kid(first, "end")!.splice(1, 2, m[0], m[1]);
  const second = clone(seg!.node); K.kid(second, "start")!.splice(1, 2, m[0], m[1]); const u = K.kid(second, "uuid"); if (u) second.splice(second.indexOf(u), 1);
  return [replacedChange(seg!, first), addedChange(doc, second)];
}
/**
 * TRACKS_CLEANER: a dry plan of what "Cleanup Tracks & Vias" would do with KiCad's options — shorting tracks,
 * redundant vias, collinear merges (and contained / duplicate segments), zero-length segments, dangling ends
 * (iterated) and tracks fully inside pads.  { remove: Set, replace: [{item, node}], items: [{code, text, ids}] }.
 */
export function cleanupPlan(doc: BoardDoc, opts?: CleanupOpts | null): CleanupPlan {
  opts = Object.assign({ shorts: true, vias: true, merge: true, dangling: true, danglingVias: true, inPads: true }, opts || {});
  const remove = new Set<string>(), replace = new Map<string, SNode>(), items: CleanupItem[] = []; const report = (code: string, text: string, ids: string[]) => items.push({ code, text, ids });
  const alive = (c: Conductor) => !remove.has(c.id);
  let conds = conductors(doc); const tracks = () => conds.filter((c) => (c.kind === "segment" || c.kind === "arc") && alive(c));
  const nodeOf = (c: Conductor) => replace.get(c.id) || c.item.node; const layerOfC = (c: Conductor) => c.layers.values().next().value!;
  const near = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
  const touchesPt = (p: Pt, layer: string, self: Conductor) => conds.filter(alive).some((c) => c !== self && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS);
  // zero length
  for (const c of tracks()) if (c.kind === "segment" && c.length < EPS) { remove.add(c.id); report("null_segment", "Remove zero-length track", [c.id]); }
  // shorting: a track touching pads of two nets
  if (opts.shorts) for (const c of tracks()) {
    const nets = new Set<string>(); for (const o of conds) if (o.kind === "pad" && o.net && alive(o) && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS) nets.add(o.net);
    if (nets.size > 1) { remove.add(c.id); report("shorting_track", `Remove track shorting ${Array.from(nets).join(" and ")}`, [c.id]); }
  }
  // redundant vias: same spot, same layers (the later one goes); vias with nothing to connect
  if (opts.vias) {
    const vias = conds.filter((c) => c.kind === "via");
    for (let i = 0; i < vias.length; i++) for (let j = i + 1; j < vias.length; j++) if (alive(vias[j]) && near(vias[i].anchors[0], vias[j].anchors[0]) && Array.from(vias[i].layers).join() === Array.from(vias[j].layers).join()) { remove.add(vias[j].id); report("redundant_via", "Remove redundant via", [vias[j].id]); }
  }
  // tracks fully inside a pad
  if (opts.inPads) for (const c of tracks()) if (c.kind === "segment") {
    const [a, b] = c.anchors; const layer = layerOfC(c);
    const inside = (p: Pt) => conds.find((o) => o.kind === "pad" && o.layers.has(layer) && boxesTouch(o.bbox, [p[0], p[1], p[0], p[1]], 0) && coreDist(o.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= shapeOffset(o.shape) + 1e-9);
    const pa = inside(a), pb = inside(b); if (pa && pb && pa === pb) { remove.add(c.id); report("track_in_pad", "Remove track inside pad", [c.id]); }
  }
  // duplicates, contained and collinear segments
  if (opts.merge) {
    let changed = true;
    while (changed) {
      changed = false; const segs = tracks().filter((c) => c.kind === "segment");
      outer: for (let i = 0; i < segs.length; i++) for (let j = 0; j < segs.length; j++) {
        if (i === j) continue; const p = segs[i], q = segs[j]; if (layerOfC(p) !== layerOfC(q) || (p.net && q.net && p.net !== q.net)) continue;
        const pn = nodeOf(p), qn = nodeOf(q); const a = pt(pn, "start")!, b = pt(pn, "end")!, c = pt(qn, "start")!, d = pt(qn, "end")!;
        const dir = [b![0] - a![0], b![1] - a![1]]; const L = Math.hypot(dir[0], dir[1]); if (L < EPS) continue;
        const cross = (r: Pt) => Math.abs((r[0] - a![0]) * dir[1] - (r[1] - a![1]) * dir[0]) / L; const along = (r: Pt) => ((r[0] - a![0]) * dir[0] + (r[1] - a![1]) * dir[1]) / L;
        if (cross(c) > EPS || cross(d) > EPS) continue;   // not collinear
        const tc = along(c), td = along(d), lo = Math.min(tc, td), hi = Math.max(tc, td);
        if (lo >= -EPS && hi <= L + EPS && widthOf(qn, 0.25) <= widthOf(pn, 0.25) + 1e-9) {   // q lies within p (a duplicate when equal)
          remove.add(q.id); report(Math.abs(lo) < EPS && Math.abs(hi - L) < EPS ? "duplicate_track" : "contained_track", Math.abs(lo) < EPS && Math.abs(hi - L) < EPS ? "Remove duplicate track" : "Remove track contained in another", [q.id]); changed = true; break outer;
        }
        if (Math.abs(widthOf(pn, 0.25) - widthOf(qn, 0.25)) > 1e-9) continue;
        // share exactly one end that is not a node (nothing else lands there): merge into one segment
        const joint = near(b, c) ? [b, a, d] : near(b, d) ? [b, a, c] : near(a, c) ? [a, b, d] : near(a, d) ? [a, b, c] : null; if (!joint) continue;
        if (Math.abs(along(joint[2]) - along(joint[1])) <= Math.abs(along(joint[0]) - along(joint[1])) + EPS && lo > -EPS && hi < L + EPS) continue;   // folds back on itself
        if (touchesPt(joint[0], layerOfC(p), p) && conds.filter(alive).some((o) => o !== p && o !== q && o.layers.has(layerOfC(p)) && (o.kind !== "segment" ? shapeGap(o.shape, { t: "circle", x: joint[0]![0], y: joint[0]![1], r: 0 }) <= EPS : o.anchors.some((r: Pt) => near(r, joint[0]))))) continue;
        const merged = clone(pn); K.kid(merged, "start")!.splice(1, 2, r6(joint[1]![0]), r6(joint[1]![1])); K.kid(merged, "end")!.splice(1, 2, r6(joint[2]![0]), r6(joint[2]![1]));
        replace.set(p.id, merged); remove.add(q.id); report("merge_collinear", "Merge collinear tracks", [p.id, q.id]);
        p.shape = { t: "seg", a: joint[1], b: joint[2], r: (p.shape as { r: number }).r }; p.anchors = [joint[1], joint[2]]; p.bbox = shapeBBox(p.shape); (p as TrackConductor).length = Math.hypot(joint[2]![0] - joint[1]![0], joint[2]![1] - joint[1]![1]);
        changed = true; break outer;
      }
    }
  }
  // dangling ends, until nothing else comes loose
  if (opts.dangling || opts.danglingVias) {
    let again = true;
    while (again) {
      again = false;
      if (opts.dangling) for (const c of tracks()) { const layer = layerOfC(c); if (c.anchors.some((p: Pt) => !touchesPt(p, layer, c))) { remove.add(c.id); report("dangling_track", "Remove dangling track", [c.id]); again = true; } }
      if (opts.danglingVias) for (const c of conds) if (c.kind === "via" && alive(c) && !conds.filter(alive).some((o) => o !== c && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS)) { remove.add(c.id); report("dangling_via", "Remove dangling via", [c.id]); again = true; }
    }
  }
  const replaceOut: { item: KItem; node: SNode }[] = []; for (const [id, node] of replace) if (!remove.has(id)) replaceOut.push({ item: doc.items.get(id)!, node });
  return { remove, replace: replaceOut, items };
}
export function cleanupChanges(doc: BoardDoc, plan: CleanupPlan) { const out: PcbChange[] = []; for (const { item, node } of plan.replace) out.push(replacedChange(item, node)); for (const id of plan.remove) { const it = doc.items.get(id); if (it) out.push(removedChange(it)); } return out; }
