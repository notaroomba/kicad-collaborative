// selmodes.ts — SELECTION_TOOL::setModifiersState: what Shift / Ctrl do to a click and to a box or lasso drag.

/** SELECTION_TOOL::setModifiersState for a click: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift removes; null replaces. */
export function selModifier(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): "add" | "toggle" | "remove" | null {
  const c = ev.ctrlKey || ev.metaKey; return c && ev.shiftKey ? "remove" : c ? "toggle" : ev.shiftKey ? "add" : null;
}
/**
 * SELECTION_TOOL::setModifiersState for a box or lasso drag: what SelectMultiple does with the items.  Eeschema calls
 * SelectMultiple( area, m_drag_subtractive, false ) with m_drag_additive = ( Ctrl || Shift ) && !Alt, so a Ctrl drag
 * adds like Shift.  Pcbnew calls SelectMultiple( area, m_subtractive, m_exclusive_or ), which do not look at Alt:
 * Ctrl alone toggles (m_exclusive_or = Ctrl && !Shift), Ctrl+Shift removes, Shift adds.
 */
export function dragModifier(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }, sch = true): "add" | "remove" | "toggle" | null {
  const c = ev.ctrlKey || ev.metaKey;
  if (!sch) return c && ev.shiftKey ? "remove" : c ? "toggle" : ev.shiftKey ? "add" : null;
  if (ev.altKey) return null;   // && !aAltState
  return c && ev.shiftKey ? "remove" : c || ev.shiftKey ? "add" : null;
}
/**
 * m_drag_additive || m_drag_subtractive, ( Ctrl || Shift ) && !Alt in both editors: the drag keeps the selection
 * instead of clearing it first.
 */
export function dragKeeps(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }): boolean {
  return (ev.ctrlKey || ev.metaKey || ev.shiftKey) && !ev.altKey;
}
/**
 * The SELECTION_AREA fill flags, SetAdditive / SetSubtractive (SetExclusiveOr is always false).  Box drags in both
 * editors and eeschema's lasso set them from m_drag_additive / m_drag_subtractive; PCB_SELECTION_TOOL::SelectPolyArea
 * sets them from m_additive ( Shift && !Ctrl ) and m_subtractive ( Ctrl && Shift ), so a Ctrl lasso on the board has
 * the normal fill and a Ctrl+Shift one the subtract fill.  ViewDraw tests additive first.
 */
export function areaFill(b: { lasso: boolean; add?: boolean; mode?: string | null }, sch: boolean): { additive: boolean; subtractive: boolean } {
  if (b.lasso && !sch) return { additive: b.mode === "add", subtractive: b.mode === "remove" };
  return { additive: !!b.add, subtractive: !!b.add && b.mode === "remove" };
}
