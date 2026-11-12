// pcb-tools/fp-pads.ts — the Footprint Editor's pad commands beyond placing pads (pcbnew/tools/pad_tool.cpp,
// pcbnew/dialogs/dialog_fp_edit_pad_table.cpp, pcbnew/pad.cpp):
//
//   Push Pad Properties to Other Pads   PAD_TOOL::pushPadSettings / doPushPadProperties / PAD::ImportSettingsFrom
//   Edit Pad as Graphic Shapes          PAD_TOOL::explodePad (custom pad -> its primitives as footprint shapes)
//   Finish Pad Edit                     PAD::Recombine (touching shapes on the pad's layer -> primitives)
//   Pad Table                           DIALOG_FP_EDIT_PAD_TABLE: rows, CSV export / import, "Edit Pads"
//   Renumber Pads                       PAD_TOOL::EnumeratePads, the interactive click-each-pad mode
//
// All pure: they read the footprint document (pads are items of kind "pad", shapes gr_*) and return changes.
type SAtom = string | number | SNode;
import type { BoardDoc, PcbChange, Pt } from "./types";
import { K } from "./state";
import { addedChange, removedChange, replacedChange } from "./changes";
import { rotateNode, translateNode } from "./transforms";
import { clone, isList, r6, rotator } from "./util";
import { canHaveNumber } from "./pad-tool";

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
const padItems = (doc: BoardDoc): KItem[] => Array.from(doc.items.values()).filter((i) => i.kind === "pad");
const layersOf = (n: SNode): string[] => (K.kid(n, "layers") || []).slice(1).map(str);
const atOf = (n: SNode): [number, number, number] => { const a = K.kid(n, "at") || []; return [num(a[1]), num(a[2]), num(a[3])]; };
/** Set (key …vals) on a node: replaced in place, else inserted after the last of `after` that exists (else at the end); null removes it. */
export function setKid(n: SNode, key: string, vals: SAtom[] | null, after: string[] = []): void {
  const cur = K.kid(n, key);
  if (vals === null) { if (cur) n.splice(n.indexOf(cur), 1); return; }
  const node: SNode = [key, ...vals];
  if (cur) { n[n.indexOf(cur)] = node; return; }
  let at = -1; for (const a of after) { const k = K.kid(n, a); if (k) at = Math.max(at, n.indexOf(k)); }
  n.splice(at >= 0 ? at + 1 : n.length, 0, node);
}
const PAD_ORDER = ["at", "size", "rect_delta", "drill", "property", "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length", "die_delay"];
const qs = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/** (layers "…" …) with the names quoted, as the writer has them. */
const layersNode = (ls: string[]): SAtom[] => (K.parse(`(layers ${ls.map(qs).join(" ")})`) as SNode).slice(1);
const setLayers = (n: SNode, ls: string[]) => { const cur = K.kid(n, "layers"); const node = K.parse(`(layers ${ls.map(qs).join(" ")})`) as SNode; if (cur) n[n.indexOf(cur)] = node; else setKid(n, "layers", layersNode(ls)); };
const after = (key: string) => PAD_ORDER.slice(0, Math.max(0, PAD_ORDER.indexOf(key)));

