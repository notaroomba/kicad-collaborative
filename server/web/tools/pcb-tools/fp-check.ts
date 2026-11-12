// pcb-tools/fp-check.ts — DIALOG_FOOTPRINT_CHECKER::runChecks (pcbnew/dialogs/dialog_footprint_checker.cpp) on the
// footprint being edited, with FOOTPRINT_UTILS' checks (pcbnew/footprint_utils.cpp) and PAD_UTILS::CheckPad
// (pcbnew/pad_utils.cpp):
//
//   courtyard        malformed (open outline) / missing (unless allow_missing_courtyard)
//   type             attribute vs the pads (FP_SMD / FP_THROUGH_HOLE; severity ignore by default, kept for the setup)
//   pads             CheckPad: hole / layer / property sanity
//   shorting pads    co-located or overlapping holes, copper of different logical pads that touches
//   net ties         net-tie pad groups naming unknown pads or a pad twice
//   clipped silk     silkscreen over the solder mask openings of pads
//
// Severities are BOARD_DESIGN_SETTINGS' defaults with the Footprint Editor's override (missing courtyard: warning).
type SAtom = string | number | SNode;
import type { BoardDoc, Pt } from "./types";
import { K } from "./state";
import { chainLoops } from "./drc";
import { padOutline } from "./fp-pads";
import { rotator } from "./util";

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
export interface FpMarker { code: string; severity: "error" | "warning"; title: string; detail: string; ids: string[]; at: Pt }
/** DRC_ITEM titles of the checks the Footprint Checker runs. */
export const FP_CHECK_TITLES: Record<string, string> = {
  malformed_courtyard: "Footprint has malformed courtyard", missing_courtyard: "Footprint has no courtyard defined",
  footprint_type_mismatch: "Footprint component type doesn't match footprint pads", padstack: "Padstack is questionable",
  through_hole_pad_without_hole: "Through hole pad has no hole", shorting_items: "Items shorting two nets", holes_co_located: "Drilled holes co-located",
  hole_to_hole: "Drilled hole too close to other hole", footprint: "Footprint is not valid", silk_over_copper: "Silkscreen clipped by solder mask",
};
const SEVERITY: Record<string, "error" | "warning" | "ignore"> = { missing_courtyard: "warning", footprint_type_mismatch: "ignore", padstack: "warning", holes_co_located: "warning", hole_to_hole: "warning", silk_over_copper: "warning" };
const sev = (code: string) => SEVERITY[code] || "error";

const layersOf = (n: SNode): string[] => (K.kid(n, "layers") || []).slice(1).map(str);
const onLayer = (ls: string[], l: string) => ls.includes(l) || ls.includes("*." + l.split(".")[1]) || (l.endsWith(".Cu") && (ls.includes("*.Cu") || (ls.includes("F&B.Cu") && (l === "F.Cu" || l === "B.Cu"))));
const atOf = (n: SNode): [number, number, number] => { const a = K.kid(n, "at") || []; return [num(a[1]), num(a[2]), num(a[3])]; };
function drill(n: SNode): { w: number; h: number; oval: boolean } { const d = K.kid(n, "drill"); if (!d) return { w: 0, h: 0, oval: false }; const v = d.slice(1).filter((x: SAtom) => typeof x === "number") as number[]; return { w: v[0] || 0, h: v[1] ?? v[0] ?? 0, oval: d.includes("oval") }; }
const PAD_TYPE: Record<string, string> = { thru_hole: "Through-hole", smd: "SMD", np_thru_hole: "NPTH", connect: "Connector", non_component: "Non-component" };
const prop = (n: SNode) => str((K.kid(n, "property") || [])[1]);

