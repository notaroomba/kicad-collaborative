// pcb-tools/convert.ts — pads under a point, CONVERT_TOOL's conversions and small item edits, board statistics.
import type { BoardDoc, NetRef, PadInfo, PcbChange, Pt, SAtom } from "./types";
import { addedChange, removedChange } from "./changes";
import { arcLength, arcPoints } from "./distances";
import { RULE_AREA_LAYERS } from "./draw-modes";
import { boardOutline, chainLoops } from "./drc";
import { bboxOfPts } from "./msgpanel";
import { netNode } from "./nets";
import { lineNode, polyNode, ruleAreaNode, segmentNode, zoneNode } from "./nodes";
import { netUnder, padCovers, padOnLayer, padsOf } from "./route-geom";
import { K } from "./state";
import { transformChanges } from "./transforms";
import * as VM from "../../canvas/variant-model";
import { corners, isList, layerOf, pt, r6 } from "./util";

// ---------------------------------------------------------------- pads
/** The pad under (x, y): { item, index, pad } from padsOf, the smallest pad covering the point on any copper layer. */
export function padAt(doc: BoardDoc, x: number, y: number, layer: string | null) {
  let best: { item: KItem; index: number; pad: PadInfo } | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint" || !it.bbox || x < it.bbox[0] || x > it.bbox[2] || y < it.bbox[1] || y > it.bbox[3]) continue;
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y) && (!best || p.w * p.h < best.pad.w * best.pad.h)) best = { item: it, index: p.index, pad: p };
  }
  return best;
}