// ---------------------------------------------------------------- Push Pad Properties
export interface PushFilters { shape: boolean; size: boolean; orient: boolean; layers: boolean; type: boolean }
const isAperture = (n: SNode) => str(n[2]) === "smd" && !layersOf(n).some((l) => /\.Cu$/.test(l));
const sizeSig = (n: SNode) => K.serialize(["s", K.kid(n, "size") || [], K.kid(n, "rect_delta") || [], K.kid(n, "drill") || [], K.kid(n, "roundrect_rratio") || [], K.kid(n, "chamfer_ratio") || [], K.kid(n, "primitives") || []] as SNode);
/** PAD::ImportSettingsFrom( master ): everything but the number, position, uuid, net, pin function / type and pad-to-die values. */
export function importPadSettings(target: SNode, master: SNode): SNode {
  const n = clone(master);
  const keep = ["net", "pinfunction", "pintype", "die_length", "die_delay", "uuid", "tstamp"];
  for (const k of keep) {
    const t = K.kid(target, k), m = K.kid(n, k);
    if (t && m) n[n.indexOf(m)] = clone(t);
    else if (m) n.splice(n.indexOf(m), 1);
    else if (t) setKid(n, k, clone(t).slice(1) as SAtom[], k === "uuid" || k === "tstamp" ? n.filter(isList).map((c) => str((c as SNode)[0])) : after(k));
  }
  n[1] = canHaveNumber(n) ? target[1] : "";
  const [x, y] = atOf(target); const ma = K.kid(n, "at")!; ma[1] = x; ma[2] = y;
  // circles are circles (the master's x size both ways)
  if (str(n[3]) === "circle") { const s = K.kid(n, "size"); if (s) s[2] = s[1]; }
  if (["smd", "connect", "non_component"].includes(str(n[2]))) setKid(n, "drill", null);
  return n;
}
/** doPushPadProperties on the footprint being edited: the pads the filters let through take the source pad's settings. */
export function pushPadChanges(doc: BoardDoc, srcId: string, f: PushFilters): PcbChange[] {
  const src = doc.items.get(srcId); if (!src || src.kind !== "pad") return [];
  const out: PcbChange[] = [];
  for (const it of padItems(doc)) {
    if (it.id === srcId) continue;
    const p = it.node, s = src.node;
    if (f.shape && (str(p[3]) !== str(s[3]) || K.serialize(K.kid(p, "padstack") || []) !== K.serialize(K.kid(s, "padstack") || []))) continue;
    if (f.size && sizeSig(p) !== sizeSig(s)) continue;
    if (f.orient && r6(atOf(p)[2]) !== r6(atOf(s)[2])) continue;
    if (f.layers && layersOf(p).join() !== layersOf(s).join()) continue;
    if (f.type && str(p[2]) !== str(s[2])) continue;
    if (f.type && str(p[2]) === "connect" && isAperture(p) !== isAperture(s)) continue;
    const n = importPadSettings(p, s);
    if (K.serialize(n) !== K.serialize(p)) out.push(replacedChange(it, n));
  }
  return out;
}

// ---------------------------------------------------------------- Edit Pad as Graphic Shapes / Finish Pad Edit
/** PAD::GetPrincipalLayer: the first copper layer of the pad (F.Cu for *.Cu), else its first layer. */
export function principalLayer(pad: SNode): string {
  const ls = layersOf(pad);
  const cu = ls.find((l) => /\.Cu$/.test(l)); if (cu) return cu === "*.Cu" || cu === "F&B.Cu" ? "F.Cu" : cu;
  const l = ls[0] || "F.Cu"; return l.replace(/^\*\./, "F.");
}
/** ShapePos: the pad position plus its (rotated) shape offset. */
function shapePos(pad: SNode): Pt {
  const [x, y, a] = atOf(pad); const d = K.kid(pad, "drill"); const o = d ? K.kid(d, "offset") : null;
  if (!o) return [x, y];
  const [ox, oy] = rotator(a)(num(o[1]), num(o[2])); return [x + ox, y + oy];
}
/** A pad primitive (pad frame) as a footprint shape on `layer` (footprint frame). */
function primitiveToShape(g: SNode, pad: SNode, layer: string): SNode {
  const n = clone(g); const k = str(n[0]);
  const w = K.kid(n, "width"); const width = w ? num(w[1]) : 0; if (w) n.splice(n.indexOf(w), 1);
  const fill = K.kid(n, "fill"); if (fill) n.splice(n.indexOf(fill), 1);
  const [, , a] = atOf(pad); const [px, py] = shapePos(pad);
  if (a) rotateNode(n, 0, 0, a);
  translateNode(n, px, py);
  n.push(["stroke", ["width", r6(width)], ["type", "solid"]]);
  if (k !== "gr_line" && k !== "gr_arc" && k !== "gr_curve") n.push(["fill", fill && str(fill[1]) !== "no" && str(fill[1]) !== "none" ? "yes" : "no"]);
  n.push(K.parse(`(layer ${qs(layer)})`) as SNode, ["uuid", K.newUuid()]);
  return n;
}
/** PAD_TOOL::explodePad: the custom pad's primitives become shapes on its principal layer; the pad keeps its anchor shape. */
export function explodePadChanges(doc: BoardDoc, padId: string): PcbChange[] {
  const it = doc.items.get(padId); if (!it || it.kind !== "pad") return [];
  const pad = clone(it.node); const out: PcbChange[] = [];
  if (str(pad[3]) === "custom") {
    const prims = K.kid(pad, "primitives"); const layer = principalLayer(pad);
    for (const g of prims ? prims.slice(1) : []) if (isList(g) && /^gr_/.test(str(g[0])) && g[0] !== "gr_bbox") out.push(addedChange(doc, primitiveToShape(g as SNode, pad, layer)));
    const opts = K.kid(pad, "options"); const anchor = opts ? K.kid(opts, "anchor") : null;
    pad[3] = anchor ? str(anchor[1]) : "circle";
    setKid(pad, "primitives", null); setKid(pad, "options", null);
  }
  out.unshift(replacedChange(it, pad));
  return out;
}

