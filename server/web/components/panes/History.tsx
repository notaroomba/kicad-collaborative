// History.tsx — the project's history: the versions somebody saved, the versions the server kept by itself before
// a restore or a merge, and the runs of edits in between.  Clicking a row puts that point on the canvas (the
// timeline bar in components/VersionHistory.tsx scrubs from there); the row at the top is the present.
import { dispatch, useApp } from "../../store";
import type { HistoryRun, VersionInfo } from "../../store";
import { cx } from "../../util";

const BODY = "kbody overflow-auto p-0 min-h-0 flex-auto bg-paper text-sm";
const ROW = "group flex items-start gap-1.5 w-full px-2 py-1 border-0 border-b border-line-soft bg-transparent text-left text-ink cursor-default hover:bg-sel-soft sel:bg-sel";
const DAY = "sticky top-0 z-[1] px-2 py-0.5 text-2xs font-mono uppercase tracking-wide text-ink-3 bg-bench border-b border-line";
const BTN = "btn sm";

type Entry =
  | { t: "version"; at: number; v: VersionInfo }
  | { t: "run"; at: number; r: HistoryRun };

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function day(ms: number): string {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const who = (u: { name?: string | null; login?: string | null } | null | undefined): string => (u && (u.name || u.login)) || "Somebody";
const fileName = (path: string): string => path.split("/").pop() || path;

/** The glyph in front of a row: a filled dot for a saved version, a ring for one kept automatically, a tick for edits. */
function Dot({ kind }: { kind: "named" | "auto" | "edit" | "restore" | "merge" | "now" }) {
  const c = kind === "named" ? "bg-blue border-blue" : kind === "now" ? "bg-wire border-wire" : kind === "auto" ? "bg-transparent border-ink-3" : "bg-ink-3 border-ink-3 scale-50";
  return <span className={cx("mt-[5px] w-2 h-2 flex-none rounded-full border", c)} aria-hidden="true" />;
}

function runText(r: HistoryRun, multi: boolean): string {
  const n = r.count;
  const what = r.kind === "restore" ? "restored an earlier version" : r.kind === "merge" ? `merged ${n} ${n === 1 ? "edit" : "edits"}` : `${n} ${n === 1 ? "edit" : "edits"}`;
  return `${who(r.author)} · ${what}${multi ? ` · ${fileName(r.path)}` : ""}`;
}

/**
 * A run of edits that a kept version falls inside is shown as two: what led up to the version and what came
 * after it.  The server only knows runs by author and pauses; the list reads better with versions as its joints.
 */
function splitRuns(runs: HistoryRun[], versions: VersionInfo[]): HistoryRun[] {
  const out: HistoryRun[] = [];
  for (const r of runs) {
    if (r.kind !== "edit") { out.push(r); continue; }
    const cuts = versions.flatMap((v) => v.docs.filter((d) => d.docId === r.docId && d.seq >= r.from && d.seq < r.to).map((d) => ({ seq: d.seq, at: v.createdAt })))
      .sort((a, b) => a.seq - b.seq).filter((c, i, all) => !i || all[i - 1].seq !== c.seq);
    let from = r.from, started = r.startedAt;
    for (const c of cuts) {
      out.push({ ...r, from, to: c.seq, count: c.seq - from + 1, startedAt: started, endedAt: c.at });
      from = c.seq + 1; started = c.at;
    }
    out.push({ ...r, from, count: r.to - from + 1, startedAt: started });
  }
  return out;
}

export function HistoryPane() {
  const vs = useApp((s) => s.versions);
  const me = useApp((s) => s.me);
  const docId = useApp((s) => s.document.docId);
  const view = vs.view;
  if (vs.error && !vs.list.length && !vs.runs.length) {
    return <div className={BODY} id="history"><p className="note px-2">{me ? `The history could not be loaded: ${vs.error}` : "Sign in to see this project's history."}</p></div>;
  }
  const entries: Entry[] = [
    ...vs.list.map((v): Entry => ({ t: "version", at: new Date(v.createdAt).getTime(), v })),
    ...splitRuns(vs.runs, vs.list).map((r): Entry => ({ t: "run", at: new Date(r.endedAt).getTime(), r })),
  ].sort((a, b) => b.at - a.at || (a.t === "version" ? -1 : 1));
  const multi = new Set(vs.runs.map((r) => r.docId)).size > 1;
  let lastDay = "";
  return (
    <div className={BODY} id="history">
      <button type="button" className={cx(ROW, !view && "sel")} data-history="now" onClick={() => dispatch({ type: "versions", cmd: "exit" })}>
        <Dot kind="now" />
        <span className="min-w-0 flex-auto"><span className="block font-semibold">Current version</span>
          <span className="block text-ink-2 text-xs">{vs.branchName ? `Branch ${vs.branchName}` : "What everyone is editing now"}</span></span>
      </button>
      {entries.map((e) => {
        const d = day(e.at), head = d !== lastDay ? <div className={DAY} key={"d" + d}>{d}</div> : null;
        lastDay = d;
        if (e.t === "version") {
          const v = e.v, named = v.kind === "named";
          const here = !!view && view.versionId === v.id;
          return [head,
            <button type="button" key={v.id} className={cx(ROW, here && "sel")} data-version={v.id} data-version-name={v.name || ""} title={v.description || undefined}
              onClick={() => dispatch({ type: "versions", cmd: "viewVersion", versionId: v.id })}>
              <Dot kind={named ? "named" : "auto"} />
              <span className="min-w-0 flex-auto">
                <span className={cx("block truncate", named ? "font-semibold" : "text-ink-2 italic")}>{v.name || "Kept automatically"}</span>
                <span className="block truncate text-ink-2 text-xs">{who(v.author)}{v.description ? ` · ${v.description}` : ""}</span>
              </span>
              <span className="flex-none text-ink-3 text-xs font-mono">{clock(e.at)}</span>
            </button>];
        }
        const r = e.r, here = !!view && view.docId === r.docId && view.versionId === null && view.seq === r.to;
        return [head,
          <button type="button" key={`${r.docId}:${r.from}`} className={cx(ROW, here && "sel")} data-run={`${r.docId}:${r.to}`}
            onClick={() => dispatch({ type: "versions", cmd: "view", docId: r.docId, seq: r.to })}>
            <Dot kind={r.kind} />
            <span className={cx("min-w-0 flex-auto truncate", r.docId === docId ? "text-ink" : "text-ink-2")}>{runText(r, multi)}</span>
            <span className="flex-none text-ink-3 text-xs font-mono">{clock(e.at)}</span>
          </button>];
      })}
      {!entries.length && !vs.loading ? <p className="note px-2">Nothing has been saved yet. Save a version to name the project as it is now; you can come back to it, or start a branch from it, at any time.</p> : null}
      {entries.length ? <p className="note px-2 text-xs">Every edit of the last 30 days can be scrubbed through. Saved versions are kept for good.</p> : null}
    </div>
  );
}

export function HistoryButtons() {
  const role = useApp((s) => s.role);
  const me = useApp((s) => s.me);
  const branch = useApp((s) => s.versions.branchName);
  const n = useApp((s) => s.versions.branches.length);
  const editor = role === "editor";
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-line bg-bench flex-none">
      <button type="button" className={cx(BTN, "primary")} data-uiact="save" disabled={!editor} title={editor ? "Name the project as it is now (Ctrl+S)" : "Only editors can save versions"}
        onClick={() => dispatch({ type: "action", id: "save" })}>Save version...</button>
      <button type="button" className={BTN} data-uiact="branches" disabled={!me} title="Try something without touching the main line"
        onClick={() => dispatch({ type: "versions", cmd: "dialog", dialog: { kind: "branches" } })}>
        {branch ? `Branch: ${branch}` : n ? `Branches (${n})` : "Branches..."}
      </button>
    </div>
  );
}
