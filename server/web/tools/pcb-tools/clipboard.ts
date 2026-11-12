// pcb-tools/clipboard.ts — the clipboard in KiCad's own format (a kicad_pcb document), paste and duplicate.
import type { BoardDoc, NetRef, PcbChange, PcbCtx, Pt, SAtom } from "./types";

/** A paste-special / duplicate option bag. */
export interface PasteOpts { annotations?: string; clearNets?: boolean; xform?: (n: SNode, it: KItem) => void }
import { addedChange } from "./changes";
import { conductorEnds } from "./connected";
import { copperOf } from "./dialogs";
import { expandGroups, groupMembers, groupMembersChanges, groupOf, parentOf, setLocked } from "./groups";
import { netTable } from "./netlist";
import { netNode, netOf, netStyle } from "./nets";
import { padsOf } from "./route-geom";
import { BOARD_VERSION, K, S } from "./state";
import { PCB_KINDS, anchorOf, isFootprintNode, selectionCenter, translateNode } from "./transforms";
import { clone, isList } from "./util";

// ---------------------------------------------------------------- clipboard (KiCad's own format: a kicad_pcb document)
// formatBoardLayers: the copper layers first, in stack order (the parser counts them there), then the rest by id.
export function layersBlock(doc: BoardDoc) {
  const rows: (string | number)[][] = []; for (const [name, l] of doc.layers) if (/\./.test(name) || name === "Margin") rows.push([l.id, name, l.type || "user"].concat(l.userName ? [l.userName] : []));
  if (!rows.length) rows.push([0, "F.Cu", "signal"], [2, "B.Cu", "signal"]);
  const copper = copperOf(doc); const rank = (r: (string | number)[]) => { const i = copper.indexOf(r[1] as string); return i >= 0 ? i : (/\.Cu$/.test(r[1] as string) ? 500 + (r[0] as number) : 1000 + (r[0] as number)); };
  rows.sort((a, b) => rank(a) - rank(b)); return ["layers", ...rows];
}
/** The (layers …) block as text: KiCad's parser wants the layer names and user names quoted, which the serializer would leave bare. */
export const quote = (s: unknown) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export function layersText(doc: BoardDoc) { return "(layers " + layersBlock(doc).slice(1).map((r) => `(${r[0]} ${quote(r[1])} ${r[2]}${r[3] !== undefined ? " " + quote(r[3]) : ""})`).join(" ") + ")"; }
/** BestDragOrigin: the item anchor nearest the cursor, else the cursor, else the selection's centre. */
export function referencePoint(doc: BoardDoc, ids: string[], cursor: Pt | null | undefined) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; let best: Pt | null = null, bd = Infinity;
  if (cursor) for (const it of items) { const pts = it.kind === "footprint" ? [anchorOf(it)].concat(padsOf(it).map((p) => [p.x, p.y])) : [anchorOf(it)].concat(conductorEnds(it)); for (const p of pts) { const d = Math.hypot(p[0] - cursor![0], p[1] - cursor![1]); if (d < bd) { bd = d; best = p; } } }
  return best || cursor || selectionCenter(items);
}
/** CLIPBOARD_IO::SaveSelection: a kicad_pcb with the board's layers, the nets in use and the items moved so ref sits at (0, 0); locks dropped. */
export function clipboardText(doc: BoardDoc, ids: Iterable<string>, ref?: Pt | null) {
  ref = ref || [0, 0]; const NT = netTable(doc); const items = Array.from(expandGroups(doc, ids)).map((id) => doc.items.get(id)).filter(Boolean);
  const refd = new Map<string, number>(); const take = (n: NetRef) => { const key = NT.key(n); if (key && !refd.has(key)) refd.set(key, n.code > 0 ? n.code : 0); };
  for (const it of items) { if (it!.kind === "footprint") for (const p of K.kids(it!.node, "pad")) take(netOf(p)); else if (K.kid(it!.node, "net")) take(netOf(it!.node)); }
  let next = 1; const used = new Set(refd.values()); for (const [k, v] of refd) if (!v) { while (used.has(next)) next++; refd.set(k, next); used.add(next); }
  const parts = [`(kicad_pcb (version ${BOARD_VERSION}) (generator "kicad-collab-web") (generator_version "10.0")`, layersText(doc), '(net 0 "")'];
  for (const [name, code] of Array.from(refd).sort((a, b) => a[1] - b[1])) parts.push(`(net ${code} ${quote(name)})`);
  for (const it of items) { const node = clone(it!.node); translateNode(node, -ref![0], -ref![1]); setLocked(node, false); parts.push(K.serialize(node)); }
  return parts.join("\n") + "\n)";
}
export function parseClipboard(text: string) {
  let trees: SAtom[] | null | undefined; try { trees = K.parseAll(text); } catch (e) { return null; }
  const nodes: SNode[] = [], codeToName = new Map<number, string>();
  for (const t of trees || []) {
    if (!isList(t)) continue;
    if (t[0] === "kicad_pcb") { for (const c of t.slice(1)) { if (!isList(c)) continue; if (c[0] === "net" && typeof c[1] === "number") codeToName.set(c[1], K.str(c[2])); else if (PCB_KINDS.has(c[0] as string)) nodes.push(c); } }
    else if (PCB_KINDS.has(t[0] as string)) nodes.push(t);
  }
  return nodes.length ? { nodes, codeToName } : null;
}
/** Every (uuid) / (tstamp) at any depth gets a new id; group members follow the map (members left behind are dropped). */
export function freshUuids(nodes: SNode[]) {
  const map = new Map<string, string>();
  const walk = (n: SNode) => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (!isList(c)) continue; if ((c[0] === "uuid" || c[0] === "tstamp") && c.length > 1) { const old = K.str(c[1]); if (!map.has(old)) map.set(old, K.newUuid()); c[1] = map.get(old)!; } else walk(c); } };
  for (const n of nodes) walk(n);
  for (const n of nodes) if (n[0] === "group" || n[0] === "generated") { const m = K.kid(n, "members"); if (m) { const ids = m.slice(1).map(K.str).filter((id) => map.has(id)).map((id) => map.get(id)!); m.splice(1, m.length - 1, ...ids); } }
  return map;
}
/** Nets are kept by name and rewritten in the target document's style; names the board lacks become unconnected in a code-style board. */
export function rewriteNets(nodes: SNode[], codeToName: Map<number, string>, doc: BoardDoc) {
  const NT = netTable(doc); const style = netStyle(doc);
  const walk = (n: SNode) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "net" && c.length > 1 && n[0] !== "kicad_pcb") {
        const name = typeof c[1] === "number" ? (c.length > 2 ? K.str(c[2]) : (codeToName.get(c[1]) || "")) : K.str(c[1]);
        if (style === "name") n[i] = ["net", name];
        else { const t = name ? NT.byName.get(name) : null; const code = t && t.code > 0 ? t.code : 0; n[i] = c.length > 2 || n[0] === "pad" ? ["net", code, code ? name : ""] : ["net", code]; }
      } else walk(c);
    }
  };
  for (const n of nodes) walk(n);
}
export const refProp = (node: SNode) => K.kids(node, "property").find((p) => K.str(p[1]) === "Reference");
/** Paste-special annotation modes (PASTE_MODE): keep (the default), unique, clear (REF**). */
export function annotate(nodes: SNode[], doc: BoardDoc, mode: string) {
  if (mode === "keep") return;
  const used = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "footprint" && it.ref) used.add(it.ref);
  for (const n of nodes) {
    if (!isFootprintNode(n)) continue; const p = refProp(n); if (!p) continue; const ref = K.str(p[2]);
    if (mode === "clear") { p[2] = "REF**"; continue; }
    const m = /^(.*?)(\d+)$/.exec(ref); if (!m) continue;
    if (!used.has(ref)) { used.add(ref); continue; }
    let k = 1; while (used.has(m[1] + k)) k++; p[2] = m[1] + k; used.add(p[2]);
  }
}
/** ADDED changes for clipboard text placed with its reference point at `at`; returns { changes, ids }. */
export function pasteChanges(doc: BoardDoc, text: string, at: Pt | null | undefined, opts?: PasteOpts | null) {
  opts = opts || {}; const parsed = parseClipboard(text); if (!parsed) return { changes: [], ids: [] };
  const nodes = parsed.nodes.map(clone); freshUuids(nodes); rewriteNets(nodes, parsed.codeToName, doc); annotate(nodes, doc, opts.annotations || "keep");
  if (opts.clearNets) clearNets(nodes, doc);
  const changes: PcbChange[] = [], ids: string[] = [];
  for (const n of nodes) { if (at && (at[0] || at[1])) translateNode(n, at[0], at[1]); const c = addedChange(doc, n); changes.push(c); ids.push(c.id); }
  return { changes, ids };
}
/**
 * DIALOG_PASTE_SPECIAL's "Clear net assignments": every pasted connected item goes onto the orphaned net
 * (SetNet( NETINFO_LIST::OrphanedItem() )) — pads lose their (net …), tracks, vias and zones take net 0 / "".
 */
