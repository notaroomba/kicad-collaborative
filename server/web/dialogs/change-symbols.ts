// dialogs/change-symbols.ts — Edit > Change Symbols… and Tools > Update Symbols from Library…
// (eeschema/dialogs/dialog_change_symbols.cpp, DIALOG_CHANGE_SYMBOLS in MODE::CHANGE / MODE::UPDATE).
//
// Scope radios (all symbols — update mode only —, the selected symbol(s), by reference designator, by value, by
// library identifier with a browse button), in Change mode the "New library identifier:" row, the "Update/Reset
// Fields" checklist with Select All / Select None, the "Update Options" checkboxes with Check All / Uncheck All,
// and the report panel.  Update / Change runs across every sheet of the project: the library symbol is fetched
// (KiCadLibrary.fetch), embedded in the sheet's lib_symbols, and each matching symbol rebuilt from it with the
// options (change-symbols-logic.ts updateSymbolNode).  The sheet on screen is one commit; the other sheets are
// edited through their own documents, each step on that sheet's undo list, as Annotate does.
import { E, appState, pushUndoFor, toolCtx } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { projectDocs, readDoc, submitDocOp } from "./project";
import * as L from "./change-symbols-logic";
import * as core from "../library/core";
import { fetchItem } from "../library/sources";

type Mode = "update" | "change";
interface LibApi { fetch(kind: "symbol", id: string): Promise<{ symbol?: string; libId?: string }>; openChooser(kind: "symbol", opts?: { title?: string; filter?: string; browser?: boolean }): Promise<{ libId?: string } | null> }
const libApi = (): LibApi | null => (window as unknown as { KiCadLibrary?: LibApi }).KiCadLibrary || null;
interface SchHelpers { autoplaceNode(doc: KDoc, item: KItem, opts?: unknown): SNode | null }
const schH = (): SchHelpers | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchHelpers : null; };

/** What each mode remembers between openings (DIALOG_SHIM saves the controls' state). */
const remembered: Record<Mode, { scope: L.Scope; opts: L.UpdateOptions; checked: Set<string> | null } | undefined> = { update: undefined, change: undefined };

interface Sheet { docId: string; path: string; doc: KDoc; current: boolean }
async function allSheets(): Promise<Sheet[]> {
  const out: Sheet[] = [{ docId: String(appState.docId || ""), path: "", doc: E.kdoc as KDoc, current: true }];
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try { out.push({ docId: d.docId, path: d.path, doc: await readDoc(d.docId, "kicad_sch"), current: false }); } catch (e) { /* unreadable sheet: left alone */ }
  }
  return out;
}
function selectedIds(): Set<string> {
  const ids = new Set<string>(E.selection); if (E.selected) ids.add(E.selected.id);
  const S = CollabTools.sch ? CollabTools.sch.state as { sel?: string | null; multi?: Iterable<string> | null } : null;
  if (S && S.sel) ids.add(S.sel); if (S && S.multi) for (const i of S.multi) ids.add(i);
  return ids;
}

/** Fetch and flatten a library symbol, embedded under its lib id (null: not found). */
const libCache = new Map<string, SNode | null>();
async function libSymbol(libId: string): Promise<SNode | null> {
  if (libCache.has(libId)) return libCache.get(libId) as SNode | null;
  const api = libApi(); let out: SNode | null = null;
  // the project's own symbol libraries first (its sym-lib-table entries), then the official ones
  try { const got = await fetchItem("symbol", { id: libId, name: core.parseLibId(libId).name, source: "project" } as Parameters<typeof fetchItem>[1], { docs: projectDocs(), doc: E.kdoc as KDoc }); if (got && got.symbol) out = core.embedSymbol(libId, core.flattenSymbol(core.symbolNodeOf(got.symbol, core.parseLibId(libId).name))); } catch (e) { out = null; }
  if (!out && api) { try { const got = await api.fetch("symbol", libId); if (got && got.symbol) out = core.embedSymbol(libId, core.flattenSymbol(core.symbolNodeOf(got.symbol, core.parseLibId(libId).name))); } catch (e) { out = null; } }
  libCache.set(libId, out);
  return out;
}

