// symedit/editor.ts — SYMBOL_EDIT_FRAME in the web editor: a full-window frame over the schematic editor with
// KiCad's menus (menubar_symbol_editor.cpp), toolbars (toolbars_symbol_editor.cpp), the library tree, symbol tabs,
// the infobar, the message panel and a canvas drawn by kicad-canvas (KiCadCanvas.parseLibSymbol + render).
//
// What is edited: a symbol of one of the project's .kicad_sym libraries (a live shared buffer, symedit/libdoc.ts),
// a read-only symbol of the official libraries (its editable copy goes through Save As), or a schematic symbol's
// library copy (symedit/schematic.ts; Save writes it back to the schematic).  Each edit sends the whole symbol with
// the text it was made against; a tab's undo list holds the symbol before and after each of this user's edits, and
// undo carries back only that change (symedit/merge.ts), leaving what other users changed since in place.
import * as M from "./model";
import { libDocFor } from "./libdoc";
import { SymDirDoc, symdirOf, type LibBuffer, type DirFile } from "./symdir";
import { h, confirmBox, download } from "../dialogs/dom";
import { messageBox } from "../dialogs/sch-items";
import { E, appState, api } from "../dialogs/editor";
import { comboOf } from "../editor/hotkeys";
import { keyName } from "../keys";
import { fmtCoord, unitName, messageText, unitsMsg, gridChoiceText, loadUnits, saveUnits } from "../units";
import { toolCursor } from "../editor/cursors";
import { ensureStyle, icon, meta, showMenu, closeMenus, type MenuEntry } from "./ui";
import { fitMenu } from "../menufit";
import * as D from "./dialogs";
import * as SP from "./props";
import { FP_BROWSE_TIP, chooseFootprint, noFileBrowsing, openDatasheet, urlIcon, urlTip } from "../dialogs/browse-cells";
import { datasheetLink } from "../library/fpchoice";
import { kicadIcon, setKicadIcon } from "../components/kicon-dom";
import { symCanvasMenu, symTreeMenu, type SymMenuCtx } from "./ctxmenu";
import { ZOOM_LIST, LINKS, LOCAL_LABELS } from "../tables";
import { openSymbolFind, findNext as findNextMatch } from "./find";
import type { Units } from "../store";
import { saveToSchematic } from "./schematic";
import { mergeSymbolText } from "./merge";
import { openPreferences } from "../dialogs/preferences";
import { GRID_PAGE, clonePrefs, defaultGrid, gridDefs, prefs, rememberGrid, savePrefs } from "../dialogs/prefs";
import { gridPitchFor, type GridClass } from "../dialogs/logic";
import { ARC_MODE_ACTIONS, ARC_START_DIR_END, ARC_START_END_CENTER, ARC_START_END_MID, ARC_TANGENT, arcFromStartEndCenterDrag, arcFromStartEndMidDrag, arcFromStartTangentEnd, fromNm, toNm, type ArcSol } from "../tools/arc-geom";

export type ToolId = "select" | "pin" | "text" | "textbox" | "rectangle" | "circle" | "ellipse" | "ellipse_arc" | "arc" | "bezier" | "polyline" | "polygon" | "anchor" | "delete" | "zoom";
interface Row { name: string; desc: string; parent: string; units: number; power: boolean; unitNames?: string[] }
export interface Lib { nick: string; kind: "project" | "official"; doc: LibBuffer | null; rows: Row[] | null; syms: Map<string, M.Node>; open: boolean; loading: boolean; error?: string }
export interface Origin { docId: string; itemId: string; libId: string; ref: string; sheet: string }
/** One undo step: the symbol before and after the edit (the undo lays after → before over the current symbol). */
export interface Step { label: string; before: string; after: string }
export interface Tab { lib: string; name: string; origin?: Origin; scratch?: M.Node; modified?: boolean; undo: Step[]; redo: Step[]; unit: number; body: number; sel: Set<string>; view: { s: number; px: number; py: number } | null; fitted?: boolean }

const TOOL_ACTIONS: Record<string, ToolId> = { selectionTool: "select", placeSymbolPin: "pin", placeSymbolText: "text", drawSymbolTextBox: "textbox", drawRectangle: "rectangle", drawCircle: "circle", drawEllipse: "ellipse", drawEllipseArc: "ellipse_arc", drawArc: "arc", drawArcCenter: "arc", drawArcStartEndMid: "arc", drawArcStartEndCenter: "arc", drawArcTangent: "arc", drawArcStartDirEnd: "arc", drawBezier: "bezier", drawSymbolLines: "polyline", drawSymbolPolygon: "polygon", placeSymbolAnchor: "anchor", deleteTool: "delete", zoomTool: "zoom" };
/** The Symbol Editor's grid list: its own window settings (Preferences > Symbol Editor > Grids), 100/50/25/10 mil by default. */
const symGrids = (): number[] => prefs().grids.sym.sizes;
const ANCHOR = "#0000FF";   // LAYER_SCHEMATIC_ANCHOR

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const VIEW_KEY = "kui.symedit.view";
/** Toolbar buttons that are check items (ACTION_TOOLBAR toggles). */
const TOGGLES = new Set(["toggleGrid", "toggleGridOverrides", "millimetersUnits", "milsUnits", "inchesUnits", "cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs",
  "showElectricalTypes", "showHiddenPins", "showHiddenFields", "togglePinAltIcons", "showLibraryTree", "showProperties", "toggleSyncedPinsMode"]);
