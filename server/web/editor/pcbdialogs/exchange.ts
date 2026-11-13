// pcbdialogs/exchange — Update Footprint… / Update Footprints from Library… / Change Footprint… / Change Footprints…
// (GLOBAL_EDIT_TOOL::ExchangeFootprints, DIALOG_EXCHANGE_FOOTPRINTS, dialog_exchange_footprints_base.fbp).
//
// The match mode (all / selected / reference / value / library id), the new library id with its browse button, KiCad's
// update options and the message report.  Update / Change exchanges every matching footprint, from the last one on the
// board, for its library footprint (PcbTools.exchange.planExchange = BOARD::ExchangeFootprint with the options), pushes
// one "Update Footprint" / "Change Footprint" step, selects the new footprints and keeps the dialog open with the report.
// Library footprints come from the project's own .pretty libraries before the global ones (KiCadLibrary.loadFootprint).
import { E } from "../state";
import { KiCadLibrary, loadLibraryFootprint } from "../library";
import { NL } from "./canvas";
import { checkField, h, iconButton, openDialog, reportPanel, type Field, type ReportLine } from "./ui";

type Mode = "all" | "selected" | "ref" | "value" | "id";
interface ExchangeOptions {
  matchPadPositions: boolean; deleteExtraTexts: boolean; resetTextLayers: boolean; resetTextEffects: boolean; resetTextPositions: boolean;
  resetTextContent: boolean; resetFabricationAttrs: boolean; resetClearanceOverrides: boolean; reset3DModels: boolean; resetTransform: boolean;
}
interface ExchangeApi {
  planExchange(fps: { id: string; node: SNode }[], job: { updateMode: boolean; newFpid?: string; match(fp: SNode, id: string): boolean; opts: Partial<ExchangeOptions>; library(fpid: string): SNode | null }):
    { modified: [string, SNode][]; report: ReportLine[]; ids: string[] };
  wildCompare(pattern: string, text: string): boolean;
  validFpid(id: string): boolean;
}
interface PcbToolsApi { exchange: ExchangeApi; applySelection?(ctx: ToolCtx, ids: string[]): void }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

// g_matchModeForUpdate / …Selected / g_matchModeForExchange / …Selected: remembered for the session
const matchModes: Record<string, Mode> = { update: "all", updateSelected: "selected", change: "ref", changeSelected: "selected" };
// DIALOG_SHIM keeps the controls' state per dialog title
const remembered: Record<string, Partial<ExchangeOptions>> = {};

const OPTS: { key: keyof ExchangeOptions; col: 0 | 1; update: string; change: string; tip?: string }[] = [
  { key: "deleteExtraTexts", col: 0, update: "Remove text items if not in library footprint", change: "Remove text items if not in library footprint", tip: "Removes fields that do not occur in the original library symbols" },
  { key: "resetTextLayers", col: 0, update: "Update/reset text layers and visibilities", change: "Update text layers and visibilities" },
  { key: "resetTextEffects", col: 0, update: "Update/reset text sizes and styles", change: "Update text sizes and styles" },
  { key: "resetTextPositions", col: 0, update: "Update/reset text position and rotation", change: "Update text positions" },
  { key: "resetTextContent", col: 0, update: "Update/reset text content", change: "Update text content" },
  { key: "resetFabricationAttrs", col: 1, update: "Update/reset fabrication attributes", change: "Update fabrication attributes" },
  { key: "resetClearanceOverrides", col: 1, update: "Update/reset clearance overrides", change: "Update clearance overrides" },
  { key: "reset3DModels", col: 1, update: "Update/reset 3D models", change: "Update 3D models" },
  { key: "resetTransform", col: 1, update: "Reset scale", change: "Reset scale", tip: "Reset the footprint scale to 1 when changing to a different library footprint. Unchecked: keep the existing scale." },
  { key: "matchPadPositions", col: 1, update: "Match pad positions", change: "Match pad positions", tip: "Attempt to match pad positions even if the footprint origin or rotation has changed." }];
/** The controls' initial state "in case there is no saved state yet". */
export function defaultExchangeOptions(updateMode: boolean): ExchangeOptions {
  return { deleteExtraTexts: false, resetTextLayers: !updateMode, resetTextEffects: !updateMode, resetTextPositions: !updateMode, resetTextContent: !updateMode,
    resetFabricationAttrs: !updateMode, resetClearanceOverrides: true, reset3DModels: true, resetTransform: !updateMode, matchPadPositions: true };
}

