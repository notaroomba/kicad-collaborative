// dialogs/prefs.ts — the web editor's preferences (Preferences… dialog): stored in localStorage under "kui.prefs",
// applied live.  Defaults are KiCad's (common/settings/app_settings.cpp, eeschema/eeschema_settings.cpp).
import { E, GRID_CHOICES, isSch, requestRender, setToggle, setToggles, store, toolCtx, updateGridStatus } from "./editor";
import { syncSchModes } from "../editor/panes";
import { PCB_GRID_OVERRIDES, SCH_GRID_OVERRIDES, gridPitchFor, schGridClassOfKind, schGridClassOfTool, type GridOverrides } from "./logic";

export type EditorId = "sch" | "pcb";
export interface GridPrefs { sizes: number[]; fast1: number; fast2: number; overrides: GridOverrides }
export interface Prefs {
  mouse: { autoZoomSpeed: boolean; zoomSpeed: number; middleDrag: "pan" | "none"; rightDrag: "pan" | "none"; centerOnZoom: boolean };
  schDisplay: { showHiddenPins: boolean; showHiddenFields: boolean; showPageLimits: boolean };
  schEditing: { lineMode: "free" | "90" | "45"; mouseDragIsDrag: boolean; autoAnnotate: boolean };
  schColors: { theme: "default" | "classic" };
  pcbDisplay: { showPadNumbers: boolean; showNetNames: boolean; showPageLimits: boolean; highContrast: boolean };
  grids: Record<EditorId, GridPrefs>;
}
const MIL = 0.0254;
export const DEFAULT_PREFS: Prefs = {
  mouse: { autoZoomSpeed: true, zoomSpeed: 5, middleDrag: "pan", rightDrag: "pan", centerOnZoom: true },
  schDisplay: { showHiddenPins: false, showHiddenFields: false, showPageLimits: true },
  schEditing: { lineMode: "90", mouseDragIsDrag: true, autoAnnotate: true },
  schColors: { theme: "default" },
  pcbDisplay: { showPadNumbers: true, showNetNames: false, showPageLimits: true, highContrast: false },
  grids: {
    // EESCHEMA_SETTINGS::DefaultGridSizeList is 100 / 50 / 25 / 10 mil; the web editor has always opened on 50 mil
    sch: { sizes: [100 * MIL, 50 * MIL, 25 * MIL, 10 * MIL], fast1: 1, fast2: 2, overrides: SCH_GRID_OVERRIDES },
    pcb: { sizes: [0.25, 0.5, 1, 0.1, 0.05, 1.27, 0.635], fast1: 0, fast2: 1, overrides: PCB_GRID_OVERRIDES },
  },
};
const KEY = "kui.prefs";
function merge<T>(def: T, got: unknown): T {
  if (Array.isArray(def)) return (Array.isArray(got) && got.length ? got : def) as T;
  if (def && typeof def === "object") { const out: Record<string, unknown> = {}; const g = (got && typeof got === "object" ? got : {}) as Record<string, unknown>; for (const [k, v] of Object.entries(def)) out[k] = merge(v, g[k]); return out as T; }
  return (typeof got === typeof def ? got : def) as T;
}
let cache: Prefs | null = null;
export function prefs(): Prefs {
  if (cache) return cache;
  let raw: unknown = null; try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { raw = null; }
  cache = merge(DEFAULT_PREFS, raw); return cache;
}
export function savePrefs(p: Prefs): void {
  cache = merge(DEFAULT_PREFS, p); try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* no storage */ }
  applyPrefs(true);
  const g = cache.grids[editorId()]; if (E.kdoc && !g.sizes.some((mm) => Math.abs(mm - E.gridPitch) < 1e-6)) { E.gridPitch = g.sizes[0]; updateGridStatus(); }
}
export function clonePrefs(): Prefs { return JSON.parse(JSON.stringify(prefs())) as Prefs; }

/** "50 mil" for whole mils, "0.25 mm" otherwise (GRID::MessageText in the editor's units). */
export function gridLabel(mm: number): string { const mils = mm / MIL; return Math.abs(mils - Math.round(mils)) < 1e-6 ? `${Math.round(mils)} mil` : `${+mm.toFixed(4)} mm`; }
export function editorId(): EditorId { return isSch() ? "sch" : "pcb"; }

// ---- colour themes (common/settings/builtin_color_themes.h): the schematic layers kicad-canvas paints from K.SCH
const CLASSIC: Record<string, string> = { bg: "#FFFFFF", grid: "#848484", wire: "#008400", bus: "#000084", junction: "#008400", outline: "#840000", body: "#FFFFC2", pin: "#840000", pinName: "#008484", pinNum: "#840000",
  ref: "#008484", value: "#008484", field: "#840084", label: "#000000", glabel: "#840000", hlabel: "#848400", sheet: "#840084", sheetName: "#008484", sheetFile: "#848400", sheetFields: "#840084", sheetLabel: "#008484",
  noconnect: "#000084", notes: "#0000C2", busEntry: "#008400", netclass: "#000000", frame: "#840000", pageLimits: "#C2C2C2" };
