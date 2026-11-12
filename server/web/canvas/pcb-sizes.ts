// pcb-sizes.ts — the board editor's track / via sizes and routing controls, as pcbnew keeps them in
// BOARD_DESIGN_SETTINGS: the pre-defined track widths and via sizes of the project file
// (board.design_settings.track_widths / via_dimensions / diff_pair_dimensions, entry 0 being the
// "use netclass" placeholder), the netclasses with their pattern / explicit assignments
// (net_settings), the current selection (m_trackWidthIndex / m_viaSizeIndex), "use the connected
// track's width" (m_UseConnectedTrackWidth) and the routing layer pair (PCB_SCREEN::m_Route_Layer_TOP /
// _BOTTOM).  Pure data and arithmetic: no DOM, so pcb-tools.js, the editor bundle and the node tests
// all drive the same object — KiCadCanvas.pcbSizes.
//
// References: pcbnew/board_design_settings.cpp (lists, GetCurrent*, nextPredefinedIndex),
// pcbnew/router/pns_kicad_iface.cpp ImportSizes (which width a new track takes),
// pcbnew/tools/board_editor_control.cpp TrackWidthInc / ViaSizeInc (W, Shift+W, ', \),
// pcbnew/toolbars_pcb_editor.cpp UpdateTrackWidthSelectBox / UpdateViaSizeSelectBox (the labels),
// common/project/net_settings.cpp GetEffectiveNetClass, common/lset.cpp UIOrder.

export type SizeUnits = "mm" | "in" | "mil";
export interface ViaDim { diameter: number; drill: number }
export interface DiffPairDim { width: number; gap: number; via_gap: number }
/** A netclass as the project file stores it; a missing value is "not set" and falls through to a lower-priority class. */
export interface NetClassDef { name: string; priority: number; clearance?: number; track_width?: number; via_diameter?: number; via_drill?: number;
  diff_pair_width?: number; diff_pair_gap?: number; diff_pair_via_gap?: number }
/** What a net resolves to: every value filled in (the Default class completes the set). */
export interface NetClassValues { name: string; clearance: number; track_width: number; via_diameter: number; via_drill: number; diff_pair_width: number; diff_pair_gap: number; diff_pair_via_gap: number }
/** What the router draws a differential pair with (PNS::SIZES_SETTINGS DiffPairWidth / DiffPairGap / DiffPairViaGap) and where each came from. */
export interface DiffPairSizes { width: number; gap: number; viaGap: number; widthSource: string; gapSource: string }
/** board.layer_pairs entry; layers by KiCad name here (the file stores PCB_LAYER_ID numbers). */
export interface LayerPairPreset { top: string; bottom: string; enabled: boolean; name?: string }

export interface BoardSizes {
  /** false when there is no project file: the web then offers a few common sizes so W still steps. */
  hasProject: boolean;
  /** mm; [0] is the "use netclass" placeholder, as in m_TrackWidthList */
  trackWidths: number[];
  vias: ViaDim[];
  diffPairs: DiffPairDim[];
  classes: NetClassDef[];
  assignments: Record<string, string[]>;
  patterns: { pattern: string; netclass: string }[];
  minTrackWidth: number; minViaDiameter: number; minThroughDrill: number;
  /** design_settings.rules.min_clearance (BOARD_DESIGN_SETTINGS::m_MinClearance) */
  minClearance: number;
}

// NETCLASS defaults (common/netclass.cpp): 0.2 mm clearance and track, 0.6 / 0.3 mm via, 0.2 mm pair width, 0.25 mm gaps.
const DEFAULT_CLASS: NetClassValues = { name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25 };
const DEFAULT_PRIORITY = 2147483647;
// Without a .kicad_pro there is nothing pre-defined; these keep the size hotkeys useful on a lone board.
const FALLBACK_TRACKS = [0, 0.2, 0.25, 0.3, 0.5, 0.8, 1.0];
const FALLBACK_VIAS: ViaDim[] = [{ diameter: 0, drill: 0 }, { diameter: 0.6, drill: 0.3 }, { diameter: 0.8, drill: 0.4 }, { diameter: 1.0, drill: 0.5 }, { diameter: 1.2, drill: 0.6 }, { diameter: 1.6, drill: 0.8 }];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOr = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);

