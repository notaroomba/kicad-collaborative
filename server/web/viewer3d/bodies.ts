// viewer3d/bodies.ts — placeholder component bodies.  The web has no 3D models (.step / .wrl), so each
// footprint gets a simple solid drawn from its courtyard (or, failing that, its fabrication outline),
// extruded to a plausible height for the kind of part.  Pure geometry: no DOM, no three.js.
import type { RGBA } from "./colors";
import type { Pt } from "./outline";
import { type Solid, localPads, partSolids } from "./parts";

/** KiCad's footprint attribute classes, the 3D viewer's three model toggles. */
export type BodyClass = "tht" | "smd" | "virtual";

export interface Body {
  cls: BodyClass;
  /** which face of the board it sits on */
  back: boolean;
  /** outline in board millimetres (Y down), closed implicitly */
  pts: Pt[];
  height: number;
  color: RGBA;
  ref: string;
  /** the part drawn as solids (board millimetres, heights from the face it sits on) when its library name is one
   *  parts.ts models; otherwise the body is the plain prism over `pts` */
  solids?: Solid[];
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** (attr smd | through_hole [board_only] [exclude_from_pos_files] [exclude_from_bom] [dnp]) of a footprint node. */
export function footprintAttrs(node: SNode): Set<string> {
  const out = new Set<string>();
  for (const c of node) if (Array.isArray(c) && c[0] === "attr") for (const a of c.slice(1)) if (typeof a === "string") out.add(a);
  return out;
}

function refPrefix(ref: string): string { const m = /^[A-Za-z]+/.exec(ref || ""); return m ? m[0].toUpperCase() : ""; }

/** Height (mm) and colour for a part, from its class, reference prefix and footprint size. */
export function bodyStyle(cls: BodyClass, ref: string, w: number, l: number, round: boolean): { height: number; color: RGBA } {
  const p = refPrefix(ref); const m = Math.min(w, l);
  const dark: RGBA = [0.16, 0.16, 0.17, 1];
  if (cls === "smd") {
    if (p === "R" || p === "RN" || p === "FB") return { height: clamp(0.3 * m, 0.35, 0.65), color: [0.13, 0.13, 0.14, 1] };
    if (p === "C") return { height: clamp(0.55 * m, 0.5, 2.0), color: [0.71, 0.62, 0.47, 1] };
    if (p === "L") return { height: clamp(0.6 * m, 0.8, 4), color: [0.28, 0.28, 0.29, 1] };
    if (p === "D" || p === "LED") return { height: clamp(0.5 * m, 0.6, 1.5), color: p === "LED" ? [0.86, 0.84, 0.74, 1] : dark };
    if (p === "Y" || p === "X") return { height: clamp(0.3 * m, 0.7, 1.4), color: [0.76, 0.76, 0.78, 1] };
    if (p === "U" || p === "IC" || p === "Q") return { height: clamp(0.12 * m + 0.6, 0.8, 1.8), color: dark };
    if (p === "J" || p === "P" || p === "CN" || p === "CON") return { height: clamp(0.5 * m, 1.5, 6), color: [0.12, 0.12, 0.12, 1] };
    return { height: clamp(0.4 * m, 0.5, 3), color: [0.22, 0.22, 0.24, 1] };
  }
  if (p === "R") return { height: clamp(0.9 * m, 1.6, 2.6), color: [0.76, 0.62, 0.42, 1] };
  if (p === "C") return round ? { height: clamp(1.4 * m, 4, 12), color: [0.13, 0.17, 0.32, 1] } : { height: clamp(0.9 * m, 2.5, 6), color: [0.80, 0.50, 0.18, 1] };
  if (p === "D" || p === "LED") return round ? { height: clamp(1.6 * m, 4, 9), color: [0.78, 0.16, 0.14, 1] } : { height: clamp(0.9 * m, 1.8, 4), color: dark };
  if (p === "U" || p === "IC") return { height: 3.6, color: dark };
  if (p === "Q") return { height: clamp(1.0 * m, 4, 9), color: dark };
  if (p === "J" || p === "P" || p === "CN" || p === "CON" || p === "K") return { height: clamp(0.6 * m, 2.5, 8.5), color: [0.12, 0.12, 0.12, 1] };
  if (p === "Y" || p === "X") return { height: clamp(0.8 * m, 3, 5), color: [0.76, 0.76, 0.78, 1] };
  if (p === "SW" || p === "S") return { height: clamp(0.6 * m, 3, 8), color: [0.3, 0.3, 0.32, 1] };
  if (p === "L" || p === "T" || p === "TR") return { height: clamp(0.8 * m, 3, 14), color: [0.26, 0.26, 0.27, 1] };
  return { height: clamp(0.5 * m, 2, 6), color: [0.22, 0.22, 0.24, 1] };
}

interface Extent { pts: Pt[]; circle: { x: number; y: number; r: number } | null }

/** The points a layer's outline graphics of one footprint span; a lone circle is reported as such. */
function layerExtent(item: KItem, layer: string): Extent {
  const pts: Pt[] = []; let circles = 0, others = 0; let circle: Extent["circle"] = null;
  for (const g of item.geom) {
    if (g.layer !== layer || g.t === "text") continue;
    if (g.t === "line") { pts.push([num(g.x1), num(g.y1)], [num(g.x2), num(g.y2)]); others++; }
    else if (g.t === "poly") { for (const p of (g.pts as Pt[] | undefined) || []) pts.push([p[0], p[1]]); others++; }
    else if (g.t === "circle" || g.t === "arc") {
      const x = num(g.x), y = num(g.y), r = num(g.r);
      pts.push([x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]);
      if (g.t === "circle") { circles++; if (!circle || r > circle.r) circle = { x, y, r }; } else others++;
    }
  }
  return { pts, circle: circles > 0 && others === 0 ? circle : null };
}

/** The placeholder body of one footprint, or null when it has nothing to stand on (no courtyard / fab outline). */
export function footprintBody(item: KItem): Body | null {
  if (item.kind !== "footprint") return null;
  const attrs = footprintAttrs(item.node);
  // board-only footprints (logos, mounting holes, test points drawn in copper) have no part; DNP parts
  // are hidden by default in KiCad's viewer ("Models marked DNP")
  if (attrs.has("board_only") || attrs.has("dnp")) return null;
  // a footprint with fewer than two pads carries no component: mounting holes, test points, fiducials, logos
  if (padCount(item) < 2) return null;
  // footprints that are board features by their library name
  if (/SolderJumper|TestPoint|MountingHole|Fiducial|NetTie|Logo/i.test(item.lib || "")) return null;
  const back = item.layer === "B.Cu";
  const cls: BodyClass = attrs.has("smd") ? "smd" : attrs.has("through_hole") ? "tht" : "virtual";
  let inset = 0.25;   // the courtyard clearance around the part (IPC-7351 nominal)
  let ext = layerExtent(item, back ? "B.CrtYd" : "F.CrtYd");
  if (ext.pts.length < 2) { ext = layerExtent(item, back ? "B.Fab" : "F.Fab"); inset = 0; }
  if (ext.pts.length < 2) return null;
  const ref = item.ref || "";
  const solids = modelSolids(item, cls === "smd" || (cls === "virtual" && !hasDrill(item)), back);
  if (ext.circle) {
    const r = Math.max(0.15, ext.circle.r - inset); const n = 32; const pts: Pt[] = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; pts.push([ext.circle.x + r * Math.cos(a), ext.circle.y + r * Math.sin(a)]); }
    const st = bodyStyle(cls === "virtual" ? "tht" : cls, ref, 2 * r, 2 * r, true);
    return { cls, back, pts, height: st.height, color: st.color, ref, solids };
  }
  // the bounding box in the footprint's own frame, so a rotated part gets a rotated box (sexpr.ts rotator's convention)
  const fx = num(item.x), fy = num(item.y); const a = num(item.rot) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ext.pts) {
    const dx = p[0] - fx, dy = p[1] - fy; const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (lx < x0) x0 = lx; if (lx > x1) x1 = lx; if (ly < y0) y0 = ly; if (ly > y1) y1 = ly;
  }
  const shrink = (lo: number, hi: number): [number, number] => (hi - lo > 2 * inset + 0.3 ? [lo + inset, hi - inset] : [lo, hi]);
  [x0, x1] = shrink(x0, x1); [y0, y1] = shrink(y0, y1);
  if (!(x1 - x0 > 0.05) || !(y1 - y0 > 0.05)) return null;
  const world = (lx: number, ly: number): Pt => [fx + lx * c + ly * s, fy - lx * s + ly * c];
  const st = bodyStyle(cls === "virtual" ? (hasDrill(item) ? "tht" : "smd") : cls, ref, x1 - x0, y1 - y0, false);
  return { cls, back, pts: [world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)], height: st.height, color: st.color, ref, solids };
}

