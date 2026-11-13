// selmodes.ts — SELECTION_TOOL::setModifiersState: what Shift / Ctrl do to a click and to a box or lasso drag.

/** SELECTION_TOOL::setModifiersState for a click: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift removes; null replaces. */
export function selModifier(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): "add" | "toggle" | "remove" | null {
  const c = ev.ctrlKey || ev.metaKey; return c && ev.shiftKey ? "remove" : c ? "toggle" : ev.shiftKey ? "add" : null;
}
/**
 * SELECTION_TOOL::setModifiersState for a box or lasso drag.  Eeschema calls SelectMultiple( area, m_drag_subtractive,
 * false ) with m_drag_additive = Ctrl || Shift, so a Ctrl drag adds like Shift.  Pcbnew calls SelectMultiple( area,
 * m_subtractive, m_exclusive_or ): Ctrl alone toggles (m_exclusive_or = Ctrl && !Shift), Ctrl+Shift removes.
 */
export function dragModifier(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }, sch = true): "add" | "remove" | "toggle" | null {
  const c = ev.ctrlKey || ev.metaKey;
  if (!sch) return c && ev.shiftKey ? "remove" : c ? "toggle" : ev.shiftKey ? "add" : null;
  if (ev.altKey) return null;   // && !aAltState
  return c && ev.shiftKey ? "remove" : c || ev.shiftKey ? "add" : null;
}
