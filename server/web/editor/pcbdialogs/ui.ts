// pcbdialogs/ui — the widgets KiCad's board dialogs are made of, on top of KDialogs.open
// (static/kicad-dialogs.js): a notebook (wxNotebook), a paged tree (PAGED_DIALOG's wxTreebook), static
// boxes, unit fields (UNIT_BINDER: a number in the editor's units followed by the unit name), editable
// grids with KiCad's add / delete row buttons (WX_GRID), and a report list (WX_HTML_REPORT_PANEL).
import { trapTab } from "../../tools/kicad-dialogs/shell";
import { E } from "../state";
import "../../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>
import { fromDisplayAbsAxis, toDisplayAbsAxis } from "../userorigin";

// ---------------------------------------------------------------- elements
type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | ((ev: Event) => void)>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.style.cssText = String(v);
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "readOnly") (el as unknown as Record<string, boolean>)[k] = !!v;
    else if (k === "value") (el as unknown as { value: string }).value = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const CSS = `
.pd-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin: 0 0 10px; flex-wrap: wrap; }
.pd-tab { padding: 5px 12px; border: 1px solid transparent; border-bottom: none; border-radius: var(--r-3) var(--r-3) 0 0; background: none; color: var(--ink-2); margin-bottom: -1px; white-space: nowrap; }
.pd-tab:hover { color: var(--ink); }
.pd-tab.on { background: var(--bench); border-color: var(--line); color: var(--ink); font-weight: 600; }
.pd-book { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 0 14px; height: 100%; min-height: 0; }
.pd-tree { border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: auto; padding: 4px 0; user-select: none; }
.pd-tree .grp { padding: 4px 8px; font-weight: 600; cursor: default; }
.pd-tree .leaf { padding: 3px 8px 3px 24px; cursor: pointer; white-space: nowrap; }
.pd-tree .leaf:hover { background: var(--panel-2); }
.pd-tree .leaf.on { background: var(--accent); color: var(--on-accent); }
.pd-page { overflow: auto; min-height: 0; padding-right: 4px; }
.pd-box { margin: 0 0 12px; }
.pd-box > .hd { font-weight: 600; margin: 0 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--line); }
.pd-form { display: grid; grid-template-columns: max-content minmax(90px, 170px) max-content; gap: 6px 8px; align-items: center; }
.pd-form.wide { grid-template-columns: max-content minmax(140px, 1fr) max-content; }
.pd-form > label, .pd-lbl { color: var(--ink); white-space: nowrap; }
.pd-form .unit { color: var(--ink-2); }
.pd-form .span { grid-column: 1 / -1; }
.pd-check { display: flex; gap: 6px; align-items: center; color: var(--ink); margin: 2px 0; }
.pd-check input { width: auto; margin: 0; }
.pd-check.disabled { color: var(--ink-3, var(--ink-2)); }
.pd-note { color: var(--ink-2); font-size: 12px; margin: 4px 0 8px; }
.pd-info { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-2); padding: 6px 10px; margin: 0 0 10px; color: var(--ink); }
.pd-grid { border: 1px solid var(--line); border-radius: var(--r-2); overflow: auto; background: var(--panel); }
.pd-grid table { border-collapse: collapse; width: 100%; font-size: 12px; }
.pd-grid th { position: sticky; top: 0; background: var(--panel-2); text-align: left; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); white-space: nowrap; z-index: 1; }
.pd-grid td { padding: 0; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); height: 24px; }
.pd-grid td.ro, .pd-grid td.txt { padding: 3px 6px; white-space: nowrap; }
.pd-grid td.ro { color: var(--ink-2); }
.pd-grid tr.sel td { background: var(--sel); }
.pd-grid tr.hd td { background: var(--panel-2); font-weight: 600; padding: 3px 6px; }
.pd-grid td input[type=text], .pd-grid td k-select { border: none !important; border-radius: 0 !important; background: transparent !important; width: 100%; height: 23px; padding: 2px 6px !important; font-family: inherit !important; }
.pd-grid td input[type=text]:focus, .pd-grid td k-select:focus-within { outline: 2px solid var(--blue); outline-offset: -2px; }
.pd-grid td input[type=text] { min-width: 84px; }
.pd-grid td.chk { text-align: center; }
.pd-grid td.chk input { width: auto; margin: 0; }
.pd-gridbar { display: flex; gap: 4px; margin: 4px 0 0; }
.pd-iconbtn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); color: var(--ink); padding: 0; }
.pd-iconbtn:hover { border-color: var(--ink-3, var(--ink-2)); }
.pd-iconbtn:disabled { opacity: .4; cursor: default; }
.pd-report { border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: auto; font-size: 12px; padding: 4px 8px; min-height: 120px; }
.pd-report .ln { padding: 1px 0; white-space: pre-wrap; }
.pd-report .ln.error { color: var(--err); }
.pd-report .ln.warning { color: var(--warn); }
.pd-report .ln.action { color: var(--ink); }
.pd-report .ln.info { color: var(--ink-2); }
.pd-sev { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }
.pd-sev.error { background: var(--err); border-radius: 50%; }
.pd-sev.warning { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 10px solid var(--warn); }
.pd-sev.exclusion { background: var(--ink-3); }
.pd-sev.ignore { background: var(--ink-3); border-radius: var(--r-1); }
.pd-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 6px; }
.pd-row k-select, .pd-row input[type=text] { width: auto; }
.pd-cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
.pd-cols3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 20px; }
.pd-list { border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: auto; }
.pd-list .it { padding: 3px 8px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; }
.pd-list .it:hover { background: var(--panel-2); }
.pd-list .it.sel { background: var(--sel); }
.pd-list .it .sub { color: var(--ink-2); padding-left: 16px; }
.pd-list .hd { padding: 3px 8px; font-weight: 600; background: var(--panel-2); border-bottom: 1px solid var(--line); }
.pd-swatch { display: inline-block; width: 22px; height: 12px; border: 1px solid var(--line); vertical-align: -1px; }
.pd-layertable { border-collapse: collapse; margin: 8px 0; }
.pd-layertable td { padding: 2px 8px 2px 0; }
.pd-layertable td.chk input { width: auto; margin: 0 4px; }
.pd-layertable input[type=text] { width: 190px; }
.pd-layertable k-select { width: 190px; }
.pd-layertable tr.cu input[type=text] { font-weight: 600; }
.pd-layertable .desc { color: var(--ink-2); }
.pd-colhead { font-weight: 600; margin: 0 0 4px; }
.pd-status { font-size: 12px; } .pd-status.err { color: var(--err); } .pd-status.ok { color: var(--ink-2); }
.pd-sevtable { border-collapse: collapse; width: 100%; }
.pd-sevtable td { padding: 2px 10px 2px 0; white-space: nowrap; }
.pd-sevtable td:first-child { white-space: normal; width: 100%; padding-left: 14px; }
.pd-sevtable tr.hd td { font-weight: 600; padding: 8px 0 3px; }
.pd-sevtable input { width: auto; margin: 0; vertical-align: -2px; }
.pd-scroll { overflow: auto; }
.pd-inline { display: inline-flex; gap: 14px; align-items: center; }
.pd-value { font-variant-numeric: tabular-nums; }
.pd-drclist { height: 300px; }
.pd-drclist .it { align-items: flex-start; padding: 4px 8px; border-bottom: 1px solid var(--line); }
.pd-drclist .it .pd-sev { margin-top: 4px; flex: 0 0 auto; }
.pd-empty { padding: 10px; color: var(--ink-2); }
.pd-badge { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--line); font-size: 11px; text-align: center; margin-left: -4px; }
.pd-showrow { margin-top: 8px; }
.pd-stat { border-collapse: collapse; width: 100%; margin: 0 0 14px; }
.pd-stat th { text-align: left; font-weight: 600; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line); }
.pd-stat td { padding: 3px 8px 3px 0; } .pd-stat td.n, .pd-stat th + th { text-align: right; font-variant-numeric: tabular-nums; }
.pd-stat tr.total td { border-top: 1px solid var(--line); font-weight: 600; }
.pd-fieldlist { margin-top: 8px; border: 1px solid var(--line); border-radius: var(--r-2); padding: 6px 8px; background: var(--panel); max-height: 380px; overflow: auto; }
.pd-report .ln.hd { font-weight: 600; }
.pd-xy { display: inline-flex; gap: 6px; align-items: center; } .pd-xy input { width: 96px; } .pd-xy label { color: var(--ink); }
.pd-dim { color: var(--ink-3, var(--ink-2)) !important; opacity: .7; }
.pd-zone { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 0 16px; }
textarea.pd-text { width: 100%; min-height: 260px; font-family: var(--mono); font-size: 12px; white-space: pre; }
`;
let cssDone = false;
/** The kit's stylesheet, for a dialog opened with KDialogs.open directly (its own button row). */
export function ensureCss(): void {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const st = document.createElement("style"); st.id = "pcbdialogs-css"; st.textContent = CSS; document.head.appendChild(st);
}