/** parts.ts's solids for a footprint, mapped from its own frame to the board's; undefined when it models nothing. */
function modelSolids(item: KItem, smd: boolean, back: boolean): Solid[] | undefined {
  const fx = num(item.x), fy = num(item.y); const a = num(item.rot) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const local = (p: Pt): Pt => { const dx = p[0] - fx, dy = p[1] - fy; return [dx * c - dy * s, dx * s + dy * c]; };
  const world = (p: Pt): Pt => [fx + p[0] * c + p[1] * s, fy - p[0] * s + p[1] * c];
  const fab = layerExtent(item, back ? "B.Fab" : "F.Fab");
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  if (fab.pts.length >= 2) {
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of fab.pts) { const [lx, ly] = local(p); box.x0 = Math.min(box.x0, lx); box.x1 = Math.max(box.x1, lx); box.y0 = Math.min(box.y0, ly); box.y1 = Math.max(box.y1, ly); }
  }
  // a can's silk / fab circle (an electrolytic's outline), in the footprint's frame
  let circle: { x: number; y: number; r: number } | null = null;
  for (const layer of [back ? "B.Fab" : "F.Fab", back ? "B.SilkS" : "F.SilkS"]) {
    for (const g of item.geom) if (g.layer === layer && g.t === "circle" && (!circle || num(g.r) > circle.r)) { const [lx, ly] = local([num(g.x), num(g.y)]); circle = { x: lx, y: ly, r: num(g.r) }; }
    if (circle) break;
  }
  let solids: Solid[] | null = null;
  try { solids = partSolids(item.lib || "", item.ref || "", localPads(item.node), box, circle, smd); } catch { solids = null; }
  if (!solids || !solids.length) return undefined;
  return solids.map((so) => so.k === "prism" ? Object.assign({}, so, { pts: so.pts.map(world) }) : Object.assign({}, so, { a: world(so.a), b: world(so.b) }));
}

function padCount(item: KItem): number { let n = 0; for (const c of item.node) if (Array.isArray(c) && c[0] === "pad") n++; return n; }

function hasDrill(item: KItem): boolean { return item.geom.some((g) => !!g.hole); }

export function boardBodies(doc: KDoc): Body[] {
  const out: Body[] = [];
  for (const it of doc.items.values()) { const b = footprintBody(it); if (b) out.push(b); }
  return out;
}
