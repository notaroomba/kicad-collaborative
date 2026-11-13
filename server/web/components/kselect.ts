// components/kselect.ts — the themed drop-down every part of the editor uses instead of the browser's <select>.
//
// A native <select> opens the operating system's own popup (a macOS menu, a GTK list), which ignores the theme and
// gets clipped or misplaced in panes.  <k-select> keeps the <select> programming model — <option> children, `value`,
// `selectedIndex`, `options`, `disabled`, `size`, and bubbling `input` / `change` events — so the dialogs build it
// with the same code, but it draws its own closed control (in a shadow root) and its own list (a fixed popup on
// <body>, so no pane or dialog clips it).  The colours come from theme.css (`k-select`, `.ksel-pop`).
//
//   mouse      click opens, click an entry picks it, click outside or scroll closes; press on the control, drag onto
//              an entry and release picks it (as a native select does)
//   labels     the host's aria-label / title / aria-labelledby and any <label for=id> name the inner combobox or
//              listbox, and a click on such a label focuses the control
//   open       while the list is up the host carries data-popup-open, so dialogs leave the first Escape to it
//   keyboard   Space / Alt+Down / Up / Down open; in the list Up, Down, Home, End, PageUp, PageDown move, Enter picks,
//              Escape and Tab close; typing jumps to the first entry that starts with the typed text
//   separator  a disabled option whose text is "---" (how wxChoice lists are filled) or that has data-sep is a rule
//   listbox    size > 1 draws the list in place, like a wxListBox: click or arrows pick, double-click bubbles
//
// Each bundle that builds a select imports this file; the first one to load defines the element.

import { menuArrowPad, menuScroller } from "../menufit";

export const KSELECT_TAG = "k-select";

/** The element, typed as the <select> it stands in for. */
export function createSelect(): HTMLSelectElement { defineKSelect(); return document.createElement(KSELECT_TAG) as HTMLSelectElement; }

/** True for a <k-select> (or a native select): where key handlers must leave the keyboard alone. */
export function isSelectLike(el: Element | null | undefined): boolean { return !!el && (el.tagName === "K-SELECT" || el.tagName === "SELECT"); }

const SHADOW_CSS = `
:host { contain: layout style; }
.b { display: flex; align-items: center; gap: 4px; width: 100%; height: 100%; min-width: 0; outline: 0; cursor: default; }
.t { flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: minmax(0, max-content); text-align: left; }
.t > * { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sz { visibility: hidden; height: 0; display: flex; flex-direction: column; }
.sz > span { white-space: nowrap; }
.c { flex: none; width: 8px; height: 8px; color: var(--ink-2); }
.lb { flex: 1; min-height: 0; overflow-y: auto; outline: 0; padding: 1px 0; }
.r { padding: 1px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.r.on { background: var(--sel); }
.lb:focus .r.on { background: var(--accent); color: var(--on-accent); }
.r.dis { color: var(--ink-3); }
.r.sep { height: 1px; padding: 0; margin: 3px 4px; background: var(--line); }
.r.hd { color: var(--ink-2); font-weight: 600; }
`;
const CARET = '<svg class="c" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 2.5h6L4 6z" fill="currentColor"/></svg>';

type OptionList = HTMLOptionElement[] & { item(i: number): HTMLOptionElement | null; namedItem(name: string): HTMLOptionElement | null };

let popSeq = 0;
let openOne: { close(): void } | null = null;

