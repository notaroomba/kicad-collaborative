import type { SAtom, SchCtx, Pt } from "./types";
import { root } from "../root";
import { cursorOf, editable, selectedItems } from "./commands";
import { netItems } from "./highlight";
import { hitNonSymbol } from "./hit";
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
  const doc = ctx.doc; let bus: KItem | undefined = opts.bus ? (typeof opts.bus === "string" ? doc.items.get(opts.bus) : opts.bus) : selectedItems(ctx).find((it) => it.kind === "bus");
  if (!bus) { const c = cursorOf(ctx), hit = hitNonSymbol(doc, c[0], c[1], Math.max(0.6, 8 * mmPerPx(ctx))); if (hit && hit.kind === "bus") bus = hit; }
  if (!bus) { ctx.toast("Select a bus first"); return false; }
  const members = unfoldMembers(doc, bus); if (!members.length) { ctx.toast("No bus label names this bus's members"); return false; }
  const go = (m: string) => { if (m && members.includes(m)) unfoldBus(ctx, bus!, m, opts!.at!); };
  if (opts.member) { go(opts.member); return true; }
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (!KD) { go(members[0]); return true; }
  KD.open({ title: "Unfold from Bus", width: 320,
    build(body) { body.innerHTML = `<div class="kv"><label>Net</label><select id="kd-member">${members.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">${m.replace(/</g, "&lt;")}</option>`).join("")}</select></div>`; },
    ok() { go((document.getElementById("kd-member") as HTMLSelectElement).value); } });
  return true;
}
