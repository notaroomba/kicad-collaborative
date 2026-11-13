// dialogs/erc.ts — Inspect → Electrical Rules Checker: eeschema/dialogs/dialog_erc.cpp (DIALOG_ERC).  A modeless
// dialog with the "Violations (n)" and "Ignored Tests (n)" pages: each violation is its rule title with the item
// lines under it ("@(x mm, y mm): …"); a click selects the marker and, with "Cross-probe Selected Items", its items
// and centres the view on it (OnERCItemSelected); a right-click offers DIALOG_ERC::OnERCItemRClick's menu (exclude,
// exclude with comment, remove the exclusion, change the rule's severity, ignore it, edit the severities or the
// pin conflict map); "Show: All / Errors / Warnings / Exclusions" filter the list with their counts, "Save..." writes
// ERC_REPORT::GetTextReport, the options button holds the three cross-probe options, "Delete Marker" / "Delete All
// Markers" clear them and "Run ERC" (the default button) runs the checks with the project's rule severities.
//
// Exclusions live with the markers for this session: a re-run excludes the same violations again (the rule, the
// position and the items match), as SCHEMATIC::ResolveERCExclusions does with the project's list.
import { E, applyView, centerOn, requestRender, toast, toolCtx } from "./editor";
import { syntaxHelp } from "../editor/syntax-help";
import { KD, checkbox, download, h, popupMenu, promptText, type DlgApi, type PopItem } from "./dom";
import { ERC_RULES, defaultSeverity, stepMarker } from "./erc-rules";
import { obj, projectJson, saveProject } from "./project";
import { openSchematicSetup } from "./schematic-setup";

export interface ErcViolation { code: string; severity: string; x: number; y: number; text: string; ids: string[]; excluded?: boolean; comment?: string; sev0?: string; selected?: boolean }

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
/** The identity of a violation for its exclusion: the rule, the position and the items (ERC_EXCLUSION's sort key). */
export const exclusionKey = (m: Pick<ErcViolation, "code" | "x" | "y" | "ids">): string => `${m.code}|${fmt(m.x)}|${fmt(m.y)}|${m.ids.join(",")}`;
const exclusions = new Map<string, string>();   // key -> comment
/** Mark a marker excluded (or not): it is drawn and counted as an exclusion, its own severity kept for the way back. */
export function setExcluded(m: ErcViolation, on: boolean, comment = ""): void {
  if (on) { if (!m.excluded) m.sev0 = m.severity; m.excluded = true; m.comment = comment; m.severity = "exclusion"; exclusions.set(exclusionKey(m), comment); }
  else { if (m.excluded) m.severity = m.sev0 || "error"; m.excluded = false; m.comment = ""; delete m.sev0; exclusions.delete(exclusionKey(m)); }
}
/** A fresh run's markers take this session's exclusions again (SCHEMATIC::ResolveERCExclusions). */
export function applyExclusions<T extends ErcViolation>(list: T[]): T[] {
  for (const m of list) { const c = exclusions.get(exclusionKey(m)); if (c !== undefined) { m.sev0 = m.severity; m.excluded = true; m.comment = c; m.severity = "exclusion"; } }
  return list;
}
/** The severity a marker reports under (an excluded one keeps the rule's). */
const baseSeverity = (m: ErcViolation): string => (m.excluded ? m.sev0 || "error" : m.severity);

interface SchModule { actions?: Record<string, { run(ctx: unknown, opts?: unknown): unknown }>; state: { markers?: ErcViolation[] }; itemDescription?(d: KDoc, id: string, u: string): string }
const sch = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools || {}).sch || null;
export const markers = (): ErcViolation[] => ((E as unknown as { markers?: ErcViolation[] }).markers || []).filter((m) => m && typeof m.code === "string");
/** Hand a changed marker list (or the same list, changed) to the canvas and the module. */
function publishMarkers(l: ErcViolation[]): void { const ctx = toolCtx() as unknown as { setMarkers?(l: unknown[]): void }; const s = sch(); if (s) s.state.markers = l; if (ctx.setMarkers) ctx.setMarkers(l); else requestRender(); }
const describe = (id: string): string => { const s = sch(), d = E.kdoc as KDoc | null; return (s && s.itemDescription && d && s.itemDescription(d, id, "mm")) || id; };

