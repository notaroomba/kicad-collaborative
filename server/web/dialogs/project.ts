import { E, api, appState, applySheetContext, requestRender } from "./editor";
// dialogs/project.ts — the project file (.kicad_pro) and document-level settings.
//
// The collab protocol is item-level: a change names one item by uuid.  Two things the dialogs edit are not items:
//
//  * Page settings — the (paper …) and (title_block …) of a schematic sheet or a board.  They travel as an ordinary op on
//    that document whose single change carries `docProps` (logic.ts pageSettingsChange) under a reserved id.  The server
//    stores and relays ops opaquely, so every web client applies it live and replays it when it loads the document
//    (snapshot + the ops after it).  The desktop has no handler for it and ignores the change; a snapshot the desktop
//    writes afterwards therefore does not contain it.
//
//  * The .kicad_pro — a JSON document of its own (docType kicad_pro).  The web editor never joins it, so a write goes
//    through a short-lived second socket: one marker op on that document moves its head, then the new text is uploaded
//    as the snapshot at that sequence number (the server keeps snapshots insert-only, so it cannot replace the one it
//    has without a new op).  Other clients read the file when they open the project.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObj = { [k: string]: Json };
interface DocEntry { docId: string; path: string; docType: string }
interface ProjectState { project: { projectId: string; name: string; docs: DocEntry[] } | null; docs: DocEntry[]; docId: string | null; me: unknown; role: string | null }
const S = appState;

