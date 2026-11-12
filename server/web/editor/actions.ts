// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { setGroupCurrent, setToggle, setToggles, state, store } from "./appstore";
import { centerOn, commentOnAction, openThreadAction, openThreadOnDoc } from "./comments";
import { saveVersionDialog, versionsCommand } from "./versions";
import { enterSheet, fpName, navigateDocs, openDoc, openDocId, rootSchematic, selectItemAction, setActiveLayer, setGridPitch, setLayerVisible, switchEditor, updateGridStatus } from "./doc";
import { loadHistory, restoreCheckpoint } from "./history";
import { navigate } from "./home";
import { chooseTrackWidth, chooseViaSize } from "./pcbrouting";
import { setCrosshair, setTheme, setUnitsAction, showPane, syncSchModes, toggleTheme } from "./panes";
import { contextMenuAction, openArcEditModeMenu, openRouterModeMenu } from "./contextmenu";
import { cycleFollow, followAction } from "./peers";
import { drawSelection, renderProps, setFilter } from "./selection";
import { E } from "./state";
import { activeModule, deleteAction, orientSelected, redoLast, runModuleAction, selectAll, setTool, toolCtx, undoLast } from "./tools";
import { api, esc, setRadio, showPopover, toast } from "./util";
import { applyView, fitView, isSch, requestRender, zoomBy } from "./view";
import { show3DViewer } from "./viewer3d-loader";
import { openFabOutputs } from "./fab-outputs";
import { openPlotDialog } from "./pcbdialogs/plot";
import { openGendrill } from "./pcbdialogs/gendrill";
import { openPosFile } from "./pcbdialogs/posfile";
import { openPlotSchematic } from "../dialogs/plot-schematic";
import { printDialog } from "./print";
import type { AppAction } from "../store";
import type { ActionAnchor, ActionHandler, ItemSummary } from "./types";
// ---- actions (the home menu's entries and the collab items of the editor menus) ----
export async function runAction(act: string, el?: ActionAnchor) {
  const id = state.project && state.project.projectId;
  window.dispatchEvent(new CustomEvent("kc:action", { detail: { id: act } }));
  switch (act) {
    case "home": navigate("/"); break;
    // the project manager's File menu: the same things the home sidebar offers
    case "newProject": window.CollabHome?.newProject(); break;
    case "joinLink": window.CollabHome?.join(); break;
    case "importGithub": location.href = "/github"; break;
    case "openTrash": if (!state.me) { toast("Sign in to see your Trash"); break; } navigate("/trash"); break;
    case "signOut": if (!state.me) { toast("You are not signed in"); break; } window.CollabHome?.signOut(); break;
    case "zoomin": zoomBy(1.25); break;
    case "zoomout": zoomBy(0.8); break;
    case "fit": fitView(); break;
    case "grid": E.gridOn = !E.gridOn; updateGridStatus(); requestRender(); break;
    case "snap": E.snapOn = !E.snapOn; updateGridStatus(); break;
    case "linemode": if (CollabTools.sch && CollabTools.sch.cycleLineMode) { CollabTools.sch.cycleLineMode(toolCtx()); syncSchModes(); } break;
    case "tab-appearance": showPane("appearance", true); break;
    case "tab-props": showPane("props", true); break;
    case "tab-peers": showPane("peers", true); break;
    case "tab-comments": showPane("comments", true); break;
    case "tab-history": showPane("history", true); break;
    case "refreshHistory": loadHistory(); break;
    case "about": showPopover("about", null, el); break;
    case "archive": if (!id) break;
      if (!state.me) { toast("Sign in to download the project"); break; }
      if (store.get().can && !store.get().can!.copy) { toast("The owner does not let viewers download this project", 4000); break; }
      location.href = `/api/projects/${id}/archive`; break;
    case "github": location.href = id ? `/p/${id}/github` : "/github"; break;
    case "clone": if (!id) break; if (!state.me) { toast("Sign in to clone"); break; }
      try { const j = await api(`/api/projects/${id}/clone`, { method: "POST" }); toast("Cloned"); navigate(`/p/${j.projectId}/edit`); } catch (e) { toast("Clone failed: " + (e as Error).message, 4000); } break;
    // The share dialog (people, roles, links) is the home's React dialog; anyone in the project can open it
    // to see who has access, and only the owner can change anything.
    case "share": if (!id) break; if (!state.me) { toast("Sign in to share"); break; }
      if (window.CollabHome) window.CollabHome.openShare(id, state.project!.name); break;
    case "checkpoint": if (!id) break; saveVersionDialog(); showPane("history", true); break;   // the Save Version dialog (components/VersionHistory.tsx)
    case "kicad": showPopover("kicad", null, el); break;
  }
}

