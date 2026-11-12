import type { SchCtx, Pt } from "./types";
import { refreshCarry } from "./carry";
import { selectedItems } from "./commands";
import { junctionAt, needsJunction } from "./connect";
import { DRAG_KINDS, connPoints } from "./drag";
import { pickAny } from "./hit";
import { switchTool } from "./junction";
import { anchorOf, cloneNode, mirrorNode, rotateNode, shiftNode } from "./orient";
import { LINE_KINDS, S, ptsOf } from "./state";
import { rotationCentre, transformNode, transformSelected } from "./transforms";
import { deep, ghost, modChange, removeChange } from "./util";

// ---------------------------------------------------------------- edits on the current selection
export function selectedItem(ctx: SchCtx) { const id = ctx.selected ? ctx.selected.id : S.sel; return id ? ctx.doc.items.get(id) || null : null; }
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically, (mirror x)) | "y" (Mirror Horizontally, (mirror y)).
// One item turns about its own anchor (or, for items without an orientation of their own, about
// its half-grid box centre); a multi-selection turns as a whole about the selection centre.
export function orientSelected(ctx: SchCtx, op: string) {
  const c = S.carry;
  if (c) { const ok = op === "x" || op === "y" ? mirrorNode(c.kind, c.node, op) : rotateNode(c.kind, c.node, op === "cw"); if (ok === false) transformNode(c.kind, c.node, op, anchorOf(c.kind, c.node)); refreshCarry(ctx); return true; }
  const items = selectedItems(ctx);
  if (items.length > 1) return transformSelected(ctx, op, items);
  const it = items[0]; if (!it) return false;
  if (ctx.viewOnly) return false;
  const node = deep(it.node);
  const ok = op === "x" || op === "y" ? mirrorNode(it.kind, node, op) : rotateNode(it.kind, node, op === "cw");
  if (ok === false) { if (!DRAG_KINDS.has(it.kind)) return false; return transformSelected(ctx, op, [it], rotationCentre([it])); }
  ctx.commit([modChange(ctx.doc, it, node)], op === "x" || op === "y" ? "mirror" : "rotate");
  return true;
}
// Removal of one item (or a list — a multi-selection) plus the junctions that only existed for them:
// a line's own points, or the connection points (pins, ends, anchors) of anything else —
// SCH_EDIT_TOOL::DoDelete's junction pass, evaluated with every listed item out of the document.
export function deleteChanges(doc: KDoc, items: KItem | KItem[]) {
  const list: KItem[] = [], ids = new Set<string>();
  for (const it of Array.isArray(items) ? items : [items]) if (it && !ids.has(it.id)) { ids.add(it.id); list.push(it); }
  const changes = list.map(removeChange), pts: { p: Pt; kind: string | null }[] = [];
  for (const it of list) { const line = LINE_KINDS.has(it.kind); for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) pts.push({ p, kind: line ? it.kind : null }); }
  if (!pts.length) return changes;
  const saved = list.map((it) => [it.id, doc.items.get(it.id)] as const);
  for (const it of list) doc.items.delete(it.id);
  try {
    for (const { p, kind } of pts) {
      const j = junctionAt(doc, p[0], p[1]); if (!j || ids.has(j.id) || changes.some((c) => c.id === j.id)) continue;
      const needed = kind ? needsJunction(doc, p[0], p[1], kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (!needed) changes.push(removeChange(j));
    }
  } finally { for (const [id, obj] of saved) if (obj) doc.items.set(id, obj); }
  return changes;
}
export function deleteSelected(ctx: SchCtx) {
  const it = S.sel ? ctx.doc.items.get(S.sel) : null; if (!it) return false;
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  ctx.commit(changes, "delete");
  ctx.requestRender();
  return true;
}
// The delete tool's click: whatever is under the cursor goes (symbols and sheets included).
export function deleteAt(ctx: SchCtx, mm: Pt) {
  const it = pickAny(ctx, mm); if (!it) return null;
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  if (ctx.selected && ctx.selected.id === it.id) ctx.setSelected(null);
  ctx.commit(changes, "delete");
  ctx.requestRender();
  return it;
}
export function duplicateSelected(ctx: SchCtx) {
  const it = selectedItem(ctx); if (!it || it.kind === "sheet") return false;
  const node = cloneNode(it); shiftNode(it.kind, node, 2.54, 2.54);
  S.carry = { kind: it.kind, node, item: ghost(ctx.doc, node), pos: anchorOf(it.kind, node) };
  S.sel = null; ctx.setSelected(null);
  switchTool(ctx, "place");                         // onActivate sees the carry and skips the picker
  ctx.requestRender();
  return true;
}
