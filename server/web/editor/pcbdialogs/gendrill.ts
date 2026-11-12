// pcbdialogs/gendrill — File > Fabrication Outputs > Drill Files… (pcbnew/dialogs/dialog_gendrill.cpp,
// DIALOG_GENDRILL): Output folder; Format (Excellon with Mirror Y axis, Minimal header, PTH and NPTH in single
// file, Use alternate drill mode for oval holes; or Gerber X2 with Generate tenting layers); Generate map: in
// Postscript / Gerber X2 / DXF / SVG / PDF; Origin, Units, Zeros and the Precision they give; the Messages box;
// Generate Report File…, Generate (which keeps the dialog open) and Close.
//
// updateConfig: the output directory and the origin choice are the board's plot settings (pcbplotparams'
// outputdirectory and useauxorigin), saved like the Plot dialog's; the rest is the user's (localStorage).
import type { KiCadFabApi } from "../../fab/index";
import type { PlotParams } from "../../canvas/plot-params";
import { E } from "../state";
import { toolCtx } from "../tools";
import { fabContext, loadFab } from "../fab-outputs";
import { loadBoardHeader } from "./board-setup";
import { PLOT } from "./canvas";
import { saveToBoard } from "./plot";
import { deliver, docDir, loadPrefs, saveBlob, savePrefs } from "./plot-out";
import { box, checkField, ensureCss, h, selectField, textField } from "./ui";

interface DrillPrefs { gerber: boolean; mirror: boolean; minimal: boolean; merge: boolean; altOval: boolean; tenting: boolean; genMap: boolean; mapFormat: number; metric: boolean; zeros: number }
const KEY = "kicad.gendrill";
const DEFAULTS: DrillPrefs = { gerber: false, mirror: false, minimal: false, merge: false, altOval: false, tenting: false, genMap: false, mapFormat: 1, metric: true, zeros: 0 };
const ZEROS = ["decimal", "suppress_leading", "suppress_trailing", "keep"] as const;
/** m_choiceDrillMap's choices and their PLOT_FORMAT ids */
const MAP_FORMATS: [number, string][] = [[0, "Postscript"], [1, "Gerber X2"], [2, "DXF"], [3, "SVG"], [4, "PDF"]];
const MAP_PLOT = [2, 1, 3, 5, 4];

/** BOARD_EDITOR_CONTROL::GenerateDrillFiles (and the Plot dialog's Generate Drill Files…). */
export async function openGendrill(o: { params?: PlotParams } = {}): Promise<void> {
  const ctx = toolCtx() as ToolCtx;
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("Drill files are made from a board: open the PCB editor first"); return; }
  let fab: KiCadFabApi; let header: Awaited<ReturnType<typeof loadBoardHeader>>;
  try { [fab, header] = await Promise.all([loadFab(), loadBoardHeader()]); } catch (e) { console.warn(e); ctx.toast("The drill file writers could not be loaded"); return; }
  const version = header ? header.version : 0;
  const stored = PLOT().params.readPlotParams(header ? header.setup : null, version);
  const p = Object.assign({}, o.params || stored);
  show(fab, ctx, p, stored, version);
}

