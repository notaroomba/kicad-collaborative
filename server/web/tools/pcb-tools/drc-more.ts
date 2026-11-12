// pcb-tools/drc-more.ts — the DRC test providers beyond drc()'s first subset: hole to hole
// (DRC_TEST_PROVIDER_HOLE_TO_HOLE), text dimensions (DRC_TEST_PROVIDER_TEXT_DIMS), text mirroring
// (DRC_TEST_PROVIDER_TEXT_MIRRORING), courtyard definitions and holes inside other footprints' courtyards
// (DRC_TEST_PROVIDER_COURTYARD_CLEARANCE), text on Edge.Cuts and keepout areas (DRC_TEST_PROVIDER_DISALLOW) and items
// on disabled copper layers (DRC_TEST_PROVIDER_MISC::testDisabledLayers).  Codes, titles and default severities are
// canvas/drc-items.ts's; the details are the providers' formatMsg texts.  Lengths are in mm.
import type { BoardDoc, CopperShape, DesignSettings, DrcMarker, PadInfo, Pt } from "./types";
import { pointInPoly } from "./hit";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { arcPoints, boxesTouch, coreDist, padShape, shapeBBox, shapeGap, shapeOffset } from "./distances";
import { chainLoops, marker, mm4 } from "./drc";
import type { DruRule, RuleHit } from "./dru";
import { evalRuleConstraint } from "./dru";
import { zoneLayers } from "./nodes";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { DRC_EPS } from "./transforms";
import { isList, layerOf, pt, rotator } from "./util";

/** BOARD_DESIGN_SETTINGS' constructor: m_HoleToHoleMin, m_MinSilkTextHeight, m_MinSilkTextThickness. */
export const MORE_DEFAULTS = { minHoleToHole: 0.25, minTextHeight: 0.8, minTextThickness: 0.08 };
const defaultSeverity = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];

type Tf = (x: number, y: number) => Pt;
const ident: Tf = (x, y) => [x, y];
function fpTf(fp: KItem): Tf { const [fx, fy, frot] = K.atOf(fp.node); const R = rotator(frot); return (x, y) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; }; }
const kindOf = (n: SNode) => String(n[0]);

// ---------------------------------------------------------------- holes
/** A drilled hole as PAD / PCB_VIA::GetEffectiveHoleShape: a segment between the slot ends and its width. */
interface Hole { id: string; kind: "pad" | "via"; a: Pt; b: Pt; w: number; layers: Set<string> | null; micro: boolean; pad?: PadInfo; fp?: KItem; uuid: string }
function padHole(fp: KItem, p: PadInfo): Hole | null {
  if (p.type !== "thru_hole" && p.type !== "np_thru_hole") return null;
  const d = K.kid(p.node, "drill"); if (!d) return null;
  let w: number, h: number;
  if (K.str(d[1]) === "oval") { w = K.num(d[2], 0); h = K.num(d[3], w); } else { w = h = K.num(d[1], 0); }
  if (!(w > 0) || !(h > 0)) return null;
  const half = Math.abs(w - h) / 2; const [dx, dy] = rotator(p.rot)(w >= h ? half : 0, w >= h ? 0 : half);
  return { id: fp.id, kind: "pad", a: [p.x - dx, p.y - dy], b: [p.x + dx, p.y + dy], w: Math.min(w, h), layers: null, micro: false, pad: p, fp, uuid: K.uuidOf(p.node) || fp.id + ":" + p.index };
}
function viaHole(it: KItem): Hole | null {
  const a = pt(it.node, "at"); if (!a) return null; const d = K.kid(it.node, "drill"); const w = d ? K.num(d[1], 0) : 0; if (!(w > 0)) return null;
  const ls = K.kid(it.node, "layers"); const pair = ls ? [K.str(ls[1]), K.str(ls[2])] : ["F.Cu", "B.Cu"];
  const typed = it.node.includes("blind") || it.node.includes("micro") || it.node.includes("buried");
  return { id: it.id, kind: "via", a, b: a, w, layers: typed ? new Set(pair) : null, micro: it.node.includes("micro"), uuid: it.id };
}
const holeShape = (h: Hole): CopperShape => ({ t: "seg", a: h.a, b: h.b, r: h.w / 2 });
const holeCentre = (h: Hole): Pt => [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2];
/** The copper layers a via spans, in stack order (PCB_VIA::GetLayerSet for a blind / buried / micro via). */
function viaSpan(doc: BoardDoc, h: Hole) {
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; if (!h.layers) return new Set(copper);
  const [x, y] = [...h.layers].map((l) => copper.indexOf(l)); const lo = Math.min(x, y), hi = Math.max(x, y);
  return new Set(copper.filter((_, i) => i >= lo && i <= hi));
}
function boardHoles(doc: BoardDoc) {
  const out: Hole[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "via") { const h = viaHole(it); if (h) out.push(h); }
    else if (it.kind === "footprint") for (const p of padsOf(it)) { const h = padHole(it, p); if (h) out.push(h); }
  }
  return out;
}

