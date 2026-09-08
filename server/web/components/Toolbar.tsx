// Toolbar.tsx — KiCad's four toolbars (top main, top aux, left options, right draw tools) built
// from the generated spec: plain buttons, split-button groups with a palette (click the arrow or
// press-and-hold, like wx), separators and the aux bar's controls.  The vertical bars are a single
// scrolling column.  The right bar also carries the collab tools app.js keeps in its File menu on
// the desktop, and a hidden `#ltools` marker that tells sch-tools which tool is active.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { actionMeta, isControl, isGroup, isSep, SPEC, type ActionItem, type ControlItem, type GroupItem, type ToolbarItem, type ToolbarLoc } from "../spec";
import { EXTRA_TOOLS, TRACK_WIDTHS, VIA_SIZES, ZOOM_PRESETS, toolFor } from "../tables";
import { dispatch, useApp, type Editor } from "../store";
import { isOn, keyFor, runUiAction, titleFor, unavailable, useAvail, type Avail } from "../actions";
import { cx } from "../util";
import { Glyph, KIcon } from "./Icon";

function useEditor(): Editor | null { return useApp((s) => s.document.editor); }

// ---------------------------------------------------------------- the look (Tailwind utilities)
/* `kb`, `on`, `desk`, `kmain`, `glyph`, `ktb`, `ktb-v`, `karrow`, … stay as hook classes (this file and
   sch-tools query them); the styling is entirely the utilities that follow them. */
const KB = "kb relative w-7.5 h-7.5 p-0.5 border border-transparent rounded-[3px] bg-transparent text-ink inline-flex items-center justify-center flex-none"
  + " hover:bg-paper hover:border-line on:bg-on on:border-on-line on:shadow-[inset_0_1px_2px] on:shadow-black/[13.3%] desk:opacity-[.38] desk:hover:opacity-70 active:translate-y-px";
/* No KiCad toolbar ever wraps: wxAuiToolBar keeps its one row (or column) and hides the tools that do
   not fit behind an overflow chevron that pops them up as a menu — ACTION_TOOLBAR's
   `SetOverflowVisible( !GetToolBarFits() )` (common/tool/action_toolbar.cpp:259-266).  OverflowBar
   below does the same on both axes, so nothing is ever cut off at the window edge and the canvas
   never loses height to a second row of buttons.
   In each bar the outer box is the grid cell and holds the chevron; the inner track is what clips,
   so the chevron always stays inside the window even when the tools do not. */
const KTB = "ktb flex items-stretch bg-bench border-b border-line min-w-0";
const KTB_INNER = "ktb-row flex flex-row flex-nowrap items-center justify-start gap-px px-1 py-0.5 flex-1 min-w-0 overflow-hidden [&>*]:flex-none";
const KTB_V = "ktb ktb-v flex flex-col items-center min-h-0 w-8.5 bg-bench";
const KTB_V_INNER = "ktb-col flex flex-col flex-nowrap items-center justify-start gap-px px-0.5 py-1 w-full flex-1 min-h-0 overflow-hidden [&>*]:flex-none";
/* the overflow chevron: KB's look without KB's `relative`, so it stays a plain flex item at the end of the bar */
const KMORE = "kb kmore flex-none w-7.5 h-7.5 p-0.5 border border-transparent rounded-[3px] bg-transparent text-ink-2 inline-flex items-center justify-center"
  + " hover:bg-paper hover:border-line hover:text-ink [&[hidden]]:hidden";
const KSEL = "ksel bg-panel border border-line rounded-[3px] px-1 py-0.5 h-6 text-sm text-ink max-w-[170px]";

// ---------------------------------------------------------------- buttons
function ActionButton({ item, a, main }: { item: ActionItem; a: Avail; main?: boolean }) {
  const tool = useApp((s) => s.tool.current);
  const toggles = useApp((s) => s.toggles);
  const panes = useApp((s) => s.panes);
  const id = item.id;
  const meta = actionMeta(id) || item;
  const tid = toolFor(a.editor, id);
  const why = unavailable(a, id);
  const on = tid ? tool === tid : isOn(id, toggles, panes);
  const menuHandled = a.handled.has(id + ":menu");
  return (
    <button type="button" className={cx(KB, main && "kmain", why && "desk", on && "on")} data-uiact={id} data-ktool={tid || undefined}
      title={titleFor(a, id)} onClick={(ev) => runUiAction(a, id, ev.currentTarget)}
      onContextMenu={menuHandled ? (ev) => { ev.preventDefault(); dispatch({ type: "action", id: id + ":menu", anchor: rectOf(ev.currentTarget) }); } : undefined}>
      <KIcon name={meta.icon || "options_generic"} />
    </button>
  );
}
function rectOf(el: Element) { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }

