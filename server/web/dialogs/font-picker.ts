// dialogs/font-picker.ts — the font choice of the text, label, field and table dialogs (KiCad's FONT_CHOICE: an
// owner-drawn combo box that filters as you type and draws each name in its own font).
//
// What it offers: KiCad Font, the fonts this project already uses or holds, and every Google Font (the list is
// /api/fonts/catalog).  Choosing one only writes its name into (font (face "…")); the file itself is fetched from
// the server when the text is drawn (web/editor/fonts.ts), for everybody who opens the project.
//
// The element behaves like the <select> it replaces: `value`, `disabled`, and a "change" event.

import { h } from "./dom";

export const KICAD_FONT = "KiCad Font";

export interface GoogleFamily { family: string; category: string; license: string }
export type FontPickerEl = HTMLDivElement & { value: string; disabled: boolean };
export interface FontPickerOpts {
  id?: string; style?: string; disabled?: boolean; key?: string;
  /** Entries above KiCad Font: [value, label] (the "leave unchanged" / "mixed" / "Default Font" choices). */
  extra?: [string, string][];
  /** The value that stands for KiCad's stroke font ("KiCad Font" in schematics, "" on boards). */
  kicadValue?: string;
}

// ---- data: the project being edited, the Google list, the project's own fonts ----

let projectId: string | null = null;
let catalogReq: Promise<GoogleFamily[]> | null = null;
let catalogNow: GoogleFamily[] | null = null;
let projectReq: Promise<string[]> | null = null;

/** The project whose fonts the pickers list (set by the editor when a project opens). */
export function setFontProject(id: string | null): void { if (id !== projectId) { projectId = id; projectReq = null; } }
export function fontProject(): string | null { return projectId; }

export function googleFonts(): Promise<GoogleFamily[]> {
  if (!catalogReq) {
    catalogReq = fetch("/api/fonts/catalog", { credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error("catalog " + r.status); return r.json(); })
      .then((j: { fonts?: [string, string, string][] }) => { catalogNow = (j.fonts || []).map((f) => ({ family: f[0], category: f[1], license: f[2] })); return catalogNow; })
      .catch(() => { catalogReq = null; return [] as GoogleFamily[]; });
  }
  return catalogReq;
}
/** Fonts uploaded into the project from somebody's computer. */
export function projectFonts(): Promise<string[]> {
  if (!projectId) return Promise.resolve([]);
  if (!projectReq) {
    const pid = projectId;
    projectReq = fetch(`/api/projects/${pid}/fonts`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { fonts: [] }))
      .then((j: { fonts?: { family: string }[] }) => (j.fonts || []).map((f) => f.family))
      .catch(() => { if (projectId === pid) projectReq = null; return [] as string[]; });
  }
  return projectReq;
}

/** The faces the document names: (font (face "…")) anywhere in it. */
export function facesUsed(doc: { items: Map<unknown, { node: unknown }> } | null): string[] {
  const used = new Set<string>();
  const walk = (n: unknown): void => { if (!Array.isArray(n)) return; if (n[0] === "face" && typeof n[1] === "string" && n[1]) used.add(n[1]); for (const c of n) walk(c); };
  if (doc) for (const it of doc.items.values()) walk(it.node);
  return Array.from(used).sort((a, b) => a.localeCompare(b));
}

const CATEGORY: Record<string, string> = { sans: "Sans serif", serif: "Serif", display: "Display", hand: "Handwriting", mono: "Monospace" };
const LICENSE: Record<string, string> = { "OFL-1.1": "SIL Open Font License 1.1", "Apache-2.0": "Apache License 2.0", "UFL-1.0": "Ubuntu Font Licence 1.0" };

// ---- names drawn in their own font: a few glyphs per family, fetched for the rows on screen ----

