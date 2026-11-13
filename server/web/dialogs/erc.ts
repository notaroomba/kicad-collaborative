// dialogs/erc.ts — Inspect → Electrical Rules Checker: eeschema/dialogs/dialog_erc.cpp (DIALOG_ERC).  A modeless
// dialog with the "Violations (n)" and "Ignored Tests (n)" pages: each violation is its rule title with the item
// lines under it ("@(x mm, y mm): …"); a click selects the marker and, with "Cross-probe Selected Items", its items
// and centres the view on it (OnERCItemSelected); a right-click offers DIALOG_ERC::OnERCItemRClick's menu (exclude,
// exclude with comment, remove the exclusion, change the rule's severity, ignore it, edit the severities or the
// pin conflict map); "Show: All / Errors / Warnings / Exclusions" filter the list with their counts, "Save..." writes
// ERC_REPORT::GetTextReport, the options button holds the three cross-probe options, "Delete Marker" / "Delete All
// Markers" clear them and "Run ERC" (the default button) runs the checks with the project's rule severities.
//
// Exclusions are kept in the project's erc_exclusions (ERC_SETTINGS::m_ErcExclusions) in the form its erc schema
// already uses, so a re-run excludes the same violations again (SCHEMATIC::ResolveERCExclusions).
import { E, appState, applyView, centerOn, openDocId, requestRender, store, toast, toolCtx } from "./editor";
import { preferInstance } from "../editor/schnets";
import { setStatusBar } from "../editor/appstore";
import { syntaxHelp } from "../editor/syntax-help";
import { KD, checkbox, download, h, popupMenu, type DlgApi, type PopItem } from "./dom";
import { ERC_RULES, defaultSeverity, stepMarker } from "./erc-rules";
import { dropRule, markExcluded, readExclusions, sameViolation, setExcluded } from "./erc-exclusions";
import { obj, projectJson, saveProject, sub } from "./project";
import { openSchematicSetup } from "./schematic-setup";
import { messageBox, textEntryBox } from "../editor/pcbdialogs/ui";
import type { Units } from "../store";
import { ercTextReport, sevOf, shownBy } from "./erc-report";
import { sheetList, type SheetInstance } from "./sch-hierarchy";
import { allMarkers, distribute, ercProjectOpts, forgetHierErc, onOpenSheet, onSheetOpened, runHierErc, runSheetList, type HierMarker } from "./erc-hier";
import { findSearchesAllSheets } from "./find";
export { ercTextReport, sevOf, shownBy };

export interface ErcViolation { code: string; severity: string; x: number; y: number; text: string; ids: string[]; base?: string; comment?: string; selected?: boolean; items?: { x: number; y: number; desc: string; len?: number }[] }

const RULE_TITLE = new Map<string, string>(ERC_RULES.filter((r): r is [string, string] => r.length === 2).map(([title, key]) => [key, title]));
/** The rule title KiCad shows for a violation (ERC_ITEM::GetErrorText), falling back to the marker's own text. */
export function ruleTitle(v: Pick<ErcViolation, "code" | "text">): string { return RULE_TITLE.get(v.code) || unescape(v.text); }
const fmt = (v: number): string => (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
/** The item line under a violation: "@(76.2 mm, 41.9 mm): Symbol R1 is not annotated" (millimetres as the status bar). */
export function itemLine(v: Pick<ErcViolation, "x" | "y" | "text">): string { return `@(${fmt(v.x)} mm, ${fmt(v.y)} mm): ${unescape(v.text)}`; }
/** UnescapeString: net and label names are shown as typed ({slash} → /), as KiCad's GetShownText. */
const unescape = (s: string): string => { const K = (window as unknown as { KiCadCanvas?: { unescapeText?(s: string): string } }).KiCadCanvas; return K && K.unescapeText ? K.unescapeText(s) : s; };
/** The rules the project sets to "ignore" (the Ignored Tests page), in dialog order. */
export function ignoredTests(severities: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const r of ERC_RULES) if (r.length === 2) { const s = typeof severities[r[1]] === "string" ? String(severities[r[1]]) : defaultSeverity(r[1]); if (s === "ignore") out.push(r[0]); }
  return out;
}
const severities = (): Record<string, unknown> => obj(obj(projectJson().erc).rule_severities) as Record<string, unknown>;
/** ERC_SETTINGS::GetSeverity of a rule. */
export function severityOf(code: string, sev: Record<string, unknown> = severities()): string { return typeof sev[code] === "string" ? String(sev[code]) : defaultSeverity(code); }

