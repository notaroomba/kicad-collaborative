// dialogs/plot-schematic — the schematic editor's File > Plot… (eeschema/dialogs/dialog_plot_schematic.cpp,
// DIALOG_PLOT_SCHEMATIC): Output directory; Output Format (Postscript, PDF, SVG, DXF, PNG); Options (Page size,
// Plot drawing sheet, Output mode, Color theme, Plot background color, Minimum line width); PDF Options
// (property popups, clickable links for hierarchical elements, metadata from AUTHOR & SUBJECT); DXF Options
// (Export units); PNG Options; Other Options (Open file after plot); the messages; Plot All Pages / Plot Current
// Page / Close.
//
// Each page is the screen painter recorded as plot items (canvas/plot-rec.ts) and written by the fab bundle's
// writers.  "Plot All Pages" walks the hierarchy (sch-hierarchy.ts) in page order: one PDF with a bookmark per
// symbol, a property popup per symbol and a link per sheet symbol to its page; every other format writes a file
// per page named as SCHEMATIC::GetUniqueFilenameForCurrentSheet ("<root>-<sheet>-<sheet>").  The output directory
// is the project's schematic.plot_directory, written back when it changes; the other choices are the user's.
import type { KiCadFabApi } from "../fab/index";
import type { PlotItem } from "../canvas/plot-rec";
import type { PlotLink, PlotPage, PlotBookmark } from "../fab/plotter";
import { editProject, type ProjectEdit } from "../canvas/project-file";
import { E, appState, toast, toolCtx } from "./editor";
import { loadFab } from "../editor/fab-outputs";
import { adoptProjectFile, canWriteProject, loadProjectFile, saveProjectFile } from "../editor/projectfile";
import { PLOT } from "../editor/pcbdialogs/canvas";
import { deliver, loadPrefs, savePrefs } from "../editor/pcbdialogs/plot-out";
import { box, checkField, ensureCss, h, numField, reportPanel, selectField, textField, type ReportLine } from "../editor/pcbdialogs/ui";
import { obj, projectJson } from "./project";
import { sheetList, withSheetContext, type SheetInstance } from "./sch-hierarchy";

export interface SchPlotPrefs { format: number; pageSize: number; frame: boolean; color: boolean; theme: string; background: boolean; minWidth: number; popups: boolean; links: boolean; metadata: boolean; dxfInch: boolean; dpi: number; antialias: boolean; openAfter: boolean }
const KEY = "kicad.plot.schematic";
export const SCH_PLOT_DEFAULTS: SchPlotPrefs = { format: 1, pageSize: 0, frame: true, color: true, theme: "default", background: false, minWidth: 0.1524, popups: true, links: true, metadata: true, dxfInch: false, dpi: 300, antialias: true, openAfter: false };
/** m_plotFormatOpt: Postscript, PDF, SVG, DXF, PNG */
const FORMATS = ["Postscript", "PDF", "SVG", "DXF", "PNG"];
const EXT = ["ps", "pdf", "svg", "dxf", "png"];

let lastReport: ReportLine[] = [];

export async function openPlotSchematic(): Promise<void> {
  const ctx = toolCtx();
  if (!E.kdoc || E.kdoc.type !== "sch") { ctx.toast("Plot needs a schematic"); return; }
  let fab: KiCadFabApi;
  try { fab = await loadFab(); } catch (e) { console.warn(e); toast("The plot writers could not be loaded"); return; }
  show(fab);
}

