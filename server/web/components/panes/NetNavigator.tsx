// NetNavigator.tsx — the schematic Net Navigator (eeschema/net_navigator.cpp, SCH_EDIT_FRAME::createNetNavigatorPanel):
// a "Filter nets" search box with the gear menu (Wildcard Search / Regex Search) above the tree.  With nothing
// highlighted the tree is "Nets" > every net > its sheets > its items; with a net highlighted the root is that net
// and the filter is disabled.  A click on an item changes to its sheet and centres on it; a sheet node changes
// sheet; a net name does nothing.  The model is web/editor/panels/netnav.ts.
import { useEffect, useState } from "react";
import type { NetNavNode } from "../../panels-api";
import { cx } from "../../util";
import { ContextMenu, Twist, pdispatch, usePanels, type MenuAt } from "./widgets";

export function NetNavigatorPane() {
  const nav = usePanels((s) => s.netNav);
  const root = nav.root;
  // a node's fold state differs from its default (wxTreeCtrl: collapsed until expanded) when its key is in here
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuAt | null>(null);
  useEffect(() => { pdispatch({ t: "netNavRefresh" }); }, []);   // wxEVT_SHOW: a stale navigator rebuilds when shown
  // the selected node is shown: its ancestors open (EnsureVisible)
  useEffect(() => {
    if (!nav.selected || !root) return;
    const path: NetNavNode[] = [];
    const walk = (n: NetNavNode): boolean => { if (n.key === nav.selected) return true; for (const c of n.children || []) if (walk(c)) { path.push(n); return true; } return false; };
    if (!walk(root)) return;
    const next = new Set(flipped); let changed = false;
    for (const n of path) { const open = n.collapsed ? next.has(n.key) : !next.has(n.key); if (!open) { if (next.has(n.key)) next.delete(n.key); else next.add(n.key); changed = true; } }
    if (changed) setFlipped(next);
    const el = document.querySelector(`#netnav [data-nav="${CSS.escape(nav.selected)}"]`); if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [nav.selected, nav.version]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => { const n = new Set(flipped); if (n.has(k)) n.delete(k); else n.add(k); setFlipped(n); };
  const isOpen = (n: NetNavNode) => (n.collapsed ? flipped.has(n.key) : !flipped.has(n.key));
  const row = (n: NetNavNode, depth: number): JSX.Element => {
    const kids = n.children || [], open = isOpen(n);
    return (
      <div key={n.key}>
        <div className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", n.bold && "font-semibold", nav.selected === n.key && "cur")} style={{ paddingLeft: 4 + depth * 14 }} data-nav={n.key}
          onClick={() => { if (depth > 0) pdispatch({ t: "netNavSelect", ids: n.ids || [], key: n.key }); }}
          onDoubleClick={() => { if (kids.length) toggle(n.key); }}>
          <Twist open={open} leaf={!kids.length} onToggle={() => toggle(n.key)} />
          <span>{n.label}</span>
        </div>
        {open ? kids.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  const wildcard = nav.wildcard !== false;
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className="flex-none flex items-center gap-0.5 p-0.5">
        <input id="netNavFilter" type="search" placeholder="Filter nets" value={nav.filter || ""} disabled={nav.filterEnabled === false} spellCheck={false}
          onChange={(ev) => pdispatch({ t: "netNavFilter", text: ev.target.value })}
          className="flex-1 min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm disabled:opacity-50" />
        <button type="button" id="netNavGear" title="Search mode" className="flex-none w-[22px] h-[22px] grid place-items-center text-ink-2 hover:bg-panel rounded-xs"
          onClick={(ev) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom, items: [
            { label: (wildcard ? "● " : "○ ") + "Wildcard Search", run: () => pdispatch({ t: "netNavFilter", wildcard: true }) },
            { label: (!wildcard ? "● " : "○ ") + "Regex Search", run: () => pdispatch({ t: "netNavFilter", wildcard: false }) }] }); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>
        </button>
      </div>
      <div className="ktree overflow-auto min-h-0 flex-auto py-1" id="netnav">
        {root ? row(root, 0) : null}
      </div>
      <ContextMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
