// pcb-tools/dimensions.ts — dimensions (pcb_dimension.cpp): their nodes, PCB_DIMENSION_BASE::Update and their edit points.
import type { Pt } from "./types";

/** A dimension as the drawing tool hands it over (mm): its feature points, height, orientation and text. */
export interface DimSpec {
  start: Pt; end: Pt; height?: number; orientation?: string; textPos?: Pt | null; text?: string | null; arrowInward?: boolean; thickness?: number | null;
}
/** The item as PCB_DIM_* holds it (dimRead, in nm), plus what Update() derives. */
export type DimModel = ReturnType<typeof dimRead> & { crossbarStart?: Pt; crossbarEnd?: Pt; measured?: number };
import { NM, crossZ, fromNm, kiRound, toNm } from "./arcs";
import { sizeUnits } from "./edit-commands";
import { effectsNode, gfxWidth } from "./nodes";
import { K } from "./state";
import { DIM_DEFAULTS, clone, norm360, r6, rotator, textStyle, vadd, vmul, vsub, vunit, xy } from "./util";

// ---------------------------------------------------------------- dimensions (pcb_dimension.cpp)
export const DIM_CLASS: Record<string, string> = { aligned: "PCB_DIM_ALIGNED", orthogonal: "PCB_DIM_ORTHOGONAL", center: "PCB_DIM_CENTER", radial: "PCB_DIM_RADIAL", leader: "PCB_DIM_LEADER" };
export const DIM_TYPE: Record<string, string> = { dimaligned: "aligned", dimortho: "orthogonal", dimcenter: "center", dimradial: "radial", leader: "leader" };
export const ARROW_LEN = 1.27, EXT_OFFSET = 0.5;                      // 50 mil arrows, DEFAULT_DIMENSION_EXTENSION_OFFSET
export const EXT_HEIGHT = 0.58642;                                    // int(arrow length × sin 27.5°) in nm, PCB_DIM_ALIGNED's constructor
export const angleOf = (v: Pt) => (v[0] === 0 && v[1] === 0) ? 0 : Math.atan2(v[1], v[0]) * 180 / Math.PI;   // EDA_ANGLE(vector) on screen axes
/** The angle KiCad gives text kept aligned to a direction: 360 − angle, normalised, then turned into the readable half. */
export function readableAngle(v: Pt) { let a = norm360(-angleOf(v)); if (a > 90 && a <= 270) a -= 180; return a; }
/** PCB_DIMENSION_BASE::GetValueText: mm, precision 4, zeroes suppressed, on a value rounded to nanometres. */
export function dimValueText(mm: number) {
  let s = (Math.round(mm * 1e6) / 1e6).toFixed(4);
  while (s.endsWith("0")) { s = s.slice(0, -1); if (s.endsWith(".")) { s = s.slice(0, -1); break; } }
  return s;
}
/** GetVectorSnapped45: the nearest of the 0 / 45 / 90° directions, staying on the grid. */
export function snap45(v: Pt) { return snapVec45(v, false); }
/** GetVectorSnapped45( aVec, only45 ): only45 leaves out the axes (a rectangle drawn with Ctrl is a square). */
export function snapVec45(v: Pt, only45: boolean): Pt {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]);
  if (!only45 && ax > ay * 2) return [v[0], 0]; if (!only45 && ay > ax * 2) return [0, v[1]];
  return ax > ay ? [v[0], Math.sign(v[1]) * ax] : [Math.sign(v[0]) * ay, v[1]];
}
/** GetVectorSnapped90: onto the nearer of the horizontal and vertical axes. */
export function snap90(v: Pt): Pt { return Math.abs(v[0]) > Math.abs(v[1]) ? [v[0], 0] : [0, v[1]]; }
/**
 * Lines, arrows and text of a dimension: PCB_DIM_*::updateGeometry() / updateText() for the OUTSIDE text mode with
 * the text kept aligned.  d = { start, end, height, orientation ("h" | "v"), textPos, text }.  Arrows are [point, angle].
 */
