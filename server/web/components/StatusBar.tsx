// StatusBar.tsx — EDA_DRAW_FRAME::UpdateStatusBar's fields: message, connection, project, edits,
// mode, Z, X/Y, dx/dy/dist (or r/θ in polar mode), grid and units.
import { useApp } from "../store";
import { fmtLen, unitName } from "../units";
import { cx } from "../util";

// One field of the bar: a vertically centred cell with a 1px rule on its left (KiCad's status panes).
const cell = "sbcell flex items-center px-2.5 border-l border-line whitespace-nowrap";

export function StatusBar() {
  const conn = useApp((s) => s.connection);
  const project = useApp((s) => s.project);
  const inEditor = useApp((s) => s.view === "editor" && !!s.document.editor);
  const status = useApp((s) => s.status);
  const vp = useApp((s) => s.viewport);
  const u = vp.units;
  const dx = vp.cursor[0] - vp.origin[0], dy = vp.cursor[1] - vp.origin[1];
  const delta = vp.polar
    ? `r ${fmtLen(Math.hypot(dx, dy), u)}  θ ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°`
    : `dx ${fmtLen(dx, u)}  dy ${fmtLen(dy, u)}  dist ${fmtLen(Math.hypot(dx, dy), u)}`;
  const live = conn.status === "live";
  const err = conn.status === "error" || conn.status === "connecting";
  return (
    <div
      id="statusbar"
      className="flex items-stretch gap-0 p-0 bg-bench border-t border-line text-xs font-mono font-normal leading-[normal] text-ink-2 tabular-nums"
    >
      <span className="sbmsg flex-1 flex items-center px-2.5 overflow-hidden text-ellipsis whitespace-nowrap font-sans" id="sbMsg">{status.message}</span>
      <span
        className={cx(
          cell,
          // the connection dot: grey by default, --wire when live, --err while connecting / on error
          "conn before:content-[''] before:inline-block before:w-[7px] before:h-[7px] before:rounded-[50%] before:bg-ink-3 before:mr-1.5 live:before:bg-wire err:before:bg-err",
          live && "live",
          err && "err",
        )}
        id="conn"
      >{conn.text || (live ? "live" : "offline")}</span>
      <span className={cell} id="sbProject">{inEditor && project ? `${project.name} · ${project.ownerLogin}` : ""}</span>
      <span className={cell} id="sbEdits">{conn.edits ? `${conn.edits} edit${conn.edits === 1 ? "" : "s"}` : ""}</span>
      <span className={cell} id="sbMode">{status.mode}</span>
      <span className={cell} id="sbZoom">Z {vp.zoom >= 10 ? vp.zoom.toFixed(0) : vp.zoom.toFixed(2)}</span>
      <span className={cell} id="sbCursor">X {fmtLen(vp.cursor[0], u)}  Y {fmtLen(vp.cursor[1], u)}</span>
      <span className={cell} id="sbDelta">{delta}</span>
      <span className={cell} id="sbGrid">grid {fmtLen(vp.gridPitch, u)} {unitName(u)}</span>
      <span className={cell} id="sbUnits">{unitName(u)}</span>
    </div>
  );
}
