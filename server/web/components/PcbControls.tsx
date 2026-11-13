// PcbControls.tsx — the board editor's aux-toolbar controls that pcbnew builds in
// toolbars_pcb_editor.cpp: the track width and via size choices (UpdateTrackWidthSelectBox /
// UpdateViaSizeSelectBox) and the active-layer selector (PCB_LAYER_BOX_SELECTOR: every enabled layer
// with its colour swatch).  What they show comes from the store's `routing` slice; a choice goes back
// as an intent and the editor (web/editor/pcbrouting.ts) updates the sizes the router uses.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { dispatch, useApp } from "../store";
import { cx } from "../util";
import { menuScroller, menuSize, placeMenu } from "../menufit";
import { Select, type SelectOption } from "./Select";

const SEL = "ksel h-6 text-sm max-w-[320px]";
const EDIT = "Edit Pre-defined Sizes...";

/** A size choice: the entries, a "---" rule and "Edit Pre-defined Sizes...", exactly as the wxChoice is filled. */
function SizeSelect({ id, title, labels, index, onPick }: { id: string; title: string; labels: string[]; index: number; onPick: (v: number | "edit") => void }) {
  const options: SelectOption[] = labels.map((l, i) => ({ value: String(i), label: l }));
  options.push({ value: "sep", label: "---", sep: true }, { value: "edit", label: EDIT });
  return <Select id={id} className={SEL} title={title} options={options} value={String(Math.min(index, Math.max(0, labels.length - 1)))} blurOnPick
    onChange={(v) => { if (v === "edit") onPick("edit"); else if (v !== "sep") onPick(Number(v)); }} />;
}
export function TrackWidthSelect() {
  const labels = useApp((s) => s.routing.trackLabels);
  const index = useApp((s) => s.routing.trackIndex);
  return <SizeSelect id="trackWidthSel" title="Select the track width" labels={labels} index={index} onPick={(v) => dispatch({ type: "setTrackWidth", index: v })} />;
}
/**
 * PCB_EDIT_FRAME::UpdateViaStackSelectBox: "Microvia stack: none defined" or "Microvia stack: %s" for each preset,
 * then "---" and "Edit Pre-defined Microvia Stacks...".
 */
export function ViaStackSelect() {
  const names = useApp((s) => s.routing.viaStacks);
  const index = useApp((s) => s.routing.viaStackIndex);
  const options: SelectOption[] = names.length ? names.map((n, i) => ({ value: String(i), label: `Microvia stack: ${n}` })) : [{ value: "none", label: "Microvia stack: none defined" }];
  options.push({ value: "sep", label: "---", sep: true }, { value: "edit", label: "Edit Pre-defined Microvia Stacks..." });
  return <Select id="viaStackSel" className={SEL} title="Select the microvia stack preset placed by the microvia stack tool." options={options} value={names.length ? String(Math.min(index, names.length - 1)) : "none"} blurOnPick
    onChange={(v) => { if (v === "edit") dispatch({ type: "setViaStack", index: "edit" }); else if (v !== "sep" && v !== "none") dispatch({ type: "setViaStack", index: Number(v) }); }} />;
}
export function ViaSizeSelect() {
  const labels = useApp((s) => s.routing.viaLabels);
  const index = useApp((s) => s.routing.viaIndex);
  return <SizeSelect id="viaSizeSel" title="Select the via size" labels={labels} index={index} onPick={(v) => dispatch({ type: "setViaSize", index: v })} />;
}

const SWATCH = "inline-block w-3.5 h-3.5 flex-none rounded-xs border border-black/45";
/** KiCad appends the layer's hotkey to its name in the selector ("F.Cu (PgUp)"). */
const LAYER_KEYS: Record<string, string> = { "F.Cu": "PgUp", "B.Cu": "PgDn" };

/** The active-layer selector: a drop-down of every enabled layer, each with its colour swatch. */
export function LayerSelect() {
  const layers = useApp((s) => s.routing.layers);
  const active = useApp((s) => s.viewport.activeLayer);
  const view = useApp((s) => s.view);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const cur = layers.find((l) => l.name === active);
  useEffect(() => { if (view !== "editor") setOpen(false); }, [view]);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const p = placeMenu(list.current ? menuSize(list.current) : { w: 230, h: 300 }, { below: r });
    setStyle({ left: p.left + "px", top: p.top + "px", maxHeight: Math.min(p.maxHeight, Math.round(window.innerHeight * 0.7)) + "px", minWidth: r.width + "px" });
    if (list.current) menuScroller(list.current);
    const on = list.current && list.current.querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
  }, [open, layers.length]);
  useEffect(() => {
    if (!open) return;
    const down = (ev: PointerEvent) => { const t = ev.target as Node; if (list.current && !list.current.contains(t) && btn.current && !btn.current.contains(t)) setOpen(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return (
    <>
      <button type="button" id="layerSel" ref={btn} title="Active layer" data-layer={active}
        className="ksel klayer bg-panel border border-line rounded-sm px-1 py-0.5 h-6 text-sm text-ink inline-flex items-center gap-1.5 min-w-[130px] max-w-[190px]"
        onClick={() => setOpen((o) => !o)} onKeyDown={(ev) => { if (ev.key === " " || ev.key === "Enter") ev.stopPropagation(); }}>
        <i className={SWATCH} style={{ background: cur ? cur.color : "transparent" }} />
        <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{cur ? cur.label : active}</span>
        <svg className="w-2 h-2 flex-none text-ink-2" viewBox="0 0 8 8"><path d="M1 2.5h6L4 6z" fill="currentColor" /></svg>
      </button>
      {open ? createPortal(
        <div ref={list} id="layerSelList" className="fixed z-70 bg-panel border border-line rounded-md shadow-panel py-0.5 overflow-auto text-sm" style={style}>
          {layers.map((l) => (
            <button type="button" key={l.name} data-layer={l.name}
              className={cx("flex items-center gap-2 w-full bg-transparent border-0 px-2 py-[3px] text-ink text-left whitespace-nowrap hover:bg-accent hover:text-on-accent on:bg-on", l.name === active && "on")}
              onClick={() => { setOpen(false); dispatch({ type: "setActiveLayer", layer: l.name }); }}>
              <i className={SWATCH} style={{ background: l.color }} />
              <span className="flex-1">{l.label}{LAYER_KEYS[l.name] ? ` (${LAYER_KEYS[l.name]})` : ""}</span>
            </button>
          ))}
        </div>, document.body) : null}
    </>
  );
}
