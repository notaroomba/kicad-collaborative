// VersionHistory.tsx — the timeline bar that sits over the canvas while an earlier version is on screen, and the
// dialogs of version history and branches (save, rename, restore, branch, merge).  All of it renders from
// store.versions; every intent goes back through dispatch({ type: "versions", … }) to web/editor/versions.ts.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { dispatch, useApp } from "../store";
import type { BranchInfo, HistoryAt, HistoryView, VersionDialog, VersionsCmd } from "../store";
import { ago, cx } from "../util";

const run = (cmd: VersionsCmd): void => dispatch({ type: "versions", ...cmd });
const close = (): void => run({ cmd: "dialog", dialog: null });
const stamp = (ms: number): string => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

// ---------------------------------------------------------------- the timeline bar

/** Where the canvas is on the page: the bar is laid over it, not inside it, so the stage never sees its clicks. */
function useStageRect(on: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!on) return;
    const stage = document.getElementById("stage"); if (!stage) return;
    const read = (): void => setRect(stage.getBoundingClientRect());
    read();
    const ro = new ResizeObserver(read); ro.observe(stage);
    window.addEventListener("resize", read);
    return () => { ro.disconnect(); window.removeEventListener("resize", read); };
  }, [on]);
  return on ? rect : null;
}

const G = { prev: "M15 6l-6 6 6 6", next: "M9 6l6 6-6 6", play: "M8 5v14l11-7z", pause: "M8 5v14M16 5v14" };
function IconBtn({ d, title, onClick, disabled, fill, id }: { d: string; title: string; onClick(): void; disabled?: boolean; fill?: boolean; id?: string }) {
  return (
    <button type="button" className="btn sm ghost w-7 p-0" title={title} aria-label={title} onClick={onClick} disabled={disabled} data-history-btn={id}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className={cx("stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]", fill ? "fill-current" : "fill-none")}><path d={d} /></svg>
    </button>
  );
}

function Scrubber({ view }: { view: HistoryView }) {
  const span = Math.max(1, view.head - view.floor);
  return (
    <div className="relative flex-auto min-w-0 h-7">
      {/* kept versions as ticks over the track: a click jumps there */}
      {view.marks.filter((m) => m.seq >= view.floor && m.seq <= view.head).map((m, i) => (
        <button type="button" key={i} title={m.name} aria-label={m.name} data-mark={m.seq}
          className={cx("absolute top-0 w-2 h-2 -ml-1 p-0 rounded-full border cursor-pointer", m.named ? "bg-blue border-blue" : "bg-panel border-ink-3")}
          style={{ left: `calc(8px + (100% - 16px) * ${(m.seq - view.floor) / span})` }}
          onClick={() => run({ cmd: "view", docId: view.docId, seq: m.seq })} />
      ))}
      <input type="range" id="historyScrub" className="absolute left-0 right-0 bottom-0 w-full m-0 accent-[var(--blue)]" aria-label="Scrub through the history"
        min={view.floor} max={view.head} step={1} value={view.seq}
        onChange={(ev) => run({ cmd: "view", docId: view.docId, seq: Number(ev.currentTarget.value) })} />
    </div>
  );
}

