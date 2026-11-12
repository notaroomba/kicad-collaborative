// pcb-tools/dru.ts — custom design rules (.kicad_dru): DRC_RULES_PARSER, the PCBEXPR condition language and
// DRC_ENGINE::EvalRules for the constraints the web editor uses (length, skew, diff_pair_gap,
// diff_pair_uncoupled, clearance, track_width).  Lengths are in mm.
import type { BoardDoc, DesignSettings, DrcMarker, SAtom } from "./types";
import { arcLength } from "./distances";
import { matchDpSuffix } from "./diffpair";
import { marker, mm4 } from "./drc";
import { approxParallelT, commonParallelProjection } from "./meander";
import { netOf } from "./nets";
import { K, S } from "./state";
import { FUNCS, FUNC_BY_LOWER, MISSING_ARG, callFunc, isKnownProp, netName, propOf } from "./dru-eval";
import type { RuleItem, Val } from "./dru-eval";
import { layerOf } from "./util";

/** A rule's (constraint …): its type and min / opt / max in mm (null when not given). */
export interface DruConstraint { type: string; min: number | null; opt: number | null; max: number | null; options?: string[] }
/** A parsed (rule …). */
export interface DruRule { name: string; condition: string; layer: string | null; severity: string | null; constraints: DruConstraint[]; expr: Expr | null; error: string | null }
/** What a resolved constraint reports: the text as MessageTextFromMinOptMax writes it and the rule's name. */
export interface RuleHit { text: string; name: string; min: number | null; opt: number | null; max: number | null; severity?: string | null }

type Expr = { k: "lit"; v: Val } | { k: "prop"; who: "A" | "B"; name: string } | { k: "call"; who: "A" | "B" | null; fn: string; args: Expr[] }
  | { k: "not"; e: Expr } | { k: "bin"; op: string; a: Expr; b: Expr };

const UNIT: Record<string, number> = { deg: 1, mm: 1, mil: 0.0254, mils: 0.0254, th: 0.0254, in: 25.4, um: 0.001, nm: 1e-6, cm: 10, m: 1000 };
/** A rule value: a number with an optional length unit (mm when there is none, as DRC_RULES_PARSER::parseValue). */
export function druValue(s: unknown): number | null {
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(String(s)); if (!m) return null;
  const u = m[2].toLowerCase(); if (u && !(u in UNIT)) return null;
  return +m[1] * (u ? UNIT[u] : 1);
}

