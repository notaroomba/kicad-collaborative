import type { SAtom, SchCtx, Pt } from "./types";
import { root } from "../root";
import { cursorOf, editable, selectedItems } from "./commands";
import { netItems } from "./highlight";
import { switchTool } from "./junction";
import { busEntryNode, labelNode } from "./nodes";
import { mmPerPx } from "./snap";
import { S, str } from "./state";
import { closestOnSeg } from "./transforms";
import { addNode, r4, segs } from "./util";
import { startWire } from "./wire";

// ---------------------------------------------------------------- unfold bus (SCH_LINE_WIRE_BUS_TOOL::UnfoldBus)
// NET_SETTINGS::ParseBusVector / ParseBusGroup: "DATA[0..3]" -> DATA0..DATA3 (a +-PN suffix rides along),
// "{A B C}" -> A B C, "NAME{A B}" -> NAME.A NAME.B; vectors nest inside groups.
/** A bus label's members: a vector (DATA[0..3]) or a group ({A B}, NAME{A B}). */
export interface BusMembers { name: string; members: string[]; vector?: boolean; group?: boolean }
export function busMembers(text: SAtom): BusMembers | null {
  text = str(text).trim();
  const v = text.match(/^([^\s\[\]{}]*)\[(\d+)\.\.(\d+)\]([+\-PN]*)$/);
  if (v) { let a = +v[2], b = +v[3]; if (a === b) return null; if (a > b) { const t = a; a = b; b = t; } const members: string[] = []; for (let i = a; i <= b; i++) members.push(v[1] + i + v[4]); return { name: v[1], members, vector: true }; }
  const g = text.match(/^([^\s\[\]{}]*)\{(.*)\}$/);
  if (g) {
    const prefix = g[1] ? g[1] + "." : "", members: string[] = [];
    for (const m of g[2].split(/[\s,]+/).filter(Boolean)) { const sub = busMembers(m); if (sub && sub.vector) members.push(...sub.members.map((x) => prefix + x)); else members.push(prefix + m); }
    return members.length ? { name: g[1], members, group: true } : null;
  }
  return null;
}
export function busLabelsOf(doc: KDoc, bus: KItem) {
  const out: (BusMembers & { label: KItem })[] = [];
  for (const id of netItems(doc, bus)) { const it = doc.items.get(id); if (it && (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label")) { const m = busMembers(it.node[1]); if (m) out.push(Object.assign({ label: it }, m)); } }
  return out;
}
/**
 * BUS_UNFOLD_MENU::memberEntries: the bus's members in label order, a nested bus (a vector inside a group) as an entry
 * of its own with its nets under it.  A named group's nested buses take its prefix ("NAME.DATA[0..3]"); every net
 * carries its full name.
 */
export interface UnfoldEntry { name: string; bus: boolean; members: string[] }
export function unfoldEntries(doc: KDoc, bus: KItem): UnfoldEntry[] {
  const out: UnfoldEntry[] = [], seen = new Set<string>();
  const add = (e: UnfoldEntry) => { const k = (e.bus ? "b:" : "n:") + e.name; if (seen.has(k)) return; seen.add(k); out.push(e); };
  for (const id of netItems(doc, bus)) {
    const it = doc.items.get(id); if (!it || !(it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label")) continue;
    const text = str(it.node[1]).trim(), m = busMembers(text); if (!m) continue;
    if (m.vector) { for (const n of m.members) add({ name: n, bus: false, members: [] }); continue; }
    const g = text.match(/^([^\s\[\]{}]*)\{(.*)\}$/); if (!g) continue;
    const prefix = g[1] ? g[1] + "." : "";
    for (const tok of g[2].split(/[\s,]+/).filter(Boolean)) {
      const sub = busMembers(tok);
      if (sub && sub.vector) add({ name: prefix + tok, bus: true, members: sub.members.map((x) => prefix + x) });
      else add({ name: prefix + tok, bus: false, members: [] });
    }
  }
  return out;
}
/** SCH_CONNECTION::PrintBusForUI: the escapes undone and the formatting braces of ~{…} _{…} ^{…} dropped. */
export function printBusForUI(name: string): string {
  const K = root.KiCadCanvas as unknown as { unescapeText?: (s: string) => string } | undefined;
  const u = K && K.unescapeText ? K.unescapeText(name) : name;
  let out = "";
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if ((c === "~" || c === "_" || c === "^") && u[i + 1] === "{") { out += c; i++; continue; }
    if (c === "}") continue;
    if (c === "\\" && u[i + 1] === " ") continue;
    out += c;
  }
  return out;
}
/** getBusForUnfolding: the selected bus, else the bus under the cursor. */
export function busForUnfolding(ctx: SchCtx): KItem | null {
  const sel = selectedItems(ctx).find((it) => it.kind === "bus"); if (sel) return sel;
  // RequestSelection( { SCH_ITEM_LOCATE_BUS_T } ): only buses compete, so a graphic line lying on the bus doesn't hide it
  const c = cursorOf(ctx), tol = Math.max(0.6, 8 * mmPerPx(ctx));
  let best: KItem | null = null, bd = Infinity;
  for (const it of ctx.doc.items.values()) if (it.kind === "bus") for (const [a, b] of segs(it)) { const q = closestOnSeg(c, a, b), d = Math.hypot(q[0] - c[0], q[1] - c[1]); if (d <= tol && d < bd) { bd = d; best = it; } }
  return best;
}
export function unfoldMembers(doc: KDoc, bus: KItem) { const seen = new Set<string>(), out: string[] = []; for (const b of busLabelsOf(doc, bus)) for (const m of b.members) if (!seen.has(m)) { seen.add(m); out.push(m); } return out; }
export function nearestOnLine(item: KItem, p: Pt) { let best: Pt | null = null, bd = Infinity; for (const [a, b] of segs(item)) { const q = closestOnSeg(p, a, b), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } } return best; }
// Bus entry at the point, the member label on its far end (spun away from the bus like
// SCH_SCREEN::GetLabelOrientationForPoint), then the wire tool takes over from that end.
export function unfoldBus(ctx: SchCtx, bus: KItem, member: string, at: Pt) {
  const doc = ctx.doc, c = at || cursorOf(ctx), snapped = ctx.snap([c[0], c[1]]).map(r4);
  const p = nearestOnLine(bus, snapped); if (!p) return null;
  const seg = segs(bus)[0], horizontal = Math.abs(seg[0][1] - seg[1][1]) < 1e-6, vertical = Math.abs(seg[0][0] - seg[1][0]) < 1e-6;
  const sx = c[0] < p[0] ? -1 : 1, sy = c[1] < p[1] ? -1 : 1;
  const dx = 2.54 * sx, dy = 2.54 * sy, end = [r4(p[0] + dx), r4(p[1] + dy)];
  let rot = 0; if (vertical) rot = end[0] < p[0] ? 180 : 0; else if (horizontal) rot = end[1] < p[1] ? 90 : 270;
  const entry = addNode(doc, busEntryNode(p, r4(dx), r4(dy))), label = addNode(doc, labelNode("label", member, end, rot));   // IS_NEW: not committed yet
  switchTool(ctx, "wire");
  startWire(ctx, "wire", end);
  S.unfold = { labelId: label.item.id, entryId: entry.item.id, origin: p, placed: false };
  ctx.requestRender();
  return { entry: entry.item, label: label.item, start: end };
}
export function unfoldAction(ctx: SchCtx, opts?: { bus?: string | KItem; member?: string; at?: Pt } | null) {
  if (!editable(ctx)) return false;
  opts = opts || {};
  const doc = ctx.doc; const bus: KItem | null | undefined = opts.bus ? (typeof opts.bus === "string" ? doc.items.get(opts.bus) : opts.bus) : busForUnfolding(ctx);
  const members = bus ? unfoldMembers(doc, bus) : [];
  if (opts.member) { if (bus && members.includes(opts.member)) unfoldBus(ctx, bus, opts.member, opts.at!); return true; }
  // SCH_LINE_WIRE_BUS_TOOL::UnfoldBus: BUS_UNFOLD_MENU pops up at the cursor (SetContextMenu CMENU_NOW), titled; a
  // pick unfolds that net, closing the menu does nothing
  const hk = root.CollabEditor && (root.CollabEditor as unknown as { hooks?: { busUnfoldMenu?: (entries: unknown[], bus: KItem | null, at: Pt) => void } }).hooks;
  if (hk && hk.busUnfoldMenu) { hk.busUnfoldMenu(bus ? unfoldEntries(doc, bus) : [], bus || null, opts.at || cursorOf(ctx)); return true; }
  if (!bus || !members.length) return false;
  unfoldBus(ctx, bus, members[0], opts.at!);
  return true;
}
