// kicad-canvas / plot-params — the board's (setup (pcbplotparams …)) section, PCB_PLOT_PARAMS
// (pcbnew/pcb_plot_params.cpp): read with PCB_PLOT_PARAMS_PARSER's rules (legacy layer numbering before
// board version 20240819, clamped integers) and written back with PCB_PLOT_PARAMS::Format's token order
// (gerberprecision only when it is not 6).  Layer sets are LSET::FmtHex / ParseHex strings: 128 bits, a
// nibble per four layers, highest first, an underscore every eight nibbles.
import { isList, kid, num, str } from "./sexpr";

/** PLOT_FORMAT, as (outputformat N) stores it. */
export const PLOT_FORMAT = { HPGL: 0, GERBER: 1, POST: 2, DXF: 3, PDF: 4, SVG: 5, PNG: 6 } as const;
/** DRILL_MARKS: (drillshape N). */
export const DRILL_MARKS = { NONE: 0, SMALL: 1, FULL: 2 } as const;

export interface PlotParams {
  /** board layer names, in no particular order */
  layerSelection: string[];
  /** "Plot on All Layers", in the sequence KiCad keeps (SeqStackupForPlotting when read from the file) */
  plotOnAllLayers: string[];
  disableApertMacros: boolean; useGerberExtensions: boolean; useGerberX2: boolean; includeNetlistInfo: boolean; createJobFile: boolean;
  gerberPrecision: 5 | 6;
  dashRatio: number; gapRatio: number;
  svgPrecision: number; pngDpi: number; pngAntialias: boolean;
  plotFrameRef: boolean; dxfSketch: boolean; useAuxOrigin: boolean;
  pdfFrontPopups: boolean; pdfBackPopups: boolean; pdfMetadata: boolean; pdfSingle: boolean;
  dxfPolygonMode: boolean; dxfImperial: boolean; dxfUsePcbnewFont: boolean;
  negative: boolean; a4Output: boolean; blackAndWhite: boolean;
  sketchPadsOnFab: boolean; plotPadNumbers: boolean; hideDnpOnFab: boolean; sketchDnpOnFab: boolean; crossoutDnpOnFab: boolean;
  subtractMaskFromSilk: boolean;
  format: number; mirror: boolean; drillMarks: number; scaleSelection: number;
  outputDirectory: string;
  // not stored in the file (dialog / job state)
  svgFitPageToBoard?: boolean; fineScaleX?: number; fineScaleY?: number; widthAdjust?: number; backgroundColor?: string | null;
  plotReference?: boolean; plotValue?: boolean;
  /** DXF "Single document" (m_DXFExportAsMultiLayeredFile, not stored in the board) */
  dxfSingle?: boolean;
}

