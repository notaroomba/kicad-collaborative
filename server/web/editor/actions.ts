// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setGroupCurrent, setToggle, setToggles, state, store } from "./appstore";
import { centerOn, openThreadAction } from "./comments";
import { saveVersionDialog, versionsCommand } from "./versions";
import { enterSheet, fpName, navigateDocs, openDoc, openDocId, rootSchematic, selectItemAction, setActiveLayer, setGridPitch, setLayerVisible, switchEditor, updateGridStatus } from "./doc";
import { loadHistory, restoreCheckpoint } from "./history";
import { navigate } from "./home";
import { chooseTrackWidth, chooseViaSize } from "./pcbrouting";
import { setCrosshair, setTheme, setUnitsAction, showPane, syncSchModes, toggleTheme } from "./panes";
import { contextMenuAction } from "./contextmenu";
import { cycleFollow, followAction } from "./peers";
import { drawSelection, renderProps, setFilter } from "./selection";
import { E } from "./state";
import { activeModule, deleteAction, orientSelected, redoLast, runModuleAction, selectAll, setTool, toolCtx, undoLast } from "./tools";
import { api, esc, setRadio, showPopover, toast } from "./util";
import { applyView, fitView, isSch, requestRender, zoomBy } from "./view";
import { show3DViewer } from "./viewer3d-loader";
// ---- actions (the home menu's entries and the collab items of the editor menus) ----
export async function runAction(act, el) {
  const id = state.project && state.project.projectId;
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
      if (store.get().can && !store.get().can.copy) { toast("The owner does not let viewers download this project", 4000); break; }
      location.href = `/api/projects/${id}/archive`; break;
    case "github": location.href = id ? `/p/${id}/github` : "/github"; break;
    case "clone": if (!id) break; if (!state.me) { toast("Sign in to clone"); break; }
      try { const j = await api(`/api/projects/${id}/clone`, { method: "POST" }); toast("Cloned"); navigate(`/p/${j.projectId}/edit`); } catch (e) { toast("Clone failed: " + e.message, 4000); } break;
    // The share dialog (people, roles, links) is the home's React dialog; anyone in the project can open it
    // to see who has access, and only the owner can change anything.
    case "share": if (!id) break; if (!state.me) { toast("Sign in to share"); break; }
      if (window.CollabHome) window.CollabHome.openShare(id, state.project.name); break;
    case "checkpoint": if (!id) break; saveVersionDialog(); showPane("history", true); break;   // the Save Version dialog (components/VersionHistory.tsx)
    case "kicad": showPopover("kicad", null, el); break;
  }
}

