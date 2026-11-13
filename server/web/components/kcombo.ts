// components/kcombo.ts — an editable combo box (wxComboBox): a text entry with a drop-down button whose list puts an
// entry's text into the entry.  The list is the themed popup <k-select> uses (.ksel-pop / .ksel-opt in theme.css),
// placed under the control and kept on screen with menufit.ts, never the browser's own <datalist> popup.
//
//   mouse      the button opens and closes the list; a click on an entry takes it; a click elsewhere or a scroll closes
//   keyboard   Alt+Down / Down in the entry open the list; Up, Down, Home, End move; Enter takes the highlighted entry;
//              Escape and Tab close (the host carries data-popup-open while the list is up, so dialogs leave Escape)
import { menuScroller } from "../menufit";

export interface KCombo { el: HTMLElement; input: HTMLInputElement; setOptions(list: string[]): void; open(): void; close(): void; isOpen(): boolean }

const CARET = '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 2.5h6L4 6z" fill="currentColor"/></svg>';
let seq = 0;

/** Wrap `input` (already built by the dialog) into a combo box offering `options`. */
export function comboBox(input: HTMLInputElement, options: string[]): KCombo {
  let list = options.slice(), pop: HTMLElement | null = null, hi = -1, undo: (() => void)[] = [];
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn kcombo-btn"; btn.tabIndex = -1; btn.innerHTML = CARET;
  btn.setAttribute("aria-label", "Show the list"); btn.style.cssText = "padding:0 5px;flex:none;align-self:stretch;display:flex;align-items:center";
  const el = document.createElement("span"); el.className = "kcombo"; el.style.cssText = "display:flex;gap:2px;align-items:stretch;min-width:0;width:100%";
  input.style.flex = "1"; input.style.minWidth = "0"; input.autocomplete = "off"; input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "false");
  input.replaceWith(el); el.append(input, btn);
  const sync = (): void => { btn.disabled = input.disabled || !list.length; };
  sync();
  const rows = (): HTMLElement[] => (pop ? Array.from(pop.querySelectorAll<HTMLElement>(".ksel-opt")) : []);
  const highlight = (i: number): void => {
    hi = i; rows().forEach((r, k) => r.classList.toggle("hi", k === i));
    const r = rows()[i]; if (r && pop) { if (r.offsetTop < pop.scrollTop) pop.scrollTop = r.offsetTop; else if (r.offsetTop + r.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = r.offsetTop + r.offsetHeight - pop.clientHeight; input.setAttribute("aria-activedescendant", r.id); }
  };
  const take = (i: number): void => {
    const v = list[i]; close(); if (v === undefined) return;
    input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); input.focus();
  };
  function close(): void {
    if (!pop) return;
    pop.remove(); pop = null; undo.forEach((f) => f()); undo = []; el.removeAttribute("data-popup-open"); input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  }
  function open(): void {
    if (pop || input.disabled || !list.length) return;
    const p = document.createElement("div"); p.className = "ksel-pop"; p.setAttribute("role", "listbox"); p.id = "kcombo-pop-" + ++seq;
    const cs = getComputedStyle(input); p.style.font = cs.font; p.style.fontSize = cs.fontSize;
    p.append(...list.map((t, i) => { const r = document.createElement("div"); r.className = "ksel-opt" + (t === input.value ? " on" : ""); r.dataset.i = String(i); r.id = p.id + "-" + i; r.setAttribute("role", "option"); r.textContent = t; return r; }));
    p.addEventListener("pointerdown", (ev) => ev.preventDefault());   // the entry keeps the keyboard focus
    p.addEventListener("pointermove", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (r) highlight(+r.dataset.i!); });
    p.addEventListener("click", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (r) take(+r.dataset.i!); });
    document.body.append(p); pop = p;
    // under the whole control (entry and button), above it when there is more room there
    const r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, M = 4;
    p.style.minWidth = r.width + "px"; p.style.maxWidth = Math.max(160, vw - 2 * M) + "px";
    const want = p.scrollHeight + 2, below = vh - r.bottom - M - 2, above = r.top - M - 2, up = want > below && above > below;
    const h = Math.min(want, Math.max(80, up ? above : below), Math.round(vh * 0.7));
    p.style.maxHeight = h + "px"; p.style.top = (up ? Math.max(M, r.top - 2 - h) : Math.min(r.bottom + 2, vh - M - h)) + "px";
    p.style.left = Math.max(M, Math.min(r.left, vw - M - p.offsetWidth)) + "px";
    menuScroller(p, { combo: true });
    highlight(Math.max(0, list.indexOf(input.value)));
    const away = (ev: Event): void => { const t = ev.target as Node; if (!el.contains(t) && !p.contains(t)) close(); };
    const scroll = (ev: Event): void => { if (!p.contains(ev.target as Node)) close(); };
    document.addEventListener("pointerdown", away, true); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", close); window.addEventListener("blur", close);
    undo = [() => document.removeEventListener("pointerdown", away, true), () => window.removeEventListener("scroll", scroll, true), () => window.removeEventListener("resize", close), () => window.removeEventListener("blur", close)];
    el.setAttribute("data-popup-open", ""); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", p.id);
  }
  btn.addEventListener("pointerdown", (ev) => ev.preventDefault());
  btn.addEventListener("click", () => { if (pop) close(); else { input.focus(); open(); } });
  input.addEventListener("keydown", (ev) => {
    if (!pop) { if (ev.key === "ArrowDown" && (ev.altKey || !ev.ctrlKey)) { if (list.length) { ev.preventDefault(); open(); } } return; }
    const n = list.length;
    if (ev.key === "ArrowDown") { ev.preventDefault(); highlight(Math.min(n - 1, hi + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); highlight(Math.max(0, hi - 1)); }
    else if (ev.key === "Home" && ev.altKey) { ev.preventDefault(); highlight(0); }
    else if (ev.key === "End" && ev.altKey) { ev.preventDefault(); highlight(n - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); take(hi); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
    else if (ev.key === "Tab") close();
  });
  input.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== input) close(); }, 0); });
  return { el, input, setOptions(next) { list = next.slice(); sync(); if (pop) { close(); open(); } }, open, close, isOpen: () => !!pop };
}
