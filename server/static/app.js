"use strict";
// KiCad Collaborative web app: home (recent / explore / open link) + online
// board editor.  Talks to the same REST + WebSocket API the desktop uses.
//
// This file is the editor core: the document (kicad-canvas.js), the websocket
// snapshot/op protocol, presence, selection, drags through the tool engines,
// undo/redo, comments, follow mode and pointer handling on #stage.  The chrome
// around the stage (menus, toolbars, docked panels, status bar, overlays) is
// React (server/web → /static/dist/ui.js) and renders from the observable store
// published on window.CollabApp below; it sends intents back via dispatch().

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const NS = "http://www.w3.org/2000/svg";

// KiCad's default colour theme, so plotted colours map back to layer names.
const KICAD_LAYERS = {
  C83434: "F.Cu", "4D7FC4": "B.Cu", C2C200: "In1.Cu", C200C2: "In2.Cu", C20000: "In3.Cu", "00C2C2": "In4.Cu",
  F2EDA1: "F.SilkS", E8B2A7: "B.SilkS", D864FF: "F.Mask", "02FFEE": "B.Mask", A4A4A4: "F.Paste", "00C2C2 ": "B.Paste",
  AFAFAF: "F.Fab", "585D84": "B.Fab", FF26E2: "F.CrtYd", "26E9FF": "B.CrtYd", D0D2CD: "Edge.Cuts",
  C2C2C2: "Dwgs.User", "5959C9": "Cmts.User", B2B2B2: "Eco1.User", "6A6A6A": "Eco2.User", FFC000: "Pads (TH)",
  ECECEC: "Vias", "000000": "Background", FFFFFF: "Page",
};

const SCH_LAYERS = {
  "009600": "Wires", "0000C2": "Buses & no-connects", "000084": "Junctions", "840000": "Symbol outlines & pins",
  A90000: "Pin numbers", "006464": "Pin names & fields", "840084": "Hierarchical labels", C80000: "Global labels",
  "000000": "Text & local labels", "0F0F0F": "Notes", FFFFC2: "Symbol fills", F5F4EF: "Sheet background",
  "808080": "Drawing sheet", "8A0000": "Sheet outlines", "00C000": "Wires", "0000FF": "Buses", "008080": "Fields",
  "800000": "Symbol outlines", "800080": "Sheets", FFFFFF: "Background",
};

const state = {
  me: null,            // {id, login, name, avatarUrl}
  view: "home",
  homeTab: "recent",
  project: null,       // /info payload
  docId: null,
  role: null,
};

// ---------- observable store: what the React chrome renders from ----------
// Slices are replaced, never mutated, so subscribers can compare by identity.  The
// shape is typed in server/web/store.ts (AppState) — keep the two in step.
const APP_TOOLS = ["select", "pan", "comment", "follow", "zoomtool", "measure"];
const store = (() => {
  let S = {
    view: "home", me: null, project: null, role: null, canJoin: false, viewOnly: true,
    connection: { status: "offline", text: "offline", edits: 0 },
    viewport: { zoom: 1, cursor: [0, 0], origin: [0, 0], polar: false, units: "mm", gridOn: true, gridPitch: 1.27, gridChoices: [], snapOn: true,
      crosshair: "small", selMode: "rect", lineMode: null, dragMode: null, renderOpts: {}, activeLayer: "" },
    document: { editor: null, docType: null, docId: null, doc: null, docs: [], rootDocId: null, sheets: [], layers: [], hiddenLayers: [], copperLayers: [], items: [], hasDoc: false, notice: null, version: 0 },
    selection: { ids: [], primary: null, field: null, version: 0 },
    peers: { list: [], follow: null }, comments: [], history: { groups: [], loading: false, error: null },
    tool: { current: "select", appTools: APP_TOOLS, moduleTools: [], moduleActions: [], handled: [] },
    toggles: {}, groupCurrent: {}, filter: {}, panes: {}, undo: { undo: 0, redo: 0 }, status: { message: "", mode: "" }, toast: null, popover: null,
  };
  const subs = new Set();
  const notify = () => { for (const fn of Array.from(subs)) { try { fn(S); } catch (e) { console.warn(e); } } };
  return {
    get: () => S,
    set(patch) { S = Object.assign({}, S, patch); notify(); },
    slice(key, patch) { S = Object.assign({}, S, { [key]: Object.assign({}, S[key], patch) }); notify(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
})();
window.CollabApp = { getState: store.get, subscribe: store.subscribe, dispatch: (a) => dispatchAction(a), renderProps: (el) => renderPropsInto(el) };
const setStatusBar = (f) => store.slice("status", f);                      // { message, mode }
const setToggles = (map) => store.set({ toggles: Object.assign({}, store.get().toggles, map) });
const setToggle = (id, on) => setToggles({ [id]: !!on });
const setGroupCurrent = (group, id) => store.set({ groupCurrent: Object.assign({}, store.get().groupCurrent, { [group]: id }) });
const RADIO = { Units: ["millimetersUnits", "inchesUnits", "milsUnits"], "Crosshair modes": ["cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs"],
  "Line modes": ["lineModeFree", "lineMode90", "lineMode45"], "Selection modes": ["selectSetRect", "selectSetLasso"] };
function setRadio(group, id) { const m = {}; for (const other of RADIO[group] || []) m[other] = other === id; setToggles(m); setGroupCurrent(group, id); }

// ---------- tiny helpers ----------
function esc(t) { const d = document.createElement("span"); d.textContent = t ?? ""; return d.innerHTML; }
let toastN = 0;
function toast(msg, ms = 2200) { store.set({ toast: { id: ++toastN, text: String(msg), ms } }); }
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`${r.status} ${t || r.statusText}`); }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}
// Popovers are React components (Overlays.tsx) rendered from store.popover: an anchor rect and a kind
// (desktop-only explanation, about, share, kicad, find, grid) with the data each kind shows.
function anchorRect(a) { if (!a) return null; if (a instanceof Element) { const r = a.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; } return a; }
function showPopover(kind, extra, anchor) { store.set({ popover: Object.assign({ kind, anchor: anchorRect(anchor) }, extra || {}) }); }
function closePopover() { if (store.get().popover) store.set({ popover: null }); }

// ---------- home navigation (the home view is still rendered here) ----------
document.addEventListener("click", (ev) => {
  const nav = ev.target.closest("#home [data-nav]");
  if (nav) { state.homeTab = nav.dataset.nav; renderHome(); }
});

// ---------- routing ----------
function navigate(path, replace) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  route();
}
window.addEventListener("popstate", route);
function route() {
  const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})(?:\/edit|\/live)?\/?$/i);
  if (m) { openEditor(m[1]); return; }
  if (location.pathname.startsWith("/gallery")) state.homeTab = "explore";
  showHome();
}

// ---------- session ----------
async function loadMe() {
  try { state.me = await api("/api/me"); } catch { state.me = null; }
  store.set({ me: state.me });
}

// ================================================================ HOME
function showView(name) {
  state.view = name;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === name));
  if (name === "home") {
    leaveEditor(); delete document.body.dataset.editor;
    store.slice("document", { editor: null, docType: null, docId: null, doc: null });
    store.set({ view: "home", project: null, role: null, popover: null });
  } else store.set({ view: name });
}

function showHome() {
  showView("home");
  document.title = "KiCad Collaborative";
  renderHome();
}

function projectCard(p, roleLabel) {
  const id = p.projectId;
  return `<div class="card" data-open="${id}">
    <div class="thumb"><img loading="lazy" src="/api/projects/${id}/preview.svg" alt="" onload="this.classList.add('ready')" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'⬡'}))"></div>
    <div class="body"><div class="name">${esc(p.name)}</div>
    <div class="meta"><span>${esc(p.ownerLogin)}</span><span>·</span><span>${ago(p.updatedAt)}</span>
    ${roleLabel ? `<span class="pill ${esc(roleLabel)}">${esc(roleLabel)}</span>` : ""}</div></div></div>`;
}

