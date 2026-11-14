// library/fpchoice.ts — what a fields grid's footprint browse button hands the footprint chooser, and how the
// chooser filters on it.  KiCad sends FOOTPRINT_CHOOSER_FRAME a "symbol netlist" (fields_grid_table.cpp
// BuildFootprintChooserSymbolNetlist): the library symbol's pins over every unit of the first body style (stacked
// pin numbers expanded) and its footprint filters (ki_fp_filters).  The frame counts the distinct pin numbers and
// offers "Filter by pin count (n)" and "Apply footprint filters (…)" (FOOTPRINT_CHOOSER_FRAME::KiwayMailIn), and
// filterFootprint keeps a footprint whose pad count equals the pin count and whose name one of the filters matches
// (EDA_PATTERN_MATCH_WILDCARD_ANCHORED over the lower-cased name, "lib:" in front when the pattern holds a ':').
// DOM-free so it runs under node (server/static/tests/fp-browse.test.js).
import { wildcardAnchored } from "../symedit/fpfilters";
import { expandStacked } from "../symedit/model";

/** The chooser's half of the symbol netlist: the distinct pin count and the footprint filters. */
export interface FpChooserFilters { pins: number; filters: string[] }

type N = SNode;
const isList = (v: unknown): v is N => Array.isArray(v);
const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kids = (n: N, key: string): N[] => n.filter((c): c is N => isList(c) && c[0] === key);
const kid = (n: N, key: string): N | null => kids(n, key)[0] || null;

/** The pin numbers BuildFootprintChooserSymbolNetlist lists: GetGraphicalPins( 0 (all units), 1 (body style 1) ), a
 *  stacked number ("[1-4]") expanded into its pins.  Sub-symbols are `Name_<unit>_<bodyStyle>`; body style 0 is shared. */
export function chooserPinNumbers(lib: N | null): string[] {
  const out: string[] = []; if (!lib) return out;
  for (const sub of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(text(sub[1])); const body = m ? +m[2] : 0;
    if (body !== 0 && body !== 1) continue;
    for (const p of kids(sub, "pin")) {
      const num = kid(p, "number"), n = num ? text(num[1]) : "";
      const st = expandStacked(n);
      if (st.valid && st.pins.length) out.push(...st.pins); else out.push(n);
    }
  }
  return out;
}

/** LIB_SYMBOL::GetFPFilters: the ki_fp_filters property, space-separated. */
export function symbolFpFilters(lib: N | null): string[] {
  if (!lib) return [];
  const p = kids(lib, "property").find((q) => text(q[1]) === "ki_fp_filters");
  return p ? text(p[2]).split(/\s+/).filter(Boolean) : [];
}

/** The filters of one library symbol (null for none: an empty netlist, so the chooser shows no filter toggles). */
export function chooserFilters(lib: N | null): FpChooserFilters | null {
  if (!lib) return null;
  // the frame keys its pin map by number (pinNames[ number ] = name): the count is of distinct numbers
  const pins = new Set(chooserPinNumbers(lib)).size, filters = symbolFpFilters(lib);
  return pins || filters.length ? { pins, filters } : null;
}

/** BuildFootprintChooserSymbolNetlist( std::vector<LIB_SYMBOL*> ): a grouped row (or a multiple selection) gets filters
 *  only when every symbol's are the same; otherwise none. */
export function commonChooserFilters(libs: (N | null)[]): FpChooserFilters | null {
  if (!libs.length || libs.some((l) => !l)) return null;
  const all = libs.map(chooserFilters), key = (f: FpChooserFilters | null) => JSON.stringify(f);
  return all.every((f) => key(f) === key(all[0])) ? all[0] : null;
}

/** EDA_PATTERN_MATCH_WILDCARD_ANCHORED of FOOTPRINT_CHOOSER_FRAME::filterFootprint's patternMatch. */
export function matchesFpFilters(fpid: { library?: string; name: string }, filters: string[]): boolean {
  for (const f of filters) {
    const pat = f.toLowerCase();
    const name = (pat.includes(":") ? text(fpid.library).toLowerCase() + ":" : "") + fpid.name.toLowerCase();
    if (wildcardAnchored(pat).test(name)) return true;
  }
  return false;
}

/** FOOTPRINT_CHOOSER_FRAME::filterFootprint for one footprint row.  A row whose pad count is not known (a vendor's
 *  search result) is kept by the pin-count filter. */
export function footprintPasses(item: { library?: string; name: string; pads?: number }, f: FpChooserFilters | null, on: { pins: boolean; filters: boolean }): boolean {
  if (!f) return true;
  if (f.pins > 0 && on.pins && item.pads !== undefined && item.pads !== f.pins) return false;
  if (f.filters.length && on.filters && !matchesFpFilters(item, f.filters)) return false;
  return true;
}

/** The labels of the two check boxes (KiwayMailIn's msg.Printf). */
export function filterLabels(f: FpChooserFilters | null): { pins: string | null; filters: string | null } {
  return { pins: f && f.pins > 0 ? `Filter by pin count (${f.pins})` : null, filters: f && f.filters.length ? `Apply footprint filters (${f.filters.join(" ")})` : null };
}

/** GetAssociatedDocument's first test for a field value: a URI with a scheme goes to the browser (the web editor
 *  opens only web and mail links, as hypertext-follow.ts does); anything else is a file the web editor cannot open
 *  ("Documentation file '%s' not found.").  "~" and blank are "no datasheet". */
export function datasheetLink(value: string): { kind: "none" | "url" | "other"; url: string } {
  const v = value.trim();
  if (!v || v === "~") return { kind: "none", url: "" };
  if (/^(https?|ftp|mailto):/i.test(v)) return { kind: "url", url: v };
  return { kind: "other", url: v };
}
