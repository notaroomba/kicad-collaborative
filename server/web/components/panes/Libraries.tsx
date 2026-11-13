// Libraries.tsx — the Footprint Editor's library tree (FOOTPRINT_EDIT_FRAME's LIB_TREE, common/widgets/lib_tree.cpp,
// pcbnew/fp_tree_synchronizing_adapter.cpp): a "Filter" box over every footprint library: the project's (every
// .pretty folder and every ${KIPRJMOD} row of fp-lib-table) and the global ones (read-only; their footprints load
// when the library opens).  A click selects; a double-click or Enter opens a footprint (onTreeActivate) or expands
// a library; the arrow keys move.  Names carry " *" and bold when modified (the open footprint), pinned libraries
// lead with "☆ ", the description column follows the name, and the on-canvas footprint (or its collapsed library)
// is outlined.  The context menus are FOOTPRINT_EDITOR_CONTROL::Init's (editor/fptree.ts).  The model is
// web/editor/fpedit.ts (store slice fpLibs).
import { useMemo, useState } from "react";
import { useApp, type FpLibRow } from "../../store";
import { cx } from "../../util";
import { menuMeta } from "../../menuspec";
import { fpTreeMenu } from "../../editor/fptree";
import { ContextMenu, Twist, type MenuAt, type MenuItem } from "./widgets";

