// pcb-tools/dru.ts — custom design rules (.kicad_dru): DRC_RULES_PARSER, the PCBEXPR condition language and
// DRC_ENGINE::EvalRules for the constraints the web editor uses (length, skew, diff_pair_gap,
// diff_pair_uncoupled, clearance, track_width).  Lengths are in mm.
import type { BoardDoc, DesignSettings, SAtom } from "./types";
import { matchDpSuffix } from "./diffpair";
import { netclassName } from "./drc";
import { boardNets } from "./changes";
import { netOf } from "./nets";
import { K } from "./state";
import { layerOf } from "./util";

/** A rule's (constraint …): its type and min / opt / max in mm (null when not given). */
export interface DruConstraint { type: string; min: number | null; opt: number | null; max: number | null }
/** A parsed (rule …). */
export interface DruRule { name: string; condition: string; layer: string | null; severity: string | null; constraints: DruConstraint[]; expr: Expr | null; error: string | null }
/** What a resolved constraint reports: the text as MessageTextFromMinOptMax writes it and the rule's name. */
export interface RuleHit { text: string; name: string; min: number | null; opt: number | null; max: number | null; severity?: string | null }

type Val = { t: "n"; v: number } | { t: "s"; v: string; wild: boolean } | { t: "u" };
type Expr = { k: "lit"; v: Val } | { k: "prop"; who: "A" | "B"; name: string } | { k: "call"; who: "A" | "B" | null; fn: string; args: Expr[] }
  | { k: "not"; e: Expr } | { k: "bin"; op: string; a: Expr; b: Expr };

const UNIT: Record<string, number> = { mm: 1, mil: 0.0254, mils: 0.0254, th: 0.0254, in: 25.4, um: 0.001, nm: 1e-6, cm: 10, m: 1000 };
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
    if (peek() === "(") { eat("("); const args: Expr[] = []; if (peek() !== ")") { args.push(or()); while (peek() === ",") { eat(","); args.push(or()); } } eat(")"); return { k: "call", who, fn: m[2], args }; }
    if (!who) throw new Error(`Unrecognized item '${tok}'`);
    return { k: "prop", who, name: m[2] };
  };
  const cmp = bin(primary, ["==", "!=", "<", ">", "<=", ">="]);
  const and = bin(cmp, ["&&"]); const or: () => Expr = bin(and, ["||"]);
  const e = or(); if (p < t.length) throw new Error(`Unexpected '${t[p]}'`);
  return e;
}

/** The board item an expression's A / B stands for, with what its properties read. */
export interface RuleItem { kind: string; node: SNode; layer?: string | null }
/** WildCompareString( pattern, string, false ): * and ? wildcards, case-insensitive. */
export function wildMatch(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); return re.test(s); }
const TYPE_NAME: Record<string, string> = { segment: "Track", arc: "Arc", via: "Via", pad: "Pad", zone: "Zone", footprint: "Footprint", gr_line: "Graphic", gr_rect: "Graphic", gr_circle: "Graphic", gr_arc: "Graphic", gr_poly: "Graphic", gr_text: "Text", generated: "Generator" };
function propOf(doc: BoardDoc, s: DesignSettings, it: RuleItem | null, name: string): Val {
  if (!it) return { t: "u" };
  const key = name.replace(/_/g, "").toLowerCase(); const net = () => netOf(it.node).name || "";
  const str = (v: string): Val => ({ t: "s", v, wild: false });
  switch (key) {
  case "type": return str(TYPE_NAME[it.kind] || it.kind);
  case "net": case "netname": return str(net());
  case "netcode": return { t: "n", v: netOf(it.node).code || 0 };
  case "netclass": return str(netclassName(s, net()));
  case "layer": return str(it.layer || layerOf(it.node) || "");
  case "width": { const w = K.kid(it.node, "width"); return w ? { t: "n", v: K.num(w[1]) } : { t: "u" }; }
  case "reference": { const p = (it.node as SNode[]).find((c) => Array.isArray(c) && c[0] === "property" && K.str(c[1]) === "Reference"); return p ? str(K.str(p[2])) : { t: "u" }; }
  default: return { t: "u" };
  }
}
const truth = (v: Val) => v.t === "n" ? v.v !== 0 : v.t === "s" ? v.v !== "" : false;
const num = (b: boolean): Val => ({ t: "n", v: b ? 1 : 0 });
function evalExpr(e: Expr, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null): Val {
  switch (e.k) {
  case "lit": return e.v;
  case "prop": return propOf(doc, s, e.who === "A" ? A : B, e.name);
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
    const it = e.who === "B" ? B : A; const arg = e.args[0] ? evalExpr(e.args[0], doc, s, A, B) : { t: "u" } as Val; const as = arg.t === "s" ? arg.v : arg.t === "n" ? String(arg.v) : "";
    switch (e.fn) {
    case "inDiffPair": {   // the net's base name (suffix character out) matches, with or without a trailing '_'
      if (!it || !as) return num(false); const name = netOf(it.node).name || ""; const m = matchDpSuffix(name);
      if (!m.rv || !boardNets(doc).some((n) => n.name === m.complement)) return num(false);
      let i = name.length - 1; while (i >= 0 && (/[0-9_]/.test(name[i]))) i--; const base = name.slice(0, i) + name.slice(i + 1);
      return num(wildMatch(as, base) || (base.endsWith("_") && wildMatch(as, base.slice(0, base.lastIndexOf("_")))));
    }
    case "hasNetclass": return num(!!it && wildMatch(as, netclassName(s, netOf(it.node).name || "")));
    case "existsOnLayer": { if (!it) return num(false); const L = K.kid(it.node, "layers"); const ls = L ? L.slice(1).map((x) => K.str(x)) : [layerOf(it.node)]; return num(ls.some((l) => wildMatch(as, l) || (l.startsWith("*") && wildMatch(as.replace(/^[^.]*/, "*"), l)))); }
    case "isPlated": return num(!!it && (it.kind === "via" || (it.kind === "pad" && K.str((it.node as SAtom[])[2]) === "thru_hole")));
    default: return { t: "u" };
    }
  }
  }
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
        for (const v of c.slice(2)) if (Array.isArray(v) && (v[0] === "min" || v[0] === "opt" || v[0] === "max")) k[v[0] as "min" | "opt" | "max"] = druValue(K.str(v[1]));
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
