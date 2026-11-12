// web/fab/model — the board as the fabrication writers need it: footprints with their pads, tracks, vias and
// zone fills read out of the parsed document's nodes, plus the board-level values of (setup …) that decide
// solder mask and paste openings.  Read-only: nothing here touches the document.
import { arcFrom3, atOf, has, isList, kid, kids, num, polyPtsOf, str, yesNo } from "../canvas/sexpr";
import { type Pt, rot } from "./prims";

export type Node = SNode;
const K = (n: Node | null, key: string): Node | null => (n ? (kid(n, key) as Node | null) : null);

/** The parsed board the editor holds (KiCadCanvas.parseDoc), with the fields the canvas adds beyond KDoc. */
export type FabDoc = KDoc & { version?: number; auxOrigin?: [number, number] | null; titleBlock?: { [k: string]: string }; projectName?: string; fileName?: string };

export interface BoardSettings {
  maskExpansion: number; maskMinWidth: number; pasteClearance: number; pasteRatio: number;
  tentFront: boolean; tentBack: boolean;
  /** (aux_axis_origin x y): the drill / place file origin. */
  auxOrigin: Pt;
}

export function boardSettings(setup: Node | null, doc: FabDoc): BoardSettings {
  const n = (key: string): number => { const k = K(setup, key); return k ? num(k[1], 0) : 0; };
  const tent = K(setup, "tenting");
  let tentFront = true, tentBack = true;
  if (tent) {
    // KiCad 8 wrote (tenting front back); 9 and later (tenting (front yes) (back yes))
    const legacy = tent.slice(1).some((x) => !isList(x));
    if (legacy) { tentFront = tent.includes("front"); tentBack = tent.includes("back"); }
    else { const f = K(tent, "front"), b = K(tent, "back"); tentFront = f ? str(f[1]) !== "no" : false; tentBack = b ? str(b[1]) !== "no" : false; }
  } else {
    // before KiCad 8 tenting was a plot option: (pcbplotparams (viasonmask false)) means tented
    const pp = K(setup, "pcbplotparams"); const v = K(pp, "viasonmask");
    if (v) { const open = str(v[1]) === "true" || str(v[1]) === "yes"; tentFront = tentBack = !open; }
  }
  const ax = K(setup, "aux_axis_origin");
  return { maskExpansion: n("pad_to_mask_clearance"), maskMinWidth: n("solder_mask_min_width"), pasteClearance: n("pad_to_paste_clearance"), pasteRatio: n("pad_to_paste_clearance_ratio"),
    tentFront, tentBack, auxOrigin: ax ? [num(ax[1]), num(ax[2])] : doc.auxOrigin ? [doc.auxOrigin[0], doc.auxOrigin[1]] : [0, 0] };
}

// ---------------------------------------------------------------- layers
/** The board's copper layers from the top down: F.Cu, In1.Cu … InN.Cu, B.Cu. */
export function copperStack(doc: FabDoc): string[] {
  const cu = doc.copper && doc.copper.length ? doc.copper.slice() : ["F.Cu", "B.Cu"];
  const rank = (l: string): number => l === "F.Cu" ? 0 : l === "B.Cu" ? 1e6 : num((/^In(\d+)\.Cu$/.exec(l) || [])[1], 5e5);
  return cu.sort((a, b) => rank(a) - rank(b));
}
export const isCopper = (l: string): boolean => /\.Cu$/.test(l);
export const isFront = (l: string): boolean => /^F\./.test(l);
export const isBack = (l: string): boolean => /^B\./.test(l);

