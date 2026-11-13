// Component placement — heuristics, not a search over the whole board.  It works the way a person lays a board out:
//   1. every functional group (a regulator with its passives, an MCU with its decoupling and crystal …) is laid out
//      on its own as a tight block around its anchor part, each small part as close as it legally fits to the pin
//      it serves;
//   2. the blocks are then rigid pieces: parts the mechanics pin down (fixed, or on a board edge) go first, the
//      other blocks are put down largest first where their connections to what is already placed are shortest,
//      trying the four rotations, and are then revisited once everything is down.
// Nets that reach everywhere (ground, the rails) do not pull, or everything would collapse into the middle.
// Who belongs to which group, the anchors and the edges come from the caller (the assistant's model, or a person);
// without them, small parts join the larger part they share their most specific net with.
// Pure: reads the board, returns positions; nothing is written here.
import { isSupply, refOf } from "./route";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pt = [number, number];
export type Box = [number, number, number, number];
export interface PlaceSpec {
  ref: string; group?: string; near?: string; side?: "front" | "back";
  fixed?: { x: number; y: number; rot?: number } | boolean;
  edge?: "left" | "right" | "top" | "bottom"; rot?: number; anchor?: boolean;
}
export interface PlaceOptions { footprints?: PlaceSpec[]; outline?: Box; spacing?: number; grid?: number; fit?: boolean; maxFill?: number }
export interface Placement { ref: string; id: string; x: number; y: number; rot: number; side: "front" | "back"; group: string }
export interface PlaceScore { ratsnest: number; overlaps: number; courtyardClashes: number; outside: number; area: number; clashes: [string, string][]; outsideRefs: string[] }
export interface PlaceResult { placements: Placement[]; score: PlaceScore; outline: Box; outlineFromBoard: boolean; groups: { name: string; anchor: string; refs: string[]; box: Box }[]; unknown: string[] }

interface Pad { x: number; y: number; net: string; thru: boolean }
interface Part {
  ref: string; id: string; node: any; sheet: string; cur: [number, number, number]; flip: boolean; back: boolean; thru: boolean;
  pads: Pad[]; box: Box; padBox: Box; holes: Box[];   // in the part's own frame; holes: what its drilled pads take on the other side (origin at its anchor, rotation 0)
  spec: PlaceSpec | null; movable: boolean; group: string;
  x: number; y: number; rot: number; placed: boolean;   // in its block's frame, then on the board
}
interface Block { name: string; parts: Part[]; anchor: Part; box: Box; padBox: Box; x: number; y: number; rot: number; placed: boolean; fixed: boolean; edge: string | null }

const GROUNDISH = /^\/?(.*\/)?([ADP]?GND\w*|VSS\w*|EARTH)$/i;
/** Do segments ab and cd cross (sharing an end is not a crossing)? */
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => { const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1; };
  const same = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6; if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function segDist(px: number, py: number, a: Pt, b: Pt): number { const vx = b[0] - a[0], vy = b[1] - a[1]; const L = vx * vx + vy * vy; const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L)); return Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy); }
const rotv = (deg: number, x: number, y: number): Pt => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; };
const norm = (d: number) => ((Math.round(d) % 360) + 360) % 360;
const r3 = (v: number) => { const x = +v.toFixed(3); return x === 0 ? 0 : x; };
/** The bounding box of a box turned by a multiple of 90° (any angle works, the box just grows). */
function turnBox(b: Box, deg: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) { const p = rotv(deg, x, y); x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
}
const shift = (b: Box, x: number, y: number): Box => [b[0] + x, b[1] + y, b[2] + x, b[3] + y];
const hit = (a: Box, b: Box, gap: number) => a[0] < b[2] + gap - 1e-6 && a[2] > b[0] - gap + 1e-6 && a[1] < b[3] + gap - 1e-6 && a[3] > b[1] - gap + 1e-6;
const GLOBAL_NAME = /^\/?(GND|AGND|DGND|PGND|VSS|VCC|VDD|VBUS|VIN|VBAT|\+?\d+V\d*|\+?\d+\.\d+V|\+\d*V\d*[A-Z]*)$/i;

