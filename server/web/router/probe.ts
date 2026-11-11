// Autorouter — the path search: a line-probe router (Mikami & Tabuchi's line search, on eight directions and
// several layers).  It is not a maze router and keeps no priority queue of cells: both ends shoot straight rays as
// far as they go; every cell of a ray spawns rays that turn 45° or 90° (or change layer through a via) one level
// later; the search widens level by level — a level is a corner — until rays from the two ends meet.  Every meeting
// is a complete candidate route with the fewest corners; the trained cost (weights.ts) picks among the candidates
// of the simplest levels.  Routes never turn back on themselves: a ray only spawns turns of at most 90°.
import { DX, DY, Grid, viaFits } from "./grid";
import type { Weights } from "./weights";

export interface Node { ix: number; iy: number; l: number }
export interface Features { length: number; vias: number; b45: number; b90: number; wrong: number }
export interface Terminal { ix: number; iy: number; layers: number[] }
export interface Win { x0: number; y0: number; x1: number; y1: number }
export interface ProbeInput {
  G: Grid; maps: Uint16Array[]; vmaps: Uint16Array[];
  src: Terminal; tgt: Terminal | null;
  term: Node[];                // cells of the target's copper the route may end on (a T-junction onto a track)
  win: Win; pref: number[];    // per layer: +1 runs horizontally, -1 vertically, 0 no habit
  W: Weights; allowVias: boolean; maxSteps: number;
  collect?: Features[];        // the trainer's hook: every candidate's features
  routable?: boolean[];        // this connection's own layer set (a plan may confine a net to some layers)
  maxVias?: number;            // candidates with more vias than this are not considered
  extra?: (nodes: Node[]) => number;   // a plan's own cost on top of the trained one
}
export interface ProbeResult { nodes: Node[]; feat: Features; cost: number; corners: number; onTerm: boolean; steps: number }

export const costOf = (f: Features, W: Weights) => f.length * W.length + f.vias * W.via + f.b45 * W.bend45 + f.b90 * W.bend90 + f.wrong * W.wrongDir;

/** Length, vias, corners and against-the-grain length of a route given as grid nodes. */
export function featuresOf(G: Grid, nodes: Node[], pref: number[]): Features {
  const f: Features = { length: 0, vias: 0, b45: 0, b90: 0, wrong: 0 }; let prev = -1;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (a.l !== b.l) { if (!G.thru[a.iy * G.W + a.ix]) f.vias++; prev = -1; continue; }
    const dx = b.ix - a.ix, dy = b.iy - a.iy; if (!dx && !dy) continue;
    const diag = dx !== 0 && dy !== 0; const len = Math.max(Math.abs(dx), Math.abs(dy)) * G.g * (diag ? Math.SQRT2 : 1);
    const dir = dirOf(dx, dy);
    f.length += len; const p = pref[a.l] || 0;
    f.wrong += diag ? len * Math.abs(p) / 2 : dy === 0 ? len * Math.max(0, -p) : len * Math.max(0, p);
    if (prev >= 0 && dir !== prev) { let d = Math.abs(dir - prev); d = Math.min(d, 8 - d); if (d === 1) f.b45++; else f.b90 += d - 1; }
    prev = dir;
  }
  return f;
}
export function dirOf(dx: number, dy: number): number {
  const sx = Math.sign(dx), sy = Math.sign(dy);
  for (let d = 0; d < 8; d++) if (DX[d] === sx && DY[d] === sy) return d;
  return 0;
}