type RuleOf = (type: string, A: { kind: string; node: SNode; layer?: string }, B: { kind: string; node: SNode; layer?: string } | null) => RuleHit | null;

/** DRC_TEST_PROVIDER_HOLE_TO_HOLE: co-located holes, then holes closer than the hole to hole constraint. */
export function holeToHoleMarkers(doc: BoardDoc, s: DesignSettings, ruleOf: RuleOf, worstRule = 0): DrcMarker[] {
  const out: DrcMarker[] = []; const holes = boardHoles(doc); const min0 = typeof s.minHoleToHole === "number" ? s.minHoleToHole : MORE_DEFAULTS.minHoleToHole;
  const seen = new Set<string>(); const box = (h: Hole) => shapeBBox(holeShape(h));
  const ri = (h: Hole) => ({ kind: h.kind, node: h.kind === "pad" ? h.pad!.node : (doc.items.get(h.id) as KItem).node, layer: "" });
  const test = (a: Hole, b: Hole) => {
    if (a.kind === "via" && b.kind === "via") { const sa = viaSpan(doc, a), sb = viaSpan(doc, b); if (![...sa].some((l) => sb.has(l))) return; }
    const ca = holeCentre(a), cb = holeCentre(b); const [p, q] = a.uuid > b.uuid ? [b, a] : [a, b];
    if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < DRC_EPS) { out.push(marker("holes_co_located", defaultSeverity("holes_co_located"), ca[0], ca[1], "Drilled holes co-located", [p.id, q.id])); return; }
    const actual = Math.max(0, coreDist(holeShape(a), holeShape(b)) - a.w / 2 - b.w / 2);
    const hit = ruleOf("hole_to_hole", ri(a), ri(b)); if (hit && hit.severity === "ignore") return;
    const min = hit && hit.min != null ? hit.min : min0, name = hit ? hit.name : "board setup constraints";
    if (min >= 0 && actual < Math.max(0, min - DRC_EPS)) out.push(marker("hole_to_hole", defaultSeverity("hole_to_hole"), ca[0], ca[1], `Drilled hole too close to other hole (${name} min ${mm4(min)}; actual ${mm4(actual)})`, [p.id, q.id]));
  };
  const reach = Math.max(min0, worstRule, 0.01); const boxes = holes.map(box);   // QueryWorstConstraint( HOLE_TO_HOLE_CONSTRAINT )
  // the via pass (microvias are laser-drilled and only collided with), then the pad pass; one test per pair
  const order = holes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]); const rank = new Int32Array(holes.length); order.forEach((h, k) => { rank[h] = k; });
  const query = (i: number) => {
    const near: number[] = [];   // the holes whose x range reaches this one's, from the sorted order both ways
    for (let k = rank[i] - 1; k >= 0; k--) { const j = order[k]; if (boxes[j][0] < boxes[i][0] - 30) break; near.push(j); }
    for (let k = rank[i] + 1; k < order.length; k++) { const j = order[k]; if (boxes[j][0] > boxes[i][2] + reach) break; near.push(j); }
    for (const j of near) {
      if (!boxesTouch(boxes[i], boxes[j], reach)) continue;
      const key = i < j ? i + ":" + j : j + ":" + i; if (seen.has(key)) continue; seen.add(key); test(holes[i], holes[j]);
    }
  };
  holes.forEach((h, i) => { if (h.kind === "via" && !h.micro) query(i); });
  holes.forEach((h, i) => { if (h.kind === "pad") query(i); });
  return out;
}

