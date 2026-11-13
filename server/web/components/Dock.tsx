// Dock.tsx — the wxAUI-style docked panes with caption bars.  The schematic keeps everything on
// the left (Properties · Hierarchy · Net Navigator · Selection Filter · History); the board keeps
// Appearance with the Selection Filter below it on the right; the Search pane docks along the
// bottom, as in KiCad.  Docks and panes are resized by their sashes; the sizes are remembered per
// editor in localStorage (kui.dock.<editor>), the open panes in kui.panes.<editor> (web/editor/panes.ts).
// Panes stay mounted while hidden so the imperative islands (pcb-tools' MutationObserver on #layers)
// keep their elements.
import { useEffect, useRef, useSyncExternalStore, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { DOCKS, PANE_TITLES } from "../tables";
import { dispatch, useApp, type Editor } from "../store";
import { cx } from "../util";
import { PropertiesPane } from "./panes/Properties";
import { HierarchyPane } from "./panes/Hierarchy";
import { SelectionFilterPane } from "./panes/SelectionFilter";
import { HistoryPane, HistoryButtons } from "./panes/History";
import { AppearancePane } from "./panes/Appearance";
import { CollaboratorsPane } from "./panes/Collaborators";
import { CommentsPane } from "./panes/Comments";
import { SearchPane } from "./panes/Search";
import { NetNavigatorPane } from "./panes/NetNavigator";
import { LibrariesPane } from "./panes/Libraries";
import { NetInspectorPane } from "./panes/NetInspector";

// ---------------------------------------------------------------- remembered sizes
interface DockLayout { left?: number; right?: number; bottom?: number; panes: Record<string, number> }
const layouts: Record<string, DockLayout> = {};
const subs = new Set<() => void>();
const layoutKey = (ed: string) => "kui.dock." + ed;
function layoutOf(ed: string): DockLayout {
  if (!layouts[ed]) {
    let saved: Partial<DockLayout> = {};
    try { saved = JSON.parse(localStorage.getItem(layoutKey(ed)) || "{}") as Partial<DockLayout>; } catch (e) { /* no storage */ }
    layouts[ed] = { left: saved.left, right: saved.right, bottom: saved.bottom, panes: Object.assign({}, saved.panes) };
  }
  return layouts[ed];
}
function setLayout(ed: string, patch: Partial<DockLayout>, save: boolean): void {
  layouts[ed] = Object.assign({}, layoutOf(ed), patch);
  if (save) { try { localStorage.setItem(layoutKey(ed), JSON.stringify(layouts[ed])); } catch (e) { /* no storage */ } }
  for (const fn of Array.from(subs)) fn();
}
function useLayout(ed: string): DockLayout {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => layoutOf(ed));
}

// ---------------------------------------------------------------- narrow windows: the side docks become drawers
// Below 900px a side dock no longer takes a grid column (it would squeeze the canvas to nothing): it floats over
// the stage as a drawer, closed by default, opened by the tab on the stage's edge (or by showing one of its panes).
export const NARROW_QUERY = "(max-width: 900px)";
function useNarrow(): boolean {
  return useSyncExternalStore((fn) => { const m = matchMedia(NARROW_QUERY); m.addEventListener("change", fn); return () => m.removeEventListener("change", fn); },
    () => matchMedia(NARROW_QUERY).matches);
}
type Side = "left" | "right";
let drawers: Record<Side, boolean> = { left: false, right: false };
const drawerSubs = new Set<() => void>();
export function setDrawer(side: Side, open: boolean): void {
  if (drawers[side] === open) return;
  // one drawer at a time: two would cover the whole stage of a narrow window
  drawers = Object.assign({}, open ? { left: false, right: false } : drawers, { [side]: open });
  for (const fn of Array.from(drawerSubs)) fn();
}
function useDrawer(side: Side): boolean {
  return useSyncExternalStore((fn) => { drawerSubs.add(fn); return () => { drawerSubs.delete(fn); }; }, () => drawers[side]);
}

