// pcbdialogs/xref — BOARD::ConvertCrossReferencesToKIIDs / ConvertKIIDsToCrossReferences (pcbnew/board.cpp).
// A board text stores a cross-reference to a footprint as ${<footprint uuid>:FIELD}; the dialogs show and take it as
// ${REF:FIELD}.  The text, textbox, table, table cell, dimension and footprint dialogs convert on open and on OK.
// Escaped expressions (\${…} and \@{…}) are copied verbatim; a reference to a footprint the board lacks, or a token
// the footprint cannot resolve (FOOTPRINT::ResolveTextVar), stays as typed.

const isList = Array.isArray;
type N = SNode;
const kid = (n: N | null, key: string): N | null => { if (!n) return null; for (const c of n) if (isList(c) && c[0] === key) return c as N; return null; };
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** One footprint as the converters see it. */
export interface XrefFootprint { uuid: string; ref: string; fields: Set<string>; pads: Set<string> }

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
    out.push({ uuid: str((kid(n, "uuid") || kid(n, "tstamp") || [])[1]), ref, fields, pads });
  }
  return out;
}

const FIXED = new Set(["REFERENCE", "VALUE", "LAYER", "FOOTPRINT_LIBRARY", "FOOTPRINT_NAME", "EXCLUDE_FROM_BOM", "EXCLUDE_FROM_POS_FILES", "EXCLUDE_FROM_BOARD", "EXCLUDE_FROM_SIM", "DNP"]);
/** FOOTPRINT::ResolveTextVar's answer to "does this token resolve" (its value is not needed here). */
export function footprintResolves(fp: XrefFootprint, token: string): boolean {
  if (FIXED.has(token)) return true;
  const m = /^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME)\((.*)$/.exec(token);
  if (m) { const pad = m[2].lastIndexOf(")") >= 0 ? m[2].slice(0, m[2].lastIndexOf(")")) : m[2]; return fp.pads.has(pad); }
  return fp.fields.has(token);
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
export function refsToKiids(fps: XrefFootprint[], text: string): string {
  if (!text || text.indexOf("${") < 0) return text;
  return convert(text, (ref, rest) => {
    const fp = fps.find((f) => f.ref.toLowerCase() === ref.toLowerCase());
    return fp && footprintResolves(fp, rest) ? fp.uuid + ":" + rest : null;
  });
}

/** ConvertKIIDsToCrossReferences: ${<uuid>:VALUE} → ${R1:VALUE} when the uuid is a footprint of the board. */
export function kiidsToRefs(fps: XrefFootprint[], text: string): string {
  if (!text || text.indexOf("${") < 0) return text;
  return convert(text, (id, rest) => { const fp = fps.find((f) => f.uuid === id); return fp ? fp.ref + ":" + rest : null; });
}

/** The two converters bound to a board document. */
export function boardXref(doc: { items: Map<string, { kind?: string; node: N }> } | null | undefined): { toRefs(t: string): string; toKiids(t: string): string } {
  let fps: XrefFootprint[] | null = null;
  const get = (): XrefFootprint[] => (fps || (fps = boardFootprints(doc ? doc.items.values() : null)));
  return { toRefs: (t) => kiidsToRefs(get(), t), toKiids: (t) => refsToKiids(get(), t) };
}
