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
import { KD, openForm } from "./dialogs";
import { sizeUnits } from "./edit-commands";
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

/**
 * InteractiveOffset: two picks, then Offset Item; the tool keeps running (the next reference point) after OK or
 * Cancel until Escape at the first pick, as POSITION_RELATIVE_TOOL's event loop does.
 */
export function interactiveOffset(ctx: PcbCtx, ids: string[], hover: boolean) {
  const done = () => { if (hover) applySelection(ctx, []); };
  const round = (): void => {
    pickInteractively(ctx, "point", "Select the reference point on the item to move.", (a) => {
      if (!a || !Array.isArray(a)) { done(); return; }
      pickInteractively(ctx, "point", "Select the point to define the new offset from.", (b) => {
        if (!b || !Array.isArray(b)) { round(); return; }       // Escape with the origin set: cleanup(), back to the first point
        const P = a as Pt, Q = b as Pt; const off: Pt = [r6(P[0] - Q[0]), r6(P[1] - Q[1])];
        openOffsetDialog(ctx, off, (o) => {
          const mv: Pt = [Q[0] - P[0] + o[0], Q[1] - P[1] + o[1]];
          // moveSelectionBy: the selection translated by the vector (positionRelativeChanges to the anchor's new place)
          const ch = offsetChanges(ctx, ids, mv); if (ch.length) ctx.commit(ch, "Set Relative Position Interactively");
          ctx.requestRender(); round();
        }, round);
      });
    });
  };
  round();
  return true;
}
function offsetChanges(ctx: PcbCtx, ids: string[], mv: Pt) {
  const items = ids.map((id) => ctx.doc.items.get(id)).filter((it): it is KItem => !!it);
  if (!items.length || (!mv[0] && !mv[1])) return [];
  return moveChanges(ctx.doc, ids, mv[0], mv[1]);
}
/** The user's length units for a UNIT_BINDER: mm per unit, the decimals shown and the label. */
export function userLengthUnits(u: string): { per: number; dp: number; label: string } {
  return u === "mil" || u === "mils" ? { per: 0.0254, dp: 2, label: "mils" } : u === "in" ? { per: 25.4, dp: 5, label: "in" } : { per: 1, dp: 4, label: "mm" };
}
/**
 * DIALOG_OFFSET_ITEM's state (dialog_offset_item.cpp) in the user's units: the shown X / Y entries (lengths, or
 * Distance and Angle in degrees in polar mode), OnPolarChanged converting the entries as typed, OnClear resetting one
 * entry to the original offset, TransferDataFromWindow giving the offset in mm.  Values read back through the shown
 * precision as the UNIT_BINDER's GetDoubleValue does.
 */
export class OffsetItemState {
  stateX = 0; stateY = 0; stateRadius = 0; stateTheta = 0;
  x = "0"; y = "0";
  readonly u: { per: number; dp: number; label: string };
  constructor(readonly original: Pt, units: string, public polar = true) {
    this.u = userLengthUnits(units);
    // TransferDataToWindow: ChangeValue( original ), then OnPolarChanged when the box is checked (it is by default)
    this.x = this.showLen(original[0]); this.y = this.showLen(original[1]);
    if (this.polar) this.setPolar(true);
  }
  showLen(mm: number): string { return String(+(mm / this.u.per).toFixed(this.u.dp)); }
  showDeg(d: number): string { return String(+d.toFixed(4)); }
  /** an entry's value: mm for a length, degrees for the polar angle (empty / unparsable = 0, OnTextFocusLost) */
  readLen(t: string): number { const v = parseFloat(t); return isFinite(v) ? +(v * this.u.per).toFixed(9) : 0; }
  readDeg(t: string): number { const v = parseFloat(t); return isFinite(v) ? v : 0; }
  get labels(): [string, string] { return this.polar ? ["Distance:", "Angle:"] : ["Offset X:", "Offset Y:"]; }
  get units(): [string, string] { return this.polar ? [this.u.label, "deg"] : [this.u.label, this.u.label]; }
  get tips(): [string, string] { return this.polar ? ["Reset to the current distance from the reference position.", "Reset to the current angle from the reference position."]
    : ["Reset to the current X offset from the reference position.", "Reset to the current Y offset from the reference position."]; }
  private static toPolar(x: number, y: number): [number, number] { const r = Math.hypot(x, y); return [r, r !== 0 ? Math.atan2(y, x) * 180 / Math.PI : 0]; }
  /** OnPolarChanged */
  setPolar(newPolar: boolean): void {
    // the entries as typed: the X entry is a length either way; the Y entry is a length, or (polar) an angle
    const xOffset = this.readLen(this.x), yOffset = this.polar && !newPolar ? this.readDeg(this.y) : this.readLen(this.y);
    this.polar = newPolar;
    if (newPolar) {
      if (xOffset !== this.stateX || yOffset !== this.stateY) {
        this.stateX = xOffset; this.stateY = yOffset;
        const [r, q] = OffsetItemState.toPolar(xOffset, yOffset);
        this.x = this.showLen(r); this.stateRadius = this.readLen(this.x);
        this.y = this.showDeg(q); this.stateTheta = this.readDeg(this.y);
      } else { this.x = this.showLen(this.stateRadius); this.y = this.showDeg(this.stateTheta); }
    } else if (xOffset !== this.stateRadius || yOffset !== this.stateTheta) {
      this.stateRadius = xOffset; this.stateTheta = yOffset;
      const t = yOffset * Math.PI / 180;
      this.x = this.showLen(xOffset * Math.cos(t)); this.stateX = this.readLen(this.x);
      this.y = this.showLen(xOffset * Math.sin(t)); this.stateY = this.readLen(this.y);
    } else { this.x = this.showLen(this.stateX); this.y = this.showLen(this.stateY); }
  }
  /** OnClear: the Reset button beside an entry */
  clear(which: "x" | "y"): void {
    const [r, q] = OffsetItemState.toPolar(this.original[0], this.original[1]);
    if (which === "x") { this.stateX = this.original[0]; this.stateRadius = this.readLen(this.showLen(r)); this.x = this.polar ? this.showLen(this.stateRadius) : this.showLen(this.stateX); }
    else { this.stateY = this.original[1]; this.stateTheta = this.readDeg(this.showDeg(q)); this.y = this.polar ? this.showDeg(this.stateTheta) : this.showLen(this.stateY); }
  }
  /** TransferDataFromWindow: the offset in mm */
  result(): Pt {
    if (this.polar) { const r = this.readLen(this.x), t = this.readDeg(this.y) * Math.PI / 180; return [r6(r * Math.cos(t)), r6(r * Math.sin(t))]; }
    return [r6(this.readLen(this.x)), r6(this.readLen(this.y))];
  }
}