const fieldText = (fp: SNode, name: string): string => {
  for (const c of fp) if (Array.isArray(c) && ((c[0] === "property" && c[1] === name) || (c[0] === "fp_text" && c[1] === name.toLowerCase()))) return String(c[2] ?? "");
  return "";
};

export type ExchangeAction = "updateFootprint" | "updateFootprints" | "changeFootprint" | "changeFootprints";

/** GLOBAL_EDIT_TOOL::ExchangeFootprints: which dialog the action opens, for the current selection. */
export function openExchangeFootprints(ctx: ToolCtx, action: ExchangeAction): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("This needs a board"); return; }
  const selFps = Array.from(ctx.selection || []).map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && it.kind === "footprint");
  const current = selFps[0] || null;
  const updateMode = action === "updateFootprint" || action === "updateFootprints";
  const selectedMode = action === "updateFootprint" || action === "changeFootprint" ? true : selFps.length > 0;
  showExchangeDialog(ctx, doc, current, updateMode, selectedMode);
}

function showExchangeDialog(ctx: ToolCtx, doc: KDoc, current: KItem | null, updateMode: boolean, selectedMode: boolean): void {
  const title = updateMode ? "Update Footprints from Library" : "Change Footprints";
  const modeKey = (updateMode ? "update" : "change") + (selectedMode ? "Selected" : "");
  let mode: Mode = matchModes[modeKey];
  if (mode === "selected" && !current) mode = updateMode ? "all" : "ref";
  if (mode === "all" && !updateMode) mode = "ref";
  const saved = remembered[title] || {};
  const init = Object.assign(defaultExchangeOptions(updateMode), saved);
  const ro = !!E.viewOnly;
  const verb = updateMode ? "Update" : "Change";
  const report = reportPanel("200px");
  const radios: Partial<Record<Mode, HTMLInputElement>> = {};
  const checks = new Map<keyof ExchangeOptions, Field<boolean>>();
  const text = (v: string): HTMLInputElement => h("input", { type: "text", value: v, style: "width:100%;min-width:0" }) as HTMLInputElement;
  const curId = current ? String(current.node[1] ?? "") : "";
  const specifiedRef = text(current ? fieldText(current.node, "Reference") : "");
  const specifiedValue = text(current ? fieldText(current.node, "Value") : "");
  const specifiedID = text(curId);
  const newID = text(updateMode ? curId : "");
  const setMode = (m: Mode, focus?: HTMLElement): void => { mode = m; matchModes[modeKey] = m; for (const [k, r] of Object.entries(radios)) if (r) r.checked = k === m; if (focus) focus.focus(); };
  const radio = (m: Mode, label: string, focus: () => HTMLElement | undefined): HTMLElement => {
    const r = h("input", { type: "radio", name: "xfp-match" }) as HTMLInputElement; radios[m] = r;
    r.addEventListener("change", () => { if (r.checked) setMode(m, focus()); });
    return h("label", { class: "pd-lbl", style: "display:flex;align-items:center;gap:6px;white-space:nowrap" }, r, label);
  };
  // the library chooser (FRAME_FOOTPRINT_CHOOSER) for the new id or the specified id
  const browse = (target: HTMLInputElement, m?: Mode): void => {
    void KiCadLibrary.openChooser("footprint", { title: "Choose Footprint" }).then((chosen) => {
      if (!chosen) return;
      target.value = chosen.fpid || chosen.item.id;
      if (m) setMode(m);
    });
  };
  const rows: HTMLElement[] = [];
  const grid2 = (a: HTMLElement, b?: HTMLElement): HTMLElement => h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin:0 0 6px" }, a, b || h("span"));
  if (updateMode) rows.push(grid2(radio("all", `${verb} all footprints on board`, () => radios.all)));
  if (current) rows.push(grid2(radio("selected", `${verb} selected footprint(s)`, () => radios.selected)));
  rows.push(grid2(radio("ref", `${verb} footprints matching reference designator:`, () => specifiedRef), specifiedRef));
  rows.push(grid2(radio("value", `${verb} footprints matching value:`, () => specifiedValue), specifiedValue));
  const idRow = h("div", { style: "display:flex;gap:4px;align-items:center" }, specifiedID, iconButton("library", "Browse", () => browse(specifiedID, "id"), ro));
  rows.push(grid2(radio("id", `${verb} footprints with library id:`, () => specifiedID), idRow));
  // typing in a match field picks its mode (wxEVT_TEXT / TEXT_ENTER -> OnMatch…Clicked)
  for (const [inp, m] of [[specifiedRef, "ref"], [specifiedValue, "value"], [specifiedID, "id"]] as [HTMLInputElement, Mode][]) inp.addEventListener("input", () => setMode(m));

  const isMatch = (fp: SNode, id: string): boolean => {
    const X = PT().exchange;
    switch (mode) {
      case "all": return true;
      case "selected": return (!!current && id === current.id) || (ctx.selection ? ctx.selection.has(id) : false);
      case "ref": return X.wildCompare(specifiedRef.value, fieldText(fp, "Reference"));
      case "value": return X.wildCompare(specifiedValue.value, fieldText(fp, "Value"));
      case "id": return String(fp[1] ?? "") === specifiedID.value.trim();
    }
    return false;
  };
  const opts = (): ExchangeOptions => { const o = defaultExchangeOptions(updateMode); for (const [k, f] of checks) o[k] = f.get(); return o; };
  let busy = false;
  const run = async (): Promise<void> => {
    if (busy || ro) return;
    busy = true;
    try {
      const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint").map((it) => ({ id: it.id, node: it.node }));
      const newFpid = newID.value.trim();
      // LoadFootprint for every library id the run will ask for, before the synchronous exchange
      const want = new Set<string>();
      if (!updateMode) { if (PT().exchange.validFpid(newFpid)) want.add(newFpid); }
      else for (const f of fps) if (isMatch(f.node, f.id)) want.add(String(f.node[1] ?? ""));
      const lib = new Map<string, SNode | null>();
      if (want.size) report.set([{ severity: "info", text: "Loading library footprints…" }]);
      await Promise.all(Array.from(want).map(async (id) => {
        const t = await loadLibraryFootprint(id); const node = t ? KiCadCanvas.parse(t) : null;
        lib.set(id, node ? NL().footprintFromLibrary(node, id, () => KiCadCanvas.newUuid()) : null);
      }));
      const plan = PT().exchange.planExchange(fps, { updateMode, newFpid, match: isMatch, opts: opts(),
        // each call a fresh copy: the same library footprint may replace several board footprints
        library: (id) => { const n = lib.get(id); return n ? NL().footprintFromLibrary(n, id, () => KiCadCanvas.newUuid()) : null; } });
      const changes: KChange[] = [];
      for (const [id, node] of plan.modified) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node })); }
      if (changes.length) ctx.commit(changes, updateMode ? "Update Footprint" : "Change Footprint");
      const sel = PT().applySelection; if (sel && plan.ids.length) sel(ctx, plan.ids.filter((id) => doc.items.has(id)));
      report.set(plan.report);
      ctx.requestRender();
    } finally { busy = false; }
  };

  const dlg = openDialog({ title, width: 720, okLabel: updateMode ? "Update" : "Change", cancelLabel: "Close", readOnly: ro, noEnter: true,
    cancel() { remembered[title] = opts(); },
    build(body) {
      body.append(h("div", { style: "margin:0 0 4px" }, ...rows));
      if (!updateMode) {
        body.append(h("hr", { style: "border:0;border-top:1px solid var(--line);margin:4px 0 8px" }),
          h("div", { style: "display:flex;gap:6px;align-items:center;margin:0 0 10px" }, h("span", { class: "pd-lbl" }, "New footprint library id:"), newID, iconButton("library", "Browse", () => browse(newID), ro)));
      }
      const cols = [h("div", { style: "display:flex;flex-direction:column;gap:2px" }), h("div", { style: "display:flex;flex-direction:column;gap:2px" })];
      for (const o of OPTS) { const f = checkField(init[o.key], updateMode ? o.update : o.change, { key: o.key, tip: o.tip, ro }); checks.set(o.key, f); cols[o.col].append(f.el); }
      const all = (on: boolean): void => { for (const f of checks.values()) f.set(on); };
      const btn = (label: string, fn: () => void): HTMLButtonElement => { const b = h("button", { type: "button", class: "btn", style: "margin-top:10px" }, label) as HTMLButtonElement; b.disabled = ro; b.addEventListener("click", fn); return b; };
      cols[0].append(btn("Check All Update Options", () => all(true))); cols[1].append(btn("Uncheck All Update Options", () => all(false)));
      body.append(h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Update Options"), h("div", { class: "pd-cols2" }, cols[0], cols[1])), report.el);
      report.set([]);
      setMode(mode);
      const focus = mode === "ref" ? specifiedRef : mode === "value" ? specifiedValue : mode === "id" ? specifiedID : radios[mode];
      setTimeout(() => focus && focus.focus(), 0);
    },
    ok() { remembered[title] = opts(); void run(); return false; } });     // KiCad keeps the dialog open with its report; Close dismisses it
  if (!dlg) return;
}
