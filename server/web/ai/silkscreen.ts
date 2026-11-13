// silkscreen.ts — the silkscreen pass a careful layout person does last: every reference designator readable, next
// to its part, and on nothing — not a pad, not other silkscreen, not another part, not the board edge — and the net
// names printed beside the pins of the connectors.  A reference that does not fit at the usual size is made smaller
// (down to what a board house still prints), turned on its side, or moved a little further out; it is hidden only
// when none of that finds a place.
//
// The shapes are the DRC's own (pcb-tools/drc-silk boardElements: stroke-font text, pads with their mask openings),
// so what this pass calls clear is what the rules check calls clear.  Nothing here touches the document: the
// footprints come back as edited copies.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ED, K } from "./design";

const W = window as any;
const PCB = (): any => W.PcbTools || null;
type Box = [number, number, number, number];
type Pt = [number, number];
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export interface SilkOptions {
  /** the size references are printed at where there is room (mm, default 1.0) */
  size?: number;
  /** the smallest size a reference may be shrunk to (mm, default 0.6) */
  minSize?: number;
  /** only these parts' references */
  refs?: string[];
  /** also bring back references that are hidden now */
  unhide?: boolean;
  /** net names beside connector pins: true for every connector, or the references to label; false for none */
  pinLabels?: boolean | string[];
  /** leave the references alone (pin labels only) */
  keepRefs?: boolean;
  /** the board's identity to print in free room when the silkscreen has no text of its own yet: each entry is one way to break it into lines, the first that fits wins */
  mark?: { shapes: string[][]; size?: number; layer?: string };
}
export interface SilkReport {
  references: number; kept: number; moved: number; resized: Record<string, number>; turned: string[]; hidden: string[]; shown: string[]; other_side: string[];
  pin_labels: Record<string, string[]>; pin_labels_skipped: Record<string, string[]>; pin_labels_other_side: string[]; mark?: { text: string; at: number[]; layer: string; size: number } | { problem: string }; smallest: number | null; min_size: number;
}
export interface SilkPlan { nodes: Map<string, any>; adds: any[]; report: SilkReport }

interface Obstacle { box: Box; fp: string | null; key: string }

const sideOf = (layer: string) => (layer.startsWith("B.") ? "B" : "F");
const hit = (a: Box, b: Box, gap: number) => a[0] < b[2] + gap && a[2] > b[0] - gap && a[1] < b[3] + gap && a[3] > b[1] - gap;
const grow = (b: Box, by: number): Box => [b[0] - by, b[1] - by, b[2] + by, b[3] + by];

function shapesBox(shapes: any[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const put = (x: number, y: number, r: number) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const s of shapes) {
    if (s.t === "seg") { put(s.a[0], s.a[1], s.r || 0); put(s.b[0], s.b[1], s.r || 0); }
    else if (s.t === "path") for (const p of s.pts) put(p[0], p[1], s.r || 0);
    else if (s.t === "poly") for (const p of s.pts) put(p[0], p[1], 0);
    else if (s.t === "circle") put(s.x, s.y, s.r);
    else if (s.t === "rect") { const a = ((s.rot || 0) * Math.PI) / 180, c = Math.abs(Math.cos(a)), n = Math.abs(Math.sin(a)); const hw = (s.w * c + s.h * n) / 2, hh = (s.w * n + s.h * c) / 2; put(s.x - hw, s.y - hh, 0); put(s.x + hw, s.y + hh, 0); }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

function inPoly(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; }
  return c;
}
/** Does the segment a–b touch the box? */
function segHitsBox(a: Pt, b: Pt, bx: Box): boolean {
  let t0 = 0, t1 = 1; const d = [b[0] - a[0], b[1] - a[1]];
  for (let i = 0; i < 2; i++) {
    const lo = bx[i], hi = bx[i + 2];
    if (Math.abs(d[i]) < 1e-12) { if (a[i] < lo || a[i] > hi) return false; continue; }
    let u = (lo - a[i]) / d[i], v = (hi - a[i]) / d[i]; if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) return false;
  }
  return true;
}

