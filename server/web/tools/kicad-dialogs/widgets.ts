// kicad-dialogs/widgets.ts — widgets: notebook, treebook, grid
// The pieces KiCad's larger dialogs are made of (wxNotebook, PAGED_DIALOG's wxTreebook, WX_GRID with its
// add / delete / move buttons).  Their CSS travels with them so a dialog works wherever this file is loaded.
import type { GridApi, GridColumn, GridOpts, NotebookApi, NotebookTab, TreebookApi, TreeSection } from "../../dialogs/dom";
import { esc, isList, str } from "./sexpr";
import { el } from "./shell";

const WIDGET_CSS = `
.kd-overlay.kd-modeless { background: transparent; pointer-events: none; align-items: flex-start; justify-content: flex-end; padding: 96px 60px 0 0; }
.kd-overlay.kd-modeless .kd-dialog { pointer-events: auto; }
.kd-dialog.kd-wide { max-width: min(1180px, 96vw); }
.kd-dialog.kd-flush .kd-body { padding: 0; }
.kd-nb { display: flex; flex-direction: column; min-height: 0; }
.kd-nb-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); padding: 0 6px; }
.kd-nb-tab { padding: 5px 14px; border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; cursor: pointer; color: var(--ink-2); margin-bottom: -1px; user-select: none; }
.kd-nb-tab.on { background: var(--bench); border-color: var(--line); color: var(--ink); font-weight: 600; }
.kd-nb-page { padding: 10px 4px 2px; min-height: 0; }
.kd-tb { display: grid; grid-template-columns: 190px 1fr; min-height: 420px; }
.kd-tb-tree { border-right: 1px solid var(--line); background: var(--panel); padding: 6px 0; overflow: auto; user-select: none; }
.kd-tb-node { padding: 3px 10px; cursor: default; white-space: nowrap; color: var(--ink); }
.kd-tb-node.child { padding-left: 26px; cursor: pointer; }
.kd-tb-node.parent { cursor: pointer; }
.kd-tb-node.parent::before { content: "▾"; display: inline-block; width: 12px; color: var(--ink-3); font-size: 10px; }
.kd-tb-node.on { background: var(--accent); color: var(--on-accent); }
.kd-tb-page { padding: 12px 16px; overflow: auto; max-height: 68vh; }
.kd-grid-wrap { border: 1px solid var(--line); overflow: auto; background: var(--panel); }
.kd-grid { border-collapse: collapse; width: 100%; font-size: 12px; }
.kd-grid th { position: sticky; top: 0; background: var(--bench); text-align: left; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); white-space: nowrap; z-index: 1; }
.kd-grid td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 0; height: 22px; }
.kd-grid tr.sel td { background: color-mix(in srgb, var(--blue) 18%, transparent); }
.kd-grid td.ro { padding: 2px 6px; color: var(--ink-2); }
.kd-grid td.c { text-align: center; }
.kd-body .kd-grid td input[type=text], .kd-body .kd-grid td input[type=number], .kd-body .kd-grid td select { border: none; background: transparent; border-radius: 0; padding: 2px 6px; font-family: inherit; }
.kd-body .kd-grid td input[type=text]:focus, .kd-body .kd-grid td select:focus { outline: 2px solid var(--blue); outline-offset: -2px; background: var(--panel); }
.kd-grid td input[type=checkbox] { margin: 0; }
.kd-grid-btns { display: flex; gap: 4px; margin-top: 4px; }
.kd-grid-btns .btn { padding: 1px 7px; min-width: 26px; font-size: 13px; line-height: 18px; }
.kd-sb { border: 1px solid var(--line); border-radius: 3px; padding: 14px 10px 8px; margin: 12px 0 8px; position: relative; }
.kd-sb > .kd-sb-t { position: absolute; top: -9px; left: 8px; background: var(--bench); padding: 0 4px; color: var(--ink-2); font-size: 12px; }
.kd-row { display: flex; gap: 8px; align-items: center; }
.kd-chk { display: flex; gap: 6px; align-items: center; color: var(--ink); margin: 3px 0; }
.kd-chk input { width: auto; margin: 0; }
`;
let cssDone = false;
export function ensureCss(): void { if (cssDone || typeof document === "undefined") return; cssDone = true; const st = document.createElement("style"); st.id = "kd-widget-css"; st.textContent = WIDGET_CSS; document.head.appendChild(st); }

