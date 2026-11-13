// editor/variant-ops — the schematic editor's design-variant commands (SCH_EDIT_FRAME, sch_edit_frame.cpp:3345-3640
// and toolbars_sch_editor.cpp:373-440): Tools > Variants > Add / Remove / Edit Description / Rename / Copy, and the
// toolbar combo's "Add New Design Variant...".
//
// The registry is the .kicad_pro's schematic.variants ([{ "description"?, "name" }], the std::map in name order
// that SCHEMATIC_SETTINGS writes, nlohmann's sorted keys); the per-symbol data is each instance's (variant …).
// Each command is one undo step (the entry's undoOthers / redoOthers) that swaps only the variant data it touched,
// so a peer's variants and edits made in between survive (see variantCommand).
import { E } from "./state";
import { state } from "./appstore";
import { pushUndoFor } from "./tools";
import { applyChanges } from "./doc";
import { sendOp } from "./net";
import { toast } from "./util";
import { listPick, textEntry } from "./panels/core";
import { h, openDialog } from "./pcbdialogs/ui";
import { loadProject, onProjectChanged, readDoc, saveProject, submitDocOp, type JsonObj } from "../dialogs/project";
import { sheetList } from "../dialogs/sch-hierarchy";
import { ADD_VARIANT_ENTRY, VARIANT_SEPARATOR, currentVariant, refreshVariantNames, setCurrentVariant, variantDescription, variantNamesForUI } from "./variant";
import * as VM from "../canvas/variant-model";

// a peer's Add / Rename / Remove reaches the .kicad_pro (editor/projectwatch adopts it): the combo follows
// (UpdateVariantSelectionCtrl), and a current variant that went away falls back to the default
onProjectChanged(() => { try { refreshVariantNames(); } catch (e) { console.warn(e); } });

/** The registry helpers live with the model (pure, tested under node). */
const registryOf = (pro: JsonObj): Map<string, string> => VM.variantRegistry(pro as Record<string, unknown>);
const writeRegistry = (pro: JsonObj, reg: Map<string, string>): void => VM.writeVariantRegistry(pro as Record<string, unknown>, reg);

/** One symbol or sheet a command changed: its node before and after (the variant data the undo swaps). */
interface Touched { id: string; before: SNode; after: SNode }

/**
 * An edit of every symbol and sheet of the hierarchy plus the registry, as one undo step labelled `label`.
 *
 * KiCad's VARIANT_PROXY_UNDO_ITEM swaps the variant data only.  Here the step keeps, per sheet, each item's node
 * before and after; an undo (redo) puts back only the instances' variants named in `names` (the ones the command
 * touched) onto the items as they stand then, and only the registry entries the command changed onto the .kicad_pro
 * as it stands then: a variant a peer added meanwhile, or a peer's edit of a symbol, is kept.
 */
