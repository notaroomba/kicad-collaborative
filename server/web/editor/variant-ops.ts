// editor/variant-ops — the schematic editor's design-variant commands (SCH_EDIT_FRAME, sch_edit_frame.cpp:3345-3640
// and toolbars_sch_editor.cpp:373-440): Tools > Variants > Add / Remove / Edit Description / Rename / Copy, and the
// toolbar combo's "Add New Design Variant...".
//
// The registry is the .kicad_pro's schematic.variants ([{ "description"?, "name" }], the std::map in name order
// that SCHEMATIC_SETTINGS writes, nlohmann's sorted keys); the per-symbol data is each instance's (variant …).
// Each command is one undo step: the open sheet's symbols are one commit, the other sheets are written alongside
// it, and the registry is restored with them (the entry's undoOthers / redoOthers).
import { E } from "./state";
import { state } from "./appstore";
import { toolCtx, undoStack, pushUndoFor } from "./tools";
import { toast } from "./util";
import { listPick, textEntry } from "./panels/core";
import { h, openDialog } from "./pcbdialogs/ui";
import { loadProject, readDoc, saveProject, submitDocOp, type JsonObj } from "../dialogs/project";
import { sheetList } from "../dialogs/sch-hierarchy";
import { ADD_VARIANT_ENTRY, VARIANT_SEPARATOR, currentVariant, refreshVariantNames, setCurrentVariant, variantNamesForUI } from "./variant";
import * as VM from "../canvas/variant-model";

/** The registry helpers live with the model (pure, tested under node). */
const registryOf = (pro: JsonObj): Map<string, string> => VM.variantRegistry(pro as Record<string, unknown>);
const writeRegistry = (pro: JsonObj, reg: Map<string, string>): void => VM.writeVariantRegistry(pro as Record<string, unknown>, reg);

/** An edit of every symbol and sheet of the hierarchy plus the registry, as one undo step labelled `label`. */
async function variantCommand(label: string, edit: (node: SNode) => SNode, registry: (reg: Map<string, string>) => void): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return; }
  const ctx = toolCtx() as unknown as ToolCtx;
  const doc = E.kdoc as KDoc;
  // the open sheet: one commit
  const changes: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    const n = edit(it.node); if (n === it.node) continue;
    changes.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
  }
  type Hooks = { label?: string; undoOthers?: () => void; redoOthers?: () => void };
  let entry: Hooks | null = null;
  if (changes.length) { ctx.commit(changes, label); entry = undoStack[undoStack.length - 1] as unknown as Hooks; }
  else { const e: Hooks & { changes: KChange[]; inverse: KChange[] } = { label, changes: [], inverse: [] }; pushUndoFor(String(state.docId || ""), e as never); entry = e; }
  // the other sheets
  const others: { docId: string; changes: KChange[]; inverse: KChange[] }[] = [];
  let sheets: Awaited<ReturnType<typeof sheetList>> = [];
  try { sheets = await sheetList(); } catch (e) { sheets = []; }
  const seen = new Set<string>([String(state.docId || "")]);
  for (const s of sheets) {
    if (seen.has(s.docId)) continue; seen.add(s.docId);
    try {
      const fresh = await readDoc(s.docId, "kicad_sch");
      const ch: KChange[] = [], inv: KChange[] = [];
      for (const it of fresh.items.values()) {
        if (it.kind !== "symbol" && it.kind !== "sheet") continue;
        const n = edit(it.node); if (n === it.node) continue;
        inv.push(KiCadCanvas.replaceChange(fresh, it)); ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
      }
      if (ch.length) { await submitDocOp(s.docId, ch); others.push({ docId: s.docId, changes: ch, inverse: inv }); }
    } catch (e) { toast(`Could not update '${s.path}'.`); }
  }
  // the registry
  let before: Map<string, string> | null = null, after: Map<string, string> | null = null;
  try {
    const pro = await loadProject(); before = registryOf(pro); after = new Map(before); registry(after);
    const target = after;
    await saveProject((p) => writeRegistry(p, target), label);
  } catch (e) { before = after = null; }
  const setReg = (reg: Map<string, string> | null) => { if (reg) void saveProject((p) => writeRegistry(p, reg), label).then(() => refreshVariantNames()).catch(() => toast("Could not update the project file.")); };
  const replay = (which: "changes" | "inverse") => { for (const o of others) submitDocOp(o.docId, o[which]).catch(() => toast("Could not update a sheet.")); };
  if (entry) Object.assign(entry, { undoOthers: () => { replay("inverse"); setReg(before); }, redoOthers: () => { replay("changes"); setReg(after); } });
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

