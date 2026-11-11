// Dock.tsx — the wxAUI-style docked panes with caption bars.  The schematic keeps everything on
// the left (Properties · Hierarchy · Net Navigator · Selection Filter · History); the board keeps
// Appearance with the Selection Filter below it on the right; the Search pane docks along the
// bottom, as in KiCad.  Docks and panes are resized by their sashes; the sizes are remembered per
// editor in localStorage (kui.dock.<editor>), the open panes in kui.panes.<editor> (web/editor/panes.ts).
// Panes stay mounted while hidden so the imperative islands (pcb-tools' MutationObserver on #layers)
// keep their elements.
import { useSyncExternalStore, type PointerEvent as RPointerEvent, type ReactNode } from "react";
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
const PANE_FLEX: Record<string, string> = { props: "flex-[2_1_0]", filter: "flex-none", history: "flex-[1.4_1_0]", appearance: "flex-[3_1_0]" };
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
        <button type="button" className="kx ml-auto w-4 h-4 p-0 border-0 rounded-xs bg-transparent text-ink-2 text-lg font-sans font-normal leading-none hover:bg-copper hover:text-white" data-pane-close={name} title="Close" onClick={() => dispatch({ type: "showPane", pane: name, show: false })}>×</button>
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
    default: return null;
  }
}

function Dock({ side }: { side: "left" | "right" | "bottom" }) {
  const editor = useApp((s) => s.document.editor);
  const panes = useApp((s) => s.panes);
  const layout = useLayout(editor || "x");
  const names = editor ? DOCKS[editor as Editor][side] || [] : [];
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
  const w = side === "left" ? layout.left : layout.right;
  const down = (ev: RPointerEvent) => {
    const w0 = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
    dragSash(ev, (dx) => setLayout(ed, { [side]: clamp(w0 + (side === "left" ? dx : -dx), 170, Math.max(220, window.innerWidth * 0.45)) }, false), () => setLayout(ed, {}, true));
  };
  return (
    <aside
      id={side === "left" ? "dockL" : "dockR"}
      className={cx("kdock relative flex flex-col min-h-0 overflow-hidden bg-bench border-line [&[hidden]]:hidden [@media(max-width:900px)]:hidden!", !w && "w-[300px] [@media(max-width:1100px)]:w-[240px]", side === "left" ? "border-r" : "border-l")}
      style={w ? { width: w } : undefined}
      hidden={!any}
    >
      <div className={cx("ksash absolute top-0 bottom-0 w-[4px] z-[3] cursor-col-resize hover:bg-blue/40", side === "left" ? "right-0" : "left-0")} data-dock-sash={side} onPointerDown={down} />
      {names.map((n) => <PaneFor name={n} key={n} first={n === firstShown} />)}
    </aside>
  );
}
export function DockLeft() { return <Dock side="left" />; }
export function DockRight() { return <Dock side="right" />; }
export function DockBottom() { return <Dock side="bottom" />; }
