// pcbdialogs/posfile — File > Fabrication Outputs > Component Placement (.pos, .gbr)…
// (pcbnew/dialogs/dialog_gen_footprint_position.cpp, DIALOG_GEN_FOOTPRINT_POSITION): Output directory,
// Format (Plain text / CSV / Gerber X3), Units, the footprint filters, Use drill/place file origin, Use negative
// X coordinates for footprints on bottom layer, Generate single file with both front and back positions; the
// messages panel; Generate Position File / Close.  The files are PLACE_FILE_EXPORTER's:
// <board>-top.pos / -bottom.pos (or -all.pos), the CSV variants <board>-top-pos.csv …
import type { KiCadFabApi } from "../../fab/index";
import type { Placement } from "../../fab/parts";
import { E } from "../state";
import { toolCtx } from "../tools";
import { fabContext, loadFab } from "../fab-outputs";
import { loadBoardHeader } from "./board-setup";
import { PLOT } from "./canvas";
import { deliver, docDir, loadPrefs, savePrefs } from "./plot-out";
import { checkField, ensureCss, h, messageBox, reportPanel, selectField, textField, type ReportLine } from "./ui";

interface PosPrefs { format: number; mm: boolean; smdOnly: boolean; excludeTH: boolean; excludeDnp: boolean; excludeBom: boolean; boardEdge: boolean; auxOrigin: boolean; negateX: boolean; single: boolean; outputDir: string | null }
const KEY = "kicad.posfile";
const DEFAULTS: PosPrefs = { format: 0, mm: true, smdOnly: false, excludeTH: false, excludeDnp: false, excludeBom: false, boardEdge: false, auxOrigin: true, negateX: false, single: true, outputDir: null };

export async function openPosFile(): Promise<void> {
  const ctx = toolCtx() as ToolCtx;
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("Component placement files are made from a board: open the PCB editor first"); return; }
  let fab: KiCadFabApi; let outDir = ""; let plotAux = false;
  try {
    const [f, header] = await Promise.all([loadFab(), loadBoardHeader()]); fab = f;
    const pp = PLOT().params.readPlotParams(header ? header.setup : null, header ? header.version : 0);
    outDir = pp.outputDirectory; plotAux = pp.useAuxOrigin;
  } catch (e) { console.warn(e); ctx.toast("The placement writers could not be loaded"); return; }
  show(fab, outDir, plotAux);
}