/** ARC_DRAW_MODE, shared with the schematic editor's Draw Arcs (sch-tools arcs.ts SCH_ARC_MODE_KEY). */
const ARC_MODE_KEY = "kc.sch.arcDrawMode";
function arcDrawMode(): number { try { const m = Number(localStorage.getItem(ARC_MODE_KEY)); return m >= 0 && m <= 4 ? m : 0; } catch { return 0; } }
function setArcDrawMode(m: number): void { try { localStorage.setItem(ARC_MODE_KEY, String(m)); } catch { /* no storage */ } }
function viewPref(k: string, dflt: unknown): unknown { try { const o = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}"); return k in o ? o[k] : dflt; } catch { return dflt; } }
function saveViewPref(k: string, v: unknown): void { try { const o = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}"); o[k] = v; localStorage.setItem(VIEW_KEY, JSON.stringify(o)); } catch { /* no storage */ } }
/** EE_GRID_HELPER::GetItemGrid for the symbol editor's items and tools: pins connect, texts are text, the rest graphics. */
const SYM_GRID_CLASS: Record<string, GridClass> = { pin: "connected", text: "text", textbox: "graphics", text_box: "graphics", rectangle: "graphics", circle: "graphics", ellipse: "graphics", ellipse_arc: "graphics", arc: "graphics", bezier: "graphics", polyline: "graphics", polygon: "graphics", property: "text" };
const symIdOf = (kind: string, sub: string, j: number) => (kind === "pin" ? "p:" : "g:") + sub + ":" + j;
/** "p:SUB:J" / "g:SUB:J" / "f:Name" → the node in `sym`. */
export function nodeOf(sym: M.Node, id: string): M.Node | null {
  if (id.startsWith("f:")) return M.fieldOf(sym, id.slice(2));
  const a = id.indexOf(":"), b = id.lastIndexOf(":"); if (a < 0 || b <= a) return null;
  return M.itemAt(sym, { sub: id.slice(a + 1, b), j: Number(id.slice(b + 1)) });
}
export function idOfNode(sym: M.Node, n: M.Node): string | null {
  if (n[0] === "property") return "f:" + String(n[1]);
  const r = M.findRef(sym, n); return r ? symIdOf(String(n[0]), r.sub, r.j) : null;
}

export class SymbolEditor {
  root: HTMLElement | null = null;
  libs = new Map<string, Lib>();
  tabs: Tab[] = [];
  cur = -1;
  tool: ToolId = "select";
  showHiddenPins = true; showHiddenFields = true; showETypes = true; showAltIcons = true; syncPins = true; showTree = true; showProps = true;
  propsCollapsed = new Set<string>();
  symOpen = new Set<string>();
  /** the window's grid.show and cursor shape (COMMON_TOOLS::ToggleGrid, CursorSmall/Full/45Crosshairs), remembered per browser */
  showGrid = viewPref("grid", true) as boolean; crosshair = viewPref("crosshair", "small") as "small" | "full" | "45";
  /** ACTION_TOOLBAR groups: the action each group's button shows (SelectToolbarAction) */
  private groupCurrent: Record<string, string> = {};
  /** grid.last_size of the symbol editor's window settings, in mm */
  gridMm = 50 * M.MIL;
  /** the schematic editor's units while this frame is up: the symbol editor keeps its own (symbol_editor system.units) */
  private hostUnits: { units: string; lastImperial: string } | null = null;
  /** BASE_SCREEN::m_LocalOrigin (file coordinates) */
  localOrigin: [number, number] = [0, 0];
  lastPin = M.initialPinDefaults();
  lastRepeat: M.PinInfo | null = null;
  lastTextAngle = 0;
  clip: string | null = null;
  filter = "";
  treeSel: { lib: string; name?: string; unit?: number } | null = null;
  private el: Record<string, HTMLElement> = {};
  private cv: HTMLCanvasElement | null = null;
  private preview: M.Node | null = null;
  private kcache: { key: string; doc: KDoc } | null = null;
  private mouse = { x: 0, y: 0, in: false };           // doc mm (Y down)
  private drag: { mode: "pan" | "band" | "move" | "zoom"; sx: number; sy: number; x0: number; y0: number; px?: number; py?: number; moved?: boolean; ids?: string[] } | null = null;
  private carry: { ids: string[]; sx: number; sy: number; label: string; amend: boolean; base: string } | null = null;
  /** SYMBOL_EDITOR_DRAWING_TOOLS::TwoClickPlace: a new pin or text follows the cursor (IS_NEW | IS_MOVING) until the second click. */
  private floating: { kind: "pin"; pin: M.PinInfo } | { kind: "text"; node: M.Node; body: number; unit?: number } | null = null;
  private draw: { kind: ToolId; pts: number[][] } | null = null;
  private officialList: { name: string; description: string }[] | null = null;
  private officialFailed = "";
  private keyHook = (ev: KeyboardEvent) => this.onKey(ev);
  /** the schematic editor puts the focus back on its own canvas when a dialog closes: the frame takes it back */
  private focusHook = (ev: FocusEvent) => {
    const t = ev.target as HTMLElement | null; if (!this.isOpen || !t || !this.root || this.root.contains(t)) return;
    if (t.closest && t.closest(".kd-overlay, .kd-pop, .se-menu, [role='dialog']")) return;
    setTimeout(() => { const a = document.activeElement as HTMLElement | null; if (this.isOpen && (!a || a === document.body || !this.root!.contains(a)) && !(a && a.closest && a.closest(".kd-overlay, .kd-pop, [role='dialog']"))) this.el.cwrap.focus({ preventScroll: true }); }, 0);
  };

  /** multiUnitModeCond: the symbol has several units and they are interchangeable (not locked). */
  multiUnitMode(sym: M.Node | null = this.symbol()): boolean { if (!sym) return false; const r = this.rootSym(sym); return M.unitCount(r) > 1 && !M.unitsLocked(r); }
  /** SYMBOL_EDIT_FRAME::SynchronizePins: the setting (sync_pin_edit, on by default), for a multi-unit symbol whose units are not locked. */
  synchronizePins(sym: M.Node | null = this.symbol()): boolean { return this.syncPins && this.multiUnitMode(sym); }
  get isOpen(): boolean { return !!this.root && this.root.isConnected; }
  get tab(): Tab | null { return this.tabs[this.cur] || null; }
  get units(): Units { return (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units; }
  fmt(mm: number): string { return fmtCoord(mm, this.units).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m)) + " " + unitName(this.units); }

  // ---------------------------------------------------------------- open / close
  open(): void {
    ensureStyle();
    if (!this.root) { this.build(); if (window.innerWidth < 900) { this.showTree = false; this.showProps = false; } }   // a narrow window starts with the canvas alone
    if (!this.root!.isConnected) document.body.append(this.root!);
    document.documentElement.dataset.symedit = "open";
    if (!this.hostUnits) {
      this.hostUnits = { units: E.units, lastImperial: String(E.lastImperial || "mil") };
      const us = loadUnits("symbol_editor"); E.units = us.units; E.lastImperial = us.lastImperial;
      this.gridMm = defaultGrid("sym");
      window.addEventListener("kc:prefs", this.prefsHook);
    }
    window.addEventListener("keydown", this.keyHook, true);
    document.addEventListener("focusin", this.focusHook, true);
    this.refreshLibs();
    this.renderAll();
    requestAnimationFrame(() => { this.resize(); if (this.tab && !this.tab.fitted) this.zoomFit(); this.paint(); });
  }
  async close(): Promise<void> {
    const dirty = this.tabs.filter((t) => (t.origin && t.modified) || (t.scratch && !t.origin));
    if (dirty.length && !(await confirmBox("Close Symbol Editor", `Save changes to "${dirty[0].name}" before closing?\n\nChanges made to the schematic copy will be lost.`, "Discard Changes"))) return;
    this.tabs = this.tabs.filter((t) => !t.origin && !t.scratch); this.cur = Math.min(this.cur, this.tabs.length - 1);
    closeMenus();
    window.removeEventListener("keydown", this.keyHook, true);
    document.removeEventListener("focusin", this.focusHook, true);
    delete document.documentElement.dataset.symedit;
    if (this.hostUnits) { E.units = this.hostUnits.units; E.lastImperial = this.hostUnits.lastImperial; this.hostUnits = null; window.removeEventListener("kc:prefs", this.prefsHook); }
    if (this.root) this.root.remove();
    if (this.hostTitle) { document.title = this.hostTitle; this.hostTitle = ""; }
    try { const u = new URL(location.href); if (u.searchParams.has("symedit")) { u.searchParams.delete("symedit"); history.replaceState(history.state, "", u.toString()); } } catch (e) { /* no history */ }
  }

  // ---------------------------------------------------------------- libraries
  /**
   * The project's libraries as the project sym-lib-table lists them (SYMBOL_LIBRARY_ADAPTER over the table rows): a
   * .kicad_sym document joins the tree under its row's nickname only, and a file no row names (a stray copy, a legacy
   * <project>-cache.kicad_sym) stays out.  Nothing is listed until the table has been read, so a library never shows
   * under its file name first.  A project with no table at all lists its .kicad_sym documents by file name (except
   * the legacy cache), since the web has no other way to reach them.
   */
  refreshLibs(): void {
    const docs = (appState.project && appState.project.docs) || appState.docs || [];
    const table = docs.find((d) => /(^|\/)sym-lib-table$/.test(d.path));
    if (table && !this.tableLoaded) { void this.readTable(table.docId); }
    else for (const d of docs) {
      if (d.docType !== "symbol_lib" && !/\.kicad_sym$/i.test(d.path)) continue;
      if (symdirOf(d.path)) continue;   // a directory library's file: below
      if (this.disabledPaths.has(d.path)) continue;
      const file = d.path.split("/").pop() || d.path;
      let nick: string | undefined;
      if (table) { nick = this.tableNicks.get(d.path); if (!nick) continue; }
      else { if (/-cache\.kicad_sym$/i.test(file)) continue; nick = file.replace(/\.kicad_sym$/i, ""); }
      if (this.libs.has(nick) && this.libs.get(nick)!.kind === "project") continue;
      const doc = libDocFor(d.docId, d.path, nick);
      const lib: Lib = { nick, kind: "project", doc, rows: null, syms: new Map(), open: false, loading: true };
      this.libs.set(nick, lib);   // a project row shadows an official library of the same nickname, as the project table does
      doc.on((why, names) => this.onLibEvent(lib, why, names));
      doc.connect();
    }
    if (!table || this.tableLoaded) this.refreshDirLibs(docs, !!table);
    if (!this.officialList && !this.officialFailed) {
      fetch("/api/libs/symbols", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 401 ? "Sign in to browse the KiCad libraries" : `HTTP ${r.status}`))))
        .then((j: { libraries: { name: string; description: string }[] }) => {
          this.officialList = j.libraries;
          for (const l of j.libraries) if (!this.libs.has(l.name)) this.libs.set(l.name, { nick: l.name, kind: "official", doc: null, rows: null, syms: new Map(), open: false, loading: false });
          this.renderTree();
        }).catch((e: Error) => { this.officialFailed = e.message; });
    }
  }
  /** KiCad 10 directory libraries (X.kicad_symdir, one symbol per file): one buffer over the directory's files. */
  private refreshDirLibs(docs: { docId: string; path: string; docType?: string }[], byTable: boolean): void {
    const dirs = new Map<string, DirFile[]>();
    for (const d of docs) { const dir = symdirOf(d.path); if (!dir) continue; const l = dirs.get(dir) || []; l.push({ docId: d.docId, path: d.path }); dirs.set(dir, l); }
    if (byTable) for (const path of this.tableNicks.keys()) if (/\.kicad_symdir$/i.test(path) && !dirs.has(path)) dirs.set(path, []);   // a row whose directory has no file yet
    for (const [dir, files] of dirs) {
      if (this.disabledPaths.has(dir)) continue;
      const nick = byTable ? this.tableNicks.get(dir) : (dir.split("/").pop() || dir).replace(/\.kicad_symdir$/i, "");
      if (!nick) continue;
      const have = this.libs.get(nick);
      if (have && have.kind === "project" && have.doc instanceof SymDirDoc) { for (const f of files) have.doc.adopt(f); continue; }
      const doc = new SymDirDoc(dir, nick, files, (path, first) => this.makeProjectFile(path, first));
      const lib: Lib = { nick, kind: "project", doc, rows: null, syms: new Map(), open: false, loading: files.length > 0 };
      this.libs.set(nick, lib);
      doc.on((why, names) => this.onLibEvent(lib, why, names));
      doc.connect();
    }
  }
  /** A new .kicad_sym document in the project (a directory library's new symbol file) with its first content. */
  private async makeProjectFile(path: string, first: string): Promise<DirFile | null> {
    const proj = appState.project; if (!proj) return null;
    try {
      const d = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, docType: "symbol_lib" }) }) as { docId: string; path: string; docType: string };
      const r = await fetch(`/api/docs/${d.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: first });
      if (!r.ok) return null;
      if (!proj.docs.some((x) => x.docId === d.docId)) proj.docs.push({ docId: d.docId, path: d.path, docType: d.docType || "symbol_lib" });
      return { docId: d.docId, path: d.path };
    } catch (e) { return null; }
  }
  /** project table rows: document path → nickname (enabled and disabled rows) */
  private tableNicks = new Map<string, string>();
  /** Project libraries whose sym-lib-table row is disabled: not loaded, not in the tree (LIBRARY_TABLE_ROW::Disabled). */
  private disabledPaths = new Set<string>();
  private tableRead = false; private tableLoaded = false;
  private async readTable(docId: string): Promise<void> {
    if (this.tableRead) return; this.tableRead = true;
    let rows: M.LibTableRow[] = [];
    try { const r = await fetch(`/api/docs/${docId}/content`, { credentials: "same-origin" }); if (r.ok) rows = M.parseLibTable(await r.text()); } catch (e) { /* an unreadable table lists nothing */ }
    this.tableLoaded = true;
    this.reloadLibTable(rows);
  }
  /** An official library a project library of the same nickname was shadowing comes back. */
  private restoreOfficial(nick: string): void {
    if (this.libs.has(nick) || !this.officialList || !this.officialList.some((l) => l.name === nick)) return;
    this.libs.set(nick, { nick, kind: "official", doc: null, rows: null, syms: new Map(), open: false, loading: false });
  }
  /** A row this client just added (New Library / Add Library). */
  noteTableRow(path: string, nick: string): void { this.tableNicks.set(path, nick); }
  /** The project table changed (or was read): nicknames follow it, rows that went or are disabled leave the tree, new and re-enabled ones come in. */
  reloadLibTable(rows: M.LibTableRow[]): void {
    let changed = false;
    const disabled = new Set<string>(); const nicks = new Map<string, string>();
    for (const row of rows) {
      const m = /^\$\{KIPRJMOD\}\/(.+)$/.exec(row.uri); if (!row.nickname || !m) continue;
      const path = m[1]; nicks.set(path, row.nickname);
      if (!row.enabled) disabled.add(path);
      for (const lib of [...this.libs.values()]) if (lib.doc && lib.doc.path === path && lib.nick !== row.nickname) {
        const old = lib.nick; this.libs.delete(old); lib.nick = row.nickname; lib.doc.nickname = row.nickname; this.libs.set(row.nickname, lib);
        for (const t2 of this.tabs) if (t2.lib === old) t2.lib = row.nickname;
        this.restoreOfficial(old);
        changed = true;
      }
    }
    this.tableNicks = nicks; this.tableLoaded = true;
    for (const lib of [...this.libs.values()]) if (lib.doc && (disabled.has(lib.doc.path) || !nicks.has(lib.doc.path)) && !this.tabs.some((t) => t.lib === lib.nick)) { this.libs.delete(lib.nick); this.restoreOfficial(lib.nick); changed = true; }
    this.disabledPaths = disabled;
    const before = this.libs.size; this.refreshLibs(); if (this.libs.size !== before) changed = true;
    if (changed) this.renderAll();
  }
  private onLibEvent(lib: Lib, why: string, names?: string[]): void {
    if (why === "load" || why === "error") lib.loading = false;
    if (why === "error" && lib.doc) lib.error = lib.doc.error || "could not load";
    lib.rows = null;
    // a symbol renamed or deleted elsewhere: its tab goes
    for (let i = this.tabs.length - 1; i >= 0; i--) { const t = this.tabs[i]; if (t.lib === lib.nick && !t.origin && lib.doc && lib.doc.loaded && !lib.doc.lib.symbols.has(t.name)) { if (why === "remote" && names && names.includes(t.name)) this.closeTab(i, true); } }
    if (!this.isOpen) return;
    this.renderTree(); this.renderTabs(); this.renderInfo(); this.renderToolbars(); this.renderMsg(); this.paint();
  }
  rowsOf(lib: Lib): Row[] {
    if (lib.rows) return lib.rows;
    if (lib.kind === "project" && lib.doc) {
      const rows: Row[] = [];
      for (const [name, s] of lib.doc.lib.symbols) { const root = M.rootOf(lib.doc.lib, s); rows.push({ name, desc: M.fieldValue(s, "Description"), parent: M.parentNameOf(s) || "", units: M.unitCount(root), power: M.isPower(s), unitNames: M.unitChoices(root) }); }
      rows.sort((a, b) => M.numCompare(a.name, b.name));
      return (lib.rows = rows);
    }
    return [];
  }
  private async loadOfficial(lib: Lib): Promise<void> {
    if (lib.rows || lib.loading) return; lib.loading = true; this.renderTree();
    try {
      const r = await fetch(`/api/libs/symbols/${encodeURIComponent(lib.nick)}`, { credentials: "same-origin" }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { symbols: { n: string; d: string; u: number; p?: boolean; e?: string }[] };
      lib.rows = j.symbols.map((s) => ({ name: s.n, desc: s.d, parent: s.e || "", units: s.u, power: !!s.p }));
    } catch (e) { lib.error = (e as Error).message; }
    lib.loading = false; this.renderTree();
  }
  /** An official library symbol (and its parents), parsed into the library's map. */
  private async fetchOfficial(lib: Lib, name: string): Promise<M.Node | null> {
    const have = lib.syms.get(name); if (have) return have;
    const r = await fetch(`/api/libs/symbols/${encodeURIComponent(lib.nick)}/${encodeURIComponent(name)}`, { credentials: "same-origin" });
    if (!r.ok) { await messageBox(`Symbol '${name}' not found in library '${lib.nick}'.`); return null; }
    const j = await r.json() as { symbol: string; parents?: string[] };
    for (const p of j.parents || []) { try { const n = M.node(p); lib.syms.set(M.symName(n), n); } catch (e) { /* skip */ } }
    const n = M.node(j.symbol); lib.syms.set(M.symName(n), n); return n;
  }
  libMap(lib: Lib | null): M.SymLib | null {
    if (!lib) return null;
    if (lib.doc) return lib.doc.lib;
    return { head: [], version: 0, symbols: lib.syms } as unknown as M.SymLib;
  }
  projectLibs(): Lib[] { return [...this.libs.values()].filter((l) => l.kind === "project"); }

  // ---------------------------------------------------------------- the current symbol
  symbol(t: Tab | null = this.tab): M.Node | null {
    if (!t) return null;
    if (t.scratch) return t.scratch;
    const lib = this.libs.get(t.lib); if (!lib) return null;
    return lib.doc ? lib.doc.lib.symbols.get(t.name) || null : lib.syms.get(t.name) || null;
  }
  parentOf(sym: M.Node, t: Tab | null = this.tab): M.Node | null {
    const p = M.parentNameOf(sym); if (!p || !t || t.scratch) return null;
    const m = this.libMap(this.libs.get(t.lib) || null); return m ? m.symbols.get(p) || null : null;
  }
  readOnly(t: Tab | null = this.tab): boolean {
    if (!t) return true;
    if (E.viewOnly) return true;
    if (t.origin || t.scratch) return false;
    const lib = this.libs.get(t.lib); return !lib || lib.kind === "official" || !lib.doc || !lib.doc.canEdit;
  }
  isModified(t: Tab): boolean {
    if (t.origin) return !!t.modified;
    if (t.scratch) return true;   // an unsaved symbol
    const lib = this.libs.get(t.lib); return !!lib && !!lib.doc && lib.doc.loaded && lib.doc.isSymbolModified(t.name);
  }
  /**
   * One undoable edit of the current symbol: `fn` changes a fresh copy (false = nothing to do) and may return the
   * nodes to select afterwards.  Library symbols commit to the shared buffer; a schematic copy stays in its tab.
   */
  edit(label: string, fn: (s: M.Node) => M.Node[] | void | false, opts: { amend?: boolean } = {}): boolean {
    const t = this.tab; const cur = this.symbol(); if (!t || !cur) return false;
    if (this.readOnly()) { this.readOnlyNotice(); return false; }
    const before = M.text(cur); const s = M.node(before);
    const res = fn(s); if (res === false) return false;
    const after = M.text(s); if (after === before) return false;
    if (!opts.amend || !t.undo.length) t.undo.push({ label, before, after });
    else t.undo[t.undo.length - 1].after = after;
    if (t.undo.length > 100) t.undo.shift();
    t.redo = [];
    if (Array.isArray(res)) { t.sel = new Set(res.map((n) => idOfNode(s, n)).filter((x): x is string => !!x)); }
    else t.sel = new Set([...t.sel].filter((id) => nodeOf(s, id)));
    this.store(t, s, before);
    return true;
  }
  /** `base`: the symbol's text the change was made against (merged over a symbol another user changed meanwhile). */
  private store(t: Tab, s: M.Node, base: string): void {
    if (t.origin || t.scratch) { t.scratch = s; t.modified = true; }
    else {
      const lib = this.libs.get(t.lib);
      if (lib && lib.doc) {
        const nn = M.symName(s);
        // an undone or redone rename (Symbol Properties): the symbol moves back under its other name
        const ch: ([string, string | null] | [string, string, string])[] = nn !== t.name && nn && !lib.doc.lib.symbols.has(nn) ? [[t.name, null], [nn, M.text(s)]] : [[t.name, M.text(s), base]];
        if (ch.length === 2) t.name = nn;
        lib.doc.commit(ch).catch((e: Error) => void messageBox(`The edit was not accepted: ${e.message}`)); lib.rows = null;
      }
    }
    this.kcache = null;
    this.renderTree(); this.renderTabs(); this.renderMsg(); this.renderToolbars(); this.paint();
  }
  undo(): void {
    const t = this.tab; const cur = this.symbol(); if (!t || !cur || !t.undo.length || this.readOnly()) return;
    const step = t.undo.pop()!; t.redo.push(step); t.sel.clear(); this.applyStep(t, cur, step.after, step.before);
    if (t.origin && !t.undo.length) t.modified = false;
  }
  /** Lay the change from → to over the current symbol: only this user's edit is taken back (or redone). */
  private applyStep(t: Tab, cur: M.Node, from: string, to: string): void {
    const ct = M.text(cur);
    this.store(t, M.node(mergeSymbolText(from, to, ct, M.node)), ct);
  }
  redo(): void {
    const t = this.tab; const cur = this.symbol(); if (!t || !cur || !t.redo.length || this.readOnly()) return;
    const step = t.redo.pop()!; t.undo.push(step); t.sel.clear(); this.applyStep(t, cur, step.before, step.after);
  }
  /** EDA_BASE_FRAME::ShowInfoBarError: the infobar shows the message until the next refresh. */
  infoBarError(msg: string): void {
    const el = this.el.info; if (!el) return; el.innerHTML = ""; el.append(h("span", { class: "se-info-error" }, msg)); el.classList.add("show");
  }
  /** SCH_BASE_FRAME::ShowFindReplaceStatus: an information message for a while (WX_INFOBAR::ShowMessageFor). */
  infoBarMessage(msg: string, ms: number): void {
    const el = this.el.info; if (!el) return; el.innerHTML = ""; el.append(h("span", null, msg)); el.classList.add("show");
    clearTimeout(this.infoTimer); this.infoTimer = setTimeout(() => this.renderInfo(), ms);
  }
  private infoTimer: ReturnType<typeof setTimeout> | undefined;
  /** EDA_DRAW_FRAME::FocusOnLocation: centre the view on a point (mm, Y down) without changing the zoom. */
  focusOn(x: number, y: number): void {
    const v = this.view(); if (!this.cv) return;
    v.px = (this.cv.clientWidth || 800) / 2 - x * v.s; v.py = (this.cv.clientHeight || 600) / 2 - y * v.s; this.paint(); this.renderStatus();
  }
  readOnlyNotice(): void {
    const t = this.tab; if (!t) return;
    const lib = this.libs.get(t.lib);
    if (E.viewOnly) void messageBox("You have view-only access to this project.");
    else if (lib && lib.kind === "official") void messageBox(`Symbol library '${lib.nick}' is not writable.\n\nYou must save to a different location.`);
    else if (lib && lib.doc && !lib.doc.loaded) void messageBox("The library is still loading.");
    else void messageBox("Library is read-only.  Changes cannot be saved to this library.");
  }

  // ---------------------------------------------------------------- tabs
  async loadSymbol(libNick: string, name: string, unit = 1, body = 1): Promise<boolean> {
    const lib = this.libs.get(libNick);
    if (!lib) { await messageBox(`Library '${libNick}' not found.`); return false; }
    if (lib.kind === "official") { if (!(await this.fetchOfficial(lib, name))) return false; }
    else if (lib.doc) { await lib.doc.whenLoaded(); if (!lib.doc.lib.symbols.has(name)) { await messageBox(`Symbol '${name}' not found in library '${libNick}'.`); return false; } }
    const i = this.tabs.findIndex((t) => !t.origin && t.lib === libNick && t.name === name);
    if (i >= 0) { this.cur = i; const t = this.tabs[i]; if (unit) t.unit = unit; t.body = body || t.body; }
    else { this.tabs.push({ lib: libNick, name, undo: [], redo: [], unit: unit || 1, body: body || 1, sel: new Set(), view: null }); this.cur = this.tabs.length - 1; }
    this.treeSel = { lib: libNick, name }; lib.open = true; this.afterTabChange();
    try { const u = new URL(location.href); u.searchParams.set("symedit", `${libNick}:${name}`); history.replaceState(history.state, "", u.toString()); } catch (e) { /* no history */ }
    return true;
  }
  /** SYMBOL_EDIT_FRAME::CreateUnsavedSymbolTab: a new symbol with no library yet; its first save asks for one. */
  openUnsaved(sym: M.Node): void {
    this.tabs.push({ lib: "", name: M.symName(sym), scratch: sym, modified: true, undo: [], redo: [], unit: 1, body: 1, sel: new Set(), view: null });
    this.cur = this.tabs.length - 1; this.treeSel = null; this.afterTabChange();
  }
  openScratch(origin: Origin, sym: M.Node, unit: number, body: number): void {
    const i = this.tabs.findIndex((t) => t.origin && t.origin.itemId === origin.itemId && t.origin.docId === origin.docId);
    const tab: Tab = { lib: origin.libId.split(":")[0] || "", name: M.symName(sym), origin, scratch: sym, modified: false, undo: [], redo: [], unit: unit || 1, body: body || 1, sel: new Set(), view: null };
    if (i >= 0) { this.tabs[i] = tab; this.cur = i; } else { this.tabs.push(tab); this.cur = this.tabs.length - 1; }
    this.afterTabChange();
  }
  async closeTab(i: number, force = false): Promise<void> {
    const t = this.tabs[i]; if (!t) return;
    if (!force && t.origin && t.modified && !(await confirmBox("Close Symbol Tab", `Discard changes to the schematic copy of '${t.name}'?`, "Discard Changes"))) return;
    if (!force && t.scratch && !t.origin && !(await confirmBox("Close Symbol Tab", `Discard the unsaved symbol '${M.unescapeLibId(t.name)}'?`, "Discard Changes"))) return;
    this.tabs.splice(i, 1); if (this.cur >= this.tabs.length) this.cur = this.tabs.length - 1; else if (i < this.cur) this.cur--;
    this.afterTabChange();
  }
  private afterTabChange(): void {
    this.cancelInteraction(); this.kcache = null; this.preview = null;
    this.renderAll(); requestAnimationFrame(() => { this.resize(); const t = this.tab; if (t && !t.fitted) this.zoomFit(); this.paint(); });
  }
  setUnit(u: number): void { const t = this.tab; if (!t) return; t.unit = u; t.sel.clear(); this.kcache = null; this.renderToolbars(); this.paint(); }
  setBody(b: number): void { const t = this.tab; if (!t) return; t.body = b; t.sel.clear(); this.kcache = null; this.renderToolbars(); this.paint(); }

  // ---------------------------------------------------------------- canvas model
  /** The (version …) of the file the tab's symbol lives in (a schematic copy: the schematic's; an unsaved one: this tree's). */
  fileVersion(t: Tab | null = this.tab): number {
    if (!t) return 0;
    if (t.origin) { const kd = E.kdoc as { version?: number } | null; return (kd && kd.version) || 0; }
    if (t.scratch) return M.SYMBOL_LIB_FILE_VERSION;
    const lib = this.libs.get(t.lib); return lib && lib.doc ? lib.doc.lib.version : 0;
  }
  kdoc(): KDoc | null {
    const t = this.tab; const sym = this.preview || this.symbol(); if (!t || !sym) return null;
    const parent = this.parentOf(sym);
    const key = [M.text(sym), parent ? M.text(parent) : "", t.unit, t.body, this.showHiddenPins, this.showHiddenFields, this.showETypes].join("§");
    if (this.kcache && this.kcache.key === key) return this.kcache.doc;
    const doc = K().parseLibSymbol(sym as unknown as SNode, { unit: t.unit, bodyStyle: t.body, showHiddenPins: this.showHiddenPins, showHiddenFields: this.showHiddenFields, showElectricalTypes: this.showETypes, showPinAltIcons: this.showAltIcons, fileVersion: this.fileVersion(t), parent: parent as unknown as SNode });
    this.kcache = { key, doc }; return doc;
  }
  private view(): { s: number; px: number; py: number } {
    const t = this.tab; if (t && t.view) return t.view;
    const v = { s: 12, px: (this.cv ? this.cv.clientWidth : 800) / 2, py: (this.cv ? this.cv.clientHeight : 600) / 2 };
    if (t) t.view = v; return v;
  }
  /** client px → doc mm (Y down). */
  toDoc(cx: number, cy: number): [number, number] { const r = this.cv!.getBoundingClientRect(); const v = this.view(); return [(cx - r.left - v.px) / v.s, (cy - r.top - v.py) / v.s]; }
  /** doc mm → snapped library coordinates (Y up). */
  snapFile(x: number, y: number): [number, number] { const g = this.snapGrid(); return [+M.fmt(Math.round(x / g) * g), +M.fmt(-Math.round(y / g) * g)]; }
  /** The pitch the cursor snaps to: the grid, or the override of the class of what is drawn or carried (Grid Overrides). */
  snapGrid(): number {
    const o = prefs().grids.sym.overrides; if (!o.enabled) return this.gridMm;
    let cls: GridClass = this.tool !== "select" && this.tool !== "zoom" ? SYM_GRID_CLASS[this.tool] || null : null;
    const t = this.tab, sym = this.symbol();
    if (!cls && t && sym && t.sel.size) { const id = [...t.sel][0]; const n = nodeOf(sym, id); cls = id.startsWith("f:") ? "text" : n ? SYM_GRID_CLASS[String(n[0])] || null : null; }
    return gridPitchFor(cls, o, this.gridMm);
  }
  zoomFit(): void {
    const t = this.tab; const doc = this.kdoc(); if (!t || !this.cv) return;
    const W = this.cv.clientWidth || 800, H = this.cv.clientHeight || 600;
    const bb = doc && doc.bbox ? doc.bbox : [-10, -10, 10, 10];
    const w = Math.max(5, bb[2] - bb[0]), hh = Math.max(5, bb[3] - bb[1]);
    const s = Math.min(W / (w * 1.4), H / (hh * 1.4), 200);
    t.view = { s, px: W / 2 - (bb[0] + bb[2]) / 2 * s, py: H / 2 - (bb[1] + bb[3]) / 2 * s }; t.fitted = true; this.paint(); this.renderStatus();
  }
  zoomAt(f: number, cx?: number, cy?: number): void {
    const v = this.view(); if (!this.cv) return;
    const r = this.cv.getBoundingClientRect(); const x = cx === undefined ? r.width / 2 : cx - r.left, y = cy === undefined ? r.height / 2 : cy - r.top;
    const s = Math.min(2000, Math.max(0.5, v.s * f)); v.px = x - (x - v.px) * (s / v.s); v.py = y - (y - v.py) * (s / v.s); v.s = s; this.paint(); this.renderStatus();
  }
  /** ZOOM_TOOL::selectRegion, left button: the dragged box fills the view (a click without a box does nothing). */
  zoomToArea(x0: number, y0: number, x1: number, y1: number): void {
    const v = this.view(); const c = this.cv; if (!c) { this.paint(); return; }
    const w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0); if (w < 1e-9 || hh < 1e-9) { this.paint(); return; }
    const ratio = Math.max(w / (c.clientWidth / v.s), hh / (c.clientHeight / v.s));
    const s = Math.min(2000, Math.max(0.5, v.s / ratio)); const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    v.s = s; v.px = c.clientWidth / 2 - cx * s; v.py = c.clientHeight / 2 - cy * s; this.paint(); this.renderStatus();
  }
  /** The view's KiCad zoom factor (the status bar's Z). */
  kzoom(): number { return this.view().s / 12; }
  resize(): void {
    const c = this.cv; if (!c) return; const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), hh = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  }
  private raf = 0;
  paint(): void { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.paintNow(); }); }
  paintNow(): void {
    const c = this.cv; if (!c || !this.isOpen) return; this.resize();
    const ctx = c.getContext("2d"); if (!ctx) return;
    const t = this.tab; const doc = this.kdoc(); const dpr = window.devicePixelRatio || 1;
    this.el.empty.style.display = doc ? "none" : "flex";
    if (!doc || !t) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = K().SCH.bg; ctx.fillRect(0, 0, c.width, c.height); return; }
    const v = this.view(); const view = { ppm: 1, zoom: v.s, panX: v.px, panY: v.py, x0: 0, y0: 0, dpr };
    const sel = new Set([...t.sel].filter((id) => doc.items.has(id)));
    // the selection shadow is drawn by the canvas pass, under the items (SCH_PAINTER's LAYER_SELECTION_SHADOWS)
    K().render(doc, ctx, view, { grid: this.showGrid ? this.gridMm : 0, gridAxes: true, frame: false, showHiddenPins: this.showHiddenPins, selected: sel.size ? sel : undefined } as KRenderOpts);
    const s = K().setViewTransform(ctx, view);
    // the symbol anchor (LAYER_SCHEMATIC_ANCHOR cross at the origin)
    const a = 6 * dpr / s; ctx.strokeStyle = ANCHOR; ctx.lineWidth = dpr / s; ctx.beginPath(); ctx.moveTo(-a, 0); ctx.lineTo(a, 0); ctx.moveTo(0, -a); ctx.lineTo(0, a); ctx.stroke();
    if (this.drag && this.drag.mode === "zoom") {   // KIGFX::PREVIEW::SELECTION_AREA of ZOOM_TOOL::selectRegion
      const [x0, y0] = [this.drag.x0, this.drag.y0], [x1, y1] = [this.mouse.x, this.mouse.y];
      ctx.save(); ctx.lineWidth = dpr / s; ctx.strokeStyle = "#4F9CFF"; ctx.fillStyle = "rgba(79,156,255,.12)";
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.restore();
    }
    if (this.drag && this.drag.mode === "band") {
      const [x0, y0] = [this.drag.x0, this.drag.y0], [x1, y1] = [this.mouse.x, this.mouse.y];
      ctx.save(); ctx.lineWidth = dpr / s; ctx.strokeStyle = x1 >= x0 ? "#4F9CFF" : "#4FCF6F"; ctx.setLineDash(x1 >= x0 ? [] : [4 / s, 3 / s]);
      ctx.fillStyle = x1 >= x0 ? "rgba(79,156,255,.12)" : "rgba(79,207,111,.12)"; ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.restore();
    }
    // the cursor on the snapped grid point (KIGFX::CURSOR): small crosshairs, full-window, or full-window at 45 degrees
    if (this.mouse.in) {
      const [fx, fy] = this.snapFile(this.mouse.x, this.mouse.y); const cx = fx, cy = -fy;
      const r = this.crosshair === "small" ? 8 * dpr / s : (c.width + c.height) / s;
      ctx.strokeStyle = K().SCH.cursor || "#000"; ctx.lineWidth = dpr / s; ctx.beginPath();
      if (this.crosshair === "45") { ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r); }
      else { ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- DOM
  private build(): void {
    const root = h("div", { class: "se-root", id: "symedit", role: "application", "aria-label": "Symbol Editor" });
    const mb = h("div", { class: "se-menubar", id: "se-menubar" });
    const tbTop = h("div", { class: "se-tb", id: "se-tbTop" });
    const info = h("div", { class: "se-info", id: "se-info" });
    const main = h("div", { class: "se-main" });
    const tbLeft = h("div", { class: "se-tbv se-tbl", id: "se-tbLeft" });
    const tree = h("div", { class: "se-tree", id: "se-tree" });
    const filter = h("input", { type: "search", placeholder: "Filter", id: "se-filter", "aria-label": "Filter" }) as HTMLInputElement;
    filter.addEventListener("input", () => { this.filter = filter.value; this.renderTree(); });
    const list = h("div", { class: "se-list", id: "se-list", tabindex: 0 });
    tree.append(filter, list);
    const centre = h("div", { class: "se-centre" });
    const tabs = h("div", { class: "se-tabs", id: "se-tabs" });
    const cwrap = h("div", { class: "se-canvas", id: "se-canvas", tabindex: 0 });
    const cv = h("canvas", { id: "se-cv" }) as HTMLCanvasElement; this.cv = cv;
    const empty = h("div", { class: "se-empty" }, "Select a symbol in the library tree, or create one with File ▸ New Symbol...");
    cwrap.append(cv, empty);
    centre.append(tabs, cwrap);
    const props = h("div", { class: "se-props", id: "se-props" });
    const tbRight = h("div", { class: "se-tbv se-tbr", id: "se-tbRight" });
    main.append(tbLeft, tree, centre, props, tbRight);
    const msg = h("div", { class: "se-msg", id: "se-msg" });
    const status = h("div", { class: "se-status", id: "se-status" });
    root.append(mb, tbTop, info, main, msg, status);
    this.root = root;
    this.el = { mb, tbTop, info, tbLeft, tree, list, tabs, cwrap, props, tbRight, msg, status, empty, filter };
    this.hookCanvas(cwrap, cv);
    new ResizeObserver(() => this.paint()).observe(cwrap);
  }
  renderAll(): void { this.renderMenus(); this.renderToolbars(); this.renderInfo(); this.renderTree(); this.renderTabs(); this.renderMsg(); this.renderStatus(); this.paint(); }

  // menus ----------------------------------------------------------------
  private act(id: string, run?: () => void, opts: { enabled?: () => boolean; check?: () => boolean; label?: string } = {}): MenuEntry {
    const m = meta(id); return { id, label: opts.label || m.label, icon: m.icon, key: m.key, run, enabled: run ? opts.enabled || (() => true) : () => false, check: opts.check };
  }
  menus(): [string, MenuEntry[]][] {
    const S: MenuEntry = { sep: true };
    const has = () => !!this.symbol(); const can = () => has() && !this.readOnly();
    const fromSch = () => !!(this.tab && this.tab.origin);
    const A = this.actions();
    const a = (id: string, enabled?: () => boolean, check?: () => boolean, label?: string): MenuEntry => this.act(id, A[id], { enabled, check, label });
    const link = (id: string): MenuEntry => { const m = meta(id); return { id, label: m.label !== id ? m.label : (LOCAL_LABELS[id] || id), icon: m.icon, run: () => { window.open(LINKS[id], "_blank", "noopener"); }, enabled: () => !!LINKS[id] }; };
    return [
      ["File", [a("newLibrary", () => !E.viewOnly), a("addLibrary", () => !E.viewOnly), a("saveLibraryAs", () => !!this.currentLib()), a("newSymbol", () => !E.viewOnly), a("editLibSymbolWithLibEdit", fromSch, undefined, "Open Symbol from Library"), S,
        a("save", () => has() || !!this.currentLib()), a("saveSymbolAs", has), a("saveSymbolCopyAs", has), ...(fromSch() ? [] : [a("saveAll", () => this.projectLibs().some((l) => l.doc && l.doc.isModified))]), a("revert", () => !!this.tab && !(this.tab.scratch && !this.tab.origin) && this.isModified(this.tab)), S,
        { label: "Import", sub: [a("importSymbol", () => !E.viewOnly, undefined, "Symbol..."), a("importGraphics", undefined, undefined, "Graphics...")] },
        { label: "Export", sub: [a("exportSymbol", has, undefined, "Symbol..."), a("exportSymbolView", has, undefined, "View as PNG..."), a("exportSymbolAsSVG", has, undefined, "Symbol as SVG...")] }, S,
        a("compareLibraryWithFile"), S, a("symbolProperties", has), S, { label: "Close", icon: "exit", tip: "Close Symbol Editor", key: "Ctrl+W", run: () => void this.close(), enabled: () => true }]],
      ["Edit", [a("undo", () => !!this.tab && this.tab.undo.length > 0 && !this.readOnly()), a("redo", () => !!this.tab && this.tab.redo.length > 0 && !this.readOnly()), S,
        a("cut", () => can() && this.tab!.sel.size > 0), a("copy", () => has() && this.tab!.sel.size > 0), a("copyAsText", () => has() && this.tab!.sel.size > 0), a("paste", () => can() && !!this.clip), a("doDelete", () => can() && this.tab!.sel.size > 0), a("duplicate", () => can() && this.tab!.sel.size > 0), S,
        a("selectAll", has), a("unselectAll", has), S, a("find", has), a("findAndReplace", has), S, a("pinTable", has), a("editSymbolPinMaps", () => can() && !M.isDerived(this.symbol()!)), a("updateSymbolFields", () => can() && M.isDerived(this.symbol()!))]],
      ["View", [{ label: "Panels", sub: [a("showProperties", () => true, () => this.showProps), a("showLibraryTree", () => true, () => this.showTree)] }, S, a("showSymbolBrowser"), S,
        a("zoomInCenter"), a("zoomOutCenter"), a("zoomFitScreen"), a("zoomTool"), a("zoomRedraw"), S,
        a("showHiddenPins", () => true, () => this.showHiddenPins), a("showHiddenFields", () => true, () => this.showHiddenFields), a("togglePinAltIcons", () => true, () => this.showAltIcons), S,
        a("nextSymbolTab", () => this.tabs.length > 1), a("prevSymbolTab", () => this.tabs.length > 1), a("closeSymbolTab", () => this.tabs.length > 0)]],
      ["Place", ["placeSymbolPin", "placeSymbolText", "drawSymbolTextBox", "drawRectangle", "drawCircle", "drawEllipse", "drawEllipseArc", "drawArc", "drawBezier", "drawSymbolLines", "drawSymbolPolygon"].map((id) => a(id, can, () => TOOL_ACTIONS[id] === this.tool))],
      // Tools > External Plugins (the plugin API runs in the desktop app: its rows stay disabled here)
      ["Tools", [{ label: "External Plugins", icon: "puzzle_piece", sub: [a("pluginsReload"), a("pluginsShowFolder")] }]],
      ["Inspect", [a("showDatasheet", () => has() && !!M.fieldValue(this.symbol()!, "Datasheet")), S, a("checkSymbol", has)]],
      ["Preferences", [a("configurePaths"), a("showSymbolLibTable", () => !!appState.project), a("openPreferences"), S, { label: "Set Language" }]],
      // EDA_BASE_FRAME::AddStandardHelpMenu, with the app's own entries (HELP_MENU)
      ["Help", [link("help"), link("gettingStarted"), a("listHotKeys"), link("getInvolved"), link("donate"), link("reportBug"), S,
        { id: "about", label: LOCAL_LABELS.about || "About", icon: "about", run: () => { const app = window.CollabApp; if (app) app.dispatch({ type: "action", id: "about", anchor: null }); }, enabled: () => true }]],
    ];
  }
  private renderMenus(): void {
    const mb = this.el.mb; mb.innerHTML = "";
    for (const [label, items] of this.menus()) {
      const b = h("div", { class: "se-mb", role: "menuitem", "data-menu": label }, label);
      const openIt = () => { const r = b.getBoundingClientRect(); closeMenus(); b.classList.add("open"); showMenu(r.left, r.bottom, this.menus().find((m) => m[0] === label)![1], 0, { below: r, gap: 0, noFlip: true }); };
      b.addEventListener("click", (ev) => { ev.stopPropagation(); if (b.classList.contains("open")) closeMenus(); else openIt(); });
      b.addEventListener("pointerenter", () => { if (document.querySelector(".se-mb.open") && !b.classList.contains("open")) openIt(); });
      mb.append(b);
    }
    // SYMBOL_EDIT_FRAME::UpdateTitle: the frame's title is "Symbol Editor", whatever symbol is open; the frame
    // closes from File > Close (Ctrl+W), it has no button of its own
    if (!this.hostTitle) this.hostTitle = document.title || "Junction";
    document.title = "Symbol Editor";
  }
  /** The window title the host frame had when the Symbol Editor opened, put back on close. */
  private hostTitle = "";

  // toolbars ---------------------------------------------------------------
  private tbButton(id: string, onTool?: boolean, bind = true): HTMLElement {
    const m = meta(id); const A = this.actions(); const run: (() => void) | undefined = A[id];
    const on = this.toggled(id);
    const b = h("button", { class: "se-btn" + (on ? " on" : "") + (run ? "" : " dim"), "data-act": id, title: m.tip + (m.key ? ` (${keyName(m.key)})` : "") + (run ? "" : " — runs in the KiCad desktop app"), "aria-label": m.label, "aria-pressed": onTool || on || TOGGLES.has(id) || TOOL_ACTIONS[id] ? String(!!on) : undefined }, icon(m.icon));
    if (!run) (b as HTMLButtonElement).disabled = true; else if (bind) b.addEventListener("click", () => { run(); });
    if (run && !this.tbEnabled(id)) { (b as HTMLButtonElement).disabled = true; b.classList.add("dim"); }
    // the grid button's menu (toolbars_symbol_editor.cpp): Edit Grids...
    if (id === "toggleGrid") b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom, [this.act("gridProperties", this.actions().gridProperties, { enabled: () => true })], 0, { below: r, gap: 0 }); });
    return b;
  }
  /**
   * ACTION_TOOLBAR::AddGroup: one button showing the group's current action, a corner triangle, and a palette of the
   * group's actions (ACTION_TOOLBAR_PALETTE) opened by the triangle or a long press; picking one makes it the
   * group's button and runs it.  A toggled action of the group (the active tool, the units) is the one shown.
   */
  private tbGroup(group: string, ids: string[], dock: "top" | "left" | "right"): HTMLElement {
    const on = ids.find((id) => this.toggled(id));
    const cur = on || (ids.includes(this.groupCurrent[group]) ? this.groupCurrent[group] : ids[0]);
    if (on) this.groupCurrent[group] = on;
    const wrap = h("div", { class: "se-group", "data-group": group });
    const btn = this.tbButton(cur);
    const arrow = h("button", { class: "se-garrow", type: "button", tabindex: -1, title: group, "aria-label": group });
    arrow.innerHTML = '<svg viewBox="0 0 6 6"><path d="M6 0V6H0z" fill="currentColor"/></svg>';
    let hold = 0, swallow = false;
    const open = () => {
      closeMenus();
      const pal = h("div", { class: "se-palette" + (dock === "top" ? " col" : ""), role: "menu", "data-group": group });
      for (const id of ids) {
        const b = this.tbButton(id, false, false); b.setAttribute("role", "menuitem");
        const run = this.actions()[id];
        if (run && !(b as HTMLButtonElement).disabled) b.addEventListener("click", (ev) => { ev.stopPropagation(); close(); this.groupCurrent[group] = id; run(); this.renderToolbars(); });
        pal.append(b);
      }
      document.body.append(pal);
      const r = wrap.getBoundingClientRect(), w = pal.offsetWidth;
      // ACTION_TOOLBAR::popupPalette: under a top toolbar, beside a left one, to the left of a right one
      const at = dock === "left" ? { x: r.right + 6, y: r.top } : dock === "right" ? { x: r.left - w - 6, y: r.top } : { x: r.left - 4, y: r.bottom + 2 };
      fitMenu(pal, { at });
      const down = (ev: PointerEvent) => { if (!pal.contains(ev.target as Node)) close(); };
      const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); close(); } };
      function close() { pal.remove(); document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); }
      setTimeout(() => document.addEventListener("pointerdown", down, true), 0); document.addEventListener("keydown", key, true);
    };
    arrow.addEventListener("click", (ev) => { ev.stopPropagation(); open(); });
    btn.addEventListener("pointerdown", (ev) => { if (ev.button !== 0) return; swallow = false; clearTimeout(hold); hold = window.setTimeout(() => { swallow = true; open(); }, 500); });
    btn.addEventListener("pointerup", () => clearTimeout(hold)); btn.addEventListener("pointerleave", () => clearTimeout(hold));
    btn.addEventListener("click", (ev) => { if (swallow) { swallow = false; ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
    wrap.append(btn, arrow);
    return wrap;
  }
  /** ACTION_CONDITIONS::Enable of the toolbar buttons that have one. */
  private tbEnabled(id: string): boolean {
    if (id === "toggleSyncedPinsMode") return this.multiUnitMode();
    return true;
  }
  private toggled(id: string): boolean {
    const am = ARC_MODE_ACTIONS.indexOf(id); if (am >= 0) return this.tool === "arc" && this.arcMode === am;
    if (TOOL_ACTIONS[id]) return this.tool === TOOL_ACTIONS[id];
    switch (id) {
      case "showElectricalTypes": return this.showETypes; case "showHiddenPins": return this.showHiddenPins; case "showHiddenFields": return this.showHiddenFields; case "togglePinAltIcons": return this.showAltIcons;
      case "showLibraryTree": return this.showTree; case "showProperties": return this.showProps; case "toggleSyncedPinsMode": return this.synchronizePins(); case "toggleGrid": return this.showGrid;
      case "toggleGridOverrides": return prefs().grids.sym.overrides.enabled;
      case "cursorSmallCrosshairs": return this.crosshair === "small"; case "cursorFullCrosshairs": return this.crosshair === "full"; case "cursor45Crosshairs": return this.crosshair === "45";
      case "millimetersUnits": return this.units === "mm"; case "milsUnits": return this.units === "mil"; case "inchesUnits": return this.units === "in";
    }
    return false;
  }
  renderToolbars(): void {
    if (!this.root) return;
    const spec = (window as unknown as { KiCadUiToolbars?: Record<string, Record<string, unknown[]>> }).KiCadUiToolbars;
    const tb = spec && spec.symedit;
    const fill = (host: HTMLElement, list: unknown[] | undefined, fallback: string[]) => {
      host.innerHTML = "";
      const items = list && list.length ? list : fallback.map((id) => (id === "|" ? { sep: true } : { id }));
      for (const raw of items as { id?: string; sep?: boolean; group?: string; items?: { id: string }[]; control?: string }[]) {
        if (raw.sep) host.append(h("span", { class: "se-sep" }));
        else if (raw.control) { const c = this.control(raw.control); if (c) host.append(c); }
        else if (raw.group && raw.items) host.append(this.tbGroup(raw.group, raw.items.map((it) => it.id), host === this.el.tbTop ? "top" : host === this.el.tbLeft ? "left" : "right"));
        else if (raw.id) host.append(this.tbButton(raw.id));
      }
    };
    fill(this.el.tbTop, tb && tb.top, ["newSymbol", "saveAll", "save", "|", "undo", "redo", "|", "zoomRedraw", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "|", "rotateCCW", "rotateCW", "mirrorV", "mirrorH", "|", "symbolProperties", "pinTable", "|", "showDatasheet", "checkSymbol"]);
    fill(this.el.tbLeft, tb && tb.left, ["toggleGrid", "|", "showElectricalTypes", "showHiddenPins", "showHiddenFields", "|", "showLibraryTree", "showProperties"]);
    fill(this.el.tbRight, tb && tb.right, ["selectionTool", "|", "placeSymbolPin", "placeSymbolText", "drawRectangle", "drawCircle", "drawArc", "drawBezier", "drawSymbolLines", "drawSymbolPolygon", "placeSymbolAnchor", "deleteTool"]);
    this.el.tree.classList.toggle("hide", !this.showTree); this.el.props.classList.toggle("hide", !this.showProps);
    this.renderProps();
  }
  private control(name: string): HTMLElement | null {
    const sym = this.symbol(); const t = this.tab;
    if (name === "unitSelector") {
      const n = sym ? M.unitCount(this.rootSym(sym)) : 1;
      const s = h("k-select", { id: "se-unit", "aria-label": "Unit", disabled: !sym || n < 2 }) as HTMLSelectElement;
      const names = sym && n > 1 ? M.unitChoices(this.rootSym(sym)) : [""];   // one unit: an empty entry, as KiCad
      names.forEach((label, i) => s.append(h("option", { value: String(i + 1) }, label)));
      if (t) s.value = String(t.unit); s.addEventListener("change", () => this.setUnit(Number(s.value)));
      return s;
    }
    if (name === "bodyStyleSelector") {
      const b = sym ? M.bodyStyles(this.rootSym(sym)) : { count: 1, demorgan: false, names: [] as string[] };
      const s = h("k-select", { id: "se-body", "aria-label": "Body style", disabled: !sym || b.count < 2 }) as HTMLSelectElement;
      for (let i = 1; i <= Math.max(1, b.count); i++) s.append(h("option", { value: String(i) }, sym && b.count > 1 ? M.bodyStyleDescription(this.rootSym(sym), i) : ""));
      if (t) s.value = String(t.body); s.addEventListener("change", () => this.setBody(Number(s.value)));
      return s;
    }
    return null;   // ipcScripting
  }
  rootSym(sym: M.Node): M.Node { const t = this.tab; if (!t || t.scratch) return sym; return M.rootOf(this.libMap(this.libs.get(t.lib) || null), sym); }

  // infobar --------------------------------------------------------------
  renderInfo(): void {
    const el = this.el.info; if (!el) return; el.innerHTML = ""; el.classList.remove("show");
    const t = this.tab; const sym = this.symbol(); if (!t || !sym) return;
    const show = (text: string, link?: [string, () => void]) => { el.append(h("span", null, text)); if (link) el.append(h("a", { onclick: link[1] }, link[0])); el.classList.add("show"); };
    const lib = this.libs.get(t.lib);
    if (t.origin) show(`Editing ${t.origin.ref || t.name} from schematic.  Saving will update the schematic only.`, [`Open symbol from library ${t.origin.libId}`, () => void this.editLibrarySymbol(t.origin!.libId)]);
    else if (M.isDerived(sym)) show(`Symbol ${t.name} is a derived symbol. Symbol graphics will not be editable.`, [`Open ${M.parentNameOf(sym)}`, () => void this.loadSymbol(t.lib, M.parentNameOf(sym)!)]);
    else if (lib && lib.kind === "official") show("Library is read-only.  Changes cannot be saved to this library.", ["Create an editable copy", () => void D.editableCopy(this)]);
    else if (lib && lib.doc && lib.doc.loaded && !lib.doc.canEdit) show("Library is read-only.  Changes cannot be saved to this library.");
  }

  // library tree -----------------------------------------------------------
  currentLib(): Lib | null {
    const n = this.treeSel ? this.treeSel.lib : this.tab && !this.tab.origin ? this.tab.lib : null;
    return n ? this.libs.get(n) || null : null;
  }
  /** SYMBOL_TREE_SYNCHRONIZING_ADAPTER: pinned libraries first ("☆ "), " *" and bold on modified libraries and
   *  symbols, derived symbols in italics, the on-canvas symbol (or its collapsed library) outlined, every
   *  multi-unit symbol with its units as children; a click selects, a double-click or the twist expands. */
  renderTree(): void {
    const list = this.el.list; if (!list) return;
    const q = this.filter.trim().toLowerCase(); const t = this.tab;
    const frag = document.createDocumentFragment();
    const pinned = this.pinnedLibs();
    const libs = [...this.libs.values()].sort((a, b) => (pinned.has(a.nick) !== pinned.has(b.nick) ? (pinned.has(a.nick) ? -1 : 1) : a.kind === b.kind ? a.nick.localeCompare(b.nick) : a.kind === "project" ? -1 : 1));
    const onCanvas = t && !t.origin ? { lib: t.lib, name: t.name } : null;
    for (const lib of libs) {
      const rows = lib.kind === "project" || lib.rows ? this.rowsOf(lib) : lib.rows || [];
      const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)) : rows;
      if (q && !hits.length && !lib.nick.toLowerCase().includes(q)) continue;
      const open = lib.open || (!!q && hits.length > 0);
      const modified = !!lib.doc && lib.doc.loaded && lib.doc.isModified;
      const isSel = this.treeSel && this.treeSel.lib === lib.nick && !this.treeSel.name;
      const canvasLib = !!onCanvas && onCanvas.lib === lib.nick && !open;
      const note = lib.error ? "(failed to load) " + lib.error : lib.kind === "official" ? "(read-only)" : lib.loading ? "loading…" : "";
      const tw = h("span", { class: "tw" }, open ? "▾" : "▸");
      const row = h("div", { class: "se-row lib" + (modified ? " mod" : "") + (lib.error ? " dis" : "") + (isSel ? " cur" : ""), "data-lib": lib.nick, title: lib.kind === "official" ? "KiCad library (read-only)" : lib.doc ? lib.doc.path : "" },
        tw, h("span", { class: "nm" + (canvasLib ? " canvas" : "") }, (pinned.has(lib.nick) ? "☆ " : "") + lib.nick + (modified ? " *" : "")), note ? h("span", { class: "ds" }, note) : null);
      const toggle = () => { lib.open = !open; if (lib.open && lib.kind === "official") void this.loadOfficial(lib); this.renderTree(); };
      tw.addEventListener("click", (ev) => { ev.stopPropagation(); this.treeSel = { lib: lib.nick }; toggle(); });
      row.addEventListener("click", () => { this.treeSel = { lib: lib.nick }; this.renderTree(); this.renderMenus(); });
      row.addEventListener("dblclick", () => toggle());
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.treeSel = { lib: lib.nick }; this.renderTree(); showMenu(ev.clientX, ev.clientY, this.treeMenu(lib, null)); });
      frag.append(row);
      if (!open) continue;
      for (const r of hits) {
        const cur = !!onCanvas && onCanvas.lib === lib.nick && onCanvas.name === r.name;
        const sel = this.treeSel && this.treeSel.lib === lib.nick && this.treeSel.name === r.name && this.treeSel.unit === undefined;
        const mod = !!lib.doc && lib.doc.loaded && lib.doc.isSymbolModified(r.name);
        const key = lib.nick + ":" + r.name; const uopen = r.units > 1 && this.symOpen.has(key);
        const stw = h("span", { class: "tw" }, r.units > 1 ? (uopen ? "▾" : "▸") : "");
        const sr = h("div", { class: "se-row" + (sel ? " cur" : "") + (mod ? " mod" : "") + (r.parent ? " der" : ""), "data-sym": key, style: "padding-left:18px", title: r.desc },
          stw, h("span", { class: "nm" + (cur ? " canvas" : "") }, M.unescapeLibId(r.name) + (mod ? " *" : "")), h("span", { class: "ds" }, r.desc));
        const utoggle = () => { if (r.units < 2) return; if (this.symOpen.has(key)) this.symOpen.delete(key); else this.symOpen.add(key); this.renderTree(); };
        stw.addEventListener("click", (ev) => { ev.stopPropagation(); utoggle(); });
        sr.addEventListener("click", () => { this.treeSel = { lib: lib.nick, name: r.name }; this.renderTree(); });
        sr.addEventListener("dblclick", () => void this.loadSymbol(lib.nick, r.name));
        sr.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.treeSel = { lib: lib.nick, name: r.name }; this.renderTree(); showMenu(ev.clientX, ev.clientY, this.treeMenu(lib, r.name)); });
        frag.append(sr);
        if (uopen) for (let u = 1; u <= r.units; u++) {
          const usel = this.treeSel && this.treeSel.lib === lib.nick && this.treeSel.name === r.name && this.treeSel.unit === u;
          const label = (r.unitNames && r.unitNames[u - 1]) || `Unit ${M.unitLetter(u)}`;
          const ur = h("div", { class: "se-row unit" + (usel ? " cur" : ""), "data-unit": key + ":" + u, style: "padding-left:36px" }, h("span", { class: "nm" }, label));
          ur.addEventListener("click", () => { this.treeSel = { lib: lib.nick, name: r.name, unit: u }; this.renderTree(); });
          // LIB_TREE activation of a unit: the symbol opens on that unit
          ur.addEventListener("dblclick", () => void (async () => { if (cur || (await this.loadSymbol(lib.nick, r.name))) this.setUnit(u); })());
          frag.append(ur);
        }
      }
      if (lib.kind === "project" && lib.doc && lib.doc.loaded && !rows.length && !q) frag.append(h("div", { class: "se-row", style: "padding-left:18px;color:var(--ink-3)" }, "(empty)"));
    }
    if (this.officialFailed && !q) frag.append(h("div", { class: "se-row", style: "color:var(--ink-3);white-space:normal" }, this.officialFailed));
    list.innerHTML = ""; list.append(frag);
  }
  /** Pinned libraries (LIB_TREE_MODEL_ADAPTER pinned_symbol_libs), kept for this viewer. */
  pinnedLibs(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem("kui.symedit.pinned") || "[]") as string[]); } catch { return new Set(); } }
  private setPinned(nick: string, on: boolean): void {
    const p = this.pinnedLibs(); if (on) p.add(nick); else p.delete(nick);
    try { localStorage.setItem("kui.symedit.pinned", JSON.stringify([...p])); } catch { /* no storage */ }
    this.renderTree();
  }
  /** The library tree's menu (symedit/ctxmenu.ts symTreeMenu): rows whose condition is false are hidden. */
  private treeMenu(lib: Lib, name: string | null): MenuEntry[] {
    const proj = lib.kind === "project" && !!lib.doc && lib.doc.canEdit && !E.viewOnly;
    const row = name ? this.rowsOf(lib).find((r) => r.name === name) || (lib.rows || []).find((r) => r.name === name) : null;
    const pinned = this.pinnedLibs().has(lib.nick);
    const ids = symTreeMenu({ libSelected: !name, libInferred: true, symbolSelected: !!name, derived: !!row && !!row.parent, allPinned: !name ? pinned : true, allUnpinned: !name ? !pinned : true });
    const runs: Record<string, [() => void, (() => boolean)?]> = {
      newSymbol: [() => void D.newSymbol(this), () => proj],
      deriveFromExistingSymbol: [() => void D.newSymbol(this, name || undefined), () => proj],
      save: [() => void this.saveLib(lib), () => proj && !!lib.doc && (name ? lib.doc.isSymbolModified(name) : lib.doc.isModified)],
      saveLibraryAs: [() => void D.saveLibraryAs(this, lib), () => !E.viewOnly],
      saveSymbolAs: [() => void this.withSymbol(lib, name!, () => D.saveSymbolAs(this, false))],
      saveSymbolCopyAs: [() => void this.withSymbol(lib, name!, () => D.saveSymbolAs(this, true))],
      revert: [() => void (name ? this.revertSymbol(lib, name) : this.revertLib(lib)), () => proj && !!lib.doc && (name ? lib.doc.isSymbolModified(name) : lib.doc.isModified)],
      importSymbol: [() => void D.importSymbol(this, lib), () => proj],
      exportSymbol: [() => void this.withSymbol(lib, name!, () => D.exportSymbol(this))],
      cutSymbol: [() => { this.copySymbol(lib, name!); void this.deleteSymbol(lib, name!); }, () => proj],
      copySymbol: [() => this.copySymbol(lib, name!)],
      pasteSymbol: [() => void this.pasteSymbol(lib), () => proj && !!this.clip],
      duplicateSymbol: [() => void this.duplicateSymbol(lib, name!), () => proj],
      deleteSymbol: [() => void this.deleteSymbol(lib, name!), () => proj],
      renameSymbol: [() => void D.renameSymbol(this, lib, name!), () => proj],
      symbolProperties: [() => void this.withSymbol(lib, name!, () => D.symbolProperties(this))],
      flattenSymbol: [() => void this.flattenSymbol(lib, name!), () => proj],
      pinLibrary: [() => this.setPinned(lib.nick, true), () => !name],
      unpinLibrary: [() => this.setPinned(lib.nick, false), () => !name],
      hideLibraryTree: [() => { this.showTree = false; this.renderToolbars(); this.paint(); }],
    };
    return ids.map((id): MenuEntry => { if (id === "-") return { sep: true }; const r = runs[id]; return this.act(id, r ? r[0] : undefined, { enabled: r && r[1] ? r[1] : () => true }); });
  }
  /** SYMBOL_EDITOR_CONTROL::FlattenSymbol: the derived symbol becomes a root symbol in its library buffer. */
  async flattenSymbol(lib: Lib, name: string): Promise<void> {
    const doc = lib.doc; if (!doc || !doc.canEdit) return;
    const s = doc.lib.symbols.get(name); if (!s || !M.isDerived(s)) return;
    const base = M.text(s); const flat = M.flatten(doc.lib, s);
    try { await doc.commit([[name, M.text(flat), base]]); } catch (e) { void messageBox("Failed to update library with flattened symbol"); return; }
    lib.rows = null; this.kcache = null; this.renderAll();
  }
  private async withSymbol(lib: Lib, name: string, fn: () => unknown): Promise<void> { if (await this.loadSymbol(lib.nick, name)) await fn(); }

  // tabs strip -------------------------------------------------------------
  renderTabs(): void {
    const host = this.el.tabs; if (!host) return; host.innerHTML = "";
    this.tabs.forEach((t, i) => {
      const x = h("span", { class: "x", title: "Close", "aria-label": "Close tab" }, "×");
      const el = h("div", { class: "se-tab" + (i === this.cur ? " cur" : ""), "data-tab": i, title: t.origin ? `${t.name} (from schematic)` : t.lib ? `${t.lib}:${t.name}` : t.name }, (this.isModified(t) ? "*" : "") + (t.origin ? t.origin.ref || t.name : M.unescapeLibId(t.name)), x);
      el.addEventListener("click", (ev) => { if (ev.target === x) { void this.closeTab(i); return; } this.cur = i; this.afterTabChange(); });
      host.append(el);
    });
    host.style.display = this.tabs.length ? "flex" : "none";
    this.renderMenus();
  }

  // properties panel / message panel ------------------------------------------
  /** SCH_PROPERTIES_PANEL: the selection's PROPERTY_MANAGER rows, editable; nothing selected = the symbol itself. */
  renderProps(): void {
    const p = this.el.props; if (!p || !this.showProps) return;
    const keep = p.querySelector<HTMLElement>(".se-pgrid"); const scroll = keep ? keep.scrollTop : 0;
    p.innerHTML = "";
    const sym = this.symbol(); const t = this.tab; if (!sym || !t) { p.append(h("div", { class: "se-pcap" }, "No objects selected")); return; }
    const root = this.rootSym(sym); const ro = this.readOnly();
    const items: SP.SPItem[] = [];
    for (const id of t.sel) { const n = nodeOf(sym, id); if (!n) continue; const r = n[0] === "property" ? null : M.findRef(sym, n); items.push({ node: n, unit: r ? r.unit : 0, body: r ? r.body : 0 }); }
    const rows = items.length ? SP.sharedRows(items.map((it) => SP.itemRows(root, it))) : SP.symbolRows(sym, root).map((r) => ({ ...r, mixed: false }));
    const title = items.length > 1 ? `${items.length} objects selected` : items.length ? SP.friendlyName(items[0].node) : "Symbol";
    p.append(h("div", { class: "se-pcap", "data-prop-title": "" }, title));
    const grid = h("div", { class: "se-pgrid" }); p.append(grid);
    const commit = (row: SP.SPRow, value: string): void => {
      const ids = [...t.sel]; let ok = true;
      const label = "Edit Properties";   // SCH_PROPERTIES_PANEL::valueChanged
      if (!ids.length) this.edit(label, (s) => { if (SP.setSymbolProp(s, row.name, value)) return; ok = false; return false; });
      else this.edit(label, (s) => {
        const out: M.Node[] = [];
        for (const id of ids) {
          const n = nodeOf(s, id); if (!n) continue; const r = n[0] === "property" ? null : M.findRef(s, n);
          const got = SP.setItemProp(s, { node: n, unit: r ? r.unit : 0, body: r ? r.body : 0 }, row.name, value);
          if (!got) { ok = false; return false; } out.push(got);
        }
        return out;
      });
      if (!ok) this.infoBarError(`Invalid value for ${row.name}`);
      this.renderProps();
    };
    let group = "";
    for (const r of rows) {
      if (r.group !== group) {
        group = r.group; const g = group; const shut = this.propsCollapsed.has(g);
        const head = h("div", { class: "se-pgroup", "data-prop-group": g }, h("span", { class: "tw" }, shut ? "\u25b8" : "\u25be"), g);
        head.addEventListener("click", () => { if (this.propsCollapsed.has(g)) this.propsCollapsed.delete(g); else this.propsCollapsed.add(g); this.renderProps(); });
        grid.append(head);
      }
      if (this.propsCollapsed.has(group)) continue;
      const dis = ro || !!r.readOnly;
      let ed: HTMLElement;
      if (r.type === "bool") {
        const c = h("input", { type: "checkbox", "data-prop": r.name, disabled: dis }) as HTMLInputElement; c.checked = r.value === "1"; c.indeterminate = r.mixed;
        c.addEventListener("change", () => commit(r, c.checked ? "1" : "0")); ed = h("span", { class: "cb" }, c);
      } else if (r.type === "enum") {
        const s = h("k-select", { "data-prop": r.name, disabled: dis, "aria-label": r.name }) as HTMLSelectElement;
        if (r.mixed) s.append(h("option", { value: "" }, ""));
        for (const [k, l] of r.choices || []) s.append(h("option", { value: k }, l));
        s.value = r.value; s.addEventListener("change", () => { if (s.value !== "") commit(r, s.value); }); ed = s;
      } else {
        const len = r.type === "length" || r.type === "coord";
        const shown = r.mixed ? "" : len ? this.fmt(Number(r.value)) : r.value;
        const i = h("input", { type: "text", "data-prop": r.name, value: shown, disabled: dis, spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
        let committed = shown;   // what the row holds now: the shown value, or the text done() last committed
        const done = () => {
          if (i.value === committed) return;
          let v = i.value;
          if (len) { const mm = D.parseLen(v); if (mm === null) { this.infoBarError(`Invalid value for ${r.name}`); i.value = shown; return; } v = M.fmt(mm); }
          else if (r.type === "int") { if (!/^\s*\d+\s*$/.test(v)) { i.value = shown; return; } v = String(parseInt(v, 10)); }
          commit(r, v); committed = i.value;
        };
        i.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(); } else if (ev.key === "Escape") { i.value = shown; i.blur(); } });
        i.addEventListener("change", done); ed = i;
        // SCH_PROPERTIES_PANEL: PG_FPID_EDITOR on Footprint, PG_URL_EDITOR on Datasheet (the symbol editor's selection
        // holds no placed symbol, so the chooser gets no netlist and shows no filter toggles)
        if (!dis && r.group === "Fields" && (r.name === "Footprint" || r.name === "Datasheet")) {
          const isFp = r.name === "Footprint", iconOf = (v: string) => (isFp ? "small_library" : urlIcon(v)), tipOf = (v: string) => (isFp ? FP_BROWSE_TIP : urlTip(v));
          const ic = kicadIcon(iconOf(shown)), b = h("button", { type: "button", class: "se-pbrowse", tabindex: "-1", title: tipOf(shown), "data-prop-browse": r.group + "/" + r.name, "data-icon": iconOf(shown) }, ic) as HTMLButtonElement;
          i.addEventListener("input", () => { setKicadIcon(ic, iconOf(i.value)); b.title = tipOf(i.value); b.dataset.icon = iconOf(i.value); });
          b.addEventListener("pointerdown", (ev) => ev.preventDefault());
          b.addEventListener("click", (ev) => {
            ev.preventDefault(); ev.stopPropagation(); done();
            const cur = r.mixed ? "" : i.value;
            if (!isFp) { if (r.mixed || datasheetLink(cur).kind === "none") void noFileBrowsing("property"); else openDatasheet(cur); return; }
            // the typed text done() just committed is the value to compare the choice with, not the one first shown
            void chooseFootprint(cur, null).then((fp) => { if (fp && fp !== committed) { commit(r, fp); committed = fp; } });
          });
          ed = h("span", { class: "se-pbtn" }, i, b);
        }
      }
      grid.append(h("div", { class: "se-prow" + (dis ? " ro" : ""), "data-prop-row": r.group + "/" + r.name }, h("span", { class: "k", title: r.name }, r.name), h("span", { class: "v" }, ed)));
    }
    grid.scrollTop = scroll;
  }
  renderMsg(): void {
    const el = this.el.msg; if (!el) return; el.innerHTML = "";
    const sym = this.symbol(); const t = this.tab; if (!sym || !t) return;
    const cell = (k: string, v: string) => el.append(h("div", null, h("b", null, k), h("span", null, v)));
    const sel = [...t.sel]; const n = sel.length === 1 ? nodeOf(sym, sel[0]) : null;
    // SCH_ITEM::GetMsgPanelInfo: Unit (a multi-unit symbol), Body Style (a multi-body-style one) and Private
    const root0 = this.rootSym(sym);
    const itemInfo = (node: M.Node) => {
      const ref = M.findRef(sym, node); if (!ref) return;
      if (M.unitCount(root0) > 1) cell("Unit", (SP.unitChoices(root0).find((c) => c[0] === String(ref.unit)) || ["", M.unitLetter(ref.unit)])[1]);
      if (M.bodyStyles(root0).count > 1) cell("Body Style", (SP.bodyChoices(root0).find((c) => c[0] === String(ref.body)) || ["", String(ref.body)])[1]);
      if (node[1] === "private") cell("Private", "");
    };
    if (n && n[0] !== "pin" && n[0] !== "property") { cell("Type", SP.friendlyName(n)); itemInfo(n); this.renderProps(); return; }
    if (n && n[0] === "pin") {
      const i = M.pinInfo(n);
      cell("Type", "Pin"); itemInfo(n); cell("Name", i.name); cell("Number", i.number); cell("Type", D.typeLabel(i.type)); cell("Style", D.shapeLabel(i.shape)); cell("Visible", i.visible ? "Yes" : "No");
      cell("Length", this.fmt(i.length)); cell("Orientation", D.orientLabel(i.orient)); cell("Pos X", this.fmt(i.x)); cell("Pos Y", this.fmt(-i.y || 0));
      this.renderProps(); return;
    }
    const root = this.rootSym(sym); const pw = K().kid(root as unknown as SNode, "power");
    cell("Name", M.symName(sym)); cell("Parent", M.parentNameOf(sym) || "<none>");
    cell("Type", pw ? (K().str(pw[1]) === "local" ? "Power Symbol (Local)" : "Power Symbol") : "Symbol");
    cell("Description", M.fieldValue(sym, "Description")); cell("Keywords", M.fieldValue(sym, "ki_keywords")); cell("Datasheet", M.fieldValue(sym, "Datasheet"));
    this.renderProps();
  }
  renderStatus(): void {
    const el = this.el.status; if (!el) return;
    const [fx, fy] = this.snapFile(this.mouse.x, this.mouse.y);
    const v = this.tab && this.tab.view ? this.tab.view.s : 12;
    if (!el.firstChild) {
      // EDA_DRAW_FRAME::DisplayGridMsg / DisplayUnitsMsg: plain text, the grid is changed from the menus and hotkeys
      el.append(h("span", { id: "se-zoom" }), h("span", { id: "se-xy" }), h("span", { id: "se-dxy" }), h("span", { id: "se-grid" }), h("span", { id: "se-units" }), h("span", { id: "se-tool" }));
    }
    el.querySelector("#se-grid")!.textContent = `grid ${messageText(this.gridMm, this.units, "sch", false)}`;
    el.querySelector("#se-zoom")!.textContent = `Z ${(v / 12).toFixed(2)}`;
    // eeschema shows internal coordinates: Y grows downward (the file's library Y is up)
    el.querySelector("#se-xy")!.textContent = `X ${fmtCoord(fx, this.units, true)}  Y ${fmtCoord(-fy || 0, this.units, true)}`;   // the short form (SCH_IU_PER_MM)
    // dx / dy / dist from the local origin (Space: resetLocalCoords)
    const dx = fx - this.localOrigin[0], dy = -(fy - this.localOrigin[1]) || 0;
    el.querySelector("#se-dxy")!.textContent = `dx ${fmtCoord(dx, this.units, true)}  dy ${fmtCoord(dy, this.units, true)}  dist ${fmtCoord(Math.hypot(dx, dy), this.units, true)}`;
    el.querySelector("#se-units")!.textContent = unitsMsg(this.units);
    el.querySelector("#se-tool")!.textContent = meta(Object.keys(TOOL_ACTIONS).find((k) => TOOL_ACTIONS[k] === this.tool) || "selectionTool").label;
  }

  // ---------------------------------------------------------------- actions
  private _actions: Record<string, (() => void) | undefined> | null = null;
  actions(): Record<string, (() => void) | undefined> {
    if (this._actions) return this._actions;
    const tool = (t: ToolId) => () => this.setTool(t);
    const A: Record<string, (() => void) | undefined> = {
      newLibrary: () => void D.newLibrary(this), addLibrary: () => void D.addLibrary(this),
      openPreferences: () => openPreferences(), showSymbolLibTable: () => void D.manageSymbolLibraries(this),
      showSymbolBrowser: () => void this.symbolBrowser(), saveLibraryAs: () => { const l = this.currentLib(); if (l) void D.saveLibraryAs(this, l); },
      newSymbol: () => void D.newSymbol(this), editLibSymbolWithLibEdit: () => { const t = this.tab; if (t && t.origin) void this.editLibrarySymbol(t.origin.libId); },
      save: () => void this.save(), saveSymbolAs: () => void D.saveSymbolAs(this, false), saveSymbolCopyAs: () => void D.saveSymbolAs(this, true), saveAll: () => void this.saveAll(),
      revert: () => { const t = this.tab; if (t && !t.origin) { const l = this.libs.get(t.lib); if (l) void this.revertSymbol(l, t.name); } else if (t && t.origin) void this.revertScratch(); },
      importSymbol: () => { const l = this.currentLib(); if (l && l.kind === "project") void D.importSymbol(this, l); else void messageBox("Select a project library to import into."); },
      exportSymbol: () => void D.exportSymbol(this), exportSymbolView: () => void D.exportPng(this), exportSymbolAsSVG: () => void D.exportSvg(this),
      find: () => openSymbolFind(this, false), findAndReplace: () => openSymbolFind(this, true), findNext: () => void findNextMatch(this), findPrevious: () => void findNextMatch(this, true),
      symbolProperties: () => void D.symbolProperties(this), updateSymbolFields: () => D.updateSymbolFields(this), editSymbolPinMaps: () => { this.cancelInteraction(); if (this.tab) { this.tab.sel.clear(); this.selChanged(); } D.symbolProperties(this, { pinMaps: true }); },
      undo: () => this.undo(), redo: () => this.redo(),
      cut: () => { this.copySel(); this.deleteSel("Delete"); }, copy: () => this.copySel(), copyAsText: () => this.copySel(true), paste: () => this.paste(), doDelete: () => this.deleteSel(), duplicate: () => this.duplicateSel(),
      selectAll: () => this.selectAll(), unselectAll: () => { if (this.tab) { this.tab.sel.clear(); this.selChanged(); } },
      pinTable: () => void D.pinTable(this),
      showProperties: () => { this.showProps = !this.showProps; this.renderToolbars(); this.paint(); }, showLibraryTree: () => { this.showTree = !this.showTree; this.renderToolbars(); this.paint(); },
      zoomInCenter: () => this.zoomAt(1.3), zoomOutCenter: () => this.zoomAt(1 / 1.3), zoomFitScreen: () => this.zoomFit(), zoomRedraw: () => { this.kcache = null; this.paint(); },
      showHiddenPins: () => { this.showHiddenPins = !this.showHiddenPins; this.kcache = null; this.renderToolbars(); this.paint(); },
      showHiddenFields: () => { this.showHiddenFields = !this.showHiddenFields; this.kcache = null; this.renderToolbars(); this.paint(); },
      showElectricalTypes: () => { this.showETypes = !this.showETypes; this.kcache = null; this.renderToolbars(); this.paint(); },
      togglePinAltIcons: () => { this.showAltIcons = !this.showAltIcons; this.kcache = null; this.renderToolbars(); this.paint(); },
      toggleSyncedPinsMode: () => { if (!this.multiUnitMode()) return; this.syncPins = !this.syncPins; this.renderToolbars(); },
      nextSymbolTab: () => { if (this.tabs.length) { this.cur = (this.cur + 1) % this.tabs.length; this.afterTabChange(); } },
      prevSymbolTab: () => { if (this.tabs.length) { this.cur = (this.cur - 1 + this.tabs.length) % this.tabs.length; this.afterTabChange(); } },
      closeSymbolTab: () => { if (this.cur >= 0) void this.closeTab(this.cur); },
      showDatasheet: () => { const s = this.symbol(); const ds = s ? M.fieldValue(s, "Datasheet") : ""; if (ds && ds !== "~") window.open(/^[a-z]+:/i.test(ds) ? ds : "https://" + ds, "_blank", "noopener"); },
      checkSymbol: () => void D.checker(this),
      rotateCCW: () => this.transformSel("Rotate", (n, c) => M.rotateNode(n, c[0], c[1], true)), rotateCW: () => this.transformSel("Rotate", (n, c) => M.rotateNode(n, c[0], c[1], false)),
      mirrorV: () => this.transformSel("Mirror", (n, c) => M.mirrorNode(n, c[0], c[1], false)), mirrorH: () => this.transformSel("Mirror", (n, c) => M.mirrorNode(n, c[0], c[1], true)),
      addSymbolToSchematic: () => void D.addToSchematic(this),
      toggleGrid: () => { this.showGrid = !this.showGrid; saveViewPref("grid", this.showGrid); this.renderToolbars(); this.paint(); },
      toggleGridOverrides: () => { const p = clonePrefs(); p.grids.sym.overrides.enabled = !p.grids.sym.overrides.enabled; savePrefs(p); this.renderToolbars(); this.paint(); },
      cursorSmallCrosshairs: () => this.setCrosshair("small"), cursorFullCrosshairs: () => this.setCrosshair("full"), cursor45Crosshairs: () => this.setCrosshair("45"),
      millimetersUnits: () => this.setUnits("mm"), milsUnits: () => this.setUnits("mil"), inchesUnits: () => this.setUnits("in"),
      toggleUnits: () => this.setUnits(this.units === "mm" ? (E.lastImperial === "in" ? "in" : "mil") : "mm"),
      properties: () => this.editSelected(), repeatDrawItem: () => this.repeat(),
      pushPinLength: () => this.pushPin("length"), pushPinNameSize: () => this.pushPin("nameSize"), pushPinNumSize: () => this.pushPin("numSize"),
      move: () => this.startCarry("Move"), drag: () => this.startCarry("Move"),
      listHotKeys: () => void D.hotkeys(),
      cancelInteractive: () => this.cancelInteraction(),
      // COMMON_TOOLS: grids (GRID_SETTINGS last_size_idx; fast_grid_1 / fast_grid_2 default to indexes 1 and 2), pan, local origin
      gridNext: () => this.setGridIdx(this.gridIdx() + 1), gridPrev: () => this.setGridIdx(this.gridIdx() - 1),
      gridFast1: () => this.setGridIdx(prefs().grids.sym.fast1), gridFast2: () => this.setGridIdx(prefs().grids.sym.fast2),
      gridFastCycle: () => { const g = prefs().grids.sym; this.setGridIdx(this.gridIdx() === g.fast1 ? g.fast2 : g.fast1); },
      // COMMON_TOOLS::GridProperties: Preferences on the Symbol Editor's Grids page
      gridProperties: () => openPreferences(GRID_PAGE.sym),
      panUp: () => this.pan(0, -1), panDown: () => this.pan(0, 1), panLeft: () => this.pan(-1, 0), panRight: () => this.pan(1, 0),
      resetLocalCoords: () => { this.localOrigin = this.snapFile(this.mouse.x, this.mouse.y); this.renderStatus(); },
      libraryTreeSearch: () => { if (!this.showTree) { this.showTree = true; this.renderToolbars(); this.paint(); } const f = this.el.filter as HTMLInputElement | undefined; if (f) { f.focus(); f.select(); } },
      finishInteractive: () => { if (this.draw) this.finishDraw(); },
      deleteLastPoint: () => this.deleteLastPoint(),
      alignToGrid: () => this.alignToGrid(), swap: () => this.swapSel(),
      convertStackedPins: () => this.convertStacked(), explodeStackedPin: () => this.explodeStacked(),
    };
    for (const [id, t] of Object.entries(TOOL_ACTIONS)) A[id] = tool(t);
    // SCH_ACTIONS::drawArcCenter … drawArcStartDirEnd: Draw Arcs in that mode (drawArc keeps the mode last used)
    ARC_MODE_ACTIONS.forEach((id, m) => { A[id] = () => { this.arcMode = m; setArcDrawMode(m); if (this.draw && this.draw.kind === "arc") { this.draw = null; this.preview = null; this.kcache = null; } this.setTool("arc"); this.renderToolbars(); }; });
    return (this._actions = A);
  }
  /** COMMON_TOOLS::CursorSmallCrosshairs / CursorFullCrosshairs / Cursor45Crosshairs. */
  setCrosshair(m: "small" | "full" | "45"): void { this.crosshair = m; saveViewPref("crosshair", m); this.renderToolbars(); this.paint(); }
  /** COMMON_TOOLS::GridNext / GridPrev / GridPreset: the index wraps around the grid list. */
  setGridIdx(i: number): void {
    const l = symGrids(), n = l.length; if (!n) return; const k = ((i % n) + n) % n;
    this.setGrid(l[k]);
  }
  /** COMMON_TOOLS::GridPreset: the grid picked from the Grid menu, remembered as the window's grid.last_size. */
  setGrid(mm: number): void { this.gridMm = mm; rememberGrid(mm, "sym"); this.renderStatus(); this.paint(); }
  gridIdx(): number { return symGrids().findIndex((mm) => Math.abs(mm - this.gridMm) < 1e-9); }
  /** Preferences saved: the grid list may have changed; the window's grid.last_size is the grid in use. */
  private prefsHook = (): void => { if (!this.isOpen) return; const mm = defaultGrid("sym"); if (Math.abs(mm - this.gridMm) > 1e-9) { this.gridMm = mm; this.renderStatus(); this.paint(); } };
  /** GRID_MENU (EDA_DRAW_FRAME::AddStandardSubMenus): every grid as GRID_MENU::BuildChoiceList writes it, the one in use checked. */
  private gridMenu(): MenuEntry {
    const u = this.units, li = (E.lastImperial === "in" ? "in" : "mil") as Units;
    return { label: "Grid", icon: "grid_select", sub: gridDefs(prefs().grids.sym).map((g) => ({ label: gridChoiceText(g, u, li, "sch"), check: () => Math.abs(g.mm - this.gridMm) < 1e-9, enabled: () => true, run: () => this.setGrid(g.mm) })) };
  }
  /** COMMON_TOOLS::PanControl: the view centre moves by ten grid steps. */
  pan(dx: number, dy: number): void {
    const v = this.view(); const d = this.gridMm * 10 * v.s;
    v.px -= dx * d; v.py -= dy * d; this.paint(); this.renderStatus();
  }
  /**
   * ACTIONS::deleteLastPoint (Backspace, also doDelete's alternate) while a multi-point shape is being drawn: the
   * arc / Bezier / elliptical-arc sessions take back their last point (EE_GRAPHIC_TOOL's RemoveLastPoint); the
   * rectangle / circle / polyline tool (DrawShape) has no handler for it.
   */
  deleteLastPoint(): void {
    const d = this.draw; if (!d) return;
    if (d.kind !== "arc" && d.kind !== "bezier" && d.kind !== "ellipse_arc") return;
    d.pts.pop();
    if (!d.pts.length) { this.cancelInteraction(); return; }
    this.drawPreview(); this.paint();
  }
  /** View > Symbol Library Browser (SYMBOL_VIEWER_FRAME): browse every library; its Add Symbol to Schematic places the pick on the schematic. */
  private async symbolBrowser(): Promise<void> {
    type Chosen = { libId?: string; item: { id: string }; symbol?: string; fields?: unknown; unit?: number; keep?: boolean; allUnits?: boolean };
    const L = (window as unknown as { KiCadLibrary?: { openChooser(kind: "symbol", o?: { browser?: boolean; title?: string }): Promise<Chosen | null>; placeSymbol(o: Record<string, unknown>): Promise<unknown> } }).KiCadLibrary;
    if (!L) return;
    const r = await L.openChooser("symbol", { browser: true }); if (!r) return;
    await this.close(); if (this.isOpen) return;
    await L.placeSymbol({ libId: r.libId || r.item.id, symbol: r.symbol || "", fields: r.fields, unit: r.unit, keep: r.keep, allUnits: r.allUnits }).catch((e: Error) => messageBox(e.message));
  }
  /** EDA_DRAW_FRAME::ChangeUserUnits: kept as symbol_editor's system.units and system.last_imperial_units. */
  setUnits(u: Units): void { E.units = u; if (u !== "mm") E.lastImperial = u; saveUnits("symbol_editor", { units: u, lastImperial: (E.lastImperial === "in" ? "in" : "mil") as Units }); this.renderToolbars(); this.renderMsg(); this.renderStatus(); }
  setTool(t: ToolId): void {
    if (t !== "select" && t !== "zoom" && this.readOnly()) { this.readOnlyNotice(); return; }
    const sym = this.symbol();
    if (t !== "select" && t !== "pin" && t !== "anchor" && t !== "delete" && t !== "zoom" && sym && M.isDerived(sym)) { void messageBox(`Symbol ${M.symName(sym)} is a derived symbol. Symbol graphics will not be editable.`); return; }
    this.cancelInteraction(); this.tool = t; this.renderToolbars(); this.renderStatus();
    // SYMBOL_EDITOR_DRAWING_TOOLS / PIN_TOOL / SCH_TOOL_BASE: TEXT for text, BULLSEYE for the anchor, REMOVE for delete, PENCIL for shapes
    if (this.el.cwrap) this.el.cwrap.style.cursor = toolCursor(t === "select" ? "ARROW" : t === "zoom" ? "ZOOM_IN" : t === "text" ? "TEXT" : t === "anchor" ? "BULLSEYE" : t === "delete" ? "REMOVE" : "PENCIL");
  }
  cancelInteraction(): void {
    if (this.carry) { const c = this.carry; this.carry = null; this.preview = null; if (c.amend) { const t = this.tab; const cur = this.symbol(); if (t && cur && t.undo.length) { const step = t.undo.pop()!; this.applyStep(t, cur, step.after, step.before); } } }
    this.drag = null; this.draw = null; this.floating = null; this.preview = null; this.kcache = null; this.paint();
  }
  selChanged(): void { this.renderMsg(); this.renderMenus(); this.paint(); }
  selectAll(): void { const t = this.tab; const doc = this.kdoc(); if (!t || !doc) return; t.sel = new Set([...doc.items.values()].filter((i) => i.movable).map((i) => i.id)); this.selChanged(); }
  /** EE_GRID_HELPER::GetItemGrid for one item, with the grid overrides. */
  private gridFor(n: M.Node): number { const o = prefs().grids.sym.overrides; return o.enabled ? gridPitchFor(SYM_GRID_CLASS[String(n[0])] || null, o, this.gridMm) : this.gridMm; }
  /** SYMBOL_EDITOR_MOVE_TOOL::AlignElements. */
  alignToGrid(): void {
    const t = this.tab; if (!t || !t.sel.size || this.readOnly()) return;
    this.edit("Align Items to Grid", (s) => { const ns = this.selNodes(s); for (const n of ns) M.alignToGrid(n, this.gridFor(n)); return ns; });
  }
  /** SYMBOL_EDITOR_EDIT_TOOL::Swap. */
  swapSel(): void {
    const t = this.tab; if (!t || t.sel.size < 2 || this.readOnly()) return;
    this.edit("Swap", (s) => { const ns = this.selNodes(s); M.swapItems(ns); return ns; });
  }
  convertStacked(): void {
    const t = this.tab; if (!t || this.readOnly()) return; let err: string | null = null;
    this.edit("Convert Stacked Pins", (s) => { err = M.convertStackedPins(s, M.stackCandidates(s, this.selNodes(s))); return err ? false : []; });
    if (err) this.infoBarError(err); else { t.sel.clear(); this.selChanged(); }
  }
  explodeStacked(): void {
    const t = this.tab; if (!t || this.readOnly()) return; const ns0 = this.symbol() ? this.selNodes(this.symbol()!) : [];
    if (ns0.length !== 1 || ns0[0][0] !== "pin") { this.infoBarError("Select a single pin with stacked notation to explode"); return; }
    let err: string | null = null;
    this.edit("Explode Stacked Pin", (s) => { const r = M.explodeStackedPin(s, this.selNodes(s)[0]); if (typeof r === "string") { err = r; return false; } return []; });
    if (err) this.infoBarError(err); else { t.sel.clear(); this.selChanged(); }
  }
  selNodes(sym: M.Node): M.Node[] { const t = this.tab; return t ? [...t.sel].map((id) => nodeOf(sym, id)).filter((n): n is M.Node => !!n) : []; }
  private selCentre(): [number, number] {
    const doc = this.kdoc(); const t = this.tab; let bb: number[] | null = null;
    if (doc && t) for (const id of t.sel) { const it = doc.items.get(id); if (it && it.bbox) bb = bb ? [Math.min(bb[0], it.bbox[0]), Math.min(bb[1], it.bbox[1]), Math.max(bb[2], it.bbox[2]), Math.max(bb[3], it.bbox[3])] : it.bbox.slice(); }
    if (!bb) return [0, 0];
    // a single pin turns about its connection point
    if (t && t.sel.size === 1) { const sym = this.symbol(); const n = sym ? nodeOf(sym, [...t.sel][0]) : null; if (n && n[0] === "pin") { const i = M.pinInfo(n); return [i.x, i.y]; } }
    return this.snapFile((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
  }
  transformSel(label: string, fn: (n: M.Node, c: [number, number]) => void): void {
    const t = this.tab; if (!t || !t.sel.size) return;
    const c = this.selCentre();
    const c0 = this.carry;
    if (c0) { const b = M.node(c0.base); for (const id of c0.ids) { const n = nodeOf(b, id); if (n) fn(n, [c0.sx, c0.sy]); } c0.base = M.text(b); this.carryPreview(); this.paint(); return; }
    this.edit(label, (s) => { const ns = this.selNodes(s); for (const n of ns) fn(n, c); return ns; });
  }
  /**
   * SYMBOL_EDITOR_EDIT_TOOL::DoDelete.  A field is never removed: a visible one is hidden ("Hide Field(s)"), an
   * already hidden one points at the Symbol Properties dialog.  In synchronized pins mode a pin also takes, from
   * every other unit, at most one pin at the same position with the same body style, type and name.
   */
  deleteSel(label = "Delete"): void {
    const t = this.tab; if (!t || !t.sel.size) return;
    let alreadyHidden = 0, hideLabel = "";
    const ok = this.edit(label, (s) => {
      const ns = this.selNodes(s); const doomed = new Set<M.Node>();
      let hidden = 0; alreadyHidden = 0;
      const sync = this.synchronizePins(s);
      for (const n of ns) {
        if (n[0] === "property") { if (!M.isHidden(n)) { M.setHide(n, true); hidden++; } else alreadyHidden++; continue; }
        doomed.add(n);
        if (n[0] === "pin" && sync) {
          const i = M.pinInfo(n); const r = M.findRef(s, n); if (!r) continue;
          const got = new Set<number>([r.unit]);
          for (const d of M.allPins(s)) {
            if (got.has(d.unit) || d.node === n) continue;
            const o = M.pinInfo(d.node);
            if (Math.abs(o.x - i.x) > 1e-6 || Math.abs(o.y - i.y) > 1e-6) continue;
            if (d.body !== r.body || o.type !== i.type || o.name !== i.name) continue;
            doomed.add(d.node); got.add(d.unit);
          }
        }
      }
      for (const n of doomed) { const r = M.findRef(s, n); if (r) M.removeDrawItem(s, r); }
      if (!doomed.size) { if (!hidden) return false; hideLabel = hidden === 1 ? "Hide Field" : "Hide Fields"; }
      return [];
    });
    if (ok && hideLabel) { const st = t.undo[t.undo.length - 1]; if (st) st.label = hideLabel; }
    if (!ok && alreadyHidden > 0) this.infoBarError("Use the Symbol Properties dialog to remove fields.");
  }
  copySel(asText = false): void {
    const sym = this.symbol(); if (!sym) return;
    const items = this.selNodes(sym).filter((n) => n[0] !== "property");
    if (!items.length) return;
    const text = items.map((n) => M.text(n)).join("\n");
    this.clip = text;
    try { void navigator.clipboard.writeText(asText ? text : text); } catch (e) { /* page clipboard only */ }
    this.renderMenus();
  }
  paste(): void {
    const t = this.tab; if (!t || !this.clip) return;
    let nodes: M.Node[] = []; try { nodes = (M.node("(clip " + this.clip + ")").slice(1) as M.Node[]).filter((n) => Array.isArray(n) && (n[0] === "pin" || M.GRAPHIC_KINDS.has(String(n[0])))); } catch (e) { return; }
    if (!nodes.length) return;
    if (this.edit("Paste", (s) => { const out: M.Node[] = []; for (const n of nodes) { const c = M.clone(n); M.addDrawItem(s, n[0] === "pin" ? t.unit : 0, t.body, c); out.push(c); } return out; })) this.startCarry("Paste", true);
  }
  duplicateSel(): void {
    const t = this.tab; const sym = this.symbol(); if (!t || !sym || !t.sel.size) return;
    const step = this.gridMm;
    if (this.edit("Duplicate", (s) => { const out: M.Node[] = []; for (const n of this.selNodes(s)) { if (n[0] === "property") continue; const r = M.findRef(s, n)!; const c = M.clone(n); M.moveNode(c, step, -step); M.addDrawItem(s, r.unit, r.body, c); out.push(c); } return out; })) this.startCarry("Duplicate", true);
  }
  editSelected(): void {
    const t = this.tab; const sym = this.symbol(); if (!t || !sym) return;
    const ids = [...t.sel];
    if (ids.length !== 1) { void D.symbolProperties(this); return; }
    const n = nodeOf(sym, ids[0]); if (!n) return;
    if (n[0] === "pin") void D.editPin(this, ids[0]);
    else if (n[0] === "property") void D.editField(this, ids[0]);
    else if (n[0] === "text" || n[0] === "text_box") void D.editText(this, ids[0]);
    else void D.editShape(this, ids[0]);
  }
  pushPin(what: "length" | "nameSize" | "numSize"): void {
    const t = this.tab; const sym = this.symbol(); if (!t || !sym) return;
    const id = [...t.sel].find((i) => i.startsWith("p:")); if (!id) return;
    const label = what === "length" ? "Push Pin Length" : what === "nameSize" ? "Push Pin Name Size" : "Push Pin Number Size";
    this.edit(label, (s) => { const src = nodeOf(s, id); if (!src) return false; M.pushPinProperty(s, src, what, t.body); return [src]; });
  }
  /** Repeat Pin (Ins): the last placed pin one step on, name and number incremented. */
  repeat(): void {
    const t = this.tab; const last = this.lastRepeat; if (!t || !last || this.readOnly()) return;
    const p = M.repeatPin(last); const sym = this.symbol(); if (!sym) return;
    const go = () => {
      if (this.edit("Repeat Pin", (s) => { const r = M.placePin(s, p, this.synchronizePins(s) && p.unit !== 0); const n = M.itemAt(s, r); return n ? [n] : []; })) this.lastRepeat = p;
    };
    const occ = this.synchronizePins(sym) ? M.occupiedBy(sym, p) : null;
    if (occ !== null) void confirmBox("Confirmation", M.OCCUPIED_MSG(occ) + "\n\n" + M.OCCUPIED_EXT, "Place Pin Anyway").then((ok) => { if (ok) go(); });
    else go();
  }
  /** First click of the pin tool: CreatePin's dialog, then the pin follows the cursor (TwoClickPlace). */
  async placePinAt(fx: number, fy: number): Promise<void> {
    const t = this.tab; const sym = this.symbol(); if (!t || !sym) return;
    const p = M.newPinInfo(fx, fy, this.lastPin, t.unit, t.body);
    const res = await D.pinDialog(this, p, null); if (!res) return;
    M.rememberPin(this.lastPin, res);   // EditPinProperties keeps the g_LastPin* settings on OK
    this.startFloating({ kind: "pin", pin: res });
  }
  /** A new text (or pin) attached to the cursor; Esc drops it, a click places it. */
  startFloating(f: NonNullable<SymbolEditor["floating"]>): void { this.floating = f; this.floatPreview(); this.paint(); }
  private floatPreview(): void {
    const f = this.floating; const sym = this.symbol(); if (!f || !sym) return;
    const [x, y] = this.snapFile(this.mouse.x, this.mouse.y); const s = M.node(M.text(sym));
    if (f.kind === "pin") { const n = M.pinNode({ ...f.pin, x, y }); M.addDrawItem(s, f.pin.unit, f.pin.body, n); }
    else { const n = M.clone(f.node); M.mapPoints(n, () => [x, y]); M.addDrawItem(s, f.unit || 0, f.body, n); }
    this.preview = s; this.kcache = null;
  }
  /** Second click: PlacePin (occupied-position check in sync mode, image pins) or the text added, as one undo step. */
  private async placeFloating(fx: number, fy: number): Promise<void> {
    const f = this.floating; if (!f) return;
    this.floating = null; this.preview = null; this.kcache = null; this.paint();
    if (f.kind === "text") { const n = M.clone(f.node); M.mapPoints(n, () => [fx, fy]); this.edit("Draw Text", (s) => { M.addDrawItem(s, f.unit || 0, f.body, n); return [n]; }); return; }
    const res: M.PinInfo = { ...f.pin, x: fx, y: fy };
    const cur = this.symbol(); if (!cur) return;
    const occ = this.synchronizePins(cur) ? M.occupiedBy(cur, res) : null;
    if (occ !== null && !(await confirmBox("Confirmation", M.OCCUPIED_MSG(occ) + "\n\n" + M.OCCUPIED_EXT, "Place Pin Anyway"))) return;
    if (this.edit("Place Pin", (s) => { const r = M.placePin(s, res, this.synchronizePins(s) && res.unit !== 0); const n = M.itemAt(s, r); return n ? [n] : []; })) { this.lastRepeat = res; }
  }

  // library-level actions ------------------------------------------------------
  async save(): Promise<void> {
    const t = this.tab;
    if (t && t.origin) { await saveToSchematic(this, t); return; }
    if (t && t.scratch) { D.saveSymbolAs(this, false); return; }   // an unsaved symbol: the first save asks for a library
    const lib = t ? this.libs.get(t.lib) : this.currentLib();
    if (!lib) return;
    if (lib.kind === "official" || !lib.doc || !lib.doc.canEdit) { await messageBox(`Symbol library '${lib.nick}' is not writable.\n\nYou must save to a different location.`); if (t) await D.saveSymbolAs(this, false); return; }
    await this.saveLib(lib);
  }
  async saveLib(lib: Lib): Promise<boolean> {
    if (!lib.doc) return false;
    const ok = await lib.doc.save().catch(() => false);
    if (!ok) await messageBox(`Error saving library '${lib.nick}'.`);
    this.renderAll(); return ok;
  }
  async saveAll(): Promise<void> { for (const l of this.projectLibs()) if (l.doc && l.doc.isModified && l.doc.canEdit) await this.saveLib(l); }
  async revertSymbol(lib: Lib, name: string): Promise<void> {
    if (!lib.doc) return;
    if (!(await confirmBox("Revert", `The symbol "${name}" has been modified.\n\nYou are about to revert your changes.  All changes will be lost.  Continue?`, "Revert"))) return;
    const t = this.tabs.find((x) => !x.origin && x.lib === lib.nick && x.name === name);
    const had = lib.doc.lib.symbols.get(name);
    await lib.doc.revert([name]).catch(() => 0);
    const now = lib.doc.lib.symbols.get(name);
    if (t) { if (had && now) t.undo.push({ label: "Revert", before: M.text(had), after: M.text(now) }); t.sel.clear(); }
    if (!lib.doc.saved.symbols.has(name) && t) await this.closeTab(this.tabs.indexOf(t), true);
    this.kcache = null; this.renderAll();
  }
  async revertLib(lib: Lib): Promise<void> {
    if (!lib.doc) return;
    if (!(await confirmBox("Revert", `The library "${lib.nick}" has been modified.\n\nYou are about to revert your changes.  All changes will be lost.  Continue?`, "Revert"))) return;
    await lib.doc.revert().catch(() => 0); this.kcache = null; this.renderAll();
  }
  async revertScratch(): Promise<void> {
    const t = this.tab; if (!t || !t.origin || !t.undo.length) return;
    if (!(await confirmBox("Revert", `You are about to revert your changes to "${t.name}".  All changes will be lost.  Continue?`, "Revert"))) return;
    t.scratch = M.node(t.undo[0].before); t.undo = []; t.redo = []; t.modified = false; t.sel.clear(); this.kcache = null; this.renderAll();
  }
  async deleteSymbol(lib: Lib, name: string): Promise<void> {
    if (!lib.doc || !lib.doc.canEdit) return;
    const derived = M.derivedOf(lib.doc.lib, name);
    const msg = derived.length ? `Deleting symbol '${name}' will also delete the following derived symbols:\n\n${derived.join("\n")}\n\nAre you sure you want to delete them?` : `Are you sure you want to delete symbol '${name}'?`;
    if (!(await confirmBox("Delete Symbol", msg, "Delete"))) return;
    await lib.doc.commit([[name, null], ...derived.map((d): [string, null] => [d, null])]).catch(() => 0);
    for (let i = this.tabs.length - 1; i >= 0; i--) { const t = this.tabs[i]; if (!t.origin && t.lib === lib.nick && (t.name === name || derived.includes(t.name))) await this.closeTab(i, true); }
    lib.rows = null; this.renderAll();
  }
  copySymbol(lib: Lib, name: string): void {
    const m = this.libMap(lib); const s = m && m.symbols.get(name); if (!s) return;
    const flat = M.flatten(m, s); this.clip = M.text(flat); try { void navigator.clipboard.writeText(this.clip); } catch (e) { /* page only */ }
  }
  async pasteSymbol(lib: Lib): Promise<void> {
    if (!lib.doc || !this.clip) return;
    let sym: M.Node; try { sym = M.node(this.clip); } catch (e) { return; }
    if (sym[0] !== "symbol") { await messageBox("The clipboard does not hold a symbol."); return; }
    let name = M.symName(sym); let n = 1; while (lib.doc.lib.symbols.has(name)) name = `${M.symName(sym)}_${n++}`;
    const lib2 = { symbols: new Map([[M.symName(sym), sym]]) } as unknown as M.SymLib; M.renameSymbol(lib2, M.symName(sym), name);
    await lib.doc.commit([[name, M.text(lib2.symbols.get(name)!)]]).catch(() => 0);
    lib.rows = null; this.renderTree(); await this.loadSymbol(lib.nick, name);
  }
  async duplicateSymbol(lib: Lib, name: string): Promise<void> {
    if (!lib.doc) return; const s = lib.doc.lib.symbols.get(name); if (!s) return;
    let nn = name + "_1", i = 1; while (lib.doc.lib.symbols.has(nn)) nn = `${name}_${++i}`;
    const tmp = { symbols: new Map([[name, M.clone(s)]]) } as unknown as M.SymLib; M.renameSymbol(tmp, name, nn);
    await lib.doc.commit([[nn, M.text(tmp.symbols.get(nn)!)]]).catch(() => 0);
    lib.rows = null; this.renderTree(); await this.loadSymbol(lib.nick, nn);
  }
  async editLibrarySymbol(libId: string): Promise<void> {
    this.open();
    const i = libId.indexOf(":"); const nick = i > 0 ? libId.slice(0, i) : ""; const name = i > 0 ? libId.slice(i + 1) : libId;
    if (!this.libs.has(nick)) {
      // the official table may still be on its way
      for (let k = 0; k < 20 && !this.libs.has(nick) && !this.officialFailed; k++) await new Promise((r) => setTimeout(r, 150));
    }
    if (!this.libs.has(nick)) { await messageBox(`Library '${nick}' not found in the project's or KiCad's symbol libraries.`); return; }
    await this.loadSymbol(nick, name);
  }

  // ---------------------------------------------------------------- canvas input
  private hookCanvas(wrap: HTMLElement, cv: HTMLCanvasElement): void {
    wrap.addEventListener("contextmenu", (ev) => ev.preventDefault());
    wrap.addEventListener("pointerenter", () => { this.mouse.in = true; });
    wrap.addEventListener("pointerleave", () => { this.mouse.in = false; this.paint(); });
    wrap.addEventListener("wheel", (ev) => {
      ev.preventDefault(); const v = this.view();
      if (ev.ctrlKey && !ev.deltaMode && Math.abs(ev.deltaY) < 50 && ev.deltaY % 1 !== 0) { this.zoomAt(Math.exp(-ev.deltaY / 100), ev.clientX, ev.clientY); return; }   // pinch
      if (ev.shiftKey) { v.px -= ev.deltaY; this.paint(); return; }
      if (ev.ctrlKey) { v.py -= ev.deltaY; this.paint(); return; }
      this.zoomAt(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX, ev.clientY);
    }, { passive: false });
    wrap.addEventListener("pointerdown", (ev) => this.onDown(ev));
    wrap.addEventListener("pointermove", (ev) => this.onMove(ev));
    wrap.addEventListener("pointerup", (ev) => this.onUp(ev));
    wrap.addEventListener("dblclick", (ev) => this.onDbl(ev));
    void cv;
  }
  private hitAt(x: number, y: number): string | null {
    const doc = this.kdoc(); if (!doc) return null; const v = this.view();
    const r = K().hitTestDetail(doc, x, y, 4 / v.s); return r ? r.id : null;
  }
  private onDown(ev: PointerEvent): void {
    closeMenus(); this.el.cwrap.focus({ preventScroll: true });
    const [x, y] = this.toDoc(ev.clientX, ev.clientY); this.mouse.x = x; this.mouse.y = y;
    const v = this.view();
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) { this.drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, x0: v.px, y0: v.py }; (ev.target as Element).setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
    if (ev.button === 2) { this.contextMenu(ev, x, y); return; }
    if (ev.button !== 0) return;
    if (this.tool === "zoom") { this.drag = { mode: "zoom", sx: ev.clientX, sy: ev.clientY, x0: x, y0: y }; (ev.target as Element).setPointerCapture(ev.pointerId); return; }
    const t = this.tab; if (!t || !this.symbol()) return;
    const [fx, fy] = this.snapFile(x, y);
    if (this.carry) { this.finishCarry(); return; }
    if (this.floating) { void this.placeFloating(fx, fy); return; }
    switch (this.tool) {
      case "select": {
        const hit = this.hitAt(x, y);
        if (hit) {
          if (ev.shiftKey) t.sel.add(hit); else if (ev.ctrlKey || ev.metaKey) { if (t.sel.has(hit)) t.sel.delete(hit); else t.sel.add(hit); } else if (!t.sel.has(hit)) t.sel = new Set([hit]);
          this.drag = { mode: "move", sx: ev.clientX, sy: ev.clientY, x0: x, y0: y, ids: [...t.sel] };
        } else { if (!ev.shiftKey && !ev.ctrlKey) t.sel.clear(); this.drag = { mode: "band", sx: ev.clientX, sy: ev.clientY, x0: x, y0: y }; }
        (ev.target as Element).setPointerCapture(ev.pointerId);
        this.selChanged(); return;
      }
      case "delete": { const hit = this.hitAt(x, y); if (hit) { t.sel = new Set([hit]); this.deleteSel(); } return; }
      case "anchor": this.edit("Move Symbol Anchor", (s) => { M.moveAnchor(s, fx, fy); }); this.setTool("select"); return;
      case "pin": void this.placePinAt(fx, fy); return;
      case "text": void D.newText(this, fx, fy); return;
      default: this.drawClick(fx, fy, ev.detail >= 2); return;
    }
  }
  private onMove(ev: PointerEvent): void {
    const [x, y] = this.toDoc(ev.clientX, ev.clientY); this.mouse.x = x; this.mouse.y = y; this.mouse.in = true;
    const d = this.drag;
    if (d && d.mode === "pan") { const v = this.view(); v.px = d.x0 + ev.clientX - d.sx; v.py = d.y0 + ev.clientY - d.sy; this.paint(); return; }
    if (d && d.mode === "move" && !this.readOnly()) {
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return;
      d.moved = true; this.movePreview(d.ids || [], d.x0, d.y0, x, y);
    } else if (this.carry) this.carryPreview();
    else if (this.floating) this.floatPreview();
    else if (this.draw) this.drawPreview();
    this.renderStatus(); this.paint();
  }
  private onUp(ev: PointerEvent): void {
    const d = this.drag; this.drag = null; if (!d) return;
    const [x, y] = this.toDoc(ev.clientX, ev.clientY);
    if (d.mode === "move" && d.moved) {
      const [fx0, fy0] = this.snapFile(d.x0, d.y0), [fx1, fy1] = this.snapFile(x, y); const ids = d.ids || [];
      this.preview = null; this.kcache = null;
      this.edit("Move", (s) => { const ns = ids.map((id) => nodeOf(s, id)).filter((n): n is M.Node => !!n); for (const n of ns) M.moveNode(n, fx1 - fx0, fy1 - fy0); return ns; });
      this.paint(); return;
    }
    if (d.mode === "zoom") { this.zoomToArea(d.x0, d.y0, x, y); return; }
    if (d.mode === "band") {
      const t = this.tab; const doc = this.kdoc(); if (!t || !doc) return;
      const x0 = Math.min(d.x0, x), x1 = Math.max(d.x0, x), y0 = Math.min(d.y0, y), y1 = Math.max(d.y0, y);
      if (x1 - x0 > 0.01 || y1 - y0 > 0.01) {
        const inside = x >= d.x0;
        for (const it of doc.items.values()) { if (!it.movable || !it.bbox) continue; const b = it.bbox; const hit = inside ? b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1 : K().itemTouchesRect(it, x0, y0, x1, y1); if (hit) t.sel.add(it.id); }
      }
      this.selChanged();
    }
    this.paint();
  }
  private onDbl(ev: MouseEvent): void {
    if (this.draw) { this.finishDraw(); return; }
    if (this.tool !== "select") return;
    const [x, y] = this.toDoc(ev.clientX, ev.clientY); const hit = this.hitAt(x, y); const t = this.tab; if (!t) return;
    if (hit) { t.sel = new Set([hit]); this.selChanged(); this.editSelected(); } else void D.symbolProperties(this);
  }
  private movePreview(ids: string[], x0: number, y0: number, x: number, y: number): void {
    const sym = this.symbol(); if (!sym) return;
    const [ax, ay] = this.snapFile(x0, y0), [bx, by] = this.snapFile(x, y);
    const s = M.node(M.text(sym));
    for (const id of ids) { const n = nodeOf(s, id); if (n) M.moveNode(n, bx - ax, by - ay); }
    this.preview = s; this.kcache = null;
  }
  private carryPreview(): void {
    const c = this.carry; if (!c) return;
    const [bx, by] = this.snapFile(this.mouse.x, this.mouse.y); const s = M.node(c.base);
    for (const id of c.ids) { const n = nodeOf(s, id); if (n) M.moveNode(n, bx - c.sx, by - c.sy); }
    this.preview = s; this.kcache = null;
  }
  /** M / G: the selection follows the cursor until a click (Esc puts it back). */
  startCarry(label: string, amend = false): void {
    const t = this.tab; const sym = this.symbol(); if (!t || !sym || !t.sel.size || this.readOnly()) return;
    const [fx, fy] = this.snapFile(this.mouse.x, this.mouse.y);
    this.carry = { ids: [...t.sel], sx: fx, sy: fy, label, amend, base: M.text(sym) }; this.preview = M.node(M.text(sym)); this.kcache = null; this.paint();
  }
  private finishCarry(): void {
    const c = this.carry; if (!c) return; this.carry = null; const s = this.preview; this.preview = null; this.kcache = null;
    if (!s) return;
    const text = M.text(s); const ids = c.ids;
    this.edit(c.label, (x) => { x.length = 0; x.push(...M.node(text)); return ids.map((id) => nodeOf(x, id)).filter((n): n is M.Node => !!n); }, { amend: c.amend });
  }
  // drawing tools -----------------------------------------------------------
  /** ARC_DRAW_MODE of Draw Arcs */
  arcMode = arcDrawMode();
  private arcSeed: number[] | null = null;
  private need(kind: ToolId): number { return kind === "rectangle" || kind === "circle" || kind === "textbox" || kind === "ellipse" ? 2 : kind === "arc" ? (this.arcMode === ARC_TANGENT ? 2 : 3) : kind === "bezier" || kind === "ellipse_arc" ? 4 : Infinity; }
  private drawClick(fx: number, fy: number, dbl: boolean): void {
    // ARC_TANGENT: the arc continues the line or arc that ends where it starts
    if (!this.draw && this.tool === "arc" && this.arcMode === ARC_TANGENT) {
      const t = this.tab, sym = this.symbol(); this.arcSeed = t && sym ? M.arcTangentSeed(sym, [fx, fy], t.unit, t.body) : null;
      if (!this.arcSeed) { this.infoBarMessage("Click the end of a line or arc to draw a tangent arc", 3000); return; }
    }
    if (!this.draw) { this.draw = { kind: this.tool, pts: [[fx, fy]] }; this.drawPreview(); this.paint(); return; }
    const d = this.draw; const last = d.pts[d.pts.length - 1];
    if (dbl && (d.kind === "polyline" || d.kind === "polygon")) { this.finishDraw(); return; }
    if (last[0] === fx && last[1] === fy && !(d.kind === "ellipse_arc" && d.pts.length >= 2)) { if (d.kind === "polyline" || d.kind === "polygon") this.finishDraw(); return; }
    d.pts.push([fx, fy]);
    if (d.pts.length >= this.need(d.kind)) this.finishDraw(); else { this.drawPreview(); this.paint(); }
  }
  private shapeFor(kind: ToolId, pts: number[][]): M.Node | null {
    if (kind === "rectangle" && pts.length >= 2) return M.shapeNode("rectangle", pts);
    if (kind === "circle" && pts.length >= 2) return M.shapeNode("circle", pts);
    if (kind === "textbox" && pts.length >= 2) return M.shapeNode("rectangle", pts);
    // EDA_SHAPE::calcEdit (ELLIPSE) and ELLIPSE_GEOM_MANAGER: box corner, box corner, then for an arc start and end angle
    if ((kind === "ellipse" || kind === "ellipse_arc") && pts.length >= 2) {
      const e = M.ellipseFromBox(pts[0], pts[1]);
      if (kind === "ellipse" || pts.length < 3) return M.ellipseNode(e, kind === "ellipse_arc");
      Object.assign(e, M.ellipseArcAngles(e, pts[2], pts[3]));
      return M.ellipseNode(e, true);
    }
    if (kind === "arc" && pts.length >= 2 && this.arcMode !== 0) {
      // ARC_GEOM_MANAGER's other constructions (tools/arc-geom.ts), in nm as KiCad rounds them
      const nm = pts.map(toNm); let sol: ArcSol;
      if (this.arcMode === ARC_TANGENT) sol = this.arcSeed ? arcFromStartTangentEnd(nm[0], this.arcSeed, nm[1]) : { valid: false };
      else if (pts.length < 3) return null;
      else if (this.arcMode === ARC_START_END_MID) sol = arcFromStartEndMidDrag(nm[0], nm[1], nm[2]);
      else if (this.arcMode === ARC_START_END_CENTER) sol = arcFromStartEndCenterDrag(nm[0], nm[1], nm[2], false);
      else if (this.arcMode === ARC_START_DIR_END) sol = arcFromStartTangentEnd(nm[0], [nm[1][0] - nm[0][0], nm[1][1] - nm[0][1]], nm[2]);
      else sol = { valid: false };
      if (!sol.valid) return null;
      return M.shapeNode("arc", [sol.start, sol.mid, sol.end].map((p) => fromNm(p)).map((p) => [+M.fmt(p[0]), +M.fmt(p[1])]));
    }
    if (kind === "arc" && pts.length >= 2) {
      const [c, s] = pts; const e = pts[2] || s; const r = Math.hypot(s[0] - c[0], s[1] - c[1]); if (r <= 0) return null;
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (pts.length < 3) a1 = a0 + Math.PI / 2;
      let sweep = a1 - a0; while (sweep <= -Math.PI) sweep += 2 * Math.PI; while (sweep > Math.PI) sweep -= 2 * Math.PI; if (Math.abs(sweep) < 1e-6) return null;
      const end = [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)], mid = [c[0] + r * Math.cos(a0 + sweep / 2), c[1] + r * Math.sin(a0 + sweep / 2)];
      return M.shapeNode("arc", [s, mid, end].map((p) => [+M.fmt(p[0]), +M.fmt(p[1])]));
    }
    if (kind === "bezier" && pts.length >= 2) { const q = pts.slice(); while (q.length < 4) q.push(q[q.length - 1]); return M.shapeNode("bezier", q); }
    if ((kind === "polyline" || kind === "polygon") && pts.length >= 2) return M.shapeNode("polyline", kind === "polygon" && pts.length > 2 ? pts.concat([pts[0]]) : pts);
    return null;
  }
  private drawPreview(): void {
    const d = this.draw; const t = this.tab; const sym = this.symbol(); if (!d || !t || !sym) return;
    const pts = d.pts.concat([this.snapFile(this.mouse.x, this.mouse.y)]);
    const n = this.shapeFor(d.kind, pts); const s = M.node(M.text(sym)); if (n) M.addDrawItem(s, 0, t.body, n);
    this.preview = s; this.kcache = null;
  }
  private finishDraw(): void {
    const d = this.draw; const t = this.tab; this.draw = null; this.preview = null; this.kcache = null; if (!d || !t) { this.paint(); return; }
    if (d.kind === "textbox") { if (d.pts.length >= 2) void D.newTextBox(this, d.pts[0], d.pts[1]); this.paint(); return; }
    const n = this.shapeFor(d.kind, d.pts); if (!n) { this.paint(); return; }
    const label = { rectangle: "Draw Rectangle", circle: "Draw Circle", ellipse: "Draw Ellipse", ellipse_arc: "Draw Elliptical Arc", arc: "Draw Arc", bezier: "Draw Bezier", polyline: "Draw Lines", polygon: "Draw Polygon" }[d.kind as string] || "Draw";
    this.edit(label, (s) => { M.addDrawItem(s, 0, t.body, n); return [n]; });
  }
  /** The canvas context menu of the active tool (symedit/ctxmenu.ts): hidden entries, KiCad's order, Zoom / Grid submenus. */
  private contextMenu(ev: PointerEvent, x: number, y: number): void {
    const t = this.tab; const sym = this.symbol();
    const drawing = !!(this.draw || this.floating || this.carry);
    const tool: SymMenuCtx["tool"] = this.tool === "zoom" ? "zoom" : this.tool === "select" && !this.floating ? "select" : "draw";
    // SCH_SELECTION_TOOL: a right click on an unselected item selects it first
    if (tool === "select" && t && sym && !drawing) { const hit = this.hitAt(x, y); if (hit && !t.sel.has(hit)) { t.sel = new Set([hit]); this.selChanged(); } }
    const nodes = t && sym ? this.selNodes(sym) : [];
    const pinsSel = nodes.filter((n) => n[0] === "pin");
    let conv = false, expl = false;
    if (sym && nodes.length >= 2 && pinsSel.length === nodes.length) { const p0 = M.itemPosition(nodes[0]); conv = nodes.every((n) => { const p = M.itemPosition(n); return p[0] === p0[0] && p[1] === p0[1]; }); }
    else if (sym && nodes.length === 1 && pinsSel.length === 1) { conv = M.stackCandidates(sym, nodes).length >= 2; const nb = K().kid(nodes[0] as unknown as SNode, "number"); const st = nb ? M.stackedNumbers(String(nb[1])) : null; expl = !!st && st.length > 1; }
    const rows = symCanvasMenu({ tool, drawing, kinds: nodes.map((n) => String(n[0])), haveSymbol: !!sym, editable: !!sym && !this.readOnly(), alias: !!sym && M.isDerived(sym), canConvertStacked: conv, canExplodeStacked: expl });
    const A = this.actions();
    const items: MenuEntry[] = rows.map((r): MenuEntry => {
      if (r === "-") return { sep: true };
      if (r === "zoomMenu") return this.zoomMenu();
      if (r === "gridMenu") return this.gridMenu();
      if (r === "cancelInteractive") return this.act(r, () => { this.cancelInteraction(); this.setTool("select"); });
      if (r === "paste") return this.act(r, A[r], { enabled: () => !!this.clip });
      return this.act(r, A[r]);
    });
    showMenu(ev.clientX, ev.clientY, items);
  }
  /** ZOOM_MENU::update: the zoom list, the entry within 10 % of the current zoom checked. */
  private zoomMenu(): MenuEntry {
    const cur = this.kzoom();
    return { label: "Zoom", icon: "zoom_selection", sub: ZOOM_LIST.sch.map((f) => ({ label: `Zoom: ${f.toFixed(2)}`, check: () => Math.abs(f - cur) / cur < 0.1, enabled: () => true, run: () => this.zoomAt(f / this.kzoom()) })) };
  }

  // ---------------------------------------------------------------- keys
  private onKey(ev: KeyboardEvent): void {
    if (!this.isOpen) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT" || t.isContentEditable)) {
      // the library filter keeps its typing; Find / Find and Replace still open from it, as from any frame control
      const findKey = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === "f";
      if (!this.root!.contains(t) || (ev.key !== "Escape" && !findKey)) return;
    }
    if (t && t.closest && t.closest(".kd-overlay, .kd-pop")) return;
    if ((window as unknown as { KDialogs?: { isOpen?: () => boolean } }).KDialogs?.isOpen?.()) return;
    const combo = comboOf(ev); if (!combo) return;
    ev.stopImmediatePropagation();
    if (document.querySelector(".se-menu")) { if (combo === "Esc") { ev.preventDefault(); closeMenus(); } return; }
    const run = (fn: () => void) => { ev.preventDefault(); fn(); };
    if (combo === "Esc") return run(() => { if (this.carry || this.draw || this.floating) this.cancelInteraction(); else if (this.tool !== "select") this.setTool("select"); else if (this.tab) { this.tab.sel.clear(); this.selChanged(); } });
    if (combo === "Enter" && this.draw) return run(() => this.finishDraw());
    if (this.draw) {
      // a shape being drawn takes End (finishInteractive) and Backspace / Delete (deleteLastPoint or doDelete) itself
      if (combo === "End") return run(() => this.finishDraw());
      if (combo === "Backspace" || combo === "Delete" || combo === "Del") return run(() => this.deleteLastPoint());
    }
    if (combo === "Ctrl+W") return run(() => void this.close());
    if (combo === "Ctrl+Shift+Z") return run(() => this.redo());
    if (combo === "E" && this.tab) return run(() => this.editSelected());
    if (combo === "Delete" || combo === "Backspace" || combo === "Del") return run(() => this.deleteSel());
    if (combo === "Insert" || combo === "Ins") return run(() => this.repeat());
    if (this.symbol()) {
      if (combo === "Ctrl+F") return run(() => openSymbolFind(this, false));
      if (combo === "Ctrl+Alt+F") return run(() => openSymbolFind(this, true));
      if (combo === "F3") return run(() => void findNextMatch(this));
      if (combo === "Shift+F3") return run(() => void findNextMatch(this, true));
    }
    if (combo === "Home") return run(() => this.zoomFit());
    // every action of the frame that KiCad gives a hotkey (TOOL_MANAGER's hotkey map over the registered actions)
    const A = this.actions();
    for (const [id, fn] of Object.entries(A)) {
      if (!fn || NO_HOTKEY.has(id) || (id === "find" && !this.symbol())) continue;
      const k = meta(id).key; if (k && norm(k) === norm(combo)) return run(fn);
    }
  }
}
/** Actions dispatched above or not handled by the Symbol Editor's tools (their hotkeys belong to other frames). */
const NO_HOTKEY = new Set(["doDelete", "repeatDrawItem", "properties", "cancelInteractive", "deleteLastPoint", "finishInteractive"]);
const norm = (k: string) => k.replace(/\s/g, "").toLowerCase().replace("delete", "del").replace("insert", "ins");

export const editor = new SymbolEditor();
export { download };
