// review/sources.ts — the versions of a document the Compare window can show, and how each is read.
//
// A version is named by a VersionRef (the contract other parts of the editor call the window with):
//   "live"                         the open document as it is now, edits of everyone included
//   { kind: "head", docId }        another document of the project as the server has it now
//   { kind: "at", docId, seq }     a document at a point of its history (the version history's endpoint:
//                                  a snapshot and the edits to lay over it)
//   { kind: "snapshot", docId, seq } a saved snapshot, which is what a named checkpoint is
//   { kind: "git", path, sha }     the file at a commit of the linked GitHub repository
//   { kind: "file", name, text }   a file from the person's computer
// The two sides may name different documents (a branch's board against the main one).

export type VersionRef =
  | "live"
  | { kind: "head"; docId: string; label?: string }
  | { kind: "at"; docId: string; seq: number | "head"; label?: string }
  | { kind: "snapshot"; docId: string; seq: number; label?: string }
  | { kind: "git"; path: string; sha: string; label?: string }
  | { kind: "file"; name: string; text: string; label?: string };

export interface DocEntry { docId: string; path: string; docType: string }
export interface Loaded { doc: KDoc; label: string; live: boolean }

/** One row of a version picker. */
export interface Choice { ref: VersionRef; label: string; group: "Now" | "Checkpoints" | "Versions" | "GitHub commits" | "File"; when?: string; note?: string }

interface EditorState { kdoc: KDoc | null; IU: number }
const editor = (): EditorState | undefined => (window as unknown as { CollabEditor?: EditorState }).CollabEditor;
const K = (): KiCadCanvasApi => window.KiCadCanvas;
const iuOf = (docType: string): number => (docType === "kicad_sch" ? 1e4 : 1e6);

export class SourceError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new SourceError(await failure(r));
  return (await r.json()) as T;
}
async function getText(url: string): Promise<{ text: string; seq: number | null }> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new SourceError(await failure(r));
  const seq = Number(r.headers.get("x-snapshot-seq"));
  return { text: await r.text(), seq: Number.isFinite(seq) && r.headers.has("x-snapshot-seq") ? seq : null };
}
async function failure(r: Response): Promise<string> {
  let message = "";
  try { const t = await r.text(); try { const j = JSON.parse(t) as { message?: string; error?: string }; message = j.message || j.error || ""; } catch { message = t.slice(0, 200); } } catch { /* no body */ }
  if (r.status === 401) return "Sign in to read this version.";
  if (r.status === 403) return message || "You do not have access to this version.";
  if (r.status === 404) return "That version no longer exists.";
  return message || `The server answered ${r.status}.`;
}

function parse(text: string, docType: string, what: string): KDoc {
  try { return K().parseDoc(text, docType); } catch { throw new SourceError(`${what} is not a KiCad ${docType === "kicad_sch" ? "schematic" : "board"} this editor can read.`); }
}
interface Op { seq: number; changes: KChange[] }
function replay(doc: KDoc, ops: Op[], docType: string): void {
  for (const op of ops) for (const c of op.changes || []) { try { K().applyChange(doc, c, iuOf(docType)); } catch (e) { console.warn("compare: an edit could not be replayed", e); } }
  K().computeBBox(doc);
}

export function refLabel(ref: VersionRef): string {
  if (ref === "live") return "Current";
  if (ref.label) return ref.label;
  switch (ref.kind) {
    case "head": return "Current";
    case "at": return ref.seq === "head" ? "Current" : `Edit ${ref.seq}`;
    case "snapshot": return `Snapshot ${ref.seq}`;
    case "git": return `Commit ${ref.sha.slice(0, 7)}`;
    case "file": return ref.name;
  }
}
export function sameRef(a: VersionRef, b: VersionRef): boolean {
  if (a === "live" || b === "live") return a === b;
  if (a.kind !== b.kind) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return ["docId", "seq", "path", "sha", "name", "text"].every((k) => x[k] === y[k]);
}

/**
 * Read one version.  `open` is the document the editor has open; "live" means that one, and its
 * in-memory document is used as it is (not copied: the window redraws when it changes).
 */