/** el.append that skips the absent children. */
export function put(el: HTMLElement, ...children: Child[]): void { for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c); }

// ---------------------------------------------------------------- the dialog shell
export interface DialogApi { body: HTMLElement; close(): void; dialog: HTMLElement; okButton: HTMLButtonElement | null; cancelButton: HTMLButtonElement | null; setTitle(t: string): void }
export interface DialogSpec {
  title: string; width?: number; height?: number;
  build(body: HTMLElement, api: DialogApi): void;
  /** return false to keep the dialog open */
  ok?(): boolean | void;
  cancel?(): void;
  okLabel?: string; cancelLabel?: string;
  /** a dialog with only its Close button */
  noOk?: boolean; readOnly?: boolean;
  /** buttons left of the standard pair, in order */
  extra?: { label: string; fn(): void }[];
  /** Enter does not press the default button (grids, multi-line editors) */
  noEnter?: boolean;
  /** a modeless dialog: the canvas and the menus stay usable while it is open (DIALOG_DRC) */
  modeless?: boolean;
}
interface KDialogOpenApi { body: HTMLElement; close(): void }
/** KDialogs.open with KiCad's button wording and a size beyond the default cap. */
export function openDialog(spec: DialogSpec): DialogApi | null {
  if (typeof KDialogs === "undefined" || !KDialogs) return null;
  ensureCss();
  let out: DialogApi | null = null;
  KDialogs.open({ title: spec.title, width: spec.width, okLabel: spec.okLabel, readOnly: spec.readOnly, extra: spec.extra, ok: spec.ok, cancel: spec.cancel, modeless: spec.modeless,
    build(body: HTMLElement, a: KDialogOpenApi) {
      const dlg = body.parentElement as HTMLElement;
      if (spec.width) dlg.style.maxWidth = "96vw";
      if (spec.height) { dlg.style.height = `min(${spec.height}px, 92vh)`; body.style.flex = "1 1 auto"; body.style.minHeight = "0"; body.style.display = "flex"; body.style.flexDirection = "column"; }
      const buttons = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".kd-foot > button"));
      const okButton = buttons.length ? buttons[buttons.length - 1] : null, cancelButton = buttons.length > 1 ? buttons[buttons.length - 2] : null;
      if (cancelButton && spec.cancelLabel) cancelButton.textContent = spec.cancelLabel;
      if (okButton && spec.noOk) { okButton.style.display = "none"; if (cancelButton && !spec.cancelLabel) cancelButton.textContent = "Close"; }
      if (spec.noEnter) body.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.stopPropagation(); });
      const title = dlg.querySelector(".kd-title span");
      out = { body, close: a.close, dialog: dlg, okButton, cancelButton, setTitle(t: string) { if (title) title.textContent = t; } };
      spec.build(body, out);
    } });
  return out;
}

