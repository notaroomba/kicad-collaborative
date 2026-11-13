// dialogs/erc.ts — Inspect → Electrical Rules Checker: eeschema/dialogs/dialog_erc.cpp (DIALOG_ERC).  A modeless
// dialog with the "Violations (n)" and "Ignored Tests (n)" pages: each violation is its rule title with the item
// lines under it ("@(x mm, y mm): …"); a click selects the items and centres the view on the marker (KiCad's
// OnERCItemSelected), "Show: All / Errors / Warnings / Exclusions" filter the list, "Delete Marker" / "Delete All
// Markers" clear them and "Run ERC" (the default button) runs the checks with the project's rule severities.
import { E, applyView, centerOn, toolCtx } from "./editor";
import { KD, checkbox, h, type DlgApi } from "./dom";
import { ERC_RULES, defaultSeverity, stepMarker } from "./erc-rules";
import { obj, projectJson } from "./project";

export interface ErcViolation { code: string; severity: string; x: number; y: number; text: string; ids: string[] }

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

interface SchModule { actions?: Record<string, { run(ctx: unknown, opts?: unknown): unknown }>; state: { markers?: ErcViolation[] } }
const sch = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools || {}).sch || null;
const markers = (): ErcViolation[] => ((E as unknown as { markers?: ErcViolation[] }).markers || []).filter((m) => m && typeof m.code === "string");

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
/** The open dialog's marker stepping (SCH_INSPECTION_TOOL::PrevMarker / NextMarker reach DIALOG_ERC only while it exists). */
let live: { step(dir: 1 | -1): void } | null = null;
export function ercPrevMarker(): void { if (live) live.step(-1); }
export function ercNextMarker(): void { if (live) live.step(1); }
const show = { errors: true, warnings: true };

export function openErc(): void {
  let list: HTMLElement, vioTab: HTMLElement | null = null, current = -1;
  const setMarkers = (l: ErcViolation[]) => { const ctx = toolCtx() as unknown as { setMarkers?(l: unknown[]): void }; const s = sch(); if (s) s.state.markers = l; if (ctx.setMarkers) ctx.setMarkers(l); };
  const refresh = () => {
    const all = markers(), errors = all.filter((m) => m.severity === "error").length, warnings = all.length - errors;
    if (vioTab) vioTab.textContent = `Violations (${all.length})`;
    const cnt = api && api.body.querySelectorAll<HTMLElement>("[data-erc-count]"); if (cnt) cnt.forEach((e) => { e.textContent = e.dataset.ercCount === "errors" ? String(errors) : e.dataset.ercCount === "warnings" ? String(warnings) : "0"; });
    list.innerHTML = "";
    const shown = all.map((m, i) => [m, i] as const).filter(([m]) => m.severity === "error" ? show.errors : show.warnings);
    if (!shown.length) list.append(h("div", { class: "kd-note", style: "padding:6px" }, all.length ? "No violations of the shown severities." : "No violations. Run ERC to check the schematic."));
    for (const [m, i] of shown) {
      const row = h("div", { "data-erc-row": String(i), style: `padding:3px 6px;cursor:default;border-bottom:1px solid var(--line);${i === current ? "background:var(--blue);color:var(--panel)" : ""}`,
        onclick: () => { current = i; focus(m); refresh(); } },
        h("div", { style: "display:flex;gap:6px;align-items:center" }, h("span", { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:var(${m.severity === "error" ? "--err" : "--warn"})` }), h("b", null, ruleTitle(m))),
        h("div", { style: "padding-left:14px;font-family:var(--mono);font-size:12px" }, itemLine(m)));
      list.append(row);
    }
  };
  const focus = (m: ErcViolation) => {
    const ctx = toolCtx(); ctx.setSelection(m.ids.filter((id) => E.kdoc && E.kdoc.items.has(id)));
    if (E.zoom < 2) { E.zoom = 3; E.viewTouched = true; applyView(); }
    centerOn(m.x, m.y);
  };
  const shownRows = () => markers().map((m, i) => [m, i] as const).filter(([m]) => (m.severity === "error" ? show.errors : show.warnings)).map(([, i]) => i);
  live = { step(dir) {
    if (!list || !list.isConnected) { live = null; return; }   // another dialog took its place
    const i = stepMarker(shownRows(), current, dir); const m = i === null ? null : markers()[i]; if (i === null || !m) return;
    current = i; focus(m); refresh();
    const row = list.querySelector<HTMLElement>(`[data-erc-row="${i}"]`); if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  } };
  const run = () => { const s = sch(); const a = s && s.actions && s.actions.runERC; if (!a) return; a.run(toolCtx()); current = -1; refresh(); };
  api = KD().open({
    title: "Electrical Rules Checker", width: 640, modeless: true,
    build(body) {
      const nb = KD().notebook(body, [
        { label: "Violations", build(page) {
          const filt = h("div", { style: "display:flex;gap:14px;align-items:center;margin:6px 0" }, h("span", null, "Show:"),
            checkbox("All", show.errors && show.warnings, (on) => { show.errors = show.warnings = on; syncBoxes(); refresh(); }, { id: "kd-erc-all" }),
            checkbox("Errors", show.errors, (on) => { show.errors = on; syncBoxes(); refresh(); }, { id: "kd-erc-errors" }), h("span", { "data-erc-count": "errors" }),
            checkbox("Warnings", show.warnings, (on) => { show.warnings = on; syncBoxes(); refresh(); }, { id: "kd-erc-warnings" }), h("span", { "data-erc-count": "warnings" }),
            checkbox("Exclusions", false, undefined, { disabled: true, id: "kd-erc-excl", title: "Exclusions are kept by the desktop app" }), h("span", { "data-erc-count": "exclusions" }));
          list = h("div", { "data-erc-list": "1", style: "height:300px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
          const del = h("div", { style: "display:flex;gap:8px;margin-top:8px" },
            h("button", { class: "btn sm", onclick: () => { const all = markers(); if (current < 0 || !all[current]) return; setMarkers(all.filter((_, j) => j !== current)); current = -1; refresh(); } }, "Delete Marker"),
            h("button", { class: "btn sm", onclick: () => { setMarkers([]); current = -1; refresh(); } }, "Delete All Markers"));
          page.append(filt, list, del);
        } },
        { label: "Ignored Tests", build(page) {
          const ign = ignoredTests(obj(obj(projectJson().erc).rule_severities) as Record<string, unknown>);
          page.append(h("div", { style: "height:300px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:4px 6px" }, ...(ign.length ? ign.map((t) => h("div", null, t)) : [h("div", { class: "kd-note" }, "No tests are ignored.")])));
        } },
      ]);
      const tabs = nb.el.querySelectorAll<HTMLElement>(".kd-nb-tab"); vioTab = tabs[0] || null;
      if (tabs[1]) tabs[1].textContent = `Ignored Tests (${ignoredTests(obj(obj(projectJson().erc).rule_severities) as Record<string, unknown>).length})`;
    },
    buttons: [{ label: "Run ERC", primary: true, isDefault: true, fn: run, id: "kd-erc-run" }, { label: "Close", close: true }],
    cancel() { live = null; },
  });
  function syncBoxes(): void {
    const set = (id: string, on: boolean) => { const e = api && api.body.querySelector<HTMLInputElement>("#" + id); if (e) e.checked = on; };
    set("kd-erc-all", show.errors && show.warnings); set("kd-erc-errors", show.errors); set("kd-erc-warnings", show.warnings);
  }
  refresh();
}