/** The text of a footprint's property or fp_text as drawn: its box on the board, or null when it draws nothing. */
function measure(doc: any, fp: any, child: any): Box | null {
  const k = K(), P = PCB(); const n = fp.node; const body: any[] = [];
  for (let i = 2; i < n.length; i++) {
    const g = n[i]; if (!Array.isArray(g)) continue;
    if (g[0] === "layer" || g[0] === "at" || g[0] === "transform") body.push(g);
    else if (g[0] === "property") body.push(child[0] === "property" && k.str(g[1]) === k.str(child[1]) ? child : g.concat([["hide", "yes"]]));
  }
  if (child[0] !== "property") body.push(child);
  const item: any = { id: fp.id, kind: "footprint", node: [n[0], n[1], ...body], geom: [], bbox: null, movable: true, docType: "pcb" };
  try { k.buildGeom(doc, item); } catch { return null; }
  const lay = k.kid(child, "layer"); const layer = lay ? k.str(lay[1]) : "F.SilkS";
  return shapesBox(P.geomShapes(item.geom, layer));
}

/** A text child with this place (in the footprint's own numbers), angle, size and pen; shown. */
function styled(child: any, lx: number, ly: number, ang: number, size: number, text?: string): any {
  const k = K(); const node = k.cloneNode(child);
  if (text !== undefined) node[2] = text;
  for (let i = node.length - 1; i >= 2; i--) if (Array.isArray(node[i]) && node[i][0] === "hide") node.splice(i, 1);
  let at = k.kid(node, "at"); if (!at) { at = ["at", 0, 0, 0]; node.splice(3, 0, at); }
  at.length = 1; at.push(r4(lx), r4(ly), ang);
  let fx = k.kid(node, "effects"); if (!fx) { fx = ["effects"]; node.push(fx); }
  for (let i = fx.length - 1; i >= 1; i--) if (fx[i] === "hide" || (Array.isArray(fx[i]) && fx[i][0] === "hide")) fx.splice(i, 1);
  let font = k.kid(fx, "font"); if (!font) { font = ["font"]; fx.splice(1, 0, font); }
  for (let i = font.length - 1; i >= 1; i--) if (Array.isArray(font[i]) && (font[i][0] === "size" || font[i][0] === "thickness")) font.splice(i, 1);
  font.splice(1, 0, ["size", size, size], ["thickness", Math.max(0.1, Math.round(size * 15) / 100)]);
  return node;
}
/** The same text printed on the given side of the board (mirrored on the back, as KiCad draws it). */
function toSide(child: any, side: string): any {
  const k = K(); const node = k.cloneNode(child);
  const lay = k.parseAll(`(layer "${side}.SilkS")`)[0]; const li = node.findIndex((g: any) => Array.isArray(g) && g[0] === "layer");
  if (li >= 0) node[li] = lay; else node.push(lay);
  let fx = k.kid(node, "effects"); if (!fx) { fx = ["effects"]; node.push(fx); }
  for (let i = fx.length - 1; i >= 1; i--) if (Array.isArray(fx[i]) && fx[i][0] === "justify") fx.splice(i, 1);
  if (side === "B") fx.push(k.parseAll("(justify mirror)")[0]);
  return node;
}
const hiddenText = (node: any): boolean => {
  const k = K(); const h = k.kid(node, "hide"); if (h && k.str(h[1]) !== "no") return true;
  const fx = k.kid(node, "effects"); return !!fx && fx.some((x: any) => x === "hide" || (Array.isArray(x) && x[0] === "hide" && k.str(x[1]) !== "no"));
};

/** Where a text child lands for a place in the footprint's own numbers: measured, so every rotation and side is right. */
class Frame {
  private c0: Pt; private ex: Pt; private ey: Pt; readonly w: number; readonly h: number; readonly ok: boolean;
  constructor(private doc: any, private fp: any, private child: any, readonly ang: number, readonly size: number, private text?: string) {
    const at = (x: number, y: number) => measure(doc, fp, styled(child, x, y, ang, size, text));
    const b0 = at(0, 0), b1 = at(1, 0), b2 = at(0, 1);
    this.ok = !!(b0 && b1 && b2); const c = (b: Box | null): Pt => (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0]);
    this.c0 = c(b0); const c1 = c(b1), c2 = c(b2); this.ex = [c1[0] - this.c0[0], c1[1] - this.c0[1]]; this.ey = [c2[0] - this.c0[0], c2[1] - this.c0[1]];
    this.w = b0 ? b0[2] - b0[0] : 0; this.h = b0 ? b0[3] - b0[1] : 0;
  }
  /** the node whose text is centred on (x, y) of the board */
  node(x: number, y: number): any {
    const dx = x - this.c0[0], dy = y - this.c0[1]; const det = this.ex[0] * this.ey[1] - this.ex[1] * this.ey[0] || 1;
    return styled(this.child, (dx * this.ey[1] - dy * this.ey[0]) / det, (dy * this.ex[0] - dx * this.ex[1]) / det, this.ang, this.size, this.text);
  }
  box(x: number, y: number): Box { return [x - this.w / 2, y - this.h / 2, x + this.w / 2, y + this.h / 2]; }
}