/**
 * A message over the dialog that asked for it (DisplayError, wxMessageBox, IsOK): its own overlay on top of the open
 * dialog, which stays as it is.  buttons: left to right; the last is the default (Enter), Escape picks `escape` (or
 * the first button).
 */
export function messageBox(title: string, message: string, buttons: { label: string; fn?: () => void }[] = [{ label: "OK" }], escape?: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  ensureCss();
  const ov = h("div", { class: "kd-overlay", style: "z-index:10050", "data-k": "messagebox" });
  const dlg = h("div", { class: "kd-dialog", style: "width:440px", tabIndex: -1 });
  const body = h("div", { class: "kd-body" }, h("p", { style: "margin:4px 0 6px;white-space:pre-wrap", "data-k": "message" }, message));
  const foot = h("div", { class: "kd-foot" }, h("span", { class: "spacer" }));
  const done = (i: number): void => { ov.remove(); const b = buttons[i]; if (b && b.fn) b.fn(); };
  const btns = buttons.map((b, i) => { const e = h("button", { class: "btn" + (i === buttons.length - 1 ? " primary" : ""), type: "button", "data-k": "mb-" + b.label.toLowerCase() }, b.label); e.addEventListener("click", () => done(i)); return e; });
  foot.append(...btns);
  dlg.append(h("div", { class: "kd-title" }, h("span", null, title)), body, foot); ov.append(dlg);
  ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov);
    if (ev.key === "Escape") { ev.preventDefault(); done(escape === undefined ? 0 : escape); }
    else if (ev.key === "Enter" && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(buttons.length - 1); }
  });
  document.body.append(ov); const last = btns[btns.length - 1]; if (last) last.focus(); else dlg.focus();
  return ov;
}
/**
 * WX_TEXT_ENTRY_DIALOG over the dialog that asked for it: a caption, a (multi-line) text field and Cancel / OK.
 * OK hands the text to onOk; Cancel or Escape leaves it alone.
 */
export function textEntryBox(title: string, caption: string, value: string, multiline: boolean, onOk: (text: string) => void): HTMLElement | null {
  if (typeof document === "undefined") return null;
  ensureCss();
  const ov = h("div", { class: "kd-overlay", style: "z-index:10050", "data-k": "textentry" });
  const dlg = h("div", { class: "kd-dialog", style: "width:440px", tabIndex: -1 });
  const field = multiline ? h("textarea", { class: "pd-text", style: "min-height:90px;width:100%", "data-k": "entry" }) : h("input", { type: "text", style: "width:100%", "data-k": "entry" });
  (field as HTMLInputElement | HTMLTextAreaElement).value = value;
  const body = h("div", { class: "kd-body" }, caption ? h("p", { style: "margin:4px 0 6px" }, caption) : null, field);
  const done = (ok: boolean): void => { ov.remove(); if (ok) onOk((field as HTMLInputElement | HTMLTextAreaElement).value); };
  const cancel = h("button", { class: "btn", type: "button", "data-k": "te-cancel" }, "Cancel"), okb = h("button", { class: "btn primary", type: "button", "data-k": "te-ok" }, "OK");
  cancel.addEventListener("click", () => done(false)); okb.addEventListener("click", () => done(true));
  dlg.append(h("div", { class: "kd-title" }, h("span", null, title)), body, h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), cancel, okb)); ov.append(dlg);
  ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov);
    if (ev.key === "Escape") { ev.preventDefault(); done(false); }
    else if (ev.key === "Enter" && (!multiline || ev.shiftKey || ev.ctrlKey || ev.metaKey) && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(true); }
  });
  document.body.append(ov); field.focus();
  return ov;
}
/** DisplayError: an "Error" message with an OK button, over the dialog. */
export const errorMessage = (message: string, then?: () => void): void => { messageBox("Error", message, [{ label: "OK", fn: then }]); };

