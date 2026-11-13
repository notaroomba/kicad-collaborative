// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { KICAD_LAYERS, SCH_LAYERS, setStatusBar, setToggle, state, store } from "./appstore";
import { centerOn, closeThread, drawComments, loadComments, renderThreads } from "./comments";
import { $ } from "./dom";
import { pruneSelection, resetInteraction } from "./gestures";
import { loadHistory } from "./history";
import { dropHistoryView } from "./versions";
import { navigate, showView } from "./home";
import { connect, requestResync, setConn } from "./net";
import { setupEditorChrome } from "./panes";
import { renderPeers, stopPresenceKeepalive } from "./peers";
import { drawSelection, renderProps } from "./selection";
import { E } from "./state";
import { activeModule, bindUndoDoc, renderModuleTools, toolCtx } from "./tools";
import { api, toast } from "./util";
import { notePreviewDirty } from "./thumbpush";
import { fpEntryFor, fpParam, isFpPrivate, isFpReadOnlyLib, onFootprintOpened, privateText } from "./fpedit";
import type { DocEntry, ProjectInfo } from "../store";
import type { GridDef } from "../units";
import type { ItemSummary, SheetEntry, SvgLayer, WireChange } from "./types";
import { applyView, base, canvas, cmtG, cmtPanel, dragG, fitView, isSch, overlay, peersG, requestRender, selG, stage, world } from "./view";
export const docNav = { list: [] as string[], idx: -1, lock: false };


/** Each editor's grids in KiCad's list order (Preferences > Grids, dialogs/prefs.ts fills them in from the saved settings). */
export const GRID_CHOICES: Record<string, GridDef[]> = { kicad_sch: [2.54, 1.27, 0.635, 0.254].map((mm) => ({ mm, name: "" })), kicad_pcb: [1.27, 0.635, 0.5, 0.25, 0.1].map((mm) => ({ mm, name: "" })), footprint: [1.27, 0.635, 0.5, 0.25, 0.1].map((mm) => ({ mm, name: "" })) };
/** Which grid list the open document uses: the schematic's, the board's, or the Footprint Editor's own window settings. */
export function gridListKey(): string { return isSch() ? "kicad_sch" : E.DOC_TYPE === "footprint" ? "footprint" : "kicad_pcb"; }
/** The grids of the open document (the board's for the Footprint Editor too). */
export function gridList(): GridDef[] { return GRID_CHOICES[gridListKey()] || []; }

export function syncItemsFromDoc() {
  if (!E.kdoc) return;
  const mv = KiCadCanvas.movableItems(E.kdoc);
  E.items = mv.filter((m) => m.kind !== "sheet").map((m) => ({ id: m.id, ref: m.ref, value: m.value, lib: m.lib, layer: m.layer, x: Math.round(m.x * E.IU), y: Math.round(m.y * E.IU), rot: m.rot, bbox: m.bbox }));
  E.sheets = mv.filter((m) => m.kind === "sheet").map((m) => ({ id: m.id, name: m.name, file: m.file, page: m.page, x: m.x * E.IU, y: m.y * E.IU, w: m.w! * E.IU, h: m.h! * E.IU }));
  // Remember what this sheet calls its children and what page number it gives them: a child .kicad_sch
  // carries neither (its ${SHEETPATH} name and its ${#} both live in the parent's (sheet …) node), and
  // KiCad reads them off the sheet path / SCH_SCREEN::GetPageNumber() rather than out of the child file.
  const dir = state.doc ? state.doc.path.split("/").slice(0, -1).join("/") : "";
  for (const sh of E.sheets) {
    if (!sh.file) continue;
    const path = dir ? `${dir}/${sh.file}` : sh.file;
    if (sh.name) sheetNames.set(path, sh.name);
    if (sh.page) sheetPages.set(path, sh.page);
  }
  if (E.selected) E.selected = E.items.find((f: ItemSummary) => f.id === E.selected.id) || E.sheets.find((sh: SheetEntry) => sh.id === E.selected.id) || null;   // a selected sheet stays selected
  renderObjects();
}

