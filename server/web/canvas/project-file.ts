// kicad-canvas / project-file — reading and rewriting a .kicad_pro the way KiCad's JSON_SETTINGS does.
//
// KiCad writes the project file with nlohmann::json::dump( 2 ): two-space indent, keys in byte order,
// doubles in their shortest round-trip form with ".0" kept on whole values.  JSON.parse / JSON.stringify
// lose that last part (1.0 comes back as 1), which would rewrite hundreds of untouched numbers the first
// time the web saves the file.  So the file is read into a tree whose numbers keep their source token
// (JNum) and only the values an edit really changes get a new token.
//
// Pure functions (no DOM): shared by the Board Setup dialog, DRC and the node tests
// (KiCadCanvas.projectFile).

/** A number as the file spelled it. */
export class JNum {
  raw: string;
  constructor(raw: string) { this.raw = raw; }
  get v(): number { return Number(this.raw); }
  get isFloat(): boolean { return /[.eE]/.test(this.raw); }
}
export type JVal = null | boolean | string | JNum | JVal[] | JObj;
export interface JObj { [key: string]: JVal }
/** Plain JSON, as JSON.parse gives it. */
export type Plain = null | boolean | string | number | Plain[] | { [key: string]: Plain };

export const isJObj = (v: unknown): v is JObj => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof JNum);

/** nlohmann's number output: shortest round-trip, ".0" on whole doubles, exponents below 1e-4 / from 1e15. */
export function formatNumber(n: number, float: boolean): string {
  if (!isFinite(n)) return "null";
  if (!float && Number.isInteger(n)) return String(n);
  if (Object.is(n, -0)) return "-0.0";
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-4 || a >= 1e15)) {
    const [m, e] = n.toExponential().split("e");
    const ex = Number(e);
    return `${m}e${ex < 0 ? "-" : "+"}${String(Math.abs(ex)).padStart(2, "0")}`;
  }
  const s = String(n);
  return /[.e]/.test(s) ? s : s + ".0";
}

/** Parse JSON text keeping every number's token.  Throws SyntaxError like JSON.parse. */
export function parseProject(text: string): JVal {
  let i = 0;
  const n = text.length;
  const fail = (what: string): never => { throw new SyntaxError(`${what} at offset ${i}`); };
  const ws = (): void => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
  const str = (): string => {
    // the opening quote is at i; JSON.parse does the unescaping
    const start = i; i++;
    while (i < n) { const c = text[i]; if (c === "\\") i += 2; else if (c === '"') { i++; return JSON.parse(text.slice(start, i)) as string; } else i++; }
    return fail("unterminated string");
  };
  const value = (): JVal => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o: JObj = {}; ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("expected a key");
        const k = str(); ws(); if (text[i] !== ":") fail("expected ':'"); i++;
        o[k] = value(); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++; const a: JVal[] = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) {
        a.push(value()); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return a; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (!m) return fail("unexpected token");
    i += m[0].length; return new JNum(m[0]);
  };
  const v = value(); ws();
  if (i < n) fail("trailing characters");
  return v;
}

const jstr = (s: string): string => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => c);   // dump() leaves UTF-8 alone

/** The file text KiCad would write for this tree (dump( 2 ), keys sorted, newline at the end). */
export function stringifyProject(v: JVal, level = 0): string {
  const pad = "  ".repeat(level), pad1 = "  ".repeat(level + 1);
  let out: string;
  if (v === null || v === undefined) out = "null";
  else if (v instanceof JNum) out = v.raw;
  else if (typeof v === "boolean") out = v ? "true" : "false";
  else if (typeof v === "string") out = jstr(v);
  else if (Array.isArray(v)) out = v.length ? "[\n" + v.map((x) => pad1 + stringifyProject(x, level + 1)).join(",\n") + "\n" + pad + "]" : "[]";
  else {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out = keys.length ? "{\n" + keys.map((k) => pad1 + jstr(k) + ": " + stringifyProject(v[k], level + 1)).join(",\n") + "\n" + pad + "}" : "{}";
  }
  return level === 0 ? out + "\n" : out;
}

/** The tree as plain JSON values. */
export function toPlain(v: JVal | undefined): Plain {
  if (v === null || v === undefined) return null;
  if (v instanceof JNum) return v.v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") { const o: { [key: string]: Plain } = {}; for (const k of Object.keys(v)) o[k] = toPlain(v[k]); return o; }
  return v;
}

/**
 * Plain JSON as a tree, borrowing number tokens from `prev` (the value being replaced) wherever the number
 * is unchanged, and its int/float style where it changed.  A number with no predecessor is written as a
 * double when `floats` is set (lengths, ratios) and as an integer otherwise when it is whole.
 */
export function fromPlain(p: Plain | undefined, prev?: JVal, floats = true): JVal {
  if (p === null || p === undefined) return null;
  if (typeof p === "number") {
    if (prev instanceof JNum) { if (prev.v === p) return prev; return new JNum(formatNumber(p, prev.isFloat || !Number.isInteger(p))); }
    return new JNum(formatNumber(p, floats));
  }
  if (typeof p === "boolean" || typeof p === "string") return p;
  if (Array.isArray(p)) { const pa = Array.isArray(prev) ? prev : []; return p.map((x, i) => fromPlain(x, pa[i] !== undefined ? pa[i] : pa[0], floats)); }
  const po = isJObj(prev) ? prev : {};
  const o: JObj = {};
  for (const k of Object.keys(p)) o[k] = fromPlain(p[k], po[k], floats);
  return o;
}

