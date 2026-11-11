// theme.ts — the one owner of the UI theme (light / dark chrome).  The mode is "light", "dark" or "system";
// it is stored in localStorage under "kui.theme" ("light" | "dark"; absent = follow the system) and shown as
// <html data-theme="light|dark"> (no attribute = system), which is what the tokens in static/app.html key on.
// app.html applies the stored value with a tiny inline script before the first paint (keep it in step with
// `apply` below), so a reload never flashes the other theme.  Both bundles (editor, ui) import this module;
// the state lives in the DOM and storage, so the two copies agree, and `subscribe` hears changes made by either.
export type ThemeMode = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "kui.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function stored(): ThemeMode {
  let v: string | null = null;
  try { v = localStorage.getItem(KEY); } catch (e) { /* no storage */ }
  return v === "light" || v === "dark" ? v : "system";
}

/** The chosen mode (what the Appearance menu shows checked). */
export function getThemeMode(): ThemeMode {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : stored();
}

/** The theme in effect right now: the explicit choice, else the system's. */
export function effectiveTheme(): Theme {
  const m = getThemeMode();
  if (m !== "system") return m;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function apply(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme; else root.dataset.theme = mode;
}

/** Choose a mode, remember it, and tell the subscribers. */
export function setThemeMode(mode: ThemeMode): void {
  try { if (mode === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* no storage */ }
  apply(mode);
}

/** Flip between light and dark (the old "Toggle Dark Theme" entry): an explicit choice opposite to what shows now. */
export function toggleTheme(): void { setThemeMode(effectiveTheme() === "dark" ? "light" : "dark"); }

/**
 * Hear every change of the effective theme or the mode: a choice made here or in the other bundle (the attribute
 * changes), in another tab (storage), or by the system while the mode is "system".  Returns the unsubscribe.
 */
export function subscribeTheme(fn: (theme: Theme, mode: ThemeMode) => void): () => void {
  let last = "";
  const fire = () => { const t = effectiveTheme(), m = getThemeMode(), k = t + "/" + m; if (k !== last) { last = k; fn(t, m); } };
  const mo = new MutationObserver(fire);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
  if (mq) mq.addEventListener("change", fire);
  const onStorage = (ev: StorageEvent) => { if (ev.key === KEY || ev.key === null) apply(stored()); };
  window.addEventListener("storage", onStorage);
  last = effectiveTheme() + "/" + getThemeMode();
  return () => { mo.disconnect(); if (mq) mq.removeEventListener("change", fire); window.removeEventListener("storage", onStorage); };
}

/** Make sure the page shows the stored mode (the inline script normally did already). */
export function initTheme(): void { apply(stored()); }