/** PAD_UTILS::CheckPad (outside the Pad Properties dialog): the messages for one pad, each with its DRC code. */
export function checkPad(n: SNode): { code: string; msg: string }[] {
  const out: { code: string; msg: string }[] = []; const attr = str(n[2]); const t = PAD_TYPE[attr] || attr; const ls = layersOf(n); const d = drill(n);
  const has = (l: string) => onLayer(ls, l);
  const P = (msg: string) => out.push({ code: "padstack", msg });
  const techSide = () => {
    if ((has("F.Cu") && has("B.Mask")) || (has("B.Cu") && has("F.Mask"))) P(`${t} pad has copper and mask layers on different sides of the board`);
    if ((has("F.Cu") && has("B.Paste")) || (has("B.Cu") && has("F.Paste"))) P(`${t} pad has copper and paste layers on different sides of the board`);
  };
  const s = K.kid(n, "size"); if (s && (num(s[1]) <= 0 || num(s[2]) <= 0) && str(n[3]) !== "custom") P("Pad size must be greater than zero");
  if (!has("F.Cu") && !has("B.Cu") && (d.w || d.h) && attr !== "np_thru_hole") P("plated through holes normally have a copper pad on at least one outer layer");
  const pr = prop(n);
  if ((pr === "pad_prop_fiducial_glob" || pr === "pad_prop_fiducial_loc") && attr === "np_thru_hole") P("'fiducial' pads are normally plated");
  if (pr === "pad_prop_testpoint" && attr === "np_thru_hole") P("'testpoint' pads are normally plated");
  if (pr === "pad_prop_heatsink" && attr === "np_thru_hole") P("'heatsink' pads are normally plated");
  if (pr === "pad_prop_castellated" && attr !== "thru_hole") P("'castellated' pads are normally PTH");
  if (pr === "pad_prop_bga" && attr !== "smd") P("'BGA' property is for SMD pads");
  if (pr === "pad_prop_mechanical" && attr !== "thru_hole") P("'mechanical' pads are normally PTH");
  if (pr === "pad_prop_pressfit" && (attr !== "thru_hole" || d.w <= 0)) P("'press-fit' pads are normally PTH with round holes");
  const cu = ls.filter((l) => /\.Cu$/.test(l));
  const cuCount = cu.some((l) => l === "*.Cu") ? 2 : cu.some((l) => l === "F&B.Cu") ? 2 : cu.length;
  if (attr === "np_thru_hole" || attr === "thru_hole") { if (d.w <= 0 || (d.h <= 0 && d.oval)) out.push({ code: "through_hole_pad_without_hole", msg: "" }); }
  else if (attr === "connect" || attr === "smd") {
    if (attr === "connect" && (has("F.Paste") || has("B.Paste"))) P("connector pads normally have no solder paste; use a SMD pad instead");
    if (d.w > 0 || d.h > 0) P(`${t} pad has a hole`);
    if (cuCount > 1) P(`${t} pad has more than one copper layer`);
    if (cuCount) { if (!has("F.Cu") && !has("B.Cu")) P(`${t} pad has no outer layers`); techSide(); }
  } else if (attr === "non_component") {
    if (d.w > 0 || d.h > 0) P(`${t} pad has a hole`);
    if (!cuCount) P(`${t} pad has no copper layers`);
  }
  return out;
}

