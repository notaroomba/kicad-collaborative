// dialogs/groups.ts — schematic groups (KiCad 10's SCH_GROUP): Group Items / Ungroup Items, Enter Group / Leave Group /
// Remove from Group.  A group is its own item — (group "name" (uuid …) (members …)) — so grouping adds one, ungrouping
// removes it; a click on a member selects the whole group unless that group has been entered.
// The desktop's collab layer does not transfer SCH_GROUP fragments yet (sch_collab_sync.cpp typeSupportsSexprTransfer),
// so groups made here reach other web clients live but a desktop session only sees them once it reloads a snapshot
// that contains them.
import { E, requestRender, setStatusBar } from "./editor";
import { promptText } from "./dom";
import { expandGroups, groupMembers, groupOf, groupSexpr, topGroupOf } from "./logic";

interface Ctx extends ToolCtx { setSelection(ids: Iterable<string>): void }
let entered: string | null = null;
export function enteredGroup(): string | null { return entered && E.kdoc && E.kdoc.items.has(entered) ? entered : (entered = null); }
const selectionIds = (ctx: Ctx): string[] => { const s = new Set<string>(ctx.selection); if (ctx.selected) s.add(ctx.selected.id); const m = CollabTools.sch && CollabTools.sch.state.sel; if (typeof m === "string" && m) s.add(m); return [...s].filter((id) => ctx.doc!.items.has(id)); };
const change = (kind: "ADDED" | "MODIFIED", id: string, name: string, members: string[]) => ({ id, kind, typeName: "SCH_GROUP", sexpr: groupSexpr(name, id, members), groupMembers: [...new Set(members)].sort() }) as KChange;
const canEdit = (ctx: Ctx) => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };

export function schExpandGroups(doc: KDoc, ids: string[]): string[] { return [...expandGroups(doc, ids, enteredGroup())]; }

function group(ctx: Ctx): boolean {
  const doc = ctx.doc; if (!doc || !canEdit(ctx)) return true;
  const ids = selectionIds(ctx); if (!ids.length) { ctx.toast("Select items to group"); return true; }
  // members are the selection's top-level units: an already grouped item joins as its group
  const members = new Set<string>(); for (const id of ids) { const it = doc.items.get(id)!; const top = it.kind === "group" ? topGroupOf(doc, id, enteredGroup()) || it : topGroupOf(doc, id, enteredGroup()); members.add(top ? top.id : id); }
  if (members.size < 1) return true;
  const id = KiCadCanvas.newUuid(), ch: KChange[] = [change("ADDED", id, "", [...members])];
  const parent = enteredGroup(); if (parent) { const p = doc.items.get(parent)!; ch.push(change("MODIFIED", parent, String(p.node[1] ?? ""), [...groupMembers(p.node).filter((m) => !members.has(m)), id])); }
  ctx.commit(ch, "group"); ctx.setSelection(expandGroups(ctx.doc!, [id], enteredGroup())); ctx.toast(`Grouped ${members.size} item${members.size === 1 ? "" : "s"}`);
  return true;
}
function ungroup(ctx: Ctx): boolean {
  const doc = ctx.doc; if (!doc || !canEdit(ctx)) return true;
  const groups = new Map<string, KItem>(); for (const id of selectionIds(ctx)) { const it = doc.items.get(id)!; const g = it.kind === "group" ? topGroupOf(doc, id, enteredGroup()) || it : topGroupOf(doc, id, enteredGroup()); if (g) groups.set(g.id, g); }
  if (!groups.size) { ctx.toast("The selection is not in a group"); return true; }
  const ch: KChange[] = [], freed: string[] = [];
  for (const g of groups.values()) {
    const mem = groupMembers(g.node); freed.push(...mem); ch.push({ id: g.id, kind: "REMOVED", typeName: "SCH_GROUP", properties: [] });
    const parent = groupOf(doc, g.id); if (parent) ch.push(change("MODIFIED", parent.id, String(parent.node[1] ?? ""), [...groupMembers(parent.node).filter((m) => m !== g.id), ...mem]));
    if (entered === g.id) entered = null;
  }
  ctx.commit(ch, "ungroup"); ctx.setSelection(freed.filter((id) => ctx.doc!.items.has(id) && ctx.doc!.items.get(id)!.kind !== "group"));
  return true;
}
function enterGroup(ctx: Ctx): boolean {
  const doc = ctx.doc; if (!doc) return true;
  let g: KItem | null = null; for (const id of selectionIds(ctx)) { const it = doc.items.get(id)!; g = it.kind === "group" ? topGroupOf(doc, id, enteredGroup()) || it : topGroupOf(doc, id, enteredGroup()); if (g) break; }
  if (!g) { ctx.toast("Select a group to enter"); return true; }
  entered = g.id; ctx.setSelection([]); ctx.setHighlight(null); setStatusBar({ mode: `Editing group${g.node[1] ? " " + String(g.node[1]) : ""} — Leave Group to finish` }); requestRender();
  return true;
}
function leaveGroup(ctx: Ctx): boolean {
  const g = enteredGroup(); if (!g) return false;
  entered = null; setStatusBar({ mode: "" }); if (ctx.doc) ctx.setSelection(expandGroups(ctx.doc, [g], null));
  return true;
}
function removeFromGroup(ctx: Ctx): boolean {
  const doc = ctx.doc, g = enteredGroup(); if (!doc || !canEdit(ctx)) return true;
  if (!g) { ctx.toast("Enter a group first"); return true; }
  const grp = doc.items.get(g)!, drop = new Set(selectionIds(ctx)), rest = groupMembers(grp.node).filter((m) => !drop.has(m));
  if (rest.length === groupMembers(grp.node).length) { ctx.toast("Select members of the group to remove"); return true; }
  ctx.commit([rest.length ? change("MODIFIED", g, String(grp.node[1] ?? ""), rest) : ({ id: g, kind: "REMOVED", typeName: "SCH_GROUP", properties: [] } as KChange)], "remove from group");
  if (!rest.length) { entered = null; setStatusBar({ mode: "" }); }
  return true;
}
function renameGroup(ctx: Ctx): boolean {
  const doc = ctx.doc; if (!doc || !canEdit(ctx)) return true;
  let g: KItem | null = null; for (const id of selectionIds(ctx)) { const it = doc.items.get(id)!; g = it.kind === "group" ? it : topGroupOf(doc, id, enteredGroup()); if (g) break; }
  if (!g) { ctx.toast("Select a group first"); return true; }
  const grp = g; void promptText("Group Properties", "Group name:", String(grp.node[1] ?? "")).then((name) => { if (name === null || !ctx.doc || !ctx.doc.items.has(grp.id)) return; ctx.commit([change("MODIFIED", grp.id, name, groupMembers(grp.node))], "group name"); });
  return true;
}
/** Deleting a selection takes its groups along and repairs the groups that only lose some members. */
export function groupCleanupChanges(doc: KDoc, removed: Set<string>): KChange[] {
  const out: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "group" || removed.has(it.id)) continue;
    const mem = groupMembers(it.node), rest = mem.filter((m) => !removed.has(m)); if (rest.length === mem.length) continue;
    out.push(rest.length ? change("MODIFIED", it.id, String(it.node[1] ?? ""), rest) : ({ id: it.id, kind: "REMOVED", typeName: "SCH_GROUP", properties: [] } as KChange));
  }
  return out;
}