const pointInPoly = (p: Pt, pts: Pt[]) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
function segDist(p: Pt, a: Pt, b: Pt): number { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
/** The pad's copper outline on its layer, as a polygon (rect / roundrect / oval / circle / trapezoid approximated; custom: anchor + primitives' hulls are not needed: a custom pad recombines through its anchor). */
export function padOutline(pad: SNode): Pt[] {
  const [x, y, a] = atOf(pad); const s = K.kid(pad, "size"); const w = num(s && s[1]), h = num(s && s[2]);
  const [cx, cy] = shapePos(pad); const R = rotator(a);
  const shape = str(pad[3]);
  const local: Pt[] = [];
  if (shape === "circle" || shape === "oval") { const n = 32; for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; local.push([w / 2 * Math.cos(t), h / 2 * Math.sin(t)]); } }
  else local.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
  void x; void y;
  return local.map(([lx, ly]) => { const [rx, ry] = R(lx, ly); return [cx + rx, cy + ry] as Pt; });
}
/** The points of a footprint shape that tell whether it touches the pad (its outline, sampled). */
function shapePoints(n: SNode): Pt[] {
  const k = str(n[0]); const p = (key: string): Pt | null => { const c = K.kid(n, key); return c ? [num(c[1]), num(c[2])] : null; };
  if (k === "gr_poly" || k === "gr_curve") return ((K.kid(n, "pts") || []).slice(1) as SNode[]).filter((xy) => isList(xy) && xy[0] === "xy").map((xy) => [num(xy[1]), num(xy[2])] as Pt);
  if (k === "gr_rect") { const a = p("start"), b = p("end"); return a && b ? [a, [b[0], a[1]], b, [a[0], b[1]]] : []; }
  if (k === "gr_circle") { const c = p("center"), e = p("end"); if (!c || !e) return []; const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const out: Pt[] = []; for (let i = 0; i < 32; i++) { const t = 2 * Math.PI * i / 32; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); } return out; }
  const pts = ["start", "mid", "end"].map(p).filter(Boolean) as Pt[];
  return pts;
}
/** Does a shape intersect the pad (TransformShapeToPolygon & BooleanIntersection non-empty)? */
export function shapeTouchesPad(n: SNode, pad: SNode): boolean {
  const outline = padOutline(pad); const pts = shapePoints(n); if (!pts.length) return false;
  const w = K.kid(n, "stroke"); const sw = w ? num((K.kid(w, "width") || [])[1]) : num((K.kid(n, "width") || [])[1]);
  const closed = ["gr_poly", "gr_rect", "gr_circle"].includes(str(n[0]));
  if (pts.some((q) => pointInPoly(q, outline))) return true;
  if (closed && outline.some((q) => pointInPoly(q, pts))) return true;
  // edges crossing (or within half the stroke)
  const segs: [Pt, Pt][] = []; for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]); if (closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
  for (const [a, b] of segs) for (let i = 0; i < outline.length; i++) { const c = outline[i], d = outline[(i + 1) % outline.length]; if (segDist(c, a, b) <= sw / 2 + 1e-9 || segDist(a, c, d) <= sw / 2 + 1e-9 || crosses(a, b, c, d)) return true; }
  return false;
}
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean { const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); }