async function variantCommand(label: string, edit: (node: SNode) => SNode, registry: (reg: Map<string, string>) => void, names: string[], undoable = true): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return; }
  const doc = E.kdoc as KDoc, hereId = String(state.docId || "");
  // the open sheet
  const here: Touched[] = [], changes: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    const n = edit(it.node); if (n === it.node) continue;
    here.push({ id: it.id, before: it.node, after: n });
    changes.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
  }
  if (changes.length) { applyChanges(changes); sendOp(changes); }
  // the other sheets
  const others: { docId: string; touched: Touched[] }[] = [];
  let sheets: Awaited<ReturnType<typeof sheetList>> = [];
  try { sheets = await sheetList(); } catch (e) { sheets = []; }
  const seen = new Set<string>([hereId]);
  for (const s of sheets) {
    if (seen.has(s.docId)) continue; seen.add(s.docId);
    try {
      const fresh = await readDoc(s.docId, "kicad_sch");
      const ch: KChange[] = [], touched: Touched[] = [];
      for (const it of fresh.items.values()) {
        if (it.kind !== "symbol" && it.kind !== "sheet") continue;
        const n = edit(it.node); if (n === it.node) continue;
        touched.push({ id: it.id, before: it.node, after: n });
        ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
      }
      if (ch.length) { await submitDocOp(s.docId, ch); others.push({ docId: s.docId, touched }); }
    } catch (e) { toast(`Could not update '${s.path}'.`); }
  }
  // the registry
  let delta: VM.RegistryDelta[] = [];
  try {
    const pro = await loadProject(); const before = registryOf(pro), after = new Map(before); registry(after);
    delta = VM.registryDelta(before, after);
    if (delta.length) await saveProject((p) => { const reg = registryOf(p); VM.applyRegistryDelta(reg, delta, "after"); writeRegistry(p, reg); }, label);
  } catch (e) { delta = []; toast("Could not update the project file."); }
  const which = (w: "before" | "after") => () => {
    // the open sheet (the undo list is per sheet, so it is the one on screen)
    const d = E.kdoc as KDoc | null;
    if (d && here.length) {
      const ch: KChange[] = [];
      for (const t of here) { const it = d.items.get(t.id); if (!it) continue; const n = VM.restoreSymbolVariants(it.node, t[w], names); if (n !== it.node) ch.push(KiCadCanvas.replaceChange(d, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem)); }
      if (ch.length) { applyChanges(ch); sendOp(ch); }
    }
    for (const o of others) {
      void readDoc(o.docId, "kicad_sch").then((fresh) => {
        const ch: KChange[] = [];
        for (const t of o.touched) { const it = fresh.items.get(t.id); if (!it) continue; const n = VM.restoreSymbolVariants(it.node, t[w], names); if (n !== it.node) ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem)); }
        return ch.length ? submitDocOp(o.docId, ch) : 0;
      }).catch(() => toast("Could not update a sheet."));
    }
    if (delta.length) void saveProject((p) => { const reg = registryOf(p); VM.applyRegistryDelta(reg, delta, w); writeRegistry(p, reg); }, label)
      .then(() => refreshVariantNames()).catch(() => toast("Could not update the project file."));
  };
  if (undoable) pushUndoFor(hereId, { label, changes: [], inverse: [], undoOthers: which("before"), redoOthers: which("after") } as never);
  refreshVariantNames();
}

/** SCH_EDIT_FRAME::ValidateNewVariantName: false (and the infobar message) when the name cannot be used. */
export function validateNewVariantName(name: string, exclude = ""): boolean {
  const msg = newVariantNameError(name, VM_names(), exclude);
  if (msg) { toast(msg, 10000); return false; }
  return true;
}
const VM_names = (): string[] => variantNamesForUI().slice(1);
const newVariantNameError = VM.newVariantNameError;
const trimWx = (s: string): string => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");

/** A name / description dialog (ShowAddVariantDialog and the Edit Description dialog). */
function nameDescDialog(title: string, withName: boolean, desc0: string, onOk: (name: string, desc: string) => void): void {
  let nameIn: HTMLInputElement | null = null, descIn: HTMLTextAreaElement | null = null;
  openDialog({ title, width: 360,
    build(body) {
      if (withName) { nameIn = h("input", { type: "text", "data-k": "variant-name", style: "width:100%" }) as HTMLInputElement; body.append(h("label", { class: "pd-lbl" }, "Variant name:"), nameIn); }
      descIn = h("textarea", { "data-k": "variant-desc", style: "width:100%;min-height:60px" }) as HTMLTextAreaElement; descIn.value = desc0;
      body.append(h("label", { class: "pd-lbl", style: withName ? "margin-top:8px" : "" }, withName ? "Description (optional):" : "Description:"), descIn);
      setTimeout(() => { (nameIn || descIn)?.focus(); }, 0);
    },
    ok() { const n = nameIn ? trimWx(nameIn.value) : "", d = descIn ? trimWx(descIn.value) : ""; setTimeout(() => onOk(n, d), 0); return true; } });
}

/** The dialogs a command asks through: the editor's (one dialog at a time) or, from inside a dialog (the Symbol
 *  Fields Table), ones stacked over it. */