// ---- the condition language (LIBEVAL): || && == != < > <= >= ! ( ), 'strings', numbers with units, A.Prop, A.fn('x')
function tokenize(src: string) {
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') { let j = i + 1, s = ""; while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) j++; s += src[j++]; } if (j >= src.length) throw new Error("Missing closing quote"); out.push("'" + s); i = j + 1; continue; }
    const two = src.slice(i, i + 2); if (["||", "&&", "==", "!=", "<=", ">="].includes(two)) { out.push(two); i += 2; continue; }
    if ("()<>!,".includes(c)) { out.push(c); i++; continue; }
    const m = /^[A-Za-z_0-9.]+/.exec(src.slice(i)); if (!m) throw new Error(`Unexpected '${c}'`);
    out.push(m[0]); i += m[0].length;
  }
  return out;
}
/** PCBEXPR_COMPILER: the condition as an expression tree (throws with KiCad-like messages on a syntax error). */
export function parseCondition(src: string): Expr {
  const t = tokenize(src); let p = 0;
  const peek = () => t[p], eat = (x?: string) => { const v = t[p++]; if (x && v !== x) throw new Error(`Expected '${x}'`); return v; };
  const bin = (next: () => Expr, ops: string[]) => () => { let a = next(); while (ops.includes(peek())) { const op = eat(); a = { k: "bin", op, a, b: next() }; } return a; };
  const primary = (): Expr => {
    const tok = eat(); if (tok === undefined) throw new Error("Unexpected end of expression");
    if (tok === "(") { const e = or(); eat(")"); return e; }
    if (tok === "!") return { k: "not", e: primary() };
    if (tok[0] === "'") { const s = tok.slice(1); return { k: "lit", v: { t: "s", v: s, wild: /[*?]/.test(s) } }; }
    const n = druValue(tok); if (n !== null) return { k: "lit", v: { t: "n", v: n } };
    const m = /^(?:([AB])\.)?([A-Za-z_][A-Za-z_0-9]*)$/.exec(tok); if (!m) throw new Error(`Unrecognized item '${tok}'`);
    const who = (m[1] || null) as "A" | "B" | null;
    if (peek() === "(") {
      eat("("); const args: Expr[] = []; if (peek() !== ")") { args.push(or()); while (peek() === ",") { eat(","); args.push(or()); } } eat(")");
      const fn = FUNC_BY_LOWER.get(m[2].toLowerCase()); if (!fn) throw new Error(`Unrecognized function '${m[2]}'`);   // LIBEVAL looks functions up without case
      const empty = (x: Expr | undefined) => !x || (x.k === "lit" && x.v.t === "s" && x.v.v === "");
      if (MISSING_ARG[fn] && empty(args[0])) throw new Error(MISSING_ARG[fn]);
      if (fn === "fromTo") { if (empty(args[0])) throw new Error("Missing 'from' pad argument (footprint reference designator followed by hyphen and pad number) to fromTo()."); if (empty(args[1])) throw new Error("Missing 'to' pad argument (footprint reference designator followed by hyphen and pad number) to fromTo()."); }
      void FUNCS; return { k: "call", who, fn, args };
    }
    if (!who) throw new Error(`Unrecognized item '${tok}'`);
    if (!isKnownProp(m[2])) throw new Error(`Unrecognized property '${m[2]}'`);
    return { k: "prop", who, name: m[2] };
  };
  const cmp = bin(primary, ["==", "!=", "<", ">", "<=", ">="]);
  const and = bin(cmp, ["&&"]); const or: () => Expr = bin(and, ["||"]);
  const e = or(); if (p < t.length) throw new Error(`Unexpected '${t[p]}'`);
  return e;
}

export type { RuleItem } from "./dru-eval";
/** WildCompareString( pattern, string, false ): * and ? wildcards, case-insensitive. */
export function wildMatch(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); return re.test(s); }
/** wxString::Matches: * and ? wildcards, case-sensitive. */
export function wxMatches(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); return re.test(s); }
/**
 * A.Type: PCBEXPR_TYPE_REF::GetValue returns ENUM_MAP<KICAD_T>'s name of the item's type (EDA_ITEM_DESC,
 * common/eda_item.cpp) — an arc track is a "Track" like a straight one, every dimension but the leader a "Dimension".
 */
export const TYPE_NAME: Record<string, string> = { segment: "Track", arc: "Track", via: "Via", pad: "Pad", zone: "Zone", footprint: "Footprint",
  gr_line: "Graphic", gr_rect: "Graphic", gr_circle: "Graphic", gr_arc: "Graphic", gr_poly: "Graphic", gr_curve: "Graphic", gr_bbox: "Graphic",
  gr_text: "Text", fp_text: "Text", property: "Text", gr_text_box: "Text Box", fp_text_box: "Text Box", table: "Table", table_cell: "Table Cell",
  image: "Reference Image", generated: "Generator", group: "Group", target: "Target", point: "Point", barcode: "Barcode",
  fp_line: "Graphic", fp_rect: "Graphic", fp_circle: "Graphic", fp_arc: "Graphic", fp_poly: "Graphic", fp_curve: "Graphic" };