/** Parse a .kicad_pro (text or parsed JSON) into the lists and netclasses; anything else gives the no-project defaults. */
export function boardSizes(src: unknown): BoardSizes {
  let pro: unknown = src;
  if (typeof src === "string") { try { pro = src.trim() ? JSON.parse(src) : null; } catch (e) { pro = null; } }
  const p = obj(pro), board = p && obj(p.board), ds = board && obj(board.design_settings), ns = p && obj(p.net_settings);
  const out: BoardSizes = { hasProject: !!(ds || ns), trackWidths: [0], vias: [{ diameter: 0, drill: 0 }], diffPairs: [{ width: 0, gap: 0, via_gap: 0 }],
    classes: [], assignments: {}, patterns: [], minTrackWidth: 0, minViaDiameter: 0, minThroughDrill: 0, minClearance: 0 };
  if (!out.hasProject) { out.trackWidths = FALLBACK_TRACKS.slice(); out.vias = FALLBACK_VIAS.map((v) => ({ ...v })); }
  if (ds) {
    const tw = arr(ds.track_widths).filter((v): v is number => typeof v === "number");
    if (tw.length) out.trackWidths = tw;
    const vd = arr(ds.via_dimensions).map(obj).filter((v): v is Json => !!v && typeof v.diameter === "number" && typeof v.drill === "number").map((v) => ({ diameter: v.diameter as number, drill: v.drill as number }));
    if (vd.length) out.vias = vd;
    const dp = arr(ds.diff_pair_dimensions).map(obj).filter((v): v is Json => !!v && typeof v.width === "number" && typeof v.gap === "number" && typeof v.via_gap === "number")
      .map((v) => ({ width: v.width as number, gap: v.gap as number, via_gap: v.via_gap as number }));
    if (dp.length) out.diffPairs = dp;
    const rules = obj(ds.rules);
    if (rules) { out.minTrackWidth = numOr(rules.min_track_width, 0); out.minViaDiameter = numOr(rules.min_via_diameter, 0); out.minThroughDrill = numOr(rules.min_through_hole_diameter, 0); out.minClearance = numOr(rules.min_clearance, 0); }
  }
  if (ns) {
    for (const c of arr(ns.classes).map(obj)) {
      if (!c || typeof c.name !== "string" || !c.name) continue;
      out.classes.push({ name: c.name, priority: numOr(c.priority, c.name === "Default" ? DEFAULT_PRIORITY : 0), clearance: optNum(c.clearance), track_width: optNum(c.track_width), via_diameter: optNum(c.via_diameter), via_drill: optNum(c.via_drill),
        diff_pair_width: optNum(c.diff_pair_width), diff_pair_gap: optNum(c.diff_pair_gap), diff_pair_via_gap: optNum(c.diff_pair_via_gap) });
    }
    const asg = obj(ns.netclass_assignments);
    if (asg) for (const [net, v] of Object.entries(asg)) { const names = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && !!x); if (names.length) out.assignments[net] = names; }
    for (const pt of arr(ns.netclass_patterns).map(obj)) if (pt && typeof pt.pattern === "string" && typeof pt.netclass === "string") out.patterns.push({ pattern: pt.pattern, netclass: pt.netclass });
  }
  return out;
}

/** The Default netclass with every value present. */
export function defaultNetclass(s: BoardSizes): NetClassValues {
  const d = s.classes.find((c) => c.name === "Default");
  return { name: "Default", clearance: d && d.clearance !== undefined ? d.clearance : DEFAULT_CLASS.clearance, track_width: d && d.track_width !== undefined ? d.track_width : DEFAULT_CLASS.track_width,
    via_diameter: d && d.via_diameter !== undefined ? d.via_diameter : DEFAULT_CLASS.via_diameter, via_drill: d && d.via_drill !== undefined ? d.via_drill : DEFAULT_CLASS.via_drill,
    diff_pair_width: d && d.diff_pair_width !== undefined ? d.diff_pair_width : DEFAULT_CLASS.diff_pair_width, diff_pair_gap: d && d.diff_pair_gap !== undefined ? d.diff_pair_gap : DEFAULT_CLASS.diff_pair_gap,
    diff_pair_via_gap: d && d.diff_pair_via_gap !== undefined ? d.diff_pair_via_gap : DEFAULT_CLASS.diff_pair_via_gap };
}

const PATTERN_CACHE = new Map<string, RegExp | null>();
/** EDA_COMBINED_MATCHER( pattern, CTX_NETCLASS ): an explicit regex (/…/ or ^…$) or an anchored, case-insensitive wildcard. */
export function netclassPatternMatches(pattern: string, net: string): boolean {
  let re = PATTERN_CACHE.get(pattern);
  if (re === undefined) {
    re = null;
    try {
      if (pattern.startsWith("^") && pattern.endsWith("$") && pattern.length > 1) re = new RegExp(pattern);
      else if (pattern.startsWith("/") && pattern.length > 1) { let body = pattern.slice(1); if (body.endsWith("/")) body = body.slice(0, -1); re = new RegExp("^(?:" + body + ")$"); }
    } catch (e) { re = null; }
    PATTERN_CACHE.set(pattern, re);
  }
  if (re && re.test(net)) return true;
  // EDA_PATTERN_MATCH_WILDCARD_ANCHORED: * and ?, compared in lower case
  const wild = "^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  let wre = PATTERN_CACHE.get("w:" + pattern);
  if (wre === undefined) { try { wre = new RegExp(wild); } catch (e) { wre = null; } PATTERN_CACHE.set("w:" + pattern, wre); }
  return !!wre && wre.test(net.toLowerCase());
}

