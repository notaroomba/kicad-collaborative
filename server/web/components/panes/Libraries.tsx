// Libraries.tsx — the Footprint Editor's library tree (FOOTPRINT_EDIT_FRAME's LIB_TREE, common/widgets/lib_tree.cpp):
// a "Filter" box over the project's footprint libraries (every .pretty folder and every ${KIPRJMOD} row of
// fp-lib-table) with their footprints.  A click opens the footprint; the open one is highlighted, and its library
// opens by itself.  The model is web/editor/fpedit.ts (store slice fpLibs).
import { useMemo, useState } from "react";
import { useApp, type FpLibRow } from "../../store";
import { cx } from "../../util";
import { Twist } from "./widgets";

const NONE: FpLibRow[] = [];
export function LibrariesPane() {
  const libs = useApp((s) => (s.fpLibs ? s.fpLibs.libs : NONE));
  const current = useApp((s) => s.document.docId);
  const [filter, setFilter] = useState("");
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => libs.map((l) => ({ ...l, footprints: q ? l.footprints.filter((f) => (l.name + ":" + f.name).toLowerCase().includes(q)) : l.footprints }))
    .filter((l) => !q || l.footprints.length || l.name.toLowerCase().includes(q)), [libs, q]);
  // a library is open when it holds the open footprint or the filter matched inside it; a click on its twist flips that
  const isOpen = (name: string, hasCurrent: boolean) => ((hasCurrent || !!q) ? !flipped.has(name) : flipped.has(name));
  const toggle = (name: string) => { const n = new Set(flipped); if (n.has(name)) n.delete(name); else n.add(name); setFlipped(n); };
  const open = (docId: string) => window.dispatchEvent(new CustomEvent("kc-fpedit-pick", { detail: { docId } }));
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className="flex-none p-0.5">
        <input id="fpLibFilter" type="search" placeholder="Filter" value={filter} spellCheck={false} onChange={(ev) => setFilter(ev.target.value)}
          className="w-full min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" />
      </div>
      <div className="ktree overflow-auto min-h-0 flex-auto py-1" id="fpLibTree">
        {shown.length ? null : <div className="px-2 py-1 text-ink-3">{libs.length ? "No matches" : "The project has no footprint libraries. File > New Library... adds one."}</div>}
        {shown.map((l) => {
          const has = l.footprints.some((f) => f.docId === current); const o = isOpen(l.name, has);
          return (
            <div key={l.name}>
              <div className="node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel font-semibold" style={{ paddingLeft: 4 }} data-lib={l.name} onDoubleClick={() => toggle(l.name)}>
                <Twist open={o} leaf={!l.footprints.length} onToggle={() => toggle(l.name)} />
                <span>{l.name}</span>
              </div>
              {o ? l.footprints.map((f) => (
                <div key={f.docId} className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", f.docId === current && "cur")} style={{ paddingLeft: 4 + 14 }}
                  data-fp={f.docId} title={l.name + ":" + f.name} onClick={() => open(f.docId)}>
                  <Twist open={false} leaf onToggle={() => undefined} />
                  <span>{f.name}</span>
                </div>
              )) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
