// Search.tsx — KiCad's Search pane (common/widgets/search_pane.cpp): a search box, one tab per handler
// (Footprints / Zones / Nets / Ratsnest / Text on a board; Symbols / Power / Text / Labels on a schematic)
// and the handler's columns.  A click on a row selects its item and zooms to it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchResult } from "../../panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { panels, pdispatch, usePanels } from "./widgets";

export function SearchPane() {
  const editor = useApp((s) => s.document.editor);
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const units = useApp((s) => s.viewport.units);
  const shown = useApp((s) => !!s.panes.search);
  const hierV = usePanels((s) => s.hierarchy.version);
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [cur, setCur] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabs = useMemo(() => { const p = panels(); return p && editor ? p.searchTabs() : []; }, [editor, docId]);
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0] ? tabs[0].id : "";
  const result: SearchResult = useMemo(() => {
    const p = panels();
    return p && active && shown ? p.search(active, q) : { tab: active, rows: [], total: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, q, docV, docId, units, shown, hierV]);
  useEffect(() => { if (shown && box.current) box.current.focus(); }, [shown]);
  const def = tabs.find((t) => t.id === active);
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="search">
      <div className="flex-none px-1.5 py-1 bg-bench">
        <input ref={box} id="searchBox" type="search" placeholder="Search" value={q} spellCheck={false} onChange={(ev) => setQ(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key !== "Escape") ev.stopPropagation(); }}
          className="w-full bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" />
      </div>
      <div className="ktabs flex flex-none border-b border-line bg-bench">
        {tabs.map((t) => <button type="button" key={t.id} data-stab={t.id} className={cx("bg-transparent border-0 border-b-2 border-b-transparent py-1 px-3 text-sm text-ink-2 on:text-ink on:border-b-blue on:bg-paper", t.id === active && "on")} onClick={() => setTab(t.id)}>{t.label}</button>)}
        <span className="ml-auto self-center pr-2 text-ink-3 text-xs" data-search-count>{result.total > result.rows.length ? `${result.rows.length} of ${result.total}` : `${result.total}`}</span>
      </div>
      <div className="flex-auto min-h-0 overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm" data-search-table={active}>
          <thead>
            <tr>{def ? def.columns.map((c) => <th key={c} className="sticky top-0 z-[1] px-2 py-0.5 text-left font-semibold whitespace-nowrap bg-bench border-b border-r border-line">{c}</th>) : null}</tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.key} data-search-row={r.key} className={cx("cursor-default hover:bg-panel cur:bg-sel", cur === r.key && "cur")}
                onClick={() => { setCur(r.key); pdispatch({ t: "searchSelect", row: r, zoom: true }); }}>
                {r.cells.map((c, i) => <td key={i} className="px-2 py-px whitespace-nowrap border-r border-line-soft max-w-[320px] overflow-hidden text-ellipsis">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
