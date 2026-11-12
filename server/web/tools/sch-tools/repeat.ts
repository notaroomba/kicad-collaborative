import type { SchCtx, Pt } from "./types";
import { assignPastedRef, canFollow, refField, setReference, unannotated, usedReferences } from "./clipboard";
import { cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { LABEL_KINDS, beginDrag, connPoints, isNetLine } from "./drag";
import { type EditTxn, editTxn, explicitJunctionNeeded, screenConnections, segOf, txnAddJunction, txnCleanUp, txnTrimWire } from "./junction";
import { anchorOf, cloneNode, shiftNode } from "./orient";
import { LINE_KINDS, S, TEXT_KINDS, str, uuidOf } from "./state";
import { autoRotateOf, setAutoRotate, supportsAutoRotate } from "./autorotate";
import { deep, modChange, r4, segDist, segs } from "./util";

// ---------------------------------------------------------------- repeat last item (Insert)
// SaveCopyForRepeatItem: what Insert repeats is a list (a whole wire, an unfold's entry, label and wire);
// junctions are never repeated.
export function rememberPlaced(kind: string, node: SNode) { if (kind === "junction") return; S.lastPlaced = [{ kind, node: deep(node) }]; }
// common/increment.cpp IncrementString: the last run of digits steps, leading zeros kept; null below zero.
export function incrementText(text: unknown, delta: number) {
  const m = str(text).match(/^([\s\S]*?)(\d+)(\D*)$/); if (!m) return str(text);
  const n = parseInt(m[2], 10) + (delta === undefined ? 1 : delta); if (n < 0) return null;
  return m[1] + String(n).padStart(m[2].length, "0") + m[3];
}
// Junctions the new items need (SCH_SCREEN::GetNeededJunctions + AddJunction), inside a dry-run edit.
export function txnNeededJunctions(t: EditTxn, doc: KDoc, items: KItem[]) {
  const conns = screenConnections(doc), pts: Pt[] = [], seen = new Set<string>();
  const push = (p: Pt) => { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
  for (const it of items) {
    for (const p of connPoints(doc, it)) push(p);
    if (isNetLine(it.kind)) for (const [a, b] of segs(it)) for (const c of conns) if (segDist(c, a, b) <= 1e-3) push(c);
  }
  for (const p of pts) if (explicitJunctionNeeded(doc, p)) txnAddJunction(t, doc, p);
}
// TrimOverLappingWires: a line running through exactly two connection points of a new (non-line) item is
// cut between them (a symbol repeated onto a wire takes its place in it).
export function txnTrimOverlapping(t: EditTxn, doc: KDoc, items: KItem[]) {
  for (const it of items) {
    if (isNetLine(it.kind) || LINE_KINDS.has(it.kind)) continue;
    const pts = connPoints(doc, it); if (pts.length < 2) continue;
    for (const line of Array.from(doc.items.values())) {
      if (line.kind !== "wire") continue; const s = segOf(line); if (!s) continue;
      const on = pts.filter((p) => segDist(p, s[0], s[1]) <= 1e-3);
      if (on.length === 2) txnTrimWire(t, doc, on[0], on[1], new Set([line.id]));
    }
  }
}
/**
 * SCH_EDIT_TOOL::RepeatDrawItem (Insert): every remembered item is duplicated; a label's number steps by
 * repeat_label_increment (warning when it would go below zero), a symbol goes to the cursor, is re-annotated
 * when annotation is automatic and then follows the cursor (SCH_ACTIONS::move), anything else is offset by
 * default_repeat_offset.  Overlapped wires are trimmed, junctions added and the lines cleaned up in one
 * "Repeat Item" commit; the new items become what the next Insert repeats.
 */
export function repeatLast(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const src = S.lastPlaced; if (!src || !src.length) return false;
  const doc = ctx.doc, t = editTxn(doc, ctx.IU), used = usedReferences(doc), added: string[] = [];
  let symbolId: string | null = null, warned = false;
  try {
    for (const lp of src) {
      const node = cloneNode({ kind: lp.kind, node: deep(lp.node) });
      if (LABEL_KINDS.has(lp.kind) && lp.kind !== "netclass_flag" && lp.kind !== "directive_label") {
        const tx = incrementText(node[1], S.repeatIncrement);
        if (tx === null) { if (!warned) ctx.toast("Label value cannot go below zero"); warned = true; } else node[1] = tx;
      }
      if (lp.kind === "symbol") {
        const p = snapCursor(ctx), a = anchorOf("symbol", node); shiftNode("symbol", node, r4(p[0] - a[0]), r4(p[1] - a[1]));
        if (S.annotateAuto) { const rf = refField(node); if (rf) setReference(node, unannotated(str(rf[2]))); assignPastedRef(doc, node, used); }
      } else shiftNode(lp.kind, node, S.repeatOffset[0], S.repeatOffset[1]);
      const it = t.add(node); added.push(it.id); if (lp.kind === "symbol" && !symbolId) symbolId = it.id;
      // SCH_ITEM::Duplicate copies SCH_LABEL_BASE::m_autoRotateOnPlacement: the repeated label keeps its Auto flag
      if (supportsAutoRotate(lp.kind) && autoRotateOf(uuidOf(lp.node) || "")) setAutoRotate(it.id, true);
    }
    const items = added.map((id) => doc.items.get(id)).filter(Boolean) as KItem[];
    txnTrimOverlapping(t, doc, items);
    txnNeededJunctions(t, doc, items);
    txnCleanUp(t, doc, added.filter((id) => { const it = doc.items.get(id); return it && isNetLine(it.kind); }), []);
  } finally { t.restore(); }
  const changes = t.changes(); if (!changes.length) return false;
  ctx.commit(changes, "Repeat Item");
  const now = added.map((id) => doc.items.get(id)).filter(Boolean) as KItem[];
  S.lastPlaced = now.map((it) => ({ kind: it.kind, node: deep(it.node) }));
  setSelectionIds(ctx, now.map((it) => it.id));
  if (symbolId && canFollow(ctx)) {                                      // then SCH_ACTIONS::move: the repeated symbol follows the cursor until the click
    const it = doc.items.get(symbolId), mode = S.dragMode; S.dragMode = "move";
    const d = it ? beginDrag(ctx, [it], cursorOf(ctx), false) : null;
    if (d) { d.restoreMode = mode; d.moved = true; } else S.dragMode = mode;
  }
  return true;
}
export function incrementSelection(ctx: SchCtx, delta: number) {
  if (!editable(ctx)) return false;
  const changes: KChange[] = [];
  for (const it of selectedItems(ctx)) {
    if (!TEXT_KINDS.has(it.kind) && it.kind !== "text_box") continue;
    const t = incrementText(it.node[1], delta); if (t === null || t === str(it.node[1])) continue;
    const n = deep(it.node); n[1] = t; changes.push(modChange(ctx.doc, it, n));
  }
  if (!changes.length) return false;
  ctx.commit(changes, delta < 0 ? "decrement" : "increment"); return true;
}