const previews = new Map<string, "loading" | "ok" | "fail">();
interface Watcher { done: () => void; still: () => boolean }
const watchers = new Map<string, Watcher[]>();   // the rows waiting for a family's glyphs
const waiting: string[] = [];
let running = 0;
const previewFamily = (family: string): string => "jfp " + family;
const noPreview = (family: string): boolean => /^Material (Icons|Symbols)/.test(family);   // icon fonts cannot spell their own name
function pump(): void {
  while (running < 6 && waiting.length) {
    const family = waiting.shift()!;
    if (!(watchers.get(family) || []).some((w) => w.still())) { previews.delete(family); watchers.delete(family); continue; }   // scrolled away before its turn
    running++;
    const face = new FontFace(previewFamily(family), `url(/api/fonts/preview?family=${encodeURIComponent(family)})`);
    face.load().then(() => { document.fonts.add(face); previews.set(family, "ok"); for (const w of watchers.get(family) || []) w.done(); }, () => { previews.set(family, "fail"); })
      .then(() => { watchers.delete(family); running--; pump(); });
  }
}
function wantPreview(family: string, done: () => void, still: () => boolean): void {
  if (typeof FontFace === "undefined" || noPreview(family)) return;
  const state = previews.get(family);
  if (state === "ok" || state === "fail") return;
  const list = watchers.get(family) || []; list.push({ done, still }); watchers.set(family, list);
  if (!state) { previews.set(family, "loading"); waiting.push(family); setTimeout(pump, 60); }   // after the row is in place, and not for rows scrolled straight past
}

// ---- the control ----

interface Row { head?: string; value?: string; label?: string; google?: GoogleFamily; note?: string }
const ROW_H = 26;

