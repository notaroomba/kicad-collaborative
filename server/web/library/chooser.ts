// library/chooser.ts — KiCad's "Choose Symbol" / "Choose Footprint" dialogs and the library
// browsers (eeschema/dialogs/dialog_symbol_chooser.cpp, panel_symbol_chooser.cpp,
// pcbnew/widgets/panel_footprint_chooser.cpp, common/widgets/lib_tree.cpp): the filter box over
// the library tree with its "-- Recently Used --" and "-- Already Placed --" groups and the
// Item / Description columns, the details pane under it, the preview on the right (symbol unit
// over its default footprint, or the footprint alone), "Place repeated copies" / "Place all
// units" and Cancel / OK.  A double click or Enter on an item accepts it.
import { isPowerRow, parseLibId, searchScore, symbolInfo, unitName } from "./core";
import { clearPreview, renderFootprintPreview, renderSymbolPreview } from "./preview";
import { fetchItem, libraryIndex, officialLibraries, onSourcesChanged, placedItems, projectLibraries, recentItems, registeredSources, rememberRecent } from "./sources";
import type { FetchedItem, LibItem, LibKind, LibraryEntry, LibrarySource, SourceContext } from "./sources";
import { filterLabels, footprintPasses, type FpChooserFilters } from "./fpchoice";
import "../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

export interface ChooserOptions {
  /** The power tool's chooser: only power symbols. */
  power?: boolean;
  /** The library browser: the same tree, read as a browser ("Add … to …" instead of OK, no placement options). */
  browser?: boolean;
  title?: string;
  /** Text the filter starts with. */
  filter?: string;
  /** The document cannot be edited: browsing only. */
  viewOnly?: boolean;
  /** FOOTPRINT_CHOOSER_FRAME's MAIL_SYMBOL_NETLIST: the symbol's pin count and footprint filters, offered as the
   *  "Filter by pin count (n)" / "Apply footprint filters (…)" check boxes under the filter box. */
  fpFilters?: FpChooserFilters | null;
  /** PANEL_FOOTPRINT_CHOOSER::SetPreselect: the item ("Lib:Name") selected and shown when the tree opens. */
  preselect?: string;
  /** Only the libraries (a field's value is picked: a vendor search result has no library id to write back). */
  noSources?: boolean;
  /** FOOTPRINT_CHOOSER_FRAME's AddFootprintToHistory: an accepted item goes to "-- Recently Used --". */
  history?: boolean;
}

export interface Chosen {
  kind: LibKind;
  item: LibItem;
  libId?: string;
  fpid?: string;
  symbol?: string;
  footprint?: string;
  fields?: Record<string, string>;
  unit: number;
  /** "Place repeated copies" */
  keep: boolean;
  /** "Place all units" */
  allUnits: boolean;
}

interface Group {
  key: string;
  label: string;
  description: string;
  type: "recent" | "placed" | "lib" | "source";
  entry?: LibraryEntry;
  src?: LibrarySource;
  items: LibItem[] | null;
  loading: boolean;
  error: string;
}
interface Row { key: string; depth: 0 | 1 | 2; group: Group; item?: LibItem; unit?: number; label: string; description: string; expandable: boolean; expanded: boolean }