/** KiCad's line-mode actions share one friendly name; when a group's labels collide, show the tooltips. */
function paletteLabel(it: ActionItem, group: GroupItem): string {
  const labels = group.items.map((x) => (actionMeta(x.id) || x).label || x.id);
  const m = actionMeta(it.id) || it;
  return new Set(labels).size < labels.length && m.tip ? m.tip : (m.label || it.id);
}

function Palette({ group, wrap, a, onClose }: { group: GroupItem; wrap: HTMLElement; a: Avail; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const groupCurrent = useApp((s) => s.groupCurrent);
  const cur = groupCurrent[group.group] || group.items[0].id;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const r = wrap.getBoundingClientRect(); const vertical = !!wrap.closest(".ktb-v"); const onRight = !!wrap.closest("#tbRight");
    const w = ref.current ? ref.current.offsetWidth : 200;
    const left = vertical ? (onRight ? r.left - w - 4 : r.right + 4) : r.left;
    const top = vertical ? r.top : r.bottom + 2;
    setStyle({ left: Math.max(4, Math.min(left, window.innerWidth - w - 4)) + "px", top: Math.max(4, Math.min(top, window.innerHeight - (ref.current ? ref.current.offsetHeight : 0) - 4)) + "px" });
  }, [wrap]);
  useEffect(() => {
    const down = (ev: PointerEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener("pointerdown", down, true), 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", down, true); };
  }, [onClose]);
  return createPortal(
    <div className="kpalette fixed z-70 bg-panel border border-line rounded-sm shadow-panel p-1 min-w-50" ref={ref} style={style}>
      {group.items.map((it) => {
        const why = unavailable(a, it.id); const k = keyFor(a, it.id);
        return (
          <button type="button" key={it.id} title={titleFor(a, it.id)} data-uiact={it.id}
            className={cx("krow group flex items-center gap-2 w-full bg-transparent border-0 rounded-xs px-2 py-1 text-ink text-left hover:bg-blue hover:text-white cur:shadow-[inset_2px_0_0_var(--color-copper)] desk:opacity-[.45]",
              why && "desk", cur === it.id && "cur")}
            onClick={(ev) => { onClose(); dispatch({ type: "setGroupCurrent", group: group.group, id: it.id }); runUiAction(a, it.id, ev.currentTarget); }}>
            <KIcon name={(actionMeta(it.id) || it).icon || "options_generic"} />
            <span className="flex-1">{paletteLabel(it, group)}</span>
            {k ? <kbd className="text-xs font-mono font-normal leading-[normal] text-ink-3 group-hover:text-white">{k}</kbd> : null}
          </button>
        );
      })}
    </div>, document.body);
}

