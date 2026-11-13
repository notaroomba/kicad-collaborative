// pcb-tools/ref-move.ts — EDIT_TOOL's moves that need more than M:
//   moveWithReference  (Move with Reference...)   pickReferencePoint "Select reference point for move..." then Move with
//                                                  the picked point as the reference point (edit_tool_move_fct.cpp:1061)
//   copyWithReference  (Copy with Reference...)   pickReferencePoint "Select reference point for the copy...", then the
//                                                  copy with that origin; "Selection copied" / "Copy canceled" (edit_tool.cpp:4203)
//   moveIndividually   (Ctrl+M)                    each selected item in selection order rides the cursor in turn
//                                                  ("Click to place %s (item %zu of %zu)…"), Tab skips one (it goes back),
//                                                  Escape puts every one back, all placements are one undo step
//   interactiveOffsetTool                          POSITION_RELATIVE_TOOL::InteractiveOffset: a point on the item, then the
//                                                  point to offset from, then DIALOG_OFFSET_ITEM ("Offset Item") with the
//                                                  vector between them; OK moves the selection so the first point lands at
//                                                  the second plus the offset ("Set Relative Position Interactively")
import type { PcbCtx, Pt } from "./types";
import { statusPopup } from "./assistants";
import { replacedChange } from "./changes";
import { clipSet, clipboardText, cursorPoint } from "./clipboard";
import { openForm } from "./dialogs";
import { pickInteractively } from "./dom";
import { applySelection } from "./groups";
import { beginCarryMove, finishSelectMove } from "./select-move";
import { S } from "./state";
import { moveChanges } from "./transforms";
import { anchorOf } from "./transforms";
import { clone, r6 } from "./util";

export interface MoveSeq { ids: string[]; idx: number; base: Map<string, SNode>; committed: boolean }

/** The word KiCad's popup names an item by: a footprint's reference, else its type description in lower case. */
export function itemWord(it: KItem): string {
  if (it.kind === "footprint") return it.ref || "";
  const T: Record<string, string> = { segment: "track", arc: "track", via: "via", zone: "zone", gr_line: "graphic", gr_rect: "graphic", gr_circle: "graphic", gr_arc: "graphic", gr_poly: "graphic", gr_curve: "graphic",
    gr_text: "text", gr_text_box: "text box", dimension: "dimension", image: "reference image", table: "table", group: "group", generated: "generator", target: "target", point: "point", barcode: "barcode" };
  return T[it.kind] || it.kind;
}
export const moveIndividuallyText = (it: KItem, i: number, n: number) => `Click to place ${itemWord(it)} (item ${i} of ${n})\nPress <esc> to cancel all; double-click to finish`;

/** Move with Reference: the picked point is the move's reference point; Escape at the pick ends it (a hover selection is cleared). */
export function moveWithReference(ctx: PcbCtx, ids: string[], hover: boolean) {
  pickInteractively(ctx, "point", "Select reference point for move...", (res) => {
    if (!res || !Array.isArray(res)) { if (hover) applySelection(ctx, []); return; }
    applySelection(ctx, ids); beginCarryMove(ctx, { ids, origin: (res as Pt).slice(), hover });
  });
  return true;
}

/** Copy with Reference: the clipboard's origin is the picked point. */
export function copyWithReference(ctx: PcbCtx, ids: string[], hover: boolean) {
  pickInteractively(ctx, "point", "Select reference point for the copy...", (res) => {
    const at = ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx);
    if (!res || !Array.isArray(res)) { statusPopup(ctx, "Copy canceled", at, 800); if (hover) applySelection(ctx, []); return; }
    clipSet(ctx, clipboardText(ctx.doc, ids, (res as Pt).slice()));
    statusPopup(ctx, "Selection copied", at, 800); if (ctx.setStatus) ctx.setStatus("Selection copied");
    if (hover) applySelection(ctx, []); else applySelection(ctx, ids);
  });
  return true;
}