export function HistoryBar() {
  const view = useApp((s) => s.versions.view);
  const versions = useApp((s) => s.versions.list);
  const inBranch = useApp((s) => !!s.versions.parentId);
  const role = useApp((s) => s.role);
  const rect = useStageRect(!!view);
  // Esc leaves the timeline, the arrows step through it (unless a dialog or a field has the keyboard)
  const dialogOpen = useApp((s) => !!s.versions.dialog);
  useEffect(() => {
    if (!view || dialogOpen) return;
    const key = (ev: KeyboardEvent): void => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT")) return;
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); run({ cmd: "exit" }); }
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); ev.stopPropagation(); run({ cmd: "step", by: (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? 10 : 1) }); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [!!view, dialogOpen]);
  if (!view || !rect) return null;
  const editor = role === "editor";
  const version = view.versionId ? versions.find((v) => v.id === view.versionId) || null : null;
  const atHead = view.seq >= view.head;
  const at: HistoryAt = { docId: view.docId, seq: view.seq };
  const when = view.at ? stamp(view.at) : "";
  const label = version ? (version.name || "Kept automatically") : atHead ? "Current version" : when || `Edit ${view.seq}`;
  const restoreLabel = version && version.name ? `"${version.name}"` : when ? `the version of ${when}` : "this version";
  const canCompare = !!(window as unknown as { CollabReview?: { openCompare?: unknown } }).CollabReview?.openCompare;
  return (
    <>
      <div id="historyBanner" className="fixed z-40 flex items-center gap-2 px-3 py-1 rounded-md border border-line bg-panel shadow-panel text-sm text-ink pointer-events-none"
        style={{ left: rect.left + rect.width / 2, top: rect.top + 8, transform: "translateX(-50%)" }}>
        <span className="pill info">History</span>
        <span>{atHead ? "This is the current version." : "You are looking at an earlier version. Nothing here can be edited."}</span>
      </div>
      <div id="historyBar" className="fixed z-40 flex flex-col gap-1.5 px-3 py-2 rounded-md border border-line bg-panel shadow-panel text-sm text-ink"
        style={{ left: rect.left + 12, width: Math.max(280, rect.width - 24), bottom: Math.max(8, window.innerHeight - rect.bottom + 12) }}>
        <div className="flex items-center gap-2 min-w-0">
          <IconBtn d={G.prev} id="prev" title="One edit back (Left arrow)" disabled={view.seq <= view.floor} onClick={() => run({ cmd: "step", by: -1 })} />
          <IconBtn d={view.playing ? G.pause : G.play} id="play" fill={!view.playing} title={view.playing ? "Pause" : "Play the history"} onClick={() => run({ cmd: "play", on: !view.playing })} />
          <IconBtn d={G.next} id="next" title="One edit forward (Right arrow)" disabled={atHead} onClick={() => run({ cmd: "step", by: 1 })} />
          <Scrubber view={view} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 min-w-0">
          <span className="min-w-0 truncate" id="historyWhere">
            <b className="font-semibold">{label}</b>
            <span className="text-ink-2">{version && when ? ` · ${when}` : ""}{view.who ? ` · ${view.who}` : ""}</span>
            <span className="text-ink-3 font-mono text-xs"> · edit {view.seq - view.floor} of {view.head - view.floor}</span>
            {view.loading ? <span className="spinner ml-2 align-middle" aria-label="Loading" /> : null}
            {view.error ? <span className="text-err"> · {view.error}</span> : null}
          </span>
          <span className="flex-auto" />
          {canCompare && !atHead ? <button type="button" className="btn sm" data-history-btn="compare" title="See what changed between this version and the current one" onClick={() => run({ cmd: "compare" })}>Compare with current</button> : null}
          {version
            ? <button type="button" className="btn sm" data-history-btn="rename" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: { kind: "rename", versionId: version.id, name: version.name || "", description: version.description } })}>{version.kind === "named" ? "Rename..." : "Name..."}</button>
            : <button type="button" className="btn sm" data-history-btn="name" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: atHead ? { kind: "save" } : { kind: "save", at } })} title="Keep this point for good, under a name">Name...</button>}
          {version ? <button type="button" className="btn sm danger" data-history-btn="delete" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: { kind: "deleteVersion", versionId: version.id, label: version.name || "this version" } })}>Delete</button> : null}
          {!inBranch ? <button type="button" className="btn sm" data-history-btn="branch" disabled={!editor} title="Start a branch from this version; the main line is not touched"
            onClick={() => run({ cmd: "dialog", dialog: version ? { kind: "newBranch", versionId: version.id, from: restoreLabel } : atHead ? { kind: "newBranch", from: "the current version" } : { kind: "newBranch", at, from: restoreLabel } })}>Branch from here...</button> : null}
          <button type="button" className="btn sm" data-history-btn="restore" disabled={!editor || atHead} title={editor ? "Make this the current version for everyone" : "Only editors can restore"}
            onClick={() => run({ cmd: "dialog", dialog: version ? { kind: "restore", versionId: version.id, label: restoreLabel } : { kind: "restore", at, label: restoreLabel } })}>Restore...</button>
          <button type="button" className="btn sm primary" data-history-btn="done" onClick={() => run({ cmd: "exit" })}>Back to current</button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- dialogs

