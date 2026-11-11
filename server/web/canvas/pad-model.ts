// canvas/pad-model — the pure half of Pad Properties (web/editor/pcbdialogs/pad-props.ts): one pad of a board
// footprint read into the dialog's model (DIALOG_PAD_PROPERTIES::initValues), CheckPad's messages, and the model
// written back into the pad node — only what changed, each child where PCB_IO_KICAD_SEXPR::format( PAD ) puts it,
// in the writer's number format.  Exposed as KiCadCanvas.padModel for the dialog and the node tests.
import { atOf, kid as kid0, kids, parse } from "./sexpr";

type SNode = unknown[];
interface KDocLike { copper: string[]; items: Map<string, { kind: string; node: SNode }> }
type KDoc = KDocLike;
const isList = Array.isArray;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (kid0(n, key) as SNode | null) : null);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : v === undefined || v === null || v === "" || isNaN(Number(v)) ? d : Number(v));
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/** formatInternalUnits / FormatDouble2Str: at most six decimals, no trailing zeros. */
export const f6 = (v: number): string => { const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; };
const norm180 = (a: number): number => { let r = a % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return Math.round(r * 1e6) / 1e6; };
const rot = (deg: number): ((x: number, y: number) => [number, number]) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; };

/** The children of (pad …) in the order the writer prints them. */
export const PAD_ORDER = ["at", "size", "rect_delta", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "property", "sim_electrical_type",
  "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length",
  "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap",
  "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
/** Replace (key …) in a pad with `text` parsed (null removes it), a new one where the writer puts it. */
export function setPadChild(pad: SNode, key: string, text: string | null): void {
  let i = -1; for (let j = 1; j < pad.length; j++) { const c = pad[j]; if (isList(c) && c[0] === key) { i = j; break; } }
  if (text === null) { if (i > 0) pad.splice(i, 1); return; }
  const n = parse(text) as SNode;
  if (i > 0) { pad[i] = n; return; }
  const rank = PAD_ORDER.indexOf(key); let at = pad.length;
  for (let j = 4; j < pad.length; j++) { const c = pad[j]; if (isList(c) && PAD_ORDER.indexOf(String(c[0])) > rank) { at = j; break; } }
  pad.splice(at, 0, n);
}

// ---------------------------------------------------------------- the dialog's model
export type DlgType = "pth" | "smd" | "conn" | "npth" | "aperture";
export type DlgShape = "circle" | "oval" | "rect" | "trapezoid" | "roundrect" | "chamfer" | "mixed" | "custom_circle" | "custom_rect";
export interface PadModel {
  type: DlgType; number: string; net: string; x: number; y: number; angle: number;
  shape: DlgShape; w: number; h: number; deltaAxis: 0 | 1; delta: number; rratio: number; cratio: number; corners: [boolean, boolean, boolean, boolean];
  offset: boolean; ox: number; oy: number; holeOblong: boolean; hx: number; hy: number; dieOn: boolean; die: number;
  copper: number; tech: Record<string, boolean>; property: string;
  zoneConnect: number; knockout: "outline" | "convexhull"; gap: number; spoke: number; spokeAngle: number;
  clearance: number; mask: number; paste: number; pasteRatio: number;
}
/** Technical layer checkboxes: label and the front-side layer name (a flipped footprint swaps F/B). */
export const TECH: [string, string][] = [["Front adhesive", "F.Adhes"], ["Back adhesive", "B.Adhes"], ["Front solder paste", "F.Paste"], ["Back solder paste", "B.Paste"],
  ["Front silk screen", "F.SilkS"], ["Back silk screen", "B.SilkS"], ["Front solder mask", "F.Mask"], ["Back solder mask", "B.Mask"], ["Drafting notes", "Dwgs.User"], ["E.C.O.1", "Eco1.User"], ["E.C.O.2", "Eco2.User"]];
const LAYER_ID: Record<string, number> = { "F.Cu": 0, "F.Mask": 1, "B.Cu": 2, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15, "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23 };
const layerId = (n: string): number => { if (n in LAYER_ID) return LAYER_ID[n]; const m = /^In(\d+)\.Cu$/.exec(n); return m ? 2 * Number(m[1]) + 2 : 1000; };
export const PROPS: [string, string][] = [["", "None"], ["pad_prop_bga", "BGA pad"], ["pad_prop_fiducial_loc", "Fiducial, local to footprint"], ["pad_prop_fiducial_glob", "Fiducial, global to board"],
  ["pad_prop_testpoint", "Test point pad"], ["pad_prop_heatsink", "Heatsink pad"], ["pad_prop_mechanical", "Mechanical"], ["pad_prop_castellated", "Castellated pad (TH only)"], ["pad_prop_pressfit", "Press-fit (round TH only)"]];
const flipName = (l: string): string => (/^F\./.test(l) ? "B." + l.slice(2) : /^B\./.test(l) ? "F." + l.slice(2) : l);

/** Expand the wildcard layer names a pad stores ("*.Cu", "*.Mask", "F&B.Cu") into single layers. */
export function expandLayers(names: string[], copper: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (n === "*.Cu") for (const c of copper) out.add(c);
    else if (n === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); }
    else if (/^\*\./.test(n)) { out.add("F." + n.slice(2)); out.add("B." + n.slice(2)); }
    else out.add(n);
  }
  return out;
}
/** PCB_IO_KICAD_SEXPR::formatLayers( mask, false ) for a pad. */
export function formatPadLayers(set: Set<string>, copper: string[]): string[] {
  const s = new Set(set); const out: string[] = [];
  const cu = copper.length ? copper : ["F.Cu", "B.Cu"];
  if (cu.every((c) => s.has(c)) && cu.length) { out.push("*.Cu"); for (const l of Array.from(s)) if (/\.Cu$/.test(l)) s.delete(l); }
  else if (s.has("F.Cu") && s.has("B.Cu") && cu.filter((c) => s.has(c)).length === 2) { out.push("*.Cu"); s.delete("F.Cu"); s.delete("B.Cu"); }
  for (const t of ["Adhes", "Paste", "SilkS", "Mask", "CrtYd", "Fab"]) if (s.has("F." + t) && s.has("B." + t)) { out.push("*." + t); s.delete("F." + t); s.delete("B." + t); }
  return out.concat(Array.from(s).sort((a, b) => layerId(a) - layerId(b) || (a < b ? -1 : 1)));
}