async function renderHome() {
  $$("#home nav [data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === state.homeTab));
  const main = $("#homeMain");
  if (state.homeTab === "open") {
    main.innerHTML = `<h1>Open a share link</h1>
      <p class="lead">Paste a link someone shared with you. Editors can move parts live in the browser; viewers follow along.</p>
      <div class="row" style="max-width:640px"><input id="linkIn" placeholder="https://…/j/token"><button class="btn primary" id="linkGo">Open</button></div>
      <p class="note">Prefer the desktop app? Paste the same link into KiCad Collaborative → File → Join Shared Project…</p>`;
    $("#linkGo").onclick = openLink;
    $("#linkIn").onkeydown = (ev) => { if (ev.key === "Enter") openLink(); };
    return;
  }
  if (state.homeTab === "explore") {
    main.innerHTML = `<h1>Explore</h1><p class="lead">Public projects on this server. Open one to look around; clone it to make it yours.</p><div class="grid" id="exploreGrid"><div class="muted">Loading…</div></div>`;
    try {
      const j = await api("/api/gallery");
      $("#exploreGrid").innerHTML = j.projects.length ? j.projects.map((p) => projectCard(p)).join("")
        : `<div class="empty">Nothing public yet.</div>`;
    } catch (e) { $("#exploreGrid").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    bindCards();
    return;
  }
  // recent
  if (!state.me) {
    main.innerHTML = `<h1>Welcome to KiCad Collaborative</h1>
      <p class="lead">Real-time multiplayer for KiCad: shared cursors, live edits, comments and history — in the desktop app and right here in the browser.</p>
      <p><a class="btn primary" href="/auth/github/login?next=/">Sign in with GitHub</a> <button class="btn" data-nav="explore">Browse public projects</button></p>
      <h2>Get started</h2>
      <ol class="lead"><li>Install the desktop app from the <a href="https://github.com/notaroomba/kicad-collaborative/releases" target="_blank">releases page</a>.</li>
      <li>Open a project and choose <b>File → Start Collaboration Session</b>.</li>
      <li>Share the link — collaborators join from KiCad or from this site.</li></ol>`;
    return;
  }
  main.innerHTML = `<h1>Recent projects</h1><p class="lead">Everything you own or have joined, most recently edited first.</p><div class="grid" id="recentGrid"><div class="muted">Loading…</div></div>`;
  try {
    const j = await api("/api/projects");
    $("#recentGrid").innerHTML = j.projects.length ? j.projects.map((p) => projectCard(p, p.role)).join("")
      : `<div class="empty">No projects yet. Start a session from the desktop app, or open a share link.</div>`;
  } catch (e) { $("#recentGrid").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  bindCards();
}

function bindCards() {
  $$("[data-open]").forEach((c) => c.addEventListener("click", () => navigate(`/p/${c.dataset.open}/edit`)));
}

async function openLink() {
  const raw = $("#linkIn").value.trim();
  const m = raw.match(/\/j\/([A-Za-z0-9_-]+)/) || raw.match(/^([A-Za-z0-9_-]{16,})$/);
  if (!m) { toast("That doesn't look like a share link"); return; }
  if (!state.me) { location.href = `/auth/github/login?next=${encodeURIComponent("/j/" + m[1])}`; return; }
  try {
    const j = await api(`/api/join/${m[1]}`, { method: "POST" });
    navigate(`/p/${j.projectId}/edit`);
  } catch (e) { toast("Couldn't open link: " + e.message, 4000); }
}

// ================================================================ EDITOR
const stage = $("#stage"), world = $("#world"), base = $("#base"), overlay = $("#overlay");
const peersG = $("#peersG"), selG = $("#selG"), dragG = $("#dragG"), cmtG = $("#cmtG");
const cmtPanel = $("#cmtPanel");

let ws = null, retries = 0, canJoin = false, viewOnly = false, myClientId = "", wsToken = "";
let IU = 1e6;                 // internal units per mm: 1e6 for boards (nm), 1e4 for schematics
let vbPerMm = 1;              // SVG viewBox units per mm (board plots: 1; schematic plots differ)
const mmW = () => vb[2] / vbPerMm, mmH = () => vb[3] / vbPerMm, mmX0 = () => vb[0] / vbPerMm, mmY0 = () => vb[1] / vbPerMm;
let DOC_TYPE = "kicad_pcb";   // "kicad_pcb" | "kicad_sch"
let ITEM_TYPE = "FOOTPRINT";  // op typeName for the movable items of this doc
let sheets = [];              // hierarchical sheets on a schematic sheet
const isSch = () => DOC_TYPE === "kicad_sch";
let vb = [0, 0, 297, 210];
let items = [], selected = null, drag = null, pan = null;
let zoom = 1, panX = 0, panY = 0;
let tool = "select";
let editsSeen = 0, opN = 0, lastPresence = 0, lastLiveMove = 0;
let followPeer = null, suppressBreakout = false, peerState = {};
let comments = [], openThread = null;
let layers = {};          // hex -> {name, nodes, visible}
let renderTimer = 0, renderDirtySince = 0;
let baseVersion = 0;

// ---- canvas renderer (the document itself, mirrored from the collaboration stream) ----
const canvas = $("#canvas"), cctx = canvas.getContext("2d");
let kdoc = null;                 // KiCadCanvas document when the canvas renderer is active
let hiddenLayers = new Set(), layersSeeded = false;
let gridOn = true, snapOn = true, gridPitch = 1.27;
// KiCad-frame state: local origin for dx/dy (Space resets it), polar readout, crosshair mode,
// render display options (hidden pins, outline modes, high contrast), measure/zoom tools, sheet navigation
let localOrigin = [0, 0], lastCursorMm = [0, 0], polarCoords = false, crosshairMode = "small", renderOpts = {}, measure = null, zoomRect = null, activeLayer = "";
let markers = [], proSettings = null;   // ERC/DRC markers handed over by the tool modules; the project's .kicad_pro text (design rules)
// KiCad's clipboard is s-expression text: the modules write it here and to the system clipboard when allowed.
const appClipboard = { text: "", get() { return appClipboard.text; }, set(t) { appClipboard.text = String(t || ""); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(appClipboard.text).catch(() => {}); },
  async read() { try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t && /^\s*\((kicad_sch|kicad_pcb|lib_symbols|symbol|wire|footprint|segment|via|zone|gr_|label|junction)/.test(t)) return t; } } catch (e) { /* permission denied: use the buffer */ } return appClipboard.text; } };
/** Board groups: a member drags/deletes with its whole group (KiCad's default). */
function groupExpand(ids) { const m = CollabTools.pcb; if (isSch() || !kdoc || !m || !m.expandGroups) return new Set(ids); try { return new Set(m.expandGroups(kdoc, [...ids])); } catch (e) { return new Set(ids); } }
const docNav = { list: [], idx: -1, lock: false };
// Multi-selection (box / lasso, Shift-click, Ctrl+A): ids of any document items; `selected` stays the
// primary footprint/symbol the Properties panel shows.  highlightIds = the net-highlight tool's set.
let selection = new Set(), selMode = "rect", boxSel = null, highlightIds = null;
function selectedSet() { const s = new Set(selection); if (selected) s.add(selected.id); return s.size ? s : null; }
let selField = null, fdrag = null;   // a selected symbol / footprint field {id, name} and its drag {id, name, startMm, orig, moved}
function clearSelection() { selection.clear(); selected = null; selField = null; if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null); }
/** World-space delta → the field's own coordinate frame (schematic fields are absolute; footprint fields ride the footprint's rotation/scale). */
function fieldLocalDelta(item, dx, dy) {
  if (isSch() || item.kind !== "footprint") return [dx, dy];
  const [, , frot] = KiCadCanvas.atOf(item.node); const tr = KiCadCanvas.kid(item.node, "transform"), sc = tr && KiCadCanvas.kid(tr, "scale");
  const sx = sc ? KiCadCanvas.num(sc[1], 1) || 1 : 1, sy = sc ? KiCadCanvas.num(sc[2], 1) || 1 : 1;
  const r = frot * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  return [(dx * c - dy * sn) / sx, (dx * sn + dy * c) / sy];
}
function fieldOf(item, name) { return window.KDialogs && KDialogs._ ? KDialogs._.fieldNode(item.node, name) : null; }
// KiCad's selection filter categories for an item kind.
function filterKey(kind) {
  if (isSch()) return kind === "symbol" ? "symbols" : (kind === "wire" || kind === "bus") ? "wires" : /label|netclass_flag/.test(kind) ? "labels" : kind === "image" ? "images" : (kind === "text" || kind === "text_box") ? "text" : /rectangle|circle|arc|polyline|bezier|rule_area/.test(kind) ? "graphics" : "other";
  return kind === "footprint" ? "footprints" : (kind === "segment" || kind === "arc") ? "tracks" : kind === "via" ? "vias" : kind === "zone" ? "zones" : kind === "dimension" ? "dimensions" : (kind === "gr_text" || kind === "gr_text_box") ? "text" : /^gr_|image|table/.test(kind) ? "graphics" : "other";
}
function filterAllows(kind) { const f = selFilter(); const k = filterKey(kind); return f[k] !== false; }
let renderReq = 0;
const GRID_CHOICES = { kicad_sch: [[1.27, "50 mil"], [2.54, "100 mil"], [0.635, "25 mil"]], kicad_pcb: [[0.25, "0.25 mm"], [0.5, "0.5 mm"], [1, "1 mm"], [0.1, "0.1 mm"], [0.05, "0.05 mm"], [1.27, "50 mil"], [0.635, "25 mil"]] };
function requestRender() { if (renderReq || !kdoc) return; renderReq = requestAnimationFrame(() => { renderReq = 0; drawCanvas(); }); }
KiCadCanvas.onAssetLoaded = () => requestRender();   // bitmaps decode asynchronously; repaint once they are ready
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
}
function drawCanvas() {
  if (!kdoc) return; sizeCanvas();
  const ppm = stage.clientWidth / mmW();
  const view = { ppm, zoom, panX, panY, x0: mmX0(), y0: mmY0(), dpr: window.devicePixelRatio || 1 };
  KiCadCanvas.render(kdoc, cctx, view, Object.assign({ hidden: hiddenLayers, grid: gridOn ? gridPitch : 0, selected: selectedSet(), highlight: highlightIds }, renderOpts));
  const m = activeModule();
  if (m && m.drawOverlay) { try { cctx.save(); KiCadCanvas.setViewTransform(cctx, view); m.drawOverlay(cctx, view, toolCtx()); } catch (e) { console.warn(e); } finally { cctx.restore(); } }
  if (selField) {
    const it = kdoc.items.get(selField.id); if (!it) { selField = null; return; }
    cctx.save(); KiCadCanvas.setViewTransform(cctx, view);
    const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
    cctx.fillStyle = "rgba(102,178,255,0.35)"; cctx.strokeStyle = "#4D7FC4"; cctx.lineWidth = 1.5 * px;
    for (const f of KiCadCanvas.fieldBoxes(it)) { if (f.name !== selField.name) continue; cctx.beginPath(); f.pts.forEach((q, i) => i ? cctx.lineTo(q[0], q[1]) : cctx.moveTo(q[0], q[1])); cctx.closePath(); cctx.fill(); cctx.stroke(); }
    cctx.restore();
  }
}
function syncItemsFromDoc() {
  if (!kdoc) return;
  const mv = KiCadCanvas.movableItems(kdoc);
  items = mv.filter((m) => m.kind !== "sheet").map((m) => ({ id: m.id, ref: m.ref, value: m.value, lib: m.lib, layer: m.layer, x: Math.round(m.x * IU), y: Math.round(m.y * IU), rot: m.rot, bbox: m.bbox }));
  sheets = mv.filter((m) => m.kind === "sheet").map((m) => ({ id: m.id, name: m.name, file: m.file, x: m.x * IU, y: m.y * IU, w: m.w * IU, h: m.h * IU }));
  if (selected) selected = items.find((f) => f.id === selected.id) || null;
  renderObjects();
}
function setDocFromText(text) {
  let d;
  try { d = KiCadCanvas.parseDoc(text, DOC_TYPE); } catch (e) { console.warn("document parse failed", e); return false; }
  kdoc = d; vbPerMm = 1;
  if (isSch()) vb = [0, 0, kdoc.page[0], kdoc.page[1]];
  else { const b = kdoc.bbox, m = 5; vb = [b[0] - m, b[1] - m, (b[2] - b[0]) + 2 * m, (b[3] - b[1]) + 2 * m]; }
  base.replaceChildren(); base.setAttribute("viewBox", vb.join(" ")); overlay.setAttribute("viewBox", vb.join(" "));
  $("#ovRoot").setAttribute("transform", "scale(1)");
  if (!layersSeeded) { hiddenLayers = new Set(isSch() ? [] : Array.from(KiCadCanvas.PCB_HIDDEN_DEFAULT)); layersSeeded = true; }
  renderLayersFromDoc(); syncItemsFromDoc(); renderModuleTools(); bumpDoc();
  const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } }
  canvas.style.display = "block"; requestRender();
  return true;
}
const layerRow = (l) => ({ key: l.key, name: l.name, color: l.color, count: l.count });
function renderLayersFromDoc() {
  const list = KiCadCanvas.layerList(kdoc);
  const cu = isSch() ? [] : list.filter((l) => /\.Cu$/.test(l.name));
  if (!isSch()) { if (!cu.some((l) => l.name === activeLayer)) activeLayer = cu[0] ? cu[0].name : ""; renderOpts.activeLayer = activeLayer; }
  store.slice("document", { layers: list.map(layerRow), hiddenLayers: Array.from(hiddenLayers), copperLayers: cu.map(layerRow), notice: null, hasDoc: true });
  store.slice("viewport", { activeLayer });
}
function setActiveLayer(name) {
  activeLayer = name; renderOpts.activeLayer = activeLayer; store.slice("viewport", { activeLayer });
  if (CollabTools.pcb && CollabTools.pcb.setLayer) { try { CollabTools.pcb.setLayer(toolCtx(), activeLayer); } catch (e) { /* module without layer API */ } }
  requestRender();
}
function setLayerVisible(key, visible) {
  if (kdoc) { if (visible) hiddenLayers.delete(key); else hiddenLayers.add(key); store.slice("document", { hiddenLayers: Array.from(hiddenLayers) }); requestRender(); return; }
  const l = layers[key]; if (!l) return;                       // the desktop-pushed SVG render: toggle its nodes
  l.visible = visible; for (const n of l.nodes) n.style.display = visible ? "" : "none";
  renderLayers();
}
/** Every applied change bumps the document version (the Properties island re-reads on it). */
function bumpDoc() { store.slice("document", { version: store.get().document.version + 1 }); }
function applyChanges(changes) {
  if (!kdoc) return;
  let any = false;
  for (const c of changes || []) { try { if (KiCadCanvas.applyChange(kdoc, c, IU)) any = true; } catch (e) { console.warn("change not applied", e); } }
  if (any) { if (!isSch()) KiCadCanvas.computeBBox(kdoc); syncItemsFromDoc(); drawSelection(); renderProps(); bumpDoc(); requestRender(); const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } } }
}
function setupGridControls() {
  const choices = GRID_CHOICES[DOC_TYPE] || GRID_CHOICES.kicad_pcb;   // the board's aux toolbar has KiCad's grid dropdown; the schematic uses the grid button's menu
  gridPitch = choices[0][0];
  store.slice("viewport", { gridChoices: choices.map((c) => c.slice()) });
  updateGridStatus();
}
function updateGridStatus() { setToggle("toggleGrid", gridOn); store.slice("viewport", { gridOn, gridPitch, snapOn }); }
function setGridPitch(v) { gridPitch = Number(v) || gridPitch; updateGridStatus(); requestRender(); }
function snapMm(mm) { return snapOn ? [KiCadCanvas.snap(mm[0], gridPitch), KiCadCanvas.snap(mm[1], gridPitch)] : mm; }