/**
 * NET_SETTINGS::GetEffectiveNetClass: the explicitly assigned classes plus every class whose pattern matches,
 * merged from the lowest priority up (a smaller priority number wins), the Default class completing whatever
 * the resolved classes leave unset.  A net with no assignment — and the empty net — is in Default.
 */
export function effectiveNetclass(s: BoardSizes, net: string): NetClassValues {
  const def = defaultNetclass(s);
  if (!net) return def;
  const names = new Set<string>();
  for (const n of s.assignments[net] || []) names.add(n);
  for (const p of s.patterns) if (netclassPatternMatches(p.pattern, net)) names.add(p.netclass);
  const resolved = Array.from(names, (n) => s.classes.find((c) => c.name === n)).filter((c): c is NetClassDef => !!c);
  if (!resolved.length) return def;
  resolved.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: NetClassValues = { ...def, name: resolved[0].name };
  for (let i = resolved.length - 1; i >= 0; i--) {
    const c = resolved[i];
    if (c.clearance !== undefined) out.clearance = c.clearance;
    if (c.track_width !== undefined) out.track_width = c.track_width;
    if (c.via_diameter !== undefined) out.via_diameter = c.via_diameter;
    if (c.via_drill !== undefined) out.via_drill = c.via_drill;
    if (c.diff_pair_width !== undefined) out.diff_pair_width = c.diff_pair_width;
    if (c.diff_pair_gap !== undefined) out.diff_pair_gap = c.diff_pair_gap;
    if (c.diff_pair_via_gap !== undefined) out.diff_pair_via_gap = c.diff_pair_via_gap;
  }
  return out;
}

/** nextPredefinedIndex: step through the real entries (1 … n-1), rolling over past the netclass placeholder. */
export function nextPredefinedIndex(index: number, forward: boolean, listSize: number): number {
  if (listSize <= 1) return 0;
  let next = index + (forward ? 1 : -1);
  if (next >= listSize) next = 1; else if (next < 1) next = listSize - 1;
  return next;
}

// ---------------------------------------------------------------- labels (toolbars_pcb_editor.cpp)
const UNIT_TEXT: Record<SizeUnits, string> = { mm: " mm", in: " in", mil: " mils" };
/** ComboBoxUnits: "%.3f" mm, "%.2f" mils, "%.5f" in, with the unit label when asked. */
export function comboBoxUnits(units: SizeUnits, mm: number, label = true): string {
  const text = units === "mm" ? mm.toFixed(3) : units === "mil" ? (mm / 0.0254).toFixed(2) : (mm / 25.4).toFixed(5);
  return label ? text + UNIT_TEXT[units] : text;
}
/** EDA_DRAW_FRAME::GetUnitPair: metric shows the last imperial unit second (mils by default), imperial shows mm. */
export function unitPair(units: SizeUnits, lastImperial: SizeUnits = "mil"): [SizeUnits, SizeUnits] {
  return units === "mm" ? ["mm", lastImperial === "in" ? "in" : "mil"] : [units, "mm"];
}
export const USE_NETCLASS_TRACK = "Track: use netclass width";
export const USE_NETCLASS_VIA = "Via: use netclass sizes";
export const EDIT_SIZES = "Edit Pre-defined Sizes...";
/** The track width choice's entries: "Track: use netclass width", then "Track: 0.250 mm (9.84 mils)" per pre-defined width. */
export function trackWidthLabels(s: BoardSizes, units: SizeUnits, lastImperial: SizeUnits = "mil"): string[] {
  const [pri, sec] = unitPair(units, lastImperial);
  return [USE_NETCLASS_TRACK].concat(s.trackWidths.slice(1).map((w) => `Track: ${comboBoxUnits(pri, w)} (${comboBoxUnits(sec, w)})`));
}
/** The via size choice's entries: "Via: use netclass sizes", then "Via: 0.800 / 0.400 mm (31.50 / 15.75 mils)". */
export function viaSizeLabels(s: BoardSizes, units: SizeUnits, lastImperial: SizeUnits = "mil"): string[] {
  const [pri, sec] = unitPair(units, lastImperial);
  const one = (u: SizeUnits, v: ViaDim) => (v.drill > 0 ? comboBoxUnits(u, v.diameter, false) + " / " + comboBoxUnits(u, v.drill, true) : comboBoxUnits(u, v.diameter, true));
  return [USE_NETCLASS_VIA].concat(s.vias.slice(1).map((v) => `Via: ${one(pri, v)} (${one(sec, v)})`));
}