/** Copper choices of the "Copper layers:" control for a pad type (UpdateLayersDropdown). */
export function copperChoices(type: DlgType): string[] {
  switch (type) {
    case "pth": return ["All copper layers", "F.Cu, B.Cu and connected layers", "Connected layers only", "None"];
    case "npth": return ["F.Cu and B.Cu", "F.Cu", "B.Cu", "None"];
    case "smd": case "conn": return ["F.Cu", "B.Cu"];
    default: return ["None"];
  }
}
const yes = (n: SNode | null): boolean => !!n && str(n[1]) !== "no";

/** Read one pad (index) of a footprint item into the dialog's model (front-relative when the footprint is flipped). */
export function readPad(doc: KDoc, fp: SNode, pad: SNode, netName: string): PadModel {
  const [fx, fy, frot] = atOf(fp); const [px, py, prot] = atOf(pad); const [rx, ry] = rot(frot)(px, py);
  const flipped = str((kid(fp, "layer") || [])[1]) === "B.Cu";
  const raw = ((kid(pad, "layers") || []) as unknown[]).slice(1).map(str);
  const layers0 = expandLayers(raw, doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
  const layers = flipped ? new Set(Array.from(layers0, flipName)) : layers0;
  const hasCu = Array.from(layers).some((l) => /\.Cu$/.test(l));
  const t = str(pad[2]);
  const type: DlgType = t === "thru_hole" ? "pth" : t === "np_thru_hole" ? "npth" : t === "connect" ? "conn" : hasCu ? "smd" : "aperture";
  const sz = kid(pad, "size"); const w = num(sz && sz[1], 1), hh = num(sz && sz[2], w);
  const s = str(pad[3]); const ch = kid(pad, "chamfer"); const cornersOn = ["top_left", "top_right", "bottom_left", "bottom_right"].map((c) => !!ch && ch.includes(c)) as [boolean, boolean, boolean, boolean];
  const rr = num((kid(pad, "roundrect_rratio") || [])[1], 0.25), cr = num((kid(pad, "chamfer_ratio") || [])[1], 0.2);
  const opts = kid(pad, "options"), anchor = str((kid(opts, "anchor") || [])[1]);
  const chamfered = s === "roundrect" && cornersOn.some(Boolean);
  const shape: DlgShape = s === "circle" ? "circle" : s === "oval" ? "oval" : s === "rect" ? "rect" : s === "trapezoid" ? "trapezoid" : s === "custom" ? (anchor === "rect" ? "custom_rect" : "custom_circle")
    : chamfered ? (rr > 0 ? "mixed" : "chamfer") : "roundrect";
  const rd = kid(pad, "rect_delta"); const dx = num(rd && rd[1]), dy = num(rd && rd[2]);
  const dr = kid(pad, "drill"); const drVals = (dr || []).slice(1).filter((v) => !isList(v)); const oblong = drVals[0] === "oval"; const dn = drVals.filter((v) => typeof v === "number") as number[];
  const off = kid(dr, "offset");
  const copperSet = Array.from(layers).filter((l) => /\.Cu$/.test(l));
  let copper = 0;
  if (type === "pth") copper = !copperSet.length ? 3 : yes(kid(pad, "remove_unused_layers")) ? (yes(kid(pad, "keep_end_layers")) ? 1 : 2) : 0;
  else if (type === "npth") copper = layers.has("F.Cu") && layers.has("B.Cu") ? 0 : layers.has("F.Cu") ? 1 : layers.has("B.Cu") ? 2 : 3;
  else if (type === "smd" || type === "conn") copper = layers.has("B.Cu") && !layers.has("F.Cu") ? 1 : 0;
  const tech: Record<string, boolean> = {}; for (const [, l] of TECH) tech[l] = layers.has(l);
  const opt = (key: string): number => { const n = kid(pad, key); return n ? num(n[1], NaN) : NaN; };
  const zc = kid(pad, "zone_connect");
  const defAngle = s === "circle" || s === "custom" || s === "trapezoid" ? 45 : 90;
  const sa = kid(pad, "thermal_bridge_angle");
  return {
    type, number: str(pad[1]), net: netName, x: fx + rx, y: fy + ry, angle: norm180(prot - frot),
    shape, w, h: hh, deltaAxis: dx === 0 && dy !== 0 ? 1 : 0, delta: dx !== 0 ? dx : dy, rratio: rr, cratio: cr, corners: cornersOn,
    offset: !!off && (num(off[1]) !== 0 || num(off[2]) !== 0), ox: num(off && off[1]), oy: num(off && off[2]),
    holeOblong: oblong, hx: dn.length ? dn[0] : 0, hy: dn.length > 1 ? dn[1] : dn.length ? dn[0] : 0,
    dieOn: !!kid(pad, "die_length") && num((kid(pad, "die_length") || [])[1]) !== 0, die: num((kid(pad, "die_length") || [])[1]),
    copper, tech, property: str((kid(pad, "property") || [])[1]),
    zoneConnect: zc ? num(zc[1], -1) : -1, knockout: str((kid(opts, "clearance") || [])[1]) === "convexhull" ? "convexhull" : "outline",
    gap: opt("thermal_gap"), spoke: opt("thermal_bridge_width"), spokeAngle: sa ? num(sa[1], defAngle) : defAngle,
    clearance: opt("clearance"), mask: opt("solder_mask_margin"), paste: opt("solder_paste_margin"), pasteRatio: opt("solder_paste_margin_ratio"),
  };
}

const fileShape = (s: DlgShape): string => (s === "chamfer" || s === "mixed" ? "roundrect" : s === "custom_circle" || s === "custom_rect" ? "custom" : s);
const sameNum = (a: number, b: number): boolean => (isNaN(a) && isNaN(b)) || Math.abs(a - b) < 1e-9;

/** The layer set the model asks for (front-relative). */
export function modelLayers(m: PadModel, copper: string[]): Set<string> {
  const out = new Set<string>(); const all = copper.length ? copper : ["F.Cu", "B.Cu"];
  if (m.type === "pth") { if (m.copper !== 3) for (const c of all) out.add(c); }
  else if (m.type === "npth") { if (m.copper === 0 || m.copper === 1) out.add("F.Cu"); if (m.copper === 0 || m.copper === 2) out.add("B.Cu"); }
  else if (m.type === "smd" || m.type === "conn") out.add(m.copper === 1 ? "B.Cu" : "F.Cu");
  for (const [, l] of TECH) if (m.tech[l]) out.add(l);
  return out;
}

/** Problems CheckPad reports for the model: errors stop OK, warnings are shown. */
export function checkPad(m: PadModel): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const holeX = m.hx, holeY = m.holeOblong ? m.hy : m.hx;
  if (!(m.w > 0) || !(m.h > 0)) errors.push("Error: (Pad must have a positive size)");
  if ((m.type === "pth" || m.type === "npth") && !(holeX > 0 && holeY > 0)) errors.push(m.type === "pth" ? "Error: Through hole pad has no hole." : "Error: (Pad must have a positive size)");
  if (m.type === "pth" && holeX > 0 && m.copper !== 3) {
    const cu = m.shape === "circle" ? m.w : Math.min(m.w, m.h);
    if (holeX >= m.w && holeY >= m.h) warnings.push("Warning: (PTH pad hole leaves no copper)");
    else if (!m.offset && (holeX > m.w || holeY > m.h) && cu > 0) warnings.push("Warning: (PTH pad hole not fully inside copper)");
  }
  if (m.type === "pth" && m.copper === 3) warnings.push("Warning: (plated through holes normally have a copper pad on at least one layer)");
  if (m.property === "pad_prop_bga" && m.type !== "smd") warnings.push("Warning: ('BGA' property is for SMD pads)");
  if (m.property === "pad_prop_castellated" && m.type !== "pth") warnings.push("Warning: ('castellated' pads are normally PTH)");
  if (m.property === "pad_prop_pressfit" && (m.type !== "pth" || m.holeOblong)) warnings.push("Warning: ('press-fit' pads are normally PTH with round holes)");
  if (m.type === "smd" && m.tech["F.Mask"] && m.copper === 1 && !m.tech["B.Mask"]) warnings.push("Warning: (SMD pad has copper and mask layers on different sides of the board)");
  if (m.type === "smd" && m.tech["F.Paste"] && m.copper === 1 && !m.tech["B.Paste"]) warnings.push("Warning: (SMD pad has copper and paste layers on different sides of the board)");
  return { errors, warnings };
}