/** A footprint shape as a pad primitive (pad frame): the layer, uuid and stroke go, the width stays, hatched fills become solid. */
function shapeToPrimitive(n: SNode, pad: SNode): SNode {
  const g = clone(n); const [px, py] = shapePos(pad); const a = atOf(pad)[2];
  translateNode(g, -px, -py); if (a) rotateNode(g, 0, 0, -a);
  const st = K.kid(g, "stroke"); const width = st ? num((K.kid(st, "width") || [])[1]) : 0;
  const fill = K.kid(g, "fill"); const filled = !!fill && !["no", "none"].includes(str(fill[1]));
  for (const k of ["stroke", "fill", "layer", "uuid", "tstamp", "locked", "net"]) setKid(g, k, null);
  g.push(["width", r6(width)]);
  if (str(g[0]) !== "gr_line" && str(g[0]) !== "gr_arc" && str(g[0]) !== "gr_curve") g.push(["fill", filled ? "yes" : "no"]);
  return g;
}
/**
 * PAD::Recombine: every shape on the pad's principal layer that touches the pad (repeatedly, so a chain of touching
 * shapes all join) becomes a primitive; a pad that was not custom turns custom with its rect / circle as the anchor,
 * any other shape becoming a circle anchor plus its outline as a polygon primitive.  Returns the changes and the
 * shapes merged (dry run: only the shapes).
 */