/** Move Individually: the first item picked up; each click places one and picks up the next. */
export function moveIndividually(ctx: PcbCtx, ids: string[]) {
  const items = ids.map((id) => ctx.doc.items.get(id)).filter((it): it is KItem => !!it && it.kind !== "group");
  if (!items.length) return true;
  const seq: MoveSeq = { ids: items.map((it) => it.id), idx: 0, base: new Map(), committed: false };
  for (const it of items) seq.base.set(it.id, clone(it.node));
  S.moveSeq = seq; pickUp(ctx, seq);
  return true;
}
function pickUp(ctx: PcbCtx, seq: MoveSeq) {
  const id = seq.ids[seq.idx], it = ctx.doc.items.get(id);
  if (!it) { nextItem(ctx, seq); return; }
  applySelection(ctx, [id]);
  // the item's position goes to the cursor: its position is the reference point (nextItem->Move( cursor - pos ))
  if (!beginCarryMove(ctx, { ids: [id], origin: anchorOf(it) }) || !S.move) { S.moveSeq = null; return; }
  const m = S.move; m.amend = seq.committed;
  m.after = (placed, wrote) => {
    if (S.moveSeq !== seq) return;
    if (wrote) seq.committed = true;
    if (!placed) { cancelAll(ctx, seq); return; }
    nextItem(ctx, seq);
  };
  S.popup = { text: moveIndividuallyText(it, seq.idx + 1, seq.ids.length), at: ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx), until: Number.MAX_SAFE_INTEGER }; ctx.requestRender();   // follows the cursor (select-move.ts)
}
function nextItem(ctx: PcbCtx, seq: MoveSeq) {
  if (++seq.idx < seq.ids.length) { pickUp(ctx, seq); return; }
  S.moveSeq = null; S.popup = null; applySelection(ctx, seq.ids.filter((id) => ctx.doc.items.has(id))); ctx.requestRender();
}
/** Escape: every item placed so far goes back (the step is taken out again). */
function cancelAll(ctx: PcbCtx, seq: MoveSeq) {
  S.moveSeq = null; S.popup = null;
  if (seq.committed) {
    const back = seq.ids.slice(0, seq.idx).filter((id) => ctx.doc.items.has(id)).map((id) => replacedChange(ctx.doc.items.get(id)!, seq.base.get(id)!));
    if (back.length) ctx.commit(back, "cancel", { amend: true, discard: true });
  }
  applySelection(ctx, []); ctx.requestRender();
}
/** PCB_ACTIONS::skip (Tab) while moving individually: the current item goes back where it was and the next is picked up. */
export function skipMoveItem(ctx: PcbCtx): boolean {
  const seq = S.moveSeq, m = S.move; if (!seq || !m || !m.after) return false;
  m.after = undefined; finishSelectMove(ctx, false);
  nextItem(ctx, seq); return true;
}

/** InteractiveOffset: two picks, then Offset Item. */
export function interactiveOffset(ctx: PcbCtx, ids: string[], hover: boolean) {
  const done = () => { if (hover) applySelection(ctx, []); };
  pickInteractively(ctx, "point", "Select the reference point on the item to move.", (a) => {
    if (!a || !Array.isArray(a)) { done(); return; }
    pickInteractively(ctx, "point", "Select the point to define the new offset from.", (b) => {
      if (!b || !Array.isArray(b)) { done(); return; }
      const P = a as Pt, Q = b as Pt; const off: Pt = [r6(P[0] - Q[0]), r6(P[1] - Q[1])];
      openOffsetDialog(ctx, off, (o) => {
        const mv: Pt = [Q[0] - P[0] + o[0], Q[1] - P[1] + o[1]];
        // moveSelectionBy: the selection translated by the vector (positionRelativeChanges to the anchor's new place)
        const ch = offsetChanges(ctx, ids, mv); if (ch.length) ctx.commit(ch, "Set Relative Position Interactively");
        done(); ctx.requestRender();
      }, done);
    });
  });
  return true;
}
function offsetChanges(ctx: PcbCtx, ids: string[], mv: Pt) {
  const items = ids.map((id) => ctx.doc.items.get(id)).filter((it): it is KItem => !!it);
  if (!items.length || (!mv[0] && !mv[1])) return [];
  return moveChanges(ctx.doc, ids, mv[0], mv[1]);
}
/** DIALOG_OFFSET_ITEM: Offset X / Offset Y (or Distance / Angle with "Use polar coordinates"). */
export function openOffsetDialog(ctx: PcbCtx, off: Pt, ok: (o: Pt) => void, cancel?: () => void) {
  const r = Math.hypot(off[0], off[1]), q = r ? Math.atan2(off[1], off[0]) * 180 / Math.PI : 0;
  let polar = false;
  return openForm({ title: "Offset Item", width: 360, fields: [
    { k: "x", label: "Offset X:", type: "num", value: r6(off[0]) }, { k: "y", label: "Offset Y:", type: "num", value: r6(off[1]) },
    { k: "polar", label: "Use polar coordinates", type: "check", value: false }],
    change: (k: string, v: unknown, set: (k: string, v: unknown) => void) => {
      if (k !== "polar") return; polar = !!v;
      if (polar) { set("x", r6(r)); set("y", r6(q)); } else { set("x", r6(off[0])); set("y", r6(off[1])); }
    },
    apply: (v: { x: number; y: number; polar: boolean }) => {
      const x = isNaN(v.x) ? 0 : v.x, y = isNaN(v.y) ? 0 : v.y;
      ok(v.polar ? [r6(x * Math.cos(y * Math.PI / 180)), r6(x * Math.sin(y * Math.PI / 180))] : [x, y]);
    } });
  void cancel;
}