export function dimGeometry(type: string, d: DimSpec, layer: string) {
  const s = d.start, e = d.end; const { size, thick } = textStyle(layer); const lines: Pt[][] = [], arrows: [Pt, number][] = [];
  let text = "", tpos = s.slice(), tang = 0;
  if (type === "aligned" || type === "orthogonal") {
    const h = d.height || 0, dim = vsub(e, s), horiz = d.orientation !== "v"; let ext: Pt, cs: Pt, ce: Pt, value: number;
    if (type === "aligned") { ext = vunit(h > 0 ? [-dim[1], dim[0]] : [dim[1], -dim[0]]); cs = vadd(s, vmul(ext, Math.abs(h))); ce = vadd(e, vmul(ext, Math.abs(h))); value = Math.hypot(dim[0], dim[1]); }
    else { const sg = h < 0 ? -1 : 1; ext = horiz ? [0, sg] : [sg, 0]; cs = horiz ? [s[0], s[1] + h] : [s[0] + h, s[1]]; ce = horiz ? [e[0], cs[1]] : [cs[0], e[1]]; value = Math.abs(horiz ? dim[0] : dim[1]); }
    const extLen = Math.abs(h) - EXT_OFFSET + EXT_HEIGHT;
    lines.push([vadd(s, vmul(ext, EXT_OFFSET)), vadd(s, vmul(ext, EXT_OFFSET + extLen))]);
    if (type === "aligned") lines.push([vadd(e, vmul(ext, EXT_OFFSET)), vadd(e, vmul(ext, EXT_OFFSET + extLen))]);
    else { const e2 = vsub(e, ce), l2 = Math.hypot(e2[0], e2[1]), u2 = vunit(e2); const st = vsub(ce, vmul(u2, EXT_HEIGHT)); lines.push([st, vadd(st, vmul(u2, l2 - EXT_OFFSET + EXT_HEIGHT))]); }
    lines.push([cs, ce]);
    const cb = vsub(ce, cs), cbAng = angleOf(cb); arrows.push([cs, cbAng], [ce, cbAng + 180]);
    const cc = vmul(cb, 0.5), off = thick + size;   // GetEffectiveTextPenWidth() + GetTextHeight() off the crossbar
    if (type === "aligned") { const rot = cc[0] === 0 ? 90 * Math.sign(-cc[1]) : cc[0] < 0 ? -90 : 90; const to = rotator(rot)(cc[0], cc[1]); tpos = vadd(cs, vadd(cc, vmul(vunit(to), off))); tang = readableAngle(cc); }
    else { tpos = vadd(cs, vadd(cc, horiz ? [0, -off] : [-off, 0])); tang = Math.abs(cc[0]) > Math.abs(cc[1]) ? 0 : 90; }
    text = dimValueText(value);
  } else if (type === "radial") {
    lines.push([vsub(s, [0, ARROW_LEN]), vadd(s, [0, ARROW_LEN])], [vsub(s, [ARROW_LEN, 0]), vadd(s, [ARROW_LEN, 0])]);
    const radial = vmul(vunit(vsub(e, s)), ARROW_LEN * 3), knee = vadd(e, radial);   // leader length = 3 arrow lengths
    tpos = d.textPos ? d.textPos.slice() : vadd(knee, [e[0] < s[0] ? -ARROW_LEN * 10 : ARROW_LEN * 10, 0]);   // the drawing tool's first placement
    lines.push([e, knee], [knee, tpos]); arrows.push([e, angleOf(radial)]);
    tang = Math.round(readableAngle(vsub(tpos, knee))); text = "R " + dimValueText(Math.hypot(e[0] - s[0], e[1] - s[1]));
  } else if (type === "leader") {
    const st = vadd(s, vmul(vunit(vsub(e, s)), EXT_OFFSET));
    tpos = d.textPos ? d.textPos.slice() : vadd(e, [e[0] < s[0] ? -ARROW_LEN * 10 : ARROW_LEN * 10, 0]);
    lines.push([st, e], [e, tpos]); arrows.push([st, angleOf(vsub(e, s))]); text = d.text || "";
  } else {   // center: an arm through the centre and the same arm turned by 90°
    const arm = vsub(e, s), arm2: Pt = [-arm[1], arm[0]]; lines.push([vsub(s, arm), vadd(s, arm)], [vsub(s, arm2), vadd(s, arm2)]);
  }
  return { lines, arrows, text, tpos, tang, size, thick };
}
/**
 * A new (dimension …) as DRAWING_TOOL::DrawDimension makes it and PCB_IO_KICAD_SEXPR::format writes it: the type's
 * constructor defaults (a radial's "R " prefix and 3-arrow leader, a leader's "Leader" override in inches), the board's
 * dimension defaults for the measuring types, the layer's text and line defaults (mirrored text on the back), then
 * Update() places the text.  d = { start, end, height, orientation ("h" | "v"), textPos, text, arrowInward, thickness }.
 */
