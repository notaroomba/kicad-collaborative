// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { KICAD_LAYERS, SCH_LAYERS, setStatusBar, setToggle, state, store } from "./appstore";
import { centerOn, drawComments, loadComments, renderThreads } from "./comments";
import { $ } from "./dom";
import { loadHistory } from "./history";
import { navigate, showView } from "./home";
import { connect, requestResync, setConn } from "./net";
import { setupEditorChrome } from "./panes";
import { renderPeers, stopPresenceKeepalive } from "./peers";
import { drawSelection, renderProps } from "./selection";
import { E } from "./state";
import { activeModule, renderModuleTools, toolCtx } from "./tools";
import { api, toast } from "./util";
import { base, canvas, cmtG, cmtPanel, dragG, fitView, isSch, overlay, peersG, requestRender, selG, stage, world } from "./view";
export const docNav = { list: [], idx: -1, lock: false };


export const GRID_CHOICES = { kicad_sch: [[1.27, "50 mil"], [2.54, "100 mil"], [0.635, "25 mil"]], kicad_pcb: [[0.25, "0.25 mm"], [0.5, "0.5 mm"], [1, "1 mm"], [0.1, "0.1 mm"], [0.05, "0.05 mm"], [1.27, "50 mil"], [0.635, "25 mil"]] };

export function syncItemsFromDoc() {
  if (!E.kdoc) return;
  const mv = KiCadCanvas.movableItems(E.kdoc);
  E.items = mv.filter((m) => m.kind !== "sheet").map((m) => ({ id: m.id, ref: m.ref, value: m.value, lib: m.lib, layer: m.layer, x: Math.round(m.x * E.IU), y: Math.round(m.y * E.IU), rot: m.rot, bbox: m.bbox }));
  E.sheets = mv.filter((m) => m.kind === "sheet").map((m) => ({ id: m.id, name: m.name, file: m.file, x: m.x * E.IU, y: m.y * E.IU, w: m.w * E.IU, h: m.h * E.IU }));
  if (E.selected) E.selected = E.items.find((f) => f.id === E.selected.id) || null;
  renderObjects();
}

export function setDocFromText(text) {
  let d;
  try { d = KiCadCanvas.parseDoc(text, E.DOC_TYPE); } catch (e) { console.warn("document parse failed", e); return false; }
  E.kdoc = d; E.vbPerMm = 1;
  if (isSch()) E.vb = [0, 0, E.kdoc.page[0], E.kdoc.page[1]];
  else { const b = E.kdoc.bbox, m = 5; E.vb = [b[0] - m, b[1] - m, (b[2] - b[0]) + 2 * m, (b[3] - b[1]) + 2 * m]; }
  base.replaceChildren(); base.setAttribute("viewBox", E.vb.join(" ")); overlay.setAttribute("viewBox", E.vb.join(" "));
  $("#ovRoot").setAttribute("transform", "scale(1)");
  if (!E.layersSeeded) { E.hiddenLayers = new Set(isSch() ? [] : Array.from(KiCadCanvas.PCB_HIDDEN_DEFAULT)); E.layersSeeded = true; }
  renderLayersFromDoc(); syncItemsFromDoc(); renderModuleTools(); bumpDoc();
  const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } }
  canvas.style.display = "block"; requestRender();
  return true;
}

export const layerRow = (l) => ({ key: l.key, name: l.name, color: l.color, count: l.count });

export function renderLayersFromDoc() {
  const list = KiCadCanvas.layerList(E.kdoc);
  const cu = isSch() ? [] : list.filter((l) => /\.Cu$/.test(l.name));
  if (!isSch()) { if (!cu.some((l) => l.name === E.activeLayer)) E.activeLayer = cu[0] ? cu[0].name : ""; E.renderOpts.activeLayer = E.activeLayer; }
  store.slice("document", { layers: list.map(layerRow), hiddenLayers: Array.from(E.hiddenLayers), copperLayers: cu.map(layerRow), notice: null, hasDoc: true });
  store.slice("viewport", { activeLayer: E.activeLayer });
}

