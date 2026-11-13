// dialogs/dom.ts — small typed DOM helpers shared by the dialogs, and the typed face of kicad-dialogs.js's
// shell and widgets (window.KDialogs: open, notebook, treebook, grid, staticBox).
import { trapTab } from "../tools/kicad-dialogs/shell";
import "../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>
import { fitMenu } from "../menufit";

export interface DlgButton { label: string; fn?: () => void; primary?: boolean; isDefault?: boolean; close?: boolean; id?: string }
export interface DlgSpec {
  title: string; width?: number; cls?: string; modeless?: boolean; readOnly?: boolean; okLabel?: string; cancelLabel?: string;
  build(body: HTMLElement, api: DlgApi): void; ok?(): boolean | void; cancel?(): void;
  extra?: { label: string; fn: () => void; id?: string }[]; buttons?: DlgButton[];
  /** DIALOG_SHIM::m_hash_key: the name its remembered geometry is kept under, when the title carries per-item text. */
  geomKey?: string;
  /** A dialog without wxRESIZE_BORDER: no resize grip, and only its position is remembered. */
  fixedSize?: boolean;
  /** A child window of the open dialog (HTML_MESSAGE_BOX): it opens over the dialog instead of replacing it and closes with it. */
  child?: boolean;
}
export interface DlgApi { body: HTMLElement; dlg: HTMLElement; foot: HTMLElement; close(): void; finish(apply: boolean): void; refocus(key?: string): void }
export interface NotebookTab { label: string; build(page: HTMLElement): void }
export interface NotebookApi { el: HTMLElement; select(i: number): void; index(): number; pages: HTMLElement[] }
export interface TreeSection { label: string; pages: NotebookTab[] }
export interface TreebookApi { el: HTMLElement; select(label: string): void; current(): string | null }
export interface GridColumn<R> { key: string; label: string; type?: "text" | "bool" | "choice" | "ro"; options?: (string | [string, string])[] | ((row: R) => (string | [string, string])[]); width?: number; list?: string; ro?(row: R): boolean; format?(v: unknown, row: R): string; title?(row: R): string }
export interface GridOpts<R> { readOnly?: boolean; onHeader?(column: GridColumn<R>, index: number): void; height?: number | string; onChange?(row: R, key: string | null, value: unknown, index: number): void; onSelect?(row: R | null, index: number): void;
  buttons?: { add?(): R | null; addTitle?: string; remove?: boolean; removeTitle?: string; move?: boolean; canRemove?(row: R): boolean } }
export interface GridApi<R> { el: HTMLElement; rows: R[]; columns: GridColumn<R>[]; refresh(): void; selected(): number; select(i: number): void; bar?: HTMLElement }
interface KD {
  open(spec: DlgSpec): DlgApi; close(): void; isOpen(): boolean;
  notebook(host: HTMLElement, tabs: NotebookTab[], opts?: { selected?: number; onSelect?(i: number): void }): NotebookApi;
  treebook(host: HTMLElement, sections: TreeSection[], opts?: { selected?: string; onSelect?(label: string): void }): TreebookApi;
  grid<R>(host: HTMLElement, columns: GridColumn<R>[], rows: R[], opts?: GridOpts<R>): GridApi<R>;
  staticBox(host: HTMLElement, title: string): HTMLElement;
}
export function KD(): KD { return (window as unknown as { KDialogs: KD }).KDialogs; }

export const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type Attrs = Record<string, string | number | boolean | undefined | null | ((ev: Event) => void)>;
/** h("div", { class: "x", onclick: fn }, child, "text") */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "style") e.setAttribute("style", String(v));
    else if (k === "value") (e as unknown as HTMLInputElement).value = String(v);
    else if (k === "checked" || k === "disabled" || k === "selected") (e as unknown as Record<string, boolean>)[k] = !!v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