// ---------------------------------------------------------------- exclusions (SCH_MARKER::SetExcluded)
/** An excluded marker shows as an exclusion, its rule's severity kept as base. */
export const isExcluded = (m: Pick<ErcViolation, "severity">): boolean => m.severity === "exclusion";
/** Apply the project's exclusions to the marker list (SCHEMATIC::ResolveERCExclusions). */
export function withExclusions<T extends ErcViolation>(list: T[]): T[] { return markExcluded(list, readExclusions(obj(projectJson().erc))) as T[]; }
/** The same violation in another copy of the marker list (the rule, the position and the items). */
const sameMarker = (a: ErcViolation, b: ErcViolation): boolean => sameViolation(a, { ...b, comment: "" }) && a.ids.join(",") === b.ids.join(",");
/** SCH_MARKER::SetExcluded + RecordERCExclusions: add, re-comment or drop the violation's entry in the .kicad_pro, then re-resolve. */
function storeExclusion(m: ErcViolation, on: boolean, comment = ""): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return Promise.resolve(); }
  return saveProject((pro) => { setExcluded(sub(pro, "erc") as never, { ...m, severity: sevOf(m) }, on, comment); }, on ? "ERC exclusion" : "remove ERC exclusion")
    .then(() => { publishMarkers(withExclusions(markers())); })
    .catch((e: Error) => toast(`Could not change the exclusion: ${e.message}`, 5000));
}

interface SchModule { actions?: Record<string, { run(ctx: unknown, opts?: unknown): unknown }>; state: { markers?: ErcViolation[] }; itemDescription?(d: KDoc, id: string, u: string): string }
const sch = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools || {}).sch || null;
/** The open sheet's markers (on the canvas). */
const liveMarkers = (): ErcViolation[] => ((E as unknown as { markers?: ErcViolation[] }).markers || []).filter((m) => m && typeof m.code === "string");
/** Every marker of the hierarchy the last Run ERC found (the open sheet's are the canvas list itself). */
export const markers = (): ErcViolation[] => allMarkers(liveMarkers() as unknown as HierMarker[]) as unknown as ErcViolation[];
const hereDoc = (): string | null => (appState as unknown as { docId: string | null }).docId;
const onOtherSheet = (m: ErcViolation): boolean => !onOpenSheet(m as { docId?: string; sheetKey?: string });
/** Hand a changed marker list (or the same list, changed) to the canvas and the module: each sheet keeps its own. */
function publishMarkers(all: ErcViolation[]): void {
  const l = distribute(all as unknown as HierMarker[]) as unknown as ErcViolation[];
  const s = sch(); if (s) s.state.markers = l;
  const EE = E as unknown as { markers: unknown[]; renderOpts: Record<string, unknown> };
  EE.markers = l; EE.renderOpts.markers = l.length ? l : undefined; store.slice("viewport", { renderOpts: Object.assign({}, EE.renderOpts) }); requestRender();
}

// ---------------------------------------------------------------- the canvas side: the marker selected on the sheet
/** The marker selected on the canvas (SCH_SELECTION_TOOL with a SCH_MARKER_T), or null. */
export function selectedMarker(): ErcViolation | null { return markers().find((m) => m.selected) || null; }
export function selectMarker(m: ErcViolation | null): void { for (const x of markers()) if (x.selected && x !== m) delete x.selected; if (m) m.selected = true; requestRender(); }
/** The marker of the current list that is `m` (exclusions re-resolve the list into fresh copies). */
const resolveMarker = (m: ErcViolation | null): ErcViolation | null => (m ? markers().find((x) => x === m) || markers().find((x) => sameMarker(x, m)) || null : null);

