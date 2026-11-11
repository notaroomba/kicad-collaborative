// versions.ts — version history and branches in the editor (server/src/versions.rs is the other half).
//
// The server keeps a document as snapshots (whole files) and a journal of ops after them.  A point in a
// document's history is "the snapshot at snapSeq with the ops up to seq laid over it"; GET /api/docs/{id}/at/{seq}
// hands out both, and this module builds the document from them with the same reader and the same apply the live
// session uses.  That is all scrubbing is: load a base once, lay more or fewer ops over it.
//
// While an earlier point is on screen (store.versions.view is set, E.history holds what to put back):
//   - nothing can be edited: the document is view-only and sendOp() refuses,
//   - the live op stream is not applied (net.ts asks historyActive()), so the document on screen stays the past,
//   - leaving asks the server for the document again, which is what brings the present back.
//
// Everything that changes something goes to the server and comes back as a `versions` notice to every client in
// the project (onVersionsNotice), so the History pane of everyone connected stays current without a refresh.
import { state, store } from "./appstore";
import { applyChanges, openDoc, setDocFromText } from "./doc";
import { navigate } from "./home";
import { requestResync } from "./net";
import { E } from "./state";
import { toast } from "./util";
import type { AppState, BranchInfo, HistoryAt, HistoryRun, HistoryView, VersionDialog, VersionInfo, VersionsCmd, VersionsState } from "../store";

interface DocRef { docId: string; path: string; docType: string }
interface StateView { me: unknown; project: { projectId: string; name: string } | null; docId: string | null; doc: DocRef | null; docs: DocRef[]; view: string }
const app = (): StateView => state as unknown as StateView;
const slice = (): VersionsState => (store.get() as unknown as AppState).versions;
const put = (patch: Partial<VersionsState>): void => { (store as unknown as { slice(k: string, p: object): void }).slice("versions", patch); };

/** A JSON call that turns the server's `{ error, message }` into the Error's message. */
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: unknown = null;
  try { json = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) {
    const j = json as { message?: string; error?: string } | null;
    const err = new Error((j && j.message) || `the server answered ${r.status}`) as Error & { code?: string; status?: number };
    err.code = j && j.error || undefined; err.status = r.status;
    throw err;
  }
  return json as T;
}
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- the list

interface TimelineReply {
  parentId: string | null; branchName: string | null; versions: VersionInfo[]; runs: HistoryRun[];
  docs: { docId: string; path: string; docType: string; head: number; floor: number }[];
}
interface BranchesReply { main: { projectId: string; name: string }; branches: BranchInfo[] }

let loadN = 0;
/** Read the project's versions, the runs of edits between them and its branches. */
export async function loadVersions(): Promise<void> {
  const p = app().project; if (!p) return;
  const n = ++loadN, pid = p.projectId;
  put({ loading: true });
  try {
    const [tl, br] = await Promise.all([
      call<TimelineReply>(`/api/projects/${pid}/timeline`),
      app().me ? call<BranchesReply>(`/api/projects/${pid}/branches`).catch(() => null) : Promise.resolve(null),
    ]);
    if (n !== loadN || !app().project || app().project!.projectId !== pid) return;
    put({ loading: false, error: null, list: tl.versions, runs: tl.runs, docs: tl.docs, parentId: tl.parentId, branchName: tl.branchName,
      branches: br ? br.branches : [], main: br ? br.main : null });
    // the old slice, for anything that still reads the checkpoint list (plugins, the assistant)
    (store as unknown as { set(p: object): void }).set({ history: { groups: tl.versions.filter((v) => v.kind === "named").map((v) => ({ name: v.name || "", at: v.createdAt, docs: v.docs.length })), loading: false, error: null } });
    const v = slice().view;
    if (v) {                                             // the document moved on while we look at its past
      const d = tl.docs.find((x) => x.docId === v.docId);
      if (d && d.head !== v.head) { indexes.delete(v.docId); put({ view: { ...v, head: d.head, marks: marksFor(v.docId) } }); void loadIndex(v.docId); }
      else put({ view: { ...v, marks: marksFor(v.docId), versionId: versionAt(v.docId, v.seq) } });
    }
  } catch (e) {
    if (n !== loadN) return;
    put({ loading: false, error: why(e) });
  }
}

let noticeTimer = 0;
/** The server says the project's versions or branches changed (somebody saved, restored, branched or merged). */
export function onVersionsNotice(msg: { projectId?: string; what?: string }): void {
  const p = app().project; if (!p || (msg.projectId && msg.projectId !== p.projectId)) return;
  if (msg.what === "branch_deleted") {
    const parent = slice().parentId;
    toast("This branch was deleted. Back to the main line.", 4000);
    if (parent) navigate(`/p/${parent}/edit`, false);
    return;
  }
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { void loadVersions(); }, 120);
}

