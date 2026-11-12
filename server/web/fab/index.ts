// web/fab — fabrication outputs from the browser: Gerbers, drill files, a bill of materials and a
// pick-and-place file from the open board, in one click, packaged the way a fabricator's upload form wants
// them.  This entry builds static/dist/fab.js (npm run build:fab), loaded on demand by the editor
// (File > Fabrication Outputs) and exposed as window.KiCadFab for plugins and the node tests.
//
// It needs kicad-canvas loaded first (KiCadCanvas.strokeLine / strokeOrigin / dashPattern: text is plotted
// with the same stroke font the canvas draws) and a board document parsed by KiCadCanvas.parseDoc.  The
// (setup …) section of the board — solder mask and paste clearances, via tenting, the drill / place origin —
// is passed beside the document, because the editor's document keeps items only.
import { boardHeader } from "../canvas/board-setup";
import { type DrillFile, type DrillOptions, boardHoles, drillFiles } from "./drill";
import { type GerberAttrs, projectGuid, writeGerber } from "./gerber";
import { type BoardModel, type FabDoc, type Node, boardModel, isCopper } from "./model";
import { type BomLine, type BomOptions, type Placement, type PlacementOptions, bom, bomCsv, placementAscii, placementCsv, placements } from "./parts";
import { PlotLog, type PlotOptions, centrePoints, plotFile } from "./plot";
import { type FabPreset, PRESETS, presetById, jlcPlacement } from "./presets";
import { primPolys } from "./poly";
import { type Prim, type Pt } from "./prims";
import { type ZipEntry, crc32, zip } from "./zip";
import { drillJob, drillReport } from "./drilljob";
import { pnpFileName, pnpGerber } from "./pnp";
import { plotBoard, plotFileName, outputPath } from "./plotjob";
import { writeSvg } from "./svg";
import { writePdf } from "./pdf";
import { writePs } from "./ps";
import { writeDxf } from "./dxf";
import { paintPage, writePng } from "./raster";
import { gerberJobFile } from "./gbrjob";
import { boardPage } from "./pageplot";
import { type FillProgress, type FillRules, type ZoneFillResult, ZoneFiller, filledZoneNode, polyArea, storedFill } from "./zonefill";

export const VERSION_SUFFIX = "-web";

// ---------------------------------------------------------------- layer names
/** BOARD::GetStandardLayerName: the names KiCad shows (and uses in plot file names) for the canonical ones. */
const DISPLAY: { [k: string]: string } = { "F.Adhes": "F.Adhesive", "B.Adhes": "B.Adhesive", "F.SilkS": "F.Silkscreen", "B.SilkS": "B.Silkscreen", "Dwgs.User": "User.Drawings", "Cmts.User": "User.Comments",
  "Eco1.User": "User.Eco1", "Eco2.User": "User.Eco2", "F.CrtYd": "F.Courtyard", "B.CrtYd": "B.Courtyard" };
const PROTEL: { [k: string]: string } = { "F.Cu": "gtl", "B.Cu": "gbl", "F.Adhes": "gta", "B.Adhes": "gba", "F.Paste": "gtp", "B.Paste": "gbp", "F.SilkS": "gto", "B.SilkS": "gbo", "F.Mask": "gts", "B.Mask": "gbs", "Edge.Cuts": "gm1" };

