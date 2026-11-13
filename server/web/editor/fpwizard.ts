// editor/fpwizard.ts — the Footprint Wizard (pcbnew/footprint_wizard_frame.cpp, KiCad 10), opened by the footprint
// editor's Create Footprint (FOOTPRINT_EDITOR_CONTROL::CreateFootprintFromWizard).
//
// The wizards are the plugins' actions of scope "footprint_wizard" (KiCad's api.v1 PluginAction scope): a web
// plugin registers each with kicad.wizards.register(identifier, handler); a Python plugin's FootprintWizardPlugin
// is registered by the runtime (kicad_wizard.web_op).  A wizard is asked one thing at a time and answers the same way:
//
//   request   { op: "describe" }                     the values as they stand
//             { op: "build", values: string[][] }    every page's values, in the order the pages list them
//             { op: "reset" }                        ResetParameters
//   answer    { name, description, pages: [{ name, params: [{ name, value, units, hint?, designator?, error? }] }],
//               messages?, footprint: "<.kicad_mod text>" | null }
//
// units: "mm", "mils", "float", "integer", "bool" (value "1"/"0"), "radians", "degrees", "%", "string", or a list
// "a,b,c" of choices.  The frame: the wizard selector (DIALOG_FOOTPRINT_WIZARD_LIST "Footprint Wizards": Name /
// Description) shown when it opens, the top toolbar, the Parameters property grid (a category per page; lengths in
// the editor's user units, angles in degrees, ints, reals, checkboxes, choices), the build message box (the wizard's
// description when it built, its errors when it did not), the footprint drawn by the editor's renderer, the message
// panel, and "Export footprint to editor", which hands the built footprint back.
import { h, messageBox, openDialog, type DialogApi } from "./pcbdialogs/ui";
import type { WizardContribution } from "../plugins/host";
import { clearPreview, renderFootprintPreview } from "../library/preview";

import { INVALID_VALUE, boolValue, buildMessage, pageValues, paramCategories, paramDisplay, paramKind, paramParse, wizardMsgPanel, wizardState, type WizardParam, type WizardState } from "./fpwizard-model";
import { E } from "./state";
import { icon } from "../symedit/ui";
import "../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

/** The plugin host (web/plugins/host.ts, in the app's bundle) as it offers its footprint wizards. */
interface WizardHost { list(): WizardContribution[]; call(plugin: string, id: string, req: unknown): Promise<unknown> }
const host = (): WizardHost | null => (window as unknown as { KiCadPluginWizards?: WizardHost }).KiCadPluginWizards || null;
const footprintWizards = (): WizardContribution[] => { const h = host(); return h ? h.list() : []; };
const callWizard = (plugin: string, id: string, req: unknown): Promise<unknown> => { const h = host(); return h ? h.call(plugin, id, req) : Promise.reject(new Error("plugins are not available here")); };

/** DIALOG_FOOTPRINT_WIZARD_LIST: Name / Description of every wizard; the first is selected. */
function selectWizard(list: WizardContribution[], current: WizardContribution | null): Promise<WizardContribution | null> {
  return new Promise((resolve) => {
    let sel = current ? Math.max(0, list.findIndex((w) => w.plugin === current.plugin && w.id === current.id)) : 0; let done = false;
    const finish = (w: WizardContribution | null) => { if (!done) { done = true; resolve(w); } };
    const rows: HTMLTableRowElement[] = [];
    const api = openDialog({ title: "Footprint Wizards", width: 620,
      build(body, a) {
        const tb = h("tbody");
        list.forEach((w, i) => {
          const tr = h("tr", { class: i === sel ? "sel" : "", "data-k": "wizard-row", title: `${w.pluginName}` }, h("td", { class: "ro" }, w.name), h("td", { class: "ro" }, w.description));
          tr.addEventListener("pointerdown", () => { sel = i; rows.forEach((r, k) => r.classList.toggle("sel", k === i)); });
          tr.addEventListener("dblclick", () => { finish(list[i]); a.close(); });
          rows.push(tr); tb.append(tr);
        });
        body.append(h("div", { class: "pd-grid", style: "max-height:320px" }, h("table", null, h("thead", null, h("tr", null, h("th", { style: "width:34%" }, "Name"), h("th", null, "Description"))), tb)));
        if (!list.length) body.append(h("p", { class: "pd-note", "data-k": "no-wizards" }, "No footprint wizards are available. Footprint wizards come from plugins: install one from Manage Plugins."));
      },
      ok() { finish(list[sel] || null); },
      cancel() { finish(null); } });
    if (!api) finish(null);
  });
}