// ---------------------------------------------------------------- conversions (CONVERT_TOOL) and small edits
export const closedShapeLoop = (it: KItem) => {
  const n = it.node;
  if (it.kind === "gr_rect") { const [x0, y0, x1, y1] = corners(pt(n, "start")!, pt(n, "end")!); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (it.kind === "gr_poly") return K.ptsOf(n);
  if (it.kind === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); const r = Math.hypot(e![0] - c![0], e![1] - c![1]); const pts: Pt[] = []; for (let i = 0; i < 32; i++) pts.push([c![0] + r * Math.cos(i * Math.PI / 16), c![1] + r * Math.sin(i * Math.PI / 16)]); return pts; }
  return null;
};
/** Lines and arcs of the selection chained into closed loops (world points), plus any closed shapes. */
export function selectionLoops(items: Iterable<KItem>) {
  const chains: Pt[][] = [], loops: Pt[][] = [];
  for (const it of items) {
    const n = it.node;
    if (it.kind === "gr_line") { const a = pt(n, "start"), b = pt(n, "end"); if (a && b) chains.push([a, b]); }
    else if (it.kind === "gr_arc") { const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) chains.push(arcPoints(arc, a, b)); }
    else if (it.kind === "gr_curve") { const pts = K.bezierPts(K.ptsOf(n)); if (pts.length > 1) chains.push(pts); }
    else { const l = closedShapeLoop(it); if (l) loops.push(l); }
  }
  if (chains.length) loops.push(...chainLoops(chains).loops);
  return loops.map((l) => l.map(([x, y]) => [r6(x), r6(y)]));
}
export function convertChanges(doc: BoardDoc, ids: string[], to: string, extra?: { layer?: string; net?: NetRef | null; keep?: boolean } | null) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; const out: PcbChange[] = []; const layer = items.length ? layerOf(items[0].node, "F.SilkS") : "F.SilkS";
  if (to === "lines") {   // rectangles and polygons into their edges
    for (const it of items) { const loop = closedShapeLoop(it); if (!loop || it.kind === "gr_circle") continue; loop.forEach((p, i) => out.push(addedChange(doc, lineNode(p, loop[(i + 1) % loop.length], layerOf(it.node, layer))))); out.push(removedChange(it)); }
    return out;
  }
  if (to === "tracks") {   // graphic lines and arcs on copper become tracks with the line's width
    for (const it of items) {
      const n = it.node; const l = layerOf(n, layer); if (!/\.Cu$/.test(l) || (it.kind !== "gr_line" && it.kind !== "gr_arc")) continue;
      const w = K.kid(n, "stroke") ? K.num((K.kid(K.kid(n, "stroke")!, "width") || [0, 0.2])[1], 0.2) : 0.2; const a = pt(n, "start"); const net = netUnder(doc, a![0], a![1], l);
      if (it.kind === "gr_line") out.push(addedChange(doc, segmentNode(doc, a!, pt(n, "end")!, w, l, net), net));
      else out.push(addedChange(doc, ["arc", ["start", ...a!.map(r6)], ["mid", ...pt(n, "mid")!.map(r6)], ["end", ...pt(n, "end")!.map(r6)], ["width", r6(w)], ["layer", l], netNode(doc, net)], net));
      out.push(removedChange(it));
    }
    return out;
  }
  const loops = selectionLoops(items); if (!loops.length) return [];
  if (to === "poly") { for (const loop of loops) out.push(addedChange(doc, polyNode(loop, layer))); }
  else if (to === "zone") { const l = /\.Cu$/.test(layer) ? layer : (extra && extra.layer) || "F.Cu"; const net = (extra && extra.net) || { code: 0, name: "" }; for (const loop of loops) out.push(addedChange(doc, zoneNode(doc, loop, l, net), net)); }
  else if (to === "keepout") { for (const loop of loops) out.push(addedChange(doc, ruleAreaNode(loop, /\.Cu$/.test(layer) ? [layer] : RULE_AREA_LAYERS))); }
  else return [];
  if (!(extra && extra.keep)) for (const it of items) if (/^gr_(line|arc|rect|poly|circle|curve)$/.test(it.kind)) out.push(removedChange(it));
  return out;
}
export function justifyChanges(doc: BoardDoc, ids: Iterable<string>, how: string) {
  return transformChanges(doc, ids, (n, it: KItem) => {
    const t = it.kind === "dimension" ? K.kid(n, "gr_text") : (it.kind === "gr_text" || it.kind === "gr_text_box") ? n : null; if (!t) return false;
    let eff = K.kid(t, "effects"); if (!eff) { eff = ["effects"]; t.push(eff); } let j = K.kid(eff, "justify"); const rest = (j ? j.slice(1) : []).filter((x) => x !== "left" && x !== "right");
    const toks = (how === "center" ? [] as SAtom[] : [how] as SAtom[]).concat(rest);
    if (j) { if (toks.length) j.splice(1, j.length - 1, ...toks); else eff.splice(eff.indexOf(j), 1); } else if (toks.length) eff.push(["justify", ...toks]);
  });
}
export function zonePriorityChanges(doc: BoardDoc, ids: Iterable<string>, how: string) {
  const zones = Array.from(doc.items.values()).filter((it) => it.kind === "zone" && !K.kid(it.node, "keepout")); const prio = (it: KItem) => { const p = K.kid(it.node, "priority"); return p ? K.num(p[1]) : 0; };
  const top = zones.reduce((m, z) => Math.max(m, prio(z)), 0);
  return transformChanges(doc, ids, (n, it: KItem) => {
    if (it.kind !== "zone" || K.kid(n, "keepout")) return false; const cur = prio(it);
    const want = how === "raise" ? cur + 1 : how === "lower" ? Math.max(0, cur - 1) : how === "top" ? top + 1 : 0; if (want === cur) return false;
    const p = K.kid(n, "priority"); if (want) { if (p) p[1] = want; else n.splice(n.indexOf((K.kid(n, "connect_pads") || K.kid(n, "min_thickness"))!), 0, ["priority", want]); } else if (p) n.splice(n.indexOf(p), 1);
  });
}
/** EDIT_TOOL::ToggleFootprintAttribute: the flag goes on for every selected footprint when any of them lacks it (as
 *  the current variant shows it), else off for all.  With a current variant (the toolbar's) the footprint's
 *  (variant …) takes the flag (created from the footprint's own flags, FOOTPRINT::AddVariant), not its (attr …). */
