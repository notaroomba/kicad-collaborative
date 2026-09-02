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
  if (m) openEditor(m[1]); else showHome();
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
    <div class="thumb"><img loading="lazy" src="/api/projects/${id}/preview.svg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'⬡'}))"></div>
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

let ws = null, retries = 0, canJoin = false, viewOnly = false;
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

function leaveEditor() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  clearInterval(renderTimer); renderTimer = 0;
  items = []; selected = null; drag = null; peerState = {}; comments = []; followPeer = null;
  peersG.replaceChildren(); selG.replaceChildren(); dragG.replaceChildren(); cmtG.replaceChildren();
  cmtPanel.style.display = "none";
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
  const board = info.docs.find((d) => d.docType === "kicad_pcb");
  state.docId = board ? board.docId : null;
  canJoin = !!state.me;
  viewOnly = !canJoin || info.role === "viewer" || !info.role;
  $("#signinOverlay").style.display = canJoin ? "none" : "block";
  $("#signinLink").href = `/auth/github/login?next=${encodeURIComponent(location.pathname)}`;
  $$("[data-act=share],[data-act=checkpoint],[data-tool=comment]").forEach((b) => { b.disabled = viewOnly && b.dataset.tool !== "comment" ? true : false; });
  world.style.width = stage.clientWidth + "px";
  layers = {};
  if (!board) {
    base.replaceChildren(); $("#layers").innerHTML = `<p class="note">This project has no board yet — only schematics. Open it in the desktop app.</p>`;
    setConn("err", "no board"); return;
  }
  await loadBase(true);
  lastStageW = stage.clientWidth;
  requestAnimationFrame(fitView);
  api(`/api/projects/${id}/board-items`).then((j) => { items = j.footprints || []; renderObjects(); }).catch(() => {});
  loadComments();
  loadHistory();
  if (canJoin) connect();
  else setConn("", "guest preview");
  renderPeers();
}

