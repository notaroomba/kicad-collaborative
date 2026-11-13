// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { setToggles, store } from "./appstore";
import { refreshCrosshair } from "./crosshair";
import { getThemeMode, initTheme, setThemeMode, subscribeTheme, toggleTheme } from "../theme";
import type { ThemeMode } from "../theme";
import { $ } from "./dom";
import { filters } from "./selection";
import { E } from "./state";
import { renderModuleTools } from "./tools";
import { UNITS, setRadio } from "./util";
import { isSch, requestRender } from "./view";
import { loadUnits, saveUnits, unitsAppFor } from "../units";
// ================================================================ KiCad frame (the React chrome reads the store)
// Docked panes: which are open, per editor, remembered in localStorage (kui.panes.<editor>).
export const PANE_NAMES = ["props", "hier", "filter", "history", "peers", "comments", "appearance", "search", "netnav", "libtree"];

export const PANE_EDITOR_ONLY: Record<string, "sch" | "pcb" | undefined> = { hier: "sch", netnav: "sch" };

import { PANE_DEFAULT_HIDDEN } from "../tables";
export { PANE_DEFAULT_HIDDEN };


export const editorId = () => (isSch() ? "sch" : "pcb");

export const paneKey = (ed: string | null | undefined) => "kui.panes." + (ed || "x");

export function savedPanes(ed: string): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(paneKey(ed)) || "{}"); } catch (e) { return {}; } }

export function loadPanes(ed: "sch" | "pcb") {
  const saved = savedPanes(ed), out: Record<string, boolean> = {};
  for (const n of PANE_NAMES) { const allowed = n === "libtree" ? E.DOC_TYPE === "footprint" : !PANE_EDITOR_ONLY[n] || PANE_EDITOR_ONLY[n] === ed; out[n] = allowed && (saved[n] !== undefined ? !!saved[n] : !PANE_DEFAULT_HIDDEN[ed].includes(n)); }
  out.filter = filterFollows(out, ed);
  return out;
}

/**
 * The Selection Filter has no visibility of its own in KiCad: eeschema shows it whenever the Hierarchy, the Net
 * Navigator or Properties is shown (SCH_EDIT_FRAME::updateSelectionFilterVisbility), the board and footprint editors
 * with the Layers Manager (pcb_edit_frame.cpp:455, footprint_edit_frame.cpp:548).
 */
export function filterFollows(panes: Record<string, boolean>, ed: "sch" | "pcb"): boolean {
  return ed === "sch" ? !!(panes.hier || panes.netnav || panes.props) : !!panes.appearance;
}

(E.hooks as Record<string, unknown>).showPane = (name: string, show?: unknown): void => showPane(name, show);   // dialogs/find.ts's "Show search panel"
export function showPane(name: string, show?: unknown) {
  const ed = editorId();
  if (!PANE_NAMES.includes(name) || (PANE_EDITOR_ONLY[name] && PANE_EDITOR_ONLY[name] !== ed) || (name === "libtree" && E.DOC_TYPE !== "footprint")) return;
  if (name === "filter") return;   // follows the panes it docks with (filterFollows)
  const next = show === undefined ? !E.panes[name] : !!show;
  E.panes = Object.assign({}, E.panes, { [name]: next });
  E.panes.filter = filterFollows(E.panes, ed);
  const saved = savedPanes(ed); saved[name] = next; delete saved.filter;
  try { localStorage.setItem(paneKey(ed), JSON.stringify(saved)); } catch (e) { /* no storage */ }
  store.set({ panes: E.panes });
  requestRender();
}

// Theme: owned by web/theme.ts; the Preferences > Appearance entries show the chosen mode as checked.
export function applyTheme() {
  initTheme();
  const sync = () => { const m = getThemeMode(); setToggles({ themeLight: m === "light", themeDark: m === "dark", themeSystem: m === "system" }); };
  sync(); subscribeTheme(sync);
}

export { toggleTheme };

export function setTheme(mode: ThemeMode) { setThemeMode(mode); }