export function proDoc(): DocEntry | null { return S.project ? S.project.docs.find((d) => d.docType === "kicad_pro") || null : null; }
/** The parsed .kicad_pro ({} when the project has none or it has not arrived yet). */
export function projectJson(): JsonObj {
  try { const j = E.proSettings ? JSON.parse(E.proSettings) : null; return j && typeof j === "object" && !Array.isArray(j) ? j as JsonObj : {}; } catch (e) { return {}; }
}
/** Fetch the .kicad_pro now (the editor loads it lazily); resolves to the parsed object. */
export async function loadProject(): Promise<JsonObj> {
  const pro = proDoc(); if (!pro) return {};
  try { const t = await api(`/api/docs/${pro.docId}/content`); E.proSettings = typeof t === "string" ? t : JSON.stringify(t); } catch (e) { /* keep what we have */ }
  return projectJson();
}
export function obj(v: Json | undefined): JsonObj { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
/** Get-or-create a nested object: sub(pro, "schematic", "drawing"). */
export function sub(root: JsonObj, ...path: string[]): JsonObj { let o = root; for (const k of path) { const n = o[k]; if (!n || typeof n !== "object" || Array.isArray(n)) o[k] = {}; o = o[k] as JsonObj; } return o; }

interface SideResult { seq: number; file: string | null; snapSeq: number; thenOps: { seq: number; changes: unknown[] }[] }
/**
 * A short-lived socket on a document this page has not joined.  With `changes` it submits one op and resolves with
 * its sequence number; without, it resolves with the document's current base (snapshot text + the ops after it).
 */
function sideSession(docId: string, changes?: unknown[]): Promise<SideResult> {
  return new Promise((resolve, reject) => {
    (async () => {
      let token = ""; try { token = ((await api("/api/ws-ticket")) as { token?: string }).token || ""; } catch (e) { reject(new Error("sign-in expired")); return; }
      const proto = location.protocol === "https:" ? "wss" : "ws"; let sock: WebSocket;
      try { sock = new WebSocket(`${proto}://${location.host}/ws`); } catch (e) { reject(new Error("connection blocked")); return; }
      const opId = "web-side:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const timer = setTimeout(() => { try { sock.close(); } catch (e) { /* closed */ } reject(new Error("no answer from the server")); }, 8000);
      const done = (fn: () => void) => { clearTimeout(timer); sock.onmessage = null; sock.onerror = null; try { sock.close(); } catch (e) { /* closed */ } fn(); };
      sock.onopen = () => sock.send(JSON.stringify({ type: "hello", proto: 1, token, clientId: "web-side-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "web" }));
      sock.onerror = () => done(() => reject(new Error("connection failed")));
      sock.onmessage = (ev) => {
        let msg: { type?: string; code?: string; clientOpId?: string; seq?: number; file?: string; thenOps?: { seq: number; changes: unknown[] }[]; docId?: string };
        try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
        if (msg.type === "hello_ok") sock.send(JSON.stringify({ type: "join_doc", docId }));
        else if (msg.type === "doc_info" && changes) sock.send(JSON.stringify({ type: "op", docId, clientOpId: opId, baseSeq: null, changes }));
        else if (msg.type === "ack" && msg.clientOpId === opId) done(() => resolve({ seq: Number(msg.seq) || 0, file: null, snapSeq: 0, thenOps: [] }));
        else if (msg.type === "snapshot" && !changes && typeof msg.file === "string") done(() => resolve({ seq: 0, file: msg.file as string, snapSeq: Number(msg.seq) || 0, thenOps: msg.thenOps || [] }));
        else if (msg.type === "error" && msg.code !== "bad_message") done(() => reject(new Error(msg.code === "permission_denied" ? "view-only access" : String(msg.code || "refused"))));
      };
    })().catch(reject);
  });
}
/** One op on a document this page has not joined; resolves to the op's sequence number. */
export function submitDocOp(docId: string, changes: unknown[]): Promise<number> { return sideSession(docId, changes).then((r) => r.seq); }
/**
 * Another document of the project as it stands now: its snapshot with every later op applied (the same catch-up a
 * joining client gets).  Signed-out viewers fall back to the last snapshot alone.
 */
export async function readDoc(docId: string, docType = "kicad_sch"): Promise<KDoc> {
  let file: string | null = null, ops: { changes: unknown[] }[] = [];
  try { const r = await sideSession(docId); file = r.file; ops = r.thenOps; } catch (e) { file = null; }
  if (file === null) { const r = await fetch(`/api/docs/${docId}/content`); if (!r.ok) throw new Error(`${r.status}`); file = await r.text(); }
  const doc = KiCadCanvas.parseDoc(file, docType); const IU = docType === "kicad_sch" ? 1e4 : 1e6;
  const applyProps = KiCadCanvas.applyDocProps as (d: KDoc, p: unknown) => boolean;
  for (const op of ops) for (const c of (Array.isArray(op.changes) ? op.changes : []) as (KChange & { docProps?: unknown })[]) {
    try { if (c && c.docProps) applyProps(doc, c.docProps); else KiCadCanvas.applyChange(doc, c, IU); } catch (e) { /* an op this reader cannot take */ }
  }
  return doc;
}

/**
 * Change the .kicad_pro: `mutate` edits a fresh copy of the current file; the result is written back as the
 * project document's next snapshot and becomes this page's design settings at once.  Rejects when the project
 * has no .kicad_pro or the user may not edit.
 */
export async function saveProject(mutate: (pro: JsonObj) => void, label = "project settings"): Promise<JsonObj> {
  const pro = proDoc(); if (!pro) throw new Error("this project has no .kicad_pro file");
  if (E.viewOnly) throw new Error("view-only access");
  const cur = await loadProject(); mutate(cur);
  const text = JSON.stringify(cur, null, 2) + "\n";
  const seq = await submitDocOp(pro.docId, [{ id: "project", kind: "MODIFIED", typeName: "PROJECT_FILE", note: label }]);
  const r = await fetch(`/api/docs/${pro.docId}/snapshots?seq=${seq}`, { method: "POST", headers: { "content-type": "text/plain" }, body: text });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => r.statusText)}`);
  adoptProject(text);
  return cur;
}
const listeners = new Set<() => void>();
/** Called whenever the project settings change on this page (after a save). */
export function onProjectChanged(fn: () => void): void { listeners.add(fn); }
export function adoptProject(text: string): void {
  E.proSettings = text;
  const pcb = CollabTools.pcb as (PcbToolModule & { setDesignSettings?(t: string): void }) | undefined;
  if (pcb && pcb.setDesignSettings) { try { pcb.setDesignSettings(text); } catch (e) { /* module without rules */ } }
  if (E.kdoc) { applySheetContext(E.kdoc); requestRender(); }
  for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } }
}
export function currentDocEntry(): DocEntry | null { return S.docs.find((d) => d.docId === S.docId) || null; }
export function projectDocs(): DocEntry[] { return S.docs; }
export function projectName(): string { const p = proDoc(); return p ? p.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : (S.project ? S.project.name : ""); }
/** A document's base as the server holds it: the snapshot text and every op after it (for a copy of the file). */
export function docBase(docId: string): Promise<{ file: string | null; ops: { changes: unknown[] }[] }> { return sideSession(docId).then((r) => ({ file: r.file, ops: r.thenOps })); }