function show(fab: KiCadFabApi, ctx: ToolCtx, p: PlotParams, stored: PlotParams, version: number): void {
  const pref = loadPrefs(KEY, DEFAULTS);
  const outDir = textField(p.outputDirectory, { key: "outputDir" });
  const rbExcellon = h("input", { type: "radio", name: "gd-fmt", checked: !pref.gerber, "data-k": "excellon" }), rbGerber = h("input", { type: "radio", name: "gd-fmt", checked: pref.gerber, "data-k": "gerberX2" });
  const mirror = checkField(pref.mirror, "Mirror Y axis", { key: "mirror", tip: "Not recommended.\nUsed mostly by users who make the boards themselves." });
  const minimal = checkField(pref.minimal, "Minimal header", { key: "minimal", tip: "Not recommended.\nOnly use it for board houses which do not accept fully featured headers." });
  const merge = checkField(pref.merge, "PTH and NPTH in single file", { key: "merge", tip: "Not recommended.\nOnly use for board houses which ask for merged PTH and NPTH into a single file." });
  const altOval = checkField(pref.altOval, "Use alternate drill mode for oval holes", { key: "altOval" });
  const tenting = checkField(pref.tenting, "Generate tenting layers", { key: "tenting" });
  const genMap = checkField(pref.genMap, "Generate map:", { key: "genMap" });
  const mapFmt = selectField<number>(pref.mapFormat, MAP_FORMATS, { key: "mapFormat" });
  const origin = selectField<number>(p.useAuxOrigin ? 1 : 0, [[0, "Absolute"], [1, "Drill/place file origin"]], { key: "origin" });
  const units = selectField<number>(pref.metric ? 0 : 1, [[0, "Millimeters"], [1, "Inches"]], { key: "units", onChange: () => update() });
  const zeros = selectField<number>(pref.zeros, [[0, "Decimal format (recommended)"], [1, "Suppress leading zeros"], [2, "Suppress trailing zeros"], [3, "Keep zeros"]], { key: "zeros", onChange: () => update() });
  const precLabel = h("span", { class: "pd-lbl" }, "Precision:"), precision = h("span", { class: "pd-lbl", "data-k": "precision" }, "");
  const messages = h("div", { class: "pd-report gd-msgs", "data-k": "messages", style: "height:150px" });
  const say = (lines: string[]): void => { messages.replaceChildren(...lines.map((t) => h("div", { class: "ln" }, t))); };

  // onFileFormatSelection / updatePrecisionOptions
  function update(): void {
    const ex = rbExcellon.checked;
    for (const f of [units, zeros, mirror, minimal, merge, altOval]) { f.input.disabled = !ex; f.el.classList.toggle("disabled", !ex); }
    tenting.input.disabled = ex; tenting.el.classList.toggle("disabled", ex);
    if (ex) {
      precision.textContent = units.get() === 1 ? "2:4" : "3:3";
      const dec = zeros.get() === 0; precLabel.classList.toggle("disabled", dec); precision.classList.toggle("disabled", dec);
    } else { precLabel.classList.remove("disabled"); precision.classList.remove("disabled"); precision.textContent = p.gerberPrecision === 6 ? "4.6" : "4.5"; }
  }
  rbExcellon.addEventListener("change", update); rbGerber.addEventListener("change", update);

  const remember = (): void => savePrefs(KEY, { gerber: rbGerber.checked, mirror: mirror.get(), minimal: minimal.get(), merge: merge.get(), altOval: altOval.get(), tenting: tenting.get(), genMap: genMap.get(), mapFormat: mapFmt.get(), metric: units.get() === 0, zeros: zeros.get() });
  /** updateConfig: output directory and origin into the board's plot settings */
  const updateConfig = (): void => {
    remember();
    p.outputDirectory = outDir.get().replace(/\\/g, "/"); p.useAuxOrigin = origin.get() === 1;
    if (!ctx.viewOnly && !PLOT().params.samePlotParams(stored, p)) { const t = Object.assign({}, p); void saveToBoard(t, version).then((ok) => { if (ok) Object.assign(stored, t); }); }
  };
  async function generate(): Promise<void> {
    updateConfig();
    const fctx = await fabContext(); if (!fctx) return;
    try {
      const res = fab.drillJob(fctx, { format: rbGerber.checked ? "gerber" : "excellon", metric: units.get() === 0, zeros: ZEROS[zeros.get()], merge: merge.get(), minimalHeader: minimal.get(), mirrorY: mirror.get(),
        ovalMode: altOval.get() ? "g85" : "route", useAuxOrigin: origin.get() === 1, genDrill: true, genMap: genMap.get(), mapFormat: MAP_PLOT[mapFmt.get()] || 4, gerberPrecision: p.gerberPrecision,
        outputDir: p.outputDirectory, boardDir: docDir() });
      say(res.report.map((l) => l.text));
      await deliver(fab, res.files, `${fctx.projectName}-drill.zip`);
    } catch (e) { console.error(e); say(["Failed to create the drill files: " + (e instanceof Error ? e.message : String(e))]); }
  }
  async function reportFile(): Promise<void> {
    updateConfig();
    const fctx = await fabContext(); if (!fctx) return;
    const name = `${fctx.projectName}-drl.rpt`;
    try { saveBlob(fab.drillReport(fctx, { merge: merge.get(), gerber: rbGerber.checked }), name); say([`Report file '${name}' created.`]); }
    catch (e) { say([`Failed to create file '${name}'.`]); }
  }

  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  KDialogs!.open({ title: "Generate Drill Files", width: 640,
    buttons: [
      { label: "Generate Report File...", id: "report", fn: () => { void reportFile(); } },
      { label: "Generate", primary: true, isDefault: true, id: "generate", fn: () => { void generate(); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => remember(),
    build(body: HTMLElement) {
      ensureCss();
      body.append(
        h("div", { class: "pd-row", style: "margin-bottom:8px" }, lbl("Output folder:"), outDir.el),
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0 16px" },
          box("Format",
            h("label", { class: "pd-check" }, rbExcellon, "Excellon"),
            h("div", { style: "padding-left:22px" }, mirror.el, minimal.el, merge.el, altOval.el),
            h("label", { class: "pd-check" }, rbGerber, "Gerber X2"),
            h("div", { style: "padding-left:22px" }, tenting.el),
            h("div", { class: "pd-row", style: "margin-top:8px" }, genMap.el, mapFmt.el)),
          box("Options",
            h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:6px 8px;align-items:center" },
              lbl("Origin:"), origin.el, lbl("Units:"), units.el, lbl("Zeros:"), zeros.el, precLabel, precision))),
        box("Messages", messages));
      update();
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}