export function dimensionNode(type: string, d: DimSpec, layer: string) {
  const uuid = K.newUuid(), D = DIM_DEFAULTS, measuring = type !== "center" && type !== "leader";
  const node: SNode = ["dimension", ["type", type], ["layer", layer], ["uuid", uuid], ["pts", xy(d.start), xy(d.end)]];
  if (type === "aligned" || type === "orthogonal") node.push(["height", r6(d.height || 0)]);
  if (type === "radial") node.push(["leader_length", r6(ARROW_LEN * 3)]);   // m_arrowLength * 3, before the board's arrow length is set
  if (type === "orthogonal") node.push(["orientation", d.orientation === "v" ? 1 : 0]);
  if (type !== "center") {
    const format: SNode = measuring
      ? ["format", ["prefix", type === "radial" ? "R " : ""], ["suffix", ""], ["units", D.units], ["units_format", D.unitsFormat], ["precision", D.precision]]
      : ["format", ["prefix", ""], ["suffix", ""], ["units", 0], ["units_format", 0], ["precision", 4], ["override_value", d.text == null ? "Leader" : d.text]];
    if (measuring && D.suppressZeroes) format.push(["suppress_zeroes", "yes"]);
    node.push(format);
  }
  const style: SNode = ["style", ["thickness", r6(d.thickness != null ? d.thickness : gfxWidth(layer))], ["arrow_length", r6(D.arrowLength)], ["text_position_mode", measuring ? D.textPosition : 0]];
  if (type === "aligned" || type === "orthogonal") style.push(["arrow_direction", d.arrowInward ? "inward" : "outward"], ["extension_height", EXT_HEIGHT]);   // always written
  if (type === "leader") style.push(["text_frame", 0]);
  style.push(["extension_offset", r6(D.extOffset)]);
  if (measuring ? D.keepAligned : type === "center") style.push(["keep_text_aligned", "yes"]);
  node.push(style);
  if (type === "center") return node;
  // the dimension is its own PCB_TEXT, so the gr_text repeats the item's uuid; Update() fills in the text and its place
  const tp = d.textPos || (type === "leader" ? vadd(d.end, [d.end[0] < d.start[0] ? -10 * D.arrowLength : 10 * D.arrowLength, 0]) : d.start);
  node.push(["gr_text", "", ["at", r6(tp[0]), r6(tp[1]), 0], ["layer", layer], ["uuid", uuid], effectsNode(layer)]);
  const m = dimRead(node);
  if (type === "radial" && !d.textPos) { const k = dimKnee(m); m.textPos = kadd(k, [m.end[0] < m.start[0] ? -10 * m.arrowLength : 10 * m.arrowLength, 0]); }
  dimUpdate(m);
  return dimWrite(node, m);
}