/** A dimension's type name: PCB_DIM_LEADER_T is "Leader", the aligned, orthogonal, centre and radial ones "Dimension". */
export function typeName(it: RuleItem) {
  if (it.kind === "dimension") { const t = K.kid(it.node, "type"); return t && K.str(t[1]) === "leader" ? "Leader" : "Dimension"; }
  return TYPE_NAME[it.kind] || it.kind;
}
const truth = (v: Val) => v.t === "n" ? v.v !== 0 : v.t === "s" ? v.v !== "" : false;
const num = (b: boolean): Val => ({ t: "n", v: b ? 1 : 0 });
function evalExpr(e: Expr, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null): Val {
  switch (e.k) {
  case "lit": return e.v;
  case "prop": return propOf(doc, s, e.who === "A" ? A : B, e.name, typeName);
  case "not": return num(!truth(evalExpr(e.e, doc, s, A, B)));
  case "bin": {
    if (e.op === "&&") return num(truth(evalExpr(e.a, doc, s, A, B)) && truth(evalExpr(e.b, doc, s, A, B)));
    if (e.op === "||") return num(truth(evalExpr(e.a, doc, s, A, B)) || truth(evalExpr(e.b, doc, s, A, B)));
    const a = evalExpr(e.a, doc, s, A, B), b = evalExpr(e.b, doc, s, A, B);
    if (e.op === "==" || e.op === "!=") {   // VALUE::EqualTo: the right side's wildcards match the left
      let eq = false;
      if (a.t === "n" && b.t === "n") eq = a.v === b.v;
      else if (a.t === "s" && b.t === "s") eq = b.wild ? wildMatch(b.v, a.v) : a.v.toLowerCase() === b.v.toLowerCase();
      return num(e.op === "==" ? eq : !eq && a.t !== "u" && b.t !== "u");
    }
    if (a.t !== "n" || b.t !== "n") return num(false);
    return num(e.op === "<" ? a.v < b.v : e.op === ">" ? a.v > b.v : e.op === "<=" ? a.v <= b.v : a.v >= b.v);
  }
  case "call": {
    const it = e.who === "B" ? B : A;
    const args = e.args.map((x) => { const v = evalExpr(x, doc, s, A, B); return v.t === "s" ? v.v : v.t === "n" ? String(v.v) : ""; });
    return callFunc(e.fn, it, args, { doc, s, A, B, constraint: curConstraint, ver: S.docVer }, wildMatch, wxMatches);
  }
  }
}
/** The constraint EvalRules is resolving (isCoupledDiffPair answers differently for the pair constraints). */
let curConstraint: string | null = null;

/** ProcessAssertions: does the item satisfy the assertion constraint's expression (null when it does not compile)? */
const ASSERT_CACHE = new WeakMap<DruConstraint, Expr | null>();
export function evalAssertion(rule: DruRule, c: DruConstraint, doc: BoardDoc, s: DesignSettings, A: RuleItem): boolean | null {
  let e = ASSERT_CACHE.get(c);
  if (e === undefined) { try { e = parseCondition((c.options || [])[0] || ""); } catch { e = null; } ASSERT_CACHE.set(c, e); }
  if (!e) return null; curConstraint = "assertion"; void rule;
  return truth(evalExpr(e, doc, s, A, null));
}
/** DRC_RULES_PARSER: the file's rules in order; a rule whose condition does not compile carries its error and never matches. */
export function parseDru(text: string): { rules: DruRule[]; errors: string[] } {
  const rules: DruRule[] = [], errors: string[] = [];
  let root: SNode;
  try { root = K.parse("(dru " + (text || "") + "\n)") as SNode; } catch (e) { return { rules, errors: [String((e as Error).message || e)] }; }
  for (const r of root.slice(1)) {
    if (!Array.isArray(r) || r[0] !== "rule") continue;
    const rule: DruRule = { name: K.str(r[1]), condition: "", layer: null, severity: null, constraints: [], expr: null, error: null };
    for (const c of r.slice(2)) {
      if (!Array.isArray(c)) continue;
      if (c[0] === "condition") rule.condition = K.str(c[1]);
      else if (c[0] === "layer") rule.layer = K.str(c[1]);
      else if (c[0] === "severity") rule.severity = K.str(c[1]);
      else if (c[0] === "constraint") {
        const k: DruConstraint = { type: K.str(c[1]), min: null, opt: null, max: null };
        for (const v of c.slice(2)) {
          if (Array.isArray(v) && (v[0] === "min" || v[0] === "opt" || v[0] === "max")) k[v[0] as "min" | "opt" | "max"] = druValue(K.str(v[1]));
          else if (Array.isArray(v) && v.length === 1) (k.options = k.options || []).push(K.str(v[0]));   // (within_diff_pairs)
          else if (!Array.isArray(v)) (k.options = k.options || []).push(K.str(v));
        }
        rule.constraints.push(k);
      }
    }
    if (rule.condition) { try { rule.expr = parseCondition(rule.condition); } catch (e) { rule.error = (e as Error).message; errors.push(`rule '${rule.name}': ${rule.error}`); } }
    rules.push(rule);
  }
  return { rules, errors };
}
const layerOk = (rule: DruRule, layer: string | null | undefined) => {
  if (!rule.layer || !layer) return true;
  if (rule.layer === "outer") return /^(F|B)\.Cu$/.test(layer);
  if (rule.layer === "inner") return /^In\d+\.Cu$/.test(layer);
  return wildMatch(rule.layer, layer);
};
/** Does a rule apply to A (and B)? */
export function ruleMatches(rule: DruRule, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null) {
  if (rule.error) return false;
  if (!layerOk(rule, A ? A.layer || layerOf(A.node) : null)) return false;
  return !rule.expr || truth(evalExpr(rule.expr, doc, s, A, B));
}
/**
 * DRC_ENGINE::EvalRules for one constraint type: the rules are walked last to first and the first that matches and
 * carries the constraint wins (later rules take precedence).  null when no rule gives it.
 */
