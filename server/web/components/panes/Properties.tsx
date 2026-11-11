// Properties.tsx — KiCad's Properties panel (PROPERTIES_PANEL over a wxPropertyGrid): a caption with what
// is selected, then the item's properties in their categories as name | value rows.  The rows come from the
// editor's property model (CollabPanels.propGrid()); a commit goes back through CollabPanels.setProp(), which
// writes every selected item in one op.  Enter commits, Esc reverts, Tab moves to the next row; a value that
// differs across the selection shows "<...>".
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropGrid, PropRow } from "../../panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { panels, usePanels } from "./widgets";

const MIXED = "<...>";
const CELL = "w-full h-full min-w-0 m-0 px-1 py-0 border-0 outline-none bg-transparent text-ink text-sm font-sans focus:bg-canvas focus:shadow-[inset_0_0_0_1px_var(--color-blue)]";

/** Leave the cell editor: the keyboard goes back to the editor's hotkeys. */
function releaseKeyboard(el: HTMLElement): void { el.blur(); }

function Editor({ row, onDone }: { row: PropRow; onDone: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const settled = useRef(false);   // Enter / Esc already dealt with the draft: the blur that follows must not commit it again
  useEffect(() => { setDraft(null); setErr(null); }, [row.value, row.mixed]);
  const commit = (text: string): boolean => {
    const p = panels(); if (!p) return false;
    if (!row.mixed && text === row.value) { setDraft(null); setErr(null); return true; }
    const e = p.setProp(row.id, text);
    if (e) { setErr(e); return false; }
    setDraft(null); setErr(null); onDone(); return true;
  };
  if (row.type === "bool") {
    return <span className="flex items-center h-full px-1"><input type="checkbox" className="m-0 accent-blue" data-prop={row.id} disabled={row.readOnly} checked={row.value === "1"}
      ref={(el) => { if (el) el.indeterminate = row.mixed; }} onChange={(ev) => commit(ev.target.checked ? "1" : "0")} /></span>;
  }
  if (row.type === "enum" && row.choices) {
    return (
      <select className={cx(CELL, "appearance-auto")} data-prop={row.id} disabled={row.readOnly} value={row.mixed ? "\u0001" : row.value} onChange={(ev) => { const el = ev.currentTarget; if (commit(el.value)) releaseKeyboard(el); }}>
        {row.mixed ? <option value={"\u0001"} disabled>{MIXED}</option> : null}
        {row.choices.some(([v]) => v === row.value) || row.mixed ? null : <option value={row.value}>{row.value}</option>}
        {row.choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  const shown = draft !== null ? draft : row.value;
  return (
    <>
      <input type="text" className={cx(CELL, row.readOnly && "text-ink-3", err && "shadow-[inset_0_0_0_1px_var(--color-err)]")} data-prop={row.id} spellCheck={false} autoComplete="off"
        readOnly={row.readOnly} value={shown} placeholder={row.mixed ? MIXED : ""} title={err || (row.type === "longtext" ? row.value : undefined)}
        onFocus={(ev) => { if (!row.readOnly) ev.target.select(); }}
        onChange={(ev) => { setDraft(ev.target.value); setErr(null); }}
        onBlur={() => { if (settled.current) { settled.current = false; return; } if (draft !== null && !commit(draft)) { setDraft(null); setErr(null); } }}
        onKeyDown={(ev) => {
          // wxPropertyGrid: Enter commits and Esc reverts, and either closes the cell editor so the next keys
          // (Ctrl+Z, hotkeys) go to the frame again; a value the item refused keeps the editor open
          if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); if (draft === null || commit(draft)) { settled.current = true; releaseKeyboard(ev.currentTarget); } else ev.currentTarget.select(); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); setDraft(null); setErr(null); settled.current = true; releaseKeyboard(ev.currentTarget); }
          else if (ev.key !== "Tab") ev.stopPropagation();
        }} />
      {err ? <span className="absolute right-0 top-full z-10 px-1.5 py-0.5 bg-panel border border-err text-err text-xs whitespace-nowrap shadow-panel" data-prop-error>{err}</span> : null}
    </>
  );
}

function loadCollapsed(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem("kui.props.collapsed") || "{}") as Record<string, boolean>; } catch (e) { return {}; } }

export function PropertiesPane() {
  const selV = usePanels((s) => s.selVersion);
  const appSel = useApp((s) => s.selection.version);
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const units = useApp((s) => s.viewport.units);
  const viewOnly = useApp((s) => s.viewOnly);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const grid: PropGrid = useMemo(() => {
    const p = panels();
    try { return p ? p.propGrid() : { title: "No objects selected", count: 0, groups: [], readOnly: true }; }
    catch (e) { console.warn(e); return { title: "No objects selected", count: 0, groups: [], readOnly: true }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selV, appSel, docV, docId, units, viewOnly, tick]);
  const toggle = (g: string) => { const n = Object.assign({}, collapsed, { [g]: !collapsed[g] }); setCollapsed(n); try { localStorage.setItem("kui.props.collapsed", JSON.stringify(n)); } catch (e) { /* no storage */ } };
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="props">
      <div className="kprop-caption flex-none px-1.5 py-1 border-b border-line bg-bench font-semibold overflow-hidden text-ellipsis whitespace-nowrap" data-prop-title title={grid.note}>{grid.title}</div>
      <div className="flex-auto min-h-0 overflow-auto">
        {grid.groups.map((g) => (
          <div key={g.name} data-prop-group={g.name}>
            <div className="flex items-center h-[20px] px-1 bg-bench border-b border-line font-semibold cursor-default select-none" onClick={() => toggle(g.name)}>
              <span className="inline-block w-3.5 text-ink-2 text-xs">{collapsed[g.name] ? "▸" : "▾"}</span>{g.name}
            </div>
            {collapsed[g.name] ? null : g.rows.map((r) => (
              <div key={r.id} className="kprop d-grid grid-cols-[minmax(0,45%)_minmax(0,55%)] h-[21px] border-b border-line-soft" data-prop-row={r.id}>
                <span className={cx("pl-[18px] pr-1 leading-[20px] overflow-hidden text-ellipsis whitespace-nowrap border-r border-line-soft", r.readOnly && "text-ink-3")} title={r.name}>{r.name}</span>
                <span className="relative min-w-0"><Editor row={r} onDone={() => setTick((t) => t + 1)} /></span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