/**
 * The drawing sheet's identity for the open document — what eeschema hands DS_PROXY_VIEW_ITEM
 * (eeschema/sch_view.cpp:131-138, pcbnew/pcb_edit_frame.cpp:927-953) so the title block can
 * resolve ${FILENAME}, ${SHEETPATH}, ${#} and ${##}.  The title-block fields, the paper name and
 * the root sheet's own page number come out of the file itself (canvas/doc.ts).
 *
 * ${SHEETPATH} is SCH_SHEET_PATH::PathHumanReadable(): "/" on the root sheet, "/<sheet name>/"
 * one level down.  A sheet reached through the hierarchy carries the name its parent gave it
 * (E.sheets, remembered in sheetNames); opened cold by URL, the file's own stem is the best the
 * browser has.  A board has no sheet path at all — EDA_DRAW_FRAME::GetFullScreenDesc returns
 * empty for pcbnew, so KiCad's board title block reads "Sheet: ".
 */
export const sheetNames = new Map<string, string>();
   // sheet file path -> the Sheetname its parent gives it
export const sheetPages = new Map<string, string>();
   // sheet file path -> the (page "N") its parent's (sheet … (instances …)) gives it

/** The root sheet's own name: SCH_SHEET_FILE's loader calls it "Root" (eeschema/files-io.cpp:383). */
export const ROOT_SHEET_NAME = "Root";

/**
 * The project's text variables — the .kicad_pro's `text_variables` object, which is PROJECT's own
 * resolver and BuildFullText's last fallback (ds_painter.cpp:222-223).  Null until the file lands.
 */
export function projectTextVars(): Record<string, string> | null {
  if (!E.proSettings) return null;
  try { const j = JSON.parse(E.proSettings); const v = j && j.text_variables; return v && typeof v === "object" && Object.keys(v).length ? v : null; }
  catch (e) { return null; }
}

/**
 * Harvest the root schematic's (sheet …) nodes once per project, so a subsheet opened cold by URL —
 * with no parent ever on screen — still knows the Sheetname and the (page "N") its parent gives it.
 * eeschema always has the whole hierarchy loaded; the browser has one file at a time, so this is the
 * one extra read that makes ${SHEETPATH} and ${#} agree with the desktop.
 */
let hierarchyLearned: string | null = null;
export async function learnHierarchy() {
  const pid = state.project ? state.project.projectId : null;
  const root = pid ? rootSchematic() : null;
  if (!root || hierarchyLearned === pid) return;
  hierarchyLearned = pid;
  try {
    const r = await fetch(`/api/docs/${root.docId}/content`);
    if (!r.ok) return;
    const d = KiCadCanvas.parseDoc(await r.text(), "kicad_sch");
    const dir = root.path.split("/").slice(0, -1).join("/");
    for (const m of KiCadCanvas.movableItems(d)) {
      if (m.kind !== "sheet" || !m.file) continue;
      const path = dir ? `${dir}/${m.file}` : m.file;
      if (m.name && !sheetNames.has(path)) sheetNames.set(path, m.name);
      if (m.page && !sheetPages.has(path)) sheetPages.set(path, m.page);
    }
  } catch (e) { /* unreadable root: fall back to the file's own stem and page number */ }
}

/** The title block's text variables the document resolves (${FILENAME}, ${SHEETNAME}, ${#}, ${##}, project variables). */
type SheetContextDoc = KDoc & { fileName?: string; filePath?: string; projectName?: string; projectVars?: unknown; sheetName?: string; sheetPath?: string; sheetCount?: number; pageNumber?: string };
export function applySheetContext(d: SheetContextDoc) {
  const doc = state.doc;
  d.fileName = doc ? doc.path.split("/").pop() : "";
  d.filePath = doc ? doc.path : "";
  d.projectName = state.project ? state.project.name : "";
  d.projectVars = projectTextVars();
  if (d.type !== "sch") { d.sheetName = ""; d.sheetPath = ""; d.sheetCount = 1; return; }
  const sch = state.docs!.filter((x) => x.docType === "kicad_sch");
  d.sheetCount = sch.length || 1;
  const root = state.project ? rootSchematic() : null;
  if (!doc || (root && root.docId === doc.docId)) { d.sheetName = ROOT_SHEET_NAME; d.sheetPath = "/"; return; }
  const name = sheetNames.get(doc.path) || d.fileName!.replace(/\.kicad_sch$/, "");
  d.sheetName = name; d.sheetPath = "/" + name + "/";
  // ${#} comes from SCH_SCREEN::GetPageNumber(), which the parent's instance data fills in; the
  // child's own (sheet_instances …) — if it even has one — is not what eeschema shows.
  const page = sheetPages.get(doc.path);
  if (page) d.pageNumber = page;
}