// ---------------------------------------------------------------- layer ids
const FIXED: Record<string, number> = { "F.Cu": 0, "B.Cu": 2, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15,
  "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "B.CrtYd": 29, "F.CrtYd": 31, "B.Fab": 33, "F.Fab": 35, "Rescue": 37 };
/** The canonical PCB_LAYER_ID of a layer name (KiCad 9+ numbering), -1 when it is not one. */
export function layerId(name: string): number {
  if (name in FIXED) return FIXED[name];
  let m = /^In(\d+)\.Cu$/.exec(name); if (m) return 2 * Number(m[1]) + 2;
  m = /^User\.(\d+)$/.exec(name); if (m) return 39 + 2 * (Number(m[1]) - 1);
  return -1;
}
const BY_ID = new Map<number, string>();
for (const [k, v] of Object.entries(FIXED)) BY_ID.set(v, k);
export function layerName(id: number): string {
  if (BY_ID.has(id)) return BY_ID.get(id)!;
  if (id >= 4 && id <= 62 && id % 2 === 0) return `In${(id - 2) / 2}.Cu`;
  if (id >= 39 && id < 128 && id % 2 === 1) return `User.${(id - 39) / 2 + 1}`;
  return "";
}
/** LEGACY_PCB_LAYER_ID (KiCad 8 and older numbering) of a name. */
const LEGACY_FIXED: Record<string, number> = { "F.Cu": 0, "B.Cu": 31, "B.Adhes": 32, "F.Adhes": 33, "B.Paste": 34, "F.Paste": 35, "B.SilkS": 36, "F.SilkS": 37, "B.Mask": 38, "F.Mask": 39,
  "Dwgs.User": 40, "Cmts.User": 41, "Eco1.User": 42, "Eco2.User": 43, "Edge.Cuts": 44, "Margin": 45, "B.CrtYd": 46, "F.CrtYd": 47, "B.Fab": 48, "F.Fab": 49, "Rescue": 59 };
function legacyId(name: string): number {
  if (name in LEGACY_FIXED) return LEGACY_FIXED[name];
  let m = /^In(\d+)\.Cu$/.exec(name); if (m) return Number(m[1]);
  m = /^User\.(\d+)$/.exec(name); if (m && Number(m[1]) <= 9) return 49 + Number(m[1]);
  return -1;
}
const LEGACY_BY_ID = new Map<number, string>();
for (const [k, v] of Object.entries(LEGACY_FIXED)) LEGACY_BY_ID.set(v, k);
function legacyName(id: number): string {
  if (LEGACY_BY_ID.has(id)) return LEGACY_BY_ID.get(id)!;
  if (id >= 1 && id <= 30) return `In${id}.Cu`;
  if (id >= 50 && id <= 58) return `User.${id - 49}`;
  return "";
}
/** The board version from which plot layer sets use the KiCad 9 numbering (PCB_PLOT_PARAMS_PARSER). */
export const MODERN_LSET_VERSION = 20240819;

/** BASE_SET::FmtHex of a set of bit numbers (`bits` wide). */
export function fmtHex(ids: Iterable<number>, bits = 128): string {
  const on = new Set(ids); let ret = "";
  const nibbles = Math.ceil(bits / 4);
  for (let n = 0; n < nibbles; n++) {
    let v = 0;
    for (let b = 0; b < 4; b++) { const pos = n * 4 + b; if (pos < bits && on.has(pos)) v |= 1 << b; }
    if (n && !(n % 8)) ret += "_";
    ret += "0123456789abcdef"[v];
  }
  return ret.split("").reverse().join("");
}
/** BASE_SET::ParseHex: the bit numbers set in a FmtHex string (with or without the 0x). */
export function parseHex(text: string, bits = 128): number[] {
  const s = text.replace(/^0x/i, ""); const out: number[] = []; let nib = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]; if (c === "_") continue;
    const v = parseInt(c, 16); if (isNaN(v)) break;
    for (let b = 0; b < 4; b++) { const pos = nib * 4 + b; if (pos < bits && (v >> b) & 1) out.push(pos); }
    nib++;
  }
  return out.sort((a, b) => a - b);
}
/** A layer selection as the board file writes it ("0x…"): modern numbering, or the legacy one on an older board. */
export function lsetHex(names: Iterable<string>, version: number): string {
  const modern = !version || version >= MODERN_LSET_VERSION;
  const ids: number[] = [];
  for (const n of names) { const id = modern ? layerId(n) : legacyId(n); if (id >= 0) ids.push(id); }
  return "0x" + fmtHex(ids, modern ? 128 : 60);
}
export function lsetNames(hex: string, version: number): string[] {
  const modern = !version || version >= MODERN_LSET_VERSION;
  return parseHex(hex, modern ? 128 : 60).map((id) => (modern ? layerName(id) : legacyName(id))).filter((n) => !!n);
}

/** LSET::AllCuMask(): F.Cu, In1.Cu … In30.Cu, B.Cu. */
export function allCuNames(): string[] { const cu = ["F.Cu"]; for (let i = 1; i <= 30; i++) cu.push(`In${i}.Cu`); cu.push("B.Cu"); return cu; }

/** PCB_PLOTTER::DialogLayerSelection: (checked & enabled), plus every copper layer the board does not have unless
 *  for a job, so a board that later gains inner layers still plots them (and an untouched dialog writes nothing). */
export function dialogLayerSelection(checked: Iterable<string>, enabled: Iterable<string>, forJob = false): string[] {
  const en = new Set(enabled);
  const out: string[] = []; const seen = new Set<string>();
  const add = (n: string): void => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  for (const n of checked) if (en.has(n)) add(n);
  if (!forJob) for (const n of allCuNames()) if (!en.has(n)) add(n);
  return out;
}

