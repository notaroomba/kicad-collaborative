// pcb-tools/drc-silk.ts — the silkscreen and solder mask DRC providers:
//   DRC_TEST_PROVIDER_SILK_CLEARANCE   silk against silk (silk_overlap) and silk clipped by a mask opening
//                                      (silk_over_copper), plus silk_clearance rules against any front/back layer
//   DRC_TEST_PROVIDER_EDGE_CLEARANCE   silk against the board edge (silk_edge_clearance), resolveSilkDisposition
//   DRC_TEST_PROVIDER_SOLDER_MASK      silk against the healed mask when there is a minimum web width, and mask
//                                      apertures bridging copper of different nets (solder_mask_bridge)
// The shapes are the plotter's (fab/plot geomPrims: stroke-font text, graphics with their pen), one element per
// BOARD_ITEM: a board drawing, or one child of a footprint (a field, text, graphic or pad) with the footprint as
// its parent.  Lengths are mm.
import type { Box, CopperShape, DesignSettings, DrcMarker, PadInfo, Pt } from "./types";
import { geomPrims, PlotLog } from "../../fab/plot";
import type { Prim } from "../../fab/prims";
import { arcPoints as primArcPoints } from "../../fab/prims";
import { boardSettings } from "../../fab/model";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { coreDist, padShape, polyPolyDist, shapeBBox, shapeOffset } from "./distances";
import { boardOutline, edgeShapes, marker, mm4 } from "./drc";
import type { DruRule, RuleItem } from "./dru";
import { evalRuleConstraint } from "./dru";
import { netName } from "./dru-eval";
import { conductors } from "./netlist";
import { zoneLayers } from "./nodes";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { pointInPoly } from "./hit";
import { isList, layerOf } from "./util";


const EPS = 1e-6;
const defaultSeverity = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
const SILK = ["F.SilkS", "B.SilkS"];

/** One BOARD_ITEM's shapes on one layer. `grow` widens every shape (a solder mask expansion); `net` is null for an unconnected item. */
export interface DrcElement {
  id: string; uuid: string; kind: string; node: SNode; fp: KItem | null; layer: string;
  shapes: CopperShape[]; grow: number; bbox: Box; net: string | null;
  /** copper layers the item is on (mask bridges) */
  copper: Set<string>; mask: Set<string>;
  pad?: PadInfo; npthNoCopper?: boolean;
}

