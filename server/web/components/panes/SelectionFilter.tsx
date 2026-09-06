// SelectionFilter.tsx — panel_*selection_filter_base: which item kinds the select tool picks.
import { FILTERS } from "../../tables";
import { dispatch, useApp } from "../../store";

// `kcb` / `kbody` / `kfilter` / `kfgrid` stay as plain hooks; the utilities carry the styling.
const CB = "kcb flex items-center gap-1.5 py-px";
const CB_INPUT = "m-0 accent-blue";

export function SelectionFilterPane() {
  const editor = useApp((s) => s.document.editor);
  const filter = useApp((s) => s.filter);
  const list = editor ? FILTERS[editor] : [];
  const all = list.every(([k]) => filter[k] !== false);
  return (
    <div className="kbody kfilter overflow-auto min-h-0 flex-auto bg-paper px-2 py-1.5 text-sm">
      <label className={`${CB} all`}><input type="checkbox" className={CB_INPUT} data-f="all" checked={all} onChange={(ev) => dispatch({ type: "setFilter", key: "all", on: ev.target.checked })} /> All items</label>
      <div className="kfgrid d-grid grid-cols-[1fr_1fr] gap-x-2 gap-y-0 mt-0.5 mb-1 ml-3.5">
        {list.map(([k, l]) => (
          <label className={CB} key={k}><input type="checkbox" className={CB_INPUT} data-f={k} checked={filter[k] !== false} onChange={(ev) => dispatch({ type: "setFilter", key: k, on: ev.target.checked })} /> {l}</label>
        ))}
      </div>
      <label className={`${CB} locked text-ink-3`}><input type="checkbox" className={CB_INPUT} data-f="locked" disabled /> Locked items</label>
    </div>
  );
}
