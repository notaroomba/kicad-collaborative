// Appearance.tsx — the Appearance pane: Layers (visibility per layer), Objects (the movable items
// with a filter, plus the sheets on a schematic) and Nets.  `#layers` keeps its id: pcb-tools.js
// watches it to know when a document's layer list was rebuilt.
import { useState } from "react";
import { dispatch, useApp, type ItemSummary } from "../../store";
import { cx } from "../../util";

// A list row (`.layer`): flex, centred, 8px gap, 3px/4px padding, 2px radius; callers add the hover fill.
const ROW = "layer flex items-center gap-2 py-[3px] px-1 rounded-xs";
// The right-aligned mono count (`.layer .cnt`); `font: 11px var(--mono)` also reset weight and leading.
const CNT = "cnt ml-auto text-ink-3 text-xs font-mono font-normal leading-[normal]";

function fpName(fp: ItemSummary, sch: boolean): string {
  return sch ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()!) : (fp.lib || "?").split(":").pop()!;
}

function Layers() {
  const layers = useApp((s) => s.document.layers);
  const hidden = useApp((s) => s.document.hiddenLayers);
  const notice = useApp((s) => s.document.notice);
  if (notice) return <p className="note">{notice}</p>;
  if (!layers.length) return <p className="note">Nothing to show yet.</p>;
  return (
    <>
      {layers.map((l) => (
        <label className={cx(ROW, "hover:bg-panel")} key={l.key}>
          <input type="checkbox" className="m-0 accent-blue" data-lkey={l.key} checked={!hidden.includes(l.key)} onChange={(ev) => dispatch({ type: "setLayerVisible", key: l.key, visible: ev.target.checked })} />
          <span className="sw w-3.5 h-3.5 rounded-xs border border-black/40 flex-none" style={{ background: l.color }} /><span>{l.name}</span><span className={CNT}>{l.count}</span>
        </label>
      ))}
    </>
  );
}

function Objects() {
  const items = useApp((s) => s.document.items);
  const sheets = useApp((s) => s.document.sheets);
  const sch = useApp((s) => s.document.editor === "sch");
  const primary = useApp((s) => s.selection.primary);
  const [q, setQ] = useState("");
  const ql = q.toLowerCase();
  const list = items.filter((fp) => !ql || fpName(fp, sch).toLowerCase().includes(ql)).sort((a, b) => fpName(a, sch).localeCompare(fpName(b, sch)));
  return (
    <>
      <input id="objSearch" placeholder={sch ? "Filter symbols…" : "Filter footprints…"} value={q} onChange={(ev) => setQ(ev.target.value)}
        className="w-full mb-1.5 bg-canvas border border-line rounded-sm py-1 px-1.5 text-ink" />
      <div id="objList">
        {sch && sheets.length ? (
          <>
            <div className={cx(ROW, "hover:bg-panel")}><span className="muted">Sheets</span><span className={CNT}>{sheets.length}</span></div>
            {sheets.map((sh) => (
              <div className={cx(ROW, "hover:bg-panel cursor-pointer pl-3.5")} key={sh.id} data-sheet={sh.file} onClick={() => dispatch({ type: "enterSheet", file: sh.file })}>
                <span>{sh.name || sh.file}</span><span className={CNT}>↗</span>
              </div>
            ))}
          </>
        ) : null}
        <div className={cx(ROW, "hover:bg-panel")}><span className="muted">{sch ? "Symbols" : "Footprints"}</span><span className={CNT}>{list.length}/{items.length}</span></div>
        {list.slice(0, 300).map((fp) => (
          // the selected row's fill used to be an inline style, which also beat the hover fill: keep both states
          <div className={cx(ROW, "cursor-pointer pl-3.5", primary && primary.id === fp.id ? "bg-panel-2 hover:bg-panel-2" : "hover:bg-panel")} key={fp.id} data-fp={fp.id}
            onClick={() => dispatch({ type: "selectItem", id: fp.id })}>
            <span>{fpName(fp, sch)}</span><span className={CNT}>{Math.round(fp.rot || 0)}°</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function AppearancePane() {
  const [tab, setTab] = useState<"layers" | "objects" | "nets">("layers");
  return (
    <div className="kbody overflow-auto py-1.5 px-2 min-h-0 flex-auto bg-paper text-sm">
      <div className="ktabs flex border-b border-line -mt-1.5 -mx-2 mb-1.5 bg-bench">
        {(["layers", "objects", "nets"] as const).map((t) => (
          <button type="button" key={t} className={cx("flex-1 bg-transparent border-0 border-b-2 border-b-transparent py-1 px-0 text-sm text-ink-2 on:text-ink on:border-b-copper on:bg-paper", tab === t && "on")} data-atab={t} onClick={() => setTab(t)}>{t === "layers" ? "Layers" : t === "objects" ? "Objects" : "Nets"}</button>
        ))}
      </div>
      <div id="layers" hidden={tab !== "layers"}><Layers /></div>
      <div id="objects" hidden={tab !== "objects"}>{tab === "objects" ? <Objects /> : null}</div>
      <div id="nets" hidden={tab !== "nets"}><p className="note">Net colours and highlighting are set in the desktop app.</p></div>
    </div>
  );
}
