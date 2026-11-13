// pcbdialogs/xref — BOARD::ConvertCrossReferencesToKIIDs / ConvertKIIDsToCrossReferences (pcbnew/board.cpp).
// A board text stores a cross-reference to a footprint as ${<footprint uuid>:FIELD}; the dialogs show and take it as
// ${REF:FIELD}.  The text, textbox, table, table cell, dimension and footprint dialogs convert on open and on OK.
// Escaped expressions (\${…} and \@{…}) are copied verbatim; a reference to a footprint the board lacks, or a token
// the footprint cannot resolve (FOOTPRINT::ResolveTextVar), stays as typed.

const isList = Array.isArray;
type N = SNode;
const kid = (n: N | null, key: string): N | null => { if (!n) return null; for (const c of n) if (isList(c) && c[0] === key) return c as N; return null; };
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** One footprint as the converters see it (`props`: the ${PROPERTY.…} names with a value). */
export interface XrefFootprint { uuid: string; ref: string; fields: Set<string>; pads: Set<string>; props?: Set<string> }

/** The properties FOOTPRINT_DESC and BOARD_ITEM_DESC register for a footprint (footprint.cpp:5240-5375,
 *  board_item.cpp), the names ${PROPERTY.Name_With_Underscores} reads; the optional overrides have a value only when
 *  the footprint sets them. */
const FP_PROPERTIES = ["Position X", "Position Y", "Locked", "Layer", "Orientation", "Scale X", "Scale Y", "Reference", "Library Link", "Library Description", "Keywords", "Height",
  "Component Class", "Footprint Type", "Not in Schematic", "Exclude From Position Files", "Exclude From Bill of Materials", "Exclude From Simulation", "Do not Populate",
  "Exempt From Courtyard Requirement", "Zone Connection Style"];
const FP_OPTIONAL: [string, string][] = [["Clearance Override", "clearance"], ["Solderpaste Margin Override", "solder_paste_margin"], ["Solderpaste Margin Ratio Override", "solder_paste_margin_ratio"]];

/** The footprints of a board (its doc items, or plain nodes). */
export function boardFootprints(src: Iterable<{ kind?: string; node: N }> | null | undefined): XrefFootprint[] {
  const out: XrefFootprint[] = [];
  if (!src) return out;
  for (const it of src) {
    const n = it.node; if (!n || n[0] !== "footprint") continue;
    const fields = new Set<string>(), pads = new Set<string>(); let ref = "";
    for (const c of n) {
      if (!isList(c)) continue;
      if (c[0] === "property") { const name = str(c[1]); fields.add(name); if (name === "Reference") ref = str(c[2]); }
      else if (c[0] === "fp_text" && str(c[1]) === "reference") ref = str(c[2]);
      else if (c[0] === "pad") pads.add(str(c[1]));
    }
    const props = new Set<string>(FP_PROPERTIES); for (const [name, key] of FP_OPTIONAL) if (kid(n, key)) props.add(name);
    out.push({ uuid: str((kid(n, "uuid") || kid(n, "tstamp") || [])[1]), ref, fields, pads, props });
  }
  return out;
}

const FIXED = new Set(["REFERENCE", "VALUE", "LAYER", "FOOTPRINT_LIBRARY", "FOOTPRINT_NAME", "EXCLUDE_FROM_BOM", "EXCLUDE_FROM_POS_FILES", "EXCLUDE_FROM_BOARD", "EXCLUDE_FROM_SIM", "DNP"]);
/** BOARD::ResolveTextVar's own tokens (board.cpp:759-800) and TITLE_BLOCK::TextVarResolver's. */
const BOARD_FIXED = new Set(["FILENAME", "FILEPATH", "VARIANT", "VARIANT_DESC", "PROJECTNAME", "DRILL_OPERATIONS", "DRILL_SITES", "DRILL_GROUPS",
  "ISSUE_DATE", "CURRENT_DATE", "CURRENT_TIME_HH_MM_SS", "CURRENT_TIME_LOCALE", "REVISION", "TITLE", "COMPANY", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => "COMMENT" + i)]);
/** BOARD::ResolveTextVar's answer: a cross-reference (it always answers, "<Unresolved: …>" at worst), its own and the
 *  title block's tokens, the project's text variables and the board's properties (`vars`). */
export function boardResolves(token: string, vars?: Set<string> | null): boolean {
  return token.includes(":") || BOARD_FIXED.has(token) || !!(vars && vars.has(token));
}
/** FOOTPRINT::ResolveTextVar's answer to "does this token resolve" (its value is not needed here): its fixed tokens,
 *  pad tokens, fields, ${PROPERTY.Name} (underscores for spaces), then the board's (`vars`). */
