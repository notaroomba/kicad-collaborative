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
// "a,b,c" of choices.  The frame: the wizard selector (DIALOG_FOOTPRINT_WIZARD_LIST: Name / Description) shown when
// it opens, the parameter pages and their grid (Parameter / Value / Units), the build message box (the wizard's
// description when it built, its errors when it did not), the footprint drawn by the editor's renderer, and
// "Export footprint to editor", which hands the built footprint back.
import { h, messageBox, openDialog, type DialogApi } from "./pcbdialogs/ui";
import type { WizardContribution } from "../plugins/host";
import { clearPreview, renderFootprintPreview } from "../library/preview";

import { buildMessage, pageValues, unitsLabel, wizardState, type WizardState } from "./fpwizard-model";

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
    const api = openDialog({ title: "Footprint Generators", width: 620,
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
 * FOOTPRINT_WIZARD_FRAME, as a dialog.  Resolves with the built footprint's text (Export footprint to editor), or
 * null when it is closed.
 */
export async function footprintWizardDialog(): Promise<string | null> {
  const list = footprintWizards();
  let wizard = await selectWizard(list, null);
  return new Promise((resolve) => {
    let st: WizardState | null = null; let pageIx = 0; let seq = 0; let done = false;
    let dlg: DialogApi | null = null;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const pageList = h("div", { class: "fw-pages", "data-k": "pages" });
    const paramBody = h("tbody");
    const paramTable = h("div", { class: "pd-grid fw-params", "data-k": "params" }, h("table", null, h("thead", null, h("tr", null, h("th", { style: "width:45%" }, "Parameter"), h("th", null, "Value"), h("th", { style: "width:52px" }, "Units"))), paramBody));
    const msgBox = h("textarea", { class: "fw-msg", readOnly: true, "data-k": "messages", rows: 5 }) as HTMLTextAreaElement;
    const canvas = h("canvas", { class: "fw-canvas", "data-k": "preview" }) as HTMLCanvasElement;
    const sizeNote = h("div", { class: "pd-note fw-size", "data-k": "size" });

    const title = () => `Footprint Wizard [${wizard ? wizard.name : "no wizard selected"}]`;
    const draw = () => {
      if (!st || !st.footprint) { clearPreview(canvas, "footprint"); sizeNote.textContent = ""; return; }
      try { renderFootprintPreview(canvas, "wizard:" + (st.name || "footprint"), st.footprint); }
      catch (e) { clearPreview(canvas, "footprint"); msgBox.value += `\nThe footprint could not be drawn: ${(e as Error).message || e}`; }
      const pads = (st.footprint.match(/\(pad\s/g) || []).length; sizeNote.textContent = `${pads} pad${pads === 1 ? "" : "s"}`;
    };
    const setExport = () => { if (dlg && dlg.okButton) dlg.okButton.disabled = !(st && st.footprint); };
    const showPages = () => {
      pageList.replaceChildren();
      (st ? st.pages : []).forEach((p, i) => {
        const err = p.params.some((q) => q.error);
        const b = h("button", { type: "button", class: "fw-page" + (i === pageIx ? " on" : "") + (err ? " err" : ""), "data-k": "page" }, p.name || `Page ${i + 1}`);
        b.addEventListener("click", () => { pageIx = i; showPages(); showParams(); });
        pageList.append(b);
      });
    };
    const showParams = () => {
      paramBody.replaceChildren();
      const page = st && st.pages[pageIx]; if (!page) return;
      page.params.forEach((q) => {
        let ctrl: HTMLElement;
        if (q.units === "bool") {
          const cb = h("input", { type: "checkbox", checked: q.value === "1" || /^(true|t|y|yes|on)$/i.test(q.value) }) as HTMLInputElement;
          cb.addEventListener("change", () => { q.value = cb.checked ? "1" : "0"; void request({ op: "build", values: pageValues(st!) }); });
          ctrl = h("td", { class: "chk" }, cb);
        } else if (q.units.includes(",")) {
          const sel = h("select") as HTMLSelectElement;
          for (const c of q.units.split(",")) { const o = h("option", { value: c.trim() }, c.trim()); if (c.trim() === q.value) o.selected = true; sel.append(o); }
          sel.addEventListener("change", () => { q.value = sel.value; void request({ op: "build", values: pageValues(st!) }); });
          ctrl = h("td", null, sel);
        } else {
          const inp = h("input", { type: "text", value: q.value }) as HTMLInputElement;
          inp.addEventListener("change", () => { q.value = inp.value; void request({ op: "build", values: pageValues(st!) }); });
          inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); ev.preventDefault(); inp.blur(); } });
          ctrl = h("td", null, inp);
        }
        const tip = [q.hint, q.error].filter(Boolean).join("\n");
        paramBody.append(h("tr", { class: q.error ? "fw-err" : "", title: tip || null, "data-k": "param" },
          h("td", { class: "ro" }, (q.designator ? q.designator + " " : "") + q.name), ctrl, h("td", { class: "ro" }, unitsLabel(q.units))));
      });
    };
    const apply = (next: WizardState) => {
      st = next; if (pageIx >= st.pages.length) pageIx = 0;
      msgBox.value = buildMessage(st);
      showPages(); showParams(); draw(); setExport();
      if (dlg) dlg.setTitle(title());
    };
    const request = async (req: Record<string, unknown>) => {
      if (!wizard) return;
      const my = ++seq; const w = wizard;
      if (dlg && dlg.okButton) dlg.okButton.disabled = true;
      try { const out = wizardState(await callWizard(w.plugin, w.id, req)); if (my === seq && wizard === w) apply(out); }
      catch (e) { if (my !== seq) return; msgBox.value = `${w.name}: ${(e as Error).message || e}`; st = st ? Object.assign({}, st, { footprint: null }) : null; draw(); setExport(); }
    };
    const choose = async () => {
      const w = await selectWizard(footprintWizards(), wizard); if (!w) return;
      wizard = w; st = null; pageIx = 0; showPages(); showParams(); draw(); msgBox.value = ""; if (dlg) dlg.setTitle(title());
      await request({ op: "describe" });
    };

    dlg = openDialog({ title: title(), width: 1040, height: 660, okLabel: "Export footprint to editor", noEnter: true,
      extra: [{ label: "Select Wizard...", fn: () => void choose() }, { label: "Reset Parameters", fn: () => void request({ op: "reset" }) }],
      build(body) {
        body.classList.add("fw-body");
        body.append(h("style", null, FW_CSS),
          h("div", { class: "fw-left" }, h("div", { class: "pd-lbl" }, "Parameters"), pageList, paramTable, msgBox),
          h("div", { class: "fw-right" }, canvas, sizeNote));
      },
      ok() { if (!st || !st.footprint) return false; finish(st.footprint); },
      cancel() { finish(null); } });
    if (!dlg) { finish(null); return; }
    setExport();
    requestAnimationFrame(() => draw());
    if (wizard) void request({ op: "describe" });
    else if (!list.length) messageBox("Footprint Wizard", "No footprint wizards are available. Footprint wizards come from plugins: install one from Manage Plugins.");
  });
}

const FW_CSS = `
.fw-body { flex-direction: row !important; gap: 12px; }
.fw-left { display: flex; flex-direction: column; gap: 6px; width: 400px; flex: 0 0 400px; min-height: 0; }
.fw-right { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; gap: 4px; }
.fw-pages { display: flex; flex-wrap: wrap; gap: 4px; }
.fw-page { padding: 3px 10px; border: 1px solid var(--line); border-radius: var(--r-2); background: none; color: var(--ink-2); }
.fw-page.on { background: var(--bench); color: var(--ink); font-weight: 600; }
.fw-page.err { border-color: var(--err); }
.fw-params { flex: 1 1 auto; min-height: 120px; overflow: auto; }
.fw-params tr.fw-err td:first-child { color: var(--err); }
.fw-params input[type=text], .fw-params select { width: 100%; }
.fw-msg { width: 100%; resize: vertical; font-family: var(--mono); font-size: 12px; min-height: 80px; }
.fw-canvas { flex: 1 1 auto; width: 100%; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-2); }
@media (max-width: 760px) { .fw-body { flex-direction: column !important; } .fw-left { width: 100%; flex: 0 0 auto; } .fw-canvas { min-height: 220px; } }
`;