export function setActiveLayer(name) {
  E.activeLayer = name; E.renderOpts.activeLayer = E.activeLayer; store.slice("viewport", { activeLayer: E.activeLayer });
  if (CollabTools.pcb && CollabTools.pcb.setLayer) { try { CollabTools.pcb.setLayer(toolCtx(), E.activeLayer); } catch (e) { /* module without layer API */ } }
  requestRender();
}

export function setLayerVisible(key, visible) {
  if (E.kdoc) { if (visible) E.hiddenLayers.delete(key); else E.hiddenLayers.add(key); store.slice("document", { hiddenLayers: Array.from(E.hiddenLayers) }); requestRender(); return; }
  const l = E.layers[key]; if (!l) return;                       // the desktop-pushed SVG render: toggle its nodes
  l.visible = visible; for (const n of l.nodes) n.style.display = visible ? "" : "none";
  renderLayers();
}

/** Every applied change bumps the document version (the Properties island re-reads on it). */
export function bumpDoc() { store.slice("document", { version: store.get().document.version + 1 }); }

export function applyChanges(changes) {
  if (!E.kdoc) return;
  let any = false, dropped = null;
  for (const c of changes || []) {
    let ok = false;
    try { ok = KiCadCanvas.applyChange(E.kdoc, c, E.IU); } catch (e) { console.warn("change not applied", e); }
    if (ok) { any = true; continue; }
    // A REMOVED (or a property edit) for an item we never had is a legitimate no-op — delete
    // beats concurrent modify.  A fragment we could not take is not: the two views have just
    // diverged, and the old code discarded that fact entirely.
    if (c.sexpr || c.itemSexpr || String(c.kind).toUpperCase() === "ADDED") dropped = c;
  }
  if (dropped) noteDroppedChange(dropped);
  if (any) { if (!isSch()) KiCadCanvas.computeBBox(E.kdoc); syncItemsFromDoc(); drawSelection(); renderProps(); bumpDoc(); requestRender(); const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } } }
}

/**
 * One remote change we could not apply means this document no longer matches the server's.
 * Ask for a fresh base once per document (a resync per dropped op would be a storm, and if
 * the item type is simply unknown to us the snapshot will not carry it either).
 */
export function noteDroppedChange(change) {
  console.warn("collab: a remote change was not applied", change.typeName || "", change.kind || "", change.id || "");
  if (E.applyFailed) return;
  E.applyFailed = true;
  requestResync(null, true);
}

export function setupGridControls() {
  const choices = GRID_CHOICES[E.DOC_TYPE] || GRID_CHOICES.kicad_pcb;   // the board's aux toolbar has KiCad's grid dropdown; the schematic uses the grid button's menu
  E.gridPitch = choices[0][0];
  store.slice("viewport", { gridChoices: choices.map((c) => c.slice()) });
  updateGridStatus();
}

export function updateGridStatus() { setToggle("toggleGrid", E.gridOn); store.slice("viewport", { gridOn: E.gridOn, gridPitch: E.gridPitch, snapOn: E.snapOn }); }

export function setGridPitch(v) { E.gridPitch = Number(v) || E.gridPitch; updateGridStatus(); requestRender(); }

export function snapMm(mm) { return E.snapOn ? [KiCadCanvas.snap(mm[0], E.gridPitch), KiCadCanvas.snap(mm[1], E.gridPitch)] : mm; }


export function leaveEditor() {
  leaveDoc();
  state.doc = null; state.docId = null;
  setConn("offline", "");
}