export function clearNets(nodes: SNode[], doc: BoardDoc) {
  const walk = (n: SNode) => {
    for (let i = n.length - 1; i > 0; i--) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "net" && n[0] !== "kicad_pcb") { if (n[0] === "pad") n.splice(i, 1); else n[i] = netNode(doc, null); }
      else if (c[0] === "net_name") c[1] = "";
      else walk(c);
    }
  };
  for (const n of nodes) walk(n);
}
/**
 * EDIT_TOOL::Duplicate: BOARD_ITEM::Duplicate clones each item with a new uuid and nothing else changed — the same
 * reference, lock state, nets and place — and a copy whose original sits in a group that is not itself being
 * duplicated joins that group (the group is MODIFIED in the same commit).  A selected group is copied whole
 * (PCB_GROUP::DeepDuplicate): a new group holding copies of its members.  Returns { changes, ids, restore } where
 * restore holds the groups' nodes before the copies joined them (a cancelled placement puts them back).
 */
export function duplicateChanges(doc: BoardDoc, ids: Iterable<string>, offset?: Pt | null, opts?: PasteOpts | null) {
  const sel = new Set(ids); const out: { changes: PcbChange[]; ids: string[]; restore: { id: string; node: SNode }[] } = { changes: [], ids: [], restore: [] }; const joins = new Map<string, string[]>();
  const coveredByGroup = (id: string) => { for (let g = parentOf(doc, id); g; g = parentOf(doc, g.id)) if (sel.has(g.id)) return true; return false; };
  const isParent = (n: SNode) => n[0] === "group" || n[0] === "generated";
  const subtree = (it: KItem, acc: KItem[]): KItem[] => { acc.push(it); if (it.kind === "group" || it.kind === "generated") for (const m of groupMembers(it.node)) { const c = doc.items.get(m); if (c) subtree(c, acc); } return acc; };
  for (const id of ids) {
    // a generator (a tuning pattern) is copied as PCB_GENERATOR::DeepDuplicate does: a new generator holding copies of its members
    const it = doc.items.get(id); if (!it || coveredByGroup(id)) continue;
    const src = subtree(it, []);
    const nodes = src.map((x) => clone(x.node)); freshUuids(nodes);
    if (opts && opts.annotations) annotate(nodes, doc, opts.annotations);
    if (opts && opts.xform) for (const n of nodes) opts.xform(n, it);   // the array tool's per-copy transform (about the top item)
    // members first, so a group's ADDED change finds them
    const order = nodes.map((n, i: number) => i).sort((a, b) => (isParent(nodes[a]) as unknown as number) - (isParent(nodes[b]) as unknown as number) || b - a);   // booleans subtract as 0/1
    let topId: string | null = null;
    for (const i of order) {
      const n = nodes[i]; if (offset && (offset[0] || offset[1])) translateNode(n, offset[0], offset[1]);
      const c = addedChange(doc, n); out.changes.push(c); out.ids.push(c.id); if (i === 0) topId = c.id;
    }
    const g = groupOf(doc, id);
    if (g && topId) { if (!joins.has(g.id)) joins.set(g.id, []); joins.get(g.id)!.push(topId); }
  }
  for (const [gid, add] of joins) { const g = doc.items.get(gid); out.restore.push({ id: gid, node: clone(g!.node) }); out.changes.push(...groupMembersChanges(doc, g!, add, [])); }
  return out;
}
export const textOfItem = (it: KItem) => it.kind === "footprint" ? (it.ref || "") : it.kind === "gr_text" || it.kind === "gr_text_box" ? K.str(it.node[1]) : it.kind === "dimension" ? K.str((K.kid(it.node, "gr_text") || [])[1]) : "";
// The clipboard: the browser's when it can be reached, an app-supplied one, else a buffer of our own.
export let clipBuffer = "";
export function clipSet(ctx: PcbCtx, text: string) {
  clipBuffer = text; if (ctx.clipboard && ctx.clipboard.set) ctx.clipboard.set(text);
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}
export function clipGet(ctx: PcbCtx, done: (text: string) => void) {
  if (ctx.clipboard && ctx.clipboard.get) { const v = ctx.clipboard.get(); if (v && typeof (v as Promise<string | null | undefined>).then === "function") { (v as Promise<string | null | undefined>).then((t) => done(t || clipBuffer), () => done(clipBuffer)); return; } done((v as string | null | undefined) || clipBuffer); return; }
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.readText) { navigator.clipboard.readText().then((t) => done(t && /\(kicad_pcb|\(footprint|\(segment|\(via|\(gr_|\(zone/.test(t) ? t : clipBuffer), () => done(clipBuffer)); return; }
  done(clipBuffer);
}
export function cursorPoint(ctx: PcbCtx) {
  let p: Pt | null = ctx.cursor || (S.hover ? [S.hover.x, S.hover.y] : null);
  if (!p && ctx.doc && ctx.doc.bbox) p = [(ctx.doc.bbox[0] + ctx.doc.bbox[2]) / 2, (ctx.doc.bbox[1] + ctx.doc.bbox[3]) / 2];
  if (!p) return [0, 0]; return ctx.snapOn && ctx.snap ? ctx.snap(p) : p;
}
