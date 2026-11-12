import type { SchCtx, Pt, Box } from "./types";
import { editable, selectedItems } from "./commands";
import { isPowerSymbol } from "./dom";
import { isNetLine } from "./drag";
import { fontNode } from "./nodes";
import { K, atOf, kid, kids, num, ptsOf, str } from "./state";
import { deep, dropKid, modChange, r4, replaceKid } from "./util";

// ---------------------------------------------------------------- symbol pins with their electrical type (lib symbol + transform)
/** A symbol pin on the sheet: its connection point, the root at the body, number, name, electrical type and side. */
export interface SymPin { x: number; y: number; root: Pt; number: string; name: string; type: string; hidden: boolean; len: number; side: string }
export function symbolPins(doc: KDoc, item: Pick<KItem, "node">): SymPin[] {
  const n = item.node, out: SymPin[] = [];
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, str((kid(n, "lib_id") || [])[1])); if (!lib) return out;
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
  const tf = (lx: number, ly: number): Pt => [r4(ax + T[0] * lx + T[1] * ly), r4(ay + T[2] * lx + T[3] * ly)];
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
    if ((u !== 0 && u !== unit) || (m && s !== 0 && s !== style)) continue;   // unit 0 / body style 0 = common to all
    for (const g of kids(sub, "pin")) {
      const [px, py, pr] = atOf(g), lenN = kid(g, "length"), len = lenN ? num(lenN[1]) : 2.54;
      const dir = ((Math.round(pr) % 360) + 360) % 360, d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
      const pos = tf(px, py), root = tf(px + d[0] * len, py + d[1] * len);
      const h = kid(g, "hide"); const hidden = h ? str(h[1]) !== "no" : g.includes("hide");
      let ox = pos[0] - root[0], oy = pos[1] - root[1]; const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
      if (!ox && !oy) { const tip = tf(px - d[0], py - d[1]); ox = Math.sign(tip[0] - pos[0]); oy = Math.sign(tip[1] - pos[1]); }
      out.push({ x: pos[0], y: pos[1], root, number: str((kid(g, "number") || [])[1]), name: str((kid(g, "name") || [])[1]), type: str(g[1]) || "passive", hidden, len,
        side: ox > 0 ? "right" : ox < 0 ? "left" : oy < 0 ? "top" : "bottom" });
    }
  }
  return out;
}
export function symbolLibId(node: SNode) { return str((kid(node, "lib_id") || [])[1]); }
export function symbolIsPower(doc: KDoc, item: KItem) { return isPowerSymbol(doc, symbolLibId(item.node)); }
// SCH_PIN::IsGlobalPower: a power input of a global power symbol, or (legacy) a hidden power input of any symbol
// that is not a local power symbol ((power local) in KiCad 10).
export function globalPowerPin(doc: KDoc, item: KItem, pin: SymPin) {
  if (pin.type !== "power_in") return false;
  const lib = K.resolveLib(doc, symbolLibId(item.node)) || doc.lib.get(symbolLibId(item.node)), pw = lib && kid(lib, "power");
  if (pw && pw.includes("local")) return false;
  if (pw) return true;
  return !!pin.hidden;
}

