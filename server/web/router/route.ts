// Autorouter — the run: what to connect, in which order, with rip-up and retry, and the tracks and vias that
// come out.  Pure: reads a parsed board and the design rules, returns item nodes; nothing is written to the board
// here (the caller commits them as ordinary edits).
import { buildClass, DX, DY, fillPoly, Grid, Obstacle, pickGrid, pointGap, Pt, RuleClass, Shape, stamp, stampClass, viaFits } from "./grid";
import { costOf, dirOf, Features, featuresOf, Node, probe, ProbeResult, Terminal, Win } from "./probe";
import { TRAINED, Weights } from "./weights";
import { stackupOf, traceOn, usualImpedance, widthFor, z0, zdiff } from "./impedance";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A supply net by its name: ground, a rail voltage, or one of the usual rail names. */
export const isSupply = (net: string): boolean => /^\/?(.*\/)?(A|D|P)?(GND|VSS|VEE)\w*$|^\/?(.*\/)?[+-]?\d+(V\d*|\.\d+V)\w*$|^\/?(.*\/)?(VCC|VDD|VBUS|VBAT|VIN|VSYS|VPP|VAA|VREF|VOUT|V\d+V\d*|PWR|\+BATT|-BATT)\w*$/i.test(net) && !/(_|\b)(EN|SENSE|SNS|FB|PG|OK|DET|MON|ADC)\w*$/i.test(net);
/** What a net carries, as far as its neighbours are concerned. */
export type NetKind = "analog" | "rf" | "switching" | "fast" | "digital" | "supply";
/** A net's kind from its name.  Analog: ADC and DAC inputs, references, audio, sense and feedback lines, crystals.
 *  RF: antenna and RF feeds.  Switching: a converter's switch node, bootstrap and gate drives.  Fast: clocks and
 *  differential pairs.  Supply: rails and ground.  Everything else is digital, and so is a general-purpose pin
 *  (GPIO26_ADC0), whatever its second function.  A net KiCad named after a pin
 *  (Net-(U3-SW)) is judged by the pin's name. */
export function netKind(net: string, paired = /(\+|-|_P|_N)\)?$/.test(net)): NetKind {
  if (isSupply(net)) return "supply";
  const m = /^Net-\((.+)-([^-]+)\)$/.exec(net); const n = m ? m[2] : net.replace(/^.*\//, ""); const auto = !!m;
  if (auto && /^(Pad)?\d+$/i.test(n)) return "digital";
  if (/^(GPIO|GP|IO|P[A-Z]?)_?\d+([_.\-]|$)/i.test(n)) return "digital";   // a general-purpose pin broken out, whatever else it can do
  if (usualImpedance(net, false) || /^(ANT\d*|RF\w*|ANTENNA)$/i.test(n) || (m && /^(AE|ANT)\d+$/i.test(m[1]))) return "rf";
  if (/(^|[_\-.])(SW|LX|PHASE|PH|BST|SWN|GATE|HG|LG|HDRV|LDRV|UGATE|LGATE)\d*([_\-.]|$)/i.test(n) && !/SW(D|O|CLK|DIO)/i.test(n) && (auto || !/^SW\d+$/i.test(n))) return "switching";
  if (auto && /^(BOOT|CB|BS)$/i.test(n)) return "switching";
  if (/(^|[_\-.])(AIN|ADC|DAC|VREF|AREF|REF|MIC|AUDIO|AUD|LINE_?IN|LINE_?OUT|HP_?[LR]|SENSE|SNS|ISENSE|ISNS|VSENSE|THERM|NTC|XTAL|XIN|XOUT|XI|XO|XC|XL|OSC_?IN|OSC_?OUT|OSCI|OSCO|COMP|FB|VFB|ANALOG|ANA)[A-Z]?\d*([_\-.+]|$)/i.test(n)) return "analog";
  if ((paired && pairName(net)) || /(CLK|SCK|LRCK|CLOCK)\d*(_\w+)?$/i.test(n) || /(^|[_\-.])CK\d*$/i.test(n)) return "fast";
  return "digital";
}
/** Which nets were kept apart, and where that had to give. */
export interface DomainReport { kinds: Record<string, NetKind>; quiet: number; noisy: number; relaxed: string[] }
/** Ground vias set beside a net's tracks (a fence) and beside its layer changes (return vias). */
export interface FenceReport { net: string; ground: string; fence: number; returns: number; spacing: number; note?: string }
/** The rim of the board: how far in from the edge it reaches, how much of a route may lie in it for nothing (the
 *  approach to an edge connector's pad), and what each further mm costs, in mm of ordinary track. */
const RIM_MM = 1.3, RIM_FREE_MM = 4, RIM_COST = 3;

export interface RouteOptions {
  /** true lets tracks run along the board edge at no extra cost (by default a long run in the rim is priced up). */
  edgeRuns?: boolean;
  /** Ground vias for high-frequency nets.  A fence: vias down both sides of every track of an RF net (and of the
   *  nets named in `nets`), `spacing` mm apart (default 2 mm, about a twentieth of a wavelength at 2.4 GHz on FR4),
   *  wherever the ground pour lies on two layers and the rules leave room.  Return vias: one ground via beside each
   *  layer change of an RF, clock or pair net, so the return current changes layer with the signal.  false turns
   *  both off.  Reported in `result.fences`. */
  fence?: boolean | { spacing?: number; nets?: string[]; returnVias?: boolean };
  /** Keep sensitive nets (analog, RF) away from the rest: `quiet` mm from ordinary digital tracks and `noisy` mm
   *  from switching nodes, clocks and pairs (defaults: twice and three times the board clearance, at least 0.3 and
   *  0.5 mm).  Pads are exempt, and so is the copper within `nearPads` mm of any pad (default 1.2): parts sit where
   *  they sit, and a fine-pitch fan-out has no room to give.  false turns it off.  A connection that cannot be made
   *  with the gap is made without it and named in `result.domains.relaxed`. */
  separate?: boolean | { quiet?: number; noisy?: number; nearPads?: number };
  nets?: string[] | null;        // only these nets (names); default every net with a missing connection
  layers?: string[] | null;      // copper layers tracks may use; default the signal layers
  allowVias?: boolean;           // default true
  ripUp?: boolean;               // default true
  passes?: number;               // whole-board attempts with a different order; default 3
  pitch?: number;                // force the grid pitch, mm
  weights?: Partial<Weights>;
  powerWidth?: number;           // track width for supply nets (GND, +3V3, VBUS …) that have no class of their own; 0 keeps the class width.  Default: twice the class width, 0.3 to 0.5 mm
  impedance?: boolean;           // size tracks for the impedance their nets call for (a plan's impedance, else by name: USB 90 Ω, HDMI/Ethernet 100 Ω, antenna feeds 50 Ω); default true
  matchLengths?: boolean;        // lengthen the shorter members of a matched group with serpentines; default true
  match?: { nets: string[]; tolerance?: number; length?: number }[];   // nets to bring to one length (the longest, or the length given), within the tolerance in mm (default 0.25)
  skewTolerance?: number;        // the most the two tracks of a pair may differ in length, mm; default 0.1
  maxAmplitude?: number;         // how far a serpentine may swing off its track, mm; default 3
  pairs?: boolean;               // route differential pairs (D+/D-, _P/_N, DP/DM …) side by side at a constant gap; default true
  pairGap?: number;              // the gap between a pair's tracks in mm; default the nets' clearance
  fewerVias?: boolean;
  /** the most vias any one connection (pad to pad) may use; a connection that cannot be made within it is left open and reported */
  maxViasPerConnection?: number;
  /** false keeps every via at its net class's size.  By default a connection that cannot be made with it may use
   *  the smallest via Board Setup's constraints permit. */
  smallVias?: boolean;           // after routing, lay each route that changes layer again without (or with fewer) vias where the finished board leaves room; default true
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
  impedance?: number;            // ohms: single-ended, or differential when the net is one of a pair
  allowVias?: boolean; maxVias?: number;
  avoid?: Box[];                 // areas this net stays out of
  priority?: number;             // higher routes earlier (after `order`)
  kind?: NetKind;                // what the net carries, when its name does not say (see netKind)
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
  nodes: Node[] | null; shapes: Obstacle[]; viaCells: number[]; landed: number; rips: number; feat: Features | null; stubs: [Pt, Pt, number][]; zoneEnd: boolean; ends?: [Anchor, Anchor]; stitch?: boolean; moot?: boolean; pair?: boolean;
  why?: string;
}
export interface RouteItem { kind: "segment" | "via"; node: any; net: any; netName: string; conn: number }
export interface RouteResult {
  items: RouteItem[]; total: number; routed: number; failed: { net: string; a: Pt; b: Pt }[];
  segments: number; vias: number; length: number; ms: number; passes: number; zoneEnds: number; zoneCovered: number; pairs?: PairReport[]; impedance?: ImpedanceReport[]; matched?: MatchReport[];
  grid: { pitch: number; w: number; h: number; layers: string[] }; nets: number;
  connections: ConnReport[]; domains?: DomainReport; fences?: FenceReport[];
}
export interface Progress { done: number; total: number; routed: number; pass: number; net: string }

export interface ImpedanceReport { nets: string[]; target: number; differential: boolean; layer: string; model: string; width: number | null; gap?: number; achieved?: number; applied: boolean; note?: string }
export interface MatchReport { group: string; target: number; tolerance: number; members: { nets: string[]; before: number; length: number; matched: boolean; note?: string }[] }
export interface PairReport { p: string; n: string; coupled: boolean; layer?: string; width?: number; gap?: number; lengthP?: number; lengthN?: number; skew?: number; reason?: string }
/** The two nets of a differential pair, by name: D+/D-, X_P/X_N, DP/DM, TXP/TXN. */
export function pairName(net: string): { base: string; pol: 1 | -1 } | null {
  const m = /^(.*?)(\+|-|_P|_N|DP|DM|P|N)(\)?)$/.exec(net); if (!m || !m[1] || isSupply(net) || /(^|[\/_(])V$/i.test(m[1])) return null;
  const t = m[2]; if ((t === "P" || t === "N") && !/[A-Z0-9]$/.test(m[1])) return null;
  return { base: m[1] + (t.length === 2 && t[0] === "D" ? "D" : "") + "~" + m[3], pol: t === "+" || t === "_P" || t === "DP" || t === "P" ? 1 : -1 };
}
interface Pair { p: NetInfo; n: NetInfo; cp: Conn; cn: Conn; swap: boolean; laid?: { c: Pt[]; l: number; w: number; d: number; clr: number; sgn: number; lead: Lead[] } }
interface Lead { e: Pt; s: number }   // each track first leaves its pad straight, this far, before it turns in to its partner
interface Guide { allowed: boolean[] | null; allowVias: boolean; maxVias: number; avoid: [number, number, number, number][]; rank: number; priority: number }
interface Found { res: ProbeResult; owner: Map<number, number>; flip: boolean; esc?: (Pt | undefined)[] }
interface NetInfo { key: string; obj: any; cls: RuleClass; conns: Conn[]; clusters: number; zoneCells: Node[] | null; zoneCluster: number; guide: Guide; anchors?: Anchor[]; pour?: { mask: (Uint8Array | null)[]; width: number; clr: number } }

const r6 = (v: number) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };

