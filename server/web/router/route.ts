// Autorouter — the run: what to connect, in which order, with rip-up and retry, and the tracks and vias that
// come out.  Pure: reads a parsed board and the design rules, returns item nodes; nothing is written to the board
// here (the caller commits them as ordinary edits).
import { buildClass, DX, DY, fillPoly, Grid, Obstacle, pickGrid, pointGap, Pt, RuleClass, Shape, stamp, stampClass, viaFits } from "./grid";
import { costOf, dirOf, Features, featuresOf, Node, probe, ProbeResult, Terminal, Win } from "./probe";
import { TRAINED, Weights } from "./weights";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A supply net by its name: ground, a rail voltage, or one of the usual rail names. */
export const isSupply = (net: string): boolean => /^\/?(.*\/)?(A|D|P)?(GND|VSS|VEE)\w*$|^\/?(.*\/)?[+-]?\d+(V\d*|\.\d+V)\w*$|^\/?(.*\/)?(VCC|VDD|VBUS|VBAT|VIN|VSYS|VPP|VAA|VREF|VOUT|V\d+V\d*|PWR|\+BATT|-BATT)\w*$/i.test(net) && !/(_|\b)(EN|SENSE|SNS|FB|PG|OK|DET|MON|ADC)\w*$/i.test(net);
export interface RouteOptions {
  nets?: string[] | null;        // only these nets (names); default every net with a missing connection
  layers?: string[] | null;      // copper layers tracks may use; default the signal layers
  allowVias?: boolean;           // default true
  ripUp?: boolean;               // default true
  passes?: number;               // whole-board attempts with a different order; default 3
  pitch?: number;                // force the grid pitch, mm
  weights?: Partial<Weights>;
  powerWidth?: number;           // track width for supply nets (GND, +3V3, VBUS …) that have no class of their own; 0 keeps the class width.  Default: twice the class width, 0.3 to 0.5 mm
  timeMs?: number;               // stop starting new connections after this long
  zones?: boolean;               // let a route end in the net's own copper zone; default true
  // ---- a plan from outside (the assistant's model, or a person): the engine still does the geometry and the rules
  order?: string[];              // net names to route first, in this order; the rest follow in the heuristic order
  netOpts?: Record<string, NetPlan>;
  keepouts?: { layers?: string[]; box: Box }[];   // areas no new track or via may enter, for this run only
  explain?: boolean;             // say why each failed connection failed (default true)
}
export type Box = [number, number, number, number];   // x0, y0, x1, y1 in mm
export interface NetPlan {
  layers?: string[];             // copper layers the net should run on
  width?: number;                // track width in mm (never below the board's minimum)
  allowVias?: boolean; maxVias?: number;
  avoid?: Box[];                 // areas this net stays out of
  priority?: number;             // higher routes earlier (after `order`)
}
/** What became of one connection, in words a reviewer (a person or a model) can act on. */
export interface ConnReport {
  net: string; from: { x: number; y: number; pad?: string }; to: { x: number; y: number; pad?: string };
  routed: boolean; length: number; vias: number; bends: number; layers: string[]; detourRatio: number;
  reason?: "blocked" | "no-room" | "rule" | "budget"; detail?: string; blockedBy?: { nets: string[]; items: string[] };
}
export interface Anchor { p: Pt; layers: number[]; shape: Shape | null; cluster: number; grp?: number; narrow?: number; axis?: Pt }
export interface Conn {
  id: number; net: string; cls: RuleClass; a: Anchor; b: Anchor; len: number;
  nodes: Node[] | null; shapes: Obstacle[]; viaCells: number[]; landed: number; rips: number; feat: Features | null; stubs: [Pt, Pt, number][]; zoneEnd: boolean; ends?: [Anchor, Anchor]; stitch?: boolean; moot?: boolean;
  why?: string;
}
export interface RouteItem { kind: "segment" | "via"; node: any; net: any; netName: string; conn: number }
export interface RouteResult {
  items: RouteItem[]; total: number; routed: number; failed: { net: string; a: Pt; b: Pt }[];
  segments: number; vias: number; length: number; ms: number; passes: number; zoneEnds: number; zoneCovered: number;
  grid: { pitch: number; w: number; h: number; layers: string[] }; nets: number;
  connections: ConnReport[];
}
export interface Progress { done: number; total: number; routed: number; pass: number; net: string }

interface Guide { allowed: boolean[] | null; allowVias: boolean; maxVias: number; avoid: [number, number, number, number][]; rank: number; priority: number }
interface Found { res: ProbeResult; owner: Map<number, number>; flip: boolean; esc?: (Pt | undefined)[] }
interface NetInfo { key: string; obj: any; cls: RuleClass; conns: Conn[]; clusters: number; zoneCells: Node[] | null; zoneCluster: number; guide: Guide; anchors?: Anchor[]; pour?: { mask: (Uint8Array | null)[]; width: number; clr: number } }

const r6 = (v: number) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };

export class Router {
  G!: Grid; nets: NetInfo[] = []; conns: Conn[] = []; pref: number[] = []; W: Weights; allowVias: boolean; s: any;
  stopped = false; zoneCovered = 0; dropped: any[] = []; stat: Record<string, number> = { noSoft: 0, noBlockers: 0, tooMany: 0, ripped: 0, ripLimit: 0 };
  constructor(public K: any, public P: any, public doc: any, settings: any, public opts: RouteOptions = {}) {
    this.W = Object.assign({}, TRAINED, opts.weights || {}); this.allowVias = opts.allowVias !== false;
    this.s = settings && settings.netclasses ? settings : P.designSettings(settings);
    this.build();
  }