export function fontPicker(doc: { items: Map<unknown, { node: unknown }> } | null, value: string, opts?: FontPickerOpts): FontPickerEl {
  const o = opts || {};
  const kicadValue = o.kicadValue !== undefined ? o.kicadValue : KICAD_FONT;
  const extra = o.extra || [];
  let current = value, disabled = !!o.disabled, pop: HTMLElement | null = null;
  const labelOf = (v: string): string => { const x = extra.find((e) => e[0] === v); return x ? x[1] : v === kicadValue || v === KICAD_FONT ? KICAD_FONT : v; };
  const text = h("span", { class: "kd-font-name" }, labelOf(current));
  const el = h("div", { class: "kd-font", id: o.id, style: o.style, role: "combobox", tabindex: disabled ? -1 : 0, "aria-haspopup": "listbox", "aria-expanded": "false", "aria-disabled": disabled ? "true" : undefined, "data-k": o.key },
    text, h("span", { class: "kd-font-chev", "aria-hidden": "true" }, "▾")) as FontPickerEl;
  Object.defineProperty(el, "value", { get: () => current, set: (v: string) => { current = String(v); text.textContent = labelOf(current); } });
  Object.defineProperty(el, "disabled", { get: () => disabled, set: (d: boolean) => { disabled = !!d; el.tabIndex = disabled ? -1 : 0; if (disabled) el.setAttribute("aria-disabled", "true"); else el.removeAttribute("aria-disabled"); if (disabled) close(); } });

  const used = facesUsed(doc);
  let uploaded: string[] = [], google: GoogleFamily[] = catalogNow || [];

  function rowsFor(filter: string): Row[] {
    const q = filter.trim().toLowerCase(), hit = (s: string): boolean => !q || s.toLowerCase().includes(q);
    const rows: Row[] = [];
    for (const [v, l] of extra) if (hit(l)) rows.push({ value: v, label: l });
    if (hit(KICAD_FONT)) rows.push({ value: kicadValue, label: KICAD_FONT });
    const byName = new Map(google.map((g) => [g.family.toLowerCase(), g]));
    const mine = Array.from(new Set([...used, ...uploaded, ...(current && current !== kicadValue && current !== KICAD_FONT && !extra.some((e) => e[0] === current) ? [current] : [])])).sort((a, b) => a.localeCompare(b)).filter(hit);
    if (mine.length) {
      rows.push({ head: "In this project" });
      for (const f of mine) { const g = byName.get(f.toLowerCase()); rows.push({ value: f, label: f, google: g, note: g ? "" : uploaded.some((u) => u.toLowerCase() === f.toLowerCase()) ? "Stored with the project" : "" }); }
    }
    const list = google.filter((g) => hit(g.family));
    // names that start with what was typed come first, as a combo box's own search would land on them
    if (q) list.sort((a, b) => Number(b.family.toLowerCase().startsWith(q)) - Number(a.family.toLowerCase().startsWith(q)) || a.family.localeCompare(b.family));
    if (list.length) { rows.push({ head: `Google Fonts (${list.length})` }); for (const g of list) rows.push({ value: g.family, label: g.family, google: g }); }
    else if (!google.length) rows.push({ head: catalogReq && !catalogNow ? "Loading Google Fonts…" : "Google Fonts could not be loaded" });
    return rows;
  }

  function close(): void {
    if (!pop) return;
    pop.remove(); pop = null; el.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", close); window.removeEventListener("blur", close);
  }
  const outside = (ev: Event): void => { if (pop && !pop.contains(ev.target as Node) && !el.contains(ev.target as Node)) close(); };
  function choose(v: string): void {
    const changed = v !== current;
    el.value = v; close(); el.focus();
    if (changed) el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function open(): void {
    if (pop || disabled) return;
    const search = h("input", { type: "text", class: "kd-font-search", placeholder: "Search fonts", spellcheck: "false", autocomplete: "off", "aria-label": "Search fonts" });
    const spacer = h("div", { class: "kd-font-spacer" }), list = h("div", { class: "kd-font-list", role: "listbox" }, spacer);
    const foot = h("div", { class: "kd-font-foot" });
    const p = h("div", { class: "kd-font-pop" }, search, list, foot); pop = p;
    let rows: Row[] = [], active = -1;
    const painted = new Map<number, HTMLElement>();
    const selectable = (i: number): boolean => !!rows[i] && rows[i].head === undefined;
    const describe = (r: Row | undefined): void => {
      foot.textContent = !r || r.head !== undefined ? "" : r.google ? `${CATEGORY[r.google.category] || "Google Fonts"} · Google Fonts · ${LICENSE[r.google.license] || "open licence"}`
        : r.value === kicadValue ? "KiCad's own stroke font" : r.note || "";
    };
    function paint(): void {
      const top = list.scrollTop, first = Math.max(0, Math.floor(top / ROW_H) - 4), last = Math.min(rows.length - 1, Math.ceil((top + list.clientHeight) / ROW_H) + 4);
      for (const [i, node] of painted) if (i < first || i > last) { node.remove(); painted.delete(i); }
      for (let i = first; i <= last; i++) {
        let node = painted.get(i);
        if (!node) {
          const r = rows[i];
          if (r.head !== undefined) node = h("div", { class: "kd-font-head" }, r.head);
          else {
            const name = h("span", { class: "kd-font-row-name" }, r.label || "");
            node = h("div", { class: "kd-font-row", role: "option", "data-i": i, title: r.label }, name);
            const g = r.google;
            if (g) {
              const show = (): void => { if (previews.get(g.family) === "ok") name.style.fontFamily = `"${previewFamily(g.family)}", var(--font)`; };
              show(); wantPreview(g.family, show, () => !!pop && painted.get(i) === node);
            }
          }
          node.style.top = i * ROW_H + "px"; painted.set(i, node); list.append(node);
        }
        node.classList.toggle("sel", rows[i].value === current && rows[i].head === undefined);
        node.classList.toggle("active", i === active);
        if (rows[i].head === undefined) node.setAttribute("aria-selected", rows[i].value === current ? "true" : "false");
      }
    }
    function setActive(i: number, scroll: boolean): void {
      active = i; describe(rows[i]);
      if (scroll && i >= 0) { const y = i * ROW_H; if (y < list.scrollTop) list.scrollTop = y; else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight; }
      paint();
    }
    function refill(keep: boolean): void {
      const was = keep && active >= 0 && rows[active] ? rows[active].value : undefined;
      rows = rowsFor(search.value);
      for (const node of painted.values()) node.remove(); painted.clear();
      spacer.style.height = rows.length * ROW_H + "px";
      let i = was !== undefined ? rows.findIndex((r) => r.head === undefined && r.value === was) : -1;
      if (i < 0 && search.value.trim()) i = rows.findIndex((r) => r.head === undefined);
      if (i < 0) i = rows.findIndex((r) => r.head === undefined && r.value === current);
      if (!keep) list.scrollTop = !search.value.trim() && i > 0 ? Math.max(0, i * ROW_H - 3 * ROW_H) : 0;
      setActive(i, keep);
    }
    const step = (d: number): void => { let i = active; for (let n = 0; n < rows.length; n++) { i += d; if (i < 0 || i >= rows.length) return; if (selectable(i)) { setActive(i, true); return; } } };
    list.addEventListener("scroll", paint);
    list.addEventListener("pointermove", (ev) => { const row = (ev.target as Element).closest<HTMLElement>(".kd-font-row"); if (row && Number(row.dataset.i) !== active) setActive(Number(row.dataset.i), false); });
    list.addEventListener("click", (ev) => { const row = (ev.target as Element).closest<HTMLElement>(".kd-font-row"); if (row) choose(rows[Number(row.dataset.i)].value as string); });
    search.addEventListener("input", () => refill(false));
    p.addEventListener("keydown", (ev) => {
      ev.stopPropagation();   // the dialog under it must not take Enter and Escape
      if (ev.key === "Escape") { ev.preventDefault(); close(); el.focus(); }
      else if (ev.key === "Enter") { ev.preventDefault(); if (selectable(active)) choose(rows[active].value as string); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); step(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); step(-1); }
      else if (ev.key === "PageDown" || ev.key === "PageUp") { ev.preventDefault(); const n = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1); for (let k = 0; k < n; k++) step(ev.key === "PageDown" ? 1 : -1); }
      else if (ev.key === "Tab") { close(); }
    });
    document.body.append(p);
    // under the control, or above it when the window ends first
    const r = el.getBoundingClientRect(), w = Math.max(r.width, 280), ht = Math.min(360, window.innerHeight - 16);
    const below = window.innerHeight - r.bottom - 8, up = below < Math.min(ht, 220) && r.top > below;
    const height = Math.max(160, Math.min(ht, up ? r.top - 8 : below));
    p.style.width = w + "px"; p.style.height = height + "px";
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    p.style.top = (up ? Math.max(8, r.top - height - 2) : r.bottom + 2) + "px";
    el.setAttribute("aria-expanded", "true");
    refill(false); search.focus();
    document.addEventListener("pointerdown", outside, true); window.addEventListener("resize", close); window.addEventListener("blur", close);
    void projectFonts().then((f) => { uploaded = f; if (pop === p) refill(true); });
    void googleFonts().then((g) => { google = g; if (pop === p) refill(true); });
    if (!catalogNow) refill(true);   // shows "Loading…" until the list arrives
  }

  el.addEventListener("click", () => { if (pop) close(); else open(); });
  el.addEventListener("keydown", (ev) => {
    if (disabled || pop) return;
    if (ev.key === "Enter" || ev.key === " " || ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "F4") { ev.preventDefault(); ev.stopPropagation(); open(); }
    else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.stopPropagation(); open(); }   // typing starts the search, as in a combo box
  });
  return el;
}

