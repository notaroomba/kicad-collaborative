// lock.ts — SCH_EDIT_TOOL::modifyLockSelected (Lock / Unlock / Toggle Lock) and SCH_SELECTION_TOOL::
// FilterSelectionForLockedItems: a locked item carries "(locked yes)" where SCH_IO_KICAD_SEXPR writes it, and sits
// out of moves, drags, rotations, mirrors, swaps and deletes.
import type { SchCtx } from "./types";
import { editable, selectedItems } from "./commands";
import { kid, str } from "./state";
import { deep, modChange } from "./util";

/** SCH_ITEM::IsLocked as read back from the file: SCH_IO_KICAD_SEXPR only takes the "(locked yes)" child. */
export function isLockedNode(node: SNode): boolean { const l = kid(node, "locked"); return !!l && str(l[1]) !== "no"; }
/** The item or (a group) any of its members is locked: FilterSelectionForLockedItems' lockedDescendant. */
export function isLockedItem(doc: KDoc, it: KItem): boolean {
  if (isLockedNode(it.node)) return true;
  if (it.kind === "group") { const m = kid(it.node, "members"); if (m) for (const id of m.slice(1)) { const c = doc.items.get(str(id)); if (c && isLockedItem(doc, c)) return true; } }
  return false;
}

const SHEET_ATTRS = new Set(["exclude_from_sim", "in_bom", "on_board", "in_pos_files", "dnp"]);
/**
 * SetLocked on a copy of the node, the flag where the writer puts it: a symbol's before fields_autoplaced (else its
 * uuid), a sheet's after its attribute booleans, a rule area's first, everything else's right after its uuid.
 */
export function setLockedNode(kind: string, node: SNode, on: boolean): SNode {
  const n = deep(node);
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (Array.isArray(c) && c[0] === "locked") n.splice(i, 1); }
  if (!on) return n;
  const flag: SNode = ["locked", "yes"];
  const at = (tok: string) => n.findIndex((c, i) => i > 0 && Array.isArray(c) && c[0] === tok);
  let i = -1;
  if (kind === "rule_area") i = 1;
  else if (kind === "symbol") { i = at("fields_autoplaced"); if (i < 0) i = at("uuid"); }
  else if (kind === "sheet") { for (let j = 1; j < n.length; j++) { const c = n[j]; if (Array.isArray(c) && SHEET_ATTRS.has(String(c[0]))) i = j + 1; } if (i < 0) { i = at("fields_autoplaced"); if (i < 0) i = at("stroke"); } }
  else { const u = at("uuid"); i = u >= 0 ? u + 1 : -1; }
  if (i < 0 || i > n.length) n.push(flag); else n.splice(i, 0, flag);
  return n;
}

/** SCH_EDIT_TOOL::Lock / Unlock / ToggleLock (Toggle locks unless something in the selection is locked). */
export function modifyLock(ctx: SchCtx, mode: "on" | "off" | "toggle") {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, items = selectedItems(ctx); if (!items.length) return false;
  const on = mode === "toggle" ? !items.some((it) => isLockedNode(it.node)) : mode === "on";
  const changes: KChange[] = [];
  for (const it of items) { if (isLockedNode(it.node) === on) continue; changes.push(modChange(doc, it, setLockedNode(it.kind, it.node, on))); }
  if (!changes.length) return true;
  ctx.commit(changes, on ? "Lock" : "Unlock");
  return true;
}

/** FilterSelectionForLockedItems: drop the locked items from the selection; the items left. */
export function unlockedSelection(ctx: SchCtx): KItem[] {
  const items = selectedItems(ctx), free = items.filter((it) => !isLockedItem(ctx.doc, it));
  if (free.length !== items.length && typeof ctx.setSelection === "function") ctx.setSelection(free.map((it) => it.id));
  return free;
}
