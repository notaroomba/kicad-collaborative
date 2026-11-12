// symedit/editor.ts — SYMBOL_EDIT_FRAME in the web editor: a full-window frame over the schematic editor with
// KiCad's menus (menubar_symbol_editor.cpp), toolbars (toolbars_symbol_editor.cpp), the library tree, symbol tabs,
// the infobar, the message panel and a canvas drawn by kicad-canvas (KiCadCanvas.parseLibSymbol + render).
//
// What is edited: a symbol of one of the project's .kicad_sym libraries (a live shared buffer, symedit/libdoc.ts),
// a read-only symbol of the official libraries (its editable copy goes through Save As), or a schematic symbol's
// library copy (symedit/schematic.ts; Save writes it back to the schematic).  Each edit replaces the whole symbol;
// a tab's undo list holds the symbol's text before every edit (SYMBOL_EDIT_FRAME's undo of a LIB_SYMBOL copy).
import * as M from "./model";
import { LibDoc, libDocFor } from "./libdoc";
import { h, confirmBox, download } from "../dialogs/dom";
import { messageBox } from "../dialogs/sch-items";
import { E, appState } from "../dialogs/editor";
import { comboOf } from "../editor/hotkeys";
import { fmtCoord, unitName } from "../units";
import { ensureStyle, icon, meta, showMenu, closeMenus, type MenuEntry } from "./ui";
import * as D from "./dialogs";
import { openSymbolFind, findNext as findNextMatch } from "./find";
import type { Units } from "../store";
import { saveToSchematic } from "./schematic";
import { openPreferences } from "../dialogs/preferences";

export type ToolId = "select" | "pin" | "text" | "textbox" | "rectangle" | "circle" | "ellipse" | "ellipse_arc" | "arc" | "bezier" | "polyline" | "polygon" | "anchor" | "delete";
interface Row { name: string; desc: string; parent: string; units: number; power: boolean }
export interface Lib { nick: string; kind: "project" | "official"; doc: LibDoc | null; rows: Row[] | null; syms: Map<string, M.Node>; open: boolean; loading: boolean; error?: string }
export interface Origin { docId: string; itemId: string; libId: string; ref: string; sheet: string }
interface Step { label: string; text: string }
export interface Tab { lib: string; name: string; origin?: Origin; scratch?: M.Node; modified?: boolean; undo: Step[]; redo: Step[]; unit: number; body: number; sel: Set<string>; view: { s: number; px: number; py: number } | null; fitted?: boolean }

const TOOL_ACTIONS: Record<string, ToolId> = { selectionTool: "select", placeSymbolPin: "pin", placeSymbolText: "text", drawSymbolTextBox: "textbox", drawRectangle: "rectangle", drawCircle: "circle", drawEllipse: "ellipse", drawEllipseArc: "ellipse_arc", drawArc: "arc", drawBezier: "bezier", drawSymbolLines: "polyline", drawSymbolPolygon: "polygon", placeSymbolAnchor: "anchor", deleteTool: "delete" };
const GRIDS_MIL = [100, 50, 25, 10, 5, 2, 1];
const ANCHOR = "#0000FF";   // LAYER_SCHEMATIC_ANCHOR