const ROW_H = 22;
const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
.klib-dialog { width: min(1040px, 96vw); height: min(700px, 92vh); max-width: 98vw; max-height: 96vh; min-width: 640px; min-height: 420px; resize: both; overflow: hidden; }
.klib-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 1.15fr) 5px minmax(240px, 1fr); padding: 8px 10px 0; }
.klib-left { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.klib-split { cursor: col-resize; }
.klib-filter { display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-2); padding: 0 6px; margin-bottom: 6px; }
.klib-filter:focus-within { border-color: var(--blue); }
.klib-filter svg { flex: none; color: var(--ink-2); }
.klib-filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 12px var(--font); padding: 5px 0; }
.klib-filter .klib-clear { cursor: pointer; color: var(--ink-2); padding: 0 2px; visibility: hidden; }
.klib-filter.has-text .klib-clear { visibility: visible; }
.klib-head { display: grid; grid-template-columns: var(--klib-col, 46%) 1fr; border: 1px solid var(--line); border-bottom: 0; background: var(--panel-2); font-weight: 600; color: var(--ink-2); }
.klib-head span { padding: 3px 8px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; }
.klib-head span:last-child { border-right: 0; }
.klib-tree { flex: 1; min-height: 80px; overflow: auto; border: 1px solid var(--line); background: var(--panel); outline: 0; position: relative; }
.klib-rows { position: relative; }
.klib-row { position: absolute; left: 0; right: 0; height: ${ROW_H}px; line-height: ${ROW_H}px; display: grid; grid-template-columns: var(--klib-col, 46%) 1fr; cursor: default; white-space: nowrap; user-select: none; }
.klib-row:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
.klib-row.sel { background: var(--accent); color: var(--on-accent); }
.klib-row.sel .klib-desc { color: var(--on-accent); }
.klib-row .klib-item { overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
.klib-row .klib-desc { overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); padding: 0 8px; }
.klib-row.lib .klib-item { font-weight: 600; }
.klib-row.note .klib-item { color: var(--ink-2); font-style: italic; font-weight: 400; }
.klib-row.sel.note .klib-item { color: var(--on-accent); }
.klib-spin { display: inline-block; width: 10px; height: 10px; margin: 0 6px 0 2px; border: 2px solid color-mix(in srgb, var(--ink) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: klib-spin .7s linear infinite; vertical-align: -1px; }
.klib-row.sel .klib-spin { border-color: color-mix(in srgb, var(--on-accent) 35%, transparent); border-top-color: var(--on-accent); }
@keyframes klib-spin { to { transform: rotate(360deg); } }
.klib-tw { display: inline-block; width: 16px; text-align: center; color: var(--ink-2); font-size: 9px; }
.klib-row.sel .klib-tw { color: var(--on-accent); }
.klib-filters { display: flex; flex-direction: column; padding-left: 4px; }
.klib-filters label { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.klib-filters input[type=checkbox] { width: auto; margin: 0; flex: none; }
.klib-details { height: 132px; flex: none; overflow: auto; border: 1px solid var(--line); border-top: 0; background: var(--panel); padding: 6px 10px; line-height: 1.45; }
.klib-details b.klib-name { font-size: 13px; }
.klib-details table { border-collapse: collapse; margin-top: 4px; }
.klib-details td { vertical-align: top; padding: 0 10px 0 0; }
.klib-details td:first-child { color: var(--ink-2); white-space: nowrap; }
.klib-details a { color: var(--blue); }
.klib-right { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 6px; }
.klib-pane { position: relative; flex: 1; min-height: 60px; border: 1px solid var(--line); overflow: hidden; }
.klib-pane canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.klib-pane .klib-msg { position: absolute; left: 0; right: 0; bottom: 6px; text-align: center; color: var(--ink-3); font-size: 11px; pointer-events: none; }
.klib-fpsel { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
.klib-fpsel k-select { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-2); padding: 3px 6px; color: var(--ink); font: 12px var(--font); }
.klib-foot { align-items: center; }
.klib-foot label { display: flex; gap: 6px; align-items: center; margin-right: 14px; white-space: nowrap; }
.klib-foot label.off { color: var(--ink-3); }
.klib-foot input[type=checkbox] { width: auto; margin: 0; }
.klib-status { color: var(--ink-2); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
function ensureCss(): void {
  if (document.getElementById("klib-css")) return;
  const st = document.createElement("style"); st.id = "klib-css"; st.textContent = CSS; document.head.appendChild(st);
}

let openDialog: { close(): void } | null = null;
/** Whether a chooser is on screen. */
export function chooserOpen(): boolean { return !!openDialog; }
export function closeChooser(): void { if (openDialog) openDialog.close(); }

// DIALOG_SYMBOL_CHOOSER is built afresh for every placement: "Place repeated copies" starts off and
// "Place all units" starts on (m_useUnits->SetValue( true )); neither is remembered
const CHOOSER_DEFAULTS = { keep: false, allUnits: true } as const;

// PCBNEW_SETTINGS m_FootprintChooser.filter_on_pin_count / use_fp_filters (both off by default), kept between openings
const FP_FILTER_KEY = "klib.fpchooser.filters";
function loadFpFilterPrefs(): { pins: boolean; filters: boolean } {
  try { const j = JSON.parse(localStorage.getItem(FP_FILTER_KEY) || "{}") as { pins?: unknown; filters?: unknown }; return { pins: j.pins === true, filters: j.filters === true }; } catch { return { pins: false, filters: false }; }
}
function saveFpFilterPrefs(v: { pins: boolean; filters: boolean }): void { try { localStorage.setItem(FP_FILTER_KEY, JSON.stringify(v)); } catch { /* no storage */ } }

/** Open the chooser; resolves with the chosen item (its s-expression fetched) or null on Cancel. */
export function openChooser(kind: LibKind, ctx: SourceContext, opts: ChooserOptions = {}): Promise<Chosen | null> {
  if (openDialog) openDialog.close();
  ensureCss();
  const isSym = kind === "symbol", browser = !!opts.browser, power = isSym && !!opts.power;
  const baseTitle = opts.title || (browser ? (isSym ? "Symbol Library Browser" : "Footprint Library Browser") : power ? "Choose Power Symbol" : isSym ? "Choose Symbol" : "Choose Footprint");
  const okLabel = browser ? (isSym ? "Add Symbol to Schematic" : "Add Footprint to Board") : "OK";
  const fpf = !isSym ? opts.fpFilters || null : null, labels = filterLabels(fpf), fpOn = loadFpFilterPrefs();

  return new Promise<Chosen | null>((resolve) => {
    const ov = document.createElement("div"); ov.className = "kd-overlay klib-overlay";
    const dlg = document.createElement("div"); dlg.className = "kd-dialog klib-dialog"; dlg.setAttribute("role", "dialog"); dlg.dataset.kind = kind;
    dlg.innerHTML = `
      <div class="kd-title"><span class="klib-title"></span><span class="kd-x" title="Close (Esc)">×</span></div>
      <div class="klib-main">
        <div class="klib-left">
          <div class="klib-filter"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>
            <input type="text" placeholder="Filter" spellcheck="false" autocomplete="off" aria-label="Filter"><span class="klib-clear" title="Clear filter">×</span></div>
          ${labels.filters || labels.pins ? `<div class="klib-filters">${labels.filters ? `<label><input type="checkbox" class="klib-by-filters"${fpOn.filters ? " checked" : ""}> ${esc(labels.filters)}</label>` : ""}${labels.pins ? `<label><input type="checkbox" class="klib-by-pins"${fpOn.pins ? " checked" : ""}> ${esc(labels.pins)}</label>` : ""}</div>` : ""}
          <div class="klib-head"><span>Item</span><span>Description</span></div>
          <div class="klib-tree" tabindex="0"><div class="klib-rows"></div></div>
          <div class="klib-details"></div>
        </div>
        <div class="klib-split"></div>
        <div class="klib-right">
          <div class="klib-pane klib-pane-main"><canvas></canvas><div class="klib-msg"></div></div>
          ${isSym ? `<div class="klib-fpsel"><span>Footprint:</span><k-select disabled><option>No default footprint</option></k-select></div>
          <div class="klib-pane klib-pane-fp"><canvas></canvas><div class="klib-msg"></div></div>` : ""}
        </div>
      </div>
      <div class="kd-foot klib-foot">
        ${isSym && !browser ? `<label><input type="checkbox" class="klib-keep"> Place repeated copies</label><label><input type="checkbox" class="klib-units"> Place all units</label>` : ""}
        <span class="klib-status"></span><span class="spacer"></span>
        <button class="btn klib-cancel">${browser ? "Close" : "Cancel"}</button><button class="btn primary klib-ok">${esc(okLabel)}</button>
      </div>`;
    ov.appendChild(dlg); document.body.appendChild(ov);
    const $ = <T extends Element>(sel: string) => dlg.querySelector(sel) as T;
    const titleEl = $<HTMLElement>(".klib-title"), input = $<HTMLInputElement>(".klib-filter input"), filterBox = $<HTMLElement>(".klib-filter");
    const tree = $<HTMLElement>(".klib-tree"), rowsEl = $<HTMLElement>(".klib-rows"), details = $<HTMLElement>(".klib-details"), status = $<HTMLElement>(".klib-status");
    const mainCanvas = $<HTMLCanvasElement>(".klib-pane-main canvas"), mainMsg = $<HTMLElement>(".klib-pane-main .klib-msg");
    const fpCanvas = isSym ? $<HTMLCanvasElement>(".klib-pane-fp canvas") : null, fpMsg = isSym ? $<HTMLElement>(".klib-pane-fp .klib-msg") : null;
    const fpSelect = isSym ? $<HTMLSelectElement>(".klib-fpsel k-select") : null;
    const okBtn = $<HTMLButtonElement>(".klib-ok"), keepBox = dlg.querySelector<HTMLInputElement>(".klib-keep"), unitsBox = dlg.querySelector<HTMLInputElement>(".klib-units");
    if (keepBox) keepBox.checked = CHOOSER_DEFAULTS.keep;
    if (unitsBox) unitsBox.checked = CHOOSER_DEFAULTS.allUnits;
    if (opts.viewOnly) { okBtn.disabled = true; okBtn.title = "This document is read-only"; }
    if (opts.filter) { input.value = opts.filter; filterBox.classList.add("has-text"); }

    // ---- the model
    const groups: Group[] = [];
    const expanded = new Set<string>();           // group keys and item keys the user opened
    let rows: Row[] = [], selKey = "", query = input.value.trim(), closed = false, loadedCount = 0, pending = 0, tableError = "";
    const recentGroup: Group = { key: "@recent", label: "-- Recently Used --", description: "", type: "recent", items: recentItems(kind), loading: false, error: "" };
    const placedGroup: Group = { key: "@placed", label: "-- Already Placed --", description: "", type: "placed", items: placedItems(kind, ctx.doc), loading: false, error: "" };
    const sourceGroups = new Map<string, Group>();
    const rebuildGroups = () => {
      const libs = groups.filter((g) => g.type === "lib");
      groups.length = 0;
      groups.push(recentGroup, placedGroup);
      for (const src of opts.noSources ? [] : registeredSources(kind)) {
        let g = sourceGroups.get(src.id);
        if (!g) { g = { key: "@src:" + src.id, label: src.label, description: "", type: "source", src, items: [], loading: false, error: "" }; sourceGroups.set(src.id, g); }
        groups.push(g);
      }
      groups.push(...libs);
    };
    rebuildGroups();
    const offSources = onSourcesChanged(() => { rebuildGroups(); searchSources(); refresh(); });

    const byPinsBox = dlg.querySelector<HTMLInputElement>(".klib-by-pins"), byFiltersBox = dlg.querySelector<HTMLInputElement>(".klib-by-filters");
    const fpFiltering = (): { pins: boolean; filters: boolean } => ({ pins: !!(byPinsBox && byPinsBox.checked), filters: !!(byFiltersBox && byFiltersBox.checked) });
    /** filterFootprint is on: libraries without a passing footprint are left out and the rest open, like a search */
    const filtering = (): boolean => { const on = fpFiltering(); return !!fpf && ((on.pins && fpf.pins > 0) || (on.filters && fpf.filters.length > 0)); };
    const visibleItems = (g: Group): LibItem[] => {
      let items = g.items || [];
      if (power) items = items.filter(isPowerRow);
      if (fpf && g.type !== "source") { const on = fpFiltering(); items = items.filter((it) => footprintPasses(it, fpf, on)); }
      return items;
    };
    const itemKey = (g: Group, it: LibItem) => g.key + "/" + it.id;

    function buildRows(): void {
      const out: Row[] = [];
      const ranked: { g: Group; items: { it: LibItem; score: number }[]; best: number }[] = [];
      for (const g of groups) {
        const all = visibleItems(g);
        // a registered source filters on its side: its results are taken as they come
        const scored = all.map((it) => ({ it, score: g.type === "source" ? 1 : searchScore({ name: it.name, description: it.description, keywords: it.keywords, library: it.library }, query) })).filter((x) => x.score > 0);
        if (query) scored.sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name));
        const best = scored.length ? scored[0].score : 0;
        if (g.type === "lib") { if ((query || power || filtering()) && !scored.length) continue; }
        else if (g.type === "source") { if (!scored.length && !g.loading && !g.error && !query) continue; }
        else if (!scored.length) continue;
        ranked.push({ g, items: scored, best });
      }
      if (query) {
        // best match first, the pinned groups staying on top like KiCad's "-- Recently Used --"
        const rank = (r: { g: Group; best: number }) => (r.g.type === "recent" ? 3e9 : r.g.type === "placed" ? 2e9 : r.best);
        ranked.sort((a, b) => rank(b) - rank(a));
      }
      for (const { g, items } of ranked) {
        const open = query || filtering() ? !expanded.has("-" + g.key) : expanded.has(g.key);
        const count = g.items ? items.length : -1;
        out.push({ key: g.key, depth: 0, group: g, label: g.label, description: g.description, expandable: count !== 0 || g.loading || !!g.error || !g.items, expanded: open });
        if (!open) continue;
        // a vendor search keeps its "Searching…" row above the previous results until the new ones arrive
        if (g.loading && (!items.length || g.type === "source")) out.push({ key: g.key + "/@loading", depth: 1, group: g, label: g.type === "source" ? `Searching ${g.label.replace(/\s*\(.*$/, "")}…` : "Loading…", description: g.type === "source" && query ? `for "${query}"` : "", expandable: false, expanded: false });
        if (g.error) out.push({ key: g.key + "/@error", depth: 1, group: g, label: g.error, description: "", expandable: false, expanded: false });
        for (const { it } of items) {
          const k = itemKey(g, it), units = isSym ? it.units || 1 : 1, itemOpen = units > 1 && expanded.has(k);
          out.push({ key: k, depth: 1, group: g, item: it, label: it.name, description: it.description || "", expandable: units > 1, expanded: itemOpen });
          if (itemOpen) for (let u = 1; u <= units; u++) out.push({ key: k + "#" + u, depth: 2, group: g, item: it, unit: u, label: unitName(u), description: "", expandable: false, expanded: false });
        }
      }
      rows = out;
    }
    /** The scroll height follows the rows at once (drawRows sets it a frame later), so a scroll to the selection is
     *  not clamped to the old height. */
    const growRows = (): void => { rowsEl.style.height = rows.length * ROW_H + "px"; };

    // ---- rendering (a windowed list: a search can match thousands of rows)
    let drawQueued = false;
    function drawRows(): void {
      drawQueued = false; if (closed) return;
      rowsEl.style.height = rows.length * ROW_H + "px";
      const top = tree.scrollTop, h = tree.clientHeight || 300;
      const first = Math.max(0, Math.floor(top / ROW_H) - 6), last = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + 6);
      let html = "";
      for (let i = first; i < last; i++) {
        const r = rows[i], note = !r.item && r.depth === 1;
        const tw = r.expandable ? (r.expanded ? "▼" : "▶") : "";
        html += `<div class="klib-row${r.depth === 0 ? " lib" : ""}${note ? " note" : ""}${r.key === selKey ? " sel" : ""}" style="top:${i * ROW_H}px" data-i="${i}" title="${esc(r.item ? (r.item.library ? r.item.library + ":" : "") + r.item.name : r.label)}">`
          + `<span class="klib-item" style="padding-left:${4 + r.depth * 16}px"><span class="klib-tw">${tw}</span>${(r.depth === 0 || r.key.endsWith("/@loading")) && r.group.loading ? '<span class="klib-spin"></span>' : ""}${esc(r.label)}</span><span class="klib-desc">${esc(r.description)}</span></div>`;
      }
      rowsEl.innerHTML = html;
    }
    const queueDraw = () => { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawRows); } };
    function setTitle(): void {
      titleEl.textContent = baseTitle + ` (${loadedCount} items loaded)`;
      const searching = [...sourceGroups.values()].some((g) => g.loading && groups.includes(g));
      status.textContent = tableError ? tableError : pending > 0 ? `Loading libraries… ${pending} to go` : searching ? "Searching vendor catalogues…" : "";
    }
    let refreshTimer = 0;
    let preselect = opts.preselect && opts.preselect.includes(":") ? opts.preselect : "";
    /** SetPreselect: once the library holding the item is in, open it and select the item */
    function applyPreselect(): void {
      if (!preselect || query) return;
      const lib = preselect.slice(0, preselect.indexOf(":"));
      const g = groups.find((x) => x.type === "lib" && x.label === lib); if (!g) return;
      if (!g.items) {
        // a library that failed to load is not asked for again here (loadGroup's own retries, when the server asked
        // for one, still run, and the item is selected if one of them brings the library in); once none is left the
        // preselection is dropped, as the tree has nothing to select
        if (g.error) { if (!g.loading && !retryWaiting.has(g.key)) preselect = ""; return; }
        void loadGroup(g); return;
      }
      const it = visibleItems(g).find((x) => x.id === preselect || (x.library || lib) + ":" + x.name === preselect);
      preselect = "";
      if (!it) return;
      if (!filtering()) expanded.add(g.key); else expanded.delete("-" + g.key);
      buildRows(); const k = itemKey(g, it);
      if (rows.some((r) => r.key === k)) { growRows(); selKey = ""; select(k, true); const i = rows.findIndex((r) => r.key === k); tree.scrollTop = Math.max(0, i * ROW_H - (tree.clientHeight || 300) / 2); }
    }
    function refresh(selectBest = false): void {
      if (closed) return;
      applyPreselect();
      // libraries that load (or open) above the selection push it down: the view follows it
      const before = selKey ? rows.findIndex((r) => r.key === selKey) : -1;
      buildRows();
      const after = before >= 0 ? rows.findIndex((r) => r.key === selKey) : -1;
      if (before >= 0 && after >= 0 && after !== before) { growRows(); tree.scrollTop += (after - before) * ROW_H; }
      if (selectBest || !rows.some((r) => r.key === selKey)) {
        const best = query || selectBest ? rows.find((r) => r.item) : null;
        if (best) select(best.key, true); else if (selKey && !rows.some((r) => r.key === selKey)) { selKey = ""; showSelection(); }
      }
      setTitle(); queueDraw();
    }
    const queueRefresh = () => { if (!refreshTimer) refreshTimer = window.setTimeout(() => { refreshTimer = 0; refresh(); }, 80); };

    function scrollTo(key: string): void {
      const i = rows.findIndex((r) => r.key === key); if (i < 0) return;
      const y = i * ROW_H, h = tree.clientHeight || 300;
      if (y < tree.scrollTop) tree.scrollTop = y; else if (y + ROW_H > tree.scrollTop + h) tree.scrollTop = y + ROW_H - h;
    }
    function select(key: string, quiet?: boolean): void {
      if (key === selKey && !quiet) return;
      selKey = key; scrollTo(key); showSelection(); queueDraw();
    }
    const selectedRow = (): Row | null => rows.find((r) => r.key === selKey) || null;

    // ---- details + preview of the selection
    let previewToken = 0, shown: { row: Row; got: FetchedItem } | null = null;
    function showSelection(): void {
      const row = selectedRow(); const token = ++previewToken; shown = null;
      okBtn.disabled = !!opts.viewOnly || !(row && row.item);
      if (unitsBox) { const multi = !!(row && row.item && (row.item.units || 1) > 1); unitsBox.disabled = !multi; unitsBox.parentElement!.classList.toggle("off", !multi); }
      if (!row) { details.innerHTML = ""; blank(); return; }
      if (!row.item) {
        details.innerHTML = `<b class="klib-name">${esc(row.label)}</b>${row.description ? `<div>${esc(row.description)}</div>` : ""}`;
        blank(); return;
      }
      const it = row.item;
      renderDetails(it, row.unit, null);
      clearPreview(mainCanvas, kind);
      mainMsg.innerHTML = `<span class="klib-spin"></span>${esc(it.source ? `Fetching ${it.name} from ${row.group.label.replace(/\s*\(.*$/, "")}…` : "Loading…")}`;
      fetchItem(kind, it, ctx).then((got) => {
        if (closed || token !== previewToken) return;
        shown = { row, got }; mainMsg.textContent = "";
        try {
          if (isSym) { renderSymbolPreview(mainCanvas, got.libId || it.id, got.symbol || "", row.unit || 1); renderDetails(it, row.unit, got); showDefaultFootprint(got, token); }
          else renderFootprintPreview(mainCanvas, got.fpid || it.id, got.footprint || "");
        } catch (e) { clearPreview(mainCanvas, kind); mainMsg.textContent = "Cannot draw this " + kind + ": " + ((e as Error).message || e); }
      }, (e: Error) => { if (closed || token !== previewToken) return; clearPreview(mainCanvas, kind); mainMsg.textContent = e.message || String(e); });
    }
    function blank(): void {
      clearPreview(mainCanvas, kind); mainMsg.textContent = "";
      if (fpCanvas && fpMsg && fpSelect) { clearPreview(fpCanvas, "footprint"); fpMsg.textContent = ""; fpSelect.innerHTML = "<option>No default footprint</option>"; }
    }
    function renderDetails(it: LibItem, unit: number | undefined, got: FetchedItem | null): void {
      const rowsHtml: string[] = [];
      const add = (k: string, v: string, html?: boolean) => { if (v) rowsHtml.push(`<tr><td>${esc(k)}</td><td>${html ? v : esc(v)}</td></tr>`); };
      let description = it.description || "";
      if (isSym) {
        let info = null; try { info = got && got.symbol ? symbolInfo(got.symbol) : null; } catch { info = null; }
        if (info && !description) description = info.description;
        if (it.extends) add("Derived from", it.extends);
        add("Keywords", (info && info.keywords) || it.keywords || "");
        if (info) for (const f of info.fields) {
          const v = (got && got.fields && got.fields[f.name] !== undefined) ? got.fields[f.name] : f.value;
          if (f.name === "Description" || f.name === "Value" || !v || v === "~") continue;
          if (f.name === "Datasheet" && /^https?:\/\//i.test(v)) add(f.name, `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`, true);
          else add(f.name, v);
        } else { add("Reference", it.reference || ""); add("Footprint", it.footprint || ""); }
        if ((it.units || 1) > 1) add("Units", unit ? `${unitName(unit).replace("Unit ", "")} of ${it.units}` : String(it.units));
      } else {
        add("Keywords", it.keywords || "");
        if (it.pads !== undefined) add("Pads", String(it.pads));
      }
      add("Library", it.library || parseLibId(it.id).lib);
      details.innerHTML = `<b class="klib-name">${esc(it.name)}</b>${unit ? ` <span>— ${esc(unitName(unit))}</span>` : ""}`
        + (description ? `<div>${esc(description)}</div>` : "") + `<table>${rowsHtml.join("")}</table>`;
    }
    function showDefaultFootprint(got: FetchedItem, token: number): void {
      if (!fpCanvas || !fpMsg || !fpSelect) return;
      let fp = (got.fields && got.fields.Footprint) || "";
      if (!fp) { try { fp = symbolInfo(got.symbol || "").footprint; } catch { fp = ""; } }
      fpSelect.innerHTML = `<option>${esc(fp || "No default footprint")}</option>`;
      clearPreview(fpCanvas, "footprint"); fpMsg.textContent = "";
      if (!fp || !fp.includes(":")) return;
      const { lib, name } = parseLibId(fp);
      const source = projectLibraries("footprint", ctx.docs).some((l) => l.name === lib) ? "project" : "official";
      fetchItem("footprint", { id: fp, name, library: lib, source }, ctx).then((f) => {
        if (closed || token !== previewToken) return;
        try { renderFootprintPreview(fpCanvas, fp, f.footprint || ""); } catch { fpMsg.textContent = "Cannot draw " + fp; }
      }, () => { if (!closed && token === previewToken) fpMsg.textContent = "Footprint not found: " + fp; });
    }

    // ---- loading
    const retries = new Map<string, number>(), retryTimers: number[] = [], retryWaiting = new Set<string>();
    function loadGroup(g: Group): Promise<void> {
      if (g.items || g.loading || !g.entry) return Promise.resolve();
      g.loading = true; g.error = "";
      return libraryIndex(kind, g.entry, ctx).then((items) => { g.items = items; loadedCount += items.length; }, (e: Error & { retryAfter?: number }) => {
        g.error = "Could not load: " + (e.message || e);
        // the server asks to come back later (the upstream refused it): do, a few times
        const tries = retries.get(g.key) || 0;
        if (e.retryAfter && tries < 3 && !closed) { retries.set(g.key, tries + 1); retryWaiting.add(g.key); retryTimers.push(window.setTimeout(() => { retryWaiting.delete(g.key); if (!closed && !g.items) void loadGroup(g); }, Math.min(90, e.retryAfter) * 1000 + 500)); }
      }).then(() => { g.loading = false; if (!closed) queueRefresh(); });
    }
    function preload(list: Group[]): void {
      const queue = list.slice(); pending += queue.length; setTitle();
      const worker = async (): Promise<void> => {
        for (;;) { const g = queue.shift(); if (!g || closed) return; await loadGroup(g); pending--; }
      };
      const done = () => { if (!closed) { setTitle(); refresh(); } };
      void Promise.all([worker(), worker(), worker(), worker()]).then(done, done);
    }
    const project = projectLibraries(kind, ctx.docs).map((l): Group => ({ key: "project:" + l.name, label: l.name, description: "Project library", type: "lib",
      entry: { name: l.name, description: "Project library", source: "project" }, items: null, loading: false, error: "" }));
    groups.push(...project);
    officialLibraries(kind).then((t) => {
      if (closed) return;
      const taken = new Set(project.map((g) => g.label));
      const official = t.libraries.filter((l) => !taken.has(l.name)).map((l): Group => ({ key: "lib:" + l.name, label: l.name, description: l.description, type: "lib", entry: l, items: null, loading: false, error: "" }));
      groups.push(...official);
      refresh();
      // the power tool wants its library first; everything else follows in table order
      const order = power ? official.filter((g) => g.label === "power").concat(official.filter((g) => g.label !== "power")) : official;
      preload(project.concat(order));
    }, (e: Error) => { if (closed) return; tableError = "KiCad libraries unavailable: " + (e.message || e); preload(project); refresh(); });

    let sourceTimer = 0, sourceToken = 0;
    function searchSources(): void {
      const token = ++sourceToken;
      for (const g of sourceGroups.values()) {
        if (!g.src || !groups.includes(g)) continue;
        const src = g.src; g.loading = true; g.error = "";
        Promise.resolve().then(() => src.search(query, kind)).then((list) => {
          if (closed || token !== sourceToken) return;
          g.items = (Array.isArray(list) ? list : []).map((r): LibItem => ({ id: String(r.id), name: String(r.name), description: r.description, keywords: r.keywords, library: r.library || src.label, source: src.id }));
          g.loading = false; queueRefresh();
        }, (e: Error) => { if (closed || token !== sourceToken) return; g.items = []; g.loading = false; g.error = "Search failed: " + (e.message || e); queueRefresh(); });
      }
    }

    // ---- finishing
    function close(result: Chosen | null): void {
      if (closed) return; closed = true;
      offSources(); window.removeEventListener("keydown", onKey, true); window.clearTimeout(refreshTimer); window.clearTimeout(sourceTimer); for (const t of retryTimers) window.clearTimeout(t); ro.disconnect();
      ov.remove(); if (openDialog === handle) openDialog = null;
      resolve(result);
    }
    const handle = { close: () => close(null) };
    openDialog = handle;
    function accept(): void {
      const row = selectedRow(); if (!row || !row.item || opts.viewOnly) return;
      const it = row.item;
      if (opts.history) rememberRecent(kind, it);
      const finish = (got: FetchedItem) => close({ kind, item: it, libId: got.libId || (isSym ? it.id : undefined), fpid: got.fpid || (isSym ? undefined : it.id), symbol: got.symbol, footprint: got.footprint,
        fields: got.fields, unit: row.unit || 1, keep: !!(keepBox && keepBox.checked), allUnits: !!(unitsBox && unitsBox.checked && !unitsBox.disabled) });
      if (shown && shown.row.key === row.key) { finish(shown.got); return; }
      okBtn.disabled = true; status.textContent = "Loading " + it.name + "…";
      fetchItem(kind, it, ctx).then((got) => { if (!closed) finish(got); }, (e: Error) => { if (closed) return; okBtn.disabled = false; status.textContent = e.message || String(e); });
    }
    function toggle(row: Row): void {
      if (!row.expandable) return;
      if (row.depth === 0 && (query || filtering())) { if (row.expanded) expanded.add("-" + row.key); else expanded.delete("-" + row.key); }
      else if (row.expanded) expanded.delete(row.key); else expanded.add(row.key);
      if (row.depth === 0 && !row.expanded) void loadGroup(row.group);
      refresh();
    }

    // ---- events
    rowsEl.addEventListener("mousedown", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>(".klib-row"); if (!el) return;
      const row = rows[+el.dataset.i!]; if (!row) return;
      if ((ev.target as HTMLElement).classList.contains("klib-tw")) { select(row.key); toggle(row); ev.preventDefault(); return; }
      select(row.key);
    });
    rowsEl.addEventListener("dblclick", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>(".klib-row"); if (!el) return;
      const row = rows[+el.dataset.i!]; if (!row || (ev.target as HTMLElement).classList.contains("klib-tw")) return;
      if (row.item) accept(); else toggle(row);
    });
    tree.addEventListener("scroll", queueDraw);
    const onFilterToggle = () => { saveFpFilterPrefs(fpFiltering()); tree.scrollTop = 0; refresh(); };
    if (byPinsBox) byPinsBox.addEventListener("change", onFilterToggle);
    if (byFiltersBox) byFiltersBox.addEventListener("change", onFilterToggle);
    input.addEventListener("input", () => {
      query = input.value.trim(); filterBox.classList.toggle("has-text", !!input.value);
      tree.scrollTop = 0; refresh(true);
      // show the vendor search as busy from the first keystroke, not only once the debounce fires
      if (query) for (const g of sourceGroups.values()) if (g.src && groups.includes(g)) { g.loading = true; g.error = ""; }
      window.clearTimeout(sourceTimer); sourceTimer = window.setTimeout(searchSources, 250);
      if (query) queueRefresh();
    });
    $<HTMLElement>(".klib-clear").addEventListener("click", () => { input.value = ""; input.dispatchEvent(new Event("input")); input.focus(); });
    $<HTMLElement>(".klib-cancel").addEventListener("click", () => close(null));
    $<HTMLElement>(".kd-x").addEventListener("click", () => close(null));
    okBtn.addEventListener("click", accept);
    // DIALOG_SHIM: a click on the frame behind a modal dialog does nothing (only OK / Cancel / Esc / the close box end it)
    function move(delta: number): void {
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.key === selKey);
      i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + delta));
      select(rows[i].key);
    }
    // The dialog is modal: it sees every key first, so the editor's hotkeys stay asleep behind it.
    function onKey(ev: KeyboardEvent): void {
      if (closed) return;
      const inDialog = dlg.contains(ev.target as Node), inText = ev.target === input;
      const page = Math.max(1, Math.floor((tree.clientHeight || 300) / ROW_H) - 1);
      const row = selectedRow();
      let handled = true;
      switch (ev.key) {
        case "Escape": close(null); break;
        case "Enter": if (ev.target instanceof HTMLButtonElement) { handled = false; break; } if (row && row.item) accept(); else if (row) toggle(row); break;
        case "ArrowDown": move(1); break;
        case "ArrowUp": move(-1); break;
        case "PageDown": move(page); break;
        case "PageUp": move(-page); break;
        case "ArrowRight": if (inText) { handled = false; break; } if (row && row.expandable && !row.expanded) toggle(row); else move(1); break;
        case "ArrowLeft": if (inText) { handled = false; break; }
          if (row && row.expandable && row.expanded) toggle(row);
          else if (row && row.depth > 0) { const parent = row.depth === 2 ? row.key.replace(/#\d+$/, "") : row.group.key; select(parent); }
          break;
        default: handled = false;
      }
      if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      if (!inDialog) { if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) input.focus(); else if (ev.key !== "Tab") { ev.stopImmediatePropagation(); ev.preventDefault(); } return; }
      // typing anywhere in the dialog goes to the filter, as in KiCad's tree
      if (!inText && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !(ev.target instanceof HTMLInputElement) && !(ev.target instanceof HTMLButtonElement && ev.key === " ")) input.focus();
      ev.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);

    // the title bar drags the dialog, the splitter resizes the two halves, previews follow the box
    const titleBar = $<HTMLElement>(".kd-title"); let dragFrom: [number, number] | null = null;
    titleBar.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).classList.contains("kd-x")) return;
      const r = dlg.getBoundingClientRect(); dragFrom = [ev.clientX - r.left, ev.clientY - r.top];
      dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px"; titleBar.setPointerCapture(ev.pointerId);
    });
    titleBar.addEventListener("pointermove", (ev) => { if (!dragFrom) return; dlg.style.left = Math.max(0, ev.clientX - dragFrom[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - dragFrom[1]) + "px"; });
    titleBar.addEventListener("pointerup", () => { dragFrom = null; });
    const split = $<HTMLElement>(".klib-split"), mainEl = $<HTMLElement>(".klib-main"); let splitting = false;
    split.addEventListener("pointerdown", (ev) => { splitting = true; split.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    split.addEventListener("pointermove", (ev) => {
      if (!splitting) return; const r = mainEl.getBoundingClientRect();
      const left = Math.max(320, Math.min(r.width - 250, ev.clientX - r.left - 10));
      mainEl.style.gridTemplateColumns = `${left}px 5px minmax(240px, 1fr)`;
    });
    split.addEventListener("pointerup", () => { splitting = false; });
    let redraw = 0;
    const ro = new ResizeObserver(() => { queueDraw(); window.clearTimeout(redraw); redraw = window.setTimeout(() => { if (!closed) showSelection(); }, 120); });
    ro.observe(tree); ro.observe(mainCanvas);

    refresh(); blank(); searchSources();
    input.focus(); input.select();
  });
}