// ---------------------------------------------------------------- texts
/** One EDA_TEXT on the board: a board text, text box, dimension text or a footprint field / text / text box. */
interface TextItem { id: string; node: SNode; kind: string; layer: string; pos: Pt; fp?: KItem }
function boardTexts(doc: BoardDoc): TextItem[] {
  const out: TextItem[] = [];
  const take = (n: SNode, id: string, tf: Tf, fp?: KItem, layer?: string) => {
    const k = kindOf(n); const at = pt(n, k.endsWith("text_box") ? "start" : "at") || (k.endsWith("text_box") ? K.ptsOf(n)[0] : null) || [0, 0];
    out.push({ id, node: n, kind: k, layer: layer || layerOf(n, "F.SilkS"), pos: tf(at[0], at[1]), fp });
  };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "gr_text" || it.kind === "gr_text_box") take(n, it.id, ident);
    else if (it.kind === "dimension") { const t = K.kid(n, "gr_text"); if (t) take(t, it.id, ident, undefined, layerOf(n, "Dwgs.User")); }
    else if (it.kind === "footprint") {
      const tf = fpTf(it);
      for (const g of n) if (isList(g) && (g[0] === "property" || g[0] === "fp_text" || g[0] === "fp_text_box") && K.kid(g, "layer")) take(g, it.id, tf, it);
    }
  }
  return out;
}
/** EDA_TEXT::GetEffectiveTextPenWidth: the stored thickness (bold stroke text 1.6 ×) or the size's default, clamped. */
export function effectivePenWidth(n: SNode, boardVersion: number) {
  const ef = K.effectsOf(n); const minSize = Math.min(Math.abs(ef.size), Math.abs(ef.sizeX));
  let w: number;
  if (ef.thick <= 1e-6) w = ef.bold ? ef.sizeX / 5 : ef.sizeX / 8;
  else if (ef.bold && !ef.face) w = boardVersion > 0 && boardVersion < 20260826 ? ef.thick : ef.thick * 1.6;   // older files stored the bold width
  else w = ef.thick;
  return Math.min(w, minSize * 0.25);   // ClampTextPenSize
}
/** DRC_TEST_PROVIDER_TEXT_DIMS: visible texts against the silk text height / thickness minimums and text rules. */
export function textDimsMarkers(doc: BoardDoc, s: DesignSettings, ruleOf: RuleOf): DrcMarker[] {
  const out: DrcMarker[] = [];
  const minH = typeof s.minTextHeight === "number" ? s.minTextHeight : MORE_DEFAULTS.minTextHeight, minT = typeof s.minTextThickness === "number" ? s.minTextThickness : MORE_DEFAULTS.minTextThickness;
  for (const t of boardTexts(doc)) {
    const ef = K.effectsOf(t.node); if (ef.hide) continue;
    const silk = t.layer === "F.SilkS" || t.layer === "B.SilkS"; const A = { kind: t.kind, node: t.node, layer: t.layer };
    const check = (type: "text_height" | "text_thickness", implicit: number, implicitName: string, actual: number, what: string) => {
      const hit = ruleOf(type, A, null); if (hit && hit.severity === "ignore") return;
      const min = hit ? hit.min : silk ? implicit : null, max = hit ? hit.max : null, name = hit ? hit.name : implicitName;
      if (min != null && min > 0 && actual < min - 1e-9) out.push(marker(type, defaultSeverity(type), t.pos[0], t.pos[1], `${type === "text_height" ? "Text height out of range" : "Text thickness out of range"} (${name} min ${what} ${mm4(min)}; actual ${mm4(actual)})`, [t.id]));
      if (max != null && actual > max + 1e-9) out.push(marker(type, defaultSeverity(type), t.pos[0], t.pos[1], `${type === "text_height" ? "Text height out of range" : "Text thickness out of range"} (${name} max ${what} ${mm4(max)}; actual ${mm4(actual)})`, [t.id]));
    };
    // an outline (TrueType) font's stroke weight is the glyphs' business; its thickness is not checked here
    if (!ef.face) check("text_thickness", minT, "board setup constraints silk text thickness", effectivePenWidth(t.node, (doc as { version?: number }).version || 0), "thickness");
    check("text_height", minH, "board setup constraints silk text height", Math.abs(ef.size), "height");
  }
  return out;
}
/** DRC_TEST_PROVIDER_TEXT_MIRRORING: mirrored text on a front layer, unmirrored text on a back layer. */
export function textMirroringMarkers(doc: BoardDoc): DrcMarker[] {
  const out: DrcMarker[] = []; const top = new Set(["F.Cu", "F.SilkS", "F.Mask", "F.Fab"]), bottom = new Set(["B.Cu", "B.SilkS", "B.Mask", "B.Fab"]);
  for (const t of boardTexts(doc)) {
    if (!top.has(t.layer) && !bottom.has(t.layer)) continue; if (doc.layers.size && !doc.layers.has(t.layer)) continue;
    const ef = K.effectsOf(t.node); if (ef.hide) continue;
    if (ef.mirror && top.has(t.layer)) out.push(marker("mirrored_text_on_front_layer", defaultSeverity("mirrored_text_on_front_layer"), t.pos[0], t.pos[1], "Mirrored text on front layer", [t.id]));
    if (!ef.mirror && bottom.has(t.layer)) out.push(marker("nonmirrored_text_on_back_layer", defaultSeverity("nonmirrored_text_on_back_layer"), t.pos[0], t.pos[1], "Non-Mirrored text on back layer", [t.id]));
  }
  return out;
}

