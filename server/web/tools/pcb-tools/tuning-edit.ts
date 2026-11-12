// pcb-tools/tuning-edit.ts — a placed tuning pattern as one selectable object (PCB_TUNING_PATTERN is a PCB_GENERATOR, a
// PCB_GROUP): its selection, the dashed base line and outline it draws while selected (ViewDraw), its four edit points
// (MakeEditPoints / UpdateFromEditPoints) and the live re-tune while one of them, a property or a move changes it
// (GENERATOR_TOOL genStartEdit / genUpdateEdit / genFinishEdit / genCancelEdit), committed as "Edit Tuning Pattern".
import type { BoardDoc, PcbCtx, Pt, SAtom } from "./types";
import type { MeanderSettings } from "./meander";
import { branchChanges } from "./branch";
import { selectionIds } from "./groups";
import { line } from "./overlay";
import { K, S } from "./state";
import { isTuningPattern, regenerateTuningBranch, tuningPatternInfo } from "./tuning-patterns";
import { clone, color, pt, widthOf } from "./util";

/** The generator edit in flight: the pattern's original and edited node, and the board as the update would leave it. */
export interface GenEdit { id: string; orig: SNode; node: SNode; fin: BoardDoc | null; hidden: Set<string>; label: string }
export const TUNING_COMMIT_MESSAGE = "Edit Tuning Pattern";   // PCB_TUNING_PATTERN::GetCommitMessage

/**
 * The one tuning pattern the selection is (its generator with nothing but its own members beside it), or null: what
 * KiCad's selection holds as a single PCB_GENERATOR.
 */
export function selectedTuningPattern(ctx: PcbCtx, ids?: Iterable<string>) {
  const doc = ctx.doc; if (!doc) return null; const sel = Array.from(ids || selectionIds(ctx)); let gen: KItem | null = null;
  for (const id of sel) { const it = doc.items.get(id); if (isTuningPattern(it)) { if (gen) return null; gen = it!; } }
  if (!gen) return null; const mem = new Set(K.groupMemberIds(gen.node));
  for (const id of sel) if (id !== gen.id && !mem.has(id)) return null;
  return gen;
}

