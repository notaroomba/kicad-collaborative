// view-switcher.ts — EDA_VIEW_SWITCHER, the Preset and Viewport switcher of the board and footprint editors
// (pcbnew/pcb_base_edit_frame.cpp:111-178 TryBefore, common/dialogs/eda_view_switcher.cpp,
// common/dialogs/eda_view_switcher_base.cpp):
//
//   • holding PRESET_SWITCH_KEY (Ctrl; the physical Control key on macOS) and pressing Tab opens a borderless
//     "View Preset Switcher" centred on the frame, listing the layer presets most recently used first;
//     VIEWPORT_SWITCH_KEY (Shift; Option on macOS) with Tab does the same for the viewports;
//   • the list starts on its first row and the opening Tab advances it; each further Tab advances again, Shift+Tab
//     goes back (unless Shift is the switch key);
//   • releasing the switch key applies the selected row (wxID_OK) and moves it to the front of the MRU; Esc cancels;
//   • nothing opens while the MRU is empty.
//
// Browsers keep Ctrl+Tab for themselves, so the preset switcher is reached where the page receives the key: in a
// fullscreen window the editor asks for keyboard capture of Tab (navigator.keyboard.lock), and in an installed
// app window that does not take Ctrl+Tab.  Everywhere else the preset switcher also opens and steps on Ctrl+` (the key
// under Esc with the same held Control, by its position so Shift may go with it).  Shift+Tab opens the viewport
// switcher only with the canvas focused: on a button, a docked pane or a table it stays the browser's step back through
// the focusable controls.
import { applyLayerPresetByName, applyViewportByName, layerPresetsMRU, viewportsMRU } from "./panels/appearance";
import { IS_MAC } from "../keys";
import { advance, switcherFor, type SwitcherKind as Kind } from "./view-switcher-model";
import { E } from "./state";
import { state } from "./appstore";
import { stage } from "./view";

interface Open { kind: Kind; items: string[]; sel: number; el: HTMLElement; list: HTMLElement; key: "Control" | "Shift" | "Alt" }

let cur: Open | null = null;

const boardFrame = (): boolean => state.view === "editor" && !!E.kdoc && E.kdoc.type !== "sch";

function render(o: Open): void {
  o.list.replaceChildren(...o.items.map((name, i) => {
    const row = document.createElement("div");
    row.className = "vsw-row kview-row" + (i === o.sel ? " on" : "");
    row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === o.sel)); row.dataset.idx = String(i);
    row.textContent = name;
    return row;
  }));
}

function close(apply: boolean): void {
  const o = cur; if (!o) return; cur = null;
  o.el.remove();
  if (!apply) return;
  const name = o.items[o.sel]; if (name === undefined) return;
  if (o.kind === "preset") applyLayerPresetByName(name); else applyViewportByName(name);
}

function show(kind: Kind, items: string[], shift: boolean): void {
  const key: Open["key"] = kind === "preset" ? "Control" : IS_MAC ? "Alt" : "Shift";
  const el = document.createElement("div");
  el.id = "viewSwitcher"; el.className = "vsw kview-switcher"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
  el.dataset.switcher = kind;
  const title = document.createElement("div"); title.className = "vsw-title"; title.textContent = "View Preset Switcher";
  const list = document.createElement("div"); list.className = "vsw-list"; list.setAttribute("role", "listbox");
  el.append(title, list);
  const o: Open = { kind, items, sel: Math.min(0, items.length - 1), el, list, key };
  // without key-state polling the Tab that opened the switcher is counted now
  o.sel = advance(o.sel, items.length, shift, key);
  cur = o; render(o);
  document.body.append(el);
  // Centre(): on the frame, i.e. the canvas area
  const r = stage.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.round(Math.max(4, Math.min(window.innerWidth - w - 4, r.left + (r.width - w) / 2))) + "px";
  el.style.top = Math.round(Math.max(4, Math.min(window.innerHeight - h - 4, r.top + (r.height - h) / 2))) + "px";
}

/** A text field, a list or a dialog keeps its own Tab. */
function ownsTab(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : null; if (!el) return false;
  if (el.closest("input, textarea, select, k-select, [contenteditable=''], [contenteditable='true'], .kd-dialog, [role=dialog]:not(#viewSwitcher), #kmenus")) return true;
  return false;
}

/** The key the page receives in place of the browser's Ctrl+Tab: Backquote, by its position. */
const isAltStep = (ev: KeyboardEvent): boolean => ev.code === "Backquote";
/** The canvas has the keyboard: nothing focusable (body) or the drawing stage itself. */
function canvasFocused(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  return typeof el.closest === "function" && !!el.closest("#stage");
}

function onKeyDown(ev: KeyboardEvent): void {
  if (cur) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (ev.key === "Tab" || (cur.kind === "preset" && isAltStep(ev))) { cur.sel = advance(cur.sel, cur.items.length, ev.shiftKey, cur.key); render(cur); }
    else if (ev.key === "Escape") close(false);
    return;
  }
  let kind = switcherFor(ev);
  if (!kind && isAltStep(ev) && ev.ctrlKey && !ev.metaKey && !ev.altKey) kind = "preset";
  if (!kind || !boardFrame() || ownsTab(ev.target)) return;
  if (kind === "viewport" && !canvasFocused(ev.target)) return;
  const items = kind === "preset" ? layerPresetsMRU() : viewportsMRU();
  if (!items.length) return;   // an empty MRU leaves the key to everyone else
  ev.preventDefault(); ev.stopImmediatePropagation();
  show(kind, items, ev.shiftKey);
}
function onKeyUp(ev: KeyboardEvent): void {
  if (!cur) return;
  // the trailing edge of the switch key: wxID_OK
  if (ev.key === cur.key || (cur.key === "Control" && !ev.ctrlKey) || (cur.key === "Shift" && !ev.shiftKey) || (cur.key === "Alt" && !ev.altKey)) { ev.preventDefault(); close(true); }
}

/** In fullscreen the page may capture Tab with its modifiers (Keyboard Lock), so Ctrl+Tab reaches the editor. */
function lockTab(): void {
  const kb = (navigator as unknown as { keyboard?: { lock?(keys: string[]): Promise<void>; unlock?(): void } }).keyboard;
  if (!kb || !kb.lock) return;
  if (document.fullscreenElement) kb.lock(["Tab"]).catch(() => { /* not allowed here */ }); else if (kb.unlock) kb.unlock();
}

export function installViewSwitcher(): void {
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", () => close(false));
  document.addEventListener("fullscreenchange", lockTab);
}
