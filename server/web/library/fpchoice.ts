// library/fpchoice.ts — what a fields grid's footprint browse button hands the footprint chooser, and how the
// chooser filters on it.  KiCad sends FOOTPRINT_CHOOSER_FRAME a "symbol netlist" (fields_grid_table.cpp
// BuildFootprintChooserSymbolNetlist): the library symbol's pins over every unit of the first body style (stacked
// pin numbers expanded) and its footprint filters (ki_fp_filters).  The frame counts the distinct pin numbers and
// offers "Filter by pin count (n)" and "Apply footprint filters (…)" (FOOTPRINT_CHOOSER_FRAME::KiwayMailIn), and
// filterFootprint keeps a footprint whose pad count equals the pin count and whose name one of the filters matches
// (EDA_PATTERN_MATCH_WILDCARD_ANCHORED over the lower-cased name, "lib:" in front when the pattern holds a ':').
// The netlist is built as the string KiCad sends, so a grouped row compares what KiCad compares; the schematic
// Properties panel's own netlist leaves stacked numbers as they are.  Also GetAssociatedDocument's first steps for a
// field value (ResolveUriByEnvVars, the URI scheme, kicad-embed://) and SCH_FIELD::HasHypertext's IsURL.
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

/** One entry of the netlist's pin line: the pin's number and its shown name ("~" is no name). */
export interface ChooserPin { number: string; name: string }
/** The pins BuildFootprintChooserSymbolNetlist lists: GetGraphicalPins( 0 (all units), 1 (body style 1) ) in drawing
 *  order, a stacked number ("[1-4]") expanded into its pins.  SCH_PROPERTIES_PANEL's netlistCallback lists them the
 *  same way but sends pin->GetNumber() as it is (`expand` false).  Sub-symbols are `Name_<unit>_<bodyStyle>`; body
 *  style 0 is shared. */
export function chooserPins(lib: N | null, expand = true): ChooserPin[] {
  const out: ChooserPin[] = []; if (!lib) return out;
  for (const sub of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(text(sub[1])); const body = m ? +m[2] : 0;
    if (body !== 0 && body !== 1) continue;
    for (const p of kids(sub, "pin")) {
      const num = kid(p, "number"), nm = kid(p, "name"), n = num ? text(num[1]) : "", raw = nm ? text(nm[1]) : "", name = raw === "~" ? "" : raw;
      const st = expand ? expandStacked(n) : { valid: false, pins: [] as string[] };
      if (st.valid && st.pins.length) for (const x of st.pins) out.push({ number: x, name }); else out.push({ number: n, name });
    }
  }
  return out;
}
/** The pin numbers of chooserPins. */
export function chooserPinNumbers(lib: N | null, expand = true): string[] { return chooserPins(lib, expand).map((p) => p.number); }

/** LIB_SYMBOL::GetFPFilters: the ki_fp_filters property, space-separated. */
export function symbolFpFilters(lib: N | null): string[] {
  if (!lib) return [];
  const p = kids(lib, "property").find((q) => text(q[1]) === "ki_fp_filters");
  return p ? text(p[2]).split(/\s+/).filter(Boolean) : [];
}

/** The symbol netlist string itself: "number name<TAB>number name…\rfilter filter…\r" (a line break in either line
 *  written "{return}", as EscapeString( CTX_LINE ) does). */
export function netlistOf(pins: ChooserPin[], filters: string[]): string {
  const line = (s: string) => s.replace(/[\n\r]/g, "{return}");
  return (pins.length ? line(pins.map((p) => p.number + " " + p.name).join("\t")) : "") + "\r" + (filters.length ? line(filters.join(" ")) : "") + "\r";
}
/** BuildFootprintChooserSymbolNetlist( LIB_SYMBOL* ) (or, `expand` false, the Properties panel's netlistCallback). */
export function chooserNetlist(lib: N | null, expand = true): string {
  return lib ? netlistOf(chooserPins(lib, expand), symbolFpFilters(lib)) : "";
}
/** What FOOTPRINT_CHOOSER_FRAME::KiwayMailIn( MAIL_SYMBOL_NETLIST ) reads from a netlist: the count of distinct pin
 *  numbers (pinNames[ number ] = name) and the filters; null when neither is there (no filter toggles). */
export function netlistFilters(netlist: string): FpChooserFilters | null {
  if (!netlist) return null;
  const [pinLine = "", filterLine = ""] = netlist.split("\r");
  const numbers = new Set(pinLine ? pinLine.split("\t").map((t) => (t.includes(" ") ? t.slice(0, t.indexOf(" ")) : t)) : []);
  const pins = numbers.size, filters = filterLine ? filterLine.split(" ").filter(Boolean) : [];
  return pins || filters.length ? { pins, filters } : null;
}

/** The filters of one library symbol (null for none: an empty netlist, so the chooser shows no filter toggles). */
export function chooserFilters(lib: N | null, expand = true): FpChooserFilters | null { return netlistFilters(chooserNetlist(lib, expand)); }

/** BuildFootprintChooserSymbolNetlist( std::vector<LIB_SYMBOL*> ): a grouped row (or a multiple selection) gets filters
 *  only when every symbol's netlist is the same string (each pin's number and name, in order, and the filters);
 *  otherwise none. */
export function commonChooserFilters(libs: (N | null)[]): FpChooserFilters | null {
  if (!libs.length || libs.some((l) => !l)) return null;
  const first = chooserNetlist(libs[0]);
  return libs.every((l) => chooserNetlist(l) === first) ? netlistFilters(first) : null;
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

/** ResolveUriByEnvVars as far as the web editor knows the variables: ${NAME} replaced by the project's text variable of
 *  that name (ExpandTextVars( FOR_URI )); a reference it does not know is left as it is. */
export function resolveUriVars(value: string, vars?: Record<string, string> | null): string {
  if (!vars || value.indexOf("${") < 0) return value;
  let out = value;
  for (let i = 0; i < 10 && /\$\{[^{}]*\}/.test(out); i++) {
    const next = out.replace(/\$\{([^{}]*)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
    if (next === out) break; out = next;
  }
  return out;
}
/** SCH_FIELD::HasHypertext's IsURL (common/string_utils.cpp): the text holds a web, ftp or file link somewhere. */
export function isURL(value: string): boolean { return /(https?|ftp|file):\/\/([-\w+&@#/%?=~|!:,.;]*[^.,:;<>\s\u00b6])/i.test(value); }

/** GetAssociatedDocument's first test for a field value, after ResolveUriByEnvVars: a URI with a scheme goes to the
 *  browser (the web editor opens only web and mail links, as hypertext-follow.ts does); kicad-embed://<name> is a file
 *  of the embedded-files stack ("embed", `url` its name); anything else is a file the web editor cannot open
 *  ("Documentation file '%s' not found.").  "~" and blank are "no datasheet". */
export function datasheetLink(value: string, vars?: Record<string, string> | null): { kind: "none" | "url" | "embed" | "other"; url: string } {
  const v = value.trim();
  if (!v || v === "~") return { kind: "none", url: "" };
  const r = resolveUriVars(v, vars).trim();
  if (/^(https?|ftp|mailto):/i.test(r)) return { kind: "url", url: r };
  if (/^kicad-embed:\/\//i.test(r)) return { kind: "embed", url: r.slice("kicad-embed://".length) };
  return { kind: "other", url: r };
}
