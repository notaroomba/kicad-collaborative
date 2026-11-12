// pcb-tools/changes.ts — the board changes the tools commit: added, modified, removed.
import type { BoardDoc, NetRef, PcbChange } from "./types";
import { DIM_CLASS } from "./dimensions";
import { netOf } from "./nets";
import { BOARD_VERSION, K } from "./state";
import { isTuningPattern, tuningRemoveChanges } from "./tuning-patterns";

   // REFERENCE_IMAGE: 1000 mils / ppi per pixel

// ---------------------------------------------------------------- changes
export function wrapBoard(node: SNode) { return `(kicad_pcb (version ${BOARD_VERSION}) (generator "pcbnew") ${K.serialize(node)})`; }
// The desktop's class names: kicad-canvas maps "arc" to the schematic shape name first (boards want PCB_ARC) and
// knows nothing of curves, dimensions, images and tables.
export const typeNameOf = (item: Pick<KItem, "kind" | "node">) => item.kind === "arc" ? "PCB_ARC" : item.kind === "gr_curve" ? "PCB_SHAPE"
  : item.kind === "dimension" ? (DIM_CLASS[K.str((K.kid(item.node, "type") || [])[1])] || "PCB_DIM_ALIGNED")
  : item.kind === "image" ? "PCB_REFERENCE_IMAGE" : item.kind === "table" ? "PCB_TABLE" : item.kind === "group" ? "PCB_GROUP" : item.kind === "target" ? "PCB_TARGET" : K.typeNameOf(item);
export function upsertChange(item: Pick<KItem, "id" | "kind" | "node">, kind: KChange["kind"], net?: NetRef | null) {
  const c: PcbChange = { id: item.id, kind, typeName: typeNameOf(item), sexpr: wrapBoard(item.node) };
  const n = net || netOf(item.node); if (n.name) c.netName = n.name;   // the desktop re-resolves nets by name
  // parseItemSexpr strips a parsed group's members (they point into its temporary parse
  // board) and rebuilds membership from this uuid list; without it the group lands empty
  // on the desktop, and a MODIFIED empties one that had members.
  if (item.kind === "group" || item.kind === "generated") c.groupMembers = K.groupMemberIds(item.node);
  if (item.kind === "footprint") {
    const pads: Record<string, string> = {};
    for (const p of K.kids(item.node, "pad")) { const pn = netOf(p); if (pn.name) pads[K.str(p[1])] = pn.name; }
    c.padNets = pads;
  }
  return c;
}
export function addedChange(doc: BoardDoc, node: SNode, net?: NetRef | null) { return upsertChange(K.createItem(doc, node)!, "ADDED", net); }
export function replacedChange(item: KItem, node: SNode) { return upsertChange({ id: item.id, kind: item.kind, node }, "MODIFIED"); }
export function removedChange(item: KItem): PcbChange { const c = K.removeChange(item); c.typeName = typeNameOf(item); return c; }
/** REMOVED changes for a multi-selection (items or ids); app.js deletes a group through this. */
/** Is a footprint field (property / old fp_text reference|value) hidden? */
export function fieldIsHidden(node: SNode): boolean {
  const yes = (n: SNode | null) => !!n && K.str(n[1]) !== "no";
  const h = K.kid(node, "hide"); if (h) return yes(h);
  if (node.includes("hide")) return true;
  const e = K.kid(node, "effects"); return !!e && (e.includes("hide") || yes(K.kid(e, "hide")));
}
/** The field node with (hide yes) (PCB_FIELD::SetVisible( false ) as the file writes it). */
export function hiddenFieldNode(node: SNode): SNode {
  const p = K.cloneNode(node);
  const hk = K.kid(p, "hide"); if (hk) p.splice(p.indexOf(hk), 1);
  const e = K.kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); const he = K.kid(e, "hide"); if (he) e.splice(e.indexOf(he), 1); }
  const before = ["uuid", "effects"].map((k) => K.kid(p, k)).find(Boolean);
  p.splice(before ? p.indexOf(before) : p.length, 0, ["hide", "yes"]);
  return p;
}
/**
 * EDIT_TOOL::DeleteItems: the changes that delete `items`.  A footprint's field (in the Footprint Editor) is never
 * removed: it is hidden (PCB_FIELD::SetVisible( false )).  The array says how KiCad names the step: `hideLabel`
 * "Hide Field" / "Hide Fields" when only fields were hidden, `infoError` when every field was already hidden.
 */
export function deleteChanges(doc: BoardDoc, items: Iterable<KItem | string> | null | undefined): PcbChange[] & { hideLabel?: string; infoError?: string } {
  const out: PcbChange[] & { hideLabel?: string; infoError?: string } = [], gens: KItem[] = [], ids = new Set<string>();
  let hidden = 0, alreadyHidden = 0, removed = 0;
  for (const x of items || []) {
    const it = typeof x === "string" ? doc.items.get(x) : x; if (!it || !it.id || !it.kind || ids.has(it.id)) continue;
    ids.add(it.id);
    if ((doc as { fpEditor?: boolean }).fpEditor && it.kind === "property") {
      if (fieldIsHidden(it.node)) alreadyHidden++; else { out.push(replacedChange(it, hiddenFieldNode(it.node))); hidden++; }
      continue;
    }
    out.push(removedChange(it)); removed++; if (isTuningPattern(it)) gens.push(it);
  }
  if (!removed) { if (hidden) out.hideLabel = hidden === 1 ? "Hide Field" : "Hide Fields"; else if (alreadyHidden) out.infoError = "Use the Footprint Properties dialog to remove fields."; }
  if (!gens.length) return out;
  // EDIT_TOOL::DeleteItems: a selection of only generators (a selected pattern is the generator with its members here)
  // runs genRemove — each pattern goes back to its base line (PCB_TUNING_PATTERN::Remove); with anything else in the
  // selection the generators and their members are removed outright
  const owned = new Set<string>(); for (const g of gens) { owned.add(g.id); for (const m of K.groupMemberIds(g.node)) owned.add(m); }
  if (Array.from(ids).every((id) => owned.has(id))) return tuningRemoveChanges(doc, gens, ids);
  for (const id of owned) { const it = doc.items.get(id); if (it && !ids.has(id)) { out.push(removedChange(it)); ids.add(id); } }
  return out;
}
/** The board's nets, from every pad, track, via and zone (kicad-canvas drops the (net …) table). */
export function boardNets(doc: BoardDoc) {
  const byName = new Map<string, NetRef>(); const take = (n: NetRef) => { if (n && n.name && !byName.has(n.name)) byName.set(n.name, n); };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { for (const p of K.kids(it.node, "pad")) take(netOf(p)); }
    else if (it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") take(netOf(it.node));
  }
  return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