// ---- PCB_DIMENSION_BASE::Update on an existing (dimension …), in internal units (nm) so positions round as pcbnew's:
// the point editor (PCB_POINT_EDITOR's *_DIMENSION_POINT_EDIT_BEHAVIORs) and the Dimension Properties dialog read the
// item with dimRead, change the model, and dimWrite re-runs updateGeometry / updateText into a copy of the node: the
// feature points, height, orientation, leader length and the text (value, position and angle) - nothing else.
export const DIM_UNIT_NAMES = ["in", "mil", "mm"];                  // DIM_UNITS_MODE INCH, MILS, MM; 3 is automatic
export const DIM_UNIT_SUFFIX: Record<string, string> = { in: " in", mil: " mils", mm: " mm" };   // EDA_UNIT_UTILS::GetText
export const DIM_POS_OUTSIDE = 0, DIM_POS_INLINE = 1, DIM_POS_MANUAL = 2;
export const g10 = (v: number) => { const x = +(+v).toPrecision(10); return x === 0 ? 0 : x; };   // FormatDouble2Str for angles
export const kiResize = (v: Pt, len: number): Pt => {   // VECTOR2I::Resize
  if (!v[0] && !v[1]) return [0, 0];
  let nx: number, ny: number; if (Math.abs(v[0]) === Math.abs(v[1])) nx = ny = Math.abs(len) * Math.SQRT1_2;
  else { const l2 = v[0] * v[0] + v[1] * v[1]; nx = Math.sqrt(len * len * v[0] * v[0] / l2); ny = Math.sqrt(len * len * v[1] * v[1] / l2); }
  const sg = Math.sign(len); return [(v[0] < 0 ? -kiRound(nx) : kiRound(nx)) * sg, (v[1] < 0 ? -kiRound(ny) : kiRound(ny)) * sg];
};
/** RotatePoint( VECTOR2I, EDA_ANGLE ): KiCad's turn (clockwise on screen for a positive angle), rounded to nm. */
export function kiRotate(v: Pt, deg: number): Pt {
  const a = norm360(deg);
  if (a === 0) return v.slice(); if (a === 90) return [v[1], -v[0]]; if (a === 180) return [-v[0], -v[1]]; if (a === 270) return [-v[1], v[0]];
  const s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180);
  return [kiRound(v[1] * s + v[0] * c), kiRound(v[1] * c - v[0] * s)];
}
export const kiAngle = (v: Pt) => (v[0] === 0 && v[1] === 0) ? 0 : Math.atan2(v[1], v[0]) * 180 / Math.PI;   // EDA_ANGLE( VECTOR2 )
export const div2 = (v: Pt): Pt => [kiRound(v[0] / 2), kiRound(v[1] / 2)];   // VECTOR2I / 2 (operator/( double ) rounds)
export const ksub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]], kadd = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
/** The item as PCB_DIM_* holds it: points in nm, the format and style, the text's size and pen. */
export function dimRead(node: SNode) {
  const kid = (p: SNode | null, k: string) => (p ? K.kid(p, k) : null), val = (p: SNode | null, k: string, d: string | number) => { const n = kid(p, k); return n && n.length > 1 ? n[1] : d; };
  const fmt = kid(node, "format"), st = kid(node, "style"), gt = kid(node, "gr_text");
  const xs = K.kids(kid(node, "pts") || [], "xy").map((x) => toNm([K.num(x[1]), K.num(x[2])]));
  const ef = kid(gt, "effects"), font = kid(ef, "font"), sz = kid(font, "size"), th = kid(font, "thickness");
  const at = kid(gt, "at"), just = kid(ef, "justify");
  const yesno = (p: SNode | null, k: string, d: boolean) => { const n = kid(p, k); if (!n) return d; return n.length < 2 ? true : K.str(n[1]) !== "no"; };
  const ov = kid(fmt, "override_value");
  return {
    type: K.str(val(node, "type", "aligned")), start: (xs[0] || [0, 0]) as Pt, end: (xs[1] || xs[0] || [0, 0]) as Pt,
    height: Math.round(K.num(val(node, "height", 0)) * NM), orientation: K.num(val(node, "orientation", 0)) ? 1 : 0,
    leaderLength: Math.round(K.num(val(node, "leader_length", 0)) * NM),
    prefix: K.str(val(fmt, "prefix", "")), suffix: K.str(val(fmt, "suffix", "")),
    unitsMode: Math.max(0, Math.min(3, K.num(val(fmt, "units", 3)))), unitsFormat: Math.max(0, Math.min(2, K.num(val(fmt, "units_format", 0)))),
    precision: K.num(val(fmt, "precision", 4)), override: (ov ? K.str(ov[1] == null ? "" : ov[1]) : null) as string | null, suppressZeroes: yesno(fmt, "suppress_zeroes", false),
    thickness: K.num(val(st, "thickness", 0.15)), arrowLength: Math.round(K.num(val(st, "arrow_length", 1.27)) * NM),
    posMode: <number>Math.max(0, Math.min(2, K.num(val(st, "text_position_mode", 0)))), arrowInward: K.str(val(st, "arrow_direction", "outward")) === "inward",
    extHeight: Math.round(K.num(val(st, "extension_height", 0.58642)) * NM), extOffset: Math.round(K.num(val(st, "extension_offset", 0.5)) * NM),
    keepAligned: yesno(st, "keep_text_aligned", false), textFrame: K.num(val(st, "text_frame", 0)),
    text: gt ? K.str(gt[1]) : "", textPos: (at ? toNm([K.num(at[1]), K.num(at[2])]) : xs[0] || [0, 0]) as Pt, textAngle: at && at.length > 3 ? K.num(at[3]) : 0,
    textH: Math.round((sz ? K.num(sz[1]) : 1) * NM), textW: Math.round((sz ? K.num(sz.length > 2 ? sz[2] : sz[1]) : 1) * NM),
    textThick: Math.round((th ? K.num(th[1]) : 0) * NM), bold: yesno(font, "bold", false),
    hJustify: just ? (just.includes("left") ? "left" : just.includes("right") ? "right" : "center") : "center",
  };
}
/** EDA_TEXT::GetEffectiveTextPenWidth for the stroke font. */
export function dimPen(m: DimModel) {
  let pen = m.textThick;
  if (pen <= 1) pen = m.bold ? kiRound(m.textW / 5) : kiRound(m.textW / 8); else if (m.bold) pen = kiRound(pen * 1.6);
  return Math.min(pen, kiRound(Math.min(Math.abs(m.textW), Math.abs(m.textH)) * 0.25));
}
/** The units a dimension shows: its own, or the editor's for automatic. */
export const dimUnits = (m: DimModel) => (m.unitsMode < 3 ? DIM_UNIT_NAMES[m.unitsMode] : (sizeUnits() === "mil" ? "mil" : sizeUnits() === "in" ? "in" : "mm"));
/** PCB_DIMENSION_BASE::GetValueText of a measured value in nm. */
export function dimValueString(m: DimModel, nm: number) {
  const u = dimUnits(m); let p = m.precision;
  if (p >= 6) p = u === "in" ? p - 4 : u === "mil" ? Math.max(0, p - 7) : u === "mm" ? p - 5 : p - 4;
  const v = u === "in" ? nm / 25.4e6 : u === "mil" ? nm / 25400 : nm / 1e6;
  let s = v.toFixed(Math.max(0, p));
  if (m.suppressZeroes && p > 0) while (s.endsWith("0")) { s = s.slice(0, -1); if (s.endsWith(".")) { s = s.slice(0, -1); break; } }
  return s;
}
/** PCB_DIMENSION_BASE::updateText: the override or the value, its units by the format, between prefix and suffix. */
export function dimBaseText(m: DimModel, nm: number) {
  let t = m.override !== null ? m.override : dimValueString(m, nm); const u = dimUnits(m);
  if (m.unitsFormat === 1) t += DIM_UNIT_SUFFIX[u]; else if (m.unitsFormat === 2) t += " (" + DIM_UNIT_SUFFIX[u].trim() + ")";
  return m.prefix + t + m.suffix;
}
/** PCB_DIM_RADIAL::GetKnee. */
export const dimKnee = (m: DimModel) => kadd(m.end, kiResize(ksub(m.end, m.start), m.leaderLength));
/** PCB_DIM_*::Update: the crossbar (aligned / orthogonal), the measured value and the text; m is changed in place. */
export function dimUpdate(m: DimModel) {
  const s = m.start, e = m.end;
  if (m.type === "aligned" || m.type === "orthogonal") {
    let measured: number, cs: Pt, ce: Pt;
    if (m.type === "aligned") {
      const d = ksub(e, s); measured = kiRound(Math.hypot(d[0], d[1]));
      const ext = m.height > 0 ? [-d[1], d[0]] : [d[1], -d[0]]; const off = kiResize(ext, m.height); const dist = [Math.sign(m.height) * off[0], Math.sign(m.height) * off[1]];
      cs = kadd(s, dist); ce = kadd(e, dist);
    } else {
      const horiz = m.orientation === 0; measured = Math.abs(horiz ? e[0] - s[0] : e[1] - s[1]);
      const ext = horiz ? [0, m.height] : [m.height, 0]; const off = kiResize(ext, m.height); const dist = [Math.sign(m.height) * off[0], Math.sign(m.height) * off[1]];
      cs = kadd(s, dist); ce = horiz ? [e[0], cs[1]] : [cs[0], e[1]];
    }
    m.crossbarStart = cs; m.crossbarEnd = ce; m.measured = measured;
    // PCB_DIM_ORTHOGONAL::updateText places the text, then PCB_DIM_ALIGNED::updateText places it again
    const cc = div2(ksub(ce, cs));
    if (m.posMode === DIM_POS_OUTSIDE) {
      const dist = dimPen(m) + m.textH; const rot = cc[0] === 0 ? 90 * Math.sign(-cc[1]) : cc[0] < 0 ? -90 : 90;
      m.textPos = kadd(cs, kadd(cc, kiResize(kiRotate(cc, rot), dist)));
    } else if (m.posMode === DIM_POS_INLINE) m.textPos = kadd(cs, cc);
    if (m.keepAligned) { let a = norm360(360 - kiAngle(cc)); if (a > 90 && a <= 270) a -= 180; m.textAngle = a; }
    m.text = dimBaseText(m, measured);
  } else if (m.type === "radial") {
    const d = ksub(e, s); m.measured = kiRound(Math.hypot(d[0], d[1]));
    if (m.keepAligned) { let a = norm360(360 - kiAngle(ksub(m.textPos, dimKnee(m)))); if (a > 90 && a <= 270) a -= 180; m.textAngle = Math.round(a); }
    m.text = dimBaseText(m, m.measured);
  } else if (m.type === "leader") { m.measured = 0; m.text = dimBaseText(m, 0); }
  else { m.textPos = s.slice(); m.measured = 0; m.text = dimBaseText(m, 0); }
  return m;
}
/**
 * DIM_ALIGNED_TEXT_UPDATER::UpdateTextAfterChange: a manually placed text follows the crossbar it belonged to (the
 * automatic modes have placed it already, and Update() puts them back).  old = { cs, ce, textPos }.
 */