function Modal({ title, children, foot, onSubmit, width }: { title: string; children: ReactNode; foot: ReactNode; onSubmit?(): void; width?: number }) {
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") || el.querySelector<HTMLElement>("input, textarea, select") || el.querySelector<HTMLElement>(".kd-foot .primary, .kd-foot .solid");
    if (first) { first.focus(); if (first instanceof HTMLInputElement) first.select(); }
    const key = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); } else ev.stopPropagation(); };
    // the editor's own hotkeys must not fire while a dialog has the keyboard
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const submit = (ev: FormEvent): void => { ev.preventDefault(); if (onSubmit) onSubmit(); };
  return (
    <div className="kd-overlay" data-version-dialog onPointerDown={(ev) => { if (ev.target === ev.currentTarget) close(); }}>
      <form className="kd-dialog" ref={box} role="dialog" aria-modal="true" aria-label={title} style={{ width: width || 440 }} onSubmit={submit}>
        <div className="kd-title">{title}<span className="kd-x" role="button" aria-label="Close" onClick={close}>×</span></div>
        <div className="kd-body flex flex-col gap-2.5 text-sm">{children}</div>
        <div className="kd-foot">{foot}</div>
      </form>
    </div>
  );
}
const Cancel = () => <button type="button" className="btn" onClick={close}>Cancel</button>;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-ink-2 text-xs">{label}</span>{children}</label>;
}

function SaveDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "save" }>; busy: boolean }) {
  const [name, setName] = useState(""), [note, setNote] = useState("");
  const ok = !!name.trim() && !busy;
  return (
    <Modal title={d.at ? "Name this version" : "Save version"} onSubmit={() => { if (ok) run({ cmd: "save", name: name.trim(), description: note.trim(), at: d.at }); }}
      foot={<><Cancel /><button type="submit" className="btn primary" disabled={!ok}>{busy ? "Saving..." : "Save version"}</button></>}>
      <p className="m-0 text-ink-2">{d.at ? "Keeps the project as it was at this point of the timeline, under a name, for good." : "Keeps the whole project as it is now, under a name. You can look at it, restore it or start a branch from it at any time."}</p>
      <Field label="Name"><input className="input" id="versionName" data-autofocus maxLength={120} placeholder="For example: Before rerouting USB" value={name} onChange={(e) => setName(e.currentTarget.value)} /></Field>
      <Field label="Note (optional)"><textarea className="input font-sans text-base" id="versionNote" rows={2} placeholder="What changed, or why this point matters" value={note} onChange={(e) => setNote(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

function RenameDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "rename" }>; busy: boolean }) {
  const [name, setName] = useState(d.name), [note, setNote] = useState(d.description);
  const ok = !!name.trim() && !busy;
  return (
    <Modal title={d.name ? "Rename version" : "Name this version"} onSubmit={() => { if (ok) run({ cmd: "rename", versionId: d.versionId, name: name.trim(), description: note.trim() }); }}
      foot={<><Cancel /><button type="submit" className="btn primary" disabled={!ok}>Save</button></>}>
      <Field label="Name"><input className="input" id="versionName" data-autofocus maxLength={120} value={name} onChange={(e) => setName(e.currentTarget.value)} /></Field>
      <Field label="Note (optional)"><textarea className="input font-sans text-base" id="versionNote" rows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

function RestoreDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "restore" }>; busy: boolean }) {
  const peers = useApp((s) => s.peers.list.length);
  return (
    <Modal title="Restore version" onSubmit={() => { if (!busy) run({ cmd: "restore", versionId: d.versionId, at: d.at, label: d.label }); }}
      foot={<><Cancel /><button type="submit" className="btn primary" id="restoreConfirm" disabled={busy}>{busy ? "Restoring..." : "Restore"}</button></>}>
      <p className="m-0">Make {d.label} the current version of the project?</p>
      <p className="m-0 text-ink-2">Everyone working on it gets this version{peers ? ` (${peers} other ${peers === 1 ? "person is" : "people are"} here now)` : ""}. The project as it is now is kept in History as "Before restoring…", so this can be taken back.</p>
    </Modal>
  );
}