/** wxNotebook: tabs = [{ label, build(page) }]; pages are built on first show.  -> { el, select(i), index() } */
export function notebook(host: HTMLElement, tabs: NotebookTab[], opts?: { selected?: number; onSelect?(i: number): void }): NotebookApi {
  ensureCss();
  const nb = el("div", "kd-nb"), bar = el("div", "kd-nb-tabs"), pages: HTMLElement[] = []; let cur = -1;
  const select = (i: number): void => { if (i === cur || !tabs[i]) return; cur = i;
    [...bar.children].forEach((t, j) => t.classList.toggle("on", j === i));
    pages.forEach((p, j) => { p.style.display = j === i ? "" : "none"; });
    if (!pages[i].dataset.built) { pages[i].dataset.built = "1"; tabs[i].build(pages[i]); }
    if (opts && opts.onSelect) opts.onSelect(i); };
  tabs.forEach((t, i) => { const tab = el("div", "kd-nb-tab", esc(t.label)); tab.addEventListener("click", () => select(i)); bar.appendChild(tab); const pg = el("div", "kd-nb-page"); pg.style.display = "none"; pages.push(pg); });
  nb.append(bar, ...pages); host.appendChild(nb); select((opts && opts.selected) || 0);
  return { el: nb, select, index: () => cur, pages };
}

/** PAGED_DIALOG's treebook: sections = [{ label, pages: [{ label, build(page) }] }].  -> { el, select(label), current() } */
export function treebook(host: HTMLElement, sections: TreeSection[], opts?: { selected?: string; onSelect?(label: string): void }): TreebookApi {
  ensureCss();
  const tb = el("div", "kd-tb"), tree = el("div", "kd-tb-tree"), pane = el("div", "kd-tb-page"), built = new Map<string, HTMLElement>(), nodes = new Map<string, HTMLElement>(); let cur: string | null = null;
  const select = (label: string): void => { let pg: NotebookTab | null = null; for (const s of sections) for (const p of s.pages) if (p.label === label) pg = p; if (!pg) return; cur = label;
    for (const [l, n] of nodes) n.classList.toggle("on", l === label);
    for (const [l, d] of built) d.style.display = l === label ? "" : "none";
    if (!built.has(label)) { const d = el("div"); built.set(label, d); pane.appendChild(d); pg.build(d); }
    if (opts && opts.onSelect) opts.onSelect(label); };
  for (const s of sections) {
    const pn = el("div", "kd-tb-node parent", esc(s.label)); tree.appendChild(pn);
    pn.addEventListener("click", () => { if (s.pages[0]) select(s.pages[0].label); });
    for (const p of s.pages) { const n = el("div", "kd-tb-node child", esc(p.label)); n.addEventListener("click", () => select(p.label)); nodes.set(p.label, n); tree.appendChild(n); }
  }
  tb.append(tree, pane); host.appendChild(tb);
  const first = (opts && opts.selected) || (sections[0] && sections[0].pages[0] && sections[0].pages[0].label); if (first) select(first);
  return { el: tb, select, current: () => cur };
}

/**
 * WX_GRID: columns = [{ key, label, type: "text" | "bool" | "choice" | "ro", options, width, ro(row) }], rows = [{…}] (edited in place).
 * opts: { readOnly, height, onChange(row, key, value), onHeader(column), buttons: { add() -> row | null, remove: true, move: true }, onSelect(row, index) }
 * -> { el, rows, refresh(), selected(), select(i) }
 */