export function recombinePadChanges(doc: BoardDoc, padId: string, dryRun = false): { changes: PcbChange[]; merged: string[] } {
  const it = doc.items.get(padId); if (!it || it.kind !== "pad") return { changes: [], merged: [] };
  const pad = clone(it.node); const layer = principalLayer(pad);
  const shapes = Array.from(doc.items.values()).filter((s) => /^gr_(line|rect|circle|arc|poly|curve)$/.test(s.kind) && str((K.kid(s.node, "layer") || [])[1]) === layer);
  const merged: KItem[] = []; const used = new Set<string>();
  // the pad grows as shapes join: test against the pad and every shape already merged
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of shapes) {
      if (used.has(s.id)) continue;
      if (shapeTouchesPad(s.node, pad) || merged.some((m) => shapesTouch(m.node, s.node))) { used.add(s.id); merged.push(s); grew = true; }
    }
  }
  if (dryRun || !merged.length) return { changes: [], merged: merged.map((m) => m.id) };
  const shape = str(pad[3]);
  let prims = K.kid(pad, "primitives");
  if (shape !== "custom") {
    if (shape === "circle" || shape === "rect") setKid(pad, "options", [["clearance", "outline"], ["anchor", shape]], after("chamfer").concat(["net", "pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap"]));
    else {
      // a circular anchor inside the old outline, and the outline itself as a polygon primitive
      const outline = padOutline(pad); const c = shapePos(pad);
      let r = Infinity; for (let i = 0; i < outline.length; i++) r = Math.min(r, segDist(c, outline[i], outline[(i + 1) % outline.length]));
      const poly: SNode = ["gr_poly", ["pts", ...outline.map(([x, y]) => ["xy", r6(x), r6(y)] as SNode)], ["stroke", ["width", 0], ["type", "solid"]], ["fill", "yes"]];
      setKid(pad, "size", [r6(2 * r), r6(2 * r)], after("size"));
      setKid(pad, "roundrect_rratio", null); setKid(pad, "chamfer_ratio", null); setKid(pad, "chamfer", null); setKid(pad, "rect_delta", null);
      setKid(pad, "options", [["clearance", "outline"], ["anchor", "circle"]], after("chamfer").concat(["net", "pinfunction", "pintype", "die_length", "die_delay"]));
      prims = ["primitives", shapeToPrimitive(poly, pad)];
      const o = K.kid(pad, "options")!; pad.splice(pad.indexOf(o) + 1, 0, prims);
    }
    pad[3] = "custom";
  }
  if (!prims) { prims = ["primitives"]; const o = K.kid(pad, "options"); pad.splice(o ? pad.indexOf(o) + 1 : pad.length, 0, prims); }
  for (const s of merged) prims.push(shapeToPrimitive(s.node, pad));
  const changes: PcbChange[] = [replacedChange(it, pad)];
  for (const s of merged) changes.push(removedChange(s));
  return { changes, merged: merged.map((m) => m.id) };
}
function shapesTouch(a: SNode, b: SNode): boolean {
  const pa = shapePoints(a), pb = shapePoints(b); if (!pa.length || !pb.length) return false;
  const wa = num((K.kid(K.kid(a, "stroke") || [], "width") || [])[1]), wb = num((K.kid(K.kid(b, "stroke") || [], "width") || [])[1]);
  const ca = ["gr_poly", "gr_rect", "gr_circle"].includes(str(a[0])), cb = ["gr_poly", "gr_rect", "gr_circle"].includes(str(b[0]));
  if (ca && pb.some((q) => pointInPoly(q, pa))) return true;
  if (cb && pa.some((q) => pointInPoly(q, pb))) return true;
  const segs = (p: Pt[], closed: boolean) => { const s: [Pt, Pt][] = []; for (let i = 0; i + 1 < p.length; i++) s.push([p[i], p[i + 1]]); if (closed && p.length > 2) s.push([p[p.length - 1], p[0]]); return s; };
  const tol = (wa + wb) / 2 + 1e-9;
  for (const [a1, a2] of segs(pa, ca)) for (const [b1, b2] of segs(pb, cb)) if (crosses(a1, a2, b1, b2) || segDist(a1, b1, b2) <= tol || segDist(a2, b1, b2) <= tol || segDist(b1, a1, a2) <= tol || segDist(b2, a1, a2) <= tol) return true;
  return false;
}

