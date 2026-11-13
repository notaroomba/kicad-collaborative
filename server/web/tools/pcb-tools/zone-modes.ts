// pcb-tools/zone-modes.ts — DRAWING_TOOL::DrawZone's ZONE_MODE::CUTOUT (Add a Zone Cutout, Shift+C) and
// ZONE_MODE::SIMILAR (Add a Similar Zone, Ctrl+Shift+.): both start from one selected zone (getSourceZoneForAction)
// and draw a polygon with the zone tool's line modes; ZONE_CREATE_HELPER then
//   SIMILAR: createZoneFromExisting — a new zone with every setting of the source (ZONE_SETTINGS::ExportSetting with
//            the full export: priority, layers, name made unique, net), the drawn outline, "Draw Zone";
//   CUTOUT:  performZoneCutout — the source's outline less the drawn polygon (Clipper, arcs flattened); one zone per
//            remaining main outline with its holes, unfilled, the source removed, "Add Zone Cutout"; the first new zone
//            is selected and becomes the source for the next cutout.
import type { BoardDoc, PcbChange, PcbCtx, Pt } from "./types";
import { FillRule, differenceD, type PathD } from "clipper2-ts";
import { addedChange, removedChange } from "./changes";
import { netOf } from "./nets";
import { K } from "./state";
import { clone, isList, r6 } from "./util";

/** The zone a cutout / similar zone starts from: exactly one selected zone, else the zone under the cursor (selectionCursor). */
export function sourceZone(ctx: PcbCtx, selected: string[], under: string[]): KItem | null {
  const doc = ctx.doc;
  if (selected.length) { if (selected.length !== 1) return null; const it = doc.items.get(selected[0]); return it && it.kind === "zone" ? it : null; }
  const zones = under.map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && it.kind === "zone");
  return zones.length === 1 ? zones[0] : null;
}

/** A zone's layers: (layer X) or (layers …). */
export function zoneLayerList(node: SNode): string[] {
  const l = K.kid(node, "layers"); if (l) return l.slice(1).map((v) => K.str(v));
  const one = K.kid(node, "layer"); return one ? [K.str(one[1])] : [];
}

/** The points of one (pts …) list, arcs flattened to chords within maxErr (SHAPE_POLY_SET::ClearArcs keeps their points). */
export function chainPoints(pts: SNode | null, maxErr = 0.005): Pt[] {
  const out: Pt[] = []; if (!pts) return out;
  for (let i = 1; i < pts.length; i++) {
    const c = pts[i]; if (!isList(c)) continue;
    if (c[0] === "xy") out.push([K.num(c[1]), K.num(c[2])]);
    else if (c[0] === "arc") {
      const g = (k: string) => { const n = K.kid(c, k); return n ? [K.num(n[1]), K.num(n[2])] as Pt : null; };
      const s = g("start"), m = g("mid"), e = g("end"); if (!s || !m || !e) continue;
      const a = K.arcFrom3(s, m, e);
      if (!a) { out.push(s, e); continue; }
      let sweep = a.anticlockwise ? a.a0 - a.a1 : a.a1 - a.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const step = a.r > maxErr ? 2 * Math.acos(1 - maxErr / a.r) : Math.PI / 8;
      const n = Math.max(2, Math.ceil(sweep / step));
      out.push(s);
      for (let k = 1; k < n; k++) { const t = a.a0 + (a.anticlockwise ? -1 : 1) * sweep * k / n; out.push([r6(a.x + a.r * Math.cos(t)), r6(a.y + a.r * Math.sin(t))]); }
      out.push(e);
    }
  }
  const dedup: Pt[] = []; for (const p of out) { const q = dedup[dedup.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) dedup.push(p); }
  while (dedup.length > 1 && dedup[0][0] === dedup[dedup.length - 1][0] && dedup[0][1] === dedup[dedup.length - 1][1]) dedup.pop();
  return dedup;
}

/** The zone's outline chains: the main outline first, then its holes (each (polygon) child, as the file stores them). */
export function zoneChains(node: SNode): Pt[][] { return K.kids(node, "polygon").map((p) => chainPoints(K.kid(p, "pts"))).filter((c) => c.length >= 3); }

const area = (p: Pt[]) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return a / 2; };
function inside(p: Pt, poly: Pt[]) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; }