export async function openEditor(id) {
  if (state.project && state.project.projectId === id && state.view === "editor") return;
  leaveEditor();
  showView("editor");
  let info;
  try { info = await api(`/api/projects/${id}/info`); }
  catch (e) { toast("Project not found or private", 3500); navigate("/", true); return; }
  state.project = info;
  state.role = info.role;
  document.title = `${info.name} — KiCad Collaborative`;
  state.docs = [];
  E.canJoin = !!state.me;
  E.viewOnly = !E.canJoin || info.role === "viewer" || !info.role;
  state.docs = info.docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
  store.set({ project: info, role: info.role || null, canJoin: E.canJoin, viewOnly: E.viewOnly });
  publishDocs();
  loadHistory();
  const wanted = new URLSearchParams(location.search).get("doc");
  // Open what has something to show: a rendered board first, else the root
  // schematic (a schematic-only project has an empty placeholder board).
  const doc = state.docs.find((d) => d.docId === wanted)
    || state.docs.find((d) => d.docType === "kicad_pcb" && d.hasPreview)
    || (rootSchematic() && rootSchematic().hasPreview ? rootSchematic() : null)
    || state.docs.find((d) => d.docType === "kicad_pcb") || rootSchematic() || null;
  if (!doc) {
    base.replaceChildren(); setDocNotice("This project has no board or schematic yet. Open it in the desktop app.");
    setConn("err", "nothing to show"); return;
  }
  await openDoc(doc);
}


export function rootSchematic() {
  const sch = state.docs.filter((d) => d.docType === "kicad_sch");
  const pro = state.project.docs.find((d) => d.docType === "kicad_pro");
  if (pro && E.proSettings === null) { E.proSettings = ""; api(`/api/docs/${pro.docId}/content`).then((t) => { E.proSettings = typeof t === "string" ? t : JSON.stringify(t); if (CollabTools.pcb && CollabTools.pcb.setDesignSettings) { try { CollabTools.pcb.setDesignSettings(E.proSettings); } catch (e) { /* module without rules */ } } }).catch(() => { E.proSettings = ""; }); }
  const stem = pro && pro.path.split("/").pop().replace(/\.kicad_pro$/, "");
  return sch.find((d) => d.path.split("/").pop() === stem + ".kicad_sch")
    || sch.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}


export function enterSheet(file) {
  const base = file.split("/").pop();
  const cur = state.doc ? state.doc.path.split("/").slice(0, -1).join("/") : "";
  const rel = cur ? `${cur}/${file}` : file;
  const doc = state.docs.find((d) => d.docType === "kicad_sch" && (d.path === rel || d.path === file))
    || state.docs.find((d) => d.docType === "kicad_sch" && d.path.split("/").pop() === base);
  if (doc) openDoc(doc); else toast("That sheet isn't in the shared project yet");
}


/** The document list, the root sheet and the open document, for the hierarchy pane and the doc switcher. */
export function publishDocs() {
  const root = state.project ? rootSchematic() : null;
  store.slice("document", { docs: state.docs.slice(), rootDocId: root ? root.docId : null, doc: state.doc || null, docId: state.docId || null });
}

/** A note shown in the Appearance pane instead of the layer list (nothing to render yet). */
export function setDocNotice(text) { store.slice("document", { notice: text || null, layers: [], copperLayers: [], hasDoc: false }); }


export function leaveDoc() {
  E.connectGen++;   // any connect() still waiting for its ticket must give up
  if (E.ws) { E.ws.onclose = null; E.ws.close(); E.ws = null; }
  stopPresenceKeepalive();
  E.joinedDocId = null; E.lastSeq = 0; E.resyncAt = 0; E.lastPresenceMm = null; E.applyFailed = false;
  clearInterval(E.renderTimer); E.renderTimer = 0;
  E.items = []; E.sheets = []; E.selected = null; E.drag = null; E.boxSel = null; E.selection = new Set(); E.highlightIds = null; E.peerState = {}; E.comments = []; E.followPeer = null; E.layers = {};
  E.kdoc = null; E.layersSeeded = false; canvas.style.display = "none"; if (E.renderReq) { cancelAnimationFrame(E.renderReq); E.renderReq = 0; }
  peersG.replaceChildren(); selG.replaceChildren(); dragG.replaceChildren(); cmtG.replaceChildren();
  cmtPanel.style.display = "none";
  store.slice("document", { layers: [], hiddenLayers: [], copperLayers: [], items: [], sheets: [], hasDoc: false, notice: null });
  store.set({ comments: [], peers: { list: [], follow: null } });
  renderProps();
}


