// dialogs/fields-table.ts — Tools → Symbol Fields Table (Bulk Edit Symbol Fields…) and Generate Bill of Materials…:
// eeschema/dialogs/dialog_symbol_fields_table.cpp over common/dialogs/dialog_fields_table_base.  One dialog, two tabs:
// "Edit" (the grouped, filterable grid; a cell edit applies to every symbol of its row) and "Export" (the BOM:
// delimiters, format presets, preview, Export downloads the file).  The field list on the left sets each column's
// BOM name, whether it is included and whether rows group by it; view presets are KiCad's built-ins plus the project's.
import { E, appState, toast, toolCtx, cloneNode } from "./editor";
import { KD, checkbox, download, h, promptFields, promptText, select, textInput, type GridApi, type GridColumn } from "./dom";
import { messageBox } from "./sch-items";
import { datasheetButton, footprintButton } from "./browse-cells";
import { commonChooserFilters, type FpChooserFilters } from "../library/fpchoice";
import { fieldNamesAreDuplicates } from "./sch-items-logic";
import { ATTR_FIELDS, BOM_FMT_PRESETS, BOM_PRESETS, ITEM_NO, QTY, bomExport, bomRows, fieldNames, str, symbolRows, withAllFields, type BomField, type BomFmt, type BomPreset, type BomRow, type SymRow } from "./logic";
import { loadProject, obj, projectDocs, projectName, readDoc, saveProject, sub, submitDocOp, type Json, type JsonObj } from "./project";
import { variantDocView, variantEditNode } from "./variant-edits";
import { currentSheetPath, setCurrentVariant, variantNamesForUI } from "../editor/variant";
import { addVariant, type VariantPrompts, fieldsTableCopyVariant, fieldsTableDeleteVariant, fieldsTableEditVariantDescription, fieldsTableRenameVariant } from "../editor/variant-ops";