// ---------------------------------------------------------------- Pad Table
export const PAD_TYPES: [string, string][] = [["thru_hole", "Through-hole"], ["smd", "SMD"], ["connect", "Connector"], ["np_thru_hole", "NPTH"], ["non_component", "Non-component"], ["aperture", "Aperture"]];
export const PAD_SHAPES: [string, string][] = [["circle", "Circle"], ["oval", "Oval"], ["rect", "Rectangle"], ["trapezoid", "Trapezoid"], ["roundrect", "Rounded rectangle"], ["chamfered", "Chamfered rectangle"], ["custom", "Custom shape"]];
/** The CSV header labels (GetPadTableColLabel, untranslated). */
export const PAD_TABLE_COLS: [keyof PadRow, string][] = [["number", "Number"], ["type", "Type"], ["shape", "Shape"], ["x", "Pos X"], ["y", "Pos Y"], ["w", "Size X"], ["h", "Size Y"], ["dx", "Drill X"], ["dy", "Drill Y"], ["dieLen", "Pad to die length"], ["dieDelay", "Pad to die delay"]];
export interface PadRow { id: string; number: string; type: string; shape: string; x: number; y: number; w: number; h: number; dx: number; dy: number; dieLen: number; dieDelay: number; complex?: boolean }
export const drillsEditable = (type: string) => type === "thru_hole" || type === "np_thru_hole";
export function padTypeKey(n: SNode): string { return isAperture(n) ? "aperture" : str(n[2]); }
export function padShapeKey(n: SNode): string { const s = str(n[3]); return s === "roundrect" && K.kid(n, "chamfer") ? "chamfered" : s; }
export function padRow(it: KItem): PadRow {
  const n = it.node; const [x, y] = atOf(n); const s = K.kid(n, "size"); const d = K.kid(n, "drill");
  const dv = d ? d.slice(1).filter((v: SAtom) => typeof v === "number") as number[] : [];
  const dl = K.kid(n, "die_length"), dd = K.kid(n, "die_delay");
  return { id: it.id, number: str(n[1]), type: padTypeKey(n), shape: padShapeKey(n), x, y, w: num(s && s[1]), h: num(s && s[2]), dx: dv.length ? dv[0] : NaN, dy: dv.length ? (dv[1] ?? dv[0]) : NaN,
    dieLen: dl ? num(dl[1]) : NaN, dieDelay: dd ? num(dd[1]) : NaN, complex: !!K.kid(n, "padstack") };
}
/** The rows of the table: the footprint's pads in pad order (StrNumCmp of the numbers, as FOOTPRINT::Pads after sorting). */
export function padTableRows(doc: BoardDoc, cmp: (a: string, b: string) => number): PadRow[] {
  return padItems(doc).map(padRow).sort((a, b) => cmp(a.number, b.number));
}
const SMD_MASK = ["F.Cu", "F.Mask", "F.Paste"];
const isBackOnly = (ls: string[]) => ls.some((l) => /^B\./.test(l)) && !ls.some((l) => /^F\./.test(l) || /^\*\./.test(l));
const flipSide = (ls: string[]) => ls.map((l) => l.replace(/^F\./, "B."));
/** SetPadTypeFromString and the column setters, on a copy of the pad node. */
export function applyPadRow(node: SNode, r: PadRow): SNode {
  const n = clone(node); const cur = padRow({ id: "", kind: "pad", node } as KItem);
  if (r.number !== cur.number) n[1] = r.number;
  if (r.type !== cur.type) {
    const ls = layersOf(n);
    if (r.type === "thru_hole") n[2] = "thru_hole";
    else if (r.type === "smd") { if (str(n[2]) !== "smd" || isAperture(n)) setLayers(n, isBackOnly(ls) ? flipSide(SMD_MASK) : SMD_MASK); n[2] = "smd"; }
    else if (r.type === "connect") n[2] = "connect";
    else if (r.type === "non_component") { if (str(n[2]) !== "non_component") { const cu = ls.filter((l) => /\.Cu$/.test(l)); setLayers(n, [cu.length ? (cu[0] === "*.Cu" ? "F.Cu" : cu[0]) : "F.Cu"]); n[2] = "non_component"; } }
    else if (r.type === "np_thru_hole") n[2] = "np_thru_hole";
    else if (r.type === "aperture") { if (!isAperture(n)) { n[2] = "smd"; setLayers(n, isBackOnly(ls) ? ["B.Paste"] : ["F.Paste"]); } }
    if (!canHaveNumber(n)) n[1] = "";
  }
  if (r.shape !== cur.shape) {
    const s = r.shape === "chamfered" ? "roundrect" : r.shape;
    n[3] = s;
    setKid(n, "chamfer", null); setKid(n, "chamfer_ratio", null);
    if (s === "roundrect") { if (!K.kid(n, "roundrect_rratio")) setKid(n, "roundrect_rratio", [r.shape === "chamfered" ? 0 : 0.25], after("roundrect_rratio")); }
    else setKid(n, "roundrect_rratio", null);
    if (r.shape === "chamfered") setKid(n, "chamfer_ratio", [0.2], after("chamfer_ratio"));
    if (s !== "trapezoid") setKid(n, "rect_delta", null);
    if (s !== "custom") { setKid(n, "options", null); setKid(n, "primitives", null); }
  }
  if (r.x !== cur.x || r.y !== cur.y) { const a = K.kid(n, "at")!; a[1] = r6(r.x); a[2] = r6(r.y); }
  if (r.w !== cur.w || r.h !== cur.h) setKid(n, "size", [r6(r.w), r6(r.h)], after("size"));
  if (drillsEditable(str(n[2])) && ((r.dx !== cur.dx && !(isNaN(r.dx) && isNaN(cur.dx))) || (r.dy !== cur.dy && !(isNaN(r.dy) && isNaN(cur.dy))))) {
    const d = K.kid(n, "drill"); const off = d ? K.kid(d, "offset") : null; const oval = !!d && d.includes("oval");
    const dx = isFinite(r.dx) ? r6(r.dx) : 0, dy = isFinite(r.dy) ? r6(r.dy) : dx;
    const vals: SAtom[] = []; if (oval || (dy !== dx && dy > 0)) vals.push("oval"); if (dx > 0) vals.push(dx); if (dy > 0 && dy !== dx) vals.push(dy); if (off) vals.push(off);
    setKid(n, "drill", vals.length ? vals : null, after("drill"));
  }
  if (r.dieLen !== cur.dieLen && !(isNaN(r.dieLen) && isNaN(cur.dieLen))) setKid(n, "die_length", isFinite(r.dieLen) && r.dieLen !== 0 ? [r6(r.dieLen)] : null, after("die_length"));
  if (r.dieDelay !== cur.dieDelay && !(isNaN(r.dieDelay) && isNaN(cur.dieDelay))) setKid(n, "die_delay", isFinite(r.dieDelay) && r.dieDelay !== 0 ? [r6(r.dieDelay)] : null, after("die_delay"));
  return n;
}
/** OK: one "Edit Pads" step with every row that differs from its pad, the pads added by an import, the pads an import replaced. */
export function padTableChanges(doc: BoardDoc, rows: PadRow[], newPad: (r: PadRow) => SNode): PcbChange[] {
  const out: PcbChange[] = []; const keep = new Set<string>();
  for (const r of rows) {
    const it = r.id ? doc.items.get(r.id) : null;
    if (!it) { out.push(addedChange(doc, applyPadRow(newPad(r), r))); continue; }
    keep.add(it.id);
    const n = applyPadRow(it.node, r); if (K.serialize(n) !== K.serialize(it.node)) out.push(replacedChange(it, n));
  }
  for (const it of padItems(doc)) if (!keep.has(it.id) && !out.some((c) => c.id === it.id)) out.push(removedChange(it));
  return out;
}
/** PIN_NUMBERS summary: the numbers in order with runs collapsed ("1-8, A1"), and the duplicates. */
export function padNumberSummary(numbers: string[], cmp: (a: string, b: string) => number): { summary: string; duplicates: string } {
  const sorted = numbers.filter(Boolean).slice().sort(cmp);
  const seen = new Set<string>(), dup: string[] = [];
  for (const n of sorted) { if (seen.has(n) && !dup.includes(n)) dup.push(n); seen.add(n); }
  const uniq = Array.from(seen); const parts: string[] = [];
  for (let i = 0; i < uniq.length;) {
    let j = i; const m = /^(.*?)(\d+)$/.exec(uniq[i]);
    if (m) while (j + 1 < uniq.length) { const m2 = /^(.*?)(\d+)$/.exec(uniq[j + 1]); if (!m2 || m2[1] !== m[1] || Number(m2[2]) !== Number(m[2]) + (j + 1 - i)) break; j++; }
    parts.push(j > i ? `${uniq[i]}-${uniq[j]}` : uniq[i]); i = j + 1;
  }
  return { summary: parts.join(", "), duplicates: dup.join(", ") };
}
/** CSV (RFC 4180 quoting) of a table of strings. */
export function toCsv(table: string[][]): string { return table.map((r) => r.map((c) => /[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(",")).join("\n") + "\n"; }
/** A CSV / TSV text as rows (the delimiter guessed from the first line, as ReadTableFromFileOrClipboard's AutoDecodeCSV). */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] || ""; const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}
/** GetColTypeForString: a header label (the CSV label, the grid label, case-insensitive) to its column. */
export function colForLabel(label: string): keyof PadRow | null {
  const l = label.trim().toLowerCase();
  const alias: Record<string, keyof PadRow> = { "x position": "x", "y position": "y", "pad->die length": "dieLen", "pad->die delay": "dieDelay" };
  if (alias[l]) return alias[l];
  const c = PAD_TABLE_COLS.find(([, lab]) => lab.toLowerCase() === l); return c ? c[0] : null;
}

