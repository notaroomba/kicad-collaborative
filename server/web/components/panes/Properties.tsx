// Properties.tsx — KiCad's Properties panel (PROPERTIES_PANEL over a wxPropertyGrid): a caption with what
// is selected, then the item's properties in their categories as name | value rows.  The rows come from the
// editor's property model (CollabPanels.propGrid()); a commit goes back through CollabPanels.setProp(), which
// writes every selected item in one op.  The keys are PROPERTIES_PANEL's: Enter (and Down) commits and moves to
// the next property, Up to the previous one, Tab / Shift+Tab to the next / previous editable one (wrapping), Space
// toggles a checkbox, Esc reverts and gives the keyboard back to the canvas.  The splitter between names and values
// starts centred (CenterSplitter) and remembers where it was dragged.  A value that differs across the selection
// shows "<...>".
import { Select } from "../Select";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropGrid, PropRow } from "../../panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { panels, usePanels } from "./widgets";

const MIXED = "<...>";
const CELL = "w-full h-full min-w-0 m-0 px-1 py-0 border-0 outline-none bg-transparent text-ink text-sm font-sans focus:bg-canvas focus:shadow-[inset_0_0_0_1px_var(--color-blue)]";

/** Leave the cell editor: the keyboard goes back to the editor's hotkeys. */
function releaseKeyboard(el: HTMLElement): void { el.blur(); }

/** A key that leaves the cell for another property: "next" / "prev" (Enter, Down / Up), "tab" / "backtab". */
type Nav = "next" | "prev" | "tab" | "backtab";
function navOf(ev: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Nav | null {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  if (ev.key === "Tab") return ev.shiftKey ? "backtab" : "tab";
  if (ev.shiftKey) return null;
  return ev.key === "Enter" || ev.key === "ArrowDown" ? "next" : ev.key === "ArrowUp" ? "prev" : null;
}
/** The cell editor a navigation key lands on, from the one it left (PROPERTIES_PANEL::onCharHook). */
export function navTarget(cells: { readOnly: boolean }[], from: number, nav: Nav): number {
  const n = cells.length; if (!n) return -1;
  if (nav === "next") return Math.min(n - 1, from + 1);
  if (nav === "prev") return Math.max(0, from - 1);
  const step = nav === "tab" ? 1 : -1;
  for (let k = 1; k <= n; k++) { const i = ((from + step * k) % n + n) % n; if (!cells[i].readOnly) return i; }
  return from;
}
function moveFrom(el: HTMLElement, nav: Nav): void {
  const box = el.closest("#props"); if (!box) return;
  const cells = Array.from(box.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-prop]"));
  const from = cells.indexOf(el as HTMLInputElement);
  const to = navTarget(cells.map((c) => ({ readOnly: c.disabled || (c as HTMLInputElement).readOnly })), from, nav);
  const t = cells[to]; if (t && t !== el) { t.focus(); if (t instanceof HTMLInputElement && t.type === "text" && !t.readOnly) t.select(); }
}

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
      ref={(el) => { if (el) el.indeterminate = row.mixed; }} onChange={(ev) => commit(ev.target.checked ? "1" : "0")}
      onKeyDown={(ev) => {
        const nav = navOf(ev);
        if (nav) { ev.preventDefault(); ev.stopPropagation(); moveFrom(ev.currentTarget, nav); }
        else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); releaseKeyboard(ev.currentTarget); }
        else ev.stopPropagation();
      }} /></span>;
  }
  if (row.type === "enum" && row.choices) {
    return (
      <Select className={cx(CELL, "rounded-none")} data={{ prop: row.id }} disabled={row.readOnly} value={row.mixed ? "\u0001" : row.value}
        options={[...(row.mixed ? [{ value: "\u0001", label: MIXED, disabled: true }] : []), ...(row.choices.some(([v]) => v === row.value) || row.mixed ? [] : [{ value: row.value, label: row.value }]),
          ...row.choices.map(([v, l]) => ({ value: v, label: l }))]}
        onChange={(v, el) => { if (commit(v)) releaseKeyboard(el); }}
        onKey={(ev, el) => {
          // Up / Down are dedicated to the grid (DedicateKey): they move between properties, not through the choices
          const nav = navOf(ev);
          if (nav) { ev.preventDefault(); ev.stopPropagation(); moveFrom(el, nav); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); releaseKeyboard(el); }
        }} />
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
          // PROPERTIES_PANEL::onCharHook: Enter / Down / Up / Tab commit first (a refused value keeps the editor open,
          // wxPG_VFB_STAY_IN_PROPERTY), then move; Esc reverts and gives the keyboard back to the frame
          const nav = navOf(ev);
          if (nav) { ev.preventDefault(); ev.stopPropagation(); const el = ev.currentTarget; if (draft === null || commit(draft)) { settled.current = true; moveFrom(el, nav); if (document.activeElement === el) settled.current = false; } else el.select(); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); setDraft(null); setErr(null); settled.current = true; releaseKeyboard(ev.currentTarget); }
          else ev.stopPropagation();
        }} />
      {err ? <span className="absolute right-0 top-full z-10 px-1.5 py-0.5 bg-panel border border-err text-err text-xs whitespace-nowrap shadow-panel" data-prop-error>{err}</span> : null}
    </>
  );
}