export function toggleRenderOpt(key: string, id: string) { E.renderOpts[key] = !E.renderOpts[key]; setToggle(id, !!E.renderOpts[key]); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); }

export function findPopover(el: ActionAnchor) { showPopover("find", { hits: null, query: "" }, el); }

/** The Find popover's query: select and centre the best match, report the count. */
export function findAction(query: string) {
  const v = String(query || "").trim().toLowerCase();
  // booleans subtract as 0 / 1: exact matches first, then prefix matches
  const m: ItemSummary[] = v ? E.items.filter((fp: ItemSummary) => fpName(fp).toLowerCase().includes(v)).sort((x: ItemSummary, y: ItemSummary) => ((fpName(y).toLowerCase() === v) as unknown as number) - ((fpName(x).toLowerCase() === v) as unknown as number) || ((fpName(y).toLowerCase().startsWith(v)) as unknown as number) - ((fpName(x).toLowerCase().startsWith(v)) as unknown as number)) : [];
  if (m.length) { E.selected = m[0]; drawSelection(); renderProps(); centerOn(m[0].x / E.IU, m[0].y / E.IU); }
  const p = store.get().popover; if (p && p.kind === "find") store.set({ popover: Object.assign({}, p, { hits: v ? m.length : null, query: String(query || "") }) });
}

export function gridMenu(el: ActionAnchor) { showPopover("grid", null, el); }