export function setDocFromText(text: string) {
  let d: KDoc;
  try { d = KiCadCanvas.parseDoc(text, E.DOC_TYPE); } catch (e) { console.warn("document parse failed", e); return false; }
  applySheetContext(d);
  E.kdoc = d; E.vbPerMm = 1; notePreviewDirty();
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

export const layerRow = (l: { key: string; name: string; color: string; count: number }) => ({ key: l.key, name: l.name, color: l.color, count: l.count });

export function renderLayersFromDoc() {
  const list = KiCadCanvas.layerList(E.kdoc);
  const cu = isSch() ? [] : list.filter((l) => /\.Cu$/.test(l.name));
  if (!isSch()) { if (!cu.some((l) => l.name === E.activeLayer) && !(E.kdoc.layers && E.kdoc.layers.has(E.activeLayer))) E.activeLayer = cu[0] ? cu[0].name : ""; E.renderOpts.activeLayer = E.activeLayer; }   // any enabled layer can be the active one
  store.slice("document", { layers: list.map(layerRow), hiddenLayers: Array.from(E.hiddenLayers), copperLayers: cu.map(layerRow), notice: null, hasDoc: true });
  store.slice("viewport", { activeLayer: E.activeLayer });
}

export function setActiveLayer(name: string) {
  E.activeLayer = name; E.renderOpts.activeLayer = E.activeLayer; store.slice("viewport", { activeLayer: E.activeLayer });
  if (CollabTools.pcb && CollabTools.pcb.setLayer) { try { CollabTools.pcb.setLayer(toolCtx(), E.activeLayer); } catch (e) { /* module without layer API */ } }
  requestRender();
}

export function setLayerVisible(key: string, visible: boolean) {
  if (E.kdoc) { if (visible) E.hiddenLayers.delete(key); else E.hiddenLayers.add(key); store.slice("document", { hiddenLayers: Array.from(E.hiddenLayers) }); requestRender(); return; }
  const l: SvgLayer | undefined = E.layers[key]; if (!l) return;                       // the desktop-pushed SVG render: toggle its nodes
  l.visible = visible; for (const n of l.nodes) n.style.display = visible ? "" : "none";
  renderLayers();
}

/** Every applied change bumps the document version (the Properties island re-reads on it). */
export function bumpDoc() { notePreviewDirty(); store.slice("document", { version: store.get().document.version + 1 }); if (E.comments.length) drawComments(); }   // pins follow the items they are on

export function applyChanges(changes: WireChange[] | null | undefined) {
  if (!E.kdoc) return;
  let any = false, dropped: WireChange | null = null;
  for (const c of changes || []) {
    // a document-level change (Page Settings: paper and title block) addresses no item — web/dialogs/project.ts
    if (c && c.docProps) { if (KiCadCanvas.applyDocProps(E.kdoc, c.docProps)) { any = true; if (isSch()) { E.vb = [0, 0, E.kdoc.page[0], E.kdoc.page[1]]; base.setAttribute("viewBox", E.vb.join(" ")); overlay.setAttribute("viewBox", E.vb.join(" ")); applyView(); } } continue; }
    if (c && c.typeName === "BOARD_SETUP") { if (KiCadCanvas.boardSetup && KiCadCanvas.boardSetup.applyBoardSetup(E.kdoc, c)) { any = true; renderLayersFromDoc(); } continue; }   // board-level sections (canvas/board-setup.ts)
    let ok = false;
    try { ok = KiCadCanvas.applyChange(E.kdoc, c, E.IU); } catch (e) { console.warn("change not applied", e); }
    if (ok) { any = true; continue; }
    // A REMOVED (or a property edit) for an item we never had is a legitimate no-op — delete
    // beats concurrent modify.  A fragment we could not take is not: the two views have just
    // diverged, and the old code discarded that fact entirely.
    if (c.sexpr || c.itemSexpr || String(c.kind).toUpperCase() === "ADDED") dropped = c;
  }
  if (dropped) noteDroppedChange(dropped);
  if (any) { if (!isSch()) KiCadCanvas.computeBBox(E.kdoc); syncItemsFromDoc(); pruneSelection(); drawSelection(); renderProps(); bumpDoc(); requestRender(); const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } } }
}

