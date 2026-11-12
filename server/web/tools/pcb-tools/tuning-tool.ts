// pcb-tools/tuning-tool.ts — the length tuning tool (DRAWING_TOOL::PlaceTuningPattern).
import type { BoardDoc, NetRef, PcbChange, PcbCtx, Pt, TrackLine } from "./types";
import type { Chain, MeanderSettings, TuneRange } from "./meander";
import { netNameOf, sizesOf } from "./app-state";
import { removedChange, upsertChange } from "./changes";
import { ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { dpNetPair } from "./diffpair";
import { assembleLine, peq } from "./dragger";
import { netClearance } from "./drc";
import { distSeg } from "./hit";
import { DELAY_UNCONSTRAINED_MM, TUNE_IU, TUNE_MSG_INSIDE, TUNE_MSG_PICK, TUNE_STATUS_TEXT, chPoints, dpMeanderMove, meanderDefaults, meanderMove, segSide, splitLine, tuneCopy, veq } from "./meander";
import { routedLength } from "./msgpanel";
import { netTable } from "./netlist";
import { netOf } from "./nets";
import { segmentNode } from "./nodes";
import { closestOnSeg } from "./point-editor";
import { arcTrackNode } from "./posture";
import { setLayer } from "./route-tool";
import { K, S } from "./state";
import { layerOf, pt, r6, widthOf } from "./util";
import { pathHits, routeObstacles } from "./walkaround";

// ---- the tool (DRAWING_TOOL::PlaceTuningPattern, PCB_TUNING_PATTERN::Update / EditFinish)
/** What meanderMove hands back for the pattern as it is; a pair's pattern adds the coupled line's rebuilt chain and base line. */
export type TuneResult = ReturnType<typeof meanderMove> & { finalCoupled?: Chain; baselineCoupled?: Chain };
/** A differential pair's pattern (Tune Length of a Differential Pair): the coupled line, whether the picked line is P, the pair's gap. */
export interface TuneDp { line: TrackLine; net: NetRef; netKey: string; mineIsP: boolean; gap: number; lenMine: number; lenOther: number }
/** The pattern being placed (S.tune.pattern): the line it tunes, its stretch in mm, its settings and the last result. */
export interface TunePattern {
  item: string; line: TrackLine; layer: string; net: NetRef; netName: string; netKey: string; width: number;
  origin: Pt; end: Pt; cursor: Pt; st: MeanderSettings; clearance: number; lineLength: number; res: TuneResult | null;
  mode: string; coupled: number | null; dpGap?: number; dp?: TuneDp | null;
}
/** The track under the cursor before the first click (S.tune.picker): its id. */
export type TunePicker = string;
S.tuneSettings = { single: meanderDefaults(), diffpair: meanderDefaults(), skew: meanderDefaults() };   // BOARD_DESIGN_SETTINGS::m_SingleTrackMeanderSettings, m_DiffPairMeanderSettings, m_SkewMeanderSettings
export const TUNE_TOOLS = new Set(["tunesingle", "tunediff", "tuneskew"]);
export const isTuneTool = (t: string | null | undefined) => TUNE_TOOLS.has(t!);
export const tuneMode = (): "single" | "diffpair" | "skew" => S.modTool === "tuneskew" ? "skew" : S.modTool === "tunediff" ? "diffpair" : "single";
export const TUNE_MSG_DP_NETS = "Unable to find complementary differential pair net for length tuning. Make sure the names of the nets belonging to a differential pair end with either _N/_P or +/-.";
/** The generator's tuning_mode for a tuner mode. */
export const tuningModeName = (mode: string) => mode === "skew" ? "diff_pair_skew" : mode === "diffpair" ? "diff_pair" : "single";
/**
 * TOPOLOGY::AssembleDiffPair from a picked track: the coupled net's nearest track on the same layer (findNItem), its
 * line, and the pair's gap from the two parallel segments (|refDir × displacement| / |refDir| - width).  null when
 * the net has no partner or the partner has no track there.
 */
export function assembleDiffPair(doc: BoardDoc, item: KItem, line: TrackLine) {
  const pair = dpNetPair(doc, line.net); if (!pair) return null;
  const NT = netTable(doc); const kP = NT.key(pair.P), other = kP === line.netKey ? pair.N : pair.P, otherKey = NT.key(other);
  const a = pt(item.node, "start")!, b = pt(item.node, "end")!, mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" || layerOf(it.node) !== line.layer || NT.key(netOf(it.node)) !== otherKey) continue;
    const c = pt(it.node, "start"), d = pt(it.node, "end"); if (!c || !d) continue;
    const dd = distSeg(mid[0], mid[1], c[0], c[1], d[0], d[1]); if (dd < bd) { bd = dd; best = it; }
  }
  if (!best) return null;
  const ln = assembleLine(doc, best); if (!ln) return null;
  const c = pt(best.node, "start")!, dir = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(dir[0], dir[1]) || 1;
  const gap = Math.abs(dir[0] * (c[1] - a[1]) - dir[1] * (c[0] - a[0])) / n - line.width;
  return { line: ln, net: other, netKey: otherKey, mineIsP: kP === line.netKey, gap: r6(gap), item: best };
}
export const TUNE_MSG_SKEW_PICK = "Please select a differential pair track you want to tune.";
export const TUNE_MSG_SKEW_NETS = "Unable to find complementary differential pair net for skew tuning. Make sure the names of the nets belonging to a differential pair end with either _N/_P or +/-.";
/** MEANDER_SKEW_PLACER::Start: the routed length of the pair's other line (its tracks connected to the nearest one). */
export function coupledLength(doc: BoardDoc, pair: { P: NetRef; N: NetRef }, mineKey: string, near: Pt) {
  const NT = netTable(doc); const kP = NT.key(pair.P), other = kP === mineKey ? NT.key(pair.N) : kP;
  let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if ((it.kind !== "segment" && it.kind !== "arc") || NT.key(netOf(it.node)) !== other) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    const d = distSeg(near[0], near[1], a[0], a[1], b[0], b[1]); if (d < bd) { bd = d; best = it; }
  }
  return best ? routedLength(doc, best.id) : 0;
}
/** The length target doMove works to: the pattern's own, or for skew the coupled length plus the skew (MEANDER_SKEW_PLACER::Move). */
export function tuneTarget(st: MeanderSettings, coupled: number | null | undefined): TuneRange {
  if (coupled == null) return st.target;
  const c = coupled * TUNE_IU; return { min: c + st.skew.min, opt: c + st.skew.opt, max: c + st.skew.max };
}
/** The track the tuner picks under the cursor: GENERAL_COLLECTOR on tracks and arcs, 5 px, the nearest centre wins. */
export function tunePick(ctx: PcbCtx, mm: Pt) {
  const doc = ctx.doc; const thr = 5 * (S.mmPerPx || 0.05); const active = S.layer; const hits: { it: KItem; d2: number; onActive: boolean }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc") continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    const w = widthOf(it.node, 0.25);
    let d: number, centre: Pt;
    if (it.kind === "arc") { const m = pt(it.node, "mid"); const c = m && K.arcFrom3(a, m, b); centre = m || a; d = c ? Math.abs(Math.hypot(mm[0] - c.x, mm[1] - c.y) - c.r) : distSeg(mm[0], mm[1], a[0], a[1], b[0], b[1]); }
    else { centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; d = distSeg(mm[0], mm[1], a[0], a[1], b[0], b[1]); }
    if (d > w / 2 + thr) continue;
    hits.push({ it, d2: (mm[0] - centre[0]) ** 2 + (mm[1] - centre[1]) ** 2, onActive: layerOf(it.node) === active });
  }
  if (!hits.length) return null;
  const pool = hits.some((h) => h.onActive) ? hits.filter((h) => h.onActive) : hits;   // GuessSelectionCandidates: the active layer first
  pool.sort((x, y) => x.d2 - y.d2); return pool[0].it;
}
/** The tuning pattern a track belongs to (its parent group is a PCB_TUNING_PATTERN), or null. */
export function tuningPatternOf(doc: BoardDoc, id: string) {
  for (const it of doc.items.values()) if (it.kind === "generated" && /^tuning_pattern$/.test(K.str((K.kid(it.node, "type") || [])[1])) && K.groupMemberIds(it.node).includes(id)) return it;
  return null;
}
/** PCB_TUNING_PATTERN::CreateNew + the first click: anchored on the track's nearest point. */
export function tuneBegin(ctx: PcbCtx, item: KItem, mm: Pt) {
  const doc = ctx.doc;
  const skew = tuneMode() === "skew", dual = tuneMode() === "diffpair";
  if (tuningPatternOf(doc, item.id)) { ctx.toast(TUNE_MSG_INSIDE); return; }
  if (item.kind !== "segment") { ctx.toast(skew ? TUNE_MSG_SKEW_PICK : TUNE_MSG_PICK); return; }
  const line = assembleLine(doc, item); if (!line) { ctx.toast(skew ? TUNE_MSG_SKEW_PICK : TUNE_MSG_PICK); return; }
  const pair = skew ? dpNetPair(doc, line.net) : null;
  if (skew && !pair) { ctx.toast(TUNE_MSG_SKEW_NETS); return; }
  const dpa = dual ? assembleDiffPair(doc, item, line) : null;
  if (dual && (!dpa || tuningPatternOf(doc, dpa.item.id))) { ctx.toast(dpa ? TUNE_MSG_INSIDE : TUNE_MSG_DP_NETS); return; }
  if (layerOf(item.node) !== S.layer) setLayer(ctx, layerOf(item.node));   // m_frame->SetActiveLayer( pickerItem layer )
  const a = pt(item.node, "start"), b = pt(item.node, "end"); const at = closestOnSeg(mm, a!, b!);
  const s = settingsOf(ctx);
  const st = tuneCopy(S.tuneSettings[tuneMode()]);
  S.tune.pattern = { item: item.id, line, layer: line.layer, net: line.net, netName: netNameOf(ctx, line.net), netKey: line.netKey, width: line.width, origin: at, end: at, cursor: mm.slice(), st,
    clearance: netClearance(s, line.netKey), lineLength: routedLength(doc, item.id), res: null, mode: tuneMode(),
    coupled: pair ? coupledLength(doc, pair, line.netKey, closestOnSeg(mm, a!, b!)) : null };
  if (dpa) {
    const lenMine = S.tune.pattern.lineLength, lenOther = routedLength(doc, dpa.item.id);
    S.tune.pattern.dp = { line: dpa.line, net: dpa.net, netKey: dpa.netKey, mineIsP: dpa.mineIsP, gap: dpa.gap, lenMine, lenOther };
    S.tune.pattern.lineLength = Math.max(lenMine, lenOther);   // origPathLength
    S.tune.pattern.dpGap = dpa.gap;
  }
}
/** PCB_TUNING_PATTERN::EditStart + Update for the pattern as it is: the side from the end, then MEANDER_PLACER::Move. */
export function tuneUpdate(ctx: PcbCtx) {
  const T = S.tune.pattern; if (!T) return;
  const ln = T.line; const pts = ln.pts;
  // the end snaps onto the line (SnapToNearestTrack on the net); the side is the cursor's against the baseline's last leg
  let best: { d: number; q: Pt } | null = null; for (let i = 0; i + 1 < pts.length; i++) { const q = closestOnSeg(T.cursor, pts[i], pts[i + 1]); const d = Math.hypot(q[0] - T.cursor[0], q[1] - T.cursor[1]); if (!best || d < best.d) best = { d, q }; }
  T.end = best!.q;
  if (peq(T.end, T.origin)) { T.res = null; return; }
  const I = (p: Pt) => [p[0] * TUNE_IU, p[1] * TUNE_IU];
  const sp = splitLine(pts.map(I), I(T.origin), I(T.end));
  let last = sp.mid.length >= 2 ? { A: sp.mid[sp.mid.length - 2].p, B: sp.mid[sp.mid.length - 1].p } : null;
  if (last && T.dp) {   // the side against the pair's centre line: the base line's last leg moved halfway to the coupled one's end
    const spc = splitLine(T.dp.line.pts.map(I), I(T.origin), I(T.end)); const off = [(spc.end[0] - sp.end[0]) / 2, (spc.end[1] - sp.end[1]) / 2];
    last = { A: [last.A[0] + off[0], last.A[1] + off[1]], B: [last.B[0] + off[0], last.B[1] + off[1]] };
  }
  if (last && !veq(last.A, last.B)) T.st.initialSide = segSide(last, I(T.cursor)) < 0 ? -1 : 1;   // UpdateSideFromEnd
  const st = tuneCopy(T.st); st.keepEndpoints = true; st.target = tuneTarget(T.st, T.coupled);
  const doc = ctx.doc; const O = routeObstacles(doc, settingsOf(ctx), T.netKey, T.layer);
  const r = T.width / 2;
  if (T.dp) {
    const dp = T.dp, skip = new Set(dp.line.ids);
    const Od = routeObstacles(doc, settingsOf(ctx), T.netKey, T.layer, null, skip);   // both lines are lifted out of the world
    const hits = (ch: Chain) => pathHits(Od, chPoints(ch).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
    T.res = tuneDp(T, st, I, hits);
    T.st.initialSide = st.initialSide; return;
  }
  const collides = (ch: Chain) => pathHits(O, chPoints(ch).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
  T.res = meanderMove({ pts: pts.map(I), origin: I(T.origin), end: I(T.end), cursor: I(T.cursor), st, width: Math.round(T.width * TUNE_IU), clearance: Math.round(T.clearance * TUNE_IU), lineLength: T.lineLength * TUNE_IU, collides });
  T.st.initialSide = st.initialSide;   // flipInitialSide reaches the pattern's settings (m_settings = placer->MeanderSettings())
}
/** DP_MEANDER_PLACER::Move for a pair's pattern, its result in the picked line's terms (final / baseline its own, *Coupled the other's). */
export function tuneDp(T: Pick<TunePattern, "line" | "origin" | "end" | "cursor" | "width" | "clearance" | "dp">, st: MeanderSettings, I: (p: Pt) => Pt, collides: (ch: Chain) => boolean): TuneResult {
  const dp = T.dp!; const mine = T.line.pts.map(I), other = dp.line.pts.map(I);
  const r = dpMeanderMove({ ptsP: dp.mineIsP ? mine : other, ptsN: dp.mineIsP ? other : mine, origin: I(T.origin), end: I(T.end), cursor: I(T.cursor), st,
    width: Math.round(T.width * TUNE_IU), gap: Math.round(dp.gap * TUNE_IU), clearance: Math.round(T.clearance * TUNE_IU),
    lengthP: (dp.mineIsP ? dp.lenMine : dp.lenOther) * TUNE_IU, lengthN: (dp.mineIsP ? dp.lenOther : dp.lenMine) * TUNE_IU, collides });
  const P = dp.mineIsP;
  return { final: P ? r.finalP : r.finalN, finalCoupled: P ? r.finalN : r.finalP, tuned: P ? r.tunedP : r.tunedN, status: r.status, length: r.length, hasMeanders: r.hasMeanders,
    settings: r.settings, start: r.start, end: r.end, baseline: P ? r.baselineP : r.baselineN, baselineCoupled: P ? r.baselineN : r.baselineP };
}
/** The rebuilt line's pieces in mm: [{ a, b }] and [{ a, m, b }] for arcs. */
export function tunePieces(ch: Chain) {
  const out: { a: Pt; m?: Pt; b: Pt }[] = []; const M = (p: Pt) => [r6(p[0] / TUNE_IU), r6(p[1] / TUNE_IU)];
  for (let i = 1; i < ch.length; i++) { const a = M(ch[i - 1].p), b = M(ch[i].p); if (peq(a, b)) continue; out.push(ch[i].m ? { a, m: M(ch[i].m!), b } : { a, b }); }
  return out;
}
export const sexprQ = (s: unknown) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export const fmtG = (v: number | string) => { const x = +(+v).toPrecision(10); return String(x === 0 ? 0 : x); };
/** PCB_TUNING_PATTERN's (generated …) node, its properties in STRING_ANY_MAP (alphabetical) order as PCB_IO_KICAD_SEXPR writes them. */
export function tuningPatternNode(T: Pick<TunePattern, "st" | "dpGap" | "netName" | "width" | "mode" | "layer"> & { st?: MeanderSettings | null }, res: TuneResult, members: string[]) {
  const coupled = res.baselineCoupled ? res.baselineCoupled.map((n: { p: Pt }) => [r6(n.p[0] / TUNE_IU), r6(n.p[1] / TUNE_IU)]) : null;
  const st = T.st ? Object.assign({}, res.settings, { target: T.st.target, skew: T.st.skew }) : res.settings; const mm = (v: number) => fmtG(v / TUNE_IU); const xy = (p: Pt) => `(xy ${fmtG(p[0])} ${fmtG(p[1])})`;
  const base = res.baseline.map((n: { p: Pt }) => [r6(n.p[0] / TUNE_IU), r6(n.p[1] / TUNE_IU)]);
  const side = st.initialSide < 0 ? "left" : st.initialSide > 0 ? "right" : "default";
  const yn = (b: boolean) => b ? "yes" : "no";
  const props = [
    `(base_line (pts ${base.map(xy).join(" ")}))`, ...(coupled && coupled.length >= 2 ? [`(base_line_coupled (pts ${coupled.map(xy).join(" ")}))`] : []), `(corner_radius_percent ${st.crPct})`, `(end ${xy(base[base.length - 1])})`,
    `(initial_side ${sexprQ(side)})`, `(is_time_domain no)`, `(last_diff_pair_gap ${fmtG(T.dpGap!)})`, `(last_netname ${sexprQ(T.netName || "")})`,
    `(last_status ${sexprQ(res.status)})`, `(last_track_width ${fmtG(T.width)})`, `(last_tuning_length ${mm(res.length)})`,
    `(max_amplitude ${mm(st.maxAmp)})`, `(min_amplitude ${mm(st.minAmp)})`, `(min_spacing ${mm(st.spacing)})`, `(origin ${xy(base[0])})`,
    `(override_custom_rules ${yn(st.overrideCustomRules)})`, `(rounded ${yn(st.round)})`, `(single_sided ${yn(st.singleSided)})`,
    `(target_delay ${fmtG(DELAY_UNCONSTRAINED_MM)})`, `(target_delay_max ${fmtG(DELAY_UNCONSTRAINED_MM)})`, `(target_delay_min 0)`,
    `(target_length ${mm(st.target.opt)})`, `(target_length_max ${mm(st.target.max)})`, `(target_length_min ${mm(st.target.min)})`,
    `(target_skew ${mm(st.skew.opt)})`, `(target_skew_max ${mm(st.skew.max)})`, `(target_skew_min ${mm(st.skew.min)})`,
    `(tuning_mode ${sexprQ(tuningModeName(T.mode))})`,
  ];
  const text = `(generated (uuid ${sexprQ(K.newUuid())}) (type tuning_pattern) (name "Tuning Pattern") (layer ${sexprQ(T.layer)}) ${props.join(" ")} (members ${members.slice().sort().map(sexprQ).join(" ")}))`;
  return K.parse(text);
}
/** Is a point inside the pattern's outline (getOutline: the baseline grown by the clamped max amplitude + half the width)? */
export function inTuneOutline(T: Pick<TunePattern, "width">, res: TuneResult, p: Pt) {
  const st = res.settings; const minA = st.round ? T.width : T.width * Math.tan(1 - Math.tan(Math.PI / 8));
  const amp = Math.max(st.maxAmp / TUNE_IU, minA) + T.width / 2 + 0.0005;   // + the DRC epsilon
  for (const bl of [res.baseline, res.baselineCoupled]) {
    if (!bl) continue; const base = bl.map((n: { p: Pt }) => [n.p[0] / TUNE_IU, n.p[1] / TUNE_IU]);
    for (let i = 0; i + 1 < base.length; i++) if (distSeg(p[0], p[1], base[i][0], base[i][1], base[i + 1][0], base[i + 1][1]) <= amp) return true;
  }
  return false;
}
/** The second click: EditStart / Update / EditFinish in one commit ("Tune"), or KiCad's warning when nothing meanders. */
export function tuneFinish(ctx: PcbCtx) {
  const T = S.tune.pattern; if (!T) return; tuneUpdate(ctx); const res = T.res;
  if (!res) return;
  if (!res.hasMeanders) {
    S.tune.pattern = null; S.tune.picker = null;
    ctx.toast(`No tuning pattern added: no meanders were needed or would fit (${TUNE_STATUS_TEXT[res.status]}).`); ctx.requestRender(); return;
  }
  const doc = ctx.doc; const changes: PcbChange[] = [], members: string[] = [];
  const scratch = Object.assign({}, doc, { items: new Map(doc.items) });
  const rebuild = (ln: TrackLine, fin: Chain, net: NetRef) => {
    const old = ln.ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[];
    const oldKey = new Map<string, KItem>(); for (const it of old) { const a = pt(it.node, "start")!, b = pt(it.node, "end")!; oldKey.set(ptKey(a) + "|" + ptKey(b), it); oldKey.set(ptKey(b) + "|" + ptKey(a), it); }
    const kept = new Set<string>();
    for (const pc of tunePieces(fin)) {
      const same = !pc.m && oldKey.get(ptKey(pc.a) + "|" + ptKey(pc.b));
      if (same && !kept.has(same.id)) { kept.add(same.id); continue; }   // the line's own segments outside the meanders stay as they are
      const node = pc.m ? arcTrackNode(doc, pc.a, pc.m, pc.b, T.width, T.layer, net) : segmentNode(doc, pc.a, pc.b, T.width, T.layer, net);
      const it = K.createItem(scratch, node); changes.push(upsertChange(it!, "ADDED", net));
      if (inTuneOutline(T, res, pc.a) && inTuneOutline(T, res, pc.b)) members.push(it!.id);
    }
    for (const it of old) if (!kept.has(it.id)) changes.unshift(removedChange(it));
  };
  rebuild(T.line, res.final, T.net);
  if (T.dp && res.finalCoupled) rebuild(T.dp.line, res.finalCoupled, T.dp.net);
  if (!T.dp) T.dpGap = sizesOf(ctx).routeDiffPair ? sizesOf(ctx).routeDiffPair(T.netName).gap : 0.25;   // a pair's pattern keeps its own gap
  const gen = K.createItem(scratch, tuningPatternNode(T, res, members)!); changes.push(upsertChange(gen!, "ADDED"));
  S.tuneSettings[tuneMode()].initialSide = T.st.initialSide;
  S.tune.pattern = null; S.tune.picker = null;
  ctx.commit(changes, "Tune"); ctx.requestRender();
}
