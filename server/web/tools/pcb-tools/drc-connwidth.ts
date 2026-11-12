// pcb-tools/drc-connwidth.ts — DRC_TEST_PROVIDER_CONNECTION_WIDTH (connection_width): the copper of each net on each
// layer merged and fractured, then POLYGON_TEST::FindPairs (a VERTEX_SET walk in z-order) looks for necks — two
// concave vertices closer than a minimum width whose two sides both bulge out "substantially" — for every distinct
// connection_width minimum (the board setup's minimum connection width and the custom rules').  A neck is a
// violation when the rule resolved for the items at its middle gives that same minimum.
import type { BoardDoc, Conductor, DesignSettings, DrcMarker } from "./types";
import type { Pt } from "../../fab/prims";
import type { DruRule, RuleItem } from "./dru";
import { fracture } from "../../fab/poly";
import { shapeGap } from "./distances";
import { resolve } from "./drc-rules";
import { marker, mm4 } from "./drc";
import { copperCtx, layerName, netCopper, type CopperCtx } from "./drc-sliver";

/** ADVANCED_CFG m_DRCEpsilon, m_ExtraClearance and the board's maximum error (mm). */
const DRC_EPSILON = 0.0005, EXTRA_CLEARANCE = 0.0005, MAX_ERROR = 0.005;

interface V { i: number; x: number; y: number; prev: V; next: V; z: number; prevZ: V | null; nextZ: V | null; dead?: boolean }