function ConfirmDialog({ title, text, sub, action, onOk, busy }: { title: string; text: string; sub?: string; action: string; onOk(): void; busy: boolean }) {
  return (
    <Modal title={title} onSubmit={() => { if (!busy) onOk(); }} foot={<><Cancel /><button type="submit" className="btn danger solid" id="versionConfirm" disabled={busy}>{action}</button></>}>
      <p className="m-0">{text}</p>
      {sub ? <p className="m-0 text-ink-2">{sub}</p> : null}
    </Modal>
  );
}

function NewBranchDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "newBranch" }>; busy: boolean }) {
  const [name, setName] = useState(""), [note, setNote] = useState(""), [open, setOpen] = useState(true);
  const taken = useApp((s) => s.versions.branches.some((b) => b.name.toLowerCase() === name.trim().toLowerCase()));
  const ok = !!name.trim() && !taken && !busy;
  return (
    <Modal title="New branch" onSubmit={() => { if (ok) run({ cmd: "newBranch", name: name.trim(), description: note.trim(), versionId: d.versionId, at: d.at, open }); }}
      foot={<><Cancel /><button type="submit" className="btn primary" disabled={!ok}>{busy ? "Creating..." : "Create branch"}</button></>}>
      <p className="m-0 text-ink-2">A branch is a copy of the project, starting from {d.from}, that you and your collaborators can change freely. The main line is not touched until you merge the branch back.</p>
      <Field label="Name"><input className={cx("input", taken && "bad")} id="branchName" data-autofocus maxLength={60} placeholder="For example: tighter-layout" value={name} onChange={(e) => setName(e.currentTarget.value)} /></Field>
      {taken ? <p className="m-0 text-err text-xs">There is already a branch with that name.</p> : null}
      <Field label="What it is for (optional)"><input className="input" id="branchNote" maxLength={200} value={note} onChange={(e) => setNote(e.currentTarget.value)} /></Field>
      <label className="flex items-center gap-2"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.currentTarget.checked)} /> Switch to the branch now</label>
    </Modal>
  );
}

function RenameBranchDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "renameBranch" }>; busy: boolean }) {
  const [name, setName] = useState(d.name), [note, setNote] = useState(d.description);
  const ok = !!name.trim() && !busy;
  return (
    <Modal title="Rename branch" onSubmit={() => { if (ok) run({ cmd: "renameBranch", projectId: d.projectId, name: name.trim(), description: note.trim() }); }}
      foot={<><button type="button" className="btn" onClick={() => run({ cmd: "dialog", dialog: { kind: "branches" } })}>Cancel</button><button type="submit" className="btn primary" disabled={!ok}>Save</button></>}>
      <Field label="Name"><input className="input" id="branchName" data-autofocus maxLength={60} value={name} onChange={(e) => setName(e.currentTarget.value)} /></Field>
      <Field label="What it is for (optional)"><input className="input" id="branchNote" maxLength={200} value={note} onChange={(e) => setNote(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

function BranchRow({ b, current, editor }: { b: BranchInfo; current: boolean; editor: boolean }) {
  const state = b.ahead === 0 && b.behind === 0 ? (b.mergedAt ? "Merged, same as main" : "Same as main")
    : [b.ahead ? `${b.ahead} ${b.ahead === 1 ? "edit" : "edits"} not in main` : "", b.behind ? `${b.behind} behind main` : ""].filter(Boolean).join(" · ");
  return (
    <div className={cx("flex items-center gap-2 px-2.5 py-2 border-b border-line-soft", current && "bg-sel")} data-branch={b.name}>
      <div className="min-w-0 flex-auto">
        <div className="flex items-center gap-1.5 min-w-0"><b className="font-semibold truncate">{b.name}</b>{current ? <span className="pill info">open</span> : null}</div>
        <div className="text-ink-2 text-xs truncate">{b.description ? `${b.description} · ` : ""}{state} · {b.createdBy ? `by ${b.createdBy.name || b.createdBy.login} · ` : ""}changed {ago(b.updatedAt)}</div>
      </div>
      {!current ? <button type="button" className="btn sm" data-branch-act="open" onClick={() => run({ cmd: "openBranch", projectId: b.projectId })}>Open</button> : null}
      <button type="button" className="btn sm" data-branch-act="update" disabled={!editor || !b.behind} title="Bring main's newer work into this branch" onClick={() => run({ cmd: "dialog", dialog: { kind: "merge", projectId: b.projectId, name: b.name, direction: "from_main" } })}>Update from main...</button>
      <button type="button" className="btn sm" data-branch-act="merge" disabled={!editor || !b.ahead} title="Bring this branch's work to the main line" onClick={() => run({ cmd: "dialog", dialog: { kind: "merge", projectId: b.projectId, name: b.name, direction: "into_main" } })}>Merge into main...</button>
      <button type="button" className="btn sm ghost" data-branch-act="rename" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: { kind: "renameBranch", projectId: b.projectId, name: b.name, description: b.description } })}>Rename</button>
      <button type="button" className="btn sm ghost danger" data-branch-act="delete" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: { kind: "deleteBranch", projectId: b.projectId, name: b.name } })}>Delete</button>
    </div>
  );
}

