// pcb-tools/fp-users.ts — DIALOG_FOOTPRINT_USERS' query (eeschema/eeschema.cpp filterFootprintUsers): the symbols of
// the symbol libraries that use a footprint, in three independent ways —
//   a footprint filter selects it   (ki_fp_filters, EDA_PATTERN_MATCH_WILDCARD_ANCHORED, FootprintFilterMatchesName)
//   its footprint field names it    (the nearest non-empty Footprint field up the `extends` chain, LIB_ID compare)
//   one of its pin maps is bound    (associated_footprints, own or inherited)
// A reference without a nickname matches any library; names compare case-insensitively.
type SAtom = string | number | SNode;
import { K } from "./state";

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
export interface FpUsersQuery { lib: string; name: string; filters?: boolean; field?: boolean; pinMaps?: boolean; max?: number }
export interface FpUserMatch { lib: string; symbol: string; pins: number; derived: boolean; filter: string; field: boolean; pinMaps: string[] }
export const MAX_USER_RESULTS = 400;

const splitId = (id: string): [string, string] => { const i = id.indexOf(":"); return i < 0 ? ["", id] : [id.slice(0, i), id.slice(i + 1)]; };
/** footprintReferenceMatches */
export function referenceMatches(ref: string, lib: string, name: string): boolean {
  const [rl, rn] = splitId(ref);
  if (!rn || rn.toLowerCase() !== name.toLowerCase()) return false;
  return !rl || !lib || rl.toLowerCase() === lib.toLowerCase();
}
/** EDA_PATTERN_MATCH_WILDCARD_ANCHORED on FootprintFilterMatchesName's candidate ("lib:name" when the filter has a ':'). */
export function filterMatches(filter: string, lib: string, name: string): boolean {
  const pat = filter.toLowerCase();
  const cand = (pat.includes(":") ? lib.toLowerCase() + ":" : "") + name.toLowerCase();
  const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(cand);
}
const prop = (s: SNode, key: string): string => { for (const k of K.kids(s, "property")) if (str(k[1]) === key) return str(k[2]); return ""; };
/** LIB_SYMBOL::GetPinCount: every pin of every unit and body style. */
export function pinCount(s: SNode): number {
  let n = 0; const walk = (x: SNode) => { for (const c of x) if (Array.isArray(c)) { if (c[0] === "pin") n++; else if (c[0] === "symbol") walk(c as SNode); } }; walk(s); return n;
}

/** Every symbol of the libraries that uses the footprint (in library, then symbol order, natural-number aware). */
export function footprintUsers(libs: { nickname: string; tree: SNode }[], q: FpUsersQuery): { matches: FpUserMatch[]; limited: boolean } {
  const wantFilter = q.filters !== false, wantField = q.field !== false, wantMap = q.pinMaps !== false, max = q.max === undefined ? MAX_USER_RESULTS : q.max;
  const out: FpUserMatch[] = []; let limited = false;
  if (!q.name || (!wantFilter && !wantField && !wantMap)) return { matches: out, limited };
  for (const lib of libs) {
    const syms = K.kids(lib.tree, "symbol") as SNode[];
    const byName = new Map(syms.map((s) => [str(s[1]), s]));
    const parentOf = (s: SNode): SNode | null => { const e = K.kid(s, "extends"); return e ? byName.get(str(e[1])) || null : null; };
    const effFootprint = (s: SNode, depth = 0): string => { const t = prop(s, "Footprint"); if (t || depth > 16) return t; const p = parentOf(s); return p ? effFootprint(p, depth + 1) : ""; };
    const effAssoc = (s: SNode, depth = 0): SNode[] => { const a = K.kid(s, "associated_footprints"); if (a) return K.kids(a, "footprint") as SNode[]; const p = depth < 16 ? parentOf(s) : null; return p ? effAssoc(p, depth + 1) : []; };
    for (const s of syms) {
      const m: FpUserMatch = { lib: lib.nickname, symbol: str(s[1]), pins: 0, derived: !!K.kid(s, "extends"), filter: "", field: false, pinMaps: [] };
      let filt = prop(s, "ki_fp_filters"); if (!filt) { const p = parentOf(s); if (p) filt = prop(p, "ki_fp_filters"); }
      for (const f of filt.split(/\s+/)) if (f && filterMatches(f, q.lib, q.name)) { m.filter = f; break; }
      const fpText = effFootprint(s); if (fpText && referenceMatches(fpText, q.lib, q.name)) m.field = true;
      for (const a of effAssoc(s)) if (referenceMatches(str(a[1]), q.lib, q.name)) { const mp = K.kid(a, "map"); m.pinMaps.push(mp ? str(mp[1]) : ""); }
      if (!m.filter && !m.field && !m.pinMaps.length) continue;
      if (!((wantFilter && m.filter) || (wantField && m.field) || (wantMap && m.pinMaps.length))) continue;
      if (max > 0 && out.length >= max) { limited = true; break; }
      const root = (() => { let r = s; for (let i = 0, p = parentOf(r); p && i < 16; i++, p = parentOf(r)) r = p; return r; })();
      m.pins = pinCount(root === s ? s : root); out.push(m);
    }
    if (limited) break;
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  out.sort((a, b) => cmp(a.lib, b.lib) || cmp(a.symbol, b.symbol));
  return { matches: out, limited };
}
/** The status line under the list. */
export function usersStatus(n: number, limited: boolean): string {
  return limited ? `This footprint is referenced by more than ${n} symbols` : `This footprint is referenced by ${n} symbols`;
}
export const fpUsersApi = { footprintUsers, usersStatus, filterMatches, referenceMatches, pinCount, MAX_USER_RESULTS };
