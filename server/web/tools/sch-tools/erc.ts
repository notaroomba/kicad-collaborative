import type { SchCtx, Pt, ErcMarker } from "./types";
import { type SymPin, symbolIsPower, symbolPins } from "./autoplace";
import { ellipsizeMenuText, itemDescription } from "./msgpanel";
import { editable, selectedItems } from "./commands";
import { lineEndsAt, lineMidsAt, pinsAt } from "./connect";
import { LABEL_KINDS, busEntriesAt, isNetLine, labelsAt, noConnectsAt, sheetPinsAt } from "./drag";
import { conducts, joins, terminalsOf } from "./highlight";
import { sheetPinNode } from "./nodes";
import { baseName } from "./sheets";
import { K, S, atOf, kid, kids, num, ptsOf, str } from "./state";
import { deep, modChange, onSegMid, r4, segs } from "./util";

// ---------------------------------------------------------------- ERC (eeschema/erc/erc.cpp subset)
export const PIN_TYPES = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"];
export const PIN_TYPE_TEXT: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
// ERC_SETTINGS::m_defaultPinMap: 0 ok, 1 warning, 2 error
export const PIN_MATRIX = [
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2], [0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
  [0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2], [0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]];
export const DRIVING = new Set(["output", "power_out", "passive", "tri_state", "bidirectional"]), DRIVEN = new Set(["input", "power_in"]);
export const pinTypeIndex = (t: string) => { const i = PIN_TYPES.indexOf(t); return i < 0 ? 6 : i; };
/** ERC_SETTINGS m_PinTypeWeights (SM_HEURISTICS, the default sorting metric of pin conflicts). */
export const PIN_TYPE_WEIGHT: Record<string, number> = { free: 11, unspecified: 10, passive: 9, open_collector: 8, open_emitter: 7, input: 6, tri_state: 5, bidirectional: 4, output: 3, power_in: 2, power_out: 1, no_connect: 0 };
/** PIN_ERROR of a pin map entry (OK 0, WARNING 1, PP_ERROR 2, UNCONNECTED 3); anything else reads as OK, as ERC_SETTINGS' loader skips it. */
export function pinErrorAt(map: number[][], a: string, b: string): number {
  const row = Array.isArray(map) ? map[pinTypeIndex(a)] : null, v = Array.isArray(row) ? row[pinTypeIndex(b)] : 0;
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : PIN_MATRIX[pinTypeIndex(a)][pinTypeIndex(b)];
}
/** ercErrorCode: only PIN_ERROR::WARNING is a warning, every other non-OK value is ERCE_PIN_TO_PIN_ERROR. */
export const pinErrorSeverity = (e: number): "error" | "warning" => (e === 1 ? "warning" : "error");
/** SCH_PIN::IsStacked: pins of one symbol at one position with one name, of the same type or one of them passive / free. */
export function stackedPins(a: { item: KItem; p: Pt; pin: SymPin }, b: { item: KItem; p: Pt; pin: SymPin }): boolean {
  const loose = (t: string) => t === "passive" || t === "free";
  return a.item === b.item && ptKey(a.p) === ptKey(b.p) && a.pin.name === b.pin.name && (a.pin.type === b.pin.type || loose(a.pin.type) || loose(b.pin.type));
}
/** StrNumCmp (case sensitive): runs of digits compare as numbers. */
export function strNumCmp(a: string, b: string): number {
  let i = 0, j = 0; const digit = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (digit(c1) && digit(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && digit(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && digit(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
export const ptKey = (p: Pt) => r4(p[0]) + "," + r4(p[1]);
/** A terminal of an ERC net: a symbol pin, a sheet pin or an item's connection point; attached once it touches another. */
export interface ErcTerm { item: KItem; p: Pt; net: string; key?: string; pin?: SymPin; power?: boolean; sheetPin?: string; attached?: boolean }
/** An ERC net: its terminals and the ids of the items they belong to. */
export interface ErcNet { terms: ErcTerm[]; ids: Set<string> }
/** ercCheck's options: the project's Pin Conflicts Map, the sub-sheet docs, the parent sheet's pin names, and the ERC dialog's 'Show all errors' (ERC_TESTER's m_showAllErrors). */
export interface ErcOpts { pinMap?: number[][]; sheetDocs?: SheetDocs | null; parentPins?: Iterable<string> | null; showAllErrors?: boolean }
/** ctx.sheetDocs: Sheetfile (or docId / path) -> parsed doc or its text. */
export type SheetDocs = NonNullable<SchCtx["sheetDocs"]>;
// Every terminal on the sheet joined into nets (the rules of netItems, evaluated once with union-find).
export function ercNets(doc: KDoc) {
  const terms: ErcTerm[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") {
      const power = symbolIsPower(doc, it), value = kids(it.node, "property").find((p) => str(p[1]) === "Value");
      for (const pin of symbolPins(doc, it)) {
        let key: string | undefined; if (power && value && pin.type === "power_in") key = "global:" + str(value[2]); else if (pin.hidden && pin.type === "power_in") key = "global:" + pin.name;
        terms.push({ item: it, p: [pin.x, pin.y], net: "wire", key, pin, power });
      }
    } else if (it.kind === "sheet") { for (const pin of kids(it.node, "pin")) terms.push({ item: it, p: atOf(pin).slice(0, 2).map(r4), net: "any", sheetPin: str(pin[1]) }); }
    else for (const t of terminalsOf(doc, it)) terms.push(Object.assign({ item: it }, t));
  }
  const parent = terms.map((_, i) => i);
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const byItem = new Map<KItem, number[]>(), byPoint = new Map<string, number[]>(), byKey = new Map<string, number[]>(), touch = terms.map(() => false);
  terms.forEach((t, i) => {
    if (!byItem.has(t.item)) byItem.set(t.item, []); byItem.get(t.item)!.push(i);
    const pk = ptKey(t.p); if (!byPoint.has(pk)) byPoint.set(pk, []); byPoint.get(pk)!.push(i);
    if (t.key) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key)!.push(i); }
  });
  for (const [it, idx] of byItem) if (conducts(it)) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  for (const idx of byPoint.values()) for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) if (terms[idx[a]].item !== terms[idx[b]].item && joins(terms[idx[a]], terms[idx[b]])) { union(idx[a], idx[b]); touch[idx[a]] = touch[idx[b]] = true; }
  for (const [it, idx] of byItem) {
    if (!isNetLine(it.kind)) continue;
    const sg = segs(it), lineT = { net: it.kind };
    terms.forEach((u, i) => { if (u.item === it || !joins(lineT, u)) return; if (sg.some(([a, b]) => onSegMid(u.p, a, b))) { union(idx[0], i); touch[i] = true; } });
  }
  for (const idx of byKey.values()) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  const nets = new Map<number, ErcNet>();
  terms.forEach((t, i) => { const r = find(i); if (!nets.has(r)) nets.set(r, { terms: [], ids: new Set() }); const n = nets.get(r)!; n.terms.push(t); n.ids.add(t.item.id); t.attached = touch[i]; });
  return { terms, nets: Array.from(nets.values()) };
}
// A no-connect flag at p, a sheet pin at p, any net line end / middle at p.
export function noConnectAt(doc: KDoc, p: Pt) { return noConnectsAt(doc, p).length > 0; }
/** The item lines of an ERC report (RC_ITEM::ShowReport): an item's own position and its GetItemDescription;
 *  `len` (mm) is a length the report prints in its units where the text has "%L". */
export interface ErcItemRef { x: number; y: number; desc: string; len?: number }
const PIN_SHAPE_TEXT: Record<string, string> = { line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low", clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic" };
const unesc = (t: string): string => { const u = (K as unknown as { unescapeText?(s: string): string }).unescapeText; return u ? u(t) : t; };
/** SCH_PIN::GetItemDescription of a placed symbol's pin: "Symbol U1 Pin 3 [IN+, Input, Line]". */
export function pinItemRef(t: ErcTerm & { pin: SymPin }): ErcItemRef {
  const name = t.pin.name && t.pin.name !== "~" ? unesc(t.pin.name) : "", type = PIN_TYPE_TEXT[t.pin.type] || "Unspecified", shape = PIN_SHAPE_TEXT[t.pin.shape || "line"] || "Line";
  const what = `${t.pin.hidden ? "Hidden pin" : "Pin"} ${t.pin.number} [${name ? name + ", " : ""}${type}, ${shape}]`;
  return { x: r4(t.p[0]), y: r4(t.p[1]), desc: `Symbol ${t.item.ref || "?"} ${what}` };
}
/** An item's GetPosition and GetItemDescription (msgpanel.ts's itemDescription); a wire's or line's length is left as "%L" for the report's units. */
export function itemRef(doc: KDoc, it: KItem): ErcItemRef {
  const n = it.node, at = atOf(n), pts = it.kind === "wire" || it.kind === "bus" || it.kind === "polyline" ? ptsOf(n) : [];
  if (pts.length === 2) {
    const [a, b] = pts, what = it.kind === "wire" ? "Wire" : it.kind === "bus" ? "Bus" : "Graphic Line";
    const dir = a[0] === b[0] ? "Vertical " : a[1] === b[1] ? "Horizontal " : "";
    return { x: a[0], y: a[1], desc: `${dir}${what}, length %L`, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  }
  const p = pts[0] || at;
  return { x: p[0], y: p[1], desc: itemDescription(doc, it.id, "mm") || it.kind };
}
export function pinLabel(t: ErcTerm & { pin: SymPin }) { return `${t.item.ref || "?"} pin ${t.pin.number}${t.pin.name && t.pin.name !== "~" ? " (" + t.pin.name + ")" : ""}`; }
export function ercCheck(doc: KDoc, opts?: ErcOpts | null) {
  opts = opts || {};
  // refs: the main and aux items of ShowReport (default: the first two of ids, as items of this sheet)
  const markers: ErcMarker[] = [], mark = (code: string, severity: string, p: Pt, text: string, ids: Iterable<string>, refs?: ErcItemRef[], extra?: Record<string, unknown>) => {
    const idl = Array.from(new Set(ids || []));
    const items = refs || idl.slice(0, 2).map((id) => doc.items.get(id)).filter((x): x is KItem => !!x).map((x) => itemRef(doc, x));
    markers.push(Object.assign({ code, severity, x: r4(p[0]), y: r4(p[1]), text, ids: idl, items }, extra || {}));
  };
  const { nets } = ercNets(doc);
  // symbols: annotation and duplicate references
  const byRef = new Map<string, KItem>();
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const ref = it.ref || "", [x, y] = atOf(it.node);
    if (!ref || /\?$/.test(ref)) { mark("unannotated", "error", [x, y], `Symbol ${ref || "(no reference)"} is not annotated`, [it.id]); continue; }
    const unit = kid(it.node, "unit") ? num(kid(it.node, "unit")![1], 1) : 1, k = ref + "#" + unit;
    if (byRef.has(k)) mark("duplicate_reference", "error", [x, y], `Duplicate reference designators ${ref}`, [it.id, byRef.get(k)!.id]); else byRef.set(k, it);
  }
  // nets: pins, drivers, labels
  for (const net of nets) {
    const pins = net.terms.filter((t): t is ErcTerm & { pin: SymPin } => !!t.pin), labels = net.terms.filter((t) => LABEL_KINDS.has(t.item.kind));
    const leaves = net.terms.some((t) => t.sheetPin || t.item.kind === "hierarchical_label" || t.item.kind === "global_label" || t.power || (t.pin && t.key));
    for (const t of pins) {
      if (t.pin.hidden || t.pin.type === "no_connect" || t.key) continue;
      if (!t.attached && !noConnectAt(doc, t.p)) mark("pin_not_connected", "error", t.p, `Pin not connected: ${pinLabel(t)}`, [t.item.id], [pinItemRef(t)]);
      if (t.pin.type === "no_connect" || (noConnectAt(doc, t.p) && net.terms.some((u) => u !== t && u.item !== t.item)))
        mark("no_connect_connected", "warning", t.p, `A pin with a "no connection" flag is connected: ${pinLabel(t)}`, [t.item.id], [pinItemRef(t)]);
    }
    // TestPinToPin: every pin of the net, sorted by reference then pin number (StrNumCmp)
    const all = pins.slice().sort((a, b) => strNumCmp(a.item.ref || "", b.item.ref || "") || strNumCmp(a.pin.number, b.pin.number));
    const isPower = all.some((t) => t.pin.type === "power_in"), pinMap = opts.pinMap || PIN_MATRIX;
    let hasDriver = false, needs: (typeof pins)[number] | null = null;
    const needAll: (typeof pins)[number][] = [], mismatches: [number, number, number][] = [], weight = new Map<number, number>();
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (DRIVEN.has(a.pin.type)) {
        // needsDriver is the pin the report shows: upgraded to a visible one, and to a power input on a power net
        needAll.push(a);
        if (!needs || (needs.pin.hidden && !a.pin.hidden) || (isPower !== (needs.pin.type === "power_in") && isPower === (a.pin.type === "power_in"))) needs = a;
      }
      if (isPower ? a.pin.type === "power_out" : DRIVING.has(a.pin.type)) hasDriver = true;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (stackedPins(a, b)) continue;   // SCH_PIN::IsStacked on the same sheet
        const e = pinErrorAt(pinMap, a.pin.type, b.pin.type);
        if (!e) continue;
        mismatches.push([i, j, e]);
        // ERC_PIN_SORTING_METRIC::SM_HEURISTICS: the count is the pin type's weight
        weight.set(i, PIN_TYPE_WEIGHT[a.pin.type] ?? 10); weight.set(j, PIN_TYPE_WEIGHT[b.pin.type] ?? 10);
      }
    }
    // pins_dsc: heaviest first (ties keep the sorted order); each pin takes its nearest conflicting pin and the
    // pairs it was part of are used up
    const order = Array.from(weight.entries()).sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    for (const [pi] of order) {
      if (!mismatches.length) break;
      const a = all[pi]; let near = -1, best = Infinity, err = 0;
      for (let k = mismatches.length - 1; k >= 0; k--) {
        const [i, j, e] = mismatches[k]; const other = i === pi ? j : j === pi ? i : -1; if (other < 0) continue;
        mismatches.splice(k, 1);
        const d = Math.hypot(all[other].p[0] - a.p[0], all[other].p[1] - a.p[1]);
        if (d < best || (d === best && other < near)) { best = d; near = other; err = e; }
      }
      if (near < 0) continue;
      const b = all[near];
      mark("pin_to_pin", pinErrorSeverity(err), a.p, `Pins of type ${PIN_TYPE_TEXT[a.pin.type]} and ${PIN_TYPE_TEXT[b.pin.type]} are connected: ${pinLabel(a)} and ${pinLabel(b)}`, [a.item.id, b.item.id], [pinItemRef(a), pinItemRef(b)]);
    }
    if (needs && !hasDriver && all.length > 1 && !net.terms.some((t) => t.pin && noConnectAt(doc, t.p))) {
      const leavesSheet = net.terms.some((t) => t.sheetPin || t.item.kind === "hierarchical_label");
      // TestPinToPin: one marker on the chosen pin, or with Show all errors one on every pin that needs a driver
      // (the power inputs on a power net, else the pins not on power symbols, else all of them)
      const powerIns = needAll.filter((t) => t.pin.type === "power_in"), nonPower = needAll.filter((t) => !t.power);
      const flagged = !opts.showAllErrors ? [isPower && powerIns.length ? powerIns[0] : needs] : isPower && powerIns.length ? powerIns : nonPower.length ? nonPower : needAll;
      if (!leavesSheet) for (const t of flagged) mark(isPower ? "power_pin_not_driven" : "pin_not_driven", leaves ? "warning" : "error", t.p,
        (isPower ? "Input Power pin not driven by any Output Power pins" : "Input pin not driven by any Output pins") + ": " + pinLabel(t) + (leaves ? " (no driver on this sheet)" : ""), [t.item.id], [pinItemRef(t)]);
    }
    for (const t of labels) {
      if (t.item.kind === "netclass_flag" || t.item.kind === "directive_label") continue;
      const text = str(t.item.node[1]);
      if (!text.trim()) mark("empty_label_name", "error", t.p, "Label has an empty name", [t.item.id]);
      if (!t.attached) mark("label_dangling", "error", t.p, `Label not connected: ${text}`, [t.item.id]);
      else if (t.item.kind === "label" && pins.length === 1 && labels.length === 1 && !leaves) mark("isolated_pin_label", "warning", t.p, `Label connected to only one pin: ${text}`, [t.item.id]);
      const wires = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "wire" && (K.wireEndsAt(doc, t.p[0], t.p[1], 1e-3).some((e) => e.item === it) || segs(it).some(([a, b]) => onSegMid(t.p, a, b)))) wires.add(it.id);
      if (wires.size > 1) mark("label_multiple_wires", "warning", t.p, `Label connects more than one wire: ${text}`, [t.item.id, ...wires]);
    }
  }
  // wires: dangling ends
  for (const it of doc.items.values()) {
    if (!isNetLine(it.kind)) continue;
    const pts = ptsOf(it.node); if (pts.length < 2) continue;
    const loose = [pts[0], pts[pts.length - 1]].filter((p) => {
      if (K.wireEndsAt(doc, p[0], p[1], 1e-3).some((e) => e.item !== it)) return false;
      if (lineMidsAt(doc, p[0], p[1], "wire").length || lineMidsAt(doc, p[0], p[1], "bus").length) return false;
      if (it.kind === "wire" && pinsAt(doc, p[0], p[1]).length) return false;
      return !labelsAt(doc, p).length && !sheetPinsAt(doc, p).length && !busEntriesAt(doc, p).length && !noConnectsAt(doc, p).length;
    });
    if (loose.length === 2) mark("wire_dangling", "error", [(pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2], "Wires not connected to anything", [it.id]);
    else for (const p of loose) mark("unconnected_wire_endpoint", "warning", p, "Unconnected wire endpoint", [it.id]);
  }
  // no-connect flags on nothing, four-way junctions
  for (const it of doc.items.values()) {
    if (it.kind === "no_connect") { const [x, y] = atOf(it.node); if (!pinsAt(doc, x, y).length && !K.wireEndsAt(doc, x, y, 1e-3).length) mark("no_connect_dangling", "warning", [x, y], 'Unconnected "no connection" flag', [it.id]); }
    if (it.kind === "junction") { const [x, y] = atOf(it.node); if (lineEndsAt(doc, x, y, "wire").length >= 4) mark("four_way_junction", "warning", [x, y], "Four connection points are joined together", [it.id]); }
  }
  // similar labels (case-insensitive twins)
  const names = new Map<string, Map<string, KItem>>();
  for (const it of doc.items.values()) if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") { const t = str(it.node[1]); const k = t.toLowerCase(); if (!names.has(k)) names.set(k, new Map()); names.get(k)!.set(t, it); }
  for (const m of names.values()) if (m.size > 1) { const its = Array.from(m.values()); mark("similar_labels", "warning", atOf(its[0].node), `Labels are similar: ${Array.from(m.keys()).join(", ")}`, its.map((x) => x.id)); }
  // sheet pins vs the sub-sheet's hierarchical labels (when the sub-sheet document is known)
  const sheetDocs = opts.sheetDocs || null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const sub = sheetDocs ? subsheetDoc(sheetDocs, it) : null;
    const pinNames = new Map<string, SNode>(); for (const pin of kids(it.node, "pin")) pinNames.set(str(pin[1]), pin);
    if (sub) {
      const hier = new Set<string>(); for (const o of sub.items.values()) if (o.kind === "hierarchical_label") hier.add(str(o.node[1]));
      for (const [name, pin] of pinNames) if (!hier.has(name)) { const pp = atOf(pin); mark("hier_label_mismatch", "error", pp, `Sheet pin ${name} has no matching hierarchical label in ${it.file || "the sheet"}`, [it.id], [{ x: pp[0], y: pp[1], desc: `Hierarchical Sheet Pin '${ellipsizeMenuText(name)}'` }]); }
      const [x, y] = atOf(it.node);
      // the main item is the label on the sub-sheet: the report lists it under that sheet (mainFile)
      for (const name of hier) if (!pinNames.has(name)) { const lab = Array.from(sub.items.values()).find((o) => o.kind === "hierarchical_label" && str(o.node[1]) === name); mark("hier_label_mismatch", "error", [x, y], `Hierarchical label ${name} in ${it.file || "the sheet"} has no sheet pin`, [it.id], lab ? [itemRef(sub, lab)] : undefined, lab ? { mainFile: it.file, mainSheet: it.id } : undefined); }
    }
  }
  if (opts.parentPins) { const pp = new Set(opts.parentPins); for (const it of doc.items.values()) if (it.kind === "hierarchical_label" && !pp.has(str(it.node[1]))) mark("hier_label_mismatch", "error", atOf(it.node), `Hierarchical label ${str(it.node[1])} has no sheet pin on the parent sheet`, [it.id]); }
  markers.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.y - b.y || a.x - b.x);
  return markers;
}
// ctx.sheetDocs: a Map or object of Sheetfile (or docId / path) -> parsed doc or its text.
export function subsheetDoc(sheetDocs: SheetDocs, sheet: KItem): KDoc | null {
  // a Map, or a plain object that may itself have a "get" / "set" key: the original tests for the methods
  const asMap = sheetDocs as Partial<Map<string, KDoc | string>>, asObj = sheetDocs as Record<string, KDoc | string>;
  const get = (k: string) => (typeof asMap.get === "function" ? asMap.get(k) : asObj[k]);
  const file = sheet.file || str((kids(sheet.node, "property").find((p) => str(p[1]) === "Sheetfile") || [])[2]);
  let d = get(file) || get(baseName(file)) || get(sheet.id); if (!d) return null;
  if (typeof d === "string") { try { d = K.parseDoc(d); } catch (e) { return null; } if (typeof asMap.set === "function") asMap.set(file, d); }
  return d && d.items ? d : null;
}
export function runERC(ctx: SchCtx, opts?: ErcOpts | null) {
  const markers = ercCheck(ctx.doc, Object.assign({ sheetDocs: ctx.sheetDocs, parentPins: ctx.parentSheetPins }, opts || {}));
  S.markers = markers; S.markersDoc = ctx.doc;
  if (typeof ctx.setMarkers === "function") ctx.setMarkers(markers);
  const errors = markers.filter((m) => m.severity === "error").length;
  ctx.toast(markers.length ? `ERC: ${errors} error${errors === 1 ? "" : "s"}, ${markers.length - errors} warning${markers.length - errors === 1 ? "" : "s"}` : "ERC: no problems found");
  ctx.requestRender(); return true;
}
// Sheet pins the sub-sheet's hierarchical labels ask for (syncSheetPins); cleanupSheetPins removes the orphans.
export function syncSheetPins(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes: KChange[] = []; let added = 0;
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    const have = new Set<string>(kids(it.node, "pin").map((p) => str(p[1]))); const node = deep(it.node);
    const [x, y] = atOf(node), s = kid(node, "size"), h = num(s && s[2]); let row = 0;
    for (const o of sub.items.values()) {
      if (o.kind !== "hierarchical_label" || have.has(str(o.node[1]))) continue;
      const py = Math.min(y + h, r4(y + 1.27 * (++row)));
      const pin = sheetPinNode(str(o.node[1]), [x, py], "left"); const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
      have.add(str(o.node[1])); added++;
    }
    if (added) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "sync sheet pins"); return true;
}
/**
 * GetUnplacedSheetPinLabels + AutoPlaceSheetPins (sch_tool_utils.cpp), for Autoplace All Sheet Pins: the sub-sheet's
 * hierarchical labels with no pin yet, outputs down the right edge and the rest down the left, each column sorted by
 * name and stacked below the pins already on that edge at a grid-snapped pitch; the sheet grows when they would run
 * past its bottom.  Returns the new sheet node, or null when no label is unplaced.
 */