const K = (): KiCadCanvasApi => window.KiCadCanvas;
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
  showHiddenPins = true; showHiddenFields = true; showETypes = true; showAltIcons = true; syncPins = false; showTree = true; showProps = true;
  gridMil = 50;
  lastPin = M.initialPinDefaults();
  lastRepeat: M.PinInfo | null = null;
  lastTextAngle = 0;
  clip: string | null = null;
  filter = "";
  treeSel: { lib: string; name?: string } | null = null;
  private el: Record<string, HTMLElement> = {};
  private cv: HTMLCanvasElement | null = null;
  private preview: M.Node | null = null;
  private kcache: { key: string; doc: KDoc } | null = null;
  private mouse = { x: 0, y: 0, in: false };           // doc mm (Y down)
  private drag: { mode: "pan" | "band" | "move"; sx: number; sy: number; x0: number; y0: number; px?: number; py?: number; moved?: boolean; ids?: string[] } | null = null;
  private carry: { ids: string[]; sx: number; sy: number; label: string; amend: boolean; base: string } | null = null;
  /** SYMBOL_EDITOR_DRAWING_TOOLS::TwoClickPlace: a new pin or text follows the cursor (IS_NEW | IS_MOVING) until the second click. */
  private floating: { kind: "pin"; pin: M.PinInfo } | { kind: "text"; node: M.Node; body: number } | null = null;
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

  get isOpen(): boolean { return !!this.root && this.root.isConnected; }
  get tab(): Tab | null { return this.tabs[this.cur] || null; }
  get units(): Units { return (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units; }
  get gridMm(): number { return this.gridMil * M.MIL; }
  fmt(mm: number): string { return fmtCoord(mm, this.units).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m)) + " " + unitName(this.units); }

  // ---------------------------------------------------------------- open / close
  open(): void {
    ensureStyle();
    if (!this.root) { this.build(); if (window.innerWidth < 900) { this.showTree = false; this.showProps = false; } }   // a narrow window starts with the canvas alone
    if (!this.root!.isConnected) document.body.append(this.root!);
    document.documentElement.dataset.symedit = "open";
    window.addEventListener("keydown", this.keyHook, true);
    document.addEventListener("focusin", this.focusHook, true);
    this.refreshLibs();
    this.renderAll();
    requestAnimationFrame(() => { this.resize(); if (this.tab && !this.tab.fitted) this.zoomFit(); this.paint(); });
  }
  async close(): Promise<void> {
    const dirty = this.tabs.filter((t) => t.origin && t.modified);
    if (dirty.length && !(await confirmBox("Close Symbol Editor", `Save changes to "${dirty[0].name}" before closing?\n\nChanges made to the schematic copy will be lost.`, "Discard Changes"))) return;
    this.tabs = this.tabs.filter((t) => !t.origin); this.cur = Math.min(this.cur, this.tabs.length - 1);
    closeMenus();
    window.removeEventListener("keydown", this.keyHook, true);
    document.removeEventListener("focusin", this.focusHook, true);
    delete document.documentElement.dataset.symedit;
    if (this.root) this.root.remove();
    try { const u = new URL(location.href); if (u.searchParams.has("symedit")) { u.searchParams.delete("symedit"); history.replaceState(history.state, "", u.toString()); } } catch (e) { /* no history */ }
  }

  // ---------------------------------------------------------------- libraries
  /** The project's .kicad_sym documents, by sym-lib-table nickname when the table names them. */
  refreshLibs(): void {
    const docs = (appState.project && appState.project.docs) || appState.docs || [];
    const nickFor = new Map<string, string>();
    const table = docs.find((d) => /(^|\/)sym-lib-table$/.test(d.path));
    if (table) void this.readTable(table.docId);
    for (const [path, nick] of this.tableNicks) nickFor.set(path, nick);
    for (const d of docs) {
      if (d.docType !== "symbol_lib" && !/\.kicad_sym$/i.test(d.path)) continue;
      const file = d.path.split("/").pop() || d.path;
      const nick = nickFor.get(d.path) || file.replace(/\.kicad_sym$/i, "");
      if (this.libs.has(nick)) continue;
      const doc = libDocFor(d.docId, d.path, nick);
      const lib: Lib = { nick, kind: "project", doc, rows: null, syms: new Map(), open: false, loading: true };
      this.libs.set(nick, lib);
      doc.on((why, names) => this.onLibEvent(lib, why, names));
      doc.connect();
    }
    if (!this.officialList && !this.officialFailed) {
      fetch("/api/libs/symbols", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 401 ? "Sign in to browse the KiCad libraries" : `HTTP ${r.status}`))))
        .then((j: { libraries: { name: string; description: string }[] }) => {
          this.officialList = j.libraries;
          for (const l of j.libraries) if (!this.libs.has(l.name)) this.libs.set(l.name, { nick: l.name, kind: "official", doc: null, rows: null, syms: new Map(), open: false, loading: false });
          this.renderTree();
        }).catch((e: Error) => { this.officialFailed = e.message; });
    }
  }
  private tableNicks = new Map<string, string>();
  private tableRead = false;
  private async readTable(docId: string): Promise<void> {
    if (this.tableRead) return; this.tableRead = true;
    try {
      const r = await fetch(`/api/docs/${docId}/content`, { credentials: "same-origin" }); if (!r.ok) return;
      const t = await r.text(); const tree = K().parse(t); if (!tree) return;
      let changed = false;
      for (const l of K().kids(tree, "lib")) {
        const name = K().str((K().kid(l, "name") || [])[1]), uri = K().str((K().kid(l, "uri") || [])[1]);
        const m = /^\$\{KIPRJMOD\}\/(.+)$/.exec(uri); if (!name || !m) continue;
        this.tableNicks.set(m[1], name);
        for (const lib of this.libs.values()) if (lib.doc && lib.doc.path === m[1] && lib.nick !== name) {
          this.libs.delete(lib.nick); lib.nick = name; lib.doc.nickname = name; this.libs.set(name, lib);
          for (const t2 of this.tabs) if (t2.lib === (lib.doc.path.split("/").pop() || "").replace(/\.kicad_sym$/i, "")) t2.lib = name;
          changed = true;
        }
      }
      if (changed) this.renderAll();
    } catch (e) { /* the file names stay */ }
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
      for (const [name, s] of lib.doc.lib.symbols) rows.push({ name, desc: M.fieldValue(s, "Description"), parent: M.parentNameOf(s) || "", units: M.unitCount(M.rootOf(lib.doc.lib, s)), power: M.isPower(s) });
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
    if (t.origin) return false;
    const lib = this.libs.get(t.lib); return !lib || lib.kind === "official" || !lib.doc || !lib.doc.canEdit;
  }
  isModified(t: Tab): boolean {
    if (t.origin) return !!t.modified;
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
    if (!opts.amend || !t.undo.length) t.undo.push({ label, text: before });
    if (t.undo.length > 100) t.undo.shift();
    t.redo = [];
    if (Array.isArray(res)) { t.sel = new Set(res.map((n) => idOfNode(s, n)).filter((x): x is string => !!x)); }
    else t.sel = new Set([...t.sel].filter((id) => nodeOf(s, id)));
    this.store(t, s);
    return true;
  }
  private store(t: Tab, s: M.Node): void {
    if (t.origin || t.scratch) { t.scratch = s; t.modified = true; }
    else { const lib = this.libs.get(t.lib); if (lib && lib.doc) { lib.doc.commit([[t.name, M.text(s)]]).catch((e: Error) => void messageBox(`The edit was not accepted: ${e.message}`)); lib.rows = null; } }
    this.kcache = null;
    this.renderTree(); this.renderTabs(); this.renderMsg(); this.renderToolbars(); this.paint();
  }
  undo(): void {
    const t = this.tab; const cur = this.symbol(); if (!t || !cur || !t.undo.length || this.readOnly()) return;
    const step = t.undo.pop()!; t.redo.push({ label: step.label, text: M.text(cur) }); t.sel.clear(); this.store(t, M.node(step.text));
    if (t.origin && !t.undo.length) t.modified = false;
  }
  redo(): void {
    const t = this.tab; const cur = this.symbol(); if (!t || !cur || !t.redo.length || this.readOnly()) return;
    const step = t.redo.pop()!; t.undo.push({ label: step.label, text: M.text(cur) }); t.sel.clear(); this.store(t, M.node(step.text));
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
  openScratch(origin: Origin, sym: M.Node, unit: number, body: number): void {
    const i = this.tabs.findIndex((t) => t.origin && t.origin.itemId === origin.itemId && t.origin.docId === origin.docId);
    const tab: Tab = { lib: origin.libId.split(":")[0] || "", name: M.symName(sym), origin, scratch: sym, modified: false, undo: [], redo: [], unit: unit || 1, body: body || 1, sel: new Set(), view: null };
    if (i >= 0) { this.tabs[i] = tab; this.cur = i; } else { this.tabs.push(tab); this.cur = this.tabs.length - 1; }
    this.afterTabChange();
  }
  async closeTab(i: number, force = false): Promise<void> {
    const t = this.tabs[i]; if (!t) return;
    if (!force && t.origin && t.modified && !(await confirmBox("Close Symbol Tab", `Discard changes to the schematic copy of '${t.name}'?`, "Discard Changes"))) return;
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
  kdoc(): KDoc | null {
    const t = this.tab; const sym = this.preview || this.symbol(); if (!t || !sym) return null;
    const parent = this.parentOf(sym);
    const key = [M.text(sym), parent ? M.text(parent) : "", t.unit, t.body, this.showHiddenPins, this.showHiddenFields, this.showETypes].join("§");
    if (this.kcache && this.kcache.key === key) return this.kcache.doc;
    const doc = K().parseLibSymbol(sym as unknown as SNode, { unit: t.unit, bodyStyle: t.body, showHiddenPins: this.showHiddenPins, showHiddenFields: this.showHiddenFields, showElectricalTypes: this.showETypes, showPinAltIcons: this.showAltIcons, parent: parent as unknown as SNode });
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
  snapFile(x: number, y: number): [number, number] { const g = this.gridMm; return [+M.fmt(Math.round(x / g) * g), +M.fmt(-Math.round(y / g) * g)]; }
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
    K().render(doc, ctx, view, { grid: this.gridMm, gridAxes: true, frame: false, showHiddenPins: this.showHiddenPins } as KRenderOpts);
    const s = K().setViewTransform(ctx, view);
    // the symbol anchor (LAYER_SCHEMATIC_ANCHOR cross at the origin)
    const a = 6 * dpr / s; ctx.strokeStyle = ANCHOR; ctx.lineWidth = dpr / s; ctx.beginPath(); ctx.moveTo(-a, 0); ctx.lineTo(a, 0); ctx.moveTo(0, -a); ctx.lineTo(0, a); ctx.stroke();
    const sel = new Set([...t.sel].filter((id) => doc.items.has(id)));
    if (this.carry || (this.drag && this.drag.mode === "move")) { /* the moved items draw as themselves */ }
    if (sel.size) K().drawSelectionHalo(ctx, doc, sel, s, dpr);
    if (this.drag && this.drag.mode === "band") {
      const [x0, y0] = [this.drag.x0, this.drag.y0], [x1, y1] = [this.mouse.x, this.mouse.y];
      ctx.save(); ctx.lineWidth = dpr / s; ctx.strokeStyle = x1 >= x0 ? "#4F9CFF" : "#4FCF6F"; ctx.setLineDash(x1 >= x0 ? [] : [4 / s, 3 / s]);
      ctx.fillStyle = x1 >= x0 ? "rgba(79,156,255,.12)" : "rgba(79,207,111,.12)"; ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.restore();
    }
    // the cursor (KiCad's small crosshair on the snapped grid point)
    if (this.mouse.in) {
      const [fx, fy] = this.snapFile(this.mouse.x, this.mouse.y); const cx = fx, cy = -fy, r = 8 * dpr / s;
      ctx.strokeStyle = K().SCH.cursor || "#000"; ctx.lineWidth = dpr / s; ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
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
    return [
      ["File", [a("newLibrary", () => !E.viewOnly), a("addLibrary", () => !E.viewOnly), a("saveLibraryAs", () => !!this.currentLib()), a("newSymbol", () => !E.viewOnly), a("editLibSymbolWithLibEdit", fromSch, undefined, "Open Symbol from Library"), S,
        a("save", () => has() || !!this.currentLib()), a("saveSymbolAs", has), a("saveSymbolCopyAs", has), ...(fromSch() ? [] : [a("saveAll", () => this.projectLibs().some((l) => l.doc && l.doc.isModified))]), a("revert", () => !!this.tab && this.isModified(this.tab)), S,
        { label: "Import", sub: [a("importSymbol", () => !E.viewOnly, undefined, "Symbol..."), a("importGraphics", undefined, undefined, "Graphics...")] },
        { label: "Export", sub: [a("exportSymbol", has, undefined, "Symbol..."), a("exportSymbolView", has, undefined, "View as PNG..."), a("exportSymbolAsSVG", has, undefined, "Symbol as SVG...")] }, S,
        a("compareLibraryWithFile"), S, a("symbolProperties", has), S, { label: "Close", key: "Ctrl+W", run: () => void this.close(), enabled: () => true }]],
      ["Edit", [a("undo", () => !!this.tab && this.tab.undo.length > 0 && !this.readOnly()), a("redo", () => !!this.tab && this.tab.redo.length > 0 && !this.readOnly()), S,
        a("cut", () => can() && this.tab!.sel.size > 0), a("copy", () => has() && this.tab!.sel.size > 0), a("copyAsText", () => has() && this.tab!.sel.size > 0), a("paste", () => can() && !!this.clip), a("doDelete", () => can() && this.tab!.sel.size > 0), a("duplicate", () => can() && this.tab!.sel.size > 0), S,
        a("selectAll", has), a("unselectAll", has), S, a("find", has), a("findAndReplace", has), S, a("pinTable", has), a("editSymbolPinMaps"), a("updateSymbolFields", () => can() && M.isDerived(this.symbol()!))]],
      ["View", [{ label: "Panels", sub: [a("showProperties", () => true, () => this.showProps), a("showLibraryTree", () => true, () => this.showTree)] }, S, a("showSymbolBrowser"), S,
        a("zoomInCenter"), a("zoomOutCenter"), a("zoomFitScreen"), a("zoomTool"), a("zoomRedraw"), S,
        a("showHiddenPins", () => true, () => this.showHiddenPins), a("showHiddenFields", () => true, () => this.showHiddenFields), a("togglePinAltIcons", () => true, () => this.showAltIcons), S,
        a("nextSymbolTab", () => this.tabs.length > 1), a("prevSymbolTab", () => this.tabs.length > 1), a("closeSymbolTab", () => this.tabs.length > 0)]],
      ["Place", ["placeSymbolPin", "placeSymbolText", "drawSymbolTextBox", "drawRectangle", "drawCircle", "drawEllipse", "drawEllipseArc", "drawArc", "drawBezier", "drawSymbolLines", "drawSymbolPolygon"].map((id) => a(id, can, () => TOOL_ACTIONS[id] === this.tool))],
      ["Inspect", [a("showDatasheet", () => has() && !!M.fieldValue(this.symbol()!, "Datasheet")), S, a("checkSymbol", has)]],
      ["Preferences", [a("configurePaths"), a("showSymbolLibTable"), a("openPreferences"), S, { label: "Set Language" }]],
      ["Help", [{ label: "Getting Started with KiCad", run: () => window.open("https://docs.kicad.org/", "_blank", "noopener") }, a("listHotKeys")]],
    ];
  }
  private renderMenus(): void {
    const mb = this.el.mb; mb.innerHTML = "";
    for (const [label, items] of this.menus()) {
      const b = h("div", { class: "se-mb", role: "menuitem", "data-menu": label }, label);
      const openIt = () => { const r = b.getBoundingClientRect(); closeMenus(); b.classList.add("open"); showMenu(r.left, r.bottom, this.menus().find((m) => m[0] === label)![1]); };
      b.addEventListener("click", (ev) => { ev.stopPropagation(); if (b.classList.contains("open")) closeMenus(); else openIt(); });
      b.addEventListener("pointerenter", () => { if (document.querySelector(".se-mb.open") && !b.classList.contains("open")) openIt(); });
      mb.append(b);
    }
    const t = this.tab;
    mb.append(h("span", { class: "se-title", id: "se-title" }, t ? `Symbol Editor — ${t.origin ? t.name + " [from schematic]" : t.lib + ":" + t.name}${t && this.isModified(t) ? " *" : ""}` : "Symbol Editor"));
    mb.append(h("button", { class: "btn sm se-close", id: "se-close", onclick: () => void this.close() }, "Close"));
  }

  // toolbars ---------------------------------------------------------------
  private tbButton(id: string, onTool?: boolean): HTMLElement {
    const m = meta(id); const A = this.actions(); const run: (() => void) | undefined = A[id];
    const on = this.toggled(id);
    const b = h("button", { class: "se-btn" + (on ? " on" : "") + (run ? "" : " dim"), "data-act": id, title: m.tip + (m.key ? ` (${m.key})` : "") + (run ? "" : " — runs in the KiCad desktop app"), "aria-label": m.label, "aria-pressed": onTool || on ? String(!!on) : undefined }, icon(m.icon));
    if (run) b.addEventListener("click", () => { run(); }); else (b as HTMLButtonElement).disabled = true;
    return b;
  }
  private toggled(id: string): boolean {
    if (TOOL_ACTIONS[id]) return this.tool === TOOL_ACTIONS[id];
    switch (id) {
      case "showElectricalTypes": return this.showETypes; case "showHiddenPins": return this.showHiddenPins; case "showHiddenFields": return this.showHiddenFields; case "togglePinAltIcons": return this.showAltIcons;
      case "showLibraryTree": return this.showTree; case "showProperties": return this.showProps; case "toggleSyncedPinsMode": return this.syncPins; case "toggleGrid": return true;
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
        else if (raw.group && raw.items) { for (const it of raw.items) host.append(this.tbButton(it.id)); }
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
      const s = h("select", { id: "se-unit", "aria-label": "Unit", disabled: !sym || n < 2 }) as HTMLSelectElement;
      const names = sym && n > 1 ? M.unitChoices(this.rootSym(sym)) : [""];   // one unit: an empty entry, as KiCad
      names.forEach((label, i) => s.append(h("option", { value: String(i + 1) }, label)));
      if (t) s.value = String(t.unit); s.addEventListener("change", () => this.setUnit(Number(s.value)));
      return s;
    }
    if (name === "bodyStyleSelector") {
      const b = sym ? M.bodyStyles(this.rootSym(sym)) : { count: 1, demorgan: false, names: [] as string[] };
      const s = h("select", { id: "se-body", "aria-label": "Body style", disabled: !sym || b.count < 2 }) as HTMLSelectElement;
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
  renderTree(): void {
    const list = this.el.list; if (!list) return;
    const q = this.filter.trim().toLowerCase(); const t = this.tab;
    const frag = document.createDocumentFragment();
    const libs = [...this.libs.values()].sort((a, b) => (a.kind === b.kind ? a.nick.localeCompare(b.nick) : a.kind === "project" ? -1 : 1));
    for (const lib of libs) {
      const rows = lib.kind === "project" || lib.rows ? this.rowsOf(lib) : lib.rows || [];
      const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)) : rows;
      if (q && !hits.length && !lib.nick.toLowerCase().includes(q)) continue;
      const open = lib.open || (!!q && hits.length > 0);
      const modified = !!lib.doc && lib.doc.loaded && lib.doc.isModified;
      const isSel = this.treeSel && this.treeSel.lib === lib.nick && !this.treeSel.name;
      const row = h("div", { class: "se-row lib" + (lib.kind === "official" ? " ro" : "") + (isSel ? " cur" : ""), "data-lib": lib.nick, title: lib.kind === "official" ? "KiCad library (read-only)" : lib.doc ? lib.doc.path : "" },
        h("span", { class: "tw" }, open ? "▾" : "▸"), h("span", { class: "nm" }, (modified ? "*" : "") + lib.nick),
        lib.loading ? h("span", { class: "ds" }, " loading…") : lib.error ? h("span", { class: "ds" }, " " + lib.error) : null);
      row.addEventListener("click", () => { lib.open = !open; this.treeSel = { lib: lib.nick }; if (lib.open && lib.kind === "official") void this.loadOfficial(lib); this.renderTree(); this.renderMenus(); });
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.treeSel = { lib: lib.nick }; this.renderTree(); showMenu(ev.clientX, ev.clientY, this.libMenu(lib)); });
      frag.append(row);
      if (!open) continue;
      for (const r of hits) {
        const cur = !!t && !t.origin && t.lib === lib.nick && t.name === r.name;
        const sel = this.treeSel && this.treeSel.lib === lib.nick && this.treeSel.name === r.name;
        const mod = !!lib.doc && lib.doc.loaded && lib.doc.isSymbolModified(r.name);
        const sr = h("div", { class: "se-row" + (sel || cur ? " cur" : ""), "data-sym": lib.nick + ":" + r.name, style: "padding-left:18px", title: r.desc },
          h("span", { class: "tw" }, r.units > 1 ? "▸" : ""), h("span", { class: "nm", style: cur ? "font-weight:600" : "" }, (mod ? "*" : "") + r.name), h("span", { class: "ds" }, r.desc));
        sr.addEventListener("click", () => { this.treeSel = { lib: lib.nick, name: r.name }; this.renderTree(); });
        sr.addEventListener("dblclick", () => void this.loadSymbol(lib.nick, r.name));
        sr.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.treeSel = { lib: lib.nick, name: r.name }; this.renderTree(); showMenu(ev.clientX, ev.clientY, this.symMenu(lib, r.name)); });
        frag.append(sr);
        if (r.units > 1 && cur) for (let u = 1; u <= r.units; u++) {
          const ur = h("div", { class: "se-row" + (t!.unit === u ? " cur" : ""), style: "padding-left:36px" }, h("span", { class: "nm" }, `Unit ${M.unitLetter(u)}`));
          ur.addEventListener("click", () => this.setUnit(u)); frag.append(ur);
        }
      }
      if (lib.kind === "project" && lib.doc && lib.doc.loaded && !rows.length && !q) frag.append(h("div", { class: "se-row", style: "padding-left:18px;color:var(--ink-3)" }, "(empty)"));
    }
    if (this.officialFailed && !q) frag.append(h("div", { class: "se-row", style: "color:var(--ink-3);white-space:normal" }, this.officialFailed));
    list.innerHTML = ""; list.append(frag);
  }
  private libMenu(lib: Lib): MenuEntry[] {
    const A = this.actions(); const proj = lib.kind === "project" && !!lib.doc && lib.doc.canEdit && !E.viewOnly;
    return [
      this.act("newSymbol", A.newSymbol, { enabled: () => proj }),
      { sep: true },
      this.act("save", () => void this.saveLib(lib), { enabled: () => proj && !!lib.doc && lib.doc.isModified }),
      this.act("saveLibraryAs", () => void D.saveLibraryAs(this, lib), { label: "Save Library As...", enabled: () => !E.viewOnly }),
      this.act("revert", () => void this.revertLib(lib), { enabled: () => proj && !!lib.doc && lib.doc.isModified }),
      { sep: true },
      this.act("importSymbol", () => void D.importSymbol(this, lib), { enabled: () => proj }),
      this.act("pasteSymbol", () => void this.pasteSymbol(lib), { enabled: () => proj }),
    ];
  }
  private symMenu(lib: Lib, name: string): MenuEntry[] {
    const proj = lib.kind === "project" && !!lib.doc && lib.doc.canEdit && !E.viewOnly;
    return [
      this.act("editSymbol", () => void this.loadSymbol(lib.nick, name)),
      { sep: true },
      this.act("save", () => void this.saveLib(lib), { enabled: () => proj && !!lib.doc && lib.doc.isSymbolModified(name) }),
      this.act("saveSymbolAs", () => void this.withSymbol(lib, name, () => D.saveSymbolAs(this, false))),
      this.act("saveSymbolCopyAs", () => void this.withSymbol(lib, name, () => D.saveSymbolAs(this, true))),
      this.act("duplicateSymbol", () => void this.duplicateSymbol(lib, name), { enabled: () => proj }),
      this.act("renameSymbol", () => void D.renameSymbol(this, lib, name), { enabled: () => proj }),
      this.act("revert", () => void this.revertSymbol(lib, name), { enabled: () => proj && !!lib.doc && lib.doc.isSymbolModified(name) }),
      { sep: true },
      this.act("cutSymbol", () => { this.copySymbol(lib, name); void this.deleteSymbol(lib, name); }, { label: "Cut", enabled: () => proj }),
      this.act("copySymbol", () => this.copySymbol(lib, name), { label: "Copy" }),
      this.act("pasteSymbol", () => void this.pasteSymbol(lib), { enabled: () => proj && !!this.clip }),
      this.act("deleteSymbol", () => void this.deleteSymbol(lib, name), { enabled: () => proj }),
      { sep: true },
      this.act("exportSymbol", () => void this.withSymbol(lib, name, () => D.exportSymbol(this))),
    ];
  }
  private async withSymbol(lib: Lib, name: string, fn: () => unknown): Promise<void> { if (await this.loadSymbol(lib.nick, name)) await fn(); }

  // tabs strip -------------------------------------------------------------
  renderTabs(): void {
    const host = this.el.tabs; if (!host) return; host.innerHTML = "";
    this.tabs.forEach((t, i) => {
      const x = h("span", { class: "x", title: "Close", "aria-label": "Close tab" }, "×");
      const el = h("div", { class: "se-tab" + (i === this.cur ? " cur" : ""), "data-tab": i, title: t.origin ? `${t.name} (from schematic)` : `${t.lib}:${t.name}` }, (this.isModified(t) ? "*" : "") + (t.origin ? t.origin.ref || t.name : t.name), x);
      el.addEventListener("click", (ev) => { if (ev.target === x) { void this.closeTab(i); return; } this.cur = i; this.afterTabChange(); });
      host.append(el);
    });
    host.style.display = this.tabs.length ? "flex" : "none";
    this.renderMenus();
  }

  // properties panel / message panel ------------------------------------------
  renderProps(): void {
    const p = this.el.props; if (!p || !this.showProps) return; p.innerHTML = "";
    const sym = this.symbol(); const t = this.tab; if (!sym || !t) { p.append(h("h4", null, "Properties"), h("div", { style: "color:var(--ink-3)" }, "No symbol")); return; }
    const sel = [...t.sel]; const kv = h("div", { class: "kv" });
    const add = (k: string, v: string) => kv.append(h("span", null, k), h("span", null, v));
    if (sel.length === 1) {
      const n = nodeOf(sym, sel[0]);
      if (n && n[0] === "pin") { const i = M.pinInfo(n); p.append(h("h4", null, "Pin")); add("Name", i.name); add("Number", i.number); add("Type", D.typeLabel(i.type)); add("Style", D.shapeLabel(i.shape)); add("Length", this.fmt(i.length)); add("Position X", this.fmt(i.x)); add("Position Y", this.fmt(i.y)); add("Orientation", D.orientLabel(i.orient)); add("Visible", i.visible ? "Yes" : "No"); }
      else if (n && n[0] === "property") { p.append(h("h4", null, "Field")); add("Name", String(n[1])); add("Text", String(n[2])); }
      else if (n) { p.append(h("h4", null, D.kindLabel(String(n[0])))); }
    } else if (sel.length > 1) p.append(h("h4", null, `${sel.length} items selected`));
    else {
      p.append(h("h4", null, "Symbol"));
      add("Name", M.symName(sym)); add("Reference", M.fieldValue(sym, "Reference")); add("Value", M.fieldValue(sym, "Value")); add("Units", String(M.unitCount(this.rootSym(sym)))); add("Pins", String(M.allPins(sym).length));
    }
    p.append(kv);
  }
  renderMsg(): void {
    const el = this.el.msg; if (!el) return; el.innerHTML = "";
    const sym = this.symbol(); const t = this.tab; if (!sym || !t) return;
    const cell = (k: string, v: string) => el.append(h("div", null, h("b", null, k), h("span", null, v)));
    const sel = [...t.sel]; const n = sel.length === 1 ? nodeOf(sym, sel[0]) : null;
    if (n && n[0] === "pin") {
      const i = M.pinInfo(n);
      cell("Type", "Pin"); cell("Name", i.name); cell("Number", i.number); cell("Type", D.typeLabel(i.type)); cell("Style", D.shapeLabel(i.shape)); cell("Visible", i.visible ? "Yes" : "No");
      cell("Length", this.fmt(i.length)); cell("Orientation", D.orientLabel(i.orient)); cell("Pos X", this.fmt(i.x)); cell("Pos Y", this.fmt(i.y));
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
      const grid = h("select", { id: "se-grid", "aria-label": "Grid" }) as HTMLSelectElement;
      for (const g of GRIDS_MIL) grid.append(h("option", { value: String(g) }, `Grid: ${g} mils (${M.fmt(g * M.MIL)} mm)`));
      grid.addEventListener("change", () => { this.gridMil = Number(grid.value); this.paint(); });
      el.append(h("span", { id: "se-zoom" }), h("span", { id: "se-xy" }), h("span", { id: "se-dxy" }), grid, h("span", { id: "se-units" }), h("span", { id: "se-tool" }));
    }
    (el.querySelector("#se-grid") as HTMLSelectElement).value = String(this.gridMil);
    el.querySelector("#se-zoom")!.textContent = `Z ${(v / 12).toFixed(2)}`;
    el.querySelector("#se-xy")!.textContent = `X ${fmtCoord(fx, this.units)}  Y ${fmtCoord(fy, this.units)}`;
    el.querySelector("#se-dxy")!.textContent = "";
    el.querySelector("#se-units")!.textContent = unitName(this.units);
    el.querySelector("#se-tool")!.textContent = meta(Object.keys(TOOL_ACTIONS).find((k) => TOOL_ACTIONS[k] === this.tool) || "selectionTool").label;
  }

  // ---------------------------------------------------------------- actions
  private _actions: Record<string, (() => void) | undefined> | null = null;
  actions(): Record<string, (() => void) | undefined> {
    if (this._actions) return this._actions;
    const tool = (t: ToolId) => () => this.setTool(t);
    const A: Record<string, (() => void) | undefined> = {
      newLibrary: () => void D.newLibrary(this), addLibrary: () => void D.addLibrary(this),
      openPreferences: () => openPreferences(),
      showSymbolBrowser: () => void this.symbolBrowser(), saveLibraryAs: () => { const l = this.currentLib(); if (l) void D.saveLibraryAs(this, l); },
      newSymbol: () => void D.newSymbol(this), editLibSymbolWithLibEdit: () => { const t = this.tab; if (t && t.origin) void this.editLibrarySymbol(t.origin.libId); },
      save: () => void this.save(), saveSymbolAs: () => void D.saveSymbolAs(this, false), saveSymbolCopyAs: () => void D.saveSymbolAs(this, true), saveAll: () => void this.saveAll(),
      revert: () => { const t = this.tab; if (t && !t.origin) { const l = this.libs.get(t.lib); if (l) void this.revertSymbol(l, t.name); } else if (t && t.origin) void this.revertScratch(); },
      importSymbol: () => { const l = this.currentLib(); if (l && l.kind === "project") void D.importSymbol(this, l); else void messageBox("Select a project library to import into."); },
      exportSymbol: () => void D.exportSymbol(this), exportSymbolView: () => void D.exportPng(this), exportSymbolAsSVG: () => void D.exportSvg(this),
      find: () => openSymbolFind(this, false), findAndReplace: () => openSymbolFind(this, true), findNext: () => void findNextMatch(this), findPrevious: () => void findNextMatch(this, true),
      symbolProperties: () => void D.symbolProperties(this), updateSymbolFields: () => D.updateSymbolFields(this),
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
      toggleSyncedPinsMode: () => { this.syncPins = !this.syncPins; this.renderToolbars(); },
      nextSymbolTab: () => { if (this.tabs.length) { this.cur = (this.cur + 1) % this.tabs.length; this.afterTabChange(); } },
      prevSymbolTab: () => { if (this.tabs.length) { this.cur = (this.cur - 1 + this.tabs.length) % this.tabs.length; this.afterTabChange(); } },
      closeSymbolTab: () => { if (this.cur >= 0) void this.closeTab(this.cur); },
      showDatasheet: () => { const s = this.symbol(); const ds = s ? M.fieldValue(s, "Datasheet") : ""; if (ds && ds !== "~") window.open(/^[a-z]+:/i.test(ds) ? ds : "https://" + ds, "_blank", "noopener"); },
      checkSymbol: () => void D.checker(this),
      rotateCCW: () => this.transformSel("Rotate", (n, c) => M.rotateNode(n, c[0], c[1], true)), rotateCW: () => this.transformSel("Rotate", (n, c) => M.rotateNode(n, c[0], c[1], false)),
      mirrorV: () => this.transformSel("Mirror", (n, c) => M.mirrorNode(n, c[0], c[1], false)), mirrorH: () => this.transformSel("Mirror", (n, c) => M.mirrorNode(n, c[0], c[1], true)),
      addSymbolToSchematic: () => void D.addToSchematic(this),
      toggleGrid: () => { /* the grid is always shown in the symbol editor canvas */ },
      millimetersUnits: () => this.setUnits("mm"), milsUnits: () => this.setUnits("mil"), inchesUnits: () => this.setUnits("in"),
      toggleUnits: () => this.setUnits(this.units === "mm" ? "mil" : "mm"),
      properties: () => this.editSelected(), repeatDrawItem: () => this.repeat(),
      pushPinLength: () => this.pushPin("length"), pushPinNameSize: () => this.pushPin("nameSize"), pushPinNumSize: () => this.pushPin("numSize"),
      move: () => this.startCarry("Move"), drag: () => this.startCarry("Move"),
      listHotKeys: () => void D.hotkeys(),
      cancelInteractive: () => this.cancelInteraction(),
    };
    for (const [id, t] of Object.entries(TOOL_ACTIONS)) A[id] = tool(t);
    return (this._actions = A);
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
  setUnits(u: Units): void { E.units = u; try { localStorage.setItem("kui.units", u); } catch (e) { /* no storage */ } this.renderToolbars(); this.renderMsg(); this.renderStatus(); }
  setTool(t: ToolId): void {
    if ((t !== "select") && this.readOnly()) { this.readOnlyNotice(); return; }
    const sym = this.symbol();
    if (t !== "select" && t !== "pin" && t !== "anchor" && t !== "delete" && sym && M.isDerived(sym)) { void messageBox(`Symbol ${M.symName(sym)} is a derived symbol. Symbol graphics will not be editable.`); return; }
    this.cancelInteraction(); this.tool = t; this.renderToolbars(); this.renderStatus();
    if (this.el.cwrap) this.el.cwrap.style.cursor = t === "select" ? "default" : "crosshair";
  }
  cancelInteraction(): void {
    if (this.carry) { const c = this.carry; this.carry = null; this.preview = null; if (c.amend) { const t = this.tab; if (t && t.undo.length) { const step = t.undo.pop()!; this.store(t, M.node(step.text)); } } }
    this.drag = null; this.draw = null; this.floating = null; this.preview = null; this.kcache = null; this.paint();
  }
  selChanged(): void { this.renderMsg(); this.renderMenus(); this.paint(); }
  selectAll(): void { const t = this.tab; const doc = this.kdoc(); if (!t || !doc) return; t.sel = new Set([...doc.items.values()].filter((i) => i.movable).map((i) => i.id)); this.selChanged(); }
  private selNodes(sym: M.Node): M.Node[] { const t = this.tab; return t ? [...t.sel].map((id) => nodeOf(sym, id)).filter((n): n is M.Node => !!n) : []; }
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
  deleteSel(label = "Delete"): void {
    const t = this.tab; if (!t || !t.sel.size) return;
    this.edit(label, (s) => {
      const ns = this.selNodes(s); const doomed = new Set<M.Node>();
      for (const n of ns) {
        if (n[0] === "property") { if (M.MANDATORY_FIELDS.includes(String(n[1]))) continue; doomed.add(n); continue; }
        doomed.add(n);
        // SYMBOL_EDITOR_EDIT_TOOL::DoDelete: in synchronized pins mode the pin goes from every unit
        if (n[0] === "pin" && this.syncPins) { const i = M.pinInfo(n); const r = M.findRef(s, n); for (const d of M.allPins(s)) { const o = M.pinInfo(d.node); if (d.node !== n && Math.abs(o.x - i.x) < 1e-6 && Math.abs(o.y - i.y) < 1e-6 && r && d.body === r.body) doomed.add(d.node); } }
      }
      for (const n of doomed) { if (n[0] === "property") { const k = s.indexOf(n); if (k > 0) s.splice(k, 1); } else { const r = M.findRef(s, n); if (r) M.removeDrawItem(s, r); } }
      return [];
    });
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
      if (this.edit("Repeat Pin", (s) => { const r = M.placePin(s, p, this.syncPins && p.unit !== 0); const n = M.itemAt(s, r); return n ? [n] : []; })) this.lastRepeat = p;
    };
    const occ = this.syncPins ? M.occupiedBy(sym, p) : null;
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
    else { const n = M.clone(f.node); M.mapPoints(n, () => [x, y]); M.addDrawItem(s, 0, f.body, n); }
    this.preview = s; this.kcache = null;
  }
  /** Second click: PlacePin (occupied-position check in sync mode, image pins) or the text added, as one undo step. */
  private async placeFloating(fx: number, fy: number): Promise<void> {
    const f = this.floating; if (!f) return;
    this.floating = null; this.preview = null; this.kcache = null; this.paint();
    if (f.kind === "text") { const n = M.clone(f.node); M.mapPoints(n, () => [fx, fy]); this.edit("Draw Text", (s) => { M.addDrawItem(s, 0, f.body, n); return [n]; }); return; }
    const res: M.PinInfo = { ...f.pin, x: fx, y: fy };
    const cur = this.symbol(); if (!cur) return;
    const occ = this.syncPins ? M.occupiedBy(cur, res) : null;
    if (occ !== null && !(await confirmBox("Confirmation", M.OCCUPIED_MSG(occ) + "\n\n" + M.OCCUPIED_EXT, "Place Pin Anyway"))) return;
    if (this.edit("Place Pin", (s) => { const r = M.placePin(s, res, this.syncPins && res.unit !== 0); const n = M.itemAt(s, r); return n ? [n] : []; })) { this.lastRepeat = res; }
  }

  // library-level actions ------------------------------------------------------
  async save(): Promise<void> {
    const t = this.tab;
    if (t && t.origin) { await saveToSchematic(this, t); return; }
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
    if (t) { if (had) t.undo.push({ label: "Revert", text: M.text(had) }); t.sel.clear(); }
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
    t.scratch = M.node(t.undo[0].text); t.undo = []; t.redo = []; t.modified = false; t.sel.clear(); this.kcache = null; this.renderAll();
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
  private need(kind: ToolId): number { return kind === "rectangle" || kind === "circle" || kind === "textbox" || kind === "ellipse" ? 2 : kind === "arc" ? 3 : kind === "bezier" || kind === "ellipse_arc" ? 4 : Infinity; }
  private drawClick(fx: number, fy: number, dbl: boolean): void {
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
  private contextMenu(ev: PointerEvent, x: number, y: number): void {
    const t = this.tab; if (!t || !this.symbol()) return;
    if (this.draw) { this.finishDraw(); return; }
    const hit = this.hitAt(x, y); if (hit && !t.sel.has(hit)) { t.sel = new Set([hit]); this.selChanged(); }
    const A = this.actions(); const has = t.sel.size > 0; const can = !this.readOnly();
    const pin = [...t.sel].some((i) => i.startsWith("p:"));
    const a = (id: string, en: boolean, label?: string): MenuEntry => this.act(id, A[id], { enabled: () => en, label });
    const items: MenuEntry[] = [
      a("properties", true, has ? "Properties..." : "Symbol Properties..."), { sep: true },
      a("move", has && can), a("rotateCCW", has && can), a("rotateCW", has && can), a("mirrorV", has && can), a("mirrorH", has && can), { sep: true },
      a("cut", has && can), a("copy", has), a("paste", can && !!this.clip), a("doDelete", has && can), a("duplicate", has && can), { sep: true },
    ];
    if (pin) items.push(a("pushPinLength", can), a("pushPinNameSize", can), a("pushPinNumSize", can), { sep: true });
    items.push(a("selectAll", true), a("zoomFitScreen", true));
    showMenu(ev.clientX, ev.clientY, items);
  }

  // ---------------------------------------------------------------- keys
  private onKey(ev: KeyboardEvent): void {
    if (!this.isOpen) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
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
    const A = this.actions();
    const ids = ["undo", "redo", "save", "newSymbol", "cut", "copy", "paste", "duplicate", "selectAll", "rotateCCW", "rotateCW", "mirrorV", "mirrorH", "move", "drag", "placeSymbolPin", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomRedraw", "showDatasheet", ...(this.symbol() ? ["find"] : []), "selectionTool", "toggleUnits"];
    for (const id of ids) { const k = meta(id).key; if (k && norm(k) === norm(combo) && A[id]) return run(A[id]); }
    if (combo === "Home") return run(() => this.zoomFit());
  }
}
const norm = (k: string) => k.replace(/\s/g, "").toLowerCase().replace("delete", "del").replace("insert", "ins");

export const editor = new SymbolEditor();
export { download };