/** POLYGON_TEST( aLimit ): VERTEX_SET( 0 ) with the neck search (nm). */
export class PolygonTest {
  private vertices: V[] = []; private hits: [number, number][] = []; private hitKeys = new Set<string>();
  private bbox = [0, 0, 0, 0];
  constructor(private limit: number) {}
  private zOrder(x: number, y: number): number {
    const [bx, by, bw, bh] = this.bbox;
    const lx = Math.min(Math.max((x - bx) / bw, 0), 1), ly = Math.min(Math.max((y - by) / bh, 0), 1);
    let X = Math.trunc((isFinite(lx) ? lx : 0) * 32767), Y = Math.trunc((isFinite(ly) ? ly : 0) * 32767);
    X = (X | (X << 8)) & 0x00FF00FF; X = (X | (X << 4)) & 0x0F0F0F0F; X = (X | (X << 2)) & 0x33333333; X = (X | (X << 1)) & 0x55555555;
    Y = (Y | (Y << 8)) & 0x00FF00FF; Y = (Y | (Y << 4)) & 0x0F0F0F0F; Y = (Y | (Y << 2)) & 0x33333333; Y = (Y | (Y << 1)) & 0x55555555;
    return (X | (Y << 1)) >>> 0;
  }
  private area(p: V, q: V, r: V): number { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
  private same(a: V | null, b: V | null): boolean { return !!a && !!b && a.x === b.x && a.y === b.y; }
  private insert(i: number, x: number, y: number, last: V | null): V {
    const p = { i, x, y, z: 0, prevZ: null, nextZ: null } as unknown as V; this.vertices.push(p);
    if (!last) { p.prev = p; p.next = p; } else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
    return p;
  }
  private remove(p: V): void {
    p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ;
    p.dead = true; p.prevZ = p.nextZ = null;
  }
  private createList(pts: Pt[]): V | null {
    let tail: V | null = null; let sum = 0; const n = pts.length;
    for (let i = 0; i < n; i++) { const p1 = pts[i], p2 = pts[(i + 1) % n]; sum += (p2[0] - p1[0]) * (p2[1] + p1[1]); }
    let last: Pt | null = null;
    const add = (i: number) => { const pt = pts[i]; if (!last || (pt[0] - last[0]) ** 2 + (pt[1] - last[1]) ** 2 > 0) { tail = this.insert(i, pt[0], pt[1], tail); last = pt; } };
    if (sum > 0) for (let i = n - 1; i >= 0; i--) add(i); else for (let i = 0; i < n; i++) add(i);
    const t = tail as V | null;
    if (t && t.x === t.next.x && t.y === t.next.y) this.remove(t.next);
    return t;
  }
  private updateList(head: V): void {
    let p = head.next;
    while (p !== head) {
      if (p.x === p.next.x && p.y === p.next.y) { p = p.prev; this.remove(p.next); if (p === p.next) break; }
      if (!p.z) p.z = this.zOrder(p.x, p.y);
      p = p.next;
    }
    if (!head.z) head.z = this.zOrder(head.x, head.y);
    const q: V[] = [head]; for (let r = head.next; r && r !== head; r = r.next) q.push(r);
    q.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.i - b.i);
    let prev: V | null = null;
    for (const e of q) { if (prev) { prev.nextZ = e; e.prevZ = prev; } else e.prevZ = null; prev = e; }
    if (prev) prev.nextZ = null;
  }
  private nextOutline(a: V): V {
    const nz = a.nextZ, pz = a.prevZ;
    if (nz && this.same(a, nz) && this.same(a.next, nz.prev) && a.y === a.next.y) return nz.next;
    if (pz && this.same(a, pz) && this.same(a.next, pz.prev) && a.y === a.next.y) return pz.next;
    return a.next;
  }
  private prevOutline(a: V): V {
    const nz = a.nextZ, pz = a.prevZ;
    if (nz && this.same(a, nz) && a.y === a.prev.y) return nz.prev;
    if (pz && this.same(a, pz) && a.y === a.prev.y) return pz.prev;
    return a.prev;
  }
  private locallyInside(a: V, b: V): boolean {
    const an = this.nextOutline(a), ap = this.prevOutline(a);
    if (this.area(ap, a, an) < 0) return this.area(a, b, an) >= 0 && this.area(a, ap, b) >= 0;
    return this.area(a, b, ap) < 0 || this.area(a, an, b) < 0;
  }
  private isSubstantial(A: V, B: V): boolean {
    let xc = false, yc = false, checked = 0; const total = this.vertices.length;
    const p0 = A; let p = this.nextOutline(p0);
    while (!this.same(p, B) && !this.same(p, A) && checked < total && !(xc && yc)) {
      if (Math.abs(p.x - p0.x) > this.limit) xc = true; if (Math.abs(p.y - p0.y) > this.limit) yc = true;
      p = this.nextOutline(p); ++checked;
    }
    if (checked >= total) return false;
    if (!this.same(p, A) && (!xc || !yc)) return false;
    p = this.prevOutline(p0); xc = false; yc = false; checked = 0;
    while (!this.same(p, B) && !this.same(p, A) && checked < total && !(xc && yc)) {
      if (Math.abs(p.x - p0.x) > this.limit) xc = true; if (Math.abs(p.y - p0.y) > this.limit) yc = true;
      p = this.prevOutline(p); ++checked;
    }
    if (checked >= total) return false;
    return this.same(p, A) || (xc && yc);
  }
  private getKink(a: V): V | null {
    if (this.locallyInside(a.prev, a.next)) return null;   // the point must be on a concave stretch
    const maxZ = this.zOrder(a.x + this.limit, a.y + this.limit), minZ = this.zOrder(a.x - this.limit, a.y - this.limit);
    const limit2 = this.limit * this.limit; let best = Infinity, ret: V | null = null;
    const test = (p: V) => {
      const di = Math.abs(p.i - a.i); const d2 = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
      if (di > 1 && d2 < limit2 && d2 < best && d2 > 0 && this.locallyInside(p, a) && this.isSubstantial(p, a) && this.isSubstantial(a, p)) { best = d2; ret = p; }
    };
    for (let p = a.nextZ; p && p.z <= maxZ; p = p.nextZ) test(p);
    for (let p = a.prevZ; p && p.z >= minZ; p = p.prevZ) test(p);
    return ret;
  }
  /** FindPairs: the vertex index pairs of the necks of one outline. */
  findPairs(pts: Pt[]): [number, number][] {
    this.hits = []; this.hitKeys.clear(); this.vertices = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    this.bbox = [x0, y0, x1 - x0, y1 - y0];
    this.createList(pts); if (!this.vertices.length) return [];
    const front = this.vertices[0]; this.updateList(front);
    const all = new Set<V>();
    for (let p = front.next; p !== front; p = p.next) {
      let m: V | null = null;
      if ((all.size === 0 || !all.has(p)) && (m = this.getKink(p)) !== null) {
        const key = p.i + "," + m.i;
        if (!all.has(m) && !this.hitKeys.has(key)) { this.hitKeys.add(key); this.hits.push([p.i, m.i]); for (const v of [p, m, p.next, p.prev, m.next, m.prev]) all.add(v); }
      }
    }
    return this.hits.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // a std::set<std::pair<int,int>>
  }
}