/** ShowAddVariantDialog ("New Design Variant"), and Tools > Variants > Add Design Variant... */
export function addVariant(): void {
  if (E.viewOnly) { toast("View-only access"); return; }
  nameDescDialog("New Design Variant", true, "", (name, desc) => {
    if (!validateNewVariantName(name)) return;
    void variantCommand("Add Variant", (n) => n, (reg) => { if (!reg.has(name)) reg.set(name, ""); if (desc) reg.set(name, desc); }).then(() => { refreshVariantNames(addedName(name)); setCurrentVariant(name); });
  });
}
const addedName = (name: string): string[] => [...variantNamesForUI(), name];

/** Tools > Variants > Remove Design Variant... */
export async function removeVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  const name = await listPick("Remove Design Variant", "Select variant name to remove:", "", choices); if (!name) return;
  const wasCurrent = currentVariant() === name;
  await variantCommand("Delete Variant", (n) => VM.renameSymbolVariants(n, name, null), (reg) => { reg.delete(name); });
  if (wasCurrent) setCurrentVariant("");
  refreshVariantNames(variantNamesForUI().filter((v) => v !== name));
}

/** Tools > Variants > Edit Variant Description... */
export async function editVariantDescription(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No design variants to edit.", 10000); return; }
  const name = await listPick("Edit Variant Description", "Select variant to edit description:", "", choices); if (!name) return;
  let desc0 = ""; try { desc0 = registryOf(await loadProject()).get(name) || ""; } catch (e) { desc0 = ""; }
  nameDescDialog(`Edit Description for '${name}'`, false, desc0, (_n, desc) => {
    void variantCommand("Edit Variant Description", (n) => n, (reg) => { reg.set(name, desc); });
  });
}

/** Tools > Variants > Rename Design Variant... */
export async function renameVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No variants to rename.", 10000); return; }
  const oldName = await listPick("Rename Design Variant", "Select variant to rename:", "", choices); if (!oldName) return;
  const typed = await textEntry("Rename Design Variant", "Enter new variant name:", oldName); if (typed === null) return;
  const newName = trimWx(typed);
  if (newName === oldName) return;
  if (!validateNewVariantName(newName, oldName)) return;
  const wasCurrent = currentVariant() === oldName;
  await variantCommand("Rename Variant", (n) => VM.renameSymbolVariants(n, oldName, newName), (reg) => { if (reg.has(oldName)) { reg.set(newName, reg.get(oldName) || ""); reg.delete(oldName); } });
  refreshVariantNames(variantNamesForUI().filter((v) => v !== oldName).concat(newName));
  if (wasCurrent) setCurrentVariant(newName);
}

/** Tools > Variants > Copy Design Variant... */
export async function copyVariant(): Promise<void> {
  const choices = variantNamesForUI().slice(1);
  if (!choices.length) { toast("No variants to copy.", 10000); return; }
  const src = await listPick("Copy Design Variant", "Select variant to copy:", "", choices); if (!src) return;
  const typed = await textEntry("Copy Design Variant", "Enter name for the copied variant:", src + "_copy"); if (typed === null) return;
  const newName = trimWx(typed);
  if (!validateNewVariantName(newName)) return;
  await variantCommand("Copy Variant", (n) => VM.renameSymbolVariants(n, src, newName, true), (reg) => { if (!reg.has(newName)) reg.set(newName, ""); if (reg.has(src)) reg.set(newName, reg.get(src) || ""); });
  refreshVariantNames(addedName(newName));
  setCurrentVariant(newName);
}

/** onVariantSelected (both editors' toolbar combo). */
export function onVariantSelected(name: string): void {
  if (name === VARIANT_SEPARATOR) return;   // the separator restores the selection (the combo shows the current one)
  if (name === ADD_VARIANT_ENTRY) { addVariant(); return; }
  setCurrentVariant(name);
}