/**
 * One remote change we could not apply means this document no longer matches the server's.
 * Ask for a fresh base once per document (a resync per dropped op would be a storm, and if
 * the item type is simply unknown to us the snapshot will not carry it either).
 */
export function noteDroppedChange(change: WireChange) {
  console.warn("collab: a remote change was not applied", change.typeName || "", change.kind || "", change.id || "");
  if (E.applyFailed) return;
  E.applyFailed = true;
  requestResync(null, true);
}

export function setupGridControls() {
  const choices = gridList();   // the board's aux toolbar has KiCad's grid dropdown; the schematic uses the grid button's menu
  E.gridPitch = (E.gridDefault && E.gridDefault()) || choices[0].mm;   // grid.last_size: not always the first of the list
  store.slice("viewport", { gridChoices: choices.map((c) => ({ ...c })) });
  updateGridStatus();
}

export function updateGridStatus() { setToggle("toggleGrid", E.gridOn); store.slice("viewport", { gridOn: E.gridOn, gridPitch: E.gridPitch, snapOn: E.snapOn }); }

export function setGridPitch(v: unknown) { E.gridPitch = Number(v) || E.gridPitch; if (E.gridPicked) E.gridPicked(E.gridPitch); updateGridStatus(); requestRender(); }
/** COMMON_TOOLS::GridPreset: the grid at a position of the list. */
export function setGridIndex(i: number) { const l = gridList(); if (!l.length) return; setGridPitch(l[Math.max(0, Math.min(l.length - 1, i))].mm); }
/** grid.last_size: where the current grid is in the list (-1 when it is not one of them). */
export function gridIndex(): number { return gridList().findIndex((g) => Math.abs(g.mm - E.gridPitch) < 1e-9); }

export function snapMm(mm: [number, number]): [number, number];
export function snapMm(mm: number[]): number[];
export function snapMm(mm: number[]): number[] {
  if (!E.snapOn) return mm;
  const p = E.gridFor ? E.gridFor() : E.gridPitch;   // E.gridFor: the grid override of the active tool (Preferences > Grids)
  if (!isSch()) return KiCadCanvas.pcbSizes.state.snapToGrid(mm as [number, number], p);   // the board's grid starts at its grid origin
  return [KiCadCanvas.snap(mm[0], p), KiCadCanvas.snap(mm[1], p)];
}


export function leaveEditor() {
  leaveDoc();
  state.doc = null; state.docId = null;
  setConn("offline", "");
}


