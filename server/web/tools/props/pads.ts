// props/pads.ts — pads: the footprint's pad table and DIALOG_PAD_PROPERTIES on the footprint node
// (children kept in pcb_io_kicad_sexpr's order).
import { netNameOf } from "./footprint";
import { atOf, delKid, isList, kid, kids, normDeg, num, r6, setKid, str } from "./sexpr";

/** One row of the Properties panel's pad table. */
export interface PadRow { number: string; type: string; shape: string; net: string; w: number; h: number; drill: string; layers: string[] }
export function padList(doc: KDoc | null | undefined, node: SNode): PadRow[] {
  return kids(node, "pad").map((p) => {
    const sz = kid(p, "size"); const w = sz ? num(sz[1]) : 0, h = sz ? num(sz[2], w) : 0;
    const dr = kid(p, "drill"); const drill = !dr ? "" : str(dr[1]) === "oval" ? num(dr[2]) + "×" + num(dr[3]) : str(dr[1]);
    return { number: str(p[1]), type: str(p[2]), shape: str(p[3]), net: netNameOf(doc, p), w, h, drill, layers: (kid(p, "layers") || []).slice(1).map(str) };
  });
}
export const PAD_TYPES = ["smd", "thru_hole", "np_thru_hole", "connect"], PAD_SHAPES = ["circle", "rect", "oval", "roundrect", "trapezoid", "custom"];
export const PAD_LAYER_PRESETS = ["F.Cu F.Paste F.Mask", "B.Cu B.Paste B.Mask", "*.Cu *.Mask", "F.Cu F.Mask", "B.Cu B.Mask", "*.Cu"];
// what follows each optional child in the writer, so a new one lands in its place
const PAD_AFTER_NET = ["pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "options", "primitives", "tenting", "uuid", "tstamp"];
export function padNode(node: SNode, index: number): SNode | null { return kids(node, "pad")[index] || null; }
/** The pad dialog's fields (padInfo). */
export interface PadInfo { number: string; type: string; shape: string; w: number; h: number; rot: number; drill: string; layers: string[]; net: string; maskMargin: number | null; pasteMargin: number | null; rratio: number | null }
/** The pad dialog's fields: number, type, shape, size, absolute angle, drill as text ("0.8", "0.8x1.2" or ""), layers, net name, margins, corner ratio. */
export function padInfo(doc: KDoc | null | undefined, pad: SNode): PadInfo {
  const sz = kid(pad, "size"); const w = sz ? num(sz[1]) : 0, h = sz ? num(sz[2], w) : 0; const dr = kid(pad, "drill");
  const drill = !dr ? "" : str(dr[1]) === "oval" ? num(dr[2]) + "x" + num(dr[3], num(dr[2])) : (typeof dr[1] === "number" ? String(dr[1]) : "");
  const mm = kid(pad, "solder_mask_margin"), pm = kid(pad, "solder_paste_margin"), rr = kid(pad, "roundrect_rratio"); const shape = str(pad[3]);
  return { number: str(pad[1]), type: str(pad[2]), shape, w, h, rot: atOf(pad)[2], drill, layers: (kid(pad, "layers") || []).slice(1).map(str), net: netNameOf(doc, pad),
    maskMargin: mm ? num(mm[1]) : null, pasteMargin: pm ? num(pm[1]) : null, rratio: rr ? num(rr[1]) : (shape === "roundrect" ? 0.25 : null) };
}
/** Whether the board numbers its nets — (net 3 "GND") on pads — or names them inline. */
export function numberedNets(doc: KDoc | null | undefined): boolean { if (!doc) return false; for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of kids(it.node, "pad")) { const n = kid(p, "net"); if (n) return typeof n[1] === "number"; } return false; }
/** A numbered board's code for a net name (from any pad carrying it), else 0. */
export function netCodeOf(doc: KDoc | null | undefined, name: string): number { if (!name || !doc) return 0; for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of kids(it.node, "pad")) { const n = kid(p, "net"); if (n && typeof n[1] === "number" && n.length > 2 && str(n[2]) === name) return n[1]; } return 0; }
/** Every net name the board's pads, tracks, vias and zones carry, sorted. */
export function boardNetNames(doc: KDoc): string[] { const s = new Set<string>(); for (const it of doc.items.values()) { if (it.kind === "footprint") { for (const p of kids(it.node, "pad")) { const n = netNameOf(doc, p); if (n) s.add(n); } } else if (kid(it.node, "net")) { const n = netNameOf(doc, it.node); if (n) s.add(n); } } return [...s].sort(); }
/** setPad's patch; every key is optional and only the given ones change. */
export interface PadPatch {
  number?: unknown; type?: string; shape?: string; w?: unknown; h?: unknown; rot?: unknown;
  drill?: string | number | number[]; layers?: unknown[]; net?: unknown;
  maskMargin?: number | string | null; pasteMargin?: number | string | null; rratio?: number | null;
}
/**
 * Edit pad `index` of a footprint node: patch = { number, type, shape, w, h, rot (absolute, degrees), drill ("" | n | [w, h] | "WxH"),
 * layers [names], net (name; "" clears), maskMargin / pasteMargin (null clears), rratio }.  Returns false when there is no such pad.
 */
