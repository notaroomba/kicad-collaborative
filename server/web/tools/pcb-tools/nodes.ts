// pcb-tools/nodes.ts — node builders (KiCad board file shapes).
import type { BoardDoc, NetRef, Pt } from "./types";
import { netNode } from "./nets";
import { K } from "./state";
import { LINE_W, corners, isBack, layerClass, r6, textStyle, xy } from "./util";

// ---------------------------------------------------------------- node builders (KiCad board file shapes)
export function segmentNode(doc: BoardDoc, a: Pt, b: Pt, width: number, layer: string, net: NetRef | null): SNode {
  return ["segment", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], ["width", r6(width)], ["layer", layer], netNode(doc, net)];
}
export function viaNode(doc: BoardDoc, x: number, y: number, size: number, drill: number, net: NetRef | null, layers?: string[] | null): SNode {
  return ["via", ["at", r6(x), r6(y)], ["size", r6(size)], ["drill", r6(drill)], ["layers"].concat(layers || ["F.Cu", "B.Cu"]), netNode(doc, net)];
}
export const gfxWidth = (layer: string) => LINE_W[layerClass(layer)];
export const strokeNode = (w: number): SNode => ["stroke", ["width", r6(w)], ["type", "default"]];
export function lineNode(a: Pt, b: Pt, layer: string): SNode { return ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
export function rectNode(a: Pt, b: Pt, layer: string): SNode { return ["gr_rect", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
export function circleNode(c: Pt, e: Pt, layer: string): SNode { return ["gr_circle", ["center", r6(c[0]), r6(c[1])], ["end", r6(e[0]), r6(e[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
// PCB_IO_KICAD_SEXPR::format(PCB_SHAPE): start/mid/end, stroke, (fill only for closed shapes), layer, then the uuid
// EDA_SHAPE::SetArcGeometry keeps one winding: from start to end the polar angle grows (clockwise on the board), so an
// arc given the other way round is stored with its ends swapped, as pcbnew writes it.
export function arcNode(a: Pt, m: Pt, b: Pt, layer: string): SNode { if ((m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) < 0) [a, b] = [b, a]; return ["gr_arc", ["start", r6(a[0]), r6(a[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
export function polyNode(pts: Pt[], layer: string): SNode { return ["gr_poly", ["pts", ...pts.map((p: Pt) => ["xy", r6(p[0]), r6(p[1])])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
// DRAWING_TOOL::PlaceText: the layer class's size and thickness, left / bottom justified, mirrored on the back;
// PCB_IO_KICAD_SEXPR::format(PCB_TEXT) writes the text, (at), (layer), (uuid) and then the effects.
export function textNode(text: string, x: number, y: number, layer: string): SNode {
  return ["gr_text", text, ["at", r6(x), r6(y), 0], ["layer", layer], ["uuid", K.newUuid()], effectsNode(layer, ["left", "bottom"])];
}
/** EDA_TEXT::Format for a new item on a layer: the class's size and thickness, a justification, mirrored on the back. */
export function effectsNode(layer: string, just?: string[]): SNode {
  const { size, thick } = textStyle(layer); const eff: SNode = ["effects", ["font", ["size", size, size], ["thickness", thick]]];
  const j = (just || []).slice(); if (isBack(layer)) j.push("mirror"); if (j.length) eff.push(["justify", ...j]);
  return eff;
}
// SHAPE_T::BEZIER: (gr_curve (pts start c1 c2 end) …)
export function curveNode(pts: Pt[], layer: string): SNode { return ["gr_curve", ["pts", ...pts.map(xy)], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
// PCB_TEXTBOX as DRAWING_TOOL::DrawRectangle leaves it: the constructor's margins (half the default line width plus
// three quarters of the default 1.27 text size), the layer class's text, left/top, a border in the layer's line width.
// The uuid sits between the layer and the effects in the writer, so it is minted here.
export const TEXTBOX_MARGIN = 1.0025;
export function textBoxNode(text: string, a: Pt, b: Pt, layer: string): SNode {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["gr_text_box", text, ["start", r6(x0), r6(y0)], ["end", r6(x1), r6(y1)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN],
    ["layer", layer], ["uuid", K.newUuid()], effectsNode(layer, ["left", "top"]), ["border", "yes"], strokeNode(gfxWidth(layer)), ["knockout", "no"]];
}
// DRAWING_TOOL::DrawTable, on every motion: the table hangs from the first click; one column per 15 text widths and one
// row per 3 text heights of the drag (integer division in nm, so a drag up or left gives one), cells at least 5 × 3 text
// sizes, each rounded to the grid.
export function tableGrid(origin: Pt, cursor: Pt, layer: string, grid: number) {
  const { size } = textStyle(layer); const fs = Math.round(size * 1e6), g = Math.round((grid || 0) * 1e6);
  const rx = Math.round((cursor[0] - origin[0]) * 1e6), ry = Math.round((cursor[1] - origin[1]) * 1e6);
  const cols = Math.max(1, Math.trunc(rx / (fs * 15))), rows = Math.max(1, Math.trunc(ry / (fs * 3)));
  let cw = Math.max(fs * 5, Math.trunc(rx / cols)), ch = Math.max(fs * 3, Math.trunc(ry / rows));
  if (g > 0) { cw = Math.round(cw / g) * g; ch = Math.round(ch / g) * g; }
  return { x: origin[0], y: origin[1], cw: r6(cw / 1e6), ch: r6(ch / 1e6), rows, cols };
}
// PCB_TABLE with PCB_TABLECELLs as the drawing tool creates them, in PCB_IO_KICAD_SEXPR::format( PCB_TABLE ) order (uuid,
// layer, then formatTableData): borders and separators in the layer's line width, every cell empty with the text box
// constructor's margins and EDA_TEXT's own 1.27 size (auto thickness), left / middle, mirrored on a back layer.
export function tableNode(origin: Pt, cursor: Pt, layer: string, grid: number): SNode {
  const L = tableGrid(origin, cursor, layer, grid); const w = gfxWidth(layer); const cells: SNode = ["cells"];
  const just = ["justify", "left"]; if (isBack(layer)) just.push("mirror");
  for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
    const x = r6(L.x + c * L.cw), y = r6(L.y + r * L.ch);
    cells.push(["table_cell", "", ["start", x, y], ["end", r6(x + L.cw), r6(y + L.ch)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN], ["span", 1, 1],
      ["layer", layer], ["uuid", K.newUuid()], ["effects", ["font", ["size", 1.27, 1.27]], just.slice()], ["knockout", "no"]]);
  }
  return ["table", ["uuid", K.newUuid()], ["layer", layer], ["column_count", L.cols],
    ["border", ["external", "yes"], ["header", "yes"], strokeNode(w)], ["separators", ["rows", "yes"], ["cols", "yes"], strokeNode(w)],
    ["column_widths", ...Array(L.cols).fill(L.cw)], ["row_heights", ...Array(L.rows).fill(L.ch)], cells];
}
// PCB_REFERENCE_IMAGE: anchored at its centre, the file's own bytes as base64 in KICAD_FORMAT::FormatStreamData's
// 76-column rows.  (scale) is only written when it differs from 1, so a fresh image carries none.
export function imageNode(x: number, y: number, base64: string, layer: string): SNode {
  const data = ["data"]; for (let i = 0; i < base64.length; i += 76) data.push(base64.slice(i, i + 76));
  return ["image", ["at", r6(x), r6(y)], ["layer", layer], data];
}
// ZONE_SETTINGS defaults (zones.h): edge hatch 0.5, clearance 0.5, min thickness 0.25, thermal gap / spoke 0.5, islands
// always removed.  A new zone travels unfilled (no "yes" on fill) — every client refills for itself.
export const zoneFillNode = (): SNode => ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5], ["island_removal_mode", 0]];
export const zoneLayers = (node: SNode) => { const l = K.kid(node, "layer"); if (l) return [K.str(l[1])]; const ls = K.kid(node, "layers"); return ls ? ls.slice(1).map(K.str) : []; };
/** ZONE_CREATE_HELPER::setUniquePriority: the lowest priority no copper zone on the board uses yet. */
export function zonePriority(doc: BoardDoc) {
  const used = new Set<number>();
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || K.kid(it.node, "keepout") || K.kid(it.node, "attr") || !zoneLayers(it.node).some((l) => /\.Cu$/.test(l))) continue;
    const p = K.kid(it.node, "priority"); used.add(p ? K.num(p[1]) : 0);
  }
  let p = 0; while (used.has(p)) p++; return p;
}
// ---------------------------------------------------------------- zone fill mode (ZONE::SetFillMode) and THIEVING_SETTINGS
export type ZoneFillMode = "solid" | "hatch" | "thieving";
export interface ThievingSettings { type: "dots" | "squares" | "hatch"; size: number; gap: number; width: number; stagger: boolean; orientation: number }
/** ZONE_SETTINGS' thieving defaults (zone_settings.cpp:59-64): dots, 0.5 mm, 1.0 mm gap, max(min thickness, 0.3) lines, no stagger, 0°. */
export const thievingDefaults = (minThickness: number): ThievingSettings => ({ type: "dots", size: 0.5, gap: 1, width: Math.max(minThickness, 0.3), stagger: false, orientation: 0 });
export const zoneFillMode = (node: SNode): ZoneFillMode => { const f = K.kid(node, "fill"), m = f && K.kid(f, "mode"); const v = m ? K.str(m[1]) : ""; return v === "hatch" || v === "thieving" ? v : "solid"; };
/** The zone's thieving settings: the file's (thieving …) over the defaults. */
export function thievingOf(node: SNode): ThievingSettings {
  const mt = K.kid(node, "min_thickness"); const d = thievingDefaults(mt ? K.num(mt[1]) : 0.25);
  const f = K.kid(node, "fill"), t = f && K.kid(f, "thieving"); if (!t) return d;
  const n = (k: string, dv: number) => { const c = K.kid(t, k); return c ? K.num(c[1]) : dv; };
  const ty = K.kid(t, "type"), st = K.kid(t, "stagger"); const tv = ty ? K.str(ty[1]) : "dots";
  return { type: tv === "squares" || tv === "hatch" ? tv : "dots", size: n("size", d.size), gap: n("gap", d.gap), width: n("width", d.width), stagger: st ? K.str(st[1]) === "yes" : false, orientation: n("orientation", 0) };
}
/** PCB_IO_KICAD_SEXPR's (thieving (type ..) (size ..) (gap ..) (width ..) (stagger ..) (orientation ..)), always whole and in that order. */
export const thievingNode = (t: ThievingSettings): SNode => ["thieving", ["type", t.type], ["size", r6(t.size)], ["gap", r6(t.gap)], ["width", r6(t.width)], ["stagger", t.stagger ? "yes" : "no"], ["orientation", r6(t.orientation)]];
/** Write the zone's thieving settings (the fill's last child, as the writer puts it). */
export function setThieving(node: SNode, patch: Partial<ThievingSettings>) {
  const f = K.kid(node, "fill"); if (!f) return node;
  const t = Object.assign(thievingOf(node), patch); const old = K.kid(f, "thieving");
  if (old) f.splice(f.indexOf(old), 1, thievingNode(t)); else f.push(thievingNode(t));
  return node;
}
const HATCH_KEYS = ["hatch_thickness", "hatch_gap", "hatch_orientation", "hatch_smoothing_level", "hatch_smoothing_value", "hatch_border_algorithm", "hatch_min_hole_area"];
/**
 * ZONE::SetFillMode as the Properties panel's Fill Mode edits it, written as PCB_IO_KICAD_SEXPR writes the fill:
 * (mode …) after the fill flag, the hatch keys or the (thieving …) block at the end.  A thieving zone is net-less,
 * single-layer and connects no pads (ZONE_SETTINGS::ExportSetting forces ZONE_CONNECTION::NONE and net 0).
 */
export function setZoneFillMode(node: SNode, mode: ZoneFillMode) {
  let f = K.kid(node, "fill");
  if (!f) { f = ["fill"]; const poly = K.kid(node, "polygon"); node.splice(poly ? node.indexOf(poly) : node.length, 0, f); }
  const del = (k: string) => { const c = K.kid(f!, k); if (c) f!.splice(f!.indexOf(c), 1); };
  del("mode"); for (const k of HATCH_KEYS) del(k); del("thieving");
  if (mode !== "solid") f.splice(f[1] === "yes" ? 2 : 1, 0, ["mode", mode]);
  const mt = K.kid(node, "min_thickness"); const minT = mt ? K.num(mt[1]) : 0.25;
  if (mode === "hatch") {   // ZONE_SETTINGS: max(4 × min width, 1 mm) lines, max(6 × min width, 1.5 mm) gap
    f.push(["hatch_thickness", r6(Math.max(minT * 4, 1))], ["hatch_gap", r6(Math.max(minT * 6, 1.5))], ["hatch_orientation", 0], ["hatch_border_algorithm", "hatch_thickness"], ["hatch_min_hole_area", 0.3]);
  }
  if (mode === "thieving") {
    f.push(thievingNode(thievingDefaults(minT)));
    for (const k of ["net", "net_name"]) { const c = K.kid(node, k); if (c) node.splice(node.indexOf(c), 1); }
    const ls = K.kid(node, "layers"); if (ls && ls.length > 2) node.splice(node.indexOf(ls), 1, ["layer", K.str(ls[1])]);
    let cp = K.kid(node, "connect_pads"); if (!cp) { cp = ["connect_pads", ["clearance", 0.5]]; node.splice(node.indexOf(K.kid(node, "min_thickness") || f), 0, cp); }
    if (typeof cp[1] === "string") cp[1] = "no"; else cp.splice(1, 0, "no");
  }
  return node;
}
/** ZONE_CREATE_HELPER::createNewZone with m_thieving (zone_create_helper.cpp): fill mode COPPER_THIEVING, net 0, no pad connections. */
export function thievingZoneNode(doc: BoardDoc, pts: Pt[], layer: string): SNode {
  return setZoneFillMode(zoneNode(doc, pts, layer, null), "thieving");
}
export function zoneNode(doc: BoardDoc, pts: Pt[], layer: string, net: NetRef | null): SNode {
  const node: SNode = ["zone"]; const nn = netNode(doc, net); if (nn[1]) node.push(nn);   // (net …) only for a real net
  node.push(["layer", layer], ["uuid", K.newUuid()], ["hatch", "edge", 0.5]);
  const prio = zonePriority(doc); if (prio > 0) node.push(["priority", prio]);
  node.push(["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25], zoneFillNode(), ["polygon", ["pts", ...pts.map(xy)]]);
  return node;
}
// A rule area with ZONE_SETTINGS' default keepouts: tracks, vias and pads out; copper pours and footprints allowed.
export function ruleAreaNode(pts: Pt[], layers: string[]): SNode {
  return ["zone", layers.length > 1 ? ["layers", ...layers] : ["layer", layers[0]], ["uuid", K.newUuid()], ["hatch", "edge", 0.5],
    ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25],
    ["keepout", ["tracks", "not_allowed"], ["vias", "not_allowed"], ["pads", "not_allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
    ["placement", ["enabled", "no"], ["sheetname", ""]], zoneFillNode(), ["polygon", ["pts", ...pts.map(xy)]]];
}