export function openChangeSymbols(mode: Mode): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  libCache.clear();
  const doc = E.kdoc as KDoc, sel = selectedIds();
  const symbol = Array.from(sel).map((id) => doc.items.get(id)).find((it) => it && it.kind === "symbol") || null;
  const mem = remembered[mode] || (remembered[mode] = { scope: mode === "update" ? "all" : "reference", opts: L.defaultOptions(mode), checked: null });
  const o = mem.opts;
  // TransferDataToWindow: a selected symbol picks "selected"; otherwise all (update) or by reference (change)
  let scope: L.Scope = symbol ? "selected" : mode === "update" ? "all" : (mem.scope === "selected" || mem.scope === "all" ? "reference" : mem.scope);
  const C = mode === "change";
  const word = C ? "Change" : "Update";
  let refText = "", valText = "", idText = "", newId = "";
  if (symbol) { refText = L.symbolRefs(symbol.node)[0] || ""; const v = L.fieldOf(symbol.node, "Value"); valText = v ? L.propValue(v) : ""; idText = L.libIdOf(symbol.node); }
  let api: DlgApi | null = null, fieldsHost: HTMLElement | null = null, report: HTMLElement | null = null;
  const checks = new Map<string, HTMLInputElement>();
  const optBoxes = new Map<keyof L.UpdateOptions, HTMLInputElement>();

  const say = (text: string, sev: "error" | "action" | "info" = "action") => { if (!report) return; report.append(h("div", { style: sev === "error" ? "color:var(--err)" : "" }, text)); report.scrollTop = report.scrollHeight; };

  const matching = (sheets: { doc: KDoc; current: boolean }[]): KItem[] => {
    const arg = scope === "reference" ? refText : scope === "value" ? valText : idText;
    const out: KItem[] = [];
    for (const s of sheets) for (const it of s.doc.items.values()) if (it.kind === "symbol" && L.isMatch(it.node, scope, arg, s.current && sel.has(it.id))) out.push(it);
    return out;
  };
  /** updateFieldsList: the mandatory fields, then every other field name of the matching symbols and their library symbols. */
  const refreshFields = async (): Promise<void> => {
    if (!fieldsHost) return;
    const here = matching([{ doc, current: true }]);
    const libs: SNode[] = [];
    if (C) { if (/^[^:]+:.+$/.test(newId)) { const l = await libSymbol(newId); if (l) libs.push(l); } }
    else for (const it of here) { const l = doc.lib.get(L.libIdOf(it.node)); if (l) libs.push(l); }
    const names = L.MANDATORY.concat(L.fieldNames(here.map((it) => it.node), libs));
    const before = new Map<string, boolean>(); for (const [k, cb] of checks) before.set(k, cb.checked);
    const allChecked = Array.from(checks).every(([k, cb]) => cb.checked || k === "Reference" || k === "Value");
    checks.clear(); fieldsHost.replaceChildren();
    for (const name of names) {
      const on = before.has(name) ? !!before.get(name) : mem.checked ? mem.checked.has(name) : L.MANDATORY.includes(name) ? (name !== "Reference" && name !== "Value") : (allChecked || o.fields.has(name));
      const row = checkbox(name, on, undefined, { id: "kd-chs-f-" + name.replace(/\W/g, "_") });
      checks.set(name, row.querySelector("input") as HTMLInputElement); fieldsHost.append(row);
    }
  };
  const radio = (value: L.Scope, label: string, input?: HTMLElement) => {
    const r = h("input", { type: "radio", name: "kd-chs-scope", value, checked: scope === value, id: "kd-chs-" + value });
    r.addEventListener("change", () => { if (r.checked) { scope = value; void refreshFields(); } });
    return [h("label", { class: "kd-chk", style: "display:flex;gap:6px;align-items:center;white-space:nowrap" }, r, label), input || h("span")];
  };
  const browse = (set: (id: string) => void, input: () => HTMLInputElement) => h("button", { class: "btn", type: "button", title: "Browse library", style: "padding:0 6px", onclick: async () => {
    const lib = libApi(); if (!lib) return; const got = await lib.openChooser("symbol", { title: "Choose Symbol", filter: input().value.split(":").pop() || "" }); if (got && got.libId) { input().value = got.libId; set(got.libId); void refreshFields(); }
  } }, "\u{1F4DA}");
  const opt = (key: keyof L.UpdateOptions, label: string, tip?: string) => {
    const row = checkbox(label, !!o[key], (on) => { (o as unknown as Record<string, boolean>)[key] = on; }, { id: "kd-chs-o-" + key, title: tip });
    optBoxes.set(key, row.querySelector("input") as HTMLInputElement); return row;
  };
  const setAll = (on: boolean) => { for (const [k, cb] of optBoxes) { cb.checked = on; (o as unknown as Record<string, boolean>)[k] = on; } };

  const run = async (): Promise<void> => {
    if (!report) return;
    report.replaceChildren();
    if (E.viewOnly) { say("View-only access", "error"); return; }
    o.fields = new Set(Array.from(checks).filter(([, cb]) => cb.checked).map(([k]) => k));
    mem.scope = scope; mem.checked = new Set(o.fields);
    if (C && !/^[^:]+:.+$/.test(newId.trim())) return;              // processMatchingSymbols: no valid new id, nothing happens
    const sheets = await allSheets();
    const items = new Map<KItem, Sheet>();
    const arg = scope === "reference" ? refText : scope === "value" ? valText : idText;
    for (const s of sheets) for (const it of s.doc.items.values()) if (it.kind === "symbol" && L.isMatch(it.node, scope, arg, s.current && sel.has(it.id))) items.set(it, s);
    if (!items.size) { say("*** No symbols matching criteria found ***", "error"); return; }
    const refs: L.RefContext = { used: new Set(sheets.flatMap((s) => L.sheetRefs(s.doc))), renamed: new Map() };
    const perSheet = new Map<Sheet, { changes: KChange[]; inverse: KChange[] }>();
    let processed = 0;
    for (const [it, sheet] of items) {
      const oldId = L.libIdOf(it.node), target = C ? newId.trim() : oldId, refList = L.symbolRefs(it.node);
      if (!/^[^:]+:.+$/.test(target)) { say(L.reportLine(mode, refList, oldId, target) + ": *** symbol lib id not valid ***", "error"); continue; }
      const lib = await libSymbol(target);
      if (!lib) { say(L.reportLine(mode, refList, oldId, target) + ": *** symbol not found ***", "error"); continue; }
      const unitN = KiCadCanvas.kid(it.node, "unit") as SNode | null; const unit = unitN ? KiCadCanvas.num(unitN[1], 1) : 1;
      if (L.libUnits(lib) < unit) { say(L.reportLine(mode, refList, oldId, target) + ": *** new symbol has too few units ***", "error"); continue; }
      let node = L.updateSymbolNode((KiCadCanvas.cloneNode as (n: SNode) => SNode)(it.node), lib, target, o, refs, () => KiCadCanvas.newUuid());
      // AutoplaceFields when positions were reset and the symbol's fields are autoplaced
      if (o.resetPositions && KiCadCanvas.kid(node, "fields_autoplaced")) {
        const view = Object.assign(Object.create(sheet.doc) as KDoc, { lib: new Map(sheet.doc.lib).set(target, lib) });
        try { const placed = schH()?.autoplaceNode(view, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem); if (placed) node = placed; } catch (e) { console.warn(e); }
      }
      const acc = perSheet.get(sheet) || { changes: [], inverse: [] }; perSheet.set(sheet, acc);
      acc.inverse.push(KiCadCanvas.replaceChange(sheet.doc, it));
      acc.changes.push({ id: it.id, kind: "MODIFIED", typeName: "SCH_SYMBOL", sexpr: "(lib_symbols " + KiCadCanvas.serialize(lib) + ") " + KiCadCanvas.serialize(node) } as KChange);
      say(L.reportLine(mode, L.symbolRefs(node), oldId, target) + ": OK");
      processed++;
    }
    const label = C ? "Change Symbols" : "Update Symbols";
    for (const [sheet, acc] of perSheet) {
      if (sheet.current) { toolCtx().commit(acc.changes, label); continue; }
      try { await submitDocOp(sheet.docId, acc.changes); pushUndoFor(sheet.docId, { label, changes: acc.changes, inverse: acc.inverse }); }
      catch (e) { say(`Could not update ${sheet.path}: ${(e as Error).message}`, "error"); }
    }
    if (!processed) return;
  };

  api = KD().open({
    title: C ? "Change Symbols" : "Update Symbols from Library", width: 780,
    build(body) {
      const ref = textInput(refText, (v) => { refText = v; }, { id: "kd-chs-ref", style: "width:200px" });
      const val = textInput(valText, (v) => { valText = v; }, { id: "kd-chs-val" });
      const id = textInput(idText, (v) => { idText = v; }, { id: "kd-chs-id" });
      for (const inp of [ref, val, id]) inp.addEventListener("blur", () => void refreshFields());
      const grid = h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:3px 8px;align-items:center" });
      if (!C) grid.append(...radio("all", "Update all symbols in schematic"));
      if (symbol) grid.append(...radio("selected", `${word} selected symbol(s)`));
      grid.append(...radio("reference", `${word} symbols matching reference designator:`, ref), ...radio("value", `${word} symbols matching value:`, val),
        ...radio("libid", `${word} symbols matching library identifier:`, h("div", { style: "display:flex;gap:4px" }, id, browse((v) => { idText = v; }, () => id))));
      body.append(grid, h("hr", { style: "border:0;border-top:1px solid var(--line);margin:8px 0" }));
      if (C) {
        const nid = textInput(newId, (v) => { newId = v; }, { id: "kd-chs-newid", style: "flex:1" });
        nid.addEventListener("blur", () => void refreshFields());
        body.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin-bottom:6px" }, h("label", null, "New library identifier:"), nid, browse((v) => { newId = v; }, () => nid)));
      }
      const fieldsBox = h("div", { style: "flex:1;min-width:0" }), optsBox = h("div", { style: "flex:4;min-width:0" });
      const fb = KD().staticBox(fieldsBox, C ? "Update Fields" : "Update/Reset Fields");
      fieldsHost = h("div", { id: "kd-chs-fields", style: "height:170px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:2px 4px" });
      fb.append(fieldsHost, h("div", { style: "display:flex;gap:6px;margin-top:4px" },
        h("button", { class: "btn", type: "button", onclick: () => { for (const cb of checks.values()) cb.checked = true; } }, "Select All"),
        h("button", { class: "btn", type: "button", onclick: () => { for (const cb of checks.values()) cb.checked = false; } }, "Select None")));
      const ob = KD().staticBox(optsBox, "Update Options");
      const t = (u: string, c: string) => (C ? c : u);
      const colA = h("div", { style: "flex:1;display:flex;flex-direction:column;gap:2px" },
        opt("removeExtras", t("Remove fields if not in library symbol", "Remove fields if not in new symbol"), "Removes fields that do not occur in the original library symbols"),
        opt("resetEmpty", t("Reset fields if empty in library symbol", "Reset fields if empty in new symbol")),
        opt("resetText", t("Update/reset field text", "Update field text")),
        opt("resetVisibility", t("Update/reset field visibilities", "Update field visibilities")),
        opt("resetEffects", t("Update/reset field text sizes and styles", "Update field sizes and styles")),
        opt("resetPositions", t("Update/reset field positions", "Update field positions")),
        h("button", { class: "btn", type: "button", style: "margin-top:6px", onclick: () => setAll(true) }, "Check All Update Options"));
      const fixed = (label: string) => checkbox(label, true, undefined, { disabled: true });
      const colB = h("div", { style: "flex:1;display:flex;flex-direction:column;gap:2px" },
        fixed("Update symbol shape and pins"), fixed("Update keywords and footprint filters"), h("div", { style: "height:10px" }),
        opt("resetPinTextVisibility", t("Update/reset pin name/number visibilities", "Update pin name/number visibilities")),
        opt("resetAlternates", "Reset alternate pin functions"),
        opt("resetAttributes", t("Update/reset symbol attributes", "Update symbol attributes")),
        opt("resetPinMaps", "Update/reset pin map overrides"),
        opt("resetCustomPower", "Reset custom power symbols"),
        h("button", { class: "btn", type: "button", style: "margin-top:6px", onclick: () => setAll(false) }, "Uncheck All Update Options"));
      ob.append(h("div", { style: "display:flex;gap:14px" }, colA, colB));
      body.append(h("div", { style: "display:flex;gap:10px" }, fieldsBox, optsBox));
      report = h("div", { id: "kd-chs-report", style: "margin-top:10px;height:200px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:4px 6px;font-size:12px" });
      body.append(report);
      void refreshFields();
    },
    buttons: [
      { label: "Close", close: true },
      { label: word, primary: true, isDefault: true, fn: () => { void run(); }, id: "kd-chs-run" },
    ],
  });
  void api;
}