// ---- geometry: offset lines with round corners (SHAPE_LINE_CHAIN::OffsetLine / SHAPE_POLY_SET::OffsetLineChain, ROUND_ALL_CORNERS)
const ARC_STEPS = 16;
const perp = (u: Pt): Pt => [-u[1], u[0]];   // VECTOR2::Perpendicular: (-y, x), the "right" (SEG::Side > 0) of the travel
const unit = (a: Pt, b: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
function arcPts(c: Pt, r: number, a0: number, a1: number, out: Pt[]) {
  // from angle a0 to a1 the short way round (the caller passes them so the short way is the outer side)
  let sw = a1 - a0; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(sw) / (Math.PI / ARC_STEPS)));
  for (let i = 1; i < n; i++) { const a = a0 + sw * i / n; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
}
/** A polyline offset by d along its Perpendicular (d > 0 the right, d < 0 the left), outer corners rounded, inner ones mitred. */
export function offsetSide(pts: Pt[], d: number): Pt[] {
  const P = pts.filter((p, i) => !i || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
  if (P.length < 2) return [];
  const U: Pt[] = []; for (let i = 0; i + 1 < P.length; i++) U.push(unit(P[i], P[i + 1]));
  const out: Pt[] = []; const off = (p: Pt, u: Pt): Pt => { const n = perp(u); return [p[0] + n[0] * d, p[1] + n[1] * d]; };
  out.push(off(P[0], U[0]));
  for (let k = 1; k + 1 < P.length; k++) {
    const u0 = U[k - 1], u1 = U[k]; const cr = u0[0] * u1[1] - u0[1] * u1[0];
    if (Math.abs(cr) < 1e-12) { out.push(off(P[k], u1)); continue; }
    if (cr * d > 0) {   // the inside of the turn: the two offset lines meet (mitre)
      const n0 = perp(u0), n1 = perp(u1); const den = 1 + n0[0] * n1[0] + n0[1] * n1[1];
      out.push([P[k][0] + (n0[0] + n1[0]) / den * d, P[k][1] + (n0[1] + n1[1]) / den * d]);
    } else {            // the outside: a round corner about the vertex
      const q0 = off(P[k], u0), q1 = off(P[k], u1); out.push(q0);
      arcPts(P[k], Math.abs(d), Math.atan2(q0[1] - P[k][1], q0[0] - P[k][0]), Math.atan2(q1[1] - P[k][1], q1[0] - P[k][0]), out); out.push(q1);
    }
  }
  out.push(off(P[P.length - 1], U[U.length - 1]));
  return out;
}
/** OffsetLineChain with round ends: the closed outline a distance amp around a polyline. */
export function roundOutline(pts: Pt[], amp: number): Pt[] {
  const R = offsetSide(pts, amp), L = offsetSide(pts, -amp); if (!R.length) return [];
  const out: Pt[] = R.slice(); const e = pts[pts.length - 1], s = pts[0];
  const cap = (c: Pt, from: Pt, to: Pt, mid: Pt) => {   // a half circle about c from `from` round through `mid` to `to`
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]), am = Math.atan2(mid[1] - c[1], mid[0] - c[0]), a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
    const tmp: Pt[] = []; arcPts(c, amp, a0, am, tmp); out.push(...tmp); out.push(mid); const t2: Pt[] = []; arcPts(c, amp, am, a1, t2); out.push(...t2);
  };
  const ue = unit(pts[pts.length - 2], e), us = unit(pts[0], pts[1]);
  cap(e, R[R.length - 1], L[L.length - 1], [e[0] + ue[0] * amp, e[1] + ue[1] * amp]);
  out.push(...L.slice().reverse());
  cap(s, L[0], R[0], [s[0] - us[0] * amp, s[1] - us[1] * amp]);
  return out;
}
/** PCB_TUNING_PATTERN::getOutline: the base line(s) grown by the clamped maximum amplitude; one side when single-sided. */
export function tuningOutline(info: ReturnType<typeof tuningPatternInfo>): Pt[] {
  const base = info.base; if (!base || base.length < 2) return [];
  const dp = info.mode === "diff_pair"; const w = info.width, gap = info.gap; const st = info.st; const IU = 1e6;
  const baselineOffset = dp ? (gap + w) / 2 : 0;
  const minAllowed = st.round ? baselineOffset + w : baselineOffset + w * Math.tan(1 - Math.tan(Math.PI / 8));
  const clamped = Math.max(st.maxAmp / IU, minAllowed);
  if (st.singleSided && !dp) {
    const amp = clamped + w / 2; const side = offsetSide(base, st.initialSide >= 0 ? amp : -amp);
    return side.length ? side.concat(base.slice().reverse()) : [];
  }
  const amp = dp ? clamped + gap / 2 + w : clamped + w / 2;
  if (dp && info.coupled && info.coupled.length >= 2) {
    // the union of the two lines' outlines: the pair's centre line grown by the amplitude and half their separation
    const n = Math.min(base.length, info.coupled.length); const centre: Pt[] = [];
    for (let i = 0; i < n; i++) centre.push([(base[i][0] + info.coupled[i][0]) / 2, (base[i][1] + info.coupled[i][1]) / 2]);
    centre[centre.length - 1] = [(base[base.length - 1][0] + info.coupled[info.coupled.length - 1][0]) / 2, (base[base.length - 1][1] + info.coupled[info.coupled.length - 1][1]) / 2];
    const sep = Math.hypot(base[0][0] - info.coupled[0][0], base[0][1] - info.coupled[0][1]);
    return roundOutline(centre, amp + sep / 2);
  }
  return roundOutline(base, amp);
}

