// ---------------------------------------------------------------- a bare symbol pin as the selection (SCH_PIN_T)
// SCH_SELECTION_TOOL collects a pin under the cursor ahead of its symbol's body: a click on a pin selects the pin.
// What KiCad does with a selected pin: the move / drag tools and Properties promote it to its parent symbol, the
// Edit Main Fields actions edit the parent's fields, and the selection menu offers the Pin Function (alternates)
// and Pin Helpers (PIN_TRICKS_MENU: Wire, No Connect, Net Label, Hierarchical Label, Global Label) sub-menus.
import type { SchCtx, Pt } from "./types";
import { symbolPins, type SymPin } from "./autoplace";
import { lineNode, labelNode, noConnectNode } from "./nodes";
import type { Anchor, BreakJob } from "./types";
import { canFollow } from "./clipboard";
import { cursorOf, setSelectionIds } from "./commands";
import { announceModes, endDrag } from "./drag";
import { K, S, kid, kids, ptsOf, str } from "./state";
import { addNode, deep, modChange, r4 } from "./util";
import { setSpinOfNode, type Spin } from "./autorotate";
import { netWalk } from "./highlight";

export interface PinRef { id: string; number: string }
export interface PinHit { item: KItem; pin: SymPin }

/** Distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/** The schematic setting m_PinSymbolSize (25 mils) a quarter of which floors SCH_PIN::HitTest's accuracy. */
export const PIN_SYMBOL_SIZE = 0.635;
type GeomBox = [number, number, number, number];
/** One drawn primitive's box; a text by its own extent, placed by its justification and turned with it. */
function geomBoxOf(g: KGeom): GeomBox | null {
  const q = g as unknown as Record<string, number> & { t: string; text?: string; h?: string; v?: string; pts?: number[][] };
  const w = (q.w || 0) / 2;
  if (q.t === "line") return [Math.min(q.x1, q.x2) - w, Math.min(q.y1, q.y2) - w, Math.max(q.x1, q.x2) + w, Math.max(q.y1, q.y2) + w];
  if (q.t === "poly" && q.pts && q.pts.length) { const xs = q.pts.map((p) => p[0]), ys = q.pts.map((p) => p[1]); return [Math.min(...xs) - w, Math.min(...ys) - w, Math.max(...xs) + w, Math.max(...ys) + w]; }
  if (q.t === "circle" || q.t === "arc") return [q.x - q.r - w, q.y - q.r - w, q.x + q.r + w, q.y + q.r + w];
  if (q.t === "text") {
    const tw = K.textWidth(q.text || "", q.sizeX || q.size || 1, q.w || 0), th = q.size || 1;
    const x0 = q.h === "left" ? 0 : q.h === "right" ? -tw : -tw / 2, y0 = q.v === "top" ? 0 : q.v === "bottom" ? -th : -th / 2;
    const r = (q.rot || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    // the inverse of the canvas rotator(-rot): local (u, v) -> world
    const pts = [[x0, y0], [x0 + tw, y0], [x0 + tw, y0 + th], [x0, y0 + th]].map(([u, v]) => [q.x + u * c + v * sn, q.y - u * sn + v * c]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return null;
}
/**
 * SCH_PIN::GetBoundingBox( false, true, false ) on the sheet: the pin's line and decoration plus its shown name and
 * number (PIN_LAYOUT_CACHE::GetPinBoundingBox), from what the canvas draws for the pin.
 */
export function pinBox(item: KItem, pin: SymPin): GeomBox {
  let b: GeomBox = [Math.min(pin.x, pin.root[0]), Math.min(pin.y, pin.root[1]), Math.max(pin.x, pin.root[0]), Math.max(pin.y, pin.root[1])];
  const src = pin.hidden ? item.hiddenGeom || [] : item.geom || [];
  for (const g of src) {
    if ((g as { pinNo?: string }).pinNo !== pin.number) continue;
    const gb = geomBoxOf(g); if (!gb) continue;
    b = [Math.min(b[0], gb[0]), Math.min(b[1], gb[1]), Math.max(b[2], gb[2]), Math.max(b[3], gb[3])];
  }
  return b;
}
/**
 * SCH_PIN::HitTest: the pin's box (its line, decoration, shown name and number) inflated by `tol`, with
 * m_PinSymbolSize / 4 as the floor of the accuracy.  Hidden pins count only while hidden pins are shown
 * (SCH_SELECTION_TOOL::Selectable).  Of several pins hit, the one whose box the point is deepest in, then the one
 * whose line is nearest, wins.
 */
export function pinAt(doc: KDoc, p: Pt, tol: number, showHidden?: boolean): PinHit | null {
  let best: PinHit | null = null, bestD = Infinity, bestL = Infinity;
  const acc = Math.max(tol, PIN_SYMBOL_SIZE / 4);
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    if (it.bbox && (p[0] < it.bbox[0] - acc - 5 || p[0] > it.bbox[2] + acc + 5 || p[1] < it.bbox[1] - acc - 5 || p[1] > it.bbox[3] + acc + 5)) continue;
    for (const pin of symbolPins(doc, it)) {
      if (pin.hidden && !showHidden) continue;
      const b = pinBox(it, pin);
      const d = Math.max(b[0] - p[0], p[0] - b[2], b[1] - p[1], p[1] - b[3], 0);
      if (d > acc) continue;
      const l = segDist(p, [pin.x, pin.y], pin.root);
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && l < bestL)) { best = { item: it, pin }; bestD = d; bestL = l; }
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
// SCH_PIN's property rows (sch_pin.cpp, the PIN property registration) as the schematic editor shows them: the
// position, text size and Visible rows are available only in the symbol editor, and the rest are read-only
// outside it (SetWriteableFunc( isSymbolEditor )).  Enum rows carry the file keyword and the ENUM_MAP names.
const PIN_TYPES: [string, string][] = [["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"], ["free", "Free"], ["unspecified", "Unspecified"], ["power_in", "Power input"], ["power_out", "Power output"], ["open_collector", "Open collector"], ["open_emitter", "Open emitter"], ["no_connect", "Unconnected"]];
const PIN_SHAPES: [string, string][] = [["line", "Line"], ["inverted", "Inverted"], ["clock", "Clock"], ["inverted_clock", "Inverted clock"], ["input_low", "Input low"], ["clock_low", "Clock low"], ["output_low", "Output low"], ["edge_clock_high", "Falling edge clock"], ["non_logic", "NonLogic"]];
// PIN_ORIENTATION from the library pin's angle (the parser: 0 PIN_RIGHT, 90 PIN_UP, 180 PIN_LEFT, 270 PIN_DOWN)
const PIN_ORIENTS: [string, string][] = [["0", "Right"], ["180", "Left"], ["90", "Up"], ["270", "Down"]];
export interface PinPropRow { name: string; type: "text" | "enum" | "length"; value: string | number; choices?: [string, string][] }
/** The Properties rows of a selected pin (lengths in mm); null when the pin is gone. */
export function pinProperties(doc: KDoc, ref: PinRef | null | undefined): PinPropRow[] | null {
  const h = pinOf(doc, ref); if (!h) return null;
  const p = h.pin;
  return [
    { name: "Pin Name", type: "text", value: p.name }, { name: "Pin Number", type: "text", value: p.number },
    { name: "Electrical Type", type: "enum", value: p.type, choices: PIN_TYPES }, { name: "Graphic Style", type: "enum", value: p.shape || "line", choices: PIN_SHAPES },
    { name: "Orientation", type: "enum", value: String(p.libRot || 0), choices: PIN_ORIENTS }, { name: "Length", type: "length", value: p.len },
  ];
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
 * its electrical type gives (the assigned alternate's name and type when the pin has one).  The wire and labels become
 * the selection; the no-connects leave nothing selected.  Returns their ids.
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
      const alt = pinAltFunction(doc, h.item, h.pin.number);
      let text = alt ? alt.name : shownName(h.pin);
      if (!text) text = `${sheetRef ? sheetRef(h.item) : (h.item.ref || "")}_${h.pin.number}`;
      node = labelNode(what, text, p, 0);
      setSpinOfNode(what, node, SIDE_SPIN[side] === undefined ? 0 : SIDE_SPIN[side]);
      if (what !== "label") { const sh = kid(node, "shape"); if (sh) sh[1] = labelShapeForPin(alt ? alt.type : h.pin.type); }
    }
    if (!K.uuidOf(node)) node.push(["uuid", K.newUuid()]);
    const { item, change } = addNode(doc, node); changes.push(change); ids.push(item.id);
  }
  if (!changes.length) return [];
  if (what === "wire" && canFollow(ctx)) return wireStubsInFlight(ctx, ids);
  for (const id of ids) doc.items.delete(id);           // commit adds them from the fragments
  ctx.commit(changes, what === "noconnect" ? "No Connect Pins" : what === "wire" ? "Wire Pins" : "Label Pins");
  // ID_POPUP_SCH_PIN_TRICKS_NO_CONNECT ends in ClearSelection(); the Wire and Label helpers select what they added
  if (ctx.setSelection) ctx.setSelection(what === "noconnect" ? [] : ids.filter((id) => doc.items.has(id)));
  else if (what === "noconnect") ctx.setSelected(null);
  ctx.requestRender();
  return ids;
}

/**
 * ID_POPUP_SCH_PIN_TRICKS_WIRE with a pointer: the stubs exist on this client only with their far ends selected
 * (ENDPOINT) and SCH_ACTIONS::drag running at once, so the ends follow the cursor; the click that ends the drag
 * pushes one "Wire Pins" step, Esc (or Ctrl+Z) reverts the commit and leaves nothing behind.  The drag is the
 * Break Wire session's (a BreakJob of local lines whose ends stretch), so a peer's edit puts it back the same way.
 */
function wireStubsInFlight(ctx: SchCtx, ids: string[]): string[] {
  const doc = ctx.doc; if (S.drag) endDrag(ctx, false);
  const brk: BreakJob = { mode: "wirepins", label: "Wire Pins", orig: new Map(), local: new Set(ids), clicks: 0 };
  const anchors: Anchor[] = [];
  for (const id of ids) { const it = doc.items.get(id); if (!it) continue; const q = ptsOf(it.node); anchors.push({ p: q[1], ends: [{ item: it, index: 1, orig: q.map((v) => v.slice() as Pt) }], stub: null, followers: [] }); }
  const p0 = anchors[0].p, c = cursorOf(ctx);
  // KiCad warps the pointer onto the first stub's end; here the ends move with the pointer from where it is
  S.drag = { items: [], item: doc.items.get(ids[0])!, kind: "wire", orig: null, anchor0: p0, grab: [r4(c[0] - p0[0]), r4(c[1] - p0[1])], last: [0, 0], applied: [0, 0], moved: true, byPointer: false,
    riders: [], anchors, preview: [], mode: "wirepins", brk, restoreMode: S.dragMode };
  S.dragMode = "drag"; announceModes(ctx);
  setSelectionIds(ctx, ids);
  ctx.requestRender();
  return ids;
}

// ---------------------------------------------------------------- Pin Function (PIN_FUNCTION_MENU)
/**
 * The instance pin's assigned alternate (SCH_PIN::m_alt) as the library defines it: SCH_PIN::GetShownName returns its
 * name and SCH_PIN::GetType its electrical type.  Null for the base function or an alternate the library lacks.
 */
export function pinAltFunction(doc: KDoc, it: KItem, number: string): { name: string; type: string } | null {
  const ip = kids(it.node, "pin").find((x) => str(x[1]) === number), a = ip && kid(ip, "alternate"); if (!a) return null;
  const want = str(a[1]); if (!want) return null;
  const libId = str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, str((kid(it.node, "lib_id") || [])[1])); if (!lib) return null;
  for (const sub of kids(lib, "symbol")) for (const g of kids(sub, "pin")) {
    if (str((kid(g, "number") || [])[1]) !== number) continue;
    const alt = kids(g, "alternate").find((x) => str(x[1]) === want);
    if (alt) return { name: want, type: str(alt[2]) || "unspecified" };
  }
  return null;
}
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

// ---------------------------------------------------------------- Swap Pin Labels (SCH_EDIT_TOOL::SwapPinLabels)
const NET_LABELS = new Set(["label", "global_label", "hierarchical_label"]);
/** A label text that names a bus (a vector "D[0..7]" or a group "{A B}"): its connection is not a net. */
const isBusName = (t: string) => /\[[^\]]*\.\.[^\]]*\]/.test(t) || /\{[^}]*\}/.test(t);
/**
 * findSingleNetLabelForPin: the one net label (local, global or hierarchical) of the pin's subgraph on this sheet,
 * when that subgraph holds no other pin; else null.
 */