function show(fab: KiCadFabApi, boardOutDir: string, plotAux: boolean): void {
  const pref = loadPrefs(KEY, DEFAULTS);
  const outDir = textField(pref.outputDir !== null ? pref.outputDir : boardOutDir, { key: "outputDir" });
  outDir.input.title = "Target directory for plot files. Can be absolute or relative to the board file location.";
  const format = selectField<number>(pref.format, [[0, "Plain text"], [1, "CSV"], [2, "Gerber X3"]], { key: "format", onChange: () => update() });
  const units = selectField<number>(pref.mm ? 1 : 0, [[0, "Inches"], [1, "Millimeters"]], { key: "units" });
  const smdOnly = checkField(pref.smdOnly, "Include only SMD footprints", { key: "smdOnly" });
  const excludeTH = checkField(pref.excludeTH, "Exclude all footprints with through hole pads", { key: "excludeTH" });
  const excludeDnp = checkField(pref.excludeDnp, "Exclude all footprints with the Do Not Populate flag set", { key: "excludeDnp" });
  const excludeBom = checkField(pref.excludeBom, "Exclude all footprints with the Exclude from BOM flag set", { key: "excludeBom" });
  const boardEdge = checkField(pref.boardEdge, "Include board edge layer", { key: "boardEdge" });
  const auxOrigin = checkField(pref.auxOrigin, "Use drill/place file origin", { key: "auxOrigin" });
  const negateX = checkField(pref.negateX, "Use negative X coordinates for footprints on bottom layer", { key: "negateX" });
  const single = checkField(pref.single, "Generate single file with both front and back positions", { key: "single" });
  const report = reportPanel("140px");

  // the onUpdateUI* handlers
  function update(): void {
    const gerber = format.get() === 2;
    const en = (f: { input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; el: HTMLElement }, on: boolean, clear = true): void => { f.input.disabled = !on; f.el.classList.toggle("disabled", !on); if (!on && clear && f.input instanceof HTMLInputElement) f.input.checked = false; };
    // FormatSupportsFilter: Gerber X3 records the mount type, so the pad technology filters are off (and cleared)
    en(units, !gerber, false); en(single, !gerber, false); en(negateX, !gerber); en(boardEdge, gerber, false);
    en(smdOnly, !gerber); en(excludeTH, !gerber);
  }
  const remember = (): void => savePrefs(KEY, { format: format.get(), mm: units.get() === 1, smdOnly: smdOnly.get(), excludeTH: excludeTH.get(), excludeDnp: excludeDnp.get(), excludeBom: excludeBom.get(), boardEdge: boardEdge.get(), auxOrigin: auxOrigin.get(), negateX: negateX.get(), single: single.get(), outputDir: outDir.get() });

  async function generate(): Promise<void> {
    remember();
    const fctx = await fabContext(); if (!fctx) return;
    const lines: ReportLine[] = []; const say = (severity: string, text: string): void => { lines.push({ severity, text }); report.set(lines.slice()); };
    if (format.get() === 2) { await createGerberFiles(fctx, say); return; }
    const csv = format.get() === 1, inch = units.get() === 0;
    const rows = (side: "both" | "front" | "back"): Placement[] => fab.positions(fctx, { side, smdOnly: smdOnly.get(), excludeThroughHole: excludeTH.get(), excludeDnp: excludeDnp.get(), useAuxOrigin: auxOrigin.get(), negateBottomX: negateX.get() })
      .filter((r) => !(excludeBom.get() && r.fp.excludeFromBom));
    if (!rows("both").length) { messageBox("Message", "No footprint for automated placement."); return; }
    const board = fctx.projectName, dir = outDir.get().replace(/\\/g, "/");
    const date = new Date().toISOString().slice(0, 19).replace("T", " ");
    const software = `Pcbnew ${String((fctx.doc as unknown as { kicadVersion?: string }).kicadVersion || "10.99")}-web`;
    const files: { name: string; path: string; data: string }[] = [];
    const file = (side: "both" | "front" | "back"): number => {
      const r = rows(side); const deco = side === "both" ? "all" : side === "front" ? "top" : "bottom";
      const name = csv ? `${board}-${deco}-pos.csv` : `${board}-${deco}.pos`;
      const path = fab.outputPath(dir, docDir(), name);
      files.push({ name, path, data: csv ? fab.placementCsv(r, inch) : fab.placementAscii(r, side, date, software, inch) });
      return r.length;
    };
    if (single.get()) {
      const n = file("both"); say("action", `Placement file: '${files[0].path}'.`); say("info", `Component count: ${n}.`);
    } else {
      const a = file("front"); say("action", `Front (top side) placement file: '${files[0].path}'.`); say("info", `Component count: ${a}.`);
      const b = file("back"); say("action", `Back (bottom side) placement file: '${files[1].path}'.`); say("info", `Component count: ${b}.`);
      say("info", `Full component count: ${a + b}.`);
    }
    say("info", "Done.");
    await deliver(fab, files, `${board}-pos.zip`);
  }

  /** CreateGerberFiles: the front and the back file, always separate, every footprint of the side. */
  async function createGerberFiles(fctx: NonNullable<Awaited<ReturnType<typeof fabContext>>>, say: (severity: string, text: string) => void): Promise<void> {
    const dir = outDir.get().replace(/\\/g, "/"), board = fctx.projectName || "board";
    const files: { name: string; path: string; data: string }[] = [];
    let full = 0;
    for (const [side, label] of [["F.Cu", "Front (top side) placement file"], ["B.Cu", "Back (bottom side) placement file"]] as const) {
      const name = fab.pnpFileName(board, side), path = fab.outputPath(dir, docDir(), name);
      const r = fab.pnpGerber(fctx, { side, includeBoardEdge: boardEdge.get(), excludeDnp: excludeDnp.get(), excludeBom: excludeBom.get(), useAuxOrigin: plotAux });
      files.push({ name, path, data: r.text });
      say("action", `${label}: '${path}'.`); say("info", `Component count: ${r.count}.`);
      full += r.count;
    }
    say("info", `Full component count: ${full}.`);
    say("info", "Done.");
    await deliver(fab, files, `${board}-pnp.zip`);
  }

  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  KDialogs!.open({ title: "Generate Placement Files", width: 600,
    buttons: [
      { label: "Generate Position File", primary: true, isDefault: true, id: "generate", fn: () => { void generate(); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => remember(),
    build(body: HTMLElement) {
      ensureCss();
      body.append(
        h("div", { class: "pd-row", style: "margin-bottom:8px" }, lbl("Output directory:"), outDir.el),
        h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:6px 8px;align-items:center;margin-bottom:8px" }, lbl("Format:"), format.el, lbl("Units:"), units.el),
        smdOnly.el, excludeTH.el, excludeDnp.el, excludeBom.el, boardEdge.el, h("div", { style: "height:8px" }), auxOrigin.el, negateX.el, single.el,
        h("div", { style: "height:8px" }), report.el);
      update();
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}