export function probe(inp: ProbeInput): ProbeResult | null {
  const { G, maps, vmaps, win, W } = inp; const RT = inp.routable || G.routable; const ww = win.x1 - win.x0 + 1, wh = win.y1 - win.y0 + 1, n = ww * wh, L = G.layers.length;
  if (ww <= 0 || wh <= 0) return null;
  const inWin = (t: Terminal) => t.ix >= win.x0 && t.ix <= win.x1 && t.iy >= win.y0 && t.iy <= win.y1;
  if (!inWin(inp.src) || (inp.tgt && !inWin(inp.tgt))) return null;
  const seen: Uint8Array[][] = [[], []], own: Int32Array[][] = [[], []]; const term: (Uint8Array | null)[] = [];
  for (let l = 0; l < L; l++) {
    for (let s = 0; s < 2; s++) { seen[s].push(RT[l] ? new Uint8Array(n) : (null as unknown as Uint8Array)); own[s].push(RT[l] ? new Int32Array(n).fill(-1) : (null as unknown as Int32Array)); }
    term.push(null);
  }
  let hasTerm = false;
  for (const t of inp.term) {
    if (!RT[t.l] || t.ix < win.x0 || t.ix > win.x1 || t.iy < win.y0 || t.iy > win.y1) continue;
    (term[t.l] || (term[t.l] = new Uint8Array(n)))[(t.iy - win.y0) * ww + (t.ix - win.x0)] = 1; hasTerm = true;
  }
  if (!inp.tgt && !hasTerm) return null;
  const viaCache = new Uint8Array(n);
  const rl: number[] = [], rd: number[] = [], rs: number[] = [], rn: number[] = [], rp: number[] = [], rv: number[] = [], rside: number[] = [];
  const buckets: number[][][] = [[], []];
  let steps = 0, meets = 0, best: ProbeResult | null = null, bestCorners = Infinity;
  const multi = RT.filter(Boolean).length > 1; const maxVias = inp.maxVias === undefined ? Infinity : inp.maxVias;
  const viaLevel = Math.max(1, Math.round(W.viaLevel));

  const toNode = (li: number, l: number): Node => ({ ix: win.x0 + li % ww, iy: win.y0 + ((li / ww) | 0), l });
  const chain = (id: number, li: number): Node[] => {
    const out: Node[] = [toNode(li, rl[id])]; let last = li, r = id;
    while (r >= 0) {
      if (rs[r] !== last) { out.push(toNode(rs[r], rl[r])); last = rs[r]; }
      const p = rp[r]; if (p >= 0 && rl[p] !== rl[r]) out.push(toNode(rs[r], rl[p]));
      r = p;
    }
    return out;
  };
  const consider = (nodes: Node[], corners: number, onTerm: boolean) => {
    const feat = featuresOf(G, nodes, inp.pref); meets++; if (feat.vias > maxVias) return;
    const cost = costOf(feat, W) + (inp.extra ? inp.extra(nodes) : 0);
    if (inp.collect && inp.collect.length < 4000) inp.collect.push(feat);
    if (corners < bestCorners) bestCorners = corners;
    if (!best || cost < best.cost) best = { nodes, feat, cost, corners, onTerm, steps };
  };
  const meet = (sId: number, li: number, tId: number) => {
    if (meets > 20000) return;
    const ds = rd[sId], dt = rd[tId]; let turn = 0;
    if (ds >= 0 && dt >= 0) { const rev = (dt + 4) & 7; let d = Math.abs(ds - rev); d = Math.min(d, 8 - d); if (d > 2) return; turn = d ? 1 : 0; }
    const a = chain(sId, li).reverse(), b = chain(tId, li);
    consider(a.concat(b.slice(1)), rv[sId] + rv[tId] + turn, false);
  };
  const meetTerm = (sId: number, li: number) => { if (meets <= 20000) consider(chain(sId, li).reverse(), rv[sId], true); };

  const addRay = (side: number, l: number, d: number, sx: number, sy: number, startLi: number, parent: number, level: number): void => {
    const m = maps[l], sn = seen[side][l], ow = own[side][l], oo = own[1 - side][l], tm = side === 0 ? term[l] : null, bit = 1 << d;
    let x = sx + DX[d], y = sy + DY[d];
    if (x < 0 || y < 0 || x >= ww || y >= wh || m[(y + win.y0) * G.W + x + win.x0] || (sn[y * ww + x] & bit)) { steps++; return; }
    const id = rl.length; let len = 0, lastMeet = -2; const dx = DX[d], dy = DY[d], dl = dy * ww + dx, dg = dy * G.W + dx;
    rl.push(l); rd.push(d); rs.push(startLi); rn.push(0); rp.push(parent); rv.push(level); rside.push(side);
    let li = y * ww + x, gi = (y + win.y0) * G.W + x + win.x0;
    while (x >= 0 && y >= 0 && x < ww && y < wh) {
      if (m[gi] || (sn[li] & bit)) break;
      sn[li] |= bit; if (ow[li] < 0) ow[li] = id;
      const o = oo[li]; if (o >= 0 && o !== lastMeet) { lastMeet = o; if (side === 0) meet(id, li, o); else meet(o, li, id); }
      if (tm && tm[li]) meetTerm(id, li);
      len++; x += dx; y += dy; li += dl; gi += dg;
    }
    steps += len + 1;
    rn[id] = len; (buckets[side][level] || (buckets[side][level] = [])).push(id);
  };
  /** A point the route may leave in any direction: an end of the connection, or the far side of a via. */
  const hub = (side: number, l: number, x: number, y: number, parent: number, level: number): void => {
    const li = y * ww + x, id = rl.length;
    rl.push(l); rd.push(-1); rs.push(li); rn.push(0); rp.push(parent); rv.push(level); rside.push(side);
    if (own[side][l][li] < 0) own[side][l][li] = id;
    const o = own[1 - side][l][li]; if (o >= 0) { if (side === 0) meet(id, li, o); else meet(o, li, id); }
    if (side === 0 && term[l] && term[l]![li]) meetTerm(id, li);
    const sn = seen[side][l];
    for (let d = 0; d < 8; d++) if (!(sn[li] & (1 << d))) { sn[li] |= 1 << d; addRay(side, l, d, x, y, li, id, level); }
  };
  const viaOk = (li: number, x: number, y: number): boolean => {
    let v = viaCache[li]; if (!v) { v = viaFits(G, vmaps, (y + win.y0) * G.W + x + win.x0) ? 1 : 2; viaCache[li] = v; }
    return v === 1;
  };
  const TURNS = [1, 7, 2, 6];
  const expand = (id: number): void => {
    const side = rside[id], l = rl[id], d = rd[id], lvl = rv[id], sn = seen[side][l]; const s = rs[id]; let x = s % ww, y = (s / ww) | 0;
    for (let i = 0; i < rn[id]; i++) {
      x += DX[d]; y += DY[d]; const li = y * ww + x;
      for (const t of TURNS) { const d2 = (d + t) & 7, bit = 1 << d2; if (!(sn[li] & bit)) { sn[li] |= bit; addRay(side, l, d2, x, y, li, id, lvl + 1); } }
      if (!multi) continue;
      const gi = (y + win.y0) * G.W + x + win.x0; const free = G.thru[gi] !== 0;
      if (!free && !(inp.allowVias && viaOk(li, x, y))) continue;
      for (let l2 = 0; l2 < L; l2++) if (l2 !== l && RT[l2] && !maps[l2][gi] && seen[side][l2][li] !== 255) hub(side, l2, x, y, id, lvl + (free ? 1 : viaLevel));
    }
  };

  // level 0: the two ends
  const start = (side: number, t: Terminal) => { for (const l of t.layers) if (RT[l]) hub(side, l, t.ix - win.x0, t.iy - win.y0, -1, 0); };
  if (inp.tgt) start(1, inp.tgt);
  start(0, inp.src);
  for (let k = 0; k < 64; k++) {
    if (best && bestCorners <= k + 1 - W.extraLevels) break;
    if (steps > inp.maxSteps) break;
    let any = false;
    for (let side = 0; side < 2; side++) {
      const b = buckets[side][k]; if (!b) continue;
      for (let i = 0; i < b.length; i++) { expand(b[i]); if (steps > inp.maxSteps) break; }
      any = true;
    }
    if (!any) { let more = false; for (let side = 0; side < 2; side++) for (let j = k + 1; j < buckets[side].length; j++) if (buckets[side][j] && buckets[side][j].length) more = true; if (!more) break; }
  }
  if (best) (best as ProbeResult).steps = steps;
  return best;
}
