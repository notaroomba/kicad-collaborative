// StatusBar.tsx — the status bar of KiCad's drawing frames (EDA_DRAW_FRAME::UpdateStatusBar, DisplayGridMsg,
// DisplayUnitsMsg, DisplayToolMsg, DisplayConstraintsMsg), in its field order:
//
//   message | Z zoom | X … Y … | dx … dy … dist … (r … theta … in polar mode) | grid | units | tool | constraint
//
// The collaboration fields the desktop shows in its title bar and collab panel sit between the message and the
// zoom factor: the connection, the number of edits, and — as the frame title does — the sheet path on a
// schematic or the active layer on a board.  Every coordinate follows the units chosen in View > Units (or
// Ctrl+U), with the unit's fixed precision.
import { toDisplayAbs, toDisplayRel } from "../units";
import { useApp, type Editor } from "../store";
import { menuMeta } from "../menuspec";
import { EXTRA_TOOLS, TOOL_MAP } from "../tables";
import { fmtCoord, gridMessageText, unitsMsg } from "../units";
import { cx } from "../util";

// One field of the bar: a vertically centred cell with a 1px rule on its left (KiCad's status panes).
const cell = "sbcell flex items-center px-2.5 border-l border-line whitespace-nowrap";

/** The name KiCad shows for the active tool (the action's friendly name; the selection tool reads "Select item(s)"). */
function toolName(editor: Editor | null, tool: string, moduleLabel: string | undefined): string {
  if (tool === "select") return "Select item(s)";
  const extra = EXTRA_TOOLS.find((e) => e.tool === tool); if (extra) return extra.name;
  if (editor) for (const [action, id] of Object.entries(TOOL_MAP[editor])) if (id === tool) { const m = menuMeta(editor, action); if (m) return m.label; }
  return moduleLabel || tool;
}