// ---- drawing (PCB_TUNING_PATTERN::ViewDraw while selected or new)
/** DRAW_CONTEXT::DrawLineDashed: dashes of `fill` every `step` from a to b. */
export function dashedLine(c: CanvasRenderingContext2D, a: Pt, b: Pt, step: number, fill: number) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (!L || step <= 0) return;
  c.beginPath();
  for (let i = 0; i < L; i += step) { const j = Math.min(i + fill, L); c.moveTo(a[0] + dx * i / L, a[1] + dy * i / L); c.lineTo(a[0] + dx * j / L, a[1] + dy * j / L); }
  c.stroke();
}
/** The selected (or edited) pattern: its base line(s) dashed at half alpha, its outline dashed, in LAYER_AUX_ITEMS (white), 1 px. */
export function drawTuningSelection(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  const ge = S.genEdit as GenEdit | null | undefined;
  const gen = ge ? (ge.fin ? ge.fin.items.get(ge.id) : null) || { node: ge.node } : selectedTuningPattern(ctx);
  if (!gen) return;
  const info = tuningPatternInfo(gen); const size = Math.max(0.8 * 8 * px, 0.05);   // max( 0.8 * EDIT_POINT::POINT_SIZE, 0.05 mm )
  c.save(); c.setLineDash([]); c.lineWidth = px; c.strokeStyle = "#FFFFFF"; c.lineCap = "butt";
  if (!ge) {   // not while IN_EDIT
    c.globalAlpha = 0.5;
    const lines = [info.base].concat(info.mode === "diff_pair" ? [info.coupled] : []);
    for (const b of lines) { if (b && b.length >= 2) for (let i = 0; i + 1 < b.length; i++) dashedLine(c, b[i], b[i + 1], size, size / 6); }
    if (!info.base && info.origin && info.end) { c.globalAlpha = 1; dashedLine(c, info.origin, info.end, size, size / 6); }
  }
  c.globalAlpha = 1;
  const o = tuningOutline(info);
  for (let i = 0; i + 1 < o.length; i++) dashedLine(c, o[i], o[i + 1], size, size / 2);
  if (o.length > 2) dashedLine(c, o[o.length - 1], o[0], size, size / 2);
  c.restore();
}

