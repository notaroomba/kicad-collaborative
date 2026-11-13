// fieldops.ts — what Delete does to a schematic field selected on its own (E.selField): SCH_EDIT_TOOL::DoDelete on a
// SCH_FIELD hides it (SetVisible( false )), one "Delete" step.  A board footprint field's Delete is the board module's
// (EDIT_TOOL::DeleteItems, pcb-tools/field-edit.ts); Move / Drag of a field is gestures.ts startFieldMove.
import { E } from "./state";
import { fieldOf, drawSelection, renderProps } from "./selection";
import { commitChanges } from "./tools";
import { isSch, requestRender } from "./view";
import { toast } from "./util";

type FieldKit = { fieldHidden(p: SNode): boolean; setFieldHidden(node: SNode, p: SNode, hidden: boolean): void };
const kit = (): FieldKit | null => { const K = window.KDialogs as unknown as { _?: Partial<FieldKit> } | undefined; return K && K._ && K._.fieldHidden && K._.setFieldHidden ? K._ as FieldKit : null; };

/** The node a field hide leaves (null: nothing to change) and whether the field was visible. */
export function hiddenFieldNode(node: SNode, name: string, k: FieldKit, find: (node: SNode, name: string) => SNode | null): SNode | null {
  const copy = JSON.parse(JSON.stringify(node)) as SNode; const p = find(copy, name); if (!p) return null;
  if (k.fieldHidden(p)) return null;
  k.setFieldHidden(copy, p, true); return copy;
}

/** Delete with a field selected: hide it.  True when the key was ours. */
export function deleteSelectedField(): boolean {
  const f = E.selField; if (!f || !E.kdoc || !isSch()) return false;
  if (E.viewOnly) { toast("View-only access"); return true; }
  const it = E.kdoc.items.get(f.id), k = kit(); if (!it || !k) return true;
  const node = hiddenFieldNode(it.node, f.name, k, (n, nm) => fieldOf({ node: n }, nm));
  if (!node) return true;
  commitChanges([KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null }))], "Delete");
  E.selField = null; drawSelection(); renderProps(); requestRender();
  return true;
}