  /** Everything on the board a new track must keep clear of: copper by net, unplated holes and the board edge. */
  collectObstacles(nl: any): Map<string, Obstacle[]> {
    const { K, P, doc, s } = this; const copper: string[] = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const L = copper.length; const all = copper.map((_, i) => i);
    const obstacles = new Map<string, Obstacle[]>(); const push = (o: Obstacle) => { let l = obstacles.get(o.net); if (!l) obstacles.set(o.net, l = []); l.push(o); };
    for (const c of nl.conductors) {
      if (c.kind === "zone") continue;
      const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
      push({ net: c.net || "", layers, shape: c.shape, clr: P.netClearance(s, c.net), thru: L > 1 && layers.length === L && (c.kind === "pad" || c.kind === "via") ? [c.anchors[0][0], c.anchors[0][1]] : undefined });
    }
    for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of P.padsOf(it)) if (p.type === "np_thru_hole") {
      const d = K.kid(p.node, "drill"); const nums: number[] = d ? d.slice(1).filter((v: any) => typeof v === "number") : [];
      const w = nums.length ? nums[0] : p.w, h = nums.length > 1 ? nums[1] : nums.length ? nums[0] : p.h;
      push({ net: "", layers: all, shape: P.padShape({ shape: w === h ? "circle" : "oval", x: p.x, y: p.y, w, h, rot: p.rot }), clr: Math.max(s.clearance, s.holeClearance !== undefined ? s.holeClearance : 0.25) });   // Board Setup > Constraints: hole clearance
    }
    for (const e of P.edgeShapes(doc).shapes) push({ net: "", layers: all, shape: e, clr: 0, edge: true });
    return obstacles;
  }
  /** The board may have changed under a long run (other people edit it too): check the routes against it as it is now. */
  revalidate(): number {
    const before = this.conns.filter((c) => c.nodes).length; this.G.obstacles = this.collectObstacles(this.P.netlist(this.doc)); this.oidx = null; this.validate();
    return before - this.conns.filter((c) => c.nodes).length;
  }

  // ------------------------------------------------------------------ board → grid
  build(): void {
    const { K, P, doc, s } = this; const copper: string[] = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const L = copper.length;
    const nl = P.netlist(doc); const all = copper.map((_, i) => i);
    const obstacles = this.collectObstacles(nl);
    const pads: number[][] = []; let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const hv = copper.map(() => [0, 0]); const smd: Shape[] = [];
    for (const c of nl.conductors) {
      if (c.kind === "zone") continue;
      const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
      if (c.bbox[0] < bx0) bx0 = c.bbox[0]; if (c.bbox[1] < by0) by0 = c.bbox[1]; if (c.bbox[2] > bx1) bx1 = c.bbox[2]; if (c.bbox[3] > by1) by1 = c.bbox[3];
      if (c.kind === "pad") { const fine = c.pad.type === "smd" && Math.min(c.pad.w, c.pad.h) <= 0.35 ? 25 : 1; const ax = padAxis(c.pad); const along = Math.abs(ax[0]) > 0.7; pads.push([c.pad.x, c.pad.y, fine > 1 && along ? 0.2 : fine, fine > 1 && !along ? 0.2 : fine]); if (layers.length < L || L === 1) smd.push(c.shape); }
      if (c.kind === "segment") { const [a, b] = c.anchors; const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); if (dy < dx * 0.2) hv[layers[0]][0] += dx; else if (dx < dy * 0.2) hv[layers[0]][1] += dy; }
    }
    const outline: Pt[] | null = P.boardOutline(doc).outline;
    let bounds: [number, number, number, number];
    if (outline) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of outline) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } bounds = [x0, y0, x1, y1]; }
    else if (bx0 < bx1) bounds = [bx0 - 5, by0 - 5, bx1 + 5, by1 + 5]; else bounds = [0, 0, 10, 10];
    const pg = pickGrid(pads, bounds, L, this.opts.pitch);
    const W = Math.floor((bounds[2] - pg.ox) / pg.g) + 2, H = Math.floor((bounds[3] - pg.oy) / pg.g) + 2;
    const allow = this.opts.layers && this.opts.layers.length ? this.opts.layers : null;
    const routable = copper.map((name) => allow ? allow.includes(name) : (doc.layers.get(name) || { type: "signal" }).type !== "power");
    if (!routable.some(Boolean)) routable.fill(true);
    const rmin = s.clearance + s.trackWidth / 2;
    const G: Grid = this.G = { g: pg.g, ox: pg.ox, oy: pg.oy, W, H, layers: copper, routable, noVia: new Uint16Array(W * H), thru: new Uint8Array(W * H), outside: null, keep: copper.map(() => null),
      edgeClr: Math.max(s.edgeClearance || 0, 0), margin: pg.g * pg.g / (4 * Math.max(rmin, 0.05)) + 0.002, obstacles, classes: new Map(), weights: this.W };
    if (outline) { const out = G.outside = new Uint8Array(W * H).fill(1); fillPoly(G, outline, (x0, x1, iy) => out.fill(0, iy * W + x0, iy * W + x1 + 1)); }
    for (const sh of smd) stamp(G, G.noVia, sh, 0, 1);
    // rule areas
    const zoneLayers = (n: any): number[] => { const l = K.kid(n, "layer"), ls = K.kid(n, "layers"); const names: string[] = l ? [K.str(l[1])] : ls ? ls.slice(1).map(K.str) : []; const out = new Set<number>(); for (const nm of names) { if (nm === "*.Cu" || nm === "F&B.Cu") all.forEach((i) => out.add(i)); else { const i = copper.indexOf(nm); if (i >= 0) out.add(i); } } return Array.from(out); };
    // A zone's outline may carry holes as further polygons: inside means inside an odd number of them.
    const zones: { net: string; layers: number[]; polys: Pt[][]; clr: number; minW: number }[] = [];
    const cellsIn = (polys: Pt[][]): Uint8Array => { const t = new Uint8Array(W * H); for (const pts of polys) fillPoly(G, pts, (x0, x1, iy) => { for (let i = iy * W + x0; i <= iy * W + x1; i++) t[i] ^= 1; }); return t; };
    for (const it of doc.items.values()) {
      if (it.kind !== "zone") continue; const n = it.node; const polys: Pt[][] = K.kids(n, "polygon").map((poly: any) => K.ptsOf(poly) as Pt[]).filter((pts: Pt[]) => pts.length >= 3); if (!polys.length) continue;
      const ko = K.kid(n, "keepout"); const layers = zoneLayers(n);
      if (ko) {
        const no = (k: string) => { const c = K.kid(ko, k); return !!c && K.str(c[1]) === "not_allowed"; };
        if (!no("tracks") && !no("vias")) continue; const t = cellsIn(polys);
        if (no("tracks")) for (const l of layers) { const m = G.keep[l] || (G.keep[l] = new Uint8Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) m[i] = 1; }
        for (let i = 0; i < t.length; i++) if (t[i]) G.noVia[i]++;
      } else if (layers.length) { const cp = K.kid(n, "connect_pads"), cc = cp && K.kid(cp, "clearance"), mt = K.kid(n, "min_thickness"); zones.push({ net: nl.table.key(P.netOf(n)), layers, polys, clr: cc ? K.num(cc[1], 0) : 0, minW: mt ? K.num(mt[1], 0.25) : 0.25 }); }
    }
    for (const ko of this.opts.keepouts || []) {
      const b = this.cellBox(ko.box); if (!b) continue; const ls = ko.layers && ko.layers.length ? ko.layers.map((nm) => copper.indexOf(nm)).filter((i) => i >= 0) : all;
      for (const l of ls) { const m = G.keep[l] || (G.keep[l] = new Uint8Array(W * H)); for (let iy = b[1]; iy <= b[3]; iy++) m.fill(1, iy * W + b[0], iy * W + b[2] + 1); }
      for (let iy = b[1]; iy <= b[3]; iy++) for (let ix = b[0]; ix <= b[2]; ix++) G.noVia[iy * W + ix]++;
    }
    for (const it of doc.items.values()) if (it.kind === "footprint") { const ref = refOf(K, it.node); for (const p of P.padsOf(it)) this.padNames.set(p.x.toFixed(3) + "," + p.y.toFixed(3), (ref || "?") + "." + p.number); }
    this.pref = hv.map(([h, v]) => h + v > 20 ? (h - v) / (h + v) : 0);
    // An empty board has no habit yet: give it the usual one, alternate layers running across and along.
    if (hv.every(([h, v]) => h + v <= 20) && routable.filter(Boolean).length > 1) { let k = 0; this.pref = routable.map((r) => r ? (k++ % 2 ? -0.5 : 0.5) : 0); }

    // ---- what to connect: per net, a spanning tree over its islands of copper
    const want = this.opts.nets ? new Set(this.opts.nets) : null; const useZones = this.opts.zones !== false;
    for (const net of nl.nets.values()) {
      if (!net.key || (want && !want.has(net.key))) continue;
      const clusters: Anchor[][] = [];
      for (const cl of net.clusters) {
        const anchors: Anchor[] = [];
        for (const c of cl.items) {
          if (c.kind === "zone") continue;
          const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
          for (const p of c.anchors) {
            const ix = Math.round((p[0] - G.ox) / G.g), iy = Math.round((p[1] - G.oy) / G.g);
            if (ix < 0 || iy < 0 || ix >= W || iy >= H || (G.outside && G.outside[iy * W + ix])) continue;   // off the board: nothing to route to
            anchors.push({ p: [p[0], p[1]], layers, shape: c.kind === "pad" || c.kind === "via" ? c.shape : { t: "circle", x: p[0], y: p[1], r: (c.width || 0.2) / 2 }, cluster: 0, narrow: c.kind === "pad" && c.pad.type === "smd" ? Math.min(c.pad.w, c.pad.h) : undefined, axis: c.kind === "pad" && c.pad.type === "smd" ? padAxis(c.pad) : undefined });
          }
        }
        if (anchors.length) { for (const a of anchors) a.grp = clusters.length; clusters.push(anchors); }
      }
      // An unfilled zone of the net joins the pads it covers on its own layers once it is filled: those need no
      // track.  The remaining islands may reach the zone with a short track and a via instead of a long one.
      const mine = useZones ? zones.filter((z) => z.net === net.key) : []; let zoneCluster = -1; let zoneCells: Node[] | null = null; let pour: NetInfo["pour"]; const anchors = ([] as Anchor[]).concat(...clusters);
      if (mine.length) {
        const inZone = (a: Anchor) => mine.some((z) => z.layers.some((l) => a.layers.includes(l)) && z.polys.filter((pts) => pointInPolyPts(pts, a.p)).length % 2 === 1);
        const covered: number[] = [], rest: Anchor[][] = [];
        clusters.forEach((cl, i) => { if (cl.some(inZone)) covered.push(i); else rest.push(cl); });
        if (covered.length) {
          const merged: Anchor[] = []; for (const i of covered) merged.push(...clusters[i]);
          this.zoneCovered += covered.length - 1; clusters.length = 0; clusters.push(merged, ...rest); zoneCluster = 0;
          zoneCells = [];
          pour = { mask: copper.map(() => null), width: Math.max(...mine.map((z) => z.minW)), clr: Math.max(P.netClearance(s, net.key), s.minClearance || 0, ...mine.map((z) => z.clr)) };
          for (const z of mine) { const t = cellsIn(z.polys); for (const l of z.layers) if (routable[l]) { const m = pour.mask[l] || (pour.mask[l] = new Uint8Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) { m[i] = 1; zoneCells.push({ ix: i % W, iy: (i / W) | 0, l }); } } }
        }
      }
      if (clusters.length < 2 && !pour) continue;
      clusters.forEach((cl, i) => cl.forEach((a) => { a.cluster = i; }));
      const cls = this.classFor(net.key);
      const info: NetInfo = { key: net.key, obj: nl.table.byName.get(net.key) || { code: net.code, name: net.name }, cls, conns: [], clusters: clusters.length, zoneCells, zoneCluster, guide: this.guideFor(net.key), anchors, pour };
      // Prim's tree over the islands through their nearest anchors (the ratsnest)
      const near = (i: number, j: number) => { let best: [number, Anchor, Anchor] | null = null; for (const a of clusters[i]) for (const b of clusters[j]) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (!best || d < best[0]) best = [d, a, b]; } return best!; };
      const inTree = clusters.map(() => false); const bestTo: ([number, Anchor, Anchor] | null)[] = clusters.map(() => null);
      const update = (k: number) => { for (let j = 0; j < clusters.length; j++) { if (inTree[j]) continue; const e = near(k, j); if (!bestTo[j] || e[0] < bestTo[j]![0]) bestTo[j] = e; } };
      inTree[0] = true; update(0);
      for (let n = 1; n < clusters.length; n++) {
        let j = -1; for (let i = 0; i < clusters.length; i++) if (!inTree[i] && (j < 0 || bestTo[i]![0] < bestTo[j]![0])) j = i;
        inTree[j] = true; const e = bestTo[j]!;
        const room = Math.min(this.roomAt(e[1], net.key), this.roomAt(e[2], net.key));
        const conn: Conn = { id: this.conns.length, net: net.key, cls: this.classFor(net.key, room), a: e[2], b: e[1], len: e[0], nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false };
        this.conns.push(conn); info.conns.push(conn); update(j);
      }
      this.nets.push(info);
    }
  }

  /** The rule class a net routes with (its netclass's track width, clearance and via), built on first use. */
  classFor(netKey: string, cap = Infinity, want = 0): RuleClass {
    const { P, s, G } = this; const nc = P.netclassOf(s, netKey); const plan = (this.opts.netOpts || {})[netKey]; const pw = plan && +plan.width! > 0 ? +plan.width! : 0;
    let width = Math.max(pw || Math.max(nc.track_width !== undefined ? nc.track_width : s.trackWidth, want), s.minTrackWidth || 0);
    // A fine-pitch pad only has room for so wide a track between its neighbours: a connection that ends on one
    // runs as wide as that room allows, as people neck tracks down at such pads.
    if (cap < width) width = Math.max(s.minTrackWidth || 0.1, 0.1, Math.floor(cap * 100 + 1e-6) / 100);
    const clr = Math.max(P.netClearance(s, netKey), s.minClearance || 0); const viaD = Math.max(nc.via_diameter !== undefined ? nc.via_diameter : s.viaDiameter, s.minViaDiameter || 0);
    const viaDrill = Math.max(nc.via_drill !== undefined ? nc.via_drill : s.viaDrill, s.minViaDrill || 0);
    const key = `${width}/${clr}/${viaD}/${viaDrill}`; return G.classes.get(key) || buildClass(G, key, width, clr, viaD, viaDrill);
  }
  /** Supply nets carry the board's current: where the net has no class or plan of its own, they run wider. */
  powerWidth(netKey: string): number {
    const { P, s } = this; const o = this.opts.powerWidth; if (o === 0 || !isSupply(netKey)) return 0;
    if (((this.opts.netOpts || {})[netKey] || {}).width) return 0; const nc = P.netclassOf(s, netKey); if (s.netclasses.Default && nc !== s.netclasses.Default) return 0; const w = nc.track_width !== undefined ? nc.track_width : s.trackWidth;
    return o && o > 0 ? o : Math.min(0.5, Math.max(0.3, w * 2));
  }
  padNames = new Map<string, string>();
  private cellBox(b: Box): [number, number, number, number] | null {
    const G = this.G; if (!b || b.length < 4) return null;
    const x0 = Math.max(0, Math.ceil((Math.min(b[0], b[2]) - G.ox) / G.g)), x1 = Math.min(G.W - 1, Math.floor((Math.max(b[0], b[2]) - G.ox) / G.g));
    const y0 = Math.max(0, Math.ceil((Math.min(b[1], b[3]) - G.oy) / G.g)), y1 = Math.min(G.H - 1, Math.floor((Math.max(b[1], b[3]) - G.oy) / G.g));
    return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
  }
  /** The plan's wishes for a net, resolved against this board. */
  private guideFor(netKey: string): Guide {
    const G = this.G, plan: NetPlan = (this.opts.netOpts || {})[netKey] || {}; const rank = (this.opts.order || []).indexOf(netKey);
    let allowed: boolean[] | null = null;
    if (plan.layers && plan.layers.length) { allowed = G.layers.map((nm) => plan.layers!.includes(nm)); if (!allowed.some(Boolean)) allowed = null; }
    return { allowed, allowVias: this.allowVias && plan.allowVias !== false, maxVias: plan.maxVias === undefined || plan.maxVias === null ? Infinity : Math.max(0, +plan.maxVias),
      avoid: (plan.avoid || []).map((b) => this.cellBox(b)).filter(Boolean) as [number, number, number, number][], rank: rank < 0 ? Infinity : rank, priority: +plan.priority! || 0 };
  }
  /** A connection between two given points of a net, outside the run's own list (the trainer and tools use this). */
  adhoc(netKey: string, a: { p: Pt; layers: number[]; shape: Shape | null }, b: { p: Pt; layers: number[]; shape: Shape | null }): Conn {
    let info = this.nets.find((n) => n.key === netKey);
    if (!info) { info = { key: netKey, obj: null, cls: this.classFor(netKey), conns: [], clusters: 2, zoneCells: null, zoneCluster: -1, guide: this.guideFor(netKey) }; this.nets.push(info); }
    return { id: -1, net: netKey, cls: info.cls, a: { ...a, cluster: 0 }, b: { ...b, cluster: 1 }, len: Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]), nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false };
  }

  // ------------------------------------------------------------------ lifting a net's own copper out of its map
  private netOf(key: string): NetInfo { return this.nets.find((n) => n.key === key)!; }
  lift(net: NetInfo, sign: number, c: RuleClass = net.cls): void {
    const G = this.G;
    for (const o of G.obstacles.get(net.key) || []) {
      stampClass(G, c, o, -sign, true);
      if (o.thru) {   // a plated hole: a pad or via through every layer
        const ix = Math.round((o.thru[0] - G.ox) / G.g), iy = Math.round((o.thru[1] - G.oy) / G.g);
        if (ix >= 0 && iy >= 0 && ix < G.W && iy < G.H) G.thru[iy * G.W + ix] = sign > 0 ? 1 : 0;
      }
    }
    for (const b of net.guide.avoid) for (const maps of [c.full, c.fixed, c.vfull, c.vfixed]) for (const m of maps) for (let iy = b[1]; iy <= b[3]; iy++) for (let i = iy * G.W + b[0]; i <= iy * G.W + b[2]; i++) m[i] += sign;
    for (const conn of net.conns) if (conn.nodes) {
      for (const o of conn.shapes) stampClass(G, c, o, -sign, false);
      for (const gi of conn.viaCells) G.thru[gi] = sign > 0 ? 1 : 0;
    }
  }
  private place(conn: Conn, sign: number): void {
    const G = this.G; for (const c of G.classes.values()) for (const o of conn.shapes) stampClass(G, c, o, sign, false);
  }
  private mm(n: { ix: number; iy: number }): Pt { return [r6(this.G.ox + n.ix * this.G.g), r6(this.G.oy + n.iy * this.G.g)]; }

  /** The free cell a route starts from at an anchor: its own cell, else the nearest free one still on the pad. */
  access(a: Anchor, maps: Uint16Array[], rt: boolean[] = this.G.routable): Terminal | null {
    const G = this.G; const cx = (a.p[0] - G.ox) / G.g, cy = (a.p[1] - G.oy) / G.g; const layers = a.layers.filter((l) => rt[l]); if (!layers.length) return null;
    let best: Terminal | null = null, bd = Infinity; const R = a.shape ? Math.min(6, Math.ceil(1 / G.g)) : 0;
    for (let iy = Math.round(cy) - R; iy <= Math.round(cy) + R; iy++) for (let ix = Math.round(cx) - R; ix <= Math.round(cx) + R; ix++) {
      if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; const d = Math.hypot(ix - cx, iy - cy); if (d >= bd) continue;
      if (R && d > 0.71 && pointGap(a.shape, G.ox + ix * G.g, G.oy + iy * G.g) > 0) continue;
      const free = layers.filter((l) => !maps[l][iy * G.W + ix]); if (!free.length) continue;
      bd = d; best = { ix, iy, layers: free };
    }
    return best || this.escape(a, maps, layers);
  }
  /**
   * A pad with no legal track centre on the grid (a fine-pitch pad whose row falls between grid rows): leave it
   * straight along its own axis, off the grid, to the first point from which a grid cell is reached — both pieces
   * checked exactly against everything around.
   */
  private escape(a: Anchor, maps: Uint16Array[], layers: number[]): Terminal | null {
    if (!a.axis || !this.cur) return null; const G = this.G, w = this.cur.cls.width, net = this.cur.net, clr = this.cur.cls.clr;
    for (let t = G.g; t <= 3; t += G.g / 2) for (const sgn of [1, -1]) {
      const q: Pt = [r6(a.p[0] + a.axis[0] * t * sgn), r6(a.p[1] + a.axis[1] * t * sgn)]; const ix = Math.round((q[0] - G.ox) / G.g), iy = Math.round((q[1] - G.oy) / G.g);
      if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; const free = layers.filter((l) => !maps[l][iy * G.W + ix]); if (!free.length) continue;
      const c: Pt = [r6(G.ox + ix * G.g), r6(G.oy + iy * G.g)];
      const ok = free.filter((l) => this.clearOf({ t: "seg", a: a.p, b: q, r: w / 2 }, l, net, clr) && this.clearOf({ t: "seg", a: q, b: c, r: w / 2 }, l, net, clr));
      if (ok.length) return { ix, iy, layers: ok, esc: q };
    }
    return null;
  }
  /** The widest track that can leave a fine-pitch pad along its axis and keep the clearance to what is beside it. */
  private roomAt(a: Anchor, net: string): number {
    if (!a.axis || !a.narrow || a.narrow > 0.35) return Infinity; const G = this.G, P = this.P; const clr = Math.max(P.netClearance(this.s, net), this.s.minClearance || 0); this.index();
    let half = Infinity; const B = 2; const seen = new Set<any>();
    for (const sgn of [1, -1]) {
      let h = Infinity; const b: Pt = [a.p[0] + a.axis[0] * 0.45 * sgn, a.p[1] + a.axis[1] * 0.45 * sgn]; const sh = { t: "seg", a: a.p, b, r: 0 }; seen.clear();
      for (let y = Math.floor((Math.min(a.p[1], b[1]) - 1) / B); y <= Math.floor((Math.max(a.p[1], b[1]) + 1) / B); y++) for (let x = Math.floor((Math.min(a.p[0], b[0]) - 1) / B); x <= Math.floor((Math.max(a.p[0], b[0]) + 1) / B); x++) for (const e of this.oidx!.get(x + "," + y) || []) {
        if (seen.has(e)) continue; seen.add(e); if ((e.o.net && e.o.net === net) || !e.o.layers.some((l) => a.layers.includes(l))) continue;
        const v = P.shapeGap(e.o.shape, sh) - (e.o.edge ? G.edgeClr : Math.max(e.o.clr, clr)); if (v < h) h = v;
      }
      if (sgn === 1 || h > half) half = sgn === 1 ? h : Math.max(half, h);   // the better of the two ways out
    }
    return half === Infinity ? Infinity : Math.max(0, 2 * (half - G.margin - 0.004));
  }
  private index(): void {
    if (this.oidx) return; const G = this.G, B = 2; const idx = this.oidx = new Map();
    const full = (s: Shape): number[] => { if (s.t === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]; if (s.t === "seg") return [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const pts: Pt[] = s.pts || [[s.x - Math.hypot(s.w, s.h) / 2, s.y - Math.hypot(s.w, s.h) / 2], [s.x + Math.hypot(s.w, s.h) / 2, s.y + Math.hypot(s.w, s.h) / 2]]; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } const o = s.r || 0; return [x0 - o, y0 - o, x1 + o, y1 + o]; };
    const add = (o: Obstacle) => { const bb = full(o.shape); const e = { o, bb }; for (let y = Math.floor(bb[1] / B); y <= Math.floor(bb[3] / B); y++) for (let x = Math.floor(bb[0] / B); x <= Math.floor(bb[2] / B); x++) { const k = x + "," + y; let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(e); } };
    for (const list of G.obstacles.values()) for (const o of list) { if (o.shape.t === "path" && o.shape.pts.length > 2) { for (let i = 0; i + 1 < o.shape.pts.length; i++) add({ net: o.net, layers: o.layers, clr: o.clr, edge: o.edge, shape: { t: "seg", a: o.shape.pts[i], b: o.shape.pts[i + 1], r: o.shape.r || 0 } }); } else add(o); }
  }
  private cur: Conn | null = null; private curSoft = false; private oidx: Map<string, { o: Obstacle; bb: number[] }[]> | null = null;
  /** Exact: does a piece of track keep its clearance to the board's copper, holes and edges, and to this run's routes? */
  private clearOf(shape: Shape, layer: number, net: string, clr: number, why?: { net: string; gap: number; need: number }): boolean {
    const G = this.G, P = this.P, B = 2; const bbOf = (s: Shape): number[] => s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.t === "seg" ? [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r] : null as any;
    this.index();
    const bb = bbOf(shape); const m = Math.max(clr, this.s.clearance, G.edgeClr) + 0.3; const seen = new Set<any>();
    for (let y = Math.floor((bb[1] - m) / B); y <= Math.floor((bb[3] + m) / B); y++) for (let x = Math.floor((bb[0] - m) / B); x <= Math.floor((bb[2] + m) / B); x++) for (const e of this.oidx!.get(x + "," + y) || []) {
      if (seen.has(e)) continue; seen.add(e); if (e.o.net && e.o.net === net) continue; if (!e.o.layers.includes(layer)) continue;
      const need = (e.o.edge ? G.edgeClr : Math.max(e.o.clr, clr)) - 5e-5; if (e.bb[0] > bb[2] + need || e.bb[2] < bb[0] - need || e.bb[1] > bb[3] + need || e.bb[3] < bb[1] - need) continue;
      const gap = P.shapeGap(e.o.shape, shape); if (gap < need) { if (why) { why.net = e.o.net; why.gap = gap; why.need = need + 5e-5; } return false; }
    }
    if (!this.curSoft) for (const c of this.conns) {
      if (!c.nodes || c.net === net) continue; const need = Math.max(c.cls.clr, clr) - 5e-5;
      for (const o of c.shapes) { if (!o.layers.includes(layer)) continue; const ob = bbOf(o.shape); if (ob[0] > bb[2] + need || ob[2] < bb[0] - need || ob[1] > bb[3] + need || ob[3] < bb[1] - need) continue; if (P.shapeGap(o.shape, shape) < need) return false; }
    }
    return true;
  }
  /** Islands of a net joined by the routes laid so far. */
  private components(net: NetInfo): number[] {
    const parent = Array.from({ length: net.clusters }, (_, i) => i); const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const c of net.conns) if (c.nodes) parent[find(c.a.cluster)] = find(c.b.cluster);
    return parent.map((_, i) => find(i));
  }
  private cellsOf(conn: Conn, out: Node[], owner: Map<number, number>): void {
    const G = this.G, nodes = conn.nodes!;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue;
      const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy);
      for (let k = 0; k <= n; k++) { const ix = a.ix + sx * k, iy = a.iy + sy * k; out.push({ ix, iy, l: a.l }); owner.set(a.l * G.W * G.H + iy * G.W + ix, conn.id); }
    }
  }

  // ------------------------------------------------------------------ one connection
  /** Search a route for the connection in the given maps (the net's own copper is lifted while it runs). */
  find(conn: Conn, soft: boolean, collect?: Features[]): Found | null {
    const G = this.G, net = this.netOf(conn.net); this.lift(net, 1, conn.cls); this.cur = conn; this.curSoft = soft;
    try {
      const maps = soft ? conn.cls.fixed : conn.cls.full, vmaps = soft ? conn.cls.vfixed : conn.cls.vfull;
      const comp = this.components(net); const owner = new Map<number, number>();
      const cells = (cluster: number) => { const out: Node[] = []; if (collect) return out; for (const c of net.conns) if (c.nodes && c !== conn && comp[c.a.cluster] === comp[cluster]) this.cellsOf(c, out, owner); return out; };
      let ta = cells(conn.a.cluster), tb = cells(conn.b.cluster);
      const zoneAt = (cluster: number) => !collect && net.zoneCells && comp[cluster] === comp[net.zoneCluster];
      // the larger tree is the target, so the route may join it anywhere along its tracks
      let flip = ta.length > tb.length || (!!zoneAt(conn.a.cluster) && !zoneAt(conn.b.cluster)); if (flip) { const t = ta; ta = tb; tb = t; }
      const A = flip ? conn.b : conn.a, B = flip ? conn.a : conn.b;
      // A plan may confine the net to some layers.  Where an end has no copper on them (a surface pad), its own layer
      // stays open so the route can leave the pad, at a price per mm that sends it to the wanted layers quickly.
      const gd = net.guide; let rt = G.routable, extra: ((nodes: Node[]) => number) | undefined;
      if (gd.allowed && !collect) {
        const want = gd.allowed.map((v, l) => v && G.routable[l]); const open = want.slice(); let relaxed = false;
        if (want.some(Boolean)) {
          for (const e of [A, B]) if (!e.layers.some((l) => want[l])) for (const l of e.layers) if (G.routable[l] && !open[l]) { open[l] = true; relaxed = true; }
          rt = open;
          if (relaxed) extra = (nodes) => { let off = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l === b.l && !want[a.l]) off += Math.hypot(b.ix - a.ix, b.iy - a.iy) * G.g; } return off * 4 * this.W.length; };
        }
      }
      if (soft && !collect) {   // looking through this run's routes: prefer the way that disturbs the fewest of them
        const full = conn.cls.full, plan = extra;
        extra = (nodes) => { let hit = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const m = full[a.l]; for (let k = 0; k <= n; k++) if (m[(a.iy + sy * k) * G.W + a.ix + sx * k]) hit++; } return hit * G.g * 12 * this.W.length + (plan ? plan(nodes) : 0); };
      }
      let used = 0; for (const c of net.conns) if (c.nodes && c !== conn && c.feat) used += c.feat.vias;
      const maxVias = gd.maxVias - used;
      const src = this.access(A, maps, rt), tgt = this.access(B, maps, rt); if (!src) return null;
      let term = tb; let zoneSet: Set<number> | null = null;
      if (zoneAt(B.cluster)) { zoneSet = new Set(); term = tb.slice(); for (const z of net.zoneCells!) if (rt[z.l] && !maps[z.l][z.iy * G.W + z.ix]) { term.push(z); zoneSet.add(z.l * G.W * G.H + z.iy * G.W + z.ix); } }
      if (!tgt && !term.length) return null;
      const x0 = Math.min(src.ix, tgt ? tgt.ix : src.ix), x1 = Math.max(src.ix, tgt ? tgt.ix : src.ix), y0 = Math.min(src.iy, tgt ? tgt.iy : src.iy), y1 = Math.max(src.iy, tgt ? tgt.iy : src.iy);
      const span = Math.max(x1 - x0, y1 - y0);
      const margins = [Math.max(14, Math.round(span * 0.35)), Math.max(50, Math.round(span * 1.2)), Math.max(G.W, G.H)];
      for (let i = 0; i < margins.length; i++) {
        const m = margins[i]; const win: Win = { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(G.W - 1, x1 + m), y1: Math.min(G.H - 1, y1 + m) };
        const res = probe({ G, maps, vmaps, src, tgt, term, win, pref: this.pref, W: this.W, allowVias: gd.allowVias && maxVias > 0, maxSteps: 6e6, collect, routable: rt, maxVias: maxVias === Infinity ? undefined : maxVias, extra });
        if (res) {
          res.nodes = this.mitre(simplify(res.nodes), maps);
          if (res.onTerm) { const e = res.nodes[res.nodes.length - 1]; const k = e.l * G.W * G.H + e.iy * G.W + e.ix; if (zoneSet && zoneSet.has(k) && !owner.has(k)) (res as any).zoneEnd = true; }
          return { res, owner, flip, esc: [src.esc, tgt ? tgt.esc : undefined] };
        }
        if (win.x0 === 0 && win.y0 === 0 && win.x1 === G.W - 1 && win.y1 === G.H - 1) break;
      }
      return null;
    } finally { this.lift(net, -1, conn.cls); }
  }
  /** Chamfer the 90° corners the search was forced into, as far as the neighbouring copper allows. */
  private mitre(nodes: Node[], maps: Uint16Array[]): Node[] {
    const G = this.G; const maxCells = Math.max(1, Math.round(this.W.mitre / G.g)); const out: Node[] = [nodes[0]];
    const run = (a: Node, b: Node) => Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy));
    const corner = (i: number) => { if (i <= 0 || i >= nodes.length - 1) return 0; const a = nodes[i - 1], b = nodes[i], c = nodes[i + 1]; if (a.l !== b.l || b.l !== c.l) return 0; let d = Math.abs(dirOf(b.ix - a.ix, b.iy - a.iy) - dirOf(c.ix - b.ix, c.iy - b.iy)); d = Math.min(d, 8 - d); return d; };
    for (let i = 1; i < nodes.length; i++) {
      const b = nodes[i];
      if (corner(i) === 2) {
        const a = out[out.length - 1], c = nodes[i + 1]; const la = run(a, b), lc = run(b, c);
        const ia = [Math.sign(b.ix - a.ix), Math.sign(b.iy - a.iy)], oc = [Math.sign(c.ix - b.ix), Math.sign(c.iy - b.iy)];
        const endA = corner(i - 1) === 0 && out.length === 1, endC = i + 1 === nodes.length - 1;
        let m = Math.min(maxCells, endA ? la : la >> 1, endC ? lc : lc >> 1); let done = false;
        for (; m >= 1 && !done; m--) {
          const p1 = { ix: b.ix - ia[0] * m, iy: b.iy - ia[1] * m, l: b.l }, p2 = { ix: b.ix + oc[0] * m, iy: b.iy + oc[1] * m, l: b.l };
          const sx = Math.sign(p2.ix - p1.ix), sy = Math.sign(p2.iy - p1.iy), n = run(p1, p2); let ok = true;
          for (let k = 1; k < n && ok; k++) if (maps[b.l][(p1.iy + sy * k) * G.W + p1.ix + sx * k]) ok = false;
          if (ok) { if (p1.ix !== a.ix || p1.iy !== a.iy) out.push(p1); out.push(p2); done = true; if (p2.ix === c.ix && p2.iy === c.iy) i++; }
        }
        if (done) continue;
      }
      out.push(b);
    }
    return simplify(out);
  }
  /** Lay a found route: its copper becomes an obstacle for every other net. */
  commit(conn: Conn, found: Found): void {
    const G = this.G, { res, flip } = found; const nodes = res.nodes; const w = conn.cls.width; const all = G.layers.map((_, i) => i);
    const shapes: Obstacle[] = [], viaCells: number[] = []; const clr = conn.cls.clr; const net = this.netOf(conn.net);
    // thru cells are only known while the net is lifted
    this.lift(net, 1, conn.cls);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (a.l !== b.l) { const gi = a.iy * G.W + a.ix; if (!G.thru[gi] && !viaCells.includes(gi)) { viaCells.push(gi); const p = this.mm(a); shapes.push({ net: conn.net, layers: all, shape: { t: "circle", x: p[0], y: p[1], r: conn.cls.viaD / 2 }, clr }); } }
      else shapes.push({ net: conn.net, layers: [a.l], shape: { t: "seg", a: this.mm(a), b: this.mm(b), r: w / 2 }, clr });
    }
    this.lift(net, -1, conn.cls);
    conn.nodes = nodes; conn.shapes = shapes; conn.viaCells = viaCells; conn.stubs = []; conn.feat = featuresOf(G, nodes, this.pref); conn.zoneEnd = !!(res as any).zoneEnd;
    const A = flip ? conn.b : conn.a, B = flip ? conn.a : conn.b; const first = nodes[0], last = nodes[nodes.length - 1];
    const piece = (from: Pt, to: Pt, l: number) => { if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 1e-4) { conn.stubs.push([from, to, l]); conn.shapes.push({ net: conn.net, layers: [l], shape: { t: "seg", a: from, b: to, r: w / 2 }, clr }); } };
    const stub = (anchor: Anchor, n: Node, esc?: Pt) => { const p = this.mm(n); if (esc) { piece(anchor.p, esc, n.l); piece(esc, p, n.l); } else piece(anchor.p, p, n.l); };
    const esc = found.esc || []; stub(A, first, esc[0]); if (!res.onTerm) stub(B, last, esc[1]);
    conn.landed = -1;
    if (res.onTerm) { const o = found.owner.get(last.l * G.W * G.H + last.iy * G.W + last.ix); if (o !== undefined) conn.landed = o; }
    this.place(conn, 1);
  }
  /** Take a laid route (and every route that joined it mid-track) off the board again. */
  rip(conn: Conn, out: Conn[] = []): Conn[] {
    if (!conn.nodes) return out;
    this.place(conn, -1); conn.nodes = null; conn.shapes = []; conn.viaCells = []; conn.stubs = []; out.push(conn);
    if (conn.ends) { conn.a = conn.ends[0]; conn.b = conn.ends[1]; conn.ends = undefined; }
    for (const c of this.conns) if (c.nodes && c.landed === conn.id) this.rip(c, out);
    return out;
  }
  /** Routes of other nets laid in this run that a candidate route would run into. */
  private blockers(conn: Conn, res: ProbeResult): Conn[] {
    const G = this.G, P = this.P; const w = conn.cls.width; const mine: { l: number[]; s: Shape; bb: number[] }[] = []; const nodes = res.nodes;
    const bb = (s: Shape) => s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1]; let s: Shape, l: number[];
      if (a.l !== b.l) { const p = this.mm(a); s = { t: "circle", x: p[0], y: p[1], r: conn.cls.viaD / 2 }; l = G.layers.map((_, k) => k); } else { s = { t: "seg", a: this.mm(a), b: this.mm(b), r: w / 2 }; l = [a.l]; }
      mine.push({ l, s, bb: bb(s) });
    }
    const out: Conn[] = [];
    for (const o of this.conns) {
      if (!o.nodes || o.net === conn.net) continue; const need = Math.max(conn.cls.clr, o.cls.clr) + G.margin + G.g * 1.5; let hit = false;
      for (const sh of o.shapes) { const ob = bb(sh.shape); for (const m of mine) { if (ob[0] > m.bb[2] + need || ob[2] < m.bb[0] - need || ob[1] > m.bb[3] + need || ob[3] < m.bb[1] - need) continue; if (!sh.layers.some((x) => m.l.includes(x))) continue; if (P.shapeGap(sh.shape, m.s) < need) { hit = true; break; } } if (hit) break; }
      if (hit) out.push(o);
    }
    return out;
  }
  /** Is every cell of a route free in the full map (after its blockers were ripped)? */
  private fits(conn: Conn, res: ProbeResult): boolean {
    const G = this.G, net = this.netOf(conn.net); this.lift(net, 1, conn.cls);
    try {
      const maps = conn.cls.full, nodes = res.nodes;
      for (let i = 0; i + 1 < nodes.length; i++) {
        const a = nodes[i], b = nodes[i + 1];
        if (a.l !== b.l) { if (!G.thru[a.iy * G.W + a.ix] && !viaFits(G, conn.cls.vfull, a.iy * G.W + a.ix)) return false; continue; }
        const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy);
        for (let k = 0; k <= n; k++) if (maps[a.l][(a.iy + sy * k) * G.W + a.ix + sx * k]) return false;
      }
      return true;
    } finally { this.lift(net, -1, conn.cls); }
  }

  // ------------------------------------------------------------------ the run
  *run(): Generator<Progress, RouteResult> {
    const t0 = Date.now(); const conns = this.conns; const passes = Math.max(1, this.opts.passes || 3); const ripUp = this.opts.ripUp !== false;
    const gOf = new Map(this.nets.map((n) => [n.key, n.guide])); const cmp = (x: number, y: number) => x === y ? 0 : x < y ? -1 : 1;
    // Short hops first (decoupling, crystals).  Then a fine-pitch chip is fanned out, the longest connection first:
    // its pins leave side by side, and the one that travels furthest must turn away first for the others to nest
    // inside it.  Everything else follows, shortest first.
    const tier = (c: Conn) => c.len < 3 ? 0 : Math.min(c.a.narrow || Infinity, c.b.narrow || Infinity) <= 0.35 ? 1 : 2;
    const order = conns.slice().sort((a, b) => cmp(gOf.get(a.net)!.rank, gOf.get(b.net)!.rank) || gOf.get(b.net)!.priority - gOf.get(a.net)!.priority || tier(a) - tier(b) || (tier(a) === 1 ? b.len - a.len : a.len - b.len) || (a.net < b.net ? -1 : a.net > b.net ? 1 : a.id - b.id));
    let best: { score: number; snap: (Pick<Conn, "cls" | "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd">)[] } | null = null; let failedLast = new Set<number>(); let pass = 0;
    const RC = (this.opts as any).connRips || 4, RB = (this.opts as any).blockerRips || 3;
    const timeUp = () => this.stopped || (!!this.opts.timeMs && Date.now() - t0 > this.opts.timeMs);
    for (; pass < passes; pass++) {
      for (const c of conns) if (c.nodes) this.rip(c);
      for (const c of conns) c.rips = 0;
      const queue = pass === 0 ? order.slice() : order.filter((c) => failedLast.has(c.id)).concat(order.filter((c) => !failedLast.has(c.id)));
      const failed = new Set<number>(); let done = 0;
      while (queue.length) {
        if (timeUp()) { for (const c of queue) { failed.add(c.id); if (!c.nodes) c.why = "budget"; } break; }
        const c = queue.shift()!; if (c.nodes) continue; c.why = undefined;
        let found = this.find(c, false);
        if (!found && ripUp && c.rips < RC) {
          const soft = this.find(c, true);
          if (!soft) this.stat.noSoft++;
          if (soft) {
            const bl = this.blockers(c, soft.res);
            this.stat[!bl.length ? "noBlockers" : bl.length > 14 ? "tooMany" : bl.every((b) => b.rips < RB) ? "ripped" : "ripLimit"]++;
            if (bl.length && bl.length <= 14 && bl.every((b) => b.rips < RB)) {
              const ripped: Conn[] = []; for (const b of bl) { b.rips++; this.rip(b, ripped); }
              c.rips++;
              if (this.fits(c, soft.res)) { found = soft; for (const r of ripped) { failed.delete(r.id); queue.unshift(r); } }
              else { found = this.find(c, false); for (const r of ripped) { failed.delete(r.id); queue.unshift(r); } }
            }
          }
        }
        if (found) { this.commit(c, found); failed.delete(c.id); } else failed.add(c.id);
        done++;
        yield { done: Math.min(done, conns.length), total: conns.length, routed: conns.filter((x) => x.nodes).length, pass, net: c.net };
      }
      const routed = conns.filter((x) => x.nodes); const cost = routed.reduce((s, c) => s + costOf(c.feat!, this.W), 0);
      const score = routed.length * 1e6 - cost;
      if (!best || score > best.score) best = { score, snap: conns.map((c) => ({ cls: c.cls, nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd })) };
      failedLast = failed;
      if (!failed.size || timeUp()) { pass++; break; }
    }
    if (best) {   // the maps follow the routes that are kept, so the board can still be questioned afterwards
      for (const c of conns) if (c.nodes) this.place(c, -1);
      conns.forEach((c, i) => Object.assign(c, best!.snap[i]));
      for (const c of conns) if (c.nodes) this.place(c, 1);
    }
    if (this.opts.zones !== false && !this.stopped) this.stitch(timeUp);
    if (ripUp && !this.stopped) { this.repair(timeUp); if (this.opts.zones !== false) this.stitch(timeUp); }
    this.widen();
    this.validate();
    if (this.opts.explain !== false) this.explain();
    this.ms = Date.now() - t0; this.passes = pass;
    return this.result();
  }

  /**
   * What the passes left open, one connection at a time: take out the routes in its way, lay it, lay those again
   * around it.  Kept only when nothing else is lost, so every step is a gain.
   */
  repair(timeUp: () => boolean): void {
    const conns = this.conns; type Snap = Pick<Conn, "cls" | "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd">;
    const snapOf = (): Snap[] => conns.map((c) => ({ cls: c.cls, nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd }));
    const back = (snap: Snap[]) => { for (const c of conns) if (c.nodes !== snap[c.id].nodes && c.nodes) this.place(c, -1); conns.forEach((c, i) => { if (c.nodes !== snap[i].nodes) { Object.assign(c, snap[i]); if (c.nodes) this.place(c, 1); } }); };
    const lay = (c: Conn): boolean => { const f = this.find(c, false); if (f) this.commit(c, f); return !!f; };
    // lay c whatever it takes: routes in its way come out and are laid again the same way, a few levels deep;
    // a route laid in this attempt is never taken out again
    const force = (c: Conn, depth: number, keep: Set<Conn>): boolean => {
      if (lay(c)) { keep.add(c); return true; } if (depth <= 0 || timeUp()) return false;
      const soft = this.find(c, true); if (!soft) return false; const bl = this.blockers(c, soft.res); if (!bl.length || bl.length > 12 || bl.some((b) => keep.has(b))) return false;
      const ripped: Conn[] = []; for (const b of bl) this.rip(b, ripped); if (ripped.some((r) => keep.has(r))) return false;
      if (this.fits(c, soft.res)) this.commit(c, soft); else if (!lay(c)) return false; keep.add(c);
      ripped.sort((a, b) => a.len - b.len); for (const r of ripped) if (!r.nodes && !force(r, depth - 1, keep)) return false;
      return true;
    };
    for (let round = 0; round < 3; round++) {
      const open = conns.filter((c) => !c.nodes && c.why !== "budget"); if (!open.length) return; let gained = false;
      for (const c of open) {
        if (timeUp()) return; if (c.nodes) continue; const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
        if (force(c, 3, new Set()) && conns.filter((x) => x.nodes).length > n0) gained = true; else back(snap);
      }
      if (!gained) break;
    }
    // Last resort for what is still open: the narrowest track the board allows gets through gaps the class width
    // does not.  Narrower than the net class asks for, never narrower than the design rules permit.
    const floor = Math.max(this.s.minTrackWidth || 0, 0.1);
    for (const c of conns) {
      if (c.nodes || c.why === "budget" || timeUp() || c.cls.width <= floor + 1e-6) continue;
      const known = new Set(this.G.classes.keys()); const wide = c.cls; const thin = this.classFor(c.net, floor);
      if (!known.has(thin.key)) for (const o of conns) if (o.nodes) for (const sh of o.shapes) stampClass(this.G, thin, sh, 1, false);
      c.cls = thin; const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
      if (!(force(c, 3, new Set()) && conns.filter((x) => x.nodes).length > n0)) { c.cls = wide; back(snap); }
    }
  }
  // ------------------------------------------------------------------ copper pours
  /** How a net's pour really falls once it is filled: the pour is cut into pieces by the other nets' copper, and a pad
   *  or a track end that sits in a piece is joined only to what else sits in that piece.  Returns which of the net's
   *  original islands end up joined (through pour pieces and this run's tracks), and the pieces of the main body. */
  private pourState(net: NetInfo): { root: (g: number) => number; main: number; cells: Node[]; connRoot: (c: Conn) => number } | null {
    const G = this.G, W = G.W, H = G.H, pour = net.pour!; const nc = net.cls;
    const key = `pour/${pour.width}/${pour.clr}`; let cls = G.classes.get(key);
    if (!cls) { cls = buildClass(G, key, pour.width, pour.clr, nc.viaD, nc.viaDrill); for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, cls, sh, 1, false); }
    const label: (Int32Array | null)[] = pour.mask.map(() => null); let pieces = 0;
    this.lift(net, 1, cls);
    try {
      for (let l = 0; l < pour.mask.length; l++) {
        const mask = pour.mask[l]; if (!mask) continue; const free = cls.full[l]; const lab = label[l] = new Int32Array(W * H); const stack: number[] = [];
        for (let i0 = 0; i0 < W * H; i0++) {
          if (!mask[i0] || free[i0] || lab[i0]) continue; lab[i0] = ++pieces; stack.push(i0);
          while (stack.length) { const i = stack.pop()!; const x = i % W;
            for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && mask[j] && !free[j] && !lab[j]) { lab[j] = pieces; stack.push(j); } }
        }
      }
    } finally { this.lift(net, -1, cls); }
    const anchors = net.anchors || []; let ng = 0; for (const a of anchors) ng = Math.max(ng, (a.grp || 0) + 1);
    const routed = net.conns.filter((c) => c.nodes); const parent = Array.from({ length: ng + pieces + 1 + routed.length }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }; const join = (a: number, b: number) => { parent[find(a)] = find(b); };
    const at = (l: number, ix: number, iy: number) => { const lab = label[l]; return lab && ix >= 0 && iy >= 0 && ix < W && iy < H ? lab[iy * W + ix] : 0; };
    for (const a of anchors) {   // a pad joins the piece its copper lies in
      const sh = a.shape as any; const r = sh ? (sh.t === "circle" ? sh.r : Math.min(sh.w || 0, sh.h || 0) / 2 || sh.r || 0) : 0; const n = Math.max(0, Math.floor(r / G.g));
      const cx = Math.round((a.p[0] - G.ox) / G.g), cy = Math.round((a.p[1] - G.oy) / G.g);
      for (const l of a.layers) for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) { if (dx * dx + dy * dy > n * n) continue; const id = at(l, cx + dx, cy + dy); if (id) join(a.grp || 0, ng + id); }
    }
    const node = new Map<Conn, number>(); routed.forEach((c, i) => node.set(c, ng + pieces + 1 + i)); const owner = new Map<number, number>();
    for (const c of routed) {
      const me = node.get(c)!; const first = this.mm(c.nodes![0]), last = this.mm(c.nodes![c.nodes!.length - 1]);
      for (const e of c.ends || [c.a, c.b]) if (c.stubs.some((st) => st[0] === e.p) || [first, last].some((q) => Math.hypot(q[0] - e.p[0], q[1] - e.p[1]) < 1e-3)) join(me, e.grp || 0);
      if (c.landed >= 0 && node.has(this.conns[c.landed])) join(me, node.get(this.conns[c.landed])!);
      const cells: Node[] = []; this.cellsOf(c, cells, owner); for (const n of c.nodes!) cells.push(n);
      for (const n of cells) { const id = at(n.l, n.ix, n.iy); if (id) join(me, ng + id); }
      for (const gi of c.viaCells) for (let l = 0; l < label.length; l++) { const id = at(l, gi % W, (gi / W) | 0); if (id) join(me, ng + id); }
    }
    const count = new Map<number, number>(); const hasPiece = new Set<number>(); for (let i = 1; i <= pieces; i++) hasPiece.add(find(ng + i));
    for (const a of anchors) { const r = find(a.grp || 0); count.set(r, (count.get(r) || 0) + 1); }
    let main = -1; for (const [r, n] of count) if (hasPiece.has(r) && (main < 0 || n > count.get(main)!)) main = r;
    if (main < 0) return null;
    const cells: Node[] = []; for (let l = 0; l < label.length; l++) { const lab = label[l]; if (!lab || !G.routable[l]) continue; for (let i = 0; i < W * H; i++) if (lab[i] && find(ng + lab[i]) === main) cells.push({ ix: i % W, iy: (i / W) | 0, l }); }
    return { root: (g) => find(g), main, cells, connRoot: (c) => node.has(c) ? find(node.get(c)!) : -1 };
  }
  /** Tracks cut a pour into pieces.  Whatever the pour was counted on to join but that ends up in a cut-off piece is
   *  joined to the main body with a track of its own; a route that ended in a cut-off piece is taken out again. */
  stitch(timeUp: () => boolean): void {
    if ((this.opts as any).stitch === false) return;
    for (const net of this.nets) {
      if (!net.pour || !net.anchors) continue;
      for (let round = 0; round < 4 && !timeUp(); round++) {
        let st = this.pourState(net); if (!st) break;
        let dead = false; for (const c of net.conns) if (c.nodes && c.zoneEnd && st.connRoot(c) !== st.main) { this.rip(c); dead = true; this.stat.deadEnds = (this.stat.deadEnds || 0) + 1; }
        if (dead) { st = this.pourState(net); if (!st) break; }
        // the islands as they really are
        const idx = new Map<number, number>(); const of = (a: Anchor) => { const r = st!.root(a.grp || 0); let i = idx.get(r); if (i === undefined) idx.set(r, i = idx.size); return i; };
        of(net.anchors.find((a) => st!.root(a.grp || 0) === st!.main)!);
        for (const a of net.anchors) a.cluster = of(a);
        net.clusters = idx.size; net.zoneCluster = 0; net.zoneCells = st.cells;
        for (const c of net.conns) if (c.nodes && c.a.cluster !== c.b.cluster) {   // it joined something other than the pad it set out for
          if (!c.ends) c.ends = [c.a, c.b]; const r = st.connRoot(c); if (st.root(c.a.grp || 0) === r) c.b = c.a; else c.a = c.b;
        }
        if (idx.size < 2) break;
        let gained = false;
        for (let k = 1; k < idx.size && !timeUp(); k++) {
          const comp = this.components(net); if (comp[k] === comp[0]) continue;
          let c = net.conns.find((x) => !x.nodes && ((x.a.cluster === k) !== (x.b.cluster === k)));
          if (!c) {
            let best: [number, Anchor, Anchor] | null = null;
            for (const a of net.anchors) if (a.cluster === k) for (const b of net.anchors) if (comp[b.cluster] === comp[0]) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (!best || d < best[0]) best = [d, a, b]; }
            if (!best) continue;
            c = { id: this.conns.length, net: net.key, cls: this.classFor(net.key, Math.min(this.roomAt(best[1], net.key), this.roomAt(best[2], net.key))), a: best[1], b: best[2], len: best[0], nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false, stitch: true };
            this.conns.push(c); net.conns.push(c);
          }
          c.why = undefined; const found = this.find(c, false); if (found) { this.commit(c, found); gained = true; this.stat.stitched = (this.stat.stitched || 0) + 1; } else this.stat.stitchFailed = (this.stat.stitchFailed || 0) + 1;
        }
        // a connection that was never laid but whose ends are joined after all (through the pour, or another track) is settled
        const comp = this.components(net); for (const c of net.conns) c.moot = !c.nodes && comp[c.a.cluster] === comp[c.b.cluster];
        if (!gained) break;
      }
    }
  }
  /** Supply tracks are routed at the class width, so they never cost a connection, and then fattened piece by
   *  piece wherever the exact clearances leave the room — wide along the run, necked down at tight pads. */
  widen(): void {
    for (const c of this.conns) {
      if (!c.nodes) continue; const want = this.powerWidth(c.net); if (!(want > c.cls.width + 1e-6)) continue;
      this.place(c, -1); this.cur = c; this.curSoft = false;
      for (const o of c.shapes) {
        const sh = o.shape as any; if (sh.t !== "seg") continue; const r0 = sh.r;
        for (const w of [want, (want + c.cls.width) / 2]) { sh.r = w / 2; if (this.clearOf(sh, o.layers[0], c.net, c.cls.clr)) break; sh.r = r0; }
      }
      this.place(c, 1);
    }
  }
  /** The exact check: every new track and via against the real shapes, at the real clearances.  Offenders are dropped. */
  validate(): void {
    const G = this.G, P = this.P; const B = 2; const idx = new Map<string, { o: Obstacle; bb: number[]; conn: number }[]>();
    const bbOf = (s: Shape): number[] => { if (s.t === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]; if (s.t === "seg") return [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const pts: Pt[] = s.pts || [[s.x - Math.hypot(s.w, s.h) / 2, s.y - Math.hypot(s.w, s.h) / 2], [s.x + Math.hypot(s.w, s.h) / 2, s.y + Math.hypot(s.w, s.h) / 2]]; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } const o = s.r || 0; return [x0 - o, y0 - o, x1 + o, y1 + o]; };
    const add = (o: Obstacle, conn: number) => { const bb = bbOf(o.shape); const e = { o, bb, conn }; for (let y = Math.floor(bb[1] / B); y <= Math.floor(bb[3] / B); y++) for (let x = Math.floor(bb[0] / B); x <= Math.floor(bb[2] / B); x++) { const k = x + "," + y; let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(e); } };
    for (const list of G.obstacles.values()) for (const o of list) { if (o.shape.t === "path" && o.shape.pts.length > 2) { for (let i = 0; i + 1 < o.shape.pts.length; i++) add({ net: o.net, layers: o.layers, clr: o.clr, edge: o.edge, shape: { t: "seg", a: o.shape.pts[i], b: o.shape.pts[i + 1], r: o.shape.r || 0 } }, -1); } else add(o, -1); }
    const bad = new Set<number>(); const maxClr = Math.max(G.edgeClr, ...Array.from(G.classes.values()).map((c) => c.clr), this.s.clearance);
    for (const c of this.conns) {
      if (!c.nodes) continue;
      for (const o of c.shapes) {
        const bb = bbOf(o.shape); const seen = new Set<any>();
        for (let y = Math.floor((bb[1] - maxClr) / B); y <= Math.floor((bb[3] + maxClr) / B) && !bad.has(c.id); y++) for (let x = Math.floor((bb[0] - maxClr) / B); x <= Math.floor((bb[2] + maxClr) / B) && !bad.has(c.id); x++) {
          for (const e of idx.get(x + "," + y) || []) {
            if (seen.has(e) || e.conn === c.id) continue; seen.add(e);
            if (e.o.net && e.o.net === o.net) continue; if (!e.o.layers.some((l) => o.layers.includes(l))) continue;
            const need = (e.o.edge ? G.edgeClr : Math.max(e.o.clr, o.clr)) - 1e-4;
            if (e.bb[0] > bb[2] + need || e.bb[2] < bb[0] - need || e.bb[1] > bb[3] + need || e.bb[3] < bb[1] - need) continue;
            const gap = P.shapeGap(e.o.shape, o.shape); if (gap < need) { bad.add(c.id); c.why = "rule"; this.ruleHit.set(c.id, e.o.net); this.dropped.push({ net: c.net, other: e.o.net, gap, need, shape: o.shape, against: e.o.shape, stub: c.stubs.some((st) => st[0] === o.shape.a) }); break; }
          }
        }
        if (bad.has(c.id)) break;
      }
      if (!bad.has(c.id)) for (const o of c.shapes) add(o, c.id);
    }
    const kill = (id: number) => { const c = this.conns[id]; if (!c.nodes) return; this.place(c, -1); c.nodes = null; c.shapes = []; c.viaCells = []; c.stubs = []; if (!c.why) c.why = "rule"; for (const d of this.conns) if (d.nodes && d.landed === id) kill(d.id); };
    for (const id of bad) kill(id);
  }

  ruleHit = new Map<number, string>(); reports = new Map<number, Partial<ConnReport>>();
  /** Why each connection that is still open failed: what is in its way, or that there is no way at all. */
  explain(): void {
    for (const c of this.conns) {
      if (c.nodes || c.moot) continue; const rep: Partial<ConnReport> = {}; this.reports.set(c.id, rep);
      if (c.why === "budget") { rep.reason = "budget"; rep.detail = "the run stopped before this connection was tried"; continue; }
      if (c.why === "rule") { rep.reason = "rule"; const o = this.ruleHit.get(c.id); rep.blockedBy = { nets: o ? [o] : [], items: [] }; rep.detail = "the route found did not keep its clearance in the exact check"; continue; }
      const net = this.netOf(c.net); let ends: boolean[] = []; const gd = net.guide;
      this.lift(net, 1, c.cls); this.cur = c; this.curSoft = true; try { ends = [c.a, c.b].map((e) => !!this.access(e, c.cls.fixed)); } finally { this.lift(net, -1, c.cls); }
      const soft = this.find(c, true);
      if (!soft && (!ends[0] || !ends[1])) {   // is it the rules themselves that close the pad in?
        const e = !ends[0] ? c.a : c.b; const why = { net: "", gap: 0, need: 0 }; let shut = !!e.axis;
        if (e.axis) for (const sgn of [1, -1]) for (const l of e.layers) if (this.G.routable[l]) { this.cur = c; this.curSoft = true; if (this.clearOf({ t: "seg", a: e.p, b: [e.p[0] + e.axis[0] * 0.3 * sgn, e.p[1] + e.axis[1] * 0.3 * sgn], r: c.cls.width / 2 }, l, c.net, c.cls.clr, why)) shut = false; }
        if (shut && why.need) { rep.reason = "rule"; rep.blockedBy = { nets: why.net ? [why.net] : [], items: [] }; rep.detail = `a ${c.cls.width} mm track cannot leave ${this.padName(e.p)}: it would pass ${why.gap.toFixed(3)} mm from ${why.net || "its neighbour"} where ${why.need.toFixed(3)} mm is required — relax that clearance or the minimum track width`; continue; }
      }
      if (!soft) { rep.reason = "no-room"; rep.detail = !ends[0] || !ends[1] ? `no free way out of ${this.padName(!ends[0] ? c.a.p : c.b.p)}` : "no path past the copper, holes, keep-outs and edges already on the board" + (gd.allowed || gd.avoid.length || gd.maxVias < Infinity || !gd.allowVias ? " within the plan's limits for this net" : ""); continue; }
      const bl = this.blockers(c, soft.res); rep.reason = "blocked"; rep.blockedBy = { nets: Array.from(new Set(bl.map((b) => b.net))), items: [] };
      rep.detail = bl.length ? "routes laid earlier in this run are in the way" : "too tight for a track of this width between the routes laid earlier";
    }
  }
  private padName(p: Pt): string { return this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)) || `(${r6(p[0])}, ${r6(p[1])})`; }
  ms = 0; passes = 0;
  result(): RouteResult {
    const ms = this.ms, passes = this.passes;
    const { P, doc, G } = this; const items: RouteItem[] = []; let segments = 0, vias = 0, length = 0, zoneEnds = 0; const failed: RouteResult["failed"] = [];
    const span = [G.layers[0], G.layers[G.layers.length - 1]];
    const connections: ConnReport[] = []; const end = (p: Pt) => { const pad = this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)); return pad ? { x: r6(p[0]), y: r6(p[1]), pad } : { x: r6(p[0]), y: r6(p[1]) }; };
    for (const c of this.conns) {
      if (c.moot && !c.nodes) continue;
      const ea = c.ends ? c.ends[0] : c.a, eb = c.ends ? c.ends[1] : c.b; const rep: ConnReport = { net: c.net, from: end(ea.p), to: end(eb.p), routed: !!c.nodes, length: 0, vias: 0, bends: 0, layers: [], detourRatio: 0 }; connections.push(rep);
      if (!c.nodes) { failed.push({ net: c.net, a: ea.p, b: eb.p }); Object.assign(rep, this.reports.get(c.id) || {}); continue; }
      { let len = 0; const ls = new Set<number>(); for (const [a, b, l] of c.stubs) { len += Math.hypot(a[0] - b[0], a[1] - b[1]); ls.add(l); }
        for (let i = 0; i + 1 < c.nodes.length; i++) { const a = c.nodes[i], b = c.nodes[i + 1]; if (a.l === b.l) { len += Math.hypot(b.ix - a.ix, b.iy - a.iy) * G.g; ls.add(a.l); } }
        rep.length = +len.toFixed(3); rep.vias = c.viaCells.length; rep.bends = c.feat ? c.feat.b45 + c.feat.b90 : 0; rep.layers = Array.from(ls).sort().map((l) => G.layers[l]); rep.detourRatio = c.len > 1e-6 ? +(len / c.len).toFixed(2) : 1; }
      const net = this.netOf(c.net).obj; if (c.zoneEnd) zoneEnds++;
      const seg = (a: Pt, b: Pt, l: number, w: number) => { if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return; items.push({ kind: "segment", node: P.segmentNode(doc, a, b, w, G.layers[l], net), net, netName: c.net, conn: c.id }); segments++; length += Math.hypot(a[0] - b[0], a[1] - b[1]); };
      for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") seg(sh.a, sh.b, o.layers[0], +(sh.r * 2).toFixed(4)); }   // stubs and runs, each at its own width
      for (const gi of c.viaCells) { const p = this.mm({ ix: gi % G.W, iy: (gi / G.W) | 0 }); items.push({ kind: "via", node: P.viaNode(doc, p[0], p[1], c.cls.viaD, c.cls.viaDrill, net, span), net, netName: c.net, conn: c.id }); vias++; }
    }
    const total = this.conns.filter((c) => c.nodes || !c.moot).length;
    return { items, total, routed: total - failed.length, failed, segments, vias, length, ms, passes, zoneEnds, zoneCovered: this.zoneCovered,
      grid: { pitch: G.g, w: G.W, h: G.H, layers: G.layers.filter((_, i) => G.routable[i]) }, nets: this.nets.length, connections };
  }
}