// ---------------------------------------------------------------- geometry
/** A plot primitive as distance shapes (core + offset). */
export function primShapes(p: Prim): CopperShape[] {
  if (p.clear) return [];
  switch (p.k) {
    case "seg": return p.w > 0 || (p.x1 === p.x2 && p.y1 === p.y2) ? [{ t: "seg", a: [p.x1, p.y1], b: [p.x2, p.y2], r: p.w / 2 }] : [];
    case "arc": return p.w > 0 ? [{ t: "path", pts: primArcPoints(p.cx, p.cy, p.r, p.a0, p.a1, p.acw, 0.005), r: p.w / 2 }] : [];
    case "circle": return p.d > 0 ? [{ t: "circle", x: p.x, y: p.y, r: p.d / 2 }] : [];
    case "rect": return [{ t: "rect", x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot, rr: 0 }];
    case "roundrect": return [{ t: "rect", x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot, rr: p.r }];
    case "oval": return [padShape({ shape: "oval", x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot })];
    case "poly": return p.pts.length >= 3 ? [{ t: "poly", pts: p.pts.map((q) => [p.x + q[0], p.y + q[1]] as Pt) }] : [];
    case "region": return p.pts.length >= 3 ? [{ t: "poly", pts: p.pts }] : [];
  }
  return [];
}
/** The shapes a set of canvas geometry records draws on `layer` (a knockout text is its box). */
export function geomShapes(geoms: KGeom[], layer: string, grow = 0): CopperShape[] {
  const out: Prim[] = [], knock: Prim[] = []; const log = new PlotLog();
  for (const g of geoms) {
    if (g.hiddenText || g.point || g.zoneOutline || g.zoneHatch || g.pad || g.hole || g.padText) continue;
    if (g.layer === layer) geomPrims(g, out, knock, log, 0);
    else if (g.maskLayer === layer) geomPrims(g, out, knock, log, grow || (typeof g.maskMargin === "number" ? g.maskMargin as number : 0));
  }
  const shapes: CopperShape[] = [];
  for (const p of knock.concat(out)) for (const s of primShapes(p)) shapes.push(s);
  return shapes;
}
function bboxOf(shapes: CopperShape[], grow: number): Box {
  let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of shapes) { const q = shapeBBox(s); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return [b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow];
}
/** Signed gap between two shapes (negative when they overlap by more than touching). */
function rawGap(a: CopperShape, b: CopperShape): number {
  const core = a.t === "poly" && b.t === "poly" ? polyPolyDist(a.pts, b.pts) : coreDist(a, b);
  if (core === 0) {
    // the cores meet: a filled polygon holding the other counts as overlap, as does any crossing
    return -Math.max(EPS * 2, shapeOffset(a) + shapeOffset(b));
  }
  return core - shapeOffset(a) - shapeOffset(b);
}
/** SHAPE::Collide( other, clearance, &actual ): the least signed gap between two elements, and whether it collides. */
export function elementGap(a: DrcElement, b: DrcElement): number {
  let best = Infinity;
  for (const s of a.shapes) for (const t of b.shapes) { const g = rawGap(s, t) - a.grow - b.grow; if (g < best) best = g; if (best < -1) return best; }
  return best;
}
const collides = (gap: number, clearance: number) => gap < clearance - EPS || (gap < 0 && clearance <= EPS);
const touch = (a: Box, b: Box, slop: number) => !(b[0] > a[2] + slop || b[2] < a[0] - slop || b[1] > a[3] + slop || b[3] < a[1] - slop);
const centre = (a: Box, b: Box): Pt => [(Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2, (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2];

/** A 2 mm bucket grid over elements (the R-tree's job in KiCad): `near(box, slop)` lists the candidates once each. */
export function elementGrid(els: DrcElement[]) {
  const G = 2, grid = new Map<string, number[]>(); const cell = (v: number) => Math.floor(v / G);
  els.forEach((e, i) => { if (!isFinite(e.bbox[0])) return; for (let gx = cell(e.bbox[0]); gx <= cell(e.bbox[2]); gx++) for (let gy = cell(e.bbox[1]); gy <= cell(e.bbox[3]); gy++) { const k = gx + "," + gy; const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); } });
  return (b: Box, slop: number): DrcElement[] => {
    const got = new Set<number>();
    for (let gx = cell(b[0] - slop); gx <= cell(b[2] + slop); gx++) for (let gy = cell(b[1] - slop); gy <= cell(b[3] + slop); gy++) for (const i of grid.get(gx + "," + gy) || []) got.add(i);
    return [...got].sort((x, y) => x - y).map((i) => els[i]);
  };
}

/** A filled polygon with its edges in 1 mm buckets: the gap to a small element without walking every vertex (a zone's R-tree). */
export function polyIndex(pts: Pt[]) {
  const G = 1, cells = new Map<string, number[]>(), rows = new Map<number, number[]>(); const cell = (v: number) => Math.floor(v / G);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let gx = cell(Math.min(a[0], b[0])); gx <= cell(Math.max(a[0], b[0])); gx++) for (let gy = cell(Math.min(a[1], b[1])); gy <= cell(Math.max(a[1], b[1])); gy++) { const k = gx + "," + gy; const l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); }
    for (let gy = cell(Math.min(a[1], b[1])); gy <= cell(Math.max(a[1], b[1])); gy++) { const l = rows.get(gy); if (l) l.push(i); else rows.set(gy, [i]); }
  }
  const inside = (x: number, y: number) => {
    let c = false; for (const i of rows.get(cell(y)) || []) { const a = pts[i], b = pts[(i + 1) % pts.length]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; }
    return c;
  };
  /** The signed gap from an element to the polygon (negative inside), or Infinity when farther than `reach`. */
  return (e: DrcElement, reach: number): number => {
    let best = Infinity;
    for (const sh of e.shapes) {
      const b = shapeBBox(sh); if (inside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) return -1;
      const seen = new Set<number>(); const r = reach + Math.max(0, e.grow);
      for (let gx = cell(b[0] - r); gx <= cell(b[2] + r); gx++) for (let gy = cell(b[1] - r); gy <= cell(b[3] + r); gy++) for (const i of cells.get(gx + "," + gy) || []) {
        if (seen.has(i)) continue; seen.add(i);
        const g = rawGap(sh, { t: "seg", a: pts[i], b: pts[(i + 1) % pts.length], r: 0 }) - e.grow; if (g < best) best = g;
      }
    }
    return best;
  };
}

