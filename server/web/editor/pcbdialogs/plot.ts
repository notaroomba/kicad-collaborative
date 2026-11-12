// pcbdialogs/plot — File > Plot… (pcbnew/dialogs/dialog_plot.cpp, DIALOG_PLOT) for the web board editor.
//
//   Plot format (Gerber, Postscript, SVG, DXF, PDF, PNG) and the output directory, Include Layers (UIOrder,
//   checked from the board's (pcbplotparams (layerselection …)), right-click: Select Fab Layers / Select All
//   Copper Layers / …), Plot on All Layers (a rearrange list with Move Up / Move Down, right-click: Select All /
//   Deselect All / Order as Board Stackup; its order is kept for the session like s_lastAllLayersOrder),
//   General Options, one options box per format (SetPlotFormat shows it and enables / forces the general
//   options the format takes), the solder mask alert with its Board setup link, the messages panel, Run DRC…
//   and "(%d known DRC violations; %d exclusions)", and Plot / Generate Drill Files… / Close.
//
// Plot applies the settings (applyPlotSettings): when they differ from the board's they go back into the
// board's (setup (pcbplotparams …)) as one BOARD_SETUP change, which is not an undo step (KiCad's OnModify).
// The check-zone-fills box, the PostScript adjustments and the PDF background colour are the user's
// (PCBNEW_SETTINGS in KiCad, localStorage here).  PCB_PLOTTER::Plot runs in the fab bundle (fab/plotjob.ts);
// the files download — one as itself, several as a zip laid out under the output directory.
import type { KiCadFabApi } from "../../fab/index";
import type { PlotParams } from "../../canvas/plot-params";
import type { BoardHeader } from "../../canvas/board-setup";
import { popupMenu, type PopItem } from "../../dialogs/dom";
import { applyChanges } from "../doc";
import { sendOp } from "../net";
import { E } from "../state";
import { store } from "../appstore";
import { toolCtx } from "../tools";
import { fabContext, loadFab } from "../fab-outputs";
import { loadBoardHeader, openBoardSetup } from "./board-setup";
import { BS, PLOT } from "./canvas";
import { openDrc } from "./inspect";
import { runZoneFill, zoneFillsDirty } from "./zonefill";
import { openGendrill } from "./gendrill";
import { deliver, docDir, loadPrefs, projectLastPlotPath, savePrefs, saveProjectLastPlotPath, whenDialogsClosed } from "./plot-out";
import { box, checkField, ensureCss as kitCss, errorMessage, h, iconButton, numField, reportPanel, selectField, textField, type Field, type ReportLine } from "./ui";

interface LayerRow { key: string; name: string; color: string }
const layerRows = (): LayerRow[] => ((store as unknown as { get(): { document: { layers?: LayerRow[] } } }).get().document.layers || []);

/** The formats in the dialog's order (getPlotFormat) and their PLOT_FORMAT ids. */
export const FORMATS: [number, string][] = [[1, "Gerber"], [2, "Postscript"], [5, "SVG"], [3, "DXF"], [4, "PDF"], [6, "PNG"]];
const SHEET_COLOR = "#C872AB";   // LAYER_DRAWINGSHEET in the default PCB theme

/** PCBNEW_SETTINGS' plot panel: what KiCad keeps per user rather than in the board. */
interface UserPlot { checkZones: boolean; fineScaleX: number; fineScaleY: number; widthAdjust: number; pdfBackground: string | null; svgFitPage: boolean }
const USER_KEY = "kicad.plot.board";
const USER_DEFAULTS: UserPlot = { checkZones: true, fineScaleX: 1, fineScaleY: 1, widthAdjust: 0, pdfBackground: null, svgFitPage: false };


/** s_lastAllLayersOrder: the Plot on All Layers order the dialog had when it last closed (this session). */
let lastAllLayersOrder: string[] = [];
/** the report panel's lines, kept while the dialog is reopened over a DRC or Board Setup visit */
let lastReport: ReportLine[] = [];

const isCu = (l: string): boolean => /\.Cu$/.test(l);
const FAB_TECH = new Set(["F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Fab", "B.Fab"]);

export interface PlotDialogOptions { gerber?: boolean; params?: PlotParams; outputDir?: string; allOrder?: string[]; allChecked?: string[]; variant?: string }

/** StringFromValue( …, true ) in millimetres. */
const mmText = (v: number): string => `${Number(v.toFixed(6))} mm`;