/** LSEQ order of LSET::SeqStackupForPlotting: the board from top to bottom, then the rest in id order. */
export function seqStackupForPlotting(names: Iterable<string>): string[] {
  const set = new Set(names);
  const inner = [...set].filter((n) => /^In\d+\.Cu$/.test(n)).sort((a, b) => parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10));
  const seq = ["B.Adhes", "F.Adhes", "B.Paste", "F.Paste", "B.SilkS", "B.Mask", "B.Cu", ...inner, "F.Cu", "F.Mask", "F.SilkS", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "B.CrtYd", "F.CrtYd", "B.Fab", "F.Fab"];
  const users = [...set].filter((n) => /^User\.\d+$/.test(n)).sort((a, b) => layerId(a) - layerId(b));
  const out = seq.concat(users).filter((n) => set.has(n));
  for (const n of set) if (!out.includes(n)) out.push(n);
  return out;
}

// ---------------------------------------------------------------- defaults, read, write
export function defaultPlotParams(): PlotParams {
  const cu = ["F.Cu", "B.Cu"]; for (let i = 1; i <= 30; i++) cu.push(`In${i}.Cu`);
  return {
    layerSelection: ["F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Paste", "B.Paste", "Edge.Cuts", ...cu],
    plotOnAllLayers: [],
    disableApertMacros: false, useGerberExtensions: false, useGerberX2: true, includeNetlistInfo: true, createJobFile: true, gerberPrecision: 6,
    dashRatio: 12, gapRatio: 3, svgPrecision: 4, pngDpi: 300, pngAntialias: true,
    plotFrameRef: false, dxfSketch: false, useAuxOrigin: false,
    pdfFrontPopups: true, pdfBackPopups: true, pdfMetadata: true, pdfSingle: false,
    dxfPolygonMode: true, dxfImperial: true, dxfUsePcbnewFont: true,
    negative: false, a4Output: false, blackAndWhite: true,
    sketchPadsOnFab: false, plotPadNumbers: false, hideDnpOnFab: false, sketchDnpOnFab: true, crossoutDnpOnFab: true, subtractMaskFromSilk: false,
    format: PLOT_FORMAT.GERBER, mirror: false, drillMarks: DRILL_MARKS.SMALL, scaleSelection: 1, outputDirectory: "",
  };
}

const clampInt = (v: unknown, lo: number, hi: number, d: number): number => { const n = Math.round(num(v, d)); return Math.max(lo, Math.min(hi, n)); };
const yes = (v: unknown): boolean => { const s = str(v); return s === "yes" || s === "true" || s === "1"; };

