// dialogs/annotate.ts — Tools → Annotate Schematic…: eeschema/dialogs/dialog_annotate.cpp (DIALOG_ANNOTATE).
// Scope (Entire schematic / Current sheet only / Selection), Order (by X / by Y), Numbering (first free after N,
// sheet number × 100, × 1000) and Options (keep / reset existing annotations); "Annotate" numbers the symbols in
// scope against every reference the project's sheets already use (SCH_REFERENCE_LIST over the whole hierarchy),
// "Clear Annotation" resets them to "R?".  Other sheets are edited through their own documents, each step on
// that sheet's undo list, as Find and Replace's Replace All does.
import { E, appState, pushUndoFor, toolCtx } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { projectDocs, readDoc, submitDocOp } from "./project";

type Scope = "all" | "sheet" | "selection";
interface AnnotateOpts { order: "x" | "y"; keep: boolean; start: number; sheetInterval: number; sheetNumber?: number; only?: Set<string>; reserved?: string[] }
interface SchAnnotate {
  annotateChanges(doc: KDoc, opts: AnnotateOpts): KChange[];
  clearAnnotationChanges(doc: KDoc, only?: Set<string> | null): KChange[];
}
const sch = (): SchAnnotate | null => ((window as unknown as { CollabTools?: { sch?: SchAnnotate } }).CollabTools || {}).sch || null;

/** What the dialog remembers between openings (KiCad keeps these in the eeschema settings). */
const A = { scope: "all" as Scope, order: "x" as "x" | "y", numbering: "first" as "first" | "100" | "1000", start: 0, keep: true };

/** The annotated references of a sheet ("R1", "#PWR03"; "R?" is not one) — what the other sheets must not reuse. */
export function usedRefs(doc: KDoc): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !/\?$/.test(it.ref)) out.push(it.ref);
  return out;
}
const pageOf = (doc: KDoc, fallback: number): number => { const p = parseInt(String((doc as KDoc & { pageNumber?: string }).pageNumber || ""), 10); return p > 0 ? p : fallback; };
const inverseOf = (doc: KDoc, ch: KChange[]): KChange[] => ch.map((c) => { const it = doc.items.get(c.id as string); return it ? KiCadCanvas.replaceChange(doc, it) : null; }).filter(Boolean) as KChange[];

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
let msgs: HTMLElement | null = null;
const say = (text: string, bad = false) => { if (!msgs) return; msgs.append(h("div", { style: bad ? "color:var(--err)" : "" }, text)); msgs.scrollTop = msgs.scrollHeight; };

async function otherSheets(): Promise<{ docId: string; path: string; doc: KDoc }[]> {
  const out: { docId: string; path: string; doc: KDoc }[] = [];
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try { out.push({ docId: d.docId, path: d.path, doc: await readDoc(d.docId, "kicad_sch") }); } catch (e) { say(`Could not read ${d.path}: ${(e as Error).message}`, true); }
  }
  return out;
}

async function runAnnotate(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  if (E.viewOnly) { say("View-only access", true); return; }
  const interval = A.numbering === "100" ? 100 : A.numbering === "1000" ? 1000 : 0;
  const base: AnnotateOpts = { order: A.order, keep: A.keep, start: A.numbering === "first" ? A.start : 0, sheetInterval: interval };
  const only = A.scope === "selection" ? new Set<string>(E.selection) : undefined;
  if (A.scope === "selection" && E.selected) only!.add(E.selected.id);
  const others = await otherSheets();
  // the references the sheets left alone keep: everything on them when only this sheet is annotated, or when existing
  // annotations are kept; a reset of the entire schematic starts from nothing and fills sheet after sheet
  const reserved: string[] = A.scope !== "all" || A.keep ? others.flatMap((o) => usedRefs(o.doc)) : [];
  const here = S.annotateChanges(E.kdoc, Object.assign({}, base, { only, reserved, sheetNumber: pageOf(E.kdoc, 1) }));
  let total = here.length, sheets = here.length ? 1 : 0;
  if (here.length) toolCtx().commit(here, "annotate");
  if (A.scope === "all") {
    reserved.push(...usedRefs(E.kdoc));
    for (const [i, o] of others.entries()) {
      const ch = S.annotateChanges(o.doc, Object.assign({}, base, { reserved: reserved.slice(), sheetNumber: pageOf(o.doc, i + 2) }));
      if (ch.length) {
        const inverse = inverseOf(o.doc, ch);
        try { await submitDocOp(o.docId, ch); } catch (e) { say(`Could not annotate ${o.path}: ${(e as Error).message}`, true); continue; }
        pushUndoFor(o.docId, { label: "annotate", changes: ch, inverse }); total += ch.length; sheets++;
        for (const c of ch) KiCadCanvas.applyChange(o.doc, c, 1e4);
      }
      reserved.push(...usedRefs(o.doc));
    }
  }
  say(total ? `Annotated ${total} symbol${total === 1 ? "" : "s"}${sheets > 1 ? ` on ${sheets} sheets` : ""}.` : "No symbols needed annotation.");
}

