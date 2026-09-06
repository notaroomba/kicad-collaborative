// Toolbar.tsx — KiCad's four toolbars (top main, top aux, left options, right draw tools) built
// from the generated spec: plain buttons, split-button groups with a palette (click the arrow or
// press-and-hold, like wx), separators and the aux bar's controls.  The vertical bars are a single
// scrolling column.  The right bar also carries the collab tools app.js keeps in its File menu on
// the desktop, and a hidden `#ltools` marker that tells sch-tools which tool is active.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
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
/* horizontal bars (top / aux): wrap when the window is narrow */
const KTB = "ktb flex items-center flex-wrap gap-px px-1 py-0.5 bg-bench border-b border-line min-w-0";
/* vertical bars never wrap into a second column: they scroll (wheel / touch) when the window is short, like KiCad's overflow chevron */
const KTB_V = "ktb ktb-v flex flex-col flex-nowrap items-center justify-start gap-px px-0.5 py-1 bg-bench min-h-0 w-8.5 overflow-y-auto overflow-x-hidden scrollbar-none [&>*]:flex-none";
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
  return <div id="tbTop" className={cx(KTB, "min-h-8.5")}><Items items={items} a={a} /></div>;
}
export function AuxToolbar() {
  const a = useAvail(); const items = useBar("aux");
  return <div id="tbAux" className={cx(KTB, "min-h-7.5 [&[hidden]]:hidden")} hidden={!items.length}><Items items={items} a={a} /></div>;
}
export function LeftOptionsToolbar() {
  const a = useAvail(); const items = useBar("left");
  return <div id="tbLeft" className={cx(KTB_V, "border-r border-line")}><Items items={items} a={a} v /></div>;
}
export function RightDrawToolbar() {
  const a = useAvail(); const items = useBar("right");
  const tool = useApp((s) => s.tool.current);
  const moduleTools = useApp((s) => s.tool.moduleTools);
  const isModuleTool = a.moduleTools.has(tool);
  return (
    <div id="tbRight" className={cx(KTB_V, "border-l border-line")}>
      <Items items={items} a={a} v />
      <Sep v />
      {EXTRA_TOOLS.map((e) => {
        const avail = a.appTools.has(e.tool);
        return (
          <button type="button" key={e.id} className={cx(KB, "glyph", !avail && "desk", tool === e.tool && "on")} data-uiact={e.id} data-ktool={e.tool}
            title={e.name + (avail && e.key ? `  (${e.key})` : "")} onClick={(ev) => runUiAction(a, e.id, ev.currentTarget)}>
            <Glyph svg={e.glyph} />
          </button>
        );
      })}
      {/* sch-tools.js reads `#ltools .tb.on` (data-modtool / data-tool) for the active tool and
          `#ltools [data-modtool="wire"]` to know the schematic module is in charge. */}
      <span id="ltools" hidden>
        <i className="tb on" data-modtool={isModuleTool ? tool : undefined} data-tool={isModuleTool ? undefined : tool} />
        {moduleTools.map((t) => <i key={t.id} className="tb" data-modtool={t.id} />)}
      </span>
    </div>
  );
}