export function setupEditorChrome() {
  const ed = editorId();
  document.body.dataset.editor = ed;
  filters[ed] = filters[ed] || {};
  E.panes = loadPanes(ed);
  // each KiCad application keeps its own system.units and system.last_imperial_units
  const us = loadUnits(unitsAppFor(E.DOC_TYPE)); E.units = us.units; E.lastImperial = us.lastImperial;
  renderModuleTools();
  store.set({ document: Object.assign({}, store.get().document, { editor: ed, docType: E.DOC_TYPE }), panes: Object.assign({}, E.panes), filter: Object.assign({}, filters[ed]) });
  setRadio("Units", ({ mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" } as Record<string, string>)[E.units]);
  setRadio("Selection modes", E.selMode === "lasso" ? "selectSetLasso" : "selectSetRect");
  setRadio("Crosshair modes", E.crosshairMode === "full" ? "cursorFullCrosshairs" : E.crosshairMode === "45" ? "cursor45Crosshairs" : "cursorSmallCrosshairs");
  setToggles({ toggleGrid: E.gridOn, togglePolarCoords: E.polarCoords, toggleHiddenPins: !!E.renderOpts.showHiddenPins, highContrastMode: !!E.renderOpts.highContrast,
    padDisplayMode: !!E.renderOpts.outlinePads, viaDisplayMode: !!E.renderOpts.outlineVias, trackDisplayMode: !!E.renderOpts.outlineTracks,
    zoneDisplayFilled: !E.renderOpts.zoneOutline, zoneDisplayOutline: !!E.renderOpts.zoneOutline });
  syncSchModes();
  store.slice("viewport", { units: E.units, lastImperial: E.lastImperial || "mil", selMode: E.selMode, crosshair: E.crosshairMode, polar: E.polarCoords, renderOpts: Object.assign({}, E.renderOpts), gridPitch: E.gridPitch, zoom: E.zoom, cursor: [0, 0], origin: E.localOrigin.slice() });
  store.slice("tool", { current: E.tool });
}

// The schematic module owns its line / drag modes (Shift+Space, G, M); mirror them on the toolbar.
/** The angle snap mode the board tools will read for this frame (tools/pcb-tools/draw-modes.ts angleSnapMode). */
export function storedAngleSnap(): string {
  const fp = E.DOC_TYPE === "footprint";
  let v: string | null = null; try { v = localStorage.getItem(fp ? "kc.fpedit.angleSnapMode" : "kc.pcbnew.angleSnapMode"); } catch (e) { v = null; }
  return v === "free" || v === "45" || v === "90" ? v : fp ? "45" : "free";
}
export function syncSchModes() {
  if (!isSch()) {   // the board's angle snap mode (PCBNEW_SETTINGS m_AngleSnapMode) on the same radio
    const pt = (window as unknown as { PcbTools?: { angleSnapMode?: () => string } }).PcbTools;
    // until the board tools load, the stored mode, else KiCad's default: pcbnew_settings.cpp pcb_angle_snap_mode
    // LEADER_MODE::DIRECT (Free), footprint_editor_settings.cpp:57 LEADER_MODE::DEG45
    const am = (pt && pt.angleSnapMode ? pt.angleSnapMode() : null) || storedAngleSnap();
    setRadio("Line modes", am === "free" ? "lineModeFree" : am === "45" ? "lineMode45" : "lineMode90");
    store.slice("viewport", { lineMode: am === "free" || am === "45" || am === "90" ? am : null, dragMode: null }); return;
  }
  if (!CollabTools.sch || !CollabTools.sch.state) { store.slice("viewport", { lineMode: null, dragMode: null }); return; }
  const lm = CollabTools.sch.state.lineMode;
  // Annotate Automatically (sch_edit_frame.cpp:1102 CHECK(m_AnnotatePanel.automatic), on by default)
  setToggles({ toggleAnnotateAuto: (CollabTools.sch.state as { annotateAuto?: boolean }).annotateAuto !== false });
  setRadio("Line modes", lm === "free" ? "lineModeFree" : lm === "45" ? "lineMode45" : "lineMode90");
  store.slice("viewport", { lineMode: lm === "free" ? "free" : lm === "45" ? "45" : "90", dragMode: (CollabTools.sch.state.dragMode || null) as "move" | "drag" | null });
}

if (typeof window !== "undefined") {
  window.addEventListener("kc:pcb-linemode", () => syncSchModes());
  // a module action run from a hotkey or a toolbar button may flip a mode the toolbar mirrors (Annotate Automatically)
  window.addEventListener("kc:action", () => syncSchModes());
}

/**
 * EDA_DRAW_FRAME::ChangeUserUnits: every way of switching (the left toolbar's Units group, Ctrl+U) ends here.  It
 * remembers the imperial unit (COMMON_TOOLS::SetLastUnits) for Ctrl+U and the metric lists' second column, keeps the
 * choice for the next visit, and the toolbars, status bar and dialogs re-format from the store.
 */
export function setUnitsAction(u: string, id: string) {
  if (UNITS[u]) E.units = u;
  if (E.units === "in" || E.units === "mil") E.lastImperial = E.units;
  saveUnits(unitsAppFor(E.DOC_TYPE), { units: E.units as "mm", lastImperial: (E.lastImperial || "mil") as "mil" });
  setRadio("Units", id); store.slice("viewport", { units: E.units, lastImperial: E.lastImperial || "mil" });
}

export function setCrosshair(mode: "small" | "full" | "45", id: string) { E.crosshairMode = mode; setRadio("Crosshair modes", id); store.slice("viewport", { crosshair: mode }); refreshCrosshair(); }