export async function openEditor(id: string) {
  if (state.project && state.project.projectId === id && state.view === "editor") return;
  leaveEditor();
  showView("editor");
  let info: ProjectInfo;
  try { info = await api(`/api/projects/${id}/info`); }
  catch (e) {
    // Signed out, a private project looks the same as a missing one: sign in and come straight back.
    if (!state.me) { location.href = "/auth/github/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
    toast("Project not found or private", 3500); navigate("/", true); return;
  }
  state.project = info;
  state.role = info.role;
  document.title = `${info.name} — Junction`;
  state.docs = [];
  // What the server lets this person do (server/src/access.rs).  Someone who is not signed in
  // still joins the live session, as a guest who only watches.
  const can = info.can || { edit: info.role === "editor", comment: info.role === "editor" || info.role === "commenter", copy: true, share: false, manage: false };
  E.canJoin = true;
  E.viewOnly = !state.me || !can.edit;
  E.canComment = !!state.me && !!can.comment;
  state.docs = info.docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
  store.set({ project: info, role: info.role || null, canJoin: E.canJoin, viewOnly: E.viewOnly, canComment: E.canComment, guest: !state.me, can });
  publishDocs();
  loadHistory();
  // ?fp=: the Footprint Editor on a footprint of the project, or on a private copy of a board footprint
  const fp = fpParam();
  if (fp) {
    const entry = await fpEntryFor(info, fp);
    if (entry) { await openDoc(entry); return; }
  }
  const wanted = new URLSearchParams(location.search).get("doc");
  // A project opens on its root schematic, where a design starts and where KiCad's own project
  // manager leads first; the board is one click away (and ?doc= still opens exactly what a link names).
  // Only a project with no schematic at all opens on the board.
  const doc = state.docs!.find((d) => d.docId === wanted)
    || rootSchematic() || state.docs!.find((d) => d.docType === "kicad_pcb") || null;
  if (!doc) {
    base.replaceChildren(); setDocNotice("This project has no board or schematic yet. Open it in the desktop app.");
    setConn("err", "nothing to show"); return;
  }
  await openDoc(doc);
}


export function rootSchematic(): DocEntry | undefined {
  const sch = state.docs!.filter((d) => d.docType === "kicad_sch");
  const pro = state.project!.docs.find((d) => d.docType === "kicad_pro");
  if (pro && E.proSettings === null) { E.proSettings = ""; api(`/api/docs/${pro.docId}/content`).then((t) => { E.proSettings = typeof t === "string" ? t : JSON.stringify(t); if (CollabTools.pcb && CollabTools.pcb.setDesignSettings) { try { CollabTools.pcb.setDesignSettings(E.proSettings); } catch (e) { /* module without rules */ } }
    // the title block's last resolver arrives with this file, so a sheet already on screen needs a repaint
    if (E.kdoc) { applySheetContext(E.kdoc); requestRender(); } }).catch(() => { E.proSettings = ""; }); }
  // the custom rules (.kicad_dru) the PCB tools resolve length / skew constraints from
  const dru = state.project!.docs.find((d) => d.docType === "design_rules");
  if (dru && E.druText === null) { E.druText = ""; api(`/api/docs/${dru.docId}/content`).then((t) => { E.druText = typeof t === "string" ? t : ""; }).catch(() => { E.druText = ""; }); }
  const stem = pro && pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "");
  return sch.find((d) => d.path.split("/").pop() === stem + ".kicad_sch")
    || sch.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}


export function enterSheet(file: string) {
  const base = file.split("/").pop();
  const cur = state.doc ? state.doc.path.split("/").slice(0, -1).join("/") : "";
  const rel = cur ? `${cur}/${file}` : file;
  const doc = state.docs!.find((d) => d.docType === "kicad_sch" && (d.path === rel || d.path === file))
    || state.docs!.find((d) => d.docType === "kicad_sch" && d.path.split("/").pop() === base);
  if (doc) openDoc(doc); else toast("That sheet isn't in the shared project yet");
}


/** The document list, the root sheet and the open document, for the hierarchy pane and the doc switcher. */
export function publishDocs() {
  const root = state.project ? rootSchematic() : null;
  store.slice("document", { docs: state.docs!.slice(), rootDocId: root ? root.docId : null, doc: state.doc || null, docId: state.docId || null });
}

/** A note shown in the Appearance pane instead of the layer list (nothing to render yet). */
export function setDocNotice(text: string | null) { store.slice("document", { notice: text || null, layers: [], copperLayers: [], hasDoc: false }); }