export function checkbox(label: string, checked: boolean, onchange?: (on: boolean) => void, opts?: { disabled?: boolean; title?: string; id?: string }): HTMLLabelElement {
  const cb = h("input", { type: "checkbox", checked, disabled: opts?.disabled, id: opts?.id });
  if (onchange) cb.addEventListener("change", () => onchange(cb.checked));
  return h("label", { class: "kd-chk", title: opts?.title }, cb, label);
}
export function select(options: (string | [string, string])[], value: string, onchange?: (v: string) => void, opts?: { disabled?: boolean; id?: string; style?: string }): HTMLSelectElement {
  const s = h("k-select", { disabled: opts?.disabled, id: opts?.id, style: opts?.style });
  for (const o of options) s.append(h("option", { value: Array.isArray(o) ? o[0] : o }, Array.isArray(o) ? o[1] : o));
  s.value = value; if (onchange) s.addEventListener("change", () => onchange(s.value));
  return s;
}
export function textInput(value: string, onchange?: (v: string) => void, opts?: { disabled?: boolean; id?: string; style?: string; placeholder?: string; type?: string; step?: string; min?: string; max?: string }): HTMLInputElement {
  const i = h("input", { type: opts?.type || "text", value, disabled: opts?.disabled, id: opts?.id, style: opts?.style, placeholder: opts?.placeholder, step: opts?.step, min: opts?.min, max: opts?.max });
  if (onchange) { i.addEventListener("change", () => onchange(i.value)); if ((opts?.type || "text") === "text") i.addEventListener("input", () => onchange(i.value)); }
  return i;
}
/** A two-column label/control form (wxFlexGridSizer): rows of [label, control, unit?]. */
export function form(rows: ([string, Node, string?] | null)[], cols = 2): HTMLDivElement {
  const f = h("div", { class: "kv", style: cols === 3 ? "grid-template-columns:max-content 1fr max-content" : "" });
  for (const r of rows) { if (!r) continue; f.append(h("label", null, r[0]), r[1]); if (cols === 3) f.append(h("span", { class: "ro" }, r[2] || "")); }
  return f;
}
/** A small modal question on top of whatever dialog is open (wxTextEntryDialog). */
/** `validate` is TransferDataFromWindow: false keeps the dialog open (the validator shows its own message). */
export function promptText(title: string, label: string, initial = "", validate?: (v: string) => boolean | Promise<boolean>): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: initial, id: "kd-prompt-input" });
    let busy = false;
    const done = (v: string | null) => {
      if (v === null || !validate) { ov.remove(); resolve(v); return; }
      if (busy) return; busy = true;
      void Promise.resolve(validate(v)).then((good) => { busy = false; if (good) { ov.remove(); resolve(v); } else { input.focus(); } });
    };
    const ok = h("button", { class: "btn primary", onclick: () => done(input.value) }, "OK"), cancel = h("button", { class: "btn", onclick: () => done(null) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", style: "width:380px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)), h("div", { class: "kd-body" }, h("div", { class: "kv" }, h("label", null, label), input)), h("div", { class: "kd-foot" }, cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Enter") { ev.preventDefault(); done(input.value); } else if (ev.key === "Escape") { ev.preventDefault(); done(null); } });
    document.body.append(ov); input.focus(); input.select();
  });
}
/** A small modal form on top of whatever dialog is open: a label over each text control (a multi-line one for
 *  `multiline`), OK / Cancel; resolves the values by key, or null on Cancel (the variant name / description dialogs
 *  a dialog opens over itself). */