function BranchesDialog() {
  const vs = useApp((s) => s.versions);
  const pid = useApp((s) => s.project && s.project.projectId);
  const editor = useApp((s) => s.role) === "editor";
  const onMain = !vs.parentId;
  return (
    <Modal title="Branches" width={720} foot={<>
      <button type="button" className="btn" id="newBranchBtn" disabled={!editor} onClick={() => run({ cmd: "dialog", dialog: { kind: "newBranch", from: "the main line as it is now" } })}>New branch...</button>
      <span className="spacer" /><button type="button" className="btn primary" onClick={close}>Close</button></>}>
      <p className="m-0 text-ink-2">Try a layout or a circuit change on a branch: everything works as usual there, live with your collaborators, and the main line stays as it is until you merge.</p>
      <div className="border border-line rounded-sm bg-paper">
        <div className={cx("flex items-center gap-2 px-2.5 py-2 border-b border-line-soft", onMain && "bg-sel")} data-branch="main">
          <div className="min-w-0 flex-auto"><div className="flex items-center gap-1.5"><b className="font-semibold">main</b>{onMain ? <span className="pill info">open</span> : null}</div>
            <div className="text-ink-2 text-xs">The project's own line{vs.main ? ` · ${vs.main.name}` : ""}</div></div>
          {!onMain && vs.main ? <button type="button" className="btn sm" data-branch-act="open" onClick={() => run({ cmd: "openBranch", projectId: vs.main!.projectId })}>Open</button> : null}
        </div>
        {vs.branches.map((b) => <BranchRow key={b.projectId} b={b} current={b.projectId === pid} editor={editor} />)}
        {!vs.branches.length ? <p className="note px-2.5">No branches yet.</p> : null}
      </div>
    </Modal>
  );
}

interface MergePreview {
  nothing: boolean; canMerge: boolean; reason: string | null; conflicts: number;
  docs: { path: string; action: string; ops: number; changes: number; changedHere: boolean; conflicts: { id: string; label: string }[] }[];
}

