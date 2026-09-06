// Hierarchy.tsx — the schematic hierarchy: the root sheet first, then every other sheet file.
import { dispatch, useApp } from "../../store";
import { cx } from "../../util";

// The pane body (the `.kbody` contract): scrolls, 6px/8px padding, sheet-coloured, 12px type.
const BODY = "kbody ktree overflow-auto min-h-0 flex-auto px-2 py-1.5 bg-paper text-sm";
// A tree row: flex, centred, 6px gap, 2px/4px padding, 2px radius, panel hover, sel fill when `.cur`; the left
// padding indents child sheets (18px) under the root (4px).  `node` / `ktree` stay as plain hooks.
const NODE = "node flex items-center gap-1.5 py-0.5 pr-1 rounded-xs cursor-pointer whitespace-nowrap hover:bg-panel cur:bg-sel";

export function HierarchyPane() {
  const docs = useApp((s) => s.document.docs);
  const rootId = useApp((s) => s.document.rootDocId);
  const curId = useApp((s) => s.document.docId);
  const projectName = useApp((s) => (s.project ? s.project.name : ""));
  const sch = docs.filter((d) => d.docType === "kicad_sch").sort((a, b) => (a.docId === rootId ? -1 : b.docId === rootId ? 1 : a.path.localeCompare(b.path)));
  return (
    <div className={BODY} id="hier">
      {sch.length ? sch.map((d) => {
        const root = d.docId === rootId;
        return (
          <div key={d.docId} className={cx(NODE, root ? "pl-1" : "pl-[18px]", d.docId === curId && "cur")} data-doc={d.docId} title={d.path}
            onClick={() => { if (d.docId !== curId) dispatch({ type: "openDoc", docId: d.docId }); }}>
            {root ? "▾ " : "· "}{root ? (projectName || "Root") : d.path.split("/").pop()!.replace(/\.kicad_sch$/, "")}{root ? "" : <> <span className="muted">(page)</span></>}
          </div>
        );
      }) : <p className="note">No schematic sheets in this project.</p>}
    </div>
  );
}
