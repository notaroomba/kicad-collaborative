// pcb-tools/find.ts — the search behind the board editor's Find dialog (pcbnew/dialogs/dialog_find.cpp):
// EDA_ITEM::Matches (common/eda_item.cpp) for the plain, whole-word and wildcard modes, and DIALOG_FIND::search's
// hit list, in its order: footprints (reference, value, other text, fields), board texts, zones, DRC markers, nets.
import { fieldIsHidden } from "./changes";
import { K } from "./state";
import type { BoardDoc } from "./types";

export interface FindOptions {
  findString: string;
  matchCase?: boolean;
  /** EDA_SEARCH_MATCH_MODE::WHOLEWORD (wins over wildcards, as DIALOG_FIND::search sets it) */
  wholeWord?: boolean;
  wildcards?: boolean;
  /** Include hidden fields (EDA_SEARCH_DATA::searchAllFields) */
  hiddenFields?: boolean;
  references?: boolean; values?: boolean; texts?: boolean; markers?: boolean; nets?: boolean;
}
export type FindHit =
  | { kind: "item"; id: string; what: "footprint" | "text" | "zone" }
  | { kind: "marker"; index: number; x: number; y: number; text: string }
  | { kind: "net"; name: string; code: number };

/** UnescapeString (common/string_utils.cpp) for the escapes a board's texts carry. */
export function unescapeKiCad(s: string): string {
  const map: Record<string, string> = { dblquote: "\"", quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{" };
  return String(s).replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? map[k] : m));
}
const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);
/** wxString::Matches: '*' any run, '?' one character, the whole string. */
function wildcardMatch(text: string, pat: string): boolean {
  const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$", "u");
  return re.test(text);
}
/** EDA_ITEM::Matches( aText, aSearchData ). */
export function edaMatches(aText: string, o: FindOptions): boolean {
  let text = String(aText ?? ""), search = String(o.findString ?? "");
  if (!o.matchCase) { text = text.toUpperCase(); search = search.toUpperCase(); }
  if (o.wholeWord) {
    if (!search) return false;
    let ii = 0;
    while (ii < text.length) {
      let next = text.indexOf(search, ii);
      if (next < 0) return false;
      ii = next; next += search.length;
      const startOK = ii === 0 || !isWordChar(text[ii - 1]);
      const endOK = next === text.length || !isWordChar(text[next]);
      if (startOK && endOK) return true;
      ii++;
    }
    return false;
  }
  if (o.wildcards) return wildcardMatch(text, search);
  return text.includes(search);
}

/** A footprint's fields as PCB_FIELDs: (property …) in the current format, fp_text reference|value in older files. */
function fieldsOf(fp: SNode): { name: string; text: string; hidden: boolean }[] {
  const out: { name: string; text: string; hidden: boolean }[] = [];
  for (const p of K.kids(fp, "property")) out.push({ name: K.str(p[1]), text: K.str(p[2]), hidden: fieldIsHidden(p) });
  for (const t of K.kids(fp, "fp_text")) { const k = K.str(t[1]); if (k === "reference" || k === "value") out.push({ name: k === "reference" ? "Reference" : "Value", text: K.str(t[2]), hidden: fieldIsHidden(t) }); }
  return out;
}
/** PCB_FIELD::Matches: a hidden field only with "Include hidden fields". */
const fieldMatches = (f: { text: string; hidden: boolean }, o: FindOptions) => (!f.hidden || !!o.hiddenFields) && edaMatches(unescapeKiCad(f.text), o);

/** NETINFO_LIST iterates NETNAMES_MAP (std::map<wxString, NETINFO_ITEM*>): the nets in wxString order, which
 *  compares code points (std::wstring on Linux and macOS), not UTF-16 units. */
export function netNameCmp(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b), n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) { const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
}
/** The marker list and the nets: the DRC run's markers (pcb state) and the board's nets (walked in net-name order). */
export interface FindSources { markers?: { x: number; y: number; text: string; title?: string }[]; nets?: { name: string; code: number }[] }

/** DIALOG_FIND::search's hit list for the options (m_hitList, in the order the dialog walks it). */
export function boardFindHits(doc: BoardDoc, o: FindOptions, src: FindSources = {}): FindHit[] {
  const hits: FindHit[] = []; if (!o.findString) return hits;
  const on = (v: boolean | undefined) => v !== false;
  const items = Array.from(doc.items.values());
  if (on(o.texts) || on(o.values) || on(o.references)) {
    for (const it of items) {
      if (it.kind !== "footprint") continue;
      const fields = fieldsOf(it.node);
      const ref = fields.find((f) => f.name === "Reference"), val = fields.find((f) => f.name === "Value");
      let found = false;
      if (on(o.references) && ref && fieldMatches(ref, o)) found = true;
      if (!found && on(o.values) && val && fieldMatches(val, o)) found = true;
      if (!found && on(o.texts)) for (const t of K.kids(it.node, "fp_text")) { const k = K.str(t[1]); if (k !== "reference" && k !== "value" && edaMatches(unescapeKiCad(K.str(t[2])), o)) { found = true; break; } }
      if (!found && on(o.texts)) for (const f of fields) if (fieldMatches(f, o)) { found = true; break; }
      if (found) hits.push({ kind: "item", id: it.id, what: "footprint" });
    }
    if (on(o.texts)) {
      for (const it of items) if (it.kind === "gr_text" && edaMatches(unescapeKiCad(K.str(it.node[1])), o)) hits.push({ kind: "item", id: it.id, what: "text" });
      for (const it of items) if (it.kind === "zone") { const nm = K.kid(it.node, "name"); if (edaMatches(nm ? K.str(nm[1]) : "", o)) hits.push({ kind: "item", id: it.id, what: "zone" }); }
    }
  }
  if (on(o.markers)) (src.markers || []).forEach((m, index) => { if (edaMatches(m.text || m.title || "", o)) hits.push({ kind: "marker", index, x: m.x, y: m.y, text: m.text }); });
  if (on(o.nets)) for (const n of [...(src.nets || [])].sort((a, b) => netNameCmp(a.name, b.name))) if (edaMatches(n.name, o)) hits.push({ kind: "net", name: n.name, code: n.code });
  return hits;
}

/** The cursor walk of DIALOG_FIND::search: `pos` is the current hit (−1 before the first search after a refresh,
 *  hits.length past the end); returns the new position and whether the end was reached without wrapping. */
export function findStep(pos: number, count: number, forward: boolean, fresh: boolean, wrap: boolean): { pos: number; endReached: boolean } {
  if (!count) return { pos: -1, endReached: false };
  let it = fresh ? (forward ? 0 : count) : pos, end = false;
  if (forward) {
    if (it !== count && !fresh) it++;
    if (it === count) { if (wrap) it = 0; else { end = true; it--; } }
  } else {
    if (it === 0) { if (wrap) it = count; else end = true; }
    if (it !== 0) it--;
  }
  return { pos: it, endReached: end };
}