export function dimFollowCrossbar(m: DimModel, old: { cs: Pt; ce: Pt; textPos: Pt }) {
  if (m.posMode !== DIM_POS_MANUAL) return;
  const ncs = m.crossbarStart!, nce = m.crossbarEnd!; if (peqNm(ncs, old.cs) && peqNm(nce, old.ce)) return;
  const rotation = kiAngle(ksub(old.ce, old.cs)) - kiAngle(ksub(nce, ncs)); const T = old.textPos;
  const near = (a: Pt, b: Pt, p: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return a.slice(); const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; return t <= 0 ? a.slice() : t >= 1 ? b.slice() : [kiRound(a[0] + t * dx), kiRound(a[1] + t * dy)]; };
  const proj = near(old.cs, old.ce, T); let pos;
  if (peqNm(proj, old.cs) || peqNm(proj, old.ce)) {   // the text is beyond an end of the crossbar
    const oc = kadd(old.cs, div2(ksub(old.ce, old.cs))), nc = kadd(ncs, div2(ksub(nce, ncs)));   // SEG::Center
    const nearEnd = Math.hypot(T[0] - old.cs[0], T[1] - old.cs[1]) <= Math.hypot(T[0] - old.ce[0], T[1] - old.ce[1]) ? old.cs : old.ce;
    const fromCenter = kiRotate(ksub(T, oc), rotation), fromEnd = kiRotate(ksub(T, nearEnd), rotation);
    const startInDir = (ncs[0] - nc[0]) * fromCenter[0] + (ncs[1] - nc[1]) * fromCenter[1] > 0;
    pos = kadd(startInDir ? ncs : nce, fromEnd);
  } else {
    const L = Math.hypot(old.ce[0] - old.cs[0], old.ce[1] - old.cs[1]); const ratio = Math.hypot(proj[0] - old.cs[0], proj[1] - old.cs[1]) / L;
    const normal = kiRotate(ksub(T, proj), rotation);
    pos = [kiRound(ncs[0] + (nce[0] - ncs[0]) * ratio + normal[0]), kiRound(ncs[1] + (nce[1] - ncs[1]) * ratio + normal[1])];
  }
  if (m.hJustify === "left" || m.hJustify === "right") {   // past vertical, a left / right justification flips
    const side = (a: Pt, b: Pt, p: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; const t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; const lp = [a[0] + t * dx, a[1] + t * dy]; const o = ksub(lp, near(a, b, lp)); return o[0] < 0 || (o[0] === 0 && o[1] > 0); };
    if (side(old.cs, old.ce, T) !== side(ncs, nce, pos)) m.hJustify = m.hJustify === "left" ? "right" : "left";
  }
  m.textPos = pos; dimUpdate(m);
}
export const peqNm = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
/** The node with the model written back: what Update() changes, in the writer's places. */
export function dimWrite(orig: SNode, m: DimModel) {
  const node = clone(orig), mm = (v: number) => r6(v / NM), setKid = (p: SNode, k: string, v: string | number) => { const n = K.kid(p, k); if (n) n[1] = v; return !!n; };
  const pts = K.kid(node, "pts"); if (pts) { const xs = K.kids(pts, "xy"); [m.start, m.end].forEach((p, i) => { if (xs[i]) { xs[i][1] = mm(p[0]); xs[i][2] = mm(p[1]); } }); }
  if (m.type === "aligned" || m.type === "orthogonal") setKid(node, "height", mm(m.height));
  if (m.type === "orthogonal") setKid(node, "orientation", m.orientation);
  if (m.type === "radial") setKid(node, "leader_length", mm(m.leaderLength));
  const st = K.kid(node, "style"); if (st) setKid(st, "text_position_mode", m.posMode);
  const gt = K.kid(node, "gr_text");
  if (gt) {
    gt[1] = m.text; const at = K.kid(gt, "at");
    if (at) { at[1] = mm(m.textPos[0]); at[2] = mm(m.textPos[1]); const a = g10(m.textAngle); if (at.length > 3) at[3] = a; else at.push(a); }
    const ef = K.kid(gt, "effects"), j = ef && K.kid(ef, "justify");
    if (j) { const i = j.findIndex((x) => x === "left" || x === "right"); if (i > 0 && m.hJustify !== "center") j[i] = m.hJustify; }
  }
  return node;
}

