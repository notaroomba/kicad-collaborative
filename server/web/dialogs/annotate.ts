// dialogs/annotate.ts — Tools → Annotate Schematic…: eeschema/dialogs/dialog_annotate.cpp (DIALOG_ANNOTATE).
// Scope (Entire schematic / Current sheet only / Selection), Order (by X / by Y), Numbering (first free after N,
// sheet number × 100, × 1000) and Options (keep / reset existing annotations); "Annotate" numbers the symbols in
// scope against every reference the project's sheets already use (SCH_REFERENCE_LIST over the whole hierarchy),
// "Clear Annotation" resets them to "R?".  Recurse into subsheets takes in the sheets below the current one, Regroup
// symbol units (with Reset) drops the locked unit sets, and the message panel lists AnnotateSymbols' report lines.  Other sheets are edited through their own documents, each step on
// that sheet's undo list, as Find and Replace's Replace All does.
import { E, appState, pushUndoFor, toolCtx } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { obj, projectDocs, projectJson, readDoc, saveProject, sub, submitDocOp } from "./project";
import { effectiveTheme } from "../theme";
import { subsheetFiles } from "./annotate-logic";
import { reportPanel, type ReportLine } from "../editor/pcbdialogs/ui";
export { subsheetFiles };

/** BITMAPS::annotate_down_right / annotate_right_down (24 px, light and dark), beside the two sort orders. */
const ORDER_BMP: Record<string, [string, string]> = {
  x: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABcUlEQVR4AZyTA2xeURTHZ9u2/c7/vjcjmO0tmL1gtm3bCId4aJwiqm27sb6gbh+u6ser3/FpVt7Iu+kA4qcNaxxQMHVggwE6SufgM24ZF2YPkLend6FNGKID91BefQc2ay5uWj0Rz74jWzTWltMXBVWAsUWWT79wu/J7Dq9FwNNBQbJ8cz5SF7Sr3BuFDBmwdZRhuywffmy3M8ozB+tR8qGXZP8YFI5qa4/Zb9qsA4WGFCF2Bc+8vfs4rQOZ5ggRQIIx0xsfwxMdiALx4wZDKg8B24KfGkB/aSUH6BHdEMxbgAANwHu23x3PbI8ia4wAWAjjAHfymjfeTX+ljExDtA5sZb+dpRaIYst4ebBVdBi5bJW1XALQH0W2m9iIEO7wxDZIcirtq9JASDYnVn47IBmLpABfqD5eQnNV4DaeNmuOz/RNKZFeVIhy9ldr0cndEYVY+osOatPgCcqN9Qpgu8uLTK4r5nVKA1u/YuZaZJcaANc6D+SZmvZDAAAAAElFTkSuQmCC", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABc0lEQVR4AZ2UA6ybURTHZ9u2bSuY7S2YvWC2bdsIh3iKM0Tzs76e/6nbWA0e6vbq+ePV797jKsEK3pUHkEldKgZ4He3LDdBO+yEE+ByO2Nup07mNeJnVyQBwCcHo/T1YVZ50NkcmXsNBXTTA1xreCEAr1P3xjs+Hv4f4vgyIM36o+9NkWFQnWMXRAzAAX2su4tXq/vwF62MtuPM6mlYKuFvIy61e8OXWjrXxnpabgE+1EJ3AreTcZd5vAszdZABZGJts76IbBkApGCaW20fAEiagFXhrnvCR5woA13BG9GgKvpnAY9qcaDvqwm/1EoBtFP4YAJ3AqSS8Hh8VAwxBqgmsxPt4uxqlYFZiPLO5fR62s8s+z5qtAGgLf0xNXopfQuH0WpQTizR6qSUQcrl/sIq7HnJt0xQDH4kCBbaJGsDn6WawKj/HKzVEsluQD8GEVjLQlFKQjo/uenrS0A0EsVgDYuqKINPiKpkp5Ux97lfpqhECB494COOT5+8AAAAASUVORK5CYII="],
  y: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABU0lEQVR4AaWUM5zcURSF/zOxbdu6332xmthOyti2bdvugi5GFds2l+1utztsxvyd9nzvXVuOOJU4wFzZTKV4gGU4yNQdploMAG/IIBuHR7lkkcE33nCZY7pKR7WqHAS0qtGqhq732J/JtCalTTVTG5F+TGK1XiSdz2xsViowpOU80zGWLUQQNtOE3byy7H5Auyp+5iCId6ZazGWlMCflSox9sOw6lC9yhsIxAO0K6Rhe6xO6x9DpVio7SNer2tubWwSgdX1ZySe+y7rW9aPOkunCNdJkr2nvfTci0LqMXOA74+oWiGmW2hTnAxu7Fox5+GSEng1laF6+ZsGQANX5I0ukbiCgQ/jBmjYVQuTQsiYH+UWKXGCbznZNaWdBYDoOHGSY/do0ZFlNNR3JQnZznrs85TWpOLyS+6ZJtNHwhuQgh9sthnsLHRVgoJzVDskfgdjlBJq3EE2kTXGiAAAAAElFTkSuQmCC", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABVklEQVR4AZySM5xcYRTFY9u2kyZo4iq2kzK2bdu2u6Bbo1rb3v3uue+NZ9rdbndsvtnfae//6pw25ijVegCn6SGGRgNcgRkmPFOPVACgDEY0wWwTt1AjjGhAGWLxhW7QDmlYACBGi9G4awcKxBG5X/1IHodZvIYO0E38h4Fq+T739V/pKgqwy9w2yBpteTq9RIm5nQ8gD/cv9oVQUT9S8Vs13fg74pT60I43ow6/NN0UAHJX7KJS5ImlCpyW5uAZDIjHSp/bggENk/g6aiBwp2FSxCzRYk6AHq8xz6dvcEDVH/8gsKeus6Is1fVCFd+nLorDR9vwO1hB/SDfJp5TR0HGJXmCP4BNIOmWfnCQG2gMvwdDi394Qidph1jEs606ag+lEW+lGUHfWj+StvN5eom/SEc+lUIHs0OUWTc9CBBkJTOakSq22h8dGaD1+M2WWSP4tC81AA41eI6chFwMAAAAAElFTkSuQmCC"],
};