export interface VariantPrompts {
  text(title: string, message: string, value: string): Promise<string | null>;
  nameDesc(title: string, withName: boolean, desc0: string): Promise<{ name: string; desc: string } | null>;
}
const editorPrompts: VariantPrompts = {
  text: textEntry,
  nameDesc: (title, withName, desc0) => new Promise((resolve) => nameDescDialog(title, withName, desc0, (name, desc) => resolve({ name, desc }))),
};

/** ShowAddVariantDialog ("New Design Variant"), and Tools > Variants > Add Design Variant... */
export function addVariant(done?: (name: string) => void, prompts: VariantPrompts = editorPrompts): void {
  if (E.viewOnly) { toast("View-only access"); return; }
  void prompts.nameDesc("New Design Variant", true, "").then((r) => {
    if (!r) return; const name = trimWx(r.name), desc = trimWx(r.desc);
    if (!validateNewVariantName(name)) return;
    void variantCommand("Add Variant", (n) => n, (reg) => { if (!reg.has(name)) reg.set(name, ""); if (desc) reg.set(name, desc); }, []).then(() => { refreshVariantNames(addedName(name)); setCurrentVariant(name); if (done) done(name); });
  });
}
const addedName = (name: string): string[] => [...variantNamesForUI(), name];

/** Delete the variant `name` (one "Delete Variant" undo step). */
export async function removeVariantNamed(name: string): Promise<void> {
  const wasCurrent = currentVariant() === name;
  await variantCommand("Delete Variant", (n) => VM.renameSymbolVariants(n, name, null), (reg) => { reg.delete(name); }, [name]);
  if (wasCurrent) setCurrentVariant("");
  refreshVariantNames(variantNamesForUI().filter((v) => v !== name));
}

/** Tools > Variants > Remove Design Variant... */
export async function removeVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  const name = await listPick("Remove Design Variant", "Select variant name to remove:", "", choices); if (!name) return;
  await removeVariantNamed(name);
}

/** The Edit Description dialog for `name`; SetVariantDescription + OnModify (not an undo step in KiCad). */
export async function editVariantDescriptionFor(name: string, prompts: VariantPrompts = editorPrompts): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return; }
  let desc0 = ""; try { desc0 = registryOf(await loadProject()).get(name) || ""; } catch (e) { desc0 = variantDescription(name); }
  const r = await prompts.nameDesc(`Edit Description for '${name}'`, false, desc0); if (!r) return;
  const desc = trimWx(r.desc);
  try { await saveProject((p) => { const reg = registryOf(p); reg.set(name, desc); writeRegistry(p, reg); }, "Edit Variant Description"); refreshVariantNames(); }
  catch (e) { toast("Could not update the project file."); }
}

/** Tools > Variants > Edit Variant Description... */
export async function editVariantDescription(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No design variants to edit.", 10000); return; }
  const name = await listPick("Edit Variant Description", "Select variant to edit description:", "", choices); if (!name) return;
  await editVariantDescriptionFor(name);
}

/** Ask for the new name of `oldName` and rename it (one "Rename Variant" undo step). */
export async function renameVariantNamed(oldName: string, prompts: VariantPrompts = editorPrompts): Promise<void> {
  const typed = await prompts.text("Rename Design Variant", "Enter new variant name:", oldName); if (typed === null) return;
  const newName = trimWx(typed);
  if (newName === oldName) return;
  if (!validateNewVariantName(newName, oldName)) return;
  const wasCurrent = currentVariant() === oldName;
  await variantCommand("Rename Variant", (n) => VM.renameSymbolVariants(n, oldName, newName), (reg) => { if (reg.has(oldName)) { reg.set(newName, reg.get(oldName) || ""); reg.delete(oldName); } }, [oldName, newName]);
  refreshVariantNames(variantNamesForUI().filter((v) => v !== oldName).concat(newName));
  if (wasCurrent) setCurrentVariant(newName);
}

/** Tools > Variants > Rename Design Variant... */
export async function renameVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No variants to rename.", 10000); return; }
  const oldName = await listPick("Rename Design Variant", "Select variant to rename:", "", choices); if (!oldName) return;
  await renameVariantNamed(oldName);
}

/** SCHEMATIC::CopyVariant of `src` to `newName`; `undoable` false for the Symbol Fields Table's Copy (KiCad passes no
 *  commit there). */