/** Publish the group commands on the schematic module (toolbar buttons "group" / "ungroup", Edit menu entries) and its expandGroups. */
export function installGroups(): void {
  const sch = CollabTools.sch as (SchToolModule & { expandGroups?(doc: KDoc, ids: string[]): string[]; actions: Record<string, { id?: string; label: string; key?: string | null; menu?: string | null; run(ctx: ToolCtx): unknown }> }) | undefined;
  if (!sch || !sch.actions) return;
  const add = (id: string, label: string, key: string, run: (ctx: Ctx) => boolean) => { sch.actions[id] = { id, label, key, menu: "Edit", run: (ctx) => run(ctx as Ctx) }; };
  add("group", "Group Items", "", group); add("ungroup", "Ungroup Items", "", ungroup); add("enterGroup", "Enter Group", "", enterGroup); add("leaveGroup", "Leave Group", "", leaveGroup);
  add("removeFromGroup", "Remove Items", "", removeFromGroup); add("groupProperties", "Group Properties...", "", renameGroup);
  sch.expandGroups = schExpandGroups;
  // a deletion repairs the groups it leaves behind (and removes the selected groups themselves)
  const base = sch.deleteChanges;
  if (base) sch.deleteChanges = (doc: KDoc, items: KItem[]) => {
    const groups = items.filter((it) => it.kind === "group"), rest = items.filter((it) => it.kind !== "group");
    const ch = (rest.length ? base(doc, rest) : []) || rest.map((it) => KiCadCanvas.removeChange(it));
    const gone = new Set<string>(items.map((it) => it.id)); for (const c of ch) if (c.kind === "REMOVED") gone.add(c.id);
    return [...ch, ...groups.map((g) => ({ id: g.id, kind: "REMOVED", typeName: "SCH_GROUP", properties: [] }) as KChange), ...groupCleanupChanges(doc, gone)];
  };
}