// ---------------------------------------------------------------- DIALOG_ERC::OnERCItemRClick's Inspect / Fix entries
type Handlers = Record<string, ((a?: unknown) => void) | undefined>;
const handlers = (): Handlers => ((E as unknown as { api?: { HANDLERS?: Handlers } }).api?.HANDLERS) || {};
/** The violation's main item, selected on the sheet (ResolveItem( GetMainItemID() )), or null. */
function mainItem(m: ErcViolation): KItem | null {
  const d = E.kdoc as KDoc | null, id = m.ids.find((x) => d && d.items.has(x)); if (!d || !id) return null;
  return d.items.get(id) || null;
}
function runOn(m: ErcViolation, act: string): void {
  const it = mainItem(m), h = handlers()[act]; if (!it || !h) return;
  toolCtx().setSelection([it.id]); h();
}
/**
 * SCH_INSPECTION_TOOL::InspectERCErrorMenuText / InspectERCError, then SCH_EDIT_TOOL::FixERCErrorMenuText / FixERCError
 * (a command the web editor does not have is listed disabled).
 */
export function fixEntries(m: ErcViolation): PopItem[] {
  const out: PopItem[] = [], hs = handlers();
  const run = (label: string, act: string, fn: () => void): void => { out.push(hs[act] ? { label, run: fn } : { label, disabled: true }); };
  if (m.code === "bus_to_net_conflict") out.push({ label: "Run: Inspect > Show Bus Syntax Help", run: () => syntaxHelp(false) });
  else if (m.code === "lib_symbol_mismatch") run("Run: Inspect > Compare Symbol with Library", "diffSymbol", () => runOn(m, "diffSymbol"));
  switch (m.code) {
    case "simulation_model_issue": case "footprint_filter": case "footprint_link_issues":
      run("Edit Symbol Properties...", "properties", () => runOn(m, "properties")); break;
    case "lib_symbol_issues": run("Run: Preferences > Manage Symbol Libraries...", "showSymbolLibTable", () => hs.showSymbolLibTable?.()); break;
    case "lib_symbol_mismatch": run("Run: Update Symbol...", "updateSymbol", () => runOn(m, "updateSymbol")); break;
    case "unannotated": case "duplicate_reference": run("Run: Tools > Annotate Schematic...", "annotate", () => hs.annotate?.()); break;
    case "undefined_netclass": out.push({ label: "Edit Netclasses...", run: () => openSchematicSetup("Net Classes") }); break;
    case "empty_label_name": out.push({ label: "Remove Empty Label", run: () => {
      const it = mainItem(m), s = sch() as (SchModule & { _?: { deleteChanges?(d: KDoc, it: KItem): KChange[] } }) | null, ctx = toolCtx();
      if (!it || !/label$/.test(it.kind) || !s || !s._ || !s._.deleteChanges) return;
      ctx.setSelection([]); ctx.commit(s._.deleteChanges(ctx.doc as KDoc, it), "Remove Empty Label");
    } }); break;
  }
  return out;
}

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
/** The open dialog's handles (SCH_INSPECTION_TOOL::PrevMarker / NextMarker / ExcludeMarker / CrossProbe reach DIALOG_ERC only while it exists). */
let live: { step(dir: 1 | -1): void; show(m: ErcViolation): void; exclude(m: ErcViolation | null): void; refresh(): void } | null = null;
const isLive = (): boolean => { if (live && api && api.body.isConnected) return true; live = null; return false; };
export function ercPrevMarker(): void { if (isLive()) live!.step(-1); else { openErc(); if (isLive()) live!.step(-1); } }
export function ercNextMarker(): void { if (isLive()) live!.step(1); else { openErc(); if (isLive()) live!.step(1); } }
/** SCH_INSPECTION_TOOL::ExcludeMarker: the marker selected on the canvas, else the dialog's current row. */
export function ercExcludeMarker(): void {
  const m = selectedMarker();
  if (isLive()) { live!.exclude(m); return; }
  if (m && !isExcluded(m)) void storeExclusion(m, true);
}
/** SCH_INSPECTION_TOOL::CrossProbe( marker ): the dialog comes up (or forward) with the marker's row picked. */
export function ercCrossProbe(m: ErcViolation, open: boolean): void {
  if (!isLive()) { if (!open) return; openErc(); }
  if (isLive()) live!.show(m);
}
/** nextMatch's order over a screen's markers (top to bottom, then left to right); excluded ones are skipped. */
const screenOrder = (l: ErcViolation[]): ErcViolation[] => l.filter((m) => !isExcluded(m)).sort((a, b) => (a.y - b.y) || (a.x - b.x));
/** The found marker: selected alone and centred (FindNext's ClearSelection / AddItemToSel / FocusOnLocation). */
function focusMarker(m: ErcViolation): void {
  const ctx = toolCtx(); ctx.setSelection([]); selectMarker(m);
  if (E.zoom < 2) { E.zoom = 3; E.viewTouched = true; applyView(); }
  centerOn(m.x, m.y);
  if (isLive()) live!.show(m);
  const hooks = (E as unknown as { hooks?: { markerSelectionChanged?: () => void } }).hooks; if (hooks && hooks.markerSelectionChanged) hooks.markerSelectionChanged();
}
/** SCH_ACTIONS::changeSheet to a run's sheet instance, then `then` once it is on screen. */
function changeSheet(sh: { docId: string; sheetPath: string }, then: () => void): void {
  preferInstance(sh.sheetPath);
  if (sh.docId === hereDoc()) { onSheetOpened(); then(); return; }
  const before = E.kdoc; openDocId(sh.docId);
  let tries = 0; const wait = (): void => { if (E.kdoc && E.kdoc !== before && hereDoc() === sh.docId) { onSheetOpened(); then(); return; } if (++tries < 100) setTimeout(wait, 100); };
  setTimeout(wait, 100);
}
/**
 * Find Next Marker (Ctrl+Shift+F3, SCH_FIND_REPLACE_TOOL::FindNext with data.markersOnly): nextMatch walks the current
 * screen's markers after the found one; past the last, unless the Find dialog searches the current sheet only, the
 * sheets that follow in page order (SCH_ACTIONS::changeSheet to the first with a marker); then it wraps around
 * ("Reached end of schematic.").  Another sheet's markers are never selected without opening that sheet.
 */