function MergeDialog({ d, busy }: { d: Extract<VersionDialog, { kind: "merge" }>; busy: boolean }) {
  const [pv, setPv] = useState<MergePreview | null>(null), [err, setErr] = useState<string | null>(null);
  const [prefer, setPrefer] = useState<"incoming" | "current">("incoming"), [replace, setReplace] = useState(false);
  const into = d.direction === "into_main";
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${d.projectId}/merge`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ direction: d.direction, dryRun: true }) })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message || `the server answered ${r.status}`); return j as MergePreview; })
      .then((j) => { if (live) { setPv(j); if (!j.canMerge) setReplace(true); } }, (e: unknown) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [d.projectId, d.direction]);
  const src = into ? `the branch "${d.name}"` : "main", dst = into ? "main" : `the branch "${d.name}"`;
  const title = into ? `Merge "${d.name}" into main` : `Update "${d.name}" from main`;
  const conflicts = pv ? pv.docs.flatMap((x) => x.conflicts.map((c) => c.label)) : [];
  const ok = !!pv && !busy && (!pv.nothing || (replace && pv.docs.some((x) => x.changedHere)));
  const line = (x: MergePreview["docs"][number]): string => x.action === "add" ? "new file" : x.action === "take" ? "the file is taken whole" : x.action === "merge" ? `${x.changes} ${x.changes === 1 ? "change" : "changes"} in ${x.ops} ${x.ops === 1 ? "edit" : "edits"}` : x.changedHere ? `no changes (changed only in ${into ? "main" : "the branch"})` : "no changes";
  return (
    <Modal title={title} width={560} onSubmit={() => { if (ok) run({ cmd: "merge", projectId: d.projectId, direction: d.direction, replace, prefer }); }}
      foot={<><Cancel /><button type="submit" className="btn primary" id="mergeConfirm" disabled={!ok}>{busy ? "Working..." : replace ? "Replace" : into ? "Merge" : "Update"}</button></>}>
      {err ? <div className="callout err">The preview could not be made: {err}</div> : null}
      {!pv && !err ? <p className="m-0 text-ink-2"><span className="spinner mr-2 align-middle" />Looking at what changed...</p> : null}
      {pv ? <>
        <p className="m-0 text-ink-2">{pv.nothing ? `There is nothing in ${src} that ${dst} does not already have.` : `What ${src} did since the two last met is applied to ${dst}. ${into ? "Main" : "The branch"} as it is now is kept in its History first, so this can be taken back.`}</p>
        <div className="border border-line rounded-sm bg-paper" id="mergeDocs">
          {pv.docs.map((x) => (
            <div key={x.path} className="flex items-baseline gap-2 px-2.5 py-1.5 border-b border-line-soft last:border-b-0">
              <span className="font-mono text-xs min-w-0 truncate flex-auto">{x.path}</span>
              <span className={cx("flex-none text-xs", x.action === "none" ? "text-ink-3" : "text-ink")}>{line(x)}</span>
              {x.conflicts.length ? <span className="pill warn flex-none">{x.conflicts.length} changed on both sides</span> : null}
            </div>
          ))}
        </div>
        {!pv.canMerge ? <div className="callout warn" id="mergeNotLinear">{pv.reason}</div> : null}
        {conflicts.length && !replace ? (
          <div className="flex flex-col gap-1.5" id="mergeConflicts">
            <div className="callout warn">Both sides changed {conflicts.slice(0, 6).join(", ")}{conflicts.length > 6 ? ` and ${conflicts.length - 6} more` : ""}.</div>
            <span className="text-ink-2 text-xs">For those, keep</span>
            <div className="seg self-start">
              <button type="button" className={cx(prefer === "incoming" && "on")} onClick={() => setPrefer("incoming")}>{into ? "The branch's version" : "Main's version"}</button>
              <button type="button" className={cx(prefer === "current" && "on")} onClick={() => setPrefer("current")}>{into ? "Main's version" : "The branch's version"}</button>
            </div>
          </div>
        ) : null}
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" id="mergeReplace" checked={replace} disabled={!pv.canMerge} onChange={(e) => setReplace(e.currentTarget.checked)} />
          <span>Replace instead: make {dst} read exactly as {src}<span className="block text-ink-2 text-xs">What {dst} changed on its own is dropped from the current version (it stays in History).</span></span></label>
      </> : null}
    </Modal>
  );
}

export function VersionDialogs() {
  const d = useApp((s) => s.versions.dialog);
  const busy = useApp((s) => s.versions.busy);
  if (!d) return null;
  switch (d.kind) {
    case "save": return <SaveDialog d={d} busy={busy} />;
    case "rename": return <RenameDialog key={d.versionId} d={d} busy={busy} />;
    case "restore": return <RestoreDialog d={d} busy={busy} />;
    case "deleteVersion": return <ConfirmDialog title="Delete version" busy={busy} action="Delete version" text={`Delete ${d.label === "this version" ? d.label : `"${d.label}"`} from the history?`}
      sub="The project itself does not change. The version can no longer be restored once the edits behind it are older than 30 days." onOk={() => run({ cmd: "delete", versionId: d.versionId })} />;
    case "branches": return <BranchesDialog />;
    case "newBranch": return <NewBranchDialog d={d} busy={busy} />;
    case "renameBranch": return <RenameBranchDialog d={d} busy={busy} />;
    case "deleteBranch": return <ConfirmDialog title="Delete branch" busy={busy} action="Delete branch" text={`Delete the branch "${d.name}"?`}
      sub="Work on it that was not merged into main goes with it. The main line is not touched." onOk={() => run({ cmd: "deleteBranch", projectId: d.projectId })} />;
    case "merge": return <MergeDialog key={d.projectId + d.direction} d={d} busy={busy} />;
  }
}