// ---------------------------------------------------------------- the board's items as elements
/** The board's (setup …): the settings' own copy (Board Setup), else the one the editor cached with the board. */
function setupOf(doc: KDoc, s: DesignSettings): SNode | null {
  const own = s.boardSetup as SNode | string | null | undefined;
  if (own && typeof own !== "string") return own;
  if (typeof own === "string") { try { const t = K.parse(own); return (t && (t[0] === "setup" ? t : K.kid(t, "setup"))) || null; } catch (e) { return null; } }
  const cached = (doc as { boardSetup?: { setup?: SNode | null } }).boardSetup;
  return cached && cached.setup ? cached.setup : null;
}
export interface MaskSetup { maskExpansion: number; webWidth: number; tentFront: boolean; tentBack: boolean; allowBridgesInFps: boolean }
export function maskSetup(doc: KDoc, s: DesignSettings): MaskSetup {
  const setup = setupOf(doc, s);
  const b = boardSettings(setup as never, doc as never);
  const ab = setup ? K.kid(setup, "allow_soldermask_bridges_in_footprints") : null;
  return { maskExpansion: b.maskExpansion, webWidth: b.maskMinWidth, tentFront: b.tentFront, tentBack: b.tentBack, allowBridgesInFps: !!ab && /^(yes|true)$/.test(K.str(ab[1])) };
}
const FP_DRAWN = new Set(["property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_ellipse", "fp_ellipse_arc", "barcode", "dimension", "zone", "table"]);
const expand = (names: string[], copper: string[]) => names.flatMap((n) => (n === "*.Cu" ? copper : n === "F&B.Cu" ? ["F.Cu", "B.Cu"] : n.startsWith("*.") ? ["F" + n.slice(1), "B" + n.slice(1)] : [n]));
const isRuleArea = (n: SNode) => !!K.kid(n, "keepout");
/** The geometry of one footprint child: the footprint rebuilt around it alone (its other fields hidden). */
function childGeoms(doc: KDoc, fp: KItem, child: SNode): KGeom[] {
  const n = fp.node; const body: SNode[] = [];
  for (let i = 2; i < n.length; i++) {
    const g = n[i] as SNode; if (!isList(g)) continue;
    if (g[0] === "layer" || g[0] === "at" || g[0] === "transform") body.push(g);
    else if (g[0] === "property") body.push(g === child ? g : (g as unknown[]).concat([["hide", "yes"]]) as SNode);
  }
  if (child[0] !== "property") body.push(child);
  const item = { id: fp.id, kind: "footprint", node: [n[0], n[1], ...body] as SNode, geom: [], bbox: null, movable: true, docType: "pcb" } as unknown as KItem;
  try { K.buildGeom(doc as never, item); } catch (e) { return []; }
  return item.geom;
}
/** PAD::GetSolderMaskExpansion. */
function padMaskMargin(p: PadInfo, fp: KItem, ms: MaskSetup) {
  if (!p.layers.some((l) => /\.Cu$/.test(l))) return 0;
  const own = K.kid(p.node, "solder_mask_margin"), fpm = K.kid(fp.node, "solder_mask_margin");
  let v = own ? K.num(own[1], 0) : fpm ? K.num(fpm[1], 0) : ms.maskExpansion;
  if (v < 0) v = Math.max(v, -Math.min(p.w, p.h) / 2);
  return v;
}

/**
 * Every item drawn on one of `layers` as elements (forEachGeometryItem), rule areas left out.  Pads and vias carry
 * their copper and mask layers; a tented via is on no mask layer.
 */
export function boardElements(doc: KDoc, s: DesignSettings, layers: Set<string>, ms = maskSetup(doc, s)): DrcElement[] {
  const out: DrcElement[] = []; const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const push = (e: Omit<DrcElement, "bbox">) => { if (!e.shapes.length) return; (e as DrcElement).bbox = bboxOf(e.shapes, Math.max(0, e.grow)); out.push(e as DrcElement); };
  const layersOfGeoms = (geoms: KGeom[]) => { const ls = new Set<string>(); for (const g of geoms) { if (g.hiddenText || g.point || g.zoneOutline || g.zoneHatch) continue; if (g.layer) ls.add(g.layer); if (typeof g.maskLayer === "string") ls.add(g.maskLayer); } return ls; };
  const fromGeoms = (geoms: KGeom[], id: string, uuid: string, kind: string, node: SNode, fp: KItem | null, net: string | null) => {
    const ls = layersOfGeoms(geoms); const cu = new Set([...ls].filter((l) => /\.Cu$/.test(l))), mk = new Set([...ls].filter((l) => /\.Mask$/.test(l)));
    for (const l of ls) if (layers.has(l)) push({ id, uuid, kind, node, fp, layer: l, shapes: geomShapes(geoms, l), grow: 0, net, copper: cu, mask: mk });
  };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "footprint") {
      for (let i = 2; i < n.length; i++) {
        const g = n[i] as SNode; if (!isList(g) || !FP_DRAWN.has(String(g[0]))) continue;
        if (g[0] === "zone") { if (isRuleArea(g)) continue; if (!expand(zoneLayers(g), copper).some((l) => layers.has(l))) continue; }
        else if (g[0] !== "dimension" && g[0] !== "table" && !layers.has(layerOf(g, "F.SilkS"))) continue;
        const net = g[0] === "zone" ? netName(doc as never, g) : null;
        fromGeoms(childGeoms(doc, it, g), it.id, K.uuidOf(g) || it.id + ":" + i, String(g[0]), g, it, net);
      }
      for (const p of padsOf(it)) {
        const ls = expand(p.layers, copper); const cu = new Set(ls.filter((l) => /\.Cu$/.test(l))), mk = new Set(ls.filter((l) => /\.Mask$/.test(l)));
        const dr = K.kid(p.node, "drill"); const hole = dr ? K.num(K.str(dr[1]) === "oval" ? dr[2] : dr[1], 0) : 0;
        const npthNoCopper = p.type === "np_thru_hole" && hole >= Math.min(p.w, p.h) - EPS;
        const net = p.type === "np_thru_hole" ? null : (p.net.name || (p.net.code > 0 && doc.nets ? String(doc.nets.get(p.net.code) || "") : ""));
        for (const l of ls) {
          if (!layers.has(l)) continue;
          const shape = padShape(p); const grow = /\.Mask$/.test(l) ? padMaskMargin(p, it, ms) : 0;
          if (/\.Cu$/.test(l) && npthNoCopper) continue;
          push({ id: it.id, uuid: K.uuidOf(p.node) || it.id + ":p" + p.index, kind: "pad", node: p.node, fp: it, layer: l, shapes: [shape], grow, net, copper: cu, mask: mk, pad: p, npthNoCopper });
        }
      }
      continue;
    }
    if (it.kind === "zone" && isRuleArea(n)) continue;
    if (it.kind === "via") {
      const at = K.kid(n, "at"); if (!at) continue; const x = K.num(at[1]), y = K.num(at[2]); const size = K.num((K.kid(n, "size") || [0, 0.6])[1], 0.6);
      const ls = K.kid(n, "layers"); const pair = ls ? [K.str(ls[1]), K.str(ls[2])] : ["F.Cu", "B.Cu"];
      const lo = copper.indexOf(pair[0]), hi = copper.indexOf(pair[1]); const span = new Set(copper.filter((_, i) => i >= Math.min(lo, hi) && i <= Math.max(lo, hi)));
      const t = K.kid(n, "tenting"); const tf = t ? K.kid(t, "front") : null, tb = t ? K.kid(t, "back") : null;
      const tentF = tf && K.str(tf[1]) !== "none" ? K.str(tf[1]) !== "no" : ms.tentFront, tentB = tb && K.str(tb[1]) !== "none" ? K.str(tb[1]) !== "no" : ms.tentBack;
      const mk = new Set<string>(); if (span.has("F.Cu") && !tentF) mk.add("F.Mask"); if (span.has("B.Cu") && !tentB) mk.add("B.Mask");
      const net = netName(doc as never, n); const shapes: CopperShape[] = [{ t: "circle", x, y, r: size / 2 }];
      for (const l of [...span, ...mk]) if (layers.has(l)) push({ id: it.id, uuid: it.id, kind: "via", node: n, fp: null, layer: l, shapes, grow: /\.Mask$/.test(l) ? ms.maskExpansion : 0, net, copper: span, mask: mk });
      continue;
    }
    if (it.kind === "group" || it.kind === "image" || it.kind === "generated" || it.kind === "point" || it.kind === "gr_bbox") continue;
    const connected = it.kind === "segment" || it.kind === "arc" || it.kind === "zone" || /^gr_/.test(it.kind) && /\.Cu$/.test(layerOf(n, ""));
    fromGeoms(it.geom || [], it.id, it.id, it.kind, n, null, connected ? netName(doc as never, n) : null);
  }
  return out;
}
/** The elements on `layers`, from a pool already built for more layers when there is one. */
function elementsOn(doc: KDoc, s: DesignSettings, layers: Set<string>, ms: MaskSetup, pool?: DrcElement[] | null) {
  return pool ? pool.filter((e) => layers.has(e.layer)) : boardElements(doc, s, layers, ms);
}
const ruleItem = (e: DrcElement, layer: string): RuleItem => ({ kind: e.kind, node: e.node, parent: e.fp, item: e.fp ? null : undefined, layer, shape: e.shapes[0] || null, id: e.id });