export async function openDoc(doc) {
  leaveDoc();
  state.doc = doc; state.docId = doc.docId;
  E.DOC_TYPE = doc.docType;
  E.IU = isSch() ? 1e4 : 1e6;
  E.ITEM_TYPE = isSch() ? "SCH_SYMBOL" : "FOOTPRINT";
  setStatusBar({ mode: "" });
  if (!docNav.lock) { docNav.list.length = docNav.idx + 1; docNav.list.push(doc.docId); docNav.idx = docNav.list.length - 1; }
  setupEditorChrome(); publishDocs();
  const url = `/p/${state.project.projectId}/edit` + (state.docs.length > 1 ? `?doc=${doc.docId}` : "");
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  setStatusBar({ message: isSch()
    ? "scroll to zoom · right-drag to pan · click a symbol to select · drag to move · Del deletes · double-click a sheet to enter it"
    : "scroll to zoom · right-drag to pan · click a part to select · drag to move · R rotates · Del deletes" });
  world.style.width = stage.clientWidth + "px";
  E.viewTouched = false;
  renderProps(); renderPeers(); renderThreads();
  const docId = doc.docId;
  setupGridControls();
  loadComments();
  // The document itself, drawn here and kept current by the op stream; the
  // desktop-pushed render is only a fallback when the file can't be read.
  let ok = false;
  try {
    const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`);
    if (r.ok) { const text = await r.text(); if (state.docId !== docId) return; ok = setDocFromText(text); }
  } catch {}
  if (!ok) {
    const itemsReq = isSch()
      ? api(`/api/docs/${docId}/items`).then((j) => { if (state.docId !== docId) return;
          E.items = (j.symbols || []).map((sy) => ({ ...sy, x: Math.round(sy.x * E.IU), y: Math.round(sy.y * E.IU) }));
          E.sheets = (j.sheets || []).map((sh) => ({ ...sh, x: sh.x * E.IU, y: sh.y * E.IU, w: sh.w * E.IU, h: sh.h * E.IU })); renderObjects(); })
      : api(`/api/projects/${state.project.projectId}/board-items`).then((j) => { if (state.docId !== docId) return; E.items = j.footprints || []; renderObjects(); });
    itemsReq.catch(() => {});
    const okSvg = await loadBase(true);
    if (!okSvg) {
      base.replaceChildren();
      setDocNotice(`Nothing to show yet for this ${isSch() ? "sheet" : "board"} — it appears once a desktop editor has the project open in a live session.`);
    }
  }
  setTimeout(fitView, 0);   // not rAF: a background tab would defer it indefinitely
  if (E.canJoin) connect().catch(() => setConn("err", "connection failed"));
  else setConn("", "sign in to collaborate");
}


// ---- board render (inline SVG so layers can be toggled) ----
export async function loadBase(first) {
  let text;
  try {
    const r = await fetch(`/api/docs/${state.docId}/preview.svg?fit=false&v=${Date.now()}`);
    if (!r.ok) return false;
    text = await r.text();
  } catch { return false; }
  if (!text.includes("<svg")) return false;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const src = doc.documentElement;
  const vbs = src.getAttribute("viewBox");
  if (vbs) { E.vb = vbs.split(/\s+/).map(Number); base.setAttribute("viewBox", vbs); overlay.setAttribute("viewBox", vbs); }
  // Physical width from the width attribute tells us what a viewBox unit is.
  const wAttr = src.getAttribute("width") || "";
  const wm = wAttr.match(/^([\d.]+)\s*(mm|cm|in|px)?$/);
  if (wm && E.vb[2] > 0) {
    const n = parseFloat(wm[1]), u = wm[2] || "px";
    const widthMm = u === "mm" ? n : u === "cm" ? n * 10 : u === "in" ? n * 25.4 : n * 25.4 / 96;
    E.vbPerMm = widthMm > 0 ? E.vb[2] / widthMm : 1;
  } else E.vbPerMm = 1;
  $("#ovRoot").setAttribute("transform", `scale(${E.vbPerMm})`);
  const hidden = new Set(Object.entries(E.layers).filter(([, l]) => !l.visible).map(([k]) => k));
  base.replaceChildren(...Array.from(src.childNodes).map((n) => document.importNode(n, true)));
  tagLayers(hidden);
  E.baseVersion++;
  if (!first) { drawSelection(); drawComments(); }
  return true;
}


export function tagLayers(hidden) {
  E.layers = {};
  for (const el of base.querySelectorAll("[style]")) {
    const st = el.getAttribute("style") || "";
    let m = st.match(/fill:#([0-9A-Fa-f]{6})/);
    if (!m || /fill:none/i.test(st)) m = st.match(/stroke:#([0-9A-Fa-f]{6})/);
    if (!m) continue;
    const hex = m[1].toUpperCase();
    const names = isSch() ? SCH_LAYERS : KICAD_LAYERS;
    (E.layers[hex] ||= { name: names[hex] || `#${hex}`, nodes: [], visible: !hidden.has(hex) }).nodes.push(el);
    el.dataset.layer = hex;
    if (hidden.has(hex)) el.style.display = "none";
  }
  renderLayers();
}