/** SHAPE_POLY_SET::BooleanSubtract of a zone outline (outline + holes) and a cutout: [{ outline, holes }] per main outline. */
export function subtractOutline(chains: Pt[][], cut: Pt[]): { outline: Pt[]; holes: Pt[][] }[] {
  const toPath = (p: Pt[]): PathD => p.map((q) => ({ x: q[0], y: q[1] }));
  const res = differenceD(chains.map(toPath), [toPath(cut)], FillRule.EvenOdd, 6).map((p) => p.map((q) => [r6(q.x), r6(q.y)] as Pt)).filter((p) => p.length >= 3);
  if (!res.length) return [];
  // Clipper writes outer contours and holes with opposite orientation: the larger magnitude sign family is the outers
  const outers = res.filter((p) => area(p) > 0), holes = res.filter((p) => area(p) < 0);
  const [O, H] = outers.length >= 1 && (holes.length === 0 || Math.max(...outers.map((p) => Math.abs(area(p)))) >= Math.max(...holes.map((p) => Math.abs(area(p))))) ? [outers, holes] : [holes, outers];
  const out = O.map((outline) => ({ outline, holes: [] as Pt[][] }));
  for (const h of H) {
    let best: { outline: Pt[]; holes: Pt[][] } | null = null;
    for (const o of out) if (inside(h[0], o.outline) && (!best || Math.abs(area(o.outline)) < Math.abs(area(best.outline)))) best = o;
    (best || out[0]).holes.push(h);
  }
  return out;
}

const xy = (p: Pt) => ["xy", r6(p[0]), r6(p[1])];
/** The zone node with its outline replaced by these chains (main outline first) and its fill dropped (ZONE::UnFill). */
export function withOutline(node: SNode, outline: Pt[], holes: Pt[][] = []): SNode {
  const n = clone(node);
  const at = n.findIndex((c) => isList(c) && c[0] === "polygon");
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (isList(c) && (c[0] === "polygon" || c[0] === "filled_polygon" || c[0] === "fill_segments")) n.splice(i, 1); }
  const polys = [outline, ...holes].map((ch) => ["polygon", ["pts", ...ch.map(xy)]]);
  n.splice(at > 0 ? Math.min(at, n.length) : n.length, 0, ...polys);
  const fill = K.kid(n, "fill"); if (fill && fill[1] === "yes") fill.splice(1, 1);
  return n;
}

/** Fresh (uuid …) for the zone itself. */
function freshUuid(n: SNode) { const u = K.kid(n, "uuid") || K.kid(n, "tstamp"); if (u) u[1] = K.newUuid(); else n.push(["uuid", K.newUuid()]); }

/** BOARD::MakeUniqueZoneName: an empty name or one not in use stays; else root_1, root_2 … (a trailing _<digits> is the root's counter). */
export function uniqueZoneName(doc: BoardDoc, base: string): string {
  const used = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "zone") { const nm = K.kid(it.node, "name"); if (nm) used.add(K.str(nm[1])); }
  if (!base || !used.has(base)) return base;
  let root = base; const us = base.lastIndexOf("_"); if (us >= 0 && /^\d+$/.test(base.slice(us + 1))) root = base.slice(0, us);
  for (let i = 1; ; i++) { const c = `${root}_${i}`; if (!used.has(c)) return c; }
}

/**
 * createZoneFromExisting: the source zone's settings on a new zone with the drawn outline.  The teardrop area type is
 * a ZONE parameter, not a ZONE_SETTINGS one, so a teardrop's (attr (teardrop …)) is not carried over.
 */
export function similarZoneNode(doc: BoardDoc, src: SNode, outline: Pt[]): SNode {
  const n = withOutline(src, outline);
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (isList(c) && c[0] === "attr") n.splice(i, 1); }
  freshUuid(n);
  const nm = K.kid(n, "name"); if (nm) { const u = uniqueZoneName(doc, K.str(nm[1])); if (u) nm[1] = u; else n.splice(n.indexOf(nm), 1); }
  return n;
}

/** performZoneCutout: the changes (new zones added, the source removed) and the first new zone's id. */
export function zoneCutoutChanges(doc: BoardDoc, zone: KItem, cut: Pt[]): { changes: PcbChange[]; first: string | null } {
  const parts = subtractOutline(zoneChains(zone.node), cut);
  const changes: PcbChange[] = []; let first: string | null = null;
  for (const p of parts) {
    const n = withOutline(zone.node, p.outline, p.holes); freshUuid(n);
    const c = addedChange(doc, n, netOf(n));
    changes.push(c); if (!first) first = c.id;
  }
  changes.push(removedChange(zone));
  return { changes, first };
}
