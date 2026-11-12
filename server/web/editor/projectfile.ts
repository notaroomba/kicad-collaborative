// editor/projectfile — reading and writing the project's whole-file documents (.kicad_pro, .kicad_dru)
// and reading any other document of the project in its current state.
//
// How a document is stored: the server keeps snapshots (whole files) and a journal of ops after them; a
// document's content is its newest snapshot plus the ops since.  Item documents (.kicad_sch / .kicad_pcb)
// are only ever edited through ops — the browser must not upload a snapshot of those, its reader drops the
// parts of the file it does not draw.  The project file and the custom rules file are different: they are
// small text files the web holds completely, and nothing else edits them through ops.  They are written
// the way every edit is — an op on that document (journalled, attributed, and what moves its head), then
// the new file as the snapshot at that op's sequence number — so the desktop and every other reader get
// the new file from the ordinary snapshot route.
//
//   liveDocument(docId)            the newest snapshot text and the ops after it, over a short-lived socket
//   loadProjectFile()              the .kicad_pro text in its current state (null when the project has none)
//   saveProjectFile(text, edits)   store a new .kicad_pro; edits name what changed ("board.design_settings.rules.min_clearance")
//   saveTextDocument(...)          the same for another whole-file document (.kicad_dru)
//   adoptProjectFile(text)         make the running editor use it (design rules, text variables, size lists)
//
// The op's shape is shared with the track / via size selectors, which store their lists the same way:
// { id: "project", kind: "MODIFIED", typeName: "PROJECT_FILE", properties: [{ name: <dotted path>, after: { type: "json", v } }] }.
import { state } from "./appstore";
import { E } from "./state";
import { api } from "./util";
import { requestRender } from "./view";
import { editProject, type Plain, type ProjectEdit } from "../canvas/project-file";

export interface ProjectDocInfo { docId: string; docType: string; path: string }
export interface JournalOp { seq: number; changes: KChange[] }
export interface LiveDocument { file: string; seq: number; ops: JournalOp[]; role: string }

interface WireMsg { type?: string; role?: string; clientOpId?: string; seq?: number; docId?: string; file?: string; thenOps?: JournalOp[]; code?: string }

interface AppStateView { project?: { docs?: ProjectDocInfo[] } | null; docs?: ProjectDocInfo[]; me?: unknown }
const appState = (): AppStateView => state as unknown as AppStateView;
export function projectDocs(): ProjectDocInfo[] {
  const st = appState();
  // state.docs is the editor's tab list (schematics and boards only); the project's own list has every document
  const all = st.project && st.project.docs;
  return (all && all.length ? all : st.docs || []) as ProjectDocInfo[];
}
export const projectDoc = (docType: string): ProjectDocInfo | null => projectDocs().find((d) => d.docType === docType) || null;
export const canWriteProject = (): boolean => !E.viewOnly && !!appState().me;

let sockN = 0;
/**
 * One conversation with a document over its own socket: join, hand the catch-up to `onJoined`, and let it
 * send an op and wait for the ack.  Resolves with whatever `onJoined` settles on; the socket is closed after.
 */