const NONE: FpLibRow[] = [];
type Sel = { lib: string; docId?: string } | null;
export function LibrariesPane() {
  const libs = useApp((s) => (s.fpLibs ? s.fpLibs.libs : NONE));
  const current = useApp((s) => s.document.docId);
  const modified = useApp((s) => !!(s.fpTitle && s.fpTitle.modified));
  const [filter, setFilter] = useState("");
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [sel, setSelState] = useState<Sel>(null);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => libs.map((l) => ({ ...l, footprints: q ? l.footprints.filter((f) => (l.name + ":" + f.name + " " + (f.descr || "")).toLowerCase().includes(q)) : l.footprints }))
    .filter((l) => !q || l.footprints.length || l.name.toLowerCase().includes(q)), [libs, q]);
  // a library is open when it holds the open footprint or the filter matched inside it; a click on its twist flips that
  const isOpen = (name: string, hasCurrent: boolean) => ((hasCurrent || !!q) ? !flipped.has(name) : flipped.has(name));
  const cmd = (detail: Record<string, string | undefined>) => window.dispatchEvent(new CustomEvent("kc-fpedit-lib", { detail }));
  const toggle = (name: string) => {
    const n = new Set(flipped); if (n.has(name)) n.delete(name); else n.add(name); setFlipped(n);
    const l = libs.find((x) => x.name === name); if (l && !l.loaded) cmd({ cmd: "loadLib", lib: name });
  };
  const setSel = (s: Sel) => { setSelState(s); cmd({ cmd: "select", lib: s ? s.lib : undefined, docId: s ? s.docId : undefined }); };
  const open = (docId: string) => window.dispatchEvent(new CustomEvent("kc-fpedit-pick", { detail: { docId } }));
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // LIB_TREE's context menu (FOOTPRINT_EDITOR_CONTROL::Init): rows whose condition is false are left out
  const showMenu = (ev: React.MouseEvent, lib: FpLibRow, docId?: string) => {
    ev.preventDefault(); setSel({ lib: lib.name, docId });
    const ids = fpTreeMenu({ libSelected: !docId, fpSelected: !!docId, hasFootprint: !!current, allPinned: docId ? true : !!lib.pinned, allUnpinned: docId ? true : !lib.pinned });
    const run: Record<string, () => void> = {
      newFootprint: () => cmd({ cmd: "new", lib: lib.name }), createFootprint: () => cmd({ cmd: "create", lib: lib.name }),
      save: () => cmd({ cmd: "save" }), saveAs: () => cmd(docId ? { cmd: "saveAs", docId } : { cmd: "saveAs", lib: lib.name }), revert: () => cmd({ cmd: "revert" }),
      cutFootprint: () => cmd({ cmd: "cut", docId }), copyFootprint: () => cmd({ cmd: "copy", docId }), pasteFootprint: () => cmd({ cmd: "paste", lib: lib.name }),
      duplicateFootprint: () => cmd({ cmd: "duplicate", docId }), renameFootprint: () => cmd({ cmd: "rename", docId }), deleteFootprint: () => cmd({ cmd: "delete", docId }),
      footprintProperties: () => cmd({ cmd: "properties", docId }), importFootprint: () => cmd({ cmd: "import", lib: lib.name }), exportFootprint: () => cmd({ cmd: "export" }),
      pinLibrary: () => cmd({ cmd: "pin", lib: lib.name }), unpinLibrary: () => cmd({ cmd: "unpin", lib: lib.name }), hideLibraryTree: () => cmd({ cmd: "hideTree" }),
    };
    const items: MenuItem[] = ids.map((id): MenuItem => (id === "-" ? "-" : { label: (menuMeta("pcb", id) || { label: id }).label, run: run[id] || (() => undefined), disabled: (id === "pinLibrary" || id === "unpinLibrary") && !!docId }));
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };
  // the rows as the keyboard walks them
  const visible: { lib: FpLibRow; docId?: string }[] = [];
  for (const l of shown) { const o = isOpen(l.name, l.footprints.some((f) => f.docId === current)); visible.push({ lib: l }); if (o) for (const f of l.footprints) visible.push({ lib: l, docId: f.docId }); }
  // LIB_TREE::onTreeCharHook / onTreeActivate
  const onKey = (ev: React.KeyboardEvent) => {
    if (!visible.length) return;
    const i = sel ? visible.findIndex((r) => r.lib.name === sel.lib && r.docId === sel.docId) : -1;
    const row = i >= 0 ? visible[i] : null;
    const go = (j: number) => { const r = visible[Math.max(0, Math.min(visible.length - 1, j))]; setSel({ lib: r.lib.name, docId: r.docId }); };
    const libOpen = row ? isOpen(row.lib.name, row.lib.footprints.some((f) => f.docId === current)) : false;
    if (ev.key === "ArrowDown") go(i + 1);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if ((ev.key === "ArrowRight" || ev.key === "+") && row && !row.docId && !libOpen) toggle(row.lib.name);
    else if ((ev.key === "ArrowLeft" || ev.key === "-") && row && !row.docId && libOpen) toggle(row.lib.name);
    else if (ev.key === "ArrowLeft" && row && row.docId) setSel({ lib: row.lib.name });
    else if (ev.key === "Enter" && row) { if (row.docId) open(row.docId); else toggle(row.lib.name); }
    else return;
    ev.preventDefault();
  };
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className="flex-none p-0.5">
        <input id="fpLibFilter" type="search" placeholder="Filter" value={filter} spellCheck={false} onChange={(ev) => { setFilter(ev.target.value); setFlipped(new Set()); }}
          onKeyDown={(ev) => { if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter") onKey(ev); }}
          className="w-full min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" />
      </div>
      <div className="ktree overflow-auto min-h-0 flex-auto py-1 outline-none" id="fpLibTree" tabIndex={0} onKeyDown={onKey}>
        {shown.length ? null : <div className="px-2 py-1 text-ink-3">{libs.length ? "No matches" : "The project has no footprint libraries. File > New Library... adds one."}</div>}
        {shown.map((l) => {
          const has = l.footprints.some((f) => f.docId === current); const o = isOpen(l.name, has);
          const libMod = has && modified;
          return (
            <div key={l.name}>
              <div className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", sel && sel.lib === l.name && !sel.docId && "cur")} style={{ paddingLeft: 4 }} data-lib={l.name}
                onClick={() => setSel({ lib: l.name })} onDoubleClick={() => toggle(l.name)} onContextMenu={(ev) => showMenu(ev, l)} title={l.descr || l.name}>
                <Twist open={o} leaf={!!l.loaded && !l.footprints.length} onToggle={() => toggle(l.name)} />
                <span className={cx("flex-none", libMod && "font-semibold", has && !o && "canvas-item")}>{(l.pinned ? "☆ " : "") + l.name + (libMod ? " *" : "")}</span>
                {l.descr ? <span className="ml-2 min-w-0 overflow-hidden text-ellipsis text-ink-3">{l.descr}</span> : null}
              </div>
              {o ? l.footprints.map((f) => {
                const cur = f.docId === current, mod = cur && modified;
                return (
                  <div key={f.docId} className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", sel && sel.docId === f.docId && "cur")} style={{ paddingLeft: 4 + 14 }}
                    data-fp={f.docId} title={l.name + ":" + f.name} onClick={() => setSel({ lib: l.name, docId: f.docId })} onDoubleClick={() => open(f.docId)} onContextMenu={(ev) => showMenu(ev, l, f.docId)}>
                    <Twist open={false} leaf onToggle={() => undefined} />
                    <span className={cx("flex-none", mod && "font-semibold", cur && "canvas-item")}>{f.name + (mod ? " *" : "")}</span>
                    {f.descr ? <span className="ml-2 min-w-0 overflow-hidden text-ellipsis text-ink-3">{f.descr}</span> : null}
                  </div>
                );
              }) : null}
            </div>
          );
        })}
      </div>
      <ContextMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
