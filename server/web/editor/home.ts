// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { state, store } from "./appstore";
import { leaveEditor, openEditor, takeBoot } from "./doc";
import { $$ } from "./dom";
import { api } from "./util";
// ---------- routing ----------
export function navigate(path: string, replace?: boolean): void {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  route();
}

export function route() {
  const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})(?:\/edit|\/live)?\/?$/i);
  if (m) { openEditor(m[1]); return; }
  state.homeTab = location.pathname.startsWith("/gallery") ? "explore" : location.pathname.startsWith("/trash") ? "trash" : location.pathname.startsWith("/time") ? "time" : "projects";
  showHome();
}


// ---------- session ----------
export async function loadMe() {
  try { state.me = await (takeBoot("me") || api("/api/me")); } catch { state.me = null; }   // the page asks as it arrives (boot.ts)
  store.set({ me: state.me });
}


// ================================================================ HOME
export function showView(name: "home" | "editor"): void {
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
  document.title = "Junction";
  renderHome();
}


// The home view itself (project list, sharing, upload, explore) is React: server/web/home.  It
// renders from store.homeTab; homeTick bumps on every visit so the list revalidates.
export function renderHome() {
  store.set({ homeTab: state.homeTab, homeTick: (store.get().homeTick || 0) + 1 });
}

// What the React home needs back from the router.
window.CollabNav = { navigate, reloadMe: async () => { await loadMe(); renderHome(); } };