/** The layer's name as the user sees it: the board's own name for it, or KiCad's standard one. */
export function layerDisplayName(doc: FabDoc, layer: string): string {
  const info = doc.layers.get(layer);
  return (info && info.userName) || DISPLAY[layer] || layer;
}
/** GetGerberProtelExtension: gtl, gbl, g2 … for inner copper, gto, gts, gm1 …; gbr for everything else. */
export function protelExtension(layer: string, copper: string[]): string {
  if (PROTEL[layer]) return PROTEL[layer];
  const i = copper.indexOf(layer);
  if (i > 0) return "g" + (i + 1);
  return "gbr";
}
/** %TF.FileFunction and %TF.FilePolarity of a layer (GetGerberFileFunctionAttribute). */
export function layerAttrs(layer: string, copper: string[]): GerberAttrs {
  const side = layer.startsWith("B.") ? "Bot" : "Top";
  const i = copper.indexOf(layer);
  if (i >= 0) return { fileFunction: `Copper,L${i + 1},${i === 0 ? "Top" : i === copper.length - 1 ? "Bot" : "Inr"}`, polarity: "Positive" };
  if (/\.Adhes$/.test(layer)) return { fileFunction: `Glue,${side}`, polarity: "Positive" };
  if (/\.Paste$/.test(layer)) return { fileFunction: `Paste,${side}`, polarity: "Positive" };
  if (/\.SilkS$/.test(layer)) return { fileFunction: `Legend,${side}`, polarity: "Positive" };
  if (/\.Mask$/.test(layer)) return { fileFunction: `Soldermask,${side}`, polarity: "Negative" };
  if (layer === "Edge.Cuts") return { fileFunction: "Profile,NP", polarity: "" };
  if (/\.Fab$/.test(layer)) return { fileFunction: `AssemblyDrawing,${side}`, polarity: "" };
  if (layer === "Dwgs.User") return { fileFunction: "OtherDrawing,Comment", polarity: "" };
  if (layer === "Cmts.User") return { fileFunction: "Other,Comment", polarity: "" };
  if (layer === "Eco1.User") return { fileFunction: "Other,ECO1", polarity: "" };
  if (layer === "Eco2.User") return { fileFunction: "Other,ECO2", polarity: "" };
  return { fileFunction: "Other,User", polarity: "" };
}
/** The layers of the board a plot can be made of, in KiCad's plot order. */
export function plottableLayers(doc: FabDoc): string[] {
  const order = ["F.Cu", "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
  const names = [...doc.layers.keys()];
  const inner = names.filter((l) => isCopper(l) && l !== "F.Cu" && l !== "B.Cu").sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
  const rest = names.filter((l) => !isCopper(l) && !order.includes(l));
  const all = ["F.Cu", ...inner, ...order.slice(1), ...rest];
  return doc.layers.size ? all.filter((l) => doc.layers.has(l)) : all;
}

// ---------------------------------------------------------------- one call per kind of output
export interface FabContext {
  doc: FabDoc;
  /** The board's (setup …) node, or the board file's text to read it from. */
  setup?: Node | string | null;
  /** Used for file names and %TF.ProjectId. */
  projectName?: string;
  /** Creation date; defaults to now. */
  date?: Date;
}
export interface OutFile { name: string; text: string; layer?: string }

function setupNode(setup: Node | string | null | undefined): Node | null {
  if (!setup) return null;
  if (typeof setup === "string") return (boardHeader(setup).setup as Node | null) || null;
  return setup;
}
/** The (setup …) node of a context. */
export function setupOf(ctx: FabContext): Node | null { return setupNode(ctx.setup); }
/** The board model for a context (read afresh: the document may have changed since the last call). */
export function modelOf(ctx: FabContext): BoardModel { return boardModel(ctx.doc, setupNode(ctx.setup)); }
function isoDate(d: Date): string {
  const p = (n: number): string => String(Math.abs(n)).padStart(2, "0"); const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
function kicadVersion(doc: FabDoc): string { return String((doc as unknown as { kicadVersion?: string }).kicadVersion || "10.99") + VERSION_SUFFIX; }
export function projectNameOf(ctx: FabContext): string {
  const raw = ctx.projectName || ctx.doc.projectName || (ctx.doc.fileName || "").replace(/\.kicad_pcb$/i, "") || "board";
  return raw.replace(/[\\/:*?"<>|]+/g, "_").trim() || "board";
}

export interface GerberJobOptions extends Partial<PlotOptions> {
  layers?: string[];
  useProtelExtensions?: boolean; useGerberX2?: boolean; useAuxOrigin?: boolean;
  precision?: 5 | 6;
}
export interface GerberResult { files: OutFile[]; warnings: string[]; prims: Map<string, Prim[]> }

/** Gerber files for the given layers (default: copper, paste, legend, mask, outline). */
export function plotGerbers(ctx: FabContext, o: GerberJobOptions = {}): GerberResult {
  const m = modelOf(ctx); const log = new PlotLog(); const name = projectNameOf(ctx);
  const layers = o.layers || PRESETS[0].layers(plottableLayers(ctx.doc), m.copper);
  const plot: PlotOptions = { plotReference: o.plotReference !== false, plotValue: o.plotValue !== false, subtractMaskFromSilk: !!o.subtractMaskFromSilk, forceTentVias: o.forceTentVias, commonLayers: o.commonLayers,
    hideDnpOnFab: o.hideDnpOnFab, sketchDnpOnFab: o.sketchDnpOnFab, crossoutDnpOnFab: o.crossoutDnpOnFab };
  const date = isoDate(ctx.date || new Date());
  const origin: Pt = o.useAuxOrigin ? m.settings.auxOrigin : [0, 0];
  const rev = (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?";
  const files: OutFile[] = []; const prims = new Map<string, Prim[]>();
  for (const layer of layers) {
    const ps = plotFile(m, layer, plot, log); prims.set(layer, ps);
    const text = writeGerber(ps, layerAttrs(layer, m.copper), { x2: o.useGerberX2 !== false, origin, software: `KiCad,Pcbnew,${kicadVersion(ctx.doc)}`, date, project: { name, guid: projectGuid(name), rev }, precision: o.precision });
    const ext = o.useProtelExtensions ? protelExtension(layer, m.copper) : "gbr";
    files.push({ name: `${name}-${layerDisplayName(ctx.doc, layer).replace(/\./g, "_")}.${ext}`, text, layer });
  }
  if (m.unfilledZones) log.warn(`${m.unfilledZones} copper zone${m.unfilledZones > 1 ? "s have" : " has"} no fill stored in the board. Fill them with Edit > Fill All Zones before ordering.`);
  return { files, warnings: [...log.messages], prims };
}

export interface DrillJobOptions { metric?: boolean; zeros?: DrillOptions["zeros"]; merge?: boolean; minimalHeader?: boolean; mirrorY?: boolean; ovalMode?: "route" | "g85"; useAuxOrigin?: boolean; extension?: string }
/** Excellon drill files. */
export function drill(ctx: FabContext, o: DrillJobOptions = {}): DrillFile[] {
  const m = modelOf(ctx);
  return drillFiles(m, projectNameOf(ctx), { metric: o.metric !== false, zeros: o.zeros || "decimal", merge: !!o.merge, minimalHeader: !!o.minimalHeader, mirrorY: !!o.mirrorY, ovalMode: o.ovalMode || "route",
    origin: o.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad ${kicadVersion(ctx.doc)}`, softwareAttr: `Kicad,Pcbnew,${kicadVersion(ctx.doc)}`, date: isoDate(ctx.date || new Date()) }, o.extension || "drl");
}

const PLACEMENT_DEFAULTS: PlacementOptions = { side: "both", smdOnly: false, excludeThroughHole: false, excludeDnp: false, useAuxOrigin: false, negateBottomX: false };
/** Placement rows (mm, Y up). */
export function positions(ctx: FabContext, o: Partial<PlacementOptions> = {}): Placement[] { return placements(modelOf(ctx), Object.assign({}, PLACEMENT_DEFAULTS, o)); }
/** Bill of materials lines. */
export function billOfMaterials(ctx: FabContext, o: Partial<BomOptions> = {}): BomLine[] { return bom(modelOf(ctx), { excludeDnp: !!o.excludeDnp }); }

// ---------------------------------------------------------------- the package
export interface PackageOptions {
  preset?: string;
  /** Overrides of the preset. */
  layers?: string[]; useAuxOrigin?: boolean; subtractMaskFromSilk?: boolean; plotReference?: boolean; plotValue?: boolean; forceTentVias?: boolean;
  mergeDrill?: boolean; excludeDnp?: boolean; includeBom?: boolean; includePlacement?: boolean;
}
export interface PackageFile { name: string; data: Uint8Array | string; kind: "gerber" | "drill" | "bom" | "placement" | "archive"; layer?: string; note?: string }
export interface FabPackage {
  preset: FabPreset; name: string;
  /** The flat list: every Gerber and drill file, the BOM and the placement file. */
  files: PackageFile[];
  /** What to download: the same files, with the Gerbers and drill files in the inner archive when the preset has one. */
  bundle: PackageFile[];
  warnings: string[];
  summary: { layers: number; copperLayers: number; holes: number; platedHoles: number; slots: number; parts: number; placed: number; bomLines: number; width: number; height: number };
  prims: Map<string, Prim[]>;
}

/** The box of the board outline's centre lines, what a fabricator quotes the board size from. */
function outlineBox(edge: Prim[] | undefined): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of centrePoints(edge || [])) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return x1 >= x0 ? [x0, y0, x1, y1] : null;
}

/** Everything a fabricator needs, by preset. */
export async function buildPackage(ctx: FabContext, o: PackageOptions = {}): Promise<FabPackage> {
  const preset = presetById(o.preset || "jlcpcb"); const m = modelOf(ctx); const name = projectNameOf(ctx);
  const useAux = o.useAuxOrigin ?? preset.useAuxOrigin;
  const layers = o.layers || preset.layers(plottableLayers(ctx.doc), m.copper);
  const g = plotGerbers(ctx, { layers, useProtelExtensions: preset.protelExtensions, useGerberX2: preset.x2, useAuxOrigin: useAux, subtractMaskFromSilk: o.subtractMaskFromSilk ?? preset.subtractMaskFromSilk,
    plotReference: o.plotReference ?? preset.plotReference, plotValue: o.plotValue ?? preset.plotValue, forceTentVias: o.forceTentVias });
  const d = drill(ctx, { metric: preset.drill.metric, zeros: preset.drill.zeros, merge: o.mergeDrill ?? preset.drill.merge, minimalHeader: preset.drill.minimalHeader, ovalMode: preset.drill.ovalMode, useAuxOrigin: useAux });
  const warnings = g.warnings.slice();
  const files: PackageFile[] = [];
  for (const f of g.files) files.push({ name: f.name, data: f.text, kind: "gerber", layer: f.layer });
  for (const f of d) { if (!f.holes && /-NPTH\./.test(f.name) && preset.id !== "kicad") continue; files.push({ name: f.name, data: f.text, kind: "drill", note: `${f.holes} hole${f.holes === 1 ? "" : "s"}, ${f.tools.length} tool${f.tools.length === 1 ? "" : "s"}` }); }
  const excludeDnp = o.excludeDnp ?? preset.excludeDnp;
  const rows = placements(m, { side: "both", smdOnly: false, excludeThroughHole: false, excludeDnp, useAuxOrigin: useAux, negateBottomX: false });
  const lines = bom(m, { excludeDnp });
  const origin: Pt = useAux ? m.settings.auxOrigin : [0, 0];
  if (o.includeBom !== false && lines.length) files.push({ name: preset.gerberArchive ? preset.bomName : `${name}-${preset.bomName}`, data: preset.bomCsv(lines, m), kind: "bom", note: `${lines.length} line${lines.length === 1 ? "" : "s"}` });
  if (o.includePlacement !== false && rows.length) files.push({ name: preset.gerberArchive ? preset.placementName : `${name}-${preset.placementName}`, data: preset.placementCsv(rows, m, origin), kind: "placement", note: `${rows.length} part${rows.length === 1 ? "" : "s"}` });

  // checks a fabricator's form would bounce
  const holes = boardHoles(m);
  const edge = g.prims.get("Edge.Cuts");
  if (layers.includes("Edge.Cuts") && (!edge || !edge.length)) warnings.push("The board has no outline on Edge.Cuts. A fabricator cannot cut a board without one.");
  if (useAux && !m.settings.auxOrigin[0] && !m.settings.auxOrigin[1]) warnings.push("No drill / place origin is set, so coordinates are measured from the page corner. That is fine for ordering; set one with Place > Drill/Place File Origin for tidier numbers.");
  if (preset.id === "jlcpcb" && lines.some((l) => !l.lcsc && !l.dnp)) warnings.push(`${lines.filter((l) => !l.lcsc && !l.dnp).length} BOM line(s) have no LCSC part number. JLCPCB's assembly page will ask you to pick those parts by hand; add an "LCSC Part #" field to skip that.`);
  if (preset.id === "pcbway" && lines.some((l) => !l.mpn && !l.lcsc && !l.dnp)) warnings.push(`${lines.filter((l) => !l.mpn && !l.lcsc && !l.dnp).length} BOM line(s) have no manufacturer part number ("MPN" field). PCBWay quotes assembly from it.`);

  let bundle = files;
  if (preset.gerberArchive) {
    const inner = await zip(files.filter((f) => f.kind === "gerber" || f.kind === "drill").map((f) => ({ name: f.name, data: f.data })), ctx.date);
    bundle = [{ name: preset.gerberArchive, data: inner, kind: "archive", note: "Gerbers and drill files: upload this one to the order page" } as PackageFile].concat(files.filter((f) => f.kind === "bom" || f.kind === "placement"));
  }
  const bb = outlineBox(edge) || ctx.doc.bbox || [0, 0, 0, 0];
  return { preset, name, files, bundle, warnings, prims: g.prims,
    summary: { layers: g.files.length, copperLayers: m.copper.length, holes: holes.length, platedHoles: holes.filter((h) => h.plated).length, slots: holes.filter((h) => h.slot).length,
      parts: m.footprints.length, placed: rows.length, bomLines: lines.length, width: bb[2] - bb[0], height: bb[3] - bb[1] } };
}

/** The whole package as one archive: <name>-<preset>.zip. */
export async function packageZip(pkg: FabPackage, when?: Date): Promise<{ name: string; data: Uint8Array }> {
  const entries: ZipEntry[] = pkg.bundle.map((f) => ({ name: f.name, data: f.data }));
  return { name: `${pkg.name}-${pkg.preset.id === "kicad" ? "fabrication" : pkg.preset.id}.zip`, data: await zip(entries, when) };
}

/**
 * ZONE_FILLER::Fill for the zones `ids` (every board zone when null): per zone, the fill outlines and island
 * flags per layer.  Null when the progress reporter cancelled it.
 */
export function fillZones(ctx: FabContext, rules: FillRules, ids: string[] | null, prog?: FillProgress): Promise<ZoneFillResult[] | null> {
  return new ZoneFiller(modelOf(ctx), rules).fill(ids, prog);
}

export const api = { plotBoard, drillJob, drillReport, pnpGerber, pnpFileName, writeSvg, writePdf, writePs, writeDxf, writePng, paintPage, gerberJobFile, boardPage, plotFileName, outputPath, fillZones, filledZoneNode, storedFill, polyArea, PRESETS, presetById, plottableLayers, layerDisplayName, layerAttrs, protelExtension, model: modelOf, plotGerbers, drillFiles: drill, positions, bom: billOfMaterials, placementCsv, placementAscii, bomCsv,
  jlcPlacement, buildPackage, packageZip, zip, crc32, writeGerber, primPolys };
export type KiCadFabApi = typeof api & { open?: () => void };
(globalThis as unknown as { KiCadFab: KiCadFabApi }).KiCadFab = Object.assign((globalThis as unknown as { KiCadFab?: KiCadFabApi }).KiCadFab || {}, api);