const SPLIT_KEY = "kui.props.splitter";
function loadSplit(): number { try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v > 0.05 && v < 0.95 ? v : 0.5; } catch (e) { return 0.5; } }

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
  // m_splitter_key_proportion: the name column's share of the width; CenterSplitter until it is dragged
  const [split, setSplit] = useState(loadSplit);
  const gridBox = useRef<HTMLDivElement>(null);
  const dragSplit = (ev: React.PointerEvent<HTMLElement>) => {
    const box = gridBox.current; if (!box) return; ev.preventDefault(); ev.stopPropagation();
    const el = ev.currentTarget; el.setPointerCapture(ev.pointerId); let last = split;
    const move = (e: PointerEvent) => { const r = box.getBoundingClientRect(); last = Math.max(0.1, Math.min(0.9, (e.clientX - r.left) / Math.max(1, r.width))); setSplit(last); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); try { localStorage.setItem(SPLIT_KEY, String(+last.toFixed(4))); } catch (e) { /* no storage */ } };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  const grid: PropGrid = useMemo(() => {
    const p = panels();
    try { return p ? p.propGrid() : { title: "No objects selected", count: 0, groups: [], readOnly: true }; }
    catch (e) { console.warn(e); return { title: "No objects selected", count: 0, groups: [], readOnly: true }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selV, appSel, docV, docId, units, viewOnly, tick]);
  const toggle = (g: string) => { const n = Object.assign({}, collapsed, { [g]: !collapsed[g] }); setCollapsed(n); try { localStorage.setItem("kui.props.collapsed", JSON.stringify(n)); } catch (e) { /* no storage */ } };
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="props">
      {/* m_caption: a plain wxStaticText with a 5 px border above the grid */}
      <div className="kprop-caption flex-none p-[5px] overflow-hidden text-ellipsis whitespace-nowrap" data-prop-title title={grid.note}>{grid.title}</div>
      <div className="flex-auto min-h-0 overflow-auto border-t border-line" ref={gridBox}>
        {grid.groups.map((g) => (
          <div key={g.name} data-prop-group={g.name}>
            <div className="flex items-center h-[20px] px-1 bg-bench border-b border-line font-semibold cursor-default select-none" onClick={() => toggle(g.name)}>
              <span className="inline-block w-3.5 text-ink-2 text-xs">{collapsed[g.name] ? "▸" : "▾"}</span>{g.name}
            </div>
            {collapsed[g.name] ? null : g.rows.map((r) => (
              <div key={r.id} className="kprop d-grid h-[21px] border-b border-line-soft" style={{ gridTemplateColumns: `minmax(0,${(split * 100).toFixed(2)}%) minmax(0,1fr)` }} data-prop-row={r.id}>
                <span className={cx("relative pl-[18px] pr-1 leading-[20px] overflow-hidden text-ellipsis whitespace-nowrap border-r border-line-soft", r.readOnly && "text-ink-3")} title={r.name}>{r.name}
                  <span className="kprop-split absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize z-1" onPointerDown={dragSplit} /></span>
                <span className="relative min-w-0"><Editor row={r} onDone={() => setTick((t) => t + 1)} /></span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