export function defineKSelect(): void {
  if (typeof window === "undefined" || typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(KSELECT_TAG)) return;

  class KSelect extends HTMLElement {
    static get observedAttributes(): string[] { return ["disabled", "size", "aria-label", "aria-labelledby", "title", "id"]; }
    private root: ShadowRoot;
    private btn: HTMLElement | null = null;
    private label: HTMLElement | null = null;
    private sizer: HTMLElement | null = null;
    private sizedFor = "";
    private lb: HTMLElement | null = null;
    private pop: HTMLElement | null = null;
    private hi = -1;
    private none = -1;             // value set to something no option has: nothing selected (until the options change: the option count then)
    private typed = ""; private typedAt = 0;
    private mo: MutationObserver;
    private undo: (() => void)[] = [];
    /** where a press on the closed control opened the list: a release over an entry after a drag picks it */
    private press: { x: number; y: number; moved: boolean } | null = null;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open", delegatesFocus: true });
      this.mo = new MutationObserver(() => this.sync());
    }
    connectedCallback(): void {
      // a property set before the element was upgraded (innerHTML in a detached node) shadows the accessors: re-apply it
      for (const k of ["value", "selectedIndex", "disabled"] as const) {
        if (Object.prototype.hasOwnProperty.call(this, k)) { const v = (this as unknown as Record<string, unknown>)[k]; delete (this as unknown as Record<string, unknown>)[k]; (this as unknown as Record<string, unknown>)[k] = v; }
      }
      if (!this.btn && !this.lb) this.build();
      // a <label for> in the same tree may be added after the control: name it once the frame has settled too
      requestAnimationFrame(() => this.name_());
      this.mo.observe(this, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["selected", "disabled", "label", "value", "data-sep"] });
      this.sync();
    }
    disconnectedCallback(): void { this.mo.disconnect(); this.close(); }
    attributeChangedCallback(name: string): void { if (name === "size") { if (this.btn || this.lb) this.build(); } else if (name === "disabled") this.sync(); else this.name_(); }
    /**
     * The accessible name of the inner combobox / listbox: an id reference cannot cross the shadow boundary, so the
     * name is copied as text from aria-label, aria-labelledby's elements, a <label for=id>, or the title.
     */
    private name_(): void {
      const inner = this.btn || this.lb; if (!inner) return;
      let name = this.getAttribute("aria-label") || "";
      if (!name) { const ids = (this.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean); name = ids.map((i) => { const e = document.getElementById(i); return e ? (e.textContent || "").trim() : ""; }).filter(Boolean).join(" "); }
      if (!name && this.id) { const l = this.ownerDocument.querySelector(`label[for="${CSS.escape(this.id)}"]`); if (l) name = (l.textContent || "").trim().replace(/:$/, ""); }
      if (!name) name = this.getAttribute("title") || "";
      if (name) inner.setAttribute("aria-label", name); else inner.removeAttribute("aria-label");
      const t = this.getAttribute("title"); if (t) inner.setAttribute("title", t); else inner.removeAttribute("title");
    }

    // ------------------------------------------------------------ the <select> API
    get options(): OptionList {
      const a = Array.from(this.querySelectorAll("option")) as OptionList;
      a.item = (i) => a[i] || null; a.namedItem = (n) => a.find((o) => o.id === n || o.getAttribute("name") === n) || null;
      return a;
    }
    get length(): number { return this.querySelectorAll("option").length; }
    get type(): string { return "select-one"; }
    get selectedOptions(): HTMLOptionElement[] { const s = this.current(); return s ? [s] : []; }
    get selectedIndex(): number { const s = this.current(); return s ? this.options.indexOf(s) : -1; }
    set selectedIndex(i: number) { const os = this.options; os.forEach((o, k) => { o.selected = k === i; }); this.none = i >= 0 && i < os.length ? -1 : os.length; this.sync(); }
    get value(): string { const s = this.current(); return s ? s.value : ""; }
    set value(v: string) {
      const os = this.options, want = String(v); const hit = os.find((o) => o.value === want) || null;
      for (const o of os) o.selected = o === hit;
      this.none = hit ? -1 : os.length; this.sync();
    }
    get disabled(): boolean { return this.hasAttribute("disabled"); }
    set disabled(on: boolean) { this.toggleAttribute("disabled", !!on); }
    get size(): number { return Math.max(0, parseInt(this.getAttribute("size") || "0", 10) || 0); }
    set size(n: number) { this.setAttribute("size", String(n)); }
    get name(): string { return this.getAttribute("name") || ""; }
    set name(n: string) { this.setAttribute("name", n); }
    item(i: number): HTMLOptionElement | null { return this.options[i] || null; }
    add(o: HTMLOptionElement, before?: HTMLElement | number | null): void {
      const ref = typeof before === "number" ? this.options[before] || null : before || null;
      if (ref && ref.parentNode) ref.parentNode.insertBefore(o, ref); else this.appendChild(o);
    }
    override remove(index?: number): void {
      if (typeof index === "number") { const o = this.options[index]; if (o) o.remove(); return; }
      super.remove();
    }
    override blur(): void { const a = this.root.activeElement as HTMLElement | null; if (a) a.blur(); super.blur(); }
    checkValidity(): boolean { return true; }

    // ------------------------------------------------------------ drawing
    private listMode(): boolean { return this.size > 1; }
    private isSep(o: HTMLOptionElement): boolean { return o.hasAttribute("data-sep") || (o.disabled && (o.textContent || "").trim() === "---"); }
    private pickable(o: HTMLOptionElement | undefined): boolean { return !!o && !o.disabled && !(o.parentElement && o.parentElement.tagName === "OPTGROUP" && (o.parentElement as HTMLOptGroupElement).disabled); }
    private current(): HTMLOptionElement | null {
      const os = this.options; let s: HTMLOptionElement | null = null;
      for (const o of os) if (o.selected) s = o;
      if (!s && this.none !== os.length && !this.listMode()) s = os.find((o) => this.pickable(o)) || null;   // a single-line select always shows one
      return s;
    }
    private build(): void {
      this.close();
      this.root.innerHTML = "";
      const st = document.createElement("style"); st.textContent = SHADOW_CSS; this.root.append(st);
      if (this.listMode()) {
        this.btn = this.label = null;
        const lb = document.createElement("div"); lb.className = "lb"; lb.setAttribute("role", "listbox"); lb.tabIndex = 0; this.lb = lb;
        lb.addEventListener("pointerdown", (ev) => { const r = (ev.target as HTMLElement).closest(".r") as HTMLElement | null; if (r && !this.disabled) { const i = +r.dataset.i!; if (this.pickable(this.options[i])) this.choose(i); } });
        lb.addEventListener("keydown", (ev) => this.listKey(ev));
        this.root.append(lb);
      } else {
        this.lb = null;
        const b = document.createElement("div"); b.className = "b"; b.setAttribute("role", "combobox"); b.setAttribute("aria-haspopup", "listbox"); b.setAttribute("aria-expanded", "false"); b.tabIndex = 0;
        // like a native select (and a wxChoice) the control is as wide as its longest entry: the hidden .sz column sizes it
        b.innerHTML = `<span class="t"><span class="v"></span><span class="sz" aria-hidden="true"></span></span>${CARET}`; this.btn = b; this.label = b.querySelector(".v"); this.sizer = b.querySelector(".sz"); this.sizedFor = "\u0002";
        b.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0 || this.disabled) return; ev.preventDefault(); b.focus();
          if (this.pop) { this.close(); return; }
          this.open(); this.press = { x: ev.clientX, y: ev.clientY, moved: false };
        });
        b.addEventListener("keydown", (ev) => this.buttonKey(ev));
        b.addEventListener("blur", () => { if (this.pop) this.close(); });
        this.root.append(b);
      }
      this.name_();
      this.sync();
    }
    /** Bring the closed control (or the in-place list) up to date with the options and the selection. */
    sync(): void {
      const dis = this.disabled;
      if (this.btn) {
        this.btn.tabIndex = dis ? -1 : 0; this.btn.setAttribute("aria-disabled", dis ? "true" : "false");
        const os = this.options, s = this.current(); if (this.label) this.label.textContent = s ? s.label || s.text : "";
        const all = os.filter((o) => !this.isSep(o)).map((o) => o.label || o.text), key = all.join("\u0001");
        if (this.sizer && key !== this.sizedFor) { this.sizedFor = key; this.sizer.replaceChildren(...all.map((t) => { const e = document.createElement("span"); e.textContent = t; return e; })); }
        if (this.pop) this.fillPop();
      } else if (this.lb) {
        this.lb.tabIndex = dis ? -1 : 0;
        const os = this.options, s = this.current();
        this.lb.replaceChildren(...os.flatMap((o, i) => {
          const r = document.createElement("div"); r.dataset.i = String(i); r.setAttribute("role", "option");
          const hd = this.head(o, os[i - 1], "r hd");
          if (this.isSep(o)) { r.className = "r sep"; return hd ? [hd, r] : [r]; }
          r.className = "r" + (o === s ? " on" : "") + (this.pickable(o) ? "" : " dis"); r.textContent = o.label || o.text; r.setAttribute("aria-selected", o === s ? "true" : "false");
          return hd ? [hd, r] : [r];
        }));
        if (!this.style.height) this.lb.style.minHeight = `calc(${this.size} * 1.45em + 2px)`;
        const on = this.lb.querySelector(".on") as HTMLElement | null; if (on) this.scrollRow(this.lb, on);
      }
    }
    /** An <optgroup> caption row before the first option of each group, as the browser draws them. */
    private head(o: HTMLOptionElement, prev: HTMLOptionElement | undefined, cls: string): HTMLElement | null {
      const g = o.parentElement; if (!g || g.tagName !== "OPTGROUP" || (prev && prev.parentElement === g)) return null;
      const r = document.createElement("div"); r.className = cls; r.setAttribute("role", "presentation"); r.textContent = (g as HTMLOptGroupElement).label; return r;
    }
    /** Scrolls the row into the visible part of the list: clear of the arrow strips of a list cut on a Mac (menufit.ts). */
    private scrollRow(box: HTMLElement, row: HTMLElement): void {
      const pad = menuArrowPad(box);
      if (row.offsetTop - pad < box.scrollTop) box.scrollTop = Math.max(0, row.offsetTop - pad);
      else if (row.offsetTop + row.offsetHeight + pad > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight + pad - box.clientHeight;
    }

    // ------------------------------------------------------------ the popup list
    private open(): void {
      if (this.pop || this.disabled || !this.btn) return;
      if (openOne) openOne.close();
      const pop = document.createElement("div"); pop.className = "ksel-pop"; pop.setAttribute("role", "listbox"); pop.id = "ksel-pop-" + ++popSeq;
      const cs = getComputedStyle(this); pop.style.font = cs.font; pop.style.fontSize = cs.fontSize;
      this.pop = pop; this.hi = this.selectedIndex;
      pop.addEventListener("pointerdown", (ev) => ev.preventDefault());   // keep the keyboard focus on the control
      pop.addEventListener("pointermove", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (r && !r.classList.contains("dis")) this.highlight(+r.dataset.i!, false); });
      pop.addEventListener("click", (ev) => { const r = (ev.target as HTMLElement).closest(".ksel-opt") as HTMLElement | null; if (!r || r.classList.contains("dis")) return; this.close(); this.choose(+r.dataset.i!); });
      document.body.append(pop); this.fillPop(); this.place();
      this.btn.setAttribute("aria-expanded", "true"); this.btn.setAttribute("aria-controls", pop.id);
      const away = (ev: Event): void => { const t = ev.target as Node; if (t !== this && !this.contains(t) && !pop.contains(t)) this.close(); };
      const scroll = (ev: Event): void => { if (!pop.contains(ev.target as Node)) this.close(); };
      const shut = (): void => this.close();
      // press, drag onto an entry, release: the entry is picked (a press and release in place leaves the list open)
      const rowAt = (ev: PointerEvent): HTMLElement | null => { const e = document.elementFromPoint(ev.clientX, ev.clientY); const r = e && pop.contains(e) ? (e.closest(".ksel-opt") as HTMLElement | null) : null; return r && !r.classList.contains("dis") ? r : null; };
      const drag = (ev: PointerEvent): void => {
        const p = this.press; if (!p) return;
        if (!p.moved && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 4) p.moved = true;
        const r = p.moved ? rowAt(ev) : null; if (r) this.highlight(+r.dataset.i!, false);
      };
      const release = (ev: PointerEvent): void => {
        const p = this.press; this.press = null; if (!p || !p.moved) return;
        const r = rowAt(ev); if (r) { ev.preventDefault(); const i = +r.dataset.i!; this.close(); this.choose(i); }
      };
      document.addEventListener("pointerdown", away, true); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", shut); window.addEventListener("blur", shut);
      document.addEventListener("pointermove", drag, true); document.addEventListener("pointerup", release, true);
      this.undo = [() => document.removeEventListener("pointerdown", away, true), () => window.removeEventListener("scroll", scroll, true), () => window.removeEventListener("resize", shut), () => window.removeEventListener("blur", shut),
        () => document.removeEventListener("pointermove", drag, true), () => document.removeEventListener("pointerup", release, true)];
      this.setAttribute("data-popup-open", "");
      openOne = this;
    }
    close(): void {
      if (!this.pop) return;
      this.pop.remove(); this.pop = null; this.undo.forEach((f) => f()); this.undo = []; this.press = null;
      this.removeAttribute("data-popup-open");
      if (this.btn) { this.btn.setAttribute("aria-expanded", "false"); this.btn.removeAttribute("aria-activedescendant"); }
      if (openOne === this) openOne = null;
    }
    private fillPop(): void {
      const pop = this.pop; if (!pop) return;
      const os = this.options, s = this.current();
      pop.replaceChildren(...os.flatMap((o, i) => {
        const hd = this.head(o, os[i - 1], "ksel-head");
        if (this.isSep(o)) { const r = document.createElement("div"); r.className = "ksel-sep"; r.setAttribute("role", "separator"); return hd ? [hd, r] : [r]; }
        const r = document.createElement("div"); r.className = "ksel-opt" + (o === s ? " on" : "") + (i === this.hi ? " hi" : "") + (this.pickable(o) ? "" : " dis");
        r.dataset.i = String(i); r.id = pop.id + "-" + i; r.setAttribute("role", "option"); r.setAttribute("aria-selected", o === s ? "true" : "false");
        r.textContent = o.label || o.text; if (o.title) r.title = o.title;
        if (o.parentElement && o.parentElement.tagName === "OPTGROUP") r.classList.add("ind");
        return hd ? [hd, r] : [r];
      }));
    }
    private place(): void {
      const pop = this.pop; if (!pop) return;
      const r = this.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, M = 4;
      pop.style.minWidth = r.width + "px"; pop.style.maxWidth = Math.max(160, vw - 2 * M) + "px";
      pop.style.maxHeight = ""; const want = pop.scrollHeight + 2;
      const below = vh - r.bottom - M - 2, above = r.top - M - 2;
      const up = want > below && above > below;
      const room = Math.max(80, up ? above : below), h = Math.min(want, room, Math.round(vh * 0.7));
      pop.style.maxHeight = h + "px";
      pop.style.top = (up ? Math.max(M, r.top - 2 - h) : Math.min(r.bottom + 2, vh - M - h)) + "px";
      const w = pop.offsetWidth; pop.style.left = Math.max(M, Math.min(r.left, vw - M - w)) + "px";
      menuScroller(pop, { combo: true });
      const row = pop.querySelector(".hi, .on") as HTMLElement | null; if (row) this.scrollRow(pop, row);
    }
    private highlight(i: number, scroll = true): void {
      this.hi = i; const pop = this.pop; if (!pop) return;
      pop.querySelectorAll(".hi").forEach((e) => e.classList.remove("hi"));
      const row = pop.querySelector(`[data-i="${i}"]`) as HTMLElement | null;
      if (row) { row.classList.add("hi"); if (scroll) this.scrollRow(pop, row); if (this.btn) this.btn.setAttribute("aria-activedescendant", row.id); }
    }
    /** The next pickable entry from `from` going `dir` (±1), `count` steps at most; the last one reached when the end is hit. */
    private step(from: number, dir: number, count = 1): number {
      const os = this.options; let i = from, got = from, n = 0;
      while (n < count) { i += dir; if (i < 0 || i >= os.length) break; if (this.pickable(os[i]) && !this.isSep(os[i])) { got = i; n++; } }
      return got;
    }
    private edge(first: boolean): number { const os = this.options; return first ? this.step(-1, 1) : this.step(os.length, -1); }
    private typeAhead(ch: string, from: number): number {
      const now = Date.now(); this.typed = now - this.typedAt > 800 ? ch : this.typed + ch; this.typedAt = now;
      const os = this.options, q = this.typed.toLowerCase(), repeat = this.typed.length > 1 && [...this.typed].every((c) => c === this.typed[0]);
      const needle = repeat ? q[0] : q, start = this.typed.length === 1 || repeat ? from + 1 : from;
      for (let k = 0; k < os.length; k++) {
        const i = (Math.max(0, start) + k) % os.length, o = os[i];
        if (this.pickable(o) && !this.isSep(o) && (o.label || o.text).trim().toLowerCase().startsWith(needle)) return i;
      }
      return -1;
    }
    private choose(i: number): void {
      const os = this.options, o = os[i]; if (!o || !this.pickable(o)) return;
      const before = this.current(); for (const x of os) x.selected = x === o; this.none = -1; this.sync();
      if (before !== o) { this.dispatchEvent(new Event("input", { bubbles: true, composed: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    private buttonKey(ev: KeyboardEvent): void {
      if (this.disabled) return;
      const k = ev.key, eat = (): void => { ev.preventDefault(); ev.stopPropagation(); };
      if (!this.pop) {
        if (k === " " || k === "ArrowDown" || k === "ArrowUp" || k === "F4" || (k === "ArrowDown" && ev.altKey)) { eat(); this.open(); return; }
        if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { eat(); this.open(); const i = this.typeAhead(k, this.selectedIndex); if (i >= 0) this.highlight(i); return; }
        return;   // Enter, Escape and Tab keep their meaning for the dialog or toolbar around the control
      }
      if (k === "Tab") { this.close(); return; }
      eat();
      const os = this.options, cur = this.hi >= 0 ? this.hi : this.selectedIndex;
      if (k === "Escape" || (k === "ArrowUp" && ev.altKey)) this.close();
      else if (k === "Enter" || (k === " " && Date.now() - this.typedAt > 800)) { const i = this.hi; this.close(); if (i >= 0) this.choose(i); }
      else if (k === "ArrowDown") this.highlight(cur < 0 ? this.edge(true) : this.step(cur, 1));
      else if (k === "ArrowUp") this.highlight(cur < 0 ? this.edge(false) : this.step(cur, -1));
      else if (k === "Home") this.highlight(this.edge(true));
      else if (k === "End") this.highlight(this.edge(false));
      else if (k === "PageDown") this.highlight(this.step(Math.max(cur, -1), 1, 10));
      else if (k === "PageUp") this.highlight(this.step(cur < 0 ? os.length : cur, -1, 10));
      else if (k.length === 1 && !ev.ctrlKey && !ev.metaKey) { const i = this.typeAhead(k, cur); if (i >= 0) this.highlight(i); }
    }
    private listKey(ev: KeyboardEvent): void {
      if (this.disabled || ev.altKey || ev.ctrlKey || ev.metaKey) return;   // Alt+Up/Down belong to the dialog (move a row)
      const k = ev.key, cur = this.selectedIndex, os = this.options; let to = -2;
      if (k === "ArrowDown") to = cur < 0 ? this.edge(true) : this.step(cur, 1);
      else if (k === "ArrowUp") to = cur < 0 ? this.edge(false) : this.step(cur, -1);
      else if (k === "Home") to = this.edge(true);
      else if (k === "End") to = this.edge(false);
      else if (k === "PageDown") to = this.step(Math.max(cur, -1), 1, 10);
      else if (k === "PageUp") to = this.step(cur < 0 ? os.length : cur, -1, 10);
      else if (k.length === 1 && k !== " ") to = this.typeAhead(k, cur);
      if (to === -2) return;   // Enter, Escape, Tab: the dialog's
      ev.preventDefault(); ev.stopPropagation();
      if (to >= 0) this.choose(to);
    }
  }
  customElements.define(KSELECT_TAG, KSelect);
  // <label for=id> focuses (and does not otherwise act on) the control it names, as it does a native <select>: a
  // custom element is not labelable, so the browser would do nothing
  document.addEventListener("click", (ev) => {
    const l = ev.target instanceof Element ? (ev.target.closest("label") as HTMLLabelElement | null) : null; if (!l || !l.htmlFor) return;
    const t = (l.getRootNode() as Document | ShadowRoot).getElementById?.(l.htmlFor) || document.getElementById(l.htmlFor);
    if (t && t.tagName === "K-SELECT" && !(t as HTMLSelectElement).disabled) { ev.preventDefault(); (t as HTMLElement).focus(); }
  });
}

defineKSelect();