// ---- editing tools (schematic / board modules register on window.CollabTools) ----
// A module: { id, tools: [{ id, label, key, icon (svg inner markup), cursor }],
//   onActivate(toolId, ctx), onPointerDown(ev, mm, ctx) -> handled?, onPointerMove(ev, mm, ctx),
//   onPointerUp(ev, mm, ctx), onKey(key, ev, ctx) -> handled?, drawOverlay(ctx2d, view, ctx),
//   onDocChanged(ctx) }.  Everything a module needs travels in ctx (see toolCtx()).
window.CollabTools = window.CollabTools || {};
const undoStack = [], redoStack = [];
function activeModule() { if (!kdoc) return null; return isSch() ? CollabTools.sch : CollabTools.pcb; }
function toolCtx(extra) {
  return Object.assign({
    K: KiCadCanvas, doc: kdoc, IU, isSch: isSch(), zoom, pxPerMm: pxPerMm(), gridPitch, snapOn, snap: snapMm, tool, selFilter: selFilter(), activeLayer,
    selected, items, sheets, viewOnly, live: !!(ws && ws.readyState === 1), stage, worldMm, selection, docs: state.docs, project: state.project, api, docId: state.docId,
    setHighlight(ids) { highlightIds = ids && ids.size ? new Set(ids) : null; requestRender(); },
    cursor: lastCursorMm, clipboard: appClipboard, designSettings: proSettings,
    setSelection(ids) { selection = new Set([...(ids || [])].filter((id) => kdoc && kdoc.items.has(id))); selected = null; selField = null; for (const id of selection) { const f = items.find((x) => x.id === id); if (f) { selected = f; break; } } store.slice("selection", { ids: [...selection], primary: selected ? selected.id : null, version: (state.selection ? state.selection.version || 0 : 0) + 1 }); drawSelection(); renderProps(); renderObjects(); requestRender(); },
    setMarkers(list) { markers = Array.isArray(list) ? list : []; renderOpts.markers = markers.length ? markers : undefined; store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); if (markers.length) toast(`${markers.length} marker${markers.length === 1 ? "" : "s"}`); },
    setSelected(fp) { selected = fp ? (items.find((f) => f.id === fp.id) || fp) : null; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    commit(changes, label) { commitChanges(changes, label); },
    applyLocal(changes) { applyChanges(changes); },
    requestRender, toast, enterSheet, setTool,
    setStatus(text) { setStatusBar({ mode: text || "" }); },
  }, extra || {});
}
// Local apply + broadcast, with an inverse recorded for undo.
function commitChanges(changes, label) {
  if (!changes || !changes.length) return;
  const inverse = [];
  for (const c of changes) {
    const it = kdoc && kdoc.items.get(c.id);
    if (c.kind === "ADDED") inverse.push({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] });
    else if (c.kind === "REMOVED" && it) inverse.push({ id: c.id, kind: "ADDED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(kdoc, it) });
    else if (c.kind === "MODIFIED" && it) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(kdoc, it) });
  }
  applyChanges(changes);
  if (ws && ws.readyState === 1) sendOp(changes); else toast("Not connected — change kept locally");
  undoStack.push({ label: label || "edit", changes, inverse }); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; publishUndo();
  if (isSch() && label === "sheet") publishDocs();   // a new sheet file joined the project
}
function publishUndo() { store.set({ undo: { undo: undoStack.length, redo: redoStack.length } }); }
function undoLast() {
  const e = undoStack.pop(); if (!e) { toast("Nothing to undo"); return; }
  const redo = e.changes.map((c) => { const it = kdoc.items.get(c.id); return c.kind === "REMOVED" ? c : (it ? { id: c.id, kind: c.kind === "ADDED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(kdoc, it) } : c); });
  applyChanges(e.inverse); if (ws && ws.readyState === 1) sendOp(e.inverse);
  redoStack.push({ label: e.label, changes: redo, inverse: e.inverse }); publishUndo(); toast("Undo " + e.label);
}
function redoLast() {
  const e = redoStack.pop(); if (!e) { toast("Nothing to redo"); return; }
  applyChanges(e.changes); if (ws && ws.readyState === 1) sendOp(e.changes);
  undoStack.push(e); publishUndo(); toast("Redo " + e.label);
}
/** The active module's tools and menu actions ({id: {label, key, run(ctx)}}), for the toolbar and the menus. */
function renderModuleTools() {
  const m = activeModule();
  const tools = m && m.tools ? m.tools.map((t) => ({ id: t.id, label: t.label, key: t.key || "", icon: t.icon || "", cursor: t.cursor || "" })) : [];
  const actions = m && m.actions ? Object.entries(m.actions).map(([id, a]) => ({ id, label: (a && a.label) || id, key: (a && a.key) || null, menu: (a && a.menu) || null })) : [];
  store.slice("tool", { moduleTools: tools, moduleActions: actions });
}
/** Run a module action; false means the module declined it (its run() returned false), anything else counts as handled. */
function runModuleAction(id) {
  const m = activeModule(); const a = m && m.actions && m.actions[id];
  if (!a || typeof a.run !== "function") return false;
  try { return a.run(toolCtx()) !== false; } catch (e) { console.warn(e); toast("Action failed: " + e.message, 3000); return true; }
}
// Hotkeys in the spec's notation ("Ctrl+Shift+G", "Del", "Space"); Cmd counts as Ctrl on a Mac.
const KEY_NAMES = { Del: "Delete", Esc: "Escape", Space: " ", Ins: "Insert", PgUp: "PageUp", PgDn: "PageDown", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };
function hotkeyMatches(ev, key) {
  if (!key) return false;
  const parts = String(key).split("+"); const k = parts.pop();
  if (parts.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey) || parts.includes("Shift") !== ev.shiftKey || parts.includes("Alt") !== ev.altKey) return false;
  const want = KEY_NAMES[k] || k;
  return want.length === 1 ? ev.key.toUpperCase() === want.toUpperCase() : ev.key === want;
}
function runModuleHotkey(ev) {
  const m = activeModule(); if (!m || !m.actions) return false;
  for (const [id, a] of Object.entries(m.actions)) if (a && a.key && hotkeyMatches(ev, a.key)) { if (runModuleAction(id)) return true; }
  return false;
}
function moduleTool(id) { const m = activeModule(); return m && m.tools ? m.tools.find((t) => t.id === id) : null; }

function leaveEditor() {
  leaveDoc();
  state.doc = null; state.docId = null;
  setConn("offline", "");
}

async function openEditor(id) {
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
  canJoin = !!state.me;
  viewOnly = !canJoin || info.role === "viewer" || !info.role;
  state.docs = info.docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
  store.set({ project: info, role: info.role || null, canJoin, viewOnly });
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

function rootSchematic() {
  const sch = state.docs.filter((d) => d.docType === "kicad_sch");
  const pro = state.project.docs.find((d) => d.docType === "kicad_pro");
  if (pro && proSettings === null) { proSettings = ""; api(`/api/docs/${pro.docId}/content`).then((t) => { proSettings = typeof t === "string" ? t : JSON.stringify(t); if (CollabTools.pcb && CollabTools.pcb.setDesignSettings) { try { CollabTools.pcb.setDesignSettings(proSettings); } catch (e) { /* module without rules */ } } }).catch(() => { proSettings = ""; }); }
  const stem = pro && pro.path.split("/").pop().replace(/\.kicad_pro$/, "");
  return sch.find((d) => d.path.split("/").pop() === stem + ".kicad_sch")
    || sch.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}

function enterSheet(file) {
  const base = file.split("/").pop();
  const cur = state.doc ? state.doc.path.split("/").slice(0, -1).join("/") : "";
  const rel = cur ? `${cur}/${file}` : file;
  const doc = state.docs.find((d) => d.docType === "kicad_sch" && (d.path === rel || d.path === file))
    || state.docs.find((d) => d.docType === "kicad_sch" && d.path.split("/").pop() === base);
  if (doc) openDoc(doc); else toast("That sheet isn't in the shared project yet");
}

/** The document list, the root sheet and the open document, for the hierarchy pane and the doc switcher. */
function publishDocs() {
  const root = state.project ? rootSchematic() : null;
  store.slice("document", { docs: state.docs.slice(), rootDocId: root ? root.docId : null, doc: state.doc || null, docId: state.docId || null });
}
/** A note shown in the Appearance pane instead of the layer list (nothing to render yet). */
function setDocNotice(text) { store.slice("document", { notice: text || null, layers: [], copperLayers: [], hasDoc: false }); }

function leaveDoc() {
  connectGen++;   // any connect() still waiting for its ticket must give up
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  clearInterval(renderTimer); renderTimer = 0;
  items = []; sheets = []; selected = null; drag = null; boxSel = null; selection = new Set(); highlightIds = null; peerState = {}; comments = []; followPeer = null; layers = {};
  kdoc = null; layersSeeded = false; canvas.style.display = "none"; if (renderReq) { cancelAnimationFrame(renderReq); renderReq = 0; }
  peersG.replaceChildren(); selG.replaceChildren(); dragG.replaceChildren(); cmtG.replaceChildren();
  cmtPanel.style.display = "none";
  store.slice("document", { layers: [], hiddenLayers: [], copperLayers: [], items: [], sheets: [], hasDoc: false, notice: null });
  store.set({ comments: [], peers: { list: [], follow: null } });
  renderProps();
}

async function openDoc(doc) {
  leaveDoc();
  state.doc = doc; state.docId = doc.docId;
  DOC_TYPE = doc.docType;
  IU = isSch() ? 1e4 : 1e6;
  ITEM_TYPE = isSch() ? "SCH_SYMBOL" : "FOOTPRINT";
  setStatusBar({ mode: "" });
  if (!docNav.lock) { docNav.list.length = docNav.idx + 1; docNav.list.push(doc.docId); docNav.idx = docNav.list.length - 1; }
  setupEditorChrome(); publishDocs();
  const url = `/p/${state.project.projectId}/edit` + (state.docs.length > 1 ? `?doc=${doc.docId}` : "");
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  setStatusBar({ message: isSch()
    ? "scroll to zoom · right-drag to pan · click a symbol to select · drag to move · Del deletes · double-click a sheet to enter it"
    : "scroll to zoom · right-drag to pan · click a part to select · drag to move · R rotates · Del deletes" });
  world.style.width = stage.clientWidth + "px";
  viewTouched = false;
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
          items = (j.symbols || []).map((sy) => ({ ...sy, x: Math.round(sy.x * IU), y: Math.round(sy.y * IU) }));
          sheets = (j.sheets || []).map((sh) => ({ ...sh, x: sh.x * IU, y: sh.y * IU, w: sh.w * IU, h: sh.h * IU })); renderObjects(); })
      : api(`/api/projects/${state.project.projectId}/board-items`).then((j) => { if (state.docId !== docId) return; items = j.footprints || []; renderObjects(); });
    itemsReq.catch(() => {});
    const okSvg = await loadBase(true);
    if (!okSvg) {
      base.replaceChildren();
      setDocNotice(`Nothing to show yet for this ${isSch() ? "sheet" : "board"} — it appears once a desktop editor has the project open in a live session.`);
    }
  }
  setTimeout(fitView, 0);   // not rAF: a background tab would defer it indefinitely
  if (canJoin) connect().catch(() => setConn("err", "connection failed"));
  else setConn("", "sign in to collaborate");
}

// ---- board render (inline SVG so layers can be toggled) ----
async function loadBase(first) {
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
  if (vbs) { vb = vbs.split(/\s+/).map(Number); base.setAttribute("viewBox", vbs); overlay.setAttribute("viewBox", vbs); }
  // Physical width from the width attribute tells us what a viewBox unit is.
  const wAttr = src.getAttribute("width") || "";
  const wm = wAttr.match(/^([\d.]+)\s*(mm|cm|in|px)?$/);
  if (wm && vb[2] > 0) {
    const n = parseFloat(wm[1]), u = wm[2] || "px";
    const widthMm = u === "mm" ? n : u === "cm" ? n * 10 : u === "in" ? n * 25.4 : n * 25.4 / 96;
    vbPerMm = widthMm > 0 ? vb[2] / widthMm : 1;
  } else vbPerMm = 1;
  $("#ovRoot").setAttribute("transform", `scale(${vbPerMm})`);
  const hidden = new Set(Object.entries(layers).filter(([, l]) => !l.visible).map(([k]) => k));
  base.replaceChildren(...Array.from(src.childNodes).map((n) => document.importNode(n, true)));
  tagLayers(hidden);
  baseVersion++;
  if (!first) { drawSelection(); drawComments(); }
  return true;
}

function tagLayers(hidden) {
  layers = {};
  for (const el of base.querySelectorAll("[style]")) {
    const st = el.getAttribute("style") || "";
    let m = st.match(/fill:#([0-9A-Fa-f]{6})/);
    if (!m || /fill:none/i.test(st)) m = st.match(/stroke:#([0-9A-Fa-f]{6})/);
    if (!m) continue;
    const hex = m[1].toUpperCase();
    const names = isSch() ? SCH_LAYERS : KICAD_LAYERS;
    (layers[hex] ||= { name: names[hex] || `#${hex}`, nodes: [], visible: !hidden.has(hex) }).nodes.push(el);
    el.dataset.layer = hex;
    if (hidden.has(hex)) el.style.display = "none";
  }
  renderLayers();
}

function renderLayers() {   // the desktop-pushed SVG render's layers (keyed by plot colour)
  const order = Object.entries(layers).sort((a, b) => b[1].nodes.length - a[1].nodes.length);
  store.slice("document", { layers: order.map(([hex, l]) => ({ key: hex, name: l.name, color: "#" + hex, count: l.nodes.length })),
    hiddenLayers: order.filter(([, l]) => !l.visible).map(([hex]) => hex), copperLayers: [],
    notice: order.length ? null : "No render yet — the board renders once a desktop editor pushes a preview." });
}

function fpName(fp) { return isSch() ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()) : (fp.lib || "?").split(":").pop(); }
/** The Objects tab reads the movable items (and a schematic's sheets) from the store. */
function renderObjects() {
  store.slice("document", { items: items.map((fp) => ({ id: fp.id, ref: fp.ref, value: fp.value, lib: fp.lib, layer: fp.layer, x: fp.x, y: fp.y, rot: fp.rot || 0 })),
    sheets: sheets.map((sh) => ({ id: sh.id, name: sh.name, file: sh.file, x: sh.x, y: sh.y, w: sh.w, h: sh.h })) });
}
function selectItemAction(id) {
  const fp = items.find((f) => f.id === id); if (!fp) return;
  selected = fp; drawSelection(); renderProps(); centerOn(fp.x / IU, fp.y / IU);
}

// ---- view transform ----
function applyView() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  store.slice("viewport", { zoom });
  // Everything on the overlay is sized in screen pixels, so a zoom or fit
  // must redraw peers too (they otherwise keep the previous scale until the
  // next presence message).
  drawComments(); drawSelection(); drawPeers(peerState);
  requestRender();
}
function contentBoxMm() {
  if (kdoc && !isSch()) { const b = kdoc.bbox; return [b[0], b[1], Math.max(1, b[2] - b[0]), Math.max(1, b[3] - b[1])]; }
  if (isSch()) return [mmX0(), mmY0(), mmW(), mmH()];
  // Union of the board outline and copper: what a person means by "the board".
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const hex of ["D0D2CD", "C83434", "4D7FC4"]) {
    for (const el of (layers[hex] || { nodes: [] }).nodes) {
      if (typeof el.getBBox !== "function") continue;
      let b; try { b = el.getBBox(); } catch { continue; }
      if (!b.width && !b.height) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); n++;
    }
  }
  if (!n || x1 - x0 < 1 || y1 - y0 < 1) return [mmX0(), mmY0(), mmW(), mmH()];
  return [x0 / vbPerMm, y0 / vbPerMm, (x1 - x0) / vbPerMm, (y1 - y0) / vbPerMm];
}
function fitView() { fitBox(contentBoxMm(), isSch() ? 0.97 : 0.85); }
function fitBox(box, margin) {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) { setTimeout(fitView, 100); return; }
  world.style.width = sw + "px";
  const ppm = sw / mmW();                       // px per mm at zoom 1
  const [bx, by, bw, bh] = box;
  zoom = Math.min(400, Math.max(0.2, Math.min(sw / (bw * ppm), sh / (bh * ppm)) * (margin || 1)));
  panX = sw / 2 - ((bx - mmX0()) + bw / 2) * ppm * zoom;
  panY = sh / 2 - ((by - mmY0()) + bh / 2) * ppm * zoom;
  lastStageW = sw;   // the resize observer must not rescale pans computed at this width
  applyView();
}
function zoomBy(factor, cx, cy) {
  viewTouched = true;
  if (cx === undefined) { cx = stage.clientWidth / 2; cy = stage.clientHeight / 2; }
  const next = Math.min(40, Math.max(0.2, zoom * factor));
  panX = cx - (cx - panX) * (next / zoom);
  panY = cy - (cy - panY) * (next / zoom);
  zoom = next; breakFollow(); applyView();
}
stage.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomBy(Math.pow(1.0018, -ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });
let lastStageW = 0, viewTouched = false;   // until the user pans/zooms, resizes just refit
new ResizeObserver(() => {
  if (state.view !== "editor") return;
  const sw = stage.clientWidth;
  if (sw && lastStageW && sw !== lastStageW) {
    if (!viewTouched && (kdoc || Object.keys(layers).length)) { fitView(); return; }
    const r = sw / lastStageW; panX *= r; panY *= r; world.style.width = sw + "px";
  }
  if (sw) lastStageW = sw;
  applyView();
}).observe(stage);

function worldMm(ev) {
  const r = world.getBoundingClientRect();
  return [mmX0() + ((ev.clientX - r.left) / r.width) * mmW(), mmY0() + ((ev.clientY - r.top) / r.height) * mmH()];
}
function pxPerMm() { const r = world.getBoundingClientRect(); return r.width > 0 ? r.width / mmW() : 4; }
function visibleRectNm() {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (wr.width <= 0) return null;
  const x = mmX0() + ((sr.left - wr.left) / wr.width) * mmW(), y = mmY0() + ((sr.top - wr.top) / wr.height) * mmH();
  const w = (sr.width / wr.width) * mmW(), h = (sr.height / wr.height) * mmH();
  return [x, y, w, h].map((v) => Math.round(v * IU));
}