/** A footprint's reference designator. */
export function refOf(K: any, node: any): string {
  const p = K.kids(node, "property").find((q: any) => K.str(q[1]) === "Reference"); if (p) return K.str(p[2]);
  const t = K.kids(node, "fp_text").find((q: any) => K.str(q[1]) === "reference"); return t ? K.str(t[2]) : "";
}
/** The direction a pad's long side runs in, on the board. */
function padAxis(pad: any): Pt {
  const r = (pad.rot || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const lx = pad.w >= pad.h ? 1 : 0, ly = pad.w >= pad.h ? 0 : 1;
  return [lx * c + ly * s, -lx * s + ly * c];
}
function pointInPolyPts(pts: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
/** Drop repeated points and the middle point of straight runs. */
export function simplify(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    const a = out[out.length - 1]; if (a && a.ix === n.ix && a.iy === n.iy && a.l === n.l) continue;
    const b = out[out.length - 2];
    if (a && b && a.l === n.l && b.l === a.l && dirOf(a.ix - b.ix, a.iy - b.iy) === dirOf(n.ix - a.ix, n.iy - a.iy) && (a.ix !== b.ix || a.iy !== b.iy)) { out[out.length - 1] = n; continue; }
    out.push(n);
  }
  return out;
}
export { DX, DY };

/** Route a board in one go (the editor drives Router.run() in slices instead, to stay responsive). */
export function route(K: any, P: any, doc: any, settings: any, opts?: RouteOptions): RouteResult {
  const r = new Router(K, P, doc, settings, opts); const it = r.run(); let s = it.next(); while (!s.done) s = it.next(); return s.value;
}