async function runClear(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  if (E.viewOnly) { say("View-only access", true); return; }
  const only = A.scope === "selection" ? new Set<string>(E.selection) : null;
  if (only && E.selected) only.add(E.selected.id);
  const here = S.clearAnnotationChanges(E.kdoc, only); let total = here.length;
  if (here.length) toolCtx().commit(here, "clear annotation");
  if (A.scope === "all") for (const o of await otherSheets()) {
    const ch = S.clearAnnotationChanges(o.doc, null); if (!ch.length) continue;
    const inverse = inverseOf(o.doc, ch);
    try { await submitDocOp(o.docId, ch); } catch (e) { say(`Could not clear ${o.path}: ${(e as Error).message}`, true); continue; }
    pushUndoFor(o.docId, { label: "clear annotation", changes: ch, inverse }); total += ch.length;
  }
  say(total ? `Cleared the annotation of ${total} symbol${total === 1 ? "" : "s"}.` : "No annotated symbols in scope.");
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
      const hasSel = E.selection.size > 0 || !!E.selected;
      const start = textInput(String(A.start), (v) => { A.start = Math.max(0, parseInt(v, 10) || 0); }, { id: "kd-ann-start", style: "width:70px", type: "number", min: "0" });
      body.append(
        h("div", { style: "display:flex;gap:12px" },
          box("Scope", radio("scope", "all", "Entire schematic", A.scope === "all", () => { A.scope = "all"; }), radio("scope", "sheet", "Current sheet only", A.scope === "sheet", () => { A.scope = "sheet"; }),
            radio("scope", "selection", "Selection", A.scope === "selection", () => { A.scope = "selection"; }, !hasSel),
            checkbox("Recurse into subsheets", true, undefined, { disabled: true, title: "Every sheet of the project is annotated" })),
          box("Options", radio("keep", "keep", "Keep existing annotations", A.keep, () => { A.keep = true; }), radio("keep", "reset", "Reset existing annotations", !A.keep, () => { A.keep = false; }))),
        h("div", { style: "display:flex;gap:12px;margin-top:8px" },
          box("Order", radio("order", "x", "Sort symbols by X position", A.order === "x", () => { A.order = "x"; }), radio("order", "y", "Sort symbols by Y position", A.order === "y", () => { A.order = "y"; })),
          box("Numbering", h("div", { style: "display:flex;gap:6px;align-items:center" }, radio("num", "first", "Use first free number after:", A.numbering === "first", () => { A.numbering = "first"; }), start),
            radio("num", "100", "First free after sheet number X 100", A.numbering === "100", () => { A.numbering = "100"; }),
            radio("num", "1000", "First free after sheet number X 1000", A.numbering === "1000", () => { A.numbering = "1000"; }))),
        msgs = h("div", { "data-ann-msgs": "1", style: "margin-top:10px;height:90px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:4px 6px;font-size:12px" }));
      if (A.scope === "selection" && !hasSel) { A.scope = "all"; const r = body.querySelector<HTMLInputElement>("#kd-ann-scope-all"); if (r) r.checked = true; }
    },
    buttons: [
      { label: "Clear Annotation", fn: () => { void runClear(); }, id: "kd-ann-clear" },
      { label: "Close", close: true },
      { label: "Annotate", primary: true, isDefault: true, fn: () => { void runAnnotate(); }, id: "kd-ann-run" },
    ],
  });
}
