// symedit/index.ts — publishes the Symbol Editor (window.KiCadSymbolEditor, which the Symbol Properties dialog's
// "Edit Symbol..." / "Edit Library Symbol..." buttons look for) and its schematic actions: Tools > Symbol Editor
// (showSymbolEditor), Edit Symbol (editWithLibEdit, Ctrl+E) and Edit Library Symbol (editLibSymbolWithLibEdit,
// Ctrl+Shift+E).  It is part of editor.js, which is one IIFE bundle: the frame is built on first use.
import { editor } from "./editor";
import { editSchematicSymbol } from "./schematic";
import { E, appState, store } from "../dialogs/editor";
import { messageBox } from "../dialogs/sch-items";

type Handler = (anchor?: unknown) => void;
const selectedSymbol = (): string | null => {
  const doc = E.kdoc; if (!doc) return null;
  const ids = E.selection && E.selection.size ? [...E.selection] : E.selected ? [E.selected.id] : [];
  const syms = ids.map((id) => doc.items.get(id)).filter((it) => it && it.kind === "symbol");
  return syms.length === 1 ? syms[0]!.id : null;
};
export const KiCadSymbolEditor = {
  open(): void { editor.open(); },
  isOpen(): boolean { return editor.isOpen; },
  close(): Promise<void> { return editor.close(); },
  editSchematicSymbol(id: string): Promise<boolean> { return editSchematicSymbol(editor, id); },
  editLibrarySymbol(libId: string): Promise<void> { return editor.editLibrarySymbol(libId); },
  /** for tests and tooling */
  editor,
};
declare global { interface Window { KiCadSymbolEditor: typeof KiCadSymbolEditor } }

export function installSymbolEditor(handlers: Record<string, Handler>): void {
  window.KiCadSymbolEditor = KiCadSymbolEditor;
  handlers.showSymbolEditor = () => editor.open();
  handlers.editWithLibEdit = () => { const id = selectedSymbol(); if (id) void editSchematicSymbol(editor, id); else void messageBox("Select a symbol to edit."); };
  handlers.editLibSymbolWithLibEdit = () => {
    const id = selectedSymbol(); const it = id && E.kdoc ? E.kdoc.items.get(id) : null;
    if (!it) { void messageBox("Select a symbol to edit."); return; }
    const lid = window.KiCadCanvas.kid(it.node, "lib_id"); void editor.editLibrarySymbol(lid ? window.KiCadCanvas.str(lid[1]) : "");
  };
  // ?symedit=<library>:<symbol> reopens the editor on that symbol once the project is in
  let want: string | null = null;
  try { want = new URL(location.href).searchParams.get("symedit"); } catch (e) { want = null; }
  if (want) {
    const target = want; let done = false;
    const tryOpen = () => { if (done || !appState.project || !E.kdoc) return; done = true; unsub(); if (target.includes(":")) void editor.editLibrarySymbol(target); else editor.open(); };
    const unsub = store.subscribe(tryOpen); setTimeout(tryOpen, 0);
  }
}