/** wxMessageBox / confirmation. */
export function confirmBox(title: string, message: string, okLabel: string, onOk: () => void): void {
  openDialog({ title, width: 440, okLabel, build(body) { body.append(h("p", { style: "margin:4px 0 6px;white-space:pre-wrap" }, message)); }, ok() { setTimeout(onOk, 0); } });
}

// ---------------------------------------------------------------- units (UNIT_BINDER)
type Units = "mm" | "in" | "mil";
const UNIT: Record<Units, { name: string; per: number; digits: number }> = { mm: { name: "mm", per: 1, digits: 4 }, in: { name: "in", per: 25.4, digits: 5 }, mil: { name: "mils", per: 0.0254, digits: 2 } };
export const currentUnits = (): Units => (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
export const unitName = (): string => UNIT[currentUnits()].name;
const trim = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
/** A millimetre length in the editor's units, without the unit name ("0.2", "7.87"). */
export function fmtLen(mm: number): string { const u = UNIT[currentUnits()]; return trim((mm / u.per).toFixed(u.digits)) || "0"; }
/** …with the unit name, as KiCad's grids and reports show it ("0.2 mm"). */
export function fmtLenU(mm: number): string { return fmtLen(mm) + " " + unitName(); }
/** A typed length ("0.2", "0.2mm", "8 mils", "0.01in") in millimetres; NaN when it is no number. */
export function parseLen(text: string): number {
  const m = /^\s*(-?\d*[.,]?\d+(?:e-?\d+)?)\s*(mm|in|inch|"|mils?|thou|um|µm)?\s*$/i.exec(text);
  if (!m) return NaN;
  const v = Number(m[1].replace(",", ".")), s = (m[2] || "").toLowerCase();
  const per = s === "mm" ? 1 : s === "in" || s === "inch" || s === '"' ? 25.4 : s.startsWith("mil") || s === "thou" ? 0.0254 : s === "um" || s === "µm" ? 0.001 : UNIT[currentUnits()].per;
  return +(v * per).toFixed(6);
}

export interface Field<T> { el: HTMLElement; get(): T; set(v: T): void; input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement }
/** A length: the text control; pair it with unitLabel() in a form row. */
export function lenField(mm: number, opts?: { ro?: boolean; key?: string; min?: number; allowEmpty?: boolean }): Field<number> {
  let cur = mm;
  const input = h("input", { type: "text", value: opts && opts.allowEmpty && !isFinite(mm) ? "" : fmtLen(mm), disabled: !!(opts && opts.ro), "data-k": opts && opts.key });
  input.addEventListener("change", () => { const v = parseLen(input.value); if (isNaN(v)) { if (opts && opts.allowEmpty && !input.value.trim()) { cur = NaN; return; } input.value = isFinite(cur) ? fmtLen(cur) : ""; return; } cur = opts && opts.min !== undefined ? Math.max(opts.min, v) : v; input.value = fmtLen(cur); });
  // an untouched field gives back the value it was given, not its display rounding (0.58642 shown as 0.5864)
  return { el: input, input, get: () => { if (isFinite(cur) && input.value === fmtLen(cur)) return cur; const v = parseLen(input.value); return isNaN(v) ? cur : (opts && opts.min !== undefined ? Math.max(opts.min, v) : v); }, set(v) { cur = v; input.value = isFinite(v) ? fmtLen(v) : ""; } };
}
/**
 * A board position (UNIT_BINDER with SetCoordType( ABS_X_COORD / ABS_Y_COORD )): shown from the user origin with the
 * axis senses of Preferences > PCB Editor > Origins & Axes, and given back in board coordinates.
 */
export function coordField(mm: number, axis: "x" | "y", opts?: { ro?: boolean; key?: string }): Field<number> {
  // the board value comes back untouched while the shown value is the one it gave (no float drift from the round trip)
  let raw = mm, shown = toDisplayAbsAxis(mm, axis);
  const f = lenField(shown, opts);
  const back = (d: number): number => (d === shown ? raw : +fromDisplayAbsAxis(d, axis).toFixed(6));
  return { el: f.el, input: f.input, get: () => back(f.get()), set: (v) => { raw = v; shown = toDisplayAbsAxis(v, axis); f.set(shown); } };
}
export const unitLabel = (text?: string): HTMLElement => h("span", { class: "unit" }, text === undefined ? unitName() : text);
export function numField(v: number, opts?: { ro?: boolean; key?: string; digits?: number }): Field<number> {
  let cur = v; const fmt = (x: number): string => trim(x.toFixed(opts && opts.digits !== undefined ? opts.digits : 6)) || "0";
  const input = h("input", { type: "text", value: fmt(v), disabled: !!(opts && opts.ro), "data-k": opts && opts.key });
  input.addEventListener("change", () => { const x = Number(input.value.replace(",", ".")); if (isNaN(x) || !input.value.trim()) input.value = fmt(cur); else { cur = x; input.value = fmt(x); } });
  return { el: input, input, get: () => { if (input.value === fmt(cur)) return cur; const x = Number(input.value.replace(",", ".")); return isNaN(x) || !input.value.trim() ? cur : x; }, set(x) { cur = x; input.value = fmt(x); } };
}
export function textField(v: string, opts?: { ro?: boolean; key?: string; placeholder?: string }): Field<string> {
  const input = h("input", { type: "text", value: v, disabled: !!(opts && opts.ro), "data-k": opts && opts.key, placeholder: opts && opts.placeholder });
  return { el: input, input, get: () => input.value, set(x) { input.value = x; } };
}
export function selectField<T extends string | number>(v: T, options: [T, string][], opts?: { ro?: boolean; key?: string; onChange?(v: T): void }): Field<T> {
  const input = h("k-select", { disabled: !!(opts && opts.ro), "data-k": opts && opts.key });
  options.forEach(([val, label]) => { const o = h("option", { value: String(val) }, label); if (String(val) === String(v)) o.selected = true; input.append(o); });
  if (!options.some(([val]) => String(val) === String(v)) && options.length) input.selectedIndex = 0;
  const get = (): T => (options[input.selectedIndex] || options[0])[0];
  if (opts && opts.onChange) { const cb = opts.onChange; input.addEventListener("change", () => cb(get())); }
  return { el: input, input, get, set(x) { const i = options.findIndex(([val]) => String(val) === String(x)); if (i >= 0) input.selectedIndex = i; } };
}
export function checkField(v: boolean, label: string, opts?: { ro?: boolean; key?: string; tip?: string; onChange?(v: boolean): void }): Field<boolean> {
  const input = h("input", { type: "checkbox", checked: v, disabled: !!(opts && opts.ro), "data-k": opts && opts.key });
  const el = h("label", { class: "pd-check" + (opts && opts.ro ? " disabled" : ""), title: opts && opts.tip }, input, label);
  if (opts && opts.onChange) { const cb = opts.onChange; input.addEventListener("change", () => cb(input.checked)); }
  return { el, input, get: () => input.checked, set(x) { input.checked = x; } };
}

/** wxStaticBoxSizer: a titled group. */
export function box(title: string, ...children: Child[]): HTMLElement { return h("div", { class: "pd-box" }, h("div", { class: "hd" }, title), ...children); }
/** A label / control / unit grid; rows are [label, control, unit?] or a single element spanning the row. */
export function form(rows: ([string, Child, Child?, string?] | Child)[], wide?: boolean): HTMLElement {
  const f = h("div", { class: "pd-form" + (wide ? " wide" : "") });
  for (const r of rows) {
    if (Array.isArray(r)) { f.append(h("label", r[3] ? { title: r[3] } : null, r[0]), (r[1] as Node) || h("span"), (r[2] as Node) || h("span")); }
    else if (r) { const s = h("div", { class: "span" }); s.append(r as Node | string); f.append(s); }
  }
  return f;
}
export const note = (text: string): HTMLElement => h("p", { class: "pd-note" }, text);

// ---------------------------------------------------------------- notebook and tree book
export interface Page { label: string; build(el: HTMLElement): void }
/** wxNotebook: tabs across the top, pages built on first show. */
export function notebook(pages: Page[], opts?: { start?: number; onShow?(i: number): void; fill?: boolean }): { el: HTMLElement; show(i: number): void; setLabel(i: number, label: string): void; current(): number } {
  const bar = h("div", { class: "pd-tabs" }), host = h("div", opts && opts.fill ? { style: "flex:1 1 auto;min-height:0;display:flex;flex-direction:column" } : null);
  const el = h("div", opts && opts.fill ? { style: "display:flex;flex-direction:column;flex:1 1 auto;min-height:0" } : null, bar, host);
  const built: (HTMLElement | null)[] = pages.map(() => null), tabs: HTMLButtonElement[] = [];
  let cur = -1;
  const show = (i: number): void => {
    if (i === cur || !pages[i]) return;
    cur = i;
    tabs.forEach((t, k) => t.classList.toggle("on", k === i));
    let p = built[i];
    if (!p) { p = h("div", opts && opts.fill ? { style: "flex:1 1 auto;min-height:0;display:flex;flex-direction:column" } : null); built[i] = p; pages[i].build(p); }
    host.replaceChildren(p);
    if (opts && opts.onShow) opts.onShow(i);
  };
  pages.forEach((pg, i) => { const t = h("button", { class: "pd-tab", type: "button" }, pg.label); t.addEventListener("click", () => show(i)); tabs.push(t); bar.append(t); });
  show(opts && opts.start ? opts.start : 0);
  return { el, show, setLabel(i, label) { if (tabs[i]) tabs[i].textContent = label; }, current: () => cur };
}

export interface TreeGroup { label: string; pages: Page[] }
/** PAGED_DIALOG: groups with sub-pages down the left, the chosen page on the right. */
export function treeBook(groups: TreeGroup[], start?: string): { el: HTMLElement; show(label: string): void; current(): string; built(label: string): boolean } {
  const tree = h("div", { class: "pd-tree" }), page = h("div", { class: "pd-page" }), el = h("div", { class: "pd-book" }, tree, page);
  const built = new Map<string, HTMLElement>(), leaves = new Map<string, HTMLElement>(), specs = new Map<string, Page>();
  let cur = "";
  const show = (label: string): void => {
    const pg = specs.get(label); if (!pg || label === cur) return;
    cur = label;
    for (const [l, leaf] of leaves) leaf.classList.toggle("on", l === label);
    let p = built.get(label);
    if (!p) { p = h("div"); built.set(label, p); pg.build(p); }
    page.replaceChildren(p); page.scrollTop = 0;
  };
  for (const g of groups) {
    tree.append(h("div", { class: "grp" }, g.label));
    for (const pg of g.pages) { const leaf = h("div", { class: "leaf" }, pg.label); leaf.addEventListener("click", () => show(pg.label)); leaves.set(pg.label, leaf); specs.set(pg.label, pg); tree.append(leaf); }
  }
  show(start && specs.has(start) ? start : groups[0].pages[0].label);
  return { el, show, current: () => cur, built: (l) => built.has(l) };
}

// ---------------------------------------------------------------- grids (WX_GRID)
const svg = (inner: string): string => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const ICONS = {
  plus: svg('<path d="M8 2.5v11M13.5 8h-11"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke-width="1.5"/>'),
  up: svg('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>'),
  down: svg('<path d="M8 3v10M3.5 8.5L8 13l4.5-4.5"/>'),
  library: svg('<path d="M2.5 3v10M5 3v10M7.5 3.5l3 9.5M11 3l2.5 9.5" stroke-width="1.4"/>'),
};
export function iconButton(icon: keyof typeof ICONS, title: string, fn: () => void, disabled?: boolean): HTMLButtonElement {
  const b = h("button", { class: "pd-iconbtn", type: "button", title, disabled: !!disabled });
  b.innerHTML = ICONS[icon]; b.addEventListener("click", fn); return b;
}

export type CellValue = string | number | boolean;
export interface GridColumn {
  label: string; key: string; width?: string;
  /** text (default), a length in the editor's units, a number, a checkbox, a choice or read-only text */
  type?: "text" | "len" | "num" | "check" | "select" | "ro";
  options?: [string | number, string][];
  /** a per-row override: read-only cells (the Default netclass's name) */
  readOnly?(row: Record<string, CellValue>, index: number): boolean;
  /** shown for an unset length (NaN) */
  blank?: string;
}
export interface GridApi { el: HTMLElement; rows(): Record<string, CellValue>[]; setRows(rows: Record<string, CellValue>[]): void; selected(): number; select(i: number): void; refresh(): void }
/** An editable table; `rows` is edited in place (commit reads grid.rows()). */
export function grid(columns: GridColumn[], rows: Record<string, CellValue>[], opts?: { ro?: boolean; height?: string; onSelect?(i: number): void; onChange?(): void; rowClass?(row: Record<string, CellValue>, i: number): string }): GridApi {
  let data = rows, sel = -1;
  const table = h("table"), wrap = h("div", { class: "pd-grid", style: opts && opts.height ? `max-height:${opts.height}` : null }, table);
  const changed = (): void => { if (opts && opts.onChange) opts.onChange(); };
  const select = (i: number): void => { sel = i; Array.from(table.querySelectorAll("tbody tr")).forEach((tr, k) => tr.classList.toggle("sel", k === i)); if (opts && opts.onSelect) opts.onSelect(i); };
  const refresh = (): void => {
    table.replaceChildren();
    const head = h("tr"); for (const c of columns) head.append(h("th", { style: c.width ? `width:${c.width}` : null }, c.label));
    table.append(h("thead", null, head));
    const body = h("tbody");
    data.forEach((row, i) => {
      const tr = h("tr", { class: (i === sel ? "sel " : "") + (opts && opts.rowClass ? opts.rowClass(row, i) : "") });
      tr.addEventListener("pointerdown", () => { if (sel !== i) select(i); });
      for (const c of columns) {
        const ro = !!(opts && opts.ro) || c.type === "ro" || (c.readOnly ? c.readOnly(row, i) : false);
        const v = row[c.key];
        if (c.type === "check") {
          const cb = h("input", { type: "checkbox", checked: !!v, disabled: ro }); cb.addEventListener("change", () => { row[c.key] = cb.checked; changed(); });
          tr.append(h("td", { class: "chk" }, cb));
        } else if (c.type === "select" && !ro) {
          const s = h("k-select"); for (const [val, label] of c.options || []) { const o = h("option", { value: String(val) }, label); if (String(val) === String(v)) o.selected = true; s.append(o); }
          s.addEventListener("change", () => { const o = (c.options || [])[s.selectedIndex]; if (o) { row[c.key] = o[0]; changed(); } });
          tr.append(h("td", null, s));
        } else if (ro) {
          const text = c.type === "len" ? (typeof v === "number" && isFinite(v) ? fmtLenU(v) : c.blank || "") : c.type === "select" ? (((c.options || []).find((o) => String(o[0]) === String(v)) || [0, String(v === undefined ? "" : v)])[1]) : String(v === undefined ? "" : v);
          tr.append(h("td", { class: "ro", title: text }, text));
        } else {
          const text = c.type === "len" ? (typeof v === "number" && isFinite(v) ? fmtLenU(v) : "") : c.type === "num" ? (typeof v === "number" && isFinite(v) ? trim(v.toFixed(6)) : "") : String(v === undefined ? "" : v);
          const inp = h("input", { type: "text", value: text, placeholder: c.blank });
          inp.addEventListener("change", () => {
            if (c.type === "len") { const x = parseLen(inp.value); if (!inp.value.trim()) { row[c.key] = NaN; inp.value = ""; } else if (isNaN(x)) inp.value = text; else { row[c.key] = x; inp.value = fmtLenU(x); } }
            else if (c.type === "num") { const x = Number(inp.value.replace(",", ".")); if (!inp.value.trim()) row[c.key] = NaN; else if (isNaN(x)) inp.value = text; else row[c.key] = x; }
            else row[c.key] = inp.value;
            changed();
          });
          inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); inp.blur(); } });
          tr.append(h("td", null, inp));
        }
      }
      body.append(tr);
    });
    table.append(body);
  };
  refresh();
  return { el: wrap, rows: () => data, setRows(r) { data = r; sel = -1; refresh(); }, selected: () => sel, select, refresh };
}
/** EDA_LIST_DIALOG: a filter box (wildcards, "*text*", case-insensitive, on the first column), "Items:" and a
 *  read-only list; OK, Enter or a double-click picks the selected row.  `onPick` gets the row's columns. */