// ---- the dimensions' edit points (pcb_point_editor.cpp: DIMENSION_POINTS)
/** EDIT_POINTS of a dimension: start, end, text, crossbar start / end (aligned, orthogonal), knee (radial). */
export function dimEditPoints(node: SNode) {
  const m = dimUpdate(dimRead(node)), P = (p: Pt) => fromNm(p), out = [{ key: "start", p: P(m.start) }, { key: "end", p: P(m.end) }];
  if (m.type === "center") return out;
  out.push({ key: "text", p: P(m.textPos) });
  if (m.type === "aligned" || m.type === "orthogonal") out.push({ key: "cbstart", p: P(m.crossbarStart!) }, { key: "cbend", p: P(m.crossbarEnd!) });
  if (m.type === "radial") out.push({ key: "knee", p: P(dimKnee(m)) });
  return out;
}
/** EDIT_RELATION ANGLE_STEP_45 from `ref` (mm), the free coordinate on the grid when the result lies on an axis. */
export function angle45From(ref: Pt, raw: Pt, grid: ((p: Pt) => Pt) | null | undefined) {
  const sv = snap45(vsub(raw, ref));
  if (grid && (sv[0] === 0 || sv[1] === 0)) { const gp = grid(vadd(ref, sv)); return sv[0] === 0 ? [ref[0], gp[1]] : [gp[0], ref[1]]; }
  return vadd(ref, sv);
}
/**
 * The dimension with handle `key` dragged: `p` is the snapped cursor, `raw` the cursor itself, `grid` aligns a point to
 * the grid (the handles that ignore snapping still keep their grid constraint).  UpdateItem of the type's behaviour.
 */