// ---- tools ----
function setTool(t) {
  if (t === "follow") { cycleFollow(); return; }
  const prev = tool; tool = t;
  store.slice("tool", { current: t });
  const mt = moduleTool(t);
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : t === "zoomtool" ? "zoomtool" : t === "measure" ? "measure" : "";
  if (t !== "measure" && measure) { measure = null; dragG.replaceChildren(); setStatusBar({ message: "" }); }
  if (mt && mt.cursor) stage.style.cursor = mt.cursor; else stage.style.cursor = "";
  if (t === "comment" && !canJoin) { toast("Sign in to comment"); setTool("select"); return; }
  const m = activeModule(); if (m && m.onActivate && (mt || moduleTool(prev))) { try { m.onActivate(t, toolCtx()); } catch (e) { console.warn(e); } }
  requestRender();
}
function cycleFollow() {
  const ids = Object.keys(peerState);
  if (!ids.length) { toast("No one else is here to follow"); return; }
  const i = ids.indexOf(followPeer);
  followPeer = ids[(i + 1) % ids.length] || null;
  const p = peerState[followPeer];
  toast(`Following ${peerName(p)} — zoom or pan to stop`);
  applyFollowWeb(peerState); renderPeers();
}
function peerName(p) { return (p && p.user && (p.user.name || p.user.login)) || "peer"; }

// ---- follow ----
function applyFollowWeb(peers) {
  if (!followPeer) return;
  const entry = peers[followPeer];
  if (!entry) { followPeer = null; toast("Stopped following (they left)"); renderPeers(); return; }
  const vp = (entry.state || {}).viewport;
  if (!vp || vp.length < 4 || vp[2] <= 0) return;
  const w = world.clientWidth || stage.clientWidth;
  const xMm = vp[0] / IU, yMm = vp[1] / IU, wMm = vp[2] / IU;
  zoom = Math.min(40, Math.max(0.2, (stage.clientWidth / w) * (mmW() / wMm)));
  panX = -((xMm - mmX0()) / mmW()) * w * zoom;
  panY = -((yMm - mmY0()) / mmH()) * (w * mmH() / mmW()) * zoom;
  suppressBreakout = true; applyView(); suppressBreakout = false;
}
function breakFollow() {
  if (!followPeer || suppressBreakout) return;
  followPeer = null; toast("Stopped following"); renderPeers();
}

