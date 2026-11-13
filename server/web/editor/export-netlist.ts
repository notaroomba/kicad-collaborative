// editor/export-netlist — File > Export > Netlist… (DIALOG_EXPORT_NETLIST): a notebook of the netlist formats,
// "Export Netlist" / "Close".  KiCad (this sheet, menu-actions netlistText), OrcadPCB2, Allegro, CadStar, PADS
// (sim/netlist-formats.ts from the project's hierarchy), SPICE and SPICE Model (sim/spice-netlist.ts).
// The file is offered as a download named after the project (<stem>.net / .cir).  The page last used and the SPICE
// options are remembered per browser, as KiCad keeps them in its settings.
import { E } from "./state";
import { state } from "./appstore";
import { box, checkField, h, note, notebook, openDialog, reportPanel, textField, type Field, type ReportLine } from "./pcbdialogs/ui";
import { projectNetlist } from "./pcbdialogs/update-pcb";
import { projectDocs } from "./projectfile";
import { download, fileStem, netlistText } from "./menu-actions";
import * as SP from "../sim/spice-netlist";
import * as NF from "../sim/netlist-formats";
import * as S from "../dialogs/sim-model-logic";
import { projectModelFiles } from "../dialogs/sim-files";
import { symbolViewForVariant } from "../canvas/variant-model";
import { currentVariant } from "./variant";

const PAGES = ["KiCad", "OrcadPCB2", "Allegro", "CadStar", "PADS", "SPICE", "SPICE Model"] as const;
const HEAD: Record<string, string> = { KiCad: "Export netlist in KiCad format", OrcadPCB2: "Export netlist in OrcadPCB2 format", Allegro: "Export netlist in Allegro format",
  CadStar: "Export netlist in CadStar format", PADS: "Export netlist in PADS format", SPICE: "Export netlist in SPICE format", "SPICE Model": "Export netlist as a SPICE .subckt model" };
const EXT: Record<string, string> = { KiCad: "net", OrcadPCB2: "net", Allegro: "txt", CadStar: "frp", PADS: "asc", SPICE: "cir", "SPICE Model": "cir" };

interface Saved { page?: number; curSheetAsRoot?: boolean; saveAllVoltages?: boolean; saveAllCurrents?: boolean; saveAllDissipations?: boolean; saveAllEvents?: boolean; modelCurSheetAsRoot?: boolean }
const KEY = "kc.exportNetlist";
function loadSaved(): Saved { try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Saved; } catch (e) { return {}; } }
function store(s: Saved): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* not remembered */ } }

interface SchInternals { _?: { symbolPins(doc: KDoc, item: KItem): { number: string }[]; isPowerSymbol(doc: KDoc, libId: string): boolean } }

/** The SPICE netlist of the project's hierarchy (or of the current sheet's subtree) with its libraries read. */
export async function projectSpiceNetlist(options: number, report: (m: string, sev: "error" | "warning") => void): Promise<string | null> {
  const res = await projectNetlist();
  if ("error" in res) { report(res.error, "error"); return null; }
  const sch = CollabTools.sch as (SchToolModule & SchInternals) | undefined, hp = sch && sch._;
  if (!hp) { report("The schematic tools are not loaded.", "error"); return null; }
  const insts = res.netlist.instances || [];
  let sheets = insts.map((i) => ({ index: i.index, uuidPath: i.uuidPath, doc: (res.files.get(i.file) || { doc: null }).doc as KDoc })).filter((s) => s.doc);
  if (options & SP.OPTION_CUR_SHEET_AS_ROOT) {
    const cur = projectDocs().find((d) => d.docId === state.docId) || null;
    const here = insts.find((i) => cur && i.file === cur.path);
    if (here) sheets = sheets.filter((s) => here.uuidPath.every((u, k) => s.uuidPath[k] === u));
  }
  const variant = currentVariant();
  if (variant) SP.setVariantView((n, v, path) => symbolViewForVariant(n, v, path));
  const { symbols, texts } = SP.readHierarchy({ sheets, netMap: res.netlist.netMap || new Map(), symbolPins: hp.symbolPins,
    isPower: (d, it) => hp.isPowerSymbol(d, String(((KiCadCanvas.kid(it.node, "lib_id") as SNode | null) || [])[1])), variant: variant || undefined });
  // every Sim.Library the symbols name, read before the (synchronous) exporter runs
  const files = projectModelFiles(projectDocs()), libs = new Map<string, S.SpiceLibrary | null>();
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/^\$\{KIPRJMOD\}\//, "").replace(/^\.\//, "");
  for (const sym of symbols) {
    const p = (sym.fields.find((f) => f.name === S.F.LIBRARY) || { value: "" }).value; if (!p || libs.has(p)) continue;
    const f = files.find((x) => norm(x.path) === norm(p)) || files.find((x) => norm(p).endsWith("/" + norm(x.path))) || null;
    let text: string | null = null; try { text = f ? await f.load() : null; } catch (e) { text = null; }
    if (text !== null && !S.isIbisPath(p)) {
      const errs: string[] = [];
      text = await S.expandSpiceIncludes(text, p, async (cands) => { for (const c of cands) { const g = files.find((x) => norm(x.path) === norm(c)); if (g) { const t = await g.load(); if (t !== null) return t; } } return null; }, errs);
    }
    libs.set(p, text === null ? null : S.isIbisPath(p) ? S.parseIbisLibrary(text, p) : S.parseSpiceLibrary(text));
  }
  return SP.spiceNetlist({ symbols, texts, options, library: (p) => libs.get(p) || null, report });
}