export function grid<R>(host: HTMLElement, columns: GridColumn<R>[], rows: R[], optsIn?: GridOpts<R>): GridApi<R> {
  ensureCss(); const opts = optsIn || {};
  const wrap = el("div", "kd-grid-wrap"), table = el("table", "kd-grid"); if (opts.height) wrap.style.maxHeight = wrap.style.height = typeof opts.height === "number" ? opts.height + "px" : opts.height;
  let sel = -1; const api: GridApi<R> = { el: wrap, rows, columns, refresh, selected: () => sel, select };
  function select(i: number): void { sel = i; [...table.querySelectorAll("tbody tr")].forEach((tr, j) => tr.classList.toggle("sel", j === i)); if (opts.onSelect) opts.onSelect(rows[i] || null, i); }
  function refresh(): void {
    const cols = api.columns;
    table.innerHTML = `<thead><tr>${cols.map((c) => `<th${c.width ? ` style="width:${c.width}px"` : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>`;
    const tb = el("tbody");
    rows.forEach((r, i) => {
      const tr = el("tr"); if (i === sel) tr.classList.add("sel");
      for (const c of cols) {
        const td = el("td"), ro = opts.readOnly || c.type === "ro" || (c.ro && c.ro(r)), v = (r as Record<string, unknown>)[c.key];   // a row is a plain record keyed by its columns
        if (c.type === "bool") { td.className = "c"; const cb = el("input") as HTMLInputElement; cb.type = "checkbox"; cb.checked = !!v; cb.disabled = !!ro; cb.dataset.col = c.key; cb.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = cb.checked; if (opts.onChange) opts.onChange(r, c.key, cb.checked, i); }); td.appendChild(cb); }
        else if (ro) { td.className = "ro"; td.textContent = c.format ? c.format(v, r) : str(v); if (c.title) td.title = c.title(r); }
        else if (c.type === "choice") { const s = el("select") as HTMLSelectElement; s.dataset.col = c.key; for (const o of (typeof c.options === "function" ? c.options(r) : c.options!)) { const op = el("option") as HTMLOptionElement; op.value = isList(o) ? o[0] : o; op.textContent = isList(o) ? o[1] : o; s.appendChild(op); } s.value = str(v); s.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = s.value; if (opts.onChange) opts.onChange(r, c.key, s.value, i); }); td.appendChild(s); }
        else { const inp = el("input") as HTMLInputElement; inp.type = "text"; inp.value = str(v); inp.dataset.col = c.key; if (c.list) inp.setAttribute("list", c.list); inp.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = inp.value; if (opts.onChange) opts.onChange(r, c.key, inp.value, i); }); td.appendChild(inp); }
        tr.appendChild(td);
      }
      tr.addEventListener("pointerdown", () => { if (sel !== i) select(i); });
      tr.addEventListener("focusin", () => { if (sel !== i) select(i); });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    if (opts.onHeader) [...table.querySelectorAll<HTMLElement>("th")].forEach((th, i) => { th.style.cursor = "pointer"; th.addEventListener("click", () => opts.onHeader!(cols[i], i)); });
  }
  wrap.appendChild(table); host.appendChild(wrap); refresh();
  const B = opts.buttons;
  if (B && !opts.readOnly) {
    const bar = el("div", "kd-grid-btns"); const mk = (txt: string, title: string, fn: () => void): HTMLElement => { const b = el("button", "btn", txt) as HTMLButtonElement; b.title = title; b.type = "button"; b.addEventListener("click", fn); bar.appendChild(b); return b; };
    if (B.add) mk("+", B.addTitle || "Add", () => { const r = B.add!(); if (r) { rows.push(r); sel = rows.length - 1; refresh(); const f = table.querySelector<HTMLInputElement>("tbody tr:last-child input[type=text]"); if (f) f.focus(); if (opts.onChange) opts.onChange(r, null, null, sel); } });
    if (B.move) { mk("↑", "Move up", () => { if (sel > 0) { [rows[sel - 1], rows[sel]] = [rows[sel], rows[sel - 1]]; sel--; refresh(); if (opts.onChange) opts.onChange(rows[sel], null, null, sel); } });
      mk("↓", "Move down", () => { if (sel >= 0 && sel < rows.length - 1) { [rows[sel + 1], rows[sel]] = [rows[sel], rows[sel + 1]]; sel++; refresh(); if (opts.onChange) opts.onChange(rows[sel], null, null, sel); } }); }
    if (B.remove) mk("🗑", B.removeTitle || "Delete", () => { if (sel < 0 || !rows[sel]) return; if (B.canRemove && !B.canRemove(rows[sel])) return; const gone = rows.splice(sel, 1)[0]; sel = Math.min(sel, rows.length - 1); refresh(); if (opts.onChange) opts.onChange(gone, null, null, -1); });
    host.appendChild(bar); api.bar = bar;
  }
  return api;
}
/** wxStaticBoxSizer: a titled frame; returns the element to fill. */
export function staticBox(host: HTMLElement, title: string): HTMLElement { ensureCss(); const b = el("div", "kd-sb"); b.appendChild(el("span", "kd-sb-t", esc(title))); host.appendChild(b); return b; }