const pip = (p: Pt, pts: Pt[]) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const cross = (a: Pt, b: Pt, c: Pt, d: Pt) => { const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
/** Two closed outlines touch (one inside the other, or edges cross); the point is where. */
function polysTouch(a: Pt[], b: Pt[]): Pt | null {
  for (const p of a) if (pip(p, b)) return p;
  for (const p of b) if (pip(p, a)) return p;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) if (cross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return a[i];
  return null;
}
function holeSeg(n: SNode): { a: Pt; b: Pt; r: number } | null {
  const d = drill(n); if (d.w <= 0) return null; const [x, y, ang] = atOf(n);
  const w = d.w, h = d.oval ? d.h : d.w; const R = rotator(ang);
  if (w === h) return { a: [x, y], b: [x, y], r: w / 2 };
  const half = Math.abs(w - h) / 2; const v = w > h ? R(half, 0) : R(0, half);
  return { a: [x - v[0], y - v[1]], b: [x + v[0], y + v[1]], r: Math.min(w, h) / 2 };
}
function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (cross(a, b, c, d)) return 0;
  const ps = (p: Pt, s: Pt, e: Pt) => { const dx = e[0] - s[0], dy = e[1] - s[1]; const l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l)) : 0; return Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dy); };
  return Math.min(ps(a, c, d), ps(b, c, d), ps(c, a, b), ps(d, a, b));
}
/** Polygon of a footprint graphic with its stroke (for the silk / mask test): sampled outline points. */
function graphicPoints(n: SNode): Pt[] {
  const k = str(n[0]); const p = (key: string): Pt | null => { const c = K.kid(n, key); return c ? [num(c[1]), num(c[2])] : null; };
  if (k === "gr_poly" || k === "gr_curve") return ((K.kid(n, "pts") || []).slice(1) as SNode[]).filter((xy) => Array.isArray(xy) && xy[0] === "xy").map((xy) => [num(xy[1]), num(xy[2])] as Pt);
  if (k === "gr_rect") { const a = p("start"), b = p("end"); return a && b ? [a, [b[0], a[1]], b, [a[0], b[1]]] : []; }
  if (k === "gr_circle") { const c = p("center"), e = p("end"); if (!c || !e) return []; const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const o: Pt[] = []; for (let i = 0; i < 32; i++) o.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); return o; }
  if (k === "gr_text" || k === "property") { const a = K.kid(n, "at"); return a ? [[num(a[1]), num(a[2])]] : []; }
  return ["start", "mid", "end"].map(p).filter(Boolean) as Pt[];
}
/** The mask opening of a pad: its outline grown by the mask margin (pad, else footprint, else 0). */
function maskOutline(pad: SNode, fpMargin: number): Pt[] {
  const m = K.kid(pad, "solder_mask_margin"); const g = m ? num(m[1]) : fpMargin;
  if (!g) return padOutline(pad);
  const n = (K.cloneNode as (x: SNode) => SNode)(pad); const s = K.kid(n, "size"); if (s) { s[1] = num(s[1]) + 2 * g; s[2] = num(s[2]) + 2 * g; }
  return padOutline(n);
}

