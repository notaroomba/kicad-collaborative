// dialogs/dom.ts — small typed DOM helpers shared by the dialogs, and the typed face of kicad-dialogs.js's
// shell and widgets (window.KDialogs: open, notebook, treebook, grid, staticBox).

export interface DlgButton { label: string; fn?: () => void; primary?: boolean; isDefault?: boolean; close?: boolean; id?: string }
export interface DlgSpec {
  title: string; width?: number; cls?: string; modeless?: boolean; readOnly?: boolean; okLabel?: string; cancelLabel?: string;
  build(body: HTMLElement, api: DlgApi): void; ok?(): boolean | void; cancel?(): void;
  extra?: { label: string; fn: () => void }[]; buttons?: DlgButton[];
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
  const s = h("select", { disabled: opts?.disabled, id: opts?.id, style: opts?.style });
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
export function promptText(title: string, label: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: initial, id: "kd-prompt-input" });
    const done = (v: string | null) => { ov.remove(); resolve(v); };
    const ok = h("button", { class: "btn primary", onclick: () => done(input.value) }, "OK"), cancel = h("button", { class: "btn", onclick: () => done(null) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", style: "width:380px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)), h("div", { class: "kd-body" }, h("div", { class: "kv" }, h("label", null, label), input)), h("div", { class: "kd-foot" }, cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(input.value); } else if (ev.key === "Escape") { ev.preventDefault(); done(null); } });
    document.body.append(ov); input.focus(); input.select();
  });
}
export function confirmBox(title: string, message: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => { ov.remove(); resolve(v); };
    const ok = h("button", { class: "btn primary", onclick: () => done(true) }, okLabel), cancel = h("button", { class: "btn", onclick: () => done(false) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", style: "width:420px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)), h("div", { class: "kd-body" }, h("p", { style: "margin:4px 0;white-space:pre-wrap" }, message)), h("div", { class: "kd-foot" }, cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); ok.focus();
  });
}
export function download(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
