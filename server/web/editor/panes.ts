// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setToggles, store } from "./appstore";
import { $ } from "./dom";
import { filters } from "./selection";
import { E } from "./state";
import { renderModuleTools } from "./tools";
import { UNITS, setRadio } from "./util";
import { isSch, requestRender } from "./view";
// ================================================================ KiCad frame (the React chrome reads the store)
// Docked panes: which are open, per editor, remembered in localStorage (kui.panes.<editor>).
export const PANE_NAMES = ["props", "hier", "filter", "history", "peers", "comments", "appearance"];

export const PANE_EDITOR_ONLY = { hier: "sch" };

export const PANE_DEFAULT_HIDDEN = { sch: ["peers", "comments", "appearance"], pcb: ["peers", "comments"] };


export const editorId = () => (isSch() ? "sch" : "pcb");

export const paneKey = (ed) => "kui.panes." + (ed || "x");

export function savedPanes(ed) { try { return JSON.parse(localStorage.getItem(paneKey(ed)) || "{}"); } catch (e) { return {}; } }

export function loadPanes(ed) {
  const saved = savedPanes(ed), out = {};
  for (const n of PANE_NAMES) { const allowed = !PANE_EDITOR_ONLY[n] || PANE_EDITOR_ONLY[n] === ed; out[n] = allowed && (saved[n] !== undefined ? !!saved[n] : !PANE_DEFAULT_HIDDEN[ed].includes(n)); }
  return out;
}

export function showPane(name, show) {
  const ed = editorId();
  if (!PANE_NAMES.includes(name) || (PANE_EDITOR_ONLY[name] && PANE_EDITOR_ONLY[name] !== ed)) return;
  const next = show === undefined ? !E.panes[name] : !!show;
  E.panes = Object.assign({}, E.panes, { [name]: next });
  const saved = savedPanes(ed); saved[name] = next;
  try { localStorage.setItem(paneKey(ed), JSON.stringify(saved)); } catch (e) { /* no storage */ }
  store.set({ panes: E.panes });
  requestRender();
}

// Theme (kui.theme): light/dark override of the system preference.
export function applyTheme() {
  const saved = (() => { try { return localStorage.getItem("kui.theme"); } catch (e) { return null; } })();
  if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
}

export function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kui.theme", next); } catch (e) { /* no storage */ }
}


export function setupEditorChrome() {
  const ed = editorId();
  document.body.dataset.editor = ed;
  filters[ed] = filters[ed] || {};
  E.panes = loadPanes(ed);
  renderModuleTools();
  store.set({ document: Object.assign({}, store.get().document, { editor: ed, docType: E.DOC_TYPE }), panes: Object.assign({}, E.panes), filter: Object.assign({}, filters[ed]) });
  setRadio("Units", { mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" }[E.units]);
  setRadio("Selection modes", E.selMode === "lasso" ? "selectSetLasso" : "selectSetRect");
  setRadio("Crosshair modes", E.crosshairMode === "full" ? "cursorFullCrosshairs" : E.crosshairMode === "45" ? "cursor45Crosshairs" : "cursorSmallCrosshairs");
  $("#crosshair").classList.toggle("on", E.crosshairMode !== "small");
  setToggles({ toggleGrid: E.gridOn, togglePolarCoords: E.polarCoords, toggleHiddenPins: !!E.renderOpts.showHiddenPins, highContrastMode: !!E.renderOpts.highContrast,
    padDisplayMode: !!E.renderOpts.outlinePads, viaDisplayMode: !!E.renderOpts.outlineVias, trackDisplayMode: !!E.renderOpts.outlineTracks,
    zoneDisplayFilled: !E.renderOpts.zoneOutline, zoneDisplayOutline: !!E.renderOpts.zoneOutline });
  syncSchModes();
  store.slice("viewport", { units: E.units, selMode: E.selMode, crosshair: E.crosshairMode, polar: E.polarCoords, renderOpts: Object.assign({}, E.renderOpts), gridPitch: E.gridPitch, zoom: E.zoom, cursor: [0, 0], origin: E.localOrigin.slice() });
  store.slice("tool", { current: E.tool });
}

// The schematic module owns its line / drag modes (Shift+Space, G, M); mirror them on the toolbar.
export function syncSchModes() {
  if (!isSch() || !CollabTools.sch || !CollabTools.sch.state) { store.slice("viewport", { lineMode: null, dragMode: null }); return; }
  const lm = CollabTools.sch.state.lineMode;
  setRadio("Line modes", lm === "free" ? "lineModeFree" : lm === "45" ? "lineMode45" : "lineMode90");
  store.slice("viewport", { lineMode: lm === "free" ? "free" : lm === "45" ? "45" : "90", dragMode: CollabTools.sch.state.dragMode || null });
}

export function setUnitsAction(u, id) { if (UNITS[u]) E.units = u; setRadio("Units", id); store.slice("viewport", { units: E.units }); }

export function setCrosshair(mode, id) { E.crosshairMode = mode; setRadio("Crosshair modes", id); $("#crosshair").classList.toggle("on", mode !== "small"); store.slice("viewport", { crosshair: mode }); }