const shortNet = (name: string): string => {
  const s = String(name || "").replace(/^\/+/, "").split("/").pop() || "";
  return /^(Net-\(|unconnected-\(|N\$)/.test(s) || !s || /["\\]/.test(s) ? "" : s;
};

export function planSilk(doc: any, opts: SilkOptions = {}): SilkPlan {
  const k = K(), P = PCB(); if (!P || !P.boardElements) throw new Error("The board tools are not loaded.");
  const settings = P.designSettings((ED() && ED().proSettings) || null);
  // the smallest size is the board's own rule (Board Setup, minimum text height: 0.8 mm unless set) unless the caller names one
  const ruleMin = typeof settings.minTextHeight === "number" && settings.minTextHeight > 0 ? settings.minTextHeight : 0.8;
  const top = Math.max(0.5, opts.size || 1.0), low = Math.min(top, Math.max(0.4, opts.minSize || ruleMin));
  const sizes = [top, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4].filter((s, i) => i === 0 || (s < top && s >= low - 1e-9));
  if (low < top && !sizes.some((s) => Math.abs(s - low) < 1e-9)) sizes.push(low);
  const want = opts.refs && opts.refs.length ? new Set(opts.refs.map((r) => r.toLowerCase())) : null;
  const report: SilkReport = { references: 0, kept: 0, moved: 0, resized: {}, turned: [], hidden: [], shown: [], other_side: [], pin_labels: {}, pin_labels_skipped: {}, pin_labels_other_side: [], smallest: null, min_size: low };
  const nodes = new Map<string, any>();
  const fps: any[] = Array.from(doc.items.values()).filter((it: any) => it.kind === "footprint");
  const refProp = (fp: any) => k.kids(fp.node, "property").find((p: any) => k.str(p[1]) === "Reference");
  const layerOfNode = (n: any) => { const l = k.kid(n, "layer"); return l ? k.str(l[1]) : ""; };

  // ---- which references this pass places
  const mine = new Map<string, any>();
  if (!opts.keepRefs) for (const fp of fps) {
    const p = refProp(fp); if (!p) continue; const ref = k.str(p[2]);
    if (!/SilkS$/.test(layerOfNode(p)) || !ref || /\*/.test(ref) || /^#/.test(ref)) continue;
    if (want && !want.has(ref.toLowerCase())) continue;
    if (hiddenText(p) && !opts.unhide) continue;
    mine.set(fp.id, p);
  }

  // ---- what is in the way, per side
  const obs: Record<string, Obstacle[]> = { F: [], B: [] };
  const els: any[] = P.boardElements(doc, settings, new Set(["F.SilkS", "B.SilkS", "F.Mask", "B.Mask"]));
  const netNames = new Map<string, Set<string>>();      // footprint id → the labels this pass may have printed for it before
  const NT = P.netTable(doc);
  for (const fp of fps) { const s = new Set<string>(); for (const p of P.padsOf(fp)) { const n = shortNet(NT.key(p.net) || ""); if (n) s.add(n); } netNames.set(fp.id, s); }
  const isOldLabel = (fp: any, g: any) => g[0] === "fp_text" && k.str(g[1]) === "user" && /SilkS$/.test(layerOfNode(g)) && (netNames.get(fp.id) || new Set()).has(k.str(g[2]));
  for (const e of els) {
    if (!isFinite(e.bbox[0])) continue;
    if (e.fp && e.kind === "property" && k.str(e.node[1]) === "Reference" && mine.has(e.fp.id)) continue;
    if (e.fp && opts.pinLabels !== false && opts.pinLabels !== undefined && isOldLabel(e.fp, e.node)) continue;
    const mask = /Mask$/.test(e.layer);
    obs[sideOf(e.layer)].push({ box: grow(e.bbox, mask ? 0.1 : 0.12), fp: e.fp ? e.fp.id : null, key: e.uuid });
  }
  const court = new Map<string, Box>(); const sideOfFp = new Map<string, string>();
  for (const fp of fps) {
    const side = fp.layer === "B.Cu" ? "B" : "F"; let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    try { const cy = P.courtyards({ node: fp.node }); for (const key of Object.keys(cy)) for (const loop of cy[key]) for (const q of loop) b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])]; } catch { /* no courtyard */ }
    if (b[0] > b[2]) for (const p of P.padsOf(fp)) { const h = Math.max(p.w || 0.5, p.h || 0.5) / 2; b = [Math.min(b[0], p.x - h), Math.min(b[1], p.y - h), Math.max(b[2], p.x + h), Math.max(b[3], p.y + h)]; }
    if (b[0] > b[2]) continue;
    court.set(fp.id, b); sideOfFp.set(fp.id, side); obs[side].push({ box: b, fp: fp.id, key: "courtyard:" + fp.id });
  }
  let outline: Pt[] | null = null, holes: Pt[][] = [], edges: [Pt, Pt][] = [];
  try {
    const es = P.edgeShapes(doc); const loops: Pt[][] = es.chains && es.chains.length ? P.chainLoops(es.chains).loops : [];
    const area = (l: Pt[]) => Math.abs(l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0));
    loops.sort((a, b) => area(b) - area(a)); outline = loops[0] || null; holes = loops.slice(1);
    for (const l of loops) for (let i = 0; i < l.length; i++) edges.push([l[i], l[(i + 1) % l.length]]);
  } catch { outline = null; }
  // areas where copper is kept out (an antenna's clearance): the board's name is not printed there, ink over an antenna detunes it a little and reads as part of it
  const keepBoxes: Box[] = [];
  for (const it of doc.items.values() as any) {
    if (it.kind !== "zone") continue; const ko = k.kid(it.node, "keepout"); if (!ko) continue;
    const cp = k.kid(ko, "copperpour"); if (!cp || k.str(cp[1]) !== "not_allowed") continue;
    for (const poly of k.kids(it.node, "polygon")) { const pts: Pt[] = k.ptsOf(poly); if (pts.length < 3) continue; keepBoxes.push([Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]); }
  }
  const EDGE = 0.3;
  const onBoard = (b: Box): boolean => {
    if (!outline) return true;
    const cs: Pt[] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    if (!cs.every((c) => inPoly(c, outline!))) return false;
    const g = grow(b, EDGE); if (edges.some(([a, c]) => segHitsBox(a, c, g))) return false;
    const mid: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; return !holes.some((h) => inPoly(mid, h));
  };
  // a via's hole swallows the ink even when the via is tented: text keeps off vias while it has anywhere else to go
  const viaBoxes: Box[] = [];
  for (const it of doc.items.values() as any) {
    if (it.kind !== "via") continue; const at = k.kid(it.node, "at"), sz = k.kid(it.node, "size"); if (!at) continue;
    const r = (sz ? k.num(sz[1], 0.6) : 0.6) / 2; const x = k.num(at[1], 0), y = k.num(at[2], 0); viaBoxes.push([x - r, y - r, x + r, y + r]);
  }
  const offVias = (b: Box): boolean => !viaBoxes.some((v) => hit(b, v, 0.05));
  const clear = (b: Box, side: string, skip?: string): boolean => onBoard(b) && !obs[side].some((o) => o.key !== skip && hit(b, o.box, 0));
  const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
  /** A name must read as its own part's: no other part on that side may be nearer to it. */
  const reads = (b: Box, fpId: string, side: string): boolean => {
    const own = court.get(fpId); if (!own) return true; const d = gap(b, own);
    for (const [id, c] of court) { if (id === fpId || sideOfFp.get(id) !== side) continue; if (gap(b, c) < d - 0.05) return false; }
    return true;
  };

  // ---- net names beside connector pins (fixed by where the pins are, so they go first)
  // A connector is labelled whole or not at all: a row with some pins named reads worse than a bare one.  The names
  // go on the part's own side, toward the inside of the board or away from it; a through-hole connector whose own
  // side has no clear row for all of them gets them on the other side of the board, where its pins also are.
  const labelled = opts.pinLabels === true ? null : Array.isArray(opts.pinLabels) ? new Set(opts.pinLabels.map((r) => r.toLowerCase())) : undefined;
  const working = new Map<string, any>();      // footprint id → its node as edited so far
  const nodeOf = (fp: any) => working.get(fp.id) || fp.node;
  if (labelled !== undefined) for (const fp of fps) {
    const ref = String(fp.ref || ""); const pads: any[] = P.padsOf(fp).filter((p: any) => p.number !== "" && p.type !== "np_thru_hole");
    if (labelled ? !labelled.has(ref.toLowerCase()) : !/^(J|P|CN|X|BT)\d/.test(ref) || pads.length < 2 || pads.length > 48) continue;
    const own = fp.layer === "B.Cu" ? "B" : "F"; const cb = court.get(fp.id); if (!cb) continue;
    const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y); const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
    const rowAlongX = spanX >= spanY; const cx = (cb[0] + cb[2]) / 2, cy = (cb[1] + cb[3]) / 2;
    const along = (p: any) => (rowAlongX ? p.x : p.y), across = (p: any) => (rowAlongX ? p.y : p.x);
    const sorted = pads.slice().sort((a, b) => along(a) - along(b)); let pitch = Infinity;
    for (let i = 1; i < sorted.length; i++) { const d = along(sorted[i]) - along(sorted[i - 1]); if (d > 0.2) pitch = Math.min(pitch, d); }
    if (!isFinite(pitch)) pitch = 2.54;
    // a fine-pitch connector (USB-C, FFC) has no room for names and needs none; one asked for by reference is still tried
    if (!labelled && pitch < 1.9) continue;
    const rows = Array.from(new Set(pads.map((p) => Math.round(across(p) * 10) / 10))).sort((a, b) => a - b);
    if (rows.length > 2) { if (labelled) report.pin_labels_skipped[ref] = ["more than two rows of pins: the inner rows have nowhere to print"]; continue; }
    const base = k.cloneNode(nodeOf(fp));
    for (let i = base.length - 1; i >= 2; i--) if (Array.isArray(base[i]) && isOldLabel(fp, base[i])) base.splice(i, 1);
    const fpNow = Object.assign({}, fp, { node: base });
    const named = pads.map((p) => ({ p, name: shortNet(NT.key(p.net) || "") })).filter((x) => x.name);
    if (!named.length) continue;
    const through = pads.some((p) => p.type === "thru_hole");
    interface Row { nodes: any[]; boxes: Box[]; miss: string[]; size: number; side: string }
    const tryRow = (side: string, dir1: number, vias: boolean): Row => {
      const proto = k.parseAll(`(fp_text user "X" (at 0 0 0) (layer "${side}.SilkS") (uuid "${k.newUuid()}") (effects (font (size 1 1) (thickness 0.15))${side === "B" ? " (justify mirror)" : ""}))`)[0];
      // text runs away from the row: turned when the row runs along X
      const horiz = [0, 90].find((a) => { const f = new Frame(doc, fpNow, proto, a, 1, "MMMM"); return f.ok && f.w > f.h; }) ?? 0;
      const ang = rowAlongX ? (horiz === 0 ? 90 : 0) : horiz;
      let best: Row | null = null;
      // pin names are small print: they start at 0.8 mm (or the board's minimum) and shrink to the minimum
      for (const size of sizes.filter((s) => (s <= Math.max(0.8, low) + 1e-9 && s + 0.25 <= pitch) || s === sizes[sizes.length - 1])) {
        const out: any[] = [], boxes: Box[] = [], miss: string[] = [];
        for (const { p, name } of named) {
          const row = rows.indexOf(Math.round(across(p) * 10) / 10); const dir = rows.length > 1 ? (row === 0 ? -1 : 1) : dir1;
          const f = new Frame(doc, fpNow, proto, ang, size, name); if (!f.ok) { miss.push(`${p.number} ${name}`); continue; }
          const len = rowAlongX ? f.h : f.w; const edge = rowAlongX ? (dir < 0 ? cb[1] : cb[3]) : (dir < 0 ? cb[0] : cb[2]);
          const far = side !== own; const half = (rowAlongX ? (p.h || 1.7) : (p.w || 1.7)) / 2;
          // on the other side of the board there is no body and no courtyard: the names start right beside the pads
          const off = far ? across(p) + dir * (half + 0.35 + len / 2) : edge + dir * (0.3 + len / 2); const x = rowAlongX ? p.x : off, y = rowAlongX ? off : p.y; const b = f.box(x, y);
          if (!clear(grow(b, 0.05), side, "courtyard:" + fp.id) || (vias && !offVias(b)) || (!far && hit(b, cb, 0.05)) || boxes.some((o) => hit(b, o, 0.1))) { miss.push(`${p.number} ${name}`); continue; }
          const nd = f.node(x, y); k.kid(nd, "uuid")[1] = k.newUuid(); out.push(nd); boxes.push(b);
        }
        const res: Row = { nodes: out, boxes, miss, size, side };
        if (!best || miss.length < best.miss.length) best = res;
        if (!miss.length) break;
      }
      return best || { nodes: [], boxes: [], miss: named.map((x) => `${x.p.number} ${x.name}`), size: 0, side };
    };
    // a single row prints toward the inside of the board first
    let inward = -1;
    if (outline) { let ox = 0, oy = 0; for (const q of outline) { ox += q[0]; oy += q[1]; } ox /= outline.length; oy /= outline.length; inward = rowAlongX ? (oy < cy ? -1 : 1) : (ox < cx ? -1 : 1); }
    const dirs = rows.length > 1 ? [0] : [inward, -inward];
    const sides = through ? [own, own === "F" ? "B" : "F"] : [own];
    let pick: Row | null = null, nearest: Row | null = null;
    for (const vias of [true, false]) { if (pick) break; for (const side of sides) { for (const d of dirs) { const r = tryRow(side, d, vias); if (!r.miss.length) { pick = r; break; } if (!nearest || r.miss.length < nearest.miss.length) nearest = r; } if (pick) break; } }
    if (!pick) { report.pin_labels_skipped[ref] = [`no clear row for all ${named.length} names on ${through ? "either side of the board" : "its side"}; in the way at: ${(nearest ? nearest.miss : []).slice(0, 12).join(", ")}`]; if (k.serialize(base) !== k.serialize(nodeOf(fp))) working.set(fp.id, base); continue; }
    for (const nd of pick.nodes) base.push(nd);
    pick.boxes.forEach((b, i) => obs[pick!.side].push({ box: grow(b, 0.12), fp: fp.id, key: "pinlabel:" + fp.id + ":" + i }));
    working.set(fp.id, base); report.pin_labels[ref] = named.map((x) => `${x.p.number} ${x.name}`);
    if (pick.side !== own) report.pin_labels_other_side.push(ref);
  }

  // ---- the board's name (placed below, together with the references)
  const adds: any[] = [];
  const hasText = Array.from(doc.items.values()).some((it: any) => (it.kind === "gr_text" || it.kind === "gr_text_box") && /SilkS$/.test(layerOfNode(it.node)));
  const wantMark = !!(opts.mark && opts.mark.shapes.length && !hasText);
  const placeMark = (): boolean => {
    if (!opts.mark) return false;
    const want = opts.mark.layer && opts.mark.layer.startsWith("B.") ? "B" : "F"; const msize = Math.max(low, opts.mark.size || 1.0);
    let ob: Box | null = null; if (outline) { ob = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of outline) ob = [Math.min(ob[0], q[0]), Math.min(ob[1], q[1]), Math.max(ob[2], q[0]), Math.max(ob[3], q[1])]; }
    let placed = false;
    if (ob) search: for (const side of [want, want === "F" ? "B" : "F"]) for (const sz of [msize, 0.8, low].filter((s, i, a) => s <= msize + 1e-9 && s >= low - 1e-9 && a.indexOf(s) === i)) for (const lines of opts.mark.shapes) {
      const tw = Math.max(...lines.map((l) => l.length)) * sz * 0.9, w = tw + 0.4, h = lines.length * sz * 1.65 + 0.3;
      if (w > ob[2] - ob[0] - 1.6 || h > ob[3] - ob[1] - 1.6) continue;
      for (let y = ob[3] - 0.8 - h; y >= ob[1] + 0.8; y -= 0.5) for (let x = ob[0] + 0.8; x + w <= ob[2] - 0.8; x += 0.5) {
        const b: Box = [x, y, x + w, y + h]; if (!clear(b, side) || !offVias(b) || keepBoxes.some((kb) => hit(b, kb, 0.2))) continue;
        // mirrored text runs toward smaller x from where it starts: it starts at the right end of its room
        const ax = side === "B" ? x + 0.2 + tw : x + 0.2, ay = y + 0.15; const text = lines.join("\\n").replace(/"/g, "'");
        adds.push(k.parseAll(`(gr_text "${text}" (at ${r4(ax)} ${r4(ay)}) (layer "${side}.SilkS") (uuid "${k.newUuid()}") (effects (font (size ${sz} ${sz}) (thickness ${Math.max(0.1, Math.round(sz * 15) / 100)})) (justify left top${side === "B" ? " mirror" : ""})))`)[0]);
        obs[side].push({ box: grow(b, 0.12), fp: null, key: "mark" });
        report.mark = { text: lines.join(" / "), at: [r4(ax), r4(ay)], layer: side + ".SilkS", size: sz }; placed = true; break search;
      }
    }
    return placed;
  };

  // ---- the references
  interface Job { fp: any; prop: any; ref: string; side: string; body: Box; frames: Map<string, Frame>; horiz: number; was: any }
  const jobs: Job[] = [];
  for (const [id, prop] of mine) {
    const fp = doc.items.get(id); const body = court.get(id); if (!body) continue;
    const fpNow = Object.assign({}, fp, { node: nodeOf(fp) });
    const horiz = [0, 90].find((a) => { const f = new Frame(doc, fpNow, prop, a, 1, "MMMM"); return f.ok && f.w > f.h; }) ?? 0;
    // a reference an earlier pass printed on the other side of the board is tried on its part's own side again
    const ownSide = sideOfFp.get(id) || "F"; const here = sideOf(layerOfNode(prop)) === ownSide ? prop : toSide(prop, ownSide);
    jobs.push({ fp: fpNow, prop: here, ref: k.str(prop[2]), side: ownSide, body, frames: new Map(), horiz, was: prop });
  }
  const frame = (j: Job, size: number, turned: boolean): Frame => {
    const key = size + (turned ? "t" : "h"); let f = j.frames.get(key);
    if (!f) { f = new Frame(doc, j.fp, j.prop, turned ? (j.horiz === 0 ? 90 : 0) : j.horiz, size); j.frames.set(key, f); }
    return f;
  };
  /** Places to try around a part, nearest first: centred on each side, then slid along it, then the corners; `out` is how far from the part. */
  const spots = (b: Box, w: number, h: number, out: number, turned: boolean): { x: number; y: number; cost: number }[] => {
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, g = 0.25 + out; const res: { x: number; y: number; cost: number }[] = [];
    const wide = b[2] - b[0] >= b[3] - b[1];
    const yT = b[1] - g - h / 2, yB = b[3] + g + h / 2, xL = b[0] - g - w / 2, xR = b[2] + g + w / 2;
    // a wide part reads best with its name above or below, a tall one with it beside; a turned name is the second choice
    const base = Math.abs(out) * 2 + (turned ? 0.8 : 0);
    const slide = (lo: number, hi: number, mid: number) => { const s = new Set<number>([mid]); for (let v = lo; v <= hi + 1e-9; v += 0.5) s.add(Math.round(v * 100) / 100); s.add(hi); return Array.from(s); };
    for (const x of slide(b[0] - w / 2, b[2] + w / 2, cx)) { const d = Math.abs(x - cx) * 0.6; res.push({ x, y: yT, cost: base + d + (wide ? 0 : 0.3) }, { x, y: yB, cost: base + d + (wide ? 0.1 : 0.4) }); }
    for (const y of slide(b[1] - h / 2, b[3] + h / 2, cy)) { const d = Math.abs(y - cy) * 0.6; res.push({ x: xR, y, cost: base + d + (wide ? 0.3 : 0) }, { x: xL, y, cost: base + d + (wide ? 0.4 : 0.1) }); }
    return res.sort((p, q) => p.cost - q.cost);
  };
  const find = (j: Job, sizeList: number[], outs: number[], vias: boolean): { f: Frame; x: number; y: number; size: number; turned: boolean } | null => {
    for (const size of sizeList) {
      let best: { f: Frame; x: number; y: number; size: number; turned: boolean; cost: number } | null = null;
      for (const turned of [false, true]) {
        const f = frame(j, size, turned); if (!f.ok) continue;
        for (const out of outs) for (const s of spots(j.body, f.w, f.h, out, turned)) {
          if (best && s.cost >= best.cost) break;
          if (clear(f.box(s.x, s.y), j.side) && (!vias || offVias(f.box(s.x, s.y))) && reads(f.box(s.x, s.y), j.fp.id, j.side)) { best = { f, x: s.x, y: s.y, size, turned, cost: s.cost }; break; }
        }
      }
      if (best) return best;
    }
    return null;
  };
  const underPart = (j: Job, vias: boolean): { f: Frame; x: number; y: number; size: number; side: string } | null => {
    const side = j.side === "F" ? "B" : "F"; const prop = toSide(j.prop, side); const cx = (j.body[0] + j.body[2]) / 2, cy = (j.body[1] + j.body[3]) / 2;
    for (const size of [Math.min(sizes[0], 0.8), sizes[sizes.length - 1]].filter((v, i, a) => a.indexOf(v) === i)) for (const turned of [false, true]) {
      const f = new Frame(doc, j.fp, prop, turned ? (j.horiz === 0 ? 90 : 0) : j.horiz, size); if (!f.ok) continue;
      const tries: Pt[] = [[cx, cy]]; for (const d of [0.5, 1.0, 1.5, 2.0, 2.5]) tries.push([cx + d, cy], [cx - d, cy], [cx, cy + d], [cx, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx + d, cy - d], [cx - d, cy - d]);
      // a little air around it: it must not touch a pin name or another reference printed there
      for (const [x, y] of tries) { const b = f.box(x, y); if (clear(grow(b, 0.15), side) && (!vias || offVias(b))) return { f, x, y, size, side }; }
    }
    return null;
  };
  // the parts with the fewest places go first
  const room = (j: Job) => { let n = 0; for (const turned of [false, true]) { const f = frame(j, sizes[0], turned); if (f.ok) for (const s of spots(j.body, f.w, f.h, 0, turned)) if (clear(f.box(s.x, s.y), j.side)) n++; } return n; };
  const order = jobs.map((j) => ({ j, n: room(j) })).sort((a, b) => a.n - b.n || a.j.ref.localeCompare(b.j.ref, undefined, { numeric: true })).map((x) => x.j);
  const placeRefs = () => { for (const j of order) {
    report.references++;
    const far = [-0.1, 0.9, 1.5, 2.2, 3.0], small = [sizes[sizes.length - 1]];
    // off the vias first, on either side of the board; over a via only when that is the one place left
    let got = find(j, sizes, [0, 0.4], true) || find(j, small, far, true);
    let under = got ? null : underPart(j, true);
    if (!got && !under) { got = find(j, sizes, [0, 0.4], false) || find(j, small, far, false); if (!got) under = underPart(j, false); }
    const before = k.serialize(j.was); let next: any;
    // no place beside the part on its own side: a crowded board prints the name on the other side, right under the part
    if (under) {
      next = under.f.node(under.x, under.y); obs[under.side].push({ box: grow(under.f.box(under.x, under.y), 0.2), fp: j.fp.id, key: "ref:" + j.fp.id });
      report.other_side.push(j.ref); if (under.size < sizes[0] - 1e-9) report.resized[j.ref] = under.size;
      report.smallest = report.smallest === null ? under.size : Math.min(report.smallest, under.size);
    } else if (!got) {
      next = k.cloneNode(j.prop); if (!hiddenText(next)) next.push(["hide", "yes"]);
      report.hidden.push(j.ref);
    } else {
      next = got.f.node(got.x, got.y); const b = got.f.box(got.x, got.y);
      // two names side by side must not read as one word: the next one keeps about a character's width away
      obs[j.side].push({ box: grow(b, Math.max(0.3, got.size * 0.55)), fp: j.fp.id, key: "ref:" + j.fp.id });
      if (got.size < sizes[0] - 1e-9) report.resized[j.ref] = got.size;
      if (got.turned) report.turned.push(j.ref);
      if (hiddenText(j.prop)) report.shown.push(j.ref);
      report.smallest = report.smallest === null ? got.size : Math.min(report.smallest, got.size);
    }
    if (k.serialize(next) === before) { report.kept++; continue; }
    if (got || under) report.moved++;
    const node = k.cloneNode(nodeOf(j.fp)); const i = node.findIndex((g: any) => Array.isArray(g) && g[0] === "property" && k.str(g[1]) === "Reference");
    if (i < 0) continue; node[i] = next; working.set(j.fp.id, node);
  } };
  // The name is planned around the references when there is room for both, since a reference that had to hide is the
  // worse loss; only when the references leave no block for it does the name go first and the references around it.
  const mark0 = { F: obs.F.length, B: obs.B.length }, work0 = new Map(working), rep0 = JSON.stringify(report);
  placeRefs();
  if (wantMark && !placeMark()) {
    obs.F.length = mark0.F; obs.B.length = mark0.B; working.clear(); for (const [id, n] of work0) working.set(id, n);
    Object.assign(report, JSON.parse(rep0));
    if (!placeMark()) report.mark = { problem: outline ? `no free room for "${opts.mark!.shapes[0].join(" ")}" on either side, even at ${low} mm in ${opts.mark!.shapes[opts.mark!.shapes.length - 1].length} lines: board.mark(name, at=(x, y)) puts it where you say` : "the board has no outline yet" };
    placeRefs();
  }
  for (const [id, node] of working) { const it = doc.items.get(id); if (it && k.serialize(node) !== k.serialize(it.node)) nodes.set(id, node); }
  report.hidden.sort(); report.turned.sort(); report.other_side.sort();
  return { nodes, adds, report };
}

/** The boxes of what is printed on the silkscreen, for placing something new clear of it: [x0, y0, x1, y1, layer]. */
export function silkBoxes(doc: any): (number | string)[][] {
  const P = PCB(); if (!P || !P.boardElements) return [];
  const settings = P.designSettings((ED() && ED().proSettings) || null);
  const out: (number | string)[][] = [];
  for (const e of P.boardElements(doc, settings, new Set(["F.SilkS", "B.SilkS"])) as any[]) if (isFinite(e.bbox[0])) out.push([r4(e.bbox[0]), r4(e.bbox[1]), r4(e.bbox[2]), r4(e.bbox[3]), e.layer]);
  return out;
}