/** DIALOG_OFFSET_ITEM ("Offset Item"): Offset X / Offset Y, or Distance / Angle with "Use polar coordinates", each with Reset. */
export function openOffsetDialog(ctx: PcbCtx, off: Pt, ok: (o: Pt) => void, cancel?: () => void) {
  const st = new OffsetItemState(off, sizeUnits());
  const kd = KD();
  if (!kd || typeof document === "undefined") {
    // no dialog shell (node tests): the form fallback hands the shown values to apply
    return openForm<{ x: string; y: string; polar: boolean }>({ title: "Offset Item", width: 360, fields: [
      { k: "x", label: st.labels[0], type: "text", value: st.x, unit: st.units[0] }, { k: "y", label: st.labels[1], type: "text", value: st.y, unit: st.units[1] },
      { k: "polar", label: "Use polar coordinates", type: "check", value: st.polar }],
      apply: (v) => { st.x = String(v.x); st.y = String(v.y); st.polar = !!v.polar; ok(st.result()); } });
  }
  const mk = <T extends HTMLElement>(tag: string, css?: string, text?: string): T => { const e = document.createElement(tag) as T; if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
  const inputCss = "font:inherit;background:var(--panel,#0A1421);color:inherit;border:1px solid var(--line,#24374E);border-radius:3px;padding:3px 5px;min-width:0";
  kd.open({
    title: "Offset Item", width: 360,
    build(body: HTMLElement) {
      const grid = mk<HTMLDivElement>("div", "display:grid;grid-template-columns:auto 1fr auto auto;gap:6px 8px;align-items:center;margin:4px 0 10px");
      const row = (k: "x" | "y") => {
        const lab = mk<HTMLSpanElement>("span"); const inp = mk<HTMLInputElement>("input", inputCss); inp.type = "text"; inp.dataset.k = k;
        const unit = mk<HTMLSpanElement>("span"); const reset = mk<HTMLButtonElement>("button"); reset.type = "button"; reset.className = "btn"; reset.textContent = "Reset"; reset.dataset.k = k === "x" ? "clearX" : "clearY";
        inp.addEventListener("input", () => { st[k] = inp.value; });
        inp.addEventListener("blur", () => { if (!inp.value.trim()) { inp.value = "0"; st[k] = "0"; } });   // OnTextFocusLost
        reset.addEventListener("click", () => { st.clear(k); sync(); });
        grid.append(lab, inp, unit, reset);
        return { lab, inp, unit, reset };
      };
      const rx = row("x"), ry = row("y");
      const polarBox = mk<HTMLInputElement>("input", "width:auto;margin:0"); polarBox.type = "checkbox"; polarBox.dataset.k = "polar"; polarBox.checked = st.polar;
      const polarLab = mk<HTMLLabelElement>("label", "display:flex;gap:6px;align-items:center"); polarLab.append(polarBox, document.createTextNode("Use polar coordinates"));
      polarBox.addEventListener("change", () => { st.setPolar(polarBox.checked); sync(); });
      const sync = (): void => {
        const [lx, ly] = st.labels, [ux, uy] = st.units, [tx, ty] = st.tips;
        rx.lab.textContent = lx; ry.lab.textContent = ly; rx.unit.textContent = ux; ry.unit.textContent = uy; rx.reset.title = tx; ry.reset.title = ty;
        rx.inp.value = st.x; ry.inp.value = st.y;
      };
      sync();
      body.append(grid, polarLab);
      setTimeout(() => { rx.inp.focus(); rx.inp.select(); }, 0);   // SetInitialFocus( m_xEntry )
    },
    ok() { ok(st.result()); return true; },
    cancel() { if (cancel) cancel(); },
  });
  return true;
}