export function setPad(node: SNode, index: number, patch: PadPatch, doc?: KDoc | null): boolean {
  const pad = padNode(node, index); if (!pad) return false;
  if (patch.number !== undefined) pad[1] = str(patch.number);
  if (patch.type && PAD_TYPES.includes(patch.type)) pad[2] = patch.type;
  if (patch.shape && PAD_SHAPES.includes(patch.shape)) pad[3] = patch.shape;
  if (patch.w !== undefined || patch.h !== undefined) {
    const sz = kid(pad, "size") || setKid(pad, "size", [1, 1], ["rect_delta", "drill", "property", "layers"]);
    const w = patch.w !== undefined ? num(patch.w, num(sz[1])) : num(sz[1]), h = patch.h !== undefined ? num(patch.h, num(sz[2], w)) : num(sz[2], num(sz[1]));
    sz.length = 1; sz.push(r6(Math.max(0, w)), r6(Math.max(0, h)));
  }
  if (patch.rot !== undefined) { const at = kid(pad, "at"); if (at) { const a = r6(normDeg(num(patch.rot))); if (at.length >= 4) { if (a) at[3] = a; else at.length = 3; } else if (a) at.push(a); } }
  if (patch.drill !== undefined) {
    let d = patch.drill; if (typeof d === "string") d = /x/i.test(d) ? d.split(/x/i).map((s) => num(s)) : d.trim() === "" ? 0 : num(d);
    const old = kid(pad, "drill"); const off = old && kid(old, "offset");
    const vals = isList(d) ? (d.length > 1 && Math.abs(d[1] - d[0]) > 1e-9 ? ["oval", r6(d[0]), r6(d[1])] : [r6(d[0])]) : (d > 0 ? [r6(d)] : []);
    if (!vals.length && !off) delKid(pad, "drill"); else { const n = setKid(pad, "drill", vals, ["backdrill", "property", "sim_electrical_type", "layers"]); if (off) n.push(off); }
  }
  if (patch.layers) { const ls = patch.layers.map(str).filter(Boolean); if (ls.length) setKid(pad, "layers", ls, ["remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net"].concat(PAD_AFTER_NET)); }
  if (patch.rratio !== undefined || patch.shape) {
    const shape = str(pad[3]); const before = ["chamfer_ratio", "chamfer", "net"].concat(PAD_AFTER_NET);
    if (shape === "roundrect") { if (patch.rratio !== undefined && patch.rratio !== null && !isNaN(patch.rratio)) setKid(pad, "roundrect_rratio", [r6(Math.max(0, Math.min(0.5, num(patch.rratio))))], before); else if (!kid(pad, "roundrect_rratio")) setKid(pad, "roundrect_rratio", [0.25], before); }
    else if (shape !== "custom") delKid(pad, "roundrect_rratio");
  }
  if (patch.net !== undefined) {
    const name = str(patch.net); const cur = kid(pad, "net"); const numbered = cur ? typeof cur[1] === "number" : numberedNets(doc);
    if (!name) delKid(pad, "net"); else setKid(pad, "net", numbered ? [netCodeOf(doc, name), name] : [name], PAD_AFTER_NET);
  }
  for (const [key, prop] of [["solder_mask_margin", "maskMargin"], ["solder_paste_margin", "pasteMargin"]] as const) {
    if (patch[prop] === undefined) continue; const v = patch[prop];
    if (v === null || v === "" || isNaN(v as number)) delKid(pad, key); else setKid(pad, key, [r6(num(v))], PAD_AFTER_NET.slice(PAD_AFTER_NET.indexOf(key) + 1));
  }
  return true;
}