/**
 * FOOTPRINT_WIZARD_FRAME, as a dialog: the top toolbar (Show wizards selector | Reset wizard parameters | Refresh,
 * Zoom In, Zoom Out, Zoom to Fit | Export footprint to editor), the "Parameters" pane (FOOTPRINT_WIZARD_PROPERTIES_PANEL:
 * a property grid, one category per parameter category), the build message box under it, the footprint canvas and
 * the message panel.  Resolves with the built footprint's text (Export footprint to editor), or null when closed.
 */
export async function footprintWizardDialog(): Promise<string | null> {
  const list = footprintWizards();
  let wizard = await selectWizard(list, null);
  return new Promise((resolve) => {
    let st: WizardState | null = null; let seq = 0; let done = false; let zoom = 1;
    let dlg: DialogApi | null = null;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const userUnits = () => String(E.units || "mm");
    const grid = h("div", { class: "fw-pg", "data-k": "params" });
    const msgBox = h("textarea", { class: "fw-msg", readOnly: true, "data-k": "messages", rows: 5 }) as HTMLTextAreaElement;
    const canvas = h("canvas", { class: "fw-canvas", "data-k": "preview" }) as HTMLCanvasElement;
    const msgPanel = h("div", { class: "fw-msgpanel", "data-k": "msgpanel" });
    const collapsed = new Set<string>();

    const title = () => `Footprint Wizard [${wizard ? wizard.name : "no wizard selected"}]`;
    const draw = () => {
      if (!st || !st.footprint) { clearPreview(canvas, "footprint"); return; }
      try { renderFootprintPreview(canvas, "wizard:" + (st.name || "footprint"), st.footprint, zoom); }
      catch (e) { clearPreview(canvas, "footprint"); msgBox.value += `\nThe footprint could not be drawn: ${(e as Error).message || e}`; }
    };
    // FOOTPRINT_WIZARD_FRAME::UpdateMsgPanel: the built footprint's GetMsgPanelInfo, else cleared
    const showMsgPanel = () => {
      let t: unknown = null; if (st && st.footprint) { try { t = window.KiCadCanvas.parse(st.footprint); } catch { t = null; } }
      msgPanel.replaceChildren(...wizardMsgPanel(t as unknown[] | null).map((m) => h("div", { class: "fw-mp" }, h("div", { class: "fw-mp-t" }, m.title), h("div", { class: "fw-mp-v" }, m.value))));
    };
    const setExport = () => { const ok = !!(st && st.footprint); if (dlg && dlg.okButton) dlg.okButton.disabled = !ok; if (exportBtn) exportBtn.disabled = !ok; };
    const rebuild = () => { if (st) void request({ op: "build", values: pageValues(st) }); };
    // FOOTPRINT_WIZARD_PROPERTIES_PANEL::RebuildParameters
    const showParams = () => {
      grid.replaceChildren();
      if (!st) return;
      for (const cat of paramCategories(st)) {
        const err = cat.params.some((q) => q.error);
        const head = h("div", { class: "fw-pg-cat" + (err ? " err" : ""), "data-k": "category" }, h("span", { class: "fw-pg-tw" }, collapsed.has(cat.name) ? "\u25b8" : "\u25be"), cat.name);
        head.addEventListener("click", () => { if (collapsed.has(cat.name)) collapsed.delete(cat.name); else collapsed.add(cat.name); showParams(); });
        grid.append(head);
        if (collapsed.has(cat.name)) continue;
        for (const q of cat.params) grid.append(paramRow(q));
      }
    };
    const paramRow = (q: WizardParam): HTMLElement => {
      const kind = paramKind(q.units);
      let ctrl: HTMLElement;
      if (kind === "bool") {
        const cb = h("input", { type: "checkbox", checked: boolValue(q.value) }) as HTMLInputElement;
        cb.addEventListener("change", () => { q.value = cb.checked ? "1" : "0"; rebuild(); });
        ctrl = h("span", { class: "fw-pg-chk" }, cb);
      } else if (kind === "enum") {
        const sel = h("k-select") as HTMLSelectElement;
        for (const c of q.units.split(",")) { const o = h("option", { value: c.trim() }, c.trim()); if (c.trim() === q.value) o.selected = true; sel.append(o); }
        sel.addEventListener("change", () => { q.value = sel.value; rebuild(); });
        ctrl = sel;
      } else {
        const shown = paramDisplay(q, userUnits());
        const inp = h("input", { type: "text", value: shown, spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
        let shownNow = shown;
        const commit = (): boolean => {
          if (inp.value === shownNow) { inp.classList.remove("bad"); inp.title = ""; return true; }
          const v = paramParse(q, inp.value, userUnits());
          if (v === null) { inp.classList.add("bad"); inp.title = INVALID_VALUE; msgBox.value = INVALID_VALUE; return false; }
          inp.classList.remove("bad"); inp.title = ""; q.value = v; shownNow = paramDisplay(q, userUnits()); inp.value = shownNow; rebuild(); return true;
        };
        inp.addEventListener("change", () => { commit(); });
        inp.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.stopPropagation(); ev.preventDefault(); if (commit()) inp.blur(); }
          else if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); inp.value = shownNow; inp.classList.remove("bad"); inp.title = ""; inp.blur(); }
        });
        ctrl = inp;
      }
      const label = (q.designator ? q.designator + " " : "") + q.name;
      const tip = [q.hint, q.error].filter(Boolean).join("\n");
      return h("div", { class: "fw-pg-row" + (q.error ? " err" : ""), title: tip || null, "data-k": "param", "data-kind": kind },
        h("span", { class: "fw-pg-name" }, label), h("span", { class: "fw-pg-val" }, ctrl));
    };
    const apply = (next: WizardState) => {
      st = next;
      msgBox.value = buildMessage(st);
      showParams(); draw(); showMsgPanel(); setExport();
      if (dlg) dlg.setTitle(title());
    };
    const request = async (req: Record<string, unknown>) => {
      if (!wizard) return;
      const my = ++seq; const w = wizard;
      if (dlg && dlg.okButton) dlg.okButton.disabled = true;
      try { const out = wizardState(await callWizard(w.plugin, w.id, req)); if (my === seq && wizard === w) apply(out); }
      catch (e) { if (my !== seq) return; msgBox.value = `${w.name}: ${(e as Error).message || e}`; st = st ? Object.assign({}, st, { footprint: null }) : null; draw(); showMsgPanel(); setExport(); }
    };
    // FOOTPRINT_WIZARD_FRAME::SelectFootprintWizard: a new wizard is built and zoomed to fit (Zoom_Automatique)
    const choose = async () => {
      const w = await selectWizard(footprintWizards(), wizard); if (!w) return;
      wizard = w; st = null; zoom = 1; showParams(); draw(); showMsgPanel(); msgBox.value = ""; if (dlg) dlg.setTitle(title());
      await request({ op: "describe" });
    };
    // the frame's top toolbar (toolbars_footprint_wizard.cpp TOP_MAIN)
    const tool = (iconName: string, tip: string, fn: () => void, k: string): HTMLButtonElement => {
      const b = h("button", { type: "button", class: "fw-tb-btn", title: tip, "data-k": k }) as HTMLButtonElement;
      b.append(icon(iconName)); b.addEventListener("click", fn); return b;
    };
    const sep = () => h("span", { class: "fw-tb-sep" });
    const exportBtn: HTMLButtonElement = tool("export_footprint_names", "Export footprint to editor", () => { if (st && st.footprint && dlg) { finish(st.footprint); dlg.close(); } }, "tb-export");
    const toolbar = h("div", { class: "fw-tb", "data-k": "toolbar" },
      tool("module_wizard", "Show wizards selector\nSelect wizard script to run", () => void choose(), "tb-wizards"), sep(),
      tool("reload", "Reset wizard parameters\nReset wizard parameters to default", () => void request({ op: "reset" }), "tb-reset"), sep(),
      tool("refresh", "Refresh", () => draw(), "tb-refresh"),
      tool("zoom_in", "Zoom In", () => { zoom = Math.min(zoom * 1.3, 200); draw(); }, "tb-zoomin"),
      tool("zoom_out", "Zoom Out", () => { zoom = Math.max(zoom / 1.3, 0.01); draw(); }, "tb-zoomout"),
      tool("zoom_fit_in_page", "Zoom to Fit\nZoom to worksheet area if exists or edited object", () => { zoom = 1; draw(); }, "tb-zoomfit"), sep(),
      exportBtn);

    dlg = openDialog({ title: title(), width: 1040, height: 680, okLabel: "Export footprint to editor", noEnter: true,
      build(body) {
        body.classList.add("fw-body");
        body.append(h("style", null, FW_CSS), toolbar,
          h("div", { class: "fw-main" },
            h("div", { class: "fw-left" }, h("div", { class: "fw-caption" }, "Parameters"), grid, msgBox),
            h("div", { class: "fw-right" }, canvas)),
          msgPanel);
      },
      ok() { if (!st || !st.footprint) return false; finish(st.footprint); },
      cancel() { finish(null); } });
    if (!dlg) { finish(null); return; }
    canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); zoom = Math.min(200, Math.max(0.01, zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))); draw(); }, { passive: false });
    setExport();
    requestAnimationFrame(() => draw());
    if (wizard) void request({ op: "describe" });
    else if (!list.length) messageBox("Footprint Wizard", "No footprint wizards are available. Footprint wizards come from plugins: install one from Manage Plugins.");
  });
}

