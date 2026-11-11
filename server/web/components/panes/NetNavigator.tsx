// NetNavigator.tsx — the schematic Net Navigator (eeschema/net_navigator.cpp): the highlighted net as a
// tree of its sheet and the items on it; with nothing highlighted, the sheet's named nets.  A click on an
// item selects it and brings it into view; a click on a net name highlights that net.
import { useState } from "react";
import type { NetNavNode } from "../../panels-api";
import { cx } from "../../util";
import { Twist, pdispatch, usePanels } from "./widgets";

export function NetNavigatorPane() {
  const root = usePanels((s) => s.netNav.root);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [cur, setCur] = useState<string | null>(null);
  const toggle = (k: string) => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosed(n); };
  const row = (n: NetNavNode, depth: number): JSX.Element => {
    const kids = n.children || [], open = !closed.has(n.key);
    return (
      <div key={n.key}>
        <div className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", n.bold && "font-semibold", cur === n.key && "cur")} style={{ paddingLeft: 4 + depth * 14 }} data-nav={n.key}
          onClick={() => { setCur(n.key); if (n.ids && n.ids.length && depth > 0) pdispatch({ t: "netNavSelect", ids: n.ids }); }}>
          <Twist open={open} leaf={!kids.length} onToggle={() => toggle(n.key)} />
          <span>{n.label}</span>
        </div>
        {open ? kids.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  return (
    <div className="kbody ktree overflow-auto min-h-0 flex-auto py-1 bg-paper text-sm" id="netnav">
      {root ? row(root, 0) : <p className="note px-2">Highlight a net to list its items.</p>}
      {root && root.key === "nets" && !(root.children || []).length ? <p className="note px-2">No named nets on this sheet.</p> : null}
    </div>
  );
}