/** BOARD_EDITOR_CONTROL::Plot (and Fabrication Outputs > Gerbers…, which opens the dialog set to Gerber). */
export async function openPlotDialog(opts: PlotDialogOptions = {}): Promise<void> {
  const ctx = toolCtx() as ToolCtx;
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("Plot needs a board"); return; }
  let fab: KiCadFabApi, header: BoardHeader | null;
  let lastPath = "";
  try { [fab, header, lastPath] = await Promise.all([loadFab(), loadBoardHeader(), projectLastPlotPath()]); }
  catch (e) { console.warn(e); ctx.toast("The plot writers could not be loaded"); return; }
  const P = PLOT().params;
  const version = header ? header.version : 0;
  const stored = P.readPlotParams(header ? header.setup : null, version);
  const p: PlotParams = opts.params ? Object.assign({}, opts.params) : Object.assign({}, stored);
  if (opts.gerber) p.format = 1;
  // the project's last plot path wins over the board's output directory (DIALOG_PLOT::init_Dialog)
  if (lastPath && !opts.params) p.outputDirectory = lastPath;
  const user = loadPrefs(USER_KEY, USER_DEFAULTS);
  const mask = BS().maskPaste(header ? header.setup : null);
  show(fab, ctx, p, stored, version, user, !!(mask.maskExpansion || mask.maskMinWidth), opts, fab.variantNames(header ? header.variants : null), lastPath);
}

