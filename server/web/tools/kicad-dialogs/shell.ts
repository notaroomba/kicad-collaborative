// kicad-dialogs/shell.ts — the dialog shell (DOM): one modal (or modeless) dialog at a time, with a title
// bar that drags it, OK / Cancel (or the dialog's own button row) and the desktop keyboard contract.
import type { DlgApi, DlgSpec } from "../../dialogs/dom";
import { esc } from "./sexpr";
import { ensureCss } from "./widgets";

interface OpenDialog { ov: HTMLElement; dlg: HTMLElement; body: HTMLElement; spec: DlgSpec; finish(apply: boolean): void }

let current: OpenDialog | null = null;
export const isOpen = (): boolean => !!current;
export function el(tag: string, cls?: string, html?: string): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
export function close(): void { if (current) { current.ov.remove(); current = null; } }
// Esc closes the open dialog wherever the keyboard focus is: a dialog that redraws its body (the Symbol Fields
// Table) or is opened from a toolbar button can leave the focus outside the overlay, whose own key handler then
// never hears the key.
if (typeof document !== "undefined") document.addEventListener("keydown", (ev) => {
  if (!current || ev.key !== "Escape" || ev.defaultPrevented) return;
  const t = ev.target as Element | null;
  if (t && t.closest && t.closest(".kd-overlay, .kd-font-pop, #ctxMenu, [role='menu'], [data-popup-open]")) return;   // the overlay's own handler, a prompt on top, or an open menu
  ev.preventDefault(); ev.stopPropagation(); current.finish(false);
}, true);
// ---------------------------------------------------------------- DIALOG_SHIM's window geometry
// A dialog is centred on its parent the first time; after the person moves or resizes it, the next opening of the
// same dialog comes back where it was, and (wxRESIZE_BORDER) at least as big as it was.  KiCad keys the map by
// m_hash_key, else by the title without a trailing " (...)" (getDialogKeyFromTitle); the web's titles that name the
// edited item after " — " drop that part too.  Browser storage is a per-viewer convenience, as the desktop's
// window-geometry settings are per user.
interface Geometry { left: number; top: number; width?: number; height?: number }
/** getDialogKeyFromTitle: the title up to its last '(' (trailing spaces trimmed), and up to " — " (the web's item suffix). */
export function dialogKeyFromTitle(title: string): string {
  let t = String(title);
  const dash = t.indexOf(" \u2014 "); if (dash > 0) t = t.slice(0, dash);
  const paren = t.lastIndexOf("("); if (paren > 0) t = t.slice(0, paren).replace(/ +$/, "");
  return t;
}
const GEOM_KEY = (key: string): string => "kd.geom." + key;
/** Take the dialog out of the centring flexbox at its current place, so it can move and resize. */
function detach(dlg: HTMLElement): void {
  if (dlg.style.position === "fixed") return;
  const r = dlg.getBoundingClientRect();
  dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px";
}
function saveGeometry(key: string, dlg: HTMLElement, sized: boolean): void {
  const r = dlg.getBoundingClientRect();
  let prev: Geometry | null = null; try { prev = JSON.parse(localStorage.getItem(GEOM_KEY(key)) || "null"); } catch (e) { prev = null; }
  const g: Geometry = { left: Math.round(r.left), top: Math.round(r.top) };
  if (sized) { g.width = Math.round(r.width); g.height = Math.round(r.height); }
  else if (prev && prev.width) { g.width = prev.width; g.height = prev.height; }
  try { localStorage.setItem(GEOM_KEY(key), JSON.stringify(g)); } catch (e) { /* no storage: nothing remembered */ }
}
/** The geometry clamped to the window (the screen may have shrunk since). */
export function clampGeometry(g: Geometry, vw: number, vh: number): Geometry {
  const width = g.width ? Math.min(g.width, vw) : undefined, height = g.height ? Math.min(g.height, vh) : undefined;
  const w = width || 240, h = height || 120;
  return { left: Math.max(0, Math.min(g.left, vw - Math.min(w, vw))), top: Math.max(0, Math.min(g.top, vh - Math.min(h, vh))), width, height };
}
/**
 * The geometry a dialog opens with: the saved position, and for a resizable dialog std::max( calculated size,
 * saved size ) so it never comes back smaller than its content needs; a fixed-size one keeps its calculated size.
 */