// ---------------------------------------------------------------- layers
const TECH_ORDER = ["F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
/** LSET::UIOrder rank of a layer name: the copper stack front to back, the technical / user layers, then User.N. */
export function layerUiRank(name: string): number {
  if (name === "F.Cu") return 0;
  if (name === "B.Cu") return 999;
  const inner = /^In(\d+)\.Cu$/.exec(name); if (inner) return Number(inner[1]);
  const t = TECH_ORDER.indexOf(name); if (t >= 0) return 1000 + t;
  const user = /^User\.(\d+)$/.exec(name); if (user) return 2000 + Number(user[1]);
  return 3000;
}
export interface LayerEntry { name: string; label: string; color: string; copper: boolean; id: number }
interface LayerDoc { layers: Map<string, { id: number; type: string; userName: string }>; copper?: string[] }
/** Every enabled layer of the board in KiCad's selector order, labelled with the board's own layer name when it has one. */
export function enabledLayers(doc: LayerDoc | null | undefined, colorOf: (layer: string) => string): LayerEntry[] {
  if (!doc || !doc.layers) return [];
  const out: LayerEntry[] = []; let i = 0; const seq = new Map<string, number>();
  for (const [name, l] of doc.layers) {
    if (!/\./.test(name) && name !== "Margin") continue;
    seq.set(name, i++);
    out.push({ name, label: l.userName || name, color: colorOf(name), copper: /\.Cu$/.test(name) && l.type !== "user", id: l.id });
  }
  out.sort((a, b) => layerUiRank(a.name) - layerUiRank(b.name) || (seq.get(a.name) || 0) - (seq.get(b.name) || 0));
  return out;
}
/** The copper stack front to back (LSET::CuStack). */
export function copperStack(copper: string[]): string[] { return copper.slice().sort((a, b) => layerUiRank(a) - layerUiRank(b)); }
/**
 * PCB_CONTROL::LayerNext / LayerPrev (+ / -): from a non-copper layer go to B.Cu (next) or F.Cu (previous);
 * otherwise the next visible copper layer down (or up) the stack, wrapping round.  null = nothing to switch to.
 */
export function stepCopperLayer(copper: string[], current: string, forward: boolean, hidden?: Set<string> | null): string | null {
  const stack = copperStack(copper); if (!stack.length) return null;
  const at = stack.indexOf(current);
  if (at < 0) return forward ? stack[stack.length - 1] : stack[0];
  for (let n = 1; n <= stack.length; n++) {
    const l = stack[(at + (forward ? n : -n) + stack.length * n) % stack.length];
    if (!hidden || !hidden.has(l)) return l === current ? null : l;
  }
  return null;
}

// ---------------------------------------------------------------- the project file as text
/** nlohmann::json::dump( 2 ) of a value: objects with sorted keys, every element on its own line; `floats` prints numbers as doubles (1 → 1.0). */
export function kicadJson(value: unknown, level = 0, floats = true): string {
  const pad = "  ".repeat(level), pad1 = "  ".repeat(level + 1);
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") { if (!isFinite(value)) return "null"; const t = String(value); return floats && /^-?\d+$/.test(t) ? t + ".0" : t; }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return value.length ? "[\n" + value.map((v) => pad1 + kicadJson(v, level + 1, floats)).join(",\n") + "\n" + pad + "]" : "[]";
  const o = value as Json; const keys = Object.keys(o).sort();
  return keys.length ? "{\n" + keys.map((k) => pad1 + JSON.stringify(k) + ": " + kicadJson(o[k], level + 1, floats)).join(",\n") + "\n" + pad + "}" : "{}";
}
function skipWs(t: string, i: number): number { while (i < t.length && /\s/.test(t[i])) i++; return i; }
function skipString(t: string, i: number): number { i++; while (i < t.length && t[i] !== '"') i += t[i] === "\\" ? 2 : 1; return i + 1; }
/** Index just past the JSON value starting at i. */
function skipValue(t: string, i: number): number {
  i = skipWs(t, i); const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < t.length; i++) {
      if (t[i] === '"') { i = skipString(t, i) - 1; continue; }
      if (t[i] === "{" || t[i] === "[") depth++; else if (t[i] === "}" || t[i] === "]") { depth--; if (!depth) return i + 1; }
    }
    return t.length;
  }
  while (i < t.length && !/[,\]}\s]/.test(t[i])) i++;
  return i;
}
/** [start, end) of the value at an object path in JSON text, with its nesting depth; null when a key is missing. */
function jsonSpan(t: string, path: string[]): { start: number; end: number; level: number } | null {
  let i = skipWs(t, 0);
  for (let d = 0; d < path.length; d++) {
    if (t[i] !== "{") return null;
    i++; let found = false;
    for (;;) {
      i = skipWs(t, i); if (t[i] === "}" || i >= t.length) break;
      if (t[i] === ",") { i++; continue; }
      if (t[i] !== '"') return null;
      const ke = skipString(t, i); let key: unknown; try { key = JSON.parse(t.slice(i, ke)); } catch (e) { return null; }
      i = skipWs(t, ke); if (t[i] !== ":") return null; i = skipWs(t, i + 1);
      if (key === path[d]) { found = true; break; }
      i = skipValue(t, i);
    }
    if (!found) return null;
  }
  return { start: i, end: skipValue(t, i), level: path.length };
}
/**
 * Replace one value of the project file, leaving every other byte as KiCad wrote it.  When the path does not
 * exist yet the file is re-serialized instead (same content, KiCad's layout).
 */