export function StatusBar() {
  const conn = useApp((s) => s.connection);
  const inEditor = useApp((s) => s.view === "editor" && !!s.document.editor);
  const editor = useApp((s) => s.document.editor);
  const doc = useApp((s) => s.document.doc);
  const rootDocId = useApp((s) => s.document.rootDocId);
  useApp((s) => s.document.version);
  const status = useApp((s) => s.status);
  const vp = useApp((s) => s.viewport);
  const tool = useApp((s) => s.tool.current);
  const moduleTools = useApp((s) => s.tool.moduleTools);
  const u = vp.units;
  // MessageTextFromValue's short form on the schematic (sch_base_frame.cpp:264-272): "%.3f" mm / in, "%.0f" mils
  const sch = editor === "sch", c = (v: number) => fmtCoord(v, u, sch);
  // PCB_BASE_FRAME::UpdateStatusBar: the absolute and the cartesian relative coordinates go through the user's
  // origin transforms (Origins & Axes); the polar form is computed before them, from the raw offset
  const inv = !sch && editor === "pcb", ix = inv && !!vp.invertX, iy = inv && !!vp.invertY;
  const abs = inv ? toDisplayAbs(vp.cursor, vp.userOrigin || [0, 0], ix, iy) : vp.cursor;
  const rdx = vp.cursor[0] - vp.origin[0], rdy = vp.cursor[1] - vp.origin[1];
  const [dx, dy] = toDisplayRel([rdx, rdy], ix, iy);
  // only PCB_BASE_FRAME::UpdateStatusBar honours GetShowPolarCoords; eeschema always prints dx / dy / dist
  const delta = vp.polar && !sch
    ? `r ${c(Math.hypot(rdx, rdy))}  theta ${(Math.atan2(-rdy, rdx) * 180 / Math.PI).toFixed(3)}`
    : `dx ${c(dx)}  dy ${c(dy)}  dist ${c(Math.hypot(dx, dy))}`;
  // status field 7, DisplayConstraintsMsg: only pcbnew's DRAWING_TOOL::UpdateStatusBar writes it (by LEADER_MODE)
  const constraint = sch ? "" : vp.lineMode === "45" ? "Constrain to H, V, 45" : vp.lineMode === "90" ? "Constrain to H, V" : "";
  const live = conn.status === "live";
  const err = conn.status === "error" || conn.status === "connecting";
  // the sheet path as the editor resolved it for the title block ("/" on the root sheet, "/Name/" below it)
  const kdoc = (window as unknown as { CollabEditor?: { kdoc?: { sheetPath?: string; layers?: Map<string, { userName?: string }> } | null } }).CollabEditor?.kdoc;
  const stem = doc ? (doc.path.split("/").pop() || "").replace(/\.kicad_sch$/, "") : "";
  const sheetPath = (kdoc && kdoc.sheetPath) || (doc && rootDocId && doc.docId !== rootDocId ? `/${stem}/` : "/");
  // the board's own name for the layer (BOARD::GetLayerName), as the layer combo shows it
  const layerRow = kdoc && kdoc.layers && kdoc.layers.get ? kdoc.layers.get(vp.activeLayer) : null;
  const where = !inEditor ? "" : editor === "sch" ? sheetPath : (layerRow && layerRow.userName) || vp.activeLayer;
  return (
    <div
      id="statusbar"
      className="flex items-stretch gap-0 p-0 min-w-0 overflow-hidden bg-bench border-t border-line text-xs font-mono font-normal leading-[normal] text-ink-2 tabular-nums"
    >
      <span className="sbmsg flex-1 flex items-center px-2.5 overflow-hidden text-ellipsis whitespace-nowrap font-sans min-w-0" id="sbMsg">{status.message}</span>
      <span
        className={cx(
          cell,
          // the connection dot: grey by default, --wire when live, --err while connecting / on error
          "conn before:content-[''] before:inline-block before:w-[7px] before:h-[7px] before:rounded-full before:bg-ink-3 before:mr-1.5 live:before:bg-wire err:before:bg-err",
          live && "live",
          err && "err",
        )}
        id="conn"
      >{conn.text || (live ? "live" : "offline")}</span>
      {conn.edits ? <span className={cell} id="sbEdits">{`${conn.edits} edit${conn.edits === 1 ? "" : "s"}`}</span> : null}
      {inEditor ? (
        <>
          <span className={cx(cell, "max-[900px]:hidden")} id="sbWhere" title={editor === "sch" ? "Sheet path" : "Active layer"}>{where}</span>
          <span className={cx(cell, "min-w-[calc(9ch+20px)] max-[560px]:hidden")} id="sbZoom">Z {vp.kzoom.toFixed(2)}</span>
          <span className={cx(cell, "min-w-[calc(26ch+20px)]")} id="sbCursor">X {c(abs[0])}  Y {c(abs[1])}</span>
          <span className={cx(cell, "min-w-[calc(42ch+20px)] max-[1180px]:hidden")} id="sbDelta">{delta}</span>
          {/* EDA_DRAW_FRAME::DisplayGridMsg ("grid %s", GRID::UserUnitsMessageText) and DisplayUnitsMsg: plain text; the
              units change from the left toolbar or Ctrl+U */}
          <span className={cx(cell, "min-w-[calc(16ch+20px)]")} id="sbGrid">grid {gridMessageText(vp.gridPitch, vp.gridPitch, u, sch ? "sch" : "pcb")}</span>
          <span className={cell} id="sbUnits">{unitsMsg(u)}</span>
          <span className={cx(cell, "font-sans min-w-0 overflow-hidden text-ellipsis max-[640px]:hidden")} id="sbTool">{toolName(editor, tool, moduleTools.find((t) => t.id === tool)?.label)}</span>
          {constraint ? <span className={cx(cell, "font-sans min-w-0 overflow-hidden text-ellipsis max-[1024px]:hidden")} id="sbMode">{constraint}</span> : null}
        </>
      ) : null}
    </div>
  );
}