/** EvalRules( SILK_CLEARANCE_CONSTRAINT, a, b, layer ): a custom rule either way round, else the implicit silk rule (silk layers only). */
function silkConstraint(rules: DruRule[], doc: KDoc, s: DesignSettings, a: DrcElement | null, b: DrcElement | null, layer: string | null) {
  if (rules.length && a) {
    const A = ruleItem(a, layer || a.layer), B = b ? ruleItem(b, layer || b.layer) : null;
    const h = evalRuleConstraint(rules, "silk_clearance", doc as never, s, A, B) || (B ? evalRuleConstraint(rules, "silk_clearance", doc as never, s, B, A) : null);
    if (h) return { min: h.severity === "ignore" ? -1 : (h.min != null ? h.min : 0), name: h.name };
  }
  if (layer === null || SILK.includes(layer)) return { min: typeof s.minSilkClearance === "number" ? s.minSilkClearance as number : 0, name: "board setup constraints silk" };
  return null;
}
const detail = (name: string, min: number, actual: number) => (min > 0 ? ` (${name} clearance ${mm4(min)}; actual ${mm4(Math.max(0, actual))})` : "");

// ---------------------------------------------------------------- DRC_TEST_PROVIDER_SILK_CLEARANCE
const TARGETS: Record<string, string[]> = {
  "F.SilkS": ["F.SilkS", "F.Mask", "F.Adhes", "F.Paste", "F.CrtYd", "F.Fab", "F.Cu", "Edge.Cuts", "Margin"],
  "B.SilkS": ["B.SilkS", "B.Mask", "B.Adhes", "B.Paste", "B.CrtYd", "B.Fab", "B.Cu", "Edge.Cuts", "Margin"],
};
export function silkClearanceMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[], ms = maskSetup(doc, s), pool?: DrcElement[] | null): DrcMarker[] {
  const out: DrcMarker[] = [];
  const customSilk = rules.some((r) => r.constraints.some((c) => c.type === "silk_clearance"));
  const checkIndividualMaskItems = !(ms.webWidth > 0);
  // without a custom silk rule only silk and mask targets can carry a constraint
  const want = new Set<string>(SILK.concat(["F.Mask", "B.Mask"])); if (customSilk) for (const l of Object.values(TARGETS).flat()) want.add(l);
  const els = elementsOn(doc, s, want, ms, customSilk ? null : pool); if (!els.some((e) => SILK.includes(e.layer))) return out;
  const byLayer = new Map<string, DrcElement[]>(); for (const e of els) { const l = byLayer.get(e.layer); if (l) l.push(e); else byLayer.set(e.layer, [e]); }
  const ol = boardOutline(doc as never); const outline = ol.outline ? { t: "poly" as const, pts: ol.outline } : null; const ob = outline ? shapeBBox(outline) : null;
  const onBoard = new Map<DrcElement, boolean>();
  const touchesOutline = (e: DrcElement) => { if (!outline) return true; let v = onBoard.get(e); if (v === undefined) { v = touch(e.bbox, ob!, 0) && e.shapes.some((sh) => rawGap(sh, outline) - Math.max(0, e.grow) <= EPS); onBoard.set(e, v); } return v; };
  const largest = Math.max(0, typeof s.minSilkClearance === "number" ? s.minSilkClearance as number : 0, ...rules.flatMap((r) => r.constraints.filter((c) => c.type === "silk_clearance").map((c) => c.min || 0)));
  const reported = new Set<string>();
  for (const silkLayer of SILK) {
    const refs = byLayer.get(silkLayer) || [];
    for (const target of TARGETS[silkLayer]) {
      const tests = byLayer.get(target) || []; if (!tests.length) continue; const near = elementGrid(tests);
      for (const ref of refs) for (const test of near(ref.bbox, largest)) {
        if (ref === test) continue;
        if (target === silkLayer && ref.uuid > test.uuid) continue;   // each silk pair once
        if (!touch(ref.bbox, test.bbox, largest)) continue;
        // a tented via shows only its hole, and a via is never on a silk layer, so nothing to do for tenting here
        if (!touchesOutline(test)) continue;
        let code = "silk_overlap"; const c = silkConstraint(rules, doc, s, ref, test, target); let min = c ? c.min : -1; const name = c ? c.name : "";
        if (/\.Mask$/.test(target)) { if (checkIndividualMaskItems) min = Math.max(min, 0); code = "silk_over_copper"; }
        if (min < 0) continue;
        // graphics are often compound shapes: two drawings of one footprint (or both of the board) are not tested
        const isShape = (e: DrcElement) => /^(fp|gr)_(line|rect|circle|arc|poly|curve|ellipse|ellipse_arc)$/.test(e.kind);
        if (isShape(ref) && isShape(test) && ref.fp === test.fp) continue;
        let [a, b] = [ref, test]; if (target === silkLayer && a.uuid > b.uuid) [a, b] = [b, a];
        const key = code + "|" + a.uuid + "|" + b.uuid + "|" + target; if (reported.has(key)) continue;
        const gap = elementGap(a, b); if (!collides(gap, min)) continue;
        reported.add(key);
        const [x, y] = centre(a.bbox, b.bbox); const title = code === "silk_overlap" ? "Silkscreen clearance" : "Silkscreen clipped by solder mask";
        out.push(marker(code, defaultSeverity(code), x, y, title + detail(name, min, gap), Array.from(new Set([a.id, b.id]))));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- silk to the board edge
/** DRC_TEST_PROVIDER_EDGE_CLEARANCE for silk: silk within the silk clearance of an Edge.Cuts / Margin drawing, or a compound silk item that crosses the outline. */
export function silkEdgeMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[], ms = maskSetup(doc, s), pool?: DrcElement[] | null): DrcMarker[] {
  const out: DrcMarker[] = []; const sev = defaultSeverity("silk_edge_clearance");
  const edges = edgeShapes(doc as never); if (!edges.shapes.length) return out;
  const silk = elementsOn(doc, s, new Set(SILK), ms, pool); if (!silk.length) return out;
  const eb = edges.shapes.map((e) => shapeBBox(e));
  const edgeEl = (i: number): DrcElement => ({ id: edges.ids[i], uuid: edges.ids[i], kind: "gr_line", node: (doc.items.get(edges.ids[i]) || { node: ["gr_line", ["layer", "Edge.Cuts"]] }).node as SNode, fp: null, layer: "Edge.Cuts", shapes: [edges.shapes[i]], grow: 0, bbox: eb[i], net: null, copper: new Set(), mask: new Set() });
  const ol = boardOutline(doc as never);
  for (const e of silk) {
    let crosses = false;
    for (let i = 0; i < edges.shapes.length; i++) {
      const edge = edgeEl(i); const c = silkConstraint(rules, doc, s, edge, e, null); if (!c || c.min < 0) continue;
      const clr = Math.max(0, c.min - EPS); if (!touch(e.bbox, eb[i], clr)) continue;
      const gap = elementGap(e, edge); if (!collides(gap, clr)) continue;
      const [x, y] = centre(e.bbox, eb[i]);
      out.push(marker("silk_edge_clearance", sev, x, y, "Silkscreen clipped by board edge" + detail(c.name, c.min, gap), Array.from(new Set([edge.id, e.id])))); crosses = true; break;
    }
    if (crosses || !ol.outline || e.shapes.length < 2) continue;
    // resolveSilkDisposition: the item's pieces lie on both sides of the outline
    const inside = (sh: CopperShape) => { const b = shapeBBox(sh); return pointInPoly(ol.outline!, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
    const first = inside(e.shapes[0]); if (e.shapes.every((sh) => inside(sh) === first)) continue;
    const cx = (e.bbox[0] + e.bbox[2]) / 2, cy = (e.bbox[1] + e.bbox[3]) / 2; let best: Pt = ol.outline[0], bd = Infinity, bi = -1;
    for (let i = 0; i < ol.outline.length; i++) {
      const p = ol.outline[i], q = ol.outline[(i + 1) % ol.outline.length]; const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((cx - p[0]) * dx + (cy - p[1]) * dy) / l2)) : 0; const n: Pt = [p[0] + t * dx, p[1] + t * dy]; const d = Math.hypot(n[0] - cx, n[1] - cy);
      if (d < bd) { bd = d; best = n; }
    }
    for (let i = 0; i < edges.shapes.length; i++) if (rawGap(edges.shapes[i], { t: "circle", x: best[0], y: best[1], r: 0 }) <= 0.01) { bi = i; break; }
    if (bi < 0) continue;
    const c = silkConstraint(rules, doc, s, edgeEl(bi), e, null); if (!c || c.min < 0) continue;
    out.push(marker("silk_edge_clearance", sev, best[0], best[1], "Silkscreen clipped by board edge" + detail(c.name, c.min, 0), Array.from(new Set([edges.ids[bi], e.id]))));
  }
  return out;
}

// ---------------------------------------------------------------- DRC_TEST_PROVIDER_SOLDER_MASK
/** testSilkToMaskClearance (a minimum web width set): silk over the healed mask — openings closer than the web width merge. */
export function silkToMaskMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[], ms = maskSetup(doc, s), pool?: DrcElement[] | null): DrcMarker[] {
  const out: DrcMarker[] = []; if (!(ms.webWidth > 0)) return out;
  const els = elementsOn(doc, s, new Set(SILK.concat(["F.Mask", "B.Mask"])), ms, pool);
  const w = ms.webWidth;
  for (const silkLayer of SILK) {
    const maskLayer = silkLayer === "F.SilkS" ? "F.Mask" : "B.Mask";
    const silk = els.filter((e) => e.layer === silkLayer), mask = els.filter((e) => e.layer === maskLayer); if (!mask.length) continue;
    for (const e of silk) {
      let clearance = 0, name = "";
      if (rules.length) { const h = evalRuleConstraint(rules, "silk_clearance", doc as never, s, ruleItem(e, maskLayer), null); if (h) { if (h.severity === "ignore") continue; clearance = h.min || 0; name = h.name; } }
      if (clearance < 0) continue;
      const near = mask.filter((m) => touch(e.bbox, m.bbox, clearance + w)); if (!near.length) continue;
      const gaps = near.map((m) => elementGap(e, m));
      let hit = gaps.findIndex((g) => collides(g, clearance)); let actual = hit >= 0 ? gaps[hit] : 0;
      if (hit < 0) {
        // in the web between two openings narrower than the minimum width (the healed fill closes it)
        for (let i = 0; i < near.length && hit < 0; i++) for (let j = i + 1; j < near.length; j++) {
          if (gaps[i] >= w / 2 + clearance || gaps[j] >= w / 2 + clearance) continue;
          if (elementGap(near[i], near[j]) < w - EPS) { hit = i; actual = 0; break; }
        }
      }
      if (hit < 0) continue;
      const [x, y] = centre(e.bbox, near[hit].bbox);
      out.push(marker("silk_over_copper", defaultSeverity("silk_over_copper"), x, y, "Silkscreen clipped by solder mask" + detail(name, clearance, actual), [e.id]));
    }
  }
  return out;
}

/** FOOTPRINT::MapPadNumbersToNetTieGroups: pad number → group index. */
function netTieGroups(fp: KItem | null): Map<string, number> {
  const m = new Map<string, number>(); if (!fp) return m; const g = K.kid(fp.node, "net_tie_pad_groups"); if (!g) return m;
  g.slice(1).forEach((grp, i) => { for (const n of K.str(grp).split(/[\s,]+/).filter(Boolean)) m.set(n, i); });
  return m;
}
const fpAllowsBridges = (fp: KItem | null) => { if (!fp) return false; const a = K.kid(fp.node, "attr"); return !!a && a.slice(1).some((x) => K.str(x) === "allow_soldermask_bridges"); };
/** The nets of the pads tied to this item's pad in its net-tie footprint (FOOTPRINT::GetNetTieCache). */
function netTieNets(e: DrcElement, els: DrcElement[]): Set<string> | null {
  const groups = netTieGroups(e.fp); if (!groups.size) return null;
  const out = new Set<string>(); const g = e.pad ? groups.get(e.pad.number) : undefined;
  for (const o of els) if (o.fp === e.fp && o.pad && o.net && (g === undefined || groups.get(o.pad.number) === g)) out.add(o.net);
  return out;
}
const isMaskAperture = (e: DrcElement) => e.mask.size > 0 && e.copper.size === 0;
const sameLogicalPad = (a: DrcElement, b: DrcElement) => !!a.pad && !!b.pad && a.fp === b.fp && a.pad.number !== "" && a.pad.number === b.pad.number;
const sharesNetTie = (a: DrcElement, b: DrcElement) => { if (!a.pad || !b.pad || a.fp !== b.fp) return false; const g = netTieGroups(a.fp); const x = g.get(a.pad.number), y = g.get(b.pad.number); return x !== undefined && x === y; };

/** testMaskBridges: openings closer than the web width, and copper of another net under an opening. */
export function maskBridgeMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[], ms = maskSetup(doc, s), pool?: DrcElement[] | null): DrcMarker[] {
  const out: DrcMarker[] = [];
  const els = elementsOn(doc, s, new Set(["F.Mask", "B.Mask", "F.Cu", "B.Cu"]), ms, pool).filter((e) => e.kind !== "zone");
  const zones = conductors(doc as never).filter((c) => c.kind === "zone");
  const mtc = typeof s.maskToCopperClearance === "number" ? s.maskToCopperClearance as number : 0;
  const ignored = (e: DrcElement, layer: string) => rules.length > 0 && (evalRuleConstraint(rules, "bridged_mask", doc as never, s, ruleItem(e, layer), null) || { severity: null }).severity === "ignore";
  const checked = new Set<string>();
  interface Bridge { a: DrcElement; b: DrcElement; c: DrcElement | null; layer: string; pos: Pt; zoneId?: string }
  const bridges: Bridge[] = []; const apertures = new Map<DrcElement, { item: DrcElement | null; zone?: string; net: string; pos: Pt }[]>();
  const record = (ap: DrcElement, test: DrcElement | null, testLayer: string, net: string | null, pos: Pt, zone?: string) => {
    if (!net) return;
    if (testLayer === "F.Mask" && test && !test.copper.has("F.Cu")) return; if (testLayer === "B.Mask" && test && !test.copper.has("B.Cu")) return;
    if (fpAllowsBridges(ap.fp)) return;
    const l = apertures.get(ap); const v = { item: test, zone, net, pos }; if (l) l.push(v); else apertures.set(ap, [v]);
  };
  const checkItemMask = (e: DrcElement, testNet: string | null) => {
    if (e.fp) {
      if (fpAllowsBridges(e.fp)) return false;
      if (e.pad) { const nets = netTieNets(e, els); if (nets && netTieGroups(e.fp).has(e.pad.number)) { if (testNet === null) return false; if (nets.has(testNet)) return false; } }
    }
    return true;
  };
  const filterOk = (a: DrcElement, b: DrcElement, targetLayer: string) => {
    if (b.net && b.net === a.net) return false;
    if (b.npthNoCopper) return false;
    if (a.fp && a.fp === b.fp && (ms.allowBridgesInFps || fpAllowsBridges(a.fp))) return false;
    if (sameLogicalPad(a, b) || sharesNetTie(a, b)) return false;
    const ta = netTieNets(a, els); if (ta && (b.net === null || ta.has(b.net))) return false;
    const tb = netTieNets(b, els); if (tb && (a.net === null || tb.has(a.net))) return false;
    const key = (a.uuid < b.uuid ? a.uuid + "|" + b.uuid : b.uuid + "|" + a.uuid) + "|" + targetLayer;
    if (checked.has(key)) return false; checked.add(key); return true;
  };
  const byLayer = new Map<string, (b: Box, slop: number) => DrcElement[]>();
  for (const l of ["F.Mask", "B.Mask"]) byLayer.set(l, elementGrid(els.filter((e) => e.layer === l)));
  const maxGrow = Math.max(0, ...els.map((e) => e.grow));
  const test = (item: DrcElement, refLayer: string, targetLayer: string) => {
    const clearance = /\.Mask$/.test(refLayer) ? ms.webWidth : mtc;
    for (const other of byLayer.get(targetLayer)!(item.bbox, clearance + 2 * maxGrow)) {
      if (other === item || other.layer !== targetLayer || other.uuid === item.uuid) continue;
      if (!touch(item.bbox, other.bbox, clearance + Math.max(0, item.grow) + Math.max(0, other.grow))) continue;
      if (!filterOk(item, other, targetLayer)) continue;
      const gap = elementGap(item, other); if (!collides(gap, clearance) && !(clearance > 0 && gap <= EPS && gap >= -EPS)) continue;
      if ((isMaskAperture(item) && ignored(item, refLayer)) || (isMaskAperture(other) && ignored(other, targetLayer)) || (ignored(item, refLayer) && ignored(other, targetLayer))) continue;
      const pos = centre(item.bbox, other.bbox);
      if (isMaskAperture(item)) record(item, other, refLayer, other.net, pos);
      else if (isMaskAperture(other)) record(other, item, refLayer, item.net, pos);
      else if (checkItemMask(other, item.net)) bridges.push({ a: item, b: other, c: null, layer: targetLayer, pos });
    }
  };
  const zoneIdx = new Map<object, ReturnType<typeof polyIndex>>();
  const testZones = (item: DrcElement, maskLayer: string, cuLayer: string) => {
    for (const z of zones) {
      if (!z.layers.has(cuLayer)) continue; if (item.net !== null && z.net === item.net && z.net) continue;
      const zb = z.bbox; if (!touch(item.bbox, zb, mtc)) continue;
      const zel: DrcElement = { id: z.id, uuid: z.id + ":" + cuLayer, kind: "zone", node: z.item.node, fp: null, layer: cuLayer, shapes: [z.shape], grow: 0, bbox: zb, net: z.net, copper: new Set([cuLayer]), mask: new Set() };
      let idx = zoneIdx.get(z); if (!idx) { idx = polyIndex((z.shape as { pts: Pt[] }).pts); zoneIdx.set(z, idx); }
      const gap = idx(item, mtc + EPS); if (!collides(gap, mtc)) continue;
      const pos = centre(item.bbox, zb);
      if (isMaskAperture(item)) record(item, zel, maskLayer, z.net, pos, z.id);
      else bridges.push({ a: item, b: zel, c: null, layer: cuLayer, pos });
    }
  };
  const seenItems = new Set<string>();
  for (const e of els) {
    // one pass per item and side, as testMaskBridges walks the items
    for (const [mask, cu] of [["F.Mask", "F.Cu"], ["B.Mask", "B.Cu"]]) {
      const k = e.uuid + "|" + mask; if (seenItems.has(k)) continue;
      if (e.layer === mask && !e.npthNoCopper) { seenItems.add(k); test(e, mask, mask); testZones(e, mask, cu); }
      else if (e.layer === cu && !e.mask.has(mask)) { seenItems.add(k); test(e, cu, mask); }
    }
  }
  // reportMaskApertureBridges: the first net an aperture exposes is the reference; another net bridges it
  for (const [ap, items] of [...apertures.entries()].sort((x, y) => (x[0].uuid < y[0].uuid ? -1 : 1))) {
    items.sort((x, y) => { const ux = x.item ? x.item.uuid : x.zone || "", uy = y.item ? y.item.uuid : y.zone || ""; return ux < uy ? -1 : ux > uy ? 1 : x.net < y.net ? -1 : 1; });
    const ref = items.find((x) => x.net); if (!ref) continue;
    const done = new Set<string>(); const maskLayer = ap.layer;
    const excluded = (x: DrcElement | null, y: DrcElement | null) => {
      if (!ap.fp || !y || y.fp !== ap.fp || !x) return false;
      if (x.pad && y.pad) return sameLogicalPad(x, y) || sharesNetTie(x, y);
      const g = netTieGroups(ap.fp);
      if (x.pad && /^fp_/.test(y.kind)) return g.has(x.pad.number); if (y.pad && /^fp_/.test(x.kind)) return g.has(y.pad.number);
      return false;
    };
    for (const col of items) {
      if (col.net === ref.net) continue; if (excluded(ref.item, col.item)) continue;
      let track = false;
      for (const ent of items) {
        if (ent.net === col.net) continue; if (excluded(ent.item, col.item)) continue;
        const isTrack = !!ent.item && (ent.item.kind === "segment" || ent.item.kind === "arc"); if (isTrack && track) continue;
        const ka = ent.item ? ent.item.uuid : ent.zone!, kb = col.item ? col.item.uuid : col.zone!; const key = ka < kb ? ka + "|" + kb : kb + "|" + ka; if (done.has(key)) continue; done.add(key);
        bridges.push({ a: ap, b: ent.item!, c: col.item, layer: maskLayer, pos: col.pos, zoneId: ent.item ? undefined : ent.zone });
        if (isTrack) track = true;
      }
    }
  }
  const front = "Front solder mask aperture bridges items with different nets", back = "Rear solder mask aperture bridges items with different nets";
  const keys = new Set<string>();
  for (const b of bridges) {
    const ids = [b.a.id, b.b ? b.b.id : b.zoneId || "", b.c ? b.c.id : ""].filter(Boolean);
    const key = [b.layer, b.a.uuid, b.b ? b.b.uuid : b.zoneId, b.c ? b.c.uuid : ""].join("|"); if (keys.has(key)) continue; keys.add(key);
    const m = marker("solder_mask_bridge", defaultSeverity("solder_mask_bridge"), b.pos[0], b.pos[1], /^F\./.test(b.layer) ? front : back, Array.from(new Set(ids)));
    (m as DrcMarker & { message?: boolean }).message = true;   // SetErrorMessage: the text replaces the title
    out.push(m);
  }
  return out;
}

/** The silk and solder mask providers as one pass. */
export function silkMaskMarkers(doc: KDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const ms = maskSetup(doc, s); const pool = boardElements(doc, s, new Set(["F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Cu", "B.Cu"]), ms);
  return [...silkToMaskMarkers(doc, s, rules, ms, pool), ...maskBridgeMarkers(doc, s, rules, ms, pool), ...silkClearanceMarkers(doc, s, rules, ms, pool), ...silkEdgeMarkers(doc, s, rules, ms, pool)];
}