/** (layers "F.Cu" "*.Mask" …) against the board: wildcards expanded. */
export function expandLayers(names: string[], copper: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (n === "*.Cu") out.push(...copper);
    else if (n === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (n.startsWith("*.")) out.push("F" + n.slice(1), "B" + n.slice(1));
    else out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- footprints and pads
export interface PadShape {
  /** circle | rect | oval | trapezoid | roundrect | chamfer | custom */
  shape: string; w: number; h: number;
  /** corner radius ratio (of the shorter side) */
  rratio: number; chamferRatio: number; chamfers: string[];
  /** trapezoid delta */
  delta: Pt;
  /** shape offset from the pad position (the hole), pad frame */
  offset: Pt;
  anchor: string; primitives: Node | null;
}

export interface Pad {
  node: Node; fp: Footprint; number: string;
  /** thru_hole | smd | connect | np_thru_hole */
  type: string;
  /** position (the hole's centre) and orientation on the board */
  x: number; y: number; rot: number;
  layers: Set<string>;
  drill: { w: number; h: number; oval: boolean } | null;
  net: string; property: string;
  maskMargin: number | null; pasteMargin: number | null; pasteRatio: number | null;
  /** (remove_unused_layers), (keep_end_layers), (zone_layer_connections …) */
  removeUnused: boolean; keepEnds: boolean; zoneLayers: Set<string>;
  base: PadShape; stackMode: string; stack: Map<string, PadShape>;
  /** (tenting …) on a pad: false = open, true = covered, null = follow the layer set */
  tentFront: boolean | null; tentBack: boolean | null;
}

export interface Footprint {
  id: string; node: Node; item: KItem;
  /** library id and its item name (after the colon) */
  lib: string; name: string;
  x: number; y: number; rot: number;
  /** F.Cu or B.Cu */
  side: string;
  ref: string; value: string; props: Map<string, string>;
  smd: boolean; throughHole: boolean; boardOnly: boolean; excludeFromPos: boolean; excludeFromBom: boolean; dnp: boolean;
  maskMargin: number | null; pasteMargin: number | null; pasteRatio: number | null;
  privateLayers: Set<string>;
  pads: Pad[];
  /** footprint frame → board */
  tf: (x: number, y: number) => Pt;
}

const optNum = (n: Node | null, key: string): number | null => { const k = K(n, key); return k ? num(k[1], 0) : null; };

function readShape(n: Node, shape: string, inherit: PadShape | null): PadShape {
  const sz = K(n, "size"); const dr = K(n, "drill"); const off = K(n, "offset") || (dr ? K(dr, "offset") : null);
  const rr = K(n, "roundrect_rratio"); const cr = K(n, "chamfer_ratio"); const ch = K(n, "chamfer"); const rd = K(n, "rect_delta");
  const opts = K(n, "options"); const an = opts ? K(opts, "anchor") : null;
  const chamfers = ch ? ch.slice(1).map(str) : inherit ? inherit.chamfers : [];
  let s = shape || (inherit ? inherit.shape : "circle");
  if ((s === "roundrect" || s === "rect") && chamfers.length && (cr ? num(cr[1]) : inherit ? inherit.chamferRatio : 0) > 0) s = "chamfer";
  if (s === "rect" && rd && (num(rd[1]) || num(rd[2]))) s = "trapezoid";
  const w = sz ? num(sz[1], 0) : inherit ? inherit.w : 0;
  return { shape: s, w, h: sz ? num(sz[2], w) : inherit ? inherit.h : w,
    rratio: rr ? num(rr[1]) : inherit ? inherit.rratio : (s === "roundrect" ? 0.25 : 0), chamferRatio: cr ? num(cr[1]) : inherit ? inherit.chamferRatio : 0, chamfers,
    delta: rd ? [num(rd[1]), num(rd[2])] : inherit ? inherit.delta : [0, 0], offset: off ? [num(off[1]), num(off[2])] : inherit ? inherit.offset : [0, 0],
    anchor: an ? str(an[1]) : inherit ? inherit.anchor : "rect", primitives: K(n, "primitives") || (inherit ? inherit.primitives : null) };
}

/** The pad's shape on a layer: the padstack entry for inner / back copper, the front shape otherwise (PADSTACK::EffectiveLayerFor). */
export function padShapeOn(pad: Pad, layer: string, copper: string[]): PadShape {
  if (!pad.stack.size) return pad.base;
  const cu = isCopper(layer) ? layer : isBack(layer) ? "B.Cu" : "F.Cu";
  if (cu === "F.Cu") return pad.base;
  if (pad.stackMode === "front_inner_back") {
    if (cu === "B.Cu") return pad.stack.get("B.Cu") || pad.base;
    return pad.stack.get("Inner") || pad.stack.get(copper[1] || "In1.Cu") || pad.base;
  }
  return pad.stack.get(cu) || pad.base;
}

function frontBack(n: Node | null): [boolean | null, boolean | null] {
  if (!n) return [null, null];
  if (n.slice(1).some((x) => !isList(x))) return [n.includes("front") ? true : null, n.includes("back") ? true : null];
  const f = K(n, "front"), b = K(n, "back");
  const v = (k: Node | null): boolean | null => (k ? (str(k[1]) === "none" ? null : str(k[1]) !== "no") : null);
  return [v(f), v(b)];
}

function readPad(node: Node, fp: Footprint, copper: string[], nets: Map<number, string>): Pad {
  const [px, py, prot] = atOf(node) as [number, number, number];
  const [x, y] = fp.tf(px, py);
  const ls = K(node, "layers");
  const layers = new Set(expandLayers(ls ? ls.slice(1).map(str) : [fp.side], copper));
  const dr = K(node, "drill");
  let drill: Pad["drill"] = null;
  if (dr) {
    const oval = str(dr[1]) === "oval"; const nums = dr.slice(1).filter((v) => typeof v === "number") as number[];
    const w = nums.length ? nums[0] : 0, h = nums.length > 1 ? nums[1] : w;
    if (w > 0 || h > 0) drill = { w, h: oval ? h : w, oval: oval && Math.abs(w - h) > 1e-9 };
  }
  const netN = K(node, "net");
  const net = netN ? (typeof netN[1] === "number" ? (netN.length > 2 ? str(netN[2]) : str(nets.get(netN[1]) || "")) : str(netN[1])) : "";
  const base = readShape(node, str(node[3]), null);
  const stack = new Map<string, PadShape>(); let stackMode = "";
  const ps = K(node, "padstack");
  if (ps) {
    const m = K(ps, "mode"); stackMode = m ? str(m[1]) : "";
    for (const l of kids(ps, "layer") as Node[]) {
      const shapeN = K(l, "shape");
      stack.set(str(l[1]), readShape(l, shapeN ? str(shapeN[1]) : "", base));
    }
  }
  const ru = K(node, "remove_unused_layers"), ke = K(node, "keep_end_layers"), zl = K(node, "zone_layer_connections");
  const [tf, tb] = frontBack(K(node, "tenting"));
  const prop = K(node, "property");
  return { node, fp, number: str(node[1]), type: str(node[2]), x, y, rot: prot || 0, layers, drill, net, property: prop ? str(prop[1]) : "",
    maskMargin: optNum(node, "solder_mask_margin"), pasteMargin: optNum(node, "solder_paste_margin"), pasteRatio: optNum(node, "solder_paste_margin_ratio") ?? optNum(node, "solder_paste_ratio"),
    removeUnused: ru ? (ru.length < 2 || str(ru[1]) !== "no") : has(node, "remove_unused_layers"), keepEnds: ke ? (ke.length < 2 || str(ke[1]) !== "no") : has(node, "keep_end_layers"),
    zoneLayers: new Set(zl ? zl.slice(1).map(str) : []), base, stackMode, stack, tentFront: tf, tentBack: tb };
}

function readFootprint(item: KItem, copper: string[], nets: Map<number, string>): Footprint {
  const n = item.node;
  const [fx, fy, frot] = atOf(n) as [number, number, number];
  const layerN = K(n, "layer"); const side = layerN ? str(layerN[1]) : "F.Cu";
  const trN = K(n, "transform"); const scN = trN ? K(trN, "scale") : null; const sx = scN ? num(scN[1], 1) || 1 : 1, sy = scN ? num(scN[2], 1) || 1 : 1;
  const tf = (lx: number, ly: number): Pt => { const [x, y] = rot(lx * sx, ly * sy, frot || 0); return [fx + x, fy + y]; };
  const props = new Map<string, string>();
  for (const p of kids(n, "property") as Node[]) if (typeof p[2] !== "object") props.set(str(p[1]), str(p[2]));
  // KiCad 7 and earlier: (fp_text reference "R1" …) / (fp_text value "10k" …)
  for (const t of kids(n, "fp_text") as Node[]) { const kind = str(t[1]); if (kind === "reference" && !props.has("Reference")) props.set("Reference", str(t[2])); else if (kind === "value" && !props.has("Value")) props.set("Value", str(t[2])); }
  const attr = K(n, "attr"); const flags = attr ? attr.slice(1).map(str) : [];
  const priv = K(n, "private_layers");
  const lib = str(n[1]);
  const fp: Footprint = { id: item.id, node: n, item, lib, name: lib.indexOf(":") >= 0 ? lib.slice(lib.indexOf(":") + 1) : lib, x: fx, y: fy, rot: frot || 0, side,
    ref: props.get("Reference") || "", value: props.get("Value") || "", props,
    smd: flags.includes("smd"), throughHole: flags.includes("through_hole"), boardOnly: flags.includes("board_only"), excludeFromPos: flags.includes("exclude_from_pos_files"),
    excludeFromBom: flags.includes("exclude_from_bom"), dnp: flags.includes("dnp"),
    maskMargin: optNum(n, "solder_mask_margin"), pasteMargin: optNum(n, "solder_paste_margin"), pasteRatio: optNum(n, "solder_paste_margin_ratio") ?? optNum(n, "solder_paste_ratio"),
    privateLayers: new Set(priv ? priv.slice(1).map(str) : []), pads: [], tf };
  for (const p of kids(n, "pad") as Node[]) fp.pads.push(readPad(p, fp, copper, nets));
  return fp;
}

// ---------------------------------------------------------------- tracks, vias, zones
export interface Track {
  layer: string; w: number; x1: number; y1: number; x2: number; y2: number;
  /** a track arc: centre, radius, the canvas-convention angles and direction */
  arc: { cx: number; cy: number; r: number; a0: number; a1: number; acw: boolean } | null;
  /** the mask layer a track is opened on ((layers "F.Cu" "F.Mask")) and its margin */
  maskLayer: string | null; maskMargin: number | null;
  net?: string;
}
export interface Via {
  x: number; y: number; size: number; drill: number;
  /** through | blind | micro (KiCad 10 writes buried vias as blind with an inner pair) */
  type: string;
  /** the copper layers it spans, top down */
  layers: string[];
  /** per-layer diameters when the via has a padstack */
  sizes: Map<string, number> | null;
  net: string; removeUnused: boolean; keepEnds: boolean; zoneLayers: Set<string>;
  tentFront: boolean | null; tentBack: boolean | null;
}
export interface ZoneFill { layer: string; pts: Pt[] }

export interface BoardModel {
  doc: FabDoc; settings: BoardSettings; copper: string[];
  footprints: Footprint[]; tracks: Track[]; vias: Via[]; fills: ZoneFill[];
  /** zones that are on a copper layer and carry no fill */
  unfilledZones: number;
}

function netName(node: Node, nets: Map<number, string>): string {
  const nn = K(node, "net"); if (!nn) return "";
  return typeof nn[1] === "number" ? (nn.length > 2 ? str(nn[2]) : str(nets.get(nn[1]) || "")) : str(nn[1]);
}

function readTrack(n: Node, kind: string, nets?: Map<number, string>): Track | null {
  const s = K(n, "start"), e = K(n, "end"); if (!s || !e) return null;
  const ls = K(n, "layers"); const l1 = K(n, "layer");
  const names = ls ? ls.slice(1).map(str) : [l1 ? str(l1[1]) : "F.Cu"];
  const layer = names.find(isCopper) || names[0];
  const maskLayer = names.find((x) => /\.Mask$/.test(x)) || null;
  const wN = K(n, "width");
  const t: Track = { layer, w: wN ? num(wN[1], 0.25) : 0.25, x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), arc: null, maskLayer, maskMargin: optNum(n, "solder_mask_margin"), net: nets ? netName(n, nets) : undefined };
  if (kind === "arc") {
    const m = K(n, "mid");
    const a = m ? arcFrom3([t.x1, t.y1], [num(m[1]), num(m[2])], [t.x2, t.y2]) as { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean } | null : null;
    if (a) t.arc = { cx: a.x, cy: a.y, r: a.r, a0: a.a0, a1: a.a1, acw: a.anticlockwise };
  }
  return t;
}

function readVia(n: Node, copper: string[], nets: Map<number, string>): Via {
  const [x, y] = atOf(n) as [number, number, number];
  const sz = K(n, "size"), dr = K(n, "drill");
  const type = has(n, "blind") ? "blind" : has(n, "buried") ? "blind" : has(n, "micro") ? "micro" : "through";
  const ls = K(n, "layers"); const pair = ls ? [str(ls[1]), str(ls[2])] : ["F.Cu", "B.Cu"];
  let layers = copper;
  if (type !== "through") { const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); layers = i0 >= 0 && i1 >= 0 ? copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1) : pair; }
  const size = sz ? num(sz[1], 0.8) : 0.8;
  let sizes: Map<string, number> | null = null;
  const ps = K(n, "padstack");
  if (ps) {
    const mode = str((K(ps, "mode") || [])[1]);
    const entry = new Map<string, number>();
    for (const l of kids(ps, "layer") as Node[]) { const s = K(l, "size"); if (s) entry.set(str(l[1]), num(s[1], size)); }
    sizes = new Map();
    for (const l of layers) {
      if (l === "F.Cu") sizes.set(l, size);
      else if (mode === "front_inner_back") sizes.set(l, l === "B.Cu" ? entry.get("B.Cu") ?? size : entry.get("Inner") ?? entry.get(copper[1]) ?? size);
      else sizes.set(l, entry.get(l) ?? size);
    }
  }
  const ru = K(n, "remove_unused_layers"), ke = K(n, "keep_end_layers"), zl = K(n, "zone_layer_connections");
  const [tf, tb] = frontBack(K(n, "tenting"));
  return { x, y, size, drill: dr ? num(dr[1], 0.4) : 0.4, type, layers, sizes, net: netName(n, nets),
    removeUnused: ru ? (ru.length < 2 || str(ru[1]) !== "no") : has(n, "remove_unused_layers"), keepEnds: ke ? (ke.length < 2 || str(ke[1]) !== "no") : has(n, "keep_end_layers"),
    zoneLayers: new Set(zl ? zl.slice(1).map(str) : []), tentFront: tf, tentBack: tb };
}