// ---------------------------------------------------------------- autoplace fields (eeschema/autoplace_fields.cpp)
export const AP_HPADDING = 0.635, AP_VPADDING = 0.381, AP_GRID = 1.27, AP_WIRE_V = 2.54, AP_FIELD_PADDING = 0.381;
export const SIDES: Record<string, Pt> = { right: [1, 0], top: [0, -1], left: [-1, 0], bottom: [0, 1] };
// round_n on positive IU: up or down to the next multiple of n
export function roundN(v: number, n: number, up: boolean) { const q = v / n, r = Math.round(q); if (Math.abs(q - r) < 1e-6) return r4(r * n); return r4((up ? Math.ceil(q) : Math.floor(q)) * n); }
export function fieldHidden(p: SNode) { const h = kid(p, "hide"); if (h) return str(h[1]) !== "no"; const ef = kid(p, "effects"); return !!(ef && (ef.includes("hide") || (kid(ef, "hide") && str(kid(ef, "hide")![1]) !== "no"))); }
export function fieldFont(p: SNode) { const ef = kid(p, "effects"), f = ef && kid(ef, "font"), s = f && kid(f, "size"), th = f && kid(f, "thickness"); const size = s ? num(s[2], num(s[1], 1.27)) : 1.27; const bold = !!(f && (f.includes("bold") || (kid(f, "bold") && str(kid(f, "bold")![1]) !== "no"))); const thick = th && num(th[1]) > 0.001 ? num(th[1]) : Math.min(bold ? size / 5 : size / 8, size / 4); return { size, thick, bold }; }
// EDA_TEXT::GetTextBox for the stroke font: glyph extents inflated by 1.5 × pen, 17% taller.
export function fieldExtent(p: SNode) {
  const { size, thick } = fieldFont(p), text = str(p[2]);
  const lines = text.split("\n"), w = Math.max(...lines.map((l) => K.textWidth(l, size, 0))) + 3 * thick;
  return { w: r4(w), h: r4((size + 3 * thick) * 1.17 + (lines.length - 1) * size * 1.61) };
}
// The body box: the library drawing (no pins, no fields) plus the visible pin roots, on the sheet.
export function bodyBox(doc: KDoc, item: KItem) {
  const n = item.node, libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, symbolLibId(n));
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  const tf = (lx: number, ly: number): Pt => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  let b: Box | null = null as Box | null; const take = (p: Pt) => { b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
  if (lib) {
    const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
    for (const sub of kids(lib, "symbol")) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || (m && s !== 0 && s !== style)) continue;   // unit 0 / body style 0 = common to all
      for (const g of sub.slice(2)) {
        if (!Array.isArray(g)) continue;
        const gk = g[0];
        if (gk === "rectangle") { const a = kid(g, "start")!, e = kid(g, "end")!; take(tf(num(a[1]), num(a[2]))); take(tf(num(e[1]), num(e[2]))); }
        else if (gk === "circle") { const c = kid(g, "center")!, r = num((kid(g, "radius") || [])[1]); for (const [dx, dy] of [[-r, -r], [r, r], [-r, r], [r, -r]]) take(tf(num(c[1]) + dx, num(c[2]) + dy)); }
        else if (gk === "arc") { for (const key of ["start", "mid", "end"]) { const k = kid(g, key); if (k) take(tf(num(k[1]), num(k[2]))); } }
        else if (gk === "polyline" || gk === "bezier") { for (const [x, y] of ptsOf(g)) take(tf(x, y)); }
        else if (gk === "text") { const [tx, ty] = atOf(g), ef = K.effectsOf(g); if (!ef.hide) { const w = K.textWidth(str(g[1]), ef.size, 0) / 2; take(tf(tx - w, ty - ef.size / 2)); take(tf(tx + w, ty + ef.size / 2)); } }
      }
    }
  }
  for (const pin of symbolPins(doc, item)) if (!pin.hidden) take(pin.root);
  return (b || [ax, ay, ax, ay]).map(r4);
}
export const boxW = (b: Box) => b[2] - b[0], boxH = (b: Box) => b[3] - b[1];
export function boxesIntersect(a: Box | null, b: Box | null) { return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
export function autoplaceNode(doc: KDoc, item: KItem, opts?: { manual?: boolean } | null) {
  opts = opts || {};
  const node = deep(item.node), power = symbolIsPower(doc, item), pins = symbolPins(doc, item).filter((p) => !p.hidden || power);
  const fields = kids(node, "property").filter((p) => !fieldHidden(p) && !str(p[1]).startsWith("ki_") && str(p[2]) !== "");
  if (!fields.length) return null;
  const [, , rot] = atOf(node), mN = kid(node, "mirror"), mirror = mN ? str(mN[1]) : "", T = K.symbolTransform(rot, mirror);
  const fieldRot = T[1] !== 0 ? 90 : 0;                          // vertical storage counters the transform: fields always display horizontally
  const flipStored = (T[1] !== 0 ? T[1] : T[0]) < 0;             // the canvas (and IsHorizJustifyFlipped) render the stored justify flipped
  const body = bodyBox(doc, item), symW = boxW(body), symH = boxH(body);
  const ext = fields.map(fieldExtent);
  let fbox = { w: Math.max(...ext.map((e) => e.w)), h: ext.reduce((t, e) => t + roundN(e.h, AP_GRID, true), 0) };
  const pinsOn = (side: string) => pins.filter((p) => p.side === side).length;
  // getPreferredSides
  let sides = ["right", "top", "left", "bottom"].map((s) => ({ side: s, pins: pinsOn(s) }));
  const swap = (i: number, j: number) => { const t = sides[i]; sides[i] = sides[j]; sides[j] = t; };
  if (power) { if (rot === 0) { swap(0, 1); swap(1, 3); } else if (rot === 90) { swap(0, 2); swap(1, 2); } else if (rot === 180) swap(0, 3); else if (rot === 270) swap(1, 2); }
  else { if (mirror === "x" && (rot === 0 || rot === 180)) swap(0, 2); if (symH > 0 && symW / symH > 3) { swap(0, 1); swap(1, 3); } }
  // fieldBoxPlacement
  const place = (sp: { side: string; pins: number }, size: { w: number; h: number }) => {
    const [sx, sy] = SIDES[sp.side], cx = (body[0] + body[2]) / 2, cy = (body[1] + body[3]) / 2;
    let ox = (symW + size.w) / 2, oy = (symH + size.h) / 2; if (sx) ox += AP_HPADDING; else if (sy) oy += AP_VPADDING;
    let x = cx + sx * ox - size.w / 2, y = cy + sy * oy - size.h / 2;
    if (sp.pins > 0) {
      let pb: Box | null = null; for (const p of pins) if (p.side === sp.side) for (const q of [[p.x, p.y], p.root]) pb = pb ? [Math.min(pb[0], q[0]), Math.min(pb[1], q[1]), Math.max(pb[2], q[0]), Math.max(pb[3], q[1])] : [q[0], q[1], q[0], q[1]];
      if (pb) { if (sy) x = pb[2] + 2 * AP_HPADDING; else y = pb[1] - (size.h + 2 * AP_VPADDING); }
    }
    return [x, y];
  };
  // chooseSideForFields (manual: sides whose field box collides with other items go last)
  const others = Array.from(doc.items.values()).filter((it) => it !== item && it.id !== item.id && it.bbox);
  const collision = (sp: { side: string; pins: number }) => {
    const [x, y] = place(sp, fbox), box = [x, y, x + fbox.w, y + fbox.h]; let coll = "none";
    for (const it of others) { if (!boxesIntersect(it.bbox, box)) continue; if (isNetLine(it.kind) && !SIDES[sp.side][0] && ptsOf(it.node).every((p) => Math.abs(p[1] - ptsOf(it.node)[0][1]) < 1e-6) && coll !== "objects") coll = "hwires"; else coll = "objects"; }
    return coll;
  };
  sides.reverse();
  let side = { side: "right", pins: Infinity };
  if (opts.manual !== false) {
    const colliding = new Map<string, string>(); for (const sp of sides) { const c = collision(sp); if (c !== "none") colliding.set(sp.side, c); }
    for (const kind of ["objects", "hwires"]) sides = sides.filter((sp) => { if (colliding.get(sp.side) !== kind) return true; if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; return false; });
  }
  let chosen: { side: string; pins: number } | null = null;
  for (let i = sides.length - 1; i >= 0; i--) if (!sides[i].pins) { chosen = sides[i]; break; }
  if (!chosen) { for (const sp of sides) if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; chosen = side; }
  let [bx, by] = place(chosen, fbox);
  const [sx, sy] = SIDES[chosen.side];
  // fitFieldsBetweenWires: only horizontal wires in the way -> fixed 100 mil rows on the wire pitch
  let wireSpacing = false;
  if (opts.manual !== false && sy) {
    const box = [bx, by, bx + fbox.w, by + fbox.h], hits = others.filter((it) => boxesIntersect(it.bbox, box));
    if (hits.length && hits.every((it) => isNetLine(it.kind) && ptsOf(it.node).length > 1 && Math.abs(ptsOf(it.node)[0][1] - ptsOf(it.node)[1][1]) < 1e-6)) {
      const offs = new Set(hits.map((it) => r4(1.5 * AP_WIRE_V - (ptsOf(it.node)[0][1] % AP_WIRE_V))));
      if (offs.size === 1) { wireSpacing = true; fbox = { w: fbox.w, h: fields.length * AP_WIRE_V }; by = roundN(by, AP_WIRE_V, chosen.side === "bottom"); }
    }
  }
  // move the fields
  let lastY = by;
  fields.forEach((p, i) => {
    let hj = sx ? (sx > 0 ? "left" : "right") : "center";
    if (chosen.pins > 0) hj = sy ? "left" : "center";
    let x = hj === "left" ? bx : hj === "right" ? bx + fbox.w : bx + fbox.w / 2;
    const fh = wireSpacing ? AP_WIRE_V / 2 : ext[i].h, pad = wireSpacing ? AP_WIRE_V / 2 : roundN(fh, AP_GRID, true) - fh;
    let y = lastY + pad / 2 + fh / 2; lastY += pad + fh;
    if (sx) x = roundN(x, AP_GRID, sx >= 0);
    if (sy) y = roundN(y, AP_GRID, sy >= 0);
    const a = kid(p, "at"); const keep = a ? a.slice(4) : [];
    replaceKid(p, ["at", r4(x), r4(y), fieldRot, ...keep]);
    const stored = flipStored ? (hj === "left" ? "right" : hj === "right" ? "left" : "center") : hj;
    let ef = kid(p, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; p.push(ef); }
    if (stored === "center") dropKid(ef, "justify"); else replaceKid(ef, ["justify", stored]);
  });
  dropKid(node, "fields_autoplaced");
  const ui = node.findIndex((c) => Array.isArray(c) && c[0] === "uuid");
  node.splice(ui >= 0 ? ui : node.length, 0, ["fields_autoplaced", "yes"]);
  return node;
}
export function autoplaceSelection(ctx: SchCtx, opts?: { manual?: boolean } | null) {
  if (!editable(ctx)) return false;
  const changes: KChange[] = [];
  for (const it of selectedItems(ctx)) { if (it.kind !== "symbol") continue; const n = autoplaceNode(ctx.doc, it, opts); if (n) changes.push(modChange(ctx.doc, it, n)); }
  if (!changes.length) return false;
  ctx.commit(changes, "autoplace fields"); return true;
}
