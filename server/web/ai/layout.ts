// layout.ts — how a schematic sheet reads: what lies on top of what.
//
// A sheet can be electrically right and still unreadable: a value printed over a wire, a label
// through a symbol, a note under a part, a block that runs off the page or into the title block.
// checkLayout finds those from the same geometry the canvas draws (item.geom), so a box here is
// the box a person sees.  The Python harness lays blocks out with it (measure, then place), and
// any assistant can ask for it as the check_layout tool.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { K, ToolError, resolveDoc } from "./design";

const W = window as any;
const SCH = (): any => (W.CollabTools && W.CollabTools.sch) || null;
const r2 = (v: number) => Math.round(v * 100) / 100;

type Box = [number, number, number, number];
type Seg = [number, number, number, number];
interface Piece { id: string; owner: string; name: string; kind: "body" | "text" | "wire" | "frame" | "graphic"; box: Box; seg?: Seg; part?: boolean; pins?: [number, number][]; field?: string }

const grow = (b: Box | null, c: Box): Box => (b ? [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])] : [c[0], c[1], c[2], c[3]]);
const shrink = (b: Box, m: number): Box => { const mx = Math.min(m, (b[2] - b[0]) / 2 - 1e-3), my = Math.min(m, (b[3] - b[1]) / 2 - 1e-3); return [b[0] + Math.max(0, mx), b[1] + Math.max(0, my), b[2] - Math.max(0, mx), b[3] - Math.max(0, my)]; };
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const inside = (a: Box, b: Box) => a[0] >= b[0] - 1e-6 && a[1] >= b[1] - 1e-6 && a[2] <= b[2] + 1e-6 && a[3] <= b[3] + 1e-6;
const mid = (a: Box, b: Box): [number, number] => [r2((Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2), r2((Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2)];
/** Does the segment pass through the box (Liang-Barsky)? */
function segHits(s: Seg, b: Box): boolean {
  let t0 = 0, t1 = 1; const dx = s[2] - s[0], dy = s[3] - s[1];
  for (const [p, q] of [[-dx, s[0] - b[0]], [dx, b[2] - s[0]], [-dy, s[1] - b[1]], [dy, b[3] - s[1]]]) {
    if (Math.abs(p) < 1e-12) { if (q <= 0) return false; continue; }
    const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9;
}
/** Do two segments cross at a point inside both (ends touching is not a crossing)? */
function segsCross(a: Seg, b: Seg): boolean {
  const d = (a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0]); if (Math.abs(d) < 1e-9) return false;
  const t = ((b[0] - a[0]) * (b[3] - b[1]) - (b[1] - a[1]) * (b[2] - b[0])) / d, u = ((b[0] - a[0]) * (a[3] - a[1]) - (b[1] - a[1]) * (a[2] - a[0])) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

/** The box a text geom covers on the sheet (the canvas's own extents, a little taller for descenders and overbars). */
function textBox(g: any): Box {
  const k = K(); const w = k.textWidth(g.text, g.size, g.w || 0), h = g.size * 1.15;
  const x0 = g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2, y0 = g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2;
  const a = ((g.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); let b: Box | null = null;
  for (const [px, py] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) { const x = g.x + px * c + py * s, y = g.y - px * s + py * c; b = grow(b, [x, y, x, y]); }
  return b as Box;
}
function fieldHidden(k: any, p: any): boolean {
  const h = k.kid(p, "hide"); if (h) return k.str(h[1]) !== "no";
  const ef = k.kid(p, "effects"); if (!ef) return false;
  if (ef.includes("hide")) return true; const eh = k.kid(ef, "hide"); return !!eh && k.str(eh[1]) !== "no";
}
const short = (t: string) => (t.length > 28 ? t.slice(0, 27) + "…" : t).replace(/\n/g, " ");

/** Everything on the sheet that can be in something else's way, as boxes and segments. */
function pieces(doc: any): { list: Piece[]; full: Map<string, Box> } {
  const s = SCH(), k = K(); const list: Piece[] = []; const full = new Map<string, Box>();
  for (const it of doc.items.values() as Iterable<any>) {
    const add = (p: Omit<Piece, "id">) => { list.push(Object.assign({ id: it.id }, p)); full.set(it.id, grow(full.get(it.id) || null, p.box)); };
    if (it.kind === "symbol") {
      const ref = it.ref || "symbol", power = /^#/.test(ref); const who = power ? `${it.value || "power"} symbol` : ref;
      const body: Box = s._.bodyBox(doc, it);
      const ends: [number, number][] = []; let pins: Box | null = null;
      for (const p of s._.symbolPins(doc, it)) { ends.push([p.x, p.y]); if (!p.hidden) pins = grow(pins, [p.x, p.y, p.x, p.y]); }
      add({ owner: it.id, name: who, kind: "body", box: body, part: true, pins: ends });
      if (pins) full.set(it.id, grow(full.get(it.id) || null, pins));
      // the fields that are drawn: a text of the symbol that shows a visible property's value
      const shown = new Map<string, string>();
      for (const p of k.kids(it.node, "property")) { if (fieldHidden(k, p)) continue; const v = k.str(p[2]); if (v) shown.set(v, k.str(p[1])); }
      for (const g of it.geom || []) {
        if (g.t !== "text" || g.noBox) continue;
        const field = shown.get(g.raw || g.text) || shown.get(g.text) || (it.ref && String(g.text).startsWith(it.ref) && String(g.text).length <= it.ref.length + 1 ? "Reference" : "");
        if (!field) continue;
        add({ owner: it.id, name: `${who} ${field === "Reference" ? "reference" : field === "Value" ? "value" : field}`, kind: "text", box: textBox(g), field });
      }
    } else if (it.kind === "wire" || it.kind === "bus") {
      const pts = k.ptsOf(it.node);
      for (let i = 1; i < pts.length; i++) { const sg: Seg = [pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]; add({ owner: it.id, name: it.kind, kind: "wire", seg: sg, box: [Math.min(sg[0], sg[2]), Math.min(sg[1], sg[3]), Math.max(sg[0], sg[2]), Math.max(sg[1], sg[3])] }); }
    } else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label" || it.kind === "text" || it.kind === "directive_label" || it.kind === "netclass_flag") {
      const t = k.str(it.node[1]); let b: Box | null = null;
      if (it.kind === "label" || it.kind === "text") for (const g of it.geom || []) if (g.t === "text") b = grow(b, textBox(g));
      if (!b && it.bbox) b = it.bbox.slice() as Box; if (!b) continue;
      add({ owner: it.id, name: `${it.kind === "text" ? "text" : "label"} "${short(t)}"`, kind: "text", box: b });
    } else if (it.kind === "text_box" || it.kind === "table" || it.kind === "image") {
      if (it.bbox) add({ owner: it.id, name: it.kind === "text_box" ? `text box "${short(k.str(it.node[1]))}"` : it.kind, kind: "text", box: it.bbox.slice() as Box });
    } else if (it.kind === "rectangle") {
      const a = k.kid(it.node, "start"), e = k.kid(it.node, "end"); if (!a || !e) continue;
      const b: Box = [Math.min(k.num(a[1]), k.num(e[1])), Math.min(k.num(a[2]), k.num(e[2])), Math.max(k.num(a[1]), k.num(e[1])), Math.max(k.num(a[2]), k.num(e[2]))];
      for (const sg of [[b[0], b[1], b[2], b[1]], [b[2], b[1], b[2], b[3]], [b[2], b[3], b[0], b[3]], [b[0], b[3], b[0], b[1]]] as Seg[])
        add({ owner: it.id, name: "frame", kind: "frame", seg: sg, box: [Math.min(sg[0], sg[2]), Math.min(sg[1], sg[3]), Math.max(sg[0], sg[2]), Math.max(sg[1], sg[3])] });
    } else if (it.kind === "sheet") {
      if (it.bbox) add({ owner: it.id, name: `sheet ${it.name || ""}`.trim(), kind: "body", box: it.bbox.slice() as Box, part: true });
    } else if (it.kind === "polyline" || it.kind === "circle" || it.kind === "arc" || it.kind === "bezier") {
      if (it.bbox) full.set(it.id, grow(full.get(it.id) || null, it.bbox.slice() as Box));
    } else if (it.bbox && (it.kind === "junction" || it.kind === "no_connect" || it.kind === "bus_entry")) full.set(it.id, grow(full.get(it.id) || null, it.bbox.slice() as Box));
  }
  return { list, full };
}

/** The part of the page a drawing may use: inside the sheet border, clear of the title block (KiCad's default drawing sheet). */
/**
 * Where a part's reference, value or other shown field is drawn over something, the nearest shift that puts it in
 * the clear.  KiCad's Autoplace Fields looks at the wires and parts around a symbol, not at the labels on its
 * own pins, so a value can land on a pin's net label; this is the look a person takes afterwards.
 */
export function fieldShifts(doc: any, input: { refs?: string[]; within?: number[] } = {}): { id: string; field: string; dx: number; dy: number }[] {
  const { list } = pieces(doc); const out: { id: string; field: string; dx: number; dy: number }[] = [];
  const want = input.refs && input.refs.length ? new Set(input.refs.map((r) => r.toLowerCase())) : null; const within = input.within && input.within.length === 4 ? input.within : null;
  const T = 0.2, B = 0.3, G = 1.27;
  const blocked = (me: Piece, box: Box): boolean => {
    const t = shrink(box, T);
    for (const o of list) {
      if (o === me || o.box[0] > box[2] || o.box[2] < box[0] || o.box[1] > box[3] || o.box[3] < box[1]) continue;
      if (o.kind === "text") { if (hit(t, shrink(o.box, T))) return true; }
      else if (o.kind === "body") { if (hit(t, shrink(o.box, B))) return true; }
      else if (o.seg && segHits(o.seg, t)) return true;
    }
    return false;
  };
  const steps: [number, number][] = [];
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) if (i || j) steps.push([i * G, j * G]);
  steps.sort((a, b) => Math.hypot(a[0], a[1] * 1.01) - Math.hypot(b[0], b[1] * 1.01));
  for (const p of list) {
    if (!p.field) continue; const it = doc.items.get(p.id); if (!it) continue;
    if (want ? !want.has(String(it.ref || "").toLowerCase()) : /^#/.test(it.ref || "")) continue;
    if (within && !(it.x >= within[0] && it.x <= within[2] && it.y >= within[1] && it.y <= within[3])) continue;
    if (!blocked(p, p.box)) continue;
    for (const [dx, dy] of steps) {
      const b: Box = [p.box[0] + dx, p.box[1] + dy, p.box[2] + dx, p.box[3] + dy];
      if (blocked(p, b)) continue;
      p.box = b; out.push({ id: p.id, field: p.field, dx: r2(dx), dy: r2(dy) }); break;
    }
  }
  return out;
}
/**
 * Fields of a two pin part drawn in line with a wire, the way a person sets them: the reference just before the
 * body and the value just after it, both sitting on the wire, so parts on neighbouring rows can stack.
 */
/**
 * Reference and value of an upright two pin part pulled in beside its body: Autoplace Fields leaves them a pin length
 * away, a person slides them up against the part.
 */
export function snugFieldShifts(doc: any, input: { refs?: string[]; within?: number[] } = {}): { id: string; field: string; dx: number; dy: number }[] {
  const s = SCH(); const { list } = pieces(doc); const out: { id: string; field: string; dx: number; dy: number }[] = [];
  const want = input.refs && input.refs.length ? new Set(input.refs.map((r) => r.toLowerCase())) : null; const within = input.within && input.within.length === 4 ? input.within : null;
  const GAP = 0.6;
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind !== "symbol" || /^#/.test(it.ref || "")) continue;
    if (want && !want.has(String(it.ref || "").toLowerCase())) continue;
    if (within && !(it.x >= within[0] && it.x <= within[2] && it.y >= within[1] && it.y <= within[3])) continue;
    const pins = s._.symbolPins(doc, it); if (pins.length !== 2 || Math.abs(pins[0].x - pins[1].x) > 1e-3) continue;
    const body = list.find((p) => p.id === it.id && p.kind === "body"); if (!body) continue;
    for (const p of list) {
      if (p.id !== it.id || !p.field) continue;
      let dx = 0;
      if (p.box[0] >= body.box[2] - 0.05) dx = body.box[2] + GAP - p.box[0]; else if (p.box[2] <= body.box[0] + 0.05) dx = body.box[0] - GAP - p.box[2];
      if (Math.abs(dx) > 0.05) out.push({ id: it.id, field: p.field, dx: r2(dx), dy: 0 });
    }
  }
  return out;
}
export function inlineFieldShifts(doc: any, refs: string[]): { id: string; field: string; dx: number; dy: number }[] {
  const s = SCH(); const { list } = pieces(doc); const out: { id: string; field: string; dx: number; dy: number }[] = [];
  const want = new Set(refs.map((r) => r.toLowerCase()));
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind !== "symbol" || !want.has(String(it.ref || "").toLowerCase())) continue;
    const pins = s._.symbolPins(doc, it); if (pins.length !== 2 || Math.abs(pins[0].y - pins[1].y) > 1e-3) continue;
    const y = pins[0].y, xl = Math.min(pins[0].x, pins[1].x), xr = Math.max(pins[0].x, pins[1].x);
    const body = list.find((p) => p.id === it.id && p.kind === "body"); if (!body) continue;
    const bl = Math.max(body.box[0], xl), br = Math.min(body.box[2], xr);
    for (const p of list) {
      if (p.id !== it.id || !p.field) continue;
      if (p.field === "Reference") out.push({ id: it.id, field: p.field, dx: r2(bl - 0.4 - p.box[2]), dy: r2(y - 0.35 - p.box[3]) });
      else if (p.field === "Value") out.push({ id: it.id, field: p.field, dx: r2(br + 0.4 - p.box[0]), dy: r2(y - 0.35 - p.box[3]) });
    }
  }
  return out;
}
export function pageAreas(page: number[]): { area: Box; title: Box } {
  const w = page[0] || 297, h = page[1] || 210;
  return { area: [12, 12, w - 12, h - 12], title: [w - 122, h - 46, w - 10, h - 10] };
}