async function copyVariantTo(src: string, newName: string, undoable: boolean): Promise<void> {
  await variantCommand("Copy Variant", (n) => VM.renameSymbolVariants(n, src, newName, true), (reg) => { if (!reg.has(newName)) reg.set(newName, ""); if (reg.has(src)) reg.set(newName, reg.get(src) || ""); }, [newName], undoable);
  refreshVariantNames(addedName(newName));
  setCurrentVariant(newName);
}

/** Tools > Variants > Copy Design Variant... */
export async function copyVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No variants to copy.", 10000); return; }
  const src = await listPick("Copy Design Variant", "Select variant to copy:", "", choices); if (!src) return;
  const typed = await textEntry("Copy Design Variant", "Enter name for the copied variant:", src + "_copy"); if (typed === null) return;
  const newName = trimWx(typed);
  if (!validateNewVariantName(newName)) return;
  await copyVariantTo(src, newName, true);
}

// ---------------------------------------------------------------- the Symbol Fields Table's variant buttons
// DIALOG_SYMBOL_FIELDS_TABLE::onDeleteVariant / onRenameVariant / onCopyVariant / onEditVariantDescription act on
// the list's selection (index 0 is the default); each returns the name the list selects afterwards (null: as is).

/** onDeleteVariant: the entry above the deleted one is selected (and made current). */
export async function fieldsTableDeleteVariant(names: string[], index: number, _prompts?: VariantPrompts): Promise<string | null> {
  if (index <= 0 || index >= names.length) { toast("Cannot delete the default variant.", 10000); return null; }
  const name = names[index];
  await variantCommand("Delete Variant", (n) => VM.renameSymbolVariants(n, name, null), (reg) => { reg.delete(name); }, [name]);
  const sel = index - 1 > 0 ? names[index - 1] : "";
  refreshVariantNames(variantNamesForUI().filter((v) => v !== name));
  setCurrentVariant(sel);
  return sel;
}
/** onRenameVariant. */
export async function fieldsTableRenameVariant(names: string[], index: number, prompts: VariantPrompts = editorPrompts): Promise<string | null> {
  if (index <= 0 || index >= names.length) { toast("Cannot rename the default variant.", 10000); return null; }
  const oldName = names[index];
  await renameVariantNamed(oldName, prompts);
  // the list selects the new name (SetStringSelection), or keeps the old one when nothing happened
  const now = variantNamesForUI(); return now.includes(oldName) ? oldName : now.find((n) => !names.includes(n)) || null;
}
/** onCopyVariant (no undo step, as in KiCad). */
export async function fieldsTableCopyVariant(names: string[], index: number, prompts: VariantPrompts = editorPrompts): Promise<string | null> {
  if (index <= 0 || index >= names.length) { toast("Cannot copy the default variant.", 10000); return null; }
  const src = names[index];
  const typed = await prompts.text("Copy Design Variant", "Enter name for the copied variant:", src + "_copy"); if (typed === null) return null;
  const newName = trimWx(typed);
  if (!newName) { toast("Variant name cannot be empty.", 10000); return null; }
  if (names.some((n) => n.toLowerCase() === newName.toLowerCase())) { toast(`Variant '${newName}' already exists.`, 10000); return null; }
  if (E.viewOnly) { toast("View-only access"); return null; }
  await copyVariantTo(src, newName, false);
  return newName;
}
/** onEditVariantDescription. */
export async function fieldsTableEditVariantDescription(names: string[], index: number, prompts: VariantPrompts = editorPrompts): Promise<string | null> {
  if (index <= 0 || index >= names.length) { toast("Cannot edit the default variant description.", 10000); return null; }
  await editVariantDescriptionFor(names[index], prompts);
  return names[index];
}

/** onVariantSelected (both editors' toolbar combo). */
export function onVariantSelected(name: string): void {
  if (name === VARIANT_SEPARATOR) return;   // the separator restores the selection (the combo shows the current one)
  if (name === ADD_VARIANT_ENTRY) { addVariant(); return; }
  setCurrentVariant(name);
}