let editTimer = 0;
/** An edit was made or arrived: the runs of edits in the list are re-read once things go quiet. */
export function noteEdit(): void {
  clearTimeout(editTimer);
  editTimer = window.setTimeout(() => { if (app().view === "editor" && app().project) void loadVersions(); }, 1500);
}

// ---------------------------------------------------------------- looking at the past

interface AtReply { docId: string; seq: number; head: number; upto: number; snapSeq: number; file: string; ops: { seq: number; changes: KChange[] }[] }
interface Base { snapSeq: number; file: string; ops: { seq: number; changes: KChange[] }[]; upto: number }
interface DocIndex { head: number; floor: number; floorAt: number | null; seqs: number[]; times: number[]; who: number[]; people: { id: number; login?: string | null; name?: string | null }[] }

const bases = new Map<string, Base[]>();
const indexes = new Map<string, DocIndex>();
let shown: { docId: string; snapSeq: number; seq: number } | null = null;
let want: HistoryAt | null = null, drawing = false, playTimer = 0;

export const historyActive = (): boolean => !!E.history;

function marksFor(docId: string): HistoryView["marks"] {
  const out: HistoryView["marks"] = [];
  for (const v of slice().list) { const d = v.docs.find((x) => x.docId === docId); if (d) out.push({ seq: d.seq, name: v.name || "Kept automatically", named: v.kind === "named" }); }
  return out;
}
function versionAt(docId: string, seq: number): string | null {
  const hit = slice().list.find((v) => v.docs.some((d) => d.docId === docId && d.seq === seq));
  return hit ? hit.id : null;
}
function describe(docId: string, seq: number): { at: number | null; who: string | null } {
  const ix = indexes.get(docId); if (!ix) return { at: null, who: null };
  // the last edit at or before seq
  let lo = 0, hi = ix.seqs.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ix.seqs[mid] <= seq) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0) return { at: ix.floorAt, who: null };
  const p = ix.people[ix.who[k]];
  return { at: ix.times[k], who: p ? (p.name || p.login || null) : null };
}

async function loadIndex(docId: string): Promise<void> {
  if (indexes.has(docId)) return;
  try {
    const ix = await call<DocIndex>(`/api/docs/${docId}/history`);
    indexes.set(docId, ix);
    const v = slice().view;
    if (v && v.docId === docId) put({ view: { ...v, floor: ix.floor, head: Math.max(v.head, ix.head), ...describe(docId, v.seq) } });
  } catch (e) { /* the scrubber still works, it just cannot say when and who */ }
}

/** The base a point is built on: one already fetched that covers it, else ask the server. */
async function baseFor(docId: string, seq: number): Promise<Base> {
  const list = bases.get(docId) || [];
  const hit = list.find((b) => b.snapSeq <= seq && seq <= b.upto);
  if (hit) return hit;
  const r = await call<AtReply>(`/api/docs/${docId}/at/${seq}?span=1`);
  const same = list.find((b) => b.snapSeq === r.snapSeq);
  if (same) { if (r.upto > same.upto) { same.ops = r.ops; same.upto = r.upto; } return same; }
  const b: Base = { snapSeq: r.snapSeq, file: r.file, ops: r.ops, upto: r.upto };
  list.push(b); bases.set(docId, list);
  return b;
}

async function draw(at: HistoryAt): Promise<void> {
  const b = await baseFor(at.docId, at.seq);
  if (!E.history || app().docId !== at.docId) return;
  if (shown && shown.docId === at.docId && shown.snapSeq === b.snapSeq && shown.seq <= at.seq) {
    for (const op of b.ops) if (op.seq > shown.seq && op.seq <= at.seq) applyChanges(op.changes);
  } else {
    if (!setDocFromText(b.file)) throw new Error("that version of the file cannot be read here");
    for (const op of b.ops) if (op.seq <= at.seq) applyChanges(op.changes);
  }
  shown = { docId: at.docId, snapSeq: b.snapSeq, seq: at.seq };
}

/** Draw the newest point asked for; points asked for while one is being drawn replace each other. */
async function pump(): Promise<void> {
  if (drawing) return;
  drawing = true;
  try {
    while (want) {
      const at = want; want = null;
      try { await draw(at); const v = slice().view; if (v && v.docId === at.docId && v.seq === at.seq) put({ view: { ...v, loading: false, error: null } }); }
      catch (e) { const v = slice().view; if (v) put({ view: { ...v, loading: false, error: why(e) } }); stopPlay(); }
    }
  } finally { drawing = false; }
}