function readZone(n: Node, copper: string[], tf: ((x: number, y: number) => Pt) | null, out: BoardModel): void {
  if (K(n, "keepout")) return;   // a rule area has no fill
  const single = K(n, "layer"), multi = K(n, "layers");
  const layers = expandLayers(single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"], copper);
  const fills = kids(n, "filled_polygon") as Node[];
  if (!fills.length) { if (layers.some(isCopper)) out.unfilledZones++; return; }
  for (const f of fills) {
    const l = K(f, "layer"); const pts = (polyPtsOf(f) as Pt[]); if (pts.length < 3) continue;
    out.fills.push({ layer: l ? str(l[1]) : layers[0], pts: tf ? pts.map((p) => tf(p[0], p[1])) : pts });
  }
}

/** Read the board once; every writer works from this. */
export function boardModel(doc: FabDoc, setup: Node | null): BoardModel {
  const copper = copperStack(doc);
  const m: BoardModel = { doc, settings: boardSettings(setup, doc), copper, footprints: [], tracks: [], vias: [], fills: [], unfilledZones: 0 };
  for (const item of doc.items.values()) {
    const n = item.node;
    if (item.kind === "footprint") {
      const fp = readFootprint(item, copper, doc.nets);
      m.footprints.push(fp);
      // a zone inside a footprint is kept in the footprint's frame
      for (const z of kids(n, "zone") as Node[]) readZone(z, copper, fp.tf, m);
    } else if (item.kind === "segment" || item.kind === "arc") { const t = readTrack(n, item.kind, doc.nets); if (t) m.tracks.push(t); }
    else if (item.kind === "via") m.vias.push(readVia(n, copper, doc.nets));
    else if (item.kind === "zone") readZone(n, copper, null, m);
  }
  return m;
}
