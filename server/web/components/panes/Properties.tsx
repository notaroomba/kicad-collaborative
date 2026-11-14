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
import { rowValueText } from "./prop-text";
import { KIcon } from "../Icon";
import { ContextMenu, panels, useContextMenu, usePanels, type MenuItem } from "./widgets";

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
/** PROPERTIES_PANEL::onCharHook Ctrl+C: with no editor text selected, the selected property's value goes to the clipboard. */
function copyRow(ev: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; currentTarget: EventTarget | null; preventDefault(): void; stopPropagation(): void }, row: PropRow): boolean {
  if (ev.key.toLowerCase() !== "c" || !(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return false;
  const el = ev.currentTarget as HTMLElement;
  // an open editor with a selection runs its own copy
  if (el instanceof HTMLInputElement && el.type === "text" && el.selectionStart !== null && el.selectionEnd !== null && el.selectionEnd > el.selectionStart) return false;
  ev.preventDefault(); ev.stopPropagation();
  const text = rowValueText(row);
  try { if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* no clipboard */ }
  return true;
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
        if (copyRow(ev, row)) return;
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
          if (copyRow(ev, row)) return;
          const nav = navOf(ev);
          if (nav) { ev.preventDefault(); ev.stopPropagation(); moveFrom(el, nav); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); releaseKeyboard(el); }
        }} />
    );
  }
  const shown = draft !== null ? draft : row.value;
  // PG_FPID_EDITOR / PG_URL_EDITOR: a wxPGMultiButton at the editor's right edge (small_library; small_folder while the
  // datasheet is empty, www once it holds something), shown while the property is being edited or pointed at
  const browseIcon = row.browse === "footprint" ? "small_library" : row.browse === "url" ? (!shown.trim() || shown.trim() === "~" ? "small_folder" : "www") : null;
  const browseTip = row.browse === "footprint" ? "Browse for footprint" : browseIcon === "www" ? "Show datasheet in browser" : "Open file";
  return (
    <>
      {browseIcon ? <button type="button" tabIndex={-1} title={browseTip} data-prop-browse={row.id} data-icon={browseIcon}
        className="absolute right-0 top-0 bottom-0 z-1 w-[20px] p-0 flex items-center justify-center bg-transparent border-0 rounded-xs text-ink-2 invisible group-hover:visible group-focus-within:visible hover:bg-sel-soft"
        onPointerDown={(ev) => ev.preventDefault()}
        onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); const p = panels(); if (!p) return; if (draft !== null && !commit(draft)) return; settled.current = false; p.browseProp(row.id); }}>
        <KIcon name={browseIcon} size={16} /></button> : null}
      <input type="text" className={cx(CELL, browseIcon && "pr-[20px]", row.readOnly && "text-ink-3", err && "shadow-[inset_0_0_0_1px_var(--color-err)]")} data-prop={row.id} spellCheck={false} autoComplete="off"
        readOnly={row.readOnly} value={shown} placeholder={row.mixed ? MIXED : ""} title={err || (row.type === "longtext" ? row.value : undefined)}
        onFocus={(ev) => { if (!row.readOnly) ev.target.select(); }}
        onChange={(ev) => { setDraft(ev.target.value); setErr(null); }}
        onBlur={() => { if (settled.current) { settled.current = false; return; } if (draft !== null && !commit(draft)) { setDraft(null); setErr(null); } }}
        onKeyDown={(ev) => {
          // wxPropertyGrid: Enter commits and Esc reverts, and either closes the cell editor so the next keys
          // (Ctrl+Z, hotkeys) go to the frame again; a value the item refused keeps the editor open
          // PROPERTIES_PANEL::onCharHook: Enter / Down / Up / Tab commit first (a refused value keeps the editor open,
          // wxPG_VFB_STAY_IN_PROPERTY), then move; Esc reverts and gives the keyboard back to the frame
          if (draft === null && copyRow(ev, row)) return;
          const nav = navOf(ev);
          if (nav) { ev.preventDefault(); ev.stopPropagation(); const el = ev.currentTarget; if (draft === null || commit(draft)) { settled.current = true; moveFrom(el, nav); if (document.activeElement === el) settled.current = false; } else el.select(); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); setDraft(null); setErr(null); settled.current = true; releaseKeyboard(ev.currentTarget); }
          else ev.stopPropagation();
        }} />
      {err ? <span className="absolute right-0 top-full z-10 px-1.5 py-0.5 bg-panel border border-err text-err text-xs whitespace-nowrap shadow-panel" data-prop-error>{err}</span> : null}
    </>
  );
}

/**
 * The label column's editor (wxPropertyGrid::BeginLabelEdit on a MakeColumnEditable( 0 ) grid): Enter or leaving it
 * renames the property (onLabelEditEnding), Esc gives the old name back — and a property just added from the panel
 * that is left blank (or given a name already in use) is taken away again (onNewItemLeftBlank).
 */