function partOf(K: any, P: any, doc: any, it: any, spec: PlaceSpec | null): Part {
  let node = it.node; const cur = K.atOf(it.node) as [number, number, number]; const layer = K.kid(node, "layer"); const isBack = !!layer && K.str(layer[1]) === "B.Cu";
  const wantBack = spec && spec.side ? spec.side === "back" : isBack; const flip = wantBack !== isBack;
  if (flip) { node = structuredClone(node); P.flipNode(node, cur[0], doc); }
  const [fx, fy, frot] = K.atOf(node); const pads: Pad[] = []; const holes: Box[] = []; let pb: Box = [Infinity, Infinity, -Infinity, -Infinity]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; let thru = false;
  const take = (ax: number, ay: number, m: number) => { const [lx, ly] = rotv(-frot, ax - fx, ay - fy); x0 = Math.min(x0, lx - m); y0 = Math.min(y0, ly - m); x1 = Math.max(x1, lx + m); y1 = Math.max(y1, ly + m); return [lx, ly]; };
  for (const p of P.padsOf({ node })) {
    const t = p.type === "thru_hole" || p.type === "np_thru_hole"; if (t) thru = true;
    const [lx, ly] = rotv(-frot, p.x - fx, p.y - fy); pads.push({ x: lx, y: ly, net: p.net && p.net.name ? p.net.name : "", thru: t }); { const m = Math.max(p.w, p.h) / 2; pb = [Math.min(pb[0], lx - m), Math.min(pb[1], ly - m), Math.max(pb[2], lx + m), Math.max(pb[3], ly + m)]; } if (t) { const m = Math.max(p.w, p.h) / 2; holes.push([lx - m, ly - m, lx + m, ly + m]); }
  }
  let any = false; const cy = P.courtyards({ node });
  for (const k of Object.keys(cy)) for (const loop of cy[k]) for (const q of loop) { take(q[0], q[1], 0); any = true; }
  if (!any) for (const p of P.padsOf({ node })) take(p.x, p.y, Math.max(p.w, p.h) / 2 + 0.25);
  if (x0 > x1) { x0 = y0 = -0.5; x1 = y1 = 0.5; }
  const sh = K.kid(it.node, "sheetname") || K.kid(it.node, "path");
  return { ref: refOf(K, it.node), id: it.id, node: it.node, sheet: sh ? K.str(sh[1]).replace(/\/[^/]*$/, "") : "", cur, flip, back: wantBack, thru, pads, box: [x0, y0, x1, y1], padBox: pb[0] <= pb[2] ? pb : [x0, y0, x1, y1], holes, spec, movable: false, group: "", x: 0, y: 0, rot: 0, placed: false };
}