// ---------------------------------------------------------------- Renumber Pads (interactive)
export interface EnumState { prefix: string; next: number; step: number; stored: number[]; old: Map<string, { val: number; was: string }>; picked: Set<string>; numbers: Map<string, string> }
export function enumBegin(prefix: string, start: number, step: number): EnumState { return { prefix, next: start, step, stored: [], old: new Map(), picked: new Set(), numbers: new Map() }; }
export const enumLabel = (st: EnumState, v: number) => `${st.prefix}${v}`;
/** The value the next pad takes (storedPadNumbers first). */
export const enumNextValue = (st: EnumState) => (st.stored.length ? st.stored[0] : st.next);
/** The popup text: "Click on pad %s\nPress <esc> to cancel all; double-click to finish". */
export const enumPopup = (st: EnumState) => `Click on pad ${enumLabel(st, enumNextValue(st))}\nPress <esc> to cancel all; double-click to finish`;
/** The pads under a point (pad numbers only on pads that can have one). */
export function padsAt(doc: BoardDoc, p: Pt): KItem[] { return padItems(doc).filter((it) => canHaveNumber(it.node) && pointInPoly(p, padOutline(it.node))); }
/**
 * One click (or one step of a drag) of EnumeratePads: a pad not yet picked takes the next number (a stored one
 * first); a click on a picked pad gives its old number back and stores its value for the next pad.
 */