/** File → Plot: SVG or PNG of the current document (KiCad's plot dialog, the web's subset). */
export function plotDialog() {
  if (!E.kdoc || !window.KDialogs) return;
  const name = (state.docs.find((d) => d.docId === state.docId) || {}).path || (isSch() ? "sheet.kicad_sch" : "board.kicad_pcb");
  const stem = name.split("/").pop().replace(/\.kicad_(sch|pcb)$/, "");
  KDialogs.open({ title: "Plot", width: 460,
    build(body) {
      body.innerHTML = `<div class="kv"><label>Format</label><select id="kd-fmt"><option value="svg">SVG</option><option value="png">PNG</option></select>
        <label>Resolution (PNG)</label><input id="kd-dpi" type="number" value="300" min="72" max="1200" step="1">
        <label>Content</label><select id="kd-scope"><option value="all">Whole ${isSch() ? "sheet" : "board"}</option><option value="sel"${E.selection.size ? "" : " disabled"}>Selection only</option></select>
        <label></label><label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="kd-bg" type="checkbox" style="width:auto;margin:0"> Include background</label>
        <label></label><label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="kd-hid" type="checkbox" style="width:auto;margin:0"${isSch() ? "" : " disabled"}> Show hidden pins</label></div>
        <p class="kd-note" style="margin-top:10px">Hidden layers stay hidden; the file downloads as ${esc(stem)}.svg / .png.</p>`;
    },
    okLabel: "Plot",
    ok() {
      const g = (id) => document.querySelector("#" + id);
      const fmt = g("kd-fmt").value, dpi = Math.max(72, Math.min(1200, +g("kd-dpi").value || 300));
      const opts = { hidden: E.hiddenLayers, background: g("kd-bg").checked ? undefined : false, showHiddenPins: !!g("kd-hid").checked, zoneOutline: !!E.renderOpts.zoneOutline };
      if (g("kd-scope").value === "sel" && E.selection.size) opts.ids = [...E.selection];
      const download = (blob, ext) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${stem}.${ext}`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
      try {
        if (fmt === "svg") { download(new Blob([KiCadCanvas.renderSvg(E.kdoc, opts)], { type: "image/svg+xml" }), "svg"); toast("Plotted " + stem + ".svg"); }
        else { toast("Rendering PNG…"); KiCadCanvas.renderPng(E.kdoc, Object.assign({ dpi }, opts, E.renderOpts)).then((blob) => { download(blob, "png"); toast("Plotted " + stem + ".png"); }).catch((e) => { console.warn(e); toast("PNG export failed"); }); }
      } catch (e) { console.warn(e); toast("Plot failed: " + (e.message || e)); }
    } });
}

/**
 * File → Print: KiCad's Print dialog (eeschema DIALOG_PRINT / pcbnew DIALOG_PRINT_PCBNEW on
 * DIALOG_PRINT_GENERIC): output mode, drawing sheet, scale (and the board's included layers), then
 * Print Preview / Print / Close.  Printing renders the document as SVG into a window the browser prints.
 */
export function printDialog() {
  if (!E.kdoc) return;
  if (!window.KDialogs) { printDocument({}); return; }
  const sch = isSch();
  const P = E.printOpts || (E.printOpts = { mono: false, frame: true, background: false, scale: "fit", custom: 1, layers: null });
  const layerNames = sch || !E.kdoc.layers ? [] : [...E.kdoc.layers.keys()];
  if (P.layersDoc !== E.kdoc) { P.layers = null; P.layersDoc = E.kdoc; }   // another board: its own layers, not the last one's
  const included = new Set(P.layers || layerNames.filter((l) => !(E.hiddenLayers && E.hiddenLayers.has(l))));
  const cb = (id, on, label, dis) => `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="${id}" type="checkbox" style="width:auto;margin:0"${on ? " checked" : ""}${dis ? " disabled" : ""}> ${esc(label)}</label>`;
  const radio = (name, value, on, label) => `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="radio" name="${name}" value="${value}" style="width:auto;margin:0"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const read = () => {
    const g = (id) => document.querySelector("#" + id);
    P.mono = g("kd-pr-mode").value === "bw"; P.frame = !!g("kd-pr-frame").checked;
    if (sch) P.background = !!g("kd-pr-bg").checked;
    else {
      const r = document.querySelector('input[name="kd-pr-scale"]:checked'); P.scale = r ? r.value : "fit";
      P.custom = Math.max(0.01, Math.min(100, +g("kd-pr-custom").value || 1));
      P.layers = [...document.querySelectorAll(".kd-pr-layer")].filter((c) => c.checked).map((c) => c.dataset.layer);
    }
  };
  KDialogs.open({ title: "Print", width: sch ? 420 : 560,
    build(body) {
      const options = `<h3>Options</h3>
        <div class="kv"><label>Output mode:</label><select id="kd-pr-mode"><option value="color"${P.mono ? "" : " selected"}>Color</option><option value="bw"${P.mono ? " selected" : ""}>Black and White</option></select></div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">${cb("kd-pr-frame", P.frame, "Print drawing sheet")}${sch ? cb("kd-pr-bg", P.background, "Print background color") : ""}</div>`;
      if (sch) { body.innerHTML = options; return; }
      const layers = layerNames.map((l) => `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input class="kd-pr-layer" data-layer="${esc(l)}" type="checkbox" style="width:auto;margin:0"${included.has(l) ? " checked" : ""}> ${esc(l)}</label>`).join("");
      body.innerHTML = `<div class="kd-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div><h3>Included Layers</h3><div style="max-height:260px;overflow:auto;border:1px solid var(--line);padding:4px 6px;display:flex;flex-direction:column;gap:2px">${layers}</div></div>
        <div>${options}<h3>Scale</h3><div style="display:flex;flex-direction:column;gap:6px">${radio("kd-pr-scale", "1", P.scale === "1", "1:1")}${radio("kd-pr-scale", "fit", P.scale === "fit", "Fit to page")}
          <div style="display:flex;gap:6px;align-items:center">${radio("kd-pr-scale", "custom", P.scale === "custom", "Custom:")}<input id="kd-pr-custom" type="number" min="0.01" max="100" step="0.1" value="${P.custom}" style="width:80px"></div></div></div></div>`;
    },
    buttons: [
      { label: "Print Preview", fn: () => { read(); printDocument(P, true); } },
      { label: "Print", primary: true, isDefault: true, fn: () => { read(); printDocument(P, false); } },
      { label: "Close", close: true },
    ] });
}

/**
 * Black and White: KiCad prints every item in black on white paper.  On a schematic a pale *fill* (a symbol
 * body, a sheet background) stays paper white; strokes and text are always black.  Translucent colours (mask
 * layers) keep their alpha, so a print does not turn into one black slab.
 */
function monochrome(svg, sch) {
  const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const map = (k, c) => {
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c), r, g, b, a = 1;
    if (m) { let h = m[1]; if (h.length === 3) h = h.replace(/./g, "$&$&"); r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
    else if ((m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/i.exec(c))) { r = +m[1]; g = +m[2]; b = +m[3]; if (m[4] !== undefined) a = +m[4]; }
    else return c;
    if (sch && k === "fill" && lum(r, g, b) > 0.85) return "#ffffff";
    return a < 1 ? `rgba(0,0,0,${a})` : "#000000";
  };
  return svg.replace(/\b(fill|stroke)="([^"]+)"/g, (all, k, c) => (c === "none" ? all : `${k}="${map(k, c)}"`));
}

/** Render the document for printing and open it in a print window (preview: shown, not printed). */
export function printDocument(P, preview) {
  if (!E.kdoc) return;
  P = P || {}; const sch = isSch();
  const hidden = new Set(E.hiddenLayers || []);
  if (!sch && P.layers) for (const l of E.kdoc.layers ? E.kdoc.layers.keys() : []) { if (P.layers.includes(l)) hidden.delete(l); else hidden.add(l); }
  const frame = P.frame !== false;
  const opts = { hidden, background: sch && P.background ? undefined : false, zoneOutline: !!E.renderOpts.zoneOutline, frame };
  if (!sch && frame && E.kdoc.page) opts.bbox = [0, 0, E.kdoc.page[0], E.kdoc.page[1]];
  let svg; try { svg = KiCadCanvas.renderSvg(E.kdoc, opts); } catch (e) { toast("Print failed: " + (e.message || e)); return; }
  if (P.mono) svg = monochrome(svg, sch);
  // 1:1 keeps the SVG's own millimetre size; Custom scales it; Fit to page (and a schematic page) fills the paper
  const m = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
  const k = !sch && P.scale === "1" ? 1 : !sch && P.scale === "custom" ? (P.custom || 1) : 0;
  const size = k && m ? `svg{width:${(+m[1] * k).toFixed(2)}mm;height:${(+m[2] * k).toFixed(2)}mm}` : "svg{width:100%;height:auto;max-height:100vh}";
  const w = window.open("", "_blank"); if (!w) { toast("Allow pop-ups to print"); return; }
  w.document.write(`<!doctype html><title>${preview ? "Print Preview" : "Print"}</title><style>html,body{margin:0;background:#fff}${size}@page{margin:10mm}</style>${svg}`); w.document.close();
  if (preview) return;
  let printed = false; const go = () => { if (printed) return; printed = true; try { w.print(); } catch (e) { /* the window was closed */ } };
  w.addEventListener("load", () => setTimeout(go, 200)); setTimeout(go, 800);
}

export function toggleRenderOpt(key, id) { E.renderOpts[key] = !E.renderOpts[key]; setToggle(id, !!E.renderOpts[key]); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); }

export function findPopover(el) { showPopover("find", { hits: null, query: "" }, el); }

/** The Find popover's query: select and centre the best match, report the count. */
export function findAction(query) {
  const v = String(query || "").trim().toLowerCase();
  const m = v ? E.items.filter((fp) => fpName(fp).toLowerCase().includes(v)).sort((x, y) => (fpName(y).toLowerCase() === v) - (fpName(x).toLowerCase() === v) || (fpName(y).toLowerCase().startsWith(v)) - (fpName(x).toLowerCase().startsWith(v))) : [];
  if (m.length) { E.selected = m[0]; drawSelection(); renderProps(); centerOn(m[0].x / E.IU, m[0].y / E.IU); }
  const p = store.get().popover; if (p && p.kind === "find") store.set({ popover: Object.assign({}, p, { hits: v ? m.length : null, query: String(query || "") }) });
}

export function gridMenu(el) { showPopover("grid", null, el); }

// Every chrome action the web editor handles, by KiCad action id (or one of ours).  An id missing here
// that maps to a tool (server/web/tables.ts TOOL_MAP) activates the tool; anything else is dimmed and
// explained as desktop-only by the chrome itself.  Handlers get the anchor rect of the clicked control.
export const HANDLERS = {
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
  plot: () => plotDialog(),
  show3DViewer: () => show3DViewer(),
  print: () => printDialog(),
  lineModeFree: () => { CollabTools.sch.setLineMode(toolCtx(), "free"); syncSchModes(); }, lineMode90: () => { CollabTools.sch.setLineMode(toolCtx(), "90"); syncSchModes(); }, lineMode45: () => { CollabTools.sch.setLineMode(toolCtx(), "45"); syncSchModes(); },
  showHierarchy: () => showPane("hier"), showProperties: () => showPane("props"), showLayersManager: () => showPane("appearance"), showAppearance: () => showPane("appearance"),
  showSearch: () => showPane("search"), showNetNavigator: () => showPane("netnav"),
  showSelectionFilter: () => showPane("filter"), showHistory: () => showPane("history"), showPeers: () => showPane("peers"), showComments: () => showPane("comments"),
  collabCopyLink: (a) => runAction("share", a), collabComments: () => showPane("comments", true), collabFollow: () => cycleFollow(), collabHistory: () => showPane("history", true),
  collabLeave: () => navigate("/"), archive: (a) => runAction("archive", a), github: (a) => runAction("github", a), clone: (a) => runAction("clone", a), openInKicad: (a) => runAction("kicad", a), home: () => navigate("/"),
  // the Assistant dock (web/ai) owns its own state; the menu entry just asks it to toggle
  showAssistant: () => window.dispatchEvent(new Event("kc-assistant-toggle")),
  theme: () => toggleTheme(), themeLight: () => setTheme("light"), themeDark: () => setTheme("dark"), themeSystem: () => setTheme("system"), about: (a) => runAction("about", a),
  // the app menu (the "KiCad Collaborative" title in the menu bar): places outside the current editor
  explore: () => navigate("/gallery"), connectClaude: () => { location.href = "/connect"; },
  symbolLibrary: () => { if (window.KiCadLibrary) window.KiCadLibrary.openChooser("symbol", { browser: true }); },
  footprintLibrary: () => { if (window.KiCadLibrary) window.KiCadLibrary.openChooser("footprint", { browser: true }); },
  pluginManager: () => { const P = (window as unknown as { KcPlugins?: { openManager?: () => void } }).KcPlugins; if (P && P.openManager) P.openManager(); else toast("Plugins are not loaded yet"); },
  // the home view's menu entries
  share: (a) => runAction("share", a), checkpoint: (a) => runAction("checkpoint", a), kicad: (a) => runAction("kicad", a),
  zoomin: () => zoomBy(1.25), zoomout: () => zoomBy(0.8), fit: () => fitView(), grid: () => runAction("grid"), snap: () => runAction("snap"), linemode: () => runAction("linemode"),
  "tab-appearance": () => showPane("appearance", true), "tab-props": () => showPane("props", true), "tab-peers": () => showPane("peers", true), "tab-comments": () => showPane("comments", true), "tab-history": () => showPane("history", true),
};


/** window.CollabApp.dispatch: the chrome's intents (typed as AppAction in server/web/store.ts). */
export function dispatchAction(a) {
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
      case "openThread": openThreadAction(a.id); return;
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