/** PCB_PLOT_PARAMS_PARSER::Parse over a (pcbplotparams …) node (or a (setup …) node holding one). */
export function readPlotParams(node: SNode | null | undefined, version: number): PlotParams {
  const p = defaultPlotParams();
  if (!node) return p;
  const pp = node[0] === "pcbplotparams" ? node : (kid(node, "pcbplotparams") as SNode | null);
  if (!pp) return p;
  for (const c of pp.slice(1)) {
    if (!isList(c)) continue;
    const k = str(c[0]), v = c[1];
    switch (k) {
      case "layerselection": {
        if (typeof v === "number") { const cu = ["F.Cu", "B.Cu"]; for (let i = 1; i <= 30; i++) cu.push(`In${i}.Cu`); p.layerSelection = ["F.SilkS", "B.SilkS", ...cu]; }
        else p.layerSelection = lsetNames(str(v), version);
        break;
      }
      case "plot_on_all_layers_selection": p.plotOnAllLayers = seqStackupForPlotting(lsetNames(str(v), version)); break;
      case "excludeedgelayer": if (!yes(v)) { if (!p.plotOnAllLayers.includes("Edge.Cuts")) p.plotOnAllLayers.push("Edge.Cuts"); } break;
      case "disableapertmacros": p.disableApertMacros = yes(v); break;
      case "usegerberextensions": p.useGerberExtensions = yes(v); break;
      case "usegerberattributes": p.useGerberX2 = yes(v); break;
      case "usegerberadvancedattributes": p.includeNetlistInfo = yes(v); break;
      case "creategerberjobfile": p.createJobFile = yes(v); break;
      case "gerberprecision": p.gerberPrecision = clampInt(v, 5, 6, 6) as 5 | 6; break;
      case "dashed_line_dash_ratio": p.dashRatio = num(v, 12); break;
      case "dashed_line_gap_ratio": p.gapRatio = num(v, 3); break;
      case "svgprecision": p.svgPrecision = clampInt(v, 3, 6, 4); break;
      case "pngdpi": p.pngDpi = clampInt(v, 72, 4800, 300); break;
      case "pngantialias": p.pngAntialias = yes(v); break;
      case "plotframeref": p.plotFrameRef = yes(v); break;
      // T_mode is an obsolete HPGL token to the parser: the integer is read and dropped, so the DXF plot mode stays FILLED
      case "mode": break;
      case "useauxorigin": p.useAuxOrigin = yes(v); break;
      case "pdf_front_fp_property_popups": p.pdfFrontPopups = yes(v); break;
      case "pdf_back_fp_property_popups": p.pdfBackPopups = yes(v); break;
      case "pdf_metadata": p.pdfMetadata = yes(v); break;
      case "pdf_single_document": p.pdfSingle = yes(v); break;
      case "dxfpolygonmode": p.dxfPolygonMode = yes(v); break;
      case "dxfimperialunits": p.dxfImperial = yes(v); break;
      case "dxfusepcbnewfont": p.dxfUsePcbnewFont = yes(v); break;
      case "psnegative": p.negative = yes(v); break;
      case "psa4output": p.a4Output = yes(v); break;
      case "plot_black_and_white": p.blackAndWhite = yes(v); break;
      case "sketchpadsonfab": p.sketchPadsOnFab = yes(v); break;
      case "plotpadnumbers": p.plotPadNumbers = yes(v); break;
      case "hidednponfab": p.hideDnpOnFab = yes(v); break;
      case "sketchdnponfab": p.sketchDnpOnFab = yes(v); break;
      case "crossoutdnponfab": p.crossoutDnpOnFab = yes(v); break;
      case "subtractmaskfromsilk": p.subtractMaskFromSilk = yes(v); break;
      case "outputformat": p.format = clampInt(v, 0, 6, 1); break;
      case "mirror": p.mirror = yes(v); break;
      case "drillshape": p.drillMarks = clampInt(v, 0, 2, 1); break;
      case "scaleselection": p.scaleSelection = clampInt(v, 0, 4, 1); break;
      case "outputdirectory": p.outputDirectory = str(v); break;
      default: break;
    }
  }
  return p;
}

/** FormatDouble2Str: up to ten significant digits, no trailing zeros. */
const fmtD = (v: number): string => { if (Number.isInteger(v)) return String(v); return String(+v.toPrecision(10)); };
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
const yn = (b: boolean): string => (b ? "yes" : "no");

/** PCB_PLOT_PARAMS::Format: the (pcbplotparams …) section, KiCad's token order. */
export function plotParamsText(p: PlotParams, version: number): string {
  const t: string[] = [];
  t.push(`(layerselection ${lsetHex(p.layerSelection, version)})`);
  t.push(`(plot_on_all_layers_selection ${lsetHex(p.plotOnAllLayers, version)})`);
  t.push(`(disableapertmacros ${yn(p.disableApertMacros)})`, `(usegerberextensions ${yn(p.useGerberExtensions)})`, `(usegerberattributes ${yn(p.useGerberX2)})`,
    `(usegerberadvancedattributes ${yn(p.includeNetlistInfo)})`, `(creategerberjobfile ${yn(p.createJobFile)})`);
  if (p.gerberPrecision !== 6) t.push(`(gerberprecision ${p.gerberPrecision})`);
  t.push(`(dashed_line_dash_ratio ${fmtD(p.dashRatio)})`, `(dashed_line_gap_ratio ${fmtD(p.gapRatio)})`, `(svgprecision ${p.svgPrecision})`,
    `(pngdpi ${p.pngDpi})`, `(pngantialias ${yn(p.pngAntialias)})`,
    `(plotframeref ${yn(p.plotFrameRef)})`, `(mode ${p.dxfSketch ? 2 : 1})`, `(useauxorigin ${yn(p.useAuxOrigin)})`,
    `(pdf_front_fp_property_popups ${yn(p.pdfFrontPopups)})`, `(pdf_back_fp_property_popups ${yn(p.pdfBackPopups)})`, `(pdf_metadata ${yn(p.pdfMetadata)})`, `(pdf_single_document ${yn(p.pdfSingle)})`,
    `(dxfpolygonmode ${yn(p.dxfPolygonMode)})`, `(dxfimperialunits ${yn(p.dxfImperial)})`, `(dxfusepcbnewfont ${yn(p.dxfUsePcbnewFont)})`,
    `(psnegative ${yn(p.negative)})`, `(psa4output ${yn(p.a4Output)})`, `(plot_black_and_white ${yn(p.blackAndWhite)})`,
    `(sketchpadsonfab ${yn(p.sketchPadsOnFab)})`, `(plotpadnumbers ${yn(p.plotPadNumbers)})`, `(hidednponfab ${yn(p.hideDnpOnFab)})`, `(sketchdnponfab ${yn(p.sketchDnpOnFab)})`,
    `(crossoutdnponfab ${yn(p.crossoutDnpOnFab)})`, `(subtractmaskfromsilk ${yn(p.subtractMaskFromSilk)})`, `(outputformat ${p.format})`, `(mirror ${yn(p.mirror)})`,
    `(drillshape ${p.drillMarks})`, `(scaleselection ${p.scaleSelection})`, `(outputdirectory ${quote(p.outputDirectory)})`);
  return "(pcbplotparams " + t.join(" ") + ")";
}

