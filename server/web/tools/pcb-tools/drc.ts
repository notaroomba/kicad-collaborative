// pcb-tools/drc.ts — design settings and the DRC subset.
import type { Box, Conductor, CopperShape, DesignSettings, DesignSource, DrcMarker, NetclassRules, BoardDoc, PolyShape, Pt } from "./types";
import { arcPoints, boxesTouch, polysOverlap, shapeBBox, shapeGap, shareLayer } from "./distances";
import { pointInPoly } from "./hit";
import { netlist, ratsnest } from "./netlist";
import { K } from "./state";
import { DRC_EPS, EPS } from "./transforms";
import { isList, layerDefaults, layerOf, pt, r6, rotator, widthOf } from "./util";
import { evalRuleConstraint, parseDru, ruleClearance } from "./dru";
import { assertionMarkers, disallowMarkers, ruleItems, sizeMarkers, trackAngleMarkers } from "./drc-rules";
import type { DruRule } from "./dru";
import { moreDrcMarkers } from "./drc-more";
import { silkMaskMarkers } from "./drc-silk";

// ---------------------------------------------------------------- design settings and DRC
// BOARD_DESIGN_SETTINGS / NETCLASS defaults (board_design_settings.h, netclass.cpp): what a board without a
// project file is checked against.  Rules can come from the .kicad_pro (parsed JSON) or a legacy board's (setup).
export const DEFAULT_SETTINGS = (): DesignSettings => ({ clearance: 0.2, edgeClearance: 0.5, trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3, minTrackWidth: 0, minViaDiameter: 0, minViaDrill: 0, netclasses: { Default: { clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 } }, netclassOf: {}, patterns: [], severities: {} });
export function designSettings(src: string | DesignSource | DesignSettings | null | undefined): DesignSettings {
  const s = DEFAULT_SETTINGS(); if (!src) return s;
  if (typeof src === "string" && /^\s*\{/.test(src)) { try { src = JSON.parse(src) as DesignSource; } catch (e) { return s; } }   // the .kicad_pro as text (the editor's ctx.designSettings)
  if (typeof src === "string") {   // a legacy board's (setup … (net_class …)) block
    let tree: SNode | null = null; try { tree = K.parse(src); } catch (e) { return s; }
    const setup = tree && K.kid(tree, "setup"); if (setup) { for (const [key, prop] of [["clearance", "clearance"], ["trace_clearance", "clearance"], ["edge_clearance", "edgeClearance"], ["copper_edge_clearance", "edgeClearance"], ["trace_min", "minTrackWidth"], ["via_min_size", "minViaDiameter"], ["via_min_drill", "minViaDrill"], ["trace_width", "trackWidth"], ["via_size", "viaDiameter"], ["via_drill", "viaDrill"]]) { const c = K.kid(setup, key); if (c) s[prop] = K.num(c[1], s[prop] as number); } }
    for (const nc of (tree ? K.kids(tree, "net_class") : [])) { const name = K.str(nc[1]); const e = s.netclasses[name] = Object.assign({}, s.netclasses.Default); for (const [key, prop] of [["clearance", "clearance"], ["trace_width", "track_width"], ["via_dia", "via_diameter"], ["via_drill", "via_drill"]]) { const c = K.kid(nc, key); if (c) e[prop] = K.num(c[1]); } for (const a of K.kids(nc, "add_net")) s.netclassOf[K.str(a[1])] = name; }
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; }
    return s;
  }
  if (src.netclasses || src.clearance !== undefined) return Object.assign(s, src as DesignSettings);   // already our shape
  src = src as DesignSource;
  const rules = src.board && src.board.design_settings && src.board.design_settings.rules;   // a .kicad_pro
  const sev = src.board && src.board.design_settings && src.board.design_settings.rule_severities; if (sev) for (const [k, v] of Object.entries(sev)) s.severities[k] = String(v);
  if (rules) { s.minClearance = rules.min_clearance || 0; s.minTrackWidth = rules.min_track_width || 0; s.minViaDiameter = rules.min_via_diameter || 0; s.minViaDrill = rules.min_through_hole_diameter || 0; s.minViaAnnular = rules.min_via_annular_width || 0; s.minMicroViaDrill = rules.min_microvia_drill || 0; if (rules.min_hole_clearance !== undefined) s.holeClearance = rules.min_hole_clearance; if (rules.min_copper_edge_clearance !== undefined) s.edgeClearance = rules.min_copper_edge_clearance; if (rules.min_hole_to_hole !== undefined) s.minHoleToHole = rules.min_hole_to_hole; if (rules.min_text_height !== undefined) s.minTextHeight = rules.min_text_height; if (rules.min_text_thickness !== undefined) s.minTextThickness = rules.min_text_thickness; if (rules.min_silk_clearance !== undefined) s.minSilkClearance = rules.min_silk_clearance; if (rules.solder_mask_to_copper_clearance !== undefined) s.maskToCopperClearance = rules.solder_mask_to_copper_clearance; if (rules.min_resolved_spokes !== undefined) s.minResolvedSpokes = rules.min_resolved_spokes; }
  const dflt = src.board && src.board.design_settings && src.board.design_settings.defaults; if (dflt) layerDefaults(dflt);   // Board Setup > Text & Graphics > Defaults: what a new item gets
  const ns = src.net_settings;
  if (ns && isList(ns.classes)) {
    for (const c of ns.classes as (Partial<NetclassRules> & { name?: string } | null)[]) if (c && c.name) s.netclasses[c.name] = { clearance: c.clearance !== undefined ? c.clearance : s.clearance, track_width: c.track_width !== undefined ? c.track_width : s.trackWidth, via_diameter: c.via_diameter !== undefined ? c.via_diameter : s.viaDiameter, via_drill: c.via_drill !== undefined ? c.via_drill : s.viaDrill };
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; s.viaDiameter = s.netclasses.Default.via_diameter; s.viaDrill = s.netclasses.Default.via_drill; }
    if (ns.netclass_assignments) for (const [net, cls] of Object.entries(ns.netclass_assignments)) s.netclassOf[net] = cls;
    if (isList(ns.netclass_patterns)) for (const p of ns.netclass_patterns as ({ pattern?: string; netclass: string } | null)[]) if (p && p.pattern) s.patterns.push({ re: new RegExp("^" + String(p.pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"), netclass: p.netclass });
  }
  return s;
}
export function netclassName(s: DesignSettings, net: string | null | undefined) { const name = net ? (s.netclassOf[net] || (s.patterns.find((p) => p.re.test(net)) || { netclass: undefined }).netclass) : null; return name && s.netclasses[name] ? name : "Default"; }
export function netclassOf(s: DesignSettings, net: string | null | undefined): Partial<NetclassRules> { return s.netclasses[netclassName(s, net)] || s.netclasses.Default || { clearance: s.clearance, track_width: s.trackWidth, via_diameter: s.viaDiameter, via_drill: s.viaDrill }; }
export const netClearance = (s: DesignSettings, net: string | null | undefined): number => { const nc = netclassOf(s, net); return nc && nc.clearance !== undefined ? nc.clearance : s.clearance; };
export const mm4 = (v: number) => v.toFixed(4) + " mm";
/** Edge.Cuts geometry as shapes (lines with their half width) and the polylines they form, board items and footprint drawings alike. */
export function edgeShapes(doc: BoardDoc) {
  const shapes: CopperShape[] = [], chains: Pt[][] = [];
  const take = (kind: string, node: SNode, tf: (x: number, y: number) => Pt, layer: string) => {
    if (layer !== "Edge.Cuts") return; const w = K.kid(node, "stroke") ? K.num((K.kid(K.kid(node, "stroke")!, "width") || [0, 0])[1]) : widthOf(node, 0);
    const P = (key: string) => { const p = pt(node, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) { shapes.push({ t: "seg", a, b, r: w / 2 }); chains.push([a, b]); } }
    else if (kind === "rect") { const a = P("start"), b = P("end"); if (a && b) { const c = tf(pt(node, "start")![0], pt(node, "end")![1]), d = tf(pt(node, "end")![0], pt(node, "start")![1]); const pts = [a, d, b, c]; shapes.push({ t: "path", pts: pts.concat([a]), r: w / 2 }); chains.push(pts.concat([a])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i < 48; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 24), c[1] + r * Math.sin(i * Math.PI / 24)]); pts.push(pts[0].slice()); shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); const pts = arc ? arcPoints(arc, a, b) : [a, b]; shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "poly") { const pts = K.ptsOf(node).map(([x, y]) => tf(x, y)); if (pts.length > 2) { shapes.push({ t: "path", pts: pts.concat([pts[0]]), r: w / 2 }); chains.push(pts.concat([pts[0]])); } }
    else if (kind === "curve") { const pts = K.bezierPts(K.ptsOf(node).map(([x, y]) => tf(x, y))); if (pts.length > 1) { shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
  };
  const id = (x: number, y: number) => [x, y]; const ids: string[] = [];
  for (const it of doc.items.values()) {
    const n = it.node; const before = shapes.length;
    if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)) take(it.kind.slice(3), n, id, layerOf(n, "Dwgs.User"));
    else if (it.kind === "footprint") { const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x: number, y: number) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; }; for (const g of n) if (isList(g) && /^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0] as string)) take((g[0] as string).slice(3), g, tf, layerOf(g, "F.SilkS")); }
    for (let i = before; i < shapes.length; i++) ids.push(it.id);
  }
  return { shapes, chains, ids };
}
/** Join open polylines end to end (0.01 mm) into closed loops; returns the loops and whether anything stayed open. */
export function chainLoops(chains: Pt[][], tol?: number) {
  tol = tol || 0.01; const loops: Pt[][] = [], open = chains.map((c) => c.slice()); let dangling = false;
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol! && Math.abs(a[1] - b[1]) <= tol!;
  while (open.length) {
    let cur = open.pop()!; if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) { loops.push(cur.slice(0, -1)); continue; }
    let grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false; const tail = cur[cur.length - 1];
      for (let i = 0; i < open.length; i++) {
        const c = open[i]; if (same(c[0], tail)) { cur = cur.concat(c.slice(1)); open.splice(i, 1); grew = true; break; }
        if (same(c[c.length - 1], tail)) { cur = cur.concat(c.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
      }
    }
    if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) loops.push(cur.slice(0, -1)); else dangling = true;
  }
  return { loops, dangling };
}
export const polyArea = (pts: Pt[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
/** The board outline: the largest closed Edge.Cuts loop, or null (and whether edges exist that fail to close). */
export function boardOutline(doc: BoardDoc) {
  const { chains } = edgeShapes(doc); if (!chains.length) return { outline: null, dangling: false, hasEdges: false };
  const { loops, dangling } = chainLoops(chains); let best: Pt[] | null = null, bestA = 0;
  for (const l of loops) { const a = Math.abs(polyArea(l)); if (a > bestA) { bestA = a; best = l; } }
  return { outline: best, dangling, hasEdges: true, area: bestA };
}
/** A footprint's courtyard polygons per side, chained from its F.CrtYd / B.CrtYd drawings in board coordinates. */
export function courtyards(fp: KItem) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x: number, y: number) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
  const out: Record<string, Pt[][]> = { "F.CrtYd": [], "B.CrtYd": [] };
  for (const g of n) {
    if (!isList(g) || !/^fp_(line|rect|circle|arc|poly)$/.test(g[0] as string)) continue; const layer = layerOf(g, ""); if (!out[layer]) continue;
    const kind = (g[0] as string).slice(3); const P = (key: string) => { const p = pt(g, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) out[layer].push([a, b]); }
    else if (kind === "rect") { const s = pt(g, "start"), e = pt(g, "end"); if (s && e) { const pts = [tf(s[0], s[1]), tf(e[0], s[1]), tf(e[0], e[1]), tf(s[0], e[1])]; out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i < 32; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); out[layer].push(arc ? arcPoints(arc, a, b) : [a, b]); } }
    else if (kind === "poly") { const pts = K.ptsOf(g).map(([x, y]) => tf(x, y)); if (pts.length > 2) out[layer].push(pts.concat([pts[0]])); }
  }
  const res: Record<string, Pt[][]> = {}; for (const layer of Object.keys(out)) res[layer] = out[layer].length ? chainLoops(out[layer]).loops : [];
  return res;
}
/** SEG::Intersect: where two track centre lines cross (touching ends included), or null. */
export function segCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]]; const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / den, u = ((p3[0] - p1[0]) * d1[1] - (p3[1] - p1[1]) * d1[0]) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
export const marker = (code: string, severity: string, x: number, y: number, text: string, ids: string[]): DrcMarker => ({ code, severity, x: r6(x), y: r6(y), text, ids });
export const boxCenter = (a: Box, b: Box) => [(Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2, (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2];
/**
 * The DRC subset: copper clearance (pads, tracks, arcs, vias against different nets on a shared layer), copper to
 * board edge, missing connections (from the ratsnest), shorts, zero-length and dangling tracks, via annular
 * width, courtyard overlaps and items outside the outline.  Returns markers [{ x, y, severity, text, ids, code }].
 */
export function drc(doc: BoardDoc, settings: DesignSettings | DesignSource | string | null | undefined, opts?: { unconnected?: boolean; outline?: boolean; rules?: DruRule[] | string | null }) {
  const s = settings && (settings as DesignSettings).netclasses ? settings as DesignSettings : designSettings(settings); opts = opts || {}; const out: DrcMarker[] = [];
  const nl = netlist(doc); const conds = nl.conductors.filter((c) => c.kind !== "zone");
  const clr = (c: Conductor) => netClearance(s, c.net);
  // the custom rules' clearance constraints (.kicad_dru) take over from the netclass clearance where they match
  const rules = typeof opts.rules === "string" ? parseDru(opts.rules).rules : opts.rules || [];
  const clrRules = rules.filter((r) => r.constraints.some((k) => k.type === "clearance" && k.min != null));
  const ruleMax = Math.max(0, ...clrRules.map((r) => r.constraints.find((k) => k.type === "clearance")!.min || 0));
  const maxClr = Math.max(s.clearance, s.minClearance || 0, ...Object.values(s.netclasses).map((n) => n.clearance || 0), s.edgeClearance, ruleMax);
  const ruleItem = (c: Conductor, layer: string) => (c.kind === "pad" ? { kind: c.kind, node: c.pad.node, parent: c.item, layer, shape: c.shape } : { kind: c.kind, node: c.item.node, item: c.item, layer, shape: c.shape });
  // copper clearance
  const order = conds.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j]; if (b.bbox[0] > a.bbox[2] + maxClr) break;
      if (a.net && a.net === b.net) continue; if (!shareLayer(a.layers, b.layers)) continue;
      let need = Math.max(clr(a), clr(b), s.minClearance || 0), by = "";   // Board Setup > Constraints: the board minimum is a floor
      if (clrRules.length && boxesTouch(a.bbox, b.bbox, maxClr)) {
        const layer = [...a.layers].find((l) => b.layers.has(l)) || ""; const hit = ruleClearance(clrRules, doc, s, ruleItem(a, layer), ruleItem(b, layer));
        if (hit) { need = hit.min > 0 ? Math.max(hit.min, s.minClearance || 0) : 0; by = hit.name; }
      }
      if (!need || !boxesTouch(a.bbox, b.bbox, need)) continue;
      const gap = shapeGap(a.shape, b.shape); if (gap >= need - DRC_EPS) continue;
      if (a.kind === "segment" && b.kind === "segment") {   // DRC_TEST_PROVIDER_COPPER_CLEARANCE: crossing tracks are their own violation
        const sa = a.shape as { a: Pt; b: Pt }, sb = b.shape as { a: Pt; b: Pt }; const X = segCross(sa.a, sa.b, sb.a, sb.b);
        if (X) { out.push(marker("tracks_crossing", "error", X[0], X[1], `Tracks crossing${by ? ` (${by})` : ""}`, [a.id, b.id])); continue; }
      }
      const cls = clr(a) >= clr(b) ? netclassName(s, a.net) : netclassName(s, b.net);   // the stricter class of the pair names the rule
      const [x, y] = boxCenter(a.bbox, b.bbox);
      out.push(marker("clearance", "error", x, y, `Clearance violation (${by || `netclass '${cls}'`} clearance ${mm4(need)}; actual ${mm4(gap)})`, Array.from(new Set([a.id, b.id]))));
    }
  }
  // copper to board edge (DRC_TEST_PROVIDER_EDGE_CLEARANCE): a custom edge_clearance rule, else the board setup value
  const edges = edgeShapes(doc);
  const edgeRules = rules.some((r) => r.constraints.some((k) => k.type === "edge_clearance"));
  if (edges.shapes.length && (s.edgeClearance > 0 || edgeRules)) {
    const eb = edges.shapes.map((e) => shapeBBox(e)); const edgeItem = { kind: "gr_line", node: ["gr_line", ["layer", "Edge.Cuts"]] as SNode, layer: "Edge.Cuts" };
    const edgeMax = Math.max(s.edgeClearance, ...rules.flatMap((r) => r.constraints.filter((k) => k.type === "edge_clearance").map((k) => k.min || 0)));
    for (const c of conds) {
      let need = s.edgeClearance, name = "board setup constraints edge";
      if (edgeRules) { const layer = c.layers.values().next().value || ""; const h = evalRuleConstraint(rules, "edge_clearance", doc, s, ruleItem(c, layer), edgeItem) || evalRuleConstraint(rules, "edge_clearance", doc, s, edgeItem, ruleItem(c, layer)); if (h) { need = h.severity === "ignore" ? 0 : h.min || 0; name = h.name; } }
      if (!(need > 0)) continue;
      for (let i = 0; i < edges.shapes.length; i++) {
        if (!boxesTouch(c.bbox, eb[i], Math.max(need, edgeMax))) continue; const gap = shapeGap(c.shape, edges.shapes[i]); if (gap >= need - DRC_EPS) continue;
        const [x, y] = boxCenter(c.bbox, eb[i]); out.push(marker("copper_edge_clearance", "error", x, y, `Board edge clearance violation (${name} clearance ${mm4(need)}; actual ${mm4(gap)})`, [c.id])); break;
      }
    }
  }
  // connectivity
  if (opts.unconnected !== false) for (const l of ratsnest(doc, nl)) out.push(marker("unconnected_items", "error", l.a[0], l.a[1], `Missing connection between items (net '${l.name}')`, l.ids.slice()));
  for (const net of nl.nets.values()) for (const cl of net.shorts) { const p = cl.anchors[0] ? cl.anchors[0].p : [0, 0]; out.push(marker("shorting_items", "error", p[0], p[1], `Items shorting two nets (${Array.from(cl.nets).join(", ")})`, Array.from(new Set(cl.items.map((c) => c.id))))); }
  // tracks and vias
  const touches = (p: Pt, layer: string, self: Conductor) => conds.some((c) => c !== self && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && shapeGap(c.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS)
    || nl.conductors.some((c) => c.kind === "zone" && c.layers.has(layer) && boxesTouch(c.bbox, [p[0], p[1], p[0], p[1]], EPS) && pointInPoly((c.shape as PolyShape).pts, p[0], p[1]));
  for (const c of conds) {
    if (c.kind === "segment" || c.kind === "arc") {
      const [a, b] = c.anchors; const layer = c.layers.values().next().value!;
      if (c.length! < EPS) continue;   // KiCad reports nothing for a zero-length track
      const loose = [a, b].find((p) => !touches(p, layer, c)); if (loose) out.push(marker("track_dangling", "warning", loose[0], loose[1], "Track has unconnected end", [c.id]));   // one marker per track, like DRCE_DANGLING_TRACK
    } else if (c.kind === "via") {
      const [a] = c.anchors;
      if (!conds.some((o) => o !== c && o.id !== c.id && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS) && !nl.conductors.some((o) => o.kind === "zone" && shareLayer(o.layers, c.layers) && boxesTouch(o.bbox, c.bbox, EPS) && shapeGap(o.shape, c.shape) <= EPS)) out.push(marker("via_dangling", "warning", a[0], a[1], "Via is not connected or connected on only one layer", [c.id]));
    }
  }
  // track width, via diameter, hole size, annular width, segment length and angle through the rules (drc-rules.ts)
  out.push(...sizeMarkers(doc, s, rules, conds), ...trackAngleMarkers(doc, s, rules, conds));
  if (rules.length) { const items = ruleItems(doc); out.push(...disallowMarkers(doc, s, rules, items), ...assertionMarkers(doc, s, rules, items)); }
  // courtyards
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint"); const cy = fps.map((fp) => courtyards(fp));
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
    if (!fps[i].bbox || !fps[j].bbox || !boxesTouch(fps[i].bbox!, fps[j].bbox!, 0)) continue;
    for (const layer of ["F.CrtYd", "B.CrtYd"]) { let hit = false; for (const P of cy[i][layer]) for (const Q of cy[j][layer]) if (polysOverlap(P, Q)) hit = true; if (hit) { const [x, y] = boxCenter(fps[i].bbox!, fps[j].bbox!); out.push(marker("courtyards_overlap", "error", x, y, `Courtyards overlap (${fps[i].ref || "footprint"} and ${fps[j].ref || "footprint"} on ${layer})`, [fps[i].id, fps[j].id])); } }
  }
  // outline
  const ol = boardOutline(doc);
  if (ol.hasEdges && !ol.outline) { const e = edges.shapes[0] as { a?: Pt; pts: Pt[] }; const p = e.a || e.pts[0]; out.push(marker("invalid_outline", "error", p[0], p[1], "Board has malformed outline (Edge.Cuts does not close)", [])); }
  else if (ol.outline && opts.outline !== false) {
    // DRC_TEST_PROVIDER_EDGE_CLEARANCE::testCopperOutsideBoard: copper that does not touch the board at all
    const seen = new Set<string>(); const board = { t: "poly" as const, pts: ol.outline };
    for (const c of nl.conductors) {
      if (seen.has(c.id) || c.kind === "zone") continue;
      if (boxesTouch(c.bbox, shapeBBox(board), 0) && shapeGap(c.shape, board) <= EPS) continue;
      seen.add(c.id); const p = c.kind === "pad" ? [c.pad!.x, c.pad!.y] : c.anchors[0];
      out.push(marker("copper_outside_board", "warning", p[0], p[1], "Copper outside board outline", [c.id]));
    }
  }
  // hole to hole, text dimensions and mirroring, courtyard definitions and holes in courtyards, Edge.Cuts text,
  // keepout areas and disabled layers (drc-more.ts)
  out.push(...moreDrcMarkers(doc, s, rules));
  // silkscreen overlaps, silk clipped by mask or by the board edge, solder mask bridges (drc-silk.ts)
  out.push(...silkMaskMarkers(doc, s, rules));
  // the project's rule severities: ignored rules drop out, the rest take the severity the project gives them
  return out.filter((m) => s.severities[m.code] !== "ignore").map((m) => { const sev = s.severities[m.code]; if (sev === "warning" || sev === "error") m.severity = sev; return m; });
}
