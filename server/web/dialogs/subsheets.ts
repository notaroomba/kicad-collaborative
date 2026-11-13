// dialogs/subsheets.ts — the sub-sheet documents the open schematic's sheet symbols name, for the schematic tools that
// look into them (Place Sheet Pins' importHierLabel, the ERC's sheet pin / hierarchical label checks).  A sheet's file
// is found beside the open page (else by file name among the project's schematics), read with readDoc and cached by
// the sheet's Sheetfile; every read refreshes the cache entry, so a later use sees the sub-sheet as it is now.
// The editor's toolCtx reaches it through E.hooks.loadSheetDoc (the editor modules do not import the dialogs).
import { readDoc } from "./project";
import { E, appState } from "./editor";
import type { DocEntry } from "../store";
import { subSheetDocs } from "../editor/subsheets";

/** The project document a sheet symbol on the open page names, or null. */
export function sheetDocEntry(sheet: KItem): DocEntry | null {
  const st = appState as unknown as { docs: DocEntry[] | null; docId: string | null };
  const docs = (st.docs || []) as DocEntry[], here = docs.find((d) => d.docId === st.docId);
  const dir = here ? here.path.split("/").slice(0, -1).join("/") : "", f = sheet.file || "";
  if (!f) return null;
  const path = dir ? `${dir}/${f}` : f, all = docs.filter((d) => d.docType === "kicad_sch");
  return all.find((d) => d.path === path) || all.find((d) => d.path.split("/").pop() === f.split("/").pop()) || null;
}

/** Read the sub-sheet a sheet symbol names (null when the project has no such file or it cannot be read). */
export async function loadSheetDoc(sheet: KItem): Promise<KDoc | null> {
  const entry = sheetDocEntry(sheet); if (!entry) return null;
  try { const d = await readDoc(entry.docId, "kicad_sch"); if (sheet.file) subSheetDocs.set(sheet.file, d); return d; } catch (e) { return null; }
}

/** Called once by installDialogs: the tool context's loadSheetDoc goes through this hook. */
export function installSubSheets(): void { (E as unknown as { hooks: Record<string, unknown> }).hooks.loadSheetDoc = loadSheetDoc; }
