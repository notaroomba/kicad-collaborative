// widgets.tsx — what the docked panels share: the hook onto the editor's panel models
// (window.CollabPanels, see web/panels-api.ts), a popup context menu, the colour swatch with its
// picker, and KiCad's collapsible pane section (WX_COLLAPSIBLE_PANE).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelAction, PanelsApi, PanelsState } from "../../panels-api";
import { cx } from "../../util";

const EMPTY: PanelsState = {
  appearance: { layers: [], active: "", objects: [], nets: [], netClasses: [], inactive: "normal", flip: false, netColorMode: "ratsnest", ratsnestMode: "all", presets: [], builtinPresets: [], preset: null, viewports: [], viewport: null },
  hierarchy: { root: null, version: 0 }, netNav: { root: null, version: 0 }, selVersion: 0,
};
export const panels = (): PanelsApi | null => window.CollabPanels || null;
const subscribe = (fn: () => void) => { const p = panels(); return p ? p.subscribe(fn) : () => {}; };
const snapshot = () => { const p = panels(); return p ? p.getState() : EMPTY; };
/** Select a slice of the panel models' store; re-renders when the selected value changes identity. */
export function usePanels<T>(selector: (s: PanelsState) => T): T { return selector(useSyncExternalStore(subscribe, snapshot)); }
export function pdispatch(a: PanelAction): void { const p = panels(); if (p) p.dispatch(a); }

// ---------------------------------------------------------------- context menu
export type MenuItem = { label: string; run: () => void; disabled?: boolean } | "-";
export interface MenuAt { x: number; y: number; items: MenuItem[] }

