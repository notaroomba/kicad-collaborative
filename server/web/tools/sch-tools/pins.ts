// ---------------------------------------------------------------- a bare symbol pin as the selection (SCH_PIN_T)
// SCH_SELECTION_TOOL collects a pin under the cursor ahead of its symbol's body: a click on a pin selects the pin.
// What KiCad does with a selected pin: the move / drag tools and Properties promote it to its parent symbol, the
// Edit Main Fields actions edit the parent's fields, and the selection menu offers the Pin Function (alternates)
// and Pin Helpers (PIN_TRICKS_MENU: Wire, No Connect, Net Label, Hierarchical Label, Global Label) sub-menus.
import type { SchCtx, Pt } from "./types";
import { symbolPins, type SymPin } from "./autoplace";
import { lineNode, labelNode, noConnectNode } from "./nodes";
import { K, kid, kids, str } from "./state";
import { addNode, deep, modChange, r4 } from "./util";
import { setSpinOfNode, type Spin } from "./autorotate";

export interface PinRef { id: string; number: string }
export interface PinHit { item: KItem; pin: SymPin }

/** Distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/**
 * SCH_PIN::HitTest: the pin's line from its connection point to the body, within `tol`.  Hidden pins count only while
 * hidden pins are shown (SCH_SELECTION_TOOL::Selectable).  The nearest pin wins.
 */
export function pinAt(doc: KDoc, p: Pt, tol: number, showHidden?: boolean): PinHit | null {
  let best: PinHit | null = null, bestD = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    for (const pin of symbolPins(doc, it)) {
      if (pin.hidden && !showHidden) continue;
      const d = segDist(p, [pin.x, pin.y], pin.root);
      if (d <= tol && d < bestD) { best = { item: it, pin }; bestD = d; }
    }
  }
  return best;
}
export function pinOf(doc: KDoc, ref: PinRef | null | undefined): PinHit | null {
  if (!ref) return null;
  const it = doc.items.get(ref.id); if (!it || it.kind !== "symbol") return null;
  const pin = symbolPins(doc, it).find((q) => q.number === ref.number);
  return pin ? { item: it, pin } : null;
}
/** The pin's spin away from its body: the side the pin points to, as GetPinSpinStyle / PIN_TRICKS orient things. */
const SIDE_SPIN: Record<string, Spin> = { right: 0, top: 1, left: 2, bottom: 3 };
const SIDE_DIR: Record<string, Pt> = { right: [1, 0], top: [0, -1], left: [-1, 0], bottom: [0, 1] };
/** LABEL_FLAG_SHAPE from the pin's electrical type (sch_selection_tool.cpp, the Pin Helpers labels). */
export function labelShapeForPin(type: string): string {
  switch (type) {
    case "bidirectional": return "bidirectional";
    case "input": return "input";
    case "output": return "output";
    case "tri_state": return "tri_state";
    case "unspecified": return "passive";              // L_UNSPECIFIED is written as (shape passive)
    default: return "input";
  }
}
/** SCH_PIN::GetShownName: "~" is an empty name. */
const shownName = (pin: SymPin): string => (pin.name === "~" ? "" : pin.name);
export type PinHelper = "wire" | "noconnect" | "label" | "hierarchical_label" | "global_label";
export const PIN_HELPERS: { id: PinHelper; label: string; icon: string }[] = [
  { id: "wire", label: "Wire", icon: "add_line" }, { id: "noconnect", label: "No Connect", icon: "noconn" },
  { id: "label", label: "Net Label", icon: "add_label" }, { id: "hierarchical_label", label: "Hierarchical Label", icon: "add_hierarchical_label" },
  { id: "global_label", label: "Global Label", icon: "add_glabel" },
];
/**
 * The Pin Helpers commands on the selected pins: a no-connect on each ("No Connect Pins"), a wire stub one grid step
 * out of each ("Wire Pins"), or a label named after the pin ("Label Pins") facing away from the body with the shape
 * its electrical type gives.  The new items become the selection.  Returns their ids.
 */