export function footprintAttrChanges(doc: BoardDoc, ids: Iterable<string>, flag: string, variant?: string) {
  const list = [...ids];
  const v = variant !== undefined ? variant : String(((globalThis as unknown as { CollabEditor?: { currentVariant?: string } }).CollabEditor || {}).currentVariant || "");
  const key = flag as keyof VM.FpFlags;
  let on = false;
  for (const id of list) { const it = doc.items.get(id); if (it && it.kind === "footprint" && !VM.footprintFlagsForVariant(it.node, v)[key]) { on = true; break; } }
  return transformChanges(doc, list, (n, it: KItem) => {
    if (it.kind !== "footprint") return false;
    if (v && !VM.isDefaultVariant(v)) { const out = VM.setFootprintVariant(n, v, { flags: { [key]: on } }); n.splice(0, n.length, ...out); return; }
    let a = K.kid(n, "attr"); const toks = a ? a.slice(1).map(K.str) : []; const i = toks.indexOf(flag);
    if (on === (i >= 0)) return;
    if (i >= 0) toks.splice(i, 1); else toks.push(flag);
    // the writer's token order (pcb_io_kicad_sexpr.cpp format footprint (attr …))
    const ORDER = ["smd", "through_hole", "board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges"];
    toks.sort((x, y) => { const a1 = ORDER.indexOf(x), b1 = ORDER.indexOf(y); return (a1 < 0 ? 99 : a1) - (b1 < 0 ? 99 : b1); });
    if (!toks.length) { n.splice(n.indexOf(a!), 1); return; } if (a) a.splice(1, a.length - 1, ...toks); else { const before = n.find((c) => isList(c) && /^(fp_|pad|model|embedded_fonts)/.test(c[0] as string)); n.splice(before ? n.indexOf(before) : n.length, 0, ["attr", ...toks]); }
  });
}
/** Board statistics (DIALOG_BOARD_STATISTICS): footprint, pad, via and track counts, board size and outline area. */
export function boardStatistics(doc: BoardDoc) {
  const st = { footprints: { total: 0, front: 0, back: 0, smd: 0, tht: 0, other: 0 }, pads: { total: 0, smd: 0, tht: 0, npth: 0, connect: 0 }, vias: { total: 0, through: 0, blind: 0, micro: 0 }, tracks: { count: 0, length: 0 }, zones: 0, drills: 0, width: 0, height: 0, area: 0 };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { st.footprints.total++; if (it.layer === "B.Cu") st.footprints.back++; else st.footprints.front++; const a = K.kid(it.node, "attr"); const toks = a ? a.slice(1).map(K.str) : []; if (toks.includes("smd")) st.footprints.smd++; else if (toks.includes("through_hole")) st.footprints.tht++; else st.footprints.other++;
      for (const p of K.kids(it.node, "pad")) { st.pads.total++; const t = K.str(p[2]); if (t === "smd") st.pads.smd++; else if (t === "thru_hole") { st.pads.tht++; st.drills++; } else if (t === "np_thru_hole") { st.pads.npth++; st.drills++; } else st.pads.connect++; } }
    else if (it.kind === "via") { st.vias.total++; st.drills++; if (it.node.includes("micro")) st.vias.micro++; else if (it.node.includes("blind")) st.vias.blind++; else st.vias.through++; }
    else if (it.kind === "segment") { const a = pt(it.node, "start"), b = pt(it.node, "end"); st.tracks.count++; if (a && b) st.tracks.length += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    else if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); st.tracks.count++; if (arc) st.tracks.length += arcLength(arc); }
    else if (it.kind === "zone" && !K.kid(it.node, "keepout")) st.zones++;
  }
  st.tracks.length = r6(st.tracks.length);
  const ol = boardOutline(doc); const b = ol.outline ? bboxOfPts(ol.outline) : doc.bbox;
  if (b) { st.width = r6(b[2] - b[0]); st.height = r6(b[3] - b[1]); } st.area = r6(ol.outline ? ol.area : (b ? (b[2] - b[0]) * (b[3] - b[1]) : 0));
  return st;
}
