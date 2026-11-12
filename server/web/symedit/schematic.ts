// symedit/schematic.ts — the symbol editor opened on a placed schematic symbol (SYMBOL_EDIT_FRAME::
// LoadSymbolFromSchematic) and its Save (SaveSymbolToSchematic): the edited library copy goes back into every unit of
// that symbol — the same reference on every sheet — in one undo step.  Each placed unit's fields are updated from the
// copy (SCH_SYMBOL::UpdateFields), its pins follow the copy's pin list, and the copy itself becomes the sheet's
// (lib_symbols) entry, under the symbol's lib_id when that entry is no longer used by anything else, else under a
// new "<name>_<n>" name (SCH_SCREEN::Append) that the units then name with (lib_name …).
import * as M from "./model";
import { messageBox } from "../dialogs/sch-items";
import { E, appState, toolCtx, undoStack, pushUndoFor, toast } from "../dialogs/editor";
import { otherUnitsOf } from "../dialogs/sync-units";
import { projectDocs, readDoc, submitDocOp } from "../dialogs/project";
import type { SymbolEditor, Tab, Origin } from "./editor";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const mine = (n: SNode): M.Node => M.node(K().serialize(n));
const libIdOf = (n: SNode): string => K().str((K().kid(n, "lib_id") || [])[1]);
const cacheKeyOf = (n: SNode): string => { const ln = K().kid(n, "lib_name"); return ln ? K().str(ln[1]) : libIdOf(n); };

/** Edit Symbol (Ctrl+E) / Symbol Properties' "Edit Symbol...": the placed symbol's library copy in a tab of its own. */
export async function editSchematicSymbol(se: SymbolEditor, itemId: string): Promise<boolean> {
  const doc = E.kdoc; const it = doc ? doc.items.get(itemId) : null;
  if (!doc || !it || it.kind !== "symbol") { await messageBox("Select a symbol to edit."); return false; }
  const libId = libIdOf(it.node); const entry = doc.lib.get(cacheKeyOf(it.node)) || doc.lib.get(libId);
  if (!entry) { await messageBox(`Symbol library symbol '${libId}' not found in the schematic.`); return false; }
  const sym = mine(entry as unknown as SNode);
  // LIB_SYMBOL::Flatten of the cache copy (cache copies are flat already), named by the item name
  sym[1] = libId.includes(":") ? libId.slice(libId.indexOf(":") + 1) : libId;
  M.instanceToLibrary(mine(it.node), sym);
  const unit = K().num((K().kid(it.node, "unit") || [0, 1])[1], 1);
  const bs = K().kid(it.node, "body_style") || K().kid(it.node, "convert"); const body = bs ? K().num(bs[1], 1) : 1;
  const refP = K().kids(it.node, "property").find((p) => K().str(p[1]) === "Reference");
  const origin: Origin = { docId: String(appState.docId || ""), itemId, libId, ref: refP ? K().str(refP[2]) : "", sheet: (appState.docs.find((d) => d.docId === appState.docId) || { path: "" }).path };
  se.open(); se.openScratch(origin, sym, unit, body);
  return true;
}

/** The (lib_symbols) names the sheet's other symbols still draw from once `targets` are updated. */
function freeCache(doc: KDoc, targets: Set<string>): Map<string, M.Node> {
  const used = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "symbol" && !targets.has(it.id)) used.add(cacheKeyOf(it.node));
  const m = new Map<string, M.Node>();
  for (const [k, v] of doc.lib) if (used.has(k)) m.set(k, mine(v as unknown as SNode));
  return m;
}
/** The updated unit: fields from the copy, pins from the copy, (lib_name) set or cleared. */
function updatedUnit(n: SNode, flat: M.Node, cacheName: string, libId: string, principal: boolean): M.Node {
  let out = M.updateInstanceFields(mine(n), flat);
  M.updateInstancePins(out, flat, () => K().newUuid(), principal);
  const li = out.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "lib_name");
  if (cacheName === libId) { if (li > 0) out.splice(li, 1); }
  else if (li > 0) (out[li] as M.Node)[1] = cacheName;
  else { const lid = out.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "lib_id"); out.splice(lid > 0 ? lid : 1, 0, M.node(`(lib_name ${M.q(cacheName)})`)); }
  out = M.node(M.text(out));
  return out;
}
function changesFor(doc: KDoc, items: KItem[], flat: M.Node, libId: string, principalId: string): KChange[] {
  const name = M.cacheName(freeCache(doc, new Set(items.map((i) => i.id))), libId, flat).name;
  const entry = M.asCacheEntry(flat, name);
  const typeName = K().typeNameOf({ kind: "symbol" });
  return items.map((it) => ({ id: it.id, kind: "MODIFIED", typeName, sexpr: `(lib_symbols ${M.text(entry)}) ${M.text(updatedUnit(it.node, flat, name, libId, it.id === principalId))}` } as KChange));
}

/** SaveSymbolToSchematic: "Save" / "Update symbol in schematic" of a tab opened from the schematic. */
export async function saveToSchematic(se: SymbolEditor, t: Tab): Promise<boolean> {
  const o = t.origin; const s = se.symbol(t); if (!o || !s) return false;
  if (E.viewOnly) { await messageBox("You have view-only access to this project."); return false; }
  if (appState.docId !== o.docId || !E.kdoc) { await messageBox(`Open the sheet '${o.sheet}' to update the symbol in the schematic.`); return false; }
  const doc = E.kdoc; const it = doc.items.get(o.itemId);
  if (!it) { await messageBox("The symbol is no longer in the schematic."); return false; }
  const flat = M.node(M.text(s)); flat[1] = o.libId.includes(":") ? o.libId.slice(o.libId.indexOf(":") + 1) : o.libId;
  const units = otherUnitsOf(doc, it);
  const here = [it, ...(units ? units.here.filter((u) => u.id !== it.id) : [])];
  const label = "Save Symbol to Schematic";
  toolCtx().commit(changesFor(doc, here, flat, o.libId, it.id), label);
  const entry = undoStack[undoStack.length - 1];
  const there = units ? units.there : [];
  if (there.length) {
    const done: { docId: string; file: string; changes: KChange[]; inverse: KChange[] }[] = [], failed: string[] = [];
    for (const { file, ids } of there) {
      const de = projectDocs().find((d) => d.path === file); if (!de) continue;
      try {
        const fresh = await readDoc(de.docId, "kicad_sch");
        const items = ids.map((id) => fresh.items.get(id)).filter((x): x is KItem => !!x); if (!items.length) continue;
        const inv = items.map((x) => K().replaceChange(fresh, x));
        const ch = changesFor(fresh, items, flat, o.libId, "");
        await submitDocOp(de.docId, ch); done.push({ docId: de.docId, file, changes: ch, inverse: inv });
      } catch (e) { failed.push(file); }
    }
    if (done.length) {
      const replay = (which: "changes" | "inverse") => () => { for (const d of done) submitDocOp(d.docId, d[which]).catch(() => { void messageBox(`Could not update '${d.file}'.`); }); };
      if (entry && undoStack.includes(entry)) Object.assign(entry, { undoOthers: replay("inverse"), redoOthers: replay("changes") });
      else pushUndoFor(String(appState.docId || ""), { label, changes: [], inverse: [], undoOthers: replay("inverse"), redoOthers: replay("changes") });
    }
    if (failed.length) await messageBox(`Could not update ${failed.map((f) => `'${f}'`).join(", ")}.`);
  }
  t.modified = false; se.renderAll();
  toast(`Symbol '${o.ref || flat[1]}' updated in the schematic.`);
  return true;
}