export function findNextMarker(): boolean {
  const here = screenOrder(liveMarkers()), cur = here.find((m) => m.selected) || null;
  const i = cur ? here.indexOf(cur) : -1;
  if (i + 1 < here.length) { focusMarker(here[i + 1]); return true; }
  const { sheets, open } = runSheetList();
  const firstOn = (k: number): ErcViolation | null => { const l = screenOrder((sheets[k].markers as unknown as ErcViolation[])); return l[0] || null; };
  const goTo = (k: number, wrapped: boolean): boolean => {
    if (k === open) { const m = here[0]; if (!m) return false; focusMarker(m); }
    else changeSheet(sheets[k], () => { const m = screenOrder(liveMarkers())[0]; if (m) focusMarker(m); });
    if (wrapped) setStatusBar({ message: "Reached end of schematic." });
    return true;
  };
  if (findSearchesAllSheets() && sheets.length && open >= 0) {
    // a fresh session (nothing found yet) starts at the first sheet; else at the one after the current sheet
    for (let k = cur ? open + 1 : 0; k < sheets.length; k++) if (k !== open && firstOn(k)) return goTo(k, false);
    if (!cur) { setStatusBar({ message: "No matches found." }); return false; }
    for (let k = 0; k < sheets.length; k++) if (k === open ? here.length : firstOn(k)) return goTo(k, true);
    return false;
  }
  if (!here.length) { setStatusBar({ message: "No matches found." }); return false; }
  focusMarker(here[0]);
  if (cur) setStatusBar({ message: findSearchesAllSheets() ? "Reached end of schematic." : "Reached end of sheet." });
  return true;
}

// ---------------------------------------------------------------- the dialog's persisted options (DIALOG_ERC m_crossprobe …)
const OPTS_KEY = "kui.erc.options";
const opts = ((): { crossprobe: boolean; scrollOnCrossprobe: boolean; showAllErrors: boolean } => {
  const d = { crossprobe: true, scrollOnCrossprobe: true, showAllErrors: false };
  try { const s = JSON.parse(localStorage.getItem(OPTS_KEY) || "null"); if (s && typeof s === "object") Object.assign(d, s); } catch { /* storage blocked */ }
  return d;
})();
const saveOpts = (): void => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* storage blocked */ } };
export function ercShowAllErrors(): boolean { return opts.showAllErrors; }
const show = { errors: true, warnings: true, exclusions: false };