/** The variant dialogs stacked over the table (KiCad opens them as children of the table). */
const stackedPrompts: VariantPrompts = {
  text: (title, message, value) => promptText(title, message, value),
  nameDesc: async (title, withName, desc0) => {
    const r = await promptFields(title, [...(withName ? [{ key: "variant-name", label: "Variant name:" }] : []), { key: "variant-desc", label: withName ? "Description (optional):" : "Description:", initial: desc0, multiline: true }]);
    return r ? { name: r["variant-name"] || "", desc: r["variant-desc"] || "" } : null;
  },
};
// KiCad's small_plus / small_edit / copy / text / small_trash bitmaps (DIALOG_FIELDS_TABLE's variant buttons), drawn
// in the button's text colour
const vIcon = (inner: string): SVGSVGElement => { const t = document.createElement("template"); t.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`; return t.content.firstChild as SVGSVGElement; };
const V_ICONS: Record<string, string> = {
  plus: '<path d="M8 2v12M14 8H2" stroke-width="2"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="9" rx="1"/><path d="M3.5 10.5h-1v-9h8v1"/>',
  text: '<path d="M3 3.5h10M8 3.5V14M6 14h4" stroke-width="1.8"/>',
  trash: '<path d="M4 13.2L3.5 5.5h9l-.5 7.7c-.05.7-.6 1.3-1.3 1.3H5.3c-.7 0-1.2-.6-1.3-1.3z" fill="currentColor" stroke-width="1"/><path d="M13.6 2h-3.2l-.25-.65A.65.65 0 009.6 1H6.5a.65.65 0 00-.58.35L5.67 2H2.43A.43.43 0 002 2.43v1.14c0 .24.2.43.43.43h11.2c.24 0 .43-.19.43-.43V2.43A.43.43 0 0013.6 2z" fill="currentColor" stroke="none"/>',
};

interface Member { docId: string; id: string }
interface Row extends SymRow { members: Member[] }
type GRow = Record<string, string | boolean | BomRow> & { _g: BomRow };
const S = appState;
const UNSAVED = "(unsaved)", SAVE = "Save preset...", DELETE = "Delete preset...";
type Scope = "Entire Project" | "Current Sheet Only" | "Current Sheet and Down" | "Selection";
const SCOPES: Scope[] = ["Entire Project", "Current Sheet Only", "Current Sheet and Down", "Selection"];
const FLAG_NODE: Record<string, [string, boolean]> = { dnp: ["dnp", true], excludeBom: ["in_bom", false], excludeBoard: ["on_board", false], excludeSim: ["exclude_from_sim", true], excludePos: ["in_pos_files", false] };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function presetFromJson(j: Json | undefined): BomPreset | null {
  const o = obj(j); if (!Array.isArray(o.fields_ordered) || !o.fields_ordered.length) return null;
  return { name: str(o.name), fields_ordered: (o.fields_ordered as JsonObj[]).map((f) => ({ name: str(f.name), label: str(f.label), show: !!f.show, group_by: !!f.group_by })), sort_field: str(o.sort_field), sort_asc: o.sort_asc !== false,
    filter_string: str(o.filter_string), group_symbols: o.group_symbols !== false, exclude_dnp: !!o.exclude_dnp, include_excluded_from_bom: !!o.include_excluded_from_bom };
}
function fmtFromJson(j: Json | undefined): BomFmt | null {
  const o = obj(j); if (typeof o.field_delimiter !== "string") return null;
  return { name: str(o.name), field_delimiter: str(o.field_delimiter), string_delimiter: str(o.string_delimiter), ref_delimiter: str(o.ref_delimiter), ref_range_delimiter: str(o.ref_range_delimiter), keep_tabs: !!o.keep_tabs, keep_line_breaks: !!o.keep_line_breaks, include_bom: !!o.include_bom };
}
const presetJson = (p: BomPreset): JsonObj => ({ exclude_dnp: p.exclude_dnp, fields_ordered: p.fields_ordered.map((f) => ({ group_by: f.group_by, label: f.label, name: f.name, show: f.show })), filter_string: p.filter_string, group_symbols: p.group_symbols, include_excluded_from_bom: p.include_excluded_from_bom, name: p.name, sort_asc: p.sort_asc, sort_field: p.sort_field });
const fmtJson = (f: BomFmt): JsonObj => ({ field_delimiter: f.field_delimiter, keep_line_breaks: f.keep_line_breaks, keep_tabs: f.keep_tabs, name: f.name, ref_delimiter: f.ref_delimiter, ref_range_delimiter: f.ref_range_delimiter, string_delimiter: f.string_delimiter });
/** The sheets a sheet file reaches through its (sheet …) items, itself included. */
function sheetAndDown(docs: Map<string, KDoc>, docId: string): Set<string> {
  const all = projectDocs().filter((d) => d.docType === "kicad_sch"), out = new Set<string>([docId]), queue = [docId];
  while (queue.length) {
    const id = queue.pop()!, d = docs.get(id), entry = all.find((x) => x.docId === id); if (!d || !entry) continue;
    const dir = entry.path.split("/").slice(0, -1).join("/");
    for (const it of d.items.values()) { if (it.kind !== "sheet" || !it.file) continue; const path = dir ? `${dir}/${it.file}` : it.file;
      const sub = all.find((x) => x.path === path) || all.find((x) => x.path.split("/").pop() === it.file!.split("/").pop()); if (sub && !out.has(sub.docId)) { out.add(sub.docId); queue.push(sub.docId); } }
  }
  return out;
}

export function openFieldsTable(exportTab = false): void {
  if (!E.kdoc) return;
  const ro = !!E.viewOnly, here = S.docId || "", docs = new Map<string, KDoc>([[here, E.kdoc as KDoc]]);
  const selection = new Set<string>(E.selection as Set<string>); if (E.selected) selection.add(E.selected.id);
  let rows: Row[] = [], scope: Scope = "Entire Project", loading = false;
  let preset: BomPreset = clone(BOM_PRESETS[0]), presetName = BOM_PRESETS[0].name, userPresets: BomPreset[] = [];
  let fmt: BomFmt = clone(BOM_FMT_PRESETS[0]), fmtName = BOM_FMT_PRESETS[0].name, userFmts: BomFmt[] = [], outFile = "${PROJECTNAME}.csv";
  let dirtySettings = false;
  // the table's variant follows the schematic's current one; edits are staged per variant and Apply writes them all
  let variant = String((E as { currentVariant?: string }).currentVariant || "");
  const edits = new Map<string, { m: Member; variant: string; values: Record<string, string>; flags: Record<string, boolean> }>();
  const editKey = (m: Member, v = variant): string => v + "\u0001" + m.docId + "\u0000" + m.id;
  const editOf = (m: Member) => { const k = editKey(m); let e = edits.get(k); if (!e) { e = { m, variant, values: {}, flags: {} }; edits.set(k, e); } return e; };
  let fieldGrid: GridApi<BomField> | null = null, grid: GridApi<GRow> | null = null, gridHost: HTMLElement | null = null, previewEl: HTMLTextAreaElement | null = null, presetSel: HTMLSelectElement | null = null, fmtSel: HTMLSelectElement | null = null, countEl: HTMLElement | null = null;
  const fmtInputs: Record<string, HTMLInputElement> = {}; let syncBar: () => void = () => {};

  // the open sheet's symbols read and write the instance on screen (GetCurrentSheet()); another sheet's, its first
  const herePath = currentSheetPath();
  const pathOf = (docId: string): string | null => (docId === here ? herePath : null);
  const buildRows = () => {
    const use = scope === "Current Sheet Only" || scope === "Selection" ? new Set([here]) : scope === "Current Sheet and Down" ? sheetAndDown(docs, here) : new Set(docs.keys());
    const byRef = new Map<string, Row>(), out: Row[] = [];
    for (const [docId, d] of docs) {
      if (!use.has(docId)) continue;
      for (const r of symbolRows(variantDocView(d, variant, pathOf(docId)), docId, !ro)) {
        if (scope === "Selection" && !r.ids.some((id) => selection.has(id))) continue;
        const prev = r.ref && !/\?$/.test(r.ref) ? byRef.get(r.ref) : undefined; const members = r.ids.map((id) => ({ docId, id }));
        if (prev) { prev.members.push(...members); continue; }
        const row: Row = Object.assign(r, { members }); out.push(row); if (r.ref) byRef.set(r.ref, row);
      }
    }
    // edits made before a rescope / reload stay on screen
    for (const r of out) for (const m of r.members) { const e = edits.get(editKey(m)); if (!e) continue; Object.assign(r.values, e.values); for (const [f, v] of Object.entries(e.flags)) (r as unknown as Record<string, boolean>)[f] = v; if (e.values.Reference !== undefined) r.ref = e.values.Reference; }
    rows = out; preset = withAllFields(preset, fieldNames(rows));
  };
  const markUnsaved = () => { dirtySettings = true; if (presetName !== UNSAVED) { presetName = UNSAVED; fillPresetSel(); } };
  const fillPresetSel = () => { if (!presetSel) return; const names = [...BOM_PRESETS.map((p) => p.name), ...userPresets.map((p) => p.name)]; presetSel.replaceChildren(...[...names, ...(presetName === UNSAVED ? [UNSAVED] : []), "---", SAVE, DELETE].map((n) => h("option", { value: n, disabled: n === "---" }, n === BOM_PRESETS[0].name ? "Default Editing" : n))); presetSel.value = presetName; };
  const fillFmtSel = () => { if (!fmtSel) return; const names = [...BOM_FMT_PRESETS.map((p) => p.name), ...userFmts.map((p) => p.name)]; fmtSel.replaceChildren(...[...names, ...(fmtName === UNSAVED ? [UNSAVED] : []), "---", SAVE, DELETE].map((n) => h("option", { value: n, disabled: n === "---" }, n))); fmtSel.value = fmtName; };
  const syncFmtInputs = () => { for (const [k, inp] of Object.entries(fmtInputs)) { const v = (fmt as unknown as Record<string, string | boolean>)[k]; if (inp.type === "checkbox") inp.checked = !!v; else inp.value = str(v).replace(/\t/g, "\\t"); } };
  const refreshPreview = () => { if (previewEl) previewEl.value = bomExport(rows, preset, fmt); };
  const refreshFields = () => { if (fieldGrid) { fieldGrid.rows.splice(0, fieldGrid.rows.length, ...preset.fields_ordered); fieldGrid.refresh(); } };
  /** getFootprintChooserSymbolNetlist: the library symbols of a row's symbols, one set of filters when they agree. */
  const rowFilters = (r: GRow): FpChooserFilters | null => commonChooserFilters((r._g.rows as Row[]).flatMap((x) => x.members).map((m) => {
    const d = docs.get(m.docId), it = d && d.items.get(m.id); if (!d || !it) return null;
    const ln = KiCadCanvas.kid(it.node, "lib_name") || KiCadCanvas.kid(it.node, "lib_id");
    return ln ? KiCadCanvas.resolveLib(d, KiCadCanvas.str(ln[1])) : null;
  }));
  const dsButton = datasheetButton();
  const refreshGrid = () => {
    if (!gridHost) return;
    const cols: GridColumn<GRow>[] = preset.fields_ordered.filter((f) => f.show).map((f) => {
      const sorted = (preset.sort_field || "Reference") === f.name ? (preset.sort_asc === false ? " ▾" : " ▴") : "";
      const base = { key: f.name, label: f.label + sorted };
      if (ATTR_FIELDS[f.name]) return Object.assign(base, { type: "bool" as const, width: 90, ro: (r: GRow) => !r._g.rows.every((x) => x.editable) });
      if (f.name === QTY || f.name === ITEM_NO) return Object.assign(base, { type: "ro" as const, width: 46 });
      // DIALOG_SYMBOL_FIELDS_TABLE: the Footprint column's GRID_CELL_FPID_EDITOR (filters only when every symbol of the
      // row has the same ones), the Datasheet column's GRID_CELL_URL_EDITOR
      const button = f.name === "Footprint" ? (r: GRow) => footprintButton(() => rowFilters(r)) : f.name === "Datasheet" ? () => dsButton : undefined;
      return Object.assign(base, { type: "text" as const, ro: (r: GRow) => (f.name === "Reference" && r._g.rows.length > 1) || !r._g.rows.every((x) => x.editable), button });
    });
    const groups = bomRows(rows, preset);
    const data: GRow[] = groups.map((g) => { const r: GRow = { _g: g }; for (const f of preset.fields_ordered) { const a = ATTR_FIELDS[f.name]; r[f.name] = a ? g.rows.every((x) => x[a.flag]) : g.cells[f.name]; } return r; });
    gridHost.replaceChildren();
    grid = KD().grid<GRow>(gridHost, cols, data, { readOnly: ro, height: "46vh",
      onHeader(c) { if (preset.sort_field === c.key || (!preset.sort_field && c.key === "Reference")) preset.sort_asc = preset.sort_asc === false; else { preset.sort_field = c.key; preset.sort_asc = true; } markUnsaved(); refreshGrid(); },
      onSelect(r) { if (!r) return; const ids = r._g.rows.flatMap((x) => (x as Row).members).filter((m) => m.docId === here).map((m) => m.id); if (ids.length) { try { toolCtx().setSelection(ids); } catch (e) { /* cross-probe is best effort */ } } },
      onChange(r, key, value) {
        if (!key) return; const a = ATTR_FIELDS[key];
        for (const x of r._g.rows as Row[]) {
          if (a) (x as unknown as Record<string, boolean>)[a.flag] = !!value; else { x.values[key] = str(value); if (key === "Reference") x.ref = str(value); }
          for (const m of x.members) { const e = editOf(m); if (a) e.flags[a.flag] = !!value; else e.values[key] = str(value); }
        }
        refreshGrid();
      } });
    if (countEl) countEl.textContent = loading ? "Loading the other sheets…" : `${rows.length} symbol${rows.length === 1 ? "" : "s"}, ${groups.length} row${groups.length === 1 ? "" : "s"}`;
  };
  const refreshAll = () => { buildRows(); refreshFields(); refreshGrid(); refreshPreview(); };

  /** The edits as changes per document; flags ride on the same change as the field texts. */
  const changesByDoc = (): Map<string, KChange[]> => {
    const sch = CollabTools.sch as SchToolModule & { fieldsTableChanges(doc: KDoc, edits: { id: string; values: Record<string, string> }[]): KChange[] };
    const out = new Map<string, KChange[]>(), byDoc = new Map<string, { id: string; values: Record<string, string>; flags: Record<string, boolean> }[]>();
    const variantEdits = new Map<string, { id: string; variant: string; values: Record<string, string>; flags: Record<string, boolean> }[]>();
    for (const e of edits.values()) {
      // with a variant, the Reference is still the symbol's own; the rest goes to the variant below
      const base = e.variant ? { id: e.m.id, values: e.values.Reference !== undefined ? { Reference: e.values.Reference } : {}, flags: {} } : { id: e.m.id, values: e.values, flags: e.flags };
      const l = byDoc.get(e.m.docId) || []; l.push(base); byDoc.set(e.m.docId, l);
      if (e.variant) { const v = variantEdits.get(e.m.docId) || []; v.push({ id: e.m.id, variant: e.variant, values: e.values, flags: e.flags }); variantEdits.set(e.m.docId, v); }
    }
    for (const [docId, list] of byDoc) {
      const d = docs.get(docId); if (!d) continue;
      const ch = new Map<string, KChange>(); for (const c of sch.fieldsTableChanges(d, list.filter((x) => Object.keys(x.values).length).map((x) => ({ id: x.id, values: x.values })))) ch.set(c.id, c);
      for (const x of variantEdits.get(docId) || []) {
        const it = d.items.get(x.id); if (!it) continue;
        const prior = ch.get(x.id); const node = (prior && prior.sexpr ? KiCadCanvas.parse(prior.sexpr) : cloneNode(it.node)) as SNode;
        const nn = variantEditNode(node, x.variant, x.values, x.flags, pathOf(docId), d.version);
        if (nn) ch.set(x.id, KiCadCanvas.replaceChange(d, Object.assign({}, it, { node: nn, geom: [], bbox: null })));
      }
      for (const x of list) {
        if (!Object.keys(x.flags).length) continue; const it = d.items.get(x.id); if (!it) continue;
        const prior = ch.get(x.id); const node = (prior && prior.sexpr ? KiCadCanvas.parse(prior.sexpr) : cloneNode(it.node)) as SNode; let any = false;
        for (const [flag, on] of Object.entries(x.flags)) { const [key, direct] = FLAG_NODE[flag] || []; const k = key ? KiCadCanvas.kid(node, key) : null; if (!k) continue; const want = (direct ? on : !on) ? "yes" : "no"; if (str(k[1]) !== want) { k[1] = want; any = true; } }
        if (any) ch.set(x.id, KiCadCanvas.replaceChange(d, Object.assign({}, it, { node, geom: [], bbox: null })));
      }
      if (ch.size) out.set(docId, [...ch.values()]);
    }
    return out;
  };
  const apply = async (): Promise<boolean> => {
    if (ro) return true;
    const byDoc = changesByDoc(); let n = 0;
    try {
      for (const [docId, ch] of byDoc) { n += ch.length; if (docId === here) toolCtx().commit(ch, "symbol fields"); else { await submitDocOp(docId, ch); const fresh = await readDoc(docId, "kicad_sch"); docs.set(docId, fresh); } }
    } catch (e) { toast("Could not apply the changes: " + (e as Error).message, 4000); return false; }
    edits.clear(); if (docs.has(here)) docs.set(here, E.kdoc as KDoc);
    if (n) toast(`Updated ${n} symbol${n === 1 ? "" : "s"}`);
    if (dirtySettings) {
      dirtySettings = false;
      saveProject((pro) => { const s = sub(pro, "schematic"); s.bom_settings = presetJson(Object.assign({}, preset, { name: presetName === UNSAVED ? "" : presetName })); s.bom_presets = userPresets.map(presetJson);
        s.bom_fmt_settings = fmtJson(Object.assign({}, fmt, { name: fmtName === UNSAVED ? "" : fmtName })); s.bom_fmt_presets = userFmts.map(fmtJson); s.bom_export_filename = outFile; }, "BOM settings").catch(() => { /* the table still applied */ });
    }
    return true;
  };
  const doExport = () => { const name = outFile.replace(/\$\{PROJECTNAME\}/g, projectName() || "project").split(/[\\/]/).pop() || "bom.csv"; download(name, bomExport(rows, preset, fmt)); toast("Exported " + name); };

  buildRows();
  const api = KD().open({ title: "Symbol Fields Table", width: 1120, cls: "kd-wide", readOnly: ro,
    extra: [{ label: "Export", fn: doExport }, ...(ro ? [] : [{ label: "Apply, Save Schematic & Continue", fn: () => { void apply().then(() => refreshAll()); } }])],
    build(body) {
      // ---- left: the field list and the view presets
      const left = h("div", { style: "width:330px;flex:none;display:flex;flex-direction:column" });
      fieldGrid = KD().grid<BomField>(left, [{ key: "name", label: "Field", type: "ro", format: (v) => (v === QTY ? "Quantity" : v === ITEM_NO ? "Item Number" : str(v)) }, { key: "label", label: "BOM Name", type: "text" }, { key: "show", label: "Include", type: "bool", width: 52 }, { key: "group_by", label: "Group By", type: "bool", width: 62 }],
        preset.fields_ordered, { height: "40vh", onChange() { markUnsaved(); preset.fields_ordered = fieldGrid!.rows; refreshGrid(); refreshPreview(); }, buttons: { move: true } });
      const bar = fieldGrid.bar || h("div", { class: "kd-grid-btns" }); if (!fieldGrid.bar) left.append(bar);
      const fbtn = (txt: string, title: string, id: string, fn: () => void) => { const b = h("button", { class: "btn", type: "button", title, id, disabled: ro, onclick: fn }, txt); bar.prepend(b); return b; };
      fbtn("🗑", "Remove selected field", "kd-sft-removefield", () => { const f = preset.fields_ordered[fieldGrid!.selected()]; if (!f) return;
        if (["Reference", "Value", "Footprint", "Datasheet", "Description", QTY, ITEM_NO].includes(f.name) || ATTR_FIELDS[f.name]) { toast(`The ${f.name} field is mandatory and cannot be removed`); return; }
        preset.fields_ordered.splice(fieldGrid!.selected(), 1); for (const r of rows) { if (r.values[f.name] !== undefined && r.values[f.name] !== "") { r.values[f.name] = ""; for (const m of r.members) editOf(m).values[f.name] = ""; } } markUnsaved(); refreshFields(); refreshGrid(); });
      fbtn("✎", "Rename selected field", "kd-sft-renamefield", () => { const f = preset.fields_ordered[fieldGrid!.selected()]; if (!f) return; void promptText("Rename Field", "New field name:", f.label).then((n) => { if (n) { f.label = n; markUnsaved(); refreshFields(); refreshGrid(); } }); });
      fbtn("+", "Add a new field", "kd-sft-addfield", () => { void promptText("Add Field", "New field name:").then((n) => {
        // DIALOG_FIELDS_TABLE::OnAddField: Cancel does nothing; an empty or taken name is a DisplayError box
        if (n === null) return;
        if (!n) { void messageBox("Field must have a name."); return; }
        if (preset.fields_ordered.some((f) => fieldNamesAreDuplicates(n, f.name))) { void messageBox(`Field name '${n}' already in use.`); return; } preset.fields_ordered.push({ name: n, label: n, show: true, group_by: false }); markUnsaved(); refreshFields(); refreshGrid(); }); });
      presetSel = select([], "", (v) => {
        if (v === SAVE) { fillPresetSel(); void promptText("Save BOM Preset", "BOM preset name:", presetName === UNSAVED ? "" : presetName).then((n) => { n = (n || "").trim(); if (!n) return; if (BOM_PRESETS.some((p) => p.name === n)) { toast("Default presets cannot be modified.\nPlease use a different name."); return; }
          userPresets = userPresets.filter((p) => p.name !== n); userPresets.push(Object.assign(clone(preset), { name: n })); presetName = n; dirtySettings = true; fillPresetSel(); }); return; }
        if (v === DELETE) { fillPresetSel(); if (!userPresets.length) { toast("No user presets to delete"); return; } void promptText("Delete BOM Preset", "Preset to delete:", userPresets[userPresets.length - 1].name).then((n) => { if (!n) return; userPresets = userPresets.filter((p) => p.name !== n); if (presetName === n) presetName = UNSAVED; dirtySettings = true; fillPresetSel(); }); return; }
        const p = BOM_PRESETS.find((x) => x.name === v) || userPresets.find((x) => x.name === v); if (!p) return;
        preset = withAllFields(clone(p), fieldNames(rows)); presetName = v; dirtySettings = true; fillPresetSel(); refreshFields(); syncEditBar(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-preset" });
      left.append(h("div", { class: "kd-row", style: "margin-top:10px" }, h("label", { style: "white-space:nowrap;color:var(--ink-2)" }, "View presets:"), presetSel)); fillPresetSel();
      // Schematic variants: the list (GetVariantNamesForUI), choosing one shows (and stages edits for) its values
      // and makes it the schematic's current variant (onVariantSelectionChange); add / rename / copy / describe / delete
      const vlist = h("k-select", { id: "kd-sft-variants", size: 5, style: "width:100%;margin-top:3px" }) as HTMLSelectElement;   // a themed list box (components/kselect.ts)
      const fillVariants = () => { const names = variantNamesForUI(); vlist.replaceChildren(...names.map((n, i) => h("option", { value: i === 0 ? "" : n }, n))); vlist.value = variant; if (vlist.selectedIndex < 0) vlist.selectedIndex = 0; };
      vlist.addEventListener("change", () => { variant = vlist.value; setCurrentVariant(variant); refreshAll(); });
      // the buttons act on the list's selection (DIALOG_SYMBOL_FIELDS_TABLE::onRenameVariant …); copy, rename,
      // describe and delete are disabled on the default (updateVariantButtonStates)
      const btns: HTMLButtonElement[] = [];
      const afterCmd = (sel: string | null) => setTimeout(() => {
        variant = String((E as { currentVariant?: string }).currentVariant || ""); fillVariants();
        if (sel !== null) { const i = variantNamesForUI().indexOf(sel); if (i >= 0) vlist.selectedIndex = i; }
        updateBtns(); refreshAll(); }, 300);
      const vbtn = (icon: string, title: string, id: string, fn: (names: string[], index: number, prompts: VariantPrompts) => Promise<string | null> | void, needsVariant: boolean) => {
        const b = h("button", { class: "btn sm", type: "button", title, id, disabled: ro, "data-needs-variant": needsVariant ? "1" : "",
          onclick: () => { const names = variantNamesForUI(); const r = fn(names, vlist.selectedIndex, stackedPrompts); if (r) void r.then((sel) => afterCmd(sel)); } }, vIcon(V_ICONS[icon])) as HTMLButtonElement;
        btns.push(b); return b;
      };
      const updateBtns = () => { for (const b of btns) if (b.dataset.needsVariant) b.disabled = ro || vlist.selectedIndex <= 0; };
      vlist.addEventListener("change", updateBtns);
      left.append(h("div", { style: "margin-top:10px" }, h("label", { style: "color:var(--ink-2)" }, "Schematic variants:"), vlist,
        h("div", { class: "kd-row", style: "gap:4px;margin-top:3px" },
          vbtn("plus", "Add a new variant", "kd-sft-addvariant", () => { addVariant((name) => afterCmd(name), stackedPrompts); }, false),
          vbtn("edit", "Rename the selected variant", "kd-sft-renamevariant", fieldsTableRenameVariant, true),
          vbtn("copy", "Copy the selected variant", "kd-sft-copyvariant", fieldsTableCopyVariant, true),
          vbtn("text", "Edit the selected variant's description", "kd-sft-descvariant", fieldsTableEditVariantDescription, true),
          h("span", { style: "flex:1" }),
          vbtn("trash", "Delete the selected variant", "kd-sft-deletevariant", fieldsTableDeleteVariant, true))));
      fillVariants(); updateBtns();

      // ---- right: Edit / Export
      const right = h("div", { style: "flex:1;min-width:0" });
      const filter = textInput(preset.filter_string, (v) => { preset.filter_string = v; refreshGrid(); }, { id: "kd-sft-filter", placeholder: "Filter", style: "width:170px" });
      const groupCb = checkbox("Group symbols", preset.group_symbols, (on) => { preset.group_symbols = on; markUnsaved(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-group", title: "Group symbols together based on common properties" });
      const dnpCb = checkbox("Include 'DNP' Symbols", !preset.exclude_dnp, (on) => { preset.exclude_dnp = !on; markUnsaved(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-dnp" });
      const exclCb = checkbox("Include 'Exclude from BOM' Symbols", preset.include_excluded_from_bom, (on) => { preset.include_excluded_from_bom = on; markUnsaved(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-excl" });
      const syncEditBar = () => { filter.value = preset.filter_string; (groupCb.firstChild as HTMLInputElement).checked = preset.group_symbols; (dnpCb.firstChild as HTMLInputElement).checked = !preset.exclude_dnp; (exclCb.firstChild as HTMLInputElement).checked = preset.include_excluded_from_bom; };
      syncBar = syncEditBar;
      KD().notebook(right, [
        { label: "Edit", build(page) {
          const scopeSel = select(SCOPES, scope, (v) => { scope = v as Scope; refreshAll(); }, { id: "kd-sft-scope", style: "width:190px" });
          page.append(h("div", { class: "kd-row", style: "margin-bottom:6px;flex-wrap:wrap" }, filter, scopeSel, groupCb, h("button", { class: "btn sm", type: "button", title: "Refresh Grouping", id: "kd-sft-refresh", onclick: () => refreshAll() }, "↻")),
            h("div", { class: "kd-row", style: "margin-bottom:6px;gap:18px" }, dnpCb, exclCb, (countEl = h("span", { style: "margin-left:auto;color:var(--ink-2)", id: "kd-sft-count" }))));
          gridHost = h("div", { id: "kd-sft-grid" }); page.append(gridHost); refreshGrid();
        } },
        { label: "Export", build(page) {
          const fi = (key: keyof BomFmt, id: string, width = 70) => { const i = textInput("", (v) => { (fmt as unknown as Record<string, string>)[key] = v.replace(/\\t/g, "\t"); fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); refreshPreview(); }, { id, style: `width:${width}px` }); fmtInputs[key] = i; return i; };
          const fc = (key: keyof BomFmt, label: string, id: string, title?: string) => { const c = checkbox(label, false, (on) => { (fmt as unknown as Record<string, boolean>)[key] = on; fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); refreshPreview(); }, { id, title }); fmtInputs[key] = c.firstChild as HTMLInputElement; return c; };
          fmtSel = select([], "", (v) => {
            if (v === SAVE) { fillFmtSel(); void promptText("Save BOM Format Preset", "BOM preset name:", fmtName === UNSAVED ? "" : fmtName).then((n) => { n = (n || "").trim(); if (!n) return; if (BOM_FMT_PRESETS.some((p) => p.name === n)) { toast("Default presets cannot be modified.\nPlease use a different name."); return; } userFmts = userFmts.filter((p) => p.name !== n); userFmts.push(Object.assign(clone(fmt), { name: n })); fmtName = n; dirtySettings = true; fillFmtSel(); }); return; }
            if (v === DELETE) { fillFmtSel(); if (!userFmts.length) { toast("No user presets to delete"); return; } void promptText("Delete BOM Format Preset", "Preset to delete:", userFmts[userFmts.length - 1].name).then((n) => { if (!n) return; userFmts = userFmts.filter((p) => p.name !== n); if (fmtName === n) fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); }); return; }
            const p = BOM_FMT_PRESETS.find((x) => x.name === v) || userFmts.find((x) => x.name === v); if (!p) return; fmt = clone(p); fmtName = v; dirtySettings = true; fillFmtSel(); syncFmtInputs(); refreshPreview(); }, { id: "kd-sft-fmt", style: "width:220px" });
          page.append(h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content max-content 1fr;gap:6px 12px;align-items:center" },
            h("label", null, "Field delimiter:"), fi("field_delimiter", "kd-sft-fd"), h("label", null, "String delimiter:"), fi("string_delimiter", "kd-sft-sd"), h("span"),
            h("label", null, "Reference delimiter:"), fi("ref_delimiter", "kd-sft-rd"), h("label", null, "Range delimiter:"), fi("ref_range_delimiter", "kd-sft-rr"), h("span", { class: "kd-note", style: "margin:0" }, "Leave blank to disable ranges.")),
            h("div", { class: "kd-row", style: "gap:18px;margin:8px 0" }, fc("keep_tabs", "Keep tabs", "kd-sft-tabs"), fc("keep_line_breaks", "Keep line breaks", "kd-sft-lb"), fc("include_bom", "Include byte order mark", "kd-sft-bom", "Can increase compatibility with older software that does not import UTF-8 correctly, such as Excel. Can worsen compatibility in some cases.")),
            h("div", { class: "kd-row", style: "margin:8px 0;border-top:1px solid var(--line);padding-top:8px" }, h("label", { style: "color:var(--ink-2)" }, "Format presets:"), fmtSel),
            h("div", { class: "kd-row", style: "margin:8px 0" }, h("label", { style: "white-space:nowrap;color:var(--ink-2)" }, "Output file:"), textInput(outFile, (v) => { outFile = v; dirtySettings = true; }, { id: "kd-sft-out" })),
            h("div", { class: "kd-row", style: "justify-content:space-between" }, h("label", { style: "color:var(--ink-2)" }, "Preview:"), h("button", { class: "btn sm", type: "button", title: "Refresh preview", onclick: refreshPreview }, "↻")),
            (previewEl = h("textarea", { id: "kd-sft-preview", readonly: true, wrap: "off", style: "height:34vh;margin-top:4px;white-space:pre;font-size:12px" })));
          fillFmtSel(); syncFmtInputs(); refreshPreview();
        } },
      ], { selected: exportTab ? 1 : 0, onSelect(i) { if (i === 1) refreshPreview(); } });
      body.append(h("div", { style: "display:flex;gap:14px" }, left, right));
      if (exportTab) refreshPreview();
    },
    ok() { void apply(); } });
  void api;

  // the project's stored BOM settings and presets, then the other sheets
  void loadProject().then((pro) => {
    const s = obj(pro.schematic); if (!KD().isOpen()) return;
    userPresets = (Array.isArray(s.bom_presets) ? s.bom_presets : []).map(presetFromJson).filter((p): p is BomPreset => !!p && !!p.name);
    userFmts = (Array.isArray(s.bom_fmt_presets) ? s.bom_fmt_presets : []).map(fmtFromJson).filter((p): p is BomFmt => !!p && !!p.name);
    const cur = presetFromJson(s.bom_settings);
    if (cur && cur.name && (BOM_PRESETS.some((p) => p.name === cur.name) || userPresets.some((p) => p.name === cur.name))) { const p = BOM_PRESETS.find((x) => x.name === cur.name) || userPresets.find((x) => x.name === cur.name)!; preset = withAllFields(clone(p), fieldNames(rows)); presetName = cur.name; }
    else if (cur && !cur.name) { preset = withAllFields(cur, fieldNames(rows)); presetName = UNSAVED; }
    const cf = fmtFromJson(s.bom_fmt_settings); if (cf) { fmt = cf; fmtName = BOM_FMT_PRESETS.some((p) => p.name === cf.name && JSON.stringify(fmtJson(p)) === JSON.stringify(fmtJson(cf))) || userFmts.some((p) => p.name === cf.name) ? cf.name : UNSAVED; }
    if (typeof s.bom_export_filename === "string" && s.bom_export_filename) outFile = s.bom_export_filename;
    const out = document.querySelector<HTMLInputElement>("#kd-sft-out"); if (out) out.value = outFile;
    fillPresetSel(); fillFmtSel(); syncFmtInputs(); syncBar(); refreshFields(); refreshGrid(); refreshPreview();
  });
  const others = projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here);
  if (others.length) {
    loading = true; refreshGrid();
    void Promise.all(others.map((d) => readDoc(d.docId, "kicad_sch").then((od) => { docs.set(d.docId, od); }, () => { /* an unreadable sheet is left out */ }))).then(() => { loading = false; if (KD().isOpen()) refreshAll(); });
  }
}