export interface ListDialogOpts {
  select?: string; width?: number;
  /** EDA_LIST_DIALOG::SetListLabel (default "Items:") */
  listLabel?: string;
  /** EDA_LIST_DIALOG::SetOKLabel */
  okLabel?: string;
  /** SAVE_AS_DIALOG's "Name:" field above the list */
  name?: { label: string; value: string; invalidChars?: string };
  /** buttons left of the standard pair ("New Library...") */
  extra?: { label: string; fn(): void }[];
  /** TransferDataFromWindow: false (or a promise of false) keeps the dialog open */
  validate?(row: string[] | null, name: string): boolean | Promise<boolean>;
  /** OK with the row and the name (when there is a name field) */
  onOk?(row: string[] | null, name: string): void;
}
export function listDialog(title: string, headers: string[], items: string[][], onPick: (row: string[]) => void, opts?: ListDialogOpts): DialogApi | null {
  const cols: GridColumn[] = headers.map((label, i) => ({ key: "c" + i, label, type: "ro" as const }));
  const toRows = (list: string[][]) => list.map((r) => { const o: Record<string, CellValue> = {}; r.forEach((v, i) => { o["c" + i] = v; }); return o; });
  let shown = items.slice();
  const g = grid(cols, toRows(shown), { height: "300px" });
  const filter = h("input", { type: "text", placeholder: "Filter", "data-k": "filter", style: "width:100%;margin-bottom:6px" });
  const wild = (pat: string) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  filter.addEventListener("input", () => { const re = wild("*" + filter.value.toLowerCase() + "*"); shown = items.filter((r) => re.test(String(r[0] || "").toLowerCase())); g.setRows(toRows(shown)); if (shown.length) g.select(0); });
  const nameIn = opts && opts.name ? h("input", { type: "text", "data-k": "name", value: opts.name.value, style: "flex:1" }) as HTMLInputElement : null;
  if (nameIn && opts!.name!.invalidChars) { const bad = opts!.name!.invalidChars; nameIn.addEventListener("input", () => { const v = nameIn.value.split("").filter((c) => !bad.includes(c)).join(""); if (v !== nameIn.value) nameIn.value = v; }); }
  let api: DialogApi | null = null; let busy = false;
  const row = (): string[] | null => { const i = g.selected(); return i >= 0 ? shown[i] || null : null; };
  const pick = (): boolean => {
    const r = row(); const name = nameIn ? nameIn.value.trim() : "";
    if (!opts || (!opts.validate && !opts.onOk)) { if (!r) return false; onPick(r); return true; }
    if (busy) return false;
    const v = opts.validate ? opts.validate(r, name) : true;
    const finish = (ok: boolean) => { busy = false; if (!ok) return; if (opts.onOk) opts.onOk(r, name); else if (r) onPick(r); if (api) api.close(); };
    if (v instanceof Promise) { busy = true; v.then(finish, () => { busy = false; }); return false; }
    if (!v) return false;
    if (opts.onOk) opts.onOk(r, name); else if (r) onPick(r);
    return true;
  };
  api = openDialog({ title, width: opts && opts.width || 400, okLabel: opts && opts.okLabel, extra: opts && opts.extra,
    build(body) {
      if (nameIn) body.append(h("div", { style: "display:flex;align-items:center;gap:6px;margin-bottom:8px" }, h("span", { class: "pd-lbl" }, opts!.name!.label), nameIn));
      body.append(filter, h("div", { class: "pd-lbl", style: "margin-bottom:4px" }, (opts && opts.listLabel) || "Items:"), g.el);
      g.el.addEventListener("dblclick", () => { if (pick() && api) api.close(); });
      const at = opts && opts.select ? shown.findIndex((r) => r[0] === opts.select) : 0; if (shown.length) g.select(Math.max(0, at));
      setTimeout(() => { if (nameIn) { nameIn.focus(); nameIn.select(); } else filter.focus(); }, 0);
    },
    ok() { return pick(); } });
  return api;
}
/** The add / delete buttons KiCad puts under a grid. */
export function gridButtons(g: GridApi, make: () => Record<string, CellValue>, opts?: { ro?: boolean; canDelete?(row: Record<string, CellValue>, i: number): boolean; onChange?(): void; move?: boolean; addTip?: string; delTip?: string }): HTMLElement {
  const ro = !!(opts && opts.ro);
  const bar = h("div", { class: "pd-gridbar" });
  bar.append(iconButton("plus", (opts && opts.addTip) || "Add row", () => { const rows = g.rows(); rows.push(make()); g.refresh(); g.select(rows.length - 1); const last = g.el.querySelector("tbody tr:last-child input[type=text]") as HTMLInputElement | null; if (last) { last.focus(); last.select(); } if (opts && opts.onChange) opts.onChange(); }, ro));
  if (opts && opts.move) {
    const swap = (d: number): void => { const rows = g.rows(), i = g.selected(), j = i + d; if (i < 0 || j < 0 || j >= rows.length) return; [rows[i], rows[j]] = [rows[j], rows[i]]; g.refresh(); g.select(j); if (opts.onChange) opts.onChange(); };
    bar.append(iconButton("up", "Move up", () => swap(-1), ro), iconButton("down", "Move down", () => swap(1), ro));
  }
  bar.append(iconButton("trash", (opts && opts.delTip) || "Delete row", () => { const rows = g.rows(), i = g.selected(); if (i < 0 || i >= rows.length) return; if (opts && opts.canDelete && !opts.canDelete(rows[i], i)) return; rows.splice(i, 1); g.refresh(); g.select(Math.min(i, rows.length - 1)); if (opts && opts.onChange) opts.onChange(); }, ro));
  return bar;
}