// ---- for the board dialogs (web/editor/pcbdialogs): the picker as a form field, and the (face …) of a (font …) ----

/** The picker in the shape the board dialogs' fields have.  On a board the stroke font is "" (no face). */
export function fontField(doc: { items: Map<unknown, { node: unknown }> } | null, face: string, opts?: { ro?: boolean; key?: string; extra?: [string, string][]; kicadValue?: string; onChange?(v: string): void }): { el: HTMLElement; input: HTMLSelectElement; get(): string; set(v: string): void } {
  const o = opts || {};
  const el = fontPicker(doc, face, { disabled: o.ro, key: o.key, extra: o.extra, kicadValue: o.kicadValue !== undefined ? o.kicadValue : "", style: "width:100%" });
  if (o.onChange) { const cb = o.onChange; el.addEventListener("change", () => cb(el.value)); }
  return { el, input: el as unknown as HTMLSelectElement, get: () => el.value, set: (v) => { el.value = v; } };
}
/** The face a (font …) node names, "" for KiCad's stroke font. */
export function faceOfFont(font: unknown): string {
  if (!Array.isArray(font)) return "";
  const f = font.find((c) => Array.isArray(c) && c[0] === "face");
  return f && typeof f[1] === "string" ? f[1] : "";
}
/** Write the face into a (font …) node: first in it, as KiCad writes it; none for the stroke font. */
export function setFaceOfFont(font: unknown[], face: string): void {
  for (let i = font.length - 1; i > 0; i--) { const c = font[i]; if (Array.isArray(c) && c[0] === "face") font.splice(i, 1); }
  if (face && face !== KICAD_FONT) font.splice(1, 0, ["face", face]);
}