export function promptFields(title: string, fields: { key: string; label: string; initial?: string; multiline?: boolean }[], width = 360): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => {
      const el = f.multiline ? h("textarea", { "data-k": f.key, style: "width:100%;min-height:60px;box-sizing:border-box" }) as HTMLTextAreaElement : h("input", { type: "text", "data-k": f.key, style: "width:100%;box-sizing:border-box" }) as HTMLInputElement;
      el.value = f.initial || ""; return { f, el };
    });
    const done = (ok: boolean) => { ov.remove(); if (!ok) { resolve(null); return; } const out: Record<string, string> = {}; for (const i of inputs) out[i.f.key] = i.el.value; resolve(out); };
    const ok = h("button", { class: "btn primary", onclick: () => done(true) }, "OK"), cancel = h("button", { class: "btn", onclick: () => done(false) }, "Cancel");
    const body = h("div", { class: "kd-body" });
    inputs.forEach((i, k) => body.append(h("label", { class: "pd-lbl", style: k ? "display:block;margin-top:8px" : "display:block" }, i.f.label), i.el));
    const dlg = h("div", { class: "kd-dialog", style: `width:${width}px;min-width:0` }, h("div", { class: "kd-title" }, h("span", null, title)), body, h("div", { class: "kd-foot" }, cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Enter" && !(ev.target instanceof HTMLTextAreaElement)) { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); if (inputs[0]) inputs[0].el.focus();
  });
}
export function confirmBox(title: string, message: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => { ov.remove(); resolve(v); };
    const ok = h("button", { class: "btn primary", onclick: () => done(true) }, okLabel), cancel = h("button", { class: "btn", onclick: () => done(false) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", style: "width:420px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)), h("div", { class: "kd-body" }, h("p", { style: "margin:4px 0;white-space:pre-wrap" }, message)), h("div", { class: "kd-foot" }, cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); ok.focus();
  });
}
/** A wxMenu popped up inside a dialog (grid header / cell right-click): check items, separators and submenus. */
export interface PopItem { label?: string; sep?: boolean; check?: boolean; checked?: boolean; disabled?: boolean; run?: () => void; sub?: PopItem[] }
export function popupMenu(x: number, y: number, items: PopItem[]): HTMLElement {
  for (const old of Array.from(document.querySelectorAll(".kd-pop"))) old.remove();
  const build = (list: PopItem[], px: number, py: number, depth: number): HTMLElement => {
    const m = h("div", { class: "kd-pop", role: "menu", "data-depth": depth, style: `position:fixed;left:${px}px;top:${py}px;z-index:${80 + depth};min-width:160px;background:var(--panel);border:1px solid var(--line);border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,.25);padding:3px 0;font-size:12px;color:var(--ink)` });
    for (const it of list) {
      if (it.sep) { m.append(h("div", { style: "height:1px;background:var(--line);margin:3px 0" })); continue; }
      const row = h("div", { class: "kd-pop-row", role: "menuitem", "aria-disabled": it.disabled ? "true" : undefined, style: `display:flex;gap:6px;align-items:center;padding:3px 12px 3px 6px;cursor:default;white-space:nowrap;${it.disabled ? "opacity:.45;" : ""}` },
        h("span", { style: "width:14px;display:inline-block;text-align:center" }, it.check ? (it.checked ? "✓" : "") : ""), h("span", { style: "flex:1" }, it.label || ""), it.sub ? h("span", null, "▸") : null);
      row.addEventListener("pointerenter", () => { row.style.background = "var(--accent)"; row.style.color = "var(--on-accent)"; for (const o of Array.from(document.querySelectorAll(".kd-pop"))) if (Number((o as HTMLElement).dataset.depth) > depth) o.remove();
        if (it.sub && !it.disabled) { const r = row.getBoundingClientRect(), sub = build(it.sub, r.right - 2, r.top - 3, depth + 1); document.body.append(sub); fitMenu(sub, { row: r, parent: m.getBoundingClientRect(), overlap: 2 }); } });
      row.addEventListener("pointerleave", () => { row.style.background = ""; row.style.color = ""; });
      row.addEventListener("click", (ev) => { ev.stopPropagation(); if (it.disabled || it.sub) return; closeAll(); if (it.run) it.run(); });
      m.append(row);
    }
    return m;
  };
  const closeAll = (): void => { for (const o of Array.from(document.querySelectorAll(".kd-pop"))) o.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  const away = (ev: Event): void => { const t = ev.target as Element | null; if (t && t.closest && t.closest(".kd-pop")) return; closeAll(); };
  const esc = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeAll(); } };
  const root = build(items, x, y, 0); document.body.append(root); fitMenu(root, { at: { x, y } });
  setTimeout(() => { document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", esc, true); }, 0);
  return root;
}
export function download(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
