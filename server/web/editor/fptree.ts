// editor/fptree.ts — the Footprint Editor library tree's context menu as FOOTPRINT_EDITOR_CONTROL::Init builds it
// (pcbnew/tools/footprint_editor_control.cpp) with LIBRARY_EDITOR_CONTROL::AddContextMenuItems
// (common/tool/library_editor_control.cpp): CONDITIONAL_MENU rows sorted by order, false conditions hidden.
// Pure: the node tests load it.
import { tidy } from "../symedit/ctxmenu";

export interface FpTreeCtx {
  /** a library row is selected (libSelectedCondition) */
  libSelected: boolean;
  /** a footprint row is selected (fpSelectedCondition) */
  fpSelected: boolean;
  /** the editor holds a footprint (fpExportCondition) */
  hasFootprint: boolean;
  /** LIBRARY_EDITOR_CONTROL checkPinnedStatus over the selected library rows */
  allPinned: boolean;
  allUnpinned: boolean;
}
export function fpTreeMenu(c: FpTreeCtx): string[] {
  const lib = c.libSelected, fp = c.fpSelected, inferred = lib || fp;
  const rows: [number, string, boolean][] = [];
  const add = (order: number, id: string, cond = true) => rows.push([order, id, cond]);
  add(10, "newFootprint", lib); add(10, "createFootprint", lib);
  add(10, "-"); add(10, "save"); add(10, "saveAs", lib || fp); add(10, "revert", inferred);
  add(10, "-");
  for (const id of ["cutFootprint", "copyFootprint"]) add(10, id, fp);
  add(10, "pasteFootprint", inferred);
  for (const id of ["duplicateFootprint", "renameFootprint", "deleteFootprint", "footprintProperties"]) add(10, id, fp);
  add(100, "-"); add(100, "importFootprint", inferred); add(100, "exportFootprint", c.hasFootprint);
  add(1, "pinLibrary", c.allUnpinned); add(1, "unpinLibrary", c.allPinned); add(1, "-");
  add(400, "-"); add(400, "hideLibraryTree");
  return tidy(rows.map((r, i) => [r, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).filter(([r]) => r[2]).map(([r]) => r[1]));
}
