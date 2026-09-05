"use strict";
// KiCad Collaborative web app: home (recent / explore / open link) + online
// board editor.  Talks to the same REST + WebSocket API the desktop uses.

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

// ---------- tiny helpers ----------
function esc(t) { const d = document.createElement("span"); d.textContent = t ?? ""; return d.innerHTML; }
function toast(msg, ms = 2200) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), ms);
}
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
function popover(html, anchorEl) {
  const p = $("#popover");
  p.innerHTML = html;
  p.style.display = "block";
  const r = anchorEl ? anchorEl.getBoundingClientRect() : { left: innerWidth / 2 - 160, bottom: 60 };
  p.style.left = Math.min(r.left, innerWidth - p.offsetWidth - 12) + "px";
  p.style.top = Math.min(r.bottom + 6, innerHeight - p.offsetHeight - 12) + "px";
  return p;
}
function closePopover() { $("#popover").style.display = "none"; }
document.addEventListener("pointerdown", (ev) => {
  if (!ev.target.closest("#popover") && !ev.target.closest("[data-act]")) closePopover();
  if (!ev.target.closest(".menu")) $$(".menu.open").forEach((m) => m.classList.remove("open"));
});

// ---------- menus ----------
$$(".menu > button").forEach((b) => b.addEventListener("click", (ev) => {
  const m = b.parentElement, was = m.classList.contains("open");
  $$(".menu.open").forEach((x) => x.classList.remove("open"));
  if (!was) m.classList.add("open");
  ev.stopPropagation();
}));
document.addEventListener("click", (ev) => {
  const act = ev.target.closest("[data-act]");
  if (act) { $$(".menu.open").forEach((x) => x.classList.remove("open")); runAction(act.dataset.act, act); }
  const tool = ev.target.closest("[data-tool]");
  if (tool) setTool(tool.dataset.tool);
  const tab = ev.target.closest("#dockTabs [data-tab]");
  if (tab) showTab(tab.dataset.tab);
  const nav = ev.target.closest("#home nav [data-nav]");
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
  const box = $("#userBox");
  if (state.me) {
    box.innerHTML = `${state.me.avatarUrl ? `<img src="${esc(state.me.avatarUrl)}" alt="">` : ""}<span>${esc(state.me.name || state.me.login)}</span>`;
  } else {
    box.innerHTML = `<a class="btn sm" href="/auth/github/login?next=${encodeURIComponent(location.pathname)}">Sign in with GitHub</a>`;
  }
}

// ================================================================ HOME
function showView(name) {
  state.view = name;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === name));
  if (name === "home") { leaveEditor(); $("#sbProject").textContent = ""; }
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
let renderReq = 0;
const GRID_CHOICES = { kicad_sch: [[1.27, "50 mil"], [2.54, "100 mil"], [0.635, "25 mil"]], kicad_pcb: [[0.25, "0.25 mm"], [0.5, "0.5 mm"], [1, "1 mm"], [0.1, "0.1 mm"], [0.05, "0.05 mm"], [1.27, "50 mil"], [0.635, "25 mil"]] };
function requestRender() { if (renderReq || !kdoc) return; renderReq = requestAnimationFrame(() => { renderReq = 0; drawCanvas(); }); }
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
}
function drawCanvas() {
  if (!kdoc) return; sizeCanvas();
  const ppm = stage.clientWidth / mmW();
  const view = { ppm, zoom, panX, panY, x0: mmX0(), y0: mmY0(), dpr: window.devicePixelRatio || 1 };
  KiCadCanvas.render(kdoc, cctx, view, { hidden: hiddenLayers, grid: gridOn ? gridPitch : 0, selected: selected ? new Set([selected.id]) : null });
  const m = activeModule();
  if (m && m.drawOverlay) { try { cctx.save(); KiCadCanvas.setViewTransform(cctx, view); m.drawOverlay(cctx, view, toolCtx()); } catch (e) { console.warn(e); } finally { cctx.restore(); } }
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
  renderLayersFromDoc(); syncItemsFromDoc(); renderModuleTools();
  const m = activeModule(); if (m && m.onDocChanged) { try { m.onDocChanged(toolCtx()); } catch (e) { console.warn(e); } }
  canvas.style.display = "block"; requestRender();
  return true;
}
function renderLayersFromDoc() {
  const list = KiCadCanvas.layerList(kdoc);
  $("#layers").innerHTML = list.map((l) => `<label class="layer"><input type="checkbox" data-lkey="${esc(l.key)}" ${hiddenLayers.has(l.key) ? "" : "checked"}>
     <span class="sw" style="background:${l.color}"></span><span>${esc(l.name)}</span><span class="cnt">${l.count}</span></label>`).join("") || `<p class="note">Nothing to show yet.</p>`;
  $$("#layers input").forEach((cb) => cb.addEventListener("change", () => { if (cb.checked) hiddenLayers.delete(cb.dataset.lkey); else hiddenLayers.add(cb.dataset.lkey); requestRender(); }));
}
function applyChanges(changes) {
  if (!kdoc) return;
  let any = false;
  for (const c of changes || []) { try { if (KiCadCanvas.applyChange(kdoc, c, IU)) any = true; } catch (e) { console.warn("change not applied", e); } }
  if (any) { if (!isSch()) KiCadCanvas.computeBBox(kdoc); syncItemsFromDoc(); drawSelection(); requestRender(); }
}
function setupGridControls() {
  const sel = $("#gridSel"); const choices = GRID_CHOICES[DOC_TYPE] || GRID_CHOICES.kicad_pcb;
  sel.innerHTML = choices.map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  gridPitch = choices[0][0]; sel.value = String(gridPitch);
  sel.onchange = () => { gridPitch = Number(sel.value) || gridPitch; requestRender(); updateGridStatus(); };
  updateGridStatus();
}
function updateGridStatus() {
  $$("[data-act=grid]").forEach((b) => b.classList.toggle("on", gridOn));
  $$("[data-act=snap]").forEach((b) => b.classList.toggle("on", snapOn));
  const el = $("#sbGrid"); if (el) el.textContent = `grid ${gridPitch} mm · snap ${snapOn ? "on" : "off"}`;
}
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
    K: KiCadCanvas, doc: kdoc, IU, isSch: isSch(), zoom, pxPerMm: pxPerMm(), gridPitch, snapOn, snap: snapMm,
    selected, items, sheets, viewOnly, live: !!(ws && ws.readyState === 1), stage, worldMm,
    setSelected(fp) { selected = fp ? (items.find((f) => f.id === fp.id) || fp) : null; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    commit(changes, label) { commitChanges(changes, label); },
    applyLocal(changes) { applyChanges(changes); },
    requestRender, toast, enterSheet, setTool,
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
  redoStack.length = 0;
}
function undoLast() {
  const e = undoStack.pop(); if (!e) { toast("Nothing to undo"); return; }
  const redo = e.changes.map((c) => { const it = kdoc.items.get(c.id); return c.kind === "REMOVED" ? c : (it ? { id: c.id, kind: c.kind === "ADDED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(kdoc, it) } : c); });
  applyChanges(e.inverse); if (ws && ws.readyState === 1) sendOp(e.inverse);
  redoStack.push({ label: e.label, changes: redo, inverse: e.inverse }); toast("Undo " + e.label);
}
function redoLast() {
  const e = redoStack.pop(); if (!e) { toast("Nothing to redo"); return; }
  applyChanges(e.changes); if (ws && ws.readyState === 1) sendOp(e.changes);
  undoStack.push(e); toast("Redo " + e.label);
}
function renderModuleTools() {
  const m = activeModule(); const host = $("#ltools");
  $$("[data-modtool]", host).forEach((b) => b.remove());
  if (!m || !m.tools) return;
  for (const t of m.tools) {
    const b = document.createElement("button"); b.className = "tb"; b.dataset.modtool = t.id; b.title = t.label + (t.key ? ` (${t.key})` : "");
    b.innerHTML = t.icon ? `<svg viewBox="0 0 24 24">${t.icon}</svg>` : `<span style="font:11px var(--mono)">${esc(t.label.slice(0, 2))}</span>`;
    b.addEventListener("click", () => setTool(t.id)); host.appendChild(b);
  }
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
  $("#projName").textContent = info.name;
  $("#roleChip").textContent = info.role || "guest";
  $("#roleChip").className = "pill " + (info.role || "");
  $("#sbProject").textContent = `${info.name} · ${info.ownerLogin}`;
  state.docs = [];
  canJoin = !!state.me;
  viewOnly = !canJoin || info.role === "viewer" || !info.role;
  $("#signinOverlay").style.display = canJoin ? "none" : "block";
  $("#signinLink").href = `/auth/github/login?next=${encodeURIComponent(location.pathname)}`;
  $$("[data-act=share],[data-act=checkpoint]").forEach((b) => { b.disabled = viewOnly; });
  state.docs = info.docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
  renderDocSwitcher();
  loadHistory();
  const wanted = new URLSearchParams(location.search).get("doc");
  // Open what has something to show: a rendered board first, else the root
  // schematic (a schematic-only project has an empty placeholder board).
  const doc = state.docs.find((d) => d.docId === wanted)
    || state.docs.find((d) => d.docType === "kicad_pcb" && d.hasPreview)
    || (rootSchematic() && rootSchematic().hasPreview ? rootSchematic() : null)
    || state.docs.find((d) => d.docType === "kicad_pcb") || rootSchematic() || null;
  if (!doc) {
    base.replaceChildren(); $("#layers").innerHTML = `<p class="note">This project has no board or schematic yet. Open it in the desktop app.</p>`;
    setConn("err", "nothing to show"); return;
  }
  await openDoc(doc);
}

function rootSchematic() {
  const sch = state.docs.filter((d) => d.docType === "kicad_sch");
  const pro = state.project.docs.find((d) => d.docType === "kicad_pro");
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

function docLabel(d) { return d.docType === "kicad_pcb" ? "Board · " + d.path.split("/").pop() : "Sheet · " + d.path; }

function renderDocSwitcher() {
  const sel = $("#docSel");
  sel.innerHTML = state.docs.map((d) => `<option value="${esc(d.docId)}">${esc(docLabel(d))}</option>`).join("");
  sel.onchange = () => { const d = state.docs.find((x) => x.docId === sel.value); if (d) openDoc(d); };
  sel.style.display = state.docs.length > 1 ? "" : "none";
}

function leaveDoc() {
  connectGen++;   // any connect() still waiting for its ticket must give up
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  clearInterval(renderTimer); renderTimer = 0;
  items = []; sheets = []; selected = null; drag = null; peerState = {}; comments = []; followPeer = null; layers = {};
  kdoc = null; layersSeeded = false; canvas.style.display = "none"; if (renderReq) { cancelAnimationFrame(renderReq); renderReq = 0; }
  peersG.replaceChildren(); selG.replaceChildren(); dragG.replaceChildren(); cmtG.replaceChildren();
  cmtPanel.style.display = "none"; objFilter = "";
  const objs = $("#objects"); objs.innerHTML = ""; delete objs.dataset.ready;
}

async function openDoc(doc) {
  leaveDoc();
  state.doc = doc; state.docId = doc.docId;
  DOC_TYPE = doc.docType;
  IU = isSch() ? 1e4 : 1e6;
  ITEM_TYPE = isSch() ? "SCH_SYMBOL" : "FOOTPRINT";
  $("#docSel").value = doc.docId;
  const url = `/p/${state.project.projectId}/edit` + (state.docs.length > 1 ? `?doc=${doc.docId}` : "");
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  $("#hint").textContent = isSch()
    ? "scroll to zoom · right-drag to pan · click a symbol to select · drag to move · Del deletes · double-click a sheet to enter it"
    : "scroll to zoom · right-drag to pan · click a part to select · drag to move · R rotates · Del deletes";
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
      $("#layers").innerHTML = `<p class="note">Nothing to show yet for this ${isSch() ? "sheet" : "board"} — it appears once a desktop editor has the project open in a live session.</p>`;
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

function renderLayers() {
  const order = Object.entries(layers).sort((a, b) => b[1].nodes.length - a[1].nodes.length);
  $("#layers").innerHTML = order.map(([hex, l]) => `<label class="layer"><input type="checkbox" data-layer="${hex}" ${l.visible ? "checked" : ""}>
     <span class="sw" style="background:#${hex}"></span><span>${esc(l.name)}</span><span class="cnt">${l.nodes.length}</span></label>`).join("")
    || `<p class="note">No render yet — the board renders once a desktop editor pushes a preview.</p>`;
  $$("#layers input").forEach((cb) => cb.addEventListener("change", () => {
    const l = layers[cb.dataset.layer]; l.visible = cb.checked;
    for (const n of l.nodes) n.style.display = cb.checked ? "" : "none";
  }));
}

let objFilter = "";
function fpName(fp) { return isSch() ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()) : (fp.lib || "?").split(":").pop(); }
function renderObjects() {
  const el = $("#objects");
  const q = objFilter.toLowerCase();
  const list = items.filter((fp) => !q || fpName(fp).toLowerCase().includes(q))
    .sort((a, b) => fpName(a).localeCompare(fpName(b)));
  if (!el.dataset.ready) {
    el.innerHTML = `<input id="objSearch" placeholder="${isSch() ? "Filter symbols…" : "Filter footprints…"}" style="width:100%;margin-bottom:6px;background:var(--canvas);border:1px solid var(--line);border-radius:4px;padding:4px 6px;color:var(--text)"><div id="objList"></div>`;
    el.dataset.ready = "1";
    $("#objSearch").oninput = (ev) => { objFilter = ev.target.value; renderObjects(); };
  }
  const sheetRows = isSch() && sheets.length ? `<div class="layer"><span class="muted">Sheets</span><span class="cnt">${sheets.length}</span></div>` +
    sheets.map((sh) => `<div class="layer" data-sheet="${esc(sh.file)}" style="cursor:pointer;padding-left:14px"><span>${esc(sh.name || sh.file)}</span><span class="cnt">↗</span></div>`).join("") : "";
  $("#objList").innerHTML = sheetRows + `<div class="layer"><span class="muted">${isSch() ? "Symbols" : "Footprints"}</span><span class="cnt">${list.length}/${items.length}</span></div>` +
    list.slice(0, 300).map((fp) => `<div class="layer" data-fp="${esc(fp.id)}" style="cursor:pointer;padding-left:14px${selected && selected.id === fp.id ? ";background:var(--panel-2)" : ""}"><span>${esc(fpName(fp))}</span><span class="cnt">${Math.round(fp.rot || 0)}°</span></div>`).join("");
  $$("[data-sheet]", el).forEach((row) => row.onclick = () => enterSheet(row.dataset.sheet));
  $$("[data-fp]", el).forEach((row) => row.onclick = () => {
    const fp = items.find((f) => f.id === row.dataset.fp); if (!fp) return;
    selected = fp; drawSelection(); renderProps(); centerOn(fp.x / IU, fp.y / IU); renderObjects();
  });
}

// ---- view transform ----
function applyView() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $("#sbZoom").textContent = Math.round(zoom * 100) + "%";
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
function fitView() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) { setTimeout(fitView, 100); return; }
  world.style.width = sw + "px";
  const ppm = sw / mmW();                       // px per mm at zoom 1
  const [bx, by, bw, bh] = contentBoxMm();
  zoom = Math.min(40, Math.max(0.2, Math.min(sw / (bw * ppm), sh / (bh * ppm)) * (isSch() ? 0.97 : 0.85)));
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
  $$("#ltools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  $$("#ltools [data-modtool]").forEach((b) => b.classList.toggle("on", b.dataset.modtool === t));
  const mt = moduleTool(t);
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : "";
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
  if (!isSch() || !sheets.length) return;
  const [x, y] = worldMm(ev);
  const sh = sheets.find((r) => x >= r.x / IU && x <= (r.x + r.w) / IU && y >= r.y / IU && y <= (r.y + r.h) / IU);
  if (sh) enterSheet(sh.file);
});
stage.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay")) return;
  if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && tool === "pan")) {
    pan = { x: ev.clientX - panX, y: ev.clientY - panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const mod = activeModule();
  if (mod && moduleTool(tool) && mod.onPointerDown) { if (viewOnly) { toast("View-only access"); return; } try { if (mod.onPointerDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  const best = nearestFootprint(x, y, 5 / Math.max(1, zoom * 0.6));
  if (!best) { selected = null; drawSelection(); renderProps(); renderObjects(); return; }
  selected = best; drawSelection(); renderProps(); renderObjects();
  if (viewOnly || !ws || ws.readyState !== 1) return;
  drag = { fp: best, startMm: [x, y], curMm: [best.x / IU, best.y / IU], moved: false, grabOff: [x - best.x / IU, y - best.y / IU], wires: [] };
  // Schematic moves drag the attached wire ends along (KiCad's rubber band).
  if (kdoc && isSch()) {
    const it = kdoc.items.get(best.id);
    if (it && it.kind === "symbol") {
      for (const pin of KiCadCanvas.pinPoints(kdoc, it)) for (const end of KiCadCanvas.wireEndsAt(kdoc, pin.x, pin.y, 0.02)) {
        if (!drag.wires.some((w) => w.item === end.item && w.index === end.index)) drag.wires.push({ item: end.item, index: end.index, off: [pin.x - best.x / IU, pin.y - best.y / IU], orig: KiCadCanvas.ptsOf(end.item.node)[end.index].slice() });
      }
    }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});
stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  $("#sbCursor").textContent = `X ${mm[0].toFixed(3)}  Y ${mm[1].toFixed(3)} mm`;
  if (pan) { viewTouched = true; panX = ev.clientX - pan.x; panY = ev.clientY - pan.y; breakFollow(); applyView(); return; }
  const modM = activeModule();
  if (modM && moduleTool(tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm); return; }
  if (!drag) { sendPresence(mm); return; }
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
  const modU = activeModule();
  if (modU && moduleTool(tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } return; }
  if (ev.button !== 0 || !drag) return;
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
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0;
  }
  fp.x = nx; fp.y = ny; if (kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
});

document.addEventListener("keydown", (ev) => {
  if (["TEXTAREA", "INPUT"].includes(ev.target.tagName) || state.view !== "editor") return;
  const k = ev.key;
  if (k === "Escape") { if ($("#popover").style.display === "block") { closePopover(); return; }
    drag = null; selected = null; dragG.replaceChildren(); drawSelection(); renderProps(); cmtPanel.style.display = "none"; setTool("select"); return; }
  if (k === "f" || k === "F") { fitView(); return; }
  if (k === "+" || k === "=") { zoomBy(1.25); return; }
  if (k === "-" || k === "_") { zoomBy(0.8); return; }
  if (k === "s" || k === "S") { setTool("select"); return; }
  if (k === "h" || k === "H") { setTool("pan"); return; }
  if (k === "c" || k === "C") { setTool("comment"); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "z" || k === "Z")) { ev.preventDefault(); if (ev.shiftKey) redoLast(); else undoLast(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "y" || k === "Y")) { ev.preventDefault(); redoLast(); return; }
  const modK = activeModule();
  if (modK && modK.onKey && !ev.metaKey && !ev.ctrlKey) { try { if (modK.onKey(k, ev, toolCtx())) { ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  if (k === "g" || k === "G") { gridOn = !gridOn; updateGridStatus(); requestRender(); return; }
  if (k === "n" || k === "N") { snapOn = !snapOn; updateGridStatus(); return; }
  if (!selected || viewOnly || !ws || ws.readyState !== 1) return;
  if ((k === "r" || k === "R") && !isSch()) rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

function rotateSelected() {
  const before = selected.rot || 0, after = (before + 90) % 360;
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
function nearestFootprint(x, y, radiusMm) {
  if (kdoc) { const id = KiCadCanvas.hitTest(kdoc, x, y, Math.min(radiusMm, 0.5)); return id ? items.find((f) => f.id === id) || null : null; }
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
function showTab(name) {
  $$("#dockTabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
}
function renderProps() {
  const el = $("#props");
  if (kdoc && CollabTools.props && CollabTools.props.render) { try { CollabTools.props.render(el, selected, toolCtx()); return; } catch (e) { console.warn(e); } }
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
  const el = $("#peers"), ids = Object.keys(peerState);
  $("#peerN").textContent = ids.length;
  const meRow = state.me ? `<div class="peer"><span class="dot" style="background:#ffb43a"></span><span class="who">${esc(state.me.name || state.me.login)}</span><span class="me">you</span></div>` : "";
  el.innerHTML = meRow + (ids.length ? ids.map((cid) => { const p = peerState[cid]; const c = (p.user && p.user.color) || "#4477ee";
    return `<div class="peer"><span class="dot" style="background:${esc(c)}"></span><span class="who">${esc(peerName(p))}</span>
      <button class="btn sm" data-follow="${esc(cid)}">${followPeer === cid ? "Following ✔" : "Follow"}</button></div>`; }).join("")
    : `<p class="note">No one else is here right now. Share the link to invite collaborators.</p>`);
  $$("[data-follow]", el).forEach((b) => b.onclick = () => { const cid = b.dataset.follow; followPeer = followPeer === cid ? null : cid; applyFollowWeb(peerState); renderPeers(); });
}
function renderThreads() {
  const roots = comments.filter((c) => !c.parentId);
  $("#cmtN").textContent = roots.filter((c) => !c.resolved).length;
  $("#threads").innerHTML = roots.length ? roots.map((c) => `<div class="thread ${c.resolved ? "resolved" : ""}" data-thread="${c.id}">
      <div class="meta"><span>${esc(c.authorLogin)}</span><span>${ago(c.createdAt)}</span></div>
      <div class="body">${esc(c.body)}</div>
      <div class="meta"><span>${comments.filter((x) => x.parentId === c.id).length} repl${comments.filter((x) => x.parentId === c.id).length === 1 ? "y" : "ies"}</span><span>${c.resolved ? "resolved" : ""}</span></div></div>`).join("")
    : `<p class="note">No comments yet. Use the comment tool to pin a note to the board.</p>`;
  $$("[data-thread]").forEach((t) => t.onclick = () => { const c = comments.find((x) => x.id === +t.dataset.thread); if (c) { centerOn(c.x / IU, c.y / IU); showThread(c.id); } });
}
function centerOn(xMm, yMm) {
  const w = world.clientWidth, h = w * mmH() / mmW();
  panX = stage.clientWidth / 2 - ((xMm - mmX0()) / mmW()) * w * zoom;
  panY = stage.clientHeight / 2 - ((yMm - mmY0()) / mmH()) * h * zoom;
  applyView();
}
async function loadHistory() {
  const el = $("#history");
  try {
    const j = await api(`/api/projects/${state.project.projectId}/checkpoints`);
    const byName = {};
    for (const c of j.checkpoints || []) (byName[c.name] ||= { name: c.name, at: c.createdAt, docs: [] }).docs.push(c);
    const list = Object.values(byName).sort((a, b) => new Date(b.at) - new Date(a.at));
    el.innerHTML = list.length ? list.map((c) => `<div class="ckpt"><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><span class="when">${ago(c.at)}</span>
        ${viewOnly ? "" : `<button class="btn sm" data-restore="${esc(c.name)}">Restore</button>`}</div>`).join("")
      : `<p class="note">No checkpoints yet. Create one to name the current state so you can come back to it.</p>`;
    $$("[data-restore]", el).forEach((b) => b.onclick = async () => {
      if (!confirm(`Restore "${b.dataset.restore}"? Everyone in the session gets this version.`)) return;
      try { await api(`/api/projects/${state.project.projectId}/restore`, { method: "POST", body: JSON.stringify({ name: b.dataset.restore }) }); toast("Restored — rendering…"); scheduleRenderRefresh(); }
      catch (e) { toast("Restore failed: " + e.message, 4000); }
    });
  } catch (e) { el.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
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
function setConn(cls, text) { const c = $("#conn"); c.className = "conn " + cls; c.textContent = text || (cls === "live" ? "live" : "offline"); }
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
    if (msg.type === "error" && msg.code === "permission_denied") { viewOnly = true; drag = null; dragG.replaceChildren(); setConn("live", "live · view-only"); renderProps(); toast("You have view-only access here"); }
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
function bumpEdits() { $("#sbEdits").textContent = editsSeen ? `${editsSeen} edit${editsSeen === 1 ? "" : "s"}` : ""; }
function noteRemoteOp(msg) {
  for (const c of msg.changes || []) {
    if (c.typeName !== ITEM_TYPE) continue;
    if (c.kind === "REMOVED") { items = items.filter((f) => f.id !== c.id); if (selected && selected.id === c.id) { selected = null; renderProps(); } continue; }
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

// ---- actions ----
async function runAction(act, el) {
  const id = state.project && state.project.projectId;
  switch (act) {
    case "home": navigate("/"); break;
    case "zoomin": zoomBy(1.25); break;
    case "zoomout": zoomBy(0.8); break;
    case "fit": fitView(); break;
    case "grid": gridOn = !gridOn; updateGridStatus(); requestRender(); break;
    case "snap": snapOn = !snapOn; updateGridStatus(); break;
    case "tab-appearance": showTab("appearance"); break;
    case "tab-props": showTab("props"); break;
    case "tab-peers": showTab("peers"); break;
    case "tab-comments": showTab("comments"); break;
    case "tab-history": showTab("history"); break;
    case "refreshHistory": loadHistory(); break;
    case "about": popover(`<h4>KiCad Collaborative 1.0</h4><p class="note">Real-time collaboration for KiCad, based on KiCad 10.99.<br>Web editor v1: move, rotate, delete footprints; comments; history; live presence.</p>`, el); break;
    case "archive": if (id) location.href = `/api/projects/${id}/archive`; break;
    case "clone": if (!id) break; if (!state.me) { toast("Sign in to clone"); break; }
      try { const j = await api(`/api/projects/${id}/clone`, { method: "POST" }); toast("Cloned"); navigate(`/p/${j.projectId}/edit`); } catch (e) { toast("Clone failed: " + e.message, 4000); } break;
    case "share": if (!id) break; if (!state.me || !state.role || state.role === "viewer") { toast("Only editors can create share links"); break; }
      try { const j = await api(`/api/projects/${id}/links`, { method: "POST", body: JSON.stringify({ role: "editor" }) });
        await navigator.clipboard.writeText(j.url).catch(() => {});
        popover(`<h4>Share link (editor)</h4><input value="${esc(j.url)}" readonly onclick="this.select()"><p class="note">Copied to your clipboard. Anyone with it can join in the browser or from KiCad Collaborative → File → Join Shared Project…</p>`, el);
        toast("Share link copied"); } catch (e) { toast("Couldn't create link: " + e.message, 4000); } break;
    case "checkpoint": if (!id) break; if (viewOnly) { toast("Only editors can create checkpoints"); break; }
      { const name = prompt("Checkpoint name", `checkpoint ${new Date().toLocaleString()}`); if (!name) break;
        try { await api(`/api/projects/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ name }) }); toast("Checkpoint created"); loadHistory(); showTab("history"); }
        catch (e) { toast("Checkpoint failed: " + e.message, 4000); } } break;
    case "kicad": popover(`<h4>Open in KiCad Collaborative</h4><p class="note">1. Install the desktop app from the <a href="https://github.com/notaroomba/kicad-collaborative/releases" target="_blank">releases page</a>.<br>2. File → Join Shared Project… and paste a share link (File → Copy share link… here).<br>3. Edits sync both ways, live.</p>`, el); break;
  }
}

// ---------- boot ----------
(async () => { await loadMe(); route(); })();