const FW_CSS = `
.fw-body { gap: 0 !important; padding: 0 !important; }
.fw-tb { display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-bottom: 1px solid var(--line); background: var(--bench); flex: 0 0 auto; }
.fw-tb-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: var(--r-2); background: none; padding: 0; color: var(--ink); }
.fw-tb-btn:hover:not(:disabled) { border-color: var(--line); background: var(--paper); }
.fw-tb-btn:disabled { opacity: .4; }
.fw-tb-sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
.fw-main { display: flex; flex: 1 1 auto; min-height: 0; }
.fw-left { display: flex; flex-direction: column; width: 340px; flex: 0 0 340px; min-height: 0; border-right: 1px solid var(--line); }
.fw-caption { padding: 3px 6px; background: var(--bench); border-bottom: 1px solid var(--line); font-weight: 600; }
.fw-right { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.fw-pg { flex: 1 1 auto; min-height: 160px; overflow: auto; background: var(--paper); font-size: 12px; }
.fw-pg-cat { display: flex; align-items: center; height: 20px; padding: 0 4px; background: var(--bench); border-bottom: 1px solid var(--line); font-weight: 600; cursor: default; user-select: none; }
.fw-pg-cat.err { color: var(--err); }
.fw-pg-tw { display: inline-block; width: 14px; color: var(--ink-2); font-size: 11px; }
.fw-pg-row { display: grid; grid-template-columns: minmax(0, 50%) minmax(0, 50%); height: 21px; border-bottom: 1px solid var(--line-soft, var(--line)); }
.fw-pg-name { padding: 0 4px 0 18px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-right: 1px solid var(--line-soft, var(--line)); }
.fw-pg-row.err .fw-pg-name { color: var(--err); }
.fw-pg-val { position: relative; min-width: 0; display: flex; align-items: center; }
.fw-pg-val input[type=text], .fw-pg-val k-select { width: 100%; height: 20px; border: 0; background: transparent; color: var(--ink); padding: 0 4px; font: inherit; border-radius: 0; }
.fw-pg-val input[type=text]:focus, .fw-pg-val k-select:focus-within { outline: none; box-shadow: inset 0 0 0 1px var(--accent, var(--line)); background: var(--panel); }
.fw-pg-val input.bad { box-shadow: inset 0 0 0 1px var(--err); }
.fw-pg-chk { padding: 0 4px; display: flex; align-items: center; }
.fw-msg { width: 100%; resize: vertical; font-family: var(--mono); font-size: 12px; min-height: 80px; border: 0; border-top: 1px solid var(--line); border-radius: 0; background: var(--paper); color: var(--ink); }
.fw-canvas { flex: 1 1 auto; width: 100%; min-height: 0; display: block; }
.fw-msgpanel { flex: 0 0 auto; display: flex; gap: 0; min-height: 38px; border-top: 1px solid var(--line); background: var(--bench); overflow: hidden; font-size: 12px; }
.fw-mp { padding: 2px 10px; border-right: 1px solid var(--line); white-space: nowrap; }
.fw-mp-t { color: var(--ink-2); }
.fw-mp-v { color: var(--ink); }
@media (max-width: 760px) { .fw-main { flex-direction: column; } .fw-left { width: 100%; flex: 0 0 auto; border-right: 0; } .fw-canvas { min-height: 220px; } .fw-msgpanel { overflow-x: auto; } }
`;
