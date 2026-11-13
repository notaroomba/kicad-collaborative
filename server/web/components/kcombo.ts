// components/kcombo.ts — an editable combo box (wxComboBox): a text entry with a drop-down button whose list puts an
// entry's text into the entry.  The list is the themed popup <k-select> uses (.ksel-pop / .ksel-opt in theme.css),
// placed under the control and kept on screen with menufit.ts, never the browser's own <datalist> popup.
//
// With { filter: true } it is KiCad's FILTER_COMBOBOX (common/widgets/filter_combobox.cpp): the list is sorted, and the
// popup opens with a "Filter:" entry above it that takes the keyboard; typing narrows the list to the entries holding
// the text (a case-insensitive substring; spaces are refused, a leading "::" is dropped) and picks the first.
//
//   mouse      the button opens and closes the list; a click on an entry takes it; a click elsewhere or a scroll closes
//   keyboard   Alt+Down / Down in the entry open the list; Up, Down move; Enter takes the highlighted entry (an empty
//              pick changes nothing); Escape closes; Tab closes and moves on (the host carries data-popup-open while
//              the list is up, so dialogs leave Escape)
import { menuScroller } from "../menufit";

export interface KCombo { el: HTMLElement; input: HTMLInputElement; setOptions(list: string[]): void; open(): void; close(): void; isOpen(): boolean }

const CARET = '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 2.5h6L4 6z" fill="currentColor"/></svg>';
let seq = 0;

