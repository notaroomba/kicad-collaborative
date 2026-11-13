// dialogs/prefs.ts — the web editor's preferences (Preferences… dialog): stored in localStorage under "kui.prefs",
// applied live.  Defaults are KiCad's (common/settings/app_settings.cpp, eeschema/eeschema_settings.cpp).
import { E, GRID_CHOICES, gridListKey, isSch, requestRender, setToggle, setToggles, store, toolCtx, updateGridStatus } from "./editor";
import { syncSchModes } from "../editor/panes";
import { publishUserOrigin } from "../editor/userorigin";
import { effectiveTheme, subscribeTheme } from "../theme";
import { PCB_GRID_OVERRIDES, SCH_GRID_OVERRIDES, gridPitchFor, schGridClassOfKind, schGridClassOfTool, type GridOverrides } from "./logic";
import { gridChoiceText, type GridDef, type IuScale } from "../units";
import type { Units } from "../store";

/** The KiCad frame whose window settings keep a grid list: eeschema, pcbnew, the symbol editor and the footprint editor each have their own. */
export type EditorId = "sch" | "pcb" | "sym" | "fp";
/** The internal-unit scale an editor formats with: the schematic and symbol editors use eeschema's, the board editors pcbnew's. */
export const scaleOf = (ed: EditorId): IuScale => (ed === "sch" || ed === "sym" ? "sch" : "pcb");
export type SchThemeId = "default" | "classic" | "dark";
/**
 * WINDOW_SETTINGS::grid: the grid list in KiCad's order (sizes in mm, square grids; names[i] is GRID::name, "" when
 * unnamed), last = grid.last_size (the grid the editor opens on), fast1 / fast2 = Alt+1 / Alt+2, axes = axes_enabled.
 */
