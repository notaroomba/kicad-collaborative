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
  if (t && t.closest && t.closest(".kd-overlay, #ctxMenu, [role='menu']")) return;   // the overlay's own handler, a prompt on top, or an open menu
  ev.preventDefault(); ev.stopPropagation(); current.finish(false);
}, true);
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
  ov.addEventListener("pointerdown", (ev) => { if (ev.target === ov && !spec.modeless) finish(false); });
  ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.target && (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest(".kd-grid")) { ev.preventDefault(); (ev.target as HTMLElement).blur(); }   // Enter in a grid cell commits the cell, as in a wxGrid
    // multi-line text: Enter is a new line, Shift/Ctrl+Enter is OK (SCINTILLA_TRICKS, DIALOG_SHIM)
    else if (ev.key === "Enter" && !(ev.target && (ev.target as HTMLElement).tagName === "TEXTAREA" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) && !(ev.target && (ev.target as HTMLElement).tagName === "BUTTON")) { ev.preventDefault(); if (spec.buttons) { if (defaultBtn && !defaultBtn.disabled) defaultBtn.click(); } else finish(true); }
  });
  // the title bar drags the dialog around, like a desktop window
  let dragFrom: [number, number] | null = null;
  tt.addEventListener("pointerdown", (ev) => { if ((ev.target as Element).classList.contains("kd-x")) return; const r = dlg.getBoundingClientRect(); dragFrom = [ev.clientX - r.left, ev.clientY - r.top]; dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px"; tt.setPointerCapture(ev.pointerId); });
  tt.addEventListener("pointermove", (ev) => { if (!dragFrom) return; dlg.style.left = Math.max(0, ev.clientX - dragFrom[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - dragFrom[1]) + "px"; });
  tt.addEventListener("pointerup", () => { dragFrom = null; });
  current = { ov, dlg, body, spec, finish };
  ensureCss();
  const api: DlgApi = { body, close, dlg, foot, finish, refocus(key) { const c = key !== undefined && body.querySelector<HTMLInputElement>(`[data-k="${key}"]`); if (c) { c.focus(); if (c.select && c.type === "text") c.select(); } } };
  spec.build(body, api);
  const first = body.querySelector<HTMLInputElement>("input:not([type=checkbox]), select, textarea, input"); if (first && !spec.readOnly && !first.disabled) { first.focus(); if (first.select && first.type === "text") first.select(); }
  if (!dlg.contains(document.activeElement)) dlg.focus();
  return api;
}