export class Router {
  G!: Grid; rim: Uint8Array | null = null; nets: NetInfo[] = []; conns: Conn[] = []; pref: number[] = []; W: Weights; allowVias: boolean; s: any;
  stopped = false; zoneCovered = 0; dropped: any[] = []; stat: Record<string, number> = { noSoft: 0, noBlockers: 0, tooMany: 0, ripped: 0, ripLimit: 0 };
  constructor(public K: any, public P: any, public doc: any, settings: any, public opts: RouteOptions = {}) {
    // the weights were fitted to how people route; a via is then charged double, because a board with few layer changes is what is asked for
    this.W = Object.assign({}, TRAINED, { via: TRAINED.via * 2 }, opts.weights || {}); this.allowVias = opts.allowVias !== false;
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
      push({ net: c.net || "", layers, shape: c.shape, clr: P.netClearance(s, c.net), pad: c.kind === "pad", thru: L > 1 && layers.length === L && (c.kind === "pad" || c.kind === "via") ? [c.anchors[0][0], c.anchors[0][1]] : undefined });
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
    if (this.fenceVias.length) { const g = this.fenceVias[0]; this.fenceVias = this.fenceVias.filter((v) => this.G.layers.every((_, l) => this.clearOf({ t: "circle", x: v.p[0], y: v.p[1], r: g.cls.viaD / 2 }, l, v.net, g.cls.clr))); }
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
    // The rim: cells within a header pitch of the board edge.  A track may reach a pad there, but a long run along
    // the edge (out past a pin row and down the side of the board) is priced so that a way through the board wins.
    { const r = Math.max(1, Math.round(RIM_MM / pg.g)); const out = G.outside; const rim = this.rim = new Uint8Array(W * H);
      const off = (ix: number, iy: number) => ix < 0 || iy < 0 || ix >= W || iy >= H || (out ? out[iy * W + ix] === 1 : false);
      let front: number[] = []; for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) { if (off(ix, iy)) continue; if (off(ix - 1, iy) || off(ix + 1, iy) || off(ix, iy - 1) || off(ix, iy + 1)) { rim[iy * W + ix] = 1; front.push(iy * W + ix); } }
      for (let d = 1; d < r && front.length; d++) { const next: number[] = []; for (const i of front) { const ix = i % W, iy = (i - ix) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = ix + dx, y = iy + dy; if (off(x, y)) continue; const j = y * W + x; if (!rim[j]) { rim[j] = 1; next.push(j); } } } front = next; } }
    for (const sh of smd) stamp(G, G.noVia, sh, 0, 1);
    // rule areas
    const zoneLayers = (n: any): number[] => { const l = K.kid(n, "layer"), ls = K.kid(n, "layers"); const names: string[] = l ? [K.str(l[1])] : ls ? ls.slice(1).map(K.str) : []; const out = new Set<number>(); for (const nm of names) { if (nm === "*.Cu" || nm === "F&B.Cu") all.forEach((i) => out.add(i)); else { const i = copper.indexOf(nm); if (i >= 0) out.add(i); } } return Array.from(out); };
    // A zone's outline may carry holes as further polygons: inside means inside an odd number of them.
    const zones: { net: string; layers: number[]; polys: Pt[][]; clr: number; minW: number }[] = [];
    const cellsIn = (polys: Pt[][]): Uint8Array => { const t = new Uint8Array(W * H); for (const pts of polys) fillPoly(G, pts, (x0, x1, iy) => { for (let i = iy * W + x0; i <= iy * W + x1; i++) t[i] ^= 1; }); return t; };
    const ncs = Object.values(s.netclasses || {}) as { track_width?: number; via_diameter?: number }[];
    const maxTrack = Math.max(s.trackWidth || 0, ...ncs.map((c) => c.track_width || 0)), maxVia = Math.max(s.viaDiameter || 0, ...ncs.map((c) => c.via_diameter || 0));
    const band = (polys: Pt[][], inside: Uint8Array, r: number): Uint8Array => {
      const t = inside.slice(); if (!(r > 0)) return t;
      for (const pts of polys) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        const ix0 = Math.max(0, Math.floor((x0 - r - G.ox) / G.g)), ix1 = Math.min(W - 1, Math.ceil((x1 + r - G.ox) / G.g)), iy0 = Math.max(0, Math.floor((y0 - r - G.oy) / G.g)), iy1 = Math.min(H - 1, Math.ceil((y1 + r - G.oy) / G.g));
        for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
          const i = iy * W + ix; if (t[i]) continue; const x = G.ox + ix * G.g, y = G.oy + iy * G.g;
          for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
            const a = pts[j], b = pts[k], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
            if (Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy) < r - 1e-6) { t[i] = 1; break; }
          }
        }
      }
      return t;
    };
    for (const it of doc.items.values()) {
      if (it.kind !== "zone") continue; const n = it.node; const polys: Pt[][] = K.kids(n, "polygon").map((poly: any) => K.ptsOf(poly) as Pt[]).filter((pts: Pt[]) => pts.length >= 3); if (!polys.length) continue;
      const ko = K.kid(n, "keepout"); const layers = zoneLayers(n);
      if (ko) {
        const no = (k: string) => { const c = K.kid(ko, k); return !!c && K.str(c[1]) === "not_allowed"; };
        if (!no("tracks") && !no("vias")) continue; const t = cellsIn(polys);
        // a track or via whose centre sits on the area's edge still reaches into it by its half width (the DRC's
        // DRC_TEST_PROVIDER_DISALLOW): the band within the widest half width of the edge is kept out too
        const tt = band(polys, t, maxTrack / 2), tv = band(polys, t, maxVia / 2);
        if (no("tracks")) for (const l of layers) { const m = G.keep[l] || (G.keep[l] = new Uint8Array(W * H)); for (let i = 0; i < tt.length; i++) if (tt[i]) m[i] = 1; }
        if (no("vias")) for (let i = 0; i < tv.length; i++) if (tv[i]) G.noVia[i]++;
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
    this.sizeForImpedance(Array.from(nl.nets.values() as Iterable<any>).map((n: any) => n.key).filter((k: string) => k && (!want || want.has(k))));
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
          for (const z of mine) { const t = cellsIn(z.polys); for (const l of z.layers) { const m = pour.mask[l] || (pour.mask[l] = new Uint8Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) { m[i] = 1; zoneCells.push({ ix: i % W, iy: (i / W) | 0, l }); } } }
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
  classFor(netKey: string, cap = Infinity, want = 0, smallVia = false): RuleClass {
    const { P, s, G } = this; const nc = P.netclassOf(s, netKey); const plan = (this.opts.netOpts || {})[netKey]; const pw = plan && +plan.width! > 0 ? +plan.width! : 0;
    const zw = pw ? 0 : (this.zWidth.get(netKey) || 0);   // a plan's own width stands; else the width its impedance asks for
    let width = Math.max(pw || zw || Math.max(nc.track_width !== undefined ? nc.track_width : s.trackWidth, want), s.minTrackWidth || 0);
    // A fine-pitch pad only has room for so wide a track between its neighbours: a connection that ends on one
    // runs as wide as that room allows, as people neck tracks down at such pads.
    if (cap < width) width = Math.max(s.minTrackWidth || 0.1, 0.1, Math.floor(cap * 100 + 1e-6) / 100);
    const clr = Math.max(P.netClearance(s, netKey), s.minClearance || 0); const viaD0 = Math.max(nc.via_diameter !== undefined ? nc.via_diameter : s.viaDiameter, s.minViaDiameter || 0);
    let viaD = viaD0, viaDrill = Math.max(nc.via_drill !== undefined ? nc.via_drill : s.viaDrill, s.minThroughDrill || 0);
    // The smallest via Board Setup permits, for a connection the class's own via cannot serve (a ball in a grid
    // array has no room for it).  Only when the board states its minimums; the hole keeps its annular ring.
    if (smallVia && s.minViaDiameter > 0 && s.minThroughDrill > 0 && s.minViaDiameter < viaD0 - 1e-6) { const d = Math.max(s.minViaDiameter, s.minThroughDrill + 2 * (s.minViaAnnular || 0.05)); if (d < viaD0 - 1e-6) { viaD = d; viaDrill = Math.min(viaDrill, s.minThroughDrill); } }
    const kind = this.relax ? undefined : this.kindFor(netKey);
    const key = `${width}/${clr}/${viaD}/${viaDrill}` + (kind ? "/" + kind : ""); let c = G.classes.get(key);
    if (!c) { c = buildClass(G, key, width, clr, viaD, viaDrill, kind); if (this.conns.length) for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, c, sh, 1, false); }
    return c;
  }
  relax = false; relaxed = new Set<string>(); pairNets = new Set<string>(); private kindMemo = new Map<string, NetKind>(); private domains: boolean | null = null;
  /** The net's kind, as planned or by name. */
  kindOf(netKey: string): NetKind { let k = this.kindMemo.get(netKey); if (!k) { const plan = (this.opts.netOpts || {})[netKey]; k = (plan && plan.kind) || netKind(netKey, this.pairNets.has(netKey) || undefined); this.kindMemo.set(netKey, k); } return k; }
  /** The kind a net's rule class carries: none when the board has nothing sensitive on it (or separation is off),
   *  and none for supply nets, which every domain shares. */
  private kindFor(netKey: string): string | undefined {
    const G = this.G;
    if (this.domains === null) {
      const names = new Set<string>([...G.obstacles.keys(), ...Object.keys(this.opts.netOpts || {})]); names.delete("");
      { const by = new Map<string, string[]>(); for (const n of names) { const k = pairName(n); if (k) { const e = by.get(k.base) || []; by.set(k.base, e); e[k.pol > 0 ? 0 : 1] = n; } } for (const e of by.values()) if (e[0] && e[1]) { this.pairNets.add(e[0]); this.pairNets.add(e[1]); } this.kindMemo.clear(); }
      this.domains = this.opts.separate !== false && Array.from(names).some((n) => { const k = this.kindOf(n); return k === "analog" || k === "rf"; });
      if (this.domains) {
        const o = typeof this.opts.separate === "object" ? this.opts.separate : {}; const base = Math.max(this.s.clearance || 0.2, this.s.minClearance || 0);
        const quiet = o.quiet !== undefined ? o.quiet : Math.max(2 * base, 0.3), noisy = o.noisy !== undefined ? o.noisy : Math.max(3 * base, 0.5); this.sepGaps = { quiet, noisy };
        const sens = (k: string) => k === "analog" || k === "rf", loud = (k: string) => k === "switching" || k === "fast";
        G.kinds = new Proxy(new Map<string, string>(), { get: (_t, prop) => prop === "get" ? (n: string) => { const k = this.kindOf(n); return k === "supply" ? undefined : k; } : undefined }) as any;
        { const near = G.nearPad = new Uint8Array(G.W * G.H); const reach = o.nearPads !== undefined ? o.nearPads : 1.2; for (const list of G.obstacles.values()) for (const ob of list) if (ob.pad) stamp(G, near as any, ob.shape, reach, 1); }
        G.sep = (a, b) => a === b || a === "supply" || b === "supply" ? 0 : sens(a) && sens(b) ? quiet : sens(a) ? (loud(b) ? noisy : quiet) : sens(b) ? (loud(a) ? noisy : quiet) : 0;
      }
    }
    if (!this.domains) return undefined; const k = this.kindOf(netKey); return k === "supply" ? undefined : k;
  }
  sepGaps = { quiet: 0, noisy: 0 };
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
  zWidth = new Map<string, number>(); zGap = new Map<string, number>(); zReports: ImpedanceReport[] = [];
  /** Work out, before anything is laid, the width (and for pairs the gap) each impedance-controlled net needs on
   *  this stackup.  A geometry the board cannot reasonably carry is reported and left at the class width. */
  private sizeForImpedance(keys: string[]): void {
    if (this.opts.impedance === false) return; const { K, P, s, doc, G } = this; const stack = stackupOf(K, doc);
    const outer = G.layers.find((_, l) => G.routable[l]) || G.layers[0]; const tr = traceOn(stack, outer); if (!tr) return;
    const model = `${tr.kind} on ${tr.layer} over ${tr.reference.join(" and ")}, ${+tr.h.toFixed(3)} mm of εr ${+tr.er.toFixed(2)}${stack.assumed ? " (stackup assumed: the board carries none)" : ""}`;
    const planned = (k: string) => +(((this.opts.netOpts || {})[k] || {}).impedance || 0);
    const by = new Map<string, { key: string }[]>(); const single: { key: string }[] = [];
    for (const key of keys) { const net = { key }; const k = pairName(net.key); if (k) { const e = by.get(k.base) || []; by.set(k.base, e); e.push(net); } else single.push(net); }
    const minW = Math.max(s.minTrackWidth || 0, 0.09); const r2 = (v: number) => Math.round(v * 100) / 100;
    for (const e of by.values()) {
      if (e.length !== 2) { single.push(...e); continue; }
      const target = planned(e[0].key) || planned(e[1].key) || usualImpedance(e[0].key, true); if (!target) continue;
      const clr = Math.max(P.netClearance(s, e[0].key), P.netClearance(s, e[1].key), s.minClearance || 0); const cw = this.classFor(e[0].key).width;
      // the tightest gap first (the strongest coupling), then wider ones, until the width is one the board can carry
      let pick: { w: number; g: number } | null = null, first: number | null = null;
      for (const g of [Math.max(clr, this.opts.pairGap || 0), clr * 1.5, clr * 2, clr * 3]) { const w = widthFor(tr, target, g); if (w !== null && first === null) first = w; if (w !== null && w >= minW && w <= Math.max(0.6, cw * 3)) { pick = { w: r2(w), g: r2(g) }; break; } }
      const rep: ImpedanceReport = { nets: e.map((n) => n.key), target, differential: true, layer: tr.layer, model, width: pick ? pick.w : first !== null ? r2(first) : null, gap: pick ? pick.g : r2(clr), applied: !!pick };
      if (pick) { for (const n of e) { this.zWidth.set(n.key, pick.w); this.zGap.set(n.key, pick.g); } rep.achieved = Math.round(zdiff(tr, pick.w, pick.g)); }
      else rep.note = first !== null ? `${target} Ω needs ${r2(first)} mm tracks on this stackup, more than the board can carry: routed at the class width (${Math.round(zdiff(tr, cw, clr))} Ω). A thinner dielectric under the layer (a 4-layer build) brings the width down.` : `no track width gives ${target} Ω on this stackup`;
      this.zReports.push(rep);
    }
    for (const net of single) {
      const target = planned(net.key) || usualImpedance(net.key, false); if (!target) continue; const cw = this.classFor(net.key).width; const w = widthFor(tr, target);
      const ok = w !== null && w >= minW && w <= Math.max(1.2, cw * 5);
      const rep: ImpedanceReport = { nets: [net.key], target, differential: false, layer: tr.layer, model, width: w !== null ? r2(w) : null, applied: ok };
      if (ok) { this.zWidth.set(net.key, r2(w!)); rep.achieved = Math.round(z0(tr, r2(w!))); }
      else rep.note = w !== null && w < minW ? `${target} Ω needs a ${r2(w)} mm track on this stackup, under the board's minimum track width (${r2(minW)} mm): routed at the class width (${Math.round(z0(tr, cw))} Ω).`
        : w !== null ? `${target} Ω needs a ${r2(w)} mm track on this stackup, more than the board can carry: routed at the class width (${Math.round(z0(tr, cw))} Ω). A thinner dielectric under the layer (a 4-layer build), or a coplanar feed with ground beside it, brings the width down.` : `no track width gives ${target} Ω on this stackup`;
      this.zReports.push(rep);
    }
  }
  pairList: Pair[] | null = null; pairReports = new Map<string, PairReport>();
  /** The connections of paired nets that start side by side and end side by side: those run as a pair. */
  private findPairs(): Pair[] {
    const by = new Map<string, { p?: NetInfo; n?: NetInfo }>(); const out: Pair[] = [];
    for (const net of this.nets) { const k = pairName(net.key); if (!k) continue; const e = by.get(k.base) || {}; by.set(k.base, e); if (k.pol > 0) e.p = net; else e.n = net; }
    const d = (a: Anchor, b: Anchor) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); const NEAR = 3;
    for (const e of by.values()) {
      if (!e.p || !e.n) continue; const used = new Set<Conn>();
      for (const cp of e.p.conns) {
        if (cp.len < 2) continue; let best: [number, Conn, boolean] | null = null;
        for (const cn of e.n.conns) {
          if (used.has(cn)) continue; const st = d(cp.a, cn.a) + d(cp.b, cn.b), sw = d(cp.a, cn.b) + d(cp.b, cn.a); const swap = sw < st;
          const [x, y] = swap ? [d(cp.a, cn.b), d(cp.b, cn.a)] : [d(cp.a, cn.a), d(cp.b, cn.b)]; if (x > NEAR || y > NEAR || x < 1e-3 || y < 1e-3) continue;
          if (!best || x + y < best[0]) best = [x + y, cn, swap];
        }
        if (best) {
          used.add(best[1]); const pr: Pair = { p: e.p, n: e.n, cp, cn: best[1], swap: best[2] }; out.push(pr);
          // Each net's tree could as well reach another of its pads on the same side (a USB-C socket has two D+ and
          // two D- pads, interleaved): take the two that sit closest together and the same way round as the far end.
          for (const end of ["a", "b"] as const) {
            const other = end === "a" ? "b" : "a"; const cn = pr.cn, nEnd = (pr.swap ? other : end) as "a" | "b", nOther = (pr.swap ? end : other) as "a" | "b";
            const side = (net: NetInfo, c: Conn, at: "a" | "b"): Anchor[] => {   // the pads this end may move to and the net's tree stays a tree
              const seen = new Set<number>([c[at].cluster]); let grew = true;
              while (grew) { grew = false; for (const o of net.conns) if (o !== c) { const x = o.a.cluster, y = o.b.cluster; if (seen.has(x) !== seen.has(y)) { seen.add(x); seen.add(y); grew = true; } } }
              return (net.anchors || []).filter((a) => seen.has(a.cluster) && a.axis);
            };
            const cps = side(e.p, cp, end), cns = side(e.n, cn, nEnd); const far: Pt = [cp[other].p[0] - cn[nOther].p[0], cp[other].p[1] - cn[nOther].p[1]];
            let pick: [number, Anchor, Anchor] | null = null;
            for (const a of cps) for (const b of cns) { const dd = d(a, b); if (dd < 1e-3 || dd > NEAR) continue; const sc = dd + ((a.p[0] - b.p[0]) * far[0] + (a.p[1] - b.p[1]) * far[1] < 0 ? 5 : 0) + 0.05 * (d(a, cp[other]) + d(b, cn[nOther])); if (!pick || sc < pick[0] - 1e-9) pick = [sc, a, b]; }
            if (pick && (pick[1] !== cp[end] || pick[2] !== cn[nEnd])) { cp[end] = pick[1]; cn[nEnd] = pick[2]; cp.len = d(cp.a, cp.b); cn.len = d(cn.a, cn.b); cp.cls = this.classFor(cp.net, Math.min(this.roomAt(cp.a, cp.net), this.roomAt(cp.b, cp.net))); cn.cls = this.classFor(cn.net, Math.min(this.roomAt(cn.a, cn.net), this.roomAt(cn.b, cn.net))); }
          }
        }
      }
    }
    return out;
  }
  /** A differential pair is laid as one: a single wide route down the middle between the two starts and the two
   *  ends, split into two tracks a constant gap apart, each fanned to its own pad.  Every piece is checked exactly;
   *  when the pair cannot be laid this way its nets are routed like any other, and the report says so. */
  layPairs(): void {
    if (this.opts.pairs === false) return; if (!this.pairList) this.pairList = this.findPairs();
    for (const pr of this.pairList) {
      if (pr.cp.nodes || pr.cn.nodes) continue; const key = pr.cp.id + "/" + pr.cn.id;
      const why = this.layPair(pr); if (why) this.pairReports.set(key, { p: pr.p.key, n: pr.n.key, coupled: false, reason: why });
    }
  }
  /** The two tracks of a pair from its centre line: each a constant distance to one side, mitred at the turns, and
   *  fanned to its own pads at the ends — checked exactly against each other and against everything around.
   *  Returns the two polylines, or why they cannot be. */
  private pairTracks(pr: Pair, c: Pt[], l: number, w: number, d: number, clr: number, sgn: number, lead: Lead[]): { tp: Pt[]; tn: Pt[] } | string {
    const P = this.P, { cp, cn } = pr; const Pa = cp.a, Pb = cp.b, Na = pr.swap ? cn.b : cn.a, Nb = pr.swap ? cn.a : cn.b;
    const dir = (i: number): Pt => { const x = c[i + 1][0] - c[i][0], y = c[i + 1][1] - c[i][1], h = Math.hypot(x, y); return [x / h, y / h]; };
    const off = (sg: number): Pt[] | null => {
      const out: Pt[] = [];
      for (let i = 0; i < c.length; i++) {
        const u0 = i > 0 ? dir(i - 1) : dir(0), u1 = i < c.length - 1 ? dir(i) : dir(c.length - 2); const n0: Pt = [-u0[1], u0[0]], n1: Pt = [-u1[1], u1[0]]; const k = 1 + n0[0] * n1[0] + n0[1] * n1[1]; if (k < 0.2) return null;
        out.push([r6(c[i][0] + sg * d * (n0[0] + n1[0]) / k), r6(c[i][1] + sg * d * (n0[1] + n1[1]) / k)]);
      }
      for (let i = 0; i + 1 < out.length; i++) { const u = dir(i); if ((out[i + 1][0] - out[i][0]) * u[0] + (out[i + 1][1] - out[i][1]) * u[1] < 0.02) return null; }   // a piece too short to carry the turn
      return out;
    };
    const segs = (t: Pt[]) => { const o: Shape[] = []; for (let i = 0; i + 1 < t.length; i++) if (Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]) > 1e-4) o.push({ t: "seg", a: t[i], b: t[i + 1], r: w / 2 } as Shape); return o; };
    const op = off(sgn), on = off(-sgn); if (!op || !on) return "a turn is too tight for the pair";
    const out = (a: Anchor, ld: Lead): Pt => [r6(a.p[0] + ld.e[0] * ld.s), r6(a.p[1] + ld.e[1] * ld.s)];
    const tp = [Pa.p, out(Pa, lead[0]), ...op, out(Pb, lead[1]), Pb.p], tn = [Na.p, out(Na, lead[0]), ...on, out(Nb, lead[1]), Nb.p]; const sp = segs(tp), sn = segs(tn);
    if (sp.some((a) => sn.some((b) => P.shapeGap(a, b) < clr - 1e-4))) return "the fan-out to the pads brings the two tracks too close";
    this.cur = Object.assign({}, cp); this.curSoft = false;
    if (!sp.every((sh) => this.clearOf(sh, l, pr.p.key, cp.cls.clr)) || !sn.every((sh) => this.clearOf(sh, l, pr.n.key, cn.cls.clr))) return "a piece of the pair would not keep its clearance";
    return { tp, tn };
  }
  private layPair(pr: Pair): string {
    const G = this.G, P = this.P, { cp, cn } = pr; const w = Math.min(cp.cls.width, cn.cls.width), clr = Math.max(cp.cls.clr, cn.cls.clr); const gap = Math.max(clr, this.opts.pairGap || 0, this.zGap.get(pr.p.key) || 0), d = (w + gap) / 2;
    const Pa = cp.a, Pb = cp.b, Na = pr.swap ? cn.b : cn.a, Nb = pr.swap ? cn.a : cn.b;
    const layers = G.layers.map((_, l) => l).filter((l) => G.routable[l] && [Pa, Pb, Na, Nb].every((a) => a.layers.includes(l)));
    if (!layers.length) return "its pads are not all on one layer";
    const key = `pair/${w}/${gap}/${clr}`; let wide = G.classes.get(key);
    if (!wide) { wide = buildClass(G, key, 2 * w + gap, clr, cp.cls.viaD, cp.cls.viaDrill, cp.cls.kind); for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, wide, sh, 1, false); }
    const half = (a: Anchor) => { const sh = a.shape as any; return sh ? (sh.t === "circle" ? sh.r : Math.max(sh.w || 0, sh.h || 0) / 2 || sh.r || 0) : 0; };
    // Each end gathers the pair a little way off its pads, square to the line between them, on either side of it.
    const gather = (a: Anchor, b: Anchor, toward: Anchor): { g: Anchor; e: Pt; q: Pt; s: number }[] => {
      const mx = (a.p[0] + b.p[0]) / 2, my = (a.p[1] + b.p[1]) / 2; let ex = -(a.p[1] - b.p[1]), ey = a.p[0] - b.p[0]; const h = Math.hypot(ex, ey); ex /= h; ey /= h;
      // each track runs straight off its pad to just past the pad's end, turns in at 45° until the two are side by side (q), and from there they go on together to the gathering point
      const s1 = Math.max(half(a), half(b)) + clr * 0.7, jog = Math.max(0, h / 2 - d);
      // straight out first; then a little to either side, where something stands right in front of the pads
      const out: { g: Anchor; e: Pt; q: Pt; s: number }[] = [];
      const fwd = (toward.p[0] - mx) * ex + (toward.p[1] - my) * ey >= 0 ? 1 : -1;   // first the side that faces the other end
      for (const sh of [0, 0.4, -0.4, 0.8, -0.8]) for (const sg of [fwd, -fwd]) { const tq = s1 + jog + Math.abs(sh) + 0.05, t = tq + 2 * d + 0.1 + G.g; const ox = mx - ey * sh, oy = my + ex * sh; const p: Pt = [r6(ox + ex * t * sg), r6(oy + ey * t * sg)]; out.push({ g: { p, layers, shape: { t: "circle", x: p[0], y: p[1], r: G.g * 1.5 } as Shape, cluster: 0 }, e: [ex * sg, ey * sg] as Pt, q: [r6(ox + ex * tq * sg), r6(oy + ey * tq * sg)] as Pt, s: s1 }); }
      return out;
    };
    let why = "there is no room for the two tracks side by side", close = "";
    this.lift(pr.p, 1, wide); this.lift(pr.n, 1, wide); let laid: { l: number; nodes: Node[]; feat: Features; tp: Pt[]; tn: Pt[] } | null = null;
    // the pair leaves a gathering point away from its pads, never back over them
    const wall = (m: Uint16Array, at: { g: Anchor; e: Pt }, cell: Terminal, sign: number) => {
      const R = Math.max(1.5, Math.hypot(Pa.p[0] - Na.p[0], Pa.p[1] - Na.p[1])), n = Math.ceil(R / G.g), cx = cell.ix, cy = cell.iy;   // behind the cell the pair really starts from
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) { const ix = cx + dx, iy = cy + dy; if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; if ((dx * at.e[0] + dy * at.e[1]) * G.g < -G.g * 0.6) m[iy * G.W + ix] += sign; }
    };
    try {
      this.cur = Object.assign({}, cp, { cls: wide }); this.curSoft = false;
      // Two ends that face each other at close range (series resistors right behind a connector) need no search: the
      // pair goes straight across from where one end has gathered to where the other has.
      for (const l of layers) {
        if (laid) break; const ga = gather(Pa, Na, Pb)[0], gb = gather(Pb, Nb, Pa)[0]; const span = Math.hypot(gb.q[0] - ga.q[0], gb.q[1] - ga.q[1]); if (span < 0.1 || span > 6) continue;
        const cell = (q: Pt): Node => ({ ix: Math.round((q[0] - G.ox) / G.g), iy: Math.round((q[1] - G.oy) / G.g), l }); const nodes = [cell(ga.q), cell(gb.q)]; const lead: Lead[] = [{ e: ga.e, s: ga.s }, { e: gb.e, s: gb.s }];
        for (const L1 of [0.4, 0.3, 0.2]) {   // a short piece straight on at each end, so the two tracks stand square to their pads where they meet them
          if (laid) break; const a1: Pt = [r6(ga.q[0] + ga.e[0] * L1), r6(ga.q[1] + ga.e[1] * L1)], b1: Pt = [r6(gb.q[0] + gb.e[0] * L1), r6(gb.q[1] + gb.e[1] * L1)];
          const along = (b1[0] - a1[0]) * ga.e[0] + (b1[1] - a1[1]) * ga.e[1], across = Math.abs((b1[0] - a1[0]) * ga.e[1] - (b1[1] - a1[1]) * ga.e[0]);
          if (along < 0.02 || (a1[0] - b1[0]) * gb.e[0] + (a1[1] - b1[1]) * gb.e[1] < 0.02 || across > along * 1.2 + 0.02) { close = "the two ends are too close together for a coupled run"; continue; }   // no sideways dog-leg for the sake of a millimetre of pair
          const c: Pt[] = [ga.q, a1, b1, gb.q];
          for (const sgn of [1, -1]) { const r = this.pairTracks(pr, c, l, w, d, clr, sgn, lead); if (typeof r === "string") { why = r; if ((this.opts as any).debugPairs) console.log("  direct", L1, sgn, r); continue; } pr.laid = { c, l, w, d, clr, sgn, lead }; laid = { l, nodes, feat: featuresOf(G, nodes, this.pref), tp: r.tp, tn: r.tn }; break; }
        }
      }
      let tries = 0;
      search: for (const l of layers) for (const ga of gather(Pa, Na, Pb)) for (const gb of gather(Pb, Nb, Pa)) {
        if (laid) break search;
        this.cur = Object.assign({}, cp, { cls: wide }); this.curSoft = false;
        const rt = G.routable.map((_, i) => i === l); const src = this.access(ga.g, wide.full, rt), tgt = this.access(gb.g, wide.full, rt); if ((this.opts as any).debugPairs) console.log("combo", pr.p.key, JSON.stringify(ga.g.p), JSON.stringify(gb.g.p), !!src, !!tgt); if (!src || !tgt) continue;
        wall(wide.full[l], ga, src, 1); wall(wide.full[l], gb, tgt, 1); let res: ProbeResult | null = null;
        try { if (!wide.full[l][src.iy * G.W + src.ix] && !wide.full[l][tgt.iy * G.W + tgt.ix]) res = probe({ G, maps: wide.full, vmaps: wide.vfull, src, tgt, term: [], win: { x0: 0, y0: 0, x1: G.W - 1, y1: G.H - 1 }, pref: this.pref, W: this.W, allowVias: false, maxSteps: 6e6, routable: rt }); }
        finally { wall(wide.full[l], ga, src, -1); wall(wide.full[l], gb, tgt, -1); }
        if ((this.opts as any).debugPairs) console.log("  probe", !!res);
        if (!res) continue; if (++tries > 12) break search;
        const nodes = this.mitre(simplify(res.nodes), wide.full); let c: Pt[] = []; for (const n of nodes) { const q = this.mm(n); if (!c.length || Math.hypot(q[0] - c[c.length - 1][0], q[1] - c[c.length - 1][1]) > 1e-6) c.push(q); }
        if (c.length < 2) continue;
        if (Math.hypot(c[0][0] - ga.g.p[0], c[0][1] - ga.g.p[1]) > Math.hypot(c[c.length - 1][0] - ga.g.p[0], c[c.length - 1][1] - ga.g.p[1])) c = c.slice().reverse();
        // the lead-in runs exactly along the pads' axis into the gathering cell, wherever the grid put that cell
        const back = (p: Pt, e: Pt): Pt => [r6(p[0] - e[0] * (2 * d + 0.1 + G.g)), r6(p[1] - e[1] * (2 * d + 0.1 + G.g))];
        c = [back(c[0], ga.e), ...c, back(c[c.length - 1], gb.e)];
        for (const sgn of [1, -1]) {   // which track is whose: the way round in which the two fans do not cross
          const lead: Lead[] = [{ e: ga.e, s: ga.s }, { e: gb.e, s: gb.s }];
          const r = this.pairTracks(pr, c, l, w, d, clr, sgn, lead); if (typeof r === "string") { why = r; if ((this.opts as any).debugPairs) console.log("  fail", sgn, r, JSON.stringify(c)); continue; }
          const tp = r.tp, tn = r.tn; pr.laid = { c, l, w, d, clr, sgn, lead };
          laid = { l, nodes, feat: res.feat, tp, tn }; break search;
        }
      }
    } finally { this.lift(pr.n, -1, wide); this.lift(pr.p, -1, wide); }
    if (!laid) return close || why;
    const put = (c: Conn, t: Pt[]) => {
      c.shapes = []; for (let i = 0; i + 1 < t.length; i++) if (Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]) > 1e-4) c.shapes.push({ net: c.net, layers: [laid!.l], shape: { t: "seg", a: t[i], b: t[i + 1], r: w / 2 } as Shape, clr: c.cls.clr });
      c.nodes = laid!.nodes; c.viaCells = []; c.stubs = []; c.feat = laid!.feat; c.landed = -1; c.zoneEnd = false; c.pair = true; c.rips = 99; c.why = undefined; this.place(c, 1);
      let len = 0; for (let i = 0; i + 1 < t.length; i++) len += Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]); return len;
    };
    const lp = put(cp, laid.tp), ln = put(cn, laid.tn);
    this.pairReports.set(cp.id + "/" + cn.id, { p: pr.p.key, n: pr.n.key, coupled: true, layer: G.layers[laid.l], width: w, gap: +gap.toFixed(4), lengthP: +lp.toFixed(3), lengthN: +ln.toFixed(3), skew: +Math.abs(lp - ln).toFixed(3) });
    return "";
  }
  // ------------------------------------------------------------------ length matching
  matchReports: MatchReport[] = [];
  /** A run of n serpentine humps on the piece a→b, swinging A to one side: square humps S wide and S apart with
   *  chamfered corners.  Each adds 2A − 2.343·ch to the length. */
  private humps(a: Pt, b: Pt, n: number, A: number, S: number, ch: number, side: number): Pt[] {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * side, ny = ux * side;
    const at = (x: number, y: number): Pt => [r6(a[0] + ux * x + nx * y), r6(a[1] + uy * x + ny * y)]; const out: Pt[] = [a]; const s0 = (L - (2 * n - 1) * S) / 2;
    for (let k = 0; k < n; k++) { const x = s0 + 2 * k * S; out.push(at(x - ch, 0), at(x, ch), at(x, A - ch), at(x + ch, A), at(x + S - ch, A), at(x + S, A - ch), at(x + S, ch), at(x + S + ch, 0)); }
    out.push(b); return out;
  }
  /** For the last fraction of a millimetre: n shallow bumps with 45° flanks, each a high and r long on top.  Each
   *  adds 0.828·a. */
  private bumps(a: Pt, b: Pt, n: number, h: number, r: number, side: number): Pt[] {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * side, ny = ux * side;
    const at = (x: number, y: number): Pt => [r6(a[0] + ux * x + nx * y), r6(a[1] + uy * x + ny * y)]; const out: Pt[] = [a]; const one = 2 * h + r, s0 = (L - n * one - (n - 1) * r) / 2;
    for (let k = 0; k < n; k++) { const x = s0 + k * (one + r); out.push(at(x, 0), at(x + h, h), at(x + h + r, h), at(x + one, 0)); }
    out.push(b); return out;
  }
  /** The serpentines to try on a straight piece L long for `left` mm more: deep square humps first, then more and
   *  shallower ones, and shallow bumps when what is missing is less than the smallest hump adds. */
  private meanders(a: Pt, b: Pt, L: number, left: number, tol: number, g: { S: number; ch: number; Amin: number; Amax: number; m: number; hmin: number }): { pts: Pt[]; gain: number }[] {
    const out: { pts: Pt[]; gain: number }[] = []; const kk = 2.343 * g.ch; const nmax = Math.floor(((L - 2 * g.m) / g.S + 1) / 2);
    for (const cap of [g.Amax, g.Amax / 2, g.Amax / 4, g.Amax / 8, g.Amin]) {
      if (cap < g.Amin - 1e-9 || nmax < 1) continue;
      let n = Math.min(nmax, Math.max(1, Math.ceil(left / (2 * cap - kk)))); let A = Math.min(cap, (left / n + kk) / 2);
      if (A < g.Amin) { A = g.Amin; if (n * (2 * A - kk) > left + tol) n = Math.floor((left + tol) / (2 * A - kk)); if (n < 1) continue; }
      for (const side of [1, -1]) out.push({ pts: this.humps(a, b, n, A, g.S, g.ch, side), gain: n * (2 * A - kk) });
    }
    if (left < 2 * g.Amin - kk + tol) for (const n of [1, 2, 3]) {
      const h = left / (0.8284 * n), r = Math.max(g.hmin * 2, 0.2); if (h < g.hmin || h > g.Amax || n * (2 * h + r) + (n - 1) * r + 2 * g.m > L) continue;
      for (const side of [1, -1]) out.push({ pts: this.bumps(a, b, n, h, r, side), gain: left });
    }
    return out;
  }
  private static lenOf(c: Conn): number { let len = 0; for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") len += Math.hypot(sh.a[0] - sh.b[0], sh.a[1] - sh.b[1]); } return len; }
  /** Lengthen one track by `extra` with serpentines on its longest straight pieces; returns what is still missing. */
  private extend(c: Conn, extra: number, tol: number): number {
    const w = c.cls.width, clr = c.cls.clr, Amax = this.opts.maxAmplitude || 3; const ch = Math.max(0.1, w / 2), S = Math.max(w + 2 * clr, 3 * w, 2 * ch + 0.1), Amin = 2 * ch + 0.05, m = ch + 0.1;
    let left = extra;
    for (let round = 0; round < 6 && left > tol; round++) {
      const cand = c.shapes.map((o, i) => ({ o, i, L: (o.shape as any).t === "seg" ? Math.hypot((o.shape as any).a[0] - (o.shape as any).b[0], (o.shape as any).a[1] - (o.shape as any).b[1]) : 0 })).filter((x) => x.L >= S + 2 * m).sort((x, y) => y.L - x.L);
      let done = false;
      for (const { o, i, L } of cand) {
        const sh = o.shape as any;
        for (const cand2 of this.meanders(sh.a, sh.b, L, left, tol, { S, ch, Amin, Amax, m, hmin: Math.max(0.1, w / 2) })) {
          const pts = cand2.pts; const add: Obstacle[] = []; for (let k = 0; k + 1 < pts.length; k++) add.push({ net: c.net, layers: o.layers, shape: { t: "seg", a: pts[k], b: pts[k + 1], r: sh.r } as Shape, clr: o.clr });
          this.place(c, -1); const keep = c.shapes; c.shapes = []; this.cur = c; this.curSoft = false;
          const ok = add.every((x) => this.clearOf(x.shape, o.layers[0], c.net, clr));
          c.shapes = ok ? keep.slice(0, i).concat(add, keep.slice(i + 1)) : keep; this.place(c, 1);
          if (ok) { left -= cand2.gain; c.pair = true; done = true; break; }
        }
        if (done) break;
      }
      if (!done) break;
    }
    return left;
  }
  /** Lengthen a coupled pair: the serpentine is put on its centre line, so the two tracks swing together. */
  private extendPair(pr: Pair, extra: number, tol: number): number {
    const Ld = pr.laid!; const { cp, cn } = pr; const w = Ld.w, d = Ld.d, Wt = 2 * d + w, Amax = this.opts.maxAmplitude || 3;
    const ch = Math.max(0.15, 0.6 * d + 0.06), S = Math.max(Wt + 2 * Ld.clr, 2 * ch + d + 0.1), Amin = 2 * ch + d + 0.05, m = ch + d + 0.1; let left = extra;
    const total = () => (Router.lenOf(cp) + Router.lenOf(cn)) / 2;
    for (let round = 0; round < 6 && left > tol; round++) {
      const c = Ld.c; const cand: { i: number; L: number }[] = []; for (let i = 1; i + 2 < c.length; i++) { const L = Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]); if (L >= S + 2 * m) cand.push({ i, L }); }
      cand.sort((x, y) => y.L - x.L); let done = false;
      for (const { i, L } of cand) {
        for (const cand2 of this.meanders(c[i], c[i + 1], L, left, tol, { S, ch, Amin, Amax, m, hmin: 0.6 * d + 0.06 })) {
          const c2 = c.slice(0, i).concat(cand2.pts, c.slice(i + 2)); const before = total();
          this.place(cp, -1); this.place(cn, -1); const kp = cp.shapes, kn = cn.shapes; cp.shapes = []; cn.shapes = [];
          const r = this.pairTracks(pr, c2, Ld.l, w, d, Ld.clr, Ld.sgn, Ld.lead);
          if (typeof r === "string") { cp.shapes = kp; cn.shapes = kn; this.place(cp, 1); this.place(cn, 1); continue; }
          const set = (cc: Conn, t: Pt[]) => { for (let k = 0; k + 1 < t.length; k++) if (Math.hypot(t[k + 1][0] - t[k][0], t[k + 1][1] - t[k][1]) > 1e-4) cc.shapes.push({ net: cc.net, layers: [Ld.l], shape: { t: "seg", a: t[k], b: t[k + 1], r: w / 2 } as Shape, clr: cc.cls.clr }); this.place(cc, 1); };
          set(cp, r.tp); set(cn, r.tn); Ld.c = c2; left -= total() - before; done = true; break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    return left;
  }
  /** Bring the members of each matched group to one length, then take out what skew is left inside each pair. */
  tune(): void {
    const tolOf = (t?: number) => t !== undefined && t > 0 ? t : 0.25; const pairs = (this.pairList || []).filter((pr) => pr.cp.pair && pr.cn.pair && pr.laid && pr.cp.nodes && pr.cn.nodes);
    interface Member { nets: string[]; pr?: Pair; conns: Conn[] }
    const lenM = (mb: Member) => mb.pr ? (Router.lenOf(mb.pr.cp) + Router.lenOf(mb.pr.cn)) / 2 : mb.conns.reduce((a, c) => a + (c.nodes ? Router.lenOf(c) : 0), 0);
    const groups: { name: string; members: Member[]; tol: number; length?: number }[] = [];
    for (const g of this.opts.match || []) {
      const members: Member[] = []; const taken = new Set<string>();
      for (const pr of pairs) if (g.nets.includes(pr.p.key) && g.nets.includes(pr.n.key)) { members.push({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); taken.add(pr.p.key); taken.add(pr.n.key); }
      for (const k of g.nets) if (!taken.has(k)) { const net = this.nets.find((n) => n.key === k); if (net && net.conns.some((c) => c.nodes)) members.push({ nets: [k], conns: net.conns.filter((c) => c.nodes) }); }
      if (members.length) groups.push({ name: g.nets.join(", "), members, tol: tolOf(g.tolerance), length: g.length });
    }
    // the lanes of one bus (HDMI_D0…D2 and the clock, ETH_TX and ETH_RX): pairs that share the name in front of the lane
    const planned = new Set((this.opts.match || []).flatMap((g) => g.nets)); const bus = new Map<string, Member[]>();
    for (const pr of pairs) { if (planned.has(pr.p.key)) continue; const k = pairName(pr.p.key)!.base.replace(/~.*$/, "").replace(/[_\-]?(D|TX|RX|TD|RD|CLK|CK|LANE|L|MDI|DATA|TMDS)?_?\d*$/i, "").replace(/[_\-]+$/, ""); if (!k || /^\/?$/.test(k)) continue; const e = bus.get(k) || []; bus.set(k, e); e.push({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); }
    for (const [k, members] of bus) if (members.length > 1) groups.push({ name: k, members, tol: 0.25 });
    for (const g of groups) {
      const before = g.members.map(lenM); const target = g.length && g.length > 0 ? g.length : Math.max(...before);
      const rep: MatchReport = { group: g.name, target: +target.toFixed(3), tolerance: g.tol, members: [] }; this.matchReports.push(rep);
      g.members.forEach((mb, i) => {
        const need = target - before[i]; let left = need;
        if (need > g.tol) left = mb.pr ? this.extendPair(mb.pr, need, g.tol / 2) : this.extend(mb.conns.slice().sort((a, b) => Router.lenOf(b) - Router.lenOf(a))[0], need, g.tol / 2);
        const now = lenM(mb); const ok = Math.abs(target - now) <= g.tol + 1e-6;
        rep.members.push({ nets: mb.nets, before: +before[i].toFixed(3), length: +now.toFixed(3), matched: ok, note: ok ? undefined : need < 0 ? "longer than the length asked for" : `no room for ${left.toFixed(2)} mm more of serpentine beside its track` });
      });
    }
    const skewTol = this.opts.skewTolerance !== undefined ? this.opts.skewTolerance : 0.1;
    for (const pr of pairs) {
      const lp = Router.lenOf(pr.cp), ln = Router.lenOf(pr.cn); if (Math.abs(lp - ln) > skewTol) this.extend(lp < ln ? pr.cp : pr.cn, Math.abs(lp - ln), skewTol / 2);
      const rep = this.pairReports.get(pr.cp.id + "/" + pr.cn.id); if (rep) { rep.lengthP = +Router.lenOf(pr.cp).toFixed(3); rep.lengthN = +Router.lenOf(pr.cn).toFixed(3); rep.skew = +Math.abs(rep.lengthP - rep.lengthN).toFixed(3); }
    }
    this.oidx = null;
  }
  private viaCap = Infinity;
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
    const G = this.G, nodes = conn.nodes!; if (conn.pair) return;   // a pair's tracks run beside these cells, and nothing tees into a pair
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
      if (!collect && this.rim && this.opts.edgeRuns !== true) {   // mm run along the board edge beyond a short approach to a pad there
        const rim = this.rim, before = extra;
        extra = (nodes) => { let run = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const step = Math.hypot(sx, sy) * G.g; for (let k = 0; k < n; k++) if (rim[(a.iy + sy * k) * G.W + a.ix + sx * k] && rim[(a.iy + sy * (k + 1)) * G.W + a.ix + sx * (k + 1)]) run += step; }
          return Math.max(0, run - RIM_FREE_MM) * RIM_COST * this.W.length + (before ? before(nodes) : 0); };
      }
      let used = 0; for (const c of net.conns) if (c.nodes && c !== conn && c.feat) used += c.feat.vias;
      const perConn = this.opts.maxViasPerConnection; const maxVias = Math.min(gd.maxVias - used, this.viaCap, perConn === undefined || perConn === null ? Infinity : Math.max(0, +perConn));
      const src = this.access(A, maps, rt), tgt = this.access(B, maps, rt); if (!src) return null;
      let term = tb; let zoneSet: Set<number> | null = null;
      if (zoneAt(B.cluster)) { zoneSet = new Set(); term = tb.slice(); let own = false; for (const z of net.zoneCells!) if (!maps[z.l][z.iy * G.W + z.ix]) { if (!rt[z.l]) { if (!own) { rt = rt.slice(); own = true; } rt[z.l] = true; }   // a plane layer takes no tracks, but a via may drop into the net's own pour on it
        term.push(z); zoneSet.add(z.l * G.W * G.H + z.iy * G.W + z.ix); } }
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
    // Only a plated hole of a pad or of copper already on the board saves a via.  A via of another connection of this
    // net does not: that connection may be ripped and laid elsewhere later, which would leave this one changing layer in thin air.
    const holes = new Set<number>(); for (const o of G.obstacles.get(conn.net) || []) if (o.thru) holes.add(Math.round((o.thru[1] - G.oy) / G.g) * G.W + Math.round((o.thru[0] - G.ox) / G.g));
    this.lift(net, 1, conn.cls);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (a.l !== b.l) { const gi = a.iy * G.W + a.ix; if ((!G.thru[gi] || !holes.has(gi)) && !viaCells.includes(gi)) { viaCells.push(gi); const p = this.mm(a); shapes.push({ net: conn.net, layers: all, shape: { t: "circle", x: p[0], y: p[1], r: conn.cls.viaD / 2 }, clr }); } }
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
    this.place(conn, -1); conn.nodes = null; conn.shapes = []; conn.viaCells = []; conn.stubs = []; conn.pair = false; out.push(conn);
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
    let best: { score: number; snap: (Pick<Conn, "cls" | "pair" | "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd">)[] } | null = null; let failedLast = new Set<number>(); let pass = 0;
    const RC = (this.opts as any).connRips || 4, RB = (this.opts as any).blockerRips || 3;
    const timeUp = () => this.stopped || (!!this.opts.timeMs && Date.now() - t0 > this.opts.timeMs);
    for (; pass < passes; pass++) {
      for (const c of conns) if (c.nodes) this.rip(c);
      for (const c of conns) c.rips = 0;
      this.layPairs();
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
      if (!best || score > best.score) best = { score, snap: conns.map((c) => ({ cls: c.cls, pair: c.pair, nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd })) };
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
    if (this.opts.fewerVias !== false && !this.stopped) this.fewerVias(timeUp);
    this.widen();
    if (this.opts.zones !== false && !this.stopped) this.stitch(timeUp);   // what the last two steps moved may have cut a pour again
    if (ripUp && this.opts.zones !== false && !this.stopped && conns.some((c) => !c.nodes && !c.moot && c.stitch)) { this.repair(timeUp); this.stitch(timeUp); }   // a cut-off pad still not joined: let it push others aside
    if (this.opts.matchLengths !== false && !this.stopped) this.tune();
    this.validate();
    if (this.opts.fence !== false && !this.stopped) this.fence();
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
      const soft = this.find(c, true); if (!soft) return false; const bl = this.blockers(c, soft.res); if (!bl.length || bl.length > 12 || bl.some((b) => keep.has(b) || b.pair)) return false;
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
      if (c.nodes || c.why === "budget" || timeUp() || c.pair) continue;
      const wide = c.cls;
      for (const relax of wide.kind ? [false, true] : [false]) {   // last of all, without the gap its signal domain asks for
        let thin: RuleClass; this.relax = relax; try { thin = this.classFor(c.net, Math.min(floor, wide.width), 0, this.opts.smallVias !== false); } finally { this.relax = false; } if (thin === wide) continue;
        c.cls = thin; const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
        if (force(c, 3, new Set()) && conns.filter((x) => x.nodes).length > n0) { if (relax) this.relaxed.add(c.net); break; }
        c.cls = wide; back(snap);
      }
    }
  }
  /** Once everything is laid there is often room that was not there (or not known to be free) when a route chose to
   *  change layers.  Each route with vias is tried again on the finished board with none, then with fewer; it is
   *  only replaced when that works and does not send it on a long way round. */
  fewerVias(timeUp: () => boolean): void {
    const conns = this.conns; const todo = conns.filter((c) => c.nodes && c.viaCells.length && !c.zoneEnd).sort((a, b) => b.viaCells.length - a.viaCells.length);
    for (const c of todo) {
      if (timeUp()) break; if (!c.nodes || this.netOf(c.net).guide.allowed || conns.some((o) => o.nodes && o.landed === c.id)) continue;   // a plan that names the net's layers stands
      const old = { nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd, ends: c.ends, a: c.a, b: c.b };
      const n = old.viaCells.length, len = old.feat ? old.feat.length : c.len; this.rip(c); let done = false;
      for (const cap of n > 2 ? [0, n - 2] : [0]) {
        this.viaCap = cap; let found: Found | null = null; try { found = this.find(c, false); } finally { this.viaCap = Infinity; }
        if (found && found.res.feat.vias < n && found.res.feat.length <= len * 2.5 + 4) { this.commit(c, found); this.stat.viasSaved = (this.stat.viasSaved || 0) + n - c.viaCells.length; done = true; break; }
      }
      if (!done) { Object.assign(c, old); this.place(c, 1); }
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
    const cells: Node[] = []; for (let l = 0; l < label.length; l++) { const lab = label[l]; if (!lab) continue; for (let i = 0; i < W * H; i++) if (lab[i] && find(ng + lab[i]) === main) cells.push({ ix: i % W, iy: (i / W) | 0, l }); }
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
      // A drop into the pour that no longer joins anything (its pad has since been tied to the main body another way,
      // or it ended in a piece nothing else is in) is a stub: take out each one the net stays whole without.
      const loose = () => { const st = this.pourState(net); if (!st) return Infinity; let n = 0; for (const a of net.anchors!) if (st.root(a.grp || 0) !== st.main) n++; return n; };
      let base = -1;
      for (const c of net.conns) {
        if (timeUp()) break; if (!c.nodes || !c.zoneEnd || this.conns.some((o) => o.nodes && o.landed === c.id)) continue; if (base < 0) base = loose();
        const old = { nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd, ends: c.ends, a: c.a, b: c.b };
        this.rip(c);
        if (loose() > base) { Object.assign(c, old); this.place(c, 1); } else { c.moot = true; this.stat.stubsRemoved = (this.stat.stubsRemoved || 0) + 1; }
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

  fenceVias: { p: Pt; net: string; cls: RuleClass; obj: any }[] = []; fenceReports: FenceReport[] = [];
  /** Ground vias beside high-frequency tracks and their layer changes.  Each one sits in the ground pour on at least
   *  two layers (else it would join nothing), keeps every clearance in the exact check, and stays a hole's width from
   *  the other ground vias. */
  fence(): void {
    const G = this.G, W = G.W, o = this.opts.fence; const fo = typeof o === "object" && o ? o : {}; const spacing = Math.max(0.6, fo.spacing || 2);
    const named = new Set(fo.nets || []); const wantFence = (n: string) => named.has(n) || this.kindOf(n) === "rf";
    const wantRet = (n: string) => fo.returnVias !== false && (wantFence(n) || this.kindOf(n) === "fast");
    const nets = new Map<string, Conn[]>(); for (const c of this.conns) if (c.nodes && (wantFence(c.net) || (wantRet(c.net) && c.viaCells.length))) { const l = nets.get(c.net) || []; nets.set(c.net, l); l.push(c); }
    if (!nets.size) return;
    const cover = (n: NetInfo) => n.pour!.mask.reduce((t, m) => t + (m ? 1 : 0), 0);
    const gnd = this.nets.filter((n) => n.pour && /(^|\/)[ADP]?(GND|VSS)\w*$/i.test(n.key) && cover(n) >= 2).sort((a, b) => cover(b) - cover(a))[0];
    if (!gnd) { for (const n of nets.keys()) this.fenceReports.push({ net: n, ground: "", fence: 0, returns: 0, spacing, note: "the board has no ground pour on two layers for the vias to join" }); return; }
    const pour = gnd.pour!, cls = gnd.cls; const pkey = `pour/${pour.width}/${pour.clr}`; let pcls = G.classes.get(pkey);
    if (!pcls) { pcls = buildClass(G, pkey, pour.width, pour.clr, cls.viaD, cls.viaDrill); for (const c of this.conns) if (c.nodes) for (const sh of c.shapes) stampClass(G, pcls, sh, 1, false); }
    const holes: Pt[] = []; for (const ob of G.obstacles.get(gnd.key) || []) if (ob.thru) holes.push(ob.thru); for (const c of gnd.conns) if (c.nodes) for (const gi of c.viaCells) holes.push(this.mm({ ix: gi % W, iy: (gi / W) | 0 }));
    const apart = cls.viaD + 0.25; const r = cls.viaD / 2; const all = G.layers.map((_, i) => i);
    this.lift(gnd, 1, cls); this.lift(gnd, 1, pcls); this.cur = null as any; this.curSoft = false;
    const tryAt = (x: number, y: number): boolean => {
      const ix = Math.round((x - G.ox) / G.g), iy = Math.round((y - G.oy) / G.g); if (ix < 1 || iy < 1 || ix >= W - 1 || iy >= G.H - 1) return false; const gi = iy * W + ix;
      if (!viaFits(G, cls.vfull, gi)) return false; let n = 0; for (let l = 0; l < pour.mask.length; l++) { const m = pour.mask[l]; if (m && m[gi] && !pcls!.full[l][gi]) n++; } if (n < 2) return false;
      const p = this.mm({ ix, iy }); if (holes.some((h) => Math.hypot(h[0] - p[0], h[1] - p[1]) < apart)) return false;
      const shape: Shape = { t: "circle", x: p[0], y: p[1], r }; for (const l of all) if (!this.clearOf(shape, l, gnd.key, cls.clr)) return false;
      holes.push(p); this.fenceVias.push({ p, net: gnd.key, cls, obj: gnd.obj }); const ob: Obstacle = { net: gnd.key, layers: all, shape, clr: cls.clr }; this.fenceShapes.push(ob); return true;
    };
    try {
      for (const [net, conns] of nets) {
        const rep: FenceReport = { net, ground: gnd.key, fence: 0, returns: 0, spacing }; this.fenceReports.push(rep); let wanted = 0;
        const clr = Math.max(conns[0].cls.clr, cls.clr, pour.clr);
        if (wantFence(net)) for (const c of conns) {
          let carry = spacing / 2;
          for (const sh of c.shapes) { const g = sh.shape as any; if (g.t !== "seg") continue; const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], len = Math.hypot(dx, dy); if (len < 1e-6) continue;
            const ux = dx / len, uy = dy / len; const off = g.r + clr + r + G.g;
            for (let t = carry; t <= len; t += spacing) { for (const sgn of [1, -1]) { wanted++; const bx = g.a[0] + ux * t, by = g.a[1] + uy * t;
              for (const [dt, extra] of [[0, 0], [0, G.g * 2], [spacing / 4, 0], [-spacing / 4, 0], [0, G.g * 4]] as Pt[]) if (tryAt(bx + ux * dt - uy * sgn * (off + extra), by + uy * dt + ux * sgn * (off + extra))) { rep.fence++; break; } } }
            carry = (carry - len) % spacing; if (carry < 0) carry += spacing; }
        }
        if (wantRet(net)) for (const c of conns) for (const gi of c.viaCells) {
          const v = this.mm({ ix: gi % W, iy: (gi / W) | 0 }); const d0 = c.cls.viaD / 2 + clr + r + G.g; let done = false;
          for (const d of [d0, d0 + 2 * G.g, d0 + 0.4, d0 + 0.8]) { for (let k = 0; k < 8 && !done; k++) { const a = k * Math.PI / 4; if (tryAt(v[0] + Math.cos(a) * d, v[1] + Math.sin(a) * d)) done = true; } if (done) break; }
          if (done) rep.returns++; else rep.note = "no room in the ground pour beside " + (rep.note ? "some layer changes" : "a layer change");
        }
        if (wantFence(net) && rep.fence < wanted) rep.note = (rep.note ? rep.note + "; " : "") + `${wanted - rep.fence} of ${wanted} fence positions had no room or no ground pour on two layers`;
      }
    } finally { this.lift(gnd, -1, pcls); this.lift(gnd, -1, cls); }
    for (const c of G.classes.values()) for (const ob of this.fenceShapes) stampClass(G, c, ob, 1, false);
  }
  fenceShapes: Obstacle[] = [];
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
  private domainReport(): DomainReport | undefined {
    if (!this.domains) return undefined; const kinds: Record<string, NetKind> = {};
    for (const n of this.G.obstacles.keys()) if (n) { const k = this.kindOf(n); if (k !== "digital" && k !== "supply") kinds[n] = k; }
    return { kinds, quiet: this.sepGaps.quiet, noisy: this.sepGaps.noisy, relaxed: Array.from(this.relaxed) };
  }
  ms = 0; passes = 0;
  result(): RouteResult {
    const ms = this.ms, passes = this.passes;
    const { P, doc, G } = this; const items: RouteItem[] = []; let segments = 0, vias = 0, length = 0, zoneEnds = 0; const failed: RouteResult["failed"] = [];
    const span = [G.layers[0], G.layers[G.layers.length - 1]];
    const connections: ConnReport[] = []; const end = (p: Pt) => { const pad = this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)); return pad ? { x: r6(p[0]), y: r6(p[1]), pad } : { x: r6(p[0]), y: r6(p[1]) }; };
    const viaSeen = new Set<string>();   // two connections of a net may each hold a via at the same spot: one is laid
    for (const c of this.conns) {
      if (c.moot && !c.nodes) continue;
      const ea = c.ends ? c.ends[0] : c.a, eb = c.ends ? c.ends[1] : c.b; const rep: ConnReport = { net: c.net, from: end(ea.p), to: end(eb.p), routed: !!c.nodes, length: 0, vias: 0, bends: 0, layers: [], detourRatio: 0 }; connections.push(rep);
      if (!c.nodes) { failed.push({ net: c.net, a: ea.p, b: eb.p }); Object.assign(rep, this.reports.get(c.id) || {}); continue; }
      { let len = 0; const ls = new Set<number>(); for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") { len += Math.hypot(sh.a[0] - sh.b[0], sh.a[1] - sh.b[1]); ls.add(o.layers[0]); } }
        rep.length = +len.toFixed(3); rep.vias = c.viaCells.length; rep.bends = c.feat ? c.feat.b45 + c.feat.b90 : 0; rep.layers = Array.from(ls).sort().map((l) => G.layers[l]); rep.detourRatio = c.len > 1e-6 ? +(len / c.len).toFixed(2) : 1; }
      const net = this.netOf(c.net).obj; if (c.zoneEnd) zoneEnds++;
      const seg = (a: Pt, b: Pt, l: number, w: number) => { if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return; items.push({ kind: "segment", node: P.segmentNode(doc, a, b, w, G.layers[l], net), net, netName: c.net, conn: c.id }); segments++; length += Math.hypot(a[0] - b[0], a[1] - b[1]); };
      for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") seg(sh.a, sh.b, o.layers[0], +(sh.r * 2).toFixed(4)); }   // stubs and runs, each at its own width
      for (const gi of c.viaCells) { const vk = c.net + "\n" + gi; if (viaSeen.has(vk)) continue; viaSeen.add(vk); const p = this.mm({ ix: gi % G.W, iy: (gi / G.W) | 0 }); items.push({ kind: "via", node: P.viaNode(doc, p[0], p[1], c.cls.viaD, c.cls.viaDrill, net, span), net, netName: c.net, conn: c.id }); vias++; }
    }
    for (const v of this.fenceVias) { items.push({ kind: "via", node: P.viaNode(doc, v.p[0], v.p[1], v.cls.viaD, v.cls.viaDrill, v.obj, span), net: v.obj, netName: v.net, conn: -1 }); vias++; }
    const total = this.conns.filter((c) => c.nodes || !c.moot).length;
    return { items, total, routed: total - failed.length, failed, segments, vias, length, ms, passes, zoneEnds, zoneCovered: this.zoneCovered,
      grid: { pitch: G.g, w: G.W, h: G.H, layers: G.layers.filter((_, i) => G.routable[i]) }, nets: this.nets.length, connections, pairs: Array.from(this.pairReports.values()), impedance: this.zReports, matched: this.matchReports, domains: this.domainReport(), fences: this.fenceReports };
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