// ---------------------------------------------------------------- courtyards
/** FOOTPRINT::BuildCourtyardCaches: the F.CrtYd / B.CrtYd outlines chained at 0.02 mm, and where a chain stays open. */
export function courtyardOutlines(fp: KItem) {
  const tf = fpTf(fp); const chains: Record<string, Pt[][]> = { "F.CrtYd": [], "B.CrtYd": [] };
  for (const g of fp.node) {
    if (!isList(g) || !/^fp_(line|rect|circle|arc|poly)$/.test(g[0] as string)) continue; const layer = layerOf(g, ""); if (!chains[layer]) continue;
    const kind = (g[0] as string).slice(3); const P = (key: string) => { const p = pt(g, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) chains[layer].push([a, b]); }
    else if (kind === "rect") { const s0 = pt(g, "start"), e = pt(g, "end"); if (s0 && e) { const pts = [tf(s0[0], s0[1]), tf(e[0], s0[1]), tf(e[0], e[1]), tf(s0[0], e[1])]; chains[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i < 32; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); chains[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); chains[layer].push(arc ? arcPoints(arc, a, b) : [a, b]); } }
    else if (kind === "poly") { const pts = K.ptsOf(g).map(([x, y]) => tf(x, y)); if (pts.length > 2) chains[layer].push(pts.concat([pts[0]])); }
  }
  const res: Record<string, { loops: Pt[][]; open: Pt | null }> = {};
  for (const layer of Object.keys(chains)) {
    if (!chains[layer].length) { res[layer] = { loops: [], open: null }; continue; }
    const { loops, dangling } = chainLoops(chains[layer], 0.02); let open: Pt | null = null;
    if (dangling) {   // the free end nearest another free end: where ConvertOutlineToPolygon gives up
      const ends: Pt[] = []; for (const c of chains[layer]) { const a = c[0], b = c[c.length - 1]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.02) ends.push(a, b); }
      const free = ends.filter((e) => ends.filter((o) => Math.hypot(o[0] - e[0], o[1] - e[1]) <= 0.02).length < 2); open = free[0] || ends[0] || chains[layer][0][0];
    }
    res[layer] = { loops, open };
  }
  return res;
}
const allowsMissingCourtyard = (fp: KItem) => { const a = K.kid(fp.node, "attr"); return !!a && a.slice(1).some((x) => K.str(x) === "allow_missing_courtyard"); };
/** DRC_TEST_PROVIDER_COURTYARD_CLEARANCE: malformed and missing courtyards, then holes inside other footprints' courtyards. */
export function courtyardMarkers(doc: BoardDoc): DrcMarker[] {
  const out: DrcMarker[] = []; const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cy = fps.map((fp) => courtyardOutlines(fp));
  fps.forEach((fp, i) => {
    const c = cy[i]; const bad = ["F.CrtYd", "B.CrtYd"].map((l) => c[l].open).find((p) => p);
    const [fx, fy] = K.atOf(fp.node);
    if (bad) out.push(marker("malformed_courtyard", defaultSeverity("malformed_courtyard"), bad[0], bad[1], "Footprint has malformed courtyard (not a closed shape)", [fp.id]));
    else if (!c["F.CrtYd"].loops.length && !c["B.CrtYd"].loops.length && !allowsMissingCourtyard(fp)) out.push(marker("missing_courtyard", defaultSeverity("missing_courtyard"), fx, fy, "Footprint has no courtyard defined", [fp.id]));
  });
  const holes = fps.map((fp) => padsOf(fp).map((p) => ({ p, h: padHole(fp, p) })).filter((x) => x.h && !/heatsink/.test(String((K.kid(x.p.node, "property") || [])[1] || ""))));
  const hitIn = (h: Hole, loops: Pt[][]) => loops.some((L) => shapeGap({ t: "poly", pts: L }, holeShape(h)) <= 0);
  const testPads = (bi: number, ai: number) => {
    for (const { p, h } of holes[bi]) {
      const code = p.type === "np_thru_hole" ? "npth_inside_courtyard" : "pth_inside_courtyard";
      if (hitIn(h!, cy[ai]["F.CrtYd"].loops) || hitIn(h!, cy[ai]["B.CrtYd"].loops)) out.push(marker(code, defaultSeverity(code), p.x, p.y, code === "pth_inside_courtyard" ? "PTH inside courtyard" : "NPTH inside courtyard", [fps[bi].id, fps[ai].id]));
    }
  };
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
    if (fps[i].bbox && fps[j].bbox && !boxesTouch(fps[i].bbox!, fps[j].bbox!, 0)) continue;
    testPads(j, i); testPads(i, j);
  }
  return out;
}

