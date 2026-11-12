import type { SchCtx, Pt } from "./types";
import { symbolPins } from "./autoplace";
import { cursorOf } from "./commands";
import { pinsAt } from "./connect";
import { isPowerSymbol } from "./dom";
import { connPoints, isNetLine } from "./drag";
import { hitNonSymbol } from "./hit";
import { mmPerPx } from "./snap";
import { K, S, atOf, kid, kids, ptsOf, str } from "./state";
import { onSegMid, r4, same, segs } from "./util";

// ---------------------------------------------------------------- net highlighting (connectivity on this sheet)
// Terminals of an item: { p, net: "wire" | "bus" | "any", key }.  Terminals join where they share a
// point (a wire never joins a bus directly, everything else is agnostic) or sit on the middle of a
// net line; `key` names a net that spans the sheet — net labels by text, global labels and power
// symbols by name, hierarchical labels by text.  Net lines, junctions and bus entries conduct
// between all their terminals; a symbol's or sheet's pins are separate nets.
export const NET_PICK = new Set(["wire", "bus", "junction", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
/** A connection point of an item for net walking. */
export interface Terminal { p: Pt; net: string; key?: string }
export function terminalsOf(doc: KDoc, it: KItem): Terminal[] {
  const k = it.kind, n = it.node, at = () => atOf(n).slice(0, 2).map(r4);
  if (isNetLine(k)) return ptsOf(n).map((p) => ({ p: p.map(r4), net: k }));
  if (k === "junction" || k === "netclass_flag" || k === "directive_label") return [{ p: at(), net: "any" }];
  if (k === "bus_entry") return connPoints(doc, it).map((p) => ({ p, net: "any" }));
  if (k === "label") return [{ p: at(), net: "any", key: "local:" + str(n[1]) }];
  if (k === "global_label") return [{ p: at(), net: "any", key: "global:" + str(n[1]) }];
  if (k === "hierarchical_label") return [{ p: at(), net: "any", key: "hier:" + str(n[1]) }];
  if (k === "symbol") {
    const libId = str((kid(n, "lib_id") || [])[1]), value = kids(n, "property").find((p) => str(p[1]) === "Value");
    // a power symbol names its net through its power input pin; PWR_FLAG (a power output) names none
    const key = isPowerSymbol(doc, libId) && value && symbolPins(doc, it).some((q) => q.type === "power_in") ? "global:" + str(value[2]) : undefined;
    return K.pinPoints(doc, it).map((q) => ({ p: [r4(q.x), r4(q.y)], net: "wire", key }));
  }
  if (k === "sheet") return kids(n, "pin").map((pin) => ({ p: atOf(pin).slice(0, 2).map(r4), net: "any" }));
  return [];
}
export const conducts = (it: KItem) => isNetLine(it.kind) || it.kind === "junction" || it.kind === "bus_entry";
export const joins = (a: { net: string }, b: { net: string }) => a.net === "any" || b.net === "any" || a.net === b.net;
/** Ids of everything on the net of `item` on this sheet; `near` picks the pin of a symbol or sheet. */
export function netItems(doc: KDoc, item: KItem, near?: Pt | null) {
  const terms = new Map<KItem, Terminal[]>();
  for (const it of doc.items.values()) { const t = terminalsOf(doc, it); if (t.length) terms.set(it, t); }
  const mine = terms.get(item), set = new Set([item.id]); if (!mine) return set;
  const done = new Set<Terminal>(), keys = new Set<string>(), keysDone = new Set<string>(), work: Terminal[] = [];
  const reach = (it: KItem, t: Terminal) => {
    set.add(it.id);
    for (const u of conducts(it) ? terms.get(it)! : [t]) { if (done.has(u)) continue; done.add(u); work.push(u); if (u.key) keys.add(u.key); }
    if (isNetLine(it.kind)) {                                 // things sitting on the middle of a reached line
      const sg = segs(it), lineT = { net: it.kind };
      for (const [o, ts] of terms) { if (o === it) continue; for (const u of ts) if (!done.has(u) && joins(lineT, u) && sg.some(([a, b]) => onSegMid(u.p, a, b))) reach(o, u); }
    }
  };
  if (item.kind === "symbol" || item.kind === "sheet") {
    let best = mine[0], bd = Infinity;
    if (near) for (const t of mine) { const dd = Math.hypot(t.p[0] - near[0], t.p[1] - near[1]); if (dd < bd) { bd = dd; best = t; } }
    reach(item, best);
  } else for (const t of mine) reach(item, t);
  for (;;) {
    while (work.length) {
      const t = work.pop()!;
      for (const [it, ts] of terms) {
        for (const u of ts) if (!done.has(u) && joins(t, u) && same(u.p, t.p)) reach(it, u);
        if (isNetLine(it.kind) && !set.has(it.id) && joins(t, { net: it.kind }) && segs(it).some(([a, b]) => onSegMid(t.p, a, b))) reach(it, ts[0]);
      }
    }
    const fresh = Array.from(keys).filter((k) => !keysDone.has(k)); if (!fresh.length) break;
    for (const key of fresh) { keysDone.add(key); for (const [o, ts] of terms) for (const u of ts) if (u.key === key && !done.has(u)) reach(o, u); }
  }
  return set;
}
// What the highlight tool picks under the cursor: a net item, a symbol pin, or a sheet pin.
export function pickNet(ctx: SchCtx, mm: Pt): { item: KItem; at: Pt; pin?: string } | null {
  const doc = ctx.doc, tol = Math.max(0.3, 5 * mmPerPx(ctx)), pinTol = Math.max(tol, 0.6);
  const hit = hitNonSymbol(doc, mm[0], mm[1], tol);
  if (hit && NET_PICK.has(hit.kind)) return { item: hit, at: mm };
  const pins = pinsAt(doc, mm[0], mm[1], pinTol); if (pins.length) return { item: pins[0].item, at: [pins[0].x, pins[0].y] };
  for (const it of doc.items.values()) if (it.kind === "sheet") for (const pin of kids(it.node, "pin")) { const [x, y] = atOf(pin); if (Math.hypot(x - mm[0], y - mm[1]) <= pinTol) return { item: it, at: [x, y] }; }
  // a power symbol (its body or one of its fields) stands for the net of its single pin (highlightNet: pins.size() == 1)
  const symId = K.hitTest(doc, mm[0], mm[1], tol), sym = symId ? doc.items.get(symId) : null;
  if (sym && sym.kind === "symbol" && isPowerSymbol(doc, str((kid(sym.node, "lib_id") || [])[1]))) {
    const sp = symbolPins(doc, sym); if (sp.length === 1) return { item: sym, at: [sp[0].x, sp[0].y], pin: sp[0].number };
  }
  return null;
}
export function setHighlight(ctx: SchCtx, ids: Set<string> | null) {
  S.highlight = ids && ids.size ? ids : null;
  if (typeof ctx.setHighlight === "function") ctx.setHighlight(S.highlight);
  ctx.requestRender();
}
// SCH_EDITOR_CONTROL::HighlightNet: the net of the item under the cursor, straight away; nothing there clears it.
export function highlightNetNow(ctx: SchCtx) {
  const c = cursorOf(ctx); if (!c) return false;
  highlightClick(ctx, c); return true;
}
// The editor installs the hierarchy-wide highlighter (web/editor/schnets.ts): the highlight is kept as a net NAME
// (SCH_EDIT_FRAME::SetHighlightedConnection) and follows the net through every sheet; without it, this sheet's ids.
export function clearHighlight(ctx: SchCtx) { if (S.netHL) S.netHL.clear(ctx); else setHighlight(ctx, null); }
export function highlightClick(ctx: SchCtx, mm: Pt) {
  const pick = pickNet(ctx, mm);
  if (S.netHL) { S.netHL.highlightPick(ctx, pick); return S.highlight; }
  if (!pick) { setHighlight(ctx, null); return null; }
  const ids = netItems(ctx.doc, pick.item, pick.at); setHighlight(ctx, ids); return ids;
}