export function setProjectValue(text: string, path: string[], value: unknown, floats = true): string {
  const span = jsonSpan(text, path);
  if (span) return text.slice(0, span.start) + kicadJson(value, span.level, floats) + text.slice(span.end);
  let root: Json; try { root = obj(JSON.parse(text)) || {}; } catch (e) { root = {}; }
  let at = root;
  for (let d = 0; d < path.length - 1; d++) { let next = obj(at[path[d]]); if (!next) { next = {}; at[path[d]] = next; } at = next; }
  at[path[path.length - 1]] = value;
  return JSON.stringify(root, null, 2) + "\n";
}
/** The three pre-defined lists as the project file stores them (entry 0 is the netclass placeholder, written as zeros). */
export function sizesToProject(text: string, s: Pick<BoardSizes, "trackWidths" | "vias" | "diffPairs">): string {
  let t = setProjectValue(text, ["board", "design_settings", "track_widths"], s.trackWidths);
  t = setProjectValue(t, ["board", "design_settings", "via_dimensions"], s.vias.map((v) => ({ diameter: v.diameter, drill: v.drill })));
  t = setProjectValue(t, ["board", "design_settings", "diff_pair_dimensions"], s.diffPairs.map((d) => ({ gap: d.gap, via_gap: d.via_gap, width: d.width })));
  return t;
}