/** Every distinct connection_width minimum (QueryDistinctConstraints): the board setup's and the custom rules'. */
export function connectionWidths(s: DesignSettings, rules: DruRule[]): number[] {
  const set = new Set<number>([Number(s.minConn) || 0]);
  for (const r of rules) for (const c of r.constraints) if (c.type === "connection_width" && c.min != null) set.add(c.min);
  return [...set].sort((a, b) => a - b);
}

/** connection_width markers. */
export function connectionWidthMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], conductors: Conductor[], cc?: CopperCtx): DrcMarker[] {
  const out: DrcMarker[] = [];
  const eps = 2 * (DRC_EPSILON + MAX_ERROR + EXTRA_CLEARANCE);
  const widths = connectionWidths(s, rules).filter((w) => w - eps > 0); if (!widths.length) return out;
  const ctx = cc || copperCtx(doc);
  const ruleItem = (c: Conductor, layer: string): RuleItem => (c.kind === "pad" ? { kind: c.kind, node: c.pad.node, parent: c.item, layer, shape: c.shape } : { kind: c.kind, node: c.item.node, item: c.item, layer, shape: c.shape });
  for (const layer of doc.copper) {
    const onLayer = conductors.filter((c) => c.layers.has(layer));
    const ordered = [...onLayer.filter((c) => c.kind !== "zone"), ...onLayer.filter((c) => c.kind === "zone")];
    for (const merged of netCopper(layer, conductors, ctx, true).values()) {
      const polys = fracture(merged).map((p) => p.map((q) => [Math.round(q[0] * 1e6), Math.round(q[1] * 1e6)] as Pt));
      for (const minW of widths) {
        const test = new PolygonTest(Math.round((minW - eps) * 1e6));
        for (const chain of polys) for (const [ia, ib] of test.findPairs(chain)) {
          const A = chain[ia], B = chain[ib]; const loc: Pt = [Math.trunc((A[0] + B[0]) / 2) / 1e6, Math.trunc((A[1] + B[1]) / 2) / 1e6];
          const dist = Math.round(Math.hypot(A[0] - B[0], A[1] - B[1])) / 1e6;
          const at = { t: "circle" as const, x: loc[0], y: loc[1], r: 0 };
          const hit = ordered.filter((c) => shapeGap(c.shape, at) <= minW);
          if (!hit.length) continue;
          const r = resolve(rules, "connection_width", doc, s, ruleItem(hit[0], layer), hit[1] ? ruleItem(hit[1], layer) : null, Number(s.minConn) || 0);
          if (!r || r.min == null || Math.abs(r.min - minW) > 1e-9) continue;
          const m = marker("connection_width", r.severity === "warning" || r.severity === "error" ? r.severity : "warning", loc[0], loc[1],
            `Copper connection too narrow (${r.name} minimum connection width ${mm4(r.min)}; actual ${mm4(dist)}) (${layerName(doc, layer)})`, Array.from(new Set(hit.map((c) => c.id))));
          m.layer = layer; m.rule = r.name; out.push(m);
        }
      }
    }
  }
  return out;
}
