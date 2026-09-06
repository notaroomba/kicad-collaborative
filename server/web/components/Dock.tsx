// Dock.tsx — the wxAUI-style docked panes with caption bars.  The schematic keeps everything on
// the left (Properties · Hierarchy · Selection Filter · History); the board keeps Appearance with
// the Selection Filter below it on the right.  Panes stay mounted while hidden so the imperative
// islands (props.js into #props, pcb-tools' MutationObserver on #layers) keep their elements.
import type { ReactNode } from "react";
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

// How each pane shares the dock's height (was `.kpane[data-pane=…] { flex: … }`).
const PANE_FLEX: Record<string, string> = { props: "flex-[2_1_0]", filter: "flex-none", history: "flex-[1.4_1_0]" };

function Pane({ name, count, children, footer }: { name: string; count?: number; children: ReactNode; footer?: ReactNode }) {
  const shown = useApp((s) => !!s.panes[name]);
  return (
    <section className={cx("kpane flex flex-col min-h-0 border-b border-line [&[hidden]]:hidden", PANE_FLEX[name] || "flex-[1_1_0]")} data-pane={name} hidden={!shown}>
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

function PaneFor({ name }: { name: string }) {
  const peerN = useApp((s) => s.peers.list.length);
  const cmtN = useApp((s) => s.comments.filter((c) => !c.parentId && !c.resolved).length);
  switch (name) {
    case "props": return <Pane name={name}><PropertiesPane /></Pane>;
    case "hier": return <Pane name={name}><HierarchyPane /></Pane>;
    case "filter": return <Pane name={name}><SelectionFilterPane /></Pane>;
    case "history": return <Pane name={name} footer={<HistoryButtons />}><HistoryPane /></Pane>;
    case "peers": return <Pane name={name} count={peerN}><CollaboratorsPane /></Pane>;
    case "comments": return <Pane name={name} count={cmtN}><CommentsPane /></Pane>;
    case "appearance": return <Pane name={name}><AppearancePane /></Pane>;
    default: return null;
  }
}

function Dock({ side }: { side: "left" | "right" }) {
  const editor = useApp((s) => s.document.editor);
  const panes = useApp((s) => s.panes);
  const names = editor ? DOCKS[editor as Editor][side] : [];
  const any = names.some((n) => panes[n]);
  return (
    <aside
      id={side === "left" ? "dockL" : "dockR"}
      className={cx("kdock flex flex-col w-[300px] min-h-0 overflow-hidden bg-bench border-line [&[hidden]]:hidden [@media(max-width:1100px)]:w-[240px] [@media(max-width:900px)]:hidden!", side === "left" ? "border-r" : "border-l")}
      hidden={!any}
    >
      {names.map((n) => <PaneFor name={n} key={n} />)}
    </aside>
  );
}
export function DockLeft() { return <Dock side="left" />; }
export function DockRight() { return <Dock side="right" />; }