/** Show the open document as it was at `seq` (entering the timeline if it is not open yet). */
export async function viewAt(docId: string, seq: number): Promise<void> {
  const st = app();
  if (st.docId !== docId) {
    const doc = st.docs.find((d) => d.docId === docId);
    if (!doc) { toast("That file has no drawing to show here"); return; }
    await openDoc(doc);
    if (app().docId !== docId) return;
  }
  const d = slice().docs.find((x) => x.docId === docId);
  const ix = indexes.get(docId);
  const head = Math.max(d ? d.head : seq, ix ? ix.head : 0, seq), floor = ix ? ix.floor : d ? d.floor : 0;
  seq = Math.min(head, Math.max(floor, Math.round(seq)));
  if (!E.history) {
    // What to put back on the way out.  The view-only flag is forced on while the past is on screen.
    E.history = { viewOnly: !!E.viewOnly };
    E.viewOnly = true; (store as unknown as { set(p: object): void }).set({ viewOnly: true });
    E.selection = new Set(); E.selected = null;
  }
  const prev = slice().view;
  put({ view: { docId, seq, head, floor, loading: true, playing: !!(prev && prev.playing), error: null, ...describe(docId, seq), versionId: versionAt(docId, seq), marks: marksFor(docId) } });
  void loadIndex(docId);
  want = { docId, seq };
  await pump();
}

function viewVersion(versionId: string): void {
  const v = slice().list.find((x) => x.id === versionId); if (!v) return;
  const st = app();
  const d = v.docs.find((x) => x.docId === st.docId) || v.docs.find((x) => st.docs.some((t) => t.docId === x.docId));
  if (!d) { toast("That version holds no schematic or board"); return; }
  void viewAt(d.docId, d.seq);
}

function stopPlay(): void {
  if (playTimer) { clearInterval(playTimer); playTimer = 0; }
  const v = slice().view; if (v && v.playing) put({ view: { ...v, playing: false } });
}
function play(on: boolean): void {
  stopPlay();
  const v = slice().view; if (!on || !v) return;
  const start = v.seq >= v.head ? v.floor : v.seq;
  const stride = Math.max(1, Math.ceil((v.head - v.floor) / 240));      // a long history plays in about half a minute
  put({ view: { ...v, playing: true } });
  if (start !== v.seq) void viewAt(v.docId, start);
  playTimer = window.setInterval(() => {
    const cur = slice().view; if (!cur) { stopPlay(); return; }
    if (drawing) return;                                                // never queue frames behind a slow one
    if (cur.seq >= cur.head) { stopPlay(); return; }
    void viewAt(cur.docId, Math.min(cur.head, cur.seq + stride));
  }, 120);
}

/** The document went away (another one was opened, the editor was left): forget the timeline without reloading. */
export function dropHistoryView(): void {
  stopPlay(); want = null; shown = null;
  if (E.history) { E.viewOnly = !!E.history.viewOnly; E.history = null; (store as unknown as { set(p: object): void }).set({ viewOnly: E.viewOnly }); }
  if (slice().view) put({ view: null });
}

/** Leave the timeline: the live document comes back. */
export async function exitHistory(): Promise<void> {
  if (!E.history) return;
  const docId = app().docId;
  dropHistoryView();
  E.applyFailed = false;
  if (!docId) return;
  if (E.ws && E.ws.readyState === 1 && E.joinedDocId === docId) { requestResync(null, true); return; }
  try {                                                                 // no session (signed out on a public project)
    const r = await call<AtReply>(`/api/docs/${docId}/at/head`);
    if (app().docId === docId && !E.history && setDocFromText(r.file)) for (const op of r.ops) applyChanges(op.changes);
  } catch (e) { toast("The current version could not be loaded: " + why(e), 4000); }
}

/** While the past is on screen the role the server reports is remembered, not applied. */
export function holdViewOnly(v: boolean): boolean {
  if (!E.history) return false;
  E.history.viewOnly = !!v;
  return true;
}

// ---------------------------------------------------------------- commands from the chrome

const openDialog = (dialog: VersionDialog | null): void => put({ dialog });

async function act<T>(what: string, fn: () => Promise<T>, done?: (r: T) => void | Promise<void>): Promise<void> {
  if (slice().busy) return;
  put({ busy: true });
  try { const r = await fn(); put({ busy: false, dialog: null }); if (done) await done(r); void loadVersions(); }
  catch (e) { put({ busy: false }); toast(`${what}: ${why(e)}`, 5000); }
}

function canEdit(): boolean {
  const role = (store.get() as unknown as AppState).role;
  if (role === "editor") return true;
  toast(app().me ? "Only editors can do that" : "Sign in to do that");
  return false;
}