/** wxArrayString::Sort: by character code. */
const sorted = (l: string[]): string[] => l.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Wrap `input` (already built by the dialog) into a combo box offering `options`. */
export function comboBox(input: HTMLInputElement, options: string[], cfg: { filter?: boolean } = {}): KCombo {
  const filtered = !!cfg.filter;
  let all = filtered ? sorted(options) : options.slice(), list = all.slice();
  let pop: HTMLElement | null = null, box: HTMLElement | null = null, filt: HTMLInputElement | null = null, hi = -1, undo: (() => void)[] = [];
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn kcombo-btn"; btn.tabIndex = -1; btn.innerHTML = CARET;
  btn.setAttribute("aria-label", "Show the list"); btn.style.cssText = "padding:0 5px;flex:none;align-self:stretch;display:flex;align-items:center";
  const el = document.createElement("span"); el.className = "kcombo"; el.style.cssText = "display:flex;gap:2px;align-items:stretch;min-width:0;width:100%";
  input.style.flex = "1"; input.style.minWidth = "0"; input.autocomplete = "off"; input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "false");
  input.replaceWith(el); el.append(input, btn);
  const sync = (): void => { btn.disabled = input.disabled || !all.length; };
  sync();
  const rows = (): HTMLElement[] => (box ? Array.from(box.querySelectorAll<HTMLElement>(".ksel-opt")) : []);
  const highlight = (i: number): void => {
    hi = i; rows().forEach((r, k) => r.classList.toggle("hi", k === i));
    const r = rows()[i];
    if (r && box) { if (r.offsetTop < box.scrollTop) box.scrollTop = r.offsetTop; else if (r.offsetTop + r.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = r.offsetTop + r.offsetHeight - box.clientHeight; input.setAttribute("aria-activedescendant", r.id); }
  };
  // FILTER_COMBOPOPUP::Accept: the picked entry goes into the entry; nothing picked changes nothing
  const take = (i: number): void => {
    const v = list[i]; close(); input.focus(); if (v === undefined || (filtered && !v)) return;
    if (filtered && v === input.value) return;
    input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  function close(): void {
    if (!pop) return;
    pop.remove(); pop = null; box = null; filt = null; undo.forEach((f) => f()); undo = []; el.removeAttribute("data-popup-open"); input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  }
  const fillRows = (): void => {
    if (!box || !pop) return;
    box.replaceChildren(...list.map((t, i) => { const r = document.createElement("div"); r.className = "ksel-opt" + (t === input.value ? " on" : ""); r.dataset.i = String(i); r.id = pop!.id + "-" + i; r.setAttribute("role", "option"); r.textContent = t; return r; }));
  };
  // FILTER_COMBOPOPUP::getListContent: a case-insensitive substring of the filter text
  const applyFilter = (): void => {
    let f = filt ? filt.value : "";
    if (f.startsWith("::")) f = f.slice(2);   // "::" leaves out the italic entries (none are styled here)
    const q = f.toLowerCase();
    list = q ? all.filter((s) => s.toLowerCase().includes(q)) : all.slice();
    fillRows(); place();
    highlight(list.length ? 0 : -1);   // onFilterEdit: the first entry is picked
  };
  // under the whole control (entry and button), above it when there is more room there
  function place(): void {
    const p = pop; if (!p) return;
    p.style.maxHeight = ""; if (box && filtered) box.style.maxHeight = "";
    const r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, M = 4;
    p.style.minWidth = r.width + "px"; p.style.maxWidth = Math.max(160, vw - 2 * M) + "px";
    const want = p.scrollHeight + 2, below = vh - r.bottom - M - 2, above = r.top - M - 2, up = want > below && above > below;
    const h = Math.min(want, Math.max(80, up ? above : below), Math.round(vh * 0.7));
    p.style.maxHeight = h + "px"; p.style.top = (up ? Math.max(M, r.top - 2 - h) : Math.min(r.bottom + 2, vh - M - h)) + "px";
    p.style.left = Math.max(M, Math.min(r.left, vw - M - p.offsetWidth)) + "px";
    if (box && filtered) box.style.maxHeight = Math.max(20, h - (box.offsetTop - p.clientTop) - 4) + "px";
  }
  function open(): void {
    if (pop || input.disabled || !all.length) return;
    const p = document.createElement("div"); p.className = "ksel-pop" + (filtered ? " kcombo-pop" : ""); p.id = "kcombo-pop-" + ++seq;
    p.setAttribute("data-popup-open", "");   // the filter entry has the keyboard: a dialog leaves its Escape to the popup
    const cs = getComputedStyle(input); p.style.font = cs.font; p.style.fontSize = cs.fontSize;
    pop = p; list = all.slice();
    if (filtered) {
      // FILTER_COMBOPOPUP::Create: a "Filter:" label, the filter entry, then the list
      const lab = document.createElement("div"); lab.className = "kcombo-flabel"; lab.textContent = "Filter:"; lab.id = p.id + "-fl";
      const f = document.createElement("input"); f.className = "input kcombo-filter"; f.autocomplete = "off"; f.spellcheck = false; f.setAttribute("aria-labelledby", lab.id); f.setAttribute("aria-controls", p.id + "-list");
      const b = document.createElement("div"); b.className = "kcombo-list"; b.id = p.id + "-list"; b.setAttribute("role", "listbox");
      p.append(lab, f, b); box = b; filt = f;
      // m_filterValidator: wxFILTER_EXCLUDE_CHAR_LIST " "
      f.addEventListener("beforeinput", (ev) => { const d = (ev as InputEvent).data; if (d && d.includes(" ")) ev.preventDefault(); });
      f.addEventListener("input", () => { if (f.value.includes(" ")) f.value = f.value.replace(/ /g, ""); applyFilter(); });
      f.addEventListener("keydown", popKey);
      f.addEventListener("blur", () => { setTimeout(() => { if (pop && !el.contains(document.activeElement) && !p.contains(document.activeElement)) close(); }, 0); });
    } else { p.setAttribute("role", "listbox"); box = p; }
    fillRows();
    p.addEventListener("pointerdown", (ev) => { if (ev.target !== filt) ev.preventDefault(); });   // the entry (or the filter) keeps the keyboard focus
    p.addEventListener("pointermove", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (r) highlight(+r.dataset.i!); });
    p.addEventListener("click", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (r) take(+r.dataset.i!); });
    document.body.append(p);
    place();
    menuScroller(box, { combo: true });
    // OnPopup: the filter is cleared and takes the focus; the current value is the picked entry
    const cur = list.indexOf(input.value);
    highlight(filtered ? cur : Math.max(0, cur));
    if (filt) filt.focus();
    const away = (ev: Event): void => { const t = ev.target as Node; if (!el.contains(t) && !p.contains(t)) close(); };
    const scroll = (ev: Event): void => { if (!p.contains(ev.target as Node)) close(); };
    document.addEventListener("pointerdown", away, true); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", close); window.addEventListener("blur", close);
    undo = [() => document.removeEventListener("pointerdown", away, true), () => window.removeEventListener("scroll", scroll, true), () => window.removeEventListener("resize", close), () => window.removeEventListener("blur", close)];
    el.setAttribute("data-popup-open", ""); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", filtered ? p.id + "-list" : p.id);
  }
  /** The next (or previous) control of the dialog after the combo: FILTER_COMBOPOPUP's Tab navigates on. */
  const tabOn = (back: boolean): void => {
    const scope = el.closest(".kd-dialog") || document.body;
    const all = Array.from(scope.querySelectorAll<HTMLElement>("input,textarea,button,k-select,[tabindex]")).filter((x) => x === input || (x.tabIndex >= 0 && !(x as HTMLInputElement).disabled && x.offsetParent !== null && !el.contains(x)));
    const i = all.indexOf(input), next = all[i + (back ? -1 : 1)];
    if (next) next.focus(); else input.focus();
  };
  // FILTER_COMBOPOPUP::onKeyDown, and the entry's keys while the list is up
  function popKey(ev: KeyboardEvent): void {
    if (!pop) return;
    if (ev.ctrlKey || ev.metaKey) return;
    const n = list.length;
    if (ev.key === "ArrowDown") { ev.preventDefault(); highlight(Math.min(n - 1, hi + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); highlight(Math.max(0, hi - 1)); }
    else if (!filtered && ev.key === "Home" && ev.altKey) { ev.preventDefault(); highlight(0); }
    else if (!filtered && ev.key === "End" && ev.altKey) { ev.preventDefault(); highlight(n - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); take(hi); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); input.focus(); }
    else if (ev.key === "Tab") { if (filtered) { ev.preventDefault(); close(); tabOn(ev.shiftKey); } else close(); }
  }
  btn.addEventListener("pointerdown", (ev) => ev.preventDefault());
  btn.addEventListener("click", () => { if (pop) { close(); input.focus(); } else { input.focus(); open(); } });
  input.addEventListener("keydown", (ev) => {
    if (!pop) { if (ev.key === "ArrowDown" && (ev.altKey || !ev.ctrlKey)) { if (all.length) { ev.preventDefault(); open(); } } return; }
    popKey(ev);
  });
  input.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== input && !(pop && pop.contains(document.activeElement))) close(); }, 0); });
  return { el, input, setOptions(next) { all = filtered ? sorted(next) : next.slice(); list = all.slice(); sync(); if (pop) { close(); open(); } }, open, close, isOpen: () => !!pop };
}
