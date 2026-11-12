// MsgPanel.tsx — KiCad's message panel (common/widgets/msgpanel.cpp EDA_MSG_PANEL), the strip between the
// canvas and the status bar.  Each MSG_PANEL_ITEM is a column: its upper text over its lower text, both in the
// window text colour.  The first column starts one 'W' in, and each column is as wide as its longer text plus
// the default padding (six spaces) and one more 'W' (EDA_MSG_PANEL::updateItemPos).  Its height is two lines.
import { useApp } from "../store";

export function MsgPanel() {
  const items = useApp((s) => s.msgPanel.items);
  // eeschema's panel: only while something answers (a selected table cell, SCH_TABLECELL::GetMsgPanelInfo)
  const show = useApp((s) => s.view === "editor" && (s.document.editor === "pcb" || (s.document.editor === "sch" && s.msgPanel.items.length > 0)));
  if (!show) return null;
  return (
    <div
      id="msgpanel"
      className="flex items-stretch overflow-hidden whitespace-pre bg-bench border-t border-line text-xs text-ink leading-[1.35] font-sans pl-[1em] py-0.5 min-h-[calc(2.7em+4px)] select-text"
      aria-label="Message panel"
    >
      {items.map((it, i) => (
        <div key={i} className="msgitem flex flex-col flex-none pr-[calc(6ch+1em)]">
          <span className="msgup">{it.title || " "}</span>
          <span className="msglow">{it.value || " "}</span>
        </div>
      ))}
    </div>
  );
}