/** A wire that starts on one of the symbol's own pins and runs away from it is that pin's wire, even where the drawing reaches past the pin's end. */
function leavesPin(body: Piece, sg: Seg): boolean {
  const b = shrink(body.box, 0.3); const out = (x: number, y: number) => x <= b[0] || x >= b[2] || y <= b[1] || y >= b[3];
  for (const [px, py] of body.pins || []) {
    if (Math.abs(sg[0] - px) < 1e-3 && Math.abs(sg[1] - py) < 1e-3 && out(sg[2], sg[3])) return true;
    if (Math.abs(sg[2] - px) < 1e-3 && Math.abs(sg[3] - py) < 1e-3 && out(sg[0], sg[1])) return true;
  }
  return false;
}

export interface Overlap { what: string; a: string; b: string; at: [number, number] }

function overlapsOf(doc: any, list: Piece[], full: Map<string, Box>): Overlap[] {
  const out: Overlap[] = []; const seen = new Set<string>();
  const say = (what: string, a: Piece, b: Piece | string, at: [number, number]) => {
    const bn = typeof b === "string" ? b : b.name; const key = [what, a.owner, a.name, typeof b === "string" ? b : b.owner + b.name].join("|"); if (seen.has(key)) return; seen.add(key);
    out.push({ what, a: a.name, b: bn, at });
  };
  // a sweep over x keeps this near linear for a sheet of a few thousand pieces
  const order = list.map((p, i) => i).sort((i, j) => list[i].box[0] - list[j].box[0]);
  const T = 0.2, B = 0.3;
  for (let oi = 0; oi < order.length; oi++) {
    const a = list[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = list[order[oj]]; if (b.box[0] > a.box[2] + 0.5) break;
      if (a.owner === b.owner && !(a.kind === "text" && b.kind === "text")) continue;
      const pair = (x: Piece, y: Piece): boolean => {
        if (x.kind === "text" && y.kind === "text") { if (hit(shrink(x.box, T), shrink(y.box, T))) { say("text over text", x, y, mid(x.box, y.box)); } return true; }
        if (x.kind === "text" && y.kind === "body") { if (hit(shrink(x.box, T), shrink(y.box, B))) say("text over a symbol", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "text" && y.kind === "wire") { if (segHits(y.seg as Seg, shrink(x.box, T))) say("wire through text", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "text" && y.kind === "frame") { if (segHits(y.seg as Seg, shrink(x.box, T))) say("frame through text", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "body" && y.kind === "body") { if (hit(shrink(x.box, B), shrink(y.box, B))) say("symbols overlap", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "body" && y.kind === "wire") { if (segHits(y.seg as Seg, shrink(x.box, B)) && !leavesPin(x, y.seg as Seg)) say("wire through a symbol", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "body" && y.kind === "frame") { if (segHits(y.seg as Seg, shrink(x.box, B))) say("frame through a symbol", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "wire" && y.kind === "frame") { if (segsCross(x.seg as Seg, y.seg as Seg)) say("wire crosses a frame", x, y, mid(x.box, y.box)); return true; }
        if (x.kind === "frame" && y.kind === "frame") { if (segsCross(x.seg as Seg, y.seg as Seg)) say("frames cross", x, y, mid(x.box, y.box)); return true; }
        return false;
      };
      if (!pair(a, b)) pair(b, a);
    }
  }
  // off the page, or in the title block
  const { area, title } = pageAreas(doc.page || [297, 210]); const done = new Set<string>();
  for (const p of list) {
    if (done.has(p.owner)) continue; const b = full.get(p.owner) || p.box;
    if (!inside(b, area)) { done.add(p.owner); out.push({ what: "outside the page border", a: p.name, b: "page", at: [r2((b[0] + b[2]) / 2), r2((b[1] + b[3]) / 2)] }); }
    else if (hit(b, title)) { done.add(p.owner); out.push({ what: "over the title block", a: p.name, b: "title block", at: mid(b, title) }); }
  }
  return out;
}

/** Break a note into lines no wider than `width` millimetres at this text size. */
export function wrapText(text: string, size: number, width: number): { lines: string[]; width: number } {
  const k = K(); const lines: string[] = []; let widest = 0;
  for (const para of String(text).split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + " " + word : word;
      if (cur && k.textWidth(next, size, 0) > width) { lines.push(cur); cur = word; } else cur = next;
    }
    lines.push(cur);
  }
  for (const l of lines) widest = Math.max(widest, k.textWidth(l, size, 0));
  return { lines, width: r2(widest) };
}

/**
 * The connected surroundings of some parts: their stubs, labels, power symbols and junctions, found by
 * walking wires from their pins until another part is reached.  It is what a frame around a block must contain.
 */
function surroundings(doc: any, refs: string[]): Set<string> {
  const s = SCH(), k = K(); const want = new Set(refs.map((r) => r.toLowerCase())); const ids = new Set<string>();
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const at = new Map<string, { id: string; other?: string; stop?: boolean }[]>(); const put = (kx: string, v: { id: string; other?: string; stop?: boolean }) => { const l = at.get(kx); if (l) l.push(v); else at.set(kx, [v]); };
  const start: string[] = [];
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind === "symbol") {
      const mine = want.has(String(it.ref || "").toLowerCase()), power = /^#/.test(it.ref || "");
      if (mine) ids.add(it.id);
      for (const p of s._.symbolPins(doc, it)) { const kx = key(p.x, p.y); if (mine) start.push(kx); else put(kx, { id: it.id, stop: !power }); }
    } else if (it.kind === "wire" || it.kind === "bus") {
      const pts = k.ptsOf(it.node); if (pts.length < 2) continue; const a = key(pts[0][0], pts[0][1]), b = key(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      put(a, { id: it.id, other: b }); put(b, { id: it.id, other: a });
    } else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label" || it.kind === "junction" || it.kind === "no_connect") { const [x, y] = k.atOf(it.node); put(key(x, y), { id: it.id }); }
  }
  const seen = new Set<string>(); const todo = start.slice();
  while (todo.length) {
    const kx = todo.pop() as string; if (seen.has(kx)) continue; seen.add(kx);
    for (const v of at.get(kx) || []) { if (v.stop) continue; ids.add(v.id); if (v.other) todo.push(v.other); }
  }
  return ids;
}

/**
 * Free room for a box of w × h: beside the things in `around` when given (inside the frame that holds them, when
 * there is one), else anywhere on the page.  Top left corner, or null when the page has no such room.
 */
function findFree(doc: any, list: Piece[], around: Box | null, w: number, h: number): { x: number; y: number } | null {
  const { area, title } = pageAreas(doc.page || [297, 210]); const gap = 1.27, step = 1.27;
  const clear = (b: Box) => inside(b, area) && !hit(b, title) && !list.some((p) => (p.seg ? segHits(p.seg, [b[0] - gap, b[1] - gap, b[2] + gap, b[3] + gap]) : hit(p.box, [b[0] - gap, b[1] - gap, b[2] + gap, b[3] + gap])));
  const snap = (v: number) => Math.round(v / step) * step;
  if (around) {
    let best: { x: number; y: number; d: number } | null = null; const cx = (around[0] + around[2]) / 2, cy = (around[1] + around[3]) / 2;
    for (let ring = 0; ring < 60 && !best; ring++) {
      const m = 2.54 + ring * step; const x0 = snap(around[0] - m - w), x1 = snap(around[2] + m), y0 = snap(around[1] - m - h), y1 = snap(around[3] + m);
      const tries: [number, number][] = [];
      for (let x = x0; x <= x1 + 1e-6; x += step) { tries.push([x, y1]); tries.push([x, y0]); }
      for (let y = y0; y <= y1 + 1e-6; y += step) { tries.push([x1, y]); tries.push([x0, y]); }
      for (const [x, y] of tries) { const b: Box = [x, y, x + w, y + h]; if (!clear(b)) continue; const d = Math.hypot(x + w / 2 - cx, (y + h / 2 - cy) * 1.5); if (!best || d < best.d) best = { x, y, d }; }
    }
    return best ? { x: r2(best.x), y: r2(best.y) } : null;
  }
  for (let y = snap(area[1] + 2); y + h < area[3]; y += 2 * step) for (let x = snap(area[0] + 2); x + w < area[2]; x += 2 * step) { const b: Box = [x, y, x + w, y + h]; if (clear(b)) return { x: r2(x), y: r2(y) }; }
  return null;
}

export interface LayoutInput { doc?: string; within?: number[]; of?: string[]; wrap?: { text: string; size?: number; width: number }[]; limit?: number; free?: { near?: string; w: number; h: number } }

/**
 * What lies on top of what on a schematic sheet, and how much room things take.
 *   overlaps: each with what it is, the two things and where
 *   extent:   the box around everything on the sheet, or around the items inside `within`, or around the parts
 *             named in `of` with the stubs, labels and power symbols on their pins
 *   wrapped:  for each entry of `wrap`, the note broken into lines of at most that width
 */
export async function checkLayout(input: LayoutInput): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc);
  if (doc.type !== "sch") throw new ToolError("The layout check is for schematic sheets; the board has its design rules check.");
  if (!SCH()) throw new ToolError("The schematic tools are not loaded.");
  const { list, full } = pieces(doc); const all = overlapsOf(doc, list, full);
  const by: Record<string, number> = {}; for (const o of all) by[o.what] = (by[o.what] || 0) + 1;
  let extent: Box | null = null, counted = 0;
  const w = Array.isArray(input.within) && input.within.length === 4 ? (input.within as Box) : null;
  const of = Array.isArray(input.of) && input.of.length ? surroundings(doc, input.of.map(String)) : null;
  for (const [id, b] of full) { if (of && !of.has(id)) continue; if (w && !inside(b, w)) continue; extent = grow(extent, b); counted++; }
  let free: { x: number; y: number } | null | undefined;
  if (input.free && input.free.w > 0 && input.free.h > 0) {
    let around: Box | null = null;
    if (input.free.near) { const ids = surroundings(doc, [String(input.free.near)]); for (const id of ids) { const b = full.get(id); if (b) around = grow(around, b); } if (!around) throw new ToolError(`There is no part ${input.free.near} on ${path}.`); }
    free = findFree(doc, list, around, input.free.w, input.free.h);
  }
  const { area, title } = pageAreas(doc.page || [297, 210]); const cap = Math.max(1, Math.min(200, input.limit || 40));
  // the framed sections: each frame with its heading (the topmost text inside it) and the parts it holds
  const k = K(); const sections: { title: string; box: number[]; parts: string[] }[] = [];
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind !== "rectangle") continue; const sa = k.kid(it.node, "start"), se = k.kid(it.node, "end"); if (!sa || !se) continue;
    const b: Box = [Math.min(k.num(sa[1]), k.num(se[1])), Math.min(k.num(sa[2]), k.num(se[2])), Math.max(k.num(sa[1]), k.num(se[1])), Math.max(k.num(sa[2]), k.num(se[2]))];
    let head = "", top = Infinity; const parts: string[] = [];
    for (const o of doc.items.values() as Iterable<any>) {
      if (o.kind === "text") { const [x, y] = k.atOf(o.node); if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && y < top) { top = y; head = k.str(o.node[1]); } }
      else if (o.kind === "symbol" && o.ref && !/^#/.test(o.ref) && o.x >= b[0] && o.x <= b[2] && o.y >= b[1] && o.y <= b[3] && !parts.includes(o.ref)) parts.push(o.ref);
    }
    sections.push({ title: head, box: b.map(r2), parts: parts.sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) });
  }
  sections.sort((x, y) => x.box[1] - y.box[1] || x.box[0] - y.box[0]);
  return { sections, document: path, page: (doc.page || []).map(r2), paper: doc.paper || "A4", drawing_area: area.map(r2), title_block: title.map(r2),
    extent: extent ? extent.map(r2) : null, items: counted,
    count: all.length, by_kind: by, overlaps: all.slice(0, cap).map((o) => ({ what: o.what, a: o.a, b: o.b, x: o.at[0], y: o.at[1] })),
    truncated: all.length > cap ? `showing ${cap} of ${all.length}` : undefined,
    free,
    wrapped: Array.isArray(input.wrap) ? input.wrap.map((q) => wrapText(String(q.text || ""), q.size || 1.27, q.width || 60)) : undefined };
}

/** The ids of the items wholly inside a box (what move_region moves). */
export function itemsWithin(doc: any, box: number[]): string[] {
  const { full } = pieces(doc); const out: string[] = [];
  for (const it of doc.items.values() as Iterable<any>) { const b = full.get(it.id) || (it.bbox as Box | null); if (b && inside(b, box as Box)) out.push(it.id); }
  return out;
}