// ---------------------------------------------------------------- report panel
export interface ReportLine { severity: string; text: string }
/** WX_HTML_REPORT_PANEL: the message list with its "Show:" filter row. */
export function reportPanel(height?: string): { el: HTMLElement; set(lines: ReportLine[]): void } {
  const list = h("div", { class: "pd-report", style: `height:${height || "260px"}` });
  let lines: ReportLine[] = [];
  const filters: Record<string, Field<boolean>> = {};
  const draw = (): void => {
    list.replaceChildren();
    for (const l of lines) { const key = l.severity === "error" ? "Errors" : l.severity === "warning" ? "Warnings" : l.severity === "action" ? "Actions" : "Infos"; if (!filters.All.get() && !filters[key].get()) continue; list.append(h("div", { class: "ln " + l.severity }, l.text)); }
    if (!list.childElementCount) list.append(h("div", { class: "ln info" }, lines.length ? "" : "No changes to be made."));
    const count = (s: string): number => lines.filter((l) => l.severity === s).length;
    (filters.Errors.el.lastChild as Text).textContent = `Errors (${count("error")})`; (filters.Warnings.el.lastChild as Text).textContent = `Warnings (${count("warning")})`;
  };
  const bar = h("div", { class: "pd-row", style: "margin-top:6px" }, h("span", { class: "pd-lbl" }, "Show:"));
  for (const [name, on] of [["All", true], ["Errors", true], ["Warnings", true], ["Actions", true], ["Infos", true]] as [string, boolean][]) {
    const f = checkField(on, name, { onChange: (v) => { if (name === "All") for (const k of Object.keys(filters)) filters[k].set(v); else filters.All.set(["Errors", "Warnings", "Actions", "Infos"].every((k) => filters[k].get())); draw(); } });
    filters[name] = f; bar.append(f.el);
  }
  const el = h("div", null, list, bar);
  return { el, set(l) { lines = l; draw(); } };
}

export function download(name: string, text: string, type = "text/plain"): void {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
