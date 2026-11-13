// web/fab/plotjob — PCB_PLOTTER::Plot (pcbnew/pcb_plotter.cpp) for the browser: the selected layers in
// UIOrder, one file per layer named by BuildPlotFileName (<board>-<Layer_Name>.<ext>, Protel extensions on
// request), or a single document for PDF ("Single document") and DXF; the Gerber job file; the reporter
// lines KiCad prints ("Plotted to '…'.", "Created Gerber job file '…'.", "Done.").
import { type PlotParams, defaultPlotParams } from "../canvas/plot-params";
import { writeDxf } from "./dxf";
import { gerberJobFile } from "./gbrjob";
import { projectGuid, writeGerber } from "./gerber";
import { type FabContext, VERSION_SUFFIX, setupOf, layerAttrs, layerDisplayName, modelOf, plottableLayers, projectNameOf, protelExtension } from "./index";
import { boardPage } from "./pageplot";
import { PlotLog, type PlotOptions, plotFile } from "./plot";
import { writePdf } from "./pdf";
import { type PlotPage, isoDateTime } from "./plotter";
import { writePs } from "./ps";
import { writePng } from "./raster";
import { writeSvg } from "./svg";

export interface BoardPlotRequest {
  params: PlotParams;
  /** the layers to plot, UIOrder */
  layers: string[];
  /** Plot on All Layers, in the list's order */
  common: string[];
  colors: Record<string, string>; sheetColor: string; background?: string | null;
  /** the output directory as typed (relative to the board's folder) and the board's folder in the project */
  outputDir: string; boardDir?: string;
  /** default netclass clearance for the job file */
  clearance?: number; thickness?: number;
  /** ${AUTHOR} / ${SUBJECT} resolved, for "Generate metadata" */
  author?: string; subject?: string;
}
export interface ReportLine { severity: "error" | "warning" | "info" | "action"; text: string }
export interface PlotFile { name: string; path: string; data: string | Uint8Array; layer?: string }
export interface BoardPlotResult { files: PlotFile[]; report: ReportLine[] }

export const EXT: Record<number, string> = { 1: "gbr", 2: "ps", 3: "dxf", 4: "pdf", 5: "svg", 6: "png" };