export function place(K: any, P: any, doc: any, settings: any, opts: PlaceOptions = {}): PlaceResult {
  void settings; const gap = opts.spacing !== undefined ? Math.max(0, +opts.spacing) : 0.5; const specs = new Map<string, PlaceSpec>(); for (const s of opts.footprints || []) if (s && s.ref) specs.set(s.ref, s);
  const all: Part[] = []; const byRef = new Map<string, Part>();
  for (const it of doc.items.values()) if (it.kind === "footprint") { const ref = refOf(K, it.node); const p = partOf(K, P, doc, it, specs.get(ref) || null); all.push(p); if (ref && !byRef.has(ref)) byRef.set(ref, p); }
  const unknown = Array.from(specs.keys()).filter((r) => !byRef.has(r));
  const listed = specs.size > 0;

  // ---- nets: which ones pull
  const netPads = new Map<string, number>(); let total = 0; for (const p of all) for (const d of p.pads) if (d.net) { netPads.set(d.net, (netPads.get(d.net) || 0) + 1); total++; }
  const wide = Math.max(8, total * 0.12); const weight = new Map<string, number>();
  for (const [n, c] of netPads) weight.set(n, c < 2 ? 0 : GLOBAL_NAME.test(n) || c > wide ? 0.03 : 1 / Math.sqrt(c - 1));
  const w = (n: string) => weight.get(n) || 0;
  // Without a list, everything unlocked moves, except parts nothing connects to (mounting holes, fiducials, logos):
  // where those sit is a mechanical decision.
  for (const p of all) p.movable = listed ? !!p.spec && !(p.spec.fixed === true) : !(P.isLocked && P.isLocked(p.node)) && p.pads.some((d) => (netPads.get(d.net) || 0) > 1);
  const moving = all.filter((p) => p.movable), still = all.filter((p) => !p.movable);

  // ---- groups
  const groupOf = new Map<string, Part[]>(); const join = (g: string, p: Part) => { p.group = g; let l = groupOf.get(g); if (!l) groupOf.set(g, l = []); l.push(p); };
  const loose: Part[] = [];
  const isFixed = (p: Part) => !!p.spec && typeof p.spec.fixed === "object" && !!p.spec.fixed; const hasFixed = new Set<string>(), hasEdge = new Set<string>(); let solo = 0;
  for (const p of moving) {
    if (!(p.spec && p.spec.group)) { loose.push(p); continue; }
    // a group moves as one piece, so it can hold only one pinned part: any further ones stand on their own
    if (isFixed(p)) { if (hasFixed.has(p.spec.group)) { join(p.spec.group + "~" + (++solo), p); continue; } hasFixed.add(p.spec.group); }
    // and only one part on a board edge: a group of three headers, each on its own edge, is three pieces
    if (p.spec.edge) { if (hasEdge.has(p.spec.group)) { join(p.spec.group + "~" + (++solo), p); continue; } hasEdge.add(p.spec.group); }
    join(p.spec.group, p);
  }
  for (const p of loose) if (p.spec && p.spec.near && byRef.get(p.spec.near) && byRef.get(p.spec.near)!.group) join(byRef.get(p.spec.near)!.group, p);
  const rest = loose.filter((p) => !p.group); const big = rest.filter((p) => p.pads.length > 3 || !!(p.spec && (p.spec.edge || p.spec.fixed)));
  for (const p of big) join("~" + p.ref, p);
  for (const p of rest) {
    if (p.group) continue; let best: Part | null = null, bs = 0;
    for (const q of big) { let s = 0; for (const a of p.pads) for (const b of q.pads) if (a.net && a.net === b.net) s += w(a.net); if (p.sheet && p.sheet === q.sheet) s *= 2; if (s > bs) { bs = s; best = q; } }
    join(best ? best.group : "~" + p.ref, p);
  }

  // ---- 1. each group as a block around its anchor
  const blocks: Block[] = [];
  const padAt = (p: Part, d: Pad): Pt => { const [x, y] = rotv(p.rot, d.x, d.y); return [p.x + x, p.y + y]; };
  const boxAt = (p: Part): Box => shift(turnBox(p.box, p.rot), p.x, p.y);
  // Parts on opposite sides only get in each other's way where one of them is drilled through the board.
  interface Geo { p: Part; b: Box; rot: number; x: number; y: number }
  const geo = (p: Part, rot: number, x: number, y: number): Geo => ({ p, b: shift(turnBox(p.box, rot), x, y), rot, x, y });
  const holesAt = (a: Geo) => a.p.holes.map((h) => shift(turnBox(h, a.rot), a.x, a.y));
  const clash = (a: Geo, b: Geo, g: number) => {
    if (!hit(a.b, b.b, g)) return false; if (a.p.back === b.p.back) return true; if (!a.p.thru && !b.p.thru) return false;
    for (const h of holesAt(a)) if (hit(h, b.b, g)) return true; for (const h of holesAt(b)) if (hit(h, a.b, g)) return true;
    if (a.p.thru && b.p.thru) return false; return false;
  };
  for (const [name, parts] of groupOf) {
    const anchor = parts.find(isFixed) || parts.find((p) => p.spec && p.spec.anchor) || parts.slice().sort((a, b) => b.pads.length - a.pads.length || (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
    anchor.x = 0; anchor.y = 0; anchor.rot = 0; anchor.placed = true; const down: Part[] = [anchor];
    const pull = (p: Part) => { let s = 0; for (const a of p.pads) for (const q of down) for (const b of q.pads) if (a.net && a.net === b.net) s += w(a.net); return s; };
    const todo = parts.filter((p) => p !== anchor);
    while (todo.length) {
      // next: the part most tied to what is down (a part asked to sit near one that is down goes before the others)
      todo.sort((a, b) => (+(!!b.spec && !!b.spec.near && down.some((q) => q.ref === b.spec!.near)) - +(!!a.spec && !!a.spec.near && down.some((q) => q.ref === a.spec!.near))) || pull(b) - pull(a) || b.pads.length - a.pads.length);
      const p = todo.shift()!; const nearPart = p.spec && p.spec.near ? down.find((q) => q.ref === p.spec!.near) || null : null;
      // what it wants to be next to: the pads it shares its most specific nets with (on the `near` part if one is named)
      const targets: { at: Pt; wt: number; net: string }[] = [];
      for (const q of nearPart ? [nearPart] : down) for (const b of q.pads) if (b.net && p.pads.some((a) => a.net === b.net)) targets.push({ at: padAt(q, b), wt: w(b.net), net: b.net });
      if (nearPart && !targets.length) targets.push({ at: [nearPart.x, nearPart.y], wt: 1, net: "" });
      let focus: Pt = [0, 0]; { let bw = -1; for (const t of targets) if (t.wt > bw) { bw = t.wt; focus = t.at; } }
      // the part's own body, for "does a line run back over it": the pads' box shrunk to its middle
      const size = Math.max(p.box[2] - p.box[0], p.box[3] - p.box[1]);
      const core = Math.max(0.15, Math.min(p.padBox[2] - p.padBox[0], p.padBox[3] - p.padBox[1]) * 0.35);
      const cost = (rot: number, x: number, y: number) => {
        let c = 0; const lines: [Pt, Pt][] = [];
        for (const a of p.pads) { if (!a.net) continue; let dmin = Infinity, best: Pt | null = null; const [dx, dy] = rotv(rot, a.x, a.y); const at: Pt = [x + dx, y + dy];
          for (const t of targets) if (t.net === a.net) { const d = Math.hypot(t.at[0] - at[0], t.at[1] - at[1]); if (d < dmin) { dmin = d; best = t.at; } }
          if (dmin < Infinity) { c += dmin * Math.max(w(a.net), 0.03); if (best && !GROUNDISH.test(a.net) && !isSupply(a.net)) lines.push([at, best]); } }
        // signal pins facing their nets (ground and supplies drop to a plane or run wide round the part): each crossing of two of its rat lines is a via or a loop, each line back over the part a detour round it
        let pen = 0; for (let i = 0; i < lines.length; i++) { for (let j = i + 1; j < lines.length; j++) if (crosses(lines[i][0], lines[i][1], lines[j][0], lines[j][1])) pen += 1;
          const [a, b] = lines[i]; if (Math.hypot(b[0] - x, b[1] - y) > Math.hypot(a[0] - x, a[1] - y) && segDist(x, y, a, b) < core) pen += 0.6; }
        return c + pen * Math.max(1, size * 0.8) + Math.hypot(x - focus[0], y - focus[1]) * (nearPart ? 0.3 : 0.02) + Math.hypot(x, y) * 0.005;
      };
      const step = 0.25; let best: { c: number; rot: number; x: number; y: number } | null = null; const rots = p.spec && p.spec.rot !== undefined ? [norm(p.spec.rot)] : [0, 90, 180, 270];
      let found = Infinity;
      for (let ring = 0; ring < 400 && ring * step <= found + size + 1.5; ring++) {
        for (let i = -ring; i <= ring; i++) for (const [ox, oy] of ring === 0 ? [[0, 0]] : [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
          if (ring && Math.abs(ox) === ring && Math.abs(oy) === ring && (ox !== i)) continue;
          const x = Math.round(focus[0] / step) * step + ox * step, y = Math.round(focus[1] / step) * step + oy * step;
          for (const rot of rots) {
            const ge = geo(p, rot, x, y); if (down.some((q) => clash(ge, geo(q, q.rot, q.x, q.y), gap))) continue;
            if (found === Infinity) found = ring * step; const c = cost(rot, x, y); if (!best || c < best.c) best = { c, rot, x, y };
          }
        }
      }
      if (best) { p.x = best.x; p.y = best.y; p.rot = best.rot; } else { p.x = focus[0]; p.y = focus[1]; p.rot = 0; }
      p.placed = true; down.push(p);
    }
    let box: Box = [Infinity, Infinity, -Infinity, -Infinity], padBox: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of parts) { const b = boxAt(p); box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]; const q = shift(turnBox(p.padBox, p.rot), p.x, p.y); padBox = [Math.min(padBox[0], q[0]), Math.min(padBox[1], q[1]), Math.max(padBox[2], q[2]), Math.max(padBox[3], q[3])]; }
    const edgePart = parts.find((p) => p.spec && p.spec.edge); const fixedPart = parts.find((p) => p.spec && typeof p.spec.fixed === "object" && p.spec.fixed);
    blocks.push({ name, parts, anchor: fixedPart || edgePart || anchor, box, padBox, x: 0, y: 0, rot: 0, placed: false, fixed: !!fixedPart, edge: edgePart ? edgePart.spec!.edge! : null });
  }

  // ---- the board
  let outline: Box | null = opts.outline && opts.outline.length === 4 ? [Math.min(opts.outline[0], opts.outline[2]), Math.min(opts.outline[1], opts.outline[3]), Math.max(opts.outline[0], opts.outline[2]), Math.max(opts.outline[1], opts.outline[3])] : null; let fromBoard = false;
  if (!outline) { const o = P.boardOutline(doc).outline as Pt[] | null; if (o) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of o) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } outline = [x0, y0, x1, y1]; fromBoard = true; } }
  if (!outline) {   // no outline yet: a board with room for the blocks and the routing between them
    let area = 0, widest = 0; for (const b of blocks) { const bw = b.box[2] - b.box[0] + 2 * gap, bh = b.box[3] - b.box[1] + 2 * gap; area += bw * bh; widest = Math.max(widest, bw, bh); }
    for (const p of still) area += (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
    const side = Math.max(widest + 4, Math.ceil(Math.sqrt(area * 2.2))); outline = [100, 100, 100 + side, 100 + side];
  }
  const inset = Math.max(gap, 0.3);
  // what the grouping left: each attempt at a board size starts from it
  const partState = all.map((p) => ({ p, x: p.x, y: p.y, rot: p.rot, placed: p.placed })); const blocks0 = blocks.map((b) => Object.assign({}, b));
  const arrange = (O: Box, coarse = 1) => {
  for (const st of partState) { st.p.x = st.x; st.p.y = st.y; st.p.rot = st.rot; st.p.placed = st.placed; }
  blocks.length = 0; for (const b of blocks0) blocks.push(Object.assign({}, b, { parts: b.parts.slice(), x: 0, y: 0, rot: 0, placed: false }));
  let squeezed = 0;

  // ---- 2. the blocks on the board
  const stillBoxes: Geo[] = still.map((p) => geo(p, p.cur[2], p.cur[0], p.cur[1]));
  const placedPads = new Map<string, Pt[]>(); const addPad = (net: string, at: Pt) => { let l = placedPads.get(net); if (!l) placedPads.set(net, l = []); l.push(at); };
  for (const p of still) for (const d of p.pads) if (d.net) { const [x, y] = rotv(p.cur[2], d.x, d.y); addPad(d.net, [p.cur[0] + x, p.cur[1] + y]); }
  const blockPads = (b: Block) => { const out: { x: number; y: number; net: string }[] = []; for (const p of b.parts) for (const d of p.pads) if (d.net && w(d.net) > 0) { const [x, y] = padAt(p, d); out.push({ x, y, net: d.net }); } return out; };
  const partBoxes = (b: Block, rot: number, x: number, y: number): Geo[] => b.parts.map((p) => { const [px, py] = rotv(rot, p.x, p.y); return geo(p, p.rot + rot, x + px, y + py); });
  const rebuildPads = () => { placedPads.clear(); for (const p of still) for (const d of p.pads) if (d.net) { const [x, y] = rotv(p.cur[2], d.x, d.y); addPad(d.net, [p.cur[0] + x, p.cur[1] + y]); } for (const b of blocks) if (b.placed) for (const d of blockPads(b)) { const [x, y] = rotv(b.rot, d.x, d.y); addPad(d.net, [b.x + x, b.y + y]); } };
  const legal = (b: Block, rot: number, x: number, y: number) => {
    // every part's pads and courtyard on the board; only the connector of a block on an edge may hang over that edge
    const bb = shift(turnBox(b.box, rot), x, y), pb = shift(turnBox(b.padBox, rot), x, y);
    if (pb[0] < O[0] + inset - 1e-6 || pb[1] < O[1] + inset - 1e-6 || pb[2] > O[2] - inset + 1e-6 || pb[3] > O[3] - inset + 1e-6) { if (!b.edge || !edgeOk(b, bb)) return false; }
    if (!inside(bb, O, 0)) for (const q of partBoxes(b, rot, x, y)) { if (b.edge && q.p === b.anchor) { if (!edgeOk(b, q.b)) return false; continue; } if (!inside(q.b, O, inset)) return false; }
    return free(b, rot, x, y, bb);
  };
  const inside = (q: Box, o: Box, m: number) => q[0] >= o[0] + m - 1e-6 && q[1] >= o[1] + m - 1e-6 && q[2] <= o[2] - m + 1e-6 && q[3] <= o[3] - m + 1e-6;
  const edgeOk = (b: Block, bb: Box) => bb[0] >= O[0] - 1e-6 - (b.edge === "left" ? 1e3 : 0) && bb[1] >= O[1] - 1e-6 - (b.edge === "top" ? 1e3 : 0) && bb[2] <= O[2] + 1e-6 + (b.edge === "right" ? 1e3 : 0) && bb[3] <= O[3] + 1e-6 + (b.edge === "bottom" ? 1e3 : 0);
  const free = (b: Block, rot: number, x: number, y: number, bb: Box) => {
    let mine: Geo[] | null = null;
    for (const o of blocks) { if (o === b || !o.placed) continue; const ob = shift(turnBox(o.box, o.rot), o.x, o.y); if (!hit(bb, ob, gap)) continue; mine = mine || partBoxes(b, rot, x, y); const theirs = partBoxes(o, o.rot, o.x, o.y); for (const a of mine) for (const t of theirs) if (clash(a, t, gap)) return false; }
    for (const t of stillBoxes) { if (!hit(bb, t.b, gap)) continue; mine = mine || partBoxes(b, rot, x, y); for (const a of mine) if (clash(a, t, gap)) return false; }
    return true;
  };
  const cx = (O[0] + O[2]) / 2, cy = (O[1] + O[3]) / 2;
  // A block nearly as long as the board (a pin header, a card-edge connector) only fits along an edge, and has to
  // go down before the middle fills up.
  const long = (b: Block) => Math.max(b.box[2] - b.box[0], b.box[3] - b.box[1]) >= 0.6 * Math.max(O[2] - O[0], O[3] - O[1]);
  let hug: Block | null = null;
  const costAt = (pads: { x: number; y: number; net: string }[], rot: number, x: number, y: number) => {
    let c = 0, tied = 0;
    if (hug) { const bb = shift(turnBox(hug.padBox, rot), x, y); const wide = bb[2] - bb[0] >= bb[3] - bb[1]; c += 2 * (wide ? Math.min(bb[1] - O[1], O[3] - bb[3]) : Math.min(bb[0] - O[0], O[2] - bb[2])); }
    for (const d of pads) { const l = placedPads.get(d.net); if (!l) continue; const [dx, dy] = rotv(rot, d.x, d.y); let dmin = Infinity; for (const q of l) { const v = Math.abs(q[0] - x - dx) + Math.abs(q[1] - y - dy); if (v < dmin) dmin = v; } c += dmin * w(d.net); tied++; }
    return c + (Math.abs(x - cx) + Math.abs(y - cy)) * (tied ? 0.01 : 0.2);
  };
  const g = coarse * (opts.grid && opts.grid > 0 ? opts.grid : Math.max(0.5, Math.min(1.27, Math.round(Math.max(O[2] - O[0], O[3] - O[1]) / 80 * 4) / 4)));
  const put = (b: Block, grid = g): boolean => {
    hug = long(b) && !b.edge ? b : null; const pads = blockPads(b); const ap = b.anchor; const spec = ap.spec;
    if (b.fixed && spec && typeof spec.fixed === "object" && spec.fixed) {   // the pinned part lands exactly where asked; its block comes with it
      const rot = norm((spec.fixed.rot !== undefined ? spec.fixed.rot : spec.rot !== undefined ? spec.rot : ap.cur[2]) - ap.rot); const [px, py] = rotv(rot, ap.x, ap.y);
      b.rot = rot; b.x = spec.fixed.x - px; b.y = spec.fixed.y - py; b.placed = true; return true;
    }
    let rots = [0, 90, 180, 270];
    if (spec && spec.rot !== undefined) rots = [norm(spec.rot - ap.rot)];
    else if (b.edge) {   // a connector faces out: its pads sit towards the inside of the board
      const pc = ap.pads.length ? ap.pads.reduce((s, d) => [s[0] + d.x / ap.pads.length, s[1] + d.y / ap.pads.length], [0, 0]) : [0, 0]; const bc = [(ap.box[0] + ap.box[2]) / 2, (ap.box[1] + ap.box[3]) / 2];
      const inward: Pt = b.edge === "left" ? [1, 0] : b.edge === "right" ? [-1, 0] : b.edge === "top" ? [0, 1] : [0, -1]; let bestDot = -Infinity, pick = rots;
      for (const r of [0, 90, 180, 270]) { const v = rotv(r + ap.rot, pc[0] - bc[0], pc[1] - bc[1]); const dot = v[0] * inward[0] + v[1] * inward[1]; if (dot > bestDot + 1e-6) { bestDot = dot; pick = [r]; } else if (Math.abs(dot - bestDot) <= 1e-6) pick = pick.concat(r); }
      if (Math.hypot(pc[0] - bc[0], pc[1] - bc[1]) > 0.2) rots = pick;
      else {   // pads in the middle of the body (a pin header): it lies along the edge, not across it
        const along = (r: number) => { const t = turnBox(ap.box, ap.rot + r); return b.edge === "top" || b.edge === "bottom" ? t[2] - t[0] >= t[3] - t[1] - 1e-6 : t[3] - t[1] >= t[2] - t[0] - 1e-6; };
        const lying = rots.filter(along); if (lying.length) rots = lying;
      }
    }
    let best: { c: number; rot: number; x: number; y: number } | null = null;
    for (const rot of rots) {
      const tb = turnBox(b.edge ? b.box : b.padBox, rot);
      if (b.edge) {   // slide along the edge, the named part's body flush with it
        const [ax, ay] = rotv(rot, ap.x, ap.y); const abx = turnBox(ap.box, ap.rot + rot); const horiz = b.edge === "top" || b.edge === "bottom";
        const fx = b.edge === "left" ? O[0] - (ax + abx[0]) : O[2] - (ax + abx[2]), fy = b.edge === "top" ? O[1] - (ay + abx[1]) : O[3] - (ay + abx[3]);
        const lo = horiz ? O[0] + inset - tb[0] : O[1] + inset - tb[1], hi = horiz ? O[2] - inset - tb[2] : O[3] - inset - tb[3];
        for (let v = Math.ceil(lo / grid) * grid; v <= hi + 1e-6; v += grid / 2) { const x = horiz ? v : fx, y = horiz ? fy : v; if (!legal(b, rot, x, y)) continue; const c = costAt(pads, rot, x, y); if (!best || c < best.c) best = { c, rot, x, y }; }
        continue;
      }
      for (let y = Math.ceil((O[1] + inset - tb[1]) / grid) * grid; y <= O[3] - inset - tb[3] + 1e-6; y += grid) for (let x = Math.ceil((O[0] + inset - tb[0]) / grid) * grid; x <= O[2] - inset - tb[2] + 1e-6; x += grid) {
        const c = costAt(pads, rot, x, y); if (best && c >= best.c) continue; if (!legal(b, rot, x, y)) continue; best = { c, rot, x, y };
      }
    }
    if (best) { b.rot = best.rot; b.x = best.x; b.y = best.y; b.placed = true; return true; }
    return false;
  };
  /** Nowhere legal for a part: the spot where it is least in the way (the score will say so). */
  const squeeze = (b: Block) => {
    squeezed++;
    let best: { c: number; x: number; y: number } | null = null; const tb = turnBox(b.padBox, 0); const pads = blockPads(b); const side = b.anchor.back; const others: Box[] = stillBoxes.filter((t) => t.p.back === side).map((t) => t.b);
    for (const o of blocks) if (o !== b && o.placed) for (const t of partBoxes(o, o.rot, o.x, o.y)) if (t.p.back === side) others.push(t.b);
    for (let y = O[1] + inset - tb[1]; y <= O[3] - inset - tb[3] + 1e-6; y += g) for (let x = O[0] + inset - tb[0]; x <= O[2] - inset - tb[2] + 1e-6; x += g) {
      const bb = shift(tb, x, y); let ov = 0; for (const o of others) { const wv = Math.min(bb[2], o[2]) - Math.max(bb[0], o[0]), hv = Math.min(bb[3], o[3]) - Math.max(bb[1], o[1]); if (wv > 0 && hv > 0) ov += wv * hv; }
      const c = ov * 50 + costAt(pads, 0, x, y); if (!best || c < best.c) best = { c, x, y };
    }
    b.rot = 0; if (best) { b.x = best.x; b.y = best.y; } else { b.x = cx - (tb[0] + tb[2]) / 2; b.y = cy - (tb[1] + tb[3]) / 2; } b.placed = true;
  };
  /** Put a block down; when it does not fit as a whole, its parts go down one by one, the anchor first. */
  const settle = (b: Block) => {
    if (put(b)) return;
    if (b.parts.length === 1) { if (!put(b, g / 4)) squeeze(b); return; }
    const i = blocks.indexOf(b); if (i >= 0) blocks.splice(i, 1);
    const parts = [b.anchor].concat(b.parts.filter((p) => p !== b.anchor));
    for (const p of parts) {
      p.x = 0; p.y = 0; p.rot = 0; const nb: Block = { name: b.name, parts: [p], anchor: p, box: p.box, padBox: p.padBox, x: 0, y: 0, rot: 0, placed: false, fixed: false, edge: p.spec && p.spec.edge ? p.spec.edge : null };
      blocks.push(nb); if (!put(nb) && !put(nb, g / 4)) squeeze(nb); rebuildPads();
    }
  };
  const sizeOf = (b: Block) => b.parts.reduce((s, p) => s + p.pads.length, 0);
  const order = blocks.slice().sort((a, b) => +b.fixed - +a.fixed || +!!b.edge - +!!a.edge || +long(b) - +long(a) || sizeOf(b) - sizeOf(a) || (a.name < b.name ? -1 : 1));
  for (const b of order) { settle(b); rebuildPads(); }
  for (let round = 0; round < 2; round++) for (const b of blocks.slice()) {
    if (b.fixed) continue; const keep = { x: b.x, y: b.y, rot: b.rot }; const wasLegal = legal(b, keep.rot, keep.x, keep.y); b.placed = false; rebuildPads(); hug = long(b) && !b.edge ? b : null; const before = costAt(blockPads(b), keep.rot, keep.x, keep.y);
    if (!put(b) || (wasLegal && costAt(blockPads(b), b.rot, b.x, b.y) > before - 1e-9)) Object.assign(b, keep); b.placed = true; rebuildPads();
  }

  // ---- out
  const placements: Placement[] = []; const finalBox = new Map<Part, Box>(); const finalGeo: Geo[] = []; const finalPads: { net: string; at: Pt }[] = [];
  for (const b of blocks) for (const p of b.parts) {
    const [px, py] = rotv(b.rot, p.x, p.y); const exact = b.fixed && p === b.anchor && isFixed(p) ? (p.spec!.fixed as { x: number; y: number }) : null;
    const x = exact ? exact.x : r3(Math.round((b.x + px) / 0.05) * 0.05), y = exact ? exact.y : r3(Math.round((b.y + py) / 0.05) * 0.05), rot = norm(p.rot + b.rot);
    placements.push({ ref: p.ref, id: p.id, x, y, rot, side: p.back ? "back" : "front", group: b.name.startsWith("~") ? "" : b.name.replace(/~\d+$/, "") });
    finalBox.set(p, shift(turnBox(p.box, rot), x, y)); finalGeo.push(geo(p, rot, x, y)); for (const d of p.pads) if (d.net) { const [dx, dy] = rotv(rot, d.x, d.y); finalPads.push({ net: d.net, at: [x + dx, y + dy] }); }
  }
  for (const t of stillBoxes) { finalBox.set(t.p, t.b); finalGeo.push(t); for (const d of t.p.pads) if (d.net) { const [dx, dy] = rotv(t.p.cur[2], d.x, d.y); finalPads.push({ net: d.net, at: [t.p.cur[0] + dx, t.p.cur[1] + dy] }); } }
  const onEdge = new Set(blocks.filter((b) => b.edge).map((b) => b.anchor)); const score: PlaceScore = { ratsnest: r3(mstTotal(finalPads)), overlaps: 0, courtyardClashes: 0, outside: 0, area: 0, clashes: [], outsideRefs: [] };
  for (let i = 0; i < finalGeo.length; i++) {
    const a = finalGeo[i]; const pq = shift(turnBox(a.p.padBox, a.rot), a.x, a.y); if (!onEdge.has(a.p) && a.p.pads.length && (pq[0] < O[0] - 1e-6 || pq[1] < O[1] - 1e-6 || pq[2] > O[2] + 1e-6 || pq[3] > O[3] + 1e-6)) { score.outside++; score.outsideRefs.push(a.p.ref); }
    for (let j = i + 1; j < finalGeo.length; j++) { if (clash(a, finalGeo[j], 0)) { score.courtyardClashes++; score.overlaps++; score.clashes.push([a.p.ref, finalGeo[j].p.ref]); } else if (gap > 0 && clash(a, finalGeo[j], gap * 0.999)) score.overlaps++; }
  }
  score.area = r3((O[2] - O[0]) * (O[3] - O[1]));
  const groups = blocks.filter((b) => !b.name.startsWith("~") ? blocks.find((o) => o.name === b.name) === b : true).map((b0) => { const b = { name: b0.name, anchor: b0.anchor, parts: b0.name.startsWith("~") ? b0.parts : blocks.filter((o) => o.name === b0.name).flatMap((o) => o.parts) }; let box: Box = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of b.parts) { const q = finalBox.get(p)!; box = [Math.min(box[0], q[0]), Math.min(box[1], q[1]), Math.max(box[2], q[2]), Math.max(box[3], q[3])]; } return { name: b.name.startsWith("~") ? b.anchor.ref : b.name, anchor: b.anchor.ref, refs: b.parts.map((p) => p.ref), box: box.map(r3) as Box }; });
  let fill = 0; for (const p of finalBox.keys()) if (p.movable) { const q = finalBox.get(p)!; fill += (q[2] - q[0]) * (q[3] - q[1]); } fill /= (O[2] - O[0]) * (O[3] - O[1]);
  return { placements, score, groups, squeezed, O, fill };
  };
  // A board sized to its parts (opts.fit): the smallest outline of the same proportions, in whole millimetres, on
  // which every block finds a legal place (nothing squeezed, nothing outside, no courtyard clash) -- the way a person
  // pulls the outline in round the parts once they are placed.
  const stillRefs = new Set(still.map((p) => p.ref)); const O0 = outline as Box;
  let res = arrange(O0);
  // a person's dense boards have courtyards over 37 to 46% of the board: fuller than that leaves no room to route
  const maxFill = opts.maxFill && opts.maxFill > 0 ? opts.maxFill : 0.45;
  const good = (r: ReturnType<typeof arrange>, fit = false) => !r.squeezed && r.score.outsideRefs.every((ref) => stillRefs.has(ref)) && r.score.courtyardClashes === 0 && (!fit || r.fill <= maxFill);
  if (opts.fit && good(res)) {
    const W0 = O0[2] - O0[0], H0 = O0[3] - O0[1];
    const sized = (s: number): Box => { const w = Math.ceil(W0 * s), h = Math.ceil(H0 * s); return [O0[0], O0[1], O0[0] + w, O0[1] + h]; };
    let lo = 0.3, hi = 1; let best = res;
    for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2; const r = arrange(sized(mid), 2); if (good(r, true)) { best = r; hi = mid; } else lo = mid; }
    // then each side on its own, as far as it goes
    let O2 = best.O.slice() as Box;
    for (const side of [2, 3]) { let a = side === 2 ? O2[0] + 5 : O2[1] + 5, b = O2[side]; while (b - a > 1) { const m = Math.round((a + b) / 2); const t = O2.slice() as Box; t[side] = m; const r = arrange(t, 2); if (good(r, true)) { best = r; b = m; O2 = t; } else a = m; } }
    // the size found on a coarse search grid, placed for real; when the fine grid does not make it, a millimetre more each way
    res = arrange(O2); for (let i = 0; i < 6 && !good(res); i++) { O2 = [O2[0], O2[1], O2[2] + 1, O2[3] + 1]; res = arrange(O2); }
    if (!good(res)) res = arrange(O0);
  }
  const { placements, score, groups } = res; const O = res.O;
  return { placements, score, outline: O.map(r3) as Box, outlineFromBoard: fromBoard, groups, unknown };
}

