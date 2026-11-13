// dialogs/erc-hier.ts — ERC_TESTER::RunTests over the whole SCH_SHEET_LIST: Run ERC checks every sheet of the
// hierarchy, not only the one on screen, and puts each sheet's markers on that sheet.  Each sheet instance is checked
// with its sub-sheets (the sheet pins against their hierarchical labels) and its parent sheet's pins (its labels
// against them); markers carry the sheet path and document they belong to.  The open sheet's markers go to the
// canvas; the others wait until their sheet is opened (onSheetOpened), and the ERC dialog lists them all.
import { E, appState, requestRender, store } from "./editor";
import { obj, projectJson } from "./project";
import { applySeverities } from "./erc-rules";
import { sheetList, type SheetInstance } from "./sch-hierarchy";

export interface HierMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; docId?: string; sheetPath?: string; sheetKey?: string; selected?: boolean; [k: string]: unknown }
interface SchErc { ercCheck(doc: KDoc, opts: Record<string, unknown>): HierMarker[]; ercHierarchy?(docs: { doc: KDoc; key: string }[]): HierMarker[][]; state: { markers?: unknown[]; markersDoc?: KDoc | null } }
const sch = (): SchErc | null => ((window as unknown as { CollabTools?: { sch?: SchErc } }).CollabTools || {}).sch || null;

/** The project's ERC options for ercCheck: its Pin Conflicts Map, the connection grid (schematic.connection_grid_size,
 *  mils) and the netclasses it defines (net_settings.classes) for undefined_netclass. */
export function ercProjectOpts(): Record<string, unknown> {
  const pro = projectJson(), erc = obj(pro.erc), sch = obj(pro.schematic), ns = obj(pro.net_settings);
  const cg = typeof sch.connection_grid_size === "number" && sch.connection_grid_size > 0 ? sch.connection_grid_size * 0.0254 : 1.27;
  const classes = Array.isArray(ns.classes) ? (ns.classes as unknown[]).map((c) => String(obj(c as never).name || "")).filter((n) => n) : null;
  return { pinMap: Array.isArray(erc.pin_map) ? erc.pin_map : undefined, connectionGrid: cg, netclasses: classes, defaultNetclass: "Default" };
}
/** The markers of the last hierarchical run, by sheet instance (root first, then by page number). */
let sheets: { docId: string; sheetPath: string; key: string; markers: HierMarker[] }[] = [], runPid: string | null = null;
const pidNow = (): string | null => { const p = (appState as unknown as { project: { projectId: string } | null }).project; return p ? p.projectId : null; };
/** The last run's sheets, when it was made in this project. */
const runSheets = (): typeof sheets => (runPid === pidNow() ? sheets : []);

/**
 * Run the ERC over every sheet instance.  `resolve` applies the project's exclusions to one sheet's list
 * (dialogs/erc.ts withExclusions).  Returns the open sheet's markers (already on the canvas).
 */
