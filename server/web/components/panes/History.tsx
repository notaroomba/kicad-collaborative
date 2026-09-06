// History.tsx — named checkpoints of the project; Restore hands everyone that version.
import { useSyncExternalStore } from "react";
import { dispatch, useApp } from "../../store";
import { runUiAction, useAvail } from "../../actions";
import { ago, cx } from "../../util";

// The picked row is shared between the table and the button row (they are siblings in the pane).
const pickedStore = (() => {
  let v: string | null = null; const subs = new Set<() => void>();
  return { get: () => v, set(n: string | null) { v = n; subs.forEach((s) => s()); }, subscribe(s: () => void) { subs.add(s); return () => { subs.delete(s); }; } };
})();
const usePicked = () => useSyncExternalStore(pickedStore.subscribe, pickedStore.get, pickedStore.get);

// Pane body (the .kbody contract) with History's padding: 0 override; the checkpoint table and its cells.
const BODY = "kbody overflow-auto p-0 min-h-0 flex-auto bg-paper text-sm";
const TH = "text-left font-semibold text-ink-2 px-1.5 py-[3px] border-b border-line bg-panel sticky top-0";
// Rows carry `group` (+ `sel` when picked).  The picked tint sits on the <tr>, the hover tint on its cells: cell
// backgrounds paint over the row's, so hovering a picked row shows the soft tint — as the old chrome.css's later
// `tr:hover td` rule did — without depending on how Tailwind orders the sel/hover variants.
const TR = "group sel:bg-sel";
const TD = "px-1.5 py-[3px] border-b border-line-soft whitespace-nowrap overflow-hidden text-ellipsis max-w-40 group-hover:bg-sel-soft group-hover:cursor-default";
const BTN = "kbtn bg-panel border border-line rounded-[3px] px-2.5 py-[3px] text-ink text-sm hover:border-ink-3 disabled:opacity-45";

export function HistoryPane() {
  const groups = useApp((s) => s.history.groups);
  const error = useApp((s) => s.history.error);
  const cur = usePicked();
  if (error) return <div className={BODY} id="history"><p className="note">{error}</p></div>;
  return (
    <div className={BODY} id="history">
      <table className="w-full border-collapse text-sm">
        <thead><tr><th className={TH}>Checkpoint</th><th className={TH}>When</th><th className={TH}>Docs</th></tr></thead>
        <tbody>
          {groups.length ? groups.map((c) => (
            <tr key={c.name} data-restore={c.name} className={cx(TR, cur === c.name && "sel")} onClick={() => pickedStore.set(c.name)}>
              <td className={TD} title={c.name}>{c.name}</td><td className={TD}>{ago(c.at)}</td><td className={TD}>{c.docs}</td>
            </tr>
          )) : <tr className={TR}><td colSpan={3} className={cx(TD, "note")}>No checkpoints yet. Create one to name the current state so you can come back to it.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryButtons() {
  const a = useAvail();
  const viewOnly = useApp((s) => s.viewOnly);
  const groups = useApp((s) => s.history.groups);
  const cur = usePicked();
  const valid = !!cur && groups.some((g) => g.name === cur);
  return (
    <div className="flex gap-1.5 px-2 py-1.5 border-t border-line bg-bench flex-none">
      <button type="button" className={BTN} data-uiact="save" onClick={(ev) => runUiAction(a, "save", ev.currentTarget)}>Checkpoint...</button>
      <button type="button" className={BTN} id="restoreBtn" disabled={viewOnly || !valid} onClick={() => { if (cur) dispatch({ type: "restore", name: cur }); }}>Restore</button>
      <button type="button" className={BTN} data-uiact="refreshHistory" onClick={(ev) => runUiAction(a, "refreshHistory", ev.currentTarget)}>Refresh</button>
    </div>
  );
}
