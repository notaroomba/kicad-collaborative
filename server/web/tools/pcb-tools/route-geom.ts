// pcb-tools/route-geom.ts — routing geometry: the posture leg, pads, the snap target and the net under a point.
import type { BoardDoc, NetRef, PadInfo, Pt, SnapHit } from "./types";
import { rp } from "./dragger";
import { hitTestItem } from "./hit";
import { hasNet, netOf, sameNet } from "./nets";
import { HIT_MM, K } from "./state";
import { layerOf, pt, rotator, widthOf } from "./util";

// ---------------------------------------------------------------- routing geometry
/** One KiCad-style leg from a to b: a 45° diagonal plus an orthogonal run, in either order. */
export function routeLeg(a: Pt, b: Pt, diagFirst: boolean) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.min(Math.abs(dx), Math.abs(dy));
  const diag = [Math.sign(dx) * d, Math.sign(dy) * d], orth = [dx - diag[0], dy - diag[1]];
  const first = diagFirst ? diag : orth, second = diagFirst ? orth : diag;
  const c = [a[0] + first[0], a[1] + first[1]]; const out: Pt[][] = [];
  if (Math.hypot(first[0], first[1]) > 1e-6) out.push([a.slice(), c]);
  if (Math.hypot(second[0], second[1]) > 1e-6) out.push([c.slice(), b.slice()]);
  return out;
}

/** Absolute pad centres of a footprint item, with nets and copper layers. */
export function padsOf(fp: Pick<KItem, "node">) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const out: PadInfo[] = [];
  K.kids(n, "pad").forEach((pad, index) => {
    const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const sz = K.kid(pad, "size"); const ls = K.kid(pad, "layers");
    // the shape's offset from the anchor ((drill … (offset x y)), PAD::GetOffset), in the pad's own frame
    const dr = K.kid(pad, "drill"), of = dr && K.kid(dr, "offset"); const off = of ? [K.num(of[1], 0), K.num(of[2], 0)] : [0, 0];
    out.push({ x: fx + rx, y: fy + ry, rot: prot, w: sz ? K.num(sz[1]) : 1, h: sz ? K.num(sz[2], K.num(sz[1])) : 1, off,
      net: netOf(pad), layers: ls ? ls.slice(1).map(K.str) : [], number: K.str(pad[1]), type: K.str(pad[2]), shape: K.str(pad[3]), node: pad, index });
  });
  return out;
}
export const padOnLayer = (p: PadInfo, layer: string) => p.layers.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
export function padCovers(p: PadInfo, x: number, y: number) { const [lx, ly] = rotator(-p.rot)(x - p.x, y - p.y); return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2; }

/** Magnetic target near (x, y): a pad (centre within tol, or the cursor over it), via or track end on the layer (strict: of `net` only). */
export function snapTarget(doc: BoardDoc, x: number, y: number, tol: number, layer: string, net: NetRef | null, strict?: boolean) {
  let best: SnapHit | null = null, bd = Infinity;
  const take = (px: number, py: number, n: NetRef, kind: string, inside: boolean, extra: { fp?: string; padIndex?: number; id?: string }) => {
    const d = Math.hypot(px - x, py - y); if (!inside && d > tol) return;
    if (hasNet(net) && hasNet(n) && !sameNet(n, net)) return;   // never pull a routed net onto another net
    if (strict && !sameNet(n, net) && !(kind === "pad" && inside)) return;   // pickSingleItem: the routed net only; a free pad when the cursor is inside it
    if (d < bd) { bd = d; best = Object.assign({ x: px, y: py, net: n, kind }, extra); }
  };
  const mids: { it: KItem; a: Pt; b: Pt }[] = [];
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) continue;
    if (it.kind === "footprint") { padsOf(it).forEach((p, i) => { if (padOnLayer(p, layer)) take(p.x, p.y, p.net, "pad", padCovers(p, x, y), { fp: it.id, padIndex: p.index !== undefined ? p.index : i }); }); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) take(a[0], a[1], netOf(it.node), "via", false, { id: it.id }); }
    else if ((it.kind === "segment" || it.kind === "arc") && layerOf(it.node) === layer) {
      const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
      take(a[0], a[1], netOf(it.node), "track", false, { id: it.id }); take(b[0], b[1], netOf(it.node), "track", false, { id: it.id });
      if (strict && it.kind === "segment" && Math.hypot(a[0] - x, a[1] - y) > tol && Math.hypot(b[0] - x, b[1] - y) > tol) mids.push({ it, a, b });
    }
  }
  // while routing, the body of a routed-net track under the cursor is an end too (TOOL_BASE::snapToItem: the nearest
  // point on it); the route ends there and the track is split (LINE_PLACER::splitAdjacentSegments)
  if (!best) for (const { it, a, b } of mids) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!(l2 > 0)) continue;
    const k = ((x - a[0]) * dx + (y - a[1]) * dy) / l2; if (k <= 0 || k >= 1) continue;
    const q = rp([a[0] + k * dx, a[1] + k * dy]); const inside = Math.hypot(q[0] - x, q[1] - y) <= widthOf(it.node, 0.25) / 2;
    take(q[0], q[1], netOf(it.node), "trackMid", inside, { id: it.id });
  }
  return best;
}
/** Net of whatever copper sits under (x, y): a pad, or a track/via on the layer. */
export function netUnder(doc: BoardDoc, x: number, y: number, layer?: string | null): NetRef {
  for (const it of doc.items.values()) if (it.kind === "footprint" && it.bbox && x >= it.bbox[0] && x <= it.bbox[2] && y >= it.bbox[1] && y <= it.bbox[3]) {
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y)) return p.net;
  }
  const it = hitTestItem(doc, x, y, HIT_MM);
  if (it && (it.kind === "via" || ((it.kind === "segment" || it.kind === "arc") && (!layer || layerOf(it.node) === layer)))) return netOf(it.node);
  return { code: 0, name: "" };
}