export interface GridPrefs { sizes: number[]; names?: string[]; last?: number; fast1: number; fast2: number; overrides: GridOverrides; axes?: boolean }
export interface Prefs {
  mouse: { autoZoomSpeed: boolean; zoomSpeed: number; middleDrag: "pan" | "none"; rightDrag: "pan" | "none"; centerOnZoom: boolean };
  schDisplay: { showHiddenPins: boolean; showHiddenFields: boolean; showPageLimits: boolean };
  schEditing: { lineMode: "free" | "90" | "45"; mouseDragIsDrag: boolean; autoAnnotate: boolean };
  /** the schematic canvas colours (Preferences > Schematic Editor > Colors): a theme, and whether a dark UI swaps in the dark sheet */
  schColors: { theme: SchThemeId; followDark: boolean };
  /** the inactive layer mode is not here: it is the project's ("board.high_contrast_mode", Appearance panel) */
  pcbDisplay: { showPadNumbers: boolean; showNetNames: boolean; showPageLimits: boolean;
    /** pcb_display.track_clearance_mode: 0 do not show, 1 while routing, 2 with via while routing (default), 3 while routing and editing, 4 always */
    trackClearance: number;
    /** pcb_display.pad_clearance: Show pad clearance (on by default) */
    padClearance?: boolean };
  /** COMMON_SETTINGS appearance.hicontrast_dimming_factor (0.8) */
  common: { hcDimming: number };
  /** PCB Editor > Origins & Axes (PCBNEW_SETTINGS m_Display.m_DisplayOrigin, m_DisplayInvertXAxis / YAxis) */
  pcbOrigin: { origin: "page" | "aux" | "grid"; invertX: boolean; invertY: boolean };
  /** PCB Editor > Editing Options (PCBNEW_SETTINGS): m_AutoRefillZones */
  pcbEditing: { autoRefillZones: boolean };
  grids: Record<EditorId, GridPrefs>;
}
const MIL = 0.0254;
function schGrids(): GridPrefs { return { sizes: [100 * MIL, 50 * MIL, 25 * MIL, 10 * MIL], names: ["", "", "", ""], last: 1, fast1: 1, fast2: 2, overrides: { ...SCH_GRID_OVERRIDES }, axes: false }; }
function pcbGrids(): GridPrefs { return { sizes: PCB_GRID_SIZES.slice(), names: Array(22).fill(""), last: 15, fast1: 15, fast2: 16, overrides: { ...PCB_GRID_OVERRIDES }, axes: false }; }
/** APP_SETTINGS_BASE::DefaultGridSizeList for pcbnew and the footprint editor: 1000 mil down to 1 mil, then 5 mm down to 0.01 mm. */
const PCB_GRID_SIZES = [1000, 500, 250, 200, 100, 50, 25, 20, 10, 5, 2, 1].map((m) => m * MIL).concat([5, 2.5, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.01]);
export const DEFAULT_PREFS: Prefs = {
  mouse: { autoZoomSpeed: true, zoomSpeed: 5, middleDrag: "pan", rightDrag: "pan", centerOnZoom: true },
  schDisplay: { showHiddenPins: false, showHiddenFields: false, showPageLimits: true },
  schEditing: { lineMode: "90", mouseDragIsDrag: true, autoAnnotate: true },
  schColors: { theme: "default", followDark: false },
  pcbDisplay: { showPadNumbers: true, showNetNames: true, showPageLimits: true, trackClearance: 2, padClearance: true },
  common: { hcDimming: 0.8 },
  pcbOrigin: { origin: "page", invertX: false, invertY: false },
  pcbEditing: { autoRefillZones: false },
  grids: {
    // APP_SETTINGS_BASE::DefaultGridSizeList and addParamsForWindow's defaultGridIdx (common/settings/app_settings.cpp):
    // eeschema / symbol_editor 100, 50, 25, 10 mil on 50 mil (index 1); pcbnew / footprint editor the 22 grids from
    // 1000 mil down to 0.01 mm on index 15 (0.5 mm), fast grids on that index and the next
    sch: schGrids(),
    pcb: pcbGrids(),
    sym: schGrids(),
    fp: pcbGrids(),
  },
};
const KEY = "kui.prefs";
function merge<T>(def: T, got: unknown): T {
  if (Array.isArray(def)) return (Array.isArray(got) && got.length ? got : def) as T;
  if (def && typeof def === "object") { const out: Record<string, unknown> = {}; const g = (got && typeof got === "object" ? got : {}) as Record<string, unknown>; for (const [k, v] of Object.entries(def)) out[k] = merge(v, g[k]); return out as T; }
  return (typeof got === typeof def ? got : def) as T;
}
let cache: Prefs | null = null;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
/** The board grid list and overrides the web editor kept before it took KiCad's list (no grid.last_size then). */
const LEGACY_PCB_SIZES = [0.25, 0.5, 1, 0.1, 0.05, 1.27, 0.635];
const OV_KEYS = ["connected", "wires", "vias", "text", "graphics"] as const;
/**
 * Settings saved before the grids kept grid.last_size: the editor opened the schematic on its second grid and the
 * board on its first.  An untouched old board list becomes KiCad's 22 grids with the same grid, fast grids and
 * override sizes picked again by value; a list the user changed is kept and opens on its first grid as before.
 */