export function evalRuleConstraint(rules: DruRule[], type: string, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null, fmt?: (mm: number) => string): RuleHit | null {
  curConstraint = type;
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]; const c = r.constraints.find((k) => k.type === type); if (!c) continue;
    if (!ruleMatches(r, doc, s, A, B)) continue;
    const f = fmt || ((v: number) => v.toFixed(4) + " mm"); const parts: string[] = [];
    if (c.min != null && c.min > 0) parts.push("min " + f(c.min));   // MessageTextFromMinOptMax
    if (c.opt != null) parts.push("opt " + f(c.opt));
    if (c.max != null) parts.push("max " + f(c.max));
    return { text: parts.join("; "), name: `rule '${r.name}'`, min: c.min, opt: c.opt, max: c.max, severity: r.severity };
  }
  return null;
}

/**
 * DRC_ENGINE::EvalRules( CLEARANCE_CONSTRAINT, a, b, layer ) over the custom rules: the last rule with a clearance
 * constraint whose condition holds for (A, B) or (B, A) gives the clearance (its min); null when none does, and the
 * netclass clearance applies.  A rule with severity ignore gives 0.
 */
export function ruleClearance(rules: DruRule[], doc: BoardDoc, s: DesignSettings, A: RuleItem, B: RuleItem): { min: number; name: string } | null {
  curConstraint = "clearance";
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i], c = r.constraints.find((k) => k.type === "clearance"); if (!c || c.min == null) continue;
    if (!ruleMatches(r, doc, s, A, B) && !ruleMatches(r, doc, s, B, A)) continue;
    return { min: r.severity === "ignore" ? 0 : c.min, name: `rule '${r.name}'` };
  }
  return null;
}
/**
 * DRC_TEST_PROVIDER_MATCHED_LENGTH for the custom rules: every net whose tracks a rule gives a length constraint is
 * checked as one connection (its routed track length; via heights and pad-to-die lengths are not counted), and the
 * nets one skew rule covers are compared with the longest of them (within_diff_pairs: each pair on its own).
 */