// ---------------------------------------------------------------- the state (one board editor per page)
type Listener = () => void;
export class PcbSizes {
  sizes: BoardSizes = boardSizes(null);
  /** what `sizes` was parsed from (identity): a repeated load of the same source keeps session edits */
  src: unknown = undefined;
  trackIndex = 0;
  viaIndex = 0;
  /** BOARD_DESIGN_SETTINGS::m_DiffPairIndex (0 = the net class values) */
  diffPairIndex = 0;
  /** m_useCustomDiffPair and m_customDiffPair (Use Custom Values… / Differential Pair Dimensions…) */
  useCustomDiffPair = false;
  customDiffPair: DiffPairDim = { width: 0.2, gap: 0.25, via_gap: 0.25 };
  /** SIZES_SETTINGS::m_diffPairViaGapSameAsTraceGap — the dialog's "Via gap same as track gap" (on by default) */
  diffPairViaGapSameAsGap = true;
  /** PROJECT_LOCAL_SETTINGS::m_AutoTrackWidth — on by default */
  useConnectedWidth = true;
  /** m_TempOverrideTrackWidth: W during a route overrides the connected width until the route ends */
  tempOverride = false;
  /**
   * The custom rules' sizes for a net (PNS_KICAD_IFACE_BASE::ImportSizes queries CT_WIDTH, CT_VIA_DIAMETER,
   * CT_VIA_HOLE and CT_DIFF_PAIR_GAP while the sizes follow the netclass): set by the board tools from the
   * project's .kicad_dru; each value is the rule's pinned opt (else min) and null when no custom rule gives it.
   */
  ruleSizes: ((net: string) => { width: number | null; viaDiameter: number | null; viaDrill: number | null; dpGap: number | null; dpWidth?: number | null; widthRule?: string | null; gapRule?: string | null }) | null = null;
  layerPair: [string, string] = ["F.Cu", "B.Cu"];
  /** the board editor's active layer ("" until a board is open); the module and the toolbar keep it in step through here */
  activeLayer = "";
  layerPairPresets: LayerPairPreset[] = [];
  curvedRatsnest = false;
  /** BOARD_DESIGN_SETTINGS::m_GridOrigin / m_AuxOrigin (the drill / place file origin), mm */
  gridOrigin: [number, number] = [0, 0];
  auxOrigin: [number, number] = [0, 0];
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(): void { for (const fn of Array.from(this.listeners)) { try { fn(); } catch (e) { console.warn(e); } } }
  /** Back to a fresh board editor (the node tests share one module instance). */
  reset(): void {
    this.sizes = boardSizes(null); this.src = undefined; this.trackIndex = 0; this.viaIndex = 0; this.diffPairIndex = 0; this.useCustomDiffPair = false;
    this.customDiffPair = { width: 0.2, gap: 0.25, via_gap: 0.25 }; this.diffPairViaGapSameAsGap = true; this.useConnectedWidth = true; this.tempOverride = false;
    this.layerPair = ["F.Cu", "B.Cu"]; this.activeLayer = ""; this.layerPairPresets = []; this.curvedRatsnest = false; this.gridOrigin = [0, 0]; this.auxOrigin = [0, 0]; this.emit();
  }
  /** Take the project's settings (.kicad_pro text or object; empty = no project).  The same source again is a no-op. */
  load(src: unknown): boolean {
    const key = src === null || src === "" ? undefined : src;
    if (key === this.src) return false;
    this.src = key; this.sizes = boardSizes(key);
    if (this.trackIndex >= this.sizes.trackWidths.length) this.trackIndex = 0;
    if (this.viaIndex >= this.sizes.vias.length) this.viaIndex = 0;
    if (this.diffPairIndex >= this.sizes.diffPairs.length) this.diffPairIndex = 0;
    this.emit(); return true;
  }
  /** Replace the pre-defined lists (the Pre-defined Sizes page): sorted, the netclass placeholder first. */
  setLists(trackWidths: number[], vias: ViaDim[], diffPairs?: DiffPairDim[]): void {
    const tw = trackWidths.filter((w) => w > 0).sort((a, b) => a - b);
    const vd = vias.filter((v) => v.diameter > 0).map((v) => ({ diameter: v.diameter, drill: v.drill > 0 ? v.drill : 0 })).sort((a, b) => a.diameter - b.diameter || a.drill - b.drill);
    this.sizes = { ...this.sizes, trackWidths: [0, ...tw], vias: [{ diameter: 0, drill: 0 }, ...vd] };
    if (diffPairs) this.sizes.diffPairs = [{ width: 0, gap: 0, via_gap: 0 }, ...diffPairs.filter((d) => d.width > 0).sort((a, b) => a.width - b.width || a.gap - b.gap || a.via_gap - b.via_gap)];
    if (this.trackIndex >= this.sizes.trackWidths.length) this.trackIndex = 0;
    if (this.viaIndex >= this.sizes.vias.length) this.viaIndex = 0;
    if (this.diffPairIndex >= this.sizes.diffPairs.length) this.diffPairIndex = 0;
    this.emit();
  }
  setTrackIndex(i: number): void { this.trackIndex = Math.max(0, Math.min(Math.round(i) || 0, this.sizes.trackWidths.length - 1)); this.emit(); }
  setViaIndex(i: number): void { this.viaIndex = Math.max(0, Math.min(Math.round(i) || 0, this.sizes.vias.length - 1)); this.emit(); }
  /** PCB_ACTIONS::autoTrackWidth */
  toggleConnectedWidth(): boolean { this.useConnectedWidth = !this.useConnectedWidth; this.emit(); return this.useConnectedWidth; }
  setActiveLayer(layer: string): void { if (layer === this.activeLayer) return; this.activeLayer = layer; this.emit(); }
  setLayerPair(top: string, bottom: string): void { this.layerPair = [top, bottom]; this.emit(); }
  setCurvedRatsnest(on: boolean): void { this.curvedRatsnest = !!on; this.emit(); }
  setGridOrigin(p: [number, number]): void { this.gridOrigin = [p[0], p[1]]; this.emit(); }
  setAuxOrigin(p: [number, number]): void { this.auxOrigin = [p[0], p[1]]; this.emit(); }