type Scope = "all" | "sheet" | "selection";
interface AnnotateOpts { order: "x" | "y"; keep: boolean; start: number; sheetInterval: number; sheetNumber?: number; only?: Set<string>; reserved?: string[]; regroup?: boolean }
interface SchAnnotate {
  annotateChanges(doc: KDoc, opts: AnnotateOpts): KChange[];
  annotateMessages(doc: KDoc, changes: KChange[], clear?: boolean): string[];
  clearAnnotationChanges(doc: KDoc, only?: Set<string> | null): KChange[];
}
const sch = (): SchAnnotate | null => ((window as unknown as { CollabTools?: { sch?: SchAnnotate } }).CollabTools || {}).sch || null;

/** What the dialog remembers between openings (KiCad keeps these in the eeschema settings). */
const A = { scope: "all" as Scope, order: "x" as "x" | "y", numbering: "first" as "first" | "100" | "1000", start: 0, keep: true, recursive: true, regroup: false };


/** The annotated references of a sheet ("R1", "#PWR03"; "R?" is not one) — what the other sheets must not reuse. */
export function usedRefs(doc: KDoc): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !/\?$/.test(it.ref)) out.push(it.ref);
  return out;
}
const pageOf = (doc: KDoc, fallback: number): number => { const p = parseInt(String((doc as KDoc & { pageNumber?: string }).pageNumber || ""), 10); return p > 0 ? p : fallback; };
const inverseOf = (doc: KDoc, ch: KChange[]): KChange[] => ch.map((c) => { const it = doc.items.get(c.id as string); return it ? KiCadCanvas.replaceChange(doc, it) : null; }).filter(Boolean) as KChange[];

/**
 * The references the project's other sheets use, kept on the schematic module (state.otherRefs) so that placing,
 * pasting or repeating a symbol never takes a number another sheet already has.  Refreshed when a sheet opens and
 * after an annotation; a sheet edited elsewhere since then is caught by the next refresh (and by ERC).
 */