/** DIALOG_FOOTPRINT_CHECKER::runChecks. */
export function checkFootprint(doc: BoardDoc): FpMarker[] {
  const out: FpMarker[] = [];
  const add = (code: string, detail: string, ids: string[], at: Pt) => { const s = sev(code); if (s === "ignore") return; out.push({ code, severity: s, title: FP_CHECK_TITLES[code] || code, detail, ids, at }); };
  const header = ((doc as unknown as { fpState?: { fp: SNode } }).fpState || { fp: ["footprint", ""] as SNode }).fp;
  const attrs = (K.kid(header, "attr") || []).slice(1).map(str);
  const items = Array.from(doc.items.values());
  const pads = items.filter((i) => i.kind === "pad");
  // BuildCourtyardCaches: each side's courtyard shapes must chain into closed outlines
  for (const side of ["F.CrtYd", "B.CrtYd"]) {
    const chains: Pt[][] = [];
    for (const it of items) {
      if (!/^gr_(line|rect|circle|arc|poly)$/.test(it.kind) || str((K.kid(it.node, "layer") || [])[1]) !== side) continue;
      const pts = graphicPoints(it.node); if (pts.length < 2) continue;
      chains.push(/^gr_(rect|circle|poly)$/.test(it.kind) ? pts.concat([pts[0]]) : pts);
    }
    if (!chains.length) continue;
    const { dangling } = chainLoops(chains);
    if (dangling) add("malformed_courtyard", `(not a closed shape)`, [], [0, 0]);
  }
  const hasCrtYd = items.some((i) => ["F.CrtYd", "B.CrtYd"].includes(str((K.kid(i.node, "layer") || [])[1])));
  if (!attrs.includes("allow_missing_courtyard") && !hasCrtYd) add("missing_courtyard", "", [], [0, 0]);
  // CheckFootprintAttributes: GetLikelyAttribute (any plated hole: through hole; else any SMD pad: SMD)
  const likely = pads.some((p) => str(p.node[2]) === "thru_hole") ? "through_hole" : pads.some((p) => str(p.node[2]) === "smd") ? "smd" : "";
  const set = attrs.includes("through_hole") ? "through_hole" : attrs.includes("smd") ? "smd" : "";
  if (set && likely && set !== likely) add("footprint_type_mismatch", `(expected '${likely === "smd" ? "SMD" : "Through hole"}'; actual '${set === "smd" ? "SMD" : "Through hole"}')`, [], [0, 0]);
  for (const p of pads) for (const r of checkPad(p.node)) { const [x, y] = atOf(p.node); add(r.code, r.msg ? `(${r.msg})` : "", [p.id], [x, y]); }
  // CheckShortingPads
  const netTie = (K.kid(header, "net_tie_pad_groups") || []).slice(1).map((g: SAtom) => str(g).split(/[,\s]+/).filter(Boolean));
  const tied = (a: string, b: string) => netTie.some((g: string[]) => g.includes(a) && g.includes(b));
  for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) {
    const a = pads[i].node, b = pads[j].node; const pa = atOf(a), pb = atOf(b);
    const ha = holeSeg(a), hb = holeSeg(b);
    if (ha && hb) {
      if (Math.abs(pa[0] - pb[0]) < 1e-6 && Math.abs(pa[1] - pb[1]) < 1e-6) add("holes_co_located", "", [pads[i].id, pads[j].id], [pa[0], pa[1]]);
      else if (segSeg(ha.a, ha.b, hb.a, hb.b) < ha.r + hb.r) add("hole_to_hole", "", [pads[i].id, pads[j].id], [pa[0], pa[1]]);
    }
    const na = str(a[1]), nb = str(b[1]);
    if ((na && na === nb) || tied(na, nb)) continue;   // SameLogicalPadAs / net-tie pads
    const la = layersOf(a), lb = layersOf(b);
    const cu = ["F.Cu", "B.Cu", ...Array.from({ length: 30 }, (_, k) => `In${k + 1}.Cu`)];
    if (!cu.some((l) => onLayer(la, l) && onLayer(lb, l))) continue;
    const hit = polysTouch(padOutline(a), padOutline(b)); if (hit) add("shorting_items", "", [pads[i].id, pads[j].id], hit);
  }
  if (netTie.length) {
    const nums = new Set(pads.map((p) => str(p.node[1]))); const seen = new Set<string>();
    for (const g of netTie) for (const n of g) {
      if (!nums.has(n)) add("footprint", `(net-tie pad group contains unknown pad number ${n})`, [], [0, 0]);
      else if (seen.has(n)) add("footprint", `(pad ${n} appears in more than one net-tie pad group)`, [], [0, 0]);
      else seen.add(n);
    }
  }
  // CheckClippedSilk: silk graphics over a pad's mask opening on the same side
  const fpMask = num((K.kid(header, "solder_mask_margin") || [])[1]);
  for (const g of items) {
    if (!/^gr_(line|rect|circle|arc|poly|curve)$/.test(g.kind)) continue;
    const gl = str((K.kid(g.node, "layer") || [])[1]); if (gl !== "F.SilkS" && gl !== "B.SilkS") continue;
    const mask = gl === "F.SilkS" ? "F.Mask" : "B.Mask"; const pts = graphicPoints(g.node); if (!pts.length) continue;
    const closed = /^gr_(rect|circle|poly)$/.test(g.kind); const st = K.kid(g.node, "stroke"); const w = st ? num((K.kid(st, "width") || [])[1]) : 0;
    for (const p of pads) {
      if (!onLayer(layersOf(p.node), mask)) continue;
      const mo = maskOutline(p.node, fpMask); let hit: Pt | null = null;
      for (const q of pts) if (pip(q, mo)) { hit = q; break; }
      if (!hit) for (let i = 0; i + (closed ? 0 : 1) < pts.length && !hit; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; for (let j = 0; j < mo.length; j++) if (segSeg(a, b, mo[j], mo[(j + 1) % mo.length]) <= w / 2) { hit = a; break; } }
      if (!hit && closed && pip(mo[0], pts)) hit = mo[0];
      if (hit) add("silk_over_copper", "", [g.id, p.id], hit);
    }
  }
  return out;
}

export const fpCheckApi = { checkFootprint, checkPad, FP_CHECK_TITLES };