export function restoredGeometry(saved: Geometry, natural: { width: number; height: number }, resizable: boolean): Geometry {
  const out: Geometry = { left: saved.left, top: saved.top };
  if (resizable && saved.width && saved.height) { out.width = Math.max(natural.width, saved.width); out.height = Math.max(natural.height, saved.height); }
  return out;
}
function restoreGeometry(key: string, dlg: HTMLElement, resizable: boolean): void {
  let g: Geometry | null = null; try { g = JSON.parse(localStorage.getItem(GEOM_KEY(key)) || "null"); } catch (e) { g = null; }
  if (!g || typeof g.left !== "number" || typeof g.top !== "number") return;
  const r = dlg.getBoundingClientRect();
  const c = clampGeometry(restoredGeometry(g, { width: Math.ceil(r.width), height: Math.ceil(r.height) }, resizable), window.innerWidth, window.innerHeight);
  dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = c.left + "px"; dlg.style.top = c.top + "px";
  if (c.width) { dlg.style.width = c.width + "px"; dlg.style.maxWidth = "none"; }
  if (c.height) { dlg.style.height = c.height + "px"; dlg.style.maxHeight = "none"; }
}

/** open({title, width, build(body, api), ok() -> false keeps it open, extra:[{label, fn}], readOnly}) */
export function open(spec: DlgSpec): DlgApi {
  close();
  const ov = el("div", "kd-overlay"), dlg = el("div", "kd-dialog"); if (spec.width) dlg.style.width = spec.width + "px";
  const tt = el("div", "kd-title", `<span>${esc(spec.title)}</span><span class="kd-x" title="Close (Esc)">×</span>`);
  const body = el("div", "kd-body"), foot = el("div", "kd-foot");
  for (const b of spec.extra || []) { const btn = el("button", "btn", esc(b.label)); btn.addEventListener("click", () => b.fn()); foot.appendChild(btn); }
  foot.appendChild(el("span", "spacer"));
  const cancel = el("button", "btn", spec.cancelLabel || "Cancel") as HTMLButtonElement, ok = el("button", "btn primary", spec.okLabel || "OK") as HTMLButtonElement;
  if (spec.readOnly) ok.disabled = true;
  // spec.buttons replaces OK / Cancel with the dialog's own row (KiCad's Find: Find Next / Find Previous / Close):
  // [{ label, fn, primary, isDefault (Enter), close (the button closes like Cancel), id }]
  let defaultBtn: HTMLButtonElement | null = null;
  if (spec.buttons) for (const b of spec.buttons) { const btn = el("button", "btn" + (b.primary ? " primary" : ""), esc(b.label)) as HTMLButtonElement; if (b.id) btn.dataset.btn = b.id; if (b.isDefault) defaultBtn = btn; btn.addEventListener("click", () => { if (b.close) finish(false); else if (b.fn) b.fn(); }); foot.appendChild(btn); }
  else foot.append(cancel, ok);
  if (spec.cls) dlg.classList.add(...String(spec.cls).split(" ")); if (spec.modeless) ov.classList.add("kd-modeless");
  dlg.tabIndex = -1; dlg.style.outline = "none";   // a click on a label or a tree node keeps the keyboard (Esc/Enter) in the dialog
  dlg.append(tt, body, foot); ov.appendChild(dlg); document.body.appendChild(ov);
  const finish = (apply: boolean): void => { if (apply) { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && dlg.contains(a)) a.blur(); if (spec.ok && spec.ok() === false) return; } close(); if (!apply && spec.cancel) spec.cancel(); };
  cancel.addEventListener("click", () => finish(false)); ok.addEventListener("click", () => finish(true)); tt.querySelector(".kd-x")!.addEventListener("click", () => finish(false));
  // DIALOG_SHIM: a modal dialog ignores clicks on the frame behind it; only OK / Cancel / Esc / the close box end it
  ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.target && (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest(".kd-grid")) { ev.preventDefault(); (ev.target as HTMLElement).blur(); }   // Enter in a grid cell commits the cell, as in a wxGrid
    // multi-line text: Enter is a new line, Shift/Ctrl+Enter is OK (SCINTILLA_TRICKS, DIALOG_SHIM)
    else if (ev.key === "Enter" && !(ev.target && (ev.target as HTMLElement).tagName === "TEXTAREA" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) && !(ev.target && (ev.target as HTMLElement).tagName === "BUTTON")) { ev.preventDefault(); if (spec.buttons) { if (defaultBtn && !defaultBtn.disabled) defaultBtn.click(); } else finish(true); }
  });
  // the title bar drags the dialog around, like a desktop window
  let dragFrom: [number, number] | null = null;
  tt.addEventListener("pointerdown", (ev) => { if ((ev.target as Element).classList.contains("kd-x")) return; const r = dlg.getBoundingClientRect(); dragFrom = [ev.clientX - r.left, ev.clientY - r.top]; detach(dlg); tt.setPointerCapture(ev.pointerId); });
  tt.addEventListener("pointermove", (ev) => { if (!dragFrom) return; dlg.style.left = Math.max(0, ev.clientX - dragFrom[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - dragFrom[1]) + "px"; });
  const geomKey = spec.geomKey || dialogKeyFromTitle(spec.title), resizable = !spec.fixedSize;
  tt.addEventListener("pointerup", () => { if (dragFrom) saveGeometry(geomKey, dlg, false); dragFrom = null; });
  // wxRESIZE_BORDER: a grip in the bottom-right corner resizes the dialog
  const grip = el("div", "kd-grip"); grip.title = "Resize"; if (resizable) dlg.appendChild(grip);
  let sizeFrom: [number, number, number, number] | null = null;
  grip.addEventListener("pointerdown", (ev) => { ev.preventDefault(); const r = dlg.getBoundingClientRect(); detach(dlg); sizeFrom = [ev.clientX, ev.clientY, r.width, r.height]; grip.setPointerCapture(ev.pointerId); });
  grip.addEventListener("pointermove", (ev) => {
    if (!sizeFrom) return;
    const r = dlg.getBoundingClientRect();
    dlg.style.width = Math.max(240, Math.min(window.innerWidth - r.left, sizeFrom[2] + ev.clientX - sizeFrom[0])) + "px";
    dlg.style.height = Math.max(120, Math.min(window.innerHeight - r.top, sizeFrom[3] + ev.clientY - sizeFrom[1])) + "px";
    dlg.style.maxWidth = "none"; dlg.style.maxHeight = "none";
  });
  grip.addEventListener("pointerup", () => { if (sizeFrom) saveGeometry(geomKey, dlg, true); sizeFrom = null; });
  current = { ov, dlg, body, spec, finish };
  ensureCss();
  const api: DlgApi = { body, close, dlg, foot, finish, refocus(key) { const c = key !== undefined && body.querySelector<HTMLInputElement>(`[data-k="${key}"]`); if (c) { c.focus(); if (c.select && c.type === "text") c.select(); } } };
  spec.build(body, api);
  restoreGeometry(geomKey, dlg, resizable);
  const first = body.querySelector<HTMLInputElement>("input:not([type=checkbox]), k-select, textarea, input"); if (first && !spec.readOnly && !first.disabled) { first.focus(); if (first.select && first.type === "text") first.select(); }
  if (!dlg.contains(document.activeElement)) dlg.focus();
  return api;
}