// ---- pointer interaction ----
stage.addEventListener("contextmenu", (ev) => ev.preventDefault());
stage.addEventListener("dblclick", (ev) => {
  if (!kdoc || !window.KDialogs || (tool !== "select" && tool !== "highlight")) return;
  if (ev.target.closest("#cmtPanel") || ev.target.closest("[data-schtools]")) return;
  const [x, y] = worldMm(ev); const ctx = toolCtx();
  const f = KiCadCanvas.fieldAt(kdoc, x, y);
  if (f) { KDialogs.openField(ctx, f.item, f.name); return; }
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.padAt && CollabTools.pcb.padProperties) {
    let pad = null; try { pad = CollabTools.pcb.padAt(kdoc, x, y); } catch (e) { pad = null; }
    if (pad && pad.item) { CollabTools.pcb.padProperties(ctx, pad.item, pad.index); return; }
  }
  const best = nearestFootprint(x, y, 5 / Math.max(1, zoom * 0.6));
  if (best) { const it = kdoc.items.get(best.id); if (it) KDialogs.openItem(ctx, it); return; }
  if (isSch()) { const sh = sheets.find((r) => x >= r.x / IU && x <= (r.x + r.w) / IU && y >= r.y / IU && y <= (r.y + r.h) / IU); if (sh) { const it = kdoc.items.get(sh.id); if (it) { KDialogs.openItem(ctx, it); return; } } }
  const other = hitAny([x, y]); const it = other && kdoc.items.get(other.id);
  if (it) KDialogs.openItem(ctx, it);
});
/** E: KiCad's "Edit properties" for whatever is selected — a field, the app selection, or a tool module's own selection. */
function openSelectionProperties() {
  if (!kdoc || !window.KDialogs) return false;
  const ctx = toolCtx();
  if (selField) { const it = kdoc.items.get(selField.id); if (it) { KDialogs.openField(ctx, it, selField.name); return true; } }
  const modSel = isSch() ? (CollabTools.sch && CollabTools.sch.state && CollabTools.sch.state.sel) : (CollabTools.pcb && CollabTools.pcb.state && CollabTools.pcb.state.sel);
  const id = selected ? selected.id : modSel;
  const it = id && kdoc.items.get(id); if (!it) return false;
  KDialogs.openItem(ctx, it); return true;
}
stage.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || tool !== "select" || !kdoc || selection.size < 2 || viewOnly || ev.shiftKey) return;
  const mm = worldMm(ev); const hit = hitAny(mm);
  if (!hit || !selection.has(hit.id)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  startGroupDrag(hit, mm, ev);
}, true);
stage.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay")) return;
  if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && tool === "pan")) {
    pan = { x: ev.clientX - panX, y: ev.clientY - panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (tool === "zoomtool") { zoomRect = { start: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (tool === "measure") { measureClick(snapMm(worldMm(ev))); return; }
  if (tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const mod = activeModule();
  if (mod && moduleTool(tool) && mod.onPointerDown) { if (viewOnly && tool !== "highlight") { toast("View-only access"); return; } try { if (mod.onPointerDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (tool === "select" && kdoc && !ev.shiftKey && window.KDialogs) {   // KiCad: a click on a field selects (and drags) the field, not its symbol
    const f = KiCadCanvas.fieldAt(kdoc, x, y);
    if (f) {
      clearSelection(); selField = { id: f.item.id, name: f.name }; drawSelection(); renderProps(); renderObjects(); requestRender();
      const pn = fieldOf(f.item, f.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at && !viewOnly && ws && ws.readyState === 1) { fdrag = { id: f.item.id, name: f.name, startMm: [x, y], orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], moved: false }; stage.setPointerCapture(ev.pointerId); }
      ev.preventDefault(); return;
    }
  }
  let best = nearestFootprint(x, y, 5 / Math.max(1, zoom * 0.6));
  // Board: a track / via / graphic under the cursor beats a footprint whose only claim is its empty bounding box
  // (KiCad picks the item whose geometry is under the cursor; the footprint wins on its own pads and outline).
  if (!isSch() && best && lastFpHit && !lastFpHit.onGeom && mod && mod.onSelectDown && tool === "select") {
    try { if (mod.onSelectDown(ev, [x, y], toolCtx())) { clearSelection(); drawSelection(); renderProps(); renderObjects(); stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); }
  }
  if (!best && mod && mod.onSelectDown) { try { if (mod.onSelectDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (!best) {
    if (!ev.shiftKey) { clearSelection(); drawSelection(); renderProps(); renderObjects(); }
    if (tool === "select" && kdoc) { boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: selMode === "lasso", add: ev.shiftKey, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    return;
  }
  if (ev.shiftKey) {                                   // KiCad: Shift+click adds to / removes from the selection
    if (selection.has(best.id)) selection.delete(best.id); else selection.add(best.id);
    selected = selection.has(best.id) ? best : (selected && selected.id === best.id ? null : selected);
    drawSelection(); renderProps(); renderObjects(); return;
  }
  if (!selection.has(best.id)) selection.clear();
  selected = best; drawSelection(); renderProps(); renderObjects();
  if (viewOnly || !ws || ws.readyState !== 1) return;
  if (!isSch()) { const g = groupExpand([best.id]); if (g.size > 1) { selection = g; drawSelection(); renderObjects(); startGroupDrag({ id: best.id, fp: best }, [x, y], ev); return; } }   // a group member moves its group
  drag = { fp: best, startMm: [x, y], curMm: [best.x / IU, best.y / IU], moved: false, grabOff: [x - best.x / IU, y - best.y / IU], wires: [], engine: false };
  // Schematic moves run through sch-tools' connected drag: attached wires stretch (with bends in
  // 90° mode), a pin or junction under a moved pin gets a new wire, no-connects follow — KiCad's drag.
  if (kdoc && isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    const it = kdoc.items.get(best.id);
    try { if (it && CollabTools.sch.beginDrag(toolCtx(), it, [x, y], true)) drag.engine = true; } catch (e) { console.warn(e); }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});
stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  lastCursorMm = mm; store.slice("viewport", { cursor: mm });
  if (crosshairMode !== "small") { const r = stage.getBoundingClientRect(); const cy = ev.clientY - r.top, cx = ev.clientX - r.left; $("#chH").setAttribute("y1", cy); $("#chH").setAttribute("y2", cy); $("#chV").setAttribute("x1", cx); $("#chV").setAttribute("x2", cx); }
  if (zoomRect) { drawZoomRect(ev); return; }
  if (boxSel) { boxSel.cur = mm; if (boxSel.lasso) boxSel.pts.push(mm); drawBoxSel(); return; }
  if (measure && !measure.b) { drawMeasure(snapMm(mm)); }
  if (pan) { viewTouched = true; panX = ev.clientX - pan.x; panY = ev.clientY - pan.y; breakFollow(); applyView(); return; }
  const modM = activeModule();
  if (modM && moduleTool(tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm); return; }
  if (fdrag) {
    if (!fdrag.moved && Math.hypot(mm[0] - fdrag.startMm[0], mm[1] - fdrag.startMm[1]) > 0.4) fdrag.moved = true;
    if (fdrag.moved) {
      const it = kdoc && kdoc.items.get(fdrag.id), pn = it && fieldOf(it, fdrag.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at) {
        const w = snapMm([mm[0] - fdrag.startMm[0], mm[1] - fdrag.startMm[1]]); const [ldx, ldy] = fieldLocalDelta(it, w[0], w[1]);
        at[1] = +(fdrag.orig[0] + ldx).toFixed(4); at[2] = +(fdrag.orig[1] + ldy).toFixed(4);
        KiCadCanvas.replaceChange(kdoc, it); requestRender();
      }
    }
    sendPresence(mm); return;
  }
  if (!drag) { sendPresence(mm); return; }
  if (drag.group) { moveGroupDrag(mm); sendPresence(mm); return; }
  if (drag.engine) {
    const d = CollabTools.sch.state.drag;
    if (!d) { drag = null; sendPresence(mm); return; }           // cancelled (Escape) or already dropped
    CollabTools.sch.moveDrag(toolCtx(), mm);
    if (!d.moved) { sendPresence(mm); return; }
    drag.moved = true; drag.curMm = [drag.fp.x / IU + d.last[0], drag.fp.y / IU + d.last[1]];
    const nowE = Date.now();
    if (nowE - lastLiveMove > 150 && d.kind === "symbol") { lastLiveMove = nowE; sendOp([moveOp(drag.fp, Math.round(drag.curMm[0] * IU), Math.round(drag.curMm[1] * IU))]); }
    sendPresence(mm); return;
  }
  if (!drag.moved && Math.hypot(mm[0] - drag.startMm[0], mm[1] - drag.startMm[1]) > 0.4) drag.moved = true;
  if (!drag.moved) return;
  // Keep the grab offset, then snap the item's own anchor to the grid.
  const off = drag.grabOff || [0, 0];
  const target = snapMm([mm[0] - off[0], mm[1] - off[1]]);
  drag.curMm = target;
  drawDrag();
  if (kdoc) {
    KiCadCanvas.applyChange(kdoc, moveOp(drag.fp, Math.round(target[0] * IU), Math.round(target[1] * IU)), IU);
    for (const w of drag.wires) { const p = KiCadCanvas.ptsOf(w.item.node); p[w.index] = [target[0] + w.off[0], target[1] + w.off[1]]; KiCadCanvas.setPts(w.item.node, p); w.item.geom = []; w.item.bbox = null; }
    for (const w of drag.wires) KiCadCanvas.replaceChange(kdoc, w.item);
    requestRender();
  }
  const now = Date.now();
  if (now - lastLiveMove > 150) { lastLiveMove = now; sendOp([moveOp(drag.fp, Math.round(target[0] * IU), Math.round(target[1] * IU))]); }
  const s = 4;
  const g = [[mm[0]-s, mm[1]-s, mm[0]+s, mm[1]-s], [mm[0]+s, mm[1]-s, mm[0]+s, mm[1]+s],
             [mm[0]+s, mm[1]+s, mm[0]-s, mm[1]+s], [mm[0]-s, mm[1]+s, mm[0]-s, mm[1]-s]]
    .map((sg) => [...sg.map((v) => Math.round(v * IU)), 100000]);
  sendPresence(mm, g);
});
stage.addEventListener("pointerup", (ev) => {
  if (pan) { pan = null; return; }
  if (fdrag) {
    const fd = fdrag; fdrag = null;
    const it = kdoc && kdoc.items.get(fd.id), pn = it && fieldOf(it, fd.name), at = pn && KiCadCanvas.kid(pn, "at");
    if (fd.moved && at) {
      const nx = at[1], ny = at[2];
      at[1] = fd.orig[0]; at[2] = fd.orig[1]; KiCadCanvas.replaceChange(kdoc, it);          // original back so commit records the inverse
      if (nx !== fd.orig[0] || ny !== fd.orig[1]) {
        const node = JSON.parse(JSON.stringify(it.node)); const p2 = fieldOf({ node }, fd.name); const a2 = KiCadCanvas.kid(p2, "at"); a2[1] = nx; a2[2] = ny;
        commitChanges([KiCadCanvas.replaceChange(kdoc, Object.assign({}, it, { node, geom: [], bbox: null }))], "move " + fd.name.toLowerCase());
      }
      requestRender();
    }
    return;
  }
  if (zoomRect) { finishZoomRect(ev); return; }
  if (boxSel) { finishBoxSel(ev); return; }
  const modU = activeModule();
  if (modU && moduleTool(tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } return; }
  if (ev.button !== 0 || !drag) return;
  if (drag.group) { finishGroupDrag(); return; }
  if (drag.engine) {
    const fpE = drag.fp, cur = drag.curMm; drag = null; dragG.replaceChildren();
    if (CollabTools.sch.state.drag) { try { CollabTools.sch.endDrag(toolCtx(), true); } catch (e) { console.warn(e); } }
    sendPresence(cur, []);
    if (kdoc) syncItemsFromDoc(); selected = items.find((f) => f.id === fpE.id) || selected; drawSelection(); renderProps(); requestRender();
    return;
  }
  const fp = drag.fp, wasMoved = drag.moved, wires = drag.wires || [];
  const nx = Math.round(drag.curMm[0] * IU), ny = Math.round(drag.curMm[1] * IU);
  drag = null; dragG.replaceChildren();
  sendPresence([nx / IU, ny / IU], []);
  if (!wasMoved) return;
  const changes = [];
  if (nx !== fp.x || ny !== fp.y) changes.push(moveOp(fp, nx, ny));
  for (const w of wires) changes.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(kdoc, w.item) });
  if (changes.length) {
    if (ws && ws.readyState === 1) sendOp(changes);
    // inverse: put the symbol and the wire ends back
    const inverse = [moveOp({ id: fp.id, x: nx, y: ny }, fp.x, fp.y)];
    for (const w of wires) { const p = KiCadCanvas.ptsOf(w.item.node).map((q) => q.slice()); p[w.index] = w.orig; inverse.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: "(kicad_sch (version 20250114) (generator \"kicad-collab-web\") " + KiCadCanvas.serialize(Object.assign([], w.item.node, { })).replace(/\(pts[^]*?\)\)/, "(pts " + p.map((q) => `(xy ${q[0]} ${q[1]})`).join(" ") + ")") + ")" }); }
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  }
  fp.x = nx; fp.y = ny; if (kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
});

document.addEventListener("keydown", (ev) => {
  if (["TEXTAREA", "INPUT"].includes(ev.target.tagName) || state.view !== "editor") return;
  const k = ev.key;
  if (window.KDialogs && KDialogs.isOpen()) return;                     // the dialog owns the keyboard
  if (k === "Escape") { if (store.get().popover) { closePopover(); return; }
    if (selField || fdrag) { selField = null; fdrag = null; requestRender(); }
    if (drag && drag.engine && CollabTools.sch && CollabTools.sch.cancelDrag) { try { CollabTools.sch.cancelDrag(toolCtx()); } catch (e) { console.warn(e); } }
    drag = null; boxSel = null; clearSelection(); if (highlightIds) { highlightIds = null; } dragG.replaceChildren(); drawSelection(); renderProps(); cmtPanel.style.display = "none"; setTool("select"); return; }
  if ((k === "Delete" || k === "Backspace") && selection.size > 1 && !viewOnly) { ev.preventDefault(); deleteSelection(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "a" || k === "A")) { ev.preventDefault(); selectAll(); return; }
  if (k === "f" || k === "F") { fitView(); return; }
  if (k === "+" || k === "=") { zoomBy(1.25); return; }
  if (k === "-" || k === "_") { zoomBy(0.8); return; }
  if (k === "s" || k === "S") { setTool("select"); return; }
  if (k === "h" || k === "H") { setTool("pan"); return; }
  if (k === "c" || k === "C") { setTool("comment"); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "z" || k === "Z")) { ev.preventDefault(); if (ev.shiftKey) redoLast(); else undoLast(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "y" || k === "Y")) { ev.preventDefault(); redoLast(); return; }
  // The module's menu actions ({id: {label, key, run(ctx) -> handled}}) bind KiCad's default hotkeys after the
  // editor's own fixed keys (F, S, H, C, ±, undo); an action that reports "not handled" lets the key fall through.
  if (runModuleHotkey(ev)) { ev.preventDefault(); return; }
  const modK = activeModule();
  if (modK && modK.onKey && !ev.metaKey && !ev.ctrlKey) { try { if (modK.onKey(k, ev, toolCtx())) { ev.preventDefault(); syncSchModes(); return; } } catch (e) { console.warn(e); } }
  if (k === " " && !ev.shiftKey) { ev.preventDefault(); localOrigin = lastCursorMm.slice(); store.slice("viewport", { origin: localOrigin.slice() }); return; }
  if ((k === "e" || k === "E") && !ev.metaKey && !ev.ctrlKey) { if (openSelectionProperties()) { ev.preventDefault(); return; } }
  if (k === "g" || k === "G") { gridOn = !gridOn; updateGridStatus(); requestRender(); return; }
  if (k === "n" || k === "N") { snapOn = !snapOn; updateGridStatus(); return; }
  if (!selected || viewOnly || !ws || ws.readyState !== 1) return;
  if ((k === "r" || k === "R") && !isSch()) rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

function rotateSelected(delta) {
  const d = typeof delta === "number" ? delta : 90;
  const before = selected.rot || 0, after = (((before + d) % 360) + 360) % 360;
  sendOp([{ id: selected.id, typeName: ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
  selected.rot = after;
  if (kdoc) applyChanges([{ id: selected.id, kind: "MODIFIED", properties: [{ name: "Orientation", after: { v: after } }] }]);
  drawSelection(); renderProps();
}
function deleteSelected() {
  sendOp([{ id: selected.id, typeName: ITEM_TYPE, kind: "REMOVED", properties: [] }]);
  if (kdoc) kdoc.items.delete(selected.id);
  items = items.filter((f) => f.id !== selected.id);
  selected = null; drawSelection(); renderProps(); renderObjects(); requestRender(); toast("Deleted");
}
function moveOp(fp, nx, ny) {
  return { id: fp.id, typeName: ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Position X", before: { type: "int", v: fp.x }, after: { type: "int", v: nx } },
    { name: "Position Y", before: { type: "int", v: fp.y }, after: { type: "int", v: ny } }] };
}
/** Hit-test options: hidden layers never count and the active layer's side is preferred (KiCad's candidate rules). */
function hitOpts() { return { hidden: hiddenLayers, side: !isSch() && activeLayer && /^B\./.test(activeLayer) ? "B" : "F" }; }
let lastFpHit = null;   // {id, onGeom} of the latest nearestFootprint() call
function nearestFootprint(x, y, radiusMm) {
  if (kdoc) { const f = selFilter(); if ((isSch() && f.symbols === false) || (!isSch() && f.footprints === false)) return null; lastFpHit = KiCadCanvas.hitTestDetail(kdoc, x, y, Math.min(radiusMm, 0.5), hitOpts()); const id = lastFpHit ? lastFpHit.id : null; return id ? items.find((f2) => f2.id === id) || null : null; }
  let best = null, bestD = radiusMm;
  for (const fp of items) { const d = Math.hypot(fp.x / IU - x, fp.y / IU - y); if (d < bestD) { best = fp; bestD = d; } }
  return best;
}

// ---- overlay drawing ----
function svgText(x, y, size, color, text) {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y); t.setAttribute("fill", color); t.setAttribute("font-size", size);
  t.setAttribute("font-family", "system-ui, sans-serif"); t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "#001023"); t.setAttribute("stroke-width", size / 4); t.textContent = text;
  return t;
}
function drawSelection() {
  selG.replaceChildren();
  if (!selected) return;
  if (kdoc) { requestRender(); return; }   // the renderer draws KiCad's selection halo around the item itself
  const s = pxPerMm(), x = selected.x / IU, y = selected.y / IU;
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", x); ring.setAttribute("cy", y); ring.setAttribute("r", 10 / s);
  ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#ffb43a");
  ring.setAttribute("stroke-width", 2.5 / s); ring.setAttribute("stroke-dasharray", `${5 / s} ${3 / s}`);
  selG.appendChild(ring);
  selG.appendChild(svgText(x + 12 / s, y - 12 / s, 12 / s, "#ffb43a", isSch() ? fpName(selected) : `${selected.lib.split(":").pop()} (${Math.round(selected.rot || 0)}°)`));
}
function drawDrag() {
  dragG.replaceChildren();
  if (!drag) return;
  const s = pxPerMm(), [x, y] = drag.curMm;
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", drag.fp.x / IU); line.setAttribute("y1", drag.fp.y / IU);
  line.setAttribute("x2", x); line.setAttribute("y2", y);
  line.setAttribute("stroke", "#ffb43a"); line.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); line.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(line);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4 / s);
  dot.setAttribute("fill", "none"); dot.setAttribute("stroke", "#ffb43a"); dot.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(dot);
  dragG.appendChild(svgText(x + 6 / s, y - 6 / s, 12 / s, "#ffb43a", isSch() ? fpName(drag.fp) : drag.fp.lib.split(":").pop()));
}
function drawPeers(peers) {
  peersG.replaceChildren();
  const s = pxPerMm(), mm = (nm) => nm / IU;
  for (const [cid, p] of Object.entries(peers)) {
    const st = p.state || {}, color = (p.user && p.user.color) || "#4477ee", name = peerName(p);
    for (const g of st.ghost || []) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(g[0])); line.setAttribute("y1", mm(g[1])); line.setAttribute("x2", mm(g[2])); line.setAttribute("y2", mm(g[3]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", Math.max(mm(g[4] || 0), 2 / s)); line.setAttribute("stroke-linecap", "round");
      peersG.appendChild(line);
    }
    for (const b of st.boxes || []) {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mm(b[0])); rect.setAttribute("y", mm(b[1])); rect.setAttribute("width", mm(b[2])); rect.setAttribute("height", mm(b[3]));
      rect.setAttribute("fill", color); rect.setAttribute("fill-opacity", "0.18"); rect.setAttribute("stroke", color); rect.setAttribute("stroke-width", 3 / s);
      peersG.appendChild(rect);
    }
    if (Array.isArray(st.cursor)) {
      const x = mm(st.cursor[0]), y = mm(st.cursor[1]), t = 14 / s;
      const tri = document.createElementNS(NS, "path");
      tri.setAttribute("d", `M ${x} ${y} L ${x + 0.38 * t} ${y + t} L ${x + t} ${y + 0.38 * t} Z`);
      tri.setAttribute("fill", color); tri.setAttribute("stroke", "white"); tri.setAttribute("stroke-width", 1 / s);
      peersG.appendChild(tri);
      const label = svgText(x + 1.1 * t, y + 1.7 * t, 12 / s, color, followPeer === cid ? name + " ✔" : name);
      label.style.pointerEvents = "auto"; label.style.cursor = "pointer";
      label.addEventListener("click", (ev) => { ev.stopPropagation(); followPeer = followPeer === cid ? null : cid; toast(followPeer ? `Following ${name}` : "Stopped following"); renderPeers(); });
      peersG.appendChild(label);
    }
  }
}

// ---- panels ----
// The docked panes are React (server/web/components/panes); app.js publishes what they show.
/** Publish the selection; bumping its version makes the Properties island redraw (props.js). */
function renderProps() {
  const v = store.get().selection.version + 1;
  store.set({ selection: { ids: Array.from(selectedSet() || []), primary: selected ? Object.assign({}, selected) : null, field: selField ? { id: selField.id, name: selField.name } : null, version: v } });
}
/** The Properties pane's imperative island: props.js draws into the pane's div (window.CollabApp.renderProps). */
function renderPropsInto(el) {
  if (!el) return;
  const $ = (sel) => el.querySelector(sel);
  if (kdoc && CollabTools.props && CollabTools.props.render) { try { CollabTools.props.render(el, selected || (selField ? { id: selField.id } : null), toolCtx()); return; } catch (e) { console.warn(e); } }
  if (!selected) { el.innerHTML = `<p class="note">Select a footprint on the board to see its properties.</p>`; return; }
  const ro = viewOnly ? "disabled" : "";
  if (isSch()) {
    el.innerHTML = `<div class="kv">
      <label>Reference</label><div class="ro">${esc(selected.ref || "")}</div>
      <label>Value</label><div class="ro">${esc(selected.value || "")}</div>
      <label>Symbol</label><div class="ro" title="${esc(selected.lib)}">${esc(selected.lib)}</div>
      <label>X (mm)</label><input id="pX" type="number" step="0.01" value="${(selected.x / IU).toFixed(2)}" ${ro}>
      <label>Y (mm)</label><input id="pY" type="number" step="0.01" value="${(selected.y / IU).toFixed(2)}" ${ro}>
      <label>Rotation</label><div class="ro">${Math.round(selected.rot || 0)}°</div>
      <label>UUID</label><div class="ro muted">${esc(selected.id)}</div></div>
      <div class="actions"><button class="btn sm danger" id="pDelBtn" ${ro}>Delete</button></div>`;
    if (viewOnly) return;
    const commitPos = () => {
      const nx = Math.round(parseFloat($("#pX").value) * IU), ny = Math.round(parseFloat($("#pY").value) * IU);
      if (isNaN(nx) || isNaN(ny) || (nx === selected.x && ny === selected.y)) return;
      sendOp([moveOp(selected, nx, ny)]); selected.x = nx; selected.y = ny; drawSelection();
    };
    $("#pX").onchange = commitPos; $("#pY").onchange = commitPos; $("#pDelBtn").onclick = deleteSelected;
    return;
  }
  el.innerHTML = `<div class="kv">
    <label>Footprint</label><div class="ro" title="${esc(selected.lib)}">${esc(selected.lib)}</div>
    <label>X (mm)</label><input id="pX" type="number" step="0.01" value="${(selected.x / IU).toFixed(3)}" ${ro}>
    <label>Y (mm)</label><input id="pY" type="number" step="0.01" value="${(selected.y / IU).toFixed(3)}" ${ro}>
    <label>Rotation</label><input id="pRot" type="number" step="1" value="${Math.round(selected.rot || 0)}" ${ro}>
    <label>UUID</label><div class="ro muted">${esc(selected.id)}</div></div>
    <div class="actions"><button class="btn sm" id="pRotBtn" ${ro}>Rotate 90°</button><button class="btn sm danger" id="pDelBtn" ${ro}>Delete</button></div>`;
  if (viewOnly) return;
  const commitPos = () => {
    const nx = Math.round(parseFloat($("#pX").value) * IU), ny = Math.round(parseFloat($("#pY").value) * IU);
    if (isNaN(nx) || isNaN(ny) || (nx === selected.x && ny === selected.y)) return;
    sendOp([moveOp(selected, nx, ny)]); selected.x = nx; selected.y = ny; drawSelection();
  };
  $("#pX").onchange = commitPos; $("#pY").onchange = commitPos;
  $("#pRot").onchange = () => {
    const after = ((parseFloat($("#pRot").value) % 360) + 360) % 360, before = selected.rot || 0;
    if (isNaN(after) || after === before) return;
    sendOp([{ id: selected.id, typeName: ITEM_TYPE, kind: "MODIFIED", properties: [{ name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
    selected.rot = after; drawSelection();
  };
  $("#pRotBtn").onclick = rotateSelected; $("#pDelBtn").onclick = deleteSelected;
}
function renderPeers() {
  store.set({ peers: { list: Object.keys(peerState).map((cid) => { const p = peerState[cid]; return { cid, name: peerName(p), color: (p.user && p.user.color) || "#4477ee" }; }), follow: followPeer } });
}
function followAction(cid) { followPeer = cid && peerState[cid] ? cid : null; applyFollowWeb(peerState); renderPeers(); }
function renderThreads() { store.set({ comments: comments.slice() }); }
function openThreadAction(id) { const c = comments.find((x) => x.id === id); if (c) { centerOn(c.x / IU, c.y / IU); showThread(c.id); } }
function centerOn(xMm, yMm) {
  const w = world.clientWidth, h = w * mmH() / mmW();
  panX = stage.clientWidth / 2 - ((xMm - mmX0()) / mmW()) * w * zoom;
  panY = stage.clientHeight / 2 - ((yMm - mmY0()) / mmH()) * h * zoom;
  applyView();
}
async function loadHistory() {
  store.slice("history", { loading: true });
  try {
    const j = await api(`/api/projects/${state.project.projectId}/checkpoints`);
    const byName = {};
    for (const c of j.checkpoints || []) (byName[c.name] ||= { name: c.name, at: c.createdAt, docs: [] }).docs.push(c);
    const list = Object.values(byName).sort((a, b) => new Date(b.at) - new Date(a.at));
    store.set({ history: { groups: list.map((c) => ({ name: c.name, at: c.at, docs: c.docs.length })), loading: false, error: null } });
  } catch (e) { store.set({ history: { groups: [], loading: false, error: e.message } }); }
}
async function restoreCheckpoint(name) {
  if (!name || viewOnly || !state.project || !confirm(`Restore "${name}"? Everyone in the session gets this version.`)) return;
  try { await api(`/api/projects/${state.project.projectId}/restore`, { method: "POST", body: JSON.stringify({ name }) }); toast("Restored — rendering…"); scheduleRenderRefresh(); }
  catch (e) { toast("Restore failed: " + e.message, 4000); }
}

// ---- comments ----
async function loadComments() {
  if (!state.docId) return;
  try { comments = (await api(`/api/docs/${state.docId}/comments`)).comments || []; } catch { comments = []; }
  drawComments(); renderThreads();
}
function noteCommentMsg(msg) {
  const c = msg.comment || {}, inner = c.comment || {};
  if (c.action === "deleted") comments = comments.filter((x) => x.id !== inner.id && x.parentId !== inner.id);
  else if (c.action === "updated") comments = comments.map((x) => (x.id === inner.id ? inner : x));
  else if (c.action === "added" && !comments.some((x) => x.id === inner.id)) comments.push(inner);
  drawComments(); renderThreads();
  if (openThread !== null) showThread(openThread);
}
function drawComments() {
  cmtG.replaceChildren();
  const s = pxPerMm();
  for (const c of comments) {
    if (c.resolved) continue;   // resolved threads leave the canvas; the Comments pane still lists them
    if (c.parentId) continue;
    const x = c.x / IU, y = c.y / IU, r = 9 / s;
    const pin = document.createElementNS(NS, "g"); pin.setAttribute("cursor", "pointer");
    const bubble = document.createElementNS(NS, "circle");
    bubble.setAttribute("cx", x); bubble.setAttribute("cy", y); bubble.setAttribute("r", r);
    bubble.setAttribute("fill", c.resolved ? "#7a8794" : "#ffb43a"); bubble.setAttribute("stroke", "#001023"); bubble.setAttribute("stroke-width", 1.5 / s);
    pin.appendChild(bubble);
    const glyph = document.createElementNS(NS, "text");
    glyph.setAttribute("x", x); glyph.setAttribute("y", y + 3.2 / s); glyph.setAttribute("text-anchor", "middle");
    glyph.setAttribute("fill", "#001023"); glyph.setAttribute("font-size", 10 / s); glyph.setAttribute("font-family", "system-ui, sans-serif"); glyph.setAttribute("font-weight", "700");
    glyph.textContent = String(comments.filter((x) => x.id === c.id || x.parentId === c.id).length);
    pin.appendChild(glyph);
    pin.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    pin.addEventListener("click", (ev) => { ev.stopPropagation(); showThread(c.id); });
    cmtG.appendChild(pin);
  }
}
function panelAt(xNm, yNm) {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const px = wr.left - sr.left + ((xNm / IU - mmX0()) / mmW()) * wr.width;
  const py = wr.top - sr.top + ((yNm / IU - mmY0()) / mmH()) * wr.height;
  cmtPanel.style.left = Math.max(0, Math.min(px + 14, sr.width - 350)) + "px";
  cmtPanel.style.top = Math.max(0, Math.min(py - 10, sr.height - 160)) + "px";
  cmtPanel.style.display = "block";
}
function showThread(rootId) {
  const root = comments.find((c) => c.id === rootId);
  if (!root) { cmtPanel.style.display = "none"; openThread = null; return; }
  openThread = rootId;
  const thread = [root, ...comments.filter((c) => c.parentId === rootId)];
  cmtPanel.innerHTML = thread.map((c) => `<div class="meta">${esc(c.authorLogin)} · ${ago(c.createdAt)}</div><div class="cbody">${esc(c.body)}</div>`).join("")
    + (canJoin ? `<textarea id="replyText" rows="2" placeholder="Reply…"></textarea>
       <p><button class="btn sm primary" id="replyBtn">Reply</button><button class="btn sm" id="resolveBtn">${root.resolved ? "Reopen" : "Resolve"}</button><button class="btn sm" id="closeBtn">Close</button></p>`
     : `<p><button class="btn sm" id="closeBtn">Close</button></p>`);
  panelAt(root.x, root.y);
  $("#closeBtn").onclick = () => { cmtPanel.style.display = "none"; openThread = null; };
  const rb = $("#replyBtn");
  if (rb) rb.onclick = async () => { const text = $("#replyText").value.trim(); if (!text) return;
    await api(`/api/docs/${state.docId}/comments`, { method: "POST", body: JSON.stringify({ body: text, parentId: rootId }) }); };
  const sb = $("#resolveBtn");
  if (sb) sb.onclick = () => api(`/api/comments/${rootId}`, { method: "PATCH", body: JSON.stringify({ resolved: !root.resolved }) });
}
function placeComment(ev) {
  setTool("select");
  const [x, y] = worldMm(ev), xNm = Math.round(x * IU), yNm = Math.round(y * IU);
  openThread = null;
  cmtPanel.innerHTML = `<div class="meta">New comment</div><textarea id="newText" rows="3" placeholder="Say something about this spot…"></textarea>
    <p><button class="btn sm primary" id="postBtn">Post</button><button class="btn sm" id="cancelBtn">Cancel</button></p>`;
  panelAt(xNm, yNm);
  $("#newText").focus();
  $("#cancelBtn").onclick = () => cmtPanel.style.display = "none";
  $("#postBtn").onclick = async () => { const text = $("#newText").value.trim(); if (!text) return; cmtPanel.style.display = "none";
    try { await api(`/api/docs/${state.docId}/comments`, { method: "POST", body: JSON.stringify({ body: text, x: xNm, y: yNm }) }); }
    catch (e) { toast("Couldn't post: " + e.message, 4000); } };
}

// ---- websocket / presence / ops ----
function setConn(cls, text) { store.slice("connection", { status: cls === "live" ? "live" : cls === "err" ? "error" : "offline", text: text || (cls === "live" ? "live" : "offline") }); }
function setViewOnly(v) { viewOnly = !!v; store.set({ viewOnly }); }
let connectGen = 0;   // bumped by every connect()/leaveDoc(); a stale socket's events are ignored
async function connect() {
  const gen = ++connectGen;
  if (!state.me) { setConn("", "sign in to collaborate"); return; }
  setConn("err", retries ? `reconnecting…` : "connecting…");
  // A cookie riding the WS upgrade is unreliable (SameSite / tracking
  // protection / proxies), so authenticate the socket with a token fetched
  // over a normal request and sent in the hello frame, like the desktop.
  let ticket;
  try {
    ticket = (await api("/api/ws-ticket")).token || "";
  } catch (e) {
    if (gen === connectGen) setConn("err", "sign-in expired — reload to reconnect");
    return;   // a bad ticket would just loop; wait for a reload/re-auth
  }
  if (gen !== connectGen || state.view !== "editor") return;   // the document changed while we waited
  wsToken = ticket;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let sock;
  try { sock = new WebSocket(`${proto}://${location.host}/ws`); }
  catch (e) { setConn("err", "connection blocked (VPN or proxy?)"); return; }
  ws = sock;
  // A proxy that accepts the upgrade but never relays frames leaves the socket
  // open and silent; treat "no hello_ok" as a failure and retry rather than
  // sitting on the initial label forever.
  let handshakeDone = false;
  const watchdog = setTimeout(() => {
    if (ws !== sock || handshakeDone) return;
    console.warn("collab socket: no answer to hello within 8s (VPN/proxy?)");
    setConn("err", "no answer from server (VPN or proxy?) — retrying");
    sock.close();
  }, 8000);
  sock.onopen = () => { if (ws !== sock) return; myClientId = "web-" + Math.random().toString(36).slice(2, 10);
    sock.send(JSON.stringify({ type: "hello", proto: 1, token: wsToken, clientId: myClientId, linkToken: null, client: "web" })); };
  sock.onclose = (ev) => {
    clearTimeout(watchdog);
    console.warn(`collab socket closed: code=${ev.code} clean=${ev.wasClean} reason=${JSON.stringify(ev.reason || "")}`);
    if (ws !== sock || gen !== connectGen) return;   // superseded: not ours to reconnect
    ws = null;
    peersG.replaceChildren(); peerState = {}; renderPeers();
    const delay = Math.min(15000, 1000 * Math.pow(2, retries++));
    setConn("err", `reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (state.view === "editor" && gen === connectGen) connect().catch(() => {}); }, delay);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") console.warn("collab server error:", msg.code, msg.docId || "");
    if (msg.type === "hello_ok") { handshakeDone = true; clearTimeout(watchdog); retries = 0; sock.send(JSON.stringify({ type: "join_doc", docId: state.docId })); }
    if (msg.type === "error" && (msg.code === "bad_message" || msg.code === "unsupported_protocol")) { setConn("err", `server refused the session (${msg.code}) — reload`); }
    if (msg.type === "error" && msg.code === "auth_failed") {
      sock.onclose = null; sock.close(); if (ws === sock) ws = null;
      setConn("err", "sign-in expired — reload to reconnect");
    }
    if (msg.type === "doc_info") { peerState = {}; setConn("live", viewOnly ? "live · view-only" : "live"); renderPeers(); }
    if (msg.type === "presence") { for (const [cid, e] of Object.entries(msg.peers || {})) { if (cid === myClientId || cid.endsWith(":" + myClientId)) continue; if (e === null) delete peerState[cid]; else peerState[cid] = e; }
      drawPeers(peerState); applyFollowWeb(peerState); renderPeers(); }
    if (msg.type === "peer_left" && msg.clientId) { delete peerState[msg.clientId]; drawPeers(peerState); applyFollowWeb(peerState); renderPeers(); }
    if (msg.type === "error" && msg.code === "permission_denied") { setViewOnly(true); drag = null; dragG.replaceChildren(); setConn("live", "live · view-only"); renderProps(); toast("You have view-only access here"); }
    if (msg.type === "error" && msg.code === "desynced") { sock.send(JSON.stringify({ type: "resync", docId: state.docId })); }
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "snapshot" && msg.docId === state.docId && typeof msg.file === "string") {
      if (setDocFromText(msg.file)) for (const op of msg.thenOps || []) applyChanges(op.changes);
    }
    if (msg.type === "op") { editsSeen++; if (kdoc) applyChanges(msg.changes); else noteRemoteOp(msg); bumpEdits(); if (!kdoc) scheduleRenderRefresh(); }
    if (msg.type === "ops") { editsSeen += (msg.ops || []).length; if (kdoc) for (const op of msg.ops || []) applyChanges(op.changes); bumpEdits(); if (!kdoc) scheduleRenderRefresh(); }
    if (msg.type === "reset" && msg.docId === state.docId) { sock.send(JSON.stringify({ type: "resync", docId: state.docId })); }
  };
}
function bumpEdits() { store.slice("connection", { edits: editsSeen }); }
function noteRemoteOp(msg) {
  for (const c of msg.changes || []) {
    if (c.typeName !== ITEM_TYPE) continue;
    if (c.kind === "REMOVED") { items = items.filter((f) => f.id !== c.id); selection.delete(c.id); if (selected && selected.id === c.id) { selected = null; renderProps(); } continue; }
    const fp = items.find((f) => f.id === c.id);
    if (!fp || c.kind !== "MODIFIED") continue;
    for (const p of c.properties || []) {
      if (p.name === "Position X" && p.after) fp.x = p.after.v;
      if (p.name === "Position Y" && p.after) fp.y = p.after.v;
      if (p.name === "Orientation" && p.after) fp.rot = p.after.v;
    }
    if (selected && selected.id === fp.id) renderProps();
  }
  drawSelection(); renderObjects();
}
function sendPresence(mmPos, ghostSegs) {
  const now = Date.now();
  if (!ws || ws.readyState !== 1 || (now - lastPresence < 80 && !ghostSegs)) return;
  lastPresence = now;
  const st = { cursor: [Math.round(mmPos[0] * IU), Math.round(mmPos[1] * IU)] };
  const vp = visibleRectNm(); if (vp) st.viewport = vp;
  if (ghostSegs) st.ghost = ghostSegs;
  ws.send(JSON.stringify({ type: "presence", docId: state.docId, state: st }));
}
function sendOp(changes) {
  if (!ws || ws.readyState !== 1) { toast("Not connected"); return; }
  ws.send(JSON.stringify({ type: "op", docId: state.docId, clientOpId: `web:${++opN}`, baseSeq: null, changes }));
  editsSeen++; bumpEdits(); if (!kdoc) scheduleRenderRefresh();
}
function scheduleRenderRefresh() {
  renderDirtySince = Date.now();
  if (renderTimer) return;
  renderTimer = setInterval(async () => {
    if (Date.now() - renderDirtySince > 120000 || state.view !== "editor") { clearInterval(renderTimer); renderTimer = 0; return; }
    await loadBase(false);
  }, 8000);
}

// ---- actions (the home menu's entries and the collab items of the editor menus) ----
async function runAction(act, el) {
  const id = state.project && state.project.projectId;
  switch (act) {
    case "home": navigate("/"); break;
    case "zoomin": zoomBy(1.25); break;
    case "zoomout": zoomBy(0.8); break;
    case "fit": fitView(); break;
    case "grid": gridOn = !gridOn; updateGridStatus(); requestRender(); break;
    case "snap": snapOn = !snapOn; updateGridStatus(); break;
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
    case "checkpoint": if (!id) break; if (viewOnly) { toast("Only editors can create checkpoints"); break; }
      { const name = prompt("Checkpoint name", `checkpoint ${new Date().toLocaleString()}`); if (!name) break;
        try { await api(`/api/projects/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ name }) }); toast("Checkpoint created"); loadHistory(); showPane("history", true); }
        catch (e) { toast("Checkpoint failed: " + e.message, 4000); } } break;
    case "kicad": showPopover("kicad", null, el); break;
  }
}

// ================================================================ KiCad frame (the React chrome reads the store)
// Docked panes: which are open, per editor, remembered in localStorage (kui.panes.<editor>).
const PANE_NAMES = ["props", "hier", "filter", "history", "peers", "comments", "appearance"];
const PANE_EDITOR_ONLY = { hier: "sch" };
const PANE_DEFAULT_HIDDEN = { sch: ["peers", "comments", "appearance"], pcb: ["peers", "comments"] };
let panes = {};
const editorId = () => (isSch() ? "sch" : "pcb");
const paneKey = (ed) => "kui.panes." + (ed || "x");
function savedPanes(ed) { try { return JSON.parse(localStorage.getItem(paneKey(ed)) || "{}"); } catch (e) { return {}; } }
function loadPanes(ed) {
  const saved = savedPanes(ed), out = {};
  for (const n of PANE_NAMES) { const allowed = !PANE_EDITOR_ONLY[n] || PANE_EDITOR_ONLY[n] === ed; out[n] = allowed && (saved[n] !== undefined ? !!saved[n] : !PANE_DEFAULT_HIDDEN[ed].includes(n)); }
  return out;
}
function showPane(name, show) {
  const ed = editorId();
  if (!PANE_NAMES.includes(name) || (PANE_EDITOR_ONLY[name] && PANE_EDITOR_ONLY[name] !== ed)) return;
  const next = show === undefined ? !panes[name] : !!show;
  panes = Object.assign({}, panes, { [name]: next });
  const saved = savedPanes(ed); saved[name] = next;
  try { localStorage.setItem(paneKey(ed), JSON.stringify(saved)); } catch (e) { /* no storage */ }
  store.set({ panes });
  requestRender();
}
// Selection filter (panel_*selection_filter_base): per editor, a category is enabled unless set false.
const FILTER_KEYS = { sch: ["symbols", "pins", "wires", "labels", "graphics", "images", "text", "other"], pcb: ["footprints", "text", "tracks", "vias", "pads", "graphics", "zones", "dimensions", "other"] };
const filters = {};
function selFilter() { return filters[editorId()] || {}; }
function setFilter(key, on) {
  const ed = editorId(); const f = filters[ed] = filters[ed] || {};
  if (key === "all") { for (const k of FILTER_KEYS[ed]) f[k] = !!on; } else f[key] = !!on;
  store.set({ filter: Object.assign({}, f) });
  selected = null; drawSelection(); renderProps();
}
// Theme (kui.theme): light/dark override of the system preference.
function applyTheme() {
  const saved = (() => { try { return localStorage.getItem("kui.theme"); } catch (e) { return null; } })();
  if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kui.theme", next); } catch (e) { /* no storage */ }
}
// Status-bar units (EDA_DRAW_FRAME::UpdateStatusBar); the bar formats through server/web/units.ts, this is for messages.
const UNITS = { mm: { name: "mm", f: (v) => v, d: 4 }, in: { name: "in", f: (v) => v / 25.4, d: 4 }, mil: { name: "mils", f: (v) => v / 0.0254, d: 2 } };
let units = "mm";
function fmtLen(mm) { const u = UNITS[units]; return u.f(mm).toFixed(u.d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); }

function setupEditorChrome() {
  const ed = editorId();
  document.body.dataset.editor = ed;
  filters[ed] = filters[ed] || {};
  panes = loadPanes(ed);
  renderModuleTools();
  store.set({ document: Object.assign({}, store.get().document, { editor: ed, docType: DOC_TYPE }), panes: Object.assign({}, panes), filter: Object.assign({}, filters[ed]) });
  setRadio("Units", { mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" }[units]);
  setRadio("Selection modes", selMode === "lasso" ? "selectSetLasso" : "selectSetRect");
  setRadio("Crosshair modes", crosshairMode === "full" ? "cursorFullCrosshairs" : crosshairMode === "45" ? "cursor45Crosshairs" : "cursorSmallCrosshairs");
  $("#crosshair").classList.toggle("on", crosshairMode !== "small");
  setToggles({ toggleGrid: gridOn, togglePolarCoords: polarCoords, toggleHiddenPins: !!renderOpts.showHiddenPins, highContrastMode: !!renderOpts.highContrast,
    padDisplayMode: !!renderOpts.outlinePads, viaDisplayMode: !!renderOpts.outlineVias, trackDisplayMode: !!renderOpts.outlineTracks,
    zoneDisplayFilled: !renderOpts.zoneOutline, zoneDisplayOutline: !!renderOpts.zoneOutline });
  syncSchModes();
  store.slice("viewport", { units, selMode, crosshair: crosshairMode, polar: polarCoords, renderOpts: Object.assign({}, renderOpts), gridPitch, zoom, cursor: [0, 0], origin: localOrigin.slice() });
  store.slice("tool", { current: tool });
}
// The schematic module owns its line / drag modes (Shift+Space, G, M); mirror them on the toolbar.
function syncSchModes() {
  if (!isSch() || !CollabTools.sch || !CollabTools.sch.state) { store.slice("viewport", { lineMode: null, dragMode: null }); return; }
  const lm = CollabTools.sch.state.lineMode;
  setRadio("Line modes", lm === "free" ? "lineModeFree" : lm === "45" ? "lineMode45" : "lineMode90");
  store.slice("viewport", { lineMode: lm === "free" ? "free" : lm === "45" ? "45" : "90", dragMode: CollabTools.sch.state.dragMode || null });
}
function openDocId(id) { const d = state.docs.find((x) => x.docId === id); if (d) openDoc(d); }
function navigateDocs(dir) {
  const i = docNav.idx + dir; if (i < 0 || i >= docNav.list.length) { toast(dir < 0 ? "No previous sheet" : "No next sheet"); return; }
  docNav.lock = true; docNav.idx = i; try { openDocId(docNav.list[i]); } finally { docNav.lock = false; }
}
function switchEditor() {
  const target = isSch() ? state.docs.find((d) => d.docType === "kicad_pcb") : rootSchematic();
  if (target) openDoc(target); else toast(isSch() ? "This project has no board yet" : "This project has no schematic yet");
}
function setUnitsAction(u, id) { if (UNITS[u]) units = u; setRadio("Units", id); store.slice("viewport", { units }); }
function setCrosshair(mode, id) { crosshairMode = mode; setRadio("Crosshair modes", id); $("#crosshair").classList.toggle("on", mode !== "small"); store.slice("viewport", { crosshair: mode }); }
/** File → Plot: SVG or PNG of the current document (KiCad's plot dialog, the web's subset). */
function plotDialog() {
  if (!kdoc || !window.KDialogs) return;
  const name = (state.docs.find((d) => d.docId === state.docId) || {}).path || (isSch() ? "sheet.kicad_sch" : "board.kicad_pcb");
  const stem = name.split("/").pop().replace(/\.kicad_(sch|pcb)$/, "");
  KDialogs.open({ title: "Plot", width: 460,
    build(body) {
      body.innerHTML = `<div class="kv"><label>Format</label><select id="kd-fmt"><option value="svg">SVG</option><option value="png">PNG</option></select>
        <label>Resolution (PNG)</label><input id="kd-dpi" type="number" value="300" min="72" max="1200" step="1">
        <label>Content</label><select id="kd-scope"><option value="all">Whole ${isSch() ? "sheet" : "board"}</option><option value="sel"${selection.size ? "" : " disabled"}>Selection only</option></select>
        <label></label><label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="kd-bg" type="checkbox" style="width:auto;margin:0"> Include background</label>
        <label></label><label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="kd-hid" type="checkbox" style="width:auto;margin:0"${isSch() ? "" : " disabled"}> Show hidden pins</label></div>
        <p class="kd-note" style="margin-top:10px">Hidden layers stay hidden; the file downloads as ${esc(stem)}.svg / .png.</p>`;
    },
    okLabel: "Plot",
    ok() {
      const g = (id) => document.querySelector("#" + id);
      const fmt = g("kd-fmt").value, dpi = Math.max(72, Math.min(1200, +g("kd-dpi").value || 300));
      const opts = { hidden: hiddenLayers, background: g("kd-bg").checked ? undefined : false, showHiddenPins: !!g("kd-hid").checked, zoneOutline: !!renderOpts.zoneOutline };
      if (g("kd-scope").value === "sel" && selection.size) opts.ids = [...selection];
      const download = (blob, ext) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${stem}.${ext}`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
      try {
        if (fmt === "svg") { download(new Blob([KiCadCanvas.renderSvg(kdoc, opts)], { type: "image/svg+xml" }), "svg"); toast("Plotted " + stem + ".svg"); }
        else { toast("Rendering PNG…"); KiCadCanvas.renderPng(kdoc, Object.assign({ dpi }, opts, renderOpts)).then((blob) => { download(blob, "png"); toast("Plotted " + stem + ".png"); }).catch((e) => { console.warn(e); toast("PNG export failed"); }); }
      } catch (e) { console.warn(e); toast("Plot failed: " + (e.message || e)); }
    } });
}
/** File → Print: the document as SVG in a print window. */
function printDocument() {
  if (!kdoc) return;
  let svg; try { svg = KiCadCanvas.renderSvg(kdoc, { hidden: hiddenLayers, background: false, zoneOutline: !!renderOpts.zoneOutline }); } catch (e) { toast("Print failed: " + (e.message || e)); return; }
  const w = window.open("", "_blank"); if (!w) { toast("Allow pop-ups to print"); return; }
  w.document.write(`<!doctype html><title>Print</title><style>html,body{margin:0;background:#fff}svg{width:100%;height:auto;max-height:100vh}@page{margin:10mm}</style>${svg}`); w.document.close();
  w.addEventListener("load", () => setTimeout(() => w.print(), 200)); setTimeout(() => { try { w.print(); } catch (e) { /* already printed */ } }, 800);
}
function toggleRenderOpt(key, id) { renderOpts[key] = !renderOpts[key]; setToggle(id, !!renderOpts[key]); store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); }
function schKey(k) { const m = CollabTools.sch; if (!m || !isSch()) return false; try { return !!m.onKey(k, {}, toolCtx()); } catch (e) { console.warn(e); return false; } }
function orientSelected(kind) {
  if (isSch()) { if (!schKey({ ccw: "r", cw: "R", mv: "y", mh: "x" }[kind])) toast("Select a symbol or item first"); return; }
  if (!selected) { toast("Select a footprint first"); return; }
  if (kind === "ccw") rotateSelected(-90); else if (kind === "cw") rotateSelected(90);
  else { const h = CollabTools.props && CollabTools.props.helpers; if (h && h.setFootprintSide) { const it = kdoc.items.get(selected.id); const side = (it && it.layer === "B.Cu") ? "F.Cu" : "B.Cu"; try { h.setFootprintSide(toolCtx(), it, side); } catch (e) { toast("Flip failed: " + e.message); } } else toast("Flip runs in the desktop app"); }
}
function deleteAction() { if (schKey("Delete")) return; if (selected && !viewOnly) deleteSelected(); else toast("Nothing selected"); }
function findPopover(el) { showPopover("find", { hits: null, query: "" }, el); }
/** The Find popover's query: select and centre the best match, report the count. */
function findAction(query) {
  const v = String(query || "").trim().toLowerCase();
  const m = v ? items.filter((fp) => fpName(fp).toLowerCase().includes(v)).sort((x, y) => (fpName(y).toLowerCase() === v) - (fpName(x).toLowerCase() === v) || (fpName(y).toLowerCase().startsWith(v)) - (fpName(x).toLowerCase().startsWith(v))) : [];
  if (m.length) { selected = m[0]; drawSelection(); renderProps(); centerOn(m[0].x / IU, m[0].y / IU); }
  const p = store.get().popover; if (p && p.kind === "find") store.set({ popover: Object.assign({}, p, { hits: v ? m.length : null, query: String(query || "") }) });
}
function gridMenu(el) { showPopover("grid", null, el); }
// measure tool: two clicks, the distance goes to the status bar
function measureClick(mm) {
  if (!measure || measure.b) { measure = { a: mm }; dragG.replaceChildren(); setStatusBar({ message: "Measure — click the second point" }); return; }
  measure.b = mm; drawMeasure(mm);
  const dx = mm[0] - measure.a[0], dy = mm[1] - measure.a[1];
  setStatusBar({ message: `dist ${fmtLen(Math.hypot(dx, dy))} ${UNITS[units].name} · dx ${fmtLen(dx)} · dy ${fmtLen(dy)} · ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°` });
}
function drawMeasure(mm) {
  if (!measure) return; dragG.replaceChildren();
  const s = pxPerMm(), a = measure.a;
  const line = document.createElementNS(NS, "line"); line.setAttribute("x1", a[0]); line.setAttribute("y1", a[1]); line.setAttribute("x2", mm[0]); line.setAttribute("y2", mm[1]);
  line.setAttribute("stroke", "#ffb43a"); line.setAttribute("stroke-width", 1.5 / s); dragG.appendChild(line);
  const t = svgText((a[0] + mm[0]) / 2, (a[1] + mm[1]) / 2 - 6 / s, 11 / s, "#ffb43a", `${fmtLen(Math.hypot(mm[0] - a[0], mm[1] - a[1]))} ${UNITS[units].name}`); t.setAttribute("text-anchor", "middle"); dragG.appendChild(t);
}
// zoom-area tool: drag a rectangle, the view fits it
function drawZoomRect(ev) {
  dragG.replaceChildren(); const a = worldMm({ clientX: zoomRect.start[0], clientY: zoomRect.start[1] }), b = worldMm(ev);
  const r = document.createElementNS(NS, "rect"); r.setAttribute("x", Math.min(a[0], b[0])); r.setAttribute("y", Math.min(a[1], b[1])); r.setAttribute("width", Math.abs(b[0] - a[0])); r.setAttribute("height", Math.abs(b[1] - a[1]));
  r.setAttribute("fill", "#4D7FC433"); r.setAttribute("stroke", "#4D7FC4"); r.setAttribute("stroke-width", 1 / pxPerMm()); dragG.appendChild(r);
}
function finishZoomRect(ev) {
  const a = worldMm({ clientX: zoomRect.start[0], clientY: zoomRect.start[1] }), b = worldMm(ev); zoomRect = null; dragG.replaceChildren();
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (w < 0.5 || h < 0.5) { zoomBy(2, ev.clientX, ev.clientY); return; }
  fitBox([Math.min(a[0], b[0]), Math.min(a[1], b[1]), w, h], 0.9);
}
// ---- multi-selection: box / lasso, group move, group delete ----
function hitAny(mm) {
  const fp = nearestFootprint(mm[0], mm[1], 5 / Math.max(1, zoom * 0.6)); if (fp) return { id: fp.id, kind: isSch() ? "symbol" : "footprint", fp };
  const m = activeModule(); const pick = m && m._ && m._.pickNonSymbol;
  if (pick) { try { const it = pick(toolCtx(), mm); if (it) return { id: it.id, kind: it.kind, item: it }; } catch (e) { /* module without pick */ } }
  return null;
}
function itemBoxCentre(it) { const b = it.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; }
function pointInPoly(p, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
function drawBoxSel() {
  dragG.replaceChildren(); if (!boxSel) return;
  const s = pxPerMm();
  if (boxSel.lasso) {
    const p = document.createElementNS(NS, "polygon"); p.setAttribute("points", boxSel.pts.map((q) => q.join(",")).join(" "));
    p.setAttribute("fill", "#4D7FC422"); p.setAttribute("stroke", "#4D7FC4"); p.setAttribute("stroke-width", 1 / s); p.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); dragG.appendChild(p);
  } else {
    const a = boxSel.start, b = boxSel.cur, ltr = b[0] >= a[0];
    const r = document.createElementNS(NS, "rect"); r.setAttribute("x", Math.min(a[0], b[0])); r.setAttribute("y", Math.min(a[1], b[1])); r.setAttribute("width", Math.abs(b[0] - a[0])); r.setAttribute("height", Math.abs(b[1] - a[1]));
    r.setAttribute("fill", ltr ? "#4D7FC422" : "#00960022"); r.setAttribute("stroke", ltr ? "#4D7FC4" : "#009600"); r.setAttribute("stroke-width", 1 / s); if (!ltr) r.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); dragG.appendChild(r);
  }
}
// KiCad: dragging left-to-right selects what the box encloses, right-to-left what it touches; the lasso takes what it contains.
function finishBoxSel(ev) {
  const b = boxSel; boxSel = null; dragG.replaceChildren(); if (!b || !kdoc) return;
  const moved = Math.hypot(ev.clientX - b.startClient[0], ev.clientY - b.startClient[1]);
  if (moved < 4) return;
  const picked = [];
  if (b.lasso) { for (const it of kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind)) continue; const c = itemBoxCentre(it); if (c && pointInPoly(c, b.pts)) picked.push(it); } }
  else {
    const x0 = Math.min(b.start[0], b.cur[0]), x1 = Math.max(b.start[0], b.cur[0]), y0 = Math.min(b.start[1], b.cur[1]), y1 = Math.max(b.start[1], b.cur[1]), enclose = b.cur[0] >= b.start[0];
    for (const it of kdoc.items.values()) { if (!it.bbox || !filterAllows(it.kind)) continue; const bb = it.bbox;
      const inside = bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1, touches = bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1;
      if (enclose ? inside : touches) picked.push(it); }
  }
  if (!b.add) selection.clear();
  for (const it of picked) selection.add(it.id);
  const prim = picked.find((it) => it.kind === "symbol" || it.kind === "footprint");
  selected = prim ? (items.find((f) => f.id === prim.id) || selected) : (b.add ? selected : null);
  if (CollabTools.sch && CollabTools.sch.select) CollabTools.sch.select(null);
  drawSelection(); renderProps(); renderObjects();
  setStatusBar({ message: selection.size ? `${selection.size} item${selection.size === 1 ? "" : "s"} selected` : "" });
}
function selectAll() {
  if (!kdoc) return; selection.clear();
  for (const it of kdoc.items.values()) if (it.bbox && filterAllows(it.kind)) selection.add(it.id);
  selected = items.find((f) => selection.has(f.id)) || null;
  drawSelection(); renderProps(); renderObjects(); setStatusBar({ message: `${selection.size} items selected` });
}
function deleteSelection() {
  if (!kdoc || !selection.size) return;
  selection = groupExpand(selection);
  const its = [...selection].map((id) => kdoc.items.get(id)).filter(Boolean);
  const m = activeModule(); let changes = null;
  if (m && m.deleteChanges) { try { changes = m.deleteChanges(kdoc, its); } catch (e) { console.warn(e); } }
  if (!changes) changes = its.map((it) => KiCadCanvas.removeChange(it));
  clearSelection(); commitChanges(changes, "delete"); drawSelection(); renderProps(); renderObjects();
  toast(`Deleted ${its.length} item${its.length === 1 ? "" : "s"}`);
}
function startGroupDrag(hit, mm, ev) {
  selection = groupExpand(selection);
  const its = [...selection].map((id) => kdoc.items.get(id)).filter(Boolean);
  const fp = hit.fp || { id: hit.id, x: Math.round(KiCadCanvas.atOf(hit.item.node)[0] * IU), y: Math.round(KiCadCanvas.atOf(hit.item.node)[1] * IU) };
  if (isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    let d = null; try { d = CollabTools.sch.beginDrag(toolCtx(), its, mm, true); } catch (e) { d = null; }
    if (d) { drag = { fp, engine: true, startMm: mm, curMm: [fp.x / IU, fp.y / IU], moved: false, wires: [] }; stage.setPointerCapture(ev.pointerId); return; }
  }
  // board (or a schematic module without group support): move the footprints together
  const members = its.filter((it) => it.kind === "footprint" || it.kind === "symbol").map((it) => { const f = items.find((q) => q.id === it.id); return f ? { fp: f, ox: f.x, oy: f.y } : null; }).filter(Boolean);
  if (!members.length) return;
  drag = { fp, group: members, startMm: mm, grab: snapMm(mm), curMm: [fp.x / IU, fp.y / IU], moved: false, last: [0, 0] };
  stage.setPointerCapture(ev.pointerId);
}
function moveGroupDrag(mm) {
  const t = snapMm(mm); const dx = Math.round((t[0] - drag.grab[0]) * IU), dy = Math.round((t[1] - drag.grab[1]) * IU);
  if (dx === drag.last[0] && dy === drag.last[1]) return; drag.last = [dx, dy]; drag.moved = true;
  for (const m of drag.group) { const nx = m.ox + dx, ny = m.oy + dy; KiCadCanvas.applyChange(kdoc, moveOp(m.fp, nx, ny), IU); m.fp.x = nx; m.fp.y = ny; }
  requestRender();
  const now = Date.now(); if (now - lastLiveMove > 150) { lastLiveMove = now; sendOp(drag.group.map((m) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y))); }
}
function finishGroupDrag() {
  const g = drag; drag = null; dragG.replaceChildren(); if (!g.moved || (!g.last[0] && !g.last[1])) return;
  const changes = g.group.map((m) => moveOp({ id: m.fp.id, x: m.ox, y: m.oy }, m.fp.x, m.fp.y));
  const inverse = g.group.map((m) => moveOp({ id: m.fp.id, x: m.fp.x, y: m.fp.y }, m.ox, m.oy));
  if (ws && ws.readyState === 1) sendOp(changes);
  undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  if (kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
}
// Every chrome action the web editor handles, by KiCad action id (or one of ours).  An id missing here
// that maps to a tool (server/web/tables.ts TOOL_MAP) activates the tool; anything else is dimmed and
// explained as desktop-only by the chrome itself.  Handlers get the anchor rect of the clicked control.
const HANDLERS = {
  selectSetRect: () => { selMode = "rect"; setRadio("Selection modes", "selectSetRect"); store.slice("viewport", { selMode }); setTool("select"); },
  selectSetLasso: () => { selMode = "lasso"; setRadio("Selection modes", "selectSetLasso"); store.slice("viewport", { selMode }); setTool("select"); },
  selectAll: () => selectAll(),
  save: (a) => runAction("checkpoint", a), refreshHistory: () => loadHistory(),
  undo: () => undoLast(), redo: () => redoLast(), find: (a) => findPopover(a), doDelete: () => deleteAction(),
  zoomRedraw: () => requestRender(), zoomInCenter: () => zoomBy(1.25), zoomOutCenter: () => zoomBy(0.8), zoomFitScreen: () => fitView(), zoomFitObjects: () => fitView(),
  navigateBack: () => navigateDocs(-1), navigateForward: () => navigateDocs(1), navigateUp: () => { const r = rootSchematic(); if (r && state.doc !== r) openDoc(r); else toast("Already at the root sheet"); },
  rotateCCW: () => orientSelected("ccw"), rotateCW: () => orientSelected("cw"), rotateCcw: () => orientSelected("ccw"), rotateCw: () => orientSelected("cw"),
  mirrorV: () => orientSelected("mv"), mirrorH: () => orientSelected("mh"),
  showPcbNew: () => switchEditor(), showEeschema: () => switchEditor(),
  toggleGrid: () => { gridOn = !gridOn; updateGridStatus(); requestRender(); }, "toggleGrid:menu": (a) => gridMenu(a),
  millimetersUnits: () => setUnitsAction("mm", "millimetersUnits"), inchesUnits: () => setUnitsAction("in", "inchesUnits"), milsUnits: () => setUnitsAction("mil", "milsUnits"),
  cursorSmallCrosshairs: () => setCrosshair("small", "cursorSmallCrosshairs"), cursorFullCrosshairs: () => setCrosshair("full", "cursorFullCrosshairs"), cursor45Crosshairs: () => setCrosshair("45", "cursor45Crosshairs"),
  togglePolarCoords: () => { polarCoords = !polarCoords; setToggle("togglePolarCoords", polarCoords); store.slice("viewport", { polar: polarCoords }); },
  toggleHiddenPins: () => toggleRenderOpt("showHiddenPins", "toggleHiddenPins"),
  highContrastMode: () => toggleRenderOpt("highContrast", "highContrastMode"),
  padDisplayMode: () => toggleRenderOpt("outlinePads", "padDisplayMode"), viaDisplayMode: () => toggleRenderOpt("outlineVias", "viaDisplayMode"), trackDisplayMode: () => toggleRenderOpt("outlineTracks", "trackDisplayMode"),
  zoneDisplayFilled: () => { renderOpts.zoneOutline = false; setToggles({ zoneDisplayFilled: true, zoneDisplayOutline: false }); store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); },
  zoneDisplayOutline: () => { renderOpts.zoneOutline = true; setToggles({ zoneDisplayFilled: false, zoneDisplayOutline: true }); store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); },
  showNetNames: () => toggleRenderOpt("netNames", "showNetNames"),
  flipBoard: () => toggleRenderOpt("flip", "flipBoard"),
  showHiddenText: () => toggleRenderOpt("showHiddenText", "showHiddenText"),
  zoneFillPreview: () => toggleRenderOpt("zoneFill", "zoneFillPreview"),
  showPadNumbers: () => { renderOpts.padNumbers = renderOpts.padNumbers === false; setToggle("showPadNumbers", renderOpts.padNumbers !== false); store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); },
  clearMarkers: () => { markers = []; renderOpts.markers = undefined; const m = activeModule(); if (m && m.actions && m.actions.clearMarkers) { try { m.actions.clearMarkers.run(toolCtx()); } catch (e) { /* module without markers */ } } store.slice("viewport", { renderOpts: Object.assign({}, renderOpts) }); requestRender(); },
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
store.slice("tool", { handled: Object.keys(HANDLERS) });

/** window.CollabApp.dispatch: the chrome's intents (typed as AppAction in server/web/store.ts). */
function dispatchAction(a) {
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
      case "setZoom": if (a.zoom === "auto") fitView(); else { viewTouched = true; zoom = Math.min(400, Math.max(0.2, Number(a.zoom) / 100)); applyView(); } return;
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

// ---------- boot ----------
applyTheme();
(async () => { await loadMe(); route(); })();