/** Track a sash drag: `move(dx, dy)` while the button is down, `done()` on release. */
function dragSash(ev: RPointerEvent, move: (dx: number, dy: number) => void, done: () => void): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY, el = ev.currentTarget as HTMLElement;
  try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
  const onMove = (m: PointerEvent) => move(m.clientX - x0, m.clientY - y0);
  const onUp = () => { el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerup", onUp); el.removeEventListener("pointercancel", onUp); done(); };
  el.addEventListener("pointermove", onMove); el.addEventListener("pointerup", onUp); el.addEventListener("pointercancel", onUp);
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// How each pane shares the dock's height until it is resized (was `.kpane[data-pane=…] { flex: … }`).
const PANE_FLEX: Record<string, string> = { libtree: "flex-[2_1_0]", props: "flex-[2_1_0]", filter: "flex-none", history: "flex-[1.4_1_0]", appearance: "flex-[3_1_0]" };
const MIN_PANE = 46;

/** The sash above a pane: drags the boundary with the visible pane before it. */
function PaneSash({ name, editor }: { name: string; editor: string }) {
  const down = (ev: RPointerEvent) => {
    const me = (ev.currentTarget as HTMLElement).closest<HTMLElement>(".kpane"); const dock = me ? me.parentElement : null; if (!me || !dock) return;
    const vis = Array.from(dock.querySelectorAll<HTMLElement>(":scope > .kpane")).filter((p) => !p.hidden);
    const i = vis.indexOf(me); if (i < 1) return;
    const prev = vis[i - 1], prevName = prev.dataset.pane || "";
    // from here on every visible pane of this dock holds its measured height as its share
    const sizes: Record<string, number> = Object.assign({}, layoutOf(editor).panes);
    for (const p of vis) sizes[p.dataset.pane || ""] = p.getBoundingClientRect().height;
    const a0 = sizes[prevName], b0 = sizes[name], total = a0 + b0;
    dragSash(ev, (_dx, dy) => {
      const a = clamp(a0 + dy, MIN_PANE, total - MIN_PANE);
      setLayout(editor, { panes: Object.assign({}, sizes, { [prevName]: a, [name]: total - a }) }, false);
    }, () => setLayout(editor, {}, true));
  };
  return <div className="ksash-h flex-none h-[4px] -mt-[2px] -mb-[2px] relative z-[2] cursor-row-resize hover:bg-blue/40" data-sash={name} onPointerDown={down} />;
}

function Pane({ name, first, count, children, footer }: { name: string; first: boolean; count?: number; children: ReactNode; footer?: ReactNode }) {
  const shown = useApp((s) => !!s.panes[name]);
  const editor = useApp((s) => s.document.editor) || "x";
  const size = useLayout(editor).panes[name];
  return (
    <section className={cx("kpane flex flex-col min-h-0 min-w-0 border-b border-line [&[hidden]]:hidden", size ? "" : PANE_FLEX[name] || "flex-[1_1_0]")} style={size ? { flex: `${Math.round(size)} 1 0px` } : undefined} data-pane={name} hidden={!shown}>
      {first ? null : <PaneSash name={name} editor={editor} />}
      <header className="flex flex-none items-center h-5.5 px-1.5 text-sm font-semibold text-ink bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">
        {PANE_TITLES[name] || name}
        {count !== undefined ? <span className="n ml-1.5 font-normal text-ink-3" id={name === "peers" ? "peerN" : name === "comments" ? "cmtN" : undefined}>{count}</span> : null}
        {name === "filter" ? null : <button type="button" className="kx ml-auto w-4 h-4 p-0 border-0 rounded-xs bg-transparent text-ink-2 text-lg font-sans font-normal leading-none hover:bg-err hover:text-white" data-pane-close={name} title="Close" onClick={() => dispatch({ type: "showPane", pane: name, show: false })}>×</button>}
      </header>
      {children}
      {footer}
    </section>
  );
}

function PaneFor({ name, first }: { name: string; first: boolean }) {
  const peerN = useApp((s) => s.peers.list.length);
  const cmtN = useApp((s) => s.comments.filter((c) => !c.parentId && !c.resolved).length);
  switch (name) {
    case "props": return <Pane name={name} first={first}><PropertiesPane /></Pane>;
    case "hier": return <Pane name={name} first={first}><HierarchyPane /></Pane>;
    case "filter": return <Pane name={name} first={first}><SelectionFilterPane /></Pane>;
    case "history": return <Pane name={name} first={first} footer={<HistoryButtons />}><HistoryPane /></Pane>;
    case "peers": return <Pane name={name} first={first} count={peerN}><CollaboratorsPane /></Pane>;
    case "comments": return <Pane name={name} first={first} count={cmtN}><CommentsPane /></Pane>;
    case "appearance": return <Pane name={name} first={first}><AppearancePane /></Pane>;
    case "search": return <Pane name={name} first={first}><SearchPane /></Pane>;
    case "netnav": return <Pane name={name} first={first}><NetNavigatorPane /></Pane>;
    case "netinsp": return <Pane name={name} first={first}><NetInspectorPane /></Pane>;
    case "libtree": return <Pane name={name} first={first}><LibrariesPane /></Pane>;
    default: return null;
  }
}

function Dock({ side }: { side: "left" | "right" | "bottom" }) {
  const editor = useApp((s) => s.document.editor);
  const panes = useApp((s) => s.panes);
  const layout = useLayout(editor || "x");
  const fpEdit = useApp((s) => s.document.docType === "footprint");
  // the Footprint Editor: the Libraries tree heads the left dock (FOOTPRINT_EDIT_FRAME's m_treePane)
  const names = editor ? (fpEdit && side === "left" ? ["libtree", ...(DOCKS[editor as Editor][side] || [])] : DOCKS[editor as Editor][side] || []) : [];
  const any = names.some((n) => panes[n]);
  const firstShown = names.find((n) => panes[n]);
  const ed = editor || "x";
  if (side === "bottom") {
    const h = layout.bottom || 200;
    const down = (ev: RPointerEvent) => {
      const h0 = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().height;
      dragSash(ev, (_dx, dy) => setLayout(ed, { bottom: clamp(h0 - dy, 90, Math.max(120, window.innerHeight - 260)) }, false), () => setLayout(ed, {}, true));
    };
    return (
      <aside id="dockB" className="kdock relative flex flex-col min-w-0 overflow-hidden bg-bench border-t border-line [&[hidden]]:hidden" style={{ height: h }} hidden={!any}>
        <div className="ksash absolute left-0 right-0 top-0 h-[4px] z-[3] cursor-row-resize hover:bg-blue/40" data-dock-sash="bottom" onPointerDown={down} />
        {names.map((n) => <PaneFor name={n} key={n} first={n === firstShown} />)}
      </aside>
    );
  }
  return <SideDock side={side} ed={ed} names={names} any={any} firstShown={firstShown} w={side === "left" ? layout.left : layout.right} />;
}

function SideDock({ side, ed, names, any, firstShown, w }: { side: Side; ed: string; names: string[]; any: boolean; firstShown?: string; w?: number }) {
  const narrow = useNarrow(), drawer = useDrawer(side);
  const panes = useApp((s) => s.panes);
  // showing one of this dock's panes (View menu, a toolbar button) in a narrow window opens its drawer
  // (not when a document opens: its remembered panes arrive together with its editor)
  const prev = useRef({ ed, panes });
  useEffect(() => {
    if (narrow && prev.current.ed === ed && names.some((n) => panes[n] && !prev.current.panes[n])) setDrawer(side, true);
    prev.current = { ed, panes };
  }, [narrow, ed, panes, names, side]);
  const down = (ev: RPointerEvent) => {
    const w0 = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
    dragSash(ev, (dx) => setLayout(ed, { [side]: clamp(w0 + (side === "left" ? dx : -dx), 170, Math.max(220, window.innerWidth * (narrow ? 0.85 : 0.45))) }, false), () => setLayout(ed, {}, true));
  };
  const open = !narrow || drawer;
  // the drawer sits beside the side toolbar (placed against the whole body: an absolutely positioned grid item
  // with a grid-column would be placed against that — empty — column), so the tools stay reachable while it is open
  const bar = narrow ? (document.getElementById(side === "left" ? "tbLeft" : "tbRight")?.offsetWidth ?? 34) : 0;
  const width = w ? (narrow ? `min(${Math.round(w)}px, calc(100% - ${bar + 40}px))` : w) : narrow ? `min(300px, calc(100% - ${bar + 40}px))` : undefined;
  return (
    <>
      <aside
        id={side === "left" ? "dockL" : "dockR"}
        className={cx("kdock flex flex-col min-h-0 overflow-hidden bg-bench border-line [&[hidden]]:hidden", narrow ? "kdrawer absolute top-0 bottom-0 z-40 shadow-panel" : "relative",
          !w && !narrow && "w-[300px] [@media(max-width:1100px)]:w-[240px]", side === "left" ? "border-r" : "border-l")}
        style={Object.assign({}, width !== undefined ? { width } : {}, narrow ? { [side]: bar, gridColumn: "auto", gridRow: "auto" } : {})}
        hidden={!any || !open}
      >
        <div className={cx("ksash absolute top-0 bottom-0 w-[4px] z-[3] cursor-col-resize hover:bg-blue/40", side === "left" ? "right-0" : "left-0")} data-dock-sash={side} onPointerDown={down} />
        {names.map((n) => <PaneFor name={n} key={n} first={n === firstShown} />)}
      </aside>
      {narrow && any ? (
        <button type="button" className={cx("kdrawer-tab absolute z-41 top-2 w-4.5 h-12 p-0 flex items-center justify-center bg-bench text-ink-2 border border-line text-xs leading-none hover:text-ink hover:bg-paper",
          side === "left" ? "rounded-r-sm border-l-0" : "rounded-l-sm border-r-0")}
          style={drawer ? { [side]: `calc(${bar}px + ${typeof width === "number" ? width + "px" : width})` } : { [side]: bar }}
          data-drawer={side} aria-expanded={drawer} title={drawer ? "Hide panels" : "Show panels"} onClick={() => setDrawer(side, !drawer)}>
          {(side === "left") === drawer ? "\u2039" : "\u203a"}
        </button>
      ) : null}
    </>
  );
}
export function DockLeft() { return <Dock side="left" />; }
export function DockRight() { return <Dock side="right" />; }
export function DockBottom() { return <Dock side="bottom" />; }