export async function runHierErc(opts: { showAllErrors?: boolean }, resolve: (l: HierMarker[]) => HierMarker[]): Promise<HierMarker[] | null> {
  const s = sch(); if (!s) return null;
  let list: SheetInstance[] = [];
  try { list = await sheetList(); } catch (e) { list = []; }
  const here = (appState as unknown as { docId: string | null }).docId;
  if (!list.length || !list.some((x) => x.docId === here)) return null;   // a sheet outside the hierarchy: the caller checks it alone
  const erc = obj(projectJson().erc), sev = obj(erc.rule_severities) as Record<string, unknown>, base = ercProjectOpts();
  const out: typeof sheets = [], docs: { doc: KDoc; key: string }[] = [], raw: HierMarker[][] = [];
  for (const inst of list) {
    // the sub-sheets this instance's sheet symbols name, and the pins of the sheet symbol that names it
    const subDocs = new Map<string, KDoc>();
    for (const child of list) if (child.parentDocId === inst.docId && child.sheetItemId && child.uuidPath.slice(0, -1).join("/") === inst.uuidPath.join("/")) {
      const it = inst.doc.items.get(child.sheetItemId); if (it && it.file) subDocs.set(it.file, child.doc);
    }
    let parentPins: string[] | null = null;
    if (inst.sheetItemId && inst.parentDocId) {
      const parent = list.find((p) => p.docId === inst.parentDocId && p.uuidPath.join("/") === inst.uuidPath.slice(0, -1).join("/"));
      const it = parent && parent.doc.items.get(inst.sheetItemId);
      if (it) parentPins = KiCadCanvas.kids(it.node, "pin").map((p) => KiCadCanvas.str(p[1] as SNode));
    }
    const doc = inst.docId === here && E.kdoc ? E.kdoc : inst.doc;
    let ms: HierMarker[] = [];
    // the tests across sheets (units, local / global and similar names, single global labels) run once below
    try { ms = s.ercCheck(doc, Object.assign({}, base, { sheetDocs: subDocs, parentPins, showAllErrors: !!opts.showAllErrors, crossSheet: !s.ercHierarchy ? true : false })); } catch (e) { ms = []; }
    docs.push({ doc, key: inst.uuidPath.join("/") }); raw.push(ms);
  }
  let cross: HierMarker[][] = [];
  try { cross = s.ercHierarchy ? s.ercHierarchy(docs) : []; } catch (e) { cross = []; }
  list.forEach((inst, i) => {
    const key = docs[i].key, all = raw[i].concat(cross[i] || []);
    all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.y - b.y || a.x - b.x);
    const ms = resolve(applySeverities(all, sev) as HierMarker[]);
    for (const m of ms) { m.docId = inst.docId; m.sheetPath = inst.sheetPath; m.sheetKey = key; }
    out.push({ docId: inst.docId, sheetPath: inst.sheetPath, key, markers: ms });
  });
  sheets = out; runPid = pidNow();
  const mine = out.find((x) => x.docId === here);
  return mine ? mine.markers : [];
}

/** Every marker of the last run in hierarchy order; the open sheet's entry is the live list on the canvas. */
export function allMarkers(live: HierMarker[]): HierMarker[] {
  const sheets = runSheets(); if (!sheets.length) return live;
  const here = (appState as unknown as { docId: string | null }).docId; let used = false;
  const out: HierMarker[] = [];
  for (const s of sheets) { if (s.docId === here && !used) { used = true; out.push(...live); } else if (s.docId !== here) out.push(...s.markers); }
  if (!used) out.push(...live);
  return out;
}
/**
 * Hand a changed full list back (an exclusion, a deleted marker, a severity change): each sheet keeps its markers in
 * the list's order; returns the open sheet's part for the canvas.
 */
export function distribute(all: HierMarker[]): HierMarker[] {
  const sheets = runSheets(), here = (appState as unknown as { docId: string | null }).docId;
  if (!sheets.length) return all;
  for (const s of sheets) s.markers = [];
  const live: HierMarker[] = [];
  for (const m of all) {
    const s = sheets.find((x) => x.key === m.sheetKey) || (m.docId ? null : sheets.find((x) => x.docId === here)) || null;
    if (s) s.markers.push(m);
    if (!m.docId || m.docId === here) live.push(m);
  }
  return live;
}
/** A sheet just opened: its markers from the last run go on the canvas (SCH_SCREEN keeps its own markers; another
 *  sheet's never show here). */
export function onSheetOpened(): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  const here = (appState as unknown as { docId: string | null }).docId, s = runSheets().find((x) => x.docId === here);
  const list = s ? s.markers : [];
  const EE = E as unknown as { markers: unknown[]; renderOpts: Record<string, unknown> };
  if (!list.length && !(EE.markers && EE.markers.length)) return;
  const M = sch(); if (M) { M.state.markers = list; M.state.markersDoc = E.kdoc; }
  EE.markers = list; EE.renderOpts.markers = list.length ? list : undefined;
  (store as unknown as { slice(k: string, v: unknown): void }).slice("viewport", { renderOpts: Object.assign({}, EE.renderOpts) }); requestRender();
}
/** A project switch forgets the run. */
export function forgetHierErc(): void { sheets = []; runPid = null; }