/** The output directory joined to a file name, as the reporter shows it ("plots/board-F_Cu.gbr"). */
export function outputPath(dir: string, boardDir: string | undefined, name: string): string {
  let d = (dir || "").replace(/\\/g, "/").trim();
  if (!/^(\/|[A-Za-z]:\/|~)/.test(d) && boardDir) d = boardDir.replace(/\/+$/, "") + (d ? "/" + d : "");
  d = d.replace(/(^|\/)\.\//g, "$1").replace(/\/+$/, "");
  return d ? d + "/" + name : name;
}

/** BuildPlotFileName: <board>-<layer name, dots as underscores>.<ext>. */
export function plotFileName(board: string, layerName: string, ext: string): string { return `${board}-${layerName.replace(/\./g, "_")}.${ext}`; }

export async function plotBoard(ctx: FabContext, req: BoardPlotRequest): Promise<BoardPlotResult> {
  const p = req.params, m = modelOf(ctx), board = projectNameOf(ctx), log = new PlotLog();
  const report: ReportLine[] = []; const files: PlotFile[] = [];
  if (!req.layers.length) { report.push({ severity: "error", text: "No layers selected for plotting." }); return { files, report }; }
  const date = ctx.date || new Date();
  const version = String((ctx.doc as unknown as { kicadVersion?: string }).kicadVersion || "10.99") + VERSION_SUFFIX;
  const name = (n: string): string => outputPath(req.outputDir, req.boardDir, n);
  const layers = req.layers.filter((l) => !/\.Cu$/.test(l) || m.copper.includes(l));   // copperLayerShouldBeSkipped
  const add = (n: string, data: string | Uint8Array, layer?: string): void => { const path = name(n); files.push({ name: n, path, data, layer }); report.push({ severity: "action", text: `Plotted to '${path}'.` }); };

  if (p.format === 1) {
    const opt: PlotOptions = { plotReference: p.plotReference !== false, plotValue: p.plotValue !== false, subtractMaskFromSilk: p.subtractMaskFromSilk, commonLayers: req.common,
      hideDnpOnFab: p.hideDnpOnFab, sketchDnpOnFab: p.sketchDnpOnFab, crossoutDnpOnFab: p.crossoutDnpOnFab, sketchPadsOnFab: p.sketchPadsOnFab, plotPadNumbers: p.plotPadNumbers };
    const rev = (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?";
    const iso = isoDateTime(date);
    const job: { name: string; layer: string }[] = [];
    let edge = undefined as ReturnType<typeof plotFile> | undefined;
    for (const layer of layers) {
      const prims = plotFile(m, layer, opt, log);
      if (layer === "Edge.Cuts") edge = prims;
      const text = writeGerber(prims, layerAttrs(layer, m.copper), { x2: p.useGerberX2, origin: p.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad,Pcbnew,${version}`, date: iso,
        project: { name: board, guid: projectGuid(board + ".kicad_pcb"), rev }, precision: p.gerberPrecision, netAttributes: p.includeNetlistInfo, disableMacros: p.disableApertMacros });
      const ext = p.useGerberExtensions ? protelExtension(layer, m.copper) : "gbr";
      const n = plotFileName(board, layerDisplayName(ctx.doc, layer), ext);
      add(n, text, layer); job.push({ name: n, layer });
    }
    if (p.createJobFile) {
      if (!edge) edge = plotFile(m, "Edge.Cuts", { plotReference: false, plotValue: false, subtractMaskFromSilk: false }, log);
      const text = gerberJobFile({ m, setup: setupOf(ctx), files: job, projectName: board, guid: projectGuid(board + ".kicad_pcb"), rev, version, date: iso,
        clearance: req.clearance, thickness: req.thickness ?? (ctx.doc as unknown as { thickness?: number }).thickness, edge, layerName: (l) => layerDisplayName(ctx.doc, l) });
      const n = `${board}-job.gbrjob`; const path = name(n);
      files.push({ name: n, path, data: text });
      report.push({ severity: "action", text: `Created Gerber job file '${path}'.` });
    }
  } else {
    const pages: { page: PlotPage; layer: string }[] = [];
    layers.forEach((layer, i) => {
      pages.push({ layer, page: boardPage(m, { params: p, layer, common: req.common, layerName: layerDisplayName(ctx.doc, layer), colors: req.colors, sheetColor: req.sheetColor,
        background: req.background, pageNumber: i + 1, pageCount: layers.length, interactive: true }, log) });
    });
    const title = (ctx.doc.titleBlock && ctx.doc.titleBlock.title) || "";
    const meta = p.pdfMetadata ? { author: req.author || "", subject: req.subject || "" } : {};
    if (!pages.length) { /* every selected layer was a copper layer the board does not have */ }
    else if (p.format === 4 && p.pdfSingle) add(`${board}.pdf`, writePdf(Object.assign({ pages: pages.map((x) => x.page), creator: "PCBNEW", title, date, fileName: `${board}.pdf` }, meta)));
    else if (p.format === 3 && p.dxfSingle) {
      const pg = pages[0].page;
      add(`${board}.dxf`, writeDxf(pages.map((x) => ({ name: layerDisplayName(ctx.doc, x.layer), color: req.colors[x.layer] || "#000000", page: Object.assign({}, x.page, { h: pg.h }) })), { imperial: p.dxfImperial, polygonMode: p.dxfPolygonMode, nativeText: !p.dxfUsePcbnewFont }));
    } else {
      for (const { page, layer } of pages) {
        const n = plotFileName(board, layerDisplayName(ctx.doc, layer), EXT[p.format] || "plt");
        let data: string | Uint8Array;
        if (p.format === 5) data = writeSvg(page, { precision: p.svgPrecision, creator: "PCBNEW", fileName: n, date });
        else if (p.format === 4) data = writePdf(Object.assign({ pages: [page], creator: "PCBNEW", title, date, fileName: n }, meta));
        else if (p.format === 2) data = writePs({ pages: [page], creator: "PCBNEW", title, date }, { scaleX: p.fineScaleX || 1, scaleY: p.fineScaleY || 1, fileName: n, date });
        else if (p.format === 3) data = writeDxf([{ name: layerDisplayName(ctx.doc, layer), color: req.colors[layer] || "#000000", page }], { imperial: p.dxfImperial, polygonMode: p.dxfPolygonMode, nativeText: !p.dxfUsePcbnewFont });
        else data = await writePng(page, p.pngDpi, p.pngAntialias);
        add(n, data, layer);
      }
    }
  }
  for (const w of log.messages) report.push({ severity: "warning", text: w });
  report.push({ severity: "info", text: "Done." });
  return { files, report };
}

/** What a plugin's PLOT_CONTROLLER asks for: one file holding the given layers, the first on top of the rest. */
export interface PluginPlotArgs {
  format?: number; layers?: unknown; commonLayers?: unknown;
  mirror?: boolean; negative?: boolean; plotFrameRef?: boolean; drillMarks?: number; blackAndWhite?: boolean;
  plotReference?: boolean; plotValue?: boolean; useAuxOrigin?: boolean; scale?: number; autoScale?: boolean;
  svgPrecision?: number; svgFitPageToBoard?: boolean; sketchPadsOnFab?: boolean; plotPadNumbers?: boolean;
  hideDnpOnFab?: boolean; sketchDnpOnFab?: boolean; crossoutDnpOnFab?: boolean; subtractMaskFromSilk?: boolean;
  dxfPolygonMode?: boolean; dxfImperial?: boolean; a4Output?: boolean; fineScaleX?: number; fineScaleY?: number; widthAdjust?: number;
}
export interface PluginPlotResult { name: string; base64: string; missing: string[]; warnings: string[] }

function base64(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(bin);
}

/**
 * PLOT_CONTROLLER::OpenPlotfile + PlotLayers for a plugin: PostScript, DXF, PDF or SVG of the board as it stands, written by
 * the same code as File → Plot.  The first layer is the plot's own, the others are drawn with it in the order given.
 */
export function pluginPlot(ctx: FabContext, a: PluginPlotArgs, colorOf: (layer: string) => string): PluginPlotResult {
  const format = Number(a.format);
  if (![2, 3, 4, 5].includes(format)) throw new Error("plot: the format is PostScript (2), DXF (3), PDF (4) or SVG (5)");
  const all = plottableLayers(ctx.doc);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 80) : []);
  const asked = [...list(a.layers), ...list(a.commonLayers)].filter((l, i, arr) => arr.indexOf(l) === i);
  const have = asked.filter((l) => all.includes(l)), missing = asked.filter((l) => !all.includes(l));
  if (!have.length) return { name: "", base64: "", missing, warnings: [] };
  const flag = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
  const scales = [0, 1, 1.5, 2, 3]; const sel = a.autoScale ? 0 : Math.max(1, scales.indexOf(Number(a.scale) || 1));
  const d = defaultPlotParams();
  const params: PlotParams = Object.assign(d, {
    format, layerSelection: [have[0]], plotOnAllLayers: have.slice(1), mirror: !!a.mirror, negative: !!a.negative, plotFrameRef: !!a.plotFrameRef,
    drillMarks: [0, 1, 2].includes(Number(a.drillMarks)) ? Number(a.drillMarks) : 0, blackAndWhite: flag(a.blackAndWhite, true),
    plotReference: flag(a.plotReference, true), plotValue: flag(a.plotValue, true), useAuxOrigin: !!a.useAuxOrigin, scaleSelection: sel,
    svgPrecision: Math.max(3, Math.min(6, Math.round(Number(a.svgPrecision) || 4))), svgFitPageToBoard: !!a.svgFitPageToBoard,
    sketchPadsOnFab: !!a.sketchPadsOnFab, plotPadNumbers: !!a.plotPadNumbers, hideDnpOnFab: !!a.hideDnpOnFab, sketchDnpOnFab: flag(a.sketchDnpOnFab, true),
    crossoutDnpOnFab: flag(a.crossoutDnpOnFab, true), subtractMaskFromSilk: !!a.subtractMaskFromSilk, dxfPolygonMode: flag(a.dxfPolygonMode, true),
    dxfImperial: flag(a.dxfImperial, true), a4Output: !!a.a4Output, fineScaleX: Number(a.fineScaleX) || 1, fineScaleY: Number(a.fineScaleY) || 1,
    widthAdjust: Number(a.widthAdjust) || 0, pdfSingle: false, dxfSingle: false, pdfMetadata: false, pdfFrontPopups: false, pdfBackPopups: false,
  });
  const colors: Record<string, string> = {}; for (const l of have) colors[l] = colorOf(l);
  const m = modelOf(ctx), board = projectNameOf(ctx), log = new PlotLog(), date = ctx.date || new Date(), p = params;
  const layer = have[0], lname = layerDisplayName(ctx.doc, layer);
  const page = boardPage(m, { params: p, layer, common: have.slice(1), layerName: lname, colors, sheetColor: "#C872AB", background: null, pageNumber: 1, pageCount: 1, interactive: false }, log);
  const title = (ctx.doc.titleBlock && ctx.doc.titleBlock.title) || "";
  const name = plotFileName(board, lname, EXT[format]);
  let data: string | Uint8Array;
  if (format === 5) data = writeSvg(page, { precision: p.svgPrecision, creator: "PCBNEW", fileName: name, date });
  else if (format === 4) data = writePdf({ pages: [page], creator: "PCBNEW", title, date, fileName: name });
  else if (format === 2) data = writePs({ pages: [page], creator: "PCBNEW", title, date }, { scaleX: p.fineScaleX || 1, scaleY: p.fineScaleY || 1, fileName: name, date });
  else data = writeDxf([{ name: lname, color: colors[layer] || "#000000", page }], { imperial: p.dxfImperial, polygonMode: p.dxfPolygonMode, nativeText: !p.dxfUsePcbnewFont });
  return { name, base64: base64(data), missing, warnings: [...log.messages] };
}