export function leaveDoc() {
  dropHistoryView();    // the timeline belongs to the document being left
  resetInteraction();   // no drag, menu, hover or tool survives into the next document
  E.connectGen++;   // any connect() still waiting for its ticket must give up
  if (E.ws) { E.ws.onclose = null; E.ws.close(); E.ws = null; }
  stopPresenceKeepalive();
  E.joinedDocId = null; E.lastSeq = 0; E.resyncAt = 0; E.lastPresenceMm = null; E.applyFailed = false;
  clearInterval(E.renderTimer); E.renderTimer = 0;
  E.items = []; E.sheets = []; E.selected = null; E.drag = null; E.boxSel = null; E.measure = null; E.selection = new Set(); E.highlightIds = null; E.peerState = {}; E.comments = []; E.followPeer = null; E.layers = {};
  E.kdoc = null; E.layersSeeded = false; canvas.style.display = "none"; if (E.renderReq) { cancelAnimationFrame(E.renderReq); E.renderReq = 0; }
  peersG.replaceChildren(); selG.replaceChildren(); dragG.replaceChildren(); cmtG.replaceChildren();
  closeThread();
  store.slice("document", { layers: [], hiddenLayers: [], copperLayers: [], items: [], sheets: [], hasDoc: false, notice: null });
  store.set({ comments: [], otherComments: [], openThread: null, peers: { list: [], follow: null } });
  renderProps();
}


export async function openDoc(doc: DocEntry) {
  leaveDoc();
  state.doc = doc; state.docId = doc.docId; bindUndoDoc(doc.docId);
  E.DOC_TYPE = doc.docType;
  E.IU = isSch() ? 1e4 : 1e6;
  E.ITEM_TYPE = isSch() ? "SCH_SYMBOL" : "FOOTPRINT";
  setStatusBar({ mode: "" });
  if (!docNav.lock) { docNav.list.length = docNav.idx + 1; docNav.list.push(doc.docId); docNav.idx = docNav.list.length - 1; }
  setupEditorChrome(); publishDocs();
  const url = `/p/${state.project!.projectId}/edit` + (doc.docType === "footprint" ? `?fp=${encodeURIComponent(doc.docId)}` : state.docs!.length > 1 ? `?doc=${doc.docId}` : "");
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  setStatusBar({ message: "" });   // KiCad leaves the message field empty until something reports there
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
    const own = privateText(doc);   // a board footprint's private copy: no document on the server
    if (own !== null) ok = setDocFromText(own);
    else {
      const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`);
      if (r.ok) { const text = await r.text(); if (state.docId !== docId) return; ok = setDocFromText(text); if (ok && doc.docType === "footprint") onFootprintOpened(Number(r.headers.get("x-snapshot-seq")) || 0); }
    }
    if (ok && own !== null) onFootprintOpened(0);
  } catch (e) { console.warn(e); }
  // a subsheet opened cold knows neither its Sheetname nor its page number: both live in its parent
  if (ok && isSch() && state.doc && !(sheetNames.has(state.doc.path) && sheetPages.has(state.doc.path))) {
    const rootSch = state.project ? rootSchematic() : null;
    if (rootSch && rootSch.docId !== docId) {
      learnHierarchy().then(() => { if (state.docId === docId && E.kdoc) { applySheetContext(E.kdoc); requestRender(); } });
    }
  }
  if (!ok) {
    const itemsReq = isSch()
      ? api(`/api/docs/${docId}/items`).then((j) => { if (state.docId !== docId) return;
          E.items = (j.symbols || []).map((sy: ItemSummary) => ({ ...sy, x: Math.round(sy.x * E.IU), y: Math.round(sy.y * E.IU) }));
          E.sheets = (j.sheets || []).map((sh: SheetEntry) => ({ ...sh, x: sh.x * E.IU, y: sh.y * E.IU, w: sh.w * E.IU, h: sh.h * E.IU })); renderObjects(); })
      : api(`/api/projects/${state.project!.projectId}/board-items`).then((j) => { if (state.docId !== docId) return; E.items = j.footprints || []; renderObjects(); });
    itemsReq.catch(() => {});
    const okSvg = await loadBase(true);
    if (!okSvg) {
      base.replaceChildren();
      setDocNotice(`Nothing to show yet for this ${isSch() ? "sheet" : "board"} — it appears once a desktop editor has the project open in a live session.`);
    }
  }
  setTimeout(fitView, 0);   // not rAF: a background tab would defer it indefinitely
  if (isFpPrivate()) setConn("", "private copy of a board footprint");   // nothing goes over the socket until Save
  else if (isFpReadOnlyLib()) setConn("", "read-only library footprint");   // a global library's footprint: Save As makes a project copy
  else if (E.canJoin) connect().catch(() => setConn("err", "connection failed"));
  else setConn("", "sign in to collaborate");
}


// ---- board render (inline SVG so layers can be toggled) ----
export async function loadBase(first: boolean) {
  let text: string;
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
  const hidden = new Set(Object.entries(E.layers as Record<string, SvgLayer>).filter(([, l]) => !l.visible).map(([k]) => k));
  base.replaceChildren(...Array.from(src.childNodes).map((n) => document.importNode(n, true)));
  tagLayers(hidden);
  E.baseVersion++;
  if (!first) { drawSelection(); drawComments(); }
  return true;
}


export function tagLayers(hidden: Set<string>) {
  E.layers = {};
  for (const el of base.querySelectorAll<HTMLElement | SVGElement>("[style]")) {
    const st = el.getAttribute("style") || "";
    let m = st.match(/fill:#([0-9A-Fa-f]{6})/);
    if (!m || /fill:none/i.test(st)) m = st.match(/stroke:#([0-9A-Fa-f]{6})/);
    if (!m) continue;
    const hex = m[1].toUpperCase();
    const names: Record<string, string> = isSch() ? SCH_LAYERS : KICAD_LAYERS;
    (E.layers[hex] ||= { name: names[hex] || `#${hex}`, nodes: [], visible: !hidden.has(hex) }).nodes.push(el);
    el.dataset.layer = hex;
    if (hidden.has(hex)) el.style.display = "none";
  }
  renderLayers();
}