export function openExportNetlist(): void {
  const saved = loadSaved();
  const { stem } = fileStem();
  const opts: Record<string, Field<boolean>> = {};
  let report: { el: HTMLElement; set(lines: ReportLine[]): void } | null = null;
  let nb: ReturnType<typeof notebook> | null = null;
  const pageHead = (name: string): HTMLElement => h("div", { style: "margin-bottom:10px" }, HEAD[name]);
  const pages = PAGES.map((name) => ({ label: name, build(el: HTMLElement) {
    el.append(pageHead(name));
    if (name === "SPICE") {
      opts.curSheetAsRoot = checkField(!!saved.curSheetAsRoot, "Use current sheet as root", { key: "cur-sheet-as-root", tip: "Export netlist only for the current sheet" });
      opts.saveAllVoltages = checkField(saved.saveAllVoltages !== false, "Save all voltages", { key: "save-all-voltages", tip: "Write a directive to save all voltages (.save all)" });
      opts.saveAllCurrents = checkField(saved.saveAllCurrents !== false, "Save all currents", { key: "save-all-currents", tip: "Write a directive to save all currents (.probe alli)" });
      opts.saveAllDissipations = checkField(saved.saveAllDissipations !== false, "Save all power dissipations", { key: "save-all-dissipations", tip: "Write directives to save power dissipation of all items (.probe p(<item>))" });
      opts.saveAllEvents = checkField(saved.saveAllEvents !== false, "Save all digital event data", { key: "save-all-events", tip: "If not set, write a directive to prevent the saving of digital event data (esave none)" });
      for (const k of ["curSheetAsRoot", "saveAllVoltages", "saveAllCurrents", "saveAllDissipations", "saveAllEvents"]) el.append(h("div", { style: "margin-bottom:5px" }, opts[k].el));
      const run = checkField(false, "Run external simulator command:", { ro: true, key: "run-simulator", tip: "Enter the command line to run SPICE\nUsually '<path to SPICE binary> \"%I\"'\n%I will be replaced by the netlist filepath" });
      el.append(h("div", { style: "margin-top:10px" }, run.el), textField("", { ro: true, key: "simulator-command" }).el, note("A browser cannot run a simulator on this computer."));
    } else if (name === "SPICE Model") {
      opts.modelCurSheetAsRoot = checkField(!!saved.modelCurSheetAsRoot, "Use current sheet as root", { key: "model-cur-sheet-as-root", tip: "Export netlist only for the current sheet" });
      el.append(opts.modelCurSheetAsRoot.el);
    }
  } }));
  openDialog({ title: "Export Netlist", width: 560, okLabel: "Export Netlist", cancelLabel: "Close",
    build(body) {
      nb = notebook(pages, { start: Math.min(Math.max(saved.page || 0, 0), PAGES.length - 1) });
      report = reportPanel("120px");
      body.append(nb.el, box("Messages", report.el));
    },
    ok() {
      const page = nb ? nb.current() : 0, name = PAGES[page];
      const v = (k: string, d: boolean): boolean => (opts[k] ? opts[k].get() : d);
      store({ page, curSheetAsRoot: v("curSheetAsRoot", !!saved.curSheetAsRoot), saveAllVoltages: v("saveAllVoltages", saved.saveAllVoltages !== false), saveAllCurrents: v("saveAllCurrents", saved.saveAllCurrents !== false),
        saveAllDissipations: v("saveAllDissipations", saved.saveAllDissipations !== false), saveAllEvents: v("saveAllEvents", saved.saveAllEvents !== false), modelCurSheetAsRoot: v("modelCurSheetAsRoot", !!saved.modelCurSheetAsRoot) });
      const lines: ReportLine[] = [];
      const say = (text: string, severity: string): void => { lines.push({ severity, text }); if (report) report.set(lines.slice()); };
      const fname = `${stem}.${EXT[name]}`;
      void (async () => {
        let text: string | null = null;
        try {
          if (name === "KiCad") text = E.kdoc ? netlistText(E.kdoc as never, fileStem().name) : null;
          else if (name === "SPICE" || name === "SPICE Model") {
            let o = 0;
            if (name === "SPICE") {
              o |= SP.OPTION_SIM_COMMAND;
              if (v("saveAllVoltages", true)) o |= SP.OPTION_SAVE_ALL_VOLTAGES;
              if (v("saveAllCurrents", true)) o |= SP.OPTION_SAVE_ALL_CURRENTS;
              if (v("saveAllDissipations", true)) o |= SP.OPTION_SAVE_ALL_DISSIPATIONS;
              if (v("saveAllEvents", true)) o |= SP.OPTION_SAVE_ALL_EVENTS;
              if (v("curSheetAsRoot", false)) o |= SP.OPTION_CUR_SHEET_AS_ROOT;
            } else if (v("modelCurSheetAsRoot", false)) o |= SP.OPTION_CUR_SHEET_AS_ROOT;
            if (name === "SPICE Model") { say("SPICE .subckt model export is not available in the browser.", "error"); return; }
            text = await projectSpiceNetlist(o, (m, sev) => say(m, sev));
          } else if (name === "Allegro") { say("Allegro netlist export is not available in the browser.", "error"); return; }
          else {
            const res = await projectNetlist();
            if ("error" in res) { say(res.error, "error"); return; }
            const now = new Date(), ver = "10.99-web";
            text = name === "OrcadPCB2" ? NF.orcadPcb2(res.netlist, now) : name === "CadStar" ? NF.cadstar(res.netlist, now, ver) : NF.pads(res.netlist);
          }
        } catch (e) { console.warn(e); text = null; }
        if (text === null) { say(`Failed to create file '${fname}'.`, "error"); return; }
        download(text, fname);
        say(`Netlist exported to '${fname}'.`, "info");
      })();
      return false;
    } });
}
