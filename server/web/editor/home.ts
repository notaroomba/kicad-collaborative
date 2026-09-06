// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { leaveEditor, openEditor } from "./doc";
import { $, $$ } from "./dom";
import { ago, api, esc, toast } from "./util";
// ---------- routing ----------
export function navigate(path, replace) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  route();
}

export function route() {
  const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})(?:\/edit|\/live)?\/?$/i);
  if (m) { openEditor(m[1]); return; }
  if (location.pathname.startsWith("/gallery")) state.homeTab = "explore";
  showHome();
}


// ---------- session ----------
export async function loadMe() {
  try { state.me = await api("/api/me"); } catch { state.me = null; }
  store.set({ me: state.me });
}


// ================================================================ HOME
export function showView(name) {
  state.view = name;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === name));
  if (name === "home") {
    leaveEditor(); delete document.body.dataset.editor;
    store.slice("document", { editor: null, docType: null, docId: null, doc: null });
    store.set({ view: "home", project: null, role: null, popover: null });
  } else store.set({ view: name });
}


export function showHome() {
  showView("home");
  document.title = "KiCad Collaborative";
  renderHome();
}


export function projectCard(p, roleLabel) {
  const id = p.projectId;
  return `<div class="card" data-open="${id}">
    <div class="thumb"><img loading="lazy" src="/api/projects/${id}/preview.svg" alt="" onload="this.classList.add('ready')" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'⬡'}))"></div>
    <div class="body"><div class="name">${esc(p.name)}</div>
    <div class="meta"><span>${esc(p.ownerLogin)}</span><span>·</span><span>${ago(p.updatedAt)}</span>
    ${roleLabel ? `<span class="pill ${esc(roleLabel)}">${esc(roleLabel)}</span>` : ""}</div></div></div>`;
}


export async function renderHome() {
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


export function bindCards() {
  $$("[data-open]").forEach((c) => c.addEventListener("click", () => navigate(`/p/${c.dataset.open}/edit`)));
}


export async function openLink() {
  const raw = $("#linkIn").value.trim();
  const m = raw.match(/\/j\/([A-Za-z0-9_-]+)/) || raw.match(/^([A-Za-z0-9_-]{16,})$/);
  if (!m) { toast("That doesn't look like a share link"); return; }
  if (!state.me) { location.href = `/auth/github/login?next=${encodeURIComponent("/j/" + m[1])}`; return; }
  try {
    const j = await api(`/api/join/${m[1]}`, { method: "POST" });
    navigate(`/p/${j.projectId}/edit`);
  } catch (e) { toast("Couldn't open link: " + e.message, 4000); }
}