// Every chrome action the web editor handles, by KiCad action id (or one of ours).  An id missing here
// that maps to a tool (server/web/tables.ts TOOL_MAP) activates the tool; anything else is dimmed and
// explained as desktop-only by the chrome itself.  Handlers get the anchor rect of the clicked control.
export const HANDLERS: Record<string, ActionHandler> = {
  selectSetRect: () => { E.selMode = "rect"; setRadio("Selection modes", "selectSetRect"); store.slice("viewport", { selMode: E.selMode }); setTool("select"); },
  selectSetLasso: () => { E.selMode = "lasso"; setRadio("Selection modes", "selectSetLasso"); store.slice("viewport", { selMode: E.selMode }); setTool("select"); },
  selectAll: () => selectAll(),
  save: (a) => runAction("checkpoint", a), refreshHistory: () => loadHistory(),
  undo: () => undoLast(), redo: () => redoLast(), find: (a) => findPopover(a), doDelete: () => deleteAction(),
  zoomRedraw: () => requestRender(), zoomInCenter: () => zoomBy(1.25), zoomOutCenter: () => zoomBy(0.8), zoomFitScreen: () => fitView(), zoomFitObjects: () => fitView(),
  navigateBack: () => navigateDocs(-1), navigateForward: () => navigateDocs(1), navigateUp: () => { const r = rootSchematic(); if (r && state.doc !== r) openDoc(r); else toast("Already at the root sheet"); },
  rotateCCW: () => orientSelected("ccw"), rotateCW: () => orientSelected("cw"), rotateCcw: () => orientSelected("ccw"), rotateCw: () => orientSelected("cw"),
  mirrorV: () => orientSelected("mv"), mirrorH: () => orientSelected("mh"),
  showPcbNew: () => switchEditor(), showEeschema: () => switchEditor(),
  toggleGrid: () => { E.gridOn = !E.gridOn; updateGridStatus(); requestRender(); }, "toggleGrid:menu": (a) => gridMenu(a),
  "routeSingleTrack:menu": (a) => openRouterModeMenu(a), "routeDiffPair:menu": (a) => openRouterModeMenu(a),
  // the Arc group's menu, whichever drawing mode its button shows
  "drawArcCenter:menu": (a) => openArcEditModeMenu(a), "drawArcStartEndMid:menu": (a) => openArcEditModeMenu(a), "drawArcStartEndCenter:menu": (a) => openArcEditModeMenu(a),
  "drawArcTangent:menu": (a) => openArcEditModeMenu(a), "drawArcStartDirEnd:menu": (a) => openArcEditModeMenu(a),
  millimetersUnits: () => setUnitsAction("mm", "millimetersUnits"), inchesUnits: () => setUnitsAction("in", "inchesUnits"), milsUnits: () => setUnitsAction("mil", "milsUnits"),
  cursorSmallCrosshairs: () => setCrosshair("small", "cursorSmallCrosshairs"), cursorFullCrosshairs: () => setCrosshair("full", "cursorFullCrosshairs"), cursor45Crosshairs: () => setCrosshair("45", "cursor45Crosshairs"),
  togglePolarCoords: () => { E.polarCoords = !E.polarCoords; setToggle("togglePolarCoords", E.polarCoords); store.slice("viewport", { polar: E.polarCoords }); },
  toggleHiddenPins: () => toggleRenderOpt("showHiddenPins", "toggleHiddenPins"),
  highContrastMode: () => toggleRenderOpt("highContrast", "highContrastMode"),
  padDisplayMode: () => toggleRenderOpt("outlinePads", "padDisplayMode"), viaDisplayMode: () => toggleRenderOpt("outlineVias", "viaDisplayMode"), trackDisplayMode: () => toggleRenderOpt("outlineTracks", "trackDisplayMode"),
  zoneDisplayFilled: () => { E.renderOpts.zoneOutline = false; setToggles({ zoneDisplayFilled: true, zoneDisplayOutline: false }); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  zoneDisplayOutline: () => { E.renderOpts.zoneOutline = true; setToggles({ zoneDisplayFilled: false, zoneDisplayOutline: true }); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  // on by default (render(): netNames !== false), so the first toggle turns them off
  showNetNames: () => { E.renderOpts.netNames = E.renderOpts.netNames === false; setToggle("showNetNames", E.renderOpts.netNames !== false); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  flipBoard: () => toggleRenderOpt("flip", "flipBoard"),
  showHiddenText: () => toggleRenderOpt("showHiddenText", "showHiddenText"),
  zoneFillPreview: () => toggleRenderOpt("zoneFill", "zoneFillPreview"),
  showPadNumbers: () => { E.renderOpts.padNumbers = E.renderOpts.padNumbers === false; setToggle("showPadNumbers", E.renderOpts.padNumbers !== false); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  clearMarkers: () => { E.markers = []; E.renderOpts.markers = undefined; const m = activeModule(); if (m && m.actions && m.actions.clearMarkers) { try { m.actions.clearMarkers.run(toolCtx()); } catch (e) { /* module without markers */ } } store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  plot: () => { if (isSch()) void openPlotSchematic(); else void openPlotDialog(); },
  show3DViewer: () => show3DViewer(),
  // DIALOG_PLOT set to Gerber, DIALOG_GENDRILL, DIALOG_GEN_FOOTPRINT_POSITION; the order-form package is the web's own entry
  generateGerbers: () => { void openPlotDialog({ gerber: true }); }, generateDrillFiles: () => { void openGendrill(); }, generatePosFile: () => { void openPosFile(); },
  fabPackage: () => openFabOutputs("gerber"),
  print: () => printDialog(),
  // the Line Modes radio: the schematic's wire modes, or the board's angle snap (PCB_ACTIONS::lineModeFree / 90 / 45)
  lineModeFree: () => { if (isSch()) CollabTools.sch!.setLineMode(toolCtx(), "free"); else runModuleAction("lineModeFree"); syncSchModes(); },
  lineMode90: () => { if (isSch()) CollabTools.sch!.setLineMode(toolCtx(), "90"); else runModuleAction("lineMode90"); syncSchModes(); },
  lineMode45: () => { if (isSch()) CollabTools.sch!.setLineMode(toolCtx(), "45"); else runModuleAction("lineMode45"); syncSchModes(); },
  showHierarchy: () => showPane("hier"), showProperties: () => showPane("props"), showLayersManager: () => showPane("appearance"), showAppearance: () => showPane("appearance"),
  showSearch: () => showPane("search"), showNetNavigator: () => showPane("netnav"),
  showSelectionFilter: () => showPane("filter"), showHistory: () => showPane("history"), showPeers: () => showPane("peers"), showComments: () => showPane("comments"),
  collabCopyLink: (a) => runAction("share", a), collabComments: () => showPane("comments", true), collabFollow: () => cycleFollow(), collabHistory: () => showPane("history", true),
  // design review (web/review): KiCad's File > Compare … entries open the Compare window
  compareSchematicWithHistory: () => openCompare(), compareBoardWithHistory: () => openCompare(), collabCompare: () => openCompare(),
  compareSchematicWithFile: () => openCompare({ pickFile: true }), compareBoardWithFile: () => openCompare({ pickFile: true }),
  collabLeave: () => navigate("/"), archive: (a) => runAction("archive", a), github: (a) => runAction("github", a), clone: (a) => runAction("clone", a), openInKicad: (a) => runAction("kicad", a), home: () => navigate("/"),
  theme: () => toggleTheme(), themeLight: () => setTheme("light"), themeDark: () => setTheme("dark"), themeSystem: () => setTheme("system"), about: (a) => runAction("about", a),
  // the app menu (the "KiCad Collaborative" title in the menu bar): places outside the current editor
  explore: () => navigate("/gallery"), connectAI: () => { location.href = "/connect"; },
  symbolLibrary: () => { if (window.KiCadLibrary) window.KiCadLibrary.openChooser("symbol", { browser: true }); },
  footprintLibrary: () => { if (window.KiCadLibrary) window.KiCadLibrary.openChooser("footprint", { browser: true }); },
  pluginManager: () => { const P = (window as unknown as { KcPlugins?: { openManager?: () => void } }).KcPlugins; if (P && P.openManager) P.openManager(); else toast("Plugins are not loaded yet"); },
  // the home view's menu entries
  share: (a) => runAction("share", a), checkpoint: (a) => runAction("checkpoint", a), kicad: (a) => runAction("kicad", a),
  zoomin: () => zoomBy(1.25), zoomout: () => zoomBy(0.8), fit: () => fitView(), grid: () => runAction("grid"), snap: () => runAction("snap"), linemode: () => runAction("linemode"),
  "tab-appearance": () => showPane("appearance", true), "tab-props": () => showPane("props", true), "tab-peers": () => showPane("peers", true), "tab-comments": () => showPane("comments", true), "tab-history": () => showPane("history", true),
};


/** The Compare window lives in the chrome bundle; it listens for this event (web/review/store.ts). */
function openCompare(detail: Record<string, unknown> = {}) { window.dispatchEvent(new CustomEvent("kc-compare", { detail })); }

/** window.CollabApp.dispatch: the chrome's intents (typed as AppAction in server/web/store.ts). */
export function dispatchAction(a: AppAction) {
  if (!a || typeof a !== "object") return;
  try {
    switch (a.type) {
      case "action": {
        if (typeof a.id !== "string") return;
        if (a.id.startsWith("module:")) { runModuleAction(a.id.slice(7)); return; }
        const h = HANDLERS[a.id]; if (h) h(a.anchor || null); return;
      }
      case "setTool": setTool(a.tool); return;
      case "setGroupCurrent": setGroupCurrent(a.group, a.id); return;
      case "showPane": showPane(a.pane, a.show); return;
      case "openDoc": openDocId(a.docId); return;
      case "enterSheet": enterSheet(a.file); return;
      case "setLayerVisible": setLayerVisible(a.key, a.visible); return;
      case "setActiveLayer": setActiveLayer(a.layer); return;
      case "setTrackWidth": chooseTrackWidth(a.index); return;
      case "setViaSize": chooseViaSize(a.index); return;
      case "setGrid": setGridPitch(a.pitch); return;
      case "setZoom": if (a.zoom === "auto") fitView(); else { E.viewTouched = true; E.zoom = Math.min(400, Math.max(0.2, Number(a.zoom) / 100)); applyView(); } return;
      case "setFilter": setFilter(a.key, a.on); return;
      case "follow": followAction(a.cid); return;
      case "openThread": if (a.docId) openThreadOnDoc(a.docId, a.id); else openThreadAction(a.id); return;
      case "commentOn": commentOnAction(a); return;
      case "compare": openCompare({ a: a.a, b: a.b, docId: a.docId }); return;
      case "selectItem": selectItemAction(a.id); return;
      case "restore": restoreCheckpoint(a.name); return;
      case "versions": versionsCommand(a); return;
      case "find": findAction(a.query); return;
      case "popover": store.set({ popover: a.popover || null }); return;
      case "contextMenu": contextMenuAction(a); return;
      case "toastDone": return;
      default: console.warn("unknown chrome action", a);
    }
  } catch (e) { console.warn("chrome action failed", a, e); }
}