function migrate(raw: unknown): unknown {
  const grids = raw && typeof raw === "object" ? (raw as { grids?: Record<string, Record<string, unknown>> }).grids : undefined;
  if (!grids || typeof grids !== "object") return raw;
  const sch = grids.sch; if (sch && typeof sch === "object" && typeof sch.last !== "number") sch.last = 1;
  const pcb = grids.pcb; if (!pcb || typeof pcb !== "object" || typeof pcb.last === "number") return raw;
  const sizes = Array.isArray(pcb.sizes) ? (pcb.sizes as unknown[]).map(Number) : [];
  if (sizes.length === LEGACY_PCB_SIZES.length && sizes.every((mm, i) => near(mm, LEGACY_PCB_SIZES[i]))) {
    const at = (i: unknown, fallback: number): number => { const mm = sizes[Number(i)]; const k = mm === undefined ? -1 : PCB_GRID_SIZES.findIndex((x) => near(x, mm)); return k >= 0 ? k : fallback; };
    pcb.sizes = PCB_GRID_SIZES.slice(); pcb.names = Array(PCB_GRID_SIZES.length).fill("");
    pcb.last = at(0, 15); pcb.fast1 = at(pcb.fast1, 15); pcb.fast2 = at(pcb.fast2, 16);
    const o = pcb.overrides as Record<string, unknown> | undefined;
    // the old overrides were all 0.25 mm: they take KiCad's sizes, keeping which ones are on
    if (o && typeof o === "object" && OV_KEYS.every((k) => near(Number(o[k + "Mm"]), 0.25))) for (const k of OV_KEYS) o[k + "Mm"] = (PCB_GRID_OVERRIDES as unknown as Record<string, number>)[k + "Mm"];
  } else pcb.last = 0;
  return raw;
}
/** names[] runs beside sizes[] (settings saved before grids had names have none) */
function normalize(p: Prefs): Prefs { for (const g of Object.values(p.grids)) { const n = g.names || []; g.names = g.sizes.map((_, i) => (typeof n[i] === "string" ? n[i] : "")); } return p; }
export function prefs(): Prefs {
  if (cache) return cache;
  let raw: unknown = null; try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { raw = null; }
  cache = normalize(merge(DEFAULT_PREFS, migrate(raw))); return cache;
}
export function savePrefs(p: Prefs): void {
  cache = normalize(merge(DEFAULT_PREFS, p)); try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* no storage */ }
  applyPrefs(true);
  // the Grids page's list selection is the current grid (PANEL_GRID_SETTINGS::TransferDataFromWindow sets grid.last_size)
  if (E.kdoc) { const mm = defaultGrid(); if (Math.abs(mm - E.gridPitch) > 1e-9) { E.gridPitch = mm; updateGridStatus(); requestRender(); } }
  // the Symbol Editor frame re-reads its own grids
  try { window.dispatchEvent(new Event("kc:prefs")); } catch (e) { /* no window */ }
}
export function clonePrefs(): Prefs { return JSON.parse(JSON.stringify(prefs())) as Prefs; }

/** The grids of one editor as KiCad's GRID list: size and name, in the list's order. */
export function gridDefs(g: GridPrefs): GridDef[] { return g.sizes.map((mm, i) => ({ mm, name: (g.names && g.names[i]) || "" })); }
/** GRID_MENU::BuildChoiceList's text for one grid, in the editor's current units ("1.2700 mm (50.00 mils)"). */
export function gridLabel(g: GridDef | number, ed: EditorId = editorId()): string {
  const units = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
  return gridChoiceText(typeof g === "number" ? { mm: g } : g, units, (E.lastImperial === "in" ? "in" : "mil") as Units, scaleOf(ed));
}
/** COMMON_TOOLS::GridProperties: the Preferences page of each frame's grids. */
export const GRID_PAGE: Record<EditorId, string> = { sch: "Schematic Editor/Grids", pcb: "PCB Editor/Grids", sym: "Symbol Editor/Grids", fp: "Footprint Editor/Grids" };
/** The document's editor: the schematic, the board, or the Footprint Editor for a footprint (the Symbol Editor frame passes "sym" itself). */
export function editorId(): EditorId { return isSch() ? "sch" : E.DOC_TYPE === "footprint" ? "fp" : "pcb"; }
/** The grid the editor opens on (grid.last_size). */
export function defaultGrid(ed: EditorId = editorId()): number { const g = prefs().grids[ed]; return g.sizes[Math.max(0, Math.min(g.sizes.length - 1, g.last ?? 0))]; }
/** Remember the grid picked (KiCad saves grid.last_size with the window settings); nothing else is re-applied. */
export function rememberGrid(mm: number, ed: EditorId = editorId()): void {
  const p = prefs(), g = p.grids[ed], i = g.sizes.findIndex((x) => Math.abs(x - mm) < 1e-9); if (i < 0 || g.last === i) return;
  g.last = i; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* no storage */ }
}