// ---- board render (inline SVG so layers can be toggled) ----
async function loadBase(first) {
  const id = state.project.projectId;
  let text;
  try { text = await (await fetch(`/api/projects/${id}/preview.svg?fit=false&v=${Date.now()}`)).text(); }
  catch { return false; }
  if (!text.includes("<svg")) return false;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const src = doc.documentElement;
  const vbs = src.getAttribute("viewBox");
  if (vbs) { vb = vbs.split(/\s+/).map(Number); base.setAttribute("viewBox", vbs); overlay.setAttribute("viewBox", vbs); }
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
    (layers[hex] ||= { name: KICAD_LAYERS[hex] || `#${hex}`, nodes: [], visible: !hidden.has(hex) }).nodes.push(el);
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
function fpName(fp) { return (fp.lib || "?").split(":").pop(); }
function renderObjects() {
  const el = $("#objects");
  const q = objFilter.toLowerCase();
  const list = items.filter((fp) => !q || fpName(fp).toLowerCase().includes(q))
    .sort((a, b) => fpName(a).localeCompare(fpName(b)));
  if (!el.dataset.ready) {
    el.innerHTML = `<input id="objSearch" placeholder="Filter footprints…" style="width:100%;margin-bottom:6px;background:var(--canvas);border:1px solid var(--line);border-radius:4px;padding:4px 6px;color:var(--text)"><div id="objList"></div>`;
    el.dataset.ready = "1";
    $("#objSearch").oninput = (ev) => { objFilter = ev.target.value; renderObjects(); };
  }
  $("#objList").innerHTML = `<div class="layer"><span class="muted">Footprints</span><span class="cnt">${list.length}/${items.length}</span></div>` +
    list.slice(0, 300).map((fp) => `<div class="layer" data-fp="${esc(fp.id)}" style="cursor:pointer;padding-left:14px${selected && selected.id === fp.id ? ";background:var(--panel-2)" : ""}"><span>${esc(fpName(fp))}</span><span class="cnt">${Math.round(fp.rot || 0)}°</span></div>`).join("");
  $$("[data-fp]", el).forEach((row) => row.onclick = () => {
    const fp = items.find((f) => f.id === row.dataset.fp); if (!fp) return;
    selected = fp; drawSelection(); renderProps(); centerOn(fp.x / 1e6, fp.y / 1e6); renderObjects();
  });
}

// ---- view transform ----
function applyView() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $("#sbZoom").textContent = Math.round(zoom * 100) + "%";
  drawComments(); drawSelection();
}
function contentBoxMm() {
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
  if (!n || x1 - x0 < 1 || y1 - y0 < 1) return [vb[0], vb[1], vb[2], vb[3]];
  return [x0, y0, x1 - x0, y1 - y0];
}
function fitView() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) { requestAnimationFrame(fitView); return; }
  world.style.width = sw + "px";
  const ppm = sw / vb[2];                       // px per mm at zoom 1
  const [bx, by, bw, bh] = contentBoxMm();
  zoom = Math.min(40, Math.max(0.2, Math.min(sw / (bw * ppm), sh / (bh * ppm)) * 0.85));
  panX = sw / 2 - ((bx - vb[0]) + bw / 2) * ppm * zoom;
  panY = sh / 2 - ((by - vb[1]) + bh / 2) * ppm * zoom;
  applyView();
}
function zoomBy(factor, cx, cy) {
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
let lastStageW = 0;
new ResizeObserver(() => {
  if (state.view !== "editor") return;
  const sw = stage.clientWidth;
  if (sw && lastStageW && sw !== lastStageW) { const r = sw / lastStageW; panX *= r; panY *= r; world.style.width = sw + "px"; }
  if (sw) lastStageW = sw;
  applyView();
}).observe(stage);

function worldMm(ev) {
  const r = world.getBoundingClientRect();
  return [vb[0] + ((ev.clientX - r.left) / r.width) * vb[2], vb[1] + ((ev.clientY - r.top) / r.height) * vb[3]];
}
function pxPerMm() { const r = world.getBoundingClientRect(); return r.width > 0 ? r.width / vb[2] : 4; }
function visibleRectNm() {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (wr.width <= 0) return null;
  const x = vb[0] + ((sr.left - wr.left) / wr.width) * vb[2], y = vb[1] + ((sr.top - wr.top) / wr.height) * vb[3];
  const w = (sr.width / wr.width) * vb[2], h = (sr.height / wr.height) * vb[3];
  return [x, y, w, h].map((v) => Math.round(v * 1e6));
}

// ---- tools ----
function setTool(t) {
  if (t === "follow") { cycleFollow(); return; }
  tool = t;
  $$("#ltools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : "";
  if (t === "comment" && !canJoin) { toast("Sign in to comment"); setTool("select"); }
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
  const xMm = vp[0] / 1e6, yMm = vp[1] / 1e6, wMm = vp[2] / 1e6;
  zoom = Math.min(40, Math.max(0.2, (stage.clientWidth / w) * (vb[2] / wMm)));
  panX = -((xMm - vb[0]) / vb[2]) * w * zoom;
  panY = -((yMm - vb[1]) / vb[3]) * (w * vb[3] / vb[2]) * zoom;
  suppressBreakout = true; applyView(); suppressBreakout = false;
}
function breakFollow() {
  if (!followPeer || suppressBreakout) return;
  followPeer = null; toast("Stopped following"); renderPeers();
}

// ---- pointer interaction ----
stage.addEventListener("contextmenu", (ev) => ev.preventDefault());
stage.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest("#cmtPanel") || ev.target.closest("#signinOverlay")) return;
  if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && tool === "pan")) {
    pan = { x: ev.clientX - panX, y: ev.clientY - panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const best = nearestFootprint(x, y, 5 / Math.max(1, zoom * 0.6));
  if (!best) { selected = null; drawSelection(); renderProps(); renderObjects(); return; }
  selected = best; drawSelection(); renderProps(); renderObjects();
  if (viewOnly || !ws || ws.readyState !== 1) return;
  drag = { fp: best, startMm: [x, y], curMm: [x, y], moved: false };
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});
stage.addEventListener("pointermove", (ev) => {
  const mm = worldMm(ev);
  $("#sbCursor").textContent = `X ${mm[0].toFixed(3)}  Y ${mm[1].toFixed(3)} mm`;
  if (pan) { panX = ev.clientX - pan.x; panY = ev.clientY - pan.y; breakFollow(); applyView(); return; }
  if (!drag) { sendPresence(mm); return; }
  drag.curMm = mm;
  if (!drag.moved && Math.hypot(mm[0] - drag.startMm[0], mm[1] - drag.startMm[1]) > 0.4) drag.moved = true;
  if (!drag.moved) return;
  drawDrag();
  const now = Date.now();
  if (now - lastLiveMove > 150) { lastLiveMove = now; sendOp([moveOp(drag.fp, Math.round(mm[0] * 1e6), Math.round(mm[1] * 1e6))]); }
  const s = 4;
  const g = [[mm[0]-s, mm[1]-s, mm[0]+s, mm[1]-s], [mm[0]+s, mm[1]-s, mm[0]+s, mm[1]+s],
             [mm[0]+s, mm[1]+s, mm[0]-s, mm[1]+s], [mm[0]-s, mm[1]+s, mm[0]-s, mm[1]-s]]
    .map((sg) => [...sg.map((v) => Math.round(v * 1e6)), 100000]);
  sendPresence(mm, g);
});
stage.addEventListener("pointerup", (ev) => {
  if (pan) { pan = null; return; }
  if (ev.button !== 0 || !drag) return;
  const fp = drag.fp, wasMoved = drag.moved;
  const nx = Math.round(drag.curMm[0] * 1e6), ny = Math.round(drag.curMm[1] * 1e6);
  drag = null; dragG.replaceChildren();
  sendPresence([nx / 1e6, ny / 1e6], []);
  if (!wasMoved) return;
  if (nx !== fp.x || ny !== fp.y) sendOp([moveOp(fp, nx, ny)]);
  fp.x = nx; fp.y = ny; drawSelection(); renderProps();
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
  if (!selected || viewOnly || !ws || ws.readyState !== 1) return;
  if (k === "r" || k === "R") rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

function rotateSelected() {
  const before = selected.rot || 0, after = (before + 90) % 360;
  sendOp([{ id: selected.id, typeName: "FOOTPRINT", kind: "MODIFIED", properties: [
    { name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
  selected.rot = after; drawSelection(); renderProps();
}
function deleteSelected() {
  sendOp([{ id: selected.id, typeName: "FOOTPRINT", kind: "REMOVED", properties: [] }]);
  items = items.filter((f) => f.id !== selected.id);
  selected = null; drawSelection(); renderProps(); renderObjects(); toast("Deleted");
}
function moveOp(fp, nx, ny) {
  return { id: fp.id, typeName: "FOOTPRINT", kind: "MODIFIED", properties: [
    { name: "Position X", before: { type: "int", v: fp.x }, after: { type: "int", v: nx } },
    { name: "Position Y", before: { type: "int", v: fp.y }, after: { type: "int", v: ny } }] };
}
function nearestFootprint(x, y, radiusMm) {
  let best = null, bestD = radiusMm;
  for (const fp of items) { const d = Math.hypot(fp.x / 1e6 - x, fp.y / 1e6 - y); if (d < bestD) { best = fp; bestD = d; } }
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
  const s = pxPerMm(), x = selected.x / 1e6, y = selected.y / 1e6;
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", x); ring.setAttribute("cy", y); ring.setAttribute("r", 10 / s);
  ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#ffb43a");
  ring.setAttribute("stroke-width", 2.5 / s); ring.setAttribute("stroke-dasharray", `${5 / s} ${3 / s}`);
  selG.appendChild(ring);
  selG.appendChild(svgText(x + 12 / s, y - 12 / s, 12 / s, "#ffb43a", `${selected.lib.split(":").pop()} (${Math.round(selected.rot || 0)}°)`));
}
function drawDrag() {
  dragG.replaceChildren();
  if (!drag) return;
  const s = pxPerMm(), [x, y] = drag.curMm;
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", drag.fp.x / 1e6); line.setAttribute("y1", drag.fp.y / 1e6);
  line.setAttribute("x2", x); line.setAttribute("y2", y);
  line.setAttribute("stroke", "#ffb43a"); line.setAttribute("stroke-dasharray", `${4 / s} ${3 / s}`); line.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(line);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4 / s);
  dot.setAttribute("fill", "none"); dot.setAttribute("stroke", "#ffb43a"); dot.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(dot);
  dragG.appendChild(svgText(x + 6 / s, y - 6 / s, 12 / s, "#ffb43a", drag.fp.lib.split(":").pop()));
}
function drawPeers(peers) {
  peersG.replaceChildren();
  const s = pxPerMm(), mm = (nm) => nm / 1e6;
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
  if (!selected) { el.innerHTML = `<p class="note">Select a footprint on the board to see its properties.</p>`; return; }
  const ro = viewOnly ? "disabled" : "";
  el.innerHTML = `<div class="kv">
    <label>Footprint</label><div class="ro" title="${esc(selected.lib)}">${esc(selected.lib)}</div>
    <label>X (mm)</label><input id="pX" type="number" step="0.01" value="${(selected.x / 1e6).toFixed(3)}" ${ro}>
    <label>Y (mm)</label><input id="pY" type="number" step="0.01" value="${(selected.y / 1e6).toFixed(3)}" ${ro}>
    <label>Rotation</label><input id="pRot" type="number" step="1" value="${Math.round(selected.rot || 0)}" ${ro}>
    <label>UUID</label><div class="ro muted">${esc(selected.id)}</div></div>
    <div class="actions"><button class="btn sm" id="pRotBtn" ${ro}>Rotate 90°</button><button class="btn sm danger" id="pDelBtn" ${ro}>Delete</button></div>`;
  if (viewOnly) return;
  const commitPos = () => {
    const nx = Math.round(parseFloat($("#pX").value) * 1e6), ny = Math.round(parseFloat($("#pY").value) * 1e6);
    if (isNaN(nx) || isNaN(ny) || (nx === selected.x && ny === selected.y)) return;
    sendOp([moveOp(selected, nx, ny)]); selected.x = nx; selected.y = ny; drawSelection();
  };
  $("#pX").onchange = commitPos; $("#pY").onchange = commitPos;
  $("#pRot").onchange = () => {
    const after = ((parseFloat($("#pRot").value) % 360) + 360) % 360, before = selected.rot || 0;
    if (isNaN(after) || after === before) return;
    sendOp([{ id: selected.id, typeName: "FOOTPRINT", kind: "MODIFIED", properties: [{ name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
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
  $$("[data-thread]").forEach((t) => t.onclick = () => { const c = comments.find((x) => x.id === +t.dataset.thread); if (c) { centerOn(c.x / 1e6, c.y / 1e6); showThread(c.id); } });
}
function centerOn(xMm, yMm) {
  const w = world.clientWidth, h = w * vb[3] / vb[2];
  panX = stage.clientWidth / 2 - ((xMm - vb[0]) / vb[2]) * w * zoom;
  panY = stage.clientHeight / 2 - ((yMm - vb[1]) / vb[3]) * h * zoom;
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
    const x = c.x / 1e6, y = c.y / 1e6, r = 9 / s;
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
  const px = wr.left - sr.left + ((xNm / 1e6 - vb[0]) / vb[2]) * wr.width;
  const py = wr.top - sr.top + ((yNm / 1e6 - vb[1]) / vb[3]) * wr.height;
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
  const [x, y] = worldMm(ev), xNm = Math.round(x * 1e6), yNm = Math.round(y * 1e6);
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
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", proto: 1, token: "", clientId: "web-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "web" }));
  ws.onclose = () => {
    peersG.replaceChildren(); peerState = {}; renderPeers();
    const delay = Math.min(15000, 1000 * Math.pow(2, retries++));
    setConn("err", `reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (state.view === "editor") connect(); }, delay);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "hello_ok") { retries = 0; ws.send(JSON.stringify({ type: "join_doc", docId: state.docId })); }
    if (msg.type === "doc_info") { peerState = {}; setConn("live", viewOnly ? "live · view-only" : "live"); renderPeers(); }
    if (msg.type === "presence") { for (const [cid, e] of Object.entries(msg.peers || {})) { if (e === null) delete peerState[cid]; else peerState[cid] = e; }
      drawPeers(peerState); applyFollowWeb(peerState); renderPeers(); }
    if (msg.type === "peer_left" && msg.clientId) { delete peerState[msg.clientId]; drawPeers(peerState); applyFollowWeb(peerState); renderPeers(); }
    if (msg.type === "error" && msg.code === "permission_denied") { viewOnly = true; drag = null; dragG.replaceChildren(); setConn("live", "live · view-only"); renderProps(); toast("You have view-only access here"); }
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "op") { editsSeen++; noteRemoteOp(msg); bumpEdits(); scheduleRenderRefresh(); }
    if (msg.type === "ops") { editsSeen += (msg.ops || []).length; bumpEdits(); scheduleRenderRefresh(); }
  };
}
function bumpEdits() { $("#sbEdits").textContent = editsSeen ? `${editsSeen} edit${editsSeen === 1 ? "" : "s"}` : ""; }
function noteRemoteOp(msg) {
  for (const c of msg.changes || []) {
    if (c.typeName !== "FOOTPRINT") continue;
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
  const st = { cursor: [Math.round(mmPos[0] * 1e6), Math.round(mmPos[1] * 1e6)] };
  const vp = visibleRectNm(); if (vp) st.viewport = vp;
  if (ghostSegs) st.ghost = ghostSegs;
  ws.send(JSON.stringify({ type: "presence", docId: state.docId, state: st }));
}
function sendOp(changes) {
  if (!ws || ws.readyState !== 1) { toast("Not connected"); return; }
  ws.send(JSON.stringify({ type: "op", docId: state.docId, clientOpId: `web:${++opN}`, baseSeq: null, changes }));
  editsSeen++; bumpEdits(); scheduleRenderRefresh();
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