// ---- edit points (MakeEditPoints / UpdateFromEditPoints)
interface TuneHandle { key: string; p: Pt; ignoreGrid?: boolean }
function handleFrame(info: ReturnType<typeof tuningPatternInfo>) {
  const origin = info.origin || (info.base ? info.base[0] : [0, 0]), end = info.end || (info.base ? info.base[info.base.length - 1] : origin);
  let off: Pt = [0, 0], offEnd: Pt = [0, 0];
  if (info.mode === "diff_pair" && info.coupled && info.coupled.length >= 2) {
    off = [(info.coupled[0][0] - origin[0]) / 2, (info.coupled[0][1] - origin[1]) / 2];
    const cl = info.coupled[info.coupled.length - 1]; offEnd = [(cl[0] - end[0]) / 2, (cl[1] - end[1]) / 2];
  }
  const bA = info.base && info.base.length >= 2 ? info.base[0] : origin, bB = info.base && info.base.length >= 2 ? info.base[1] : end;
  return { origin, end, off, offEnd, A: [bA[0] + off[0], bA[1] + off[1]] as Pt, B: [bB[0] + off[0], bB[1] + off[1]] as Pt };
}
const resize = (v: Pt, l: number): Pt => { const n = Math.hypot(v[0], v[1]); return n ? [v[0] * l / n, v[1] * l / n] : [0, 0]; };
/** The pattern's four handles: 0 the origin and 1 the end (on the centre line of a pair), 2 the amplitude and 3 the spacing. */
export function tuningEditPoints(gen: Pick<KItem, "node">): TuneHandle[] {
  const info = tuningPatternInfo(gen); const F = handleFrame(info); const IU = 1e6;
  let amp = info.st.maxAmp / IU + info.width / 2; if (info.mode === "diff_pair") amp += info.width + info.gap;
  if (info.st.initialSide === -1) amp = -amp;
  const d: Pt = [F.B[0] - F.A[0], F.B[1] - F.A[1]];
  const wOff = resize(perp(d), amp); const sOff = resize(d, info.st.spacing / IU * 1.5);
  return [
    { key: "0", p: [F.origin[0] + F.off[0], F.origin[1] + F.off[1]] }, { key: "1", p: [F.end[0] + F.offEnd[0], F.end[1] + F.offEnd[1]] },
    { key: "2", p: [F.A[0] + wOff[0], F.A[1] + wOff[1]], ignoreGrid: true },
    { key: "3", p: [F.A[0] + wOff[0] + sOff[0], F.A[1] + wOff[1] + sOff[1]], ignoreGrid: true },
  ];
}
/** SEG::LineDistance: the distance from p to the infinite line through a and b. */
const lineDistance = (a: Pt, b: Pt, p: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return l ? Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l : Math.hypot(p[0] - a[0], p[1] - a[1]); };
const round001 = (mm: number) => Math.round(mm / 0.01) * 0.01;
const fmt = (v: number) => +(+v).toFixed(6);
function setKid(node: SNode, key: string, ...vals: SAtom[]) { const c = K.kid(node, key); if (c) c.splice(1, c.length - 1, ...vals); else node.splice(node.length - 1, 0, [key, ...vals]); }
/** The pattern's node with handle `key` dragged to p (UpdateFromEditPoints): origin / end, or max amplitude + side, or spacing. */
export function tuningEditNode(orig: SNode, key: string, p: Pt) {
  const node = clone(orig); const info = tuningPatternInfo({ node: orig }); const F = handleFrame(info);
  const hs = tuningEditPoints({ node: orig });
  if (key === "0") setKid(node, "origin", ["xy", fmt(p[0] - F.off[0]), fmt(p[1] - F.off[1])]);
  else if (key === "1") setKid(node, "end", ["xy", fmt(p[0] - F.offEnd[0]), fmt(p[1] - F.offEnd[1])]);
  else if (key === "2") {
    let v = lineDistance(F.A, F.B, p) - info.width / 2; if (info.mode === "diff_pair") v -= info.width + info.gap;
    setKid(node, "max_amplitude", fmt(round001(v)));
    const side = (F.B[0] - F.A[0]) * (p[1] - F.A[1]) - (F.B[1] - F.A[1]) * (p[0] - F.A[0]);   // SEG::Side
    setKid(node, "initial_side", side < 0 ? "left" : "right");
  } else if (key === "3") {
    const w = hs[2].p; setKid(node, "min_spacing", fmt(round001(lineDistance(F.A, w, p) / 1.5)));
  }
  return node;
}

