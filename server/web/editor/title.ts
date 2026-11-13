// title.ts — the window title of the schematic and board editors, as their frames write it:
//
//   SCH_EDIT_FRAME::updateTitle (eeschema/sch_edit_frame.cpp:1971-2013)
//     [*]<sheet file> [<root file>/<sheet path>] [Read Only] — Schematic Editor
//   PCB_EDIT_FRAME::UpdateTitle (pcbnew/pcb_edit_frame.cpp:2573-2600)
//     [*]<board file> [Read Only] — PCB Editor
//
// "*" is IsContentModified: here, edits of this document the server has not acknowledged yet (E.pendingOps), since
// every acknowledged edit is already saved.  "[Read Only]" is a visitor who may not edit.  The Footprint Editor
// writes its own title (fpedit.ts refreshTitle) and the Symbol Editor its own (symedit/editor.ts).
import { state, store } from "./appstore";
import { E } from "./state";

const stem = (path: string | null | undefined): string => (path || "").split("/").pop()!.replace(/\.kicad_(sch|pcb)$/, "");

/** The title for the open document, or null when another frame owns the title (Footprint Editor, home). */
export function frameTitle(): string | null {
  const s = store.get();
  if (s.view !== "editor" || !state.doc || document.documentElement.dataset.symedit !== undefined) return null;
  const docType = (state.doc as { docType?: string }).docType;
  if (E.DOC_TYPE === "footprint" || (docType !== "kicad_sch" && docType !== "kicad_pcb")) return null;
  let modified = false;
  for (const op of (E.pendingOps as Map<string, { docId?: string }>).values()) if (op.docId === state.docId) { modified = true; break; }
  const ro = E.viewOnly ? " [Read Only]" : "";
  if (docType === "kicad_pcb") return `${modified ? "*" : ""}${stem(state.doc.path)}${ro} — PCB Editor`;
  // GetCurrentSheet().PathHumanReadable( false, true ): the root file's name, then the sheet names, no trailing "/"
  const name = stem(state.doc.path);
  const rootId = s.document.rootDocId;
  const root = rootId ? (s.document.docs as { docId: string; path: string }[]).find((d) => d.docId === rootId) : null;
  const kdoc = E.kdoc as { sheetPath?: string } | null;
  const sub = kdoc && kdoc.sheetPath && kdoc.sheetPath !== "/" ? kdoc.sheetPath.replace(/^\/|\/$/g, "") : "";
  const sheetPath = (root ? stem(root.path) : name) + (sub ? "/" + sub : "");
  return `${modified ? "*" : ""}${name}${sheetPath !== name ? ` [${sheetPath}]` : ""}${ro} — Schematic Editor`;
}

let last = "";
/** Write the title when it changed (called on every store update and after an edit is sent or acknowledged). */
export function updateTitle(): void {
  const t = frameTitle(); if (t === null || t === last && document.title === t) return;
  last = t; document.title = t;
}
store.subscribe(() => updateTitle());