export function renderLayers() {   // the desktop-pushed SVG render's layers (keyed by plot colour)
  const order = Object.entries(E.layers).sort((a, b) => b[1].nodes.length - a[1].nodes.length);
  store.slice("document", { layers: order.map(([hex, l]) => ({ key: hex, name: l.name, color: "#" + hex, count: l.nodes.length })),
    hiddenLayers: order.filter(([, l]) => !l.visible).map(([hex]) => hex), copperLayers: [],
    notice: order.length ? null : "No render yet — the board renders once a desktop editor pushes a preview." });
}


export function fpName(fp) { return isSch() ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()) : (fp.lib || "?").split(":").pop(); }

/** The Objects tab reads the movable items (and a schematic's sheets) from the store. */
export function renderObjects() {
  store.slice("document", { items: E.items.map((fp) => ({ id: fp.id, ref: fp.ref, value: fp.value, lib: fp.lib, layer: fp.layer, x: fp.x, y: fp.y, rot: fp.rot || 0 })),
    sheets: E.sheets.map((sh) => ({ id: sh.id, name: sh.name, file: sh.file, x: sh.x, y: sh.y, w: sh.w, h: sh.h })) });
}

export function selectItemAction(id) {
  const fp = E.items.find((f) => f.id === id); if (!fp) return;
  E.selected = fp; drawSelection(); renderProps(); centerOn(fp.x / E.IU, fp.y / E.IU);
}

export function openDocId(id) { const d = state.docs.find((x) => x.docId === id); if (d) openDoc(d); }

export function navigateDocs(dir) {
  const i = docNav.idx + dir; if (i < 0 || i >= docNav.list.length) { toast(dir < 0 ? "No previous sheet" : "No next sheet"); return; }
  docNav.lock = true; docNav.idx = i; try { openDocId(docNav.list[i]); } finally { docNav.lock = false; }
}

export function switchEditor() {
  const target = isSch() ? state.docs.find((d) => d.docType === "kicad_pcb") : rootSchematic();
  if (target) openDoc(target); else toast(isSch() ? "This project has no board yet" : "This project has no schematic yet");
}