export function dimEditNode(orig: SNode, key: string, p: Pt, raw: Pt | null | undefined, grid: ((p: Pt) => Pt) | null | undefined) {
  const m = dimUpdate(dimRead(orig)), N = toNm, type = m.type;
  if (type === "aligned" || type === "orthogonal") {
    const old = { cs: m.crossbarStart!, ce: m.crossbarEnd!, textPos: m.textPos.slice() };
    if (key === "cbstart" || key === "cbend") {
      if (type === "aligned") {   // PointOnLine: the handle runs along its feature line; the height is how far, signed
        const base = key === "cbstart" ? m.start : m.end, d = ksub(m.end, m.start), L = Math.hypot(d[0], d[1]); if (!L) return clone(orig);
        const q = N(p), n = [-d[1] / L, d[0] / L]; const t = (q[0] - base[0]) * n[0] + (q[1] - base[1]) * n[1];
        const fl = [kiRound(n[0] * t), kiRound(n[1] * t)];
        m.height = crossZ(fl[0], fl[1], d[0], d[1]) > 0 ? -kiRound(Math.hypot(fl[0], fl[1])) : kiRound(Math.hypot(fl[0], fl[1]));
      } else {   // updateOrthogonalDimension: the axis changes only outside the feature points' box
        const c = N(p), s = m.start, e = m.end; const x0 = Math.min(s[0], e[0]), x1 = Math.max(s[0], e[0]), y0 = Math.min(s[1], e[1]), y1 = Math.max(s[1], e[1]);
        const dA = ksub(c, s), dB = ksub(c, e); const dir = dA[0] * dA[0] + dA[1] * dA[1] < dB[0] * dB[0] + dB[1] * dB[1] ? dA : dB;
        let vert: boolean;
        if (!(c[0] >= x0 && c[0] <= x1 && c[1] >= y0 && c[1] <= y1)) {
          if (x1 === x0) vert = true; else if (y1 === y0) vert = false;
          else if (c[0] > x0 && c[0] < x1) vert = false; else if (c[1] > y0 && c[1] < y1) vert = true;
          else vert = Math.abs(dir[1]) < Math.abs(dir[0]);
          m.orientation = vert ? 1 : 0;
        } else vert = m.orientation === 1;
        m.height = vert ? c[0] - s[0] : c[1] - s[1];
      }
    } else if (key === "start") m.start = N(p);
    else if (key === "end") m.end = N(p);
    else if (key === "text") { m.posMode = DIM_POS_MANUAL; m.textPos = N(p); }
    dimUpdate(m); dimFollowCrossbar(m, old);
  } else if (type === "center") {
    if (key === "start") m.start = N(p); else if (key === "end") m.end = N(angle45From(fromNm(m.start), raw || p, grid));   // Angle45 from the centre, no snapping
    dimUpdate(m);
  } else if (type === "radial") {
    if (key === "start") m.start = N(p);
    else if (key === "end") { const k0 = dimKnee(m); m.end = N(p); const k1 = dimKnee(m); m.textPos = kadd(m.textPos, ksub(k1, k0)); }
    else if (key === "knee") {   // PointOnLine(start, end): on the radius line; the leader length is its distance from the end
      const k0 = dimKnee(m), q = N(raw || p), d = ksub(m.start, m.end), L2 = d[0] * d[0] + d[1] * d[1]; if (!L2) return clone(orig);
      const t = ((q[0] - m.end[0]) * d[0] + (q[1] - m.end[1]) * d[1]) / L2, kp = [kiRound(m.end[0] + d[0] * t), kiRound(m.end[1] + d[1] * t)];
      m.leaderLength = kiRound(Math.hypot(kp[0] - m.end[0], kp[1] - m.end[1]));
      const k1 = dimKnee(m); m.textPos = kadd(m.textPos, ksub(k1, k0));
    } else if (key === "text") m.textPos = N(angle45From(fromNm(dimKnee(m)), raw || p, grid));
    dimUpdate(m);
  } else if (type === "leader") {
    if (key === "start") m.start = N(p);
    else if (key === "end") { const q = N(p); m.textPos = kadd(m.textPos, ksub(q, m.end)); m.end = q; }
    else if (key === "text") m.textPos = N(angle45From(fromNm(m.end), raw || p, grid));
    dimUpdate(m);
  }
  return dimWrite(orig, m);
}