export function singleNetLabelForPin(doc: KDoc, ref: PinRef): KItem | null {
  const h = pinOf(doc, ref); if (!h) return null;
  const { reached } = netWalk(doc, h.item, [h.pin.x, h.pin.y], true);
  let pins = 0; let label: KItem | null = null;
  for (const [, it] of reached) if (it.kind === "symbol") pins++;
  const seen = new Set<string>();
  for (const it of reached.values()) {
    if (seen.has(it.id)) continue; seen.add(it.id);
    if (!NET_LABELS.has(it.kind) || isBusName(str(it.node[1]))) continue;
    if (label) return null;                       // more than one label
    label = it;
  }
  return pins === 1 ? label : null;
}
/**
 * SCH_ACTIONS::swapPinLabels on two or more selected pins, in selection order: each pin's single net label takes the
 * next pin's text (a swap for two, a rotation for more), one "Swap Pin Labels" commit.  Returns the error the
 * infobar shows, or null.
 */
export function swapPinLabels(ctx: SchCtx, pins: PinRef[]): string | null {
  if (pins.length < 2) return null;
  const doc = ctx.doc; const labels: KItem[] = [];
  for (const r of pins) {
    const l = singleNetLabelForPin(doc, r);
    if (!l) return "Each selected pin must have exactly one attached net label and no other pin connections.";
    labels.push(l);
  }
  const text = new Map<string, string>(); for (const l of labels) text.set(l.id, str(l.node[1]));
  for (let i = 0; i < labels.length - 1; i++) {
    const a = labels[i], b = labels[(i + 1) % labels.length];
    const at = text.get(a.id)!, bt = text.get(b.id)!; text.set(a.id, bt); text.set(b.id, at);
  }
  const changes: KChange[] = [];
  for (const l of new Set(labels)) {
    if (text.get(l.id) === str(l.node[1])) continue;
    const n = deep(l.node); n[1] = text.get(l.id)!; changes.push(modChange(doc, l, n));
  }
  if (changes.length) ctx.commit(changes, "Swap Pin Labels");
  ctx.requestRender();
  return null;
}