let refreshing = 0;
export async function refreshOtherRefs(): Promise<void> {
  const S = (window as unknown as { CollabTools?: { sch?: { state: { otherRefs?: Set<string> } } } }).CollabTools?.sch; if (!S || !E.kdoc || E.kdoc.type !== "sch") return;
  const mine = ++refreshing, set = new Set<string>();
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try { for (const r of usedRefs(await readDoc(d.docId, "kicad_sch"))) set.add(r); } catch (e) { /* unreadable sheet: its references stay unknown */ }
    if (mine !== refreshing) return;   // a newer refresh (another sheet opened) supersedes this one
  }
  S.state.otherRefs = set;
}

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
/** m_MessageWindow (WX_HTML_REPORT_PANEL): the lines AnnotateSymbols reports, actions unless they are errors. */
let report: { el: HTMLElement; set(lines: ReportLine[]): void } | null = null;
let reportLines: ReportLine[] = [];
const say = (text: string, bad = false) => {
  if (!report) return; reportLines.push({ severity: bad ? "error" : "action", text }); report.set(reportLines);
  const list = report.el.firstElementChild as HTMLElement | null; if (list) list.scrollTop = list.scrollHeight;
};
const clearReport = (): void => { reportLines = []; if (report) report.set(reportLines); };

const dirOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
/** The sheets below this one (Recurse into subsheets): the sheet files its sheets name, then theirs. */
function belowHere(others: { docId: string; path: string; doc: KDoc }[], only: Set<string> | null): typeof others {
  const here = projectDocs().find((d) => d.docId === appState.docId), byPath = new Map(others.map((o) => [o.path, o])), out: typeof others = [], seen = new Set<string>();
  const walk = (doc: KDoc, dir: string, sel: Set<string> | null): void => {
    for (const f of subsheetFiles(doc, dir, sel)) { const o = byPath.get(f); if (!o || seen.has(o.docId)) continue; seen.add(o.docId); out.push(o); walk(o.doc, dirOf(o.path), null); }
  };
  if (E.kdoc) walk(E.kdoc, here ? dirOf(here.path) : "", only);
  return out;
}
async function otherSheets(): Promise<{ docId: string; path: string; doc: KDoc }[]> {
  const out: { docId: string; path: string; doc: KDoc }[] = [];
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try { out.push({ docId: d.docId, path: d.path, doc: await readDoc(d.docId, "kicad_sch") }); } catch (e) { say(`Could not read ${d.path}: ${(e as Error).message}`, true); }
  }
  return out;
}

async function runAnnotate(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  clearReport();
  if (E.viewOnly) { say("View-only access", true); return; }
  const interval = A.numbering === "100" ? 100 : A.numbering === "1000" ? 1000 : 0;
  await storeReusedSheetMode();   // annotation reads the mode from the project
  // OnAnnotateClick: regroupUnits = resetAnnotation && m_checkRegroupUnits
  const base: AnnotateOpts = { order: A.order, keep: A.keep, start: A.numbering === "first" ? A.start : 0, sheetInterval: interval, regroup: !A.keep && A.regroup };
  const only = A.scope === "selection" ? new Set<string>(E.selection) : undefined;
  if (A.scope === "selection" && E.selected) only!.add(E.selected.id);
  const others = await otherSheets();
  // the sheets annotated besides this one: all of them, or with Recurse the ones below this sheet (or the selected sheets)
  const targets = A.scope === "all" ? others : A.recursive ? belowHere(others, only || null) : [];
  const targetIds = new Set(targets.map((t) => t.docId));
  // the references the sheets left alone keep: everything on them when only some sheets are annotated, or when existing
  // annotations are kept; a reset of the entire schematic starts from nothing and fills sheet after sheet
  const reserved: string[] = others.filter((o) => !targetIds.has(o.docId) || A.keep).flatMap((o) => usedRefs(o.doc));
  const here = S.annotateChanges(E.kdoc, Object.assign({}, base, { only, reserved, sheetNumber: pageOf(E.kdoc, 1) }));
  const lines: string[] = S.annotateMessages ? S.annotateMessages(E.kdoc, here) : [];
  if (here.length) toolCtx().commit(here, "Annotate");
  reserved.push(...usedRefs(E.kdoc));
  for (const [i, o] of targets.entries()) {
    const ch = S.annotateChanges(o.doc, Object.assign({}, base, { reserved: reserved.slice(), sheetNumber: pageOf(o.doc, i + 2) }));
    if (ch.length) {
      const inverse = inverseOf(o.doc, ch), msgsHere = S.annotateMessages ? S.annotateMessages(o.doc, ch) : [];
      try { await submitDocOp(o.docId, ch); } catch (e) { say(`Could not annotate ${o.path}: ${(e as Error).message}`, true); continue; }
      pushUndoFor(o.docId, { label: "Annotate", changes: ch, inverse }); lines.push(...msgsHere);
      for (const c of ch) KiCadCanvas.applyChange(o.doc, c, 1e4);
    }
    reserved.push(...usedRefs(o.doc));
  }
  for (const l of lines) say(l);
  say("Annotation complete.");
  void refreshOtherRefs();
}