function withDocument<T>(docId: string, onJoined: (live: LiveDocument, sendOp: (changes: KChange[]) => Promise<number>) => Promise<T>, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let sock: WebSocket | null = null, settled = false, role = "viewer";
    const acks = new Map<string, { ok(seq: number): void; fail(e: Error): void }>();
    const done = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); try { if (sock) sock.close(); } catch (e) { /* already closed */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("the server did not answer"))), timeoutMs);
    const sendOp = (changes: KChange[]): Promise<number> => new Promise<number>((ok, fail) => {
      if (!sock || sock.readyState !== 1) { fail(new Error("not connected")); return; }
      const clientOpId = `web-file:${Date.now().toString(36)}:${++sockN}`;
      acks.set(clientOpId, { ok, fail });
      sock.send(JSON.stringify({ type: "op", docId, clientOpId, baseSeq: null, changes }));
    });
    (api("/api/ws-ticket") as Promise<{ token?: string }>).then((ticket) => {
      if (settled) return;
      sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      const s = sock;
      s.onopen = () => s.send(JSON.stringify({ type: "hello", proto: 1, token: ticket.token || "", clientId: "web-file-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "web" }));
      s.onerror = () => done(() => reject(new Error("connection failed")));
      s.onclose = () => done(() => reject(new Error("connection closed")));
      s.onmessage = (ev) => {
        let msg: WireMsg;
        try { msg = JSON.parse(String(ev.data)) as WireMsg; } catch (e) { return; }
        if (msg.type === "hello_ok") s.send(JSON.stringify({ type: "join_doc", docId }));
        else if (msg.type === "doc_info") role = msg.role || "viewer";
        else if (msg.type === "snapshot" && typeof msg.file === "string") {
          onJoined({ file: msg.file, seq: Number(msg.seq) || 0, ops: msg.thenOps || [], role }, sendOp).then((v) => done(() => resolve(v)), (e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
        } else if (msg.type === "ack" && msg.clientOpId && acks.has(msg.clientOpId)) { const a = acks.get(msg.clientOpId); acks.delete(msg.clientOpId); if (a) a.ok(Number(msg.seq) || 0); }
        else if (msg.type === "error") {
          const a = msg.clientOpId ? acks.get(msg.clientOpId) : undefined;
          if (a) a.fail(new Error(msg.code || "refused")); else done(() => reject(new Error(msg.code || "refused")));
        }
      };
    }).catch((e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

/** A document as the server has it now: its newest snapshot and the ops journalled after it. */
export function liveDocument(docId: string): Promise<LiveDocument> { return withDocument(docId, (live) => Promise.resolve(live)); }

/** Send item ops to a document that is not the open one (the board a footprint editor tab writes back to); resolves with the seq. */
export function sendDocOps(docId: string, changes: KChange[]): Promise<number> {
  return withDocument(docId, async (live, sendOp) => { if (live.role !== "editor") throw new Error("permission_denied"); return sendOp(changes); });
}

/** The ops a whole-file document picked up after its snapshot (an upload that failed half way), laid over the text. */
function withFileOps(text: string, ops: JournalOp[]): string {
  const edits: ProjectEdit[] = [];
  for (const op of ops) for (const c of op.changes || []) {
    if (c.typeName !== "PROJECT_FILE") continue;
    for (const p of c.properties || []) if (p.after && p.name) edits.push({ path: p.name.split("."), value: p.after.v as Plain });
  }
  if (!edits.length) return text;
  try { return editProject(text, edits).text; } catch (e) { return text; }
}

/** The .kicad_pro in its current state; null when the project has none or it cannot be read. */
export async function loadProjectFile(): Promise<string | null> {
  const pro = projectDoc("kicad_pro"); if (!pro) return null;
  if (!appState().me) {                       // anonymous viewers have no socket: the snapshot route is all there is
    try { const t = await (api(`/api/docs/${pro.docId}/content?v=${Date.now()}`) as Promise<unknown>); return typeof t === "string" ? t : JSON.stringify(t); } catch (e) { return null; }
  }
  try { const live = await liveDocument(pro.docId); return withFileOps(live.file, live.ops); }
  catch (e) {
    try { const t = await (api(`/api/docs/${pro.docId}/content?v=${Date.now()}`) as Promise<unknown>); return typeof t === "string" ? t : JSON.stringify(t); } catch (e2) { return null; }
  }
}

/** Store `text` as the new content of a whole-file document.  `change` is the op that records the edit. */
export function saveTextDocument(docId: string, text: string, change: KChange): Promise<boolean> {
  if (!canWriteProject()) return Promise.resolve(false);
  return withDocument(docId, async (live, sendOp) => {
    if (live.role !== "editor") return false;
    const seq = await sendOp([change]);
    const r = await fetch(`/api/docs/${docId}/snapshots?seq=${seq}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text });
    return r.ok;
  }).catch(() => false);
}

/** Store a new .kicad_pro.  `edits` are the values that changed, by path. */
export function saveProjectFile(text: string, edits: readonly ProjectEdit[]): Promise<boolean> {
  const pro = projectDoc("kicad_pro"); if (!pro) return Promise.resolve(false);
  return saveTextDocument(pro.docId, text, { id: "project", kind: "MODIFIED", typeName: "PROJECT_FILE",
    properties: edits.map((e) => ({ name: e.path.join("."), after: { type: "json", v: e.value } })) });
}

interface DesignSettingsSink { setDesignSettings?(src: unknown): void }
interface SizesSink { state?: { load?(src: unknown): unknown; emit?(): void } }
/** Make the running editor use a project file: the DRC / router rules, the text variables, the size selectors. */
export function adoptProjectFile(text: string): void {
  E.proSettings = text;
  const pcb = CollabTools.pcb as (PcbToolModule & DesignSettingsSink) | undefined;
  if (pcb && pcb.setDesignSettings) { try { pcb.setDesignSettings(text); } catch (e) { /* module without rules */ } }
  const sizes = (KiCadCanvas as unknown as { pcbSizes?: SizesSink }).pcbSizes;
  if (sizes && sizes.state && sizes.state.load) { try { sizes.state.load(text); if (sizes.state.emit) sizes.state.emit(); } catch (e) { /* older bundle */ } }
  if (E.kdoc) { try { const j = JSON.parse(text) as { text_variables?: Record<string, string> }; (E.kdoc as { projectVars?: unknown }).projectVars = j.text_variables && Object.keys(j.text_variables).length ? j.text_variables : null; } catch (e) { /* keep what we had */ } }
  requestRender();
}