export function matchedLengthMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "length" || c.type === "skew"))) return out;
  const nets = new Map<string, { name: string; ids: string[]; total: number; first: KItem }>();
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc") continue;
    const name = netName(doc, it.node); if (!name) continue;
    const a = K.kid(it.node, "start"), b = K.kid(it.node, "end"); if (!a || !b) continue;
    const A: [number, number] = [K.num(a[1]), K.num(a[2])], B: [number, number] = [K.num(b[1]), K.num(b[2])];
    let L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (it.kind === "arc") { const m = K.kid(it.node, "mid"); const c = m && K.arcFrom3(A, [K.num(m[1]), K.num(m[2])], B); if (c) L = arcLength(c); }
    let n = nets.get(name); if (!n) nets.set(name, n = { name, ids: [], total: 0, first: it });
    n.ids.push(it.id); n.total += L;
  }
  const at = (it: KItem) => { const a = K.kid(it.node, "start")!; return [K.num(a[1]), K.num(a[2])]; };
  const groups = new Map<string, { c: DruConstraint; rule: DruRule; nets: typeof nets extends Map<string, infer V> ? V[] : never }>();
  for (const n of nets.values()) {
    for (let i = rules.length - 1; i >= 0; i--) {   // the rule that gives this net its length constraint
      const r = rules[i], c = r.constraints.find((k) => k.type === "length"); if (!c || !ruleMatches(r, doc, s, n.first, null)) continue;
      if (r.severity === "ignore") break;
      const name = `rule '${r.name}'`, [x, y] = at(n.first);
      if (c.min != null && n.total < c.min - 1e-6) out.push(Object.assign(marker("length_out_of_range", r.severity || "error", x, y, `Track length out of range (${name} min length ${mm4(c.min)}; actual ${mm4(n.total)})`, n.ids.slice())));
      else if (c.max != null && n.total > c.max + 1e-6) out.push(marker("length_out_of_range", r.severity || "error", x, y, `Track length out of range (${name} max length ${mm4(c.max)}; actual ${mm4(n.total)})`, n.ids.slice()));
      break;
    }
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i], c = r.constraints.find((k) => k.type === "skew"); if (!c || !ruleMatches(r, doc, s, n.first, null)) continue;
      if (r.severity === "ignore") break;
      let g = groups.get(r.name + "\u0000" + i); if (!g) groups.set(r.name + "\u0000" + i, g = { c, rule: r, nets: [] }); g.nets.push(n); break;
    }
  }
  for (const g of groups.values()) {
    let sets: (typeof g.nets)[] = [g.nets];
    if (g.c.options && g.c.options.includes("within_diff_pairs")) {
      sets = []; const left = new Map(g.nets.map((n) => [n.name, n]));
      for (const n of g.nets) { if (!left.has(n.name)) continue; const m = matchDpSuffix(n.name); const o = m.rv ? left.get(m.complement) : null; if (o) { sets.push([n, o]); left.delete(n.name); left.delete(o.name); } }
    }
    for (const set of sets) {
      let ref = set[0]; for (const n of set) if (n.total > ref.total) ref = n;
      for (const n of set) {
        const skew = Math.abs(n.total - ref.total), name = `rule '${g.rule.name}'`; let kind = "";
        if (g.c.max != null && skew > g.c.max + 1e-6) kind = "max"; else if (g.c.min != null && n !== ref && skew < g.c.min - 1e-6) kind = "min";
        if (!kind) continue;
        const [x, y] = at(n.first);
        out.push(marker("skew_out_of_range", g.rule.severity || "error", x, y, `Skew between tracks out of range (${name} ${kind} skew ${mm4(kind === "max" ? g.c.max! : g.c.min!)}; actual ${mm4(n.total - ref.total)}; target net length ${mm4(ref.total)} (from ${ref.name}); actual ${mm4(n.total)})`, n.ids.slice()));
      }
    }
  }
  return out.filter((m) => s.severities[m.code] !== "ignore");
}
/**
 * DRC_TEST_PROVIDER_DIFF_PAIR_COUPLING for the custom rules: each differential pair a diff_pair_gap or
 * diff_pair_uncoupled rule covers has its P / N track segments (outside tuning patterns) paired where they run
 * side by side over a common stretch (commonParallelProjection, the gap measured between them less the half widths).
 * The web pairs each P segment with its nearest parallel N segment where KiCad discards pairs another item sits
 * between.  "Differential uncoupled length too long" when the stretch not coupled within the gap exceeds the rule's
 * max; "Differential pair gap out of range" for each pair outside the gap (only when the uncoupled length fails too,
 * or no uncoupled rule applies).
 */