function show(fab: KiCadFabApi, ctx: ToolCtx, p: PlotParams, stored: PlotParams, version: number, user: UserPlot, maskAlert: boolean, opts: PlotDialogOptions, variants: string[], lastPath: string): void {
  const P = PLOT().params;
  const doc = E.kdoc as KDoc;
  const enabled = fab.plottableLayers(doc as never);          // UIOrder
  const nameOf = (l: string): string => fab.layerDisplayName(doc as never, l);
  const ro = !!ctx.viewOnly;

  // ---------------------------------------------------------------- the controls
  const fmtSel = selectField<number>(FORMATS.some(([f]) => f === p.format) ? p.format : 1, FORMATS, { key: "format", onChange: () => setPlotFormat() });
  const outDir = textField(opts.outputDir !== undefined ? opts.outputDir : p.outputDirectory, { key: "outputDir" });
  // Design variant: GetVariantNamesForUI, the default first (the board has no current variant in the web editor)
  const variantSel = selectField<string>(opts.variant && variants.includes(opts.variant) ? opts.variant : variants[0], variants.map((v) => [v, v] as [string, string]), { key: "variant" });
  /** getSelectedVariant: empty for the default */
  const selectedVariant = (): string => (variantSel.get() !== variants[0] ? variantSel.get() : "");
  outDir.input.title = "Target directory for plot files. Can be absolute or relative to the board file location.";

  // Include Layers
  const layerChecks = new Map<string, HTMLInputElement>();
  const layerList = h("div", { class: "pl-list", "data-k": "layers" });
  for (const l of enabled) {
    const cb = h("input", { type: "checkbox", checked: p.layerSelection.includes(l) });
    layerChecks.set(l, cb);
    layerList.append(h("label", { class: "pl-row", "data-layer": l }, cb, nameOf(l)));
  }
  const fabSet = (l: string): boolean => isCu(l) || FAB_TECH.has(l);
  layerList.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const set = (f: (l: string) => boolean | null): void => { for (const [l, cb] of layerChecks) { const v = f(l); if (v !== null) cb.checked = v; } };
    const items: PopItem[] = [
      { label: "Select Fab Layers", run: () => set((l) => fabSet(l)) }, { sep: true },
      { label: "Select All Copper Layers", run: () => set((l) => (isCu(l) ? true : null)) },
      { label: "Deselect All Copper Layers", run: () => set((l) => (isCu(l) ? false : null)) }, { sep: true },
      { label: "Select All Layers", run: () => set(() => true) },
      { label: "Deselect All Layers", run: () => set(() => false) }];
    popupMenu(ev.clientX, ev.clientY, items);
  });

  // Plot on All Layers: SeqStackupForPlotting, then the session's last order (arrangeAllLayersList)
  let allOrder = P.seqStackupForPlotting(enabled);
  const arrange = (seq: string[]): void => { let idx = 0; for (const l of seq) { const at = allOrder.indexOf(l); if (at < 0) continue; if (at > idx) { allOrder.splice(at, 1); allOrder.splice(idx, 0, l); } idx++; } };
  arrange(opts.allOrder || lastAllLayersOrder);
  const allChecked = new Set(opts.allChecked || p.plotOnAllLayers);
  let allSel = -1;
  const allList = h("div", { class: "pl-list", "data-k": "allLayers", tabIndex: 0 });
  const drawAll = (): void => {
    allList.replaceChildren();
    allOrder.forEach((l, i) => {
      const cb = h("input", { type: "checkbox", checked: allChecked.has(l) });
      cb.addEventListener("change", () => { if (cb.checked) allChecked.add(l); else allChecked.delete(l); });
      const row = h("div", { class: "pl-row" + (i === allSel ? " sel" : ""), "data-layer": l }, cb, h("span", null, nameOf(l)));
      row.addEventListener("pointerdown", (ev) => { if (ev.target === cb) return; allSel = i; drawAll(); });
      allList.append(row);
    });
  };
  const move = (d: number): void => { const j = allSel + d; if (allSel < 0 || j < 0 || j >= allOrder.length) return; const [l] = allOrder.splice(allSel, 1); allOrder.splice(j, 0, l); allSel = j; drawAll(); };
  allList.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    popupMenu(ev.clientX, ev.clientY, [
      { label: "Select All Layers", run: () => { allOrder.forEach((l) => allChecked.add(l)); drawAll(); } },
      { label: "Deselect All Layers", run: () => { allChecked.clear(); drawAll(); } }, { sep: true },
      { label: "Order as Board Stackup", run: () => { arrange(P.seqStackupForPlotting(enabled)); allSel = -1; drawAll(); } }]);
  });
  allList.addEventListener("keydown", (ev) => { if (ev.key === "ArrowUp" && ev.altKey) { ev.preventDefault(); move(-1); } else if (ev.key === "ArrowDown" && ev.altKey) { ev.preventDefault(); move(1); } });
  drawAll();
  const upBtn = iconButton("up", "Move current selection up", () => move(-1)), downBtn = iconButton("down", "Move current selection down", () => move(1));

  // General Options
  const sheetRef = checkField(p.plotFrameRef, "Plot drawing sheet", { key: "plotFrameRef" });
  const subtract = checkField(p.subtractMaskFromSilk, "Subtract soldermask from silkscreen", { key: "subtractMaskFromSilk", tip: "Remove silkscreen from areas without soldermask" });
  const dnpOn = p.hideDnpOnFab || p.sketchDnpOnFab || p.crossoutDnpOnFab;
  const plotDnp = checkField(dnpOn, "Indicate DNP on fabrication layers", { key: "plotDNP", tip: "Hide or cross-out DNP footprints on fabrication layers", onChange: () => syncEnables() });
  const radio = (label: string, on: boolean, tip: string): { el: HTMLElement; input: HTMLInputElement } => { const input = h("input", { type: "radio", name: "pl-dnp", checked: on }); return { input, el: h("label", { class: "pd-check", title: tip }, input, label) }; };
  const hideDnp = radio("Hide", !dnpOn || p.hideDnpOnFab, "Hide the footprint text and graphics"), crossDnp = radio("Cross-out", dnpOn && !p.hideDnpOnFab, "");
  const sketchPads = checkField(p.sketchPadsOnFab, "Sketch pads on fabrication layers", { key: "sketchPadsOnFab", tip: "Include pad outlines on F.Fab and B.Fab layers when plotting", onChange: () => syncEnables() });
  const padNumbers = checkField(p.plotPadNumbers, "Include pad numbers", { key: "plotPadNumbers" });
  const zoneCheck = checkField(user.checkZones, "Check zone fills before plotting", { key: "checkZones" });
  const drillMarks = selectField<number>(p.drillMarks, [[0, "None"], [1, "Small"], [2, "Actual size"]], { key: "drillMarks" });
  const scale = selectField<number>(p.scaleSelection, [[0, "Auto"], [1, "1:1"], [2, "3:2"], [3, "2:1"], [4, "3:1"]], { key: "scale" });
  const auxOrigin = checkField(p.useAuxOrigin, "Use drill/place file origin", { key: "useAuxOrigin", tip: "Use the drill/place file origin as the coordinate origin for plotted files" });
  const mirror = checkField(p.mirror, "Mirrored plot", { key: "mirror" });
  const negative = checkField(p.negative, "Negative plot", { key: "negative" });

  // Gerber Options
  const protel = checkField(p.useGerberExtensions, "Use Protel filename extensions", { key: "useGerberExtensions", tip: "Use Protel Gerber extensions (.GBL, .GTL, etc...)\nNo longer recommended. The official extension is .gbr" });
  const jobFile = checkField(p.createJobFile, "Generate Gerber job file", { key: "createJobFile", tip: "Generate a Gerber job file that contains info about the board,\nand the list of generated Gerber plot files" });
  const coordFmt = selectField<number>(p.gerberPrecision === 5 ? 0 : 1, [[0, "4.5, unit mm"], [1, "4.6, unit mm"]], { key: "coordFormat" });
  const x2 = checkField(p.useGerberX2, "Use extended X2 format (recommended)", { key: "useGerberX2", tip: "Use X2 Gerber file format.\nInclude  mainly X2 attributes in Gerber headers.\nIf not checked, use X1 format.\nIn X1 format, these attributes are included as comments in files." });
  const netAttrs = checkField(p.includeNetlistInfo, "Include netlist attributes", { key: "includeNetlistInfo", tip: "Include netlist metadata and aperture attributes in Gerber files.\nThey are comments in the X1 format.\nUsed to check connectivity in CAM tools and Gerber viewers." });
  const noMacros = checkField(p.disableApertMacros, "Disable aperture macros (not recommended)", { key: "disableApertMacros", tip: "Disable aperture macros in Gerber files\nUse *only* for broken Gerber viewers." });
  // Postscript Options
  const fineX = numField(user.fineScaleX, { key: "fineScaleX" }); fineX.input.title = "Set global X scale adjust for exact scale PostScript output.";
  const fineY = numField(user.fineScaleY, { key: "fineScaleY" }); fineY.input.title = "Set global Y scale adjust for exact scale PostScript output.";
  const widthAdj = numField(user.widthAdjust, { key: "widthAdjust" }); widthAdj.input.title = "Set global width correction for exact width PostScript output.\nThese width correction is intended to compensate tracks width and also pads and vias size errors.\nThe reasonable width correction value must be in a range of [-(MinTrackWidth-1), +(MinClearanceValue-1)].";
  const a4 = checkField(p.a4Output, "Force A4 output", { key: "a4Output" });
  // DXF Options
  const dxfContours = checkField(p.dxfPolygonMode, "Plot graphic items using their contours", { key: "dxfPolygonMode", tip: "Uncheck to plot graphic items using their center lines", onChange: () => syncEnables() });
  const dxfUnits = selectField<number>(p.dxfImperial ? 0 : 1, [[0, "Inches"], [1, "Millimeters"]], { key: "dxfUnits" }); dxfUnits.input.title = "The units to use for the exported DXF file";
  const dxfFont = checkField(p.dxfUsePcbnewFont, "Use KiCad font to plot text", { key: "dxfUsePcbnewFont", tip: "Check to use KiCad stroke font\nUncheck to plot single-line ASCII texts as editable text (using DXF font)" });
  const dxfSingle = checkField(!!p.dxfSingle, "Single document", { key: "dxfSingle", tip: "Export selected layers into a single DXF" });
  // SVG Options
  const svgPrec = numField(p.svgPrecision, { key: "svgPrecision", digits: 0 }); svgPrec.input.title = "This number defines how many digits are exported that are below 1 mm.\nUser unit is 10^-<N> mm\nChoose 4 if you are not sure.";
  const svgMode = selectField<number>(p.blackAndWhite ? 1 : 0, [[0, "Color"], [1, "Black and white"]], { key: "svgMode" });
  const svgFit = checkField(user.svgFitPage, "Fit page to board", { key: "svgFitPage" });
  // PDF Options
  const pdfMode = selectField<number>(p.blackAndWhite ? 1 : 0, [[0, "Color"], [1, "Black and white"]], { key: "pdfMode", onChange: () => syncEnables() });
  const frontPop = checkField(p.pdfFrontPopups, "Generate property popups for front footprints", { key: "pdfFrontPopups" });
  const backPop = checkField(p.pdfBackPopups, "Generate property popups for back footprints", { key: "pdfBackPopups" });
  const pdfMeta = checkField(p.pdfMetadata, "Generate metadata from AUTHOR & SUBJECT variables", { key: "pdfMetadata", tip: "Generate PDF document properties from AUTHOR and SUBJECT text variables" });
  const pdfSingle = checkField(p.pdfSingle, "Single document", { key: "pdfSingle" });
  let pdfBg: string | null = user.pdfBackground;
  const bgSwatch = h("input", { type: "color", value: pdfBg || "#ffffff", "data-k": "pdfBackground", title: "Background Color" });
  const bgClear = iconButton("trash", "Default (no background)", () => { pdfBg = null; drawSwatch(); });
  const drawSwatch = (): void => { bgSwatch.style.opacity = pdfBg ? "1" : "0.35"; };
  bgSwatch.addEventListener("input", () => { pdfBg = bgSwatch.value; drawSwatch(); }); drawSwatch();
  const bgLabel = h("span", { class: "pd-lbl" }, "Background Color");
  // PNG Options
  const pngDpi = numField(p.pngDpi, { key: "pngDpi", digits: 0 });
  const pngAa = checkField(p.pngAntialias, "Anti-alias", { key: "pngAntialias" });

  const row = (...c: (Node | string)[]): HTMLElement => h("div", { class: "pd-row" }, ...c);
  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  const boxes: Record<number, HTMLElement> = {
    1: box("Gerber Options", h("div", { class: "pl-cols2" }, h("div", null, protel.el, jobFile.el, row(lbl("Coordinate format:"), coordFmt.el)), h("div", null, x2.el, netAttrs.el, noMacros.el))),
    2: box("Postscript Options", h("div", { class: "pl-grid3" }, lbl("X scale factor:"), fineX.el, h("span"), lbl("Y scale factor:"), fineY.el, h("span"), lbl("Track width correction:"), widthAdj.el, h("span", { class: "unit" }, "mm")), a4.el),
    3: box("DXF Options", h("div", { class: "pl-cols2" }, h("div", null, dxfContours.el, row(lbl("Export units:"), dxfUnits.el)), h("div", null, dxfFont.el, dxfSingle.el))),
    5: box("SVG Options", h("div", { class: "pd-row" }, lbl("Precision:"), svgPrec.el, lbl("Output mode:"), svgMode.el, svgFit.el)),
    4: box("PDF Options", h("div", { class: "pl-cols2" }, h("div", null, row(lbl("Output mode:"), pdfMode.el), frontPop.el, backPop.el), h("div", null, pdfMeta.el, pdfSingle.el, row(bgLabel, bgSwatch, bgClear)))),
    6: box("PNG Options", h("div", { class: "pd-row" }, lbl("DPI:"), pngDpi.el, pngAa.el)),
  };
  const boardSetupLink = h("a", { href: "#", title: "File > Board Setup...", "data-k": "boardSetup" }, "Board setup");
  const alert = h("div", { class: "pl-alert", "data-k": "maskAlert" },
    h("span", { class: "pl-warn" }, "⚠"), h("div", null, h("div", null, "Global solder mask minimum width and/or margin are not set to 0. "), h("div", null, "Most board manufacturers expect 0 and use their own constraints for solder mask minimum width.")), boardSetupLink);
  const report = reportPanel("150px"); report.set(lastReport);
  const status = h("div", { class: "pl-status", "data-k": "status" });
  const markers = (E.markers || []) as { excluded?: boolean }[];
  const excl = markers.filter((m) => m.excluded).length, known = markers.length - excl;
  const drcBtn = h("button", { class: "btn", type: "button", "data-k": "runDrc" }, "Run DRC...");
  const drcWarn = h("span", { class: "pl-drcwarn", "data-k": "drcWarning" }, `(${known} known DRC violations; ${excl} exclusions)`);
  if (!known && !excl) drcWarn.style.display = "none";

  // ---------------------------------------------------------------- SetPlotFormat and the enable rules
  const en = (f: { input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; el: HTMLElement }, on: boolean): void => { f.input.disabled = !on || ro; f.el.classList.toggle("disabled", !on); };
  function setPlotFormat(): void {
    const fmt = fmtSel.get();
    for (const [k, b] of Object.entries(boxes)) b.style.display = +k === fmt ? "" : "none";
    alert.style.display = fmt === 1 && maskAlert ? "" : "none";
    const rules: Record<number, { drill: boolean; mirror: boolean; aux: boolean; scale: boolean; ps: boolean; neg: boolean; a4: boolean }> = {
      5: { drill: true, mirror: true, aux: true, scale: true, ps: false, neg: true, a4: false }, 4: { drill: true, mirror: true, aux: true, scale: true, ps: false, neg: true, a4: false },
      2: { drill: true, mirror: true, aux: false, scale: true, ps: true, neg: true, a4: true }, 1: { drill: false, mirror: false, aux: true, scale: false, ps: false, neg: false, a4: false },
      3: { drill: true, mirror: false, aux: true, scale: true, ps: false, neg: false, a4: false }, 6: { drill: true, mirror: true, aux: true, scale: true, ps: false, neg: true, a4: false } };
    const r = rules[fmt];
    en(drillMarks, r.drill); if (fmt === 1) drillMarks.set(0);
    en(mirror, r.mirror); if (!r.mirror) mirror.set(false);
    en(auxOrigin, r.aux); if (!r.aux) auxOrigin.set(false);
    en(scale, r.scale); if (fmt === 1) scale.set(1);
    en(fineX, r.ps); en(fineY, r.ps); en(widthAdj, r.ps);
    en(negative, r.neg); if (!r.neg) negative.set(false);
    en(a4, r.a4); if (!r.a4) a4.set(false);
    en(dxfContours, fmt === 3);
    syncEnables();
  }
  function syncEnables(): void {
    hideDnp.input.disabled = crossDnp.input.disabled = !plotDnp.get() || ro;
    en(padNumbers, sketchPads.get());
    // OnChangeDXFPlotMode: the contour mode plots text with the stroke font
    en(dxfFont, !dxfContours.get()); if (dxfContours.get()) dxfFont.set(true);
    const bw = pdfMode.get() === 1; bgSwatch.disabled = bw || ro; bgClear.disabled = bw || ro; bgLabel.classList.toggle("disabled", bw);
  }

  // ---------------------------------------------------------------- applyPlotSettings
  const reportLines: ReportLine[] = [];
  const say = (severity: ReportLine["severity"], text: string): void => { reportLines.push({ severity, text }); report.set(reportLines.slice()); lastReport = reportLines.slice(); };
  function current(): PlotParams {
    const fmt = fmtSel.get();
    const t: PlotParams = Object.assign({}, p);
    t.subtractMaskFromSilk = subtract.get(); t.plotFrameRef = sheetRef.get(); t.sketchPadsOnFab = sketchPads.get(); t.plotPadNumbers = padNumbers.get();
    t.plotValue = true; t.plotReference = true;
    t.hideDnpOnFab = plotDnp.get() && hideDnp.input.checked; t.sketchDnpOnFab = t.crossoutDnpOnFab = plotDnp.get() && crossDnp.input.checked;
    t.useAuxOrigin = auxOrigin.get(); t.scaleSelection = scale.get(); t.drillMarks = drillMarks.get(); t.mirror = mirror.get();
    t.dxfPolygonMode = dxfContours.get(); t.dxfImperial = dxfUnits.get() === 0; t.dxfUsePcbnewFont = dxfFont.get(); t.dxfSingle = dxfSingle.get();
    if (fmt === 5) t.blackAndWhite = svgMode.get() === 1;
    else if (fmt === 4) { t.blackAndWhite = pdfMode.get() === 1; t.pdfFrontPopups = frontPop.get(); t.pdfBackPopups = backPop.get(); t.pdfMetadata = pdfMeta.get(); t.pdfSingle = pdfSingle.get(); }
    else if (fmt === 6) t.blackAndWhite = false;
    else t.blackAndWhite = true;
    t.format = fmt;
    t.disableApertMacros = noMacros.get(); t.useGerberExtensions = protel.get(); t.useGerberX2 = x2.get(); t.includeNetlistInfo = netAttrs.get(); t.createJobFile = jobFile.get();
    t.gerberPrecision = coordFmt.get() === 0 ? 5 : 6;
    t.svgPrecision = Math.max(3, Math.min(6, Math.round(svgPrec.get()))); svgPrec.set(t.svgPrecision);
    t.pngDpi = Math.max(72, Math.min(2400, Math.round(pngDpi.get()))); pngDpi.set(t.pngDpi);
    t.pngAntialias = pngAa.get(); t.svgFitPageToBoard = svgFit.get();
    // PCB_PLOTTER::DialogLayerSelection: the copper layers the board does not have stay selected
    t.layerSelection = P.dialogLayerSelection(enabled.filter((l) => layerChecks.get(l)!.checked), enabled);
    t.plotOnAllLayers = allOrder.filter((l) => allChecked.has(l));
    t.negative = negative.get(); t.a4Output = a4.get();
    t.outputDirectory = outDir.get().replace(/\\/g, "/");
    t.backgroundColor = fmt === 4 && !t.blackAndWhite ? pdfBg : null;
    return t;
  }
  let lastPlotPath = lastPath;
  /** the BOARD_SETUP change applyPlotSettings sent last (KiCad's SetPlotSettings + OnModify is synchronous) */
  let saving: Promise<boolean> = Promise.resolve(false);
  function applyPlotSettings(): PlotParams {
    const t = current();
    // the PostScript adjustments, constrained as setDouble does (PLOT_MIN_SCALE 0.01, PLOT_MAX_SCALE 100)
    const clamp = (f: Field<number>, what: string): number => { const v = f.get(); const c = Math.max(0.01, Math.min(100, v || 0)); if (c !== v) { f.set(c); say("info", `${what} scale constrained.`); } return c; };
    t.fineScaleX = clamp(fineX, "X"); t.fineScaleY = clamp(fineY, "Y");
    // PS Width correction: setInt( m_PSWidthAdjust, …, -(m_TrackMinWidth - 1), GetSmallestClearanceValue() - 1 )
    const [lo, hi] = P.widthAdjustLimits(E.proSettings);
    const wa = widthAdj.get() || 0, waC = Math.min(hi, Math.max(lo, wa));
    if (waC !== wa) {
      widthAdj.set(waC);
      say("warning", `Width correction constrained.  The width correction value must be in the range of [${mmText(lo)}; ${mmText(hi)}] for the current design rules.`);
    }
    t.widthAdjust = waC;
    user.checkZones = zoneCheck.get(); user.fineScaleX = t.fineScaleX; user.fineScaleY = t.fineScaleY; user.widthAdjust = t.widthAdjust; user.pdfBackground = pdfBg; user.svgFitPage = svgFit.get();
    savePrefs(USER_KEY, user);
    if (!ro && t.outputDirectory !== lastPlotPath) { lastPlotPath = t.outputDirectory; void saveProjectLastPlotPath(t.outputDirectory); }
    if (!ro && !P.samePlotParams(stored, t)) {
      saving = saveToBoard(t, version).then((ok) => { if (ok) Object.assign(stored, t); return ok; });
    }
    return t;
  }

  // ---------------------------------------------------------------- Plot
  let busy = false;
  async function plot(): Promise<void> {
    if (busy) return;
    const t = applyPlotSettings();
    if (!t.layerSelection.length) { errorMessage("No layer selected, Nothing to plot"); return; }   // !GetLayerSelection().any()
    busy = true;   // the messages panel keeps what earlier plots reported, as KiCad's does
    try {
      await saving;   // applyPlotSettings' OnModify marks the fills dirty before CheckAllZones looks
      // ZONE_FILLER_TOOL::CheckAllZones: only when the board changed (any edit, undo, redo or another user's change)
      // since the last fill of every zone
      if (user.checkZones && !ro && zoneFillsDirty() && [...doc.items.values()].some((it) => it.kind === "zone")) {
        status.textContent = "Check Zones";
        await runZoneFill(ctx, { ids: [...doc.items.values()].filter((it) => it.kind === "zone").map((it) => it.id), title: null, status, label: "Fill Zone(s)", all: true });
        status.textContent = "";
      }
      const fctx = await fabContext(); if (!fctx) return;
      fctx.variant = selectedVariant();
      const colors: Record<string, string> = {}; for (const r of layerRows()) colors[r.key] = r.color;
      const vars = (E.proSettings ? ((): Record<string, string> => { try { return JSON.parse(E.proSettings).text_variables || {}; } catch (e) { return {}; } })() : {}) as Record<string, string>;
      const res = await fab.plotBoard(fctx, { params: t, layers: [...enabled.filter((l) => t.layerSelection.includes(l)), ...t.layerSelection.filter((l) => !enabled.includes(l))], common: t.plotOnAllLayers, colors, sheetColor: SHEET_COLOR, background: t.backgroundColor,
        outputDir: t.outputDirectory, boardDir: docDir(), author: vars.AUTHOR, subject: vars.SUBJECT });
      for (const l of res.report) say(l.severity, l.text);
      await deliver(fab, res.files, `${fctx.projectName}-plot.zip`);
    } catch (e) {
      console.error(e); say("error", "Plot failed: " + (e instanceof Error ? e.message : String(e)));
    } finally { busy = false; status.textContent = ""; }
  }

  const keep = (): PlotDialogOptions => ({ params: current(), outputDir: outDir.get(), allOrder: allOrder.slice(), allChecked: [...allChecked], variant: variantSel.get() });
  const reopen = (o: PlotDialogOptions): void => { void openPlotDialog(o); };

  // ---------------------------------------------------------------- the dialog
  const spec = {
    title: "Plot", width: 980, noEnter: true,
    buttons: [
      { label: "Plot", primary: true, isDefault: true, id: "plot", fn: () => { void plot(); } },
      { label: "Generate Drill Files...", id: "drill", fn: () => { const t = applyPlotSettings(); const o = keep(); lastAllLayersOrder = allOrder.slice(); whenDialogsClosed(() => reopen(o)); void openGendrill({ params: t }); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => { lastAllLayersOrder = allOrder.slice(); },
    build(body: HTMLElement) {
      kitCss(); ensureCss();
      body.classList.add("pl-body");
      body.append(
        h("div", { class: "pl-top" }, h("span", { class: "pd-lbl" }, "Plot format:"), fmtSel.el, h("span", { class: "pd-lbl" }, "Design variant:"), variantSel.el, h("span", { class: "pd-lbl" }, "Output directory:"), outDir.el),
        h("div", { class: "pl-mid" },
          box("Include Layers", layerList),
          box("Plot on All Layers", allList, h("div", { class: "pd-row" }, upBtn, downBtn)),
          box("General Options",
            sheetRef.el, subtract.el, plotDnp.el, h("div", { class: "pl-indent" }, hideDnp.el, crossDnp.el), sketchPads.el, h("div", { class: "pl-indent" }, padNumbers.el), zoneCheck.el,
            h("div", { class: "pl-grid" }, lbl("Drill marks:"), drillMarks.el, lbl("Scaling:"), scale.el), auxOrigin.el, mirror.el, negative.el)),
        ...Object.values(boxes), alert, status, report.el,
        h("div", { class: "pd-row pl-drc" }, drcBtn, drcWarn));
      drcBtn.addEventListener("click", () => { const o = keep(); applyPlotSettings(); whenDialogsClosed(() => reopen(o)); openDrc(ctx); });
      boardSetupLink.addEventListener("click", (ev) => { ev.preventDefault(); const o = keep(); whenDialogsClosed(() => reopen(o)); void openBoardSetup(ctx, "Solder Mask/Paste"); });
      setPlotFormat();
    },
  };
  KDialogs!.open(spec as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}

/** SetPlotSettings + OnModify: the settings into (setup (pcbplotparams …)), one BOARD_SETUP change, no undo step. */
export async function saveToBoard(t: PlotParams, version: number): Promise<boolean> {
  try {
    const header = await loadBoardHeader(); if (!header) return false;
    const setup = BS().setupWithPlotParams(header.setup, t, header.version || version);
    const change = BS().boardSetupChange({ setup: BS().sectionText(setup) });
    sendOp([change], false); applyChanges([change]);
    return true;
  } catch (e) { console.warn("plot settings not saved", e); return false; }
}

const CSS = `
.pl-body { display: flex; flex-direction: column; gap: 4px; }
.pl-top { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.pl-top input[type=text] { flex: 1 1 auto; }
.pl-mid { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) minmax(300px, 1.6fr); gap: 0 14px; }
.pl-list { height: 270px; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); padding: 2px 0; outline: none; }
.pl-row { display: flex; gap: 6px; align-items: center; padding: 1px 6px; color: var(--ink); white-space: nowrap; cursor: default; }
.pl-row input { width: auto; margin: 0; }
.pl-row.sel { background: var(--accent); color: var(--on-accent); }
.pl-indent { padding-left: 22px; display: flex; gap: 14px; }
.pl-grid { display: grid; grid-template-columns: max-content minmax(80px, 140px) max-content minmax(80px, 140px); gap: 6px 8px; align-items: center; margin: 4px 0; }
.pl-grid3 { display: grid; grid-template-columns: max-content minmax(80px, 140px) max-content; gap: 6px 8px; align-items: center; margin: 4px 0; }
.pl-cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.pl-alert { display: flex; gap: 10px; align-items: center; color: var(--ink); padding: 4px 0; }
.pl-alert a { color: var(--accent); white-space: nowrap; }
.pl-warn { color: var(--warn, var(--accent)); font-size: 18px; }
.pl-status { min-height: 1.2em; color: var(--ink-2); }
.pl-drcwarn { color: var(--ink-2); }
.pl-drc { margin-top: 6px; }
.pd-lbl.disabled, .pd-check.disabled { color: var(--ink-3, var(--ink-2)); }
@media (max-width: 900px) { .pl-mid { grid-template-columns: 1fr; } .pl-cols2 { grid-template-columns: 1fr; } .pl-list { height: 160px; } }
`;
let cssDone = false;
function ensureCss(): void { if (cssDone || typeof document === "undefined") return; cssDone = true; const st = document.createElement("style"); st.id = "pl-css"; st.textContent = CSS; document.head.appendChild(st); }