/** wxDateTime::Now().FormatISOCombined('T'): local time, no zone. */
const isoNow = (): string => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

export function openErc(): void {
  let list: HTMLElement, vioTab: HTMLElement | null = null, ignTab: HTMLElement | null = null, ignHost: HTMLElement | null = null, current: ErcViolation | null = null;
  let nb: { select(i: number): void } | null = null;
  const shown = (m: ErcViolation): boolean => shownBy(m, show);
  const fillIgnored = () => {
    const ign = ignoredTests(severities());
    if (ignTab) ignTab.textContent = `Ignored Tests (${ign.length})`;
    if (ignHost) ignHost.replaceChildren(...(ign.length ? ign.map((t) => h("div", null, " • " + t)) : []));
  };
  const refresh = () => {
    const all = markers(), errors = all.filter((m) => m.severity === "error").length, excl = all.filter(isExcluded).length, warnings = all.length - errors - excl;
    if (vioTab) vioTab.textContent = `Violations (${all.filter(shown).length})`;
    const cnt = api && api.body.querySelectorAll<HTMLElement>("[data-erc-count]"); if (cnt) cnt.forEach((e) => { e.textContent = e.dataset.ercCount === "errors" ? String(errors) : e.dataset.ercCount === "warnings" ? String(warnings) : String(excl); });
    list.innerHTML = "";
    current = resolveMarker(current);
    const rows = all.filter(shown);
    if (!rows.length) list.append(h("div", { class: "kd-note", style: "padding:6px" }, all.length ? "No violations of the shown severities." : "No violations. Run ERC to check the schematic."));
    for (const m of rows) {
      const i = all.indexOf(m), sel = m === current;
      const sev = isExcluded(m) ? "--ink-3" : m.severity === "error" ? "--err" : "--warn";
      const row = h("div", { "data-erc-row": String(i), "data-excluded": isExcluded(m) ? "1" : undefined, style: `padding:3px 6px;cursor:default;border-bottom:1px solid var(--line);${sel ? "background:var(--blue);color:var(--panel)" : isExcluded(m) ? "color:var(--ink-3)" : ""}`,
        onclick: () => pick(m), oncontextmenu: (ev: Event) => { const me = ev as MouseEvent; me.preventDefault(); pick(m); rowMenu(m, me.clientX, me.clientY); } },
        h("div", { style: "display:flex;gap:6px;align-items:center" }, h("span", { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:var(${sev})` }), h("b", null, ruleTitle(m))),
        h("div", { style: "padding-left:14px;font-family:var(--mono);font-size:12px" }, itemLine(m)),
        isExcluded(m) && m.comment ? h("div", { style: "padding-left:14px;font-size:12px;font-style:italic", "data-erc-comment": "1" }, m.comment) : null);
      list.append(row);
    }
    fillIgnored();
  };
  // DIALOG_ERC::OnERCItemSelected: the marker is selected; with cross-probing its items are and the view centres on it
  const pick = (m: ErcViolation, fromCanvas = false, opened = false): void => {
    current = m;
    // a marker on another sheet: that sheet opens (SCH_EDIT_FRAME::FocusOnItem changes the current sheet), then it is picked there
    if (!fromCanvas && !opened && onOtherSheet(m)) {
      const own = m as { docId?: string; sheetPath?: string }, target = own.docId!, before = E.kdoc;
      // the instance of a sheet used more than once (SCH_SHEET_PATH): the hierarchy shows that one
      preferInstance(own.sheetPath || null);
      if (target === hereDoc()) { onSheetOpened(); pick(m, false, true); return; }
      openDocId(target);
      let tries = 0; const wait = (): void => { if (E.kdoc && E.kdoc !== before && hereDoc() === target) { onSheetOpened(); pick(m, false, true); return; } if (++tries < 100) setTimeout(wait, 100); };
      setTimeout(wait, 100); refresh(); return;
    }
    if (!fromCanvas) {
      const ctx = toolCtx();
      if (opts.crossprobe) ctx.setSelection(m.ids.filter((id) => E.kdoc && E.kdoc.items.has(id)));
      selectMarker(m);
      if (opts.crossprobe && opts.scrollOnCrossprobe) { if (E.zoom < 2) { E.zoom = 3; E.viewTouched = true; applyView(); } centerOn(m.x, m.y); }
    }
    refresh();
    const row = list.querySelector<HTMLElement>(`[data-erc-row="${markers().indexOf(m)}"]`); if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  };
  const shownRows = () => markers().map((m, i) => [m, i] as const).filter(([m]) => shown(m)).map(([, i]) => i);
  const exclude = (m: ErcViolation, on: boolean, comment = "") => { void storeExclusion(m, on, comment).then(refresh); };
  // WX_TEXT_ENTRY_DIALOG( …, _( "Exclusion Comment" ), …, true ): a multi-line entry
  const askComment = (initial: string, then: (text: string) => void): void => { textEntryBox("Exclusion Comment", "", initial, true, then); };
  // ERC_SETTINGS::SetSeverity into the .kicad_pro; Ignore drops the rule's exclusions and its markers go (ScreenList.DeleteMarkers),
  // the others take the new level (an exclusion keeps it as its base)
  const setSeverity = (code: string, sev: string) => {
    if (E.viewOnly) { toast("View-only access"); return; }
    void saveProject((pro) => { const e = sub(pro, "erc"); sub(e, "rule_severities")[code] = sev; if (sev === "ignore") dropRule(e as never, code); }, "ERC severity").then(() => {
      let all = markers();
      if (sev === "ignore") { all = all.filter((m) => m.code !== code); if (current && current.code === code) current = null; }
      else for (const m of all) if (m.code === code) { if (isExcluded(m)) m.base = sev; else m.severity = sev; }
      publishMarkers(all); refresh();
    }).catch((e: Error) => toast(`Could not change the severity: ${e.message}`, 5000));
  };
  const rowMenu = (m: ErcViolation, x: number, y: number) => {
    const sev = severityOf(m.code), et = ruleTitle(m);
    const items: PopItem[] = isExcluded(m)
      ? [{ label: "Remove exclusion for this violation", run: () => exclude(m, false) },
         { label: "Edit exclusion comment...", run: () => askComment(m.comment || "", (t) => exclude(m, true, t)) }]
      : [{ label: "Exclude this violation", run: () => exclude(m, true) },
         { label: "Exclude with comment...", run: () => askComment("", (t) => exclude(m, true, t)) }];
    items.push({ sep: true });
    // SCH_INSPECTION_TOOL::InspectERCErrorMenuText then SCH_EDIT_TOOL::FixERCErrorMenuText, a separator after them
    const fixes = fixEntries(m); if (fixes.length) items.push(...fixes, { sep: true });
    if (m.code !== "pin_to_pin") {
      if (sev === "warning") items.push({ label: `Change severity to Error for all '${et}' violations`, run: () => setSeverity(m.code, "error") });
      else items.push({ label: `Change severity to Warning for all '${et}' violations`, run: () => setSeverity(m.code, "warning") });
    }
    items.push({ label: `Ignore all '${et}' violations`, run: () => setSeverity(m.code, "ignore") }, { sep: true });
    if (m.code === "pin_to_pin") items.push({ label: "Edit pin-to-pin conflict map...", run: () => openSchematicSetup("Pin Conflicts Map") });
    else items.push({ label: "Edit violation severities...", run: () => openSchematicSetup("Violation Severity") });
    if (m.code === "endpoint_off_grid") items.push({ label: "Edit connection grid spacing...", run: () => openSchematicSetup("Formatting") });
    popupMenu(x, y, items);
  };
  live = {
    step(dir) {
      const all = markers(), cur = resolveMarker(current), i = stepMarker(shownRows(), cur ? all.indexOf(cur) : -1, dir); const m = i === null ? null : all[i]; if (!m) return;
      pick(m);
    },
    show(m) { if (nb) nb.select(0); pick(m, true); },
    exclude(m) { const t = resolveMarker(m || current); if (t && !isExcluded(t)) exclude(t, true); },
    refresh() { refresh(); },
  };
  // ERC_TESTER::RunTests over the whole hierarchy; a sheet outside it (or no hierarchy known) is checked alone
  const run = async (): Promise<void> => {
    const s = sch(); const a = s && s.actions && s.actions.runERC; if (!a) return;
    const runBtn = api && api.body.ownerDocument.querySelector<HTMLButtonElement>("[data-btn=\"kd-erc-run\"]"); if (runBtn) runBtn.disabled = true;
    try {
      const live = await runHierErc({ showAllErrors: opts.showAllErrors }, (l) => withExclusions(l as unknown as ErcViolation[]) as unknown as HierMarker[]);
      if (!live) { forgetHierErc(); a.run(toolCtx(), Object.assign(ercProjectOpts(), { showAllErrors: opts.showAllErrors })); }
      else {
        onSheetOpened();   // the canvas: this sheet's own markers (the others stay with their sheets)
        const all = markers(), e = all.filter((m) => m.severity === "error").length, w = all.filter((m) => m.severity === "warning").length;
        toast(all.length ? `ERC: ${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}` : "ERC: no problems found");
      }
    } finally { if (runBtn) runBtn.disabled = false; }
    current = null; refresh();
  };
  // DIALOG_ERC::OnDeleteOneClick / OnDeleteAllClick
  const delOne = () => { const c = resolveMarker(current); if (!c) return; current = null; publishMarkers(markers().filter((m) => m !== c)); refresh(); };
  // OnDeleteAllClick: with exclusions about, ask whether they go too (ClearUnresolvedERCExclusions + DeleteAllMarkers)
  const delAll = () => {
    const all = markers(), stored = readExclusions(obj(projectJson().erc));
    const unresolved = stored.filter((ex) => !all.some((m) => isExcluded(m) && sameViolation({ ...m, severity: sevOf(m) }, ex))).length;
    const wipe = (withExcl: boolean): void => {
      if (withExcl && stored.length && !E.viewOnly) void saveProject((pro) => { sub(pro, "erc").erc_exclusions = []; }, "clear ERC exclusions").catch((e: Error) => toast(`Could not clear the exclusions: ${e.message}`, 5000));
      current = null; publishMarkers(withExcl ? [] : all.filter(isExcluded)); refresh();
    };
    if (unresolved + all.filter(isExcluded).length <= 0) { wipe(false); return; }
    messageBox("Delete All Markers", "Delete exclusions too?", [{ label: "Cancel" }, { label: "Errors, Warnings and Exclusions", fn: () => wipe(true) }, { label: "Errors and Warnings Only", fn: () => wipe(false) }], 0);
  };
  // OnSaveReport: ERC.rpt with the shown severities (the browser saves it; KiCad asks for the path first)
  const save = async (): Promise<void> => {
    const u = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
    // BuildSheetListSortedByPageNumbers: a "***** Sheet" block per sheet; a marker goes under its main item's sheet
    let list: SheetInstance[] = []; try { list = await sheetList(); } catch { list = []; }
    const here = list.find((x) => x.docId === appState.docId);
    const sheetOf = (m: ErcViolation): string | null => {
      const ms = (m as { mainSheet?: unknown }).mainSheet, own = (m as { sheetPath?: string; docId?: string });
      if (own.sheetPath && own.docId !== hereDoc()) return own.sheetPath;
      if (typeof ms === "string" && here) { const child = list.find((x) => x.parentDocId === here.docId && x.sheetItemId === ms && x.uuidPath.slice(0, -1).join("/") === here.uuidPath.join("/")); if (child) return child.sheetPath; }
      return here ? here.sheetPath : null;
    };
    const sheets = list.length ? list.map((x) => x.sheetPath) : undefined;
    download("ERC.rpt", ercTextReport(markers(), { ...show, units: u, date: isoNow(), ignored: ignoredTests(severities()), sheets, sheetOf, title: ruleTitle, text: unescape }), "text/plain;charset=utf-8");
  };
  api = KD().open({
    title: "Electrical Rules Checker", width: 640, modeless: true,
    build(body) {
      // m_bMenu: the options button at the top right (DIALOG_ERC::OnMenu)
      const gear = h("button", { class: "btn sm", type: "button", title: "Options", id: "kd-erc-options", style: "padding:2px 6px", "aria-label": "Options" }, "⋯");
      gear.addEventListener("click", () => { const r = gear.getBoundingClientRect(); popupMenu(r.left, r.bottom, [
        { label: "Cross-probe Selected Items", check: true, checked: opts.crossprobe, run: () => { opts.crossprobe = !opts.crossprobe; saveOpts(); } },
        { label: "Center on Cross-probe", check: true, checked: opts.scrollOnCrossprobe, run: () => { opts.scrollOnCrossprobe = !opts.scrollOnCrossprobe; saveOpts(); } },
        { label: "Show all errors", check: true, checked: opts.showAllErrors, run: () => { opts.showAllErrors = !opts.showAllErrors; saveOpts(); } }]); });
      body.append(h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:4px" }, gear));
      const book = KD().notebook(body, [
        { label: "Violations", build(page) {
          list = h("div", { "data-erc-list": "1", style: "height:300px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
          page.append(list);
        } },
        { label: "Ignored Tests", build(page) {
          ignHost = h("div", { "data-erc-ignored": "1", style: "height:276px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:4px 6px" });
          const link = h("a", { href: "#", id: "kd-erc-edit-ignored", "data-k": "edit-ignored", style: "display:inline-block;margin-top:6px;color:var(--blue)" }, "Edit ignored tests");
          link.addEventListener("click", (ev) => { ev.preventDefault(); openSchematicSetup("Violation Severity"); });
          page.append(ignHost, link);
        } },
      ]);
      nb = book;
      // OnSeverity: "All" ticks Errors and sets Warnings and Exclusions to itself
      const filt = h("div", { style: "display:flex;gap:14px;align-items:center;margin:8px 0 0" }, h("span", null, "Show:"),
        checkbox("All", show.errors && show.warnings && show.exclusions, (on) => { show.errors = true; show.warnings = show.exclusions = on; syncBoxes(); refresh(); }, { id: "kd-erc-all" }),
        checkbox("Errors", show.errors, (on) => { show.errors = on; syncBoxes(); refresh(); }, { id: "kd-erc-errors" }), h("span", { "data-erc-count": "errors", class: "kd-badge" }),
        checkbox("Warnings", show.warnings, (on) => { show.warnings = on; syncBoxes(); refresh(); }, { id: "kd-erc-warnings" }), h("span", { "data-erc-count": "warnings", class: "kd-badge" }),
        checkbox("Exclusions", show.exclusions, (on) => { show.exclusions = on; syncBoxes(); refresh(); setRender(); }, { id: "kd-erc-excl" }), h("span", { "data-erc-count": "exclusions", class: "kd-badge" }),
        h("span", { style: "flex:1" }),
        h("button", { class: "btn sm", type: "button", id: "kd-erc-save", onclick: () => { void save(); } }, "Save..."));
      body.append(filt);
      const tabs = book.el.querySelectorAll<HTMLElement>(".kd-nb-tab"); vioTab = tabs[0] || null; ignTab = tabs[1] || null;
    },
    // m_buttonsSizer: Delete Marker / Delete All Markers on the left, then Run ERC / Close
    extra: [{ label: "Delete Marker", fn: delOne, id: "kd-erc-del" }, { label: "Delete All Markers", fn: delAll, id: "kd-erc-delall" }],
    buttons: [{ label: "Run ERC", primary: true, isDefault: true, fn: () => { void run(); }, id: "kd-erc-run" }, { label: "Close", close: true }],
    cancel() { live = null; },
  });
  // the canvas shows exclusions with the dialog's Exclusions box (DIALOG_ERC::syncCheckboxesFromSeverities → show_erc_exclusions)
  function setRender(): void { const ro = (E as unknown as { renderOpts?: Record<string, unknown> }).renderOpts; if (ro) { ro.showErcExclusions = show.exclusions; requestRender(); } }
  function syncBoxes(): void {
    const set = (id: string, on: boolean) => { const e = api && api.body.querySelector<HTMLInputElement>("#" + id); if (e) e.checked = on; };
    set("kd-erc-all", show.errors && show.warnings && show.exclusions); set("kd-erc-errors", show.errors); set("kd-erc-warnings", show.warnings); set("kd-erc-excl", show.exclusions);
  }
  const sel = selectedMarker(); if (sel) current = sel;
  refresh();
}