// ---------------------------------------------------------------- the canvas side: the marker selected on the sheet
/** The marker selected on the canvas (SCH_SELECTION_TOOL with a SCH_MARKER_T), or null. */
export function selectedMarker(): ErcViolation | null { return markers().find((m) => m.selected) || null; }
export function selectMarker(m: ErcViolation | null): void { for (const x of markers()) if (x.selected && x !== m) delete x.selected; if (m) m.selected = true; requestRender(); }

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
  if (m && !m.excluded) { setExcluded(m, true); publishMarkers(markers()); }
}
/** SCH_INSPECTION_TOOL::CrossProbe( marker ): the dialog comes up (or forward) with the marker's row picked. */
export function ercCrossProbe(m: ErcViolation, open: boolean): void {
  if (!isLive()) { if (!open) return; openErc(); }
  if (isLive()) live!.show(m);
}
/** Find Next Marker (Ctrl+Shift+F3, SCH_FIND_REPLACE_TOOL with data.markersOnly): the next marker on the sheet, selected and centred. */
export function findNextMarker(): boolean {
  const all = markers().filter((m) => !m.excluded); if (!all.length) return false;
  // nextMatch walks the screen's items in their sorted order: top to bottom, then left to right
  const order = all.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const cur = selectedMarker(), i = cur ? order.indexOf(cur) : -1, m = order[(i + 1) % order.length];
  const ctx = toolCtx(); ctx.setSelection([]); selectMarker(m);
  if (E.zoom < 2) { E.zoom = 3; E.viewTouched = true; applyView(); }
  centerOn(m.x, m.y);
  if (isLive()) live!.show(m);
  const hooks = (E as unknown as { hooks?: { markerSelectionChanged?: () => void } }).hooks; if (hooks && hooks.markerSelectionChanged) hooks.markerSelectionChanged();
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

/** ERC_REPORT::GetTextReport for the markers of this sheet. */
export function ercTextReport(list: ErcViolation[], sev: Record<string, unknown>, sheetPath = "/"): string {
  const now = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
  const tz = -now.getTimezoneOffset(), tzs = `${tz >= 0 ? "+" : "-"}${p2(Math.floor(Math.abs(tz) / 60))}${p2(Math.abs(tz) % 60)}`;
  const iso = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}${tzs}`;
  let msg = `ERC report (${iso}, Encoding UTF8)\nReport includes: Errors, Warnings\n`;
  let err = 0, warn = 0, total = 0;
  msg += `\n***** Sheet ${sheetPath}\n`;
  const sevName = (s: string) => (s === "error" ? "error" : s === "warning" ? "warning" : s === "ignore" ? "ignore" : "info");
  for (const m of list) {
    const s = m.code === "pin_to_pin" ? baseSeverity(m) : severityOf(m.code, sev); total++;
    if (s === "error") err++; else if (s === "warning") warn++;
    const head = `[${m.code}]: ${unescape(m.text)}\n    ; ${sevName(s)}${m.excluded ? " (excluded)" : ""}\n`;
    msg += head + m.ids.slice(0, 2).map((id) => `    @(${fmt(m.x)} mm, ${fmt(m.y)} mm): ${describe(id)}\n`).join("");
  }
  msg += `\n ** ERC messages: ${total}  Errors ${err}  Warnings ${warn}\n`;
  msg += "\n ** Ignored checks:\n";
  const ign: string[] = []; for (const r of ERC_RULES) if (r.length === 2 && severityOf(r[1], sev) === "ignore") ign.push(r[0]);
  msg += ign.length ? ign.map((t) => `    - ${t}\n`).join("") : "    - None\n";
  return msg;
}

export function openErc(): void {
  let list: HTMLElement, vioTab: HTMLElement | null = null, ignTab: HTMLElement | null = null, ignHost: HTMLElement | null = null, current: ErcViolation | null = null;
  let nb: { select(i: number): void } | null = null;
  const shown = (m: ErcViolation): boolean => (m.excluded ? show.exclusions : m.severity === "error" ? show.errors : show.warnings);
  const fillIgnored = () => {
    const ign = ignoredTests(severities());
    if (ignTab) ignTab.textContent = `Ignored Tests (${ign.length})`;
    if (ignHost) ignHost.replaceChildren(...(ign.length ? ign.map((t) => h("div", null, " • " + t)) : []));
  };
  const refresh = () => {
    const all = markers(), errors = all.filter((m) => !m.excluded && m.severity === "error").length, excl = all.filter((m) => m.excluded).length, warnings = all.length - errors - excl;
    if (vioTab) vioTab.textContent = `Violations (${all.filter(shown).length})`;
    const cnt = api && api.body.querySelectorAll<HTMLElement>("[data-erc-count]"); if (cnt) cnt.forEach((e) => { e.textContent = e.dataset.ercCount === "errors" ? String(errors) : e.dataset.ercCount === "warnings" ? String(warnings) : String(excl); });
    list.innerHTML = "";
    const rows = all.filter(shown);
    if (!rows.length) list.append(h("div", { class: "kd-note", style: "padding:6px" }, all.length ? "No violations of the shown severities." : "No violations. Run ERC to check the schematic."));
    for (const m of rows) {
      const i = all.indexOf(m), sel = m === current;
      const sev = m.excluded ? "--ink-3" : m.severity === "error" ? "--err" : "--warn";
      const row = h("div", { "data-erc-row": String(i), "data-excluded": m.excluded ? "1" : undefined, style: `padding:3px 6px;cursor:default;border-bottom:1px solid var(--line);${sel ? "background:var(--blue);color:var(--panel)" : m.excluded ? "color:var(--ink-3)" : ""}`,
        onclick: () => pick(m), oncontextmenu: (ev: Event) => { const me = ev as MouseEvent; me.preventDefault(); pick(m); rowMenu(m, me.clientX, me.clientY); } },
        h("div", { style: "display:flex;gap:6px;align-items:center" }, h("span", { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:var(${sev})` }), h("b", null, ruleTitle(m))),
        h("div", { style: "padding-left:14px;font-family:var(--mono);font-size:12px" }, itemLine(m)),
        m.excluded && m.comment ? h("div", { style: "padding-left:14px;font-size:12px", "data-erc-comment": "1" }, m.comment) : null);
      list.append(row);
    }
    fillIgnored();
  };
  // DIALOG_ERC::OnERCItemSelected: the marker is selected; with cross-probing its items are and the view centres on it
  const pick = (m: ErcViolation, fromCanvas = false) => {
    current = m;
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
  const exclude = (m: ErcViolation, on: boolean, comment = "") => { setExcluded(m, on, comment); publishMarkers(markers()); refresh(); };
  // ERC_SETTINGS::SetSeverity into the .kicad_pro; ignored rules' markers go, the others take the new level
  const setSeverity = (code: string, sev: string) => {
    if (E.viewOnly) { toast("View-only access"); return; }
    void saveProject((pro) => { const e = obj(pro.erc); pro.erc = e; e.rule_severities = Object.assign({}, obj(e.rule_severities), { [code]: sev }); }, "ERC severity").then(() => {
      let all = markers();
      if (sev === "ignore") { all = all.filter((m) => m.code !== code); if (current && current.code === code) current = null; }
      else for (const m of all) if (m.code === code) { if (m.excluded) m.sev0 = sev; else m.severity = sev; }
      publishMarkers(all); refresh();
    }).catch((e: Error) => toast(`Could not change the severity: ${e.message}`, 5000));
  };
  const rowMenu = (m: ErcViolation, x: number, y: number) => {
    const sev = severityOf(m.code), et = ruleTitle(m);
    const items: PopItem[] = m.excluded
      ? [{ label: "Remove exclusion for this violation", run: () => exclude(m, false) },
         { label: "Edit exclusion comment...", run: () => { void promptText("Exclusion Comment", "", m.comment || "").then((t) => { if (t !== null) exclude(m, true, t); }); } }]
      : [{ label: "Exclude this violation", run: () => exclude(m, true) },
         { label: "Exclude with comment...", run: () => { void promptText("Exclusion Comment", "", "").then((t) => { if (t !== null) exclude(m, true, t); }); } }];
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
      const all = markers(), i = stepMarker(shownRows(), current ? all.indexOf(current) : -1, dir); const m = i === null ? null : all[i]; if (!m) return;
      pick(m);
    },
    show(m) { if (nb) nb.select(0); pick(m, true); },
    exclude(m) { const t = m || current; if (t && !t.excluded) exclude(t, true); },
    refresh() { refresh(); },
  };
  const run = () => { const s = sch(); const a = s && s.actions && s.actions.runERC; if (!a) return; a.run(toolCtx(), { showAllErrors: opts.showAllErrors }); current = null; refresh(); };
  // DIALOG_ERC::OnDeleteOneClick / OnDeleteAllClick
  const delOne = () => { if (!current) return; const c = current; current = null; if (c.excluded) exclusions.delete(exclusionKey(c)); publishMarkers(markers().filter((m) => m !== c)); refresh(); };
  const delAll = () => { current = null; publishMarkers(markers().filter((m) => m.excluded)); refresh(); };
  const save = () => download("ERC.rpt", ercTextReport(markers(), severities(), ((E.kdoc as KDoc & { sheetPath?: string } | null)?.sheetPath) || "/"), "text/plain;charset=utf-8");
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
          const link = h("a", { href: "#", id: "kd-erc-edit-ignored", style: "display:inline-block;margin-top:6px;color:var(--blue)" }, "Edit ignored tests");
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
        h("button", { class: "btn sm", type: "button", id: "kd-erc-save", onclick: save }, "Save..."));
      const del = h("div", { style: "display:flex;gap:8px;margin-top:8px" },
        h("button", { class: "btn sm", type: "button", id: "kd-erc-delete", onclick: delOne }, "Delete Marker"),
        h("button", { class: "btn sm", type: "button", id: "kd-erc-delete-all", onclick: delAll }, "Delete All Markers"));
      body.append(filt, del);
      const tabs = book.el.querySelectorAll<HTMLElement>(".kd-nb-tab"); vioTab = tabs[0] || null; ignTab = tabs[1] || null;
    },
    buttons: [{ label: "Run ERC", primary: true, isDefault: true, fn: run, id: "kd-erc-run" }, { label: "Close", close: true }],
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
