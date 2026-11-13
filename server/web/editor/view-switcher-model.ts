// view-switcher-model.ts — EDA_VIEW_SWITCHER's key handling as plain functions (common/dialogs/eda_view_switcher.cpp,
// pcbnew/pcb_base_edit_frame.cpp:111-178), so the node tests can run them; view-switcher.ts draws the dialog.
import { IS_MAC } from "../keys";

export type SwitcherKind = "preset" | "viewport";

/** Index after EDA_VIEW_SWITCHER::advanceSelection: forward, or back with Shift unless Shift is the switch key. */
export function advance(sel: number, count: number, shift: boolean, switchKey: string): number {
  if (!count) return sel;
  const backward = shift && switchKey !== "Shift";
  return ((sel + (backward ? -1 : 1)) % count + count) % count;
}

/** Which switcher a Tab keydown asks for (TryBefore: the preset key first), or null. */
export function switcherFor(ev: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac = IS_MAC): SwitcherKind | null {
  if (ev.key !== "Tab") return null;
  // WXK_RAW_CONTROL on macOS is the Control key itself (Cmd+Tab is the system's application switcher)
  if (ev.ctrlKey && (mac || !ev.metaKey)) return "preset";
  if (mac ? ev.altKey : ev.shiftKey) return "viewport";
  return null;
}