/** A wxMenu popped at the pointer: closes on a pick, an outside press or Escape; kept inside the window. */
export function ContextMenu({ at, onClose }: { at: MenuAt | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!at || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(2, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(2, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const down = (ev: PointerEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) onClose(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [at, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={ref} className="kctx fixed z-[400] min-w-[180px] py-1 bg-panel border border-line rounded-md shadow-panel text-sm text-ink select-none" role="menu"
      style={{ left: (pos || at).x, top: (pos || at).y, visibility: pos ? "visible" : "hidden" }} onContextMenu={(ev) => ev.preventDefault()}>
      {at.items.map((it, i) => it === "-"
        ? <div key={i} className="my-1 border-t border-line" />
        : <div key={i} role="menuitem" className={cx("px-3 py-[3px] whitespace-nowrap", it.disabled ? "text-ink-3" : "cursor-default hover:bg-accent hover:text-on-accent")}
            onClick={() => { if (it.disabled) return; onClose(); it.run(); }}>{it.label}</div>)}
    </div>, document.body);
}
/** State for one ContextMenu: `open(ev, items)` from an onContextMenu handler. */
export function useContextMenu(): { at: MenuAt | null; open: (ev: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => void; close: () => void } {
  const [at, setAt] = useState<MenuAt | null>(null);
  return { at, open: (ev, items) => { ev.preventDefault(); setAt({ x: ev.clientX, y: ev.clientY, items }); }, close: () => setAt(null) };
}

// ---------------------------------------------------------------- colour swatch + picker
// KiCad's colour picker opens on its "Defined Colors" palette; these are that page's rows.  They are opaque: picking one
// sets the opacity to its own (DIALOG_COLOR_PICKER::buttColorClick takes the defined colour's alpha too).
const PALETTE = ["#C83434", "#E08A2E", "#E2C12C", "#7FC820", "#22B84C", "#1FB8A6", "#2D9BE0", "#4D7FC4", "#7F5FD0", "#C04FC8", "#E0508C", "#8A5A2B",
  "#FF6060", "#FFB060", "#FFF060", "#B8FF60", "#60FF90", "#60FFE8", "#60C8FF", "#8CA8FF", "#B090FF", "#F080FF", "#FF90C0", "#C8A070",
  "#FFFFFF", "#D0D0D0", "#A0A0A0", "#707070", "#404040", "#000000"];
/** A css colour as "#rrggbb" plus its opacity 0..100 (the colours here are "#rrggbb", "#rrggbbaa" or "rgb[a](r,g,b[,a])"). */
export function splitColor(c: string | null): { hex: string; alpha: number } {
  const h = c ? /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c) : null;
  if (h) return { hex: "#" + h[1], alpha: h[2] ? Math.round(parseInt(h[2], 16) / 2.55) : 100 };
  const m = c ? /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c) : null;
  if (m) return { hex: "#" + [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, "0")).join(""), alpha: m[4] === undefined ? 100 : Math.round(Math.max(0, Math.min(1, +m[4])) * 100) };
  return { hex: "#808080", alpha: 100 };
}
/** "#rrggbb" at full opacity, else "rgba(r,g,b,a)" (the canvas library's rgba() form). */
export function joinColor(hex: string, alpha: number): string {
  if (alpha >= 100) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${+(Math.max(0, alpha) / 100).toFixed(3)})`;
}

/**
 * opacity: DIALOG_COLOR_PICKER's Opacity slider (aAllowOpacityControl) — on for every COLOR_SWATCH of the
 * Appearance panel (layers, nets, net classes); a translucent layer colour lets the layers under it show through.
 */
export interface ColorAt { x: number; y: number; title: string; color: string | null; canClear: boolean; clearLabel: string; set: (c: string | null) => void; opacity?: boolean }
export function ColorPicker({ at, onClose }: { at: ColorAt | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [val, setVal] = useState("#808080");
  const [alpha, setAlpha] = useState(100);
  // UNSPECIFIED (no colour yet) opens fully opaque, as DIALOG_COLOR_PICKER does
  useEffect(() => { if (at) { const c = splitColor(at.color); setVal(c.hex); setAlpha(at.opacity === false || !at.color ? 100 : c.alpha); } }, [at]);
  useEffect(() => {
    if (!at) return;
    const down = (ev: PointerEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) onClose(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [at, onClose]);
  if (!at) return null;
  const W = 232, left = Math.max(4, Math.min(at.x, window.innerWidth - W - 8)), top = Math.max(4, Math.min(at.y, window.innerHeight - 290));
  const withOpacity = at.opacity !== false, a = withOpacity ? alpha : 100;
  const pick = (c: string | null, alphaPct = a) => { at.set(c === null ? null : joinColor(c, alphaPct)); onClose(); };
  const valid = /^#[0-9a-f]{6}$/i.test(val);
  return createPortal(
    <div ref={ref} className="kcolor fixed z-[400] p-2 bg-panel border border-line rounded-md shadow-panel text-sm text-ink" style={{ left, top, width: W }}>
      <div className="font-semibold mb-1.5">{at.title}</div>
      <div className="flex flex-wrap gap-[3px] mb-2">
        {PALETTE.map((c) => <button type="button" key={c} title={c} data-color={c} className="w-4 h-4 p-0 rounded-xs border border-black/40 cursor-pointer" style={{ background: c }} onClick={() => pick(c, 100)} />)}
      </div>
      <div className="flex items-center gap-1.5 mb-2">
        <input type="color" value={val.toLowerCase()} onChange={(ev) => setVal(ev.target.value)} className="w-8 h-6 p-0 border border-line bg-transparent" />
        <input type="text" value={val} spellCheck={false} onChange={(ev) => setVal(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && valid) pick(val); }}
          className="flex-1 min-w-0 px-1 py-0.5 bg-panel border border-line rounded-xs text-ink font-mono text-xs" />
        <Swatch color={valid ? joinColor(val, a) : null} title="New color" />
      </div>
      {withOpacity ? (
        <div className="flex items-center gap-1.5 mb-2" title="Opacity of the color: lower it to see the layers underneath">
          <span className="flex-none">Opacity:</span>
          <input type="range" min={0} max={100} step={1} value={alpha} data-color-opacity onChange={(ev) => setAlpha(+ev.target.value)} className="flex-1 min-w-0 h-3 m-0 accent-blue" />
          <span className="flex-none w-9 text-right font-mono text-xs text-ink-2">{alpha}%</span>
        </div>
      ) : null}
      <div className="flex gap-1.5 justify-end">
        {at.canClear ? <button type="button" className="mr-auto px-2 py-0.5 border border-line rounded-xs bg-bench text-ink" data-color-clear onClick={() => pick(null)}>{at.clearLabel}</button> : null}
        <button type="button" className="px-2 py-0.5 border border-line rounded-xs bg-bench text-ink" onClick={onClose}>Cancel</button>
        <button type="button" className="px-2 py-0.5 border border-line rounded-xs bg-bench text-ink" data-color-ok disabled={!valid} onClick={() => pick(val)}>OK</button>
      </div>
    </div>, document.body);
}

const CHECKER = "linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%),linear-gradient(45deg,#888 25%,#ccc 25%,#ccc 75%,#888 75%)";
/**
 * KiCad's COLOR_SWATCH: a bordered square; with no colour set it shows the checkerboard of "no colour", and a
 * translucent colour is blended over that checkerboard (COLOR_SWATCH::RenderToDC).
 */
export function Swatch({ color, title, onPick, small }: { color: string | null; title?: string; onPick?: (ev: { clientX: number; clientY: number }) => void; small?: boolean }) {
  const translucent = !!color && splitColor(color).alpha < 100;
  const bg = color && !translucent ? { background: color }
    : { backgroundImage: (translucent ? `linear-gradient(${color},${color}),` : "") + CHECKER, backgroundSize: translucent ? "100% 100%,6px 6px,6px 6px" : "6px 6px", backgroundPosition: translucent ? "0 0,0 0,3px 3px" : "0 0,3px 3px" };
  return <span className={cx("sw flex-none rounded-xs border border-black/50", small ? "w-3 h-3" : "w-[18px] h-3.5")} style={bg} title={title}
    onDoubleClick={onPick ? (ev) => { ev.stopPropagation(); onPick(ev); } : undefined}
    onAuxClick={onPick ? (ev) => { if (ev.button === 1) { ev.preventDefault(); onPick(ev); } } : undefined} />;
}

// ---------------------------------------------------------------- collapsible section
export function Collapsible({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("kui.collapse." + id) === "1"; } catch (e) { return false; } });
  const toggle = () => { const n = !open; setOpen(n); try { localStorage.setItem("kui.collapse." + id, n ? "1" : "0"); } catch (e) { /* no storage */ } };
  return (
    <div className="kcollapse flex-none border-t border-line bg-bench" data-collapse={id}>
      <button type="button" className="flex items-center gap-1 w-full px-1.5 py-1 border-0 bg-transparent text-ink text-sm text-left cursor-pointer" onClick={toggle} aria-expanded={open}>
        <span className="inline-block w-3 text-ink-2 text-xs">{open ? "▾" : "▸"}</span>{title}
      </button>
      {open ? <div className="px-2 pb-2 pt-0.5">{children}</div> : null}
    </div>
  );
}

/** The +/- of a tree row (wxTreeCtrl's twist button); an empty slot keeps leaf labels aligned. */
export function Twist({ open, onToggle, leaf }: { open: boolean; onToggle: () => void; leaf?: boolean }) {
  if (leaf) return <span className="inline-block w-3.5 flex-none" />;
  return <span className="twist inline-block w-3.5 flex-none text-center text-ink-2 text-xs cursor-pointer" data-twist onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>{open ? "▾" : "▸"}</span>;
}
