// editor/print — File > Print… in both editors: pcbnew's DIALOG_PRINT_PCBNEW (pcbnew/dialogs/dialog_print_pcbnew.cpp
// on DIALOG_PRINT_GENERIC) and eeschema's DIALOG_PRINT (eeschema/printing/dialog_print.cpp).
//
//   board      Include Layers (right-click: Select Fab Layers / Select all Copper Layers / …), Output mode,
//              Print drawing sheet, Print background color, Drill marks, Print mirrored, Print one page per
//              layer, Print board edges on all pages, Scale (1:1, Fit to page, Custom)
//   schematic  Print drawing sheet, Output mode, Print background color, Use a different color theme for
//              printing; every page of the hierarchy, in page order
//
// The pages are the plot pages (fab/pageplot.ts for a board, the painter recorded for a sheet) written as SVG and
// laid out in a hidden iframe, each with its own @page size, which the browser prints; Print Preview shows the same
// pages over the dialog.
import type { KiCadFabApi } from "../fab/index";
import type { PlotPage } from "../fab/plotter";
import { store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import { isSch } from "./view";
import { fabContext, loadFab } from "./fab-outputs";
import { loadBoardHeader } from "./pcbdialogs/board-setup";
import { PLOT } from "./pcbdialogs/canvas";
import { loadPrefs, savePrefs } from "./pcbdialogs/plot-out";
import { checkField, ensureCss as kitCss, h, messageBox, numField, selectField } from "./pcbdialogs/ui";
import { popupMenu } from "../dialogs/dom";
import { SCH_PLOT_DEFAULTS, sheetPage } from "../dialogs/plot-schematic";
import { sheetList } from "../dialogs/sch-hierarchy";

interface LayerRow { key: string; name: string; color: string }
interface PcbPrint { color: boolean; frame: boolean; background: boolean; drill: number; mirror: boolean; perLayer: boolean; edges: boolean; scale: number; custom: number; layers: string[] | null }
interface SchPrint { frame: boolean; color: boolean; background: boolean; otherTheme: boolean; theme: string }
const PCB_KEY = "kicad.print.board", SCH_KEY = "kicad.print.schematic";
const PCB_DEFAULTS: PcbPrint = { color: true, frame: true, background: false, drill: 1, mirror: false, perLayer: false, edges: true, scale: 0, custom: 1, layers: null };
const SCH_DEFAULTS: SchPrint = { frame: true, color: true, background: true, otherTheme: false, theme: "default" };
const SHEET_COLOR = "#C872AB";
const FP_EDITOR_PAGE: [number, number] = [297, 210];   // PAGE_INFO( A4 ), landscape, mm

export function printDialog(): void {
  if (!E.kdoc || !window.KDialogs) return;
  if (isSch()) schPrint(); else void pcbPrint();
}

// ---------------------------------------------------------------- the board
async function pcbPrint(): Promise<void> {
  let fab: KiCadFabApi; try { fab = await loadFab(); } catch (e) { toast("The plot writers could not be loaded"); return; }
  const P = loadPrefs(PCB_KEY, PCB_DEFAULTS);
  const doc = E.kdoc as KDoc;
  // PCB_CONTROL::Print in the Footprint Editor: ForcePrintBorder( false ) unchecks and hides "Print drawing sheet",
  // and the editor's board has an A4 page (FOOTPRINT_EDIT_FRAME's SetPageSettings( PAGE_INFO( A4 ) ))
  const fpEditor = !!(doc as unknown as { fpEditor?: boolean }).fpEditor;
  const layers = fab.plottableLayers(doc as never);
  const rows = ((store as unknown as { get(): { document: { layers?: LayerRow[] } } }).get().document.layers || []);
  const nameOf = (l: string): string => fab.layerDisplayName(doc as never, l);
  const on = new Set(P.layers ? P.layers.filter((l) => layers.includes(l)) : layers.filter((l) => !(E.hiddenLayers && E.hiddenLayers.has(l))));
  const checks = new Map<string, HTMLInputElement>();
  const list = h("div", { class: "pr-list", "data-k": "layers", title: "Right-click for layer selection commands." });
  for (const l of layers) { const cb = h("input", { type: "checkbox", checked: on.has(l) }); checks.set(l, cb); list.append(h("label", { class: "pd-check", style: "padding:0 6px" }, cb, nameOf(l))); }
  list.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const set = (f: (l: string) => boolean | null): void => { for (const [l, cb] of checks) { const v = f(l); if (v !== null) cb.checked = v; } };
    const cu = (l: string): boolean => /\.Cu$/.test(l);
    const fabL = new Set(["F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Fab", "B.Fab"]);
    popupMenu(ev.clientX, ev.clientY, [
      { label: "Select Fab Layers", run: () => set((l) => cu(l) || fabL.has(l)) }, { sep: true },
      { label: "Select all Copper Layers", run: () => set((l) => (cu(l) ? true : null)) }, { label: "Deselect all Copper Layers", run: () => set((l) => (cu(l) ? false : null)) }, { sep: true },
      { label: "Select all Layers", run: () => set(() => true) }, { label: "Deselect all Layers", run: () => set(() => false) }]);
  });
  const mode = selectField<number>(P.color ? 0 : 1, [[0, "Color"], [1, "Black and white"]], { key: "mode", onChange: () => sync() });
  const frame = checkField(P.frame, "Print drawing sheet", { key: "frame", tip: "Print Frame references." });
  const bg = checkField(P.background, "Print background color", { key: "background" });
  const drill = selectField<number>(P.drill, [[0, "No drill mark"], [1, "Small mark"], [2, "Real drill"]], { key: "drill" });
  const mirror = checkField(P.mirror, "Print mirrored", { key: "mirror" });
  const perLayer = checkField(P.perLayer, "Print one page per layer", { key: "perLayer", onChange: () => sync() });
  const edges = checkField(P.edges, "Print board edges on all pages", { key: "edges" });
  const radio = (v: number, label: string): HTMLInputElement => { const r = h("input", { type: "radio", name: "pr-scale", checked: P.scale === v, "data-k": "scale-" + v }); r.dataset.v = String(v); return r; };
  const r1 = radio(1, "1:1"), rFit = radio(0, "Fit to page"), rCustom = radio(2, "Custom:");
  const custom = numField(P.custom, { key: "custom", digits: 3 });
  const sync = (): void => { bg.input.disabled = mode.get() === 1; edges.input.disabled = !perLayer.get(); edges.el.classList.toggle("disabled", !perLayer.get()); };
  const read = (): PcbPrint => ({ color: mode.get() === 0, frame: frame.get(), background: bg.get(), drill: drill.get(), mirror: mirror.get(), perLayer: perLayer.get(), edges: edges.get(),
    scale: r1.checked ? 1 : rCustom.checked ? 2 : 0, custom: Math.max(0.01, Math.min(100, custom.get() || 1)), layers: layers.filter((l) => checks.get(l)!.checked) });

  const pages = async (o: PcbPrint): Promise<PlotPage[] | null> => {
    savePrefs(PCB_KEY, o);
    const sel = o.layers || [];
    if (!sel.length) { messageBox("Error", "No layer selected."); return null; }
    const fctx = await fabContext(); if (!fctx) return null;
    if (fpEditor) { fctx.doc = footprintBoard(doc) as unknown as typeof fctx.doc; o = Object.assign({}, o, { frame: false }); }
    const header = await loadBoardHeader().catch(() => null);
    const params = Object.assign(PLOT().params.readPlotParams(header ? header.setup : null, header ? header.version : 0), {
      format: 4, blackAndWhite: !o.color, plotFrameRef: o.frame, drillMarks: o.drill, mirror: o.mirror, scaleSelection: o.scale === 1 ? 1 : o.scale === 2 ? 1 : 0, negative: false, a4Output: false, useAuxOrigin: false });
    const colors: Record<string, string> = {}; for (const r of rows) colors[r.key] = r.color;
    const m = fab.model(fctx); const log = { warn() { /* print shows no report */ }, messages: [] as string[] };
    const groups: [string, string[]][] = o.perLayer ? sel.map((l) => [l, o.edges && l !== "Edge.Cuts" ? ["Edge.Cuts"] : []]) : [[sel[0], sel.slice(1)]];
    const bgc = o.background && o.color ? ((KiCadCanvas as unknown as { PCB_BG?: string }).PCB_BG || "#001023") : null;
    return groups.map(([layer, common], i) => fab.boardPage(m, { params, layer, common, layerName: o.perLayer ? nameOf(layer) : "", colors, sheetColor: SHEET_COLOR, background: bgc,
      pageNumber: i + 1, pageCount: groups.length, customScale: o.scale === 2 ? o.custom : undefined, printBoard: !o.frame }, log as never));
  };
  KDialogs!.open({ title: "Print", width: 640,
    buttons: [
      { label: "Print Preview", id: "preview", fn: () => { void pages(read()).then((p) => { if (p) preview(fab, p); }); } },
      { label: "Print", primary: true, isDefault: true, id: "print", fn: () => { void pages(read()).then((p) => { if (p) printPages(fab, p); }); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => savePrefs(PCB_KEY, read()),
    build(body: HTMLElement) {
      ensureCss();
      const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
      const r = (input: HTMLInputElement, label: string): HTMLElement => h("label", { class: "pd-check" }, input, label);
      body.append(h("div", { class: "pr-cols" },
        h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Include Layers"), list),
        h("div", null,
          h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Options"), h("div", { class: "pd-row" }, lbl("Output mode:"), mode.el), ...(fpEditor ? [] : [frame.el]), bg.el,
            h("div", { class: "pd-row" }, lbl("Drill marks:"), drill.el), mirror.el, perLayer.el, h("div", { style: "padding-left:22px" }, edges.el)),
          h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Scale"), r(r1, "1:1"), r(rFit, "Fit to page"), h("div", { class: "pd-row" }, r(rCustom, "Custom:"), custom.el)))));
      sync();
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}

/** The Footprint Editor's board as the plotter reads a board: the footprint (the file the editor holds, at the
 *  origin) in a board with the editor's layers, on an A4 page. */
function footprintBoard(doc: KDoc): object {
  const C = KiCadCanvas as unknown as { footprintDoc: { serializeFootprintDoc(d: unknown): string }; parseDoc(text: string, type: string): KDoc | null };
  const q = (t: string): string => '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const rows = [...((doc as unknown as { layers: Map<string, { id: number; type: string; userName?: string }> }).layers || new Map()).entries()]
    .map(([name, l]) => `(${l.id} ${q(name)} ${l.type}${l.userName ? " " + q(l.userName) : ""})`);
  const text = `(kicad_pcb (version ${(doc as unknown as { version?: number }).version || 20241229}) (generator "pcbnew") (layers ${rows.join(" ")})\n${C.footprintDoc.serializeFootprintDoc(doc)})`;
  const board = C.parseDoc(text, "kicad_pcb"); if (!board) throw new Error("the footprint does not parse as a board");
  return Object.assign(board, { page: FP_EDITOR_PAGE });
}

// ---------------------------------------------------------------- the schematic
function schPrint(): void {
  const P = loadPrefs(SCH_KEY, SCH_DEFAULTS);
  const frame = checkField(P.frame, "Print drawing sheet", { key: "frame", tip: "Print (or not) the Frame references." });
  const mode = selectField<number>(P.color ? 0 : 1, [[0, "Color"], [1, "Black and White"]], { key: "mode", onChange: () => sync() });
  const bg = checkField(P.background, "Print background color", { key: "background" });
  const other = checkField(P.otherTheme, "Use a different color theme for printing:", { key: "otherTheme", onChange: () => sync() });
  const themes = Object.entries(KiCadCanvas.SCH_THEMES as Record<string, { name: string }>).map(([id, t]) => [id, t.name] as [string, string]);
  const theme = selectField<string>(P.theme, themes, { key: "theme" });
  const sync = (): void => { const c = mode.get() === 0; bg.input.disabled = !c; other.input.disabled = !c; theme.input.disabled = !c || !other.get(); };
  const read = (): SchPrint => ({ frame: frame.get(), color: mode.get() === 0, background: bg.get(), otherTheme: other.get(), theme: theme.get() });
  const pages = async (o: SchPrint): Promise<{ fab: KiCadFabApi; pages: PlotPage[] } | null> => {
    savePrefs(SCH_KEY, o);
    let fab: KiCadFabApi; try { fab = await loadFab(); } catch (e) { toast("The plot writers could not be loaded"); return null; }
    const sheets = await sheetList().catch(() => []);
    const idx = new Map<string, number>(); sheets.forEach((s, i) => idx.set(s.page, i + 1));
    const screenTheme = String((KiCadCanvas as unknown as { schTheme?: () => string }).schTheme ? (KiCadCanvas as unknown as { schTheme: () => string }).schTheme() : "default");
    const opts = Object.assign({}, SCH_PLOT_DEFAULTS, { frame: o.frame, color: o.color, background: o.background, theme: o.otherTheme ? o.theme : screenTheme, minWidth: 0, popups: false, links: false, pageSize: 0 });
    const list = sheets.length ? sheets : [{ docId: "", path: "sheet.kicad_sch", name: "", sheetPath: "/", page: "1", doc: E.kdoc as KDoc, uuidPath: [], sheetItemId: null, parentDocId: null }];
    return { fab, pages: list.map((s) => sheetPage(s, list.length, opts, idx)) };
  };
  KDialogs!.open({ title: "Print", width: 440,
    buttons: [
      { label: "Print Preview", id: "preview", fn: () => { void pages(read()).then((r) => { if (r) preview(r.fab, r.pages); }); } },
      { label: "Print", primary: true, isDefault: true, id: "print", fn: () => { void pages(read()).then((r) => { if (r) printPages(r.fab, r.pages); }); } },
      { label: "Close", close: true, id: "close" },
    ],
    cancel: () => savePrefs(SCH_KEY, read()),
    build(body: HTMLElement) {
      body.append(frame.el, h("div", { class: "pd-row" }, h("span", { class: "pd-lbl" }, "Output mode:"), mode.el), bg.el, other.el, h("div", { style: "padding-left:22px" }, theme.el));
      sync();
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}

// ---------------------------------------------------------------- the printout
/** The pages as one HTML document: an SVG per page, each on a named @page of its own size. */
export function printHtml(fab: KiCadFabApi, pages: PlotPage[], title: string): string {
  const css: string[] = [], body: string[] = [];
  pages.forEach((p, i) => {
    const w = p.w.toFixed(3), hh = p.h.toFixed(3);
    css.push(`@page p${i} { size: ${w}mm ${hh}mm; margin: 0 }`, `.pg${i} { page: p${i}; width: ${w}mm; height: ${hh}mm }`);
    const svg = fab.writeSvg(p, { precision: 4, creator: "KiCad", fileName: title, date: new Date() }).replace(/^<\?xml[^>]*>\s*/, "");
    body.push(`<div class="pg pg${i}" style="aspect-ratio:${w}/${hh}">${svg}</div>`);
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>html,body{margin:0;padding:0;background:#fff}.pg{break-after:page;overflow:hidden}.pg:last-child{break-after:auto}.pg svg{display:block;width:100%;height:100%}${css.join("\n")}</style></head><body>${body.join("")}</body></html>`;
}

function printPages(fab: KiCadFabApi, pages: PlotPage[]): void {
  const html = printHtml(fab, pages, "Print");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true"); frame.dataset.k = "print-frame";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(frame);
  const win = frame.contentWindow; if (!win) { frame.remove(); return; }
  let done = false;
  const cleanup = (): void => { if (done) return; done = true; setTimeout(() => frame.remove(), 500); };
  frame.addEventListener("load", () => {
    win.addEventListener("afterprint", cleanup);
    setTimeout(() => { try { win.focus(); win.print(); } catch (e) { toast("Printing failed"); } setTimeout(cleanup, 60000); }, 100);
  });
  win.document.open(); win.document.write(html); win.document.close();
}

/** Print Preview: the pages over the dialog, in a scrolling frame, closed with its own button. */
function preview(fab: KiCadFabApi, pages: PlotPage[]): void {
  ensureCss();
  const ov = h("div", { class: "kd-overlay", style: "z-index:10050", "data-k": "print-preview" });
  const frame = h("iframe", { class: "pr-preview", title: "Print Preview" }) as HTMLIFrameElement;
  const close = h("button", { class: "btn primary", type: "button", "data-k": "preview-close" }, "Close");
  const dlg = h("div", { class: "kd-dialog", style: "width:min(980px,96vw);height:min(760px,92vh);display:flex;flex-direction:column", tabIndex: -1 },
    h("div", { class: "kd-title" }, h("span", null, "Print Preview")), h("div", { class: "kd-body", style: "flex:1 1 auto;min-height:0;display:flex" }, frame), h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), close));
  ov.append(dlg); document.body.append(ov);
  const shut = (): void => ov.remove();
  close.addEventListener("click", shut);
  ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { ev.preventDefault(); shut(); } });
  const cs = getComputedStyle(document.documentElement), tok = (n: string, d: string): string => (cs.getPropertyValue(n) || "").trim() || d;
  frame.srcdoc = printHtml(fab, pages, "Print Preview").replace("<style>", `<style>html,body{background:${tok("--panel-2", tok("--panel", "gray"))}!important}body{padding:12px}.pg{width:100%!important;height:auto!important;box-sizing:border-box;background:#fff;margin:0 auto 12px;border:1px solid ${tok("--line", "gray")}}`);
  close.focus();
}

const CSS = `
.pr-cols { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(250px, 1.4fr); gap: 0 16px; }
.pr-list { height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); padding: 2px 0; }
.pr-preview { flex: 1 1 auto; width: 100%; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); }
@media (max-width: 700px) { .pr-cols { grid-template-columns: 1fr; } .pr-list { height: 180px; } }
`;
let cssDone = false;
function ensureCss(): void { kitCss(); if (cssDone) return; cssDone = true; const st = document.createElement("style"); st.id = "pr-css"; st.textContent = CSS; document.head.appendChild(st); }