export function enumPick(st: EnumState, doc: BoardDoc, pads: KItem[], isClick: boolean): boolean {
  let any = false;
  for (const it of pads) {
    if (!st.picked.has(it.id)) {
      const val = st.stored.length ? st.stored.shift()! : (st.next += st.step, st.next - st.step);
      const label = enumLabel(st, val);
      st.old.set(it.id, { val, was: st.numbers.has(it.id) ? st.numbers.get(it.id)! : str(it.node[1]) });
      st.numbers.set(it.id, label); st.picked.add(it.id); any = true;
    } else if (isClick) {
      const o = st.old.get(it.id); if (o) { st.stored.push(o.val); st.numbers.set(it.id, o.was); st.old.delete(it.id); }
      st.picked.delete(it.id); any = true;
    }
  }
  return any;
}
/** The pads along the mouse path (every 0.1 mm from the last position), as KiCad samples a fast drag. */
export function padsAlong(doc: BoardDoc, from: Pt, to: Pt): KItem[] {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]); const n = Math.floor(d / 0.1) + 1; const out: KItem[] = [];
  for (let j = 0; j < n; j++) { const p: Pt = [to[0] - j * (to[0] - from[0]) / n, to[1] - j * (to[1] - from[1]) / n]; for (const it of padsAt(doc, p)) if (!out.includes(it)) out.push(it); }
  return out;
}
/** The "Renumber Pads" changes: every pad whose number the session changed. */
export function enumChanges(doc: BoardDoc, st: EnumState): PcbChange[] {
  const out: PcbChange[] = [];
  for (const [id, label] of st.numbers) { const it = doc.items.get(id); if (!it || str(it.node[1]) === label) continue; const n = clone(it.node); n[1] = label; out.push(replacedChange(it, n)); }
  return out;
}

export const fpPadsApi = { pushPadChanges, importPadSettings, explodePadChanges, recombinePadChanges, principalLayer, padOutline, shapeTouchesPad, padTableRows, padRow, applyPadRow, padTableChanges, padNumberSummary,
  toCsv, parseCsv, colForLabel, PAD_TYPES, PAD_SHAPES, PAD_TABLE_COLS, drillsEditable, enumBegin, enumPick, enumChanges, enumPopup, enumNextValue, padsAt, padsAlong, setKid };
