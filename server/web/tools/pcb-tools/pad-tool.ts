// pcb-tools/pad-tool.ts — the Footprint Editor's PAD_TOOL (pcbnew/tools/pad_tool.cpp) and the anchor tool:
//
//   Add Pad / Add Through-hole Pad / Add SMD Pad / Add NPTH / Add Solder Paste Aperture   PAD_TOOL::PlacePad with
//       PAD_MASTER_PROVIDER: the selected pad (Add Pad only), else the last pad placed of that type, else the
//       highest-numbered pad of that type, else KiCad's default pad; numbered by FOOTPRINT::GetNextPadNumber
//   Place the Footprint Anchor                                                           FOOTPRINT::MoveAnchorPosition
//   Enumerate Pads (the numbering pass of PAD_TOOL::EnumeratePads)
//
// The footprint is the document (canvas/footprint-doc.ts): pads are items of kind "pad" at the origin's frame.
import type { BoardDoc, PcbChange, PcbCtx, Pt } from "./types";
import { K, S } from "./state";
import { addedChange, replacedChange } from "./changes";
import { translateNode } from "./transforms";
import { clone, isList, r6 } from "./util";

export type PadType = "auto" | "tht" | "smd" | "npth" | "paste" | "mask" | "conn" | "nc";
/** The tool ids the module registers for each PlacePad action. */
export const PAD_TOOLS: Record<string, PadType> = { pad: "auto", padtht: "tht", padsmd: "smd", padnpth: "npth", padpaste: "paste" };

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** UTIL::GetRefDesPrefix: the text before the trailing digits. */
export function refDesPrefix(s: string): string { return s.replace(/\d+$/, ""); }
/** GetTrailingInt: the trailing number (0 without one). */
export function trailingInt(s: string): number { const m = /(\d+)$/.exec(s); return m ? parseInt(m[1], 10) : 0; }

/** The pads of the footprint being edited. */
export function fpPads(doc: BoardDoc): SNode[] { const out: SNode[] = []; for (const it of doc.items.values()) if (it.kind === "pad") out.push(it.node); return out; }

/** FOOTPRINT::GetNextPadNumber: prefix of the last number + its trailing integer, counting up past every number in use. */
export function nextPadNumber(doc: BoardDoc, last: string, extraUsed?: Iterable<string>): string {
  const used = new Set<string>(fpPads(doc).map((p) => str(p[1])));
  if (extraUsed) for (const u of extraUsed) used.add(u);
  const prefix = refDesPrefix(last); let num = trailingInt(last);
  while (used.has(prefix + num)) num++;
  return prefix + num;
}

const layerSet = (pad: SNode): string[] => (K.kid(pad, "layers") || []).slice(1).map(str);
/** PAD::IsAperturePad: an SMD pad on no copper layer. */
const isAperture = (pad: SNode) => str(pad[2]) === "smd" && !layerSet(pad).some((l) => /\.Cu$/.test(l));
/** PAD_MASTER_PROVIDER::TypeFromPad. */
export function typeFromPad(pad: SNode): PadType | null {
  const a = str(pad[2]);
  if (a === "thru_hole") return "tht";
  if (a === "smd") {
    if (isAperture(pad)) { const ls = layerSet(pad); if (ls.some((l) => /\.Paste$/.test(l))) return "paste"; if (ls.some((l) => /\.Mask$/.test(l))) return "mask"; return null; }
    return "smd";
  }
  if (a === "connect") return "conn";
  if (a === "np_thru_hole") return "npth";
  return null;
}

/** StrNumCmp: text compared with digit runs as numbers. */
export function strNumCmp(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) || [], rb = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i]; const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else { const c = x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0; if (c) return c; }
  }
  return ra.length - rb.length;
}

/** PAD_UTILS::GetDefaultIpcRoundingRatio: radius min(0.25 mm, 25 % of the smaller side), as a ratio. */
export function ipcRoundingRatio(w: number, h: number): number { const m = Math.min(w, h); return m > 0 ? r6(Math.min(0.25, m * 0.25) / m) : 0.25; }

/** PAD_MASTER_PROVIDER::MakeDefaultPad, as the file writes it. */
export function defaultPad(type: PadType): SNode {
  switch (type) {
  case "smd": return ["pad", "", "smd", "roundrect", ["at", 0, 0], ["size", 2, 1], ["layers", "F.Cu", "F.Mask", "F.Paste"], ["roundrect_rratio", ipcRoundingRatio(2, 1)]];
  case "npth": return ["pad", "", "np_thru_hole", "circle", ["at", 0, 0], ["size", 1, 1], ["drill", 1], ["layers", "*.Cu", "*.Mask"]];
  case "paste": return ["pad", "", "smd", "roundrect", ["at", 0, 0], ["size", 1, 1], ["layers", "F.Paste"], ["roundrect_rratio", ipcRoundingRatio(1, 1)]];
  case "mask": return ["pad", "", "smd", "roundrect", ["at", 0, 0], ["size", 1, 1], ["layers", "F.Mask"], ["roundrect_rratio", ipcRoundingRatio(1, 1)]];
  case "conn": return ["pad", "", "connect", "rect", ["at", 0, 0], ["size", 2.54, 1.27], ["layers", "F.Cu", "F.Mask"]];
  case "nc": return ["pad", "", "smd", "roundrect", ["at", 0, 0], ["size", 2, 1], ["layers", "F.Cu"], ["roundrect_rratio", ipcRoundingRatio(2, 1)]];
  default: return ["pad", "", "thru_hole", "oval", ["at", 0, 0], ["size", 2.54, 1.27], ["drill", 0.8], ["layers", "*.Cu", "*.Mask"]];
  }
}