/** File > Save, Ctrl+S, the pane's button: name the project as it is now. */
export function saveVersionDialog(): void {
  if (!app().project) return;
  if (!canEdit()) return;
  const v = slice().view;
  openDialog(v && v.seq < v.head ? { kind: "save", at: { docId: v.docId, seq: v.seq } } : { kind: "save" });
}

function branchUrl(projectId: string): string {
  // stay on the same file: a branch holds the same paths under its own document ids
  const path = app().doc ? app().doc!.path : null;
  const s = slice();
  const docs = projectId === (s.main && s.main.projectId) ? null : (s.branches.find((b) => b.projectId === projectId) || { docs: [] }).docs;
  const twin = path && docs ? docs.find((d) => d.path === path) : null;
  return `/p/${projectId}/edit` + (twin ? `?doc=${twin.docId}` : "");
}

export function versionsCommand(a: VersionsCmd): void {
  const p = app().project; if (!p) return;
  const pid = p.projectId;
  switch (a.cmd) {
    case "refresh": void loadVersions(); return;
    case "dialog": openDialog(a.dialog); return;
    case "view": void viewAt(a.docId, a.seq); return;
    case "viewVersion": viewVersion(a.versionId); return;
    case "step": { const v = slice().view; if (v) { stopPlay(); void viewAt(v.docId, v.seq + a.by); } return; }
    case "play": play(a.on); return;
    case "exit": void exitHistory(); return;
    case "save":
      void act("The version was not saved", () => call<{ githubPush?: boolean }>(`/api/projects/${pid}/versions`, "POST", { name: a.name, description: a.description, at: a.at }),
        (r) => { toast(r.githubPush ? "Version saved, pushing to GitHub" : "Version saved"); });
      return;
    case "rename":
      void act("The version was not renamed", () => call(`/api/projects/${pid}/versions/${a.versionId}`, "PATCH", { name: a.name, description: a.description }));
      return;
    case "delete":
      void act("The version was not deleted", () => call(`/api/projects/${pid}/versions/${a.versionId}`, "DELETE"), () => { toast("Version deleted"); });
      return;
    case "restore":
      void act("Nothing was restored", () => call<{ docs: unknown[] }>(`/api/projects/${pid}/restore`, "POST", a.versionId ? { versionId: a.versionId } : { at: a.at, label: a.label }),
        async (r) => { await exitHistory(); toast(r.docs.length ? `Restored ${a.label}. The state before is kept in History.` : "The project already reads like that", 4500); });
      return;
    case "newBranch":
      void act("The branch was not created", () => call<{ projectId: string; name: string }>(`/api/projects/${slice().parentId || pid}/branches`, "POST", { name: a.name, description: a.description, versionId: a.versionId, at: a.at }),
        async (r) => { toast(`Branch "${r.name}" created`); if (a.open) { await loadVersions(); dropHistoryView(); navigate(branchUrl(r.projectId), false); } });
      return;
    case "openBranch": if (a.projectId !== pid) { openDialog(null); dropHistoryView(); navigate(branchUrl(a.projectId), false); } else openDialog(null); return;
    case "renameBranch":
      void act("The branch was not renamed", () => call(`/api/projects/${pid}/branches/${a.projectId}`, "PATCH", { name: a.name, description: a.description }), () => { openDialog({ kind: "branches" }); });
      return;
    case "deleteBranch":
      void act("The branch was not deleted", () => call(`/api/projects/${pid}/branches/${a.projectId}`, "DELETE"), () => {
        toast("Branch deleted");
        if (a.projectId === pid) { const parent = slice().parentId; if (parent) navigate(`/p/${parent}/edit`, false); } else openDialog({ kind: "branches" });
      });
      return;
    case "merge":
      void act("Nothing was merged", () => call<{ merged: boolean }>(`/api/projects/${a.projectId}/merge`, "POST", { direction: a.direction, mode: a.replace ? "replace" : "merge", prefer: a.prefer }),
        (r) => { toast(!r.merged ? "There was nothing to merge" : a.direction === "into_main" ? "Merged into main. Main as it was before is kept in its History." : "Updated from main", 4500); });
      return;
    case "compare": {
      const v = slice().view; if (!v) return;
      const when = v.at ? new Date(v.at).toLocaleString() : `edit ${v.seq}`;
      const review = (window as unknown as { CollabReview?: { openCompare?(o: unknown): void } }).CollabReview;
      const refs = { a: { kind: "at", docId: v.docId, seq: v.seq, label: when }, b: { kind: "at", docId: v.docId, seq: v.head, label: "Current version" } };
      if (review && review.openCompare) review.openCompare(refs);
      else toast("Compare is not available in this build");
      return;
    }
  }
}
