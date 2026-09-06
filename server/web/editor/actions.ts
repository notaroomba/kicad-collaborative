// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { setGroupCurrent, setToggle, setToggles, state, store } from "./appstore";
import { centerOn, openThreadAction } from "./comments";
import { enterSheet, fpName, navigateDocs, openDoc, openDocId, rootSchematic, selectItemAction, setActiveLayer, setGridPitch, setLayerVisible, switchEditor, updateGridStatus } from "./doc";
import { loadHistory, restoreCheckpoint } from "./history";
import { navigate } from "./home";
import { setCrosshair, setUnitsAction, showPane, syncSchModes, toggleTheme } from "./panes";
import { cycleFollow, followAction } from "./peers";
import { drawSelection, renderProps, setFilter } from "./selection";
import { E } from "./state";
import { activeModule, deleteAction, orientSelected, redoLast, runModuleAction, selectAll, setTool, toolCtx, undoLast } from "./tools";
import { api, esc, setRadio, showPopover, toast } from "./util";
import { applyView, fitView, isSch, requestRender, zoomBy } from "./view";
// ---- actions (the home menu's entries and the collab items of the editor menus) ----
export async function runAction(act, el) {
  const id = state.project && state.project.projectId;
  switch (act) {
    case "home": navigate("/"); break;
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
    case "archive": if (id) location.href = `/api/projects/${id}/archive`; break;
    case "clone": if (!id) break; if (!state.me) { toast("Sign in to clone"); break; }
      try { const j = await api(`/api/projects/${id}/clone`, { method: "POST" }); toast("Cloned"); navigate(`/p/${j.projectId}/edit`); } catch (e) { toast("Clone failed: " + e.message, 4000); } break;
    case "share": if (!id) break; if (!state.me || !state.role || state.role === "viewer") { toast("Only editors can create share links"); break; }
      try { const j = await api(`/api/projects/${id}/links`, { method: "POST", body: JSON.stringify({ role: "editor" }) });
        await navigator.clipboard.writeText(j.url).catch(() => {});
        showPopover("share", { url: j.url }, el);
        toast("Share link copied"); } catch (e) { toast("Couldn't create link: " + e.message, 4000); } break;
    case "checkpoint": if (!id) break; if (E.viewOnly) { toast("Only editors can create checkpoints"); break; }
      { const name = prompt("Checkpoint name", `checkpoint ${new Date().toLocaleString()}`); if (!name) break;
        try { await api(`/api/projects/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ name }) }); toast("Checkpoint created"); loadHistory(); showPane("history", true); }
        catch (e) { toast("Checkpoint failed: " + e.message, 4000); } } break;
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

/** File → Print: the document as SVG in a print window. */
export function printDocument() {
  if (!E.kdoc) return;
  let svg; try { svg = KiCadCanvas.renderSvg(E.kdoc, { hidden: E.hiddenLayers, background: false, zoneOutline: !!E.renderOpts.zoneOutline }); } catch (e) { toast("Print failed: " + (e.message || e)); return; }
  const w = window.open("", "_blank"); if (!w) { toast("Allow pop-ups to print"); return; }
  w.document.write(`<!doctype html><title>Print</title><style>html,body{margin:0;background:#fff}svg{width:100%;height:auto;max-height:100vh}@page{margin:10mm}</style>${svg}`); w.document.close();
  w.addEventListener("load", () => setTimeout(() => w.print(), 200)); setTimeout(() => { try { w.print(); } catch (e) { /* already printed */ } }, 800);
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
  showNetNames: () => toggleRenderOpt("netNames", "showNetNames"),
  flipBoard: () => toggleRenderOpt("flip", "flipBoard"),
  showHiddenText: () => toggleRenderOpt("showHiddenText", "showHiddenText"),
  zoneFillPreview: () => toggleRenderOpt("zoneFill", "zoneFillPreview"),
  showPadNumbers: () => { E.renderOpts.padNumbers = E.renderOpts.padNumbers === false; setToggle("showPadNumbers", E.renderOpts.padNumbers !== false); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  clearMarkers: () => { E.markers = []; E.renderOpts.markers = undefined; const m = activeModule(); if (m && m.actions && m.actions.clearMarkers) { try { m.actions.clearMarkers.run(toolCtx()); } catch (e) { /* module without markers */ } } store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); },
  plot: () => plotDialog(),
  print: () => printDocument(),
  lineModeFree: () => { CollabTools.sch.setLineMode(toolCtx(), "free"); syncSchModes(); }, lineMode90: () => { CollabTools.sch.setLineMode(toolCtx(), "90"); syncSchModes(); }, lineMode45: () => { CollabTools.sch.setLineMode(toolCtx(), "45"); syncSchModes(); },
  showHierarchy: () => showPane("hier"), showProperties: () => showPane("props"), showLayersManager: () => showPane("appearance"), showAppearance: () => showPane("appearance"),
  showSelectionFilter: () => showPane("filter"), showHistory: () => showPane("history"), showPeers: () => showPane("peers"), showComments: () => showPane("comments"),
  collabCopyLink: (a) => runAction("share", a), collabComments: () => showPane("comments", true), collabFollow: () => cycleFollow(), collabHistory: () => showPane("history", true),
  collabLeave: () => navigate("/"), archive: (a) => runAction("archive", a), clone: (a) => runAction("clone", a), openInKicad: (a) => runAction("kicad", a), home: () => navigate("/"),
  theme: () => toggleTheme(), about: (a) => runAction("about", a),
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
      case "setGrid": setGridPitch(a.pitch); return;
      case "setZoom": if (a.zoom === "auto") fitView(); else { E.viewTouched = true; E.zoom = Math.min(400, Math.max(0.2, Number(a.zoom) / 100)); applyView(); } return;
      case "setFilter": setFilter(a.key, a.on); return;
      case "follow": followAction(a.cid); return;
      case "openThread": openThreadAction(a.id); return;
      case "selectItem": selectItemAction(a.id); return;
      case "restore": restoreCheckpoint(a.name); return;
      case "find": findAction(a.query); return;
      case "popover": store.set({ popover: a.popover || null }); return;
      case "toastDone": return;
      default: console.warn("unknown chrome action", a);
    }
  } catch (e) { console.warn("chrome action failed", a, e); }
}