// ---------------------------------------------------------------- disallow and misc
const EDGE_TEXT = new Set(["gr_text", "gr_text_box", "table", "barcode", "dimension"]);
/** DRC_TEST_PROVIDER_DISALLOW's text check: text, text boxes, tables, barcodes and dimensions drawn on Edge.Cuts. */
export function textOnEdgeCutsMarkers(doc: BoardDoc): DrcMarker[] {
  const out: DrcMarker[] = []; const sev = defaultSeverity("text_on_edge_cuts");
  for (const it of doc.items.values()) {
    if (EDGE_TEXT.has(it.kind) && layerOf(it.node, "") === "Edge.Cuts") { const p = pt(it.node, "at") || pt(it.node, "start") || (it.bbox ? [it.bbox[0], it.bbox[1]] : [0, 0]); out.push(marker("text_on_edge_cuts", sev, p[0], p[1], "Text or graphic on Edge.Cuts layer", [it.id])); }
  }
  for (const t of boardTexts(doc)) if (t.fp && t.layer === "Edge.Cuts") out.push(marker("text_on_edge_cuts", sev, t.pos[0], t.pos[1], "Text or graphic on Edge.Cuts layer", [t.id]));
  return out;
}

interface Keepout { id: string; name: string; layers: Set<string>; pts: Pt[]; fp: KItem | null; tracks: boolean; vias: boolean; pads: boolean }
function keepouts(doc: BoardDoc): Keepout[] {
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const out: Keepout[] = [];
  const take = (z: SNode, id: string, tf: Tf, fp: KItem | null) => {
    const ko = K.kid(z, "keepout"); if (!ko) return; const no = (k: string) => { const c = K.kid(ko, k); return !!c && K.str(c[1]) === "not_allowed"; };
    const poly = K.kid(z, "polygon"); const pts = poly ? K.ptsOf(poly).map(([x, y]) => tf(x, y)) : []; if (pts.length < 3) return;
    const layers = new Set<string>(); for (const l of zoneLayers(z)) { if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => layers.add(c)); else layers.add(l); }
    const nm = K.kid(z, "name"); out.push({ id, name: nm ? K.str(nm[1]) : "", layers, pts, fp, tracks: no("tracks"), vias: no("vias"), pads: no("pads") });
  };
  for (const it of doc.items.values()) {
    if (it.kind === "zone") take(it.node, it.id, ident, null);
    else if (it.kind === "footprint") { const tf = fpTf(it); for (const g of it.node) if (isList(g) && g[0] === "zone") take(g, it.id, tf, it); }
  }
  return out;
}
/** DRC_ENGINE's implicit keepout rule names: keepout area, keepout area 'name', … of R1. */
function keepoutRuleName(k: Keepout) {
  const ref = k.fp ? k.fp.ref || "" : "";
  if (k.name) return ref ? `keepout area '${k.name}' of ${ref}` : `keepout area '${k.name}'`;
  return ref ? `keepout area of ${ref}` : "keepout area";
}
/** Does a shape's core reach strictly inside a polygon (more than its outline)? */
function pointInPolyShape(shape: CopperShape, P: Pt[]) {
  const probe: Pt[] = shape.t === "circle" ? [[shape.x, shape.y]] : shape.t === "rect" ? [[shape.x, shape.y]] : shape.t === "seg" ? [shape.a, shape.b, [(shape.a[0] + shape.b[0]) / 2, (shape.a[1] + shape.b[1]) / 2]] : shape.t === "path" ? shape.pts.concat(shape.pts.slice(1).map((p, i) => [(p[0] + shape.pts[i][0]) / 2, (p[1] + shape.pts[i][1]) / 2] as Pt)) : shape.pts;
  return probe.some((p) => pointInPoly(P, p[0], p[1]) && polyEdgeDist(P, p) > DRC_EPS);
}
const polyEdgeDist = (P: Pt[], p: Pt) => { let d = Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)); } return d; };
/** DRC_TEST_PROVIDER_DISALLOW for rule areas: tracks, vias and pads inside a keepout that does not allow them. */
export function keepoutMarkers(doc: BoardDoc): DrcMarker[] {
  const out: DrcMarker[] = []; const kos = keepouts(doc); if (!kos.length) return out; const sev = defaultSeverity("items_not_allowed");
  const boxes = kos.map((k) => shapeBBox({ t: "poly", pts: k.pts }));
  // a shape that only touches the area's edge stays outside (the router keeps tracks exactly there)
  const hits = (shape: CopperShape, i: number) => { if (!boxesTouch(shapeBBox(shape), boxes[i], 0)) return false; const core = coreDist({ t: "poly", pts: kos[i].pts }, shape); return core === 0 && pointInPolyShape(shape, kos[i].pts) || core < shapeOffset(shape) - DRC_EPS; };
  const firstInside = (shape: CopperShape, pts: Pt[], P: Pt[]) => pts.find((p) => pointInPoly(P, p[0], p[1])) || (shape.t === "seg" ? shape.a : pts[0]);
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "segment" || it.kind === "arc") {
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue; const layer = layerOf(n); const w = K.num((K.kid(n, "width") || [0, 0.25])[1], 0.25);
      let pts: Pt[] = [a, b]; if (it.kind === "arc") { const m = pt(n, "mid"); const arc = m && K.arcFrom3(a, m, b); if (arc) pts = arcPoints(arc, a, b); }
      const shape: CopperShape = { t: "path", pts, r: w / 2 };
      kos.forEach((k, i) => { if (k.tracks && k.layers.has(layer) && hits(shape, i)) { const p = firstInside(shape, pts, k.pts); out.push(marker("items_not_allowed", sev, p[0], p[1], `Items not allowed (${keepoutRuleName(k)})`, [it.id])); } });
    } else if (it.kind === "via") {
      const a = pt(n, "at"); if (!a) continue; const size = K.num((K.kid(n, "size") || [0, 0.6])[1], 0.6); const span = viaSpan(doc, viaHole(it) || { layers: null } as Hole);
      const shape: CopperShape = { t: "circle", x: a[0], y: a[1], r: size / 2 };
      kos.forEach((k, i) => { if (k.vias && [...span].some((l) => k.layers.has(l)) && hits(shape, i)) out.push(marker("items_not_allowed", sev, a[0], a[1], `Items not allowed (${keepoutRuleName(k)})`, [it.id])); });
    } else if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        const shape = padShape(p); const layers = new Set<string>(); for (const l of p.layers) { if (l === "*.Cu" || l === "F&B.Cu") (doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]).forEach((c) => layers.add(c)); else layers.add(l); }
        kos.forEach((k, i) => { if (k.pads && k.fp !== it && [...layers].some((l) => k.layers.has(l)) && hits(shape, i)) out.push(marker("items_not_allowed", sev, p.x, p.y, `Items not allowed (${keepoutRuleName(k)})`, [it.id])); });
      }
    }
  }
  return out;
}
/** DRC_TEST_PROVIDER_MISC::testDisabledLayers: copper items on a copper layer the board does not enable. */
export function disabledLayerMarkers(doc: BoardDoc): DrcMarker[] {
  const out: DrcMarker[] = []; if (!doc.layers.size) return out; const sev = defaultSeverity("item_on_disabled_layer");
  const off = (l: string) => /\.Cu$/.test(l) && !doc.layers.has(l);
  const report = (id: string, p: Pt, l: string) => out.push(marker("item_on_disabled_layer", sev, p[0], p[1], `Item on a disabled copper layer (layer ${l})`, [id]));
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "via") { const ls = K.kid(n, "layers"); const pair = ls ? [K.str(ls[1]), K.str(ls[2])] : []; const bad = pair.find(off); const a = pt(n, "at"); if (bad && a) report(it.id, a, bad); }
    else if (it.kind === "footprint") {
      for (const p of padsOf(it)) { if (p.type !== "smd" && p.type !== "connect") continue; const l = p.layers.find((x) => /\.Cu$/.test(x) && x !== "*.Cu"); if (l && off(l)) report(it.id, [p.x, p.y], l); }
    } else if (it.kind !== "zone") {
      const l = layerOf(n, ""); if (!l || !off(l)) continue; const p = pt(n, "start") || pt(n, "at") || pt(n, "center") || (it.bbox ? [it.bbox[0], it.bbox[1]] : [0, 0]); report(it.id, p, l);
    }
  }
  return out;
}

/** The providers above as one pass, with the project's severities applied (ignored rules drop out). */
export function moreDrcMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const ruleOf: RuleOf = (type, A, B) => (rules.length ? evalRuleConstraint(rules, type, doc, s, A as never, B as never) : null);
  const all = [...disabledLayerMarkers(doc), ...courtyardMarkers(doc), ...holeToHoleMarkers(doc, s, ruleOf, Math.max(0, ...rules.flatMap((r) => r.constraints.filter((c) => c.type === "hole_to_hole").map((c) => c.min || 0)))), ...textOnEdgeCutsMarkers(doc), ...keepoutMarkers(doc), ...textDimsMarkers(doc, s, ruleOf), ...textMirroringMarkers(doc)];
  return all.filter((m) => (s.severities[m.code] || m.severity) !== "ignore");
}
