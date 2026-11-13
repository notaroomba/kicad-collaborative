// Hierarchy.tsx — the schematic Hierarchy navigator (eeschema/widgets/hierarchy_pane.cpp): the tree of
// sheets, each "name (page N)", the sheet on screen highlighted.  A click opens the sheet; the right-click
// menu is KiCad's: Edit Page Number, Rename, Delete Top-Level Sheet, New Top-Level Sheet, Expand All, Collapse All.
import { useState } from "react";
import type { HierNode } from "../../panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { ContextMenu, Twist, pdispatch, useContextMenu, usePanels, type MenuItem } from "./widgets";

// The pane body (the `.kbody` contract): scrolls, sheet-coloured, 12px type.
const BODY = "kbody ktree overflow-auto min-h-0 flex-auto py-1 bg-paper text-sm";
const NODE = "node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel cur:font-semibold";

function allPaths(n: HierNode, out: string[] = []): string[] { if (n.children.length) out.push(n.path); for (const c of n.children) allPaths(c, out); return out; }

export function HierarchyPane() {
  const root = usePanels((s) => s.hierarchy.root);
  const viewOnly = useApp((s) => s.viewOnly);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const menu = useContextMenu();
  const toggle = (p: string) => { const n = new Set(closed); if (n.has(p)) n.delete(p); else n.add(p); setClosed(n); };
  // HIERARCHY_PANE::onContextMenu: a sheet's own entries (Delete Top-Level Sheet on a top-level one), then New
  // Top-Level Sheet, then Expand / Collapse All.  A project here has one top-level sheet, its file the project's root
  // schematic: adding or removing top-level sheets runs in the desktop app.
  const DESKTOP = "runs in the desktop app";
  const items = (n: HierNode): MenuItem[] => [
    { label: "Edit Page Number", run: () => pdispatch({ t: "hierPage", path: n.path }), disabled: viewOnly || !n.sheetId },
    { label: "Rename", run: () => pdispatch({ t: "hierRename", path: n.path }), disabled: viewOnly || !n.sheetId },
    ...(n.parentDocId ? [] : [{ label: "Delete Top-Level Sheet", run: () => {}, disabled: true, title: DESKTOP } satisfies MenuItem]),
    "-",
    { label: "New Top-Level Sheet", run: () => {}, disabled: true, title: DESKTOP },
    "-",
    { label: "Expand All", run: () => setClosed(new Set()) },
    { label: "Collapse All", run: () => setClosed(new Set(root ? allPaths(root) : [])) },
  ];
  const row = (n: HierNode, depth: number): JSX.Element => {
    const open = !closed.has(n.path);
    return (
      <div key={n.path}>
        <div className={cx(NODE, n.current && "cur", !n.docId && "text-ink-3")} style={{ paddingLeft: 4 + depth * 14 }} data-doc={n.docId || undefined} data-path={n.path} title={n.file}
          onClick={() => pdispatch({ t: "hierOpen", path: n.path })} onContextMenu={(ev) => menu.open(ev, items(n))}>
          <Twist open={open} leaf={!n.children.length} onToggle={() => toggle(n.path)} />
          <span>{n.name}{n.page ? ` (page ${n.page})` : ""}</span>
        </div>
        {open ? n.children.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  return (
    <div className={BODY} id="hier">
      {root ? row(root, 0) : <p className="note px-2">No schematic sheets in this project.</p>}
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}