export function renderLayers() {   // the desktop-pushed SVG render's layers (keyed by plot colour)
  const order = Object.entries(E.layers as Record<string, SvgLayer>).sort((a, b) => b[1].nodes.length - a[1].nodes.length);
  store.slice("document", { layers: order.map(([hex, l]) => ({ key: hex, name: l.name, color: "#" + hex, count: l.nodes.length })),
    hiddenLayers: order.filter(([, l]) => !l.visible).map(([hex]) => hex), copperLayers: [],
    notice: order.length ? null : "No render yet — the board renders once a desktop editor pushes a preview." });
}


export function fpName(fp: { ref?: string; value?: string; lib?: string }): string { return isSch() ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()!) : (fp.lib || "?").split(":").pop()!; }

/** The Objects tab reads the movable items (and a schematic's sheets) from the store. */
export function renderObjects() {
  store.slice("document", { items: E.items.map((fp: ItemSummary) => ({ id: fp.id, ref: fp.ref, value: fp.value, lib: fp.lib, layer: fp.layer, x: fp.x, y: fp.y, rot: fp.rot || 0 })),
    sheets: E.sheets.map((sh: SheetEntry) => ({ id: sh.id, name: sh.name, file: sh.file, x: sh.x, y: sh.y, w: sh.w, h: sh.h })) });
}

export function selectItemAction(id: string) {
  const fp: ItemSummary | undefined = E.items.find((f: ItemSummary) => f.id === id); if (!fp) return;
  E.selected = fp; drawSelection(); renderProps(); centerOn(fp.x / E.IU, fp.y / E.IU);
}

export function openDocId(id: string) { const d = state.docs!.find((x) => x.docId === id); if (d) openDoc(d); }

export function navigateDocs(dir: number) {
  const i = docNav.idx + dir; if (i < 0 || i >= docNav.list.length) { toast(dir < 0 ? "No previous sheet" : "No next sheet"); return; }
  docNav.lock = true; docNav.idx = i; try { openDocId(docNav.list[i]); } finally { docNav.lock = false; }
}

export function switchEditor() {
  const target = isSch() ? state.docs!.find((d) => d.docType === "kicad_pcb") : rootSchematic();
  if (target) openDoc(target); else toast(isSch() ? "This project has no board yet" : "This project has no schematic yet");
}
