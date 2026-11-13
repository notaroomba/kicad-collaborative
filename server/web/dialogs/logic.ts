// dialogs/logic.ts — the DOM-free half of the schematic-editor dialogs: paper formats and the
// (paper …)/(title_block …) writers (common/page_info.cpp, common/title_block.cpp), KiCad's find /
// replace matching (EDA_ITEM::Matches / Replace, SCH_*::Matches), the Symbol Fields Table's data
// model and BOM export (common/dialogs/fields_table_data_model.cpp, common/settings/bom_settings.cpp),
// schematic groups (SCH_IO_KICAD_SEXPR::saveGroup) and the grid overrides (EE_GRID_HELPER).
// Everything here runs under node too — server/static/tests/schdialogs.test.js bundles this file.

const isList = Array.isArray;
export const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0): number => { const x = typeof v === "number" ? v : Number(v); return v === undefined || v === null || v === "" || isNaN(x) ? d : x; };
export function kid(node: SNode, key: string): SNode | null { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
export function kids(node: SNode, key: string): SNode[] { const out: SNode[] = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
/** OUTPUTFORMATTER::Quotew: always quoted, with \\, \" and control characters escaped. */
export function quote(s: string): string { return '"' + str(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"'; }
/** FormatDouble2Str for sizes in mm: up to 6 decimals, no trailing zeros. */
export function fmtNum(v: number): string { const s = (+v).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; }

// ---------------------------------------------------------------- page settings
export interface PaperFormat { type: string; label: string; w: number; h: number }
const IN = 25.4;
/** PAGE_INFO::standardPageSizes in dialog order (landscape width × height, mm). */
export const PAPER_FORMATS: PaperFormat[] = [
  { type: "A5", label: "A5 148 x 210mm", w: 210, h: 148 }, { type: "A4", label: "A4 210 x 297mm", w: 297, h: 210 }, { type: "A3", label: "A3 297 x 420mm", w: 420, h: 297 },
  { type: "A2", label: "A2 420 x 594mm", w: 594, h: 420 }, { type: "A1", label: "A1 594 x 841mm", w: 841, h: 594 }, { type: "A0", label: "A0 841 x 1189mm", w: 1189, h: 841 },
  { type: "A", label: "A 8.5 x 11in", w: 11 * IN, h: 8.5 * IN }, { type: "B", label: "B 11 x 17in", w: 17 * IN, h: 11 * IN }, { type: "C", label: "C 17 x 22in", w: 22 * IN, h: 17 * IN },
  { type: "D", label: "D 22 x 34in", w: 34 * IN, h: 22 * IN }, { type: "E", label: "E 34 x 44in", w: 44 * IN, h: 34 * IN },
  { type: "User", label: "User (Custom)", w: 17 * IN, h: 11 * IN },
  { type: "USLetter", label: "US Letter 8.5 x 11in", w: 11 * IN, h: 8.5 * IN }, { type: "USLegal", label: "US Legal 8.5 x 14in", w: 14 * IN, h: 8.5 * IN }, { type: "USLedger", label: "US Ledger 11 x 17in", w: 17 * IN, h: 11 * IN },
];
export interface PageSettings { paper: string; portrait: boolean; width: number; height: number; title: string; date: string; rev: string; company: string; comments: string[] }
/** PAGE_INFO::Format: (paper "A4"), (paper "A4" portrait), (paper "User" 300 200). */
export function paperSexpr(p: Pick<PageSettings, "paper" | "portrait" | "width" | "height">): string {
  if (p.paper === "User") return `(paper "User" ${fmtNum(p.width)} ${fmtNum(p.height)})`;
  return `(paper ${quote(p.paper)}${p.portrait ? " portrait" : ""})`;
}
/** TITLE_BLOCK::Format: only the non-empty fields; nothing at all for an empty title block. */
export function titleBlockSexpr(p: Pick<PageSettings, "title" | "date" | "rev" | "company" | "comments">): string {
  const parts: string[] = [];
  if (p.title) parts.push(`(title ${quote(p.title)})`);
  if (p.date) parts.push(`(date ${quote(p.date)})`);
  if (p.rev) parts.push(`(rev ${quote(p.rev)})`);
  if (p.company) parts.push(`(company ${quote(p.company)})`);
  (p.comments || []).forEach((c, i) => { if (c && i < 9) parts.push(`(comment ${i + 1} ${quote(c)})`); });
  return parts.length ? `(title_block ${parts.join(" ")})` : "";
}
/** The settings a parsed document carries (kicad-canvas keeps paper / portrait / page / titleBlock on it). */
export function pageSettingsOf(doc: { paper?: string; portrait?: boolean; page: [number, number]; titleBlock?: Record<string, string> }): PageSettings {
  const tb = doc.titleBlock || {}; const comments: string[] = [];
  for (let i = 1; i <= 9; i++) comments.push(str(tb["comment" + i] ?? tb["COMMENT" + i] ?? ""));
  const known = PAPER_FORMATS.some((f) => f.type === doc.paper);
  return { paper: known ? str(doc.paper) : "User", portrait: !!doc.portrait && doc.paper !== "User", width: doc.page[0], height: doc.page[1],
    title: str(tb.title ?? tb.TITLE ?? ""), date: str(tb.date ?? tb.ISSUE_DATE ?? ""), rev: str(tb.rev ?? tb.REVISION ?? ""), company: str(tb.company ?? tb.COMPANY ?? ""), comments };
}
/** The id every document-level (page settings) change travels under; no item ever has it. */
export const DOC_PROPS_ID = "00000000-0000-0000-0000-0000000d0c00";
export interface DocPropsChange { id: string; kind: "MODIFIED"; typeName: "PAGE_SETTINGS"; docProps: { paper: string; titleBlock: string } }
export function pageSettingsChange(p: PageSettings): DocPropsChange { return { id: DOC_PROPS_ID, kind: "MODIFIED", typeName: "PAGE_SETTINGS", docProps: { paper: paperSexpr(p), titleBlock: titleBlockSexpr(p) } }; }
export function isDocPropsChange(c: unknown): c is DocPropsChange { const o = c as { id?: unknown; docProps?: unknown } | null; return !!o && o.id === DOC_PROPS_ID && typeof o.docProps === "object" && o.docProps !== null; }
/** KiCad's date format for the "<<<" button (DIALOG_PAGES_SETTINGS: FormatISODate). */
export function isoDate(d: Date): string { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

// ---------------------------------------------------------------- find / replace
export interface FindOpts { query: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean; pins?: boolean; hiddenFields?: boolean; netNames?: boolean; selectionOnly?: boolean; replaceRefs?: boolean }
export interface FindHit { id: string; kind: string; what: string; field?: string; text: string; replaceable: boolean; x: number; y: number }
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** EDA_ITEM::Matches: whole word = the whole text; a regular expression; wildcards (* ?) as wxMatchWild; else a substring. */
export function matcher(o: FindOpts): ((text: string) => boolean) | null {
  const q = str(o.query); if (!q) return null;
  const fl = o.matchCase ? "" : "i";
  try {
    if (o.regex) { const re = new RegExp(q, fl); return (t) => re.test(t); }
    if (o.wholeWord) { const re = new RegExp("^" + reEsc(q) + "$", fl); return (t) => re.test(t); }
    if (/[*?]/.test(q)) { const re = new RegExp("^" + q.split(/([*?])/).map((p) => (p === "*" ? "[\\s\\S]*" : p === "?" ? "[\\s\\S]" : reEsc(p))).join("") + "$", fl); return (t) => re.test(t); }
  } catch (e) { return null; }
  const needle = o.matchCase ? q : q.toLowerCase();
  return (t) => (o.matchCase ? t : t.toLowerCase()).includes(needle);
}
/** EDA_ITEM::Replace: every occurrence (the whole text for whole-word and wildcard matches); null when nothing changes. */
export function replaceText(text: string, o: FindOpts, replacement: string): string | null {
  const m = matcher(o); if (!m || !m(text)) return null;
  const q = str(o.query), fl = o.matchCase ? "g" : "gi"; let out: string;
  if (o.regex) out = text.replace(new RegExp(q, fl), replacement);
  else if (o.wholeWord || /[*?]/.test(q)) out = replacement;
  else out = text.replace(new RegExp(reEsc(q), fl), () => replacement);
  return out === text ? null : out;
}
function hidden(p: SNode): boolean {
  const h = kid(p, "hide"); if (h) return str(h[1]) !== "no";
  const e = kid(p, "effects"); if (!e) return false;
  if (e.includes("hide")) return true; const eh = kid(e, "hide"); return !!eh && str(eh[1]) !== "no";
}
function at(node: SNode): [number, number] { const a = kid(node, "at"); return a ? [num(a[1]), num(a[2])] : [0, 0]; }
/** Every (pin …) of a library symbol, across its units. */
export function libPins(lib: SNode | null): { name: string; number: string }[] {
  const out: { name: string; number: string }[] = []; if (!lib) return out;
  const walk = (n: SNode) => { for (const c of n) { if (!isList(c)) continue; if (c[0] === "pin") { const nm = kid(c, "name"), nb = kid(c, "number"); out.push({ name: nm ? str(nm[1]) : "", number: nb ? str(nb[1]) : "" }); } else if (c[0] === "symbol") walk(c); } };
  walk(lib); return out;
}
const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
type FindDoc = Pick<KDoc, "items" | "lib">;
type LibResolver = (doc: FindDoc, name: string) => SNode | null;
/** The texts of one item that KiCad's find looks at (SCH_SYMBOL / SCH_FIELD / SCH_LABEL / SCH_TEXT / SCH_SHEET ::Matches). */
export function searchableTexts(doc: FindDoc, it: KItem, o: FindOpts, resolveLib?: LibResolver): Omit<FindHit, "id" | "kind">[] {
  const out: Omit<FindHit, "id" | "kind">[] = [], n = it.node, [x, y] = at(n);
  const push = (what: string, text: string, replaceable: boolean, field?: string, px = x, py = y) => out.push({ what, field, text, replaceable, x: px, y: py });
  if (it.kind === "symbol" || it.kind === "sheet") {
    for (const p of kids(n, "property")) {
      const name = str(p[1]); if (name.startsWith("ki_")) continue;
      if (!o.hiddenFields && hidden(p) && name !== "Reference" && name !== "Value") continue;
      const [fx, fy] = at(p);
      push(name, str(p[2]), name === "Reference" ? !!o.replaceRefs : !(it.kind === "sheet" && name === "Sheetfile"), name, fx, fy);
    }
    if (it.kind === "sheet") for (const p of kids(n, "pin")) { const [px, py] = at(p); push("Sheet Pin", str(p[1]), false, undefined, px, py); }
    if (it.kind === "symbol" && o.pins) {
      const lid = kid(n, "lib_name") || kid(n, "lib_id"); const lib = lid ? (resolveLib ? resolveLib(doc, str(lid[1])) : doc.lib.get(str(lid[1])) || null) : null;
      for (const pin of libPins(lib)) { if (pin.name && pin.name !== "~") push("Pin Name", pin.name, false); if (pin.number) push("Pin Number", pin.number, false); }
    }
  } else if (LABEL_KINDS.has(it.kind)) {
    push("Label", str(n[1]), true);
    if (o.netNames && it.kind === "label") push("Net Name", "/" + str(n[1]), false);
    if (o.hiddenFields || it.kind === "global_label") for (const p of kids(n, "property")) { if (!o.hiddenFields && hidden(p)) continue; push(str(p[1]), str(p[2]), false, str(p[1])); }
  } else if (it.kind === "text" || it.kind === "text_box") push("Text", str(n[1]), true);
  return out;
}
/** All hits on a sheet in KiCad's search order (left to right, then top to bottom). */
export function findHits(doc: FindDoc, o: FindOpts, selection?: Set<string> | null, resolveLib?: LibResolver): FindHit[] {
  const m = matcher(o); if (!m) return [];
  const hits: FindHit[] = [];
  for (const it of doc.items.values()) {
    if (o.selectionOnly && selection && !selection.has(it.id)) continue;
    for (const t of searchableTexts(doc, it, o, resolveLib)) if (m(t.text)) hits.push(Object.assign({ id: it.id, kind: it.kind }, t));
  }
  const pos = new Map<string, [number, number]>(); for (const h of hits) if (!pos.has(h.id)) { const it = doc.items.get(h.id)!; pos.set(h.id, at(it.node)); }
  hits.sort((a, b) => { const pa = pos.get(a.id)!, pb = pos.get(b.id)!; return pa[0] - pb[0] || pa[1] - pb[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  return hits;
}
/** Apply a replacement to a cloned node for one hit; false when the hit is not replaceable or nothing changed. */
export function replaceInNode(node: SNode, hit: Pick<FindHit, "what" | "field" | "replaceable" | "kind">, o: FindOpts, replacement: string): boolean {
  if (!hit.replaceable) return false;
  if (hit.field) { const p = kids(node, "property").find((q) => str(q[1]) === hit.field); if (!p) return false; const r = replaceText(str(p[2]), o, replacement); if (r === null) return false; p[2] = r; return true; }
  const r = replaceText(str(node[1]), o, replacement); if (r === null) return false; node[1] = r; return true;
}

// ---------------------------------------------------------------- symbol fields table / BOM
export interface BomField { name: string; label: string; show: boolean; group_by: boolean }
export interface BomPreset { name: string; fields_ordered: BomField[]; sort_field: string; sort_asc: boolean; filter_string: string; group_symbols: boolean; exclude_dnp: boolean; include_excluded_from_bom: boolean; readOnly?: boolean }
export interface BomFmt { name: string; field_delimiter: string; string_delimiter: string; ref_delimiter: string; ref_range_delimiter: string; keep_tabs: boolean; keep_line_breaks: boolean; include_bom?: boolean; readOnly?: boolean }
const F = (name: string, label: string, show: boolean, group_by: boolean): BomField => ({ name, label, show, group_by });
/** BOM_PRESET::BuiltInPresets (common/settings/bom_settings.cpp). */
export const BOM_PRESETS: BomPreset[] = [
  { name: "Default Editing", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: true,
    fields_ordered: [F("Reference", "Reference", true, false), F("${QUANTITY}", "Qty", true, false), F("Value", "Value", true, true), F("${DNP}", "DNP", true, true), F("${EXCLUDE_FROM_BOM}", "Exclude from BOM", true, true), F("${EXCLUDE_FROM_BOARD}", "Exclude from Board", true, true), F("Footprint", "Footprint", true, true), F("Datasheet", "Datasheet", true, false)] },
  { name: "Grouped By Value", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: false,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", true, false), F("Footprint", "Footprint", true, false), F("${QUANTITY}", "Qty", true, false), F("${DNP}", "DNP", true, true)] },
  { name: "Grouped By Value and Footprint", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: false,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", true, false), F("Footprint", "Footprint", true, true), F("${QUANTITY}", "Qty", true, false), F("${DNP}", "DNP", true, true)] },
  { name: "Attributes", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: true,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", false, false), F("Footprint", "Footprint", false, true), F("${DNP}", "Do Not Place", true, false), F("${EXCLUDE_FROM_BOM}", "Exclude from BOM", true, false), F("${EXCLUDE_FROM_BOARD}", "Exclude from Board", true, false), F("${EXCLUDE_FROM_SIM}", "Exclude from Simulation", true, false)] },
];
/** BOM_FMT_PRESET::BuiltInPresets. */
export const BOM_FMT_PRESETS: BomFmt[] = [
  { name: "CSV", readOnly: true, field_delimiter: ",", string_delimiter: '"', ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
  { name: "TSV", readOnly: true, field_delimiter: "\t", string_delimiter: "", ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
  { name: "Semicolons", readOnly: true, field_delimiter: ";", string_delimiter: "'", ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
];
export const ATTR_FIELDS: Record<string, { flag: "dnp" | "excludeBom" | "excludeBoard" | "excludeSim" | "excludePos"; text: string }> = {
  "${DNP}": { flag: "dnp", text: "DNP" }, "${EXCLUDE_FROM_BOM}": { flag: "excludeBom", text: "Excluded from BOM" }, "${EXCLUDE_FROM_BOARD}": { flag: "excludeBoard", text: "Excluded from board" },
  "${EXCLUDE_FROM_SIM}": { flag: "excludeSim", text: "Excluded from simulation" }, "${EXCLUDE_FROM_POS_FILES}": { flag: "excludePos", text: "Excluded from position files" },
};
export const QTY = "${QUANTITY}", ITEM_NO = "${ITEM_NUMBER}";
export interface SymRow { id: string; ids: string[]; ref: string; values: Record<string, string>; dnp: boolean; excludeBom: boolean; excludeBoard: boolean; excludeSim: boolean; excludePos: boolean; sheet: string; editable: boolean }
const yes = (n: SNode, key: string, def: boolean) => { const k = kid(n, key); return k ? str(k[1]) === "yes" : def; };
/** One row per reference designator on a sheet (the units of a multi-unit symbol share a row); power symbols (#PWR…) are left out. */
export function symbolRows(doc: Pick<KDoc, "items">, sheet = "", editable = true): SymRow[] {
  const byRef = new Map<string, SymRow>(), rows: SymRow[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const values: Record<string, string> = {};
    for (const p of kids(it.node, "property")) { const nm = str(p[1]); if (!nm.startsWith("ki_")) values[nm] = str(p[2]); }
    const ref = values.Reference || ""; if (ref.startsWith("#")) continue;
    const prev = ref && !/\?$/.test(ref) ? byRef.get(ref) : undefined;
    if (prev) { prev.ids.push(it.id); continue; }
    const row: SymRow = { id: it.id, ids: [it.id], ref, values, sheet, editable, dnp: yes(it.node, "dnp", false), excludeBom: !yes(it.node, "in_bom", true), excludeBoard: !yes(it.node, "on_board", true), excludeSim: yes(it.node, "exclude_from_sim", false), excludePos: !yes(it.node, "in_pos_files", true) };
    rows.push(row); if (ref) byRef.set(ref, row);
  }
  return rows;
}
/** Every field name the rows carry, the four mandatory ones first (the dialog's field list). */
export function fieldNames(rows: SymRow[]): string[] { const out = ["Reference", "Value", "Footprint", "Datasheet", "Description"]; for (const r of rows) for (const k of Object.keys(r.values)) if (!out.includes(k)) out.push(k); return out; }
export function splitRef(ref: string): [string, number] { const m = /^(.*?)(\d+)$/.exec(ref); return m ? [m[1], +m[2]] : [ref, -1]; }
export function refCmp(a: string, b: string): number { const [pa, na] = splitRef(a), [pb, nb] = splitRef(b); return pa < pb ? -1 : pa > pb ? 1 : na - nb || (a < b ? -1 : a > b ? 1 : 0); }
/** SCH_REFERENCE_LIST::Shorthand: "R1, R2", runs of three or more as "R1-R3" unless the range delimiter is empty. */
export function refShorthand(refs: string[], delim: string, range: string): string {
  const s = [...new Set(refs)].sort(refCmp), out: string[] = [];
  for (let i = 0; i < s.length;) {
    const [p, n] = splitRef(s[i]); let j = i;
    while (n >= 0 && j + 1 < s.length) { const [p2, n2] = splitRef(s[j + 1]); if (p2 === p && n2 === n + (j + 1 - i)) j++; else break; }
    if (range && j - i >= 2) out.push(s[i] + range + s[j]); else for (let k = i; k <= j; k++) out.push(s[k]);
    i = j + 1;
  }
  return out.join(delim);
}
export interface BomRow { rows: SymRow[]; cells: Record<string, string> }
function cellOf(r: SymRow, name: string): string { const a = ATTR_FIELDS[name]; return a ? (r[a.flag] ? a.text : "") : str(r.values[name]); }
function natCmp(a: string, b: string): number { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
/**
 * FIELDS_EDITOR_GRID_DATA_MODEL::RebuildRows: filter, group on the group-by columns, sort, then number.
 * `refDelim` / `refRange` are ", " and "-" on screen and the format preset's on export.
 */
export function bomRows(rows: SymRow[], preset: BomPreset, refDelim = ", ", refRange = "-"): BomRow[] {
  const flt = str(preset.filter_string).trim(); const fm = flt ? matcher({ query: /[*?]/.test(flt) ? (flt.startsWith("*") ? "" : "*") + flt + (flt.endsWith("*") ? "" : "*") : flt }) : null;
  const kept = rows.filter((r) => (!preset.exclude_dnp || !r.dnp) && (preset.include_excluded_from_bom || !r.excludeBom) && (!fm || fm(r.ref)));
  const groupCols = preset.fields_ordered.filter((f) => f.group_by && f.name !== "Reference" && f.name !== QTY && f.name !== ITEM_NO);
  const groups: SymRow[][] = [];
  if (preset.group_symbols) {
    const map = new Map<string, SymRow[]>();
    for (const r of kept) { const key = JSON.stringify(groupCols.map((c) => cellOf(r, c.name)).concat(groupCols.length ? [] : [r.id])); const g = map.get(key); if (g) g.push(r); else { const ng = [r]; map.set(key, ng); groups.push(ng); } }
  } else for (const r of kept) groups.push([r]);
  const out: BomRow[] = groups.map((g) => {
    g.sort((a, b) => refCmp(a.ref, b.ref)); const cells: Record<string, string> = {};
    for (const f of preset.fields_ordered) {
      if (f.name === "Reference") cells[f.name] = refShorthand(g.map((r) => r.ref), refDelim, refRange);
      else if (f.name === QTY) cells[f.name] = String(g.length);
      else if (f.name === ITEM_NO) cells[f.name] = "";
      else { const vals = [...new Set(g.map((r) => cellOf(r, f.name)))]; cells[f.name] = vals.length <= 1 ? vals[0] || "" : vals.filter((v) => v !== "").join(refDelim); }
    }
    return { rows: g, cells };
  });
  const sf = preset.sort_field || "Reference", dir = preset.sort_asc === false ? -1 : 1;
  out.sort((a, b) => dir * (sf === "Reference" ? refCmp(a.rows[0].ref, b.rows[0].ref) : sf === QTY ? a.rows.length - b.rows.length || refCmp(a.rows[0].ref, b.rows[0].ref) : natCmp(str(a.cells[sf]), str(b.cells[sf])) || refCmp(a.rows[0].ref, b.rows[0].ref)));
  out.forEach((r, i) => { if (ITEM_NO in r.cells) r.cells[ITEM_NO] = String(i + 1); });
  return out;
}
/** FIELDS_TABLE_DATA_MODEL_BASE::Export. */
export function bomExport(rows: SymRow[], preset: BomPreset, fmt: BomFmt): string {
  const cols = preset.fields_ordered.filter((f) => f.show); if (!cols.length) return "";
  const sd = fmt.string_delimiter || "";
  const field = (v: string, last: boolean) => {
    let s = str(v); if (!fmt.keep_line_breaks) s = s.replace(/[\r\n]/g, ""); if (!fmt.keep_tabs) s = s.replace(/\t/g, "");
    if (sd) s = s.split(sd).join(sd + sd);
    return sd + s + sd + (last ? "\n" : fmt.field_delimiter);
  };
  let out = fmt.include_bom ? "﻿" : "";
  cols.forEach((c, i) => { out += field(c.label, i === cols.length - 1); });
  for (const r of bomRows(rows, preset, fmt.ref_delimiter, fmt.ref_range_delimiter)) cols.forEach((c, i) => { out += field(r.cells[c.name], i === cols.length - 1); });
  return out;
}
/** A preset that shows every field the rows carry; the ones a stored preset lacks are appended hidden. */
export function withAllFields(preset: BomPreset, names: string[]): BomPreset {
  const fields = preset.fields_ordered.map((f) => Object.assign({}, f));
  for (const n of names) if (!fields.some((f) => f.name === n)) fields.push(F(n, n, false, false));
  for (const [n, label] of [[QTY, "Qty"], [ITEM_NO, "#"]] as const) if (!fields.some((f) => f.name === n)) fields.push(F(n, label, false, false));
  return Object.assign({}, preset, { fields_ordered: fields });
}

// ---------------------------------------------------------------- schematic groups
export function groupMembers(node: SNode): string[] { const m = kid(node, "members"); return m ? m.slice(1).map(str) : []; }
/** (group "name" (uuid …) (members …)) as SCH_IO_KICAD_SEXPR::saveGroup writes it: member ids sorted. */
export function groupSexpr(name: string, uuid: string, members: string[]): string { return `(group ${quote(name)} (uuid ${quote(uuid)}) (members ${[...new Set(members)].sort().map(quote).join(" ")}))`; }
export function groupOf(doc: Pick<KDoc, "items">, id: string): KItem | null { for (const it of doc.items.values()) if (it.kind === "group" && groupMembers(it.node).includes(id)) return it; return null; }
/** The outermost group an item belongs to, stopping below the group the user has entered. */
export function topGroupOf(doc: Pick<KDoc, "items">, id: string, entered?: string | null): KItem | null {
  let g = groupOf(doc, id), top: KItem | null = null, guard = 0;
  while (g && g.id !== entered && guard++ < 32) { top = g; g = groupOf(doc, g.id); }
  return top;
}
/** ids plus, for every member of a group, the whole (outermost, not entered) group: its id and all its members, nested groups included. */
export function expandGroups(doc: Pick<KDoc, "items">, ids: Iterable<string>, entered?: string | null): Set<string> {
  const out = new Set<string>();
  const addGroup = (g: KItem) => { if (out.has(g.id)) return; out.add(g.id); for (const m of groupMembers(g.node)) { const it = doc.items.get(m); if (!it) continue; if (it.kind === "group") addGroup(it); else out.add(m); } };
  for (const id of ids) { const it = doc.items.get(id); if (!it) continue; const top = it.kind === "group" ? (topGroupOf(doc, id, entered) || it) : topGroupOf(doc, id, entered); if (top) addGroup(top); else out.add(id); }
  return out;
}

// ---------------------------------------------------------------- grids
export interface GridOverrides { enabled: boolean; connected: boolean; connectedMm: number; wires: boolean; wiresMm: number; text: boolean; textMm: number; graphics: boolean; graphicsMm: number; vias: boolean; viasMm: number }
const MIL = 0.0254;
/** APP_SETTINGS_BASE's schematic defaults: connected items and wires on 50 mil, text on 10 mil, graphics (off) on 25 mil. */
export const SCH_GRID_OVERRIDES: GridOverrides = { enabled: true, connected: true, connectedMm: 50 * MIL, wires: true, wiresMm: 50 * MIL, text: true, textMm: 10 * MIL, graphics: false, graphicsMm: 25 * MIL, vias: false, viasMm: 100 * MIL };
/**
 * pcbnew's (and the footprint editor's): all off, on the list's indices 16, 19, 18, 18 and 15 of DefaultGridSizeList
 * (connected 0.25 mm, wires 0.05 mm, text 0.1 mm, vias 0.1 mm, graphics 0.5 mm).
 */
export const PCB_GRID_OVERRIDES: GridOverrides = { enabled: true, connected: false, connectedMm: 0.25, wires: false, wiresMm: 0.05, text: false, textMm: 0.1, graphics: false, graphicsMm: 0.5, vias: false, viasMm: 0.1 };
export type GridClass = "connected" | "wires" | "text" | "graphics" | "vias" | null;
/** EE_GRID_HELPER::GetItemGrid by item kind. */
export function schGridClassOfKind(kind: string): GridClass {
  switch (kind) {
    case "symbol": case "sheet": case "no_connect": case "label": case "global_label": case "hierarchical_label": case "netclass_flag": case "directive_label": case "rule_area": return "connected";
    case "text": return "text";
    case "rectangle": case "circle": case "arc": case "bezier": case "polyline": case "text_box": case "image": case "ellipse": return "graphics";
    case "junction": case "wire": case "bus": case "bus_entry": return "wires";
    default: return null;
  }
}
const SCH_TOOL_KIND: Record<string, string> = { place: "symbol", power: "symbol", wire: "wire", bus: "bus", busentry: "bus_entry", noconnect: "no_connect", junction: "junction", label: "label", classlabel: "netclass_flag", glabel: "global_label", hlabel: "hierarchical_label",
  rulearea: "rule_area", sheet: "sheet", sheetpin: "sheet", text: "text", textbox: "text_box", rect: "rectangle", circle: "circle", arc: "arc", bezier: "bezier", polygon: "polyline", lines: "polyline", image: "image" };
export function schGridClassOfTool(tool: string): GridClass { const k = SCH_TOOL_KIND[tool]; return k ? schGridClassOfKind(k) : null; }
/** The pitch a grid class snaps to: its override when overrides are on and that one is ticked, else the current grid. */
export function gridPitchFor(cls: GridClass, o: GridOverrides, current: number): number {
  if (!o.enabled || !cls) return current;
  const on = o[cls], mm = o[(cls + "Mm") as "connectedMm"];
  return on && mm > 0 ? mm : current;
}
