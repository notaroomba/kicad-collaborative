import type { Box, Pt } from "./types";
import { K, TYPE_NAMES, kid, ptsOf, uuidOf } from "./state";

// ---------------------------------------------------------------- small helpers
export const deep = <T extends SNode | null>(n: T): T => K.cloneNode(n);   // not JSON: that drops the reader's record of which atoms were quoted
export const r4 = (v: number | string) => +(+v).toFixed(4);
export const same = (a: Pt, b: Pt, tol?: number) => Math.abs(a[0] - b[0]) <= (tol || 1e-3) && Math.abs(a[1] - b[1]) <= (tol || 1e-3);
export const area = (b: Box | null) => b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
export function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
export function onSegMid(p: Pt, a: Pt, b: Pt) { return !same(p, a) && !same(p, b) && segDist(p, a, b) <= 1e-3; }
export function segs(item: KItem) { const p = ptsOf(item.node), out: Pt[][] = []; for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]); return out; }
export function replaceKid(node: SNode, child: SNode) { const i = node.findIndex((c) => Array.isArray(c) && c[0] === child[0]); if (i >= 0) node[i] = child; else node.push(child); }
export function dropKid(node: SNode, key: string) { const i = node.findIndex((c) => Array.isArray(c) && c[0] === key); if (i >= 0) node.splice(i, 1); }

// The desktop class name for a change (the canvas knows only the KiCad 9 kinds).
export function typeNameFor(item: Pick<KItem, "kind">) { return TYPE_NAMES[item.kind] || K.typeNameOf(item); }
// A rule area's uuid sits inside its polyline (formatPoly writes it there); the canvas keys the item by
// that uuid and pushes a direct (uuid) child the desktop parser would reject, so strip it before sending.
export function ruleAreaId(node: SNode) { const pl = kid(node, "polyline"); return pl ? uuidOf(pl) : ""; }
export function itemSexpr(doc: KDoc, kind: string, node: SNode) {
  if (kind === "rule_area" && kid(node, "uuid")) { node = deep(node); dropKid(node, "uuid"); }
  let s = K.serializeItem(doc, { kind, node });
  // a sheet's page number is a string to KiCad (its parser wants a symbol): keep the quotes the canvas drops
  if (kind === "sheet") s = s.replace(/\(page (\d+)\)/g, '(page "$1")');
  return s;
}
// MODIFIED change from a cloned node: the doc item stays untouched until commit applies it,
// which is what lets app.js record the pre-edit item as the undo step.
export function modChange(doc: KDoc, item: Pick<KItem, "id" | "kind">, node: SNode): KChange { return { id: item.id, kind: "MODIFIED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, node) }; }
export function removeChange(item: KItem): KChange { return { id: item.id, kind: "REMOVED", typeName: typeNameFor(item), properties: [] }; }
export function addNode(doc: KDoc, node: SNode): { item: KItem; change: KChange } {
  if (node[0] === "rule_area") {
    let pl = kid(node, "polyline"); if (!pl) { pl = ["polyline", ["pts"]]; node.splice(1, 0, pl); }
    if (!uuidOf(pl)) pl.push(["uuid", K.newUuid()]);
    const item = K.addItem(doc, node)!, id = ruleAreaId(node);
    doc.items.delete(item.id); item.id = id; doc.items.set(id, item);
    return { item, change: { id, kind: "ADDED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, node) } };
  }
  const item = K.createItem(doc, node)!;
  return { item, change: { id: item.id, kind: "ADDED", typeName: typeNameFor(item), sexpr: itemSexpr(doc, item.kind, item.node) } };
}
// Geometry for a node that is not (yet) part of the document: borrow the canvas builder.
export function ghost(doc: KDoc, node: SNode) { if (!uuidOf(node)) node.push(["uuid", K.newUuid()]); const it = K.addItem(doc, node); if (it) doc.items.delete(it.id); return it; }