export function autoPlaceSheetPinsNode(sheetNode: SNode, sub: KDoc, textSize = 1.27): SNode | null {
  const names = new Set<string>(kids(sheetNode, "pin").map((p) => str(p[1])));
  const labels: { name: string; shape: string }[] = [];
  for (const o of sub.items.values()) if (o.kind === "hierarchical_label") { const n = str(o.node[1]); if (!names.has(n)) { names.add(n); const sh = kid(o.node, "shape"); labels.push({ name: n, shape: sh ? str(sh[1]) : "input" }); } }
  if (!labels.length) return null;
  const IU = 1e4, iu = (mm: number) => Math.round(mm * IU), mm = (v: number) => r4(v / IU);
  const grid = iu(1.27), ts = iu(textSize);
  let pitch = Math.max(Math.round(ts * 2), iu(2.54)); pitch = Math.round(pitch / grid) * grid;
  const margin = pitch, node = deep(sheetNode), [x, y] = atOf(node), size = kid(node, "size")!;
  const leftX = iu(x), rightX = iu(x) + iu(num(size[1])), topY = iu(y), h0 = iu(num(size[2]));
  let leftY = topY + margin - pitch, rightY = leftY;
  for (const p of kids(node, "pin")) { const a = kid(p, "at"); if (!a) continue; const r = ((Math.round(num(a[3]) || 0) % 360) + 360) % 360, py = iu(num(a[2])); if (r === 0) rightY = Math.max(rightY, py); else if (r === 180) leftY = Math.max(leftY, py); }
  const byText = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const right = labels.filter((l) => l.shape === "output").sort(byText), left = labels.filter((l) => l.shape !== "output").sort(byText);
  const needBot = Math.max(leftY + left.length * pitch, rightY + right.length * pitch) + margin;
  if (needBot > topY + h0) {
    // SCH_SHEET::Resize re-runs AutoplaceFields only when the fields are autoplaced: those below the sheet then follow
    // its bottom edge; fields placed by hand stay where they are
    const dh = needBot - topY - h0; size[2] = mm(needBot - topY);
    const ap = kid(node, "fields_autoplaced"), auto = !!ap && str(ap[1]) !== "no";
    if (auto) for (const f of kids(node, "property")) { const fa = kid(f, "at"); if (fa && iu(num(fa[2])) >= topY + h0) fa[2] = mm(iu(num(fa[2])) + dh); }
    for (const p of kids(node, "pin")) { const a = kid(p, "at"); if (a && iu(num(a[2])) === topY + h0 && (Math.round(num(a[3]) || 0) % 360 + 360) % 360 === 270) a[2] = mm(needBot); }
  }
  const column = (col: { name: string; shape: string }[], px: number, start: number, side: string) => {
    let py = Math.round(start / grid) * grid;
    // pin->SetTextSize( m_DefaultTextSize )
    for (const l of col) { py += pitch; const pin = sheetPinNode(l.name, [mm(px), mm(py)], side, textSize); pin[2] = l.shape; const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin); }
  };
  column(left, leftX, leftY, "left"); column(right, rightX, rightY, "right");
  return node;
}
export function cleanupSheetPins(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes: KChange[] = [];
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    const hier = new Set<string>(); for (const o of sub.items.values()) if (o.kind === "hierarchical_label") hier.add(str(o.node[1]));
    const node = deep(it.node); const before = kids(node, "pin").length;
    for (let i = node.length - 1; i > 0; i--) { const c = node[i]; if (Array.isArray(c) && c[0] === "pin" && !hier.has(str(c[1]))) node.splice(i, 1); }
    if (kids(node, "pin").length !== before) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "cleanup sheet pins"); return true;
}