export function getPath(root: JVal, path: readonly string[]): JVal | undefined {
  let v: JVal | undefined = root;
  for (const k of path) { if (!isJObj(v)) return undefined; v = v[k]; }
  return v;
}

/** Set root[path] (creating objects on the way); returns false when the value was already equal. */
export function setPath(root: JVal, path: readonly string[], value: Plain, floats = true): boolean {
  if (!isJObj(root) || !path.length) return false;
  let o: JObj = root;
  for (let i = 0; i < path.length - 1; i++) { const k = path[i]; let c = o[k]; if (!isJObj(c)) { c = {}; o[k] = c; } o = c; }
  const last = path[path.length - 1], prev = o[last];
  if (prev !== undefined && JSON.stringify(toPlain(prev)) === JSON.stringify(value)) return false;
  o[last] = fromPlain(value, prev, floats);
  return true;
}

/** One edit of the project file: a dotted path and its new plain value (`ints` for counts and enums). */
export interface ProjectEdit { path: string[]; value: Plain; ints?: boolean }

/** Apply edits to the file text; returns the new text and the edits that changed something. */
export function editProject(text: string, edits: readonly ProjectEdit[]): { text: string; changed: ProjectEdit[] } {
  const root = parseProject(text);
  const changed = edits.filter((e) => setPath(root, e.path, e.value, !e.ints));
  return { text: changed.length ? stringifyProject(root) : text, changed };
}

// ---------------------------------------------------------------- the board's design settings (KiCad's defaults)
// BOARD_DESIGN_SETTINGS' constructor and board_design_settings.cpp's PARAMs: what a value reads as when
// the project file does not carry it.
export const RULE_DEFAULTS: Record<string, number | boolean> = {
  min_clearance: 0, min_connection: 0, min_track_width: 0.2, min_via_annular_width: 0.1, min_via_diameter: 0.5, min_through_hole_diameter: 0.3,
  min_microvia_diameter: 0.2, min_microvia_drill: 0.1, min_hole_to_hole: 0.25, min_hole_clearance: 0.25, min_silk_clearance: 0, min_groove_width: 0,
  min_text_height: 0.8, min_text_thickness: 0.08, min_copper_edge_clearance: 0.5, solder_mask_to_copper_clearance: 0, max_error: 0.005,
  min_resolved_spokes: 2, use_height_for_length_calcs: true, allow_microvias: false, allow_blind_buried_vias: false,
};

/** board.design_settings.defaults: [key stem, panel row label] in PANEL_SETUP_TEXT_AND_GRAPHICS' row order. */
export const LAYER_CLASSES: [string, string][] = [["silk", "Silk Layers"], ["copper", "Copper Layers"], ["board_outline", "Edge Cuts"], ["courtyard", "Courtyards"], ["fab", "Fab Layers"], ["other", "Other Layers"]];
export const DEFAULTS_DEFAULTS: Record<string, number | boolean> = {
  silk_line_width: 0.1, silk_text_size_h: 1, silk_text_size_v: 1, silk_text_thickness: 0.1, silk_text_italic: false, silk_text_upright: false,
  copper_line_width: 0.2, copper_text_size_h: 1.5, copper_text_size_v: 1.5, copper_text_thickness: 0.3, copper_text_italic: false, copper_text_upright: false,
  board_outline_line_width: 0.05, courtyard_line_width: 0.05,
  fab_line_width: 0.1, fab_text_size_h: 1, fab_text_size_v: 1, fab_text_thickness: 0.15, fab_text_italic: false, fab_text_upright: false,
  other_line_width: 0.1, other_text_size_h: 1, other_text_size_v: 1, other_text_thickness: 0.15, other_text_italic: false, other_text_upright: false,
  dimension_units: 3, dimension_precision: 4,
  apply_defaults_to_fp_fields: false, apply_defaults_to_fp_text: false, apply_defaults_to_fp_shapes: false, apply_defaults_to_fp_dimensions: false, apply_defaults_to_fp_barcodes: false,
};
export const DIMENSION_DEFAULTS: Record<string, number | boolean> = { arrow_length: 1270000, extension_offset: 500000, keep_text_aligned: true, suppress_zeroes: true, text_position: 0, units_format: 1 };

/** NETCLASS's defaults (netclass.cpp), in the project file's millimetres. */
export const NETCLASS_DEFAULTS: Record<string, Plain> = {
  bus_width: 12, clearance: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2, line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1,
  name: "Default", pcb_color: "rgba(0, 0, 0, 0.000)", priority: 2147483647, schematic_color: "rgba(0, 0, 0, 0.000)", track_width: 0.2, tuning_profile: "", via_diameter: 0.6, via_drill: 0.3, wire_width: 6,
};
/** The integer-valued members of a netclass (written without a decimal point). */
export const NETCLASS_INT_KEYS = new Set(["bus_width", "wire_width", "line_style", "priority"]);

/** board.design_settings as plain JSON, {} when the file has none. */
export function designSettingsOf(root: JVal): { [key: string]: Plain } {
  const p = toPlain(getPath(root, ["board", "design_settings"]));
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

export const projectFile = { JNum, parseProject, stringifyProject, toPlain, fromPlain, getPath, setPath, editProject, formatNumber, designSettingsOf,
  RULE_DEFAULTS, DEFAULTS_DEFAULTS, DIMENSION_DEFAULTS, NETCLASS_DEFAULTS, LAYER_CLASSES };