function show(fab: KiCadFabApi): void {
  const pref = loadPrefs(KEY, SCH_PLOT_DEFAULTS);
  const pro = projectJson();
  const storedDir = String(obj(pro.schematic).plot_directory || "");
  const outDir = textField(storedDir, { key: "outputDir" });
  outDir.input.title = "Target directory for plot files. Can be absolute or relative to the schematic main file location.";
  const fmtRadios = FORMATS.map((label, i) => { const input = h("input", { type: "radio", name: "ps-fmt", checked: i === pref.format, "data-k": "fmt-" + label.toLowerCase() }); input.addEventListener("change", () => update()); return { input, el: h("label", { class: "pd-check" }, input, label) }; });
  const fmt = (): number => Math.max(0, fmtRadios.findIndex((r) => r.input.checked));
  const pageSize = selectField<number>(pref.pageSize, [[0, "Schematic size"], [1, "A4"], [2, "A"]], { key: "pageSize" });
  const frame = checkField(pref.frame, "Plot drawing sheet", { key: "frame", tip: "Plot the drawing sheet border and title block" });
  const mode = selectField<number>(pref.color ? 0 : 1, [[0, "Color"], [1, "Black and White"]], { key: "mode", onChange: () => update() });
  const themes = Object.entries(KiCadCanvas.SCH_THEMES as Record<string, { name: string }>).map(([id, t]) => [id, t.name] as [string, string]);
  const theme = selectField<string>(pref.theme, themes, { key: "theme" }); theme.input.title = "Select the color theme to use for plotting";
  const themeLabel = h("span", { class: "pd-lbl" }, "Color theme:");
  const background = checkField(pref.background, "Plot background color", { key: "background", tip: "Plot the background color if the output format supports it" });
  const minWidth = numField(pref.minWidth, { key: "minWidth", digits: 4 }); minWidth.input.title = "Selection of the default pen thickness used to draw items, when their thickness is set to 0.";
  const minLabel = h("span", { class: "pd-lbl" }, "Minimum line width:");
  const popups = checkField(pref.popups, "Generate property popups", { key: "popups" });
  const links = checkField(pref.links, "Generate clickable links for hierarchical elements", { key: "links" });
  const metadata = checkField(pref.metadata, "Generate metadata from AUTHOR & SUBJECT variables", { key: "metadata", tip: "Generate PDF document properties from AUTHOR and SUBJECT text variables" });
  const dxfUnits = selectField<number>(pref.dxfInch ? 0 : 1, [[0, "Inches"], [1, "Millimeters"]], { key: "dxfUnits" });
  const dxfLabel = h("span", { class: "pd-lbl" }, "Export units:");
  const dpi = numField(pref.dpi, { key: "dpi", digits: 0 });
  const aa = checkField(pref.antialias, "Anti-alias", { key: "antialias" });
  const openAfter = checkField(pref.openAfter, "Open file after plot", { key: "openAfter", tip: "Open output file with associated application after successful plot" });
  const report = reportPanel("130px"); report.set(lastReport);
  const pngBox = box("PNG Options", h("div", { class: "pd-row" }, h("span", { class: "pd-lbl" }, "DPI:"), dpi.el, aa.el));

  const en = (f: { input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; el: HTMLElement }, on: boolean): void => { f.input.disabled = !on; f.el.classList.toggle("disabled", !on); };
  // onPlotFormatSelection + onColorMode
  function update(): void {
    const f = fmt(), pdf = f === 1;
    en(openAfter, pdf); en(popups, pdf); en(links, pdf); en(metadata, pdf);
    en(dxfUnits, f === 3); dxfLabel.classList.toggle("disabled", f !== 3);
    const lw = f === 0 || f === 1 || f === 2 || f === 4; en(minWidth, lw); minLabel.classList.toggle("disabled", !lw);
    pngBox.style.display = f === 4 ? "" : "none";
    const color = mode.get() === 0;
    en(theme, color); themeLabel.classList.toggle("disabled", !color);
    en(background, (f === 0 || f === 1 || f === 2 || f === 4) && color);
  }
  const prefsNow = (): SchPlotPrefs => ({ format: fmt(), pageSize: pageSize.get(), frame: frame.get(), color: mode.get() === 0, theme: theme.get(), background: background.get(), minWidth: Math.max(0, minWidth.get()),
    popups: popups.get(), links: links.get(), metadata: metadata.get(), dxfInch: dxfUnits.get() === 0, dpi: Math.max(72, Math.min(2400, Math.round(dpi.get()))), antialias: aa.get(), openAfter: openAfter.get() });

  async function plot(all: boolean): Promise<void> {
    const o = prefsNow(); savePrefs(KEY, o);
    const lines: ReportLine[] = []; const say = (severity: string, text: string): void => { lines.push({ severity, text }); report.set(lines.slice()); lastReport = lines.slice(); };
    report.set([]);
    const dir = outDir.get().replace(/\\/g, "/");
    if (dir !== storedDir) void saveDirectory(dir);
    let sheets: SheetInstance[];
    try { sheets = await sheetList(); } catch (e) { sheets = []; }
    const S = appState as unknown as { docId: string | null };
    const current = sheets.find((s) => s.docId === S.docId) || null;
    const list = all ? sheets : current ? [current] : [];
    if (!list.length) {
      // the open sheet is not reachable from the root (opened on its own): it is the page
      if (!all || !sheets.length) list.push({ docId: S.docId || "", path: (E.kdoc as KDoc & { filePath?: string }).filePath || "sheet.kicad_sch", name: "", sheetPath: "/", page: "1", doc: E.kdoc as KDoc, uuidPath: [], sheetItemId: null, parentDocId: null });
    }
    if (!list.length) { say("error", "No sheets to plot."); return; }
    const rootStem = (sheets[0] ? sheets[0].path : list[0].path).split("/").pop()!.replace(/\.kicad_sch$/, "");
    const projectDir = (sheets[0] ? sheets[0].path : list[0].path).split("/").slice(0, -1).join("/");
    const fileStem = (s: SheetInstance): string => [rootStem, ...s.sheetPath.split("/").filter(Boolean)].join("-").replace(/[/\\]/g, "_");
    const pageIndex = new Map<string, number>(); list.forEach((s, i) => pageIndex.set(s.page, i + 1));
    const pages: PlotPage[] = list.map((s) => sheetPage(s, sheets.length || 1, o, pageIndex));
    const f = o.format;
    const files: { name: string; path: string; data: string | Uint8Array }[] = [];
    const add = (name: string, data: string | Uint8Array): void => { const path = fab.outputPath(dir, projectDir, name); files.push({ name, path, data }); say("action", `Plotted to '${path}'.`); };
    const vars = obj(pro.text_variables) as Record<string, unknown>;
    const tb = (E.kdoc as KDoc & { titleBlock?: { title?: string } }).titleBlock;
    const meta = o.metadata ? { author: String(vars.AUTHOR || ""), subject: String(vars.SUBJECT || "") } : {};
    try {
      if (f === 1) {
        const name = all ? `${rootStem}.pdf` : `${fileStem(list[0])}.pdf`;
        add(name, fab.writePdf(Object.assign({ pages, creator: "Eeschema", title: (tb && tb.title) || "", date: new Date(), fileName: name }, meta)));
      } else {
        for (let i = 0; i < list.length; i++) {
          const name = `${fileStem(list[i])}.${EXT[f]}`, page = pages[i];
          if (f === 2) add(name, fab.writeSvg(page, { precision: 4, creator: "Eeschema", fileName: name, date: new Date() }));
          else if (f === 0) add(name, fab.writePs({ pages: [page], creator: "Eeschema", date: new Date() }, { scaleX: 1, scaleY: 1, fileName: name, date: new Date() }));
          else if (f === 3) add(name, fab.writeDxf([{ name: "0", color: "#000000", page }], { imperial: o.dxfInch, polygonMode: false }));
          else add(name, await fab.writePng(page, o.dpi, o.antialias));
        }
      }
      say("info", "Done.");
      const got = await deliver(fab, files, `${rootStem}-plot.zip`);
      if (got && o.openAfter && f === 1 && files.length === 1) {
        const url = URL.createObjectURL(new Blob([files[0].data as BlobPart], { type: "application/pdf" })); window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) { console.error(e); say("error", "Plot failed: " + (e instanceof Error ? e.message : String(e))); }
  }

  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  KDialogs!.open({ title: "Plot Schematic Options", width: 720,
    buttons: [
      { label: "Plot All Pages", primary: true, isDefault: true, id: "plotAll", fn: () => { void plot(true); } },
      { label: "Plot Current Page", id: "plotCurrent", fn: () => { void plot(false); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => savePrefs(KEY, prefsNow()),
    build(body: HTMLElement) {
      ensureCss();
      body.append(
        h("div", { class: "pd-row", style: "margin-bottom:8px" }, lbl("Output directory:"), outDir.el),
        h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:0 16px" },
          box("Output Format", ...fmtRadios.map((r) => r.el)),
          h("div", null,
            box("Options", h("div", { style: "display:grid;grid-template-columns:max-content 1fr max-content;gap:6px 8px;align-items:center" },
              lbl("Page size:"), pageSize.el, h("span"), h("div", { style: "grid-column:1/-1" }, frame.el), lbl("Output mode:"), mode.el, h("span"),
              themeLabel, theme.el, h("span"), h("div", { style: "grid-column:1/-1" }, background.el), minLabel, minWidth.el, h("span", { class: "unit" }, "mm"))),
            box("PDF Options", popups.el, links.el, metadata.el),
            box("DXF Options", h("div", { class: "pd-row" }, dxfLabel, dxfUnits.el)),
            pngBox,
            box("Other Options", openAfter.el))),
        report.el);
      update();
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}

/** One page: the sheet recorded through the painter, scaled to the paper, with its links, popups and bookmarks. */
export function sheetPage(s: SheetInstance, count: number, o: SchPlotPrefs, pageIndex: Map<string, number>): PlotPage {
  const doc = withSheetContext(s, count);
  const W = doc.page[0], H = doc.page[1];
  let paper: [number, number] = [W, H];
  if (o.pageSize === 1) paper = [297, 210]; else if (o.pageSize === 2) paper = [279.4, 215.9];
  if (o.pageSize && H > W) paper = [paper[1], paper[0]];
  const k = Math.min(paper[0] / W, paper[1] / H);
  const x0 = -(paper[0] / k - W) / 2, y0 = -(paper[1] / k - H) / 2;
  const items: PlotItem[] = PLOT().plotItems(doc, { frame: o.frame, mono: !o.color, theme: o.color ? o.theme : null, x0, y0, width: paper[0] / k, height: paper[1] / k, scale: k });
  if (o.minWidth > 0) for (const it of items) if ((it.k === "line" || (it.k === "circle" && !it.fill)) && it.w < o.minWidth) it.w = o.minWidth;
  const P = (x: number, y: number): [number, number] => [(x - x0) * k, (y - y0) * k];
  const links: PlotLink[] = [], bookmarks: PlotBookmark[] = [];
  const box4 = (b: number[]): [number, number, number, number] => { const a = P(b[0], b[1]), c = P(b[2], b[3]); return [a[0], a[1], c[0], c[1]]; };
  for (const it of doc.items.values()) {
    const b = it.bbox as number[] | null; if (!b) continue;
    const props = KiCadCanvas.kids(it.node as never, "property").map((p) => [KiCadCanvas.str(p[1]), KiCadCanvas.str(p[2])] as [string, string]);
    if (it.kind === "symbol") {
      if (o.popups) { const menu = props.filter(([, v]) => v).map(([n, v]) => [`${n} = ${v}`, ""] as [string, string]); if (menu.length) links.push({ box: box4(b), menu }); }
      const ref = (props.find(([n]) => n === "Reference") || ["", ""])[1];
      if (ref && !ref.startsWith("#")) bookmarks.push({ group: "Symbols", title: ref });
    } else if (it.kind === "sheet") {
      const m = KiCadCanvas.movableItems(doc).find((x) => x.id === it.id);
      const target = m && m.page ? pageIndex.get(m.page) : undefined;
      if (o.links && target) links.push({ box: box4(b), url: `#${target}` });
      else if (o.popups) links.push({ box: box4(b), menu: [...(target ? [["Go to page " + m!.page, `#${target}`] as [string, string]] : []), ...props.map(([n, v]) => [`${n} = ${v}`, ""] as [string, string])] });
    }
  }
  const bg = o.background && o.color ? (KiCadCanvas.schThemeColors as (id: string) => { bg: string })(o.theme).bg : null;
  return { w: paper[0], h: paper[1], name: s.sheetPath, items, background: bg || undefined, links, bookmarks };
}

/** schematic.plot_directory into the .kicad_pro (PROJECT_FILE's m_PlotDirectoryName). */
async function saveDirectory(dir: string): Promise<void> {
  if (!canWriteProject()) return;
  try {
    const text = await loadProjectFile(); if (!text) return;
    const edits: ProjectEdit[] = [{ path: ["schematic", "plot_directory"], value: dir }];
    const res = editProject(text, edits);
    if (res.changed.length && await saveProjectFile(res.text, res.changed)) adoptProjectFile(res.text);
  } catch (e) { console.warn("plot directory not saved", e); }
}