// ---- the generator edit session (genStartEdit / genUpdateEdit / genFinishEdit / genCancelEdit)
/** genStartEdit: remember the pattern as it is. */
export function genStartEdit(ctx: PcbCtx, gen: KItem, label?: string) {
  const ge: GenEdit = { id: gen.id, orig: clone(gen.node), node: clone(gen.node), fin: null, hidden: new Set(), label: label || TUNING_COMMIT_MESSAGE };
  S.genEdit = ge; return ge;
}
/** genUpdateEdit: the pattern re-tuned with the edited node; the preview hides what the update replaces. */
export function genUpdateEdit(ctx: PcbCtx, node: SNode, doc?: BoardDoc) {
  const ge = S.genEdit as GenEdit | null | undefined; if (!ge) return null;
  ge.node = clone(node);
  const fin = regenerateTuningBranch(ctx, { id: ge.id, kind: "generated", node: ge.node }, doc); ge.fin = fin;
  ge.hidden = new Set(); const base = doc || ctx.doc;
  if (fin) for (const [id, it] of base.items) { const n = fin.items.get(id); if ((it.kind === "segment" || it.kind === "arc") && (!n || n.node !== it.node)) ge.hidden.add(id); }
  ctx.requestRender(); return fin;
}
/** genFinishEdit: one commit of the update (nothing when it changed nothing or could not be made). */
export function genFinishEdit(ctx: PcbCtx, extra?: KChange[]) {
  const ge = S.genEdit as GenEdit | null | undefined; S.genEdit = null; if (!ge) return false;
  if (!ge.fin || K.serialize(ge.node) === K.serialize(ge.orig)) { ctx.requestRender(); return false; }
  const changes = (extra || []).concat(branchChanges(ctx.doc, ge.fin));
  if (changes.length) ctx.commit(changes, ge.label);
  ctx.requestRender(); return true;
}
/** genCancelEdit: the board as it was. */
export function genCancelEdit(ctx: PcbCtx) { const had = !!S.genEdit; S.genEdit = null; if (had) ctx.requestRender(); return had; }
/** What the board render leaves out while an edit previews the re-tuned line. */
export function genHiddenIds() { const ge = S.genEdit as GenEdit | null | undefined; return ge && ge.fin && ge.hidden.size ? ge.hidden : null; }
/** The re-tuned line's copper over the hidden originals. */
export function drawGenEditPreview(c: CanvasRenderingContext2D, ctx: PcbCtx) {
  const ge = S.genEdit as GenEdit | null | undefined; if (!ge || !ge.fin) return;
  c.save(); c.globalAlpha = 1; c.lineCap = "round";
  for (const [id, it] of ge.fin.items) {
    if (it.kind !== "segment" && it.kind !== "arc") continue; const o = ctx.doc.items.get(id); if (o && o.node === it.node && !ge.hidden.has(id)) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    c.strokeStyle = color(K.str((K.kid(it.node, "layer") || [])[1])); c.lineWidth = widthOf(it.node, 0.25);
    if (it.kind === "arc") { const m = pt(it.node, "mid"); const arc = m && K.arcFrom3(a, m, b); if (arc) { c.beginPath(); c.arc(arc.x, arc.y, arc.r, arc.a0, arc.a1, !!arc.anticlockwise); c.stroke(); continue; } }
    line(c, a, b);
  }
  c.restore();
}

/** The pattern's node with its settings replaced (PCB_TUNING_PATTERN's m_settings as SetProperties reads them back). */
export function tuningNodeWithSettings(orig: SNode, st: MeanderSettings, mode: string) {
  const node = clone(orig); const mm = (v: number) => fmt(v / 1e6); const yn = (b: boolean) => (b ? "yes" : "no");
  setKid(node, "min_amplitude", mm(st.minAmp)); setKid(node, "max_amplitude", mm(st.maxAmp)); setKid(node, "min_spacing", mm(st.spacing));
  setKid(node, "corner_radius_percent", st.crPct); setKid(node, "rounded", yn(st.round)); setKid(node, "single_sided", yn(st.singleSided));
  setKid(node, "override_custom_rules", yn(st.overrideCustomRules));
  if (mode === "diff_pair_skew") { setKid(node, "target_skew", mm(st.skew.opt)); setKid(node, "target_skew_min", mm(st.skew.min)); setKid(node, "target_skew_max", mm(st.skew.max)); }
  else { setKid(node, "target_length", mm(st.target.opt)); setKid(node, "target_length_min", mm(st.target.min)); setKid(node, "target_length_max", mm(st.target.max)); }
  return node;
}
/** genStartEdit / genUpdateEdit / genFinishEdit with an edited node, in one commit labelled "Edit Tuning Pattern". */
export function editTuningPattern(ctx: PcbCtx, gen: KItem, node: SNode) {
  genStartEdit(ctx, gen); genUpdateEdit(ctx, node); return genFinishEdit(ctx);
}