export async function loadVersion(ref: VersionRef, projectId: string, entry: DocEntry, open: DocEntry | null): Promise<Loaded> {
  const label = refLabel(ref);
  if (ref === "live" || (ref.kind === "head" && open && ref.docId === open.docId)) {
    const ed = editor();
    if (open && ed && ed.kdoc && (ref === "live" || open.docId === entry.docId)) return { doc: ed.kdoc, label, live: true };
    return loadVersion({ kind: "head", docId: entry.docId, label }, projectId, entry, null);
  }
  switch (ref.kind) {
    case "head": {
      const { text, seq } = await getText(`/api/docs/${ref.docId}/content?v=${Date.now()}`);
      const doc = parse(text, entry.docType, entry.path);
      if (seq !== null) {
        // the snapshot is as old as the last save: the edits made since bring it up to now
        try { replay(doc, (await getJson<{ ops: Op[] }>(`/api/docs/${ref.docId}/ops?since=${seq}`)).ops || [], entry.docType); } catch { /* signed out: the snapshot alone */ }
      }
      return { doc, label, live: false };
    }
    case "at": {
      const j = await getJson<{ file: string; ops?: Op[] }>(`/api/docs/${ref.docId}/at/${ref.seq}`);
      const doc = parse(j.file, entry.docType, label);
      replay(doc, j.ops || [], entry.docType);
      return { doc, label, live: false };
    }
    case "snapshot": return { doc: parse((await getText(`/api/docs/${ref.docId}/snapshots/${ref.seq}`)).text, entry.docType, label), label, live: false };
    case "git": return { doc: parse((await getText(`/api/projects/${projectId}/github/file?path=${encodeURIComponent(ref.path)}&sha=${encodeURIComponent(ref.sha)}`)).text, entry.docType, label), label, live: false };
    case "file": return { doc: parse(ref.text, entry.docType, ref.name), label, live: false };
  }
}

interface CheckpointRow { docId: string; path: string; seq: number; name: string; createdAt: string }
interface VersionRow { id: string | number; name?: string | null; kind?: string; author?: string | null; createdAt: string; docs: { docId: string; path: string; snapSeq: number; seq: number }[] }
interface CommitRow { sha: string; message: string; author?: string | null; date?: string | null }

export interface Listing { choices: Choice[]; github: "ok" | "unlinked" | "not_connected" | "error"; githubNote?: string; signedOut: boolean }

/**
 * Everything `entry` can be compared with: now, the saved versions of the project (the version history
 * when the server has it, the named checkpoints otherwise) and the commits of the linked repository.
 */
export async function listVersions(projectId: string, entry: DocEntry, isOpen: boolean): Promise<Listing> {
  const choices: Choice[] = [{ ref: isOpen ? "live" : { kind: "head", docId: entry.docId, label: "Current" }, label: "Current", group: "Now", note: "as it is now" }];
  const out: Listing = { choices, github: "unlinked", signedOut: false };

  let versions: VersionRow[] | null = null;
  try {
    const r = await fetch(`/api/projects/${projectId}/versions`, { credentials: "same-origin" });
    if (r.ok) versions = ((await r.json()) as { versions?: VersionRow[] }).versions || [];
    else if (r.status === 401) out.signedOut = true;
  } catch { /* fall through to the checkpoints */ }

  if (versions) {
    for (const v of versions) {
      const d = v.docs.find((x) => x.docId === entry.docId) || v.docs.find((x) => x.path === entry.path); if (!d) continue;
      const named = !!v.name;
      choices.push({ ref: { kind: "at", docId: d.docId, seq: d.seq, label: v.name || `Version of ${new Date(v.createdAt).toLocaleString()}` }, label: v.name || new Date(v.createdAt).toLocaleString(),
        group: named ? "Checkpoints" : "Versions", when: v.createdAt, note: v.author || undefined });
    }
  } else if (!out.signedOut) {
    try {
      const rows = (await getJson<{ checkpoints: CheckpointRow[] }>(`/api/projects/${projectId}/checkpoints`)).checkpoints || [];
      for (const c of rows) if (c.docId === entry.docId) choices.push({ ref: { kind: "snapshot", docId: c.docId, seq: c.seq, label: c.name }, label: c.name, group: "Checkpoints", when: c.createdAt });
    } catch (e) { if (e instanceof SourceError && /Sign in/.test(e.message)) out.signedOut = true; }
  }

  if (!out.signedOut) {
    try {
      const r = await fetch(`/api/projects/${projectId}/github/commits?path=${encodeURIComponent(entry.path)}&limit=40`, { credentials: "same-origin" });
      if (r.ok) {
        out.github = "ok";
        for (const c of ((await r.json()) as { commits: CommitRow[] }).commits || []) {
          choices.push({ ref: { kind: "git", path: entry.path, sha: c.sha, label: `${c.message || "Commit"} (${c.sha.slice(0, 7)})` }, label: `${c.message || "Commit"} (${c.sha.slice(0, 7)})`,
            group: "GitHub commits", when: c.date || undefined, note: c.author || undefined });
        }
      } else {
        let code = "", message = "";
        try { const j = (await r.json()) as { message?: string; error?: string }; code = j.error || ""; message = j.message || ""; } catch { /* not json */ }
        if (r.status === 400) out.github = "unlinked";
        else if (code === "github_not_connected" || r.status === 409) { out.github = "not_connected"; out.githubNote = "Connect your GitHub account to compare with commits."; }
        else { out.github = "error"; out.githubNote = message || `GitHub could not be read (${r.status}).`; }
      }
    } catch { out.github = "error"; out.githubNote = "GitHub could not be reached."; }
  }
  return out;
}