  /** BOARD_DESIGN_SETTINGS::UseNetClassTrack / UseNetClassVia */
  get useNetclassTrack(): boolean { return this.trackIndex <= 0 || this.trackIndex >= this.sizes.trackWidths.length; }
  get useNetclassVia(): boolean { return this.viaIndex <= 0 || this.viaIndex >= this.sizes.vias.length; }
  /** GetCurrentTrackWidth: the selected pre-defined width, or the Default netclass's. */
  currentTrackWidth(): number { return this.useNetclassTrack ? defaultNetclass(this.sizes).track_width : this.sizes.trackWidths[this.trackIndex]; }
  /** GetCurrentViaSize / GetCurrentViaDrill (a pre-defined via without a hole takes the Default netclass's drill). */
  currentVia(): ViaDim {
    const def = defaultNetclass(this.sizes);
    if (this.useNetclassVia) return { diameter: def.via_diameter, drill: def.via_drill };
    const v = this.sizes.vias[this.viaIndex]; return { diameter: v.diameter, drill: v.drill > 0 ? v.drill : def.via_drill };
  }
  netclassOf(net: string): NetClassValues { return effectiveNetclass(this.sizes, net); }
  /**
   * PNS_KICAD_IFACE_BASE::ImportSizes — the width of a track started on `net`: the connected track's width when
   * "use existing track width" is on (and W has not overridden it), else the net's class width with "use
   * netclass", else the selected width; never below the board's minimum.
   */
  routeWidth(net: string, connectedWidth?: number | null): number {
    const min = this.sizes.minTrackWidth;
    if (this.useConnectedWidth && !this.tempOverride && connectedWidth && connectedWidth > 0) return connectedWidth;
    if (this.useNetclassTrack) { const r = this.ruleSizes ? this.ruleSizes(net) : null; return Math.max(min, r && r.width != null ? r.width : this.netclassOf(net).track_width); }
    return Math.max(min, this.currentTrackWidth());
  }
  /** The via a route on `net` drops, or the via tool places over `net`. */
  routeVia(net: string): ViaDim {
    if (this.useNetclassVia) {
      const nc = this.netclassOf(net), r = this.ruleSizes ? this.ruleSizes(net) : null;
      return { diameter: Math.max(this.sizes.minViaDiameter, r && r.viaDiameter != null ? r.viaDiameter : nc.via_diameter), drill: Math.max(this.sizes.minThroughDrill, r && r.viaDrill != null ? r.viaDrill : nc.via_drill) };
    }
    return this.currentVia();
  }
  /** W / Shift+W with nothing selected (TrackWidthInc / Dec): the next pre-defined width; mid-route it also overrides the connected width. */
  stepTrackWidth(forward: boolean, routing = false): number {
    if (routing && this.useConnectedWidth && !this.tempOverride) this.tempOverride = true;
    this.trackIndex = nextPredefinedIndex(this.trackIndex, forward, this.sizes.trackWidths.length);
    this.emit(); return this.currentTrackWidth();
  }
  /** ' and \ with nothing selected (ViaSizeInc / Dec). */
  stepViaSize(forward: boolean): ViaDim {
    this.viaIndex = nextPredefinedIndex(this.viaIndex, forward, this.sizes.vias.length);
    this.emit(); return this.currentVia();
  }
  /** BOARD_DESIGN_SETTINGS::UseNetClassDiffPair: the list's netclass entry and no custom values. */
  get useNetclassDiffPair(): boolean { return !this.useCustomDiffPair && (this.diffPairIndex <= 0 || this.diffPairIndex >= this.sizes.diffPairs.length); }
  /** DIFF_PAIR_MENU: Use Net Class Values (index 0), an entry of the list (1 …), or Use Custom Values… ("custom"). */
  setDiffPairIndex(i: number | "custom"): void {
    if (i === "custom") this.useCustomDiffPair = true;
    else { this.useCustomDiffPair = false; this.diffPairIndex = Math.max(0, Math.min(Math.round(i) || 0, this.sizes.diffPairs.length - 1)); }
    this.emit();
  }
  /** ROUTER_TOOL::DpDimensionsDialog's OK: the custom values (SetCustomDiffPairWidth / Gap / ViaGap). */
  setCustomDiffPair(d: DiffPairDim, viaGapSameAsGap: boolean): void {
    this.customDiffPair = { width: d.width, gap: d.gap, via_gap: d.via_gap }; this.diffPairViaGapSameAsGap = !!viaGapSameAsGap; this.useCustomDiffPair = true; this.emit();
  }
  /**
   * The pair a route on the nets P / N gets (BOARD_DESIGN_SETTINGS::GetCurrentDiffPair* through ROUTER_TOOL's
   * size update): the custom values, else the selected list entry, else the net's class; the class values are
   * floored at the board minimum track width and clearance, as are list or custom values below them.  The via gap
   * follows the track gap with "Via gap same as track gap" (SIZES_SETTINGS::EffectiveDiffPairViaGap).
   */
  routeDiffPair(net: string): DiffPairSizes {
    const nc = this.netclassOf(net), minW = this.sizes.minTrackWidth, minC = this.sizes.minClearance;
    const ncSource = nc.name === "Default" ? "netclass 'Default'" : `netclass '${nc.name}'`;
    let width: number, gap: number, viaGap: number, widthSource: string, gapSource: string;
    if (this.useCustomDiffPair) { width = this.customDiffPair.width; gap = this.customDiffPair.gap; viaGap = this.customDiffPair.via_gap; widthSource = gapSource = "user choice"; }
    else if (!this.useNetclassDiffPair) { const d = this.sizes.diffPairs[this.diffPairIndex]; width = d.width; gap = d.gap > 0 ? d.gap : nc.diff_pair_gap; viaGap = d.via_gap > 0 ? d.via_gap : gap; widthSource = gapSource = "user choice"; }
    else {
      width = nc.diff_pair_width; gap = nc.diff_pair_gap; viaGap = nc.diff_pair_via_gap; widthSource = gapSource = ncSource;
      const r = this.ruleSizes ? this.ruleSizes(net) : null;   // a custom track_width / diff_pair_gap rule on the pair wins over the class
      if (r && r.dpWidth != null) { width = r.dpWidth; widthSource = r.widthRule || widthSource; }
      if (r && r.dpGap != null) { gap = viaGap = r.dpGap; gapSource = r.gapRule || gapSource; }
    }
    if (width < minW) { width = minW; widthSource = "board minimum track width"; }
    if (gap < minC) { gap = minC; gapSource = "board minimum clearance"; }
    if (this.useCustomDiffPair && this.diffPairViaGapSameAsGap) viaGap = gap;
    if (!(viaGap > 0)) viaGap = gap;
    return { width, gap, viaGap, widthSource, gapSource };
  }
  /** DIFF_PAIR_MENU's entries for the list (index 1 …): "Width %s", "Width %s, gap %s", "Width %s, via gap %s", "Width %s, gap %s, via gap %s". */
  diffPairLabels(fmt: (mm: number) => string): string[] {
    return this.sizes.diffPairs.slice(1).map((d) => d.gap <= 0 ? (d.via_gap <= 0 ? `Width ${fmt(d.width)}` : `Width ${fmt(d.width)}, via gap ${fmt(d.via_gap)}`)
      : d.via_gap <= 0 ? `Width ${fmt(d.width)}, gap ${fmt(d.gap)}` : `Width ${fmt(d.width)}, gap ${fmt(d.gap)}, via gap ${fmt(d.via_gap)}`);
  }
  /** The route ended: the W override of the connected width is dropped. */
  endRoute(): void { if (this.tempOverride) { this.tempOverride = false; this.emit(); } }
  /** W / Shift+W on a selected track: the next larger (smaller) of the Default netclass width and the pre-defined widths; null = none. */
  steppedWidth(width: number, forward: boolean): number | null {
    const n = this.sizes.trackWidths.length, def = defaultNetclass(this.sizes).track_width, eps = 1e-9;
    if (forward) { for (let i = 0; i < n; i++) { const c = i > 0 ? this.sizes.trackWidths[i] : def; if (c > width + eps) return c; } }
    else for (let i = n - 1; i >= 0; i--) { const c = i > 0 ? this.sizes.trackWidths[i] : def; if (c < width - eps) return c; }
    return null;
  }
  /** ' / \ on a selected via: the next larger (smaller) of the Default netclass via and the pre-defined vias. */
  steppedVia(diameter: number, forward: boolean): ViaDim | null {
    const n = this.sizes.vias.length, def = defaultNetclass(this.sizes), eps = 1e-9;
    const at = (i: number): ViaDim => (i > 0 ? this.sizes.vias[i] : { diameter: def.via_diameter, drill: def.via_drill });
    if (forward) { for (let i = 0; i < n; i++) { const c = at(i); if (c.diameter > diameter + eps) return c; } }
    else for (let i = n - 1; i >= 0; i--) { const c = at(i); if (c.diameter < diameter - eps) return c; }
    return null;
  }
  /** PCB_CONTROL::LayerToggle / the router's via: the other layer of the routing pair (anything but the top goes to the top). */
  pairedLayer(layer: string): string { return layer === this.layerPair[0] ? this.layerPair[1] : this.layerPair[0]; }
  /** Snap a coordinate pair to the grid measured from the grid origin. */
  snapToGrid(mm: [number, number], pitch: number): [number, number] {
    if (!(pitch > 0)) return [mm[0], mm[1]];
    const [ox, oy] = this.gridOrigin; const r = (v: number, o: number) => +(Math.round((v - o) / pitch) * pitch + o).toFixed(6);
    return [r(mm[0], ox), r(mm[1], oy)];
  }
}

/** The (aux_axis_origin x y) / (grid_origin x y) of a board's (setup …), [0, 0] when absent. */
export function setupOrigins(setup: unknown): { aux: [number, number]; grid: [number, number] } {
  const out: { aux: [number, number]; grid: [number, number] } = { aux: [0, 0], grid: [0, 0] };
  if (!Array.isArray(setup)) return out;
  for (const c of setup) {
    if (!Array.isArray(c) || typeof c[1] !== "number" || typeof c[2] !== "number") continue;
    if (c[0] === "aux_axis_origin") out.aux = [c[1], c[2]]; else if (c[0] === "grid_origin") out.grid = [c[1], c[2]];
  }
  return out;
}

export const pcbSizes = {
  state: new PcbSizes(), PcbSizes, boardSizes, defaultNetclass, effectiveNetclass, netclassPatternMatches, nextPredefinedIndex,
  comboBoxUnits, unitPair, trackWidthLabels, viaSizeLabels, layerUiRank, enabledLayers, copperStack, stepCopperLayer,
  kicadJson, setProjectValue, sizesToProject, setupOrigins, USE_NETCLASS_TRACK, USE_NETCLASS_VIA, EDIT_SIZES,
};