/**
 * Write the model into the pad node, touching only what differs from `was` (the model the dialog opened with).
 * `fp` is the footprint node (for its position / rotation / side), `numbered` whether the board numbers its nets.
 */
export function writePad(doc: KDoc, fp: SNode, pad: SNode, m: PadModel, was: PadModel, netCode: (name: string) => number): void {
  const [fx, fy, frot] = atOf(fp); const flipped = str((kid(fp, "layer") || [])[1]) === "B.Cu";
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const hasConn = m.type !== "npth" && m.type !== "aperture";
  // type and shape (the three atoms after the number)
  const t = m.type === "pth" ? "thru_hole" : m.type === "npth" ? "np_thru_hole" : m.type === "conn" ? "connect" : "smd";
  if (m.type !== was.type) pad[2] = t;
  if (fileShape(m.shape) !== str(pad[3])) pad[3] = fileShape(m.shape);
  if (!hasConn && was.number && m.type !== was.type) pad[1] = ""; else if (m.number !== was.number) pad[1] = m.number;
  // position and angle: the board position the dialog shows, back to footprint coordinates
  if (!sameNum(m.x, was.x) || !sameNum(m.y, was.y) || !sameNum(m.angle, was.angle)) {
    const [rx, ry] = rot(-frot)(m.x - fx, m.y - fy); const a = norm180(m.angle + frot);
    setPadChild(pad, "at", `(at ${f6(rx)} ${f6(ry)}${a ? " " + f6(a) : ""})`);
  }
  const w = m.w, hh = m.shape === "circle" ? m.w : m.h;
  if (!sameNum(w, was.w) || !sameNum(hh, was.shape === "circle" ? was.w : was.h)) setPadChild(pad, "size", `(size ${f6(w)} ${f6(hh)})`);
  // trapezoid delta
  if (m.shape === "trapezoid") { const dx = m.deltaAxis === 0 ? m.delta : 0, dy = m.deltaAxis === 1 ? m.delta : 0; setPadChild(pad, "rect_delta", dx || dy ? `(rect_delta ${f6(dx)} ${f6(dy)})` : null); }
  else setPadChild(pad, "rect_delta", null);
  // drill: plated / unplated holes only; an offset is kept on any type
  const holeChanged = m.type !== was.type || m.holeOblong !== was.holeOblong || !sameNum(m.hx, was.hx) || !sameNum(m.hy, was.hy) || m.offset !== was.offset || !sameNum(m.ox, was.ox) || !sameNum(m.oy, was.oy);
  if (holeChanged) {
    const holed = m.type === "pth" || m.type === "npth";
    const hx = holed ? m.hx : 0, hy = holed ? (m.holeOblong ? m.hy : m.hx) : 0; const off = m.offset && (m.ox || m.oy);
    if (hx > 0 || hy > 0 || off) {
      let s = "(drill"; if (holed && m.holeOblong) s += " oval"; if (hx > 0) s += " " + f6(hx); if (hy > 0 && Math.abs(hy - hx) > 1e-9) s += " " + f6(hy);
      if (off) s += ` (offset ${f6(m.ox)} ${f6(m.oy)})`; setPadChild(pad, "drill", s + ")");
    } else setPadChild(pad, "drill", null);
  }
  if (m.property !== was.property) setPadChild(pad, "property", m.property ? `(property ${m.property})` : null);
  // layers
  const before = modelLayers(was, copper), after = modelLayers(m, copper);
  const changedLayers = before.size !== after.size || Array.from(after).some((l) => !before.has(l)) || m.type !== was.type;
  if (changedLayers) {
    const fileSet = flipped ? new Set(Array.from(after, flipName)) : after;
    const names = formatPadLayers(fileSet, copper);
    setPadChild(pad, "layers", `(layers ${names.map(quote).join(" ")})`);
  }
  if (m.type === "pth" && (m.copper !== was.copper || m.type !== was.type)) {
    const remove = m.copper === 1 || m.copper === 2;
    setPadChild(pad, "remove_unused_layers", `(remove_unused_layers ${remove ? "yes" : "no"})`);
    if (remove) { setPadChild(pad, "keep_end_layers", `(keep_end_layers ${m.copper === 1 ? "yes" : "no"})`); if (!kid(pad, "zone_layer_connections")) setPadChild(pad, "zone_layer_connections", "(zone_layer_connections)"); }
    else { setPadChild(pad, "keep_end_layers", null); setPadChild(pad, "zone_layer_connections", null); }
  } else if (m.type !== "pth" && was.type === "pth") { for (const k of ["remove_unused_layers", "keep_end_layers", "zone_layer_connections"]) setPadChild(pad, k, null); }
  // corners
  const round = m.shape === "roundrect" || m.shape === "chamfer" || m.shape === "mixed";
  const rr = m.shape === "chamfer" ? 0 : m.rratio;
  const cornersWere = was.shape === "roundrect" || was.shape === "chamfer" || was.shape === "mixed";
  if (round && (!cornersWere || m.shape !== was.shape || !sameNum(rr, was.shape === "chamfer" ? 0 : was.rratio))) setPadChild(pad, "roundrect_rratio", `(roundrect_rratio ${f6(rr)})`);
  if (!round) setPadChild(pad, "roundrect_rratio", null);
  if (m.shape === "chamfer" || m.shape === "mixed") {
    const names = ["top_left", "top_right", "bottom_left", "bottom_right"].filter((_, i) => m.corners[i]);
    if (m.shape !== was.shape || !sameNum(m.cratio, was.cratio) || m.corners.some((c, i) => c !== was.corners[i])) {
      setPadChild(pad, "chamfer_ratio", `(chamfer_ratio ${f6(m.cratio)})`); setPadChild(pad, "chamfer", `(chamfer${names.length ? " " + names.join(" ") : ""})`);
    }
  } else { setPadChild(pad, "chamfer_ratio", null); setPadChild(pad, "chamfer", null); }
  // net
  if (!hasConn) setPadChild(pad, "net", null);
  else if (m.net !== was.net) {
    const cur = kid(pad, "net"); const numbered = cur ? typeof cur[1] === "number" : Array.from(doc.items.values()).some((it) => it.kind === "footprint" && (kids(it.node, "pad") as SNode[]).some((p) => { const n = kid(p, "net"); return !!n && typeof n[1] === "number"; }));
    setPadChild(pad, "net", !m.net ? null : numbered ? `(net ${netCode(m.net)} ${quote(m.net)})` : `(net ${quote(m.net)})`);
  }
  if (m.dieOn !== was.dieOn || !sameNum(m.die, was.die)) setPadChild(pad, "die_length", m.dieOn && m.die ? `(die_length ${f6(m.die)})` : null);
  const optional = (key: string, v: number, v0: number, fmt = f6): void => { if (!sameNum(v, v0)) setPadChild(pad, key, isNaN(v) ? null : `(${key} ${fmt(v)})`); };
  optional("solder_mask_margin", m.mask, was.mask); optional("solder_paste_margin", m.paste, was.paste); optional("solder_paste_margin_ratio", m.pasteRatio, was.pasteRatio);
  optional("clearance", m.clearance, was.clearance);
  if (m.zoneConnect !== was.zoneConnect) setPadChild(pad, "zone_connect", m.zoneConnect < 0 ? null : `(zone_connect ${m.zoneConnect})`);
  optional("thermal_bridge_width", m.spoke, was.spoke);
  const defAngle = m.shape === "circle" || m.shape === "trapezoid" || m.shape === "custom_circle" || m.shape === "custom_rect" ? 45 : 90;
  if (!sameNum(m.spokeAngle, was.spokeAngle) || m.shape !== was.shape) setPadChild(pad, "thermal_bridge_angle", sameNum(m.spokeAngle, defAngle) ? null : `(thermal_bridge_angle ${f6(m.spokeAngle)})`);
  optional("thermal_gap", m.gap, was.gap);
  // custom pads: the anchor and the zone knockout live in (options); primitives stay as drawn
  const custom = m.shape === "custom_circle" || m.shape === "custom_rect";
  if (custom) {
    if (m.shape !== was.shape || m.knockout !== was.knockout) setPadChild(pad, "options", `(options (clearance ${m.knockout}) (anchor ${m.shape === "custom_rect" ? "rect" : "circle"}))`);
    if (!kid(pad, "primitives")) setPadChild(pad, "primitives", "(primitives)");
  } else { setPadChild(pad, "options", null); setPadChild(pad, "primitives", null); }
}


export const padModel = { PAD_ORDER, TECH, PROPS, f6, setPadChild, expandLayers, formatPadLayers, copperChoices, readPad, modelLayers, checkPad, writePad };