export function diffPairMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "diff_pair_gap" || c.type === "diff_pair_uncoupled"))) return out;
  const inPattern = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "generated") for (const id of K.groupMemberIds(it.node)) inPattern.add(id);
  const byNet = new Map<string, KItem[]>();
  for (const it of doc.items.values()) if (it.kind === "segment" || it.kind === "arc") { const n = netName(doc, it.node); if (n) { let l = byNet.get(n); if (!l) byNet.set(n, l = []); l.push(it); } }
  const xy = (it: KItem, k: string): [number, number] => { const v = K.kid(it.node, k)!; return [K.num(v[1]), K.num(v[2])]; };
  const len = (it: KItem) => { const a = xy(it, "start"), b = xy(it, "end"); if (it.kind === "arc") { const m = xy(it, "mid"); const c = K.arcFrom3(a, m, b); if (c) return arcLength(c); } return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  const width = (it: KItem) => { const w = K.kid(it.node, "width"); return w ? K.num(w[1]) : 0; };
  const find = (type: string, A: KItem, B: KItem) => { for (let i = rules.length - 1; i >= 0; i--) { const r = rules[i], c = r.constraints.find((k) => k.type === type); if (c && ruleMatches(r, doc, s, A, B)) return r.severity === "ignore" ? null : { c, r }; } return null; };
  const at = (it: KItem) => xy(it, "start");
  for (const [name, P] of byNet) {
    const m = matchDpSuffix(name); if (m.rv <= 0) continue; const N = byNet.get(m.complement); if (!N) continue;
    const gapR = find("diff_pair_gap", P[0], N[0]), uncR = find("diff_pair_uncoupled", P[0], N[0]); if (!gapR && !uncR) continue;
    const I = (p: [number, number]) => [p[0] * 1e6, p[1] * 1e6];
    const coupled: { p: KItem; n: KItem; gap: number; len: number; failMin: boolean; failMax: boolean }[] = [];
    for (const sp of P) {
      if (sp.kind !== "segment" || inPattern.has(sp.id)) continue; let best: (typeof coupled)[number] | null = null;
      for (const sn of N) {
        if (sn.kind !== "segment" || inPattern.has(sn.id) || layerOf(sn.node) !== layerOf(sp.node)) continue;
        const a = { A: I(xy(sp, "start")), B: I(xy(sp, "end")) }, b = { A: I(xy(sn, "start")), B: I(xy(sn, "end")) };
        if (!approxParallelT(a, b, 10)) continue;
        const cp = commonParallelProjection(a, b); if (!cp) continue;
        const gap = (Math.hypot(cp.pClip.A[0] - cp.nClip.A[0], cp.pClip.A[1] - cp.nClip.A[1]) - (width(sp) + width(sn)) / 2 * 1e6) / 1e6;
        const L = Math.hypot(cp.nClip.B[0] - cp.nClip.A[0], cp.nClip.B[1] - cp.nClip.A[1]) / 1e6;
        if (!best || gap < best.gap) best = { p: sp, n: sn, gap, len: L, failMin: false, failMax: false };
      }
      if (best) coupled.push(best);
    }
    let totalCoupled = 0;
    for (const d of coupled) {
      const g = gapR && gapR.c; if (g) { d.failMin = g.min != null && g.min >= 0 && d.gap < g.min - 0.0005; d.failMax = g.max != null && g.max >= 0 && d.gap > g.max + 0.0005; }
      if (!d.failMin && !d.failMax) totalCoupled += d.len;
    }
    const sum = (l: KItem[]) => l.filter((it) => !inPattern.has(it.id)).reduce((t, it) => t + len(it), 0);
    const total = Math.max(sum(P), sum(N)), uncoupled = total - totalCoupled; let uncFail = false;
    if (uncR && uncR.c.max != null && uncR.c.max >= 0 && uncoupled > uncR.c.max + 1e-6) {
      uncFail = true; const [x, y] = at(N[0]);
      out.push(marker("diff_pair_uncoupled_length_too_long", uncR.r.severity || "error", x, y, `Differential uncoupled length too long (rule '${uncR.r.name}' maximum uncoupled length ${mm4(uncR.c.max)}; actual ${mm4(uncoupled)})`, P.concat(N).map((it) => it.id)));
    }
    if (gapR && (uncFail || !uncR)) for (const d of coupled) {
      if (!d.failMin && !d.failMax) continue; const [x, y] = at(d.n);
      out.push(marker("diff_pair_gap_out_of_range", gapR.r.severity || "error", x, y, `Differential pair gap out of range (rule '${gapR.r.name}' ${d.failMin ? "minimum" : "maximum"} gap ${mm4(d.failMin ? gapR.c.min! : gapR.c.max!)}; actual ${mm4(d.gap)})`, [d.p.id, d.n.id]));
    }
  }
  return out.filter((mk) => s.severities[mk.code] !== "ignore");
}
