// pcb-tools/groups.ts — selection helpers, groups and locks.
import type { BoardDoc, PcbChange, PcbCtx } from "./types";
import { addedChange, removedChange, replacedChange } from "./changes";
import { K, S } from "./state";
import { transformChanges } from "./transforms";
import { clone } from "./util";

// ---------------------------------------------------------------- selection helpers and groups
/** app.js's multi-selection, its footprint selection and the module's own picks, as one set of ids. */
export function selectionIds(ctx: PcbCtx) {
  const s = new Set<string>(S.sel); if (ctx.selection) for (const id of ctx.selection) s.add(id); if (ctx.selected && ctx.selected.id) s.add(ctx.selected.id);
  for (const id of Array.from(s)) if (!ctx.doc.items.has(id)) s.delete(id);
  return s;
}
export const selectedItems = (ctx: PcbCtx) => Array.from(selectionIds(ctx), (id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[];
/** Hand a selection back: app.js through setSelection (or setSelected for a lone footprint), the module for its own kinds. */
export function applySelection(ctx: PcbCtx, ids: Iterable<string>) {
  const arr = Array.from(ids).filter((id) => ctx.doc.items.has(id));
  if (typeof ctx.setSelection === "function") { S.sel.clear(); ctx.setSelection(arr); }   // app.js owns the whole selection
  else {
    S.sel = new Set(arr.filter((id) => ctx.doc.items.get(id)!.kind !== "footprint"));
    if (ctx.setSelected) { const fp = arr.map((id) => ctx.doc.items.get(id)).find((it) => it!.kind === "footprint"); ctx.setSelected(fp ? { id: fp.id } : null); }
  }
  ctx.requestRender(); return arr;
}
export const groupMembers = (node: SNode) => { const m = K.kid(node, "members"); return m ? m.slice(1).map(K.str) : []; };
/**
 * The item's parent in the hierarchy FilterCollectorForHierarchy climbs: a group, or a generator (a PCB_GENERATOR such as
 * a tuning pattern is a PCB_GROUP whose members are not individually selectable).
 */
export function parentOf(doc: BoardDoc, id: string) { for (const it of doc.items.values()) if ((it.kind === "group" || it.kind === "generated") && groupMembers(it.node).includes(id)) return it; return null; }
/** The outermost group or generator above an item, or null. */
export function topParentOf(doc: BoardDoc, id: string) { const scope = scopeOf(doc); let g = parentOf(doc, id), top: KItem | null = null, guard = 0; while (g && !scope.has(g.id) && guard++ < 32) { top = g; g = parentOf(doc, g.id); } return top; }
/** The entered group (PCB_SELECTION_TOOL::m_enteredGroup) and its ancestors: picking a member does not climb into them. */
function scopeOf(doc: BoardDoc): Set<string> { const out = new Set<string>(); let g = S.enteredGroup && doc.items.has(S.enteredGroup) ? S.enteredGroup : null, guard = 0; while (g && guard++ < 32) { out.add(g); const p = parentOf(doc, g); g = p ? p.id : null; } return out; }
export function groupOf(doc: BoardDoc, id: string) { for (const it of doc.items.values()) if (it.kind === "group" && groupMembers(it.node).includes(id)) return it; return null; }
/** The ids plus every member of any group they belong to (and the groups themselves), to any depth. */
export function expandGroups(doc: BoardDoc, ids: Iterable<string>) {
  const out = new Set<string>(ids); let grew = true; const scope = scopeOf(doc);
  while (grew) {
    grew = false;
    for (const it of doc.items.values()) {
      if ((it.kind !== "group" && it.kind !== "generated") || scope.has(it.id)) continue; const m = groupMembers(it.node);   // a generator holds its members as a group does
      if (!out.has(it.id) && !m.some((id) => out.has(id))) continue;
      for (const id of m.concat([it.id])) if (!out.has(id) && doc.items.has(id)) { out.add(id); grew = true; }
    }
  }
  return out;
}
/** (group "name" (uuid …) (members …)) as PCB_IO_KICAD_SEXPR::format(PCB_GROUP) writes it, member ids sorted. */
export function groupNode(name: string, ids: Iterable<string>): SNode { return ["group", name || "", ["uuid", K.newUuid()], ["members", ...Array.from(new Set(ids)).sort()]]; }
export function groupChanges(doc: BoardDoc, ids: Iterable<string>, name: string) {
  const members = Array.from(ids).filter((id) => { const it = doc.items.get(id); return it && it.kind !== "group"; });
  if (!members.length) return [];
  return [addedChange(doc, groupNode(name, members))];
}
export function ungroupChanges(doc: BoardDoc, ids: Iterable<string>) {
  const out: PcbChange[] = []; const seen = new Set<string>();
  for (const id of ids) { const it = doc.items.get(id); const g = it && it.kind === "group" ? it : groupOf(doc, id); if (g && !seen.has(g.id)) { seen.add(g.id); out.push(removedChange(g)); } }
  return out;
}
export function groupMembersChanges(doc: BoardDoc, groupItem: KItem, add: string[] | null, remove: string[] | null) {
  const node = clone(groupItem.node); const set = new Set(groupMembers(node));
  for (const id of add || []) if (doc.items.has(id)) set.add(id); for (const id of remove || []) set.delete(id);
  if (!set.size) return [removedChange(groupItem)];
  const m = K.kid(node, "members"); m!.splice(1, m!.length - 1, ...Array.from(set).sort()); return [replacedChange(groupItem, node)];
}
// (locked yes) where each writer puts it: before the layer for footprints, tracks, shapes, dimensions and zones,
// before (at) for texts, after the layers for vias, after the uuid for groups and tables, after the layer for images.
export const LOCK_BEFORE: Record<string, string[]> = { footprint: ["placed", "layer"], segment: ["layer", "layers"], arc: ["layer", "layers"], via: ["free", "net", "uuid"], zone: ["layer", "layers"], gr_text: ["at"], gr_text_box: ["start", "pts"], dimension: ["layer"], table: ["layer"], image: ["uuid", "data"], group: ["lib_id", "members"], target: ["at"] };
export const isLocked = (node: SNode) => { const l = K.kid(node, "locked"); return l ? K.str(l[1]) !== "no" : node.includes("locked"); };
export function setLocked(node: SNode, on: boolean) {
  const k = node[0] as string; const cur = K.kid(node, "locked"); const i = node.indexOf("locked"); if (i > 0) node.splice(i, 1);
  if (cur) { if (on) cur[1] = "yes"; else node.splice(node.indexOf(cur), 1); return node; }
  if (!on) return node;
  let at = node.length; const before = LOCK_BEFORE[k] || (/^gr_/.test(k) ? ["layer"] : ["layer", "uuid"]);
  for (const b of before) { const c = K.kid(node, b); if (c) { at = node.indexOf(c); break; } }
  if (k === "gr_text" || k === "gr_text_box" || k === "table" || k === "group") { const u = K.kid(node, "uuid"); if ((k === "table" || k === "group") && u) at = node.indexOf(u) + 1; }
  if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(k)) { const f = K.kid(node, "fill") || K.kid(node, "stroke"); if (f) at = node.indexOf(f) + 1; }
  node.splice(at, 0, ["locked", "yes"]); return node;
}
export const lockChanges = (doc: BoardDoc, ids: Iterable<string>, on: boolean) => transformChanges(doc, ids, (n: SNode) => { if (isLocked(n) === !!on) return false; setLocked(n, on); });