/** The fields the file stores (PCB_PLOT_PARAMS::IsSameAs compares these). */
const STORED: (keyof PlotParams)[] = ["disableApertMacros", "useGerberExtensions", "useGerberX2", "includeNetlistInfo", "createJobFile", "gerberPrecision", "dashRatio", "gapRatio", "svgPrecision",
  "pngDpi", "pngAntialias", "plotFrameRef", "dxfSketch", "useAuxOrigin", "pdfFrontPopups", "pdfBackPopups", "pdfMetadata", "pdfSingle", "dxfPolygonMode", "dxfImperial", "dxfUsePcbnewFont",
  "negative", "a4Output", "blackAndWhite", "sketchPadsOnFab", "plotPadNumbers", "hideDnpOnFab", "sketchDnpOnFab", "crossoutDnpOnFab", "subtractMaskFromSilk", "format", "mirror", "drillMarks",
  "scaleSelection", "outputDirectory"];
export function samePlotParams(a: PlotParams, b: PlotParams): boolean {
  for (const k of STORED) if (a[k] !== b[k]) return false;
  const setEq = (x: string[], y: string[]): boolean => { const s = new Set(x); return x.length === y.length && y.every((n) => s.has(n)) && new Set(y).size === s.size; };
  if (!setEq([...new Set(a.layerSelection)], [...new Set(b.layerSelection)])) return false;
  return setEq([...new Set(a.plotOnAllLayers)], [...new Set(b.plotOnAllLayers)]);
}

/** The scale of a (scaleselection N): 0 is auto (null). */
export function scaleOf(sel: number): number | null { return [null, 1, 1.5, 2, 3][sel] ?? 1; }

/** DIALOG_PLOT's m_widthAdjustMinValue / m_widthAdjustMaxValue from the project's design rules, mm (1 nm = 1e-6 mm):
 *  [-(min track width - 1 nm), smallest netclass clearance - 1 nm]. */
export function widthAdjustLimits(proText: string | null | undefined): [number, number] {
  let minTrack = 0.2, clearance = 0.2;
  try {
    const j = JSON.parse(proText || "{}") as { board?: { design_settings?: { rules?: { min_track_width?: unknown } } }; net_settings?: { classes?: { name?: unknown; clearance?: unknown }[] } };
    const r = j.board && j.board.design_settings && j.board.design_settings.rules;
    if (r && typeof r.min_track_width === "number") minTrack = r.min_track_width;
    const classes = (j.net_settings && Array.isArray(j.net_settings.classes)) ? j.net_settings.classes : [];
    const def = classes.find((c) => c && c.name === "Default");
    if (def && typeof def.clearance === "number") clearance = def.clearance;
    for (const c of classes) if (c && c.name !== "Default" && typeof c.clearance === "number") clearance = Math.min(clearance, c.clearance);
  } catch (e) { /* the defaults */ }
  const nm = 1e-6, r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  return [r6(-(minTrack - nm)), r6(clearance - nm)];
}
export const plotParams = { widthAdjustLimits, readPlotParams, plotParamsText, samePlotParams, defaultPlotParams, lsetHex, lsetNames, fmtHex, parseHex, layerId, layerName, seqStackupForPlotting, allCuNames, dialogLayerSelection, scaleOf, PLOT_FORMAT, DRILL_MARKS };