async function runClear(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  clearReport();
  if (E.viewOnly) { say("View-only access", true); return; }
  const only = A.scope === "selection" ? new Set<string>(E.selection) : null;
  if (only && E.selected) only.add(E.selected.id);
  const here = S.clearAnnotationChanges(E.kdoc, only);
  const lines: string[] = S.annotateMessages ? S.annotateMessages(E.kdoc, here, true) : [];
  if (here.length) toolCtx().commit(here, "Delete Annotation");
  const others = A.scope === "all" || A.recursive ? await otherSheets() : [];
  const targets = A.scope === "all" ? others : A.recursive ? belowHere(others, only) : [];
  for (const o of targets) {
    const ch = S.clearAnnotationChanges(o.doc, null); if (!ch.length) continue;
    const inverse = inverseOf(o.doc, ch), msgsHere = S.annotateMessages ? S.annotateMessages(o.doc, ch, true) : [];
    try { await submitDocOp(o.docId, ch); } catch (e) { say(`Could not clear ${o.path}: ${(e as Error).message}`, true); continue; }
    pushUndoFor(o.docId, { label: "Delete Annotation", changes: ch, inverse }); lines.push(...msgsHere);
    for (const c of ch) KiCadCanvas.applyChange(o.doc, c, 1e4);
  }
  for (const l of lines) say(l);
}