/** The provider's memory: the last pad type placed and the last pad placed of each type (by uuid). */
export const padMemory: { lastType: PadType; lastByType: Partial<Record<PadType, string>>; lastNumber: string } = { lastType: "auto", lastByType: {}, lastNumber: "1" };

/** PAD_MASTER_PROVIDER::GetMasterPad: the template for a new pad of `type` (a copy, without uuid / net). */
export function masterPad(doc: BoardDoc, type: PadType, selected: SNode | null): SNode {
  const pads = fpPads(doc).slice().sort((a, b) => strNumCmp(str(b[1]), str(a[1])));   // reverse number order: avoid pin 1
  let t = type;
  if (t === "auto") {
    // resolveAutoType: the selected pad, the last type placed, the first classified pad, THT
    const sel = selected ? typeFromPad(selected) : null;
    t = sel || (padMemory.lastType !== "auto" ? padMemory.lastType : null) || pads.map(typeFromPad).find((x): x is PadType => !!x) || "tht";
    if (selected && sel === t) return strip(clone(selected));
  }
  const lastId = padMemory.lastByType[t];
  if (lastId) { const it = doc.items.get(lastId); if (it && it.kind === "pad" && typeFromPad(it.node) === t) return strip(clone(it.node)); }
  const same = pads.find((p) => typeFromPad(p) === t); if (same) return strip(clone(same));
  return defaultPad(t);
}
function strip(n: SNode): SNode {
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (isList(c) && (c[0] === "uuid" || c[0] === "tstamp" || c[0] === "net" || c[0] === "pinfunction" || c[0] === "pintype")) n.splice(i, 1); }
  return n;
}

/** PAD::CanHaveNumber: an NPTH or an aperture pad carries no number. */
export const canHaveNumber = (pad: SNode) => str(pad[2]) !== "np_thru_hole" && !isAperture(pad);

/** The pad the placer would put down at (x, y): PAD_PLACER::CreateItem, numbered, rotated by `angle`. */
export function newPadNode(doc: BoardDoc, type: PadType, selected: SNode | null, at: Pt, angle: number, number: string | null): SNode {
  const p = masterPad(doc, type, selected);
  p[1] = canHaveNumber(p) ? (number || "") : "";
  const a = K.kid(p, "at")!; a.length = 1; a.push(r6(at[0]), r6(at[1])); const ang = r6(((angle % 360) + 360) % 360); if (ang) a.push(ang > 180 ? ang - 360 : ang);
  return p;
}

/**
 * PAD_PLACER::PlaceItem: commit the pad (one undo step), record it as the master of its type and move the number on.
 * `state` carries neednewPadNumber across placements, as the static of PlacePad does.
 */
export function placePad(ctx: PcbCtx, type: PadType, at: Pt, angle: number): PcbChange | null {
  const doc = ctx.doc; if (!doc) return null;
  const selected = S.padTemplate || null;
  const probe = masterPad(doc, type, selected);
  let number = "";
  // neednewPadNumber: a number is only used up by a pad that was placed, so the next one starts from it
  if (canHaveNumber(probe)) { number = nextPadNumber(doc, padMemory.lastNumber); padMemory.lastNumber = number; }
  const node = newPadNode(doc, type, selected, at, angle, number);
  const ch = addedChange(doc, node);
  const t = typeFromPad(node); if (t) { padMemory.lastType = t; padMemory.lastByType[t] = ch.id; }
  ctx.commit([ch], "Place pad");
  return ch;
}

/** FOOTPRINT::MoveAnchorPosition: every child moves by -(x, y), so (x, y) becomes the origin. */
export function moveAnchorChanges(doc: BoardDoc, at: Pt): PcbChange[] {
  const [dx, dy] = [-at[0], -at[1]]; if (!dx && !dy) return [];
  const out: PcbChange[] = [];
  for (const it of doc.items.values()) {
    const n = clone(it.node);
    if (it.kind === "zone") { for (const poly of K.kids(n, "polygon").concat(K.kids(n, "filled_polygon"))) { const p = K.kid(poly, "pts"); if (p) for (const xy of p.slice(1)) if (isList(xy) && xy[0] === "xy") { xy[1] = r6(K.num(xy[1]) + dx); xy[2] = r6(K.num(xy[2]) + dy); } } }
    else translateNode(n, dx, dy);
    out.push(replacedChange(it, n));
  }
  return out;
}

/**
 * PAD_TOOL::EnumeratePads, the numbering: pads in the order clicked get prefix + start, start + step, …  A pad whose
 * number changes to one another pad already has swaps with it (KiCad keeps the numbers unique the same way).
 */
export function enumerateChanges(doc: BoardDoc, ids: string[], prefix: string, start: number, step: number): PcbChange[] {
  const out: PcbChange[] = [];
  ids.forEach((id, i) => { const it = doc.items.get(id); if (!it || it.kind !== "pad" || !canHaveNumber(it.node)) return; const n = clone(it.node); n[1] = prefix + (start + i * step); out.push(replacedChange(it, n)); });
  return out;
}

export const padToolApi = { nextPadNumber, masterPad, defaultPad, typeFromPad, newPadNode, placePad, moveAnchorChanges, enumerateChanges, padMemory, strNumCmp, ipcRoundingRatio, refDesPrefix, trailingInt, canHaveNumber };