let defaultSch: Record<string, string> | null = null, themeOn = "default", themedDoc: unknown = null;
export const COLOR_THEMES: [Prefs["schColors"]["theme"], string][] = [["default", "KiCad Default"], ["classic", "KiCad Classic"]];
function applyColorTheme(theme: string): void {
  const SCH = KiCadCanvas.SCH; if (!SCH) return;
  if (!defaultSch) defaultSch = Object.assign({}, SCH);
  Object.assign(SCH, defaultSch, theme === "classic" ? CLASSIC : {});
  // geometry carries its colour from the moment it is built: a theme change (or a document parsed under the other
  // theme) rebuilds the schematic's items
  const doc = E.kdoc as KDoc | null;
  if (doc && doc.type === "sch" && (theme !== themeOn || (themedDoc !== doc && theme !== "default"))) for (const it of doc.items.values()) { try { KiCadCanvas.replaceChange(doc, it); } catch (e) { /* an item without geometry */ } }
  themeOn = theme; themedDoc = doc;
}

/** The pitch the cursor snaps to right now: the grid override of the active tool (or of the item being dragged), else the current grid. */
export function activeGridPitch(): number {
  const cur = E.gridPitch as number; if (!isSch()) return cur;
  const o = prefs().grids.sch.overrides; if (!o.enabled) return cur;
  let cls = schGridClassOfTool(String(E.tool));
  if (!cls && E.tool === "select") {
    const id = E.fdrag ? null : E.drag && E.drag.fp ? E.drag.fp.id : null;
    if (E.fdrag) cls = "text"; else { const it = id && E.kdoc ? E.kdoc.items.get(id) : null; if (it) cls = schGridClassOfKind(it.kind); }
  }
  return gridPitchFor(cls, o, cur);
}

/**
 * Push the preferences into the running editor.  `full` also sets the display toggles and the schematic's editing
 * modes (after OK in the dialog, and once when the page's first document opens) — otherwise a toolbar toggle made
 * since would be undone every time a sheet is entered.
 */
export function applyPrefs(full = true): void {
  const p = prefs();
  // KiCad's zoom speed slider is 1..10; "automatic" is the wheel factor the web editor has always used
  E.zoomStep = p.mouse.autoZoomSpeed ? 1.0018 : 1.0006 + 0.0004 * Math.max(1, Math.min(10, p.mouse.zoomSpeed));
  E.middleDragPan = p.mouse.middleDrag !== "none"; E.rightDragPan = p.mouse.rightDrag !== "none";
  E.gridFor = activeGridPitch;
  applyColorTheme(p.schColors.theme);
  const ed = editorId(), g = p.grids[ed];
  if (E.kdoc) {
    const choices = g.sizes.map((mm) => [mm, gridLabel(mm)] as [number, string]);
    GRID_CHOICES[isSch() ? "kicad_sch" : "kicad_pcb"] = choices;
    store.slice("viewport", { gridChoices: choices.map((c) => c.slice()) });
    if (!full) { /* grids and colours only */ }
    else if (isSch()) {
      E.renderOpts.showHiddenPins = p.schDisplay.showHiddenPins; E.renderOpts.showHiddenText = p.schDisplay.showHiddenFields; E.renderOpts.pageLimits = p.schDisplay.showPageLimits;
      setToggles({ toggleHiddenPins: p.schDisplay.showHiddenPins, showHiddenText: p.schDisplay.showHiddenFields });
      const sch = CollabTools.sch;
      if (sch) { try { const ctx = toolCtx(); sch.setLineMode(ctx, p.schEditing.lineMode); sch.setDragMode(ctx, p.schEditing.mouseDragIsDrag ? "drag" : "move"); sch.state.annotateAuto = p.schEditing.autoAnnotate; syncSchModes(); } catch (e) { console.warn(e); } }
    } else {
      E.renderOpts.padNumbers = p.pcbDisplay.showPadNumbers; E.renderOpts.netNames = p.pcbDisplay.showNetNames; E.renderOpts.highContrast = p.pcbDisplay.highContrast; E.renderOpts.pageLimits = p.pcbDisplay.showPageLimits;
      setToggles({ showPadNumbers: p.pcbDisplay.showPadNumbers, showNetNames: p.pcbDisplay.showNetNames, highContrastMode: p.pcbDisplay.highContrast });
    }
    if (full) store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) });
  }
  setToggle("toggleGridOverrides", p.grids[ed].overrides.enabled);
  updateGridStatus(); requestRender();
}
export function toggleGridOverrides(): boolean {
  const p = clonePrefs(), ed = editorId(); p.grids[ed].overrides.enabled = !p.grids[ed].overrides.enabled; savePrefs(p); return p.grids[ed].overrides.enabled;
}
/** Alt+1 / Alt+2: KiCad's fast grid switching. */
export function fastGrid(n: 1 | 2): number | null {
  const g = prefs().grids[editorId()], mm = g.sizes[n === 1 ? g.fast1 : g.fast2]; if (!mm) return null;
  E.gridPitch = mm; updateGridStatus(); requestRender(); return mm;
}