let reuseSuffix = false, initialReuse = false;
/** storeReusedSheetMode: the Reused Sheets choice written to the project when it changed. */
async function storeReusedSheetMode(): Promise<void> {
  if (reuseSuffix === initialReuse) return;
  initialReuse = reuseSuffix; const on = reuseSuffix;
  await saveProject((pro) => { sub(pro, "schematic", "annotation").reused_sheet_suffixes = on; }, "annotation options");
}
export function openAnnotate(): void {
  const radio = (name: string, value: string, label: string, on: boolean, set: () => void, disabled = false) => {
    const r = h("input", { type: "radio", name, value, checked: on, disabled, id: `kd-ann-${name}-${value}` }); r.addEventListener("change", () => { if (r.checked) set(); });
    return h("label", { class: "kd-chk", style: "display:flex;gap:6px;align-items:center" }, r, label);
  };
  const box = (title: string, ...rows: HTMLElement[]) => { const b = h("div", { style: "flex:1;min-width:0" }); KD().staticBox(b, title).append(...rows); return b; };
  api = KD().open({
    title: "Annotate Schematic", width: 600,
    build(body) {
      // m_MessageWindow: WX_HTML_REPORT_PANEL labelled "Annotation Messages:", saved as report.txt (SetFileName)
      reportLines = []; report = reportPanel("160px", { fileName: "report.txt", empty: "" });
      (report.el.firstElementChild as HTMLElement).setAttribute("data-ann-msgs", "1");
      report.set(reportLines);
      const messages = h("div", { style: "margin-top:10px" }); KD().staticBox(messages, "Annotation Messages:").append(report.el);
      const hasSel = E.selection.size > 0 || !!E.selected;
      const start = textInput(String(A.start), (v) => { A.start = Math.max(0, parseInt(v, 10) || 0); }, { id: "kd-ann-start", style: "width:70px", type: "number", min: "0" });
      const dark = effectiveTheme() === "dark";
      // bSizerXpos / bSizerYpos: the radio button, then annotate_down_right / annotate_right_down beside it
      const withBmp = (row: HTMLElement, o: string) => h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:12px" }, row, h("img", { src: ORDER_BMP[o][dark ? 1 : 0], width: "24", height: "24", alt: "" }));
      const withTip = (row: HTMLElement, tip: string) => { row.title = tip; return row; };
      reuseSuffix = obj(obj(obj(projectJson()).schematic).annotation).reused_sheet_suffixes === true;
      initialReuse = reuseSuffix;
      const regroup = checkbox("Regroup symbol units", A.regroup, (on) => { A.regroup = on; }, { id: "kd-ann-regroup", disabled: A.keep });
      const regroupBox = regroup.querySelector("input") as HTMLInputElement;
      const keepChanged = (keep: boolean): void => { A.keep = keep; regroupBox.disabled = keep; regroup.style.opacity = keep ? ".5" : ""; };
      if (A.keep) regroup.style.opacity = ".5";
      // fgSizer1 (2 × 2): Scope | Order, Options | Numbering; the Reused Sheets box; then the message panel
      body.append(
        h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px" },
          box("Scope", radio("scope", "all", "Entire schematic", A.scope === "all", () => { A.scope = "all"; }), radio("scope", "sheet", "Current sheet only", A.scope === "sheet", () => { A.scope = "sheet"; }),
            radio("scope", "selection", "Selection", A.scope === "selection", () => { A.scope = "selection"; }, !hasSel),
            checkbox("Recurse into subsheets", A.recursive, (on) => { A.recursive = on; }, { id: "kd-ann-recursive" })),
          box("Order", withBmp(radio("order", "x", "Sort symbols by X position", A.order === "x", () => { A.order = "x"; }), "x"), withBmp(radio("order", "y", "Sort symbols by Y position", A.order === "y", () => { A.order = "y"; }), "y")),
          box("Options", radio("keep", "keep", "Keep existing annotations", A.keep, () => keepChanged(true)), radio("keep", "reset", "Reset existing annotations", !A.keep, () => keepChanged(false)), regroup),
          box("Numbering", h("div", { style: "display:flex;gap:6px;align-items:center" }, radio("num", "first", "Use first free number after:", A.numbering === "first", () => { A.numbering = "first"; }), start),
            radio("num", "100", "First free after sheet number X 100", A.numbering === "100", () => { A.numbering = "100"; }),
            radio("num", "1000", "First free after sheet number X 1000", A.numbering === "1000", () => { A.numbering = "1000"; }))),
        // sbSizerReusedSheets: SCHEMATIC_SETTINGS::m_AnnotateReusedSheetSuffixes (annotation.reused_sheet_suffixes)
        h("div", { style: "margin-top:8px" }, box("Reused Sheets",
          radio("reuse", "separate", "Number each sheet instance separately (R1, R2 ...)", !reuseSuffix, () => { reuseSuffix = false; }),
          withTip(radio("reuse", "suffix", "Number each file once and add the sheet's reference suffix (R1_M1, R1_M2 ...)", reuseSuffix, () => { reuseSuffix = true; }),
            "Repeated instances of one sheet file need distinct full reference suffixes. Set Reference Suffix in Sheet Properties."))),
        messages);
      if (A.scope === "selection" && !hasSel) { A.scope = "all"; const r = body.querySelector<HTMLInputElement>("#kd-ann-scope-all"); if (r) r.checked = true; }
    },
    buttons: [
      { label: "Clear Annotation", fn: () => { void runClear(); }, id: "kd-ann-clear" },
      { label: "Close", close: true },
      { label: "Annotate", primary: true, isDefault: true, fn: () => { void runAnnotate(); }, id: "kd-ann-run" },
    ],
  });
}