function LabelEditor({ row, pending, onEnd }: { row: PropRow; pending: boolean; onEnd: () => void }) {
  const [text, setText] = useState(pending ? "" : row.name);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return; done.current = true;
    const p = panels();
    if (p) { if (commit) p.renamePropKey(row.id, text, pending); else if (pending) p.removePropKey(row.id); }
    onEnd();
  };
  return <input type="text" autoFocus className={cx(CELL, "absolute inset-0 pl-[18px]")} data-prop-label-editor={row.id} spellCheck={false} autoComplete="off" value={text}
    onFocus={(ev) => ev.target.select()} onChange={(ev) => setText(ev.target.value)} onBlur={() => finish(true)}
    onKeyDown={(ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    }} />;
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
  // ORIGIN_TRANSFORMS: the coordinate rows follow Preferences > PCB Editor > Origins & Axes
  const originKey = useApp((s) => `${(s.viewport.userOrigin || [0, 0]).join(",")}|${s.viewport.invertX ? 1 : 0}|${s.viewport.invertY ? 1 : 0}`);
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
  }, [selV, appSel, docV, docId, units, originKey, viewOnly, tick]);
  // the label being edited: a row id, and whether that row was just added (addBlankField / addBlankCustomProperty)
  const [labelEdit, setLabelEdit] = useState<{ id: string; pending: boolean } | null>(null);
  const menu = useContextMenu();
  const addKey = (what: "Add Field" | "Add Custom Property") => {
    const p = panels(); if (!p) return;
    const id = p.addPropKey(what === "Add Field" ? "field" : "custom");
    if (id) { setTick((t) => t + 1); setLabelEdit({ id, pending: true }); }
  };
  const removeKey = (id: string) => { const p = panels(); if (p && p.removePropKey(id)) setTick((t) => t + 1); };
  /** PCB_PROPERTIES_PANEL::buildContextMenu: on a category, its Add entry; on a field or custom property, Remove then Add. */
  const menuFor = (g: { name: string; add?: "Add Field" | "Add Custom Property" }, r: PropRow | null): MenuItem[] => {
    const out: MenuItem[] = [];
    if (!g.add) return out;
    if (r) {
      if (g.name === "Fields" && r.keyEditable) out.push({ label: "Remove Field", run: () => removeKey(r.id) });
      else if (g.name === "Custom Properties") out.push({ label: "Remove Custom Property", run: () => removeKey(r.id) });
    }
    out.push({ label: g.add, run: () => addKey(g.add!) });
    return out;
  };
  const toggle = (g: string) => { const n = Object.assign({}, collapsed, { [g]: !collapsed[g] }); setCollapsed(n); try { localStorage.setItem("kui.props.collapsed", JSON.stringify(n)); } catch (e) { /* no storage */ } };
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="props">
      {/* m_caption: a plain wxStaticText with a 5 px border above the grid */}
      <div className="kprop-caption flex-none p-[5px] overflow-hidden text-ellipsis whitespace-nowrap" data-prop-title title={grid.note}>{grid.title}</div>
      <div className="flex-auto min-h-0 overflow-auto border-t border-line" ref={gridBox}>
        {grid.groups.map((g) => (
          <div key={g.name} data-prop-group={g.name}>
            <div className="flex items-center h-[20px] px-1 bg-bench border-b border-line font-semibold cursor-default select-none" onClick={() => toggle(g.name)}
              onContextMenu={(ev) => { const items = menuFor(g, null); if (items.length) menu.open(ev, items); else ev.preventDefault(); }}>
              <span className="inline-block w-3.5 text-ink-2 text-xs">{collapsed[g.name] ? "▸" : "▾"}</span><span className="flex-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{g.name}</span>
              {/* addCategoryButton: the small "+" at the category row's right edge */}
              {g.add ? <button type="button" className="tbtn flex-none flex items-center justify-center w-[16px] h-[16px] p-0 bg-transparent border border-transparent text-ink-2" title={g.add} data-prop-add={g.name}
                onClick={(ev) => { ev.stopPropagation(); addKey(g.add!); }}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" /></svg></button> : null}
            </div>
            {collapsed[g.name] ? null : g.rows.map((r) => (
              <div key={r.id} className="kprop d-grid h-[21px] border-b border-line-soft" style={{ gridTemplateColumns: `minmax(0,${(split * 100).toFixed(2)}%) minmax(0,1fr)` }} data-prop-row={r.id}>
                <span className={cx("relative pl-[18px] pr-1 leading-[20px] overflow-hidden text-ellipsis whitespace-nowrap border-r border-line-soft outline-none focus:bg-sel", r.readOnly && "text-ink-3")} title={r.name}
                  tabIndex={-1} data-prop-label={r.id}
                  onDoubleClick={() => { if (r.keyEditable) setLabelEdit({ id: r.id, pending: false }); }}
                  onKeyDown={(ev) => { if (copyRow(ev, r)) return; if (ev.key === "F2" && r.keyEditable) { ev.preventDefault(); ev.stopPropagation(); setLabelEdit({ id: r.id, pending: false }); } }}
                  onContextMenu={(ev) => { const items = menuFor(g, r); if (items.length) menu.open(ev, items); else ev.preventDefault(); }}>{r.name}
                  {labelEdit && labelEdit.id === r.id ? <LabelEditor row={r} pending={labelEdit.pending} onEnd={() => { setLabelEdit(null); setTick((t) => t + 1); }} /> : null}
                  <span className="kprop-split absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize z-1" onPointerDown={dragSplit} /></span>
                <span className="relative min-w-0 group"><Editor row={r} onDone={() => setTick((t) => t + 1)} /></span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}