/** The total length of the per-net spanning trees over pad centres: what is left to route, as the crow flies. */
export function mstTotal(pads: { net: string; at: Pt }[]): number {
  const by = new Map<string, Pt[]>(); for (const p of pads) { let l = by.get(p.net); if (!l) by.set(p.net, l = []); l.push(p.at); }
  let sum = 0; for (const pts of by.values()) sum += mst(pts);
  return sum;
}
export function mst(pts: Pt[]): number {
  const n = pts.length; if (n < 2) return 0; const d = new Float64Array(n).fill(Infinity); const used = new Uint8Array(n); let sum = 0, k = 0; used[0] = 1;
  for (let c = 1; c < n; c++) { let j = -1; for (let i = 0; i < n; i++) { if (used[i]) continue; const v = Math.hypot(pts[i][0] - pts[k][0], pts[i][1] - pts[k][1]); if (v < d[i]) d[i] = v; if (j < 0 || d[i] < d[j]) j = i; } used[j] = 1; sum += d[j]; k = j; }
  return sum;
}

/** The placements as ordinary edits (one replaced footprint each), for the caller to commit or to show as a proposal. */
export function placementChanges(K: any, P: any, doc: any, placements: Placement[]): any[] {
  const out: any[] = [];
  for (const pl of placements) {
    const it = pl.id ? doc.items.get(pl.id) : Array.from(doc.items.values()).find((i: any) => i.kind === "footprint" && refOf(K, i.node) === pl.ref); if (!it || it.kind !== "footprint") continue;
    out.push(...P.transformChanges(doc, [it.id], (node: any) => {
      const layer = K.kid(node, "layer"); const back = !!layer && K.str(layer[1]) === "B.Cu"; let [x, y, rot] = K.atOf(node);
      if ((pl.side === "back") !== back) { P.flipNode(node, x, doc); [x, y, rot] = K.atOf(node); }
      const turn = norm(pl.rot - rot); if (turn) P.rotateNode(node, x, y, turn);
      if (Math.abs(pl.x - x) > 1e-9 || Math.abs(pl.y - y) > 1e-9) P.translateNode(node, pl.x - x, pl.y - y);
      return Math.abs(pl.x - x) > 1e-9 || Math.abs(pl.y - y) > 1e-9 || turn !== 0 || (pl.side === "back") !== back;
    }));
  }
  return out;
}