export function pinHelper(ctx: SchCtx, pins: PinRef[], what: PinHelper, sheetRef?: (it: KItem) => string): string[] {
  const doc = ctx.doc, changes: KChange[] = [], ids: string[] = [];
  const grid = ctx.gridPitch > 0 ? ctx.gridPitch : 1.27;
  for (const r of pins) {
    const h = pinOf(doc, r); if (!h) continue;
    const p: Pt = [h.pin.x, h.pin.y], side = h.pin.side;
    let node: SNode;
    if (what === "noconnect") node = noConnectNode(p);
    else if (what === "wire") { const d = SIDE_DIR[side] || [1, 0]; node = lineNode("wire", p, [r4(p[0] + d[0] * grid), r4(p[1] + d[1] * grid)]); }
    else {
      let text = shownName(h.pin);
      if (!text) text = `${sheetRef ? sheetRef(h.item) : (h.item.ref || "")}_${h.pin.number}`;
      node = labelNode(what, text, p, 0);
      setSpinOfNode(what, node, SIDE_SPIN[side] === undefined ? 0 : SIDE_SPIN[side]);
      if (what !== "label") { const sh = kid(node, "shape"); if (sh) sh[1] = labelShapeForPin(h.pin.type); }
    }
    if (!K.uuidOf(node)) node.push(["uuid", K.newUuid()]);
    const { item, change } = addNode(doc, node); changes.push(change); ids.push(item.id);
  }
  if (!changes.length) return [];
  for (const id of ids) doc.items.delete(id);           // commit adds them from the fragments
  ctx.commit(changes, what === "noconnect" ? "No Connect Pins" : what === "wire" ? "Wire Pins" : "Label Pins");
  if (ctx.setSelection) ctx.setSelection(ids.filter((id) => doc.items.has(id)));
  ctx.requestRender();
  return ids;
}

// ---------------------------------------------------------------- Pin Function (PIN_FUNCTION_MENU)
/** The lib pin's alternates (SCH_PIN::GetAlternates), empty when it has none. */
export function pinAlternates(doc: KDoc, ref: PinRef): { base: string; alts: string[]; current: string } | null {
  const it = doc.items.get(ref.id); if (!it || it.kind !== "symbol") return null;
  const libId = str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, str((kid(it.node, "lib_id") || [])[1])); if (!lib) return null;
  for (const sub of kids(lib, "symbol")) for (const g of kids(sub, "pin")) {
    if (str((kid(g, "number") || [])[1]) !== ref.number) continue;
    const alts = kids(g, "alternate").map((a) => str(a[1])); if (!alts.length) return null;
    const ip = kids(it.node, "pin").find((x) => str(x[1]) === ref.number), a = ip && kid(ip, "alternate");
    return { base: str((kid(g, "name") || [])[1]), alts, current: a ? str(a[1]) : "" };
  }
  return null;
}
/** SCH_EDIT_FRAME::SetAltPinFunction: the instance pin's (alternate …), cleared for the base function. */
export function setAltPinFunction(ctx: SchCtx, ref: PinRef, alt: string): boolean {
  const doc = ctx.doc, it = doc.items.get(ref.id); const info = pinAlternates(doc, ref); if (!it || !info) return false;
  const want = alt === info.base ? "" : alt; if (want === info.current) return false;
  const n = deep(it.node);
  let p = kids(n, "pin").find((x) => str(x[1]) === ref.number);
  if (!p) { if (!want) return false; p = K.parse(`(pin ${JSON.stringify(ref.number)} (uuid ${JSON.stringify(K.newUuid())}))`) as SNode; const at = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "instances"); if (at > 0) n.splice(at, 0, p); else n.push(p); }
  const ai = p.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "alternate"); if (ai > 0) p.splice(ai, 1);
  if (want) p.push(K.parse(`(alternate ${JSON.stringify(want)})`) as SNode);
  ctx.commit([modChange(doc, it, n)], "Set Pin Function");
  return true;
}