// ---- colour themes: the palettes and the switch live in web/canvas/colors.ts (KiCadCanvas.setSchTheme); the painters
// rebuild geometry built under another theme.  Exports and plots keep KiCad Default unless they are told otherwise.
export const COLOR_THEMES: [SchThemeId, string][] = [["default", "KiCad Default"], ["classic", "KiCad Classic"], ["dark", "Dark"]];
/** The schematic theme the canvas should show: the chosen one, or the dark sheet while the UI is dark and the user asked to follow it. */
export function schThemeFor(p: Prefs, ui: "light" | "dark" = effectiveTheme()): SchThemeId {
  const t = COLOR_THEMES.some(([id]) => id === p.schColors.theme) ? p.schColors.theme : "default";
  return p.schColors.followDark && ui === "dark" ? "dark" : t;
}
let followingUi = false;
function applyColorTheme(p: Prefs): void {
  if (typeof KiCadCanvas === "undefined" || !KiCadCanvas.setSchTheme) return;
  if (KiCadCanvas.setSchTheme(schThemeFor(p))) requestRender();
  // with "follow the app's dark mode" on, a UI theme change (menu, other tab, the system) swaps the sheet too
  if (!followingUi) { followingUi = true; subscribeTheme(() => applyColorTheme(prefs())); }
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
  applyColorTheme(p);
  E.pcbOrigin = p.pcbOrigin; publishUserOrigin();
  const ed = editorId(), g = p.grids[ed];
  if (E.kdoc) {
    const choices = gridDefs(g);
    GRID_CHOICES[gridListKey()] = choices;
    store.slice("viewport", { gridChoices: choices.map((c) => ({ ...c })) });
    E.renderOpts.gridAxes = !!g.axes;
    if (!full) { /* grids and colours only */ }
    else if (isSch()) {
      E.renderOpts.showHiddenPins = p.schDisplay.showHiddenPins; E.renderOpts.showHiddenFields = p.schDisplay.showHiddenFields; E.renderOpts.pageLimits = p.schDisplay.showPageLimits;
      setToggles({ toggleHiddenPins: p.schDisplay.showHiddenPins, toggleHiddenFields: p.schDisplay.showHiddenFields });
      const sch = CollabTools.sch;
      if (sch) { try { const ctx = toolCtx(); sch.setLineMode(ctx, p.schEditing.lineMode); sch.setDragMode(ctx, p.schEditing.mouseDragIsDrag ? "drag" : "move"); sch.state.annotateAuto = p.schEditing.autoAnnotate; syncSchModes(); } catch (e) { console.warn(e); } }
    } else {
      E.renderOpts.padNumbers = p.pcbDisplay.showPadNumbers; E.renderOpts.netNames = p.pcbDisplay.showNetNames; E.renderOpts.pageLimits = p.pcbDisplay.showPageLimits;
      (E.renderOpts as { hcDimming?: number }).hcDimming = p.common.hcDimming;
      const pcbS = CollabTools.pcb && (CollabTools.pcb.state as { trackClearance?: number; padClearance?: boolean }); if (pcbS) { pcbS.trackClearance = p.pcbDisplay.trackClearance; pcbS.padClearance = p.pcbDisplay.padClearance !== false; }
      setToggles({ showPadNumbers: p.pcbDisplay.showPadNumbers, showNetNames: p.pcbDisplay.showNetNames });
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
  E.gridPitch = mm; rememberGrid(mm); updateGridStatus(); requestRender(); return mm;
}
