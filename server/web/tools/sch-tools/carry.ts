import type { PtrEvent, SchCtx, Pt } from "./types";
import { breakLinesAt, junctionAt, junctionChanges } from "./connect";
import { autoRotateNode, setAutoRotate, supportsAutoRotate } from "./autorotate";
import { editTxn, explicitJunctionAllowed, switchTool, txnAddJunction } from "./junction";
import { labelNode } from "./nodes";
import { anchorOf, cloneNode, shiftNode } from "./orient";
import { rememberPlaced } from "./repeat";
import { snapConn } from "./snap";
import { K, LINE_KINDS, S, SHAPE_KINDS, TEXT_KINDS, atOf, ptsOf, uuidOf } from "./state";
import { addNode, deep, ghost, r4, removeChange, same } from "./util";

// ---------------------------------------------------------------- carried item (ghost that follows the cursor)
export function startCarry(ctx: SchCtx, kind: string, node: SNode, mm: Pt | null | undefined) {
  S.carry = { kind, node, item: null, pos: null };
  placeCarry(ctx, mm || S.cursor || [ctx.doc.page[0] / 2, ctx.doc.page[1] / 2]);
}
export function placeCarry(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null) {
  const c = S.carry; if (!c) return;
  // labels snap to pins and wire ends like wires do (EE_GRID_HELPER::ResolveSnap); graphics and symbols to the grid
  const gridOnly = c.kind === "symbol" || c.kind === "text" || SHAPE_KINDS.has(c.kind) || c.kind === "text_box"
    || c.kind === "image" || c.kind === "table" || c.kind === "bezier" || c.kind === "rule_area" || c.kind === "sheet";
  const noGrid = !!(ev && (ev.ctrlKey || ev.metaKey));
  const p = gridOnly ? (noGrid ? [mm[0], mm[1]] : ctx.snap([mm[0], mm[1]])).map(r4) : snapConn(ctx, mm, c.kind === "bus" ? "bus" : "wire", ev);
  if (c.pos && same(c.pos, p)) return;
  const a = anchorOf(c.kind, c.node); shiftNode(c.kind, c.node, r4(p[0] - a[0]), r4(p[1] - a[1]));
  c.pos = p; c.item = ghost(ctx.doc, c.node); ctx.requestRender();
}
export function refreshCarry(ctx: SchCtx) { const c = S.carry; if (c) { c.item = ghost(ctx.doc, c.node); ctx.requestRender(); } }
export function cancelCarry(ctx: SchCtx) { S.carry = null; S.labelQueue = null; ctx.requestRender(); }
export function dropCarry(ctx: SchCtx) {
  const c = S.carry; if (!c) return null; S.carry = null;
  const doc = ctx.doc, p = anchorOf(c.kind, c.node);
  // SCH_DRAWING_TOOLS::TwoClickPlace: a global / hierarchical label placed with "Auto" faces away from what it lands on
  const auto = supportsAutoRotate(c.kind) && !!S.lastAutoRotate;
  if (auto) { const n = autoRotateNode(doc, c.kind, c.node, uuidOf(c.node) || null, true); if (n) c.node = n; }
  if (c.kind === "junction" && junctionAt(doc, p[0], p[1])) { ctx.toast("There is already a junction here"); ctx.requestRender(); return null; }
  const { item, change } = addNode(doc, c.node); const changes = [change];
  if (auto) setAutoRotate(item.id, true);
  if (c.kind === "symbol") changes.push(...junctionChanges(doc, K.pinPoints(doc, item).map((q) => [q.x, q.y]), "wire"));
  else if (LINE_KINDS.has(c.kind) && c.kind !== "polyline") changes.push(...junctionChanges(doc, ptsOf(c.node), c.kind));
  else if (c.kind === "junction") changes.push(...breakLinesAt(doc, p, "wire"), ...breakLinesAt(doc, p, "bus"));
  ctx.commit(changes, c.kind === "symbol" ? "place " + (item.ref || "symbol") : c.kind.replace("_", " "));
  rememberPlaced(item.kind, item.node);
  if (c.kind === "symbol" || c.kind === "sheet") ctx.setSelected({ id: item.id }); else { S.sel = item.id; ctx.setSelected(null); }
  // the dialog's multiple-label list: the next label rides on the cursor (itemsToPlace)
  if (S.labelQueue && S.labelQueue.length && (TEXT_KINDS.has(c.kind) || c.kind === "netclass_flag")) { const next = S.labelQueue.shift()!; startCarry(ctx, c.kind, next, p); }
  ctx.requestRender();
  return item;
}
/**
 * SCH_DRAWING_TOOLS::SingleClickPlace's click for the junction, no-connect and bus-entry tools.  A click on an
 * existing no-connect removes it (the flag toggles); a junction needs a place it can join
 * (IsExplicitJunctionAllowed) and breaks the lines it lands on; a double click ends the tool.  The preview
 * keeps its orientation for the next placement.
 */
export function singleClickPlace(ctx: SchCtx, toolId: string, dbl: boolean) {
  const c = S.carry; if (!c) return null;
  S.carry = null;                 // the commit's onDocChanged re-ghosts a carry: the ghost shares the placed item's uuid and would take it out
  const keep = () => { S.carry = c; };
  const doc = ctx.doc, p = anchorOf(c.kind, c.node);
  let existing: KItem | null = null;
  for (const it of doc.items.values()) if (it.kind === c.kind && same(atOf(it.node), p)) { existing = it; break; }
  let placed: KItem | null = null;
  if (existing) {
    if (c.kind === "no_connect") { ctx.commit([removeChange(existing)], "Remove No Connect Flag"); if (S.sel === existing.id) S.sel = null; }
  } else if (c.kind === "junction") {
    if (!explicitJunctionAllowed(doc, p)) { keep(); ctx.toast("Junction location contains no joinable wires and/or pins."); ctx.requestRender(); return null; }
    const t = editTxn(doc, ctx.IU); try { placed = txnAddJunction(t, doc, p); } finally { t.restore(); }
    ctx.commit(t.changes(), "Add Junction");
  } else {
    const r = addNode(doc, deep(c.node)); placed = r.item;
    ctx.commit([r.change], c.kind === "no_connect" ? "Add No Connect Flag" : "Add Wire to Bus Entry");
    S.lastPlaced = [{ kind: r.item.kind, node: deep(r.item.node) }];      // allowRepeat: no-connects and bus entries, not junctions
  }
  if (dbl) { S.carry = null; switchTool(ctx, "select"); return placed; }
  const node = cloneNode({ kind: c.kind, node: c.node });
  S.carry = { kind: c.kind, node, item: ghost(doc, node), pos: c.pos };
  ctx.requestRender();
  return placed;
}
// Create a label/text straight away at p (the inline prompt's Enter).
export function placeText(ctx: SchCtx, kind: string, text: string, p: Pt, rot: number) {
  const doc = ctx.doc; const { item, change } = addNode(doc, labelNode(kind, text, p, rot || 0));
  ctx.commit([change], kind.replace("_", " "));
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null); ctx.requestRender();
  return item;
}