function GroupButton({ group, a }: { group: GroupItem; a: Avail }) {
  const wrap = useRef<HTMLDivElement>(null);
  const groupCurrent = useApp((s) => s.groupCurrent);
  const view = useApp((s) => s.view);
  const [open, setOpen] = useState(false);
  const hold = useRef<number>(0);
  useEffect(() => { if (view !== "editor") setOpen(false); }, [view]);
  const cur = groupCurrent[group.group] || group.items[0].id;
  const item = group.items.find((i) => i.id === cur) || group.items[0];
  const openPalette = () => setOpen(true);
  return (
    <div className="kgroup relative flex-none" data-group={group.group} ref={wrap}
      onPointerDown={(ev) => { if ((ev.target as Element).closest(".karrow")) return; hold.current = window.setTimeout(openPalette, 450); }}
      onPointerUp={() => clearTimeout(hold.current)} onPointerLeave={() => clearTimeout(hold.current)}>
      <ActionButton item={item} a={a} main />
      <button type="button" className="karrow absolute right-0 bottom-0 w-2.5 h-2.5 p-0 border-0 bg-transparent text-ink-2 d-grid place-items-center" title={group.group} onClick={(ev) => { ev.stopPropagation(); setOpen((o) => !o); }}>
        <svg className="w-[7px] h-[7px]" viewBox="0 0 8 8"><path d="M1 2.5h6L4 6z" fill="currentColor" /></svg>
      </button>
      {open && wrap.current ? <Palette group={group} wrap={wrap.current} a={a} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- the aux bar's controls
function Control({ item }: { item: ControlItem }) {
  const c = item.control;
  const gridPitch = useApp((s) => s.viewport.gridPitch);
  const gridChoices = useApp((s) => s.viewport.gridChoices);
  const zoom = useApp((s) => s.viewport.zoom);
  const copper = useApp((s) => s.document.copperLayers);
  const activeLayer = useApp((s) => s.viewport.activeLayer);
  const [trackW, setTrackW] = useState(String(TRACK_WIDTHS[0]));
  const [viaD, setViaD] = useState(String(VIA_SIZES[0]));
  if (c === "ipcScripting") return null;
  let inner: ReactElement | null = null;
  if (c === "currentVariant") inner = <select className={KSEL} title="Select the current variant to display and edit." defaultValue="default"><option value="default">&lt; Default &gt;</option></select>;
  else if (c === "overrideLocks") inner = <label className="kcheck inline-flex items-center gap-1 text-sm whitespace-nowrap" title="Allow editing locked items"><input type="checkbox" /> Override locks</label>;
  else if (c === "trackWidth") inner = <select id="trackWidthSel" className={KSEL} title="Select the track width" value={trackW} onChange={(ev) => setTrackW(ev.target.value)}>{TRACK_WIDTHS.map((v) => <option key={v} value={v}>{v} mm</option>)}</select>;
  else if (c === "viaDiameter") inner = <select id="viaSizeSel" className={KSEL} title="Select the via size" value={viaD} onChange={(ev) => setViaD(ev.target.value)}>{VIA_SIZES.map((v) => <option key={v} value={v}>{v} mm</option>)}</select>;
  else if (c === "viaStack") inner = <select className={KSEL} title="Via stack" defaultValue="Through"><option>Through</option></select>;
  else if (c === "layerSelector") inner = (
    <select id="layerSel" className={KSEL + " klayer"} title="Active layer" value={activeLayer} onChange={(ev) => dispatch({ type: "setActiveLayer", layer: ev.target.value })}>
      {copper.map((l) => <option key={l.name} value={l.name} style={{ color: l.color }}>{l.name}</option>)}
    </select>);
  else if (c === "gridSelect") inner = (
    <select id="gridSel" className={KSEL} title="Grid" value={String(gridPitch)} onChange={(ev) => dispatch({ type: "setGrid", pitch: Number(ev.target.value) })}>
      {gridChoices.map(([v, label]) => <option key={v} value={String(v)}>{label}</option>)}
      {gridChoices.some(([v]) => v === gridPitch) ? null : <option value={String(gridPitch)}>{gridPitch} mm</option>}
    </select>);
  else if (c === "zoomSelect") {
    const preset = ZOOM_PRESETS.find((z) => Math.abs(z / 100 - zoom) < 1e-6);
    inner = (
      <select id="zoomSel" className={KSEL} title="Zoom" value={preset ? String(preset) : "auto"} onChange={(ev) => dispatch({ type: "setZoom", zoom: ev.target.value === "auto" ? "auto" : Number(ev.target.value) })}>
        <option value="auto">Auto</option>
        {ZOOM_PRESETS.map((z) => <option key={z} value={String(z)}>{z}%</option>)}
      </select>);
  }
  return <span className="kctl inline-flex items-center gap-1 mx-[3px] flex-none" data-control={c}>{inner}</span>;
}

// ---------------------------------------------------------------- bars
/** A 1px rule: 22px tall in the horizontal bars, 22px wide in the vertical ones. */
function Sep({ v }: { v?: boolean }) {
  return <span className={cx("ksep flex-none bg-line", v ? "w-5.5 h-px my-[3px]" : "w-px h-5.5 mx-[3px]")} />;
}
function Items({ items, a, v }: { items: ToolbarItem[]; a: Avail; v?: boolean }) {
  return (
    <>
      {items.map((it, i) => {
        if (isSep(it)) return <Sep v={v} key={"s" + i} />;
        if (isGroup(it)) return <GroupButton group={it} a={a} key={"g" + it.group + i} />;
        if (isControl(it)) return <Control item={it} key={"c" + it.control + i} />;
        return <ActionButton item={it} a={a} key={it.id + i} />;
      })}
    </>
  );
}
function useBar(loc: ToolbarLoc): ToolbarItem[] {
  const editor = useEditor();
  return (editor && SPEC.toolbars[editor] && SPEC.toolbars[editor][loc]) || [];
}

export function TopToolbar() {
  const a = useAvail(); const items = useBar("top");
  const groupCurrent = useApp((s) => s.groupCurrent);
  return <OverflowBar id="tbTop" cls="min-h-8.5" a={a} entries={barEntries(items, a, groupCurrent)} />;
}
export function AuxToolbar() {
  const a = useAvail(); const items = useBar("aux");
  const groupCurrent = useApp((s) => s.groupCurrent);
  return <OverflowBar id="tbAux" cls="min-h-7.5 [&[hidden]]:hidden" a={a} entries={barEntries(items, a, groupCurrent)} hidden={!items.length} />;
}
// ---------------------------------------------------------------- overflow (wxAuiToolBar's chevron)
/** One entry of a bar: what to draw in the bar, and what the overflow menu should list for it. */
interface BarEntry { key: string; node: ReactNode; menu?: { id: string; label: string; icon?: string | null; glyph?: string; control?: boolean } | null }

/** The aux bar's controls, titled as wxAuiToolBar's overflow menu titles them (the tool's label). */
const CONTROL_LABELS: Record<string, string> = { currentVariant: "Current variant", overrideLocks: "Override locks", trackWidth: "Track width",
  viaDiameter: "Via size", viaStack: "Via stack", layerSelector: "Active layer", gridSelect: "Grid", zoomSelect: "Zoom" };

/** The overflow menu: the tools that did not fit, in bar order, as a wxAUI drop-down. */
function OverflowMenu({ entries, anchor, onRight, vertical, a, onClose }: { entries: BarEntry[]; anchor: HTMLElement; onRight: boolean; vertical: boolean; a: Avail; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current ? ref.current.offsetWidth : 220, h = ref.current ? ref.current.offsetHeight : 200;
    // a side bar's menu opens beside the bar; a top bar's drops straight down from the chevron, right-aligned to it
    const left = vertical ? (onRight ? r.left - w - 4 : r.right + 4) : r.right - w;
    const top = vertical ? Math.min(r.bottom - h, window.innerHeight - h - 4) : r.bottom + 2;
    setStyle({ left: Math.max(4, Math.min(left, window.innerWidth - w - 4)) + "px", top: Math.max(4, Math.min(top, window.innerHeight - h - 4)) + "px" });
  }, [anchor, onRight, vertical, entries.length]);
  useEffect(() => {
    const down = (ev: PointerEvent) => { if (ref.current && !ref.current.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener("pointerdown", down, true), 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", down, true); };
  }, [anchor, onClose]);
  return createPortal(
    <div className="kpalette koverflow fixed z-70 bg-panel border border-line rounded-sm shadow-panel p-1 min-w-50 max-h-[80vh] overflow-y-auto" ref={ref} style={style}>
      {entries.map((e) => {
        const m = e.menu!;
        // wxAuiToolBar cannot re-parent a control into its overflow menu, so it lists it as a
        // disabled item (wx/aui/auibar.cpp OnOverflowClick) — the label alone, exactly as here.
        if (m.control) return <div key={e.key} className="krow flex items-center gap-2 w-full rounded-xs px-2 py-1 text-ink-3 text-left opacity-60">{m.label}</div>;
        const why = unavailable(a, m.id); const k = keyFor(a, m.id);
        return (
          <button type="button" key={e.key} title={titleFor(a, m.id)} data-uiact={m.id}
            className={cx("krow group flex items-center gap-2 w-full bg-transparent border-0 rounded-xs px-2 py-1 text-ink text-left hover:bg-blue hover:text-white desk:opacity-[.45]", why && "desk")}
            onClick={(ev) => { onClose(); runUiAction(a, m.id, ev.currentTarget); }}>
            {m.glyph ? <Glyph svg={m.glyph} /> : <KIcon name={m.icon || "options_generic"} />}
            <span className="flex-1">{m.label}</span>
            {k ? <kbd className="text-xs font-mono font-normal leading-[normal] text-ink-3 group-hover:text-white">{k}</kbd> : null}
          </button>
        );
      })}
    </div>, document.body);
}

/**
 * A toolbar that behaves like wxAuiToolBar when it does not fit: the tools that would be clipped
 * stay laid out (so the measurement never oscillates) but are made invisible, and an overflow
 * chevron at the end of the bar pops them up as a menu.  Before this the vertical bars ran off the
 * bottom of the window (on 1280x780, 15 of the board's 34 draw tools — delete, measure, comment and
 * pan among them — were unreachable) and the horizontal bars wrapped into a second row, which
 * wxAuiToolBar never does and which stole 19-30 px of canvas at common laptop widths.
 */
function OverflowBar({ id, cls, entries, a, tail, vertical, hidden }: { id: string; cls: string; entries: BarEntry[]; a: Avail; tail?: ReactNode; vertical?: boolean; hidden?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [cut, setCut] = useState(-1);
  const [open, setOpen] = useState(false);
  const cutRef = useRef(-1);
  const chevron = useRef(30);
   // KMORE is a 30 px button; re-measured from the DOM the first time it is shown
  const view = useApp((s) => s.view);
  /**
   * Which tools fit.  Measured against the OUTER box, whose size along the bar does not depend on the
   * answer — the track is `flex-1`, so asking it would make showing the chevron shrink the space that
   * decides whether to show it, and a bar that fits by a hair would flip-flop for ever.  The items keep
   * their boxes either way (`justify-start`, fixed sizes), so their offsets are a stable input too.
   *
   * The offsets are taken as client-rect deltas from the TRACK's own leading edge.  `offsetTop` /
   * `offsetLeft` would be measured from the nearest positioned ancestor — which for these buttons is
   * the document body — so they carry the bar's distance from the top of the page (102 px, more once
   * the top bars are two rows deep) and comparing them against a height cut the bar far too early.
   */
  const measure = useCallback(() => {
    const el = ref.current, outer = box.current; if (!el || !outer) return;
    // the track's own children are the tools, in `entries` order; `#ltools` is a marker, not a tool
    const kids = Array.from(el.children).filter((k) => k.id !== "ltools") as HTMLElement[];
    let n = -1;
    if (kids.length) {
      const cs = getComputedStyle(el);
      const pad = parseFloat(vertical ? cs.paddingBottom : cs.paddingRight) || 0;
      const moreEl = more.current;
      const moreSize = moreEl && (vertical ? moreEl.offsetHeight : moreEl.offsetWidth);
      if (moreSize) chevron.current = moreSize;
      const trackRect = el.getBoundingClientRect();
      const start = vertical ? trackRect.top : trackRect.left;
      const full = vertical ? outer.clientHeight : outer.clientWidth;
      const endOf = (k: HTMLElement) => { const r = k.getBoundingClientRect(); return (vertical ? r.bottom : r.right) - start; };
      if (endOf(kids[kids.length - 1]) + pad > full + 0.5) {
        const limit = full - chevron.current - pad;
        n = kids.findIndex((k) => endOf(k) > limit);
        n = n < 0 ? kids.length : Math.max(n, 1);
      }
    }
    // hide the tail without taking it out of the flow, so the next measurement sees the same boxes
    kids.forEach((k, i) => { const off = n >= 0 && i >= n; k.style.visibility = off ? "hidden" : ""; k.style.pointerEvents = off ? "none" : ""; });
    if (n !== cutRef.current) { cutRef.current = n; setCut(n); }
  }, [vertical]);
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const outer = box.current; if (!outer) return;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(outer);
    window.addEventListener("resize", measure);
    // web fonts and the icon sheet land after the first layout and change every button's size
    if (typeof document !== "undefined" && (document as any).fonts && (document as any).fonts.ready) (document as any).fonts.ready.then(measure).catch(() => {});
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);
  useEffect(() => { if (cut < 0 || view !== "editor") setOpen(false); }, [cut, view]);
  const hiddenEntries = cut >= 0 ? entries.slice(cut).filter((e) => e.menu) : [];
  return (
    <div id={id} className={cx(vertical ? KTB_V : KTB, cls)} ref={box} hidden={hidden}>
      <div className={vertical ? KTB_V_INNER : KTB_INNER} ref={ref}>
        {entries.map((e) => <Fragment key={e.key}>{e.node}</Fragment>)}
        {tail}
      </div>
      <button type="button" ref={more} data-more="" hidden={cut < 0} title="More tools" aria-label="More tools"
        className={cx(KMORE, vertical ? "mb-1" : "self-center mr-1")} onClick={() => setOpen((o) => !o)}>
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4l5 4 5-4M3 9l5 4 5-4" /></svg>
      </button>
      {open && cut >= 0 && more.current && hiddenEntries.length
        ? <OverflowMenu entries={hiddenEntries} anchor={more.current} onRight={id === "tbRight"} vertical={!!vertical} a={a} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The spec's items as bar entries, each carrying what the overflow menu should show for it. */
function barEntries(items: ToolbarItem[], a: Avail, groupCurrent: Record<string, string>, vertical?: boolean): BarEntry[] {
  return items.map((it, i) => {
    if (isSep(it)) return { key: "s" + i, node: <Sep v={vertical} />, menu: null };
    if (isGroup(it)) {
      const cur = groupCurrent[it.group] || it.items[0].id;
      const item = it.items.find((x) => x.id === cur) || it.items[0];
      const meta = actionMeta(item.id) || item;
      return { key: "g" + it.group + i, node: <GroupButton group={it} a={a} />, menu: { id: item.id, label: meta.label || item.id, icon: meta.icon } };
    }
    if (isControl(it)) return { key: "c" + it.control + i, node: <Control item={it} />,
      menu: it.control === "ipcScripting" ? null : { id: "", label: CONTROL_LABELS[it.control] || it.control, control: true } };
    const meta = actionMeta(it.id) || it;
    return { key: it.id + i, node: <ActionButton item={it} a={a} />, menu: { id: it.id, label: meta.label || it.id, icon: meta.icon } };
  });
}

export function LeftOptionsToolbar() {
  const a = useAvail(); const items = useBar("left");
  const groupCurrent = useApp((s) => s.groupCurrent);
  return <OverflowBar id="tbLeft" cls="border-r border-line" vertical a={a} entries={barEntries(items, a, groupCurrent, true)} />;
}
export function RightDrawToolbar() {
  const a = useAvail(); const items = useBar("right");
  const tool = useApp((s) => s.tool.current);
  const groupCurrent = useApp((s) => s.groupCurrent);
  const moduleTools = useApp((s) => s.tool.moduleTools);
  const isModuleTool = a.moduleTools.has(tool);
  const entries = barEntries(items, a, groupCurrent, true);
  entries.push({ key: "extrasep", node: <Sep v />, menu: null });
  for (const e of EXTRA_TOOLS) {
    const avail = a.appTools.has(e.tool);
    entries.push({
      key: e.id,
      node: (
        <button type="button" className={cx(KB, "glyph", !avail && "desk", tool === e.tool && "on")} data-uiact={e.id} data-ktool={e.tool}
          title={e.name + (avail && e.key ? `  (${e.key})` : "")} onClick={(ev) => runUiAction(a, e.id, ev.currentTarget)}>
          <Glyph svg={e.glyph} />
        </button>
      ),
      menu: { id: e.id, label: e.name, glyph: e.glyph },
    });
  }
  return (
    <OverflowBar id="tbRight" cls="border-l border-line" vertical a={a} entries={entries}
      // sch-tools.js reads `#ltools .tb.on` (data-modtool / data-tool) for the active tool and
      // `#ltools [data-modtool="wire"]` to know the schematic module is in charge.
      tail={
        <span id="ltools" hidden>
          <i className="tb on" data-modtool={isModuleTool ? tool : undefined} data-tool={isModuleTool ? undefined : tool} />
          {moduleTools.map((t) => <i key={t.id} className="tb" data-modtool={t.id} />)}
        </span>
      } />
  );
}
