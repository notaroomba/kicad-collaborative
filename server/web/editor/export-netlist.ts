// editor/export-netlist — File > Export > Netlist… (DIALOG_EXPORT_NETLIST): a notebook of the netlist formats,
// "Export Netlist" / "Close".  KiCad and Allegro (sim/netlist-kicad.ts), OrcadPCB2, CadStar, PADS
// (sim/netlist-formats.ts), all from the project's hierarchy, SPICE and SPICE Model (sim/spice-netlist.ts).
// The file is offered as a download named after the project (<stem>.net / .cir); Allegro's netlist and its devices/
// folder of device files come as one .zip, as the browser cannot write a folder next to the file.  The page last used and the SPICE
// options are remembered per browser, as KiCad keeps them in its settings.
import { E } from "./state";
import { state } from "./appstore";
import { box, checkField, h, note, notebook, openDialog, reportPanel, textField, type Field, type ReportLine } from "./pcbdialogs/ui";
import { projectNetlist } from "./pcbdialogs/update-pcb";
import { liveDocument, loadProjectFile, projectDocs } from "./projectfile";
import { download, fileStem } from "./menu-actions";
import * as NK from "../sim/netlist-kicad";
import { schVariantNames } from "../dialogs/sch-variants";
import { zip } from "../fab/zip";
import { KICAD_BASE_VERSION } from "../canvas/version";
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
export async function projectSpiceNetlist(options: number, report: (m: string, sev: "error" | "warning") => void, model = false): Promise<string | null> {
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
  const { symbols, texts, ports } = SP.readHierarchy({ sheets, netMap: res.netlist.netMap || new Map(), symbolPins: hp.symbolPins,
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
  return SP.spiceNetlist({ symbols, texts, options, library: (p) => libs.get(p) || null, report, subckt: model ? { name: projectName(), ports } : undefined });
}

/** GetBuildVersion() as the netlist headers carry it */
const BUILD_VERSION = KICAD_BASE_VERSION;
/** PROJECT::GetProjectName: the .kicad_pro's file name without its extension. */
function projectName(): string {
  const pro = projectDocs().find((d) => /\.kicad_pro$/.test(d.path));
  return pro ? (pro.path.split("/").pop() as string).replace(/\.kicad_pro$/, "") : fileStem().stem;
}
/** The NlInput of the project's hierarchy: sheets by page, the .kicad_pro's text variables, variants and root sheet
 *  name, the symbol library table's URIs and the net classes. */
export async function projectNlInput(): Promise<NK.NlInput | { error: string }> {
  const res = await projectNetlist();
  if ("error" in res) return res;
  let pro: Record<string, unknown> = {};
  try { const t = (E.proSettings as string | null) || (await loadProjectFile()); pro = t ? JSON.parse(t) : {}; } catch (e) { pro = {}; }
  const sheets = NK.nlSheets(res.netlist.instances || [], (f) => { const x = res.files.get(f); return x ? (x.doc as KDoc) : null; });
  const docs = sheets.map((s) => s.doc);
  const reg = new Map<string, string>();
  const sch = pro.schematic as { variants?: { name?: string; description?: string }[] } | undefined;
  for (const v of (sch && Array.isArray(sch.variants) ? sch.variants : [])) if (v && typeof v.name === "string") reg.set(v.name, typeof v.description === "string" ? v.description : "");
  const variants = schVariantNames(docs as never, pro).slice(1).map((name) => ({ name, description: reg.get(name) || "" }));
  // the project sym-lib-table's rows, else the global table's ${KICAD10_SYMBOL_DIR}
  const uris = new Map<string, string>();
  const table = projectDocs().find((d) => /(^|\/)sym-lib-table$/.test(d.path));
  if (table) {
    try {
      const t = KiCadCanvas.parse((await liveDocument(table.docId)).file) as SNode | null;
      for (const row of (t || []).filter((c) => Array.isArray(c) && c[0] === "lib") as SNode[]) {
        const name = String(((KiCadCanvas.kid(row, "name") as SNode | null) || [])[1] || ""), uri = String(((KiCadCanvas.kid(row, "uri") as SNode | null) || [])[1] || "");
        if (name) uris.set(name, uri);
      }
    } catch (e) { /* the global table only */ }
  }
  const ns = (pro.net_settings || {}) as { classes?: { name?: string }[]; netclass_assignments?: Record<string, string | string[]> | null; netclass_patterns?: { netclass?: string; pattern?: string }[] };
  const classes = new Set(["Default", ...(ns.classes || []).map((c) => String((c && c.name) || "")).filter(Boolean)]);
  const wild = (p: string): RegExp => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  const pats = (ns.netclass_patterns || []).filter((p) => p && p.pattern && p.netclass).map((p) => ({ re: wild(String(p.pattern)), cls: String(p.netclass) }));
  const netClass = (name: string): string => {
    const a = (ns.netclass_assignments || {})[name]; const direct = Array.isArray(a) ? a[0] : a;
    const cls = direct || (pats.find((p) => p.re.test(name)) || { cls: "" }).cls;
    return cls && classes.has(cls) ? cls : "Default";
  };
  const rootUuid = sheets.length ? sheets.find((s) => !s.sheetNode)?.uuidPath[0] : "";
  const rootSheetName = String(((pro.sheets as unknown[][] | undefined) || []).find((e) => Array.isArray(e) && e[0] === rootUuid)?.[1] || "");
  return { sheets, netlist: res.netlist, source: res.root, date: NK.iso8601Local(new Date()), version: BUILD_VERSION,
    textVars: (pro.text_variables as Record<string, string>) || {}, variants, rootSheetName, netClass,
    libUri: (nick) => (uris.has(nick) ? (uris.get(nick) as string) : `\${KICAD10_SYMBOL_DIR}/${nick}.kicad_sym`) };
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
          if (name === "KiCad" || name === "Allegro") {
            const inp = await projectNlInput();
            if ("error" in inp) { say(inp.error, "error"); return; }
            if (name === "KiCad") text = NK.kicadNetlist(inp);
            else {
              const a = NK.allegroNetlist(inp, (m, sev) => say(m, sev));
              const entries = [{ name: fname, data: a.netlist }, ...[...a.devices].map(([f, d]) => ({ name: "devices/" + f, data: d }))];
              const bytes = await zip(entries);
              download(new Blob([bytes as BlobPart], { type: "application/zip" }), `${stem}-allegro.zip`);
              say(`Netlist exported to '${fname}' with ${a.devices.size} device file${a.devices.size === 1 ? "" : "s"} in 'devices' (${stem}-allegro.zip).`, "info");
              return;
            }
          }
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
            text = await projectSpiceNetlist(o, (m, sev) => say(m, sev), name === "SPICE Model");
          } else {
            const res = await projectNetlist();
            if ("error" in res) { say(res.error, "error"); return; }
            const now = new Date(), ver = BUILD_VERSION;
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
