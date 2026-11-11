// dialogs/groups.ts — schematic groups (KiCad 10's SCH_GROUP): Group Items / Ungroup Items, Enter Group / Leave Group /
// Remove from Group.  A group is its own item — (group "name" (uuid …) (members …)) — so grouping adds one, ungrouping
// removes it; a click on a member selects the whole group unless that group has been entered.
// Groups travel like every other item: the desktop's collab layer (sch_collab_sync.cpp) reads the member ids off the
// change and resolves them on its own sheet, so a group made here appears in a desktop session at once and vice versa.
import { E, isSch, requestRender, setStatusBar, toolCtx } from "./editor";
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
  entered = g.id; ctx.setSelection(groupMembers(g.node).filter((m) => doc.items.has(m))); ctx.setHighlight(null);   // KiCad's EnterGroup selects the members
  setStatusBar({ mode: `Editing group${g.node[1] ? " " + String(g.node[1]) : ""} — Leave Group to finish` }); requestRender();
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

/** Union of a group's member boxes (nested groups included), in mm. */
function groupBox(doc: KDoc, g: KItem, depth = 0): number[] | null {
  let b: number[] | null = null;
  for (const m of groupMembers(g.node)) {
    const it = doc.items.get(m); if (!it) continue;
    const r = it.kind === "group" ? (depth < 16 ? groupBox(doc, it, depth + 1) : null) : (it.bbox as number[] | null | undefined);
    if (!r) continue;
    b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : [r[0], r[1], r[2], r[3]];
  }
  return b;
}
const ANCHOR = "#0000FF";   // LAYER_SCHEMATIC_ANCHOR in KiCad's default colour theme
/**
 * SCH_PAINTER::draw( SCH_GROUP ): nothing for a group that is neither selected nor entered; otherwise the box
 * around its members at twice the outline width and, when the name fits, a title tab with the name in italics.
 */
function drawGroupBoxes(c: CanvasRenderingContext2D, view: { ppm: number; zoom: number; dpr?: number }, ctx: Ctx): void {
  const doc = ctx.doc; if (!doc) return;
  const show = new Set<string>(); const ent = enteredGroup(); if (ent) show.add(ent);
  for (const id of selectionIds(ctx)) { const it = doc.items.get(id); if (it && it.kind === "group") show.add(id); }
  if (!show.size) return;
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
  for (const id of show) {
    const g = doc.items.get(id)!, b = groupBox(doc, g); if (!b) continue;
    const w = b[2] - b[0];
    c.save(); c.strokeStyle = ANCHOR; c.fillStyle = ANCHOR; c.lineWidth = Math.max(0.3048, 1.5 * px); c.lineJoin = "miter"; c.setLineDash([]);
    c.strokeRect(b[0], b[1], w, b[3] - b[1]);
    const name = String(g.node[1] ?? "");
    if (name) {
      const textSize = (12 * px * (view.dpr || 1) + 2 * 0.3048) / 3;      // "scale by zoom a bit, but not too much"
      if (name.length * textSize < w) {
        const th = textSize * 2;
        c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(b[0], b[1] - th); c.lineTo(b[2], b[1] - th); c.lineTo(b[2], b[1]); c.stroke();
        c.font = `italic ${textSize * 1.35}px sans-serif`; c.textAlign = "center"; c.textBaseline = "bottom";
        c.fillText(name, b[0] + w / 2, b[1] - textSize * 0.5);
      }
    }
    c.restore();
  }
}
/** KiCad's double-click on a group enters it (SCH_SELECTION_TOOL: IsDblClick on a lone SCH_GROUP -> EnterGroup). */
export function enterGroupAt(ctx: ToolCtx, id: string): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const it = doc.items.get(id); if (!it) return false;
  const g = it.kind === "group" ? topGroupOf(doc, id, enteredGroup()) || it : topGroupOf(doc, id, enteredGroup());
  if (!g) return false;
  (ctx as Ctx).setSelection(expandGroups(doc, [g.id], enteredGroup()));
  return enterGroup(ctx as Ctx);
}

/** Publish the group commands on the schematic module (toolbar buttons "group" / "ungroup", Edit menu entries) and its expandGroups. */
export function installGroups(): void {
  const sch = CollabTools.sch as (SchToolModule & { expandGroups?(doc: KDoc, ids: string[]): string[]; actions: Record<string, { id?: string; label: string; key?: string | null; menu?: string | null; run(ctx: ToolCtx): unknown }> }) | undefined;
  if (!sch || !sch.actions) return;
  const add = (id: string, label: string, key: string, run: (ctx: Ctx) => boolean) => { sch.actions[id] = { id, label, key, menu: "Edit", run: (ctx) => run(ctx as Ctx) }; };
  add("group", "Group Items", "", group); add("ungroup", "Ungroup Items", "", ungroup); add("enterGroup", "Enter Group", "", enterGroup); add("leaveGroup", "Leave Group", "", leaveGroup);
  add("removeFromGroup", "Remove Items", "", removeFromGroup); add("groupProperties", "Group Properties...", "", renameGroup);
  sch.expandGroups = schExpandGroups;
  (sch as unknown as { enterGroupAt?: typeof enterGroupAt }).enterGroupAt = enterGroupAt;
  // Esc, or a click outside the entered group's box, leaves the group (SCH_SELECTION_TOOL::ExitGroup)
  (sch as unknown as { exitGroup?: () => boolean }).exitGroup = () => { if (!enteredGroup()) return false; entered = null; setStatusBar({ mode: "" }); requestRender(); return true; };
  const stage = typeof document !== "undefined" ? document.querySelector("#stage") : null;
  if (stage) stage.addEventListener("pointerdown", (ev) => {
    const g = enteredGroup(); if (!g || !E.kdoc || !isSch() || (ev as PointerEvent).button !== 0 || E.tool !== "select") return;
    const b = groupBox(E.kdoc, E.kdoc.items.get(g)!); if (!b) return;
    const mm = toolCtx().worldMm(ev as PointerEvent);
    if (mm[0] < b[0] || mm[0] > b[2] || mm[1] < b[1] || mm[1] > b[3]) { entered = null; setStatusBar({ mode: "" }); requestRender(); }
  }, true);
  const overlay = sch.drawOverlay;
  sch.drawOverlay = (c, view, ctx) => { if (overlay) overlay(c, view, ctx); try { drawGroupBoxes(c as CanvasRenderingContext2D, view as { ppm: number; zoom: number; dpr?: number }, ctx as Ctx); } catch (e) { console.warn(e); } };
  // a deletion repairs the groups it leaves behind (and removes the selected groups themselves)
  const base = sch.deleteChanges;
  if (base) sch.deleteChanges = (doc: KDoc, items: KItem[]) => {
    const groups = items.filter((it) => it.kind === "group"), rest = items.filter((it) => it.kind !== "group");
    const ch = (rest.length ? base(doc, rest) : []) || rest.map((it) => KiCadCanvas.removeChange(it));
    const gone = new Set<string>(items.map((it) => it.id)); for (const c of ch) if (c.kind === "REMOVED") gone.add(c.id);
    return [...ch, ...groups.map((g) => ({ id: g.id, kind: "REMOVED", typeName: "SCH_GROUP", properties: [] }) as KChange), ...groupCleanupChanges(doc, gone)];
  };
}
