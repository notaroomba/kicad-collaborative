import type { SAtom, SchCtx } from "./types";
import { root } from "../root";
import { symbolLibId } from "./autoplace";
import { refField, setReference, unannotated } from "./clipboard";
import { editable, selectedItems } from "./commands";
import { promptImpl } from "./dom";
import { switchTool } from "./junction";
import { fontNode } from "./nodes";
import { anchorOf, cloneNode } from "./orient";
import { K, S, atOf, kid, kids, num, str } from "./state";
import { deep, ghost, modChange, replaceKid } from "./util";

// ---------------------------------------------------------------- annotation (sch_reference_list.cpp Annotate / sortByXPosition)
export function splitRef(ref: SAtom) {
  ref = str(ref); if (!ref) return { prefix: "U", num: -1, isNew: true };
  if (/\?$/.test(ref)) return { prefix: ref.slice(0, -1), num: -1, isNew: true };
  const m = ref.match(/^(.*?)(\d+)$/); if (!m) return { prefix: ref, num: -1, isNew: true };
  return { prefix: m[1], num: +m[2], isNew: false };
}
// opts: { order: "x" | "y", keep: true (incremental) | false (renumber everything), start: 0, sheetInterval: 0 | 100 | 1000, sheetNumber: 1, only: Set of ids,
//         reserved: references in use on the project's other sheets (KiCad annotates against the whole hierarchy's reference list) }
/** Annotation options (see annotateChanges). */
export interface AnnotateOpts { order?: string; keep?: boolean; start?: number; sheetInterval?: number; sheetNumber?: number; only?: Set<string> | null; reserved?: Iterable<string> }
/** A symbol's reference as the annotation sees it. */
interface RefEntry { item: KItem; prefix: string; num: number; isNew: boolean; old: string; x: number; y: number; unit: number }
/** Who holds a reference number: the library symbol, its value and the unit (-1: another sheet). */
interface RefHolder { lib: string | null; value: string | null; unit: number }
export function annotateChanges(doc: KDoc, opts?: AnnotateOpts | null) {
  opts = opts || {};
  const order = opts.order === "y" ? "y" : "x", keep = opts.keep !== false, start = opts.start! | 0, interval = opts.sheetInterval! | 0, sheetNum = opts.sheetNumber || 1;
  const refs: RefEntry[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const p = refField(it.node); if (!p) continue;
    const r = splitRef(p[2]); const [x, y] = atOf(it.node); const unitN = kid(it.node, "unit");
    refs.push({ item: it, prefix: r.prefix, num: r.num, isNew: (r.isNew || !keep) && (!opts!.only || opts!.only.has(it.id)), old: str(p[2]), x, y, unit: unitN ? num(unitN[1], 1) : 1 });
  }
  refs.sort((a, b) => a.prefix.localeCompare(b.prefix) || (order === "x" ? (a.x - b.x || a.y - b.y) : (a.y - b.y || a.x - b.x)) || (a.item.id < b.item.id ? -1 : 1));
  // prefix -> number -> the units holding it ({lib, value, unit}), like FindFirstUnusedReference's refNumberMap
  const used = new Map<string, Map<number, RefHolder[]>>();
  const valueOf = (node: SNode) => { const p = kids(node, "property").find((q) => str(q[1]) === "Value"); return p ? str(p[2]) : ""; };
  const holder = (r: RefEntry): RefHolder => ({ lib: symbolLibId(r.item.node), value: valueOf(r.item.node), unit: r.unit });
  const put = (prefix: string, n: number, h: RefHolder) => { if (!used.has(prefix)) used.set(prefix, new Map()); const m = used.get(prefix)!; if (!m.has(n)) m.set(n, []); m.get(n)!.push(h); };
  const take = (r: RefEntry, n: number) => put(r.prefix, n, holder(r));
  for (const r of refs) if (!r.isNew && r.num >= 0) take(r, r.num);
  // references held on other sheets: taken outright (no library / value to share a package with)
  for (const ref of opts.reserved || []) { const r = splitRef(ref); if (!r.isNew) put(r.prefix, r.num, { lib: null, value: null, unit: -1 }); }
  const minRef = interval ? sheetNum * interval + 1 : start + 1;
  // REFDES_TRACKER::GetNextRefDesForUnits: a free number, or for a unit of a multi-unit symbol one whose holders
  // are the same library symbol with the same value and leave this unit free
  const firstFree = (r: RefEntry, multi: boolean) => {
    const m = used.get(r.prefix), me = holder(r);
    for (let n = minRef; ; n++) {
      const hs = m && m.get(n);
      if (!hs || !hs.length) return n;
      if (multi && hs.every((h) => h.lib === me.lib && h.value === me.value && h.unit !== me.unit)) return n;
    }
  };
  const assigned = new Map<string, number>();   // old full reference of a multi-unit package -> its new number
  const changes: KChange[] = [];
  for (const r of refs) {
    if (!r.isNew) continue;
    let n: number;
    const multi = libUnits(doc, r.item.node).units > 1;
    // units of one multi-unit package (same old reference) stay together, like KiCad's locked-unit map
    const packageKey = multi && r.old && !/\?$/.test(r.old) ? r.prefix + ":" + r.old : null;
    if (packageKey && assigned.has(packageKey)) n = assigned.get(packageKey)!;
    else { n = packageKey ? firstFree(r, false) : firstFree(r, multi); if (packageKey) assigned.set(packageKey, n); }
    take(r, n);
    const ref = r.prefix + n; if (ref === r.old) continue;
    const node = deep(r.item.node); setReference(node, ref); changes.push(modChange(doc, r.item, node));
  }
  return changes;
}
export function clearAnnotationChanges(doc: KDoc, only?: Set<string> | null) {
  const changes: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" || (only && !only.has(it.id))) continue;
    const p = refField(it.node); if (!p || /\?$/.test(str(p[2]))) continue;
    const node = deep(it.node); setReference(node, unannotated(str(p[2]))); changes.push(modChange(doc, it, node));
  }
  return changes;
}
export function annotate(ctx: SchCtx, opts?: AnnotateOpts | null) {
  if (!editable(ctx)) return false;
  const changes = annotateChanges(ctx.doc, Object.assign({ sheetNumber: ctx.pageNumber }, opts || {}));
  if (!changes.length) { ctx.toast("Nothing to annotate"); return true; }
  ctx.commit(changes, "annotate"); ctx.toast(`Annotated ${changes.length} symbol${changes.length === 1 ? "" : "s"}`); return true;
}
export function clearAnnotation(ctx: SchCtx, opts?: { only?: Set<string> | null } | null) {
  if (!editable(ctx)) return false;
  const changes = clearAnnotationChanges(ctx.doc, opts && opts.only);
  if (!changes.length) return true;
  ctx.commit(changes, "clear annotation"); return true;
}
export function editFieldPrompt(ctx: SchCtx, name: string, title: string, quiet: boolean) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const p = kids(it.node, "property").find((q) => str(q[1]) === name); const cur = p ? str(p[2]) : "";
  // SCH_EDIT_TOOL::editFieldText: DIALOG_FIELD_PROPERTIES ("Edit Reference Designator Field", …)
  if (p && root.KDialogs && root.KDialogs.schFieldDialog && root.KDialogs.schFieldDialog(ctx, it, name)) return true;
  promptImpl(title, cur, S.cursorClient, (text) => {
    if (text === null || text === undefined || text === cur) return;
    const node = deep(it.node);
    if (name === "Reference") setReference(node, text);
    else { let q = kids(node, "property").find((z) => str(z[1]) === name); if (!q) { q = ["property" as SAtom, name, "", ["at", ...atOf(node).slice(0, 2), 0], ["hide", "yes"], ["effects", fontNode(1.27)]]; insertField(node, q); } q[2] = text; }
    ctx.commit([modChange(ctx.doc, it, node)], name.toLowerCase());
  });
  return true;
}
export function insertField(node: SNode, p: SNode) { const at = node.findIndex((c) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances")); if (at >= 0) node.splice(at, 0, p); else node.push(p); }
export const FLAG_KEYS: Record<string, string[]> = { setDNP: ["dnp", "yes", "no"], setExcludeFromBOM: ["in_bom", "no", "yes"], setExcludeFromSim: ["exclude_from_sim", "yes", "no"], setExcludeFromBoard: ["on_board", "no", "yes"] };
export function toggleSymbolFlag(ctx: SchCtx, which: string) {
  if (!editable(ctx)) return false;
  const [key, onVal, offVal] = FLAG_KEYS[which], changes: KChange[] = [];
  const items = selectedItems(ctx).filter((it) => it.kind === "symbol"); if (!items.length) return false;
  const allOn = items.every((it) => { const k = kid(it.node, key); return k && str(k[1]) === onVal; });
  for (const it of items) { const node = deep(it.node); replaceKid(node, [key, allOn ? offVal : onVal]); changes.push(modChange(ctx.doc, it, node)); }
  ctx.commit(changes, which.replace(/^set/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()); return true;
}
export function libUnits(doc: KDoc, node: SNode) {
  const lib = K.resolveLib(doc, symbolLibId(node)); const units = new Set<number>(), styles = new Set<number>();
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m) { if (+m[1] > 0) units.add(+m[1]); styles.add(+m[2]); } }
  return { units: Math.max(1, ...units), styles: Math.max(1, ...styles) };
}
export function stepUnit(ctx: SchCtx, dir: number) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("Symbol has a single unit"); return false; }
  const cur = kid(it.node, "unit") ? num(kid(it.node, "unit")![1], 1) : 1, next = ((cur - 1 + dir + units) % units) + 1;
  const node = deep(it.node); replaceKid(node, ["unit", next]);
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const u = kid(pa, "unit"); if (u) u[1] = next; }
  ctx.commit([modChange(ctx.doc, it, node)], "unit"); return true;
}
export function cycleBodyStyle(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { styles } = libUnits(ctx.doc, it.node); if (styles < 2) { ctx.toast("Symbol has no alternate body style"); return false; }
  const cur = kid(it.node, "body_style") ? num(kid(it.node, "body_style")![1], 1) : 1;
  const node = deep(it.node); replaceKid(node, ["body_style", (cur % styles) + 1]);
  ctx.commit([modChange(ctx.doc, it, node)], "body style"); return true;
}
export function placeNextUnit(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("Symbol has a single unit"); return false; }
  const inUse = new Set<number>(); for (const o of ctx.doc.items.values()) if (o.kind === "symbol" && o.ref === it.ref) inUse.add(kid(o.node, "unit") ? num(kid(o.node, "unit")![1], 1) : 1);
  let next = 1; while (inUse.has(next) && next <= units) next++;
  if (next > units) { ctx.toast("All units of " + it.ref + " are placed"); return false; }
  const node = cloneNode(it); replaceKid(node, ["unit", next]);
  S.carry = { kind: "symbol", node, item: ghost(ctx.doc, node), pos: anchorOf("symbol", node) };
  S.sel = null; ctx.setSelected(null); switchTool(ctx, "place"); ctx.requestRender(); return true;
}
export function showDatasheet(ctx: SchCtx) {
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const p = kids(it.node, "property").find((q) => str(q[1]) === "Datasheet"); const url = p ? str(p[2]).trim() : "";
  if (!url || url === "~") { ctx.toast("No datasheet defined"); return false; }
  if (typeof window !== "undefined" && window.open && /^https?:/i.test(url)) window.open(url, "_blank"); else ctx.toast("Datasheet: " + url);
  return true;
}