export function footprintResolves(fp: XrefFootprint, token: string, vars?: Set<string> | null): boolean {
  if (FIXED.has(token)) return true;
  const m = /^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME)\((.*)$/.exec(token);
  if (m) { const pad = m[2].lastIndexOf(")") >= 0 ? m[2].slice(0, m[2].lastIndexOf(")")) : m[2]; if (fp.pads.has(pad)) return true; }
  else if (fp.fields.has(token)) return true;
  else if (token.startsWith("PROPERTY.")) return (fp.props || new Set(FP_PROPERTIES)).has(token.slice(token.indexOf(".") + 1).replace(/_/g, " "));
  return boardResolves(token, vars);
}

/** Walk the text, calling `map` on each ${token} that holds a ':'; escaped expressions are copied verbatim. */
function convert(src: string, map: (ref: string, rest: string) => string | null): string {
  let out = ""; const n = src.length;
  for (let i = 0; i < n; i++) {
    if (src[i] === "\\" && i + 2 < n && src[i + 2] === "{" && (src[i + 1] === "$" || src[i + 1] === "@")) {
      out += src[i] + src[i + 1] + src[i + 2]; i += 2;
      let depth = 1;
      for (i = i + 1; i < n && depth > 0; ++i) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; out += src[i]; }
      i--; continue;
    }
    if (src[i] === "$" && i + 1 < n && src[i + 1] === "{") {
      let token = "", cross = false;
      for (i = i + 2; i < n; ++i) { if (src[i] === "}") break; if (src[i] === ":") cross = true; token += src[i]; }
      if (cross) { const k = token.indexOf(":"); const r = map(token.slice(0, k), token.slice(k + 1)); if (r !== null) token = r; }
      out += "${" + token + "}";
    } else out += src[i];
  }
  return out;
}

/** ConvertCrossReferencesToKIIDs: ${R1:VALUE} → ${<R1's uuid>:VALUE} (reference matched without case). */
export function refsToKiids(fps: XrefFootprint[], text: string, vars?: Set<string> | null): string {
  if (!text || text.indexOf("${") < 0) return text;
  return convert(text, (ref, rest) => {
    const fp = fps.find((f) => f.ref.toLowerCase() === ref.toLowerCase());
    return fp && footprintResolves(fp, rest, vars) ? fp.uuid + ":" + rest : null;
  });
}

/** ConvertKIIDsToCrossReferences: ${<uuid>:VALUE} → ${R1:VALUE} when the uuid is a footprint of the board. */
export function kiidsToRefs(fps: XrefFootprint[], text: string): string {
  if (!text || text.indexOf("${") < 0) return text;
  return convert(text, (id, rest) => { const fp = fps.find((f) => f.uuid === id); return fp ? fp.ref + ":" + rest : null; });
}

/** The names BOARD::ResolveTextVar finds besides its fixed tokens: the project's text variables (the .kicad_pro
 *  text_variables) and the board's (property …) entries. */
export function boardTextVarNames(proText: string | null | undefined, boardProps?: Iterable<string> | null): Set<string> {
  const out = new Set<string>(boardProps || []);
  try { const j = proText ? JSON.parse(proText) as { text_variables?: Record<string, unknown> } : null; if (j && j.text_variables && typeof j.text_variables === "object") for (const k of Object.keys(j.text_variables)) out.add(k); } catch (e) { /* no project variables */ }
  return out;
}

/** The two converters bound to a board document (the board's text variables read from the editor's project). */
export function boardXref(doc: { items: Map<string, { kind?: string; node: N }>; boardProperties?: Record<string, string> } | null | undefined, vars?: Set<string> | null): { toRefs(t: string): string; toKiids(t: string): string } {
  let fps: XrefFootprint[] | null = null;
  const get = (): XrefFootprint[] => (fps || (fps = boardFootprints(doc ? doc.items.values() : null)));
  if (!vars) {
    const ed = (globalThis as { CollabEditor?: { proSettings?: string | null } }).CollabEditor;
    const props: string[] = doc && doc.boardProperties ? Object.keys(doc.boardProperties) : [];
    if (doc) for (const it of doc.items.values()) if (it.kind === "property" && it.node && it.node[0] === "property") props.push(str(it.node[1]));   // the board's (property "k" "v")
    vars = boardTextVarNames(ed ? ed.proSettings : null, props);
  }
  const v = vars;
  return { toRefs: (t) => kiidsToRefs(get(), t), toKiids: (t) => refsToKiids(get(), t, v) };
}
